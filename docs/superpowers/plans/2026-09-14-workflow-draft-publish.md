# Workflow Draft / Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Saving a workflow writes a draft only; runtime keeps using the last published definition until the author explicitly publishes.

**Architecture:** `management.workflows` remains the live row. New `management.workflow_drafts` (1:1) holds unpublished definition fields. `published_version` NULL means never published and not callable. GET/list overlay the draft for the editor; triggers still `SELECT` the main row with `is_enabled AND published_version IS NOT NULL`.

**Tech Stack:** Postgres migrations, Axum/sqlx handlers, existing MCP tools, Next.js editor/list. No new crates.

**Spec:** `docs/superpowers/specs/2026-09-14-workflow-draft-publish-design.md`

## Global Constraints

- Runtime reads `management.workflows` only; never execute `workflow_drafts.nodes`
- Live gate is exactly `is_enabled = true AND published_version IS NOT NULL`
- Unpublish/disabled external triggers stay 404「不存在或未启用」
- Save / MCP create / MCP update do **not** write versions or change `published_version`
- Versions are written only on publish
- Restore writes a draft, does not go live
- `is_enabled`, tenant/database binding, alert webhook, doc-share stay immediate on the main row
- List folder move (`PATCH` only `department`/`category`) updates the main row and syncs those two columns on an existing draft
- Do not add draft diff, approval, scheduled publish, multi-branch drafts, or an 「未发布」list filter
- Do not commit unless the user asked; skip `git commit` steps if this session did not request commits, but still finish the code and verification
- Repo has no frontend unit-test runner; UI tasks end with a concrete manual check

## File map

| Path | Responsibility |
|------|----------------|
| `migrations/067_workflow_drafts.sql` | `published_version`, `workflow_drafts`, backfill |
| `src/migrate.rs` | Register 067 in `MIGRATIONS` |
| `src/error.rs` | `AppError::Conflict` → HTTP 409 |
| `src/workflow_draft.rs` | Draft row, overlay, slug conflict, upsert/delete SQL |
| `src/workflow_handlers.rs` | `Workflow` fields; create/update/get/list; publish; discard; restore; import; duplicate; trigger |
| `src/main.rs` | `mod workflow_draft`; `POST /:id/publish` and `/:id/discard-draft` |
| Trigger / engine / scheduler / sse files | Live SQL gate |
| `src/mcp_tools.rs` | Tool text + `publish_workflow` / `discard_workflow_draft` |
| `mcp-server/src/index.ts` | HTTP wrappers |
| `WorkflowEditorHeader.tsx` / `WorkflowsManager.tsx` | Save / publish / discard |
| `list/types.ts` / `WorkflowRow.tsx` / `RowMenu.tsx` | Badges and row actions |

---

### Task 1: Migration 067

**Files:**
- Create: `migrations/067_workflow_drafts.sql`
- Modify: `src/migrate.rs` — append after the `"066 project log sources"` entry

**Interfaces:**
- Consumes: existing `management.workflows`, `management.workflow_versions`
- Produces: `workflows.published_version INTEGER`; table `management.workflow_drafts`

- [ ] **Step 1: Write the migration**

```sql
-- 工作流草稿 / 已发布指针。
-- workflows = 线上定义；workflow_drafts = 未发布编辑稿；published_version NULL = 从未发布。

ALTER TABLE management.workflows
    ADD COLUMN IF NOT EXISTS published_version INTEGER;

CREATE TABLE IF NOT EXISTS management.workflow_drafts (
    workflow_id    INTEGER PRIMARY KEY REFERENCES management.workflows(id) ON DELETE CASCADE,
    name           VARCHAR(200) NOT NULL,
    slug           VARCHAR(64) NOT NULL,
    description    TEXT,
    category       VARCHAR(64),
    department     VARCHAR(64),
    trigger_type   VARCHAR(20) NOT NULL DEFAULT 'endpoint',
    trigger_config JSONB NOT NULL DEFAULT '{}',
    input_schema   JSONB,
    nodes          JSONB NOT NULL DEFAULT '[]',
    edges          JSONB NOT NULL DEFAULT '[]',
    dependencies   JSONB NOT NULL DEFAULT '{}'::jsonb,
    timeout_ms     INTEGER NOT NULL DEFAULT 30000,
    max_retries    INTEGER NOT NULL DEFAULT 0,
    note           VARCHAR(500),
    updated_by     INTEGER,
    updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_drafts_slug
    ON management.workflow_drafts (slug);

-- 没有版本快照的旧行补 v1，然后全部视为已发布。
INSERT INTO management.workflow_versions
    (workflow_id, version, name, slug, description, category, department,
     trigger_type, trigger_config, input_schema, nodes, edges, timeout_ms, max_retries,
     note, created_by)
SELECT w.id, 1, w.name, w.slug, w.description, w.category, w.department,
       w.trigger_type, w.trigger_config, w.input_schema, w.nodes, w.edges,
       w.timeout_ms, w.max_retries, '迁移标记已发布', w.created_by
FROM management.workflows w
WHERE NOT EXISTS (
    SELECT 1 FROM management.workflow_versions v WHERE v.workflow_id = w.id
);

UPDATE management.workflows w
SET published_version = (
    SELECT MAX(v.version) FROM management.workflow_versions v WHERE v.workflow_id = w.id
)
WHERE w.published_version IS NULL;
```

- [ ] **Step 2: Register in `src/migrate.rs`**

After the 066 tuple:

```rust
    (
        "067 workflow drafts",
        include_str!("../migrations/067_workflow_drafts.sql"),
    ),
```

- [ ] **Step 3: Apply locally**

Run: `cargo run --bin migrate_all`

Expected: 067 executes (or skipped if already applied); `errors = 0`. Confirm with:

```sql
SELECT column_name FROM information_schema.columns
 WHERE table_schema='management' AND table_name='workflows' AND column_name='published_version';
SELECT COUNT(*) FROM management.workflow_drafts;
SELECT COUNT(*) FILTER (WHERE published_version IS NULL) FROM management.workflows;
```

Existing rows must have `published_version IS NOT NULL`. Draft table empty.

- [ ] **Step 4: Commit** (skip if the user did not ask)

```bash
git add migrations/067_workflow_drafts.sql src/migrate.rs
git commit -m "$(cat <<'EOF'
feat: 工作流草稿表与 published_version 回填。

EOF
)"
```

---

### Task 2: Draft overlay helpers + 409 Conflict

**Files:**
- Create: `src/workflow_draft.rs`
- Modify: `src/main.rs` — `mod workflow_draft;` next to `mod workflow_handlers;`
- Modify: `src/error.rs` — add `Conflict(String)`
- Modify: `src/workflow_handlers.rs` — add `published_version` / `has_unpublished` on `Workflow`

**Interfaces:**
- Consumes: `crate::workflow_handlers::Workflow`, `crate::error::AppError`
- Produces:
  - `pub struct WorkflowDraft { workflow_id: i32, name: String, slug: String, description: Option<String>, category: Option<String>, department: Option<String>, trigger_type: String, trigger_config: Value, input_schema: Option<Value>, nodes: Value, edges: Value, dependencies: Value, timeout_ms: i32, max_retries: i32, note: Option<String>, updated_by: Option<i32>, updated_at: chrono::NaiveDateTime }`
  - `pub const EMPTY_GRAPH: &str` not needed; use `json!([])`
  - `pub fn workflow_is_live(wf: &Workflow) -> bool` — `wf.is_enabled && wf.published_version.is_some()`
  - `pub fn apply_draft(wf: &mut Workflow, draft: &WorkflowDraft)` — copies definition fields; sets `has_unpublished = true`; does **not** touch `is_enabled`, `tenant_id`, `database_id`, alerts, `published_version`, ids, timestamps except callers may set `updated_at` from draft
  - `pub fn editor_view(mut wf: Workflow, draft: Option<WorkflowDraft>) -> Workflow` — if draft Some, `apply_draft`; else `has_unpublished = false`
  - `Workflow.published_version: Option<i32>` with `#[serde(default)] #[sqlx(default)]`
  - `Workflow.has_unpublished: bool` with `#[serde(default)] #[sqlx(default)]` (not a DB column)
  - `Workflow.published_slug: Option<String>` with `#[serde(default)] #[sqlx(default)]` (not a DB column). `apply_draft` sets it to the pre-overlay slug when `published_version` is Some; never-published stays `None`. Editor uses it for the live endpoint path.
  - `AppError::Conflict(String)` → 409, `code: "conflict"`

- [ ] **Step 1: Write failing overlay tests in `src/workflow_draft.rs`**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn live_wf() -> Workflow {
        Workflow {
            id: 1,
            tenant_id: Some(9),
            database_id: Some(2),
            name: "live".into(),
            slug: "live".into(),
            description: Some("L".into()),
            category: Some("cat".into()),
            department: Some("dept".into()),
            trigger_type: "endpoint".into(),
            trigger_config: json!({}),
            input_schema: None,
            nodes: json!([{"id":"a"}]),
            edges: json!([]),
            dependencies: json!({"javascript": {"lodash": "4.0.0"}}),
            is_enabled: true,
            timeout_ms: 30_000,
            max_retries: 0,
            alert_webhook_url: Some("https://example.com".into()),
            alert_webhook_template: None,
            alert_throttle_hours: 24,
            last_alert_sent_at: None,
            created_by: None,
            created_at: chrono::NaiveDateTime::from_timestamp_opt(0, 0).unwrap(),
            updated_at: chrono::NaiveDateTime::from_timestamp_opt(0, 0).unwrap(),
            created_by_name: None,
            created_by_email: None,
            published_version: Some(3),
            has_unpublished: false,
            published_slug: None,
        }
    }

    fn draft() -> WorkflowDraft {
        WorkflowDraft {
            workflow_id: 1,
            name: "draft".into(),
            slug: "draft".into(),
            description: None,
            category: Some("new-cat".into()),
            department: Some("dept".into()),
            trigger_type: "manual".into(),
            trigger_config: json!({"x": 1}),
            input_schema: Some(json!({"type": "object"})),
            nodes: json!([{"id":"b"}]),
            edges: json!([{"from":"b","to":"b"}]),
            dependencies: json!({}),
            timeout_ms: 12_000,
            max_retries: 2,
            note: Some("n".into()),
            updated_by: Some(1),
            updated_at: chrono::NaiveDateTime::from_timestamp_opt(1, 0).unwrap(),
        }
    }

    #[test]
    fn live_requires_enabled_and_published_version() {
        let mut wf = live_wf();
        assert!(workflow_is_live(&wf));
        wf.is_enabled = false;
        assert!(!workflow_is_live(&wf));
        wf.is_enabled = true;
        wf.published_version = None;
        assert!(!workflow_is_live(&wf));
    }

    #[test]
    fn apply_draft_overwrites_definition_keeps_binding() {
        let mut wf = live_wf();
        apply_draft(&mut wf, &draft());
        assert_eq!(wf.name, "draft");
        assert_eq!(wf.slug, "draft");
        assert_eq!(wf.trigger_type, "manual");
        assert_eq!(wf.nodes, json!([{"id":"b"}]));
        assert_eq!(wf.timeout_ms, 12_000);
        assert_eq!(wf.published_version, Some(3));
        assert!(wf.is_enabled);
        assert_eq!(wf.database_id, Some(2));
        assert_eq!(wf.alert_webhook_url.as_deref(), Some("https://example.com"));
        assert!(wf.has_unpublished);
        assert_eq!(wf.published_slug.as_deref(), Some("live"));
    }

    #[test]
    fn editor_view_without_draft_is_live_row() {
        let wf = editor_view(live_wf(), None);
        assert!(!wf.has_unpublished);
        assert_eq!(wf.name, "live");
    }
}
```

If `NaiveDateTime::from_timestamp_opt` is deprecated in this chrono, use the same timestamp helper already used in nearby tests, or `chrono::Utc.timestamp_opt(0,0).unwrap().naive_utc()`.

- [ ] **Step 2: Run tests — expect compile/fail**

Run: `cargo test --bin planeos apply_draft_overwrites -- --nocapture`

Expected: FAIL (module / functions missing) or compile error on new `Workflow` fields.

- [ ] **Step 3: Implement**

`src/error.rs` — add variant and match arm:

```rust
    #[error("{0}")]
    Conflict(String),
```

```rust
const CODE_CONFLICT: &str = "conflict";
```

In `into_response`:

```rust
            AppError::Conflict(ref msg) => (StatusCode::CONFLICT, msg.clone(), CODE_CONFLICT),
```

`Workflow` — after `created_by_email`:

```rust
    #[serde(default)]
    #[sqlx(default)]
    pub published_version: Option<i32>,
    #[serde(default)]
    #[sqlx(default)]
    pub has_unpublished: bool,
```

Fix any in-crate `Workflow { ... }` literals (kafka/notify tests) by adding `published_version: None, has_unpublished: false`.

`src/workflow_draft.rs` — structs + `apply_draft` / `editor_view` / `workflow_is_live` as specified. `apply_draft` copies: name, slug, description, category, department, trigger_type, trigger_config, input_schema, nodes, edges, dependencies, timeout_ms, max_retries.

- [ ] **Step 4: Re-run tests**

Run: `cargo test --bin planeos workflow_draft -- --nocapture`

Expected: PASS. Also `cargo test --lib` still compiles (`AppError` match is exhaustive).

- [ ] **Step 5: Commit** (skip if not asked)

```bash
git add src/workflow_draft.rs src/main.rs src/error.rs src/workflow_handlers.rs src/workflow_kafka_trigger.rs src/workflow_notify_trigger.rs
git commit -m "$(cat <<'EOF'
feat: 工作流草稿叠层与 409 Conflict。

EOF
)"
```

---

### Task 3: Runtime live gate

**Files:**
- Modify: `src/workflow_engine.rs` — `call_workflow` SELECT (~3355)
- Modify: `src/workflow_trigger.rs` — hook SELECT (`is_enabled = true AND trigger_type = 'hook'`)
- Modify: `src/workflow_handlers.rs` — `endpoint_trigger` and `endpoint_trigger_public` WHERE clauses
- Modify: `src/workflow_cron_trigger.rs` — cron scan SELECT
- Modify: `src/workflow_kafka_trigger.rs` — `load_active_kafka_configs`
- Modify: `src/workflow_notify_trigger.rs` — both `is_enabled = true AND trigger_type = 'notify'` queries
- Modify: `src/scheduler_workflow.rs` — after load, reject if `published_version` is None
- Modify: `src/scheduler_handlers.rs` — `load_enabled_workflow_for_tenant`
- Modify: `src/sse.rs` — `load_workflow_public_endpoint` SELECT

**Interfaces:**
- Consumes: `workflow_is_live` / `published_version`
- Produces: every executable load path uses the live gate

SQL fragment to paste (do not invent a second spelling):

```sql
is_enabled = true AND published_version IS NOT NULL
```

- [ ] **Step 1: Rely on Task 2 `workflow_is_live` tests.** Do not add a database test for `call_workflow`. Verification for SQL is the grep in Step 3 plus `cargo check`.

- [ ] **Step 2: Patch every listed query**

Examples:

`call_workflow` WHERE becomes:

```sql
WHERE slug = $1 AND tenant_id IS NOT DISTINCT FROM $2
  AND is_enabled = true AND published_version IS NOT NULL
```

`endpoint_trigger` / public:

```sql
WHERE database_id = $1 AND slug = $2 AND trigger_type = 'endpoint'
  AND is_enabled = true AND published_version IS NOT NULL
```

Cron:

```sql
SELECT * FROM management.workflows
 WHERE trigger_type = 'cron' AND is_enabled = true AND published_version IS NOT NULL
```

`scheduler_workflow.rs` after the existing `is_enabled` check:

```rust
        if wf.published_version.is_none() {
            return Err(format!("工作流 {} 尚未发布", wf.slug));
        }
```

`load_enabled_workflow_for_tenant`: same `published_version.is_none()` → `AppError::InvalidQuery("只能选择已发布且启用的工作流".into())`.

`sse.rs`:

```sql
SELECT slug, nodes FROM management.workflows
 WHERE is_enabled = true AND published_version IS NOT NULL
 ORDER BY updated_at DESC
```

- [ ] **Step 3: Grep leftover live loads**

Run: `rg "FROM management.workflows" src --glob '*.rs'`

Every path that executes a workflow must include `published_version`. List/admin/QA/sketches that only display or lint may omit it. `workflow_qa/store.rs` sketches stay as-is (review uses GET overlay later).

- [ ] **Step 4: Compile**

Run: `cargo test --bin planeos workflow_draft -- --nocapture`

Expected: PASS.

- [ ] **Step 5: Commit** (skip if not asked)

```bash
git add src/workflow_engine.rs src/workflow_trigger.rs src/workflow_handlers.rs src/workflow_cron_trigger.rs src/workflow_kafka_trigger.rs src/workflow_notify_trigger.rs src/scheduler_workflow.rs src/scheduler_handlers.rs src/sse.rs
git commit -m "$(cat <<'EOF'
feat: 运行时只执行已发布且启用的工作流。

EOF
)"
```

---

### Task 4: Draft SQL + GET/list overlay + create

**Files:**
- Modify: `src/workflow_draft.rs` — `fetch_draft`, `upsert_draft`, `delete_draft`, `fetch_drafts_for`, `draft_slug_taken`
- Modify: `src/workflow_handlers.rs` — `get_workflow`, `list_workflows`, `create_workflow`

**Interfaces:**
- Produces:
  - `pub async fn fetch_draft(pool, workflow_id) -> Result<Option<WorkflowDraft>>`
  - `pub async fn fetch_drafts_for(pool, ids: &[i32]) -> Result<HashMap<i32, WorkflowDraft>>`
  - `pub async fn upsert_draft(pool, draft: &WorkflowDraft) -> Result<()>` — `INSERT ... ON CONFLICT (workflow_id) DO UPDATE`
  - `pub async fn delete_draft(pool, workflow_id) -> Result<u64>` — rows deleted
  - `pub async fn draft_slug_taken(pool, database_id: Option<i32>, slug: &str, self_id: Option<i32>) -> Result<bool>` — true if another workflow's **main** slug or **another draft** slug collides in the same `database_id` (`IS NOT DISTINCT FROM`)
  - `create_workflow` inserts main row with `nodes='[]'`, `edges='[]'`, `published_version=NULL`, name/slug/taxonomy/binding/alerts from request; then `upsert_draft` with the full definition; **does not** call `snapshot_workflow_version`; **does not** `spawn_*_deps_install`
  - GET/list return `editor_view(wf, draft)`

- [ ] **Step 1: Failing test for slug collision helper (pure, if extracted)**

Keep SQL in async functions; add a small pure helper used by the query builder:

```rust
pub fn slug_conflict_sql() -> &'static str {
    r#"SELECT EXISTS(
         SELECT 1 FROM management.workflows w
          WHERE w.slug = $1
            AND w.database_id IS NOT DISTINCT FROM $2
            AND ($3::int IS NULL OR w.id <> $3)
         UNION ALL
         SELECT 1 FROM management.workflow_drafts d
         JOIN management.workflows w2 ON w2.id = d.workflow_id
          WHERE d.slug = $1
            AND w2.database_id IS NOT DISTINCT FROM $2
            AND ($3::int IS NULL OR d.workflow_id <> $3)
       )"#
}
```

Test:

```rust
    #[test]
    fn slug_conflict_sql_excludes_self() {
        assert!(slug_conflict_sql().contains("$3"));
        assert!(slug_conflict_sql().contains("workflow_drafts"));
    }
```

- [ ] **Step 2: Implement SQL helpers**

`upsert_draft` columns match the table. Bind `note` from `draft.note`.

`create_workflow` after DAG validate:

1. If `draft_slug_taken(..., req.slug, None)` → `AppError::Conflict("slug 已被占用".into())` (in addition to the unique constraint on insert).
2. INSERT workflows: `nodes`/`edges` = `json!([])`; omit `published_version` (NULL). Keep `is_enabled` default true.
3. Build `WorkflowDraft { workflow_id: workflow.id, name/slug/... from req, nodes/edges from req, note: version_note, ...}` and upsert.
4. Return `json!({ "workflow": editor_view(workflow, Some(draft)) })` — reconstruct the draft struct in memory rather than re-fetch if upsert succeeded.
5. Remove the `snapshot_workflow_version` call and the deps spawn from create.

`get_workflow`:

```rust
    let workflow = fetch_workflow_for_admin(&pool, &claims, id).await?;
    let draft = crate::workflow_draft::fetch_draft(&pool, id).await?;
    let workflow = crate::workflow_draft::editor_view(workflow, draft);
    Ok(Json(json!({ "workflow": workflow, "deps_status": ..., "py_deps_status": ... })))
```

`list_workflows`: after `fetch_all`, collect ids, `fetch_drafts_for`, map `editor_view`.

- [ ] **Step 3: Compile**

Run: `cargo test --bin planeos slug_conflict_sql -- --nocapture`

Expected: PASS. `cargo check` succeeds.

- [ ] **Step 4: Commit** (skip if not asked)

```bash
git add src/workflow_draft.rs src/workflow_handlers.rs
git commit -m "$(cat <<'EOF'
feat: 创建工作流写入草稿，GET/列表叠编辑稿。

EOF
)"
```

---

### Task 5: PATCH definition → draft

**Files:**
- Modify: `src/workflow_handlers.rs` — `update_workflow`

**Interfaces:**
- Consumes: `upsert_draft`, `fetch_draft`, `draft_slug_taken`, existing `merge_node_patch`
- Produces: definition PATCH upserts draft; switch/binding/alerts PATCH the main row; taxonomy-only PATCH updates main + draft category/department

Treat as **definition** (write draft) if any of: `name`, `slug`, `description`, `trigger_type`, `trigger_config`, `input_schema`, `nodes`, `edges`, `dependencies`, `node_patch`, `remove_node_ids`, `timeout_ms`, `max_retries`, `version_note`.

Treat as **taxonomy-only** if `category`/`department` present and no definition fields above: UPDATE main row as today (no snapshot) and `UPDATE workflow_drafts SET category=$2, department=$3 WHERE workflow_id=$1` when a draft exists.

`database_id` / `is_enabled` / alerts / doc-share: UPDATE main row only.

A single PATCH may include both (editor save sends definition + `database_id` + alerts). Then: upsert draft from merged editor definition; UPDATE main for binding/alerts/`is_enabled` only; do not copy nodes onto main.

- [ ] **Step 1: Write a pure classifier test in `workflow_draft.rs`**

```rust
#[derive(Default)]
pub struct UpdateKind {
    pub definition: bool,
    pub taxonomy_only: bool,
}

pub fn classify_update(
    has_definition: bool,
    has_taxonomy: bool,
) -> UpdateKind {
    UpdateKind {
        definition: has_definition,
        taxonomy_only: has_taxonomy && !has_definition,
    }
}

#[test]
fn classify_editor_save_is_definition_not_taxonomy_only() {
    let k = classify_update(true, true);
    assert!(k.definition);
    assert!(!k.taxonomy_only);
}

#[test]
fn classify_list_move_is_taxonomy_only() {
    let k = classify_update(false, true);
    assert!(!k.definition);
    assert!(k.taxonomy_only);
}
```

- [ ] **Step 2: Run — expect fail then implement classifier + handler**

`update_workflow` algorithm:

1. `existing = fetch_workflow_for_admin`
2. `base = editor_view(existing.clone(), fetch_draft?)` — patch relative to editor view
3. If definition: merge node_patch onto `base.nodes`; validate DAG on effective nodes/edges; if slug changing, `draft_slug_taken(..., Some(id))` → 409 Conflict; `upsert_draft` from merged fields (`version_note` → `note`); **do not** `snapshot_workflow_version`; **do not** spawn deps
4. If taxonomy_only: current UPDATE for category/department on workflows; also update draft columns if row exists
5. If `is_enabled` / `database_id` / alerts present: COALESCE UPDATE those columns on workflows only
6. Reload admin row + overlay; return `{ workflow }`
7. Audit `definition_changed` means draft written, not live nodes changed

Keep `node_patch` vs full `nodes` mutual exclusion as today.

- [ ] **Step 3: Compile**

Run: `cargo test --bin planeos classify_ -- --nocapture`

Expected: PASS.

- [ ] **Step 4: Commit** (skip if not asked)

```bash
git add src/workflow_draft.rs src/workflow_handlers.rs
git commit -m "$(cat <<'EOF'
feat: 工作流定义 PATCH 只写草稿。

EOF
)"
```

---

### Task 6: Publish, discard, restore, trigger 409

**Files:**
- Modify: `src/workflow_handlers.rs` — new handlers; change `restore_workflow_version`; change `trigger_workflow`
- Modify: `src/main.rs` — routes **before** `/:id` is not required (these are `/:id/publish`). Register next to versions:

```rust
            "/api/admin/workflows/:id/publish",
            post(workflow_handlers::publish_workflow),
        )
        .route(
            "/api/admin/workflows/:id/discard-draft",
            post(workflow_handlers::discard_workflow_draft),
```

**Interfaces:**
- `POST /api/admin/workflows/:id/publish` body `PublishWorkflowRequest { version_note: Option<String> }`
- `POST /api/admin/workflows/:id/discard-draft` empty body
- Restore upserts draft from `WorkflowVersion` + `dependencies` from the **live** main row (versions table has no dependencies). Does not snapshot. Does not change `published_version`.
- `trigger_workflow`: if `published_version.is_none()` → `AppError::Conflict("工作流尚未发布".into())`; keep existing disabled → `InvalidQuery`

- [ ] **Step 1: Implement `publish_workflow`**

In one transaction (`pool.begin()`):

1. `fetch_workflow_for_admin`
2. `fetch_draft` — if None: if `published_version.is_none()` → Conflict「没有可发布的定义」else Conflict「没有未发布的修改」
3. Validate DAG on draft nodes/edges
4. If draft.slug != existing.slug, unique check will run on UPDATE; map unique violation via `map_workflow_write_err`
5. UPDATE workflows SET name,slug,description,category,department,trigger_type,trigger_config,input_schema,nodes,edges,dependencies,timeout_ms,max_retries from draft WHERE id=$1 RETURNING *
6. `snapshot_workflow_version(&mut tx, &workflow, note, Some(claims.sub))` — **this must use the transaction**. If `snapshot_workflow_version` currently takes `&PgPool`, add an overload `snapshot_workflow_version_exec<'e, E: Executor>(executor, ...)` or pass `&mut *tx`. Failure here is fatal (return err, rollback), not the old warn-only path.
7. `UPDATE workflows SET published_version = $2 WHERE id = $1`
8. `delete_draft`
9. commit
10. `spawn_javascript_deps_install` / `spawn_python_deps_install` on the published workflow
11. Return `{ workflow: editor_view(published, None) }` (`has_unpublished=false`)

Note = `req.version_note` trimmed non-empty, else draft.note, else None.

- [ ] **Step 2: Implement `discard_workflow_draft`**

```rust
    fetch_workflow_for_admin(...)?;
    let n = delete_draft(&pool, id).await?;
    if n == 0 {
        return Err(AppError::Conflict("没有可丢弃的草稿".into()));
    }
    let workflow = fetch_workflow_for_admin(...).await?;
    Ok(Json(json!({ "workflow": editor_view(workflow, None) })))
```

- [ ] **Step 3: Restore writes draft**

Replace the UPDATE workflows block with:

```rust
    let mut d = WorkflowDraft {
        workflow_id: id,
        name: snapshot.name,
        slug: snapshot.slug,
        description: snapshot.description,
        category: snapshot.category,
        department: snapshot.department,
        trigger_type: snapshot.trigger_type,
        trigger_config: snapshot.trigger_config,
        input_schema: snapshot.input_schema,
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        dependencies: existing.dependencies.clone(),
        timeout_ms: snapshot.timeout_ms,
        max_retries: snapshot.max_retries,
        note: Some(format!("恢复自 v{}", version)),
        updated_by: Some(claims.sub),
        updated_at: chrono::Utc::now().naive_utc(),
    };
    if draft_slug_taken(&pool, existing.database_id, &d.slug, Some(id)).await? {
        return Err(AppError::Conflict("slug 已被占用".into()));
    }
    upsert_draft(&pool, &d).await?;
    let workflow = editor_view(existing, Some(d));
    // return { workflow } ; do not snapshot
```

Update the handler doc comment: 恢复写入草稿，发布后才上线。

- [ ] **Step 4: Manual trigger unpublished**

After `fetch_workflow_for_admin`:

```rust
    if workflow.published_version.is_none() {
        return Err(AppError::Conflict("工作流尚未发布".into()));
    }
```

Keep the existing `!is_enabled` check.

- [ ] **Step 5: Compile**

Run: `cargo check`

Expected: success.

- [ ] **Step 6: Commit** (skip if not asked)

```bash
git add src/workflow_handlers.rs src/main.rs src/workflow_draft.rs
git commit -m "$(cat <<'EOF'
feat: 工作流发布、丢弃草稿、恢复进草稿。

EOF
)"
```

---

### Task 7: Duplicate, import, api_doc published view

**Files:**
- Modify: `src/workflow_handlers.rs` — `duplicate_workflow`; import create/overwrite (~2556+)
- Modify: `src/mcp_tools.rs` — `tool_workflow_api_doc` (or a helper used by it)

**Interfaces:**
- Duplicate: INSERT main with empty graph, `published_version=NULL`, `is_enabled=false`, unique slug; upsert draft from **source editor view** (`editor_view(src, fetch_draft(src.id))`) but with new name/slug
- Import new: same as create (unpublished + draft), no snapshot
- Import overwrite: upsert draft from imported definition; do not UPDATE live nodes/edges; keep id/`is_enabled`/`published_version`
- `workflow_api_doc`: if `published_version` is Some, document the **main row without overlay** (re-fetch or skip overlay). If None, document the draft and set `"unpublished": true` plus a Chinese note「尚未发布，无线上接口」. Do **not** use GET overlay for the published case (overlay would show unpublished slug/nodes).

- [ ] **Step 1: Duplicate**

After loading `src`:

```rust
    let src_editor = editor_view(src.clone(), fetch_draft(&pool, src.id).await?);
    // INSERT workflows using src_editor.name/slug variants, but nodes/edges json!([]), published_version NULL, is_enabled false
    // upsert_draft from src_editor fields with new workflow_id / new_name / new_slug
    // return editor_view(new_row, Some(draft))
```

Do not snapshot.

- [ ] **Step 2: Import**

In the overwrite branch: `upsert_draft` instead of UPDATE nodes on workflows. In the insert branch: empty live graph + draft, same as create.

- [ ] **Step 3: api_doc**

```rust
    let live = fetch_workflow_for_admin(...)?;
    let doc_wf = if live.published_version.is_some() {
        live
    } else {
        let draft = fetch_draft(&pool, id).await?;
        editor_view(live, draft)
    };
    // existing field extraction on doc_wf
    // add "unpublished": live.published_version.is_none()  — capture before move
```

If GET is used today, switch this tool to `fetch_workflow_for_admin` + optional overlay so published docs stay live.

- [ ] **Step 4: `cargo check`**

Expected: success.

- [ ] **Step 5: Commit** (skip if not asked)

```bash
git add src/workflow_handlers.rs src/mcp_tools.rs
git commit -m "$(cat <<'EOF'
feat: 复制/导入进草稿，接口文档使用已发布定义。

EOF
)"
```

---

### Task 8: MCP tools

**Files:**
- Modify: `src/mcp_tools.rs` — `NODE_SPEC` 约束 bullet; `create_workflow` / `update_workflow` descriptions; `tool_definitions`; `call_tool`; `tool_create_workflow` notice
- Modify: `mcp-server/src/index.ts` — register `publish_workflow` and `discard_workflow_draft`; update create/update descriptions

**Interfaces:**
- `publish_workflow` args: `{ id: integer, version_note?: string }` → POST `/:id/publish`
- `discard_workflow_draft` args: `{ id: integer }` → POST `/:id/discard-draft`
- create notice: `工作流已保存为草稿；调用 publish_workflow 后才会进入运行时`
- Duplicate notice can mention 未发布

- [ ] **Step 1: Change create/update copy**

Replace「创建即启用」/「更新即生效」/「会触发版本快照」.

`tool_create_workflow`: keep `is_enabled = Some(true)` (switch default on) but change notice. Do not auto-publish.

`update_workflow` description: 只写草稿，不进入运行时，不打版本。`version_note` 暂存在草稿，发布时写入版本历史。

- [ ] **Step 2: Add tools to `tool_definitions` and `call_tool`**

```rust
        {
            "name": "publish_workflow",
            "description": "把工作流的未发布草稿发布为线上定义。无草稿则失败。发布后运行时才会使用新图。",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "integer" },
                "version_note": { "type": "string" }
            }, "required": ["id"] }
        },
        {
            "name": "discard_workflow_draft",
            "description": "丢弃未发布草稿，编辑稿回到当前已发布定义。从未发布过的丢弃后画布为空。",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "integer" }
            }, "required": ["id"] }
        },
```

Dispatch: call new handlers the same way as `update_workflow` (State/Path/Extension).

- [ ] **Step 3: mcp-server HTTP wrappers**

Follow `update_workflow` registration style:

```ts
server.registerTool("publish_workflow", { title: "发布工作流", description: "...", inputSchema: { id: z.number().int(), version_note: z.string().optional() } }, async (args) => {
  const { id, ...body } = args;
  return toResult(await api("POST", `/api/admin/workflows/${id}/publish`, body));
});
```

- [ ] **Step 4: `cargo test --bin planeos` for mcp_tools unit tests if any parse `tool_definitions`**

Expected: PASS.

- [ ] **Step 5: Commit** (skip if not asked)

```bash
git add src/mcp_tools.rs mcp-server/src/index.ts
git commit -m "$(cat <<'EOF'
feat: MCP publish_workflow / discard_workflow_draft。

EOF
)"
```

---

### Task 9: Editor save / publish / discard

**Files:**
- Modify: `frontend-nextjs/components/workflow/WorkflowEditorHeader.tsx`
- Modify: `frontend-nextjs/components/workflow/WorkflowsManager.tsx`
- Modify: `frontend-nextjs/lib/api.ts` only if a Workflow type lives there; otherwise the local `Workflow` interface in `WorkflowsManager.tsx`

**Interfaces:**
- `Workflow` adds `published_version: number | null`, `has_unpublished: boolean`
- Header props: `hasUnpublished`, `publishedVersion`, `liveSlug`, `onPublish`, `onDiscardDraft`
- Save stays「保存」and still returns to list after success (current `persistWorkflow`)
- Publish: persist current canvas as draft **without** leaving the editor, then `POST /:id/publish`. If QA findings on that persist, reuse the existing modal; 「仍然保存」should persist then publish when the pending action is publish
- Discard: confirm → `POST /:id/discard-draft` → replace `editing` / nodes / formMeta from response `workflow`
- `saveNote` is sent as `version_note` on publish (and stored on draft during save persist)
- Badge: `published_version == null` → 「未发布」; `has_unpublished` → 「有未发布修改」
- Enable toggle hint when unpublished: 「发布后才会接收请求」
- Endpoint path uses live slug: if `editing` has `has_unpublished` and `formMeta.slug !== liveSlug`, show 「发布后地址变为 {formMeta.slug}」
- Versions restore confirm string: `确认恢复到版本 v${n}？将写入草稿，不会立刻上线。`

- [ ] **Step 1: Types + header buttons**

Keep the indigo primary on **发布**. Save becomes outline (border slate, white bg) so publish is the main action.

Publish disabled when `editing && published_version != null && !has_unpublished && dirtyFields.size===0` with label「已发布」. If the canvas can be dirty without `has_unpublished` (never saved), keep Publish enabled.

Discard button only if `has_unpublished`.

- [ ] **Step 2: persist vs publish in `WorkflowsManager`**

Split `persistWorkflow({ closeEditor: boolean })`. Save uses `closeEditor: true`. Publish:

```ts
const handlePublish = async () => {
  // build payload like handleSave (extract a shared buildPayload())
  pendingPayloadRef.current = payload
  pendingPublishRef.current = true
  // same QA as handleSave
  // on empty findings: await persistWorkflow({ closeEditor: false }); then POST publish
}
```

On publish success: `setEditing(res.data.workflow)`, `setSaveNote('')`, toast「已发布」.

Live endpoint path: `editing.published_slug ?? editing.slug`. Draft slug stays on `formMeta.slug`. If they differ, show 「发布后地址变为 {formMeta.slug}」.

- [ ] **Step 3: Manual check**

1. Open an existing (migrated) workflow: badge none, Publish disabled「已发布」.
2. Change a node, Save: back to list, row badge「有修改」; HTTP endpoint still old behavior.
3. Re-open, Publish: badge gone; endpoint uses new graph.
4. New workflow, Save: list「未发布」; POST `/workflow/...` 404.
5. Publish new: endpoint works.
6. Discard on a published+draft editor: nodes revert.
7. Restore from version history: confirm text; editor shows restored graph; endpoint unchanged until Publish.

- [ ] **Step 4: Commit** (skip if not asked)

```bash
git add frontend-nextjs/components/workflow/WorkflowEditorHeader.tsx frontend-nextjs/components/workflow/WorkflowsManager.tsx src/workflow_draft.rs src/workflow_handlers.rs
git commit -m "$(cat <<'EOF'
feat: 工作流编辑器保存草稿并支持发布/丢弃。

EOF
)"
```

---

### Task 10: List badges and row menu

**Files:**
- Modify: `frontend-nextjs/components/workflow/list/types.ts` — `has_unpublished`, `published_version`
- Modify: `frontend-nextjs/components/workflow/list/WorkflowRow.tsx` — compact + card
- Modify: `frontend-nextjs/components/workflow/list/RowMenu.tsx`
- Modify: `frontend-nextjs/components/workflow/WorkflowsManager.tsx` — list handlers `onPublish` / `onDiscardDraft`

**Interfaces:**
- Badge next to name: `published_version == null` → slate「未发布」; else if `has_unpublished` → amber「有修改」
- Enable/disable column unchanged
- Row menu: if `has_unpublished`, items「发布」「丢弃草稿」above 运行
- `onRun` for unpublished: toast「尚未发布」and do not call trigger (backend also 409)

- [ ] **Step 1: Types + badge component**

```tsx
function PublishBadge({ w }: { w: WorkflowListItem }) {
  if (w.published_version == null) {
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">未发布</span>
  }
  if (w.has_unpublished) {
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">有修改</span>
  }
  return null
}
```

Add to both compact and card name rows beside the slug.

- [ ] **Step 2: RowMenu optional callbacks**

```ts
  onPublish?: () => void
  onDiscardDraft?: () => void
```

Render only if provided.

- [ ] **Step 3: Wire in manager**

```ts
await api.post(`/api/admin/workflows/${id}/publish`, { version_note: null })
await api.post(`/api/admin/workflows/${id}/discard-draft`)
refreshList()
```

Discard: `confirm('丢弃未发布的修改？已发布的工作流将回到线上定义。')`

- [ ] **Step 4: Manual check**

List shows badges. Publish from menu on a drafted row. Discard from menu. Filters still 全部/启用/禁用. Run on unpublished toasts and does not 202.

- [ ] **Step 5: Commit** (skip if not asked)

```bash
git add frontend-nextjs/components/workflow/list frontend-nextjs/components/workflow/WorkflowsManager.tsx
git commit -m "$(cat <<'EOF'
feat: 工作流列表展示未发布/有修改并可发布。

EOF
)"
```

---

## Spec coverage

| Spec section | Task |
|---|---|
| 3.x schema, backfill | 1 |
| overlay / live helper / 409 | 2 |
| §8 runtime queries | 3 |
| create + GET/list overlay | 4 |
| PATCH draft vs live meta | 5 |
| publish / discard / restore / manual 409 | 6 |
| duplicate / import / api_doc | 7 |
| MCP tools | 8 |
| editor UX | 9 |
| list UX | 10 |
| deps install on publish | 6 |
| QA still on save | 9 |
| slug conflict on save | 4–5 |
| no unpublished list filter | 10 (explicitly omitted) |
