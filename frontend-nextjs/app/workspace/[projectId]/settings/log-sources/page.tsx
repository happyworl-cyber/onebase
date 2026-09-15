'use client'

/**
 * `/workspace/[projectId]/settings/log-sources` —— 项目云日志源。
 * 密钥在凭证管理（aliyun_ak），本页只引用 credential_id。
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import {
  projectLogSourceAPI,
  wfCredentialAPI,
  type ProjectLogSource,
  type WfCredential,
} from '@/lib/api'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import { useNotification } from '@/hooks/useNotification'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'

interface SourceForm {
  editing: ProjectLogSource | null
  name: string
  credential_id: number | ''
  region: string
  sls_project: string
  logstore: string
  endpoint: string
  query_prefix: string
}

const EMPTY: SourceForm = {
  editing: null,
  name: '',
  credential_id: '',
  region: 'cn-hangzhou',
  sls_project: '',
  logstore: '',
  endpoint: '',
  query_prefix: '',
}

export default function ProjectLogSourcesPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const caps = useCurrentProjectCapabilities()
  const notify = useNotification()

  const [sources, setSources] = useState<ProjectLogSource[] | null>(null)
  const [creds, setCreds] = useState<WfCredential[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<SourceForm | null>(null)
  const [saving, setSaving] = useState(false)
  const [testingId, setTestingId] = useState<number | null>(null)

  const akCreds = creds.filter((c) => c.kind === 'aliyun_ak')

  const load = async () => {
    setLoading(true)
    try {
      const [srcRes, credRes] = await Promise.all([
        projectLogSourceAPI.list(projectId),
        wfCredentialAPI.list(projectId),
      ])
      setSources(srcRes.data)
      setCreds(credRes.data)
    } catch (err: unknown) {
      notify.error(err)
      setSources(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (Number.isFinite(projectId) && caps.canManageSecurity) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, caps.canManageSecurity])

  const handleSave = async () => {
    if (!form) return
    if (!form.name.trim()) return notify.warning('请填写名称')
    if (form.credential_id === '') return notify.warning('请选择阿里云 AccessKey 凭证')
    if (!form.region.trim() || !form.sls_project.trim() || !form.logstore.trim()) {
      return notify.warning('地域、SLS Project、Logstore 均为必填')
    }
    setSaving(true)
    try {
      const body = {
        name: form.name.trim(),
        provider: 'aliyun_sls' as const,
        credential_id: Number(form.credential_id),
        region: form.region.trim(),
        sls_project: form.sls_project.trim(),
        logstore: form.logstore.trim(),
        endpoint: form.endpoint.trim() || null,
        query_prefix: form.query_prefix.trim() || null,
      }
      if (form.editing) {
        const res = await projectLogSourceAPI.update(projectId, form.editing.id, body)
        setSources((prev) => prev?.map((s) => (s.id === res.data.id ? res.data : s)) ?? null)
        notify.success(`已更新 ${res.data.name}`)
      } else {
        const res = await projectLogSourceAPI.create(projectId, body)
        setSources((prev) => (prev ? [...prev, res.data] : [res.data]))
        notify.success(`已新建 ${res.data.name}`)
      }
      setForm(null)
    } catch (err: unknown) {
      notify.error(err)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (s: ProjectLogSource) => {
    if (!window.confirm(`确认删除云日志源 ${s.name} 吗？`)) return
    try {
      await projectLogSourceAPI.remove(projectId, s.id)
      setSources((prev) => prev?.filter((x) => x.id !== s.id) ?? null)
      notify.success(`已删除 ${s.name}`)
    } catch (err: unknown) {
      notify.error(err)
    }
  }

  const handleTest = async (s: ProjectLogSource) => {
    setTestingId(s.id)
    try {
      const res = await projectLogSourceAPI.test(projectId, s.id)
      notify.success(`连通正常，最近 1 分钟 ${res.data.count} 条`)
    } catch (err: unknown) {
      notify.error(err)
    } finally {
      setTestingId(null)
    }
  }

  if (!caps.canManageSecurity) {
    return <ForbiddenPlaceholder reason="云日志源需要项目 admin 或 owner 角色（或平台超管）" />
  }

  return (
    <div className="p-6 max-w-5xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900">云日志源</h1>
          <p className="text-sm text-gray-500 mt-1">
            配置阿里云 SLS Project / Logstore，AccessKey 放在{' '}
            <Link
              href={`/workspace/${projectId}/settings/credentials`}
              className="text-blue-600 hover:underline"
            >
              凭证管理
            </Link>
            （类型「阿里云 AccessKey」）。查询入口在诊断与监控 → 云日志。
          </p>
        </div>
        <button
          onClick={() => setForm({ ...EMPTY })}
          className="btn-primary flex-shrink-0 whitespace-nowrap"
        >
          <i className="fas fa-plus mr-2" />
          新建日志源
        </button>
      </div>

      {akCreds.length === 0 && !loading && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
          还没有阿里云 AccessKey 凭证。请先到{' '}
          <Link
            href={`/workspace/${projectId}/settings/credentials`}
            className="underline"
          >
            设置 → 凭证管理
          </Link>{' '}
          新建类型为「阿里云 AccessKey」的凭证。
        </div>
      )}

      {loading && (
        <div className="py-16 text-center text-gray-400">
          <i className="fas fa-spinner fa-spin mr-2" />
          加载中...
        </div>
      )}

      {!loading && (sources?.length ?? 0) === 0 && (
        <div className="bg-white border border-gray-200 rounded-xl py-12 text-center text-gray-400">
          暂无日志源。
        </div>
      )}

      {!loading && (sources?.length ?? 0) > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {sources?.map((s) => (
            <div key={s.id} className="border border-gray-200 rounded-lg p-4 bg-white">
              <div className="text-sm font-medium text-gray-800">{s.name}</div>
              <div className="mt-2 space-y-1 text-xs text-gray-500 font-mono">
                <div>{s.region} / {s.sls_project} / {s.logstore}</div>
                <div>凭证：{s.credential_name}</div>
                {s.query_prefix && <div>前缀：{s.query_prefix}</div>}
              </div>
              <div className="mt-3 pt-3 border-t border-gray-100 flex items-center justify-end gap-3 text-xs">
                <button
                  onClick={() => handleTest(s)}
                  disabled={testingId === s.id}
                  className="text-blue-600 hover:text-blue-800 disabled:opacity-50"
                >
                  {testingId === s.id ? '测试中...' : '测试连接'}
                </button>
                <button
                  onClick={() =>
                    setForm({
                      editing: s,
                      name: s.name,
                      credential_id: s.credential_id,
                      region: s.region,
                      sls_project: s.sls_project,
                      logstore: s.logstore,
                      endpoint: s.endpoint ?? '',
                      query_prefix: s.query_prefix ?? '',
                    })
                  }
                  className="text-blue-600 hover:text-blue-800"
                >
                  编辑
                </button>
                <button
                  onClick={() => handleDelete(s)}
                  className="text-red-600 hover:text-red-800"
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {form && (
        <div
          className="fixed inset-0 bg-black/40 z-40 flex items-center justify-center p-4"
          onClick={() => !saving && setForm(null)}
        >
          <div
            className="bg-white w-full max-w-lg rounded-xl shadow-xl p-6 max-h-[88vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-gray-900 mb-4">
              {form.editing ? `编辑 ${form.editing.name}` : '新建日志源'}
            </h3>
            <div className="space-y-4">
              <label className="block">
                <span className="block text-sm font-medium text-gray-700 mb-1.5">名称 *</span>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full input-base"
                  placeholder="Access / 工作流"
                />
              </label>
              <label className="block">
                <span className="block text-sm font-medium text-gray-700 mb-1.5">凭证 *</span>
                <select
                  value={form.credential_id}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      credential_id: e.target.value ? Number(e.target.value) : '',
                    })
                  }
                  className="w-full input-base"
                >
                  <option value="">选择阿里云 AccessKey</option>
                  {akCreds.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="block text-sm font-medium text-gray-700 mb-1.5">地域 *</span>
                <input
                  value={form.region}
                  onChange={(e) => setForm({ ...form, region: e.target.value })}
                  className="w-full input-base font-mono"
                  placeholder="cn-hangzhou"
                />
              </label>
              <label className="block">
                <span className="block text-sm font-medium text-gray-700 mb-1.5">SLS Project *</span>
                <input
                  value={form.sls_project}
                  onChange={(e) => setForm({ ...form, sls_project: e.target.value })}
                  className="w-full input-base font-mono"
                />
              </label>
              <label className="block">
                <span className="block text-sm font-medium text-gray-700 mb-1.5">Logstore *</span>
                <input
                  value={form.logstore}
                  onChange={(e) => setForm({ ...form, logstore: e.target.value })}
                  className="w-full input-base font-mono"
                />
              </label>
              <label className="block">
                <span className="block text-sm font-medium text-gray-700 mb-1.5">
                  Endpoint（可选，默认公网）
                </span>
                <input
                  value={form.endpoint}
                  onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
                  className="w-full input-base font-mono"
                  placeholder="https://project.region.log.aliyuncs.com"
                />
              </label>
              <label className="block">
                <span className="block text-sm font-medium text-gray-700 mb-1.5">
                  查询前缀（可选）
                </span>
                <input
                  value={form.query_prefix}
                  onChange={(e) => setForm({ ...form, query_prefix: e.target.value })}
                  className="w-full input-base font-mono"
                  placeholder="app:pay"
                />
              </label>
            </div>
            <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-100">
              <button
                onClick={() => setForm(null)}
                disabled={saving}
                className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                取消
              </button>
              <button onClick={handleSave} disabled={saving} className="btn-primary disabled:opacity-50">
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
