# PG Crash Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden webhook fan-out (semaphore + TTL cache), tighten tenant pool connection budget, and apply AIO Postgres conf on every boot.

**Architecture:** Minimal in-place changes to `webhook_manager.rs`, `tenant_handlers.rs`, and `docker/entrypoint.sh`, plus `.env.example` docs. Pure helpers for env parsing and budget math are unit-tested.

**Tech Stack:** Rust / tokio Semaphore / sqlx / bash entrypoint

## Global Constraints

- Defaults: dispatch concurrency 16, cache TTL 30s, per-db cap 50, host budget 60, AIO max_connections 120 / shared_buffers 256MB / work_mem 4MB
- Budget aggregates by `(db_host, db_port)`
- No CRUD cache invalidation; no AIO topology split; no forced rewrite of existing rows

---

### Task 1: Webhook options + TTL cache helpers

**Files:**
- Modify: `src/webhook_manager.rs`

- [ ] **Step 1: Write failing tests** for `WebhookDispatchOptions::from_env_map` defaults/overrides and a small `TtlCache` fresh/expired behavior
- [ ] **Step 2: Implement** options + `TtlCache` + wire into `WebhookManager` (Semaphore acquire in `dispatch`, cache in load path)
- [ ] **Step 3: `cargo test --lib webhook_manager`** — pass
- [ ] **Step 4: Document env in `.env.example`**

### Task 2: Connection budget helpers + tenant API checks

**Files:**
- Modify: `src/tenant_handlers.rs` (create/update connection + replica create)

- [ ] **Step 1: Write failing tests** for `validate_tenant_max_connections` (1..=50) and `connection_budget_ok`
- [ ] **Step 2: Implement** helpers; call on create/update/replica paths with SQL `SUM` by host:port
- [ ] **Step 3: `cargo test` related** — pass
- [ ] **Step 4: `.env.example` for `TENANT_POOL_GLOBAL_MAX_CONNECTIONS`

### Task 3: AIO entrypoint PG conf apply

**Files:**
- Modify: `docker/entrypoint.sh`

- [ ] **Step 1: Add** `apply_aio_pg_conf` (idempotent set/replace keys) run every boot before PG start
- [ ] **Step 2: Env overrides** `AIO_PG_MAX_CONNECTIONS`, `AIO_PG_SHARED_BUFFERS`, `AIO_PG_WORK_MEM`
- [ ] **Step 3: `.env.example` notes for AIO vars

### Task 4: Verify

- [ ] **Step 1:** `cargo test --lib webhook_manager` and connection-budget tests
- [ ] **Step 2:** `cargo check`
