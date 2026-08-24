# Org Access Matrix + Security Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 租户控制台增加「访问」成员×项目矩阵与「安全总览」跨项目摘要，配套两个只读聚合 API。

**Architecture:** `organization_handlers` 新增两个 GET；前端 `OrgSidebar` + 两个 View 组件；矩阵空格复用现有加入项目弹层。

**Tech Stack:** Rust/Axum/SQLx、Next.js、现有 org console 模式。

**Spec:** `docs/superpowers/specs/2026-08-14-org-access-security-overview-design.md`

## Global Constraints

- 鉴权：`require_organization_admin`
- 只读聚合；凭证仍绑项目；不在总览页创建密钥
- 矩阵空格可打开加入弹层（预填 user）；v1 不在矩阵改角色
- 可见性同 org admin+（`canViewOrgLogs` / `canViewLogs`）
- 除非用户明确要求，否则不 git commit

## File map

| File | Responsibility |
|------|----------------|
| `src/organization_handlers.rs` | `organization_member_project_matrix`, `organization_security_overview` |
| `src/main.rs` | 路由注册 |
| `frontend-nextjs/lib/api.ts` | `organizationAPI` 两方法 |
| `frontend-nextjs/components/OrgSidebar.tsx` | nav ids |
| `frontend-nextjs/components/OrgAccessMatrixView.tsx` | 新建 |
| `frontend-nextjs/components/OrgSecurityOverviewView.tsx` | 新建 |
| `frontend-nextjs/app/org/[orgId]/page.tsx` | 挂载 Tab + 预填弹层 |

---

### Task 1: Backend — member-project-matrix API

**Files:**
- Modify: `src/organization_handlers.rs`（在 `organization_stats` 附近新增）
- Modify: `src/main.rs`（organizations 路由组）

**Interfaces:**
- Consumes: `require_organization_admin`, `organization_project_ids`（或直接查 active 项目）
- Produces: `GET /api/organizations/:id/member-project-matrix` → JSON 如 spec

- [ ] **Step 1: 实现 handler**

```rust
/// GET /api/organizations/:id/member-project-matrix
pub async fn organization_member_project_matrix(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(organization_id): Path<i32>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_organization_admin(&pool, &claims, organization_id).await?;

    let members = sqlx::query(
        r#"
        SELECT u.id AS user_id, u.username, u.email, om.role AS org_role
        FROM management.organization_members om
        JOIN users u ON u.id = om.user_id
        WHERE om.organization_id = $1 AND om.is_active = true
        ORDER BY u.username ASC
        "#,
    )
    .bind(organization_id)
    .fetch_all(&pool)
    .await?;

    let projects = sqlx::query(
        r#"
        SELECT id, name, slug FROM management.tenants
        WHERE organization_id = $1 AND status = 'active'
        ORDER BY name ASC
        "#,
    )
    .bind(organization_id)
    .fetch_all(&pool)
    .await?;

    let project_ids: Vec<i32> = projects.iter().map(|r| r.get::<i32, _>("id")).collect();

    let cells = if project_ids.is_empty() {
        vec![]
    } else {
        sqlx::query(
            r#"
            SELECT ut.user_id, ut.tenant_id AS project_id, ut.role
            FROM management.user_tenants ut
            JOIN management.organization_members om
              ON om.user_id = ut.user_id
             AND om.organization_id = $1
             AND om.is_active = true
            WHERE ut.tenant_id = ANY($2) AND ut.is_active = true
            "#,
        )
        .bind(organization_id)
        .bind(&project_ids)
        .fetch_all(&pool)
        .await?
    };

    // map to json members / projects / cells per spec
    Ok(Json(json!({
        "organization_id": organization_id,
        "members": /* ... */,
        "projects": /* ... */,
        "cells": /* ... */,
    })))
}
```

- [ ] **Step 2: 注册路由**

```rust
.route(
    "/api/organizations/:id/member-project-matrix",
    get(organization_handlers::organization_member_project_matrix),
)
```

放在现有 `/api/organizations/:id/stats` 附近。

- [ ] **Step 3: `cargo check`**

Expected: exit 0

---

### Task 2: Backend — security-overview API

**Files:**
- Modify: `src/organization_handlers.rs`
- Modify: `src/main.rs`

**Interfaces:**
- Produces: `GET /api/organizations/:id/security-overview`

- [ ] **Step 1: 实现 handler**

对 org 下 `status='active'` 项目，用一次或几次聚合查询：

```sql
SELECT t.id, t.name, t.slug,
  (SELECT COUNT(*)::bigint FROM management.api_keys k WHERE k.tenant_id = t.id) AS api_keys,
  (SELECT COUNT(*)::bigint FROM management.webhooks w WHERE w.tenant_id = t.id AND w.is_active = true) AS webhooks,
  (SELECT COUNT(*)::bigint FROM management.sso_providers s WHERE s.tenant_id = t.id AND s.is_active = true) AS sso_providers,
  (SELECT COUNT(*)::bigint FROM management.project_idp_providers p WHERE p.tenant_id = t.id) AS idp_providers,
  (SELECT COUNT(*)::bigint FROM management.tenant_databases d WHERE d.tenant_id = t.id AND d.is_active = true) AS databases
FROM management.tenants t
WHERE t.organization_id = $1 AND t.status = 'active'
ORDER BY t.name ASC
```

（若 `api_keys` / `project_idp_providers` 无 `is_active` 则按全量计数；以实际表结构为准。）

返回：

```json
{
  "organization_id": ...,
  "projects": [{ "id", "name", "slug", "api_keys", "webhooks", "sso_providers", "idp_providers", "databases" }]
}
```

- [ ] **Step 2: 路由**

```rust
.route(
    "/api/organizations/:id/security-overview",
    get(organization_handlers::organization_security_overview),
)
```

- [ ] **Step 3: `cargo check`**

Expected: exit 0

---

### Task 3: Frontend API + Sidebar

**Files:**
- Modify: `frontend-nextjs/lib/api.ts`（`organizationAPI`）
- Modify: `frontend-nextjs/components/OrgSidebar.tsx`

**Interfaces:**
- Produces: `organizationAPI.memberProjectMatrix(id)`, `securityOverview(id)`；`OrgNavId` 增加 `'access' | 'security-overview'`

- [ ] **Step 1: api.ts**

```ts
memberProjectMatrix: (id: number) =>
  api.get<{
    organization_id: number
    members: Array<{ user_id: number; username: string; email: string; org_role: string }>
    projects: Array<{ id: number; name: string; slug: string }>
    cells: Array<{ user_id: number; project_id: number; role: string }>
  }>(`/api/organizations/${id}/member-project-matrix`),

securityOverview: (id: number) =>
  api.get<{
    organization_id: number
    projects: Array<{
      id: number
      name: string
      slug: string
      api_keys: number
      webhooks: number
      sso_providers: number
      idp_providers: number
      databases: number
    }>
  }>(`/api/organizations/${id}/security-overview`),
```

- [ ] **Step 2: OrgSidebar**

`OrgNavId` 增加 `'access' | 'security-overview'`。在 `showLogs` 块中（或同条件）加入：

```ts
{ id: 'access', name: '访问', icon: 'fa-th' },
{ id: 'security-overview', name: '安全总览', icon: 'fa-lock' },
```

顺序建议：…统计/监控/审计… 附近，或成员之后：`项目 → 成员 → 访问 → … → 安全总览 → …`

推荐顺序：`projects, members, access, stats, monitor, audit, operation-logs, execution-logs, security-overview, settings`

---

### Task 4: OrgAccessMatrixView + wire page

**Files:**
- Create: `frontend-nextjs/components/OrgAccessMatrixView.tsx`
- Modify: `frontend-nextjs/app/org/[orgId]/page.tsx`

**Interfaces:**
- Props: `{ organizationId: number; onAddToProject: (project: Project, userId: number) => void }`
- 或内部用 projects from parent；打开弹层由 page 回调

- [ ] **Step 1: 实现 View**

- `useEffect` 拉 `memberProjectMatrix`
- 表格：首列成员，其余列项目；`cells` 建成 `Map<`${userId}:${projectId}`, role>`
- 空单元格按钮「—」/`加入` → `onAddToProject(project, userId)`
- 筛选 checkbox：仅显示「cells 中无任何 project」的成员
- loading / error 态对齐 `OrgStatsView`

- [ ] **Step 2: page.tsx**

```tsx
{tab === 'access' && canViewLogs && (
  <OrgAccessMatrixView
    organizationId={org.id}
    onAddToProject={(project, userId) => {
      setProjectAddTarget(project)
      setProjectAddUserId(String(userId))
      setProjectAddRole('member')
      setProjectAddMode('org')
      // reset other form fields...
    }}
  />
)}
```

加入成功后若在 access tab，可 `load()` 或让 View 暴露 `reload`；最简单：成功回调里 View 的 key 用 counter，或 View 自己 listen — v1 关闭弹层后 View 提供刷新按钮即可，或 `onSuccess` 触发 View 内 `load()`。

实现：把 `matrixReloadToken` state 在 `submitAddToProject` 成功后 `+1`，传给 View 的 `reloadToken` prop。

---

### Task 5: OrgSecurityOverviewView + wire + docs

**Files:**
- Create: `frontend-nextjs/components/OrgSecurityOverviewView.tsx`
- Modify: `frontend-nextjs/app/org/[orgId]/page.tsx`
- Modify: `docs/superpowers/specs/2026-08-14-org-access-security-overview-design.md` 状态 → 已实现

- [ ] **Step 1: View**

表格列按 spec；操作列：

```tsx
<a href={`/workspace/${p.id}/security/api-keys`} className="text-xs text-blue-600">
  打开安全
</a>
```

（同页可加 IdP 链：`/workspace/${p.id}/security/idp`）

- [ ] **Step 2: page 挂载**

```tsx
{tab === 'security-overview' && canViewLogs && (
  <OrgSecurityOverviewView organizationId={org.id} />
)}
```

- [ ] **Step 3: 规格状态改为已实现**

- [ ] **Step 4: 冒烟**

1. Org admin 打开「访问」「安全总览」  
2. 空格加人后矩阵刷新有角色  
3. 非 admin 无侧栏项  

---

## Spec coverage

| Spec | Task |
|------|------|
| matrix API | 1 |
| security-overview API | 2 |
| sidebar + api client | 3 |
| Access UI + add modal | 4 |
| Security UI + docs | 5 |

## Placeholder scan

无 TBD。
