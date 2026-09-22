'use client'

import { useState, useEffect, useMemo } from 'react'
import { adminAPI } from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { useTranslations } from 'next-intl'
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

const TENANT_ROLES: { value: string; key: string }[] = [
  { value: 'owner', key: 'roleOwner' },
  { value: 'admin', key: 'roleAdmin' },
  { value: 'member', key: 'roleMember' },
  { value: 'viewer', key: 'roleViewer' },
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
  const tr = useTranslations('platformUsers')
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
      console.error(tr('loadTenantsFailed'), err)
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

    if (!username) return notify.warning(tr('warnUsername'))
    if (!email || !email.includes('@')) return notify.warning(tr('warnEmail'))
    if (!isStrongPassword(newUser.password))
      return notify.warning(tr('warnPwWeak'))
    if (newUser.password !== newUser.confirm)
      return notify.warning(tr('warnPwMismatch'))

    setCreating(true)
    try {
      await adminAPI.createUser({
        username,
        email,
        password: newUser.password,
        is_superadmin: newUser.is_superadmin,
      })
      notify.success(tr('created'))
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
    if (!trimmed) return notify.warning(tr('warnUsernameEmpty'))
    if (trimmed === selected.username) return // 没改

    setSavingUsername(true)
    try {
      await adminAPI.updateUser(selected.id, { username: trimmed })
      notify.success(tr('usernameUpdated'))
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
    const verb = next ? tr('promote') : tr('demote')
    if (!window.confirm(tr('confirmRole', { verb, email: selected.email }))) return

    setSavingSuperadmin(true)
    try {
      await adminAPI.updateUser(selected.id, { is_superadmin: next })
      notify.success(tr('roleDone', { verb }))
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
      return notify.warning(tr('warnPwWeak'))
    if (resetPwd.p1 !== resetPwd.p2)
      return notify.warning(tr('warnPwMismatch'))

    setResetting(true)
    try {
      await adminAPI.resetUserPassword(selected.id, resetPwd.p1)
      notify.success(tr('pwReset'))
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
      tr('confirmDelete', { email: selected.email })
    )) return

    setDeletingUser(true)
    try {
      await adminAPI.deleteUser(selected.id)
      notify.success(tr('deleted'))
      setSelected(null)
      await loadUsers()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setDeletingUser(false)
    }
  }

  const handleAssignTenant = async () => {
    if (!selected || !assignTenantId) return notify.warning(tr('warnSelectProject'))
    setAssigning(true)
    try {
      await adminAPI.assignUserToTenant(selected.id, {
        tenant_id: Number(assignTenantId),
        role: assignRole,
      })
      notify.success(tr('joinedProject'))
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
    if (!window.confirm(tr('confirmRemove', { email: selected.email, tenant: tenantName }))) return
    try {
      await adminAPI.removeUserFromTenant(selected.id, tenantId)
      notify.success(tr('removedFromProject'))
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
          <h2 className="text-lg font-semibold text-gray-800 mb-2">{tr('needSuperTitle')}</h2>
          <p className="text-sm text-gray-500">
            {tr('needSuperDesc')}
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
          <h1 className="text-2xl font-semibold text-gray-800">{tr('title')}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {tr('subtitle')}
          </p>
        </div>
        <button onClick={() => setShowCreate(true)} className="btn-primary">
          <i className="fas fa-user-plus mr-2"></i>{tr('createUser')}
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard icon="fa-users" color="blue" label={tr('statTotal')} value={stats.total} />
        <StatCard icon="fa-user-shield" color="purple" label={tr('statSupers')} value={stats.supers} />
        <StatCard icon="fa-building" color="green" label={tr('statWithTenant')} value={stats.withTenant} />
      </div>

      <div className="card">
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm"></i>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={tr('searchPlaceholder')}
              className="input-base pl-9 h-9"
            />
          </div>
          <span className="text-xs text-gray-500 ml-auto">
            {tr('countLine', { shown: filteredUsers.length, total: users.length })}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
              <tr>
                <th className="px-4 py-3 text-left font-medium">{tr('colUser')}</th>
                <th className="px-4 py-3 text-left font-medium">{tr('colEmail')}</th>
                <th className="px-4 py-3 text-left font-medium">{tr('colRole')}</th>
                <th className="px-4 py-3 text-left font-medium">{tr('colTenants')}</th>
                <th className="px-4 py-3 text-left font-medium">{tr('colCreated')}</th>
                <th className="px-4 py-3 text-right font-medium w-32">{tr('colActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-gray-400">
                    <i className="fas fa-spinner fa-spin mr-2"></i>{tr('loading')}
                  </td>
                </tr>
              ) : filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-gray-400">
                    {search ? tr('noMatch') : tr('empty')}
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
                                <span className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 font-normal">{tr('you')}</span>
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
                            <i className="fas fa-crown text-xs"></i>{tr('superAdmin')}
                          </span>
                        ) : (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{tr('normalUser')}</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {(u.tenants?.length || 0) === 0 ? (
                          <span className="text-xs text-gray-400">{tr('noTenant')}</span>
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
                          {tr('manage')}
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
        title={selected ? tr('drawerTitle', { name: selected.username }) : ''}
        size="lg"
      >
        {selected && (
          <div className="space-y-6">
            {/* 基本信息（用户名可改） */}
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">{tr('basicInfo')}</h4>
              <div className="bg-gray-50 rounded-lg p-4 space-y-3 text-sm">
                <Field label={tr('userId')} value={`#${selected.id}`} />
                <div>
                  <label className="block text-gray-500 text-xs mb-1.5">{tr('usernameLabel')}</label>
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
                      {savingUsername ? <i className="fas fa-spinner fa-spin"></i> : tr('save')}
                    </button>
                  </div>
                </div>
                <Field label={tr('emailLabel')} value={selected.email} />
                <Field label={tr('createdAt')} value={formatDate(selected.created_at)} />
              </div>
            </section>

            {/* 平台角色（超管开关） */}
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">{tr('platformRole')}</h4>
              <div className="border border-gray-200 rounded-lg px-4 py-3 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    {selected.is_superadmin ? (
                      <span className="text-purple-700"><i className="fas fa-crown mr-1.5"></i>{tr('superAdmin')}</span>
                    ) : (
                      <span>{tr('normalUser')}</span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {selected.is_superadmin
                      ? tr('superDescOn')
                      : tr('superDescOff')}
                  </p>
                </div>
                <button
                  onClick={handleToggleSuperadmin}
                  disabled={savingSuperadmin || (!canTogglePromote)}
                  title={
                    !canTogglePromote
                      ? selected.is_superadmin && isSelf
                        ? tr('cantDemoteSelf')
                        : selected.is_superadmin && isLastSuper
                          ? tr('needOneSuper')
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
                    <><i className="fas fa-spinner fa-spin mr-1.5"></i>{tr('processing')}</>
                  ) : selected.is_superadmin ? (
                    <><i className="fas fa-user-minus mr-1.5"></i>{tr('demoteBtn')}</>
                  ) : (
                    <><i className="fas fa-crown mr-1.5"></i>{tr('promoteBtn')}</>
                  )}
                </button>
              </div>
            </section>

            {/* 重置密码 */}
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">{tr('resetPw')}</h4>
              {!showResetForm ? (
                <button
                  onClick={() => setShowResetForm(true)}
                  className="w-full border border-dashed border-gray-300 rounded-lg py-3 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  <i className="fas fa-key mr-2"></i>{tr('resetPwHint')}
                </button>
              ) : (
                <div className="border border-gray-200 rounded-lg p-4 space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">{tr('newPw')}</label>
                    <input
                      type="password"
                      value={resetPwd.p1}
                      onChange={(e) => setResetPwd({ ...resetPwd, p1: e.target.value })}
                      placeholder={tr('pwPlaceholder')}
                      className="w-full input-base"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">{tr('confirmNewPw')}</label>
                    <input
                      type="password"
                      value={resetPwd.p2}
                      onChange={(e) => setResetPwd({ ...resetPwd, p2: e.target.value })}
                      placeholder={tr('reenter')}
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
                      {tr('cancel')}
                    </button>
                    <button
                      onClick={handleResetPassword}
                      disabled={resetting}
                      className="flex-1 h-9 text-xs text-white bg-gradient-to-r from-blue-500 to-blue-600 rounded-lg hover:from-blue-600 hover:to-blue-700 disabled:opacity-50"
                    >
                      {resetting ? (
                        <><i className="fas fa-spinner fa-spin mr-1.5"></i>{tr('resetting')}</>
                      ) : (
                        <><i className="fas fa-check mr-1.5"></i>{tr('confirmReset')}</>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </section>

            {/* 项目成员关系（DB: user_tenants；产品层「项目」隶属于组织） */}
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
                {tr('memberships', { count: selected.tenants?.length || 0 })}
              </h4>
              {(selected.tenants?.length || 0) === 0 ? (
                <div className="text-sm text-gray-400 bg-gray-50 rounded-lg p-4 text-center">
                  {tr('noMemberships')}
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
                        <i className="fas fa-user-minus mr-1"></i>{tr('remove')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* 加入新项目 */}
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">{tr('joinProject')}</h4>
              {availableTenantsForAssign.length === 0 ? (
                <div className="text-sm text-gray-400 bg-gray-50 rounded-lg p-4 text-center">
                  {tenants.length === 0
                    ? tr('noProjectsHint')
                    : tr('allJoined')}
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">{tr('tenantLabel')}</label>
                    <select
                      value={assignTenantId}
                      onChange={(e) => setAssignTenantId(e.target.value ? Number(e.target.value) : '')}
                      className="w-full input-base"
                    >
                      <option value="">{tr('selectTenant')}</option>
                      {availableTenantsForAssign.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}（{t.slug}）
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">{tr('roleLabel')}</label>
                    <select
                      value={assignRole}
                      onChange={(e) => setAssignRole(e.target.value)}
                      className="w-full input-base"
                    >
                      {TENANT_ROLES.map((r) => (
                        <option key={r.value} value={r.value}>{tr(r.key)}</option>
                      ))}
                    </select>
                  </div>
                  <button
                    onClick={handleAssignTenant}
                    disabled={!assignTenantId || assigning}
                    className="btn-primary w-full disabled:opacity-50"
                  >
                    {assigning ? (
                      <><i className="fas fa-spinner fa-spin mr-2"></i>{tr('processing')}</>
                    ) : (
                      <><i className="fas fa-plus mr-2"></i>{tr('joinTenant')}</>
                    )}
                  </button>
                </div>
              )}
            </section>

            {/* 危险区 */}
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-red-400 mb-3">{tr('dangerZone')}</h4>
              <div className="border border-red-200 bg-red-50/50 rounded-lg p-4">
                <p className="text-sm text-gray-700 font-medium">{tr('deleteUser')}</p>
                <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                  {tr('deleteUserDesc')}
                </p>
                <button
                  onClick={handleDeleteUser}
                  disabled={!canDelete || deletingUser}
                  title={
                    !canDelete
                      ? isSelf
                        ? tr('cantDeleteSelf')
                        : selected.is_superadmin && isLastSuper
                          ? tr('needOneSuper')
                          : ''
                      : ''
                  }
                  className="mt-3 text-xs px-3 py-2 rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
                >
                  {deletingUser ? (
                    <><i className="fas fa-spinner fa-spin mr-1.5"></i>{tr('deleting')}</>
                  ) : (
                    <><i className="fas fa-trash mr-1.5"></i>{tr('deleteUserBtn')}</>
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
        title={tr('createTitle')}
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
              {tr('cancel')}
            </button>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="flex-1 h-11 px-5 text-sm font-medium text-white bg-gradient-to-r from-blue-500 to-blue-600 rounded-lg hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 transition-all shadow-sm hover:shadow-md flex items-center justify-center"
            >
              {creating ? (
                <><i className="fas fa-spinner fa-spin mr-2"></i>{tr('creating')}</>
              ) : (
                <><i className="fas fa-user-plus mr-2"></i>{tr('createUser')}</>
              )}
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">{tr('usernameLabel')}</label>
            <input
              type="text"
              value={newUser.username}
              onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
              placeholder={tr('usernamePlaceholder')}
              className="w-full input-base"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">{tr('emailLabel')}</label>
            <input
              type="email"
              value={newUser.email}
              onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
              placeholder="user@example.com"
              className="w-full input-base"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">{tr('initialPw')}</label>
            <input
              type="password"
              value={newUser.password}
              onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
              placeholder={tr('pwPlaceholder')}
              className="w-full input-base"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">{tr('confirmNewPw')}</label>
            <input
              type="password"
              value={newUser.confirm}
              onChange={(e) => setNewUser({ ...newUser, confirm: e.target.value })}
              placeholder={tr('reenterPw')}
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
              <p className="text-sm font-medium text-gray-900">{tr('grantSuper')}</p>
              <p className="text-xs text-gray-500 mt-0.5">{tr('grantSuperHint')}</p>
            </div>
          </label>
          <div className="text-xs text-gray-500 bg-blue-50 border border-blue-100 rounded-lg p-3 leading-relaxed">
            <i className="fas fa-info-circle text-blue-500 mr-1"></i>
            {tr('createNote')}
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
