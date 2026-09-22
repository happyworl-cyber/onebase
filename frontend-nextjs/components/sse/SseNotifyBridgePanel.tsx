'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  sseNotifyBridgeAPI,
  tenantAPI,
  type SseNotifyBridge,
  type CreateSseNotifyBridgeInput,
  type UpdateSseNotifyBridgeInput,
} from '@/lib/api'
import { useNotification } from '@/hooks/useNotification'
import Drawer from '@/components/Drawer'

/**
 * PG NOTIFY → SSE 监听桥的管理面板（CRUD）。
 *
 * 监听桥按 `database_id` 持一条 `LISTEN`，收到业务库的 `NOTIFY` 后用 topic 模板
 * （占位符取 payload 字段）算出 SSE topic 推送。后端管理任务每 10s 重读配置，增删改自动生效。
 *
 * - `tenantId` 传入时：列表只展示该租户的桥（项目工作区用）。
 * - `defaultDatabaseId` 传入时：新建时预选该库。
 */
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
  database_id: string
  channel: string
  topic_template: string
  event_name: string
}

const EMPTY_FORM: FormState = {
  database_id: '',
  channel: '',
  topic_template: '',
  event_name: '',
}

function bridgeToForm(b: SseNotifyBridge): FormState {
  return {
    database_id: String(b.database_id),
    channel: b.channel,
    topic_template: b.topic_template,
    event_name: b.event_name,
  }
}

interface Props {
  tenantId?: number | null
  defaultDatabaseId?: number | null
}

export default function SseNotifyBridgePanel({ tenantId, defaultDatabaseId }: Props) {
  const notify = useNotification()
  const t = useTranslations('sseNotifyBridge')

  const [bridges, setBridges] = useState<SseNotifyBridge[]>([])
  const [connections, setConnections] = useState<ConnRow[]>([])
  const [loading, setLoading] = useState(true)

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  // 对外订阅地址与其他模块（如 ES 代理）一致：用当前访问平台的统一域名 origin 拼。
  // useEffect 赋值避免 SSR 注水不一致；服务端渲染时先留空。
  const [origin, setOrigin] = useState('')
  useEffect(() => {
    setOrigin(window.location.origin)
  }, [])

  // 列表：tenantId 给定时只看该租户（项目内）。
  const visibleBridges = useMemo(
    () => (tenantId == null ? bridges : bridges.filter((b) => b.tenant_id === tenantId)),
    [bridges, tenantId],
  )

  // 数据库下拉：tenantId 给定时只列该租户的库（按 database_id 去重）。
  const databaseOptions = useMemo(() => {
    const seen = new Map<number, { id: number; label: string }>()
    for (const c of connections) {
      if (tenantId != null && c.tenant_id !== tenantId) continue
      if (seen.has(c.database_id)) continue
      seen.set(c.database_id, {
        id: c.database_id,
        label: `${c.connection_name || c.db_name} (${c.db_host}:${c.db_port}/${c.db_name})${
          c.is_primary ? t('primarySuffix') : ''
        }`,
      })
    }
    return Array.from(seen.values())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections, tenantId, t])

  const dbLabel = (id: number) =>
    databaseOptions.find((d) => d.id === id)?.label ?? t('dbFallbackLabel', { id })

  const load = async () => {
    try {
      setLoading(true)
      // tenantId 给定时，让后端按租户鉴权 + 过滤（权威）；visibleBridges 仅作前端兜底。
      const res = await sseNotifyBridgeAPI.list(tenantId ?? undefined)
      setBridges(res.data.data ?? [])
    } catch (err) {
      notify.error(err as Error)
    } finally {
      setLoading(false)
    }
  }

  const loadConnections = async () => {
    try {
      const res = await tenantAPI.getMyConnections(tenantId ?? undefined)
      setConnections(Array.isArray(res.data) ? res.data : [])
    } catch (err) {
      console.error('加载数据库连接失败:', err)
    }
  }

  useEffect(() => {
    load()
    loadConnections()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId])

  const openCreate = () => {
    setEditingId(null)
    setForm({
      ...EMPTY_FORM,
      database_id: defaultDatabaseId == null ? '' : String(defaultDatabaseId),
    })
    setDrawerOpen(true)
  }

  const openEdit = (b: SseNotifyBridge) => {
    setEditingId(b.id)
    setForm(bridgeToForm(b))
    setDrawerOpen(true)
  }

  const closeDrawer = () => {
    if (saving) return
    setDrawerOpen(false)
  }

  const handleSave = async () => {
    if (!form.database_id.trim()) {
      notify.warning(t('selectDb'))
      return
    }
    if (!form.channel.trim()) {
      notify.warning(t('fillChannel'))
      return
    }
    if (!form.topic_template.trim()) {
      notify.warning(t('fillTopicTemplate'))
      return
    }
    if (!form.event_name.trim()) {
      notify.warning(t('fillEventName'))
      return
    }

    setSaving(true)
    try {
      if (editingId == null) {
        const payload: CreateSseNotifyBridgeInput = {
          database_id: parseInt(form.database_id.trim(), 10),
          channel: form.channel.trim(),
          topic_template: form.topic_template.trim(),
          event_name: form.event_name.trim(),
        }
        await sseNotifyBridgeAPI.create(payload)
        notify.success(t('createSuccess'))
      } else {
        // database_id 不可改（改库等于换 listener）；只更新模板/channel/event/启停。
        const payload: UpdateSseNotifyBridgeInput = {
          channel: form.channel.trim(),
          topic_template: form.topic_template.trim(),
          event_name: form.event_name.trim(),
        }
        await sseNotifyBridgeAPI.update(editingId, payload)
        notify.success(t('updateSuccess'))
      }
      setDrawerOpen(false)
      load()
    } catch (err) {
      notify.error(err as Error)
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = async (b: SseNotifyBridge) => {
    try {
      await sseNotifyBridgeAPI.update(b.id, { is_active: !b.is_active })
      notify.success(b.is_active ? t('deactivateSuccess') : t('activateSuccess'))
      load()
    } catch (err) {
      notify.error(err as Error)
    }
  }

  const handleDelete = async (b: SseNotifyBridge) => {
    if (!confirm(t('deleteConfirm', { channel: b.channel }))) return
    try {
      await sseNotifyBridgeAPI.delete(b.id)
      notify.success(t('deleteSuccess'))
      load()
    } catch (err) {
      notify.error(err as Error)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-gray-600">
          {t.rich('description', {
            code: (chunks) => <code className="font-mono text-xs">{chunks}</code>,
          })}
        </p>
        <button onClick={openCreate} className="btn-primary whitespace-nowrap flex-shrink-0">
          <i className="fas fa-plus mr-2"></i>
          {t('createButton')}
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-12 text-center">
            <i className="fas fa-spinner fa-spin text-2xl text-gray-400"></i>
          </div>
        ) : visibleBridges.length === 0 ? (
          <div className="p-12 text-center text-gray-500">
            <i className="fas fa-satellite-dish text-4xl mb-4 text-gray-300"></i>
            <p className="mb-4">{t('emptyState')}</p>
            <button onClick={openCreate} className="btn-primary">
              <i className="fas fa-plus mr-2"></i>
              {t('createFirstButton')}
            </button>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {visibleBridges.map((b) => (
              <div
                key={b.id}
                className={`px-6 py-4 flex items-center justify-between hover:bg-gray-50 ${
                  !b.is_active ? 'opacity-60' : ''
                }`}
              >
                <div className="flex items-start space-x-4 min-w-0">
                  <div
                    className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
                      b.is_active ? 'bg-indigo-100' : 'bg-gray-100'
                    }`}
                  >
                    <i
                      className={`fas fa-satellite-dish ${
                        b.is_active ? 'text-indigo-600' : 'text-gray-400'
                      }`}
                    ></i>
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium text-gray-900 truncate font-mono">{b.channel}</p>
                      <span className="px-2 py-0.5 rounded text-xs bg-blue-50 text-blue-700">
                        {dbLabel(b.database_id)}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 font-mono mt-1 truncate">
                      <i className="fas fa-arrow-right text-gray-300 mr-1"></i>
                      {b.topic_template}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">event: {b.event_name}</p>
                  </div>
                </div>
                <div className="flex items-center space-x-3 flex-shrink-0">
                  <span
                    className={`text-xs px-2 py-1 rounded-full ${
                      b.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                    }`}
                  >
                    {b.is_active ? t('statusActive') : t('statusInactive')}
                  </span>
                  <button
                    onClick={() => handleToggle(b)}
                    className={`px-3 py-1 text-sm rounded-lg ${
                      b.is_active
                        ? 'text-yellow-700 hover:bg-yellow-50'
                        : 'text-green-700 hover:bg-green-50'
                    }`}
                  >
                    {b.is_active ? t('deactivateAction') : t('activateAction')}
                  </button>
                  <button
                    onClick={() => openEdit(b)}
                    className="px-3 py-1 text-sm text-blue-600 hover:bg-blue-50 rounded-lg"
                  >
                    {t('editAction')}
                  </button>
                  <button
                    onClick={() => handleDelete(b)}
                    className="px-3 py-1 text-sm text-red-600 hover:bg-red-50 rounded-lg"
                  >
                    {t('deleteAction')}
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
        title={editingId == null ? t('createButton') : t('editTitle', { id: editingId })}
        size="lg"
        footer={
          <div className="flex gap-3">
            <button
              onClick={closeDrawer}
              disabled={saving}
              className="flex-1 h-11 px-5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              {t('cancelAction')}
            </button>
            <button onClick={handleSave} disabled={saving} className="flex-1 btn-primary disabled:opacity-50">
              {saving ? t('savingLabel') : editingId == null ? t('createSubmit') : t('saveSubmit')}
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {t('fieldDatabase')} <span className="text-red-500">*</span>
            </label>
            <select
              value={form.database_id}
              onChange={(e) => setForm({ ...form, database_id: e.target.value })}
              className="w-full input-base"
              disabled={editingId != null}
            >
              <option value="">{t('selectDbOption')}</option>
              {databaseOptions.map((d) => (
                <option key={d.id} value={String(d.id)}>
                  {d.label}
                </option>
              ))}
            </select>
            {editingId != null && (
              <p className="mt-1 text-xs text-gray-400">{t('dbImmutableHint')}</p>
            )}
            {editingId == null && databaseOptions.length === 0 && (
              <p className="mt-1 text-xs text-gray-500">{t('noDbAvailable')}</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              NOTIFY channel <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.channel}
              onChange={(e) => setForm({ ...form, channel: e.target.value })}
              placeholder={t('phGrowthAnimationExample')}
              className="w-full input-base font-mono text-sm"
              maxLength={63}
            />
            <p className="mt-1 text-xs text-gray-400">
              {t.rich('channelHint', {
                code: (chunks) => <code className="font-mono">{chunks}</code>,
              })}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {t('fieldTopicTemplate')} <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.topic_template}
              onChange={(e) => setForm({ ...form, topic_template: e.target.value })}
              placeholder={t('phTopicTemplateExample')}
              className="w-full input-base font-mono text-xs"
            />
            <p className="mt-1 text-xs text-gray-400">
              {t.rich('topicKeyHint', {
                code: (chunks) => <code className="font-mono">{chunks}</code>,
              })}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {t('fieldEventName')} <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.event_name}
              onChange={(e) => setForm({ ...form, event_name: e.target.value })}
              placeholder={t('phGrowthAnimationExample')}
              className="w-full input-base"
              maxLength={100}
            />
          </div>

          <div className="rounded-lg bg-indigo-50 border border-indigo-100 p-3 text-xs text-indigo-700 space-y-1">
            <p className="font-medium">{t('exampleTitle')}</p>
            <p>
              {t('exampleChannelPrefix')}
              <code className="font-mono">growth_animation_available</code>
            </p>
            <p>
              {t('exampleTopicPrefix')}
              <code className="font-mono">way:{'{wayUid}'}:growth:{'{projectId}'}</code>
            </p>
            <p>
              {t('exampleEventPrefix')}
              <code className="font-mono">growth_animation_available</code>
            </p>
            <p className="pt-1">
              {t('exampleSubscribeIntro')}
            </p>
            <code className="block font-mono bg-white/70 border border-indigo-100 rounded px-2 py-1 break-all">
              GET {origin || t('platformDomainPlaceholder')}/events/growth-animation?projectId={t('communityIdPlaceholder')}
            </code>
            <p className="text-indigo-500">
              {t.rich('authHeaderHint', {
                code: (chunks) => <code className="font-mono">{chunks}</code>,
              })}
            </p>
          </div>
        </div>
      </Drawer>
    </div>
  )
}
