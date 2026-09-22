'use client'

/**
 * `/workspace/[projectId]/security/api-keys` —— 项目 API Key 管理（W3 Task 2）。
 *
 * 历史：早期跟"REST API 概览 / 文档"挤在一个 `/api` 页面里三个 tab。问题：
 *   - keys tab 是写操作（创建 / 删除 / 启用禁用），要求 admin+ 角色
 *   - overview / docs 是只读，所有项目成员可看
 *   - 一张页面承担两种心智的访问门槛，sidebar 也只能给"全开"或"全锁"
 *
 * W3 拆出来：本页只管 keys；`/api` 页面保留 overview + docs（只读）。
 * sidebar 把 "API Key" 条目放进"安全"分组，与其他写操作（角色 / RLS / RPC ACL）
 * 并列；门槛 `canManageSecurity`（admin / owner / 超管）。
 */

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { apiKeyAPI, patAPI } from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { useNotification } from '@/hooks/useNotification'
import Drawer from '@/components/Drawer'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'

interface ApiKey {
  id: number
  name: string
  key_prefix: string
  permissions: { read: boolean; write: boolean; delete: boolean }
  is_active: boolean
  last_used_at: string | null
  created_at: string
  expires_at: string | null
  created_by: number | null
  created_by_name: string | null
  created_by_email: string | null
}

export default function ApiKeysPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  // ⚠️ database_id 必须从项目主连接拿，**不能**直接用 projectId。
  // 历史教训（commit 1957ed5 的 bug）：W2 当时假设 `projectId === database_id`，
  // 但这只对 M2 自助开通的新项目成立；老租户里 tenants.id 和
  // tenant_databases.id 是两个独立自增序列，几乎一定不相等——用 projectId
  // 当 database_id 查 management.api_keys 会查到别的 db 的数据（或空），
  // 用户会以为"我以前建的 key 没了"。
  // workspace layout 已经从 /api/projects/:id 拉到 primary_connection.database_id
  // 并铺到 currentConnection，这里直接读就行。
  const currentConnection = useAppStore((s) => s.currentConnection)
  const currentProject = useAppStore((s) => s.currentProject)
  // 必须属于当前项目，防止残留的上一项目 currentConnection 把 key 列到错误项目下。
  const connectionForProject =
    currentConnection?.tenant_id === projectId ? currentConnection : null
  const databaseId = connectionForProject?.database_id ?? null
  const databaseSlug = connectionForProject?.database_slug || null
  const dbRouteSeg = databaseSlug || null
  const caps = useCurrentProjectCapabilities()
  const t = useTranslations('wsApiKeys')
  const notify = useNotification()

  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreateDrawer, setShowCreateDrawer] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [newKeyData, setNewKeyData] = useState({
    name: '',
    permissions: { read: true, write: true, delete: true },
    expires_in_days: 0,
    // 新版细粒度 scope。EXECUTE 必须从这里开。详见与 `/api` 页相同的注释。
    advancedEnabled: false,
    allowedActions: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as string[],
    allowedResources: '',
  })

  const resetForm = () => {
    setNewKeyData({
      name: '',
      permissions: { read: true, write: true, delete: true },
      expires_in_days: 0,
      advancedEnabled: false,
      allowedActions: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      allowedResources: '',
    })
    setCreatedKey(null)
  }

  const loadApiKeys = async () => {
    if (!dbRouteSeg) return
    try {
      const response = await apiKeyAPI.list(dbRouteSeg)
      setApiKeys(response.data)
    } catch (err: any) {
      notify.error(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (dbRouteSeg) loadApiKeys()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbRouteSeg])

  const handleCreateKey = async () => {
    if (!dbRouteSeg || !newKeyData.name.trim()) {
      notify.warning(t('errName'))
      return
    }
    setCreating(true)
    try {
      const payload: Record<string, unknown> = {
        name: newKeyData.name,
        permissions: newKeyData.permissions,
        expires_in_days: newKeyData.expires_in_days || undefined,
      }
      if (newKeyData.advancedEnabled) {
        payload.allowed_actions = newKeyData.allowedActions
        const resources = newKeyData.allowedResources
          .split(/[,\n]/)
          .map((s) => s.trim())
          .filter(Boolean)
        if (resources.length) payload.allowed_resources = resources
      }
      // 见 /api 页同位置的 cast 说明：apiKeyAPI.create 的 type 没涵盖 allowed_*
      // 字段，但后端实际接受。
      const response = await apiKeyAPI.create(dbRouteSeg, payload as any)
      setCreatedKey(response.data.api_key)
      notify.success(t('createOk'))
      loadApiKeys()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setCreating(false)
    }
  }

  const handleDeleteKey = async (keyId: number, keyName: string) => {
    if (!dbRouteSeg) return
    if (!confirm(t('confirmDelete', { name: keyName }))) return
    try {
      await apiKeyAPI.delete(dbRouteSeg, keyId)
      notify.success(t('deleted'))
      loadApiKeys()
    } catch (err: any) {
      notify.error(err)
    }
  }

  const handleToggleKey = async (keyId: number, isActive: boolean) => {
    if (!dbRouteSeg) return
    try {
      await apiKeyAPI.update(dbRouteSeg, keyId, { is_active: !isActive })
      notify.success(isActive ? t('keyDisabled') : t('keyEnabled'))
      loadApiKeys()
    } catch (err: any) {
      notify.error(err)
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    notify.success(t('copied'))
  }

  if (!caps.canManageSecurity) {
    return (
      <ForbiddenPlaceholder reason={t('forbidden')} />
    )
  }

  if (isNaN(projectId)) {
    return (
      <div className="p-8 text-center text-gray-500">
        {t('invalidProject')}
      </div>
    )
  }

  if (!databaseId) {
    // 项目存在但没有主连接（M2 自助开通向导跳过 / 老租户没绑库）。
    // 没 database_id 就拿不到 / 也不能创建 API Key——API Key 必须挂在
    // 某个具体的 tenant_databases 行上。引导用户先建/绑连接。
    return (
      <div className="p-8 text-center text-gray-500 space-y-3">
        <i className="fas fa-plug text-4xl text-gray-300"></i>
        <p>{t('noConn')}</p>
        <Link
          href={`/workspace/${projectId}/settings/connections`}
          className="text-blue-600 hover:underline"
        >
          {t('goConn')}
        </Link>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      {currentProject?.via_organization && (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-4">
          {t('viaOrgNote')}
        </p>
      )}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">API Key</h1>
          <p className="text-gray-600 mt-1 text-sm">
            {t.rich('subtitle', {
              seg: dbRouteSeg || '-',
              a: (c) => (
                <a href={`/workspace/${projectId}/api`} className="text-blue-600 hover:underline">{c}</a>
              ),
            })}
          </p>
        </div>
        <button
          onClick={() => {
            resetForm()
            setShowCreateDrawer(true)
          }}
          className="btn-primary"
        >
          <i className="fas fa-plus mr-2"></i>
          {t('createKey')}
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-12 text-center">
            <i className="fas fa-spinner fa-spin text-2xl text-gray-400"></i>
          </div>
        ) : apiKeys.length === 0 ? (
          <div className="p-12 text-center text-gray-500">
            <i className="fas fa-key text-4xl mb-4 text-gray-300"></i>
            <p className="mb-4">{t('emptyKeys')}</p>
            <button
              onClick={() => {
                resetForm()
                setShowCreateDrawer(true)
              }}
              className="btn-primary"
            >
              <i className="fas fa-plus mr-2"></i>
              {t('createFirst')}
            </button>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {apiKeys.map((key) => (
              <div
                key={key.id}
                className="px-6 py-4 flex items-center justify-between hover:bg-gray-50"
              >
                <div className="flex items-center space-x-4">
                  <div
                    className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                      key.is_active ? 'bg-green-100' : 'bg-gray-100'
                    }`}
                  >
                    <i
                      className={`fas fa-key ${
                        key.is_active ? 'text-green-600' : 'text-gray-400'
                      }`}
                    ></i>
                  </div>
                  <div>
                    <p className="font-medium text-gray-900">{key.name}</p>
                    <p className="text-sm text-gray-500 font-mono">{key.key_prefix}</p>
                  </div>
                </div>
                <div className="flex items-center space-x-6">
                  <div
                    className="text-sm text-gray-500 truncate max-w-[10rem]"
                    title={key.created_by_email || undefined}
                  >
                    {t('createdBy', { name: key.created_by_name || t('unknown') })}
                  </div>
                  <div className="text-sm text-gray-500">
                    {key.last_used_at ? (
                      <span>{t('lastUsed', { time: new Date(key.last_used_at).toLocaleString() })}</span>
                    ) : (
                      <span>{t('neverUsed')}</span>
                    )}
                  </div>
                  <div className="flex items-center space-x-2">
                    <span
                      className={`text-xs px-2 py-1 rounded-full ${
                        key.permissions.read
                          ? 'bg-blue-100 text-blue-700'
                          : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {t('permRead')}
                    </span>
                    <span
                      className={`text-xs px-2 py-1 rounded-full ${
                        key.permissions.write
                          ? 'bg-green-100 text-green-700'
                          : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {t('permWrite')}
                    </span>
                    <span
                      className={`text-xs px-2 py-1 rounded-full ${
                        key.permissions.delete
                          ? 'bg-red-100 text-red-700'
                          : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {t('permDelete')}
                    </span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => handleToggleKey(key.id, key.is_active)}
                      className={`px-3 py-1 text-sm rounded-lg ${
                        key.is_active
                          ? 'text-yellow-700 hover:bg-yellow-50'
                          : 'text-green-700 hover:bg-green-50'
                      }`}
                    >
                      {key.is_active ? t('disable') : t('enable')}
                    </button>
                    <button
                      onClick={() => handleDeleteKey(key.id, key.name)}
                      className="px-3 py-1 text-sm text-red-600 hover:bg-red-50 rounded-lg"
                    >
                      {t('delete')}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 个人访问令牌（PAT）：MCP 工作流创作凭证，绑定当前用户而非项目 */}
      <PatSection />

      {/* 创建抽屉 */}
      <Drawer
        isOpen={showCreateDrawer}
        onClose={() => setShowCreateDrawer(false)}
        title={createdKey ? t('drawerSaveTitle') : t('drawerCreateTitle')}
        size="md"
        footer={
          createdKey ? (
            <button
              onClick={() => {
                setShowCreateDrawer(false)
                setCreatedKey(null)
              }}
              className="w-full btn-primary"
            >
              {t('savedClose')}
            </button>
          ) : (
            <div className="flex gap-3">
              <button
                onClick={() => setShowCreateDrawer(false)}
                className="flex-1 h-11 px-5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                {t('cancel')}
              </button>
              <button
                onClick={handleCreateKey}
                disabled={creating || !newKeyData.name.trim()}
                className="flex-1 btn-primary disabled:opacity-50"
              >
                {creating ? t('creating') : t('create')}
              </button>
            </div>
          )
        }
      >
        {createdKey ? (
          <div className="space-y-6">
            <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
              <p className="text-sm text-yellow-800 mb-2">
                <i className="fas fa-exclamation-triangle mr-2"></i>
                {t.rich('importantOnce', { b: (c) => <strong>{c}</strong> })}
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">{t('yourKey')}</label>
              <div className="flex items-center space-x-2">
                <input
                  type="text"
                  value={createdKey}
                  readOnly
                  className="flex-1 input-base font-mono text-sm bg-gray-50"
                />
                <button
                  onClick={() => copyToClipboard(createdKey)}
                  className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
                >
                  <i className="fas fa-copy"></i>
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                {t('keyNameLabel')} <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={newKeyData.name}
                onChange={(e) => setNewKeyData({ ...newKeyData, name: e.target.value })}
                placeholder={t('phEnvExample')}
                className="w-full input-base"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">{t('permissions')}</label>
              <div className="flex items-center space-x-4">
                <label className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    checked={newKeyData.permissions.read}
                    onChange={(e) =>
                      setNewKeyData({
                        ...newKeyData,
                        permissions: { ...newKeyData.permissions, read: e.target.checked },
                      })
                    }
                    className="rounded border-gray-300 text-blue-600"
                  />
                  <span className="text-sm text-gray-700">{t('permReadFull')}</span>
                </label>
                <label className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    checked={newKeyData.permissions.write}
                    onChange={(e) =>
                      setNewKeyData({
                        ...newKeyData,
                        permissions: { ...newKeyData.permissions, write: e.target.checked },
                      })
                    }
                    className="rounded border-gray-300 text-green-600"
                  />
                  <span className="text-sm text-gray-700">{t('permWriteFull')}</span>
                </label>
                <label className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    checked={newKeyData.permissions.delete}
                    onChange={(e) =>
                      setNewKeyData({
                        ...newKeyData,
                        permissions: { ...newKeyData.permissions, delete: e.target.checked },
                      })
                    }
                    className="rounded border-gray-300 text-red-600"
                  />
                  <span className="text-sm text-gray-700">{t('permDeleteFull')}</span>
                </label>
              </div>
            </div>

            {/* 新版细粒度 scope（启用后可授予 EXECUTE 给 RPC 调用） */}
            <div className="border border-gray-200 rounded-lg p-3 bg-gray-50/40 space-y-3">
              <label className="flex items-center space-x-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={newKeyData.advancedEnabled}
                  onChange={(e) =>
                    setNewKeyData({ ...newKeyData, advancedEnabled: e.target.checked })
                  }
                  className="rounded border-gray-300 text-blue-600"
                />
                <span className="text-sm font-medium text-gray-700">
                  {t('enableScope')}
                </span>
                <span className="text-xs text-gray-500">
                  {t('scopeHint')}
                </span>
              </label>

              {newKeyData.advancedEnabled && (
                <div className="space-y-3 pl-6">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1.5">
                      {t('allowedActions')}
                    </label>
                    <div className="flex flex-wrap gap-3">
                      {(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'EXECUTE', 'DDL', 'ALL'] as const).map(
                        (act) => (
                          <label
                            key={act}
                            className="flex items-center space-x-1.5 cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={newKeyData.allowedActions.includes(act)}
                              onChange={(e) => {
                                const set = new Set(newKeyData.allowedActions)
                                if (e.target.checked) set.add(act)
                                else set.delete(act)
                                setNewKeyData({
                                  ...newKeyData,
                                  allowedActions: Array.from(set),
                                })
                              }}
                              className="rounded border-gray-300"
                            />
                            <span
                              className={`text-xs font-mono ${
                                act === 'EXECUTE'
                                  ? 'text-purple-700 font-semibold'
                                  : act === 'DDL'
                                  ? 'text-amber-700 font-semibold'
                                  : 'text-gray-700'
                              }`}
                            >
                              {act}
                            </span>
                          </label>
                        ),
                      )}
                    </div>
                    <p className="mt-1 text-[11px] text-gray-500">
                      {t.rich('actionsHint', { mono: (c) => <span className="font-mono">{c}</span> })}
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1.5">
                      {t('allowedResources')}
                    </label>
                    <textarea
                      value={newKeyData.allowedResources}
                      onChange={(e) =>
                        setNewKeyData({ ...newKeyData, allowedResources: e.target.value })
                      }
                      rows={2}
                      placeholder={t('phResources')}
                      className="w-full px-2 py-1.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <p className="mt-1 text-[11px] text-gray-500">
                      {t.rich('resourcesHint', { mono: (c) => <span className="font-mono">{c}</span> })}
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">{t('validity')}</label>
              <select
                value={newKeyData.expires_in_days}
                onChange={(e) =>
                  setNewKeyData({ ...newKeyData, expires_in_days: parseInt(e.target.value) })
                }
                className="w-full input-base"
              >
                <option value={0}>{t('expNever')}</option>
                <option value={7}>{t('exp7')}</option>
                <option value={30}>{t('exp30')}</option>
                <option value={90}>{t('exp90')}</option>
                <option value={365}>{t('exp365')}</option>
              </select>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  )
}

/**
 * MCP 端点地址。next.config.js 把 `/mcp` 反代到后端，所以用户当前浏览的
 * origin 就是正确的接入地址（网关域名 / 内网 IP 都自动正确，无需额外配置）。
 * 仅在用户交互后渲染，不存在 SSR/CSR 不一致问题。
 */
function mcpEndpoint(): string {
  if (typeof window === 'undefined') return '/mcp'
  return `${window.location.origin}/mcp`
}

/** 拼好可直接粘贴执行的 Claude Code 接入命令。 */
function mcpAddCommand(token: string): string {
  return `claude mcp add --transport http planeos ${mcpEndpoint()} --header "Authorization: Bearer ${token}"`
}

/**
 * 复制到剪贴板。明文令牌"只显示一次"，复制失败必须明确告知——否则用户
 * 以为已复制、关掉横幅，令牌就永久丢失了。
 * 注意 navigator.clipboard 在非 HTTPS（且非 localhost）环境下是 undefined。
 */
async function copyToClipboard(text: string, label: string, tr: (k: string, p?: any) => string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      alert(tr('copiedLabel', { label }))
    } else {
      alert(tr('manualCopy', { label }))
    }
  } catch {
    alert(tr('copyFail', { label }))
  }
}

/** 个人访问令牌（PAT）管理：MCP 工作流创作的鉴权凭证，绑定当前登录用户（跨项目） */
function PatSection() {
  const t = useTranslations('wsApiKeys')
  /** 当前用户的 PAT 列表 */
  const [pats, setPats] = useState<any[]>([])
  const [patLoading, setPatLoading] = useState(true)
  /** 刚生成的明文 token（仅展示一次） */
  const [createdToken, setCreatedToken] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    loadPats()
  }, [])

  const loadPats = async () => {
    setPatLoading(true)
    try {
      const resp = await patAPI.list()
      setPats(resp.data?.pats || [])
    } catch (err: any) {
      console.error(t('loadPatFailed'), err)
    } finally {
      setPatLoading(false)
    }
  }

  const handleCreate = async () => {
    const name = window.prompt(t('promptName'))?.trim()
    if (!name) return
    const daysRaw = window.prompt(t('promptDays'), '')?.trim()
    // 非数字输入会 parseInt 成 NaN，经 JSON.stringify 变 null 被后端当"永不过期"——
    // 与用户意图相反，这里显式校验，避免静默生成超出预期的永久令牌。
    let expires_days: number | undefined = undefined
    if (daysRaw) {
      const n = parseInt(daysRaw, 10)
      if (Number.isNaN(n) || n < 1 || n > 3650) {
        alert(t('errDays'))
        return
      }
      expires_days = n
    }
    setCreating(true)
    try {
      const resp = await patAPI.create({ name, expires_days })
      setCreatedToken(resp.data?.token || null)
      loadPats()
    } catch (err: any) {
      alert(t('genFailed', { msg: err.response?.data?.error || err.message }))
    } finally {
      setCreating(false)
    }
  }

  const handleRevoke = async (id: number, name: string) => {
    if (!window.confirm(t('confirmRevoke', { name }))) return
    try {
      await patAPI.revoke(id)
      loadPats()
    } catch (err: any) {
      alert(t('revokeFailed', { msg: err.response?.data?.error || err.message }))
    }
  }

  return (
    <div data-alt="pat-section" className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">
            {t('patTitle')}
            <span className="ml-2 text-xs font-normal text-gray-400">{t('patSubtitle')}</span>
          </h2>
          <p className="text-xs text-gray-500 mt-1">
            {t.rich('patDesc', {
              c1: (c) => <code className="bg-gray-100 px-1 rounded">{c}</code>,
              c2: (c) => <code className="bg-gray-100 px-1 rounded font-mono">{c}</code>,
              c3: (c) => <code className="bg-gray-100 px-1 rounded font-mono">{c}</code>,
            })}
          </p>
        </div>
        <button
          data-alt="pat-create-button"
          onClick={handleCreate}
          disabled={creating}
          className="btn-primary disabled:opacity-50"
        >
          <i className="fas fa-plus mr-2"></i>
          {creating ? t('generating') : t('genToken')}
        </button>
      </div>

      {createdToken && (
        <div data-alt="pat-created-token" className="mx-6 mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
          <p className="text-sm text-yellow-800 mb-2">
            <i className="fas fa-exclamation-triangle mr-2"></i>
            {t.rich('tokenOnce', { b: (c) => <strong>{c}</strong> })}
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 bg-white border border-yellow-300 rounded text-xs font-mono break-all">
              {createdToken}
            </code>
            <button
              data-alt="pat-copy-button"
              onClick={() => copyToClipboard(createdToken, t('labelToken'), t)}
              className="px-3 py-2 text-sm text-yellow-800 hover:bg-yellow-100 rounded-lg whitespace-nowrap"
            >
              <i className="fas fa-copy mr-1"></i>{t('copy')}
            </button>
            <button
              data-alt="pat-token-done-button"
              onClick={() => setCreatedToken(null)}
              className="px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg whitespace-nowrap"
            >
              {t('saved')}
            </button>
          </div>

          {/* 接入命令直接填好地址与令牌 —— 令牌只显示这一次，这里是用户唯一能
              一键拿到可用命令的时机。让他自己拼 {BASE_URL} / {令牌} 会显著拉低
              MCP（付费加购模块）的激活率。
              地址用 window.location.origin：next.config.js 已把 /mcp 反代到后端，
              所以用户当前浏览的域名就是正确的 MCP 端点。 */}
          <div className="mt-3 border-t border-yellow-200 pt-3">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-yellow-800">
                {t('mcpCmdLabel')}
              </span>
              <button
                data-alt="pat-copy-mcp-command"
                onClick={() => copyToClipboard(mcpAddCommand(createdToken), t('labelCommand'), t)}
                className="shrink-0 rounded-lg px-2.5 py-1 text-xs text-yellow-800 hover:bg-yellow-100"
              >
                <i className="fas fa-copy mr-1"></i>{t('copyFullCmd')}
              </button>
            </div>
            <code className="block break-all rounded border border-yellow-300 bg-white px-3 py-2 font-mono text-xs text-gray-700">
              {mcpAddCommand(createdToken)}
            </code>
            <p className="mt-1.5 text-[11px] text-yellow-700">
              {t.rich('otherClients', {
                endpoint: mcpEndpoint(),
                mono: (c) => <span className="font-mono">{c}</span>,
              })}
            </p>
          </div>
        </div>
      )}

      {patLoading ? (
        <div className="p-8 text-center">
          <i className="fas fa-spinner fa-spin text-xl text-gray-400"></i>
        </div>
      ) : pats.length === 0 ? (
        <div className="p-8 text-center text-gray-400 text-sm">{t('emptyTokens')}</div>
      ) : (
        <div className="divide-y divide-gray-100">
          {pats.map((pat) => (
            <div
              key={pat.id}
              data-alt="pat-list-item"
              className="px-6 py-3 flex items-center justify-between hover:bg-gray-50"
            >
              <div className="flex items-center space-x-3">
                <i className={`fas fa-robot ${pat.is_active ? 'text-indigo-500' : 'text-gray-300'}`}></i>
                <div>
                  <p className="text-sm font-medium text-gray-900">{pat.name}</p>
                  <p className="text-xs text-gray-400">
                    {pat.scope}
                    {pat.expires_at ? t('expiresSuffix', { date: new Date(pat.expires_at).toLocaleDateString() }) : t('neverExpire')}
                    {pat.last_used_at
                      ? t('lastUsedSuffix', { time: new Date(pat.last_used_at).toLocaleString() })
                      : t('neverUsedSuffix')}
                  </p>
                </div>
              </div>
              <div className="flex items-center space-x-3">
                {!pat.is_active && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">{t('revoked')}</span>
                )}
                {pat.is_active && (
                  <button
                    data-alt="pat-revoke-button"
                    onClick={() => handleRevoke(pat.id, pat.name)}
                    className="px-3 py-1 text-sm text-red-600 hover:bg-red-50 rounded-lg"
                  >
                    {t('revoke')}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
