'use client'

/**
 * `/workspace/[projectId]/events/redis-connections` — 项目维度的 Redis 数据源管理。
 *
 * 视图分两层：
 *   1. **连接列表**（左）：当前项目登记的所有 Redis 实例
 *   2. **连接详情**（右）：数据控制台（精选命令读写）+ 连接设置 + 接入指南
 *
 * 安全要点：
 *   - 密码明文**仅在创建/更新表单提交瞬间**经过前端；后端 AES-GCM 加密入库，
 *     `password_enc` 永不回传（`#[serde(skip_serializing)]`）。
 *   - 数据控制台写操作需 owner/admin/member，读放行任意成员（viewer 只读）。
 *
 * tenantId 来自 URL 的 projectId（projectId === tenant.id）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import {
  redisAPI,
  REDIS_OPS,
  type RedisConnection,
  type RedisOp,
  type CreateRedisConnectionInput,
  type UpdateRedisConnectionInput,
} from '@/lib/api'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import { useNotification } from '@/hooks/useNotification'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'

export default function RedisConnectionsPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const caps = useCurrentProjectCapabilities()

  if (!caps.canManageEvents) {
    return (
      <ForbiddenPlaceholder reason="Redis 数据源管理需要 admin+ 角色（owner / admin / 超管）" />
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

  return <RedisConnectionsManager tenantId={projectId} />
}

// ── 内部组件 ──────────────────────────────────────────────────────────

function RedisConnectionsManager({ tenantId }: { tenantId: number }) {
  const notify = useNotification()
  const [connections, setConnections] = useState<RedisConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [activeId, setActiveId] = useState<number | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const loadConnections = useCallback(async () => {
    setLoading(true)
    try {
      const res = await redisAPI.listConnections(tenantId)
      const rows = res.data.filter((c) => c.tenant_id === tenantId)
      setConnections(rows)
      if (rows.length > 0) {
        setActiveId((prev) =>
          prev !== null && rows.some((c) => c.id === prev) ? prev : rows[0].id,
        )
      } else {
        setActiveId(null)
      }
    } catch {
      /* 全局拦截器已弹错误 */
    } finally {
      setLoading(false)
    }
  }, [tenantId])

  useEffect(() => {
    loadConnections()
  }, [loadConnections])

  const activeConnection = useMemo(
    () => connections.find((c) => c.id === activeId) ?? null,
    [connections, activeId],
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">
            <i className="fas fa-database mr-2 text-red-600"></i>
            Redis 数据源
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            登记租户已有的 Redis 实例；平台保管地址 / 密码，业务经数据 API 与工作流
            redis 节点统一读写，无需散落连接串。
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
              <i className="fas fa-database text-3xl text-gray-300 mb-2"></i>
              <p className="text-sm text-gray-500">还没有 Redis 连接</p>
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="mt-3 text-sm text-blue-600 hover:underline"
              >
                立即创建第一个
              </button>
            </div>
          ) : (
            connections.map((c) => (
              <ConnectionListItem
                key={c.id}
                connection={c}
                active={c.id === activeId}
                onClick={() => setActiveId(c.id)}
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
              onDeleted={loadConnections}
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
            notify.success('Redis 连接已创建')
          }}
        />
      )}
    </div>
  )
}

// ── 连接列表项 ────────────────────────────────────────────────────────

function ConnectionListItem({
  connection,
  active,
  onClick,
}: {
  connection: RedisConnection
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
      <div className="flex items-center justify-between">
        <div className="font-medium text-sm truncate">{connection.connection_name}</div>
        {!connection.is_active && (
          <span className="text-xs bg-gray-200 text-gray-700 px-1.5 py-0.5 rounded">已停用</span>
        )}
      </div>
      <div className="text-xs text-gray-500 mt-1 truncate font-mono">
        {connection.host}:{connection.port} · db{connection.db_index}
      </div>
      <div className="flex items-center text-xs text-gray-400 mt-1 space-x-2">
        {connection.use_tls && (
          <span className="text-emerald-600" title="TLS 连接">
            <i className="fas fa-lock"></i> TLS
          </span>
        )}
        {connection.username && (
          <span title="ACL 用户">
            <i className="fas fa-user mr-1"></i>
            {connection.username}
          </span>
        )}
      </div>
    </button>
  )
}

// ── 连接详情 ──────────────────────────────────────────────────────────

function ConnectionDetail({
  connection,
  onChanged,
  onDeleted,
}: {
  connection: RedisConnection
  onChanged: () => void
  onDeleted: () => void
}) {
  const notify = useNotification()
  const [tab, setTab] = useState<'console' | 'usage' | 'settings'>('console')

  const handleDelete = async () => {
    if (
      !window.confirm(
        `确认删除连接「${connection.connection_name}」？删除后引用它的数据 API / 工作流节点会立即失败。`,
      )
    )
      return
    try {
      await redisAPI.deleteConnection(connection.id)
      notify.success('连接已删除')
      onDeleted()
    } catch {
      /* noop */
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded shadow-sm">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div>
          <div className="font-semibold">{connection.connection_name}</div>
          <div className="text-xs text-gray-500 font-mono mt-0.5">
            {connection.host}:{connection.port} · db{connection.db_index}
            {connection.use_tls ? ' · TLS' : ''}
          </div>
        </div>
        <button
          type="button"
          onClick={handleDelete}
          className="text-sm text-red-600 hover:text-red-700"
          title="删除连接"
        >
          <i className="fas fa-trash"></i>
        </button>
      </div>

      <div className="border-b flex text-sm">
        {[
          { id: 'console', label: '数据控制台', icon: 'fa-terminal' },
          { id: 'usage', label: '接入指南', icon: 'fa-book' },
          { id: 'settings', label: '连接设置', icon: 'fa-cog' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id as typeof tab)}
            className={`px-4 py-2 -mb-px border-b-2 ${
              tab === t.id
                ? 'border-blue-500 text-blue-600 font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <i className={`fas ${t.icon} mr-1.5`}></i>
            {t.label}
          </button>
        ))}
      </div>

      <div className="p-4">
        {tab === 'console' && <ConsoleTab connection={connection} />}
        {tab === 'usage' && <UsageTab connection={connection} />}
        {tab === 'settings' && <SettingsTab connection={connection} onUpdated={onChanged} />}
      </div>
    </div>
  )
}

// ── 数据控制台：精选命令读写 ──────────────────────────────────────────

/** 每个 op 需要哪些输入字段。 */
const OP_FIELDS: Record<RedisOp, ReadonlyArray<'key' | 'value' | 'field' | 'ttl' | 'nx' | 'pattern' | 'count' | 'start' | 'stop' | 'members' | 'values'>> = {
  get: ['key'],
  set: ['key', 'value', 'ttl', 'nx'],
  del: ['key'],
  exists: ['key'],
  expire: ['key', 'ttl'],
  ttl: ['key'],
  incr: ['key'],
  decr: ['key'],
  keys: ['pattern', 'count'],
  hget: ['key', 'field'],
  hset: ['key', 'field', 'value'],
  hgetall: ['key'],
  lpush: ['key', 'values'],
  rpush: ['key', 'values'],
  lrange: ['key', 'start', 'stop'],
  sadd: ['key', 'members'],
  smembers: ['key'],
}

function splitList(s: string): string[] {
  return s
    .split(/[\n,，]+/)
    .map((x) => x.trim())
    .filter(Boolean)
}

function ConsoleTab({ connection }: { connection: RedisConnection }) {
  const notify = useNotification()
  const [op, setOp] = useState<RedisOp>('get')
  const [f, setF] = useState({
    key: '',
    value: '',
    field: '',
    ttl: '',
    nx: false,
    pattern: '*',
    count: '1000',
    start: '0',
    stop: '-1',
    members: '',
    values: '',
  })
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)

  const fields = OP_FIELDS[op]

  const run = async () => {
    if (fields.includes('key') && !f.key.trim()) {
      notify.error('请填写 key')
      return
    }
    const args: Record<string, unknown> = {}
    if (fields.includes('key')) args.key = f.key
    if (fields.includes('value')) args.value = f.value
    if (fields.includes('field')) args.field = f.field
    if (fields.includes('ttl') && f.ttl.trim() !== '') args.ttl = parseInt(f.ttl, 10)
    if (fields.includes('nx') && f.nx) args.nx = true
    if (fields.includes('pattern')) args.pattern = f.pattern || '*'
    if (fields.includes('count') && f.count.trim() !== '') args.count = parseInt(f.count, 10)
    if (fields.includes('start')) args.start = parseInt(f.start || '0', 10)
    if (fields.includes('stop')) args.stop = parseInt(f.stop || '-1', 10)
    if (fields.includes('members')) args.members = splitList(f.members)
    if (fields.includes('values')) args.values = splitList(f.values)

    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const res = await redisAPI.exec(connection.id, { op, args })
      setResult(res.data.result)
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || '执行失败')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-3 text-sm">
      {!connection.is_active && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded p-2 text-xs">
          <i className="fas fa-exclamation-triangle mr-1"></i>连接已停用，执行会失败。
        </div>
      )}

      <div className="flex items-end gap-2">
        <div className="w-40">
          <label className="block text-xs font-medium text-gray-700 mb-1">操作</label>
          <select
            value={op}
            onChange={(e) => {
              setOp(e.target.value as RedisOp)
              setResult(null)
              setError(null)
            }}
            className="input-base w-full font-mono"
          >
            {REDIS_OPS.map((o) => (
              <option key={o} value={o}>
                {o.toUpperCase()}
              </option>
            ))}
          </select>
        </div>
        <button type="button" onClick={run} disabled={running} className="btn-primary">
          {running ? (
            <>
              <i className="fas fa-spinner fa-spin mr-2"></i>执行中…
            </>
          ) : (
            <>
              <i className="fas fa-play mr-2"></i>执行
            </>
          )}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {fields.includes('key') && (
          <FormRow label="key">
            <input value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} className="input-base w-full font-mono" />
          </FormRow>
        )}
        {fields.includes('field') && (
          <FormRow label="field">
            <input value={f.field} onChange={(e) => setF({ ...f, field: e.target.value })} className="input-base w-full font-mono" />
          </FormRow>
        )}
        {fields.includes('value') && (
          <FormRow label="value" hint="按字符串存储">
            <input value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} className="input-base w-full font-mono" />
          </FormRow>
        )}
        {fields.includes('ttl') && (
          <FormRow label="TTL（秒）" hint={op === 'set' ? '留空 = 不过期' : undefined}>
            <input type="number" value={f.ttl} onChange={(e) => setF({ ...f, ttl: e.target.value })} className="input-base w-full" />
          </FormRow>
        )}
        {fields.includes('pattern') && (
          <FormRow label="pattern" hint="SCAN MATCH，如 user:*">
            <input value={f.pattern} onChange={(e) => setF({ ...f, pattern: e.target.value })} className="input-base w-full font-mono" />
          </FormRow>
        )}
        {fields.includes('count') && (
          <FormRow label="上限" hint="最多返回条数（≤10000）">
            <input type="number" value={f.count} onChange={(e) => setF({ ...f, count: e.target.value })} className="input-base w-full" />
          </FormRow>
        )}
        {fields.includes('start') && (
          <FormRow label="start">
            <input type="number" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} className="input-base w-full" />
          </FormRow>
        )}
        {fields.includes('stop') && (
          <FormRow label="stop" hint="-1 = 末尾">
            <input type="number" value={f.stop} onChange={(e) => setF({ ...f, stop: e.target.value })} className="input-base w-full" />
          </FormRow>
        )}
        {fields.includes('members') && (
          <FormRow label="members" hint="逗号或换行分隔">
            <textarea value={f.members} onChange={(e) => setF({ ...f, members: e.target.value })} className="input-base w-full font-mono" rows={2} />
          </FormRow>
        )}
        {fields.includes('values') && (
          <FormRow label="values" hint="逗号或换行分隔，可多个">
            <textarea value={f.values} onChange={(e) => setF({ ...f, values: e.target.value })} className="input-base w-full font-mono" rows={2} />
          </FormRow>
        )}
      </div>

      {fields.includes('nx') && (
        <label className="flex items-center space-x-2 text-sm">
          <input type="checkbox" checked={f.nx} onChange={(e) => setF({ ...f, nx: e.target.checked })} />
          <span>NX（仅当 key 不存在时写入）</span>
        </label>
      )}

      {error && (
        <div className="text-xs p-3 rounded border bg-red-50 border-red-200 text-red-900">
          <i className="fas fa-times-circle mr-1"></i>
          {error}
        </div>
      )}
      {result !== null && (
        <div>
          <div className="text-xs font-medium text-gray-700 mb-1">结果</div>
          <pre className="bg-gray-900 text-emerald-300 text-xs p-3 rounded overflow-x-auto whitespace-pre-wrap break-all">
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

// ── 接入指南 ──────────────────────────────────────────────────────────

function UsageTab({ connection }: { connection: RedisConnection }) {
  const notify = useNotification()
  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'https://platform.example.com'
  const execUrl = `${origin}/api/redis-connections/${connection.id}/exec`

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      notify.success(`已复制：${label}`)
    } catch {
      notify.error('复制失败，请手动选择文本')
    }
  }

  const curlSet = `# 写入（需 owner/admin/member；带上登录后的 JWT）
curl -X POST "${execUrl}" \\
  -H "Authorization: Bearer <your_jwt>" \\
  -H "Content-Type: application/json" \\
  -d '{"op":"set","args":{"key":"greeting","value":"hello","ttl":60}}'`

  const curlGet = `# 读取（任意租户成员）
curl -X POST "${execUrl}" \\
  -H "Authorization: Bearer <your_jwt>" \\
  -H "Content-Type: application/json" \\
  -d '{"op":"get","args":{"key":"greeting"}}'
# → {"op":"get","result":{"value":"hello"}}`

  const workflowNote = `工作流里新增 redis 节点即可读写本连接：
  · 连接：选择「${connection.connection_name}」
  · 操作：get / set / del / incr / hget / ...
  · 参数：key / value / ttl 等，支持 {{nodeId.field}} 模板占位符
写操作在 dry_run / 生产只读调试下返回 mock，不落库。`

  return (
    <div className="space-y-3 text-sm">
      <div className="bg-blue-50 border border-blue-200 text-blue-900 rounded p-3 text-xs space-y-1">
        <div className="font-semibold">
          <i className="fas fa-lightbulb mr-1"></i>三种用法
        </div>
        <ul className="list-disc list-inside space-y-0.5">
          <li>本页「数据控制台」：直接点选命令读写，快速验证。</li>
          <li>数据 API：<code className="bg-white px-1 rounded">POST /api/redis-connections/{connection.id}/exec</code>，JWT 鉴权。</li>
          <li>工作流 <code className="bg-white px-1 rounded">redis</code> 节点：在自动化里编排读写。</li>
        </ul>
      </div>
      <CodeBlock label="exec 地址" code={execUrl} onCopy={() => copy(execUrl, 'exec 地址')} />
      <CodeBlock label="写入（SET）" code={curlSet} onCopy={() => copy(curlSet, '写入示例')} />
      <CodeBlock label="读取（GET）" code={curlGet} onCopy={() => copy(curlGet, '读取示例')} />
      <div className="bg-gray-50 border border-gray-200 text-gray-700 rounded p-3 text-xs whitespace-pre-wrap">
        <div className="font-semibold mb-1">
          <i className="fas fa-diagram-project mr-1"></i>工作流中使用
        </div>
        {workflowNote}
      </div>
      <div className="text-xs text-gray-500 pt-2 border-t">
        支持的命令：<span className="font-mono">{REDIS_OPS.join(' / ')}</span>。危险 / 阻塞命令
        （FLUSHALL / CONFIG / KEYS *）不在集合内。
      </div>
    </div>
  )
}

function CodeBlock({ label, code, onCopy }: { label: string; code: string; onCopy: () => void }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-gray-700">{label}</span>
        <button type="button" onClick={onCopy} className="text-xs text-blue-600 hover:underline">
          <i className="fas fa-copy mr-1"></i>复制
        </button>
      </div>
      <pre className="bg-gray-900 text-gray-100 text-xs p-3 rounded overflow-x-auto whitespace-pre-wrap break-all">
        {code}
      </pre>
    </div>
  )
}

// ── 设置（编辑连接） ──────────────────────────────────────────────────

function SettingsTab({
  connection,
  onUpdated,
}: {
  connection: RedisConnection
  onUpdated: () => void
}) {
  const notify = useNotification()
  const [form, setForm] = useState({
    connection_name: connection.connection_name,
    host: connection.host,
    port: connection.port,
    db_index: connection.db_index,
    username: connection.username ?? '',
    password: '', // 留空 = 保留原密码
    use_tls: connection.use_tls,
    connect_timeout_secs: connection.connect_timeout_secs,
    is_active: connection.is_active,
  })
  const [saving, setSaving] = useState(false)
  const [healthChecking, setHealthChecking] = useState(false)
  const [healthResult, setHealthResult] = useState<{
    ok: boolean
    redis_version?: string | null
    error?: string
  } | null>(null)

  const save = async () => {
    setSaving(true)
    try {
      const payload: UpdateRedisConnectionInput = {
        connection_name: form.connection_name.trim(),
        host: form.host.trim(),
        port: form.port,
        db_index: form.db_index,
        username: form.username.trim() || null,
        use_tls: form.use_tls,
        connect_timeout_secs: form.connect_timeout_secs,
        is_active: form.is_active,
      }
      // password 语义：留空 = 不动；非空 = 替换。清空密码请显式输入一个空格再删——
      // 这里简单处理：非空才提交（清空场景少见，可在需要时扩展）。
      if (form.password.trim() !== '') {
        payload.password = form.password
      }
      await redisAPI.updateConnection(connection.id, payload)
      notify.success('连接已更新')
      setForm({ ...form, password: '' })
      onUpdated()
    } catch {
      /* noop */
    } finally {
      setSaving(false)
    }
  }

  const probe = async () => {
    setHealthChecking(true)
    setHealthResult(null)
    try {
      const res = await redisAPI.healthCheck(connection.id)
      setHealthResult(res.data)
      if (res.data.ok) {
        notify.success('Redis 可达')
      } else {
        notify.warning('探活失败')
      }
    } catch (err: any) {
      setHealthResult({ ok: false, error: err?.response?.data?.error || err?.message || '探活失败' })
    } finally {
      setHealthChecking(false)
    }
  }

  return (
    <div className="space-y-3 text-sm">
      <FormRow label="连接名称">
        <input
          value={form.connection_name}
          onChange={(e) => setForm({ ...form, connection_name: e.target.value })}
          className="input-base w-full"
        />
      </FormRow>
      <div className="grid grid-cols-3 gap-3">
        <FormRow label="host">
          <input
            value={form.host}
            onChange={(e) => setForm({ ...form, host: e.target.value })}
            className="input-base w-full font-mono"
          />
        </FormRow>
        <FormRow label="port">
          <input
            type="number"
            value={form.port}
            onChange={(e) => setForm({ ...form, port: parseInt(e.target.value, 10) || 6379 })}
            className="input-base w-full"
          />
        </FormRow>
        <FormRow label="db 编号">
          <input
            type="number"
            min={0}
            max={255}
            value={form.db_index}
            onChange={(e) => setForm({ ...form, db_index: parseInt(e.target.value, 10) || 0 })}
            className="input-base w-full"
          />
        </FormRow>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FormRow label="用户名（ACL）" hint="留空 = 传统 AUTH 密码模式">
          <input
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            className="input-base w-full font-mono"
          />
        </FormRow>
        <FormRow label="超时（秒）">
          <input
            type="number"
            min={1}
            max={60}
            value={form.connect_timeout_secs}
            onChange={(e) =>
              setForm({ ...form, connect_timeout_secs: parseInt(e.target.value, 10) || 5 })
            }
            className="input-base w-full"
          />
        </FormRow>
      </div>
      <FormRow label="密码" hint="留空 = 保留原密码。新输入会替换并加密入库。">
        <input
          type="password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          placeholder="••••••••（输入新值以替换）"
          className="input-base w-full font-mono"
        />
      </FormRow>
      <div className="flex items-center space-x-4 text-sm">
        <label className="flex items-center space-x-2">
          <input
            type="checkbox"
            checked={form.use_tls}
            onChange={(e) => setForm({ ...form, use_tls: e.target.checked })}
          />
          <span>TLS（rediss://）</span>
        </label>
        <label className="flex items-center space-x-2">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
          />
          <span>连接启用中</span>
        </label>
      </div>

      <div className="flex items-center space-x-2 pt-3 border-t">
        <button type="button" onClick={save} disabled={saving} className="btn-primary">
          {saving ? (
            <>
              <i className="fas fa-spinner fa-spin mr-2"></i>保存中…
            </>
          ) : (
            <>
              <i className="fas fa-save mr-2"></i>保存
            </>
          )}
        </button>
        <button
          type="button"
          onClick={probe}
          disabled={healthChecking}
          className="btn-default"
          title="PING + INFO 探活"
        >
          {healthChecking ? (
            <>
              <i className="fas fa-spinner fa-spin mr-2"></i>探活中…
            </>
          ) : (
            <>
              <i className="fas fa-heartbeat mr-2"></i>测试连接
            </>
          )}
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
          {healthResult.ok ? (
            <div>
              <i className="fas fa-check-circle mr-1"></i>PING OK
              {healthResult.redis_version && (
                <span className="ml-2">
                  redis <span className="font-mono">{healthResult.redis_version}</span>
                </span>
              )}
            </div>
          ) : (
            <div>
              <i className="fas fa-times-circle mr-1"></i>
              {healthResult.error || '探活失败'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── 创建连接弹窗 ──────────────────────────────────────────────────────

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
  const [form, setForm] = useState({
    connection_name: '',
    host: '',
    port: 6379,
    db_index: 0,
    username: '',
    password: '',
    use_tls: false,
    connect_timeout_secs: 5,
  })
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!form.connection_name.trim()) {
      notify.error('请填写连接名称')
      return
    }
    if (!form.host.trim()) {
      notify.error('请填写 host')
      return
    }
    setSaving(true)
    try {
      const payload: CreateRedisConnectionInput = {
        tenant_id: tenantId,
        connection_name: form.connection_name.trim(),
        host: form.host.trim(),
        port: form.port,
        db_index: form.db_index,
        username: form.username.trim() || null,
        password: form.password || null,
        use_tls: form.use_tls,
        connect_timeout_secs: form.connect_timeout_secs,
      }
      const res = await redisAPI.createConnection(payload)
      onCreated(res.data.id)
    } catch {
      /* noop */
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title="新建 Redis 连接" onClose={onClose} widthClass="max-w-lg">
      <div className="space-y-3 text-sm">
        <FormRow label="连接名称 *" hint="同租户内不可重名">
          <input
            autoFocus
            value={form.connection_name}
            onChange={(e) => setForm({ ...form, connection_name: e.target.value })}
            className="input-base w-full"
            placeholder="prod-redis / cache / …"
          />
        </FormRow>
        <div className="grid grid-cols-3 gap-3">
          <FormRow label="host *">
            <input
              value={form.host}
              onChange={(e) => setForm({ ...form, host: e.target.value })}
              className="input-base w-full font-mono"
              placeholder="redis.internal"
            />
          </FormRow>
          <FormRow label="port">
            <input
              type="number"
              value={form.port}
              onChange={(e) => setForm({ ...form, port: parseInt(e.target.value, 10) || 6379 })}
              className="input-base w-full"
            />
          </FormRow>
          <FormRow label="db 编号">
            <input
              type="number"
              min={0}
              max={255}
              value={form.db_index}
              onChange={(e) => setForm({ ...form, db_index: parseInt(e.target.value, 10) || 0 })}
              className="input-base w-full"
            />
          </FormRow>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormRow label="用户名（ACL）" hint="Redis 6+；留空用传统密码">
            <input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              className="input-base w-full font-mono"
            />
          </FormRow>
          <FormRow label="超时（秒）">
            <input
              type="number"
              min={1}
              max={60}
              value={form.connect_timeout_secs}
              onChange={(e) =>
                setForm({ ...form, connect_timeout_secs: parseInt(e.target.value, 10) || 5 })
              }
              className="input-base w-full"
            />
          </FormRow>
        </div>
        <FormRow label="密码" hint="无密码实例可留空；后端加密入库">
          <input
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="input-base w-full font-mono"
          />
        </FormRow>
        <label className="flex items-center space-x-2 text-sm">
          <input
            type="checkbox"
            checked={form.use_tls}
            onChange={(e) => setForm({ ...form, use_tls: e.target.checked })}
          />
          <span>
            使用 TLS（rediss://）
            <span className="text-xs text-gray-400 ml-1">（托管 Redis 常需开启）</span>
          </span>
        </label>
      </div>
      <div className="flex justify-end space-x-2 pt-4 border-t mt-4">
        <button type="button" onClick={onClose} className="btn-default">
          取消
        </button>
        <button type="button" onClick={submit} disabled={saving} className="btn-primary">
          {saving ? (
            <>
              <i className="fas fa-spinner fa-spin mr-2"></i>创建中…
            </>
          ) : (
            <>
              <i className="fas fa-plus mr-2"></i>创建
            </>
          )}
        </button>
      </div>
    </Dialog>
  )
}

// ── 通用小组件 ────────────────────────────────────────────────────────

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
  widthClass,
  children,
}: {
  title: React.ReactNode
  onClose: () => void
  widthClass?: string
  children: React.ReactNode
}) {
  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className={`bg-white rounded shadow-lg w-full ${widthClass ?? 'max-w-md'} max-h-[90vh] overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
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
