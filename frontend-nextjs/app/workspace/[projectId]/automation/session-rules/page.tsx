'use client'

/**
 * `/workspace/[projectId]/automation/session-rules` —— 项目级会话规则管理。
 *
 * 详细设计：docs/superpowers/specs/2026-05-27-session-rules-design.md
 * 后端：src/session_rules_handlers.rs（`/api/admin/session-rules/:database_slug[/:id]`）
 *
 * 与 dashboard 上的 Workflow 的差别：
 * - 会话规则：声明式 / 同步 / RPC inject 热路径 / 项目 owner-admin。配 header→GUC，业务函数读 GUC 做精细化授权。
 * - Workflow：脚本式 / 异步 / 事件驱动 / 项目 admin+。Lua 节点跑业务自动化（同步外部系统、发通知等）。
 *
 * 两者 UI 都归到「自动化」分组，但是路径区分：本页 `/automation/session-rules`，
 * workflow 在 dashboard。
 *
 * 鉴权：handler 内 `require_database_admin`；前端门槛 `canManageEvents`（与定时任务一致）。
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import type { AxiosError } from 'axios'
import {
  sessionRuleAPI,
  type SessionRule,
  type SessionHook,
  type SessionHookValidationError,
  type CreateSessionRuleInput,
  type UpdateSessionRuleInput,
} from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { useNotification } from '@/hooks/useNotification'
import Drawer from '@/components/Drawer'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'

// ────────────────────────────────────────────────────────────────────────
// 表单状态：保持与后端 `SessionHook` 字段名一致，方便直接序列化为 hooks 数组。
//
// `max_length` / `max_count` 在 text / int_csv 之间互斥；我们用 hookKindCaps 派生，
// 而不是另写两个字段，避免来回切换 type 时残留旧值。
// ────────────────────────────────────────────────────────────────────────

type FormHook = {
  header: string
  guc: string
  type: 'text' | 'int_csv'
  cap: string // textbox 字面值；提交时按 type 解析成 max_length / max_count
}

interface FormState {
  name: string
  description: string
  is_active: boolean
  hooks: FormHook[]
}

const DEFAULT_TEXT_CAP = '256'
const DEFAULT_INT_CSV_CAP = '1000'

const EMPTY_FORM: FormState = {
  name: '',
  description: '',
  is_active: true,
  hooks: [],
}

function hookToForm(h: SessionHook): FormHook {
  return {
    header: h.header,
    guc: h.guc,
    type: h.type,
    cap:
      h.type === 'text'
        ? String(h.max_length ?? DEFAULT_TEXT_CAP)
        : String(h.max_count ?? DEFAULT_INT_CSV_CAP),
  }
}

function ruleToForm(r: SessionRule): FormState {
  return {
    name: r.name,
    description: r.description ?? '',
    is_active: r.is_active,
    hooks: r.hooks.map(hookToForm),
  }
}

/**
 * 表单 → 后端 hooks 数组。cap 为空或非正整数时**不填**对应字段，让后端走默认值
 * （`parse_hooks_from_value` 里 `parse_positive_usize` 也是这套默认逻辑）。
 */
function formHooksToWire(hooks: FormHook[]): SessionHook[] {
  return hooks.map((h) => {
    const cap = parseInt(h.cap, 10)
    const valid = Number.isFinite(cap) && cap > 0
    const base: SessionHook = { header: h.header.trim(), guc: h.guc.trim(), type: h.type }
    if (h.type === 'text') {
      if (valid) base.max_length = cap
    } else {
      if (valid) base.max_count = cap
    }
    return base
  })
}

/**
 * 拿 422 details，按 index 取该 hook 上的第一条错误，做行内标红。
 *
 * 后端 `HookParseError.index` 在"输入不是数组"这种整体性错误时为 0、`field` 为 null；
 * 这种情况会回退到 `topLevelError`（仅在 JSON 模式或表单整体不合法时出现）。
 */
function indexErrors(
  errors: SessionHookValidationError[],
): { byIndex: Record<number, SessionHookValidationError[]>; topLevel: string | null } {
  const byIndex: Record<number, SessionHookValidationError[]> = {}
  let topLevel: string | null = null
  for (const e of errors) {
    if (e.field === null && e.index === 0) {
      topLevel = e.reason
      continue
    }
    if (!byIndex[e.index]) byIndex[e.index] = []
    byIndex[e.index].push(e)
  }
  return { byIndex, topLevel }
}

/** axios 错误 → details 数组（找不到时返回 null，调用方退化为常规 toast）。 */
function extractValidationDetails(
  err: AxiosError<{ details?: SessionHookValidationError[]; code?: string }>,
): SessionHookValidationError[] | null {
  const body = err.response?.data
  if (body && Array.isArray(body.details) && body.code === 'validation_error') {
    return body.details
  }
  return null
}

// ────────────────────────────────────────────────────────────────────────
// 主页面
// ────────────────────────────────────────────────────────────────────────

export default function SessionRulesPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)

  // 后端 session-rules 路由要求 database_slug；不能回退到 project slug/name，
  // 否则会把项目标识误当成数据库连接 slug，导致 404。
  const currentConnection = useAppStore((s) => s.currentConnection)
  const databaseSlug = currentConnection?.database_slug || null
  const caps = useCurrentProjectCapabilities()
  const notify = useNotification()

  const [rules, setRules] = useState<SessionRule[]>([])
  const [loading, setLoading] = useState(true)

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null) // null = 新建
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  // JSON 模式：直接编辑 hooks 数组（运维侧粘贴/导出方便）；带本地解析校验
  const [jsonMode, setJsonMode] = useState(false)
  const [jsonText, setJsonText] = useState('[]')
  const [jsonParseError, setJsonParseError] = useState<string | null>(null)

  // 422 反馈：逐条错误标到 hook 行
  const [validationByIndex, setValidationByIndex] = useState<
    Record<number, SessionHookValidationError[]>
  >({})
  const [validationTopLevel, setValidationTopLevel] = useState<string | null>(null)

  // ─── 加载 ───
  const loadRules = async () => {
    if (!databaseSlug) return
    try {
      setLoading(true)
      const res = await sessionRuleAPI.list(databaseSlug)
      setRules(res.data.data)
    } catch (err) {
      notify.error(err as Error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (databaseSlug) loadRules()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseSlug])

  // ─── 抽屉打开/关闭 ───
  const openCreate = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setJsonMode(false)
    setJsonText('[]')
    setJsonParseError(null)
    setValidationByIndex({})
    setValidationTopLevel(null)
    setDrawerOpen(true)
  }

  const openEdit = (rule: SessionRule) => {
    setEditingId(rule.id)
    const f = ruleToForm(rule)
    setForm(f)
    setJsonMode(false)
    setJsonText(JSON.stringify(rule.hooks, null, 2))
    setJsonParseError(null)
    setValidationByIndex({})
    setValidationTopLevel(null)
    setDrawerOpen(true)
  }

  const closeDrawer = () => {
    if (saving) return
    setDrawerOpen(false)
  }

  // ─── JSON ↔ 表单 互转 ───
  // 切换到 JSON 模式时，把当前表单 hooks 序列化进 textbox；
  // 切换回表单时，尝试解析 textbox，失败则停留在 JSON 模式并展示 parse 错误。
  const switchToJson = () => {
    setJsonText(JSON.stringify(formHooksToWire(form.hooks), null, 2))
    setJsonParseError(null)
    setJsonMode(true)
  }

  const switchToForm = () => {
    try {
      const parsed = JSON.parse(jsonText)
      if (!Array.isArray(parsed)) {
        setJsonParseError('hooks 必须是 JSON 数组')
        return
      }
      const next: FormHook[] = parsed.map((h: any) => ({
        header: typeof h?.header === 'string' ? h.header : '',
        guc: typeof h?.guc === 'string' ? h.guc : '',
        type: h?.type === 'int_csv' ? 'int_csv' : 'text',
        cap:
          h?.type === 'int_csv'
            ? typeof h?.max_count === 'number'
              ? String(h.max_count)
              : DEFAULT_INT_CSV_CAP
            : typeof h?.max_length === 'number'
              ? String(h.max_length)
              : DEFAULT_TEXT_CAP,
      }))
      setForm({ ...form, hooks: next })
      setJsonParseError(null)
      setJsonMode(false)
    } catch (e: any) {
      setJsonParseError(`JSON 解析失败：${e?.message ?? String(e)}`)
    }
  }

  // ─── hooks 行编辑 ───
  const addHook = () => {
    setForm({
      ...form,
      hooks: [
        ...form.hooks,
        { header: '', guc: '', type: 'text', cap: DEFAULT_TEXT_CAP },
      ],
    })
  }

  const updateHook = (idx: number, patch: Partial<FormHook>) => {
    const next = form.hooks.slice()
    const cur = next[idx]
    const merged: FormHook = { ...cur, ...patch }
    // 切换 type 时同步 cap 默认值，避免 text 的 256 被当成 int_csv 的 256 误用
    if (patch.type && patch.type !== cur.type) {
      merged.cap = patch.type === 'text' ? DEFAULT_TEXT_CAP : DEFAULT_INT_CSV_CAP
    }
    next[idx] = merged
    setForm({ ...form, hooks: next })
  }

  const removeHook = (idx: number) => {
    setForm({ ...form, hooks: form.hooks.filter((_, i) => i !== idx) })
  }

  // ─── 提交 ───
  const handleSave = async () => {
    if (!databaseSlug) return
    setValidationByIndex({})
    setValidationTopLevel(null)

    if (!form.name.trim()) {
      notify.warning('请填写规则名称')
      return
    }

    // 收集要发的 hooks：JSON 模式下从 textbox 解析；表单模式从 form.hooks
    let hooksWire: SessionHook[]
    if (jsonMode) {
      try {
        const parsed = JSON.parse(jsonText)
        if (!Array.isArray(parsed)) {
          setJsonParseError('hooks 必须是 JSON 数组')
          return
        }
        hooksWire = parsed
      } catch (e: any) {
        setJsonParseError(`JSON 解析失败：${e?.message ?? String(e)}`)
        return
      }
    } else {
      hooksWire = formHooksToWire(form.hooks)
    }

    setSaving(true)
    try {
      if (editingId == null) {
        const payload: CreateSessionRuleInput = {
          name: form.name.trim(),
          description: form.description.trim() || null,
          is_active: form.is_active,
          hooks: hooksWire,
        }
        await sessionRuleAPI.create(databaseSlug, payload)
        notify.success('规则已创建')
      } else {
        const payload: UpdateSessionRuleInput = {
          name: form.name.trim(),
          description: form.description.trim() || null,
          is_active: form.is_active,
          hooks: hooksWire,
        }
        await sessionRuleAPI.update(databaseSlug, editingId, payload)
        notify.success('规则已更新')
      }
      setDrawerOpen(false)
      loadRules()
    } catch (err) {
      // 422 校验失败 → 把 details 映射到行
      const ax = err as AxiosError<any>
      const details = extractValidationDetails(ax)
      if (details) {
        const { byIndex, topLevel } = indexErrors(details)
        setValidationByIndex(byIndex)
        setValidationTopLevel(topLevel)
        notify.warning('hooks 校验失败，请检查标红的行')
      } else {
        notify.error(ax as unknown as Error)
      }
    } finally {
      setSaving(false)
    }
  }

  // ─── 行内操作 ───
  const handleToggleActive = async (rule: SessionRule) => {
    if (!databaseSlug) return
    try {
      await sessionRuleAPI.update(databaseSlug, rule.id, { is_active: !rule.is_active })
      notify.success(rule.is_active ? '规则已停用' : '规则已启用')
      loadRules()
    } catch (err) {
      notify.error(err as Error)
    }
  }

  const handleDelete = async (rule: SessionRule) => {
    if (!databaseSlug) return
    if (!confirm(`确定删除规则 "${rule.name}"？`)) return
    try {
      await sessionRuleAPI.delete(databaseSlug, rule.id)
      notify.success('规则已删除')
      loadRules()
    } catch (err) {
      notify.error(err as Error)
    }
  }

  // ─── 守卫 ───
  if (!caps.canManageEvents) {
    return (
      <ForbiddenPlaceholder reason="会话规则需要 admin+ 角色（owner / admin / 超管）" />
    )
  }

  if (isNaN(projectId)) {
    return <div className="p-8 text-center text-gray-500">URL 中的 projectId 无效</div>
  }

  if (!databaseSlug) {
    return (
      <div className="p-8 text-center text-gray-500 space-y-3">
        <i className="fas fa-plug text-4xl text-gray-300"></i>
        <p>本项目尚未绑定主数据库连接，无法管理会话规则。</p>
        <Link
          href={`/workspace/${projectId}/settings/connections`}
          className="text-blue-600 hover:underline"
        >
          前往设置 → 数据库连接
        </Link>
      </div>
    )
  }

  // ─── 渲染 ───
  return (
    <div className="p-6 space-y-6">
      {/* 顶部 header：title + 一句话描述 + info tooltip + 按钮归位。
          描述只留"做什么"，详细的优先级/合并语义放进 hover/focus 弹出的 tooltip 里，
          避免长段文字把按钮挤窄。database_slug 不在 UI 里露出（用户不关心底层实现细节）。 */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-3 min-w-0 flex-1">
          <h1 className="text-2xl font-bold text-gray-900 flex-shrink-0">会话规则</h1>
          <div className="flex items-center gap-1.5 text-sm text-gray-600 min-w-0">
            <span className="truncate">
              把请求头映射到 PG session GUC（如 <code>app.current_user_id</code> /{' '}
              <code>app.project_ids</code>）
            </span>
            {/* tabIndex=0 让键盘也能 focus 到这里触发 tooltip；role=button 略 overkill 因为没有 action，仅作信息提示。
                pointer-events-none 让 tooltip 不挡下方元素点击。 */}
            <span
              tabIndex={0}
              aria-label="查看优先级与合并规则说明"
              className="relative inline-flex flex-shrink-0 group outline-none"
            >
              <i className="fas fa-circle-info text-gray-400 group-hover:text-gray-600 group-focus:text-gray-600 cursor-help"></i>
              <div
                role="tooltip"
                className="invisible opacity-0 group-hover:visible group-hover:opacity-100 group-focus:visible group-focus:opacity-100 transition-opacity duration-150 absolute left-0 top-full mt-2 z-20 w-80 p-3 bg-gray-900 text-gray-100 rounded-lg shadow-lg text-xs leading-relaxed pointer-events-none"
              >
                <p className="font-medium mb-1.5 text-gray-100">优先级与合并规则</p>
                <ul className="space-y-1 list-disc list-outside ml-4 text-gray-300">
                  <li>多条 active 规则按 id 升序合并（同 GUC 时后规则覆盖前规则）</li>
                  <li>
                    API Key{' '}
                    <code className="bg-gray-800 px-1 rounded text-[10.5px]">
                      permissions.session_hooks
                    </code>{' '}
                    优先级最高，会覆盖项目级规则
                  </li>
                </ul>
              </div>
            </span>
          </div>
        </div>
        <button onClick={openCreate} className="btn-primary flex-shrink-0 whitespace-nowrap">
          <i className="fas fa-plus mr-2"></i>
          新建规则
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-12 text-center">
            <i className="fas fa-spinner fa-spin text-2xl text-gray-400"></i>
          </div>
        ) : rules.length === 0 ? (
          <div className="p-12 text-center text-gray-500">
            <i className="fas fa-sliders-h text-4xl mb-4 text-gray-300"></i>
            <p className="mb-4">本项目暂无会话规则</p>
            <button onClick={openCreate} className="btn-primary">
              <i className="fas fa-plus mr-2"></i>
              新建第一条规则
            </button>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {rules.map((rule) => (
              <div
                key={rule.id}
                className="px-6 py-4 flex items-center justify-between hover:bg-gray-50"
              >
                <div className="flex items-start space-x-4 min-w-0">
                  <div
                    className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
                      rule.is_active ? 'bg-blue-100' : 'bg-gray-100'
                    }`}
                  >
                    <i
                      className={`fas fa-sliders-h ${
                        rule.is_active ? 'text-blue-600' : 'text-gray-400'
                      }`}
                    ></i>
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900 truncate">{rule.name}</p>
                    {rule.description && (
                      <p className="text-sm text-gray-500 truncate mt-0.5">
                        {rule.description}
                      </p>
                    )}
                    <p className="text-xs text-gray-400 mt-1">
                      {rule.hooks.length} 条 hook · 更新于{' '}
                      {new Date(rule.updated_at).toLocaleString()}
                    </p>
                  </div>
                </div>
                <div className="flex items-center space-x-3 flex-shrink-0">
                  <span
                    className={`text-xs px-2 py-1 rounded-full ${
                      rule.is_active
                        ? 'bg-green-100 text-green-700'
                        : 'bg-gray-100 text-gray-500'
                    }`}
                  >
                    {rule.is_active ? '生效中' : '已停用'}
                  </span>
                  <button
                    onClick={() => handleToggleActive(rule)}
                    className={`px-3 py-1 text-sm rounded-lg ${
                      rule.is_active
                        ? 'text-yellow-700 hover:bg-yellow-50'
                        : 'text-green-700 hover:bg-green-50'
                    }`}
                  >
                    {rule.is_active ? '停用' : '启用'}
                  </button>
                  <button
                    onClick={() => openEdit(rule)}
                    className="px-3 py-1 text-sm text-blue-600 hover:bg-blue-50 rounded-lg"
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => handleDelete(rule)}
                    className="px-3 py-1 text-sm text-red-600 hover:bg-red-50 rounded-lg"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 编辑抽屉（创建 + 编辑共用） */}
      <Drawer
        isOpen={drawerOpen}
        onClose={closeDrawer}
        title={editingId == null ? '新建会话规则' : `编辑会话规则 #${editingId}`}
        size="lg"
        footer={
          <div className="flex gap-3">
            <button
              onClick={closeDrawer}
              disabled={saving}
              className="flex-1 h-11 px-5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !form.name.trim()}
              className="flex-1 btn-primary disabled:opacity-50"
            >
              {saving ? '保存中...' : editingId == null ? '创建' : '保存'}
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          {validationTopLevel && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              <i className="fas fa-exclamation-triangle mr-2"></i>
              {validationTopLevel}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              规则名称 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="例：acme-headers"
              className="w-full input-base"
              maxLength={100}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">备注</label>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={2}
              placeholder="可选：说明这条规则的来源 / 适用场景"
              className="w-full input-base font-mono text-sm"
            />
          </div>

          <div>
            <label className="flex items-center space-x-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                className="rounded border-gray-300 text-blue-600"
              />
              <span className="text-sm text-gray-700">启用（is_active）</span>
            </label>
            <p className="mt-1 text-xs text-gray-500 pl-6">
              停用的规则不参与 inject 路径合并；可用于"草稿"或"临时下线"状态。
            </p>
          </div>

          {/* ── hooks 子表单 / JSON 模式切换 ── */}
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-200">
              <div className="flex items-center space-x-3">
                <span className="text-sm font-medium text-gray-700">
                  Hooks（{jsonMode ? 'JSON 模式' : '表单模式'}）
                </span>
              </div>
              <div className="flex items-center space-x-1 text-xs">
                <button
                  type="button"
                  onClick={jsonMode ? switchToForm : undefined}
                  className={`px-2 py-1 rounded ${
                    !jsonMode
                      ? 'bg-white border border-gray-300 text-gray-900'
                      : 'text-gray-500 hover:bg-gray-100'
                  }`}
                >
                  表单
                </button>
                <button
                  type="button"
                  onClick={!jsonMode ? switchToJson : undefined}
                  className={`px-2 py-1 rounded ${
                    jsonMode
                      ? 'bg-white border border-gray-300 text-gray-900'
                      : 'text-gray-500 hover:bg-gray-100'
                  }`}
                >
                  JSON
                </button>
              </div>
            </div>

            {jsonMode ? (
              <div className="p-3 space-y-2">
                <textarea
                  value={jsonText}
                  onChange={(e) => {
                    setJsonText(e.target.value)
                    setJsonParseError(null)
                  }}
                  rows={14}
                  spellCheck={false}
                  className="w-full px-3 py-2 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder={`[
  { "header": "X-Way-UID",    "guc": "app.current_user_id", "type": "text",    "max_length": 256 },
  { "header": "X-Project-IDs", "guc": "app.project_ids",    "type": "int_csv", "max_count": 1000 }
]`}
                />
                {jsonParseError && (
                  <div className="text-xs text-red-600">{jsonParseError}</div>
                )}
                <p className="text-xs text-gray-500">
                  字段约束：GUC 必须匹配 <code>^app\.[a-z_][a-z0-9_]{'{'}0,63{'}'}$</code>；
                  type 只能是 <code>text</code> 或 <code>int_csv</code>。
                </p>
              </div>
            ) : (
              <div className="p-3 space-y-3">
                {form.hooks.length === 0 ? (
                  <div className="text-sm text-gray-500 py-3 text-center">
                    尚未配置任何 hook，点击下方按钮添加。
                  </div>
                ) : (
                  form.hooks.map((h, i) => {
                    const rowErrs = validationByIndex[i] ?? []
                    const fieldErr = (field: string) =>
                      rowErrs.find((e) => e.field === field)
                    return (
                      <div
                        key={i}
                        className={`border rounded-lg p-3 space-y-2 ${
                          rowErrs.length > 0
                            ? 'border-red-300 bg-red-50/40'
                            : 'border-gray-200 bg-white'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-gray-500">
                            Hook #{i + 1}
                          </span>
                          <button
                            type="button"
                            onClick={() => removeHook(i)}
                            className="text-xs text-red-600 hover:underline"
                          >
                            移除
                          </button>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="block text-xs text-gray-600 mb-1">
                              Header
                            </label>
                            <input
                              type="text"
                              value={h.header}
                              onChange={(e) => updateHook(i, { header: e.target.value })}
                              placeholder="X-Way-UID"
                              className={`w-full px-2 py-1.5 text-xs font-mono border rounded focus:outline-none focus:ring-1 ${
                                fieldErr('header')
                                  ? 'border-red-400 focus:ring-red-500'
                                  : 'border-gray-300 focus:ring-blue-500'
                              }`}
                            />
                            {fieldErr('header') && (
                              <p className="text-[11px] text-red-600 mt-0.5">
                                {fieldErr('header')!.reason}
                              </p>
                            )}
                          </div>
                          <div>
                            <label className="block text-xs text-gray-600 mb-1">
                              GUC
                            </label>
                            <input
                              type="text"
                              value={h.guc}
                              onChange={(e) => updateHook(i, { guc: e.target.value })}
                              placeholder="app.current_user_id"
                              className={`w-full px-2 py-1.5 text-xs font-mono border rounded focus:outline-none focus:ring-1 ${
                                fieldErr('guc')
                                  ? 'border-red-400 focus:ring-red-500'
                                  : 'border-gray-300 focus:ring-blue-500'
                              }`}
                            />
                            {fieldErr('guc') && (
                              <p className="text-[11px] text-red-600 mt-0.5">
                                {fieldErr('guc')!.reason}
                              </p>
                            )}
                          </div>
                          <div>
                            <label className="block text-xs text-gray-600 mb-1">
                              类型
                            </label>
                            <select
                              value={h.type}
                              onChange={(e) =>
                                updateHook(i, { type: e.target.value as FormHook['type'] })
                              }
                              className={`w-full px-2 py-1.5 text-xs border rounded focus:outline-none focus:ring-1 ${
                                fieldErr('type')
                                  ? 'border-red-400 focus:ring-red-500'
                                  : 'border-gray-300 focus:ring-blue-500'
                              }`}
                            >
                              <option value="text">text（字符串）</option>
                              <option value="int_csv">int_csv（逗号分隔整数）</option>
                            </select>
                            {fieldErr('type') && (
                              <p className="text-[11px] text-red-600 mt-0.5">
                                {fieldErr('type')!.reason}
                              </p>
                            )}
                          </div>
                          <div>
                            <label className="block text-xs text-gray-600 mb-1">
                              {h.type === 'text' ? '最大长度' : '最大段数'}
                            </label>
                            <input
                              type="number"
                              min={1}
                              value={h.cap}
                              onChange={(e) => updateHook(i, { cap: e.target.value })}
                              placeholder={
                                h.type === 'text' ? DEFAULT_TEXT_CAP : DEFAULT_INT_CSV_CAP
                              }
                              className="w-full px-2 py-1.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                          </div>
                        </div>
                        {/* 极少数情况下错误没有 field（结构性错误），兜底展示 */}
                        {rowErrs
                          .filter((e) => !e.field)
                          .map((e, k) => (
                            <p key={k} className="text-[11px] text-red-600">
                              {e.reason}
                            </p>
                          ))}
                      </div>
                    )
                  })
                )}
                <button
                  type="button"
                  onClick={addHook}
                  className="w-full py-2 text-sm text-blue-600 border border-dashed border-blue-300 rounded-lg hover:bg-blue-50"
                >
                  <i className="fas fa-plus mr-2"></i>
                  添加 hook
                </button>
              </div>
            )}
          </div>

          <div className="text-xs text-gray-500 leading-relaxed">
            <p className="font-medium text-gray-700 mb-1">优先级提示</p>
            同项目下多条 active 规则按 id 升序合并（同 GUC 后规则覆盖前规则）；
            API Key <code>permissions.session_hooks</code> 拥有最高优先级，会覆盖任意项目级规则。
          </div>
        </div>
      </Drawer>
    </div>
  )
}
