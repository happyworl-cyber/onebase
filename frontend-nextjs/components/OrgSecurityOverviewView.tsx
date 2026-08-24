'use client'

import { useEffect, useState } from 'react'
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
        setError(err?.response?.data?.error || err?.message || '加载失败')
        setOverview(null)
      })

    return () => {
      cancelled = true
    }
  }, [organizationId])

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>
  }
  if (!overview) {
    return (
      <p className="text-sm text-gray-400">
        <i className="fas fa-spinner fa-spin mr-2"></i>加载安全总览…
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-semibold text-gray-900">安全总览</h1>
        <p className="text-sm text-gray-500 mt-1">
          跨项目查看安全与集成配置；具体配置仍在各项目工作区管理。
        </p>
      </header>

      <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 text-left font-medium">项目</th>
              <th className="px-4 py-3 text-right font-medium whitespace-nowrap">API Key</th>
              <th className="px-4 py-3 text-right font-medium">Webhook</th>
              <th className="px-4 py-3 text-right font-medium">SSO</th>
              <th className="px-4 py-3 text-right font-medium">IdP</th>
              <th className="px-4 py-3 text-right font-medium whitespace-nowrap">DB 连接</th>
              <th className="px-4 py-3 text-right font-medium">操作</th>
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
                    打开安全
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
                  暂无项目
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
