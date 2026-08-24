'use client'

/**
 * `/platform` —— 平台超管：按租户分组查看全部项目（只读入口）。
 * 创建租户 → /platform/organizations；创建项目 → 租户控制台。
 */

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import api, { type ApiRequestConfig } from '@/lib/api'
import type { Project } from '@/lib/store'

type OrgGroup = {
  organization_id: number
  organization_name: string
  projects: Project[]
}

export default function PlatformProjectsPage() {
  const router = useRouter()
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ projects: Project[] }>('/api/projects', {
        suppressErrorToast: true,
      } as ApiRequestConfig)
      .then((res) => setProjects(res.data.projects || []))
      .catch((err) => {
        setError(err?.response?.data?.error || err?.message || '加载失败')
        setProjects([])
      })
  }, [])

  const groups = useMemo(() => {
    if (!projects) return []
    const map = new Map<number, OrgGroup>()
    for (const p of projects) {
      const oid = p.organization_id ?? 0
      const oname = p.organization_name || (oid ? `组织 #${oid}` : '未归属')
      let g = map.get(oid)
      if (!g) {
        g = { organization_id: oid, organization_name: oname, projects: [] }
        map.set(oid, g)
      }
      g.projects.push(p)
    }
    return Array.from(map.values()).sort((a, b) =>
      a.organization_name.localeCompare(b.organization_name, 'zh'),
    )
  }, [projects])

  return (
    <div className="w-full space-y-6">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">全部项目</h1>
          <p className="text-sm text-gray-500 mt-1">
            按租户分组。新建租户请用「租户管理」；新建项目请进入对应租户控制台。
          </p>
        </div>
        <button
          type="button"
          className="btn-primary shrink-0"
          onClick={() => router.push('/platform/organizations')}
        >
          租户管理
        </button>
      </header>

      {error && (
        <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-4 py-3">
          {error}
        </div>
      )}

      {projects === null ? (
        <div className="text-sm text-gray-400">
          <i className="fas fa-spinner fa-spin mr-2"></i>加载中…
        </div>
      ) : groups.length === 0 ? (
        <div className="bg-white border border-dashed border-gray-300 rounded-lg p-10 text-center text-sm text-gray-500">
          暂无项目。请先在「租户管理」创建租户，再在租户控制台开通项目。
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section
              key={g.organization_id}
              className="bg-white border border-gray-200 rounded-lg overflow-hidden"
            >
              <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-3 bg-slate-50">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-gray-900 truncate">
                    <i className="fas fa-building text-indigo-500 mr-2"></i>
                    {g.organization_name}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {g.projects.length} 个项目
                    {g.organization_id ? ` · org #${g.organization_id}` : ''}
                  </div>
                </div>
                {g.organization_id > 0 && (
                  <button
                    type="button"
                    className="text-xs text-blue-600 hover:underline shrink-0"
                    onClick={() => router.push(`/org/${g.organization_id}`)}
                  >
                    打开租户控制台 →
                  </button>
                )}
              </div>
              <div className="divide-y divide-gray-100">
                {g.projects.map((p) => (
                  <div
                    key={p.id}
                    className="px-4 py-3 flex items-center justify-between gap-3 hover:bg-gray-50"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-gray-900 truncate">{p.name}</div>
                      <div className="text-xs text-gray-500 font-mono truncate">
                        {p.slug || `id=${p.id}`} · {p.status}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="text-xs text-blue-600 hover:underline shrink-0"
                      onClick={() => router.push(`/workspace/${p.id}`)}
                    >
                      进入工作区
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
