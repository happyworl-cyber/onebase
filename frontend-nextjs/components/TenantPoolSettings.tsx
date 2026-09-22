'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { tenantAPI } from '@/lib/api'
import { parseOptionalInt, parsePoolSettings, type OptionalInt } from '@/components/parseOptionalInt'

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
  const t = useTranslations('poolSettings')
  const [maxConn, setMaxConn] = useState<OptionalInt>(initialMax)
  const [timeoutSecs, setTimeoutSecs] = useState<OptionalInt>(initialTimeout)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    setMaxConn(initialMax)
    setTimeoutSecs(initialTimeout)
  }, [initialMax, initialTimeout, databaseId])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    const pool = parsePoolSettings(maxConn, timeoutSecs, TENANT_MAX_CONNECTIONS_CAP)
    if (!pool.ok) {
      setMsg({ ok: false, text: pool.text })
      return
    }
    const { max, timeout } = pool
    setSaving(true)
    setMsg(null)
    try {
      await tenantAPI.updateConnection(databaseSlug ?? databaseId, {
        max_connections: max,
        connection_timeout: timeout,
      })
      setMsg({ ok: true, text: t('saved') })
      onSaved?.(max, timeout)
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } }; message?: string }
      setMsg({
        ok: false,
        text: error.response?.data?.error || error.message || t('saveFailed'),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block">
          <span className="block text-sm font-medium text-gray-700 mb-1">{t('fMaxConn')}</span>
          <input
            type="number"
            min={1}
            max={TENANT_MAX_CONNECTIONS_CAP}
            value={maxConn}
            onChange={(e) => setMaxConn(parseOptionalInt(e.target.value))}
            className="input-base w-full"
          />
          <p className="text-xs text-gray-400 mt-1">
            {t('maxConnHint', { cap: TENANT_MAX_CONNECTIONS_CAP })}
          </p>
        </label>
        <label className="block">
          <span className="block text-sm font-medium text-gray-700 mb-1">{t('fAcquireTimeout')}</span>
          <input
            type="number"
            min={1}
            max={600}
            value={timeoutSecs}
            onChange={(e) => setTimeoutSecs(parseOptionalInt(e.target.value))}
            className="input-base w-full"
          />
          <p className="text-xs text-gray-400 mt-1">
            {t('acquireHint', { n: DEFAULT_TENANT_ACQUIRE_TIMEOUT_SECS })}
          </p>
        </label>
      </div>

      {(liveMax != null || liveTimeout != null) && (
        <p className="text-xs text-gray-500">
          {t('liveWater', { max: liveMax ?? '—', timeout: liveTimeout ?? '—' })}
          {envOverride != null ? t('envOverride', { v: envOverride }) : ''}
        </p>
      )}
      {envOverride != null && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          {t.rich('envWarn', {
            v: envOverride,
            code: (c) => <code className="font-mono">{c}</code>,
          })}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button type="submit" disabled={saving} className="btn-primary text-sm disabled:opacity-50">
          {saving ? t('saving') : t('saveRebuild')}
        </button>
        {msg && (
          <span className={`text-sm ${msg.ok ? 'text-emerald-700' : 'text-red-600'}`}>{msg.text}</span>
        )}
      </div>
    </form>
  )
}
