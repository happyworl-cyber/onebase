'use client'

import { useState, useEffect } from 'react'
import api from '@/lib/api'
import PermissionGate from '@/components/PermissionGate'

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
  return (
    <PermissionGate requires="canManageWebhooks" pageName="Webhook 管理">
      <WebhooksPageInner />
    </PermissionGate>
  )
}

function WebhooksPageInner() {
  const [webhooks, setWebhooks] = useState<Webhook[]>([])
  const [loading, setLoading] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Webhook | null>(null)
  const [testResult, setTestResult] = useState<any>(null)
  const [form, setForm] = useState({
    tenant_id: 1,
    name: '',
    url: '',
    event_pattern: '*.*.*',
    headers: '{}',
    secret: '',
    retry_count: 3,
    timeout_ms: 5000,
  })

  useEffect(() => { load() }, [])

  const load = async () => {
    setLoading(true)
    try {
      const res = await api.get('/api/admin/webhooks')
      setWebhooks(res.data.data || [])
    } catch (err) {
      console.error('加载 Webhook 失败:', err)
    } finally {
      setLoading(false)
    }
  }

  const resetForm = () => {
    setForm({ tenant_id: 1, name: '', url: '', event_pattern: '*.*.*', headers: '{}', secret: '', retry_count: 3, timeout_ms: 5000 })
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
      alert('保存失败: ' + (err.response?.data?.error || err.message))
    }
  }

  const handleDelete = async (id: number) => {
    if (!confirm('确认删除此 Webhook？')) return
    try {
      await api.delete(`/api/admin/webhooks/${id}`)
      load()
    } catch (err: any) {
      alert('删除失败: ' + (err.response?.data?.error || err.message))
    }
  }

  const handleToggle = async (wh: Webhook) => {
    try {
      await api.patch(`/api/admin/webhooks/${wh.id}`, { is_active: !wh.is_active })
      load()
    } catch (err: any) {
      alert('操作失败: ' + (err.response?.data?.error || err.message))
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
    { label: '全部事件', value: '*.*.*' },
    { label: '所有 INSERT', value: '*.*.INSERT' },
    { label: '所有 UPDATE', value: '*.*.UPDATE' },
    { label: '所有 DELETE', value: '*.*.DELETE' },
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Webhook 管理</h1>
          <p className="text-sm text-gray-500 mt-1">数据变更时自动推送 HTTP 回调</p>
        </div>
        <button
          onClick={() => { setShowForm(!showForm); if (showForm) resetForm(); }}
          className="btn-primary"
        >
          <i className={`fas ${showForm ? 'fa-times' : 'fa-plus'} text-xs mr-2`}></i>
          {showForm ? '取消' : '添加 Webhook'}
        </button>
      </div>

      {showForm && (
        <div className="card p-6">
          <h2 className="text-lg font-semibold mb-4">{editing ? '编辑 Webhook' : '新建 Webhook'}</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">名称 *</label>
                <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input-base w-full" required />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">URL *</label>
                <input type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} className="input-base w-full" placeholder="https://example.com/webhook" required />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                事件模式 <span className="text-gray-400 text-xs">（格式: schema.table.action，支持 * 通配）</span>
              </label>
              <div className="flex items-center space-x-2">
                <input type="text" value={form.event_pattern} onChange={(e) => setForm({ ...form, event_pattern: e.target.value })} className="input-base flex-1" />
                <div className="flex space-x-1">
                  {patternPresets.map((p) => (
                    <button key={p.value} type="button" onClick={() => setForm({ ...form, event_pattern: p.value })}
                      className="px-2 py-1 text-xs rounded bg-gray-100 hover:bg-gray-200 text-gray-600">{p.label}</button>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">签名密钥</label>
                <input type="text" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} className="input-base w-full" placeholder="用于 HMAC 签名" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">重试次数</label>
                <input type="number" value={form.retry_count} onChange={(e) => setForm({ ...form, retry_count: parseInt(e.target.value) })} className="input-base w-full" min={1} max={10} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">超时 (ms)</label>
                <input type="number" value={form.timeout_ms} onChange={(e) => setForm({ ...form, timeout_ms: parseInt(e.target.value) })} className="input-base w-full" min={1000} max={30000} step={1000} />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">自定义 Headers (JSON)</label>
              <textarea value={form.headers} onChange={(e) => setForm({ ...form, headers: e.target.value })} className="input-base w-full font-mono text-xs" rows={3} />
            </div>

            <div className="flex space-x-3 pt-4 border-t">
              <button type="submit" className="btn-primary">
                <i className="fas fa-save mr-2"></i>{editing ? '保存' : '创建'}
              </button>
              <button type="button" onClick={() => { setShowForm(false); resetForm(); }} className="btn-default">取消</button>
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
            <p className="text-gray-500">暂无 Webhook 配置</p>
          </div>
        ) : (
          webhooks.map((wh) => (
            <div key={wh.id} className={`card p-5 ${!wh.is_active ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center space-x-3 mb-2">
                    <h3 className="text-sm font-semibold text-gray-900">{wh.name}</h3>
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${wh.is_active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-500'}`}>
                      {wh.is_active ? '启用' : '停用'}
                    </span>
                    <span className="px-2 py-0.5 rounded text-xs font-mono bg-purple-100 text-purple-700">{wh.event_pattern}</span>
                  </div>
                  <p className="text-xs text-gray-500 font-mono mb-1">{wh.url}</p>
                  <p className="text-xs text-gray-400">重试 {wh.retry_count} 次 / 超时 {wh.timeout_ms}ms</p>
                </div>
                <div className="flex items-center space-x-2">
                  <button onClick={() => handleTest(wh.id)} className="btn-default text-xs">
                    <i className="fas fa-play mr-1"></i>测试
                  </button>
                  <button onClick={() => handleEdit(wh)} className="btn-default text-xs">
                    <i className="fas fa-edit mr-1"></i>编辑
                  </button>
                  <button onClick={() => handleToggle(wh)} className="btn-default text-xs">
                    <i className={`fas ${wh.is_active ? 'fa-pause' : 'fa-play'} mr-1`}></i>
                    {wh.is_active ? '停用' : '启用'}
                  </button>
                  <button onClick={() => handleDelete(wh.id)} className="text-red-500 hover:text-red-700 text-xs px-2 py-1">
                    <i className="fas fa-trash"></i>
                  </button>
                </div>
              </div>
              {testResult && testResult.id === wh.id && (
                <div className={`mt-3 p-3 rounded-lg text-xs ${testResult.success ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
                  {testResult.success
                    ? `测试成功 (HTTP ${testResult.status})`
                    : `测试失败: ${testResult.error || `HTTP ${testResult.status}`}`}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
