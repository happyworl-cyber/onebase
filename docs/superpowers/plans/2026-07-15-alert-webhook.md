# Alert Webhook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable final-failure Webhook alerts for workflows and scheduled tasks, with JSON templates and per-object hourly throttling.

**Architecture:** Store one alert Webhook configuration directly on each workflow and scheduled task row. A new backend `alert_webhook` module owns template rendering, atomic throttling claim, and best-effort HTTP POST delivery. Workflow and scheduler execution paths call that module only after a run reaches final failure.

**Tech Stack:** Rust/Axum/sqlx/PostgreSQL/reqwest for backend and migrations; Next.js/React/TypeScript for admin UI.

## Global Constraints

- Do not create git commits unless the user explicitly asks.
- One workflow or scheduled task has at most one alert Webhook in v1.
- Send alerts only on final failure.
- Throttle per object using `alert_throttle_hours`; `0` means no throttling.
- Webhook sends are best-effort and must never change the original run status.
- Webhook body is a JSON object template; render variables only inside string values.
- Default throttle is 24 hours.

---

## File Structure

- Create `migrations/049_alert_webhooks.sql`: add alert columns and constraints to `management.workflows` and `management.scheduled_tasks`.
- Modify `src/migrate.rs`: register migration 049.
- Create `src/alert_webhook.rs`: shared config structs, template rendering, DB throttling claim, and HTTP POST send helpers.
- Modify `src/main.rs`: add `mod alert_webhook;`.
- Modify `src/workflow_handlers.rs`: include alert fields in workflow structs and create/update requests; persist fields; call alert helper after workflow final failure.
- Modify `src/scheduler/models.rs`: include alert fields in `ScheduledTask`.
- Modify `src/scheduler_handlers.rs`: accept, validate, persist, and return alert fields for scheduled tasks.
- Modify `src/scheduler/runner.rs`: call alert helper after scheduled task final failure.
- Modify `frontend-nextjs/lib/api.ts`: extend scheduled-task types and inputs with alert fields.
- Modify `frontend-nextjs/components/ScheduledTasksManager.tsx`: add alert form fields, JSON validation, payload wiring, and edit refill.
- Modify `frontend-nextjs/components/workflow/WorkflowsManager.tsx`: extend workflow metadata, draft, save, import/export, and edit refill with alert fields.
- Modify `frontend-nextjs/components/workflow/WorkflowEditorHeader.tsx`: render workflow alert settings.

---

### Task 1: Database Schema And Backend Types

**Files:**
- Create: `migrations/049_alert_webhooks.sql`
- Modify: `src/migrate.rs`
- Modify: `src/workflow_handlers.rs`
- Modify: `src/scheduler/models.rs`
- Modify: `src/scheduler_handlers.rs`

**Interfaces:**
- Produces workflow fields: `alert_webhook_url: Option<String>`, `alert_webhook_template: Option<Value>`, `alert_throttle_hours: i32`, `last_alert_sent_at: Option<DateTime/Utc-ish type>`
- Produces scheduled task fields with the same names.
- Later tasks rely on create/update APIs accepting `alert_webhook_url`, `alert_webhook_template`, and `alert_throttle_hours`.

- [ ] **Step 1: Add migration 049**

Create `migrations/049_alert_webhooks.sql`:

```sql
ALTER TABLE management.workflows
    ADD COLUMN IF NOT EXISTS alert_webhook_url TEXT,
    ADD COLUMN IF NOT EXISTS alert_webhook_template JSONB,
    ADD COLUMN IF NOT EXISTS alert_throttle_hours INTEGER NOT NULL DEFAULT 24,
    ADD COLUMN IF NOT EXISTS last_alert_sent_at TIMESTAMPTZ;

ALTER TABLE management.workflows
    DROP CONSTRAINT IF EXISTS chk_workflows_alert_webhook_url;
ALTER TABLE management.workflows
    ADD CONSTRAINT chk_workflows_alert_webhook_url CHECK (
        alert_webhook_url IS NULL
        OR (
            length(trim(alert_webhook_url)) > 0
            AND alert_webhook_url ~ '^https?://'
        )
    );

ALTER TABLE management.workflows
    DROP CONSTRAINT IF EXISTS chk_workflows_alert_webhook_template_object;
ALTER TABLE management.workflows
    ADD CONSTRAINT chk_workflows_alert_webhook_template_object CHECK (
        alert_webhook_template IS NULL
        OR jsonb_typeof(alert_webhook_template) = 'object'
    );

ALTER TABLE management.workflows
    DROP CONSTRAINT IF EXISTS chk_workflows_alert_throttle_hours;
ALTER TABLE management.workflows
    ADD CONSTRAINT chk_workflows_alert_throttle_hours CHECK (
        alert_throttle_hours BETWEEN 0 AND 720
    );

ALTER TABLE management.scheduled_tasks
    ADD COLUMN IF NOT EXISTS alert_webhook_url TEXT,
    ADD COLUMN IF NOT EXISTS alert_webhook_template JSONB,
    ADD COLUMN IF NOT EXISTS alert_throttle_hours INTEGER NOT NULL DEFAULT 24,
    ADD COLUMN IF NOT EXISTS last_alert_sent_at TIMESTAMPTZ;

ALTER TABLE management.scheduled_tasks
    DROP CONSTRAINT IF EXISTS chk_st_alert_webhook_url;
ALTER TABLE management.scheduled_tasks
    ADD CONSTRAINT chk_st_alert_webhook_url CHECK (
        alert_webhook_url IS NULL
        OR (
            length(trim(alert_webhook_url)) > 0
            AND alert_webhook_url ~ '^https?://'
        )
    );

ALTER TABLE management.scheduled_tasks
    DROP CONSTRAINT IF EXISTS chk_st_alert_webhook_template_object;
ALTER TABLE management.scheduled_tasks
    ADD CONSTRAINT chk_st_alert_webhook_template_object CHECK (
        alert_webhook_template IS NULL
        OR jsonb_typeof(alert_webhook_template) = 'object'
    );

ALTER TABLE management.scheduled_tasks
    DROP CONSTRAINT IF EXISTS chk_st_alert_throttle_hours;
ALTER TABLE management.scheduled_tasks
    ADD CONSTRAINT chk_st_alert_throttle_hours CHECK (
        alert_throttle_hours BETWEEN 0 AND 720
    );
```

- [ ] **Step 2: Register migration**

In `src/migrate.rs`, add after migration 048:

```rust
(
    "049 alert webhooks",
    include_str!("../migrations/049_alert_webhooks.sql"),
),
```

- [ ] **Step 3: Extend backend response/request structs**

Add alert fields to `Workflow`, `CreateWorkflowRequest`, `UpdateWorkflowRequest`, `ScheduledTask`, `CreateTaskReq`, and `UpdateTaskReq`.

For workflow timestamp, use `Option<chrono::NaiveDateTime>` because `Workflow` currently maps timestamps as `NaiveDateTime`.

For scheduled task timestamp, use `Option<chrono::DateTime<Utc>>` because `ScheduledTask` already maps `TIMESTAMPTZ` that way.

- [ ] **Step 4: Persist workflow alert fields**

Update workflow insert/update SQL to include:

```sql
alert_webhook_url, alert_webhook_template, alert_throttle_hours
```

Create path default:

```rust
.bind(normalize_alert_url(req.alert_webhook_url.as_deref()))
.bind(req.alert_webhook_template)
.bind(req.alert_throttle_hours.unwrap_or(24))
```

Update path should support explicit clearing:

```sql
alert_webhook_url = $17,
alert_webhook_template = $18,
alert_throttle_hours = COALESCE($19, alert_throttle_hours)
```

The implementation should pass the existing value when the request field is omitted, and `NULL` when the request explicitly sends `null`.

- [ ] **Step 5: Persist scheduled task alert fields**

Update scheduled-task create/update SQL and binds the same way:

```rust
alert_webhook_url = normalize_alert_url(...)
alert_webhook_template = req.alert_webhook_template
alert_throttle_hours = req.alert_throttle_hours.unwrap_or(24)
```

For update, preserve existing values when omitted and clear when explicitly null.

- [ ] **Step 6: Verify compile errors surface exact missed fields**

Run:

```bash
cargo check
```

Expected: either PASS or focused compile errors for remaining struct/query updates. Fix all Task 1 compile errors before moving on.

---

### Task 2: Shared Alert Webhook Module

**Files:**
- Create: `src/alert_webhook.rs`
- Modify: `src/main.rs`

**Interfaces:**
- Produces `render_template(template: &Value, vars: &BTreeMap<String, String>) -> Value`
- Produces `spawn_workflow_failure_alert(pool: PgPool, workflow_id: i32, ctx: AlertWebhookContext)`
- Produces `spawn_scheduled_task_failure_alert(pool: PgPool, task_id: i64, ctx: AlertWebhookContext)`

- [ ] **Step 1: Write template-rendering tests**

Add unit tests in `src/alert_webhook.rs`:

```rust
#[test]
fn render_template_replaces_nested_string_values() {
    let template = serde_json::json!({
        "msg_type": "markdown",
        "content": "name={{name}} error={{error}}",
        "nested": { "trace": "{{trace_id}}" },
        "count": 3
    });
    let vars = BTreeMap::from([
        ("name".to_string(), "orders".to_string()),
        ("error".to_string(), "boom".to_string()),
        ("trace_id".to_string(), "tr_1".to_string()),
    ]);

    assert_eq!(
        render_template(&template, &vars),
        serde_json::json!({
            "msg_type": "markdown",
            "content": "name=orders error=boom",
            "nested": { "trace": "tr_1" },
            "count": 3
        })
    );
}

#[test]
fn render_template_keeps_unknown_variables() {
    let template = serde_json::json!({ "content": "{{missing}} {{name}}" });
    let vars = BTreeMap::from([("name".to_string(), "wf".to_string())]);
    assert_eq!(
        render_template(&template, &vars),
        serde_json::json!({ "content": "{{missing}} wf" })
    );
}
```

- [ ] **Step 2: Implement module**

Implement:

```rust
use chrono::Utc;
use reqwest::Client;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use std::collections::BTreeMap;
use std::time::Duration;

pub const DEFAULT_ALERT_TEMPLATE: &str = r#"{"msg_type":"markdown","content":"### 🚨 报警\n- **类型**: {{source}}\n- **名称**: {{name}}\n- **状态**: {{status}}\n- **错误**: {{error}}\n- **时间**: {{time}}\n- **Run ID**: {{run_id}}"}"#;

#[derive(Debug, Clone)]
pub struct AlertWebhookContext {
    pub source: &'static str,
    pub object_id: i64,
    pub run_id: i64,
    pub name: String,
    pub status: String,
    pub error: Option<String>,
    pub trigger_type: String,
    pub trace_id: Option<String>,
}
```

`spawn_*` should `tokio::spawn` a best-effort async block. Inside, atomically claim with `UPDATE ... RETURNING alert_webhook_url, alert_webhook_template`. If no row is returned, throttle or missing URL suppressed the send.

- [ ] **Step 3: Register module**

Add in `src/main.rs`:

```rust
mod alert_webhook;
```

- [ ] **Step 4: Run unit tests**

Run:

```bash
cargo test alert_webhook --lib
```

Expected: PASS.

---

### Task 3: Backend Execution Hookups

**Files:**
- Modify: `src/workflow_handlers.rs`
- Modify: `src/scheduler/runner.rs`

**Interfaces:**
- Consumes `crate::alert_webhook::AlertWebhookContext`
- Consumes `spawn_workflow_failure_alert` and `spawn_scheduled_task_failure_alert`

- [ ] **Step 1: Hook workflow failures**

After workflow final failure branches have written `workflow_runs` and finished `execution_index`, call:

```rust
crate::alert_webhook::spawn_workflow_failure_alert(
    pool.clone(),
    workflow.id,
    crate::alert_webhook::AlertWebhookContext {
        source: "workflow",
        object_id: workflow.id as i64,
        run_id: run.id,
        name: workflow.name.clone(),
        status: "failed".to_string(),
        error: Some(masked_err_or_msg.clone()),
        trigger_type: trigger_type.to_string(),
        trace_id: Some(trace_id.clone()),
    },
);
```

Do this for timeout, node-result failure, and engine `Err` branches. Do not call it for completed runs or `WorkflowRunGuard::drop`.

- [ ] **Step 2: Hook scheduled task final failures**

In `SchedulerRunner::execute_one`, after `finalize_run` and `update_task_after_run`, add:

```rust
if matches!(status, "failed" | "timeout") && attempt >= task.max_retries {
    crate::alert_webhook::spawn_scheduled_task_failure_alert(
        self.pool.clone(),
        task.id,
        crate::alert_webhook::AlertWebhookContext {
            source: "scheduled_task",
            object_id: task.id,
            run_id,
            name: task.name.clone(),
            status: status.to_string(),
            error: err_msg.clone(),
            trigger_type: triggered_by.to_string(),
            trace_id: Some(trace_id.clone()),
        },
    );
}
```

- [ ] **Step 3: Run backend checks**

Run:

```bash
cargo check
cargo test alert_webhook --lib
```

Expected: PASS.

---

### Task 4: Frontend Scheduled Task Settings

**Files:**
- Modify: `frontend-nextjs/lib/api.ts`
- Modify: `frontend-nextjs/components/ScheduledTasksManager.tsx`

**Interfaces:**
- Consumes backend fields `alert_webhook_url`, `alert_webhook_template`, `alert_throttle_hours`, `last_alert_sent_at`
- Produces create/update payloads with alert fields.

- [ ] **Step 1: Extend TypeScript types**

Add to scheduled task interfaces:

```ts
alert_webhook_url: string | null
alert_webhook_template: Record<string, unknown> | null
alert_throttle_hours: number
last_alert_sent_at: string | null
```

Add optional input fields:

```ts
alert_webhook_url?: string | null
alert_webhook_template?: Record<string, unknown> | null
alert_throttle_hours?: number
```

- [ ] **Step 2: Extend form state**

Add to `FormState` and `EMPTY_FORM`:

```ts
alert_webhook_url: string
alert_webhook_template: string
alert_throttle_hours: number
```

Default template should be pretty-printed JSON matching the spec.

- [ ] **Step 3: Wire edit refill and payload validation**

In `startEdit`, refill from task fields.

In `buildCreatePayload`, if `alert_webhook_url.trim()` is non-empty, parse `alert_webhook_template` as JSON object and set:

```ts
payload.alert_webhook_url = form.alert_webhook_url.trim()
payload.alert_webhook_template = parsedTemplate
payload.alert_throttle_hours = form.alert_throttle_hours
```

If URL is empty, send `null` for URL and template so update can clear existing alert config.

- [ ] **Step 4: Render scheduled task alert fields**

Add a “失败告警 Webhook” section near timeout/retry controls with URL input, throttle number input, template textarea, and variable hint text.

- [ ] **Step 5: Run frontend check**

Run:

```bash
cd frontend-nextjs && npm run lint
```

Expected: PASS or only unrelated pre-existing warnings.

---

### Task 5: Frontend Workflow Settings

**Files:**
- Modify: `frontend-nextjs/components/workflow/WorkflowsManager.tsx`
- Modify: `frontend-nextjs/components/workflow/WorkflowEditorHeader.tsx`

**Interfaces:**
- Consumes backend workflow fields `alert_webhook_url`, `alert_webhook_template`, `alert_throttle_hours`, `last_alert_sent_at`
- Produces workflow save payload with alert fields.

- [ ] **Step 1: Extend workflow and metadata types**

Add fields to `Workflow`:

```ts
alert_webhook_url: string | null
alert_webhook_template: Record<string, unknown> | null
alert_throttle_hours: number
last_alert_sent_at: string | null
```

Add string fields to `WorkflowFormMeta` and `FormMeta` in `WorkflowEditorHeader.tsx`:

```ts
alert_webhook_url: string
alert_webhook_template: string
alert_throttle_hours: number
```

- [ ] **Step 2: Wire defaults, drafts, edit refill, import/export**

Update `blankMeta`, `setFormMeta` calls for existing workflows, draft persistence, import, and export with alert fields.

- [ ] **Step 3: Validate and save template**

In `handleSave`, parse alert template only when URL is non-empty. Add to payload:

```ts
alert_webhook_url: formMeta.alert_webhook_url.trim() || null,
alert_webhook_template: formMeta.alert_webhook_url.trim() ? parsedAlertTemplate : null,
alert_throttle_hours: formMeta.alert_throttle_hours,
```

Invalid JSON should show `alert('告警模板 JSON 格式错误')` and stop save.

- [ ] **Step 4: Render workflow alert fields**

In `WorkflowEditorHeader`, add URL, throttle, and template inline fields or a compact alert block near timeout/retry metadata. Include variable hint text.

- [ ] **Step 5: Run frontend check**

Run:

```bash
cd frontend-nextjs && npm run lint
```

Expected: PASS or only unrelated pre-existing warnings.

---

### Task 6: Final Verification

**Files:**
- All changed files.

**Interfaces:**
- Confirms backend and frontend work together.

- [ ] **Step 1: Run backend verification**

Run:

```bash
cargo check
cargo test alert_webhook --lib
```

Expected: PASS.

- [ ] **Step 2: Run frontend verification**

Run:

```bash
cd frontend-nextjs && npm run lint
```

Expected: PASS or documented unrelated pre-existing warnings.

- [ ] **Step 3: Check lints in edited files**

Use Cursor diagnostics for edited files and fix introduced issues.

- [ ] **Step 4: Summarize**

Report:

- data model/migration added
- backend alert sender and final-failure hookups added
- workflow and scheduled-task UI configuration added
- verification commands and results
