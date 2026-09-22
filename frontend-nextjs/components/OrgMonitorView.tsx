'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import api, { organizationAPI, type ApiRequestConfig } from '@/lib/api'

type OrgStats = {
  audit_calls_24h: number
  audit_errors_24h: number
  slow_queries_24h: number
  exec_total_24h: number
  exec_failed_24h: number
}

type ExecRow = {
  id: number
  trace_id: string
  source: string
  name: string | null
  status: string
  started_at: string
  duration_ms: number | null
  error_brief: string | null
  tenant_id: number | null
}

type ExecStat = { source: string; status: string; count: number }

export default function OrgMonitorView({ organizationId }: { organizationId: number }) {
  const t = useTranslations('orgMonitor')
  const [stats, setStats] = useState<OrgStats | null>(null)
  const [execStats, setExecStats] = useState<ExecStat[]>([])
  const [failed, setFailed] = useState<ExecRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [s, es, fl] = await Promise.all([
        organizationAPI.stats(organizationId),
        // 必须用 /execution-stats；/executions/stats 会被 :trace_id 当成详情查询
        api.get('/api/platform/execution-stats', {
          params: { organization_id: organizationId },
          suppressErrorToast: true,
        } as ApiRequestConfig),
        api.get('/api/platform/executions', {
          params: {
            organization_id: organizationId,
            failed_only: true,
            limit: 20,
          },
          suppressErrorToast: true,
        } as ApiRequestConfig),
      ])
      setStats(s.data)
      const rows = es.data?.stats || []
      setExecStats(Array.isArray(rows) ? rows : [])
      setFailed(fl.data?.data || [])
    } catch {
      setStats(null)
      setExecStats([])
      setFailed([])
    } finally {
      setLoading(false)
    }
  }, [organizationId])

  useEffect(() => {
    load()
  }, [load])

  if (loading) {
    return (
      <p className="text-sm text-gray-400">
        <i className="fas fa-spinner fa-spin mr-2"></i>{t('loadingMonitor')}
      </p>
    )
  }

  const errRate =
    stats && stats.audit_calls_24h > 0
      ? ((stats.audit_errors_24h / stats.audit_calls_24h) * 100).toFixed(1)
      : '0.0'

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">{t('title')}</h1>
          <p className="text-sm text-gray-500 mt-1">{t('subtitle')}</p>
        </div>
        <button type="button" className="text-sm text-blue-600 hover:underline" onClick={load}>
          {t('refresh')}
        </button>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          [t('statApiCalls24h'), stats?.audit_calls_24h ?? 0],
          [t('statErrorRate'), `${errRate}%`],
          [t('statExecFailed24h'), stats?.exec_failed_24h ?? 0],
          [t('statSlowQueries24h'), stats?.slow_queries_24h ?? 0],
        ].map(([label, value]) => (
          <div key={String(label)} className="bg-white border border-gray-200 rounded-lg px-4 py-4">
            <p className="text-xs text-gray-500">{label}</p>
            <p className="text-2xl font-semibold text-gray-900 mt-1 tabular-nums">{value}</p>
          </div>
        ))}
      </div>

      {execStats.length > 0 && (
        <section className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 text-sm font-medium text-gray-800">
            {t('execDistribution24h')}
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left">{t('colSource')}</th>
                <th className="px-4 py-2 text-left">{t('colStatus')}</th>
                <th className="px-4 py-2 text-right">{t('colCount')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {execStats.map((r, i) => (
                <tr key={`${r.source}-${r.status}-${i}`}>
                  <td className="px-4 py-2 font-mono text-xs">{r.source}</td>
                  <td className="px-4 py-2">{r.status}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{r.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 text-sm font-medium text-gray-800">
          {t('recentFailedExec')}
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs text-gray-500">
            <tr>
              <th className="px-4 py-2 text-left">{t('colTime')}</th>
              <th className="px-4 py-2 text-left">{t('colSource')}</th>
              <th className="px-4 py-2 text-left">{t('colName')}</th>
              <th className="px-4 py-2 text-left">{t('colError')}</th>
              <th className="px-4 py-2 text-left">Trace</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {failed.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                  {t('noFailedExec')}
                </td>
              </tr>
            ) : (
              failed.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2 text-xs font-mono text-gray-500 whitespace-nowrap">
                    {new Date(r.started_at).toLocaleString('zh-CN', { hour12: false })}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{r.source}</td>
                  <td className="px-4 py-2 truncate max-w-[160px]">{r.name || '-'}</td>
                  <td
                    className="px-4 py-2 text-xs text-red-600 truncate max-w-[220px]"
                    title={r.error_brief || ''}
                  >
                    {r.error_brief || r.status}
                  </td>
                  <td className="px-4 py-2 text-xs font-mono text-gray-400 truncate max-w-[120px]">
                    {r.trace_id}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  )
}
