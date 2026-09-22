'use client'

import { useCallback, useState } from 'react'
import { useTranslations } from 'next-intl'
import { usePathname } from 'next/navigation'
import { healthAPI } from '@/lib/api'
import { showToast } from '@/components/Toast'

function fmtHealthStatus(s: string): string {
  if (s === 'healthy') return 'statusNormal'
  if (s === 'unhealthy') return 'statusAbnormal'
  if (s === 'not_configured') return 'statusNotConfigured'
  return s
}

const pageTitles: Record<string, string> = {
  '/dashboard': 'titleDashboard',
  '/dashboard/schema': 'titleSchema',
  '/dashboard/tables': 'titleTables',
  '/dashboard/query': 'titleQuery',
  '/dashboard/transaction': 'titleTransaction',
  '/dashboard/rpc': 'titleRpc',
  '/dashboard/rpc-acl': 'titleRpcAcl',
}

export default function Header() {
  const pathname = usePathname()
  const t = useTranslations('header')
  const title = pageTitles[pathname] ? t(pageTitles[pathname]) : t('adminConsole')
  const [checking, setChecking] = useState(false)

  const handleHealthCheck = useCallback(async () => {
    if (checking) return
    setChecking(true)
    try {
      const { data } = await healthAPI.getDetail()
      const db = t(fmtHealthStatus(data.database?.status ?? ''))
      const redis = t(fmtHealthStatus(data.redis?.status ?? ''))
      const ver = data.version ? ` · v${data.version}` : ''
      const ok = data.status === 'healthy'
      const msg = t('healthMsg', { overall: ok ? t('statusNormal') : t('statusAbnormal'), db, redis, ver })
      showToast(ok ? 'success' : 'warning', msg, 5500)
    } catch (err: unknown) {
      const e = err as { message?: string; response?: { data?: { error?: string } } }
      const detail =
        (typeof e.response?.data?.error === 'string' && e.response.data.error) ||
        e.message ||
        t('reqFailed')
      showToast('error', t('healthCheckFailed', { detail }), 6000)
    } finally {
      setChecking(false)
    }
  }, [checking])

  return (
    <div className="bg-white border-b border-gray-100 shadow-sm">
      <div className="px-6 py-4 flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2 text-sm text-gray-600">
            <i className="fas fa-home text-xs"></i>
            <i className="fas fa-chevron-right text-xs text-gray-400"></i>
            <span className="font-medium text-gray-900">{title}</span>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-2 px-3 py-1.5 bg-gray-50 rounded-lg border border-gray-200">
            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
            <span className="text-xs text-gray-600 font-mono">{process.env.NEXT_PUBLIC_API_URL ? new URL(process.env.NEXT_PUBLIC_API_URL).host : 'API'}</span>
          </div>

          <button
            type="button"
            onClick={handleHealthCheck}
            disabled={checking}
            className="btn-success shadow-sm hover:shadow-md transform transition-all duration-200 hover:-translate-y-0.5 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0"
          >
            <i className={`fas mr-1.5 ${checking ? 'fa-spinner fa-spin' : 'fa-heart-pulse'}`}></i>
            {checking ? t('checking') : t('healthCheck')}
          </button>
        </div>
      </div>
    </div>
  )
}

