'use client'

/**
 * `/workspace/[projectId]/settings/members` —— 项目成员管理（W4 / PASE Stage E）。
 *
 * 鉴权：admin+（含 owner / {t('badgeSuperAdmin')}）。后端各接口走
 * `permissions::require_tenant_admin`。前端用 `canManageMembers` 决定是否
 * 渲染。
 *
 * 行为细节：
 *   - 列表：表格 + 角色 inline 改 + 移除按钮
 *   - 添加：抽屉里搜索本租户成员（须先是 organization_members）
 *   - 自己一行：角色 select / 移除按钮 disable + tooltip（与后端 self-protect 对齐）
 *   - owner 角色降级 / 移除时如果是最后一个 owner，后端返回 400，前端直接弹 toast
 */

import { useEffect, useRef, useState, useMemo } from 'react'
import { useParams } from 'next/navigation'
import {
  projectMembersAPI,
  type MemberCandidate,
  type ProjectMember,
} from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import { useNotification } from '@/hooks/useNotification'
import { useTranslations } from 'next-intl'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'
import Drawer from '@/components/Drawer'
import { closeOnBackdropPress } from '@/lib/utils'

const ROLE_OPTIONS = ['owner', 'admin', 'member', 'viewer'] as const
type RoleOption = typeof ROLE_OPTIONS[number]

const ROLE_BADGE: Record<string, string> = {
  owner: 'bg-purple-100 text-purple-800',
  admin: 'bg-blue-100 text-blue-800',
  member: 'bg-green-100 text-green-800',
  viewer: 'bg-gray-200 text-gray-700',
}

const isStrongPassword = (p: string) =>
  p.length >= 8 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /\d/.test(p)

/** 添加成员对话框里的 4 张角色卡——名称 / 一句话职责。 */
const ROLE_CARDS: Array<{ value: RoleOption; title: string; descKey: string }> = [
  { value: 'owner',  title: 'Owner',  descKey: 'roleOwnerDesc' },
  { value: 'admin',  title: 'Admin',  descKey: 'roleAdminDesc' },
  { value: 'member', title: 'Member', descKey: 'roleMemberDesc' },
  { value: 'viewer', title: 'Viewer', descKey: 'roleViewerDesc' },
]

export default function ProjectMembersPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const currentUser = useAppStore((s) => s.currentUser)
  const caps = useCurrentProjectCapabilities()
  const t = useTranslations('wsMembers')
  const notify = useNotification()

  const [members, setMembers] = useState<ProjectMember[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [rowSaving, setRowSaving] = useState<Record<number, boolean>>({})

  // 添加成员对话框
  const [showAddDrawer, setShowAddDrawer] = useState(false)
  // 'search'：搜已注册账号加入；'create'：直接新建账号并加入。
  const [addMode, setAddMode] = useState<'search' | 'create'>('search')
  const [searchText, setSearchText] = useState('')
  const [searchResults, setSearchResults] = useState<MemberCandidate[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [selectedUser, setSelectedUser] = useState<MemberCandidate | null>(null)
  const [newRole, setNewRole] = useState<RoleOption>('member')
  const [addSaving, setAddSaving] = useState(false)
  // 新建账号表单
  const [createForm, setCreateForm] = useState({ username: '', email: '', password: '' })
  // debounce 搜索：300ms 内连续敲键不发请求
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 成员账号管理抽屉
  const [manageTarget, setManageTarget] = useState<ProjectMember | null>(null)
  const [profileForm, setProfileForm] = useState({ username: '', email: '' })
  const [pwdForm, setPwdForm] = useState({ p1: '', p2: '' })
  const [savingProfile, setSavingProfile] = useState(false)
  const [resettingPwd, setResettingPwd] = useState(false)
  const [togglingActive, setTogglingActive] = useState(false)

  const loadMembers = async () => {
    setLoading(true)
    try {
      const res = await projectMembersAPI.list(projectId)
      setMembers(res.data)
    } catch (err: any) {
      notify.error(err)
      setMembers(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (Number.isFinite(projectId) && caps.canManageMembers) loadMembers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, caps.canManageMembers])

  // 当前用户在该项目的 user_id（用于"不能改自己"那行 disable）
  const selfUserId = currentUser?.id ?? -1

  const ownerCount = useMemo(
    () => members?.filter((m) => m.role === 'owner').length ?? 0,
    [members],
  )

  const handleChangeRole = async (m: ProjectMember, role: string) => {
    if (m.role === role) return
    setRowSaving((s) => ({ ...s, [m.user_id]: true }))
    try {
      const res = await projectMembersAPI.updateRole(projectId, m.user_id, role)
      setMembers(
        (prev) =>
          prev?.map((x) => (x.user_id === m.user_id ? res.data : x)) ?? null,
      )
      notify.success(t('roleChanged', { name: m.username, role }))
    } catch (err: any) {
      notify.error(err)
      // 回滚 UI——重新拉一次最简单
      await loadMembers()
    } finally {
      setRowSaving((s) => ({ ...s, [m.user_id]: false }))
    }
  }

  const handleRemove = async (m: ProjectMember) => {
    const ok = window.confirm(
      t('confirmRemove', { name: m.username, email: m.email }),
    )
    if (!ok) return

    setRowSaving((s) => ({ ...s, [m.user_id]: true }))
    try {
      await projectMembersAPI.remove(projectId, m.user_id)
      setMembers((prev) => prev?.filter((x) => x.user_id !== m.user_id) ?? null)
      notify.success(t('removed', { name: m.username }))
    } catch (err: any) {
      notify.error(err)
    } finally {
      setRowSaving((s) => ({ ...s, [m.user_id]: false }))
    }
  }

  const openManage = (m: ProjectMember) => {
    setManageTarget(m)
    setProfileForm({ username: m.username, email: m.email })
    setPwdForm({ p1: '', p2: '' })
  }

  const handleSaveProfile = async () => {
    if (!manageTarget) return
    const targetUserId = manageTarget.user_id
    const username = profileForm.username.trim()
    const email = profileForm.email.trim()
    if (!username) return notify.warning(t('errUsername'))
    if (!email || !email.includes('@')) return notify.warning(t('errEmail'))

    setSavingProfile(true)
    try {
      const res = await projectMembersAPI.updateProfile(
        projectId,
        targetUserId,
        { username, email },
      )
      setManageTarget((prev) => {
        if (prev?.user_id !== targetUserId) return prev
        setProfileForm({ username: res.data.username, email: res.data.email })
        return { ...prev, username: res.data.username, email: res.data.email }
      })
      notify.success(t('profileUpdated'))
      await loadMembers()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setSavingProfile(false)
    }
  }

  const handleResetPassword = async () => {
    if (!manageTarget) return
    const targetUserId = manageTarget.user_id
    if (!isStrongPassword(pwdForm.p1))
      return notify.warning(t('errPwdRule'))
    if (pwdForm.p1 !== pwdForm.p2)
      return notify.warning(t('errPwdMismatch'))

    setResettingPwd(true)
    try {
      await projectMembersAPI.resetPassword(
        projectId,
        targetUserId,
        pwdForm.p1,
      )
      setManageTarget((prev) => {
        if (prev?.user_id !== targetUserId) return prev
        setPwdForm({ p1: '', p2: '' })
        return prev
      })
      notify.success(t('pwdReset'))
    } catch (err: any) {
      notify.error(err)
    } finally {
      setResettingPwd(false)
    }
  }

  const handleToggleActive = async () => {
    if (!manageTarget) return
    const targetUserId = manageTarget.user_id
    const next = !manageTarget.is_active
    const confirmMessage = next
      ? t('confirmEnable', { email: manageTarget.email })
      : t('confirmDisable', { email: manageTarget.email })
    if (!window.confirm(confirmMessage)) return

    setTogglingActive(true)
    try {
      await projectMembersAPI.updateStatus(projectId, targetUserId, next)
      setManageTarget((prev) =>
        prev?.user_id === targetUserId ? { ...prev, is_active: next } : prev,
      )
      notify.success(next ? t('userEnabled') : t('userDisabled'))
      await loadMembers()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setTogglingActive(false)
    }
  }

  // 关闭对话框时把状态全部清回缺省，避免下次打开还残留上次搜索结果
  const closeAddDrawer = () => {
    setShowAddDrawer(false)
    setAddMode('search')
    setSearchText('')
    setSearchResults(null)
    setSelectedUser(null)
    setNewRole('member')
    setCreateForm({ username: '', email: '', password: '' })
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
    }
  }

  // 输入框 onChange：debounce 300ms 后发请求
  const handleSearchChange = (value: string) => {
    setSearchText(value)
    setSelectedUser(null)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    const trimmed = value.trim()
    if (trimmed.length < 2) {
      setSearchResults(null)
      setSearching(false)
      return
    }
    setSearching(true)
    searchTimerRef.current = setTimeout(async () => {
      try {
        const res = await projectMembersAPI.search(projectId, trimmed)
        setSearchResults(res.data)
      } catch (err: any) {
        notify.error(err)
        setSearchResults([])
      } finally {
        setSearching(false)
      }
    }, 300)
  }

  // 把新成员合并进列表：upsert（后端 add 是 upsert，create 是新账号）。
  const upsertMember = (m: ProjectMember) => {
    setMembers((prev) => {
      if (!prev) return [m]
      const exists = prev.some((x) => x.user_id === m.user_id)
      return exists
        ? prev.map((x) => (x.user_id === m.user_id ? m : x))
        : [...prev, m]
    })
  }

  const handleAdd = async () => {
    if (!selectedUser) {
      notify.warning(t('errSelectUser'))
      return
    }
    setAddSaving(true)
    try {
      const res = await projectMembersAPI.add(projectId, {
        user_id: selectedUser.user_id,
        role: newRole,
      })
      upsertMember(res.data)
      notify.success(t('added', { name: res.data.username, role: res.data.role }))
      closeAddDrawer()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setAddSaving(false)
    }
  }

  const createFormValid =
    createForm.username.trim().length >= 3 &&
    createForm.email.trim().includes('@') &&
    createForm.password.length >= 6

  const handleCreateUser = async () => {
    if (!createFormValid) {
      notify.warning(t('errCreateForm'))
      return
    }
    setAddSaving(true)
    try {
      const res = await projectMembersAPI.createUser(projectId, {
        username: createForm.username.trim(),
        email: createForm.email.trim(),
        password: createForm.password,
        role: newRole,
      })
      upsertMember(res.data)
      notify.success(t('created', { name: res.data.username, role: res.data.role }))
      closeAddDrawer()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setAddSaving(false)
    }
  }

  if (!caps.canManageMembers) {
    return (
      <ForbiddenPlaceholder reason={t('forbidden')} />
    )
  }

  return (
    <div className="p-6 max-w-5xl space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {t('subtitle')}
          </p>
        </div>
        <button
          onClick={() => setShowAddDrawer(true)}
          className="btn-primary"
        >
          <i className="fas fa-user-plus mr-2"></i>
          {t('addMember')}
        </button>
      </div>

      {/* 表格 */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500 tracking-wider">
            <tr>
              <th className="px-5 py-3 text-left font-medium">{t('thUser')}</th>
              <th className="px-5 py-3 text-left font-medium">{t('thRole')}</th>
              <th className="px-5 py-3 text-left font-medium">{t('thJoined')}</th>
              <th className="px-5 py-3 text-right font-medium">{t('thActions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && (
              <tr>
                <td colSpan={4} className="px-5 py-12 text-center text-gray-400">
                  <i className="fas fa-spinner fa-spin mr-2"></i>{t('loading')}
                </td>
              </tr>
            )}
            {!loading && (members?.length ?? 0) === 0 && (
              <tr>
                <td colSpan={4} className="px-5 py-12 text-center text-gray-400">
                  {t('emptyMembers')}
                </td>
              </tr>
            )}
            {!loading &&
              members?.map((m) => {
                const isSelf = m.user_id === selfUserId
                const saving = !!rowSaving[m.user_id]
                // 最后一个 owner 不能被改 / 移除（前端先拦一手；后端也兜底）
                const isLastOwner = m.role === 'owner' && ownerCount <= 1
                const disableRoleChange = isSelf || saving || isLastOwner
                const disableRemove = isSelf || saving || isLastOwner

                return (
                  <tr
                    key={m.user_id}
                    className={`hover:bg-gray-50/50 ${!m.is_active ? 'opacity-60' : ''}`}
                  >
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center text-white text-xs font-semibold">
                          {m.username.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <div className="font-medium text-gray-900 flex items-center gap-2">
                            {m.username}
                            {isSelf && (
                              <span className="text-xs text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">
                                {t('badgeYou')}
                              </span>
                            )}
                            {!m.is_active && (
                              <span className="text-xs text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded">
                                {t('badgeDisabled')}
                              </span>
                            )}
                            {m.is_superadmin && (
                              <span
                                className="text-xs text-purple-700 bg-purple-50 px-1.5 py-0.5 rounded"
                                title={t('badgeSuperAdminTitle')}
                              >
                                {t('badgeSuperAdmin')}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-gray-500">{m.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                            ROLE_BADGE[m.role] ?? 'bg-gray-100 text-gray-700'
                          }`}
                        >
                          {m.role}
                        </span>
                        <select
                          value={m.role}
                          onChange={(e) => handleChangeRole(m, e.target.value)}
                          disabled={disableRoleChange}
                          className="text-xs border border-gray-300 rounded px-1.5 py-0.5 disabled:opacity-40"
                          title={
                            isSelf
                              ? t('roleSelfTitle')
                              : isLastOwner
                                ? t('roleLastOwnerTitle')
                                : t('roleChangeTitle')
                          }
                        >
                          {ROLE_OPTIONS.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-gray-600 text-xs">
                      {m.created_at?.split('.')[0] ?? '—'}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <div className="inline-flex items-center gap-3">
                        {!isSelf && (
                          <button
                            onClick={() => openManage(m)}
                            disabled={saving}
                            className="text-blue-600 hover:text-blue-800 text-sm disabled:opacity-40"
                          >
                            <i className="fas fa-user-cog mr-1"></i>
                            {t('manage')}
                          </button>
                        )}
                        <button
                          onClick={() => handleRemove(m)}
                          disabled={disableRemove}
                          className="text-red-600 hover:text-red-800 text-sm disabled:opacity-40 disabled:hover:text-red-600"
                          title={
                            isSelf
                              ? t('removeSelfTitle')
                              : isLastOwner
                                ? t('removeLastOwnerTitle')
                                : t('removeTitle')
                          }
                        >
                          {saving ? (
                            <i className="fas fa-spinner fa-spin"></i>
                          ) : (
                            <>
                              <i className="fas fa-user-minus mr-1"></i>
                              {t('remove')}
                            </>
                          )}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
          </tbody>
        </table>
      </div>

      <Drawer
        isOpen={!!manageTarget}
        onClose={() => setManageTarget(null)}
        title={manageTarget ? t('manageTitle', { name: manageTarget.username }) : ''}
        size="lg"
      >
        {manageTarget && (
          <div className="space-y-6">
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-100 rounded-lg p-3">
              {t('manageNote')}
            </p>

            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
                {t('tabProfile')}
              </h4>
              <div className="border border-gray-200 rounded-lg p-4 space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1.5">
                    {t('fUsername')}
                  </label>
                  <input
                    type="text"
                    value={profileForm.username}
                    onChange={(e) =>
                      setProfileForm((form) => ({ ...form, username: e.target.value }))
                    }
                    className="w-full input-base"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1.5">
                    {t('fEmail')}
                  </label>
                  <input
                    type="email"
                    value={profileForm.email}
                    onChange={(e) =>
                      setProfileForm((form) => ({ ...form, email: e.target.value }))
                    }
                    className="w-full input-base"
                  />
                </div>
                <button
                  onClick={handleSaveProfile}
                  disabled={
                    savingProfile ||
                    !profileForm.username.trim() ||
                    !profileForm.email.trim() ||
                    (profileForm.username.trim() === manageTarget.username &&
                      profileForm.email.trim() === manageTarget.email)
                  }
                  className="btn-primary w-full disabled:opacity-50"
                >
                  {savingProfile ? (
                    <><i className="fas fa-spinner fa-spin mr-2"></i>{t('savingProfile')}</>
                  ) : (
                    t('saveProfile')
                  )}
                </button>
              </div>
            </section>

            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
                {t('tabPassword')}
              </h4>
              <div className="border border-gray-200 rounded-lg p-4 space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1.5">
                    {t('fNewPwd')}
                  </label>
                  <input
                    type="password"
                    value={pwdForm.p1}
                    onChange={(e) => setPwdForm((form) => ({ ...form, p1: e.target.value }))}
                    placeholder={t('phPwd')}
                    className="w-full input-base"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1.5">
                    {t('fConfirmPwd')}
                  </label>
                  <input
                    type="password"
                    value={pwdForm.p2}
                    onChange={(e) => setPwdForm((form) => ({ ...form, p2: e.target.value }))}
                    placeholder={t('phRepeat')}
                    className="w-full input-base"
                  />
                </div>
                <button
                  onClick={handleResetPassword}
                  disabled={resettingPwd || !pwdForm.p1 || !pwdForm.p2}
                  className="w-full h-10 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {resettingPwd ? (
                    <><i className="fas fa-spinner fa-spin mr-2"></i>{t('resetting')}</>
                  ) : (
                    <><i className="fas fa-key mr-2"></i>{t('resetPwd')}</>
                  )}
                </button>
              </div>
            </section>

            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
                {t('tabStatus')}
              </h4>
              <div className="border border-gray-200 rounded-lg p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-gray-900">
                      {t('currentLabel')}{manageTarget.is_active ? t('statusNormal') : t('statusDisabled')}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                      {t('disableWarn')}
                    </p>
                  </div>
                  <button
                    onClick={handleToggleActive}
                    disabled={togglingActive}
                    className={`shrink-0 text-xs px-3 py-2 rounded-lg text-white disabled:opacity-50 ${
                      manageTarget.is_active
                        ? 'bg-red-500 hover:bg-red-600'
                        : 'bg-green-600 hover:bg-green-700'
                    }`}
                  >
                    {togglingActive
                      ? t('processing')
                      : manageTarget.is_active
                        ? t('disableUser')
                        : t('enableUser')}
                  </button>
                </div>
              </div>
            </section>
          </div>
        )}
      </Drawer>

      {/* 添加成员对话框 —— 搜索 + 卡片选角色 */}
      {showAddDrawer && (
        <div
          className="fixed inset-0 bg-black/40 z-40 flex items-end justify-center sm:items-center"
          onMouseDown={closeOnBackdropPress(closeAddDrawer)}
        >
          <div
            className="bg-white w-full max-w-lg rounded-xl shadow-xl p-6 m-4"
          >
            <h3 className="text-lg font-semibold text-gray-900 mb-3">
              {t('addMemberTitle')}
            </h3>

            {/* 模式切换：搜索已有账号 / 新建账号 */}
            <div className="flex p-1 bg-gray-100 rounded-lg mb-4 text-sm">
              <button
                type="button"
                onClick={() => setAddMode('search')}
                className={`flex-1 py-1.5 rounded-md font-medium transition-colors ${
                  addMode === 'search'
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <i className="fas fa-search mr-1.5"></i>{t('tabSearch')}
              </button>
              <button
                type="button"
                onClick={() => setAddMode('create')}
                className={`flex-1 py-1.5 rounded-md font-medium transition-colors ${
                  addMode === 'create'
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <i className="fas fa-user-plus mr-1.5"></i>{t('tabCreate')}
              </button>
            </div>

            <p className="text-sm text-gray-500 mb-4">
              {addMode === 'search'
                ? t('searchHint')
                : t('createHint')}
            </p>

            <div className="space-y-4">
              {/* 模式一：搜索已有账号 */}
              {addMode === 'search' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  {t('fUser')} <span className="text-red-500">*</span>
                </label>
                {selectedUser ? (
                  <div className="flex items-center justify-between border border-blue-300 bg-blue-50/40 rounded-lg px-3 py-2">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center text-white text-sm font-semibold shrink-0">
                        {selectedUser.username.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium text-gray-900 truncate flex items-center gap-2">
                          {selectedUser.username}
                          {selectedUser.is_superadmin && (
                            <span className="text-xs text-purple-700 bg-purple-50 px-1.5 py-0.5 rounded">
                              {t('badgeSuperAdmin')}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-gray-500 truncate">
                          {selectedUser.email}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedUser(null)
                        setSearchText('')
                        setSearchResults(null)
                      }}
                      className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1"
                    >
                      {t('reselect')}
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="relative">
                      <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none"></i>
                      <input
                        type="text"
                        value={searchText}
                        onChange={(e) => handleSearchChange(e.target.value)}
                        className="w-full input-base pl-9"
                        placeholder={t('phSearch')}
                        autoFocus
                      />
                    </div>
                    {/* 搜索状态 / 结果列表 */}
                    {searchText.trim().length >= 2 && (
                      <div className="mt-1.5 border border-gray-200 rounded-lg overflow-hidden max-h-64 overflow-y-auto">
                        {searching && (
                          <div className="px-3 py-3 text-sm text-gray-500">
                            <i className="fas fa-spinner fa-spin mr-2"></i>{t('searching')}
                          </div>
                        )}
                        {!searching && searchResults?.length === 0 && (
                          <div className="px-3 py-3 text-sm text-gray-500">
                            {t('noMatch')}
                          </div>
                        )}
                        {!searching &&
                          searchResults?.map((u) => {
                            const disabled = u.already_member
                            return (
                              <button
                                key={u.user_id}
                                type="button"
                                disabled={disabled}
                                onClick={() => setSelectedUser(u)}
                                className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                                  disabled
                                    ? 'opacity-50 cursor-not-allowed'
                                    : 'hover:bg-gray-50 cursor-pointer'
                                }`}
                              >
                                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center text-white text-xs font-semibold shrink-0">
                                  {u.username.charAt(0).toUpperCase()}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="font-medium text-gray-900 text-sm truncate flex items-center gap-2">
                                    {u.username}
                                    {u.is_superadmin && (
                                      <span className="text-[10px] text-purple-700 bg-purple-50 px-1.5 py-0.5 rounded">
                                        {t('badgeSuperAdmin')}
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-xs text-gray-500 truncate">
                                    {u.email}
                                  </div>
                                </div>
                                {disabled && (
                                  <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded shrink-0">
                                    {t('alreadyIn')}
                                  </span>
                                )}
                              </button>
                            )
                          })}
                      </div>
                    )}
                  </>
                )}
              </div>
              )}

              {/* 模式二：新建账号表单 */}
              {addMode === 'create' && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      {t('fUsername')} <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={createForm.username}
                      onChange={(e) => setCreateForm((f) => ({ ...f, username: e.target.value }))}
                      className="w-full input-base"
                      placeholder={t('phUsername3')}
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      {t('fEmail')} <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="email"
                      value={createForm.email}
                      onChange={(e) => setCreateForm((f) => ({ ...f, email: e.target.value }))}
                      className="w-full input-base"
                      placeholder="user@example.com"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      {t('fInitPwd')} <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={createForm.password}
                      onChange={(e) => setCreateForm((f) => ({ ...f, password: e.target.value }))}
                      className="w-full input-base font-mono"
                      placeholder={t('phPwd6')}
                    />
                    <p className="text-xs text-gray-400 mt-1">
                      {t('initPwdNote')}
                    </p>
                  </div>
                </div>
              )}

              {/* 步骤 2：角色卡片 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  {t('initRole')}
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {ROLE_CARDS.map((card) => {
                    const active = newRole === card.value
                    return (
                      <button
                        key={card.value}
                        type="button"
                        onClick={() => setNewRole(card.value)}
                        className={`text-left border rounded-lg px-3 py-2 transition-colors ${
                          active
                            ? 'border-blue-500 bg-blue-50/60 ring-1 ring-blue-500'
                            : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span
                            className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${
                              ROLE_BADGE[card.value] ?? 'bg-gray-100 text-gray-700'
                            }`}
                          >
                            {card.title}
                          </span>
                          {active && (
                            <i className="fas fa-check-circle text-blue-500 text-xs ml-auto"></i>
                          )}
                        </div>
                        <p className="text-xs text-gray-600 leading-relaxed">
                          {t(card.descKey)}
                        </p>
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-100">
              <button
                onClick={closeAddDrawer}
                disabled={addSaving}
                className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                {t('cancel')}
              </button>
              <button
                onClick={addMode === 'create' ? handleCreateUser : handleAdd}
                disabled={
                  addSaving ||
                  (addMode === 'create' ? !createFormValid : !selectedUser)
                }
                className="btn-primary disabled:opacity-50"
              >
                {addSaving
                  ? addMode === 'create'
                    ? t('creating')
                    : t('adding')
                  : addMode === 'create'
                    ? t('createAndJoin')
                    : t('add')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
