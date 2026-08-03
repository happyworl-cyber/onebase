'use client'

// M4 权限矩阵：rows = schema.table 资源；cols = SELECT / INSERT / UPDATE / DELETE / ALL
//
// 顶部 role tab → 切换查看哪个角色的权限。Cell 显示该 (role, resource, action) 三元组的状态：
//   - 灰底 empty 圈 → 角色未持有该权限（也许 permission 存在但未挂到角色）
//   - 绿 ✓ → 持有该权限
//   - 绿 ✓ + 🔒 → 持有但有行级条件
//   - 绿 ✓ + ◐ → 持有但有列级限制
//
// Cell 点击 → 打开右侧抽屉编辑 (resource, action) 这条 permission（条件 / 列控制）
// + 切换该权限是否归属当前角色。
//
// 权限记录是 tenant 级共享的 —— 改条件会影响所有引用该 permission 的角色，drawer 顶部
// 明确告示，避免误改。

import { useEffect, useMemo, useState } from 'react'
import Drawer from '@/components/Drawer'
import ConditionBuilder from '@/components/rbac/ConditionBuilder'
import ColumnControl, { type ColumnMode } from '@/components/rbac/ColumnControl'
import { PERMISSION_TEMPLATES, describeCondition } from '@/lib/rbac/templates'
import { rbacAPI, schemaAPI, type Permission, type RowCondition } from '@/lib/api'

const ACTIONS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL'] as const
type Action = (typeof ACTIONS)[number]

const ACTION_LABEL: Record<Action, string> = {
  SELECT: '读',
  INSERT: '建',
  UPDATE: '改',
  DELETE: '删',
  ALL: '全',
}

interface Role {
  id: number
  tenant_id: number
  name: string
  description: string | null
  is_system: boolean
}

interface PermissionMatrixProps {
  roles: Role[]
  permissions: Permission[]
  /** roleId → permission ids 的集合（来自 rbacAPI.getRolePermissions） */
  rolePermissionIds: Record<number, Set<number>>
  /** 默认 schema —— 新增资源时用于补全前缀 */
  defaultSchema: string
  /** 任何变更后让父组件重新拉数据 */
  onReload: () => void
  /** notify 透传 */
  notify: {
    success: (msg: string) => void
    error: (err: unknown) => void
    warning: (msg: string) => void
  }
}

export default function PermissionMatrix({
  roles,
  permissions,
  rolePermissionIds,
  defaultSchema,
  onReload,
  notify,
}: PermissionMatrixProps) {
  const [activeRoleId, setActiveRoleId] = useState<number | null>(
    roles[0]?.id ?? null,
  )
  const [editing, setEditing] = useState<{
    resource: string
    action: Action
    existing: Permission | null
  } | null>(null)
  const [addingResource, setAddingResource] = useState(false)
  const [newResourceInput, setNewResourceInput] = useState('')
  const [extraResources, setExtraResources] = useState<string[]>([])

  useEffect(() => {
    if (activeRoleId == null && roles.length > 0) setActiveRoleId(roles[0].id)
  }, [roles, activeRoleId])

  // 矩阵的行 = 所有出现在 permissions 表里的资源 ∪ 用户新增的临时资源
  const resources = useMemo(() => {
    const set = new Set<string>(extraResources)
    for (const p of permissions) set.add(p.resource)
    return Array.from(set).sort()
  }, [permissions, extraResources])

  const activeRolePermIds = activeRoleId != null
    ? rolePermissionIds[activeRoleId] ?? new Set<number>()
    : new Set<number>()

  const lookupPermission = (resource: string, action: Action) =>
    permissions.find((p) => p.resource === resource && p.action === action) ?? null

  const onCellClick = (resource: string, action: Action) => {
    const existing = lookupPermission(resource, action)
    setEditing({ resource, action, existing })
  }

  const onAddResource = () => {
    const raw = newResourceInput.trim()
    if (!raw) return
    const fq = raw.includes('.') ? raw : `${defaultSchema}.${raw}`
    if (!extraResources.includes(fq) && !permissions.some((p) => p.resource === fq)) {
      setExtraResources([...extraResources, fq])
    }
    setNewResourceInput('')
    setAddingResource(false)
  }

  if (roles.length === 0) {
    return (
      <div className="text-sm text-gray-400 italic p-4 border border-dashed border-gray-200 rounded">
        当前项目没有角色 — 请先在上方创建角色，再来分配权限。
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* 角色 tab */}
      <div className="flex items-center gap-2 border-b border-gray-200 overflow-x-auto">
        {roles.map((r) => (
          <button
            key={r.id}
            onClick={() => setActiveRoleId(r.id)}
            className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 transition-colors ${
              activeRoleId === r.id
                ? 'border-blue-500 text-blue-600 font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {r.name}
            {r.is_system && (
              <span className="ml-1 text-[10px] text-gray-400">[内置]</span>
            )}
          </button>
        ))}
      </div>

      {/* 矩阵 */}
      <div className="overflow-x-auto border border-gray-200 rounded-lg">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-600 sticky left-0 bg-gray-50">
                资源 (schema.table)
              </th>
              {ACTIONS.map((a) => (
                <th
                  key={a}
                  className="text-center px-3 py-2 text-xs font-medium text-gray-600 w-20"
                  title={a}
                >
                  {ACTION_LABEL[a]}
                  <span className="block text-[9px] text-gray-400 font-normal">
                    {a}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {resources.length === 0 ? (
              <tr>
                <td
                  colSpan={ACTIONS.length + 1}
                  className="text-center text-gray-400 text-sm py-6 italic"
                >
                  当前角色没有任何权限。点击下方 "+ 添加资源" 开始配置。
                </td>
              </tr>
            ) : (
              resources.map((resource) => (
                <tr key={resource} className="hover:bg-gray-50 border-t border-gray-100">
                  <td className="px-4 py-2 font-mono text-xs text-gray-700 sticky left-0 bg-white">
                    {resource}
                  </td>
                  {ACTIONS.map((action) => {
                    const perm = lookupPermission(resource, action)
                    const owned = !!perm && activeRolePermIds.has(perm.id)
                    return (
                      <td key={action} className="text-center py-1.5">
                        <button
                          onClick={() => onCellClick(resource, action)}
                          className="inline-flex items-center justify-center w-9 h-7 rounded hover:bg-blue-50 group relative"
                          title={
                            owned
                              ? `已持有 ${action}`
                              : perm
                                ? `${action} 权限存在但未挂到此角色`
                                : `点击为此角色创建 ${action} 权限`
                          }
                        >
                          <CellIndicator owned={owned} perm={perm} />
                        </button>
                      </td>
                    )
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* + 添加资源 */}
      <div>
        {addingResource ? (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newResourceInput}
              onChange={(e) => setNewResourceInput(e.target.value)}
              placeholder={`${defaultSchema}.table_name 或仅 table_name`}
              className="input-base text-xs h-8 flex-1"
              onKeyDown={(e) => e.key === 'Enter' && onAddResource()}
              autoFocus
            />
            <button
              onClick={onAddResource}
              className="px-3 py-1 text-xs bg-blue-500 text-white rounded"
            >
              添加
            </button>
            <button
              onClick={() => {
                setAddingResource(false)
                setNewResourceInput('')
              }}
              className="px-3 py-1 text-xs text-gray-600"
            >
              取消
            </button>
          </div>
        ) : (
          <button
            onClick={() => setAddingResource(true)}
            className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1"
          >
            <i className="fas fa-plus text-[10px]"></i>
            添加资源行
          </button>
        )}
      </div>

      {/* 编辑抽屉 */}
      {editing && activeRoleId != null && (
        <CellEditorDrawer
          role={roles.find((r) => r.id === activeRoleId)!}
          resource={editing.resource}
          action={editing.action}
          existing={editing.existing}
          rolePermIds={activeRolePermIds}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            onReload()
          }}
          notify={notify}
        />
      )}
    </div>
  )
}

function CellIndicator({
  owned,
  perm,
}: {
  owned: boolean
  perm: Permission | null
}) {
  if (owned && perm) {
    const hasCond = perm.conditions.length > 0
    const hasCol =
      (perm.allowed_columns && perm.allowed_columns.length >= 0) ||
      perm.denied_columns.length > 0
    return (
      <span className="inline-flex items-center gap-0.5 text-green-600">
        <i className="fas fa-check text-xs"></i>
        {hasCond && <i className="fas fa-filter text-[9px] text-amber-500" title="有行级条件"></i>}
        {hasCol && (
          <i
            className="fas fa-columns text-[9px] text-purple-500"
            title="有列级限制"
          ></i>
        )}
      </span>
    )
  }
  if (perm) {
    return <span className="text-gray-300 text-xs">○</span>
  }
  return <span className="text-gray-200 text-xs">·</span>
}

// ─── 编辑抽屉（Phase 2 内联，Phase 3 可考虑独立成文件） ─────────────────

function CellEditorDrawer({
  role,
  resource,
  action,
  existing,
  rolePermIds,
  onClose,
  onSaved,
  notify,
}: {
  role: Role
  resource: string
  action: Action
  existing: Permission | null
  rolePermIds: Set<number>
  onClose: () => void
  onSaved: () => void
  notify: PermissionMatrixProps['notify']
}) {
  const isOwned = !!existing && rolePermIds.has(existing.id)
  const [conditions, setConditions] = useState<RowCondition[]>(
    existing?.conditions ?? [],
  )
  const [allowed, setAllowed] = useState<string[] | null>(
    existing?.allowed_columns ?? null,
  )
  const [denied, setDenied] = useState<string[]>(existing?.denied_columns ?? [])
  const [columnMode, setColumnMode] = useState<ColumnMode>(
    existing?.allowed_columns != null ? 'allow' : 'deny',
  )
  const [description, setDescription] = useState(existing?.description ?? '')
  const [tableColumns, setTableColumns] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [showLegacy, setShowLegacy] = useState(false)

  // 加载该 resource 的列名给 ColumnControl
  useEffect(() => {
    const [schema, table] = resource.split('.')
    if (!schema || !table) return
    schemaAPI
      .getTableStructure(schema, table)
      .then((res) => {
        const cols = (res.data?.columns ?? [])
          .map((c: { column_name: string }) => c.column_name)
          .filter(Boolean)
        setTableColumns(cols)
      })
      .catch(() => setTableColumns([]))
  }, [resource])

  // 检测旧 string 条件 —— 只读告示
  const hasLegacyStrings = useMemo(() => {
    const raw = existing?.conditions as unknown
    if (!Array.isArray(raw)) return false
    return raw.some((c: unknown) => typeof c === 'string')
  }, [existing])

  const applyTemplate = (id: string) => {
    const tpl = PERMISSION_TEMPLATES.find((t) => t.id === id)
    if (!tpl) return
    setConditions(tpl.buildConditions())
    if (tpl.buildColumns) {
      const c = tpl.buildColumns()
      setColumnMode(c.mode)
      setAllowed(c.allowed_columns)
      setDenied(c.denied_columns)
    }
    notify.success(`已应用模板：${tpl.label}（可继续调整后保存）`)
  }

  const save = async () => {
    setSaving(true)
    try {
      let permId: number
      if (existing) {
        await rbacAPI.updatePermission(existing.id, {
          conditions,
          allowed_columns: columnMode === 'allow' ? allowed ?? [] : null,
          denied_columns: columnMode === 'deny' ? denied : [],
          description: description || undefined,
        })
        permId = existing.id
      } else {
        const res = await rbacAPI.createPermission({
          resource,
          action,
          conditions,
          allowed_columns: columnMode === 'allow' ? allowed ?? [] : null,
          denied_columns: columnMode === 'deny' ? denied : [],
          description: description || undefined,
        })
        permId = res.data?.id ?? res.data?.data?.id
        if (!permId) {
          throw new Error('创建权限后未返回 id')
        }
      }

      // 同步 role.permissions：如果当前角色未持有，加上；不主动移除其他角色的引用
      const want = new Set(rolePermIds)
      want.add(permId)
      if (!rolePermIds.has(permId)) {
        await rbacAPI.setRolePermissions(role.id, Array.from(want))
      }

      notify.success('已保存')
      onSaved()
    } catch (err) {
      notify.error(err)
    } finally {
      setSaving(false)
    }
  }

  const removeFromRole = async () => {
    if (!existing) return
    if (!window.confirm(`从 "${role.name}" 角色移除该权限？\n权限记录本身不会被删除。`)) {
      return
    }
    setSaving(true)
    try {
      const next = new Set(rolePermIds)
      next.delete(existing.id)
      await rbacAPI.setRolePermissions(role.id, Array.from(next))
      notify.success('已移除')
      onSaved()
    } catch (err) {
      notify.error(err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer
      isOpen={true}
      onClose={onClose}
      title={`${role.name} · ${resource} · ${action}`}
      size="xl"
      footer={
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 h-10 px-4 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            取消
          </button>
          {isOwned && existing && (
            <button
              onClick={removeFromRole}
              disabled={saving}
              className="h-10 px-4 text-sm text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50"
            >
              从角色移除
            </button>
          )}
          <button
            onClick={save}
            disabled={saving}
            className="flex-1 h-10 px-4 text-sm text-white bg-blue-500 rounded-lg hover:bg-blue-600 disabled:opacity-50"
          >
            {saving ? '保存中…' : isOwned ? '保存修改' : existing ? '挂到角色并保存' : '新建并挂到角色'}
          </button>
        </div>
      }
    >
      <div className="space-y-5">
        {/* 上下文条幅 */}
        <div className="p-3 bg-blue-50 border border-blue-100 rounded text-xs text-blue-900 leading-relaxed">
          <p>
            正在为角色 <strong>{role.name}</strong> 配置 <code className="bg-white px-1 rounded">{resource}</code> 的 <strong>{action}</strong> 权限。
          </p>
          {existing && (
            <p className="mt-1 text-blue-700">
              此权限记录 (#{existing.id}) 可能被多个角色引用；编辑会影响所有引用方。
            </p>
          )}
        </div>

        {hasLegacyStrings && (
          <div className="p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
            <p className="flex items-center gap-2 font-medium">
              <i className="fas fa-exclamation-triangle"></i>
              该权限包含**旧版字符串条件**
            </p>
            <p className="mt-1">
              运行时已被后端拒绝。请用下方结构化条件 builder 重建后保存。
              <button
                onClick={() => setShowLegacy(!showLegacy)}
                className="ml-2 text-amber-700 underline"
              >
                {showLegacy ? '隐藏' : '查看'}原条件
              </button>
            </p>
            {showLegacy && (
              <pre className="mt-2 p-2 bg-white text-[10px] text-gray-600 rounded overflow-auto">
                {JSON.stringify(existing?.conditions, null, 2)}
              </pre>
            )}
          </div>
        )}

        {/* 模板下拉 */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            应用模板（可选）
          </label>
          <div className="grid grid-cols-3 gap-2">
            {PERMISSION_TEMPLATES.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                onClick={() => applyTemplate(tpl.id)}
                className="text-left p-2 border border-gray-200 rounded hover:border-blue-300 hover:bg-blue-50 transition-colors"
                title={tpl.hint}
              >
                <p className="text-xs font-medium text-gray-800">{tpl.label}</p>
                <p className="text-[10px] text-gray-500 line-clamp-2">{tpl.hint}</p>
              </button>
            ))}
          </div>
        </div>

        {/* 行级条件 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            行级过滤条件
          </label>
          <ConditionBuilder
            value={conditions.filter(
              (c) => typeof c === 'object' && c !== null && 'field' in c,
            )}
            onChange={setConditions}
            fieldOptions={tableColumns}
          />
          {conditions.length > 0 && (
            <p className="text-[10px] text-gray-400 mt-2">
              生效后：{conditions.map(describeCondition).join(' AND ')}
            </p>
          )}
        </div>

        {/* 列级 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            列级可见性
          </label>
          <ColumnControl
            availableColumns={tableColumns}
            allowed_columns={allowed}
            denied_columns={denied}
            mode={columnMode}
            onChange={({ mode, allowed_columns, denied_columns }) => {
              setColumnMode(mode)
              setAllowed(allowed_columns)
              setDenied(denied_columns)
            }}
          />
        </div>

        {/* 备注 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            描述（可选）
          </label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="说明该权限用途，便于团队审阅"
            className="input-base w-full text-sm"
          />
        </div>
      </div>
    </Drawer>
  )
}
