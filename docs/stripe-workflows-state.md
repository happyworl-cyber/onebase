# Stripe 工作流当前状态

## 运行环境

- 服务器：`http://127.0.0.1:3000`
- 数据库 slug：`acme-test`（`database_id=2`, `tenant_id=4`）
- gamesq schema 存放所有插件业务表
- 工作流通过 OneBase 引擎执行，节点类型：`code`(Lua 5.4)、`db_query`、`db_execute`、`db_transaction`、`condition`、`response`、`http_call`、`foreach`

## 环境变量（服务器启动时需设置）

```
PLUGIN_STRIPE_SECRET_KEY=sk_test_xxx        # Stripe API 密钥
PLUGIN_STRIPE_WEBHOOK_SECRET=whsec_xxx      # Stripe webhook 签名密钥（本地用 stripe listen --print-secret 获取）
PLUGIN_BASE_URL=https://yourapp.com         # 用于拼 success_url/cancel_url
```

本地开发调试 webhook：
```bash
stripe listen --forward-to http://localhost:3000/pub/workflow/acme-test/stripe-webhook
# 记下输出的 whsec_xxx 设置到 PLUGIN_STRIPE_WEBHOOK_SECRET
stripe events resend <evt_id>   # 重放事件
```

## 路由规则

| 前缀 | 鉴权 | 用途 |
|------|------|------|
| `POST /workflow/:db/:slug` | Bearer Token（JWT 或 API Key） | 普通业务端点 |
| `GET /workflow/:db/:slug` | Bearer Token | 同上（GET 版） |
| `POST /pub/workflow/:db/:slug` | 无（Anonymous） | Stripe webhook 专用，无鉴权，安全由工作流内验签保证 |

## 模板变量规则

工作流节点内模板语法：`{{source.path}}`

- `{{trigger.field}}` — 请求 body 中的字段（endpoint 触发）
- `{{trigger._raw_body}}` — 原始请求 body 字符串（webhook 验签、event 存库用）
- `{{node_id.field}}` — 引用其他节点的输出
- `{{node_id.rows[0].col}}` — db_query 结果行（rows 数组，1-indexed 在 Lua 中，0-indexed 在模板中）
- `{{node_id.count}}` — db_query 结果行数

Lua 节点内访问：
- `ctx.body.field` — 请求 body 字段
- `ctx.body._raw_body` — 原始 body 字符串
- `ctx.body.headers["header-name"]` — 请求 header（全小写）
- `ctx.nodes["node_id"].field` — 其他节点输出
- `env.get("PLUGIN_XXX")` — 环境变量（仅允许 PLUGIN_ 前缀）
- `http.post(url, body_string, {headers={...}})` — 3 个参数，body 是第 2 个字符串参数，opts 是第 3 个 table
- `http.get(url, {headers={...}})`
- `resp.status` — HTTP 状态码（integer）
- `resp.body` — 响应体字符串
- `resp.json` — 自动解析的 JSON table（可能为 nil）
- `crypto.hmac_sha256(key_string, data)` — 返回 hex 字符串，key 为 UTF-8 字节
- `crypto.hmac_sha256_raw_key(base64_key, data)` — 内部 Base64 解码 key 后做 HMAC（Stripe Dashboard whsec_ 格式用这个）
- `crypto.uuid()` — UUID v4 字符串
- `json.encode(table)` / `json.decode(string)`

**注意**：Stripe CLI 的 `whsec_` secret 直接用 `crypto.hmac_sha256(webhook_secret, signed_payload)` 即可（不需要 Base64 解码）。Stripe Dashboard 的 `whsec_` secret 才需要 `crypto.hmac_sha256_raw_key`。

## 数据库表（gamesq schema）

### plugin_list
```
id, plugin_key, name, is_active,
price_usd_monthly::float8, price_usd_yearly::float8, price_usd_lifetime::float8,
next_price_usd_monthly, next_price_usd_yearly, next_price_usd_lifetime,
price_update_at
```

### plugin_order
```
order_id (uuid PK), project_id (int), plugin_key, plan_key,
actor_way_uid, source, status ('pending'|'paid'|'granted'|'failed'),
amount (int, cents), currency ('USD'), provider ('stripe'),
provider_session_id, idempotency_key,
paid_at (timestamptz, nullable), created_at, updated_at
```

### plugin_subscription
```
id PK, project_id (int), plugin_id (int), plugin_key,
provider_customer_id (Stripe cus_xxx),
billing_cycle ('monthly'|'yearly'|'lifetime'),
status ('pending'|'active'|'expired'|'cancelled'),
is_enabled (bool),
cancel_at (nullable), expires_at (nullable),
created_at, updated_at
UNIQUE (project_id, plugin_key) WHERE plugin_key IS NOT NULL
```

### plugin_payment_event
```
id PK, order_id (uuid), event_type, provider ('stripe'),
event_id (Stripe evt_xxx, NOT NULL),
raw_payload (jsonb),
created_at
```
注：无 `provider_event_id` 列（曾经踩坑）。

## 工作流清单

### WF8 — stripe-expiry-job（定时任务）
到期订阅失效 Job，无入参，cron 触发。
- `expire_subscriptions`：`UPDATE plugin_subscription SET status='expired', is_enabled=false WHERE expires_at < NOW() AND status='active'`

---

### WF11 — stripe-cancel（POST /workflow/acme-test/stripe-cancel）
取消订阅，设置 cancel_at = expires_at。

**入参（body）**：`project_id`, `way_uid`, `plugin_key`

鉴权：`ownership_check`（project_list owner 或 moderator_project）→ `auth` condition（pass/forbidden）

- `write_cancel`：`UPDATE plugin_subscription SET cancel_at = expires_at WHERE project_id=$1 AND plugin_key=$2`

---

### WF12 — stripe-get-order（POST /workflow/acme-test/stripe-get-order）
查单个订单状态，前端支付结果页轮询用。

**入参**：`provider_session_id`, `way_uid`

流程：查订单 → 存在检查 → 鉴权检查 → 返回

**返回（200）**：
```json
{"code":0,"data":{"project_id","plugin_key","plan_key","status","amount","currency","paid_at"},"message":"ok"}
```

---

### WF13 — stripe-list-subscriptions（POST /workflow/acme-test/stripe-list-subscriptions）
列出某项目的所有订阅。

**入参**：`project_id`, `way_uid`

**返回（200）**：`{"code":0,"data":[{plugin_key, billing_cycle, status, expires_at, grace_period_end, is_enabled}]}`

---

### WF14 — stripe-list-orders（POST /workflow/acme-test/stripe-list-orders）
分页查订单历史。

**入参**：`project_id`, `way_uid`, `page`（可选，默认1）, `page_size`（可选，默认10）

---

### WF15 — stripe-checkout（POST /workflow/acme-test/stripe-checkout）
新购插件，创建 Stripe Checkout Session。

**入参**：
```json
{
  "project_id": 211903,
  "way_uid": "osueydqtgjr4dxxqwaxe9b4bse",
  "plugin_key": "ai-customer-bot",
  "plan_key": "monthly|yearly|lifetime",
  "idempotency_key": "project_id:plugin_key:plan_key:uuid",
  "success_url": "可选",
  "cancel_url": "可选"
}
```

**流程**：
```
ownership_check → auth
  → query_price（plugin_list）→ plugin_exists
  → query_idempotency（幂等检查）→ idempotency_check
      ├─ already_paid → resp_already_paid(400)
      ├─ pending → read_key_pending → fetch_old_session(GET /v1/checkout/sessions/:id) → resp_old_url(200)
      └─ new → query_customer → read_key_new → stripe_call(Lua)
                  → write_order → write_subscription → resp_checkout(200)
```

**stripe_call Lua** 做：
1. 若无 customer_id → `POST /v1/customers` 创建
2. 按 plan_key 取价格（price_usd_monthly/yearly/lifetime → cents）
3. `POST /v1/checkout/sessions`（mode=payment，inline price_data）
4. 返回 `{customer_id, session_id, checkout_url, order_id, amount_cents, plugin_id, plan_key}`

**注意**：`fetch_old_session.body.url` 在 `http_call` 节点中 body 是已解析 JSON（非字符串），可直接 `.url`。

**返回（200）**：`{"code":0,"data":{"checkout_url":"https://checkout.stripe.com/...","provider_session_id":"cs_test_xxx"}}`

---

### WF17 — stripe-renew（POST /workflow/acme-test/stripe-renew）
已有订阅续费，流程与 WF15 基本相同。

**差异**：
- 多一个 `query_existing_sub` 节点拿当前 `billing_cycle`
- `stripe_call` 的 `plan_key` 来自 `ctx.nodes["query_existing_sub"].rows[1].billing_cycle`（非入参）
- 商品名带 `(Renew)` 后缀

**入参**：同 WF15（`plan_key` 字段会被忽略，实际用已有订阅的 billing_cycle）

---

### WF19 — stripe-price-update-job（定时任务）
将 `next_price_usd_*` 应用为正式价格，foreach 批量处理。

---

### WF20 — stripe-webhook（POST /pub/workflow/acme-test/stripe-webhook）
Stripe webhook 接收处理，**无鉴权**，通过 HMAC 验签保证安全。

**流程**：
```
verify_signature(Lua) → event_filter
  ├─ ignore → resp_ignore(200)
  └─ checkout_complete → query_order → order_check
        ├─ skip（已paid/granted 或找不到订单）→ resp_ignore(200)
        └─ process → fulfill_payment(db_transaction) → resp_ok(200)
```

**verify_signature Lua** 逻辑：
1. 取 `ctx.body.headers["stripe-signature"]`，解析 `t=...` 和 `v1=...`
2. `signed_payload = ts .. "." .. ctx.body._raw_body`
3. `expected = crypto.hmac_sha256(PLUGIN_STRIPE_WEBHOOK_SECRET, signed_payload)`
4. 比较 hex 字符串
5. 返回 `{event_id, event_type, session(event.data.object), ts}`

**fulfill_payment 事务（3条 SQL）**：
1. `UPDATE plugin_order SET status='paid', paid_at=NOW() WHERE order_id=$1::uuid`
   - params: `[query_order.rows[0].order_id]`
2. `INSERT INTO plugin_payment_event (order_id, event_type, provider, event_id, raw_payload) VALUES ($1::uuid, 'checkout.session.completed', 'stripe', $2, $3::jsonb)`
   - params: `[query_order.rows[0].order_id, verify_signature.event_id, trigger._raw_body]`
3. `UPDATE plugin_subscription SET status='active', is_enabled=true, billing_cycle=$1, expires_at=... WHERE project_id=$2::int AND plugin_key=$3`
   - params: `[query_order.rows[0].plan_key, query_order.rows[0].project_id, query_order.rows[0].plugin_key]`
   - expires_at: monthly=+1month, yearly=+1year, lifetime=NULL

## 工作流 PATCH API

修改工作流节点/边：
```
PATCH /api/admin/workflows/:id
Content-Type: application/json
Authorization: Bearer <token>
Body: {"nodes": [...], "edges": [...]}
```

获取工作流：
```
GET /api/admin/workflows/:id
```

查看运行历史：
```
GET /api/admin/workflows/:id/runs?limit=N
```
返回 `runs[].node_results[].{node_id, status, error, output}`

## 已知坑

1. **`http_call` vs Lua `http.post` body 字段不同**：`http_call` 节点的 `fetch_old_session.body` 是已解析 JSON（直接 `.url`）；Lua 的 `http.post` 返回的 `resp.body` 是字符串，解析后的 JSON 在 `resp.json`。

2. **`http.post` 调用约定**：`http.post(url, body_string, {headers={...}})` — body 是第 2 参数字符串，opts 是第 3 参数 table。不能把 headers 放进第 2 参数。

3. **Stripe HMAC key**：Stripe CLI 的 `whsec_` 直接用整个字符串做 HMAC key（crypto.hmac_sha256）。不能 base64 解码。

4. **plugin_payment_event 表没有 `provider_event_id` 列**，有 `event_id`（Stripe evt_xxx）和 `provider`（NOT NULL）。

5. **db_query rows 下标**：模板中 `rows[0]` 是第一行，Lua 中 `rows[1]` 是第一行（Lua 1-indexed）。
