import assert from 'node:assert/strict'
import { formatRelativeTime } from './utils'

const now = new Date('2026-09-16T12:35:00+08:00').getTime()

assert.equal(formatRelativeTime('2026-09-16T04:00:00.000Z', now), '今天')
assert.equal(formatRelativeTime('2026-09-15T08:49:46.000Z', now), '昨天')
assert.equal(formatRelativeTime('2026-09-14T08:49:46.000Z', now), '2天前')
assert.equal(formatRelativeTime('2026-09-10T08:49:46.000Z', now), '2026/09/10')
assert.equal(
  formatRelativeTime('2026-09-15T23:00:00+08:00', new Date('2026-09-16T01:00:00+08:00').getTime()),
  '昨天',
)

console.log('formatRelativeTime tests passed')
