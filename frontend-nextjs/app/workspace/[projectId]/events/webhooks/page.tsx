'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import api from '@/lib/api'
import PermissionGate from '@/components/PermissionGate'
import { useTranslations } from 'next-intl'

interface Webhook {
  id: number
  tenant_id: number
  name: string
  url: string
  event_pattern: string
  headers: any
  retry_count: number
  timeout_ms: number
  is_active: boolean
}

export default function WebhooksPage() {
  const t = useTranslations('wsWebhooks')
  return (
    <PermissionGate requires="canManageWebhooks" pageName={t('gate')}>
      <WebhooksPageInner />
    </PermissionGate>
  )
}

function WebhooksPageInner() {
  // W2：tenant_id 来自 URL 的 projectId。这里不能展示后端返回的超管全量列表，
  // workspace 视图必须锁定当前项目。
  const t = useTranslations('wsWebhooks')
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)

  const [webhooks, setWebhooks] = useState<Webhook[]>([])
  const [loading, setLoading] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Webhook | null>(null)
  const [testResult, setTestResult] = useState<any>(null)
  const [form, setForm] = useState({
    tenant_id: projectId,
    name: '',
    url: '',
    event_pattern: '*.*.*',
    headers: '{}',
    secret: '',
    retry_count: 3,
    timeout_ms: 5000,
  })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get('/api/admin/webhooks', {
        params: { tenant_id: projectId },
      })
      const rows = Array.isArray(res.data.data) ? res.data.data : []
      setWebhooks(rows.filter((wh: Webhook) => wh.tenant_id === projectId))
    } catch (err) {
      console.error(t('loadFailed'), err)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { load() }, [load])

  const resetForm = () => {
    setForm({ tenant_id: projectId, name: '', url: '', event_pattern: '*.*.*', headers: '{}', secret: '', retry_count: 3, timeout_ms: 5000 })
    setEditing(null)
    setTestResult(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      let headersJson: any = {}
      try { headersJson = JSON.parse(form.headers) } catch {}

      const payload = { ...form, headers: headersJson, secret: form.secret || undefined }

      if (editing) {
        await api.patch(`/api/admin/webhooks/${editing.id}`, payload)
      } else {
        await api.post('/api/admin/webhooks', payload)
      }
      setShowForm(false)
      resetForm()
      load()
    } catch (err: any) {
      alert(t('saveFailed', { msg: err.response?.data?.error || err.message }))
    }
  }

  const handleDelete = async (id: number) => {
    if (!confirm(t('confirmDelete'))) return
    try {
      await api.delete(`/api/admin/webhooks/${id}`)
      load()
    } catch (err: any) {
      alert(t('deleteFailed', { msg: err.response?.data?.error || err.message }))
    }
  }

  const handleToggle = async (wh: Webhook) => {
    try {
      await api.patch(`/api/admin/webhooks/${wh.id}`, { is_active: !wh.is_active })
      load()
    } catch (err: any) {
      alert(t('toggleFailed', { msg: err.response?.data?.error || err.message }))
    }
  }

  const handleTest = async (id: number) => {
    setTestResult(null)
    try {
      const res = await api.post(`/api/admin/webhooks/${id}/test`)
      setTestResult({ id, ...res.data })
    } catch (err: any) {
      setTestResult({ id, success: false, error: err.message })
    }
  }

  const handleEdit = (wh: Webhook) => {
    setEditing(wh)
    setForm({
      tenant_id: wh.tenant_id,
      name: wh.name,
      url: wh.url,
      event_pattern: wh.event_pattern,
      headers: JSON.stringify(wh.headers || {}, null, 2),
      secret: '',
      retry_count: wh.retry_count,
      timeout_ms: wh.timeout_ms,
    })
    setShowForm(true)
  }

  const patternPresets = [
    { labelKey: 'presetAll', value: '*.*.*' },
    { labelKey: 'presetInsert', value: '*.*.INSERT' },
    { labelKey: 'presetUpdate', value: '*.*.UPDATE' },
    { labelKey: 'presetDelete', value: '*.*.DELETE' },
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">{t('title')}</h1>
          <p className="text-sm text-gray-500 mt-1">{t('subtitle')}</p>
        </div>
        <button
          onClick={() => { setShowForm(!showForm); if (showForm) resetForm(); }}
          className="btn-primary"
        >
          <i className={`fas ${showForm ? 'fa-times' : 'fa-plus'} text-xs mr-2`}></i>
          {showForm ? t('cancel') : t('addWebhook')}
        </button>
      </div>

      {showForm && (
        <div className="card p-6">
          <h2 className="text-lg font-semibold mb-4">{editing ? t('editTitle') : t('newTitle')}</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('fName')}</label>
                <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input-base w-full" required />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">URL *</label>
                <input type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} className="input-base w-full" placeholder="https://example.com/webhook" required />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t('fEventPattern')} <span className="text-gray-400 text-xs">{t('eventPatternHint')}</span>
              </label>
              <div className="flex items-center space-x-2">
                <input type="text" value={form.event_pattern} onChange={(e) => setForm({ ...form, event_pattern: e.target.value })} className="input-base flex-1" />
                <div className="flex space-x-1">
                  {patternPresets.map((p) => (
                    <button key={p.value} type="button" onClick={() => setForm({ ...form, event_pattern: p.value })}
                      className="px-2 py-1 text-xs rounded bg-gray-100 hover:bg-gray-200 text-gray-600">{t(p.labelKey)}</button>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('fSecret')}</label>
                <input type="text" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} className="input-base w-full" placeholder={t('phSecret')} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('fRetry')}</label>
                <input type="number" value={form.retry_count} onChange={(e) => setForm({ ...form, retry_count: parseInt(e.target.value) })} className="input-base w-full" min={1} max={10} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('fTimeout')}</label>
                <input type="number" value={form.timeout_ms} onChange={(e) => setForm({ ...form, timeout_ms: parseInt(e.target.value) })} className="input-base w-full" min={1000} max={30000} step={1000} />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('fHeaders')}</label>
              <textarea value={form.headers} onChange={(e) => setForm({ ...form, headers: e.target.value })} className="input-base w-full font-mono text-xs" rows={3} />
            </div>

            <div className="flex space-x-3 pt-4 border-t">
              <button type="submit" className="btn-primary">
                <i className="fas fa-save mr-2"></i>{editing ? t('save') : t('create')}
              </button>
              <button type="button" onClick={() => { setShowForm(false); resetForm(); }} className="btn-default">{t('cancel')}</button>
            </div>
          </form>
        </div>
      )}

      {/* Webhook 列表 */}
      <div className="space-y-3">
        {loading ? (
          <div className="text-center py-12 text-gray-400"><i className="fas fa-spinner fa-spin text-2xl"></i></div>
        ) : webhooks.length === 0 ? (
          <div className="text-center py-12">
            <i className="fas fa-satellite-dish text-5xl text-gray-300 mb-4"></i>
            <p className="text-gray-500">{t('emptyList')}</p>
          </div>
        ) : (
          webhooks.map((wh) => (
            <div key={wh.id} className={`card p-5 ${!wh.is_active ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center space-x-3 mb-2">
                    <h3 className="text-sm font-semibold text-gray-900">{wh.name}</h3>
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${wh.is_active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-500'}`}>
                      {wh.is_active ? t('enabled') : t('disabled')}
                    </span>
                    <span className="px-2 py-0.5 rounded text-xs font-mono bg-purple-100 text-purple-700">{wh.event_pattern}</span>
                  </div>
                  <p className="text-xs text-gray-500 font-mono mb-1">{wh.url}</p>
                  <p className="text-xs text-gray-400">{t('retryTimeout', { retry: wh.retry_count, timeout: wh.timeout_ms })}</p>
                </div>
                <div className="flex items-center space-x-2">
                  <button onClick={() => handleTest(wh.id)} className="btn-default text-xs">
                    <i className="fas fa-play mr-1"></i>{t('test')}
                  </button>
                  <button onClick={() => handleEdit(wh)} className="btn-default text-xs">
                    <i className="fas fa-edit mr-1"></i>{t('edit')}
                  </button>
                  <button onClick={() => handleToggle(wh)} className="btn-default text-xs">
                    <i className={`fas ${wh.is_active ? 'fa-pause' : 'fa-play'} mr-1`}></i>
                    {wh.is_active ? t('disabled') : t('enabled')}
                  </button>
                  <button onClick={() => handleDelete(wh.id)} className="text-red-500 hover:text-red-700 text-xs px-2 py-1">
                    <i className="fas fa-trash"></i>
                  </button>
                </div>
              </div>
              {testResult && testResult.id === wh.id && (
                <div className={`mt-3 p-3 rounded-lg text-xs ${testResult.success ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
                  {testResult.success
                    ? t('testOk', { status: testResult.status })
                    : t('testFail', { err: testResult.error || `HTTP ${testResult.status}` })}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
