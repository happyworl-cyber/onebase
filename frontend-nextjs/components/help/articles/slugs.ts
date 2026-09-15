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
