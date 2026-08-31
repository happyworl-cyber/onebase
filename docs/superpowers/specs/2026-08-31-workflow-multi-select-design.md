# 工作流画布多选：框选、整组拖动、整组删除 — 设计文档

- 日期：2026-08-31
- 状态：草案
- 相关代码：
  - `frontend-nextjs/components/workflow/WorkflowCanvas.tsx`
  - `frontend-nextjs/components/workflow/NodeTypes.tsx`（`selected` 高亮环）
  - `frontend-nextjs/components/workflow/workflowLayout.ts`（`clampDragToCanvas`）
  - 只读：版本浏览页 `WorkflowCanvas readOnly`

## 1. 背景与目标

画布目前是单选：单击节点打开右侧配置，拖的是这一个。用户需要一次选中多个节点，一起挪位置、一起删除。

**目标**：在现有 React Flow 11 画布上支持 Shift 框选与 Shift/Cmd/Ctrl 点选，选中集合可整组拖动、整组删除。不改后端，不改节点 config 形状。

### 已确认需求

1. **选中**：框选 + Shift/Cmd/Ctrl 点选加减（方案 A）。
2. **批量操作**：一起拖 + Delete/Backspace 一起删（方案 A）。不做复制、对齐。
3. **框选与平移**：Shift + 拖空白为框选；左键空拖仍平移（方案 1）。
4. **配置栏**：只服务恰好 1 个选中节点；多选时关栏。

### 非目标（YAGNI）

- 复制 / 粘贴、对齐、等距排布。
- 框选边、多选后批量改 config。
- 选择模式开关、左键空拖改为框选、空格/中键平移。
- 新状态库、新后端 API。

## 2. 关键决定

| 决定 | 选择 | 理由 |
|------|------|------|
| 实现 | React Flow 自带多选（`node.selected`） | 已有高亮与拖拽，少造状态 |
| 框选 | `selectionKeyCode = Shift`，`selectionOnDrag = false`，`selectionMode = Partial` | 不改变现有左键平移；碰到边也算选中 |
| 加减点选 | `multiSelectionKeyCode = ['Meta', 'Control', 'Shift']` | Mac Cmd、Windows Ctrl、以及 Shift 单击 |
| 配置栏 | 选中数 ≠ 1 则关闭 | 避免对着「一组」改单个节点配置 |
| 组拖钳制 | 整组同一位移 | 避免相对位置被逐个 clamp 拆散 |
| 删除确认 | 无 | 与现单节点 Delete 一致 |

## 3. 架构

```
用户手势
  ├─ 左键拖空白          → 平移（现有）
  ├─ Shift+拖空白        → RF 选框 → node.selected
  ├─ 单击节点            → 单选 + 开 NodeConfigPanel
  ├─ Shift/Cmd/Ctrl+单击 → 加减 selected；多选则关栏
  ├─ 拖已选节点          → 整组 position；组 clamp 后 syncChange
  └─ Delete/Backspace    → 删 selected 节点 + 关联边 → syncChange

onSelectionChange(nodes)
  length === 1 → setSelectedNode(那一个)
  否则         → setSelectedNode(null) 关栏
```

选中集合以 React Flow 的 `node.selected` 为准。`selectedNode` 只表示「配置栏正在编辑谁」，不另存多选列表。

改动集中在 `WorkflowCanvas.tsx`。`NodeTypes` 已有 `selected` 高亮，不改视觉语言。`workflowLayout.ts` 增加组 clamp（或给现有 `clampDragToCanvas` 增加「同一 delta」包装），供 `onNodesChangeWrapper` 在 `position + dragging` 时使用。

## 4. 交互约定

| 手势 | 结果 |
|------|------|
| 左键拖空白 | 平移画布 |
| Shift + 拖空白 | 浅蓝选框；松开后与框**相交**的节点全部选中（部分碰到也算）。一个都没碰到则清空并关栏 |
| 单击节点 | 只选该节点，打开配置栏 |
| Shift / Cmd / Ctrl + 单击节点 | 加入或移出选择。结果为多选则关栏；结果只剩 1 个则开该节点配置栏 |
| 点空白（无 Shift） | 清空选择，关栏 |
| 拖选中集合中任一节点 | 整组平移；16px 网格仍开 |
| 单击边 | 不进入本轮多选集合（不框选边） |

只读页：可选中、可框选查看高亮；`nodesDraggable={false}`；`deleteKeyCode={[]}`。

## 5. 组拖钳制

现状：每个节点的 `position` change 各自 `clampDragToCanvas`，多选时节点会在边缘被单独夹住，相对布局散开。

改为：

1. 收集本批 `type === 'position' && dragging` 且属于选中集合的 change。
2. 对每个节点算出「未钳」目标位与「钳后」目标位的差值。
3. 取使整组仍全部留在画布内的**同一位移**（各轴取最紧的那个限制）。
4. 把该位移应用到每一个被拖节点。

松手后仍走现有 `syncChange` / `refreshEdges`。

## 6. 删除

- 画布焦点下 Delete / Backspace：删除所有 `selected` 节点，以及 `source`/`target` 落在这些 id 上的边（含 loop 回边）。
- 配置栏「删除节点」仍只删栏里那一个。
- 无确认框。
- `onChange` 形状与现在单删相同（`fromFlowNodes` / `fromFlowEdges`）。
- 代码片段编辑器（含放大层）有焦点时，Delete 只编辑文本，不删画布节点。实现：画布 `deleteKeyCode` 在可编辑焦点（`input` / `textarea` / `[contenteditable]` / CodeMirror `.cm-editor` / `.cm-content`）内不生效，或仅在画布容器 focus 时生效。

## 7. 与现有行为的对齐

- 「添加节点」后仍单选新节点并开栏。
- 自动排布、适配视图、小地图不因多选改变。
- 面板宽度、网格、缩放范围不变。
- 后端与保存协议不变。

## 8. 测试

无前端单测框架；手工验收：

1. Shift 框选多个 → 拖其中一个，其余跟着动，网格对齐，相对位置不变。
2. 把整组拖向画布边缘：整组停下，不被逐个夹扁。
3. Shift/Cmd/Ctrl 点选加减；普通单击恢复单选并开栏。
4. 多选后 Delete：节点和相关边消失；保存再打开仍然没有。
5. 点空白清空并关栏；左键空拖仍平移。
6. 只读版本页：能高亮，不能拖，Delete 无效。
7. 代码节点放大编辑时，编辑器内 Delete 只删字符。
