'use client'

import { useState, useEffect } from 'react'
import { ssoAPI } from '@/lib/api'

interface SsoProvider {
  id: number
  provider_type: string
  display_name: string
  client_id: string
  authorization_url: string | null
  token_url: string | null
  userinfo_url: string | null
  scopes: string | null
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
    label: 'OIDC (自定义)',
    icon: 'fas fa-key',
    color: 'text-indigo-500',
    defaults: { display_name: 'OIDC Provider', scopes: 'openid email profile' },
  },
}

export default function SsoManagementPage() {
  const [providers, setProviders] = useState<SsoProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // 表单状态
  const [formData, setFormData] = useState({
    provider_type: 'google',
    display_name: 'Google',
    client_id: '',
    client_secret: '',
    authorization_url: '',
    token_url: '',
    userinfo_url: '',
    scopes: '',
  })

  const fetchProviders = async () => {
    try {
      const res = await ssoAPI.listProviders()
      setProviders(res.data || [])
    } catch {
      setMessage({ type: 'error', text: '加载 SSO Provider 列表失败' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchProviders() }, [])

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
      setMessage({ type: 'error', text: '请填写 Client ID 和 Client Secret' })
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
      })
      setMessage({ type: 'success', text: `${formData.display_name} SSO Provider 创建成功` })
      resetForm()
      fetchProviders()
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || '创建失败' })
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
      })
      setMessage({ type: 'success', text: 'SSO Provider 已更新' })
      resetForm()
      fetchProviders()
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || '更新失败' })
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
    })
    setShowForm(true)
  }

  const handleToggle = async (provider: SsoProvider) => {
    try {
      await ssoAPI.updateProvider(provider.id, { is_active: !provider.is_active })
      fetchProviders()
      setMessage({
        type: 'success',
        text: `${provider.display_name} 已${provider.is_active ? '禁用' : '启用'}`,
      })
    } catch {
      setMessage({ type: 'error', text: '操作失败' })
    }
  }

  const handleDelete = async (provider: SsoProvider) => {
    if (!confirm(`确定删除 ${provider.display_name} SSO 配置？关联用户的 SSO 登录将失效。`)) return
    try {
      await ssoAPI.deleteProvider(provider.id)
      setMessage({ type: 'success', text: `${provider.display_name} 已删除` })
      fetchProviders()
    } catch {
      setMessage({ type: 'error', text: '删除失败' })
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
    <div className="space-y-6 max-w-5xl">
      {/* 标题栏 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-3">
            <i className="fas fa-sign-in-alt text-indigo-500"></i>
            SSO 社交登录管理
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            配置 Google、Facebook、GitHub 等第三方登录，各 Provider 的 App ID / Secret 在此集中管理
          </p>
        </div>
        <button
          onClick={() => { resetForm(); setShowForm(true) }}
          className="px-4 py-2 bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 transition-colors flex items-center gap-2"
        >
          <i className="fas fa-plus"></i>
          添加 SSO Provider
        </button>
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
          <h3 className="text-lg font-medium text-gray-600 mb-2">尚未配置 SSO Provider</h3>
          <p className="text-sm text-gray-400 mb-4">
            添加 Google / Facebook / GitHub 等 SSO 登录方式，用户将可以通过第三方账号直接登录
          </p>
          <button
            onClick={() => { resetForm(); setShowForm(true) }}
            className="px-4 py-2 bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 transition-colors"
          >
            <i className="fas fa-plus mr-2"></i>创建第一个 SSO Provider
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
                        <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${
                          p.is_active
                            ? 'bg-green-100 text-green-700'
                            : 'bg-gray-100 text-gray-500'
                        }`}>
                          {p.is_active ? '已启用' : '已禁用'}
                        </span>
                      </div>
                      <div className="text-sm text-gray-500 mt-0.5 space-x-4">
                        <span>Client ID: <code className="text-xs bg-gray-100 px-1 rounded">{p.client_id.substring(0, 20)}...</code></span>
                        <span>关联用户: {p.linked_users}</span>
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
                      {p.is_active ? '禁用' : '启用'}
                    </button>
                    <button
                      onClick={() => handleEdit(p)}
                      className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
                    >
                      <i className="fas fa-edit mr-1"></i>编辑
                    </button>
                    <button
                      onClick={() => handleDelete(p)}
                      className="px-3 py-1.5 text-xs rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors"
                    >
                      <i className="fas fa-trash mr-1"></i>删除
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
              {editingId ? '编辑 SSO Provider' : '添加 SSO Provider'}
            </h3>
            <button onClick={resetForm} className="text-gray-400 hover:text-gray-600 text-lg">
              <i className="fas fa-times"></i>
            </button>
          </div>

          {/* Provider 类型选择 */}
          {!editingId && (
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">Provider 类型</label>
              <div className="grid grid-cols-4 gap-3">
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
              <label className="block text-sm font-medium text-gray-700">显示名称</label>
              <input
                type="text"
                value={formData.display_name}
                onChange={(e) => setFormData(prev => ({ ...prev, display_name: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm"
                placeholder="如：Google 登录"
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

          {/* OAuth2 凭证 */}
          <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
            <h4 className="text-sm font-medium text-yellow-800 mb-3 flex items-center gap-2">
              <i className="fas fa-key"></i>
              OAuth2 凭证（从第三方开发者后台获取）
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
                  placeholder="从开发者后台获取的 App ID"
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
                  placeholder={editingId ? '不修改请留空' : '从开发者后台获取的 Secret'}
                />
              </div>
            </div>
          </div>

          {/* 自定义端点（OIDC 必填） */}
          {formData.provider_type === 'oidc' && (
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-gray-700 flex items-center gap-2">
                <i className="fas fa-link"></i>
                OIDC 端点（自定义 Provider 必填）
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

          {/* 帮助提示 */}
          {formData.provider_type !== 'oidc' && (
            <div className="text-xs text-gray-500 bg-gray-50 rounded-lg p-3">
              <i className="fas fa-info-circle mr-1"></i>
              {formData.provider_type === 'google' && (
                <span>
                  前往 <a href="https://console.cloud.google.com/apis/credentials" target="_blank" className="text-indigo-600 underline">Google Cloud Console</a> 创建 OAuth 2.0 客户端 ID。回调地址设置为：<code className="bg-white px-1 rounded">{'{API_BASE_URL}'}/auth/sso/google/callback</code>
                </span>
              )}
              {formData.provider_type === 'facebook' && (
                <span>
                  前往 <a href="https://developers.facebook.com/apps" target="_blank" className="text-indigo-600 underline">Facebook Developers</a> 创建应用并获取 App ID 和 App Secret。
                </span>
              )}
              {formData.provider_type === 'github' && (
                <span>
                  前往 <a href="https://github.com/settings/developers" target="_blank" className="text-indigo-600 underline">GitHub Developer Settings</a> 创建 OAuth App。回调地址设置为：<code className="bg-white px-1 rounded">{'{API_BASE_URL}'}/auth/sso/github/callback</code>
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
              取消
            </button>
            <button
              onClick={editingId ? handleUpdate : handleCreate}
              disabled={saving}
              className="px-6 py-2 text-sm bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 disabled:opacity-50 transition-colors flex items-center gap-2"
            >
              {saving ? <i className="fas fa-spinner fa-spin"></i> : <i className="fas fa-save"></i>}
              {editingId ? '保存更改' : '创建 Provider'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
