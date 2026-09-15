const RESERVED_NODE_IDS = new Set(['loop', 'trigger'])
const NODE_ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function validateNodeId(id: string, usedIds: string[], currentId: string): string | null {
  const next = id.trim()
  if (!next) return '节点 ID 不能为空'
  if (RESERVED_NODE_IDS.has(next)) return `节点 ID「${next}」为保留名`
  if (!NODE_ID_RE.test(next)) return '只能用字母、数字、下划线，且不能以数字开头'
  if (next !== currentId && usedIds.includes(next)) return `节点 ID「${next}」已存在`
  return null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function rewriteIdInText(text: string, oldId: string, newId: string): string {
  if (!oldId || oldId === newId) return text
  const e = escapeRegExp(oldId)
  return text
    .replace(new RegExp(`\\{\\{${e}(?=\\.|\\}})`, 'g'), `{{${newId}`)
    .replace(new RegExp(`ctx\\.nodes\\["${e}"\\]`, 'g'), `ctx.nodes["${newId}"]`)
    .replace(new RegExp(`ctx\\.nodes\\['${e}'\\]`, 'g'), `ctx.nodes['${newId}']`)
}

export function rewriteNodeIdRefs(value: unknown, oldId: string, newId: string): unknown {
  if (typeof value === 'string') return rewriteIdInText(value, oldId, newId)
  if (Array.isArray(value)) return value.map((v) => rewriteNodeIdRefs(v, oldId, newId))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewriteNodeIdRefs(v, oldId, newId)
    }
    return out
  }
  return value
}
