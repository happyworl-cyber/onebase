'use client'

/**
 * `/platform/provision-settings` —— P3 运维 Webhook 开通配置（超管只读）。
 */

import { useEffect, useState } from 'react'
import { pgPoolAPI, type ProvisionWebhookAdminStatus, type ProvisionWebhookProbeResult } from '@/lib/api'
import { useTranslations } from 'next-intl'
import { useNotification } from '@/hooks/useNotification'

export default function PlatformProvisionSettingsPage() {
  const t = useTranslations('platformProvision')
  const notify = useNotification()
  const [status, setStatus] = useState<ProvisionWebhookAdminStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [probing, setProbing] = useState(false)
  const [probeResult, setProbeResult] = useState<ProvisionWebhookProbeResult | null>(null)

  useEffect(() => {
    pgPoolAPI
      .adminWebhookStatus()
      .then((res) => setStatus(res.data))
      .catch((e) => notify.error(e))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runProbe = async () => {
    setProbing(true)
    setProbeResult(null)
    try {
      const res = await pgPoolAPI.adminWebhookProbe()
      setProbeResult(res.data)
      if (res.data.ok) {
        notify.success(res.data.message ?? t('reachable'))
      } else {
        notify.error(res.data.error ?? t('probeFailed'))
      }
    } catch (e) {
      notify.error(e)
    } finally {
      setProbing(false)
    }
  }

  if (loading) {
    return (
      <div className="text-center py-16">
        <i className="fas fa-spinner fa-spin text-gray-400"></i>
        <p className="text-sm text-gray-500 mt-2">{t('loadingConfig')}</p>
      </div>
    )
  }

  if (!status) {
    return (
      <div className="text-center py-16 text-sm text-gray-500">{t('cannotLoad')}</div>
    )
  }

  const rows: { label: string; value: React.ReactNode }[] = [
    {
      label: t('webhookLabel'),
      value: status.provision_webhook_enabled ? (
        <span className="text-emerald-700 font-medium">{t('enabled')}</span>
      ) : (
        <span className="text-gray-500">{t('noWebhookUrl')}</span>
      ),
    },
    {
      label: t('deprovLabel'),
      value: status.deprovision_url_configured ? (
        <span className="text-emerald-700">{t('configured')}</span>
      ) : (
        <span className="text-amber-700">{t('noDeprovUrl')}</span>
      ),
    },
    {
      label: 'Bearer Token',
      value: status.token_configured ? t('tokenConfigured') : t('tokenNotConfigured'),
    },
    { label: t('timeoutLabel'), value: status.timeout_secs },
    {
      label: t('pollLabel'),
      value: status.supports_async_poll
        ? `${status.poll_interval_secs ?? 5}s / ${status.poll_max_secs ?? 600}s`
        : '—',
    },
    {
      label: t('redisLabel'),
      value: status.supports_redis ? t('redisYes') : t('redisNo'),
    },
  ]

  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
        <p className="text-sm text-gray-600 mt-1">
          {t('subtitle')}
        </p>
      </header>

      <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center px-5 py-3.5 text-sm">
            <div className="w-40 text-gray-500 shrink-0">{r.label}</div>
            <div className="text-gray-900 flex-1">{r.value}</div>
          </div>
        ))}
      </div>

      {status.provision_webhook_enabled && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={runProbe}
            disabled={probing}
            className="btn-primary text-sm disabled:opacity-50"
          >
            {probing ? (
              <>
                <i className="fas fa-spinner fa-spin mr-2"></i> {t('probing')}
              </>
            ) : (
              <>
                <i className="fas fa-stethoscope mr-2"></i> {t('probeBtn')}
              </>
            )}
          </button>
          {probeResult && (
            <span
              className={`text-sm ${probeResult.ok ? 'text-emerald-700' : 'text-red-600'}`}
            >
              {probeResult.ok
                ? `HTTP ${probeResult.http_status} — ${probeResult.message}`
                : probeResult.error}
            </span>
          )}
        </div>
      )}

      {status.description && (
        <p className="text-xs text-gray-500 leading-relaxed">{status.description}</p>
      )}

      <div className="p-4 rounded-lg border border-dashed border-gray-200 bg-gray-50 text-xs text-gray-600 space-y-2">
        <p className="font-medium text-gray-800">{t('envExample')}</p>
        <pre className="font-mono text-[11px] whitespace-pre-wrap break-all">
{`PROVISION_WEBHOOK_URL=https://ops.internal/planeos/provision
PROVISION_WEBHOOK_DEPROVISION_URL=https://ops.internal/planeos/deprovision
PROVISION_WEBHOOK_TOKEN=...
PROVISION_WEBHOOK_TIMEOUT_SECS=120`}
        </pre>
        <p>{t('localMock')}<code className="font-mono">python3 examples/provisioner-webhook/mock_server.py</code></p>
      </div>
    </div>
  )
}
