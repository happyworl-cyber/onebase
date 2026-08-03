'use client'

/**
 * `/dashboard/[...slug]` —— W2 时代的兜底重定向（catch-all）。
 *
 * W1+W2 之后大部分 /dashboard/* 页面已经搬到 /workspace/[projectId]/* 或
 * /platform/*。但用户的浏览器历史、外部链接、收藏夹仍可能直奔旧路径。本页
 * 的作用就是：根据 path 和当前用户身份，尽可能保留语义地把人送到新位置。
 *
 * 决策表（核心几条）：
 *   - 非超管：永远跳工作空间。能映射到子页面就带上 projectId（从 localStorage
 *     里读 current_project 的 id），不能就跳 /workspace 让用户重选项目。
 *   - 超管：平台级页面（query / slow-queries / …）目前仍保留在 /dashboard，
 *     这里不处理它们；其余仍按 workspace 映射，因为它们在 W2 已经搬走了。
 *
 * 注意：这是 `'use client'` + `router.replace`，不是 server-side redirect——
 * 因为我们要读 localStorage（user / project），server 端拿不到。
 *
 * 维护成本：每次有新页面搬迁，DASHBOARD_TO_WORKSPACE 这张表也得跟着加；
 * 漏一条不致命（会落到 /workspace 让用户重新选），但日志里会看到 fallback。
 */

import { useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'

/**
 * 旧 /dashboard/<key> → 新 /workspace/[projectId]/<value> 的映射。
 * key 必须与 dashboard 子目录名一一对应，value 是 workspace 下相对路径。
 */
const DASHBOARD_TO_WORKSPACE: Record<string, string> = {
  // 数据库组
  tables: 'database/tables',
  visualizer: 'database/visualizer',
  schema: 'database/schemas',
  indexes: 'database/indexes',
  triggers: 'database/triggers',
  functions: 'database/functions',
  extensions: 'database/extensions',
  'table-designer': 'database/table-designer',
  import: 'database/import',
  backup: 'database/backup',
  // 数据库 · 诊断（W3 carryover：从 dashboard 顶层并入 database/ 分组）
  query: 'database/query',
  transaction: 'database/transaction',
  'query-analyzer': 'database/query-analyzer',
  'slow-queries': 'database/slow-queries',
  // 安全组
  rls: 'security/rls',
  roles: 'security/roles',
  'rpc-acl': 'security/rpc-acl',
  // 事件组
  webhooks: 'events/webhooks',
  'scheduled-tasks': 'events/scheduled-tasks',
  'es-connections': 'events/es-connections',
  // 自动化组（W2 之后新增、晚于迁移表，收尾时并入；新家在 workspace automation/ 下）
  workflows: 'automation/workflows',
  'sse-routes': 'automation/sse-routes',
  // 其他
  rpc: 'rpc',
  api: 'api',
  monitor: 'monitor',
  // 设置
  connections: 'settings/connections',
}

/**
 * 残留的 "永远不映射到 workspace" 页面。当前为空——W3 完成后 /dashboard/* 下
 * 已经没有任何功能性子目录，所有 head 都能找到映射；这里留作"以后万一又长
 * 出来一个真正 platform-only 的 dashboard 页"的扩展点。
 */
const PLATFORM_ONLY_LEGACY = new Set<string>()

export default function DashboardCatchAllRedirect() {
  const router = useRouter()
  const params = useParams<{ slug: string[] | string }>()

  useEffect(() => {
    const slugArr = Array.isArray(params.slug)
      ? params.slug
      : params.slug
        ? [params.slug]
        : []
    const head = slugArr[0] ?? ''
    const tail = slugArr.slice(1).join('/')

    // 平台级遗留页面：让原 page.tsx 接管渲染（理论上 Next.js 的 routing 优先级
    // 会先走具体路径，再走 catch-all——所以这里其实不会命中。这里留 early
    // return 主要是文档作用，万一以后路由优先级变了也不至于死循环。
    if (PLATFORM_ONLY_LEGACY.has(head)) {
      return
    }

    // 没找到映射：直接送回工作空间根，由 /workspace 自己决定单项目跳转还是
    // 多项目让用户挑。
    const mapped = DASHBOARD_TO_WORKSPACE[head]
    if (!mapped) {
      router.replace('/workspace')
      return
    }

    // 选 projectId：优先读 localStorage 里上次激活的项目；不存在就丢给
    // /workspace 去做项目选择/单项目自动跳转。
    let projectId: number | null = null
    try {
      const raw = localStorage.getItem('current_project')
      if (raw) {
        const p = JSON.parse(raw)
        if (typeof p?.id === 'number' && p.id > 0) projectId = p.id
      }
    } catch {
      /* localStorage 解析失败就当没有 */
    }

    if (projectId === null) {
      // 让 /workspace 自己决定：0 个项目→ /workspace/no-projects；1 个→直接进入；
      // 多个→列表选择。
      router.replace('/workspace')
      return
    }

    const target = tail
      ? `/workspace/${projectId}/${mapped}/${tail}`
      : `/workspace/${projectId}/${mapped}`
    router.replace(target)
  }, [params.slug, router])

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center text-gray-500">
        <i className="fas fa-spinner fa-spin text-2xl mb-2"></i>
        <p className="text-sm">正在迁移到新的页面位置…</p>
      </div>
    </div>
  )
}
