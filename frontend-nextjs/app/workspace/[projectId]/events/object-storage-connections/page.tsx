'use client'

/**
 * `/workspace/[projectId]/events/object-storage-connections` — 项目维度的对象存储
 * （COS / OSS / MinIO，S3 兼容）数据源管理。
 *
 * 视图分两层（同 Redis / Kafka 连接页）：
 *   1. **连接列表**（左）：当前项目登记的所有对象存储连接
 *   2. **连接详情**（右）：数据控制台（put/get/delete/list/presign）+ 连接设置 + 探活
 *
 * 安全要点：
 *   - `secret_key` 明文**仅在创建/更新表单提交瞬间**经过前端；后端加密入库，
 *     `secret_key_enc` 永不回传（`#[serde(skip_serializing)]`）。
 *   - exec 写操作（put/delete/presign PUT）需 owner/admin/member，读放行任意成员。
 *
 * tenantId 来自 URL 的 projectId（projectId === tenant.id）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import {
  objectStorageAPI,
  OBJECT_STORAGE_OPS,
  OBJECT_STORAGE_TOKEN_OPS,
  type ObjectStorageConnection,
  type ObjectStorageProvider,
  type ObjectStorageOp,
  type ObjectStorageAccessToken,
  type ObjectStorageTokenOp,
  type CreateObjectStorageConnectionInput,
  type CreateObjectStorageTokenInput,
  type UpdateObjectStorageConnectionInput,
} from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import { useNotification } from '@/hooks/useNotification'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'

const OS_TOKEN_OPS: ObjectStorageTokenOp[] = [...OBJECT_STORAGE_TOKEN_OPS]

const PROVIDERS: { value: ObjectStorageProvider; label: string }[] = [
  { value: 'minio', label: 'MinIO' },
  { value: 'cos', label: '腾讯云 COS' },
  { value: 'oss', label: '阿里云 OSS' },
]

const DEFAULT_EXEC_ARGS = '{"key":"demo.txt","content":"hello"}'

export default function ObjectStorageConnectionsPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const caps = useCurrentProjectCapabilities()

  if (!caps.canManageEvents) {
    return (
      <ForbiddenPlaceholder reason="对象存储数据源管理需要 admin+ 角色（owner / admin / 超管）" />
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

  return <ObjectStorageConnectionsManager tenantId={projectId} />
}

// ── 内部组件 ──────────────────────────────────────────────────────────

function ObjectStorageConnectionsManager({ tenantId }: { tenantId: number }) {
  const notify = useNotification()
  const [connections, setConnections] = useState<ObjectStorageConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [activeId, setActiveId] = useState<number | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const loadConnections = useCallback(async () => {
    setLoading(true)
    try {
      const res = await objectStorageAPI.listConnections(tenantId)
      setConnections(res.data)
      if (res.data.length > 0) {
        setActiveId((prev) =>
          prev !== null && res.data.some((c) => c.id === prev) ? prev : res.data[0].id,
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
            <i className="fas fa-cloud mr-2 text-sky-600"></i>
            对象存储数据源
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            登记租户已有的 COS / OSS / MinIO（S3 兼容）桶；平台保管 endpoint / 密钥，业务经数据
            API 与工作流统一读写，无需散落凭据。
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
              <i className="fas fa-cloud text-3xl text-gray-300 mb-2"></i>
              <p className="text-sm text-gray-500">还没有对象存储连接</p>
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
            notify.success('对象存储连接已创建')
          }}
        />
      )}
    </div>
  )
}

// ── 连接列表项 ────────────────────────────────────────────────────────

function providerLabel(provider: string): string {
  return PROVIDERS.find((p) => p.value === provider)?.label ?? provider
}

function ConnectionListItem({
  connection,
  active,
  onClick,
}: {
  connection: ObjectStorageConnection
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
      <div className="text-xs text-gray-500 mt-1 truncate font-mono">{connection.bucket}</div>
      <div className="flex items-center text-xs text-gray-400 mt-1 space-x-2">
        <span title="服务商">
          <i className="fas fa-server mr-1"></i>
          {providerLabel(connection.provider)}
        </span>
        {connection.force_path_style && (
          <span title="强制 path-style 寻址">
            <i className="fas fa-route mr-1"></i>path-style
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
  connection: ObjectStorageConnection
  onChanged: () => void
  onDeleted: () => void
}) {
  const notify = useNotification()
  const [tab, setTab] = useState<'usage' | 'tokens' | 'console' | 'settings'>('usage')

  const handleDelete = async () => {
    if (
      !window.confirm(
        `确认删除连接「${connection.connection_name}」？删除后引用它的数据 API / 工作流节点会立即失败。`,
      )
    )
      return
    try {
      await objectStorageAPI.deleteConnection(connection.id)
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
            {providerLabel(connection.provider)} · {connection.bucket} · {connection.endpoint}
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

      <div className="border-b flex text-sm flex-wrap">
        {[
          { id: 'usage', label: '接入指南', icon: 'fa-book' },
          { id: 'tokens', label: '访问令牌', icon: 'fa-key' },
          { id: 'console', label: '控制台', icon: 'fa-terminal' },
          { id: 'settings', label: '设置', icon: 'fa-cog' },
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
        {tab === 'usage' && <UsageTab connection={connection} />}
        {tab === 'tokens' && <TokensTab connectionId={connection.id} />}
        {tab === 'console' && <ConsoleTab connection={connection} />}
        {tab === 'settings' && <SettingsTab connection={connection} onUpdated={onChanged} />}
      </div>
    </div>
  )
}

// ── 接入指南（令牌面 REST）────────────────────────────────────────────

function UsageTab({ connection }: { connection: ObjectStorageConnection }) {
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
    ? `${origin}/api/v1/${encodeURIComponent(databaseSlug)}/object-storage/${connection.id}`
    : `${origin}/api/object-storage/${connection.id}`

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      notify.success(`已复制：${label}`)
    } catch {
      notify.error('复制失败，请手动选择文本')
    }
  }

  const execCurl = `curl -X POST '${base}/exec' \\
  -H 'Authorization: ApiKey cres_os_<your_token>' \\
  -H 'Content-Type: application/json' \\
  -d '{"op":"put","args":{"key":"demo.txt","content":"hello"}}'`

  const healthCurl = `curl '${base}/health' \\
  -H 'Authorization: ApiKey cres_os_<your_token>'`

  return (
    <div className="space-y-4 text-sm">
      <div className="bg-blue-50 border border-blue-200 text-blue-900 rounded p-3 space-y-1.5 text-xs">
        <div className="font-semibold">
          <i className="fas fa-lightbulb mr-1"></i>对外 REST（对齐 Kafka）
        </div>
        {!databaseSlug && (
          <p className="text-amber-800">
            当前项目尚未绑定主数据库连接，示例暂用{' '}
            <code className="bg-white px-1 rounded">/api/object-storage/...</code>
            ；绑定后将自动带上项目 slug。
          </p>
        )}
        <ul className="list-disc list-inside space-y-0.5">
          <li>
            先在「访问令牌」Tab 创建 <code className="bg-white px-1 rounded">cres_os_*</code>
            ，明文仅创建时显示一次。
          </li>
          <li>
            请求头：
            <code className="bg-white px-1 rounded">Authorization: ApiKey cres_os_...</code>
            （也支持 Bearer / X-Os-Token）。
          </li>
          <li>令牌可限制 allowed_ops 与 key_prefix_allowlist；无需平台登录即可调用。</li>
        </ul>
      </div>

      {[
        { title: 'Exec（put/get/delete/list/presign）', curl: execCurl },
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
  const [tokens, setTokens] = useState<ObjectStorageAccessToken[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [revealed, setRevealed] = useState<{ token: string; name: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await objectStorageAPI.listTokens(connectionId)
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

  const toggleActive = async (t: ObjectStorageAccessToken) => {
    try {
      await objectStorageAPI.updateToken(connectionId, t.id, { is_active: !t.is_active })
      notify.success(t.is_active ? 'token 已停用' : 'token 已启用')
      load()
    } catch {
      /* noop */
    }
  }

  const remove = async (t: ObjectStorageAccessToken) => {
    if (!window.confirm(`确认删除 token「${t.name}」？使用中的请求将立即 401。`)) return
    try {
      await objectStorageAPI.deleteToken(connectionId, t.id)
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
          每个 token 独立配置 ops / object key 白名单；明文仅在创建时一次性显示。
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
                <th className="py-2 px-2">keys</th>
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
                    {t.key_prefix_allowlist.join(', ')}
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
        <CreateOsTokenModal
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

function CreateOsTokenModal({
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
  const [ops, setOps] = useState<ObjectStorageTokenOp[]>([...OS_TOKEN_OPS])
  const [keys, setKeys] = useState('*')
  const [saving, setSaving] = useState(false)

  const toggleOp = (op: ObjectStorageTokenOp) => {
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
    const key_prefix_allowlist = keys
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (key_prefix_allowlist.length === 0) {
      notify.error('key 白名单不能为空')
      return
    }
    const payload: CreateObjectStorageTokenInput = {
      name: name.trim(),
      description: description.trim() || undefined,
      allowed_ops: ops,
      key_prefix_allowlist,
    }
    setSaving(true)
    try {
      const res = await objectStorageAPI.createToken(connectionId, payload)
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
        <h3 className="font-semibold">新建对象存储访问令牌</h3>
        <div>
          <label className="block text-xs text-gray-500 mb-1">名称 *</label>
          <input
            className="w-full border rounded px-3 py-2 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="上传服务 put"
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
            {OS_TOKEN_OPS.map((op) => (
              <label key={op} className="inline-flex items-center gap-1.5">
                <input type="checkbox" checked={ops.includes(op)} onChange={() => toggleOp(op)} />
                <span className="font-mono">{op}</span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            key_prefix_allowlist（逗号或换行，* 表示不限；支持 uploads/*）
          </label>
          <textarea
            className="w-full border rounded px-3 py-2 text-sm font-mono"
            rows={3}
            value={keys}
            onChange={(e) => setKeys(e.target.value)}
            placeholder="uploads/*&#10;public/readme.txt"
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

// ── 控制台：put / get / delete / list / presign ────────────────────────

function ConsoleTab({ connection }: { connection: ObjectStorageConnection }) {
  const notify = useNotification()
  const [op, setOp] = useState<ObjectStorageOp>('get')
  const [argsText, setArgsText] = useState(DEFAULT_EXEC_ARGS)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    let args: Record<string, unknown> = {}
    if (argsText.trim() !== '') {
      try {
        const parsed = JSON.parse(argsText)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('args 必须是 JSON 对象')
        }
        args = parsed as Record<string, unknown>
      } catch (err: any) {
        notify.error(`args 不是合法 JSON：${err?.message || err}`)
        return
      }
    }

    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const res = await objectStorageAPI.exec(connection.id, { op, args })
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
              setOp(e.target.value as ObjectStorageOp)
              setResult(null)
              setError(null)
            }}
            className="input-base w-full font-mono"
          >
            {OBJECT_STORAGE_OPS.map((o) => (
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

      <FormRow label="args（JSON）" hint="按所选 op 填写参数，如 put: {key, content}；list: {prefix, max_keys}">
        <textarea
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          className="input-base w-full font-mono text-xs"
          rows={5}
          spellCheck={false}
        />
      </FormRow>

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

      <div className="text-xs text-gray-500 pt-2 border-t">
        支持的操作：<span className="font-mono">{OBJECT_STORAGE_OPS.join(' / ')}</span>。写操作
        （put / delete / presign PUT）需 owner/admin/member，读操作任意成员可用。
      </div>
    </div>
  )
}

// ── 设置（编辑连接） ──────────────────────────────────────────────────

function SettingsTab({
  connection,
  onUpdated,
}: {
  connection: ObjectStorageConnection
  onUpdated: () => void
}) {
  const notify = useNotification()
  const [form, setForm] = useState({
    connection_name: connection.connection_name,
    provider: connection.provider as ObjectStorageProvider,
    endpoint: connection.endpoint,
    region: connection.region,
    bucket: connection.bucket,
    access_key_id: connection.access_key_id,
    secret_key: '', // 留空 = 不修改
    force_path_style: connection.force_path_style,
    connect_timeout_secs: connection.connect_timeout_secs,
    is_active: connection.is_active,
  })
  // 用户是否手动改过 path-style；改过之后，provider 变化就不再自动联动。
  const [pathStyleTouched, setPathStyleTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [healthChecking, setHealthChecking] = useState(false)
  const [healthResult, setHealthResult] = useState<{
    ok: boolean
    latency_ms?: number
    bucket?: string
    error?: string
  } | null>(null)

  const handleProviderChange = (provider: ObjectStorageProvider) => {
    setForm((prev) => ({
      ...prev,
      provider,
      force_path_style: pathStyleTouched ? prev.force_path_style : provider === 'minio',
    }))
  }

  const save = async () => {
    setSaving(true)
    try {
      const payload: UpdateObjectStorageConnectionInput = {
        connection_name: form.connection_name.trim(),
        provider: form.provider,
        endpoint: form.endpoint.trim(),
        region: form.region.trim(),
        bucket: form.bucket.trim(),
        access_key_id: form.access_key_id.trim(),
        force_path_style: form.force_path_style,
        connect_timeout_secs: form.connect_timeout_secs,
        is_active: form.is_active,
      }
      // secret_key 语义：留空 = 不动；非空才提交替换。
      if (form.secret_key.trim() !== '') {
        payload.secret_key = form.secret_key
      }
      await objectStorageAPI.updateConnection(connection.id, payload)
      notify.success('连接已更新')
      setForm({ ...form, secret_key: '' })
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
      const res = await objectStorageAPI.healthCheck(connection.id)
      setHealthResult(res.data)
      if (res.data.ok) {
        notify.success('对象存储可达')
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
      <div className="grid grid-cols-2 gap-3">
        <FormRow label="服务商">
          <select
            value={form.provider}
            onChange={(e) => handleProviderChange(e.target.value as ObjectStorageProvider)}
            className="input-base w-full"
          >
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </FormRow>
        <FormRow label="region">
          <input
            value={form.region}
            onChange={(e) => setForm({ ...form, region: e.target.value })}
            className="input-base w-full font-mono"
          />
        </FormRow>
      </div>
      <FormRow label="endpoint" hint="形如 https://cos.ap-guangzhou.myqcloud.com">
        <input
          value={form.endpoint}
          onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
          className="input-base w-full font-mono"
        />
      </FormRow>
      <div className="grid grid-cols-2 gap-3">
        <FormRow label="bucket">
          <input
            value={form.bucket}
            onChange={(e) => setForm({ ...form, bucket: e.target.value })}
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
      <FormRow label="access_key_id">
        <input
          value={form.access_key_id}
          onChange={(e) => setForm({ ...form, access_key_id: e.target.value })}
          className="input-base w-full font-mono"
        />
      </FormRow>
      <FormRow label="secret_key" hint="留空则不修改。新输入会替换并加密入库。">
        <input
          type="password"
          value={form.secret_key}
          onChange={(e) => setForm({ ...form, secret_key: e.target.value })}
          placeholder="••••••••（输入新值以替换）"
          className="input-base w-full font-mono"
        />
      </FormRow>
      <div className="flex items-center space-x-4 text-sm">
        <label className="flex items-center space-x-2">
          <input
            type="checkbox"
            checked={form.force_path_style}
            onChange={(e) => {
              setPathStyleTouched(true)
              setForm({ ...form, force_path_style: e.target.checked })
            }}
          />
          <span>强制 path-style 寻址</span>
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
          title="HeadBucket 探活"
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
              <i className="fas fa-check-circle mr-1"></i>连通正常
              {typeof healthResult.latency_ms === 'number' && (
                <span className="ml-2">
                  延迟 <span className="font-mono">{healthResult.latency_ms}ms</span>
                </span>
              )}
              {healthResult.bucket && (
                <span className="ml-2">
                  bucket <span className="font-mono">{healthResult.bucket}</span>
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
    provider: 'minio' as ObjectStorageProvider,
    endpoint: '',
    region: 'us-east-1',
    bucket: '',
    access_key_id: '',
    secret_key: '',
    force_path_style: true, // provider 默认 minio → path-style 默认开
    connect_timeout_secs: 5,
  })
  // 用户是否手动改过 path-style；改过之后 provider 联动就不再覆盖。
  const [pathStyleTouched, setPathStyleTouched] = useState(false)
  const [saving, setSaving] = useState(false)

  const handleProviderChange = (provider: ObjectStorageProvider) => {
    setForm((prev) => ({
      ...prev,
      provider,
      force_path_style: pathStyleTouched ? prev.force_path_style : provider === 'minio',
    }))
  }

  const submit = async () => {
    if (!form.connection_name.trim()) {
      notify.error('请填写连接名称')
      return
    }
    if (!form.endpoint.trim()) {
      notify.error('请填写 endpoint')
      return
    }
    if (!form.bucket.trim()) {
      notify.error('请填写 bucket')
      return
    }
    if (!form.access_key_id.trim()) {
      notify.error('请填写 access_key_id')
      return
    }
    if (!form.secret_key.trim()) {
      notify.error('请填写 secret_key')
      return
    }
    setSaving(true)
    try {
      const payload: CreateObjectStorageConnectionInput = {
        tenant_id: tenantId,
        connection_name: form.connection_name.trim(),
        provider: form.provider,
        endpoint: form.endpoint.trim(),
        region: form.region.trim() || undefined,
        bucket: form.bucket.trim(),
        access_key_id: form.access_key_id.trim(),
        secret_key: form.secret_key,
        force_path_style: form.force_path_style,
        connect_timeout_secs: form.connect_timeout_secs,
      }
      const res = await objectStorageAPI.createConnection(payload)
      onCreated(res.data.id)
    } catch {
      /* noop */
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title="新建对象存储连接" onClose={onClose} widthClass="max-w-lg">
      <div className="space-y-3 text-sm">
        <FormRow label="连接名称 *" hint="同租户内不可重名">
          <input
            autoFocus
            value={form.connection_name}
            onChange={(e) => setForm({ ...form, connection_name: e.target.value })}
            className="input-base w-full"
            placeholder="prod-cos / assets-minio / …"
          />
        </FormRow>
        <div className="grid grid-cols-2 gap-3">
          <FormRow label="服务商 *">
            <select
              value={form.provider}
              onChange={(e) => handleProviderChange(e.target.value as ObjectStorageProvider)}
              className="input-base w-full"
            >
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </FormRow>
          <FormRow label="region" hint="MinIO 可任意填，如 us-east-1">
            <input
              value={form.region}
              onChange={(e) => setForm({ ...form, region: e.target.value })}
              className="input-base w-full font-mono"
            />
          </FormRow>
        </div>
        <FormRow label="endpoint *" hint="形如 https://cos.ap-guangzhou.myqcloud.com">
          <input
            value={form.endpoint}
            onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
            className="input-base w-full font-mono"
            placeholder="https://s3.example.internal:9000"
          />
        </FormRow>
        <div className="grid grid-cols-2 gap-3">
          <FormRow label="bucket *">
            <input
              value={form.bucket}
              onChange={(e) => setForm({ ...form, bucket: e.target.value })}
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
        <FormRow label="access_key_id *">
          <input
            value={form.access_key_id}
            onChange={(e) => setForm({ ...form, access_key_id: e.target.value })}
            className="input-base w-full font-mono"
          />
        </FormRow>
        <FormRow label="secret_key *" hint="后端加密入库，永不回传明文">
          <input
            type="password"
            value={form.secret_key}
            onChange={(e) => setForm({ ...form, secret_key: e.target.value })}
            className="input-base w-full font-mono"
          />
        </FormRow>
        <label className="flex items-center space-x-2 text-sm">
          <input
            type="checkbox"
            checked={form.force_path_style}
            onChange={(e) => {
              setPathStyleTouched(true)
              setForm({ ...form, force_path_style: e.target.checked })
            }}
          />
          <span>
            强制 path-style 寻址
            <span className="text-xs text-gray-400 ml-1">
              （MinIO / 自建 S3 常需开启；COS / OSS 通常关闭）
            </span>
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
