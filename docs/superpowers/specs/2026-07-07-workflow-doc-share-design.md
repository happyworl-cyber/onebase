# 工作流接口文档 · 公开分享 — 设计文档

- 日期：2026-07-07
- 状态：待评审
- 相关代码：`frontend-nextjs/components/workflow/WorkflowsManager.tsx`（`WorkflowDocModal`）、`src/workflow_handlers.rs`、`src/mcp_tools.rs`、`src/main.rs`

## 1. 背景与目标

工作流编辑器有一个「接口文档」弹窗（`WorkflowDocModal`），展示该工作流作为 HTTP endpoint 被调用的方式：调用地址、鉴权说明、入参字段、curl 示例、返回值。当前该文档**完全在前端根据内存中的工作流定义（nodes/meta/slug）实时推导生成**，没有持久化标识，也无法给未登录的人查看。

**目标**：让工作流作者能生成一个**公开链接**，把这份接口文档直接发给他人；对方**无需登录**即可打开查看（只读），且内容**实时**反映工作流最新定义，链接**可随时撤销**。

### 明确的需求边界（已与用户确认）

1. 分享形式：生成公开链接（形如 `<origin>/doc/<token>`），对方打开即可查看，无需登录。
2. 页面能力：**只读文档**，内容与现有 Modal 一致（调用地址、鉴权说明、入参、curl 示例、返回值），支持「复制全部 Markdown」。不提供在线调试台。
3. 内容新鲜度：**实时**，总是反映工作流当前定义（后端每次实时推导）。
4. 生命周期：**可撤销**（可开关）。关闭后链接立即失效（404）。不需要过期时间；不需要「重新生成 token」能力（关闭再开启复用同一 token）。

### 非目标（YAGNI）

- 不做在线调试 / try-it 控制台。
- 不做过期时间、多链接、访问统计、密码保护。
- 不做文档快照（明确要实时）。
- 不改动现有工作流触发（`/workflow/...`、`/pub/workflow/...`）与鉴权逻辑。

## 2. 架构总览

核心思想：**文档「排版渲染」只有一份（前端组件），文档「数据推导」两端各一份，通过一个中间数据模型 `DocModel` 对接。**

```
                       ┌─────────────────────────────┐
  登录态 Modal          │  <WorkflowDocContent          │
  (nodes 在内存)  ──推导─▶│    docModel: DocModel />      │──渲染──▶ 只读文档 UI + 复制 Markdown
                       │  （唯一的排版/文案来源）        │
  公开页面 /doc/[token] │                               │
  (无 nodes) ──HTTP──▶  └─────────────────────────────┘
     GET /api/public/workflow-doc/:token
             │
             ▼ 后端从 nodes 推导 DocModel（复用 scan_trigger_fields 等）
```

- **登录态**：前端沿用现有 `collectTriggerFields` 等逻辑，从 `nodes` 推导出 `DocModel`，喂给 `<WorkflowDocContent>`。
- **公开态**：后端从工作流的 `nodes` 推导出**已提炼**的 `DocModel`（不下发整包 nodes），公开接口返回它；公开页面拿到后喂给同一个 `<WorkflowDocContent>`。

这样公开接口**零暴露节点内部配置**（如 SQL、http_call 的 url），只暴露文档必需的字段。

### DocModel（前后端约定的数据契约）

```ts
interface DocModel {
  name: string
  description: string
  slug: string
  database_slug: string        // 拼调用地址用；无则由前端 fallback（见下）
  trigger_type: string         // endpoint | hook | notify | cron | manual
  trigger_config: Record<string, unknown>
  timeout_ms: number
  input_fields: string[]       // {{trigger.X}} 扫描出的字段名（已去重排序）
  response_body: string | null // response 节点 body 模板（字符串化），无则 null
  status_code: number          // response 节点 status_code，默认 200
  has_response_node: boolean
}
```

> 注：`database_slug` 由后端提供。调用地址的 `base`（origin）由前端按访问来源推导（`window.location.origin`），后端不下发绝对地址，避免把内网地址写死。

## 3. 数据库

新增 migration `migrations/046_workflow_doc_share.sql`，在 `management.workflows` 加两列：

```sql
ALTER TABLE management.workflows
  ADD COLUMN IF NOT EXISTS doc_share_token   VARCHAR(64) UNIQUE,
  ADD COLUMN IF NOT EXISTS doc_share_enabled BOOLEAN NOT NULL DEFAULT false;
```

- 一个工作流对应一条公开链接。
- `doc_share_token`：开启分享时若为空则生成一次（`ds_` 前缀 + 32 字节随机 → hex，长度 < 64），一经生成永久保留。
- `doc_share_enabled`：开关。关闭仅置 `false`（token 保留），重新开启复用同一 token，因此“撤销”后如果再次开启是同一个链接——符合用户「可撤销，不需要重新生成」的选择。
- token 与 API Key（`cr_` / `crp_`）命名空间独立，泄露 token **不泄露任何调用凭证**。

migration 编号 046（当前最大为 045，046 为下一个可用编号；见迁移注册处 `src/migrate.rs`）。

## 4. 后端

### 4.1 复用的推导逻辑

`src/mcp_tools.rs` 已有 `pub fn scan_trigger_fields(nodes: &Value) -> Vec<String>`（与前端 `collectTriggerFields` 同规则）。抽出/复用一个从工作流行构建 `DocModel` 的公共函数，供两处使用：

```
fn build_doc_model(workflow_row, database_slug) -> DocModel
  - input_fields   = scan_trigger_fields(nodes)（去重后排序，与前端 sort 对齐）
  - response 节点  = nodes 中 type == "response" 的第一个
  - response_body  = response.config.body 字符串化（对象→pretty JSON），无则 None
  - status_code    = response.config.status_code，默认 200
  - has_response_node = 是否存在 response 节点
```

放在 `src/workflow_handlers.rs`（或新建 `src/workflow_doc_share.rs`）中，`mcp_tools.rs` 的 `tool_workflow_api_doc` 后续也可改为复用（可选，非本次必须）。

### 4.2 管理接口（登录态，走现有 admin 鉴权）

在现有 admin 工作流路由组（同 `POST /api/admin/workflows/:id/trigger` 所在处，`src/main.rs`）新增：

```
POST /api/admin/workflows/:id/doc-share
  body: { "enabled": bool }
  行为:
    enabled=true  → 若 doc_share_token 为空则生成；置 doc_share_enabled=true
    enabled=false → 置 doc_share_enabled=false（token 保留）
  返回: { "share_token": "ds_...", "share_enabled": true, "share_path": "/doc/ds_..." }
  权限: 复用现有 admin 工作流鉴权（须对该工作流所属 database/tenant 有权限）
```

> 只返回相对路径 `share_path`；完整 URL 由前端拼 `window.location.origin + share_path`。

（可选）在现有工作流详情/列表返回里带上 `doc_share_enabled` 与 `doc_share_token`，供 Modal 打开时展示当前状态。若不改现有接口，则 Modal 首次打开分享面板时调一次「读状态」——为简单起见，直接在 `doc-share` 的 GET 上支持读：

```
GET /api/admin/workflows/:id/doc-share
  返回: { "share_token": "ds_..." | null, "share_enabled": bool, "share_path": string | null }
```

### 4.3 公开接口（无鉴权）

新增一个**不挂 `auth_middleware`** 的路由（参照 `workflow_public_routes` 的挂载方式，`src/main.rs`）：

```
GET /api/public/workflow-doc/:token
  行为:
    - 按 token 查 workflows：WHERE doc_share_token = $1 AND doc_share_enabled = true
    - 命中 → 取 database_slug（tenant_databases.slug）→ build_doc_model → 200 返回 DocModel
    - 未命中 / enabled=false → 404 { "error": "链接不存在或已失效" }
  鉴权: 无（公开）
  返回: DocModel（见 §2），不含 nodes/edges/内部配置
```

路由前缀 `/api/public/` 已被 `next.config.js` 的 `/api/:path*` 规则代理到后端，公开页面同源即可访问。需确认后端 `/api` 路由未被某个全局 `auth_middleware` 覆盖——从现有代码看鉴权是**按 router 组挂载**的，新路由组不挂即为公开。

**限流/防扫**：token 为 32 字节随机，暴力枚举不可行。可选加简单速率限制，非本次必须。

## 5. 前端

### 5.1 抽取共享渲染组件

新增 `frontend-nextjs/components/workflow/WorkflowDocContent.tsx`：

- 导出 `WorkflowDocContent`，props 为 `{ docModel: DocModel; apiBase: string }`（或直接接收派生好的字段）。
- 内容 = 现 `WorkflowDocModal` body（`WorkflowsManager.tsx` 约 684–826 行）的各 `<section>`：调用方式、鉴权、请求参数、请求示例、返回值、其他、速查。
- `docMarkdown` 生成逻辑（现 622–667 行）也移入此组件（或抽为纯函数 `buildDocMarkdown(docModel, url)`），供页面顶部「复制全部 Markdown」使用。
- URL 拼装：`base = apiBase || window.location.origin`，`url = ${base}/workflow/${database_slug}/${slug}`。

新增/调整 `DocModel` 的前端派生函数 `deriveDocModel(meta, nodes)`（复用现有 `collectTriggerFields`、response 节点查找逻辑），供登录态 Modal 使用。

### 5.2 瘦身 Modal

`WorkflowDocModal` 改为：弹窗外壳 + 头部（标题、「复制全部 Markdown」、**新增「分享」按钮**）+ body 用 `<WorkflowDocContent docModel={deriveDocModel(meta, nodes)} apiBase={apiBase} />`。渲染结果与现在一致（回归验证点）。

### 5.3 公开页面

新增 `frontend-nextjs/app/doc/[token]/page.tsx`：

- 位于 `workspace` 布局之外，天然免登录（根 `layout.tsx` 不强制鉴权）。
- 客户端组件，挂载后 `fetch('/api/public/workflow-doc/' + token)`。
- 200 → 页面版式（非弹窗）渲染 `<WorkflowDocContent docModel={...} apiBase="" />`，顶部标题 + 「复制全部 Markdown」。
- 404 / 错误 → 友好空状态：「该分享链接不存在或已被关闭」。
- 加载态：简单 loading。
- 该页面不加载需要登录的组件（避免调用鉴权 API 报错）。

> 注意：根 `layout.tsx` 会全局渲染 `AiAssistantPanel`（受 `AI_ASSISTANT_ENABLED` 构建开关控制）。实现时确认它在未登录公开页不会抛错/强制跳转；若有问题，公开页用独立的最小布局规避。

### 5.4 分享按钮交互

在 `WorkflowDocModal` 头部「复制全部 Markdown」旁加「分享」按钮，点开一个轻量弹层（Popover/小面板）：

- 打开分享面板时读当前状态（`GET /api/admin/workflows/:id/doc-share`）。
- 未开启：显示说明 + 「生成公开链接」按钮 → `POST {enabled:true}` → 显示 `origin + share_path` + 复制按钮。
- 已开启：显示链接 + 复制按钮 + 「关闭分享」按钮（`POST {enabled:false}`，链接立即失效）。
- 文案提示：该链接可公开访问、只读、不含任何密钥、可随时关闭。

> Modal 需要拿到当前工作流的 `id`。现有 `WorkflowDocModal` 只接收 `meta/nodes`；需从上层（`WorkflowsManager`）把当前工作流 id 传入（编辑态下应可得）。若为「未保存的新工作流」（无 id），分享按钮置灰并提示「请先保存工作流」。

## 6. 数据流

**生成分享**：Modal 分享面板 → `POST /api/admin/workflows/:id/doc-share {enabled:true}` → 后端生成/启用 token → 返回 `share_path` → 前端拼 `origin + share_path` 展示 + 复制。

**他人访问**：浏览器打开 `<origin>/doc/<token>` → `app/doc/[token]/page.tsx` → `GET /api/public/workflow-doc/:token` → 后端查 workflow（token + enabled）→ `build_doc_model` → 返回 DocModel → `<WorkflowDocContent>` 渲染。

**撤销**：分享面板「关闭分享」→ `POST {enabled:false}` → 后端置 `doc_share_enabled=false` → 后续公开接口返回 404 → 公开页面显示失效提示。

## 7. 错误处理

| 场景 | 行为 |
| --- | --- |
| token 不存在 | 公开接口 404；页面显示「链接不存在或已失效」 |
| 分享已关闭（enabled=false） | 同上 404 |
| 工作流被删除 | token 随行级联删除（`ON DELETE CASCADE`）→ 404 |
| 新工作流未保存（无 id） | 分享按钮置灰，提示先保存 |
| admin 接口无权限 | 复用现有 admin 鉴权错误（401/403） |
| 公开页 network 错误 | 页面显示可重试的错误态 |

## 8. 安全考量

- 公开接口只返回提炼后的 `DocModel`，**不含 nodes/edges 及节点内部配置**（SQL、http url、密钥等一律不出现）。
- 文档暴露的信息与登录态 Modal 一致：调用地址、入参字段名、response body 模板。作者需自行确保 response body 模板不含敏感常量（这与现状一致，非本次新增风险）。
- token 高熵随机，不可枚举；可撤销。
- 公开路由不经过鉴权中间件，须确保它**只能**读文档、无任何副作用、不触发工作流执行。

## 9. 测试策略

**后端**：
- `build_doc_model` 单测：有/无 response 节点、有/无 trigger 字段、status_code 默认值。
- 公开接口集成/脚本测试：enabled=true 命中返回 DocModel；token 错误 404；enabled=false 404；返回体不含 `nodes`。
- admin `doc-share` 接口：开启生成 token、关闭保留 token、重开复用同一 token、无权限拒绝。

**前端**：
- 抽组件后回归：登录态 Modal 渲染结果与重构前一致（各 section 与「复制全部 Markdown」文本）。
- 公开页面：mock 200 渲染文档、404 显示失效态。

**手动验收**：登录生成链接 → 浏览器隐身窗口（未登录）打开链接看到文档 → 关闭分享 → 隐身窗口刷新显示失效。

## 10. 涉及文件清单

新增：
- `migrations/046_workflow_doc_share.sql`
- `frontend-nextjs/components/workflow/WorkflowDocContent.tsx`
- `frontend-nextjs/app/doc/[token]/page.tsx`
- （可选）`src/workflow_doc_share.rs`（或把逻辑放进 `workflow_handlers.rs`）

修改：
- `src/workflow_handlers.rs`：`build_doc_model`、`doc-share` handler、public doc handler
- `src/main.rs`：注册 admin `doc-share` 路由、public `workflow-doc` 路由
- `src/migrate.rs`：注册新 migration
- `frontend-nextjs/components/workflow/WorkflowsManager.tsx`：瘦身 `WorkflowDocModal`、加分享按钮、传入 workflow id
- `frontend-nextjs/lib/api.ts`：分享相关 API 封装（如需要）
