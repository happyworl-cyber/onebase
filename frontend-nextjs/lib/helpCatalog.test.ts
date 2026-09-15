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
