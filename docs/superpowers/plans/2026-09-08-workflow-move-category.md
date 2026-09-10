# Workflow Move Category Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the workflow list move one or many workflows to another department/category via a shared modal, using `POST /api/admin/workflows/batch` with `action: "move"`.

**Architecture:** Add `resolve_batch_move_target` next to existing taxonomy normalize. Extend `batch_workflows` with `move` + `UPDATE department/category`. Frontend reuses the batch bar/modal shell; option lists come from summary groups + custom folders (same tree as the sidebar).

**Tech Stack:** Rust (axum, sqlx, existing `workflow_taxonomy`), Next.js 14 React (`WorkflowListView` list).

**Spec:** `docs/superpowers/specs/2026-09-08-workflow-move-category-design.md`

## Global Constraints

- Do not create git commits unless the user explicitly asks. Keep Commit steps but skip them until asked.
- Do not add `/workflows/move`. Do not add a new MCP tool.
- Do not drag workflow rows onto the sidebar. Do not create categories in the modal.
- Do not write `workflow_versions` on move.
- Batch still max **500** ids; same `require_admin_for_workflow` and `failed[]` as enable/delete.
- Persist via `normalize_for_storage` (empty →「共享」/「未分类」).
- `enable` / `disable` / `delete` without `department`/`category` must keep working.

---

## File Structure

- Modify `src/workflow_taxonomy.rs`: `resolve_batch_move_target`, `same_taxonomy`.
- Modify `src/workflow_handlers.rs`: `BatchWorkflowRequest` fields; `batch_workflows` `move` branch + op log.
- Modify `frontend-nextjs/components/workflow/list/batchApi.ts`: `move` + `batchMoveWorkflows`.
- Modify `frontend-nextjs/components/workflow/list/utils.ts`: `moveDepartmentOptions` / `moveCategoryOptions` / `defaultMoveTarget`.
- Modify `frontend-nextjs/components/workflow/list/WorkflowBatchBar.tsx`: Move button.
- Modify `frontend-nextjs/components/workflow/list/WorkflowBatchModals.tsx`: move modal.
- Modify `frontend-nextjs/components/workflow/list/RowMenu.tsx` + `WorkflowRow.tsx` / `WorkflowCard.tsx` + `WorkflowListView.tsx`: wire single + batch.

---

### Task 1: Taxonomy helpers for batch move

**Files:**
- Modify: `src/workflow_taxonomy.rs`

**Interfaces:**
- Consumes: `from_parts`, `normalize_for_storage`, `SHARED_DEPARTMENT`, `UNCATEGORIZED_CATEGORY`
- Produces:
  - `pub fn resolve_batch_move_target(department: Option<&str>, category: Option<&str>) -> Result<WorkflowTaxonomy, String>`
    - both `None` → `Err("move 需要 department 与 category".into())`
    - otherwise `Ok(normalize_for_storage(from_parts(department, category)))`
  - `pub fn same_taxonomy(existing_dept: Option<&str>, existing_cat: Option<&str>, target: &WorkflowTaxonomy) -> bool`
    - compare `normalize_for_storage(from_parts(existing_dept, existing_cat)) == *target`

- [x] **Step 1: Write failing tests**

Append to `src/workflow_taxonomy.rs` `mod tests`:

```rust
#[test]
fn batch_move_requires_at_least_one_field() {
    let err = resolve_batch_move_target(None, None).unwrap_err();
    assert_eq!(err, "move 需要 department 与 category");
}

#[test]
fn batch_move_empty_strings_normalize_shared_uncategorized() {
    let t = resolve_batch_move_target(Some(""), Some("")).unwrap();
    assert_eq!(t.department.as_deref(), Some(SHARED_DEPARTMENT));
    assert_eq!(t.category.as_deref(), Some(UNCATEGORIZED_CATEGORY));
}

#[test]
fn batch_move_dept_only_fills_uncategorized() {
    let t = resolve_batch_move_target(Some("运营部"), None).unwrap();
    assert_eq!(t.department.as_deref(), Some("运营部"));
    assert_eq!(t.category.as_deref(), Some(UNCATEGORIZED_CATEGORY));
}

#[test]
fn same_taxonomy_treats_null_shared_uncategorized_as_equal() {
    let target = resolve_batch_move_target(Some("共享"), Some("未分类")).unwrap();
    assert!(same_taxonomy(None, None, &target));
    assert!(!same_taxonomy(Some("运营部"), Some("通知"), &target));
}
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cargo test -p onebase --lib workflow_taxonomy::tests::batch_move -- --nocapture`

Expected: compile error (`resolve_batch_move_target` / `same_taxonomy` missing).

- [x] **Step 3: Implement**

```rust
pub fn resolve_batch_move_target(
    department: Option<&str>,
    category: Option<&str>,
) -> Result<WorkflowTaxonomy, String> {
    if department.is_none() && category.is_none() {
        return Err("move 需要 department 与 category".to_string());
    }
    Ok(normalize_for_storage(from_parts(department, category)))
}

pub fn same_taxonomy(
    existing_dept: Option<&str>,
    existing_cat: Option<&str>,
    target: &WorkflowTaxonomy,
) -> bool {
    normalize_for_storage(from_parts(existing_dept, existing_cat)) == *target
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cargo test -p onebase --lib workflow_taxonomy::tests -- --nocapture`

Expected: PASS (existing + new).

- [ ] **Step 5: Commit (skip unless the user asked)**

```bash
git add src/workflow_taxonomy.rs
git commit -m "feat(workflow): resolve batch move taxonomy target"
```

---

### Task 2: `batch_workflows` action `move`

**Files:**
- Modify: `src/workflow_handlers.rs` (`BatchWorkflowRequest` ~1888, `batch_workflows` ~1898–2031)

**Interfaces:**
- Consumes: `resolve_batch_move_target`, `same_taxonomy`
- Produces: `POST /api/admin/workflows/batch` accepts `action: "move"` plus optional `department` / `category` strings.

- [ ] **Step 1: Write a failing unit test for the action allow-list helper**

Add next to `batch_workflows` (same file, not inside the handler):

```rust
fn parse_batch_action(action: &str) -> Result<&'static str> {
    match action {
        "enable" => Ok("enable"),
        "disable" => Ok("disable"),
        "delete" => Ok("delete"),
        "move" => Ok("move"),
        _ => Err(AppError::InvalidQuery(
            "action 必须是 enable / disable / delete / move".to_string(),
        )),
    }
}
```

First write the test in `workflow_handlers.rs` in a small `#[cfg(test)] mod batch_action_tests` **without** implementing `"move"` in the match (keep the old error string) so the test fails, then add `move`.

Test:

```rust
#[cfg(test)]
mod batch_action_tests {
    use super::*;

    #[test]
    fn parse_batch_action_accepts_move() {
        assert_eq!(parse_batch_action("move").unwrap(), "move");
    }

    #[test]
    fn parse_batch_action_rejects_unknown() {
        let err = parse_batch_action("archive").unwrap_err().to_string();
        assert!(err.contains("enable / disable / delete / move"));
    }
}
```

Do **not** add a live-DB integration test in this task. Handler wiring is verified by compile + the helper tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --bin onebase parse_batch_action_accepts_move -- --nocapture`

Expected: FAIL or compile error until `parse_batch_action` exists; if you stub it with the old three actions, `move` returns Err.

- [ ] **Step 3: Implement handler**

1. Change `BatchWorkflowRequest` to:

```rust
pub struct BatchWorkflowRequest {
    pub action: String,
    pub ids: Vec<i32>,
    pub department: Option<String>,
    pub category: Option<String>,
}
```

2. Replace the `matches!(action, "enable" | "disable" | "delete")` block with `let action = parse_batch_action(&req.action)?;`

3. After the permission loop, if `action == "move"`:

```rust
let target = crate::workflow_taxonomy::resolve_batch_move_target(
    req.department.as_deref(),
    req.category.as_deref(),
)
.map_err(AppError::InvalidQuery)?;
```

4. In the execute `match`, add:

```rust
"move" => sqlx::query_scalar::<_, i32>(
    "UPDATE management.workflows \
     SET department = $1, category = $2, updated_at = NOW() \
     WHERE id = ANY($3) RETURNING id",
)
.bind(target.department.as_deref())
.bind(target.category.as_deref())
.bind(&allowed)
.fetch_all(&pool)
.await
.map_err(map_workflow_write_err)?,
```

`target` must be in scope for this arm. Compute `target` only when action is move (before the execute match). For other actions do not require the fields.

5. Op log: add `"move"` → `(UPDATE, "移动")`. For `change`:

```rust
"move" => {
    if crate::workflow_taxonomy::same_taxonomy(
        wf.department.as_deref(),
        wf.category.as_deref(),
        &target,
    ) {
        None
    } else {
        Some(json!({
            "v": 1, "kind": "modified",
            "modified": [{
                "node": wf.name,
                "fields": [
                    {
                        "field": "服务",
                        "old": wf.department.clone().unwrap_or_else(|| "共享".into()),
                        "new": target.department.clone().unwrap_or_else(|| "共享".into()),
                    },
                    {
                        "field": "分类",
                        "old": wf.category.clone().unwrap_or_else(|| "未分类".into()),
                        "new": target.category.clone().unwrap_or_else(|| "未分类".into()),
                    }
                ]
            }]
        }))
    }
}
```

`target` must be available in the log loop. Use `Option<WorkflowTaxonomy>`: `Some` only for move.

6. Update the doc comment on `batch_workflows` to list `move`.

- [ ] **Step 4: Run tests**

Run:

```
cargo test --bin onebase parse_batch_action -- --nocapture
cargo test -p onebase --lib workflow_taxonomy::tests -- --nocapture
```

Expected: PASS. `cargo check --bin onebase` succeeds.

- [ ] **Step 5: Commit (skip unless the user asked)**

```bash
git add src/workflow_handlers.rs src/workflow_taxonomy.rs
git commit -m "feat(workflow): batch action move updates department and category"
```

---

### Task 3: List UI — row menu + batch modal

**Files:**
- Modify: `frontend-nextjs/components/workflow/list/utils.ts`
- Modify: `frontend-nextjs/components/workflow/list/batchApi.ts`
- Modify: `frontend-nextjs/components/workflow/list/WorkflowBatchBar.tsx`
- Modify: `frontend-nextjs/components/workflow/list/WorkflowBatchModals.tsx`
- Modify: `frontend-nextjs/components/workflow/list/RowMenu.tsx`
- Modify: `frontend-nextjs/components/workflow/list/WorkflowRow.tsx` (pass `onMove` into `WorkflowRowActions`)
- Modify: `frontend-nextjs/components/workflow/list/WorkflowCard.tsx` (same, if it uses `WorkflowRowActions`)
- Modify: `frontend-nextjs/components/workflow/list/WorkflowListView.tsx`

**Interfaces:**
- Consumes: `batchMoveWorkflows`, `resolveWorkflowTaxonomy`, `SHARED_DEPARTMENT_NAME`, `UNCATEGORIZED_FOLDER_NAME`, `catNamesFromId`, `WorkflowFolder`
- Produces:
  - `moveDepartmentOptions(groups, customFolders): string[]`
  - `moveCategoryOptions(groups, customFolders, department): string[]` — always includes `未分类`
  - `defaultMoveTarget(workflows, currentFolderId): { department: string; category: string }`
  - `batchMoveWorkflows(ids, department, category)`
  - `BatchModalType` includes `'move'`

- [ ] **Step 1: Add option helpers in `utils.ts`**

```ts
export function moveDepartmentOptions(
  groups: WorkflowGroupCount[],
  customFolders: WorkflowFolder[],
): string[] {
  const set = new Set(listDepartmentsFromGroups(groups))
  for (const f of customFolders) {
    if (f.parent_id === ROOT_FOLDER_ID || f.parent_id === null) set.add(f.name)
  }
  if (set.size === 0) set.add(SHARED_DEPARTMENT_NAME)
  return Array.from(set).sort((a, b) => {
    if (a === SHARED_DEPARTMENT_NAME) return -1
    if (b === SHARED_DEPARTMENT_NAME) return 1
    return a.localeCompare(b, 'zh-Hans-CN')
  })
}

export function moveCategoryOptions(
  groups: WorkflowGroupCount[],
  customFolders: WorkflowFolder[],
  department: string,
): string[] {
  const set = new Set(listCategoriesFromGroups(groups, department))
  set.add(UNCATEGORIZED_FOLDER_NAME)
  const deptFolder = customFolders.find(
    (f) => (f.parent_id === ROOT_FOLDER_ID || f.parent_id === null) && f.name === department,
  )
  if (deptFolder) {
    for (const f of customFolders) {
      if (f.parent_id === deptFolder.id) set.add(f.name)
    }
  }
  return Array.from(set).sort((a, b) => {
    if (a === UNCATEGORIZED_FOLDER_NAME) return -1
    if (b === UNCATEGORIZED_FOLDER_NAME) return 1
    return a.localeCompare(b, 'zh-Hans-CN')
  })
}

export function defaultMoveTarget(
  workflows: Pick<WorkflowListItem, 'department' | 'category'>[],
  currentFolderId: string,
): { department: string; category: string } {
  if (workflows.length === 1) {
    const t = resolveWorkflowTaxonomy(workflows[0])
    return {
      department: t.department || SHARED_DEPARTMENT_NAME,
      category: t.category || UNCATEGORIZED_FOLDER_NAME,
    }
  }
  const taxes = workflows.map((w) => resolveWorkflowTaxonomy(w))
  const same =
    taxes.length > 0 &&
    taxes.every(
      (t) =>
        (t.department || SHARED_DEPARTMENT_NAME) === (taxes[0].department || SHARED_DEPARTMENT_NAME) &&
        (t.category || UNCATEGORIZED_FOLDER_NAME) === (taxes[0].category || UNCATEGORIZED_FOLDER_NAME),
    )
  if (same && taxes[0]) {
    return {
      department: taxes[0].department || SHARED_DEPARTMENT_NAME,
      category: taxes[0].category || UNCATEGORIZED_FOLDER_NAME,
    }
  }
  const cat = catNamesFromId(currentFolderId)
  if (cat) return { department: cat.dept, category: cat.cat }
  return { department: SHARED_DEPARTMENT_NAME, category: UNCATEGORIZED_FOLDER_NAME }
}

export function allWorkflowsAlreadyAt(
  workflows: Pick<WorkflowListItem, 'department' | 'category'>[],
  department: string,
  category: string,
): boolean {
  return (
    workflows.length > 0 &&
    workflows.every((w) => {
      const t = resolveWorkflowTaxonomy(w)
      return (
        (t.department || SHARED_DEPARTMENT_NAME) === department &&
        (t.category || UNCATEGORIZED_FOLDER_NAME) === category
      )
    })
  )
}
```

Import `WorkflowListItem` from `./types` if not already imported in `utils.ts`.

- [ ] **Step 2: `batchApi.ts`**

```ts
export type BatchWorkflowAction = 'enable' | 'disable' | 'delete' | 'move'

export async function batchMoveWorkflows(
  ids: number[],
  department: string,
  category: string,
) {
  const res = await api.post('/api/admin/workflows/batch', {
    action: 'move',
    ids,
    department,
    category,
  })
  return res.data as BatchWorkflowResult
}
```

Change `batchWorkflows` internal POST to still send `{ action, ids }` for enable/delete (no extra fields).

- [ ] **Step 3: Batch bar + modal**

`WorkflowBatchBar.tsx`: `BatchModalType = 'export' | 'status' | 'delete' | 'move' | null`. Add `onMove: () => void`. Between status and delete:

```tsx
      <div className="workflow-batch-sep" />
      <button type="button" className="workflow-batch-btn workflow-batch-btn-status" onClick={onMove}>
        <i className="fas fa-folder-tree" />
        移动
      </button>
```

`WorkflowBatchModals.tsx`: extend props:

```ts
interface WorkflowBatchModalsProps {
  modal: BatchModalType
  workflows: WorkflowListItem[]
  onClose: () => void
  onComplete: () => void
  summaryGroups: WorkflowGroupCount[]
  customFolders: WorkflowFolder[]
  currentFolderId: string
}
```

Add `BatchMoveModal` using the same `ModalOverlay` / `ModalHead`. Two `<select>`s. On open, initialize from `defaultMoveTarget(workflows, currentFolderId)`. Title: `workflows.length === 1 ? '移动工作流' : \`移动 ${workflows.length} 个工作流\``. Confirm:

```ts
if (allWorkflowsAlreadyAt(workflows, department, category)) {
  showToast('info', '已在该分类')
  onClose()
  return
}
const result = await batchMoveWorkflows(workflows.map((w) => w.id), department, category)
if (result.failed_count > 0) {
  showToast('warning', `已移动 ${result.succeeded_count} 个，${result.failed_count} 个失败`)
} else {
  showToast('success', `已移动 ${result.succeeded_count} 个工作流`)
}
onComplete()
onClose()
```

Render `{modal === 'move' && <BatchMoveModal open ... />}`.

If `showToast` has no `'info'`, use `'success'` for「已在该分类」.

- [ ] **Step 4: Row menu + list wiring**

`RowMenu`: add `onMove: () => void`. Insert before the delete separator:

```tsx
          <MenuItem onClick={onMove} close={() => setMenuOpen(false)}>
            <i className="fas fa-folder-tree text-[10px] w-3.5 text-slate-400" />
            移动
          </MenuItem>
```

Thread `onMove` through `WorkflowRowActions`, `WorkflowRow`, `WorkflowCard`.

`WorkflowListView.tsx`:

```ts
const [moveSubset, setMoveSubset] = useState<WorkflowListItem[] | null>(null)
```

- Batch bar `onMove={() => { setMoveSubset(null); setBatchModal('move') }}`
- Row `onMove={() => { setMoveSubset([wf]); setBatchModal('move') }}`
- Modal `workflows={moveSubset ?? selectedList}`
- Modal `onClose`: `setBatchModal(null); setMoveSubset(null)`
- Pass `summaryGroups`, `customFolders`, `currentFolderId={state.folderId}`
- `handleBatchComplete` already reloads list/summary — keep using it.

- [ ] **Step 5: Verify**

Run:

```
rg -n "移动" frontend-nextjs/components/workflow/list/RowMenu.tsx frontend-nextjs/components/workflow/list/WorkflowBatchBar.tsx
rg -n "batchMoveWorkflows" frontend-nextjs/components/workflow/list
```

Expected: both entry points exist; `batchMoveWorkflows` is imported in the modal.

Manual: open list → ⋯ → 移动 → pick another category → row leaves current folder; checkbox several → 移动 → same.

- [ ] **Step 6: Commit (skip unless the user asked)**

```bash
git add frontend-nextjs/components/workflow/list
git commit -m "feat(workflow): move workflows to another category from list and batch bar"
```

---

## Self-review (spec coverage)

| Spec | Task |
|---|---|
| `action: move` + normalize | 1, 2 |
| Missing both fields → 400 | 1 |
| Admin / failed[] / 500 cap | 2 (existing loops) |
| No version snapshot | 2 (only UPDATE taxonomy) |
| Idempotent no X→X log | 2 `same_taxonomy` |
| Row menu + batch bar modal | 3 |
| Cross-dept two selects, existing only | 3 |
| Always include 未分类 + custom empty folders | 3 `moveCategoryOptions` |
| Stay on folder, refresh | 3 `onComplete` |
| No row drag / no new category in modal | out of scope |

No TBD placeholders. Names (`resolve_batch_move_target`, `batchMoveWorkflows`, `moveDepartmentOptions`) are consistent.
