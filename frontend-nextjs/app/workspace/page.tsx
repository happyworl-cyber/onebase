'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import api, { type ApiRequestConfig } from '@/lib/api'
import type { Project } from '@/lib/store'

/**
 * /workspace 项目选择页（W1 spec §3.2.1）。
 *
 * 行为：
 *   - length === 1 → 直接 router.replace('/workspace/<id>')
 *   - length === 0 → router.replace('/workspace/no-projects')
 *   - 其他 → 渲染项目卡片让用户选
 *
 * 用 replace 而不是 push，避免用户按浏览器后退又回到这个分发页。
 */
export default function WorkspacePickerPage() {
  const router = useRouter()
  const pathname = usePathname()
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const token = localStorage.getItem('token')
    if (!token) {
      router.replace('/login')
      return
    }

    // 超管统一走 /platform（带平台管理侧边栏），让 /workspace 与 /platform 体验一致。
    // 仅当当前不在 /platform 时重定向——/platform 复用本组件，若无此守卫会自我循环。
    if (pathname !== '/platform') {
      try {
        const userStr = localStorage.getItem('current_user')
        if (userStr && JSON.parse(userStr)?.is_superadmin) {
          router.replace('/platform')
          return
        }
      } catch {
        /* current_user 被污染时忽略，继续走普通项目选择逻辑 */
      }
    }

    api
      .get<{ projects: Project[] }>(
        '/api/projects',
        { suppressErrorToast: true } as ApiRequestConfig,
      )
      .then((resp) => {
        const list = resp.data.projects || []
        if (list.length === 0) {
          router.replace('/workspace/no-projects')
        } else if (list.length === 1) {
          router.replace(`/workspace/${list[0].id}`)
        } else {
          setProjects(list)
        }
      })
      .catch((err) => {
        setError(err?.response?.data?.error || err?.message || '加载项目列表失败')
      })
  }, [router, pathname])

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <i className="fas fa-exclamation-triangle text-2xl text-red-400 mb-2"></i>
          <p className="text-sm text-gray-700 mb-4">{error}</p>
          <button
            onClick={() => location.reload()}
            className="text-sm text-blue-600 hover:underline"
          >
            重试
          </button>
        </div>
      </div>
    )
  }

  if (!projects) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <i className="fas fa-spinner fa-spin text-2xl text-gray-400 mb-2"></i>
          <p className="text-sm text-gray-500">加载项目列表…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-6">
      <div className="max-w-3xl mx-auto">
        <header className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">选择项目</h1>
            <p className="text-sm text-gray-500 mt-1">
              你可以访问以下 {projects.length} 个项目
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={() => router.push('/workspace/platform-tokens')}
              className="inline-flex items-center px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              title="给机器 / AI 用的平台服务令牌（HTTP / MCP）"
            >
              <i className="fas fa-robot mr-2"></i>
              平台服务令牌
            </button>
            <button
              onClick={() => router.push('/workspace/provision')}
              className="btn-primary"
            >
              <i className="fas fa-plus mr-2"></i>
              新建项目
            </button>
          </div>
        </header>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => router.push(`/workspace/${p.id}`)}
              className="bg-white border border-gray-200 rounded-lg p-4 text-left hover:shadow-sm hover:border-blue-300 transition"
            >
              <div className="flex items-start justify-between mb-2">
                <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
                  <i className="fas fa-cube text-blue-600"></i>
                </div>
                <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded font-mono">
                  {p.user_role}
                </span>
              </div>
              <div className="text-base font-medium text-gray-900 truncate">{p.name}</div>
              <div className="text-xs text-gray-500 font-mono mt-0.5 truncate">
                {p.slug || `id=${p.id}`}
              </div>
              {p.contact_email && (
                <div className="text-xs text-gray-400 mt-2 truncate">
                  <i className="fas fa-envelope mr-1"></i> {p.contact_email}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
