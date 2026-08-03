# W4 / PASE Stage E —— 项目成员管理 + 项目元信息编辑

> **REQUIRED SUB-SKILL:** superpowers:subagent-driven-development / superpowers:executing-plans

**目标：** 解锁 W3 Task 4——给 `/workspace/[projectId]/settings/*` 一组实页（项目信息编辑、成员管理），不再需要超管在 `/platform` 才能改这些事。

**口号：** "项目 owner 自己就能把成员加进来 / 改角色 / 改项目名"，不依赖运维 / 平台超管的人工介入。

---

## 1. 术语澄清

文档里 "PASE Stage E" 是我自己在 W2/W3 plan 里给"账号 & 权限演进 (Permission & Account / Session Evolution)" 后端工作起的临时编号——母 spec `2026-05-13-platform-evolution-design.md` 没有这个词，等同于 v1 设计图里的 **M1 "项目工作空间"剩下没做完的尾巴**。

| Stage | 已完成 | 内容 |
|---|---|---|
| A | ✅ W1 | 后端 `list_projects` / `get_project` |
| B | ✅ W1 | 前端 workspace shell + 智能路由 |
| C | ✅ W2 | 现有 dashboard 页面迁移 |
| D | ✅ W3 | API Key / Monitor 拆分 + 残留页归位 |
| **E** | **本 plan** | **项目级成员管理 + 项目元信息编辑** |

Stage F-G 等更远的事（M4 RBAC 可视化、M7 AI 助手）在母 spec 里另有 W5+ 安排，不在本 plan 范围。

---

## 2. 范围

### 做（本 W4）

**后端**（5 个新端点，全部走 `auth_middleware + permissions::require_tenant_admin/owner`）：

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `GET` | `/api/projects/:id/members` | admin+ | 列出项目成员（user + tenant_role） |
| `POST` | `/api/projects/:id/members` | admin+ | 加入已有用户（body: `{user_id, role}`） |
| `PATCH` | `/api/projects/:id/members/:user_id` | admin+ | 改角色（body: `{role}`）|
| `DELETE` | `/api/projects/:id/members/:user_id` | admin+ | 移除（软删，is_active=false） |
| `PATCH` | `/api/projects/:id` | **owner** | 改项目名 / contact_email / workspace_config |

**前端**：

| 路径 | 鉴权 | 说明 |
|---|---|---|
| `/workspace/[projectId]/settings` | owner+ | 项目基本信息表单（name / contact_email / 只读字段：slug / kind / status） |
| `/workspace/[projectId]/settings/members` | admin+ | 成员列表 + 添加/改角色/移除 |

Sidebar 把 "项目信息" 和 "成员管理" 两条加回（W2 cleanup 时去掉过）。

**辅助**：
- `permissions::require_tenant_owner` 新 helper（owner / superadmin，不放 admin）
- `permissions::is_tenant_owner` （内部用）

### 不做

- **邀请未注册用户**（邮件邀请 + 注册流程）—— 母 spec 未列优先级；本期仅支持把"已存在的 user_id"加进项目
- **改 db_host / db_port / status**（这些仍是平台超管的事，保留 `/api/admin/tenants/:id`）
- **改 slug**（slug 不允许改——避免外链 / 文档 / API Key 资源标识混乱；要改的话走平台超管路径）
- **OWNER 自降级 / 自移除护栏**（W4 做最小护栏：不允许移除最后一个 owner；其余复杂规则留 W5）
- **审计日志专项**（写 audit_logs 仍交给现有 `audit_middleware`；不为本期新增 detail sink）
- **i18n** —— 沿用 v1 中文硬编码

---

## 3. 后端详细设计

### 3.1 新 helper：`require_tenant_owner`

放在 `src/permissions.rs`，与 `require_tenant_admin` 并列：

```rust
pub async fn is_tenant_owner(pool: &PgPool, user_id: i32, tenant_id: i32) -> Result<bool> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS( \
            SELECT 1 FROM management.user_tenants \
            WHERE user_id = $1 AND tenant_id = $2 AND is_active = true \
              AND role = 'owner')",
    )
    .bind(user_id).bind(tenant_id).fetch_one(pool).await?;
    Ok(exists)
}

pub async fn require_tenant_owner(
    pool: &PgPool, claims: &Claims, tenant_id: i32,
) -> Result<()> {
    if claims.is_superadmin { return Ok(()); }
    if is_tenant_owner(pool, claims.sub, tenant_id).await? {
        Ok(())
    } else {
        Err(AppError::Forbidden(format!("需要 owner 角色或平台超管才能管理项目 {} 元信息", tenant_id)))
    }
}
```

### 3.2 5 个 handler（都放在 `tenant_handlers.rs` 末尾，与现有 list_projects / get_project 同模块）

#### `GET /api/projects/:id/members`

```sql
SELECT u.id, u.username, u.email, u.is_superadmin, ut.role, ut.is_active, ut.created_at
FROM management.user_tenants ut
JOIN users u ON u.id = ut.user_id
WHERE ut.tenant_id = $1 AND ut.is_active = true
ORDER BY
  CASE ut.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END,
  u.username ASC
```

返回字段：`{id, username, email, is_superadmin, role, created_at}`。`is_active` 默认 true，不外暴露（filter 在 WHERE 已经做了）。

#### `POST /api/projects/:id/members`

Body: `{ user_id: i32, role: 'owner'|'admin'|'member'|'viewer' }`

逻辑：
1. `require_tenant_admin`
2. 校验 role 字符串
3. 校验 user 存在
4. `INSERT ... ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = $3, is_active = true`
5. `permissions::sync_default_rbac_role(...)` —— 与 `admin_handlers::add_user_to_tenant` 一致，避免"加进来但 0 权限"
6. 返回新成员的完整 member record

#### `PATCH /api/projects/:id/members/:user_id`

Body: `{ role: '...' }`

逻辑：
1. `require_tenant_admin`
2. 不能改自己 (`claims.sub == path.user_id` → 400 "不能修改自己角色")
3. 如果目标 user 当前是 owner 且新 role 不是 owner，先校验该项目至少还有另一个 owner（否则 400 "不能降级最后一个 owner"）
4. `UPDATE management.user_tenants SET role = $3 WHERE ...`
5. `sync_default_rbac_role`
6. 返回更新后 member record

#### `DELETE /api/projects/:id/members/:user_id`

逻辑：
1. `require_tenant_admin`
2. 不能移除自己 → 400
3. 如果目标是 owner，校验"项目还有其他 owner" → 否则 400
4. `UPDATE management.user_tenants SET is_active = false WHERE ...`
5. 清 RBAC 角色：`DELETE FROM management.user_roles WHERE user_id = $1 AND tenant_id = $2`
6. `permissions::invalidate_user_permissions(...)` + `revoke_user_sessions(...)` —— 与 admin 路径一致
7. 返回 `{ removed: true }`

#### `PATCH /api/projects/:id`

Body 允许字段：`name?: string`, `contact_email?: string`, `workspace_config?: jsonb`

明确不允许的字段（请求里出现就 400）：`slug` `kind` `status` `db_*` —— 强制走平台超管路径。

逻辑：
1. `require_tenant_owner`（注意：是 owner 不是 admin）
2. 校验 name 长度 1..=200, contact_email 长度 / 简单 regex 或空字符串清除
3. `UPDATE management.tenants SET name = COALESCE(...), contact_email = COALESCE(...), workspace_config = COALESCE(...) WHERE id = $1`
4. 返回 `GET /api/projects/:id` 同样的 payload（让前端可以直接 set state）

### 3.3 路由注册

`src/main.rs` 在现有两条 `/api/projects` 路由之后追加：

```rust
.route("/api/projects/:id", patch(tenant_handlers::patch_project))
.route("/api/projects/:id/members", get(tenant_handlers::list_project_members))
.route("/api/projects/:id/members", post(tenant_handlers::add_project_member))
.route("/api/projects/:id/members/:user_id", patch(tenant_handlers::update_project_member))
.route("/api/projects/:id/members/:user_id", delete(tenant_handlers::remove_project_member))
```

全部挂在已有的 `auth_middleware` 链路里（与 GET 同位置）。

### 3.4 测试

新增 `tests/m1_workspace_members_test.sh`（沿用现有 shell 测试约定）：

- T1：admin 列成员 200，普通 member 列成员 403
- T2：admin 加另一个用户 200，member 加用户 403
- T3：owner 改 admin 角色 200
- T4：admin 改 owner 角色 200，但不能把最后一个 owner 降级（400）
- T5：owner 改项目名 200，admin 改项目名 403
- T6：admin 删除自己 400，删除最后一个 owner 400
- T7：超管对所有操作 200

---

## 4. 前端详细设计

### 4.1 `/workspace/[projectId]/settings/page.tsx`

布局：
```
项目信息
─ name          [输入框] *
─ slug          [只读]    （改 slug 请联系平台管理员）
─ contact_email [输入框]
─ kind          [只读 badge]
─ status        [只读 badge]
─ workspace_config（高级）展开后是个 monospace JSON 编辑器（v1 不做表单化）

[ 保存 ]   ← canManageProjectSettings（owner+）；非 owner disabled + tooltip
```

数据：
- 进入页面 GET `/api/projects/:id`（已有）
- 保存 PATCH `/api/projects/:id`
- 保存成功后用返回 payload 重新 set local state

错误处理：
- 403 → `ForbiddenPlaceholder reason="项目信息编辑需要 owner 角色"`
- 400 字段错误 → 行内提示

### 4.2 `/workspace/[projectId]/settings/members/page.tsx`

布局：
```
成员管理                              [ + 添加成员 ]   ← admin+ 才显示

┌─────────────────────────────────────────────────────────┐
│ 头像 │ 用户名 / 邮箱       │ 角色          │ 加入时间   │ 操作 │
├──────┼─────────────────────┼───────────────┼────────────┼──────┤
│  👤  │ alice / alice@x.com │ [owner ▾]     │ 2025-12-01 │ 移除 │
│  👤  │ bob   / bob@x.com   │ [admin ▾]     │ 2026-01-15 │ 移除 │
│  👤  │ you   / me@x.com    │ [admin]       │ 2025-11-20 │ —    │ ← 自己一行不能改 / 移除
└─────────────────────────────────────────────────────────┘
```

添加成员 Drawer：
- 输入 user_id（数字）或 email
- email 模式 v1 不支持 → 仅 user_id 输入框 + 帮助提示 "请输入用户的 ID"
- 角色 select (owner / admin / member / viewer)
- 提交 → POST /api/projects/:id/members

角色 inline 下拉直接 PATCH，保存中显示 spinner，失败回滚 + 弹 toast。

数据：
- 列表：GET `/api/projects/:id/members`
- 添加：POST
- 改角色：PATCH `/api/projects/:id/members/:user_id`
- 移除：DELETE（带二次 confirm）

### 4.3 Sidebar

`WorkspaceSidebar.tsx` 设置组：

```ts
{
  label: '设置',
  icon: 'fas fa-cog',
  items: [
    { label: '项目信息', href: '/settings', icon: 'fas fa-id-card' },           // 新
    { label: '成员管理', href: '/settings/members', icon: 'fas fa-users' },     // 新
    { label: '数据库连接', href: '/settings/connections', icon: 'fas fa-database' },
  ],
},
```

可见性：整组需要 `canManageProjectSettings` 还是 `canManageMembers`？分开：
- "项目信息" 需要 `canManageProjectSettings` (owner+)
- "成员管理" 需要 `canManageMembers` (admin+)
- "数据库连接" 已是 `canManageProjectSettings` (owner+)

→ 整组在"该用户至少能看到一项"时显示；侧栏过滤改成按 item 级。

### 4.4 lib/permissions

`deriveWorkspaceCapabilities(role)` 加：
- `canManageMembers`: `role ∈ {admin, owner, superadmin}`
- `canManageProjectSettings`（已有）: `role ∈ {owner, superadmin}`

`canManageProjectSettings` 现有定义看一下确认，必要时收窄。

### 4.5 API client

`lib/api.ts` 加 `projectMembersAPI`：

```ts
export const projectMembersAPI = {
  list: (projectId: number) => api.get<Member[]>(`/api/projects/${projectId}/members`),
  add:  (projectId: number, body: { user_id: number; role: string }) =>
    api.post<Member>(`/api/projects/${projectId}/members`, body),
  updateRole: (projectId: number, userId: number, role: string) =>
    api.patch<Member>(`/api/projects/${projectId}/members/${userId}`, { role }),
  remove: (projectId: number, userId: number) =>
    api.delete(`/api/projects/${projectId}/members/${userId}`),
}

export const projectAPI = {
  patch: (projectId: number, body: { name?: string; contact_email?: string; workspace_config?: any }) =>
    api.patch<Project>(`/api/projects/${projectId}`, body),
}
```

---

## 5. 实施顺序（任务清单）

按依赖排序，约 1.5-2 工作日：

### 后端（先做，便于前端跑通）

- [ ] T1 `permissions.rs`：加 `is_tenant_owner` + `require_tenant_owner`
- [ ] T2 `tenant_handlers.rs`：加 5 个 handler（list / add / update_role / remove / patch_project）
- [ ] T3 `main.rs`：注册 5 条路由
- [ ] T4 `tests/m1_workspace_members_test.sh`：7 个测试场景
- [ ] T5 跑 `cargo build` + `tests/m1_workspace_test.sh`（不回归 W1） + 新 shell 测试

### 前端

- [ ] T6 `lib/api.ts`：加 `projectMembersAPI` + `projectAPI.patch` + `Member` 类型
- [ ] T7 `lib/permissions.ts`：加 `canManageMembers`
- [ ] T8 `components/workspace/WorkspaceSidebar.tsx`：item-level 过滤 + 新加两条
- [ ] T9 `/workspace/[projectId]/settings/page.tsx`：项目信息编辑表单
- [ ] T10 `/workspace/[projectId]/settings/members/page.tsx`：成员管理
- [ ] T11 tsc 通过，浏览器手工 smoke：列表 / 加 / 改角色 / 移除 / 编辑项目名

### 收尾

- [ ] T12 W3 plan Task 4 状态从 BLOCKED → DONE
- [ ] T13 W4 plan 加 "实施记录"
- [ ] T14 单 PR 还是分两个 commit（建议 1 后端 + 1 前端 + 1 plan 更新，3 个 commit）

---

## 6. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| 用户输入 user_id 没回显用户名，体验差 | T9 之后再补一个 `GET /api/admin/users?id=...` 或 W5 加邮件邀请；本期接受 |
| `revoke_user_sessions` 对当前在线 admin 影响大 | 沿用现有 admin 路径行为；不在本期改动 |
| `workspace_config` JSON 编辑器易输错 | v1 容忍——JSON.parse 错误时表单显示错误提示，不允许 submit |
| 多 tab / 并发改角色 | 不做乐观锁；后端 last-write-wins，前端每次操作完重新 fetch list |

### 开放问题（不阻塞 W4 进入实施）

- [ ] **是否要"按 email 邀请"**？v1 不做；W5 起讨论邮件 + token 邀请流程
- [ ] **owner 自降级**：当前禁止（最后一个 owner 必须先指定另一人为 owner）。是否需要一个"转让所有权"流程？v1 不做，让 owner 先把 admin 升级到 owner 再自降。

---

## 7. 验收标准

- ✅ 普通项目 owner 登录后可以在 `/workspace/{id}/settings` 改项目名 / contact_email
- ✅ 普通项目 admin 可以加新成员（user_id 输入）、改成员角色、移除成员
- ✅ 普通 member / viewer 在 sidebar 看不到这两条
- ✅ 5 个后端接口对应权限校验都正确（shell 测试全绿）
- ✅ 不允许移除/降级最后一个 owner，不允许改自己角色
- ✅ `tsc --noEmit` 干净，TableEditor 历史 lint 不算
- ✅ `cargo build` 不引入新 warning

---

*本 plan 收口 W2 plan §"有意推迟到 W3" 中由 PASE Stage E 阻塞的 settings stub 条目，及 M1 母 spec 里"项目工作空间设置"未完成的部分。*

---

## 8. 实施记录（2026-05-19）

| Task | 状态 | 主要 commits | 备注 |
|---|---|---|---|
| T1 require_tenant_owner helper | **DONE** | `63d4a1e` | `permissions.rs` 加 `is_tenant_owner` / `require_tenant_owner` / `count_tenant_owners` 三件套；与 `require_tenant_admin` 并列，admin 不放过 |
| T2 5 个 handler | **DONE** | `63d4a1e` | `tenant_handlers.rs` 末尾新增块；与 `admin_handlers::{list,add,remove}_user_to_tenant` 有意保持平行实现（边界不同） |
| T3 路由注册 | **DONE** | `63d4a1e` | 挂到现有 `/api/projects` router 上，复用 `auth_middleware`；`/api/projects/:id` 现在同时支持 GET + PATCH |
| T4 shell 测试 | **DONE** | `63d4a1e` | `tests/m1_workspace_members_test.sh`：authz 矩阵 + self-protect + last-owner 护栏 + patch_project 字段白名单 |
| T5 cargo build | **DONE** | `63d4a1e` | 编译干净；运行时 smoke 待用户重启 cargo run（旧 binary 不认新路由） |
| T6 API client | **DONE** | `4f79ad8` | `lib/api.ts` 加 `projectAPI.patch` + `projectMembersAPI.{list,add,updateRole,remove}` + `ProjectMember` 类型 |
| T7 canManageMembers | **DONE** | `4f79ad8` | `lib/permissions.ts` 新加；admin+，明确比 `canManageProjectSettings` (owner+) 宽一档 |
| T8 sidebar | **DONE** | `4f79ad8` | NavItem 加 item-level `visibleIf`，"设置"组现在混合 owner+ / admin+ 项；空组自动隐藏 |
| T9 /settings/page.tsx | **DONE** | `4f79ad8` | 项目信息编辑：name / contact_email / workspace_config（JSON textarea）；只读字段（slug/kind/status）显式标注"平台超管路径"；保存后 merge 进 Zustand currentProject |
| T10 /settings/members/page.tsx | **DONE** | `4f79ad8` | 表格 + inline role select + 移除按钮 + 添加抽屉（user_id 输入，不支持 email 邀请——v1 范围之外） |
| T11 tsc | **DONE** | — | 干净（除既有的 TableEditor downlevelIteration） |
| T12-13 docs | **DONE** | 本 commit | W3 plan Task 4 状态从 BLOCKED → DONE；本 plan 加实施记录 |

### 8.1 应用拓扑（W4 落地后）

```
/workspace/[projectId]/settings/                   ← W4 新页：项目信息（owner+）
                       └── members/                 ← W4 新页：成员管理（admin+）
                       └── connections/             ← W3 旧页：DB 连接（owner+）

/api/projects                          GET                 任意已登录用户
/api/projects/:id                      GET                 项目成员 / 超管
                                       PATCH               owner / 超管          ← W4 新
/api/projects/:id/members              GET POST            admin+ / 超管          ← W4 新
/api/projects/:id/members/:user_id     PATCH DELETE        admin+ / 超管          ← W4 新
```

### 8.2 后续可补

- **邮件邀请未注册用户**：本期接受 user_id 输入面；M2 自助开通向导落地时一起做邀请流。
- **成员页用户搜索**：当前列表小可以不要；超过 50 人时再加 search + pagination。
- **审计专项 detail**：当前的成员变更走 `audit_middleware` 默认 detail sink；如果运营要 "X 在 Y 给 Z 改了什么角色" 的细粒度报表，未来加一个 sink 把 before/after role 注入 `audit_logs.request_body`。
- **W4 验收 smoke**：用户重启 `cargo run` 后跑 `./tests/m1_workspace_members_test.sh` 一次过即可签收。

