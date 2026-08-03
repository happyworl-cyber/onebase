'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  ssePublicEndpointAPI,
  type SsePublicEndpoint,
  type CreateSsePublicEndpointInput,
  type UpdateSsePublicEndpointInput,
} from '@/lib/api'
import { useNotification } from '@/hooks/useNotification'
import Drawer from '@/components/Drawer'

/**
 * 通用对外订阅端点（/events/:slug）管理面板。
 *
 * 业务前端用 EventSource 连 {origin}/events/{slug}，身份头由网关注入。
 * - tenantId 给定：列表只展示该租户的端点（项目工作区用）。
 */
interface FormState {
  slug: string
  name: string
  identity_header: string
  topic_template: string
  event_name: string
}

const EMPTY_FORM: FormState = {
  slug: '',
  name: '',
  identity_header: 'X-Way-UID',
  topic_template: '',
  event_name: '',
}

function toForm(e: SsePublicEndpoint): FormState {
  return {
    slug: e.slug,
    name: e.name,
    identity_header: e.identity_header,
    topic_template: e.topic_template,
    event_name: e.event_name,
  }
}

interface Props {
  tenantId?: number | null
}

export default function SsePublicEndpointPanel({ tenantId }: Props) {
  const notify = useNotification()

  const [endpoints, setEndpoints] = useState<SsePublicEndpoint[]>([])
  const [loading, setLoading] = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const [origin, setOrigin] = useState('')
  useEffect(() => {
    setOrigin(window.location.origin)
  }, [])

  const visible = useMemo(
    () => (tenantId == null ? endpoints : endpoints.filter((e) => e.tenant_id === tenantId)),
    [endpoints, tenantId],
  )

  const load = async () => {
    try {
      setLoading(true)
      // tenantId 给定时让后端按租户鉴权 + 过滤（权威）；visible 仅作前端兜底。
      const res = await ssePublicEndpointAPI.list(tenantId ?? undefined)
      setEndpoints(res.data.data ?? [])
    } catch (err) {
      notify.error(err as Error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId])

  const openCreate = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setDrawerOpen(true)
  }

  const openEdit = (e: SsePublicEndpoint) => {
    setEditingId(e.id)
    setForm(toForm(e))
    setDrawerOpen(true)
  }

  const closeDrawer = () => {
    if (saving) return
    setDrawerOpen(false)
  }

  const handleSave = async () => {
    if (!form.slug.trim()) return notify.warning('请填写 slug')
    if (!form.name.trim()) return notify.warning('请填写名称')
    if (!form.identity_header.trim()) return notify.warning('请填写身份头')
    if (!form.topic_template.trim()) return notify.warning('请填写 topic 模板')
    if (!form.topic_template.includes('{identity}')) return notify.warning('topic 模板必须包含 {identity}')
    if (!form.event_name.trim()) return notify.warning('请填写 event 名')

    setSaving(true)
    try {
      if (editingId == null) {
        if (tenantId == null) {
          notify.warning('无法确定租户，无法创建')
          setSaving(false)
          return
        }
        const payload: CreateSsePublicEndpointInput = {
          tenant_id: tenantId,
          slug: form.slug.trim(),
          name: form.name.trim(),
          identity_header: form.identity_header.trim(),
          topic_template: form.topic_template.trim(),
          event_name: form.event_name.trim(),
        }
        await ssePublicEndpointAPI.create(payload)
        notify.success('对外端点已创建')
      } else {
        const payload: UpdateSsePublicEndpointInput = {
          name: form.name.trim(),
          identity_header: form.identity_header.trim(),
          topic_template: form.topic_template.trim(),
          event_name: form.event_name.trim(),
        }
        await ssePublicEndpointAPI.update(editingId, payload)
        notify.success('对外端点已更新')
      }
      setDrawerOpen(false)
      load()
    } catch (err) {
      notify.error(err as Error)
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = async (e: SsePublicEndpoint) => {
    try {
      await ssePublicEndpointAPI.update(e.id, { is_active: !e.is_active })
      notify.success(e.is_active ? '已停用' : '已启用')
      load()
    } catch (err) {
      notify.error(err as Error)
    }
  }

  const handleDelete = async (e: SsePublicEndpoint) => {
    if (!confirm(`确定删除对外端点 "${e.slug}"？`)) return
    try {
      await ssePublicEndpointAPI.delete(e.id)
      notify.success('已删除')
      load()
    } catch (err) {
      notify.error(err as Error)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-gray-600">
          对外订阅端点：业务前端用 <code className="font-mono text-xs">EventSource</code> 连{' '}
          <code className="font-mono text-xs">{origin || '<平台域名>'}/events/&#123;slug&#125;</code>
          ，身份头由网关注入；topic 必含 <code className="font-mono text-xs">{'{identity}'}</code> 保证只能订自己的。
        </p>
        <button onClick={openCreate} className="btn-primary whitespace-nowrap flex-shrink-0">
          <i className="fas fa-plus mr-2"></i>
          新建对外端点
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-12 text-center">
            <i className="fas fa-spinner fa-spin text-2xl text-gray-400"></i>
          </div>
        ) : visible.length === 0 ? (
          <div className="p-12 text-center text-gray-500">
            <i className="fas fa-rss text-4xl mb-4 text-gray-300"></i>
            <p className="mb-4">暂无对外端点</p>
            <button onClick={openCreate} className="btn-primary">
              <i className="fas fa-plus mr-2"></i>
              新建第一个端点
            </button>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {visible.map((e) => (
              <div
                key={e.id}
                className={`px-6 py-4 flex items-center justify-between hover:bg-gray-50 ${
                  !e.is_active ? 'opacity-60' : ''
                }`}
              >
                <div className="flex items-start space-x-4 min-w-0">
                  <div
                    className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
                      e.is_active ? 'bg-teal-100' : 'bg-gray-100'
                    }`}
                  >
                    <i className={`fas fa-rss ${e.is_active ? 'text-teal-600' : 'text-gray-400'}`}></i>
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium text-gray-900 truncate">{e.name}</p>
                      <span className="px-2 py-0.5 rounded text-xs font-mono bg-teal-50 text-teal-700">
                        /events/{e.slug}
                      </span>
                      <span className="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600 font-mono">
                        {e.identity_header}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 font-mono mt-1 truncate">
                      <i className="fas fa-arrow-right text-gray-300 mr-1"></i>
                      {e.topic_template}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">event: {e.event_name}</p>
                  </div>
                </div>
                <div className="flex items-center space-x-3 flex-shrink-0">
                  <span
                    className={`text-xs px-2 py-1 rounded-full ${
                      e.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                    }`}
                  >
                    {e.is_active ? '生效中' : '已停用'}
                  </span>
                  <button
                    onClick={() => handleToggle(e)}
                    className={`px-3 py-1 text-sm rounded-lg ${
                      e.is_active ? 'text-yellow-700 hover:bg-yellow-50' : 'text-green-700 hover:bg-green-50'
                    }`}
                  >
                    {e.is_active ? '停用' : '启用'}
                  </button>
                  <button
                    onClick={() => openEdit(e)}
                    className="px-3 py-1 text-sm text-blue-600 hover:bg-blue-50 rounded-lg"
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => handleDelete(e)}
                    className="px-3 py-1 text-sm text-red-600 hover:bg-red-50 rounded-lg"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Drawer
        isOpen={drawerOpen}
        onClose={closeDrawer}
        title={editingId == null ? '新建对外端点' : `编辑对外端点 #${editingId}`}
        size="lg"
        footer={
          <div className="flex gap-3">
            <button
              onClick={closeDrawer}
              disabled={saving}
              className="flex-1 h-11 px-5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              取消
            </button>
            <button onClick={handleSave} disabled={saving} className="flex-1 btn-primary disabled:opacity-50">
              {saving ? '保存中...' : editingId == null ? '创建' : '保存'}
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              slug（URL 路径）<span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.slug}
              onChange={(ev) => setForm({ ...form, slug: ev.target.value })}
              placeholder="growth-animation"
              className="w-full input-base font-mono text-sm"
              maxLength={64}
              disabled={editingId != null}
            />
            <p className="mt-1 text-xs text-gray-400 break-all">
              订阅地址：{origin || '<平台域名>'}/events/{form.slug || '<slug>'}（仅小写字母/数字/连字符）
              {editingId != null && '；slug 不可改'}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              名称 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(ev) => setForm({ ...form, name: ev.target.value })}
              placeholder="成长动画"
              className="w-full input-base"
              maxLength={100}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              身份头 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.identity_header}
              onChange={(ev) => setForm({ ...form, identity_header: ev.target.value })}
              placeholder="X-Way-UID"
              className="w-full input-base font-mono text-sm"
              maxLength={64}
            />
            <p className="mt-1 text-xs text-gray-400">网关注入的可信请求头，作为连接身份。</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              topic 模板 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.topic_template}
              onChange={(ev) => setForm({ ...form, topic_template: ev.target.value })}
              placeholder="way:{identity}:growth:{query.projectId}"
              className="w-full input-base font-mono text-xs"
            />
            <p className="mt-1 text-xs text-gray-400">
              必含 <code className="font-mono">{'{identity}'}</code>（且排在所有{' '}
              <code className="font-mono">{'{query.X}'}</code> 之前）；<code className="font-mono">{'{query.X}'}</code>{' '}
              取 URL 参数，缺省时退化为末尾通配 <code className="font-mono">*</code>。
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              SSE event 名 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.event_name}
              onChange={(ev) => setForm({ ...form, event_name: ev.target.value })}
              placeholder="growth_animation_available"
              className="w-full input-base"
              maxLength={100}
            />
          </div>
        </div>
      </Drawer>
    </div>
  )
}
