import assert from 'node:assert/strict'
import { runDetailFetchId } from './runDetailLoad'

const loaded = new Set<number>([2])

assert.equal(runDetailFetchId(1, false, loaded), null)
assert.equal(runDetailFetchId(2, true, loaded), null)
assert.equal(runDetailFetchId(1, true, loaded), 1)

console.log('runDetailLoad tests passed')
