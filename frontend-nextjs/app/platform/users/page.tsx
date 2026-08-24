'use client'

import { useState, useEffect, useMemo } from 'react'
import { adminAPI } from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { useNotification } from '@/hooks/useNotification'
import Drawer from '@/components/Drawer'

// ──────────────────────────────────────────────
// 类型
// ──────────────────────────────────────────────
interface UserTenantMembership {
  tenant_id: number
  tenant_name: string
  role: string // owner | admin | member | viewer
}

interface PlatformUser {
  id: number
  username: string
  email: string
  is_superadmin: boolean
  created_at: string
  // 后端在没有租户成员关系时会返回 null（FILTER (WHERE t.id IS NOT NULL) 的结果）
  tenants: UserTenantMembership[] | null
}

interface TenantOption {
  id: number
  name: string
  slug: string
}

const TENANT_ROLES: { value: string; label: string }[] = [
  { value: 'owner', label: 'Owner（所有者）' },
  { value: 'admin', label: 'Admin（管理员）' },
  { value: 'member', label: 'Member（成员）' },
  { value: 'viewer', label: 'Viewer（只读）' },
]

const ROLE_BADGE: Record<string, string> = {
  owner: 'bg-purple-100 text-purple-700',
  admin: 'bg-blue-100 text-blue-700',
  member: 'bg-green-100 text-green-700',
  viewer: 'bg-gray-100 text-gray-700',
}

const formatDate = (raw: string): string => {
  const d = new Date(raw)
  if (isNaN(d.getTime())) return raw
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 与后端 admin_handlers::validate_password 一致：≥8 位，含大写/小写/数字。
const isStrongPassword = (p: string): boolean =>
  p.length >= 8 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p)

// ──────────────────────────────────────────────
// 页面
// ──────────────────────────────────────────────
export default function UsersPage() {
  const notify = useNotification()
  const currentUser = useAppStore((s) => s.currentUser)

  const [users, setUsers] = useState<PlatformUser[]>([])
  const [tenants, setTenants] = useState<TenantOption[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  // 详情抽屉
  const [selected, setSelected] = useState<PlatformUser | null>(null)
  const [editingUsername, setEditingUsername] = useState<string>('')
  const [savingUsername, setSavingUsername] = useState(false)
  const [savingSuperadmin, setSavingSuperadmin] = useState(false)
  const [showResetForm, setShowResetForm] = useState(false)
  const [resetPwd, setResetPwd] = useState({ p1: '', p2: '' })
  const [resetting, setResetting] = useState(false)
  const [deletingUser, setDeletingUser] = useState(false)
  const [assignTenantId, setAssignTenantId] = useState<number | ''>('')
  const [assignRole, setAssignRole] = useState<string>('member')
  const [assigning, setAssigning] = useState(false)

  // 创建用户抽屉
  const [showCreate, setShowCreate] = useState(false)
  const [newUser, setNewUser] = useState({
    username: '',
    email: '',
    password: '',
    confirm: '',
    is_superadmin: false,
  })
  const [creating, setCreating] = useState(false)

  const isSuperAdmin = !!currentUser?.is_superadmin

  // ──────────────────────────────────────────────
  // 数据加载
  // ──────────────────────────────────────────────
  const loadUsers = async () => {
    try {
      const res = await adminAPI.listAllUsers()
      setUsers(res.data || [])
    } catch (err: any) {
      notify.error(err)
    }
  }

  const loadTenants = async () => {
    try {
      const res = await adminAPI.listAllTenants()
      const opts: TenantOption[] = (res.data || []).map((t: any) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
      }))
      setTenants(opts)
    } catch (err: any) {
      console.error('加载租户列表失败:', err)
    }
  }

  const loadAll = async () => {
    if (!isSuperAdmin) return
    setLoading(true)
    await Promise.all([loadUsers(), loadTenants()])
    setLoading(false)
  }

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuperAdmin])

  // 选中的用户在列表刷新后保持同步；同时把"正在编辑的用户名"重置成最新值
  useEffect(() => {
    if (!selected) {
      setEditingUsername('')
      setShowResetForm(false)
      setResetPwd({ p1: '', p2: '' })
      return
    }
    const fresh = users.find((u) => u.id === selected.id)
    if (fresh) {
      setSelected(fresh)
      setEditingUsername(fresh.username)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [users])

  useEffect(() => {
    if (selected) setEditingUsername(selected.username)
  }, [selected?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ──────────────────────────────────────────────
  // 派生数据
  // ──────────────────────────────────────────────
  const filteredUsers = useMemo(() => {
    if (!search.trim()) return users
    const kw = search.trim().toLowerCase()
    return users.filter(
      (u) =>
        u.username.toLowerCase().includes(kw) ||
        u.email.toLowerCase().includes(kw),
    )
  }, [users, search])

  const stats = useMemo(() => {
    const total = users.length
    const supers = users.filter((u) => u.is_superadmin).length
    const withTenant = users.filter((u) => (u.tenants?.length || 0) > 0).length
    return { total, supers, withTenant }
  }, [users])

  const joinedTenantIds = useMemo(
    () => new Set((selected?.tenants || []).map((t) => t.tenant_id)),
    [selected],
  )

  const availableTenantsForAssign = useMemo(
    () => tenants.filter((t) => !joinedTenantIds.has(t.id)),
    [tenants, joinedTenantIds],
  )

  const isSelf = !!selected && currentUser?.id === selected.id
  const isLastSuper = stats.supers <= 1
  // 不能删自己；不能删唯一的超管
  const canDelete = !!selected && !isSelf && !(selected.is_superadmin && isLastSuper)
  // 不能取消自己的超管；不能取消最后一个超管的超管
  const canTogglePromote =
    !!selected &&
    !(selected.is_superadmin && (isSelf || isLastSuper))

  // ──────────────────────────────────────────────
  // 操作
  // ──────────────────────────────────────────────
  const handleCreate = async () => {
    const username = newUser.username.trim()
    const email = newUser.email.trim()

    if (!username) return notify.warning('请输入用户名')
    if (!email || !email.includes('@')) return notify.warning('请输入合法邮箱')
    if (!isStrongPassword(newUser.password))
      return notify.warning('密码至少 8 位，且需包含大写字母、小写字母和数字')
    if (newUser.password !== newUser.confirm)
      return notify.warning('两次输入的密码不一致')

    setCreating(true)
    try {
      await adminAPI.createUser({
        username,
        email,
        password: newUser.password,
        is_superadmin: newUser.is_superadmin,
      })
      notify.success('用户已创建')
      setShowCreate(false)
      setNewUser({ username: '', email: '', password: '', confirm: '', is_superadmin: false })
      await loadUsers()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setCreating(false)
    }
  }

  const handleSaveUsername = async () => {
    if (!selected) return
    const trimmed = editingUsername.trim()
    if (!trimmed) return notify.warning('用户名不能为空')
    if (trimmed === selected.username) return // 没改

    setSavingUsername(true)
    try {
      await adminAPI.updateUser(selected.id, { username: trimmed })
      notify.success('用户名已更新')
      await loadUsers()
    } catch (err: any) {
      notify.error(err)
      setEditingUsername(selected.username)
    } finally {
      setSavingUsername(false)
    }
  }

  const handleToggleSuperadmin = async () => {
    if (!selected) return
    const next = !selected.is_superadmin
    const verb = next ? '提升为超级管理员' : '取消超级管理员身份'
    if (!window.confirm(`确认要${verb}用户 "${selected.email}" 吗？\n\n注意：操作会立刻吊销该用户的所有现存会话，对方需要重新登录。`)) return

    setSavingSuperadmin(true)
    try {
      await adminAPI.updateUser(selected.id, { is_superadmin: next })
      notify.success(`已${verb}`)
      await loadUsers()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setSavingSuperadmin(false)
    }
  }

  const handleResetPassword = async () => {
    if (!selected) return
    if (!isStrongPassword(resetPwd.p1))
      return notify.warning('密码至少 8 位，且需包含大写字母、小写字母和数字')
    if (resetPwd.p1 !== resetPwd.p2)
      return notify.warning('两次输入的密码不一致')

    setResetting(true)
    try {
      await adminAPI.resetUserPassword(selected.id, resetPwd.p1)
      notify.success('密码已重置，对方需要重新登录')
      setShowResetForm(false)
      setResetPwd({ p1: '', p2: '' })
    } catch (err: any) {
      notify.error(err)
    } finally {
      setResetting(false)
    }
  }

  const handleDeleteUser = async () => {
    if (!selected || !canDelete) return
    if (!window.confirm(
      `确定要彻底删除用户 "${selected.email}" 吗？\n\n` +
      `这会同时删除：\n` +
      `  · 该用户在所有租户中的成员关系\n` +
      `  · 该用户的所有活跃会话和 SSO 绑定\n\n` +
      `操作不可恢复！`
    )) return

    setDeletingUser(true)
    try {
      await adminAPI.deleteUser(selected.id)
      notify.success('用户已删除')
      setSelected(null)
      await loadUsers()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setDeletingUser(false)
    }
  }

  const handleAssignTenant = async () => {
    if (!selected || !assignTenantId) return notify.warning('请选择要加入的项目')
    setAssigning(true)
    try {
      await adminAPI.assignUserToTenant(selected.id, {
        tenant_id: Number(assignTenantId),
        role: assignRole,
      })
      notify.success('已加入项目')
      setAssignTenantId('')
      setAssignRole('member')
      await loadUsers()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setAssigning(false)
    }
  }

  const handleRemoveTenant = async (tenantId: number, tenantName: string) => {
    if (!selected) return
    if (!window.confirm(`确定要把用户 "${selected.email}" 从项目 "${tenantName}" 中移除吗？`)) return
    try {
      await adminAPI.removeUserFromTenant(selected.id, tenantId)
      notify.success('已从项目中移除')
      await loadUsers()
    } catch (err: any) {
      notify.error(err)
    }
  }

  // ──────────────────────────────────────────────
  // 非超管访问拦截
  // ──────────────────────────────────────────────
  if (!isSuperAdmin) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-amber-100 flex items-center justify-center">
            <i className="fas fa-shield-alt text-2xl text-amber-500"></i>
          </div>
          <h2 className="text-lg font-semibold text-gray-800 mb-2">需要超级管理员权限</h2>
          <p className="text-sm text-gray-500">
            用户管理仅对平台超级管理员开放，请使用具有 <code className="px-1 py-0.5 bg-gray-100 rounded">is_superadmin</code> 标志的账号登录后再访问。
          </p>
        </div>
      </div>
    )
  }

  // ──────────────────────────────────────────────
  // UI
  // ──────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">用户管理</h1>
          <p className="text-sm text-gray-500 mt-1">
            管理平台账号、查看项目成员关系并分配项目（项目隶属于组织/租户）
          </p>
        </div>
        <button onClick={() => setShowCreate(true)} className="btn-primary">
          <i className="fas fa-user-plus mr-2"></i>创建用户
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard icon="fa-users" color="blue" label="平台用户总数" value={stats.total} />
        <StatCard icon="fa-user-shield" color="purple" label="超级管理员" value={stats.supers} />
        <StatCard icon="fa-building" color="green" label="已加入租户" value={stats.withTenant} />
      </div>

      <div className="card">
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm"></i>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="按用户名 / 邮箱搜索"
              className="input-base pl-9 h-9"
            />
          </div>
          <span className="text-xs text-gray-500 ml-auto">
            共 {filteredUsers.length} 条 / 全部 {users.length} 条
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
              <tr>
                <th className="px-4 py-3 text-left font-medium">用户</th>
                <th className="px-4 py-3 text-left font-medium">邮箱</th>
                <th className="px-4 py-3 text-left font-medium">平台角色</th>
                <th className="px-4 py-3 text-left font-medium">所属租户</th>
                <th className="px-4 py-3 text-left font-medium">创建时间</th>
                <th className="px-4 py-3 text-right font-medium w-32">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-gray-400">
                    <i className="fas fa-spinner fa-spin mr-2"></i>加载中...
                  </td>
                </tr>
              ) : filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-gray-400">
                    {search ? '没有匹配的用户' : '暂无用户'}
                  </td>
                </tr>
              ) : (
                filteredUsers.map((u) => {
                  const rowIsSelf = currentUser?.id === u.id
                  return (
                    <tr key={u.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-white text-sm font-semibold">
                            {u.username.slice(0, 1).toUpperCase()}
                          </div>
                          <div>
                            <p className="font-medium text-gray-900 flex items-center gap-2">
                              {u.username}
                              {rowIsSelf && (
                                <span className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 font-normal">你</span>
                              )}
                            </p>
                            <p className="text-xs text-gray-400">ID #{u.id}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-700">{u.email}</td>
                      <td className="px-4 py-3">
                        {u.is_superadmin ? (
                          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 font-medium">
                            <i className="fas fa-crown text-xs"></i>超级管理员
                          </span>
                        ) : (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">普通用户</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {(u.tenants?.length || 0) === 0 ? (
                          <span className="text-xs text-gray-400">未加入任何租户</span>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {u.tenants!.slice(0, 3).map((t) => (
                              <span
                                key={t.tenant_id}
                                className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded ${
                                  ROLE_BADGE[t.role] || 'bg-gray-100 text-gray-600'
                                }`}
                                title={`${t.tenant_name} · ${t.role}`}
                              >
                                {t.tenant_name}
                                <span className="opacity-60">·</span>
                                <span className="opacity-80">{t.role}</span>
                              </span>
                            ))}
                            {(u.tenants?.length || 0) > 3 && (
                              <span className="text-xs text-gray-400">+{u.tenants!.length - 3}</span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{formatDate(u.created_at)}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => setSelected(u)}
                          className="text-xs text-blue-600 hover:text-blue-700 hover:underline"
                        >
                          查看 / 管理
                        </button>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 详情抽屉 */}
      <Drawer
        isOpen={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? `用户 · ${selected.username}` : ''}
        size="lg"
      >
        {selected && (
          <div className="space-y-6">
            {/* 基本信息（用户名可改） */}
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">基本信息</h4>
              <div className="bg-gray-50 rounded-lg p-4 space-y-3 text-sm">
                <Field label="用户 ID" value={`#${selected.id}`} />
                <div>
                  <label className="block text-gray-500 text-xs mb-1.5">用户名</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={editingUsername}
                      onChange={(e) => setEditingUsername(e.target.value)}
                      className="flex-1 input-base h-9"
                    />
                    <button
                      onClick={handleSaveUsername}
                      disabled={savingUsername || editingUsername.trim() === selected.username || !editingUsername.trim()}
                      className="btn-primary h-9 px-4 text-xs disabled:opacity-50"
                    >
                      {savingUsername ? <i className="fas fa-spinner fa-spin"></i> : '保存'}
                    </button>
                  </div>
                </div>
                <Field label="邮箱" value={selected.email} />
                <Field label="创建时间" value={formatDate(selected.created_at)} />
              </div>
            </section>

            {/* 平台角色（超管开关） */}
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">平台角色</h4>
              <div className="border border-gray-200 rounded-lg px-4 py-3 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    {selected.is_superadmin ? (
                      <span className="text-purple-700"><i className="fas fa-crown mr-1.5"></i>超级管理员</span>
                    ) : (
                      <span>普通用户</span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {selected.is_superadmin
                      ? '可访问平台所有功能，包括其他租户的数据'
                      : '仅能访问自己所属租户中获授权的资源'}
                  </p>
                </div>
                <button
                  onClick={handleToggleSuperadmin}
                  disabled={savingSuperadmin || (!canTogglePromote)}
                  title={
                    !canTogglePromote
                      ? selected.is_superadmin && isSelf
                        ? '不能取消自己的超级管理员身份'
                        : selected.is_superadmin && isLastSuper
                          ? '系统至少需要保留一个超级管理员'
                          : ''
                      : ''
                  }
                  className={`text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    selected.is_superadmin
                      ? 'bg-amber-50 text-amber-700 hover:bg-amber-100'
                      : 'bg-purple-50 text-purple-700 hover:bg-purple-100'
                  }`}
                >
                  {savingSuperadmin ? (
                    <><i className="fas fa-spinner fa-spin mr-1.5"></i>处理中...</>
                  ) : selected.is_superadmin ? (
                    <><i className="fas fa-user-minus mr-1.5"></i>取消超管</>
                  ) : (
                    <><i className="fas fa-crown mr-1.5"></i>提升为超管</>
                  )}
                </button>
              </div>
            </section>

            {/* 重置密码 */}
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">重置密码</h4>
              {!showResetForm ? (
                <button
                  onClick={() => setShowResetForm(true)}
                  className="w-full border border-dashed border-gray-300 rounded-lg py-3 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  <i className="fas fa-key mr-2"></i>设置一个新密码并强制对方重新登录
                </button>
              ) : (
                <div className="border border-gray-200 rounded-lg p-4 space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">新密码</label>
                    <input
                      type="password"
                      value={resetPwd.p1}
                      onChange={(e) => setResetPwd({ ...resetPwd, p1: e.target.value })}
                      placeholder="≥ 8 位，含大小写和数字"
                      className="w-full input-base"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">确认新密码</label>
                    <input
                      type="password"
                      value={resetPwd.p2}
                      onChange={(e) => setResetPwd({ ...resetPwd, p2: e.target.value })}
                      placeholder="再次输入"
                      className="w-full input-base"
                    />
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={() => {
                        setShowResetForm(false)
                        setResetPwd({ p1: '', p2: '' })
                      }}
                      className="flex-1 h-9 text-xs text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                    >
                      取消
                    </button>
                    <button
                      onClick={handleResetPassword}
                      disabled={resetting}
                      className="flex-1 h-9 text-xs text-white bg-gradient-to-r from-blue-500 to-blue-600 rounded-lg hover:from-blue-600 hover:to-blue-700 disabled:opacity-50"
                    >
                      {resetting ? (
                        <><i className="fas fa-spinner fa-spin mr-1.5"></i>重置中...</>
                      ) : (
                        <><i className="fas fa-check mr-1.5"></i>确认重置</>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </section>

            {/* 项目成员关系（DB: user_tenants；产品层「项目」隶属于组织） */}
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
                项目成员关系（{selected.tenants?.length || 0}）
              </h4>
              {(selected.tenants?.length || 0) === 0 ? (
                <div className="text-sm text-gray-400 bg-gray-50 rounded-lg p-4 text-center">
                  该用户还没有加入任何项目
                </div>
              ) : (
                <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
                  {selected.tenants!.map((t) => (
                    <div key={t.tenant_id} className="flex items-center justify-between px-4 py-3">
                      <div>
                        <p className="text-sm font-medium text-gray-900">{t.tenant_name}</p>
                        <span
                          className={`inline-block mt-1 text-xs px-2 py-0.5 rounded ${
                            ROLE_BADGE[t.role] || 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {t.role}
                        </span>
                      </div>
                      <button
                        onClick={() => handleRemoveTenant(t.tenant_id, t.tenant_name)}
                        className="text-xs text-red-500 hover:text-red-700"
                      >
                        <i className="fas fa-user-minus mr-1"></i>移除
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* 加入新项目 */}
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">加入新项目</h4>
              {availableTenantsForAssign.length === 0 ? (
                <div className="text-sm text-gray-400 bg-gray-50 rounded-lg p-4 text-center">
                  {tenants.length === 0
                    ? '系统暂无任何项目，请先在「租户管理」创建租户，再在租户控制台开通项目'
                    : '该用户已加入全部现有项目'}
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">租户</label>
                    <select
                      value={assignTenantId}
                      onChange={(e) => setAssignTenantId(e.target.value ? Number(e.target.value) : '')}
                      className="w-full input-base"
                    >
                      <option value="">— 选择租户 —</option>
                      {availableTenantsForAssign.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}（{t.slug}）
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">角色</label>
                    <select
                      value={assignRole}
                      onChange={(e) => setAssignRole(e.target.value)}
                      className="w-full input-base"
                    >
                      {TENANT_ROLES.map((r) => (
                        <option key={r.value} value={r.value}>{r.label}</option>
                      ))}
                    </select>
                  </div>
                  <button
                    onClick={handleAssignTenant}
                    disabled={!assignTenantId || assigning}
                    className="btn-primary w-full disabled:opacity-50"
                  >
                    {assigning ? (
                      <><i className="fas fa-spinner fa-spin mr-2"></i>处理中...</>
                    ) : (
                      <><i className="fas fa-plus mr-2"></i>加入租户</>
                    )}
                  </button>
                </div>
              )}
            </section>

            {/* 危险区 */}
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-red-400 mb-3">危险操作</h4>
              <div className="border border-red-200 bg-red-50/50 rounded-lg p-4">
                <p className="text-sm text-gray-700 font-medium">删除用户</p>
                <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                  会同时清除该用户的所有租户成员关系、活跃会话、SSO 绑定和 RBAC 角色绑定。
                  操作不可恢复。
                </p>
                <button
                  onClick={handleDeleteUser}
                  disabled={!canDelete || deletingUser}
                  title={
                    !canDelete
                      ? isSelf
                        ? '不能删除自己'
                        : selected.is_superadmin && isLastSuper
                          ? '系统至少需要保留一个超级管理员'
                          : ''
                      : ''
                  }
                  className="mt-3 text-xs px-3 py-2 rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
                >
                  {deletingUser ? (
                    <><i className="fas fa-spinner fa-spin mr-1.5"></i>删除中...</>
                  ) : (
                    <><i className="fas fa-trash mr-1.5"></i>删除该用户</>
                  )}
                </button>
              </div>
            </section>
          </div>
        )}
      </Drawer>

      {/* 创建用户抽屉 */}
      <Drawer
        isOpen={showCreate}
        onClose={() => {
          setShowCreate(false)
          setNewUser({ username: '', email: '', password: '', confirm: '', is_superadmin: false })
        }}
        title="创建用户"
        size="md"
        footer={
          <div className="flex gap-3">
            <button
              onClick={() => {
                setShowCreate(false)
                setNewUser({ username: '', email: '', password: '', confirm: '', is_superadmin: false })
              }}
              className="flex-1 h-11 px-5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-all"
            >
              取消
            </button>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="flex-1 h-11 px-5 text-sm font-medium text-white bg-gradient-to-r from-blue-500 to-blue-600 rounded-lg hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 transition-all shadow-sm hover:shadow-md flex items-center justify-center"
            >
              {creating ? (
                <><i className="fas fa-spinner fa-spin mr-2"></i>创建中...</>
              ) : (
                <><i className="fas fa-user-plus mr-2"></i>创建用户</>
              )}
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">用户名</label>
            <input
              type="text"
              value={newUser.username}
              onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
              placeholder="如 alice、tom_dev"
              className="w-full input-base"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">邮箱</label>
            <input
              type="email"
              value={newUser.email}
              onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
              placeholder="user@example.com"
              className="w-full input-base"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">初始密码</label>
            <input
              type="password"
              value={newUser.password}
              onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
              placeholder="≥ 8 位，含大小写和数字"
              className="w-full input-base"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">确认密码</label>
            <input
              type="password"
              value={newUser.confirm}
              onChange={(e) => setNewUser({ ...newUser, confirm: e.target.value })}
              placeholder="再次输入密码"
              className="w-full input-base"
            />
          </div>
          <label className="flex items-start gap-3 p-3 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50 transition-colors">
            <input
              type="checkbox"
              checked={newUser.is_superadmin}
              onChange={(e) => setNewUser({ ...newUser, is_superadmin: e.target.checked })}
              className="mt-0.5 w-4 h-4 rounded border-gray-300 text-purple-600"
            />
            <div>
              <p className="text-sm font-medium text-gray-900">直接授予超级管理员权限</p>
              <p className="text-xs text-gray-500 mt-0.5">勾选后该用户开箱可访问平台所有功能。一般只用于创建运维账号。</p>
            </div>
          </label>
          <div className="text-xs text-gray-500 bg-blue-50 border border-blue-100 rounded-lg p-3 leading-relaxed">
            <i className="fas fa-info-circle text-blue-500 mr-1"></i>
            新建用户<strong>不会自动加入任何租户</strong>。创建完成后请在用户列表中点击"查看 / 管理"为其分配租户和角色。
          </div>
        </div>
      </Drawer>
    </div>
  )
}

// ──────────────────────────────────────────────
// 局部子组件
// ──────────────────────────────────────────────
function StatCard({
  icon,
  color,
  label,
  value,
}: {
  icon: string
  color: 'blue' | 'purple' | 'green'
  label: string
  value: number
}) {
  const palette: Record<string, { bg: string; text: string }> = {
    blue: { bg: 'bg-blue-100', text: 'text-blue-600' },
    purple: { bg: 'bg-purple-100', text: 'text-purple-600' },
    green: { bg: 'bg-green-100', text: 'text-green-600' },
  }
  const c = palette[color]
  return (
    <div className="card p-5 flex items-center gap-4">
      <div className={`w-12 h-12 rounded-xl ${c.bg} flex items-center justify-center`}>
        <i className={`fas ${icon} ${c.text} text-lg`}></i>
      </div>
      <div>
        <p className="text-xs text-gray-500">{label}</p>
        <p className="text-2xl font-semibold text-gray-800">{value}</p>
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <span className="text-gray-500 flex-shrink-0">{label}</span>
      <span className="text-gray-900 text-right break-all">{value}</span>
    </div>
  )
}
