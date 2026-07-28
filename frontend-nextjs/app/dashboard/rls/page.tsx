'use client'

import { useState, useEffect } from 'react'
import { rbacAPI, schemaAPI } from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { useNotification } from '@/hooks/useNotification'
import Drawer from '@/components/Drawer'
import PermissionGate from '@/components/PermissionGate'

interface Permission {
  id: number
  tenant_id: number
  resource: string
  action: string
  conditions: string[]
  allowed_columns: string[] | null
  denied_columns: string[]
  description: string | null
  created_at: string
  updated_at: string
}

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

const CONDITION_TEMPLATES = [
  { label: '仅限作者本人', value: 'author_id = :current_user_id', hint: '用户只能操作自己创建的数据' },
  { label: '仅限 user_id 匹配', value: 'user_id = :current_user_id', hint: '按 user_id 字段限制' },
  { label: '仅已发布内容', value: "status = 'published'", hint: '只能看到 status 为 published 的行' },
  { label: '同部门可见', value: 'department_id = :current_user_department_id', hint: '限制在同部门范围' },
]

export default function PermissionsPage() {
  return (
    <PermissionGate requires="canManageRbac" pageName="权限管理">
      <PermissionsPageInner />
    </PermissionGate>
  )
}

function PermissionsPageInner() {
  const { currentSchema } = useAppStore()
  const notify = useNotification()
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [tables, setTables] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [editingPerm, setEditingPerm] = useState<Permission | null>(null)
  const [filterResource, setFilterResource] = useState('')

  const [form, setForm] = useState({
    resource: '',
    action: 'SELECT' as string,
    conditions: [] as string[],
    allowed_columns: null as string[] | null,
    denied_columns: [] as string[],
    description: '',
    newCondition: '',
    newColumn: '',
  })

  const loadPermissions = async () => {
    setLoading(true)
    try {
      const res = await rbacAPI.listPermissions()
      setPermissions(res.data)
    } catch (err: any) { notify.error(err) }
    finally { setLoading(false) }
  }

  const loadTables = async () => {
    if (!currentSchema) return
    try {
      const res = await schemaAPI.listTables(currentSchema)
      setTables(res.data.filter((t: TableInfo) => t.table_type === 'BASE TABLE').map((t: TableInfo) => t.table_name))
    } catch (err: any) { console.error(err) }
  }

  useEffect(() => { loadPermissions(); loadTables() }, [currentSchema])

  const resetForm = () => setForm({
    resource: '', action: 'SELECT', conditions: [], allowed_columns: null,
    denied_columns: [], description: '', newCondition: '', newColumn: '',
  })

  const openCreate = () => { resetForm(); setEditingPerm(null); setShowCreateForm(true) }

  const openEdit = (p: Permission) => {
    setEditingPerm(p)
    setForm({
      resource: p.resource, action: p.action,
      conditions: Array.isArray(p.conditions) ? p.conditions : [],
      allowed_columns: p.allowed_columns,
      denied_columns: Array.isArray(p.denied_columns) ? p.denied_columns : [],
      description: p.description || '',
      newCondition: '', newColumn: '',
    })
    setShowCreateForm(true)
  }

  const addCondition = (value?: string) => {
    const cond = value || form.newCondition.trim()
    if (!cond) return
    setForm(f => ({ ...f, conditions: [...f.conditions, cond], newCondition: '' }))
  }

  const removeCondition = (idx: number) =>
    setForm(f => ({ ...f, conditions: f.conditions.filter((_, i) => i !== idx) }))

  const toggleColumn = (col: string) => {
    setForm(f => {
      const current = f.allowed_columns || []
      const next = current.includes(col) ? current.filter(c => c !== col) : [...current, col]
      return { ...f, allowed_columns: next.length > 0 ? next : null }
    })
  }

  const submitPermission = async () => {
    if (!form.resource) { notify.warning('请选择资源'); return }
    const data = {
      resource: form.resource,
      action: form.action,
      conditions: form.conditions,
      allowed_columns: form.allowed_columns,
      denied_columns: form.denied_columns,
      description: form.description || undefined,
    }
    try {
      if (editingPerm) {
        await rbacAPI.updatePermission(editingPerm.id, data)
        notify.success('权限已更新')
      } else {
        await rbacAPI.createPermission(data)
        notify.success('权限已创建')
      }
      setShowCreateForm(false)
      resetForm()
      loadPermissions()
    } catch (err: any) { notify.error(err) }
  }

  const deletePermission = async (id: number) => {
    if (!window.confirm('确定要删除这条权限吗？')) return
    try {
      await rbacAPI.deletePermission(id)
      notify.success('权限已删除')
      loadPermissions()
    } catch (err: any) { notify.error(err) }
  }

  const filtered = permissions.filter(p =>
    !filterResource || p.resource.toLowerCase().includes(filterResource.toLowerCase())
  )

  // 按 resource 分组
  const grouped = filtered.reduce<Record<string, Permission[]>>((acc, p) => {
    (acc[p.resource] = acc[p.resource] || []).push(p)
    return acc
  }, {})

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">权限管理</h1>
          <p className="text-sm text-gray-500 mt-1">定义资源访问规则（应用层 RBAC，替代 PostgreSQL RLS）</p>
        </div>
        <button onClick={openCreate} className="btn-primary">
          <i className="fas fa-plus mr-2"></i>创建权限
        </button>
      </div>

      {/* 搜索过滤 */}
      <div className="card p-4">
        <input
          type="text" value={filterResource}
          onChange={e => setFilterResource(e.target.value)}
          placeholder="搜索资源名 (如 public.posts)"
          className="w-full input-base"
        />
      </div>

      {/* 权限列表 */}
      {loading ? (
        <div className="card p-8 text-center text-gray-500"><i className="fas fa-spinner fa-spin mr-2"></i>加载中...</div>
      ) : Object.keys(grouped).length === 0 ? (
        <div className="card p-8 text-center">
          <i className="fas fa-shield-alt text-5xl text-gray-300 mb-4"></i>
          <p className="text-gray-500 mb-2">暂无权限定义</p>
          <p className="text-sm text-gray-400">创建权限后，可在角色管理中将其分配给角色</p>
        </div>
      ) : (
        <div className="space-y-4">
          {Object.entries(grouped).map(([resource, perms]) => (
            <div key={resource} className="card">
              <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
                <h3 className="text-sm font-semibold text-gray-700 flex items-center">
                  <i className="fas fa-table text-gray-400 mr-2"></i>
                  {resource}
                  <span className="ml-2 text-xs font-normal text-gray-400">({perms.length} 条规则)</span>
                </h3>
              </div>
              <div className="divide-y divide-gray-100">
                {perms.map(perm => (
                  <div key={perm.id} className="p-4 hover:bg-gray-50 transition-colors">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center space-x-2 mb-1">
                          <span className={`text-xs px-2 py-0.5 rounded font-medium ${ACTION_COLORS[perm.action]}`}>
                            {perm.action}
                          </span>
                          {perm.description && <span className="text-sm text-gray-600">{perm.description}</span>}
                        </div>
                        {perm.conditions && perm.conditions.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            <span className="text-xs text-gray-400">行条件:</span>
                            {perm.conditions.map((c: string, i: number) => (
                              <code key={i} className="text-xs bg-orange-50 text-orange-700 px-1.5 py-0.5 rounded">{c}</code>
                            ))}
                          </div>
                        )}
                        {perm.allowed_columns && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            <span className="text-xs text-gray-400">可见列:</span>
                            {perm.allowed_columns.map((c: string, i: number) => (
                              <span key={i} className="text-xs bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded">{c}</span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center space-x-2 ml-4">
                        <button onClick={() => openEdit(perm)} className="text-gray-400 hover:text-blue-600" title="编辑">
                          <i className="fas fa-pencil-alt text-sm"></i>
                        </button>
                        <button onClick={() => deletePermission(perm.id)} className="text-gray-400 hover:text-red-600" title="删除">
                          <i className="fas fa-trash text-sm"></i>
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 创建/编辑权限抽屉 */}
      <Drawer
        isOpen={showCreateForm}
        onClose={() => { setShowCreateForm(false); resetForm() }}
        title={editingPerm ? '编辑权限' : '创建权限'}
        size="lg"
        footer={
          <div className="flex gap-3">
            <button onClick={() => setShowCreateForm(false)} className="flex-1 h-11 px-5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-all">取消</button>
            <button onClick={submitPermission} disabled={!form.resource} className="flex-1 h-11 px-5 text-sm font-medium text-white bg-gradient-to-r from-blue-500 to-blue-600 rounded-lg hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 transition-all shadow-sm hover:shadow-md flex items-center justify-center">
              <i className={`fas ${editingPerm ? 'fa-save' : 'fa-plus'} mr-2`}></i>
              {editingPerm ? '保存修改' : '创建权限'}
            </button>
          </div>
        }
      >
        <div className="space-y-6">
          {/* 资源选择 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">资源 (schema.table)</label>
            {tables.length > 0 ? (
              <select value={form.resource} onChange={e => setForm(f => ({ ...f, resource: e.target.value }))} className="w-full input-base">
                <option value="">选择表...</option>
                {tables.map(t => (
                  <option key={t} value={`${currentSchema}.${t}`}>{currentSchema}.{t}</option>
                ))}
              </select>
            ) : (
              <input type="text" value={form.resource} onChange={e => setForm(f => ({ ...f, resource: e.target.value }))} placeholder="public.posts" className="w-full input-base" />
            )}
          </div>

          {/* 操作类型 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">操作类型</label>
            <div className="flex gap-2">
              {ACTIONS.map(a => (
                <button key={a} onClick={() => setForm(f => ({ ...f, action: a }))}
                  className={`px-4 py-2 text-sm rounded-lg transition-colors ${form.action === a ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
                  {a}
                </button>
              ))}
            </div>
          </div>

          {/* 行级条件 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">行级过滤条件</label>
            <p className="text-xs text-gray-500 mb-3">满足条件的行才可被访问。支持 <code className="bg-gray-100 px-1 rounded">:current_user_id</code> 变量。</p>

            {form.conditions.length > 0 && (
              <div className="space-y-2 mb-3">
                {form.conditions.map((c, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <code className="flex-1 text-sm bg-gray-50 border border-gray-200 px-3 py-2 rounded">{c}</code>
                    <button onClick={() => removeCondition(i)} className="text-red-400 hover:text-red-600">
                      <i className="fas fa-times"></i>
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2 mb-3">
              <input type="text" value={form.newCondition} onChange={e => setForm(f => ({ ...f, newCondition: e.target.value }))}
                placeholder="author_id = :current_user_id"
                onKeyDown={e => e.key === 'Enter' && addCondition()}
                className="flex-1 input-base font-mono text-sm" />
              <button onClick={() => addCondition()} disabled={!form.newCondition.trim()} className="px-4 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 disabled:opacity-50">添加</button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {CONDITION_TEMPLATES.map(tpl => (
                <button key={tpl.value} onClick={() => addCondition(tpl.value)}
                  className="text-left p-3 border border-gray-200 rounded-lg hover:border-blue-300 hover:bg-blue-50 transition-colors">
                  <p className="text-xs font-medium text-gray-900">{tpl.label}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{tpl.hint}</p>
                </button>
              ))}
            </div>
          </div>

          {/* 列过滤 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">列级权限（可选）</label>
            <p className="text-xs text-gray-500 mb-3">不选择则允许所有列。选择后仅返回勾选的列。</p>
            <div className="flex gap-2 mb-2">
              <input type="text" value={form.newColumn} onChange={e => setForm(f => ({ ...f, newColumn: e.target.value }))}
                placeholder="输入列名并添加"
                onKeyDown={e => { if (e.key === 'Enter' && form.newColumn.trim()) { toggleColumn(form.newColumn.trim()); setForm(f => ({ ...f, newColumn: '' })) } }}
                className="flex-1 input-base text-sm" />
              <button onClick={() => { if (form.newColumn.trim()) { toggleColumn(form.newColumn.trim()); setForm(f => ({ ...f, newColumn: '' })) } }}
                className="px-4 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200">添加</button>
            </div>
            {form.allowed_columns && form.allowed_columns.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {form.allowed_columns.map(c => (
                  <span key={c} className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded">
                    {c}
                    <button onClick={() => toggleColumn(c)} className="hover:text-red-600"><i className="fas fa-times text-[10px]"></i></button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* 描述 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">描述（可选）</label>
            <input type="text" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="描述这条权限的用途" className="w-full input-base" />
          </div>
        </div>
      </Drawer>
    </div>
  )
}
