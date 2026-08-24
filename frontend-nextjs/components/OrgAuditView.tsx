'use client'

import { useCallback, useEffect, useState } from 'react'
import api from '@/lib/api'

type Tab = 'audit' | 'slow' | 'raw-sql'

type AuditLog = {
  id: number
  tenant_id: number | null
  user_id: number | null
  action: string
  resource: string
  request_method: string
  request_path: string
  response_status: number | null
  duration_ms: number | null
  created_at: string
}

type SlowQuery = {
  id: number
  database_id: number | null
  schema_name: string | null
  table_name: string | null
  sql_preview: string | null
  duration_ms: number
  created_at: string
}

type RawSqlLog = {
  id: number
  user_id: number | null
  action: string
  request_path: string
  response_status: number | null
  duration_ms: number | null
  created_at: string
  database_id: number | null
  sql_type: string | null
  blocked_reason: string | null
}

export default function OrgAuditView({ organizationId }: { organizationId: number }) {
  const [tab, setTab] = useState<Tab>('audit')
  const [loading, setLoading] = useState(false)
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([])
  const [slowQueries, setSlowQueries] = useState<SlowQuery[]>([])
  const [rawLogs, setRawLogs] = useState<RawSqlLog[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      if (tab === 'audit') {
        const res = await api.get('/api/admin/audit-logs', {
          params: {
            organization_id: organizationId,
            limit: 50,
            offset: page * 50,
          },
        })
        setAuditLogs(res.data.data || [])
        setTotal(res.data.total || 0)
      } else if (tab === 'slow') {
        const res = await api.get('/api/admin/slow-queries', {
          params: { organization_id: organizationId, limit: 50 },
        })
        setSlowQueries(res.data.data || [])
        setTotal(res.data.data?.length || 0)
      } else {
        const res = await api.get('/api/platform/raw-sql-audit', {
          params: {
            organization_id: organizationId,
            limit: 50,
            offset: page * 50,
          },
        })
        setRawLogs(res.data.data || [])
        setTotal(res.data.total || 0)
      }
    } catch {
      setAuditLogs([])
      setSlowQueries([])
      setRawLogs([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [organizationId, tab, page])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-semibold text-gray-900">审计</h1>
        <p className="text-sm text-gray-500 mt-1">
          本租户项目的请求审计、慢查询与原始 SQL（不含平台级操作）。
        </p>
      </header>

      <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5">
        {(
          [
            ['audit', '请求审计'],
            ['slow', '慢查询'],
            ['raw-sql', '原始 SQL'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              setTab(id)
              setPage(0)
            }}
            className={`px-3 py-1.5 text-sm rounded-md ${
              tab === id ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-500'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        {loading ? (
          <div className="px-4 py-12 text-center text-gray-400 text-sm">
            <i className="fas fa-spinner fa-spin mr-2"></i>加载中…
          </div>
        ) : tab === 'audit' ? (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left">时间</th>
                <th className="px-4 py-2 text-left">动作</th>
                <th className="px-4 py-2 text-left">方法</th>
                <th className="px-4 py-2 text-left">路径</th>
                <th className="px-4 py-2 text-left">状态</th>
                <th className="px-4 py-2 text-right">耗时</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {auditLogs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-gray-400">
                    暂无审计记录
                  </td>
                </tr>
              ) : (
                auditLogs.map((l) => (
                  <tr key={l.id}>
                    <td className="px-4 py-2 text-xs font-mono text-gray-500 whitespace-nowrap">
                      {new Date(l.created_at).toLocaleString('zh-CN', { hour12: false })}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{l.action}</td>
                    <td className="px-4 py-2">{l.request_method}</td>
                    <td
                      className="px-4 py-2 text-xs font-mono truncate max-w-md"
                      title={l.request_path}
                    >
                      {l.request_path}
                    </td>
                    <td className="px-4 py-2">{l.response_status ?? '-'}</td>
                    <td className="px-4 py-2 text-right text-xs tabular-nums">
                      {l.duration_ms != null ? `${l.duration_ms}ms` : '-'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        ) : tab === 'slow' ? (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left">时间</th>
                <th className="px-4 py-2 text-left">库</th>
                <th className="px-4 py-2 text-left">SQL</th>
                <th className="px-4 py-2 text-right">耗时</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {slowQueries.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-gray-400">
                    暂无慢查询
                  </td>
                </tr>
              ) : (
                slowQueries.map((q) => (
                  <tr key={q.id}>
                    <td className="px-4 py-2 text-xs font-mono text-gray-500 whitespace-nowrap">
                      {new Date(q.created_at).toLocaleString('zh-CN', { hour12: false })}
                    </td>
                    <td className="px-4 py-2 text-xs">#{q.database_id ?? '-'}</td>
                    <td
                      className="px-4 py-2 text-xs font-mono truncate max-w-lg"
                      title={q.sql_preview || ''}
                    >
                      {q.sql_preview || '-'}
                    </td>
                    <td className="px-4 py-2 text-right text-orange-600 tabular-nums">
                      {q.duration_ms}ms
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left">时间</th>
                <th className="px-4 py-2 text-left">动作</th>
                <th className="px-4 py-2 text-left">类型</th>
                <th className="px-4 py-2 text-left">拦截原因</th>
                <th className="px-4 py-2 text-right">耗时</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rawLogs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-gray-400">
                    暂无原始 SQL 记录
                  </td>
                </tr>
              ) : (
                rawLogs.map((l) => (
                  <tr key={l.id}>
                    <td className="px-4 py-2 text-xs font-mono text-gray-500 whitespace-nowrap">
                      {new Date(l.created_at).toLocaleString('zh-CN', { hour12: false })}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{l.action}</td>
                    <td className="px-4 py-2 text-xs">{l.sql_type || '-'}</td>
                    <td className="px-4 py-2 text-xs text-red-600">
                      {l.blocked_reason || '-'}
                    </td>
                    <td className="px-4 py-2 text-right text-xs tabular-nums">
                      {l.duration_ms != null ? `${l.duration_ms}ms` : '-'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}

        {(tab === 'audit' || tab === 'raw-sql') && total > 50 && (
          <div className="flex items-center justify-between px-4 py-3 border-t bg-gray-50 text-xs text-gray-500">
            <span>共 {total} 条</span>
            <div className="flex gap-2">
              <button
                type="button"
                className="px-3 py-1 border rounded disabled:opacity-40"
                disabled={page <= 0}
                onClick={() => setPage(page - 1)}
              >
                上一页
              </button>
              <button
                type="button"
                className="px-3 py-1 border rounded disabled:opacity-40"
                disabled={(page + 1) * 50 >= total}
                onClick={() => setPage(page + 1)}
              >
                下一页
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
