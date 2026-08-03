# Kafka Workflow Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 租户可登记 Kafka 连接；工作流可用 `kafka` 节点 produce；可用 `trigger_type=kafka` 常驻消费并 at-least-once 触发工作流。

**Architecture:** 对齐 Redis 连接注册表（`management.kafka_connections` + `kafka_ds` + handlers）与 `workflow_notify_trigger` 常驻管理任务。Producer 按 connection_id 缓存；Consumer 由触发器按 `(connection_id, topic, group_id)` 启停。消息处理直接 `await execute_workflow_internal`，成功后再 commit offset。

**Tech Stack:** Rust / Axum / SQLx / rdkafka（tokio），Next.js / React / TypeScript，PostgreSQL。

**Spec:** `docs/superpowers/specs/2026-07-21-kafka-workflow-integration-design.md`

## Global Constraints

- 连接走租户级注册表，**不**进 `wf_datasources`
- 认证首期：`PLAINTEXT` / `SASL_PLAINTEXT` / `SASL_SSL` / `SSL` + `PLAIN` | `SCRAM-SHA-256` | `SCRAM-SHA-512`；**无 mTLS**
- 投递：at-least-once（工作流 `Ok` 后才 commit）
- 节点 op 仅 `produce`；管理页提供 health + `list_topics`
- 密码 `crypto::encrypt_secret`，`#[serde(skip_serializing)]`，API 只暴露 `has_password`
- 迁移序号：`047_kafka_connections.sql`（接在 `046_redis_connections` 之后）
- 验证：`cargo check` / 相关 `cargo test`；前端 `npx tsc --noEmit`（在 `frontend-nextjs`）
- 沙箱若编译失败用 `required_permissions: ["all"]`，复用默认 `target`

---

## File Structure

| Path | Responsibility |
|---|---|
| `migrations/047_kafka_connections.sql` | 表定义 |
| `src/migrate.rs` | 注册迁移 |
| `src/kafka_ds/mod.rs` | `fetch_active` / `fetch_active_for_tenant` |
| `src/kafka_ds/models.rs` | `KafkaConnection` |
| `src/kafka_ds/client_cache.rs` | FutureProducer 缓存 + invalidate |
| `src/kafka_ds/commands.rs` | `produce` / `list_topics` / `health_probe` |
| `src/kafka_ds/trigger_config.rs` | 解析 workflow `trigger_config` + 组装 `trigger_data`（纯函数，可测） |
| `src/kafka_handlers.rs` | CRUD / health / topics / exec（bin） |
| `src/workflow_kafka_trigger.rs` | 常驻 consumer 管理（bin） |
| `src/workflow_engine.rs` | `NodeType::Kafka` + `exec_kafka_node` |
| `src/workflow_handlers.rs` + `src/mcp_tools.rs` | 允许 `trigger_type=kafka` |
| `src/lib.rs` / `src/main.rs` | 模块与路由、启动 trigger |
| `Cargo.toml` | `rdkafka` 依赖 |
| `frontend-nextjs/lib/api.ts` | `kafkaAPI` |
| `frontend-nextjs/app/workspace/[projectId]/events/kafka-connections/page.tsx` | 管理页 |
| `frontend-nextjs/components/workspace/workspaceNav.ts` | 导航 |
| `frontend-nextjs/components/workflow/*` | 节点 + 触发器 UI |

---

### Task 1: Migration + Cargo dep

**Files:**
- Create: `migrations/047_kafka_connections.sql`
- Modify: `src/migrate.rs`（在 `046 redis connections` 之后）
- Modify: `Cargo.toml`

**Interfaces:**
- Produces: table `management.kafka_connections`; crate dep `rdkafka`

- [ ] **Step 1: Write migration**

Create `migrations/047_kafka_connections.sql`:

```sql
-- Kafka 数据源：租户登记 broker，供管理 API / kafka 节点 / kafka 触发器共用。
-- 对齐 046_redis_connections.sql：租户隔离、密钥 AES-GCM、is_active 软停用。

CREATE TABLE IF NOT EXISTS management.kafka_connections (
    id                        BIGSERIAL PRIMARY KEY,
    tenant_id                 INTEGER NOT NULL
                              REFERENCES management.tenants(id) ON DELETE CASCADE,
    connection_name           VARCHAR(100) NOT NULL,
    brokers                   TEXT NOT NULL,
    security_protocol         TEXT NOT NULL DEFAULT 'PLAINTEXT'
                              CHECK (security_protocol IN (
                                  'PLAINTEXT', 'SASL_PLAINTEXT', 'SASL_SSL', 'SSL'
                              )),
    sasl_mechanism            TEXT
                              CHECK (sasl_mechanism IS NULL OR sasl_mechanism IN (
                                  'PLAIN', 'SCRAM-SHA-256', 'SCRAM-SHA-512'
                              )),
    sasl_username             TEXT,
    sasl_password_enc         TEXT,
    tls_insecure_skip_verify  BOOLEAN NOT NULL DEFAULT false,
    connect_timeout_secs      INTEGER NOT NULL DEFAULT 5
                              CHECK (connect_timeout_secs BETWEEN 1 AND 60),
    is_active                 BOOLEAN NOT NULL DEFAULT true,
    created_by                INTEGER NOT NULL
                              REFERENCES users(id) ON DELETE RESTRICT,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_kafka_conn_name UNIQUE (tenant_id, connection_name),
    CONSTRAINT chk_kafka_conn_brokers CHECK (brokers ~ '^[^[:space:]]')
);

CREATE INDEX IF NOT EXISTS idx_kafka_connections_tenant
    ON management.kafka_connections(tenant_id)
    WHERE is_active;
```

- [ ] **Step 2: Register migration**

In `src/migrate.rs`, after the `046 redis connections` entry:

```rust
    ("046 redis connections", include_str!("../migrations/046_redis_connections.sql")),
    ("047 kafka connections", include_str!("../migrations/047_kafka_connections.sql")),
```

- [ ] **Step 3: Add rdkafka**

In `Cargo.toml` dependencies:

```toml
# Kafka 数据源（工作流 produce + kafka 触发器）
rdkafka = { version = "0.36", features = ["cmake-build", "ssl", "sasl"] }
```

若本机无 cmake/libsasl2 导致编译失败，可改为 `features = ["cmake-build"]` 先跑通 PLAINTEXT，再在 README/注释标明 SASL 需系统库；优先尝试完整 features。

- [ ] **Step 4: Verify**

Run: `cargo check`
Expected: PASS（或仅 rdkafka 系统依赖错误——此时按 Step 3 降级 features 后重试）

- [ ] **Step 5: Commit**

```bash
git add migrations/047_kafka_connections.sql src/migrate.rs Cargo.toml Cargo.lock
git commit -m "feat(kafka): add kafka_connections migration and rdkafka dep"
```

---

### Task 2: `kafka_ds` models + fetch + trigger_config 纯函数（TDD）

**Files:**
- Create: `src/kafka_ds/mod.rs`, `models.rs`, `trigger_config.rs`
- Modify: `src/lib.rs`（`pub mod kafka_ds;`）
- Modify: `src/main.rs`（`mod kafka_ds;` 与 redis_ds 并列）

**Interfaces:**
- Produces:
  - `KafkaConnection` struct (fields per migration; `sasl_password_enc` skip_serializing)
  - `fetch_active(pool, id) -> Result<KafkaConnection>`
  - `fetch_active_for_tenant(pool, id, tenant_id) -> Result<KafkaConnection>`
  - `KafkaTriggerConfig { connection_id: i64, topic: String, group_id: String, auto_offset_reset: String, value_format: String }`
  - `parse_kafka_trigger_config(workflow_id: i32, trigger_config: &Value) -> Option<KafkaTriggerConfig>`
  - `build_kafka_trigger_data(...) -> Value`

- [ ] **Step 1: Write failing unit tests in `trigger_config.rs`**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn default_group_id_uses_workflow_id() {
        let cfg = parse_kafka_trigger_config(
            42,
            &json!({ "connection_id": 1, "topic": "orders" }),
        )
        .unwrap();
        assert_eq!(cfg.group_id, "onebase-wf-42");
        assert_eq!(cfg.auto_offset_reset, "latest");
        assert_eq!(cfg.value_format, "json");
    }

    #[test]
    fn build_trigger_data_parses_json_payload() {
        let v = build_kafka_trigger_data(
            1,
            "orders",
            0,
            9,
            Some("k"),
            json!({"x-a": "1"}),
            r#"{"order_id":7}"#,
            "json",
        );
        assert_eq!(v["payload"]["order_id"], 7);
        assert_eq!(v["kafka"]["offset"], 9);
    }

    #[test]
    fn build_trigger_data_text_keeps_string_payload() {
        let v = build_kafka_trigger_data(
            1, "t", 0, 1, None, json!({}), "hello", "text",
        );
        assert_eq!(v["payload"], "hello");
    }
}
```

- [ ] **Step 2: Implement models + mod + trigger_config**

`models.rs`: mirror `redis_ds/models.rs` with Kafka fields.

`mod.rs`: copy `fetch_active` / `fetch_active_for_tenant` SQL against `management.kafka_connections`.

`trigger_config.rs`:
- Require `connection_id` (i64) + non-empty `topic`
- `group_id` default `format!("onebase-wf-{workflow_id}")`
- `auto_offset_reset` in `latest|earliest`, default `latest`
- `value_format` in `json|text`, default `json`
- `build_kafka_trigger_data`: shape per spec §6.5; json parse failure → `payload: null`

- [ ] **Step 3: Wire modules**

`src/lib.rs`: `pub mod kafka_ds;`
`src/main.rs`: `mod kafka_ds;`

- [ ] **Step 4: Test**

Run: `cargo test --lib kafka_ds::trigger_config -- --nocapture`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/kafka_ds src/lib.rs src/main.rs
git commit -m "feat(kafka): add kafka_ds models, fetch helpers, trigger_config"
```

---

### Task 3: `kafka_ds` client_cache + commands

**Files:**
- Create: `src/kafka_ds/client_cache.rs`, `src/kafka_ds/commands.rs`
- Modify: `src/kafka_ds/mod.rs`（`pub mod client_cache; pub mod commands;`）

**Interfaces:**
- Consumes: `KafkaConnection`, `crypto::decrypt_secret`
- Produces:
  - `client_cache::get_or_create(conn) -> Result<FutureProducer>`
  - `client_cache::invalidate(connection_id: i64)`
  - `client_cache::build_client_config(conn, password: Option<&str>) -> ClientConfig`（pub(crate)，触发器复用）
  - `commands::SUPPORTED_OPS: &[&str] = &["produce", "list_topics"]`
  - `commands::is_write_op(op) -> bool`（`produce` = true）
  - `commands::execute(producer, op, args) -> Result<Value>`
  - `commands::produce(producer, topic, key: Option<&str>, value: &str, headers: &Value) -> Result<Value>`
  - `commands::list_topics(conn) -> Result<Value>`（可用独立 admin/metadata client）
  - `commands::health_probe(conn) -> Result<Value>`

- [ ] **Step 1: Implement `build_client_config`**

Map:
- `bootstrap.servers` ← `conn.brokers`
- `security.protocol` ← `conn.security_protocol`
- SASL fields when protocol starts with `SASL_`
- `enable.ssl.certificate.verification` ← `!conn.tls_insecure_skip_verify` when SSL
- `socket.timeout.ms` / `message.timeout.ms` from `connect_timeout_secs`

- [ ] **Step 2: Producer cache**

`DashMap<i64, FutureProducer>` + lazy create; decrypt password only at create.

- [ ] **Step 3: commands**

`produce` args: `topic` (required string), `key` optional, `value` required (string or JSON-serialize object/array), `headers` optional object of string values.

Return: `{ "topic", "partition", "offset", "key" }`.

Timeout: 10s around `send().await`.

`list_topics` / `health_probe`: create short-lived client from config, fetch metadata; health returns `{ "ok": true, "broker_count": n }` or error.

- [ ] **Step 4: Unit test allowlist**

```rust
#[test]
fn produce_is_write_op() {
    assert!(is_write_op("produce"));
    assert!(!is_write_op("list_topics"));
}
```

- [ ] **Step 5: `cargo check` + commit**

```bash
git add src/kafka_ds
git commit -m "feat(kafka): producer cache and allowlisted commands"
```

---

### Task 4: `kafka_handlers` + routes

**Files:**
- Create: `src/kafka_handlers.rs`（镜像 `redis_handlers.rs` 结构）
- Modify: `src/main.rs`（`mod kafka_handlers;` + routes next to redis）

**Interfaces:**
- Routes:
  - `GET/POST /api/admin/kafka-connections`
  - `GET/PUT/DELETE /api/admin/kafka-connections/:id`
  - `POST /api/admin/kafka-connections/:id/health`
  - `GET /api/admin/kafka-connections/:id/topics`
  - `POST /api/kafka-connections/:id/exec` body `{ op, args }`
- Auth: same as Redis (`require_tenant_admin` for admin; member rules for exec; viewer read-only)
- On update/delete: `client_cache::invalidate(id)`
- List/get JSON: add `has_password` via response wrapper OR serialize helper — if using raw `KafkaConnection`, frontend can treat missing password as `has_password: !!` — **prefer** returning enriched JSON:

```rust
fn connection_json(c: &KafkaConnection) -> Value {
    let mut v = serde_json::to_value(c).unwrap();
    if let Some(obj) = v.as_object_mut() {
        obj.insert(
            "has_password".into(),
            json!(c.sasl_password_enc.as_ref().map(|s| !s.is_empty()).unwrap_or(false)),
        );
    }
    v
}
```

Create/Update DTOs: `brokers`, `security_protocol`, `sasl_mechanism`, `sasl_username`, `sasl_password` (Option; update semantics same as Redis password), `tls_insecure_skip_verify`, `connect_timeout_secs`, `is_active`.

Validate SASL protocols require mechanism + username.

- [ ] **Step 1: Implement handlers**
- [ ] **Step 2: Register routes in `main.rs`**
- [ ] **Step 3: `cargo check`**
- [ ] **Step 4: Commit**

```bash
git add src/kafka_handlers.rs src/main.rs
git commit -m "feat(kafka): admin CRUD, health, topics, and exec API"
```

---

### Task 5: Workflow `kafka` produce node

**Files:**
- Modify: `src/workflow_engine.rs` — `NodeType`, match arm, `exec_kafka_node`

**Interfaces:**
- Consumes: `kafka_ds::{fetch_active_for_tenant, client_cache, commands}`
- Config: `{ connection_id, op, topic, key?, value, headers? }`
- dry_run / prod_readonly + write op → mock like Redis

- [ ] **Step 1: Add enum variant**

```rust
    /// Kafka produce。
    /// config: `{ "connection_id": <i64>, "op": "produce", "topic", "key"?, "value", "headers"? }`
    Kafka,
```

- [ ] **Step 2: Dispatch + `exec_kafka_node`**

Mirror `exec_redis_node`: parse `connection_id`/`op`; mock writes in dry_run/prod_readonly; fetch tenant connection; `get_or_create`; `commands::execute` with args = config minus connection_id/op.

Return `(json!({ "op": op, "result": result }), None)`.

- [ ] **Step 3: `cargo check` + commit**

```bash
git add src/workflow_engine.rs
git commit -m "feat(workflow): add kafka produce node"
```

---

### Task 6: `workflow_kafka_trigger` + allow `trigger_type=kafka`

**Files:**
- Create: `src/workflow_kafka_trigger.rs`
- Modify: `src/main.rs` — `mod workflow_kafka_trigger;` + `start_kafka_trigger(pool.clone())` near notify
- Modify: `src/workflow_handlers.rs` — all trigger_type allowlists add `"kafka"`
- Modify: `src/mcp_tools.rs` — enum add `"kafka"`

**Interfaces:**
- Consumes: `kafka_ds::trigger_config::{parse_kafka_trigger_config, build_kafka_trigger_data, KafkaTriggerConfig}`, `client_cache::build_client_config`, `fetch_active`, `execute_workflow_internal`
- `start_kafka_trigger(main_pool: PgPool) -> JoinHandle<()>`

**Consumer loop (critical):**

1. Manager every 10s loads enabled kafka workflows → unique `KafkaTriggerConfig` keys (include `workflow_id` in running map if one consumer per workflow — **prefer one consumer task per workflow** keyed by `workflow.id`, so each keeps its own group_id default)
2. For each active workflow: spawn `run_consumer(pool, workflow_id, cfg)`
3. Inside consumer: build `StreamConsumer` with `group.id`, `enable.auto.commit=false`, `auto.offset.reset`
4. On message:
   - build trigger_data
   - **await** `execute_workflow_internal(..., "kafka", &trigger_data, None)`
   - on `Ok`: `consumer.commit_message(&msg, CommitMode::Sync)` (or Async)
   - on `Err`: log, `tokio::time::sleep(2s)`, do not commit
5. On disable/config change: abort handle

Also stop if `fetch_active(connection_id)` fails / inactive.

- [ ] **Step 1: Implement trigger module with unit tests for config matching if needed**
- [ ] **Step 2: Whitelist `kafka` in handlers + mcp**
- [ ] **Step 3: Start in `main.rs`**
- [ ] **Step 4: `cargo test` trigger_config + `cargo check`**
- [ ] **Step 5: Commit**

```bash
git add src/workflow_kafka_trigger.rs src/main.rs src/workflow_handlers.rs src/mcp_tools.rs
git commit -m "feat(workflow): kafka trigger with at-least-once commit"
```

---

### Task 7: Frontend API + nav + connections page

**Files:**
- Modify: `frontend-nextjs/lib/api.ts` — types + `kafkaAPI` after `redisAPI`
- Modify: `frontend-nextjs/components/workspace/workspaceNav.ts` — entry after Redis
- Create: `frontend-nextjs/app/workspace/[projectId]/events/kafka-connections/page.tsx` — clone redis page, slim to: list/create/edit/delete/health/topics; exec optional produce probe

**Interfaces:**
```ts
export type KafkaSecurityProtocol = 'PLAINTEXT' | 'SASL_PLAINTEXT' | 'SASL_SSL' | 'SSL'
export type KafkaSaslMechanism = 'PLAIN' | 'SCRAM-SHA-256' | 'SCRAM-SHA-512'
export interface KafkaConnection {
  id: number
  tenant_id: number
  connection_name: string
  brokers: string
  security_protocol: KafkaSecurityProtocol
  sasl_mechanism: KafkaSaslMechanism | null
  sasl_username: string | null
  has_password?: boolean
  tls_insecure_skip_verify: boolean
  connect_timeout_secs: number
  is_active: boolean
  created_at: string
  updated_at: string
}
export const kafkaAPI = {
  listConnections: (tenantId: number) => api.get<KafkaConnection[]>(...),
  // get/create/update/delete/health/listTopics/exec — mirror redisAPI paths with kafka-connections
}
```

- [ ] **Step 1: api.ts + nav**
- [ ] **Step 2: page.tsx**（以 redis-connections 为模板，字段换成 Kafka）
- [ ] **Step 3: Typecheck**

Run: `cd frontend-nextjs && npx tsc --noEmit`
Expected: no errors in new files

- [ ] **Step 4: Commit**

```bash
git add frontend-nextjs/lib/api.ts frontend-nextjs/components/workspace/workspaceNav.ts \
  frontend-nextjs/app/workspace/[projectId]/events/kafka-connections
git commit -m "feat(frontend): Kafka connections management page"
```

---

### Task 8: Frontend workflow node + trigger UI

**Files:**
- Modify: `frontend-nextjs/components/workflow/NodeTypes.tsx` — `kafka` meta
- Modify: `frontend-nextjs/components/workflow/WorkflowCanvas.tsx` — `getDefaultConfig('kafka')`
- Modify: `frontend-nextjs/components/workflow/NodeConfigPanel.tsx` — `KafkaNodeConfig`（mirror RedisNodeConfig）
- Modify: `frontend-nextjs/components/workflow/list/constants.ts` — `TRIGGER_META.kafka`
- Modify: trigger type selectors in `WorkflowEditorHeader.tsx` / `WorkflowsManager.tsx`（凡硬编码 endpoint/hook/cron/manual/notify 的下拉）
- Modify: kafka trigger_config form fields when `trigger_type === 'kafka'`

Default node config:

```ts
{ connection_id: 0, op: 'produce', topic: '', key: '', value: '' }
```

Trigger config defaults:

```ts
{ connection_id: 0, topic: '', group_id: '', auto_offset_reset: 'latest', value_format: 'json' }
```

Empty `group_id` → backend defaults to `onebase-wf-{id}`.

- [ ] **Step 1: Node palette + config panel**
- [ ] **Step 2: Trigger meta + forms**
- [ ] **Step 3: `npx tsc --noEmit`**
- [ ] **Step 4: Commit**

```bash
git add frontend-nextjs/components/workflow
git commit -m "feat(frontend): kafka workflow node and trigger config UI"
```

---

### Task 9: Smoke verification + docs blurb

**Files:**
- Modify: `frontend-nextjs/components/workflow/WorkflowsManager.tsx` 节点说明文案（若有 redis 说明段落则并列加 kafka）
- Optional: short comment in redis-connections style on kafka page already covers usage

- [ ] **Step 1: Run backend tests**

```bash
cargo test --lib kafka_ds -- --nocapture
cargo check
```

- [ ] **Step 2: Frontend typecheck**

```bash
cd frontend-nextjs && npx tsc --noEmit
```

- [ ] **Step 3: Manual checklist**（记入 commit message 或 PR；无 Kafka 时可跳过真实集群）

1. 创建 PLAINTEXT 连接 → health ok
2. topics 列表
3. 工作流 kafka 节点 dry_run
4. 启用 kafka 触发器 → 发消息 → 工作流 run 出现 → offset 前进
5. 故意让工作流失败 → offset 不前进

- [ ] **Step 4: Final commit if any doc/copy tweaks**

```bash
git add -A
git commit -m "docs: note kafka node in workflow manager help text"
```

---

## Spec coverage checklist

| Spec section | Task |
|---|---|
| §4 连接表 + API | 1, 4 |
| §4 客户端缓存 | 3 |
| §5 produce 节点 | 5, 8 |
| §6 kafka 触发器 + at-least-once | 2, 6 |
| §7 前端管理/节点/触发器 | 7, 8 |
| §8 错误处理 | 3–6（AppError 路径） |
| §9 测试 | 2, 3, 6, 9 |
| 非目标 mTLS/Schema Registry | 不做 |

## Self-review notes

- Trigger **awaits** `execute_workflow_internal` before commit（与 notify 的 spawn-and-forget 不同，属有意差异）
- Consumer keying: **per workflow.id**（避免同 topic/group 多工作流抢消息语义不清）
- `has_password` 由 handler JSON 注入，不落 DB 列
