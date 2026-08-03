# P1：平台默认 PG 自动建库（开通项目）

**日期**：2026-06-17  
**状态**：已实现（含 P1.1 每项目独立 PG 角色）  
**范围**：仅 PostgreSQL；Redis 不在本阶段自动创建。

---

## 背景与目标

用户在创建项目时，希望在**当前 Onebase 运行环境**所在的 PG 实例上自动新建项目库，并自动写入 `tenant_databases` 完成关联，无需选择 PG 池或手填 admin 凭据。

Redis、MQ 等中间件 **P1 不做自动开通**；用户可在项目「环境变量」中自行配置 `REDIS_URL` 等（已有 `project_env_vars` 表与工作流读取能力）。

## 非目标（P1）

- 每项目独立 Redis 实例 / ACL
- 外部 Provisioner Webhook（留 P3）
- 自动创建云 RDS / K8s Namespace
- 改动物理部署拓扑

---

## 用户故事

1. 运维一次性配置 `PROVISION_PG_URL`（或确认 `DATABASE_URL` 账号具备 `CREATEDB`）。
2. 用户打开「新建项目」→ 填名称 → 确认创建。
3. 平台在同一 PG 实例上 `CREATE DATABASE`，写入 `management.tenant_databases`，用户成为 owner。
4. 用户进入项目即可使用 API / 表编辑器；若需要 Redis，自行在项目环境变量添加。

---

## 方案概要

### 后端

| 项 | 说明 |
|----|------|
| 环境变量 | `PROVISION_PG_URL`（可选，优先于 `DATABASE_URL`）供建库 admin 凭据 |
| API | `GET /api/provision/pg-pools/platform-instance` — 返回 host/port/管理库名（无密码） |
| API | `POST /api/projects/provision` 新增 `use_platform_pg: true`（与 `pg_pool_id` / `pg_connection` 三选一） |
| 建库 | 复用 `pg_pool_helpers::create_database_with_credentials` |
| 关联 | 现有 `tenant_databases` INSERT 逻辑不变 |
| 元数据 | `workspace_config.provisioned_platform_pg = true` |
| 路由 | PG 只读接口迁至 `/api/provision/pg-pools/*`，避免 `/api/:schema/:table` 误匹配 |

### 前端

| 项 | 说明 |
|----|------|
| 默认模式 | `use_platform_pg: true`（当 `platform-instance.available && provision_ready`） |
| 向导 | 第 2 步保留，默认 Tab「当前平台数据库（推荐）」；PG 池 / 手填为高级选项 |
| 降级 | 平台 PG 不可用时回退 PG 池或手填（与现网一致） |

### 运维 Checklist

```env
# 管理库（已有）
DATABASE_URL=postgresql://onebase:***@10.0.5.33:5432/onebase

# 建库专用（推荐：与业务库账号分离）
PROVISION_PG_URL=postgresql://postgres:***@10.0.5.33:5432/postgres
```

验证：

```bash
psql "$PROVISION_PG_URL" -c "SELECT 1"
psql "$PROVISION_PG_URL" -c "CREATE DATABASE provision_smoke_test"
psql "$PROVISION_PG_URL" -c "DROP DATABASE provision_smoke_test"
```

### Redis（P1 文档约定）

- 平台 `REDIS_URL` 仍为 Onebase 自身用途（限流、Pub/Sub）。
- 业务 Redis：项目 owner/admin 在 **项目 → 环境变量** 添加 `REDIS_URL`。
- 工作流 / 定时任务执行时通过 `ExecutionContext.env_vars` 读取。

---

## 开通流程（序列）

```
用户 → POST /api/projects/provision { use_platform_pg: true, name, slug, template_slug }
  → 解析 PROVISION_PG_URL | DATABASE_URL
  → CREATE DATABASE {slug_as_ident}
  → INSERT tenants + tenant_databases + user_tenants(owner)
  → 模板 DDL + seed RBAC
  → 返回 { project_id, database_id, db_name }
```

失败补偿（已有）：management 写入失败 → `DROP DATABASE` 孤儿库。

---

## 安全说明

- **P1.1（已实现）**：本地 PG 路径（平台 PG / PG 池 / 手填）建库后会创建项目专属
  登录角色 `{db}_app[_xxxx]`，授予**仅该项目库**的全部权限并写入 `tenant_databases`；
  运行期查询以该角色执行，不再使用 admin 凭据，降低凭据泄露影响面。
- 模板 DDL 仍以 admin 身份执行（可建扩展等），随后通过 default privileges +
  `GRANT ALL ON ALL TABLES/SEQUENCES` 把对象权限授予项目角色。
- Webhook 路径由运维返回的专属凭据写入，天然隔离。

### P1.1 配置（`PROVISION_PER_PROJECT_ROLE`）

| 值 | 行为 |
|----|------|
| 未设置 / `auto`（默认） | 尝试建专属角色；admin 无 `CREATEROLE` 时**回退** admin 凭据并告警 |
| `require` / `strict` | 强制；建角色失败 → 回滚孤儿库并报错 |
| `off` / `false` | 关闭，沿用 admin 凭据（旧行为） |

回滚：provisioning 中途失败时，先 `DROP DATABASE` 再 `DROP ROLE`。
删项目（管理库行删除）目前仍**保留**物理库与角色（与孤儿库一致，需人工/运维清理）。

---

## 验收标准

- [x] 配置 `PROVISION_PG_URL` 后，向导默认「当前平台数据库」可一键开通
- [x] 新项目 `tenant_databases` 有正确 host/port/db_name
- [x] 未配置建库权限时，接口返回明确错误（非 `pg-pools` 标识符误报）
- [x] PG 池 / 手填路径仍可用
- [x] 文档说明 Redis 走项目环境变量
- [x] P1.1：默认创建项目专属角色并写入 `tenant_databases`；admin 无权限时按模式回退/报错

---

## 后续（不在 P1）

- P2：Redis 逻辑隔离 + 自动写入 env
- P3：Provisioner Webhook（已实现，见独立 spec）
