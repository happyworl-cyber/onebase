# Org Admin Project Manage-Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 组织 owner/admin 无需加入项目即可管理该组织下属项目的管理面（API Key 等经 `require_tenant_admin` 的路径）。

**Architecture:** 在 `permissions.rs` 中央扩展 `is_tenant_admin` / `tenant_admin_ids` / slug 解析；放宽 `get_project` / `list_projects`；前端可选展示 `via_organization` 提示。不放宽 member/owner-only 数据面。

**Tech Stack:** Rust/Axum/SQLx、Next.js、现有 `permissions` / workspace layout。

**Spec:** `docs/superpowers/specs/2026-08-13-org-admin-project-manage-design.md`

## Global Constraints

- 管理面：组织 owner/admin ≡ 项目 admin（对该组织下 active 项目）
- 不改：`is_tenant_member` / `require_tenant_member` / `require_tenant_owner`
- `get_project` 对 org-admin 非成员返回 `user_role: "admin"` + `via_organization: true`
- 不在 org 控制台重做凭证 UI
- 除非用户明确要求，否则不 git commit

## File map

| File | Responsibility |
|------|----------------|
| `src/permissions.rs` | Central admin checks + slug resolve + helper |
| `src/tenant_handlers.rs` | `get_project` / `list_projects` |
| `frontend-nextjs/app/workspace/[projectId]/security/api-keys/page.tsx`（或共享 banner） | 可选 `via_organization` 提示 |
| `docs/superpowers/specs/2026-08-12-organization-project-hierarchy-design.md` | 修订旧表述 |
| Spec status | 标已实现 |

---

### Task 1: permissions — org admin 视为项目 admin

**Files:**
- Modify: `src/permissions.rs`（`is_tenant_admin` ~133、`tenant_admin_ids` ~84、`resolve_database_id_by_slug_for_claims` ~486、`require_tenant_admin` 错误文案）
- Test: 同文件 `#[cfg(test)]` 若已有则追加；否则加小单元测 SQL/helper 逻辑可用的纯函数，或 `cargo test --bin onebase` 已有 permissions 测试

**Interfaces:**
- Produces: `is_tenant_admin` / `tenant_admin_ids` / `resolve_database_id_by_slug_for_claims` 行为扩展；新增 helper 可选：

```rust
/// 用户是否为「该项目所属组织」的 active owner/admin。
pub async fn is_org_admin_for_project(
    pool: &PgPool,
    user_id: i32,
    project_id: i32,
) -> Result<bool> {
    let exists: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM management.tenants t
            JOIN management.organization_members om
              ON om.organization_id = t.organization_id
             AND om.user_id = $1
             AND om.is_active = true
             AND om.role IN ('owner', 'admin')
            WHERE t.id = $2 AND t.status = 'active'
        )
        "#,
    )
    .bind(user_id)
    .bind(project_id)
    .fetch_one(pool)
    .await?;
    Ok(exists)
}
```

- [ ] **Step 1: 实现 `is_org_admin_for_project`**

放在 `is_organization_admin` 附近。

- [ ] **Step 2: 扩展 `is_tenant_admin`**

```rust
pub async fn is_tenant_admin(pool: &PgPool, user_id: i32, tenant_id: i32) -> Result<bool> {
    let via_project: bool = sqlx::query_scalar(
        "SELECT EXISTS( \
            SELECT 1 FROM management.user_tenants ut \
            JOIN management.tenants t ON t.id = ut.tenant_id \
            JOIN management.organization_members om \
              ON om.organization_id = t.organization_id \
             AND om.user_id = ut.user_id AND om.is_active = true \
            WHERE ut.user_id = $1 AND ut.tenant_id = $2 AND ut.is_active = true \
              AND ut.role IN ('owner', 'admin'))",
    )
    .bind(user_id)
    .bind(tenant_id)
    .fetch_one(pool)
    .await?;
    if via_project {
        return Ok(true);
    }
    is_org_admin_for_project(pool, user_id, tenant_id).await
}
```

- [ ] **Step 3: 扩展 `tenant_admin_ids`**

非超管时返回并集（去重）：

```sql
SELECT DISTINCT tid FROM (
  SELECT ut.tenant_id AS tid
  FROM management.user_tenants ut
  JOIN management.tenants t ON t.id = ut.tenant_id
  JOIN management.organization_members om
    ON om.organization_id = t.organization_id
   AND om.user_id = ut.user_id AND om.is_active = true
  WHERE ut.user_id = $1 AND ut.is_active = true
    AND ut.role IN ('owner', 'admin') AND t.status = 'active'
  UNION
  SELECT t.id AS tid
  FROM management.tenants t
  JOIN management.organization_members om
    ON om.organization_id = t.organization_id
   AND om.user_id = $1 AND om.is_active = true
   AND om.role IN ('owner', 'admin')
  WHERE t.status = 'active'
) s
```

- [ ] **Step 4: 扩展 `resolve_database_id_by_slug_for_claims`**

非超管分支在现有 `user_tenants` join 查不到时，再查：

```sql
SELECT td.id
FROM management.tenant_databases td
JOIN management.tenants t ON t.id = td.tenant_id AND t.status = 'active'
JOIN management.organization_members om
  ON om.organization_id = t.organization_id
 AND om.user_id = $1 AND om.is_active = true
 AND om.role IN ('owner', 'admin')
WHERE td.slug = $2 AND td.is_active = true
ORDER BY td.id ASC LIMIT 2
```

合并结果后仍按「0 → NotFound / 1 → Ok / ≥2 → ambiguous」处理。

- [ ] **Step 5: 更新 `require_tenant_admin` 错误文案**

例如：`"需要项目 owner/admin、所属组织 owner/admin，或平台超管才能管理项目 {} 的资源"`

- [ ] **Step 6: `cargo check` + 相关单测**

Run: `cargo check`  
Expected: exit 0  
若有 `permissions` 模块测试：`cargo test --bin onebase permissions -- --nocapture`

---

### Task 2: get_project / list_projects 放行 org admin

**Files:**
- Modify: `src/tenant_handlers.rs` `list_projects` ~2159、`get_project` ~2239

**Interfaces:**
- Consumes: `permissions::is_org_admin_for_project`, `is_organization_admin`
- Produces: JSON 含 `via_organization: bool`（get）；list 含 org 下全部项目

- [ ] **Step 1: 改 `get_project` 角色解析**

替换非超管分支：

```rust
} else if permissions::is_org_admin_for_project(&pool, claims.sub, project_id).await? {
    // 有效管理角色；未必有 user_tenants 行
    let role_opt: Option<String> = sqlx::query_scalar(
        "SELECT role FROM management.user_tenants \
         WHERE user_id = $1 AND tenant_id = $2 AND is_active = true",
    )
    .bind(claims.sub)
    .bind(project_id)
    .fetch_optional(&pool)
    .await?;
    let user_role = role_opt.unwrap_or_else(|| "admin".to_string());
    let via_organization = role_opt.is_none();
    // 继续往下构造 JSON，加入 via_organization
} else {
    permissions::require_tenant_membership_any(&pool, &claims, project_id).await?;
    // 原有取 role / Forbidden
    // via_organization: false
}
```

响应增加 `"via_organization": via_organization`（超管可 `false`）。

注意：若已是项目 member 且同时也是 org admin，`via_organization=false`，`user_role` 用真实项目角色。

- [ ] **Step 2: 改 `list_projects` 非超管查询**

用 UNION 合并「有 user_tenants 的项目」与「org admin 组织下全部 active 项目」：

```sql
SELECT DISTINCT ON (t.id)
  t.id, t.name, t.slug, t.status, t.kind, t.contact_email,
  t.organization_id, o.name AS organization_name,
  COALESCE(ut.role, 'admin') AS user_role,
  (ut.user_id IS NULL) AS via_organization
FROM management.tenants t
JOIN management.organizations o ON o.id = t.organization_id
LEFT JOIN management.user_tenants ut
  ON ut.tenant_id = t.id AND ut.user_id = $1 AND ut.is_active = true
LEFT JOIN management.organization_members om_ut
  ON om_ut.organization_id = t.organization_id
 AND om_ut.user_id = $1 AND om_ut.is_active = true
LEFT JOIN management.organization_members om_admin
  ON om_admin.organization_id = t.organization_id
 AND om_admin.user_id = $1 AND om_admin.is_active = true
 AND om_admin.role IN ('owner', 'admin')
WHERE t.status = 'active'
  AND ($2::int IS NULL OR t.organization_id = $2)
  AND (
    (ut.user_id IS NOT NULL AND om_ut.user_id IS NOT NULL)
    OR om_admin.user_id IS NOT NULL
  )
ORDER BY t.id DESC
```

（若 `DISTINCT ON` 与 `ORDER BY t.id DESC` 冲突，改为子查询/UNION 再外层 ORDER。）更稳妥实现：

```sql
-- branch A: membership projects (existing join)
-- UNION
-- branch B: org-admin projects where no active user_tenants for this user
-- outer SELECT ... ORDER BY id DESC
```

映射 JSON 时带上 `via_organization`（branch B 为 true；A 为 false）。超管可不返回该字段或固定 false。

- [ ] **Step 3: `cargo check`**

Expected: exit 0

---

### Task 3: 前端提示（轻量）

**Files:**
- Modify: `frontend-nextjs/lib/store.ts`（若 `Project` 类型需加 `via_organization?: boolean`）
- Modify: `frontend-nextjs/app/workspace/[projectId]/security/api-keys/page.tsx`（或 workspace 顶栏一次即可）

**Interfaces:**
- Consumes: `currentProject.via_organization` from get_project

- [ ] **Step 1: 类型**

`Project` 增加可选 `via_organization?: boolean`。

- [ ] **Step 2: 提示**

在 API Key 页（或 security layout）顶部：

```tsx
{currentProject?.via_organization && (
  <p className="text-sm text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-4">
    你以租户管理员身份管理本项目（尚未加入为项目成员）。数据面写操作仍需项目 member 角色。
  </p>
)}
```

- [ ] **Step 3: 确认能力门闩**

`deriveWorkspaceCapabilities('admin')` 已含 `canManageSecurity`——无需改 permissions.ts 逻辑；确认 layout 用 `resp.data.user_role` 即可。

---

### Task 4: 文档与冒烟

**Files:**
- Modify: `docs/superpowers/specs/2026-08-12-organization-project-hierarchy-design.md`（API Key/SSO 授权句）
- Modify: `docs/superpowers/specs/2026-08-13-org-admin-project-manage-design.md` 状态 → 已实现

- [ ] **Step 1: 修订层级文档一句**

将「API Key / SSO / IdP 仍绑项目且仅项目角色可管」改为：「资源仍绑 `tenant_id`；管理授权 = 项目 admin **或** 所属组织 admin」。

- [ ] **Step 2: 冒烟清单（手动）**

1. Org admin 非项目成员：打开 `/workspace/{id}/security/api-keys` 成功；创建 key 成功  
2. Org member：403  
3. Schema 写仍失败（非 member）  
4. 重启 `cargo run` 后再测  

---

## Spec coverage

| Spec | Task |
|------|------|
| is_tenant_admin / tenant_admin_ids / slug | Task 1 |
| get_project / list_projects | Task 2 |
| via_organization UI | Task 3 |
| 文档修订 | Task 4 |
| 不改 member/owner | Task 1 明确不碰 |

## Placeholder scan

无 TBD。
