# 组织管理员：项目管埋面权限（API Key 等）

**日期：** 2026-08-13  
**状态：** 已实现  
**范围：** 组织 owner/admin 无需加入项目即可管理该组织下属项目的管理面资源

## 背景

组织 → 项目层级落地后，凭证与安全配置仍绑 `tenant_id`（项目）。`require_tenant_admin` 仅认 `user_tenants` 的 owner/admin，导致：

- 组织 admin 未加入某项目时，无法管理 API Key / SSO / Webhook / 连接等
- 与「组织 admin 可加人、可看日志」的管理权不一致

## 目标

组织 owner/admin 对该组织下任一 active 项目，拥有与「项目 admin」同等的**管理面**权限，无需先成为项目成员。

## 非目标

- 数据面 DDL / 业务写（仍要项目 member）
- 项目 owner-only（改项目名、转让项目 owner）
- 在组织控制台重做一套凭证管理 UI（仍用工作区 `/workspace/[projectId]/security/...`）
- 改平台超管行为

## 后端

### `permissions.rs`

| 函数 | 变化 |
|------|------|
| `is_tenant_admin` | 原条件 **或** 用户是该项目所属组织的 active owner/admin |
| `require_tenant_admin` | 同上；错误文案可提及组织管理员身份 |
| `tenant_admin_ids` | 并集：原项目 admin 项目 ∪ 用户作为 org admin 的组织下全部 active 项目 |
| `resolve_database_id_by_slug_for_claims` | 非超管：经 `user_tenants` **或** org-admin-of-project 可解析 slug |
| `require_database_admin` | 继续委托 `require_tenant_admin`，自动受益 |

**不改：** `is_tenant_member` / `require_tenant_member` / `require_tenant_owner`。

### `GET /api/projects/:id`

- 组织 admin 且非项目成员：放行
- 返回 `user_role: "admin"`（有效管理角色）
- 可选：`via_organization: true` 供前端提示

### `GET /api/projects`（list）

- 组织 admin 结果集包含其组织下全部 active 项目（与 org 控制台 `view=all` 对齐），`user_role` 对非成员项目填 `"admin"`（或保留真实项目角色若已是成员）

## 前端

- 工作区 layout：依赖上述 `get_project` 放行，无额外特殊分支（403 文案仅对真无权限）
- `deriveWorkspaceCapabilities("admin")` 已覆盖 `canManageSecurity` / `canManageEvents` / `canManageMembers`；`canWriteDatabase` 仍为 false；`canManageProjectSettings` 仍 false
- 若有 `via_organization`：安全相关页可显示轻提示「以租户管理员身份管理本项目」
- `/workspace` 列表随 `list_projects` 扩展可见全部组织项目

## 覆盖面（经中央 gate 自动生效）

API Key、SSO、Webhook、Env vars、RBAC、ES/Redis/Kafka/对象存储连接、定时任务、工作区安全/事件导航等所有现有 `require_tenant_admin` / `require_database_admin` 路径。

## 测试要点

1. Org admin、非项目成员：可 `GET /api/projects/:id`、进入工作区、创建/列出 API Key
2. Org member（非 admin）：仍 403
3. 他组织项目：仍 403
4. 项目 member（非 admin）：仍不能管 API Key
5. Schema/query 写：org admin 非项目成员仍拒绝

## 与既有层级文档关系

修订 `2026-08-12-organization-project-hierarchy-design.md` 中「API Key / SSO 仍仅项目角色」的表述：资源仍绑 `tenant_id`，但**管理授权**扩展为「项目 admin **或** 所属组织 admin」。
