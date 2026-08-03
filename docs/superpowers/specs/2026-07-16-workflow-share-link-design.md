# 工作流分享链接（登录深链）— 设计文档

- 日期：2026-07-16
- 状态：已实现
- 相关代码：
  - `frontend-nextjs/app/workspace/[projectId]/automation/workflows/page.tsx`
  - `frontend-nextjs/components/workflow/WorkflowsManager.tsx`
  - `frontend-nextjs/components/workflow/WorkflowEditorHeader.tsx`
  - `frontend-nextjs/components/workflow/list/WorkflowListView.tsx`
  - `frontend-nextjs/components/workflow/list/RowMenu.tsx`
  - 既有鉴权：`frontend-nextjs/middleware.ts`、`GET /api/admin/workflows/:id`

## 1. 背景与目标

工作流详情目前只在 `WorkflowsManager` 组件内用 `view: 'list' | 'editor'` 切换，**URL 不随打开的工作流变化**，无法把「某个工作流详情」发给同事。

已有能力「接口文档公开分享」（`/doc/[token]`，**无需登录**）解决的是对外文档；本次要解决的是**团队内协作入口**：拿到链接的人必须登录，且按现有项目/工作流权限才能打开。

**目标**：提供可复制的分享链接；对方登录后打开即进入该工作流详情（编辑器）。不引入新的分享权限模型。

### 已确认需求

1. **链接形态**：`/workspace/{projectId}/automation/workflows?workflowId={id}`（查询参数深链，无独立 token）。
2. **权限**：不单独配置分享权限；与现有一致——未登录跳登录；进页需 `canManageEvents`（admin+）；拉取详情走现有 `GET /api/admin/workflows/:id` 成员校验。
3. **入口**：列表行菜单 + 编辑器顶栏均可「复制分享链接」。
4. **打开后**：进入工作流详情（与列表点「编辑」相同的编辑器态）。

### 非目标（YAGNI）

- 不新增后端 API、migration、分享 token、撤销开关。
- 不改变现有角色门槛（工作流页仍为 admin+）。
- 不替代、不合并「文档公开分享」（`ShareDocButton` / `/doc/...`）。
- 不做路径型路由 `/workflows/[id]`（本次明确采用 query 方案）。
- 不做访问统计、过期时间、密码保护。

## 2. 架构总览

纯前端能力：URL 深链 + 复制链接；鉴权全部复用现有中间件与 admin API。

```
分享者                          接收者
  │                               │
  │ 复制                          │ 打开链接
  │ /workspace/{pid}/automation/  │
  │   workflows?workflowId={id}   │
  ▼                               ▼
列表菜单 / 编辑器顶栏          middleware：无 cookie → /login?next=原 URL
                                      │
                                      ▼ 登录后回链
                               workflows page：canManageEvents？
                                      │ 否 → Forbidden
                                      ▼ 是
                               WorkflowsManager 读 workflowId
                                      │
                                      ▼ GET /api/admin/workflows/:id
                               成功 → openEditor(wf)
                               失败 → toast，留在列表，清掉 query
```

## 3. URL 与打开行为

### 3.1 格式

```
{origin}/workspace/{projectId}/automation/workflows?workflowId={id}
```

- `projectId`：工作区租户/项目 ID（与现有 workspace 路由一致）。
- `workflowId`：`management.workflows.id`。

### 3.2 消费（进入详情）

在 `WorkflowsManager` 挂载（或 searchParams 变化）时：

1. 解析 `workflowId`；非合法正整数则忽略。
2. 用 ref 记录「已尝试消费的 id」，避免同一会话重复自动打开。
3. `GET /api/admin/workflows/:id`：
   - 成功：调用与列表编辑相同的 `openEditor(workflow)`。
   - 失败：`showToast` 提示（无权限 / 不存在 / 网络错误），`router.replace` 去掉 `workflowId`，留在列表。

### 3.3 URL 同步

使用 `router.replace`（不堆叠历史），只增删 `workflowId`，保留其它 query（若有）：

| 操作 | URL |
|------|-----|
| 打开已有工作流详情 | 写入 `workflowId` |
| 新建（尚无 id） | 去掉 `workflowId` |
| 返回列表 / 关闭编辑器 | 去掉 `workflowId` |
| 新建保存成功得到 id | 写入新 `workflowId` |

保证：用户在详情页点「复制分享链接」时，剪贴板内容与地址栏语义一致。

### 3.4 鉴权边界（复用，不新做）

| 场景 | 行为 |
|------|------|
| 未登录 | `middleware` → `/login?next=...` |
| 已登录非 admin+ | 页级 `canManageEvents` → `ForbiddenPlaceholder` |
| admin+ 但无该工作流权限 / ID 无效 | API 失败 → toast + 列表 |

## 4. 复制分享链接 UI

### 4.1 链接生成

```ts
const url = `${window.location.origin}/workspace/${projectId}/automation/workflows?workflowId=${id}`
```

`projectId`：由页面 `useParams` 取得后传入 `WorkflowsManager`，或组件内 `useParams`（实现任选其一，保持单一来源）。

复制：复用 `WorkflowEditorHeader` 已有的 `copyTextToClipboard`（可抽到小 util，避免两处复制逻辑漂移）。成功 toast「链接已复制」，失败提示用户手动复制。

### 4.2 列表

- `RowMenu`：在「导出」上方增加「分享链接」（如 `fa-link`）。
- 回调链：`onShare` → `WorkflowListView` → `WorkflowsManager`。

### 4.3 编辑器顶栏

- `WorkflowEditorHeader`：在「导出」旁增加「分享链接」。
- **仅当 `editing?.id` 存在时显示**（未保存的新建不可分享）。
- 文案与「分享文档」区分：本功能用「分享链接」；文档分享 UI 保持原样。

### 4.4 交互

- 点击只复制，不跳转、不弹窗。
- 列表项均有 id，始终可复制。

## 5. 主要改动面（实现指引）

| 文件 | 改动 |
|------|------|
| `workflows/page.tsx` | 可选：传入 `projectId` |
| `WorkflowsManager.tsx` | 读/同步 `workflowId`；消费深链；`handleShare`；向列表/顶栏传回调 |
| `WorkflowEditorHeader.tsx` | 「分享链接」按钮 |
| `WorkflowListView.tsx` / `RowMenu.tsx`（及 Row/Card 透传） | 「分享链接」菜单项与 `onShare` |

**后端：无改动。**

## 6. 错误处理与测试要点

- 未登录打开分享链接 → 登录后应回到带 `workflowId` 的原 URL 并自动进详情。
- 无页面权限 → Forbidden，不泄露工作流内容。
- 无效 / 无权限的 `workflowId` → toast，列表可用，URL 已清理。
- 打开详情后地址栏含 `workflowId`；返回列表后 query 清除。
- 列表与编辑器复制的链接可被有权限用户打开进同一工作流。
- 与「分享文档」并存，互不影响。

## 7. 与文档公开分享的关系

| | 本次（分享链接） | 文档公开分享 |
|--|------------------|--------------|
| URL | `/workspace/.../workflows?workflowId=` | `/doc/{token}` |
| 登录 | 必须 | 不需要 |
| 权限 | 现有 admin+ / 成员 API | 仅 `doc_share_enabled` |
| 内容 | 工作流详情（编辑器） | 接口文档只读页 |
| 后端 | 无新接口 | `doc-share` + public API |
