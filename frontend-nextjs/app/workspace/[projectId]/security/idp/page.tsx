'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import Drawer from '@/components/Drawer'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'
import {
  idpAPI,
  type CreateOauth2ClientBody,
  type CreateProjectIdpProviderBody,
  type IdpSessionRecord,
  type IdpLoginLog,
  type IdpClientProviderToggle,
  type Oauth2ClientRecord,
  type ProjectIdpProvider,
  type UpdateOauth2ClientBody,
  type UpdateProjectIdpProviderBody,
} from '@/lib/api'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import { useNotification } from '@/hooks/useNotification'

type TabKey = 'vault' | 'apps' | 'logs' | 'audit'

type ProviderKey = 'google' | 'apple' | 'facebook' | 'github' | 'oidc' | 'mind'

interface ProviderMeta {
  key: ProviderKey
  label: string
  subtitle: string
  iconClass: string
  iconBgClass: string
  callbackHint: string
}

const PROVIDERS: ProviderMeta[] = [
  { key: 'google', label: 'Google', subtitle: 'OAuth 2.0', iconClass: 'fab fa-google', iconBgClass: 'bg-red-50 text-red-500', callbackHint: '在 Google Cloud Console 填写以下回调地址：' },
  { key: 'apple', label: 'Apple', subtitle: 'Sign in with Apple', iconClass: 'fab fa-apple', iconBgClass: 'bg-gray-900 text-white', callbackHint: '在 Apple Developer 的 Sign in with Apple 配置中填写以下回调地址：' },
  { key: 'facebook', label: 'Facebook', subtitle: 'Meta Login', iconClass: 'fab fa-facebook-f', iconBgClass: 'bg-blue-600 text-white', callbackHint: '在 Meta for Developers 中填写以下 OAuth 回调地址：' },
  { key: 'github', label: 'GitHub', subtitle: 'OAuth 2.0', iconClass: 'fab fa-github', iconBgClass: 'bg-gray-100 text-gray-800', callbackHint: '在 GitHub OAuth App 的 Authorization callback URL 中填写：' },
  { key: 'oidc', label: '自定义 OIDC', subtitle: 'OpenID Connect', iconClass: 'fas fa-id-badge', iconBgClass: 'bg-indigo-100 text-indigo-600', callbackHint: '若上游 OIDC 需要固定回调地址，请登记以下地址：' },
  { key: 'mind', label: 'Mind', subtitle: 'Mind SSO', iconClass: 'fas fa-brain', iconBgClass: 'bg-emerald-100 text-emerald-600', callbackHint: '在 Mind SSO 控制台中填写以下回调地址：' },
]

interface ProviderFormState {
  provider_type: ProviderKey
  display_name: string
  client_id: string
  client_secret: string
  is_enabled: boolean
  oidcAuthorizationUrl: string
  oidcTokenUrl: string
  oidcUserinfoUrl: string
  oidcScopes: string
  appleTeamId: string
  appleKeyId: string
  applePrivateKeyPem: string
}

interface AppFormState {
  clientId: string | null
  displayName: string
  redirectUrisText: string
  allowedScopesText: string
  accessTokenTtl: string
  refreshTokenTtl: string
  requirePkce: boolean
  isActive: boolean
  enabledProviders: Record<string, boolean>
}

const DEFAULT_ALLOWED_SCOPES = 'openid\nemail\nprofile'

function emptyProviderForm(providerType: ProviderKey): ProviderFormState {
  return {
    provider_type: providerType,
    display_name: PROVIDERS.find((p) => p.key === providerType)?.label || providerType,
    client_id: '',
    client_secret: '',
    is_enabled: true,
    oidcAuthorizationUrl: '',
    oidcTokenUrl: '',
    oidcUserinfoUrl: '',
    oidcScopes: 'openid email profile',
    appleTeamId: '',
    appleKeyId: '',
    applePrivateKeyPem: '',
  }
}

function emptyAppForm(): AppFormState {
  return {
    clientId: null,
    displayName: '',
    redirectUrisText: '',
    allowedScopesText: DEFAULT_ALLOWED_SCOPES,
    accessTokenTtl: '900',
    refreshTokenTtl: '2592000',
    requirePkce: true,
    isActive: true,
    enabledProviders: {},
  }
}

function parseMultilineList(input: string): string[] {
  return input
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function backendBaseUrl(): string {
  // issuer 必须指向对外可达的后端地址。取值优先级：
  //   1. 显式构建期变量 NEXT_PUBLIC_IDP_ISSUER / NEXT_PUBLIC_API_URL（生产/前后端分域时由运维设定）；
  //   2. 本地开发（localhost/127.0.0.1）：前端 3006、后端 3000 分端口，issuer 用 :3000；
  //   3. 其它（部署环境、通常前后端同域反代）：用当前访问来源 origin，
  //      从而"访问哪个域名/IP 就显示哪个"，不会再烤死成 127.0.0.1。
  const explicit = (process.env.NEXT_PUBLIC_IDP_ISSUER || process.env.NEXT_PUBLIC_API_URL || '').trim()
  if (explicit) {
    return explicit.replace(/\/$/, '')
  }
  if (typeof window !== 'undefined') {
    const { protocol, hostname, origin } = window.location
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return `${protocol}//${hostname}:3000`
    }
    return origin.replace(/\/$/, '')
  }
  return ''
}

function getProviderMeta(providerType: string): ProviderMeta | undefined {
  return PROVIDERS.find((provider) => provider.key === providerType)
}

/** 预设 scope；openid 为 OIDC 必选，不可移除。 */
const PRESET_SCOPES = ['openid', 'email', 'profile'] as const

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: 'vault', label: 'Provider 凭证库', icon: 'fas fa-vault' },
  { key: 'apps', label: 'OAuth2 应用', icon: 'fas fa-table-cells-large' },
  { key: 'logs', label: '活跃 Session', icon: 'fas fa-user-clock' },
  { key: 'audit', label: '登录日志', icon: 'fas fa-scroll' },
]

/** 设计稿同款的滑动开关（替代裸 checkbox）。 */
function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${
        disabled
          ? 'cursor-not-allowed bg-gray-200 opacity-60'
          : checked
            ? 'bg-blue-500'
            : 'bg-gray-300'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  )
}

export default function ProjectIdpPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const caps = useCurrentProjectCapabilities()
  const notify = useNotification()

  const [tab, setTab] = useState<TabKey>('vault')
  const [loading, setLoading] = useState(true)
  const [providers, setProviders] = useState<ProjectIdpProvider[]>([])
  const [clients, setClients] = useState<Oauth2ClientRecord[]>([])
  const [sessions, setSessions] = useState<IdpSessionRecord[]>([])
  const [revokingFamilyId, setRevokingFamilyId] = useState<string | null>(null)
  const [logs, setLogs] = useState<IdpLoginLog[]>([])
  const [logSearch, setLogSearch] = useState('')
  const [logProvider, setLogProvider] = useState('')
  const [logClient, setLogClient] = useState('')
  const [guideOpen, setGuideOpen] = useState(false)
  const [guideTab, setGuideTab] = useState<'steps' | 'discovery' | 'sdk'>('steps')
  const [sdkTab, setSdkTab] = useState<'nextjs' | 'python' | 'ios' | 'android'>('nextjs')

  const [providerDrawerOpen, setProviderDrawerOpen] = useState(false)
  const [providerSaving, setProviderSaving] = useState(false)
  const [providerForm, setProviderForm] = useState<ProviderFormState>(emptyProviderForm('google'))

  const [appDrawerOpen, setAppDrawerOpen] = useState(false)
  const [appSaving, setAppSaving] = useState(false)
  const [appForm, setAppForm] = useState<AppFormState>(emptyAppForm())
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null)
  const [scopeInput, setScopeInput] = useState('')

  // 顶部 tab 的滑动下划线：根据激活 tab 的位置/宽度做过渡
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [indicator, setIndicator] = useState<{ left: number; width: number }>({ left: 0, width: 0 })
  useEffect(() => {
    const el = tabRefs.current[tab]
    if (el) setIndicator({ left: el.offsetLeft, width: el.offsetWidth })
  }, [tab])

  const providerMap = useMemo(
    () => new Map(providers.map((provider) => [provider.provider_type, provider])),
    [providers],
  )

  const load = async (silent = false) => {
    if (!Number.isFinite(projectId)) return
    if (!silent) setLoading(true)
    try {
      const [providerRes, clientRes, sessionRes, logRes] = await Promise.all([
        idpAPI.listProviders(projectId),
        idpAPI.listClients(projectId),
        idpAPI.listSessions(projectId),
        idpAPI.listLogs(projectId),
      ])
      setProviders(providerRes.data)
      setClients(clientRes.data)
      setSessions(sessionRes.data)
      setLogs(logRes.data)
    } catch (err: any) {
      notify.error(err)
    } finally {
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => {
    if (caps.canManageSecurity && Number.isFinite(projectId)) {
      load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, caps.canManageSecurity])

  // 切换 tab 时静默刷新数据（首帧跳过，避免与挂载加载重复拉取）。
  const didMountRef = useRef(false)
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }
    if (caps.canManageSecurity && Number.isFinite(projectId)) {
      load(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  const openProviderDrawer = (providerType: ProviderKey) => {
    const existing = providerMap.get(providerType)
    setProviderForm(
      existing
        ? {
            provider_type: providerType,
            display_name: existing.display_name,
            client_id: existing.client_id,
            client_secret: '',
            is_enabled: existing.is_enabled,
            oidcAuthorizationUrl: existing.provider_config?.authorization_url || '',
            oidcTokenUrl: existing.provider_config?.token_url || '',
            oidcUserinfoUrl: existing.provider_config?.userinfo_url || '',
            oidcScopes: existing.provider_config?.scopes || 'openid email profile',
            appleTeamId: existing.provider_config?.team_id || '',
            appleKeyId: existing.provider_config?.key_id || '',
            // 私钥作为加密的 client_secret 存储，永不回传；编辑时留空表示保留原值。
            applePrivateKeyPem: '',
          }
        : emptyProviderForm(providerType),
    )
    setProviderDrawerOpen(true)
  }

  const jumpToProviderVault = (providerType: ProviderKey) => {
    setTab('vault')
    closeAppDrawer()
    window.setTimeout(() => openProviderDrawer(providerType), 0)
  }

  const closeProviderDrawer = () => {
    if (providerSaving) return
    setProviderDrawerOpen(false)
    // 延迟到抽屉关闭动画结束后再重置表单，避免关闭瞬间闪现默认（Google）配置内容
    window.setTimeout(() => setProviderForm(emptyProviderForm('google')), 320)
  }

  const openAppDrawerForCreate = () => {
    setRevealedSecret(null)
    setAppForm(emptyAppForm())
    setAppDrawerOpen(true)
  }

  const openAppDrawerForEdit = (client: Oauth2ClientRecord) => {
    const enabledProviders: Record<string, boolean> = {}
    for (const provider of client.providers || []) {
      enabledProviders[provider.provider_type] = !!provider.is_enabled
    }
    setRevealedSecret(null)
    setAppForm({
      clientId: client.client_id,
      displayName: client.display_name,
      redirectUrisText: client.redirect_uris.join('\n'),
      allowedScopesText: client.allowed_scopes.join('\n'),
      accessTokenTtl: String(client.access_token_ttl),
      refreshTokenTtl: String(client.refresh_token_ttl),
      requirePkce: client.require_pkce,
      isActive: client.is_active,
      enabledProviders,
    })
    setAppDrawerOpen(true)
  }

  const closeAppDrawer = () => {
    if (appSaving) return
    setAppDrawerOpen(false)
    // 同上：等关闭动画结束再清表单，避免闪现默认内容
    window.setTimeout(() => {
      setAppForm(emptyAppForm())
      setRevealedSecret(null)
    }, 320)
  }

  const handleSaveProvider = async () => {
    if (!providerForm.client_id.trim()) {
      notify.warning('请填写 Client ID')
      return
    }

    const isApple = providerForm.provider_type === 'apple'
    const providerConfig: Record<string, any> = {}
    if (providerForm.provider_type === 'oidc') {
      if (providerForm.oidcAuthorizationUrl.trim()) providerConfig.authorization_url = providerForm.oidcAuthorizationUrl.trim()
      if (providerForm.oidcTokenUrl.trim()) providerConfig.token_url = providerForm.oidcTokenUrl.trim()
      if (providerForm.oidcUserinfoUrl.trim()) providerConfig.userinfo_url = providerForm.oidcUserinfoUrl.trim()
      if (providerForm.oidcScopes.trim()) providerConfig.scopes = providerForm.oidcScopes.trim()
    }
    if (isApple) {
      if (providerForm.appleTeamId.trim()) providerConfig.team_id = providerForm.appleTeamId.trim()
      if (providerForm.appleKeyId.trim()) providerConfig.key_id = providerForm.appleKeyId.trim()
    }
    // Apple 无静态 client_secret：把 .p8 私钥作为 client_secret 传给后端（后端加密存储、
    // 每次换 token 时用它 + Team ID/Key ID 现签 ES256 JWT）。
    const clientSecretValue = isApple
      ? providerForm.applePrivateKeyPem.trim()
      : providerForm.client_secret.trim()
    const secretLabel = isApple ? 'Apple 私钥 (.p8)' : 'Client Secret'

    const existing = providerMap.get(providerForm.provider_type)
    if (isApple && !existing && (!providerForm.appleTeamId.trim() || !providerForm.appleKeyId.trim())) {
      notify.warning('Apple 需要填写 Team ID 与 Key ID')
      return
    }
    setProviderSaving(true)
    try {
      if (existing) {
        const payload: UpdateProjectIdpProviderBody = {
          display_name: providerForm.display_name.trim() || undefined,
          client_id: providerForm.client_id.trim(),
          client_secret: clientSecretValue || undefined,
          is_enabled: providerForm.is_enabled,
          provider_config: Object.keys(providerConfig).length ? providerConfig : undefined,
        }
        await idpAPI.updateProvider(projectId, providerForm.provider_type, payload)
        notify.success(`${providerForm.display_name || providerForm.provider_type} 凭证已更新`)
      } else {
        if (!clientSecretValue) {
          notify.warning(`首次配置必须填写 ${secretLabel}`)
          return
        }
        const payload: CreateProjectIdpProviderBody = {
          provider_type: providerForm.provider_type,
          display_name: providerForm.display_name.trim() || undefined,
          client_id: providerForm.client_id.trim(),
          client_secret: clientSecretValue,
          is_enabled: providerForm.is_enabled,
          provider_config: Object.keys(providerConfig).length ? providerConfig : undefined,
        }
        await idpAPI.createProvider(projectId, payload)
        notify.success(`${providerForm.display_name || providerForm.provider_type} 凭证已创建`)
      }
      closeProviderDrawer()
      load()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setProviderSaving(false)
    }
  }

  const normalizeAppPayload = (): CreateOauth2ClientBody | UpdateOauth2ClientBody | null => {
    const redirectUris = parseMultilineList(appForm.redirectUrisText)
    const allowedScopes = parseMultilineList(appForm.allowedScopesText)
    if (!appForm.displayName.trim()) {
      notify.warning('请填写应用名称')
      return null
    }
    if (redirectUris.length === 0) {
      notify.warning('请至少填写一个回调地址')
      return null
    }
    const accessTokenTtl = Number(appForm.accessTokenTtl)
    const refreshTokenTtl = Number(appForm.refreshTokenTtl)
    if (!Number.isFinite(accessTokenTtl) || !Number.isFinite(refreshTokenTtl)) {
      notify.warning('Token TTL 必须是数字')
      return null
    }
    return {
      display_name: appForm.displayName.trim(),
      redirect_uris: redirectUris,
      allowed_scopes: allowedScopes.length ? allowedScopes : ['openid', 'email', 'profile'],
      access_token_ttl: accessTokenTtl,
      refresh_token_ttl: refreshTokenTtl,
      require_pkce: appForm.requirePkce,
      is_active: appForm.isActive,
    }
  }

  // 只提交「已在项目凭证库配置」的 provider——后端会拒绝未配置的 provider_type（如未配的 apple）。
  const selectedClientProviders = (): IdpClientProviderToggle[] =>
    PROVIDERS.filter((provider) => providerMap.has(provider.key)).map((provider) => ({
      provider_type: provider.key,
      is_enabled: !!appForm.enabledProviders[provider.key],
    }))

  const handleSaveApp = async () => {
    const payload = normalizeAppPayload()
    if (!payload) return

    setAppSaving(true)
    try {
      if (appForm.clientId) {
        await idpAPI.updateClient(projectId, appForm.clientId, payload as UpdateOauth2ClientBody)
        await idpAPI.replaceClientProviders(projectId, appForm.clientId, selectedClientProviders())
        notify.success('OAuth2 应用已更新')
      } else {
        const res = await idpAPI.createClient(projectId, payload as CreateOauth2ClientBody)
        const clientId = res.data.client_id
        // 先记下 clientId：即便后续设置 provider 开关失败，再次点击也走「更新」而非重复创建。
        setAppForm((prev) => ({ ...prev, clientId }))
        setRevealedSecret(res.data.client_secret)
        await idpAPI.replaceClientProviders(projectId, clientId, selectedClientProviders())
        notify.success('OAuth2 应用已创建')
      }
      await load()
      if (appForm.clientId) closeAppDrawer()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setAppSaving(false)
    }
  }

  const handleRotateSecret = async () => {
    if (!appForm.clientId) return
    try {
      const res = await idpAPI.rotateClientSecret(projectId, appForm.clientId)
      setRevealedSecret(res.data.client_secret)
      notify.success('Client Secret 已轮换，请立即保存')
    } catch (err: any) {
      notify.error(err)
    }
  }

  const toggleAppProvider = (providerType: string, enabled: boolean) => {
    setAppForm((prev) => ({
      ...prev,
      enabledProviders: {
        ...prev.enabledProviders,
        [providerType]: enabled,
      },
    }))
  }

  // ── Allowed Scopes：以 chip 形式管理（openid 必选不可移除）──
  const appScopes = parseMultilineList(appForm.allowedScopesText)
  const setScopes = (list: string[]) => {
    const deduped = Array.from(new Set(['openid', ...list.filter((s) => s.trim())]))
    setAppForm((prev) => ({ ...prev, allowedScopesText: deduped.join('\n') }))
  }
  const toggleScope = (scope: string, on: boolean) => {
    if (scope === 'openid') return // 必选
    setScopes(on ? [...appScopes, scope] : appScopes.filter((s) => s !== scope))
  }
  const addCustomScope = () => {
    const s = scopeInput.trim()
    if (!s) return
    if (!/^[A-Za-z0-9_.:-]+$/.test(s)) {
      notify.warning('scope 仅支持字母、数字及 _ . : -')
      return
    }
    setScopes([...appScopes, s])
    setScopeInput('')
  }

  const copyText = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      notify.success('已复制到剪贴板')
    } catch {
      notify.warning('复制失败，请手动复制')
    }
  }

  const handleRevokeSession = async (familyId: string) => {
    const ok = window.confirm('确定踢出这个活跃 Session 吗？被踢出的第三方登录会话将无法继续刷新。')
    if (!ok) return
    setRevokingFamilyId(familyId)
    try {
      await idpAPI.revokeSession(projectId, familyId)
      notify.success('Session 已踢出')
      await load()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setRevokingFamilyId(null)
    }
  }

  if (!caps.canManageSecurity) {
    return <ForbiddenPlaceholder reason="身份提供方管理需要项目 admin 或 owner 角色（或平台超管）" />
  }

  const callbackBase = backendBaseUrl()
  const discoveryUrl = `${callbackBase}/.well-known/openid-configuration`
  const activeProviderMeta = getProviderMeta(providerForm.provider_type)

  // 登录日志的客户端过滤（搜索 / provider / 应用）
  const filteredLogs = logs.filter((log) => {
    if (logProvider && log.provider !== logProvider) return false
    if (logClient && log.client_id !== logClient) return false
    if (logSearch.trim()) {
      const kw = logSearch.trim().toLowerCase()
      const hay = [log.sub, log.provider, log.email, log.ip].filter(Boolean).join(' ').toLowerCase()
      if (!hay.includes(kw)) return false
    }
    return true
  })

  return (
    <div className="w-full space-y-6">
      <div>
        <div className="flex items-center gap-2 text-xs text-gray-400 mb-2">
          <span>安全</span>
          <i className="fas fa-chevron-right text-[10px]"></i>
          <span className="text-gray-600">身份提供方 (IdP)</span>
        </div>
        <h1 className="text-2xl font-bold text-gray-900">身份提供方 (IdP)</h1>
        <p className="text-sm text-gray-500 mt-1">
          凭证在项目层统一配置；各 OAuth2 应用独立控制允许哪些 Provider。
        </p>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="border-b border-gray-200 px-4">
          <div className="relative flex gap-1">
            {TABS.map((item) => (
              <button
                key={item.key}
                ref={(el) => {
                  tabRefs.current[item.key] = el
                }}
                onClick={() => setTab(item.key)}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium transition-colors ${
                  tab === item.key ? 'text-blue-600' : 'text-gray-500 hover:text-gray-900'
                }`}
              >
                <i className={`${item.icon} text-[11px]`}></i>
                {item.label}
              </button>
            ))}
            {/* 滑动下划线 */}
            <span
              className="absolute -bottom-px h-0.5 bg-blue-500 rounded-full transition-all duration-300 ease-out"
              style={{ left: indicator.left, width: indicator.width }}
            />
          </div>
        </div>

        {tab === 'vault' && (
          <div className="p-5 space-y-5">
            <div className="flex items-start gap-3 rounded-xl border border-blue-100 bg-blue-50/60 p-4">
              <span className="inline-flex items-center rounded bg-blue-100 text-blue-700 px-2 py-0.5 text-xs font-medium flex-shrink-0">项目层</span>
              <p className="text-xs text-gray-600 leading-6">
                在这里集中填写各 Provider 的 client_id / client_secret 凭证，本项目下所有 OAuth2 应用共用同一套密钥，无需重复填写。
                这一层只管「凭证是否存在 / 是否全局启用」，不决定具体哪个应用能用——应用级开关请到「OAuth2 应用」Tab 配置。
              </p>
            </div>

            {loading ? (
              <div className="py-16 text-center text-gray-400">
                <i className="fas fa-spinner fa-spin text-2xl"></i>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {PROVIDERS.map((meta) => {
                  const provider = providerMap.get(meta.key)
                  const configured = !!provider
                  return (
                    <button
                      type="button"
                      key={meta.key}
                      onClick={() => openProviderDrawer(meta.key)}
                      className={`text-left rounded-xl p-4 transition-all hover:shadow-md ${
                        configured
                          ? provider.is_enabled
                            ? 'bg-white border border-gray-100 border-l-[3px] border-l-blue-500'
                            : 'bg-white border border-gray-100 border-l-[3px] border-l-orange-300'
                          : 'border border-dashed border-gray-300 bg-gray-50'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${meta.iconBgClass}`}>
                            <i className={meta.iconClass}></i>
                          </div>
                          <div>
                            <div className="font-semibold text-gray-900">{meta.label}</div>
                            <div className="text-xs text-gray-500">{meta.subtitle}</div>
                          </div>
                        </div>
                        <span
                          className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium border ${
                            configured
                              ? provider.is_enabled
                                ? 'bg-green-50 text-green-700 border-green-200'
                                : 'bg-orange-50 text-orange-700 border-orange-200'
                              : 'bg-gray-100 text-gray-500 border-gray-200'
                          }`}
                        >
                          <i className="fas fa-circle text-[6px]"></i>
                          {configured ? (provider.is_enabled ? '凭证已配置' : '已禁用') : '未配置'}
                        </span>
                      </div>

                      <div className="mt-4 rounded-lg border border-gray-100 bg-gray-50 p-3 min-h-[90px]">
                        {configured ? (
                          <>
                            <div className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">Client ID</div>
                            <div className="font-mono text-xs text-gray-700 break-all">{provider.client_id}</div>
                            <div className="mt-2 text-xs text-gray-500">Secret: ••••••••••••</div>
                          </>
                        ) : (
                          <div className="h-full flex flex-col items-center justify-center text-center text-gray-400">
                            <i className="fas fa-plus mb-2"></i>
                            <span className="text-sm">填写凭证</span>
                          </div>
                        )}
                      </div>

                      <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
                        <span>{provider?.enabled_client_count ?? 0} 个应用已启用</span>
                        <span className="text-blue-600 font-medium">{configured ? '编辑凭证' : '开始配置'}</span>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {tab === 'apps' && (
          <div className="p-5 space-y-4">
            <div className="flex items-start gap-3 rounded-xl border border-emerald-100 bg-emerald-50/60 p-4">
              <span className="inline-flex items-center rounded bg-emerald-100 text-emerald-700 px-2 py-0.5 text-xs font-medium flex-shrink-0">应用层</span>
              <p className="text-xs text-gray-600 leading-6">
                每个应用独立控制允许哪些 Provider，以及各自的回调地址与 PKCE 策略，互不影响。
                凭证仍统一来自「Provider 凭证库」，这里只负责按应用开关；未配置或被全局停用的 Provider 无法在此开启。
              </p>
            </div>
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-gray-500">下面是本项目已注册的 OAuth2 应用。</p>
              <button onClick={openAppDrawerForCreate} className="btn-primary whitespace-nowrap">
                <i className="fas fa-plus mr-2"></i>
                注册应用
              </button>
            </div>

            <div className="overflow-hidden rounded-xl border border-gray-200">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-5 py-3 text-left font-medium">应用名称</th>
                    <th className="px-5 py-3 text-left font-medium">Client ID</th>
                    <th className="px-5 py-3 text-left font-medium">已启用 Provider</th>
                    <th className="px-5 py-3 text-left font-medium">回调地址</th>
                    <th className="px-5 py-3 text-left font-medium">PKCE</th>
                    <th className="px-5 py-3 text-left font-medium">状态</th>
                    <th className="px-5 py-3 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {loading && (
                    <tr>
                      <td colSpan={7} className="px-5 py-16 text-center text-gray-400">
                        <i className="fas fa-spinner fa-spin text-2xl"></i>
                      </td>
                    </tr>
                  )}
                  {!loading && clients.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-5 py-16 text-center text-gray-400">
                        暂无 OAuth2 应用，点击右上角「注册应用」创建第一个。
                      </td>
                    </tr>
                  )}
                  {!loading &&
                    clients.map((client) => {
                      const enabledProviders = (client.providers || []).filter((provider) => provider.is_enabled)
                      return (
                        <tr key={client.client_id} className="hover:bg-gray-50/50">
                          <td className="px-5 py-4">
                            <div className="font-medium text-gray-900">{client.display_name}</div>
                            <div className="text-xs text-gray-500 mt-0.5">{client.allowed_scopes.join(', ')}</div>
                          </td>
                          <td className="px-5 py-4">
                            <code className="text-xs bg-gray-100 px-2 py-1 rounded text-gray-700">{client.client_id}</code>
                          </td>
                          <td className="px-5 py-4">
                            <div className="flex flex-wrap items-center gap-1.5">
                              {enabledProviders.length === 0 ? (
                                <span className="text-xs text-gray-400">未启用</span>
                              ) : (
                                enabledProviders.map((provider) => (
                                  <span
                                    key={provider.provider_type}
                                    className="inline-flex items-center rounded-full bg-blue-50 text-blue-700 px-2 py-0.5 text-xs"
                                  >
                                    {provider.provider_type}
                                  </span>
                                ))
                              )}
                            </div>
                          </td>
                          <td className="px-5 py-4 text-xs text-gray-500">
                            <div className="max-w-[220px] truncate">{client.redirect_uris[0] || '—'}</div>
                            {client.redirect_uris.length > 1 && (
                              <div className="mt-1 text-[11px] text-gray-400">+{client.redirect_uris.length - 1} more</div>
                            )}
                          </td>
                          <td className="px-5 py-4">
                            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                              client.require_pkce
                                ? 'bg-blue-100 text-blue-700'
                                : 'bg-gray-100 text-gray-600'
                            }`}>
                              {client.require_pkce ? '强制' : '可选'}
                            </span>
                          </td>
                          <td className="px-5 py-4">
                            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                              client.is_active
                                ? 'bg-green-100 text-green-700'
                                : 'bg-gray-100 text-gray-600'
                            }`}>
                              {client.is_active ? '启用' : '停用'}
                            </span>
                          </td>
                          <td className="px-5 py-4 text-right">
                            <button
                              onClick={() => openAppDrawerForEdit(client)}
                              className="text-sm text-blue-600 hover:text-blue-800"
                            >
                              <i className="fas fa-pen mr-1"></i>
                              编辑
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>
            </div>

            {/* ── OIDC Discovery 端点 Banner ── */}
            <div className="rounded-lg border border-sky-200 bg-gradient-to-br from-sky-50 to-cyan-50 px-4 py-3.5">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 h-8 w-8 flex-shrink-0 rounded-lg bg-sky-500 flex items-center justify-center">
                  <i className="fas fa-bolt text-[11px] text-white"></i>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <p className="text-[13px] font-semibold text-sky-900">OIDC Discovery 端点</p>
                    <span className="rounded-full bg-sky-500 px-2 py-0.5 text-[10px] font-medium text-white">自动化配置</span>
                  </div>
                  <p className="mb-2.5 text-xs leading-6 text-sky-700">
                    第三方应用只需将此 URL 填入 OAuth2/OIDC 库的{' '}
                    <code className="rounded bg-white/60 px-1 py-0.5 font-mono">issuer</code> 配置项，
                    即可自动发现所有端点（授权、Token 交换、JWKS、Token 撤销），无需手动填写任何地址。
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex min-w-0 max-w-2xl flex-1 items-center overflow-hidden rounded-md border border-sky-200 bg-white">
                      <code className="flex-1 truncate px-3 py-2 font-mono text-xs text-sky-700">{discoveryUrl}</code>
                      <button
                        onClick={() => copyText(discoveryUrl)}
                        className="flex items-center gap-1 whitespace-nowrap border-l border-sky-200 bg-sky-50 px-3 py-2 text-[11px] text-sky-700 hover:bg-sky-100"
                      >
                        <i className="fas fa-copy text-[10px]"></i>复制
                      </button>
                    </div>
                    <button
                      onClick={() => setGuideOpen((v) => !v)}
                      className="flex items-center gap-1.5 whitespace-nowrap rounded-md bg-sky-500 px-3.5 py-2 text-[11px] font-medium text-white hover:bg-sky-600"
                    >
                      <i className="fas fa-book-open text-[9px]"></i>
                      查看接入指南
                      <i className={`fas fa-chevron-down text-[9px] transition-transform ${guideOpen ? 'rotate-180' : ''}`}></i>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* ── 接入指南（可展开）── */}
            {guideOpen && (
              <div className="overflow-hidden rounded-lg border border-gray-200">
                <div className="flex border-b border-gray-200 bg-gray-50 px-4">
                  {[
                    { key: 'steps', label: '接入步骤', icon: 'fas fa-list-check' },
                    { key: 'discovery', label: 'Discovery 响应', icon: 'fas fa-file-code' },
                    { key: 'sdk', label: 'SDK 接入示例', icon: 'fas fa-code' },
                  ].map((g) => (
                    <button
                      key={g.key}
                      onClick={() => setGuideTab(g.key as typeof guideTab)}
                      className={`-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-[13px] font-medium transition-colors ${
                        guideTab === g.key
                          ? 'border-sky-500 text-sky-600'
                          : 'border-transparent text-gray-500 hover:text-gray-800'
                      }`}
                    >
                      <i className={`${g.icon} text-[11px]`}></i>
                      {g.label}
                    </button>
                  ))}
                </div>

                {/* 接入步骤 */}
                {guideTab === 'steps' && (
                  <div className="p-5">
                    <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-2">
                      <div className="flex gap-3 rounded-lg border border-gray-100 bg-gray-50 p-3.5">
                        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-sky-100 text-[11px] font-bold text-sky-600">1</div>
                        <div>
                          <p className="mb-1 text-[13px] font-semibold text-gray-900">注册 OAuth2 应用</p>
                          <p className="text-xs leading-6 text-gray-500">
                            点击「注册应用」，填写应用名称和回调地址，获得{' '}
                            <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px]">client_id</code> 和{' '}
                            <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px]">client_secret</code>。
                          </p>
                          {clients.length > 0 && (
                            <span className="mt-2 inline-flex items-center gap-1 rounded bg-green-50 px-2 py-0.5 text-[11px] text-green-700">
                              <i className="fas fa-check text-[8px]"></i>已完成
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex gap-3 rounded-lg border border-gray-100 bg-gray-50 p-3.5">
                        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-sky-100 text-[11px] font-bold text-sky-600">2</div>
                        <div>
                          <p className="mb-1 text-[13px] font-semibold text-gray-900">将 Discovery URL 填入 SDK</p>
                          <p className="text-xs leading-6 text-gray-500">
                            主流 OAuth2/OIDC 库只需一个{' '}
                            <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px]">issuer</code> URL，
                            库会自动请求 Discovery 文档并发现所有端点。
                          </p>
                        </div>
                      </div>

                      <div className="flex gap-3 rounded-lg border border-gray-100 bg-gray-50 p-3.5">
                        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-sky-100 text-[11px] font-bold text-sky-600">3</div>
                        <div>
                          <p className="mb-1 text-[13px] font-semibold text-gray-900">确认回调地址已添加</p>
                          <p className="text-xs leading-6 text-gray-500">
                            你的服务回调地址必须和应用配置里的完全一致（精确匹配，不支持通配符）。
                          </p>
                        </div>
                      </div>

                      <div className="flex gap-3 rounded-lg border border-green-200 bg-green-50 p-3.5">
                        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-green-600">
                          <i className="fas fa-flag-checkered text-[10px] text-white"></i>
                        </div>
                        <div>
                          <p className="mb-1 text-[13px] font-semibold text-green-700">完成接入！</p>
                          <p className="text-xs leading-6 text-green-800">
                            用户现在可以通过已启用的 Provider（Google…）登录，你的应用收到标准 OIDC{' '}
                            <code className="rounded bg-black/5 px-1 py-0.5 font-mono text-[11px]">id_token</code>。
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* 核心端点速查 */}
                    <div className="overflow-hidden rounded-lg border border-gray-100">
                      <div className="border-b border-gray-100 bg-gray-50 px-4 py-2">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                          核心端点速查（由 Discovery 自动提供）
                        </span>
                      </div>
                      <table className="w-full border-collapse text-xs">
                        <tbody>
                          {[
                            ['授权', `${callbackBase}/oauth2/authorize`],
                            ['Token 交换', `${callbackBase}/oauth2/token`],
                            ['用户信息', `${callbackBase}/oauth2/userinfo`],
                            ['JWKS 公钥', `${callbackBase}/.well-known/jwks.json`],
                            ['撤销 Token', `${callbackBase}/oauth2/revoke`],
                          ].map(([label, url], i, arr) => (
                            <tr key={label} className={i < arr.length - 1 ? 'border-b border-gray-100' : ''}>
                              <td className="w-36 whitespace-nowrap px-4 py-2 text-gray-500">{label}</td>
                              <td className="px-4 py-2">
                                <code className="font-mono text-gray-700">{url}</code>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Discovery 响应 */}
                {guideTab === 'discovery' && (
                  <div className="p-5">
                    <p className="mb-3 text-xs text-gray-500">
                      访问 Discovery URL 返回的标准 JSON（符合 OIDC Core 1.0 规范，实际以本环境返回为准）：
                    </p>
                    <div className="relative overflow-x-auto rounded-lg bg-slate-800 p-4">
                      <span className="absolute right-3 top-2.5 font-mono text-[11px] text-slate-500">
                        GET /.well-known/openid-configuration
                      </span>
                      <pre className="m-0 font-mono text-xs leading-7 text-slate-200">
{`{
  "issuer":                                 "${callbackBase}",
  "authorization_endpoint":                 "${callbackBase}/oauth2/authorize",
  "token_endpoint":                         "${callbackBase}/oauth2/token",
  "userinfo_endpoint":                      "${callbackBase}/oauth2/userinfo",
  "revocation_endpoint":                    "${callbackBase}/oauth2/revoke",
  "jwks_uri":                               "${callbackBase}/.well-known/jwks.json",

  "response_types_supported":               ["code"],
  "grant_types_supported":                  ["authorization_code", "refresh_token"],
  "subject_types_supported":                ["public"],
  "id_token_signing_alg_values_supported":  ["RS256"],

  "scopes_supported":                       ["openid", "email", "profile"],
  "claims_supported":                       ["sub", "email", "email_verified", "name", "auth_method"],

  "token_endpoint_auth_methods_supported":  ["client_secret_post", "none"],
  "code_challenge_methods_supported":       ["S256"]
}`}
                      </pre>
                    </div>
                    <div className="mt-3 flex gap-2 rounded-md border border-amber-200 bg-amber-50 px-3.5 py-2.5">
                      <i className="fas fa-lightbulb mt-0.5 flex-shrink-0 text-xs text-amber-600"></i>
                      <p className="m-0 text-xs leading-6 text-amber-800">
                        <strong>sub 是每个用户的稳定唯一标识</strong>——<strong>同一上游账号</strong>每次登录都返回相同的{' '}
                        <code className="rounded bg-black/5 px-1 py-0.5 font-mono text-[11px]">sub</code>，与是否提供 email 无关。
                        若不同 Provider 返回<strong>相同且已验证的 email</strong>，会自动归并为同一 <code className="rounded bg-black/5 px-1 py-0.5 font-mono text-[11px]">sub</code>；
                        否则各自独立（如微信等不提供 email 的渠道会是独立身份）。
                      </p>
                    </div>
                  </div>
                )}

                {/* SDK 示例 */}
                {guideTab === 'sdk' && (
                  <div className="p-5">
                    <div className="mb-4 flex flex-wrap gap-1.5">
                      {[
                        { key: 'nextjs', label: 'Next.js' },
                        { key: 'python', label: 'Python' },
                        { key: 'ios', label: 'iOS (Swift)' },
                        { key: 'android', label: 'Android' },
                      ].map((s) => (
                        <button
                          key={s.key}
                          onClick={() => setSdkTab(s.key as typeof sdkTab)}
                          className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                            sdkTab === s.key
                              ? 'border-sky-500 bg-sky-50 text-sky-600'
                              : 'border-gray-200 bg-white text-gray-500 hover:text-gray-800'
                          }`}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>

                    {sdkTab === 'nextjs' && (
                      <div>
                        <p className="mb-2.5 text-xs text-gray-500">
                          使用 <strong>NextAuth.js v5</strong>，只需配置{' '}
                          <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px]">issuer</code>：
                        </p>
                        <div className="overflow-hidden rounded-lg bg-slate-800">
                          <div className="border-b border-slate-700 bg-slate-900 px-3.5 py-1.5 font-mono text-[11px] text-slate-500">auth.ts</div>
                          <pre className="m-0 overflow-x-auto p-4 font-mono text-xs leading-7 text-slate-200">
{`import NextAuth from "next-auth"

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [{
    id: "onebase",
    name: "OneBase",
    type: "oidc",
    // 只需这一个 URL，其余端点自动发现
    issuer: "${callbackBase}",
    clientId: process.env.ONEBASE_CLIENT_ID,
    clientSecret: process.env.ONEBASE_CLIENT_SECRET,
  }],
})`}
                          </pre>
                        </div>
                      </div>
                    )}

                    {sdkTab === 'python' && (
                      <div>
                        <p className="mb-2.5 text-xs text-gray-500">
                          使用 <strong>Authlib + FastAPI</strong>：
                        </p>
                        <div className="overflow-hidden rounded-lg bg-slate-800">
                          <div className="border-b border-slate-700 bg-slate-900 px-3.5 py-1.5 font-mono text-[11px] text-slate-500">main.py</div>
                          <pre className="m-0 overflow-x-auto p-4 font-mono text-xs leading-7 text-slate-200">
{`from authlib.integrations.starlette_client import OAuth

oauth = OAuth()
oauth.register(
    name="onebase",
    client_id=ONEBASE_CLIENT_ID,
    client_secret=ONEBASE_CLIENT_SECRET,
    # 自动从 Discovery URL 加载所有端点
    server_metadata_url="${discoveryUrl}",
    client_kwargs={"scope": "openid email profile"},
)`}
                          </pre>
                        </div>
                      </div>
                    )}

                    {sdkTab === 'ios' && (
                      <div>
                        <p className="mb-2.5 text-xs text-gray-500">
                          使用 <strong>AppAuth-iOS</strong>（Swift）：
                        </p>
                        <div className="overflow-hidden rounded-lg bg-slate-800">
                          <div className="border-b border-slate-700 bg-slate-900 px-3.5 py-1.5 font-mono text-[11px] text-slate-500">AuthManager.swift</div>
                          <pre className="m-0 overflow-x-auto p-4 font-mono text-xs leading-7 text-slate-200">
{`import AppAuth

let issuer = URL(string: "${callbackBase}")!

// Discovery 自动完成——只需传 issuer
OIDAuthorizationService.discoverConfiguration(
    forIssuer: issuer
) { configuration, error in
    guard let config = configuration else { return }
    let request = OIDAuthorizationRequest(
        configuration: config,
        clientId: "<your_client_id>",
        scopes: [OIDScopeOpenID, OIDScopeEmail, OIDScopeProfile],
        redirectURL: URL(string: "yourapp://auth/callback")!,
        responseType: OIDResponseTypeCode,
        additionalParameters: nil
    )
    // PKCE 由 AppAuth 自动处理
}`}
                          </pre>
                        </div>
                      </div>
                    )}

                    {sdkTab === 'android' && (
                      <div>
                        <p className="mb-2.5 text-xs text-gray-500">
                          使用 <strong>AppAuth-Android</strong>（Kotlin）：
                        </p>
                        <div className="overflow-hidden rounded-lg bg-slate-800">
                          <div className="border-b border-slate-700 bg-slate-900 px-3.5 py-1.5 font-mono text-[11px] text-slate-500">AuthActivity.kt</div>
                          <pre className="m-0 overflow-x-auto p-4 font-mono text-xs leading-7 text-slate-200">
{`import net.openid.appauth.*

val issuerUri = Uri.parse("${callbackBase}")

// 一行完成 Discovery，自动拉取所有端点
AuthorizationServiceConfiguration.fetchFromIssuer(issuerUri) { config, ex ->
    val request = AuthorizationRequest.Builder(
        config!!,
        "<your_client_id>",
        ResponseTypeValues.CODE,
        Uri.parse("yourapp://auth/callback")
    )
    .setScope("openid email profile")
    .build()
    // AppAuth 自动生成 PKCE code_verifier / code_challenge
    authService.performAuthorizationRequest(request, pendingIntent)
}`}
                          </pre>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {tab === 'logs' && (
          <div className="p-5 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-gray-500">
                查看当前仍可续期的第三方登录 Session，并按需踢出。
              </p>
            </div>

            <div className="overflow-hidden rounded-xl border border-gray-200">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-5 py-3 text-left font-medium">时间</th>
                    <th className="px-5 py-3 text-left font-medium">应用</th>
                    <th className="px-5 py-3 text-left font-medium">Provider</th>
                    <th className="px-5 py-3 text-left font-medium">Sub</th>
                    <th className="px-5 py-3 text-left font-medium">用户</th>
                    <th className="px-5 py-3 text-left font-medium">到期时间</th>
                    <th className="px-5 py-3 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {loading && (
                    <tr>
                      <td colSpan={7} className="px-5 py-16 text-center text-gray-400">
                        <i className="fas fa-spinner fa-spin text-2xl"></i>
                      </td>
                    </tr>
                  )}
                  {!loading && sessions.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-5 py-16 text-center text-gray-400">
                        当前没有活跃的 IdP Session。
                      </td>
                    </tr>
                  )}
                  {!loading &&
                    sessions.map((session) => (
                      <tr key={session.family_id} className="hover:bg-gray-50/50">
                        <td className="px-5 py-4 text-xs text-gray-500">
                          {session.created_at.split('.')[0]?.replace('T', ' ')}
                        </td>
                        <td className="px-5 py-4">
                          <div className="font-medium text-gray-900">{session.client_display_name}</div>
                          <div className="text-xs text-gray-500 mt-0.5">{session.client_id}</div>
                        </td>
                        <td className="px-5 py-4">
                          <span className="inline-flex rounded-full bg-blue-50 text-blue-700 px-2 py-0.5 text-xs">
                            {session.auth_method || 'unknown'}
                          </span>
                        </td>
                        <td className="px-5 py-4">
                          <code className="text-xs bg-gray-100 px-2 py-1 rounded text-gray-700">{session.sub}</code>
                        </td>
                        <td className="px-5 py-4 text-sm text-gray-600">
                          <div>{session.name || '—'}</div>
                          <div className="text-xs text-gray-400 mt-0.5">{session.email || '—'}</div>
                        </td>
                        <td className="px-5 py-4 text-xs text-gray-500">
                          {session.expires_at.split('.')[0]?.replace('T', ' ')}
                        </td>
                        <td className="px-5 py-4 text-right">
                          <button
                            onClick={() => handleRevokeSession(session.family_id)}
                            disabled={revokingFamilyId === session.family_id}
                            className="text-sm text-red-600 hover:text-red-800 disabled:opacity-50"
                          >
                            {revokingFamilyId === session.family_id ? (
                              <>
                                <i className="fas fa-spinner fa-spin mr-1"></i>
                                踢出中...
                              </>
                            ) : (
                              <>
                                <i className="fas fa-user-slash mr-1"></i>
                                踢出
                              </>
                            )}
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'audit' && (
          <div className="p-5 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative flex-1 min-w-[16rem] max-w-sm">
                <svg
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="11" cy="11" r="7" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  value={logSearch}
                  onChange={(e) => setLogSearch(e.target.value)}
                  className="w-full input-base !pl-9"
                  placeholder="搜索 sub、provider、email、IP…"
                />
              </div>
              <select
                value={logProvider}
                onChange={(e) => setLogProvider(e.target.value)}
                className="input-base w-auto"
              >
                <option value="">全部 Provider</option>
                {PROVIDERS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
              <select
                value={logClient}
                onChange={(e) => setLogClient(e.target.value)}
                className="input-base w-auto"
              >
                <option value="">全部应用</option>
                {clients.map((c) => (
                  <option key={c.client_id} value={c.client_id}>
                    {c.display_name}
                  </option>
                ))}
              </select>
            </div>

            <div className="overflow-hidden rounded-xl border border-gray-200">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-5 py-3 text-left font-medium">时间</th>
                    <th className="px-5 py-3 text-left font-medium">事件</th>
                    <th className="px-5 py-3 text-left font-medium">Provider</th>
                    <th className="px-5 py-3 text-left font-medium">Sub</th>
                    <th className="px-5 py-3 text-left font-medium">应用</th>
                    <th className="px-5 py-3 text-left font-medium">状态</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {loading && (
                    <tr>
                      <td colSpan={6} className="px-5 py-16 text-center text-gray-400">
                        <i className="fas fa-spinner fa-spin text-2xl"></i>
                      </td>
                    </tr>
                  )}
                  {!loading && filteredLogs.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-5 py-16 text-center text-gray-400">
                        暂无登录日志。用户通过本项目的应用完成社交登录后，这里会出现记录。
                      </td>
                    </tr>
                  )}
                  {!loading &&
                    filteredLogs.map((log) => (
                      <tr key={log.id} className="hover:bg-gray-50/50">
                        <td className="px-5 py-3 text-xs text-gray-500 whitespace-nowrap">
                          {log.created_at.split('.')[0]?.replace('T', ' ')}
                        </td>
                        <td className="px-5 py-3">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                              log.event === 'register'
                                ? 'bg-blue-50 text-blue-700'
                                : 'bg-green-50 text-green-700'
                            }`}
                          >
                            {log.event}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-gray-700">{log.provider}</td>
                        <td className="px-5 py-3">
                          {log.sub ? (
                            <code className="text-xs bg-gray-100 px-2 py-0.5 rounded text-gray-700">
                              {log.sub.length > 12 ? `${log.sub.slice(0, 12)}…` : log.sub}
                            </code>
                          ) : (
                            <span className="text-xs text-gray-400">—</span>
                          )}
                          {log.email && (
                            <div className="text-xs text-gray-400 mt-0.5">{log.email}</div>
                          )}
                        </td>
                        <td className="px-5 py-3 text-xs text-gray-500">{log.client_display_name || '—'}</td>
                        <td className="px-5 py-3">
                          {log.status === 'success' ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-green-50 text-green-700 px-2 py-0.5 text-xs font-medium border border-green-200">
                              <i className="fas fa-circle text-[6px]"></i>
                              成功
                            </span>
                          ) : (
                            <span
                              className="inline-flex items-center gap-1 rounded-full bg-red-50 text-red-700 px-2 py-0.5 text-xs font-medium border border-red-200"
                              title={log.error || ''}
                            >
                              <i className="fas fa-circle text-[6px]"></i>
                              失败
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <Drawer
        isOpen={providerDrawerOpen}
        onClose={closeProviderDrawer}
        title={`${providerMap.get(providerForm.provider_type) ? '编辑' : '配置'} ${PROVIDERS.find((p) => p.key === providerForm.provider_type)?.label || providerForm.provider_type} 凭证`}
        size="lg"
        footer={
          <div className="flex items-center justify-end gap-3">
            <button onClick={closeProviderDrawer} disabled={providerSaving} className="btn-default">
              取消
            </button>
            <button onClick={handleSaveProvider} disabled={providerSaving} className="btn-primary disabled:opacity-50">
              {providerSaving ? '保存中...' : '保存凭证'}
            </button>
          </div>
        }
      >
        <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Provider</label>
              <input
                value={activeProviderMeta?.label || providerForm.provider_type}
                disabled
                className="w-full input-base bg-gray-50 text-gray-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">显示名称</label>
              <input
                value={providerForm.display_name}
                onChange={(e) => setProviderForm((prev) => ({ ...prev, display_name: e.target.value }))}
                className="w-full input-base"
                placeholder="按钮文案"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Client ID <span className="text-red-500">*</span>
            </label>
            <input
              value={providerForm.client_id}
              onChange={(e) => setProviderForm((prev) => ({ ...prev, client_id: e.target.value }))}
              className="w-full input-base font-mono"
              placeholder="填写上游 Provider 的 Client ID"
            />
          </div>

          {providerForm.provider_type !== 'apple' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Client Secret {!providerMap.get(providerForm.provider_type) && <span className="text-red-500">*</span>}
              </label>
              <input
                type="password"
                value={providerForm.client_secret}
                onChange={(e) => setProviderForm((prev) => ({ ...prev, client_secret: e.target.value }))}
                className="w-full input-base font-mono"
                placeholder={providerMap.get(providerForm.provider_type) ? '留空则保留现有值' : '填写上游 Provider 的 Client Secret'}
              />
              <p className="mt-1 text-xs text-gray-400">
                填写后加密存储；已配置的 Provider 留空则保留现有密文不变。
              </p>
            </div>
          )}

          {providerForm.provider_type === 'apple' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2 text-xs text-gray-500">
                Apple 用 Team ID + Key ID + 私钥(.p8) 现签 client_secret（ES256），
                <code className="bg-gray-100 px-1 rounded font-mono">client_id</code> 填 Services ID。
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Team ID <span className="text-red-500">*</span>
                </label>
                <input
                  value={providerForm.appleTeamId}
                  onChange={(e) => setProviderForm((prev) => ({ ...prev, appleTeamId: e.target.value }))}
                  className="w-full input-base font-mono"
                  placeholder="例如 A1B2C3D4E5"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Key ID <span className="text-red-500">*</span>
                </label>
                <input
                  value={providerForm.appleKeyId}
                  onChange={(e) => setProviderForm((prev) => ({ ...prev, appleKeyId: e.target.value }))}
                  className="w-full input-base font-mono"
                  placeholder="例如 X9Y8Z7W6V5"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  私钥 (.p8 PEM) {!providerMap.get(providerForm.provider_type) && <span className="text-red-500">*</span>}
                </label>
                <textarea
                  rows={5}
                  value={providerForm.applePrivateKeyPem}
                  onChange={(e) => setProviderForm((prev) => ({ ...prev, applePrivateKeyPem: e.target.value }))}
                  className="w-full input-base font-mono"
                  placeholder={'-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----'}
                />
                <p className="mt-1 text-xs text-gray-400">
                  从 Apple Developer 下载的 .p8 私钥，加密存储；编辑时留空则保留现有私钥。
                </p>
              </div>
            </div>
          )}

          {providerForm.provider_type === 'oidc' && (
            <div className="space-y-4 rounded-xl border border-indigo-100 bg-indigo-50/50 p-4">
              <div className="text-sm font-medium text-indigo-900">自定义 OIDC 端点</div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Authorization URL</label>
                <input
                  value={providerForm.oidcAuthorizationUrl}
                  onChange={(e) => setProviderForm((prev) => ({ ...prev, oidcAuthorizationUrl: e.target.value }))}
                  className="w-full input-base font-mono"
                  placeholder="https://idp.example.com/oauth2/authorize"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Token URL</label>
                <input
                  value={providerForm.oidcTokenUrl}
                  onChange={(e) => setProviderForm((prev) => ({ ...prev, oidcTokenUrl: e.target.value }))}
                  className="w-full input-base font-mono"
                  placeholder="https://idp.example.com/oauth2/token"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">UserInfo URL</label>
                <input
                  value={providerForm.oidcUserinfoUrl}
                  onChange={(e) => setProviderForm((prev) => ({ ...prev, oidcUserinfoUrl: e.target.value }))}
                  className="w-full input-base font-mono"
                  placeholder="https://idp.example.com/oauth2/userinfo"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Scopes</label>
                <input
                  value={providerForm.oidcScopes}
                  onChange={(e) => setProviderForm((prev) => ({ ...prev, oidcScopes: e.target.value }))}
                  className="w-full input-base font-mono"
                  placeholder="openid email profile"
                />
              </div>
            </div>
          )}

          <div className="flex items-center justify-between rounded-lg border border-gray-200 p-4">
            <div>
              <div className="text-sm font-medium text-gray-800">全局启用</div>
              <div className="text-xs text-gray-500 mt-1">关闭后该 Provider 会从所有 OAuth2 应用中整体失效。</div>
            </div>
            <Toggle
              checked={providerForm.is_enabled}
              onChange={(v) => setProviderForm((prev) => ({ ...prev, is_enabled: v }))}
            />
          </div>

          <div className="rounded-xl border border-gray-200 bg-blue-50 p-4">
            <div className="text-sm font-medium text-gray-800 mb-2">
              <i className="fas fa-circle-info text-blue-500 mr-2"></i>
              回调地址
            </div>
            <p className="text-xs text-gray-600 mb-2">
              {activeProviderMeta?.callbackHint || '在上游 Provider 控制台里将回调地址配置为：'}
            </p>
            <code className="block rounded bg-white px-3 py-2 text-xs text-blue-700 break-all border border-blue-100">
              {callbackBase}/oauth2/callback/{providerForm.provider_type}
            </code>
          </div>
        </div>
      </Drawer>

      <Drawer
        isOpen={appDrawerOpen}
        onClose={closeAppDrawer}
        title={appForm.clientId ? '编辑 OAuth2 应用' : '注册 OAuth2 应用'}
        size="xl"
        footer={
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-gray-400">
              Client Secret 仅在创建或轮换后显示一次。
            </div>
            <div className="flex items-center gap-3">
              <button onClick={closeAppDrawer} disabled={appSaving} className="btn-default">
                取消
              </button>
              <button onClick={handleSaveApp} disabled={appSaving} className="btn-primary disabled:opacity-50">
                {appSaving ? '保存中...' : appForm.clientId ? '保存应用' : '注册应用'}
              </button>
            </div>
          </div>
        }
      >
        <div className="space-y-6">
          {appForm.clientId && (
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
              <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">Client ID</div>
              <div className="flex items-center gap-3">
                <code className="text-xs bg-white border border-gray-200 rounded px-2 py-1 text-gray-700">{appForm.clientId}</code>
                <button onClick={() => copyText(appForm.clientId!)} className="text-sm text-blue-600 hover:text-blue-800">
                  复制
                </button>
                <button onClick={handleRotateSecret} className="text-sm text-orange-600 hover:text-orange-800">
                  轮换 Secret
                </button>
              </div>
            </div>
          )}

          {revealedSecret && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-amber-800">请立即保存 Client Secret</div>
                  <p className="text-xs text-amber-700 mt-1">该明文只在当前操作后展示一次，关闭抽屉后无法再次读取。</p>
                  <code className="mt-3 block rounded bg-white border border-amber-200 px-3 py-2 text-xs text-amber-900 break-all">
                    {revealedSecret}
                  </code>
                </div>
                <button onClick={() => copyText(revealedSecret)} className="text-sm text-amber-700 hover:text-amber-900 whitespace-nowrap">
                  复制
                </button>
              </div>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                应用名称 <span className="text-red-500">*</span>
              </label>
              <input
                value={appForm.displayName}
                onChange={(e) => setAppForm((prev) => ({ ...prev, displayName: e.target.value }))}
                className="w-full input-base"
                placeholder="例如：ShireHub Web"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                回调地址 <span className="text-red-500">*</span>
              </label>
              <textarea
                rows={3}
                value={appForm.redirectUrisText}
                onChange={(e) => setAppForm((prev) => ({ ...prev, redirectUrisText: e.target.value }))}
                className="w-full input-base"
                placeholder={'每行一个，例如：\nhttps://shirehub.com/auth/callback'}
              />
              <p className="mt-1 text-xs text-gray-400">每行一个，精确匹配，不支持通配符。</p>
            </div>

            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Allowed Scopes</label>
              <div className="rounded-lg border border-gray-200 p-3 space-y-3">
                {/* 预设 scope：点选切换 */}
                <div className="flex flex-wrap gap-2">
                  {PRESET_SCOPES.map((scope) => {
                    const on = appScopes.includes(scope)
                    const required = scope === 'openid'
                    return (
                      <button
                        type="button"
                        key={scope}
                        onClick={() => toggleScope(scope, !on)}
                        disabled={required}
                        className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                          on
                            ? 'bg-blue-50 border-blue-200 text-blue-700'
                            : 'bg-white border-gray-200 text-gray-500 hover:border-blue-200'
                        } ${required ? 'cursor-not-allowed' : ''}`}
                        title={required ? 'OIDC 必选，不可移除' : ''}
                      >
                        {on && <i className="fas fa-check mr-1 text-[10px]"></i>}
                        {scope}
                        {required && <span className="ml-1 text-[10px] text-blue-400">必选</span>}
                      </button>
                    )
                  })}
                </div>
                {/* 自定义 scope chips（非预设的） */}
                {appScopes.filter((s) => !PRESET_SCOPES.includes(s as any)).length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {appScopes
                      .filter((s) => !PRESET_SCOPES.includes(s as any))
                      .map((scope) => (
                        <span
                          key={scope}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-700 border border-gray-200"
                        >
                          {scope}
                          <button
                            type="button"
                            onClick={() => setScopes(appScopes.filter((s) => s !== scope))}
                            className="text-gray-400 hover:text-red-500"
                          >
                            <i className="fas fa-xmark text-[10px]"></i>
                          </button>
                        </span>
                      ))}
                  </div>
                )}
                {/* 添加自定义 scope */}
                <div className="flex items-center gap-2">
                  <input
                    value={scopeInput}
                    onChange={(e) => setScopeInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addCustomScope()
                      }
                    }}
                    className="flex-1 input-base font-mono text-xs"
                    placeholder="添加自定义 scope，回车确认"
                  />
                  <button type="button" onClick={addCustomScope} className="btn-default whitespace-nowrap text-xs">
                    添加
                  </button>
                </div>
              </div>
              <p className="mt-1 text-xs text-gray-400">第三方登录请求里只能申请这里勾选的 scope，超出会被拒绝。</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Access Token TTL（秒）</label>
              <input
                type="number"
                min={60}
                value={appForm.accessTokenTtl}
                onChange={(e) => setAppForm((prev) => ({ ...prev, accessTokenTtl: e.target.value }))}
                className="w-full input-base"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Refresh Token TTL（秒）</label>
              <input
                type="number"
                min={300}
                value={appForm.refreshTokenTtl}
                onChange={(e) => setAppForm((prev) => ({ ...prev, refreshTokenTtl: e.target.value }))}
                className="w-full input-base"
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-center justify-between rounded-lg border border-gray-200 p-4">
              <div>
                <div className="text-sm font-medium text-gray-800">强制 PKCE</div>
                <div className="text-xs text-gray-500 mt-1">移动端建议开启，Web 端也可强制要求。</div>
              </div>
              <Toggle
                checked={appForm.requirePkce}
                onChange={(v) => setAppForm((prev) => ({ ...prev, requirePkce: v }))}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-gray-200 p-4">
              <div>
                <div className="text-sm font-medium text-gray-800">应用启用</div>
                <div className="text-xs text-gray-500 mt-1">停用后该 client 将无法继续发起登录流程。</div>
              </div>
              <Toggle
                checked={appForm.isActive}
                onChange={(v) => setAppForm((prev) => ({ ...prev, isActive: v }))}
              />
            </div>
          </div>

          <div className="border-t border-gray-100 pt-6">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-sm font-semibold text-gray-900">Provider 权限</div>
                <div className="text-xs text-gray-500 mt-1">控制此应用允许哪些登录方式。</div>
              </div>
              <span className="text-[11px] rounded bg-gray-100 px-2 py-1 text-gray-500">凭证在项目层统一管理</span>
            </div>

            {(() => {
              const usable = PROVIDERS.filter((m) => providerMap.get(m.key)?.is_enabled)
              const unusable = PROVIDERS.filter((m) => !providerMap.get(m.key)?.is_enabled)
              return (
                <div className="space-y-3">
                  {/* 已配置凭证（可启用） */}
                  <div className="overflow-hidden rounded-xl border border-gray-200 bg-gray-50/50">
                    <div className="px-4 py-2 bg-gray-100 border-b border-gray-200">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                        已配置凭证（可启用）
                      </span>
                    </div>
                    {usable.length === 0 ? (
                      <div className="px-4 py-4 text-xs text-gray-400">
                        本项目还没有可用的 Provider，请先到「Provider 凭证库」配置。
                      </div>
                    ) : (
                      usable.map((meta) => (
                        <div
                          key={meta.key}
                          className="flex items-center gap-4 px-4 py-3 border-b border-gray-100 last:border-b-0 bg-white"
                        >
                          <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${meta.iconBgClass}`}>
                            <i className={meta.iconClass}></i>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-gray-900">{meta.label}</div>
                            <div className="text-xs text-gray-500 mt-0.5">{meta.subtitle}</div>
                          </div>
                          <Toggle
                            checked={!!appForm.enabledProviders[meta.key]}
                            onChange={(v) => toggleAppProvider(meta.key, v)}
                          />
                        </div>
                      ))
                    )}
                  </div>

                  {/* 未配置凭证（需先填写） */}
                  {unusable.length > 0 && (
                    <div className="overflow-hidden rounded-xl border border-gray-200 bg-gray-50">
                      <div className="px-4 py-2 bg-gray-100 border-b border-gray-200">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                          未配置凭证（需先填写）
                        </span>
                      </div>
                      {unusable.map((meta) => {
                        const projectProvider = providerMap.get(meta.key)
                        const reason = projectProvider ? '项目层已禁用' : '未配置凭证'
                        return (
                          <div
                            key={meta.key}
                            className="flex items-center gap-4 px-4 py-3 border-b border-gray-100 last:border-b-0 opacity-70"
                          >
                            <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-gray-100 text-gray-400">
                              <i className={meta.iconClass}></i>
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-gray-500">{meta.label}</div>
                              <div className="text-xs text-gray-400 mt-0.5">{reason}</div>
                            </div>
                            <button
                              type="button"
                              onClick={() => jumpToProviderVault(meta.key)}
                              className="text-xs text-blue-600 hover:text-blue-800 whitespace-nowrap"
                            >
                              去配置 →
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })()}
          </div>
        </div>
      </Drawer>
    </div>
  )
}
