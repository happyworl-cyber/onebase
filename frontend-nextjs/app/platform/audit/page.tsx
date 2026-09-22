'use client'

import { useState, useEffect, Fragment } from 'react'
import api from '@/lib/api'
import { useTranslations } from 'next-intl'
import { buildOperationSummary } from '@/lib/operationSummary'

interface PlatformAdminLog {
  id: number
  user_id: number | null
  username: string | null
  email: string | null
  action: string
  category: 'project' | 'workflow' | 'sql' | 'platform'
  operation: string
  summary: string
  resource: string
  request_method: string
  request_path: string
  request_body: Record<string, unknown> | null
  response_status: number | null
  ip_address: string | null
  duration_ms: number | null
  created_at: string
}

interface AuditLog {
  id: number
  user_id: number | null
  action: string
  resource: string
  request_method: string
  request_path: string
  response_status: number | null
  ip_address: string | null
  duration_ms: number | null
  created_at: string
}

interface SlowQuery {
  id: number
  database_id: number | null
  schema_name: string | null
  table_name: string | null
  sql_preview: string | null
  duration_ms: number
  created_at: string
}

interface RawSqlAuditLog {
  id: number
  user_id: number | null
  action: string
  request_method: string
  request_path: string
  response_status: number | null
  duration_ms: number | null
  ip_address: string | null
  created_at: string
  database_id: number | null
  sql_type: string | null
  sql_len: number | null
  read_only: boolean | null
  acknowledge_destructive: boolean | null
  blocked_reason: string | null
  op_count: number | null
}

interface RawSqlStats {
  reason: string
  count: number
}

type Tab = 'platform' | 'audit' | 'slow' | 'raw-sql'

export default function AuditPage() {
  const t = useTranslations('platformAudit')
  const tOp = useTranslations('operationLog')
  const [tab, setTab] = useState<Tab>('platform')
  const [platformLogs, setPlatformLogs] = useState<PlatformAdminLog[]>([])
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([])
  const [slowQueries, setSlowQueries] = useState<SlowQuery[]>([])
  const [rawSqlLogs, setRawSqlLogs] = useState<RawSqlAuditLog[]>([])
  const [rawSqlStats, setRawSqlStats] = useState<RawSqlStats[]>([])
  const [loading, setLoading] = useState(false)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [filters, setFilters] = useState({
    action: '',
    resource: '',
    user_id: '',
  })
  const [platformFilters, setPlatformFilters] = useState({
    resource: '',
    user_id: '',
    category: '',
  })
  const [rawSqlFilters, setRawSqlFilters] = useState({
    action: '',
    user_id: '',
    database_id: '',
    blocked_only: false,
  })

  useEffect(() => {
    if (tab === 'platform') loadPlatformLogs()
    else if (tab === 'audit') loadAuditLogs()
    else if (tab === 'slow') loadSlowQueries()
    else loadRawSqlLogs()
  }, [tab, page])

  const loadPlatformLogs = async () => {
    setLoading(true)
    try {
      const params: Record<string, unknown> = { limit: 50, offset: page * 50 }
      if (platformFilters.resource) params.resource = platformFilters.resource
      if (platformFilters.user_id) params.user_id = parseInt(platformFilters.user_id)
      if (platformFilters.category) params.category = platformFilters.category

      const res = await api.get('/api/platform/admin-audit-logs', { params })
      setPlatformLogs(res.data.data || [])
      setTotal(res.data.total || 0)
    } catch (err) {
      console.error(t('loadPlatformFailed'), err)
    } finally {
      setLoading(false)
    }
  }

  const loadAuditLogs = async () => {
    setLoading(true)
    try {
      const params: Record<string, unknown> = { limit: 50, offset: page * 50 }
      if (filters.action) params.action = filters.action
      if (filters.resource) params.resource = filters.resource
      if (filters.user_id) params.user_id = parseInt(filters.user_id)

      const res = await api.get('/api/admin/audit-logs', { params })
      setAuditLogs(res.data.data || [])
      setTotal(res.data.total || 0)
    } catch (err) {
      console.error(t('loadAuditFailed'), err)
    } finally {
      setLoading(false)
    }
  }

  const loadSlowQueries = async () => {
    setLoading(true)
    try {
      const res = await api.get('/api/admin/slow-queries', { params: { limit: 50 } })
      setSlowQueries(res.data.data || [])
    } catch (err) {
      console.error(t('loadSlowFailed'), err)
    } finally {
      setLoading(false)
    }
  }

  const loadRawSqlLogs = async () => {
    setLoading(true)
    try {
      const params: Record<string, unknown> = { limit: 50, offset: page * 50 }
      if (rawSqlFilters.action) params.action = rawSqlFilters.action
      if (rawSqlFilters.user_id) params.user_id = parseInt(rawSqlFilters.user_id)
      if (rawSqlFilters.database_id) params.database_id = parseInt(rawSqlFilters.database_id)
      if (rawSqlFilters.blocked_only) params.blocked_only = true

      const res = await api.get('/api/platform/raw-sql-audit', { params })
      setRawSqlLogs(res.data.data || [])
      setRawSqlStats(res.data.stats_by_reason || [])
      setTotal(res.data.total || 0)
    } catch (err) {
      console.error(t('loadRawSqlFailed'), err)
    } finally {
      setLoading(false)
    }
  }

  const switchTab = (next: Tab) => {
    setTab(next)
    setPage(0)
    setExpandedId(null)
  }

  const categoryColor = (category: string) => {
    const colors: Record<string, string> = {
      project: 'bg-blue-100 text-blue-800',
      workflow: 'bg-indigo-100 text-indigo-800',
      sql: 'bg-orange-100 text-orange-800',
      platform: 'bg-purple-100 text-purple-800',
    }
    return colors[category] || 'bg-gray-100 text-gray-800'
  }

  const categoryLabel = (category: string) => {
    const labels: Record<string, string> = {
      project: t('typeProject'),
      workflow: t('typeWorkflow'),
      sql: 'SQL',
      platform: t('typePlatform'),
    }
    return labels[category] || category
  }

  const rawSqlActionColor = (action: string) => {
    if (action.includes('BLOCKED')) return 'bg-red-100 text-red-800'
    if (action === 'RAW_SQL_QUERY') return 'bg-orange-100 text-orange-800'
    if (action === 'RAW_SQL_QUERY_DONE') return 'bg-green-100 text-green-800'
    if (action === 'RAW_SQL_TXN') return 'bg-purple-100 text-purple-800'
    return 'bg-gray-100 text-gray-800'
  }

  const methodColor = (method: string) => {
    const colors: Record<string, string> = {
      POST: 'bg-green-100 text-green-800',
      PATCH: 'bg-yellow-100 text-yellow-800',
      PUT: 'bg-yellow-100 text-yellow-800',
      DELETE: 'bg-red-100 text-red-800',
      GET: 'bg-blue-100 text-blue-800',
    }
    return colors[method] || 'bg-gray-100 text-gray-800'
  }

  const statusColor = (status: number | null) => {
    if (!status) return 'text-gray-400'
    if (status < 300) return 'text-green-600'
    if (status < 400) return 'text-yellow-600'
    return 'text-red-600'
  }

  const Pagination = () =>
    total > 50 ? (
      <div className="flex items-center justify-between px-4 py-3 border-t bg-gray-50">
        <span className="text-xs text-gray-500">{t('countLine', { total })}</span>
        <div className="flex space-x-2">
          <button
            onClick={() => setPage(Math.max(0, page - 1))}
            disabled={page === 0}
            className="btn-default text-xs disabled:opacity-50"
          >
            {t('prevPage')}
          </button>
          <button
            onClick={() => setPage(page + 1)}
            disabled={(page + 1) * 50 >= total}
            className="btn-default text-xs disabled:opacity-50"
          >
            {t('nextPage')}
          </button>
        </div>
      </div>
    ) : null

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">{t('title')}</h1>
        <p className="text-sm text-gray-500 mt-1">
          {t('subtitle')}
        </p>
      </div>

      <div className="flex space-x-1 bg-gray-100 p-1 rounded-lg w-fit flex-wrap">
        <button
          onClick={() => switchTab('platform')}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${tab === 'platform' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
        >
          <i className="fas fa-crown mr-2"></i>{t('tabPlatform')}
        </button>
        <button
          onClick={() => switchTab('audit')}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${tab === 'audit' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
        >
          <i className="fas fa-shield-alt mr-2"></i>{t('tabAll')}
        </button>
        <button
          onClick={() => switchTab('slow')}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${tab === 'slow' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
        >
          <i className="fas fa-clock mr-2"></i>{t('tabSlow')}
        </button>
        <button
          onClick={() => switchTab('raw-sql')}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${tab === 'raw-sql' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
        >
          <i className="fas fa-terminal mr-2"></i>{t('tabRawSql')}
        </button>
      </div>

      {tab === 'platform' && (
        <>
          <div className="card p-4">
            <div className="flex flex-wrap items-center gap-3">
              <select
                value={platformFilters.category}
                onChange={(e) => setPlatformFilters({ ...platformFilters, category: e.target.value })}
                className="input-base text-sm"
              >
                <option value="">{t('allTypes')}</option>
                <option value="project">{t('typeProject')}</option>
                <option value="workflow">{t('typeWorkflow')}</option>
                <option value="sql">SQL</option>
                <option value="platform">{t('typePlatformConfig')}</option>
              </select>
              <input
                type="text"
                placeholder={t('pathFilter')}
                value={platformFilters.resource}
                onChange={(e) => setPlatformFilters({ ...platformFilters, resource: e.target.value })}
                className="input-base text-sm flex-1 min-w-[200px]"
              />
              <input
                type="text"
                placeholder={t('userIdFilter')}
                value={platformFilters.user_id}
                onChange={(e) => setPlatformFilters({ ...platformFilters, user_id: e.target.value })}
                className="input-base text-sm w-24"
              />
              <button
                onClick={() => {
                  setPage(0)
                  loadPlatformLogs()
                }}
                className="btn-primary text-sm"
              >
                <i className="fas fa-search mr-1"></i>{t('filter')}
              </button>
            </div>
          </div>

          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('colTime')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('colType')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('colDetail')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('colActor')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('colStatus')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('colElapsed')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">IP</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {loading ? (
                  <tr>
                    <td colSpan={8} className="text-center py-8 text-gray-400">
                      <i className="fas fa-spinner fa-spin mr-2"></i>{t('loading')}
                    </td>
                  </tr>
                ) : platformLogs.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center py-8 text-gray-400">
                      {t('emptyPlatform')}
                    </td>
                  </tr>
                ) : (
                  platformLogs.map((log) => (
                    <Fragment key={log.id}>
                      <tr className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                          {new Date(log.created_at).toLocaleString('zh-CN')}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${categoryColor(log.category)}`}>
                            {categoryLabel(log.category)}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="text-xs text-gray-900 font-medium" title={buildOperationSummary(log, tOp)}>{buildOperationSummary(log, tOp)}</div>
                          <div className="text-[11px] font-mono text-gray-400 mt-0.5 truncate max-w-md" title={log.request_path}>
                            {log.request_method} {log.request_path}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-700">
                          {log.username ? (
                            <span title={log.email ?? undefined}>
                              {log.username}
                              <span className="text-gray-400 ml-1">#{log.user_id}</span>
                            </span>
                          ) : (
                            <span className="text-gray-400">{log.user_id ?? '-'}</span>
                          )}
                        </td>
                        <td className={`px-4 py-3 text-xs font-medium ${statusColor(log.response_status)}`}>
                          {log.response_status ?? '-'}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-600">
                          {log.duration_ms != null ? `${log.duration_ms}ms` : '-'}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500">{log.ip_address ?? '-'}</td>
                        <td className="px-4 py-3 text-xs">
                          {log.request_body && (
                            <button
                              onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                              className="text-blue-600 hover:text-blue-800"
                            >
                              {expandedId === log.id ? t('collapse') : t('expand')}
                            </button>
                          )}
                        </td>
                      </tr>
                      {expandedId === log.id && log.request_body && (
                        <tr>
                          <td colSpan={8} className="px-4 py-3 bg-gray-50">
                            <pre className="text-xs font-mono text-gray-700 overflow-x-auto whitespace-pre-wrap">
                              {JSON.stringify(log.request_body, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))
                )}
              </tbody>
            </table>
            <Pagination />
          </div>
        </>
      )}

      {tab === 'audit' && (
        <>
          <div className="card p-4">
            <div className="flex items-center space-x-4">
              <select
                value={filters.action}
                onChange={(e) => setFilters({ ...filters, action: e.target.value })}
                className="input-base text-sm"
              >
                <option value="">{t('allActions')}</option>
                <option value="POST">POST</option>
                <option value="PATCH">PATCH</option>
                <option value="PUT">PUT</option>
                <option value="DELETE">DELETE</option>
              </select>
              <input
                type="text"
                placeholder={t('resourceFilter')}
                value={filters.resource}
                onChange={(e) => setFilters({ ...filters, resource: e.target.value })}
                className="input-base text-sm flex-1"
              />
              <input
                type="text"
                placeholder={t('userIdFilter')}
                value={filters.user_id}
                onChange={(e) => setFilters({ ...filters, user_id: e.target.value })}
                className="input-base text-sm w-24"
              />
              <button
                onClick={() => {
                  setPage(0)
                  loadAuditLogs()
                }}
                className="btn-primary text-sm"
              >
                <i className="fas fa-search mr-1"></i>{t('filter')}
              </button>
            </div>
          </div>

          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('colTime')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('colMethod')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('colPath')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('colUser')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('colStatus')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('colElapsed')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {loading ? (
                  <tr>
                    <td colSpan={7} className="text-center py-8 text-gray-400">
                      <i className="fas fa-spinner fa-spin mr-2"></i>{t('loading')}
                    </td>
                  </tr>
                ) : auditLogs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center py-8 text-gray-400">
                      {t('emptyAudit')}
                    </td>
                  </tr>
                ) : (
                  auditLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                        {new Date(log.created_at).toLocaleString('zh-CN')}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`px-2 py-0.5 rounded text-xs font-medium ${methodColor(log.request_method)}`}
                        >
                          {log.request_method}
                        </span>
                      </td>
                      <td
                        className="px-4 py-3 text-xs font-mono text-gray-700 max-w-xs truncate"
                        title={log.request_path}
                      >
                        {log.request_path}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-600">{log.user_id ?? '-'}</td>
                      <td className={`px-4 py-3 text-xs font-medium ${statusColor(log.response_status)}`}>
                        {log.response_status ?? '-'}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-600">
                        {log.duration_ms != null ? `${log.duration_ms}ms` : '-'}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">{log.ip_address ?? '-'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <Pagination />
          </div>
        </>
      )}

      {tab === 'raw-sql' && (
        <>
          {rawSqlStats.length > 0 && (
            <div className="card p-4">
              <h3 className="text-sm font-medium text-gray-700 mb-3">{t('blockedDist')}</h3>
              <div className="flex flex-wrap gap-2">
                {rawSqlStats.map((s) => (
                  <span
                    key={s.reason}
                    className={`px-3 py-1 rounded text-xs font-medium ${s.reason === 'ok' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}
                  >
                    {s.reason}: {s.count}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="card p-4">
            <div className="flex flex-wrap items-center gap-3">
              <select
                value={rawSqlFilters.action}
                onChange={(e) => setRawSqlFilters({ ...rawSqlFilters, action: e.target.value })}
                className="input-base text-sm"
              >
                <option value="">{t('allActionsRaw')}</option>
                <option value="RAW_SQL_QUERY">{t('rawEnter')}</option>
                <option value="RAW_SQL_QUERY_DONE">{t('rawDone')}</option>
                <option value="RAW_SQL_QUERY_BLOCKED">{t('rawBlocked')}</option>
                <option value="RAW_SQL_TXN">{t('rawTxn')}</option>
              </select>
              <input
                type="text"
                placeholder={t('userIdFilter')}
                value={rawSqlFilters.user_id}
                onChange={(e) => setRawSqlFilters({ ...rawSqlFilters, user_id: e.target.value })}
                className="input-base text-sm w-24"
              />
              <input
                type="text"
                placeholder={t('dbIdFilter')}
                value={rawSqlFilters.database_id}
                onChange={(e) => setRawSqlFilters({ ...rawSqlFilters, database_id: e.target.value })}
                className="input-base text-sm w-28"
              />
              <label className="inline-flex items-center text-sm text-gray-700 space-x-2">
                <input
                  type="checkbox"
                  checked={rawSqlFilters.blocked_only}
                  onChange={(e) => setRawSqlFilters({ ...rawSqlFilters, blocked_only: e.target.checked })}
                />
                <span>{t('onlyBlocked')}</span>
              </label>
              <button
                onClick={() => {
                  setPage(0)
                  loadRawSqlLogs()
                }}
                className="btn-primary text-sm"
              >
                <i className="fas fa-search mr-1"></i>{t('filter')}
              </button>
            </div>
          </div>

          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('colTime')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('colAction')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('colUser')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">DB</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('colSqlType')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('colLength')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">ACK</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('colBlockReason')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('colElapsed')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {loading ? (
                  <tr>
                    <td colSpan={8} className="text-center py-8 text-gray-400">
                      <i className="fas fa-spinner fa-spin mr-2"></i>{t('loading')}
                    </td>
                  </tr>
                ) : rawSqlLogs.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center py-8 text-gray-400">
                      {t('emptyRawSql')}
                    </td>
                  </tr>
                ) : (
                  rawSqlLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                        {new Date(log.created_at).toLocaleString('zh-CN')}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${rawSqlActionColor(log.action)}`}>
                          {log.action}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-600">{log.user_id ?? '-'}</td>
                      <td className="px-4 py-3 text-xs text-gray-600 font-mono">{log.database_id ?? '-'}</td>
                      <td className="px-4 py-3 text-xs font-mono text-gray-700">{log.sql_type ?? '-'}</td>
                      <td className="px-4 py-3 text-xs text-gray-500">{log.sql_len ?? '-'}</td>
                      <td className="px-4 py-3 text-xs">
                        {log.acknowledge_destructive === true ? (
                          <span className="text-green-700 font-medium">✓</span>
                        ) : log.acknowledge_destructive === false ? (
                          <span className="text-gray-400">✗</span>
                        ) : (
                          <span className="text-gray-300">-</span>
                        )}
                      </td>
                      <td
                        className="px-4 py-3 text-xs text-red-700 font-mono max-w-xs truncate"
                        title={log.blocked_reason ?? ''}
                      >
                        {log.blocked_reason ?? '-'}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-600">
                        {log.duration_ms != null ? `${log.duration_ms}ms` : '-'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <Pagination />
          </div>
        </>
      )}

      {tab === 'slow' && (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('colTime')}</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Schema</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Table</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('colSqlPreview')}</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('colElapsed')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={5} className="text-center py-8 text-gray-400">
                    <i className="fas fa-spinner fa-spin mr-2"></i>{t('loading')}
                  </td>
                </tr>
              ) : slowQueries.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-8 text-gray-400">
                    {t('emptySlow')}
                  </td>
                </tr>
              ) : (
                slowQueries.map((q) => (
                  <tr key={q.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                      {new Date(q.created_at).toLocaleString('zh-CN')}
                    </td>
                    <td className="px-4 py-3 text-xs font-mono text-gray-700">{q.schema_name ?? '-'}</td>
                    <td className="px-4 py-3 text-xs font-mono text-gray-700">{q.table_name ?? '-'}</td>
                    <td
                      className="px-4 py-3 text-xs font-mono text-gray-600 max-w-md truncate"
                      title={q.sql_preview ?? ''}
                    >
                      {q.sql_preview ?? '-'}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${q.duration_ms > 1000 ? 'bg-red-100 text-red-800' : 'bg-yellow-100 text-yellow-800'}`}
                      >
                        {q.duration_ms}ms
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
