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
import { useTranslations } from 'next-intl'
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
import { closeOnBackdropPress } from '@/lib/utils'

export default function RedisConnectionsPage() {
  const t = useTranslations('wsRedisConn')
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

  return <RedisConnectionsManager tenantId={projectId} />
}

// ── 内部组件 ──────────────────────────────────────────────────────────

function RedisConnectionsManager({ tenantId }: { tenantId: number }) {
  const t = useTranslations('wsRedisConn')
  const tc = useTranslations('connCommon')
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
              <i className="fas fa-database text-3xl text-gray-300 mb-2"></i>
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
  const t = useTranslations('wsRedisConn')
  const tc = useTranslations('connCommon')
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
          <span className="text-xs bg-gray-200 text-gray-700 px-1.5 py-0.5 rounded">{t('deleted') && tc('disabled')}</span>
        )}
      </div>
      <div className="text-xs text-gray-500 mt-1 truncate font-mono">
        {connection.host}:{connection.port} · db{connection.db_index}
      </div>
      <div className="flex items-center text-xs text-gray-400 mt-1 space-x-2">
        {connection.use_tls && (
          <span className="text-emerald-600" title={t('tlsTitle')}>
            <i className="fas fa-lock"></i> TLS
          </span>
        )}
        {connection.username && (
          <span title={t('aclTitle')}>
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
  const tr = useTranslations('wsRedisConn')
  const tc = useTranslations('connCommon')
  const notify = useNotification()
  const [tab, setTab] = useState<'console' | 'usage' | 'settings'>('console')

  const handleDelete = async () => {
    if (
      !window.confirm(
        tr('confirmDelete', { name: connection.connection_name }),
      )
    )
      return
    try {
      await redisAPI.deleteConnection(connection.id)
      notify.success(tr('deleted'))
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
          title={tr('deleteTitle')}
        >
          <i className="fas fa-trash"></i>
        </button>
      </div>

      <div className="border-b flex text-sm">
        {[
          { id: 'console', label: tr('tabConsole'), icon: 'fa-terminal' },
          { id: 'usage', label: tr('tabUsage'), icon: 'fa-book' },
          { id: 'settings', label: tr('tabSettings'), icon: 'fa-cog' },
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
  const t = useTranslations('wsRedisConn')
  const tc = useTranslations('connCommon')
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
      notify.error(t('fillKey'))
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
      setError(err?.response?.data?.error || err?.message || t('execFailed'))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-3 text-sm">
      {!connection.is_active && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded p-2 text-xs">
          <i className="fas fa-exclamation-triangle mr-1"></i>{t('disabledWarn')}
        </div>
      )}

      <div className="flex items-end gap-2">
        <div className="w-40">
          <label className="block text-xs font-medium text-gray-700 mb-1">{t('opLabel')}</label>
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
              <i className="fas fa-spinner fa-spin mr-2"></i>{t('executing')}
            </>
          ) : (
            <>
              <i className="fas fa-play mr-2"></i>{t('execute')}
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
          <FormRow label="value" hint={t('valueHint')}>
            <input value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} className="input-base w-full font-mono" />
          </FormRow>
        )}
        {fields.includes('ttl') && (
          <FormRow label={t('ttlLabel')} hint={op === 'set' ? t('ttlHint') : undefined}>
            <input type="number" value={f.ttl} onChange={(e) => setF({ ...f, ttl: e.target.value })} className="input-base w-full" />
          </FormRow>
        )}
        {fields.includes('pattern') && (
          <FormRow label="pattern" hint={t('patternHint')}>
            <input value={f.pattern} onChange={(e) => setF({ ...f, pattern: e.target.value })} className="input-base w-full font-mono" />
          </FormRow>
        )}
        {fields.includes('count') && (
          <FormRow label={t('limitLabel')} hint={t('limitHint')}>
            <input type="number" value={f.count} onChange={(e) => setF({ ...f, count: e.target.value })} className="input-base w-full" />
          </FormRow>
        )}
        {fields.includes('start') && (
          <FormRow label="start">
            <input type="number" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} className="input-base w-full" />
          </FormRow>
        )}
        {fields.includes('stop') && (
          <FormRow label="stop" hint={t('stopHint')}>
            <input type="number" value={f.stop} onChange={(e) => setF({ ...f, stop: e.target.value })} className="input-base w-full" />
          </FormRow>
        )}
        {fields.includes('members') && (
          <FormRow label="members" hint={t('membersHint')}>
            <textarea value={f.members} onChange={(e) => setF({ ...f, members: e.target.value })} className="input-base w-full font-mono" rows={2} />
          </FormRow>
        )}
        {fields.includes('values') && (
          <FormRow label="values" hint={t('valuesHint')}>
            <textarea value={f.values} onChange={(e) => setF({ ...f, values: e.target.value })} className="input-base w-full font-mono" rows={2} />
          </FormRow>
        )}
      </div>

      {fields.includes('nx') && (
        <label className="flex items-center space-x-2 text-sm">
          <input type="checkbox" checked={f.nx} onChange={(e) => setF({ ...f, nx: e.target.checked })} />
          <span>{t('nxHint')}</span>
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
          <div className="text-xs font-medium text-gray-700 mb-1">{t('resultLabel')}</div>
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
  const t = useTranslations('wsRedisConn')
  const tc = useTranslations('connCommon')
  const notify = useNotification()
  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'https://platform.example.com'
  const execUrl = `${origin}/api/redis-connections/${connection.id}/exec`

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      notify.success(t('copied', { label }))
    } catch {
      notify.error(t('copyFail'))
    }
  }

  const curlSet = `${t('curlSet')}
curl -X POST "${execUrl}" \\
  -H "Authorization: Bearer <your_jwt>" \\
  -H "Content-Type: application/json" \\
  -d '{"op":"set","args":{"key":"greeting","value":"hello","ttl":60}}'`

  const curlGet = `${t('curlGet')}
curl -X POST "${execUrl}" \\
  -H "Authorization: Bearer <your_jwt>" \\
  -H "Content-Type: application/json" \\
  -d '{"op":"get","args":{"key":"greeting"}}'
# → {"op":"get","result":{"value":"hello"}}`

  const workflowNote = t('wfNote', { name: connection.connection_name })

  return (
    <div className="space-y-3 text-sm">
      <div className="bg-blue-50 border border-blue-200 text-blue-900 rounded p-3 text-xs space-y-1">
        <div className="font-semibold">
          <i className="fas fa-lightbulb mr-1"></i>{t('usageTitle')}
        </div>
        <ul className="list-disc list-inside space-y-0.5">
          <li>{t('usage1')}</li>
          <li>{t('usage2Pre')}<code className="bg-white px-1 rounded">POST /api/redis-connections/{connection.id}/exec</code>{t('usage2Post')}</li>
          <li>{t('usage3Pre')}<code className="bg-white px-1 rounded">redis</code>{t('usage3Mid')}</li>
        </ul>
      </div>
      <CodeBlock label={t('execAddr')} code={execUrl} onCopy={() => copy(execUrl, t('execAddr'))} />
      <CodeBlock label={t('writeSet')} code={curlSet} onCopy={() => copy(curlSet, t('writeExample'))} />
      <CodeBlock label={t('readGet')} code={curlGet} onCopy={() => copy(curlGet, t('readExample'))} />
      <div className="bg-gray-50 border border-gray-200 text-gray-700 rounded p-3 text-xs whitespace-pre-wrap">
        <div className="font-semibold mb-1">
          <i className="fas fa-diagram-project mr-1"></i>{t('wfTitle')}
        </div>
        {workflowNote}
      </div>
      <div className="text-xs text-gray-500 pt-2 border-t">
        {t('supportedCmds')}<span className="font-mono">{REDIS_OPS.join(' / ')}</span>{t('dangerCmds')}
      </div>
    </div>
  )
}

function CodeBlock({ label, code, onCopy }: { label: string; code: string; onCopy: () => void }) {
  const tc = useTranslations('connCommon')
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-gray-700">{label}</span>
        <button type="button" onClick={onCopy} className="text-xs text-blue-600 hover:underline">
          <i className="fas fa-copy mr-1"></i>{tc('copy')}
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
  const t = useTranslations('wsRedisConn')
  const tc = useTranslations('connCommon')
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
      notify.success(t('updated'))
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
        notify.success(t('reachable'))
      } else {
        notify.warning(tc('testFail'))
      }
    } catch (err: any) {
      setHealthResult({ ok: false, error: err?.response?.data?.error || err?.message || tc('testFail') })
    } finally {
      setHealthChecking(false)
    }
  }

  return (
    <div className="space-y-3 text-sm">
      <FormRow label={t('connName')}>
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
        <FormRow label={t('dbNum')}>
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
        <FormRow label={t('aclUser')} hint={t('aclHintSettings')}>
          <input
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            className="input-base w-full font-mono"
          />
        </FormRow>
        <FormRow label={t('timeout')}>
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
      <FormRow label={t('password')} hint={t('pwHintSettings')}>
        <input
          type="password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          placeholder={t('pwPlaceholder')}
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
          <span>{t('connEnabledSettings')}</span>
        </label>
      </div>

      <div className="flex items-center space-x-2 pt-3 border-t">
        <button type="button" onClick={save} disabled={saving} className="btn-primary">
          {saving ? (
            <>
              <i className="fas fa-spinner fa-spin mr-2"></i>{tc('saving')}
            </>
          ) : (
            <>
              <i className="fas fa-save mr-2"></i>{tc('save')}
            </>
          )}
        </button>
        <button
          type="button"
          onClick={probe}
          disabled={healthChecking}
          className="btn-default"
          title={t('pingTitle')}
        >
          {healthChecking ? (
            <>
              <i className="fas fa-spinner fa-spin mr-2"></i>{tc('testing')}
            </>
          ) : (
            <>
              <i className="fas fa-heartbeat mr-2"></i>{t('pingTest')}
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
              {healthResult.error || tc('testFail')}
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
  const t = useTranslations('wsRedisConn')
  const tc = useTranslations('connCommon')
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
      notify.error(t('fillName'))
      return
    }
    if (!form.host.trim()) {
      notify.error(t('fillHost'))
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
    <Dialog title={t('createTitle')} onClose={onClose} widthClass="max-w-lg">
      <div className="space-y-3 text-sm">
        <FormRow label={t('connNameReq')} hint={t('connNameHint')}>
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
          <FormRow label={t('dbNum')}>
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
          <FormRow label={t('aclUser')} hint={t('aclHintCreate')}>
            <input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              className="input-base w-full font-mono"
            />
          </FormRow>
          <FormRow label={t('timeout')}>
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
        <FormRow label={t('password')} hint={t('pwHintCreate')}>
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
            {t('useTls')}
            <span className="text-xs text-gray-400 ml-1">{t('tlsManaged')}</span>
          </span>
        </label>
      </div>
      <div className="flex justify-end space-x-2 pt-4 border-t mt-4">
        <button type="button" onClick={onClose} className="btn-default">
          {tc('cancel')}
        </button>
        <button type="button" onClick={submit} disabled={saving} className="btn-primary">
          {saving ? (
            <>
              <i className="fas fa-spinner fa-spin mr-2"></i>{t('creating')}
            </>
          ) : (
            <>
              <i className="fas fa-plus mr-2"></i>{t('create')}
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
      onMouseDown={closeOnBackdropPress(onClose)}
    >
      <div
        className={`bg-white rounded shadow-lg w-full ${widthClass ?? 'max-w-md'} max-h-[90vh] overflow-y-auto`}
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
