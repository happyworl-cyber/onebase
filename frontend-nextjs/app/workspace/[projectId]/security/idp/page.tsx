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
import { useTranslations } from 'next-intl'

type TabKey = 'vault' | 'apps' | 'logs' | 'audit'

type ProviderKey = 'google' | 'apple' | 'facebook' | 'github' | 'oidc'

interface ProviderMeta {
  key: ProviderKey
  label: string
  subtitle: string
  iconClass: string
  iconBgClass: string
  labelKey: string
  callbackHintKey: string
}

const PROVIDERS: ProviderMeta[] = [
  { key: 'google', label: 'Google', subtitle: 'OAuth 2.0', iconClass: 'fab fa-google', iconBgClass: 'bg-red-50 text-red-500', labelKey: 'providerGoogle', callbackHintKey: 'cbGoogle' },
  { key: 'apple', label: 'Apple', subtitle: 'Sign in with Apple', iconClass: 'fab fa-apple', iconBgClass: 'bg-gray-900 text-white', labelKey: 'providerApple', callbackHintKey: 'cbApple' },
  { key: 'facebook', label: 'Facebook', subtitle: 'Meta Login', iconClass: 'fab fa-facebook-f', iconBgClass: 'bg-blue-600 text-white', labelKey: 'providerFacebook', callbackHintKey: 'cbFacebook' },
  { key: 'github', label: 'GitHub', subtitle: 'OAuth 2.0', iconClass: 'fab fa-github', iconBgClass: 'bg-gray-100 text-gray-800', labelKey: 'providerGithub', callbackHintKey: 'cbGithub' },
  { key: 'oidc', label: 'Custom OIDC', subtitle: 'OpenID Connect', iconClass: 'fas fa-id-badge', iconBgClass: 'bg-indigo-100 text-indigo-600', labelKey: 'providerOidc', callbackHintKey: 'cbOidc' },
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

const TABS: { key: TabKey; labelKey: string; icon: string }[] = [
  { key: 'vault', labelKey: 'tabVault', icon: 'fas fa-vault' },
  { key: 'apps', labelKey: 'tabApps', icon: 'fas fa-table-cells-large' },
  { key: 'logs', labelKey: 'tabLogs', icon: 'fas fa-user-clock' },
  { key: 'audit', labelKey: 'tabAudit', icon: 'fas fa-scroll' },
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
  const t = useTranslations('wsIdp')

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
      notify.warning(t('errClientId'))
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
    const secretLabel = isApple ? t('appleKeyLabel') : 'Client Secret'

    const existing = providerMap.get(providerForm.provider_type)
    if (isApple && !existing && (!providerForm.appleTeamId.trim() || !providerForm.appleKeyId.trim())) {
      notify.warning(t('errAppleIds'))
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
        notify.success(t('providerUpdated', { name: providerForm.display_name || providerForm.provider_type }))
      } else {
        if (!clientSecretValue) {
          notify.warning(t('firstConfigSecret', { label: secretLabel }))
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
        notify.success(t('providerCreated', { name: providerForm.display_name || providerForm.provider_type }))
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
      notify.warning(t('errAppName'))
      return null
    }
    if (redirectUris.length === 0) {
      notify.warning(t('errRedirect'))
      return null
    }
    const accessTokenTtl = Number(appForm.accessTokenTtl)
    const refreshTokenTtl = Number(appForm.refreshTokenTtl)
    if (!Number.isFinite(accessTokenTtl) || !Number.isFinite(refreshTokenTtl)) {
      notify.warning(t('errTtl'))
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
        notify.success(t('appUpdated'))
      } else {
        const res = await idpAPI.createClient(projectId, payload as CreateOauth2ClientBody)
        const clientId = res.data.client_id
        // 先记下 clientId：即便后续设置 provider 开关失败，再次点击也走「更新」而非重复创建。
        setAppForm((prev) => ({ ...prev, clientId }))
        setRevealedSecret(res.data.client_secret)
        await idpAPI.replaceClientProviders(projectId, clientId, selectedClientProviders())
        notify.success(t('appCreated'))
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
      notify.success(t('secretRotated'))
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
      notify.warning(t('errScope'))
      return
    }
    setScopes([...appScopes, s])
    setScopeInput('')
  }

  const copyText = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      notify.success(t('copied'))
    } catch {
      notify.warning(t('copyFail'))
    }
  }

  const handleRevokeSession = async (familyId: string) => {
    const ok = window.confirm(t('confirmRevokeSession'))
    if (!ok) return
    setRevokingFamilyId(familyId)
    try {
      await idpAPI.revokeSession(projectId, familyId)
      notify.success(t('sessionRevoked'))
      await load()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setRevokingFamilyId(null)
    }
  }

  if (!caps.canManageSecurity) {
    return <ForbiddenPlaceholder reason={t('forbidden')} />
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
          <span>{t('breadcrumbSecurity')}</span>
          <i className="fas fa-chevron-right text-[10px]"></i>
          <span className="text-gray-600">{t('idpTitle')}</span>
        </div>
        <h1 className="text-2xl font-bold text-gray-900">{t('idpTitle')}</h1>
        <p className="text-sm text-gray-500 mt-1">
          {t('idpSubtitle')}
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
                {t(item.labelKey)}
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
              <span className="inline-flex items-center rounded bg-blue-100 text-blue-700 px-2 py-0.5 text-xs font-medium flex-shrink-0">{t('vaultBadge')}</span>
              <p className="text-xs text-gray-600 leading-6">
                {t('vaultDesc')}
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
                            <div className="font-semibold text-gray-900">{t(meta.labelKey)}</div>
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
                          {configured ? (provider.is_enabled ? t('statusConfigured') : t('statusDisabledBadge')) : t('statusUnconfigured')}
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
                            <span className="text-sm">{t('fillCred')}</span>
                          </div>
                        )}
                      </div>

                      <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
                        <span>{t('enabledAppCount', { n: provider?.enabled_client_count ?? 0 })}</span>
                        <span className="text-blue-600 font-medium">{configured ? t('editCred') : t('startConfig')}</span>
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
              <span className="inline-flex items-center rounded bg-emerald-100 text-emerald-700 px-2 py-0.5 text-xs font-medium flex-shrink-0">{t('appsBadge')}</span>
              <p className="text-xs text-gray-600 leading-6">
                {t('appsDesc')}
              </p>
            </div>
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-gray-500">{t('appsListHint')}</p>
              <button onClick={openAppDrawerForCreate} className="btn-primary whitespace-nowrap">
                <i className="fas fa-plus mr-2"></i>
                {t('registerApp')}
              </button>
            </div>

            <div className="overflow-hidden rounded-xl border border-gray-200">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-5 py-3 text-left font-medium">{t('thAppName')}</th>
                    <th className="px-5 py-3 text-left font-medium">Client ID</th>
                    <th className="px-5 py-3 text-left font-medium">{t('thEnabledProvider')}</th>
                    <th className="px-5 py-3 text-left font-medium">{t('thRedirect')}</th>
                    <th className="px-5 py-3 text-left font-medium">PKCE</th>
                    <th className="px-5 py-3 text-left font-medium">{t('thStatus')}</th>
                    <th className="px-5 py-3 text-right font-medium">{t('thActions')}</th>
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
                        {t('emptyApps')}
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
                                <span className="text-xs text-gray-400">{t('notEnabled')}</span>
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
                              {client.require_pkce ? t('pkceForced') : t('pkceOptional')}
                            </span>
                          </td>
                          <td className="px-5 py-4">
                            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                              client.is_active
                                ? 'bg-green-100 text-green-700'
                                : 'bg-gray-100 text-gray-600'
                            }`}>
                              {client.is_active ? t('appActive') : t('appInactive')}
                            </span>
                          </td>
                          <td className="px-5 py-4 text-right">
                            <button
                              onClick={() => openAppDrawerForEdit(client)}
                              className="text-sm text-blue-600 hover:text-blue-800"
                            >
                              <i className="fas fa-pen mr-1"></i>
                              {t('edit')}
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
                    <p className="text-[13px] font-semibold text-sky-900">{t('discoveryTitle')}</p>
                    <span className="rounded-full bg-sky-500 px-2 py-0.5 text-[10px] font-medium text-white">{t('autoConfig')}</span>
                  </div>
                  <p className="mb-2.5 text-xs leading-6 text-sky-700">
                    {t.rich('discoveryDesc', { code: (c) => <code className="rounded bg-white/60 px-1 py-0.5 font-mono">{c}</code> })}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex min-w-0 max-w-2xl flex-1 items-center overflow-hidden rounded-md border border-sky-200 bg-white">
                      <code className="flex-1 truncate px-3 py-2 font-mono text-xs text-sky-700">{discoveryUrl}</code>
                      <button
                        onClick={() => copyText(discoveryUrl)}
                        className="flex items-center gap-1 whitespace-nowrap border-l border-sky-200 bg-sky-50 px-3 py-2 text-[11px] text-sky-700 hover:bg-sky-100"
                      >
                        <i className="fas fa-copy text-[10px]"></i>{t('copy')}
                      </button>
                    </div>
                    <button
                      onClick={() => setGuideOpen((v) => !v)}
                      className="flex items-center gap-1.5 whitespace-nowrap rounded-md bg-sky-500 px-3.5 py-2 text-[11px] font-medium text-white hover:bg-sky-600"
                    >
                      <i className="fas fa-book-open text-[9px]"></i>
                      {t('viewGuide')}
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
                    { key: 'steps', label: t('guideSteps'), icon: 'fas fa-list-check' },
                    { key: 'discovery', label: t('guideDiscovery'), icon: 'fas fa-file-code' },
                    { key: 'sdk', label: t('guideSdk'), icon: 'fas fa-code' },
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
                          <p className="mb-1 text-[13px] font-semibold text-gray-900">{t('step1Title')}</p>
                          <p className="text-xs leading-6 text-gray-500">
                            {t.rich('step1Desc', { c: (c) => <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px]">{c}</code> })}
                          </p>
                          {clients.length > 0 && (
                            <span className="mt-2 inline-flex items-center gap-1 rounded bg-green-50 px-2 py-0.5 text-[11px] text-green-700">
                              <i className="fas fa-check text-[8px]"></i>{t('done')}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex gap-3 rounded-lg border border-gray-100 bg-gray-50 p-3.5">
                        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-sky-100 text-[11px] font-bold text-sky-600">2</div>
                        <div>
                          <p className="mb-1 text-[13px] font-semibold text-gray-900">{t('step2Title')}</p>
                          <p className="text-xs leading-6 text-gray-500">
                            {t.rich('step2Desc', { code: (c) => <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px]">{c}</code> })}
                          </p>
                        </div>
                      </div>

                      <div className="flex gap-3 rounded-lg border border-gray-100 bg-gray-50 p-3.5">
                        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-sky-100 text-[11px] font-bold text-sky-600">3</div>
                        <div>
                          <p className="mb-1 text-[13px] font-semibold text-gray-900">{t('step3Title')}</p>
                          <p className="text-xs leading-6 text-gray-500">
                            {t('step3Desc')}
                          </p>
                        </div>
                      </div>

                      <div className="flex gap-3 rounded-lg border border-green-200 bg-green-50 p-3.5">
                        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-green-600">
                          <i className="fas fa-flag-checkered text-[10px] text-white"></i>
                        </div>
                        <div>
                          <p className="mb-1 text-[13px] font-semibold text-green-700">{t('doneTitle')}</p>
                          <p className="text-xs leading-6 text-green-800">
                            {t.rich('doneDesc', { code: (c) => <code className="rounded bg-black/5 px-1 py-0.5 font-mono text-[11px]">{c}</code> })}
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* 核心端点速查 */}
                    <div className="overflow-hidden rounded-lg border border-gray-100">
                      <div className="border-b border-gray-100 bg-gray-50 px-4 py-2">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                          {t('coreEndpoints')}
                        </span>
                      </div>
                      <table className="w-full border-collapse text-xs">
                        <tbody>
                          {[
                            [t('epAuthorize'), `${callbackBase}/oauth2/authorize`],
                            [t('epToken'), `${callbackBase}/oauth2/token`],
                            [t('epUserinfo'), `${callbackBase}/oauth2/userinfo`],
                            [t('epJwks'), `${callbackBase}/.well-known/jwks.json`],
                            [t('epRevoke'), `${callbackBase}/oauth2/revoke`],
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
                      {t('discoveryResp')}
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
                        {t.rich('subTip', {
                          b: (c) => <strong>{c}</strong>,
                          code: (c) => <code className="rounded bg-black/5 px-1 py-0.5 font-mono text-[11px]">{c}</code>,
                        })}
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
                          {t.rich('sdkNextjs', {
                            b: (c) => <strong>{c}</strong>,
                            code: (c) => <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px]">{c}</code>,
                          })}
                        </p>
                        <div className="overflow-hidden rounded-lg bg-slate-800">
                          <div className="border-b border-slate-700 bg-slate-900 px-3.5 py-1.5 font-mono text-[11px] text-slate-500">auth.ts</div>
                          <pre className="m-0 overflow-x-auto p-4 font-mono text-xs leading-7 text-slate-200">
{`import NextAuth from "next-auth"

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [{
    id: "planeos",
    name: "PlaneOS",
    type: "oidc",
    // Only this one URL; other endpoints are auto-discovered
    issuer: "${callbackBase}",
    clientId: process.env.PLANEOS_CLIENT_ID,
    clientSecret: process.env.PLANEOS_CLIENT_SECRET,
  }],
})`}
                          </pre>
                        </div>
                      </div>
                    )}

                    {sdkTab === 'python' && (
                      <div>
                        <p className="mb-2.5 text-xs text-gray-500">
                          {t.rich('sdkPython', { b: (c) => <strong>{c}</strong> })}
                        </p>
                        <div className="overflow-hidden rounded-lg bg-slate-800">
                          <div className="border-b border-slate-700 bg-slate-900 px-3.5 py-1.5 font-mono text-[11px] text-slate-500">main.py</div>
                          <pre className="m-0 overflow-x-auto p-4 font-mono text-xs leading-7 text-slate-200">
{`from authlib.integrations.starlette_client import OAuth

oauth = OAuth()
oauth.register(
    name="planeos",
    client_id=PLANEOS_CLIENT_ID,
    client_secret=PLANEOS_CLIENT_SECRET,
    # Auto-load all endpoints from the Discovery URL
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
                          {t.rich('sdkIos', { b: (c) => <strong>{c}</strong> })}
                        </p>
                        <div className="overflow-hidden rounded-lg bg-slate-800">
                          <div className="border-b border-slate-700 bg-slate-900 px-3.5 py-1.5 font-mono text-[11px] text-slate-500">AuthManager.swift</div>
                          <pre className="m-0 overflow-x-auto p-4 font-mono text-xs leading-7 text-slate-200">
{`import AppAuth

let issuer = URL(string: "${callbackBase}")!

// Discovery is automatic — just pass the issuer
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
    // PKCE is handled automatically by AppAuth
}`}
                          </pre>
                        </div>
                      </div>
                    )}

                    {sdkTab === 'android' && (
                      <div>
                        <p className="mb-2.5 text-xs text-gray-500">
                          {t.rich('sdkAndroid', { b: (c) => <strong>{c}</strong> })}
                        </p>
                        <div className="overflow-hidden rounded-lg bg-slate-800">
                          <div className="border-b border-slate-700 bg-slate-900 px-3.5 py-1.5 font-mono text-[11px] text-slate-500">AuthActivity.kt</div>
                          <pre className="m-0 overflow-x-auto p-4 font-mono text-xs leading-7 text-slate-200">
{`import net.openid.appauth.*

val issuerUri = Uri.parse("${callbackBase}")

// One line for Discovery; all endpoints fetched automatically
AuthorizationServiceConfiguration.fetchFromIssuer(issuerUri) { config, ex ->
    val request = AuthorizationRequest.Builder(
        config!!,
        "<your_client_id>",
        ResponseTypeValues.CODE,
        Uri.parse("yourapp://auth/callback")
    )
    .setScope("openid email profile")
    .build()
    // AppAuth generates the PKCE code_verifier / code_challenge automatically
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
                {t('logsHint')}
              </p>
            </div>

            <div className="overflow-hidden rounded-xl border border-gray-200">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-5 py-3 text-left font-medium">{t('thTime')}</th>
                    <th className="px-5 py-3 text-left font-medium">{t('thApp')}</th>
                    <th className="px-5 py-3 text-left font-medium">Provider</th>
                    <th className="px-5 py-3 text-left font-medium">Sub</th>
                    <th className="px-5 py-3 text-left font-medium">{t('thUser')}</th>
                    <th className="px-5 py-3 text-left font-medium">{t('thExpires')}</th>
                    <th className="px-5 py-3 text-right font-medium">{t('thActions')}</th>
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
                        {t('emptySessions')}
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
                                {t('kicking')}
                              </>
                            ) : (
                              <>
                                <i className="fas fa-user-slash mr-1"></i>
                                {t('kick')}
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
                  placeholder={t('phSearchLog')}
                />
              </div>
              <select
                value={logProvider}
                onChange={(e) => setLogProvider(e.target.value)}
                className="input-base w-auto"
              >
                <option value="">{t('allProviders')}</option>
                {PROVIDERS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {t(p.labelKey)}
                  </option>
                ))}
              </select>
              <select
                value={logClient}
                onChange={(e) => setLogClient(e.target.value)}
                className="input-base w-auto"
              >
                <option value="">{t('allApps')}</option>
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
                    <th className="px-5 py-3 text-left font-medium">{t('thTime')}</th>
                    <th className="px-5 py-3 text-left font-medium">{t('thEvent')}</th>
                    <th className="px-5 py-3 text-left font-medium">Provider</th>
                    <th className="px-5 py-3 text-left font-medium">Sub</th>
                    <th className="px-5 py-3 text-left font-medium">{t('thApp')}</th>
                    <th className="px-5 py-3 text-left font-medium">{t('thStatus')}</th>
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
                        {t('emptyLogs')}
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
                              {t('statusSuccess')}
                            </span>
                          ) : (
                            <span
                              className="inline-flex items-center gap-1 rounded-full bg-red-50 text-red-700 px-2 py-0.5 text-xs font-medium border border-red-200"
                              title={log.error || ''}
                            >
                              <i className="fas fa-circle text-[6px]"></i>
                              {t('statusFailure')}
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
        title={t('providerDrawerTitle', { action: providerMap.get(providerForm.provider_type) ? t('editAction') : t('configAction'), name: (() => { const m = PROVIDERS.find((p) => p.key === providerForm.provider_type); return m ? t(m.labelKey) : providerForm.provider_type })() })}
        size="lg"
        footer={
          <div className="flex items-center justify-end gap-3">
            <button onClick={closeProviderDrawer} disabled={providerSaving} className="btn-default">
              {t('cancel')}
            </button>
            <button onClick={handleSaveProvider} disabled={providerSaving} className="btn-primary disabled:opacity-50">
              {providerSaving ? t('saving') : t('saveCred')}
            </button>
          </div>
        }
      >
        <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Provider</label>
              <input
                value={activeProviderMeta ? t(activeProviderMeta.labelKey) : providerForm.provider_type}
                disabled
                className="w-full input-base bg-gray-50 text-gray-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t('displayName')}</label>
              <input
                value={providerForm.display_name}
                onChange={(e) => setProviderForm((prev) => ({ ...prev, display_name: e.target.value }))}
                className="w-full input-base"
                placeholder={t('phButtonText')}
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
              placeholder={t('phClientId')}
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
                placeholder={providerMap.get(providerForm.provider_type) ? t('phSecretKeep') : t('phSecretNew')}
              />
              <p className="mt-1 text-xs text-gray-400">
                {t('secretHint')}
              </p>
            </div>
          )}

          {providerForm.provider_type === 'apple' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2 text-xs text-gray-500">
                {t.rich('appleHint', { code: (c) => <code className="bg-gray-100 px-1 rounded font-mono">{c}</code> })}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Team ID <span className="text-red-500">*</span>
                </label>
                <input
                  value={providerForm.appleTeamId}
                  onChange={(e) => setProviderForm((prev) => ({ ...prev, appleTeamId: e.target.value }))}
                  className="w-full input-base font-mono"
                  placeholder={t('phTeamId')}
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
                  placeholder={t('phKeyId')}
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  {t('applePrivateKeyLabel')} {!providerMap.get(providerForm.provider_type) && <span className="text-red-500">*</span>}
                </label>
                <textarea
                  rows={5}
                  value={providerForm.applePrivateKeyPem}
                  onChange={(e) => setProviderForm((prev) => ({ ...prev, applePrivateKeyPem: e.target.value }))}
                  className="w-full input-base font-mono"
                  placeholder={'-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----'}
                />
                <p className="mt-1 text-xs text-gray-400">
                  {t('appleKeyHint')}
                </p>
              </div>
            </div>
          )}

          {providerForm.provider_type === 'oidc' && (
            <div className="space-y-4 rounded-xl border border-indigo-100 bg-indigo-50/50 p-4">
              <div className="text-sm font-medium text-indigo-900">{t('oidcEndpoints')}</div>
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
              <div className="text-sm font-medium text-gray-800">{t('globalEnable')}</div>
              <div className="text-xs text-gray-500 mt-1">{t('globalEnableDesc')}</div>
            </div>
            <Toggle
              checked={providerForm.is_enabled}
              onChange={(v) => setProviderForm((prev) => ({ ...prev, is_enabled: v }))}
            />
          </div>

          <div className="rounded-xl border border-gray-200 bg-blue-50 p-4">
            <div className="text-sm font-medium text-gray-800 mb-2">
              <i className="fas fa-circle-info text-blue-500 mr-2"></i>
              {t('callbackAddr')}
            </div>
            <p className="text-xs text-gray-600 mb-2">
              {activeProviderMeta ? t(activeProviderMeta.callbackHintKey) : t('callbackHintDefault')}
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
        title={appForm.clientId ? t('appDrawerEditTitle') : t('appDrawerCreateTitle')}
        size="xl"
        footer={
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-gray-400">
              {t('secretOnceNote')}
            </div>
            <div className="flex items-center gap-3">
              <button onClick={closeAppDrawer} disabled={appSaving} className="btn-default">
                {t('cancel')}
              </button>
              <button onClick={handleSaveApp} disabled={appSaving} className="btn-primary disabled:opacity-50">
                {appSaving ? t('saving') : appForm.clientId ? t('saveApp') : t('registerApp')}
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
                  {t('copy')}
                </button>
                <button onClick={handleRotateSecret} className="text-sm text-orange-600 hover:text-orange-800">
                  {t('rotateSecret')}
                </button>
              </div>
            </div>
          )}

          {revealedSecret && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-amber-800">{t('saveSecretNow')}</div>
                  <p className="text-xs text-amber-700 mt-1">{t('secretOnceWarn')}</p>
                  <code className="mt-3 block rounded bg-white border border-amber-200 px-3 py-2 text-xs text-amber-900 break-all">
                    {revealedSecret}
                  </code>
                </div>
                <button onClick={() => copyText(revealedSecret)} className="text-sm text-amber-700 hover:text-amber-900 whitespace-nowrap">
                  {t('copy')}
                </button>
              </div>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                {t('appNameLabel')} <span className="text-red-500">*</span>
              </label>
              <input
                value={appForm.displayName}
                onChange={(e) => setAppForm((prev) => ({ ...prev, displayName: e.target.value }))}
                className="w-full input-base"
                placeholder={t('phAppName')}
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                {t('redirectLabel')} <span className="text-red-500">*</span>
              </label>
              <textarea
                rows={3}
                value={appForm.redirectUrisText}
                onChange={(e) => setAppForm((prev) => ({ ...prev, redirectUrisText: e.target.value }))}
                className="w-full input-base"
                placeholder={t('phRedirect')}
              />
              <p className="mt-1 text-xs text-gray-400">{t('redirectHint')}</p>
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
                        title={required ? t('oidcRequired') : ''}
                      >
                        {on && <i className="fas fa-check mr-1 text-[10px]"></i>}
                        {scope}
                        {required && <span className="ml-1 text-[10px] text-blue-400">{t('required')}</span>}
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
                    placeholder={t('phCustomScope')}
                  />
                  <button type="button" onClick={addCustomScope} className="btn-default whitespace-nowrap text-xs">
                    {t('add')}
                  </button>
                </div>
              </div>
              <p className="mt-1 text-xs text-gray-400">{t('scopesHint')}</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t('accessTtl')}</label>
              <input
                type="number"
                min={60}
                value={appForm.accessTokenTtl}
                onChange={(e) => setAppForm((prev) => ({ ...prev, accessTokenTtl: e.target.value }))}
                className="w-full input-base"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t('refreshTtl')}</label>
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
                <div className="text-sm font-medium text-gray-800">{t('forcePkce')}</div>
                <div className="text-xs text-gray-500 mt-1">{t('forcePkceDesc')}</div>
              </div>
              <Toggle
                checked={appForm.requirePkce}
                onChange={(v) => setAppForm((prev) => ({ ...prev, requirePkce: v }))}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-gray-200 p-4">
              <div>
                <div className="text-sm font-medium text-gray-800">{t('appEnable')}</div>
                <div className="text-xs text-gray-500 mt-1">{t('appEnableDesc')}</div>
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
                <div className="text-sm font-semibold text-gray-900">{t('providerPerm')}</div>
                <div className="text-xs text-gray-500 mt-1">{t('providerPermDesc')}</div>
              </div>
              <span className="text-[11px] rounded bg-gray-100 px-2 py-1 text-gray-500">{t('credManagedProject')}</span>
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
                        {t('configuredCredHeader')}
                      </span>
                    </div>
                    {usable.length === 0 ? (
                      <div className="px-4 py-4 text-xs text-gray-400">
                        {t('noUsableProvider')}
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
                            <div className="text-sm font-medium text-gray-900">{t(meta.labelKey)}</div>
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
                          {t('unconfiguredCredHeader')}
                        </span>
                      </div>
                      {unusable.map((meta) => {
                        const projectProvider = providerMap.get(meta.key)
                        const reason = projectProvider ? t('reasonDisabled') : t('reasonUnconfigured')
                        return (
                          <div
                            key={meta.key}
                            className="flex items-center gap-4 px-4 py-3 border-b border-gray-100 last:border-b-0 opacity-70"
                          >
                            <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-gray-100 text-gray-400">
                              <i className={meta.iconClass}></i>
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-gray-500">{t(meta.labelKey)}</div>
                              <div className="text-xs text-gray-400 mt-0.5">{reason}</div>
                            </div>
                            <button
                              type="button"
                              onClick={() => jumpToProviderVault(meta.key)}
                              className="text-xs text-blue-600 hover:text-blue-800 whitespace-nowrap"
                            >
                              {t('goConfigure')}
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
