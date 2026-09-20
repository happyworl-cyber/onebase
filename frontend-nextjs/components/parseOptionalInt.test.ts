import assert from 'node:assert/strict'
import { parseOptionalInt, parsePoolSettings } from './parseOptionalInt'

assert.equal(parseOptionalInt(''), '')
assert.equal(parseOptionalInt('   '), '')
assert.equal(parseOptionalInt('30'), 30)
assert.equal(parseOptionalInt('8'), 8)
assert.equal(parseOptionalInt('abc'), '')
assert.equal(parseOptionalInt('1.5'), '')
assert.equal(parseOptionalInt('1e2'), '')
assert.equal(parseOptionalInt('12px'), '')
assert.equal(parseOptionalInt('1'), 1)

assert.deepEqual(parsePoolSettings('', 8, 50), { ok: false, text: '最大连接数必须在 1–50' })
assert.deepEqual(parsePoolSettings(30, '', 50), { ok: false, text: '获取超时必须在 1–600 秒' })
assert.deepEqual(parsePoolSettings(30, 8, 50), { ok: true, max: 30, timeout: 8 })
assert.equal(parsePoolSettings(0, 8, 50).ok, false)
assert.equal(parsePoolSettings(51, 8, 50).ok, false)

console.log('parseOptionalInt tests passed')
