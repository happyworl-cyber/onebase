# Workflow Version Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated workspace route to browse each workflow's version snapshots on a read-only canvas, with restore, without new backend APIs.

**Architecture:** Two Next.js pages share one `WorkflowVersionBrowser` (left version list, right read-only canvas + JSON). Pure path helpers and `tabIdentity` keep URL / Tab / KeepAlive consistent. `WorkflowCanvas` / `NodeConfigPanel` gain `readOnly`. Existing version drawer and list row menu link into the new routes.

**Tech Stack:** Next.js 14 App Router, React 18, React Flow 11, existing Axum admin APIs, Zustand workspace tabs.

**Spec:** `docs/superpowers/specs/2026-08-20-workflow-version-browser-design.md`

## Global Constraints

- No new backend API, migration, or permission model
- Editor stays on `/automation/workflows?workflowId=`; do not convert it to `/workflows/:id`
- No sidebar nav item; no version diff; no debug/edit/save on the version page
- Version page does **not** require `currentConnection.database_id`
- Page permission is `canManageEvents` (admin+), same copy as the workflows page
- Same workflow's `/versions` and `/versions/:n` share one workspace Tab; editor Tab stays separate
- KeepAlive must **not** freeze children for the version-browser path family
- URL builder is a single helper; do not hardcode the path string in drawer / list / browser
- Repo has no frontend unit-test runner; each task ends with a concrete manual check, not a new Vitest stack
- Do not commit unless the user asked; skip `git commit` steps if running in a session where commits were not requested, but still finish the code and verification

## File map

| Path | Responsibility |
|------|----------------|
| `frontend-nextjs/components/workflow/version/paths.ts` | `workflowVersionsPath`, `workflowEditorPath`, `parsePositiveInt` |
| `frontend-nextjs/components/workspace/workspaceNav.ts` | `tabIdentity`, `isWorkflowVersionsPath`, version Tab title |
| `frontend-nextjs/lib/workspaceTabs.ts` | `openTab` replaces Tab by identity |
| `frontend-nextjs/components/workspace/KeepAliveOutlet.tsx` | cache key = identity; live children for version family |
| `frontend-nextjs/components/workflow/WorkflowCanvas.tsx` | `readOnly` |
| `frontend-nextjs/components/workflow/NodeConfigPanel.tsx` | `readOnly` (fieldset + hide delete) |
| `frontend-nextjs/components/workflow/version/types.ts` | list item + snapshot types |
| `frontend-nextjs/components/workflow/version/WorkflowVersionList.tsx` | left list UI |
| `frontend-nextjs/components/workflow/version/WorkflowVersionCanvas.tsx` | meta + canvas + JSON |
| `frontend-nextjs/components/workflow/version/WorkflowVersionBrowser.tsx` | fetch, restore, errors |
| `frontend-nextjs/components/workflow/version/WorkflowVersionPage.tsx` | permission + params → browser |
| `.../workflows/[workflowId]/versions/page.tsx` | re-export page |
| `.../workflows/[workflowId]/versions/[version]/page.tsx` | re-export page |
| `WorkflowsManager.tsx` / `list/RowMenu.tsx` / `WorkflowRow.tsx` / `WorkflowListView.tsx` | entry links |

---

### Task 1: Path helpers, Tab identity, KeepAlive

**Files:**
- Create: `frontend-nextjs/components/workflow/version/paths.ts`
- Modify: `frontend-nextjs/components/workspace/workspaceNav.ts`
- Modify: `frontend-nextjs/lib/workspaceTabs.ts`
- Modify: `frontend-nextjs/components/workspace/KeepAliveOutlet.tsx`

**Interfaces:**
- Consumes: existing `resolveNavMeta`, `openTab`, KeepAlive cache-by-path
- Produces:
  - `parsePositiveInt(raw: string | null | undefined): number | null`
  - `workflowVersionsPath(projectId: number, workflowId: number, version?: number): string`
  - `workflowEditorPath(projectId: number, workflowId: number): string`
  - `isWorkflowVersionsPath(relPath: string): boolean`
  - `tabIdentity(relPath: string): string`

- [ ] **Step 1: Add URL helpers**

Create `frontend-nextjs/components/workflow/version/paths.ts`:

```ts
/** Parse a URL segment into a positive integer, or null if missing / invalid. */
export function parsePositiveInt(raw: string | null | undefined): number | null {
  if (raw == null || raw === '') return null
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

export function workflowVersionsPath(
  projectId: number,
  workflowId: number,
  version?: number,
): string {
  const base = `/workspace/${projectId}/automation/workflows/${workflowId}/versions`
  return version != null ? `${base}/${version}` : base
}

export function workflowEditorPath(projectId: number, workflowId: number): string {
  return `/workspace/${projectId}/automation/workflows?workflowId=${workflowId}`
}
```

- [ ] **Step 2: Add tab identity + version title in `workspaceNav.ts`**

Add next to `resolveNavMeta` (do not add a sidebar `NAV_GROUPS` item):

```ts
const WORKFLOW_VERSIONS_RE = /^(\/automation\/workflows\/\d+\/versions)(?:\/\d+)?$/

export function isWorkflowVersionsPath(relPath: string): boolean {
  return WORKFLOW_VERSIONS_RE.test(relPath)
}

/** Same-workflow version list and detail share one Tab identity. Other paths are unchanged. */
export function tabIdentity(relPath: string): string {
  const m = relPath.match(WORKFLOW_VERSIONS_RE)
  return m ? m[1] : relPath
}
```

At the **top** of `resolveNavMeta`, before exact/prefix match:

```ts
export function resolveNavMeta(relPath: string): NavMeta {
  if (isWorkflowVersionsPath(relPath)) {
    return { label: '工作流版本', icon: 'fas fa-clock-rotate-left' }
  }
  // ... existing exact + prefix logic unchanged
}
```

Without this, prefix match on `/automation/workflows` would title the Tab 「工作流」 and collide with the editor Tab.

- [ ] **Step 3: `openTab` replaces by identity**

In `frontend-nextjs/lib/workspaceTabs.ts`, import `tabIdentity` from `@/components/workspace/workspaceNav` and change `openTab` to:

```ts
  openTab: (tab) => {
    set((s) => {
      const id = tabIdentity(tab.path)
      const idx = s.tabs.findIndex((t) => tabIdentity(t.path) === id)
      const tabs =
        idx >= 0
          ? s.tabs.map((t, i) =>
              i === idx ? { ...t, path: tab.path, title: tab.title, icon: tab.icon } : t,
            )
          : [...s.tabs, tab]
      return commit(get, { tabs, activePath: tab.path })
    })
  },
```

`Tab.path` stays the **full** relPath (so clicking the Tab returns to the version you were viewing). Identity is only for dedup/replace. `layout.tsx` is unchanged.

- [ ] **Step 4: KeepAlive live-updates version-browser children**

In `KeepAliveOutlet.tsx`, import `tabIdentity` and `isWorkflowVersionsPath`. Replace the cache-key logic:

```tsx
  const cacheKey = tabIdentity(currentPath)

  if (isWorkflowVersionsPath(currentPath) || !cache.has(cacheKey)) {
    cache.set(cacheKey, children)
  }

  const renderPaths = Array.from(
    new Set<string>([...openPaths.map(tabIdentity), cacheKey]),
  )

  for (const key of Array.from(cache.keys())) {
    if (!renderPaths.includes(key)) cache.delete(key)
  }

  return (
    <>
      {renderPaths.map((path) => {
        const active = path === cacheKey
        const node = cache.get(path) ?? (active ? children : null)
        return (
          <div key={path} hidden={!active} className="h-full overflow-auto p-6">
            {node}
          </div>
        )
      })}
    </>
  )
```

Editor path `/automation/workflows` is unchanged (`tabIdentity` returns it as-is, children still frozen after first visit).

- [ ] **Step 5: Verify helpers (Node REPL, no new test runner)**

From repo root:

```bash
node --input-type=module -e "
function parsePositiveInt(raw) {
  if (raw == null || raw === '') return null
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}
function workflowVersionsPath(pid, wid, v) {
  const base = '/workspace/' + pid + '/automation/workflows/' + wid + '/versions'
  return v != null ? base + '/' + v : base
}
const RE = /^(\/automation\/workflows\/\d+\/versions)(?:\/\d+)?$/
function tabIdentity(p) { const m = p.match(RE); return m ? m[1] : p }
const eq = (a,b) => { if (JSON.stringify(a)!==JSON.stringify(b)) { console.error('FAIL', a, b); process.exit(1) } }
eq(parsePositiveInt('12'), 12)
eq(parsePositiveInt('0'), null)
eq(parsePositiveInt('-1'), null)
eq(parsePositiveInt('1.5'), null)
eq(parsePositiveInt('abc'), null)
eq(workflowVersionsPath(3, 12), '/workspace/3/automation/workflows/12/versions')
eq(workflowVersionsPath(3, 12, 4), '/workspace/3/automation/workflows/12/versions/4')
eq(tabIdentity('/automation/workflows/12/versions'), '/automation/workflows/12/versions')
eq(tabIdentity('/automation/workflows/12/versions/4'), '/automation/workflows/12/versions')
eq(tabIdentity('/automation/workflows'), '/automation/workflows')
eq(tabIdentity('/database/tables'), '/database/tables')
console.log('ok')
"
```

Expected: `ok`

Then confirm TS copies match: `parsePositiveInt('0')` is null; `tabIdentity` of a version detail equals its list path.

- [ ] **Step 6: Commit (only if the user asked)**

```bash
git add frontend-nextjs/components/workflow/version/paths.ts \
  frontend-nextjs/components/workspace/workspaceNav.ts \
  frontend-nextjs/lib/workspaceTabs.ts \
  frontend-nextjs/components/workspace/KeepAliveOutlet.tsx
git commit -m "$(cat <<'EOF'
feat(workspace): share one Tab for workflow version list and detail

EOF
)"
```

---

### Task 2: Read-only canvas and node panel

**Files:**
- Modify: `frontend-nextjs/components/workflow/WorkflowCanvas.tsx`
- Modify: `frontend-nextjs/components/workflow/NodeConfigPanel.tsx`

**Interfaces:**
- Consumes: existing `Props` / `WorkflowCanvasInner`
- Produces:
  - `WorkflowCanvas` `readOnly?: boolean` (default false); `onChange` optional when `readOnly`
  - `NodeConfigPanel` `readOnly?: boolean`; `onChange` / `onDelete` optional when `readOnly`

- [ ] **Step 1: `NodeConfigPanel` `readOnly`**

Update the props interface:

```ts
interface Props {
  node: WorkflowNodeData | null
  workflowSlug?: string
  onChange?: (node: WorkflowNodeData) => void
  onClose: () => void
  onDelete?: () => void
  onBranchRename?: (nodeId: string, oldBranch: string, newBranch: string) => void
  readOnly?: boolean
}
```

Destructure `readOnly = false`. Guard writes:

```ts
const patch = (next: WorkflowNodeData) => {
  if (readOnly) return
  onChange?.(next)
}
```

At the top of `updateConfig` (and the label-name `onChange`), no-op when `readOnly`:

```ts
const updateConfig = (key: string, value: unknown) => {
  if (readOnly || !onChange) return
  onChange({ ...node, config: { ...node.config, [key]: value } })
}
```

Replace the scrollable body wrapper (`div` with `flex-1 overflow-y-auto p-4 space-y-4`) with:

```tsx
<fieldset
  disabled={readOnly}
  className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0 border-0"
>
  {/* existing fields */}
</fieldset>
```

Footer: hide 删除节点 when `readOnly`; keep 完成 / × close.

```tsx
<div className="p-4 border-t bg-gray-50 flex justify-between">
  {readOnly ? <span /> : (
    <button type="button" onClick={() => onDelete?.()} className="px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded-lg transition-colors">
      删除节点
    </button>
  )}
  <button type="button" onClick={onClose} className="px-4 py-1.5 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
    {readOnly ? '关闭' : '完成'}
  </button>
</div>
```

- [ ] **Step 2: `WorkflowCanvas` `readOnly`**

Update `Props`:

```ts
interface Props {
  initialNodes: WorkflowNodeDef[]
  initialEdges: WorkflowEdgeDef[]
  workflowSlug?: string
  onChange?: (nodes: WorkflowNodeDef[], edges: WorkflowEdgeDef[]) => void
  readOnly?: boolean
}
```

Pass `readOnly = false` into `WorkflowCanvasInner`.

In `syncChange`, no-op when read-only:

```ts
const syncChange = useCallback((nds: Node[], eds: Edge[]) => {
  if (readOnly) return
  onChange?.(fromFlowNodes(nds), fromFlowEdges(eds))
}, [onChange, readOnly])
```

On `ReactFlow`:

```tsx
nodesDraggable={!readOnly}
nodesConnectable={!readOnly}
elementsSelectable
deleteKeyCode={readOnly ? [] : ['Backspace', 'Delete']}
onConnect={readOnly ? undefined : onConnect}
onNodesChange={readOnly ? undefined : onNodesChangeWrapper}
onEdgesChange={readOnly ? undefined : onEdgesChangeWrapper}
```

When `readOnly`, still pass `onNodeClick` so the config panel opens.

Hide the top-left Panel's 「添加节点」 and 「自动排布」 when `readOnly`. Keep 适配视图 + 概览.

```tsx
{!readOnly && (
  <>
    {/* existing palette + 自动排布 */}
  </>
)}
```

Pass `readOnly={readOnly}` into `NodeConfigPanel`. When `readOnly`, pass no-op `onChange` / omit `onDelete`:

```tsx
<NodeConfigPanel
  node={selectedNode}
  workflowSlug={workflowSlug}
  readOnly={readOnly}
  onChange={readOnly ? undefined : handleNodeConfigChange}
  onClose={closePanel}
  onDelete={readOnly ? undefined : handleNodeDelete}
  onBranchRename={readOnly ? undefined : handleBranchRename}
/>
```

Editor call site stays `<WorkflowCanvas ... onChange={handleCanvasChange} />` (no `readOnly`).

- [ ] **Step 3: Verify editor is unchanged**

1. Open `/workspace/:pid/automation/workflows`, edit a workflow.
2. Confirm 「添加节点」、拖拽、连线、Delete、自动排布、节点配置保存仍可用。
3. Do not yet have a version page; skip read-only UI until Task 4.

- [ ] **Step 4: Commit (only if the user asked)**

```bash
git add frontend-nextjs/components/workflow/WorkflowCanvas.tsx \
  frontend-nextjs/components/workflow/NodeConfigPanel.tsx
git commit -m "$(cat <<'EOF'
feat(workflow): add readOnly mode to canvas and node panel

EOF
)"
```

---

### Task 3: Presentational list + canvas pane

**Files:**
- Create: `frontend-nextjs/components/workflow/version/types.ts`
- Create: `frontend-nextjs/components/workflow/version/WorkflowVersionList.tsx`
- Create: `frontend-nextjs/components/workflow/version/WorkflowVersionCanvas.tsx`

**Interfaces:**
- Consumes: `WorkflowCanvas` `readOnly`, `formatDateTime` from `@/lib/utils`, types below
- Produces: `WorkflowVersionList`, `WorkflowVersionCanvas`, `WorkflowVersionListItem`, `WorkflowVersionSnapshot`

- [ ] **Step 1: Types**

Create `frontend-nextjs/components/workflow/version/types.ts`:

```ts
import type { WorkflowEdgeDef, WorkflowNodeDef } from '@/components/workflow/WorkflowCanvas'

export interface WorkflowVersionListItem {
  id: number
  version: number
  name: string
  note: string | null
  trigger_type: string
  node_count: number | null
  created_at: string
  created_by: number | null
  created_by_name: string | null
  created_by_email: string | null
}

export interface WorkflowVersionSnapshot {
  id: number
  workflow_id: number
  version: number
  name: string
  slug: string
  description: string | null
  category: string | null
  department: string | null
  trigger_type: string
  trigger_config: Record<string, unknown>
  nodes: WorkflowNodeDef[]
  edges: WorkflowEdgeDef[]
  timeout_ms: number
  max_retries: number
  note: string | null
  created_by: number | null
  created_at: string
  created_by_name: string | null
  created_by_email: string | null
}

export interface WorkflowVersionHeader {
  id: number
  name: string
  slug: string
}
```

These match `list_workflow_versions` / `get_workflow_version` / `GET /api/admin/workflows/:id` fields used by the UI.

- [ ] **Step 2: Left list**

Create `frontend-nextjs/components/workflow/version/WorkflowVersionList.tsx`:

```tsx
'use client'

import { formatDateTime } from '@/lib/utils'
import type { WorkflowVersionListItem } from './types'

export default function WorkflowVersionList({
  versions,
  selectedVersion,
  loading,
  error,
  onRetry,
  onSelect,
}: {
  versions: WorkflowVersionListItem[]
  selectedVersion: number | null
  loading: boolean
  error: string | null
  onRetry: () => void
  onSelect: (version: number) => void
}) {
  const latest = versions.reduce((max, v) => Math.max(max, v.version), 0)

  return (
    <aside className="w-72 shrink-0 border-r border-slate-200 bg-white flex flex-col min-h-0">
      <div className="px-4 py-3 border-b text-sm font-medium text-slate-700">版本</div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {loading ? (
          <div className="text-center py-10 text-slate-400 text-sm">加载中…</div>
        ) : error ? (
          <div className="text-sm text-red-600 space-y-2">
            <p>{error}</p>
            <button type="button" onClick={onRetry} className="text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-50">
              重试
            </button>
          </div>
        ) : versions.length === 0 ? (
          <div className="text-center py-10 text-slate-400 text-sm">暂无版本记录</div>
        ) : (
          versions.map((v) => {
            const selected = selectedVersion === v.version
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => { if (!selected) onSelect(v.version) }}
                className={`w-full text-left border rounded-lg p-3 text-sm ${
                  selected ? 'border-indigo-300 bg-indigo-50' : 'border-slate-200 hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold text-slate-800">v{v.version}</span>
                  {v.version === latest && (
                    <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-xs">最新</span>
                  )}
                  {typeof v.node_count === 'number' && (
                    <span className="text-xs text-slate-400">{v.node_count} 节点</span>
                  )}
                </div>
                {v.note && <div className="mt-1 text-slate-600 line-clamp-2">{v.note}</div>}
                <div className="mt-1 text-xs text-slate-400">
                  {v.created_by_name && <span title={v.created_by_email || undefined}>{v.created_by_name} · </span>}
                  {v.created_at ? formatDateTime(v.created_at) : ''}
                </div>
              </button>
            )
          })
        )}
        {!loading && !error && versions.length === 200 && (
          <p className="text-xs text-slate-400 px-1">仅显示最近 200 个版本</p>
        )}
      </div>
    </aside>
  )
}
```

- [ ] **Step 3: Right canvas pane**

Create `frontend-nextjs/components/workflow/version/WorkflowVersionCanvas.tsx`:

```tsx
'use client'

import { formatDateTime } from '@/lib/utils'
import WorkflowCanvas from '@/components/workflow/WorkflowCanvas'
import type { WorkflowVersionSnapshot } from './types'

export default function WorkflowVersionCanvas({ snapshot }: { snapshot: WorkflowVersionSnapshot }) {
  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col">
      <div className="px-4 py-3 border-b text-xs text-slate-500 space-y-1 shrink-0">
        <div>
          名称 <span className="text-slate-800">{snapshot.name}</span>
          {' · '}slug <span className="font-mono text-slate-800">{snapshot.slug}</span>
          {' · '}触发 {snapshot.trigger_type}
        </div>
        <div>
          timeout {snapshot.timeout_ms}ms · retries {snapshot.max_retries}
          {snapshot.note ? ` · ${snapshot.note}` : ''}
        </div>
        <div>
          {snapshot.created_by_name && <span>{snapshot.created_by_name} · </span>}
          {snapshot.created_at ? formatDateTime(snapshot.created_at) : ''}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <WorkflowCanvas
          key={snapshot.version}
          readOnly
          initialNodes={snapshot.nodes || []}
          initialEdges={snapshot.edges || []}
          workflowSlug={snapshot.slug}
        />
      </div>
      <details className="shrink-0 border-t px-4 py-2 text-xs text-slate-500">
        <summary className="cursor-pointer hover:text-slate-700">节点 / 连线 / 触发配置 JSON</summary>
        <pre className="mt-2 p-2 bg-slate-50 border rounded font-mono overflow-auto max-h-48">
          {JSON.stringify(
            { nodes: snapshot.nodes, edges: snapshot.edges, trigger_config: snapshot.trigger_config },
            null,
            2,
          )}
        </pre>
      </details>
    </div>
  )
}
```

- [ ] **Step 4: Verify types compile**

Run: `cd frontend-nextjs && npx tsc --noEmit --pretty false`

Expected: no new errors from these files. If `tsc` is slow/noisy from pre-existing files, at least confirm the new files are imported without type errors once Task 4 wires them.

- [ ] **Step 5: Commit (only if the user asked)**

```bash
git add frontend-nextjs/components/workflow/version/types.ts \
  frontend-nextjs/components/workflow/version/WorkflowVersionList.tsx \
  frontend-nextjs/components/workflow/version/WorkflowVersionCanvas.tsx
git commit -m "$(cat <<'EOF'
feat(workflow): add version list and read-only canvas panes

EOF
)"
```

---

### Task 4: Browser shell (fetch, restore, errors) + routes

**Files:**
- Create: `frontend-nextjs/components/workflow/version/WorkflowVersionBrowser.tsx`
- Create: `frontend-nextjs/components/workflow/version/WorkflowVersionPage.tsx`
- Create: `frontend-nextjs/app/workspace/[projectId]/automation/workflows/[workflowId]/versions/page.tsx`
- Create: `frontend-nextjs/app/workspace/[projectId]/automation/workflows/[workflowId]/versions/[version]/page.tsx`

**Interfaces:**
- Consumes: helpers from Task 1, panes from Task 3, `GET/POST` admin version APIs, `showToast`, `ForbiddenPlaceholder`
- Produces: working pages at the spec URLs

- [ ] **Step 1: `WorkflowVersionBrowser`**

Create `frontend-nextjs/components/workflow/version/WorkflowVersionBrowser.tsx`:

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import api, { type ApiRequestConfig } from '@/lib/api'
import { showToast } from '@/components/Toast'
import { workflowEditorPath, workflowVersionsPath } from './paths'
import WorkflowVersionList from './WorkflowVersionList'
import WorkflowVersionCanvas from './WorkflowVersionCanvas'
import type {
  WorkflowVersionHeader,
  WorkflowVersionListItem,
  WorkflowVersionSnapshot,
} from './types'

const silent = { suppressErrorToast: true } as ApiRequestConfig

function apiError(err: any, fallback: string): string {
  return err?.response?.data?.error || err?.message || fallback
}

export default function WorkflowVersionBrowser({
  projectId,
  workflowId,
  version,
  versionInvalid = false,
}: {
  projectId: number
  workflowId: number
  version: number | null
  versionInvalid?: boolean
}) {
  const router = useRouter()
  const [header, setHeader] = useState<WorkflowVersionHeader | null>(null)
  const [headerError, setHeaderError] = useState<string | null>(null)
  const [headerLoading, setHeaderLoading] = useState(true)

  const [versions, setVersions] = useState<WorkflowVersionListItem[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [listLoading, setListLoading] = useState(true)

  const [snapshot, setSnapshot] = useState<WorkflowVersionSnapshot | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailNonce, setDetailNonce] = useState(0)
  const [restoring, setRestoring] = useState(false)

  const loadHeader = useCallback(async () => {
    setHeaderLoading(true)
    setHeaderError(null)
    try {
      const res = await api.get(`/api/admin/workflows/${workflowId}`, silent)
      const wf = res.data.workflow
      setHeader({ id: wf.id, name: wf.name, slug: wf.slug })
    } catch (err: any) {
      setHeader(null)
      setHeaderError(apiError(err, '加载工作流失败'))
    } finally {
      setHeaderLoading(false)
    }
  }, [workflowId])

  const loadList = useCallback(async () => {
    setListLoading(true)
    setListError(null)
    try {
      const res = await api.get(`/api/admin/workflows/${workflowId}/versions`, {
        ...silent,
        params: { limit: 200 },
      })
      setVersions(res.data.versions || [])
    } catch (err: any) {
      setVersions([])
      setListError(apiError(err, '加载版本列表失败'))
    } finally {
      setListLoading(false)
    }
  }, [workflowId])

  useEffect(() => {
    void loadHeader()
    void loadList()
  }, [loadHeader, loadList])

  useEffect(() => {
    if (versionInvalid) {
      setSnapshot(null)
      setDetailError('版本不存在')
      setDetailLoading(false)
      return
    }
    if (version == null) {
      setSnapshot(null)
      setDetailError(null)
      setDetailLoading(false)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    setDetailError(null)
    api
      .get(`/api/admin/workflows/${workflowId}/versions/${version}`, silent)
      .then((res) => {
        if (!cancelled) setSnapshot(res.data.version)
      })
      .catch((err: any) => {
        if (!cancelled) {
          setSnapshot(null)
          setDetailError(apiError(err, '加载版本详情失败'))
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [workflowId, version, versionInvalid, detailNonce])

  const latestVersion = versions.reduce((max, v) => Math.max(max, v.version), 0)
  const canRestore = version != null && latestVersion > 0 && version !== latestVersion

  const restore = async () => {
    if (version == null || restoring) return
    if (
      !confirm(
        `确认把工作流恢复到版本 v${version}？\n当前未保存的改动将被覆盖；恢复会作为一个新版本记录，可再次回滚。`,
      )
    ) {
      return
    }
    setRestoring(true)
    try {
      await api.post(`/api/admin/workflows/${workflowId}/versions/${version}/restore`)
      showToast('success', `已恢复到 v${version}。可打开编辑器查看当前定义。`)
      await loadList()
    } catch (err: any) {
      if (!err?.__toastShown) showToast('error', apiError(err, '恢复失败'))
    } finally {
      setRestoring(false)
    }
  }

  if (headerLoading && !header) {
    return <div className="p-8 text-center text-slate-400 text-sm">加载中…</div>
  }

  if (headerError || !header) {
    return (
      <div className="p-8 text-center space-y-3">
        <p className="text-sm text-slate-600">{headerError || '工作流不存在或无权访问'}</p>
        <button type="button" onClick={() => void loadHeader()} className="text-sm text-indigo-600 hover:underline">
          重试
        </button>
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b flex items-center justify-between gap-3 shrink-0">
        <div className="min-w-0">
          <div className="font-medium text-slate-800 truncate">{header.name}</div>
          <div className="text-xs font-mono text-slate-400">{header.slug}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href={workflowEditorPath(projectId, workflowId)}
            className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
          >
            打开编辑器
          </Link>
          {canRestore && (
            <button
              type="button"
              disabled={restoring}
              onClick={() => void restore()}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-indigo-300 text-indigo-600 hover:bg-indigo-50 disabled:opacity-50"
            >
              {restoring ? '恢复中…' : '恢复到此版本'}
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        <WorkflowVersionList
          versions={versions}
          selectedVersion={version}
          loading={listLoading}
          error={listError}
          onRetry={() => void loadList()}
          onSelect={(v) => router.replace(workflowVersionsPath(projectId, workflowId, v))}
        />
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          {version == null ? (
            <div className="flex-1 flex items-center justify-center text-sm text-slate-400">
              选择一个版本以查看内容
            </div>
          ) : detailLoading ? (
            <div className="flex-1 flex items-center justify-center text-sm text-slate-400">加载中…</div>
          ) : detailError || !snapshot ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-sm text-slate-600">
              <p>{detailError || '版本不存在'}</p>
              <button
                type="button"
                onClick={() => setDetailNonce((n) => n + 1)}
                className="text-xs text-indigo-600 hover:underline"
              >
                重试
              </button>
            </div>
          ) : (
            <WorkflowVersionCanvas snapshot={snapshot} />
          )}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Page wrapper**

Create `frontend-nextjs/components/workflow/version/WorkflowVersionPage.tsx`:

```tsx
'use client'

import { useParams } from 'next/navigation'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'
import { parsePositiveInt } from './paths'
import WorkflowVersionBrowser from './WorkflowVersionBrowser'

export default function WorkflowVersionPage() {
  const params = useParams<{ projectId: string; workflowId: string; version?: string }>()
  const caps = useCurrentProjectCapabilities()
  const projectId = parsePositiveInt(params.projectId)
  const workflowId = parsePositiveInt(params.workflowId)
  const versionRaw = params.version
  const versionParsed = parsePositiveInt(versionRaw ?? null)
  const versionInvalid = versionRaw != null && versionRaw !== '' && versionParsed == null

  if (!caps.canManageEvents) {
    return <ForbiddenPlaceholder reason="工作流需要 admin+ 角色（owner / admin / 超管）" />
  }
  if (projectId == null) {
    return <div className="p-8 text-center text-gray-500">URL 中的 projectId 无效</div>
  }
  if (workflowId == null) {
    return <div className="p-8 text-center text-gray-500">工作流不存在或无权访问</div>
  }

  return (
    <WorkflowVersionBrowser
      projectId={projectId}
      workflowId={workflowId}
      version={versionParsed}
      versionInvalid={versionInvalid}
    />
  )
}
```

- [ ] **Step 3: Route files**

Both pages are identical re-exports (params differ by folder):

`frontend-nextjs/app/workspace/[projectId]/automation/workflows/[workflowId]/versions/page.tsx`:

```tsx
'use client'

export { default } from '@/components/workflow/version/WorkflowVersionPage'
```

`frontend-nextjs/app/workspace/[projectId]/automation/workflows/[workflowId]/versions/[version]/page.tsx`:

```tsx
'use client'

export { default } from '@/components/workflow/version/WorkflowVersionPage'
```

Do **not** copy the workflows page's `database_id` gate.

- [ ] **Step 4: Verify routes**

1. Log in as admin+, open `/workspace/{pid}/automation/workflows/{id}/versions` for a workflow that has saves.
2. Left list shows versions, latest badge, no restore on the list page.
3. Click a version: URL becomes `.../versions/{n}`, canvas appears, no 「添加节点」.
4. Click a node: config panel fields disabled, no 删除节点.
5. Expand JSON: contains `nodes`, `edges`, `trigger_config`.
6. Open `.../versions/999999` (missing): list remains, right side 「版本不存在」 or API error text.
7. Non-admin: Forbidden copy, no nodes leaked.
8. Switching vA → vB does not add a second Tab; editor Tab can sit beside it.
9. Restore a non-latest version: confirm dialog; list gains a top item whose note is `恢复自 vN`; URL stays on the restored-from version; toast mentions 打开编辑器.

- [ ] **Step 5: Commit (only if the user asked)**

```bash
git add frontend-nextjs/components/workflow/version/WorkflowVersionBrowser.tsx \
  frontend-nextjs/components/workflow/version/WorkflowVersionPage.tsx \
  frontend-nextjs/app/workspace/[projectId]/automation/workflows/[workflowId]/versions/page.tsx \
  frontend-nextjs/app/workspace/[projectId]/automation/workflows/[workflowId]/versions/[version]/page.tsx
git commit -m "$(cat <<'EOF'
feat(workflow): add dedicated version browser routes

EOF
)"
```

---

### Task 5: Drawer and list-menu entry points

**Files:**
- Modify: `frontend-nextjs/components/workflow/WorkflowsManager.tsx`
- Modify: `frontend-nextjs/components/workflow/list/RowMenu.tsx`
- Modify: `frontend-nextjs/components/workflow/list/WorkflowRow.tsx`
- Modify: `frontend-nextjs/components/workflow/list/WorkflowListView.tsx`

**Interfaces:**
- Consumes: `workflowVersionsPath`, existing `projectId` on `WorkflowsManager`
- Produces: `onOpenVersionHistory?: (wf: WorkflowListItem) => void` on the list; drawer links

- [ ] **Step 1: Row menu item**

In `RowMenu.tsx` `RowMenuProps` / `WorkflowRowActionsProps` add optional:

```ts
onOpenVersionHistory?: () => void
```

In the dropdown, above 导出:

```tsx
{onOpenVersionHistory && (
  <MenuItem onClick={onOpenVersionHistory} close={() => setMenuOpen(false)}>
    <i className="fas fa-clock-rotate-left text-[10px] w-3.5 text-slate-400" />
    版本历史
  </MenuItem>
)}
```

Pass through `WorkflowRowActions` → `RowMenu`.

- [ ] **Step 2: Row / Card / ListView**

Add optional `onOpenVersionHistory?: () => void` to `WorkflowRowProps`. Pass into `WorkflowRowActions`.

`WorkflowListViewProps`:

```ts
onOpenVersionHistory?: (wf: WorkflowListItem) => void
```

On compact row and card:

```tsx
onOpenVersionHistory={onOpenVersionHistory ? () => onOpenVersionHistory(wf) : undefined}
```

- [ ] **Step 3: Manager wiring**

Import `workflowVersionsPath`. In the list:

```tsx
onOpenVersionHistory={
  projectId != null
    ? (wf) => router.push(workflowVersionsPath(projectId, wf.id))
    : undefined
}
```

Drawer header, next to the title / close button:

```tsx
{projectId != null && editing && (
  <a
    href={workflowVersionsPath(projectId, editing.id)}
    onClick={(e) => {
      e.preventDefault()
      router.push(workflowVersionsPath(projectId, editing.id))
    }}
    className="text-xs text-indigo-600 hover:underline"
  >
    在页面中打开
  </a>
)}
```

Each version row, beside 查看:

```tsx
{projectId != null && editing && (
  <button
    type="button"
    onClick={() => router.push(workflowVersionsPath(projectId, editing.id, v.version))}
    className="text-xs px-2 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
  >
    页面
  </button>
)}
```

Keep 查看 (inline JSON) and 恢复 in the drawer.

- [ ] **Step 4: Verify entries**

1. List ⋯ → 版本历史 opens `/automation/workflows/{id}/versions` as a separate Tab from the editor list.
2. Editor 版本历史 still opens the drawer; 在页面中打开 and row 页面 land on the new routes.
3. If `projectId` were missing, menu item would hide — current page always passes `projectId`.

- [ ] **Step 5: Commit (only if the user asked)**

```bash
git add frontend-nextjs/components/workflow/WorkflowsManager.tsx \
  frontend-nextjs/components/workflow/list/RowMenu.tsx \
  frontend-nextjs/components/workflow/list/WorkflowRow.tsx \
  frontend-nextjs/components/workflow/list/WorkflowListView.tsx
git commit -m "$(cat <<'EOF'
feat(workflow): link version drawer and list menu to version pages

EOF
)"
```

---

### Task 6: Spec §9 acceptance sweep

**Files:** none unless a bugfix is required.

- [ ] **Step 1: Run the spec checklist**

- Unauthenticated version URL → login → back to the same URL
- Non-admin+ → Forbidden, no node JSON
- List ordered by version desc; latest has badge and no restore
- Selected version: URL `.../versions/{n}`, canvas is that snapshot, no 添加节点; node panel read-only
- JSON fold contains nodes / edges / trigger_config
- Invalid version → right pane 不存在, list remains
- Restore non-latest → new list head note `恢复自 vN`; stay on original version URL
- Drawer 「在页面中打开」 and list 「版本历史」 hit the same routes
- Same workflow v2 → v5 does not open a new Tab; editor Tab can coexist
- Editor save / connect / delete still work without `readOnly`

- [ ] **Step 2: Fix any miss against the spec, then stop**

Do not add diff UI, pagination, or sidebar items.

---

## Spec coverage (self-review)

| Spec section | Task |
|--------------|------|
| §3.1 routes | Task 4 |
| §3.2 permission / no DB gate | Task 4 `WorkflowVersionPage` |
| §3.3 Tab + KeepAlive | Task 1 |
| §4 layout / list / JSON | Task 3–4 |
| §5 readOnly canvas + restore | Task 2 + 4 |
| §6 error table | Task 4 |
| §7 drawer + row menu | Task 5 |
| §8 file map | Tasks 1–5 |
| §9 tests | Task 6 |
| `workflowVersionsPath` single source | Task 1, used in 4–5 |
| 200-cap hint | Task 3 list footer |
| No new backend | all tasks |
