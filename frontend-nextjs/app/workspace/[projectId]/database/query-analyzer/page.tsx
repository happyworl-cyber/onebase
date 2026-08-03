'use client'

/**
 * `/workspace/[projectId]/database/query-analyzer` —— 项目级 pg_stat_statements
 * 视图（W3 carryover from W2 Task 10）。
 *
 * 数据源走 X-Database-Id 路由，由 workspace layout 把 primary_connection 铺到
 * currentConnection 之后，queryPerfAPI 就能自动定位到项目主 db。useEffect 的
 * 依赖从 `currentTenant?.id` 换成 URL 里的 projectId——这个值在 workspace 下
 * 才是稳定的，而 currentTenant 已经被 layout 清掉了。
 */

import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import {
  queryPerfAPI,
  StatementStat,
  QueryPerfExtensionStatus,
} from '@/lib/api'
import { useNotification } from '@/hooks/useNotification'
import Drawer from '@/components/Drawer'
import { askAi } from '@/lib/aiAssistant'
import { genRequestId } from '@/lib/embedBridge'

type OrderBy =
  | 'mean_exec_time'
  | 'total_exec_time'
  | 'calls'
  | 'rows'
  | 'max_exec_time'

const PAGE_SIZE = 50

const ORDER_OPTIONS: { value: OrderBy; label: string }[] = [
  { value: 'mean_exec_time', label: '平均耗时' },
  { value: 'total_exec_time', label: '总耗时' },
  { value: 'calls', label: '调用次数' },
  { value: 'max_exec_time', label: '最长耗时' },
  { value: 'rows', label: '返回行数' },
]

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '-'
  if (ms < 1) return `${ms.toFixed(3)} ms`
  if (ms < 1000) return `${ms.toFixed(2)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`
  const m = Math.floor(ms / 60_000)
  const s = ((ms % 60_000) / 1000).toFixed(1)
  return `${m}m ${s}s`
}

function fmtNum(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`
  return String(n)
}

function fmtRatio(r: number): string {
  return `${(r * 100).toFixed(1)}%`
}

export default function QueryAnalyzerPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const notify = useNotification()

  const [extStatus, setExtStatus] = useState<QueryPerfExtensionStatus | null>(null)
  const [statements, setStatements] = useState<StatementStat[]>([])
  const [loading, setLoading] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(false)

  // 过滤 / 排序参数
  const [orderBy, setOrderBy] = useState<OrderBy>('mean_exec_time')
  const [search, setSearch] = useState('')
  const [minCalls, setMinCalls] = useState<number>(1)
  const [minMeanMs, setMinMeanMs] = useState<number>(0)
  const [page, setPage] = useState(0)

  // 详情抽屉
  const [detail, setDetail] = useState<StatementStat | null>(null)

  const loadExtension = async () => {
    try {
      const res = await queryPerfAPI.getExtensionStatus()
      setExtStatus(res.data)
    } catch (err: any) {
      notify.error(err)
    }
  }

  const load = async () => {
    setLoading(true)
    try {
      const res = await queryPerfAPI.listStatements({
        order_by: orderBy,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        min_calls: minCalls,
        min_mean_ms: minMeanMs,
        search: search.trim() || undefined,
      })
      setStatements(res.data || [])
    } catch (err: any) {
      notify.error(err)
      setStatements([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadExtension()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderBy, page, projectId])

  useEffect(() => {
    if (!autoRefresh) return
    const t = setInterval(() => load(), 5000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, orderBy, page])

  const handleApplyFilters = () => {
    setPage(0)
    load()
  }

  // 把某条 pg_stat_statements 记录（SQL + 关键统计）交给 AI 分析优化
  const analyzeStatementWithAi = (s: StatementStat) => {
    askAi({
      prompt:
        '下面这条 SQL 的 pg_stat_statements 统计如下，请分析性能瓶颈并给出优化建议' +
        '（索引、改写、缓存命中等角度）：\n\n' +
        '```sql\n' +
        s.query +
        '\n```\n\n' +
        `- 调用次数：${fmtNum(s.calls)}\n` +
        `- 平均耗时：${fmtMs(s.mean_exec_time)}\n` +
        `- 最长耗时：${fmtMs(s.max_exec_time)}\n` +
        `- 总耗时：${fmtMs(s.total_exec_time)}\n` +
        `- 累计返回行数：${fmtNum(s.rows)}\n` +
        `- 缓存命中率：${fmtRatio(s.hit_ratio)}`,
      requestId: genRequestId('stmt-analyze'),
    })
  }

  const handleReset = async () => {
    setResetting(true)
    try {
      await queryPerfAPI.resetStatements()
      notify.success('已重置 pg_stat_statements 统计')
      setConfirmReset(false)
      setPage(0)
      await load()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setResetting(false)
    }
  }

  const totalAggregate = useMemo(() => {
    if (!statements.length) {
      return { calls: 0, totalMs: 0, rows: 0 }
    }
    return statements.reduce(
      (acc, s) => ({
        calls: acc.calls + s.calls,
        totalMs: acc.totalMs + s.total_exec_time,
        rows: acc.rows + s.rows,
      }),
      { calls: 0, totalMs: 0, rows: 0 },
    )
  }, [statements])

  const extInstalled = extStatus?.installed ?? true

  return (
    <div className="space-y-6">
      {/* 顶部 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">查询性能</h1>
          <p className="text-sm text-gray-500 mt-1">
            基于 pg_stat_statements，按耗时 / 调用次数 / 命中率剖析当前数据库的 SQL
          </p>
        </div>
        <div className="flex items-center space-x-3">
          <label className="flex items-center space-x-2 cursor-pointer text-sm text-gray-600">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="w-4 h-4 text-blue-600 rounded"
            />
            <span>每 5s 自动刷新</span>
          </label>
          <button onClick={load} className="btn-default text-sm" disabled={loading}>
            <i className={`fas fa-sync-alt mr-1 ${loading ? 'fa-spin' : ''}`}></i>
            刷新
          </button>
          <button
            onClick={() => setConfirmReset(true)}
            className="btn-default text-sm text-red-600 hover:bg-red-50"
            disabled={!extInstalled}
            title={extInstalled ? '清空统计计数（仅超管）' : '扩展未启用'}
          >
            <i className="fas fa-eraser mr-1"></i>重置统计
          </button>
        </div>
      </div>

      {/* 扩展未启用提示 */}
      {extStatus && !extStatus.installed && (
        <div className="card p-4 border-l-4 border-yellow-400 bg-yellow-50">
          <div className="flex items-start space-x-3">
            <i className="fas fa-exclamation-triangle text-yellow-500 mt-0.5"></i>
            <div className="flex-1">
              <h3 className="font-medium text-yellow-900">pg_stat_statements 未启用</h3>
              <p className="text-sm text-yellow-800 mt-1">{extStatus.install_hint}</p>
              {extStatus.shared_preload != null && (
                <p className="text-xs text-yellow-700 mt-2">
                  当前 <code className="px-1 bg-white/50 rounded">shared_preload_libraries</code>：
                  <code className="ml-1 break-all">{extStatus.shared_preload || '(空)'}</code>
                </p>
              )}
              <div className="text-xs text-yellow-700 mt-2 font-mono bg-white/60 rounded p-2 select-all">
                ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';<br />
                -- 重启 PostgreSQL，然后：<br />
                CREATE EXTENSION pg_stat_statements;
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 过滤栏 */}
      <div className="card p-4 grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
        <div className="md:col-span-4">
          <label className="block text-xs text-gray-500 mb-1">搜索 SQL（ILIKE）</label>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleApplyFilters()
            }}
            placeholder="例如 SELECT 或 users"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs text-gray-500 mb-1">最小调用次数</label>
          <input
            type="number"
            min={0}
            value={minCalls}
            onChange={(e) => setMinCalls(Math.max(0, Number(e.target.value) || 0))}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs text-gray-500 mb-1">最小平均耗时 (ms)</label>
          <input
            type="number"
            min={0}
            value={minMeanMs}
            onChange={(e) => setMinMeanMs(Math.max(0, Number(e.target.value) || 0))}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs text-gray-500 mb-1">排序</label>
          <select
            value={orderBy}
            onChange={(e) => {
              setOrderBy(e.target.value as OrderBy)
              setPage(0)
            }}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {ORDER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label} 降序
              </option>
            ))}
          </select>
        </div>
        <div className="md:col-span-2">
          <button
            onClick={handleApplyFilters}
            className="btn-primary w-full text-sm"
            disabled={loading}
          >
            <i className="fas fa-filter mr-1"></i>应用筛选
          </button>
        </div>
      </div>

      {/* 概览卡片 —— 当前结果集的合计 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryCard label="结果条数" value={String(statements.length)} icon="fa-list" />
        <SummaryCard label="累计调用" value={fmtNum(totalAggregate.calls)} icon="fa-bolt" />
        <SummaryCard label="累计耗时" value={fmtMs(totalAggregate.totalMs)} icon="fa-stopwatch" />
        <SummaryCard label="累计行数" value={fmtNum(totalAggregate.rows)} icon="fa-table" />
      </div>

      {/* 列表 */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3">SQL</th>
                <th className="px-4 py-3 whitespace-nowrap text-right">调用</th>
                <th className="px-4 py-3 whitespace-nowrap text-right">总耗时</th>
                <th className="px-4 py-3 whitespace-nowrap text-right">平均</th>
                <th className="px-4 py-3 whitespace-nowrap text-right">最长</th>
                <th className="px-4 py-3 whitespace-nowrap text-right">行数</th>
                <th className="px-4 py-3 whitespace-nowrap text-right">缓存命中</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {loading && statements.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                    <i className="fas fa-spinner fa-spin mr-2"></i>加载中…
                  </td>
                </tr>
              )}
              {!loading && statements.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                    暂无符合条件的查询统计
                  </td>
                </tr>
              )}
              {statements.map((s, i) => (
                <tr
                  key={`${s.queryid ?? 'q'}-${i}`}
                  onClick={() => setDetail(s)}
                  className="hover:bg-blue-50 cursor-pointer"
                >
                  <td className="px-4 py-3 max-w-xl">
                    <code className="font-mono text-xs text-gray-800 line-clamp-2 break-all">
                      {s.query}
                    </code>
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">{fmtNum(s.calls)}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">{fmtMs(s.total_exec_time)}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap font-medium text-gray-900">
                    {fmtMs(s.mean_exec_time)}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">{fmtMs(s.max_exec_time)}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">{fmtNum(s.rows)}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <HitRatioBadge ratio={s.hit_ratio} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 分页 */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 bg-gray-50 text-sm text-gray-600">
          <div>
            第 {page + 1} 页 · 每页 {PAGE_SIZE} 条
          </div>
          <div className="flex items-center space-x-2">
            <button
              className="btn-default text-xs disabled:opacity-50"
              disabled={page === 0 || loading}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              <i className="fas fa-chevron-left mr-1"></i>上一页
            </button>
            <button
              className="btn-default text-xs disabled:opacity-50"
              disabled={statements.length < PAGE_SIZE || loading}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页<i className="fas fa-chevron-right ml-1"></i>
            </button>
          </div>
        </div>
      </div>

      {/* 详情抽屉 */}
      <Drawer
        isOpen={!!detail}
        onClose={() => setDetail(null)}
        title="查询详情"
        size="xl"
        footer={
          detail ? (
            <div className="flex justify-end">
              <button
                onClick={() => analyzeStatementWithAi(detail)}
                className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-lg text-white bg-gradient-to-br from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 transition-colors"
              >
                <i className="fas fa-robot mr-2"></i>
                AI 分析优化
              </button>
            </div>
          ) : undefined
        }
      >
        {detail && (
          <div className="space-y-4">
            <div>
              <div className="text-xs text-gray-500 mb-1">SQL</div>
              <pre className="bg-gray-900 text-green-300 text-xs font-mono p-4 rounded-md overflow-auto max-h-72 whitespace-pre-wrap">
                {detail.query}
              </pre>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <DetailField label="Query ID" value={detail.queryid?.toString() ?? '-'} />
              <DetailField label="调用次数" value={fmtNum(detail.calls)} />
              <DetailField label="返回行数（累计）" value={fmtNum(detail.rows)} />
              <DetailField label="总耗时" value={fmtMs(detail.total_exec_time)} />
              <DetailField label="平均耗时" value={fmtMs(detail.mean_exec_time)} highlight />
              <DetailField label="最短耗时" value={fmtMs(detail.min_exec_time)} />
              <DetailField label="最长耗时" value={fmtMs(detail.max_exec_time)} />
              <DetailField
                label="标准差"
                value={fmtMs(detail.stddev_exec_time)}
              />
              <DetailField
                label="缓存命中率"
                value={fmtRatio(detail.hit_ratio)}
                highlight
              />
              <DetailField
                label="shared 命中块"
                value={fmtNum(detail.shared_blks_hit)}
              />
              <DetailField
                label="shared 读取块"
                value={fmtNum(detail.shared_blks_read)}
              />
            </div>
          </div>
        )}
      </Drawer>

      {/* 重置确认 */}
      <Drawer
        isOpen={confirmReset}
        onClose={() => !resetting && setConfirmReset(false)}
        title="重置查询统计"
        size="md"
        footer={
          <div className="flex justify-end space-x-2">
            <button
              className="btn-default"
              onClick={() => setConfirmReset(false)}
              disabled={resetting}
            >
              取消
            </button>
            <button className="btn-primary bg-red-600 hover:bg-red-700" onClick={handleReset} disabled={resetting}>
              {resetting ? '执行中…' : '确认重置'}
            </button>
          </div>
        }
      >
        <div className="space-y-3 text-sm text-gray-700">
          <p>
            将调用 <code>pg_stat_statements_reset()</code>，把当前数据库的所有查询统计计数清零。
          </p>
          <p className="text-yellow-700 bg-yellow-50 p-3 rounded">
            <i className="fas fa-exclamation-triangle mr-1"></i>
            操作不可逆。所有用户都会丢失既有的统计样本，新的样本要等查询再次发生才会出现。
          </p>
        </div>
      </Drawer>
    </div>
  )
}

function SummaryCard({
  label,
  value,
  icon,
}: {
  label: string
  value: string
  icon: string
}) {
  return (
    <div className="card p-4 flex items-center space-x-3">
      <div className="w-10 h-10 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center">
        <i className={`fas ${icon}`}></i>
      </div>
      <div>
        <div className="text-xs text-gray-500">{label}</div>
        <div className="text-lg font-semibold text-gray-900">{value}</div>
      </div>
    </div>
  )
}

function HitRatioBadge({ ratio }: { ratio: number }) {
  const pct = ratio * 100
  const cls =
    pct >= 95
      ? 'bg-green-100 text-green-800'
      : pct >= 80
      ? 'bg-yellow-100 text-yellow-800'
      : 'bg-red-100 text-red-800'
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {pct.toFixed(1)}%
    </span>
  )
}

function DetailField({
  label,
  value,
  highlight,
}: {
  label: string
  value: string
  highlight?: boolean
}) {
  return (
    <div className={`p-3 rounded-md border ${highlight ? 'border-blue-200 bg-blue-50' : 'border-gray-200 bg-gray-50'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-sm font-medium mt-1 ${highlight ? 'text-blue-700' : 'text-gray-900'}`}>
        {value}
      </div>
    </div>
  )
}
