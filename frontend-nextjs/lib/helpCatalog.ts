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
