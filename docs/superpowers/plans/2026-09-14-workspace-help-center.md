# 工作区使用帮助 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 项目工作区内提供静态「使用帮助」：侧栏入口、目录首页、9 篇文章，覆盖产品使用与 API 对接。

**Architecture:** 纯前端。`helpCatalog.ts` 管元数据；`/help` 与 `/help/:slug` 共用 `HelpShell`（左目录右正文）。所有帮助 URL 的 Tab 身份是 `/help`；`KeepAliveOutlet` 对帮助路径每次覆盖缓存。文章是 React 组件，不接后端。

**Tech Stack:** Next.js App Router（`frontend-nextjs`）、TypeScript、Tailwind、`npx tsx` + `node:assert/strict`。

**Spec:** `docs/superpowers/specs/2026-09-14-workspace-help-center-design.md`

## Global Constraints

- Do not create git commits unless the user explicitly asks. Keep Commit steps but skip them until asked.
- 不新增 npm 依赖。不改后端。不改 REST 公开分享页。不改 `NAV_GROUPS` 功能项。
- 文案中文。功能名与侧栏一致。图标一律 `fas fa-circle-question`。
- 恰好 9 篇，slug：`getting-started` `database` `automation` `api-and-rpc` `integrations` `security` `diagnostics` `settings` `connecting-apis`。
- 只有 `getting-started` 与 `connecting-apis` 各一个 curl 代码块；其它篇不放代码。
- 不做搜索、Markdown、组织/平台帮助、按角色过滤链接。
- 旧 `SidebarV3` 的 `href="#"`「帮助文档」不改。

## File Structure

| Path | Responsibility |
|------|----------------|
| `frontend-nextjs/lib/helpCatalog.ts` | 分组、9 篇元数据、`getHelpArticle` |
| `frontend-nextjs/lib/helpCatalog.test.ts` | 目录不变量 |
| `frontend-nextjs/components/workspace/workspaceNav.ts` | `isHelpPath`、`tabIdentity`、`resolveNavMeta`、`shouldReplaceKeepAliveCache` |
| `frontend-nextjs/components/workspace/workspaceNav.test.ts` | 帮助路径与 Tab 元数据 |
| `frontend-nextjs/components/workspace/KeepAliveOutlet.tsx` | 帮助路径覆盖缓存 |
| `frontend-nextjs/components/workspace/WorkspaceSidebar.tsx` | 底部「使用帮助」入口 |
| `frontend-nextjs/components/help/HelpShell.tsx` | 两栏壳 |
| `frontend-nextjs/components/help/HelpToc.tsx` | 左栏目录 |
| `frontend-nextjs/components/help/HelpArticle.tsx` | 文章头、「去使用」、空状态、`HelpSection`/`HelpCode` |
| `frontend-nextjs/components/help/articles/slugs.ts` | `HELP_ARTICLE_BODY_SLUGS` |
| `frontend-nextjs/components/help/articles/slugs.test.ts` | slug 列表与 catalog 对齐 |
| `frontend-nextjs/components/help/articles/*.tsx` | 9 篇正文 |
| `frontend-nextjs/components/help/articles/index.ts` | `HELP_ARTICLE_BODIES`、`getHelpArticleBody` |
| `frontend-nextjs/app/workspace/[projectId]/help/page.tsx` | 目录首页 |
| `frontend-nextjs/app/workspace/[projectId]/help/[slug]/page.tsx` | 文章页 |

---

### Task 1: 帮助目录数据

**Files:**
- Create: `frontend-nextjs/lib/helpCatalog.ts`
- Test: `frontend-nextjs/lib/helpCatalog.test.ts`

**Interfaces:**
- Consumes: `NAV_GROUPS`（仅测试文件导入，catalog 本身不依赖导航）
- Produces:
  - `export type HelpGroupId = 'start' | 'product' | 'connect'`
  - `export interface HelpRelatedLink { href: string; label: string }`
  - `export interface HelpArticleMeta { slug: string; title: string; group: HelpGroupId; summary: string; related: HelpRelatedLink[] }`
  - `export const HELP_GROUPS: { id: HelpGroupId; label: string }[]`
  - `export const HELP_ARTICLES: HelpArticleMeta[]`
  - `export function getHelpArticle(slug: string): HelpArticleMeta | undefined`

- [ ] **Step 1: Write the failing test**

Create `frontend-nextjs/lib/helpCatalog.test.ts`:

```ts
import assert from 'node:assert/strict'
import { NAV_GROUPS } from '../components/workspace/workspaceNav'
import {
  HELP_ARTICLES,
  HELP_GROUPS,
  getHelpArticle,
} from './helpCatalog'

const EXPECTED_SLUGS = [
  'getting-started',
  'database',
  'automation',
  'api-and-rpc',
  'integrations',
  'security',
  'diagnostics',
  'settings',
  'connecting-apis',
] as const

const allowedHref = new Set<string>([
  '',
  ...NAV_GROUPS.flatMap((g) => g.items.map((it) => it.href)),
])
const groupIds = new Set(HELP_GROUPS.map((g) => g.id))

assert.equal(HELP_ARTICLES.length, 9)
assert.deepEqual(
  HELP_ARTICLES.map((a) => a.slug),
  [...EXPECTED_SLUGS],
)
assert.equal(new Set(HELP_ARTICLES.map((a) => a.slug)).size, 9)

assert.equal(HELP_ARTICLES.filter((a) => a.group === 'start').length, 1)
assert.equal(HELP_ARTICLES.filter((a) => a.group === 'product').length, 7)
assert.equal(HELP_ARTICLES.filter((a) => a.group === 'connect').length, 1)

for (const article of HELP_ARTICLES) {
  assert.ok(groupIds.has(article.group), article.slug)
  assert.ok(article.title.trim().length > 0, article.slug)
  assert.ok(article.summary.trim().length > 0, article.slug)
  assert.ok(article.related.length >= 1, article.slug)
  for (const rel of article.related) {
    assert.ok(allowedHref.has(rel.href), `${article.slug} related ${rel.href}`)
    assert.ok(rel.label.trim().length > 0, `${article.slug} related label`)
  }
}

assert.ok(getHelpArticle('getting-started'))
assert.equal(getHelpArticle('no-such'), undefined)

console.log('helpCatalog tests passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx frontend-nextjs/lib/helpCatalog.test.ts`

Expected: FAIL（`Cannot find module './helpCatalog'` 或等价错误）

- [ ] **Step 3: Write minimal implementation**

Create `frontend-nextjs/lib/helpCatalog.ts`:

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

export const HELP_ARTICLES: HelpArticleMeta[] = [
  {
    slug: 'getting-started',
    title: '快速开始',
    group: 'start',
    summary: '进项目后，如何第一次把数据表变成可调用的 API',
    related: [
      { href: '', label: '项目首页' },
      { href: '/database/tables', label: '表' },
      { href: '/api', label: 'REST API' },
    ],
  },
  {
    slug: 'database',
    title: '数据库',
    group: 'product',
    summary: '用表、设计器和 SQL 管结构与数据，并做导入与备份',
    related: [
      { href: '/database/tables', label: '表' },
      { href: '/database/table-designer', label: '表设计器' },
      { href: '/database/query', label: 'SQL 编辑器' },
    ],
  },
  {
    slug: 'automation',
    title: '自动化',
    group: 'product',
    summary: '函数、触发器、工作流、定时任务和会话规则如何分工',
    related: [
      { href: '/automation/workflows', label: '工作流' },
      { href: '/events/scheduled-tasks', label: '定时任务' },
      { href: '/database/functions', label: '函数' },
    ],
  },
  {
    slug: 'api-and-rpc',
    title: 'API 与 RPC',
    group: 'product',
    summary: '表会自动变成 REST；数据库函数用 RPC 调用器试',
    related: [
      { href: '/api', label: 'REST API' },
      { href: '/rpc', label: 'RPC 调用器' },
    ],
  },
  {
    slug: 'integrations',
    title: '集成',
    group: 'product',
    summary: '数据源给工作流用；Webhook、实时推送和外部存储是对外通道',
    related: [
      { href: '/events/datasources', label: '数据源' },
      { href: '/events/webhooks', label: 'Webhook' },
      { href: '/automation/sse-routes', label: '实时推送' },
    ],
  },
  {
    slug: 'security',
    title: '安全',
    group: 'product',
    summary: '角色、RLS、RPC ACL、身份提供方、API Key 和网关策略各管哪一层',
    related: [
      { href: '/security/roles', label: '角色' },
      { href: '/security/rls', label: 'RLS' },
      { href: '/security/api-keys', label: 'API Key' },
    ],
  },
  {
    slug: 'diagnostics',
    title: '诊断与监控',
    group: 'product',
    summary: '监控大盘看现状；执行 / 操作 / 云日志排障；语句分析、慢查询和锁',
    related: [
      { href: '/monitor', label: '监控大盘' },
      { href: '/logs', label: '执行日志' },
      { href: '/cloud-logs', label: '云日志' },
    ],
  },
  {
    slug: 'settings',
    title: '设置',
    group: 'product',
    summary: '项目信息、成员、环境变量、凭证、日志源、数据库连接和网关域名',
    related: [
      { href: '/settings', label: '项目信息' },
      { href: '/settings/members', label: '成员管理' },
      { href: '/settings/connections', label: '数据库连接' },
    ],
  },
  {
    slug: 'connecting-apis',
    title: 'API 对接',
    group: 'connect',
    summary: '基址、鉴权，以及 REST / RPC / SSE / Webhook 分别何时用',
    related: [
      { href: '/api', label: 'REST API' },
      { href: '/rpc', label: 'RPC 调用器' },
      { href: '/security/api-keys', label: 'API Key' },
      { href: '/automation/sse-routes', label: '实时推送' },
    ],
  },
]

export function getHelpArticle(slug: string): HelpArticleMeta | undefined {
  return HELP_ARTICLES.find((a) => a.slug === slug)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx frontend-nextjs/lib/helpCatalog.test.ts`

Expected: `helpCatalog tests passed`

- [ ] **Step 5: Commit**

```bash
git add frontend-nextjs/lib/helpCatalog.ts frontend-nextjs/lib/helpCatalog.test.ts
git commit -m "$(cat <<'EOF'
feat: add workspace help article catalog

EOF
)"
```

Skip unless the user asked to commit.

---

### Task 2: 帮助路径的 Tab 身份

**Files:**
- Modify: `frontend-nextjs/components/workspace/workspaceNav.ts`
- Test: `frontend-nextjs/components/workspace/workspaceNav.test.ts`

**Interfaces:**
- Consumes: existing `isWorkflowVersionsPath` / `WORKFLOW_VERSIONS_RE`
- Produces:
  - `export function isHelpPath(relPath: string): boolean`
  - `export function shouldReplaceKeepAliveCache(relPath: string): boolean`
  - `tabIdentity('/help')` 与 `tabIdentity('/help/getting-started')` 均为 `'/help'`
  - `resolveNavMeta` 对上述两路径返回 `{ label: '使用帮助', icon: 'fas fa-circle-question' }`

- [ ] **Step 1: Write the failing test**

Create `frontend-nextjs/components/workspace/workspaceNav.test.ts`:

```ts
import assert from 'node:assert/strict'
import {
  isHelpPath,
  resolveNavMeta,
  shouldReplaceKeepAliveCache,
  tabIdentity,
} from './workspaceNav'

assert.equal(isHelpPath('/help'), true)
assert.equal(isHelpPath('/help/getting-started'), true)
assert.equal(isHelpPath('/api'), false)
assert.equal(isHelpPath('/help-me'), false)

assert.equal(tabIdentity('/help'), '/help')
assert.equal(tabIdentity('/help/getting-started'), '/help')
assert.equal(
  tabIdentity('/automation/workflows/3/versions/2'),
  '/automation/workflows/3/versions',
)

assert.deepEqual(resolveNavMeta('/help'), {
  label: '使用帮助',
  icon: 'fas fa-circle-question',
})
assert.deepEqual(resolveNavMeta('/help/getting-started'), {
  label: '使用帮助',
  icon: 'fas fa-circle-question',
})
assert.equal(resolveNavMeta('/automation/workflows/3/versions').label, '工作流版本')

assert.equal(shouldReplaceKeepAliveCache('/help/connecting-apis'), true)
assert.equal(shouldReplaceKeepAliveCache('/automation/workflows/1/versions'), true)
assert.equal(shouldReplaceKeepAliveCache('/api'), false)

console.log('workspaceNav tests passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx frontend-nextjs/components/workspace/workspaceNav.test.ts`

Expected: FAIL（`isHelpPath` / `shouldReplaceKeepAliveCache` 未导出，或 `/help/getting-started` 的 Tab 标题变成 `getting-started`）

- [ ] **Step 3: Write minimal implementation**

In `frontend-nextjs/components/workspace/workspaceNav.ts`, after `isWorkflowVersionsPath`:

```ts
export function isHelpPath(relPath: string): boolean {
  return relPath === '/help' || relPath.startsWith('/help/')
}

export function shouldReplaceKeepAliveCache(relPath: string): boolean {
  return isWorkflowVersionsPath(relPath) || isHelpPath(relPath)
}
```

Replace `tabIdentity` with:

```ts
export function tabIdentity(relPath: string): string {
  if (isHelpPath(relPath)) return '/help'
  const m = relPath.match(WORKFLOW_VERSIONS_RE)
  return m ? m[1] : relPath
}
```

At the start of `resolveNavMeta`, before the workflow-versions check (order between help and workflow versions does not matter; paths do not overlap):

```ts
  if (isHelpPath(relPath)) {
    return { label: '使用帮助', icon: 'fas fa-circle-question' }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx frontend-nextjs/components/workspace/workspaceNav.test.ts`

Expected: `workspaceNav tests passed`

- [ ] **Step 5: Commit**

```bash
git add frontend-nextjs/components/workspace/workspaceNav.ts frontend-nextjs/components/workspace/workspaceNav.test.ts
git commit -m "$(cat <<'EOF'
feat: share one workspace tab for help routes

EOF
)"
```

Skip unless the user asked to commit.

---

### Task 3: 帮助页刷新 KeepAlive 缓存

**Files:**
- Modify: `frontend-nextjs/components/workspace/KeepAliveOutlet.tsx`

**Interfaces:**
- Consumes: `shouldReplaceKeepAliveCache(relPath: string): boolean` from Task 2
- Produces: 帮助路径每次用当前 `children` 写入缓存（与工作流版本相同）

- [ ] **Step 1: Switch the cache-write condition**

In `frontend-nextjs/components/workspace/KeepAliveOutlet.tsx`, change the import from:

```ts
import { isWorkflowVersionsPath, tabIdentity } from '@/components/workspace/workspaceNav'
```

to:

```ts
import { shouldReplaceKeepAliveCache, tabIdentity } from '@/components/workspace/workspaceNav'
```

Replace:

```ts
  if (isWorkflowVersionsPath(currentPath) || !cache.has(cacheKey)) {
    cache.set(cacheKey, children)
  }
```

with:

```ts
  if (shouldReplaceKeepAliveCache(currentPath) || !cache.has(cacheKey)) {
    cache.set(cacheKey, children)
  }
```

Update the file comment that mentions只对工作流版本覆盖缓存：改为工作流版本与帮助路径都会覆盖。

- [ ] **Step 2: Confirm the wiring**

Run: `rg -n "shouldReplaceKeepAliveCache|isWorkflowVersionsPath" frontend-nextjs/components/workspace/KeepAliveOutlet.tsx`

Expected: 命中 `shouldReplaceKeepAliveCache`；本文件不再引用 `isWorkflowVersionsPath`。

- [ ] **Step 3: Commit**

```bash
git add frontend-nextjs/components/workspace/KeepAliveOutlet.tsx
git commit -m "$(cat <<'EOF'
fix: refresh keep-alive cache when switching help articles

EOF
)"
```

Skip unless the user asked to commit.

---

### Task 4: 文章 slug 列表

**Files:**
- Create: `frontend-nextjs/components/help/articles/slugs.ts`
- Test: `frontend-nextjs/components/help/articles/slugs.test.ts`

**Interfaces:**
- Consumes: `HELP_ARTICLES` from `frontend-nextjs/lib/helpCatalog.ts`
- Produces: `export const HELP_ARTICLE_BODY_SLUGS`（`as const` 元组，顺序与 catalog 相同）

- [ ] **Step 1: Write the failing test**

Create `frontend-nextjs/components/help/articles/slugs.test.ts`:

```ts
import assert from 'node:assert/strict'
import { HELP_ARTICLES } from '../../../lib/helpCatalog'
import { HELP_ARTICLE_BODY_SLUGS } from './slugs'

assert.deepEqual(
  [...HELP_ARTICLE_BODY_SLUGS].slice().sort(),
  HELP_ARTICLES.map((a) => a.slug).slice().sort(),
)

console.log('help article slugs tests passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx frontend-nextjs/components/help/articles/slugs.test.ts`

Expected: FAIL（找不到 `./slugs`）

- [ ] **Step 3: Write minimal implementation**

Create `frontend-nextjs/components/help/articles/slugs.ts`:

```ts
export const HELP_ARTICLE_BODY_SLUGS = [
  'getting-started',
  'database',
  'automation',
  'api-and-rpc',
  'integrations',
  'security',
  'diagnostics',
  'settings',
  'connecting-apis',
] as const

export type HelpArticleSlug = (typeof HELP_ARTICLE_BODY_SLUGS)[number]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx frontend-nextjs/components/help/articles/slugs.test.ts`

Expected: `help article slugs tests passed`

Also re-run: `npx tsx frontend-nextjs/lib/helpCatalog.test.ts`

Expected: `helpCatalog tests passed`

- [ ] **Step 5: Commit**

```bash
git add frontend-nextjs/components/help/articles/slugs.ts frontend-nextjs/components/help/articles/slugs.test.ts
git commit -m "$(cat <<'EOF'
feat: add help article slug list

EOF
)"
```

Skip unless the user asked to commit.

---

### Task 5: 帮助页壳与文章头

**Files:**
- Create: `frontend-nextjs/components/help/HelpToc.tsx`
- Create: `frontend-nextjs/components/help/HelpShell.tsx`
- Create: `frontend-nextjs/components/help/HelpArticle.tsx`

**Interfaces:**
- Consumes: `HELP_GROUPS`、`HELP_ARTICLES`、`HelpArticleMeta` from catalog
- Produces:
  - `HelpToc({ base: string; slug: string | null })`
  - `HelpShell({ base: string; slug: string | null; children: React.ReactNode })`
  - `HelpArticle({ base: string; article: HelpArticleMeta | undefined; children?: React.ReactNode })`
  - `HelpSection({ title: string; children: React.ReactNode })`
  - `HelpCode({ children: string })`
  - 未知文章文案：「没有这篇文章」；提示「请从左侧目录选择一篇说明。」

- [ ] **Step 1: Create HelpToc**

Create `frontend-nextjs/components/help/HelpToc.tsx`:

```tsx
import Link from 'next/link'
import { HELP_ARTICLES, HELP_GROUPS } from '@/lib/helpCatalog'

export default function HelpToc({
  base,
  slug,
}: {
  base: string
  slug: string | null
}) {
  return (
    <nav className="w-[200px] flex-shrink-0">
      <div className="sticky top-0 space-y-4">
        <Link
          href={`${base}/help`}
          className={`block text-[13px] font-medium ${
            slug === null ? 'text-blue-600' : 'text-gray-700 hover:text-gray-900'
          }`}
        >
          使用帮助
        </Link>
        {HELP_GROUPS.map((group) => (
          <div key={group.id}>
            <div className="px-0.5 mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">
              {group.label}
            </div>
            <ul className="space-y-0.5">
              {HELP_ARTICLES.filter((a) => a.group === group.id).map((article) => {
                const active = slug === article.slug
                return (
                  <li key={article.slug}>
                    <Link
                      href={`${base}/help/${article.slug}`}
                      className={`block rounded-md px-2.5 py-1.5 text-[13px] ${
                        active
                          ? 'bg-blue-50 text-blue-600 font-medium'
                          : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                      }`}
                    >
                      {article.title}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  )
}
```

- [ ] **Step 2: Create HelpShell**

Create `frontend-nextjs/components/help/HelpShell.tsx`:

```tsx
import type { ReactNode } from 'react'
import HelpToc from '@/components/help/HelpToc'

export default function HelpShell({
  base,
  slug,
  children,
}: {
  base: string
  slug: string | null
  children: ReactNode
}) {
  return (
    <div className="flex gap-6 min-h-full items-start">
      <HelpToc base={base} slug={slug} />
      <div className="flex-1 min-w-0 max-w-3xl">{children}</div>
    </div>
  )
}
```

- [ ] **Step 3: Create HelpArticle**

Create `frontend-nextjs/components/help/HelpArticle.tsx`:

```tsx
import type { ReactNode } from 'react'
import Link from 'next/link'
import type { HelpArticleMeta } from '@/lib/helpCatalog'

export function HelpSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
      <div className="space-y-2 text-sm text-gray-700 leading-relaxed">{children}</div>
    </section>
  )
}

export function HelpCode({ children }: { children: string }) {
  return (
    <pre className="bg-gray-900 text-gray-100 rounded-lg p-3 text-xs overflow-x-auto leading-relaxed">
      {children}
    </pre>
  )
}

function relatedHref(base: string, href: string): string {
  return href === '' ? base : `${base}${href}`
}

export default function HelpArticle({
  base,
  article,
  children,
}: {
  base: string
  article: HelpArticleMeta | undefined
  children?: ReactNode
}) {
  if (!article) {
    return (
      <div>
        <h1 className="text-lg font-semibold text-gray-900 mb-2">没有这篇文章</h1>
        <p className="text-sm text-gray-600">请从左侧目录选择一篇说明。</p>
      </div>
    )
  }

  return (
    <article className="space-y-5">
      <header className="space-y-2">
        <h1 className="text-lg font-semibold text-gray-900">{article.title}</h1>
        <p className="text-sm text-gray-600">{article.summary}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          {article.related.map((rel) => (
            <Link
              key={`${rel.href}:${rel.label}`}
              href={relatedHref(base, rel.href)}
              className="inline-flex items-center rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
            >
              去使用 · {rel.label}
            </Link>
          ))}
        </div>
      </header>
      <div className="space-y-5">{children}</div>
    </article>
  )
}
```

- [ ] **Step 4: Typecheck the new files**

Run: `cd frontend-nextjs && npx tsc --noEmit`

Expected: 无与 `components/help/Help*.tsx` 相关的新错误。

- [ ] **Step 5: Commit**

```bash
git add frontend-nextjs/components/help/HelpToc.tsx frontend-nextjs/components/help/HelpShell.tsx frontend-nextjs/components/help/HelpArticle.tsx
git commit -m "$(cat <<'EOF'
feat: add workspace help shell and article chrome

EOF
)"
```

Skip unless the user asked to commit.

---

### Task 6: 九篇正文与注册表

**Files:**
- Create: `frontend-nextjs/components/help/articles/getting-started.tsx`
- Create: `frontend-nextjs/components/help/articles/database.tsx`
- Create: `frontend-nextjs/components/help/articles/automation.tsx`
- Create: `frontend-nextjs/components/help/articles/api-and-rpc.tsx`
- Create: `frontend-nextjs/components/help/articles/integrations.tsx`
- Create: `frontend-nextjs/components/help/articles/security.tsx`
- Create: `frontend-nextjs/components/help/articles/diagnostics.tsx`
- Create: `frontend-nextjs/components/help/articles/settings.tsx`
- Create: `frontend-nextjs/components/help/articles/connecting-apis.tsx`
- Create: `frontend-nextjs/components/help/articles/index.ts`

**Interfaces:**
- Consumes: `HelpSection`、`HelpCode` from `HelpArticle.tsx`；`HelpArticleSlug`、`HELP_ARTICLE_BODY_SLUGS` from `slugs.ts`
- Produces:
  - 每个 slug 一个 default export 组件
  - `export const HELP_ARTICLE_BODIES: Record<HelpArticleSlug, ComponentType>`
  - `export function getHelpArticleBody(slug: string): ComponentType | undefined`

每篇 3–6 个 `HelpSection`。只有 `getting-started` 与 `connecting-apis` 使用 `HelpCode`。产品篇必须点到该组侧栏里的主要项，不能只写「去使用」链到的那三个。

- [ ] **Step 1: Write getting-started.tsx**

```tsx
import { HelpCode, HelpSection } from '@/components/help/HelpArticle'

const CURL = `curl "\${API_BASE}/api/v1/{库slug}/{schema}/{table}?limit=1" \\
  -H "Authorization: Bearer ob_..."`

export default function GettingStartedArticle() {
  return (
    <>
      <HelpSection title="这是什么">
        <p>
          项目工作区把 PostgreSQL 变成可管理的后端：建表、配权限、自动得到 REST / RPC。
          这篇只讲已经进入某个项目之后怎么走第一步。
        </p>
      </HelpSection>
      <HelpSection title="第一次建议怎么走">
        <ol className="list-decimal ml-5 space-y-1">
          <li>看项目首页，确认当前项目无误。</li>
          <li>侧栏顶部的 Schema 选择器选对 schema（常见是 public）。</li>
          <li>打开「表」查看已有表，或用「表设计器」建一张。</li>
          <li>打开「REST API」看这张表对应的端点。</li>
          <li>在「安全 → API Key」创建一把密钥，再用下面的命令调通一次。</li>
        </ol>
      </HelpSection>
      <HelpSection title="调通一次">
        <HelpCode>{CURL}</HelpCode>
        <p>
          把 <code className="font-mono text-xs">API_BASE</code>、库 slug、schema、表名和 Key
          换成项目里的值。完整方法列表与过滤参数在 REST API 页。
        </p>
      </HelpSection>
      <HelpSection title="注意">
        <p>新建项目在工作区选择页，不在本页。权限不够时，目标功能页会自己拦住，帮助目录仍全部可见。</p>
      </HelpSection>
    </>
  )
}
```

- [ ] **Step 2: Write database.tsx**

```tsx
import { HelpSection } from '@/components/help/HelpArticle'

export default function DatabaseArticle() {
  return (
    <>
      <HelpSection title="这是什么">
        <p>「数据库」分组是对当前项目主连接里 PostgreSQL 对象的直接操作，不是对外 API 文档。</p>
      </HelpSection>
      <HelpSection title="结构">
        <p>
          「表」看数据和行编辑。「表设计器」可视化建表或改结构。「关系图」看表之间的关系。
          「Schema 浏览器」按 schema 浏览对象。「索引」和「扩展」分别管性能对象与 PG extension。
        </p>
      </HelpSection>
      <HelpSection title="查询与写入">
        <p>
          「SQL 编辑器」跑任意 SQL。「事务编辑器」把多条语句放进同一事务。写操作以你在项目里的角色为准。
        </p>
      </HelpSection>
      <HelpSection title="导入与备份">
        <p>「数据导入」把文件灌进表。「备份与恢复」导出或找回库数据。大操作前先确认连的是目标库。</p>
      </HelpSection>
    </>
  )
}
```

- [ ] **Step 3: Write automation.tsx**

```tsx
import { HelpSection } from '@/components/help/HelpArticle'

export default function AutomationArticle() {
  return (
    <>
      <HelpSection title="这是什么">
        <p>「自动化」是会在库内或调度器里替你执行的逻辑，和一次性的 SQL 查询不同。</p>
      </HelpSection>
      <HelpSection title="函数与触发器">
        <p>
          「函数」是 PostgreSQL 函数，可被 REST/RPC 或触发器调用。「触发器」挂在表的 INSERT / UPDATE / DELETE 上，行变更时自动跑。
        </p>
      </HelpSection>
      <HelpSection title="工作流与定时任务">
        <p>
          「工作流」在画布上编排 HTTP、数据库、代码等节点，可被 API、其它工作流或定时任务触发。
          「定时任务」按 cron 启动工作流或其它已支持的任务类型。
        </p>
      </HelpSection>
      <HelpSection title="会话规则">
        <p>「会话规则」在数据库会话建立时注入 GUC / 连接行为，适合按请求设置角色或搜索路径。细节在该页配置。</p>
      </HelpSection>
    </>
  )
}
```

- [ ] **Step 4: Write api-and-rpc.tsx**

```tsx
import { HelpSection } from '@/components/help/HelpArticle'

export default function ApiAndRpcArticle() {
  return (
    <>
      <HelpSection title="这是什么">
        <p>表会自动暴露为 REST。数据库函数通过 RPC 调用。本页只讲在工作区里从哪看、怎么试；完整 curl 在 REST API 页。</p>
      </HelpSection>
      <HelpSection title="REST API">
        <p>
          「REST API」给出当前 schema 下表的读写端点、过滤/排序说明，以及可分享的公开文档链接。
          不要在帮助里找方法全集，以那一页为准。
        </p>
      </HelpSection>
      <HelpSection title="RPC 调用器">
        <p>「RPC 调用器」选一个函数、填参数并执行，用来确认函数在权限打开后能被外部调用。适合调试，不替代业务客户端。</p>
      </HelpSection>
    </>
  )
}
```

- [ ] **Step 5: Write integrations.tsx**

```tsx
import { HelpSection } from '@/components/help/HelpArticle'

export default function IntegrationsArticle() {
  return (
    <>
      <HelpSection title="这是什么">
        <p>「集成」把项目连到外部系统，或把变更推出去。工作流节点会引用这里配好的连接。</p>
      </HelpSection>
      <HelpSection title="数据源">
        <p>「数据源」是项目内共享的数据库连接，给工作流里的数据库节点用，避免把主机密码写进每个流程。</p>
      </HelpSection>
      <HelpSection title="往外推">
        <p>
          「Webhook」在事件发生时 HTTP 推到你的 URL。「实时推送」把表变更写到 SSE topic，浏览器用 EventSource 订。
          订阅格式与字段以实时推送页的「使用说明」为准。
        </p>
      </HelpSection>
      <HelpSection title="外部存储与消息">
        <p>「ES 代理」「Redis」「Kafka」「对象存储」分别登记对应连接，供工作流或代理接口使用。先在这里建连接，再在工作流节点里选用。</p>
      </HelpSection>
    </>
  )
}
```

- [ ] **Step 6: Write security.tsx**

```tsx
import { HelpSection } from '@/components/help/HelpArticle'

export default function SecurityArticle() {
  return (
    <>
      <HelpSection title="这是什么">
        <p>「安全」决定谁能进项目、能看哪些行、能调哪些函数、外部调用怎么鉴权。</p>
      </HelpSection>
      <HelpSection title="身份与角色">
        <p>
          「角色」是项目内 RBAC。「身份提供方」把外部登录连进来。
          成员名单在设置里的「成员管理」，不在本组。
        </p>
      </HelpSection>
      <HelpSection title="数据与函数">
        <p>「RLS」用 PostgreSQL 行级策略限制行可见性。「RPC ACL」控制哪些角色能调哪些函数。</p>
      </HelpSection>
      <HelpSection title="调用入口">
        <p>
          「API Key」发给外部系统，Key 以 <code className="font-mono text-xs">ob_</code> 开头。
          「网关策略」管对外域名上的访问控制。走网关时，调用方鉴权方式见「API 对接」。
        </p>
      </HelpSection>
    </>
  )
}
```

- [ ] **Step 7: Write diagnostics.tsx**

```tsx
import { HelpSection } from '@/components/help/HelpArticle'

export default function DiagnosticsArticle() {
  return (
    <>
      <HelpSection title="这是什么">
        <p>「诊断与监控」只读观测：看现在是否健康、一次请求走过哪里、哪条 SQL 慢或堵住。</p>
      </HelpSection>
      <HelpSection title="看现状">
        <p>「监控大盘」看项目级指标与趋势。先看这里，再决定要不要下钻日志。</p>
      </HelpSection>
      <HelpSection title="三类日志">
        <p>
          「执行日志」是平台记下的工作流/任务执行。「操作日志」是谁在工作区做了什么。
          「云日志」按项目配置的日志源（如阿里云 SLS）代查，用来对 <code className="font-mono text-xs">x_request_id</code>。
        </p>
      </HelpSection>
      <HelpSection title="语句与阻塞">
        <p>「语句分析」看 SQL 形态与耗时。「慢查询」列出超阈值语句。「锁与阻塞」看谁堵住了谁。</p>
      </HelpSection>
    </>
  )
}
```

- [ ] **Step 8: Write settings.tsx**

```tsx
import { HelpSection } from '@/components/help/HelpArticle'

export default function SettingsArticle() {
  return (
    <>
      <HelpSection title="这是什么">
        <p>「设置」是项目级配置，不直接改表数据。部分项只有 owner / admin 能改。</p>
      </HelpSection>
      <HelpSection title="项目与人">
        <p>「项目信息」改名称等基本资料。「成员管理」加人、改角色、移出成员。</p>
      </HelpSection>
      <HelpSection title="密钥与变量">
        <p>
          「环境变量」给工作流运行时读。「凭证管理」存外部账号（含云日志用的密钥），密文不回显。
          「云日志源」指向凭证并填写 SLS 项目/Logstore，供诊断里的云日志页使用。
        </p>
      </HelpSection>
      <HelpSection title="连接与网关">
        <p>「数据库连接」是本项目连哪台 PostgreSQL。「网关域名」配置对外访问的网关基址。</p>
      </HelpSection>
    </>
  )
}
```

- [ ] **Step 9: Write connecting-apis.tsx**

```tsx
import { HelpCode, HelpSection } from '@/components/help/HelpArticle'

const CURL = `curl "\${API_BASE}/api/v1/{库slug}/{schema}/{table}?limit=1" \\
  -H "Authorization: Bearer ob_..."`

export default function ConnectingApisArticle() {
  return (
    <>
      <HelpSection title="基址">
        <p>
          表 REST：<code className="font-mono text-xs">/api/v1/{'{库slug}'}/{'{schema}'}</code>，后面接表名。
          函数 RPC：<code className="font-mono text-xs">/api/v1/{'{库slug}'}/rpc/{'{function}'}</code>。
          库 slug 不是项目数字 id，以 REST API 页上的示例为准。
        </p>
      </HelpSection>
      <HelpSection title="鉴权">
        <p>
          默认带 <code className="font-mono text-xs">Authorization: Bearer &lt;API Key&gt;</code>，Key 以{' '}
          <code className="font-mono text-xs">ob_</code> 开头。也支持 <code className="font-mono text-xs">apikey</code> 头。
          登录用户可用 JWT。项目若配置了网关对外基址，鉴权由网关处理，调用方不一定再带 Key。
        </p>
      </HelpSection>
      <HelpSection title="选哪条路">
        <ul className="list-disc ml-5 space-y-1">
          <li>读写表 → REST。</li>
          <li>调数据库函数 → RPC。</li>
          <li>浏览器要实时收表变更 → SSE（实时推送页）。</li>
          <li>变更发生时通知你自己的 HTTP 服务 → Webhook。</li>
        </ul>
      </HelpSection>
      <HelpSection title="最小示例">
        <HelpCode>{CURL}</HelpCode>
        <p>RPC 把路径换成 <code className="font-mono text-xs">/rpc/{'{function}'}</code> 并改用 POST JSON。过滤参数、HTTP 方法全集在 REST API 页，这里不重复。</p>
      </HelpSection>
    </>
  )
}
```

- [ ] **Step 10: Write the registry**

Create `frontend-nextjs/components/help/articles/index.ts`:

```ts
import type { ComponentType } from 'react'
import GettingStarted from './getting-started'
import Database from './database'
import Automation from './automation'
import ApiAndRpc from './api-and-rpc'
import Integrations from './integrations'
import Security from './security'
import Diagnostics from './diagnostics'
import Settings from './settings'
import ConnectingApis from './connecting-apis'
import { HELP_ARTICLE_BODY_SLUGS, type HelpArticleSlug } from './slugs'

export const HELP_ARTICLE_BODIES: Record<HelpArticleSlug, ComponentType> = {
  'getting-started': GettingStarted,
  database: Database,
  automation: Automation,
  'api-and-rpc': ApiAndRpc,
  integrations: Integrations,
  security: Security,
  diagnostics: Diagnostics,
  settings: Settings,
  'connecting-apis': ConnectingApis,
}

export function getHelpArticleBody(slug: string): ComponentType | undefined {
  if (!(HELP_ARTICLE_BODY_SLUGS as readonly string[]).includes(slug)) return undefined
  return HELP_ARTICLE_BODIES[slug as HelpArticleSlug]
}
```

- [ ] **Step 11: Typecheck**

Run: `cd frontend-nextjs && npx tsc --noEmit`

Expected: `HELP_ARTICLE_BODIES` 无缺键；无与 `components/help/articles/` 相关的新错误。

Also run: `npx tsx frontend-nextjs/components/help/articles/slugs.test.ts`

Expected: `help article slugs tests passed`

- [ ] **Step 12: Commit**

```bash
git add frontend-nextjs/components/help/articles
git commit -m "$(cat <<'EOF'
feat: add workspace help article bodies

EOF
)"
```

Skip unless the user asked to commit.

---

### Task 7: 帮助路由页

**Files:**
- Create: `frontend-nextjs/app/workspace/[projectId]/help/page.tsx`
- Create: `frontend-nextjs/app/workspace/[projectId]/help/[slug]/page.tsx`

**Interfaces:**
- Consumes: `HelpShell`、`HelpArticle`、`HELP_GROUPS`、`HELP_ARTICLES`、`getHelpArticle`、`getHelpArticleBody`
- Produces: `/workspace/:projectId/help` 首页卡片；`/help/:slug` 渲染文章或空状态。两页都是 `'use client'`，用 `useParams` 拼 `base`。

- [ ] **Step 1: Create the index page**

Create `frontend-nextjs/app/workspace/[projectId]/help/page.tsx`:

```tsx
'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import HelpShell from '@/components/help/HelpShell'
import { HELP_ARTICLES, HELP_GROUPS } from '@/lib/helpCatalog'

export default function HelpIndexPage() {
  const params = useParams<{ projectId: string }>()
  const base = `/workspace/${params.projectId}`

  return (
    <HelpShell base={base} slug={null}>
      <div className="space-y-6">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">使用帮助</h1>
          <p className="mt-1 text-sm text-gray-600">
            产品怎么用、API 怎么调。从左侧或下方卡片进入一篇说明。
          </p>
        </div>
        {HELP_GROUPS.map((group) => (
          <section key={group.id} className="space-y-2">
            <h2 className="text-sm font-semibold text-gray-900">{group.label}</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {HELP_ARTICLES.filter((a) => a.group === group.id).map((article) => (
                <Link
                  key={article.slug}
                  href={`${base}/help/${article.slug}`}
                  className="block rounded-lg border border-gray-200 bg-white p-3 hover:border-blue-200 hover:bg-blue-50/40"
                >
                  <div className="text-[13px] font-medium text-gray-900">{article.title}</div>
                  <div className="mt-1 text-xs text-gray-600 leading-relaxed">{article.summary}</div>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </HelpShell>
  )
}
```

- [ ] **Step 2: Create the article page**

Create `frontend-nextjs/app/workspace/[projectId]/help/[slug]/page.tsx`:

```tsx
'use client'

import { useParams } from 'next/navigation'
import HelpArticle from '@/components/help/HelpArticle'
import HelpShell from '@/components/help/HelpShell'
import { getHelpArticleBody } from '@/components/help/articles'
import { getHelpArticle } from '@/lib/helpCatalog'

export default function HelpArticlePage() {
  const params = useParams<{ projectId: string; slug: string }>()
  const base = `/workspace/${params.projectId}`
  const slug = params.slug
  const article = getHelpArticle(slug)
  const Body = getHelpArticleBody(slug)

  return (
    <HelpShell base={base} slug={slug}>
      <HelpArticle base={base} article={article && Body ? article : undefined}>
        {article && Body ? <Body /> : null}
      </HelpArticle>
    </HelpShell>
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend-nextjs && npx tsc --noEmit`

Expected: 无与 `app/workspace/[projectId]/help/` 相关的新错误。

- [ ] **Step 4: Commit**

```bash
git add "frontend-nextjs/app/workspace/[projectId]/help/page.tsx" "frontend-nextjs/app/workspace/[projectId]/help/[slug]/page.tsx"
git commit -m "$(cat <<'EOF'
feat: add workspace help routes

EOF
)"
```

Skip unless the user asked to commit.

---

### Task 8: 侧栏入口

**Files:**
- Modify: `frontend-nextjs/components/workspace/WorkspaceSidebar.tsx`

**Interfaces:**
- Consumes: `isHelpPath(relPath: string): boolean` from Task 2
- Produces: `</nav>` 之后、`</aside>` 之前的「使用帮助」链接，指向 `${base}/help`，激活态与叶子项相同

- [ ] **Step 1: Import isHelpPath and compute relPath**

Change the workspaceNav import from:

```ts
import { NAV_GROUPS } from '@/components/workspace/workspaceNav'
```

to:

```ts
import { NAV_GROUPS, isHelpPath } from '@/components/workspace/workspaceNav'
```

Immediately after `const base = `/workspace/${params.projectId}`` add:

```ts
  const relPath =
    pathname === base ? '' : pathname.startsWith(base + '/') ? pathname.slice(base.length) : ''
  const helpActive = isHelpPath(relPath)
```

- [ ] **Step 2: Add the footer link**

Replace the closing of the component from:

```tsx
      </nav>
    </aside>
  )
}
```

with:

```tsx
      </nav>
      <div className="border-t border-gray-200 px-2 py-2">
        <Link
          href={`${base}/help`}
          className={`flex items-center gap-2.5 px-2.5 py-2 rounded-md text-[13px] transition-colors ${
            helpActive
              ? 'bg-blue-50 text-blue-600 font-medium'
              : 'text-gray-700 hover:bg-gray-50 hover:text-gray-900'
          }`}
        >
          <i
            className={`fas fa-circle-question w-4 text-center text-xs flex-shrink-0 ${
              helpActive ? 'text-blue-600' : 'text-gray-400'
            }`}
          />
          <span className="truncate">使用帮助</span>
        </Link>
      </div>
    </aside>
  )
}
```

Do not add this item to `NAV_GROUPS`.

- [ ] **Step 3: Confirm placement**

Run: `rg -n "使用帮助|isHelpPath" frontend-nextjs/components/workspace/WorkspaceSidebar.tsx frontend-nextjs/components/workspace/workspaceNav.ts`

Expected: 侧栏有「使用帮助」和 `isHelpPath`；`NAV_GROUPS` 里没有 help href。

- [ ] **Step 4: Typecheck**

Run: `cd frontend-nextjs && npx tsc --noEmit`

Expected: 无与 `WorkspaceSidebar.tsx` 相关的新错误。

- [ ] **Step 5: Commit**

```bash
git add frontend-nextjs/components/workspace/WorkspaceSidebar.tsx
git commit -m "$(cat <<'EOF'
feat: add workspace sidebar help entry

EOF
)"
```

Skip unless the user asked to commit.

---

### Task 9: 回归测试与页面验收

**Files:**
- 无新文件。跑已有单测并在浏览器里走 spec §9 清单。

**Interfaces:**
- Consumes: Task 1–8 的产物
- Produces: 单测全部通过；帮助页可点、可切篇、未知 slug 有空状态

- [ ] **Step 1: Run unit tests**

Run:

```bash
npx tsx frontend-nextjs/lib/helpCatalog.test.ts
npx tsx frontend-nextjs/components/workspace/workspaceNav.test.ts
npx tsx frontend-nextjs/components/help/articles/slugs.test.ts
```

Expected:

```
helpCatalog tests passed
workspaceNav tests passed
help article slugs tests passed
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend-nextjs && npx tsc --noEmit`

Expected: 无本功能引入的新错误。

- [ ] **Step 3: Browser checklist**

用已登录的项目工作区（前端默认 `next dev -p 3006`）逐项确认：

1. 侧栏底部有「使用帮助」，点开首页，左目录 3 组 9 篇。
2. 打开一篇，Tab 只有一个「使用帮助」；再切另一篇，仍是同一 Tab，正文更换。
3. 打开 `/workspace/:id/help/not-a-page`：目录在，右栏「没有这篇文章」。
4. 「去使用」打开对应功能页（另一个 Tab），帮助 Tab 仍在。
5. 直链 `/workspace/:id/help/connecting-apis` 打开对接篇，含基址、鉴权、curl。
6. REST API 页、实时推送页原有文档仍在。

若某条失败，修对应文件后从 Step 1 重跑，不要只改文案应付。

- [ ] **Step 4: Commit**

Only if there were fixes after review and the user asked to commit.

---

## Self-Review

**Spec coverage:**

| Spec | Task |
|------|------|
| `/help` + `/help/:slug`、左目录右文章 | 5, 7 |
| 9 篇文章与 related href | 1, 6 |
| Tab 身份 `/help`、标题「使用帮助」 | 2 |
| KeepAlive 覆盖缓存 | 3 |
| 侧栏底部入口、不进 NAV_GROUPS | 8 |
| 未知 slug 空状态 | 7 |
| catalog / slugs / nav 单测 | 1, 2, 4 |
| 手动验收 | 9 |
| 不接后端、无搜索、无新依赖 | Global Constraints |

**Placeholder scan:** 无 TBD /「类似 Task N」/ 空测试。Commit 步骤保留但受 Global Constraints 约束。

**Type consistency:** `HelpGroupId`、`HelpArticleMeta.related`、`isHelpPath`、`shouldReplaceKeepAliveCache`、`getHelpArticle`、`getHelpArticleBody`、`HELP_ARTICLE_BODY_SLUGS` / `HelpArticleSlug` 在后续任务中的名称与 Task 1–4 一致。
