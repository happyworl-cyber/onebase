'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import {
  operationLogAPI,
  type OperationLogRow,
  type OperationLogStats,
  type OperationLogDetail,
  type OperationLogActor,
  type OperationLogFilterParams,
} from '@/lib/api'

// ── 呈现映射（颜色/图标/文案在前端，后端只出语义）──────────────────
const ACTION_META: Record<string, { label: string; cls: string }> = {
  CREATE: { label: '创建', cls: 'bg-green-100 text-green-800' },
  UPDATE: { label: '修改', cls: 'bg-blue-100 text-blue-800' },
  DELETE: { label: '删除', cls: 'bg-red-100 text-red-800' },
  READ: { label: '查询', cls: 'bg-gray-100 text-gray-800' },
  EXPORT: { label: '导出', cls: 'bg-orange-100 text-orange-800' },
  IMPORT: { label: '导入', cls: 'bg-purple-100 text-purple-800' },
  LOGIN: { label: '登录', cls: 'bg-cyan-100 text-cyan-800' },
  PERMISSION: { label: '权限变更', cls: 'bg-amber-100 text-amber-800' },
  TRIGGER: { label: '触发', cls: 'bg-teal-100 text-teal-800' },
  EXECUTE: { label: '执行', cls: 'bg-indigo-100 text-indigo-800' },
}
const actionMeta = (a: string) => ACTION_META[a] || { label: a, cls: 'bg-gray-100 text-gray-800' }

const SOURCE_META: Record<string, { label: string; icon: string; cls: string }> = {
  console: { label: '页面', icon: 'fa-desktop', cls: 'bg-slate-100 text-slate-700' },
  api: { label: 'API', icon: 'fa-plug', cls: 'bg-sky-100 text-sky-700' },
  mcp: { label: 'MCP', icon: 'fa-robot', cls: 'bg-violet-100 text-violet-700' },
  cron: { label: '定时', icon: 'fa-clock', cls: 'bg-amber-100 text-amber-700' },
  system: { label: '系统', icon: 'fa-gear', cls: 'bg-gray-200 text-gray-700' },
}
const sourceMeta = (s: string) => SOURCE_META[s] || SOURCE_META.console
const MACHINE_SOURCES = new Set(['cron', 'system'])

const RESOURCE_ICON: Record<string, string> = {
  数据库: 'fa-database', 数据表: 'fa-table', Schema: 'fa-layer-group', 索引: 'fa-list-ul',
  API: 'fa-plug', 工作流: 'fa-diagram-project',
  用户: 'fa-user', 角色: 'fa-user-shield', 环境变量: 'fa-key', 项目设置: 'fa-sliders-h',
  RLS: 'fa-shield-alt', 'RPC ACL': 'fa-key', 身份提供方: 'fa-id-card', 'OAuth2 Client': 'fa-id-card',
  定时任务: 'fa-clock', 系统: 'fa-desktop',
}

type Tab = 'all' | 'failed' | 'highRisk' | 'mine'
const PAGE_SIZE = 20

export default function OperationLogsPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)

  const [rows, setRows] = useState<OperationLogRow[]>([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState<OperationLogStats | null>(null)
  const [actors, setActors] = useState<OperationLogActor[]>([])
  const [facets, setFacets] = useState<{ actions: string[]; resource_types: string[] }>({ actions: [], resource_types: [] })
  const [loading, setLoading] = useState(false)
  const [forbidden, setForbidden] = useState(false)
  const [page, setPage] = useState(0)
  const [tab, setTab] = useState<Tab>('all')
  const [detail, setDetail] = useState<OperationLogDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const [filters, setFilters] = useState({
    actor_name: '',
    action: '',
    resource_type: '',
    q_resource: '',
    source: '',
    status: '',
    start_date: '',
    end_date: '',
  })
  // 已提交的筛选（点"筛选"后才生效，避免每次输入都打接口）
  const [applied, setApplied] = useState(filters)

  const baseParams: OperationLogFilterParams = useMemo(
    () => ({
      actor_name: applied.actor_name || undefined,
      action: applied.action || undefined,
      resource_type: applied.resource_type || undefined,
      q_resource: applied.q_resource || undefined,
      source: applied.source || undefined,
      status: applied.status || undefined,
      start_date: applied.start_date || undefined,
      end_date: applied.end_date || undefined,
    }),
    [applied],
  )

  const loadList = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const res = await operationLogAPI.list(projectId, {
        ...baseParams,
        tab,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      })
      setRows(res.data.data || [])
      setTotal(res.data.total || 0)
      setForbidden(false)
    } catch (err) {
      if ((err as { response?: { status?: number } })?.response?.status === 403) setForbidden(true)
    } finally {
      setLoading(false)
    }
  }, [projectId, baseParams, tab, page])

  const loadStats = useCallback(async () => {
    if (!projectId) return
    try {
      const res = await operationLogAPI.stats(projectId, baseParams)
      setStats(res.data)
    } catch {
      /* 静默：卡片非关键 */
    }
  }, [projectId, baseParams])

  useEffect(() => {
    loadList()
  }, [loadList])
  useEffect(() => {
    loadStats()
  }, [loadStats])
  useEffect(() => {
    if (!projectId) return
    operationLogAPI.actors(projectId).then((r) => setActors(r.data.data || [])).catch(() => {})
    operationLogAPI
      .facets(projectId)
      .then((r) => setFacets({ actions: r.data.actions || [], resource_types: r.data.resource_types || [] }))
      .catch(() => {})
  }, [projectId])

  const applyFilters = () => {
    setPage(0)
    setApplied(filters)
  }
  const resetFilters = () => {
    const empty = {
      actor_name: '', action: '', resource_type: '', q_resource: '',
      source: '', status: '', start_date: '', end_date: '',
    }
    setFilters(empty)
    setApplied(empty)
    setPage(0)
  }

  const switchTab = (t: Tab) => {
    setTab(t)
    setPage(0)
  }

  const openDetail = async (id: number) => {
    setDetailLoading(true)
    setDetail(null)
    try {
      const res = await operationLogAPI.detail(projectId, id)
      setDetail(res.data)
    } finally {
      setDetailLoading(false)
    }
  }
  const closeDetail = () => setDetail(null)

  const doExport = async () => {
    try {
      const res = await operationLogAPI.export(projectId, { ...baseParams, tab })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url
      a.download = `operation-logs-${projectId}-${Date.now()}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      /* 全局 toast 已处理 */
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  if (forbidden) {
    return (
      <div className="p-6">
        <div className="max-w-md mx-auto text-center py-16">
          <i className="fas fa-lock text-3xl text-amber-500 mb-3"></i>
          <p className="text-sm text-gray-600">仅项目管理员（admin+）可查看操作日志。</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">操作日志</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            记录本项目所有操作行为，支持按操作人、动作、资源对象、来源多维追溯
          </p>
        </div>
        <button className="btn-default text-sm flex items-center gap-2" onClick={doExport}>
          <i className="fas fa-download text-xs"></i>导出
        </button>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard label="今日操作" value={stats?.today} icon="fa-mouse-pointer" tone="text-primary-500 bg-primary-50" />
        <StatCard label="活跃操作人" value={stats?.active_users} icon="fa-users" tone="text-violet-500 bg-violet-50" />
        <StatCard label="高危操作" value={stats?.high_risk} icon="fa-fire" tone="text-orange-500 bg-orange-50" valueCls="text-orange-600" />
      </div>

      <div className="card overflow-hidden">
        {/* 筛选工具栏 */}
        <div className="px-5 py-3.5 border-b border-gray-100 bg-gray-50/50">
          <div className="flex flex-wrap items-center gap-2.5">
            <Dropdown leadingIcon="fa-user" width="w-[168px]" placeholder="全部操作人" value={filters.actor_name}
              onChange={(v) => setFilters({ ...filters, actor_name: v })}
              options={[{ value: '', label: '全部操作人' }, ...actors.map((a) => ({ value: a.actor_name || '', label: a.actor_name || '(未知)' }))]} />
            <Dropdown leadingIcon="fa-bolt" width="w-[132px]" placeholder="全部动作" value={filters.action}
              onChange={(v) => setFilters({ ...filters, action: v })}
              options={[{ value: '', label: '全部动作' }, ...facets.actions.map((a) => ({ value: a, label: actionMeta(a).label, badgeCls: actionMeta(a).cls }))]} />
            <Dropdown leadingIcon="fa-cube" width="w-[132px]" placeholder="全部资源" value={filters.resource_type}
              onChange={(v) => setFilters({ ...filters, resource_type: v })}
              options={[{ value: '', label: '全部资源' }, ...facets.resource_types.map((rt) => ({ value: rt, label: rt, icon: RESOURCE_ICON[rt] || 'fa-file' }))]} />
            <div className="relative w-[180px]">
              <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs pointer-events-none"></i>
              <input
                className="h-9 w-full pl-8 pr-3 text-sm bg-white border border-gray-300 rounded-lg placeholder:text-gray-400 hover:border-primary-400 focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 transition"
                placeholder="搜索资源对象"
                value={filters.q_resource}
                onChange={(e) => setFilters({ ...filters, q_resource: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') applyFilters() }} />
            </div>
            <div className="inline-flex items-center gap-2">
              <input type="date" aria-label="开始日期"
                className="h-9 w-[150px] px-3 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:border-primary-400 focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 transition"
                value={filters.start_date}
                max={filters.end_date || undefined}
                onChange={(e) => {
                  const v = e.target.value
                  // 开始不得晚于结束：若越界则把结束一并抬到开始
                  setFilters((f) => ({ ...f, start_date: v, end_date: f.end_date && v && f.end_date < v ? v : f.end_date }))
                }} />
              <span className="text-gray-400 text-xs">~</span>
              <input type="date" aria-label="结束日期"
                className="h-9 w-[150px] px-3 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:border-primary-400 focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 transition"
                value={filters.end_date}
                min={filters.start_date || undefined}
                onChange={(e) => {
                  const v = e.target.value
                  // 结束不得早于开始：若越界则把开始一并压到结束
                  setFilters((f) => ({ ...f, end_date: v, start_date: f.start_date && v && f.start_date > v ? v : f.start_date }))
                }} />
            </div>
            <div className="flex-1 min-w-[8px]" />
            <button
              className="inline-flex items-center gap-1.5 h-9 px-4 text-sm font-medium text-white bg-primary-500 rounded-lg hover:bg-primary-600 active:bg-primary-700 transition-colors"
              onClick={applyFilters}>
              <i className="fas fa-search text-xs"></i>筛选
            </button>
            <button
              className="inline-flex items-center h-9 px-3 text-sm text-gray-500 rounded-lg hover:bg-gray-200/60 hover:text-gray-700 transition-colors"
              onClick={resetFilters}>重置</button>
          </div>
        </div>

        {/* Tab */}
        <div className="px-5 pt-3 border-b border-gray-100 flex gap-1">
          {([
            ['all', '全部', stats?.total],
            ['highRisk', '高危', stats?.high_risk],
            ['mine', '我的', stats?.mine],
          ] as [Tab, string, number | undefined][]).map(([key, label, count]) => (
            <button key={key} onClick={() => switchTab(key)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
                tab === key ? 'text-primary-600 border-primary-500' : 'text-gray-500 border-transparent hover:text-gray-700'
              }`}>
              {label} <span className="ml-1 text-xs text-gray-400">{count ?? 0}</span>
            </button>
          ))}
        </div>

        {/* 表格 */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                {['时间', '操作人', '动作', '资源类型', '资源对象', '操作内容', 'IP', ''].map((h, i) => (
                  <th key={i} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={8} className="text-center py-10 text-gray-400"><i className="fas fa-spinner fa-spin mr-2"></i>加载中...</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={8} className="text-center py-12 text-gray-400"><i className="fas fa-inbox text-2xl mb-2 block opacity-60"></i>没有符合条件的操作日志</td></tr>
              ) : rows.map((log) => {
                const am = actionMeta(log.action)
                const sm = sourceMeta(log.source)
                const machine = MACHINE_SOURCES.has(log.source)
                return (
                  <tr key={log.id} className={`cursor-pointer ${log.high_risk ? 'bg-orange-50/70 border-l-4 border-orange-500 hover:bg-orange-100/70' : 'hover:bg-gray-50'}`} onClick={() => openDetail(log.id)}>
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap font-mono">{fmtTime(log.created_at)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        {machine ? (
                          <div className={`w-6 h-6 rounded-md flex items-center justify-center shrink-0 ${sm.cls}`}><i className={`fas ${sm.icon} text-[10px]`}></i></div>
                        ) : (
                          <div className="w-6 h-6 bg-primary-100 rounded-full flex items-center justify-center shrink-0"><span className="text-[11px] font-medium text-primary-600">{(log.actor_name || '?').slice(0, 1)}</span></div>
                        )}
                        <span className="text-sm text-gray-900">{log.actor_name || '-'}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${am.cls}`}>{am.label}</span>
                        {log.high_risk && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-orange-100 text-orange-700 ring-1 ring-orange-300" title="高危操作">
                            <i className="fas fa-fire text-[9px] mr-0.5"></i>高危
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {log.resource_type ? (
                        <span className="inline-flex items-center gap-1.5 text-sm text-gray-600">
                          <i className={`fas ${RESOURCE_ICON[log.resource_type] || 'fa-file'} text-gray-400 text-xs`}></i>
                          {log.resource_type}
                        </span>
                      ) : <span className="text-gray-300">-</span>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="text-sm text-gray-700 truncate max-w-[180px] block" title={log.resource_name || ''}>{log.resource_name || '-'}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-gray-700 truncate max-w-[280px] block" title={log.summary}>{log.summary}</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap font-mono">{log.ip || '-'}</td>
                    <td className="px-4 py-3 text-center">
                      <button className="text-gray-400 hover:text-primary-500" onClick={(e) => { e.stopPropagation(); openDetail(log.id) }}>
                        <i className="fas fa-chevron-right text-xs"></i>
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* 分页 */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 bg-gray-50">
          <span className="text-xs text-gray-500">共 {total.toLocaleString()} 条 · 第 {page + 1} / {totalPages} 页</span>
          <div className="flex items-center gap-2">
            <button className="btn-default text-xs px-3 py-1.5 disabled:opacity-50" disabled={page <= 0} onClick={() => setPage(page - 1)}>
              <i className="fas fa-chevron-left text-xs"></i>
            </button>
            <button className="btn-default text-xs px-3 py-1.5 disabled:opacity-50" disabled={page + 1 >= totalPages} onClick={() => setPage(page + 1)}>
              <i className="fas fa-chevron-right text-xs"></i>
            </button>
          </div>
        </div>
      </div>

      {/* 详情抽屉 */}
      {(detail || detailLoading) && (
        <>
          <div className="fixed inset-0 bg-black/25 z-40" onClick={closeDetail}></div>
          <div className="fixed right-0 top-0 h-screen w-[520px] bg-white shadow-2xl z-50 flex flex-col">
            <div className="h-14 border-b border-gray-100 flex items-center justify-between px-6 shrink-0">
              <h2 className="text-base font-semibold text-gray-900">操作详情</h2>
              <button onClick={closeDetail} className="text-gray-400 hover:text-gray-600"><i className="fas fa-times"></i></button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {detailLoading || !detail ? (
                <div className="py-16 text-center text-gray-400"><i className="fas fa-spinner fa-spin"></i></div>
              ) : (
                <OperationDetail detail={detail} />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

interface DropdownOption {
  value: string
  label: string
  /** 前置图标（资源类型用） */
  icon?: string
  /** 彩色标签样式（动作用），如 'bg-green-100 text-green-800' */
  badgeCls?: string
}

/** 自定义下拉：可样式化的浮层菜单（替代原生 select 那个丑陋的系统下拉列表）。 */
function Dropdown({
  leadingIcon, value, placeholder, options, onChange, width,
}: {
  leadingIcon: string
  value: string
  placeholder: string
  options: DropdownOption[]
  onChange: (v: string) => void
  width?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const selected = options.find((o) => o.value === value)

  return (
    <div ref={ref} className={`relative ${width || 'w-[140px]'}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`h-9 w-full pl-8 pr-8 text-sm text-left bg-white border rounded-lg flex items-center transition-colors ${
          open ? 'border-primary-500 ring-2 ring-primary-500/20' : 'border-gray-300 hover:border-primary-400'
        }`}
      >
        <i className={`fas ${leadingIcon} absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs pointer-events-none`}></i>
        <span className={`truncate ${value ? 'text-gray-700' : 'text-gray-400'}`}>{selected?.label ?? placeholder}</span>
        <i className={`fas fa-chevron-down absolute right-3 top-1/2 -translate-y-1/2 text-gray-300 text-[10px] transition-transform ${open ? 'rotate-180' : ''}`}></i>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1.5 z-30 w-full max-h-64 overflow-auto bg-white border border-gray-200 rounded-lg shadow-lg ring-1 ring-black/5 py-1">
          {options.map((o) => {
            const sel = o.value === value
            return (
              <button
                key={o.value || '__all'}
                type="button"
                onClick={() => { onChange(o.value); setOpen(false) }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${sel ? 'bg-primary-50' : 'hover:bg-gray-50'}`}
              >
                {o.icon && <i className={`fas ${o.icon} w-4 text-center text-gray-400 text-xs shrink-0`}></i>}
                {o.badgeCls ? (
                  <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${o.badgeCls}`}>{o.label}</span>
                ) : (
                  <span className={`truncate ${sel ? 'text-primary-700 font-medium' : 'text-gray-700'}`}>{o.label}</span>
                )}
                {sel && <i className="fas fa-check text-primary-500 text-[10px] shrink-0"></i>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, icon, tone, valueCls }: { label: string; value?: number; icon: string; tone: string; valueCls?: string }) {
  return (
    <div className="card px-5 py-4 flex items-center justify-between">
      <div>
        <p className="text-xs text-gray-500">{label}</p>
        <p className={`text-2xl font-semibold mt-1 tabular-nums ${valueCls || 'text-gray-900'}`}>{value ?? '—'}</p>
      </div>
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${tone}`}><i className={`fas ${icon} text-sm`}></i></div>
    </div>
  )
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return iso
  }
}

function OperationDetail({ detail }: { detail: OperationLogDetail }) {
  const am = actionMeta(detail.action)
  const cv = detail.change_view
  const d = (detail.detail || {}) as Record<string, any>

  return (
    <div>
      <div className="px-6 py-5 border-b border-gray-100">
        <div className="flex items-center gap-2 flex-wrap mb-2">
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${am.cls}`}>{am.label}</span>
          {detail.high_risk && <span className="px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-700"><i className="fas fa-fire text-[10px] mr-1"></i>高危</span>}
        </div>
        <p className="text-sm font-medium text-gray-900">{detail.summary}</p>
        <p className="text-xs text-gray-400 mt-1 font-mono">{detail.id} · {fmtTime(detail.created_at)}</p>
      </div>

      <Section title="操作人">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-primary-50 rounded-full flex items-center justify-center"><span className="text-sm font-medium text-primary-600">{(detail.actor_name || '?').slice(0, 1)}</span></div>
          <div>
            <p className="text-sm font-medium text-gray-900">{detail.actor_name || '-'}</p>
            <p className="text-xs text-gray-500">{detail.actor_role || detail.actor_type}</p>
          </div>
        </div>
      </Section>

      <Section title="请求信息">
        <dl className="grid grid-cols-[80px_1fr] gap-y-2.5 gap-x-4 text-sm">
          {typeof d.method === 'string' && <Field k="方法"><span className="font-mono">{d.method}</span></Field>}
          {typeof d.endpoint === 'string' && <Field k="路径"><code className="text-xs break-all">{d.endpoint}</code></Field>}
          <Field k="资源类型">{detail.resource_type || '-'}</Field>
          <Field k="资源对象"><span className="font-mono text-xs break-all">{detail.resource_name || '-'}</span></Field>
          <Field k="来源 IP"><span className="font-mono text-xs">{detail.ip || '-'}</span></Field>
          {detail.session_id && <Field k="会话"><span className="font-mono text-xs text-gray-500">{detail.session_id}</span></Field>}
        </dl>
      </Section>

      {typeof d.query === 'string' && (
        <Section title="SQL 查询">
          <pre className="text-xs font-mono bg-gray-50 border border-gray-100 rounded-lg p-3 overflow-x-auto">{d.query}</pre>
        </Section>
      )}

      {detail.status === 'failed' && typeof d.error === 'string' && (
        <Section title="错误信息" titleCls="text-red-500">
          <pre className="text-xs font-mono bg-red-50 border border-red-100 text-red-700 rounded-lg p-3 overflow-x-auto">{d.error}</pre>
        </Section>
      )}

      {/* 变更内容：后端 format_change 已渲染成 change_view，前端只呈现 */}
      {cv && <ChangeViewBlock cv={cv} />}

      {typeof d.userAgent === 'string' && (
        <Section title="User Agent">
          <p className="text-xs text-gray-500 break-all">{d.userAgent}</p>
        </Section>
      )}
    </div>
  )
}

const IMPORT_ACTION_LABEL: Record<string, { label: string; cls: string }> = {
  create: { label: '新建', cls: 'bg-green-100 text-green-700' },
  overwrite: { label: '覆盖', cls: 'bg-amber-100 text-amber-700' },
  rename: { label: '重命名', cls: 'bg-blue-100 text-blue-700' },
}

function ChangeViewBlock({ cv }: { cv: NonNullable<OperationLogDetail['change_view']> }) {
  if (cv.kind === 'imported') {
    const items = cv.items || []
    return (
      <Section title={`导入内容（${items.length}）`} titleCls="text-green-600">
        <div className="rounded-lg border border-green-200 bg-green-50/40 divide-y divide-green-100">
          {items.map((it, i) => {
            const am = IMPORT_ACTION_LABEL[it.action || 'create'] || IMPORT_ACTION_LABEL.create
            return (
              <div key={i} className="px-3 py-2 flex items-center gap-2">
                <i className="fas fa-diagram-project text-gray-400 text-xs shrink-0"></i>
                <div className="min-w-0">
                  <div className="text-sm text-gray-900 truncate">{it.name || it.slug}</div>
                  {it.slug && it.name && it.slug !== it.name && (
                    <div className="text-[11px] text-gray-400 font-mono truncate">{it.slug}</div>
                  )}
                </div>
                <span className={`ml-auto shrink-0 text-[11px] px-1.5 py-0.5 rounded font-medium ${am.cls}`}>{am.label}</span>
              </div>
            )
          })}
        </div>
      </Section>
    )
  }
  if (cv.kind === 'sql') {
    const stmts = cv.statements || []
    return (
      <Section title="执行内容">
        {cv.sql ? (
          <div className="rounded-lg border border-gray-200 overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 border-b border-gray-100 text-[11px]">
              {cv.sql_type && <span className="px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 font-medium">{cv.sql_type}</span>}
              {typeof cv.rows === 'number' && <span className="text-gray-500">影响 {cv.rows} 行</span>}
            </div>
            <pre className="px-3 py-2.5 text-xs font-mono text-gray-800 whitespace-pre-wrap break-all bg-gray-900/[0.02] max-h-64 overflow-auto">{cv.sql}</pre>
          </div>
        ) : null}
        {stmts.length > 0 && (
          <div className={`rounded-lg border border-gray-200 divide-y divide-gray-50 ${cv.sql ? 'mt-2' : ''}`}>
            {stmts.map((s, i) => (
              <div key={i} className="px-3 py-2 flex items-center gap-2 text-xs">
                <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 font-medium shrink-0">{s.op || 'SQL'}</span>
                <span className="font-mono text-gray-800 break-all">{s.table}</span>
              </div>
            ))}
          </div>
        )}
      </Section>
    )
  }
  if (cv.kind === 'created' || cv.kind === 'deleted') {
    const isDel = cv.kind === 'deleted'
    return (
      <Section title={isDel ? '被删除对象' : '创建内容'} titleCls={isDel ? 'text-red-500' : 'text-green-600'}>
        <div className={`rounded-lg border p-3 ${isDel ? 'border-red-200 bg-red-50/50' : 'border-green-200 bg-green-50/50'}`}>
          <dl className="grid grid-cols-[90px_1fr] gap-y-2 gap-x-4 text-sm">
            {(cv.summary || []).map((s, i) => (
              <div key={i} className="contents">
                <dt className={isDel ? 'text-red-400' : 'text-green-600'}>{s.label}</dt>
                <dd className="text-gray-800 font-mono text-xs break-all">{s.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>
    )
  }
  const opCls: Record<string, string> = {
    add: 'border-green-200 bg-green-50 text-green-700',
    modify: 'border-blue-200 bg-blue-50 text-blue-700',
    delete: 'border-red-200 bg-red-50 text-red-700',
  }
  return (
    <Section title="变更内容">
      <div className="space-y-3">
        {(cv.groups || []).map((grp, gi) => (
          <div key={gi} className="rounded-lg border overflow-hidden border-gray-200">
            <div className={`px-3 py-2 text-xs font-medium border-b ${opCls[grp.op] || opCls.modify}`}>{grp.title}</div>
            <div className="divide-y divide-gray-50">
              {grp.items.map((item, ii) => (
                <div key={ii} className="px-3 py-2.5">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-gray-900 font-mono">{item.name}</span>
                    {item.type && <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-[11px]">{item.type}</span>}
                  </div>
                  {item.fields && item.fields.length > 0 && (
                    <div className="mt-1.5 space-y-2">
                      {item.fields.map((f, fi) => (
                        <div key={fi} className="text-xs">
                          <span className="text-gray-500 break-all">{f.key}</span>
                          <div className="mt-1 flex items-center gap-2 flex-wrap">
                            <span className="font-mono px-1.5 py-0.5 rounded bg-red-50 text-red-600 line-through break-all">{f.old}</span>
                            <i className="fas fa-arrow-right text-gray-300 text-[10px] shrink-0"></i>
                            <span className="font-mono px-1.5 py-0.5 rounded bg-green-50 text-green-700 break-all">{f.new}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}

function Section({ title, titleCls, children }: { title: string; titleCls?: string; children: React.ReactNode }) {
  return (
    <div className="px-6 py-4 border-b border-gray-50">
      <p className={`text-xs font-semibold uppercase tracking-wider mb-3 ${titleCls || 'text-gray-400'}`}>{title}</p>
      {children}
    </div>
  )
}

function Field({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-gray-500">{k}</dt>
      <dd className="text-gray-800">{children}</dd>
    </div>
  )
}
