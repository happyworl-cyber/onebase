# Stripe 支付工作流配置操作手册

> 面向操作者：无需读 Rust 代码，打开 OneBase UI 按本文档逐节点配置即可。  
> 包含 Lua 基础教学——每段代码都有逐行注释。  
> 最后更新：2026-06-09

---

## 一、工作流基础知识（必读）

### 1.1 变量语法

工作流节点之间传递数据靠 `{{变量路径}}` 语法，引擎会在执行时自动替换：

| 写法 | 含义 |
|------|------|
| `{{trigger.project_id}}` | 调用方 POST body 里的 `project_id` 字段 |
| `{{trigger.plugin_key}}` | 调用方 POST body 里的 `plugin_key` 字段 |
| `{{节点名.rows[0].status}}` | 上游"数据库查询"节点第一行的 `status` 列 |
| `{{节点名.rows_affected}}` | 上游"数据库写入"节点影响的行数 |
| `{{节点名.count}}` | 上游"数据库查询"节点返回的总行数 |
| `{{节点名.body.id}}` | 上游"HTTP 调用"节点响应 body 的 `id` 字段 |

> **关于 timestamptz 列**：PostgreSQL 的时间类型（如 `expires_at`、`paid_at`）在工作流节点里
> 需要加 `::text` 强制转为字符串，否则返回 NULL。本文档所有 SQL 已经处理好了，
> 照抄即可，**你不需要额外操作**。

### 1.2 工作流触发 URL

HTTP 端点类型的工作流，外部调用地址为：
```
POST /workflow/acme-test-primary/{slug}
Content-Type: application/json
```
`acme-test-primary` 对应 UI 数据库下拉框里选的那个数据库名。  
Cron 定时工作流不需要外部调用，引擎自动按时间触发。

### 1.3 条件分支连线

条件分支节点执行后输出一个分支名（如 `"pass"`），引擎沿对应标签的边继续执行。  
连线时每条 **分支边** 都要填 `branch` 标签，和条件配置里的 `branch` 字段一致。

---

## 二、Lua 基础教学

> 工作流的"Lua 代码"节点用 Lua 5.4 语法，用于处理无法用 SQL 表达的逻辑（比如调 HTTP、拼字符串、做计算）。  
> 如果你完全没接触过 Lua，这一节帮你快速上手。

### 2.1 Lua 和 JavaScript 对比速查

| 概念 | JavaScript | Lua |
|------|-----------|-----|
| 变量声明 | `let x = 1` | `local x = 1` |
| 空值 | `null` / `undefined` | `nil` |
| 字符串拼接 | `"a" + "b"` | `"a" .. "b"` |
| 打印调试 | `console.log(x)` | `log.info(x)` |
| 函数 | `function f(a) { return a }` | `local function f(a) return a end` |
| 数组（从 1 开始）| `arr[0]` | `arr[1]` |
| 对象/字典 | `{ key: value }` | `{ key = value }` |
| if 语句 | `if (x > 0) { }` | `if x > 0 then end` |
| 取反 | `!x` | `not x` |
| 逻辑与/或 | `&&` / `||` | `and` / `or` |
| 无返回值 | `return undefined` | `return nil` 或直接 `return` |

### 2.2 工作流 Lua 节点内置对象

在 Lua 代码节点里，引擎注入了以下全局对象，可以直接使用：

```lua
-- ctx：当前执行上下文
ctx.body           -- 触发此工作流的 HTTP 请求 body（等同于 trigger_data）
ctx.user_id        -- 当前登录用户 ID（整数）
ctx.nodes          -- 所有上游节点的输出，以节点标签名为 key

-- env：读取服务器环境变量
env.get("KEY")     -- 返回 string，不存在返回 nil

-- json：JSON 序列化/反序列化
json.encode(obj)   -- table/值 → JSON 字符串
json.decode(str)   -- JSON 字符串 → table/值

-- crypto：加密工具
crypto.uuid()           -- 生成随机 UUID 字符串
crypto.sha256(str)      -- SHA-256 哈希，返回 hex 字符串
-- crypto.hmac_sha256(key, data) -- 暂未实现，等待开发

-- log：日志
log.info("msg")
log.warn("msg")
log.error("msg")

-- http：发 HTTP 请求（用于调用 Stripe API 等外部服务）
http.post(url, options)  -- POST 请求，返回 { status, body }
http.get(url, options)   -- GET 请求
```

### 2.3 Lua 节点的返回值规则

Lua 代码节点通过 `return` 把数据传给下游节点：

```lua
-- 返回一个 table（键值对），下游可以用 {{节点名.字段名}} 引用
return {
    customer_id  = "cus_xxx",   -- 下游用 {{该节点.customer_id}}
    checkout_url = "https://...", -- 下游用 {{该节点.checkout_url}}
}

-- 如果不需要输出数据，可以什么都不 return
```

### 2.4 错误处理

```lua
-- 调用 error() 会让节点失败，工作流停止执行
local key = env.get("STRIPE_SECRET_KEY")
if not key then
    error("STRIPE_SECRET_KEY 未配置，请在服务器环境变量中添加")
end

-- nil 检查：Lua 里 nil 等同于"不存在"
local name = row.name or "默认名称"  -- row.name 为 nil 时用默认值
```

### 2.5 字符串操作

```lua
-- 拼接字符串用 ..（两个点）
local msg = "插件 " .. plugin_key .. " 价格：" .. price

-- 数字转字符串
local id_str = tostring(123)     -- "123"

-- 字符串转数字
local num = tonumber("123")      -- 123

-- 数学计算
local cents = math.floor(9.99 * 100 + 0.5)  -- 四舍五入取整 → 999
```

### 2.6 表（table）操作

Lua 的 table 同时充当数组和字典：

```lua
-- 作为字典（键值对）
local data = { project_id = 123, plugin_key = "ai-bot" }
print(data.project_id)   -- 123
print(data["project_id"]) -- 同上

-- 作为数组（下标从 1 开始，不是 0！）
local rows = { "a", "b", "c" }
print(rows[1])  -- "a"（第一个元素）
print(rows[2])  -- "b"

-- 遍历数组
for i, row in ipairs(rows) do
    log.info("第 " .. i .. " 行：" .. row)
end

-- 遍历字典
for key, value in pairs(data) do
    log.info(key .. " = " .. tostring(value))
end
```

---

## 三、立即可配的工作流（Phase 0）

> 这些工作流所需节点全部已有，现在就可以配。

---

### 工作流 A：订阅到期失效（Job 1）

**功能：** 每小时检查一次，把已过期的订阅状态改为 `expired`，并关闭访问权限。

**新建工作流配置：**
- 名称：`订阅到期失效`
- Slug：`stripe-expiry-job`
- 触发：`Cron`，表达式 `0 * * * *`（每小时整点触发）
- 数据库：acme-test-primary

**节点：只需 1 个**

#### 节点 1 — 数据库写入：执行到期失效

| 字段 | 填写内容 |
|------|---------|
| 节点类型 | 数据库写入 |
| 标签 | `到期失效` |
| 参数 | 无 |

```sql
UPDATE gamesq.plugin_subscription
SET status     = 'expired',  -- 状态改为已过期
    is_enabled = false,       -- 关闭访问权限（插件功能停用）
    updated_at = NOW()        -- 记录更新时间
WHERE status = 'active'           -- 只处理当前激活的订阅
  AND expires_at IS NOT NULL      -- 排除 lifetime（永久）购买，expires_at 为 NULL
  AND expires_at < NOW()          -- 已经超过到期时间
```

**连线：** 无需连线，只有一个节点。

---

### 工作流 B：取消订阅（端点 5）

**功能：** 用户点"取消订阅"，设置 `cancel_at = expires_at`，当前周期内仍可用，到期自动停。

**新建工作流配置：**
- 名称：`取消订阅`
- Slug：`stripe-cancel`
- 触发：`HTTP 端点`
- 数据库：acme-test-primary

**前端调用方式：**
```json
POST /workflow/acme-test-primary/stripe-cancel
{
  "project_id": 123,
  "plugin_key": "ai-bot",
  "way_uid": "456"
}
```

**节点执行流程：**
```
[查归属] → [鉴权] ──(forbidden)──→ [响应403]
                  └─(pass)──→ [写取消] → [响应成功]
```

---

#### 节点 1 — 数据库查询：校验项目归属

| 字段 | 填写内容 |
|------|---------|
| 节点类型 | 数据库查询 |
| 标签 | `查归属` |
| 参数 | `["{{trigger.project_id}}", "{{trigger.way_uid}}"]` |

```sql
-- 判断当前用户是否有权操作这个项目
-- 两种情况都算有权：1) 是项目所有者 2) 是项目管理员成员
SELECT COUNT(*) AS cnt
FROM (
    -- 情况1：是项目创建者（owner）
    SELECT 1 FROM gamesq.project_list
    WHERE project_id = $1::int         -- $1 = project_id
      AND owner_way_uid = $2           -- $2 = 当前用户的 way_uid

    UNION ALL

    -- 情况2：是项目的管理员成员（moderator）
    SELECT 1 FROM gamesq.moderator_project
    WHERE project_id = $1::int
      AND way_uid = $2
      AND is_delete = 0               -- 未被移除的成员
) t
```

---

#### 节点 2 — 条件分支：鉴权

| 字段 | 填写内容 |
|------|---------|
| 节点类型 | 条件分支 |
| 标签 | `鉴权` |
| default_branch | `forbidden` |

```json
{
  "conditions": [
    {
      "branch": "pass",
      "expression": "{{查归属.rows[0].cnt}} > 0"
    }
  ],
  "default_branch": "forbidden"
}
```

> 解读：`{{查归属.rows[0].cnt}}` 取节点"查归属"第一行的 `cnt` 列。
> 如果 `cnt > 0` 说明有权限，走 `pass` 分支；否则走默认的 `forbidden` 分支。

---

#### 节点 3 — 数据库写入：设置 cancel_at（接 pass 分支）

| 字段 | 填写内容 |
|------|---------|
| 节点类型 | 数据库写入 |
| 标签 | `写取消` |
| 参数 | `["{{trigger.project_id}}", "{{trigger.plugin_key}}"]` |

```sql
UPDATE gamesq.plugin_subscription
SET cancel_at  = expires_at,  -- 把取消时间设为当前到期时间（到期自动停，不立即停）
    updated_at = NOW()
WHERE project_id = $1::int    -- $1 = project_id
  AND plugin_key  = $2        -- $2 = plugin_key
```

---

#### 节点 4 — 响应输出：成功（接 写取消）

| 字段 | 填写内容 |
|------|---------|
| 节点类型 | 响应输出 |
| 标签 | `响应成功` |
| status_code | `200` |
| body | `{"code": 0, "message": "ok", "data": {"cancelled": true}}` |

---

#### 节点 5 — 响应输出：无权限（接 forbidden 分支）

| 字段 | 填写内容 |
|------|---------|
| 节点类型 | 响应输出 |
| 标签 | `响应403` |
| status_code | `403` |
| body | `{"code": 403, "message": "PAYMENT_PROJECT_FORBIDDEN"}` |

**连线表：**

| from（起点） | to（终点） | branch（分支标签） |
|------------|----------|-----------------|
| 查归属 | 鉴权 | （不填） |
| 鉴权 | 写取消 | `pass` |
| 鉴权 | 响应403 | `forbidden` |
| 写取消 | 响应成功 | （不填） |

---

### 工作流 C：查询订单状态（端点 2）

**功能：** 根据 Stripe session_id 查询某笔订单的支付状态。

**Slug：** `stripe-get-order`

**前端调用方式：**
```json
POST /workflow/acme-test-primary/stripe-get-order
{
  "provider_session_id": "cs_test_xxx",
  "way_uid": "456"
}
```

**节点执行流程：**
```
[查订单] → [订单存在?] ──(not_found)──→ [响应404]
                       └─(found)──→ [查归属] → [鉴权] ──(forbidden)──→ [响应403]
                                                       └─(pass)──→ [响应订单]
```

---

#### 节点 1 — 数据库查询：查订单

标签：`查订单`，参数：`["{{trigger.provider_session_id}}"]`

```sql
SELECT project_id,
       plugin_key,
       plan_key,
       status,
       amount,
       currency,
       paid_at::text AS paid_at   -- ::text 转换：timestamptz 转字符串，否则工作流返回 NULL
FROM gamesq.plugin_order
WHERE provider_session_id = $1    -- $1 = provider_session_id
  AND provider = 'stripe'
LIMIT 1
```

#### 节点 2 — 条件分支：订单存在？

标签：`订单存在`

```json
{
  "conditions": [
    { "branch": "found", "expression": "{{查订单.count}} > 0" }
  ],
  "default_branch": "not_found"
}
```

#### 节点 3 — 数据库查询：查归属（接 found）

标签：`查归属`，SQL 同工作流 B 节点 1，参数：
```json
["{{查订单.rows[0].project_id}}", "{{trigger.way_uid}}"]
```

#### 节点 4 — 条件分支：鉴权

标签：`鉴权`，配置同工作流 B 节点 2。

#### 节点 5 — 响应输出：返回订单（接 pass）

```json
{
  "status_code": 200,
  "body": {
    "code": 0,
    "message": "ok",
    "data": {
      "status":     "{{查订单.rows[0].status}}",
      "plugin_key": "{{查订单.rows[0].plugin_key}}",
      "plan_key":   "{{查订单.rows[0].plan_key}}",
      "amount":     "{{查订单.rows[0].amount}}",
      "currency":   "{{查订单.rows[0].currency}}",
      "paid_at":    "{{查订单.rows[0].paid_at}}"
    }
  }
}
```

#### 节点 6 — 响应输出：404

```json
{ "status_code": 404, "body": {"code": 404, "message": "订单不存在"} }
```

#### 节点 7 — 响应输出：403

```json
{ "status_code": 403, "body": {"code": 403, "message": "PAYMENT_PROJECT_FORBIDDEN"} }
```

**连线表：**

| from | to | branch |
|------|----|--------|
| 查订单 | 订单存在 | |
| 订单存在 | 查归属 | `found` |
| 订单存在 | 响应404 | `not_found` |
| 查归属 | 鉴权 | |
| 鉴权 | 响应订单 | `pass` |
| 鉴权 | 响应403 | `forbidden` |

---

### 工作流 D：查询订阅列表（端点 3）

**Slug：** `stripe-list-subscriptions`

**前端调用：**
```json
POST /workflow/acme-test-primary/stripe-list-subscriptions
{ "project_id": 123, "way_uid": "456" }
```

**节点流程：**
```
[查归属] → [鉴权] ──(forbidden)──→ [响应403]
                  └─(pass)──→ [查订阅列表] → [响应列表]
```

#### 节点 1 — 数据库查询：查归属

同工作流 B，参数：`["{{trigger.project_id}}", "{{trigger.way_uid}}"]`

#### 节点 2 — 条件分支：鉴权

同工作流 B。

#### 节点 3 — 数据库查询：查订阅列表（接 pass）

标签：`查订阅列表`，参数：`["{{trigger.project_id}}"]`

```sql
SELECT plugin_key,
       billing_cycle,
       status,
       expires_at::text  AS expires_at,   -- ::text 转换，避免 NULL
       grace_until::text AS grace_until,
       cancel_at::text   AS cancel_at
FROM gamesq.plugin_subscription
WHERE project_id = $1::int
  AND plugin_key IS NOT NULL       -- 排除无 plugin_key 的记录（系统内部用）
  AND status <> 'pending'          -- pending 是未支付的预创建记录，不展示给用户
```

#### 节点 4 — 响应输出：返回列表

```json
{
  "status_code": 200,
  "body": { "code": 0, "message": "ok", "data": "{{查订阅列表.rows}}" }
}
```

**连线表：**

| from | to | branch |
|------|----|--------|
| 查归属 | 鉴权 | |
| 鉴权 | 查订阅列表 | `pass` |
| 鉴权 | 响应403 | `forbidden` |
| 查订阅列表 | 响应列表 | |

---

### 工作流 E：查询订单历史（端点 4）

**Slug：** `stripe-list-orders`

**前端调用：**
```json
POST /workflow/acme-test-primary/stripe-list-orders
{
  "project_id": 123,
  "way_uid": "456",
  "page": 1,
  "page_size": 20,
  "offset": 0
}
```
> `offset` 由前端计算：`(page - 1) * page_size`

**节点流程：**
```
[查归属] → [鉴权] ──(forbidden)──→ [响应403]
                  └─(pass)──→ [查总数] → [查订单列表] → [响应]
```

#### 节点 3 — 数据库查询：查总数（接 pass）

标签：`查总数`，参数：`["{{trigger.project_id}}"]`

```sql
SELECT COUNT(*) AS total
FROM gamesq.plugin_order
WHERE project_id = $1::int
```

#### 节点 4 — 数据库查询：查订单列表

标签：`查订单列表`，参数：`["{{trigger.project_id}}", "{{trigger.page_size}}", "{{trigger.offset}}"]`

```sql
SELECT order_id::text,            -- uuid 转字符串
       plugin_key,
       plan_key,
       status,
       amount,
       currency,
       paid_at::text    AS paid_at,      -- timestamptz → text
       created_at::text AS created_at    -- timestamptz → text
FROM gamesq.plugin_order
WHERE project_id = $1::int
ORDER BY created_at DESC          -- 最新的订单排在前面
LIMIT  $2::int                    -- $2 = page_size，每页条数
OFFSET $3::int                    -- $3 = offset，跳过多少条
```

#### 节点 5 — 响应输出

```json
{
  "status_code": 200,
  "body": {
    "code": 0,
    "message": "ok",
    "data": {
      "items": "{{查订单列表.rows}}",
      "total": "{{查总数.rows[0].total}}"
    }
  }
}
```

---

## 四、需要 Lua 调 Stripe API（Phase 1）

> 工作流的 HTTP 调用节点只支持 JSON body，但 Stripe API 要求 `application/x-www-form-urlencoded` 格式。
> 解决方案：用 **Lua 代码节点** 手动调 Stripe，Lua 的 `http` 模块支持 form 格式。

---

### 工作流 F：购买插件 Checkout（端点 1）

**Slug：** `stripe-checkout`

**前端调用：**
```json
POST /workflow/acme-test-primary/stripe-checkout
{
  "project_id": 123,
  "plugin_key": "ai-bot",
  "plan_key": "monthly",
  "idempotency_key": "前端生成的唯一ID",
  "way_uid": "456",
  "success_url": "https://yourapp.com/plugin-store?payment=success&session_id={CHECKOUT_SESSION_ID}",
  "cancel_url": "https://yourapp.com/plugin-store?payment=cancelled"
}
```

**节点流程：**
```
[查归属] → [鉴权] ──(forbidden)──→ [响应403]
                  └─(pass)
                      → [取价] → [插件存在?] ──(not_found)──→ [响应404]
                                             └─(found)
                                                 → [查幂等] → [幂等检查] ──(already_paid)──→ [响应已支付]
                                                                          ├─(pending)──→ [取旧Session] → [响应URL]
                                                                          └─(new)
                                                                              → [Stripe调用] → [写订单] → [写订阅] → [响应URL]
```

---

#### 节点 1 — 数据库查询：查归属

同工作流 B，参数：`["{{trigger.project_id}}", "{{trigger.way_uid}}"]`

#### 节点 2 — 条件分支：鉴权

同工作流 B。

#### 节点 3 — 数据库查询：取价（接 pass）

标签：`取价`，参数：`["{{trigger.plugin_key}}"]`

```sql
SELECT id,
       name,
       price_usd_monthly::float8  AS price_usd_monthly,   -- NUMERIC 转 float8，避免返回 NULL
       price_usd_yearly::float8   AS price_usd_yearly,
       price_usd_lifetime::float8 AS price_usd_lifetime
FROM gamesq.plugin_list
WHERE plugin_key = $1
  AND is_active = true             -- 只返回已上线的插件
LIMIT 1
```

#### 节点 4 — 条件分支：插件存在？

```json
{
  "conditions": [
    { "branch": "found", "expression": "{{取价.count}} > 0" }
  ],
  "default_branch": "not_found"
}
```

#### 节点 5 — 数据库查询：查幂等（接 found）

**幂等**的意思：同一笔订单前端可能因网络重试发多次请求，服务端要保证只处理一次。

标签：`查幂等`，参数：`["{{trigger.idempotency_key}}", "{{trigger.project_id}}"]`

```sql
SELECT provider_session_id,  -- 已创建的 Stripe session ID
       status                -- 订单状态
FROM gamesq.plugin_order
WHERE idempotency_key = $1   -- $1 = 前端传的幂等 key
  AND project_id = $2::int
ORDER BY created_at DESC
LIMIT 1
```

#### 节点 6 — 条件分支：幂等判断

```json
{
  "conditions": [
    {
      "branch": "already_paid",
      "expression": "{{查幂等.rows[0].status}} == \"paid\""
    },
    {
      "branch": "already_paid",
      "expression": "{{查幂等.rows[0].status}} == \"granted\""
    },
    {
      "branch": "pending",
      "expression": "{{查幂等.count}} > 0"
    }
  ],
  "default_branch": "new"
}
```

> 解读三个分支：  
> - `already_paid`：这笔订单已经支付过，拒绝重复下单  
> - `pending`：已有未完成的 Stripe session，直接返回原来的 URL 给用户去付款  
> - `new`（默认）：全新订单，走完整创建流程

#### 节点 7 — HTTP 调用：取回旧 Session（接 pending 分支）

| 字段 | 填写内容 |
|------|---------|
| 节点类型 | HTTP 调用 |
| 标签 | `取旧Session` |
| 方法 | `GET` |
| URL | `https://api.stripe.com/v1/checkout/sessions/{{查幂等.rows[0].provider_session_id}}` |
| headers | `{"Authorization": "Bearer {{读StripeKey.stripe_key}}"}` |

> ⚠️ 此节点依赖下方"读StripeKey"节点——需要先配好 Lua 节点，再把"读StripeKey"
> 插入到"pending"分支的最前面，之后才接"取旧Session"。

#### 节点 8 — Lua 代码：读 Stripe Key

> 这是本文档第一段完整的 Lua 代码，逐行注释帮助理解。

标签：`读StripeKey`

```lua
-- ============================================================
-- 节点作用：从服务器环境变量读取 Stripe 密钥，传给后续节点使用
-- ============================================================

-- env.get() 读取服务器上配置的环境变量
-- 如果没配置，返回 nil（类似 JavaScript 的 undefined）
local key = env.get("STRIPE_SECRET_KEY")

-- 检查 key 是否存在
-- 在 Lua 里，nil 和空字符串 "" 都表示"没有值"
-- not key 等同于 JavaScript 里的 !key
if not key or key == "" then
    -- error() 让节点失败，工作流停止，避免用空 key 调 Stripe
    error("STRIPE_SECRET_KEY 未配置，请联系运维在服务器环境变量中添加")
end

-- return 把数据传给下游节点
-- 下游节点可以用 {{读StripeKey.stripe_key}} 引用这个值
return {
    stripe_key = key
}
```

#### 节点 9 — Lua 代码：调 Stripe 建 Customer + Checkout Session（接 new 分支）

> 这是最核心的 Lua 节点，整合了"查已有 Customer → 建 Customer → 建 Checkout Session"三步。  
> 逐行注释帮助你理解每一步在做什么。

标签：`Stripe调用`

```lua
-- ============================================================
-- 节点作用：调 Stripe API 完成购买流程
--   1. 查有没有已绑定的 Stripe Customer，没有就新建
--   2. 计算价格（根据 plan_key 取对应档位的美元价格，转成分/cents）
--   3. 创建 Stripe Checkout Session，获取支付页面 URL
-- ============================================================

-- ── 第一步：读取 Stripe key（从上游"读StripeKey"节点取）──────────────
-- ctx.nodes 包含所有已执行节点的输出，key 是节点标签名
local stripe_key = ctx.nodes["读StripeKey"].stripe_key

-- 读取服务器的 BASE_URL，用于拼接支付成功/取消后的跳转地址
local base_url = env.get("NEXT_PUBLIC_BASE_URL") or "https://yourapp.com"

-- ── 第二步：查有无已有的 Stripe Customer ID ──────────────────────────
-- 从上游"查已有Customer"节点取结果（需要在此节点前加一个 DB Query 节点）
-- Lua 的 and 链：如果任意一环为 nil，整个表达式返回 nil（不会报错）
local customer_query = ctx.nodes["查已有Customer"]
local existing_customer_id = customer_query
    and customer_query.rows          -- rows 是否存在
    and customer_query.rows[1]       -- 第一行是否存在（注意 Lua 数组从 1 开始）
    and customer_query.rows[1].provider_customer_id  -- 取 customer_id 列

-- ── 第三步：没有 Customer 则新建 ───────────────────────────────────────
local customer_id = existing_customer_id

-- not customer_id 等于 customer_id 为 nil 或 ""
if not customer_id or customer_id == "" then
    -- 调 Stripe POST /v1/customers 创建 Customer
    -- Stripe API 要求 form-encoded 格式（不是 JSON）
    local resp = http.post("https://api.stripe.com/v1/customers", {
        headers = {
            -- Bearer 认证：Authorization: Bearer sk_test_xxx
            ["Authorization"] = "Bearer " .. stripe_key,
            ["Content-Type"]  = "application/x-www-form-urlencoded",
        },
        -- 用 & 拼接 form 参数，类似表单提交
        -- description 用于 Stripe 后台展示，方便识别
        body = "description=project_" .. ctx.body.project_id
            .. "&metadata[project_id]=" .. tostring(ctx.body.project_id),
    })

    -- 检查 Stripe 是否返回成功
    if resp.status ~= 200 then
        -- resp.body.error.message 是 Stripe 的错误信息
        error("创建 Stripe Customer 失败: " .. (resp.body.error and resp.body.error.message or "未知错误"))
    end

    -- 取出 Stripe 返回的 Customer ID（格式如 cus_xxx）
    customer_id = resp.body.id
end

-- ── 第四步：计算订单金额 ───────────────────────────────────────────────
-- 从上游"取价"节点取插件价格信息
local price_row = ctx.nodes["取价"].rows[1]

-- 根据 plan_key 选对应价格（plan_key 来自前端传入的请求 body）
local plan_key = ctx.body.plan_key
local price_usd = nil  -- nil 表示暂无值

if plan_key == "monthly" then
    price_usd = price_row.price_usd_monthly
elseif plan_key == "yearly" then
    price_usd = price_row.price_usd_yearly
elseif plan_key == "lifetime" then
    price_usd = price_row.price_usd_lifetime
else
    -- 无效的 plan_key，直接报错终止
    error("无效的 plan_key: " .. tostring(plan_key) .. "，只支持 monthly/yearly/lifetime")
end

-- 价格未配置（NULL/nil）时报错
if not price_usd then
    error("插件 " .. ctx.body.plugin_key .. " 的 " .. plan_key .. " 价格未配置")
end

-- Stripe 要求金额单位是"分"（cents），$9.99 → 999 cents
-- math.floor(x + 0.5) 是四舍五入取整
local amount_cents = math.floor(price_usd * 100 + 0.5)

-- 生成 Stripe 收银台显示的商品名称，如"AI 客服机器人 · 按月"
local plan_labels = { monthly = "按月", yearly = "按年", lifetime = "永久" }
local plan_label = plan_labels[plan_key] or plan_key
-- price_row.name 可能为 nil，用 or 提供后备值
local product_name = (price_row.name or ctx.body.plugin_key) .. " · " .. plan_label

-- ── 第五步：生成跳转 URL ────────────────────────────────────────────────
-- 支付成功后 Stripe 跳转的 URL
-- {CHECKOUT_SESSION_ID} 是 Stripe 的模板变量，会被自动替换为真实 session ID
local success_url = ctx.body.success_url
    or (base_url .. "/plugin-store?payment=success&session_id={CHECKOUT_SESSION_ID}")

-- 用户取消支付后跳转的 URL
local cancel_url = ctx.body.cancel_url
    or (base_url .. "/plugin-store?payment=cancelled")

-- ── 第六步：生成订单 ID 并创建 Checkout Session ────────────────────────
-- crypto.uuid() 生成一个随机的 UUID，作为订单 ID 使用
local order_id = crypto.uuid()

-- 拼接 Stripe Checkout Session 的 form 参数
-- mode=payment 表示一次性付款（不是订阅），Stripe 不会自动续费
local form_body = "mode=payment"
    .. "&customer=" .. customer_id
    .. "&line_items[0][price_data][currency]=usd"
    .. "&line_items[0][price_data][unit_amount]=" .. tostring(amount_cents)
    .. "&line_items[0][price_data][product_data][name]=" .. product_name
    .. "&line_items[0][quantity]=1"
    .. "&success_url=" .. success_url
    .. "&cancel_url=" .. cancel_url
    -- metadata 里存业务数据，Stripe 会原样回传给 webhook
    .. "&metadata[project_id]=" .. tostring(ctx.body.project_id)
    .. "&metadata[plugin_key]=" .. ctx.body.plugin_key
    .. "&metadata[plan_key]=" .. plan_key
    .. "&metadata[idempotency_key]=" .. ctx.body.idempotency_key
    .. "&metadata[order_id]=" .. order_id

-- 调 Stripe API 创建 Checkout Session
local sess = http.post("https://api.stripe.com/v1/checkout/sessions", {
    headers = {
        ["Authorization"] = "Bearer " .. stripe_key,
        ["Content-Type"]  = "application/x-www-form-urlencoded",
    },
    body = form_body,
})

-- 检查创建是否成功
if sess.status ~= 200 then
    error("创建 Checkout Session 失败: " .. (sess.body.error and sess.body.error.message or "未知错误"))
end

-- ── 第七步：返回结果给下游节点 ─────────────────────────────────────────
-- 下游节点可以用 {{Stripe调用.session_id}} 等引用这些值
return {
    customer_id   = customer_id,        -- Stripe Customer ID，写入订阅表
    session_id    = sess.body.id,       -- Stripe Checkout Session ID，如 cs_test_xxx
    checkout_url  = sess.body.url,      -- 支付页面 URL，返回给前端让用户跳转
    order_id      = order_id,           -- 我们生成的订单 UUID
    amount_cents  = amount_cents,       -- 订单金额（分），写入订单表
    plugin_id     = price_row.id,       -- 插件 ID，写入订单/订阅表
}
```

> **在此节点之前**，需要加一个"数据库查询"节点查已有 Customer：

标签：`查已有Customer`，参数：`["{{trigger.project_id}}", "{{trigger.plugin_key}}"]`

```sql
-- 查这个项目是否已经有绑定的 Stripe Customer ID
-- 有则复用，避免同一个项目在 Stripe 里建多个 Customer 记录
SELECT provider_customer_id
FROM gamesq.plugin_subscription
WHERE project_id = $1::int
  AND plugin_key  = $2
LIMIT 1
```

#### 节点：数据库写入：写 plugin_order

标签：`写订单`，参数：
```json
[
  "{{Stripe调用.order_id}}",
  "{{trigger.project_id}}",
  "{{trigger.plugin_key}}",
  "{{trigger.plan_key}}",
  "{{trigger.way_uid}}",
  "{{Stripe调用.amount_cents}}",
  "{{Stripe调用.session_id}}",
  "{{trigger.idempotency_key}}"
]
```

```sql
INSERT INTO gamesq.plugin_order
  (order_id, project_id, plugin_key, plan_key, actor_way_uid, source,
   status, amount, currency, provider, provider_session_id, idempotency_key)
VALUES
  ($1::uuid,      -- order_id，我们生成的 UUID
   $2::int,       -- project_id
   $3,            -- plugin_key
   $4,            -- plan_key（monthly/yearly/lifetime）
   $5,            -- actor_way_uid，操作者的用户 ID
   'web',         -- 来源固定写 web
   'pending',     -- 状态：待支付（Stripe webhook 回调后会改为 paid）
   $6::int,       -- 金额（分）
   'USD',         -- 货币
   'stripe',      -- 支付提供商
   $7,            -- Stripe session ID
   $8)            -- 前端的幂等 key
```

#### 节点：数据库写入：写 plugin_subscription

标签：`写订阅`，参数：
```json
[
  "{{trigger.project_id}}",
  "{{Stripe调用.plugin_id}}",
  "{{trigger.plugin_key}}",
  "{{Stripe调用.customer_id}}"
]
```

```sql
INSERT INTO gamesq.plugin_subscription
  (project_id, plugin_id, plugin_key, provider_customer_id, status, is_enabled)
VALUES
  ($1::int, $2::int, $3, $4,
   'pending',  -- 状态：待激活（用户付款后 webhook 会改为 active）
   false)      -- 暂时不开启插件权限（付款后才开）
ON CONFLICT (project_id, plugin_key) WHERE plugin_key IS NOT NULL
DO UPDATE SET
    -- 如果已有记录（比如之前买过），只更新 customer_id
    provider_customer_id = EXCLUDED.provider_customer_id,
    updated_at = NOW()
```

#### 节点：响应输出：返回 checkout_url

```json
{
  "status_code": 200,
  "body": {
    "code": 0,
    "message": "ok",
    "data": {
      "checkout_url":        "{{Stripe调用.checkout_url}}",
      "provider_session_id": "{{Stripe调用.session_id}}"
    }
  }
}
```

#### 节点：响应输出：已支付（接 already_paid 分支）

```json
{
  "status_code": 400,
  "body": { "code": 400, "message": "PAYMENT_ALREADY_PAID: 该订单已完成支付" }
}
```

**完整连线表：**

| from | to | branch |
|------|----|--------|
| 查归属 | 鉴权 | |
| 鉴权 | 取价 | `pass` |
| 鉴权 | 响应403 | `forbidden` |
| 取价 | 插件存在 | |
| 插件存在 | 查幂等 | `found` |
| 插件存在 | 响应404 | `not_found` |
| 查幂等 | 幂等检查 | |
| 幂等检查 | 响应已支付 | `already_paid` |
| 幂等检查 | 读StripeKey（pending路径） | `pending` |
| 幂等检查 | 查已有Customer | `new` |
| 读StripeKey（pending路径） | 取旧Session | |
| 取旧Session | 响应旧URL | |
| 查已有Customer | 读StripeKey（new路径） | |
| 读StripeKey（new路径） | Stripe调用 | |
| Stripe调用 | 写订单 | |
| 写订单 | 写订阅 | |
| 写订阅 | 响应checkout_url | |

---

### 工作流 G：续费（端点 6）

**Slug：** `stripe-renew`

与工作流 F 基本相同，差异只有一处：`plan_key` 不从前端传，而是从数据库读取已有订阅的 `billing_cycle`。

**在"查幂等"节点前插入一个额外查询：**

标签：`查现有订阅`，参数：`["{{trigger.project_id}}", "{{trigger.plugin_key}}"]`

```sql
SELECT billing_cycle,          -- 当前订阅的计费周期（就是 plan_key）
       provider_customer_id    -- 已绑定的 Stripe Customer ID
FROM gamesq.plugin_subscription
WHERE project_id = $1::int
  AND plugin_key = $2
LIMIT 1
```

然后在 Lua 节点（`Stripe调用`）里把：
```lua
local plan_key = ctx.body.plan_key
```
改为：
```lua
-- 续费：从数据库读 billing_cycle 而不是前端传
-- 防止前端恶意传不同的 plan_key 来用便宜价格续费贵的档位
local plan_key = ctx.nodes["查现有订阅"].rows[1].billing_cycle or "monthly"
```

其余节点与工作流 F 完全相同。

---

## 五、需等待引擎开发（Phase 2/3）

> 以下工作流因引擎缺少能力，**现在无法配完**，等同事开发后再做。

### 工作流 H：调价生效 Job（Job 2）

**等待：** ForEach 节点 + DbTransaction 节点

**届时 Query 节点 SQL：**
```sql
-- 查出所有"预定在某时间生效"的调价记录
SELECT id, plugin_key,
       next_price_usd_monthly::float8  AS next_price_usd_monthly,
       next_price_usd_yearly::float8   AS next_price_usd_yearly,
       next_price_usd_lifetime::float8 AS next_price_usd_lifetime
FROM gamesq.plugin_list
WHERE price_effective_at IS NOT NULL
  AND price_effective_at <= NOW()       -- 生效时间已到
  AND pricing_model <> 'commission'     -- 排除佣金模式（不走 Stripe 定价）
  AND (next_price_usd_monthly  IS NOT NULL
    OR next_price_usd_yearly   IS NOT NULL
    OR next_price_usd_lifetime IS NOT NULL)  -- 至少有一个待生效价格
```

**届时 Execute 节点 1（UPDATE plugin_list）：**
```sql
UPDATE gamesq.plugin_list
SET
    -- COALESCE：如果新价格不为 NULL 就用新价格，否则保留旧价格
    price_usd_monthly       = COALESCE($1::float8, price_usd_monthly),
    price_usd_yearly        = COALESCE($2::float8, price_usd_yearly),
    price_usd_lifetime      = COALESCE($3::float8, price_usd_lifetime),
    -- 清空"待生效"价格字段
    next_price_usd_monthly  = NULL,
    next_price_usd_yearly   = NULL,
    next_price_usd_lifetime = NULL,
    price_effective_at      = NULL   -- 清空触发时间，避免重复执行
WHERE id = $4::int
```

**届时 Execute 节点 2（INSERT 审计记录）：**
```sql
-- 每次调价都写一条审计记录，方便追查价格变更历史
INSERT INTO gamesq.plugin_price_history
  (plugin_key, action, operator_way_uid,
   new_price_usd_monthly, new_price_usd_yearly, new_price_usd_lifetime,
   effective_at)
VALUES ($1, 'price_effective',
        0,          -- operator_way_uid = 0 表示系统自动操作（非人工）
        $2::float8, $3::float8, $4::float8,
        NOW())
```

---

### 工作流 I：Webhook（端点 7）

**等待：** `crypto.hmac_sha256` + 原始 body 透传 + DbTransaction 节点

**等待原因详解：**

1. **`crypto.hmac_sha256` 未实现**  
   Stripe 签名验证算法是 HMAC-SHA256（带密钥的哈希，防伪造）。目前 Lua 的 `crypto` 模块只有无密钥的 `sha256`，无法做验签。

2. **原始 body 透传**  
   Stripe 签名是对 HTTP 请求的**原始字节**计算的。工作流框架在接到请求后会先把 body 解析成 JSON，再传给工作流——这一步解析会改变字节序，导致签名对不上。需要框架支持把原始字节也传进来。

3. **DbTransaction 节点**  
   Webhook 处理支付成功后要做 4 个 DB 操作（改订单状态、记支付事件、激活订阅），这 4 步必须要么全成功要么全失败（数据库事务），否则中间失败会产生"已扣款未激活"的半状态。

---

## 六、缺失引擎能力开发参考（交给同事）

| 能力 | 文件 | 工作量 | 影响哪个工作流 |
|------|------|--------|--------------|
| `crypto.hmac_sha256(key, data)` | `src/lua_builtins.rs` | 半天 | Webhook 验签 |
| 原始 body 透传到 trigger_data | `src/workflow_handlers.rs` | 1-2天 | Webhook |
| DbTransaction 节点 | `src/workflow_engine.rs` | 2-3天 | Webhook, Job2 |
| ForEach 节点 | `src/workflow_engine.rs` | 2-3天 | Job2 |

**`crypto.hmac_sha256` 最小实现**（贴到 `lua_builtins.rs` 的 `register_crypto_module` 函数里）：

```rust
// 在 Lua 的 crypto 模块里注册 hmac_sha256 函数
// 用法：crypto.hmac_sha256("密钥", "数据") 返回 hex 字符串
crypto_mod.set("hmac_sha256", lua.create_function(|_, (key, data): (String, String)| {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    type HmacSha256 = Hmac<Sha256>;

    // new_from_slice：用 key 字节初始化 HMAC-SHA256 计算器
    let mut mac = HmacSha256::new_from_slice(key.as_bytes())
        .map_err(|e| mlua::Error::RuntimeError(e.to_string()))?;

    // 输入要签名的数据
    mac.update(data.as_bytes());

    // finalize() 完成计算，into_bytes() 取原始字节，hex::encode 转成十六进制字符串
    Ok(hex::encode(mac.finalize().into_bytes()))
})?)?;
```

需在 `Cargo.toml` 添加：`hmac = "0.12"`（`sha2` 已有，无需重复添加）。
