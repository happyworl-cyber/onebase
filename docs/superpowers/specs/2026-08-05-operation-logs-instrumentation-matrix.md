# 操作日志打点覆盖清单（Instrumentation Matrix）

> 配套设计：`docs/superpowers/specs/2026-08-04-operation-logs-design.md`
> 本文件系统性梳理**哪些位置需要打点**、当前**接入状态**，并给出**回代码核对结论**。
> 核对方式：全仓 grep `operation_log::record` / `record_db_op` / `record_workflow_op` 得到全部打点点，
> 与 `main.rs` 里所有可变更路由（`post/patch/put/delete`）逐一对照。凡未出现在打点点列表中的写端点即"未接"。
> 最后核对时间：2026-08-05。

---

## 1. 判定原则（什么位置需要打点）

**需要打点**（有业务语义、低频、租户内可审计的"人/机器主动操作"）：
- 资源的**结构/配置级写操作**：创建 / 修改 / 删除 / 导入 / 导出 / 触发 / 权限变更 / 恢复。
- 无论来源（Console / MCP / API / Cron / System），只要经过认证映射到租户，都应留痕。

**不需要打点**（记了只会淹没审计、且另有链路覆盖）：
- **行级数据平面**：REST/PostgREST 记录增删改、ES/Redis/Kafka 数据代理与文档读写——高频、量大，由 `audit_logs`（HTTP 审计）+ 执行日志覆盖。
- **纯读**：list/get/查询/SELECT。
- **协议端点**：OIDC/OAuth2 token/userinfo/callback、健康探针——非"业务操作"。
- **高频运行时触发**：工作流 HTTP endpoint 触发（`endpoint_trigger*`）——等同数据平面调用。

**高危判定**（`operation_log::derive_high_risk`，打点方可 `Some(true)` 覆盖）：当前 = 删工作流 / 删表 / 删 Schema / **改表含删列**（`alter_table` 侧按操作集覆盖，删列=数据不可逆丢失）。接入权限/用户/公开分享等模块时需在此增量补规则。

---

## 2. 已接入清单 ✅（P1 工作流 + P2 数据库）

| 模块 | 操作 | 触发点（handler） | action | resource_type | high_risk | source | 变更内容(change) | 代码位置 |
|---|---|---|---|---|---|---|---|---|
| 工作流 | 创建 | `create_workflow` | CREATE | 工作流 | 否 | Console/MCP | created 快照 | workflow_handlers.rs:1129 |
| 工作流 | 修改 | `update_workflow` | UPDATE | 工作流 | 否 | Console/MCP | modified diff | workflow_handlers.rs:1342 |
| 工作流 | 删除 | `delete_workflow` | DELETE | 工作流 | **是** | Console | deleted 快照 | workflow_handlers.rs:1382 |
| 工作流 | 批量启停/删除 | `batch_workflows` | UPDATE/DELETE | 工作流 | 视动作 | Console | 逐条 | workflow_handlers.rs:1498 |
| 工作流 | 导入 | `import_workflows` | IMPORT | 工作流 | 否 | Console | imported 列表 | workflow_handlers.rs:1647 |
| 工作流 | 导出 | `export_workflows_audit` | EXPORT | 工作流 | 否 | Console | — | workflow_handlers.rs:1705 |
| 工作流 | 复制 | `duplicate_workflow` | CREATE | 工作流 | 否 | Console/MCP | created 快照 | workflow_handlers.rs:2144 |
| 工作流 | 手动触发 | `trigger_workflow` | TRIGGER | 工作流 | 否 | Console | — | workflow_handlers.rs:2172 |
| 工作流 | 恢复版本 | `restore_workflow_version` | UPDATE | 工作流 | 否 | Console | modified diff | workflow_handlers.rs:2523 |
| 工作流 | 文档公开开关 | `set_workflow_doc_share` | UPDATE | 工作流 | 开启=是 | Console | — | workflow_handlers.rs:3883 |
| 数据库·表 | 建表 | `create_table` | CREATE | 数据表 | 否 | Console | created(列/索引数) | ddl_handlers.rs:707 |
| 数据库·表 | 删表 | `drop_table` | DELETE | 数据表 | **是** | Console | deleted(schema/级联) | ddl_handlers.rs:897 |
| 数据库·表 | 改表 | `alter_table` | UPDATE | 数据表 | **含删列=是** | Console | modified(增/改/删列) | ddl_handlers.rs |
| 数据库·Schema | 建 | `create_schema` | CREATE | Schema | 否 | Console | — | schema_handlers.rs:233 |
| 数据库·Schema | 删 | `drop_schema` | DELETE | Schema | **是** | Console | deleted(级联) | schema_handlers.rs:346 |
| 数据库·索引 | 建 | `create_index` | CREATE | 索引 | 否 | Console | created(表/方法/唯一/列) | index_handlers.rs:404 |
| 数据库·索引 | 删 | `drop_index` | DELETE | 索引 | 否 | Console | — | index_handlers.rs:524 |
| 数据库·SQL | 原始 SQL(写/DDL) | `execute_sql_query`(/query) | EXECUTE | 数据库 | DROP/ALTER/TRUNCATE=是 | Console | sql(文本/类型/行数) | main.rs:2444 |
| 数据库·SQL | 事务 | `execute_transaction`(/transaction) | EXECUTE | 数据库 | 否 | Console | sql(多语句) | transaction.rs:197 |
| 数据库·导出 | 表 CSV | `export_csv` | EXPORT | 数据表 | 否 | Console | — | export_handlers.rs:61 |
| 数据库·导出 | 表 JSON | `export_json` | EXPORT | 数据表 | 否 | Console | — | export_handlers.rs:139 |
| 数据库·导出 | 任意 SQL 导出 | `export_sql_csv` | EXPORT | 数据库 | 否 | Console | sql | export_handlers.rs:250 |
| 自动化·定时任务 | 创建 | `create_task` | CREATE | 定时任务 | 否 | Console | — | scheduler_handlers.rs |
| 自动化·定时任务 | 修改 | `update_task` | UPDATE | 定时任务 | 否 | Console | — | scheduler_handlers.rs |
| 自动化·定时任务 | 删除 | `delete_task` | DELETE | 定时任务 | 否 | Console | — | scheduler_handlers.rs |
| 自动化·定时任务 | 启用/停用 | `set_active`(pause/resume) | UPDATE | 定时任务 | 否 | Console | — | scheduler_handlers.rs |
| 自动化·定时任务 | 手动触发(立即运行) | `run_now` | TRIGGER | 定时任务 | 否 | Console | — | scheduler_handlers.rs |
| 操作日志 | 审计导出 | `export_operation_logs` | EXPORT | 系统 | 否 | Console | — | operation_log_handlers.rs:404 |

> **注**：`/query` 纯 `SELECT` 按"查询不打点"跳过；`create_table`/`drop_table`/`alter_table` 仅接控制台 handler，外部 v1 API DDL 见 §4。

---

## 3. 待接入清单 ⏳（P3+，按优先级）

| 优先级 | 模块 | 操作 | 触发点 | 建议 action | 建议 resource_type | 建议 high_risk | 备注 |
|---|---|---|---|---|---|---|---|
| P3-高 | RBAC | 角色 建/改/删 | `rbac_handlers::create_role/update_role/delete_role` | CREATE/UPDATE/DELETE | 角色 | 删=是 | 权限面，强审计价值 |
| P3-高 | RBAC | 角色权限设置 | `set_role_permissions` | PERMISSION | 角色 | 是 | 越权风险核心 |
| P3-高 | RBAC | 权限 建/改/删 | `create_permission/update_permission/delete_permission` | CREATE/UPDATE/DELETE | 角色 | 删=是 | |
| P3-高 | RBAC | 授予用户角色 | `assign_user_role` | PERMISSION | 用户 | 是 | |
| P3-高 | 用户 | 用户 建/改/删（超管） | `admin_handlers::admin_create_user/update/delete` | CREATE/UPDATE/DELETE | 用户 | 删/改超管=是 | |
| P3-高 | 安全 | API Key 建/改/删 | `auto_api_handlers::create_api_key/update/delete` | CREATE/UPDATE/DELETE | API | 建/删=是 | 凭证面 |
| P3-高 | 安全 | PAT / 平台令牌 建 | `pat_handlers::create_pat`,`platform_token_handlers::create_platform_token` | CREATE | 系统 | 是 | 凭证面 |
| P3-中 | 项目 | 成员 加/移除 | `add_project_member/remove_project_member` | PERMISSION | 用户 | 移除=是 | |
| P3-中 | 项目 | 项目设置改 | `patch_project`,`update_project_gateway_settings` | UPDATE | 系统 | 否 | |
| P3-中 | 项目 | REST 文档公开开关 | `set_rest_doc_share` | UPDATE | API | 开启=是 | 对齐工作流 doc-share |
| P3-中 | 集成 | 数据源凭证/数据源 建/删 | `datasource_handlers::*` | CREATE/DELETE | 系统 | 删=是 | |
| P3-中 | 集成 | Webhook 建/改/删 | `webhook_handlers::*` | CREATE/UPDATE/DELETE | 系统 | 否 | |
| P3-中 | 集成 | SSE 路由/桥/公开端点 建/改/删 | `sse_route_handlers/sse_notify_bridge_handlers/sse_public_endpoint_handlers::*` | CREATE/UPDATE/DELETE | 系统 | 公开端点删=是 | |
| P3-中 | 集成 | ES/Redis/Kafka 连接与令牌 建/改/删 | `es::admin_handlers/redis_handlers/kafka_handlers::*` | CREATE/UPDATE/DELETE | 系统 | 删=是 | 仅**连接管理**，非数据代理 |
| P3-中 | 安全 | SSO / IDP provider、OAuth2 client 建/改/删 | `sso_handlers/idp_handlers::*` | CREATE/UPDATE/DELETE/PERMISSION | 系统 | 是 | |
| P3-中 | 安全 | RPC ACL 授予/回收 | `rpc::grant_rpc_acl/revoke_rpc_acl` | PERMISSION | API | 是 | |
| P3-中 | 网关 | 网关规则 建/改/删 | `gateway_handlers::*` | CREATE/UPDATE/DELETE | 系统 | 否 | |
| P3-低 | 工作流 | 文件夹 建/删 | `workflow_folder_handlers::create/delete` | CREATE/DELETE | 工作流 | 否 | 分类管理，低频 |
| P3-低 | 项目 | 环境变量 建/删 | `env_var_handlers::create_env_var/delete_env_var` | CREATE/DELETE | 系统 | 否 | 设计文档 P3 首项 |
| P3-低 | 平台 | 租户/副本/PG池/平台设置 建改删 | `tenant_handlers/pg_pool_handlers/platform settings` | CREATE/UPDATE/DELETE | 系统 | 删=是 | 超管级，跨租户，actor 建模待定 |
| P3-低 | 平台 | 监控告警配置/规则 | `platform_monitor_handlers::*` | UPDATE/CREATE/DELETE | 系统 | 否 | |
| P3-低 | 数据库连接 | 连接删除 | `delete_database_connection` | DELETE | 数据库 | 是 | |

---

## 4. 明确不打点清单 🚫（by design，附理由）

| 类别 | 端点 | 不打点理由 |
|---|---|---|
| 行级数据 CRUD | `auto_api_handlers::create_record/update_records/delete_record(+pgrest)` | 数据平面高频；由 `audit_logs`(HTTP) 覆盖 |
| **工作流定时(cron)触发** | `workflow_cron_trigger::fire_due_workflows` | **定时工作流可能每分钟触发、量大淹没审计**；人工触发已打点，自动触发可观测性由执行日志 / `workflow_runs` 覆盖 |
| 定时任务自动执行 | `scheduler` 调度器自动 run | 同上——只记人工管理动作（建/改/删/启停/立即运行），不记每次到点自动执行 |
| 工作流 HTTP 触发 | `endpoint_trigger/endpoint_trigger_get/endpoint_trigger_public` | 等同 API 调用、高频；手动触发已单独打点 |
| ES 数据代理 | `es::proxy_handler::proxy` (GET/POST/PUT/DELETE/PATCH) | 数据平面透传 |
| ES 应用文档 | `es::app_handlers::upsert_doc/patch_doc/delete_doc/delete_index` | 数据平面 |
| 外部 v1 DDL | `v1_create_table/v1_drop_table/v1_alter_table` | 外部 API Key 主体，actor 建模待定；本期只接控制台 |
| OIDC/OAuth2 协议 | `idp_oidc::oauth2_userinfo_post/oauth2_upstream_callback_post` 等 | 协议端点，非业务操作 |
| 纯读 | 所有 list/get/SELECT | 无写语义 |

---

## 5. 回代码核对结论 🔎

**已接入（§2）逐条核对**：28 处打点点全部在代码中就位（见"代码位置"列），并已在测试库 `test_demo` 真机验证过其中：建表 / 改表(删列，高危) / 建索引 / 删索引 / 原始 SQL(高危 DROP) / 表导出 的列表与详情渲染；其余复用同一 `record`/`record_db_op`/`record_workflow_op` + 单测覆盖变更视图格式化。**无缺失、无重复**。

**决策变更（2026-08-05）**：① 工作流**定时(cron)触发打点已移除**（`workflow_cron_trigger`）——太频繁；改列入 §4 不打点。② **自动化·定时任务管理操作**（建/改/删/启停/立即运行）**已接入**（`scheduler_handlers`，人工动作，低频），其**自动到点执行不打点**。

**发现的覆盖缺口（§3 待接）**：以下写端点当前**确实未打点**（grep 全仓 `record*` 无命中）：RBAC(角色/权限/用户角色)、超管用户管理、API Key/PAT/平台令牌、项目成员/设置/REST 文档公开、数据源/Webhook/SSE/ES-Redis-Kafka 连接管理、SSO/IDP、RPC ACL、网关规则、工作流文件夹、环境变量、平台租户/池/设置/监控。均属设计文档 P3+ 分期，非本期遗漏。

**优先级建议**：先补 **P3-高**（RBAC + 用户 + API Key/PAT）——它们是"谁动了权限/凭证"的安全审计核心，且 `resource_type` 常量（角色/用户/API/系统）已就位，接入时只需在 `derive_high_risk` 补"权限变更/凭证建删=高危"规则。

**一致性提示**：接 P3-高时应同步扩展 `operation_log::derive_high_risk`，把 `PERMISSION` 动作、`create/delete API Key`、`delete 用户/角色` 纳入高危，避免只靠各调用点 `Some(true)` 分散判断。
