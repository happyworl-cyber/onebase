'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useAppStore } from '@/lib/store'
import { apiKeyAPI, schemaAPI } from '@/lib/api'
import { useNotification } from '@/hooks/useNotification'
import Drawer from '@/components/Drawer'

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

interface TableInfo {
  table_name: string
  table_type: string
}

type ApiTab = 'overview' | 'keys' | 'docs'

export default function ApiPage() {
  const { currentTenant, currentSchema } = useAppStore()
  const notify = useNotification()

  const [activeTab, setActiveTab] = useState<ApiTab>('overview')
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [tables, setTables] = useState<TableInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreateDrawer, setShowCreateDrawer] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newKeyData, setNewKeyData] = useState({
    name: '',
    permissions: { read: true, write: true, delete: true },
    expires_in_days: 0, // 0 表示永不过期
    // 新版细粒度 scope（与旧 permissions 共存；后端会一并保存）。
    // 留空 = 不使用新格式，仍按旧 read/write/delete 控制；启用后才能授予 EXECUTE（RPC）。
    advancedEnabled: false,
    allowedActions: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as string[],
    allowedResources: '', // 逗号分隔；空 = 不限资源（仍受 actions 限制）
  })
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [selectedTable, setSelectedTable] = useState<string>('')
  /** 接口文档里 RPC 示例用的函数名（占位，可改成你的函数名） */
  const [rpcDocFunctionName, setRpcDocFunctionName] = useState('my_rpc_function')

  const databaseId = currentTenant?.database_id

  useEffect(() => {
    if (databaseId) {
      loadApiKeys()
      loadTables()
    }
  }, [databaseId, currentSchema])

  const loadApiKeys = async () => {
    if (!databaseId) return
    try {
      const response = await apiKeyAPI.list(databaseId)
      setApiKeys(response.data)
    } catch (err: any) {
      notify.error(err)
    } finally {
      setLoading(false)
    }
  }

  const loadTables = async () => {
    try {
      const response = await schemaAPI.listTables(currentSchema)
      setTables(response.data || [])
      if (response.data?.length > 0) {
        setSelectedTable(response.data[0].table_name)
      }
    } catch (err) {
      console.error('加载表列表失败:', err)
    }
  }

  const handleCreateKey = async () => {
    if (!databaseId || !newKeyData.name.trim()) {
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
      const response = await apiKeyAPI.create(databaseId, payload)
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
    if (!databaseId) return
    if (!confirm(`确定要删除 API Key "${keyName}" 吗？`)) return

    try {
      await apiKeyAPI.delete(databaseId, keyId)
      notify.success('API Key 已删除')
      loadApiKeys()
    } catch (err: any) {
      notify.error(err)
    }
  }

  const handleToggleKey = async (keyId: number, isActive: boolean) => {
    if (!databaseId) return
    try {
      await apiKeyAPI.update(databaseId, keyId, { is_active: !isActive })
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

  // 后端基址：优先使用打包时注入的 URL；否则用当前页面 origin（通过 Next.js rewrites 反代到后端），
  // 跨机器/HTTPS 场景下示例 URL 会自动正确，不会硬编码 :3000。
  const apiBaseUrl =
    process.env.NEXT_PUBLIC_API_URL ||
    (typeof window !== 'undefined' ? window.location.origin : '')
  const endpointBase = `${apiBaseUrl}/api/v1/${databaseId}/${currentSchema}`
  /** RPC 路径前缀：与表 CRUD 共用 /api/v1/{databaseId}/，仅末段从 schema/table 换成 rpc/{fn} */
  const rpcEndpointRoot = `${apiBaseUrl}/api/v1/${databaseId}/rpc`

  if (!currentTenant) {
    return (
      <div className="p-8 text-center text-gray-500">
        请先选择一个项目
      </div>
    )
  }

  const rpcFnEncoded = encodeURIComponent(rpcDocFunctionName.trim() || 'my_rpc_function')

  const rpcPostCurl = (() => {
    let s = `curl -X POST "${rpcEndpointRoot}/${rpcFnEncoded}" \\\n`
    s += `  -H "Authorization: Bearer YOUR_API_KEY" \\\n`
    s += `  -H "Content-Type: application/json"`
    if (currentSchema !== 'public') {
      s += ` \\\n  -H "Content-Profile: ${currentSchema}"`
    }
    s += ` \\\n  -d '{"user_id": 1, "keyword": "demo"}'`
    return s
  })()

  const rpcGetCurl = (() => {
    let s = `curl -X GET "${rpcEndpointRoot}/${rpcFnEncoded}?user_id=1&keyword=%22demo%22" \\\n`
    s += `  -H "Authorization: Bearer YOUR_API_KEY"`
    if (currentSchema !== 'public') {
      s += ` \\\n  -H "Accept-Profile: ${currentSchema}"`
    }
    return s
  })()

  const rpcPreferCurl = (() => {
    let s = `curl -X POST "${rpcEndpointRoot}/${rpcFnEncoded}" \\\n`
    s += `  -H "Authorization: Bearer YOUR_API_KEY" \\\n`
    s += `  -H "Content-Type: application/json" \\\n`
    s += `  -H "Prefer: params=single-object"`
    if (currentSchema !== 'public') {
      s += ` \\\n  -H "Content-Profile: ${currentSchema}"`
    }
    s += ` \\\n  -d '{"payload": {"nested": true}}'`
    return s
  })()

  const tabs: { id: ApiTab; label: string; icon: string; desc: string }[] = [
    { id: 'overview', label: '概览', icon: 'fa-plug', desc: '端点与快速开始' },
    { id: 'keys', label: 'API Keys', icon: 'fa-key', desc: '密钥管理' },
    { id: 'docs', label: '接口文档', icon: 'fa-book', desc: '表 CRUD 与 RPC 示例' },
  ]

  const activeKeysCount = apiKeys.filter((k) => k.is_active).length

  return (
    <div className="p-6 space-y-6">
      {/* 页面标题 */}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">API</h1>
          <p className="text-gray-600 mt-1">
            数据表 CRUD 与 RPC 函数共用一套路径前缀：
            <code className="text-xs bg-gray-100 px-1 rounded ml-1">/api/v1/&#123;project_id&#125;/…</code>
            ，均可配合 API Key 调用
          </p>
        </div>
        {activeTab === 'keys' && (
          <button
            onClick={() => {
              setShowCreateDrawer(true)
              setCreatedKey(null)
              setNewKeyData({
                name: '',
                permissions: { read: true, write: true, delete: true },
                expires_in_days: 0,
                advancedEnabled: false,
                allowedActions: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
                allowedResources: '',
              })
            }}
            className="btn-primary"
          >
            <i className="fas fa-plus mr-2"></i>
            创建 API Key
          </button>
        )}
      </div>

      {/* Tab 导航 */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex space-x-6">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`group inline-flex items-center gap-2 py-3 px-1 border-b-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                <i className={`fas ${tab.icon}`}></i>
                <span>{tab.label}</span>
                {tab.id === 'keys' && apiKeys.length > 0 && (
                  <span
                    className={`ml-1 inline-flex items-center justify-center text-xs font-semibold rounded-full px-2 py-0.5 ${
                      isActive ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {activeKeysCount}/{apiKeys.length}
                  </span>
                )}
              </button>
            )
          })}
        </nav>
      </div>

      {/* —— 概览 Tab —— */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* 端点信息 */}
          <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-xl p-6 border border-blue-100">
            <h2 className="text-lg font-semibold text-gray-900 mb-1">
              <i className="fas fa-plug mr-2 text-blue-500"></i>
              API 端点
            </h2>
            <p className="text-sm text-gray-500 mb-4">
              当前项目（database_id={databaseId}）+ Schema（{currentSchema}）的统一访问入口
            </p>
            <div className="space-y-3">
              <div className="bg-white rounded-lg p-4 font-mono text-sm">
                <div className="text-xs text-gray-500 mb-1">数据表 REST</div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-700 break-all">
                    {endpointBase}/<span className="text-blue-600">{'{table}'}</span>
                  </span>
                  <button
                    onClick={() => copyToClipboard(`${endpointBase}/`)}
                    className="ml-3 text-gray-400 hover:text-gray-600 shrink-0"
                    title="复制"
                  >
                    <i className="fas fa-copy"></i>
                  </button>
                </div>
              </div>
              <div className="bg-white rounded-lg p-4 font-mono text-sm">
                <div className="text-xs text-gray-500 mb-1">RPC（存储过程 / 函数）</div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-700 break-all">
                    {rpcEndpointRoot}/<span className="text-purple-600">{'{function}'}</span>
                  </span>
                  <button
                    onClick={() => copyToClipboard(`${rpcEndpointRoot}/`)}
                    className="ml-3 text-gray-400 hover:text-gray-600 shrink-0"
                    title="复制"
                  >
                    <i className="fas fa-copy"></i>
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* 快速开始三步 */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              {
                step: '1',
                title: '创建 API Key',
                desc: '在「API Keys」标签页创建一个有读/写/删权限的密钥',
                action: () => setActiveTab('keys'),
                actionLabel: '前往创建',
                color: 'blue',
              },
              {
                step: '2',
                title: '查阅接口',
                desc: '在「接口文档」查看数据表 CRUD 与 RPC 的 curl 示例',
                action: () => setActiveTab('docs'),
                actionLabel: '查看文档',
                color: 'purple',
              },
              {
                step: '3',
                title: '发起调用',
                desc: '请求头携带 Authorization: Bearer YOUR_API_KEY；RPC 需在 Key 的 scope 中勾选 EXECUTE',
                color: 'green',
              },
            ].map((s) => (
              <div
                key={s.step}
                className="bg-white border border-gray-200 rounded-xl p-5 hover:shadow-sm transition-shadow"
              >
                <div className="flex items-center gap-3 mb-3">
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold ${
                      s.color === 'blue'
                        ? 'bg-blue-100 text-blue-600'
                        : s.color === 'purple'
                        ? 'bg-purple-100 text-purple-600'
                        : 'bg-green-100 text-green-600'
                    }`}
                  >
                    {s.step}
                  </div>
                  <h3 className="font-semibold text-gray-900">{s.title}</h3>
                </div>
                <p className="text-sm text-gray-600 mb-3">{s.desc}</p>
                {s.action && (
                  <button
                    onClick={s.action}
                    className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                  >
                    {s.actionLabel} <i className="fas fa-arrow-right ml-1 text-xs"></i>
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* 最小请求示例：表 REST + RPC */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-700">最小请求示例</h3>
              <span className="text-xs text-gray-500">不需要数据库密码，仅用 API Key</span>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-gray-200">
              <div>
                <div className="px-4 py-2 bg-gray-50 text-xs font-medium text-gray-600">数据表列表</div>
                <pre className="p-4 bg-gray-900 text-gray-100 font-mono text-sm overflow-x-auto">
{`curl "${endpointBase}/${selectedTable || '{table}'}?limit=5" \\
  -H "Authorization: Bearer YOUR_API_KEY"`}
                </pre>
              </div>
              <div>
                <div className="px-4 py-2 bg-gray-50 text-xs font-medium text-gray-600">RPC（POST）</div>
                <pre className="p-4 bg-gray-900 text-gray-100 font-mono text-sm overflow-x-auto">
{`curl -X POST "${rpcEndpointRoot}/my_function" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"arg1": 1}'`}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* —— API Keys Tab —— */}
      {activeTab === 'keys' && (
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
                  setShowCreateDrawer(true)
                  setCreatedKey(null)
                  setNewKeyData({
                    name: '',
                    permissions: { read: true, write: true, delete: true },
                    expires_in_days: 0,
                    advancedEnabled: false,
                    allowedActions: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
                    allowedResources: '',
                  })
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
      )}

      {/* —— 接口文档 Tab —— */}
      {activeTab === 'docs' && (
        <div className="space-y-6">
          {/* 表选择 */}
          <div className="bg-white border border-gray-200 rounded-xl p-5">
            <h2 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2">
              <i className="fas fa-table text-blue-500"></i>
              数据表 REST
            </h2>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              选择表
              <span className="ml-2 text-xs text-gray-400 font-normal">
                来自当前 Schema：{currentSchema}
              </span>
            </label>
            {tables.length === 0 ? (
              <div className="text-sm text-gray-500 py-2">当前 Schema 暂无表</div>
            ) : (
              <select
                value={selectedTable}
                onChange={(e) => setSelectedTable(e.target.value)}
                className="input-base max-w-xs"
              >
                {tables.map((t) => (
                  <option key={t.table_name} value={t.table_name}>
                    {t.table_name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* 端点示例 */}
          {selectedTable && (
            <div className="space-y-4">
              <p className="text-sm text-gray-500 -mt-2 mb-2">
                路径前缀：
                <span className="font-mono text-xs">
                  /api/v1/{databaseId}/{currentSchema}/…
                </span>
              </p>
              {[
                {
                  method: 'GET',
                  color: 'green',
                  path: `/${currentSchema}/${selectedTable}`,
                  desc: '获取记录列表',
                  body: `curl "${endpointBase}/${selectedTable}?limit=10" \\
  -H "Authorization: Bearer YOUR_API_KEY"`,
                },
                {
                  method: 'GET',
                  color: 'green',
                  path: `/${currentSchema}/${selectedTable}/:id`,
                  desc: '获取单条记录',
                  body: `curl "${endpointBase}/${selectedTable}/1" \\
  -H "Authorization: Bearer YOUR_API_KEY"`,
                },
                {
                  method: 'POST',
                  color: 'blue',
                  path: `/${currentSchema}/${selectedTable}`,
                  desc: '创建记录',
                  body: `curl -X POST "${endpointBase}/${selectedTable}" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"column1": "value1", "column2": "value2"}'`,
                },
                {
                  method: 'PATCH',
                  color: 'yellow',
                  path: `/${currentSchema}/${selectedTable}/:id`,
                  desc: '更新记录',
                  body: `curl -X PATCH "${endpointBase}/${selectedTable}/1" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"column1": "new_value"}'`,
                },
                {
                  method: 'DELETE',
                  color: 'red',
                  path: `/${currentSchema}/${selectedTable}/:id`,
                  desc: '删除记录',
                  body: `curl -X DELETE "${endpointBase}/${selectedTable}/1" \\
  -H "Authorization: Bearer YOUR_API_KEY"`,
                },
              ].map((ep, idx) => {
                const headerBg = {
                  green: 'bg-green-50',
                  blue: 'bg-blue-50',
                  yellow: 'bg-yellow-50',
                  red: 'bg-red-50',
                  purple: 'bg-purple-50',
                }[ep.color]
                const badgeBg = {
                  green: 'bg-green-500',
                  blue: 'bg-blue-500',
                  yellow: 'bg-yellow-500',
                  red: 'bg-red-500',
                  purple: 'bg-purple-600',
                }[ep.color]
                return (
                  <div
                    key={idx}
                    className="border border-gray-200 rounded-lg overflow-hidden bg-white"
                  >
                    <div
                      className={`px-4 py-3 ${headerBg} border-b border-gray-200 flex items-center justify-between`}
                    >
                      <div className="flex items-center space-x-3">
                        <span
                          className={`px-2 py-1 ${badgeBg} text-white text-xs font-bold rounded`}
                        >
                          {ep.method}
                        </span>
                        <span className="font-mono text-sm">{ep.path}</span>
                        <span className="text-gray-500 text-sm">{ep.desc}</span>
                      </div>
                      <button
                        onClick={() => copyToClipboard(ep.body)}
                        className="text-gray-400 hover:text-gray-600 text-sm"
                        title="复制示例"
                      >
                        <i className="fas fa-copy"></i>
                      </button>
                    </div>
                    <pre className="p-4 bg-gray-900 text-gray-100 font-mono text-sm overflow-x-auto">
                      {ep.body}
                    </pre>
                  </div>
                )
              })}
            </div>
          )}

          {/* RPC：与 PostgREST / Supabase 一致 */}
          <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-5">
            <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
              <div className="space-y-2">
                <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                  <i className="fas fa-terminal text-purple-600"></i>
                  RPC（存储过程 / 函数）
                </h2>
                <p className="text-sm text-gray-600 max-w-3xl leading-relaxed">
                  调用 PostgreSQL 函数，路径与表 CRUD 同前缀：
                  <code className="text-xs bg-gray-100 px-1 rounded">/api/v1/{databaseId}/rpc/&lt;name&gt;</code>，
                  语义对齐 PostgREST：<span className="font-mono text-xs">POST</span> 用 JSON 体按<strong>形参名</strong>传参；{' '}
                  <span className="font-mono text-xs">GET</span> 用 Query（每个值会先按 JSON
                  解析）。非 <span className="font-mono text-xs">public</span> 的函数需加{' '}
                  <span className="font-mono text-xs">Content-Profile</span> /{' '}
                  <span className="font-mono text-xs">Accept-Profile</span>（下方示例已按当前 Schema{' '}
                  <span className="font-mono text-xs">{currentSchema}</span> 自动生成）。
                </p>
                <p className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                  <i className="fas fa-key mr-1.5"></i>
                  使用 <strong>API Key</strong> 调用 RPC 时，创建 Key 请勾选「新版细粒度 scope」，在 Actions 中加入{' '}
                  <span className="font-mono text-xs">EXECUTE</span>，并在 Resources 中允许对应资源（例如{' '}
                  <span className="font-mono text-xs">
                    {currentSchema}.{rpcDocFunctionName.trim() || 'my_rpc_function'}
                  </span>
                  或通配 <span className="font-mono text-xs">{currentSchema}.*</span>）。
                </p>
              </div>
              <Link
                href="/dashboard/rpc"
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-purple-200 bg-purple-50 text-purple-800 text-sm font-medium hover:bg-purple-100 shrink-0"
              >
                <i className="fas fa-flask"></i>
                RPC 调用器
              </Link>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                示例函数名（仅用于生成下方 URL，请改成你库中真实函数名）
              </label>
              <input
                type="text"
                value={rpcDocFunctionName}
                onChange={(e) => setRpcDocFunctionName(e.target.value)}
                className="input-base max-w-lg font-mono text-sm"
                placeholder="my_rpc_function"
                spellCheck={false}
              />
            </div>

            <div className="space-y-4">
              {[
                {
                  method: 'POST',
                  color: 'blue' as const,
                  path: `/api/v1/${databaseId}/rpc/${rpcFnEncoded}`,
                  desc: '默认：JSON body 与 supabase.rpc(fn, args) 一致',
                  body: rpcPostCurl,
                },
                {
                  method: 'GET',
                  color: 'green' as const,
                  path: `/api/v1/${databaseId}/rpc/${rpcFnEncoded}`,
                  desc: '适合 IMMUTABLE / STABLE；字符串参数需 URL 编码（如 %22text%22）',
                  body: rpcGetCurl,
                },
                {
                  method: 'POST',
                  color: 'purple' as const,
                  path: `/api/v1/${databaseId}/rpc/${rpcFnEncoded}`,
                  desc: '单 jsonb 实参：整段 body 作为一个参数传入',
                  body: rpcPreferCurl,
                },
              ].map((ep, idx) => {
                const headerBg = {
                  green: 'bg-green-50',
                  blue: 'bg-blue-50',
                  yellow: 'bg-yellow-50',
                  red: 'bg-red-50',
                  purple: 'bg-purple-50',
                }[ep.color]
                const badgeBg = {
                  green: 'bg-green-500',
                  blue: 'bg-blue-500',
                  yellow: 'bg-yellow-500',
                  red: 'bg-red-500',
                  purple: 'bg-purple-600',
                }[ep.color]
                return (
                  <div
                    key={`rpc-${idx}`}
                    className="border border-gray-200 rounded-lg overflow-hidden bg-white"
                  >
                    <div
                      className={`px-4 py-3 ${headerBg} border-b border-gray-200 flex items-center justify-between`}
                    >
                      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                        <span
                          className={`px-2 py-1 ${badgeBg} text-white text-xs font-bold rounded`}
                        >
                          {ep.method}
                        </span>
                        <span className="font-mono text-sm break-all">{ep.path}</span>
                        <span className="text-gray-500 text-sm">{ep.desc}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(ep.body)}
                        className="text-gray-400 hover:text-gray-600 text-sm shrink-0 p-1"
                        title="复制示例"
                      >
                        <i className="fas fa-copy"></i>
                      </button>
                    </div>
                    <pre className="p-4 bg-gray-900 text-gray-100 font-mono text-sm overflow-x-auto">
                      {ep.body}
                    </pre>
                  </div>
                )
              })}
            </div>

            <p className="text-xs text-gray-500 border-t border-gray-100 pt-4">
              鉴权：与表 API 相同，使用 <span className="font-mono">Authorization: Bearer &lt;API Key&gt;</span>（
              <span className="font-mono">cr_</span> 前缀）；亦支持{' '}
              <span className="font-mono">apikey: cr_…</span> 头。登录用户可改用 JWT。
              使用 API Key 时，URL 中的 <span className="font-mono">database_id</span> 必须与该
              Key 绑定的库一致，否则会被拒绝。
            </p>
          </div>

          {/* 查询参数说明 */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">查询参数（仅数据表 REST）</h2>
              <p className="text-sm text-gray-500">
                下列参数仅适用于上方「数据表 REST」的 GET 列表接口，不用于 RPC
              </p>
            </div>
            <div className="p-6">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b border-gray-200">
                    <th className="pb-3 font-medium text-gray-700">参数</th>
                    <th className="pb-3 font-medium text-gray-700">说明</th>
                    <th className="pb-3 font-medium text-gray-700">示例</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  <tr>
                    <td className="py-3 font-mono text-blue-600">select</td>
                    <td className="py-3 text-gray-600">选择返回的字段</td>
                    <td className="py-3 font-mono text-gray-500">?select=id,name,email</td>
                  </tr>
                  <tr>
                    <td className="py-3 font-mono text-blue-600">order</td>
                    <td className="py-3 text-gray-600">排序字段和方向</td>
                    <td className="py-3 font-mono text-gray-500">?order=created_at.desc</td>
                  </tr>
                  <tr>
                    <td className="py-3 font-mono text-blue-600">limit</td>
                    <td className="py-3 text-gray-600">返回记录数量（最大 1000）</td>
                    <td className="py-3 font-mono text-gray-500">?limit=20</td>
                  </tr>
                  <tr>
                    <td className="py-3 font-mono text-blue-600">offset</td>
                    <td className="py-3 text-gray-600">跳过记录数量（分页）</td>
                    <td className="py-3 font-mono text-gray-500">?offset=20</td>
                  </tr>
                  <tr>
                    <td className="py-3 font-mono text-blue-600">field.eq</td>
                    <td className="py-3 text-gray-600">等于过滤</td>
                    <td className="py-3 font-mono text-gray-500">?status.eq=active</td>
                  </tr>
                  <tr>
                    <td className="py-3 font-mono text-blue-600">field.neq</td>
                    <td className="py-3 text-gray-600">不等于过滤</td>
                    <td className="py-3 font-mono text-gray-500">?status.neq=deleted</td>
                  </tr>
                  <tr>
                    <td className="py-3 font-mono text-blue-600">field.gt/gte</td>
                    <td className="py-3 text-gray-600">大于/大于等于</td>
                    <td className="py-3 font-mono text-gray-500">?age.gte=18</td>
                  </tr>
                  <tr>
                    <td className="py-3 font-mono text-blue-600">field.lt/lte</td>
                    <td className="py-3 text-gray-600">小于/小于等于</td>
                    <td className="py-3 font-mono text-gray-500">?price.lt=100</td>
                  </tr>
                  <tr>
                    <td className="py-3 font-mono text-blue-600">field.like</td>
                    <td className="py-3 text-gray-600">模糊匹配（区分大小写）</td>
                    <td className="py-3 font-mono text-gray-500">?name.like=%john%</td>
                  </tr>
                  <tr>
                    <td className="py-3 font-mono text-blue-600">field.ilike</td>
                    <td className="py-3 text-gray-600">模糊匹配（不区分大小写）</td>
                    <td className="py-3 font-mono text-gray-500">?name.ilike=%john%</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 创建 API Key 抽屉 */}
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
                    onChange={(e) => setNewKeyData({
                      ...newKeyData,
                      permissions: { ...newKeyData.permissions, read: e.target.checked }
                    })}
                    className="rounded border-gray-300 text-blue-600"
                  />
                  <span className="text-sm text-gray-700">读取</span>
                </label>
                <label className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    checked={newKeyData.permissions.write}
                    onChange={(e) => setNewKeyData({
                      ...newKeyData,
                      permissions: { ...newKeyData.permissions, write: e.target.checked }
                    })}
                    className="rounded border-gray-300 text-green-600"
                  />
                  <span className="text-sm text-gray-700">写入</span>
                </label>
                <label className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    checked={newKeyData.permissions.delete}
                    onChange={(e) => setNewKeyData({
                      ...newKeyData,
                      permissions: { ...newKeyData.permissions, delete: e.target.checked }
                    })}
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
                      {(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'EXECUTE', 'ALL'] as const).map(
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
                      <span className="font-mono">ALL</span>/<span className="font-mono">*</span> 包含所有动作。
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
                      <span className="font-mono">*</span> / <span className="font-mono">*.*</span> 全开。
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">有效期</label>
              <select
                value={newKeyData.expires_in_days}
                onChange={(e) => setNewKeyData({ ...newKeyData, expires_in_days: parseInt(e.target.value) })}
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

