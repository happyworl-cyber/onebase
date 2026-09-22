'use client'

/**
 * `/workspace/[projectId]/events/datasources` —— 工作流「数据源 / 凭证」集成模块。
 *
 * 形态：数据源列表 + 居中弹窗新建/编辑。凭证入口已迁到「设置 → 凭证管理」。
 * 数据源只绑定 basic 凭证；工作流 db 节点可选择数据源覆盖默认绑定库。
 *
 * 鉴权：admin+（含 owner / 平台超管）。后端 `require_tenant_admin`，前端用
 * `canManageEvents`（与集成组其它入口同档）决定是否渲染。
 *
 * 安全模型：凭证密钥加密入库、永不回显（编辑时留空表示保持不变）。
 */

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  wfCredentialAPI,
  wfDatasourceAPI,
  type WfCredential,
  type WfDatasource,
  type WfDatasourceType,
  type WfDatasourceStatus,
} from '@/lib/api'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import { useNotification } from '@/hooks/useNotification'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'
import { closeOnBackdropPress } from '@/lib/utils'

const DS_TYPE_LABELS: Record<WfDatasourceType, string> = {
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
}

const STATUS_META: Record<WfDatasourceStatus, { labelKey: string; cls: string; dot: string }> = {
  connected: { labelKey: 'statusConnected', cls: 'bg-emerald-50 text-emerald-600', dot: 'bg-emerald-500' },
  untested: { labelKey: 'statusUntested', cls: 'bg-gray-100 text-gray-500', dot: 'bg-gray-400' },
  failed: { labelKey: 'statusFailed', cls: 'bg-red-50 text-red-600', dot: 'bg-red-500' },
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

export default function DatasourcesPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const caps = useCurrentProjectCapabilities()
  const t = useTranslations('wsDatasources')
  const notify = useNotification()

  const [datasources, setDatasources] = useState<WfDatasource[] | null>(null)
  const [credentials, setCredentials] = useState<WfCredential[] | null>(null)
  const [loading, setLoading] = useState(true)

  const [dsForm, setDsForm] = useState<DsForm | null>(null)
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

  if (!caps.canManageEvents) {
    return <ForbiddenPlaceholder reason={t('forbidden')} />
  }

  // ── 数据源：保存 ──
  const handleDsSave = async () => {
    if (!dsForm) return
    if (!dsForm.name.trim()) return notify.warning(t('errName'))
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
        notify.success(t('updated', { name: res.data.name }))
      } else {
        const res = await wfDatasourceAPI.create(projectId, body)
        setDatasources((prev) => (prev ? [...prev, res.data] : [res.data]))
        notify.success(t('created', { name: res.data.name }))
      }
      setDsForm(null)
    } catch (err: any) {
      notify.error(err)
    } finally {
      setSaving(false)
    }
  }

  const handleDsDelete = async (d: WfDatasource) => {
    if (!window.confirm(t('confirmDelete', { name: d.name }))) return
    try {
      await wfDatasourceAPI.remove(projectId, d.id)
      setDatasources((prev) => prev?.filter((x) => x.id !== d.id) ?? null)
      notify.success(t('deleted', { name: d.name }))
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
      if (res.data.ok) notify.success(t('testOk', { name: d.name }))
      else notify.warning(t('testFail', { name: d.name, err: res.data.error ?? t('unknownErr') }))
    } catch (err: any) {
      notify.error(err)
    } finally {
      setTestingId(null)
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
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {t.rich('subtitle', {
              code: (c) => <code className="px-1 bg-gray-100 rounded">{c}</code>,
            })}
          </p>
        </div>
        <button
          onClick={() => setDsForm(EMPTY_DS_FORM)}
          className="btn-primary flex-shrink-0 whitespace-nowrap"
        >
          <i className="fas fa-plus mr-2" />
          {t('addDs')}
        </button>
      </div>

      {loading && (
        <div className="py-16 text-center text-gray-400">
          <i className="fas fa-spinner fa-spin mr-2" />{t('loading')}
        </div>
      )}

      {/* ── 数据源列表 ── */}
      {!loading && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500 tracking-wider">
              <tr>
                <th className="px-5 py-3 text-left font-medium">{t('thName')}</th>
                <th className="px-5 py-3 text-left font-medium">{t('thType')}</th>
                <th className="px-5 py-3 text-left font-medium">{t('thConn')}</th>
                <th className="px-5 py-3 text-left font-medium">{t('thCred')}</th>
                <th className="px-5 py-3 text-left font-medium">{t('thStatus')}</th>
                <th className="px-5 py-3 text-left font-medium">{t('thRef')}</th>
                <th className="px-5 py-3 text-right font-medium">{t('thActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(datasources?.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-gray-400">
                    {t('emptyList')}
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
                        {t(st.labelKey)}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs text-gray-600">
                      {d.ref_count > 0 ? t('refCount', { n: d.ref_count }) : '0'}
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
                        {t('edit')}
                      </button>
                      <button
                        onClick={() => handleDsTest(d)}
                        disabled={testingId === d.id}
                        className="text-gray-500 hover:text-gray-700 text-sm mr-3 disabled:opacity-40"
                      >
                        {testingId === d.id ? <i className="fas fa-spinner fa-spin" /> : t('test')}
                      </button>
                      <button
                        onClick={() => handleDsDelete(d)}
                        className="text-red-600 hover:text-red-800 text-sm"
                      >
                        {t('del')}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="px-5 py-3 text-xs text-gray-400 flex items-center gap-1.5 border-t border-gray-100">
            <i className="fas fa-info-circle" />
            {t('footerNote')}
          </p>
        </div>
      )}

      {/* ── 数据源新建/编辑弹窗 ── */}
      {dsForm && (
        <Modal title={dsForm.editing ? t('modalEdit', { name: dsForm.editing.name }) : t('modalNew')} onClose={() => !saving && setDsForm(null)}>
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('fName')} required>
              <input
                value={dsForm.name}
                onChange={(e) => setDsForm({ ...dsForm, name: e.target.value })}
                className="w-full input-base"
                placeholder="hr_db"
                autoFocus
              />
            </Field>
            <Field label={t('fDesc')}>
              <input
                value={dsForm.description}
                onChange={(e) => setDsForm({ ...dsForm, description: e.target.value })}
                className="w-full input-base"
                placeholder={t('phDesc')}
              />
            </Field>
            <Field label={t('fType')} required>
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
            <Field label={t('fCred')}>
              <select
                value={dsForm.credential_id}
                onChange={(e) => setDsForm({ ...dsForm, credential_id: e.target.value })}
                className="w-full input-base"
              >
                <option value="">{t('credNone')}</option>
                {credentials
                  ?.filter((c) => c.kind === 'basic')
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
              <p className="text-[11px] text-gray-400 mt-1">
                {t('credHint')}
                <a
                  className="text-blue-600 hover:underline ml-1"
                  href={`/workspace/${projectId}/settings/credentials`}
                >
                  {t('credManage')}
                </a>
              </p>
            </Field>
            <Field label={t('fHost')} required className="col-span-2">
              <input
                value={dsForm.host}
                onChange={(e) => setDsForm({ ...dsForm, host: e.target.value })}
                className="w-full input-base font-mono"
                placeholder="10.0.2.30"
              />
            </Field>
            <Field label={t('fPort')}>
              <input
                value={dsForm.port}
                onChange={(e) => setDsForm({ ...dsForm, port: e.target.value })}
                className="w-full input-base font-mono"
                placeholder={dsForm.ds_type === 'mysql' ? '3306' : '5432'}
              />
            </Field>
            <Field label={t('fDb')}>
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

    </div>
  )
}

// ── 轻量弹窗 / 表单原子组件 ──

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/40 z-40 flex items-center justify-center p-4" onMouseDown={closeOnBackdropPress(onClose)}>
      <div
        className="bg-white w-full max-w-2xl rounded-xl shadow-xl p-6 max-h-[88vh] overflow-y-auto"
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
  const t = useTranslations('wsDatasources')
  return (
    <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-100">
      <button
        onClick={onCancel}
        disabled={saving}
        className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
      >
        {t('cancel')}
      </button>
      <button onClick={onSave} disabled={saving} className="btn-primary disabled:opacity-50">
        {saving ? t('saving') : t('save')}
      </button>
    </div>
  )
}
