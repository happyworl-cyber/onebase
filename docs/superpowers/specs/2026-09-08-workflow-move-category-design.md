# 工作流移动到分类 — 设计文档

- 日期：2026-09-08
- 状态：已通过
- 范围：列表页把一条或多条工作流改到另一个服务 / 分类；扩展现有批量接口。
- 相关代码：
  - `src/workflow_handlers.rs`（`batch_workflows` / `BatchWorkflowRequest`）
  - `src/workflow_taxonomy.rs`（`normalize_for_storage`）
  - `frontend-nextjs/components/workflow/list/WorkflowBatchBar.tsx`
  - `frontend-nextjs/components/workflow/list/WorkflowBatchModals.tsx`
  - `frontend-nextjs/components/workflow/list/RowMenu.tsx`
  - `frontend-nextjs/components/workflow/list/batchApi.ts`
  - `frontend-nextjs/components/workflow/list/FolderTree.tsx`（只读选项来源，不改拖拽）
- 关联：现有分类文件夹拖到服务（`onMoveCategory`）不动。

## 1. 背景与目标

列表已有勾选和底部批量栏（导出 / 改状态 / 删除）。侧边栏能把**整个分类文件夹**拖到另一个服务。缺的是把**工作流**换到别的分类。

**目标**

1. 行菜单「移动」、批量栏「移动」打开同一张弹窗。
2. 可跨服务：先选服务，再选该服务下已有分类（含未分类）。
3. 一次请求移动最多 500 条；权限与失败明细沿用现有 batch。

### 已确认需求

| 项 | 结论 |
|---|---|
| 目标范围 | 跨服务：服务 → 分类 |
| 交互 | 只要弹窗，不把工作流行拖到侧边栏 |
| 分类来源 | 只选侧边栏已有项（含未分类、空的自定义文件夹） |
| 新建分类 | 不在弹窗里建；先在侧边栏建 |

### 非目标

- 拖工作流行到侧边栏。
- 弹窗内新建服务或分类。
- 新开 `/workflows/move` 路由。
- 移动产生版本快照。
- 新 MCP 工具（单条改 `department`/`category` 已有 `update_workflow`）。
- 改「拖分类到服务」的现有手势。

## 2. 关键决定

| 项 | 结论 | 理由 |
|---|---|---|
| API | `POST /api/admin/workflows/batch` 增加 `action: "move"` | 与 enable/delete 同一套权限、上限、`failed[]` |
| 单条 | `ids` 长度为 1，走同一接口 | 行菜单不必再调 PATCH |
| 入库 | `workflow_taxonomy::normalize_for_storage` | 未分类写成「共享 / 未分类」规范值 |
| 版本 | 不写 `workflow_versions` | 纯 taxonomy 元信息，与启用/改分类 PATCH 一致 |
| 确认 | 弹窗本身即确认，无第二层 | 不是删除 |
| 成功后 | 停在当前文件夹，刷新列表与 summary | 移走的行从本页消失，目标计数增加 |

## 3. 后端

### 3.1 请求

现有：

```json
{ "action": "enable|disable|delete", "ids": [1, 2] }
```

`move` 时额外必填：

```json
{
  "action": "move",
  "ids": [1, 2],
  "department": "共享",
  "category": "基础运维"
}
```

- `department` / `category`：字符串。空、缺省或字面「未分类」交给 `normalize_for_storage`（部门缺省 →「共享」，分类缺省 →「未分类」）。
- `action` 不是 `enable|disable|delete|move` → 400。
- `move` 缺少可用于归一的目标（例如 JSON 里完全没有这两个字段）→ 400，文案：`move 需要 department 与 category`。允许显式传空串，按未分类归一。
- `ids` 空或超过 500：与现有 batch 相同错误。

### 3.2 执行

1. 去重 `ids`，查出工作流，逐条 `require_admin_for_workflow`（与 enable 相同）。
2. 对有权限的行：`UPDATE management.workflows SET department = $1, category = $2, updated_at = NOW() WHERE id = ANY($3)`。
3. 已在目标 taxonomy 的行仍算成功（幂等），不写误导性的「X→X」操作日志。
4. 操作日志：`UPDATE`，「移动工作流「{name}」（批量）」；`change` 含旧/新 `department`、`category`（仅当确有变化）。
5. 响应形状不变：`action`、`total`、`succeeded`、`succeeded_count`、`failed`、`failed_count`。`action` 为 `"move"`。

不改节点、不改 slug、不改 `is_enabled`。

## 4. 前端

### 4.1 入口

- `RowMenu`：删除分隔线上方加「移动」（图标 `fa-folder-tree` 或 `fa-arrow-right`）。
- `WorkflowBatchBar`：在「修改状态」与「删除」之间加「移动」。
- `BatchModalType` 增加 `'move'`。单条移动也打开同一 modal，`workflows` 长度为 1。

### 4.2 弹窗

复用 `WorkflowBatchModals` 的 overlay / 头栏风格。

- 标题：1 条 →「移动工作流」；N 条 →「移动 N 个工作流」。
- 下拉 1：服务。选项 = 当前侧边栏第一级（来自 `summaryGroups` + `customFolders` 的部门名，去重排序）。
- 下拉 2：分类。选项 = 所选服务下已有分类名，**必须包含「未分类」**，再加上该服务下空的自定义分类文件夹。
- 默认选中：第一条被选工作流当前的服务 / 分类；批量混源时默认当前侧边栏选中的服务（若在某分类下），否则「共享 / 未分类」。
- 目标与**所有**选中工作流的现 taxonomy 都相同：主按钮可点，提交前 toast「已在该分类」并关闭，不请求。
- 主按钮「移动」；进行中禁用。成功 toast「已移动 N 个工作流」；部分失败沿用批量删除/改状态的「成功 x / 失败 y」提示。
- `onComplete`：关弹窗、清勾选、重新拉列表与 summary。

### 4.3 API 封装

`batchApi.ts`：`BatchWorkflowAction` 加上 `'move'`；新增

```ts
batchMoveWorkflows(ids: number[], department: string, category: string)
```

POST body 带 `department`、`category`。

## 5. 测试

**后端**

- `move` 缺少目标字段 → 400。
- 合法 move：department/category 更新，`normalize` 后未分类为「共享」+「未分类」。
- 无管理员权限的 id 进 `failed`，有权限的仍成功。
- 已在目标分类：`succeeded` 含该 id，不写「X→X」日志（可用现有 record 辅助测或断言 change 为 None）。
- `enable`/`disable`/`delete` 回归：未传 department 仍可用。

**前端**

- 无单测 runner：目测行菜单与批量栏有「移动」；弹窗两级下拉来自侧边栏；成功后当前文件夹列表少了被移走行，目标分类计数增加。

## 6. 以后（不在本期）

- 勾选后拖到侧边栏分类。
- 弹窗内新建分类。
