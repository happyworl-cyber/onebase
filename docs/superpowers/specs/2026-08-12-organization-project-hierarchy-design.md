# 租户 → 项目层级

**日期：** 2026-08-12  
**状态：** 已实现（P0–P2 + 三层控制台 UX）  

**产品入口（A：仅平台建租户）：**
- 平台：`/platform/organizations` 创建/管理租户与成员
- 租户：`/orgs` → `/org/[orgId]` 管理项目与租户成员
- 项目：`/workspace/[projectId]/...` 管理项目功能


**实现计划：** `docs/superpowers/plans/2026-08-12-organization-project-hierarchy.md`  


## 背景

系统当前用「项目」充当租户边界：产品与 API 称 project，数据库与鉴权使用 `management.tenants` / `tenant_id`（`projectId === tenant_id`）。缺少「一个租户下管理多个项目」的层级。

## 目标

引入：

```text
Organization (租户) → Project (项目 = 现 tenants 行) → 资源
```

- 产品命名：上层「租户 / 组织」，现有实体继续叫「项目」
- 资源仍挂项目（DB、API Key、SSO、工作流、Webhook 等）
- 两级成员：先入租户，再入具体项目
- 存量 1:1：每个现有项目自动生成同名租户并挂唯一子项目；原 `user_tenants` 映射为租户成员 + 保留项目成员

## 非目标

- 资源 / SSO / API Key 上提到租户
- URL 改为 `/org/:id/project/:id`
- 重命名全部 `tenant_*` 表列
- 计费 / 配额产品化

## Schema 策略

**新增 `organizations`，保留 `tenants` 当项目**（不迁移资源表 FK）。

| 产品 | 数据库 |
|------|--------|
| 租户 | `management.organizations` |
| 项目 | `management.tenants`（`tenant_id` = project id） |
| 租户成员 | `management.organization_members` |
| 项目成员 | `management.user_tenants` |

### 新表

```sql
management.organizations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(50) UNIQUE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active', -- active, suspended, deleted
  contact_email VARCHAR(255),
  created_at, updated_at
)

management.organization_members (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id INTEGER NOT NULL REFERENCES management.organizations(id) ON DELETE CASCADE,
  role VARCHAR(50) NOT NULL DEFAULT 'member', -- owner | admin | member
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, organization_id)
)
```

### 变更

```sql
ALTER TABLE management.tenants
  ADD COLUMN organization_id INTEGER REFERENCES management.organizations(id);
-- 回填后 NOT NULL + 索引
```

新项目 `kind = 'project'`；`legacy_tenant` 仅历史标记。

### 迁移（一一对应）

对每个现有 `tenants` 行：

1. 插入同名 `organizations`（slug 冲突则加 `-{id}`）
2. 回填 `tenants.organization_id`
3. 从 `user_tenants` 派生 `organization_members`：`owner`/`admin` 保持，`member`/`viewer` → `member`
4. 保留原 `user_tenants` 项目角色不变

校验：无孤儿项目；凡有活跃项目成员必有对应活跃租户成员。

## 鉴权

三层：平台超管 → 租户角色 → 项目角色（+ 项目内 RBAC）。

JWT **不带** `organization_id` / `tenant_id`；上下文仍由 path / header 选择。

### 租户角色

| 角色 | 能力 |
|------|------|
| owner | 改租户信息；管成员；创建/归档项目；转让 owner |
| admin | 管成员；创建项目；把用户加入下属项目 |
| member | 仅进入自己已加入的项目；不能建项目、不能管租户成员 |

Org admin/owner **不**自动拥有全部项目进入权；可看管理视图（`?view=all`）以便加人。

### 项目角色

沿用 `user_tenants`：`owner` / `admin` / `member` / `viewer` 与现有 `require_tenant_*`。

新增：`require_organization_admin` / `require_organization_member`。

项目加人：目标用户必须已是该项目所属组织的 active 成员。  
项目 API：组织成员 + 项目成员双 active（从租户移除后即使残留 `user_tenants` 也拒绝）。

API Key / SSO / IdP 等资源仍绑 `tenant_id`；**管理授权** = 项目 admin **或** 所属组织 active owner/admin（数据面写仍须项目 member）。

## API

### Organization

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/organizations` | 我加入的租户（含 role） |
| POST | `/api/organizations` | **仅平台超管**创建租户；可选 `owner_user_id` |
| GET/PATCH | `/api/organizations/:id` | 详情 / 更新（PATCH：owner；status 仅超管） |
| GET/POST/PATCH/DELETE | `/api/organizations/:id/members` | 租户成员（admin+） |
| GET | `/api/organizations/:id/member-candidates?q=` | 搜索尚未入租户的平台用户 |
| GET | `/api/organizations/:id/projects` | 默认：我加入的活跃项目；`?view=all`：org admin+ 看全部（含已归档 suspended） |
| POST | `/api/organizations/:id/projects` | 在租户下开通项目 |
| PATCH | `/api/organizations/:id/projects/:project_id` | 租户 owner 归档/恢复项目（`status`: suspended / active） |
| POST | `/api/organizations/:id/projects/:project_id/members` | 租户 admin 把租户成员加入项目 |
| POST | `/api/organizations/:id/transfer-owner` | 租户 owner 转让 owner（目标升 owner，调用方降 admin） |

### Project（兼容）

- `GET /api/projects`：可选 `organization_id`；默认仍返回我作为项目成员可见的项目
- `GET/PATCH /api/projects/:id`：响应增加 `organization_id`、`organization_name`
- `POST /api/projects/provision`：**必须**带 `organization_id`（禁止隐式建租户）
- `/api/projects/:id/members`：加人时校验目标已是组织成员；搜索仅返回本租户成员
- `/api/tenants/*`、`X-Tenant-Id`：语义仍指向**项目**
- `POST /api/admin/tenants*`：**Deprecated**，请改走 organizations API

## 前端

```text
登录
 ├─ 超管 → /platform/organizations（租户管理）或 /platform（按租户分组的项目总览）
 └─ 普通用户 → /orgs → /org/[orgId]（租户控制台）→ /workspace/[projectId]
```

- store：`currentOrganization` + 现有 `currentProject` / `currentConnection`
- Topbar：租户名 / 项目名；「返回租户控制台 / 切换租户」
- 项目请求仍注入 `X-Tenant-Id` = project id

## 分期

| 阶段 | 内容 |
|------|------|
| P0 | Migration、Organization API、项目响应字段、加人校验（前端可不变） |
| P1 | 租户→项目选择、store/Topbar、`POST .../organizations/:id/projects` |
| P2 | Deprecated 旧 provision、平台组织维度与文案、文档对齐 |

## 验收

- 存量用户可进入原项目；组织/项目成员映射正确
- 同一组织下可建第二项目；非项目成员不可进入
- 旧 `X-Tenant-Id` + project API 行为兼容
- 连接池 / API Key / 工作流隔离仍按 project/`tenant_id`
