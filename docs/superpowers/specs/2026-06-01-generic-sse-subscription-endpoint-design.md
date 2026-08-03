# 通用对外事件订阅端点（Generic SSE Subscription Endpoint）

- 日期：2026-06-01
- 状态：设计待评审
- 关联：`2026-06-01-sse-capability-design.md`（通用 SSE 基础）、`2026-06-01-growth-animation-sse-design.md`（成长动画——本方案的应用场景之一，将被本方案取代其专用 handler）

## 1. 背景与问题

现状里成长动画用了一个**硬编码的专用端点** `GET /growth-animation/events`：身份头（`X-Way-UID`）、topic（`way:{wayUid}:growth:*`）、字段投影（`{eventId,projectId,eventType}`）、event 名（`growth_animation_available`）全部写死在 `src/sse.rs` 里。这属于"为单个业务定制开发"，每来一个新业务就要再写一套 handler + 路由。

目标：把它抽象成**与具体业务无关的通用能力**——「对外事件订阅端点」。新增一个对外订阅场景 = 在配置表里加一行，**零代码**；同一个通用 handler 服务所有场景。成长动画退化为其中一行配置。

## 2. 核心理念：生产 / 消费解耦

平台已有一条 SSE 总线（`SseHub`，topic 寻址）。**生产侧**（谁把消息推进某个 topic）和**消费侧**（谁能订阅、订到什么）通过 topic 字符串对接，彼此不感知。

- 生产侧（已存在、通用）：PG NOTIFY 监听桥、数据变更转发规则（`sse_routes`）、工作流 `sse.publish` 节点 / Lua builtin、`POST /api/sse/publish`。
- 消费侧（本方案新增、通用）：可在 Web 页面配置的对外订阅端点。

本方案只做**消费侧的通用可配端点**，不动生产侧。

## 3. 适用场景示例（成长动画只是第 1 行）

| 场景 | slug | identity_header | topic_template | event_name | 生产侧（任选其一） |
|---|---|---|---|---|---|
| 成长动画 | `growth-animation` | `X-Way-UID` | `way:{identity}:growth:{query.projectId}` | `growth_animation_available` | NOTIFY 监听桥 |
| 订单状态推买家 | `order-status` | `X-User-Id` | `order:{identity}:{query.orderId}` | `order_status_changed` | 数据变更规则 |
| 设备告警推 owner | `device-alert` | `X-Owner-Id` | `device:{identity}:alert` | `device_alert` | `POST /api/sse/publish` |
| 客服会话消息 | `chat` | `X-User-Id` | `chat:{identity}:{query.roomId}` | `chat_message` | 工作流 `sse.publish` |

四个场景共用同一个 handler，无任何业务代码。

## 4. 已确认的设计决策

1. **身份来源**：网关注入的可信请求头（端点可配头名，如 `X-Way-UID`）。不支持 JWT / 匿名（YAGNI；如需可后续扩展）。
2. **topic 模板**：必含 `{identity}`（保证只能订到"自己"的消息）；可含白名单内的 `{query.X}`（取 URL query 参数）。
3. **字段投影**：**透传** upstream payload，不做投影。隐藏敏感字段是上游（触发器 / 工作流）的责任。
4. **URL**：统一为 `GET /events/{slug}`。删除硬编码的 `/growth-animation/events`，不保留别名（成长动画业务前端尚未接入，无兼容负担）。

## 5. 架构

三个独立单元：

- **配置表 `management.sse_public_endpoints`**：定义端点形态。
- **通用 handler `GET /events/:slug`**（`src/sse.rs`）：按 slug 读配置驱动，无业务硬编码。
- **管理 UI**：「实时推送规则」页新增「对外端点」tab，CRUD（与监听桥/规则同套交互）。

### 5.1 数据模型

```sql
CREATE TABLE management.sse_public_endpoints (
    id              SERIAL PRIMARY KEY,
    tenant_id       INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    slug            VARCHAR(64)  NOT NULL UNIQUE,   -- URL: /events/{slug}，全局唯一
    name            VARCHAR(100) NOT NULL,          -- 显示名
    identity_header VARCHAR(64)  NOT NULL,          -- 可信身份头，如 X-Way-UID
    topic_template  TEXT         NOT NULL,          -- 必含 {identity}，可含 {query.X}
    event_name      VARCHAR(100) NOT NULL,          -- 下发的 SSE event 名
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
```

- `tenant_id`：管理归属。鉴权与 `sse_routes` 一致——超管管全部、租户 owner/admin 管自己租户的端点。
- `slug`：全局唯一（URL 路径），仅允许 `[a-z0-9-]`。
- 不缓存：连接是低频动作，handler 每次连接查一次配置即可。

### 5.2 通用 handler `GET /events/:slug?<query>`

1. 按 `slug` 查 `is_active = true` 的端点，查不到 → 404。
2. 读 `identity_header` 指定的请求头，缺失/空 → 401（`缺少 <header>`）。
3. **渲染 topic**（`render_subscription_topic`）：从左到右扫描 `topic_template`：
   - `{identity}` → 替换为身份头的值；
   - `{query.X}` → 替换为 query 参数 `X` 的值；
   - **遇到第一个缺省的 `{query.X}`**：在该位置截断，追加 `*` 并停止渲染（利用 `topic_matches` 的末尾通配）。
   - 例：模板 `way:{identity}:growth:{query.projectId}`
     - 带 `projectId=1` → `way:<id>:growth:1`（精确）；
     - 不带 `projectId` → `way:<id>:growth:*`（通配该身份全部）。
   - `{identity}` 缺省不可能发生（步骤 2 已拦）。截断规则要求 `{identity}` 必须排在所有 `{query.X}` 之前（§5.3 校验），否则缺省 query 截断会把 `{identity}` 一起截掉、退化成 `prefix:*` 而越权。
4. 注册连接：`ConnMeta { kind, endpoint_slug, identity, connected_at }`，订阅渲染出的 topic。
5. 先推 `event: connected`；之后凡 `topic_matches` 命中的消息，以 `event_name` 为事件名、**payload 原样透传**下发；每条 `record_push()`。
6. 心跳：复用 25s `KeepAlive`。

### 5.3 配置校验（创建 / 更新时）

- `slug` 非空、`^[a-z0-9-]{1,64}$`、唯一。
- `identity_header`、`event_name`、`topic_template` 非空。
- `topic_template` **必须包含 `{identity}`**，否则拒绝（保证隔离）。
- `topic_template` 里的占位符只允许 `{identity}` 和 `{query.<param>}`；其它 `{...}` 拒绝。
- **`{identity}` 必须出现在所有 `{query.X}` 之前**（位置校验）。否则当某个靠前的 `{query.X}` 缺省时，截断会把 `{identity}` 一并丢掉，topic 退化成 `prefix:*` 命中他人消息——属越权，创建/更新时拒绝。

## 6. 安全 / 隔离

- 身份来自网关注入的可信头，客户端无法伪造；topic 强制含 `{identity}` → 结构性保证"只能订到自己的"。
- 透传 payload：上游负责不发敏感字段（已确认）。
- topic 命名空间全局共享，跨端点/租户撞前缀属配置者自负（与现有 topic 体系一致）。
- 该端点**不经 JWT `authorize_topic`**：授权是结构性的（身份嵌入 topic），不是基于平台账号的。

## 7. 监控通用化

`ConnMeta` 由成长动画专用形态（`kind: "sse"|"growth"`, `way_uid`, `project_id`）改为通用：

```rust
struct ConnMeta {
    kind: &'static str,            // "sse"（通用 /sse）| "public"（/events/:slug）
    endpoint_slug: Option<String>, // public 连接所属端点
    identity: Option<String>,      // public 连接的身份
    connected_at: DateTime<Utc>,
}
```

「推送监控」tab 的连接聚合由"growth/generic"改为**按 `endpoint_slug` 聚合**（通用）。监听桥 listener 指标不变。

## 8. 迁移与删代码

- **删**：`src/sse.rs` 的 `growth_events_handler`、`GrowthQuery`、`project_growth_data` 及相关单测；`src/main.rs` 的 `/growth-animation/events` 路由。
- **改**：`ConnMeta` 通用化（§7），相应调整 `sse_handler` 与 `sse_notify_bridge_handlers::stats` 的聚合。
- **新增**：迁移 `025_sse_public_endpoints.sql`；`src/sse_public_endpoint_handlers.rs`（CRUD + 通用 handler，或 handler 放 `sse.rs`、CRUD 单独文件）；前端 `lib/api.ts` + 「对外端点」tab 组件。
- **成长动画**：作为一条**示例 seed**（迁移内注释示例或运维/页面新建），不写死。对外地址变为 `GET /events/growth-animation?projectId=...`。
- 同步更新 `growth-animation-frontend-reference.md` 的端点 URL。

## 9. 测试

- 单元 `render_subscription_topic`：
  - `{identity}` + 带 `{query.X}` → 精确；
  - 缺 `{query.X}` → 截断补 `*`；
  - 多个 query 参数；
  - 模板无 `{identity}` → 校验函数拒绝；
  - `{query.X}` 排在 `{identity}` 之前 → 校验函数拒绝（越权防护）。
- handler 集成：缺 header → 401；不存在/停用 slug → 404；带/不带 query 两路 topic 命中。

## 10. 不做（YAGNI）

- JWT / 匿名身份来源（仅可信头）。
- 字段投影 / 改写（透传）。
- 每端点自定义心跳间隔（统一 25s）。
- 旧 `/growth-animation/events` 兼容别名。
- 配置热缓存（连接低频，直查 DB）。
