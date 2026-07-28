'use client'

import { useState, useEffect, useCallback } from 'react'
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
}

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

export default function MonitorPage() {
  const [stats, setStats] = useState<DbStats | null>(null)
  const [tables, setTables] = useState<TableSize[]>([])
  const [pgSlowQueries, setPgSlowQueries] = useState<PgSlowQuery[]>([])
  const [appSlowQueries, setAppSlowQueries] = useState<AppSlowQuery[]>([])
  const [connections, setConnections] = useState<ActiveConn[]>([])
  const [circuitBreakers, setCircuitBreakers] = useState<CircuitBreakerInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [tab, setTab] = useState<'overview' | 'connections' | 'slow' | 'tables'>('overview')

  const loadAll = useCallback(async () => {
    try {
      const [statsRes, tablesRes, pgSlowRes, connRes, appSlowRes, cbRes] = await Promise.allSettled([
        api.get('/api/monitor/stats'),
        api.get('/api/monitor/tables'),
        api.get('/api/monitor/slow-queries'),
        api.get('/api/monitor/connections'),
        api.get('/api/admin/slow-queries', { params: { limit: 20 } }),
        api.get('/api/admin/circuit-breakers'),
      ])

      if (statsRes.status === 'fulfilled') setStats(statsRes.value.data)
      if (tablesRes.status === 'fulfilled') setTables(tablesRes.value.data || [])
      if (pgSlowRes.status === 'fulfilled') setPgSlowQueries(pgSlowRes.value.data || [])
      if (connRes.status === 'fulfilled') setConnections(connRes.value.data || [])
      if (appSlowRes.status === 'fulfilled') setAppSlowQueries(appSlowRes.value.data?.data || [])
      if (cbRes.status === 'fulfilled') setCircuitBreakers(cbRes.value.data?.data || [])
    } catch (err) {
      console.error('加载监控数据失败:', err)
    } finally {
      setLoading(false)
    }
  }, [])

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

  const connUsagePercent = stats ? Math.round((stats.connection_count / stats.max_connections) * 100) : 0

  return (
    <div className="space-y-6">
      {/* 顶部 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">数据库监控</h1>
          <p className="text-sm text-gray-500 mt-1">实时数据库状态、连接、慢查询一览</p>
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

      {/* 概览卡片 */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
          <StatCard icon="fa-database" label="数据库大小" value={stats.database_size} color="blue" />
          <StatCard icon="fa-table" label="表数量" value={String(stats.table_count)} color="indigo" />
          <StatCard
            icon="fa-plug"
            label="连接数"
            value={`${stats.connection_count} / ${stats.max_connections}`}
            sub={`${connUsagePercent}% 使用`}
            color={connUsagePercent > 80 ? 'red' : connUsagePercent > 50 ? 'yellow' : 'green'}
          />
          <StatCard icon="fa-bolt" label="活跃连接" value={String(stats.active_connections)} sub={`空闲 ${stats.idle_connections}`} color="emerald" />
          <StatCard icon="fa-tachometer-alt" label="缓存命中率" value={`${stats.cache_hit_ratio.toFixed(1)}%`} color={stats.cache_hit_ratio > 95 ? 'green' : 'yellow'} />
          <StatCard icon="fa-clock" label="运行时间" value={formatUptime(stats.uptime_seconds)} color="gray" />
        </div>
      )}

      {/* 熔断器状态 */}
      {circuitBreakers.length > 0 && (
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-2"><i className="fas fa-shield-alt mr-2 text-orange-500"></i>熔断器状态</h3>
          <div className="flex flex-wrap gap-2">
            {circuitBreakers.map((cb) => (
              <span key={cb.database_id} className={`px-3 py-1 rounded-full text-xs font-medium ${
                cb.state === 'Closed' ? 'bg-green-100 text-green-800' :
                cb.state === 'Open' ? 'bg-red-100 text-red-800' :
                'bg-yellow-100 text-yellow-800'
              }`}>
                DB#{cb.database_id}: {cb.state === 'Closed' ? '正常' : cb.state === 'Open' ? '熔断中' : '半开探测'}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Tab 切换 */}
      <div className="flex space-x-1 bg-gray-100 p-1 rounded-lg w-fit">
        {([
          ['overview', '连接池', 'fa-water'],
          ['connections', '活跃连接', 'fa-plug'],
          ['slow', '慢查询', 'fa-clock'],
          ['tables', '表统计', 'fa-table'],
        ] as [typeof tab, string, string][]).map(([key, label, icon]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              tab === key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <i className={`fas ${icon} mr-2`}></i>{label}
          </button>
        ))}
      </div>

      {/* 连接池概览 */}
      {tab === 'overview' && stats && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* 连接使用率 */}
          <div className="card p-6">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">连接使用率</h3>
            <div className="space-y-3">
              <div>
                <div className="flex justify-between text-xs text-gray-500 mb-1">
                  <span>总连接 {stats.connection_count} / {stats.max_connections}</span>
                  <span>{connUsagePercent}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-3">
                  <div
                    className={`h-3 rounded-full transition-all ${
                      connUsagePercent > 80 ? 'bg-red-500' : connUsagePercent > 50 ? 'bg-yellow-500' : 'bg-green-500'
                    }`}
                    style={{ width: `${Math.min(connUsagePercent, 100)}%` }}
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4 mt-4">
                <div className="text-center p-3 bg-green-50 rounded-lg">
                  <p className="text-2xl font-bold text-green-700">{stats.active_connections}</p>
                  <p className="text-xs text-green-600">活跃</p>
                </div>
                <div className="text-center p-3 bg-gray-50 rounded-lg">
                  <p className="text-2xl font-bold text-gray-700">{stats.idle_connections}</p>
                  <p className="text-xs text-gray-500">空闲</p>
                </div>
                <div className="text-center p-3 bg-blue-50 rounded-lg">
                  <p className="text-2xl font-bold text-blue-700">{stats.max_connections - stats.connection_count}</p>
                  <p className="text-xs text-blue-600">可用</p>
                </div>
              </div>
            </div>
          </div>

          {/* 性能指标 */}
          <div className="card p-6">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">性能指标</h3>
            <div className="space-y-4">
              <div>
                <div className="flex justify-between text-xs text-gray-500 mb-1">
                  <span>缓存命中率</span>
                  <span>{stats.cache_hit_ratio.toFixed(2)}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full ${stats.cache_hit_ratio > 95 ? 'bg-green-500' : stats.cache_hit_ratio > 80 ? 'bg-yellow-500' : 'bg-red-500'}`}
                    style={{ width: `${Math.min(stats.cache_hit_ratio, 100)}%` }}
                  />
                </div>
                {stats.cache_hit_ratio < 90 && (
                  <p className="text-xs text-yellow-600 mt-1"><i className="fas fa-exclamation-triangle mr-1"></i>建议增加 shared_buffers</p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="p-3 bg-purple-50 rounded-lg">
                  <p className="text-lg font-bold text-purple-700">{(stats.transaction_count / 1000).toFixed(1)}K</p>
                  <p className="text-xs text-purple-500">事务总数</p>
                </div>
                <div className="p-3 bg-orange-50 rounded-lg">
                  <p className="text-lg font-bold text-orange-700">{formatUptime(stats.uptime_seconds)}</p>
                  <p className="text-xs text-orange-500">运行时间</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 活跃连接 */}
      {tab === 'connections' && (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">PID</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">用户</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">数据库</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">状态</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">执行中 SQL</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">耗时</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">来源</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {connections.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-8 text-gray-400">当前无活跃连接（仅显示非 idle 连接）</td></tr>
              ) : (
                connections.map((c) => (
                  <tr key={c.pid} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-xs font-mono text-gray-700">{c.pid}</td>
                    <td className="px-4 py-3 text-xs text-gray-700">{c.user}</td>
                    <td className="px-4 py-3 text-xs font-mono text-gray-600">{c.database}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                        c.state === 'active' ? 'bg-green-100 text-green-800' :
                        c.state === 'idle in transaction' ? 'bg-yellow-100 text-yellow-800' :
                        'bg-gray-100 text-gray-600'
                      }`}>{c.state}</span>
                    </td>
                    <td className="px-4 py-3 text-xs font-mono text-gray-600 max-w-xs truncate" title={c.query}>{c.query}</td>
                    <td className="px-4 py-3 text-xs text-gray-600">
                      {c.duration_seconds != null ? `${c.duration_seconds.toFixed(1)}s` : '-'}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">{c.client_addr || '-'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* 慢查询 */}
      {tab === 'slow' && (
        <div className="space-y-6">
          {/* pg_stat_statements 慢查询 */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-3"><i className="fas fa-database mr-2 text-blue-500"></i>PostgreSQL 慢查询 (pg_stat_statements)</h3>
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">SQL</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">调用次数</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">平均耗时</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">最大耗时</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">总耗时</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {pgSlowQueries.length === 0 ? (
                    <tr><td colSpan={5} className="text-center py-6 text-gray-400 text-xs">
                      暂无数据（需启用 pg_stat_statements 扩展）
                    </td></tr>
                  ) : (
                    pgSlowQueries.map((q, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-xs font-mono text-gray-600 max-w-md truncate" title={q.query}>{q.query}</td>
                        <td className="px-4 py-3 text-xs text-gray-700">{q.calls.toLocaleString()}</td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${q.mean_time > 1000 ? 'bg-red-100 text-red-800' : q.mean_time > 100 ? 'bg-yellow-100 text-yellow-800' : 'bg-green-100 text-green-800'}`}>
                            {q.mean_time.toFixed(1)}ms
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-600">{q.max_time.toFixed(1)}ms</td>
                        <td className="px-4 py-3 text-xs text-gray-600">{(q.total_time / 1000).toFixed(1)}s</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* 应用层慢查询 */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-3"><i className="fas fa-code mr-2 text-purple-500"></i>OneBase Auto API 慢查询 (&gt;500ms)</h3>
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">时间</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Schema.Table</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">SQL</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">耗时</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {appSlowQueries.length === 0 ? (
                    <tr><td colSpan={4} className="text-center py-6 text-gray-400 text-xs">暂无慢查询记录</td></tr>
                  ) : (
                    appSlowQueries.map((q) => (
                      <tr key={q.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{new Date(q.created_at).toLocaleString('zh-CN')}</td>
                        <td className="px-4 py-3 text-xs font-mono text-gray-700">{q.schema_name}.{q.table_name}</td>
                        <td className="px-4 py-3 text-xs font-mono text-gray-600 max-w-md truncate" title={q.sql_preview || ''}>{q.sql_preview}</td>
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
          </div>
        </div>
      )}

      {/* 表统计 */}
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
                <tr><td colSpan={6} className="text-center py-6 text-gray-400 text-xs">暂无数据</td></tr>
              ) : (
                tables.map((t, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-xs font-mono text-gray-600">{t.schema_name}</td>
                    <td className="px-4 py-3 text-xs font-mono text-gray-900 font-medium">{t.table_name}</td>
                    <td className="px-4 py-3 text-xs text-gray-700 text-right">{t.row_count.toLocaleString()}</td>
                    <td className="px-4 py-3 text-xs text-gray-700 text-right font-medium">{t.total_size}</td>
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

function StatCard({ icon, label, value, sub, color }: {
  icon: string; label: string; value: string; sub?: string; color: string
}) {
  const colors: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-700',
    indigo: 'bg-indigo-50 text-indigo-700',
    green: 'bg-green-50 text-green-700',
    emerald: 'bg-emerald-50 text-emerald-700',
    yellow: 'bg-yellow-50 text-yellow-700',
    red: 'bg-red-50 text-red-700',
    gray: 'bg-gray-50 text-gray-700',
    purple: 'bg-purple-50 text-purple-700',
    orange: 'bg-orange-50 text-orange-700',
  }
  const c = colors[color] || colors.gray

  return (
    <div className="card p-4">
      <div className="flex items-center space-x-3">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${c}`}>
          <i className={`fas ${icon} text-sm`}></i>
        </div>
        <div className="min-w-0">
          <p className="text-xs text-gray-500">{label}</p>
          <p className="text-sm font-semibold text-gray-900 truncate">{value}</p>
          {sub && <p className="text-xs text-gray-400">{sub}</p>}
        </div>
      </div>
    </div>
  )
}
