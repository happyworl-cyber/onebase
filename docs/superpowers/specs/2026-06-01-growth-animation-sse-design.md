# 成长动画 SSE（PG NOTIFY → 定向推送）— 设计文档

- 日期：2026-06-01
- 范围：OneBase 后端（Rust / axum）+ 管理后台监控页（frontend-nextjs）。
- 目标：用 OneBase 已有的 SSE 能力承接「成长动画 outbox 唤醒」需求，**取代独立 Go 服务**——
  监听业务库的 PostgreSQL NOTIFY，按 `wayUid + projectId` 定向把唤醒事件推给浏览器。

## 1. 背景

业务侧（gamesq）有一套「成长动画 outbox」：业务写入 `gamesq.growth_animation_event`，
DB 触发器 `NOTIFY growth_animation_available`，payload 为：

```json
{ "eventId": 123, "projectId": 1, "wayUid": "adosp9d...", "eventType": "level_unlock" }
```

原方案由一个 Go 服务 `LISTEN growth_animation_available`、维护在线 SSE 连接、按 `wayUid:projectId`
定向推送 `event: growth_animation_available`。前端收到后调 RPC 抢 DB lease，只有抢到的浏览器播放动画。

OneBase 已具备：通用 SSE 总线 `SseHub`、`GET /sse` query-token 订阅、前缀作用域授权
（`user:` / `db:` / `sys:`）、`POST /api/sse/publish`、可配置的 SSE 转发规则（数据变更→topic）。
详见 `docs/superpowers/specs/2026-06-01-sse-capability-design.md`。

**关键缺口**：OneBase 的 `DataChangeEvent` **只在经我们 REST API 写入时**产生
（`src/auto_api_handlers.rs`），DB 触发器/RPC 内部写入不会进事件总线。因此 outbox 的 NOTIFY
覆盖不到现有桥接，需要一条专门的「PG NOTIFY → SSE」监听桥。

## 2. 已定的范围与边界

- **OneBase 建**：
  1. PG NOTIFY 监听桥 + `way:` 定向 topic + 鉴权；
  2. 专用 SSE 端点 `GET /growth-animation/events`；
  3. 管理后台「实时推送监控」页（桥配置 CRUD + 在线连接/推送指标）。
- **业务方建（不在本仓库）**：`gamesq.growth_animation_event` 表、NOTIFY 触发器、
  `console_claim/ack/requeue_growth_animation_events` RPC。OneBase 不碰 outbox 业务逻辑。
- **业务前端（不在本仓库）**：动画 hook / claim-ack / 播放队列在业务前端实现。OneBase
  只提供**端点契约 + 一段参考 hook 代码**。
- **网关信任**：`X-Way-UID` 由上游可信网关注入（剥离客户端自带值后注入可信值），OneBase
  直接信任，**不在本设计内做网关层校验**（与 session hooks 同信任模型）。

## 3. 目标 / 非目标

目标：
- 后端常驻监听业务库 NOTIFY，按 `wayUid + projectId` 定向推送，等价原 Go 服务职责。
- 监听桥**配置驱动**（`management.sse_notify_bridges`），可加任意 `channel → topic`，不写死成长动画。
- 多实例下恰好一次投递、自动重连、脏 payload 不致命。
- 管理后台可见在线连接与推送指标。

非目标（YAGNI）：
- 不实现 outbox 表 / 触发器 / claim-ack RPC（业务方 DB 侧负责）。
- 不实现业务前端动画队列（业务前端负责，仅给参考代码）。
- 不把 NOTIFY 当可靠队列：服务重启期间漏通知可接受，前端有挂载/可见/本地完成等兜底 claim。
- 不做 `Last-Event-ID` 重放、消息缓冲、投递 ack。

## 4. 架构与数据流

```
业务写 gamesq.growth_animation_event
  └─(DB 触发器) NOTIFY growth_animation_available {eventId,projectId,wayUid,eventType}
       └─ OneBase 监听桥（每实例对每个启用的 (database_id,channel) 一条 PgListener）
            └─ 解析 payload → 按 topic_template 算 topic: way:{wayUid}:growth:{projectId}
                 └─ SseHub.publish_local（不经 Redis 扇出）
                      └─ /growth-animation/events 连接（一个用户一条，通配订阅 way:{wayUid}:growth:*）转成 SSE：
                         event: growth_animation_available
                         data:  {"eventId":123,"projectId":1,"eventType":"level_unlock"}
                           └─ 业务前端按 data.projectId 路由到对应社区 → /rpc console_claim_... → 播放 → console_ack_...
```

### 4.1 多实例与去重

PostgreSQL 把 NOTIFY 投给**所有**正在 `LISTEN` 的会话。每个 OneBase 实例各持一条 LISTEN
连接，故每个实例都会收到同一条通知，并**只向本实例的本地连接**投递（`publish_local`，
`replicate = false`，不经 `onebase:sse` Redis 扇出）。浏览器只连一个实例 → **恰好一次**，
无重复、本路径无需 Redis。

### 4.2 一个用户一条连接（覆盖多社区）

用户可同时身处多个社区（project）。端点**不按 projectId 分流**，而是用可信 `X-Way-UID`
通配订阅 `way:{wayUid}:growth:*`：该用户在任意社区的唤醒都走这**同一条** SSE，前端按
`data.projectId` 路由到对应社区 tab。好处：避免每社区一条流顶满浏览器同源连接上限、契约更简。
身份来自网关注入的 `X-Way-UID`，通配也只会订到「自己」的唤醒，无越权。

> 同一社区**多标签页**仍是各自一条 EventSource（浏览器原生限制），属业务前端职责，
> 可用 `BroadcastChannel` / SharedWorker 在前端共享一条流；OneBase 侧不处理（参考代码点到）。

## 5. 组件设计

### 5.1 配置表 `management.sse_notify_bridges`（迁移 `0xx_sse_notify_bridges.sql`）

| 字段 | 说明 |
|---|---|
| `id` | 主键 |
| `database_id` | 要监听的业务库（REFERENCES `management.tenant_databases` ON DELETE CASCADE） |
| `channel` | LISTEN 的频道名，如 `growth_animation_available`（PG 标识符约束：≤63 字节） |
| `topic_template` | 目标 SSE topic 模板，占位符取 NOTIFY payload 字段，如 `way:{wayUid}:growth:{projectId}` |
| `event_name` | SSE `event` 字段，如 `growth_animation_available` |
| `is_active` | 启停 |
| `created_at` / `updated_at` | 同其它表（含 updated_at 触发器） |

> 成长动画 = 一行：`channel=growth_animation_available`、
> `topic_template=way:{wayUid}:growth:{projectId}`、`event_name=growth_animation_available`。
>
> **该行由迁移 seed 写入**（配置仍由表驱动，免去手工录入）。不提供配置 CRUD UI：新增桥属极低频运维，
> 直接 SQL / 迁移即可（见 §5.6 简化说明）。`database_id` 需指向实际业务库——seed 时若该库 id 不确定，
> 用占位/默认值并在文档注明上线前核对（或单独一条运维迁移补齐）。

### 5.2 监听桥 `src/sse_notify_bridge.rs`

`SseNotifyBridge::start(pool, hub)`：
- **配置快照**：后台任务每 10s 从 `management.sse_notify_bridges WHERE is_active` 读出
  `(database_id, channel, topic_template, event_name)`，与当前运行的 listener 集合 diff：
  新增的起 listener、删除/停用的取消。
- **每个 (database_id, channel) 一个 listener 任务**：
  - 复用现有按库取连接的能力（`auto_api_handlers::get_write_pool(main_pool, database_id)`，
    需提升可见性或抽到公共模块），用该业务库 `PgPool` 建 `PgListener::connect_with(&pool)`，`listen(channel)`；
  - 循环 `recv()`：拿到 payload 字符串 → `serde_json::from_str::<Value>` →
    按 `topic_template` 把 `{key}` 替换成 `payload[key]` 的字符串值；
  - 任一被引用的 key 缺失/非标量 → 记 `warn` 跳过该条（不退出）；
  - 解析出 `topic` 后 `hub.publish_local(SseEnvelope { topic, event: event_name, data: payload, ts: now, id: None, replicate: false })`；
    > `data` 暂存完整 payload；**定向端点在转发时再做字段投影并剔除 wayUid**（见 5.4）。
  - `recv()` 出错 / 连接断开 → 记日志，sleep 5s 重连并重新 `LISTEN`。
- **指标**：每个 listener 维护 `received` / `published` / `parse_error` / `reconnect` 计数，
  供监控页读取（见 5.5、5.6）。

`topic_template` 占位符解析为纯函数，便于单测：`render_topic(template, &payload) -> Option<String>`。

### 5.3 `way:` topic 前缀与授权

在 `authorize_topic`（`src/sse.rs`）新增前缀分支：

| 前缀 | 授权条件 |
|---|---|
| `way:{wayUid}:*` | 仅当**连接身份的 way_uid == wayUid** 时放行 |

- 监听桥用 `publish_local` 注入，**绕过** `authorize_topic`（内部可信）。
- 通用 JWT `/sse` 与 `POST /api/sse/publish` 路径上**没有 way_uid**（JWT 只有 `sub`），
  故对 `way:` 一律拒绝（fail-closed）——`way:` topic 只能经 5.4 的专用端点（携带可信 `X-Way-UID`）订阅。
- 超管在通用路径仍可放行（沿用现状），但 `way:` 在专用端点是按身份精确收口，超管不经此路。

### 5.4 专用 SSE 端点 `GET /growth-animation/events`（`projectId` 可选）

- **不挂 `auth_middleware`、不要求 JWT**：读网关注入的 `X-Way-UID` 作为连接身份。
  - `X-Way-UID` 缺失/空 → 401；带了 `projectId` 但非整数 → 400。
- 订阅 topic（由可信头派生，天然只能订到自己的唤醒，无需额外授权步骤）：
  - **默认（不传 `projectId`，方案 B）**：`way:{X-Way-UID}:growth:*`——一条连接覆盖该用户全部社区；
  - **传 `projectId`**：退化为 `way:{X-Way-UID}:growth:{projectId}` 单社区订阅（兼容/调试用）。
- 响应头：`Content-Type: text/event-stream`、`Cache-Control: no-cache, no-transform`、
  `Connection: keep-alive`、`X-Accel-Buffering: no`。
- 连上先发 `event: connected` / `data: {"ok":true}`（传了 `projectId` 则附带 `"projectId":N`）；
  之后 25s 心跳（`: heartbeat`）。
- 订阅 `SseHub`，匹配该 topic（精确 + 末尾 `*` 通配，沿用现有 `topic_matches`），命中即：
  - **字段投影**：从 `env.data` 取 `{eventId, projectId, eventType}`，**剔除 wayUid**；
    （`projectId` 必须保留，前端据此路由到对应社区）
  - 发 `event: growth_animation_available` / `data: {投影后的 JSON}`。
- 连接注册到监控注册表（见 5.5）；context 取消/断开 → 注销。
- 可选增强（默认开）：连上后立即发一次 `growth_animation_available`（空 data 也行），
  让前端立刻 claim 历史 pending outbox。

### 5.5 连接注册表（监控用）

`SseHub` 旁挂一个 `Arc<DashMap<ConnId, ConnMeta>>`：

```rust
struct ConnMeta { way_uid: String, project_id: Option<i32>, connected_at: DateTime<Utc> }
// project_id 为 None 表示通配（方案 B，覆盖该用户全部社区）
```

- 专用端点连接建立时 insert、断开时 remove；
- 全局推送计数（`pushes_total` / `push_targets_total`）用原子计数器。
- 仅进程内、近似值，重启清零——监控/排障用途，不做强一致。

### 5.6 监控（只读，无配置 CRUD）

配置走迁移 seed（§5.1），故**不做配置写接口/表单**。只提供只读监控：

后端 `src/sse_notify_bridge_handlers.rs`（挂 `auth_middleware`）：
- `GET /api/admin/sse-notify-bridges/stats`（唯一接口，只读）：返回
  - 各 listener 运行态：`database_id` / `channel` / 是否连接 / `received` / `published` / `parse_error` / `reconnect`；
  - 在线连接概况：总连接数、按 `project_id`（含通配=null）聚合的连接数；
  - 全局推送计数：`pushes_total` / `push_targets_total`。

前端 `frontend-nextjs`：
- `lib/api.ts` 新增 `sseNotifyBridgeAPI.getStats()`；
- **并入既有「实时推送规则」页**，新增一个**只读「推送监控」tab/区块**展示上述指标（无表单、无增删改）；
- 入口/权限沿用该页现状（`canManageWebhooks`）。

### 5.7 claim / ack（复用，无新增后端）

业务前端收到 `growth_animation_available` 后，经 OneBase 现有 `/rpc` 调
`gamesq.console_claim_growth_animation_events(...)` 抢 lease，播放完成后调
`console_ack_growth_animation_event(...)`。OneBase 不实现这些函数（DB 侧）。

## 6. 接线（`src/main.rs` / `src/lib.rs`）

- `lib.rs`：`pub mod sse_notify_bridge;`。
- `main.rs`：
  - `SseNotifyBridge::start(pool.clone(), sse_hub.clone())`（紧邻现有 `sse_route_manager::start`）；
  - 注册 `GET /growth-animation/events`（query/header 鉴权，**不挂** `auth_middleware`，
    与 `/sse`、`/realtime/ws` 同组）；
  - 注册 `/api/admin/sse-notify-bridges*`（挂 `auth_middleware`）。
- `authorize_topic` 增加 `way:` 分支；专用端点用 `X-Way-UID` 作连接身份。

## 7. 错误处理

| 场景 | 行为 |
|---|---|
| `X-Way-UID` 缺失 | 401 |
| `projectId` 不传 | 通配订阅 `way:{wayUid}:growth:*`（方案 B 默认） |
| `projectId` 传了但非整数 | 400 |
| listener 连接断开 | 记日志，5s 重连并重新 LISTEN |
| NOTIFY payload 非法 / 缺占位符字段 | 记 `warn`，跳过该条，不退出 listener |
| 桥配置被停用/删除 | 下次刷新（≤10s）取消对应 listener |
| broadcast Lagged | 记 `warn`，跳过该批 |
| 空闲连接 | 25s 心跳保活 |

## 8. 可观测性

日志字段（不把 wayUid 写进前端 SSE data，但可写服务端日志）：
- SSE connected/disconnected：`wayUid`、`projectId`、`connId`、`durationMs`；
- NOTIFY received：`channel`、`databaseId`、`eventId`、`projectId`、`eventType`；
- wake-up sent：`topic`、`targetCount`；
- listener reconnect：`databaseId`、`channel`、`attempt`、`error`。

## 9. 测试

- 单测 `render_topic`：占位符替换、缺字段返回 None、非标量值处理。
- 单测 `authorize_topic` 的 `way:` 分支：身份匹配放行、不匹配拒绝、JWT 路径无 way_uid 即拒绝。
- 单测 payload 投影：保留 `eventId/projectId/eventType`、剔除 `wayUid`。
- 集成/手动：业务库 `SELECT pg_notify('growth_animation_available', '{...}')`，
  另开 `curl -N -H 'X-Way-UID: u1' '/growth-animation/events'`（通配，方案 B 默认）验证多社区共用一条流；
  再用 `?projectId=1` 验证单社区退化路径。

## 10. 文件清单

已落地（新增）：
- `src/sse_notify_bridge.rs`（监听桥 + `render_topic` + `BridgeMetrics` + 重连 + 10s 配置刷新；含 `render_topic` 单测）。
- `src/sse_notify_bridge_handlers.rs`（**仅** `GET /api/admin/sse-notify-bridges/stats` 只读，**限超管**）。
- `migrations/024_sse_notify_bridges.sql`（配置表 + updated_at 触发器 + **注释版示例 INSERT**），已注册进 `src/migrate.rs`。
- `docs/superpowers/specs/2026-06-01-growth-animation-frontend-reference.md`（业务前端参考：端点契约 + hook + claim/ack）。

已落地（修改）：
- `src/sse.rs`（`authorize_topic` 显式 `way:` fail-closed 分支；`ConnMeta` 连接注册表 + 推送计数；
  `growth_events_handler` 专用端点 + `project_growth_data` 投影；含单测）。
- `src/auto_api_handlers.rs`（`get_write_pool` 提升为 `pub(crate)` 供监听桥复用）。
- `src/main.rs`（`mod` 声明、启动监听桥 + 注入 `BridgeMetrics`、注册 `/growth-animation/events`
  与 `/api/admin/sse-notify-bridges/stats`）。
- `frontend-nextjs/lib/api.ts`（`sseNotifyBridgeAPI.getStats`）+ `app/dashboard/sse-routes/page.tsx`
  加只读「推送监控」tab。

> 不新增配置 CRUD 接口/表单/独立设置页。**成长动画那一行配置由运维执行迁移末尾示例 INSERT**
> （通用迁移无法预知业务库 `database_id`，硬塞会触发 FK 报错）。

## 11. 假设与待办

- 假设业务库已存在 outbox 表 + 触发器 + RPC（业务方提供）；联调前需对方先建好。
- 假设网关在 `/growth-animation/events` 上注入可信 `X-Way-UID`（部署侧保证，不在本设计校验）。
- `database_id` → 业务库连接串：复用现有租户库连接管理（与 scheduled-task RPC、auto API 同源）。
