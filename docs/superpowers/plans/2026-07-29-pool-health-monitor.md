# 实施计划：连接池健康监控页

- 设计：`docs/superpowers/specs/2026-07-29-pool-health-monitor-design.md`
- 目标：监控页能在 3 秒内指出瓶颈在应用池还是 PG 服务端。

## Task 1 — `src/pool_metrics.rs`（新增）

- [x] `PoolTimeoutEvent` / `PoolTimeoutSnapshot`（`Serialize`）
- [x] `TOTAL: AtomicU64`、`BY_DB: DashMap<i32,u64>`、`RECENT: Mutex<VecDeque>`（cap 20）
- [x] `record_timeout(Option<i32>, &str)` / `snapshot()`
- [x] `acquire_traced(&PgPool, Option<i32>, &str)`：仅在 `PoolTimedOut` 时计数
- [x] `lib.rs` + `main.rs` 注册模块
- [x] 单测：计数累加、by_database 归因、ring buffer 上限、非超时错误不计数

## Task 2 — `src/pool_manager.rs` 水位 getter

- [x] `PoolWaterMark { max, min, size, idle, in_use, acquire_timeout_secs }`
- [x] `watermark(&PgPool)`（`in_use = size.saturating_sub(idle)`）
- [x] `PoolManager::primary_watermark` / `replica_watermarks`
- [x] 单测：`in_use` 换算不下溢

## Task 3 — 埋点

- [x] `error.rs` `PoolTimedOut` 分支调 `record_timeout(None, "http")`
- [x] `workflow_notify_trigger`：`active_listener_count` 供 handler 复用去重规则
- [x] `workflow_engine`：私有 `node_pool_key(config, ctx)`，4 处 `pool.acquire()`
      换成 `pool_metrics::acquire_traced`

## Task 4 — `monitor_handlers::get_pool_health`

- [x] 响应结构体：`PoolHealth` / `AppPoolInfo` / `ListenerInfo` / `PgConnInfo` / `Verdict`
- [x] `diagnose(&VerdictInput) -> Verdict` 纯函数（7 条规则按优先级）
- [x] 主库查询：`tenant_databases.max_connections`、`sse_notify_bridges` 计数、
      notify 工作流去重计数
- [x] 租户库单条 `pg_stat_activity` 聚合（`FILTER` + `::float8` 注意事项见设计 §6）
- [x] `main.rs` 注册 `/api/monitor/pool-health` 到 `monitor_routes`
- [x] 单测：`diagnose` 覆盖 critical(应用池满)/critical(PG 满)/warn 各条/ok

## Task 5 — 增强 `get_active_connections`

- [x] `include_idle` query 参数（默认 false，行为不变）
- [x] 新增 `application_name` / `backend_start` / `xact_duration_seconds` / `is_listen`
- [x] LIMIT 100 + active 优先、耗时降序

## Task 6 — 前端 `monitor/page.tsx`

- [x] `PoolHealth` TS 类型
- [x] verdict 横幅 + 4 张水位卡置顶
- [x] PG 概览区下沉原有 4 个指标
- [x] Tabs 改为 诊断/应用连接池/PG 会话/慢查询/表统计
- [x] `PG 会话` 走 `include_idle=true`，展示 `is_listen` 与长事务
- [x] 内联 SVG sparkline，state 攒 60 点
- [x] verdict 非 ok 时提示开启自动刷新

## Task 7 — 验证

- [x] `cargo test`（pool_metrics / diagnose / watermark）
- [ ] `cargo clippy --all-targets -- -D warnings`（可选，未全跑）
- [x] 前端 monitor 页无新增 TS 错误（仓库另有无关既有错误）
