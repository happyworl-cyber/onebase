'use client'

import { useState, useEffect, useCallback } from 'react'
import { rbacAPI, type Permission } from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { useNotification } from '@/hooks/useNotification'
import Drawer from '@/components/Drawer'
import PermissionGate from '@/components/PermissionGate'
import PermissionMatrix from '@/components/rbac/PermissionMatrix'
import { describeCondition } from '@/lib/rbac/templates'

interface Role {
  id: number
  tenant_id: number
  name: string
  description: string | null
  is_system: boolean
  created_at: string
  updated_at: string
}

export default function RolesPage() {
  // 顶层包一层 PermissionGate：非 tenant admin 直链进来时给降级提示，不再裸着 403。
  // 把内部组件单独命名，避免 hooks 顺序依赖闸门分支返回。
  return (
    <PermissionGate requires="canManageRbac" pageName="RBAC 角色管理">
      <RolesPageInner />
    </PermissionGate>
  )
}

function RolesPageInner() {
  const notify = useNotification()
  const { currentSchema } = useAppStore()
  const [roles, setRoles] = useState<Role[]>([])
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [selectedRole, setSelectedRole] = useState<Role | null>(null)
  const [rolePermissions, setRolePermissions] = useState<Permission[]>([])
  // M4 矩阵：所有角色 → 持有的 permission id 集合（一次性预拉取）
  const [rolePermissionIds, setRolePermissionIds] = useState<Record<number, Set<number>>>({})
  const [loading, setLoading] = useState(false)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [showAssignForm, setShowAssignForm] = useState(false)
  const [newRole, setNewRole] = useState({ name: '', description: '' })
  const [selectedPermIds, setSelectedPermIds] = useState<number[]>([])

  const loadRoles = async () => {
    setLoading(true)
    try {
      const res = await rbacAPI.listRoles()
      setRoles(res.data)
    } catch (err: any) {
      notify.error(err)
    } finally {
      setLoading(false)
    }
  }

  const loadPermissions = async () => {
    try {
      const res = await rbacAPI.listPermissions()
      setPermissions(res.data)
    } catch (err: any) {
      console.error('加载权限失败:', err)
    }
  }

  const loadRolePermissions = useCallback(async (roleId: number) => {
    try {
      const res = await rbacAPI.getRolePermissions(roleId)
      setRolePermissions(res.data)
      setSelectedPermIds(res.data.map((p: Permission) => p.id))
    } catch (err: any) {
      console.error('加载角色权限失败:', err)
    }
  }, [])

  // 批量拉取所有角色的 permission id 集合 —— 矩阵渲染的基础
  const loadAllRolePermissionIds = useCallback(async (rs: Role[]) => {
    const entries = await Promise.all(
      rs.map(async (r) => {
        try {
          const res = await rbacAPI.getRolePermissions(r.id)
          const ids = new Set<number>((res.data ?? []).map((p: Permission) => p.id))
          return [r.id, ids] as const
        } catch {
          return [r.id, new Set<number>()] as const
        }
      }),
    )
    const map: Record<number, Set<number>> = {}
    for (const [rid, ids] of entries) map[rid] = ids
    setRolePermissionIds(map)
  }, [])

  useEffect(() => {
    loadRoles()
    loadPermissions()
  }, [])

  // roles 一变就刷新矩阵的数据流
  useEffect(() => {
    if (roles.length > 0) {
      loadAllRolePermissionIds(roles)
    } else {
      setRolePermissionIds({})
    }
  }, [roles, loadAllRolePermissionIds])

  const reloadMatrixData = useCallback(async () => {
    await Promise.all([loadPermissions(), loadAllRolePermissionIds(roles)])
    if (selectedRole) await loadRolePermissions(selectedRole.id)
  }, [roles, selectedRole, loadAllRolePermissionIds, loadRolePermissions])

  useEffect(() => {
    if (selectedRole) loadRolePermissions(selectedRole.id)
  }, [selectedRole, loadRolePermissions])

  const createRole = async () => {
    if (!newRole.name.trim()) { notify.warning('请输入角色名称'); return }
    try {
      await rbacAPI.createRole({ name: newRole.name, description: newRole.description || undefined })
      notify.success('角色创建成功')
      setShowCreateForm(false)
      setNewRole({ name: '', description: '' })
      loadRoles()
    } catch (err: any) { notify.error(err) }
  }

  const deleteRole = async (role: Role) => {
    if (role.is_system) { notify.warning('不能删除系统角色'); return }
    if (!window.confirm(`确定要删除角色 "${role.name}" 吗？`)) return
    try {
      await rbacAPI.deleteRole(role.id)
      notify.success('角色已删除')
      if (selectedRole?.id === role.id) setSelectedRole(null)
      loadRoles()
    } catch (err: any) { notify.error(err) }
  }

  const togglePermission = (permId: number) => {
    setSelectedPermIds(prev =>
      prev.includes(permId) ? prev.filter(id => id !== permId) : [...prev, permId]
    )
  }

  const saveRolePermissions = async () => {
    if (!selectedRole) return
    try {
      await rbacAPI.setRolePermissions(selectedRole.id, selectedPermIds)
      notify.success('权限已保存')
      loadRolePermissions(selectedRole.id)
    } catch (err: any) { notify.error(err) }
  }

  const ACTION_COLORS: Record<string, string> = {
    SELECT: 'bg-blue-100 text-blue-700',
    INSERT: 'bg-green-100 text-green-700',
    UPDATE: 'bg-yellow-100 text-yellow-700',
    DELETE: 'bg-red-100 text-red-700',
    ALL: 'bg-purple-100 text-purple-700',
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">RBAC 角色管理</h1>
          <p className="text-sm text-gray-500 mt-1">管理应用层角色和权限分配</p>
        </div>
        <button onClick={() => setShowCreateForm(true)} className="btn-primary">
          <i className="fas fa-plus mr-2"></i>创建角色
        </button>
      </div>

      <div className="grid grid-cols-12 gap-6">
        {/* 左侧：角色列表 */}
        <div className="col-span-4">
          <div className="card">
            <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
              <h3 className="text-sm font-semibold text-gray-700">应用角色</h3>
            </div>
            <div className="max-h-[600px] overflow-y-auto">
              {loading && roles.length === 0 ? (
                <div className="p-4 text-center text-gray-500"><i className="fas fa-spinner fa-spin mr-2"></i>加载中...</div>
              ) : roles.length === 0 ? (
                <div className="p-4 text-center text-gray-500">暂无角色</div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {roles.map(role => (
                    <div
                      key={role.id}
                      onClick={() => setSelectedRole(role)}
                      className={`group p-4 cursor-pointer hover:bg-gray-50 transition-colors ${
                        selectedRole?.id === role.id ? 'bg-blue-50 border-l-2 border-blue-500' : ''
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-3">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                            role.is_system ? 'bg-amber-100' : 'bg-blue-100'
                          }`}>
                            <i className={`fas ${role.is_system ? 'fa-lock text-amber-500' : 'fa-user-tag text-blue-500'}`}></i>
                          </div>
                          <div>
                            <p className="font-medium text-gray-900">{role.name}</p>
                            {role.description && (
                              <p className="text-xs text-gray-500 mt-0.5">{role.description}</p>
                            )}
                            {role.is_system && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">系统角色</span>
                            )}
                          </div>
                        </div>
                        {!role.is_system && (
                          <button
                            onClick={(e) => { e.stopPropagation(); deleteRole(role) }}
                            className="text-red-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <i className="fas fa-trash text-sm"></i>
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 右侧：权限配置 */}
        <div className="col-span-8 space-y-6">
          {!selectedRole ? (
            <div className="card p-8 text-center">
              <i className="fas fa-user-shield text-5xl text-gray-300 mb-4"></i>
              <p className="text-gray-500">选择一个角色来配置其权限</p>
            </div>
          ) : (
            <>
              <div className="card">
                <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-700">
                    {selectedRole.name} 的权限配置
                  </h3>
                  <button onClick={saveRolePermissions} className="btn-primary text-sm">
                    <i className="fas fa-save mr-2"></i>保存权限
                  </button>
                </div>

                {permissions.length === 0 ? (
                  <div className="p-8 text-center text-gray-500">
                    <p>暂无权限定义，请先在权限管理页面创建权限</p>
                  </div>
                ) : (
                  <div className="divide-y divide-gray-100 max-h-[500px] overflow-y-auto">
                    {permissions.map(perm => {
                      const checked = selectedPermIds.includes(perm.id)
                      return (
                        <label
                          key={perm.id}
                          className={`flex items-start space-x-3 p-4 cursor-pointer hover:bg-gray-50 transition-colors ${
                            checked ? 'bg-blue-50' : ''
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => togglePermission(perm.id)}
                            className="mt-1 rounded border-gray-300 text-blue-600 w-4 h-4"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center space-x-2">
                              <span className="font-medium text-gray-900 text-sm">{perm.resource}</span>
                              <span className={`text-xs px-2 py-0.5 rounded font-medium ${ACTION_COLORS[perm.action] || 'bg-gray-100 text-gray-700'}`}>
                                {perm.action}
                              </span>
                            </div>
                            {perm.description && (
                              <p className="text-xs text-gray-500 mt-1">{perm.description}</p>
                            )}
                            {perm.conditions && perm.conditions.length > 0 && (
                              <div className="mt-1">
                                <span className="text-xs text-gray-400">条件: </span>
                                <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">
                                  {perm.conditions
                                    .map((c) =>
                                      typeof c === 'object' && c !== null && 'field' in c
                                        ? describeCondition(c)
                                        : String(c),
                                    )
                                    .join(' AND ')}
                                </code>
                              </div>
                            )}
                            {perm.allowed_columns && (
                              <div className="mt-1">
                                <span className="text-xs text-gray-400">列: </span>
                                <span className="text-xs text-gray-600">{perm.allowed_columns.join(', ')}</span>
                              </div>
                            )}
                          </div>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* M4 权限矩阵：跨角色一览 + cell 编辑 */}
      <div className="card">
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
          <h3 className="text-sm font-semibold text-gray-700">
            <i className="fas fa-th text-gray-400 mr-2"></i>
            权限矩阵
          </h3>
          <p className="text-xs text-gray-500 mt-1">
            按角色查看其在各资源上的 SELECT / INSERT / UPDATE / DELETE 权限；点击格子直接编辑条件 / 列控制 / 模板。
          </p>
        </div>
        <div className="p-4">
          <PermissionMatrix
            roles={roles}
            permissions={permissions}
            rolePermissionIds={rolePermissionIds}
            defaultSchema={currentSchema || 'public'}
            onReload={reloadMatrixData}
            notify={{
              success: (m) => notify.success(m),
              error: (e) => notify.error(e),
              warning: (m) => notify.warning(m),
            }}
          />
        </div>
      </div>

      {/* 创建角色抽屉 */}
      <Drawer
        isOpen={showCreateForm}
        onClose={() => setShowCreateForm(false)}
        title="创建角色"
        size="md"
        footer={
          <div className="flex gap-3">
            <button onClick={() => setShowCreateForm(false)} className="flex-1 h-11 px-5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-all">取消</button>
            <button onClick={createRole} disabled={!newRole.name.trim()} className="flex-1 h-11 px-5 text-sm font-medium text-white bg-gradient-to-r from-blue-500 to-blue-600 rounded-lg hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 transition-all shadow-sm hover:shadow-md flex items-center justify-center">
              <i className="fas fa-plus mr-2"></i>创建角色
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">角色名称</label>
            <input type="text" value={newRole.name} onChange={(e) => setNewRole({ ...newRole, name: e.target.value })} placeholder="如 editor, moderator, vip" className="w-full input-base" autoFocus />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">描述（可选）</label>
            <textarea value={newRole.description} onChange={(e) => setNewRole({ ...newRole, description: e.target.value })} placeholder="描述该角色的用途" rows={3} className="w-full input-base" />
          </div>
        </div>
      </Drawer>
    </div>
  )
}
