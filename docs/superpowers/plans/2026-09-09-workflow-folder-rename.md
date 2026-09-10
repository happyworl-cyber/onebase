# Workflow Folder Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the workflow sidebar rename a service or category (not 共享 / 未分类), cascade `department` / `category` on existing workflows, and keep the current folder selection.

**Architecture:** Reuse `PATCH /api/admin/workflow-folders/:id` `{ name }` for the folder row. Reuse the move-category pattern for workflows: list by old name, then `PATCH /api/admin/workflows/:id`. Tree ids stay name-derived; remap `folderId` / `expanded` / saved id after success. Pencil + dialog in the existing folder tree.

**Tech Stack:** Rust (`workflow_folder_handlers::trim_name` unit tests only — no new route), Next.js 14 (`FolderTree`, `NewFolderDialog`, `WorkflowListView`, `WorkflowsManager`).

**Spec:** `docs/superpowers/specs/2026-09-09-workflow-folder-rename-design.md`

## Global Constraints

- Do not create git commits unless the user explicitly asks. Keep Commit steps but skip them until asked.
- Do not add a batch-rename API. Workflow updates are per-id PATCH.
- Do not add inline edit or double-click rename.
- Do not allow renaming 全部工作流 / 共享 / 未分类. Do not allow renaming *to* 共享 or 未分类.
- Do not write `workflow_versions` on rename.
- Do not add an MCP tool.
- Do not add a backend hard-block for renaming 共享 / 未分类 (frontend-only this round).
- Folder first, then workflows. On partial failure: toast, refresh, no rollback.
- Repo has no frontend unit-test runner; run `npx tsx` on the standalone assert files.

## File Structure

| Path | Responsibility |
|------|----------------|
| `src/workflow_folder_handlers.rs` | Existing PATCH; add `trim_name` unit tests |
| `frontend-nextjs/components/workflow/list/utils.ts` | canRename / validate / remap ids / local folder rewrite |
| `frontend-nextjs/components/workflow/list/folderRename.test.ts` | Pure-function tests |
| `frontend-nextjs/components/workflow/list/folderApi.ts` | `renameApiFolder` |
| `frontend-nextjs/components/workflow/list/listApi.ts` | `fetchWorkflowsByDepartment` |
| `frontend-nextjs/components/workflow/list/NewFolderDialog.tsx` | create + rename modes |
| `frontend-nextjs/components/workflow/list/FolderTree.tsx` | Hover pencil |
| `frontend-nextjs/components/workflow/list/WorkflowListView.tsx` | Dialog state, folder PATCH, id remap |
| `frontend-nextjs/components/workflow/WorkflowsManager.tsx` | Cascade workflow PATCH |

---

### Task 1: `trim_name` unit tests

**Files:**
- Modify: `src/workflow_folder_handlers.rs`

**Interfaces:**
- Consumes: existing private `fn trim_name(name: &str) -> Result<String>`
- Produces: same function, still private; tests in `mod tests` in this file

- [x] **Step 1: Write failing tests**

Append to `src/workflow_folder_handlers.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;

    fn query_msg(r: Result<String>) -> String {
        match r {
            Err(AppError::InvalidQuery(msg)) => msg,
            other => panic!("expected InvalidQuery, got {other:?}"),
        }
    }

    #[test]
    fn trim_name_rejects_empty() {
        assert_eq!(query_msg(trim_name("   ")), "文件夹名称不能为空");
    }

    #[test]
    fn trim_name_rejects_slash() {
        assert_eq!(query_msg(trim_name("a/b")), "文件夹名称不能包含 '/'");
    }

    #[test]
    fn trim_name_rejects_over_64_chars() {
        let name = "测".repeat(65);
        assert_eq!(
            query_msg(trim_name(&name)),
            "文件夹名称不能超过 64 个字符"
        );
    }

    #[test]
    fn trim_name_accepts_trimmed() {
        assert_eq!(trim_name("  订单同步  ").unwrap(), "订单同步");
    }
}
```

These should compile against the existing `trim_name`. If they pass immediately, that is expected — this task locks current backend rules, it does not add a new route.

- [ ] **Step 2: Run tests**

Run: `cargo test -p onebase --lib workflow_folder_handlers::tests -- --nocapture`

Expected: 4 PASS.

If a message string does not match, fix the test to the actual `trim_name` text (do not change production messages).

- [ ] **Step 3: Commit (skip unless the user asked)**

```bash
git add src/workflow_folder_handlers.rs
git commit -m "test: 锁定工作流文件夹名称校验。"
```

---

### Task 2: Rename helpers (TDD)

**Files:**
- Create: `frontend-nextjs/components/workflow/list/folderRename.test.ts`
- Modify: `frontend-nextjs/components/workflow/list/utils.ts`

**Interfaces:**
- Consumes: `deptIdFromName`, `catIdFromNames`, `deptNameFromId`, `catNamesFromId`, `ROOT_FOLDER_ID`, `SHARED_DEPARTMENT_NAME`, `UNCATEGORIZED_FOLDER_NAME`, `FOLDER_NAME_PRESETS`, `WorkflowFolder`
- Produces:
  - `export function canRenameFolder(folderId: string): boolean`
  - `export function validateFolderRename(trimmed: string, siblingNames: string[], currentName: string): string | null`
  - `export function renamedFolderId(folderId: string, newName: string): string | null`
  - `export function remapFolderIdAfterDeptRename(folderId: string, oldDept: string, newDept: string): string`
  - `export function remapExpandedAfterRename(expanded: Set<string>, folderId: string, newName: string): Set<string>`
  - `export function siblingFolderNames(folders: WorkflowFolder[], folderId: string): string[]`
  - `export function applyCustomFoldersRename(customFolders: WorkflowFolder[], folderId: string, newName: string): WorkflowFolder[]`

- [ ] **Step 1: Write the failing test file**

Create `frontend-nextjs/components/workflow/list/folderRename.test.ts`:

```ts
import assert from 'node:assert/strict'
import {
  applyCustomFoldersRename,
  canRenameFolder,
  catIdFromNames,
  deptIdFromName,
  remapExpandedAfterRename,
  remapFolderIdAfterDeptRename,
  renamedFolderId,
  siblingFolderNames,
  validateFolderRename,
} from './utils'
import { ROOT_FOLDER_ID, SHARED_DEPARTMENT_NAME, UNCATEGORIZED_FOLDER_NAME, type WorkflowFolder } from './types'

const DEPT = 'gm管理后台预发'
const deptId = deptIdFromName(DEPT)
const catId = catIdFromNames(DEPT, '透明研发')
const uncatId = catIdFromNames(DEPT, UNCATEGORIZED_FOLDER_NAME)
const sharedId = deptIdFromName(SHARED_DEPARTMENT_NAME)

assert.equal(canRenameFolder(ROOT_FOLDER_ID), false)
assert.equal(canRenameFolder(sharedId), false)
assert.equal(canRenameFolder(uncatId), false)
assert.equal(canRenameFolder(deptId), true)
assert.equal(canRenameFolder(catId), true)

assert.equal(validateFolderRename('', [], DEPT), '文件夹名称不能为空')
assert.equal(validateFolderRename('a/b', [], DEPT), "文件夹名称不能包含 '/'")
assert.equal(validateFolderRename('测'.repeat(65), [], DEPT), '文件夹名称不能超过 64 个字符')
assert.equal(validateFolderRename(SHARED_DEPARTMENT_NAME, [], DEPT), `不能使用保留名称「${SHARED_DEPARTMENT_NAME}」`)
assert.equal(validateFolderRename(UNCATEGORIZED_FOLDER_NAME, [], DEPT), `不能使用保留名称「${UNCATEGORIZED_FOLDER_NAME}」`)
assert.equal(validateFolderRename('已有', ['已有'], DEPT), '文件夹「已有」已存在')
assert.equal(validateFolderRename(DEPT, ['其它'], DEPT), null)
assert.equal(validateFolderRename('新服务', ['其它'], DEPT), null)

assert.equal(renamedFolderId(deptId, '新服务'), deptIdFromName('新服务'))
assert.equal(renamedFolderId(catId, '新分类'), catIdFromNames(DEPT, '新分类'))
assert.equal(renamedFolderId(ROOT_FOLDER_ID, 'x'), null)

assert.equal(remapFolderIdAfterDeptRename(deptId, DEPT, '新服务'), deptIdFromName('新服务'))
assert.equal(
  remapFolderIdAfterDeptRename(catId, DEPT, '新服务'),
  catIdFromNames('新服务', '透明研发'),
)
assert.equal(remapFolderIdAfterDeptRename(deptIdFromName('其它'), DEPT, '新服务'), deptIdFromName('其它'))

const expanded = remapExpandedAfterRename(new Set([deptId, catId, ROOT_FOLDER_ID]), deptId, '新服务')
assert.ok(expanded.has(deptIdFromName('新服务')))
assert.ok(expanded.has(catIdFromNames('新服务', '透明研发')))
assert.ok(expanded.has(ROOT_FOLDER_ID))
assert.ok(!expanded.has(deptId))
assert.ok(!expanded.has(catId))

const folders: WorkflowFolder[] = [
  { id: deptId, parent_id: ROOT_FOLDER_ID, name: DEPT, icon: 'fa-folder', color: 'text-slate-500' },
  { id: catId, parent_id: deptId, name: '透明研发', icon: 'fa-tag', color: 'text-slate-500' },
  { id: deptIdFromName('其它'), parent_id: ROOT_FOLDER_ID, name: '其它', icon: 'fa-folder', color: 'text-slate-500' },
]
assert.deepEqual(siblingFolderNames(folders, deptId).sort(), ['其它'])
assert.deepEqual(siblingFolderNames(folders, catId), [])

const renamedDept = applyCustomFoldersRename(folders, deptId, '新服务')
assert.ok(renamedDept.some((f) => f.id === deptIdFromName('新服务') && f.name === '新服务'))
assert.ok(renamedDept.some((f) => f.id === catIdFromNames('新服务', '透明研发') && f.parent_id === deptIdFromName('新服务')))
assert.ok(!renamedDept.some((f) => f.id === deptId))

const renamedCat = applyCustomFoldersRename(folders, catId, '新分类')
assert.ok(renamedCat.some((f) => f.id === catIdFromNames(DEPT, '新分类') && f.name === '新分类'))
assert.ok(!renamedCat.some((f) => f.id === catId))

console.log('folderRename tests passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx frontend-nextjs/components/workflow/list/folderRename.test.ts`

Working directory: repo root. If `tsx` is not on PATH, run `cd frontend-nextjs && npx --yes tsx components/workflow/list/folderRename.test.ts`.

Expected: FAIL / compile error (`canRenameFolder` is not exported).

- [ ] **Step 3: Implement helpers in `utils.ts`**

Add after `canMoveCategoryToDept` (around the category-id helpers). Import `FOLDER_NAME_PRESETS` is already in this file.

```ts
export function canRenameFolder(folderId: string): boolean {
  if (folderId === ROOT_FOLDER_ID) return false
  const dept = deptNameFromId(folderId)
  if (dept) return dept !== SHARED_DEPARTMENT_NAME
  const cat = catNamesFromId(folderId)
  if (cat) return cat.cat !== UNCATEGORIZED_FOLDER_NAME
  return false
}

export function validateFolderRename(
  trimmed: string,
  siblingNames: string[],
  currentName: string,
): string | null {
  if (!trimmed) return '文件夹名称不能为空'
  if (trimmed.includes('/')) return "文件夹名称不能包含 '/'"
  if ([...trimmed].length > 64) return '文件夹名称不能超过 64 个字符'
  if (trimmed === SHARED_DEPARTMENT_NAME || trimmed === UNCATEGORIZED_FOLDER_NAME) {
    return `不能使用保留名称「${trimmed}」`
  }
  if (trimmed !== currentName && siblingNames.includes(trimmed)) {
    return `文件夹「${trimmed}」已存在`
  }
  return null
}

export function renamedFolderId(folderId: string, newName: string): string | null {
  const dept = deptNameFromId(folderId)
  if (dept) return deptIdFromName(newName)
  const cat = catNamesFromId(folderId)
  if (cat) return catIdFromNames(cat.dept, newName)
  return null
}

export function remapFolderIdAfterDeptRename(
  folderId: string,
  oldDept: string,
  newDept: string,
): string {
  if (folderId === deptIdFromName(oldDept)) return deptIdFromName(newDept)
  const cat = catNamesFromId(folderId)
  if (cat && cat.dept === oldDept) return catIdFromNames(newDept, cat.cat)
  return folderId
}

export function remapExpandedAfterRename(
  expanded: Set<string>,
  folderId: string,
  newName: string,
): Set<string> {
  const dept = deptNameFromId(folderId)
  if (dept) {
    const next = new Set<string>()
    for (const id of expanded) {
      next.add(remapFolderIdAfterDeptRename(id, dept, newName))
    }
    return next
  }
  const newId = renamedFolderId(folderId, newName)
  const next = new Set(expanded)
  if (newId && next.has(folderId)) {
    next.delete(folderId)
    next.add(newId)
  }
  return next
}

export function siblingFolderNames(folders: WorkflowFolder[], folderId: string): string[] {
  const folder = folders.find((f) => f.id === folderId)
  if (!folder) return []
  return folders.filter((f) => f.parent_id === folder.parent_id && f.id !== folderId).map((f) => f.name)
}

export function applyCustomFoldersRename(
  customFolders: WorkflowFolder[],
  folderId: string,
  newName: string,
): WorkflowFolder[] {
  const dept = deptNameFromId(folderId)
  if (dept) {
    const newDeptId = deptIdFromName(newName)
    const preset = FOLDER_NAME_PRESETS[newName] ?? { icon: 'fa-folder', color: 'text-slate-500' }
    return customFolders.map((f) => {
      if (f.id === folderId) {
        return { ...f, id: newDeptId, name: newName, ...preset }
      }
      const cat = catNamesFromId(f.id)
      if (cat && cat.dept === dept) {
        return { ...f, id: catIdFromNames(newName, cat.cat), parent_id: newDeptId }
      }
      return f
    })
  }
  const cat = catNamesFromId(folderId)
  if (!cat) return customFolders
  const newId = catIdFromNames(cat.dept, newName)
  return customFolders
    .filter((f) => f.id !== newId)
    .map((f) => (f.id === folderId ? { ...f, id: newId, name: newName } : f))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx frontend-nextjs/components/workflow/list/folderRename.test.ts`

Expected: `folderRename tests passed`

Also run: `npx tsx frontend-nextjs/components/workflow/list/buildFolderTree.test.ts`

Expected: `buildFolderTree tests passed`

- [ ] **Step 5: Commit (skip unless the user asked)**

```bash
git add frontend-nextjs/components/workflow/list/utils.ts \
  frontend-nextjs/components/workflow/list/folderRename.test.ts
git commit -m "feat: 工作流文件夹改名的纯函数与校验。"
```

---

### Task 3: Pencil + rename dialog

**Files:**
- Modify: `frontend-nextjs/components/workflow/list/NewFolderDialog.tsx`
- Modify: `frontend-nextjs/components/workflow/list/FolderTree.tsx`

**Interfaces:**
- Consumes: `canRenameFolder` from `./utils`
- Produces:
  - `NewFolderDialog` extra optional props: `mode?: 'create' | 'rename'` (default `'create'`), `initialName?: string`, `workflowCount?: number`, `siblingNames?: string[]`
  - `FolderTreeProps.onRenameFolder?: (folderId: string) => void`

- [ ] **Step 1: Extend `NewFolderDialog`**

Replace the component with this (keep `'use client'`):

```tsx
'use client'

import { useState } from 'react'
import { validateFolderRename } from './utils'

interface NewFolderDialogProps {
  parentName: string
  kind: 'department' | 'category'
  mode?: 'create' | 'rename'
  initialName?: string
  workflowCount?: number
  siblingNames?: string[]
  onConfirm: (name: string) => void
  onCancel: () => void
}

export default function NewFolderDialog({
  parentName,
  kind,
  mode = 'create',
  initialName = '',
  workflowCount = 0,
  siblingNames = [],
  onConfirm,
  onCancel,
}: NewFolderDialogProps) {
  const [error, setError] = useState<string | null>(null)
  const isRename = mode === 'rename'
  const label = kind === 'department' ? '服务' : '分类'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onCancel}>
      <div className="absolute inset-0 bg-black/40" />
      <form
        className="relative bg-white rounded-xl shadow-xl w-full max-w-sm p-5"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          const fd = new FormData(e.currentTarget)
          const name = String(fd.get('name') || '').trim()
          if (isRename) {
            if (name === initialName.trim()) {
              onCancel()
              return
            }
            const err = validateFolderRename(name, siblingNames, initialName.trim())
            if (err) {
              setError(err)
              return
            }
          }
          if (name) onConfirm(name)
        }}
      >
        <h3 className="font-semibold text-slate-800 mb-1">
          {isRename ? `重命名${label}` : `新建${label}`}
        </h3>
        <p className="text-xs text-slate-500 mb-4">
          {isRename
            ? `将「${initialName}」改为新的${label}名称`
            : `在「${parentName}」下创建${kind === 'department' ? '服务（一级）' : '分类（二级）'}`}
        </p>
        <input
          name="name"
          autoFocus
          required
          defaultValue={initialName}
          placeholder={kind === 'department' ? '如：用户服务' : '如：订单同步'}
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
          onChange={() => {
            if (error) setError(null)
          }}
        />
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        {isRename && workflowCount > 0 && (
          <p className="mt-2 text-xs text-slate-500">将同步更新 {workflowCount} 个工作流的归属</p>
        )}
        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800"
          >
            取消
          </button>
          <button
            type="submit"
            className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium"
          >
            {isRename ? '保存' : '创建'}
          </button>
        </div>
      </form>
    </div>
  )
}
```

Create mode stays the default; `WorkflowListView` create call does not need new props.

- [ ] **Step 2: Add pencil on `FolderTree`**

1. Import `canRenameFolder` from `./utils`.
2. Add to `FolderTreeProps`:

```ts
onRenameFolder?: (folderId: string) => void
```

3. Thread `onRenameFolder` through `TreeNode` the same way as `onDeleteFolder`.
4. Insert this button **between** the plus button and the delete button (plus is only on depts):

```tsx
{!isRoot && onRenameFolder && canRenameFolder(folderId) && (
  <button
    type="button"
    title="重命名"
    onClick={(e) => {
      e.stopPropagation()
      onRenameFolder(folderId)
    }}
    className="w-4 h-4 flex items-center justify-center rounded hover:bg-slate-200 text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity"
  >
    <i className="fas fa-pencil text-[8px]" />
  </button>
)}
```

Do not show the pencil on root / 共享 / 未分类. `canRenameFolder` already encodes that.

- [ ] **Step 3: Typecheck**

Run: `cd frontend-nextjs && npx tsc --noEmit`

Expected: PASS, or only pre-existing errors unrelated to these files. If `FolderTree` callers fail because `onRenameFolder` is optional, that is fine.

- [ ] **Step 4: Commit (skip unless the user asked)**

```bash
git add frontend-nextjs/components/workflow/list/NewFolderDialog.tsx \
  frontend-nextjs/components/workflow/list/FolderTree.tsx
git commit -m "feat: 侧边栏服务与分类增加重命名入口。"
```

---

### Task 4: Wire folder PATCH + workflow cascade

**Files:**
- Modify: `frontend-nextjs/components/workflow/list/folderApi.ts`
- Modify: `frontend-nextjs/components/workflow/list/listApi.ts`
- Modify: `frontend-nextjs/components/workflow/list/WorkflowListView.tsx`
- Modify: `frontend-nextjs/components/workflow/WorkflowsManager.tsx`

**Interfaces:**
- Consumes: helpers from Task 2; `fetchWorkflowsByCategory`
- Produces:
  - `export async function renameApiFolder(serverId: number, name: string): Promise<ApiWorkflowFolder>`
  - `export async function fetchWorkflowsByDepartment(department: string, defaultDatabaseId?: number | null): Promise<WorkflowListItem[]>`
  - `WorkflowListViewProps.onRenameFolder?: (folderId: string, newName: string, opts: { workflowCount: number }) => Promise<void>`

- [ ] **Step 1: API helpers**

In `folderApi.ts`, next to `moveApiCategoryFolder`:

```ts
export async function renameApiFolder(serverId: number, name: string): Promise<ApiWorkflowFolder> {
  const res = await api.patch<{ folder: ApiWorkflowFolder }>(
    `/api/admin/workflow-folders/${serverId}`,
    { name },
  )
  return res.data.folder
}
```

In `listApi.ts`, next to `fetchWorkflowsByCategory` (no `page` / `page_size`, so the list handler returns the full match):

```ts
export async function fetchWorkflowsByDepartment(
  department: string,
  defaultDatabaseId?: number | null,
): Promise<WorkflowListItem[]> {
  const params: Record<string, string | number> = { department }
  if (defaultDatabaseId != null) params.database_id = defaultDatabaseId
  const res = await api.get('/api/admin/workflows', { params })
  return res.data.workflows ?? []
}
```

- [ ] **Step 2: `WorkflowsManager` cascade**

Import `deptNameFromId` (already imported) and `fetchWorkflowsByDepartment` from `listApi`.

Add `handleRenameFolder` next to `handleMoveCategory`:

```ts
const handleRenameFolder = useCallback(
  async (folderId: string, newName: string, opts: { workflowCount: number }) => {
    if (opts.workflowCount <= 0) return

    try {
      const dept = deptNameFromId(folderId)
      if (dept) {
        const affected = await fetchWorkflowsByDepartment(dept, defaultDatabaseId)
        await Promise.all(
          affected.map((wf) =>
            api.patch(`/api/admin/workflows/${wf.id}`, { department: newName }),
          ),
        )
      } else {
        const cat = catNamesFromId(folderId)
        if (!cat) return
        const affected = await fetchWorkflowsByCategory(cat.dept, cat.cat, defaultDatabaseId)
        await Promise.all(
          affected.map((wf) =>
            api.patch(`/api/admin/workflows/${wf.id}`, { category: newName }),
          ),
        )
      }
      refreshList()
    } catch (err) {
      console.error('重命名后同步工作流失败:', err)
      showToast('error', '部分工作流归属未更新，请重试')
      throw err
    }
  },
  [defaultDatabaseId, refreshList],
)
```

Pass into `WorkflowListView`:

```tsx
onRenameFolder={handleRenameFolder}
```

- [ ] **Step 3: `WorkflowListView` execute rename**

1. Extend props:

```ts
onRenameFolder?: (
  folderId: string,
  newName: string,
  opts: { workflowCount: number },
) => Promise<void>
```

2. Import `applyCustomFoldersRename`, `canRenameFolder`, `countInFolderFromGroups` (already imported), `remapExpandedAfterRename`, `renamedFolderId`, `siblingFolderNames`, `renameApiFolder`.

3. State (next to `newFolderParent`):

```ts
const [renameTarget, setRenameTarget] = useState<string | false>(false)
const [renamingFolder, setRenamingFolder] = useState(false)
```

4. `FolderTree`:

```tsx
onRenameFolder={onRenameFolder ? (folderId) => setRenameTarget(folderId) : undefined}
```

Wait: pencil should show even when there are no workflows (empty folder rename). Do **not** gate the pencil on `onRenameFolder`. Always pass:

```tsx
onRenameFolder={(folderId) => setRenameTarget(folderId)}
```

`onRenameFolder` from props is only for the workflow cascade.

5. Compute dialog fields when `renameTarget !== false`:

```ts
const renameFolder = renameTarget ? folders.find((f) => f.id === renameTarget) : undefined
const renameKind: 'department' | 'category' =
  renameTarget && renameTarget.startsWith('dept:') ? 'department' : 'category'
const renameCount = renameTarget ? countInFolderFromGroups(summaryGroups, renameTarget) : 0
```

6. Render a second `NewFolderDialog` when `renameFolder` is set (keep the create dialog unchanged):

```tsx
{renameFolder && (
  <NewFolderDialog
    parentName={renameFolder.name}
    kind={renameKind}
    mode="rename"
    initialName={renameFolder.name}
    workflowCount={renameCount}
    siblingNames={siblingFolderNames(folders, renameFolder.id)}
    onConfirm={(name) => void handleRenameFolder(renameFolder.id, name)}
    onCancel={() => {
      if (!renamingFolder) setRenameTarget(false)
    }}
  />
)}
```

7. Implement `handleRenameFolder` in the list view (local name; do not clash with the prop). Suggested name: `executeRenameFolder`.

```ts
const executeRenameFolder = async (folderId: string, newName: string) => {
  const folder = folders.find((f) => f.id === folderId)
  if (!folder || !canRenameFolder(folderId)) return
  const trimmed = newName.trim()
  if (!trimmed || trimmed === folder.name) {
    setRenameTarget(false)
    return
  }
  const workflowCount = countInFolderFromGroups(summaryGroups, folderId)
  setRenamingFolder(true)
  try {
    if (useServerFolders && defaultDatabaseId != null) {
      let serverId = folder.server_id
      if (serverId == null) {
        if (folderId.startsWith('dept:')) {
          const dept = deptNameFromId(folderId)
          serverId = apiFolders.find((f) => f.parent_id === null && f.name === dept)?.id
        } else {
          const cat = catNamesFromId(folderId)
          if (cat) serverId = findApiCategoryFolder(apiFolders, cat.dept, cat.cat)?.id
        }
      }
      if (serverId != null) {
        await renameApiFolder(serverId, trimmed)
      }
      await reloadRemoteFolders()
    } else {
      persistLocalCustomFolders(applyCustomFoldersRename(customFolders, folderId, trimmed))
    }

    if (workflowCount > 0 && onRenameFolder) {
      await onRenameFolder(folderId, trimmed, { workflowCount })
    }

    const nextFolderId =
      deptNameFromId(folderId) != null
        ? remapFolderIdAfterDeptRename(state.folderId, deptNameFromId(folderId)!, trimmed)
        : state.folderId === folderId
          ? renamedFolderId(folderId, trimmed) ?? state.folderId
          : state.folderId

    setState((s) => {
      const mapped =
        deptNameFromId(folderId) != null
          ? remapFolderIdAfterDeptRename(s.folderId, deptNameFromId(folderId)!, trimmed)
          : s.folderId === folderId
            ? renamedFolderId(folderId, trimmed) ?? s.folderId
            : s.folderId
      saveSavedFolderId(folderNavKey, mapped)
      return {
        ...s,
        folderId: mapped,
        expanded: remapExpandedAfterRename(s.expanded, folderId, trimmed),
      }
    })
    setRenameTarget(false)
    showToast('success', '已重命名')
    void reloadSummary()
    void reloadList()
  } catch (err) {
    console.error('重命名失败:', err)
    showToast('error', '重命名失败，请重试')
    void reloadRemoteFolders()
    void reloadSummary()
    void reloadList()
  } finally {
    setRenamingFolder(false)
  }
}
```

Remove the unused `nextFolderId` local if you inline mapping only inside `setState` (do not leave a dead const).

Resolve `server_id` the same way `executeDeleteFolder` does.

- [ ] **Step 4: Typecheck + helper tests**

Run:

```
cd frontend-nextjs && npx tsc --noEmit
npx tsx frontend-nextjs/components/workflow/list/folderRename.test.ts
npx tsx frontend-nextjs/components/workflow/list/buildFolderTree.test.ts
cargo test -p onebase --lib workflow_folder_handlers::tests -- --nocapture
```

Expected: all pass.

- [ ] **Step 5: Manual check**

On `/workspace/<project>/automation/workflows` (or the current 工作流 tab):

1. Hover 「gm管理后台预发」: pencil between + and trash. Click → dialog prefilled. Rename → breadcrumb and tree update.
2. Hover 「共享」 and any 「未分类」: no pencil.
3. Empty category rename: tree label changes; toast 「已重命名」.
4. Category with workflows: dialog shows 「将同步更新 N 个工作流的归属」; after save, those workflows stay under the new name and the count is unchanged.
5. Same-sibling name: inline error, no request.

- [ ] **Step 6: Commit (skip unless the user asked)**

```bash
git add frontend-nextjs/components/workflow/list/folderApi.ts \
  frontend-nextjs/components/workflow/list/listApi.ts \
  frontend-nextjs/components/workflow/list/WorkflowListView.tsx \
  frontend-nextjs/components/workflow/WorkflowsManager.tsx
git commit -m "feat: 工作流服务与分类支持改名并同步归属。"
```

---

## Self-review

| Spec item | Task |
|-----------|------|
| Pencil on service + category | Task 3 |
| No pencil on 全部 / 共享 / 未分类 | Task 2 `canRenameFolder` + Task 3 |
| Dialog prefill, unchanged name closes | Task 3 |
| Empty / `/` / 64 / reserved / sibling | Task 2 + Task 3 |
| Workflow count hint, no second confirm | Task 3 + Task 4 |
| Folder PATCH then workflow PATCH | Task 4 |
| Remap selected / expanded / saved id | Task 2 + Task 4 |
| Local empty folders | Task 2 `applyCustomFoldersRename` + Task 4 |
| Partial failure refresh, no rollback | Task 4 catch |
| Backend `trim_name` tests | Task 1 |
| No new batch API / MCP / versions | respected |

No TBD. Helper names in Task 4 match Task 2.
