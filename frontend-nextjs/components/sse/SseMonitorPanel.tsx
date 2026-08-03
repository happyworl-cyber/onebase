'use client'

import { useEffect, useState } from 'react'
import { sseNotifyBridgeAPI, SseNotifyBridgeStats } from '@/lib/api'

/**
 * 只读监控面板：PG NOTIFY → SSE 监听桥状态 + 在线连接概况。
 *
 * 指标是进程全局视图（本实例所有 listener + 所有 SSE 连接），后端限超管访问；
 * 非超管会收到 403，这里给出友好提示。配置走迁移 / 运维 SQL，无在线增删改。
 */
export default function SseMonitorPanel() {
  const [stats, setStats] = useState<SseNotifyBridgeStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    try {
      const res = await sseNotifyBridgeAPI.getStats()
      setStats(res.data)
      setError(null)
    } catch (err: any) {
      const status = err?.response?.status
      setError(
        status === 403
          ? '仅平台超管可查看推送监控'
          : '加载监控数据失败: ' + (err?.response?.data?.error || err?.message || '未知错误')
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => clearInterval(timer)
  }, [])

  if (loading) {
    return (
      <div className="text-center py-12 text-gray-400">
        <i className="fas fa-spinner fa-spin text-2xl"></i>
      </div>
    )
  }

  if (error) {
    return (
      <div className="card p-6 text-sm text-gray-500">
        <i className="fas fa-circle-info mr-2 text-gray-400"></i>
        {error}
      </div>
    )
  }

  if (!stats) return null

  const c = stats.connections

  return (
    <div className="space-y-6">
      <p className="text-xs text-gray-400">
        进程内实时指标，每 5 秒刷新；重启清零。监听桥配置由迁移 / 运维 SQL 维护（无在线增删改）。
      </p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: '在线连接', value: c.total },
          { label: '对外端点连接', value: c.public },
          { label: '通用 /sse 连接', value: c.generic },
          { label: '累计推送', value: stats.pushes_total },
        ].map((m) => (
          <div key={m.label} className="card p-4">
            <div className="text-2xl font-semibold text-gray-900">{m.value}</div>
            <div className="text-xs text-gray-500 mt-1">{m.label}</div>
          </div>
        ))}
      </div>

      <div className="card p-5">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">监听桥（PG NOTIFY → SSE）</h3>
        {stats.listeners.length === 0 ? (
          <p className="text-sm text-gray-400">
            暂无监听桥。在 <code className="font-mono">management.sse_notify_bridges</code> 配置后将自动启动。
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-400 border-b">
                <th className="py-2">库 / channel</th>
                <th className="py-2">状态</th>
                <th className="py-2 text-right">收到</th>
                <th className="py-2 text-right">推送</th>
                <th className="py-2 text-right">解析错误</th>
                <th className="py-2 text-right">重连</th>
              </tr>
            </thead>
            <tbody>
              {stats.listeners.map((l) => (
                <tr key={`${l.database_id}:${l.channel}`} className="border-b last:border-0">
                  <td className="py-2">
                    <span className="font-mono text-xs">库 #{l.database_id} · {l.channel}</span>
                  </td>
                  <td className="py-2">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${
                        l.connected ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-700'
                      }`}
                    >
                      {l.connected ? '已连接' : '断开'}
                    </span>
                  </td>
                  <td className="py-2 text-right tabular-nums">{l.received}</td>
                  <td className="py-2 text-right tabular-nums">{l.published}</td>
                  <td className="py-2 text-right tabular-nums">{l.parse_error}</td>
                  <td className="py-2 text-right tabular-nums">{l.reconnect}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {c.by_endpoint.length > 0 && (
        <div className="card p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">对外端点连接（按端点）</h3>
          <div className="flex flex-wrap gap-2">
            {c.by_endpoint.map((p) => (
              <span
                key={p.slug}
                className="px-3 py-1 rounded-full text-xs bg-teal-50 text-teal-700"
              >
                /events/{p.slug}：{p.count}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
