# SSE（Server-Sent Events）通用推送能力 — 设计文档

- 日期：2026-06-01
- 范围：后端能力（Rust / axum）。不含前端客户端封装。
- 目标：在现有 `EventBus` / WebSocket / Redis 桥接之上，提供一个**通用的服务端→客户端单向推送通道**，业务侧可按 topic 订阅，既能收自定义业务消息（任务/工作流进度、通知、日志），也能收现有的数据变更事件。

## 1. 背景与现状

项目已具备"服务端推送"的基础设施：

- `src/events.rs` — `EventBus`，基于 `tokio::sync::broadcast`，承载 `DataChangeEvent`（`tenant_id` / `database_id` / `schema` / `table` / `action` / `old_data` / `new_data` / `user_id` / `timestamp` / `request_id`）。
- `src/realtime.rs` — WebSocket 端点 `GET /realtime/ws?token=xxx`，用 query token 鉴权（`verify_token`），按 `schema.table` channel 订阅，从 `start_broadcaster()` 派生的 broadcast 推送数据变更。
- `src/redis_pubsub.rs` — `RedisPubSubBridge`，把本地 `EventBus` 的事件经 Redis channel `onebase:events` 跨实例广播。

`DataChangeEvent` 是写死的结构，无法承载任意业务消息，因此 SSE 不直接复用 `EventBus`，而是新建一条通用总线 `SseHub`，并把 `DataChangeEvent` 桥接进来。

JWT `Claims`（`src/auth.rs`）只含 `sub`（用户 ID）与 `is_superadmin`，**不含 tenant / project**。因此"本人"维度的 topic 可直接凭 token 授权，库 / 项目维度的 topic 需要查库做成员校验。

## 2. 目标 / 非目标

目标：

- 通用 topic 级 pub/sub，客户端连接时声明订阅 topic 列表。
- 三条 publish 入口：① 内部 Rust 调用 `hub.publish(...)`；② 鉴权的 HTTP `POST /api/sse/publish`；③ 自动桥接现有 `DataChangeEvent`。
- 订阅与发布均做**前缀作用域授权**，防止越权窃听他人/他库/他项目的消息。
- 多实例下经 Redis 扇出（与现有 `redis_pubsub` 同模式），且无回环、无重复投递。

非目标（YAGNI）：

- `Last-Event-ID` 重放 / 服务端消息缓冲。
- 每条消息 ack / 投递确认。
- 连接建立后动态改订阅（SSE 是单向流；改订阅 = 重连）。

## 3. Topic 命名约定与授权

Topic 以 `:` 分隔，首段为作用域前缀，驱动授权判定：

| 前缀 | 示例 | 授权通过条件 |
|---|---|---|
| `user:{uid}:*` | `user:5:notify` | `uid == claims.sub` |
| `db:{dbId}:*` | `db:2:table:public.posts` / `db:2:workflow:99` | 用户是该 db 所属租户的 active 成员 |
| `sys:*` | `sys:broadcast` | 仅超级管理员 |

> 说明：本项目中 `project_id` 只是业务表里的一个 RLS 过滤列，**没有平台级的 projects / 成员关系表**，因此无法对 `project:` 做可靠的成员校验。工作流 / 任务进度等业务消息统一挂在 `db:{dbId}:*` 下（工作流本就绑定 `database_id`），不引入 `project:` 前缀。

`async fn authorize_topic(pool, claims, topic) -> bool`：

- `claims.is_superadmin == true` → 放行所有；
- `user:{uid}:*` → `uid == claims.sub`；
- `db:{dbId}:*` → `user_can_access_database`：超管放行，否则查 `management.tenant_databases` 反查所属 tenant，再查 `management.user_tenants` 确认用户是该租户 active 成员（任意角色，复用 `permissions.rs` 的查询模式）；
- 其它/未知前缀 → 拒绝（fail-closed）。

订阅时**任一 topic 授权失败即整连 403**（明确拒绝，便于排错）；topic 列表为空 → 400。

## 4. 组件设计（新建 `src/sse.rs`）

### 4.1 SseEnvelope

```rust
#[derive(Clone, Serialize, Deserialize)]
pub struct SseEnvelope {
    pub topic: String,
    pub event: String,          // SSE event 类型，如 "message" / "INSERT" / "progress"
    pub data: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,     // 可选 SSE id 字段
    pub ts: DateTime<Utc>,
    #[serde(skip)]
    pub replicate: bool,        // 是否经 Redis 跨实例扇出（防回环用）
}
```

### 4.2 SseHub

封装 `broadcast::Sender<SseEnvelope>`（容量 4096），作为 axum `Extension` 注入（与 `RealtimeManager` 同模式）：

- `publish(topic, event, data, id)` — `replicate = true`，本地 `send`；
- `publish_local(env)` — `replicate = false`，本地 `send`（数据变更桥接、Redis 订阅端回注使用）；
- `subscribe() -> broadcast::Receiver<SseEnvelope>`；
- 可选 `connection_count()`（统计用，`DashMap`）。

### 4.3 SSE 端点 `GET /sse?token=<jwt>&topics=a,b,c`

- **不挂 `auth_middleware`**：浏览器 `EventSource` 不能设自定义 header，沿用 `/realtime/ws` 的 query-token 方案；`verify_token(token)` 失败 → 401。
- 解析 `topics`（逗号分隔），逐个 `authorize_topic`；空 → 400，任一失败 → 403。
- 返回 `axum::response::Sse<Stream<Item = Result<Event, Infallible>>>`：订阅 `hub`，按订阅 topic 过滤（精确匹配 + 末尾 `*` 通配前缀，如 `db:2:*`），命中则映射为 SSE `Event`（`.event(env.event)`、可选 `.id(...)`、`.json_data(env.data)`）。
- `KeepAlive::new().interval(Duration::from_secs(15))`：发送注释心跳，避免反代/负载均衡空闲超时断流。
- broadcast `Lagged` → 记日志并跳过；`Closed` → 结束流。

### 4.4 HTTP 发布 `POST /api/sse/publish`

- 挂 `auth_middleware`（JWT，注入 `Claims`）。
- Body：`{ topic, event, data, id? }`。
- 同样跑 `authorize_topic`（发布作用域 = 订阅作用域）；失败 → 403。
- 调 `hub.publish(...)`，返回 `{ "ok": true }`。

## 5. 数据流与多实例

### 5.1 数据变更桥接

后台任务订阅 `EventBus`，把每个 `DataChangeEvent` 映射为：

- `topic = "db:{database_id}:table:{schema}.{table}"`
- `event = action`（INSERT/UPDATE/DELETE）
- `data = new_data.or(old_data)`

并以 `publish_local`（`replicate = false`）注入 `SseHub`。**不**走 SSE-Redis 扇出——因为 `EventBus` 已经被现有 `redis_pubsub` 跨实例桥接，每个实例都会从各自本地 `EventBus` 派生出同样的数据变更 topic，若再经 SSE-Redis 扇出会重复投递。

### 5.2 SSE Redis 桥接（仅当配置了 Redis）

仿 `redis_pubsub.rs`，channel `onebase:sse`：

- 发布端：订阅 `hub` broadcast，仅对 `replicate == true` 的 envelope `PUBLISH` JSON（即内部 `publish` + HTTP publish 的通用消息）。
- 订阅端：收到后 `hub.publish_local(env)`（`replicate = false`），故不会被发布端再次 `PUBLISH`，**无回环**。

回环 / 重复规避小结：数据变更走 `EventBus` 既有 Redis 桥（SSE 侧 `local`，不扇出）；通用消息走 SSE Redis 桥（`replicate=true` 发出、回注时 `local` 不再发）。两条路径互不重叠。

## 6. 接线（`src/main.rs` / `src/lib.rs`）

- `src/lib.rs`：新增 `pub mod sse;`。
- `src/main.rs`：在事件系统初始化处（紧邻 `RealtimeManager` 接线）：
  - 创建 `SseHub`，`app.layer(Extension(hub.clone()))`；
  - 启动数据变更桥接任务（订阅 `event_bus`）；
  - 若 `redis` 可用，启动 SSE Redis 发布端 + 订阅端；
  - 路由：`/sse`（query-token 鉴权，并入 `realtime_routes` 或新建 `sse_routes`，不挂 `auth_middleware`）；`POST /api/sse/publish`（新建 `sse_publish_routes`，挂 `auth_middleware`）。

## 7. 错误处理

| 场景 | 行为 |
|---|---|
| token 缺失/无效/过期 | 401 |
| topics 为空 | 400 |
| 任一 topic 授权失败 | 403 |
| HTTP publish 授权失败 | 403 |
| broadcast Lagged | 记 `warn` 日志，跳过该批 |
| 连接断开 | 流结束，清理订阅 |
| 空闲连接 | 15s 心跳保活 |

## 8. 测试

- 单测 `authorize_topic`：本人 `user:` 命中/不命中、超管放行、未知前缀拒绝、（库/项目用 mock pool 或拆出纯函数判定前缀解析）。
- 单测 topic 过滤匹配：精确匹配、末尾 `*` 通配、不匹配。
- 单测 `SseEnvelope` 序列化/反序列化（`replicate` 被 skip、`id` 可选）。
- 手动：`curl -N "http://localhost:PORT/sse?token=...&topics=user:1:notify"`，另开 `POST /api/sse/publish` 验证收到。

## 9. 文件清单

- 新增 `src/sse.rs`（SseHub、SseEnvelope、authorize_topic、sse_handler、publish_handler、数据变更桥接 starter、SSE Redis 桥接）。
- 修改 `src/lib.rs`（`pub mod sse;`）。
- 修改 `src/main.rs`（建 hub、layer、起桥接、注册路由）。
- 在 `src/sse.rs` 内新增 `user_can_access_database` 辅助（复用 `permissions.rs` 的 `tenant_databases` / `user_tenants` 查询模式）。

## 10. 扩展：SSE 转发/路由规则（可配置 + 管理页）

在数据变更桥接之上，提供**管理员可配置的转发规则**：当某些数据变更命中条件时，自动把事件
推到自定义 topic（与 webhook 的过滤条件同范式）。内置的 `db:{id}:table:{schema}.{table}`
桥接**保留**，路由规则是额外的自定义 topic。

### 10.1 表 `management.sse_routes`（migration `018_sse_routes.sql`）

| 字段 | 说明 |
|---|---|
| `id` / `tenant_id` | 主键 + 租户隔离（REFERENCES tenants ON DELETE CASCADE） |
| `name` | 规则名 |
| `database_id` | 可空：null = 该租户所有库；否则限定具体库（REFERENCES tenant_databases） |
| `event_pattern` | `schema.table.action`，支持 `*`（复用 `webhook_manager::pattern_matches`） |
| `topic_template` | 目标 topic，占位符 `{database_id}` `{schema}` `{table}` `{action}` |
| `event_name` | 可空：SSE `event` 字段，默认用 action |
| `is_active` / `created_at` / `updated_at` | 同 webhooks（含 updated_at 触发器） |

### 10.2 路由执行 `src/sse_route_manager.rs`

- `SseRouteManager::start(pool, hub, event_bus)`：
  - 后台任务①：每 10s 刷新一次活跃规则到内存快照 `Arc<RwLock<Vec<SseRoute>>>`（避免每条
    数据变更打 DB）。
  - 后台任务②：订阅 `EventBus`，对每个 `DataChangeEvent` 用快照匹配
    `tenant_id` 相等 + `database_id`（若设）相等 + `pattern_matches(event_pattern, "schema.table.action")`，
    命中则解析 `topic_template` → `hub.publish_local(...)`（不经 SSE-Redis 扇出，与内置桥接一致）。

### 10.3 CRUD API `src/sse_route_handlers.rs`

镜像 `webhook_handlers`，挂 `auth_middleware`，租户管理员鉴权（`permissions::require_tenant_admin`）：

- `GET /api/admin/sse-routes` — 超管全量；租户 admin 仅本租户。
- `POST /api/admin/sse-routes`
- `PATCH /api/admin/sse-routes/:id`
- `DELETE /api/admin/sse-routes/:id`

### 10.4 前端

> 本分支 `feature/expand-ability` 没有 `app/workspace` 目录，管理页统一在 `dashboard/` 下
> （与 `dashboard/webhooks`、`dashboard/scheduled-tasks` 同位置）。

- `lib/api.ts` 新增 `sseRouteAPI`（list/create/update/delete）。
- 新建页面 `app/dashboard/sse-routes/page.tsx`（镜像 webhooks 页，`PermissionGate requires="canManageWebhooks"`）。
- `components/SidebarV3.tsx` 在 webhooks 之后加「实时推送规则」入口（`requires: 'canManageWebhooks'`）。
