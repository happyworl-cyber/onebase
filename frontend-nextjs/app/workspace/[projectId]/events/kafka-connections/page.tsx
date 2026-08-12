'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
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
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const caps = useCurrentProjectCapabilities()

  if (!caps.canManageEvents) {
    return (
      <ForbiddenPlaceholder reason="Kafka 数据源管理需要 admin+ 角色（owner / admin / 超管）" />
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

  return <KafkaConnectionsManager tenantId={projectId} />
}

function KafkaConnectionsManager({ tenantId }: { tenantId: number }) {
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
            Kafka 数据源
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            管理项目共享的 Kafka 集群连接；签发访问令牌供外部 REST 调用，并供工作流 Kafka 节点复用。
          </p>
        </div>
        <button type="button" onClick={() => setShowCreate(true)} className="btn-primary">
          <i className="fas fa-plus mr-2"></i>新建连接
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
              <p className="text-sm text-gray-500">还没有 Kafka 连接</p>
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="mt-3 text-sm text-blue-600 hover:underline"
              >
                立即创建第一个
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
              请从左侧选择一个连接，或新建一个
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
            notify.success('Kafka 连接已创建')
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
            已停用
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
  const notify = useNotification()
  const [tab, setTab] = useState<'usage' | 'tokens' | 'topics' | 'groups' | 'settings'>('usage')

  const remove = async () => {
    if (
      !window.confirm(
        `确认删除连接「${connection.connection_name}」？引用它的工作流节点会立即失败。`,
      )
    ) {
      return
    }
    try {
      await kafkaAPI.deleteConnection(connection.id)
      notify.success('连接已删除')
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
          title="删除连接"
        >
          <i className="fas fa-trash"></i>
        </button>
      </div>

      <div className="border-b flex text-sm flex-wrap">
        {[
          { id: 'usage', label: '接入指南', icon: 'fa-book' },
          { id: 'tokens', label: '访问令牌', icon: 'fa-key' },
          { id: 'topics', label: 'Topics', icon: 'fa-list' },
          { id: 'groups', label: '消费组', icon: 'fa-users' },
          { id: 'settings', label: '连接设置', icon: 'fa-cog' },
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
      notify.success(`已复制：${label}`)
    } catch {
      notify.error('复制失败，请手动选择文本')
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
          <i className="fas fa-lightbulb mr-1"></i>对外 REST（对齐 ES）
        </div>
        {!databaseSlug && (
          <p className="text-amber-800">
            当前项目尚未绑定主数据库连接，示例暂用 <code className="bg-white px-1 rounded">/api/kafka/...</code>
            ；绑定后将自动带上项目 slug。
          </p>
        )}
        <ul className="list-disc list-inside space-y-0.5">
          <li>
            先在「访问令牌」Tab 创建 <code className="bg-white px-1 rounded">obes_kafka_*</code>
            ，明文仅创建时显示一次。
          </li>
          <li>
            请求头：<code className="bg-white px-1 rounded">Authorization: ApiKey obes_kafka_...</code>
            （也支持 Bearer / X-Kafka-Token）。
          </li>
          <li>令牌可限制 allowed_ops 与 topic_allowlist；无需平台登录即可调用。</li>
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
              复制
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
      notify.success(t.is_active ? 'token 已停用' : 'token 已启用')
      load()
    } catch {
      /* noop */
    }
  }

  const remove = async (t: KafkaAccessToken) => {
    if (!window.confirm(`确认删除 token「${t.name}」？使用中的请求将立即 401。`)) return
    try {
      await kafkaAPI.deleteToken(connectionId, t.id)
      notify.success('token 已删除')
      load()
    } catch {
      /* noop */
    }
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="text-gray-600 text-xs">
          每个 token 独立配置 ops / topic 白名单；明文仅在创建时一次性显示。
        </div>
        <button type="button" onClick={() => setShowCreate(true)} className="btn-primary text-xs shrink-0">
          <i className="fas fa-plus mr-1"></i>新建 token
        </button>
      </div>

      {loading ? (
        <div className="text-center py-6 text-gray-400">
          <i className="fas fa-spinner fa-spin"></i>
        </div>
      ) : tokens.length === 0 ? (
        <div className="text-center py-8 text-gray-400 border border-dashed border-gray-300 rounded">
          还没有 token
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-gray-500 border-b">
              <tr>
                <th className="py-2 px-2">名称</th>
                <th className="py-2 px-2">前缀</th>
                <th className="py-2 px-2">ops</th>
                <th className="py-2 px-2">topics</th>
                <th className="py-2 px-2">使用</th>
                <th className="py-2 px-2">状态</th>
                <th className="py-2 px-2 text-right">操作</th>
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
                    {t.use_count > 0 ? `${t.use_count} 次` : '—'}
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
                      {t.is_active ? '停用' : '启用'}
                    </button>
                    <button type="button" className="text-red-600 hover:underline" onClick={() => remove(t)}>
                      删除
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
            <h3 className="font-semibold text-gray-900">Token 已创建：{revealed.name}</h3>
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
              明文仅显示一次，请立即复制保存。关闭后无法再查看。
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
                    notify.success('已复制 token')
                  } catch {
                    notify.error('复制失败')
                  }
                }}
              >
                复制
              </button>
              <button type="button" className="btn-primary text-xs" onClick={() => setRevealed(null)}>
                我已保存
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
      notify.error('请填写名称')
      return
    }
    if (ops.length === 0) {
      notify.error('至少选择一个 op')
      return
    }
    const topic_allowlist = topics
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (topic_allowlist.length === 0) {
      notify.error('topic 白名单不能为空')
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
      notify.success('token 已创建')
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
        <h3 className="font-semibold">新建 Kafka 访问令牌</h3>
        <div>
          <label className="block text-xs text-gray-500 mb-1">名称 *</label>
          <input
            className="w-full border rounded px-3 py-2 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="订单服务 produce"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">说明</label>
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
          <label className="block text-xs text-gray-500 mb-1">topic_allowlist（逗号或换行，* 表示不限）</label>
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
            取消
          </button>
          <button type="button" className="btn-primary text-xs" onClick={submit} disabled={saving}>
            {saving ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}

function TopicsTab({ connection }: { connection: KafkaConnection }) {
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
      setError(err?.response?.data?.error || err?.message || '获取 topics 失败')
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
      setCreateError('请填写 topic 名称')
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
      notify.success(`已创建 topic：${name}`)
      setForm({ name: '', num_partitions: 1, replication_factor: 1 })
      setShowCreate(false)
      await loadTopics()
    } catch (err: any) {
      setCreateError(err?.response?.data?.error || err?.message || '创建 topic 失败')
    } finally {
      setCreating(false)
    }
  }

  if (!connection.is_active) {
    return (
      <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded p-3 text-sm">
        连接已停用，启用后才能读取 topic。
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
              {brokerCount} 个 broker · {topics.length} 个 topic
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
            新建 Topic
          </button>
          <button type="button" onClick={loadTopics} disabled={loading} className="btn-default">
            <i className={`fas fa-sync-alt mr-2 ${loading ? 'fa-spin' : ''}`}></i>
            刷新
          </button>
        </div>
      </div>

      {showCreate && (
        <div className="border border-gray-200 rounded p-3 space-y-3 bg-gray-50">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block sm:col-span-1">
              <span className="text-xs text-gray-500 mb-1 block">名称 *</span>
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full px-3 py-2 border rounded font-mono text-sm"
                placeholder="onebase.ai-close-ticket"
                disabled={creating}
              />
            </label>
            <label className="block">
              <span className="text-xs text-gray-500 mb-1 block">分区数</span>
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
              <span className="text-xs text-gray-500 mb-1 block">副本因子</span>
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
              取消
            </button>
            <button
              type="button"
              className="btn-primary text-xs"
              onClick={submitCreate}
              disabled={creating}
            >
              {creating ? '创建中…' : '创建'}
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
          <i className="fas fa-spinner fa-spin mr-2"></i>正在读取 metadata…
        </div>
      ) : !error && topics.length === 0 ? (
        <div className="text-center py-10 text-gray-400">集群未返回 topic</div>
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
      setError(err?.response?.data?.error || err?.message || '获取消费组失败')
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
        连接已停用，启用后才能读取消费组。
      </div>
    )
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-gray-500">
          {groups.length} 个消费组
          <span className="ml-2 text-xs text-gray-400">
            （仅成员与状态，不含 lag；用于确认工作流 consumer 是否已挂载）
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="筛选 group id，如 onebase-ai-close"
            className="px-3 py-1.5 border rounded text-xs font-mono min-w-[220px]"
          />
          <button type="button" onClick={loadGroups} disabled={loading} className="btn-default">
            <i className={`fas fa-sync-alt mr-2 ${loading ? 'fa-spin' : ''}`}></i>
            刷新
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
          <i className="fas fa-spinner fa-spin mr-2"></i>正在读取消费组…
        </div>
      ) : !error && filtered.length === 0 ? (
        <div className="text-center py-10 text-gray-400">
          {groups.length === 0
            ? '集群未返回消费组（工作流 Kafka consumer 未挂载时这里通常为空或没有对应 group）'
            : '无匹配的消费组'}
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
                        无在线成员：OneBase 工作流 consumer 可能未启动，或 group id 与配置不一致。
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
      notify.error('连接名称和 brokers 不能为空')
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
      notify.success('连接已更新')
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
        notify.success('Kafka 可达')
      } else {
        notify.warning('探活失败')
      }
    } catch (err: any) {
      setHealthResult({
        ok: false,
        error: err?.response?.data?.error || err?.message || '探活失败',
      })
    } finally {
      setHealthChecking(false)
    }
  }

  return (
    <div className="space-y-3 text-sm">
      <ConnectionFields form={form} setForm={setForm} passwordHint="留空 = 保留原密码" />

      <div className="flex items-center space-x-2 pt-3 border-t">
        <button type="button" onClick={save} disabled={saving} className="btn-primary">
          <i className={`fas ${saving ? 'fa-spinner fa-spin' : 'fa-save'} mr-2`}></i>
          {saving ? '保存中…' : '保存'}
        </button>
        <button
          type="button"
          onClick={probe}
          disabled={healthChecking}
          className="btn-default"
        >
          <i className={`fas ${healthChecking ? 'fa-spinner fa-spin' : 'fa-heartbeat'} mr-2`}></i>
          {healthChecking ? '探活中…' : '测试连接'}
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
            ? `连接正常（${healthResult.broker_count ?? 0} 个 broker）`
            : healthResult.error || '探活失败'}
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
  const sasl = usesSasl(form.security_protocol)
  const tls = usesTls(form.security_protocol)

  return (
    <>
      <FormRow label="连接名称 *" hint="同项目内不可重名">
        <input
          value={form.connection_name}
          onChange={(event) => setForm({ ...form, connection_name: event.target.value })}
          className="input-base w-full"
          placeholder="prod-kafka"
        />
      </FormRow>
      <FormRow label="Brokers *" hint="多个地址用逗号分隔">
        <input
          value={form.brokers}
          onChange={(event) => setForm({ ...form, brokers: event.target.value })}
          className="input-base w-full font-mono"
          placeholder="kafka-1:9092,kafka-2:9092"
        />
      </FormRow>
      <div className="grid grid-cols-2 gap-3">
        <FormRow label="安全协议">
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
        <FormRow label="连接超时（秒）">
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
            <FormRow label="SASL 机制">
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
            <FormRow label="SASL 用户名 *">
              <input
                value={form.sasl_username}
                onChange={(event) => setForm({ ...form, sasl_username: event.target.value })}
                className="input-base w-full font-mono"
              />
            </FormRow>
          </div>
          <FormRow label="SASL 密码" hint={passwordHint}>
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
            <span>跳过 TLS 证书校验（不安全）</span>
          </label>
        )}
        <label className="flex items-center space-x-2">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(event) => setForm({ ...form, is_active: event.target.checked })}
          />
          <span>连接启用中</span>
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
      notify.error('请填写连接名称')
      return
    }
    if (!form.brokers.trim()) {
      notify.error('请填写 brokers')
      return
    }
    const sasl = usesSasl(form.security_protocol)
    if (sasl && !form.sasl_username.trim()) {
      notify.error('SASL 协议需要用户名')
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
    <Dialog title="新建 Kafka 连接" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <ConnectionFields form={form} setForm={setForm} passwordHint="明文仅在提交时传输" />
      </div>
      <div className="flex justify-end space-x-2 pt-4 border-t mt-4">
        <button type="button" onClick={onClose} className="btn-default">
          取消
        </button>
        <button type="button" onClick={submit} disabled={saving} className="btn-primary">
          <i className={`fas ${saving ? 'fa-spinner fa-spin' : 'fa-plus'} mr-2`}></i>
          {saving ? '创建中…' : '创建'}
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
      onClick={onClose}
    >
      <div
        className="bg-white rounded shadow-lg w-full max-w-xl max-h-[90vh] overflow-y-auto"
        onClick={(event) => event.stopPropagation()}
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
