# Org Console Add Project Member (三模式) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 租户控制台「加入成员」支持：选租户成员、搜平台用户一步入租户+项目、新建账号并加入。

**Architecture:** 扩展 `POST /api/organizations/:orgId/projects/:projectId/members`：body 支持 `user_id` 或新建账号字段；非租户成员自动以 `org_role`（默认 `member`）入组织。前端弹窗三 Tab，复用 `member-candidates` 与现有 `addProjectMember`。

**Tech Stack:** Rust/Axum/SQLx、Next.js React、现有 `organizationAPI` / `create_project_member` 模式。

**Spec:** `docs/superpowers/specs/2026-08-13-org-project-add-member-design.md`

## Global Constraints

- 鉴权：`require_organization_admin`；不要求调用方是项目成员
- 新建字段校验：用户名 ≥3、邮箱含 `@`、密码 ≥6；与 `create_project_member` 同口径
- 补入租户时默认 `org_role=member`；`org_role=owner` 仅 org owner/超管
- v1 UI 不暴露 `org_role` 选择器
- 不改工作区成员页；不发邀请邮件
- 除非用户明确要求，否则不 git commit

## File map

| File | Responsibility |
|------|----------------|
| `src/organization_handlers.rs` | 扩展 request + `add_organization_project_member` |
| `frontend-nextjs/lib/api.ts` | `addProjectMember` body 联合类型 |
| `frontend-nextjs/app/org/[orgId]/page.tsx` | 三模式弹窗 UI + 提交逻辑 |

---

### Task 1: Backend — 扩展入项目 API

**Files:**
- Modify: `src/organization_handlers.rs`（`AddProjectMemberFromOrgRequest` ~730、`add_organization_project_member` ~745–818）
- Reference: `src/tenant_handlers.rs` `create_project_member` ~2573–2709（建号/入组织/入项目/RBAC）

**Interfaces:**
- Consumes: `permissions::require_organization_admin`, `is_organization_member`, `require_organization_owner`, `sync_default_rbac_role`, `crate::auth::hash_password`
- Produces: 同一路由 POST；body 支持 `user_id` **或** `username+email+password`；可选 `org_role`

- [ ] **Step 1: 替换 request 结构体与校验辅助**

将 `AddProjectMemberFromOrgRequest` 改为：

```rust
#[derive(Deserialize)]
pub struct AddProjectMemberFromOrgRequest {
    pub user_id: Option<i32>,
    pub username: Option<String>,
    pub email: Option<String>,
    pub password: Option<String>,
    pub role: String,
    /// 仅当目标尚非租户成员时写入 organization_members；默认 member
    pub org_role: Option<String>,
}

fn validate_org_role_for_project_add(role: &str) -> Result<()> {
    match role {
        "owner" | "admin" | "member" => Ok(()),
        _ => Err(AppError::InvalidQuery(format!(
            "无效租户角色 '{}'，必须是 owner / admin / member 之一",
            role
        ))),
    }
}
```

在 handler 开头解析模式：

```rust
let org_role = req.org_role.as_deref().unwrap_or("member");
validate_org_role_for_project_add(org_role)?;
if org_role == "owner" {
    permissions::require_organization_owner(&pool, &claims, organization_id).await?;
}

let create_mode = req.username.is_some() || req.email.is_some() || req.password.is_some();
let user_id = match (req.user_id, create_mode) {
    (Some(uid), false) => uid,
    (None, true) => {
        // 走新建分支，见 Step 2；此处先占位
        0
    }
    (Some(_), true) => {
        return Err(AppError::InvalidQuery(
            "不能同时传 user_id 与新建账号字段".to_string(),
        ));
    }
    (None, false) => {
        return Err(AppError::InvalidQuery(
            "请提供 user_id，或 username/email/password 新建账号".to_string(),
        ));
    }
};
```

- [ ] **Step 2: 实现 ensure_org_member + 新建分支，改写 handler 主体**

在项目归属校验之后：

**已有用户路径：**

```rust
// user_id 来自 req.user_id.unwrap()
let user_exists: bool =
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
        .bind(user_id)
        .fetch_one(&pool)
        .await?;
if !user_exists {
    return Err(AppError::NotFound(format!("用户 {} 不存在", user_id)));
}

if !permissions::is_organization_member(&pool, user_id, organization_id).await? {
    sqlx::query(
        r#"
        INSERT INTO management.organization_members (user_id, organization_id, role, is_active)
        VALUES ($1, $2, $3, true)
        ON CONFLICT (user_id, organization_id)
        DO UPDATE SET role = EXCLUDED.role, is_active = true
        "#,
    )
    .bind(user_id)
    .bind(organization_id)
    .bind(org_role)
    .execute(&pool)
    .await?;
}
// 然后现有 user_tenants upsert + sync_default_rbac_role
```

**新建路径**（对齐 `create_project_member`）：

```rust
let username = req.username.as_deref().unwrap_or("").trim();
let email = req.email.as_deref().unwrap_or("").trim().to_lowercase();
let password = req.password.as_deref().unwrap_or("");
if username.chars().count() < 3 {
    return Err(AppError::InvalidQuery("用户名至少 3 个字符".to_string()));
}
if !email.contains('@') || email.len() < 5 {
    return Err(AppError::InvalidQuery("邮箱格式不正确".to_string()));
}
if password.chars().count() < 6 {
    return Err(AppError::InvalidQuery("密码至少 6 个字符".to_string()));
}
// email/username 唯一性预检（同 create_project_member）
let password_hash = crate::auth::hash_password(password)?;
let new_user_id: i32 = sqlx::query_scalar(
    r#"INSERT INTO users (username, email, password_hash, role)
       VALUES ($1, $2, $3, 'user') RETURNING id"#,
)
.bind(username)
.bind(&email)
.bind(&password_hash)
.fetch_one(&pool)
.await?;

sqlx::query(
    r#"
    INSERT INTO management.organization_members (user_id, organization_id, role, is_active)
    VALUES ($1, $2, $3, true)
    ON CONFLICT (user_id, organization_id)
    DO UPDATE SET role = EXCLUDED.role, is_active = true
    "#,
)
.bind(new_user_id)
.bind(organization_id)
.bind(org_role)
.execute(&pool)
.await?;

// user_tenants upsert with req.role + sync_default_rbac_role
// 返回 json 含 user_id: new_user_id
```

删除「还不是该租户成员则报错」的旧分支。

响应保持：

```json
{
  "ok": true,
  "organization_id": ...,
  "project_id": ...,
  "user_id": ...,
  "role": "..."
}
```

- [ ] **Step 3: 编译验证**

Run: `cargo check`  
Expected: exit 0

- [ ] **Step 4: 手动冒烟（需已登录 org admin token）**

```bash
# 平台用户（非租户成员）一步加入 — 替换 ORG/PROJECT/USER
curl -sS -X POST "$BASE/api/organizations/$ORG/projects/$PROJECT/members" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"user_id":USER,"role":"member"}'

# 新建
curl -sS -X POST "$BASE/api/organizations/$ORG/projects/$PROJECT/members" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"username":"tmp_add_demo","email":"tmp_add_demo@example.com","password":"secret12","role":"viewer"}'
```

Expected: `"ok":true`；重复邮箱 → 中文错误「该邮箱已被注册」

---

### Task 2: Frontend API 类型

**Files:**
- Modify: `frontend-nextjs/lib/api.ts` ~749–754

**Interfaces:**
- Consumes: Task 1 POST body
- Produces: `organizationAPI.addProjectMember(orgId, projectId, body)` 联合类型

- [ ] **Step 1: 扩展 `addProjectMember` 签名**

```ts
addProjectMember: (
  orgId: number,
  projectId: number,
  body:
    | { user_id: number; role: string; org_role?: string }
    | {
        username: string
        email: string
        password: string
        role: string
        org_role?: string
      },
) =>
  api.post(`/api/organizations/${orgId}/projects/${projectId}/members`, body),
```

- [ ] **Step 2: Typecheck（可选）**

Run: `cd frontend-nextjs && npx tsc --noEmit -p tsconfig.json 2>&1 | head -40`  
Expected: 无与本改动相关的错误（全仓既有错误可忽略）

---

### Task 3: Frontend — 三模式弹窗

**Files:**
- Modify: `frontend-nextjs/app/org/[orgId]/page.tsx`（state ~50–54、`submitAddToProject` ~195–218、modal ~663–723）
- Reference UI: `frontend-nextjs/app/workspace/[projectId]/settings/members/page.tsx` ~664–688（segmented control）

**Interfaces:**
- Consumes: `organizationAPI.addProjectMember`, `organizationAPI.searchMemberCandidates`
- Produces: 弹窗 modes `org` | `platform` | `create`

- [ ] **Step 1: 增加弹窗 state**

```ts
type ProjectAddMode = 'org' | 'platform' | 'create'
const [projectAddMode, setProjectAddMode] = useState<ProjectAddMode>('org')
const [projectPlatformQ, setProjectPlatformQ] = useState('')
const [projectPlatformCandidates, setProjectPlatformCandidates] = useState<
  Array<{ id: number; username: string; email: string }>
>([])
const [projectCreateForm, setProjectCreateForm] = useState({
  username: '',
  email: '',
  password: '',
})
```

打开弹窗时重置 mode=`org`、清空搜索/表单（在点击「加入成员」处一并 reset）。

- [ ] **Step 2: 平台用户搜索（debounce 300ms）**

复用成员页搜索模式：`organizationAPI.searchMemberCandidates(org.id, q)`，`q.trim().length >= 2`，结果写入 `projectPlatformCandidates`；选中写入 `projectAddUserId` 并展示选中文案。

- [ ] **Step 3: 重写 `submitAddToProject`**

```ts
async function submitAddToProject() {
  if (!org || !projectAddTarget) return
  setProjectAddSaving(true)
  try {
    let joinedUserId: number | null = null
    if (projectAddMode === 'create') {
      const { username, email, password } = projectCreateForm
      if (username.trim().length < 3 || !email.includes('@') || password.length < 6) {
        notify.warning('请填写用户名（≥3）、有效邮箱、密码（≥6）')
        return
      }
      const res = await organizationAPI.addProjectMember(org.id, projectAddTarget.id, {
        username: username.trim(),
        email: email.trim(),
        password,
        role: projectAddRole,
      })
      joinedUserId = res.data?.user_id ?? null
      notify.success('已创建账号并加入项目')
    } else {
      if (!projectAddUserId) {
        notify.warning('请选择用户')
        return
      }
      joinedUserId = Number(projectAddUserId)
      await organizationAPI.addProjectMember(org.id, projectAddTarget.id, {
        user_id: joinedUserId,
        role: projectAddRole,
      })
      notify.success(
        projectAddMode === 'platform'
          ? '已加入租户并加入项目'
          : '已加入项目成员',
      )
    }
    const enteredSelf =
      currentUser?.id != null && joinedUserId === currentUser.id
    const projectId = projectAddTarget.id
    setProjectAddTarget(null)
    // reset fields...
    await load()
    if (enteredSelf) router.push(`/workspace/${projectId}`)
  } catch (err) {
    notify.error(err)
  } finally {
    setProjectAddSaving(false)
  }
}
```

注意：`notify.warning` 提前 return 前要 `setProjectAddSaving(false)`，或把 saving 包在 try/finally 且 early-return 前先清 flag。

- [ ] **Step 4: 替换 modal JSX**

结构：

1. 标题「加入项目成员」+ 项目名  
2. 三段式 Tab：`租户成员` / `平台用户` / `新建账号`  
3. 按 mode 渲染：
   - `org`：现有 members `<select>`
   - `platform`：搜索 input + 候选列表 + 已选提示
   - `create`：username / email / password inputs
4. 共用项目角色 `<select>`
5. 取消 / 确认（create 时校验 `createFormValid`；org/platform 需已选 user）

文案按 spec。确认按钮 disabled 规则按 mode。

- [ ] **Step 5: 浏览器冒烟**

1. 打开 `/org/{id}` → 项目 → 加入成员  
2. 租户成员：选一人 → 成功  
3. 平台用户：搜非本租户用户 → 成功；成员 Tab 中可见新租户成员  
4. 新建账号：填表 → 成功；可用新账号登录  
5. 重启 `cargo run` 后再测后端变更

---

### Task 4: Spec 状态

**Files:**
- Modify: `docs/superpowers/specs/2026-08-13-org-project-add-member-design.md` 状态行

- [ ] **Step 1:** 将 `**状态：** 已批准，待实施` 改为 `**状态：** 已实现`

---

## Spec coverage checklist

| Spec 项 | Task |
|---------|------|
| 三 Tab UI | Task 3 |
| 扩展 POST 自动补租户 | Task 1 |
| 新建账号路径 | Task 1 + 3 |
| member-candidates 搜索 | Task 3 |
| org_role 默认 member | Task 1 |
| org admin 鉴权 | Task 1（既有） |
| 非目标：成员页新建 / 邮件 / 工作区 | 不改 |

## Placeholder scan

无 TBD / 「similar to」占位。
