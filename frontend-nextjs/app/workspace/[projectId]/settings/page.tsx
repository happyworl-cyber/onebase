'use client'

/**
 * `/workspace/[projectId]/settings` —— 项目信息编辑（W4 / PASE Stage E）。
 *
 * 鉴权：owner+（含平台超管）。后端 PATCH /api/projects/:id 走
 * `permissions::require_tenant_owner`。前端用 `canManageProjectSettings`
 * 判断是否渲染表单——非 owner 看到 ForbiddenPlaceholder。
 *
 * 允许编辑：name / contact_email / workspace_config (JSON)。
 * **明确不允许**：slug / kind / status / db_*（这些属于平台超管的
 * `/api/admin/tenants/:id` 接口；本页若传入会被后端 400）。
 */

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import api, { projectAPI } from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import { useNotification } from '@/hooks/useNotification'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'

interface ProjectDetail {
  id: number
  name: string
  slug: string
  kind: string
  status: string
  contact_email: string | null
  workspace_config: Record<string, unknown> | null
  user_role: string
}

export default function ProjectSettingsPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const caps = useCurrentProjectCapabilities()
  const setCurrentProject = useAppStore((s) => s.setCurrentProject)
  const notify = useNotification()

  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // 表单本地状态——和远端分开，便于实现"未保存就不动 currentProject"
  const [name, setName] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [configText, setConfigText] = useState('')
  const [configError, setConfigError] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const load = async () => {
    try {
      const res = await api.get<ProjectDetail>(`/api/projects/${projectId}`)
      setProject(res.data)
      setName(res.data.name ?? '')
      setContactEmail(res.data.contact_email ?? '')
      setConfigText(
        res.data.workspace_config
          ? JSON.stringify(res.data.workspace_config, null, 2)
          : '',
      )
    } catch (err: any) {
      notify.error(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (Number.isFinite(projectId)) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // 表单是否有变化——决定保存按钮 disable
  const dirty =
    !!project &&
    (name !== (project.name ?? '') ||
      contactEmail !== (project.contact_email ?? '') ||
      configText !==
        (project.workspace_config
          ? JSON.stringify(project.workspace_config, null, 2)
          : ''))

  const handleSave = async () => {
    if (!project) return
    if (name.trim().length === 0) {
      notify.warning('项目名不能为空')
      return
    }

    // 解析 workspace_config——空字符串表示"不动这个字段"
    let parsedConfig: Record<string, unknown> | null | undefined
    if (configText.trim() === '') {
      parsedConfig = undefined // 不在 payload 里出现
    } else {
      try {
        parsedConfig = JSON.parse(configText)
        setConfigError(null)
      } catch (err: any) {
        setConfigError(`JSON 解析错误：${err.message ?? '未知错误'}`)
        return
      }
    }

    const body: Parameters<typeof projectAPI.patch>[1] = {}
    if (name !== project.name) body.name = name.trim()
    if (contactEmail !== (project.contact_email ?? '')) {
      body.contact_email = contactEmail
    }
    if (parsedConfig !== undefined) body.workspace_config = parsedConfig

    if (Object.keys(body).length === 0) {
      notify.warning('没有可保存的改动')
      return
    }

    setSaving(true)
    try {
      const res = await projectAPI.patch(projectId, body)
      const updated = res.data as ProjectDetail
      setProject(updated)
      // 同步 Zustand 里的 currentProject，让 topbar 即时跟新名字。
      // 注意：PATCH 返回 payload 不含 primary_connection，保留现有 store 里的连接信息。
      setCurrentProject({
        ...(useAppStore.getState().currentProject ?? {}),
        ...updated,
      })
      notify.success('项目信息已保存')
    } catch (err: any) {
      notify.error(err)
    } finally {
      setSaving(false)
    }
  }

  if (!caps.canManageProjectSettings) {
    return (
      <ForbiddenPlaceholder reason="项目信息编辑需要 owner 角色（或平台超管）" />
    )
  }

  if (loading || !project) {
    return (
      <div className="p-12 text-center text-gray-400">
        <i className="fas fa-spinner fa-spin text-2xl"></i>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">项目信息</h1>
        <p className="text-sm text-gray-500 mt-1">
          只有 owner 能改本页内容。slug / 状态 / 数据库连接的归属调整等
          平台级操作请联系平台管理员（走 <code className="text-xs bg-gray-100 px-1 rounded">/platform</code>）。
        </p>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
        {/* 基础字段 */}
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              项目名 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full input-base"
              placeholder="给项目起一个易识别的名字"
              maxLength={200}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              联系邮箱
              <span className="ml-2 text-xs text-gray-400 font-normal">
                （用于运维通知；留空清除）
              </span>
            </label>
            <input
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              className="w-full input-base"
              placeholder="ops@yourcompany.com"
              maxLength={255}
            />
          </div>
        </div>

        {/* 只读字段：明确告诉用户"想改这个？联系超管"——避免静默 disable 让用户疑惑 */}
        <div className="p-5 space-y-3 bg-gray-50/50">
          <h3 className="text-xs uppercase tracking-wider text-gray-400 font-medium">
            只读（平台超管路径才能改）
          </h3>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-xs text-gray-500 mb-0.5">slug</div>
              <code className="text-gray-700 font-mono text-xs">{project.slug}</code>
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-0.5">类型</div>
              <span className="text-gray-700">{project.kind}</span>
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-0.5">状态</div>
              <span
                className={`px-2 py-0.5 rounded text-xs font-medium ${
                  project.status === 'active'
                    ? 'bg-green-100 text-green-800'
                    : 'bg-gray-200 text-gray-700'
                }`}
              >
                {project.status}
              </span>
            </div>
          </div>
        </div>

        {/* 高级：workspace_config JSON */}
        <div className="p-5 space-y-3">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex items-center gap-2 text-sm text-gray-700 hover:text-gray-900"
          >
            <i
              className={`fas fa-chevron-${showAdvanced ? 'down' : 'right'} text-xs`}
            ></i>
            <span className="font-medium">高级：workspace_config (JSON)</span>
          </button>
          {showAdvanced && (
            <div>
              <textarea
                value={configText}
                onChange={(e) => {
                  setConfigText(e.target.value)
                  setConfigError(null)
                }}
                rows={10}
                spellCheck={false}
                className="w-full px-3 py-2 text-xs font-mono border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder='{ "key": "value" }'
              />
              {configError && (
                <p className="mt-2 text-xs text-red-600">{configError}</p>
              )}
              <p className="mt-2 text-xs text-gray-500">
                空字符串 = 不修改本字段；想清空请改成{' '}
                <code className="bg-gray-100 px-1 rounded">null</code>。
              </p>
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <div className="p-5 flex items-center justify-end gap-3 bg-gray-50/30">
          <button
            type="button"
            onClick={() => {
              if (!project) return
              setName(project.name)
              setContactEmail(project.contact_email ?? '')
              setConfigText(
                project.workspace_config
                  ? JSON.stringify(project.workspace_config, null, 2)
                  : '',
              )
              setConfigError(null)
            }}
            disabled={!dirty || saving}
            className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            撤销改动
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || saving || name.trim().length === 0}
            className="btn-primary disabled:opacity-50"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
