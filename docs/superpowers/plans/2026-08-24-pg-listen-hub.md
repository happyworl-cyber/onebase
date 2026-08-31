# PG Listen Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One dedicated LISTEN connection per tenant database, shared by notify workflows and SSE bridges, with hot LISTEN/UNLISTEN.

**Architecture:** New `ListenHub` owns per-`database_id` `PgListener` sessions. Notify and SSE managers only `subscribe`/`unsubscribe`. Monitor `dedicated_connections` reads `hub.listener_count`, not config row counts.

**Tech Stack:** Rust / Tokio / sqlx `PgListener`, existing `connect_dedicated_listener`, Next.js monitor copy.

**Spec:** `docs/superpowers/specs/2026-08-24-pg-listen-hub-design.md`

## Global Constraints

- No migration; no change to NOTIFY payload, `trigger_config`, or `sse_notify_bridges` schema
- One connection never spans multiple `database_id`
- Do not merge the two 10s config scanners; they only stop calling `connect_dedicated_listener`
- Do not change `diagnose` into multi-verdict (acquire timeout can still be hidden)
- Channel names still rejected by callers if empty/trim or `len > 63`
- `connect_dedicated_listener` signature stays the same
- Hub tests use a fake listener — no real PostgreSQL
- Do not commit unless the user asked; skip `git commit` steps if commits were not requested
- Modules live on the bin crate (`src/main.rs` `mod …`); run tests with `cargo test --bin onebase <filter>`

## File map

| Path | Responsibility |
|------|----------------|
| `src/pg_listen_hub.rs` | Hub, Subscription, fake-backend tests |
| `src/main.rs` | `mod pg_listen_hub`; start order; `Extension<ListenHub>` |
| `src/workflow_notify_trigger.rs` | Subscribe instead of `run_listener` |
| `src/sse_notify_bridge.rs` | Same |
| `src/monitor_handlers.rs` | `listener_count` + leak verdict `> 1` |
| `frontend-nextjs/app/workspace/[projectId]/monitor/page.tsx` | 连接数 vs 兴趣数 copy |

---

### Task 1: Diagnose leak (`dedicated_connections > 1`)

**Files:**
- Modify: `src/monitor_handlers.rs` (`diagnose` ~729, tests ~1126)

**Interfaces:**
- Consumes: existing `VerdictInput.dedicated_connections`, `diagnose`
- Produces: Warn when `dedicated_connections > 1` **before** the `>= 20` branch; summary contains `LISTEN 连接泄漏`

- [ ] **Step 1: Write the failing tests**

In `pool_health_tests`, add after `diagnose_warn_many_listeners`:

```rust
    #[test]
    fn diagnose_warn_listen_leak_before_many() {
        let mut input = base();
        input.dedicated_connections = 2;
        let v = diagnose(&input);
        assert_eq!(v.level, VerdictLevel::Warn);
        assert!(
            v.summary.contains("泄漏"),
            "2 条必须走泄漏而不是 >=20: {}",
            v.summary
        );
    }

    #[test]
    fn diagnose_one_listener_does_not_warn_for_count() {
        let mut input = base();
        input.dedicated_connections = 1;
        let v = diagnose(&input);
        assert_eq!(v.level, VerdictLevel::Ok);
    }
```

Keep `diagnose_warn_many_listeners` (25 still matches `>= 20` **or** leak — after the change, 25 must hit leak first). Update that test:

```rust
    #[test]
    fn diagnose_warn_many_listeners() {
        let mut input = base();
        input.dedicated_connections = 25;
        let v = diagnose(&input);
        assert_eq!(v.level, VerdictLevel::Warn);
        assert!(v.summary.contains("泄漏") || v.summary.contains("偏多"));
    }
```

After leak is implemented, 25 **must** contain `泄漏` (because `> 1` is checked first). Change the assertion to `assert!(v.summary.contains("泄漏"));`.

- [ ] **Step 2: Run tests — expect leak test FAIL**

```bash
cargo test --bin onebase diagnose_warn_listen_leak -- --nocapture
```

Expected: FAIL (`summary` has no `泄漏`, or compile error if test-only).

- [ ] **Step 3: Insert the leak branch immediately above `>= 20`**

```rust
    if input.dedicated_connections > 1 {
        return Verdict {
            level: VerdictLevel::Warn,
            summary: format!(
                "LISTEN 连接泄漏，同库不应超过 1 条（当前 {}）",
                input.dedicated_connections
            ),
            hints: vec!["检查 pg_listen_hub 是否对同一 database_id 重复建连".into()],
        };
    }

    if input.dedicated_connections >= 20 {
        // existing
    }
```

- [ ] **Step 4: Re-run**

```bash
cargo test --bin onebase diagnose_warn -- --nocapture
```

Expected: all `diagnose_warn*` PASS, including `diagnose_one_listener_does_not_warn_for_count`.

- [ ] **Step 5: Commit (only if the user asked)**

```bash
git add src/monitor_handlers.rs
git commit -m "$(cat <<'EOF'
fix(monitor): warn when a database opens more than one LISTEN connection

EOF
)"
```

---

### Task 2: `ListenHub` with a fake listener

**Files:**
- Create: `src/pg_listen_hub.rs`
- Modify: `src/main.rs` — add `mod pg_listen_hub;` next to `mod sse_notify_bridge;`

**Interfaces:**
- Consumes: none from Task 1
- Produces (exact names):

```rust
#[derive(Clone)]
pub struct ListenHub { /* Arc<HubInner> */ }

pub struct Subscription { /* Drop unsubscribes */ }

pub struct ListenNotice {
    pub database_id: i32,
    pub channel: String,
    pub payload: String,
}

impl ListenHub {
    pub fn start() -> Self; // production: PgListener factory
    #[cfg(test)]
    pub fn start_with_factory(factory: TestListenFactory) -> Self;

    pub fn subscribe(&self, database_id: i32, channel: &str) -> Subscription;
    pub fn listener_count(&self, database_id: i32) -> u32;
}

impl Subscription {
    pub async fn recv(&mut self) -> Option<ListenNotice>;
}
```

Internal command enum (not public): `Subscribe { database_id, channel, tx, id }`, `Unsubscribe { id }`.

Per-db worker: `select!` biased — commands first, then `session.recv()`.

Production factory calls `auto_api_handlers::load_database_config` + `pool_manager::connect_dedicated_listener`, then `listen`/`unlisten`/`recv` on `PgListener`. Hold the returned `PgPool` for the session lifetime.

Test factory records ops and injects notices. Suggested op strings: `connect:{id}`, `listen:{id}:{channel}`, `unlisten:{id}:{channel}`, `close:{id}`.

- [ ] **Step 1: Write failing tests in `pg_listen_hub.rs` `#[cfg(test)]`**

Implement `TestListenFactory` first (it can live in the test module) so tests compile, then call `ListenHub::start_with_factory` which will not exist yet.

Required cases (names exact):

```rust
#[tokio::test]
async fn two_channels_same_db_one_connection() { ... }

#[tokio::test]
async fn two_dbs_two_connections() { ... }

#[tokio::test]
async fn two_subs_same_channel_both_receive() { ... }

#[tokio::test]
async fn last_sub_unlistens_and_empty_db_closes() { ... }

#[tokio::test]
async fn dead_subscriber_does_not_block_others() { ... }
```

Assertions:

- `two_channels_same_db_one_connection`: subscribe db=1 ch=a and ch=b; `listener_count(1) == 1`; ops contain one `connect:1` and `listen:1:a`, `listen:1:b`.
- `two_dbs_two_connections`: `listener_count(1) == 1` and `listener_count(2) == 1`.
- `two_subs_same_channel_both_receive`: inject one notice; both `recv()` get the same payload; only one `listen:1:ch`.
- `last_sub_unlistens_and_empty_db_closes`: drop one of two channels → `unlisten`; drop last → `close:1` and `listener_count(1) == 0`.
- `dead_subscriber_does_not_block_others`: drop sub A (or drop its rx by dropping Subscription); inject notice; sub B still `recv`s.

Give the fake a way to push: `factory.push(database_id, channel, payload)`.

Use `tokio::time::timeout(Duration::from_secs(2), sub.recv())` so tests fail fast.

- [ ] **Step 2: Run — expect compile/link fail or test fail**

```bash
cargo test --bin onebase two_channels_same_db_one_connection -- --nocapture
```

Expected: FAIL (`ListenHub` / `start_with_factory` missing).

- [ ] **Step 3: Implement hub**

Sketch (fill so tests pass; keep production `start()` wired to a real factory even if notify/SSE are not switched yet):

- `HubInner { cmd_tx: mpsc::UnboundedSender<HubCmd>, counts: Arc<DashMap<i32, u32>> }`
- Supervisor task: `HashMap<i32, DbWorkerHandle>`. First subscribe for a db spawns a worker; last unsubscribe joins/aborts worker and sets count 0.
- Worker holds `HashMap<String, Vec<(SubId, UnboundedSender<ListenNotice>)>>`.
- On subscribe: if channel vec was empty, `session.listen`. Push sender. `counts.insert(db, 1)` after successful connect.
- On unsubscribe: remove id; if channel vec empty, `unlisten`; if all channels empty, `close` and `counts.insert(db, 0)`.
- On `recv` notice: fan out `clone` to senders; ignore closed senders.
- `RECONNECT_DELAY = 5s` on session errors; reconnect then `listen` every currently registered channel. Tests should not hit this path if the fake never errors.

`Subscription` holds `id`, `cmd_tx`, `rx`. `Drop` sends `Unsubscribe`. `recv` is `self.rx.recv().await`.

Channel string: hub may assume caller already validated; still store owned `String`.

- [ ] **Step 4: Run all hub tests**

```bash
cargo test --bin onebase pg_listen_hub -- --nocapture
```

Expected: PASS (the five tests above).

- [ ] **Step 5: Commit (only if the user asked)**

```bash
git add src/pg_listen_hub.rs src/main.rs
git commit -m "$(cat <<'EOF'
feat: add pg_listen_hub to multiplex LISTEN channels per database

EOF
)"
```

---

### Task 3: Notify trigger uses the hub

**Files:**
- Modify: `src/workflow_notify_trigger.rs`
- Modify: `src/main.rs` — `start_notify_trigger(pool, listen_hub.clone())`

**Interfaces:**
- Consumes: `ListenHub::subscribe`, `Subscription::recv`, `ListenNotice`
- Produces: `pub fn start_notify_trigger(main_pool: PgPool, hub: ListenHub) -> JoinHandle<()>`
- Removes: `run_listener`, `active_listener_count` (delete the function; monitor no longer calls it)

- [ ] **Step 1: Change the running map**

`Subscription::recv` needs `&mut self`, so the subscription lives **inside** the consume task (not a second field on the HashMap value). Tokio `abort()` drops the future, which drops `sub`, which unsubscribes. That satisfies spec §3 / §4.1.

```rust
let mut running: HashMap<NotifyTriggerConfig, JoinHandle<()>> = HashMap::new();

// retain-false: abort the consume task (Subscription Drop follows)
// insert:
let mut sub = hub.subscribe(cfg.database_id, &cfg.channel);
let pool = main_pool.clone();
let task = tokio::spawn(async move {
    while let Some(notice) = sub.recv().await {
        match build_trigger_data(notice.database_id, &notice.channel, &notice.payload) {
            Some(trigger_data) => {
                trigger_matching_workflows(
                    &pool,
                    notice.database_id,
                    &notice.channel,
                    trigger_data,
                )
                .await;
            }
            None => tracing::warn!(
                database_id = notice.database_id,
                channel = %notice.channel,
                "工作流 NOTIFY payload 非 JSON，跳过"
            ),
        }
    }
});
running.insert(cfg, task);
```

- [ ] **Step 2: Delete `run_listener` and `active_listener_count`**

Grep the repo; the only caller of `active_listener_count` is `monitor_handlers.rs` — leave a compile error there until Task 5, or temporarily keep a stub:

Do **not** stub a config-count function. In Task 3, change `start_notify_trigger` signature and fix `main.rs`. If `monitor_handlers` still calls `active_listener_count`, comment that call to `0` **only if** you must keep the bin compiling, and add `tracing::warn!("notify active_listener_count removed; Task 5 will use ListenHub")` — better: do Task 5 immediately after. Prefer compiling by doing Task 5's monitor swap in the same session after Task 3 if the compiler blocks.

If you must split: in Task 3 keep `active_listener_count` as a thin wrapper that **only** counts configs (old behavior) so monitor still compiles, then Task 5 switches the monitor. Spec says delete it — Task 5 deletes it.

- [ ] **Step 3: Existing notify unit tests still pass**

```bash
cargo test --bin onebase workflow_notify_trigger -- --nocapture
```

Expected: existing config/trigger_data/match tests PASS.

- [ ] **Step 4: Commit (only if the user asked)**

```bash
git add src/workflow_notify_trigger.rs src/main.rs
git commit -m "$(cat <<'EOF'
feat(workflow): subscribe notify channels through ListenHub

EOF
)"
```

---

### Task 4: SSE bridge uses the hub

**Files:**
- Modify: `src/sse_notify_bridge.rs`
- Modify: `src/main.rs` — `sse_notify_bridge::start(..., listen_hub.clone())`

**Interfaces:**
- Consumes: `ListenHub::subscribe`, `Subscription::recv`
- Produces: `pub fn start(main_pool: PgPool, hub: SseHub, metrics: BridgeMetrics, listen: ListenHub) -> JoinHandle<()>`
- Removes: `run_listener`'s `connect_dedicated_listener` path

- [ ] **Step 1: Per `BridgeConfig`, spawn a consumer**

Same pattern as notify: `hub.subscribe(cfg.database_id, &cfg.channel)` inside the task; on notification run the existing JSON / `render_topic` / `publish_local` / metrics block from current `run_listener` inner loop.

`stat.connected`: `true` after first successful `recv` wait starts (set true when subscribe returns); `false` when `recv` returns `None`.

Delete the dedicated-connect `run_listener` function.

- [ ] **Step 2: Keep `render_topic` tests**

```bash
cargo test --bin onebase sse_notify_bridge -- --nocapture
```

Expected: PASS.

- [ ] **Step 3: Commit (only if the user asked)**

```bash
git add src/sse_notify_bridge.rs src/main.rs
git commit -m "$(cat <<'EOF'
feat(sse): subscribe notify-bridge channels through ListenHub

EOF
)"
```

---

### Task 5: Wire hub into main + pool-health + monitor copy

**Files:**
- Modify: `src/main.rs` (start order ~2103–2139)
- Modify: `src/monitor_handlers.rs` (`get_pool_health` ~840–854, `ListenerInfo`)
- Modify: `frontend-nextjs/app/workspace/[projectId]/monitor/page.tsx` (~338–341, ~580–588)

**Interfaces:**
- Consumes: `ListenHub::start`, `ListenHub::listener_count`
- Produces: `dedicated_connections = listen_hub.listener_count(database_id) as i64`

- [ ] **Step 1: `main.rs` startup**

Before either manager:

```rust
let listen_hub = pg_listen_hub::ListenHub::start();
app = app.layer(axum::Extension(listen_hub.clone()));
```

Then:

```rust
sse_notify_bridge::start(pool.clone(), sse_hub.clone(), sse_bridge_metrics.clone(), listen_hub.clone());
workflow_notify_trigger::start_notify_trigger(pool.clone(), listen_hub.clone());
```

- [ ] **Step 2: `get_pool_health`**

Add `Extension(listen_hub): Extension<crate::pg_listen_hub::ListenHub>` (or `Option<Extension<ListenHub>>`).

```rust
let dedicated_connections = match listen_hub {
    Some(Extension(hub)) => hub.listener_count(database_id) as i64,
    None => {
        tracing::warn!("ListenHub 未注入，dedicated_connections 记 0");
        0
    }
};
```

Keep `sse_bridges` SQL count and `notify_workflows` via `load_active_notify_configs` filtered by `database_id` (interest only).

**Delete** `workflow_notify_trigger::active_listener_count`.

WaterCard / MiniStat copy:

```tsx
<WaterCard
  label="LISTEN 独立连接"
  value={String(health.listeners.dedicated_connections)}
  sub={`连接 · 兴趣 SSE ${health.listeners.sse_bridges} · notify ${health.listeners.notify_workflows}`}
  tone={
    health.listeners.dedicated_connections > 1
      ? 'yellow'
      : health.listeners.dedicated_connections >= 20
        ? 'yellow'
        : 'blue'
  }
/>
```

Detail card:

```tsx
<MiniStat label="连接" value={String(health.listeners.dedicated_connections)} />
<MiniStat label="SSE 兴趣" value={String(health.listeners.sse_bridges)} />
<MiniStat label="notify 兴趣" value={String(health.listeners.notify_workflows)} />
<p className="text-xs text-gray-400 mt-3">
  连接数是本库实际 LISTEN 连接（同库多 channel 共用一条）。SSE / notify 是登记的兴趣数。
</p>
```

- [ ] **Step 3: Compile + focused tests**

```bash
cargo test --bin onebase diagnose_ -- --nocapture
cargo test --bin onebase pg_listen_hub -- --nocapture
cargo test --bin onebase workflow_notify_trigger -- --nocapture
cargo test --bin onebase sse_notify_bridge -- --nocapture
```

Expected: PASS. `cargo check --bin onebase` succeeds.

- [ ] **Step 4: Commit (only if the user asked)**

```bash
git add src/main.rs src/monitor_handlers.rs src/workflow_notify_trigger.rs \
  frontend-nextjs/app/workspace/[projectId]/monitor/page.tsx
git commit -m "$(cat <<'EOF'
feat(monitor): count real LISTEN connections from ListenHub

EOF
)"
```

---

### Task 6: Spec coverage sweep

**Files:** none unless a gap remains.

- [ ] **Step 1: Confirm against spec §1–8**

| Spec | Task |
|------|------|
| Shared connection notify+SSE | 3+4 |
| Hot LISTEN/UNLISTEN | 2 |
| `listener_count` 0/1 | 2+5 |
| Interest counts unchanged | 5 |
| Leak `> 1` before `>= 20` | 1 |
| No multi-verdict | 1 (untouched order except leak insert) |
| Hub tests without PG | 2 |
| Frontend 连接/兴趣 | 5 |

- [ ] **Step 2: `git grep connect_dedicated_listener`**

Must only appear in `pool_manager.rs` and `pg_listen_hub.rs` (production factory), not in notify/SSE.

- [ ] **Step 3: Stop**

Do not add channel multiplexing across databases or verdict lists.

---

## Spec coverage (self-review)

- §3 interface → Task 2
- §3.1 lifecycle → Task 2 tests
- §4.1 notify → Task 3
- §4.2 SSE → Task 4
- §4.3 main → Task 5
- §5 monitor + diagnose + UI → Tasks 1 and 5
- §6 errors → Task 2 reconnect path (production factory)
- §7 tests → Tasks 1–2
- `active_listener_count` removed → Task 5
