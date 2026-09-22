'use client'

// M4 Phase 3：权限管理页 —— 行级条件 + 列级可见性的结构化编辑
//
// 结构与原版相同（列表 + 创建/编辑 drawer），关键升级：
// - 行级条件：纯字符串 → ConditionBuilder（结构化 RowCondition[]）
// - 列级控制：手动维护 allowed_columns 数组 → ColumnControl（deny / allow 二选一模式 + 表列名网格）
// - 模板：4 个字符串裸模板 → 5 个结构化模板（PERMISSION_TEMPLATES）
// - 列表显示：用 describeCondition 把 RowCondition 渲染成人话；老字符串条件显式 legacy 标记

import { useState, useEffect, useMemo } from 'react'
import {
  rbacAPI,
  schemaAPI,
  type Permission,
  type RowCondition,
} from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { useNotification } from '@/hooks/useNotification'
import { useTranslations } from 'next-intl'
import Drawer from '@/components/Drawer'
import PermissionGate from '@/components/PermissionGate'
import ConditionBuilder from '@/components/rbac/ConditionBuilder'
import ColumnControl, { type ColumnMode } from '@/components/rbac/ColumnControl'
import {
  PERMISSION_TEMPLATES,
  describeCondition,
  findTemplate,
} from '@/lib/rbac/templates'

interface TableInfo {
  table_name: string
  table_type: string
}

const ACTIONS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL'] as const

const ACTION_COLORS: Record<string, string> = {
  SELECT: 'bg-blue-100 text-blue-700',
  INSERT: 'bg-green-100 text-green-700',
  UPDATE: 'bg-yellow-100 text-yellow-700',
  DELETE: 'bg-red-100 text-red-700',
  ALL: 'bg-purple-100 text-purple-700',
}

interface FormState {
  resource: string
  action: string
  conditions: RowCondition[]
  legacyStrings: string[] // 仅展示给用户看的旧条件，永不提交
  columnMode: ColumnMode
  allowed_columns: string[] | null
  denied_columns: string[]
  description: string
}

const EMPTY_FORM: FormState = {
  resource: '',
  action: 'SELECT',
  conditions: [],
  legacyStrings: [],
  columnMode: 'deny',
  allowed_columns: null,
  denied_columns: [],
  description: '',
}

export default function PermissionsPage() {
  const t = useTranslations('wsRls')
  return (
    <PermissionGate requires="canManageRbac" pageName={t('gate')}>
      <PermissionsPageInner />
    </PermissionGate>
  )
}

function PermissionsPageInner() {
  const tr = useTranslations('wsRls')
  const trTpl = useTranslations('rbacTemplates')
  const { currentSchema } = useAppStore()
  const notify = useNotification()
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [tables, setTables] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [editingPerm, setEditingPerm] = useState<Permission | null>(null)
  const [filterResource, setFilterResource] = useState('')
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [tableColumns, setTableColumns] = useState<string[]>([])

  const loadPermissions = async () => {
    setLoading(true)
    try {
      const res = await rbacAPI.listPermissions()
      setPermissions(res.data)
    } catch (err: any) {
      notify.error(err)
    } finally {
      setLoading(false)
    }
  }

  const loadTables = async () => {
    if (!currentSchema) return
    try {
      const res = await schemaAPI.listTables(currentSchema)
      setTables(
        res.data
          .filter((t: TableInfo) => t.table_type === 'BASE TABLE')
          .map((t: TableInfo) => t.table_name),
      )
    } catch (err: any) {
      console.error(err)
    }
  }

  useEffect(() => {
    loadPermissions()
    loadTables()
  }, [currentSchema])

  // 资源改变 → 刷新该表的列名（ColumnControl 用）
  useEffect(() => {
    const [schema, table] = form.resource.split('.')
    if (!schema || !table) {
      setTableColumns([])
      return
    }
    let cancelled = false
    schemaAPI
      .getTableStructure(schema, table)
      .then((res) => {
        if (cancelled) return
        const cols = (res.data?.columns ?? [])
          .map((c: { column_name: string }) => c.column_name)
          .filter(Boolean)
        setTableColumns(cols)
      })
      .catch(() => {
        if (!cancelled) setTableColumns([])
      })
    return () => {
      cancelled = true
    }
  }, [form.resource])

  const resetForm = () => {
    setForm(EMPTY_FORM)
    setEditingPerm(null)
  }

  const openCreate = () => {
    resetForm()
    setShowCreateForm(true)
  }

  // 把后端返回的 conditions 拆成 (结构化, legacy) 两组
  const splitConditions = (raw: unknown): { structured: RowCondition[]; legacy: string[] } => {
    if (!Array.isArray(raw)) return { structured: [], legacy: [] }
    const structured: RowCondition[] = []
    const legacy: string[] = []
    for (const item of raw) {
      if (typeof item === 'string') {
        legacy.push(item)
      } else if (item && typeof item === 'object' && 'field' in item && 'op' in item) {
        structured.push(item as RowCondition)
      }
    }
    return { structured, legacy }
  }

  const openEdit = (p: Permission) => {
    const { structured, legacy } = splitConditions(p.conditions)
    setEditingPerm(p)
    setForm({
      resource: p.resource,
      action: p.action,
      conditions: structured,
      legacyStrings: legacy,
      columnMode: p.allowed_columns != null ? 'allow' : 'deny',
      allowed_columns: p.allowed_columns,
      denied_columns: Array.isArray(p.denied_columns) ? p.denied_columns : [],
      description: p.description || '',
    })
    setShowCreateForm(true)
  }

  const applyTemplate = (id: string) => {
    const tpl = findTemplate(id)
    if (!tpl) return
    setForm((f) => {
      const next: FormState = {
        ...f,
        conditions: tpl.buildConditions(),
      }
      if (tpl.buildColumns) {
        const c = tpl.buildColumns()
        next.columnMode = c.mode
        next.allowed_columns = c.allowed_columns
        next.denied_columns = c.denied_columns
      }
      return next
    })
    notify.success(tr('applied', { label: trTpl(tpl.labelKey) }))
  }

  const submitPermission = async () => {
    if (!form.resource) {
      notify.warning(tr('errSelectResource'))
      return
    }
    const payload = {
      resource: form.resource,
      action: form.action,
      conditions: form.conditions,
      allowed_columns: form.columnMode === 'allow' ? form.allowed_columns ?? [] : null,
      denied_columns: form.columnMode === 'deny' ? form.denied_columns : [],
      description: form.description || undefined,
    }
    try {
      if (editingPerm) {
        await rbacAPI.updatePermission(editingPerm.id, payload)
        notify.success(tr('updated'))
      } else {
        await rbacAPI.createPermission(payload)
        notify.success(tr('created'))
      }
      setShowCreateForm(false)
      resetForm()
      loadPermissions()
    } catch (err: any) {
      notify.error(err)
    }
  }

  const deletePermission = async (id: number) => {
    if (!window.confirm(tr('confirmDelete'))) return
    try {
      await rbacAPI.deletePermission(id)
      notify.success(tr('deleted'))
      loadPermissions()
    } catch (err: any) {
      notify.error(err)
    }
  }

  const filtered = permissions.filter(
    (p) => !filterResource || p.resource.toLowerCase().includes(filterResource.toLowerCase()),
  )

  const grouped = filtered.reduce<Record<string, Permission[]>>((acc, p) => {
    ;(acc[p.resource] = acc[p.resource] || []).push(p)
    return acc
  }, {})

  const hasFormLegacyStrings = form.legacyStrings.length > 0

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">{tr('title')}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {tr('subtitle')}
          </p>
        </div>
        <button onClick={openCreate} className="btn-primary">
          <i className="fas fa-plus mr-2"></i>{tr('createPerm')}
        </button>
      </div>

      {/* 搜索过滤 */}
      <div className="card p-4">
        <input
          type="text"
          value={filterResource}
          onChange={(e) => setFilterResource(e.target.value)}
          placeholder={tr('phSearch')}
          className="w-full input-base"
        />
      </div>

      {/* 权限列表 */}
      {loading ? (
        <div className="card p-8 text-center text-gray-500">
          <i className="fas fa-spinner fa-spin mr-2"></i>{tr('loading')}
        </div>
      ) : Object.keys(grouped).length === 0 ? (
        <div className="card p-8 text-center">
          <i className="fas fa-shield-alt text-5xl text-gray-300 mb-4"></i>
          <p className="text-gray-500 mb-2">{tr('empty')}</p>
          <p className="text-sm text-gray-400">
            {tr('emptyHint')}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {Object.entries(grouped).map(([resource, perms]) => (
            <div key={resource} className="card">
              <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
                <h3 className="text-sm font-semibold text-gray-700 flex items-center">
                  <i className="fas fa-table text-gray-400 mr-2"></i>
                  {resource}
                  <span className="ml-2 text-xs font-normal text-gray-400">
                    {tr('ruleCount', { n: perms.length })}
                  </span>
                </h3>
              </div>
              <div className="divide-y divide-gray-100">
                {perms.map((perm) => (
                  <PermissionRow
                    key={perm.id}
                    perm={perm}
                    onEdit={() => openEdit(perm)}
                    onDelete={() => deletePermission(perm.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 创建/编辑权限抽屉 */}
      <Drawer
        isOpen={showCreateForm}
        onClose={() => {
          setShowCreateForm(false)
          resetForm()
        }}
        title={editingPerm ? tr('editTitle') : tr('createTitle')}
        size="xl"
        footer={
          <div className="flex gap-3">
            <button
              onClick={() => {
                setShowCreateForm(false)
                resetForm()
              }}
              className="flex-1 h-11 px-5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-all"
            >
              {tr('cancel')}
            </button>
            <button
              onClick={submitPermission}
              disabled={!form.resource}
              className="flex-1 h-11 px-5 text-sm font-medium text-white bg-gradient-to-r from-blue-500 to-blue-600 rounded-lg hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 transition-all shadow-sm hover:shadow-md flex items-center justify-center"
            >
              <i className={`fas ${editingPerm ? 'fa-save' : 'fa-plus'} mr-2`}></i>
              {editingPerm ? tr('saveEdit') : tr('createPerm')}
            </button>
          </div>
        }
      >
        <div className="space-y-6">
          {/* 资源选择 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {tr('resourceLabel')}
            </label>
            {tables.length > 0 ? (
              <select
                value={form.resource}
                onChange={(e) => setForm((f) => ({ ...f, resource: e.target.value }))}
                className="w-full input-base"
              >
                <option value="">{tr('selectTable')}</option>
                {tables.map((t) => (
                  <option key={t} value={`${currentSchema}.${t}`}>
                    {currentSchema}.{t}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={form.resource}
                onChange={(e) => setForm((f) => ({ ...f, resource: e.target.value }))}
                placeholder="public.posts"
                className="w-full input-base"
              />
            )}
          </div>

          {/* 操作类型 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">{tr('actionType')}</label>
            <div className="flex gap-2 flex-wrap">
              {ACTIONS.map((a) => (
                <button
                  key={a}
                  onClick={() => setForm((f) => ({ ...f, action: a }))}
                  className={`px-4 py-2 text-sm rounded-lg transition-colors ${
                    form.action === a
                      ? 'bg-blue-500 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>

          {/* 应用模板 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {tr('applyTemplateLabel')}
            </label>
            <p className="text-xs text-gray-500 mb-2">
              {tr('applyTemplateHint')}
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
              {PERMISSION_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => applyTemplate(tpl.id)}
                  className="text-left p-3 border border-gray-200 rounded-lg hover:border-blue-300 hover:bg-blue-50 transition-colors"
                  title={trTpl(tpl.hintKey)}
                >
                  <p className="text-xs font-medium text-gray-900">{trTpl(tpl.labelKey)}</p>
                  <p className="text-[11px] text-gray-500 mt-0.5 line-clamp-2">
                    {trTpl(tpl.hintKey)}
                  </p>
                </button>
              ))}
            </div>
          </div>

          {/* 旧字符串条件警示 */}
          {hasFormLegacyStrings && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
              <p className="font-medium flex items-center gap-2">
                <i className="fas fa-exclamation-triangle"></i>
                {tr('legacyWarnTitle')}
              </p>
              <p className="mt-1">
                {tr('legacyWarnBody')}
              </p>
              <ul className="mt-2 space-y-1">
                {form.legacyStrings.map((s, i) => (
                  <li key={i} className="font-mono text-[10px] bg-white px-2 py-1 rounded">
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 行级条件 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {tr('rowFilter')}
            </label>
            <ConditionBuilder
              value={form.conditions}
              onChange={(conditions) => setForm((f) => ({ ...f, conditions }))}
              fieldOptions={tableColumns}
            />
            {form.conditions.length > 0 && (
              <p className="text-[10px] text-gray-400 mt-2">
                {tr('effect', { cond: form.conditions.map((c) => describeCondition(c, trTpl)).join(' AND ') })}
              </p>
            )}
          </div>

          {/* 列级可见性 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {tr('columnVisibility')}
            </label>
            <ColumnControl
              availableColumns={tableColumns}
              allowed_columns={form.allowed_columns}
              denied_columns={form.denied_columns}
              mode={form.columnMode}
              onChange={({ mode, allowed_columns, denied_columns }) =>
                setForm((f) => ({
                  ...f,
                  columnMode: mode,
                  allowed_columns,
                  denied_columns,
                }))
              }
            />
          </div>

          {/* 描述 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {tr('descLabel')}
            </label>
            <input
              type="text"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder={tr('phDesc')}
              className="w-full input-base"
            />
          </div>
        </div>
      </Drawer>
    </div>
  )
}

// 列表行：人话渲染 conditions / 列控制 / legacy 标识
function PermissionRow({
  perm,
  onEdit,
  onDelete,
}: {
  perm: Permission
  onEdit: () => void
  onDelete: () => void
}) {
  const tr = useTranslations('wsRls')
  const trTpl = useTranslations('rbacTemplates')
  const { structured, legacy } = useMemo(() => {
    if (!Array.isArray(perm.conditions)) return { structured: [], legacy: [] }
    const s: RowCondition[] = []
    const l: string[] = []
    for (const c of perm.conditions) {
      if (typeof c === 'string') l.push(c)
      else if (c && typeof c === 'object' && 'field' in c) s.push(c as RowCondition)
    }
    return { structured: s, legacy: l }
  }, [perm.conditions])

  return (
    <div className="p-4 hover:bg-gray-50 transition-colors">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center space-x-2 mb-1 flex-wrap">
            <span
              className={`text-xs px-2 py-0.5 rounded font-medium ${
                ACTION_COLORS[perm.action] || 'bg-gray-100 text-gray-700'
              }`}
            >
              {perm.action}
            </span>
            {perm.description && (
              <span className="text-sm text-gray-600">{perm.description}</span>
            )}
            {legacy.length > 0 && (
              <span className="text-[10px] px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                {tr('hasLegacy')}
              </span>
            )}
          </div>

          {structured.length > 0 && (
            <div className="mt-1">
              <span className="text-xs text-gray-400">{tr('conditionsLabel')}</span>
              <code className="text-xs bg-orange-50 text-orange-700 px-1.5 py-0.5 rounded">
                {structured.map((c) => describeCondition(c, trTpl)).join(' AND ')}
              </code>
            </div>
          )}
          {legacy.length > 0 && (
            <div className="mt-1 space-y-1">
              <span className="text-xs text-gray-400">{tr('legacyLabel')}</span>
              {legacy.map((c, i) => (
                <code
                  key={i}
                  className="block text-xs bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded line-through opacity-70"
                >
                  {c}
                </code>
              ))}
            </div>
          )}

          {perm.allowed_columns != null && (
            <div className="mt-1 flex flex-wrap gap-1 items-center">
              <span className="text-xs text-gray-400">{tr('onlyVisible')}</span>
              {perm.allowed_columns.length === 0 ? (
                <span className="text-xs text-red-500 italic">{tr('noVisibleCol')}</span>
              ) : (
                perm.allowed_columns.map((c) => (
                  <span
                    key={c}
                    className="text-xs bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded"
                  >
                    {c}
                  </span>
                ))
              )}
            </div>
          )}
          {perm.denied_columns && perm.denied_columns.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1 items-center">
              <span className="text-xs text-gray-400">{tr('hidden')}</span>
              {perm.denied_columns.map((c) => (
                <span
                  key={c}
                  className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded line-through"
                >
                  {c}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center space-x-2 ml-4">
          <button
            onClick={onEdit}
            className="text-gray-400 hover:text-blue-600"
            title={tr('edit')}
          >
            <i className="fas fa-pencil-alt text-sm"></i>
          </button>
          <button
            onClick={onDelete}
            className="text-gray-400 hover:text-red-600"
            title={tr('delete')}
          >
            <i className="fas fa-trash text-sm"></i>
          </button>
        </div>
      </div>
    </div>
  )
}
