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
  // 必须属于当前项目，防止残留的上一项目 currentConnection 把 key 列到错误项目下。
  const connectionForProject =
    currentConnection?.tenant_id === projectId ? currentConnection : null
  const databaseId = connectionForProject?.database_id ?? null
  const databaseSlug = connectionForProject?.database_slug || null
  const dbRouteSeg = databaseSlug || null
  const caps = useCurrentProjectCapabilities()
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
      notify.warning('请填写 API Key 名称')
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
      notify.success('API Key 创建成功')
      loadApiKeys()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setCreating(false)
    }
  }

  const handleDeleteKey = async (keyId: number, keyName: string) => {
    if (!dbRouteSeg) return
    if (!confirm(`确定要删除 API Key "${keyName}" 吗？`)) return
    try {
      await apiKeyAPI.delete(dbRouteSeg, keyId)
      notify.success('API Key 已删除')
      loadApiKeys()
    } catch (err: any) {
      notify.error(err)
    }
  }

  const handleToggleKey = async (keyId: number, isActive: boolean) => {
    if (!dbRouteSeg) return
    try {
      await apiKeyAPI.update(dbRouteSeg, keyId, { is_active: !isActive })
      notify.success(isActive ? 'API Key 已禁用' : 'API Key 已启用')
      loadApiKeys()
    } catch (err: any) {
      notify.error(err)
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    notify.success('已复制到剪贴板')
  }

  if (!caps.canManageSecurity) {
    return (
      <ForbiddenPlaceholder reason="API Key 管理需要 admin+ 角色（owner / admin / 超管）" />
    )
  }

  if (isNaN(projectId)) {
    return (
      <div className="p-8 text-center text-gray-500">
        URL 中的 projectId 无效
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
        <p>本项目尚未绑定主数据库连接，无法管理 API Key。</p>
        <Link
          href={`/workspace/${projectId}/settings/connections`}
          className="text-blue-600 hover:underline"
        >
          前往设置 → 数据库连接
        </Link>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">API Key</h1>
          <p className="text-gray-600 mt-1 text-sm">
            管理本项目（标识={dbRouteSeg || '-'}）的 REST / RPC 访问密钥。
            REST 端点示例与接口文档请见{' '}
            <a
              href={`/workspace/${projectId}/api`}
              className="text-blue-600 hover:underline"
            >
              API 概览页
            </a>
            。
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
          创建 API Key
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
            <p className="mb-4">暂无 API Key</p>
            <button
              onClick={() => {
                resetForm()
                setShowCreateDrawer(true)
              }}
              className="btn-primary"
            >
              <i className="fas fa-plus mr-2"></i>
              创建第一个 Key
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
                  <div className="text-sm text-gray-500">
                    {key.last_used_at ? (
                      <span>最后使用: {new Date(key.last_used_at).toLocaleString()}</span>
                    ) : (
                      <span>从未使用</span>
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
                      读
                    </span>
                    <span
                      className={`text-xs px-2 py-1 rounded-full ${
                        key.permissions.write
                          ? 'bg-green-100 text-green-700'
                          : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      写
                    </span>
                    <span
                      className={`text-xs px-2 py-1 rounded-full ${
                        key.permissions.delete
                          ? 'bg-red-100 text-red-700'
                          : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      删
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
                      {key.is_active ? '禁用' : '启用'}
                    </button>
                    <button
                      onClick={() => handleDeleteKey(key.id, key.name)}
                      className="px-3 py-1 text-sm text-red-600 hover:bg-red-50 rounded-lg"
                    >
                      删除
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
        title={createdKey ? '保存 API Key' : '创建 API Key'}
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
              我已保存，关闭
            </button>
          ) : (
            <div className="flex gap-3">
              <button
                onClick={() => setShowCreateDrawer(false)}
                className="flex-1 h-11 px-5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={handleCreateKey}
                disabled={creating || !newKeyData.name.trim()}
                className="flex-1 btn-primary disabled:opacity-50"
              >
                {creating ? '创建中...' : '创建'}
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
                <strong>重要：</strong>API Key 只会显示一次，请立即保存！
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">您的 API Key</label>
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
                Key 名称 <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={newKeyData.name}
                onChange={(e) => setNewKeyData({ ...newKeyData, name: e.target.value })}
                placeholder="例如：生产环境"
                className="w-full input-base"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">权限</label>
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
                  <span className="text-sm text-gray-700">读取</span>
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
                  <span className="text-sm text-gray-700">写入</span>
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
                  <span className="text-sm text-gray-700">删除</span>
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
                  启用新版细粒度 scope
                </span>
                <span className="text-xs text-gray-500">
                  （RPC 调用 / 资源白名单必须用这个）
                </span>
              </label>

              {newKeyData.advancedEnabled && (
                <div className="space-y-3 pl-6">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1.5">
                      允许的 Actions
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
                      <span className="font-mono">EXECUTE</span> 控制 RPC 函数调用权；
                      <span className="font-mono">DDL</span> 控制建表 / 改表 / 删表；
                      <span className="font-mono">ALL</span>/
                      <span className="font-mono">*</span> 包含所有动作。
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1.5">
                      允许的 Resources（逗号或换行分隔，留空 = 不限）
                    </label>
                    <textarea
                      value={newKeyData.allowedResources}
                      onChange={(e) =>
                        setNewKeyData({ ...newKeyData, allowedResources: e.target.value })
                      }
                      rows={2}
                      placeholder="例：public.users, public.console_get_user_projects, audit.*"
                      className="w-full px-2 py-1.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <p className="mt-1 text-[11px] text-gray-500">
                      支持精确匹配、<span className="font-mono">schema.*</span> 通配、
                      <span className="font-mono">*</span> /{' '}
                      <span className="font-mono">*.*</span> 全开。
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">有效期</label>
              <select
                value={newKeyData.expires_in_days}
                onChange={(e) =>
                  setNewKeyData({ ...newKeyData, expires_in_days: parseInt(e.target.value) })
                }
                className="w-full input-base"
              >
                <option value={0}>永不过期</option>
                <option value={7}>7 天</option>
                <option value={30}>30 天</option>
                <option value={90}>90 天</option>
                <option value={365}>1 年</option>
              </select>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  )
}

/** 个人访问令牌（PAT）管理：MCP 工作流创作的鉴权凭证，绑定当前登录用户（跨项目） */
function PatSection() {
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
      console.error('加载 PAT 失败:', err)
    } finally {
      setPatLoading(false)
    }
  }

  const handleCreate = async () => {
    const name = window.prompt('令牌用途备注（如：本机 Claude Code）')?.trim()
    if (!name) return
    const daysRaw = window.prompt('有效期天数（留空 = 永不过期，可随时吊销）', '')?.trim()
    // 非数字输入会 parseInt 成 NaN，经 JSON.stringify 变 null 被后端当"永不过期"——
    // 与用户意图相反，这里显式校验，避免静默生成超出预期的永久令牌。
    let expires_days: number | undefined = undefined
    if (daysRaw) {
      const n = parseInt(daysRaw, 10)
      if (Number.isNaN(n) || n < 1 || n > 3650) {
        alert('有效期需为 1~3650 之间的整数天数，留空则永不过期')
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
      alert('生成失败: ' + (err.response?.data?.error || err.message))
    } finally {
      setCreating(false)
    }
  }

  const handleRevoke = async (id: number, name: string) => {
    if (!window.confirm(`确认吊销「${name}」？吊销后使用该令牌的 MCP 连接立即失效。`)) return
    try {
      await patAPI.revoke(id)
      loadPats()
    } catch (err: any) {
      alert('吊销失败: ' + (err.response?.data?.error || err.message))
    }
  }

  return (
    <div data-alt="pat-section" className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">
            个人访问令牌（PAT）
            <span className="ml-2 text-xs font-normal text-gray-400">MCP 工作流创作凭证 · 绑定账号，跨项目</span>
          </h2>
          <p className="text-xs text-gray-500 mt-1">
            供 AI 客户端（Claude Code 等）连接 <code className="bg-gray-100 px-1 rounded">/mcp</code> 创作与调试工作流；
            令牌以 <code className="bg-gray-100 px-1 rounded font-mono">obm_</code> 开头（MCP 专用，区别于平台令牌的 <code className="bg-gray-100 px-1 rounded font-mono">obp_</code>）；
            生产环境实例仅允许干跑 + 只读查询，启用工作流仍需人工操作。
          </p>
        </div>
        <button
          data-alt="pat-create-button"
          onClick={handleCreate}
          disabled={creating}
          className="btn-primary disabled:opacity-50"
        >
          <i className="fas fa-plus mr-2"></i>
          {creating ? '生成中...' : '生成令牌'}
        </button>
      </div>

      {createdToken && (
        <div data-alt="pat-created-token" className="mx-6 mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
          <p className="text-sm text-yellow-800 mb-2">
            <i className="fas fa-exclamation-triangle mr-2"></i>
            <strong>令牌只显示这一次</strong>，请立即复制保存：
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 bg-white border border-yellow-300 rounded text-xs font-mono break-all">
              {createdToken}
            </code>
            <button
              data-alt="pat-copy-button"
              onClick={async () => {
                // 令牌"只显示一次"，复制失败必须明确告知，否则用户误以为已复制、关掉横幅即永久丢失。
                // navigator.clipboard 在非 HTTPS（非 localhost）下为 undefined。
                try {
                  if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(createdToken)
                    alert('已复制到剪贴板')
                  } else {
                    alert('当前环境（非 HTTPS）不支持自动复制，请手动选中上方令牌复制后再关闭')
                  }
                } catch {
                  alert('复制失败，请手动选中上方令牌复制后再关闭')
                }
              }}
              className="px-3 py-2 text-sm text-yellow-800 hover:bg-yellow-100 rounded-lg whitespace-nowrap"
            >
              <i className="fas fa-copy mr-1"></i>复制
            </button>
            <button
              data-alt="pat-token-done-button"
              onClick={() => setCreatedToken(null)}
              className="px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg whitespace-nowrap"
            >
              已保存
            </button>
          </div>
          <p className="text-xs text-yellow-700 mt-2 font-mono">
            claude mcp add --transport http onebase {'{BASE_URL}'}/mcp --header "Authorization: Bearer {'{令牌}'}"
          </p>
        </div>
      )}

      {patLoading ? (
        <div className="p-8 text-center">
          <i className="fas fa-spinner fa-spin text-xl text-gray-400"></i>
        </div>
      ) : pats.length === 0 ? (
        <div className="p-8 text-center text-gray-400 text-sm">暂无令牌</div>
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
                    {pat.expires_at ? ` · ${new Date(pat.expires_at).toLocaleDateString()} 过期` : ' · 永不过期'}
                    {pat.last_used_at
                      ? ` · 最后使用 ${new Date(pat.last_used_at).toLocaleString()}`
                      : ' · 从未使用'}
                  </p>
                </div>
              </div>
              <div className="flex items-center space-x-3">
                {!pat.is_active && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">已吊销</span>
                )}
                {pat.is_active && (
                  <button
                    data-alt="pat-revoke-button"
                    onClick={() => handleRevoke(pat.id, pat.name)}
                    className="px-3 py-1 text-sm text-red-600 hover:bg-red-50 rounded-lg"
                  >
                    吊销
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
