'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { useAppStore } from '@/lib/store'
import {
  dashboardAPI,
  type DashboardOverview,
  type DashboardActivityRow,
} from '@/lib/api'

/**
 * 项目首页 / M6 简化大盘。
 *
 * 历史：W1/W2 时这里是 4 张 placeholder 卡（'数据表 / API 端点 / RPC 函数 / 本月调用量'），
 * 后三张写死 '—'。M6 落地后改成 spec §2.3 要求的 6 张应用层指标卡 + 24h sparkline +
 * sanitized 最近活动 feed，复用同一页面避免新建路由。
 *
 * 数据源（所有都按 tenant_id 过滤、含 viewer 可读）：
 *   - GET /api/dashboard/overview        → 6 指标 + 24 hourly buckets
 *   - GET /api/dashboard/recent-activity → 最近 10 条 sanitized audit log
 *
 * 自动刷新：组件挂载 + currentProject 变化时拉一次；之后 30s 一次轻量刷新。
 * 切项目时立即重新拉，避免看到上一个项目的残留数据。
 */
export default function WorkspaceHome() {
  const params = useParams<{ projectId: string }>()
  const currentProject = useAppStore((s) => s.currentProject)

  const base = `/workspace/${params.projectId}`
  const tenantId = currentProject?.id

  const [overview, setOverview] = useState<DashboardOverview | null>(null)
  const [activity, setActivity] = useState<DashboardActivityRow[]>([])
  const [overviewError, setOverviewError] = useState<string | null>(null)

  useEffect(() => {
    if (!tenantId) {
      setOverview(null)
      setActivity([])
      return
    }
    let cancelled = false
    const pull = async () => {
      try {
        const [ov, act] = await Promise.allSettled([
          dashboardAPI.getOverview(tenantId),
          dashboardAPI.getRecentActivity(tenantId, 10),
        ])
        if (cancelled) return
        if (ov.status === 'fulfilled') {
          setOverview(ov.value.data)
          setOverviewError(null)
        } else {
          // 大盘指标拉失败：极有可能是 audit_logs 还没产生（新项目刚开通），
          // 用空数据兜底比红条更优雅；保留 error 给下方区块作为兜底说明。
          setOverview(null)
          setOverviewError(ov.reason?.response?.data?.error ?? '加载大盘失败')
        }
        if (act.status === 'fulfilled') setActivity(act.value.data)
        else setActivity([])
      } catch {
        // Promise.allSettled 不会进 catch；这里只是 TS 兜底
      }
    }
    pull()
    const timer = setInterval(pull, 30_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [tenantId])

  const sparklineData = useMemo(
    () => (overview?.hourly_24h ?? []).map((b) => b.count),
    [overview]
  )

  const hasAnyData = overview && (
    overview.calls_24h > 0 ||
    overview.slow_queries_24h > 0 ||
    overview.active_api_keys > 0
  )

  return (
    <div className="space-y-6">
      {/* 项目元信息 */}
      <div className="bg-white border border-gray-200 rounded-lg p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">
              {currentProject?.name ?? params.projectId}
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              {currentProject?.slug && (
                <span>
                  slug:{' '}
                  <code className="px-1.5 py-0.5 bg-gray-100 rounded font-mono">
                    {currentProject.slug}
                  </code>
                </span>
              )}
              {currentProject?.status && (
                <span className="ml-3">
                  状态: <span className="text-green-600">{currentProject.status}</span>
                </span>
              )}
              {currentProject?.user_role && (
                <span className="ml-3">
                  你的角色:{' '}
                  <span className="px-1.5 py-0.5 bg-blue-50 text-blue-700 border border-blue-200 rounded text-xs font-mono">
                    {currentProject.user_role}
                  </span>
                </span>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* 6 张 M6 指标卡 */}
      <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <MetricCard
          icon="fa-bolt"
          label="QPS（5min）"
          value={overview ? overview.qps_5min.toFixed(2) : '—'}
          color="blue"
          href={`${base}/monitor`}
        />
        <MetricCard
          icon="fa-stopwatch"
          label="P95（5min）"
          value={overview?.p95_ms_5min != null ? `${Math.round(overview.p95_ms_5min)} ms` : '—'}
          color="indigo"
          href={`${base}/monitor`}
        />
        <MetricCard
          icon="fa-exclamation-triangle"
          label="错误率（24h）"
          value={overview?.error_rate_24h != null ? `${(overview.error_rate_24h * 100).toFixed(2)}%` : '—'}
          color={overview?.error_rate_24h != null && overview.error_rate_24h > 0.05 ? 'red' : 'green'}
          href={`${base}/database/slow-queries`}
        />
        <MetricCard
          icon="fa-hourglass-half"
          label="慢查询（24h）"
          value={overview ? String(overview.slow_queries_24h) : '—'}
          color={overview && overview.slow_queries_24h > 0 ? 'yellow' : 'gray'}
          href={`${base}/database/slow-queries`}
        />
        <MetricCard
          icon="fa-key"
          label="活跃 API Key"
          value={overview ? String(overview.active_api_keys) : '—'}
          color="emerald"
          href={`${base}/security/api-keys`}
        />
        <MetricCard
          icon="fa-chart-bar"
          label="调用量（24h）"
          value={overview ? formatCalls(overview.calls_24h) : '—'}
          color="purple"
          href={`${base}/api`}
        />
      </section>

      {/* 24h sparkline */}
      <section className="bg-white border border-gray-200 rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-medium text-gray-900">24 小时调用趋势</h2>
          <span className="text-xs text-gray-400">
            每小时一个点 · 最右 = 最近一小时
          </span>
        </div>
        {hasAnyData && sparklineData.some((v) => v > 0) ? (
          <Sparkline data={sparklineData} />
        ) : (
          <div className="py-6 text-center text-xs text-gray-400">
            {overviewError ? (
              <span>暂时拿不到趋势数据（{overviewError}）</span>
            ) : (
              <span>项目还没有 API 调用——先去 <Link href={`${base}/database/tables`} className="text-blue-600 hover:underline">建表</Link> 或 <Link href={`${base}/api`} className="text-blue-600 hover:underline">试一下 REST API</Link></span>
            )}
          </div>
        )}
      </section>

      {/* 最近活动 feed */}
      <section className="bg-white border border-gray-200 rounded-lg">
        <div className="px-4 py-3 border-b border-gray-100 flex items-baseline justify-between">
          <div>
            <h2 className="text-sm font-medium text-gray-900">最近活动</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              来自本项目 audit 日志的最近 10 条
            </p>
          </div>
          <span className="text-xs text-gray-400">
            * 仅显示请求摘要，不暴露 IP / 请求体
          </span>
        </div>
        {activity.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-gray-400">
            <i className="fas fa-clock mb-2 text-xl"></i>
            <p>暂无活动数据</p>
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {activity.map((row) => (
              <ActivityItem key={row.id} row={row} />
            ))}
          </ul>
        )}
      </section>

      {/* 快捷入口（保留） */}
      <section className="bg-white border border-gray-200 rounded-lg p-4">
        <h2 className="text-sm font-medium text-gray-900 mb-3">快捷入口</h2>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`${base}/database/table-designer?mode=create`}
            className="px-3 py-1.5 text-xs bg-blue-50 text-blue-700 rounded hover:bg-blue-100"
          >
            <i className="fas fa-plus mr-1"></i> 建表
          </Link>
          <Link
            href={`${base}/rpc`}
            className="px-3 py-1.5 text-xs bg-blue-50 text-blue-700 rounded hover:bg-blue-100"
          >
            <i className="fas fa-terminal mr-1"></i> 调用 RPC
          </Link>
          <Link
            href={`${base}/events/webhooks`}
            className="px-3 py-1.5 text-xs bg-blue-50 text-blue-700 rounded hover:bg-blue-100"
          >
            <i className="fas fa-broadcast-tower mr-1"></i> 配 Webhook
          </Link>
          <Link
            href={`${base}/api`}
            className="px-3 py-1.5 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
          >
            <i className="fas fa-cloud mr-1"></i> 查看 API 文档
          </Link>
        </div>
      </section>
    </div>
  )
}

// ─── 子组件 ────────────────────────────────────────────────────

function MetricCard({
  icon,
  label,
  value,
  color,
  href,
}: {
  icon: string
  label: string
  value: string
  color: 'blue' | 'indigo' | 'green' | 'red' | 'yellow' | 'emerald' | 'purple' | 'gray'
  href: string
}) {
  const colors: Record<typeof color, string> = {
    blue: 'text-blue-600 bg-blue-50',
    indigo: 'text-indigo-600 bg-indigo-50',
    green: 'text-green-600 bg-green-50',
    red: 'text-red-600 bg-red-50',
    yellow: 'text-yellow-700 bg-yellow-50',
    emerald: 'text-emerald-600 bg-emerald-50',
    purple: 'text-purple-600 bg-purple-50',
    gray: 'text-gray-600 bg-gray-50',
  }
  return (
    <Link
      href={href}
      className="bg-white border border-gray-200 rounded-lg p-3 hover:shadow-sm hover:border-blue-300 transition"
    >
      <div className={`inline-flex items-center justify-center w-7 h-7 rounded-md ${colors[color]} mb-2`}>
        <i className={`fas ${icon} text-xs`}></i>
      </div>
      <p className="text-xs text-gray-500 truncate">{label}</p>
      <p className="text-lg font-semibold text-gray-900 mt-0.5 tabular-nums">{value}</p>
    </Link>
  )
}

/**
 * Inline SVG sparkline — 不引第三方图表库。
 * 24 个点用 polyline 拉直线；最后一个点高亮成 dot。
 * 全 0 时调用方应该不渲染本组件（由父级 sparklineData.some(>0) 决定）。
 */
function Sparkline({ data, height = 56 }: { data: number[]; height?: number }) {
  if (data.length === 0) return null
  const max = Math.max(...data, 1)
  const w = 600
  const step = w / Math.max(data.length - 1, 1)
  const points = data
    .map((v, i) => `${(i * step).toFixed(2)},${(height - (v / max) * (height - 6) - 3).toFixed(2)}`)
    .join(' ')
  const lastX = ((data.length - 1) * step).toFixed(2)
  const lastY = (height - (data[data.length - 1] / max) * (height - 6) - 3).toFixed(2)
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="w-full" style={{ height }}>
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-blue-500"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={lastX} cy={lastY} r="3" className="fill-blue-500" />
    </svg>
  )
}

function ActivityItem({ row }: { row: DashboardActivityRow }) {
  const status = row.response_status
  const statusColor = status == null
    ? 'text-gray-400'
    : status >= 500
      ? 'text-red-600 bg-red-50'
      : status >= 400
        ? 'text-yellow-700 bg-yellow-50'
        : 'text-green-600 bg-green-50'
  return (
    <li className="px-4 py-2.5 flex items-center justify-between text-sm hover:bg-gray-50">
      <div className="flex items-center gap-3 min-w-0">
        <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${methodBadge(row.request_method)}`}>
          {row.request_method}
        </span>
        <code className="text-xs text-gray-700 truncate min-w-0" title={row.resource}>
          {row.resource}
        </code>
      </div>
      <div className="flex items-center gap-3 text-xs flex-shrink-0">
        <span className={`px-1.5 py-0.5 rounded ${statusColor}`}>
          {status ?? '—'}
        </span>
        <span className="text-gray-400 tabular-nums">
          {row.duration_ms != null ? `${row.duration_ms} ms` : '—'}
        </span>
        <span className="text-gray-400 tabular-nums" title={row.created_at}>
          {formatAge(row.created_at)}
        </span>
      </div>
    </li>
  )
}

function methodBadge(method: string): string {
  switch (method.toUpperCase()) {
    case 'GET': return 'text-blue-700 bg-blue-50'
    case 'POST': return 'text-green-700 bg-green-50'
    case 'PATCH':
    case 'PUT': return 'text-yellow-700 bg-yellow-50'
    case 'DELETE': return 'text-red-700 bg-red-50'
    default: return 'text-gray-600 bg-gray-100'
  }
}

function formatCalls(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatAge(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return iso
  const diff = Date.now() - t
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}
