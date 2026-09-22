'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { ssoAPI, adminAPI } from '@/lib/api'

interface TenantOption {
  id: number
  name: string
  slug: string
}

interface SsoProvider {
  id: number
  tenant_id: number
  provider_type: string
  display_name: string
  client_id: string
  authorization_url: string | null
  token_url: string | null
  userinfo_url: string | null
  scopes: string | null
  user_id_field?: string | null
  email_field?: string | null
  name_field?: string | null
  avatar_field?: string | null
  auto_role?: string | null
  is_active: boolean
  linked_users: number
  created_at: string
  updated_at: string
}

const PROVIDER_PRESETS: Record<string, { label: string; icon: string; color: string; defaults: Partial<SsoProvider> }> = {
  google: {
    label: 'Google',
    icon: 'fab fa-google',
    color: 'text-red-500',
    defaults: { display_name: 'Google', scopes: 'openid email profile' },
  },
  facebook: {
    label: 'Facebook',
    icon: 'fab fa-facebook',
    color: 'text-blue-600',
    defaults: { display_name: 'Facebook', scopes: 'email public_profile' },
  },
  github: {
    label: 'GitHub',
    icon: 'fab fa-github',
    color: 'text-gray-800',
    defaults: { display_name: 'GitHub', scopes: 'read:user user:email' },
  },
  oidc: {
    label: 'OIDC (Custom)',
    icon: 'fas fa-key',
    color: 'text-indigo-500',
    defaults: { display_name: 'OIDC Provider', scopes: 'openid email profile' },
  },
}

export default function SsoManagementPage() {
  const tr = useTranslations('platformSso')
  const t = useTranslations('platformSsoPage')
  const [providers, setProviders] = useState<SsoProvider[]>([])
  const [tenants, setTenants] = useState<TenantOption[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // 表单状态。tenant_id = 适用项目（通过该 Provider 登录后授予权限的项目）。
  const [formData, setFormData] = useState<{
    provider_type: string
    display_name: string
    client_id: string
    client_secret: string
    authorization_url: string
    token_url: string
    userinfo_url: string
    scopes: string
    user_id_field: string
    email_field: string
    name_field: string
    avatar_field: string
    auto_role: string
    tenant_id: number | null
  }>({
    provider_type: 'google',
    display_name: 'Google',
    client_id: '',
    client_secret: '',
    authorization_url: '',
    token_url: '',
    userinfo_url: '',
    scopes: '',
    user_id_field: '',
    email_field: '',
    name_field: '',
    avatar_field: '',
    auto_role: 'member',
    tenant_id: null,
  })

  // 列出所有项目下的 Provider（超管视角），每条带自己的 tenant_id。
  const fetchAllProviders = async (tenantList: TenantOption[]) => {
    if (tenantList.length === 0) {
      setProviders([])
      setLoading(false)
      return
    }
    try {
      const results = await Promise.all(
        tenantList.map((t) =>
          ssoAPI
            .listProviders(t.id)
            .then((r) => (r.data || []) as SsoProvider[])
            .catch(() => [] as SsoProvider[])
        )
      )
      // 按 provider id 去重，防御上游租户列表重复导致的同一 Provider 多次出现。
      const byId = new Map<number, SsoProvider>()
      for (const p of results.flat()) byId.set(p.id, p)
      setProviders(Array.from(byId.values()))
    } catch {
      setMessage({ type: 'error', text: tr('loadProvidersFailed') })
    } finally {
      setLoading(false)
    }
  }

  // SSO 配置按项目（租户）隔离，超管可在表单里为每个 Provider 指定适用项目
  const loadTenants = async () => {
    try {
      const res = await adminAPI.listAllTenants()
      // /api/admin/all-tenants 对每个主库做 LEFT JOIN，租户有多条主库时会重复，
      // 这里按 id 去重，避免项目下拉与 Provider 列表出现重复项。
      const seen = new Set<number>()
      const opts: TenantOption[] = (res.data || [])
        .map((t: any) => ({ id: t.id, name: t.name, slug: t.slug }))
        .filter((t: TenantOption) => {
          if (seen.has(t.id)) return false
          seen.add(t.id)
          return true
        })
      setTenants(opts)
      await fetchAllProviders(opts)
    } catch {
      setMessage({ type: 'error', text: tr('loadTenantsFailed') })
      setLoading(false)
    }
  }

  useEffect(() => { loadTenants() }, [])

  const tenantName = (id: number | null | undefined) =>
    tenants.find((t) => t.id === id)?.name ?? tr('unknownProject')

  const resetForm = () => {
    setFormData({
      provider_type: 'google',
      display_name: 'Google',
      client_id: '',
      client_secret: '',
      authorization_url: '',
      token_url: '',
      userinfo_url: '',
      scopes: '',
      user_id_field: '',
      email_field: '',
      name_field: '',
      avatar_field: '',
      auto_role: 'member',
      tenant_id: tenants[0]?.id ?? null,
    })
    setEditingId(null)
    setShowForm(false)
  }

  const handleProviderTypeChange = (type: string) => {
    const preset = PROVIDER_PRESETS[type]
    setFormData(prev => ({
      ...prev,
      provider_type: type,
      display_name: preset?.defaults.display_name || type,
      scopes: preset?.defaults.scopes || 'openid email profile',
      authorization_url: '',
      token_url: '',
      userinfo_url: '',
    }))
  }

  const handleCreate = async () => {
    if (!formData.client_id || !formData.client_secret) {
      setMessage({ type: 'error', text: tr('fillClientId') })
      return
    }
    if (!formData.tenant_id) {
      setMessage({ type: 'error', text: tr('selectProject') })
      return
    }
    setSaving(true)
    try {
      await ssoAPI.createProvider({
        provider_type: formData.provider_type,
        display_name: formData.display_name,
        client_id: formData.client_id,
        client_secret: formData.client_secret,
        authorization_url: formData.authorization_url || undefined,
        token_url: formData.token_url || undefined,
        userinfo_url: formData.userinfo_url || undefined,
        scopes: formData.scopes || undefined,
        user_id_field: formData.user_id_field || undefined,
        email_field: formData.email_field || undefined,
        name_field: formData.name_field || undefined,
        avatar_field: formData.avatar_field || undefined,
        auto_role: formData.auto_role || undefined,
      }, formData.tenant_id)
      setMessage({ type: 'success', text: tr('createOk', { name: formData.display_name }) })
      resetForm()
      fetchAllProviders(tenants)
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || tr('createFailed') })
    } finally {
      setSaving(false)
    }
  }

  const handleUpdate = async () => {
    if (editingId === null) return
    setSaving(true)
    try {
      await ssoAPI.updateProvider(editingId, {
        display_name: formData.display_name,
        client_id: formData.client_id,
        client_secret: formData.client_secret || undefined,
        authorization_url: formData.authorization_url || undefined,
        token_url: formData.token_url || undefined,
        userinfo_url: formData.userinfo_url || undefined,
        scopes: formData.scopes || undefined,
        user_id_field: formData.user_id_field || undefined,
        email_field: formData.email_field || undefined,
        name_field: formData.name_field || undefined,
        avatar_field: formData.avatar_field || undefined,
        auto_role: formData.auto_role || undefined,
      }, formData.tenant_id ?? undefined)
      setMessage({ type: 'success', text: tr('updateOk') })
      resetForm()
      fetchAllProviders(tenants)
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || tr('updateFailed') })
    } finally {
      setSaving(false)
    }
  }

  const handleEdit = (provider: SsoProvider) => {
    setEditingId(provider.id)
    setFormData({
      provider_type: provider.provider_type,
      display_name: provider.display_name,
      client_id: provider.client_id,
      client_secret: '',
      authorization_url: provider.authorization_url || '',
      token_url: provider.token_url || '',
      userinfo_url: provider.userinfo_url || '',
      scopes: provider.scopes || '',
      user_id_field: provider.user_id_field || '',
      email_field: provider.email_field || '',
      name_field: provider.name_field || '',
      avatar_field: provider.avatar_field || '',
      auto_role: provider.auto_role || 'member',
      tenant_id: provider.tenant_id,
    })
    setShowForm(true)
  }

  const handleToggle = async (provider: SsoProvider) => {
    try {
      await ssoAPI.updateProvider(provider.id, { is_active: !provider.is_active }, provider.tenant_id)
      fetchAllProviders(tenants)
      setMessage({
        type: 'success',
        text: tr('toggled', { name: provider.display_name, state: provider.is_active ? tr('disabledState') : tr('enabledState') }),
      })
    } catch {
      setMessage({ type: 'error', text: tr('toggleFailed') })
    }
  }

  const handleDelete = async (provider: SsoProvider) => {
    if (!confirm(tr('confirmDelete', { name: provider.display_name }))) return
    try {
      await ssoAPI.deleteProvider(provider.id, provider.tenant_id)
      setMessage({ type: 'success', text: tr('deleteOk', { name: provider.display_name }) })
      fetchAllProviders(tenants)
    } catch {
      setMessage({ type: 'error', text: tr('deleteFailed') })
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <i className="fas fa-spinner fa-spin text-2xl text-gray-400"></i>
      </div>
    )
  }

  return (
    <div className="w-full space-y-6">
      {/* 标题栏 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-3">
            <i className="fas fa-sign-in-alt text-indigo-500"></i>
            {tr('title')}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {tr('subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => { resetForm(); setShowForm(true) }}
            disabled={tenants.length === 0}
            className="px-4 py-2 bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            <i className="fas fa-plus"></i>
            {tr('addBtn')}
          </button>
        </div>
      </div>

      {/* 消息提示 */}
      {message && (
        <div className={`flex items-center gap-2 p-3 rounded-lg text-sm border ${
          message.type === 'success'
            ? 'bg-green-50 border-green-200 text-green-700'
            : 'bg-red-50 border-red-200 text-red-700'
        }`}>
          <i className={`fas fa-${message.type === 'success' ? 'check-circle' : 'exclamation-circle'}`}></i>
          {message.text}
          <button onClick={() => setMessage(null)} className="ml-auto text-lg leading-none">&times;</button>
        </div>
      )}

      {/* Provider 列表 */}
      {providers.length === 0 && !showForm ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <i className="fas fa-puzzle-piece text-4xl text-gray-300 mb-4"></i>
          <h3 className="text-lg font-medium text-gray-600 mb-2">{tr('emptyTitle')}</h3>
          <p className="text-sm text-gray-400 mb-4">
            {tr('emptyDesc')}
          </p>
          <button
            onClick={() => { resetForm(); setShowForm(true) }}
            className="px-4 py-2 bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 transition-colors"
          >
            <i className="fas fa-plus mr-2"></i>{tr('createFirst')}
          </button>
        </div>
      ) : (
        <div className="grid gap-4">
          {providers.map((p) => {
            const preset = PROVIDER_PRESETS[p.provider_type] || PROVIDER_PRESETS.oidc
            return (
              <div key={p.id} className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md transition-shadow">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-xl bg-gray-50 flex items-center justify-center ${preset.color}`}>
                      <i className={`${preset.icon} text-xl`}></i>
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-gray-800">{p.display_name}</h3>
                        <span className="px-2 py-0.5 text-xs rounded-full font-medium bg-indigo-100 text-indigo-700">
                          <i className="fas fa-folder mr-1"></i>{tenantName(p.tenant_id)}
                        </span>
                        <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${
                          p.is_active
                            ? 'bg-green-100 text-green-700'
                            : 'bg-gray-100 text-gray-500'
                        }`}>
                          {p.is_active ? tr('enabled') : tr('disabled')}
                        </span>
                      </div>
                      <div className="text-sm text-gray-500 mt-0.5 space-x-4">
                        <span>Client ID: <code className="text-xs bg-gray-100 px-1 rounded">{p.client_id.substring(0, 20)}...</code></span>
                        <span>{tr('linkedUsers', { n: p.linked_users })}</span>
                        <span>{tr('grantedRole')}<code className="text-xs bg-indigo-50 text-indigo-700 px-1 rounded">{p.auto_role || 'member'}</code></span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleToggle(p)}
                      className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                        p.is_active
                          ? 'border-orange-200 text-orange-600 hover:bg-orange-50'
                          : 'border-green-200 text-green-600 hover:bg-green-50'
                      }`}
                    >
                      {p.is_active ? tr('disable') : tr('enable')}
                    </button>
                    <button
                      onClick={() => handleEdit(p)}
                      className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
                    >
                      <i className="fas fa-edit mr-1"></i>{tr('edit')}
                    </button>
                    <button
                      onClick={() => handleDelete(p)}
                      className="px-3 py-1.5 text-xs rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors"
                    >
                      <i className="fas fa-trash mr-1"></i>{tr('delete')}
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 创建/编辑表单 */}
      {showForm && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-800">
              {editingId ? tr('editTitle') : tr('addTitle')}
            </h3>
            <button onClick={resetForm} className="text-gray-400 hover:text-gray-600 text-lg">
              <i className="fas fa-times"></i>
            </button>
          </div>

          {/* Provider 类型选择 */}
          {!editingId && (
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">{tr('providerType')}</label>
              <div className="grid grid-cols-5 gap-3">
                {Object.entries(PROVIDER_PRESETS).map(([type, preset]) => (
                  <button
                    key={type}
                    onClick={() => handleProviderTypeChange(type)}
                    className={`p-3 rounded-lg border-2 transition-all text-center ${
                      formData.provider_type === type
                        ? 'border-indigo-500 bg-indigo-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <i className={`${preset.icon} ${preset.color} text-xl mb-1`}></i>
                    <div className="text-xs font-medium text-gray-700">{preset.label}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 基本信息 */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">{tr('displayName')}</label>
              <input
                type="text"
                value={formData.display_name}
                onChange={(e) => setFormData(prev => ({ ...prev, display_name: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm"
                placeholder={tr('displayNamePlaceholder')}
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">Scopes</label>
              <input
                type="text"
                value={formData.scopes}
                onChange={(e) => setFormData(prev => ({ ...prev, scopes: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm"
                placeholder="openid email profile"
              />
            </div>
          </div>

          {/* 适用范围 / 自动授予角色 */}
          <div className="p-4 bg-indigo-50 border border-indigo-200 rounded-lg space-y-3">
            <h4 className="text-sm font-medium text-indigo-800 flex items-center gap-2">
              <i className="fas fa-users-cog"></i>
              {tr('scopeRole')}
            </h4>
            <p className="text-xs text-indigo-700">
              {tr('scopeDesc1')}<span className="font-semibold">{tr('scopeDescStrong')}</span>{tr('scopeDesc2')}
            </p>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700">
                  {tr('applicableProject')} <span className="text-red-500">*</span>
                </label>
                {editingId ? (
                  // 已存在的 Provider 不支持改所属项目（会影响已关联用户）；只读展示。
                  <input
                    type="text"
                    value={`${tenantName(formData.tenant_id)}`}
                    disabled
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-100 text-gray-500"
                  />
                ) : (
                  <select
                    value={formData.tenant_id ?? ''}
                    onChange={(e) => setFormData(prev => ({ ...prev, tenant_id: e.target.value ? Number(e.target.value) : null }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm bg-white"
                  >
                    {tenants.length === 0 && <option value="">{tr('noProject')}</option>}
                    {tenants.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}（{t.slug}）</option>
                    ))}
                  </select>
                )}
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700">{tr('grantRole')}</label>
                <select
                  value={formData.auto_role}
                  onChange={(e) => setFormData(prev => ({ ...prev, auto_role: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm bg-white"
                >
                  <option value="admin">{tr('roleAdmin')}</option>
                  <option value="member">{tr('roleMember')}</option>
                  <option value="viewer">{tr('roleViewer')}</option>
                  <option value="owner">{tr('roleOwner')}</option>
                </select>
              </div>
            </div>
          </div>

          {/* OAuth2 凭证 */}
          <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
            <h4 className="text-sm font-medium text-yellow-800 mb-3 flex items-center gap-2">
              <i className="fas fa-key"></i>
              {tr('oauthCred')}
            </h4>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700">
                  Client ID <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={formData.client_id}
                  onChange={(e) => setFormData(prev => ({ ...prev, client_id: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm font-mono"
                  placeholder={tr('appIdPlaceholder')}
                />
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700">
                  Client Secret <span className="text-red-500">*</span>
                </label>
                <input
                  type="password"
                  value={formData.client_secret}
                  onChange={(e) => setFormData(prev => ({ ...prev, client_secret: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm font-mono"
                  placeholder={editingId ? tr('secretPlaceholderEdit') : tr('secretPlaceholder')}
                />
              </div>
            </div>
          </div>

          {/* 自定义端点（OIDC 必填或可覆盖） */}
          {formData.provider_type === 'oidc' && (
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-gray-700 flex items-center gap-2">
                <i className="fas fa-link"></i>
                {tr('endpointOidc')}
              </h4>
              <div className="grid grid-cols-1 gap-3">
                <div className="space-y-1">
                  <label className="block text-xs text-gray-500">Authorization URL</label>
                  <input
                    type="url"
                    value={formData.authorization_url}
                    onChange={(e) => setFormData(prev => ({ ...prev, authorization_url: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
                    placeholder="https://your-idp.com/authorize"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-xs text-gray-500">Token URL</label>
                  <input
                    type="url"
                    value={formData.token_url}
                    onChange={(e) => setFormData(prev => ({ ...prev, token_url: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
                    placeholder="https://your-idp.com/token"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-xs text-gray-500">UserInfo URL</label>
                  <input
                    type="url"
                    value={formData.userinfo_url}
                    onChange={(e) => setFormData(prev => ({ ...prev, userinfo_url: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
                    placeholder="https://your-idp.com/userinfo"
                  />
                </div>
              </div>
            </div>
          )}

          {/* userinfo 字段映射（OIDC 可覆盖，留空用默认 sub/email/name/picture） */}
          {formData.provider_type === 'oidc' && (
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-gray-700 flex items-center gap-2">
                <i className="fas fa-user-tag"></i>
                {tr('fieldMapping')}
              </h4>
              <div className="grid grid-cols-4 gap-3">
                <div className="space-y-1">
                  <label className="block text-xs text-gray-500">{tr('userIdField')}</label>
                  <input
                    type="text"
                    value={formData.user_id_field}
                    onChange={(e) => setFormData(prev => ({ ...prev, user_id_field: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
                    placeholder="sub"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-xs text-gray-500">{tr('emailField')}</label>
                  <input
                    type="text"
                    value={formData.email_field}
                    onChange={(e) => setFormData(prev => ({ ...prev, email_field: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
                    placeholder="email"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-xs text-gray-500">{tr('nameField')}</label>
                  <input
                    type="text"
                    value={formData.name_field}
                    onChange={(e) => setFormData(prev => ({ ...prev, name_field: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
                    placeholder="name"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-xs text-gray-500">{tr('avatarField')}</label>
                  <input
                    type="text"
                    value={formData.avatar_field}
                    onChange={(e) => setFormData(prev => ({ ...prev, avatar_field: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
                    placeholder="picture"
                  />
                </div>
              </div>
            </div>
          )}

          {/* 帮助提示 */}
          {['google', 'facebook', 'github'].includes(formData.provider_type) && (
            <div className="text-xs text-gray-500 bg-gray-50 rounded-lg p-3">
              <i className="fas fa-info-circle mr-1"></i>
              {formData.provider_type === 'google' && (
                <span>
                  {t.rich('googleHelp', {
                    link: (chunks) => (
                      <a href="https://console.cloud.google.com/apis/credentials" target="_blank" className="text-indigo-600 underline">{chunks}</a>
                    ),
                    code: (chunks) => (
                      <code className="bg-white px-1 rounded">{chunks}</code>
                    ),
                  })}
                </span>
              )}
              {formData.provider_type === 'facebook' && (
                <span>
                  {t.rich('facebookHelp', {
                    link: (chunks) => (
                      <a href="https://developers.facebook.com/apps" target="_blank" className="text-indigo-600 underline">{chunks}</a>
                    ),
                  })}
                </span>
              )}
              {formData.provider_type === 'github' && (
                <span>
                  {t.rich('githubHelp', {
                    link: (chunks) => (
                      <a href="https://github.com/settings/developers" target="_blank" className="text-indigo-600 underline">{chunks}</a>
                    ),
                    code: (chunks) => (
                      <code className="bg-white px-1 rounded">{chunks}</code>
                    ),
                  })}
                </span>
              )}
            </div>
          )}

          {/* 操作按钮 */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              onClick={resetForm}
              className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              {tr('cancel')}
            </button>
            <button
              onClick={editingId ? handleUpdate : handleCreate}
              disabled={saving}
              className="px-6 py-2 text-sm bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 disabled:opacity-50 transition-colors flex items-center gap-2"
            >
              {saving ? <i className="fas fa-spinner fa-spin"></i> : <i className="fas fa-save"></i>}
              {editingId ? tr('saveChanges') : tr('createProvider')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
