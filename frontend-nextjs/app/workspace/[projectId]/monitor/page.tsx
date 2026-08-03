'use client'

/**
 * `/workspace/[projectId]/monitor` — 项目维度的数据库 / 连接池监控。
 *
 * 首屏优先展示 OneBase 应用侧连接池健康（上次雪崩时缺的那一层），
 * PG 服务端指标下沉；时序靠前端轮询本地攒点（不落库）。
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import api from '@/lib/api'

interface DbStats {
  database_size: string
  table_count: number
  connection_count: number
  max_connections: number
  active_connections: number
  idle_connections: number
  cache_hit_ratio: number
  transaction_count: number
  uptime_seconds: number
}

interface TableSize {
  schema_name: string
  table_name: string
  row_count: number
  total_size: string
  table_size: string
  index_size: string
}

interface PgSlowQuery {
  query: string
  calls: number
  total_time: number
  mean_time: number
  max_time: number
}

interface ActiveConn {
  pid: number
  user: string
  database: string
  client_addr: string | null
  state: string
  query: string
  duration_seconds: number | null
  application_name: string
  backend_start: string | null
  xact_duration_seconds: number | null
  is_listen: boolean
}

interface PoolWaterMark {
  max: number
  min: number
  size: number
  idle: number
  in_use: number
  acquire_timeout_secs: number
}

interface ReplicaPoolInfo {
  replica_id: number
  bypassed: boolean
  watermark: PoolWaterMark
}

interface PoolHealth {
  app_pool: {
    database_id: number
    max: number
    min: number
    size: number
    idle: number
    in_use: number
    usage_percent: number
    acquire_timeout_secs: number
    db_configured_max: number | null
    env_override: number | null
    loaded: boolean
    replicas: ReplicaPoolInfo[]
  }
  listeners: {
    sse_bridges: number
    notify_workflows: number
    dedicated_connections: number
  }
  acquire_failures: {
    total: number
    for_this_database: number
    last_at: string | null
    recent: { at: string; database_id: number | null; source: string }[]
  }
  pg: {
    max_connections: number
    instance_backends: number
    database_backends: number
    active: number
    idle: number
    idle_in_transaction: number
    idle_in_transaction_aborted: number
    listen_sessions: number
    waiting_on_locks: number
    longest_active_seconds: number | null
    longest_idle_in_transaction_seconds: number | null
  }
  verdict: {
    level: 'ok' | 'warn' | 'critical'
    summary: string
    hints: string[]
  }
}

interface SamplePoint {
  t: number
  appUsage: number
  pgBackends: number
}

const MAX_SAMPLES = 60

type Tab = 'diagnose' | 'app_pool' | 'connections' | 'slow' | 'tables'

export default function MonitorPage() {
  const [health, setHealth] = useState<PoolHealth | null>(null)
  const [stats, setStats] = useState<DbStats | null>(null)
  const [tables, setTables] = useState<TableSize[]>([])
  const [pgSlowQueries, setPgSlowQueries] = useState<PgSlowQuery[]>([])
  const [connections, setConnections] = useState<ActiveConn[]>([])
  const [loading, setLoading] = useState(true)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [tab, setTab] = useState<Tab>('diagnose')
  const [samples, setSamples] = useState<SamplePoint[]>([])
  const samplesRef = useRef<SamplePoint[]>([])

  const pushSample = useCallback((h: PoolHealth) => {
    const next: SamplePoint = {
      t: Date.now(),
      appUsage: h.app_pool.usage_percent,
      pgBackends: h.pg.instance_backends,
    }
    const merged = [...samplesRef.current, next].slice(-MAX_SAMPLES)
    samplesRef.current = merged
    setSamples(merged)
  }, [])

  const loadAll = useCallback(async () => {
    try {
      const [healthRes, statsRes, tablesRes, pgSlowRes, connRes] = await Promise.allSettled([
        api.get('/api/monitor/pool-health'),
        api.get('/api/monitor/stats'),
        api.get('/api/monitor/tables'),
        api.get('/api/monitor/slow-queries'),
        api.get('/api/monitor/connections', { params: { include_idle: true } }),
      ])

      if (healthRes.status === 'fulfilled') {
        const h = healthRes.value.data as PoolHealth
        setHealth(h)
        pushSample(h)
      }
      if (statsRes.status === 'fulfilled') setStats(statsRes.value.data)
      if (tablesRes.status === 'fulfilled') setTables(tablesRes.value.data || [])
      if (pgSlowRes.status === 'fulfilled') setPgSlowQueries(pgSlowRes.value.data || [])
      if (connRes.status === 'fulfilled') setConnections(connRes.value.data || [])
    } catch (err) {
      console.error('加载监控数据失败:', err)
    } finally {
      setLoading(false)
    }
  }, [pushSample])

  useEffect(() => { loadAll() }, [loadAll])

  useEffect(() => {
    if (!autoRefresh) return
    const timer = setInterval(loadAll, 5000)
    return () => clearInterval(timer)
  }, [autoRefresh, loadAll])

  const formatUptime = (s: number) => {
    const d = Math.floor(s / 86400)
    const h = Math.floor((s % 86400) / 3600)
    const m = Math.floor((s % 3600) / 60)
    if (d > 0) return `${d}天 ${h}小时`
    if (h > 0) return `${h}小时 ${m}分钟`
    return `${m}分钟`
  }

  const formatTime = (iso: string | null) => {
    if (!iso) return '-'
    try {
      return new Date(iso).toLocaleString()
    } catch {
      return iso
    }
  }

  const verdictStyle = (level: PoolHealth['verdict']['level']) => {
    if (level === 'critical') return 'bg-red-50 border-red-300 text-red-900'
    if (level === 'warn') return 'bg-amber-50 border-amber-300 text-amber-900'
    return 'bg-emerald-50 border-emerald-300 text-emerald-900'
  }

  const verdictIcon = (level: PoolHealth['verdict']['level']) => {
    if (level === 'critical') return 'fa-exclamation-circle text-red-600'
    if (level === 'warn') return 'fa-exclamation-triangle text-amber-600'
    return 'fa-check-circle text-emerald-600'
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">连接池与数据库监控</h1>
          <p className="text-sm text-gray-500 mt-1">
            优先诊断 OneBase 应用侧连接池；PG 服务端指标作对照
          </p>
        </div>
        <div className="flex items-center space-x-3">
          <label className="flex items-center space-x-2 cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="w-4 h-4 text-blue-600 rounded"
            />
            <span className="text-sm text-gray-600">每 5s 自动刷新</span>
          </label>
          <button onClick={loadAll} className="btn-default text-sm">
            <i className={`fas fa-sync-alt mr-1 ${loading ? 'fa-spin' : ''}`}></i>刷新
          </button>
        </div>
      </div>

      {/* Verdict 横幅 */}
      {health && (
        <div className={`border rounded-xl p-5 ${verdictStyle(health.verdict.level)}`}>
          <div className="flex items-start gap-3">
            <i className={`fas ${verdictIcon(health.verdict.level)} text-2xl mt-0.5`}></i>
            <div className="min-w-0 flex-1">
              <p className="text-base font-semibold leading-snug">{health.verdict.summary}</p>
              {health.verdict.hints.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm opacity-90">
                  {health.verdict.hints.map((h, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="opacity-60">•</span>
                      <span>{h}</span>
                    </li>
                  ))}
                </ul>
              )}
              {health.verdict.level !== 'ok' && !autoRefresh && (
                <p className="mt-3 text-xs opacity-75">
                  <i className="fas fa-lightbulb mr-1"></i>
                  建议开启「每 5s 自动刷新」观察趋势是否在恶化
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 水位四卡 */}
      {health && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <WaterCard
            label="应用连接池"
            value={
              health.app_pool.loaded
                ? `${health.app_pool.in_use} / ${health.app_pool.max}`
                : '未加载'
            }
            sub={
              health.app_pool.loaded
                ? `占用 ${health.app_pool.usage_percent}% · idle ${health.app_pool.idle}`
                : '尚无请求命中该库'
            }
            percent={health.app_pool.loaded ? health.app_pool.usage_percent : 0}
            tone={
              !health.app_pool.loaded
                ? 'gray'
                : health.app_pool.usage_percent >= 100
                  ? 'red'
                  : health.app_pool.usage_percent >= 80
                    ? 'yellow'
                    : 'green'
            }
          />
          <WaterCard
            label="LISTEN 独立连接"
            value={String(health.listeners.dedicated_connections)}
            sub={`SSE ${health.listeners.sse_bridges} · notify ${health.listeners.notify_workflows}`}
            tone={health.listeners.dedicated_connections >= 20 ? 'yellow' : 'blue'}
          />
          <WaterCard
            label="Acquire 超时（近似）"
            value={String(health.acquire_failures.for_this_database)}
            sub={
              health.acquire_failures.last_at
                ? `最近 ${formatTime(health.acquire_failures.last_at)}`
                : '进程启动以来无记录'
            }
            tone={health.acquire_failures.for_this_database > 0 ? 'red' : 'green'}
          />
          <WaterCard
            label="PG 实例连接"
            value={`${health.pg.instance_backends} / ${health.pg.max_connections}`}
            sub={`本库 ${health.pg.database_backends} · active ${health.pg.active}`}
            percent={
              health.pg.max_connections > 0
                ? Math.round((health.pg.instance_backends / health.pg.max_connections) * 100)
                : 0
            }
            tone={
              health.pg.max_connections > 0 &&
              health.pg.instance_backends / health.pg.max_connections > 0.9
                ? 'red'
                : health.pg.max_connections > 0 &&
                    health.pg.instance_backends / health.pg.max_connections > 0.7
                  ? 'yellow'
                  : 'green'
            }
          />
        </div>
      )}

      {/* Sparkline */}
      {samples.length >= 2 && (
        <div className="card p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-gray-700">短期趋势（本地采样，刷新页面清空）</h3>
            <span className="text-xs text-gray-400">{samples.length} / {MAX_SAMPLES} 点</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Sparkline
              label="应用池占用 %"
              values={samples.map((s) => s.appUsage)}
              color="#dc2626"
              maxHint={100}
            />
            <Sparkline
              label="PG 实例连接数"
              values={samples.map((s) => s.pgBackends)}
              color="#2563eb"
            />
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 bg-gray-100 p-1 rounded-lg w-fit">
        {(
          [
            ['diagnose', '诊断', 'fa-stethoscope'],
            ['app_pool', '应用连接池', 'fa-water'],
            ['connections', 'PG 会话', 'fa-plug'],
            ['slow', '慢查询', 'fa-clock'],
            ['tables', '表统计', 'fa-table'],
          ] as [Tab, string, string][]
        ).map(([key, label, icon]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              tab === key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <i className={`fas ${icon} mr-2`}></i>
            {label}
          </button>
        ))}
      </div>

      {tab === 'diagnose' && health && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="card p-6 space-y-4">
            <h3 className="text-sm font-semibold text-gray-700">应用池详情</h3>
            <Kv label="database_id" value={String(health.app_pool.database_id)} />
            <Kv label="loaded" value={health.app_pool.loaded ? '是' : '否'} />
            <Kv
              label="水位"
              value={`${health.app_pool.in_use} in_use / ${health.app_pool.size} size / ${health.app_pool.max} max`}
            />
            <Kv label="min_connections" value={String(health.app_pool.min)} />
            <Kv label="acquire_timeout" value={`${health.app_pool.acquire_timeout_secs}s`} />
            <Kv
              label="DB 配置 max"
              value={
                health.app_pool.db_configured_max != null
                  ? String(health.app_pool.db_configured_max)
                  : '-'
              }
            />
            <Kv
              label="TENANT_DB_MAX_CONNECTIONS"
              value={
                health.app_pool.env_override != null
                  ? String(health.app_pool.env_override)
                  : '未设置'
              }
            />
          </div>
          <div className="card p-6 space-y-4">
            <h3 className="text-sm font-semibold text-gray-700">PG 会话摘要</h3>
            <Kv label="active" value={String(health.pg.active)} />
            <Kv label="idle" value={String(health.pg.idle)} />
            <Kv label="idle in transaction" value={String(health.pg.idle_in_transaction)} />
            <Kv
              label="idle in transaction (aborted)"
              value={String(health.pg.idle_in_transaction_aborted)}
            />
            <Kv label="LISTEN 会话（本库）" value={String(health.pg.listen_sessions)} />
            <Kv label="等锁" value={String(health.pg.waiting_on_locks)} />
            <Kv
              label="最长 active"
              value={
                health.pg.longest_active_seconds != null
                  ? `${health.pg.longest_active_seconds.toFixed(1)}s`
                  : '-'
              }
            />
            <Kv
              label="最长 idle in xact"
              value={
                health.pg.longest_idle_in_transaction_seconds != null
                  ? `${health.pg.longest_idle_in_transaction_seconds.toFixed(1)}s`
                  : '-'
              }
            />
          </div>
          {health.acquire_failures.recent.length > 0 && (
            <div className="card p-6 lg:col-span-2">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">
                最近 acquire 超时（近似，重启清零）
              </h3>
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs text-gray-500">时间</th>
                    <th className="px-3 py-2 text-left text-xs text-gray-500">来源</th>
                    <th className="px-3 py-2 text-left text-xs text-gray-500">database_id</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {health.acquire_failures.recent.map((e, i) => (
                    <tr key={i}>
                      <td className="px-3 py-2 text-xs font-mono">{formatTime(e.at)}</td>
                      <td className="px-3 py-2 text-xs">{e.source}</td>
                      <td className="px-3 py-2 text-xs font-mono">
                        {e.database_id ?? '（HTTP 兜底）'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {stats && (
            <div className="card p-6 lg:col-span-2">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">PG 概览</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <MiniStat label="数据库大小" value={stats.database_size} />
                <MiniStat label="表数量" value={String(stats.table_count)} />
                <MiniStat label="缓存命中率" value={`${stats.cache_hit_ratio.toFixed(1)}%`} />
                <MiniStat label="运行时间" value={formatUptime(stats.uptime_seconds)} />
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'app_pool' && health && (
        <div className="space-y-4">
          <div className="card p-6">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">主池水位</h3>
            <div className="mb-3">
              <div className="flex justify-between text-xs text-gray-500 mb-1">
                <span>
                  in_use {health.app_pool.in_use} / max {health.app_pool.max}
                </span>
                <span>{health.app_pool.usage_percent}%</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-3">
                <div
                  className={`h-3 rounded-full transition-all ${
                    health.app_pool.usage_percent >= 100
                      ? 'bg-red-500'
                      : health.app_pool.usage_percent >= 80
                        ? 'bg-yellow-500'
                        : 'bg-green-500'
                  }`}
                  style={{ width: `${Math.min(health.app_pool.usage_percent, 100)}%` }}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
              <MiniStat label="size" value={String(health.app_pool.size)} />
              <MiniStat label="idle" value={String(health.app_pool.idle)} />
              <MiniStat label="in_use" value={String(health.app_pool.in_use)} />
              <MiniStat label="max" value={String(health.app_pool.max)} />
            </div>
          </div>
          {health.app_pool.replicas.length > 0 && (
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs text-gray-500">Replica ID</th>
                    <th className="px-4 py-3 text-left text-xs text-gray-500">Bypassed</th>
                    <th className="px-4 py-3 text-right text-xs text-gray-500">in_use</th>
                    <th className="px-4 py-3 text-right text-xs text-gray-500">idle</th>
                    <th className="px-4 py-3 text-right text-xs text-gray-500">size</th>
                    <th className="px-4 py-3 text-right text-xs text-gray-500">max</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {health.app_pool.replicas.map((r) => (
                    <tr key={r.replica_id}>
                      <td className="px-4 py-3 font-mono text-xs">{r.replica_id}</td>
                      <td className="px-4 py-3 text-xs">{r.bypassed ? '是' : '否'}</td>
                      <td className="px-4 py-3 text-right text-xs">{r.watermark.in_use}</td>
                      <td className="px-4 py-3 text-right text-xs">{r.watermark.idle}</td>
                      <td className="px-4 py-3 text-right text-xs">{r.watermark.size}</td>
                      <td className="px-4 py-3 text-right text-xs">{r.watermark.max}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="card p-6">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">LISTEN 独立连接（不占业务池）</h3>
            <div className="grid grid-cols-3 gap-3">
              <MiniStat label="合计" value={String(health.listeners.dedicated_connections)} />
              <MiniStat label="SSE bridges" value={String(health.listeners.sse_bridges)} />
              <MiniStat label="notify workflows" value={String(health.listeners.notify_workflows)} />
            </div>
            <p className="text-xs text-gray-400 mt-3">
              数值来自管理库配置去重计数；LISTEN 隔离改造后这些连接不再占用上方业务池槽位。
            </p>
          </div>
        </div>
      )}

      {tab === 'connections' && (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">PID</th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">状态</th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">标记</th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">用户</th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">应用</th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">SQL</th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">耗时</th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">事务</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {connections.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center py-8 text-gray-400">
                    当前无会话
                  </td>
                </tr>
              ) : (
                connections.map((c) => (
                  <tr key={c.pid} className="hover:bg-gray-50">
                    <td className="px-3 py-3 text-xs font-mono text-gray-700">{c.pid}</td>
                    <td className="px-3 py-3">
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${
                          c.state === 'active'
                            ? 'bg-green-100 text-green-800'
                            : c.state.startsWith('idle in transaction')
                              ? 'bg-yellow-100 text-yellow-800'
                              : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {c.state || '-'}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      {c.is_listen ? (
                        <span className="px-2 py-0.5 rounded text-xs bg-blue-100 text-blue-800">
                          LISTEN
                        </span>
                      ) : (
                        <span className="text-xs text-gray-300">-</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-xs text-gray-700">{c.user}</td>
                    <td className="px-3 py-3 text-xs text-gray-500 max-w-[8rem] truncate" title={c.application_name}>
                      {c.application_name || '-'}
                    </td>
                    <td
                      className="px-3 py-3 text-xs font-mono text-gray-600 max-w-xs truncate"
                      title={c.query}
                    >
                      {c.query}
                    </td>
                    <td className="px-3 py-3 text-xs text-gray-600">
                      {c.duration_seconds != null ? `${c.duration_seconds.toFixed(1)}s` : '-'}
                    </td>
                    <td className="px-3 py-3 text-xs text-gray-600">
                      {c.xact_duration_seconds != null
                        ? `${c.xact_duration_seconds.toFixed(1)}s`
                        : '-'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'slow' && (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">SQL</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">调用</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">平均</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">最大</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">总耗时</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {pgSlowQueries.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-6 text-gray-400 text-xs">
                    暂无数据（需启用 pg_stat_statements 扩展）
                  </td>
                </tr>
              ) : (
                pgSlowQueries.map((q, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td
                      className="px-4 py-3 text-xs font-mono text-gray-600 max-w-md truncate"
                      title={q.query}
                    >
                      {q.query}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-700">{q.calls.toLocaleString()}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${
                          q.mean_time > 1000
                            ? 'bg-red-100 text-red-800'
                            : q.mean_time > 100
                              ? 'bg-yellow-100 text-yellow-800'
                              : 'bg-green-100 text-green-800'
                        }`}
                      >
                        {q.mean_time.toFixed(1)}ms
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">{q.max_time.toFixed(1)}ms</td>
                    <td className="px-4 py-3 text-xs text-gray-600">
                      {(q.total_time / 1000).toFixed(1)}s
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'tables' && (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Schema</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Table</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">行数</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">总大小</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">表大小</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">索引大小</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {tables.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-6 text-gray-400 text-xs">
                    暂无数据
                  </td>
                </tr>
              ) : (
                tables.map((t, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-xs font-mono text-gray-600">{t.schema_name}</td>
                    <td className="px-4 py-3 text-xs font-mono text-gray-900 font-medium">
                      {t.table_name}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-700 text-right">
                      {t.row_count.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-700 text-right font-medium">
                      {t.total_size}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600 text-right">{t.table_size}</td>
                    <td className="px-4 py-3 text-xs text-gray-600 text-right">{t.index_size}</td>
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

function WaterCard({
  label,
  value,
  sub,
  percent,
  tone,
}: {
  label: string
  value: string
  sub?: string
  percent?: number
  tone: 'red' | 'yellow' | 'green' | 'blue' | 'gray'
}) {
  const tones: Record<string, string> = {
    red: 'border-red-200 bg-red-50',
    yellow: 'border-amber-200 bg-amber-50',
    green: 'border-emerald-200 bg-emerald-50',
    blue: 'border-blue-200 bg-blue-50',
    gray: 'border-gray-200 bg-gray-50',
  }
  const bar: Record<string, string> = {
    red: 'bg-red-500',
    yellow: 'bg-amber-500',
    green: 'bg-emerald-500',
    blue: 'bg-blue-500',
    gray: 'bg-gray-400',
  }
  return (
    <div className={`card p-4 border ${tones[tone]}`}>
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className="text-xl font-semibold text-gray-900 truncate">{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
      {percent != null && (
        <div className="w-full bg-white/70 rounded-full h-1.5 mt-3">
          <div
            className={`h-1.5 rounded-full ${bar[tone]}`}
            style={{ width: `${Math.min(percent, 100)}%` }}
          />
        </div>
      )}
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-3 bg-gray-50 rounded-lg">
      <p className="text-lg font-semibold text-gray-900">{value}</p>
      <p className="text-xs text-gray-500">{label}</p>
    </div>
  )
}

function Kv({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 text-sm border-b border-gray-100 pb-2">
      <span className="text-gray-500">{label}</span>
      <span className="font-mono text-gray-900 text-right">{value}</span>
    </div>
  )
}

function Sparkline({
  label,
  values,
  color,
  maxHint,
}: {
  label: string
  values: number[]
  color: string
  maxHint?: number
}) {
  const w = 280
  const h = 56
  const max = Math.max(maxHint ?? 0, ...values, 1)
  const min = 0
  const pts = values
    .map((v, i) => {
      const x = values.length === 1 ? 0 : (i / (values.length - 1)) * w
      const y = h - ((v - min) / (max - min)) * (h - 4) - 2
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const latest = values[values.length - 1]
  return (
    <div>
      <div className="flex justify-between text-xs text-gray-500 mb-1">
        <span>{label}</span>
        <span className="font-mono">{latest}</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-14 bg-gray-50 rounded">
        <polyline fill="none" stroke={color} strokeWidth="2" points={pts} />
      </svg>
    </div>
  )
}
