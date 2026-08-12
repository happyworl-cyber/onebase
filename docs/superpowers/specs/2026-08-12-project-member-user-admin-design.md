# 项目成员管理：用户资料 / 密码 / 启停

**日期：** 2026-08-12  
**状态：** 设计已确认，待实现计划  

## 背景

工作空间「成员管理」页已支持：列出成员、添加已有用户、创建用户并加入项目、改角色、移除。  
**不支持**重置密码、改用户名/邮箱、启停账号。平台控制台（`/platform/users`）有部分用户管理能力，但仅面向平台超管 UI，且项目 admin 无法从项目上下文完成这些操作。

## 目标

项目 **owner / admin**（及平台超管）在成员管理页对本项目成员提供：

1. 重置密码  
2. 修改用户名、邮箱  
3. 启用 / 停用账号  

以上属性属于平台用户表 `users`，修改后**全局生效**（影响该用户所有项目与登录）。

## 非目标

- 不在本页提供提升 / 取消平台超管（`is_superadmin`）  
- 不删除用户账号（仍仅平台侧如需保留）  
- 不改变现有项目角色 / 移除成员语义  

## 权限与护栏

| 规则 | 说明 |
|------|------|
| 调用者 | 必须是该项目的 owner/admin，或平台超管 |
| 目标用户 | 必须是该项目的活跃成员（`user_tenants.is_active = true`） |
| 禁止改自己 | `user_id == claims.sub` → 403 |
| 可改平台超管 | 若目标是本项目成员且为平台超管，允许改资料/密码/启停 |
| 不做超管位变更 | 接口与 UI 均不暴露 `is_superadmin` |

UI 文案须明示：改邮箱、停用、重置密码会影响该用户在**所有项目**的身份与登录。

## API

在现有 `/api/projects/:id/members` 旁新增（均需 JWT）：

### 共用前置

1. `permissions::require_tenant_admin(pool, claims, project_id)`  
2. 断言目标用户为本项目活跃成员  
3. `user_id != claims.sub`

### `PATCH /api/projects/:id/members/:user_id/profile`

请求体（至少一项）：

```json
{ "username": "optional", "email": "optional" }
```

- 用户名 / 邮箱格式与唯一性：对齐平台创建用户校验  
- 成功返回更新后的 `{ user_id, username, email }`

### `POST /api/projects/:id/members/:user_id/reset-password`

```json
{ "new_password": "..." }
```

- 密码强度：复用 `admin_handlers::validate_password`（≥8，含大小写字母与数字）  
- 更新 `password_hash` 后 `revoke_user_sessions(..., "password_reset_by_project_admin")`  
- 可选后续增强：设置 `must_change_password=true`（**本期不做**，与现有平台 admin reset 行为对齐）

### `PATCH /api/projects/:id/members/:user_id/status`

```json
{ "is_active": false }
```

- 更新 `users.is_active`  
- 停用时吊销该用户全部会话  
- 启用不强制清会话  

### 列表扩展

`GET /api/projects/:id/members` 响应增加 `is_active: boolean`，默认 `true`（迁移后存量均为 true）。

### 错误约定

| 场景 | 状态 |
|------|------|
| 非项目 admin | 403 |
| 目标非本项目成员 / 改自己 | 403 |
| 用户名/邮箱冲突或格式非法 | 400 |
| 密码不符合强度 | 400 |

## 数据模型

新增迁移：

```sql
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
```

存量用户全部启用。

## 登录与鉴权拦截

1. **`/auth/login`**：若 `is_active = false`，返回明确错误（如「账号已停用」），不签发 token。  
2. **认证中间件**（JWT / 会话校验路径）：已登录用户若被停用，拒绝后续请求（避免停用前签发的 token 继续使用）。实现上优先在查会话/用户时读取 `users.is_active`，与现有 `must_change_password` 门禁同层。

## UI（`/workspace/[projectId]/settings/members`）

### 表格

- 「操作」列：在「移除」旁增加 **管理**；自己那一行不显示「管理」  
- `is_active === false`：用户名旁灰标「已停用」，行样式略淡  

### 管理抽屉

点击「管理」打开（复用 `Drawer`），分区：

1. **资料**：用户名、邮箱，保存调用 `profile`  
2. **密码**：新密码 + 确认；前端强密码校验；成功提示「已重置，对方需重新登录」  
3. **状态**：启用 / 停用；停用二次确认，文案写明全局生效、所有会话立即失效  
4. **项目角色**：沿用现有角色下拉（不可改自己 / 不可移除最后一位 owner）  

可见性：仅 `canManageMembers`。不提供改超管身份入口。

前端 API 客户端：在 `projectMembersAPI` 下增加 `updateProfile` / `resetPassword` / `updateStatus`。

## 实现落点（预期）

| 层 | 文件 |
|----|------|
| 迁移 | `migrations/0xx_users_is_active.sql` + `migrate.rs` 注册 |
| Handler | `src/tenant_handlers.rs`（或紧邻 members 的小模块） |
| 路由 | `src/main.rs` |
| 密码校验复用 | `admin_handlers::validate_password` / `hash_password`（抽公共或同 crate 调用） |
| 登录拦截 | `src/auth_handlers.rs` + `src/middleware.rs` |
| 前端页 | `frontend-nextjs/app/workspace/[projectId]/settings/members/page.tsx` |
| API 客户端 | `frontend-nextjs/lib/api.ts` |
| 参考 UI | `frontend-nextjs/app/platform/users/page.tsx` 重置密码表单 |

## 测试计划

- 项目 admin 可重置本项目成员密码；对非成员 / 自己 → 403  
- 改邮箱/用户名唯一冲突 → 400  
- 停用后无法登录；旧会话失效  
- 非项目 admin 调用新接口 → 403  
- 成员列表正确返回并展示 `is_active`  
- 平台超管作为本项目成员时，可被项目 admin 重置密码 / 停用（按产品选择）  

## 决策记录

| 决策 | 选择 |
|------|------|
| 谁可重置密码 | 项目 owner/admin（非仅超管） |
| 功能范围 | 重置密码 + 改用户名/邮箱 + 启停账号 |
| 全局属性影响 | 允许：目标为本项目成员即可，全局生效 |
| 自己 / 超管护栏 | 不能改自己；可以改本项目内的平台超管 |
| 实现路径 | 新项目作用域 API，不直接复用未收紧的 `/api/admin/users/*` |
| `must_change_password` | 本期不强制；与现有 admin reset 对齐 |
