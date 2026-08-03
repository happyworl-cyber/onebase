# Tenant Pool Keepalive / Prewarm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate multi-second Auto API cold starts caused by on-demand tenant pool creation by keeping at least one live connection and prewarming active primaries at process start.

**Architecture:** Align `POOL_MANAGER::create_pool` with management-pool keepalive knobs (`min_connections`, `idle_timeout`, `max_lifetime`) plus a post-create `SELECT 1`. Expose `ensure_pool_loaded` and spawn a bounded background prewarm from `main` after the management pool is ready.

**Tech Stack:** Rust, sqlx `PgPoolOptions`, tokio tasks + semaphore

## Global Constraints

- Do not enable `test_before_acquire` on tenant pools.
- Do not merge `set_config` with business SQL in this change.
- Prewarm failures must not abort process startup.
- Default prewarm on; overridable via env.

---

## File map

| File | Responsibility |
|------|----------------|
| `src/pool_manager.rs` | Parse tenant pool options; apply min/idle/lifetime; `SELECT 1` after create; unit tests |
| `src/auto_api_handlers.rs` | `pub(crate) ensure_pool_loaded`; `spawn_tenant_pool_prewarm` |
| `src/main.rs` | Call `spawn_tenant_pool_prewarm(pool.clone())` near other background tasks |
| `docs/superpowers/specs/2026-07-27-tenant-pool-keepalive-design.md` | Spec (already written) |

---

### Task 1: Tenant pool options + create_pool keepalive

**Files:**
- Modify: `src/pool_manager.rs`

- [x] Add `TenantPoolOptions` (or equivalent) with `from_env()` defaults: min=1, idle=600, max_lifetime=1800; clamp `min_connections <= max_connections`.
- [x] In `create_pool`, apply options; after `connect_with`, run `SELECT 1` and map failure to `AppError`.
- [x] Unit tests for defaults and clamp.
- [x] Run: `cargo test tenant_pool_options --lib`

### Task 2: Prewarm helper

**Files:**
- Modify: `src/auto_api_handlers.rs`

- [x] Change `ensure_pool_loaded` to `pub(crate)`.
- [x] Add `spawn_tenant_pool_prewarm(main_pool: PgPool)`:
  - Skip if `TENANT_POOL_PREWARM` is false/0/no.
  - Select active primary ids with limit.
  - Concurrent `ensure_pool_loaded` under semaphore.
  - Log summary.
- [x] Run: `cargo check`

### Task 3: Wire into main

**Files:**
- Modify: `src/main.rs`

- [x] After management pool is ready / near watchdog start, `auto_api_handlers::spawn_tenant_pool_prewarm(pool.clone())`.
- [x] Run: `cargo test tenant_pool_options --lib && cargo check`

### Task 4: Mark spec implemented

- [x] Set design doc status to 已实现.
