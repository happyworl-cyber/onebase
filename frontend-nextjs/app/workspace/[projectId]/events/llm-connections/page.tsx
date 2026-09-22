'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
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
  const t = useTranslations('wsLlmConn')
  const tc = useTranslations('connCommon')
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const caps = useCurrentProjectCapabilities()

  if (!caps.canManageEvents) {
    return (
      <ForbiddenPlaceholder reason={t('forbidden')} />
    )
  }

  if (isNaN(projectId) || projectId <= 0) {
    return (
      <div className="text-center py-12 text-gray-400">
        <i className="fas fa-spinner fa-spin text-2xl"></i>
        <p className="text-sm mt-2">{tc('loadingCtx')}</p>
      </div>
    )
  }

  return <LlmConnectionsManager tenantId={projectId} />
}

function LlmConnectionsManager({ tenantId }: { tenantId: number }) {
  const t = useTranslations('wsLlmConn')
  const tc = useTranslations('connCommon')
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
          <span className="text-sm font-medium text-gray-700">{t('title')}</span>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="text-xs text-indigo-600 hover:underline"
          >
            {tc('new')}
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          {loading && <p className="p-3 text-xs text-gray-400">{tc('loading')}</p>}
          {!loading && connections.length === 0 && (
            <p className="p-3 text-xs text-gray-400">{t('empty')}</p>
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
              {!c.is_active && <div className="text-xs text-amber-600">{tc('disabled')}</div>}
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
          <p className="text-sm text-gray-400">{tc('selectLeft')}</p>
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
  const t = useTranslations('wsLlmConn')
  const tc = useTranslations('connCommon')
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
        notify.success(tc('saved'))
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
        notify.success(tc('created'))
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
        notify.success(t('testOk', { status: res.data.status ? ` (HTTP ${res.data.status})` : '' }))
      } else {
        notify.error(res.data.error || tc('testFail'))
      }
    } catch (e) {
      notify.error(e instanceof Error ? e.message : tc('testFail'))
    } finally {
      setTesting(false)
    }
  }

  const remove = async () => {
    if (!existing || !onDeleted) return
    if (!window.confirm(t('confirmDelete', { name: existing.connection_name }))) {
      return
    }
    try {
      await llmAPI.deleteConnection(existing.id)
      notify.success(tc('deleted'))
      await onDeleted()
    } catch {
      /* toast */
    }
  }

  return (
    <div className="max-w-xl space-y-4">
      <h2 className="text-base font-semibold text-gray-800">{existing ? tc('editConn') : tc('newConn')}</h2>
      <label className="block">
        <span className="text-xs text-gray-500">{tc('nameLabel')}</span>
        <input
          className="mt-1 w-full border rounded-lg px-3 py-2 text-sm"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="block">
        <span className="text-xs text-gray-500">{t('baseUrl')}</span>
        <input
          className="mt-1 w-full border rounded-lg px-3 py-2 text-sm font-mono"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.openai.com/v1"
        />
      </label>
      <label className="block">
        <span className="text-xs text-gray-500">{t('credOptional')}</span>
        <select
          className="mt-1 w-full border rounded-lg px-3 py-2 text-sm"
          value={credentialId}
          onChange={(e) => setCredentialId(e.target.value)}
        >
          <option value="">{t('noAuth')}</option>
          {credentials.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}（{c.kind}）
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-xs text-gray-500">{t('models')}</span>
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
        {tc('enabled')}
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm disabled:opacity-50"
        >
          {saving ? tc('saving') : tc('save')}
        </button>
        <button
          type="button"
          disabled={testing}
          onClick={() => void test()}
          className="px-3 py-1.5 rounded-lg border text-sm"
        >
          {testing ? tc('testing') : tc('test')}
        </button>
        {!existing && (
          <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded-lg border text-sm">
            {tc('cancel')}
          </button>
        )}
        {existing && (
          <button type="button" onClick={() => void remove()} className="px-3 py-1.5 rounded-lg border text-sm text-red-600">
            {tc('delete')}
          </button>
        )}
      </div>
    </div>
  )
}
