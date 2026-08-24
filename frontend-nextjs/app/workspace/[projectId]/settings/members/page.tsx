'use client'

/**
 * `/workspace/[projectId]/settings/members` —— 项目成员管理（W4 / PASE Stage E）。
 *
 * 鉴权：admin+（含 owner / 平台超管）。后端各接口走
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
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'
import Drawer from '@/components/Drawer'

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
const ROLE_CARDS: Array<{ value: RoleOption; title: string; desc: string }> = [
  { value: 'owner',  title: 'Owner',  desc: '可改项目元信息、可管理成员，权限最高' },
  { value: 'admin',  title: 'Admin',  desc: '可管理成员、可读写数据，但不能改项目元信息' },
  { value: 'member', title: 'Member', desc: '日常协作角色：可读写业务数据，不能管理成员' },
  { value: 'viewer', title: 'Viewer', desc: '只读：可看数据但不能修改' },
]

export default function ProjectMembersPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const currentUser = useAppStore((s) => s.currentUser)
  const caps = useCurrentProjectCapabilities()
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
      notify.success(`已把 ${m.username} 改为 ${role}`)
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
      `确认要把 ${m.username} (${m.email}) 从项目里移除吗？\n` +
        `移除后该用户在本项目的 RBAC 角色也会被清除。`,
    )
    if (!ok) return

    setRowSaving((s) => ({ ...s, [m.user_id]: true }))
    try {
      await projectMembersAPI.remove(projectId, m.user_id)
      setMembers((prev) => prev?.filter((x) => x.user_id !== m.user_id) ?? null)
      notify.success(`已移除 ${m.username}`)
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
    if (!username) return notify.warning('用户名不能为空')
    if (!email || !email.includes('@')) return notify.warning('请输入合法邮箱')

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
      notify.success('用户资料已更新')
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
      return notify.warning('密码至少 8 位，且需包含大写字母、小写字母和数字')
    if (pwdForm.p1 !== pwdForm.p2)
      return notify.warning('两次输入的密码不一致')

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
      notify.success('密码已重置，对方需要重新登录')
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
      ? `确认启用用户 "${manageTarget.email}" 吗？`
      : `确认停用用户 "${manageTarget.email}" 吗？\n\n` +
        '此操作全局生效：该用户将无法登录任何项目，所有会话立即失效。'
    if (!window.confirm(confirmMessage)) return

    setTogglingActive(true)
    try {
      await projectMembersAPI.updateStatus(projectId, targetUserId, next)
      setManageTarget((prev) =>
        prev?.user_id === targetUserId ? { ...prev, is_active: next } : prev,
      )
      notify.success(`用户已${next ? '启用' : '停用'}`)
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
      notify.warning('请先在搜索结果里选一个用户')
      return
    }
    setAddSaving(true)
    try {
      const res = await projectMembersAPI.add(projectId, {
        user_id: selectedUser.user_id,
        role: newRole,
      })
      upsertMember(res.data)
      notify.success(`已添加 ${res.data.username} 为 ${res.data.role}`)
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
      notify.warning('请填写用户名（≥3）、有效邮箱、密码（≥6）')
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
      notify.success(`已创建账号 ${res.data.username} 并加入项目（${res.data.role}）`)
      closeAddDrawer()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setAddSaving(false)
    }
  }

  if (!caps.canManageMembers) {
    return (
      <ForbiddenPlaceholder reason="成员管理需要项目 admin 或 owner 角色（或平台超管）" />
    )
  }

  return (
    <div className="p-6 max-w-5xl space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">成员管理</h1>
          <p className="text-sm text-gray-500 mt-1">
            添加 / 移除项目成员，调整他们在本项目的角色。owner 才能改项目元信息；
            admin 可以管理成员；member / viewer 不能进本页。
          </p>
        </div>
        <button
          onClick={() => setShowAddDrawer(true)}
          className="btn-primary"
        >
          <i className="fas fa-user-plus mr-2"></i>
          添加成员
        </button>
      </div>

      {/* 表格 */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500 tracking-wider">
            <tr>
              <th className="px-5 py-3 text-left font-medium">用户</th>
              <th className="px-5 py-3 text-left font-medium">角色</th>
              <th className="px-5 py-3 text-left font-medium">加入时间</th>
              <th className="px-5 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && (
              <tr>
                <td colSpan={4} className="px-5 py-12 text-center text-gray-400">
                  <i className="fas fa-spinner fa-spin mr-2"></i>加载中...
                </td>
              </tr>
            )}
            {!loading && (members?.length ?? 0) === 0 && (
              <tr>
                <td colSpan={4} className="px-5 py-12 text-center text-gray-400">
                  项目暂无成员（异常状态——至少应有一名 owner）
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
                                你
                              </span>
                            )}
                            {!m.is_active && (
                              <span className="text-xs text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded">
                                已停用
                              </span>
                            )}
                            {m.is_superadmin && (
                              <span
                                className="text-xs text-purple-700 bg-purple-50 px-1.5 py-0.5 rounded"
                                title="平台超级管理员，本表角色对其无 UI 限制作用"
                              >
                                平台超管
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
                              ? '不能修改自己的角色'
                              : isLastOwner
                                ? '不能降级项目最后一个 owner'
                                : '改成员角色'
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
                            管理
                          </button>
                        )}
                        <button
                          onClick={() => handleRemove(m)}
                          disabled={disableRemove}
                          className="text-red-600 hover:text-red-800 text-sm disabled:opacity-40 disabled:hover:text-red-600"
                          title={
                            isSelf
                              ? '不能移除自己'
                              : isLastOwner
                                ? '不能移除项目最后一个 owner'
                                : '从项目移除该成员'
                          }
                        >
                          {saving ? (
                            <i className="fas fa-spinner fa-spin"></i>
                          ) : (
                            <>
                              <i className="fas fa-user-minus mr-1"></i>
                              移除
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
        title={manageTarget ? `管理用户 · ${manageTarget.username}` : ''}
        size="lg"
      >
        {manageTarget && (
          <div className="space-y-6">
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-100 rounded-lg p-3">
              修改资料 / 密码 / 启停会影响该用户在所有项目中的账号。
            </p>

            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
                资料
              </h4>
              <div className="border border-gray-200 rounded-lg p-4 space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1.5">
                    用户名
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
                    邮箱
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
                    <><i className="fas fa-spinner fa-spin mr-2"></i>保存中...</>
                  ) : (
                    '保存资料'
                  )}
                </button>
              </div>
            </section>

            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
                密码
              </h4>
              <div className="border border-gray-200 rounded-lg p-4 space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1.5">
                    新密码
                  </label>
                  <input
                    type="password"
                    value={pwdForm.p1}
                    onChange={(e) => setPwdForm((form) => ({ ...form, p1: e.target.value }))}
                    placeholder="≥ 8 位，含大小写和数字"
                    className="w-full input-base"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1.5">
                    确认新密码
                  </label>
                  <input
                    type="password"
                    value={pwdForm.p2}
                    onChange={(e) => setPwdForm((form) => ({ ...form, p2: e.target.value }))}
                    placeholder="再次输入"
                    className="w-full input-base"
                  />
                </div>
                <button
                  onClick={handleResetPassword}
                  disabled={resettingPwd || !pwdForm.p1 || !pwdForm.p2}
                  className="w-full h-10 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {resettingPwd ? (
                    <><i className="fas fa-spinner fa-spin mr-2"></i>重置中...</>
                  ) : (
                    <><i className="fas fa-key mr-2"></i>重置密码</>
                  )}
                </button>
              </div>
            </section>

            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
                状态
              </h4>
              <div className="border border-gray-200 rounded-lg p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-gray-900">
                      当前：{manageTarget.is_active ? '正常' : '已停用'}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                      停用将禁止该账号登录所有项目，并立即吊销所有会话。
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
                      ? '处理中...'
                      : manageTarget.is_active
                        ? '停用用户'
                        : '启用用户'}
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
          onClick={closeAddDrawer}
        >
          <div
            className="bg-white w-full max-w-lg rounded-xl shadow-xl p-6 m-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-gray-900 mb-3">
              添加项目成员
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
                <i className="fas fa-search mr-1.5"></i>添加已有账号
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
                <i className="fas fa-user-plus mr-1.5"></i>新建账号
              </button>
            </div>

            <p className="text-sm text-gray-500 mb-4">
              {addMode === 'search'
                ? '按用户名或邮箱搜索本租户成员（须先加入租户），选中后加入本项目。'
                : '为还没有账号的人直接创建平台账号并加入本项目。请把初始密码线下告知对方，建议其登录后自行修改。'}
            </p>

            <div className="space-y-4">
              {/* 模式一：搜索已有账号 */}
              {addMode === 'search' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  用户 <span className="text-red-500">*</span>
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
                              平台超管
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
                      重新选择
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
                        placeholder="输入用户名或邮箱（至少 2 字符）"
                        autoFocus
                      />
                    </div>
                    {/* 搜索状态 / 结果列表 */}
                    {searchText.trim().length >= 2 && (
                      <div className="mt-1.5 border border-gray-200 rounded-lg overflow-hidden max-h-64 overflow-y-auto">
                        {searching && (
                          <div className="px-3 py-3 text-sm text-gray-500">
                            <i className="fas fa-spinner fa-spin mr-2"></i>搜索中...
                          </div>
                        )}
                        {!searching && searchResults?.length === 0 && (
                          <div className="px-3 py-3 text-sm text-gray-500">
                            没找到匹配的用户。请确认对方已在平台注册。
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
                                        平台超管
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-xs text-gray-500 truncate">
                                    {u.email}
                                  </div>
                                </div>
                                {disabled && (
                                  <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded shrink-0">
                                    已在项目
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
                      用户名 <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={createForm.username}
                      onChange={(e) => setCreateForm((f) => ({ ...f, username: e.target.value }))}
                      className="w-full input-base"
                      placeholder="至少 3 个字符"
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      邮箱 <span className="text-red-500">*</span>
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
                      初始密码 <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={createForm.password}
                      onChange={(e) => setCreateForm((f) => ({ ...f, password: e.target.value }))}
                      className="w-full input-base font-mono"
                      placeholder="至少 6 个字符"
                    />
                    <p className="text-xs text-gray-400 mt-1">
                      明文展示便于复制告知对方；建议其登录后自行修改密码。
                    </p>
                  </div>
                </div>
              )}

              {/* 步骤 2：角色卡片 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  初始角色
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
                          {card.desc}
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
                取消
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
                    ? '创建中...'
                    : '添加中...'
                  : addMode === 'create'
                    ? '创建并加入'
                    : '添加'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
