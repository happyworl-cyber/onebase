'use client'

/**
 * `/platform/pg-pools` —— M2 自助开通向导：超管的 PG 服务器池管理。
 *
 * 鉴权：仅平台超管（路由层 + 后端 handler 双 check）。
 *
 * 业务定位：超管在这里注册"可分配的 PG 实例"——每条记录是一台
 * 已经部署好的 PG 服务器 + 一对 admin 凭据。普通用户走
 * `/workspace/provision` 时只能从 is_active=true 的池里选一台，由
 * 后端用 admin 凭据帮他在那台机器上 CREATE DATABASE。
 *
 * 软删除：`is_active=false` 只让 wizard 不再列出这条；已经从这台 PG
 * provisioned 出去的项目继续可用。
 */

import { useEffect, useState } from 'react'
import { pgPoolAPI, type PgPoolAdminEntry, type CreatePgPoolBody } from '@/lib/api'
import { useTranslations } from 'next-intl'
import { useNotification } from '@/hooks/useNotification'
import { closeOnBackdropPress } from '@/lib/utils'

interface DrawerState {
  mode: 'create' | 'edit'
  editingId: number | null
  form: {
    name: string
    db_host: string
    db_port: string
    admin_user: string
    admin_password: string
    note: string
    is_active: boolean
  }
}

const EMPTY_FORM: DrawerState['form'] = {
  name: '',
  db_host: '',
  db_port: '5432',
  admin_user: 'postgres',
  admin_password: '',
  note: '',
  is_active: true,
}

export default function PlatformPgPoolsPage() {
  const t = useTranslations('platformPgPools')
  const notify = useNotification()
  const [pools, setPools] = useState<PgPoolAdminEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [testResults, setTestResults] = useState<Record<number, { ok: boolean; msg?: string; loading?: boolean }>>({})
  const [drawer, setDrawer] = useState<DrawerState | null>(null)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const res = await pgPoolAPI.listAll()
      setPools(res.data)
    } catch (err: any) {
      notify.error(err)
      setPools(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openCreate = () => {
    setDrawer({ mode: 'create', editingId: null, form: { ...EMPTY_FORM } })
  }

  const openEdit = (p: PgPoolAdminEntry) => {
    setDrawer({
      mode: 'edit',
      editingId: p.id,
      form: {
        name: p.name,
        db_host: p.db_host,
        db_port: String(p.db_port),
        admin_user: p.admin_user,
        admin_password: '', // 改密码必须显式输入；空 = 不改
        note: p.note ?? '',
        is_active: p.is_active,
      },
    })
  }

  const handleSave = async () => {
    if (!drawer) return
    const { form, mode, editingId } = drawer
    const port = parseInt(form.db_port, 10)
    if (!form.name.trim() || !form.db_host.trim() || !form.admin_user.trim()) {
      notify.warning(t('warnRequired'))
      return
    }
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      notify.warning(t('warnPort'))
      return
    }
    if (mode === 'create' && !form.admin_password) {
      notify.warning(t('warnPassword'))
      return
    }

    setSaving(true)
    try {
      if (mode === 'create') {
        const body: CreatePgPoolBody = {
          name: form.name.trim(),
          db_host: form.db_host.trim(),
          db_port: port,
          admin_user: form.admin_user.trim(),
          admin_password: form.admin_password,
          note: form.note.trim() || null,
        }
        await pgPoolAPI.create(body)
        notify.success(t('created', { name: body.name }))
      } else if (editingId !== null) {
        await pgPoolAPI.update(editingId, {
          name: form.name.trim(),
          db_host: form.db_host.trim(),
          db_port: port,
          admin_user: form.admin_user.trim(),
          // 空字符串 → 后端不改密码
          admin_password: form.admin_password || undefined,
          note: form.note.trim() || null,
          is_active: form.is_active,
        })
        notify.success(t('updated', { id: editingId }))
      }
      setDrawer(null)
      await load()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async (id: number) => {
    setTestResults((s) => ({ ...s, [id]: { ok: false, loading: true } }))
    try {
      const res = await pgPoolAPI.test(id)
      setTestResults((s) => ({ ...s, [id]: { ok: res.data.ok, msg: res.data.error } }))
    } catch (err: any) {
      setTestResults((s) => ({
        ...s,
        [id]: { ok: false, msg: err?.response?.data?.error || err?.message || t('testFailed') },
      }))
    }
  }

  const handleDelete = async (p: PgPoolAdminEntry) => {
    const ok = window.confirm(
      t('confirmDisable', { name: p.name }),
    )
    if (!ok) return
    try {
      await pgPoolAPI.remove(p.id)
      notify.success(t('disabled', { name: p.name }))
      await load()
    } catch (err: any) {
      notify.error(err)
    }
  }

  return (
    <div className="w-full space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {t('subtitle')}
          </p>
        </div>
        <button onClick={openCreate} className="btn-primary">
          <i className="fas fa-plus mr-2"></i>
          {t('registerBtn')}
        </button>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500 tracking-wider">
            <tr>
              <th className="px-5 py-3 text-left font-medium">{t('colName')}</th>
              <th className="px-5 py-3 text-left font-medium">{t('colHost')}</th>
              <th className="px-5 py-3 text-left font-medium">{t('colAdminUser')}</th>
              <th className="px-5 py-3 text-left font-medium">{t('colNote')}</th>
              <th className="px-5 py-3 text-left font-medium">{t('colStatus')}</th>
              <th className="px-5 py-3 text-left font-medium">{t('colConn')}</th>
              <th className="px-5 py-3 text-right font-medium">{t('colActions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && (
              <tr>
                <td colSpan={7} className="px-5 py-12 text-center text-gray-400">
                  <i className="fas fa-spinner fa-spin mr-2"></i>{t('loading')}
                </td>
              </tr>
            )}
            {!loading && (pools?.length ?? 0) === 0 && (
              <tr>
                <td colSpan={7} className="px-5 py-12 text-center text-gray-400">
                  {t('empty')}
                </td>
              </tr>
            )}
            {!loading &&
              pools?.map((p) => {
                const tr = testResults[p.id]
                return (
                  <tr key={p.id} className="hover:bg-gray-50/50">
                    <td className="px-5 py-3 font-medium text-gray-900">{p.name}</td>
                    <td className="px-5 py-3 font-mono text-xs text-gray-700">
                      {p.db_host}:{p.db_port}
                    </td>
                    <td className="px-5 py-3 text-gray-700">{p.admin_user}</td>
                    <td className="px-5 py-3 text-gray-500 text-xs max-w-xs truncate" title={p.note ?? ''}>
                      {p.note || '—'}
                    </td>
                    <td className="px-5 py-3">
                      {p.is_active ? (
                        <span className="px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                          active
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-200 text-gray-600">
                          inactive
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {tr === undefined ? (
                        <span className="text-xs text-gray-400">{t('untested')}</span>
                      ) : tr.loading ? (
                        <span className="text-xs text-gray-500">
                          <i className="fas fa-spinner fa-spin mr-1"></i>{t('testing')}
                        </span>
                      ) : tr.ok ? (
                        <span className="text-xs text-green-600">
                          <i className="fas fa-check-circle mr-1"></i>{t('connOk')}
                        </span>
                      ) : (
                        <span className="text-xs text-red-600 truncate max-w-[200px]" title={tr.msg}>
                          <i className="fas fa-times-circle mr-1"></i>{t('connFail')}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right space-x-3">
                      <button
                        onClick={() => handleTest(p.id)}
                        className="text-xs text-blue-600 hover:text-blue-800"
                      >
                        <i className="fas fa-plug mr-1"></i>{t('test')}
                      </button>
                      <button
                        onClick={() => openEdit(p)}
                        className="text-xs text-gray-600 hover:text-gray-900"
                      >
                        <i className="fas fa-pen mr-1"></i>{t('edit')}
                      </button>
                      {p.is_active && (
                        <button
                          onClick={() => handleDelete(p)}
                          className="text-xs text-red-600 hover:text-red-800"
                        >
                          <i className="fas fa-power-off mr-1"></i>{t('disable')}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
          </tbody>
        </table>
      </div>

      {/* 添加 / 编辑 drawer */}
      {drawer && (
        <div
          className="fixed inset-0 bg-black/40 z-40 flex items-center justify-center"
          onMouseDown={closeOnBackdropPress(() => { if (!saving) setDrawer(null) })}
        >
          <div
            className="bg-white w-full max-w-lg rounded-xl shadow-xl p-6 m-4"
          >
            <h3 className="text-lg font-semibold text-gray-900 mb-1">
              {drawer.mode === 'create' ? t('createTitle') : t('editTitle', { id: drawer.editingId })}
            </h3>
            <p className="text-sm text-gray-500 mb-4">
              {drawer.mode === 'create'
                ? t('createHint')
                : t('editHint')}
            </p>

            <div className="space-y-3">
              <Field label={t('nameLabel')} required>
                <input
                  type="text"
                  value={drawer.form.name}
                  onChange={(e) =>
                    setDrawer({ ...drawer, form: { ...drawer.form, name: e.target.value } })
                  }
                  className="w-full input-base"
                  placeholder={t('namePlaceholder')}
                />
              </Field>

              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <Field label="db_host" required>
                    <input
                      type="text"
                      value={drawer.form.db_host}
                      onChange={(e) =>
                        setDrawer({ ...drawer, form: { ...drawer.form, db_host: e.target.value } })
                      }
                      className="w-full input-base"
                      placeholder="rm-xxx.mysql.rds.aliyuncs.com"
                    />
                  </Field>
                </div>
                <Field label="db_port" required>
                  <input
                    type="number"
                    value={drawer.form.db_port}
                    onChange={(e) =>
                      setDrawer({ ...drawer, form: { ...drawer.form, db_port: e.target.value } })
                    }
                    className="w-full input-base"
                  />
                </Field>
              </div>

              <Field label="admin_user" required>
                <input
                  type="text"
                  value={drawer.form.admin_user}
                  onChange={(e) =>
                    setDrawer({ ...drawer, form: { ...drawer.form, admin_user: e.target.value } })
                  }
                  className="w-full input-base"
                />
              </Field>

              <Field
                label={
                  drawer.mode === 'edit'
                    ? t('pwEditLabel')
                    : 'admin_password'
                }
                required={drawer.mode === 'create'}
              >
                <input
                  type="password"
                  value={drawer.form.admin_password}
                  onChange={(e) =>
                    setDrawer({
                      ...drawer,
                      form: { ...drawer.form, admin_password: e.target.value },
                    })
                  }
                  className="w-full input-base"
                  placeholder={drawer.mode === 'edit' ? t('pwEditPlaceholder') : ''}
                  autoComplete="new-password"
                />
              </Field>

              <Field label={t('noteLabel')}>
                <textarea
                  value={drawer.form.note}
                  onChange={(e) =>
                    setDrawer({ ...drawer, form: { ...drawer.form, note: e.target.value } })
                  }
                  rows={2}
                  className="w-full input-base"
                  placeholder={t('notePlaceholder')}
                />
              </Field>

              {drawer.mode === 'edit' && (
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={drawer.form.is_active}
                    onChange={(e) =>
                      setDrawer({
                        ...drawer,
                        form: { ...drawer.form, is_active: e.target.checked },
                      })
                    }
                  />
                  {t('isActiveHint')}
                </label>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-100">
              <button
                onClick={() => !saving && setDrawer(null)}
                disabled={saving}
                className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                {t('cancel')}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="btn-primary disabled:opacity-50"
              >
                {saving ? t('saving') : t('save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1.5">
        {label}
        {required && <span className="text-red-500 ml-1">*</span>}
      </label>
      {children}
    </div>
  )
}
