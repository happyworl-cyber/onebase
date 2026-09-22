/**
 * Client-side port of the Rust `describe_operation` / `build_operation_summary`
 * functions in `src/audit_handlers.rs` (lines ~256-486).
 *
 * The backend used to compose a Chinese-only human-readable summary string
 * for each platform admin audit log row and send it down as `summary`.
 * This module reproduces the exact same branching logic on the client so the
 * text can be rendered through next-intl (English + Chinese) instead.
 *
 * IMPORTANT: branch order matters (first match wins) — keep it identical to
 * the Rust source when editing.
 */

export type OperationSummaryRow = {
  action?: string
  request_method?: string
  request_path?: string
  request_body?: any
}

type Translate = (key: string, params?: Record<string, any>) => string

/** Mirrors Rust's `detail_field`: looks at `body.detail[key]` first, then `body[key]`, string values only. */
function detailField(body: any, key: string): string | undefined {
  const nested = body?.detail?.[key]
  if (typeof nested === 'string') return nested
  const top = body?.[key]
  if (typeof top === 'string') return top
  return undefined
}

/** Mirrors Rust's `detail_i64`: looks at `body.detail[key]` first, then `body[key]`, number values only. */
function detailNumber(body: any, key: string): number | undefined {
  const nested = body?.detail?.[key]
  if (typeof nested === 'number') return nested
  const top = body?.[key]
  if (typeof top === 'number') return top
  return undefined
}

/** Port of Rust `describe_operation(method, path, action)`. */
export function describeOperation(method: string, path: string, action: string, t: Translate): string {
  method = method ?? ''
  path = path ?? ''
  action = action ?? ''

  // Rust: `action != method && !action.chars().all(is_ascii_uppercase || '_' || '.')`
  if (action !== method && !/^[A-Z_.]*$/.test(action)) {
    return action.replace(/_/g, ' ')
  }

  if (action.startsWith('WORKFLOW.')) {
    const kind = action.slice('WORKFLOW.'.length)
    switch (kind) {
      case 'CREATE':
        return t('workflowCreate')
      case 'UPDATE':
        return t('workflowUpdate')
      case 'DELETE':
        return t('workflowDelete')
      case 'DUPLICATE':
        return t('workflowDuplicate')
      case 'TRIGGER':
        return t('workflowTrigger')
      case 'RESTORE_VERSION':
        return t('workflowRestoreVersion')
      default:
        return t('workflowOther', { kind: kind.toLowerCase() })
    }
  }

  if (action.startsWith('PLATFORM.TENANT.')) {
    const kind = action.slice('PLATFORM.TENANT.'.length)
    switch (kind) {
      case 'CREATE':
        return t('tenantCreate')
      case 'UPDATE':
        return t('tenantUpdate')
      case 'DELETE':
        return t('tenantDelete')
      default:
        return t('tenantOther', { kind: kind.toLowerCase() })
    }
  }

  if (action.startsWith('RAW_SQL') || action.startsWith('V1_RAW')) {
    if (action === 'RAW_SQL_QUERY' || action === 'V1_RAW_DDL') return t('sqlExecute')
    if (action === 'RAW_SQL_QUERY_DONE' || action === 'V1_RAW_DDL_DONE') return t('sqlExecuteDone')
    if (action.includes('BLOCKED')) return t('sqlBlocked')
    if (action === 'RAW_SQL_TXN') return t('sqlExecuteTxn')
    return t('sqlExecute')
  }

  if (path === '/query' || path === '/transaction') {
    return path === '/transaction' ? t('sqlExecuteTxn') : t('sqlExecute')
  }

  if (path.startsWith('/api/v1/') && path.endsWith('/sql')) {
    return t('sqlExecuteDdl')
  }

  if (path.startsWith('/api/admin/workflows')) {
    if (method === 'POST' && path.includes('/duplicate')) return t('workflowDuplicate')
    if (method === 'POST' && path.includes('/trigger')) return t('workflowTrigger')
    if (method === 'POST' && path.includes('/restore')) return t('workflowRestoreVersion')
    if (method === 'POST') return t('workflowCreate')
    if (method === 'PATCH') return t('workflowUpdate')
    if (method === 'DELETE') return t('workflowDelete')
    return `${method} ${path}`
  }

  if (path.startsWith('/api/admin/tenants/create') || (path === '/api/admin/tenants' && method === 'POST')) {
    return t('tenantCreate')
  }

  if (path.startsWith('/api/admin/tenants/') && method === 'PATCH') {
    return t('tenantUpdate')
  }

  if (path.startsWith('/api/admin/tenants/') && method === 'DELETE') {
    return t('tenantDelete')
  }

  if (path.includes('/status') && method === 'PATCH') {
    return t('tenantUpdateStatus')
  }

  if (path.startsWith('/api/admin/tenants/') && path.includes('/replicas')) {
    if (method === 'POST') return t('replicaAdd')
    if (method === 'PATCH') return t('replicaUpdate')
    if (method === 'DELETE') return t('replicaDelete')
    return `${method} ${path}`
  }

  if (path.includes('/assign-tenant')) {
    return t('userAssignTenant')
  }

  if (path === '/api/admin/users' && method === 'POST') {
    return t('userCreate')
  }

  if (path.startsWith('/api/admin/users/') && path.includes('reset-password')) {
    return t('userResetPassword')
  }

  if (path.startsWith('/api/admin/users/') && method === 'PATCH') {
    return t('userUpdate')
  }

  if (path.startsWith('/api/admin/users/') && method === 'DELETE') {
    return t('userDelete')
  }

  if (path === '/api/admin/tenant-users' && method === 'POST') {
    return t('tenantUserAdd')
  }

  if (path.startsWith('/api/admin/tenant-users/') && method === 'DELETE') {
    return t('tenantUserRemove')
  }

  if (path.startsWith('/api/admin/pg-pools')) {
    if (method === 'POST' && path.endsWith('/test')) return t('pgPoolTest')
    if (method === 'POST') return t('pgPoolCreate')
    if (method === 'PATCH') return t('pgPoolUpdate')
    if (method === 'DELETE') return t('pgPoolDelete')
    return `${method} ${path}`
  }

  if (path.startsWith('/api/admin/scheduled-tasks')) {
    if (method === 'POST' && path.includes('/run-now')) return t('taskRunNow')
    if (method === 'POST' && path.includes('/pause')) return t('taskPause')
    if (method === 'POST' && path.includes('/resume')) return t('taskResume')
    if (method === 'POST') return t('taskCreate')
    if (method === 'PATCH') return t('taskUpdate')
    if (method === 'DELETE') return t('taskDelete')
    return `${method} ${path}`
  }

  if (path.startsWith('/api/platform-tokens')) {
    if (method === 'POST') return t('platformTokenCreate')
    if (method === 'DELETE') return t('platformTokenDelete')
    return `${method} ${path}`
  }

  if (path.startsWith('/api/sso/providers')) {
    if (method === 'POST') return t('ssoProviderCreate')
    if (method === 'PATCH') return t('ssoProviderUpdate')
    if (method === 'DELETE') return t('ssoProviderDelete')
    return `${method} ${path}`
  }

  if (path.startsWith('/api/admin/rate-limit-rules')) {
    if (method === 'POST') return t('rateLimitRuleCreate')
    if (method === 'PATCH') return t('rateLimitRuleUpdate')
    if (method === 'DELETE') return t('rateLimitRuleDelete')
    return `${method} ${path}`
  }

  return `${method} ${path}`
}

/** Port of Rust `build_operation_summary(method, path, action, body)`. */
export function buildOperationSummary(row: OperationSummaryRow, t: Translate): string {
  const method = row?.request_method ?? ''
  const path = row?.request_path ?? ''
  const action = row?.action ?? ''
  const body = row?.request_body

  const base = describeOperation(method, path, action, t)

  const blockedReason = body?.blocked_reason
  if (typeof blockedReason === 'string' && blockedReason !== '') {
    const sqlType = typeof body?.sql_type === 'string' ? body.sql_type : 'SQL'
    return `${base}${t('sqlBlockedSuffix', { type: sqlType, reason: blockedReason })}`
  }

  const isSqlOperation =
    action.startsWith('RAW_SQL') ||
    action.startsWith('V1_RAW') ||
    path === '/query' ||
    path === '/transaction' ||
    (path.startsWith('/api/v1/') && path.endsWith('/sql'))

  if (isSqlOperation) {
    const sqlType = typeof body?.sql_type === 'string' ? body.sql_type : 'SQL'
    const sqlLen = typeof body?.sql_len === 'number' ? body.sql_len : 0
    const dbId = detailNumber(body, 'database_id')
    const opCount = typeof body?.op_count === 'number' ? body.op_count : undefined
    const dbPart = dbId !== undefined ? t('dbSuffix', { id: dbId }) : ''

    if (opCount !== undefined) {
      return `${base}${t('sqlSuffixOps', { type: sqlType, n: opCount, len: sqlLen })}${dbPart}`
    }
    return `${base}${t('sqlSuffix', { type: sqlType, len: sqlLen })}${dbPart}`
  }

  const name = detailField(body, 'name')
  if (name !== undefined) {
    const slug = detailField(body, 'slug')
    if (!slug) {
      return `${base}${t('nameSuffix', { name })}`
    }
    return `${base}${t('nameSlugSuffix', { name, slug })}`
  }

  const slugOnly = detailField(body, 'slug')
  if (slugOnly !== undefined) {
    return `${base}${t('slugSuffix', { slug: slugOnly })}`
  }

  const workflowId = detailNumber(body, 'workflow_id')
  if (workflowId !== undefined) {
    return `${base} #${workflowId}`
  }

  const tenantId = detailNumber(body, 'tenant_id')
  if (tenantId !== undefined) {
    return `${base} #${tenantId}`
  }

  return base
}
