'use client'

/**
 * `/workspace/[projectId]/events/datasources` —— 工作流「数据源 / 凭证」集成模块。
 *
 * 形态：单页双 Tab（数据源列表 / 凭证管理）+ 居中弹窗新建/编辑。数据源携带连接
 * 信息并引用一份加密凭证；工作流的 db_query / db_execute 节点可在配置里选择数据源，
 * 覆盖默认的「工作流绑定库」。
 *
 * 鉴权：admin+（含 owner / 平台超管）。后端 `require_tenant_admin`，前端用
 * `canManageEvents`（与集成组其它入口同档）决定是否渲染。
 *
 * 安全模型：凭证密钥加密入库、永不回显（编辑时留空表示保持不变）。
 */

import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import {
  wfCredentialAPI,
  wfDatasourceAPI,
  type WfCredential,
  type WfCredentialKind,
  type WfDatasource,
  type WfDatasourceType,
  type WfDatasourceStatus,
} from '@/lib/api'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import { useNotification } from '@/hooks/useNotification'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'

type Tab = 'datasources' | 'credentials'

const DS_TYPE_LABELS: Record<WfDatasourceType, string> = {
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
}

const STATUS_META: Record<WfDatasourceStatus, { label: string; cls: string; dot: string }> = {
  connected: { label: '已连通', cls: 'bg-emerald-50 text-emerald-600', dot: 'bg-emerald-500' },
  untested: { label: '未测试', cls: 'bg-gray-100 text-gray-500', dot: 'bg-gray-400' },
  failed: { label: '连接失败', cls: 'bg-red-50 text-red-600', dot: 'bg-red-500' },
}

interface DsForm {
  editing: WfDatasource | null
  name: string
  description: string
  ds_type: WfDatasourceType
  host: string
  port: string
  database: string
  credential_id: string
}

const EMPTY_DS_FORM: DsForm = {
  editing: null,
  name: '',
  description: '',
  ds_type: 'postgresql',
  host: '',
  port: '5432',
  database: '',
  credential_id: '',
}

interface CredForm {
  editing: WfCredential | null
  name: string
  kind: WfCredentialKind
  username: string
  secret: string
  description: string
}

const EMPTY_CRED_FORM: CredForm = {
  editing: null,
  name: '',
  kind: 'basic',
  username: '',
  secret: '',
  description: '',
}

export default function DatasourcesPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const caps = useCurrentProjectCapabilities()
  const notify = useNotification()

  const [tab, setTab] = useState<Tab>('datasources')
  const [datasources, setDatasources] = useState<WfDatasource[] | null>(null)
  const [credentials, setCredentials] = useState<WfCredential[] | null>(null)
  const [loading, setLoading] = useState(true)

  const [dsForm, setDsForm] = useState<DsForm | null>(null)
  const [credForm, setCredForm] = useState<CredForm | null>(null)
  const [saving, setSaving] = useState(false)
  const [testingId, setTestingId] = useState<number | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const [ds, cr] = await Promise.all([
        wfDatasourceAPI.list(projectId),
        wfCredentialAPI.list(projectId),
      ])
      setDatasources(ds.data)
      setCredentials(cr.data)
    } catch (err: any) {
      notify.error(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (Number.isFinite(projectId) && caps.canManageEvents) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, caps.canManageEvents])

  const credNameById = useMemo(() => {
    const m = new Map<number, string>()
    credentials?.forEach((c) => m.set(c.id, c.name))
    return m
  }, [credentials])

  if (!caps.canManageEvents) {
    return <ForbiddenPlaceholder reason="数据源管理需要项目 admin 或 owner 角色（或平台超管）" />
  }

  // ── 数据源：保存 ──
  const handleDsSave = async () => {
    if (!dsForm) return
    if (!dsForm.name.trim()) return notify.warning('请填写数据源名称')
    setSaving(true)
    try {
      const body = {
        name: dsForm.name.trim(),
        description: dsForm.description.trim() || null,
        ds_type: dsForm.ds_type,
        host: dsForm.host.trim() || null,
        port: dsForm.port ? parseInt(dsForm.port, 10) : null,
        database: dsForm.database.trim() || null,
        credential_id: dsForm.credential_id ? parseInt(dsForm.credential_id, 10) : null,
      }
      if (dsForm.editing) {
        const res = await wfDatasourceAPI.update(projectId, dsForm.editing.id, body)
        setDatasources((prev) => prev?.map((d) => (d.id === res.data.id ? res.data : d)) ?? null)
        notify.success(`已更新数据源 ${res.data.name}`)
      } else {
        const res = await wfDatasourceAPI.create(projectId, body)
        setDatasources((prev) => (prev ? [...prev, res.data] : [res.data]))
        notify.success(`已新建数据源 ${res.data.name}`)
      }
      setDsForm(null)
    } catch (err: any) {
      notify.error(err)
    } finally {
      setSaving(false)
    }
  }

  const handleDsDelete = async (d: WfDatasource) => {
    if (!window.confirm(`确认删除数据源 ${d.name} 吗？`)) return
    try {
      await wfDatasourceAPI.remove(projectId, d.id)
      setDatasources((prev) => prev?.filter((x) => x.id !== d.id) ?? null)
      notify.success(`已删除 ${d.name}`)
    } catch (err: any) {
      notify.error(err)
    }
  }

  const handleDsTest = async (d: WfDatasource) => {
    setTestingId(d.id)
    try {
      const res = await wfDatasourceAPI.test(projectId, d.id)
      setDatasources((prev) =>
        prev?.map((x) =>
          x.id === d.id
            ? { ...x, status: res.data.status, last_test_error: res.data.error ?? null }
            : x,
        ) ?? null,
      )
      if (res.data.ok) notify.success(`${d.name} 连接成功`)
      else notify.warning(`${d.name} 连接失败：${res.data.error ?? '未知错误'}`)
    } catch (err: any) {
      notify.error(err)
    } finally {
      setTestingId(null)
    }
  }

  // ── 凭证：保存 ──
  const handleCredSave = async () => {
    if (!credForm) return
    if (!credForm.name.trim()) return notify.warning('请填写凭证名称')
    if (!credForm.editing && !credForm.secret) return notify.warning('新建凭证必须填写密码 / 令牌')
    setSaving(true)
    try {
      const body = {
        name: credForm.name.trim(),
        kind: credForm.kind,
        username: credForm.kind === 'basic' ? credForm.username.trim() || null : null,
        secret: credForm.secret || undefined,
        description: credForm.description.trim() || null,
      }
      if (credForm.editing) {
        const res = await wfCredentialAPI.update(projectId, credForm.editing.id, body)
        setCredentials((prev) => prev?.map((c) => (c.id === res.data.id ? res.data : c)) ?? null)
        notify.success(`已更新凭证 ${res.data.name}`)
      } else {
        const res = await wfCredentialAPI.create(projectId, body)
        setCredentials((prev) => (prev ? [...prev, res.data] : [res.data]))
        notify.success(`已新建凭证 ${res.data.name}`)
      }
      setCredForm(null)
    } catch (err: any) {
      notify.error(err)
    } finally {
      setSaving(false)
    }
  }

  const handleCredDelete = async (c: WfCredential) => {
    if (!window.confirm(`确认删除凭证 ${c.name} 吗？`)) return
    try {
      await wfCredentialAPI.remove(projectId, c.id)
      setCredentials((prev) => prev?.filter((x) => x.id !== c.id) ?? null)
      notify.success(`已删除 ${c.name}`)
    } catch (err: any) {
      notify.error(err)
    }
  }

  const connInfo = (d: WfDatasource) => {
    const hostPort = d.port ? `${d.host}:${d.port}` : d.host
    return d.database ? `${hostPort}/${d.database}` : hostPort || '—'
  }

  return (
    <div className="p-6 max-w-6xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900">数据源</h1>
          <p className="text-sm text-gray-500 mt-1">
            配置工作流节点可引用的数据库连接与凭证。数据源在项目内共享；工作流的{' '}
            <code className="px-1 bg-gray-100 rounded">数据库查询 / 写入</code> 节点选择数据源后，
            执行时使用其连接，而非工作流绑定的默认库。
          </p>
        </div>
        <button
          onClick={() => (tab === 'datasources' ? setDsForm(EMPTY_DS_FORM) : setCredForm(EMPTY_CRED_FORM))}
          className="btn-primary flex-shrink-0 whitespace-nowrap"
        >
          <i className="fas fa-plus mr-2" />
          {tab === 'datasources' ? '新增数据源' : '新增凭证'}
        </button>
      </div>

      {/* Tab 切换 */}
      <div className="flex items-center gap-1 border-b border-gray-200">
        {(
          [
            ['datasources', '数据源列表', 'fas fa-plug-circle-bolt'],
            ['credentials', '凭证管理', 'fas fa-key'],
          ] as [Tab, string, string][]
        ).map(([key, label, icon]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px flex items-center gap-2 transition-colors ${
              tab === key
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <i className={`${icon} text-xs`} />
            {label}
          </button>
        ))}
      </div>

      {loading && (
        <div className="py-16 text-center text-gray-400">
          <i className="fas fa-spinner fa-spin mr-2" />加载中...
        </div>
      )}

      {/* ── 数据源列表 ── */}
      {!loading && tab === 'datasources' && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500 tracking-wider">
              <tr>
                <th className="px-5 py-3 text-left font-medium">名称</th>
                <th className="px-5 py-3 text-left font-medium">类型</th>
                <th className="px-5 py-3 text-left font-medium">连接信息</th>
                <th className="px-5 py-3 text-left font-medium">凭证</th>
                <th className="px-5 py-3 text-left font-medium">状态</th>
                <th className="px-5 py-3 text-left font-medium">引用</th>
                <th className="px-5 py-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(datasources?.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-gray-400">
                    暂无数据源，点击右上角「新增数据源」添加第一个。
                  </td>
                </tr>
              )}
              {datasources?.map((d) => {
                const st = STATUS_META[d.status] ?? STATUS_META.untested
                return (
                  <tr key={d.id} className="hover:bg-gray-50/50">
                    <td className="px-5 py-3">
                      <div className="font-medium text-gray-800">{d.name}</div>
                      {d.description && <div className="text-[11px] text-gray-400">{d.description}</div>}
                    </td>
                    <td className="px-5 py-3">
                      <span className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600 font-medium">
                        {DS_TYPE_LABELS[d.ds_type] ?? d.ds_type}
                      </span>
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-gray-600 break-all">{connInfo(d)}</td>
                    <td className="px-5 py-3 text-gray-600">
                      {d.credential_name ? (
                        <span className="flex items-center gap-1 text-xs">
                          <i className="fas fa-key text-[9px] text-amber-500" />
                          {d.credential_name}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full font-medium inline-flex items-center gap-1 ${st.cls}`}
                        title={d.status === 'failed' && d.last_test_error ? d.last_test_error : undefined}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                        {st.label}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs text-gray-600">
                      {d.ref_count > 0 ? `${d.ref_count} 个工作流` : '0'}
                    </td>
                    <td className="px-5 py-3 text-right whitespace-nowrap">
                      <button
                        onClick={() =>
                          setDsForm({
                            editing: d,
                            name: d.name,
                            description: d.description ?? '',
                            ds_type: d.ds_type,
                            host: d.host ?? '',
                            port: d.port != null ? String(d.port) : '',
                            database: d.database ?? '',
                            credential_id: d.credential_id != null ? String(d.credential_id) : '',
                          })
                        }
                        className="text-blue-600 hover:text-blue-800 text-sm mr-3"
                      >
                        编辑
                      </button>
                      <button
                        onClick={() => handleDsTest(d)}
                        disabled={testingId === d.id}
                        className="text-gray-500 hover:text-gray-700 text-sm mr-3 disabled:opacity-40"
                      >
                        {testingId === d.id ? <i className="fas fa-spinner fa-spin" /> : '测试'}
                      </button>
                      <button
                        onClick={() => handleDsDelete(d)}
                        className="text-red-600 hover:text-red-800 text-sm"
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="px-5 py-3 text-xs text-gray-400 flex items-center gap-1.5 border-t border-gray-100">
            <i className="fas fa-info-circle" />
            当前 PostgreSQL / MySQL 数据源可在 db 节点中执行 SQL；HTTP API 暂为元数据登记。
          </p>
        </div>
      )}

      {/* ── 凭证管理 ── */}
      {!loading && tab === 'credentials' && (
        <div>
          <p className="text-xs text-gray-500 mb-3">
            凭证以加密形式存储，配置后可在数据源中引用。密码 / 令牌仅写入不回显。
          </p>
          {(credentials?.length ?? 0) === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl py-12 text-center text-gray-400">
              暂无凭证，点击右上角「新增凭证」添加第一个。
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {credentials?.map((c) => (
                <div
                  key={c.id}
                  className="border border-gray-200 rounded-lg p-4 hover:border-blue-300 hover:shadow-sm transition-all bg-white"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-md bg-amber-50 flex items-center justify-center">
                        <i className="fas fa-key text-amber-600 text-xs" />
                      </div>
                      <div>
                        <div className="text-sm font-medium text-gray-800">{c.name}</div>
                        <div className="text-[11px] text-gray-400">
                          {c.kind === 'bearer' ? 'Bearer Token' : '用户名/密码'}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 space-y-1 text-xs">
                    {c.kind === 'basic' && (
                      <div className="flex justify-between">
                        <span className="text-gray-400">用户名</span>
                        <span className="font-mono text-gray-600">{c.username || '—'}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-gray-400">{c.kind === 'bearer' ? 'Token' : '密码'}</span>
                      <span className="font-mono text-gray-400">••••••••</span>
                    </div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-gray-100 flex items-center justify-between">
                    <span className="text-[11px] text-gray-400 flex items-center gap-1">
                      <i className="fas fa-link text-[9px]" />被 {c.ref_count} 个数据源引用
                    </span>
                    <span className="whitespace-nowrap">
                      <button
                        onClick={() =>
                          setCredForm({
                            editing: c,
                            name: c.name,
                            kind: c.kind,
                            username: c.username ?? '',
                            secret: '',
                            description: c.description ?? '',
                          })
                        }
                        className="text-blue-600 hover:text-blue-800 text-xs mr-3"
                      >
                        编辑
                      </button>
                      <button
                        onClick={() => handleCredDelete(c)}
                        className="text-red-600 hover:text-red-800 text-xs"
                      >
                        删除
                      </button>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── 数据源新建/编辑弹窗 ── */}
      {dsForm && (
        <Modal title={dsForm.editing ? `编辑 ${dsForm.editing.name}` : '新增数据源'} onClose={() => !saving && setDsForm(null)}>
          <div className="grid grid-cols-2 gap-4">
            <Field label="名称" required>
              <input
                value={dsForm.name}
                onChange={(e) => setDsForm({ ...dsForm, name: e.target.value })}
                className="w-full input-base"
                placeholder="hr_db"
                autoFocus
              />
            </Field>
            <Field label="描述">
              <input
                value={dsForm.description}
                onChange={(e) => setDsForm({ ...dsForm, description: e.target.value })}
                className="w-full input-base"
                placeholder="HR 专用库"
              />
            </Field>
            <Field label="类型" required>
              <select
                value={dsForm.ds_type}
                onChange={(e) => {
                  const ds_type = e.target.value as WfDatasourceType
                  // 切换类型时，若端口仍是另一类型的默认值/空，则填入该类型默认端口。
                  const nextPort =
                    dsForm.port === '' || dsForm.port === '5432' || dsForm.port === '3306'
                      ? ds_type === 'mysql'
                        ? '3306'
                        : '5432'
                      : dsForm.port
                  setDsForm({ ...dsForm, ds_type, port: nextPort })
                }}
                className="w-full input-base"
              >
                <option value="postgresql">PostgreSQL</option>
                <option value="mysql">MySQL</option>
              </select>
            </Field>
            <Field label="凭证">
              <select
                value={dsForm.credential_id}
                onChange={(e) => setDsForm({ ...dsForm, credential_id: e.target.value })}
                className="w-full input-base"
              >
                <option value="">— 免密 / 匿名 —</option>
                {credentials?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="主机地址" required className="col-span-2">
              <input
                value={dsForm.host}
                onChange={(e) => setDsForm({ ...dsForm, host: e.target.value })}
                className="w-full input-base font-mono"
                placeholder="10.0.2.30"
              />
            </Field>
            <Field label="端口">
              <input
                value={dsForm.port}
                onChange={(e) => setDsForm({ ...dsForm, port: e.target.value })}
                className="w-full input-base font-mono"
                placeholder={dsForm.ds_type === 'mysql' ? '3306' : '5432'}
              />
            </Field>
            <Field label="库名">
              <input
                value={dsForm.database}
                onChange={(e) => setDsForm({ ...dsForm, database: e.target.value })}
                className="w-full input-base font-mono"
                placeholder="hr_prod"
              />
            </Field>
          </div>
          <ModalFooter onCancel={() => setDsForm(null)} onSave={handleDsSave} saving={saving} />
        </Modal>
      )}

      {/* ── 凭证新建/编辑弹窗 ── */}
      {credForm && (
        <Modal
          title={credForm.editing ? `编辑 ${credForm.editing.name}` : '新增凭证'}
          onClose={() => !saving && setCredForm(null)}
        >
          <div className="space-y-4">
            <Field label="名称" required>
              <input
                value={credForm.name}
                onChange={(e) => setCredForm({ ...credForm, name: e.target.value })}
                className="w-full input-base"
                placeholder="hr_service"
                autoFocus
              />
            </Field>
            <Field label="类型" required>
              <select
                value={credForm.kind}
                onChange={(e) => setCredForm({ ...credForm, kind: e.target.value as WfCredentialKind })}
                className="w-full input-base"
              >
                <option value="basic">用户名 / 密码</option>
                <option value="bearer">Bearer Token</option>
              </select>
            </Field>
            {credForm.kind === 'basic' && (
              <Field label="用户名">
                <input
                  value={credForm.username}
                  onChange={(e) => setCredForm({ ...credForm, username: e.target.value })}
                  className="w-full input-base font-mono"
                  placeholder="hr_svc"
                />
              </Field>
            )}
            <Field label={credForm.kind === 'bearer' ? 'Token' : '密码'} required={!credForm.editing}>
              <input
                type="password"
                value={credForm.secret}
                onChange={(e) => setCredForm({ ...credForm, secret: e.target.value })}
                className="w-full input-base font-mono"
                placeholder={credForm.editing ? '留空表示保持不变' : '仅写入不回显'}
                autoComplete="new-password"
              />
            </Field>
            <Field label="描述">
              <input
                value={credForm.description}
                onChange={(e) => setCredForm({ ...credForm, description: e.target.value })}
                className="w-full input-base"
                placeholder="选填"
              />
            </Field>
          </div>
          <ModalFooter onCancel={() => setCredForm(null)} onSave={handleCredSave} saving={saving} />
        </Modal>
      )}
    </div>
  )
}

// ── 轻量弹窗 / 表单原子组件 ──

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/40 z-40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white w-full max-w-2xl rounded-xl shadow-xl p-6 max-h-[88vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-gray-900 mb-4">{title}</h3>
        {children}
      </div>
    </div>
  )
}

function Field({
  label,
  required,
  className,
  children,
}: {
  label: string
  required?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={className}>
      <label className="block text-sm font-medium text-gray-700 mb-1.5">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </label>
      {children}
    </div>
  )
}

function ModalFooter({ onCancel, onSave, saving }: { onCancel: () => void; onSave: () => void; saving: boolean }) {
  return (
    <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-100">
      <button
        onClick={onCancel}
        disabled={saving}
        className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
      >
        取消
      </button>
      <button onClick={onSave} disabled={saving} className="btn-primary disabled:opacity-50">
        {saving ? '保存中...' : '保存'}
      </button>
    </div>
  )
}
