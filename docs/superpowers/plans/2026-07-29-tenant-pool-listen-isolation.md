# Tenant Pool LISTEN Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop NOTIFY/SSE listeners from consuming the shared tenant `PgPool`, raise default `max_connections` to 20 with env override, and add workflow PG `statement_timeout`.

**Architecture:** Resolve effective pool max in `pool_manager::create_pool`. Listeners use a dedicated 1-connection pool built from `DatabaseConfig` (not `POOL_MANAGER`). Workflow PG nodes acquire → `apply_session_guards` → execute → `reset_session_guards`.

**Tech Stack:** Rust, sqlx 0.7 `PgListener` / `PgPool`, existing `raw_sql_guard`.

## Global Constraints

- `TENANT_DB_MAX_CONNECTIONS` overrides DB value completely when valid `1..=50`
- New/NULL default `max_connections` = 20
- No migration of existing rows
- No `test_before_acquire` on tenant pools
- Workflow timeout env: `WORKFLOW_DB_STATEMENT_TIMEOUT_MS` default 30000
- LISTEN must not use `POOL_MANAGER` business pool

---

### Task 1: `effective_max_connections` + default 20

**Files:**
- Modify: `src/pool_manager.rs`
- Modify: call sites with `unwrap_or(10)` / `max_connections: 10` for tenant DB
- Modify: `.env.example`
- Test: `src/pool_manager.rs` unit tests

- [x] **Step 1:** Add `DEFAULT_TENANT_MAX_CONNECTIONS: u32 = 20`, `effective_max_connections_from(db, env_opt)`, apply in `create_pool` with log
- [x] **Step 2:** Unit tests for env override / invalid / clamp
- [x] **Step 3:** Replace tenant default 10→20 at create/load sites; document env in `.env.example`

### Task 2: Dedicated LISTEN connections

**Files:**
- Modify: `src/pool_manager.rs` (connect options + `connect_dedicated_listener`)
- Modify: `src/auto_api_handlers.rs` (`load_database_config`)
- Modify: `src/workflow_notify_trigger.rs`
- Modify: `src/sse_notify_bridge.rs`

- [x] **Step 1:** `DatabaseConfig::connect_options()` + `connect_dedicated_listener()` → `(PgPool /*max=1*/, PgListener)`; keep pool alive for listener lifetime
- [x] **Step 2:** `load_database_config(main_pool, id)` for listeners
- [x] **Step 3:** Replace `PgListener::connect_with(&business_pool)` in notify + sse bridge

### Task 3: Workflow PG statement_timeout

**Files:**
- Modify: `src/workflow_engine.rs` (and/or small helper)
- Modify: `.env.example`
- Test: timeout policy parse unit test

- [x] **Step 1:** `workflow_db_statement_timeout_ms()` / policy from env
- [x] **Step 2:** Wrap PG paths in `db_query` / `db_execute` / `db_transaction` / foreach with apply/reset guards
- [x] **Step 3:** `cargo test` relevant modules + `cargo check`

---
