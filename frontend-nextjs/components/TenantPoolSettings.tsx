'use client'

import { useEffect, useState } from 'react'
import { tenantAPI } from '@/lib/api'

/** 与 `pool_manager::DEFAULT_TENANT_MAX_CONNECTIONS` 对齐。 */
export const DEFAULT_TENANT_MAX_CONNECTIONS = 20
/** 与 `pool_manager::DEFAULT_TENANT_ACQUIRE_TIMEOUT_SECS` 对齐。 */
export const DEFAULT_TENANT_ACQUIRE_TIMEOUT_SECS = 8
export const TENANT_MAX_CONNECTIONS_CAP = 50

export function TenantPoolSettingsForm({
  databaseId,
  databaseSlug,
  initialMax,
  initialTimeout,
  envOverride,
  liveMax,
  liveTimeout,
  onSaved,
}: {
  databaseId: number
  databaseSlug?: string | number | null
  initialMax: number
  initialTimeout: number
  envOverride?: number | null
  liveMax?: number | null
  liveTimeout?: number | null
  onSaved?: (max: number, timeout: number) => void
}) {
  const [maxConn, setMaxConn] = useState(initialMax)
  const [timeoutSecs, setTimeoutSecs] = useState(initialTimeout)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    setMaxConn(initialMax)
    setTimeoutSecs(initialTimeout)
  }, [initialMax, initialTimeout, databaseId])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    const max = Number(maxConn)
    const timeout = Number(timeoutSecs)
    if (!Number.isFinite(max) || max < 1 || max > TENANT_MAX_CONNECTIONS_CAP) {
      setMsg({ ok: false, text: `最大连接数必须在 1–${TENANT_MAX_CONNECTIONS_CAP}` })
      return
    }
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 600) {
      setMsg({ ok: false, text: '获取超时必须在 1–600 秒' })
      return
    }
    setSaving(true)
    setMsg(null)
    try {
      await tenantAPI.updateConnection(databaseSlug ?? databaseId, {
        max_connections: max,
        connection_timeout: timeout,
      })
      setMsg({ ok: true, text: '已保存，连接池将按新参数重建（无需重启服务）' })
      onSaved?.(max, timeout)
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } }; message?: string }
      setMsg({
        ok: false,
        text: error.response?.data?.error || error.message || '保存失败',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block">
          <span className="block text-sm font-medium text-gray-700 mb-1">最大连接数</span>
          <input
            type="number"
            min={1}
            max={TENANT_MAX_CONNECTIONS_CAP}
            value={maxConn}
            onChange={(e) => setMaxConn(parseInt(e.target.value, 10) || 1)}
            className="input-base w-full"
          />
          <p className="text-xs text-gray-400 mt-1">
            建议 20–30。单次页面并行打多个工作流时，10 很容易打满。上限 {TENANT_MAX_CONNECTIONS_CAP}。
          </p>
        </label>
        <label className="block">
          <span className="block text-sm font-medium text-gray-700 mb-1">获取连接超时（秒）</span>
          <input
            type="number"
            min={1}
            max={600}
            value={timeoutSecs}
            onChange={(e) => setTimeoutSecs(parseInt(e.target.value, 10) || 1)}
            className="input-base w-full"
          />
          <p className="text-xs text-gray-400 mt-1">
            池里暂时没有空闲连接时，最多等这么久。默认 {DEFAULT_TENANT_ACQUIRE_TIMEOUT_SECS} 秒。
          </p>
        </label>
      </div>

      {(liveMax != null || liveTimeout != null) && (
        <p className="text-xs text-gray-500">
          当前进程内水位：max {liveMax ?? '—'} · acquire {liveTimeout ?? '—'}s
          {envOverride != null ? ` · 环境变量覆盖为 ${envOverride}` : ''}
        </p>
      )}
      {envOverride != null && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          已设置 <code className="font-mono">TENANT_DB_MAX_CONNECTIONS={envOverride}</code>
          ，会覆盖上面的「最大连接数」。改库配置要等该环境变量去掉并重建池后才生效。
        </p>
      )}

      <div className="flex items-center gap-3">
        <button type="submit" disabled={saving} className="btn-primary text-sm disabled:opacity-50">
          {saving ? '保存中…' : '保存并重建连接池'}
        </button>
        {msg && (
          <span className={`text-sm ${msg.ok ? 'text-emerald-700' : 'text-red-600'}`}>{msg.text}</span>
        )}
      </div>
    </form>
  )
}
