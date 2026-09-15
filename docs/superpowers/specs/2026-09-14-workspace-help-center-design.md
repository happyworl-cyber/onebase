# 工作区使用帮助 — 设计文档

- 日期：2026-09-14
- 状态：已通过
- 范围：项目工作区内一套静态「使用帮助」：侧栏入口、目录首页、9 篇文章。覆盖产品怎么用与 API 怎么调。不接后端。
- 相关代码：
  - `frontend-nextjs/components/workspace/WorkspaceSidebar.tsx`
  - `frontend-nextjs/components/workspace/workspaceNav.ts`
  - `frontend-nextjs/components/workspace/KeepAliveOutlet.tsx`
  - `frontend-nextjs/lib/helpCatalog.ts`（新建）
  - `frontend-nextjs/components/help/`（新建）
  - `frontend-nextjs/app/workspace/[projectId]/help/`（新建）
- 关联：工作区多 Tab `docs/superpowers/specs/2026-07-03-workspace-tabs-design.md`；REST 文档数据源 `frontend-nextjs/components/api/restApiDoc.ts`

## 1. 目标与非目标

项目成员打开工作区后能系统阅读「怎么用 OneBase」，并知道外部系统如何调 REST / RPC / SSE / Webhook。入口在页面上，不依赖仓库里的工程文档。

### 已确认需求

| 项 | 结论 |
|---|---|
| 覆盖 | 产品使用 + API 对接 |
| 形态 | 工作区内独立帮助页：左目录、右文章 |
| 体量 | 精简 9 篇：快速开始 + 7 个侧栏分组各一篇 + API 对接总览 |
| 谁能看 | 仅项目工作区；侧栏底部「使用帮助」；项目成员（工作区壳已校验） |
| 实现 | 目录清单 + React 文章组件；无新依赖 |
| 语言 | 中文；功能名与侧栏 `NAV_GROUPS` 一致 |

### 非目标

- 搜索
- 组织控制台 / 平台控制台 / 未进项目时的帮助
- Markdown / MDX / CMS
- 后端存储或编辑器
- 按角色过滤帮助链接（无权限时由目标页自己的门槛处理）
- 复制现有 REST 完整端点表或工作流节点手册（只链到原页）
- 新建项目向导（入口在工作区外）
- 页内「？」抽屉、首次进入引导、多语言

## 2. 关键决定

| 项 | 结论 | 理由 |
|---|---|---|
| 路由 | `/workspace/:projectId/help` 首页；`/help/:slug` 文章 | 可分享单篇；首页可通览 |
| Tab | 所有帮助 URL 共用身份 `/help`，标题固定「使用帮助」 | 避免 9 篇文章堆 Tab；切篇时换正文 |
| 缓存 | `KeepAliveOutlet` 对帮助路径每次写入新 `children` | 与工作流版本同一套路，否则会卡在第一篇 |
| 入口 | 侧栏底部，不进 `NAV_GROUPS` | 功能导航保持对象分组；帮助是横切入口 |
| 数据 | `helpCatalog.ts` 纯数据；文章组件另册注册 | 测目录不必加载 React；避免循环依赖 |
| 鉴权 | 不单做；走项目 layout | 非成员进不了壳 |
| 未知 slug | 壳仍渲染，右栏空状态 | 不把整个工作区打成 404 |

## 3. 路由、Tab、入口

相对项目 base 的路径：

- `/help` — 目录首页
- `/help/:slug` — 文章。slug 仅来自 catalog（见 §6）

`workspaceNav.ts`：

```ts
export function isHelpPath(relPath: string): boolean {
  return relPath === '/help' || relPath.startsWith('/help/')
}
```

`tabIdentity`：若 `isHelpPath(relPath)` 则返回 `'/help'`。与工作流版本的判断并列、放在默认 `relPath` 回退之前即可；两条路径集合不相交，互不影响。

`resolveNavMeta`：若 `isHelpPath(relPath)` 则返回 `{ label: '使用帮助', icon: 'fas fa-circle-question' }`（放在精确/前缀匹配之前，避免 `/help/getting-started` 落到末段兜底标题）。

`KeepAliveOutlet`：在现有 `isWorkflowVersionsPath(currentPath) || !cache.has(cacheKey)` 上增加 `isHelpPath(currentPath)`，帮助路径每次用当前 `children` 覆盖缓存。

`WorkspaceSidebar` 底部（`</nav>` 之后、`</aside>` 之前）增加链接：`href={base + '/help'}`，文案「使用帮助」，图标 `fas fa-circle-question`（与 Tab 相同）。当前路径 `isHelpPath` 时高亮，风格与侧栏叶子项一致（`text-[13px]`、激活 `bg-blue-50 text-blue-600`）。不按能力隐藏。

## 4. 组件与文件

| 路径 | 职责 |
|---|---|
| `frontend-nextjs/lib/helpCatalog.ts` | 分组、9 篇元数据、`getHelpArticle(slug)` |
| `frontend-nextjs/lib/helpCatalog.test.ts` | 目录不变量 |
| `frontend-nextjs/components/help/HelpShell.tsx` | 主区两栏：左 TOC、右 children |
| `frontend-nextjs/components/help/HelpToc.tsx` | 按 `HELP_GROUPS` 列出文章，高亮当前 slug |
| `frontend-nextjs/components/help/HelpArticle.tsx` | 标题、摘要、「去使用」、正文或空状态 |
| `frontend-nextjs/components/help/articles/*.tsx` | 9 个正文组件，文件名与 slug 相同 |
| `frontend-nextjs/components/help/articles/slugs.ts` | `HELP_ARTICLE_BODY_SLUGS`（与 9 个文件对应的 slug 列表，无 React） |
| `frontend-nextjs/components/help/articles/index.ts` | `HELP_ARTICLE_BODIES: Record<(typeof HELP_ARTICLE_BODY_SLUGS)[number], ComponentType>`、`getHelpArticleBody` |
| `frontend-nextjs/components/help/articles/slugs.test.ts` | `HELP_ARTICLE_BODY_SLUGS` 与 catalog slug 一一对应 |
| `frontend-nextjs/components/workspace/workspaceNav.test.ts` | `isHelpPath` / `tabIdentity` / `resolveNavMeta` |
| `frontend-nextjs/app/workspace/[projectId]/help/page.tsx` | 首页：壳 + 分组卡片 |
| `frontend-nextjs/app/workspace/[projectId]/help/[slug]/page.tsx` | 查 catalog 与注册表，交给 `HelpArticle` |

`HelpShell` 入参：`base: string`（`/workspace/:projectId`）、`slug: string | null`。首页 `slug=null`。目录链接为 `${base}/help/${article.slug}`。

`HelpArticle` 入参：`base`、`article: HelpArticleMeta | undefined`、`children?: ReactNode`。`article` 为空时右栏标题「没有这篇文章」，说明检查左侧目录；不渲染「去使用」。

「去使用」：对 `article.related` 每项渲染 `Link` 到 `${base}${href}`（`href === ''` 时即为 `${base}`）。点击走普通工作区导航，打开独立功能 Tab。

视觉：白底、灰边、激活蓝，与工作区侧栏/卡片一致。正文 `text-sm text-gray-700`，代码块沿用 SSE 说明面板的 `pre` 深色块。不加搜索框、不加复制按钮。

文章组件不请求 API、不读 Zustand（除页面为拼 `base` 用的 `useParams`）。

## 5. 目录数据

```ts
export type HelpGroupId = 'start' | 'product' | 'connect'

export interface HelpRelatedLink {
  href: string
  label: string
}

export interface HelpArticleMeta {
  slug: string
  title: string
  group: HelpGroupId
  summary: string
  related: HelpRelatedLink[]
}

export const HELP_GROUPS: { id: HelpGroupId; label: string }[] = [
  { id: 'start', label: '入门' },
  { id: 'product', label: '产品' },
  { id: 'connect', label: '对接' },
]
```

`HELP_ARTICLES` 顺序即 TOC 顺序。`getHelpArticle` 按 slug 精确查找，找不到返回 `undefined`。

`related.href` 必须是 `NAV_GROUPS` 某项的 `href`，或空字符串（项目首页）。测试用 `NAV_GROUPS` 扁平 href 集合校验，禁止游离路径。

## 6. 九篇文章

每篇 3–6 个短节：这是什么、典型怎么走、注意点。不写字段级手册。`getting-started` 与 `connecting-apis` 各允许 **一个** curl 示例；其它篇不放代码块，需要细节时用「去使用」链到原页。

| slug | 标题 | group | summary（大意） | related |
|---|---|---|---|---|
| `getting-started` | 快速开始 | start | 进项目后如何第一次把数据表变成可调用的 API | `''` 项目首页；`/database/tables` 表；`/api` REST API |
| `database` | 数据库 | product | 结构、查询、导入与备份 | `/database/tables` 表；`/database/table-designer` 表设计器；`/database/query` SQL 编辑器 |
| `automation` | 自动化 | product | 库内逻辑、工作流、定时任务、会话规则 | `/automation/workflows` 工作流；`/events/scheduled-tasks` 定时任务；`/database/functions` 函数 |
| `api-and-rpc` | API 与 RPC | product | 表变 REST、函数用 RPC 试调用；完整 curl 在 REST API 页 | `/api` REST API；`/rpc` RPC 调用器 |
| `integrations` | 集成 | product | 数据源与对外通道（Webhook / SSE / ES / Redis / Kafka / 对象存储） | `/events/datasources` 数据源；`/events/webhooks` Webhook；`/automation/sse-routes` 实时推送 |
| `security` | 安全 | product | 角色、RLS、RPC ACL、身份提供方、API Key、网关策略各管哪一层 | `/security/roles` 角色；`/security/rls` RLS；`/security/api-keys` API Key |
| `diagnostics` | 诊断与监控 | product | 大盘、三类日志、语句分析 / 慢查询 / 锁 | `/monitor` 监控大盘；`/logs` 执行日志；`/cloud-logs` 云日志 |
| `settings` | 设置 | product | 项目信息、成员、环境变量、凭证、日志源、连接、网关域名 | `/settings` 项目信息；`/settings/members` 成员管理；`/settings/connections` 数据库连接 |
| `connecting-apis` | API 对接 | connect | 基址、鉴权、REST / RPC / SSE / Webhook 分别何时用 | `/api` REST API；`/rpc` RPC 调用器；`/security/api-keys` API Key；`/automation/sse-routes` 实时推送 |

### 6.1 必须写清的事实

**快速开始**典型路径：确认侧栏 Schema → 表（或表设计器）→ REST API 页看端点 → 安全里建 API Key → 用下面示例调通一次。不写如何新建项目。

最小 GET 示例（`getting-started` 与 `connecting-apis` 可同形，对接篇可多一行说明 RPC）：

```
curl "${API_BASE}/api/v1/{库slug}/{schema}/{table}?limit=1" \
  -H "Authorization: Bearer ob_..."
```

**API 对接**必须写：

- 表 REST 基址：`/api/v1/{库slug}/{schema}`
- 函数 RPC：`/api/v1/{库slug}/rpc/{function}`
- 鉴权：`Authorization: Bearer <API Key>`，Key 以 `ob_` 开头；也支持 `apikey` 头；登录用户可用 JWT
- 项目若走网关对外基址，鉴权由网关处理，调用方不一定再带 Key（与 `restApiDoc.ts` 的 `gatewayMode` 一致）
- SSE 订阅、Webhook 出站与 REST 不是同一条路，链到实时推送 / Webhook 页
- 完整方法列表与过滤参数去 REST API 页，本文不复制 `genericTableEndpoints`

各产品篇覆盖该组侧栏里的主要项（哪怕「去使用」只链 3 个），避免只写链到的那三个功能、组内其它入口完全不提。

## 7. 数据流

1. 点击侧栏「使用帮助」→ `/workspace/:projectId/help`
2. 项目 layout 已授权则 `openTab({ path: '/help', title: '使用帮助', icon: 'fas fa-circle-question' })`
3. `HelpShell` 从 `HELP_ARTICLES` / `HELP_GROUPS` 画 TOC；右栏为分组卡片，点卡片进 `/help/:slug`
4. URL 变、Tab 身份仍是 `/help`，`openTab` 更新 `path` 但标题不变；`KeepAliveOutlet` 因 `isHelpPath` 覆盖缓存
5. `[slug]/page.tsx`：`getHelpArticle` + `getHelpArticleBody`；缺一则 `HelpArticle` 空状态
6. 「去使用」→ 功能页，新 Tab，帮助 Tab 仍在

无网络、无写入、无权限矩阵。

## 8. 错误处理

| 情况 | 行为 |
|---|---|
| 未知 slug 或注册表缺组件 | 右栏「没有这篇文章」；TOC 仍可用 |
| `related.href` 写错 | 单测失败；运行时不校验 |
| 链到的功能页用户无权限 | 由该页现有门槛处理（403/隐藏控件），帮助不预判 |
| 非项目成员 | 进不了 layout，看不到帮助 |

## 9. 测试

前端无测试运行器，沿用 `npx tsx` + `node:assert/strict`。

**`helpCatalog.test.ts`**

- `HELP_ARTICLES.length === 9`
- slug 唯一，且恰好为 §6 九个 slug
- 每篇 `group` 属于 `HELP_GROUPS`
- 「入门」1 篇、「产品」7 篇、「对接」1 篇
- 每篇 `related.length >= 1`；每条 `href` ∈ `{''} ∪ NAV_GROUPS 全部 item.href`；`label` 非空
- `getHelpArticle('getting-started')` 有值；`getHelpArticle('no-such')` 为 `undefined`

**`articles/slugs.test.ts`**

- `HELP_ARTICLE_BODY_SLUGS` 排序后与 `HELP_ARTICLES.map(a => a.slug)` 排序后相等（覆盖全部 catalog slug，且没有多余 slug）
- 只从 `slugs.ts` 与 `helpCatalog.ts` 导入，不加载文章组件
- 组件是否齐：由 `HELP_ARTICLE_BODIES` 的 `Record<slug, ComponentType>` 在 `tsc` 漏键时报错

**`workspaceNav.test.ts`**

- `isHelpPath('/help')`、`isHelpPath('/help/getting-started')` 为 true；`isHelpPath('/api')`、`isHelpPath('/help-me')` 为 false
- `tabIdentity('/help')` 与 `tabIdentity('/help/getting-started')` 均为 `'/help'`
- `resolveNavMeta` 对上述两路径均为 `{ label: '使用帮助', icon: 'fas fa-circle-question' }`

不测文章正文措辞，不测点击与截图。

### 手动验收

1. 项目工作区侧栏底部有「使用帮助」，点开首页，左目录 3 组 9 篇。
2. 打开一篇，Tab 只有一个「使用帮助」；再切另一篇，仍是同一 Tab，正文更换。
3. 未知 URL `/help/not-a-page`：目录在，右栏空状态。
4. 「去使用」打开对应功能页（另一个 Tab），帮助 Tab 仍在。
5. 直链 `/workspace/:id/help/connecting-apis` 能打开对接篇。
6. REST API 页、实时推送页原有文档仍在，不被本功能替换。

## 10. 实现约束

- 不改 `NAV_GROUPS` 的功能项（帮助不是功能分组）。
- 不新增 npm 依赖。
- 不改后端、不改 REST 公开分享页。
- 旧 `SidebarV3` 的 `href="#"`「帮助文档」不在本范围（旧后台已废弃）。
- Git：未明确要求时不提交。
