import assert from 'node:assert/strict'
import { rewriteIdInText, rewriteNodeIdRefs, validateNodeId } from './nodeId'

assert.equal(validateNodeId('', [], 'a'), '节点 ID 不能为空')
assert.equal(validateNodeId('  ', [], 'a'), '节点 ID 不能为空')
assert.equal(validateNodeId('loop', [], 'a'), "节点 ID「loop」为保留名")
assert.equal(validateNodeId('trigger', [], 'a'), "节点 ID「trigger」为保留名")
assert.equal(validateNodeId('1abc', [], 'a'), '只能用字母、数字、下划线，且不能以数字开头')
assert.equal(validateNodeId('has-dash', [], 'a'), '只能用字母、数字、下划线，且不能以数字开头')
assert.equal(validateNodeId('输出', [], 'a'), '只能用字母、数字、下划线，且不能以数字开头')
assert.equal(validateNodeId('resp_ok', ['resp_ok', 'other'], 'old'), '节点 ID「resp_ok」已存在')
assert.equal(validateNodeId('resp_ok', ['resp_ok'], 'resp_ok'), null)
assert.equal(validateNodeId('resp_ok', ['other'], 'old'), null)

assert.equal(
  rewriteIdInText('{{response_mtvboqddy_2.body}} and {{response_mtvboqddy_2}}', 'response_mtvboqddy_2', 'output'),
  '{{output.body}} and {{output}}',
)
assert.equal(
  rewriteIdInText('{{response_mtvboqddy_2x.body}}', 'response_mtvboqddy_2', 'output'),
  '{{response_mtvboqddy_2x.body}}',
)
assert.equal(
  rewriteIdInText(`ctx.nodes["old"] + ctx.nodes['old']`, 'old', 'neu'),
  `ctx.nodes["neu"] + ctx.nodes['neu']`,
)

const rewritten = rewriteNodeIdRefs(
  { body: '{{old.status}}', nested: { code: 'return ctx.nodes["old"].x' } },
  'old',
  'out',
) as { body: string; nested: { code: string } }
assert.equal(rewritten.body, '{{out.status}}')
assert.equal(rewritten.nested.code, 'return ctx.nodes["out"].x')

console.log('nodeId tests passed')
