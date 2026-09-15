import assert from 'node:assert/strict'
import {
  isHelpPath,
  resolveNavMeta,
  shouldReplaceKeepAliveCache,
  tabIdentity,
} from './workspaceNav'

assert.equal(isHelpPath('/help'), true)
assert.equal(isHelpPath('/help/getting-started'), true)
assert.equal(isHelpPath('/api'), false)
assert.equal(isHelpPath('/help-me'), false)

assert.equal(tabIdentity('/help'), '/help')
assert.equal(tabIdentity('/help/getting-started'), '/help')
assert.equal(
  tabIdentity('/automation/workflows/3/versions/2'),
  '/automation/workflows/3/versions',
)

assert.deepEqual(resolveNavMeta('/help'), {
  label: '使用帮助',
  icon: 'fas fa-circle-question',
})
assert.deepEqual(resolveNavMeta('/help/getting-started'), {
  label: '使用帮助',
  icon: 'fas fa-circle-question',
})
assert.equal(resolveNavMeta('/automation/workflows/3/versions').label, '工作流版本')

assert.equal(shouldReplaceKeepAliveCache('/help/connecting-apis'), true)
assert.equal(shouldReplaceKeepAliveCache('/automation/workflows/1/versions'), true)
assert.equal(shouldReplaceKeepAliveCache('/api'), false)

console.log('workspaceNav tests passed')
