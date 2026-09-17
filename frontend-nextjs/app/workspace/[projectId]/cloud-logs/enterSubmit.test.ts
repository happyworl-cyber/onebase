import assert from 'node:assert/strict'
import { shouldSubmitOnKeyDown } from './enterSubmit'

assert.equal(shouldSubmitOnKeyDown({ key: 'Enter' }), true)
assert.equal(shouldSubmitOnKeyDown({ key: 'Enter', nativeEvent: { isComposing: true } }), false)
assert.equal(shouldSubmitOnKeyDown({ key: 'Enter', isComposing: true }), false)
assert.equal(shouldSubmitOnKeyDown({ key: 'a' }), false)

console.log('enterSubmit tests passed')
