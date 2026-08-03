# Workflow JavaScript Code Node Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend workflow `code` nodes with optional JavaScript (Node.js) execution, per-workflow npm deps, sandboxed subprocess + host IPC aligning Lua builtins.

**Architecture:** Keep `type: "code"`; add `config.language` (`lua`|`javascript`, default `lua`). Persist workflow-level `dependencies` JSONB. On JS exec: ensure npm install under `WORKFLOW_DEPS_DIR`, spawn sandboxed `node --require onebase-runtime`, talk to Rust host bridge for `env`/`http`/`crypto`/`log`/`json`/`time`/`sse`/`google`, write back `ctx.body`.

**Tech Stack:** Rust/Axum, tokio process, bwrap/nsjail (reuse scheduler ShellExecutor patterns), Node.js CJS runtime package, Next.js workflow editor.

## Global Constraints

- `WORKFLOW_JS_CODE_ENABLED` default `false`
- `WORKFLOW_JS_TIMEOUT_MS` default `30000`; `WORKFLOW_NPM_INSTALL_TIMEOUT_MS` default `300000`
- CJS only (`require`); no n8n `$input` API; no Python
- Missing `language` ⇒ Lua (zero change for existing workflows)
- Save may succeed when npm install fails; JS node exec fails if deps not `ready` when deps declared
- Host HTTP SSRF must not be weaker than `http_call` private-URL blocking
- Feature off / no `node` / timeout / non-zero exit ⇒ clear node error

## File map

| Path | Responsibility |
|---|---|
| `migrations/0XX_workflow_dependencies.sql` | `dependencies JSONB` column |
| `src/js_deps.rs` | hash, install mutex, status file, ensure_ready |
| `src/js_runner.rs` | wrap user code, spawn node, timeout, parse result |
| `src/js_host_bridge.rs` | UDS IPC server; host ops |
| `js-runtime/onebase-runtime/` | `--require` preload exposing globals |
| `src/workflow_engine.rs` | dispatch lua vs javascript in `exec_code_node` |
| `src/workflow_handlers.rs` | CRUD `dependencies`; return `deps_status`; async install on save |
| `src/lib.rs` / `src/main.rs` | `mod` registration |
| `frontend-nextjs/components/workflow/NodeConfigPanel.tsx` | language + JS editor |
| `frontend-nextjs/components/workflow/NodeTypes.tsx` | label 「代码」 |
| `frontend-nextjs/components/workflow/*` | workflow deps panel |
| `src/mcp_tools.rs` | NODE_SPEC |
| `.env.example` | new env vars |

---

### Task 1: DB column + request/response fields

**Files:**
- Create: `migrations/` next numbered `*_workflow_dependencies.sql`
- Modify: `src/workflow_handlers.rs` (`Workflow`, `CreateWorkflowRequest`, `UpdateWorkflowRequest`, SQL SELECT/INSERT/UPDATE)
- Modify: `src/bin/migrate_workflow.rs` if it mirrors schema

**Interfaces:**
- Produces: `Workflow.dependencies: Value` (default `{}`); create/update accept optional `dependencies`

- [ ] **Step 1:** Add migration:

```sql
ALTER TABLE management.workflows
  ADD COLUMN IF NOT EXISTS dependencies JSONB NOT NULL DEFAULT '{}'::jsonb;
```

- [ ] **Step 2:** Add `pub dependencies: Value` to `Workflow` with `#[serde(default)]` where needed; bind in create/update; include in RETURNING *.
- [ ] **Step 3:** `cargo check` passes.
- [ ] **Step 4:** Commit `feat: add workflows.dependencies column`

---

### Task 2: `js_deps` — hash, install, status

**Files:**
- Create: `src/js_deps.rs`
- Modify: `src/lib.rs`, `src/main.rs` (`mod js_deps`)

**Interfaces:**
- Produces:
  - `pub fn deps_root() -> PathBuf`
  - `pub fn javascript_dir(workflow_id: i32) -> PathBuf`
  - `pub fn content_hash(package_json: &Value, package_lock: Option<&str>) -> String`
  - `pub async fn ensure_javascript_deps(workflow_id: i32, js_deps: &JsDependencies) -> Result<DepsStatus, String>`
  - `pub fn read_status(workflow_id: i32) -> DepsStatus`
  - `pub struct JsDependencies { package_json: Value, package_lock: Option<String> }`
  - `pub enum DepsStatusKind { Idle, Installing, Ready, Failed }`
  - `pub struct DepsStatus { status: DepsStatusKind, error: Option<String>, hash: Option<String> }`
- Consumes: env `WORKFLOW_DEPS_DIR`, `WORKFLOW_NPM_REGISTRY`, `WORKFLOW_NPM_INSTALL_TIMEOUT_MS`

- [ ] **Step 1:** Write unit tests for `content_hash` stability and parse of `dependencies.javascript` from workflow JSON.
- [ ] **Step 2:** Implement dir layout, write `package.json` / lock, run `npm ci|--omit=dev` or `npm install --omit=dev` under mutex (`tokio::sync::Mutex` map keyed by workflow_id), write `.deps-hash` + `.deps-status.json`.
- [ ] **Step 3:** If no `dependencies.javascript` or empty deps object ⇒ `Idle` and `ensure` is no-op success.
- [ ] **Step 4:** `cargo test js_deps` passes.
- [ ] **Step 5:** Commit `feat: add workflow javascript deps installer`

---

### Task 3: `onebase-runtime` + host bridge (IPC)

**Files:**
- Create: `js-runtime/onebase-runtime/index.js` (+ minimal `package.json` if needed)
- Create: `src/js_host_bridge.rs`
- Modify: `src/lib.rs` / `src/main.rs`

**Interfaces:**
- Produces:
  - `pub struct HostBridgeConfig { env_vars, tenant_id, http_disabled, socket_path }`
  - `pub async fn run_bridge(config, handler_shutdown) -> Result<()>`
  - IPC request JSON: `{ "id", "op", "args" }` → `{ "id", "ok", "result"|"error" }`
  - Ops: `env.get`, `http.get|post|put|delete`, `crypto.*` (mirror lua_builtins surface used in workflows), `log.*`, `json.encode|encode_pretty|decode`, `time.now|now_ms`, `sse.publish`, `google.sa_assertion`
- JS runtime: sets `global.env`, `global.http`, etc.; sync IPC over UDS with length-prefixed frames or newline JSON

- [ ] **Step 1:** Implement minimal bridge + runtime for `env.get`, `json.*`, `time.*`, `log.*`.
- [ ] **Step 2:** Add `http.*` via Rust reqwest with private-IP block (reuse helper from `http_call` / existing SSRF util — grep `is_private` / `block_private` / `ensure_public`).
- [ ] **Step 3:** Port `crypto.*` and `sse.publish` / `google.sa_assertion` by calling shared Rust logic (extract thin wrappers from `lua_builtins` if needed rather than duplicating crypto).
- [ ] **Step 4:** Unit test: start bridge, node one-liner calling `env.get`, assert value.
- [ ] **Step 5:** Commit `feat: add JS host bridge and onebase-runtime`

---

### Task 4: `js_runner` + sandbox spawn

**Files:**
- Create: `src/js_runner.rs`
- Modify: reuse sandbox construction from `src/scheduler/executors.rs` (extract `build_sandboxed_command(argv, cwd, env)` if needed, or duplicate minimal Direct/Bwrap path for argv form — shell uses `-c`; JS needs `node --require … entry.js`)

**Interfaces:**
- Produces:
  - `pub struct JsExecRequest { workflow_id, code, plugin_ctx: PluginContext, env_vars, tenant_id, http_disabled, timeout_ms, deps_dir }`
  - `pub async fn execute_javascript(req: JsExecRequest) -> Result<JsonValue, String>`
- Behavior:
  1. Abort if `WORKFLOW_JS_CODE_ENABLED` not true
  2. Resolve `node` binary; error if missing
  3. `ensure_javascript_deps` when workflow has JS deps (caller may pass deps); if deps declared and not ready after ensure → error
  4. Temp dir: `ctx.json`, `user.js`, `entry.js`, `result.json`
  5. entry wraps user code, loads ctx, auto-calls `execute` if present, writes `{body}` to result.json
  6. Start host bridge on UDS in temp dir; set `ONEBASE_HOST_SOCK`
  7. Spawn sandboxed node with timeout; read result.json

- [ ] **Step 1:** Implement entry wrapper + Direct-mode execute (no bwrap) with feature flag gate.
- [ ] **Step 2:** Wire sandbox (bwrap argv form); bind-mount/writable temp + deps dir as needed.
- [ ] **Step 3:** Test: echo `ctx.body` round-trip with flag enabled (use `tempfile`, skip if no node).
- [ ] **Step 4:** Commit `feat: add sandboxed workflow JS runner`

---

### Task 5: Engine dispatch + save-time install

**Files:**
- Modify: `src/workflow_engine.rs` (`exec_code_node`)
- Modify: `src/workflow_handlers.rs` (after create/update, spawn install if JS deps present; get workflow includes `deps_status`)

**Interfaces:**
- Consumes: `js_runner::execute_javascript`, `js_deps::*`
- `exec_code_node` reads `config.language`; `"javascript"` → JS path; else Lua

- [ ] **Step 1:** Branch in `exec_code_node`; pass `PluginContext` fields identical to Lua path; load workflow dependencies from DB or pass via `ExecutionContext` (add `js_dependencies: Option<Value>` on context if needed — prefer attaching on `ExecutionContext` at run start from workflow row).
- [ ] **Step 2:** On create/update when `dependencies` changes, `tokio::spawn` `ensure_javascript_deps`.
- [ ] **Step 3:** Get-workflow response adds `deps_status` from `read_status`.
- [ ] **Step 4:** Unit test: missing language still Lua; javascript with flag off returns clear error.
- [ ] **Step 5:** Commit `feat: dispatch JS code nodes and install deps on save`

---

### Task 6: Frontend — language + deps panel

**Files:**
- Modify: `frontend-nextjs/components/workflow/NodeTypes.tsx` — label `代码` (or `代码 / Lua·JS`)
- Modify: `frontend-nextjs/components/workflow/NodeConfigPanel.tsx` — language select; JS placeholder using `ctx.body`
- Modify: workflow editor save/load (`WorkflowsManager.tsx` / canvas parent) — persist `dependencies`; panel to edit `dependencies.javascript.packageJson.dependencies` as JSON; show `deps_status`
- Modify: `frontend-nextjs/lib/api.ts` if workflow types need `dependencies`

- [ ] **Step 1:** Language selector + templates.
- [ ] **Step 2:** Deps JSON editor + status badge on workflow editor chrome.
- [ ] **Step 3:** Smoke: save workflow JSON includes `language` and `dependencies`.
- [ ] **Step 4:** Commit `feat(ui): JS language and workflow npm deps editor`

---

### Task 7: MCP, env example, docs polish

**Files:**
- Modify: `src/mcp_tools.rs` NODE_SPEC for `code`
- Modify: `.env.example`
- Modify: spec status line to `implemented` when done

- [ ] **Step 1:** Document `language`, deps, JS example in NODE_SPEC.
- [ ] **Step 2:** Add env vars to `.env.example` with comments.
- [ ] **Step 3:** Commit `docs: document workflow JS code node`

---

## Spec coverage checklist

| Spec item | Task |
|---|---|
| `config.language` default lua | 5, 6 |
| Per-workflow npm | 2, 5, 6 |
| Subprocess + sandbox | 4 |
| Host API parity | 3 |
| Feature flag default false | 4, 7 |
| deps status file + API | 2, 5 |
| CJS only | 3, 4 |
| No Python / no n8n API | (out of scope) |

## Self-review notes

- No TBD placeholders; ESM deferred explicitly in Task 3/4 (CJS).
- `ExecutionContext` must carry deps or runner loads from disk hash written at save — Task 5 chooses attach-on-context from workflow row at run start (explicit).
- Sandbox argv extraction may touch `executors.rs`; keep shell `-c` path working.
