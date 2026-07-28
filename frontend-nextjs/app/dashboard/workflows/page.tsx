'use client'

import { useState, useEffect, useCallback } from 'react'
import dynamic from 'next/dynamic'
import api from '@/lib/api'
import type { WorkflowNodeDef, WorkflowEdgeDef } from '@/components/workflow/WorkflowCanvas'

const WorkflowCanvas = dynamic(() => import('@/components/workflow/WorkflowCanvas'), { ssr: false })

interface Workflow {
  id: number
  name: string
  slug: string
  description: string | null
  database_id: number | null
  trigger_type: string
  trigger_config: any
  nodes: WorkflowNodeDef[]
  edges: WorkflowEdgeDef[]
  is_enabled: boolean
  timeout_ms: number
  max_retries: number
  created_at: string
  updated_at: string
}

interface WorkflowRun {
  id: number
  workflow_id: number
  trigger_type: string
  status: string
  node_results: any[]
  final_output: any
  error_message: string | null
  elapsed_ms: number | null
  started_at: string
  completed_at: string | null
}

const TRIGGER_TYPES = [
  { value: 'endpoint', label: 'HTTP 端点', icon: '🌐', desc: 'POST /workflow/:db/:slug' },
  { value: 'hook', label: '数据变更', icon: '⚡', desc: '监听表 CRUD 自动触发' },
  { value: 'cron', label: '定时任务', icon: '⏰', desc: '按 Cron 表达式定期执行' },
  { value: 'manual', label: '手动触发', icon: '👆', desc: '仅通过面板手动执行' },
]

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  running: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
}

export default function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<'list' | 'editor'>('list')
  const [editing, setEditing] = useState<Workflow | null>(null)
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [showRuns, setShowRuns] = useState<number | null>(null)

  // Editor form state
  const [formMeta, setFormMeta] = useState({
    name: '', slug: '', description: '', database_id: '',
    trigger_type: 'endpoint', trigger_config: '{}',
    timeout_ms: 30000, max_retries: 0,
  })
  const [editorNodes, setEditorNodes] = useState<WorkflowNodeDef[]>([])
  const [editorEdges, setEditorEdges] = useState<WorkflowEdgeDef[]>([])

  useEffect(() => { load() }, [])

  const load = async () => {
    setLoading(true)
    try {
      const res = await api.get('/api/admin/workflows')
      setWorkflows(res.data.workflows || [])
    } catch (err) {
      console.error('加载失败:', err)
    } finally {
      setLoading(false)
    }
  }

  const openEditor = (wf?: Workflow) => {
    if (wf) {
      setEditing(wf)
      setFormMeta({
        name: wf.name, slug: wf.slug,
        description: wf.description || '',
        database_id: wf.database_id?.toString() || '',
        trigger_type: wf.trigger_type,
        trigger_config: JSON.stringify(wf.trigger_config || {}, null, 2),
        timeout_ms: wf.timeout_ms, max_retries: wf.max_retries,
      })
      setEditorNodes(wf.nodes || [])
      setEditorEdges(wf.edges || [])
    } else {
      setEditing(null)
      setFormMeta({
        name: '', slug: '', description: '', database_id: '',
        trigger_type: 'endpoint', trigger_config: '{}',
        timeout_ms: 30000, max_retries: 0,
      })
      setEditorNodes([
        { id: 'start', type: 'code', label: '处理逻辑', config: { code: 'function execute(ctx)\n  ctx.body = { ok = true }\nend' } }
      ])
      setEditorEdges([])
    }
    setView('editor')
  }

  const handleCanvasChange = useCallback((nodes: WorkflowNodeDef[], edges: WorkflowEdgeDef[]) => {
    setEditorNodes(nodes)
    setEditorEdges(edges)
  }, [])

  const handleSave = async () => {
    let triggerConfig: any
    try { triggerConfig = JSON.parse(formMeta.trigger_config) } catch { return alert('触发配置 JSON 格式错误') }

    // Strip internal _position from config before saving (keep for frontend)
    const cleanNodes = editorNodes.map(n => ({
      ...n,
      config: { ...n.config, _position: n.config._position },
    }))

    const payload = {
      name: formMeta.name,
      slug: formMeta.slug,
      description: formMeta.description || null,
      database_id: formMeta.database_id ? parseInt(formMeta.database_id) : null,
      trigger_type: formMeta.trigger_type,
      trigger_config: triggerConfig,
      nodes: cleanNodes,
      edges: editorEdges,
      timeout_ms: formMeta.timeout_ms,
      max_retries: formMeta.max_retries,
    }

    try {
      if (editing) {
        await api.patch(`/api/admin/workflows/${editing.id}`, payload)
      } else {
        await api.post('/api/admin/workflows', payload)
      }
      setView('list')
      load()
    } catch (err: any) {
      alert(err.response?.data?.error || '保存失败')
    }
  }

  const handleDelete = async (id: number) => {
    if (!confirm('确认删除此工作流？')) return
    try {
      await api.delete(`/api/admin/workflows/${id}`)
      load()
    } catch (err: any) {
      alert(err.response?.data?.error || '删除失败')
    }
  }

  const handleTrigger = async (id: number) => {
    try {
      await api.post(`/api/admin/workflows/${id}/trigger`, {})
      alert('工作流已触发')
      if (showRuns === id) loadRuns(id)
    } catch (err: any) {
      alert(err.response?.data?.error || '触发失败')
    }
  }

  const loadRuns = async (id: number) => {
    try {
      const res = await api.get(`/api/admin/workflows/${id}/runs?limit=20`)
      setRuns(res.data.runs || [])
      setShowRuns(id)
    } catch {}
  }

  const handleToggle = async (wf: Workflow) => {
    try {
      await api.patch(`/api/admin/workflows/${wf.id}`, { is_enabled: !wf.is_enabled })
      load()
    } catch (err: any) {
      alert(err.response?.data?.error || '操作失败')
    }
  }

  // ── Editor View ──
  if (view === 'editor') {
    return (
      <div className="h-[calc(100vh-64px)] flex flex-col">
        {/* Top bar */}
        <div className="bg-white border-b px-4 py-3 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-4">
            <button onClick={() => setView('list')} className="text-gray-500 hover:text-gray-700 flex items-center gap-1">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
              返回
            </button>
            <div className="h-5 w-px bg-gray-200" />
            <h2 className="font-semibold text-gray-800">{editing ? `编辑: ${editing.name}` : '新建工作流'}</h2>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setView('list')} className="px-4 py-1.5 text-sm text-gray-600 hover:text-gray-800">取消</button>
            <button onClick={handleSave} className="px-5 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium">
              保存
            </button>
          </div>
        </div>

        {/* Settings strip */}
        <div className="bg-white border-b px-4 py-2 flex items-center gap-4 shrink-0 overflow-x-auto">
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 whitespace-nowrap">名称</label>
            <input value={formMeta.name} onChange={e => setFormMeta(f => ({ ...f, name: e.target.value }))}
              className="px-2 py-1 border rounded text-sm w-36" placeholder="工作流名称" />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 whitespace-nowrap">Slug</label>
            <input value={formMeta.slug} onChange={e => setFormMeta(f => ({ ...f, slug: e.target.value }))}
              className="px-2 py-1 border rounded text-sm font-mono w-32" placeholder="my-api" />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 whitespace-nowrap">触发</label>
            <select value={formMeta.trigger_type} onChange={e => setFormMeta(f => ({ ...f, trigger_type: e.target.value }))}
              className="px-2 py-1 border rounded text-sm">
              {TRIGGER_TYPES.map(t => <option key={t.value} value={t.value}>{t.icon} {t.label}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 whitespace-nowrap">DB ID</label>
            <input value={formMeta.database_id} onChange={e => setFormMeta(f => ({ ...f, database_id: e.target.value }))}
              className="px-2 py-1 border rounded text-sm w-16" type="number" placeholder="-" />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 whitespace-nowrap">超时</label>
            <input value={formMeta.timeout_ms} onChange={e => setFormMeta(f => ({ ...f, timeout_ms: parseInt(e.target.value) || 30000 }))}
              className="px-2 py-1 border rounded text-sm w-20" type="number" />
            <span className="text-xs text-gray-400">ms</span>
          </div>
          {formMeta.trigger_type === 'hook' && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500 whitespace-nowrap">Hook 配置</label>
              <input value={formMeta.trigger_config} onChange={e => setFormMeta(f => ({ ...f, trigger_config: e.target.value }))}
                className="px-2 py-1 border rounded text-sm font-mono w-64" placeholder='{"table":"posts","actions":["INSERT"]}' />
            </div>
          )}
          {formMeta.trigger_type === 'endpoint' && formMeta.slug && (
            <div className="ml-auto text-xs text-indigo-600 font-mono whitespace-nowrap">
              POST /workflow/{formMeta.database_id || ':db'}/{formMeta.slug}
            </div>
          )}
        </div>

        {/* Canvas */}
        <div className="flex-1 min-h-0">
          <WorkflowCanvas
            key={editing?.id || 'new'}
            initialNodes={editorNodes}
            initialEdges={editorEdges}
            onChange={handleCanvasChange}
          />
        </div>
      </div>
    )
  }

  // ── List View ──
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">工作流</h1>
          <p className="text-sm text-gray-500 mt-1">
            可视化编排自定义 API — 支持 Lua / SQL / HTTP / 条件分支
          </p>
        </div>
        <button
          onClick={() => openEditor()}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors font-medium flex items-center gap-2"
        >
          <span className="text-lg leading-none">+</span> 新建工作流
        </button>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-400">加载中...</div>
      ) : workflows.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-xl border-2 border-dashed border-gray-200">
          <div className="text-5xl mb-4">⚡</div>
          <h3 className="text-lg font-medium text-gray-700 mb-2">还没有工作流</h3>
          <p className="text-sm text-gray-400 mb-6">创建你的第一个工作流，可视化编排 API 逻辑</p>
          <button
            onClick={() => openEditor()}
            className="px-5 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
          >
            创建工作流
          </button>
        </div>
      ) : (
        <div className="grid gap-4">
          {workflows.map(wf => (
            <div key={wf.id} className={`bg-white rounded-xl border p-5 transition-opacity ${!wf.is_enabled ? 'opacity-50' : ''}`}>
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-lg">{TRIGGER_TYPES.find(t => t.value === wf.trigger_type)?.icon}</span>
                    <h3 className="font-semibold text-gray-900">{wf.name}</h3>
                    <code className="text-xs bg-gray-100 px-2 py-0.5 rounded text-gray-600 font-mono">{wf.slug}</code>
                    <span className="px-2 py-0.5 rounded text-xs font-medium bg-indigo-50 text-indigo-700">
                      {TRIGGER_TYPES.find(t => t.value === wf.trigger_type)?.label}
                    </span>
                  </div>
                  {wf.description && <p className="text-sm text-gray-500 mt-1">{wf.description}</p>}
                  <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
                    <span>{wf.nodes?.length || 0} 节点</span>
                    <span>{wf.edges?.length || 0} 连接</span>
                    {wf.trigger_type === 'endpoint' && (
                      <span className="font-mono text-indigo-500">POST /workflow/{wf.database_id}/{wf.slug}</span>
                    )}
                    {wf.trigger_type === 'hook' && wf.trigger_config?.table && (
                      <span>监听: {wf.trigger_config.schema || 'public'}.{wf.trigger_config.table}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-4">
                  <button onClick={() => handleToggle(wf)}
                    className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${wf.is_enabled ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
                    {wf.is_enabled ? '启用' : '禁用'}
                  </button>
                  <button onClick={() => handleTrigger(wf.id)} className="px-3 py-1.5 text-xs bg-amber-50 text-amber-700 rounded-lg hover:bg-amber-100">运行</button>
                  <button onClick={() => loadRuns(wf.id)} className="px-3 py-1.5 text-xs bg-gray-50 text-gray-600 rounded-lg hover:bg-gray-100">记录</button>
                  <button onClick={() => openEditor(wf)} className="px-3 py-1.5 text-xs bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100">编辑</button>
                  <button onClick={() => handleDelete(wf.id)} className="px-3 py-1.5 text-xs bg-red-50 text-red-600 rounded-lg hover:bg-red-100">删除</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Run history modal */}
      {showRuns !== null && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowRuns(null)}>
          <div className="bg-white rounded-xl shadow-xl w-[900px] max-h-[80vh] overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="p-4 border-b flex justify-between items-center">
              <h3 className="font-semibold">执行记录</h3>
              <button onClick={() => setShowRuns(null)} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
            </div>
            <div className="overflow-auto max-h-[65vh] p-4">
              {runs.length === 0 ? (
                <p className="text-center text-gray-400 py-8">暂无执行记录</p>
              ) : (
                <div className="space-y-3">
                  {runs.map(run => (
                    <div key={run.id} className="border rounded-lg p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className="text-sm font-mono text-gray-500">#{run.id}</span>
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[run.status] || 'bg-gray-100'}`}>
                            {run.status}
                          </span>
                          {run.elapsed_ms != null && <span className="text-xs text-gray-400">{run.elapsed_ms}ms</span>}
                        </div>
                        <span className="text-xs text-gray-400">{run.started_at}</span>
                      </div>
                      {run.error_message && <p className="text-xs text-red-500 mt-2 font-mono">{run.error_message}</p>}
                      {run.node_results && run.node_results.length > 0 && (
                        <div className="mt-3 flex items-center gap-2 flex-wrap">
                          {run.node_results.map((nr: any, idx: number) => (
                            <div key={idx} className={`px-2 py-1 rounded text-xs border ${
                              nr.status === 'success' ? 'bg-green-50 border-green-200 text-green-700'
                              : nr.status === 'failed' ? 'bg-red-50 border-red-200 text-red-700'
                              : 'bg-gray-50 border-gray-200 text-gray-500'
                            }`}>
                              {nr.node_id} ({nr.elapsed_ms}ms)
                            </div>
                          ))}
                        </div>
                      )}
                      {run.final_output && (
                        <details className="mt-2">
                          <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600">最终输出</summary>
                          <pre className="mt-1 p-2 bg-gray-50 rounded text-xs font-mono overflow-auto max-h-32">
                            {JSON.stringify(run.final_output, null, 2)}
                          </pre>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
