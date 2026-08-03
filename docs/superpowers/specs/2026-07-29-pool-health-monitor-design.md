# 连接池健康监控页设计

- 日期：2026-07-29
- 状态：已确认，待实施
- 关联：`docs/superpowers/specs/2026-07-29-tenant-pool-listen-isolation-design.md`

## 1. 背景

测试环境发生过一次工作流批量超时事故，日志里全是
`数据库错误: pool timed out while waiting for an open connection`。
排障过程中打开 `/workspace/[projectId]/monitor` 页面，**完全无法定位问题**：

- 页面只展示 PG 服务端指标（`pg_stat_activity` 126 / `max_connections` 1600），
  看起来一切健康 —— 而真正打满的是 OneBase 进程内的 sqlx 租户池（50/50）。
- 应用侧连接池水位（`size` / `num_idle` / `max`）在页面上**根本不存在**。
- LISTEN 会话被 `state IS DISTINCT FROM 'idle'` 过滤掉，看不见它们占了多少连接。
- `pool timed out` 的发生次数 / 时间只存在于日志里，页面无任何计数。

结论：页面缺的不是「更多 PG 指标」，而是**应用侧那一层**，以及一个能直接回答
「谁是瓶颈」的判定。

## 2. 目标与非目标

### 目标

1. 打开页面 3 秒内能看到结论：瓶颈在 OneBase 应用池，还是 PG 服务端。
2. 暴露应用侧 sqlx 池的精确水位（来自 `PgPool::size()` / `num_idle()`，非估算）。
3. 暴露 LISTEN 独立连接数，确认 LISTEN 隔离改造生效。
4. 暴露 `PoolTimedOut` 计数与最近发生时间，把日志里的信号搬到页面上。
5. PG 会话视图包含 `idle` / `idle in transaction`，长事务可见。
6. 提供短期趋势（前端本地攒点，判断是在恶化还是在恢复）。

### 非目标

- 不落库存历史时序（第一期前端本地攒点；需要长期曲线时再上 Prometheus）。
- 不做告警推送。
- 不改任何连接池运行时行为 —— 本设计是**纯观测**。

## 3. 架构

```
┌─ frontend monitor/page.tsx ─────────────────────────────┐
│  verdict 横幅（红/黄/绿 + 一句话结论 + hints）           │
│  水位卡片：应用池 in_use/max · LISTEN · acquire 超时 · PG │
│  sparkline（前端 state 攒最近 60 采样点）                 │
│  Tabs: 诊断 / 应用连接池 / PG 会话 / 慢查询 / 表统计      │
└──────────────────┬──────────────────────────────────────┘
                   │ GET /api/monitor/pool-health   (新)
                   │ GET /api/monitor/connections?include_idle=true (增强)
┌──────────────────▼──────────────────────────────────────┐
│ monitor_handlers::get_pool_health                        │
│   ├─ POOL_MANAGER.primary_watermark(db_id)   ← 进程内    │
│   ├─ POOL_MANAGER.replica_watermarks(db_id)  ← 进程内    │
│   ├─ pool_metrics::snapshot()                ← 进程内    │
│   ├─ management.{tenant_databases,sse_notify_bridges,    │
│   │              workflows}                  ← 主库      │
│   ├─ pg_stat_activity 聚合                   ← 租户库    │
│   └─ diagnose()  ← 纯函数，可单测                        │
└─────────────────────────────────────────────────────────┘
```

**关键点**：应用池水位是进程内 `Arc` 读取，零 DB 开销；这正是之前完全缺失的那一层。

## 4. 新增模块 `src/pool_metrics.rs`

进程内、近似、重启清零 —— 与 `sse_notify_bridge::BridgeMetrics` 同定位。

```rust
pub struct PoolTimeoutEvent { at, database_id: Option<i32>, source: String }
pub struct PoolTimeoutSnapshot { total, by_database, last_at, recent }

pub fn record_timeout(database_id: Option<i32>, source: &str);
pub fn snapshot() -> PoolTimeoutSnapshot;
pub async fn acquire_traced(pool, database_id, source) -> Result<PoolConnection<Postgres>>;
```

- `TOTAL: AtomicU64` + `BY_DB: DashMap<i32, u64>` + `RECENT: Mutex<VecDeque<_>>`（容量 20）。
- `RECENT` 用 `std::sync::Mutex`，临界区内不 `.await`。
- 不记录 SQL 文本，只记 `source`（节点类型 / `http`），避免泄露业务数据。

### 埋点位置

| 位置 | database_id | 说明 |
|---|---|---|
| `error.rs` `PoolTimedOut` 分支 | `None` | 兜底，覆盖所有冒泡到 HTTP 的超时 |
| `workflow_engine` 4 处 `pool.acquire()` | 节点解析出的池 key | 带归因，覆盖被吞掉的节点级失败 |

`workflow_engine` 的池 key 解析：
`extract_datasource_id(config).map(datasource_pool_key).or(ctx.database_id)`。

> 双埋点会让同一次超时在 `total` 里被计两次（节点级 + HTTP 冒泡）。这是可接受的：
> 该指标用于「有没有 / 什么时候 / 大概多严重」，不做精确 SLO 计算。文档与 UI 措辞
> 都写「近似」。

## 5. `pool_manager` 扩展

```rust
#[derive(Serialize)]
pub struct PoolWaterMark { max, min, size, idle, in_use, acquire_timeout_secs }

pub fn watermark(pool: &PgPool) -> PoolWaterMark;

impl PoolManager {
    pub fn primary_watermark(&self, db_id: i32) -> Option<PoolWaterMark>;
    pub fn replica_watermarks(&self, db_id: i32) -> Vec<ReplicaWaterMark>;
}
```

`in_use = size.saturating_sub(idle)`。数据源全部来自 sqlx `PgPool` 自身的
`size()` / `num_idle()` / `options().get_max_connections()` 等（sqlx 0.7.4 已确认存在）。

## 6. 新接口 `GET /api/monitor/pool-health`

鉴权复用 `require_monitor_access`（必须带 `X-Database-Id`，且为该 db 的
owner/admin 或平台超管）—— 与其它 monitor 接口一致，因为响应含连接/会话细节。

```json
{
  "app_pool": {
    "database_id": 2, "max": 50, "min": 1, "size": 12, "idle": 8,
    "in_use": 4, "usage_percent": 8, "acquire_timeout_secs": 30,
    "db_configured_max": 50, "env_override": null, "loaded": true,
    "replicas": [{ "replica_id": 3, "bypassed": false, "watermark": { } }]
  },
  "listeners": { "sse_bridges": 1, "notify_workflows": 10, "dedicated_connections": 11 },
  "acquire_failures": {
    "total": 42, "for_this_database": 30,
    "last_at": "2026-07-29T06:53:52Z",
    "recent": [{ "at": "...", "database_id": 2, "source": "db_query" }]
  },
  "pg": {
    "max_connections": 1600, "instance_backends": 126, "database_backends": 61,
    "active": 2, "idle": 58, "idle_in_transaction": 1, "idle_in_transaction_aborted": 0,
    "listen_sessions": 11, "waiting_on_locks": 0,
    "longest_active_seconds": 1.2, "longest_idle_in_transaction_seconds": 312.0
  },
  "verdict": { "level": "critical", "summary": "…", "hints": ["…"] }
}
```

### PG 聚合查询

单条 `pg_stat_activity` 查询，`WHERE backend_type = 'client backend'`：

- `instance_backends` 不加 `datname` 过滤 —— 这才是与 `max_connections` 可比的量。
- 其余计数用 `FILTER (WHERE datname = current_database() AND …)` 限定本库。
- LISTEN 会话判定用 `query ILIKE 'LISTEN%'`：sqlx `PgListener` 建连后执行
  `LISTEN "chan"` 便长期 idle，`query` 列会一直停留在这条语句上。
- `EXTRACT(EPOCH FROM …)` 在 PG 14+ 返回 `numeric`，聚合后必须
  `(MAX(…) FILTER (…))::float8`，否则 sqlx 解到 `f64` 报类型不匹配。

### listeners 计数

来自主库配置（真实来源，而非猜测）：

```sql
SELECT COUNT(*) FROM management.sse_notify_bridges
 WHERE is_active AND database_id = $1;
```

notify 工作流按 `(database_id, channel)` 去重计数，复用
`workflow_notify_trigger` 的解析规则（`trigger_config->>'database_id'`
回退 `workflows.database_id`）——为此把该模块的
`notify_config_for_workflow` / `NotifyTriggerConfig` 提为 `pub(crate)`，
避免在 handler 里重写一份会漂移的 SQL。

## 7. 判定逻辑 `diagnose()`

纯函数，输入是上面所有已采集的数字，输出 `Verdict`。按优先级取第一条命中：

| 优先级 | 条件 | level | 结论 |
|---|---|---|---|
| 1 | `app.idle == 0 && app.in_use >= app.max` | critical | 应用池打满；再看 PG 占用率决定文案是「瓶颈在应用池」还是「两侧都满」 |
| 2 | `pg_backends / pg_max > 0.9` | critical | PG 实例连接接近上限 |
| 3 | `longest_idle_in_transaction > 60s` | warn | 长事务占连接（给出秒数） |
| 4 | `in_use / max >= 0.8` | warn | 应用池占用偏高 |
| 5 | `dedicated_connections >= 20` | warn | LISTEN 连接偏多，建议合并 channel |
| 6 | `acquire_failures.for_this_database > 0` | warn | 近期有 acquire 超时（进程启动以来） |
| 7 | `waiting_on_locks > 0` | warn | 有会话在等锁 |
| — | 其它 | ok | 一切正常 |

规则 1 是本次事故的正解：应用池 50/50 而 PG 126/1600，必须一句话说明
「瓶颈在 OneBase 池，不是数据库」，并给出可执行 hints：

- 调大 `TENANT_DB_MAX_CONNECTIONS`（当前 env 值一并回显）
- 去「PG 会话」页找 `idle in transaction` / 长查询
- 确认 `WORKFLOW_DB_STATEMENT_TIMEOUT_MS` 生效

`hints` 由规则附带产出，与 level 无关地追加通用项。函数不依赖时钟与 IO，
单测直接构造输入断言 level + summary 关键片段。

## 8. 增强 `GET /api/monitor/connections`

新增 query 参数 `include_idle`（默认 `false`，保持既有行为）：

- `true` 时去掉 `state IS DISTINCT FROM 'idle'` 过滤，LISTEN 会话不再隐形。
- 响应新增 `application_name`、`backend_start`、`xact_duration_seconds`、
  `is_listen`（`query ILIKE 'LISTEN%'`）。
- `LIMIT` 从 20 提到 100（含 idle 后行数变多），并按
  `state='active'` 优先、耗时降序排序，长事务排在前面。

`ActiveConnection` 结构体加字段是**向后兼容**的（前端只多读几列）。

## 9. 前端 `monitor/page.tsx`

- **首屏**：verdict 横幅（level 决定配色 + 图标，summary 大字，hints 列表）。
- **水位行**：4 张卡 —— 应用池 `in_use/max` 带进度条、LISTEN 独立连接、
  acquire 超时次数 + 最近时间、PG `instance_backends/max_connections`。
- PG 的 `database_size` / 表数量 / 缓存命中率 / 运行时间下沉到「PG 概览」区，
  不再抢首屏位置。
- **Tabs**：`诊断` / `应用连接池` / `PG 会话` / `慢查询` / `表统计`。
  `PG 会话` 页默认请求 `include_idle=true`，带 `is_listen` 标记与状态色。
- **sparkline**：自动刷新开启时，把每次采样的
  `app_usage_percent` 与 `pg_instance_backends` push 进 state（`slice(-60)`），
  用内联 SVG polyline 画两条微型曲线。不引新依赖，刷新页面即清空 —— 定位为
  「看趋势方向」，不是历史存档，UI 上明确标注。
- 默认自动刷新保持关闭（避免无人值守时持续打 PG）；但 verdict 为
  critical/warn 时提示用户开启。

## 10. 安全

- 新接口鉴权与既有 monitor 接口完全一致（`require_monitor_access`）。
- `pool_metrics` 不存 SQL 文本，只存 `source` 标签 + 时间戳 + database_id。
- `pool-health` 响应不含任何 SQL 文本；SQL 文本仍只出现在原有的
  connections / slow-queries 接口（已按 owner/admin 收紧）。
- `env_override` 只回显 `TENANT_DB_MAX_CONNECTIONS` 这一个非敏感数值。

## 11. 验证

- `cargo test`：`pool_metrics` 计数/环形缓冲、`diagnose()` 各分支、
  `watermark` 换算。
- `cargo clippy -- -D warnings`。
- 前端 `npm run build` typecheck。
- 手工：测试环境把 `TENANT_DB_MAX_CONNECTIONS` 压到 1，跑并发工作流复现打满，
  确认 verdict 变红且文案指向应用池。
