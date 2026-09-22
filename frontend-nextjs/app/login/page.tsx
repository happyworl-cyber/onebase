'use client'

import { useState, useEffect, Suspense } from 'react'
import { useTranslations } from 'next-intl'
import LocaleSwitcher from '@/components/LocaleSwitcher'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAppStore } from '@/lib/store'
import { ssoAPI } from '@/lib/api'
import { setAuthToken, clearAuthToken, ensureCookieSyncedFromLocalStorage } from '@/lib/auth'
import axios from 'axios'

interface SsoProviderInfo {
  provider_type: string
  display_name: string
  authorize_url: string
  tenant_id: number
  tenant_name: string
}

// SSO 按钮统一为中性描边样式，只用图标本身的品牌色做识别 —— 满屏彩色实心按钮
// 会盖过页面唯一的强调色（登录按钮），与克制的整体风格冲突。
const providerIcons: Record<string, { icon: string; dot: string }> = {
  google: { icon: 'fab fa-google', dot: 'text-[#EA4335]' },
  facebook: { icon: 'fab fa-facebook-f', dot: 'text-[#1877F2]' },
  github: { icon: 'fab fa-github', dot: 'text-slate-900' },
  oidc: { icon: 'fas fa-key', dot: 'text-slate-500' },
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  )
}

function LoginPageInner() {
  const t = useTranslations('login')
  const router = useRouter()
  const searchParams = useSearchParams()
  const setCurrentUser = useAppStore(state => state.setCurrentUser)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [ssoLoading, setSsoLoading] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [ssoProviders, setSsoProviders] = useState<SsoProviderInfo[]>([])

  // 从 middleware 重定向时带过来的"原目标 URL"。仅放行同源相对路径，
  // 防止 ?next=https://evil.com 这种 open redirect。
  const nextParam = searchParams.get('next')
  const safeNext =
    nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//')
      ? nextParam
      : null
  const isExpiredSession = searchParams.get('session') === 'expired'

  // 跳转目标：优先 next（用户原本想去哪）；否则按角色分发
  // 注意：非超管的默认值现在是 /workspace（W1 spec §3.2.1），由 /workspace 页面
  //      再按项目数派 /workspace/<id> | /workspace | /workspace/no-projects。
  //      handleLogin 里如果拿到了 token 会主动做一次 /api/projects 直跳，省一次
  //      渲染 flash；这里只作为最后兜底（auto-redirect 路径不便发请求）。
  const targetAfterLogin = (isSuperadmin: boolean) =>
    safeNext ?? (isSuperadmin ? '/platform/organizations' : '/orgs')

  /**
   * 登录成功后统一走"浏览器级导航"而不是 App Router SPA push。
   *
   * 原因：受保护路由由 Next middleware 在服务端读 cookie 判定，若在 setAuthToken()
   * 后立刻 router.push，偶发会出现这次客户端导航仍沿用旧的未登录状态（表现为登录
   * 成功但停在 /login，刷新后才进去）。
   *
   * 用 window.location.assign/replace 触发整页导航，确保 cookie 已参与下一次请求。
   */
  const navigateAfterLogin = (target: string, mode: 'assign' | 'replace' = 'assign') => {
    if (typeof window === 'undefined') {
      router.push(target)
      return
    }
    if (mode === 'replace') {
      window.location.replace(target)
    } else {
      window.location.assign(target)
    }
  }

  // middleware 携带的"会话过期"提示
  useEffect(() => {
    if (isExpiredSession) {
      clearAuthToken()
      setError(t('sessionExpired'))
    }
  }, [isExpiredSession])

  // 老会话迁移：localStorage 有 token 但没 cookie 的用户，自动补 cookie
  // 并把他们送回原本要去的页面，避免上线本次改动后强制重新登录。
  useEffect(() => {
    if (isExpiredSession) return
    ensureCookieSyncedFromLocalStorage()
    if (typeof window !== 'undefined' && localStorage.getItem('token')) {
      const userStr = localStorage.getItem('current_user')
      let isSuperadmin = false
      let mustChangePassword = false
      try {
        if (userStr) {
          const parsed = JSON.parse(userStr)
          isSuperadmin = !!parsed.is_superadmin
          mustChangePassword = !!parsed.must_change_password
        }
      } catch {}
      if (mustChangePassword) {
        navigateAfterLogin('/change-password', 'replace')
        return
      }
      navigateAfterLogin(targetAfterLogin(isSuperadmin), 'replace')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isExpiredSession])

  // SSO 回调：落地租户选择（/orgs 会再按组织数派发）
  useEffect(() => {
    const token = searchParams.get('token')
    if (token) {
      setAuthToken(token)
      navigateAfterLogin(safeNext ?? '/orgs')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, router])

  // 加载可用的 SSO Provider
  useEffect(() => {
    ssoAPI.listPublicProviders().then(res => {
      setSsoProviders(res.data || [])
    }).catch(() => {})
  }, [])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      const response = await axios.post('/auth/login', { email, password })
      const { token, user } = response.data

      setAuthToken(token)
      setCurrentUser(user)

      // 内置默认账号首登：必须先改密，否则后端网关会 403 拦截所有业务端点。
      if (user.must_change_password) {
        navigateAfterLogin('/change-password')
        return
      }

      // 超管 / safeNext 路径维持原行为
      if (user.is_superadmin || safeNext) {
        navigateAfterLogin(targetAfterLogin(!!user.is_superadmin))
        return
      }

      // 非超管：按租户数派发（0 → 引导页；1 → 租户控制台；多 → 选择页）
      try {
        const orgsResp = await axios.get('/api/organizations', {
          headers: { Authorization: `Bearer ${token}` },
        })
        const list: Array<{ id: number }> = orgsResp.data?.organizations ?? []
        if (list.length === 0) {
          navigateAfterLogin('/workspace/no-projects')
        } else if (list.length === 1) {
          navigateAfterLogin(`/org/${list[0].id}`)
        } else {
          navigateAfterLogin('/orgs')
        }
      } catch {
        navigateAfterLogin('/orgs')
      }
    } catch (err: any) {
      setError(err.response?.data?.error || t('errorFallback'))
    } finally {
      setLoading(false)
    }
  }

  // 带上 provider 所属项目的 tenant_id 发起授权；登录后落地 /workspace，
  // 由 picker 按用户权限决定进入哪个项目。
  const handleSsoLogin = async (provider: SsoProviderInfo) => {
    const key = provider.provider_type
    setSsoLoading(key)
    setError('')

    try {
      // OAuth redirect_uri 指向前端回调页 /sso/callback；它拿到 code+state 后
      // 回 POST /auth/sso/exchange 完成换取（前端业务接入 + 后端 PKCE）。
      const res = await ssoAPI.authorize(
        provider.provider_type,
        provider.tenant_id,
        window.location.origin + '/sso/callback'
      )
      const { authorization_url } = res.data
      if (authorization_url) {
        window.location.href = authorization_url
      }
    } catch (err: any) {
      setError(err.response?.data?.error || t('errorFallback'))
      setSsoLoading(null)
    }
  }

  return (
    <div className="min-h-screen bg-[#FAFAFA] text-slate-900">
      {/* 语言切换：固定右上角，登录前即可切换 */}
      <div className="absolute right-4 top-4 z-10">
        <LocaleSwitcher />
      </div>
      <div className="mx-auto flex min-h-screen w-full max-w-[1440px] flex-col lg:flex-row">
        {/* 左：品牌与价值主张 */}
        <section className="flex flex-1 items-center px-8 py-16 lg:px-20">
          <div className="w-full max-w-xl">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900">
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <ellipse cx="12" cy="6" rx="8" ry="3" />
                  <path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6" />
                  <path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
                </svg>
              </span>
              <span className="text-lg font-semibold tracking-tight">{t('brand')}</span>
            </div>

            <h1 className="mt-14 text-[2.75rem] font-semibold leading-[1.15] tracking-tight text-slate-900 lg:text-[3.25rem]">
              {t('headline1')}
              <br />
              {t('headline2')}
            </h1>

            <p className="mt-6 max-w-md text-lg leading-relaxed text-slate-500">
              {t('subtitle')}
            </p>

            {/* 首条标记为 AI —— 这些能力都有对应实现：内置助手见 src/ai/mod.rs，
                MCP 工具见 src/mcp_tools.rs，工作流 LLM 节点见 src/workflow_llm.rs。 */}
            <dl className="mt-14 max-w-md">
              {[
                { key: 'ai', ai: true },
                { key: 'api' },
                { key: 'automation' },
                { key: 'governance' },
              ].map(({ key, ai }) => (
                <div key={key} className="border-t border-slate-200 py-4 first:border-t-0 first:pt-0">
                  <dt className="flex items-center gap-2 text-sm font-medium text-slate-900">
                    {t(`features.${key}.term`)}
                    {ai && (
                      <span className="rounded border border-primary-700/25 bg-primary-700/5 px-1.5 py-px text-[10px] font-semibold tracking-wide text-primary-700">
                        AI
                      </span>
                    )}
                  </dt>
                  <dd className="mt-1 text-sm leading-relaxed text-slate-500">{t(`features.${key}.desc`)}</dd>
                </div>
              ))}
            </dl>

            <p className="mt-8 max-w-md border-t border-slate-200 pt-4 text-xs leading-relaxed text-slate-400">
              {t('footnote')}
            </p>
          </div>
        </section>

        {/* 右：登录表单 */}
        <section className="flex w-full items-center justify-center border-t border-slate-200 bg-white px-8 py-16 lg:w-[520px] lg:border-l lg:border-t-0 lg:px-16">
          <div className="w-full max-w-sm">
            <h2 className="text-2xl font-semibold tracking-tight text-slate-900">{t('cardTitle')}</h2>
            <p className="mt-2 text-sm text-slate-500">{t('cardSubtitle')}</p>

            {/* SSO 登录 */}
            {ssoProviders.length > 0 && (
              <div className="mt-8 space-y-3">
                {ssoProviders.map((provider) => {
                  const style = providerIcons[provider.provider_type] || providerIcons.oidc
                  const key = provider.provider_type
                  return (
                    <button
                      key={key}
                      onClick={() => handleSsoLogin(provider)}
                      disabled={ssoLoading !== null}
                      className="flex h-11 w-full items-center justify-center gap-2.5 rounded-lg border border-slate-300 bg-white text-sm font-medium text-slate-700 transition-colors hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {ssoLoading === key ? (
                        <Spinner className="text-slate-400" />
                      ) : (
                        <i className={`${style.icon} ${style.dot} text-base`} />
                      )}
                      <span>{t('ssoButton', { provider: provider.display_name })}</span>
                    </button>
                  )
                })}

                <div className="relative py-2">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-slate-200" />
                  </div>
                  <div className="relative flex justify-center">
                    <span className="bg-white px-3 text-xs text-slate-400">{t('ssoDivider')}</span>
                  </div>
                </div>
              </div>
            )}

            {/* 邮箱密码登录 */}
            <form onSubmit={handleLogin} className="mt-8 space-y-5">
              <div>
                <label htmlFor="login-email" className="block text-sm font-medium text-slate-700">
                  {t('emailLabel')}
                </label>
                <input
                  id="login-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  placeholder={t('emailPlaceholder')}
                  className="mt-2 h-11 w-full rounded-lg border border-slate-300 bg-white px-3.5 text-sm text-slate-900 placeholder:text-slate-400 transition-colors focus:border-primary-700 focus:outline-none focus:ring-1 focus:ring-primary-700"
                />
              </div>

              <div>
                <label htmlFor="login-password" className="block text-sm font-medium text-slate-700">
                  {t('passwordLabel')}
                </label>
                <input
                  id="login-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  placeholder="••••••••"
                  className="mt-2 h-11 w-full rounded-lg border border-slate-300 bg-white px-3.5 text-sm text-slate-900 placeholder:text-slate-400 transition-colors focus:border-primary-700 focus:outline-none focus:ring-1 focus:ring-primary-700"
                />
              </div>

              {error && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700"
                >
                  <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0" fill="currentColor" aria-hidden="true">
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zM9 5a1 1 0 112 0v5a1 1 0 11-2 0V5zm1 9a1.25 1.25 0 100 2.5A1.25 1.25 0 0010 14z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span>{error}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary-700 text-sm font-medium text-white transition-colors hover:bg-primary-800 focus:outline-none focus:ring-2 focus:ring-primary-700 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? (
                  <>
                    <Spinner className="text-white" />
                    <span>{t('submitting')}</span>
                  </>
                ) : (
                  <span>{t('submit')}</span>
                )}
              </button>
            </form>
          </div>
        </section>
      </div>
    </div>
  )
}

/** 内联 spinner：登录页首屏不依赖 Font Awesome CDN，断网 / 内网部署也能正常显示。 */
function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg className={`h-4 w-4 animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M22 12a10 10 0 00-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}
