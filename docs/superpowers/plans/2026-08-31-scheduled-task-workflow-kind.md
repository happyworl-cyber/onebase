# Scheduled Task Workflow Kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `kind=workflow` to project scheduled tasks so a cron/run-now tick starts an enabled workflow in-process via `execute_workflow_internal`, without HTTP.

**Architecture:** Migration adds `workflow_id` / `workflow_slug` / `workflow_input`. Handlers validate tenant + enabled workflow. `WorkflowExecutor` loads the row, merges `fired_at` into the JSON object, calls `execute_workflow_internal(..., "scheduler", ...)`, then writes `{ workflow_run_id, status }` as the scheduled-task output. Frontend adds a kind option and a picker on project-scoped pages only.

**Tech Stack:** Axum, sqlx, Postgres, Next.js 14, existing `ScheduledTasksManager`.

**Spec:** `docs/superpowers/specs/2026-08-31-scheduled-task-workflow-kind-design.md`

## Global Constraints

- New kind only; do not change workflow `trigger_type=cron`
- Platform-level tasks (`tenant_id` IS NULL) cannot be `kind=workflow`
- Picker lists this tenant’s **enabled** workflows (any trigger_type)
- `workflow_input` must be a JSON object (default `{}`)
- Identity is `task.created_by`; `ApiKeyWriteGuard::Off`
- Overlap uses existing `scheduled_task_runs` only
- Kind is immutable after create (same as rpc/http/shell)
- Do not add a new permission
- Do not commit unless the user asked

## File map

| Path | Responsibility |
|------|----------------|
| `migrations/061_scheduled_tasks_workflow.sql` | kind + columns + CHECKs |
| `src/scheduler/models.rs` | `TaskKind::Workflow` + three fields on `ScheduledTask` |
| `src/scheduler/executors.rs` | `WorkflowExecutor` |
| `src/scheduler/runner.rs` | dispatch `workflow` |
| `src/scheduler_handlers.rs` | create / update / dry-run |
| `frontend-nextjs/lib/api.ts` | types |
| `frontend-nextjs/components/ScheduledTasksManager.tsx` | form + list label |

---

### Task 1: Migration + model fields

**Files:**
- Create: `migrations/061_scheduled_tasks_workflow.sql`
- Modify: `src/scheduler/models.rs`

**Interfaces:**
- Consumes: `management.scheduled_tasks`, `management.workflows`
- Produces: columns `workflow_id`, `workflow_slug`, `workflow_input`; `TaskKind::Workflow`

- [ ] **Step 1: Add migration `migrations/061_scheduled_tasks_workflow.sql`**

If `061_*` already exists when you start, use the next free number and keep the rest of this file identical.

```sql
-- 定时任务 kind=workflow：进程内调用 execute_workflow_internal。

ALTER TABLE management.scheduled_tasks
    ADD COLUMN IF NOT EXISTS workflow_id INTEGER
        REFERENCES management.workflows(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS workflow_slug VARCHAR(200),
    ADD COLUMN IF NOT EXISTS workflow_input JSONB;

ALTER TABLE management.scheduled_tasks
    DROP CONSTRAINT IF EXISTS chk_st_kind;

ALTER TABLE management.scheduled_tasks
    ADD CONSTRAINT chk_st_kind CHECK (kind IN ('rpc', 'http', 'shell', 'workflow'));

ALTER TABLE management.scheduled_tasks
    DROP CONSTRAINT IF EXISTS chk_st_kind_workflow;

ALTER TABLE management.scheduled_tasks
    ADD CONSTRAINT chk_st_kind_workflow CHECK (
        kind <> 'workflow'
        OR (
            tenant_id IS NOT NULL
            AND workflow_id IS NOT NULL
        )
    );
```

- [ ] **Step 2: Extend `TaskKind` and `ScheduledTask`**

In `src/scheduler/models.rs`, add `Workflow` to the enum and parse/as_str:

```rust
    Workflow,
```

```rust
            TaskKind::Workflow => "workflow",
```

```rust
            "workflow" => Some(TaskKind::Workflow),
```

On `ScheduledTask`, after the shell fields (before `is_active`), add:

```rust
    pub workflow_id: Option<i32>,
    pub workflow_slug: Option<String>,
    pub workflow_input: Option<serde_json::Value>,
```

sqlx `RETURNING *` / `query_as` will fail until every SELECT that maps `ScheduledTask` hits the new columns. Those queries already use `RETURNING *` or `SELECT *` in this module; after migrate they just work.

- [ ] **Step 3: Apply migration locally**

Use the project’s usual migrate command (same as other 06x files). Expected: `scheduled_tasks` has the three columns and `chk_st_kind` includes `workflow`.

- [ ] **Step 4: Commit** (skip if the user did not ask)

```bash
git add migrations/061_scheduled_tasks_workflow.sql src/scheduler/models.rs
git commit -m "$(cat <<'EOF'
Add scheduled_tasks workflow kind columns.

EOF
)"
```

---

### Task 2: Create / update / dry-run validation

**Files:**
- Modify: `src/scheduler_handlers.rs`

**Interfaces:**
- Consumes: `ScheduledTask` new fields; `management.workflows`
- Produces: `CreateTaskReq` / `UpdateTaskReq` / `DryRunReq` accept `workflow_id` + `workflow_input`; INSERT/UPDATE persist them

- [ ] **Step 1: Shared loader**

Add in `scheduler_handlers.rs` (near other validators):

```rust
async fn load_enabled_workflow_for_tenant(
    pool: &PgPool,
    workflow_id: i32,
    tenant_id: i32,
) -> Result<crate::workflow_handlers::Workflow, AppError> {
    let wf = sqlx::query_as::<_, crate::workflow_handlers::Workflow>(
        "SELECT * FROM management.workflows WHERE id = $1",
    )
    .bind(workflow_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("工作流不存在".into()))?;

    if wf.tenant_id != Some(tenant_id) {
        return Err(AppError::InvalidQuery(
            "工作流不属于当前项目".to_string(),
        ));
    }
    if !wf.is_enabled {
        return Err(AppError::InvalidQuery(
            "只能选择已启用的工作流".to_string(),
        ));
    }
    Ok(wf)
}

fn workflow_input_or_empty(v: Option<Value>) -> Result<Value, AppError> {
    let v = v.unwrap_or_else(|| json!({}));
    if !v.is_object() {
        return Err(AppError::InvalidQuery(
            "workflow_input 必须是 JSON 对象".to_string(),
        ));
    }
    Ok(v)
}
```

Confirm `Workflow` is `FromRow` (it is used with `query_as` elsewhere). If `SELECT *` column mismatch fails compile, copy the same column list used by `GET /api/admin/workflows/:id`.

- [ ] **Step 2: `CreateTaskReq` / `UpdateTaskReq` / `DryRunReq` fields**

Add to all three request structs:

```rust
    pub workflow_id: Option<i32>,
    pub workflow_input: Option<Value>,
```

- [ ] **Step 3: `create_task` validation + INSERT**

Change the kind allow-list to include `workflow`. After the shell branch, add:

```rust
    let mut workflow_id: Option<i32> = None;
    let mut workflow_slug: Option<String> = None;
    let mut workflow_input: Option<Value> = None;

    if kind == "workflow" {
        let tenant_id = req.tenant_id.ok_or_else(|| {
            AppError::InvalidQuery("工作流任务必须属于一个项目（tenant_id）".into())
        })?;
        let wf_id = req.workflow_id.ok_or_else(|| {
            AppError::InvalidQuery("工作流任务必须提供 workflow_id".into())
        })?;
        let wf = load_enabled_workflow_for_tenant(&pool, wf_id, tenant_id).await?;
        workflow_id = Some(wf.id);
        workflow_slug = Some(wf.slug.clone());
        workflow_input = Some(workflow_input_or_empty(req.workflow_input)?);
    }
```

Extend the INSERT column list and VALUES placeholders with `workflow_id, workflow_slug, workflow_input` and bind those three Options (None for non-workflow kinds). Keep existing binds in the same order, then append the three new ones before or after shell binds — **update the `$N` placeholders to match bind order exactly**.

- [ ] **Step 4: `update_task`**

When existing `task.kind == "workflow"`:

- If `req.workflow_id` is Some, re-run `load_enabled_workflow_for_tenant` with `task.tenant_id` (must be Some) and refresh slug.
- If `req.workflow_input` is Some, run `workflow_input_or_empty`.
- PATCH only those columns (same style as `http_body` / `shell_script`). Do not allow changing `kind`.

- [ ] **Step 5: `dry_run`**

Allow `kind=workflow`. Validate with the same loader + `workflow_input_or_empty`. **Do not** call `execute_workflow_internal`. Return JSON like:

```json
{ "dry_run": true, "ok": true, "kind": "workflow", "workflow_id": 1, "workflow_slug": "foo" }
```

Do not write `scheduled_task_runs` or `workflow_runs`.

- [ ] **Step 6: `cargo check`**

```bash
cargo check -q
```

Expected: compile. Fix INSERT placeholder count if sqlx/`too many/few binds`.

- [ ] **Step 7: Commit** (skip if the user did not ask)

```bash
git add src/scheduler_handlers.rs
git commit -m "$(cat <<'EOF'
Validate and persist scheduled-task workflow kind.

EOF
)"
```

---

### Task 3: `WorkflowExecutor` + runner dispatch

**Files:**
- Modify: `src/scheduler/executors.rs`
- Modify: `src/scheduler/runner.rs`
- Modify: `src/scheduler/mod.rs` (only if you export the new type; not required)

**Interfaces:**
- Consumes: `ScheduledTask.{workflow_id,workflow_input,tenant_id,created_by}`; `execute_workflow_internal`
- Produces:
  - `pub struct WorkflowExecutor { pub pool: PgPool }`
  - `impl WorkflowExecutor { pub async fn execute(&self, task: &ScheduledTask) -> Result<Value, String> }`
  - `pub type WorkflowExecutorRef = Arc<WorkflowExecutor>`

- [ ] **Step 1: Implement `WorkflowExecutor`**

At the end of `executors.rs` (or after `HttpExecutor`):

```rust
pub struct WorkflowExecutor {
    pub pool: PgPool,
}

pub type WorkflowExecutorRef = Arc<WorkflowExecutor>;

impl WorkflowExecutor {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn execute(&self, task: &ScheduledTask) -> Result<Value, String> {
        let tenant_id = task.tenant_id.ok_or_else(|| {
            "工作流任务缺少 tenant_id".to_string()
        })?;
        let workflow_id = task.workflow_id.ok_or_else(|| {
            "工作流已删除或不存在".to_string()
        })?;

        let wf = sqlx::query_as::<_, crate::workflow_handlers::Workflow>(
            "SELECT * FROM management.workflows WHERE id = $1",
        )
        .bind(workflow_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "工作流已删除或不存在".to_string())?;

        if wf.tenant_id != Some(tenant_id) {
            return Err("工作流不属于当前项目".to_string());
        }
        if !wf.is_enabled {
            return Err(format!("工作流 {} 已禁用", wf.slug));
        }

        let fired_at = chrono::Utc::now().to_rfc3339();
        let mut data = match &task.workflow_input {
            Some(v) if v.is_object() => v.clone(),
            _ => serde_json::json!({}),
        };
        if let Some(obj) = data.as_object_mut() {
            obj.insert("fired_at".into(), serde_json::Value::String(fired_at.clone()));
            obj.insert(
                "scheduled_task_id".into(),
                serde_json::json!(task.id),
            );
        }

        crate::workflow_handlers::execute_workflow_internal(
            &self.pool,
            &wf,
            "scheduler",
            &data,
            Some(task.created_by),
            crate::workflow_handlers::ApiKeyWriteGuard::Off,
        )
        .await
        .map_err(|e| e.to_string())?;

        let row: Option<(i32, String)> = sqlx::query_as(
            "SELECT id, status FROM management.workflow_runs \
             WHERE workflow_id = $1 AND trigger_type = 'scheduler' \
               AND trigger_data->>'fired_at' = $2 \
             ORDER BY id DESC LIMIT 1",
        )
        .bind(wf.id)
        .bind(&fired_at)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        let (run_id, status) = row.unwrap_or((0, "success".into()));
        Ok(serde_json::json!({
            "workflow_run_id": run_id,
            "status": status,
        }))
    }
}
```

Confirm `ApiKeyWriteGuard` is public in `workflow_handlers`. If the name differs, use the same variant admin trigger uses.

If `execute_workflow_internal` error type does not implement `ToString` usefully, map with `format!("{e}")` or the crate’s `AppError` display.

- [ ] **Step 2: Wire `SchedulerRunner`**

Add `workflow_exec: WorkflowExecutorRef` to the struct and `new(...)`. In `main.rs` where `SchedulerRunner::new` is called, pass `Arc::new(WorkflowExecutor::new(pool.clone()))`.

In `execute_one` match, add:

```rust
            "workflow" => Box::pin({
                let exec = self.workflow_exec.clone();
                let t = task.clone();
                async move { exec.execute(&t).await }
            }),
```

Add `workflow_exec()` getter next to `http_exec()` only if dry-run needs it (Task 2 dry-run does **not** execute).

- [ ] **Step 3: `cargo check`**

```bash
cargo check -q
```

Expected: clean.

- [ ] **Step 4: Manual / API check** (if server can run)

`POST /api/admin/scheduled-tasks` with kind=workflow + tenant_id + workflow_id, then `POST .../run-now`. Expect `workflow_runs.trigger_type=scheduler` and task run output with `workflow_run_id`.

- [ ] **Step 5: Commit** (skip if the user did not ask)

```bash
git add src/scheduler/executors.rs src/scheduler/runner.rs src/main.rs
git commit -m "$(cat <<'EOF'
Execute scheduled-task workflow kind in-process.

EOF
)"
```

---

### Task 4: Frontend picker

**Files:**
- Modify: `frontend-nextjs/lib/api.ts`
- Modify: `frontend-nextjs/components/ScheduledTasksManager.tsx`

**Interfaces:**
- Consumes: `GET /api/admin/workflows?tenant_id=`
- Produces: kind `'workflow'` in types; form fields `workflow_id`, `workflow_input`

- [ ] **Step 1: Types in `api.ts`**

Change `kind` unions on `ScheduledTask`, `CreateScheduledTaskInput`, and `UpdateScheduledTaskInput` to include `'workflow'`.

Add to `ScheduledTask` and create/update inputs:

```ts
  workflow_id?: number | null
  workflow_slug?: string | null
  workflow_input?: Record<string, unknown> | null
```

- [ ] **Step 2: Form state and payload**

In `ScheduledTasksManager.tsx`, extend the form object with `workflow_id: ''` and `workflow_input: '{}'`.

On submit, if `form.kind === 'workflow'`:

- Parse `workflow_input` JSON; must be a non-array object; empty string → `{}`.
- Send `workflow_id: Number(form.workflow_id)` and `workflow_input`.
- Do not send http/rpc/shell fields (or send them undefined).

When loading `editing`, fill `workflow_id` and `JSON.stringify(editing.workflow_input ?? {}, null, 2)`.

- [ ] **Step 3: Kind `<select>`**

Show `<option value="workflow">工作流</option>` only when the page has a tenant (`lockedTenantId` or a selected tenant on the platform page). Hide it when `tenant_id` is empty.

- [ ] **Step 4: Kind-specific fields**

When `form.kind === 'workflow'`, render:

- `<select>` of enabled workflows: on tenant change, `GET /api/admin/workflows` with `params: { tenant_id, page_size: 200 }` (or whatever the list API already accepts). Filter `is_enabled` client-side if the API has no flag. Option label: `${name} (${slug})`.
- JSON textarea (or `CodeSnippetEditor` language=`json` if this file already imports it; otherwise keep the same textarea used for `http_body`).

Reuse existing `FormField` layout.

List/detail kind label: map `workflow` → `工作流`. Show slug in the detail line where HTTP shows URL.

- [ ] **Step 5: Manual check**

1. Project scheduled-tasks page: kind 工作流 appears; platform page with no tenant: it does not.
2. Create + 立即执行: new `workflow_runs` row, task output has `workflow_run_id`.
3. Disable the workflow, run-now: task failed with 已禁用.
4. HTTP task create/run unchanged.

- [ ] **Step 6: Commit** (skip if the user did not ask)

```bash
git add frontend-nextjs/lib/api.ts frontend-nextjs/components/ScheduledTasksManager.tsx
git commit -m "$(cat <<'EOF'
Add workflow kind to scheduled-task UI.

EOF
)"
```

---

### Task 5: Spec acceptance

**Files:** none new

- [ ] **Step 1: Run spec §8**

1. Enabled workflow + `{"x":1}` + run-now → `trigger_type=scheduler`, data has `x` and `fired_at`.
2. `output.workflow_run_id` matches that run.
3. Disabled workflow → failed, message mentions 禁用.
4. HTTP/RPC unchanged.
5. Platform no-tenant: no UI option; API 400 for kind=workflow without tenant_id.
6. dry-run enabled workflow: ok, no new `workflow_runs`.

- [ ] **Step 2: Commit** (skip if the user did not ask)

Only if QA produced fixes.

---

## Self-review

| Spec item | Task |
|-----------|------|
| kind=workflow + columns | 1 |
| tenant required, enabled picker | 2, 4 |
| execute_workflow_internal scheduler | 3 |
| output.workflow_run_id | 3 (`fired_at` lookup) |
| dry-run no DAG | 2 |
| platform forbidden | 2, 4 |
| HTTP/RPC/Shell unchanged | constraints |
