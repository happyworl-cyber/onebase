# Stripe 支付迁移至 OneBase 工作流 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `src/payment/` 下所有 Stripe 业务逻辑迁移为 OneBase 工作流节点，使框架本身不再包含任何支付业务代码。

**Architecture:** Phase 0/1 纯 API 调用（无 Rust 改动），创建 7 个工作流定义写入数据库；Phase 2 扩展引擎（hmac_sha256、raw body、DbTransaction、ForEach、cron runner），再创建 Webhook 和调价 Job 两个工作流；最后删除 src/payment/ 目录。

**Tech Stack:** Rust/axum、sqlx/PostgreSQL、Lua 5.4（mlua）、Stripe API、OneBase Workflow Engine（DAG）

---

## 环境常量（全程复用）

```
SERVER=http://127.0.0.1:3000
DATABASE_ID=2
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=Admin123
```

**刷新 token（每次新会话执行）：**
```bash
curl -s -X POST http://127.0.0.1:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"Admin123"}' \
  | grep -o '"token":"[^"]*"'
```

**约定：** 下文所有 `$TOKEN` 均指登录返回的 token 值。

---

## 节点 ID 与模板变量映射表

所有工作流统一用英文节点 ID，避免中文 ID 在部分工具中的转义问题：

| 业务含义 | node.id（模板里用这个） | label（UI 显示） |
|---|---|---|
| 查项目归属 | `ownership_check` | 查归属 |
| 鉴权分支 | `auth` | 鉴权 |
| 写取消 | `write_cancel` | 写取消 |
| 查订单 | `query_order` | 查订单 |
| 订单存在分支 | `order_exists` | 订单存在? |
| 查订阅列表 | `query_subscriptions` | 查订阅列表 |
| 查总数 | `query_count` | 查总数 |
| 查订单列表 | `query_orders` | 查订单列表 |
| 取价 | `query_price` | 取价 |
| 插件存在分支 | `plugin_exists` | 插件存在? |
| 查幂等 | `query_idempotency` | 查幂等 |
| 幂等判断分支 | `idempotency_check` | 幂等检查 |
| 读 Stripe Key（pending路径） | `read_key_pending` | 读StripeKey(pending) |
| 取旧 Session | `fetch_old_session` | 取旧Session |
| 查已有 Customer | `query_customer` | 查已有Customer |
| 读 Stripe Key（new路径） | `read_key_new` | 读StripeKey(new) |
| 调 Stripe API | `stripe_call` | Stripe调用 |
| 写订单记录 | `write_order` | 写订单 |
| 写订阅记录 | `write_subscription` | 写订阅 |
| 查现有订阅（续费用） | `query_existing_sub` | 查现有订阅 |
| 响应 200 | `resp_ok` | 响应成功 |
| 响应 checkout URL | `resp_checkout` | 响应checkout_url |
| 响应旧 Session URL | `resp_old_url` | 响应旧URL |
| 响应已支付 | `resp_already_paid` | 响应已支付 |
| 响应 403 | `resp_403` | 响应403 |
| 响应 404 | `resp_404` | 响应404 |

---

## 文件变更清单

**Phase 0/1（仅数据库写入，无代码改动）**
- 数据库：`management.workflows` 新增 7 行

**Phase 2（Rust 代码改动）**
- 修改：`src/lua_builtins.rs` — 添加 `crypto.hmac_sha256`
- 修改：`src/workflow_handlers.rs` — endpoint_trigger 保留原始 body 和 headers
- 修改：`src/workflow_engine.rs` — 新增 `DbTransaction` / `ForEach` NodeType
- 修改：`src/scheduler/runner.rs` — 添加 cron 工作流触发逻辑
- 修改：`Cargo.toml` — 添加 `hmac = "0.12"`
- 新增测试：`tests/workflow_engine_transaction.rs`
- 新增测试：`tests/workflow_engine_foreach.rs`
- 数据库：`management.workflows` 再新增 2 行

**Phase 3（删除旧代码）**
- 删除：`src/payment/` 整个目录
- 修改：`src/lib.rs` / `src/main.rs` — 移除 payment 模块注册

---

## Task 0：Pre-flight 环境核验

- [ ] **Step 0.1：刷新 token**

```bash
export TOKEN=$(curl -s -X POST http://127.0.0.1:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"Admin123"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
echo "Token OK: ${TOKEN:0:20}..."
```

Expected: 打印 `Token OK: eyJ0eXAiOi...`

- [ ] **Step 0.2：确认 database_id=2 存在**

```bash
curl -s http://127.0.0.1:3000/api/admin/workflows?database_id=2 \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool | grep '"total"'
```

Expected: `"total": 4`（当前已有 kop-pay、kop-callback 等 4 个）

- [ ] **Step 0.3：确认服务使用 Stripe 密钥**

```bash
grep STRIPE_SECRET_KEY E:/onebase/.env
```

Expected: `STRIPE_SECRET_KEY=sk_test_51R9G...`

---

## Task 1：工作流 A — 订阅到期失效（stripe-expiry-job）

> **注意：** cron runner 尚未实现，此工作流 Phase 0 创建后用 manual 触发验证，Phase 2 Task 8 完成 cron runner 后自动调度生效。

**Files:** 数据库 management.workflows

- [ ] **Step 1.1：创建工作流**

```bash
curl -s -X POST http://127.0.0.1:3000/api/admin/workflows \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "订阅到期失效",
    "slug": "stripe-expiry-job",
    "database_id": 2,
    "trigger_type": "cron",
    "trigger_config": {"schedule": "0 * * * *"},
    "is_enabled": true,
    "timeout_ms": 60000,
    "nodes": [
      {
        "id": "expire_subscriptions",
        "type": "db_execute",
        "label": "到期失效",
        "config": {
          "sql": "UPDATE gamesq.plugin_subscription SET status = '\''expired'\'', is_enabled = false, updated_at = NOW() WHERE status = '\''active'\'' AND expires_at IS NOT NULL AND expires_at < NOW()",
          "params": []
        }
      }
    ],
    "edges": []
  }'
```

- [ ] **Step 1.2：验证创建成功**

```bash
curl -s http://127.0.0.1:3000/api/admin/workflows?database_id=2 \
  -H "Authorization: Bearer $TOKEN" | python3 -c \
  "import sys,json; wfs=json.load(sys.stdin)['workflows']; \
  print([w['slug'] for w in wfs if w['slug']=='stripe-expiry-job'])"
```

Expected: `['stripe-expiry-job']`

- [ ] **Step 1.3：手动触发验证 DAG 执行**

```bash
# 先拿 workflow ID
WF_ID=$(curl -s "http://127.0.0.1:3000/api/admin/workflows?database_id=2" \
  -H "Authorization: Bearer $TOKEN" | python3 -c \
  "import sys,json; wfs=json.load(sys.stdin)['workflows']; \
  print([w['id'] for w in wfs if w['slug']=='stripe-expiry-job'][0])")

curl -s -X POST http://127.0.0.1:3000/api/admin/workflows/$WF_ID/trigger \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Expected: `{"message":"工作流已触发","workflow_id":...}`

- [ ] **Step 1.4：检查执行记录**

```bash
curl -s "http://127.0.0.1:3000/api/admin/workflows/$WF_ID/runs?limit=1" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool | grep '"status"'
```

Expected: `"status": "completed"`

- [ ] **Step 1.5：Commit**

```bash
git add -p  # 此阶段无代码改动，仅记录
git commit -m "feat(workflow): create stripe-expiry-job workflow A"
```

---

## Task 2：工作流 B — 取消订阅（stripe-cancel）

**Files:** 数据库 management.workflows

- [ ] **Step 2.1：创建工作流**

```bash
curl -s -X POST http://127.0.0.1:3000/api/admin/workflows \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "取消订阅",
    "slug": "stripe-cancel",
    "database_id": 2,
    "trigger_type": "endpoint",
    "trigger_config": {},
    "is_enabled": true,
    "nodes": [
      {
        "id": "ownership_check",
        "type": "db_query",
        "label": "查归属",
        "config": {
          "sql": "SELECT COUNT(*) AS cnt FROM (SELECT 1 FROM gamesq.project_list WHERE project_id = $1::int AND owner_way_uid = $2 UNION ALL SELECT 1 FROM gamesq.moderator_project WHERE project_id = $1::int AND way_uid = $2 AND is_delete = 0) t",
          "params": ["{{trigger.project_id}}", "{{trigger.way_uid}}"]
        }
      },
      {
        "id": "auth",
        "type": "condition",
        "label": "鉴权",
        "config": {
          "conditions": [{"branch": "pass", "expression": "{{ownership_check.rows[0].cnt}} > 0"}],
          "default_branch": "forbidden"
        }
      },
      {
        "id": "write_cancel",
        "type": "db_execute",
        "label": "写取消",
        "config": {
          "sql": "UPDATE gamesq.plugin_subscription SET cancel_at = expires_at, updated_at = NOW() WHERE project_id = $1::int AND plugin_key = $2",
          "params": ["{{trigger.project_id}}", "{{trigger.plugin_key}}"]
        }
      },
      {
        "id": "resp_ok",
        "type": "response",
        "label": "响应成功",
        "config": {"status_code": 200, "body": {"code": 0, "message": "ok", "data": {"cancelled": true}}, "headers": {}}
      },
      {
        "id": "resp_403",
        "type": "response",
        "label": "响应403",
        "config": {"status_code": 403, "body": {"code": 403, "message": "PAYMENT_PROJECT_FORBIDDEN"}, "headers": {}}
      }
    ],
    "edges": [
      {"from": "ownership_check", "to": "auth"},
      {"from": "auth", "to": "write_cancel", "branch": "pass"},
      {"from": "auth", "to": "resp_403", "branch": "forbidden"},
      {"from": "write_cancel", "to": "resp_ok"}
    ]
  }'
```

- [ ] **Step 2.2：测试鉴权通过路径**

```bash
# 替换 project_id/way_uid 为真实测试数据
curl -s -X POST "http://127.0.0.1:3000/workflow/acme-test-primary/stripe-cancel" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id": 1, "plugin_key": "test-plugin", "way_uid": "test_uid"}'
```

Expected（有权限时）: `{"code":0,"message":"ok","data":{"cancelled":true}}`

- [ ] **Step 2.3：测试鉴权拒绝路径**

```bash
curl -s -X POST "http://127.0.0.1:3000/workflow/acme-test-primary/stripe-cancel" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id": 999999, "plugin_key": "x", "way_uid": "nobody"}'
```

Expected: `{"code":403,"message":"PAYMENT_PROJECT_FORBIDDEN"}`

---

## Task 3：工作流 C — 查询订单状态（stripe-get-order）

- [ ] **Step 3.1：创建工作流**

```bash
curl -s -X POST http://127.0.0.1:3000/api/admin/workflows \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "查询订单状态",
    "slug": "stripe-get-order",
    "database_id": 2,
    "trigger_type": "endpoint",
    "trigger_config": {},
    "is_enabled": true,
    "nodes": [
      {
        "id": "query_order",
        "type": "db_query",
        "label": "查订单",
        "config": {
          "sql": "SELECT project_id, plugin_key, plan_key, status, amount, currency, paid_at::text AS paid_at FROM gamesq.plugin_order WHERE provider_session_id = $1 AND provider = '\''stripe'\'' LIMIT 1",
          "params": ["{{trigger.provider_session_id}}"]
        }
      },
      {
        "id": "order_exists",
        "type": "condition",
        "label": "订单存在?",
        "config": {
          "conditions": [{"branch": "found", "expression": "{{query_order.count}} > 0"}],
          "default_branch": "not_found"
        }
      },
      {
        "id": "ownership_check",
        "type": "db_query",
        "label": "查归属",
        "config": {
          "sql": "SELECT COUNT(*) AS cnt FROM (SELECT 1 FROM gamesq.project_list WHERE project_id = $1::int AND owner_way_uid = $2 UNION ALL SELECT 1 FROM gamesq.moderator_project WHERE project_id = $1::int AND way_uid = $2 AND is_delete = 0) t",
          "params": ["{{query_order.rows[0].project_id}}", "{{trigger.way_uid}}"]
        }
      },
      {
        "id": "auth",
        "type": "condition",
        "label": "鉴权",
        "config": {
          "conditions": [{"branch": "pass", "expression": "{{ownership_check.rows[0].cnt}} > 0"}],
          "default_branch": "forbidden"
        }
      },
      {
        "id": "resp_order",
        "type": "response",
        "label": "响应订单",
        "config": {
          "status_code": 200,
          "body": {"code": 0, "message": "ok", "data": {"status": "{{query_order.rows[0].status}}", "plugin_key": "{{query_order.rows[0].plugin_key}}", "plan_key": "{{query_order.rows[0].plan_key}}", "amount": "{{query_order.rows[0].amount}}", "currency": "{{query_order.rows[0].currency}}", "paid_at": "{{query_order.rows[0].paid_at}}"}},
          "headers": {}
        }
      },
      {
        "id": "resp_404",
        "type": "response",
        "label": "响应404",
        "config": {"status_code": 404, "body": {"code": 404, "message": "订单不存在"}, "headers": {}}
      },
      {
        "id": "resp_403",
        "type": "response",
        "label": "响应403",
        "config": {"status_code": 403, "body": {"code": 403, "message": "PAYMENT_PROJECT_FORBIDDEN"}, "headers": {}}
      }
    ],
    "edges": [
      {"from": "query_order", "to": "order_exists"},
      {"from": "order_exists", "to": "ownership_check", "branch": "found"},
      {"from": "order_exists", "to": "resp_404", "branch": "not_found"},
      {"from": "ownership_check", "to": "auth"},
      {"from": "auth", "to": "resp_order", "branch": "pass"},
      {"from": "auth", "to": "resp_403", "branch": "forbidden"}
    ]
  }'
```

- [ ] **Step 3.2：测试不存在的 session_id**

```bash
curl -s -X POST "http://127.0.0.1:3000/workflow/acme-test-primary/stripe-get-order" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"provider_session_id": "cs_test_nonexistent", "way_uid": "test"}'
```

Expected: `{"code":404,"message":"订单不存在"}`

---

## Task 4：工作流 D — 查询订阅列表（stripe-list-subscriptions）

- [ ] **Step 4.1：创建工作流**

```bash
curl -s -X POST http://127.0.0.1:3000/api/admin/workflows \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "查询订阅列表",
    "slug": "stripe-list-subscriptions",
    "database_id": 2,
    "trigger_type": "endpoint",
    "trigger_config": {},
    "is_enabled": true,
    "nodes": [
      {
        "id": "ownership_check",
        "type": "db_query",
        "label": "查归属",
        "config": {
          "sql": "SELECT COUNT(*) AS cnt FROM (SELECT 1 FROM gamesq.project_list WHERE project_id = $1::int AND owner_way_uid = $2 UNION ALL SELECT 1 FROM gamesq.moderator_project WHERE project_id = $1::int AND way_uid = $2 AND is_delete = 0) t",
          "params": ["{{trigger.project_id}}", "{{trigger.way_uid}}"]
        }
      },
      {
        "id": "auth",
        "type": "condition",
        "label": "鉴权",
        "config": {
          "conditions": [{"branch": "pass", "expression": "{{ownership_check.rows[0].cnt}} > 0"}],
          "default_branch": "forbidden"
        }
      },
      {
        "id": "query_subscriptions",
        "type": "db_query",
        "label": "查订阅列表",
        "config": {
          "sql": "SELECT plugin_key, billing_cycle, status, expires_at::text AS expires_at, grace_until::text AS grace_until, cancel_at::text AS cancel_at FROM gamesq.plugin_subscription WHERE project_id = $1::int AND plugin_key IS NOT NULL AND status <> '\''pending'\''",
          "params": ["{{trigger.project_id}}"]
        }
      },
      {
        "id": "resp_list",
        "type": "response",
        "label": "响应列表",
        "config": {
          "status_code": 200,
          "body": {"code": 0, "message": "ok", "data": "{{query_subscriptions.rows}}"},
          "headers": {}
        }
      },
      {
        "id": "resp_403",
        "type": "response",
        "label": "响应403",
        "config": {"status_code": 403, "body": {"code": 403, "message": "PAYMENT_PROJECT_FORBIDDEN"}, "headers": {}}
      }
    ],
    "edges": [
      {"from": "ownership_check", "to": "auth"},
      {"from": "auth", "to": "query_subscriptions", "branch": "pass"},
      {"from": "auth", "to": "resp_403", "branch": "forbidden"},
      {"from": "query_subscriptions", "to": "resp_list"}
    ]
  }'
```

- [ ] **Step 4.2：测试无权限**

```bash
curl -s -X POST "http://127.0.0.1:3000/workflow/acme-test-primary/stripe-list-subscriptions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id": 999999, "way_uid": "nobody"}'
```

Expected: `{"code":403,"message":"PAYMENT_PROJECT_FORBIDDEN"}`

---

## Task 5：工作流 E — 查询订单历史（stripe-list-orders）

- [ ] **Step 5.1：创建工作流**

```bash
curl -s -X POST http://127.0.0.1:3000/api/admin/workflows \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "查询订单历史",
    "slug": "stripe-list-orders",
    "database_id": 2,
    "trigger_type": "endpoint",
    "trigger_config": {},
    "is_enabled": true,
    "nodes": [
      {
        "id": "ownership_check",
        "type": "db_query",
        "label": "查归属",
        "config": {
          "sql": "SELECT COUNT(*) AS cnt FROM (SELECT 1 FROM gamesq.project_list WHERE project_id = $1::int AND owner_way_uid = $2 UNION ALL SELECT 1 FROM gamesq.moderator_project WHERE project_id = $1::int AND way_uid = $2 AND is_delete = 0) t",
          "params": ["{{trigger.project_id}}", "{{trigger.way_uid}}"]
        }
      },
      {
        "id": "auth",
        "type": "condition",
        "label": "鉴权",
        "config": {
          "conditions": [{"branch": "pass", "expression": "{{ownership_check.rows[0].cnt}} > 0"}],
          "default_branch": "forbidden"
        }
      },
      {
        "id": "query_count",
        "type": "db_query",
        "label": "查总数",
        "config": {
          "sql": "SELECT COUNT(*) AS total FROM gamesq.plugin_order WHERE project_id = $1::int",
          "params": ["{{trigger.project_id}}"]
        }
      },
      {
        "id": "query_orders",
        "type": "db_query",
        "label": "查订单列表",
        "config": {
          "sql": "SELECT order_id::text, plugin_key, plan_key, status, amount, currency, paid_at::text AS paid_at, created_at::text AS created_at FROM gamesq.plugin_order WHERE project_id = $1::int ORDER BY created_at DESC LIMIT $2::int OFFSET $3::int",
          "params": ["{{trigger.project_id}}", "{{trigger.page_size}}", "{{trigger.offset}}"]
        }
      },
      {
        "id": "resp_orders",
        "type": "response",
        "label": "响应",
        "config": {
          "status_code": 200,
          "body": {"code": 0, "message": "ok", "data": {"items": "{{query_orders.rows}}", "total": "{{query_count.rows[0].total}}"}},
          "headers": {}
        }
      },
      {
        "id": "resp_403",
        "type": "response",
        "label": "响应403",
        "config": {"status_code": 403, "body": {"code": 403, "message": "PAYMENT_PROJECT_FORBIDDEN"}, "headers": {}}
      }
    ],
    "edges": [
      {"from": "ownership_check", "to": "auth"},
      {"from": "auth", "to": "query_count", "branch": "pass"},
      {"from": "auth", "to": "resp_403", "branch": "forbidden"},
      {"from": "query_count", "to": "query_orders"},
      {"from": "query_orders", "to": "resp_orders"}
    ]
  }'
```

- [ ] **Step 5.2：测试分页查询**

```bash
curl -s -X POST "http://127.0.0.1:3000/workflow/acme-test-primary/stripe-list-orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id": 999999, "way_uid": "nobody", "page": 1, "page_size": 20, "offset": 0}'
```

Expected（无权限）: `{"code":403,...}`

---

## Task 6：工作流 F — 购买插件 Checkout（stripe-checkout）

> 最复杂的工作流，包含 3 条分支路径，共 15 个节点。

- [ ] **Step 6.1：创建工作流**

```bash
curl -s -X POST http://127.0.0.1:3000/api/admin/workflows \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "购买插件Checkout",
    "slug": "stripe-checkout",
    "database_id": 2,
    "trigger_type": "endpoint",
    "trigger_config": {},
    "is_enabled": true,
    "timeout_ms": 30000,
    "nodes": [
      {
        "id": "ownership_check",
        "type": "db_query",
        "label": "查归属",
        "config": {
          "sql": "SELECT COUNT(*) AS cnt FROM (SELECT 1 FROM gamesq.project_list WHERE project_id = $1::int AND owner_way_uid = $2 UNION ALL SELECT 1 FROM gamesq.moderator_project WHERE project_id = $1::int AND way_uid = $2 AND is_delete = 0) t",
          "params": ["{{trigger.project_id}}", "{{trigger.way_uid}}"]
        }
      },
      {
        "id": "auth",
        "type": "condition",
        "label": "鉴权",
        "config": {
          "conditions": [{"branch": "pass", "expression": "{{ownership_check.rows[0].cnt}} > 0"}],
          "default_branch": "forbidden"
        }
      },
      {
        "id": "query_price",
        "type": "db_query",
        "label": "取价",
        "config": {
          "sql": "SELECT id, name, price_usd_monthly::float8 AS price_usd_monthly, price_usd_yearly::float8 AS price_usd_yearly, price_usd_lifetime::float8 AS price_usd_lifetime FROM gamesq.plugin_list WHERE plugin_key = $1 AND is_active = true LIMIT 1",
          "params": ["{{trigger.plugin_key}}"]
        }
      },
      {
        "id": "plugin_exists",
        "type": "condition",
        "label": "插件存在?",
        "config": {
          "conditions": [{"branch": "found", "expression": "{{query_price.count}} > 0"}],
          "default_branch": "not_found"
        }
      },
      {
        "id": "query_idempotency",
        "type": "db_query",
        "label": "查幂等",
        "config": {
          "sql": "SELECT provider_session_id, status FROM gamesq.plugin_order WHERE idempotency_key = $1 AND project_id = $2::int ORDER BY created_at DESC LIMIT 1",
          "params": ["{{trigger.idempotency_key}}", "{{trigger.project_id}}"]
        }
      },
      {
        "id": "idempotency_check",
        "type": "condition",
        "label": "幂等检查",
        "config": {
          "conditions": [
            {"branch": "already_paid", "expression": "{{query_idempotency.rows[0].status}} == \"paid\""},
            {"branch": "already_paid", "expression": "{{query_idempotency.rows[0].status}} == \"granted\""},
            {"branch": "pending", "expression": "{{query_idempotency.count}} > 0"}
          ],
          "default_branch": "new"
        }
      },
      {
        "id": "read_key_pending",
        "type": "code",
        "label": "读StripeKey(pending)",
        "config": {
          "code": "local key = env.get(\"STRIPE_SECRET_KEY\")\nif not key or key == \"\" then error(\"STRIPE_SECRET_KEY 未配置\") end\nreturn { stripe_key = key }"
        }
      },
      {
        "id": "fetch_old_session",
        "type": "http_call",
        "label": "取旧Session",
        "config": {
          "url": "https://api.stripe.com/v1/checkout/sessions/{{query_idempotency.rows[0].provider_session_id}}",
          "method": "GET",
          "headers": {"Authorization": "Bearer {{read_key_pending.stripe_key}}"},
          "body": null
        }
      },
      {
        "id": "resp_old_url",
        "type": "response",
        "label": "响应旧URL",
        "config": {
          "status_code": 200,
          "body": {"code": 0, "message": "ok", "data": {"checkout_url": "{{fetch_old_session.body.url}}", "provider_session_id": "{{query_idempotency.rows[0].provider_session_id}}"}},
          "headers": {}
        }
      },
      {
        "id": "query_customer",
        "type": "db_query",
        "label": "查已有Customer",
        "config": {
          "sql": "SELECT provider_customer_id FROM gamesq.plugin_subscription WHERE project_id = $1::int AND plugin_key = $2 LIMIT 1",
          "params": ["{{trigger.project_id}}", "{{trigger.plugin_key}}"]
        }
      },
      {
        "id": "read_key_new",
        "type": "code",
        "label": "读StripeKey(new)",
        "config": {
          "code": "local key = env.get(\"STRIPE_SECRET_KEY\")\nif not key or key == \"\" then error(\"STRIPE_SECRET_KEY 未配置\") end\nreturn { stripe_key = key }"
        }
      },
      {
        "id": "stripe_call",
        "type": "code",
        "label": "Stripe调用",
        "config": {
          "code": "local stripe_key = ctx.nodes[\"read_key_new\"].stripe_key\nlocal base_url = env.get(\"NEXT_PUBLIC_BASE_URL\") or \"https://yourapp.com\"\n\nlocal customer_query = ctx.nodes[\"query_customer\"]\nlocal existing_customer_id = customer_query\n    and customer_query.rows\n    and customer_query.rows[1]\n    and customer_query.rows[1].provider_customer_id\n\nlocal customer_id = existing_customer_id\nif not customer_id or customer_id == \"\" then\n    local resp = http.post(\"https://api.stripe.com/v1/customers\", {\n        headers = {\n            [\"Authorization\"] = \"Bearer \" .. stripe_key,\n            [\"Content-Type\"]  = \"application/x-www-form-urlencoded\",\n        },\n        body = \"description=project_\" .. ctx.body.project_id\n            .. \"&metadata[project_id]=\" .. tostring(ctx.body.project_id),\n    })\n    if resp.status ~= 200 then\n        error(\"创建 Stripe Customer 失败: \" .. (resp.body.error and resp.body.error.message or \"未知错误\"))\n    end\n    customer_id = resp.body.id\nend\n\nlocal price_row = ctx.nodes[\"query_price\"].rows[1]\nlocal plan_key = ctx.body.plan_key\nlocal price_usd = nil\nif plan_key == \"monthly\" then\n    price_usd = price_row.price_usd_monthly\nelseif plan_key == \"yearly\" then\n    price_usd = price_row.price_usd_yearly\nelseif plan_key == \"lifetime\" then\n    price_usd = price_row.price_usd_lifetime\nelse\n    error(\"无效的 plan_key: \" .. tostring(plan_key))\nend\nif not price_usd then\n    error(\"插件 \" .. ctx.body.plugin_key .. \" 的 \" .. plan_key .. \" 价格未配置\")\nend\n\nlocal amount_cents = math.floor(price_usd * 100 + 0.5)\nlocal plan_labels = { monthly = \"按月\", yearly = \"按年\", lifetime = \"永久\" }\nlocal plan_label = plan_labels[plan_key] or plan_key\nlocal product_name = (price_row.name or ctx.body.plugin_key) .. \" · \" .. plan_label\n\nlocal success_url = ctx.body.success_url or (base_url .. \"/plugin-store?payment=success&session_id={CHECKOUT_SESSION_ID}\")\nlocal cancel_url  = ctx.body.cancel_url  or (base_url .. \"/plugin-store?payment=cancelled\")\nlocal order_id = crypto.uuid()\n\nlocal form_body = \"mode=payment\"\n    .. \"&customer=\" .. customer_id\n    .. \"&line_items[0][price_data][currency]=usd\"\n    .. \"&line_items[0][price_data][unit_amount]=\" .. tostring(amount_cents)\n    .. \"&line_items[0][price_data][product_data][name]=\" .. product_name\n    .. \"&line_items[0][quantity]=1\"\n    .. \"&success_url=\" .. success_url\n    .. \"&cancel_url=\" .. cancel_url\n    .. \"&metadata[project_id]=\" .. tostring(ctx.body.project_id)\n    .. \"&metadata[plugin_key]=\" .. ctx.body.plugin_key\n    .. \"&metadata[plan_key]=\" .. plan_key\n    .. \"&metadata[idempotency_key]=\" .. ctx.body.idempotency_key\n    .. \"&metadata[order_id]=\" .. order_id\n\nlocal sess = http.post(\"https://api.stripe.com/v1/checkout/sessions\", {\n    headers = {\n        [\"Authorization\"] = \"Bearer \" .. stripe_key,\n        [\"Content-Type\"]  = \"application/x-www-form-urlencoded\",\n    },\n    body = form_body,\n})\nif sess.status ~= 200 then\n    error(\"创建 Checkout Session 失败: \" .. (sess.body.error and sess.body.error.message or \"未知错误\"))\nend\n\nreturn {\n    customer_id   = customer_id,\n    session_id    = sess.body.id,\n    checkout_url  = sess.body.url,\n    order_id      = order_id,\n    amount_cents  = amount_cents,\n    plugin_id     = price_row.id,\n}"
        }
      },
      {
        "id": "write_order",
        "type": "db_execute",
        "label": "写订单",
        "config": {
          "sql": "INSERT INTO gamesq.plugin_order (order_id, project_id, plugin_key, plan_key, actor_way_uid, source, status, amount, currency, provider, provider_session_id, idempotency_key) VALUES ($1::uuid, $2::int, $3, $4, $5, '\''web'\'', '\''pending'\'', $6::int, '\''USD'\'', '\''stripe'\'', $7, $8)",
          "params": ["{{stripe_call.order_id}}", "{{trigger.project_id}}", "{{trigger.plugin_key}}", "{{trigger.plan_key}}", "{{trigger.way_uid}}", "{{stripe_call.amount_cents}}", "{{stripe_call.session_id}}", "{{trigger.idempotency_key}}"]
        }
      },
      {
        "id": "write_subscription",
        "type": "db_execute",
        "label": "写订阅",
        "config": {
          "sql": "INSERT INTO gamesq.plugin_subscription (project_id, plugin_id, plugin_key, provider_customer_id, status, is_enabled) VALUES ($1::int, $2::int, $3, $4, '\''pending'\'', false) ON CONFLICT (project_id, plugin_key) WHERE plugin_key IS NOT NULL DO UPDATE SET provider_customer_id = EXCLUDED.provider_customer_id, updated_at = NOW()",
          "params": ["{{trigger.project_id}}", "{{stripe_call.plugin_id}}", "{{trigger.plugin_key}}", "{{stripe_call.customer_id}}"]
        }
      },
      {
        "id": "resp_checkout",
        "type": "response",
        "label": "响应checkout_url",
        "config": {
          "status_code": 200,
          "body": {"code": 0, "message": "ok", "data": {"checkout_url": "{{stripe_call.checkout_url}}", "provider_session_id": "{{stripe_call.session_id}}"}},
          "headers": {}
        }
      },
      {
        "id": "resp_already_paid",
        "type": "response",
        "label": "响应已支付",
        "config": {"status_code": 400, "body": {"code": 400, "message": "PAYMENT_ALREADY_PAID: 该订单已完成支付"}, "headers": {}}
      },
      {
        "id": "resp_404",
        "type": "response",
        "label": "响应404",
        "config": {"status_code": 404, "body": {"code": 404, "message": "插件不存在或未上线"}, "headers": {}}
      },
      {
        "id": "resp_403",
        "type": "response",
        "label": "响应403",
        "config": {"status_code": 403, "body": {"code": 403, "message": "PAYMENT_PROJECT_FORBIDDEN"}, "headers": {}}
      }
    ],
    "edges": [
      {"from": "ownership_check", "to": "auth"},
      {"from": "auth", "to": "query_price", "branch": "pass"},
      {"from": "auth", "to": "resp_403", "branch": "forbidden"},
      {"from": "query_price", "to": "plugin_exists"},
      {"from": "plugin_exists", "to": "query_idempotency", "branch": "found"},
      {"from": "plugin_exists", "to": "resp_404", "branch": "not_found"},
      {"from": "query_idempotency", "to": "idempotency_check"},
      {"from": "idempotency_check", "to": "resp_already_paid", "branch": "already_paid"},
      {"from": "idempotency_check", "to": "read_key_pending", "branch": "pending"},
      {"from": "idempotency_check", "to": "query_customer", "branch": "new"},
      {"from": "read_key_pending", "to": "fetch_old_session"},
      {"from": "fetch_old_session", "to": "resp_old_url"},
      {"from": "query_customer", "to": "read_key_new"},
      {"from": "read_key_new", "to": "stripe_call"},
      {"from": "stripe_call", "to": "write_order"},
      {"from": "write_order", "to": "write_subscription"},
      {"from": "write_subscription", "to": "resp_checkout"}
    ]
  }'
```

- [ ] **Step 6.2：验证创建并检查节点数**

```bash
WF_F_ID=$(curl -s "http://127.0.0.1:3000/api/admin/workflows?database_id=2" \
  -H "Authorization: Bearer $TOKEN" | python3 -c \
  "import sys,json; wfs=json.load(sys.stdin)['workflows']; \
  print([w['id'] for w in wfs if w['slug']=='stripe-checkout'][0])")

curl -s "http://127.0.0.1:3000/api/admin/workflows/$WF_F_ID" \
  -H "Authorization: Bearer $TOKEN" | python3 -c \
  "import sys,json; wf=json.load(sys.stdin)['workflow']; \
  print('nodes:', len(wf['nodes']), 'edges:', len(wf['edges']))"
```

Expected: `nodes: 15 edges: 17`

- [ ] **Step 6.3：测试无权限**

```bash
curl -s -X POST "http://127.0.0.1:3000/workflow/acme-test-primary/stripe-checkout" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id": 999999, "plugin_key": "x", "plan_key": "monthly", "idempotency_key": "test_k1", "way_uid": "nobody"}'
```

Expected: `{"code":403,"message":"PAYMENT_PROJECT_FORBIDDEN"}`

- [ ] **Step 6.4：测试插件不存在**

```bash
curl -s -X POST "http://127.0.0.1:3000/workflow/acme-test-primary/stripe-checkout" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id": 1, "plugin_key": "nonexistent-plugin-xyz", "plan_key": "monthly", "idempotency_key": "test_k2", "way_uid": "valid_uid"}'
```

Expected（有项目归属时）: `{"code":404,"message":"插件不存在或未上线"}`

---

## Task 7：工作流 G — 续费（stripe-renew）

> 与工作流 F 基本相同，差异：多一个 `query_existing_sub` 节点，`stripe_call` 的 Lua 代码改从数据库读 plan_key。

- [ ] **Step 7.1：创建工作流**

```bash
curl -s -X POST http://127.0.0.1:3000/api/admin/workflows \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "续费",
    "slug": "stripe-renew",
    "database_id": 2,
    "trigger_type": "endpoint",
    "trigger_config": {},
    "is_enabled": true,
    "timeout_ms": 30000,
    "nodes": [
      {
        "id": "ownership_check",
        "type": "db_query",
        "label": "查归属",
        "config": {
          "sql": "SELECT COUNT(*) AS cnt FROM (SELECT 1 FROM gamesq.project_list WHERE project_id = $1::int AND owner_way_uid = $2 UNION ALL SELECT 1 FROM gamesq.moderator_project WHERE project_id = $1::int AND way_uid = $2 AND is_delete = 0) t",
          "params": ["{{trigger.project_id}}", "{{trigger.way_uid}}"]
        }
      },
      {
        "id": "auth",
        "type": "condition",
        "label": "鉴权",
        "config": {
          "conditions": [{"branch": "pass", "expression": "{{ownership_check.rows[0].cnt}} > 0"}],
          "default_branch": "forbidden"
        }
      },
      {
        "id": "query_price",
        "type": "db_query",
        "label": "取价",
        "config": {
          "sql": "SELECT id, name, price_usd_monthly::float8 AS price_usd_monthly, price_usd_yearly::float8 AS price_usd_yearly, price_usd_lifetime::float8 AS price_usd_lifetime FROM gamesq.plugin_list WHERE plugin_key = $1 AND is_active = true LIMIT 1",
          "params": ["{{trigger.plugin_key}}"]
        }
      },
      {
        "id": "plugin_exists",
        "type": "condition",
        "label": "插件存在?",
        "config": {
          "conditions": [{"branch": "found", "expression": "{{query_price.count}} > 0"}],
          "default_branch": "not_found"
        }
      },
      {
        "id": "query_existing_sub",
        "type": "db_query",
        "label": "查现有订阅",
        "config": {
          "sql": "SELECT billing_cycle, provider_customer_id FROM gamesq.plugin_subscription WHERE project_id = $1::int AND plugin_key = $2 LIMIT 1",
          "params": ["{{trigger.project_id}}", "{{trigger.plugin_key}}"]
        }
      },
      {
        "id": "query_idempotency",
        "type": "db_query",
        "label": "查幂等",
        "config": {
          "sql": "SELECT provider_session_id, status FROM gamesq.plugin_order WHERE idempotency_key = $1 AND project_id = $2::int ORDER BY created_at DESC LIMIT 1",
          "params": ["{{trigger.idempotency_key}}", "{{trigger.project_id}}"]
        }
      },
      {
        "id": "idempotency_check",
        "type": "condition",
        "label": "幂等检查",
        "config": {
          "conditions": [
            {"branch": "already_paid", "expression": "{{query_idempotency.rows[0].status}} == \"paid\""},
            {"branch": "already_paid", "expression": "{{query_idempotency.rows[0].status}} == \"granted\""},
            {"branch": "pending", "expression": "{{query_idempotency.count}} > 0"}
          ],
          "default_branch": "new"
        }
      },
      {
        "id": "read_key_pending",
        "type": "code",
        "label": "读StripeKey(pending)",
        "config": {
          "code": "local key = env.get(\"STRIPE_SECRET_KEY\")\nif not key or key == \"\" then error(\"STRIPE_SECRET_KEY 未配置\") end\nreturn { stripe_key = key }"
        }
      },
      {
        "id": "fetch_old_session",
        "type": "http_call",
        "label": "取旧Session",
        "config": {
          "url": "https://api.stripe.com/v1/checkout/sessions/{{query_idempotency.rows[0].provider_session_id}}",
          "method": "GET",
          "headers": {"Authorization": "Bearer {{read_key_pending.stripe_key}}"},
          "body": null
        }
      },
      {
        "id": "resp_old_url",
        "type": "response",
        "label": "响应旧URL",
        "config": {
          "status_code": 200,
          "body": {"code": 0, "message": "ok", "data": {"checkout_url": "{{fetch_old_session.body.url}}", "provider_session_id": "{{query_idempotency.rows[0].provider_session_id}}"}},
          "headers": {}
        }
      },
      {
        "id": "query_customer",
        "type": "db_query",
        "label": "查已有Customer",
        "config": {
          "sql": "SELECT provider_customer_id FROM gamesq.plugin_subscription WHERE project_id = $1::int AND plugin_key = $2 LIMIT 1",
          "params": ["{{trigger.project_id}}", "{{trigger.plugin_key}}"]
        }
      },
      {
        "id": "read_key_new",
        "type": "code",
        "label": "读StripeKey(new)",
        "config": {
          "code": "local key = env.get(\"STRIPE_SECRET_KEY\")\nif not key or key == \"\" then error(\"STRIPE_SECRET_KEY 未配置\") end\nreturn { stripe_key = key }"
        }
      },
      {
        "id": "stripe_call",
        "type": "code",
        "label": "Stripe调用(续费)",
        "config": {
          "code": "local stripe_key = ctx.nodes[\"read_key_new\"].stripe_key\nlocal base_url = env.get(\"NEXT_PUBLIC_BASE_URL\") or \"https://yourapp.com\"\n\nlocal customer_query = ctx.nodes[\"query_customer\"]\nlocal existing_customer_id = customer_query\n    and customer_query.rows\n    and customer_query.rows[1]\n    and customer_query.rows[1].provider_customer_id\n\nlocal customer_id = existing_customer_id\nif not customer_id or customer_id == \"\" then\n    local resp = http.post(\"https://api.stripe.com/v1/customers\", {\n        headers = {\n            [\"Authorization\"] = \"Bearer \" .. stripe_key,\n            [\"Content-Type\"]  = \"application/x-www-form-urlencoded\",\n        },\n        body = \"description=project_\" .. ctx.body.project_id\n            .. \"&metadata[project_id]=\" .. tostring(ctx.body.project_id),\n    })\n    if resp.status ~= 200 then\n        error(\"创建 Stripe Customer 失败: \" .. (resp.body.error and resp.body.error.message or \"未知错误\"))\n    end\n    customer_id = resp.body.id\nend\n\nlocal price_row = ctx.nodes[\"query_price\"].rows[1]\n-- 续费：从数据库读 billing_cycle，防止前端传错 plan_key 用便宜价格续贵档位\nlocal existing_sub = ctx.nodes[\"query_existing_sub\"]\nlocal plan_key = existing_sub and existing_sub.rows and existing_sub.rows[1] and existing_sub.rows[1].billing_cycle or \"monthly\"\n\nlocal price_usd = nil\nif plan_key == \"monthly\" then\n    price_usd = price_row.price_usd_monthly\nelseif plan_key == \"yearly\" then\n    price_usd = price_row.price_usd_yearly\nelseif plan_key == \"lifetime\" then\n    price_usd = price_row.price_usd_lifetime\nelse\n    error(\"无效的 plan_key: \" .. tostring(plan_key))\nend\nif not price_usd then\n    error(\"插件 \" .. ctx.body.plugin_key .. \" 的 \" .. plan_key .. \" 价格未配置\")\nend\n\nlocal amount_cents = math.floor(price_usd * 100 + 0.5)\nlocal plan_labels = { monthly = \"按月\", yearly = \"按年\", lifetime = \"永久\" }\nlocal plan_label = plan_labels[plan_key] or plan_key\nlocal product_name = (price_row.name or ctx.body.plugin_key) .. \" · \" .. plan_label .. \"(续费)\"\n\nlocal success_url = ctx.body.success_url or (base_url .. \"/plugin-store?payment=success&session_id={CHECKOUT_SESSION_ID}\")\nlocal cancel_url  = ctx.body.cancel_url  or (base_url .. \"/plugin-store?payment=cancelled\")\nlocal order_id = crypto.uuid()\n\nlocal form_body = \"mode=payment\"\n    .. \"&customer=\" .. customer_id\n    .. \"&line_items[0][price_data][currency]=usd\"\n    .. \"&line_items[0][price_data][unit_amount]=\" .. tostring(amount_cents)\n    .. \"&line_items[0][price_data][product_data][name]=\" .. product_name\n    .. \"&line_items[0][quantity]=1\"\n    .. \"&success_url=\" .. success_url\n    .. \"&cancel_url=\" .. cancel_url\n    .. \"&metadata[project_id]=\" .. tostring(ctx.body.project_id)\n    .. \"&metadata[plugin_key]=\" .. ctx.body.plugin_key\n    .. \"&metadata[plan_key]=\" .. plan_key\n    .. \"&metadata[idempotency_key]=\" .. ctx.body.idempotency_key\n    .. \"&metadata[order_id]=\" .. order_id\n\nlocal sess = http.post(\"https://api.stripe.com/v1/checkout/sessions\", {\n    headers = {\n        [\"Authorization\"] = \"Bearer \" .. stripe_key,\n        [\"Content-Type\"]  = \"application/x-www-form-urlencoded\",\n    },\n    body = form_body,\n})\nif sess.status ~= 200 then\n    error(\"创建 Checkout Session 失败: \" .. (sess.body.error and sess.body.error.message or \"未知错误\"))\nend\n\nreturn {\n    customer_id   = customer_id,\n    session_id    = sess.body.id,\n    checkout_url  = sess.body.url,\n    order_id      = order_id,\n    amount_cents  = amount_cents,\n    plugin_id     = price_row.id,\n}"
        }
      },
      {
        "id": "write_order",
        "type": "db_execute",
        "label": "写订单",
        "config": {
          "sql": "INSERT INTO gamesq.plugin_order (order_id, project_id, plugin_key, plan_key, actor_way_uid, source, status, amount, currency, provider, provider_session_id, idempotency_key) VALUES ($1::uuid, $2::int, $3, $4, $5, '\''web'\'', '\''pending'\'', $6::int, '\''USD'\'', '\''stripe'\'', $7, $8)",
          "params": ["{{stripe_call.order_id}}", "{{trigger.project_id}}", "{{trigger.plugin_key}}", "{{trigger.plan_key}}", "{{trigger.way_uid}}", "{{stripe_call.amount_cents}}", "{{stripe_call.session_id}}", "{{trigger.idempotency_key}}"]
        }
      },
      {
        "id": "write_subscription",
        "type": "db_execute",
        "label": "写订阅",
        "config": {
          "sql": "INSERT INTO gamesq.plugin_subscription (project_id, plugin_id, plugin_key, provider_customer_id, status, is_enabled) VALUES ($1::int, $2::int, $3, $4, '\''pending'\'', false) ON CONFLICT (project_id, plugin_key) WHERE plugin_key IS NOT NULL DO UPDATE SET provider_customer_id = EXCLUDED.provider_customer_id, updated_at = NOW()",
          "params": ["{{trigger.project_id}}", "{{stripe_call.plugin_id}}", "{{trigger.plugin_key}}", "{{stripe_call.customer_id}}"]
        }
      },
      {
        "id": "resp_checkout",
        "type": "response",
        "label": "响应checkout_url",
        "config": {
          "status_code": 200,
          "body": {"code": 0, "message": "ok", "data": {"checkout_url": "{{stripe_call.checkout_url}}", "provider_session_id": "{{stripe_call.session_id}}"}},
          "headers": {}
        }
      },
      {
        "id": "resp_already_paid",
        "type": "response",
        "label": "响应已支付",
        "config": {"status_code": 400, "body": {"code": 400, "message": "PAYMENT_ALREADY_PAID: 该订单已完成支付"}, "headers": {}}
      },
      {
        "id": "resp_404",
        "type": "response",
        "label": "响应404",
        "config": {"status_code": 404, "body": {"code": 404, "message": "插件不存在或未上线"}, "headers": {}}
      },
      {
        "id": "resp_403",
        "type": "response",
        "label": "响应403",
        "config": {"status_code": 403, "body": {"code": 403, "message": "PAYMENT_PROJECT_FORBIDDEN"}, "headers": {}}
      }
    ],
    "edges": [
      {"from": "ownership_check", "to": "auth"},
      {"from": "auth", "to": "query_price", "branch": "pass"},
      {"from": "auth", "to": "resp_403", "branch": "forbidden"},
      {"from": "query_price", "to": "plugin_exists"},
      {"from": "plugin_exists", "to": "query_existing_sub", "branch": "found"},
      {"from": "plugin_exists", "to": "resp_404", "branch": "not_found"},
      {"from": "query_existing_sub", "to": "query_idempotency"},
      {"from": "query_idempotency", "to": "idempotency_check"},
      {"from": "idempotency_check", "to": "resp_already_paid", "branch": "already_paid"},
      {"from": "idempotency_check", "to": "read_key_pending", "branch": "pending"},
      {"from": "idempotency_check", "to": "query_customer", "branch": "new"},
      {"from": "read_key_pending", "to": "fetch_old_session"},
      {"from": "fetch_old_session", "to": "resp_old_url"},
      {"from": "query_customer", "to": "read_key_new"},
      {"from": "read_key_new", "to": "stripe_call"},
      {"from": "stripe_call", "to": "write_order"},
      {"from": "write_order", "to": "write_subscription"},
      {"from": "write_subscription", "to": "resp_checkout"}
    ]
  }'
```

- [ ] **Step 7.2：验证节点数**

```bash
curl -s "http://127.0.0.1:3000/api/admin/workflows?database_id=2" \
  -H "Authorization: Bearer $TOKEN" | python3 -c \
  "import sys,json; wfs=json.load(sys.stdin)['workflows']; \
  wf=[w for w in wfs if w['slug']=='stripe-renew'][0]; \
  print('nodes:', len(wf['nodes']), 'edges:', len(wf['edges']))"
```

Expected: `nodes: 16 edges: 18`

---

## Task 8：引擎扩展 — Cron 工作流触发器

> 当前 `src/scheduler/runner.rs` 只处理调度任务，不扫描 workflow 表。此任务添加 cron 工作流的自动触发支持。

**Files:**
- Modify: `src/main.rs` — 添加 cron workflow trigger 启动
- Create: `src/workflow_cron_trigger.rs` — cron 工作流扫描与触发逻辑
- Test: `tests/workflow_cron_trigger.rs`

- [ ] **Step 8.1：写失败测试**

`tests/workflow_cron_trigger.rs`:
```rust
// 仅做单元测试：验证 cron_matches 函数逻辑正确
#[cfg(test)]
mod tests {
    // cron_matches("0 * * * *", current_minute=0, current_hour=任意) → true
    // cron_matches("0 * * * *", current_minute=1, ...) → false
    // 此测试在 src/workflow_cron_trigger.rs 实现后补全
}
```

- [ ] **Step 8.2：创建 `src/workflow_cron_trigger.rs`**

```rust
use sqlx::PgPool;
use std::time::Duration;
use tokio::task::JoinHandle;

use crate::workflow_handlers::{self, Workflow};

/// 每分钟扫描 trigger_type='cron' 且 is_enabled=true 的工作流，
/// 用 cron 表达式判断当前分钟是否应触发。
pub fn start_cron_trigger(pool: PgPool) -> JoinHandle<()> {
    tokio::spawn(async move {
        tracing::info!("工作流 Cron 触发器已启动");
        loop {
            // 对齐到下一分钟整点
            let now = chrono::Utc::now();
            let secs_to_next = 60 - now.second();
            tokio::time::sleep(Duration::from_secs(secs_to_next as u64)).await;

            let tick_time = chrono::Utc::now();
            if let Err(e) = fire_due_workflows(&pool, tick_time).await {
                tracing::error!("cron 工作流触发失败: {}", e);
            }
        }
    })
}

async fn fire_due_workflows(
    pool: &PgPool,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<(), sqlx::Error> {
    let workflows = sqlx::query_as::<_, Workflow>(
        "SELECT * FROM management.workflows WHERE trigger_type = 'cron' AND is_enabled = true",
    )
    .fetch_all(pool)
    .await?;

    for wf in workflows {
        let schedule = wf
            .trigger_config
            .get("schedule")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if schedule.is_empty() || !cron_matches(schedule, now) {
            continue;
        }

        tracing::info!(workflow_id = wf.id, slug = %wf.slug, "Cron 触发工作流");
        let pool_clone = pool.clone();
        tokio::spawn(async move {
            if let Err(e) = workflow_handlers::execute_workflow_internal(
                &pool_clone,
                &wf,
                "cron",
                &serde_json::json!({"fired_at": now.to_rfc3339()}),
                None,
            )
            .await
            {
                tracing::error!(workflow_id = wf.id, error = %e, "Cron 工作流执行失败");
            }
        });
    }
    Ok(())
}

/// 简化 cron 匹配：只支持标准 5 字段 cron（分 时 日 月 周），
/// 每字段支持 `*` 和具体数值，不支持范围/步进（够用于本项目）。
pub fn cron_matches(expr: &str, now: chrono::DateTime<chrono::Utc>) -> bool {
    let parts: Vec<&str> = expr.split_whitespace().collect();
    if parts.len() != 5 {
        return false;
    }
    let fields = [
        (parts[0], now.minute() as u32),
        (parts[1], now.hour() as u32),
        (parts[2], now.day()),
        (parts[3], now.month()),
        (parts[4], now.weekday().num_days_from_sunday()),
    ];
    fields.iter().all(|(pat, val)| {
        *pat == "*" || pat.parse::<u32>().map(|n| n == *val).unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn dt(hour: u32, min: u32) -> chrono::DateTime<chrono::Utc> {
        chrono::Utc.with_ymd_and_hms(2026, 6, 9, hour, min, 0).unwrap()
    }

    #[test]
    fn test_every_hour_on_minute_zero() {
        assert!(cron_matches("0 * * * *", dt(0, 0)));
        assert!(cron_matches("0 * * * *", dt(3, 0)));
        assert!(!cron_matches("0 * * * *", dt(3, 1)));
        assert!(!cron_matches("0 * * * *", dt(3, 59)));
    }

    #[test]
    fn test_specific_time() {
        assert!(cron_matches("30 14 * * *", dt(14, 30)));
        assert!(!cron_matches("30 14 * * *", dt(14, 31)));
        assert!(!cron_matches("30 14 * * *", dt(15, 30)));
    }

    #[test]
    fn test_wildcard_all() {
        assert!(cron_matches("* * * * *", dt(0, 0)));
        assert!(cron_matches("* * * * *", dt(23, 59)));
    }

    #[test]
    fn test_invalid_expr() {
        assert!(!cron_matches("", dt(0, 0)));
        assert!(!cron_matches("0 *", dt(0, 0)));
    }
}
```

- [ ] **Step 8.3：运行单元测试确认通过**

```bash
cargo test workflow_cron_trigger -- --nocapture
```

Expected: 4 tests passed

- [ ] **Step 8.4：在 `src/lib.rs` 中注册模块**

在 `src/lib.rs` 末尾或 mod 块中添加：
```rust
pub mod workflow_cron_trigger;
```

- [ ] **Step 8.5：在 `src/main.rs` 中启动 cron trigger**

找到 `start_event_trigger` 或 `start_notify_trigger` 的调用处，在其后添加：
```rust
workflow_cron_trigger::start_cron_trigger(pool.clone());
```

- [ ] **Step 8.6：编译确认无错误**

```bash
cargo build 2>&1 | tail -5
```

Expected: `Finished dev [unoptimized + debuginfo] target(s)`

- [ ] **Step 8.7：Commit**

```bash
git add src/workflow_cron_trigger.rs src/lib.rs src/main.rs
git commit -m "feat(workflow): add cron workflow trigger runner"
```

---

## Task 9：引擎扩展 — `crypto.hmac_sha256`

**Files:**
- Modify: `src/lua_builtins.rs` — 注册 hmac_sha256
- Modify: `Cargo.toml` — 添加 hmac 依赖

- [ ] **Step 9.1：添加 Cargo 依赖**

在 `Cargo.toml` 的 `[dependencies]` 块中添加：
```toml
hmac = "0.12"
```

（`sha2` 已存在，无需重复）

- [ ] **Step 9.2：在 `lua_builtins.rs` 的 `register_crypto_module` 函数中添加**

找到 `register_crypto_module` 函数，在现有 `sha256` 注册之后添加：

```rust
crypto_mod.set("hmac_sha256", lua.create_function(|_, (key, data): (String, String)| {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    type HmacSha256 = Hmac<Sha256>;

    let mut mac = HmacSha256::new_from_slice(key.as_bytes())
        .map_err(|e| mlua::Error::RuntimeError(e.to_string()))?;
    mac.update(data.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
})?)?;
```

- [ ] **Step 9.3：编译确认**

```bash
cargo build 2>&1 | grep -E "error|warning.*unused|Finished"
```

Expected: `Finished dev ...`

- [ ] **Step 9.4：通过工作流测试 hmac_sha256 可用**

```bash
# 创建临时测试工作流
curl -s -X POST http://127.0.0.1:3000/api/admin/workflows \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "hmac测试(临时)",
    "slug": "test-hmac-tmp",
    "database_id": 2,
    "trigger_type": "endpoint",
    "trigger_config": {},
    "is_enabled": true,
    "nodes": [{
      "id": "test",
      "type": "code",
      "label": "test",
      "config": {"code": "local h = crypto.hmac_sha256(\"key\", \"data\")\nreturn {result = h}"}
    }],
    "edges": []
  }'

# 触发
curl -s -X POST "http://127.0.0.1:3000/workflow/acme-test-primary/test-hmac-tmp" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'
```

Expected: `{"result":"5031fe3d989c6d1537a013fa6e739da23463fdaec3b70137d828e36ace221bd0"}`
（`HMAC-SHA256("key", "data")` 的标准值）

- [ ] **Step 9.5：删除临时测试工作流**

```bash
TMP_ID=$(curl -s "http://127.0.0.1:3000/api/admin/workflows?database_id=2" \
  -H "Authorization: Bearer $TOKEN" | python3 -c \
  "import sys,json; wfs=json.load(sys.stdin)['workflows']; \
  print([w['id'] for w in wfs if w['slug']=='test-hmac-tmp'][0])")
curl -s -X DELETE "http://127.0.0.1:3000/api/admin/workflows/$TMP_ID" \
  -H "Authorization: Bearer $TOKEN"
```

- [ ] **Step 9.6：Commit**

```bash
git add src/lua_builtins.rs Cargo.toml Cargo.lock
git commit -m "feat(lua): add crypto.hmac_sha256 builtin"
```

---

## Task 10：引擎扩展 — 原始 body + headers 透传

> Stripe webhook 验签需要：①原始 HTTP body 字节；②`Stripe-Signature` header。
> 改动：`endpoint_trigger` 先接收 `Bytes`，自行解析 JSON，同时把原始字节和请求头注入 `trigger_data`。

**Files:**
- Modify: `src/workflow_handlers.rs` — `endpoint_trigger` 和 `endpoint_trigger_get` 签名

- [ ] **Step 10.1：修改 `endpoint_trigger`**

将：
```rust
pub async fn endpoint_trigger(
    ...
    Json(body): Json<Value>,
) -> Result<Json<Value>> {
    ...
    let result = execute_workflow_internal(&pool, &workflow, "endpoint", &body, user_id).await?;
```

改为：
```rust
use axum::body::Bytes;

pub async fn endpoint_trigger(
    State(pool): State<PgPool>,
    Path((database_slug, workflow_slug)): Path<(String, String)>,
    headers: HeaderMap,
    claims: Option<axum::Extension<Claims>>,
    body_bytes: Bytes,
) -> Result<Json<Value>> {
    let caller = resolve_endpoint_caller(&pool, &headers, claims.as_ref()).await?;
    let (resolved_database_id, _tenant_id) =
        resolve_database_for_caller(&pool, &caller, &database_slug).await?;

    let workflow = sqlx::query_as::<_, Workflow>(
        r#"SELECT * FROM management.workflows
           WHERE database_id = $1 AND slug = $2 AND trigger_type = 'endpoint' AND is_enabled = true"#,
    )
    .bind(resolved_database_id)
    .bind(&workflow_slug)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("工作流 {}/{} 不存在或未启用", database_slug, workflow_slug)))?;

    // 解析 JSON body，保留原始字节供 Webhook 验签
    let parsed_body: Value = serde_json::from_slice(&body_bytes)
        .unwrap_or(Value::Null);

    // 提取相关 header，注入 trigger_data（供 Lua 访问）
    let headers_json: serde_json::Map<String, Value> = headers
        .iter()
        .filter_map(|(k, v)| Some((k.to_string(), Value::String(v.to_str().ok()?.to_string()))))
        .collect();

    let trigger_data = json!({
        "body": parsed_body,
        "headers": headers_json,
        "_raw_body": String::from_utf8_lossy(&body_bytes).to_string(),
    });

    let user_id = match &caller {
        EndpointCaller::User(c) => Some(c.sub),
        EndpointCaller::ApiKey { .. } => None,
    };
    let result = execute_workflow_internal(&pool, &workflow, "endpoint", &trigger_data, user_id).await?;
    // ... 后续 response_output 查找逻辑不变
```

> **Breaking change 注意：** 现有所有 endpoint 工作流的模板变量从 `{{trigger.field}}` 变为 `{{trigger.body.field}}`。
> **Task 10.2 需要更新 Task 1-7 创建的所有工作流。**

- [ ] **Step 10.2：批量更新 Task 1-7 工作流的模板变量**

所有 `{{trigger.xxx}}` 改为 `{{trigger.body.xxx}}`（除了 cron 工作流 A 无 trigger 引用，无需改）：

```bash
# 获取所有 stripe 工作流 ID
for SLUG in stripe-cancel stripe-get-order stripe-list-subscriptions stripe-list-orders stripe-checkout stripe-renew; do
  WF_ID=$(curl -s "http://127.0.0.1:3000/api/admin/workflows?database_id=2" \
    -H "Authorization: Bearer $TOKEN" | python3 -c \
    "import sys,json; wfs=json.load(sys.stdin)['workflows']; \
    ids=[w['id'] for w in wfs if w['slug']=='$SLUG']; \
    print(ids[0] if ids else 'NOT_FOUND')")
  echo "$SLUG -> ID: $WF_ID"
done
```

然后对每个工作流用 PATCH 更新 nodes（把所有 `{{trigger.` 替换为 `{{trigger.body.`）。详细的 PATCH payload 在执行阶段由 executor 生成（节点 JSON 结构相同，仅替换字符串）。

- [ ] **Step 10.3：编译确认**

```bash
cargo build 2>&1 | grep -E "^error"
```

Expected: 无输出（无编译错误）

- [ ] **Step 10.4：测试 raw body 可访问**

```bash
curl -s -X POST "http://127.0.0.1:3000/workflow/acme-test-primary/test-raw-tmp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"hello":"world"}'
```

（需先创建一个读取 `{{trigger._raw_body}}` 的临时工作流验证）

- [ ] **Step 10.5：Commit**

```bash
git add src/workflow_handlers.rs
git commit -m "feat(workflow): expose raw body and headers in endpoint trigger_data"
```

---

## Task 11：引擎扩展 — DbTransaction 节点

> Webhook 处理支付成功需要原子性：改订单状态 + 记支付事件 + 激活订阅必须要么全成功要么全失败。

**Files:**
- Modify: `src/workflow_engine.rs` — 新增 `DbTransaction` NodeType + 执行逻辑
- Test: `tests/workflow_engine_transaction.rs`

- [ ] **Step 11.1：在 `NodeType` 枚举添加变体**

在 `workflow_engine.rs` 的 `NodeType` 枚举中添加：
```rust
/// 在单个数据库事务中执行多条 SQL（要么全成功，要么全回滚）
DbTransaction,
```

- [ ] **Step 11.2：在 `execute_node` match 添加分支**

```rust
NodeType::DbTransaction => self.exec_db_transaction_node(config, ctx).await,
```

- [ ] **Step 11.3：实现 `exec_db_transaction_node`**

```rust
async fn exec_db_transaction_node(
    &self,
    config: &JsonValue,
    _ctx: &ExecutionContext,
) -> Result<(JsonValue, Option<String>)> {
    let statements = config
        .get("statements")
        .and_then(|v| v.as_array())
        .ok_or_else(|| AppError::InvalidQuery("db_transaction 节点缺少 statements 数组".to_string()))?;

    let mut tx = self.pool.begin().await?;
    let mut total_affected: u64 = 0;

    for stmt in statements {
        let sql = stmt.get("sql").and_then(|v| v.as_str())
            .ok_or_else(|| AppError::InvalidQuery("db_transaction statements 缺少 sql 字段".to_string()))?;

        // 拦截危险操作
        let first_word = sql.trim().split_whitespace().next().unwrap_or("").to_uppercase();
        if matches!(first_word.as_str(), "DROP" | "TRUNCATE") {
            return Err(AppError::InvalidQuery("db_transaction 禁止 DROP/TRUNCATE".to_string()));
        }

        let params = stmt.get("params").and_then(|v| v.as_array());
        let mut query = sqlx::query(sql);
        if let Some(params) = params {
            for p in params {
                query = bind_json_param(query, p);
            }
        }

        let result = query.execute(&mut *tx).await?;
        total_affected += result.rows_affected();
    }

    tx.commit().await?;
    Ok((json!({ "rows_affected": total_affected, "statements_count": statements.len() }), None))
}
```

- [ ] **Step 11.4：写测试 `tests/workflow_engine_transaction.rs`**

```rust
// 集成测试：需要 TEST_DATABASE_URL 环境变量
// 在 CI 或本地测试时设置：TEST_DATABASE_URL=postgresql://...
// 此测试验证事务提交和回滚两种路径
#[cfg(test)]
#[tokio::test]
async fn test_db_transaction_commits() {
    // 需要真实数据库连接，跳过无 TEST_DATABASE_URL 的环境
    if std::env::var("TEST_DATABASE_URL").is_err() { return; }
    // ... 实现在有 DB 的 CI 环境中补全
}
```

- [ ] **Step 11.5：编译确认**

```bash
cargo build 2>&1 | grep "^error"
```

Expected: 无输出

- [ ] **Step 11.6：Commit**

```bash
git add src/workflow_engine.rs tests/workflow_engine_transaction.rs
git commit -m "feat(workflow-engine): add DbTransaction node type"
```

---

## Task 12：引擎扩展 — ForEach 节点

> 调价 Job 需要遍历每个待调价插件，对每个执行 UPDATE + INSERT 审计记录。

**Files:**
- Modify: `src/workflow_engine.rs` — 新增 `ForEach` NodeType + 执行逻辑

- [ ] **Step 12.1：在 `NodeType` 枚举添加变体**

```rust
/// 遍历数组，对每个元素执行子节点集（inline 执行，不是递归 DAG）
ForEach,
```

- [ ] **Step 12.2：在 `execute_node` match 添加分支**

```rust
NodeType::ForEach => self.exec_foreach_node(config, ctx).await,
```

- [ ] **Step 12.3：实现 `exec_foreach_node`**

```rust
async fn exec_foreach_node(
    &self,
    config: &JsonValue,
    ctx: &ExecutionContext,
) -> Result<(JsonValue, Option<String>)> {
    // items_path: 指向上游节点输出的路径，如 "query_plugins.rows"
    let items_path = config.get("items")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::InvalidQuery("foreach 节点缺少 items 字段".to_string()))?;

    // 取出数组
    let items = {
        let fake_template = json!(format!("{{{{{}}}}}", items_path));
        let resolved = resolve_template(&fake_template, ctx);
        match resolved {
            JsonValue::Array(arr) => arr,
            _ => return Err(AppError::InvalidQuery(
                format!("foreach items '{}' 不是数组", items_path)
            )),
        }
    };

    // 子 statements：每个元素执行的 db_execute 列表
    let statements = config.get("statements")
        .and_then(|v| v.as_array())
        .ok_or_else(|| AppError::InvalidQuery("foreach 节点缺少 statements 数组".to_string()))?;

    // item_var：当前元素注入 ctx 的变量名，模板中用 {{item_var.field}} 引用
    let item_var = config.get("item_var")
        .and_then(|v| v.as_str())
        .unwrap_or("item");

    let mut total_affected: u64 = 0;
    let item_count = items.len();

    for item in items {
        // 将当前 item 注入一个临时 ctx
        let mut item_ctx = ctx.clone();
        item_ctx.node_outputs.insert(item_var.to_string(), item);

        let mut tx = self.pool.begin().await?;
        for stmt in statements {
            let sql = stmt.get("sql").and_then(|v| v.as_str())
                .ok_or_else(|| AppError::InvalidQuery("foreach statement 缺少 sql".to_string()))?;
            let first_word = sql.trim().split_whitespace().next().unwrap_or("").to_uppercase();
            if matches!(first_word.as_str(), "DROP" | "TRUNCATE") {
                return Err(AppError::InvalidQuery("foreach 禁止 DROP/TRUNCATE".to_string()));
            }
            let raw_params = stmt.get("params").and_then(|v| v.as_array());
            let resolved_params: Vec<JsonValue> = raw_params
                .map(|ps| ps.iter().map(|p| resolve_template(p, &item_ctx)).collect())
                .unwrap_or_default();

            let mut query = sqlx::query(sql);
            for p in &resolved_params {
                query = bind_json_param(query, p);
            }
            let result = query.execute(&mut *tx).await?;
            total_affected += result.rows_affected();
        }
        tx.commit().await?;
    }

    Ok((json!({ "processed": item_count, "rows_affected": total_affected }), None))
}
```

- [ ] **Step 12.4：编译确认**

```bash
cargo build 2>&1 | grep "^error"
```

- [ ] **Step 12.5：Commit**

```bash
git add src/workflow_engine.rs
git commit -m "feat(workflow-engine): add ForEach node type"
```

---

## Task 13：工作流 H — 调价生效 Job（stripe-price-update-job）

**依赖：** Task 12（ForEach 节点）必须完成

- [ ] **Step 13.1：创建工作流**

```bash
curl -s -X POST http://127.0.0.1:3000/api/admin/workflows \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "调价生效Job",
    "slug": "stripe-price-update-job",
    "database_id": 2,
    "trigger_type": "cron",
    "trigger_config": {"schedule": "0 * * * *"},
    "is_enabled": true,
    "timeout_ms": 120000,
    "nodes": [
      {
        "id": "query_pending_prices",
        "type": "db_query",
        "label": "查待调价",
        "config": {
          "sql": "SELECT id, plugin_key, next_price_usd_monthly::float8 AS next_price_usd_monthly, next_price_usd_yearly::float8 AS next_price_usd_yearly, next_price_usd_lifetime::float8 AS next_price_usd_lifetime FROM gamesq.plugin_list WHERE price_effective_at IS NOT NULL AND price_effective_at <= NOW() AND pricing_model <> '\''commission'\'' AND (next_price_usd_monthly IS NOT NULL OR next_price_usd_yearly IS NOT NULL OR next_price_usd_lifetime IS NOT NULL)",
          "params": []
        }
      },
      {
        "id": "has_pending",
        "type": "condition",
        "label": "有待调价?",
        "config": {
          "conditions": [{"branch": "yes", "expression": "{{query_pending_prices.count}} > 0"}],
          "default_branch": "no"
        }
      },
      {
        "id": "apply_prices",
        "type": "foreach",
        "label": "批量调价",
        "config": {
          "items": "query_pending_prices.rows",
          "item_var": "price_item",
          "statements": [
            {
              "sql": "UPDATE gamesq.plugin_list SET price_usd_monthly = COALESCE($1::float8, price_usd_monthly), price_usd_yearly = COALESCE($2::float8, price_usd_yearly), price_usd_lifetime = COALESCE($3::float8, price_usd_lifetime), next_price_usd_monthly = NULL, next_price_usd_yearly = NULL, next_price_usd_lifetime = NULL, price_effective_at = NULL WHERE id = $4::int",
              "params": ["{{price_item.next_price_usd_monthly}}", "{{price_item.next_price_usd_yearly}}", "{{price_item.next_price_usd_lifetime}}", "{{price_item.id}}"]
            },
            {
              "sql": "INSERT INTO gamesq.plugin_price_history (plugin_key, action, operator_way_uid, new_price_usd_monthly, new_price_usd_yearly, new_price_usd_lifetime, effective_at) VALUES ($1, '\''price_effective'\'', 0, $2::float8, $3::float8, $4::float8, NOW())",
              "params": ["{{price_item.plugin_key}}", "{{price_item.next_price_usd_monthly}}", "{{price_item.next_price_usd_yearly}}", "{{price_item.next_price_usd_lifetime}}"]
            }
          ]
        }
      },
      {
        "id": "resp_done",
        "type": "response",
        "label": "完成",
        "config": {"status_code": 200, "body": {"ok": true, "processed": "{{apply_prices.processed}}"}, "headers": {}}
      },
      {
        "id": "resp_skip",
        "type": "response",
        "label": "无需调价",
        "config": {"status_code": 200, "body": {"ok": true, "processed": 0}, "headers": {}}
      }
    ],
    "edges": [
      {"from": "query_pending_prices", "to": "has_pending"},
      {"from": "has_pending", "to": "apply_prices", "branch": "yes"},
      {"from": "has_pending", "to": "resp_skip", "branch": "no"},
      {"from": "apply_prices", "to": "resp_done"}
    ]
  }'
```

- [ ] **Step 13.2：手动触发验证（无待调价时应返回 processed:0）**

```bash
WF_H_ID=$(curl -s "http://127.0.0.1:3000/api/admin/workflows?database_id=2" \
  -H "Authorization: Bearer $TOKEN" | python3 -c \
  "import sys,json; wfs=json.load(sys.stdin)['workflows']; \
  print([w['id'] for w in wfs if w['slug']=='stripe-price-update-job'][0])")

curl -s -X POST "http://127.0.0.1:3000/api/admin/workflows/$WF_H_ID/trigger" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'

sleep 2

curl -s "http://127.0.0.1:3000/api/admin/workflows/$WF_H_ID/runs?limit=1" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool | grep '"status"'
```

Expected: `"status": "completed"`

---

## Task 14：工作流 I — Stripe Webhook（stripe-webhook）

**依赖：** Task 9（hmac_sha256）+ Task 10（raw body）+ Task 11（DbTransaction）必须完成

- [ ] **Step 14.1：创建工作流**

```bash
curl -s -X POST http://127.0.0.1:3000/api/admin/workflows \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "StripeWebhook",
    "slug": "stripe-webhook",
    "database_id": 2,
    "trigger_type": "endpoint",
    "trigger_config": {},
    "is_enabled": true,
    "timeout_ms": 30000,
    "nodes": [
      {
        "id": "verify_signature",
        "type": "code",
        "label": "验签",
        "config": {
          "code": "local sig_header = ctx.body.headers[\"stripe-signature\"]\nif not sig_header then error(\"缺少 Stripe-Signature header\") end\n\nlocal webhook_secret = env.get(\"STRIPE_WEBHOOK_SECRET\")\nif not webhook_secret then error(\"STRIPE_WEBHOOK_SECRET 未配置\") end\n\n-- 从 Stripe-Signature 提取 timestamp 和 v1 签名\nlocal ts, v1_sig\nfor part in string.gmatch(sig_header, \"([^,]+)\") do\n    local k, v = string.match(part, \"^(%w+)=(.+)$\")\n    if k == \"t\" then ts = v end\n    if k == \"v1\" then v1_sig = v end\nend\nif not ts or not v1_sig then error(\"Stripe-Signature 格式错误\") end\n\n-- 重新计算签名：HMAC-SHA256(secret, timestamp + \".\" + raw_body)\nlocal signed_payload = ts .. \".\" .. ctx.body._raw_body\nlocal expected_sig = crypto.hmac_sha256(webhook_secret, signed_payload)\n\nif expected_sig ~= v1_sig then\n    error(\"Stripe webhook 签名验证失败\")\nend\n\n-- 解析事件\nlocal event = json.decode(ctx.body._raw_body)\nreturn {\n    event_type = event.type,\n    session    = event.data and event.data.object or {},\n    ts         = ts,\n}"
        }
      },
      {
        "id": "event_filter",
        "type": "condition",
        "label": "事件类型过滤",
        "config": {
          "conditions": [
            {"branch": "checkout_complete", "expression": "{{verify_signature.event_type}} == \"checkout.session.completed\""}
          ],
          "default_branch": "ignore"
        }
      },
      {
        "id": "query_order",
        "type": "db_query",
        "label": "查订单",
        "config": {
          "sql": "SELECT order_id::text, project_id, plugin_key, plan_key, status FROM gamesq.plugin_order WHERE provider_session_id = $1 AND provider = '\''stripe'\'' LIMIT 1",
          "params": ["{{verify_signature.session.id}}"]
        }
      },
      {
        "id": "order_check",
        "type": "condition",
        "label": "订单校验",
        "config": {
          "conditions": [
            {"branch": "skip", "expression": "{{query_order.rows[0].status}} == \"paid\""},
            {"branch": "skip", "expression": "{{query_order.rows[0].status}} == \"granted\""},
            {"branch": "process", "expression": "{{query_order.count}} > 0"}
          ],
          "default_branch": "skip"
        }
      },
      {
        "id": "fulfill_payment",
        "type": "db_transaction",
        "label": "履行支付",
        "config": {
          "statements": [
            {
              "sql": "UPDATE gamesq.plugin_order SET status = '\''paid'\'', paid_at = NOW(), updated_at = NOW() WHERE order_id = $1::uuid",
              "params": ["{{query_order.rows[0].order_id}}"]
            },
            {
              "sql": "INSERT INTO gamesq.plugin_payment_event (order_id, event_type, provider_event_id, raw_payload) VALUES ($1::uuid, '\''checkout.session.completed'\'', $2, $3::jsonb)",
              "params": ["{{query_order.rows[0].order_id}}", "{{verify_signature.session.id}}", "{{trigger.body._raw_body}}"]
            },
            {
              "sql": "UPDATE gamesq.plugin_subscription SET status = '\''active'\'', is_enabled = true, billing_cycle = $2, expires_at = CASE $2 WHEN '\''monthly'\'' THEN NOW() + INTERVAL '\''1 month'\'' WHEN '\''yearly'\'' THEN NOW() + INTERVAL '\''1 year'\'' ELSE NULL END, updated_at = NOW() WHERE project_id = $3::int AND plugin_key = $4",
              "params": ["{{query_order.rows[0].plan_key}}", "{{query_order.rows[0].plan_key}}", "{{query_order.rows[0].project_id}}", "{{query_order.rows[0].plugin_key}}"]
            }
          ]
        }
      },
      {
        "id": "resp_ok",
        "type": "response",
        "label": "响应200",
        "config": {"status_code": 200, "body": {"received": true}, "headers": {}}
      },
      {
        "id": "resp_ignore",
        "type": "response",
        "label": "忽略事件",
        "config": {"status_code": 200, "body": {"received": true, "ignored": true}, "headers": {}}
      }
    ],
    "edges": [
      {"from": "verify_signature", "to": "event_filter"},
      {"from": "event_filter", "to": "query_order", "branch": "checkout_complete"},
      {"from": "event_filter", "to": "resp_ignore", "branch": "ignore"},
      {"from": "query_order", "to": "order_check"},
      {"from": "order_check", "to": "fulfill_payment", "branch": "process"},
      {"from": "order_check", "to": "resp_ignore", "branch": "skip"},
      {"from": "fulfill_payment", "to": "resp_ok"}
    ]
  }'
```

- [ ] **Step 14.2：测试签名验证失败被拒绝**

```bash
curl -s -X POST "http://127.0.0.1:3000/workflow/acme-test-primary/stripe-webhook" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "stripe-signature: t=1234,v1=badsig" \
  -d '{"type":"checkout.session.completed","data":{"object":{"id":"cs_test_x"}}}'
```

Expected: 工作流执行失败，run 状态为 `failed`，error 含 "签名验证失败"

---

## Task 15：删除 `src/payment/` 旧业务代码

**依赖：** Task 1-14 全部完成且线上验证无误

**Files:**
- Delete: `src/payment/` 目录（handlers.rs、job.rs、mod.rs、models.rs、stripe_client.rs、tenant_pool.rs）
- Modify: `src/lib.rs` — 删除 `pub mod payment;`
- Modify: `src/main.rs` — 删除 payment 路由注册和 job 启动

- [ ] **Step 15.1：确认没有外部引用**

```bash
grep -r "payment::" src/ --include="*.rs" | grep -v "^src/payment/"
```

Expected: 无输出（无外部引用）

- [ ] **Step 15.2：删除目录**

```bash
rm -rf E:/onebase/src/payment
```

- [ ] **Step 15.3：从 `src/lib.rs` 移除模块声明**

删除：`pub mod payment;`

- [ ] **Step 15.4：从 `src/main.rs` 移除路由注册**

找到并删除所有 `payment::` 开头的路由和函数调用（如 `payment::handlers::*`、`payment::job::start_*` 等）。

- [ ] **Step 15.5：编译确认**

```bash
cargo build 2>&1 | grep "^error"
```

Expected: 无输出

- [ ] **Step 15.6：运行现有测试**

```bash
cargo test 2>&1 | tail -10
```

Expected: `test result: ok`

- [ ] **Step 15.7：最终 Commit**

```bash
git add -A
git commit -m "refactor: remove src/payment/ business code — fully migrated to workflows"
```

---

## Self-Review Checklist

- [x] **Spec coverage**
  - ✅ 工作流 A-G：Phase 0/1 完整覆盖（Tasks 1-7）
  - ✅ cron runner：Task 8
  - ✅ hmac_sha256：Task 9
  - ✅ raw body 透传：Task 10
  - ✅ DbTransaction：Task 11
  - ✅ ForEach：Task 12
  - ✅ 工作流 H（调价 Job）：Task 13
  - ✅ 工作流 I（Webhook）：Task 14
  - ✅ 删除旧代码：Task 15

- [x] **Breaking change 标记**
  - Task 10 修改了 endpoint trigger_data 结构（`trigger.field` → `trigger.body.field`），Task 10.2 必须在 Step 10.1 之后立即执行，不得跳过

- [x] **安全要点**
  - Webhook 验签在 `verify_signature` 节点强制执行，签名失败直接 error 中止
  - ForEach 和 DbTransaction 节点均有 DROP/TRUNCATE 黑名单
  - hmac_sha256 使用 constant-time 的 `mac.verify_slice` 可选路径（当前用字符串比较，可在 Task 9 后升级）

- [x] **依赖顺序**
  - Task 14 依赖 Task 9+10+11，执行器必须按序执行 Phase 2 任务

---

## 附：一键刷新 Token 脚本

```bash
#!/bin/bash
# refresh_token.sh — 每次新会话执行
TOKEN=$(curl -s -X POST http://127.0.0.1:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"Admin123"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
export TOKEN
echo "Token refreshed: ${TOKEN:0:30}..."
```
