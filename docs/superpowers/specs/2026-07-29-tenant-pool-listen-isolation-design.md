# 租户池 LISTEN 隔离 + 池默认抬升 + 工作流语句超时

状态：已批准  
日期：2026-07-29  
关联：`src/pool_manager.rs`、`src/workflow_notify_trigger.rs`、`src/sse_notify_bridge.rs`、`src/workflow_engine.rs`、`src/raw_sql_guard.rs`、`src/tenant_handlers.rs`、`.env.example`

## 背景与动机

测试环境（shirehub-test，`tenant_databases.id=2`）出现集中雪崩：

- `pool timed out while waiting for an open connection`（sqlx 租户池 acquire 超时，默认 30s）
- 工作流 `timeout_ms=30000` 被强制中止（与 acquire 超时重叠，表现为两种错误形态）
- OneBase SQL 编辑器查 `pg_stat_activity` 也 30s 超时（走同一租户池）

直连租户 PG（绕过 OneBase）显示：库侧健康（`max_connections=1600`，几乎无 `idle in transaction` / Lock 等待）。根因在应用侧：

1. **NOTIFY / SSE LISTEN 占用业务池**：`PgListener::connect_with(&pool)` 长驻占用连接。shirehub-test 上约 10 个 notify 工作流 + 1 个 SSE bridge ≈ **每 OneBase 实例固定占 11 槽**；多实例叠加后，池上限 30 时业务余量极小。
2. **重试风暴放大**：`open/get-recommend-list` 等失败后客户端重试，进一步打满剩余槽位。
3. **工作流 PG 节点无 `statement_timeout`**：慢 SQL 可长时间占连接（防护缺口）。

现场已手工将 `id=2` 的 `max_connections` 调至 50 并需重启进程使池重建；本设计从代码侧根治 LISTEN 占池，并抬默认 / 加语句超时。

## 目标

- LISTEN 连接**不占用**业务 `PgPool` 槽位。
- 新建 / NULL 回退的租户库默认 `max_connections`：10 → **20**。
- 支持 `TENANT_DB_MAX_CONNECTIONS`：设置后**完全覆盖**建池用的 max（clamp `1..=50`），便于测试不改库抬池。
- 工作流 Postgres `db_query` / `db_execute` / `db_transaction` / foreach-DB 路径设置 `statement_timeout`（默认 30s，env 可调），用完 RESET。

## 非目标

- 不 migration 批量改写存量 `tenant_databases.max_connections`。
- 不开启租户池 `test_before_acquire`。
- 不改工作流业务侧 `timeout_ms` 配置、不加池水位 metrics（另开）。
- 不改 MySQL/Doris 工作流路径。
- 不合并多 channel 到单 LISTEN 连接（可后续优化；本次只改连接来源）。
- 不改主库 `DB_MAX_CONNECTIONS` 默认。

## 关键设计决策

| # | 决策 | 结论 |
|---|------|------|
| 1 | LISTEN 连接来源 | `PgListener::connect(url)` / 独立 `PgConnectOptions`，**不用** `connect_with(&PgPool)` |
| 2 | 覆盖文件 | `workflow_notify_trigger.rs`、`sse_notify_bridge.rs` |
| 3 | 新建默认 max | `20`（各 `unwrap_or(10)` / 硬编码 10 的建库默认同步） |
| 4 | env 覆盖语义 | `TENANT_DB_MAX_CONNECTIONS` 有合法值时**完全覆盖** DB 配置；非法则 warn 并忽略 |
| 5 | clamp | 与 API 一致：`1..=50`；`min_connections` 继续 `clamped_min(effective_max)` |
| 6 | 生效点 | `POOL_MANAGER.create_pool`（或写入 `DatabaseConfig` 前的统一 `effective_max_connections`） |
| 7 | 工作流语句超时 | 默认 30s；`WORKFLOW_DB_STATEMENT_TIMEOUT_MS`；复用 `raw_sql_guard::apply_session_guards` / `reset_session_guards` |
| 8 | 存量行 | 不自动改；运维 UPDATE 或 env |

## 架构

### 有效 max_connections

```
tenant_databases.max_connections / unwrap_or(20)
        │
        ▼
effective_max_connections(db_value):
  if TENANT_DB_MAX_CONNECTIONS parse ok in 1..=50 → env
  else → clamp(db_value, 1..=50)
        │
        ▼
create_pool(max_connections = effective)
  + log: db_max / effective_max / env_override
```

### LISTEN（改后）

```
notify / sse bridge
  └─ 取 DatabaseConfig（密码解密等与现网一致）
       └─ PgListener::connect(config.connection_url())   // 独立连接
            └─ listen(channel) → recv 循环；断线 sleep 重连
```

业务路径（工作流 DbQuery、AutoAPI 等）仍只通过 `POOL_MANAGER` 的 `PgPool` acquire，不再与 LISTEN 抢槽。

### 工作流 PG 节点

```
acquire conn from pool
  → apply_session_guards(policy)   // statement_timeout + idle_in_transaction_session_timeout
  → 执行 SQL / 事务
  → reset_session_guards(conn)     // 成功与失败路径均执行
  → 归还池
```

## 配置（`.env.example`）

```bash
# 租户池 max_connections 运行时覆盖（设置则完全覆盖 DB 配置；clamp 1..=50）
# TENANT_DB_MAX_CONNECTIONS=30

# 工作流 Postgres 节点 statement_timeout（毫秒，默认 30000）
# WORKFLOW_DB_STATEMENT_TIMEOUT_MS=30000
```

## 错误处理

- env 非法：warn，回退 DB / 默认，不阻断启动。
- LISTEN 独立连接失败：保持现网 warn + 延迟重连。
- `statement_timeout`：节点失败走现有 `AppError::Database`；必须 RESET，避免污染池内连接。

## 测试

- `effective_max_connections`：无 env / 合法覆盖 / 非法回退 / clamp。
- `WorkflowDbTimeoutPolicy::from_env`（或等价）：默认 30s、env 覆盖。
- LISTEN：辅助函数返回独立连接路径；单测或类型上不接受 `PgPool` 作为 listener 源。
- `cargo test` 相关模块 + `cargo check`。

## 风险

- LISTEN 仍占用 PG 后端连接（只是不占业务池）；多实例 × 多 channel 需继续关注 PG `max_connections`（当前测试库 1600，余量充足）。
- 默认 20 + 测试抬到 50 时，同 host 注意 `TENANT_POOL_GLOBAL_MAX_CONNECTIONS`（默认 60）。
- 回滚：LISTEN 改回 `connect_with(pool)`；去掉两 env；新建默认改回 10。

## 成功标准

- 重启后，同一租户库上 LISTEN 会话的 `application_name` / 连接不计入业务池 `size()` 的 checked-out 业务查询竞争（业务池 idle 在无流量时应接近 `min_connections`，不被 11 条 LISTEN 占满）。
- 高并发工作流下不再出现「仅因 LISTEN 占槽」导致的系统性 `pool timed out`。
- 慢 SQL 在约 `WORKFLOW_DB_STATEMENT_TIMEOUT_MS` 内被 PG 中止并归还连接。
