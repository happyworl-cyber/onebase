# Tenant Stale Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink cross-border dead-connection windows with idle `SELECT 1` pings, and retry once on the first IO when a stale connection is checked out.

**Architecture:** Classify PG wire EOF / reset as stale; wrap `acquire` + `apply_session_guards` so a dead conn is dropped and replaced once; background `try_acquire` + `SELECT 1` on loaded tenant pools every 60s. Do not enable `test_before_acquire`.

**Tech Stack:** Rust, sqlx 0.7 Postgres, existing `POOL_MANAGER` / `pool_metrics` / `raw_sql_guard`.

## Global Constraints

- sqlx 0.7.4 — no `PgConnectOptions::keepalives_idle`; do not upgrade sqlx.
- Keep `test_before_acquire` off on tenant pools.
- Do not change default `TENANT_DB_IDLE_TIMEOUT` (600) or `TENANT_DB_MIN_CONNECTIONS` (1).
- Retry at most once, and only before business SQL has succeeded.
- Do not retry `PoolTimedOut` or SQLSTATE business errors.

---

### Task 1: Stale-connection classifier and retry-once

**Files:**
- Modify: `src/error.rs`

**Interfaces:**
- Produces: `is_stale_sqlx_error(&sqlx::Error) -> bool`, `AppError::is_stale_connection(&self) -> bool`, `retry_once_if_stale(source, database_id, op) -> Result<T>`

- [ ] Write failing tests in `src/error.rs` `mod tests` for the fingerprint `expected to read 5 bytes, got 0 bytes at EOF`, Io reset/pipe, and negatives (`PoolTimedOut`, unique-ish Database display, empty Internal).
- [ ] Implement classifier + `retry_once_if_stale` (one retry, warn with `error.kind = stale_connection`).
- [ ] `cargo test --lib error::tests` passes.

### Task 2: Idle ping interval + pool snapshot

**Files:**
- Modify: `src/pool_manager.rs`

**Interfaces:**
- Produces: `idle_ping_interval_secs() -> Option<Duration>` (`None` = off), `PoolManager::snapshot_primary_pools() -> Vec<(i32, PgPool)>`, `spawn_tenant_idle_ping()`, `ping_idle_connection(pool, database_id)` using `try_acquire` + `SELECT 1`

- [ ] Write failing tests for interval parse: default 60, `0` → None, invalid → 60.
- [ ] Implement parse, snapshot, ping, spawn loop (primary + replica snapshots; skip when `try_acquire` is None).
- [ ] `cargo test --lib pool_manager::tests` passes.

### Task 3: `acquire_with_guards` and call sites

**Files:**
- Modify: `src/raw_sql_guard.rs`
- Modify: `src/workflow_engine.rs` (db_query / db_execute / db_transaction / foreach)
- Modify: `src/transaction.rs`
- Modify: `src/main.rs` (`/query` + spawn idle ping)
- Modify: `.env.example`

**Interfaces:**
- Consumes: `retry_once_if_stale`, `apply_session_guards`, `acquire_traced`
- Produces: `acquire_with_guards(pool, database_id, source, policy) -> Result<PoolConnection<Postgres>>`

- [ ] Add `acquire_with_guards` that acquire + SET, retrying once on stale.
- [ ] Replace acquire+`apply_session_guards` pairs; raw autocommit uses the same retry on its SET.
- [ ] Spawn `spawn_tenant_idle_ping` next to prewarm; document `TENANT_DB_IDLE_PING_SECS` in `.env.example`.
- [ ] `cargo test --lib error::tests pool_manager::tests raw_sql_guard::tests` and `cargo check --lib` pass.
