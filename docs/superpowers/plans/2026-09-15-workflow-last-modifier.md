# Workflow List Last Modifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show who last saved or published each workflow on the list, and filter the list by that person, without changing the existing creator column.

**Architecture:** Persist `management.workflows.updated_by`. `upsert_draft` writes it in the same SQL as the draft (CTE) so save/import/duplicate/restore stay one executor call. `publish_workflow` sets it on the live-row UPDATE. List JOINs `users` twice (`cu` creator, `uu` updater) and accepts `updater` / `include_updaters`. Frontend adds a column and an author-style dropdown.

**Tech Stack:** Rust (axum, sqlx, Postgres), Next.js 14 (`frontend-nextjs/components/workflow/list/`).

**Spec:** `docs/superpowers/specs/2026-09-15-workflow-last-modifier-design.md`

## Global Constraints

- Do not create git commits unless the user explicitly asks. Keep Commit steps but skip them until asked.
- Keep 「作者」 as `created_by`. Do not merge the two name columns when they match.
- Top search box still matches ID / name / slug / description / department / category only — not usernames.
- Do not bump `updated_by` on enable/disable, move/taxonomy-only, alerts, `database_id`, or discard-draft.
- Do not add MCP tool parameters. Extra JSON fields from `list_workflows` are enough.
- Do not add sort-by-updater. Existing `sort=updated_at` stays.
- Query param name is `updater` (username, including `未知`). Column name is `updated_by` (user id).
- Repo frontend tests are standalone `node:assert` files; run with `npx tsx <file>`.

---

## File Structure

| Path | Responsibility |
|------|----------------|
| `migrations/069_workflow_updated_by.sql` | Add column, index, backfill |
| `migrations/022_workflows.sql` | Fresh-DB `CREATE TABLE` includes `updated_by` |
| `src/migrate.rs` | Register 068 |
| `src/bin/migrate_workflow.rs` | Fresh DAG `CREATE TABLE` includes `updated_by` |
| `src/workflow_handlers.rs` | `Workflow` fields; list JOIN/filter; publish SET |
| `src/workflow_draft.rs` | `upsert_draft` CTE also writes `workflows.updated_by` |
| `src/workflow_kafka_trigger.rs` | Test `Workflow { }` literal |
| `src/workflow_notify_trigger.rs` | Test `Workflow { }` literal |
| `frontend-nextjs/components/workflow/list/types.ts` | `updater` state + item fields |
| `frontend-nextjs/components/workflow/list/listApi.ts` | Query params + `updaters` |
| `frontend-nextjs/components/workflow/list/listApi.test.ts` | Param builder tests |
| `frontend-nextjs/components/workflow/list/WorkflowListToolbar.tsx` | Updater dropdown |
| `frontend-nextjs/components/workflow/list/WorkflowListView.tsx` | State, fetch, reset |
| `frontend-nextjs/components/workflow/list/constants.ts` | Grid one extra md column |
| `frontend-nextjs/components/workflow/list/WorkflowListHeader.tsx` | 「最近修改人」 |
| `frontend-nextjs/components/workflow/list/WorkflowRow.tsx` | Compact + card cells |

---

### Task 1: Schema + `Workflow.updated_by`

**Files:**
- Create: `migrations/069_workflow_updated_by.sql`
- Modify: `migrations/022_workflows.sql`
- Modify: `src/migrate.rs` (after the 067 tuple)
- Modify: `src/bin/migrate_workflow.rs` (`CREATE TABLE management.workflows`)
- Modify: `src/workflow_handlers.rs` (`Workflow` struct ~348)
- Modify: `src/workflow_draft.rs` (`live_wf` test literal)
- Modify: `src/workflow_handlers.rs` (`dummy_workflow` ~5543)
- Modify: `src/workflow_kafka_trigger.rs` (test `workflow()`)
- Modify: `src/workflow_notify_trigger.rs` (test `workflow()`)

**Interfaces:**
- Consumes: `users(id)`, existing `created_by` / drafts / versions
- Produces:
  - Column `management.workflows.updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL`
  - `Workflow.updated_by: Option<i32>` (table column, not `sqlx(default)`)
  - `Workflow.updated_by_name: Option<String>` and `updated_by_email: Option<String>` with `#[sqlx(default)]`

- [ ] **Step 1: Write the migration**

`migrations/069_workflow_updated_by.sql`:

```sql
-- 工作流最近修改人：保存草稿 / 发布时写入；启停与挪分类不改。
ALTER TABLE management.workflows
  ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_workflows_updated_by
  ON management.workflows(updated_by);

UPDATE management.workflows w
SET updated_by = COALESCE(
  (SELECT d.updated_by FROM management.workflow_drafts d WHERE d.workflow_id = w.id),
  (SELECT v.created_by FROM management.workflow_versions v
    WHERE v.workflow_id = w.id ORDER BY v.version DESC LIMIT 1),
  w.created_by
)
WHERE w.updated_by IS NULL;
```

In `migrations/022_workflows.sql`, add `updated_by INTEGER,` immediately after `created_by INTEGER,`.

In `src/bin/migrate_workflow.rs` `CREATE TABLE management.workflows`, add `updated_by INTEGER,` after `created_by INTEGER,`.

In `src/migrate.rs`, after the 067 tuple:

```rust
    (
        "069 workflow updated by",
        include_str!("../migrations/069_workflow_updated_by.sql"),
    ),
```

- [ ] **Step 2: Extend `Workflow` and fix literals**

In `src/workflow_handlers.rs` `Workflow`, after `created_by`:

```rust
    pub created_by: Option<i32>,
    pub updated_by: Option<i32>,
    pub created_at: chrono::NaiveDateTime,
    pub updated_at: chrono::NaiveDateTime,
    // 创建者账号信息：仅在列表/详情查询里 JOIN users 填充；其它 SELECT * 查询缺列时默认 None。
    #[sqlx(default)]
    pub created_by_name: Option<String>,
    #[sqlx(default)]
    pub created_by_email: Option<String>,
    #[sqlx(default)]
    pub updated_by_name: Option<String>,
    #[sqlx(default)]
    pub updated_by_email: Option<String>,
```

Add `updated_by: None, updated_by_name: None, updated_by_email: None,` to every `Workflow {` literal:

- `src/workflow_draft.rs` `live_wf`
- `src/workflow_handlers.rs` `dummy_workflow`
- `src/workflow_kafka_trigger.rs` test helper
- `src/workflow_notify_trigger.rs` test helper

- [ ] **Step 3: Compile**

Run: `cargo test --lib workflow_draft -- --nocapture`

Expected: PASS (existing draft unit tests). If rustc errors on missing fields, fix remaining `Workflow {` literals (`rg 'Workflow \{' --type rust`).

- [ ] **Step 4: Commit (skip unless asked)**

```bash
git add migrations/069_workflow_updated_by.sql migrations/022_workflows.sql src/migrate.rs src/bin/migrate_workflow.rs src/workflow_handlers.rs src/workflow_draft.rs src/workflow_kafka_trigger.rs src/workflow_notify_trigger.rs
git commit -m "$(cat <<'EOF'
Add workflows.updated_by for last definition editor.

EOF
)"
```

---

### Task 2: `upsert_draft` writes `workflows.updated_by`

**Files:**
- Modify: `src/workflow_draft.rs` (`upsert_draft`)

**Interfaces:**
- Consumes: `WorkflowDraft.updated_by: Option<i32>`, `workflow_id`
- Produces: same `pub async fn upsert_draft<'e, E>(executor: E, draft: &WorkflowDraft) -> Result<()>` signature. One SQL statement so `&mut *tx` and `&pool` still work. `updated_by = None` does not clear the main-table column.

- [ ] **Step 1: Write the failing test**

Append in `src/workflow_draft.rs` `mod tests`:

```rust
    #[test]
    fn upsert_draft_sql_updates_workflow_when_updated_by_present() {
        let sql = upsert_draft_sql();
        assert!(sql.contains("INSERT INTO management.workflow_drafts"), "{sql}");
        assert!(
            sql.contains("UPDATE management.workflows w"),
            "{sql}"
        );
        assert!(
            sql.contains("AND d.updated_by IS NOT NULL"),
            "{sql}"
        );
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib upsert_draft_sql_updates_workflow_when_updated_by_present -- --nocapture`

Expected: FAIL (`upsert_draft_sql` not found, or SQL lacks the UPDATE).

- [ ] **Step 3: Implement**

Extract the query string and use a CTE so the existing `Executor` bound still runs one statement. Replace the SQL inside `upsert_draft` and add:

```rust
pub fn upsert_draft_sql() -> &'static str {
    r#"WITH d AS (
            INSERT INTO management.workflow_drafts
            (workflow_id, name, slug, description, category, department,
             trigger_type, trigger_config, input_schema, nodes, edges, dependencies,
             timeout_ms, max_retries, note, updated_by, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
            ON CONFLICT (workflow_id) DO UPDATE SET
              name = EXCLUDED.name,
              slug = EXCLUDED.slug,
              description = EXCLUDED.description,
              category = EXCLUDED.category,
              department = EXCLUDED.department,
              trigger_type = EXCLUDED.trigger_type,
              trigger_config = EXCLUDED.trigger_config,
              input_schema = EXCLUDED.input_schema,
              nodes = EXCLUDED.nodes,
              edges = EXCLUDED.edges,
              dependencies = EXCLUDED.dependencies,
              timeout_ms = EXCLUDED.timeout_ms,
              max_retries = EXCLUDED.max_retries,
              note = EXCLUDED.note,
              updated_by = EXCLUDED.updated_by,
              updated_at = EXCLUDED.updated_at
            RETURNING workflow_id, updated_by
        )
        UPDATE management.workflows w
        SET updated_by = d.updated_by
        FROM d
        WHERE w.id = d.workflow_id
          AND d.updated_by IS NOT NULL"#
}
```

`upsert_draft` uses `sqlx::query(upsert_draft_sql())` with the same 17 binds as today. Do **not** change taxonomy-only `UPDATE workflow_drafts SET category, department` in `workflow_handlers.rs`.

- [ ] **Step 4: Run tests**

Run: `cargo test --lib workflow_draft -- --nocapture`

Expected: PASS.

- [ ] **Step 5: Commit (skip unless asked)**

```bash
git add src/workflow_draft.rs
git commit -m "$(cat <<'EOF'
Sync workflows.updated_by when upserting a definition draft.

EOF
)"
```

---

### Task 3: List API `updater` + `include_updaters`

**Files:**
- Modify: `src/workflow_handlers.rs` (`ParsedListParams`, `parse_list_params`, `push_list_filters`, `list_workflows`, and any other `push_list_filters` caller — currently COUNT, list SELECT, authors DISTINCT; dependency-graph listing also uses `parse_list_params` around 1285 and must keep compiling)

**Interfaces:**
- Consumes: query `updater`, `include_updaters`
- Produces:
  - `ParsedListParams { updater: Option<String>, include_updaters: bool, ... }`
  - List JSON fields `updated_by`, `updated_by_name`, `updated_by_email`
  - `updaters: string[]` when `include_updaters=1`
  - Shared FROM clause with both user joins (required by spec)

- [ ] **Step 1: Write failing tests**

In `src/workflow_handlers.rs` existing `#[cfg(test)]` module (the one with `publish_note_prefers_trimmed_request_then_draft`, ~5500), add:

```rust
    #[test]
    fn parse_list_params_reads_updater_and_include_updaters() {
        let mut params = std::collections::HashMap::new();
        params.insert("updater".into(), " 宗心 ".into());
        params.insert("include_updaters".into(), "1".into());
        let p = parse_list_params(&params);
        assert_eq!(p.updater.as_deref(), Some("宗心"));
        assert!(p.include_updaters);
        assert!(!p.include_authors);
    }

    #[test]
    fn list_from_sql_joins_creator_and_updater() {
        let sql = list_from_sql();
        assert!(sql.contains("LEFT JOIN users cu ON cu.id = w.created_by"), "{sql}");
        assert!(sql.contains("LEFT JOIN users uu ON uu.id = w.updated_by"), "{sql}");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib parse_list_params_reads_updater -- --nocapture`

Expected: FAIL (missing fields / `list_from_sql`).

- [ ] **Step 3: Implement**

Add next to `LIST_MAX_PAGE_SIZE`:

```rust
fn list_from_sql() -> &'static str {
    "FROM management.workflows w \
     LEFT JOIN users cu ON cu.id = w.created_by \
     LEFT JOIN users uu ON uu.id = w.updated_by "
}

const LIST_SELECT: &str =
    "SELECT w.*, cu.username AS created_by_name, cu.email AS created_by_email, \
     uu.username AS updated_by_name, uu.email AS updated_by_email ";
```

`ParsedListParams` add:

```rust
    updater: Option<String>,
    include_updaters: bool,
```

In `parse_list_params`, mirror `author` / `include_authors`:

```rust
        updater: params
            .get("updater")
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        include_updaters: params
            .get("include_updaters")
            .map(|s| parse_bool_param(s))
            .unwrap_or(false),
```

In `push_list_filters`, immediately after the `author` block:

```rust
    if let Some(updater) = &p.updater {
        if updater == "未知" {
            qb.push(" AND uu.username IS NULL");
        } else {
            qb.push(" AND uu.username = ").push_bind(updater.clone());
        }
    }
```

Rewrite `list_workflows`:

- COUNT: `QueryBuilder::new(format!("SELECT COUNT(*)::bigint {}", list_from_sql()))`
- List: `QueryBuilder::new(format!("{}{}", LIST_SELECT, list_from_sql()))`
- Authors DISTINCT (keep applying `push_list_filters`): start from `list_from_sql()` so `uu` exists when `updater` is set
- After authors block, if `p.include_updaters`:

```rust
    if p.include_updaters {
        let mut up_qb: sqlx::QueryBuilder<sqlx::Postgres> = sqlx::QueryBuilder::new(
            format!(
                "SELECT DISTINCT COALESCE(uu.username, '未知') AS updater {}",
                list_from_sql()
            ),
        );
        push_list_scope(&mut up_qb, &scope);
        push_list_filters(&mut up_qb, &p);
        up_qb.push(" ORDER BY updater ASC");
        let updaters: Vec<String> = up_qb
            .build_query_scalar::<String>()
            .fetch_all(&pool)
            .await?;
        out["updaters"] = json!(updaters);
    }
```

Do **not** add username matching to the `search` loop.

If another handler builds `FROM management.workflows w LEFT JOIN users cu` for listing (grep `created_by_name`), switch it to `list_from_sql()` only when it also calls `push_list_filters`. Dependency graph queries that do not use `push_list_filters` stay as they are.

- [ ] **Step 4: Run tests**

Run: `cargo test --lib parse_list_params_reads_updater -- --nocapture && cargo test --lib list_from_sql_joins_creator_and_updater -- --nocapture`

Expected: PASS.

- [ ] **Step 5: Commit (skip unless asked)**

```bash
git add src/workflow_handlers.rs
git commit -m "$(cat <<'EOF'
Filter workflow list by last modifier username.

EOF
)"
```

---

### Task 4: Publish writes `updated_by`

**Files:**
- Modify: `src/workflow_handlers.rs` (`publish_workflow` live UPDATE ~3431)

**Interfaces:**
- Consumes: `claims.sub: i32`
- Produces: live-row UPDATE includes `updated_by = $15` bound to `claims.sub`. Draft delete after publish still does **not** clear `workflows.updated_by`.

- [ ] **Step 1: Write the failing test**

Same test module:

```rust
    #[test]
    fn publish_live_update_sql_sets_updated_by() {
        let sql = publish_live_update_sql();
        assert!(sql.contains("updated_by = $15"), "{sql}");
        assert!(sql.contains("name = $2"), "{sql}");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib publish_live_update_sql_sets_updated_by -- --nocapture`

Expected: FAIL (`publish_live_update_sql` missing).

- [ ] **Step 3: Implement**

Add:

```rust
fn publish_live_update_sql() -> &'static str {
    r#"UPDATE management.workflows SET
            name = $2, slug = $3, description = $4, category = $5, department = $6,
            trigger_type = $7, trigger_config = $8, input_schema = $9, nodes = $10, edges = $11,
            dependencies = $12, timeout_ms = $13, max_retries = $14, updated_by = $15
           WHERE id = $1
           RETURNING *"#
}
```

`publish_workflow` uses `sqlx::query_as::<_, Workflow>(publish_live_update_sql())` and `.bind(claims.sub)` after `.bind(draft.max_retries)`.

Do not set `updated_by` on the follow-up `SET published_version` query. Do not call `upsert_draft` from publish.

- [ ] **Step 4: Run tests**

Run: `cargo test --lib publish_live_update_sql_sets_updated_by -- --nocapture && cargo test --lib publish_without_draft_messages -- --nocapture`

Expected: PASS.

- [ ] **Step 5: Commit (skip unless asked)**

```bash
git add src/workflow_handlers.rs
git commit -m "$(cat <<'EOF'
Record publisher as workflows.updated_by.

EOF
)"
```

---

### Task 5: Frontend query params and list state

**Files:**
- Modify: `frontend-nextjs/components/workflow/list/types.ts`
- Modify: `frontend-nextjs/components/workflow/list/listApi.ts`
- Create: `frontend-nextjs/components/workflow/list/listApi.test.ts`
- Modify: `frontend-nextjs/components/workflow/list/WorkflowListView.tsx`

**Interfaces:**
- Consumes: `WorkflowListPageState.updater`, API `updaters`
- Produces:
  - `buildListQueryParams` sends `include_updaters: '1'` and `updater` when set
  - `fetchWorkflowList` returns `updaters?: string[]`
  - View state `updater: string | null`, reset/folder-change/empty-state all clear it

- [ ] **Step 1: Write the failing test**

`frontend-nextjs/components/workflow/list/listApi.test.ts`:

```ts
import assert from 'node:assert/strict'
import { buildListQueryParams } from './listApi'
import {
  DEFAULT_LIST_PER_PAGE,
  DEFAULT_LIST_SORT,
  ROOT_FOLDER_ID,
  type WorkflowListPageState,
} from './types'

function baseState(over: Partial<WorkflowListPageState> = {}): WorkflowListPageState {
  return {
    folderId: ROOT_FOLDER_ID,
    expanded: new Set([ROOT_FOLDER_ID]),
    status: 'all',
    trigs: new Set(),
    author: null,
    updater: null,
    sort: DEFAULT_LIST_SORT,
    view: 'compact',
    search: '',
    globalSearch: false,
    page: 1,
    perPage: DEFAULT_LIST_PER_PAGE,
    ...over,
  }
}

{
  const params = buildListQueryParams(baseState())
  assert.equal(params.include_authors, '1')
  assert.equal(params.include_updaters, '1')
  assert.equal('updater' in params, false)
  assert.equal('author' in params, false)
}

{
  const params = buildListQueryParams(baseState({ updater: '宗心', author: '李四' }))
  assert.equal(params.updater, '宗心')
  assert.equal(params.author, '李四')
}

console.log('listApi tests passed')
```

This fails until `updater` exists on the type and `include_updaters` is sent.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend-nextjs && npx tsx components/workflow/list/listApi.test.ts`

Expected: FAIL (missing `updater` on state, or `include_updaters` undefined).

- [ ] **Step 3: Implement types + `listApi` + view wiring**

`types.ts` `WorkflowListPageState`:

```ts
  author: string | null
  updater: string | null
```

`WorkflowListItem` after `created_by_email`:

```ts
  updated_by: number | null
  updated_by_name: string | null
  updated_by_email: string | null
```

`listApi.ts`:

```ts
export interface PaginatedWorkflowList {
  workflows: WorkflowListItem[]
  total: number
  page: number
  page_size: number
  authors?: string[]
  updaters?: string[]
}
```

In `buildListQueryParams` params object add `include_updaters: '1'`. After `if (state.author) params.author = state.author`:

```ts
  if (state.updater) params.updater = state.updater
```

`fetchWorkflowList` return `updaters: data.updaters`.

`WorkflowListView.tsx` (state only; fetching `updaters` into React state is Task 6):

- Initial state: `updater: null` next to `author: null`
- page-reset effect deps: add `state.updater`
- `resetFiltersOnFolderChange`: `updater: null`
- `isEmptyFolder`: `!state.updater &&`
- `onResetFilters`: `updater: null`

Do not change `WorkflowListToolbar` props in this task. The toolbar still only reads `author`. Task 6 wires the dropdown and `setUpdaters`.

- [ ] **Step 4: Run test**

Run: `cd frontend-nextjs && npx tsx components/workflow/list/listApi.test.ts`

Expected: `listApi tests passed`

- [ ] **Step 5: Commit (skip unless asked)**

```bash
git add frontend-nextjs/components/workflow/list/types.ts frontend-nextjs/components/workflow/list/listApi.ts frontend-nextjs/components/workflow/list/listApi.test.ts frontend-nextjs/components/workflow/list/WorkflowListView.tsx
git commit -m "$(cat <<'EOF'
Pass updater filter on the workflow list request.

EOF
)"
```

---

### Task 6: Toolbar dropdown + list column

**Files:**
- Modify: `frontend-nextjs/components/workflow/list/constants.ts`
- Modify: `frontend-nextjs/components/workflow/list/WorkflowListHeader.tsx`
- Modify: `frontend-nextjs/components/workflow/list/WorkflowRow.tsx`
- Modify: `frontend-nextjs/components/workflow/list/WorkflowListToolbar.tsx`
- Modify: `frontend-nextjs/components/workflow/list/WorkflowListView.tsx` (toolbar props)

**Interfaces:**
- Consumes: `updaters: string[]`, `state.updater`, `onSetUpdater`
- Produces: compact header/row column 「最近修改人」; card meta includes both names; dropdown labeled 「最近修改人」

- [ ] **Step 1: Widen the compact grid**

Replace `COMPACT_LIST_GRID_CLASS` in `constants.ts`:

```ts
export const COMPACT_LIST_GRID_CLASS =
  'grid gap-x-3 px-5 [grid-template-columns:28px_minmax(0,1fr)_6.5rem_9.75rem] sm:[grid-template-columns:28px_minmax(0,1fr)_6.5rem_3.5rem_9.75rem] md:[grid-template-columns:28px_minmax(0,1fr)_6.5rem_3.5rem_minmax(0,4.5rem)_minmax(0,4.5rem)_5.5rem_9.75rem]'
```

Columns at `md`: icon | name | trigger | status | author | last modifier | time | actions.

- [ ] **Step 2: Header + row + card**

`WorkflowListHeader.tsx` between 作者 and 更新时间:

```tsx
      <span className="hidden md:block justify-self-start">作者</span>
      <span className="hidden md:block justify-self-start">最近修改人</span>
      <span className="hidden md:block justify-self-start">更新时间</span>
```

`WorkflowRow.tsx` compact row, after the author `<span>` (~220), before 更新时间:

```tsx
      <span
        className={cn(
          COMPACT_LIST_META_CELL_CLASS,
          LIST_BODY_TEXT_CLASS,
          'text-slate-500 hidden md:flex truncate justify-self-start min-w-0',
        )}
        title={w.updated_by_email || w.updated_by_name || '未知'}
      >
        {w.updated_by_name || '未知'}
      </span>
```

Keep the author cell as `created_by_name`. Do not skip rendering when names match.

Card footer (`WorkflowCard`, ~337):

```tsx
            <span>{w.nodes?.length || 0} 节点</span>
            <span>·</span>
            <span>{w.created_by_name || '未知'}</span>
            <span>·</span>
            <span>{w.updated_by_name || '未知'}</span>
            <span>·</span>
            <span>{formatRelativeTime(w.updated_at)}</span>
```

- [ ] **Step 3: Toolbar dropdown**

Extend `WorkflowListToolbarProps`:

```ts
  authors: string[]
  updaters: string[]
  onSetAuthor: (author: string | null) => void
  onSetUpdater: (updater: string | null) => void
```

Duplicate the author dropdown block immediately after it (do not extract unless the file stays readable). Differences:

- `openDrop` union includes `'updater'`
- local `updaterSearch` / `updaterInputRef` / `updaterDropRef`
- button label: `state.updater || '最近修改人'`
- icon can stay `fa-user-pen` (or `fa-user-clock`) to distinguish from 作者
- list from `updaters`, `onSetUpdater`
- placeholders: 「搜索最近修改人…」「全部」「无匹配」
- ChipClear: 「清除最近修改人筛选」

`hasActiveFilters` add `!!state.updater`.

`openDrop` outside-click map includes `updater: updaterDropRef`.

`WorkflowListView.tsx` toolbar:

```tsx
            updaters={updaters}
            onSetUpdater={(updater) => setState((s) => ({ ...s, updater, page: 1 }))}
```

Also in `WorkflowListView.tsx`:

- `const [updaters, setUpdaters] = useState<string[]>([])` next to `authors`
- `reloadList`: `setUpdaters(result.updaters ?? [])` next to `setAuthors`

- [ ] **Step 4: Typecheck list files**

Run: `cd frontend-nextjs && npx tsc --noEmit --pretty false 2>&1 | rg "workflow/list" || true`

Expected: no errors under `components/workflow/list/`. Unrelated project errors may exist; do not fix them in this task.

- [ ] **Step 5: Manual check (when the app is running)**

1. Open 工作流 list compact view: 作者 and 最近修改人 both visible at desktop width.
2. Pick a 最近修改人 in the dropdown: list narrows; 清空筛选 restores.
3. Enable/disable a workflow: 最近修改人 does not change after reload.
4. Save a draft as user A, reload: 最近修改人 is A; 作者 unchanged if someone else created it.

- [ ] **Step 6: Commit (skip unless asked)**

```bash
git add frontend-nextjs/components/workflow/list/constants.ts frontend-nextjs/components/workflow/list/WorkflowListHeader.tsx frontend-nextjs/components/workflow/list/WorkflowRow.tsx frontend-nextjs/components/workflow/list/WorkflowListToolbar.tsx frontend-nextjs/components/workflow/list/WorkflowListView.tsx
git commit -m "$(cat <<'EOF'
Show and filter workflows by last modifier.

EOF
)"
```

---

## Spec coverage

| Spec section | Task |
|---|---|
| 3.1 column + index + 022/migrate_workflow | Task 1 |
| 3.2 backfill | Task 1 |
| 3.3 upsert_draft writes; None does not clear | Task 2 |
| 3.3 publish UPDATE | Task 4 |
| 3.3 taxonomy/enable/discard unchanged | Task 2 (do not touch those paths) + Task 4 (publish only) |
| 4.1 both JOINs on every `push_list_filters` query | Task 3 |
| 4.2 `updater` / `include_updaters` / search unchanged | Task 3 |
| 5.1 state + query | Task 5 |
| 5.2 dropdown | Task 6 |
| 5.3 column + card | Task 6 |
| 6 tests | Tasks 2–5 unit tests; Task 6 manual |
| 7 deleted user → 未知 | Task 1 `ON DELETE SET NULL` + Task 3 `updater=未知` |
