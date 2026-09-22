'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { organizationAPI } from '@/lib/api'

type SecurityProject = {
  id: number
  name: string
  slug: string
  api_keys: number
  webhooks: number
  sso_providers: number
  idp_providers: number
  databases: number
}

type SecurityOverview = {
  organization_id: number
  projects: SecurityProject[]
}

type OrgSecurityOverviewViewProps = {
  organizationId: number
}

export default function OrgSecurityOverviewView({
  organizationId,
}: OrgSecurityOverviewViewProps) {
  const t = useTranslations('orgSecOverview')
  const [overview, setOverview] = useState<SecurityOverview | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setOverview(null)
    setError(null)

    organizationAPI
      .securityOverview(organizationId)
      .then((res) => {
        if (!cancelled) setOverview(res.data)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err?.response?.data?.error || err?.message || t('loadFailed'))
        setOverview(null)
      })

    return () => {
      cancelled = true
    }
  }, [organizationId, t])

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>
  }
  if (!overview) {
    return (
      <p className="text-sm text-gray-400">
        <i className="fas fa-spinner fa-spin mr-2"></i>{t('loadingOverview')}
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-semibold text-gray-900">{t('title')}</h1>
        <p className="text-sm text-gray-500 mt-1">{t('subtitle')}</p>
      </header>

      <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 text-left font-medium">{t('colProject')}</th>
              <th className="px-4 py-3 text-right font-medium whitespace-nowrap">API Key</th>
              <th className="px-4 py-3 text-right font-medium">Webhook</th>
              <th className="px-4 py-3 text-right font-medium">SSO</th>
              <th className="px-4 py-3 text-right font-medium">IdP</th>
              <th className="px-4 py-3 text-right font-medium whitespace-nowrap">{t('colDbConnections')}</th>
              <th className="px-4 py-3 text-right font-medium">{t('colActions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {overview.projects.map((project) => (
              <tr key={project.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-4 py-3 min-w-52">
                  <div className="font-medium text-gray-900">{project.name}</div>
                  <div className="text-xs font-mono text-gray-400">{project.slug}</div>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{project.api_keys}</td>
                <td className="px-4 py-3 text-right tabular-nums">{project.webhooks}</td>
                <td className="px-4 py-3 text-right tabular-nums">{project.sso_providers}</td>
                <td className="px-4 py-3 text-right tabular-nums">{project.idp_providers}</td>
                <td className="px-4 py-3 text-right tabular-nums">{project.databases}</td>
                <td className="px-4 py-3 text-right whitespace-nowrap space-x-3">
                  <a
                    href={`/workspace/${project.id}/security/api-keys`}
                    className="text-xs text-blue-600 hover:underline"
                  >
                    {t('openSecurity')}
                  </a>
                  <a
                    href={`/workspace/${project.id}/security/idp`}
                    className="text-xs text-indigo-600 hover:underline"
                  >
                    IdP
                  </a>
                </td>
              </tr>
            ))}
            {overview.projects.length === 0 && (
              <tr>
                <td className="px-4 py-8 text-center text-gray-400" colSpan={7}>
                  {t('noProjects')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
