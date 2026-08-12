import { useCurrentProjectCapabilities } from '@/lib/permissions'

/**
 * 工作区导航元数据（单一信源）。
 *
 * 原本 NAV_GROUPS 内联在 WorkspaceSidebar.tsx 里；引入多 Tab 后，Tab 栏也要
 * 用同一份「路径 → 标题 / 图标」的映射来渲染 Tab。抽到这里让侧栏与 Tab 栏共用，
 * 避免两处各维护一份、图标/文案对不上。
 *
 * href 均为相对项目 base（`/workspace/:projectId`）的路径，'' 表示项目首页。
 */

export type Caps = ReturnType<typeof useCurrentProjectCapabilities>

export interface NavItem {
  label: string
  href: string
  icon: string
  /** 该 item 独立可见条件；缺省即跟随分组可见性 */
  visibleIf?: (caps: Caps) => boolean
}

export interface NavGroup {
  label: string
  icon: string
  items: NavItem[]
  /** 该组整体显示门槛；缺省即根据 items 至少有一项可见来判定 */
  visibleIf?: (caps: Caps) => boolean
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: '概览',
    icon: 'fas fa-home',
    items: [{ label: '项目首页', href: '', icon: 'fas fa-home' }],
  },
  {
    // W6（2026-07）：数据库组回归"数据对象 + 直接操作"的完整语义。
    //   · SQL 编辑器 / 事务编辑器从「诊断与监控」搬回——它们是对库的写操作工具，
    //     不是只读观测；诊断组只保留纯观测（监控 / 分析 / 慢查询 / 锁）。
    //   · Schema 浏览器 / 索引 / 扩展 / 数据导入 / 备份与恢复：页面早已实现，但此前
    //     只能靠旧 /dashboard 链接进入，侧栏无入口——本次补齐。
    // 沿用本组约定：数据库页面不设 visibleIf（对成员可见），真实写权限由页面 / 后端收口。
    label: '数据库',
    icon: 'fas fa-database',
    items: [
      { label: '表', href: '/database/tables', icon: 'fas fa-table' },
      // M3 可视化建表入口：放在「表」「关系图」之间，与现状心智一致——
      // 用户先看到表清单，再看可视化关系图，最后才是"我想新建/改结构"这种偏写操作。
      { label: '表设计器', href: '/database/table-designer', icon: 'fas fa-pen-ruler' },
      { label: '关系图', href: '/database/visualizer', icon: 'fas fa-project-diagram' },
      { label: 'Schema 浏览器', href: '/database/schemas', icon: 'fas fa-sitemap' },
      { label: '索引', href: '/database/indexes', icon: 'fas fa-list-ol' },
      { label: '扩展', href: '/database/extensions', icon: 'fas fa-puzzle-piece' },
      // 从「诊断与监控」搬回：直接对库执行 SQL / 事务，属写操作工具。
      { label: 'SQL 编辑器', href: '/database/query', icon: 'fas fa-terminal' },
      { label: '事务编辑器', href: '/database/transaction', icon: 'fas fa-layer-group' },
      { label: '数据导入', href: '/database/import', icon: 'fas fa-file-import' },
      { label: '备份与恢复', href: '/database/backup', icon: 'fas fa-hdd' },
    ],
  },
  {
    // W5：把"在 DB 里跑的执行逻辑"全部归到这里。函数 / 触发器原本归在
    // 「数据库」（按对象分类），定时任务原本归在「事件」（按出口分类）——
    // 三者的实际心智是"配一段逻辑，由 DB / 调度器替我执行"，应该同组。
    label: '自动化',
    icon: 'fas fa-bolt',
    items: [
      { label: '函数', href: '/database/functions', icon: 'fas fa-code' },
      { label: '触发器', href: '/database/triggers', icon: 'fas fa-bell' },
      {
        label: '工作流',
        href: '/automation/workflows',
        icon: 'fas fa-diagram-project',
        visibleIf: (caps) => caps.canManageEvents,
      },
      {
        label: '定时任务',
        href: '/events/scheduled-tasks',
        icon: 'fas fa-clock',
        visibleIf: (caps) => caps.canManageEvents,
      },
      {
        label: '会话规则',
        href: '/automation/session-rules',
        icon: 'fas fa-sliders-h',
        visibleIf: (caps) => caps.canManageEvents,
      },
    ],
  },
  {
    label: 'API & RPC',
    icon: 'fas fa-plug',
    items: [
      { label: 'REST API', href: '/api', icon: 'fas fa-cloud' },
      { label: 'RPC 调用器', href: '/rpc', icon: 'fas fa-terminal' },
    ],
  },
  {
    // W5：原「事件」组改名「集成」，移走定时任务后只剩对外通道。
    // W6：补齐「实时推送」（sse-routes / 实时推送规则）——它与 Webhook（推）、
    // ES 代理（转发）同属"对外通道"，此前无侧栏入口，现归入本组。
    label: '集成',
    icon: 'fas fa-share-alt',
    visibleIf: (caps) => caps.canManageEvents,
    items: [
      // 数据源（+凭证）：工作流 db 节点可引用的项目内共享数据库连接。
      { label: '数据源', href: '/events/datasources', icon: 'fas fa-plug-circle-bolt' },
      { label: 'Webhook', href: '/events/webhooks', icon: 'fas fa-broadcast-tower' },
      { label: '实时推送', href: '/automation/sse-routes', icon: 'fas fa-satellite-dish' },
      { label: 'ES 代理', href: '/events/es-connections', icon: 'fas fa-search-plus' },
      { label: 'Redis', href: '/events/redis-connections', icon: 'fas fa-database' },
      { label: 'Kafka', href: '/events/kafka-connections', icon: 'fas fa-stream' },
      { label: '对象存储', href: '/events/object-storage-connections', icon: 'fas fa-cloud' },
    ],
  },
  {
    label: '安全',
    icon: 'fas fa-user-shield',
    visibleIf: (caps) => caps.canManageSecurity,
    items: [
      { label: '角色', href: '/security/roles', icon: 'fas fa-users-cog' },
      { label: 'RLS', href: '/security/rls', icon: 'fas fa-shield-alt' },
      { label: 'RPC ACL', href: '/security/rpc-acl', icon: 'fas fa-key' },
      { label: '身份提供方', href: '/security/idp', icon: 'fas fa-id-badge' },
      { label: 'API Key', href: '/security/api-keys', icon: 'fas fa-fingerprint' },
      {
        label: '网关策略',
        href: '/gateway',
        icon: 'fas fa-shield-halved',
        visibleIf: (caps) => caps.canManageSecurity,
      },
    ],
  },
  {
    // W5：原「诊断」+「监控」合并。W6：把 SQL / 事务编辑器（写操作）搬回
    // 「数据库」组后，本组只剩"读 / 观测 / 排障"——语义更纯，与上面"写 / 配置"
    // 分组彻底分层。顺序：先看现状（监控大盘 / 执行日志）→ 看性能与阻塞
    // （语句分析 / 慢查询 / 锁与阻塞）。
    label: '诊断与监控',
    icon: 'fas fa-stethoscope',
    items: [
      { label: '监控大盘', href: '/monitor', icon: 'fas fa-chart-line' },
      {
        label: '执行日志',
        href: '/logs',
        icon: 'fas fa-stream',
        visibleIf: (caps) => caps.canManageSecurity,
      },
      {
        label: '操作日志',
        href: '/operation-logs',
        icon: 'fas fa-clipboard-list',
        visibleIf: (caps) => caps.canManageSecurity,
      },
      { label: '语句分析', href: '/database/query-analyzer', icon: 'fas fa-tachometer-alt' },
      { label: '慢查询', href: '/database/slow-queries', icon: 'fas fa-hourglass-half' },
      { label: '锁与阻塞', href: '/database/locks', icon: 'fas fa-lock' },
    ],
  },
  {
    label: '设置',
    icon: 'fas fa-cog',
    items: [
      {
        label: '项目信息',
        href: '/settings',
        icon: 'fas fa-id-card',
        visibleIf: (caps) => caps.canManageProjectSettings,
      },
      {
        label: '成员管理',
        href: '/settings/members',
        icon: 'fas fa-users',
        visibleIf: (caps) => caps.canManageMembers,
      },
      {
        label: '环境变量',
        href: '/settings/env-vars',
        icon: 'fas fa-sliders-h',
        visibleIf: (caps) => caps.canManageMembers,
      },
      {
        label: '数据库连接',
        href: '/settings/connections',
        icon: 'fas fa-database',
        visibleIf: (caps) => caps.canManageProjectSettings,
      },
      {
        label: '网关域名',
        href: '/settings/gateway',
        icon: 'fas fa-globe',
        visibleIf: (caps) => caps.canManageMembers,
      },
    ],
  },
]

/** 所有 nav item 扁平化，供路径 → 元数据解析使用。 */
const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items)

export interface NavMeta {
  label: string
  icon: string
}

/**
 * 相对路径 → { label, icon }。给 Tab 栏渲染标题 / 图标用。
 *
 * 解析顺序：
 *   1) 精确命中某个 nav item；
 *   2) 前缀命中（覆盖详情页 /xxx/:id 等子路由），取「最长匹配」项；
 *   3) 兜底：用末段路径生成一个可读标题，图标给默认。
 */
export function resolveNavMeta(relPath: string): NavMeta {
  const exact = ALL_NAV_ITEMS.find((it) => it.href === relPath)
  if (exact) return { label: exact.label, icon: exact.icon }

  if (relPath !== '') {
    let best: NavItem | null = null
    for (const it of ALL_NAV_ITEMS) {
      if (it.href === '') continue
      if (relPath === it.href || relPath.startsWith(it.href + '/')) {
        if (!best || it.href.length > best.href.length) best = it
      }
    }
    if (best) return { label: best.label, icon: best.icon }
  }

  const seg = relPath.split('/').filter(Boolean).pop() || '页面'
  return { label: seg, icon: 'fas fa-file' }
}
