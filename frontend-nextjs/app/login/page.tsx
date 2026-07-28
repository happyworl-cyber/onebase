'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAppStore } from '@/lib/store'
import { ssoAPI } from '@/lib/api'
import { setAuthToken, ensureCookieSyncedFromLocalStorage } from '@/lib/auth'
import { BRAND } from '@/lib/brand'
import axios from 'axios'

interface SsoProviderInfo {
  provider_type: string
  display_name: string
  authorize_url: string
}

const providerIcons: Record<string, { icon: string; color: string; bg: string }> = {
  google: { icon: 'fab fa-google', color: 'text-white', bg: 'bg-red-500 hover:bg-red-600' },
  facebook: { icon: 'fab fa-facebook-f', color: 'text-white', bg: 'bg-blue-600 hover:bg-blue-700' },
  github: { icon: 'fab fa-github', color: 'text-white', bg: 'bg-gray-800 hover:bg-gray-900' },
  oidc: { icon: 'fas fa-key', color: 'text-white', bg: 'bg-indigo-500 hover:bg-indigo-600' },
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

  // 跳转目标：优先 next（用户原本想去哪）；否则按角色分发
  const targetAfterLogin = (isSuperadmin: boolean) =>
    safeNext ?? (isSuperadmin ? '/platform' : '/dashboard')

  // middleware 携带的"会话过期"提示
  useEffect(() => {
    if (searchParams.get('session') === 'expired') {
      setError('登录已过期，请重新登录')
    }
  }, [searchParams])

  // 老会话迁移：localStorage 有 token 但没 cookie 的用户，自动补 cookie
  // 并把他们送回原本要去的页面，避免上线本次改动后强制重新登录。
  useEffect(() => {
    ensureCookieSyncedFromLocalStorage()
    if (typeof window !== 'undefined' && localStorage.getItem('token')) {
      const userStr = localStorage.getItem('current_user')
      let isSuperadmin = false
      try {
        if (userStr) isSuperadmin = !!JSON.parse(userStr).is_superadmin
      } catch {}
      router.replace(targetAfterLogin(isSuperadmin))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // SSO 回调处理：如果 URL 带 token 参数则自动登录
  useEffect(() => {
    const token = searchParams.get('token')
    if (token) {
      setAuthToken(token)
      router.push(safeNext ?? '/dashboard')
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

      router.push(targetAfterLogin(!!user.is_superadmin))
    } catch (err: any) {
      setError(err.response?.data?.error || '登录失败')
    } finally {
      setLoading(false)
    }
  }

  const handleSsoLogin = async (providerType: string) => {
    setSsoLoading(providerType)
    setError('')

    try {
      const res = await ssoAPI.authorize(providerType, undefined, window.location.origin + '/login')
      const { authorization_url } = res.data
      if (authorization_url) {
        window.location.href = authorization_url
      }
    } catch (err: any) {
      setError(err.response?.data?.error || `${providerType} 登录失败`)
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
                <h1 className="text-4xl font-bold tracking-tight">{BRAND}</h1>
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
                return (
                  <button
                    key={provider.provider_type}
                    onClick={() => handleSsoLogin(provider.provider_type)}
                    disabled={ssoLoading !== null}
                    className={`w-full h-10 ${style.bg} ${style.color} font-medium rounded-lg 
                              flex items-center justify-center space-x-2 transition-all duration-200
                              disabled:opacity-50 disabled:cursor-not-allowed shadow-sm hover:shadow-md`}
                  >
                    {ssoLoading === provider.provider_type ? (
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
