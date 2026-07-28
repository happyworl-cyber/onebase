'use client'

import { useState, useEffect } from 'react'
import api from '@/lib/api'

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

export default function AuditPage() {
  const [tab, setTab] = useState<'audit' | 'slow' | 'raw-sql'>('audit')
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([])
  const [slowQueries, setSlowQueries] = useState<SlowQuery[]>([])
  const [rawSqlLogs, setRawSqlLogs] = useState<RawSqlAuditLog[]>([])
  const [rawSqlStats, setRawSqlStats] = useState<RawSqlStats[]>([])
  const [loading, setLoading] = useState(false)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [filters, setFilters] = useState({
    action: '',
    resource: '',
    user_id: '',
  })
  const [rawSqlFilters, setRawSqlFilters] = useState({
    action: '',
    user_id: '',
    database_id: '',
    blocked_only: false,
  })

  useEffect(() => {
    if (tab === 'audit') loadAuditLogs()
    else if (tab === 'slow') loadSlowQueries()
    else loadRawSqlLogs()
  }, [tab, page])

  const loadAuditLogs = async () => {
    setLoading(true)
    try {
      const params: any = { limit: 50, offset: page * 50 }
      if (filters.action) params.action = filters.action
      if (filters.resource) params.resource = filters.resource
      if (filters.user_id) params.user_id = parseInt(filters.user_id)

      const res = await api.get('/api/admin/audit-logs', { params })
      setAuditLogs(res.data.data || [])
      setTotal(res.data.total || 0)
    } catch (err) {
      console.error('加载审计日志失败:', err)
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
      console.error('加载慢查询失败:', err)
    } finally {
      setLoading(false)
    }
  }

  const loadRawSqlLogs = async () => {
    setLoading(true)
    try {
      const params: any = { limit: 50, offset: page * 50 }
      if (rawSqlFilters.action) params.action = rawSqlFilters.action
      if (rawSqlFilters.user_id) params.user_id = parseInt(rawSqlFilters.user_id)
      if (rawSqlFilters.database_id) params.database_id = parseInt(rawSqlFilters.database_id)
      if (rawSqlFilters.blocked_only) params.blocked_only = true

      const res = await api.get('/api/platform/raw-sql-audit', { params })
      setRawSqlLogs(res.data.data || [])
      setRawSqlStats(res.data.stats_by_reason || [])
      setTotal(res.data.total || 0)
    } catch (err) {
      console.error('加载原始 SQL 审计失败:', err)
    } finally {
      setLoading(false)
    }
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">审计日志</h1>
        <p className="text-sm text-gray-500 mt-1">查看所有 API 操作和慢查询记录</p>
      </div>

      {/* Tab 切换 */}
      <div className="flex space-x-1 bg-gray-100 p-1 rounded-lg w-fit">
        <button
          onClick={() => { setTab('audit'); setPage(0); }}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${tab === 'audit' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
        >
          <i className="fas fa-shield-alt mr-2"></i>审计日志
        </button>
        <button
          onClick={() => { setTab('slow'); setPage(0); }}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${tab === 'slow' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
        >
          <i className="fas fa-clock mr-2"></i>慢查询
        </button>
        <button
          onClick={() => { setTab('raw-sql'); setPage(0); }}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${tab === 'raw-sql' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
        >
          <i className="fas fa-terminal mr-2"></i>原始 SQL 审计
        </button>
      </div>

      {tab === 'audit' && (
        <>
          {/* 筛选 */}
          <div className="card p-4">
            <div className="flex items-center space-x-4">
              <select
                value={filters.action}
                onChange={(e) => setFilters({ ...filters, action: e.target.value })}
                className="input-base text-sm"
              >
                <option value="">全部操作</option>
                <option value="POST">POST</option>
                <option value="PATCH">PATCH</option>
                <option value="PUT">PUT</option>
                <option value="DELETE">DELETE</option>
              </select>
              <input
                type="text"
                placeholder="资源路径筛选..."
                value={filters.resource}
                onChange={(e) => setFilters({ ...filters, resource: e.target.value })}
                className="input-base text-sm flex-1"
              />
              <input
                type="text"
                placeholder="用户 ID"
                value={filters.user_id}
                onChange={(e) => setFilters({ ...filters, user_id: e.target.value })}
                className="input-base text-sm w-24"
              />
              <button onClick={() => { setPage(0); loadAuditLogs(); }} className="btn-primary text-sm">
                <i className="fas fa-search mr-1"></i>筛选
              </button>
            </div>
          </div>

          {/* 审计列表 */}
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">时间</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">方法</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">路径</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">用户</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">状态</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">耗时</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {loading ? (
                  <tr><td colSpan={7} className="text-center py-8 text-gray-400">
                    <i className="fas fa-spinner fa-spin mr-2"></i>加载中...
                  </td></tr>
                ) : auditLogs.length === 0 ? (
                  <tr><td colSpan={7} className="text-center py-8 text-gray-400">暂无审计记录</td></tr>
                ) : (
                  auditLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                        {new Date(log.created_at).toLocaleString('zh-CN')}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${methodColor(log.request_method)}`}>
                          {log.request_method}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs font-mono text-gray-700 max-w-xs truncate" title={log.request_path}>
                        {log.request_path}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-600">
                        {log.user_id ?? '-'}
                      </td>
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

            {total > 50 && (
              <div className="flex items-center justify-between px-4 py-3 border-t bg-gray-50">
                <span className="text-xs text-gray-500">共 {total} 条</span>
                <div className="flex space-x-2">
                  <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0} className="btn-default text-xs disabled:opacity-50">上一页</button>
                  <button onClick={() => setPage(page + 1)} disabled={(page + 1) * 50 >= total} className="btn-default text-xs disabled:opacity-50">下一页</button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'raw-sql' && (
        <>
          {/* 顶部统计卡片 */}
          {rawSqlStats.length > 0 && (
            <div className="card p-4">
              <h3 className="text-sm font-medium text-gray-700 mb-3">按 blocked_reason 分布（当前筛选条件下）</h3>
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

          {/* 筛选 */}
          <div className="card p-4">
            <div className="flex flex-wrap items-center gap-3">
              <select
                value={rawSqlFilters.action}
                onChange={(e) => setRawSqlFilters({ ...rawSqlFilters, action: e.target.value })}
                className="input-base text-sm"
              >
                <option value="">全部动作</option>
                <option value="RAW_SQL_QUERY">RAW_SQL_QUERY (进入)</option>
                <option value="RAW_SQL_QUERY_DONE">RAW_SQL_QUERY_DONE (成功)</option>
                <option value="RAW_SQL_QUERY_BLOCKED">RAW_SQL_QUERY_BLOCKED (被拦)</option>
                <option value="RAW_SQL_TXN">RAW_SQL_TXN (事务)</option>
              </select>
              <input
                type="text"
                placeholder="用户 ID"
                value={rawSqlFilters.user_id}
                onChange={(e) => setRawSqlFilters({ ...rawSqlFilters, user_id: e.target.value })}
                className="input-base text-sm w-24"
              />
              <input
                type="text"
                placeholder="数据库 ID"
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
                <span>仅看被拦截</span>
              </label>
              <button onClick={() => { setPage(0); loadRawSqlLogs(); }} className="btn-primary text-sm">
                <i className="fas fa-search mr-1"></i>筛选
              </button>
            </div>
          </div>

          {/* 列表 */}
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">时间</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">动作</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">用户</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">DB</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">SQL 类型</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">长度</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">ACK</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">拦截原因</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">耗时</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {loading ? (
                  <tr><td colSpan={9} className="text-center py-8 text-gray-400">
                    <i className="fas fa-spinner fa-spin mr-2"></i>加载中...
                  </td></tr>
                ) : rawSqlLogs.length === 0 ? (
                  <tr><td colSpan={9} className="text-center py-8 text-gray-400">暂无原始 SQL 记录</td></tr>
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
                      <td className="px-4 py-3 text-xs text-red-700 font-mono max-w-xs truncate" title={log.blocked_reason ?? ''}>
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

            {total > 50 && (
              <div className="flex items-center justify-between px-4 py-3 border-t bg-gray-50">
                <span className="text-xs text-gray-500">共 {total} 条</span>
                <div className="flex space-x-2">
                  <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0} className="btn-default text-xs disabled:opacity-50">上一页</button>
                  <button onClick={() => setPage(page + 1)} disabled={(page + 1) * 50 >= total} className="btn-default text-xs disabled:opacity-50">下一页</button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'slow' && (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">时间</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Schema</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Table</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">SQL 预览</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">耗时</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {loading ? (
                <tr><td colSpan={5} className="text-center py-8 text-gray-400">
                  <i className="fas fa-spinner fa-spin mr-2"></i>加载中...
                </td></tr>
              ) : slowQueries.length === 0 ? (
                <tr><td colSpan={5} className="text-center py-8 text-gray-400">暂无慢查询记录</td></tr>
              ) : (
                slowQueries.map((q) => (
                  <tr key={q.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                      {new Date(q.created_at).toLocaleString('zh-CN')}
                    </td>
                    <td className="px-4 py-3 text-xs font-mono text-gray-700">{q.schema_name ?? '-'}</td>
                    <td className="px-4 py-3 text-xs font-mono text-gray-700">{q.table_name ?? '-'}</td>
                    <td className="px-4 py-3 text-xs font-mono text-gray-600 max-w-md truncate" title={q.sql_preview ?? ''}>
                      {q.sql_preview ?? '-'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${q.duration_ms > 1000 ? 'bg-red-100 text-red-800' : 'bg-yellow-100 text-yellow-800'}`}>
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
