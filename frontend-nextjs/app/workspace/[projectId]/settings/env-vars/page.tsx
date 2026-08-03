'use client'

/**
 * `/workspace/[projectId]/settings/env-vars` —— 项目级环境变量管理。
 *
 * 形态：Windows「环境变量」对话框的页面化——单张三列表格（变量名 / 值明文 / 描述）
 * + 新建 / 行内编辑 / 删除（删除需确认）+ 极简弹窗（变量名 / 变量值 / 描述）。
 *
 * 鉴权：admin+（含 owner / 平台超管）。后端走 `require_tenant_admin`，前端用
 * `canManageMembers`（与成员管理同档）决定是否渲染。
 *
 * 安全模型：值加密入库、本页明文回显（便于确认修改）；工作流执行历史 / debug
 * 输出中变量值自动脱敏为 ***。交互基调对齐成员管理页（同款表格 + 居中弹窗）。
 */

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { projectEnvVarsAPI, type ProjectEnvVar } from '@/lib/api'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import { useNotification } from '@/hooks/useNotification'
import { copyToClipboard } from '@/lib/utils'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'

/** 变量名规则：字母/下划线开头，后续字母数字下划线（与后端校验一致）。 */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 编辑弹窗的三个字段。编辑既有变量时 name 锁定（改名等于删旧建新，规格不需要）。 */
interface EditForm {
  /** 正在编辑的变量；null 表示新建 */
  editing: ProjectEnvVar | null
  name: string
  value: string
  description: string
}

const EMPTY_FORM: EditForm = { editing: null, name: '', value: '', description: '' }

export default function ProjectEnvVarsPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const caps = useCurrentProjectCapabilities()
  const notify = useNotification()

  const [vars, setVars] = useState<ProjectEnvVar[] | null>(null)
  const [loading, setLoading] = useState(true)

  // 弹窗状态：showModal 控制显隐，form 持有正在编辑/新建的字段
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState<EditForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  // 行级删除中标记，避免重复点击
  const [rowDeleting, setRowDeleting] = useState<Record<number, boolean>>({})

  const load = async () => {
    setLoading(true)
    try {
      const res = await projectEnvVarsAPI.list(projectId)
      setVars(res.data)
    } catch (err: any) {
      notify.error(err)
      setVars(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (Number.isFinite(projectId) && caps.canManageMembers) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, caps.canManageMembers])

  // 复制变量值到剪贴板——密钥类长串手选易漏字符，给个一键复制
  const handleCopyValue = async (v: ProjectEnvVar) => {
    const ok = await copyToClipboard(v.value)
    if (ok) notify.success(`已复制 ${v.name} 的值`)
    else notify.warning('当前环境不支持自动复制，请手动选中复制')
  }

  // 打开新建弹窗
  const openCreate = () => {
    setForm(EMPTY_FORM)
    setShowModal(true)
  }

  // 打开编辑弹窗：带入既有值，name 只读。
  // 解密失败的行 value 是占位串（非真实值），编辑时清空强制重填，避免把占位串存回覆盖密文。
  const openEdit = (v: ProjectEnvVar) => {
    setForm({
      editing: v,
      name: v.name,
      value: v.decrypt_error ? '' : v.value,
      description: v.description ?? '',
    })
    if (v.decrypt_error) notify.warning(`${v.name} 当前解密失败，请重新填入真实值`)
    setShowModal(true)
  }

  const closeModal = () => {
    if (saving) return
    setShowModal(false)
    setForm(EMPTY_FORM)
  }

  // 新建模式才校验变量名；值必填；描述可空
  const isCreate = form.editing === null
  const nameValid = !isCreate || NAME_PATTERN.test(form.name.trim())
  const formValid = nameValid && form.value.length > 0

  const handleSave = async () => {
    if (!formValid) {
      notify.warning(
        isCreate && !nameValid
          ? '变量名需以字母或下划线开头，仅含字母、数字、下划线'
          : '变量值不能为空',
      )
      return
    }
    setSaving(true)
    try {
      if (isCreate) {
        const res = await projectEnvVarsAPI.create(projectId, {
          name: form.name.trim(),
          value: form.value,
          description: form.description.trim() || null,
        })
        // 新建追加到列表末尾
        setVars((prev) => (prev ? [...prev, res.data] : [res.data]))
        notify.success(`已新建变量 ${res.data.name}`)
      } else {
        // 后端 PUT 复用 EnvVarRequest 且校验 name，变量名不变也要原样回传
        const res = await projectEnvVarsAPI.update(projectId, form.editing!.id, {
          name: form.editing!.name,
          value: form.value,
          description: form.description.trim() || null,
        })
        // 原地替换
        setVars((prev) => prev?.map((x) => (x.id === res.data.id ? res.data : x)) ?? null)
        notify.success(`已更新变量 ${res.data.name}`)
      }
      setShowModal(false)
      setForm(EMPTY_FORM)
    } catch (err: any) {
      notify.error(err)
    } finally {
      setSaving(false)
    }
  }

  // 弹窗内的键盘交互——对齐 Windows 对话框肌肉记忆：Esc=取消、Enter=确定。
  // 仅在弹窗打开时挂全局监听（与共享 Modal 组件同款做法）。
  useEffect(() => {
    if (!showModal) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeModal()
      } else if (e.key === 'Enter' && formValid && !saving) {
        // 描述等单行输入框回车即提交；避免在 IME 组合输入途中误触发
        if (!e.isComposing) handleSave()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showModal, formValid, saving, form])

  const handleDelete = async (v: ProjectEnvVar) => {
    const ok = window.confirm(
      `确认删除环境变量 ${v.name} 吗？\n` +
        `引用了 {{env.${v.name}}} 或 env.get("${v.name}") 的工作流将读到空值 / nil。`,
    )
    if (!ok) return

    setRowDeleting((s) => ({ ...s, [v.id]: true }))
    try {
      await projectEnvVarsAPI.remove(projectId, v.id)
      setVars((prev) => prev?.filter((x) => x.id !== v.id) ?? null)
      notify.success(`已删除 ${v.name}`)
    } catch (err: any) {
      notify.error(err)
    } finally {
      setRowDeleting((s) => ({ ...s, [v.id]: false }))
    }
  }

  if (!caps.canManageMembers) {
    return <ForbiddenPlaceholder reason="环境变量管理需要项目 admin 或 owner 角色（或平台超管）" />
  }

  return (
    <div data-alt="env-vars-page" className="p-6 max-w-5xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900">环境变量</h1>
          <p className="text-sm text-gray-500 mt-1">
            项目级变量库，供工作流以 <code className="px-1 bg-gray-100 rounded">{'{{env.X}}'}</code> 模板或 Lua{' '}
            <code className="px-1 bg-gray-100 rounded">env.get()</code> 读取。值加密存储、本页明文回显，执行输出自动脱敏。
          </p>
        </div>
        <button
          data-alt="env-var-create-button"
          onClick={openCreate}
          className="btn-primary flex-shrink-0 whitespace-nowrap"
        >
          <i className="fas fa-plus mr-2"></i>
          新建
        </button>
      </div>

      {/* 三列表格：变量名 / 值（明文） / 描述，外加更新信息与操作列 */}
      <div data-alt="env-vars-table" className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500 tracking-wider">
            <tr>
              <th className="px-5 py-3 text-left font-medium">变量名</th>
              <th className="px-5 py-3 text-left font-medium">值（明文）</th>
              <th className="px-5 py-3 text-left font-medium">描述</th>
              <th className="px-5 py-3 text-left font-medium">更新时间</th>
              <th className="px-5 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && (
              <tr>
                <td colSpan={5} className="px-5 py-12 text-center text-gray-400">
                  <i className="fas fa-spinner fa-spin mr-2"></i>加载中...
                </td>
              </tr>
            )}
            {!loading && (vars?.length ?? 0) === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-12 text-center text-gray-400">
                  暂无环境变量，点击右上角「新建」添加第一个。
                </td>
              </tr>
            )}
            {!loading &&
              vars?.map((v) => {
                const deleting = !!rowDeleting[v.id]
                return (
                  <tr key={v.id} className="hover:bg-gray-50/50">
                    <td className="px-5 py-3 font-mono text-gray-900">{v.name}</td>
                    {/* 值明文回显——长值用 break-all 折行避免撑破表格；hover 露出复制按钮。
                        解密失败行标红 + 警示图标，禁用复制，提示去编辑重填。 */}
                    <td className="px-5 py-3 font-mono max-w-xs">
                      {v.decrypt_error ? (
                        <span data-alt="env-var-decrypt-error" className="text-red-600 flex items-center gap-1.5">
                          <i className="fas fa-triangle-exclamation"></i>
                          <span>解密失败，请编辑重填真实值</span>
                        </span>
                      ) : (
                        <div className="group flex items-start gap-2 text-gray-700">
                          <span className="break-all">{v.value}</span>
                          <button
                            data-alt="env-var-copy-button"
                            onClick={() => handleCopyValue(v)}
                            className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-blue-600 transition-opacity flex-shrink-0 mt-0.5"
                            title="复制值"
                          >
                            <i className="fas fa-copy text-xs"></i>
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3 text-gray-600">{v.description || '—'}</td>
                    <td className="px-5 py-3 text-xs text-gray-500">
                      {/* 去掉小数秒，与成员管理页时间展示风格一致 */}
                      {v.updated_at?.split('.')[0]?.replace('T', ' ') ?? '—'}
                    </td>
                    <td className="px-5 py-3 text-right whitespace-nowrap">
                      <button
                        data-alt="env-var-edit-button"
                        onClick={() => openEdit(v)}
                        disabled={deleting}
                        className="text-blue-600 hover:text-blue-800 text-sm disabled:opacity-40 mr-4"
                        title="编辑变量值 / 描述"
                      >
                        <i className="fas fa-pen mr-1"></i>
                        编辑
                      </button>
                      <button
                        data-alt="env-var-delete-button"
                        onClick={() => handleDelete(v)}
                        disabled={deleting}
                        className="text-red-600 hover:text-red-800 text-sm disabled:opacity-40 disabled:hover:text-red-600"
                        title="删除该变量"
                      >
                        {deleting ? (
                          <i className="fas fa-spinner fa-spin"></i>
                        ) : (
                          <>
                            <i className="fas fa-trash mr-1"></i>
                            删除
                          </>
                        )}
                      </button>
                    </td>
                  </tr>
                )
              })}
          </tbody>
        </table>
      </div>

      {/* 新建 / 编辑弹窗 —— 变量名 / 变量值 / 描述三个输入框（参照成员管理页居中弹窗） */}
      {showModal && (
        <div
          data-alt="env-var-modal-backdrop"
          className="fixed inset-0 bg-black/40 z-40 flex items-end justify-center sm:items-center"
          onClick={closeModal}
        >
          <div
            data-alt="env-var-modal"
            className="bg-white w-full max-w-lg rounded-xl shadow-xl p-6 m-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-gray-900 mb-4">
              {isCreate ? '新建环境变量' : `编辑 ${form.editing?.name}`}
            </h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  变量名 <span className="text-red-500">*</span>
                </label>
                <input
                  data-alt="env-var-name-input"
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  disabled={!isCreate}
                  className="w-full input-base font-mono disabled:bg-gray-50 disabled:text-gray-500"
                  placeholder="如 API_TOKEN"
                  autoFocus={isCreate}
                />
                {/* 仅新建态做即时校验提示；编辑态变量名锁定无需提示 */}
                {isCreate && form.name.trim().length > 0 && !nameValid && (
                  <p className="text-xs text-red-500 mt-1">
                    需以字母或下划线开头，仅含字母、数字、下划线。
                  </p>
                )}
                {!isCreate && (
                  <p className="text-xs text-gray-400 mt-1">变量名不可修改；如需改名请删除后重建。</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  变量值 <span className="text-red-500">*</span>
                </label>
                <input
                  data-alt="env-var-value-input"
                  type="text"
                  value={form.value}
                  onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
                  className="w-full input-base font-mono"
                  placeholder="变量的值"
                />
                <p className="text-xs text-gray-400 mt-1">
                  明文展示便于确认；加密存储，执行输出中自动脱敏。
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">描述</label>
                <input
                  data-alt="env-var-description-input"
                  type="text"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  className="w-full input-base"
                  placeholder="选填，说明该变量的用途"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-100">
              <button
                data-alt="env-var-cancel-button"
                onClick={closeModal}
                disabled={saving}
                className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                取消
              </button>
              <button
                data-alt="env-var-submit-button"
                onClick={handleSave}
                disabled={saving || !formValid}
                className="btn-primary disabled:opacity-50"
              >
                {saving ? '保存中...' : '确定'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
