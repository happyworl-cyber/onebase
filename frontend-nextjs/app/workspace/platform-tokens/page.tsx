'use client'

/**
 * `/workspace/platform-tokens` —— 平台服务令牌（obp_）管理 + 使用说明。
 *
 * 仅平台超管可访问。令牌用于机器 / AI 通过 HTTP 或 MCP 创建项目、管理工作流。
 * 入口在侧边栏左下角用户菜单「平台服务令牌」（仅超管可见）。
 */

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { platformTokenAPI } from '@/lib/api'
import { useNotification } from '@/hooks/useNotification'
import Drawer from '@/components/Drawer'
import { useAppStore } from '@/lib/store'

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

const ALL_SCOPES: { value: string; labelKey: string; hintKey: string }[] = [
  { value: 'project:create', labelKey: 'scopeProjectCreateLabel', hintKey: 'scopeProjectCreateHint' },
  { value: 'workflow:read', labelKey: 'scopeWorkflowReadLabel', hintKey: 'scopeWorkflowReadHint' },
  { value: 'workflow:write', labelKey: 'scopeWorkflowWriteLabel', hintKey: 'scopeWorkflowWriteHint' },
  { value: 'workflow:run', labelKey: 'scopeWorkflowRunLabel', hintKey: 'scopeWorkflowRunHint' },
]

export default function PlatformTokensPage() {
  const tr = useTranslations('platformTokensPage')
  const notify = useNotification()
  const router = useRouter()
  const currentUser = useAppStore((s) => s.currentUser)
  const [authorized, setAuthorized] = useState(false)

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
    if (typeof window === 'undefined') return
    const token = localStorage.getItem('token')
    if (!token) {
      router.replace('/login')
      return
    }
    let isSuperadmin = !!currentUser?.is_superadmin
    if (!isSuperadmin) {
      try {
        const userStr = localStorage.getItem('current_user')
        isSuperadmin = !!(userStr && JSON.parse(userStr)?.is_superadmin)
      } catch {
        isSuperadmin = false
      }
    }
    if (!isSuperadmin) {
      router.replace('/workspace')
      return
    }
    setAuthorized(true)
    loadTokens()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser, router])

  if (!authorized) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <i className="fas fa-spinner fa-spin text-2xl text-gray-400 mb-2"></i>
          <p className="text-sm text-gray-500">{tr('loadingEllipsis')}</p>
        </div>
      </div>
    )
  }

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
      notify.warning(tr('errNameRequired'))
      return
    }
    if (form.scopes.length === 0) {
      notify.warning(tr('errScopeRequired'))
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
      notify.success(tr('tokenCreated'))
      loadTokens()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (id: number, name: string) => {
    if (!confirm(tr('confirmDeactivate', { name }))) return
    try {
      await platformTokenAPI.delete(id)
      notify.success(tr('tokenDeactivated'))
      loadTokens()
    } catch (err: any) {
      notify.error(err)
    }
  }

  const copy = (text: string) => {
    navigator.clipboard.writeText(text)
    notify.success(tr('copiedToClipboard'))
  }

  const mcpConfig = `{
  "mcpServers": {
    "planeos": {
      "command": "node",
      "args": ["/absolute/path/planeos/mcp-server/dist/index.js"],
      "env": {
        "PLANEOS_BASE_URL": "${apiBase}",
        "PLANEOS_TOKEN": "obp_your_token"
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
              <i className="fas fa-arrow-left mr-1"></i> {tr('backToProjectList')}
            </Link>
            <h1 className="text-2xl font-bold text-gray-900 mt-2">{tr('pageTitle')}</h1>
            <p className="text-gray-600 mt-1 text-sm">
              {tr.rich('pageSubtitle', { code: (chunks) => <span className="font-mono">{chunks}</span> })}
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
            {tr('createTokenBtn')}
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
              <p className="mb-4">{tr('noTokensYet')}</p>
              <button
                onClick={() => {
                  resetForm()
                  setShowCreate(true)
                }}
                className="btn-primary"
              >
                <i className="fas fa-plus mr-2"></i>
                {tr('createFirstTokenBtn')}
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
                          <span className="ml-2 text-xs text-gray-400">{tr('deactivatedSuffix')}</span>
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
                          ? tr('lastUsed', { date: new Date(t.last_used_at).toLocaleString() })
                          : tr('neverUsed')}
                      </div>
                      <div>
                        {t.expires_at
                          ? tr('expiresAtLabel', { date: new Date(t.expires_at).toLocaleDateString() })
                          : tr('neverExpires')}
                      </div>
                    </div>
                    {t.is_active && (
                      <button
                        onClick={() => handleDelete(t.id, t.name)}
                        className="px-3 py-1 text-sm text-red-600 hover:bg-red-50 rounded-lg"
                      >
                        {tr('deactivateBtn')}
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
            {tr('usageGuideTitle')}
          </h2>

          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-1">{tr('scopeOverviewTitle')}</h3>
            <div className="text-sm text-gray-600 space-y-1">
              {ALL_SCOPES.map((s) => (
                <div key={s.value}>
                  <span className="font-mono text-indigo-700">{s.value}</span>
                  <span className="text-gray-400"> —— </span>
                  {tr(s.hintKey)}
                </div>
              ))}
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-1">{tr('methodOneTitle')}</h3>
            <p className="text-sm text-gray-600 mb-2">
              {tr.rich('methodOneDesc', { code: (chunks) => <span className="font-mono">{chunks}</span> })}
            </p>
            <pre className="bg-gray-900 text-gray-100 text-xs rounded-lg p-4 overflow-x-auto">
{`BASE=${apiBase}
TOKEN=obp_your_token

# 1) Available PG pools
curl -s "$BASE/api/provision/pg-pools/available" -H "Authorization: Bearer $TOKEN"

# 2) Project templates
curl -s "$BASE/api/project-templates" -H "Authorization: Bearer $TOKEN"

# 3) Provision a project (owner = the token-bound user); returns database_id / db_name
curl -s -X POST "$BASE/api/projects/provision" \\
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
  -d '{"name":"My Project","slug":"my-proj","pg_pool_id":1,"template_slug":"blank"}'

# 4) Create a workflow in that project DB (use the database_id from the previous step)
curl -s -X POST "$BASE/api/admin/workflows" \\
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
  -d '{"name":"Echo","slug":"echo","database_id":5,"trigger_type":"endpoint",
       "nodes":[{"id":"t1","type":"transform","config":{"output":{"got":"{{trigger}}"}}},
                {"id":"r","type":"response","config":{"status_code":200,"body":"{{t1}}"}}],
       "edges":[{"from":"t1","to":"r"}]}'

# 5) Trigger execution (database_slug = project slug, workflow_slug = workflow slug)
curl -s -X POST "$BASE/workflow/my-proj/echo" \\
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
  -d '{"hello":"world"}'`}
            </pre>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-sm font-semibold text-gray-700">{tr('methodTwoTitle')}</h3>
              <button
                onClick={() => copy(mcpConfig)}
                className="text-xs text-blue-600 hover:underline"
              >
                <i className="fas fa-copy mr-1"></i> {tr('copyConfigBtn')}
              </button>
            </div>
            <p className="text-sm text-gray-600 mb-2">
              {tr.rich('methodTwoDesc', {
                code1: (chunks) => <span className="font-mono">{chunks}</span>,
                code2: (chunks) => <span className="font-mono">{chunks}</span>,
                code3: (chunks) => <span className="font-mono">{chunks}</span>,
                code4: (chunks) => <span className="font-mono">{chunks}</span>,
              })}
            </p>
            <pre className="bg-gray-900 text-gray-100 text-xs rounded-lg p-4 overflow-x-auto">
{mcpConfig}
            </pre>
            <p className="text-xs text-gray-500 mt-2">
              {tr('methodTwoToolsNote')}
            </p>
          </div>
        </div>
      </div>

      {/* 创建抽屉 */}
      <Drawer
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        title={createdToken ? tr('savedTokenTitle') : tr('createTokenTitle')}
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
              {tr('savedCloseBtn')}
            </button>
          ) : (
            <div className="flex gap-3">
              <button
                onClick={() => setShowCreate(false)}
                className="flex-1 h-11 px-5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                {tr('cancelBtn')}
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !form.name.trim() || form.scopes.length === 0}
                className="flex-1 btn-primary disabled:opacity-50"
              >
                {creating ? tr('creatingEllipsis') : tr('createBtn')}
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
                {tr.rich('importantWarning', { strong: (chunks) => <strong>{chunks}</strong> })}
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">{tr('yourTokenLabel')}</label>
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
                {tr('tokenNameLabel')} <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={tr('tokenNamePlaceholder')}
                className="w-full input-base"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">{tr('scopePermissionLabel')}</label>
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
                      <span className="text-gray-500"> —— {tr(s.hintKey)}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">{tr('expiryLabel')}</label>
              <select
                value={form.expires_in_days}
                onChange={(e) => setForm({ ...form, expires_in_days: parseInt(e.target.value) })}
                className="w-full input-base"
              >
                <option value={0}>{tr('neverExpires')}</option>
                <option value={7}>{tr('days7')}</option>
                <option value={30}>{tr('days30')}</option>
                <option value={90}>{tr('days90')}</option>
                <option value={365}>{tr('year1')}</option>
              </select>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  )
}
