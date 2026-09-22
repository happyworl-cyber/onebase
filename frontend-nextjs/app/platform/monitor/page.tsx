'use client'

/**
 * `/platform/monitor` —— 平台级运维总览。
 *
 * Tab：总览 | 流量 | 异步 | 告警
 * 数据：/api/admin/platform-monitor/* + 既有 slow-queries / circuit-breakers
 */

import { Suspense, useState, useEffect, useCallback } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import api from '@/lib/api'
import { useTranslations, useMessages } from 'next-intl'

type Tab = 'overview' | 'traffic' | 'async' | 'diagnose' | 'alerts'

interface AppSlowQuery {
  id: number
  database_id: number | null
  schema_name: string | null
  table_name: string | null
  sql_preview: string | null
  duration_ms: number
  created_at: string
}

interface CircuitBreakerInfo {
  database_id: number
  state: string
}

interface Overview {
  health: {
    mgmt_db: string
    redis: string
    version: string
    mgmt_pool: { size: number; idle: number }
    active_pools: number
  }
  traffic: {
    qps_5min: number | null
    p95_ms_5min: number | null
    error_rate_24h: number | null
    calls_5min: number | null
    calls_24h: number | null
    slow_queries_5min: number | null
    slow_queries_24h: number | null
    hourly_24h: { hour: string; count: number; err_5xx: number }[]
  }
  runtime: {
    circuit_open_count: number
    circuit_half_open_count: number
    rate_limit_degraded: boolean
    rate_limit: Record<string, unknown> | null
  }
  async: {
    execution_stats: { source: string; status: string; count: number }[]
    exec_failed_24h: number
    scheduler: {
      total_tasks: number
      active_tasks: number
      runs_24h: number
      failed_24h: number
    } | null
    sse: {
      connections: { total: number; public: number; generic: number }
      pushes_total: number
      listeners: unknown
    } | null
  }
  signals?: {
    rate_limited_429_1h: number
    auth_failures_1h: number
    stuck_running: number
    stuck_workflow: number
    expiring_api_keys_7d: number
    expiring_tokens_7d: number
    webhook_failures_24h: number
  }
  anomalies?: { level: string; code: string; message: string; params?: Record<string, unknown> }[]
  warnings?: string[]
  signal_samples?: {
    stuck_running: {
      total: number
      items: {
        trace_id: string
        source: string
        name: string | null
        tenant_id: number | null
        project_name: string | null
        organization_id: number | null
        organization_name: string | null
        started_at: string
        running_for_seconds: number | null
      }[]
    }
    expiring_api_keys: {
      total: number
      items: {
        id: number
        name: string
        key_prefix: string
        tenant_id: number
        project_name: string | null
        organization_id: number | null
        organization_name: string | null
        expires_at: string
        days_left: number | null
      }[]
    }
  }
}

const EMPTY_SIGNALS = {
  rate_limited_429_1h: 0,
  auth_failures_1h: 0,
  stuck_running: 0,
  stuck_workflow: 0,
  expiring_api_keys_7d: 0,
  expiring_tokens_7d: 0,
  webhook_failures_24h: 0,
}

const EMPTY_SIGNAL_SAMPLES: NonNullable<Overview['signal_samples']> = {
  stuck_running: { total: 0, items: [] },
  expiring_api_keys: { total: 0, items: [] },
}

interface TopEndpoint {
  request_path: string
  calls: number
  err_5xx: number
  err_4xx: number
  p95: number | null
  avg_ms: number | null
}

interface FailedExecution {
  trace_id: string
  source: string
  name: string | null
  status: string
  tenant_id: number | null
  started_at: string
  duration_ms: number | null
  error_brief: string | null
}

interface Http5xx {
  request_method: string
  request_path: string
  response_status: number | null
  tenant_id: number | null
  duration_ms: number | null
  ip_address: string | null
  created_at: string
}

interface TenantRow {
  tenant_id: number | null
  tenant_name: string | null
  calls: number
  err_5xx: number
  p95: number | null
  slow_queries: number
}

interface TsPoint {
  sampled_at: string
  qps_5min: number | null
  p95_ms_5min: number | null
  error_rate_24h: number | null
  slow_queries_5min: number | null
  circuit_open_count: number | null
  exec_failed_24h: number | null
}

interface AlertConfig {
  enabled: boolean
  webhook_url: string | null
  webhook_template: Record<string, unknown> | null
  default_throttle_hours: number
  updated_at?: string | null
}

interface AlertRule {
  id: number
  name: string
  metric: string
  operator: string
  threshold: number
  window: string
  enabled: boolean
  throttle_hours: number | null
  last_fired_at: string | null
}

interface AlertEvent {
  id: number
  rule_name: string
  metric: string
  value: number | null
  threshold: number | null
  status: string
  error: string | null
  created_at: string
}

function fmtPct(v: number | null | undefined) {
  if (v == null) return '—'
  return `${(v * 100).toFixed(2)}%`
}

function fmtNum(v: number | null | undefined, digits = 1) {
  if (v == null) return '—'
  return Number.isInteger(v) ? String(v) : v.toFixed(digits)
}

function healthBadge(status: string) {
  if (status === 'healthy' || status === 'ok') return 'bg-green-100 text-green-800'
  if (status === 'not_configured') return 'bg-gray-100 text-gray-600'
  return 'bg-red-100 text-red-800'
}

function Sparkline({ data, height = 48 }: { data: number[]; height?: number }) {
  if (data.length === 0) return null
  const max = Math.max(...data, 1)
  const w = 600
  const step = w / Math.max(data.length - 1, 1)
  const points = data
    .map((v, i) => `${(i * step).toFixed(2)},${(height - (v / max) * (height - 6) - 3).toFixed(2)}`)
    .join(' ')
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
    </svg>
  )
}

function Kpi({
  label,
  value,
  warn,
  onClick,
  active,
}: {
  label: string
  value: string
  warn?: boolean
  onClick?: () => void
  active?: boolean
}) {
  const clickable = Boolean(onClick)
  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick?.()
              }
            }
          : undefined
      }
      className={`rounded-lg border p-3 ${
        active
          ? 'border-blue-400 bg-blue-50'
          : warn
            ? 'border-orange-300 bg-orange-50'
            : 'border-gray-200 bg-white'
      } ${clickable ? 'cursor-pointer hover:border-blue-300' : ''}`}
    >
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`mt-1 text-lg font-semibold tabular-nums ${warn ? 'text-orange-800' : 'text-gray-900'}`}>
        {value}
      </p>
    </div>
  )
}

function initialTab(sp: URLSearchParams | null): Tab {
  const t = sp?.get('tab')
  if (t === 'traffic' || t === 'async' || t === 'diagnose' || t === 'alerts' || t === 'overview') {
    return t
  }
  return 'overview'
}

export default function PlatformMonitorPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-gray-400">Loading…</div>}>
      <PlatformMonitorPageInner />
    </Suspense>
  )
}

function PlatformMonitorPageInner() {
  const tr = useTranslations('platformMonitor')
  const tp = useTranslations('platformMonitorPage')
  const tAlerts = useTranslations('monitorAlerts')
  const allMessages = useMessages() as Record<string, any>
  const alertLabel = (a: { code: string; message: string; params?: Record<string, unknown> }) =>
    a.code && allMessages?.monitorAlerts?.[a.code] ? tAlerts(a.code, (a.params ?? {}) as any) : a.message
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const [tab, setTab] = useState<Tab>(() => initialTab(searchParams))
  type ExpandKey = 'stuck_running' | 'expiring_api_keys' | null
  const [expanded, setExpanded] = useState<ExpandKey>(null)

  function selectTab(next: Tab) {
    setTab(next)
    const params = new URLSearchParams(searchParams.toString())
    if (next === 'overview') params.delete('tab')
    else params.set('tab', next)
    const q = params.toString()
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false })
  }

  function toggleExpand(key: ExpandKey) {
    setExpanded((cur) => (cur === key ? null : key))
  }
  const [overview, setOverview] = useState<Overview | null>(null)
  const [appSlowQueries, setAppSlowQueries] = useState<AppSlowQuery[]>([])
  const [circuitBreakers, setCircuitBreakers] = useState<CircuitBreakerInfo[]>([])
  const [tsPoints, setTsPoints] = useState<TsPoint[]>([])
  const [tsRange, setTsRange] = useState<'24h' | '7d'>('24h')
  const [alertConfig, setAlertConfig] = useState<AlertConfig | null>(null)
  const [alertRules, setAlertRules] = useState<AlertRule[]>([])
  const [alertEvents, setAlertEvents] = useState<AlertEvent[]>([])
  const [topEndpoints, setTopEndpoints] = useState<TopEndpoint[]>([])
  const [topOrder, setTopOrder] = useState<'errors' | 'latency' | 'calls'>('errors')
  const [failedExecutions, setFailedExecutions] = useState<FailedExecution[]>([])
  const [http5xx, setHttp5xx] = useState<Http5xx[]>([])
  const [tenantRows, setTenantRows] = useState<TenantRow[]>([])
  const [loading, setLoading] = useState(true)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [thresholdMs, setThresholdMs] = useState(500)
  const [limit, setLimit] = useState(50)
  const [webhookDraft, setWebhookDraft] = useState('')
  const [throttleDraft, setThrottleDraft] = useState(1)
  const [enabledDraft, setEnabledDraft] = useState(false)
  const [savingAlert, setSavingAlert] = useState(false)

  const loadCore = useCallback(async () => {
    try {
      const [ov, slow, cb] = await Promise.allSettled([
        api.get('/api/admin/platform-monitor/overview'),
        api.get('/api/admin/slow-queries', { params: { limit, min_duration_ms: thresholdMs } }),
        api.get('/api/admin/circuit-breakers'),
      ])
      if (ov.status === 'fulfilled') setOverview(ov.value.data)
      if (slow.status === 'fulfilled') setAppSlowQueries(slow.value.data?.data || [])
      if (cb.status === 'fulfilled') setCircuitBreakers(cb.value.data?.data || [])
    } catch (err) {
      console.error(tr('loadFailed'), err)
    } finally {
      setLoading(false)
    }
  }, [limit, thresholdMs])

  const loadTimeseries = useCallback(async () => {
    try {
      const res = await api.get('/api/admin/platform-monitor/timeseries', {
        params: { range: tsRange },
      })
      setTsPoints(res.data?.points || [])
    } catch {
      setTsPoints([])
    }
  }, [tsRange])

  const loadTopEndpoints = useCallback(async () => {
    try {
      const res = await api.get('/api/admin/platform-monitor/top-endpoints', {
        params: { window: '1h', order: topOrder },
      })
      setTopEndpoints(res.data?.data || [])
    } catch {
      setTopEndpoints([])
    }
  }, [topOrder])

  const loadDiagnose = useCallback(async () => {
    try {
      const [errs, tenants] = await Promise.allSettled([
        api.get('/api/admin/platform-monitor/recent-errors', { params: { limit: 50 } }),
        api.get('/api/admin/platform-monitor/tenant-breakdown', { params: { range: '24h' } }),
      ])
      if (errs.status === 'fulfilled') {
        setFailedExecutions(errs.value.data?.failed_executions || [])
        setHttp5xx(errs.value.data?.http_5xx || [])
      }
      if (tenants.status === 'fulfilled') setTenantRows(tenants.value.data?.data || [])
    } catch (err) {
      console.error(tr('loadDiagFailed'), err)
    }
  }, [])

  const loadAlerts = useCallback(async () => {
    try {
      const [cfg, rules, events] = await Promise.allSettled([
        api.get('/api/admin/platform-monitor/alert-config'),
        api.get('/api/admin/platform-monitor/alert-rules'),
        api.get('/api/admin/platform-monitor/alert-events', { params: { limit: 50 } }),
      ])
      if (cfg.status === 'fulfilled') {
        const c = cfg.value.data as AlertConfig
        setAlertConfig(c)
        setWebhookDraft(c.webhook_url || '')
        setThrottleDraft(c.default_throttle_hours ?? 1)
        setEnabledDraft(!!c.enabled)
      }
      if (rules.status === 'fulfilled') setAlertRules(rules.value.data?.data || [])
      if (events.status === 'fulfilled') setAlertEvents(events.value.data?.data || [])
    } catch (err) {
      console.error(tr('loadAlertFailed'), err)
    }
  }, [])

  useEffect(() => {
    loadCore()
  }, [loadCore])

  useEffect(() => {
    if (tab === 'traffic' || tab === 'overview') loadTimeseries()
    if (tab === 'traffic') loadTopEndpoints()
    if (tab === 'diagnose') loadDiagnose()
    if (tab === 'alerts') loadAlerts()
  }, [tab, loadTimeseries, loadTopEndpoints, loadDiagnose, loadAlerts])

  useEffect(() => {
    if (!autoRefresh) return
    const timer = setInterval(() => {
      loadCore()
      if (tab === 'traffic' || tab === 'overview') loadTimeseries()
      if (tab === 'traffic') loadTopEndpoints()
      if (tab === 'diagnose') loadDiagnose()
      if (tab === 'alerts') loadAlerts()
    }, 5000)
    return () => clearInterval(timer)
  }, [autoRefresh, loadCore, loadTimeseries, loadTopEndpoints, loadDiagnose, loadAlerts, tab])

  const saveAlertConfig = async () => {
    setSavingAlert(true)
    try {
      const res = await api.put('/api/admin/platform-monitor/alert-config', {
        enabled: enabledDraft,
        webhook_url: webhookDraft.trim() ? webhookDraft.trim() : null,
        default_throttle_hours: throttleDraft,
      })
      setAlertConfig(res.data)
    } catch (err) {
      console.error(err)
      alert(tr('saveAlertFailed'))
    } finally {
      setSavingAlert(false)
    }
  }

  const toggleRule = async (rule: AlertRule) => {
    try {
      await api.patch(`/api/admin/platform-monitor/alert-rules/${rule.id}`, {
        enabled: !rule.enabled,
      })
      await loadAlerts()
    } catch (err) {
      console.error(err)
    }
  }

  const tabs: { id: Tab; key: string }[] = [
    { id: 'overview', key: 'tabOverview' },
    { id: 'traffic', key: 'tabTraffic' },
    { id: 'async', key: 'tabAsync' },
    { id: 'diagnose', key: 'tabDiagnose' },
    { id: 'alerts', key: 'tabAlerts' },
  ]

  const hourlyCounts = overview?.traffic.hourly_24h?.map((h) => h.count) || []
  const hourlyErrs = overview?.traffic.hourly_24h?.map((h) => h.err_5xx) || []

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            <i className="fas fa-chart-line mr-2 text-blue-500"></i>
            {tr('title')}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {tr('subtitle')}
          </p>
        </div>
        <label className="flex items-center space-x-2 text-sm text-gray-700 whitespace-nowrap">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            className="rounded border-gray-300"
          />
          <span>{tr('autoRefresh')}</span>
        </label>
      </div>

      <div className="flex gap-1 border-b border-gray-200">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => selectTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.id
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tr(t.key)}
          </button>
        ))}
      </div>

      {loading && !overview ? (
        <div className="text-center py-12 text-gray-400 text-sm">
          <i className="fas fa-spinner fa-spin"></i>
        </div>
      ) : null}

      {tab === 'overview' && overview && (() => {
        const anomalies = overview.anomalies ?? []
        const signals = overview.signals ?? EMPTY_SIGNALS
        const samples = overview.signal_samples ?? EMPTY_SIGNAL_SAMPLES

        function onAnomalyClick(code: string) {
          if (code === 'stuck_running') toggleExpand('stuck_running')
          else if (code === 'api_key_expiring') toggleExpand('expiring_api_keys')
          else if (code === 'exec_failed') selectTab('diagnose')
        }

        return (
        <div className="space-y-4">
          {anomalies.length > 0 ? (
            <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
              <p className="text-sm font-semibold text-gray-800 mb-2">
                {tr('currentSignals', { n: anomalies.length })}
              </p>
              <ul className="text-sm space-y-1">
                {anomalies.map((a) => {
                  const clickable =
                    a.code === 'stuck_running' ||
                    a.code === 'api_key_expiring' ||
                    a.code === 'exec_failed'
                  return (
                    <li key={a.code} className="flex items-center gap-2">
                      <span
                        className={`inline-block w-1.5 h-1.5 rounded-full ${
                          a.level === 'critical'
                            ? 'bg-red-500'
                            : a.level === 'warning'
                              ? 'bg-orange-500'
                              : 'bg-blue-400'
                        }`}
                      />
                      <button
                        type="button"
                        className={`text-left ${
                          clickable ? 'underline-offset-2 hover:underline cursor-pointer' : ''
                        } ${
                          a.level === 'critical'
                            ? 'text-red-700'
                            : a.level === 'warning'
                              ? 'text-orange-700'
                              : 'text-gray-600'
                        }`}
                        onClick={() => onAnomalyClick(a.code)}
                        disabled={!clickable}
                      >
                        {alertLabel(a)}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : (
            <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
              {tr('noAnomaly')}
            </div>
          )}

          <div className="flex flex-wrap gap-2 text-xs">
            <span className={`px-2.5 py-1 rounded-full font-medium ${healthBadge(overview.health.mgmt_db)}`}>
              {tr('mgmtDb', { v: overview.health.mgmt_db })}
            </span>
            <span className={`px-2.5 py-1 rounded-full font-medium ${healthBadge(overview.health.redis)}`}>
              Redis: {overview.health.redis}
            </span>
            <span className="px-2.5 py-1 rounded-full font-medium bg-gray-100 text-gray-700">
              v{overview.health.version}
            </span>
            <span className="px-2.5 py-1 rounded-full font-medium bg-gray-100 text-gray-700">
              {tr('mgmtPool', { idle: overview.health.mgmt_pool.idle, size: overview.health.mgmt_pool.size })}
            </span>
            <span className="px-2.5 py-1 rounded-full font-medium bg-gray-100 text-gray-700">
              {tr('tenantPool', { n: overview.health.active_pools })}
            </span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <Kpi label="QPS (5m)" value={fmtNum(overview.traffic.qps_5min, 2)} />
            <Kpi label="P95 (5m)" value={overview.traffic.p95_ms_5min != null ? `${fmtNum(overview.traffic.p95_ms_5min, 0)}ms` : '—'} />
            <Kpi
              label={tr('errRate24h')}
              value={fmtPct(overview.traffic.error_rate_24h)}
              warn={(overview.traffic.error_rate_24h ?? 0) > 0.05}
            />
            <Kpi label={tr('slow24h')} value={fmtNum(overview.traffic.slow_queries_24h, 0)} warn={(overview.traffic.slow_queries_5min ?? 0) > 20} />
            <Kpi label={tr('circuitOpen')} value={String(overview.runtime.circuit_open_count)} warn={overview.runtime.circuit_open_count > 0} />
            <Kpi label={tr('rateLimitDegraded')} value={overview.runtime.rate_limit_degraded ? tr('yes') : tr('no')} warn={overview.runtime.rate_limit_degraded} />
          </div>

          <div>
            <p className="text-xs font-medium text-gray-400 uppercase mb-2">{tr('hazardSignals')}</p>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
              <Kpi label={tr('rateLimited1h')} value={String(signals.rate_limited_429_1h)} warn={signals.rate_limited_429_1h >= 20} />
              <Kpi label={tr('authFail1h')} value={String(signals.auth_failures_1h)} warn={signals.auth_failures_1h >= 20} />
              <Kpi
                label={tr('stuckExec')}
                value={String(signals.stuck_running)}
                warn={signals.stuck_running > 0}
                active={expanded === 'stuck_running'}
                onClick={signals.stuck_running > 0 ? () => toggleExpand('stuck_running') : undefined}
              />
              <Kpi label={tr('stuckWorkflow')} value={String(signals.stuck_workflow)} warn={signals.stuck_workflow > 0} />
              <Kpi
                label={tr('keyExpiring')}
                value={String(signals.expiring_api_keys_7d)}
                warn={signals.expiring_api_keys_7d > 0}
                active={expanded === 'expiring_api_keys'}
                onClick={
                  signals.expiring_api_keys_7d > 0 ? () => toggleExpand('expiring_api_keys') : undefined
                }
              />
              <Kpi label={tr('tokenExpiring')} value={String(signals.expiring_tokens_7d)} warn={signals.expiring_tokens_7d > 0} />
              <Kpi label={tr('webhookFail24h')} value={String(signals.webhook_failures_24h)} warn={signals.webhook_failures_24h > 0} />
            </div>
          </div>

          {expanded === 'stuck_running' && (
            <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100 flex justify-between items-center">
                <h3 className="text-sm font-semibold text-gray-700">{tr('stuckExecDetail')}</h3>
                <button type="button" className="text-xs text-gray-500" onClick={() => setExpanded(null)}>
                  {tp('collapse')}
                </button>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colOrg')}</th>
                    <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colProject')}</th>
                    <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colSource')}</th>
                    <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colName')}</th>
                    <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colStart')}</th>
                    <th className="px-4 py-2 text-right text-xs text-gray-500">{tr('colRan')}</th>
                    <th className="px-4 py-2 text-left text-xs text-gray-500">trace</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {samples.stuck_running.items.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-6 text-center text-xs text-gray-400">
                        {tr('noSample')}
                      </td>
                    </tr>
                  ) : (
                    samples.stuck_running.items.map((row) => (
                      <tr key={row.trace_id + row.started_at} className="hover:bg-gray-50">
                        <td className="px-4 py-2 text-xs">{row.organization_name || '—'}</td>
                        <td className="px-4 py-2 text-xs">{row.project_name || row.tenant_id || '—'}</td>
                        <td className="px-4 py-2 text-xs">{row.source}</td>
                        <td className="px-4 py-2 text-xs max-w-[12rem] truncate" title={row.name || ''}>
                          {row.name || '—'}
                        </td>
                        <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">
                          {new Date(row.started_at).toLocaleString('zh-CN')}
                        </td>
                        <td className="px-4 py-2 text-xs text-right tabular-nums">
                          {row.running_for_seconds != null
                            ? `${Math.floor(row.running_for_seconds / 60)}m`
                            : '—'}
                        </td>
                        <td className="px-4 py-2 text-xs font-mono">
                          <button
                            type="button"
                            className="text-blue-600 hover:underline"
                            title={tr('copyTrace')}
                            onClick={() => navigator.clipboard.writeText(row.trace_id)}
                          >
                            {row.trace_id.slice(0, 8)}…
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
              {samples.stuck_running.total > samples.stuck_running.items.length && (
                <p className="px-4 py-2 text-xs text-gray-500 border-t border-gray-100">
                  {tr('countShown', { total: samples.stuck_running.total, shown: samples.stuck_running.items.length })}
                </p>
              )}
            </div>
          )}

          {expanded === 'expiring_api_keys' && (
            <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100 flex justify-between items-center">
                <h3 className="text-sm font-semibold text-gray-700">{tr('expiringApiKey')}</h3>
                <button type="button" className="text-xs text-gray-500" onClick={() => setExpanded(null)}>
                  {tp('collapse')}
                </button>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colOrg')}</th>
                    <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colProject')}</th>
                    <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colName')}</th>
                    <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colPrefix')}</th>
                    <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colExpire')}</th>
                    <th className="px-4 py-2 text-right text-xs text-gray-500">{tr('colDaysLeft')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {samples.expiring_api_keys.items.map((row) => (
                    <tr key={row.id} className="hover:bg-gray-50">
                      <td className="px-4 py-2 text-xs">{row.organization_name || '—'}</td>
                      <td className="px-4 py-2 text-xs">{row.project_name || row.tenant_id}</td>
                      <td className="px-4 py-2 text-xs">{row.name}</td>
                      <td className="px-4 py-2 text-xs font-mono">{row.key_prefix}</td>
                      <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">
                        {new Date(row.expires_at).toLocaleString('zh-CN')}
                      </td>
                      <td className="px-4 py-2 text-xs text-right tabular-nums">
                        {row.days_left ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {samples.expiring_api_keys.total > samples.expiring_api_keys.items.length && (
                <p className="px-4 py-2 text-xs text-gray-500 border-t border-gray-100">
                  {tr('countShown', { total: samples.expiring_api_keys.total, shown: samples.expiring_api_keys.items.length })}
                </p>
              )}
            </div>
          )}

          <div className="card p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">{tr('calls24h')}</h3>
            {hourlyCounts.some((v) => v > 0) ? (
              <Sparkline data={hourlyCounts} />
            ) : (
              <p className="text-xs text-gray-400 py-4">{tr('noAuditData')}</p>
            )}
            {hourlyErrs.some((v) => v > 0) && (
              <>
                <h3 className="text-sm font-semibold text-gray-700 mt-4 mb-2">{tr('fivexx24h')}</h3>
                <Sparkline data={hourlyErrs} />
              </>
            )}
          </div>

          {(overview.warnings?.length ?? 0) > 0 && (
            <p className="text-xs text-gray-400">{tr('degradedMetrics', { w: overview.warnings!.join('; ') })}</p>
          )}
        </div>
        )
      })()}

      {tab === 'traffic' && (
        <div className="space-y-6">
          <div className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-700">{tr('sampleTrend')}</h3>
              <select
                value={tsRange}
                onChange={(e) => setTsRange(e.target.value as '24h' | '7d')}
                className="px-2 py-1 border border-gray-300 rounded text-xs"
              >
                <option value="24h">24h</option>
                <option value="7d">7d</option>
              </select>
            </div>
            {tsPoints.length === 0 ? (
              <p className="text-xs text-gray-400 py-4">
                {tr('noSamplePoint')}
              </p>
            ) : (
              <div className="space-y-4">
                <div>
                  <p className="text-xs text-gray-500 mb-1">QPS</p>
                  <Sparkline data={tsPoints.map((p) => p.qps_5min ?? 0)} height={40} />
                </div>
                <div>
                  <p className="text-xs text-gray-500 mb-1">P95 (ms)</p>
                  <Sparkline data={tsPoints.map((p) => p.p95_ms_5min ?? 0)} height={40} />
                </div>
                <div>
                  <p className="text-xs text-gray-500 mb-1">{tr('errRate')}</p>
                  <Sparkline data={tsPoints.map((p) => (p.error_rate_24h ?? 0) * 100)} height={40} />
                </div>
              </div>
            )}
          </div>

          <div className="card p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">
              <i className="fas fa-shield-alt mr-2 text-orange-500"></i>
              {tr('circuitState')}
            </h3>
            {circuitBreakers.length === 0 ? (
              <div className="text-sm text-gray-400">{tr('noCircuit')}</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {circuitBreakers.map((cb) => (
                  <span
                    key={cb.database_id}
                    className={`px-3 py-1 rounded-full text-xs font-medium ${
                      cb.state === 'Closed'
                        ? 'bg-green-100 text-green-800'
                        : cb.state === 'Open'
                          ? 'bg-red-100 text-red-800'
                          : 'bg-yellow-100 text-yellow-800'
                    }`}
                  >
                    DB#{cb.database_id}:{' '}
                    {cb.state === 'Closed' ? tr('cbClosed') : cb.state === 'Open' ? tr('cbOpen') : tr('cbHalfOpen')}
                  </span>
                ))}
              </div>
            )}
          </div>

          {overview?.runtime.rate_limit && (
            <div className="card p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">{tr('rateLimiter')}</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <Kpi
                  label={tr('degraded')}
                  value={overview.runtime.rate_limit_degraded ? tr('yes') : tr('no')}
                  warn={overview.runtime.rate_limit_degraded}
                />
                <Kpi
                  label={tr('redisFailStreak')}
                  value={String((overview.runtime.rate_limit as { redis_failures_streak?: number }).redis_failures_streak ?? '—')}
                />
                <Kpi
                  label={tr('fallbackReject')}
                  value={String((overview.runtime.rate_limit as { fallback_rejected_total?: number }).fallback_rejected_total ?? '—')}
                />
                <Kpi
                  label={tr('activeRules')}
                  value={String((overview.runtime.rate_limit as { active_rules?: number }).active_rules ?? '—')}
                />
              </div>
            </div>
          )}

          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-700">
                <i className="fas fa-fire mr-2 text-red-500"></i>
                {tr('topEndpoints')}
              </h3>
              <select
                value={topOrder}
                onChange={(e) => setTopOrder(e.target.value as 'errors' | 'latency' | 'calls')}
                className="px-2 py-1 border border-gray-300 rounded text-xs"
              >
                <option value="errors">{tr('sortErrors')}</option>
                <option value="latency">{tr('sortLatency')}</option>
                <option value="calls">{tr('sortCalls')}</option>
              </select>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colPath')}</th>
                  <th className="px-4 py-2 text-right text-xs text-gray-500">{tr('colCalls')}</th>
                  <th className="px-4 py-2 text-right text-xs text-gray-500">5xx</th>
                  <th className="px-4 py-2 text-right text-xs text-gray-500">4xx</th>
                  <th className="px-4 py-2 text-right text-xs text-gray-500">P95</th>
                  <th className="px-4 py-2 text-right text-xs text-gray-500">{tr('colAvg')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {topEndpoints.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-xs text-gray-400">
                      {tr('noData')}
                    </td>
                  </tr>
                ) : (
                  topEndpoints.map((e) => (
                    <tr key={e.request_path} className="hover:bg-gray-50">
                      <td className="px-4 py-2 text-xs font-mono text-gray-700 max-w-md truncate" title={e.request_path}>
                        {e.request_path}
                      </td>
                      <td className="px-4 py-2 text-xs text-right tabular-nums">{e.calls}</td>
                      <td className={`px-4 py-2 text-xs text-right tabular-nums ${e.err_5xx > 0 ? 'text-red-600 font-semibold' : ''}`}>
                        {e.err_5xx}
                      </td>
                      <td className={`px-4 py-2 text-xs text-right tabular-nums ${e.err_4xx > 0 ? 'text-yellow-700' : ''}`}>
                        {e.err_4xx}
                      </td>
                      <td className="px-4 py-2 text-xs text-right tabular-nums">
                        {e.p95 != null ? `${e.p95.toFixed(0)}ms` : '—'}
                      </td>
                      <td className="px-4 py-2 text-xs text-right tabular-nums text-gray-500">
                        {e.avg_ms != null ? `${e.avg_ms.toFixed(0)}ms` : '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div>
            <div className="flex items-end justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-700">
                <i className="fas fa-code mr-2 text-purple-500"></i>
                {tr('autoApiSlow')}
              </h3>
              <div className="flex items-center space-x-3 text-xs text-gray-600">
                <label className="flex items-center space-x-1.5">
                  <span>{tr('threshold')}</span>
                  <input
                    type="number"
                    min={0}
                    value={thresholdMs}
                    onChange={(e) => setThresholdMs(parseInt(e.target.value || '0', 10))}
                    className="w-20 px-2 py-1 border border-gray-300 rounded text-xs"
                  />
                  <span>ms</span>
                </label>
                <label className="flex items-center space-x-1.5">
                  <span>{tr('rowCount')}</span>
                  <select
                    value={limit}
                    onChange={(e) => setLimit(parseInt(e.target.value, 10))}
                    className="px-2 py-1 border border-gray-300 rounded text-xs"
                  >
                    <option value={20}>20</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                    <option value={200}>200</option>
                  </select>
                </label>
              </div>
            </div>
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{tr('colTime')}</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">DB</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Schema.Table</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">SQL</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{tr('colElapsed')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {appSlowQueries.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="text-center py-6 text-gray-400 text-xs">
                        {tr('noSlowQuery')}
                      </td>
                    </tr>
                  ) : (
                    appSlowQueries.map((q) => (
                      <tr key={q.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                          {new Date(q.created_at).toLocaleString('zh-CN')}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-600">{q.database_id ?? '—'}</td>
                        <td className="px-4 py-3 text-xs font-mono text-gray-700">
                          {q.schema_name}.{q.table_name}
                        </td>
                        <td
                          className="px-4 py-3 text-xs font-mono text-gray-600 max-w-md truncate"
                          title={q.sql_preview || ''}
                        >
                          {q.sql_preview}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`px-2 py-0.5 rounded text-xs font-medium ${
                              q.duration_ms > 1000
                                ? 'bg-red-100 text-red-800'
                                : 'bg-yellow-100 text-yellow-800'
                            }`}
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
          </div>
        </div>
      )}

      {tab === 'async' && overview && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Kpi label={tr('execFailed24h')} value={String(overview.async.exec_failed_24h)} warn={overview.async.exec_failed_24h > 50} />
            <Kpi label={tr('schedulerActive')} value={String(overview.async.scheduler?.active_tasks ?? '—')} />
            <Kpi label={tr('schedulerFailed24h')} value={String(overview.async.scheduler?.failed_24h ?? '—')} warn={(overview.async.scheduler?.failed_24h ?? 0) > 0} />
            <Kpi label={tr('sseConn')} value={String(overview.async.sse?.connections.total ?? '—')} />
          </div>

          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-700">{tr('execIndex24h')}</h3>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs text-gray-500">Source</th>
                  <th className="px-4 py-2 text-left text-xs text-gray-500">Status</th>
                  <th className="px-4 py-2 text-left text-xs text-gray-500">Count</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {overview.async.execution_stats.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-xs text-gray-400">
                      {tr('noExecRecord')}
                    </td>
                  </tr>
                ) : (
                  overview.async.execution_stats.map((row) => (
                    <tr key={`${row.source}-${row.status}`}>
                      <td className="px-4 py-2 text-xs">{row.source}</td>
                      <td className="px-4 py-2 text-xs">{row.status}</td>
                      <td className="px-4 py-2 text-xs tabular-nums">{row.count}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {overview.async.sse && (
            <div className="card p-4 text-sm text-gray-600 space-y-1">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">SSE</h3>
              <p>{tr('sseTotal', { total: overview.async.sse.connections.total, pub: overview.async.sse.connections.public, gen: overview.async.sse.connections.generic })}</p>
              <p>{tr('ssePushes', { n: overview.async.sse.pushes_total })}</p>
            </div>
          )}
        </div>
      )}

      {tab === 'diagnose' && (
        <div className="space-y-6">
          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-700">
                <i className="fas fa-triangle-exclamation mr-2 text-red-500"></i>
                {tr('recentFailedExec')}
              </h3>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colTime')}</th>
                  <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colSource')}</th>
                  <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colName')}</th>
                  <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colStatus')}</th>
                  <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colError')}</th>
                  <th className="px-4 py-2 text-left text-xs text-gray-500">trace</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {failedExecutions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-xs text-gray-400">
                      {tr('noRecentFail')}
                    </td>
                  </tr>
                ) : (
                  failedExecutions.map((e) => (
                    <tr key={e.trace_id + e.started_at} className="hover:bg-gray-50">
                      <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">
                        {new Date(e.started_at).toLocaleString('zh-CN')}
                      </td>
                      <td className="px-4 py-2 text-xs">{e.source}</td>
                      <td className="px-4 py-2 text-xs max-w-[12rem] truncate" title={e.name || ''}>
                        {e.name || '—'}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        <span className="px-2 py-0.5 rounded bg-red-100 text-red-800">{e.status}</span>
                      </td>
                      <td className="px-4 py-2 text-xs text-red-700 max-w-xs truncate" title={e.error_brief || ''}>
                        {e.error_brief || '—'}
                      </td>
                      <td className="px-4 py-2 text-xs font-mono text-gray-400 max-w-[8rem] truncate" title={e.trace_id}>
                        {e.trace_id}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-700">{tr('recent5xx')}</h3>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colTime')}</th>
                  <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colMethod')}</th>
                  <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colPath')}</th>
                  <th className="px-4 py-2 text-right text-xs text-gray-500">{tr('colStatus')}</th>
                  <th className="px-4 py-2 text-right text-xs text-gray-500">{tr('colElapsed')}</th>
                  <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colProject')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {http5xx.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-xs text-gray-400">
                      {tr('noRecent5xx')}
                    </td>
                  </tr>
                ) : (
                  http5xx.map((e, i) => (
                    <tr key={`${e.created_at}-${i}`} className="hover:bg-gray-50">
                      <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">
                        {new Date(e.created_at).toLocaleString('zh-CN')}
                      </td>
                      <td className="px-4 py-2 text-xs font-mono">{e.request_method}</td>
                      <td className="px-4 py-2 text-xs font-mono max-w-md truncate" title={e.request_path}>
                        {e.request_path}
                      </td>
                      <td className="px-4 py-2 text-xs text-right text-red-600 font-semibold">
                        {e.response_status}
                      </td>
                      <td className="px-4 py-2 text-xs text-right tabular-nums">
                        {e.duration_ms != null ? `${e.duration_ms}ms` : '—'}
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-500">{e.tenant_id ?? '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-700">{tr('byProject24h')}</h3>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colProject')}</th>
                  <th className="px-4 py-2 text-right text-xs text-gray-500">{tr('colCalls')}</th>
                  <th className="px-4 py-2 text-right text-xs text-gray-500">5xx</th>
                  <th className="px-4 py-2 text-right text-xs text-gray-500">{tr('colErrRate')}</th>
                  <th className="px-4 py-2 text-right text-xs text-gray-500">P95</th>
                  <th className="px-4 py-2 text-right text-xs text-gray-500">{tr('colSlow')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {tenantRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-xs text-gray-400">
                      {tr('noData')}
                    </td>
                  </tr>
                ) : (
                  tenantRows.map((r) => {
                    const rate = r.calls > 0 ? r.err_5xx / r.calls : 0
                    return (
                      <tr key={String(r.tenant_id)} className="hover:bg-gray-50">
                        <td className="px-4 py-2 text-xs">
                          {r.tenant_name || (r.tenant_id != null ? `#${r.tenant_id}` : tr('noProject'))}
                        </td>
                        <td className="px-4 py-2 text-xs text-right tabular-nums">{r.calls}</td>
                        <td className={`px-4 py-2 text-xs text-right tabular-nums ${r.err_5xx > 0 ? 'text-red-600 font-semibold' : ''}`}>
                          {r.err_5xx}
                        </td>
                        <td className={`px-4 py-2 text-xs text-right tabular-nums ${rate > 0.05 ? 'text-red-600 font-semibold' : ''}`}>
                          {fmtPct(rate)}
                        </td>
                        <td className="px-4 py-2 text-xs text-right tabular-nums">
                          {r.p95 != null ? `${r.p95.toFixed(0)}ms` : '—'}
                        </td>
                        <td className={`px-4 py-2 text-xs text-right tabular-nums ${r.slow_queries > 0 ? 'text-yellow-700' : ''}`}>
                          {r.slow_queries}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'alerts' && (
        <div className="space-y-6">
          <div className="card p-4 space-y-3">
            <h3 className="text-sm font-semibold text-gray-700">{tr('alertWebhook')}</h3>
            <p className="text-xs text-gray-500">
              {tr('alertWebhookHint')}
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={enabledDraft}
                onChange={(e) => setEnabledDraft(e.target.checked)}
                className="rounded border-gray-300"
              />
              {tr('enableAlert')}
            </label>
            <label className="block text-xs text-gray-600">
              Webhook URL
              <input
                type="url"
                value={webhookDraft}
                onChange={(e) => setWebhookDraft(e.target.value)}
                placeholder="https://..."
                className="mt-1 w-full px-3 py-2 border border-gray-300 rounded text-sm"
              />
            </label>
            <label className="block text-xs text-gray-600 w-40">
              {tr('defaultRateLimit')}
              <input
                type="number"
                min={0}
                max={720}
                value={throttleDraft}
                onChange={(e) => setThrottleDraft(parseInt(e.target.value || '0', 10))}
                className="mt-1 w-full px-3 py-2 border border-gray-300 rounded text-sm"
              />
            </label>
            <button
              type="button"
              onClick={saveAlertConfig}
              disabled={savingAlert}
              className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {savingAlert ? tr('savingAlert') : tr('saveConfig')}
            </button>
            {alertConfig?.updated_at && (
              <p className="text-xs text-gray-400">{tr('lastUpdated', { t: alertConfig.updated_at })}</p>
            )}
          </div>

          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-700">{tr('alertRules')}</h3>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colName')}</th>
                  <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colCondition')}</th>
                  <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colEnabled')}</th>
                  <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colLastTrigger')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {alertRules.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-xs text-gray-400">
                      {tr('noRule')}
                    </td>
                  </tr>
                ) : (
                  alertRules.map((r) => (
                    <tr key={r.id}>
                      <td className="px-4 py-2 text-xs">{r.name}</td>
                      <td className="px-4 py-2 text-xs font-mono">
                        {r.metric} {r.operator} {r.threshold}
                      </td>
                      <td className="px-4 py-2">
                        <button
                          type="button"
                          onClick={() => toggleRule(r)}
                          className={`text-xs px-2 py-0.5 rounded ${
                            r.enabled ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-500'
                          }`}
                        >
                          {r.enabled ? tr('on') : tr('off')}
                        </button>
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-500">
                        {r.last_fired_at ? new Date(r.last_fired_at).toLocaleString('zh-CN') : '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-700">{tr('recentAlertEvents')}</h3>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colTime')}</th>
                  <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colRule')}</th>
                  <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colValue')}</th>
                  <th className="px-4 py-2 text-left text-xs text-gray-500">{tr('colStatus')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {alertEvents.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-xs text-gray-400">
                      {tr('noEvent')}
                    </td>
                  </tr>
                ) : (
                  alertEvents.map((e) => (
                    <tr key={e.id}>
                      <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">
                        {new Date(e.created_at).toLocaleString('zh-CN')}
                      </td>
                      <td className="px-4 py-2 text-xs">{e.rule_name}</td>
                      <td className="px-4 py-2 text-xs font-mono">
                        {e.value} / {e.threshold}
                      </td>
                      <td className="px-4 py-2 text-xs" title={e.error || ''}>
                        {e.status}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
