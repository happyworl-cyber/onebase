# Workflow Code-Node Debug Logs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect `print` / `console.log` / `log.*` from Lua, JavaScript, and Python code nodes into `node_results.logs` for debug and production runs, show them in the editor and replay.

**Architecture:** A small `workflow_logs` module owns line type + truncation. JS/Python entry scripts buffer user logs into `result.json`; Lua `print`/`log.*` write an in-process sink. `execute_node` returns `NodeOutcome` so the top-level Success / Failed / FailedAllowed paths can attach `logs` without stuffing them into `output`. Frontend reads optional `logs` on the existing node card.

**Tech Stack:** Rust (`workflow_engine`, `lua_engine`, `js_runner`, `py_runner`), Next.js `WorkflowsManager` + `ExecutionReplayView`. No new crates.

**Spec:** `docs/superpowers/specs/2026-09-11-workflow-code-node-logs-design.md`

## Global Constraints

- Do not persist logs in a new table; they live on `NodeExecutionResult` inside existing `node_results` JSON
- Do not put `logs` into `ctx.node_outputs` / `output` (templates stay `{{node.field}}` on body)
- Do not capture raw process stdout or `console.dir` / `console.table`
- Truncate before mask: max 200 user lines, 64KB total message bytes, 4KB per message (head+tail); then append `{ level: "warn", message: "日志已截断" }`
- Mask `logs[].message` with existing `mask_env_and_credentials` (already walks string leaves)
- Code runtime failure still keeps logs collected before the throw
- Do not add an MCP tool; `debug_workflow` already returns `node_results`
- Do not commit unless the user asked; skip `git commit` steps if this session did not request commits
- Repo has no frontend unit-test runner; UI task ends with a concrete manual check
- JS/Python runner tests that need a real interpreter must skip (return) if `node` / `python3` is missing, same as today

## File map

| Path | Responsibility |
|------|----------------|
| `src/workflow_logs.rs` | `NodeLogLine`, `NodeLogLevel`, `truncate_logs`, `logs_from_json` |
| `src/lib.rs` | `pub mod workflow_logs` |
| `src/workflow_engine.rs` | `NodeExecutionResult.logs`, `NodeOutcome`, `ok_out`/`ok_branch`, `exec_code_node`, top-level match |
| `src/lua_engine.rs` / `src/lua_builtins.rs` | log sink on `print` / `log.*` |
| `src/js_runner.rs` | `CodeExecOutput` / `CodeExecError`, `ENTRY_JS` wrappers |
| `src/py_runner.rs` | same contract, `ENTRY_PY` wrappers |
| `frontend-nextjs/components/workflow/WorkflowsManager.tsx` | `NodeResultCard` logs block |
| `frontend-nextjs/components/workflow/replay/ExecutionReplayView.tsx` | selected-node logs |
| Spec | Mark `状态：已通过` after implementation |

---

### Task 1: Log line type and truncation

**Files:**
- Create: `src/workflow_logs.rs`
- Modify: `src/lib.rs` — add `pub mod workflow_logs;` next to `pub mod workflow_engine;`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `NodeLogLevel` serde rename_all lowercase: `Debug`, `Info`, `Warn`, `Error`
  - `NodeLogLine { level: NodeLogLevel, message: String }`
  - `pub const MAX_LOG_LINES: usize = 200`
  - `pub const MAX_LOG_BYTES: usize = 64 * 1024`
  - `pub const MAX_LOG_MESSAGE_CHARS: usize = 4096`
  - `pub fn clamp_message(s: &str) -> String` — if `s.chars().count() <= 4096` return owned; else first 2048 chars + `…[truncated]…` + last 2048 chars
  - `pub fn truncate_logs(logs: Vec<NodeLogLine>) -> Vec<NodeLogLine>` — clamp each message; keep prefix while line count ≤ 200 **and** sum of message bytes ≤ 64KB; if anything dropped, push `NodeLogLine { level: Warn, message: "日志已截断".into() }`
  - `pub fn logs_from_json(v: &Value) -> Vec<NodeLogLine>` — `v` is a JSON array; skip items missing valid `level`+`message`; unknown level → `Info`

- [ ] **Step 1: Write failing tests**

In `src/workflow_logs.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clamp_long_message_keeps_head_and_tail() {
        let s = "A".repeat(3000) + &"B".repeat(3000);
        let out = clamp_message(&s);
        assert!(out.starts_with(&"A".repeat(2048)));
        assert!(out.contains("…[truncated]…"));
        assert!(out.ends_with(&"B".repeat(2048)));
        assert!(out.chars().count() < s.chars().count());
    }

    #[test]
    fn truncate_caps_lines_and_appends_marker() {
        let logs: Vec<_> = (0..201)
            .map(|i| NodeLogLine {
                level: NodeLogLevel::Info,
                message: format!("l{i}"),
            })
            .collect();
        let out = truncate_logs(logs);
        assert_eq!(out.len(), 201);
        assert_eq!(out[199].message, "l199");
        assert_eq!(out[200].level, NodeLogLevel::Warn);
        assert_eq!(out[200].message, "日志已截断");
    }

    #[test]
    fn logs_from_json_skips_bad_rows() {
        let v = json!([
            { "level": "warn", "message": "x" },
            { "level": "nope", "message": "y" },
            { "message": "z" }
        ]);
        let logs = logs_from_json(&v);
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0].level, NodeLogLevel::Warn);
        assert_eq!(logs[1].level, NodeLogLevel::Info);
    }
}
```

- [ ] **Step 2: Run tests — expect compile fail**

Run: `cargo test -p onebase --lib workflow_logs:: -- --nocapture`

Expected: module / items missing.

- [ ] **Step 3: Implement `workflow_logs.rs` + register in `lib.rs`**

Byte budget: use `message.len()` (UTF-8 bytes) for `MAX_LOG_BYTES`. When adding a line would exceed 200 lines or 64KB, stop and append the warn marker (marker does not count toward the 200 user lines).

- [ ] **Step 4: Run tests — expect pass**

Run: `cargo test -p onebase --lib workflow_logs:: -- --nocapture`

Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add src/workflow_logs.rs src/lib.rs
git commit -m "feat: 代码节点日志行类型与截断。"
```

---

### Task 2: `NodeOutcome` and `NodeExecutionResult.logs`

**Files:**
- Modify: `src/workflow_engine.rs` — struct, helpers, every `exec_*` / `run_loop` / `execute_node` return, top-level match, tests that construct `NodeExecutionResult` or call `execute_node`

**Interfaces:**
- Consumes: `crate::workflow_logs::{NodeLogLine, truncate_logs}`
- Produces:
  - `NodeExecutionResult.logs: Vec<NodeLogLine>` with `#[serde(default, skip_serializing_if = "Vec::is_empty")]`
  - ```rust
    pub(crate) struct NodeOutcome {
        pub output: JsonValue,
        pub branch: Option<String>,
        pub logs: Vec<NodeLogLine>,
        pub error: Option<String>,
    }
    fn ok_out(output: JsonValue) -> NodeOutcome {
        NodeOutcome { output, branch: None, logs: vec![], error: None }
    }
    fn ok_branch(output: JsonValue, branch: impl Into<String>) -> NodeOutcome {
        NodeOutcome { output, branch: Some(branch.into()), logs: vec![], error: None }
    }
    ```
  - `execute_node` / `run_loop` / each `exec_*_node` that currently returns `Result<(JsonValue, Option<String>)>` → `Result<NodeOutcome>`
  - Top match: `Ok(o)` with `o.error.is_none()` → Success (use `o.output`, `o.branch`, `logs: truncate_logs(o.logs)`). `Ok(o)` with `o.error.is_some()` → same Failed / FailedAllowed logic as today's `Err(e)`, message = `o.error.unwrap()`, `logs: truncate_logs(o.logs)`. `Err(e)` → Failed / FailedAllowed with `logs: vec![]`
  - Skipped results: `logs: vec![]`
  - `ctx.node_outputs.insert` still uses **only** `o.output`

Grep in `workflow_engine.rs` for `Ok((` and `Result<(JsonValue, Option<String>)>` and replace mechanically. Tests that do `let (output, branch) = engine.execute_node(...).await.unwrap()` become `let o = ...; o.output` / `o.branch`.

- [ ] **Step 1: Write a failing serialize test**

Near other `NodeExecutionResult` tests (~7040):

```rust
    #[test]
    fn node_result_omits_empty_logs() {
        let r = NodeExecutionResult {
            node_id: "a".into(),
            node_type: None,
            status: NodeStatus::Success,
            input: JsonValue::Null,
            output: json!({"ok": true}),
            elapsed_ms: 1,
            error: None,
            branch: None,
            logs: vec![],
        };
        let v = serde_json::to_value(&r).unwrap();
        assert!(v.get("logs").is_none());
        let r2 = NodeExecutionResult {
            logs: vec![NodeLogLine {
                level: NodeLogLevel::Info,
                message: "hi".into(),
            }],
            ..r.clone()
        };
        assert_eq!(serde_json::to_value(&r2).unwrap()["logs"][0]["message"], "hi");
    }
```

This will not compile until `logs` exists. Add `logs: vec![]` to **every** existing `NodeExecutionResult { ... }` literal in this file (compiler will list them).

- [ ] **Step 2: Change types and all return sites; keep `exec_code_node` returning `ok_out(output)` (logs still empty)**

Do not wrap JS/Lua/Py yet. Goal is compile + serialize test green.

- [ ] **Step 3: Run**

Run: `cargo test -p onebase --lib workflow_engine:: -- --nocapture`

Expected: pass (existing behavior, empty logs).

- [ ] **Step 4: Commit**

```bash
git add src/workflow_engine.rs
git commit -m "feat: 节点结果增加 logs，execute_node 改走 NodeOutcome。"
```

---

### Task 3: Lua `print` / `log.*` sink

**Files:**
- Modify: `src/lua_engine.rs` — `log_sink: Arc<Mutex<Vec<NodeLogLine>>>`, `with_log_sink`, drain after `execute_plugin`
- Modify: `src/lua_builtins.rs` — `register_log_module(lua, sink)`, `register_builtins_with_creds(..., sink)`
- Modify: `src/lua_engine.rs` `inject_safe_globals` `print` — also push `Info` with tab-joined `format!("{:?}", v)` (same as today's tracing line)

**Interfaces:**
- Consumes: `NodeLogLine`, `NodeLogLevel`
- Produces: `PluginResult.logs: Vec<NodeLogLine>` (default empty). `execute_plugin` always fills it from the sink, **including** when the hook `func.call` fails: on `ExecutionError`, return `Ok(PluginResult { logs, ..Default::default() })` is wrong (hides the error). Instead change `PluginError::ExecutionError` to `ExecutionError { message: String, logs: Vec<NodeLogLine> }` with `#[error("执行错误: {message}")]` and update `func.call` map_err to drain the sink. Other `PluginError` variants keep `logs: []` via `impl PluginError { pub fn logs(&self) -> Vec<NodeLogLine> }`.
- `register_builtins` (no creds) passes `None` sink — log.* only tracing (existing tests).
- `create_sandbox_lua` passes `Some(self.log_sink.clone())`.
- `LuaEngine::new` sets `log_sink: Arc::new(Mutex::new(Vec::new()))`.
- Inner engine in `execute_plugin` **must** `with_log_sink(log_sink.clone())` before `create_sandbox_lua`. After spawn_blocking, attach drained logs to `PluginResult` on success.

`register_log_module`: if sink is `Some`, after tracing, `sink.lock().unwrap().push(NodeLogLine { level, message })`. `log.info` → Info, etc. Message is the existing `String` argument.

- [ ] **Step 1: Write failing test in `lua_engine.rs`**

```rust
    #[tokio::test]
    async fn execute_plugin_collects_print_and_log_and_keeps_them_on_error() {
        let engine = LuaEngine::new(1, 5_000, 8 * 1024 * 1024);
        let ctx = minimal_ctx(); // use the existing test helper
        let ok = engine
            .execute_plugin(
                r#"
function execute(ctx)
  print("p1", 2)
  log.info("i1")
  ctx.body = { ok = true }
end
"#,
                "execute",
                &ctx,
            )
            .await
            .unwrap();
        assert!(ok.logs.iter().any(|l| l.message.contains("p1")));
        assert!(ok.logs.iter().any(|l| l.level == NodeLogLevel::Info && l.message == "i1"));

        let err = engine
            .execute_plugin(
                r#"
function execute(ctx)
  print("before")
  error("boom")
end
"#,
                "execute",
                &ctx,
            )
            .await
            .expect_err("must fail");
        let logs = err.logs();
        assert!(logs.iter().any(|l| l.message.contains("before")));
    }
```

If `minimal_ctx` is not in scope, copy the `PluginContext` literal used by the neighboring `execute_plugin` test around line 754.

- [ ] **Step 2: Run — expect fail**

Run: `cargo test -p onebase --lib lua_engine:: -- --nocapture`

- [ ] **Step 3: Implement sink + PluginResult.logs + ExecutionError logs**

Update `test_log_module` only if `register_log_module` signature change requires it (`None` sink).

- [ ] **Step 4: Run lua_engine + lua_builtins tests**

Run: `cargo test -p onebase --lib lua_engine:: lua_builtins:: -- --nocapture`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/lua_engine.rs src/lua_builtins.rs
git commit -m "feat: Lua print 与 log 写入引擎缓冲。"
```

---

### Task 4: JavaScript runner

**Files:**
- Modify: `src/js_runner.rs` — return types, `ENTRY_JS`, `execute_in_dir` reads `logs` from `result.json` even when process exits non-zero

**Interfaces:**
- Consumes: `logs_from_json`, `NodeLogLine`
- Produces:
  ```rust
  pub struct CodeExecOutput {
      pub body: Value,
      pub logs: Vec<NodeLogLine>,
  }
  pub struct CodeExecError {
      pub message: String,
      pub logs: Vec<NodeLogLine>,
  }
  pub async fn execute_javascript(req: JsExecRequest) -> Result<CodeExecOutput, CodeExecError>
  ```
  Disabled / spawn failures: `Err(CodeExecError { message, logs: vec![] })`.
  After `run_node`, always try to read `result.json`. Success: `Ok` with body+logs. Failure: `Err` with stderr/status message **and** logs from `result.json` if present.

`ENTRY_JS` must:
1. `const __logs = [];` + `function __push(level, args) { __logs.push({ level, message: args.map(a => typeof a === 'string' ? a : require('util').inspect(a, { depth: 4 })).join(' ') }); }`
2. Wrap `console.log`→info, `info`→info, `warn`→warn, `error`→error, `debug`→debug (keep original console.error for the process-level catch stack).
3. If `global.log` exists, wrap each method to `__push` then call original.
4. `function __flush(body) { fs.writeFileSync(..., JSON.stringify({ body: body ?? null, logs: __logs })); }`
5. Success path `__flush(ctx.body)`; catch `__flush(null)` then `console.error(stack); process.exitCode = 1`.

Update existing tests: `expect_err` uses `.message`; round-trip `assert_eq!(result.body, json!(...))`.

- [ ] **Step 1: Write failing tests**

```rust
    #[tokio::test]
    async fn execute_collects_console_and_log_and_survives_throw() {
        let _guard = ENV_LOCK.lock().unwrap();
        if std::process::Command::new("node").arg("--version").output().is_err() {
            return;
        }
        std::env::set_var("WORKFLOW_JS_CODE_ENABLED", "true");
        std::env::set_var("WORKFLOW_JS_SANDBOX", "direct");
        let ok = execute_javascript(request(
            r#"
console.log("hello", 1);
log.warn("w");
ctx.body = { ok: true };
"#,
        ))
        .await
        .expect("js ok");
        std::env::remove_var("WORKFLOW_JS_CODE_ENABLED");
        std::env::remove_var("WORKFLOW_JS_SANDBOX");
        assert_eq!(ok.body, json!({"ok": true}));
        assert!(ok.logs.iter().any(|l| l.level == NodeLogLevel::Info && l.message.contains("hello")));
        assert!(ok.logs.iter().any(|l| l.level == NodeLogLevel::Warn && l.message == "w"));

        std::env::set_var("WORKFLOW_JS_CODE_ENABLED", "true");
        std::env::set_var("WORKFLOW_JS_SANDBOX", "direct");
        let err = execute_javascript(request(
            r#"
console.log("before");
throw new Error("boom");
"#,
        ))
        .await
        .expect_err("must fail");
        std::env::remove_var("WORKFLOW_JS_CODE_ENABLED");
        std::env::remove_var("WORKFLOW_JS_SANDBOX");
        assert!(err.message.to_lowercase().contains("boom") || err.message.contains("Error"));
        assert!(err.logs.iter().any(|l| l.message.contains("before")));
    }
```

Import `NodeLogLevel` from `workflow_logs`.

- [ ] **Step 2: Run — expect fail** (old `Result<Value,String>` or missing logs)

Run: `cargo test -p onebase --lib js_runner:: -- --nocapture`

- [ ] **Step 3: Implement types + ENTRY_JS + read logs on failure**

- [ ] **Step 4: Run js_runner tests**

Expected: pass (skip if no node).

- [ ] **Step 5: Commit**

```bash
git add src/js_runner.rs
git commit -m "feat: JavaScript 代码节点收集 console 与 log。"
```

---

### Task 5: Python runner

**Files:**
- Modify: `src/py_runner.rs` — same `CodeExecOutput` / `CodeExecError` **or** move those two structs to `workflow_logs.rs` / a tiny `src/code_exec.rs` if duplicating them is painful. Prefer **move to `workflow_logs.rs`** in this task if Task 4 defined them in `js_runner` — then `js_runner` and `py_runner` both `use crate::workflow_logs::{CodeExecError, CodeExecOutput}`.

**Interfaces:**
- `execute_python(...) -> Result<CodeExecOutput, CodeExecError>`
- `ENTRY_PY`:
  - `_logs = []`
  - `_push(level, *args)` join with space via `str()`
  - replace `_user_globals["print"]` and builtin `print` with a function that `_push("info", *args)` (ignore `file=` / treat like stdout)
  - wrap `_host.log` methods: `_push` then original
  - `_flush(body)` write `{body, logs: _logs}`
  - `try` success `_flush`; `except` `_flush(getattr(ctx,"body", None))`, `traceback.print_exc()`, `sys.exit(1)`

- [ ] **Step 1: Failing test** (same shape as JS, `print("hello", 1)` + `log.error("e")` + a throw after `print("before")`)

Run: `cargo test -p onebase --lib py_runner:: -- --nocapture`

- [ ] **Step 2: Implement ENTRY_PY + return types**

- [ ] **Step 3: Run py_runner tests** — pass / skip if no python3

- [ ] **Step 4: Commit**

```bash
git add src/py_runner.rs src/js_runner.rs src/workflow_logs.rs
git commit -m "feat: Python 代码节点收集 print 与 log。"
```

---

### Task 6: Wire `exec_code_node` and mask

**Files:**
- Modify: `src/workflow_engine.rs` `exec_code_node` only + one engine-level test

**Interfaces:**
- JS: `match execute_javascript(...).await { Ok(o) => ok_out(o.body) with logs: o.logs, Err(e) => NodeOutcome { output: Null, logs: e.logs, error: Some(format!("JavaScript 执行失败: {}", e.message)), .. } }`
- Python: same with `Python 执行失败`
- Lua: `match execute_plugin { Ok(r) => { let output = r.modified_body.or(r.response_body).unwrap_or(Null); NodeOutcome { output, logs: r.logs, error: None, branch: None } }, Err(e) => NodeOutcome { output: Null, logs: e.logs(), error: Some(format!("Lua 执行失败: {e}")), .. } }`
- Missing `code` field still `Err(InvalidQuery)` (no logs)

Add a workflow-level test that runs a Lua code node with `print` and env secret:

```rust
    #[tokio::test]
    async fn code_node_logs_are_truncated_field_and_masked_in_json() {
        // Build a 1-node lua workflow, env_vars {"K":"secret-value-xyz"},
        // code: print("token=secret-value-xyz"); return { ok = true }
        // execute, find node_results[0].logs[0].message contains *** and not secret-value-xyz
        // also assert node_outputs["n"].get("logs") is none — outputs are body only
    }
```

Follow an existing small Lua workflow test in `workflow_engine.rs` (search `language` / `exec_code` / `NodeType::Code`). If no tiny helper, construct `WorkflowDefinition` the same way as `javascript_code_node_respects_disabled_feature_flag`.

Also assert 201 prints → 200 + `日志已截断` on that node's `logs`.

- [ ] **Step 1: Write the failing engine test**

- [ ] **Step 2: Run `cargo test -p onebase --lib workflow_engine::code_node_logs -- --nocapture`** — fail (empty logs)

- [ ] **Step 3: Wire exec_code_node**

- [ ] **Step 4: Run that test + `javascript_code_node_*` / `python_code_node_*`**

Expected: pass. Disabled-flag tests still `Err` from feature flag **before** runner — those stay `Err(Internal)`, no logs.

Wait: disabled JS currently `execute_javascript` Err then `map_err Internal`. After Task 6, disabled should remain `Err` (not NodeOutcome.error) so the whole workflow fails hard. `CodeExecError` from disabled → `Err(AppError::Internal(e.message))` **without** converting to NodeOutcome.error.

Only runner **execution** failures (script throw / non-zero) become `Ok(NodeOutcome { error: Some(...) })`.

- [ ] **Step 5: Commit**

```bash
git add src/workflow_engine.rs
git commit -m "feat: 代码节点把收集到的日志挂上节点结果。"
```

---

### Task 7: Frontend

**Files:**
- Modify: `frontend-nextjs/components/workflow/WorkflowsManager.tsx` — `NodeResultItem`, `NodeResultCard`
- Modify: `frontend-nextjs/components/workflow/replay/ExecutionReplayView.tsx` — selected node detail
- Modify: `frontend-nextjs/components/workflow/replay/replayApi.ts` — `ReplayNodeResult` if it lists fields

**Interfaces:**
- `logs?: { level: string; message: string }[]`
- Card: after output block, if `nr.logs?.length`, render title `调试日志`, `<pre>` lines `{level}  {message}`, max-height like `JsonLogBlock`, reuse `CopyButton` with joined text
- `defaultOpen` also true when `nr.logs?.length`
- Replay: same block under output; omit if missing

No frontend automated test. Manual: debug a code node with `console.log('x')` / Lua `print('x')`, open the node card, see the line; save a run and reopen history; old run without `logs` looks unchanged.

- [ ] **Step 1: Add types + card + replay UI**

- [ ] **Step 2: Manual check (or skip if no running app) and note what was verified**

- [ ] **Step 3: Commit**

```bash
git add frontend-nextjs/components/workflow/WorkflowsManager.tsx \
  frontend-nextjs/components/workflow/replay/ExecutionReplayView.tsx \
  frontend-nextjs/components/workflow/replay/replayApi.ts
git commit -m "feat: 调试与回放展示代码节点日志。"
```

---

### Task 8: Spec status

**Files:**
- Modify: `docs/superpowers/specs/2026-09-11-workflow-code-node-logs-design.md` — `状态：待评审` → `状态：已通过`

- [ ] **Step 1: Flip status**

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-09-11-workflow-code-node-logs-design.md
git commit -m "docs: 代码节点调试日志设计已通过。"
```

---

## Spec coverage

| Spec item | Task |
|-----------|------|
| `logs` shape / omit empty | 1–2 |
| Truncation 200 / 64KB / 4KB + marker | 1, 6 |
| JS console + log.* + throw keeps lines | 4, 6 |
| Python print + log.* | 5, 6 |
| Lua print + log.* | 3, 6 |
| Mask secrets | 6 (mask already walks JSON) |
| Not in `node_outputs` | 6 |
| Non-code nodes no field | 2 |
| UI debug + history + replay | 7 |
| No new table / no stdout scrape | all |

## Type consistency

- `NodeLogLine` / `NodeLogLevel` live in `workflow_logs`
- `CodeExecOutput` / `CodeExecError` live in `workflow_logs` after Task 5 (Task 4 may define them in `js_runner` then move)
- `NodeOutcome.error: Option<String>` = code **runtime** failure only
- Feature-flag / missing-code failures stay `Err(AppError)`
