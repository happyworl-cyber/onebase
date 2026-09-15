import assert from 'node:assert/strict'
import { MAX_WINDOW_ERROR, MAX_WINDOW_SECS, oversizeWindowError } from './window'

assert.equal(MAX_WINDOW_SECS, 7 * 86400)
assert.equal(oversizeWindowError(undefined, 100), null)
assert.equal(oversizeWindowError(1, 1 + 7 * 86400), null)
assert.equal(oversizeWindowError(1, 1 + 7 * 86400 + 1), MAX_WINDOW_ERROR)
assert.equal(oversizeWindowError(1, 1 + 86401), null)
console.log('ok')
