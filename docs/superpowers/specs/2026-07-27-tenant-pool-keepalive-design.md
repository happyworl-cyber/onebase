# 租户连接池预热 / 保活设计

状态：已实现
日期：2026-07-27
关联：`src/pool_manager.rs`、`src/auto_api_handlers.rs`、`src/main.rs`

## 背景与动机

生产 access log 同一 `x_request_id` 出现：

1. `创建连接池: id=1, host=39.105.42.63:5432`
2. 「慢查询」`SELECT * FROM uba_alert_rules …`（应用侧墙钟约 800ms）
3. `elapsed_ms ≈ 4100`

同接口在池已热时仅 **5–6ms**；经 Supabase 直连同库也很快。根因是 **租户池在本进程尚未建立 / 无可用连接时，业务请求扛了 TCP+认证**，不是 SQL 本身慢。

当前 `POOL_MANAGER::create_pool` 未设置 `min_connections` / `idle_timeout` / `max_lifetime`，且无启动预热；主库池（`src/db.rs`）已有完整保活配置。

## 目标

- 租户池创建时至少建立 **1** 条物理连接（可配置），避免 `pool.begin()` 首次建连打在业务请求中段。
- 空闲 / 生命周期策略与主库同量级，且 **始终维持 `min_connections`**，降低「隔一阵又冷」概率。
- 进程启动后 **后台预热** 活跃 primary 租户库，把「创建连接池」移出首个用户请求。
- 可用环境变量关闭预热或限制数量，避免租户极多时拖垮启动。

## 非目标

- 不合并 `set_config` 与业务 SQL（方案 B，另议）。
- 不改部署拓扑 / 不引入 PgBouncer。
- 不对租户池开启 `test_before_acquire`（跨公网 RTT 下每请求多一趟；坏连接由查询失败 + 池自愈处理）。
- 不在本次做副本探活增强（已有 `replica_watchdog`）。

## 关键设计决策

| # | 决策 | 结论 |
|---|------|------|
| 1 | 范围 | 仅方案 A：租户池 min/idle/lifetime + 创建后探活 + 启动预热 |
| 2 | `min_connections` 默认 | `1`（env: `TENANT_DB_MIN_CONNECTIONS`） |
| 3 | `idle_timeout` 默认 | `600` 秒（env: `TENANT_DB_IDLE_TIMEOUT`） |
| 4 | `max_lifetime` 默认 | `1800` 秒（env: `TENANT_DB_MAX_LIFETIME`） |
| 5 | 创建后 | `SELECT 1` 校验；失败则创建失败（与主库一致） |
| 6 | 预热默认 | 开启（`TENANT_POOL_PREWARM=true`）；查 `is_active` 且 `COALESCE(db_role,'primary')='primary'` |
| 7 | 预热上限 | 默认最多 50 个（`TENANT_POOL_PREWARM_LIMIT`）；并发默认 4（`TENANT_POOL_PREWARM_CONCURRENCY`） |
| 8 | 预热失败 | 单库失败只打 warn，不影响进程启动与其它库 |
| 9 | API | 复用 `ensure_pool_loaded`（改为 `pub(crate)`），保证 replica 一并挂载 |

## 架构

```
main 启动
  └─ spawn_tenant_pool_prewarm(management_pool)
       └─ 并发 ensure_pool_loaded(id)
            └─ POOL_MANAGER.get_or_create_pool / upsert_replica
                 └─ create_pool: min=1 + idle/lifetime + SELECT 1

业务请求
  └─ ensure_pool_loaded（快路径：池已在 → 无「创建连接池」日志）
       └─ begin() 复用已有连接
```

## 观测

- 预热：`info` 汇总成功/失败数；单库失败 `warn`。
- 业务路径：预热完成后，同库请求不应再出现「创建连接池」（除非 `remove_pool` 或新库）。
- 成功标准：冷启动后首个用户请求的 `elapsed_ms` 接近热路径（数 ms～数十 ms 量级，仍受 `set_config` RTT 影响）。

## 风险

- 租户库不可达时预热会打 warn 并占用启动期并发；limit/concurrency 可调。
- 多副本部署时每个 pod 各持 `min_connections`：租户 PG 的 `max_connections` 需留余量（默认每库每 pod 1 条，通常可接受）。
- `max_connections`（配置字段，默认 10）必须 `>= min_connections`；实现时 clamp。

## 测试

- 解析租户池选项的纯函数单测（默认值 / env 覆盖 / min≤max clamp）。
- `cargo check` / 相关 unit tests。
- 手工：重启后日志应先有预热「创建连接池」，再打业务请求时无新建池；`elapsed_ms` 无冷启动尖刺。
