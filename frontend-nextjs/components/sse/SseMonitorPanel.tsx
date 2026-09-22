'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { sseNotifyBridgeAPI, SseNotifyBridgeStats } from '@/lib/api'

/**
 * 只读监控面板：PG NOTIFY → SSE 监听桥状态 + 在线连接概况。
 *
 * 指标是进程全局视图（本实例所有 listener + 所有 SSE 连接），后端限超管访问；
 * 非超管会收到 403，这里给出友好提示。配置走迁移 / 运维 SQL，无在线增删改。
 */
export default function SseMonitorPanel() {
  const t = useTranslations('sseMonitor')
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
          ? t('forbidden')
          : t('loadFailed', { msg: err?.response?.data?.error || err?.message || t('unknownError') })
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
        {t('intro')}
      </p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: t('statOnline'), value: c.total },
          { label: t('statPublic'), value: c.public },
          { label: t('statGeneric'), value: c.generic },
          { label: t('statPushes'), value: stats.pushes_total },
        ].map((m) => (
          <div key={m.label} className="card p-4">
            <div className="text-2xl font-semibold text-gray-900">{m.value}</div>
            <div className="text-xs text-gray-500 mt-1">{m.label}</div>
          </div>
        ))}
      </div>

      <div className="card p-5">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">{t('bridgeTitle')}</h3>
        {stats.listeners.length === 0 ? (
          <p className="text-sm text-gray-400">
            {t.rich('bridgeEmpty', { code: (c) => <code className="font-mono">{c}</code> })}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-400 border-b">
                <th className="py-2">{t('thDbChannel')}</th>
                <th className="py-2">{t('thStatus')}</th>
                <th className="py-2 text-right">{t('thReceived')}</th>
                <th className="py-2 text-right">{t('thPushed')}</th>
                <th className="py-2 text-right">{t('thParseErr')}</th>
                <th className="py-2 text-right">{t('thReconnect')}</th>
              </tr>
            </thead>
            <tbody>
              {stats.listeners.map((l) => (
                <tr key={`${l.database_id}:${l.channel}`} className="border-b last:border-0">
                  <td className="py-2">
                    <span className="font-mono text-xs">{t('dbChannel', { id: l.database_id, channel: l.channel })}</span>
                  </td>
                  <td className="py-2">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${
                        l.connected ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-700'
                      }`}
                    >
                      {l.connected ? t('connected') : t('disconnected')}
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
          <h3 className="text-sm font-semibold text-gray-900 mb-3">{t('endpointTitle')}</h3>
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
