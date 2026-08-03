'use client'

/**
 * `/platform/provision-settings` —— P3 运维 Webhook 开通配置（超管只读）。
 */

import { useEffect, useState } from 'react'
import { pgPoolAPI, type ProvisionWebhookAdminStatus, type ProvisionWebhookProbeResult } from '@/lib/api'
import { useNotification } from '@/hooks/useNotification'

export default function PlatformProvisionSettingsPage() {
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
        notify.success(res.data.message ?? 'Provisioner 可达')
      } else {
        notify.error(res.data.error ?? '探活失败')
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
        <p className="text-sm text-gray-500 mt-2">加载配置…</p>
      </div>
    )
  }

  if (!status) {
    return (
      <div className="text-center py-16 text-sm text-gray-500">无法加载 Provisioner Webhook 状态</div>
    )
  }

  const rows: { label: string; value: React.ReactNode }[] = [
    {
      label: 'Webhook 开通',
      value: status.provision_webhook_enabled ? (
        <span className="text-emerald-700 font-medium">已启用</span>
      ) : (
        <span className="text-gray-500">未配置 PROVISION_WEBHOOK_URL</span>
      ),
    },
    {
      label: 'Deprovision 回调',
      value: status.deprovision_url_configured ? (
        <span className="text-emerald-700">已配置</span>
      ) : (
        <span className="text-amber-700">未配置 PROVISION_WEBHOOK_DEPROVISION_URL</span>
      ),
    },
    {
      label: 'Bearer Token',
      value: status.token_configured ? '已配置（不展示）' : '未配置（可选）',
    },
    { label: '超时（秒）', value: status.timeout_secs },
    {
      label: 'Poll 间隔 / 上限',
      value: status.supports_async_poll
        ? `${status.poll_interval_secs ?? 5}s / ${status.poll_max_secs ?? 600}s`
        : '—',
    },
    {
      label: 'Redis 支持',
      value: status.supports_redis ? '向导可勾选 Redis' : '仅 PostgreSQL',
    },
  ]

  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">开通配置</h1>
        <p className="text-sm text-gray-600 mt-1">
          运维 Provisioner Webhook 状态（只读）。URL 与 Token 仅存服务端环境变量，不在此页展示。
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
                <i className="fas fa-spinner fa-spin mr-2"></i> 探活中…
              </>
            ) : (
              <>
                <i className="fas fa-stethoscope mr-2"></i> 探活 Provisioner
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
        <p className="font-medium text-gray-800">环境变量示例</p>
        <pre className="font-mono text-[11px] whitespace-pre-wrap break-all">
{`PROVISION_WEBHOOK_URL=https://ops.internal/onebase/provision
PROVISION_WEBHOOK_DEPROVISION_URL=https://ops.internal/onebase/deprovision
PROVISION_WEBHOOK_TOKEN=...
PROVISION_WEBHOOK_TIMEOUT_SECS=120`}
        </pre>
        <p>本地 mock：<code className="font-mono">python3 examples/provisioner-webhook/mock_server.py</code></p>
      </div>
    </div>
  )
}
