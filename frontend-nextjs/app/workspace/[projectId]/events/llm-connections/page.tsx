'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import {
  llmAPI,
  wfCredentialAPI,
  type LlmConnection,
  type WfCredential,
} from '@/lib/api'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import { useNotification } from '@/hooks/useNotification'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'

export default function LlmConnectionsPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const caps = useCurrentProjectCapabilities()

  if (!caps.canManageEvents) {
    return (
      <ForbiddenPlaceholder reason="LLM 连接管理需要 admin+ 角色（owner / admin / 超管）" />
    )
  }

  if (isNaN(projectId) || projectId <= 0) {
    return (
      <div className="text-center py-12 text-gray-400">
        <i className="fas fa-spinner fa-spin text-2xl"></i>
        <p className="text-sm mt-2">正在加载项目上下文…</p>
      </div>
    )
  }

  return <LlmConnectionsManager tenantId={projectId} />
}

function LlmConnectionsManager({ tenantId }: { tenantId: number }) {
  const notify = useNotification()
  const [connections, setConnections] = useState<LlmConnection[]>([])
  const [credentials, setCredentials] = useState<WfCredential[]>([])
  const [loading, setLoading] = useState(true)
  const [activeId, setActiveId] = useState<number | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [connRes, credRes] = await Promise.all([
        llmAPI.listConnections(tenantId),
        wfCredentialAPI.list(tenantId),
      ])
      const rows = connRes.data.filter((c) => c.tenant_id === tenantId)
      setConnections(rows)
      setCredentials(credRes.data)
      setActiveId((prev) => {
        if (prev !== null && rows.some((c) => c.id === prev)) return prev
        return rows[0]?.id ?? null
      })
    } catch {
      /* 全局拦截器已弹错误 */
    } finally {
      setLoading(false)
    }
  }, [tenantId])

  useEffect(() => {
    void load()
  }, [load])

  const active = connections.find((c) => c.id === activeId) ?? null

  return (
    <div className="flex h-full min-h-[480px] gap-4">
      <aside className="w-72 shrink-0 border rounded-xl bg-white overflow-hidden flex flex-col">
        <div className="px-3 py-2 border-b flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700">LLM 连接</span>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="text-xs text-indigo-600 hover:underline"
          >
            新建
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          {loading && <p className="p-3 text-xs text-gray-400">加载中…</p>}
          {!loading && connections.length === 0 && (
            <p className="p-3 text-xs text-gray-400">还没有连接。登记 OpenAI 兼容的 base_url + 可选凭证。</p>
          )}
          {connections.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                setShowCreate(false)
                setActiveId(c.id)
              }}
              className={`w-full text-left px-3 py-2 border-b text-sm ${
                !showCreate && c.id === activeId ? 'bg-indigo-50 text-indigo-800' : 'hover:bg-slate-50'
              }`}
            >
              <div className="font-medium truncate">{c.connection_name}</div>
              <div className="text-xs text-gray-400 truncate">{c.base_url}</div>
              {!c.is_active && <div className="text-xs text-amber-600">已停用</div>}
            </button>
          ))}
        </div>
      </aside>
      <section className="flex-1 border rounded-xl bg-white p-4 overflow-auto">
        {showCreate ? (
          <LlmConnectionForm
            tenantId={tenantId}
            credentials={credentials}
            onCancel={() => setShowCreate(false)}
            onSaved={async (id) => {
              await load()
              setShowCreate(false)
              setActiveId(id)
            }}
          />
        ) : active ? (
          <LlmConnectionForm
            tenantId={tenantId}
            credentials={credentials}
            existing={active}
            onCancel={() => {}}
            onSaved={async () => {
              await load()
            }}
            onDeleted={async () => {
              await load()
              setActiveId(null)
            }}
          />
        ) : (
          <p className="text-sm text-gray-400">选择左侧连接，或新建一条。</p>
        )}
      </section>
    </div>
  )
}

function LlmConnectionForm({
  tenantId,
  credentials,
  existing,
  onCancel,
  onSaved,
  onDeleted,
}: {
  tenantId: number
  credentials: WfCredential[]
  existing?: LlmConnection
  onCancel: () => void
  onSaved: (id: number) => void | Promise<void>
  onDeleted?: () => void | Promise<void>
}) {
  const notify = useNotification()
  const [name, setName] = useState(existing?.connection_name ?? '')
  const [baseUrl, setBaseUrl] = useState(existing?.base_url ?? '')
  const [credentialId, setCredentialId] = useState<string>(
    existing?.credential_id != null ? String(existing.credential_id) : '',
  )
  const [modelsText, setModelsText] = useState((existing?.models ?? []).join(', '))
  const [isActive, setIsActive] = useState(existing?.is_active ?? true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    setName(existing?.connection_name ?? '')
    setBaseUrl(existing?.base_url ?? '')
    setCredentialId(existing?.credential_id != null ? String(existing.credential_id) : '')
    setModelsText((existing?.models ?? []).join(', '))
    setIsActive(existing?.is_active ?? true)
  }, [existing])

  const models = useMemo(
    () =>
      modelsText
        .split(/[,，\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
    [modelsText],
  )

  const credId = credentialId === '' ? null : Number(credentialId)

  const save = async () => {
    setSaving(true)
    try {
      if (existing) {
        await llmAPI.updateConnection(existing.id, {
          connection_name: name,
          base_url: baseUrl,
          credential_id: credId,
          models,
          is_active: isActive,
        })
        notify.success('已保存')
        await onSaved(existing.id)
      } else {
        const res = await llmAPI.createConnection({
          tenant_id: tenantId,
          connection_name: name,
          base_url: baseUrl,
          credential_id: credId,
          models,
          is_active: isActive,
        })
        notify.success('已创建')
        await onSaved(res.data.id)
      }
    } catch {
      /* toast */
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    try {
      const res = existing
        ? await llmAPI.healthConnection(existing.id)
        : await llmAPI.testConnection({
            tenant_id: tenantId,
            base_url: baseUrl,
            credential_id: credId,
          })
      if (res.data.ok) {
        notify.success(`探活成功${res.data.status ? `（HTTP ${res.data.status}）` : ''}`)
      } else {
        notify.error(res.data.error || '探活失败')
      }
    } catch (e) {
      notify.error(e instanceof Error ? e.message : '探活失败')
    } finally {
      setTesting(false)
    }
  }

  const remove = async () => {
    if (!existing || !onDeleted) return
    if (!window.confirm(`删除连接「${existing.connection_name}」？引用它的 llm 节点运行时会失败。`)) {
      return
    }
    try {
      await llmAPI.deleteConnection(existing.id)
      notify.success('已删除')
      await onDeleted()
    } catch {
      /* toast */
    }
  }

  return (
    <div className="max-w-xl space-y-4">
      <h2 className="text-base font-semibold text-gray-800">{existing ? '编辑连接' : '新建连接'}</h2>
      <label className="block">
        <span className="text-xs text-gray-500">名称</span>
        <input
          className="mt-1 w-full border rounded-lg px-3 py-2 text-sm"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="block">
        <span className="text-xs text-gray-500">base_url（OpenAI 兼容根，建议含 /v1）</span>
        <input
          className="mt-1 w-full border rounded-lg px-3 py-2 text-sm font-mono"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.openai.com/v1"
        />
      </label>
      <label className="block">
        <span className="text-xs text-gray-500">凭证（可选）</span>
        <select
          className="mt-1 w-full border rounded-lg px-3 py-2 text-sm"
          value={credentialId}
          onChange={(e) => setCredentialId(e.target.value)}
        >
          <option value="">无认证（如本机 Ollama）</option>
          {credentials.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}（{c.kind}）
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-xs text-gray-500">模型列表（逗号分隔）</span>
        <textarea
          className="mt-1 w-full border rounded-lg px-3 py-2 text-sm font-mono"
          rows={2}
          value={modelsText}
          onChange={(e) => setModelsText(e.target.value)}
          placeholder="deepseek-chat, deepseek-reasoner"
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        启用
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm disabled:opacity-50"
        >
          {saving ? '保存中…' : '保存'}
        </button>
        <button
          type="button"
          disabled={testing}
          onClick={() => void test()}
          className="px-3 py-1.5 rounded-lg border text-sm"
        >
          {testing ? '探活中…' : '测试连接'}
        </button>
        {!existing && (
          <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded-lg border text-sm">
            取消
          </button>
        )}
        {existing && (
          <button type="button" onClick={() => void remove()} className="px-3 py-1.5 rounded-lg border text-sm text-red-600">
            删除
          </button>
        )}
      </div>
    </div>
  )
}
