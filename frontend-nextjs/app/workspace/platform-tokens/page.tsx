'use client'

/**
 * `/workspace/platform-tokens` —— 平台服务令牌（crp_）管理 + 使用说明。
 *
 * 用户级页面（非项目级）：任何登录用户都能管理自己的令牌（超管可见全部）。
 * 令牌用于机器 / AI 通过 HTTP 或 MCP 直接创建项目、管理工作流，受 scope 约束。
 *
 * 刻意不放在 `/workspace/[projectId]/...` 下——令牌不绑定具体项目；入口在
 * ProjectTopbar 右上角用户菜单「平台服务令牌」。
 */

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { platformTokenAPI } from '@/lib/api'
import { useNotification } from '@/hooks/useNotification'
import Drawer from '@/components/Drawer'

interface PlatformToken {
  id: number
  user_id: number
  user_email: string
  name: string
  token_prefix: string
  scopes: string[]
  is_active: boolean
  last_used_at: string | null
  created_at: string | null
  expires_at: string | null
}

const ALL_SCOPES: { value: string; label: string; hint: string }[] = [
  { value: 'project:create', label: '创建项目', hint: '在 PG 池上建库 + 开通新项目' },
  { value: 'workflow:read', label: '读工作流', hint: '列出 / 查看工作流' },
  { value: 'workflow:write', label: '写工作流', hint: '创建 / 更新 / 调试工作流' },
  { value: 'workflow:run', label: '运行工作流', hint: '触发 endpoint 工作流执行' },
]

export default function PlatformTokensPage() {
  const notify = useNotification()

  const [tokens, setTokens] = useState<PlatformToken[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createdToken, setCreatedToken] = useState<string | null>(null)
  const [form, setForm] = useState({
    name: '',
    scopes: ALL_SCOPES.map((s) => s.value),
    expires_in_days: 90,
  })

  // 文档里展示的后端基址：优先显式配置，否则用当前站点 origin 兜底。
  const apiBase =
    process.env.NEXT_PUBLIC_API_URL ||
    (typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:3000')

  const resetForm = () => {
    setForm({ name: '', scopes: ALL_SCOPES.map((s) => s.value), expires_in_days: 90 })
    setCreatedToken(null)
  }

  const loadTokens = async () => {
    try {
      const res = await platformTokenAPI.list()
      setTokens(res.data?.tokens ?? [])
    } catch (err: any) {
      notify.error(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadTokens()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleScope = (value: string) => {
    setForm((f) => {
      const set = new Set(f.scopes)
      if (set.has(value)) set.delete(value)
      else set.add(value)
      return { ...f, scopes: Array.from(set) }
    })
  }

  const handleCreate = async () => {
    if (!form.name.trim()) {
      notify.warning('请填写令牌名称')
      return
    }
    if (form.scopes.length === 0) {
      notify.warning('请至少选择一个 scope')
      return
    }
    setCreating(true)
    try {
      const res = await platformTokenAPI.create({
        name: form.name.trim(),
        scopes: form.scopes,
        expires_in_days: form.expires_in_days || undefined,
      })
      setCreatedToken(res.data?.token ?? null)
      notify.success('平台令牌创建成功')
      loadTokens()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (id: number, name: string) => {
    if (!confirm(`确定要停用令牌 "${name}" 吗？停用后使用该令牌的调用将立即失效。`)) return
    try {
      await platformTokenAPI.delete(id)
      notify.success('令牌已停用')
      loadTokens()
    } catch (err: any) {
      notify.error(err)
    }
  }

  const copy = (text: string) => {
    navigator.clipboard.writeText(text)
    notify.success('已复制到剪贴板')
  }

  const mcpConfig = `{
  "mcpServers": {
    "onebase": {
      "command": "node",
      "args": ["/绝对路径/onebase/mcp-server/dist/index.js"],
      "env": {
        "ONEBASE_BASE_URL": "${apiBase}",
        "ONEBASE_TOKEN": "crp_你的令牌"
      }
    }
  }
}`

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        {/* 头部 */}
        <div className="flex items-end justify-between">
          <div>
            <Link href="/workspace" className="text-sm text-blue-600 hover:underline">
              <i className="fas fa-arrow-left mr-1"></i> 返回项目列表
            </Link>
            <h1 className="text-2xl font-bold text-gray-900 mt-2">平台服务令牌</h1>
            <p className="text-gray-600 mt-1 text-sm">
              给机器 / AI 用的长期凭证（<span className="font-mono">crp_</span> 前缀）。可通过 HTTP 或
              MCP 直接创建项目、管理工作流，权限受令牌 scope 约束。
            </p>
          </div>
          <button
            onClick={() => {
              resetForm()
              setShowCreate(true)
            }}
            className="btn-primary shrink-0"
          >
            <i className="fas fa-plus mr-2"></i>
            创建令牌
          </button>
        </div>

        {/* 列表 */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {loading ? (
            <div className="p-12 text-center">
              <i className="fas fa-spinner fa-spin text-2xl text-gray-400"></i>
            </div>
          ) : tokens.length === 0 ? (
            <div className="p-12 text-center text-gray-500">
              <i className="fas fa-robot text-4xl mb-4 text-gray-300"></i>
              <p className="mb-4">暂无平台令牌</p>
              <button
                onClick={() => {
                  resetForm()
                  setShowCreate(true)
                }}
                className="btn-primary"
              >
                <i className="fas fa-plus mr-2"></i>
                创建第一个令牌
              </button>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {tokens.map((t) => (
                <div
                  key={t.id}
                  className="px-6 py-4 flex items-center justify-between hover:bg-gray-50"
                >
                  <div className="flex items-center space-x-4 min-w-0">
                    <div
                      className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
                        t.is_active ? 'bg-indigo-100' : 'bg-gray-100'
                      }`}
                    >
                      <i
                        className={`fas fa-robot ${
                          t.is_active ? 'text-indigo-600' : 'text-gray-400'
                        }`}
                      ></i>
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 truncate">
                        {t.name}
                        {!t.is_active && (
                          <span className="ml-2 text-xs text-gray-400">（已停用）</span>
                        )}
                      </p>
                      <p className="text-sm text-gray-500 font-mono">{t.token_prefix}</p>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {(t.scopes ?? []).map((s) => (
                          <span
                            key={s}
                            className="text-[11px] px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 font-mono"
                          >
                            {s}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center space-x-6 shrink-0">
                    <div className="text-xs text-gray-500 text-right">
                      <div>
                        {t.last_used_at
                          ? `最后使用: ${new Date(t.last_used_at).toLocaleString()}`
                          : '从未使用'}
                      </div>
                      <div>
                        {t.expires_at
                          ? `到期: ${new Date(t.expires_at).toLocaleDateString()}`
                          : '永不过期'}
                      </div>
                    </div>
                    {t.is_active && (
                      <button
                        onClick={() => handleDelete(t.id, t.name)}
                        className="px-3 py-1 text-sm text-red-600 hover:bg-red-50 rounded-lg"
                      >
                        停用
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 使用说明 */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          <h2 className="text-lg font-semibold text-gray-900">
            <i className="fas fa-book-open mr-2 text-blue-500"></i>
            使用说明
          </h2>

          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-1">Scope 一览</h3>
            <div className="text-sm text-gray-600 space-y-1">
              {ALL_SCOPES.map((s) => (
                <div key={s.value}>
                  <span className="font-mono text-indigo-700">{s.value}</span>
                  <span className="text-gray-400"> —— </span>
                  {s.hint}
                </div>
              ))}
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-1">方式一：直接 HTTP 调用</h3>
            <p className="text-sm text-gray-600 mb-2">
              所有请求带 <span className="font-mono">Authorization: Bearer crp_...</span>。典型流程：列池 → 列模板 → 建项目 → 建工作流 → 触发。
            </p>
            <pre className="bg-gray-900 text-gray-100 text-xs rounded-lg p-4 overflow-x-auto">
{`BASE=${apiBase}
TOKEN=crp_你的令牌

# 1) 可用 PG 池
curl -s "$BASE/api/provision/pg-pools/available" -H "Authorization: Bearer $TOKEN"

# 2) 项目模板
curl -s "$BASE/api/project-templates" -H "Authorization: Bearer $TOKEN"

# 3) 开通项目（owner = 令牌绑定用户），返回 database_id / db_name
curl -s -X POST "$BASE/api/projects/provision" \\
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
  -d '{"name":"我的项目","slug":"my-proj","pg_pool_id":1,"template_slug":"blank"}'

# 4) 在该项目库建工作流（database_id 用上一步返回的）
curl -s -X POST "$BASE/api/admin/workflows" \\
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
  -d '{"name":"Echo","slug":"echo","database_id":5,"trigger_type":"endpoint",
       "nodes":[{"id":"t1","type":"transform","config":{"output":{"got":"{{trigger}}"}}},
                {"id":"r","type":"response","config":{"status_code":200,"body":"{{t1}}"}}],
       "edges":[{"from":"t1","to":"r"}]}'

# 5) 触发执行（database_slug = 项目 slug，workflow_slug = 工作流 slug）
curl -s -X POST "$BASE/workflow/my-proj/echo" \\
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
  -d '{"hello":"world"}'`}
            </pre>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-sm font-semibold text-gray-700">方式二：MCP（给 AI / Cursor 用）</h3>
              <button
                onClick={() => copy(mcpConfig)}
                className="text-xs text-blue-600 hover:underline"
              >
                <i className="fas fa-copy mr-1"></i> 复制配置
              </button>
            </div>
            <p className="text-sm text-gray-600 mb-2">
              先在 <span className="font-mono">mcp-server/</span> 里 <span className="font-mono">npm install &amp;&amp; npm run build</span>，
              再把下面配置加进 Cursor / Claude 的 <span className="font-mono">mcpServers</span>（令牌填本页创建的 <span className="font-mono">crp_</span>）：
            </p>
            <pre className="bg-gray-900 text-gray-100 text-xs rounded-lg p-4 overflow-x-auto">
{mcpConfig}
            </pre>
            <p className="text-xs text-gray-500 mt-2">
              启用后会得到 9 个工具：list_pg_pools / list_templates / create_project /
              list_workflows / get_workflow / create_workflow / update_workflow /
              debug_workflow / run_workflow。
            </p>
          </div>
        </div>
      </div>

      {/* 创建抽屉 */}
      <Drawer
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        title={createdToken ? '保存平台令牌' : '创建平台令牌'}
        size="md"
        footer={
          createdToken ? (
            <button
              onClick={() => {
                setShowCreate(false)
                setCreatedToken(null)
              }}
              className="w-full btn-primary"
            >
              我已保存，关闭
            </button>
          ) : (
            <div className="flex gap-3">
              <button
                onClick={() => setShowCreate(false)}
                className="flex-1 h-11 px-5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !form.name.trim() || form.scopes.length === 0}
                className="flex-1 btn-primary disabled:opacity-50"
              >
                {creating ? '创建中...' : '创建'}
              </button>
            </div>
          )
        }
      >
        {createdToken ? (
          <div className="space-y-6">
            <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
              <p className="text-sm text-yellow-800">
                <i className="fas fa-exclamation-triangle mr-2"></i>
                <strong>重要：</strong>令牌只会显示这一次，请立即保存！
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">您的平台令牌</label>
              <div className="flex items-center space-x-2">
                <input
                  type="text"
                  value={createdToken}
                  readOnly
                  className="flex-1 input-base font-mono text-sm bg-gray-50"
                />
                <button
                  onClick={() => copy(createdToken)}
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
                令牌名称 <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例如：mcp-bot"
                className="w-full input-base"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">权限 Scope</label>
              <div className="space-y-2">
                {ALL_SCOPES.map((s) => (
                  <label key={s.value} className="flex items-start space-x-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.scopes.includes(s.value)}
                      onChange={() => toggleScope(s.value)}
                      className="mt-0.5 rounded border-gray-300 text-indigo-600"
                    />
                    <span className="text-sm">
                      <span className="font-mono text-indigo-700">{s.value}</span>
                      <span className="text-gray-500"> —— {s.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">有效期</label>
              <select
                value={form.expires_in_days}
                onChange={(e) => setForm({ ...form, expires_in_days: parseInt(e.target.value) })}
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
