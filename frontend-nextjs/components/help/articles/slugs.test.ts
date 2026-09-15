import assert from 'node:assert/strict'
import { HELP_ARTICLES } from '../../../lib/helpCatalog'
import { HELP_ARTICLE_BODY_SLUGS } from './slugs'

assert.deepEqual(
  [...HELP_ARTICLE_BODY_SLUGS].slice().sort(),
  HELP_ARTICLES.map((a) => a.slug).slice().sort(),
)

console.log('help article slugs tests passed')
