# Task 6 — Spec §9 acceptance sweep

Date: 2026-08-20

No live frontend/backend session was already running. Per the brief, no stack or dependency installation was attempted. Session/data-dependent checks are **DEFERRED (no live session)**.

One targeted miss was fixed: read-only snapshots still ran initial overlap auto-layout. `WorkflowCanvas` now skips it when `readOnly` (`frontend-nextjs/components/workflow/WorkflowCanvas.tsx:332-340`).

## Checklist

1. **DEFERRED (no live session)** — Unauthenticated version URL → login → same URL.
   - `/workspace/...` is protected (`frontend-nextjs/middleware.ts:18-25`, `frontend-nextjs/middleware.ts:97-107`).
   - Redirect preserves `pathname + search` as `next` (`frontend-nextjs/middleware.ts:56-74`, `frontend-nextjs/middleware.ts:77-90`).
   - Login validates and prioritizes `next` (`frontend-nextjs/app/login/page.tsx:45-60`).
   - Browser cookie/redirect round-trip was not exercised.

2. **DEFERRED (no live session)** — Non-admin+ → Forbidden, no node JSON.
   - `canManageEvents` returns `ForbiddenPlaceholder` before `WorkflowVersionBrowser` mounts (`frontend-nextjs/components/workflow/version/WorkflowVersionPage.tsx:9-20`, `frontend-nextjs/components/workflow/version/WorkflowVersionPage.tsx:28-34`).
   - Backend list/detail handlers authorize before reading versions (`src/workflow_handlers.rs:2470-2477`, `src/workflow_handlers.rs:2521-2529`).
   - No non-admin role session was available for network inspection.

3. **PASS** — Descending list; latest badge; no restore on latest.
   - API orders `v.version DESC` (`src/workflow_handlers.rs:2483-2495`).
   - UI derives maximum and badges it (`frontend-nextjs/components/workflow/version/WorkflowVersionList.tsx:21-22`, `frontend-nextjs/components/workflow/version/WorkflowVersionList.tsx:39-54`).
   - Restore requires selection to differ from the maximum (`frontend-nextjs/components/workflow/version/WorkflowVersionBrowser.tsx:126-135`, `frontend-nextjs/components/workflow/version/WorkflowVersionBrowser.tsx:187-196`).

4. **PASS** — Version URL, snapshot canvas, no add node, read-only panel.
   - Selection uses `router.replace`; reselect is ignored (`frontend-nextjs/components/workflow/version/WorkflowVersionList.tsx:39-46`, `frontend-nextjs/components/workflow/version/WorkflowVersionBrowser.tsx:200-208`).
   - Matching detail snapshot is fetched/rendered (`frontend-nextjs/components/workflow/version/WorkflowVersionBrowser.tsx:87-124`, `frontend-nextjs/components/workflow/version/WorkflowVersionBrowser.tsx:214-218`).
   - Snapshot nodes/edges feed `WorkflowCanvas readOnly` (`frontend-nextjs/components/workflow/version/WorkflowVersionCanvas.tsx:25-32`).
   - Read-only disables drag/connect/change/delete and hides add/auto-layout controls (`frontend-nextjs/components/workflow/WorkflowCanvas.tsx:529-538`, `frontend-nextjs/components/workflow/WorkflowCanvas.tsx:573-574`, `frontend-nextjs/components/workflow/WorkflowCanvas.tsx:609-643`).
   - Read-only skips initial auto-layout after this task's fix (`frontend-nextjs/components/workflow/WorkflowCanvas.tsx:332-340`).
   - Node click still opens a disabled panel with mutation controls omitted (`frontend-nextjs/components/workflow/WorkflowCanvas.tsx:437-439`, `frontend-nextjs/components/workflow/WorkflowCanvas.tsx:669-678`, `frontend-nextjs/components/workflow/NodeConfigPanel.tsx:354-357`, `frontend-nextjs/components/workflow/NodeConfigPanel.tsx:1418-1434`).

5. **PASS** — JSON fold contains nodes / edges / trigger_config.
   - Collapsed-by-default `<details>` renders all three (`frontend-nextjs/components/workflow/version/WorkflowVersionCanvas.tsx:34-43`).

6. **PASS** — Invalid version shows right-pane not-found; list remains.
   - Invalid segments are detected without detail request (`frontend-nextjs/components/workflow/version/WorkflowVersionPage.tsx:12-16`, `frontend-nextjs/components/workflow/version/WorkflowVersionBrowser.tsx:87-99`).
   - List stays mounted beside “版本不存在” (`frontend-nextjs/components/workflow/version/WorkflowVersionBrowser.tsx:200-215`).
   - Numeric 404 remains a detail-only error with retry (`frontend-nextjs/components/workflow/version/WorkflowVersionBrowser.tsx:104-124`, `frontend-nextjs/components/workflow/version/WorkflowVersionBrowser.tsx:218-228`).

7. **DEFERRED (no live session)** — Restore creates “恢复自 vN” head and stays on URL.
   - UI posts, toasts, and reloads only the list without navigating (`frontend-nextjs/components/workflow/version/WorkflowVersionBrowser.tsx:137-155`).
   - Backend appends exact note `恢复自 v{version}` (`src/workflow_handlers.rs:2592-2595`); descending order makes it the head (`src/workflow_handlers.rs:2483-2495`).
   - Database mutation/post-restore UI was not exercised.

8. **PASS** — Drawer and row-menu entries use the same routes.
   - Row callback pushes `workflowVersionsPath(projectId, wf.id)` (`frontend-nextjs/components/workflow/WorkflowsManager.tsx:1457-1461`).
   - Drawer uses the same helper/arguments (`frontend-nextjs/components/workflow/WorkflowsManager.tsx:1560-1569`).
   - Helper is the list/detail route source (`frontend-nextjs/components/workflow/version/paths.ts:9-16`).

9. **PASS** — v2 → v5 reuses one Tab; editor Tab coexists.
   - Only numeric version-family paths canonicalize; editor path remains distinct (`frontend-nextjs/components/workspace/workspaceNav.ts:207-217`).
   - `openTab` replaces the canonical match instead of appending (`frontend-nextjs/lib/workspaceTabs.ts:102-113`).
   - KeepAlive uses that identity and refreshes version children (`frontend-nextjs/components/workspace/KeepAliveOutlet.tsx:29-45`).

10. **DEFERRED (no live session)** — Editor save/connect/delete regression.
    - `readOnly` defaults false (`frontend-nextjs/components/workflow/WorkflowCanvas.tsx:204-205`).
    - Editor omits `readOnly`, passes `onChange`, and retains save wiring (`frontend-nextjs/components/workflow/WorkflowsManager.tsx:1490-1506`, `frontend-nextjs/components/workflow/WorkflowsManager.tsx:1526-1534`).
    - Default mode retains connect/change/delete handlers (`frontend-nextjs/components/workflow/WorkflowCanvas.tsx:529-538`, `frontend-nextjs/components/workflow/WorkflowCanvas.tsx:573-574`, `frontend-nextjs/components/workflow/WorkflowCanvas.tsx:669-678`).
    - Interactive regression was not possible without a live session.

## Totals / verification

- **PASS: 6**
- **FAIL: 0**
- **DEFERRED: 4**

IDE diagnostics show no lint errors in modified `WorkflowCanvas.tsx`. Direct ESLint could not start because `frontend-nextjs/node_modules/.bin/eslint` is absent; dependencies were intentionally not installed.

## Fix — spec §6 detail 404 message

Detail GET 404 now sets right-pane error to exactly `版本不存在` (was `apiError` fallback). Other detail failures unchanged. Invalid non-numeric version path unchanged; list stays mounted.

Static check:

```bash
rg -n "response\?\.status === 404 \? '版本不存在'" frontend-nextjs/components/workflow/version/WorkflowVersionBrowser.tsx
```

```
113:            err?.response?.status === 404 ? '版本不存在' : apiError(err, '加载版本详情失败'),
```
