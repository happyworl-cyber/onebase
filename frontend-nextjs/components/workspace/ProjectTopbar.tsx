'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAppStore, type Project } from '@/lib/store'
import api, { type ApiRequestConfig } from '@/lib/api'
import { clearAuthToken } from '@/lib/auth'

/**
 * 工作空间顶栏（W1 spec §3.2.4）：左侧项目切换器 + 右侧用户菜单。
 *
 * 项目列表懒加载（点开下拉才拉一次）。W1 阶段不做 SWR 缓存，多次点开
 * 会重复请求——可在 W2 用 SWR 或 store 缓存补。
 *
 * 安全说明：登出走 router.push('/login') 而不是 window.location.href，
 * 这样不会丢前端运行时（Next 路由切换 + axios 拦截器仍在）。token 已经
 * 通过 clearAuthToken 清掉，登录页会自己判定。
 */
export default function ProjectTopbar() {
  const router = useRouter()
  const currentProject = useAppStore((s) => s.currentProject)
  const currentUser = useAppStore((s) => s.currentUser)
  // SSO 用户（如 Mind）可能没有邮箱，优先用用户名兜底，避免头像/菜单显示成 "?"。
  const displayName = currentUser?.username || currentUser?.email || '用户'

  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [loading, setLoading] = useState(false)

  const projectMenuRef = useRef<HTMLDivElement>(null)
  const userMenuRef = useRef<HTMLDivElement>(null)

  // 点击外部 / 按 Esc 关闭下拉
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (projectMenuRef.current && !projectMenuRef.current.contains(e.target as Node)) {
        setProjectMenuOpen(false)
      }
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false)
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setProjectMenuOpen(false)
        setUserMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  async function openProjectMenu() {
    setProjectMenuOpen((v) => !v)
    if (!projects && !loading) {
      setLoading(true)
      try {
        const res = await api.get<{ projects: Project[] }>(
          '/api/projects',
          { suppressErrorToast: true } as ApiRequestConfig,
        )
        setProjects(res.data.projects || [])
      } catch {
        setProjects([])
      } finally {
        setLoading(false)
      }
    }
  }

  function logout() {
    clearAuthToken()
    try {
      localStorage.removeItem('current_user')
      localStorage.removeItem('current_tenant')
      localStorage.removeItem('current_project')
    } catch {}
    router.push('/login')
  }

  const projectLabel = currentProject?.name ?? currentProject?.slug ?? '加载中…'

  return (
    <header className="h-14 bg-white border-b border-gray-200 flex items-center px-4 gap-4 flex-shrink-0">
      {/* 左：项目切换器 */}
      <div ref={projectMenuRef} className="relative">
        <button
          onClick={openProjectMenu}
          className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50"
        >
          <div className="w-6 h-6 rounded bg-blue-100 flex items-center justify-center">
            <i className="fas fa-cube text-xs text-blue-600"></i>
          </div>
          <div className="text-left leading-tight">
            <div className="text-sm font-medium text-gray-900">{projectLabel}</div>
            {currentProject?.slug && (
              <div className="text-[10px] text-gray-400 font-mono">
                {currentProject.slug}
                {currentProject.user_role && ` · ${currentProject.user_role}`}
              </div>
            )}
          </div>
          <i className="fas fa-chevron-down text-[10px] text-gray-400 ml-1"></i>
        </button>

        {projectMenuOpen && (
          <div className="absolute top-full left-0 mt-1 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
            <div className="px-3 py-2 border-b border-gray-100">
              <div className="text-xs text-gray-500">切换项目</div>
            </div>
            {loading && (
              <div className="px-3 py-4 text-center text-xs text-gray-400">
                <i className="fas fa-spinner fa-spin mr-1"></i> 加载中…
              </div>
            )}
            {!loading && projects?.length === 0 && (
              <div className="px-3 py-4 text-center text-xs text-gray-400">
                你目前没有其他项目
              </div>
            )}
            {!loading && projects && projects.length > 0 && (
              <div className="max-h-72 overflow-y-auto">
                {projects.map((p) => {
                  const active = p.id === currentProject?.id
                  return (
                    <button
                      key={p.id}
                      onClick={() => {
                        setProjectMenuOpen(false)
                        if (!active) {
                          router.push(`/workspace/${p.id}`)
                        }
                      }}
                      className={`w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center justify-between ${
                        active ? 'bg-blue-50' : ''
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-gray-900 truncate">{p.name}</div>
                        <div className="text-[10px] text-gray-400 font-mono truncate">
                          {p.slug || `id=${p.id}`}
                        </div>
                      </div>
                      <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded ml-2 shrink-0">
                        {p.user_role}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
            <div className="border-t border-gray-100">
              <Link
                href="/workspace"
                onClick={() => setProjectMenuOpen(false)}
                className="block px-3 py-2 text-xs text-blue-600 hover:bg-gray-50"
              >
                <i className="fas fa-list mr-1.5"></i> 查看所有项目
              </Link>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1" />

      {/* 右：用户菜单 */}
      <div ref={userMenuRef} className="relative">
        <button
          onClick={() => setUserMenuOpen((v) => !v)}
          className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50"
        >
          <div className="w-7 h-7 rounded-full bg-gray-200 flex items-center justify-center text-xs text-gray-700 font-medium">
            {displayName[0]?.toUpperCase() ?? '?'}
          </div>
          <i className="fas fa-chevron-down text-[10px] text-gray-400"></i>
        </button>

        {userMenuOpen && (
          <div className="absolute top-full right-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
            <div className="px-3 py-2 border-b border-gray-100">
              <div className="text-sm text-gray-900 truncate">{displayName}</div>
              {currentUser?.email && (
                <div className="text-[11px] text-gray-500 truncate">{currentUser.email}</div>
              )}
              {currentUser?.is_superadmin && (
                <div className="text-[10px] text-amber-600 mt-0.5">平台超管</div>
              )}
            </div>
            {currentUser?.is_superadmin && (
              <>
                <Link
                  href="/workspace/platform-tokens"
                  onClick={() => setUserMenuOpen(false)}
                  className="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <i className="fas fa-robot mr-2"></i> 平台服务令牌
                </Link>
                <Link
                  href="/platform"
                  onClick={() => setUserMenuOpen(false)}
                  className="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <i className="fas fa-shield-alt mr-2"></i> 前往平台控制台
                </Link>
              </>
            )}
            <button
              onClick={logout}
              className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              <i className="fas fa-sign-out-alt mr-2"></i> 退出登录
            </button>
          </div>
        )}
      </div>
    </header>
  )
}
