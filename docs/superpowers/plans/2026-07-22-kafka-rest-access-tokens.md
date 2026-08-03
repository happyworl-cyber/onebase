# Kafka REST Access Tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Kafka 连接增加 `cres_kafka_*` 访问令牌与路径式 REST（produce/topics/health），含 `/api/v1/:slug/kafka/...`，对齐 ES 对外接入方式。

**Architecture:** 新增 `kafka_access_tokens` 表；`kafka_ds/auth` 负责令牌生成/校验与 ops/topic ACL；`kafka_handlers` 扩展 JWT token CRUD；新建 `kafka_app_handlers` 提供无 JWT 的对外 REST，复用 `kafka_ds::commands`。保留现有 JWT `exec`。

**Tech Stack:** Rust / Axum / SQLx，Next.js / TypeScript。

**Spec:** `docs/superpowers/specs/2026-07-22-kafka-rest-access-tokens-design.md`

## Global Constraints

- Token 前缀 `cres_kafka_`（sha256 入库；明文仅创建时返回）
- 对外路径：`POST/GET /api/kafka/:id/{produce|topics|health}` + `/api/v1/:database_slug/kafka/:id/...`
- ACL：`allowed_ops` + `topic_allowlist`（glob，复用 ES `glob_match` 逻辑或复制到 kafka_ds/auth）
- 保留 JWT `/api/kafka-connections/:id/exec` 与 admin CRUD
- 不做协议透传 / 消费 REST
- 迁移号：`053_kafka_access_tokens.sql`
- 验证：`cargo test --lib kafka_ds::auth`、`cargo check`；前端 Tokens/Usage 可用

---

## File Structure

| Path | Responsibility |
|---|---|
| `migrations/053_kafka_access_tokens.sql` | tokens 表 |
| `src/kafka_ds/auth.rs` | generate/hash/extract/check_op/check_topic/glob |
| `src/kafka_ds/models.rs` | `KafkaAccessToken` |
| `src/kafka_handlers.rs` | JWT token CRUD |
| `src/kafka_app_handlers.rs` | 令牌面 REST |
| `src/main.rs` | 路由 + slug middleware |
| `frontend-nextjs/lib/api.ts` | token API |
| `frontend-nextjs/app/.../kafka-connections/page.tsx` | Tokens + Usage tabs |

---

### Task 1: Migration + auth 纯函数（TDD）

**Files:** Create `migrations/053_kafka_access_tokens.sql`, `src/kafka_ds/auth.rs`; Modify `src/migrate.rs`, `src/kafka_ds/mod.rs`, `src/kafka_ds/models.rs`

- [ ] Migration mirrors `es_access_tokens` but with `allowed_ops TEXT[] DEFAULT ARRAY['produce','list_topics','health']` and `topic_allowlist TEXT[] DEFAULT ARRAY['*']`（无 path_denylist）
- [ ] `KafkaAccessToken` model with `token_hash` skip_serializing
- [ ] `auth.rs`: `generate_token` → `cres_kafka_...`; `hash_token`; `token_prefix`; `extract_token`; `op_allowed`; `topic_allowed` (glob); unit tests
- [ ] Register migration `"053 kafka access tokens"`
- [ ] `cargo test --lib kafka_ds::auth` PASS; commit

### Task 2: JWT Token CRUD

**Files:** Modify `src/kafka_handlers.rs`, `src/main.rs`

- [ ] Mirror `es::admin_handlers` token CRUD against `kafka_access_tokens`
- [ ] Routes under `/api/admin/kafka-connections/:id/tokens`
- [ ] Create returns `{ token, record }` once
- [ ] `cargo check`; commit

### Task 3: Token-authed app handlers + routes

**Files:** Create `src/kafka_app_handlers.rs`; Modify `src/main.rs`

- [ ] Resolve token → load connection → check op/topic → call `commands::*`
- [ ] Handlers: `produce`, `list_topics`, `health`
- [ ] Routes without JWT middleware: `/api/kafka/:id/...`
- [ ] Slug nest: `/api/v1/:database_slug/kafka/...` with tenant-scope middleware (copy ES pattern: resolve database_slug → tenant_id, compare to connection.tenant_id)
- [ ] Bump use_count/last_used_at (spawn, like ES)
- [ ] Response `{ ok, op, result }`
- [ ] `cargo check`; commit

### Task 4: Frontend Tokens + Usage

**Files:** Modify `frontend-nextjs/lib/api.ts`, `.../kafka-connections/page.tsx`

- [ ] `kafkaAPI` token methods
- [ ] Tabs: Overview | Tokens | Usage（对齐 es-connections）
- [ ] Usage curl for produce/topics/health on both bases
- [ ] Commit

### Task 5: Smoke

- [ ] `cargo test --lib kafka_ds::auth`; `cargo check`
- [ ] Confirm JWT exec + workflow kafka node still compile
- [ ] Commit any leftover copy fixes

---

## Spec coverage

| Spec | Task |
|---|---|
| §4 令牌表 + 管理 API | 1, 2 |
| §5 对外 REST + ACL + slug | 3 |
| §6 前端 | 4 |
| §7 错误码 | 3 |
| JWT exec 保留 | 不改 |

## Execution

Prefer **inline / subagent-driven** continuous execution after plan commit. User already approved the spec.
