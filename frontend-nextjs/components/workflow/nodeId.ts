const RESERVED_NODE_IDS = new Set(['loop', 'trigger'])
const NODE_ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function validateNodeId(id: string, usedIds: string[], currentId: string): string | null {
  const next = id.trim()
  if (!next) return 'Node ID cannot be empty'
  if (RESERVED_NODE_IDS.has(next)) return `Node ID "${next}" is reserved`
  if (!NODE_ID_RE.test(next)) return 'Only letters, digits, and underscores are allowed, and it cannot start with a digit'
  if (next !== currentId && usedIds.includes(next)) return `Node ID "${next}" already exists`
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
