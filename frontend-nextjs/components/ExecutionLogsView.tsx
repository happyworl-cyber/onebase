'use client'

import { useState, useEffect, useCallback } from 'react'
import api from '@/lib/api'
import Pagination from '@/components/Pagination'
import { copyTextToClipboard } from '@/lib/clipboard'

/**
 * 统一执行日志视图（平台级 + 项目级共用）。
 *
 * - 平台页 `/platform/logs`：不传 `tenantId`，超管看全部、租户 owner/admin 看自己租户。
 * - 项目页 `/workspace/[projectId]/logs`：传 `tenantId`（= projectId，W2 不变量项目即租户），
 *   后端按该租户收敛；非超管再与其可管理租户集合求交。
 */

interface ExecRefDetail {
  kind?: string
  status?: string | null
  input?: unknown
  output?: unknown
  node_results?: unknown
  error?: string | null
  elapsed_ms?: number | null
  request_method?: string | null
  request_path?: string | null
  response_status?: number | null
  trigger_type?: string | null
  task_name?: string | null
  task_kind?: string | null
  triggered_by?: string | null
}

interface ExecutionIndex {
  id: number
  trace_id: string
  source: string
  ref_table: string | null
  ref_id: number | null
  tenant_id: number | null
  user_id: number | null
  name: string | null
  status: string
  started_at: string
  finished_at: string | null
  duration_ms: number | null
  error_brief: string | null
  detail?: ExecRefDetail
}

interface ExecutionLog {
  id: number
  ts: string
  level: string
  source: string | null
  logger: string | null
  span: string | null
  message: string
  fields: Record<string, unknown> | null
}

interface DetailResponse {
  trace_id: string
  index: ExecutionIndex[]
  logs: ExecutionLog[]
}

const SOURCES = [
  { id: '', label: '全部' },
  { id: 'workflow', label: '工作流' },
  { id: 'scheduler', label: '定时任务' },
  { id: 'api', label: 'API' },
  { id: 'db', label: '数据库' },
  { id: 'rpc', label: 'RPC' },
]

const sourceBadge = (source: string) => {
  const map: Record<string, string> = {
    workflow: 'bg-indigo-100 text-indigo-800',
    scheduler: 'bg-purple-100 text-purple-800',
    api: 'bg-blue-100 text-blue-800',
    db: 'bg-teal-100 text-teal-800',
    rpc: 'bg-amber-100 text-amber-800',
  }
  return map[source] || 'bg-gray-100 text-gray-800'
}

const statusBadge = (status: string) => {
  const map: Record<string, string> = {
    success: 'bg-green-100 text-green-800',
    completed: 'bg-green-100 text-green-800',
    running: 'bg-blue-100 text-blue-800',
    failed: 'bg-red-100 text-red-800',
    timeout: 'bg-orange-100 text-orange-800',
    cancelled: 'bg-gray-100 text-gray-600',
  }
  return map[status] || 'bg-gray-100 text-gray-800'
}

/** 索引层与权威 run 表不一致时（异常中断），以 run 表终态为准。 */
function resolveDisplayStatus(ix: ExecutionIndex): string {
  const refStatus = ix.detail?.status
  if (ix.status === 'running' && refStatus && refStatus !== 'running') {
    return refStatus === 'completed' ? 'success' : refStatus
  }
  return ix.status
}

function resolveDisplayError(ix: ExecutionIndex): string | null {
  return ix.error_brief ?? ix.detail?.error ?? null
}

function resolveDisplayDuration(ix: ExecutionIndex): number | null {
  return ix.duration_ms ?? ix.detail?.elapsed_ms ?? null
}

const levelColor = (level: string) => {
  const map: Record<string, string> = {
    ERROR: 'text-red-600',
    WARN: 'text-orange-600',
    INFO: 'text-gray-700',
    DEBUG: 'text-gray-400',
  }
  return map[level] || 'text-gray-700'
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  const [copied, setCopied] = useState(false)
  if (value === null || value === undefined) return null
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  if (text === '' || text === 'null' || text === '{}' || text === '[]') return null
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="text-[11px] font-medium text-gray-500">{label}</div>
        <button
          type="button"
          onClick={async (e) => {
            e.preventDefault()
            e.stopPropagation()
            const ok = await copyTextToClipboard(text)
            if (!ok) return
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          }}
          className="text-[11px] px-2 py-0.5 rounded border border-gray-300 text-gray-500 hover:bg-gray-100 shrink-0"
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="text-[11px] bg-gray-50 border rounded p-2 overflow-x-auto max-h-72 whitespace-pre-wrap break-all text-gray-700">
        {text}
      </pre>
    </div>
  )
}

const nodeStatusBadge = (status: string) => {
  const map: Record<string, string> = {
    success: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700',
    failed_allowed: 'bg-amber-100 text-amber-700',
    skipped: 'bg-gray-100 text-gray-500',
  }
  return map[status] || 'bg-gray-100 text-gray-600'
}

interface WorkflowNode {
  node_id?: string
  node_type?: string
  status?: string
  input?: unknown
  output?: unknown
  elapsed_ms?: number
  error?: string | null
  branch?: string | null
}

/** 工作流逐节点结果：每个节点的入参 → 出参时间线。 */
function NodeResults({ nodes }: { nodes: WorkflowNode[] }) {
  return (
    <div className="mt-2">
      <div className="text-[11px] font-medium text-gray-500 mb-1">节点结果（{nodes.length}）</div>
      <div className="space-y-2">
        {nodes.map((n, i) => (
          <div key={n.node_id ?? i} className="border rounded p-2">
            <div className="flex items-center gap-2 text-[11px]">
              <span className={`px-1.5 py-0.5 rounded font-medium ${nodeStatusBadge(n.status ?? '')}`}>
                {n.status ?? '-'}
              </span>
              <span className="font-mono text-gray-700">{n.node_id}</span>
              {n.node_type && <span className="text-gray-400">{n.node_type}</span>}
              {n.branch && <span className="text-indigo-500">→ {n.branch}</span>}
              {n.elapsed_ms != null && <span className="text-gray-400 ml-auto">{n.elapsed_ms}ms</span>}
            </div>
            <JsonBlock label="入参" value={n.input} />
            <JsonBlock label="出参" value={n.output} />
            {n.error && <JsonBlock label="错误" value={n.error} />}
          </div>
        ))}
      </div>
    </div>
  )
}

/** 渲染回查 run 表得到的输入/输出等细节。 */
function RefDetail({ d }: { d: ExecRefDetail }) {
  const nodes = Array.isArray(d.node_results) ? (d.node_results as WorkflowNode[]) : null
  return (
    <div className="mt-2 border-t pt-2 space-y-0.5">
      {(d.request_method || d.request_path) && (
        <div className="text-[11px] text-gray-500 font-mono">
          {d.request_method} {d.request_path}
          {d.response_status != null ? ` → ${d.response_status}` : ''}
        </div>
      )}
      {(d.task_kind || d.triggered_by) && (
        <div className="text-[11px] text-gray-500">
          类型：{d.task_kind ?? '-'}　触发：{d.triggered_by ?? '-'}
        </div>
      )}
      <JsonBlock label="输入" value={d.input} />
      {nodes && nodes.length > 0 ? <NodeResults nodes={nodes} /> : <JsonBlock label="节点结果" value={d.node_results} />}
      <JsonBlock label="输出" value={d.output} />
      {d.error && <JsonBlock label="错误" value={d.error} />}
    </div>
  )
}

interface ExecutionLogsViewProps {
  /** 限定租户（项目页传当前 projectId）；不传 = 平台视角（按身份自动收敛）。 */
  tenantId?: number
  /** 组织级聚合：限定该组织下属全部项目。 */
  organizationId?: number
  /** 顶部标题；项目页可省略副标题以更紧凑。 */
  title?: string
  subtitle?: string
}

export default function ExecutionLogsView({
  tenantId,
  organizationId,
  title = '执行日志',
  subtitle,
}: ExecutionLogsViewProps) {
  const [rows, setRows] = useState<ExecutionIndex[]>([])
  const [total, setTotal] = useState(0)
  const [totalCapped, setTotalCapped] = useState(false)
  const [page, setPage] = useState(0)
  // 每页条数支持动态切换（10/20/50/100），与通用 Pagination 组件的默认选项对齐。
  const [pageSize, setPageSize] = useState(50)
  const [loading, setLoading] = useState(false)
  const [source, setSource] = useState('')
  const [filters, setFilters] = useState({ status: '', name: '', trace_id: '', failed_only: false })

  const [detail, setDetail] = useState<DetailResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [levelFilter, setLevelFilter] = useState('')

  // AI 助手面板布局（右侧 fixed 抽屉，z-[10000]）。详情抽屉监听它的广播并向右避让，
  // 避免两者重叠（与 WorkflowsManager 调试抽屉同款约定）。
  const [aiPanel, setAiPanel] = useState<{ open: boolean; width: number; mobile: boolean }>(
    { open: false, width: 0, mobile: false },
  )
  useEffect(() => {
    try {
      const open = localStorage.getItem('ai-assistant-open') === '1'
      const w = Number(localStorage.getItem('ai-assistant-width')) || 440
      if (open) setAiPanel({ open, width: w, mobile: false })
    } catch { /* ignore */ }
    const onAiPanel = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      setAiPanel({ open: !!d.open, width: Number(d.width) || 0, mobile: !!d.mobile })
    }
    window.addEventListener('onebase:ai-panel', onAiPanel)
    return () => window.removeEventListener('onebase:ai-panel', onAiPanel)
  }, [])
  // AI 面板占用的右侧宽度（小屏全屏时不避让，靠层级处理）。
  const aiOffset = aiPanel.open && !aiPanel.mobile ? aiPanel.width : 0

  // 只含"筛选维度"的查询参数（不含 limit/offset）。列表和总数共用它，
  // 总数与翻页/每页大小无关，所以单独抽出来当 loadCount 的依赖键。
  const filterParams = useCallback(() => {
    const params: Record<string, unknown> = {}
    if (tenantId != null) params.tenant_id = tenantId
    if (organizationId != null) params.organization_id = organizationId
    if (source) params.source = source
    if (filters.status) params.status = filters.status
    if (filters.name) params.name = filters.name
    if (filters.trace_id) params.trace_id = filters.trace_id
    if (filters.failed_only) params.failed_only = true
    return params
  }, [source, filters, tenantId, organizationId])

  // 列表数据：翻页 / 改每页大小都会触发，但不再附带总数查询。
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = { ...filterParams(), limit: pageSize, offset: page * pageSize }
      const res = await api.get('/api/platform/executions', { params })
      setRows(res.data.data || [])
    } catch (err) {
      console.error('加载执行日志失败:', err)
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, filterParams])

  // 总数：只在筛选条件变化时请求一次，翻页 / 改每页大小都不触发（总数与它们无关）。
  const loadCount = useCallback(async () => {
    try {
      const res = await api.get('/api/platform/execution-count', { params: filterParams() })
      setTotal(res.data.total || 0)
      setTotalCapped(Boolean(res.data.capped))
    } catch (err) {
      console.error('加载执行日志总数失败:', err)
    }
  }, [filterParams])

  useEffect(() => {
    load()
  }, [page, pageSize, source, tenantId])

  // source 标签 / 租户切换时刷新总数；其余筛选（状态/名称/trace/仅失败）由"筛选"按钮触发。
  useEffect(() => {
    loadCount()
  }, [source, tenantId])

  const openDetail = async (traceId: string) => {
    setDetailLoading(true)
    setDetail({ trace_id: traceId, index: [], logs: [] })
    setLevelFilter('')
    try {
      const res = await api.get(`/api/platform/executions/${encodeURIComponent(traceId)}`)
      setDetail(res.data)
    } catch (err) {
      console.error('加载执行详情失败:', err)
    } finally {
      setDetailLoading(false)
    }
  }

  const fmtTime = (s: string | null) => (s ? new Date(s).toLocaleString('zh-CN') : '-')
  const fmtDur = (ms: number | null) => (ms != null ? `${ms}ms` : '-')

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">{title}</h1>
        {subtitle !== '' && (
          <p className="text-sm text-gray-500 mt-1">
            {subtitle ?? '汇总工作流 / 定时任务 / API / 数据库等各类执行，按 trace 关联，快速定位失败'}
          </p>
        )}
      </div>

      {/* 来源 Tab */}
      <div className="flex space-x-1 bg-gray-100 p-1 rounded-lg w-fit">
        {SOURCES.map((s) => (
          <button
            key={s.id}
            onClick={() => { setSource(s.id); setPage(0) }}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              source === s.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* 筛选 */}
      <div className="card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            className="input-base text-sm"
          >
            <option value="">全部状态</option>
            <option value="success">success</option>
            <option value="running">running</option>
            <option value="failed">failed</option>
            <option value="timeout">timeout</option>
            <option value="cancelled">cancelled</option>
          </select>
          <input
            type="text"
            placeholder="名称筛选（工作流名 / 任务名 / 路径）"
            value={filters.name}
            onChange={(e) => setFilters({ ...filters, name: e.target.value })}
            className="input-base text-sm flex-1 min-w-[200px]"
          />
          <input
            type="text"
            placeholder="trace_id 直查"
            value={filters.trace_id}
            onChange={(e) => setFilters({ ...filters, trace_id: e.target.value })}
            className="input-base text-sm w-64 font-mono"
          />
          <label className="inline-flex items-center text-sm text-gray-700 space-x-2">
            <input
              type="checkbox"
              checked={filters.failed_only}
              onChange={(e) => setFilters({ ...filters, failed_only: e.target.checked })}
            />
            <span>仅看失败/超时</span>
          </label>
          <button onClick={() => { setPage(0); load(); loadCount() }} className="btn-primary text-sm">
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
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">来源</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">名称</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">状态</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">耗时</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">错误摘要</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">trace</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {loading ? (
              <tr><td colSpan={7} className="text-center py-8 text-gray-400">
                <i className="fas fa-spinner fa-spin mr-2"></i>加载中...
              </td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={7} className="text-center py-8 text-gray-400">暂无执行记录</td></tr>
            ) : (
              rows.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => openDetail(r.trace_id)}
                  className={`hover:bg-gray-50 cursor-pointer ${r.status === 'failed' || r.status === 'timeout' ? 'bg-red-50/40' : ''}`}
                >
                  <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtTime(r.started_at)}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${sourceBadge(r.source)}`}>{r.source}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-800 max-w-xs truncate" title={r.name ?? ''}>{r.name ?? '-'}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusBadge(r.status)}`}>{r.status}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600">{fmtDur(r.duration_ms)}</td>
                  <td className="px-4 py-3 text-xs text-red-700 max-w-xs truncate" title={r.error_brief ?? ''}>{r.error_brief ?? '-'}</td>
                  <td className="px-4 py-3 text-xs font-mono text-gray-400">{r.trace_id.slice(0, 8)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        <Pagination
          total={total}
          totalCapped={totalCapped}
          page={page + 1}
          pageSize={pageSize}
          onPageChange={(p) => setPage(p - 1)}
          onPageSizeChange={(s) => {
            setPageSize(s)
            setPage(0)
          }}
          className="px-4 py-3 border-t bg-white"
        />
      </div>

      {/* 详情抽屉 */}
      {detail && (
        <div
          className="fixed inset-0 z-40 flex justify-end"
          style={{ paddingRight: aiOffset }}
          onClick={() => setDetail(null)}
        >
          <div className="absolute inset-0 bg-black/30" />
          <div
            className="relative w-full max-w-2xl h-full bg-white shadow-xl overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-white border-b px-5 py-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">执行详情</h2>
                <p className="text-xs font-mono text-gray-400 mt-0.5">{detail.trace_id}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => navigator.clipboard?.writeText(detail.trace_id)}
                  className="btn-default text-xs"
                  title="复制 trace_id"
                >
                  <i className="fas fa-copy mr-1"></i>复制 trace
                </button>
                <button onClick={() => setDetail(null)} className="text-gray-400 hover:text-gray-600">
                  <i className="fas fa-times text-lg"></i>
                </button>
              </div>
            </div>

            <div className="p-5 space-y-5">
              {/* 执行索引（可能多行：重试） */}
              <div>
                <h3 className="text-sm font-medium text-gray-700 mb-2">执行记录</h3>
                <div className="space-y-2">
                  {detail.index.map((ix) => {
                    const displayStatus = resolveDisplayStatus(ix)
                    const displayError = resolveDisplayError(ix)
                    return (
                    <div key={ix.id} className="border rounded-lg p-3 text-sm">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${sourceBadge(ix.source)}`}>{ix.source}</span>
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusBadge(displayStatus)}`}>{displayStatus}</span>
                        <span className="text-gray-800 font-medium truncate">{ix.name ?? '-'}</span>
                      </div>
                      <div className="text-xs text-gray-500 grid grid-cols-2 gap-x-4 gap-y-0.5">
                        <span>开始：{fmtTime(ix.started_at)}</span>
                        <span>结束：{fmtTime(ix.finished_at)}</span>
                        <span>耗时：{fmtDur(resolveDisplayDuration(ix))}</span>
                        <span>来源表：{ix.ref_table ?? '-'}{ix.ref_id != null ? `#${ix.ref_id}` : ''}</span>
                      </div>
                      {displayError && (
                        <div className="mt-2 text-xs text-red-700 bg-red-50 rounded p-2 font-mono whitespace-pre-wrap break-all">
                          {displayError}
                        </div>
                      )}
                      {ix.detail && <RefDetail d={ix.detail} />}
                    </div>
                    )
                  })}
                </div>
              </div>

              {/* 细节日志时间线 */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-medium text-gray-700">细节日志时间线</h3>
                  <select
                    value={levelFilter}
                    onChange={(e) => setLevelFilter(e.target.value)}
                    className="input-base text-xs"
                  >
                    <option value="">全部级别</option>
                    <option value="ERROR">ERROR</option>
                    <option value="WARN">WARN</option>
                    <option value="INFO">INFO</option>
                    <option value="DEBUG">DEBUG</option>
                  </select>
                </div>

                {detailLoading ? (
                  <div className="text-center py-8 text-gray-400">
                    <i className="fas fa-spinner fa-spin mr-2"></i>加载中...
                  </div>
                ) : detail.logs.length === 0 ? (
                  <div className="text-xs text-gray-400 py-6 text-center border rounded-lg">
                    暂无细节日志（HTTP 触发的执行会记录逐条时间线；cron 触发暂只有上方执行记录）
                  </div>
                ) : (
                  <div className="space-y-1 font-mono text-xs">
                    {detail.logs
                      .filter((l) => !levelFilter || l.level === levelFilter)
                      .map((l) => (
                        <div key={l.id} className="border-b border-gray-100 py-1.5">
                          <div className="flex items-start gap-2">
                            <span className="text-gray-400 whitespace-nowrap">
                              {new Date(l.ts).toLocaleTimeString('zh-CN')}
                            </span>
                            <span className={`font-semibold w-12 flex-shrink-0 ${levelColor(l.level)}`}>{l.level}</span>
                            <span className="text-gray-700 break-all">{l.message}</span>
                          </div>
                          {(l.span || l.logger) && (
                            <div className="ml-[5.5rem] text-[11px] text-gray-400">
                              {l.logger}{l.span ? ` · ${l.span}` : ''}
                            </div>
                          )}
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
