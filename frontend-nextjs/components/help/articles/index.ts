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
