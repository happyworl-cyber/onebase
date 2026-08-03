'use client'

/**
 * `/workspace/[projectId]/automation/sse-routes` —— 项目级实时推送（SSE 转发）规则。
 *
 * 详细设计：docs/superpowers/specs/2026-06-01-sse-capability-design.md
 * 后端：src/sse_route_handlers.rs（`/api/admin/sse-routes`，租户 owner-admin / 超管）
 *
 * 与「集成 → Webhook」的对照：
 * - Webhook：数据变更 → HTTP 回调（一次性 push，对方需有 HTTP 端点）。
 * - 实时推送规则：数据变更 → 写进 SSE topic，客户端用 EventSource 订阅 /sse 长连接。
 *
 * 项目上下文：tenant_id / database_id 都从 currentConnection 推导，用户不手填底层 id。
 * 列表只展示当前租户的规则；新建默认 scope=本项目库，可切到"该租户全部库"。
 *
 * 鉴权：handler 内租户 owner-admin / 超管；前端门槛 `canManageEvents`（与会话规则一致）。
 */

import { useEffect, useMemo, useState } from 'react'
import {
  sseRouteAPI,
  tenantAPI,
  type SseRoute,
  type CreateSseRouteInput,
  type UpdateSseRouteInput,
} from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { useNotification } from '@/hooks/useNotification'
import Drawer from '@/components/Drawer'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'
import SseHelpPanel from '@/components/sse/SseHelpPanel'
import SseMonitorPanel from '@/components/sse/SseMonitorPanel'
import SseNotifyBridgePanel from '@/components/sse/SseNotifyBridgePanel'
import SsePublicEndpointPanel from '@/components/sse/SsePublicEndpointPanel'

// 来自 /api/tenants/my-connections 的一行连接信息（数据库下拉数据源，与定时任务一致）。
interface ConnRow {
  tenant_id: number
  tenant_name: string
  database_id: number
  connection_name: string
  db_host: string
  db_port: number
  db_name: string
  is_primary: boolean
}

interface FormState {
  name: string
  database_id: string // 下拉值：空字符串 = 该租户全部库；否则为 database_id
  event_pattern: string
  topic_template: string
  event_name: string
}

const EMPTY_FORM: FormState = {
  name: '',
  database_id: '',
  event_pattern: '*.*.*',
  topic_template: 'db:{database_id}:{schema}.{table}:{action}',
  event_name: '',
}

const PATTERN_PRESETS = [
  { label: '全部事件', value: '*.*.*' },
  { label: '所有 INSERT', value: '*.*.INSERT' },
  { label: '所有 UPDATE', value: '*.*.UPDATE' },
  { label: '所有 DELETE', value: '*.*.DELETE' },
]

function routeToForm(r: SseRoute): FormState {
  return {
    name: r.name,
    database_id: r.database_id == null ? '' : String(r.database_id),
    event_pattern: r.event_pattern,
    topic_template: r.topic_template,
    event_name: r.event_name ?? '',
  }
}

export default function SseRoutesPage() {
  // tenant_id / database_id 同 session-rules / api-keys 页：从 currentConnection 拿，
  // 不能误用 projectId（tenants.id ≠ tenant_databases.id）。
  const currentConnection = useAppStore((s) => s.currentConnection)
  const tenantId = currentConnection?.tenant_id ?? null
  const databaseId = currentConnection?.database_id ?? null
  const caps = useCurrentProjectCapabilities()
  const notify = useNotification()

  const [routes, setRoutes] = useState<SseRoute[]>([])
  const [loading, setLoading] = useState(true)
  const [connections, setConnections] = useState<ConnRow[]>([])

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [tab, setTab] = useState<'rules' | 'bridges' | 'endpoints' | 'monitor'>('rules')

  // 列表只展示当前租户的规则（后端可能返回超管可见的多租户全量）。
  const tenantRoutes = useMemo(
    () => (tenantId == null ? [] : routes.filter((r) => r.tenant_id === tenantId)),
    [routes, tenantId],
  )

  // 数据库下拉：当前租户下的库（按 database_id 去重），label 格式与定时任务一致。
  const databaseOptions = useMemo(() => {
    const seen = new Map<number, { id: number; label: string }>()
    for (const c of connections) {
      if (tenantId != null && c.tenant_id !== tenantId) continue
      if (seen.has(c.database_id)) continue
      seen.set(c.database_id, {
        id: c.database_id,
        label: `${c.connection_name || c.db_name} (${c.db_host}:${c.db_port}/${c.db_name})${
          c.is_primary ? ' · 主' : ''
        }`,
      })
    }
    return Array.from(seen.values())
  }, [connections, tenantId])

  const loadRoutes = async () => {
    if (tenantId == null) return
    try {
      setLoading(true)
      const res = await sseRouteAPI.list(tenantId)
      setRoutes(res.data.data ?? [])
    } catch (err) {
      notify.error(err as Error)
    } finally {
      setLoading(false)
    }
  }

  const loadConnections = async () => {
    try {
      // 项目上下文：只取本租户的连接，避免跨项目泄漏到数据库下拉。
      const res = await tenantAPI.getMyConnections(tenantId ?? undefined)
      setConnections(Array.isArray(res.data) ? res.data : [])
    } catch (err) {
      console.error('加载数据库连接失败:', err)
    }
  }

  useEffect(() => {
    if (tenantId != null) loadRoutes()
    loadConnections()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId])

  const openCreate = () => {
    setEditingId(null)
    // 默认锁定到本项目库（与原"仅本项目库"默认一致），用户可在下拉里改。
    setForm({ ...EMPTY_FORM, database_id: databaseId == null ? '' : String(databaseId) })
    setDrawerOpen(true)
  }

  const openEdit = (r: SseRoute) => {
    setEditingId(r.id)
    setForm(routeToForm(r))
    setDrawerOpen(true)
  }

  const closeDrawer = () => {
    if (saving) return
    setDrawerOpen(false)
  }

  const handleSave = async () => {
    if (tenantId == null || databaseId == null) return
    if (!form.name.trim()) {
      notify.warning('请填写规则名称')
      return
    }
    if (!form.topic_template.trim()) {
      notify.warning('请填写目标 topic 模板')
      return
    }
    if (!form.database_id.trim()) {
      notify.warning('请选择数据库')
      return
    }

    const database_id = parseInt(form.database_id.trim(), 10)
    const event_name = form.event_name.trim() || null

    setSaving(true)
    try {
      if (editingId == null) {
        const payload: CreateSseRouteInput = {
          tenant_id: tenantId,
          name: form.name.trim(),
          database_id,
          event_pattern: form.event_pattern.trim(),
          topic_template: form.topic_template.trim(),
          event_name,
        }
        await sseRouteAPI.create(payload)
        notify.success('推送规则已创建')
      } else {
        const payload: UpdateSseRouteInput = {
          name: form.name.trim(),
          database_id,
          event_pattern: form.event_pattern.trim(),
          topic_template: form.topic_template.trim(),
          event_name,
        }
        await sseRouteAPI.update(editingId, payload)
        notify.success('推送规则已更新')
      }
      setDrawerOpen(false)
      loadRoutes()
    } catch (err) {
      notify.error(err as Error)
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = async (r: SseRoute) => {
    try {
      await sseRouteAPI.update(r.id, { is_active: !r.is_active })
      notify.success(r.is_active ? '规则已停用' : '规则已启用')
      loadRoutes()
    } catch (err) {
      notify.error(err as Error)
    }
  }

  const handleDelete = async (r: SseRoute) => {
    if (!confirm(`确定删除推送规则 "${r.name}"？`)) return
    try {
      await sseRouteAPI.delete(r.id)
      notify.success('规则已删除')
      loadRoutes()
    } catch (err) {
      notify.error(err as Error)
    }
  }

  // ─── 守卫 ───
  if (!caps.canManageEvents) {
    return <ForbiddenPlaceholder reason="实时推送规则需要 admin+ 角色（owner / admin / 超管）" />
  }

  if (databaseId == null || tenantId == null) {
    return (
      <div className="p-8 text-center text-gray-500 space-y-3">
        <i className="fas fa-plug text-4xl text-gray-300"></i>
        <p>本项目尚未绑定主数据库连接，无法配置实时推送规则。</p>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold text-gray-900">实时推送规则</h1>
          <p className="text-sm text-gray-600 mt-1">
            数据变更命中条件时，自动通过 SSE 推送到指定 topic（客户端用{' '}
            <code className="font-mono text-xs">EventSource</code> 订阅{' '}
            <code className="font-mono text-xs">/sse</code>）
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {tab === 'rules' && (
            <>
              <button
                onClick={() => setShowHelp(!showHelp)}
                className="btn-default whitespace-nowrap"
              >
                <i className="fas fa-circle-question mr-2"></i>
                使用说明
              </button>
              <button onClick={openCreate} className="btn-primary whitespace-nowrap">
                <i className="fas fa-plus mr-2"></i>
                新建规则
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex gap-1 border-b border-gray-200">
        {[
          { id: 'rules' as const, label: '推送规则' },
          { id: 'bridges' as const, label: 'NOTIFY 监听桥' },
          { id: 'endpoints' as const, label: '对外端点' },
          { id: 'monitor' as const, label: '推送监控' },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === t.id
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'monitor' ? (
        <SseMonitorPanel />
      ) : tab === 'bridges' ? (
        <SseNotifyBridgePanel tenantId={tenantId} defaultDatabaseId={databaseId} />
      ) : tab === 'endpoints' ? (
        <SsePublicEndpointPanel tenantId={tenantId} />
      ) : (
        <>
          {showHelp && <SseHelpPanel />}

          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-12 text-center">
            <i className="fas fa-spinner fa-spin text-2xl text-gray-400"></i>
          </div>
        ) : tenantRoutes.length === 0 ? (
          <div className="p-12 text-center text-gray-500">
            <i className="fas fa-tower-broadcast text-4xl mb-4 text-gray-300"></i>
            <p className="mb-4">本项目暂无推送规则</p>
            <button onClick={openCreate} className="btn-primary">
              <i className="fas fa-plus mr-2"></i>
              新建第一条规则
            </button>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {tenantRoutes.map((r) => (
              <div
                key={r.id}
                className={`px-6 py-4 flex items-center justify-between hover:bg-gray-50 ${
                  !r.is_active ? 'opacity-60' : ''
                }`}
              >
                <div className="flex items-start space-x-4 min-w-0">
                  <div
                    className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
                      r.is_active ? 'bg-blue-100' : 'bg-gray-100'
                    }`}
                  >
                    <i
                      className={`fas fa-tower-broadcast ${
                        r.is_active ? 'text-blue-600' : 'text-gray-400'
                      }`}
                    ></i>
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium text-gray-900 truncate">{r.name}</p>
                      <span className="px-2 py-0.5 rounded text-xs font-mono bg-purple-100 text-purple-700">
                        {r.event_pattern}
                      </span>
                      <span className="px-2 py-0.5 rounded text-xs bg-blue-50 text-blue-700">
                        {r.database_id == null ? '该租户全部库' : `本项目库 #${r.database_id}`}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 font-mono mt-1 truncate">
                      <i className="fas fa-arrow-right text-gray-300 mr-1"></i>
                      {r.topic_template}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      event: {r.event_name || '(动作名 INSERT/UPDATE/DELETE)'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center space-x-3 flex-shrink-0">
                  <span
                    className={`text-xs px-2 py-1 rounded-full ${
                      r.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                    }`}
                  >
                    {r.is_active ? '生效中' : '已停用'}
                  </span>
                  <button
                    onClick={() => handleToggle(r)}
                    className={`px-3 py-1 text-sm rounded-lg ${
                      r.is_active
                        ? 'text-yellow-700 hover:bg-yellow-50'
                        : 'text-green-700 hover:bg-green-50'
                    }`}
                  >
                    {r.is_active ? '停用' : '启用'}
                  </button>
                  <button
                    onClick={() => openEdit(r)}
                    className="px-3 py-1 text-sm text-blue-600 hover:bg-blue-50 rounded-lg"
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => handleDelete(r)}
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
        </>
      )}

      <Drawer
        isOpen={drawerOpen}
        onClose={closeDrawer}
        title={editingId == null ? '新建推送规则' : `编辑推送规则 #${editingId}`}
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
            <button
              onClick={handleSave}
              disabled={saving || !form.name.trim()}
              className="flex-1 btn-primary disabled:opacity-50"
            >
              {saving ? '保存中...' : editingId == null ? '创建' : '保存'}
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              规则名称 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="例：订单变更实时推送"
              className="w-full input-base"
              maxLength={100}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              数据库 <span className="text-red-500">*</span>
            </label>
            <select
              value={form.database_id}
              onChange={(e) => setForm({ ...form, database_id: e.target.value })}
              className="w-full input-base"
              required
            >
              <option value="">— 选择数据库 —</option>
              {databaseOptions.map((d) => (
                <option key={d.id} value={String(d.id)}>
                  {d.label}
                </option>
              ))}
            </select>
            {databaseOptions.length === 0 && (
              <p className="mt-1 text-xs text-gray-500">本项目下暂无可用数据库</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              事件模式{' '}
              <span className="text-gray-400 text-xs">
                （格式：schema.table.action，支持 * 通配）
              </span>
            </label>
            <input
              type="text"
              value={form.event_pattern}
              onChange={(e) => setForm({ ...form, event_pattern: e.target.value })}
              className="w-full input-base font-mono text-sm"
            />
            <div className="flex flex-wrap gap-1 mt-2">
              {PATTERN_PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setForm({ ...form, event_pattern: p.value })}
                  className="px-2 py-1 text-xs rounded bg-gray-100 hover:bg-gray-200 text-gray-600"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              目标 topic 模板 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.topic_template}
              onChange={(e) => setForm({ ...form, topic_template: e.target.value })}
              className="w-full input-base font-mono text-xs"
            />
            <p className="text-xs text-gray-400 mt-1">
              占位符：{'{database_id}'} {'{schema}'} {'{table}'} {'{action}'}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              SSE event 名{' '}
              <span className="text-gray-400 text-xs">
                （留空 = 用动作名 INSERT/UPDATE/DELETE）
              </span>
            </label>
            <input
              type="text"
              value={form.event_name}
              onChange={(e) => setForm({ ...form, event_name: e.target.value })}
              placeholder="如 order_created"
              className="w-full input-base"
            />
          </div>
        </div>
      </Drawer>
    </div>
  )
}
