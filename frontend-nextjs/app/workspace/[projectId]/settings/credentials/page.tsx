'use client'

/**
 * `/workspace/[projectId]/settings/credentials` —— 项目级凭证管理。
 * 密钥只写不回显；工作流以 {{cred.名称.字段}} / cred.get 或节点 credential_id 引用。
 */

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { wfCredentialAPI, type WfCredential, type WfCredentialKind } from '@/lib/api'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import { useNotification } from '@/hooks/useNotification'
import { useTranslations } from 'next-intl'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'
import { closeOnBackdropPress } from '@/lib/utils'

interface CredForm {
  editing: WfCredential | null
  name: string
  kind: WfCredentialKind
  username: string
  header_name: string
  secret: string
  description: string
}

const EMPTY_FORM: CredForm = {
  editing: null,
  name: '',
  kind: 'basic',
  username: '',
  header_name: '',
  secret: '',
  description: '',
}

function kindLabel(kind: WfCredentialKind): string {
  if (kind === 'bearer') return 'Bearer Token'
  if (kind === 'api_key') return 'API Key'
  if (kind === 'aliyun_ak') return 'kindAliyun'
  return 'kindBasic'
}

export default function ProjectCredentialsPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const caps = useCurrentProjectCapabilities()
  const t = useTranslations('wsCredentials')
  const notify = useNotification()

  const [credentials, setCredentials] = useState<WfCredential[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<CredForm | null>(null)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const res = await wfCredentialAPI.list(projectId)
      setCredentials(res.data)
    } catch (err: unknown) {
      notify.error(err)
      setCredentials(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (Number.isFinite(projectId) && caps.canManageMembers) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, caps.canManageMembers])

  const handleSave = async () => {
    if (!form) return
    if (!form.name.trim()) return notify.warning(t('errName'))
    if ((form.kind === 'basic' || form.kind === 'aliyun_ak') && !form.username.trim()) {
      return notify.warning(
        form.kind === 'aliyun_ak' ? t('errAkId') : t('errBasicUser'),
      )
    }
    if (!form.editing && !form.secret) return notify.warning(t('errSecret'))
    setSaving(true)
    try {
      const body = {
        name: form.name.trim(),
        kind: form.kind,
        username:
          form.kind === 'basic' || form.kind === 'aliyun_ak' ? form.username.trim() : null,
        header_name: form.kind === 'api_key' ? form.header_name.trim() || null : null,
        secret: form.secret || null,
        description: form.description.trim() || null,
      }
      if (form.editing) {
        const res = await wfCredentialAPI.update(projectId, form.editing.id, body)
        setCredentials((prev) => prev?.map((c) => (c.id === res.data.id ? res.data : c)) ?? null)
        notify.success(t('updated', { name: res.data.name }))
      } else {
        const res = await wfCredentialAPI.create(projectId, body)
        setCredentials((prev) => (prev ? [...prev, res.data] : [res.data]))
        notify.success(t('created', { name: res.data.name }))
      }
      setForm(null)
    } catch (err: unknown) {
      notify.error(err)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (c: WfCredential) => {
    if (!window.confirm(t('confirmDelete', { name: c.name }))) return
    try {
      await wfCredentialAPI.remove(projectId, c.id)
      setCredentials((prev) => prev?.filter((x) => x.id !== c.id) ?? null)
      notify.success(t('deleted', { name: c.name }))
    } catch (err: unknown) {
      notify.error(err)
    }
  }

  if (!caps.canManageMembers) {
    return <ForbiddenPlaceholder reason={t('forbidden')} />
  }

  return (
    <div className="p-6 max-w-5xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {t.rich('subtitle', {
              c1: () => <code className="px-1 bg-gray-100 rounded">{'{{cred.name.password}}'}</code>,
              c2: () => <code className="px-1 bg-gray-100 rounded">{'{{cred.name.token}}'}</code>,
              c3: () => <code className="px-1 bg-gray-100 rounded">{'{{cred.name.api_key}}'}</code>,
              c4: () => <code className="px-1 bg-gray-100 rounded">{'cred.get("name", "field")'}</code>,
            })}
          </p>
        </div>
        <button
          onClick={() => setForm(EMPTY_FORM)}
          className="btn-primary flex-shrink-0 whitespace-nowrap"
        >
          <i className="fas fa-plus mr-2" />
          {t('newCred')}
        </button>
      </div>

      {loading && (
        <div className="py-16 text-center text-gray-400">
          <i className="fas fa-spinner fa-spin mr-2" />
          {t('loading')}
        </div>
      )}

      {!loading && (credentials?.length ?? 0) === 0 && (
        <div className="bg-white border border-gray-200 rounded-xl py-12 text-center text-gray-400">
          {t('empty')}
        </div>
      )}

      {!loading && (credentials?.length ?? 0) > 0 && (
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
                    <div className="text-[11px] text-gray-400">{t(kindLabel(c.kind))}</div>
                  </div>
                </div>
              </div>
              <div className="mt-3 space-y-1 text-xs">
                {(c.kind === 'basic' || c.kind === 'aliyun_ak') && (
                  <div className="flex justify-between">
                    <span className="text-gray-400">
                      {c.kind === 'aliyun_ak' ? t('accessKeyId') : t('username')}
                    </span>
                    <span className="font-mono text-gray-600">{c.username || '—'}</span>
                  </div>
                )}
                {c.kind === 'api_key' && (
                  <div className="flex justify-between">
                    <span className="text-gray-400">{t('header')}</span>
                    <span className="font-mono text-gray-600">{c.header_name || 'X-API-Key'}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-gray-400">
                    {c.kind === 'bearer'
                      ? 'Token'
                      : c.kind === 'api_key'
                        ? 'API Key'
                        : c.kind === 'aliyun_ak'
                          ? 'AccessKeySecret'
                          : t('password')}
                  </span>
                  <span className="font-mono text-gray-400">••••••••</span>
                </div>
              </div>
              <div className="mt-3 pt-3 border-t border-gray-100 flex items-center justify-between">
                <span className="text-[11px] text-gray-400 flex items-center gap-1">
                  <i className="fas fa-link text-[9px]" />
                  {t('refCount', { n: c.ref_count })}
                </span>
                <span className="whitespace-nowrap">
                  <button
                    onClick={() =>
                      setForm({
                        editing: c,
                        name: c.name,
                        kind: c.kind,
                        username: c.username ?? '',
                        header_name: c.header_name ?? '',
                        secret: '',
                        description: c.description ?? '',
                      })
                    }
                    className="text-blue-600 hover:text-blue-800 text-xs mr-3"
                  >
                    {t('edit')}
                  </button>
                  <button
                    onClick={() => handleDelete(c)}
                    className="text-red-600 hover:text-red-800 text-xs"
                  >
                    {t('delete')}
                  </button>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {form && (
        <div
          className="fixed inset-0 bg-black/40 z-40 flex items-center justify-center p-4"
          onMouseDown={closeOnBackdropPress(() => { if (!saving) setForm(null) })}
        >
          <div
            className="bg-white w-full max-w-lg rounded-xl shadow-xl p-6 max-h-[88vh] overflow-y-auto"
          >
            <h3 className="text-lg font-semibold text-gray-900 mb-4">
              {form.editing ? t('editTitle', { name: form.editing.name }) : t('createTitle')}
            </h3>
            <div className="space-y-4">
              <label className="block">
                <span className="block text-sm font-medium text-gray-700 mb-1.5">
                  {t('nameLabel')} <span className="text-red-500">*</span>
                </span>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full input-base"
                  placeholder={t('phName')}
                  autoFocus
                />
              </label>
              <label className="block">
                <span className="block text-sm font-medium text-gray-700 mb-1.5">
                  {t('typeLabel')} <span className="text-red-500">*</span>
                </span>
                <select
                  value={form.kind}
                  onChange={(e) => setForm({ ...form, kind: e.target.value as WfCredentialKind })}
                  className="w-full input-base"
                >
                  <option value="basic">{t('typeBasic')}</option>
                  <option value="bearer">Bearer Token</option>
                  <option value="api_key">API Key</option>
                  <option value="aliyun_ak">{t('typeAliyun')}</option>
                </select>
              </label>
              {(form.kind === 'basic' || form.kind === 'aliyun_ak') && (
                <label className="block">
                  <span className="block text-sm font-medium text-gray-700 mb-1.5">
                    {form.kind === 'aliyun_ak' ? t('accessKeyId') : t('username')}{' '}
                    <span className="text-red-500">*</span>
                  </span>
                  <input
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                    className="w-full input-base font-mono"
                    placeholder={form.kind === 'aliyun_ak' ? 'LTAI5t...' : 'app_ro'}
                  />
                </label>
              )}
              {form.kind === 'api_key' && (
                <label className="block">
                  <span className="block text-sm font-medium text-gray-700 mb-1.5">{t('headerNameLabel')}</span>
                  <input
                    value={form.header_name}
                    onChange={(e) => setForm({ ...form, header_name: e.target.value })}
                    className="w-full input-base font-mono"
                    placeholder="X-API-Key"
                  />
                </label>
              )}
              <label className="block">
                <span className="block text-sm font-medium text-gray-700 mb-1.5">
                  {form.kind === 'bearer'
                    ? 'Token'
                    : form.kind === 'api_key'
                      ? 'API Key'
                      : form.kind === 'aliyun_ak'
                        ? 'AccessKeySecret'
                        : t('password')}
                  {!form.editing && <span className="text-red-500"> *</span>}
                </span>
                <input
                  type="password"
                  value={form.secret}
                  onChange={(e) => setForm({ ...form, secret: e.target.value })}
                  className="w-full input-base font-mono"
                  placeholder={form.editing ? t('phSecretEdit') : t('phSecretNew')}
                  autoComplete="new-password"
                />
              </label>
              <label className="block">
                <span className="block text-sm font-medium text-gray-700 mb-1.5">{t('descLabel')}</span>
                <input
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="w-full input-base"
                  placeholder={t('phDesc')}
                />
              </label>
            </div>
            <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-100">
              <button
                onClick={() => setForm(null)}
                disabled={saving}
                className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                {t('cancel')}
              </button>
              <button onClick={handleSave} disabled={saving} className="btn-primary disabled:opacity-50">
                {saving ? t('saving') : t('save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
