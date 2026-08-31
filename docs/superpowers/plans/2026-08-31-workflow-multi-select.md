# Workflow Canvas Multi-Select Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users Shift-box-select and Shift/Cmd/Ctrl-click nodes on the workflow canvas, then drag or delete the whole selection, without changing save format or backend.

**Architecture:** Keep React Flow 11 as the selection source of truth (`node.selected`). Add `clampGroupDragToCanvas` so a multi-node drag uses one shared translation. Sync `NodeConfigPanel` from `onSelectionChange` (open only when exactly one node is selected). Disable React Flow delete keys while an editable field or CodeMirror has focus.

**Tech Stack:** Next.js 14, React 18, React Flow 11.

**Spec:** `docs/superpowers/specs/2026-08-31-workflow-multi-select-design.md`

## Global Constraints

- Selection is React Flow `node.selected`; do not add a second multi-select store
- `selectionKeyCode` is Shift; `selectionOnDrag` is false; `selectionMode` is Partial
- `multiSelectionKeyCode` is `['Meta', 'Control', 'Shift']`
- Config panel opens only when the selection length is exactly 1
- Group drag uses one shared displacement so relative layout does not scatter at the canvas edge
- No copy/paste, align, edge box-select, or bulk config edit
- No new backend API; `fromFlowNodes` / `fromFlowEdges` shape stays the same
- Delete has no confirm dialog (same as today’s single-node Delete)
- Repo has no frontend unit-test runner; each task ends with a concrete manual check
- Do not commit unless the user asked; skip `git commit` steps if commits were not requested

## File map

| Path | Responsibility |
|------|----------------|
| `frontend-nextjs/components/workflow/workflowLayout.ts` | `clampGroupDragToCanvas` |
| `frontend-nextjs/components/workflow/WorkflowCanvas.tsx` | RF multi-select props, panel sync, group clamp, delete-key gating, edges not selectable |

---

### Task 1: Shared group-drag clamp

**Files:**
- Modify: `frontend-nextjs/components/workflow/workflowLayout.ts`
- Modify: `frontend-nextjs/components/workflow/WorkflowCanvas.tsx` (`onNodesChangeWrapper` only)

**Interfaces:**
- Consumes: existing `clampDragToCanvas(position, instance, canvasEl)`
- Produces:
  - `export function clampGroupDragToCanvas(changes: NodeChange[], nodes: Array<{ id: string; position: { x: number; y: number } }>, instance: ReactFlowInstance, canvasEl: HTMLElement): NodeChange[]`

- [ ] **Step 1: Add `clampGroupDragToCanvas`**

At the top of `workflowLayout.ts`, ensure `NodeChange` is imported from `reactflow` (the file already imports `ReactFlowInstance`; add `NodeChange` to that import).

Immediately after `clampDragToCanvas`, add:

```ts
export function clampGroupDragToCanvas(
  changes: NodeChange[],
  nodes: Array<{ id: string; position: { x: number; y: number } }>,
  instance: ReactFlowInstance,
  canvasEl: HTMLElement,
): NodeChange[] {
  const dragging = changes.filter(
    (ch): ch is NodeChange & { id: string; type: 'position'; position: { x: number; y: number }; dragging: true } =>
      ch.type === 'position' && !!ch.position && ch.dragging === true,
  )

  if (dragging.length <= 1) {
    return changes.map((ch) => {
      if (ch.type !== 'position' || !ch.position || !ch.dragging) return ch
      return { ...ch, position: clampDragToCanvas(ch.position, instance, canvasEl) }
    })
  }

  const currentById = new Map(nodes.map((n) => [n.id, n.position]))
  let tx: number | null = null
  let ty: number | null = null
  const allowedTx: number[] = []
  const allowedTy: number[] = []

  for (const ch of dragging) {
    const cur = currentById.get(ch.id)
    if (!cur) continue
    tx = ch.position.x - cur.x
    ty = ch.position.y - cur.y
    const clamped = clampDragToCanvas(ch.position, instance, canvasEl)
    allowedTx.push(clamped.x - cur.x)
    allowedTy.push(clamped.y - cur.y)
  }

  if (tx == null || ty == null || allowedTx.length === 0) return changes

  const finalTx = tx >= 0 ? Math.min(tx, ...allowedTx) : Math.max(tx, ...allowedTx)
  const finalTy = ty >= 0 ? Math.min(ty, ...allowedTy) : Math.max(ty, ...allowedTy)

  return changes.map((ch) => {
    if (ch.type !== 'position' || !ch.position || !ch.dragging) return ch
    const cur = currentById.get(ch.id)
    if (!cur) return { ...ch, position: clampDragToCanvas(ch.position, instance, canvasEl) }
    return { ...ch, position: { x: cur.x + finalTx, y: cur.y + finalTy } }
  })
}
```

- [ ] **Step 2: Use it in `onNodesChangeWrapper`**

In `WorkflowCanvas.tsx`, add `clampGroupDragToCanvas` to the import from `./workflowLayout` (keep `clampDragToCanvas` if still used elsewhere in the file; if not, drop it from this import).

Replace the clamp block inside `onNodesChangeWrapper` with:

```ts
    const clamped = inst && el
      ? clampGroupDragToCanvas(changes, inst.getNodes(), inst, el)
      : changes
```

Do not change the `hasDragEnd` / `syncChange` / `refreshEdges` logic.

- [ ] **Step 3: Manual check**

Open a workflow with at least two nodes. Shift-click two nodes (RF may already allow this). Drag them into the canvas edge: they should stop together and keep spacing. A single-node drag should still be clamped as before.

- [ ] **Step 4: Commit** (skip if the user did not ask)

```bash
git add frontend-nextjs/components/workflow/workflowLayout.ts \
  frontend-nextjs/components/workflow/WorkflowCanvas.tsx
git commit -m "$(cat <<'EOF'
Clamp multi-node workflow drags as one group.

EOF
)"
```

---

### Task 2: Box select, modifier click, config panel sync

**Files:**
- Modify: `frontend-nextjs/components/workflow/WorkflowCanvas.tsx`

**Interfaces:**
- Consumes: `clampGroupDragToCanvas` from Task 1
- Produces: React Flow selection props; `onSelectionChange` drives `selectedNode`; edges have `selectable: false`

- [ ] **Step 1: Mark edges not selectable**

In `toFlowEdges`, add `selectable: false` on the returned edge object (next to `id` / `type` / `source`):

```ts
    return {
      id: `e-${e.from}-${e.to}-${i}`,
      type: 'workflowEdge',
      selectable: false,
      source: e.from,
      target: e.to,
```

- [ ] **Step 2: Import `SelectionMode` and add `onSelectionChange`**

Add `SelectionMode` to the `reactflow` import.

Replace `onNodeClick` so it does not open the panel (RF updates `selected`; the panel follows selection):

```ts
  const onSelectionChange = useCallback(({ nodes: selected }: { nodes: Node[] }) => {
    if (selected.length === 1) {
      const node = selected[0]
      setSelectedNode({
        id: node.id,
        type: node.data.nodeType,
        label: node.data.label,
        config: node.data.config,
      })
      return
    }
    setSelectedNode(null)
  }, [])
```

Delete the `onNodeClick` callback, or leave it as an empty function if something still passes it. Remove `onNodeClick={onNodeClick}` from `<ReactFlow>` and add `onSelectionChange={onSelectionChange}`.

Keep `onPaneClick` as-is (it closes the panel when the pane is clicked). Empty selection from a missed box-select also hits `onSelectionChange` with `[]` and closes the panel.

- [ ] **Step 3: Set React Flow selection props**

On `<ReactFlow>`, add these props (do not set `selectionOnDrag`; default false keeps left-drag as pan):

```tsx
          selectionKeyCode="Shift"
          multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
          selectionMode={SelectionMode.Partial}
          onSelectionChange={onSelectionChange}
```

`deleteKeyCode` stays as it is until Task 3. `nodesDraggable={!readOnly}` stays.

- [ ] **Step 4: Manual check**

1. Left-drag empty canvas still pans.
2. Shift-drag empty canvas draws a box; overlapping nodes get the indigo ring; config panel stays closed if 2+ are selected.
3. Click one node: panel opens for that node.
4. Shift/Cmd/Ctrl-click a second node: both highlighted, panel closes.
5. Modifier-click until one remains: panel opens for that node.
6. Click empty pane: selection clears, panel closes.
7. Click an edge: it is not added to the selection.

- [ ] **Step 5: Commit** (skip if the user did not ask)

```bash
git add frontend-nextjs/components/workflow/WorkflowCanvas.tsx
git commit -m "$(cat <<'EOF'
Enable Shift box-select and modifier multi-select on workflows.

EOF
)"
```

---

### Task 3: Delete keys vs editor focus

**Files:**
- Modify: `frontend-nextjs/components/workflow/WorkflowCanvas.tsx`

**Interfaces:**
- Consumes: existing `deleteKeyCode` and `handleNodeDelete` (panel button, single node)
- Produces: `canvasDeleteEnabled` boolean; RF delete keys off when an editable control is focused

- [ ] **Step 1: Track whether the focused element is editable**

Inside `WorkflowCanvasInner`, after the existing refs, add:

```ts
  const [canvasDeleteEnabled, setCanvasDeleteEnabled] = useState(true)

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false
      return !!target.closest(
        'input, textarea, select, [contenteditable="true"], .cm-editor, .cm-content',
      )
    }
    const onFocusIn = (e: FocusEvent) => {
      setCanvasDeleteEnabled(!isEditableTarget(e.target))
    }
    const onFocusOut = (e: FocusEvent) => {
      if (isEditableTarget(e.relatedTarget)) return
      setCanvasDeleteEnabled(true)
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [])
```

- [ ] **Step 2: Gate `deleteKeyCode`**

Replace the React Flow prop:

```tsx
          deleteKeyCode={readOnly || !canvasDeleteEnabled ? [] : ['Backspace', 'Delete']}
```

Do not change `handleNodeDelete` (config panel still deletes only the panel node). React Flow’s built-in delete already removes all `selected` nodes and edges that touch them; `onNodesChangeWrapper` / `onEdgesChangeWrapper` already call `syncChange`.

- [ ] **Step 3: Manual check**

1. Multi-select nodes, press Delete: those nodes and their edges disappear; save and reopen — still gone.
2. Open a code node, click the editor (or 放大), press Delete: only text changes.
3. Focus a config-panel input, press Backspace: edits the field, does not delete the node.
4. Click the canvas background, then Delete with a selection: nodes delete.
5. Version browse (`readOnly`): Delete does nothing; nodes are not draggable.

- [ ] **Step 4: Commit** (skip if the user did not ask)

```bash
git add frontend-nextjs/components/workflow/WorkflowCanvas.tsx
git commit -m "$(cat <<'EOF'
Ignore canvas Delete while editing workflow fields.

EOF
)"
```

---

### Task 4: Spec acceptance

**Files:** none new

**Interfaces:**
- Consumes: Tasks 1–3
- Produces: spec §8 checklist done in the session notes

- [ ] **Step 1: Run the spec checklist**

1. Shift box-select several nodes, drag one: others follow, 16px grid, relative positions stay.
2. Drag the group into a canvas edge: the group stops as one; layout does not squash.
3. Shift/Cmd/Ctrl click add/remove; plain click is single-select + panel.
4. Multi-select Delete removes nodes and incident edges; persist after save.
5. Click pane clears selection and closes the panel; left-drag empty still pans.
6. Read-only version page: highlight works, drag and Delete do not.
7. Code snippet overlay: Delete edits text only.

- [ ] **Step 2: Commit** (skip if the user did not ask)

Only if QA produced extra fixes.

---

## Self-review

| Spec item | Task |
|-----------|------|
| Shift box select, Partial, no selectionOnDrag | 2 |
| Meta/Control/Shift click | 2 |
| Panel iff selection length === 1 | 2 |
| Group drag + shared clamp | 1 |
| Edges not in selection | 2 |
| Delete selected + incident edges, no confirm | 3 (RF built-in + existing sync) |
| Delete ignored in editor / inputs | 3 |
| Read-only: highlight only | 2–3 |
| No copy/align/bulk config | constraints |
