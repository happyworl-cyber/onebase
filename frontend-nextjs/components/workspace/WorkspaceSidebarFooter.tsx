'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations, useLocale } from 'next-intl'
import { useAppStore, type Project } from '@/lib/store'
import api, { organizationAPI, type ApiRequestConfig } from '@/lib/api'
import { clearAuthToken } from '@/lib/auth'
import { LOCALES, LOCALE_LABELS, LOCALE_COOKIE, type Locale } from '@/i18n/config'

/**
 * 工作空间侧边栏底部：项目/租户切换器 + 用户菜单。
 *
 * 这两块原先分居通栏顶栏的左右两端（ProjectTopbar）。挪到侧边栏底部是为了：
 *   1. 与 /platform、/org 的侧边栏形态一致 —— 身份与上下文统一在左下角；
 *   2. 去掉 h-14 通栏后，内容区多出 56px 垂直空间；
 *   3. 「我是谁 / 我在哪个项目」两个同类信息聚在一起，不再对角分布。
 *
 * 位置在底部，所以下拉一律向上展开（bottom-full）。侧边栏只有 200px 宽，
 * 菜单比它宽、向右溢出覆盖在内容区上，属预期行为（z-50）。
 *
 * 安全说明：登出走 router.push('/login') 而不是 window.location.href，
 * 这样不会丢前端运行时（Next 路由切换 + axios 拦截器仍在）。token 已经
 * 通过 clearAuthToken 清掉，登录页会自己判定。
 */
export default function WorkspaceSidebarFooter() {
  const t = useTranslations('wsSidebarFooter')
  const locale = useLocale() as Locale
  const router = useRouter()
  const currentProject = useAppStore((s) => s.currentProject)
  const currentOrganization = useAppStore((s) => s.currentOrganization)
  const currentUser = useAppStore((s) => s.currentUser)
  // SSO 用户可能没有邮箱，优先用用户名兜底，避免头像/菜单显示成 "?"。
  const displayName = currentUser?.username || currentUser?.email || t('defaultUserName')

  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [loading, setLoading] = useState(false)
  // 用户可访问的租户数。null = 还没查过。
  const [orgCount, setOrgCount] = useState<number | null>(null)

  const orgId = currentOrganization?.id ?? currentProject?.organization_id ?? null
  const rawOrgLabel = currentOrganization?.name ?? currentProject?.organization_name ?? null

  const projectMenuRef = useRef<HTMLDivElement>(null)
  const userMenuRef = useRef<HTMLDivElement>(null)

  // 切换组织后清空缓存，避免下拉仍显示上一租户的项目
  useEffect(() => {
    setProjects(null)
  }, [orgId])

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
    setUserMenuOpen(false)
    if (!projects && !loading) {
      setLoading(true)
      try {
        const res = await api.get<{ projects: Project[] }>('/api/projects', {
          params: orgId ? { organization_id: orgId } : undefined,
          suppressErrorToast: true,
        } as ApiRequestConfig)
        setProjects(res.data.projects || [])
      } catch {
        setProjects([])
      } finally {
        setLoading(false)
      }
    }
    // 租户数决定「切换租户」是否有意义 —— 只有 1 个租户时该入口会跳到 /orgs
    // 再被立刻 replace 回来（见 app/orgs/page.tsx），点了等于没反应。
    if (orgCount === null) {
      organizationAPI
        .list()
        .then((r) => setOrgCount((r.data.organizations || []).length))
        .catch(() => setOrgCount(0))
    }
  }

  function chooseLocale(next: Locale) {
    setUserMenuOpen(false)
    if (next === locale) return
    // max-age 一年；path=/ 让所有页面共享；改 cookie 后 router.refresh() 让服务端按新语言重渲
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`
    router.refresh()
  }

  function logout() {
    clearAuthToken()
    try {
      localStorage.removeItem('current_user')
      localStorage.removeItem('current_tenant')
      localStorage.removeItem('current_project')
      localStorage.removeItem('current_organization')
    } catch {}
    router.push('/login')
  }

  const projectLabel = currentProject?.name ?? currentProject?.slug ?? t('loadingEllipsis')
  // 租户与项目同名时（常见于"一租户一项目"的小团队）不重复显示，否则切换器里
  // 会出现两行一模一样的文字，白占 200px 侧栏的高度。
  const orgLabel = rawOrgLabel && rawOrgLabel !== projectLabel ? rawOrgLabel : null

  return (
    <div className="shrink-0 border-t border-gray-200 bg-white">
      {/* ── 项目 / 租户切换器 ───────────────────────────── */}
      <div ref={projectMenuRef} className="relative px-2 pt-2">
        <button
          onClick={openProjectMenu}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-gray-50"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-blue-100">
            <i className="fas fa-cube text-[11px] text-blue-600" />
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            {orgLabel && (
              <span className="block truncate text-[10px] text-gray-400">{orgLabel}</span>
            )}
            <span className="block truncate text-[13px] font-medium text-gray-900">
              {projectLabel}
            </span>
          </span>
          <i
            className={`fas fa-chevron-down shrink-0 text-[10px] text-gray-400 transition-transform ${
              projectMenuOpen ? 'rotate-180' : ''
            }`}
          />
        </button>

        {projectMenuOpen && (
          <div className="absolute bottom-full left-2 z-50 mb-1 w-72 rounded-lg border border-gray-200 bg-white shadow-lg">
            <div className="border-b border-gray-100 px-3 py-2">
              <div className="text-xs text-gray-500">
                {rawOrgLabel ? t('switchProjectWithOrg', { org: rawOrgLabel }) : t('switchProject')}
              </div>
            </div>
            {loading && (
              <div className="px-3 py-4 text-center text-xs text-gray-400">
                <i className="fas fa-spinner fa-spin mr-1" /> {t('loadingEllipsis')}
              </div>
            )}
            {!loading && projects?.length === 0 && (
              <div className="px-3 py-4 text-center text-xs text-gray-400">
                {t('noOtherProjects')}
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
                      className={`flex w-full items-center justify-between px-3 py-2 text-left hover:bg-gray-50 ${
                        active ? 'bg-blue-50' : ''
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-gray-900">{p.name}</div>
                        <div className="truncate font-mono text-[10px] text-gray-400">
                          {p.slug || `id=${p.id}`}
                        </div>
                      </div>
                      <span className="ml-2 shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">
                        {p.user_role}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
            <div className="border-t border-gray-100">
              <Link
                href={orgId ? `/org/${orgId}` : '/orgs'}
                onClick={() => setProjectMenuOpen(false)}
                className="block px-3 py-2 text-xs text-blue-600 hover:bg-gray-50"
              >
                <i className="fas fa-building mr-1.5" /> {t('backToOrgConsole')}
              </Link>
              {/* 超管的跨租户入口是平台控制台（在下方用户菜单里），不是这里；
                  普通用户只有在真的拥有多个租户时，这个入口才有意义。 */}
              {!currentUser?.is_superadmin && (orgCount ?? 0) > 1 && (
                <Link
                  href="/orgs"
                  onClick={() => {
                    setProjectMenuOpen(false)
                    try {
                      localStorage.removeItem('current_organization')
                    } catch {}
                  }}
                  className="block px-3 py-2 text-xs text-gray-600 hover:bg-gray-50"
                >
                  <i className="fas fa-exchange-alt mr-1.5" /> {t('switchOrg')}
                </Link>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── 用户菜单 ─────────────────────────────────── */}
      <div ref={userMenuRef} className="relative px-2 pb-2 pt-1">
        <button
          onClick={() => {
            setUserMenuOpen((v) => !v)
            setProjectMenuOpen(false)
          }}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-gray-50"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-200 text-xs font-medium text-gray-700">
            {displayName[0]?.toUpperCase() ?? '?'}
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-xs font-medium text-gray-900">{displayName}</span>
            <span className="block truncate text-[11px] text-gray-500">
              {currentUser?.is_superadmin ? t('platformSuperadmin') : currentProject?.user_role || t('member')}
            </span>
          </span>
          <i
            className={`fas fa-chevron-down shrink-0 text-[10px] text-gray-400 transition-transform ${
              userMenuOpen ? 'rotate-180' : ''
            }`}
          />
        </button>

        {userMenuOpen && (
          <div className="absolute bottom-full left-2 right-2 z-50 mb-1 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
            <div className="border-b border-gray-100 px-3 py-2">
              <div className="truncate text-sm text-gray-900">{displayName}</div>
              {currentUser?.email && (
                <div className="truncate text-[11px] text-gray-500">{currentUser.email}</div>
              )}
            </div>
            {currentUser?.is_superadmin && (
              <>
                <Link
                  href="/workspace/platform-tokens"
                  onClick={() => setUserMenuOpen(false)}
                  className="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <i className="fas fa-robot mr-2 w-4 text-gray-400" /> {t('platformServiceTokens')}
                </Link>
                <Link
                  href="/platform"
                  onClick={() => setUserMenuOpen(false)}
                  className="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <i className="fas fa-shield-alt mr-2 w-4 text-gray-400" /> {t('goToPlatformConsole')}
                </Link>
              </>
            )}
            <Link
              href="/account"
              onClick={() => setUserMenuOpen(false)}
              className="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              <i className="fas fa-user-cog mr-2 w-4 text-gray-400" /> {t('accountSettings')}
            </Link>
            <div className="border-t border-gray-100 px-3 pb-1 pt-2">
              <div className="mb-1 flex items-center text-[11px] font-medium uppercase tracking-wide text-gray-400">
                <i className="fas fa-language mr-2 w-4 text-gray-400" /> {t('language')}
              </div>
              <div className="flex flex-wrap gap-1 pb-1 pl-6">
                {LOCALES.map((l) => (
                  <button
                    key={l}
                    onClick={() => chooseLocale(l)}
                    className={`rounded px-2 py-1 text-xs transition-colors ${
                      l === locale
                        ? 'bg-blue-50 font-medium text-blue-700'
                        : 'text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {LOCALE_LABELS[l]}
                  </button>
                ))}
              </div>
            </div>
            <button
              onClick={logout}
              className="w-full border-t border-gray-100 px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
            >
              <i className="fas fa-sign-out-alt mr-2 w-4" /> {t('logout')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
