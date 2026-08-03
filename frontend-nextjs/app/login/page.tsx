'use client'

import { useState, useEffect, Suspense } from 'react'
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

const providerIcons: Record<string, { icon: string; color: string; bg: string }> = {
  google: { icon: 'fab fa-google', color: 'text-white', bg: 'bg-red-500 hover:bg-red-600' },
  facebook: { icon: 'fab fa-facebook-f', color: 'text-white', bg: 'bg-blue-600 hover:bg-blue-700' },
  github: { icon: 'fab fa-github', color: 'text-white', bg: 'bg-gray-800 hover:bg-gray-900' },
  oidc: { icon: 'fas fa-key', color: 'text-white', bg: 'bg-indigo-500 hover:bg-indigo-600' },
  mind: { icon: 'fas fa-brain', color: 'text-white', bg: 'bg-emerald-600 hover:bg-emerald-700' },
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  )
}

function LoginPageInner() {
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
    safeNext ?? (isSuperadmin ? '/platform' : '/workspace')

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
      setError('登录已过期，请重新登录')
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

  // SSO 回调处理：如果 URL 带 token 参数则自动登录
  // SSO 回来时还不知道 is_superadmin（没经过 /auth/login 拿 user 字段），
  // 简单兜底走 /workspace；超管会被 /workspace picker 直接发回 /platform
  // （picker 拿到空列表后会在 superadmin 分支显示"前往 /platform"的引导）。
  useEffect(() => {
    const token = searchParams.get('token')
    if (token) {
      setAuthToken(token)
      navigateAfterLogin(safeNext ?? '/workspace')
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

      // 非超管：用新 token 立刻查一下项目数，直接派最终页面，避免先去 /workspace
      // 再 replace 一跳的视觉 flash（spec §3.2.1）。失败兜底回 /workspace 让
      // picker 自己再试一遍。
      try {
        const projectsResp = await axios.get('/api/projects', {
          headers: { Authorization: `Bearer ${token}` },
        })
        const list: Array<{ id: number }> = projectsResp.data?.projects ?? []
        if (list.length === 0) {
          navigateAfterLogin('/workspace/no-projects')
        } else if (list.length === 1) {
          navigateAfterLogin(`/workspace/${list[0].id}`)
        } else {
          navigateAfterLogin('/workspace')
        }
      } catch {
        navigateAfterLogin('/workspace')
      }
    } catch (err: any) {
      setError(err.response?.data?.error || '登录失败')
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
      setError(err.response?.data?.error || `${provider.display_name} 登录失败`)
      setSsoLoading(null)
    }
  }

  return (
    <div className="min-h-screen flex bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500">
      {/* 左侧品牌展示 */}
      <div className="flex-1 flex items-center justify-center p-8 lg:p-16">
        <div className="text-white max-w-lg space-y-8">
          <div className="space-y-6">
            <div className="flex items-center space-x-4 group">
              <div className="w-14 h-14 bg-white/10 backdrop-blur-lg rounded-xl flex items-center justify-center 
                            shadow-2xl transform transition-all duration-300 group-hover:scale-110 group-hover:rotate-3
                            border border-white/20">
                <i className="fas fa-database text-3xl text-white"></i>
              </div>
              <div>
                <h1 className="text-4xl font-bold tracking-tight">OneBase</h1>
                <p className="text-sm opacity-90 font-light">Zero-Code Data Gateway</p>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <h2 className="text-3xl font-semibold leading-tight">
              企业级数据网关<br />统一管理平台
            </h2>
            <p className="text-lg opacity-90 leading-relaxed font-light">
              支持 RBAC 权限引擎、分布式缓存、SSO 社交登录，帮助企业零代码构建数据服务。
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {['Auto API', 'RBAC 权限', 'Redis 缓存', 'SSO 登录'].map((feature, idx) => (
              <div
                key={idx}
                className="flex items-center space-x-3 bg-white/10 backdrop-blur-sm rounded-lg p-3 
                          transition-all duration-300 hover:bg-white/20 hover:scale-105 cursor-default"
              >
                <div className="w-8 h-8 bg-white/20 rounded-lg flex items-center justify-center">
                  <i className={`fas fa-${['bolt', 'shield-alt', 'memory', 'sign-in-alt'][idx]} text-sm`}></i>
                </div>
                <span className="text-sm font-medium">{feature}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 右侧登录表单 */}
      <div className="w-full lg:w-[480px] bg-white flex items-center justify-center p-8 shadow-2xl">
        <div className="w-full max-w-sm space-y-6">
          <div className="space-y-2">
            <h3 className="text-2xl font-semibold text-gray-800">登录账户</h3>
            <p className="text-sm text-gray-500">欢迎回来，请登录您的账户</p>
          </div>

          {/* SSO 登录按钮 */}
          {ssoProviders.length > 0 && (
            <div className="space-y-3">
              {ssoProviders.map((provider) => {
                const style = providerIcons[provider.provider_type] || providerIcons.oidc
                // 每种 SSO 只有一个统一入口（后端按 provider_type 去重）。
                // 登录后进入哪个项目由用户权限决定（/workspace picker），入口不区分项目。
                const key = provider.provider_type
                return (
                  <button
                    key={key}
                    onClick={() => handleSsoLogin(provider)}
                    disabled={ssoLoading !== null}
                    className={`w-full h-10 ${style.bg} ${style.color} font-medium rounded-lg 
                              flex items-center justify-center space-x-2 transition-all duration-200
                              disabled:opacity-50 disabled:cursor-not-allowed shadow-sm hover:shadow-md`}
                  >
                    {ssoLoading === key ? (
                      <i className="fas fa-spinner fa-spin"></i>
                    ) : (
                      <i className={style.icon}></i>
                    )}
                    <span>{provider.display_name} 登录</span>
                  </button>
                )
              })}

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-gray-200"></div>
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="px-3 bg-white text-gray-400">或使用邮箱密码</span>
                </div>
              </div>
            </div>
          )}

          {/* 邮箱密码登录 */}
          <form onSubmit={handleLogin} className="space-y-5">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">邮箱地址</label>
              <div className="relative">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  className="w-full input-with-icon pl-10"
                  placeholder="请输入邮箱地址"
                />
                <i className="fas fa-envelope absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none"></i>
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">密码</label>
              <div className="relative">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="w-full input-with-icon pl-10"
                  placeholder="请输入密码"
                />
                <i className="fas fa-lock absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none"></i>
              </div>
            </div>

            {error && (
              <div className="flex items-start space-x-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded p-3">
                <i className="fas fa-exclamation-circle mt-0.5"></i>
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full h-10 bg-primary-500 hover:bg-primary-400 active:bg-primary-600 
                       text-white font-medium rounded-lg shadow-lg hover:shadow-xl
                       transform transition-all duration-200 hover:-translate-y-0.5
                       focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2
                       disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
            >
              {loading ? (
                <span className="flex items-center justify-center space-x-2">
                  <i className="fas fa-spinner fa-spin"></i>
                  <span>登录中...</span>
                </span>
              ) : (
                <span className="flex items-center justify-center space-x-2">
                  <span>登录</span>
                  <i className="fas fa-arrow-right text-sm"></i>
                </span>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
