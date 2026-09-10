# Workflow Save-Time QA Warnings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before saving a workflow, run local QA rules on the unsaved graph, show a modal if anything hits, and still allow save. Do not call an AI Provider and do not block save for warnings.

**Architecture:** Extend `workflow_qa` with `input_schema` on the snapshot, four `style.*` rules, and `lint_unsaved` + `sort_findings`. A new `POST /api/admin/workflows/qa` (registered before `/:id`) authenticates like `debug_workflow` and returns `{ findings }`. The editor calls it from `handleSave` after hard validation, then either saves or opens the existing `Modal`.

**Tech Stack:** Rust (`workflow_qa`, axum handler), Next.js `WorkflowsManager` + `Modal` + `showToast`. No new crates.

**Spec:** `docs/superpowers/specs/2026-09-09-workflow-qa-save-warnings-design.md`

## Global Constraints

- Warnings never become HTTP 4xx; qa success is always 200 + `findings` (maybe empty)
- Auth matches `debug_workflow`: `resolve_tenant_for_workflow_input` + member (or superadmin if both ids missing)
- Do not call the project AI Provider on the qa/save path
- Do not change `create_workflow` / `update_workflow` write semantics
- Do not change `workflow_engine.rs`; do not call `validate_definition` in qa (incomplete graphs must still lint)
- Do not add a migration
- Do not reimplement rules in TypeScript
- Do not remember “仍然保存” across saves
- Do not jump to a node from the modal; do not write findings into `version_note`
- Do not flag missing `execute()`, empty labels, non-endpoint missing schema, or Lua `pcall`
- Do not commit unless the user asked; skip `git commit` steps if this session did not request commits, but still finish the code and verification
- Repo has no frontend unit-test runner; the UI task ends with a concrete manual check

## File map

| Path | Responsibility |
|------|----------------|
| `src/workflow_qa/mod.rs` | `input_schema` on snapshot; `lint_unsaved`; `sort_findings` |
| `src/workflow_qa/rules.rs` | Four `style.*` rules; use `input_schema` |
| `src/workflow_handlers.rs` | `QaWorkflowRequest` + `qa_workflow` |
| `src/main.rs` | `POST /api/admin/workflows/qa` before `/:id` |
| `frontend-nextjs/components/workflow/WorkflowsManager.tsx` | Save → qa → modal → persist |
| `frontend-nextjs/components/Modal.tsx` | Reuse only |
| Spec | Mark 已通过 after implementation |

---

### Task 1: `input_schema` + style rules + sort

**Files:**
- Modify: `src/workflow_qa/mod.rs` — add `input_schema: Option<Value>` to `WorkflowSnapshot`; update `snapshot_from_value`; add `sort_findings`, `lint_unsaved`
- Modify: `src/workflow_qa/rules.rs` — four new rules; every test `snap()` helper must set `input_schema: None`
- Modify: `src/workflow_qa/provider.rs` / orch tests — any `WorkflowSnapshot { ... }` literal needs `input_schema: None`

**Interfaces:**
- Consumes: existing `scan_rules`, `review_local`, `Finding`, `Severity`
- Produces:
  - `WorkflowSnapshot.input_schema: Option<serde_json::Value>`
  - `pub fn sort_findings(findings: &mut [Finding])` — crit > high > med > low, then `code`, then `node_id` (`None` last)
  - `pub fn lint_unsaved(trigger_type: &str, input_schema: Option<&Value>, nodes: &Value, edges: &Value) -> Result<Vec<Finding>, String>` — `Err` if `nodes` or `edges` is not a JSON array; else build snapshot (`id=0`, empty slug/name), `review_local`, `sort_findings`, return rules
  - New rule codes (all `Severity::Low`): `style.missing_input_schema`, `style.generated_node_id`, `style.bare_except`, `style.http_in_code`

Generated-id regex: node `id` matches `^{type}_[a-z0-9]+_[0-9]+$` where `{type}` is that node’s `type` (exact). Example: `code_lj9abc_3` + `type=code`. Not `resp_ok`.

Bare except: in `config.code`:
- `(?m)^\s*except(?:\s+Exception)?\s*:\s*(?:\n[ \t]+pass\s*)?(?:\n|$)` or simpler: after `except:` / `except Exception:` the next non-empty line is `pass` **or** there is no next non-empty line before the next dedent/end
- JS: `catch\s*(\([^)]*\))?\s*\{\s*\}`

HTTP in code: `type==code` and code contains `http.get` or `http.post` or `http.put` or `http.delete`.

- [x] **Step 1: Write failing tests**

Add to `src/workflow_qa/rules.rs` tests (after updating `snap` to take optional schema or add `input_schema: None` and a `snap_schema` helper):

```rust
    fn snap_full(
        trigger: &str,
        schema: Option<serde_json::Value>,
        nodes: serde_json::Value,
        edges: serde_json::Value,
    ) -> WorkflowSnapshot {
        WorkflowSnapshot {
            id: 1,
            slug: "t".into(),
            name: "t".into(),
            department: None,
            trigger_type: trigger.into(),
            input_schema: schema,
            nodes,
            edges,
        }
    }

    #[test]
    fn style_missing_input_schema() {
        let empty_nodes = json!([]);
        let edges = json!([]);
        let c = codes(&snap_full("endpoint", None, empty_nodes.clone(), edges.clone()));
        assert!(c.contains(&"style.missing_input_schema".to_string()));
        let c2 = codes(&snap_full("endpoint", Some(json!({})), empty_nodes.clone(), edges.clone()));
        assert!(!c2.contains(&"style.missing_input_schema".to_string()));
        let c3 = codes(&snap_full("cron", None, empty_nodes, edges));
        assert!(!c3.contains(&"style.missing_input_schema".to_string()));
    }

    #[test]
    fn style_generated_node_id() {
        let nodes = json!([
            { "id": "code_lj9abc_3", "type": "code", "label": "x", "config": { "code": "return 1" } },
            { "id": "resp_ok", "type": "response", "config": {} }
        ]);
        let edges = json!([{"from":"code_lj9abc_3","to":"resp_ok"}]);
        let c = codes(&snap_full("manual", None, nodes, edges));
        assert!(c.contains(&"style.generated_node_id".to_string()));
        assert_eq!(c.iter().filter(|x| *x == "style.generated_node_id").count(), 1);
    }

    #[test]
    fn style_bare_except_and_typed_except() {
        let bare = json!([{ "id": "c", "type": "code", "config": { "code": "try:\n    x()\nexcept:\n    pass\n" } }]);
        assert!(codes(&snap_full("manual", None, bare, json!([]))).contains(&"style.bare_except".to_string()));
        let js = json!([{ "id": "c", "type": "code", "config": { "code": "try { x() } catch (e) {}" } }]);
        assert!(codes(&snap_full("manual", None, js, json!([]))).contains(&"style.bare_except".to_string()));
        let typed = json!([{ "id": "c", "type": "code", "config": { "code": "try:\n    x()\nexcept ValueError:\n    return {}\n" } }]);
        assert!(!codes(&snap_full("manual", None, typed, json!([]))).contains(&"style.bare_except".to_string()));
    }

    #[test]
    fn style_http_in_code() {
        let nodes = json!([{ "id": "c", "type": "code", "config": { "code": "http.post(url, {})" } }]);
        assert!(codes(&snap_full("manual", None, nodes, json!([]))).contains(&"style.http_in_code".to_string()));
    }
```

Add in `mod.rs` `orch_tests` (or a new `lint_tests` module in `mod.rs`):

```rust
    #[test]
    fn lint_unsaved_rejects_non_array_and_sorts() {
        assert!(lint_unsaved("endpoint", None, &json!({}), &json!([])).is_err());
        let nodes = json!([
            { "id": "h", "type": "http_call", "config": { "headers": { "Authorization": "Bearer ***" } } },
            { "id": "c", "type": "code", "config": { "code": "http.get(u)" } }
        ]);
        let out = lint_unsaved("endpoint", None, &nodes, &json!([])).unwrap();
        let idx_secret = out.iter().position(|f| f.code == "hardcoded_secret").unwrap();
        let idx_style = out.iter().position(|f| f.code == "style.http_in_code").unwrap();
        assert!(idx_secret < idx_style);
        assert!(out.iter().any(|f| f.code == "style.missing_input_schema"));
    }
```

Compile will fail until `input_schema` exists on every `WorkflowSnapshot { ... }` in `provider.rs` tests and `orch_tests`. Add `input_schema: None` there in Step 3 (not before the test fail, except you must add the field to the struct for tests to compile — **do** add the field as `Option<Value>` defaulting tests to `None` so new tests compile and fail on missing rule codes).

Order: add `input_schema: None` to the struct and all literals first so the crate compiles; new tests fail because `scan_rules` does not emit `style.*`.

- [x] **Step 2: Run tests to verify they fail**

Run: `cargo test -p onebase --lib workflow_qa:: -- --nocapture`

Expected: FAIL on the new `style_*` / `lint_unsaved` tests (`assert!` false). Existing 23 tests still pass.

- [x] **Step 3: Implement rules + lint_unsaved**

In `scan_rules`:
- If `wf.trigger_type == "endpoint"` and `wf.input_schema` is `None` or not a JSON object → one `style.missing_input_schema` finding, `node_id=None`.
- For each node, if `id` matches `format!("^{}_[a-z0-9]+_[0-9]+$", regex_escape(type))` → `style.generated_node_id`.
- If `type==code` and bare-except / empty-catch matches → `style.bare_except`.
- If `type==code` and code contains the four `http.*` tokens → `style.http_in_code`.

`snapshot_from_value`: `input_schema: v.get("input_schema").cloned().filter(|x| !x.is_null())`.

`review_local` copies `input_schema` onto the redacted snapshot unchanged.

`lint_unsaved`:

```rust
pub fn lint_unsaved(
    trigger_type: &str,
    input_schema: Option<&Value>,
    nodes: &Value,
    edges: &Value,
) -> Result<Vec<Finding>, String> {
    if !nodes.is_array() {
        return Err("nodes 必须是 JSON 数组".into());
    }
    if !edges.is_array() {
        return Err("edges 必须是 JSON 数组".into());
    }
    let wf = WorkflowSnapshot {
        id: 0,
        slug: String::new(),
        name: String::new(),
        department: None,
        trigger_type: trigger_type.to_string(),
        input_schema: input_schema.cloned(),
        nodes: nodes.clone(),
        edges: edges.clone(),
    };
    let (_red, mut rules) = review_local(&wf);
    sort_findings(&mut rules);
    Ok(rules)
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cargo test -p onebase --lib workflow_qa:: -- --nocapture`

Expected: all `workflow_qa` tests PASS (old + new).

- [ ] **Step 5: Commit (only if the user asked)**

```bash
git add src/workflow_qa
git commit -m "feat: add workflow style lint rules for save-time warnings."
```

---

### Task 2: QA HTTP endpoint

**Files:**
- Modify: `src/workflow_handlers.rs` — add request struct + `qa_workflow` next to `debug_workflow` (~line 2811)
- Modify: `src/main.rs` — register `POST /api/admin/workflows/qa` immediately after the `debug` route (must be before `/:id`)

**Interfaces:**
- Consumes: `resolve_tenant_for_workflow_input`, `onebase::workflow_qa::{lint_unsaved, Finding}` — **bin crate**: `workflow_qa` is on the lib crate, so the handler uses `onebase::workflow_qa::lint_unsaved` (same as `mcp_tools`).
- Produces:
  - `pub struct QaWorkflowRequest { pub nodes: Value, pub edges: Value, pub database_id: Option<i32>, pub tenant_id: Option<i32>, pub trigger_type: Option<String>, pub input_schema: Option<Value> }`
  - `pub async fn qa_workflow(...) -> Result<Json<Value>>`

Handler body (do **not** call `parse_definition` / `validate_definition`):

```rust
pub async fn qa_workflow(
    State(pool): State<PgPool>,
    axum::Extension(claims): axum::Extension<Claims>,
    Json(req): Json<QaWorkflowRequest>,
) -> Result<Json<Value>> {
    let _ = resolve_tenant_for_workflow_input(&pool, &claims, req.database_id, req.tenant_id).await?;
    let trigger = req.trigger_type.as_deref().unwrap_or("manual");
    let schema = req.input_schema.as_ref().filter(|v| !v.is_null());
    let findings = onebase::workflow_qa::lint_unsaved(trigger, schema, &req.nodes, &req.edges)
        .map_err(AppError::InvalidQuery)?;
    Ok(Json(json!({ "findings": findings })))
}
```

`Finding` already serializes with lowercase severity.

Unit-test the mapping without a live server by testing `lint_unsaved` (already in Task 1). Optional handler test only if the crate already has handler unit tests that construct `QaWorkflowRequest` — **do not** add a DB integration test.

- [x] **Step 1: Write a compile-level assertion test in `workflow_handlers` only if cheap**

Skip a new failing handler test (no in-process HTTP harness for this module). Task 1 `lint_unsaved` covers 400-equivalent `Err`. Proceed to implement the route; verification is `cargo test --bin onebase mcp_tools::tests::test_tool_definitions_shape` plus `cargo check --bin onebase` to ensure `qa_workflow` links.

- [x] **Step 2: Implement handler + route**

In `src/main.rs` after the debug route:

```rust
        .route(
            "/api/admin/workflows/qa",
            post(workflow_handlers::qa_workflow),
        )
```

- [x] **Step 3: Verify compile**

Run:

```
cargo test -p onebase --lib workflow_qa:: -- --nocapture
cargo check --bin onebase
```

Expected: PASS / finished without errors.

- [ ] **Step 4: Commit (only if the user asked)**

```bash
git add src/workflow_handlers.rs src/main.rs
git commit -m "feat: add POST /api/admin/workflows/qa for unsaved lint."
```

---

### Task 3: Editor save modal

**Files:**
- Modify: `frontend-nextjs/components/workflow/WorkflowsManager.tsx`

**Interfaces:**
- Consumes: `POST /api/admin/workflows/qa` via existing `api` axios instance; `Modal` (import default from `@/components/Modal`); `showToast`
- Produces: save flow that lints then persists

Finding type (local to the file):

```ts
type QaFinding = {
  severity: 'crit' | 'high' | 'med' | 'low'
  code: string
  title: string
  detail: string
  node_id?: string | null
  node_label?: string | null
  evidence?: string
}
```

- [x] **Step 1: Split persist out of `handleSave`**

In `WorkflowsManager.tsx`:
1. Import `Modal`.
2. Add state: `qaFindings: QaFinding[] | null` (`null` = modal closed).
3. Extract the current try/catch create/patch block (from building `payload` through `refreshList`) into `persistWorkflow` (same payload construction as today). `handleSave` keeps hard validation (`trigger_config` JSON, `parseInputSchemaForSave`, `normalizeNodesForExecution`, alert webhook JSON).
4. After hard validation succeeds, `POST /api/admin/workflows/qa` with:

```ts
{
  database_id: formMeta.database_id ? parseInt(formMeta.database_id) : null,
  trigger_type: formMeta.trigger_type,
  input_schema: parsedInputSchema.value,
  nodes: cleanNodes,
  edges: editorEdges,
}
```

5. If qa returns `findings.length === 0` → `persistWorkflow`.
6. If qa returns findings → `setQaFindings(findings)`.
7. If qa throws / non-2xx → `showToast('error', '规范预检失败，仍可保存')` and `setQaFindings([])` is wrong — use a sentinel: set findings to `[{ severity: 'low', code: 'style.qa_unavailable', title: '规范预检失败', detail: '仍可保存', node_id: null, node_label: null }]` **or** open the modal with empty list plus the toast and two buttons. Spec: still show 「仍然保存 / 取消」. Implement as: toast + `setQaFindings([])` and a flag `qaFailed` so the modal title becomes `规范预检失败` with body text `仍可保存。` and the same two buttons.

Simpler (follow spec literally): toast + open modal with `qaFindings` set to `[]` and `qaBlockedReason: '预检失败'` — title `规范预检失败，仍可保存`. Buttons: 仍然保存 / 返回修改.

8. Modal (`size="md"`, `closeOnOverlayClick={false}`):
   - title: `qaBlockedReason` or `保存前有 ${qaFindings.length} 条提醒`
   - list findings when length > 0: color dot (`crit` red, `high` orange, `med` amber, `low` gray), `title`, optional `node_label`, `detail`
   - footer: button `返回修改` → `setQaFindings(null)` (and clear fail reason); primary `仍然保存` → close modal, `persistWorkflow()`

9. Do **not** skip qa on the next save after 仍然保存.

`persistWorkflow` must rebuild payload the same way (or handleSave stores the last `payload` in a ref when opening the modal so 仍然保存 does not re-normalize). Use a `pendingPayloadRef` set right before qa, reused by 仍然保存.

- [ ] **Step 2: Manual check (no Jest)**

With the app running:
1. New endpoint workflow, no `input_schema`, one palette-added code node → Save → modal lists `style.missing_input_schema` and `style.generated_node_id`.
2. 返回修改 → still in editor, no new row in the list.
3. 仍然保存 → workflow created, back to list.
4. Break trigger JSON → alert, no modal.

- [ ] **Step 3: Commit (only if the user asked)**

```bash
git add frontend-nextjs/components/workflow/WorkflowsManager.tsx
git commit -m "feat: show workflow QA warnings in a save confirmation modal."
```

---

### Task 4: Spec status

**Files:**
- Modify: `docs/superpowers/specs/2026-09-09-workflow-qa-save-warnings-design.md` — `状态：待评审` → `状态：已通过`

- [x] **Step 1: Flip the status line**

- [ ] **Step 2: Commit (only if the user asked)**

```bash
git add docs/superpowers/specs/2026-09-09-workflow-qa-save-warnings-design.md
git commit -m "docs: mark workflow save-warning design implemented."
```

---

## Spec coverage (self-review)

| Spec | Task |
|---|---|
| 4 style rules + existing 7 | 1 |
| `input_schema` on snapshot | 1 |
| sort order | 1 |
| `POST .../qa` + auth + 200/400 | 2 |
| Modal save / dismiss / qa fail still save | 3 |
| No AI Provider call, no engine validate, no TS rules | Global Constraints |
| MCP picks up style rules automatically | 1 (`scan_rules`) |
| Spec status | 4 |
