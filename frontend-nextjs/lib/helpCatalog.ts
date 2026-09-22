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
  { id: 'start', label: 'group.start' },
  { id: 'product', label: 'group.product' },
  { id: 'connect', label: 'group.connect' },
]

export const HELP_ARTICLES: HelpArticleMeta[] = [
  {
    slug: 'getting-started',
    title: 'title.getting-started',
    group: 'start',
    summary: 'summary.getting-started',
    related: [
      { href: '', label: 'rel.projectHome' },
      { href: '/database/tables', label: 'rel.tables' },
      { href: '/api', label: 'rel.restApi' },
    ],
  },
  {
    slug: 'database',
    title: 'title.database',
    group: 'product',
    summary: 'summary.database',
    related: [
      { href: '/database/tables', label: 'rel.tables' },
      { href: '/database/table-designer', label: 'rel.tableDesigner' },
      { href: '/database/query', label: 'rel.sqlEditor' },
    ],
  },
  {
    slug: 'automation',
    title: 'title.automation',
    group: 'product',
    summary: 'summary.automation',
    related: [
      { href: '/automation/workflows', label: 'rel.workflows' },
      { href: '/events/scheduled-tasks', label: 'rel.scheduledTasks' },
      { href: '/database/functions', label: 'rel.functions' },
    ],
  },
  {
    slug: 'api-and-rpc',
    title: 'title.api-and-rpc',
    group: 'product',
    summary: 'summary.api-and-rpc',
    related: [
      { href: '/api', label: 'rel.restApi' },
      { href: '/rpc', label: 'rel.rpcCaller' },
    ],
  },
  {
    slug: 'integrations',
    title: 'title.integrations',
    group: 'product',
    summary: 'summary.integrations',
    related: [
      { href: '/events/datasources', label: 'rel.datasources' },
      { href: '/events/webhooks', label: 'rel.webhook' },
      { href: '/automation/sse-routes', label: 'rel.realtimePush' },
    ],
  },
  {
    slug: 'security',
    title: 'title.security',
    group: 'product',
    summary: 'summary.security',
    related: [
      { href: '/security/roles', label: 'rel.roles' },
      { href: '/security/rls', label: 'rel.rls' },
      { href: '/security/api-keys', label: 'rel.apiKey' },
    ],
  },
  {
    slug: 'diagnostics',
    title: 'title.diagnostics',
    group: 'product',
    summary: 'summary.diagnostics',
    related: [
      { href: '/monitor', label: 'rel.monitorDashboard' },
      { href: '/logs', label: 'rel.execLogs' },
      { href: '/cloud-logs', label: 'rel.cloudLogs' },
    ],
  },
  {
    slug: 'settings',
    title: 'title.settings',
    group: 'product',
    summary: 'summary.settings',
    related: [
      { href: '/settings', label: 'rel.projectInfo' },
      { href: '/settings/members', label: 'rel.members' },
      { href: '/settings/connections', label: 'rel.connections' },
    ],
  },
  {
    slug: 'connecting-apis',
    title: 'title.connecting-apis',
    group: 'connect',
    summary: 'summary.connecting-apis',
    related: [
      { href: '/api', label: 'rel.restApi' },
      { href: '/rpc', label: 'rel.rpcCaller' },
      { href: '/security/api-keys', label: 'rel.apiKey' },
      { href: '/automation/sse-routes', label: 'rel.realtimePush' },
    ],
  },
]

export function getHelpArticle(slug: string): HelpArticleMeta | undefined {
  return HELP_ARTICLES.find((a) => a.slug === slug)
}
