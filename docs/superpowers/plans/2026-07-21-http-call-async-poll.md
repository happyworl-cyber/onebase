# http_call / Lua http Async Poll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in `202` / `status=pending` async polling to workflow `http_call` nodes and Lua `http.*`, sharing one protocol helper aligned with Provisioner.

**Architecture:** Introduce a small pure module `http_async_poll` that classifies responses, extracts job IDs / poll URLs, and builds poll request descriptors. `exec_http_call_node` runs an async poll loop with `reqwest::Client`; `lua_builtins::do_http_request` runs the same loop with `reqwest::blocking`. Frontend only adds fold-out config on `http_call`.

**Tech Stack:** Rust (reqwest async + blocking, mlua, serde_json), Next.js/React TypeScript (`NodeConfigPanel.tsx`).

**Spec:** `docs/superpowers/specs/2026-07-21-http-call-async-poll-design.md`

## Global Constraints

- Do not create git commits unless the user explicitly asks.
- Do not change `WORKFLOW_LUA_TIMEOUT_MS` / `lua_node_timeout_ms()` defaults (already shipped).
- `async_poll` is opt-in; disabled path must match current behavior byte-for-byte for success responses (including returning raw `202`).
- `http_call` and Lua must use the same classification / poll-body helpers — no duplicated protocol rules.
- No suspend/resume, no webhook callback wake-up, no new node type.
- Do not broaden Debug axios / Admin `TimeoutLayer` in this plan.

---

## File Structure

- Create `src/http_async_poll.rs`: protocol types, classify, parse job_id/poll_url, build poll POST body, parse config fields, shared defaults (`POLL_INTERVAL_DEFAULT=5`, `POLL_MAX_DEFAULT=600`).
- Modify `src/lib.rs`: `pub mod http_async_poll;`.
- Modify `src/main.rs`: `mod http_async_poll;` (keep binary modules in sync with existing pattern).
- Modify `src/workflow_engine.rs`: `exec_http_call_node` opt-in poll loop + output metadata.
- Modify `src/lua_builtins.rs`: `do_http_request` reads opts and runs blocking poll loop.
- Modify `frontend-nextjs/components/workflow/NodeConfigPanel.tsx`: async_poll UI + fix timeout placeholder to 120.

---

### Task 1: Shared `http_async_poll` Helper + Unit Tests

**Files:**
- Create: `src/http_async_poll.rs`
- Modify: `src/lib.rs`
- Modify: `src/main.rs`

**Interfaces:**
- Produces:
  - `pub const DEFAULT_POLL_INTERVAL_SECS: u64 = 5;`
  - `pub const DEFAULT_POLL_MAX_SECS: u64 = 600;`
  - `pub struct AsyncPollConfig { pub enabled: bool, pub poll_interval_secs: u64, pub poll_max_secs: u64 }`
  - `pub enum IdSource { JobId, Id, ProvisionId }`
  - `pub enum ClassifyResult { Ready, Pending { job_id: Option<String>, id_source: Option<IdSource>, poll_url: Option<String>, poll_after_secs: Option<u64> }, Failed { message: String } }`
  - `pub fn parse_async_poll_config(config: &serde_json::Value) -> AsyncPollConfig` (for http_call JSON config)
  - `pub fn classify_http_response(status: u16, body: &serde_json::Value, headers: &std::collections::HashMap<String, String>) -> ClassifyResult`
  - `pub fn build_poll_post_body(job_id: &str, id_source: IdSource) -> serde_json::Value`
  - `pub fn next_sleep_secs(poll_after_secs: Option<u64>, poll_interval_secs: u64) -> u64` → `max(1, min(poll_after.unwrap_or(interval), interval))`
  - `pub fn resolve_poll_url(body: &serde_json::Value, headers: &HashMap<String, String>) -> Option<String>`
- Consumes: none (pure).

- [ ] **Step 1: Write failing unit tests in the new module**

Create `src/http_async_poll.rs` with a `#[cfg(test)] mod tests` containing at least:

```rust
use super::*;
use serde_json::json;
use std::collections::HashMap;

#[test]
fn classify_202_is_pending() {
    let headers = HashMap::new();
    let body = json!({"job_id": "j1", "status": "pending"});
    match classify_http_response(202, &body, &headers) {
        ClassifyResult::Pending { job_id, .. } => assert_eq!(job_id.as_deref(), Some("j1")),
        other => panic!("expected Pending, got {:?}", other),
    }
}

#[test]
fn classify_200_pending_status_is_pending() {
    let headers = HashMap::new();
    let body = json!({"status": "Pending", "id": "x"});
    assert!(matches!(
        classify_http_response(200, &body, &headers),
        ClassifyResult::Pending { .. }
    ));
}

#[test]
fn classify_200_completed_is_ready() {
    let headers = HashMap::new();
    let body = json!({"status": "completed", "result": 1});
    assert!(matches!(
        classify_http_response(200, &body, &headers),
        ClassifyResult::Ready
    ));
}

#[test]
fn classify_failed_status_and_error_field() {
    let headers = HashMap::new();
    let body = json!({"status": "failed", "error": "boom"});
    match classify_http_response(200, &body, &headers) {
        ClassifyResult::Failed { message } => assert!(message.contains("boom")),
        other => panic!("{:?}", other),
    }
}

#[test]
fn classify_4xx_is_failed() {
    let headers = HashMap::new();
    let body = json!({"message": "nope"});
    assert!(matches!(
        classify_http_response(400, &body, &headers),
        ClassifyResult::Failed { .. }
    ));
}

#[test]
fn job_id_priority_job_id_then_id_then_provision_id() {
    let headers = HashMap::new();
    let body = json!({"job_id": "a", "id": "b", "provision_id": "c", "status": "pending"});
    match classify_http_response(202, &body, &headers) {
        ClassifyResult::Pending { job_id, id_source, .. } => {
            assert_eq!(job_id.as_deref(), Some("a"));
            assert!(matches!(id_source, Some(IdSource::JobId)));
        }
        other => panic!("{:?}", other),
    }
}

#[test]
fn location_header_and_poll_url_body() {
    let mut headers = HashMap::new();
    headers.insert("location".into(), "https://example.com/jobs/1".into());
    let body = json!({"status": "pending"});
    match classify_http_response(202, &body, &headers) {
        ClassifyResult::Pending { poll_url, .. } => {
            assert_eq!(poll_url.as_deref(), Some("https://example.com/jobs/1"));
        }
        other => panic!("{:?}", other),
    }
    let body2 = json!({"status": "pending", "poll_url": "https://example.com/p"});
    match classify_http_response(202, &body2, &HashMap::new()) {
        ClassifyResult::Pending { poll_url, .. } => {
            assert_eq!(poll_url.as_deref(), Some("https://example.com/p"));
        }
        other => panic!("{:?}", other),
    }
}

#[test]
fn build_poll_body_includes_provision_id_when_sourced() {
    let v = build_poll_post_body("p1", IdSource::ProvisionId);
    assert_eq!(v["action"], "poll");
    assert_eq!(v["job_id"], "p1");
    assert_eq!(v["provision_id"], "p1");
}

#[test]
fn next_sleep_clamps_like_provisioner() {
    assert_eq!(next_sleep_secs(Some(2), 5), 2);
    assert_eq!(next_sleep_secs(Some(9), 5), 5);
    assert_eq!(next_sleep_secs(None, 5), 5);
    assert_eq!(next_sleep_secs(Some(0), 5), 1);
}

#[test]
fn parse_config_defaults_and_enabled() {
    let off = parse_async_poll_config(&json!({}));
    assert!(!off.enabled);
    let on = parse_async_poll_config(&json!({
        "async_poll": true,
        "poll_interval_secs": 3,
        "poll_max_secs": 90
    }));
    assert!(on.enabled);
    assert_eq!(on.poll_interval_secs, 3);
    assert_eq!(on.poll_max_secs, 90);
}
```

Also add `#[derive(Debug)]` on `ClassifyResult` / `IdSource` so tests can print them.

- [ ] **Step 2: Register the module and run tests to verify they fail**

In `src/lib.rs`, near `pub mod workflow_engine;`, add:

```rust
pub mod http_async_poll;
```

In `src/main.rs`, near `mod workflow_engine;`, add:

```rust
mod http_async_poll;
```

Run:

```bash
cargo test -p onebase --lib http_async_poll::tests -- --nocapture
```

(If the package name differs, use `cargo test http_async_poll:: -- --nocapture`.)

Expected: FAIL (module incomplete / functions missing).

- [ ] **Step 3: Implement the helper module**

Implement `src/http_async_poll.rs` with the public API above. Classification rules (exact):

1. If body is object and `error` is non-empty string → `Failed { message: error }`
2. Else if body.`status` (ascii lower) is `failed` or `error` → `Failed` (prefer `error` / `message` / default `"远程任务失败"`)
3. Else if HTTP status is `4xx`/`5xx` → `Failed` (prefer body `message`/`error` / `"HTTP {status}"`)
4. Else if status == 202 OR body.`status` lower == `pending` → `Pending` with:
   - `job_id` / `id_source` from first present among `job_id`, `id`, `provision_id` (string, non-empty)
   - `poll_url` from body.`poll_url` (non-empty string) else header `location` / `Location` (case-insensitive key lookup)
   - `poll_after_secs` from body number/string if present
5. Else if status is `2xx` → `Ready`
6. Else → `Failed { message: format!("HTTP {status}") }`

`parse_async_poll_config`:

- `enabled` from bool `async_poll` (default false)
- `poll_interval_secs` from u64/i64/str, default `DEFAULT_POLL_INTERVAL_SECS`, min 1 when enabled
- `poll_max_secs` similarly, default `DEFAULT_POLL_MAX_SECS`, min 1 when enabled

`build_poll_post_body`:

```rust
json!({ "action": "poll", "job_id": job_id })
// if IdSource::ProvisionId, also insert "provision_id": job_id
```

- [ ] **Step 4: Run unit tests to verify they pass**

```bash
cargo test http_async_poll:: -- --nocapture
```

Expected: PASS

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/http_async_poll.rs src/lib.rs src/main.rs
git commit -m "$(cat <<'EOF'
feat(workflow): add shared http async poll protocol helper

EOF
)"
```

---

### Task 2: Wire Async Poll into `http_call`

**Files:**
- Modify: `src/workflow_engine.rs` (`exec_http_call_node`, approx. lines 3288–3395)
- Test: add tests in `src/workflow_engine.rs` `#[cfg(test)] mod tests` OR in `src/http_async_poll.rs` integration section that exercises a tiny local server + a thin wrapper; preferred: keep loop logic testable via a private async helper in `workflow_engine` or a `poll_loop_async` in `http_async_poll` that accepts a request callback.

**Interfaces:**
- Consumes: `http_async_poll::{parse_async_poll_config, classify_http_response, build_poll_post_body, next_sleep_secs, AsyncPollConfig, ClassifyResult, IdSource}`
- Produces: `exec_http_call_node` output shape when poll ran:

```json
{
  "status": 200,
  "headers": {},
  "body": {},
  "async_poll": {
    "enabled": true,
    "job_id": "...",
    "attempts": 3,
    "elapsed_secs": 12
  }
}
```

- [ ] **Step 1: Add a local-server integration test that fails before wiring**

Add to `src/http_async_poll.rs` (or workflow_engine tests) an async test using `tokio::net::TcpListener` + spawn that:

1. Accepts first request → responds `HTTP/1.1 202` with body `{"status":"pending","job_id":"j1","poll_after_secs":1}`
2. Accepts second POST with `"action":"poll"` → `200` `{"status":"completed","result":42}`

Expose for testing:

```rust
// in http_async_poll.rs
pub struct HttpExchange {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: serde_json::Value,
    pub body_text: String,
}

pub async fn run_async_poll_loop<F, Fut>(
    cfg: &AsyncPollConfig,
    initial_url: &str,
    initial: HttpExchange,
    auth_headers: &HashMap<String, String>,
    mut do_request: F,
) -> Result<(HttpExchange, serde_json::Value), String>
where
    F: FnMut(PollRequest) -> Fut,
    Fut: std::future::Future<Output = Result<HttpExchange, String>>,
;

pub struct PollRequest {
    pub method: String, // "GET" | "POST"
    pub url: String,
    pub json_body: Option<serde_json::Value>,
    pub headers: HashMap<String, String>,
}
```

Loop algorithm:

1. `started = Instant::now()`, `attempts = 0`, `current = initial`
2. Loop:
   - `classify(current)`
   - `Ready` → return `(current, meta)` with attempts so far (0 if never polled)
   - `Failed` → return Err(message)
   - `Pending`:
     - if both `job_id` and `poll_url` missing → Err("HTTP 异步轮询缺少 job_id/id/provision_id 与 poll_url/Location")
     - if `started.elapsed() >= poll_max` → Err(format!("HTTP 异步轮询超时（已等待 {} 秒）", cfg.poll_max_secs))
     - sleep `next_sleep_secs(...)`
     - if elapsed would exceed max, still check deadline before request
     - build `PollRequest`:
       - if `poll_url` Some → GET that URL, json_body None
       - else → POST `initial_url` with `build_poll_post_body`
     - merge `auth_headers` into request headers
     - `attempts += 1`, `current = do_request(...).await?`
3. Meta: `{ "enabled": true, "job_id": job_id_or_null, "attempts": attempts, "elapsed_secs": elapsed }`

Write test `async_poll_loop_pending_then_ready` that uses the tiny TCP server and `reqwest::Client` inside `do_request`. Expected before implementation: FAIL.

- [ ] **Step 2: Implement `run_async_poll_loop` and make the test pass**

```bash
cargo test async_poll_loop_pending_then_ready -- --nocapture
```

Expected: PASS

Also add tests:

- `async_poll_loop_missing_id_errors`
- `async_poll_loop_respects_poll_max` (server always 202, `poll_max_secs=1`, `poll_after_secs=1`)

- [ ] **Step 3: Integrate into `exec_http_call_node`**

After the existing single-request `output` is built (`status`/`headers`/`body`):

```rust
use crate::http_async_poll::{
    parse_async_poll_config, run_async_poll_loop, HttpExchange, PollRequest,
};

let poll_cfg = parse_async_poll_config(config);
if !poll_cfg.enabled {
    return Ok((output, None));
}

let status = output["status"].as_u64().unwrap_or(0) as u16;
let headers_map: HashMap<String, String> = /* from output["headers"] */;
let body_json = output["body"].clone();
let initial = HttpExchange {
    status,
    headers: headers_map.clone(),
    body: body_json,
    body_text: /* original text if still in scope; else serde_json::to_string(&body) */,
};

// Reuse same client; per-request timeout still via tokio::time::timeout(timeout_secs, ...)
let auth_headers = headers_map; // or only caller-provided request headers from config
let url_for_poll = url.clone();
let (final_ex, meta) = run_async_poll_loop(
    &poll_cfg,
    &url_for_poll,
    initial,
    &auth_headers,
    |req: PollRequest| {
        let client = client.clone();
        let timeout_secs = timeout_secs;
        async move {
            // build reqwest request from PollRequest; wrap with tokio::time::timeout if timeout_secs > 0
            // map to HttpExchange
        }
    },
).await.map_err(AppError::Internal)?;

let mut out = json!({
    "status": final_ex.status,
    "headers": final_ex.headers,
    "body": final_ex.body,
    "async_poll": meta,
});
// Only attach async_poll when enabled; if classify Ready on first response without entering Pending,
// still attach meta with attempts=0 per spec optional — prefer attach whenever enabled==true.
Ok((out, None))
```

Important details:

- Keep existing private-URL check and dry-run skip unchanged (dry-run never reaches real HTTP / poll).
- Single-request timeout applies to **each** poll attempt, not the whole loop.
- When `!poll_cfg.enabled`, return exactly the previous `output` shape (no `async_poll` key).

- [ ] **Step 4: Run focused tests**

```bash
cargo test http_async_poll:: -- --nocapture
cargo test exec_http -- --nocapture
```

Expected: PASS (or no matching exec_http tests besides compile). Full:

```bash
cargo test --lib http_async_poll
```

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/http_async_poll.rs src/workflow_engine.rs
git commit -m "$(cat <<'EOF'
feat(workflow): support async_poll on http_call nodes

EOF
)"
```

---

### Task 3: Wire Async Poll into Lua `http.*`

**Files:**
- Modify: `src/lua_builtins.rs` (`do_http_request`, opts parsing)

**Interfaces:**
- Consumes: same `http_async_poll` helpers + a blocking twin:

```rust
// http_async_poll.rs
pub fn run_blocking_poll_loop<F>(
    cfg: &AsyncPollConfig,
    initial_url: &str,
    initial: HttpExchange,
    auth_headers: &HashMap<String, String>,
    mut do_request: F,
) -> Result<(HttpExchange, serde_json::Value), String>
where
    F: FnMut(PollRequest) -> Result<HttpExchange, String>,
```

Logic identical to async loop but `std::thread::sleep` instead of `tokio::time::sleep`.

- Lua opts keys: `async_poll` (bool), `poll_interval_secs`, `poll_max_secs` (same defaults).
- Return table adds `async_poll` subtable when enabled (and preferably when any poll ran OR always when enabled).

- [ ] **Step 1: Write failing Lua-level test**

In `src/lua_builtins.rs` `#[cfg(test)] mod tests`, add a test that starts a tiny `std::net::TcpListener` server (pending then ready) and runs:

```rust
#[test]
fn lua_http_post_async_poll_waits_for_completion() {
    // spawn blocking server thread...
    let url = format!("http://127.0.0.1:{port}/job");
    let lua = mlua::Lua::new();
    register_http_module(&lua).unwrap();
    let chunk = format!(
        r#"
        local r = http.post("{url}", {{ }}, {{
          async_poll = true,
          poll_interval_secs = 1,
          poll_max_secs = 30,
          timeout_secs = 5,
        }})
        assert(r.status == 200)
        assert(r.async_poll ~= nil)
        assert(r.async_poll.attempts >= 1)
        return r.json.result
        "#,
        url = url
    );
    let result: i64 = lua.load(&chunk).eval().unwrap();
    assert_eq!(result, 42);
}
```

Run:

```bash
cargo test lua_http_post_async_poll_waits_for_completion -- --nocapture
```

Expected: FAIL (async_poll ignored / assertion on `r.async_poll`).

- [ ] **Step 2: Implement blocking poll loop + Lua opts wiring**

In `do_http_request` after the first response is assembled:

1. Parse `async_poll` / interval / max from `opts` (mirror `parse_async_poll_config` — either convert opts table to `serde_json::Value` or add `parse_async_poll_config_from_lua(opts: &Table)`). Prefer building a small JSON object from opts keys and calling `parse_async_poll_config`.
2. If disabled → return existing table unchanged.
3. If enabled → call `run_blocking_poll_loop` with blocking reqwest client (same timeout_secs per attempt).
4. Rebuild Lua result table from final exchange; set `async_poll` fields (`enabled`, `job_id`, `attempts`, `elapsed_secs`).
5. On loop `Err(msg)` → `Err(mlua::Error::RuntimeError(msg))`.

Also add test: without `async_poll`, `202` returns status 202 and no poll (server would hang if polled — use a server that panics on second request).

- [ ] **Step 3: Run Lua + helper tests**

```bash
cargo test lua_http_post_async_poll -- --nocapture
cargo test http_async_poll:: -- --nocapture
```

Expected: PASS

- [ ] **Step 4: Commit (only if user asked)**

```bash
git add src/http_async_poll.rs src/lua_builtins.rs
git commit -m "$(cat <<'EOF'
feat(workflow): support async_poll in Lua http.*

EOF
)"
```

---

### Task 4: Frontend `http_call` Config UI

**Files:**
- Modify: `frontend-nextjs/components/workflow/NodeConfigPanel.tsx` (http_call block ~lines 535–544)

**Interfaces:**
- Consumes/produces node.config fields: `async_poll?: boolean`, `poll_interval_secs?: number`, `poll_max_secs?: number`

- [ ] **Step 1: Update timeout placeholder and add fold-out UI**

Replace the timeout input block and append async poll controls:

```tsx
<div>
  <label className="block text-xs font-medium text-gray-500 mb-1">超时时间（秒）</label>
  <input
    type="number"
    min={0}
    value={node.config.timeout_secs ?? ''}
    onChange={e => updateConfig('timeout_secs', e.target.value === '' ? undefined : Number(e.target.value))}
    className="w-full px-3 py-2 border rounded-lg text-sm"
    placeholder="默认 120，填 0 表示不限制（适合 AI 等长耗时接口）"
  />
  <p className="text-xs text-gray-400 mt-1">单次 HTTP 请求超时；异步轮询时每次请求都受此限制。</p>
</div>

<label className="flex items-center gap-2 mt-3 cursor-pointer">
  <input
    type="checkbox"
    checked={!!node.config.async_poll}
    onChange={e => updateConfig('async_poll', e.target.checked)}
    className="rounded border-gray-300"
  />
  <span className="text-sm text-gray-700">启用异步轮询</span>
</label>
<p className="text-xs text-gray-400 mt-1">
  开启后，收到 HTTP 202 或 body.status=pending 时自动轮询直至完成（协议对齐 Provisioner）。
  总等待仍受工作流超时（timeout_ms）限制，长任务请一并调大。
</p>

{!!node.config.async_poll && (
  <div className="grid grid-cols-2 gap-2 mt-2 p-3 bg-gray-50 border rounded-lg">
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">轮询间隔（秒）</label>
      <input
        type="number"
        min={1}
        value={node.config.poll_interval_secs ?? 5}
        onChange={e => updateConfig('poll_interval_secs', Number(e.target.value) || 5)}
        className="w-full px-3 py-2 border rounded-lg text-sm"
      />
    </div>
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">最长等待（秒）</label>
      <input
        type="number"
        min={1}
        value={node.config.poll_max_secs ?? 600}
        onChange={e => updateConfig('poll_max_secs', Number(e.target.value) || 600)}
        className="w-full px-3 py-2 border rounded-lg text-sm"
      />
    </div>
  </div>
)}
```

Match existing checkbox / label styling in this file if a toggle pattern already exists nearby (prefer consistency over inventing a new switch component).

- [ ] **Step 2: Manual UI check**

Run frontend dev server (project usual command, e.g. `cd frontend-nextjs && npm run dev`), open a workflow, select an `http_call` node:

- Timeout placeholder shows 120
- Checkbox off → no interval/max fields
- Checkbox on → fields appear with defaults 5 / 600
- Save workflow and reload → values persist in node config JSON

- [ ] **Step 3: Commit (only if user asked)**

```bash
git add frontend-nextjs/components/workflow/NodeConfigPanel.tsx
git commit -m "$(cat <<'EOF'
feat(workflow): add http_call async_poll config UI

EOF
)"
```

---

### Task 5: Spec Coverage Smoke + Docs Touch-up

**Files:**
- Modify: `docs/superpowers/specs/2026-07-21-http-call-async-poll-design.md` (status → 已实现 / 实现中 — only if implementation done)
- Optional one-line note in code node help text in `NodeConfigPanel.tsx` about Lua `async_poll` opts — only if a natural help paragraph already exists under `code`; otherwise skip (YAGNI).

- [ ] **Step 1: Run full related test suite**

```bash
cargo test http_async_poll:: -- --nocapture
cargo test lua_http_post_async_poll -- --nocapture
```

Expected: all PASS

- [ ] **Step 2: Checklist against spec**

Verify manually / by test:

| Spec item | Evidence |
|---|---|
| http_call opt-in | Task 2 |
| Lua http.* opt-in | Task 3 |
| Shared helper | Task 1 |
| Defaults 5 / 600 | Task 1 parse + UI |
| Missing id+url fails | Task 2 test |
| poll_max timeout message | Task 2 test |
| dry-run unchanged | no code path calls poll when dry_run skips HTTP |
| Lua timeout env untouched | no edits to `lua_node_timeout_ms` |

- [ ] **Step 3: Commit (only if user asked)**

```bash
git add docs/superpowers/specs/2026-07-21-http-call-async-poll-design.md
git commit -m "$(cat <<'EOF'
docs: mark http async poll design implemented

EOF
)"
```

---

## Self-Review (plan author)

**Spec coverage:**
- Protocol pending/ready/failed → Task 1
- Poll POST / Location GET → Task 1 + Task 2 loop
- http_call engine + metadata → Task 2
- Lua http.* → Task 3
- UI fold-out A + placeholder 120 → Task 4
- Lua script timeout already done → Global Constraints / excluded
- Debug 30s / suspend-resume → excluded

**Placeholders:** none intentional; implementers must use the listed function names.

**Type consistency:** `AsyncPollConfig`, `HttpExchange`, `PollRequest`, `ClassifyResult`, `IdSource`, `run_async_poll_loop`, `run_blocking_poll_loop` are named once in Task 1/2 and reused in Task 3.
