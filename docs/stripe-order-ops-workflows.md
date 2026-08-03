# Stripe 订单处理工作流（admin 异常订单处理）

> 配合 shirehub-central `/finance` 订单处理功能。本文是**部署清单 + 节点设计**，
> 需用 PATCH 工作流 API 灌入 onebase DB（仓库无源文件，工作流存库）。
> ⚠️ 这些定义未经引擎实跑校验，部署后须用 Stripe 沙盒逐个联调（尤其 WF-B 退款）。

## 通用约定

- **端点**：一律走鉴权端点 `POST /workflow/{db}/{slug}`（**非 /pub/**）。
  退款/发货是高危写操作，绝不能放在匿名 /pub 端点。
- **角色校验（必做）**：每个工作流第一个节点 `role_guard` 校验调用者是 admin / finance_ops。
  - 调用方身份从 **payload `actor_way_uid`**（字符串 way_uid）读取——central 的
    `OneBaseOrderActionRepository` 已在每个请求体显式注入（取自 auth store，口径同
    `operator_way_uid`）。注意 central http client 的默认参数只带数字 `uid`，**不可**用它当身份。
  - `role_guard` 用 `actor_way_uid` 查 central 后台管理员角色表（**部署时确认表名/字段**），
    空值或非授权角色 → `resp_forbidden(403)`。
  - 网关鉴权只是第一层，工作流内角色校验是第二层，不可省。
- **审计**：每个写动作落 `gamesq.plugin_order.metadata`（jsonb）追加 `{action, actor_way_uid, reason, at}`，便于追溯。
- **复用**：履约逻辑复用 WF20 `fulfill_payment` 事务（靠 `provider_event_id` / `plugin_payment_event` 去重，不会重复发货）。

---

## WF-A `stripe-reconcile-order`（对账补单 / 重试 / 批量清理）

**入参**：
- 单笔：`{ actor_way_uid, order_id }`
- 批量：`{ actor_way_uid, mode: 'batch', older_than_minutes }`

**节点图**：
```
role_guard → mode_branch
  ├─ single → query_order → order_exists
  │     └─ GET /v1/checkout/sessions/:provider_session_id (http_call)
  │         → session_branch
  │             ├─ paid     → fulfill_payment(复用WF20事务) → resp{resolved:'fulfilled'}
  │             ├─ expired  → mark_failed → resp{resolved:'failed'}
  │             └─ open     → resp{resolved:'still_pending'}
  └─ batch  → query_stale (db_query) → foreach 单笔逻辑 → resp{affected:N}
```

**关键 SQL / 逻辑**：
- `query_stale`：`SELECT order_id, provider_session_id FROM gamesq.plugin_order WHERE status='pending' AND created_at < now() - ($older_than_minutes || ' minutes')::interval`
- `mark_failed`：`UPDATE gamesq.plugin_order SET status='failed', error_code='session_expired', updated_at=now() WHERE order_id=$1::uuid`
- `fulfill_payment`：同 WF20（order→paid、subscription→active、写 plugin_payment_event 去重）。**额外补 `started_at`**（见 stripe-workflows-state.md WF20 待修项）。

**返回**：`{"code":0,"data":{"resolved":"fulfilled|failed|still_pending"}}`（单笔）/ `{"code":0,"data":{"affected":N}}`（批量）

---

## WF-B `stripe-refund-order`（退款）⚠️ 高危

**入参**：`{ actor_way_uid, order_id, reason }`

**守卫**：`role_guard`（需 finance_ops/admin）+ `status_guard`（订单 status 必须 ∈ {paid, granted}，否则 resp_invalid 400）

**节点图**：
```
role_guard → query_order → status_guard
  → GET /v1/checkout/sessions/:session_id（取 payment_intent）
  → refund_call: POST /v1/refunds  body: payment_intent=<pi> （Lua, Bearer STRIPE_SECRET_KEY）
  → write_refund(db_transaction):
       1. UPDATE plugin_order SET status='refunded',
            metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object('refund_id',$rid,'refund_reason',$reason,'refunded_by',$actor,'refunded_at',now()),
            updated_at=now() WHERE order_id=$1::uuid
       2. UPDATE plugin_subscription SET status='cancelled', is_enabled=false, updated_at=now()
            WHERE project_id=$pid AND plugin_key=$pk
  → resp{refund_id, amount}
```

**refund_call Lua 要点**：`GET session` → `session.payment_intent` → `POST /v1/refunds` body `payment_intent=<pi>`（全额退，不传 amount）。注意 `plugin_order` 无 payment_intent 列，必须经 session 回查。

**返回**：`{"code":0,"data":{"refund_id":"re_xxx","amount":<cents>}}`

---

## WF-C `stripe-grant-order`（手动激活 / 凭空发货）⚠️⚠️ 最高危

**入参**：`{ actor_way_uid, order_id, reason }`

**守卫**：`role_guard` **仅 admin**（central 侧 `finance.order_grant` 也仅 admin）；`status_guard`：status ∈ {pending, failed}

**节点图**：
```
role_guard(admin only) → query_order → status_guard
  → grant(db_transaction):
       1. UPDATE plugin_order SET status='granted', source='manual_grant', paid_at=coalesce(paid_at,now()),
            metadata = ... || jsonb_build_object('grant_reason',$reason,'granted_by',$actor,'granted_at',now()),
            updated_at=now() WHERE order_id=$1::uuid
       2. UPSERT plugin_subscription：status='active', is_enabled=true,
            billing_cycle=$plan_key, started_at=now(),
            expires_at = monthly→+1month / yearly→+1year / lifetime→NULL
            （ON CONFLICT(project_id,plugin_key) DO UPDATE）
  → resp{status:'granted'}
```

**注**：不经 Stripe 付款，直接发货，必须强审计（metadata 记 actor + reason）。

---

## 部署后联调清单（Stripe 沙盒）

1. WF-A 单笔：造一笔 pending（未付）→ 调对账 → 应返回 `still_pending`；用沙盒付款后再调 → `fulfilled` 且订阅 active。
2. WF-A 批量：造几笔超 24h 的 pending → 批量清理 → 应全部 `failed`，已支付单不受影响。
3. WF-B 退款：对已 paid 单退款 → Stripe Dashboard 见 refund，订阅被收回（cancelled）。
4. WF-C 手动激活：对 pending/failed 单激活 → 订阅 active、order=granted、metadata 有审计字段。
5. 角色校验：用非 finance_ops/admin 身份调各端点 → 应 403。

部署后请更新 `docs/stripe-workflows-state.md` 工作流清单补上 WF-A/B/C。
