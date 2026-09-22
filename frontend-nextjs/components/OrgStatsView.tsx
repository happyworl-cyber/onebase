'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { organizationAPI } from '@/lib/api'

type OrgStats = {
  projects_active: number
  projects_archived: number
  members_active: number
  audit_calls_24h: number
  audit_errors_24h: number
  slow_queries_24h: number
  exec_total_24h: number
  exec_failed_24h: number
}

export default function OrgStatsView({ organizationId }: { organizationId: number }) {
  const t = useTranslations('orgStats')
  const [stats, setStats] = useState<OrgStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    organizationAPI
      .stats(organizationId)
      .then((res) => setStats(res.data))
      .catch((err) => {
        setError(err?.response?.data?.error || err?.message || t('loadFailed'))
        setStats(null)
      })
  }, [organizationId, t])

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>
  }
  if (!stats) {
    return (
      <p className="text-sm text-gray-400">
        <i className="fas fa-spinner fa-spin mr-2"></i>{t('loadingStats')}
      </p>
    )
  }

  const cards: Array<{ label: string; value: number; hint: string; tone?: string }> = [
    {
      label: t('activeProjects'),
      value: stats.projects_active,
      hint: t('archived', { n: stats.projects_archived }),
    },
    { label: t('orgMembers'), value: stats.members_active, hint: t('activeMembers') },
    {
      label: t('apiCalls24h'),
      value: stats.audit_calls_24h,
      hint: t('errors', { n: stats.audit_errors_24h }),
    },
    {
      label: t('exec24h'),
      value: stats.exec_total_24h,
      hint: t('failed', { n: stats.exec_failed_24h }),
      tone: stats.exec_failed_24h > 0 ? 'text-amber-700' : undefined,
    },
    {
      label: t('slowQueries24h'),
      value: stats.slow_queries_24h,
      hint: t('appLayerSlowQueries'),
      tone: stats.slow_queries_24h > 0 ? 'text-orange-600' : undefined,
    },
  ]

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-semibold text-gray-900">{t('title')}</h1>
        <p className="text-sm text-gray-500 mt-1">{t('subtitle')}</p>
      </header>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
        {cards.map((c) => (
          <div
            key={c.label}
            className="bg-white border border-gray-200 rounded-lg px-4 py-4"
          >
            <p className="text-xs text-gray-500">{c.label}</p>
            <p className={`text-2xl font-semibold mt-1 tabular-nums ${c.tone || 'text-gray-900'}`}>
              {c.value.toLocaleString()}
            </p>
            <p className="text-xs text-gray-400 mt-1">{c.hint}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
