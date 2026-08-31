# 每库一条 LISTEN 连接（pg_listen_hub）— 设计文档

- 日期：2026-08-24
- 状态：已批准
- 相关代码：
  - `src/workflow_notify_trigger.rs`（每 channel 一条连接）
  - `src/sse_notify_bridge.rs`（每桥一条连接）
  - `src/pool_manager.rs`（`connect_dedicated_listener`）
  - `src/monitor_handlers.rs`（`dedicated_connections` / `diagnose`）

## 1. 背景与目标

生产监控出现「LISTEN 独立连接偏多（23 条）」。这 23 条全部来自启用的 `trigger_type='notify'` 工作流（`SSE 0 · notify 23`），已按 `(database_id, channel)` 去重：引擎对每个 channel `tokio::spawn` 一条独立 `PgListener`，不占业务池，但占用 PG `max_connections`。

**目标**：同一业务库上，notify 工作流与 SSE 监听桥**共用一条**专用 LISTEN 连接；channel 增删热更新（`LISTEN` / `UNLISTEN`），不因配置刷新而整连重连。

### 已确认需求

1. 范围：notify **和** SSE 桥共用（方案 C）。
2. channel 增删：热更新，不断连（方案 A）。
3. 架构：独立 `pg_listen_hub`，两边只登记兴趣（方案 1）。
4. 监控：`dedicated_connections` = 该库 hub **实际打开的连接数**（正常 0 或 1）；卡片 `SSE n · notify m` 仍是兴趣数。

### 非目标（YAGNI）

- 不改业务 `NOTIFY` 格式、工作流 `trigger_config`、`sse_notify_bridges` 表结构。
- 不做一条连接跨多个 `database_id`。
- 不把监控结论改成多条并列（acquire 超时仍可能被其它判定挡住）。
- 不合并 10s 配置扫描循环（notify / SSE 仍各自扫表，只把「起连接」换成「向 hub 登记」）。

## 2. 架构总览

```
main：ListenHub::start()
        │
        ├─ workflow_notify_trigger（10s 扫 notify 工作流）
        │     subscribe / unsubscribe (database_id, channel)
        │
        └─ sse_notify_bridge（10s 扫 sse_notify_bridges）
              每个 BridgeConfig 一条 subscribe（同 channel 不同模板 = 多订阅）

ListenHub
  每 database_id 最多一条 connect_dedicated_listener
  命令队列 + recv：select! 先处理 LISTEN/UNLISTEN，再收通知
  按 notification.channel() 复制分发给该 (db, channel) 的全部订阅者
```

Hub **不知道**工作流或 SSE 业务。订阅者各自在自己的任务里：notify 查匹配工作流并 `execute_workflow_internal`；SSE 做 JSON / `render_topic` / `publish_local` 与原有指标。

## 3. Hub 接口

新建 `src/pg_listen_hub.rs`。`ListenHub` 可 `Clone`（内部 `Arc`）。

```rust
impl ListenHub {
    pub fn start() -> Self;
    /// 登记兴趣。Drop 返回的 Subscription（或显式 unsubscribe）即撤兴趣。
    pub fn subscribe(&self, database_id: i32, channel: &str) -> Subscription;
    /// 该库当前打开的专用 LISTEN 连接数（0 或 1；>1 视为泄漏）。
    pub fn listener_count(&self, database_id: i32) -> u32;
}

pub struct Subscription { /* 不对外暴露内部 sender */ }
impl Drop for Subscription { /* 向 hub 发 unsubscribe */ }

pub struct ListenNotice {
    pub database_id: i32,
    pub channel: String,
    pub payload: String,
}

impl Subscription {
    /// 阻塞直到下一条该 channel 的通知，或订阅被撤销 / hub 关闭。
    pub async fn recv(&mut self) -> Option<ListenNotice>;
}
```

- `channel` 规则与现网一致：非空、trim 后长度 ≤ 63（PG 标识符上限）；不合法的配置仍由两边在扫表时丢弃，不交给 hub。
- 同一 `(database_id, channel)` 允许多条 `Subscription`（两个工作流、或两条 SSE 桥模板）。
- 每条订阅使用 `mpsc::unbounded_channel` 收通知。处理慢只堆积该订阅的内存，**不阻塞** hub 的 `recv` 与其它订阅者。
- 某订阅者 `recv` 循环退出或 task abort 时必须 `Drop` Subscription，否则会泄漏兴趣（管理循环用 HashMap 持有 Subscription，abort 旧 task 前先从 map 拿掉以触发 Drop）。

### 3.1 每库 listener 生命周期

| 事件 | 行为 |
|------|------|
| 该库第一条 `subscribe` | `connect_dedicated_listener`，`LISTEN` 该 channel |
| 已有连接上新 channel 的首个订阅 | 对该名 `LISTEN`，不断连 |
| 某 channel 最后一个订阅离开 | 对该名 `UNLISTEN`，连接保留 |
| 该库订阅清空 | 关掉 `PgListener` + 单连接池 |
| 建连 / `LISTEN` / `recv` 失败 | 该库所有订阅者暂时收不到；`RECONNECT_DELAY`（5s）后重连，并对**当时仍登记**的 channel 全部再 `LISTEN` |
| 配置刷新只改订阅集合 | 不重连 |

`recv` 与命令共用同一 `&mut PgListener`，用 `tokio::select!`（命令优先）：

1. 处理 subscribe/unsubscribe（`listen` / `unlisten`）。
2. `listener.recv()` 得到通知后，按 `notification.channel()` 查找订阅者，`clone` payload 发送。

找不到订阅者的通知（刚 UNLISTEN 的竞态）丢弃，只打 debug。

建连仍走现有 `pool_manager::connect_dedicated_listener`，不占业务 `POOL_MANAGER`。

## 4. 两边管理循环

### 4.1 notify（`workflow_notify_trigger.rs`）

仍每 10s `load_active_notify_configs`（按 `(database_id, channel)` 去重）。`HashMap<NotifyTriggerConfig, …>` 的 value 从 `JoinHandle<()>` 改为：

- 一条 `Subscription`
- 一条消费 task（`recv` → 现有 `build_trigger_data` + `trigger_matching_workflows`）

diff 与现在相同：不在集合里的 abort 消费 task 并 drop Subscription；新配置 `subscribe` 并 spawn 消费。不再调用 `run_listener` / `connect_dedicated_listener`。

`active_listener_count(pool, database_id)` **删除或改为废弃**。监控改为 `ListenHub::listener_count(database_id)`，避免再按配置行数冒充连接数。

工作流匹配、非 JSON payload 跳过、单工作流 `tokio::spawn` 执行：行为不变。

### 4.2 SSE 桥（`sse_notify_bridge.rs`）

仍按完整 `BridgeConfig`（`database_id, channel, topic_template, event_name`）diff。每个配置：

- `hub.subscribe(database_id, channel)`
- 消费 task：现有 JSON / `render_topic` / `publish_local` 与 `BridgeMetrics`

同一 channel、不同模板 = 两条订阅、hub 只 `LISTEN` 一次。不再每桥一条连接。

指标 key 仍是 `(database_id, channel)`：同 channel 多桥时 `received` 会按订阅各加一次（每桥各收一份拷贝）。这与「每桥一条连接时各自 +1」一致。`connected`：该桥的订阅存在且最近一次 `recv` 未因断连退出；hub 重连期间可暂为 false。不要求指标语义比现在更精确。

### 4.3 启动（`main.rs`）

```
let listen_hub = pg_listen_hub::ListenHub::start();
sse_notify_bridge::start(..., listen_hub.clone());
workflow_notify_trigger::start_notify_trigger(..., listen_hub.clone());
// pool-health 能读到 listener_count
app.layer(Extension(listen_hub));
```

先 `start` hub，再启动两个 10s 循环。顺序只保证 handle 已存在；第一条订阅到来才建 PG 连接。

## 5. 监控

`get_pool_health`：

- `sse_bridges`：仍 `COUNT(*)` 启用的 `sse_notify_bridges`（该库）。
- `notify_workflows`：仍按现有去重规则计启用 notify 的 channel 数（可继续用 `load_active_notify_configs` 过滤 `database_id`，**只表示兴趣数**）。
- `dedicated_connections`：`listen_hub.listener_count(database_id)`，**不再** `sse_bridges + notify_workflows`。

`diagnose`：

- 保留 `dedicated_connections >= 20`（多库误用或旧逻辑回潮时仍有提示）。
- **新增**：`dedicated_connections > 1` → Warn「LISTEN 连接泄漏，同库不应超过 1 条」，hints 指向 hub 重复建连。此条放在 `>= 20` **之前**（1 < 20，否则永远轮不到）。
- 其它判定顺序不变（空闲事务 → 应用池 → **泄漏 >1** → **≥20** → acquire 超时 → 锁）。本次**不**改成多结论并列。

前端（必改文案、不新开 API）：合计标为连接数；`SSE n · notify m` 标明是兴趣数，避免 `1` 和 `notify 23` 看起来矛盾。

## 6. 错误处理

| 情况 | 行为 |
|------|------|
| 业务库配置加载失败 | 该库连不上；5s 后重试。已登记订阅保留。 |
| `LISTEN` 某 channel 失败 | 打 warn，5s 后整库重连并补齐当时 channel 集合（不拆掉其它已 LISTEN 的 channel 的订阅登记）。 |
| 订阅方 payload 非法 | 该条跳过，连接不停。 |
| 订阅 task panic | Drop Subscription，下次 10s 扫描会重新 subscribe。 |
| hub 未注入监控 | `listener_count` 视为 0，并打 warn；不要回退到「行数相加」。 |

## 7. 测试要点

不接真 PG。Hub 内部对「连接 / listen / unlisten / recv」用可替换的测试替身（trait 或注入假 listener），断言命令与分发：

- 同库两个 channel：`listener_count == 1`；不同库：`== 1` 各一次（共 2）。
- 同一 channel 两个订阅：两条 `recv` 都拿到同一 payload。
- 某 channel 最后一个订阅离开：对该名发出 `UNLISTEN`；库上订阅清空：关闭连接，`listener_count == 0`。
- 一个订阅者的发送端关掉 / 处理失败：其它订阅者仍能收到后续通知。
- `diagnose`：`dedicated_connections == 2` 走泄漏文案；`== 1` 且兴趣再多也不因 20 条兴趣告警。

Notify / SSE 现有纯函数单测保留。管理循环与 hub 的对接以编译 + 上述 hub 单测为主，不做真库集成。

## 8. 主要改动面

| 文件 | 改动 |
|------|------|
| `src/pg_listen_hub.rs` | 新建 hub |
| `src/lib.rs` / `src/main.rs` | `mod`、启动顺序、`Extension` |
| `src/workflow_notify_trigger.rs` | 订阅替代 `run_listener`；去掉按配置计连接 |
| `src/sse_notify_bridge.rs` | 同上 |
| `src/monitor_handlers.rs` | `dedicated_connections` 来源 + `> 1` 泄漏判定 |
| `frontend-nextjs/app/workspace/[projectId]/monitor/page.tsx` | 可选：连接数 vs 兴趣数文案 |

`connect_dedicated_listener` 签名不变。无 migration。
