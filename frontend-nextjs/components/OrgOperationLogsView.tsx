'use client'

/**
 * 租户控制台操作日志：聚合组织下属全部项目。
 * UI 对齐项目级 `/workspace/.../operation-logs`，多一列「项目」与项目筛选。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  orgOperationLogAPI,
  type OperationLogRow,
  type OperationLogStats,
  type OperationLogDetail,
  type OperationLogActor,
  type OperationLogFilterParams,
} from '@/lib/api'

const ACTION_META: Record<string, { label: string; cls: string }> = {
  CREATE: { label: 'actCreate', cls: 'bg-green-100 text-green-800' },
  UPDATE: { label: 'actUpdate', cls: 'bg-blue-100 text-blue-800' },
  DELETE: { label: 'actDelete', cls: 'bg-red-100 text-red-800' },
  READ: { label: 'actRead', cls: 'bg-gray-100 text-gray-800' },
  EXPORT: { label: 'actExport', cls: 'bg-orange-100 text-orange-800' },
  IMPORT: { label: 'actImport', cls: 'bg-purple-100 text-purple-800' },
  LOGIN: { label: 'actLogin', cls: 'bg-cyan-100 text-cyan-800' },
  PERMISSION: { label: 'actPermission', cls: 'bg-amber-100 text-amber-800' },
  TRIGGER: { label: 'actTrigger', cls: 'bg-teal-100 text-teal-800' },
  EXECUTE: { label: 'actExecute', cls: 'bg-indigo-100 text-indigo-800' },
}
const actionMeta = (a: string) => ACTION_META[a] || { label: '', cls: 'bg-gray-100 text-gray-800' }

type Tab = 'all' | 'failed' | 'highRisk' | 'mine'
const PAGE_SIZE = 20

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return iso
  }
}

export type OrgProjectOpt = { id: number; name: string; slug?: string | null }

export default function OrgOperationLogsView({
  organizationId,
  projects,
}: {
  organizationId: number
  projects: OrgProjectOpt[]
}) {
  const t = useTranslations('orgOpLogs')
  const actionLabel = useCallback(
    (code: string) => {
      const m = ACTION_META[code]
      return m ? t(m.label) : code
    },
    [t],
  )
  const [rows, setRows] = useState<OperationLogRow[]>([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState<OperationLogStats | null>(null)
  const [actors, setActors] = useState<OperationLogActor[]>([])
  const [facets, setFacets] = useState<{ actions: string[]; resource_types: string[] }>({
    actions: [],
    resource_types: [],
  })
  const [loading, setLoading] = useState(false)
  const [forbidden, setForbidden] = useState(false)
  const [page, setPage] = useState(0)
  const [tab, setTab] = useState<Tab>('all')
  const [detail, setDetail] = useState<OperationLogDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [projectId, setProjectId] = useState('')

  const [filters, setFilters] = useState({
    actor_name: '',
    action: '',
    resource_type: '',
    q_resource: '',
    start_date: '',
    end_date: '',
  })
  const [applied, setApplied] = useState(filters)

  const baseParams: OperationLogFilterParams = useMemo(
    () => ({
      actor_name: applied.actor_name || undefined,
      action: applied.action || undefined,
      resource_type: applied.resource_type || undefined,
      q_resource: applied.q_resource || undefined,
      start_date: applied.start_date || undefined,
      end_date: applied.end_date || undefined,
      project_id: projectId ? Number(projectId) : undefined,
    }),
    [applied, projectId],
  )

  const loadList = useCallback(async () => {
    if (!organizationId) return
    setLoading(true)
    try {
      const res = await orgOperationLogAPI.list(organizationId, {
        ...baseParams,
        tab,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      })
      setRows(res.data.data || [])
      setTotal(res.data.total || 0)
      setForbidden(false)
    } catch (err) {
      if ((err as { response?: { status?: number } })?.response?.status === 403) {
        setForbidden(true)
      }
    } finally {
      setLoading(false)
    }
  }, [organizationId, baseParams, tab, page])

  const loadStats = useCallback(async () => {
    if (!organizationId) return
    try {
      const res = await orgOperationLogAPI.stats(organizationId, baseParams)
      setStats(res.data)
    } catch {
      /* ignore */
    }
  }, [organizationId, baseParams])

  useEffect(() => {
    loadList()
  }, [loadList])
  useEffect(() => {
    loadStats()
  }, [loadStats])
  useEffect(() => {
    if (!organizationId) return
    orgOperationLogAPI
      .actors(organizationId)
      .then((r) => setActors(r.data.data || []))
      .catch(() => {})
    orgOperationLogAPI
      .facets(organizationId)
      .then((r) =>
        setFacets({
          actions: r.data.actions || [],
          resource_types: r.data.resource_types || [],
        }),
      )
      .catch(() => {})
  }, [organizationId])

  const applyFilters = () => {
    setPage(0)
    setApplied(filters)
  }

  const openDetail = async (id: number) => {
    setDetailLoading(true)
    setDetail(null)
    try {
      const res = await orgOperationLogAPI.detail(organizationId, id)
      setDetail(res.data)
    } finally {
      setDetailLoading(false)
    }
  }

  const doExport = async () => {
    try {
      const res = await orgOperationLogAPI.export(organizationId, { ...baseParams, tab })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url
      a.download = `org-${organizationId}-operation-logs-${Date.now()}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      /* toast */
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  if (forbidden) {
    return (
      <div className="text-center py-16">
        <i className="fas fa-lock text-3xl text-amber-500 mb-3"></i>
        <p className="text-sm text-gray-600">{t('forbidden')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">{t('title')}</h1>
          <p className="text-sm text-gray-500 mt-1">{t('subtitle')}</p>
        </div>
        <button type="button" className="btn-default text-sm" onClick={doExport}>
          <i className="fas fa-download text-xs mr-1.5"></i>{t('export')}
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          [t('statToday'), stats?.today],
          [t('statActiveUsers'), stats?.active_users],
          [t('statHighRisk'), stats?.high_risk],
        ].map(([label, value]) => (
          <div
            key={String(label)}
            className="bg-white border border-gray-200 rounded-lg px-4 py-3"
          >
            <p className="text-xs text-gray-500">{label}</p>
            <p className="text-2xl font-semibold text-gray-900 mt-1 tabular-nums">
              {value ?? '—'}
            </p>
          </div>
        ))}
      </div>

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 bg-gray-50/50 flex flex-wrap gap-2">
          <select
            className="h-9 border border-gray-300 rounded-lg px-3 text-sm bg-white"
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value)
              setPage(0)
            }}
          >
            <option value="">{t('allProjects')}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            className="h-9 border border-gray-300 rounded-lg px-3 text-sm bg-white"
            value={filters.actor_name}
            onChange={(e) => setFilters({ ...filters, actor_name: e.target.value })}
          >
            <option value="">{t('allActors')}</option>
            {actors.map((a) => (
              <option key={a.actor_name || a.actor_id || '?'} value={a.actor_name || ''}>
                {a.actor_name || t('unknownActor')}
              </option>
            ))}
          </select>
          <select
            className="h-9 border border-gray-300 rounded-lg px-3 text-sm bg-white"
            value={filters.action}
            onChange={(e) => setFilters({ ...filters, action: e.target.value })}
          >
            <option value="">{t('allActions')}</option>
            {facets.actions.map((a) => (
              <option key={a} value={a}>
                {actionLabel(a)}
              </option>
            ))}
          </select>
          <input
            className="h-9 border border-gray-300 rounded-lg px-3 text-sm"
            placeholder={t('searchResourcePlaceholder')}
            value={filters.q_resource}
            onChange={(e) => setFilters({ ...filters, q_resource: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyFilters()
            }}
          />
          <button type="button" className="btn-primary text-sm h-9" onClick={applyFilters}>
            {t('filterBtn')}
          </button>
        </div>

        <div className="px-4 pt-2 border-b border-gray-100 flex gap-1">
          {(
            [
              ['all', t('tabAll'), stats?.total],
              ['highRisk', t('tabHighRisk'), stats?.high_risk],
              ['mine', t('tabMine'), stats?.mine],
            ] as [Tab, string, number | undefined][]
          ).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setTab(key)
                setPage(0)
              }}
              className={`px-3 py-2 text-sm border-b-2 -mb-px ${
                tab === key
                  ? 'text-blue-600 border-blue-500 font-medium'
                  : 'text-gray-500 border-transparent'
              }`}
            >
              {label}{' '}
              <span className="text-xs text-gray-400">{count ?? 0}</span>
            </button>
          ))}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                {[
                  t('colTime'),
                  t('colProject'),
                  t('colActor'),
                  t('colAction'),
                  t('colResource'),
                  t('colContent'),
                  t('colIp'),
                ].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-medium uppercase">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-gray-400">
                    <i className="fas fa-spinner fa-spin mr-2"></i>{t('loading')}
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                    {t('noData')}
                  </td>
                </tr>
              ) : (
                rows.map((log) => {
                  const am = actionMeta(log.action)
                  return (
                    <tr
                      key={log.id}
                      className={`cursor-pointer hover:bg-gray-50 ${
                        log.high_risk ? 'bg-orange-50/60' : ''
                      }`}
                      onClick={() => openDetail(log.id)}
                    >
                      <td className="px-4 py-3 text-xs text-gray-500 font-mono whitespace-nowrap">
                        {fmtTime(log.created_at)}
                      </td>
                      <td className="px-4 py-3 text-gray-700 whitespace-nowrap">
                        {log.project_name || `#${log.tenant_id ?? '-'}`}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">{log.actor_name || '-'}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${am.cls}`}>
                          {actionLabel(log.action)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                        {log.resource_type || '-'}
                        {log.resource_name ? ` · ${log.resource_name}` : ''}
                      </td>
                      <td className="px-4 py-3 text-gray-700 max-w-[240px] truncate" title={log.summary}>
                        {log.summary}
                      </td>
                      <td className="px-4 py-3 text-xs font-mono text-gray-500">
                        {log.ip || '-'}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 bg-gray-50 text-xs text-gray-500">
          <span>
            {t('pagination', { total: total.toLocaleString(), page: page + 1, totalPages })}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="px-3 py-1 border border-gray-300 rounded disabled:opacity-40"
              disabled={page <= 0}
              onClick={() => setPage(page - 1)}
            >
              {t('prevPage')}
            </button>
            <button
              type="button"
              className="px-3 py-1 border border-gray-300 rounded disabled:opacity-40"
              disabled={page + 1 >= totalPages}
              onClick={() => setPage(page + 1)}
            >
              {t('nextPage')}
            </button>
          </div>
        </div>
      </div>

      {(detail || detailLoading) && (
        <>
          <div className="fixed inset-0 bg-black/25 z-40" onClick={() => setDetail(null)} />
          <div className="fixed right-0 top-0 h-screen w-[480px] bg-white shadow-2xl z-50 flex flex-col">
            <div className="h-14 border-b border-gray-100 flex items-center justify-between px-5">
              <h2 className="text-base font-semibold text-gray-900">{t('detailTitle')}</h2>
              <button type="button" onClick={() => setDetail(null)} className="text-gray-400">
                <i className="fas fa-times"></i>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              {detailLoading || !detail ? (
                <div className="py-16 text-center text-gray-400">
                  <i className="fas fa-spinner fa-spin"></i>
                </div>
              ) : (
                <div className="space-y-4 text-sm">
                  <div>
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${
                        actionMeta(detail.action).cls
                      }`}
                    >
                      {actionLabel(detail.action)}
                    </span>
                    <p className="mt-2 font-medium text-gray-900">{detail.summary}</p>
                    <p className="text-xs text-gray-400 mt-1 font-mono">
                      {fmtTime(detail.created_at)}
                    </p>
                  </div>
                  <dl className="grid grid-cols-[88px_1fr] gap-y-2 text-sm">
                    <dt className="text-gray-500">{t('detailProject')}</dt>
                    <dd>{detail.project_name || `#${detail.tenant_id}`}</dd>
                    <dt className="text-gray-500">{t('detailActor')}</dt>
                    <dd>{detail.actor_name || '-'}</dd>
                    <dt className="text-gray-500">{t('detailResource')}</dt>
                    <dd>
                      {detail.resource_type || '-'} {detail.resource_name || ''}
                    </dd>
                    <dt className="text-gray-500">{t('detailIp')}</dt>
                    <dd className="font-mono text-xs">{detail.ip || '-'}</dd>
                  </dl>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
