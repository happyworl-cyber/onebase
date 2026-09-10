# 工作流服务 / 分类改名 — 设计文档

- 日期：2026-09-09
- 状态：已通过
- 范围：侧边栏服务（一级）和分类（二级）支持改名；有工作流时同步改归属字段。
- 相关代码：
  - `src/workflow_folder_handlers.rs`（已有 `PATCH` 改 `name`）
  - `frontend-nextjs/components/workflow/list/FolderTree.tsx`
  - `frontend-nextjs/components/workflow/list/NewFolderDialog.tsx`
  - `frontend-nextjs/components/workflow/list/WorkflowListView.tsx`
  - `frontend-nextjs/components/workflow/list/folderApi.ts`
  - `frontend-nextjs/components/workflow/WorkflowsManager.tsx`（有工作流时逐条 PATCH，复用移动分类套路）
- 关联：`docs/superpowers/specs/2026-09-08-workflow-move-category-design.md`（工作流归属是字符串，不是文件夹 id）

## 1. 背景与目标

侧边栏已能新建、删除、把分类拖到另一服务。悬停只有加号和删除，没有改名。后端 `PATCH /api/admin/workflow-folders/:id` 已接受 `name`，前端没入口。

工作流用 `department` / `category` 字符串归属；树节点 id 由名字算出（`dept:服务名`、`cat:服务名/分类名`）。只改文件夹行、不改工作流，归属会断。

**目标**

1. 服务和分类都能改名。
2. 「共享」「未分类」「全部工作流」不能改。
3. 有工作流时同步改它们的 `department` / `category`。
4. 改名后当前选中 / 展开 / 记住的文件夹 id 换成新 id。

### 已确认需求

| 项 | 结论 |
|---|---|
| 范围 | 服务 + 分类（A） |
| 入口 | 悬停铅笔 + 弹窗，不用行内编辑 |
| 保留名 | 「共享」「未分类」无铅笔，也不能改成这两个名字 |
| 有工作流 | 弹窗提示「将同步更新 N 个工作流的归属」，不再单独确认 |
| 部分失败 | 不回滚；刷新后以落库为准，可再改一次 |

### 非目标

- 行内编辑、双击改名。
- 新开批量改名 API（沿用逐条 `PATCH /api/admin/workflows/:id`）。
- 改「共享」或「未分类」。
- 改文件夹时写工作流版本快照。
- 新 MCP 工具。

## 2. 关键决定

| 项 | 结论 | 理由 |
|---|---|---|
| 文件夹 API | 现有 `PATCH /api/admin/workflow-folders/:id` `{ name }` | 已实现 trim / 空名 / `/` / 64 字 / 同级唯一 |
| 工作流 API | 先按旧名查出，再逐条 PATCH `department` 和/或 `category` | 与拖分类到服务的 `handleMoveCategory` 相同 |
| 树 id | 仍由名字派生；成功后重映射选中/展开/saved | 不改 id 方案 |
| 弹窗 | 扩展 `NewFolderDialog` 为创建/重命名两种模式 | 校验与新建同一套 |
| 本地空文件夹 | 无 `server_id` 时只改本地列表 | 与创建/删除的本地分支一致 |

## 3. 前端

### 3.1 入口

`FolderTree` 在加号与删除之间加铅笔（`fa-pencil`），`title` 为「重命名」。

出现条件：非根节点，且不是「共享」服务、不是「未分类」分类。服务和分类都显示。

点击 `stopPropagation`，调用 `onRenameFolder(folderId)`。

### 3.2 弹窗

扩展 `NewFolderDialog`（或同文件改名为可复用的名称弹窗）：

- 标题：`重命名服务` / `重命名分类`
- 输入框预填当前名，提交时 trim
- 名称未变：关弹窗，不请求
- 空、含 `/`、超过 64 字：不提交（与后端 `trim_name` 一致）
- 改成「共享」或「未分类」：拦截并提示
- 同级已有同名：前端先拦
- 有工作流：说明「将同步更新 N 个工作流的归属」

### 3.3 提交顺序

1. 已落库的文件夹：`PATCH /api/admin/workflow-folders/:id` `{ name }`。本地空文件夹改本地列表。
2. 若有工作流：按**旧**服务/分类查出列表，逐条 PATCH。改分类只改 `category`；改服务只改 `department`（分类名不变）。
3. 刷新文件夹树、summary、列表。
4. 若当前 `folderId` 是被改节点，或是该服务下的分类（服务改名时子分类 id 会变），把 `folderId`、`expanded`、`savedFolderId` 换成新 id。

`folderApi.ts` 增加 `renameApiFolder(serverId, name)`。

### 3.4 失败

任一步失败：toast 报错，刷新树和列表。不做事务回滚。文件夹已改名而部分工作流仍是旧名时，用户可再改一次或手工修。

## 4. 后端

本期不改路由。`update_workflow_folder` 已支持改 `name`。

补测试（现无文件夹 handler 单测）：

- 改名成功，`updated_at` 变化
- 同级重名 → `InvalidQuery`（唯一约束 `idx_workflow_folders_unique_name`）
- 空名、含 `/`、超过 64 字 → 与创建相同错误

不在本期加「禁止把共享/未分类改名」的后端硬拦；前端不给入口。若以后要防 API 直调，另开任务。

## 5. 测试

**前端（`utils` / 纯函数）**

- 新 id：`dept:旧` → `dept:新`；其子分类 `cat:旧/X` → `cat:新/X`
- 可改名：普通服务/分类为 true；根、「共享」、「未分类」为 false
- 同级重名、保留名校验失败

**后端**

- 见 §4。若现有测试基建不便挂 handler，至少抽 `trim_name` 与唯一约束路径可测的部分。

**目测**

- 悬停「gm管理后台预发」有铅笔；「共享」「未分类」没有
- 空分类改名后树和面包屑更新
- 有工作流的分类改名后，工作流仍在该节点下，计数不变

## 6. 以后（不在本期）

- 行内编辑 / 双击改名
- 文件夹改名与工作流归属同一事务
- 后端禁止改「共享」「未分类」
