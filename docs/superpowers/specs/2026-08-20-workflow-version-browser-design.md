# 工作流版本浏览页 — 设计文档

- 日期：2026-08-20
- 状态：草案
- 相关代码：
  - 既有 API：`GET/POST /api/admin/workflows/:id/versions`（`src/workflow_handlers.rs`）
  - 既有抽屉：`frontend-nextjs/components/workflow/WorkflowsManager.tsx`
  - 画布：`frontend-nextjs/components/workflow/WorkflowCanvas.tsx`
  - 工作区 Tab：`frontend-nextjs/lib/workspaceTabs.ts`、`KeepAliveOutlet.tsx`

## 1. 背景与目标

工作流每次保存都会写入 `management.workflow_versions` 快照。查看某版内容目前只能在编辑器「版本历史」抽屉里展开 JSON，没有可分享、可收藏的页面，也不能用画布看历史图。

**目标**：为每个工作流提供独立的版本浏览路由——左侧版本列表、右侧只读画布 + JSON，并可从该页把某历史版恢复为当前定义。

### 已确认需求

1. **路由形态（方案 A）**：每个工作流一条版本历史页，再点进某个版本。
2. **展示**：只读画布 + 可展开 JSON。
3. **恢复**：详情页可以对非最新版执行恢复。
4. **旧抽屉**：保留快捷入口，并加「在页面中打开」。
5. **布局**：主从一页，切版本只换 URL 和右侧内容。

### 非目标（YAGNI）

- 不新增后端 API、migration、权限模型。
- 不做版本与版本的可视化 diff / 并排对比。
- 不做跨工作流的项目级版本总览。
- 不把编辑器改成路径型 `/workflows/:id`（编辑器仍用 `?workflowId=`）。
- 不在侧栏增加新导航项。
- 不在版本页调试运行、编辑或保存。

## 2. 架构总览

纯前端页面 + 画布只读能力；读写全部走现有 admin API。

```
入口                              版本浏览页
  │                                 │
  │ 列表行菜单「版本历史」            │ GET /api/admin/workflows/:id
  │ 抽屉「在页面中打开」              │ GET /api/admin/workflows/:id/versions
  ▼                                 ▼
/workspace/:pid/automation/     左侧列表
  workflows/:id/versions              │
                                      │ 选中 vN
                                      ▼
/workspace/:pid/automation/     GET .../versions/:version
  workflows/:id/versions/:n         右侧只读画布 + JSON
                                      │
                                      │ 恢复（非最新）
                                      ▼
                                POST .../versions/:n/restore
                                刷新列表，人仍停在 vN
```

### 组件边界

| 单元 | 职责 | 依赖 |
|------|------|------|
| `versions/page.tsx` 与 `versions/[version]/page.tsx` | 权限门槛、把 params 交给壳 | 与工作流页相同的 `canManageEvents` |
| `WorkflowVersionBrowser` | 拉列表/详情、选中态、恢复、顶栏 | 现有 admin API |
| `WorkflowVersionList` | 左侧列表 UI | 列表 JSON |
| `WorkflowVersionCanvas` | 右侧：元信息 + 只读画布 + JSON | `WorkflowCanvas readOnly` |
| `WorkflowCanvas` / `NodeConfigPanel` | 新增 `readOnly`，默认 false | 编辑器调用处不传即保持原行为 |
| 抽屉 / `RowMenu` | 抽屉保留查看 JSON / 恢复；两者都增加跳到新路由的链接 | `projectId` + `workflowId` |

不把浏览逻辑继续堆进 `WorkflowsManager`。

URL 构造单一来源（避免抽屉、列表、浏览器各写一串）：

```ts
function workflowVersionsPath(projectId: number, workflowId: number, version?: number): string
// /workspace/{projectId}/automation/workflows/{workflowId}/versions
// /workspace/{projectId}/automation/workflows/{workflowId}/versions/{version}
```

## 3. 路由与工作区 Tab

### 3.1 路径

```
/workspace/{projectId}/automation/workflows/{workflowId}/versions
/workspace/{projectId}/automation/workflows/{workflowId}/versions/{version}
```

- `workflowId`：`management.workflows.id`（正整数），与现有 `GET /api/admin/workflows/:id` 一致，不用 slug。
- `version`：该工作流的版本号（正整数），与 `GET .../versions/:version` 一致。
- 现有 `/automation/workflows`（含 `?workflowId=`）不变。

两个 page 文件都渲染同一个 `WorkflowVersionBrowser`：无 `:version` 时右侧空状态；有则拉详情。

### 3.2 权限

与工作流页相同，在 page 层拦截：

| 场景 | 行为 |
|------|------|
| 未登录 | 现有 `middleware` → `/login?next=原 URL` |
| 已登录非 admin+ | `ForbiddenPlaceholder`（工作流需要 admin+） |
| admin+ 但工作流不存在 / 无权限 | 整页错误（见 §6），不渲染空画布 |
| 工作流存在但版本号不存在 | 左侧列表仍可用，右侧「版本不存在」 |

### 3.3 Tab 与 KeepAlive（同一工作流共用一个 Tab）

工作区 Tab 和 `KeepAliveOutlet` 默认按**完整 relPath** 去重/缓存。若不处理，每个版本号会新开 Tab，且 KeepAlive 会冻住第一次的 `children`，切版本后画布不更新。

约定（只对这一族路径，不做通用 Tab 分组框架）：

1. **Tab 身份**：`/automation/workflows/:id/versions` 与 `/automation/workflows/:id/versions/:n` 视为同一 Tab。
2. **Tab.path**：存当前完整 relPath。切版本时 **替换** 该 Tab 的 path，不新增。点 Tab 回到正在看的那一版（若在列表则为列表 URL）。
3. **标题**：`工作流版本`，图标 `fas fa-clock-rotate-left`。`resolveNavMeta` 对这族路径特殊匹配，避免前缀命中成「工作流」而和编辑器 Tab 撞名。
4. **KeepAlive**：这族路径的 cache key 用 Tab 身份（canonical `/.../versions`）。**每次 URL 变化都用最新 `children` 覆盖缓存**（版本页没有未保存草稿要保活；切版本必须换数据）。关闭该 Tab 时卸载。
5. 编辑器 Tab（`/automation/workflows`）与版本浏览 Tab 独立，可并排。

`tabIdentity(relPath)` 只识别：

```
^/automation/workflows/\d+/versions(?:/\d+)?$
```

实现落点：`workspaceTabs.openTab` 用 `tabIdentity` 查找并替换已有 Tab；`KeepAliveOutlet` 用 `tabIdentity(currentPath)` 作 cache key，且对这族路径每次覆盖 children。`layout.tsx` 仍 `openTab({ path: relPath, ... })`，不必改调用方式。其它路径行为不变。

版本浏览页**不**要求项目已绑定主数据库（只读快照）。这与工作流编辑页「无 database_id 则无法管理」不同。

## 4. 页面结构

全高主从布局。

**顶栏**

- 工作流名称 + slug（来自 `GET /api/admin/workflows/:id`）。
- 「打开编辑器」→ `/workspace/:pid/automation/workflows?workflowId=:id`（现有深链）。
- 已选中且非最新时：「恢复到此版本」。

**左侧 `WorkflowVersionList`**

- 数据：`GET /api/admin/workflows/:id/versions?limit=200`（后端上限 200）。现有接口的 `total` 等于本次返回条数，不是全库总数；因此 **当返回恰好 200 条时** 在列表底部提示「仅显示最近 200 个版本」，不做分页。
- 每项：`v{version}`、最新标（列表中 `version` 最大的一条）、`node_count`、`note`、作者名、时间。
- 点击：`router.replace` 到该版 URL（不堆历史）。再点已选中项不重复请求。
- 无版本：空状态「暂无版本记录」。

**右侧**

- 未选版本：空状态「选择一个版本以查看内容」。
- 已选版本：`WorkflowVersionCanvas`
  - 元信息：name、slug、trigger_type、note、作者、时间、timeout_ms、max_retries。
  - 只读画布。
  - 默认可折叠的 JSON：`nodes`、`edges`、`trigger_config`（同属快照定义，默认折叠）。

## 5. 只读画布与恢复

### 5.1 `WorkflowCanvas` / `NodeConfigPanel` 的 `readOnly`

新增可选 `readOnly?: boolean`，默认 `false`。编辑器不传，行为不变。`readOnly` 时 `onChange` 可省略（不调用）。

只读开启时：

- 不显示「添加节点」；不允许连线、拖拽改位置、Delete/Backspace 删除、自动排布。
- 缩放、适配视图、概览图可用。
- 点击节点仍打开 `NodeConfigPanel`；面板内控件禁用（用 `fieldset disabled` 或等价方式，避免漏改某个 input），隐藏删除 / 重命名分支。
- 不把只读预览里的位置写回任何 API。

### 5.2 恢复

- 仅当已选版本且它不是列表中 version 最大的一条时显示按钮（与抽屉「非最新才恢复」一致）。
- 确认文案与现有抽屉一致：覆盖当前定义；未保存改动丢失；恢复会作为新版本记录，可再回滚。
- `POST /api/admin/workflows/:id/versions/:version/restore`。
- 成功：toast 成功并提示可「打开编辑器」看当前定义；再 `GET .../versions` 刷新列表（顶上出现 note 为「恢复自 vN」的新版本）。**人仍停在刚恢复的那一版**，不跳转、不自动打开编辑器。
- 失败：展示后端 `error`，列表和画布不变。

恢复语义沿用后端：只写回定义字段，不动 `is_enabled` / `database_id` / `tenant_id`；历史 append-only。

## 6. 数据流与错误处理

1. 进页：并行 `GET /api/admin/workflows/:id` 与 `GET .../versions?limit=200`。
2. URL 含合法 `:version`：再 `GET .../versions/:version`，结果交给只读画布。
3. 切版本：只重拉详情；列表不重拉（除非刚恢复成功）。
4. 不新增后端接口。

| 失败 | UI |
|------|----|
| 工作流 404 / 403 / 网络失败 | 整页说明 + 重试；无左侧空列表冒充成功 |
| 版本 404 | 左侧仍在，右侧「版本不存在」 |
| 列表失败、详情成功（少见） | 左侧错误 + 重试；右侧若已有数据可保留 |
| 详情失败 | 右侧错误 + 重试，不整页炸掉 |
| 恢复失败 | toast/alert 显示 `error`，视图不变 |
| `:workflowId` / `:version` 非正整数 | 与 404 相同处理，不发无意义请求 |

加载中：对应区域 skeleton/spinner，不闪空画布。

## 7. 现有入口改动

**版本历史抽屉（保留）**

- 标题旁「在页面中打开」→ 该工作流的版本列表 URL。
- 每一行增加链到该版 URL（可与「查看」并列；「查看」仍展开抽屉内 JSON，「恢复」仍在抽屉内可用）。

**工作流列表 `RowMenu`**

- 「导出」上方增加「版本历史」，跳到该行工作流的版本列表 URL。
- 回调名用 `onOpenVersionHistory`（避免和编辑器顶栏打开抽屉的 `onShowVersions` 混用）→ `WorkflowListView` / `WorkflowRow` / Card → `WorkflowsManager` 里 `router.push`。
- `projectId` 缺失时不渲染该菜单项（当前唯一入口会传入 `projectId`）。

不改侧栏 NAV。

## 8. 主要改动面

| 文件 | 改动 |
|------|------|
| `app/workspace/[projectId]/automation/workflows/[workflowId]/versions/page.tsx` | 新建，列表态 |
| `.../versions/[version]/page.tsx` | 新建，选中态 |
| `components/workflow/version/*` | Browser / List / Canvas |
| `WorkflowCanvas.tsx` / `NodeConfigPanel.tsx` | `readOnly` |
| `WorkflowsManager.tsx` | 抽屉增加打开页面链接；列表菜单回调 |
| `list/RowMenu.tsx` 及 Row/Card 透传 | 「版本历史」菜单项 |
| `workspaceNav.ts` | 版本路径标题「工作流版本」 |
| `workspaceTabs.ts` / `KeepAliveOutlet.tsx` | §3.3：`openTab` 按身份替换 Tab；KeepAlive 对版本族路径不冻结 children |

**后端：无改动。**

## 9. 测试要点

仓库目前无前端单测套件；按工作流分享链接 spec 的方式做手动验收：

- 未登录打开版本 URL → 登录后回到原 URL。
- 非 admin+ → Forbidden，不泄露节点内容。
- 有版本时左侧按 version 降序；最新有标且无恢复按钮。
- 选中版本：地址栏变为 `.../versions/{n}`，画布为该快照，无「添加节点」；点节点可看只读配置。
- JSON 折叠块含 nodes / edges / trigger_config。
- 非法 version → 右侧「版本不存在」，左侧仍在。
- 恢复非最新版 → 列表顶部新版本 note 为「恢复自 vN」；仍停在原 version URL。
- 抽屉「在页面中打开」与列表「版本历史」进入同一套路由。
- 同一工作流切 v2 → v5 不新开 Tab；编辑器 Tab 与版本 Tab 可并存。
- 编辑器保存/连线/删除在非 `readOnly` 下行为与改前一致。
