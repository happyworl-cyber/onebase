'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useParams } from 'next/navigation'
import {
  kafkaAPI,
  type CreateKafkaConnectionInput,
  type CreateKafkaTokenInput,
  type KafkaAccessToken,
  type KafkaConnection,
  type KafkaConsumerGroup,
  type KafkaSaslMechanism,
  type KafkaSecurityProtocol,
  type KafkaTokenOp,
  type UpdateKafkaConnectionInput,
} from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import { useNotification } from '@/hooks/useNotification'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'
import { closeOnBackdropPress } from '@/lib/utils'

const KAFKA_TOKEN_OPS: KafkaTokenOp[] = ['produce', 'list_topics', 'health']

const SECURITY_PROTOCOLS: KafkaSecurityProtocol[] = [
  'PLAINTEXT',
  'SASL_PLAINTEXT',
  'SASL_SSL',
  'SSL',
]
const SASL_MECHANISMS: KafkaSaslMechanism[] = ['PLAIN', 'SCRAM-SHA-256', 'SCRAM-SHA-512']

function usesSasl(protocol: KafkaSecurityProtocol) {
  return protocol.startsWith('SASL_')
}

function usesTls(protocol: KafkaSecurityProtocol) {
  return protocol === 'SSL' || protocol === 'SASL_SSL'
}

export default function KafkaConnectionsPage() {
  const t = useTranslations('wsKafkaConn')
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

  return <KafkaConnectionsManager tenantId={projectId} />
}

function KafkaConnectionsManager({ tenantId }: { tenantId: number }) {
  const t = useTranslations('wsKafkaConn')
  const tc = useTranslations('connCommon')
  const notify = useNotification()
  const [connections, setConnections] = useState<KafkaConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [activeId, setActiveId] = useState<number | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const loadConnections = useCallback(async () => {
    setLoading(true)
    try {
      const res = await kafkaAPI.listConnections(tenantId)
      const rows = res.data.filter((connection) => connection.tenant_id === tenantId)
      setConnections(rows)
      setActiveId((previous) => {
        if (previous !== null && rows.some((connection) => connection.id === previous)) {
          return previous
        }
        return rows[0]?.id ?? null
      })
    } catch {
      // 全局拦截器展示错误。
    } finally {
      setLoading(false)
    }
  }, [tenantId])

  useEffect(() => {
    loadConnections()
  }, [loadConnections])

  const activeConnection = useMemo(
    () => connections.find((connection) => connection.id === activeId) ?? null,
    [activeId, connections],
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">
            <i className="fas fa-stream mr-2 text-orange-600"></i>
            {t('title')}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {t('subtitle')}
          </p>
        </div>
        <button type="button" onClick={() => setShowCreate(true)} className="btn-primary">
          <i className="fas fa-plus mr-2"></i>{t('newConn')}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
        <div className="md:col-span-4 space-y-2">
          {loading ? (
            <div className="text-center py-8 text-gray-400">
              <i className="fas fa-spinner fa-spin"></i>
            </div>
          ) : connections.length === 0 ? (
            <div className="text-center py-12 bg-gray-50 border border-dashed border-gray-300 rounded">
              <i className="fas fa-stream text-3xl text-gray-300 mb-2"></i>
              <p className="text-sm text-gray-500">{t('empty')}</p>
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="mt-3 text-sm text-blue-600 hover:underline"
              >
                {t('createFirst')}
              </button>
            </div>
          ) : (
            connections.map((connection) => (
              <ConnectionListItem
                key={connection.id}
                connection={connection}
                active={connection.id === activeId}
                onClick={() => setActiveId(connection.id)}
              />
            ))
          )}
        </div>

        <div className="md:col-span-8">
          {activeConnection ? (
            <ConnectionDetail
              key={activeConnection.id}
              connection={activeConnection}
              onChanged={loadConnections}
            />
          ) : (
            <div className="bg-gray-50 border border-dashed border-gray-300 rounded p-12 text-center text-sm text-gray-400">
              {t('selectOrNew')}
            </div>
          )}
        </div>
      </div>

      {showCreate && (
        <CreateConnectionDialog
          tenantId={tenantId}
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false)
            setActiveId(id)
            loadConnections()
            notify.success(t('created'))
          }}
        />
      )}
    </div>
  )
}

function ConnectionListItem({
  connection,
  active,
  onClick,
}: {
  connection: KafkaConnection
  active: boolean
  onClick: () => void
}) {
  const tc = useTranslations('connCommon')
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left p-3 rounded border transition ${
        active ? 'bg-blue-50 border-blue-400' : 'bg-white border-gray-200 hover:bg-gray-50'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium text-sm truncate">{connection.connection_name}</div>
        {!connection.is_active && (
          <span className="shrink-0 text-xs bg-gray-200 text-gray-700 px-1.5 py-0.5 rounded">
            {tc('disabled')}
          </span>
        )}
      </div>
      <div className="text-xs text-gray-500 mt-1 truncate font-mono">{connection.brokers}</div>
      <div className="flex items-center text-xs text-gray-400 mt-1 gap-2">
        <span>{connection.security_protocol}</span>
        {connection.sasl_username && (
          <span className="truncate">
            <i className="fas fa-user mr-1"></i>
            {connection.sasl_username}
          </span>
        )}
      </div>
    </button>
  )
}

function ConnectionDetail({
  connection,
  onChanged,
}: {
  connection: KafkaConnection
  onChanged: () => void
}) {
  const t = useTranslations('wsKafkaConn')
  const tc = useTranslations('connCommon')
  const notify = useNotification()
  const [tab, setTab] = useState<'usage' | 'tokens' | 'topics' | 'groups' | 'settings'>('usage')

  const remove = async () => {
    if (
      !window.confirm(
        t('confirmDelete', { name: connection.connection_name }),
      )
    ) {
      return
    }
    try {
      await kafkaAPI.deleteConnection(connection.id)
      notify.success(t('deleted'))
      onChanged()
    } catch {
      // 全局拦截器展示错误。
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded shadow-sm">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="min-w-0">
          <div className="font-semibold">{connection.connection_name}</div>
          <div className="text-xs text-gray-500 font-mono mt-0.5 truncate">
            {connection.brokers} · {connection.security_protocol}
          </div>
        </div>
        <button
          type="button"
          onClick={remove}
          className="text-sm text-red-600 hover:text-red-700"
          title={t('deleteTitle')}
        >
          <i className="fas fa-trash"></i>
        </button>
      </div>

      <div className="border-b flex text-sm flex-wrap">
        {[
          { id: 'usage', label: t('tabUsage'), icon: 'fa-book' },
          { id: 'tokens', label: t('tabTokens'), icon: 'fa-key' },
          { id: 'topics', label: 'Topics', icon: 'fa-list' },
          { id: 'groups', label: t('tabGroups'), icon: 'fa-users' },
          { id: 'settings', label: t('tabSettings'), icon: 'fa-cog' },
        ].map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id as typeof tab)}
            className={`px-4 py-2 -mb-px border-b-2 ${
              tab === item.id
                ? 'border-blue-500 text-blue-600 font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <i className={`fas ${item.icon} mr-1.5`}></i>
            {item.label}
          </button>
        ))}
      </div>

      <div className="p-4">
        {tab === 'usage' && <UsageTab connection={connection} />}
        {tab === 'tokens' && <TokensTab connectionId={connection.id} />}
        {tab === 'topics' && <TopicsTab connection={connection} />}
        {tab === 'groups' && <ConsumerGroupsTab connection={connection} />}
        {tab === 'settings' && <SettingsTab connection={connection} onUpdated={onChanged} />}
      </div>
    </div>
  )
}

function UsageTab({ connection }: { connection: KafkaConnection }) {
  const t = useTranslations('wsKafkaConn')
  const tc = useTranslations('connCommon')
  const notify = useNotification()
  const { currentConnection, currentProject } = useAppStore()
  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'https://platform.example.com'
  const databaseSlug =
    currentConnection?.database_slug ||
    currentProject?.slug ||
    currentProject?.name ||
    null
  const base = databaseSlug
    ? `${origin}/api/v1/${encodeURIComponent(databaseSlug)}/kafka/${connection.id}`
    : `${origin}/api/kafka/${connection.id}`

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      notify.success(t('copied', { label }))
    } catch {
      notify.error(t('copyFail'))
    }
  }

  const produceCurl = `curl -X POST '${base}/produce' \\
  -H 'Authorization: ApiKey obes_kafka_<your_token>' \\
  -H 'Content-Type: application/json' \\
  -d '{"topic":"orders","key":"u1","value":{"id":1}}'`

  const topicsCurl = `curl '${base}/topics' \\
  -H 'Authorization: ApiKey obes_kafka_<your_token>'`

  const healthCurl = `curl '${base}/health' \\
  -H 'Authorization: ApiKey obes_kafka_<your_token>'`

  return (
    <div className="space-y-4 text-sm">
      <div className="bg-blue-50 border border-blue-200 text-blue-900 rounded p-3 space-y-1.5 text-xs">
        <div className="font-semibold">
          <i className="fas fa-lightbulb mr-1"></i>{t('restTitle')}
        </div>
        {!databaseSlug && (
          <p className="text-amber-800">
            {t('restLi1a')}<code className="bg-white px-1 rounded">/api/kafka/...</code>{t('restLi1b')}
          </p>
        )}
        <ul className="list-disc list-inside space-y-0.5">
          <li>
            {t('restLi2a')}<code className="bg-white px-1 rounded">obes_kafka_*</code>{t('restLi2b')}
          </li>
          <li>
            {t('restLi3a')}<code className="bg-white px-1 rounded">Authorization: ApiKey obes_kafka_...</code>{t('restLi3b')}
          </li>
          <li>{t('restLi4')}</li>
        </ul>
      </div>

      {[
        { title: 'Produce', curl: produceCurl },
        { title: 'List topics', curl: topicsCurl },
        { title: 'Health', curl: healthCurl },
      ].map((item) => (
        <div key={item.title} className="border rounded overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b">
            <span className="font-medium text-xs">{item.title}</span>
            <button
              type="button"
              className="text-xs text-blue-600 hover:underline"
              onClick={() => copy(item.curl, item.title)}
            >
              {t('copy')}
            </button>
          </div>
          <pre className="p-3 text-xs font-mono overflow-x-auto bg-gray-900 text-gray-100 leading-relaxed">
            {item.curl}
          </pre>
        </div>
      ))}
    </div>
  )
}

function TokensTab({ connectionId }: { connectionId: number }) {
  const tr = useTranslations('wsKafkaConn')
  const tc = useTranslations('connCommon')
  const notify = useNotification()
  const [tokens, setTokens] = useState<KafkaAccessToken[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [revealed, setRevealed] = useState<{ token: string; name: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await kafkaAPI.listTokens(connectionId)
      setTokens(res.data)
    } catch {
      /* interceptor */
    } finally {
      setLoading(false)
    }
  }, [connectionId])

  useEffect(() => {
    load()
  }, [load])

  const toggleActive = async (t: KafkaAccessToken) => {
    try {
      await kafkaAPI.updateToken(connectionId, t.id, { is_active: !t.is_active })
      notify.success(tr('tokenToggled', { state: t.is_active ? tr('tokenDisabled') : tr('tokenEnabled') }))
      load()
    } catch {
      /* noop */
    }
  }

  const remove = async (t: KafkaAccessToken) => {
    if (!window.confirm(tr('confirmDeleteToken', { name: t.name }))) return
    try {
      await kafkaAPI.deleteToken(connectionId, t.id)
      notify.success(tr('tokenDeleted'))
      load()
    } catch {
      /* noop */
    }
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="text-gray-600 text-xs">
          {tr('tokensDesc')}
        </div>
        <button type="button" onClick={() => setShowCreate(true)} className="btn-primary text-xs shrink-0">
          <i className="fas fa-plus mr-1"></i>{tr('newToken')}
        </button>
      </div>

      {loading ? (
        <div className="text-center py-6 text-gray-400">
          <i className="fas fa-spinner fa-spin"></i>
        </div>
      ) : tokens.length === 0 ? (
        <div className="text-center py-8 text-gray-400 border border-dashed border-gray-300 rounded">
          {tr('noToken')}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-gray-500 border-b">
              <tr>
                <th className="py-2 px-2">{tr('colName')}</th>
                <th className="py-2 px-2">{tr('colPrefix')}</th>
                <th className="py-2 px-2">ops</th>
                <th className="py-2 px-2">topics</th>
                <th className="py-2 px-2">{tr('colUse')}</th>
                <th className="py-2 px-2">{tr('colStatus')}</th>
                <th className="py-2 px-2 text-right">{tr('colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id} className="border-b last:border-b-0">
                  <td className="py-2 px-2 font-medium">
                    {t.name}
                    {t.description && (
                      <div className="text-gray-400 font-normal mt-0.5">{t.description}</div>
                    )}
                  </td>
                  <td className="py-2 px-2 font-mono text-gray-500">{t.token_prefix}…</td>
                  <td className="py-2 px-2 font-mono text-gray-700">{t.allowed_ops.join(' / ')}</td>
                  <td className="py-2 px-2 font-mono text-gray-700 max-w-[160px] truncate">
                    {t.topic_allowlist.join(', ')}
                  </td>
                  <td className="py-2 px-2 text-gray-500">
                    {t.use_count > 0 ? tr('useCount', { n: t.use_count }) : '—'}
                  </td>
                  <td className="py-2 px-2">
                    {t.is_active && !t.revoked_at ? (
                      <span className="bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded">active</span>
                    ) : (
                      <span className="bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">disabled</span>
                    )}
                  </td>
                  <td className="py-2 px-2 text-right space-x-2 whitespace-nowrap">
                    <button type="button" className="text-blue-600 hover:underline" onClick={() => toggleActive(t)}>
                      {t.is_active ? tr('disable') : tr('enable')}
                    </button>
                    <button type="button" className="text-red-600 hover:underline" onClick={() => remove(t)}>
                      {tr('delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateKafkaTokenModal
          connectionId={connectionId}
          onClose={() => setShowCreate(false)}
          onCreated={(token, name) => {
            setShowCreate(false)
            setRevealed({ token, name })
            load()
          }}
        />
      )}

      {revealed && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full p-5 space-y-3">
            <h3 className="font-semibold text-gray-900">{tr('tokenCreated', { name: revealed.name })}</h3>
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
              {tr('tokenRevealHint')}
            </p>
            <pre className="text-xs font-mono bg-gray-900 text-gray-100 p-3 rounded break-all whitespace-pre-wrap">
              {revealed.token}
            </pre>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn-default text-xs"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(revealed.token)
                    notify.success(tr('tokenCopied'))
                  } catch {
                    notify.error(tr('tokenCopyFail'))
                  }
                }}
              >
                {tr('tokenCopy')}
              </button>
              <button type="button" className="btn-primary text-xs" onClick={() => setRevealed(null)}>
                {tr('tokenSaved')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CreateKafkaTokenModal({
  connectionId,
  onClose,
  onCreated,
}: {
  connectionId: number
  onClose: () => void
  onCreated: (token: string, name: string) => void
}) {
  const t = useTranslations('wsKafkaConn')
  const tc = useTranslations('connCommon')
  const notify = useNotification()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [ops, setOps] = useState<KafkaTokenOp[]>([...KAFKA_TOKEN_OPS])
  const [topics, setTopics] = useState('*')
  const [saving, setSaving] = useState(false)

  const toggleOp = (op: KafkaTokenOp) => {
    setOps((prev) => (prev.includes(op) ? prev.filter((o) => o !== op) : [...prev, op]))
  }

  const submit = async () => {
    if (!name.trim()) {
      notify.error(t('fillName'))
      return
    }
    if (ops.length === 0) {
      notify.error(t('selectOp'))
      return
    }
    const topic_allowlist = topics
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (topic_allowlist.length === 0) {
      notify.error(t('topicAllowEmpty'))
      return
    }
    const payload: CreateKafkaTokenInput = {
      name: name.trim(),
      description: description.trim() || undefined,
      allowed_ops: ops,
      topic_allowlist,
    }
    setSaving(true)
    try {
      const res = await kafkaAPI.createToken(connectionId, payload)
      notify.success(t('tokenCreatedShort'))
      onCreated(res.data.token, res.data.record.name)
    } catch {
      /* interceptor */
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-5 space-y-3">
        <h3 className="font-semibold">{t('createTokenTitle')}</h3>
        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('tokenNameReq')}</label>
          <input
            className="w-full border rounded px-3 py-2 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('tokenNamePlaceholder')}
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('tokenDescLabel')}</label>
          <input
            className="w-full border rounded px-3 py-2 text-sm"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">allowed_ops</label>
          <div className="flex flex-wrap gap-3 text-xs">
            {KAFKA_TOKEN_OPS.map((op) => (
              <label key={op} className="inline-flex items-center gap-1.5">
                <input type="checkbox" checked={ops.includes(op)} onChange={() => toggleOp(op)} />
                <span className="font-mono">{op}</span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('topicAllowlist')}</label>
          <textarea
            className="w-full border rounded px-3 py-2 text-sm font-mono"
            rows={3}
            value={topics}
            onChange={(e) => setTopics(e.target.value)}
            placeholder="orders-*&#10;events"
          />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-default text-xs" onClick={onClose} disabled={saving}>
            {tc('cancel')}
          </button>
          <button type="button" className="btn-primary text-xs" onClick={submit} disabled={saving}>
            {saving ? t('creating') : t('create')}
          </button>
        </div>
      </div>
    </div>
  )
}

function TopicsTab({ connection }: { connection: KafkaConnection }) {
  const t = useTranslations('wsKafkaConn')
  const tc = useTranslations('connCommon')
  const notify = useNotification()
  const [topics, setTopics] = useState<string[]>([])
  const [brokerCount, setBrokerCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [form, setForm] = useState({
    name: '',
    num_partitions: 1,
    replication_factor: 1,
  })

  const loadTopics = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await kafkaAPI.listTopics(connection.id)
      setTopics(res.data.topics)
      setBrokerCount(res.data.broker_count)
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || t('getTopicsFailed'))
    } finally {
      setLoading(false)
    }
  }, [connection.id])

  useEffect(() => {
    if (connection.is_active) {
      loadTopics()
    }
  }, [connection.is_active, loadTopics])

  const submitCreate = async () => {
    const name = form.name.trim()
    if (!name) {
      setCreateError(t('fillTopicName'))
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      await kafkaAPI.createTopic(connection.id, {
        name,
        num_partitions: Number(form.num_partitions) || 1,
        replication_factor: Number(form.replication_factor) || 1,
      })
      notify.success(t('topicCreated', { name }))
      setForm({ name: '', num_partitions: 1, replication_factor: 1 })
      setShowCreate(false)
      await loadTopics()
    } catch (err: any) {
      setCreateError(err?.response?.data?.error || err?.message || t('createTopicFailed'))
    } finally {
      setCreating(false)
    }
  }

  if (!connection.is_active) {
    return (
      <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded p-3 text-sm">
        {t('disabledTopicWarn')}
      </div>
    )
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="text-gray-500">
          {brokerCount !== null && (
            <>
              <i className="fas fa-server mr-1"></i>
              {t('brokerTopicCount', { brokers: brokerCount, topics: topics.length })}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setShowCreate((v) => !v)
              setCreateError(null)
            }}
            className="btn-primary"
          >
            <i className="fas fa-plus mr-2"></i>
            {t('newTopic')}
          </button>
          <button type="button" onClick={loadTopics} disabled={loading} className="btn-default">
            <i className={`fas fa-sync-alt mr-2 ${loading ? 'fa-spin' : ''}`}></i>
            {t('refresh')}
          </button>
        </div>
      </div>

      {showCreate && (
        <div className="border border-gray-200 rounded p-3 space-y-3 bg-gray-50">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block sm:col-span-1">
              <span className="text-xs text-gray-500 mb-1 block">{t('topicNameReq')}</span>
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full px-3 py-2 border rounded font-mono text-sm"
                placeholder="planeos.ai-close-ticket"
                disabled={creating}
              />
            </label>
            <label className="block">
              <span className="text-xs text-gray-500 mb-1 block">{t('partitions')}</span>
              <input
                type="number"
                min={1}
                max={100}
                value={form.num_partitions}
                onChange={(e) =>
                  setForm((f) => ({ ...f, num_partitions: Number(e.target.value) || 1 }))
                }
                className="w-full px-3 py-2 border rounded text-sm"
                disabled={creating}
              />
            </label>
            <label className="block">
              <span className="text-xs text-gray-500 mb-1 block">{t('replicaFactor')}</span>
              <input
                type="number"
                min={1}
                max={10}
                value={form.replication_factor}
                onChange={(e) =>
                  setForm((f) => ({ ...f, replication_factor: Number(e.target.value) || 1 }))
                }
                className="w-full px-3 py-2 border rounded text-sm"
                disabled={creating}
              />
            </label>
          </div>
          {createError && (
            <div className="text-xs p-2 rounded border bg-red-50 border-red-200 text-red-900">
              {createError}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn-default text-xs"
              onClick={() => setShowCreate(false)}
              disabled={creating}
            >
              {tc('cancel')}
            </button>
            <button
              type="button"
              className="btn-primary text-xs"
              onClick={submitCreate}
              disabled={creating}
            >
              {creating ? t('creating') : t('create')}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="text-xs p-3 rounded border bg-red-50 border-red-200 text-red-900">
          <i className="fas fa-times-circle mr-1"></i>
          {error}
        </div>
      )}
      {loading && topics.length === 0 ? (
        <div className="text-center py-10 text-gray-400">
          <i className="fas fa-spinner fa-spin mr-2"></i>{t('readingMeta')}
        </div>
      ) : !error && topics.length === 0 ? (
        <div className="text-center py-10 text-gray-400">{t('noTopic')}</div>
      ) : (
        <div className="border border-gray-200 rounded divide-y max-h-96 overflow-y-auto">
          {topics.map((topic) => (
            <div key={topic} className="px-3 py-2 font-mono text-xs flex items-center">
              <i className="fas fa-stream text-orange-500 mr-2"></i>
              {topic}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ConsumerGroupsTab({ connection }: { connection: KafkaConnection }) {
  const t = useTranslations('wsKafkaConn')
  const tc = useTranslations('connCommon')
  const [groups, setGroups] = useState<KafkaConsumerGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  const loadGroups = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await kafkaAPI.listConsumerGroups(connection.id)
      setGroups(res.data.groups || [])
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || t('getGroupsFailed'))
    } finally {
      setLoading(false)
    }
  }, [connection.id])

  useEffect(() => {
    if (connection.is_active) {
      loadGroups()
    }
  }, [connection.is_active, loadGroups])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return groups
    return groups.filter((g) => g.name.toLowerCase().includes(q))
  }, [groups, filter])

  if (!connection.is_active) {
    return (
      <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded p-3 text-sm">
        {t('disabledGroupWarn')}
      </div>
    )
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-gray-500">
          {t('groupCount', { n: groups.length })}
          <span className="ml-2 text-xs text-gray-400">
            {t('groupHint')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('filterGroupPlaceholder')}
            className="px-3 py-1.5 border rounded text-xs font-mono min-w-[220px]"
          />
          <button type="button" onClick={loadGroups} disabled={loading} className="btn-default">
            <i className={`fas fa-sync-alt mr-2 ${loading ? 'fa-spin' : ''}`}></i>
            {t('refresh')}
          </button>
        </div>
      </div>

      {error && (
        <div className="text-xs p-3 rounded border bg-red-50 border-red-200 text-red-900">
          <i className="fas fa-times-circle mr-1"></i>
          {error}
        </div>
      )}

      {loading && groups.length === 0 ? (
        <div className="text-center py-10 text-gray-400">
          <i className="fas fa-spinner fa-spin mr-2"></i>{t('readingGroups')}
        </div>
      ) : !error && filtered.length === 0 ? (
        <div className="text-center py-10 text-gray-400">
          {groups.length === 0
            ? t('noGroupEmpty')
            : t('noGroupMatch')}
        </div>
      ) : (
        <div className="border border-gray-200 rounded divide-y max-h-[28rem] overflow-y-auto">
          {filtered.map((group) => {
            const open = expanded === group.name
            const noMembers = group.member_count === 0
            return (
              <div key={group.name} className="bg-white">
                <button
                  type="button"
                  className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-gray-50"
                  onClick={() => setExpanded(open ? null : group.name)}
                >
                  <i
                    className={`fas fa-chevron-${open ? 'down' : 'right'} text-gray-400 text-[10px] w-3`}
                  ></i>
                  <i className="fas fa-users text-blue-500"></i>
                  <span className="font-mono text-xs flex-1 truncate">{group.name}</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded ${
                      noMembers
                        ? 'bg-amber-50 text-amber-800 border border-amber-200'
                        : 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                    }`}
                  >
                    {group.state || 'unknown'} · {group.member_count} members
                  </span>
                </button>
                {open && (
                  <div className="px-8 pb-3 text-xs text-gray-600 space-y-1">
                    <div>
                      protocol: <span className="font-mono">{group.protocol || '-'}</span>
                      {' · '}
                      type: <span className="font-mono">{group.protocol_type || '-'}</span>
                    </div>
                    {noMembers ? (
                      <div className="text-amber-700">
                        {t('noOnlineMember')}
                      </div>
                    ) : (
                      <ul className="space-y-1 mt-1">
                        {group.members.map((m) => (
                          <li key={m.member_id} className="font-mono text-[11px] break-all">
                            {m.client_id} @ {m.client_host}
                            <span className="text-gray-400 ml-2">{m.member_id}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function SettingsTab({
  connection,
  onUpdated,
}: {
  connection: KafkaConnection
  onUpdated: () => void
}) {
  const t = useTranslations('wsKafkaConn')
  const tc = useTranslations('connCommon')
  const notify = useNotification()
  const [form, setForm] = useState({
    connection_name: connection.connection_name,
    brokers: connection.brokers,
    security_protocol: connection.security_protocol,
    sasl_mechanism: connection.sasl_mechanism ?? ('PLAIN' as KafkaSaslMechanism),
    sasl_username: connection.sasl_username ?? '',
    sasl_password: '',
    tls_insecure_skip_verify: connection.tls_insecure_skip_verify,
    connect_timeout_secs: connection.connect_timeout_secs,
    is_active: connection.is_active,
  })
  const [saving, setSaving] = useState(false)
  const [healthChecking, setHealthChecking] = useState(false)
  const [healthResult, setHealthResult] = useState<{
    ok: boolean
    broker_count?: number
    error?: string
  } | null>(null)

  const save = async () => {
    if (!form.connection_name.trim() || !form.brokers.trim()) {
      notify.error(t('nameBrokerEmpty'))
      return
    }
    setSaving(true)
    try {
      const sasl = usesSasl(form.security_protocol)
      const payload: UpdateKafkaConnectionInput = {
        connection_name: form.connection_name.trim(),
        brokers: form.brokers.trim(),
        security_protocol: form.security_protocol,
        sasl_mechanism: sasl ? form.sasl_mechanism : null,
        sasl_username: sasl ? form.sasl_username.trim() || null : null,
        tls_insecure_skip_verify: usesTls(form.security_protocol)
          ? form.tls_insecure_skip_verify
          : false,
        connect_timeout_secs: form.connect_timeout_secs,
        is_active: form.is_active,
      }
      if (form.sasl_password !== '') {
        payload.sasl_password = form.sasl_password
      }
      await kafkaAPI.updateConnection(connection.id, payload)
      setForm((current) => ({ ...current, sasl_password: '' }))
      notify.success(t('updated'))
      onUpdated()
    } catch {
      // 全局拦截器展示错误。
    } finally {
      setSaving(false)
    }
  }

  const probe = async () => {
    setHealthChecking(true)
    setHealthResult(null)
    try {
      const res = await kafkaAPI.healthCheck(connection.id)
      setHealthResult(res.data)
      if (res.data.ok) {
        notify.success(t('reachable'))
      } else {
        notify.warning(t('testFail'))
      }
    } catch (err: any) {
      setHealthResult({
        ok: false,
        error: err?.response?.data?.error || err?.message || t('testFail'),
      })
    } finally {
      setHealthChecking(false)
    }
  }

  return (
    <div className="space-y-3 text-sm">
      <ConnectionFields form={form} setForm={setForm} passwordHint={t('pwHintSettings')} />

      <div className="flex items-center space-x-2 pt-3 border-t">
        <button type="button" onClick={save} disabled={saving} className="btn-primary">
          <i className={`fas ${saving ? 'fa-spinner fa-spin' : 'fa-save'} mr-2`}></i>
          {saving ? tc('saving') : tc('save')}
        </button>
        <button
          type="button"
          onClick={probe}
          disabled={healthChecking}
          className="btn-default"
        >
          <i className={`fas ${healthChecking ? 'fa-spinner fa-spin' : 'fa-heartbeat'} mr-2`}></i>
          {healthChecking ? t('testing') : t('test')}
        </button>
      </div>

      {healthResult && (
        <div
          className={`text-xs p-3 rounded border ${
            healthResult.ok
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-red-50 border-red-200 text-red-900'
          }`}
        >
          <i
            className={`fas ${healthResult.ok ? 'fa-check-circle' : 'fa-times-circle'} mr-1`}
          ></i>
          {healthResult.ok
            ? t('healthOk', { n: healthResult.broker_count ?? 0 })
            : healthResult.error || t('testFail')}
        </div>
      )}
    </div>
  )
}

type ConnectionForm = {
  connection_name: string
  brokers: string
  security_protocol: KafkaSecurityProtocol
  sasl_mechanism: KafkaSaslMechanism
  sasl_username: string
  sasl_password: string
  tls_insecure_skip_verify: boolean
  connect_timeout_secs: number
  is_active: boolean
}

function ConnectionFields({
  form,
  setForm,
  passwordHint,
}: {
  form: ConnectionForm
  setForm: React.Dispatch<React.SetStateAction<ConnectionForm>>
  passwordHint: string
}) {
  const t = useTranslations('wsKafkaConn')
  const tc = useTranslations('connCommon')
  const sasl = usesSasl(form.security_protocol)
  const tls = usesTls(form.security_protocol)

  return (
    <>
      <FormRow label={t('connNameReq')} hint={t('connNameHint')}>
        <input
          value={form.connection_name}
          onChange={(event) => setForm({ ...form, connection_name: event.target.value })}
          className="input-base w-full"
          placeholder="prod-kafka"
        />
      </FormRow>
      <FormRow label={t('brokersReq')} hint={t('brokersHint')}>
        <input
          value={form.brokers}
          onChange={(event) => setForm({ ...form, brokers: event.target.value })}
          className="input-base w-full font-mono"
          placeholder="kafka-1:9092,kafka-2:9092"
        />
      </FormRow>
      <div className="grid grid-cols-2 gap-3">
        <FormRow label={t('securityProtocol')}>
          <select
            value={form.security_protocol}
            onChange={(event) =>
              setForm({
                ...form,
                security_protocol: event.target.value as KafkaSecurityProtocol,
              })
            }
            className="input-base w-full"
          >
            {SECURITY_PROTOCOLS.map((protocol) => (
              <option key={protocol}>{protocol}</option>
            ))}
          </select>
        </FormRow>
        <FormRow label={t('connTimeout')}>
          <input
            type="number"
            min={1}
            max={60}
            value={form.connect_timeout_secs}
            onChange={(event) =>
              setForm({
                ...form,
                connect_timeout_secs: parseInt(event.target.value, 10) || 5,
              })
            }
            className="input-base w-full"
          />
        </FormRow>
      </div>

      {sasl && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <FormRow label={t('saslMechanism')}>
              <select
                value={form.sasl_mechanism}
                onChange={(event) =>
                  setForm({
                    ...form,
                    sasl_mechanism: event.target.value as KafkaSaslMechanism,
                  })
                }
                className="input-base w-full"
              >
                {SASL_MECHANISMS.map((mechanism) => (
                  <option key={mechanism}>{mechanism}</option>
                ))}
              </select>
            </FormRow>
            <FormRow label={t('saslUser')}>
              <input
                value={form.sasl_username}
                onChange={(event) => setForm({ ...form, sasl_username: event.target.value })}
                className="input-base w-full font-mono"
              />
            </FormRow>
          </div>
          <FormRow label={t('saslPassword')} hint={passwordHint}>
            <input
              type="password"
              value={form.sasl_password}
              onChange={(event) => setForm({ ...form, sasl_password: event.target.value })}
              className="input-base w-full font-mono"
              autoComplete="new-password"
            />
          </FormRow>
        </>
      )}

      <div className="flex flex-wrap items-center gap-4">
        {tls && (
          <label className="flex items-center space-x-2">
            <input
              type="checkbox"
              checked={form.tls_insecure_skip_verify}
              onChange={(event) =>
                setForm({ ...form, tls_insecure_skip_verify: event.target.checked })
              }
            />
            <span>{t('skipTlsVerify')}</span>
          </label>
        )}
        <label className="flex items-center space-x-2">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(event) => setForm({ ...form, is_active: event.target.checked })}
          />
          <span>{t('connEnabled')}</span>
        </label>
      </div>
    </>
  )
}

function CreateConnectionDialog({
  tenantId,
  onClose,
  onCreated,
}: {
  tenantId: number
  onClose: () => void
  onCreated: (id: number) => void
}) {
  const t = useTranslations('wsKafkaConn')
  const tc = useTranslations('connCommon')
  const notify = useNotification()
  const [form, setForm] = useState<ConnectionForm>({
    connection_name: '',
    brokers: '',
    security_protocol: 'PLAINTEXT',
    sasl_mechanism: 'PLAIN',
    sasl_username: '',
    sasl_password: '',
    tls_insecure_skip_verify: false,
    connect_timeout_secs: 5,
    is_active: true,
  })
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!form.connection_name.trim()) {
      notify.error(t('fillName'))
      return
    }
    if (!form.brokers.trim()) {
      notify.error(t('fillBrokers'))
      return
    }
    const sasl = usesSasl(form.security_protocol)
    if (sasl && !form.sasl_username.trim()) {
      notify.error(t('saslNeedUser'))
      return
    }

    setSaving(true)
    try {
      const payload: CreateKafkaConnectionInput = {
        tenant_id: tenantId,
        connection_name: form.connection_name.trim(),
        brokers: form.brokers.trim(),
        security_protocol: form.security_protocol,
        sasl_mechanism: sasl ? form.sasl_mechanism : null,
        sasl_username: sasl ? form.sasl_username.trim() : null,
        sasl_password: sasl ? form.sasl_password || null : null,
        tls_insecure_skip_verify: usesTls(form.security_protocol)
          ? form.tls_insecure_skip_verify
          : false,
        connect_timeout_secs: form.connect_timeout_secs,
        is_active: form.is_active,
      }
      const res = await kafkaAPI.createConnection(payload)
      onCreated(res.data.id)
    } catch {
      // 全局拦截器展示错误。
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title={t('createTitle')} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <ConnectionFields form={form} setForm={setForm} passwordHint={t('pwHintCreate')} />
      </div>
      <div className="flex justify-end space-x-2 pt-4 border-t mt-4">
        <button type="button" onClick={onClose} className="btn-default">
          {tc('cancel')}
        </button>
        <button type="button" onClick={submit} disabled={saving} className="btn-primary">
          <i className={`fas ${saving ? 'fa-spinner fa-spin' : 'fa-plus'} mr-2`}></i>
          {saving ? t('creating') : t('create')}
        </button>
      </div>
    </Dialog>
  )
}

function FormRow({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      {children}
      {hint && <div className="text-xs text-gray-400 mt-1">{hint}</div>}
    </div>
  )
}

function Dialog({
  title,
  onClose,
  children,
}: {
  title: React.ReactNode
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onMouseDown={closeOnBackdropPress(onClose)}
    >
      <div
        className="bg-white rounded shadow-lg w-full max-w-xl max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="font-semibold">{title}</div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <i className="fas fa-times"></i>
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  )
}
