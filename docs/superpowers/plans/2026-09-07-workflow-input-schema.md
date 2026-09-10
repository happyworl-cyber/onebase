# Workflow `input_schema` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let authors declare a workflow-level JSON Schema (`input_schema`) so API docs, MCP, and the public share page show real request bodies instead of guessing from `{{trigger.xxx}}`.

**Architecture:** Store `input_schema` as a nullable JSONB column on `workflows` and `workflow_versions`. A dedicated module `resolve_doc_inputs(schema, nodes)` is the only place that turns schema-or-scan into `DocInputField[]`. Editor, public doc, and MCP all call it. No AST scan, no runtime 400 validation, no form builder.

**Tech Stack:** Rust / Axum / sqlx, Next.js editor, existing JSON Schema subset (no `jsonschema` crate).

**Spec:** `docs/superpowers/specs/2026-09-07-workflow-input-schema-design.md`

## Global Constraints

- A 档 only: persist + docs + JSON textarea. Do not add Endpoint JSON Schema validation, form panels, debug auto-forms, or code-node AST scanning
- Do not introduce the `jsonschema` crate
- `NULL` / omitted schema keeps today’s `{{trigger.xxx}}` scan; a JSON object (even empty `properties`) is author-declared and must not fall back to scan
- Save rejects non-object `input_schema` with HTTP 400: `input_schema 必须是 JSON object 或 null`
- `trigger_config` stays trigger mechanics only; do not stuff schema into it
- Changing `input_schema` (including explicit `null`) writes a version snapshot; restore writes it back
- `DocModel.input_fields` becomes an object array in the same deploy as the public share page
- Repo has no frontend unit-test runner; frontend tasks end with a concrete manual check
- Do not commit unless the user asked; skip `git commit` steps if this session did not request commits, but still finish the code and verification
- Do not auto-fill schema on existing workflows (e.g. 账号密码登录)

## File map

| Path | Responsibility |
|------|----------------|
| `src/workflow_input_schema.rs` | validate, `scan_trigger_fields`, `resolve_doc_inputs`, sample body |
| `src/main.rs` | `mod workflow_input_schema` |
| `migrations/063_workflow_input_schema.sql` | JSONB columns |
| `src/workflow_handlers.rs` | structs, SQL write/restore/import/duplicate, `build_doc_model` |
| `src/mcp_tools.rs` | tool schemas, `NODE_SPEC`, `workflow_api_doc` |
| `mcp-server/src/index.ts` | TS MCP create/update `input_schema` |
| `frontend-nextjs/components/workflow/WorkflowDocContent.tsx` | DocModel + render + `deriveDocModel` |
| `frontend-nextjs/components/workflow/WorkflowsManager.tsx` | types, save, load, export-from-editor |
| `frontend-nextjs/components/workflow/WorkflowEditorHeader.tsx` | 入参定义 JSON field |
| `frontend-nextjs/components/workflow/list/types.ts` | `WorkflowListItem.input_schema` |
| `frontend-nextjs/components/workflow/list/exportUtils.ts` | export envelope |
| `frontend-nextjs/components/workflow/version/types.ts` | snapshot type |

---

### Task 1: Resolver module (schema vs scan)

**Files:**
- Create: `src/workflow_input_schema.rs`
- Modify: `src/main.rs` (add `mod workflow_input_schema;` next to `mod workflow_handlers;`)
- Modify: `src/mcp_tools.rs` — delete the local `scan_trigger_fields` body; re-export from the new module so existing tests keep compiling (`pub use crate::workflow_input_schema::scan_trigger_fields;`). Move the three `test_scan_trigger_fields_*` tests into `workflow_input_schema.rs`.

**Interfaces:**
- Consumes: `crate::error::{AppError, Result}`, `serde_json::{json, Value}`
- Produces:
  - `pub enum InputSource { Schema, Scan }` with `as_str() -> &'static str` (`"schema"` / `"scan"`)
  - `pub enum InputRequired { Yes, No, Conditional }` with `as_str() -> &'static str` (`"yes"` / `"no"` / `"conditional"`)
  - `pub struct DocInputField { pub field: String, pub type_name: Option<String>, pub description: Option<String>, pub required: InputRequired, pub example: Option<Value>, pub template: String }`
  - `impl DocInputField { pub fn to_json(&self) -> Value }`
  - `pub fn validate_input_schema(value: Option<&Value>) -> Result<Option<Value>>`
  - `pub fn scan_trigger_fields(nodes: &Value) -> Vec<String>` (move unchanged from `mcp_tools.rs`)
  - `pub fn resolve_doc_inputs(input_schema: Option<&Value>, nodes: &Value) -> (InputSource, Vec<DocInputField>)`
  - `pub fn sample_body_from_fields(fields: &[DocInputField]) -> Value`

- [ ] **Step 1: Write failing tests in a new module**

Create `src/workflow_input_schema.rs` with the public signatures as `todo!()` / empty stubs plus these tests (copy `scan_trigger_fields` tests from `src/mcp_tools.rs` 696–721 unchanged, then add):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // --- existing scan_trigger_fields tests, moved verbatim ---

    #[test]
    fn resolve_null_schema_scans_nodes() {
        let nodes = json!([{
            "id": "t",
            "type": "transform",
            "config": { "v": "{{trigger.user_id}}" }
        }]);
        let (source, fields) = resolve_doc_inputs(None, &nodes);
        assert_eq!(source, InputSource::Scan);
        assert_eq!(fields.iter().map(|f| f.field.as_str()).collect::<Vec<_>>(), ["user_id"]);
        assert_eq!(fields[0].required, InputRequired::No);
        assert_eq!(fields[0].template, "{{trigger.user_id}}");
        assert!(fields[0].type_name.is_none());
    }

    #[test]
    fn resolve_schema_ignores_node_trigger_refs() {
        let schema = json!({
            "type": "object",
            "properties": {
                "email": { "type": "string", "description": "邮箱", "example": "a@b.com" },
                "password": { "type": "string", "required": true }
            },
            "required": ["password"],
            "oneOf": [{ "required": ["email"] }, { "required": ["phone"] }]
        });
        let nodes = json!([{
            "id": "c",
            "type": "code",
            "config": { "source": "{{trigger.other}}" }
        }]);
        let (source, fields) = resolve_doc_inputs(Some(&schema), &nodes);
        assert_eq!(source, InputSource::Schema);
        let names: Vec<_> = fields.iter().map(|f| f.field.as_str()).collect();
        assert_eq!(names, ["email", "password"]);
        let email = fields.iter().find(|f| f.field == "email").unwrap();
        assert_eq!(email.type_name.as_deref(), Some("string"));
        assert_eq!(email.description.as_deref(), Some("邮箱"));
        assert_eq!(email.required, InputRequired::Conditional);
        assert_eq!(email.example, Some(json!("a@b.com")));
        let password = fields.iter().find(|f| f.field == "password").unwrap();
        assert_eq!(password.required, InputRequired::Yes);
    }

    #[test]
    fn resolve_empty_properties_is_declared_empty() {
        let schema = json!({ "type": "object", "properties": {} });
        let nodes = json!([{
            "id": "t",
            "type": "transform",
            "config": { "v": "{{trigger.user_id}}" }
        }]);
        let (source, fields) = resolve_doc_inputs(Some(&schema), &nodes);
        assert_eq!(source, InputSource::Schema);
        assert!(fields.is_empty());
    }

    #[test]
    fn resolve_object_without_properties_is_declared_empty() {
        let schema = json!({ "type": "object" });
        let (source, fields) = resolve_doc_inputs(Some(&schema), &json!([]));
        assert_eq!(source, InputSource::Schema);
        assert!(fields.is_empty());
    }

    #[test]
    fn sample_body_prefers_example_then_type() {
        let fields = vec![
            DocInputField {
                field: "email".into(),
                type_name: Some("string".into()),
                description: None,
                required: InputRequired::Yes,
                example: Some(json!("a@b.com")),
                template: "{{trigger.email}}".into(),
            },
            DocInputField {
                field: "age".into(),
                type_name: Some("integer".into()),
                description: None,
                required: InputRequired::No,
                example: None,
                template: "{{trigger.age}}".into(),
            },
            DocInputField {
                field: "ok".into(),
                type_name: Some("boolean".into()),
                description: None,
                required: InputRequired::No,
                example: None,
                template: "{{trigger.ok}}".into(),
            },
        ];
        assert_eq!(
            sample_body_from_fields(&fields),
            json!({ "email": "a@b.com", "age": 0, "ok": false })
        );
    }

    #[test]
    fn validate_rejects_non_object() {
        assert!(validate_input_schema(Some(&json!([]))).is_err());
        assert!(validate_input_schema(Some(&json!("x"))).is_err());
        assert_eq!(validate_input_schema(None).unwrap(), None);
        assert_eq!(validate_input_schema(Some(&Value::Null)).unwrap(), None);
        assert!(validate_input_schema(Some(&json!({}))).unwrap().unwrap().is_object());
    }
}
```

- [ ] **Step 2: Register the module and run tests to see them fail**

In `src/main.rs`, add `mod workflow_input_schema;` immediately after `mod workflow_handlers;`.

In `src/mcp_tools.rs`, replace the `pub fn scan_trigger_fields` function with:

```rust
pub use crate::workflow_input_schema::scan_trigger_fields;
```

Delete the three `test_scan_trigger_fields_*` tests from `mcp_tools.rs` (they now live in the new module). Keep `test_require_id_rejects_out_of_i32_range`.

Run:

```bash
cargo test --bin onebase resolve_null_schema_scans_nodes -- --nocapture
```

Expected: FAIL (function missing or `todo!()`).

- [ ] **Step 3: Implement the module**

`validate_input_schema`: `None` / `Null` → `Ok(None)`; object → `Ok(Some(clone))`; else `Err(AppError::InvalidQuery("input_schema 必须是 JSON object 或 null".into()))`.

`scan_trigger_fields`: move the existing implementation from `mcp_tools.rs` unchanged (char scan for `{{` + `trigger.` + alphanumeric/`_`/`-`).

`resolve_doc_inputs`:

- If `input_schema` is `Some` and `is_object()` → `(InputSource::Schema, fields_from_schema(schema))`. Do **not** scan nodes.
- Otherwise → scan nodes, map each name to `DocInputField { field, type_name: None, description: None, required: No, example: None, template: "{{trigger.{field}}}" }`, then sort by `field`.

`fields_from_schema`:

- Read `properties` object; missing or non-object → empty vec.
- Top-level `required` array → `HashSet<String>`.
- Collect conditional names from each `oneOf` / `anyOf` branch’s `required` array.
- For each property name (sorted):
  - `type` / `description` / `example` from the property object
  - `required`: `Yes` if name is in top-level `required` **or** property has `"required": true`; else `Conditional` if in the oneOf/anyOf set; else `No`
  - `template`: `{{trigger.<name>}}`

`sample_body_from_fields`: for each field, use `example` if present; else placeholder by `type_name`: `number`/`integer` → `0`, `boolean` → `false`, `object` → `{}`, `array` → `[]`, else `"<field>"`.

`DocInputField::to_json`:

```rust
json!({
    "field": self.field,
    "type": self.type_name,
    "description": self.description,
    "required": self.required.as_str(),
    "example": self.example,
    "template": self.template,
})
```

(`type` / `description` / `example` may be JSON `null` when `None`.)

- [ ] **Step 4: Run the new tests**

```bash
cargo test --bin onebase workflow_input_schema -- --nocapture
```

Expected: all tests in this module PASS, including the moved scan tests.

- [ ] **Step 5: Commit (only if the user asked)**

```bash
git add src/workflow_input_schema.rs src/main.rs src/mcp_tools.rs
git commit -m "feat: 工作流入参 schema 解析，文档不再只靠扫描 trigger 模板。"
```

---

### Task 2: Persist `input_schema` on workflows and versions

**Files:**
- Create: `migrations/063_workflow_input_schema.sql`
- Modify: `src/workflow_handlers.rs`

**Interfaces:**
- Consumes: `crate::workflow_input_schema::validate_input_schema`
- Produces: `Workflow.input_schema: Option<Value>`, `WorkflowVersion.input_schema: Option<Value>`, create/update/import accept and persist it

- [ ] **Step 1: Add the migration**

Create `migrations/063_workflow_input_schema.sql`:

```sql
ALTER TABLE management.workflows
  ADD COLUMN IF NOT EXISTS input_schema JSONB DEFAULT NULL;

ALTER TABLE management.workflow_versions
  ADD COLUMN IF NOT EXISTS input_schema JSONB DEFAULT NULL;
```

- [ ] **Step 2: Extend structs**

On `Workflow` (after `trigger_config`):

```rust
pub input_schema: Option<Value>,
```

On `WorkflowVersion` (after `trigger_config`):

```rust
pub input_schema: Option<Value>,
```

On `CreateWorkflowRequest`:

```rust
pub input_schema: Option<Value>,
```

On `UpdateWorkflowRequest` (same pattern as `alert_webhook_url`):

```rust
#[serde(default)]
pub input_schema: Option<Option<Value>>,
```

On `ImportWorkflowDef`:

```rust
pub input_schema: Option<Value>,
```

Add `input_schema: None` to `dummy_workflow` in the handler tests (~line 4777).

- [ ] **Step 3: Validate and write on create / update / snapshot / restore / duplicate / import**

**Create** (`create_workflow`): before INSERT, `let input_schema = validate_input_schema(req.input_schema.as_ref())?;`. Add `input_schema` to the INSERT column list and bind it (after `trigger_config` is fine).

**Update**: resolve the value first:

```rust
let input_schema_provided = req.input_schema.is_some();
let input_schema_value = match req.input_schema.as_ref() {
    None => existing.input_schema.clone(),
    Some(None) => None,
    Some(Some(v)) => validate_input_schema(Some(v))?,
};
```

SQL: do **not** use `COALESCE` (cannot set NULL). Add:

```sql
input_schema = CASE WHEN $N THEN $N+1 ELSE input_schema END
```

Bind `$N = input_schema_provided`, `$N+1 = input_schema_value`.

Snapshot when definition changes — extend the existing condition (~1745):

```rust
if req.nodes.is_some()
    || req.edges.is_some()
    || req.dependencies.is_some()
    || req.input_schema.is_some()
```

Also set the audit `definition_changed` flag with the same four predicates.

Leave `def_changed` for node-level op-log diff as `req.nodes.is_some() || req.edges.is_some()`. Schema-only edits go through `workflow_config_diff`.

**`workflow_config_diff`:** if `old.input_schema != new.input_schema`, push `{ "field": "入参定义", "old": <compact json or "">, "new": <compact json or ""> }`.

**`snapshot_workflow_version`:** add `input_schema` to INSERT columns/VALUES and `.bind(&workflow.input_schema)`.

**`restore_workflow_version`:** add `input_schema = $…` to the UPDATE and bind `&snapshot.input_schema`.

**`duplicate_workflow`:** add `input_schema` to INSERT and bind `&src.input_schema`.

**Import create + overwrite:** `let input_schema = validate_input_schema(wf.input_schema.as_ref())?;` then write the column on both INSERT and UPDATE.

- [ ] **Step 4: Compile and run related tests**

```bash
cargo test --bin onebase workflow_input_schema -- --nocapture
cargo test --bin onebase dummy_workflow -- --nocapture
cargo check --bin onebase
```

Expected: compile succeeds; existing handler unit tests still pass. Apply the migration on the dev DB the same way this repo normally does (existing `migrate` bin / compose). Do not invent a new migrate path.

- [ ] **Step 5: Commit (only if the user asked)**

```bash
git add migrations/063_workflow_input_schema.sql src/workflow_handlers.rs
git commit -m "feat: 工作流与版本快照持久化 input_schema。"
```

---

### Task 3: Doc generation + MCP

**Files:**
- Modify: `src/workflow_handlers.rs` (`build_doc_model`, `public_workflow_doc`)
- Modify: `src/mcp_tools.rs` (`tool_workflow_api_doc`, create/update/`workflow_api_doc` tool schemas, `NODE_SPEC`)
- Modify: `mcp-server/src/index.ts`

**Interfaces:**
- Consumes: `resolve_doc_inputs`, `sample_body_from_fields`, `DocInputField::to_json`
- Produces: `DocModel.input_source` + object-array `input_fields`; MCP `workflow_api_doc` same shape

- [ ] **Step 1: Switch `build_doc_model` to the resolver**

Change signature to take `input_schema: Option<&Value>`. Replace `scan_trigger_fields` + sort with:

```rust
let (input_source, fields) =
    crate::workflow_input_schema::resolve_doc_inputs(input_schema, nodes);
let input_fields: Vec<Value> = fields.iter().map(|f| f.to_json()).collect();
```

Add to the returned JSON: `"input_source": input_source.as_str()`, `"input_fields": input_fields`.

In `public_workflow_doc`, add `input_schema` to the SELECT list, `let input_schema: Option<Value> = row.try_get("input_schema").ok();`, and pass `input_schema.as_ref()` into `build_doc_model`.

- [ ] **Step 2: Switch `tool_workflow_api_doc`**

Replace the local `scan_trigger_fields` + `"示例值"` sample with:

```rust
let (source, fields) = crate::workflow_input_schema::resolve_doc_inputs(
    workflow.get("input_schema"),
    workflow.get("nodes").unwrap_or(&Value::Null),
);
let sample_body = crate::workflow_input_schema::sample_body_from_fields(&fields);
```

`input_fields` = `fields.iter().map(|f| f.to_json()).collect()`. Add `"input_source": source.as_str()`. Notes:

- schema + empty: `"本工作流已声明无外部入参，传空 body 即可。"`
- schema + fields: `"字段来自工作流入参定义（input_schema）。"`
- scan + empty: keep `"未检测到 {{trigger.字段}} 引用——本工作流不依赖外部入参，传空 body 即可。"`
- scan + fields: `"字段来自节点中 {{trigger.X}} 引用的自动扫描，类型需按业务确认。"`

Curl `-d` uses `serde_json::to_string(&sample_body)`.

- [ ] **Step 3: MCP tool schemas + `NODE_SPEC`**

In `src/mcp_tools.rs` create/update tool property maps add:

```json
"input_schema": {
  "type": "object",
  "description": "工作流入参 JSON Schema。有则接口文档以它为准；传 null 表示未声明（走 {{trigger.x}} 扫描）。更新此字段会打版本快照。"
}
```

Update `update_workflow` `version_note` description to: `版本备注；仅当本次更新改动了定义（含 nodes/node_patch/remove_node_ids/input_schema，产生新版本快照）时记录`.

Update `workflow_api_doc` tool description to: `生成工作流接口文档：优先读 input_schema，否则扫描节点中 {{trigger.X}} 引用。交付前生成给人看。`

In `NODE_SPEC`, after the `## 模板变量` section, insert:

```
## 工作流入参 input_schema（可选）
工作流顶层可声明 JSON Schema 对象 `input_schema`（create_workflow / update_workflow 的同名字段）。
接口文档优先读它生成参数表与 curl 示例；未声明（null）时才扫描节点里的 `{{trigger.X}}`。
code 节点直接读请求 body、节点里没有 `{{trigger.x}}` 时必须声明 `input_schema`，否则文档会误写成「无入参」。
本阶段只用于文档，引擎不按 schema 校验请求。
```

In `mcp-server/src/index.ts`, add to both create and update zod schemas:

```ts
input_schema: z.record(z.any()).nullable().optional().describe(
  "工作流入参 JSON Schema；null 表示未声明",
),
```

Update the update tool description: 同时传 nodes+edges **或 input_schema** 会触发版本快照。

- [ ] **Step 4: Compile**

```bash
cargo test --bin onebase workflow_input_schema -- --nocapture
cargo check --bin onebase
```

Expected: PASS / compile ok.

- [ ] **Step 5: Commit (only if the user asked)**

```bash
git add src/workflow_handlers.rs src/mcp_tools.rs mcp-server/src/index.ts
git commit -m "feat: 接口文档与 MCP 优先读 input_schema。"
```

---

### Task 4: Frontend DocModel and document UI

**Files:**
- Modify: `frontend-nextjs/components/workflow/WorkflowDocContent.tsx`
- Modify: `frontend-nextjs/components/workflow/WorkflowsManager.tsx` (`deriveDocModel` call site ~678)

**Interfaces:**
- Consumes: `meta.input_schema` string or object
- Produces: `DocModel.input_source` + `DocInputField[]` matching the Rust JSON keys

- [ ] **Step 1: Replace DocModel types and derivation**

In `WorkflowDocContent.tsx` replace `input_fields: string[]` with:

```ts
export type InputRequired = 'yes' | 'no' | 'conditional'

export interface DocInputField {
  field: string
  type?: string | null
  description?: string | null
  required: InputRequired
  example?: unknown
  template: string
}

export interface DocModel {
  // existing fields unchanged...
  input_source: 'schema' | 'scan'
  input_fields: DocInputField[]
  // ...
}
```

Rewrite `collectTriggerFields` to the same char rules as Rust (do not keep `[A-Za-z0-9_]` only). Scan `JSON.stringify(nodes)` for `{{` + optional space + `trigger.` + a run of letters/digits/`_`/`-` using `/\{\{\s*trigger\.([\p{L}\p{N}_-]+)/gu` (or a char loop). Return sorted unique names.

Add `fieldsFromSchema(schema: unknown): DocInputField[]` and `resolveDocInputs(schema: unknown, nodes)` mirroring Rust:

- schema is a non-null object → `{ source: 'schema', fields: fieldsFromSchema(schema) }`
- else scan → each name `{ field, required: 'no', template: \`{{trigger.${name}}}\` }`

`deriveDocModel` meta adds `input_schema?: string | Record<string, unknown> | null`. Parse string JSON if needed; ignore parse errors (treat as missing). Pass parsed value into `resolveDocInputs`.

`sampleBody(fields)` / `curlExample(url, fields, gatewayMode)` take `DocInputField[]`. Value rules: `example` if present; else `number`/`integer` → `0`, `boolean` → `false`, `object` → `{}`, `array` → `[]`, else `"<field>"`. Empty fields → `{}`.

- [ ] **Step 2: Update Markdown + on-screen 请求参数**

`buildDocMarkdown` and the 请求参数 `<section>`:

| `input_source` | has fields | empty |
|---|---|---|
| `schema` | Intro: `以下字段来自工作流入参定义（input_schema）。` Table columns: 字段 / 类型 / 必填 / 说明. `conditional` → `条件必填`, `yes` → `是`, `no` → `否` | `本工作流已声明无外部入参，传空 body 即可。` |
| `scan` | Keep current intro and 字段 / 模板引用 table | Keep `未检测到 {{trigger.字段}} 引用——本工作流不依赖外部入参，传空 body 即可。` |

GET hint that used `triggerFields[0]` becomes `model.input_fields[0]?.field`.

In `WorkflowsManager.tsx` `WorkflowDocModal`, pass `input_schema: meta.input_schema` into `deriveDocModel` (meta will gain the field in Task 5; for this task add it to the meta type the modal already receives, default `''`).

- [ ] **Step 3: Manual check**

Typecheck:

```bash
cd frontend-nextjs && npx tsc --noEmit --pretty false
```

Expected: no new errors in the files you touched. If `tsc` is too slow/noisy, at least confirm the editor compiles the two files (no red diagnostics on `DocModel` / `deriveDocModel`).

- [ ] **Step 4: Commit (only if the user asked)**

```bash
git add frontend-nextjs/components/workflow/WorkflowDocContent.tsx frontend-nextjs/components/workflow/WorkflowsManager.tsx
git commit -m "feat: 接口文档按 input_schema 渲染参数表与 curl。"
```

---

### Task 5: Editor JSON field, save/load, export/import

**Files:**
- Modify: `frontend-nextjs/components/workflow/WorkflowsManager.tsx`
- Modify: `frontend-nextjs/components/workflow/WorkflowEditorHeader.tsx`
- Modify: `frontend-nextjs/components/workflow/list/types.ts`
- Modify: `frontend-nextjs/components/workflow/list/exportUtils.ts`
- Modify: `frontend-nextjs/components/workflow/version/types.ts`

**Interfaces:**
- Consumes: API `workflow.input_schema`
- Produces: create/update/import payloads with `input_schema: object | null`

- [ ] **Step 1: Thread the field through types and form state**

`Workflow` / `WorkflowFormMeta` / `WorkflowListItem` / `WorkflowVersionSnapshot`: add `input_schema`.

- API objects: `input_schema: Record<string, unknown> | null`
- `WorkflowFormMeta.input_schema: string` (pretty JSON or `''`)

Helper (put next to `blankMeta` in `WorkflowsManager.tsx`):

```ts
function inputSchemaToForm(value: unknown): string {
  if (value == null || value === '') return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return ''
  }
}

function parseInputSchemaForSave(raw: string): { ok: true; value: Record<string, unknown> | null } | { ok: false; error: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: true, value: null }
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed === null) return { ok: true, value: null }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: '入参定义必须是 JSON 对象' }
    }
    return { ok: true, value: parsed }
  } catch {
    return { ok: false, error: '入参定义 JSON 格式错误' }
  }
}
```

`blankMeta()`: `input_schema: ''`.

Every `setFormMeta({...})` that hydrates from a workflow (`~993`, `~1257`) and draft merge (`~823`) must set `input_schema: inputSchemaToForm(wf.input_schema)`.

`handleSave` payload: parse with `parseInputSchemaForSave`; on error `alert(error)` and return; else `input_schema: value`.

`handleExportEditor`: same parse; on error toast; pass `input_schema: value` into `downloadWorkflowJson`.

- [ ] **Step 2: Header UI**

In `WorkflowEditorHeader.tsx`:

- `WorkflowFormMeta`-equivalent props already come from `formMeta`; add `input_schema: string` to the header’s meta type if it is duplicated there.
- Add `'input_schema'` to `TEXT_FIELD_KEYS`.
- Add a new row **below** the 备注 row (do not cram a textarea into the 50px inline row). Label: `入参定义`. Idle state: truncated one-line JSON, or italic `未声明（文档将扫描 {{trigger.x}}）`. Edit state: `<textarea>` (`min-h-[88px]`, mono, `rows={6}`), placeholder exactly:

```json
{
  "type": "object",
  "properties": {
    "email": { "type": "string", "description": "邮箱（与 phone 二选一）" },
    "phone": { "type": "string", "description": "手机号（与 email 二选一）" },
    "password": { "type": "string", "description": "密码" }
  },
  "required": ["password"],
  "oneOf": [{ "required": ["email"] }, { "required": ["phone"] }]
}
```

Show for every `trigger_type`. Commit on blur like `trigger_config`.

Pass `formMeta.input_schema` / `setFormMeta` through the existing header props (`WorkflowsManager` ~1502).

- [ ] **Step 3: Export / import**

`exportUtils.ts` `ExportableWorkflow` Pick add `'input_schema'`. Envelope `workflow` add `input_schema: wf.input_schema ?? null`.

`parseImportedWorkflowFile` does not strip unknown keys; once `ImportWorkflowDef` has the field, a file that includes `input_schema` will persist. No extra parser work unless the import UI rebuilds a whitelist — if it does, add `input_schema` to that whitelist.

- [ ] **Step 4: Manual verification**

1. `cd frontend-nextjs && npx tsc --noEmit --pretty false` (or confirm no new diagnostics on touched files).
2. Open a workflow whose first node is `code` and has no `{{trigger.x}}`. Open 接口文档 → still shows 未检测到 / empty body (scan fallback).
3. Paste the placeholder login schema into 入参定义, save, reopen 接口文档 → table lists email / phone / password with 条件必填 / 是; curl `-d` is not `{}`.
4. Clear 入参定义, save → docs fall back to scan.
5. Public share page (if you enable share) shows the same table as the modal.
6. MCP `workflow_api_doc` on that id returns `input_source: "schema"` and typed `input_fields`.

- [ ] **Step 5: Commit (only if the user asked)**

```bash
git add frontend-nextjs/components/workflow/WorkflowsManager.tsx \
  frontend-nextjs/components/workflow/WorkflowEditorHeader.tsx \
  frontend-nextjs/components/workflow/list/types.ts \
  frontend-nextjs/components/workflow/list/exportUtils.ts \
  frontend-nextjs/components/workflow/version/types.ts
git commit -m "feat: 编辑器与导入导出支持工作流入参 input_schema。"
```

---

## Self-review (spec coverage)

| Spec section | Task |
|---|---|
| JSONB columns on workflows + versions, default NULL | Task 2 |
| Create / update null-vs-missing / reject non-object | Task 1 validate + Task 2 write path |
| Duplicate + import copy/write schema | Task 2 |
| Snapshot + restore include schema; schema change snapshots | Task 2 |
| `resolve_doc_inputs` single function; schema wins; empty properties = declared empty | Task 1 |
| required / required:true / oneOf conditional | Task 1 |
| sample body example then type placeholder | Task 1 + Task 3/4 |
| `build_doc_model` + public SELECT + MCP `workflow_api_doc` | Task 3 |
| DocModel object fields + copy | Task 4 |
| Editor JSON box, all trigger types, placeholder | Task 5 |
| MCP create/update + `NODE_SPEC` + TS MCP | Task 3 |
| Export envelope | Task 5 |
| Align frontend scan with Rust (unicode / hyphen) | Task 4 |
| No AST / no runtime 400 / no form / no auto-backfill | Global Constraints |

No placeholders remain. Names (`resolve_doc_inputs`, `DocInputField`, `input_source`, `validate_input_schema`) are consistent across tasks.
