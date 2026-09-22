'use client'

/**
 * `/org/[orgId]` —— 租户控制台：管理项目与租户成员（非项目工作区）。
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useParams, useRouter } from 'next/navigation'
import {
  organizationAPI,
  type OrganizationDto,
  type OrgMemberDto,
} from '@/lib/api'
import { useAppStore, type Project } from '@/lib/store'
import {
  deriveOrganizationCapabilities,
} from '@/lib/permissions'
import { useNotification } from '@/hooks/useNotification'
import OrgSidebar, { type OrgNavId } from '@/components/OrgSidebar'
import OrgOperationLogsView from '@/components/OrgOperationLogsView'
import ExecutionLogsView from '@/components/ExecutionLogsView'
import OrgStatsView from '@/components/OrgStatsView'
import OrgMonitorView from '@/components/OrgMonitorView'
import OrgAuditView from '@/components/OrgAuditView'
import OrgAccessMatrixView from '@/components/OrgAccessMatrixView'
import OrgSecurityOverviewView from '@/components/OrgSecurityOverviewView'

type Tab = OrgNavId
type ProjectAddMode = 'org' | 'platform' | 'create'

export default function OrgConsolePage() {
  const t = useTranslations('orgAdminPage')
  const params = useParams<{ orgId: string }>()
  const router = useRouter()
  const notify = useNotification()
  const setCurrentOrganization = useAppStore((s) => s.setCurrentOrganization)
  const currentUser = useAppStore((s) => s.currentUser)

  const orgId = parseInt(params.orgId, 10)
  const [org, setOrg] = useState<OrganizationDto | null>(null)
  const [tab, setTab] = useState<Tab>('projects')
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [members, setMembers] = useState<OrgMemberDto[]>([])
  const [error, setError] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editEmail, setEditEmail] = useState('')
  const [showAddMemberModal, setShowAddMemberModal] = useState(false)
  const [addUserId, setAddUserId] = useState('')
  const [addRole, setAddRole] = useState('member')
  const [addMemberSaving, setAddMemberSaving] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  const [candidates, setCandidates] = useState<
    Array<{ id: number; username: string; email: string }>
  >([])
  const [showTransferModal, setShowTransferModal] = useState(false)
  const [editMemberTarget, setEditMemberTarget] = useState<OrgMemberDto | null>(null)
  const [editMemberRole, setEditMemberRole] = useState('member')
  const [editMemberSaving, setEditMemberSaving] = useState(false)

  /** 租户控台：把成员加入某项目 */
  const [projectAddTarget, setProjectAddTarget] = useState<Project | null>(null)
  const [projectAddUserId, setProjectAddUserId] = useState('')
  const [projectAddRole, setProjectAddRole] = useState('member')
  const [projectAddSaving, setProjectAddSaving] = useState(false)
  const [projectAddMode, setProjectAddMode] = useState<ProjectAddMode>('org')
  const [matrixReloadToken, setMatrixReloadToken] = useState(0)
  const [projectPlatformQ, setProjectPlatformQ] = useState('')
  const [projectPlatformCandidates, setProjectPlatformCandidates] = useState<
    Array<{ id: number; username: string; email: string }>
  >([])
  const [projectCreateForm, setProjectCreateForm] = useState({
    username: '',
    email: '',
    password: '',
  })
  const projectCreateFormValid =
    projectCreateForm.username.trim().length >= 3 &&
    projectCreateForm.email.includes('@') &&
    projectCreateForm.password.length >= 6

  const caps = deriveOrganizationCapabilities(org?.user_role || 'member')
  const isSuperadmin = !!currentUser?.is_superadmin
  const canManageProjects = caps.canCreateProject || isSuperadmin
  const canArchive = caps.canArchiveProject || isSuperadmin
  const canTransfer = caps.canTransferOwner || isSuperadmin
  const canViewLogs = caps.canViewOrgLogs || isSuperadmin
  const [transferUserId, setTransferUserId] = useState('')
  const [transferring, setTransferring] = useState(false)

  const load = useCallback(async () => {
    if (!Number.isFinite(orgId) || orgId <= 0) {
      router.replace('/orgs')
      return
    }
    try {
      const orgRes = await organizationAPI.get(orgId)
      const o = orgRes.data.organization
      setOrg(o)
      setCurrentOrganization(o)
      setEditName(o.name)
      setEditEmail(o.contact_email || '')

      const oCaps = deriveOrganizationCapabilities(o.user_role)
      const viewAll = oCaps.canViewAllProjects || isSuperadmin
      const projRes = await organizationAPI.listProjects(orgId, viewAll ? 'all' : undefined)
      setProjects(projRes.data.projects || [])

      // 成员列表：成员 Tab 与「加入项目」弹窗都需要
      if (oCaps.canManageOrgMembers || oCaps.canCreateProject || isSuperadmin) {
        const memRes = await organizationAPI.listMembers(orgId)
        setMembers(memRes.data.members || [])
      }
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        t('errLoadOrgFailed')
      setError(msg)
    }
  }, [orgId, router, setCurrentOrganization, isSuperadmin])

  useEffect(() => {
    if (!localStorage.getItem('token')) {
      router.replace('/login')
      return
    }
    load()
  }, [load, router])

  useEffect(() => {
    const q = projectPlatformQ.trim()
    if (!org || projectAddMode !== 'platform' || q.length < 2) {
      setProjectPlatformCandidates([])
      return
    }

    let cancelled = false
    const timer = window.setTimeout(async () => {
      try {
        const res = await organizationAPI.searchMemberCandidates(org.id, q)
        if (!cancelled) {
          setProjectPlatformCandidates(
            (res.data.candidates || []).map((candidate) => ({
              id: candidate.user_id,
              username: candidate.username,
              email: candidate.email,
            })),
          )
        }
      } catch {
        if (!cancelled) setProjectPlatformCandidates([])
      }
    }, 300)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [org, projectAddMode, projectPlatformQ])

  async function saveSettings() {
    if (!org) return
    try {
      const res = await organizationAPI.patch(org.id, {
        name: editName.trim(),
        contact_email: editEmail.trim() || undefined,
      })
      setOrg(res.data.organization)
      setCurrentOrganization(res.data.organization)
      notify.success(t('successSaved'))
    } catch (err) {
      notify.error(err)
    }
  }

  async function searchUsers(q: string) {
    setSearchQ(q)
    if (!org || q.trim().length < 2) {
      setCandidates([])
      return
    }
    try {
      const res = await organizationAPI.searchMemberCandidates(org.id, q.trim())
      setCandidates(
        (res.data.candidates || []).map((c) => ({
          id: c.user_id,
          username: c.username,
          email: c.email,
        })),
      )
    } catch {
      setCandidates([])
    }
  }

  function openAddMemberModal() {
    setAddUserId('')
    setAddRole('member')
    setSearchQ('')
    setCandidates([])
    setShowAddMemberModal(true)
  }

  function openTransferModal() {
    setTransferUserId('')
    setShowTransferModal(true)
  }

  async function addMember() {
    if (!org || !addUserId) return
    setAddMemberSaving(true)
    try {
      await organizationAPI.addMember(org.id, {
        user_id: Number(addUserId),
        role: addRole,
      })
      notify.success(t('successAddedOrgMember'))
      setShowAddMemberModal(false)
      setAddUserId('')
      setSearchQ('')
      setCandidates([])
      load()
    } catch (err) {
      notify.error(err)
    } finally {
      setAddMemberSaving(false)
    }
  }

  function openEditMemberModal(member: OrgMemberDto) {
    setEditMemberTarget(member)
    setEditMemberRole(member.role)
  }

  async function submitEditMember() {
    if (!org || !editMemberTarget) return
    if (editMemberRole === editMemberTarget.role) {
      setEditMemberTarget(null)
      return
    }
    setEditMemberSaving(true)
    try {
      await organizationAPI.updateMember(org.id, editMemberTarget.user_id, {
        role: editMemberRole,
      })
      notify.success(t('successRoleUpdated'))
      setEditMemberTarget(null)
      load()
    } catch (err) {
      notify.error(err)
    } finally {
      setEditMemberSaving(false)
    }
  }

  async function removeMember(userId: number, name: string) {
    if (!org) return
    if (!window.confirm(t('confirmRemoveMember', { name }))) return
    try {
      await organizationAPI.removeMember(org.id, userId)
      notify.success(t('successRemoved'))
      load()
    } catch (err) {
      notify.error(err)
    }
  }

  async function joinMyselfAndEnter(project: Project) {
    if (!org || !currentUser?.id) return
    setProjectAddSaving(true)
    try {
      await organizationAPI.addProjectMember(org.id, project.id, {
        user_id: currentUser.id,
        role: 'admin',
      })
      notify.success(t('successJoinedSelfProject'))
      router.push(`/workspace/${project.id}`)
    } catch (err) {
      notify.error(err)
      setProjectAddSaving(false)
    }
  }

  async function submitAddToProject() {
    if (!org || !projectAddTarget) return
    setProjectAddSaving(true)
    try {
      let joinedUserId: number | null = null
      if (projectAddMode === 'create') {
        const { username, email, password } = projectCreateForm
        if (!projectCreateFormValid) {
          notify.warning(t('warnFillCreateForm'))
          return
        }
        const res = await organizationAPI.addProjectMember(org.id, projectAddTarget.id, {
          username: username.trim(),
          email: email.trim(),
          password,
          role: projectAddRole,
        })
        joinedUserId = res.data?.user_id ?? null
        notify.success(t('successAccountCreatedJoined'))
      } else {
        if (!projectAddUserId) {
          notify.warning(t('warnSelectUser'))
          return
        }
        joinedUserId = Number(projectAddUserId)
        await organizationAPI.addProjectMember(org.id, projectAddTarget.id, {
          user_id: joinedUserId,
          role: projectAddRole,
        })
        notify.success(
          projectAddMode === 'platform'
            ? t('successJoinedOrgAndProject')
            : t('successJoinedProject'),
        )
      }
      const enteredSelf = currentUser?.id != null && joinedUserId === currentUser.id
      const projectId = projectAddTarget.id
      setProjectAddTarget(null)
      setProjectAddUserId('')
      setProjectAddRole('member')
      setProjectAddMode('org')
      setProjectPlatformQ('')
      setProjectPlatformCandidates([])
      setProjectCreateForm({ username: '', email: '', password: '' })
      await load()
      setMatrixReloadToken((token) => token + 1)
      if (enteredSelf) router.push(`/workspace/${projectId}`)
    } catch (err) {
      notify.error(err)
    } finally {
      setProjectAddSaving(false)
    }
  }

  async function archiveProject(project: Project) {
    if (!org) return
    if (!window.confirm(t('confirmArchiveProject', { name: project.name }))) {
      return
    }
    try {
      await organizationAPI.patchProject(org.id, project.id, { status: 'suspended' })
      notify.success(t('successProjectArchived'))
      load()
    } catch (err) {
      notify.error(err)
    }
  }

  async function restoreProject(project: Project) {
    if (!org) return
    try {
      await organizationAPI.patchProject(org.id, project.id, { status: 'active' })
      notify.success(t('successProjectRestored'))
      load()
    } catch (err) {
      notify.error(err)
    }
  }

  async function transferOwner() {
    if (!org || !transferUserId) return
    const target = members.find((m) => m.user_id === Number(transferUserId))
    if (
      !window.confirm(
        t('confirmTransferOwner', { name: target?.username || transferUserId }),
      )
    ) {
      return
    }
    setTransferring(true)
    try {
      await organizationAPI.transferOwner(org.id, Number(transferUserId))
      notify.success(t('successOwnerTransferred'))
      setTransferUserId('')
      setShowTransferModal(false)
      await load()
    } catch (err) {
      notify.error(err)
    } finally {
      setTransferring(false)
    }
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 px-6">
        <div className="text-center">
          <p className="text-sm text-gray-700 mb-4">{error}</p>
          <button
            type="button"
            className="text-sm text-blue-600 mr-4"
            onClick={() => router.push('/orgs')}
          >
            {t('backToOrgList')}
          </button>
        </div>
      </div>
    )
  }

  if (!org || projects === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-sm text-gray-500">
          <i className="fas fa-spinner fa-spin mr-2"></i>
          {t('loadingConsole')}
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex bg-slate-50">
      <OrgSidebar
        orgName={org.name}
        orgSlug={org.slug}
        userRole={org.user_role}
        active={tab}
        onNavigate={setTab}
        showMembers={caps.canManageOrgMembers || isSuperadmin}
        showSettings={caps.canManageOrgSettings || isSuperadmin}
        showLogs={canViewLogs}
        isSuperadmin={isSuperadmin}
      />

      <main className="flex-1 overflow-auto p-6">
        <div className="w-full">
          {tab === 'projects' && (
            <div>
              <div className="flex items-center justify-between mb-4 gap-4">
                <div>
                  <h1 className="text-xl font-semibold text-gray-900">{t('heading')}</h1>
                  <p className="text-sm text-gray-500 mt-1">
                    {caps.canViewAllProjects || isSuperadmin
                      ? t('descProjectsAdmin')
                      : t('descProjectsLimited')}
                  </p>
                </div>
                {canManageProjects && (
                  <button
                    type="button"
                    className="btn-primary shrink-0"
                    onClick={() => router.push(`/workspace/provision?org=${org.id}`)}
                  >
                    <i className="fas fa-plus mr-2"></i>
                    {t('btnNewProject')}
                  </button>
                )}
              </div>

              {projects.length === 0 ? (
                <div className="bg-white border border-dashed border-gray-300 rounded-lg p-10 text-center">
                  <p className="text-sm text-gray-600 mb-4">
                    {canManageProjects
                      ? t('emptyNoProjectsAdmin')
                      : t('emptyNoProjectsMember')}
                  </p>
                  {canManageProjects && (
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => router.push(`/workspace/provision?org=${org.id}`)}
                    >
                      {t('btnNewProject')}
                    </button>
                  )}
                </div>
              ) : (
                <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-gray-500 border-b border-gray-200">
                      <tr>
                        <th className="px-4 py-3 text-left font-medium">{t('colProject')}</th>
                        <th className="px-4 py-3 text-left font-medium">Slug</th>
                        <th className="px-4 py-3 text-left font-medium">{t('colStatus')}</th>
                        <th className="px-4 py-3 text-left font-medium">{t('colMyRole')}</th>
                        <th className="px-4 py-3 text-right font-medium w-56">{t('colActions')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {projects.map((p) => {
                        const archived = p.status === 'suspended'
                        const canEnter = !archived && (!!p.user_role || isSuperadmin)
                        return (
                          <tr key={p.id} className="hover:bg-gray-50 transition-colors">
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-3 min-w-0">
                                <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center shrink-0">
                                  <i className="fas fa-cube text-blue-600 text-xs"></i>
                                </div>
                                <span className="font-medium text-gray-900 truncate">
                                  {p.name}
                                </span>
                              </div>
                            </td>
                            <td className="px-4 py-3 font-mono text-gray-600">
                              {p.slug || `id=${p.id}`}
                            </td>
                            <td className="px-4 py-3">
                              {archived ? (
                                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
                                  {t('statusArchived')}
                                </span>
                              ) : (
                                <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                                  active
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-3 font-mono text-xs text-gray-500">
                              {p.user_role || t('roleNotJoined')}
                            </td>
                            <td className="px-4 py-3 text-right whitespace-nowrap space-x-2">
                              {archived ? (
                                canArchive && (
                                  <button
                                    type="button"
                                    className="text-xs text-blue-600 hover:underline"
                                    onClick={() => restoreProject(p)}
                                  >
                                    {t('btnRestore')}
                                  </button>
                                )
                              ) : (
                                <>
                                  {canEnter ? (
                                    <button
                                      type="button"
                                      className="text-xs text-blue-600 hover:underline"
                                      onClick={() => router.push(`/workspace/${p.id}`)}
                                    >
                                      {t('btnEnterWorkspace')}
                                    </button>
                                  ) : canManageProjects ? (
                                    <button
                                      type="button"
                                      className="text-xs text-indigo-600 hover:underline disabled:opacity-50"
                                      disabled={projectAddSaving}
                                      onClick={() => joinMyselfAndEnter(p)}
                                    >
                                      {t('btnJoinAndEnter')}
                                    </button>
                                  ) : null}
                                  {canManageProjects && (
                                    <button
                                      type="button"
                                      className="text-xs text-gray-600 hover:underline"
                                      onClick={() => {
                                        setProjectAddTarget(p)
                                        setProjectAddUserId('')
                                        setProjectAddRole('member')
                                        setProjectAddMode('org')
                                        setProjectPlatformQ('')
                                        setProjectPlatformCandidates([])
                                        setProjectCreateForm({
                                          username: '',
                                          email: '',
                                          password: '',
                                        })
                                      }}
                                    >
                                      {t('btnJoinMember')}
                                    </button>
                                  )}
                                  {canArchive && (
                                    <button
                                      type="button"
                                      className="text-xs text-amber-700 hover:underline"
                                      onClick={() => archiveProject(p)}
                                    >
                                      {t('btnArchive')}
                                    </button>
                                  )}
                                </>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {tab === 'stats' && canViewLogs && <OrgStatsView organizationId={org.id} />}

          {tab === 'access' && canViewLogs && (
            <OrgAccessMatrixView
              organizationId={org.id}
              reloadToken={matrixReloadToken}
              onAddToProject={(matrixProject, userId) => {
                const project =
                  projects.find((candidate) => candidate.id === matrixProject.id) ||
                  ({
                    ...matrixProject,
                    status: 'active',
                    kind: '',
                    user_role: '',
                    organization_id: org.id,
                  } satisfies Project)
                setProjectAddTarget(project)
                setProjectAddUserId(String(userId))
                setProjectAddRole('member')
                setProjectAddMode('org')
                setProjectPlatformQ('')
                setProjectPlatformCandidates([])
                setProjectCreateForm({ username: '', email: '', password: '' })
              }}
            />
          )}

          {tab === 'security-overview' && canViewLogs && (
            <OrgSecurityOverviewView organizationId={org.id} />
          )}

          {tab === 'monitor' && canViewLogs && (
            <OrgMonitorView organizationId={org.id} />
          )}

          {tab === 'audit' && canViewLogs && <OrgAuditView organizationId={org.id} />}

          {tab === 'operation-logs' && canViewLogs && (
            <OrgOperationLogsView
              organizationId={org.id}
              projects={projects.map((p) => ({
                id: p.id,
                name: p.name,
                slug: p.slug,
              }))}
            />
          )}

          {tab === 'execution-logs' && canViewLogs && (
            <ExecutionLogsView
              organizationId={org.id}
              title={t('execLogsTitle')}
              subtitle={t('execLogsSubtitle')}
            />
          )}

          {tab === 'members' && (caps.canManageOrgMembers || isSuperadmin) && (
            <div>
              <div className="flex items-start justify-between gap-4 mb-4">
                <header>
                  <h1 className="text-xl font-semibold text-gray-900">{t('membersHeading')}</h1>
                  <p className="text-sm text-gray-500 mt-1">
                    {t('membersDesc')}
                  </p>
                </header>
                <button
                  type="button"
                  className="btn-primary shrink-0"
                  onClick={openAddMemberModal}
                >
                  <i className="fas fa-user-plus mr-2"></i>
                  {t('btnAddMember')}
                </button>
              </div>
              <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
                {members.length === 0 && (
                  <p className="px-4 py-8 text-sm text-gray-400 text-center">{t('emptyNoMembers')}</p>
                )}
                {members.map((m) => (
                  <div
                    key={m.user_id}
                    className="flex items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-gray-900 truncate">
                        {m.username}{' '}
                        <span className="text-gray-400 font-mono text-xs">{m.email}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-xs text-gray-600 font-mono">{m.role}</span>
                      <button
                        type="button"
                        className="text-xs text-blue-600 hover:underline disabled:opacity-40"
                        disabled={
                          (m.user_id === currentUser?.id && !isSuperadmin) ||
                          (m.role === 'owner' && !canTransfer)
                        }
                        onClick={() => openEditMemberModal(m)}
                      >
                        {t('btnEdit')}
                      </button>
                      <button
                        type="button"
                        className="text-xs text-red-500 disabled:opacity-40"
                        disabled={m.user_id === currentUser?.id && !isSuperadmin}
                        onClick={() => removeMember(m.user_id, m.username)}
                      >
                        {t('btnRemove')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'settings' && (caps.canManageOrgSettings || isSuperadmin) && (
            <div className="space-y-6">
              <header>
                <h1 className="text-xl font-semibold text-gray-900">{t('settingsHeading')}</h1>
                <p className="text-sm text-gray-500 mt-1">{t('settingsDesc')}</p>
              </header>

              <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4 max-w-xl">
                <div>
                  <label className="block text-sm text-gray-700 mb-1">{t('labelName')}</label>
                  <input
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-700 mb-1">{t('labelContactEmail')}</label>
                  <input
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    value={editEmail}
                    onChange={(e) => setEditEmail(e.target.value)}
                  />
                </div>
                <button type="button" className="btn-primary" onClick={saveSettings}>
                  {t('btnSave')}
                </button>
              </div>

              {canTransfer && (
                <div className="bg-white border border-gray-200 rounded-lg p-5 max-w-xl flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-base font-semibold text-gray-900">{t('transferOwner')}</h2>
                    <p className="text-sm text-gray-500 mt-1">
                      {t('transferOwnerDesc')}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn-primary shrink-0"
                    onClick={openTransferModal}
                  >
                    {t('transferOwner')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {editMemberTarget && org && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6 space-y-4">
            <h2 className="text-lg font-semibold text-gray-900">{t('editMemberModalHeading')}</h2>
            <p className="text-sm text-gray-500">
              {editMemberTarget.username}{' '}
              <span className="font-mono text-xs text-gray-400">
                {editMemberTarget.email}
              </span>
            </p>
            <div>
              <label className="block text-xs text-gray-500 mb-1">{t('labelOrgRole')}</label>
              <select
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                value={editMemberRole}
                onChange={(e) => setEditMemberRole(e.target.value)}
              >
                {(canTransfer || editMemberTarget.role === 'owner') && (
                  <option value="owner">owner</option>
                )}
                <option value="admin">admin</option>
                <option value="member">member</option>
              </select>
            </div>
            <div className="flex gap-3 pt-1">
              <button
                type="button"
                className="flex-1 px-4 py-2 text-sm border border-gray-300 rounded-lg"
                onClick={() => setEditMemberTarget(null)}
              >
                {t('btnCancel')}
              </button>
              <button
                type="button"
                className="flex-1 btn-primary disabled:opacity-50"
                disabled={editMemberSaving || editMemberRole === editMemberTarget.role}
                onClick={submitEditMember}
              >
                {editMemberSaving ? t('savingEllipsis') : t('btnSave')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddMemberModal && org && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6 space-y-4">
            <h2 className="text-lg font-semibold text-gray-900">{t('addMemberModalHeading')}</h2>
            <p className="text-sm text-gray-500">
              {t('addMemberModalDesc')}
            </p>
            <div>
              <label className="block text-xs text-gray-500 mb-1">{t('labelSearchUser')}</label>
              <input
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                placeholder={t('placeholderSearchUser')}
                value={searchQ}
                onChange={(e) => searchUsers(e.target.value)}
              />
              {candidates.length > 0 && (
                <div className="mt-2 border border-gray-200 rounded-lg max-h-40 overflow-y-auto">
                  {candidates.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                      onClick={() => {
                        setAddUserId(String(c.id))
                        setSearchQ(`${c.username} (${c.email})`)
                        setCandidates([])
                      }}
                    >
                      {c.username} · {c.email}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">{t('labelUserId')}</label>
              <input
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
                value={addUserId}
                onChange={(e) => setAddUserId(e.target.value)}
                placeholder={t('placeholderUserId')}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">{t('labelOrgRole')}</label>
              <select
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                value={addRole}
                onChange={(e) => setAddRole(e.target.value)}
              >
                {canTransfer && <option value="owner">owner</option>}
                <option value="admin">admin</option>
                <option value="member">member</option>
              </select>
            </div>
            <div className="flex gap-3 pt-1">
              <button
                type="button"
                className="flex-1 px-4 py-2 text-sm border border-gray-300 rounded-lg"
                onClick={() => setShowAddMemberModal(false)}
              >
                {t('btnCancel')}
              </button>
              <button
                type="button"
                className="flex-1 btn-primary disabled:opacity-50"
                disabled={!addUserId || addMemberSaving}
                onClick={addMember}
              >
                {addMemberSaving ? t('submittingEllipsis') : t('btnConfirmAdd')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showTransferModal && org && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6 space-y-4">
            <h2 className="text-lg font-semibold text-gray-900">{t('transferOwner')}</h2>
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-100 rounded-lg p-3">
              {t('transferModalDesc')}
            </p>
            <div>
              <label className="block text-xs text-gray-500 mb-1">{t('labelTargetMember')}</label>
              <select
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                value={transferUserId}
                onChange={(e) => setTransferUserId(e.target.value)}
              >
                <option value="">{t('optSelectMember')}</option>
                {members
                  .filter((m) => m.user_id !== currentUser?.id)
                  .map((m) => (
                    <option key={m.user_id} value={m.user_id}>
                      {m.username} ({m.email}) · {m.role}
                    </option>
                  ))}
              </select>
            </div>
            <div className="flex gap-3 pt-1">
              <button
                type="button"
                className="flex-1 px-4 py-2 text-sm border border-gray-300 rounded-lg"
                onClick={() => setShowTransferModal(false)}
              >
                {t('btnCancel')}
              </button>
              <button
                type="button"
                className="flex-1 btn-primary disabled:opacity-50"
                disabled={!transferUserId || transferring}
                onClick={transferOwner}
              >
                {transferring ? t('transferringEllipsis') : t('btnConfirmTransfer')}
              </button>
            </div>
          </div>
        </div>
      )}

      {projectAddTarget && org && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-6 space-y-4">
            <h2 className="text-lg font-semibold text-gray-900">{t('joinProjectModalHeading')}</h2>
            <p className="text-sm text-gray-500">
              {t('projectLabelPrefix')} <span className="font-medium text-gray-800">{projectAddTarget.name}</span>
            </p>

            <div className="flex p-1 bg-gray-100 rounded-lg text-sm">
              {(
                [
                  ['org', t('orgMembers')],
                  ['platform', t('platformUsers')],
                  ['create', t('createAccount')],
                ] as Array<[ProjectAddMode, string]>
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    setProjectAddMode(mode)
                    setProjectAddUserId('')
                    setProjectPlatformCandidates([])
                  }}
                  className={`flex-1 py-1.5 rounded-md font-medium transition-colors ${
                    projectAddMode === mode
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <p className="text-xs text-gray-500">
              {projectAddMode === 'org' && t('hintModeOrg')}
              {projectAddMode === 'platform' && t('hintModePlatform')}
              {projectAddMode === 'create' && t('hintModeCreate')}
            </p>

            {projectAddMode === 'org' && (
              <div>
                <label className="block text-xs text-gray-500 mb-1">{t('orgMembers')}</label>
                <select
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  value={projectAddUserId}
                  onChange={(e) => setProjectAddUserId(e.target.value)}
                >
                  <option value="">{t('optSelectMember')}</option>
                  {members.map((m) => (
                    <option key={m.user_id} value={m.user_id}>
                      {m.username} ({m.email}) · {m.role}
                    </option>
                  ))}
                </select>
                {members.length === 0 && (
                  <p className="text-xs text-amber-600 mt-1">
                    {t('emptyNoOrgMembersHint')}
                  </p>
                )}
              </div>
            )}

            {projectAddMode === 'platform' && (
              <div className="space-y-2">
                <label className="block text-xs text-gray-500">
                  {t('labelSearchPlatformUser')}
                </label>
                <input
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  placeholder={t('placeholderUsernameEmail')}
                  value={projectPlatformQ}
                  onChange={(e) => {
                    setProjectPlatformQ(e.target.value)
                    setProjectAddUserId('')
                  }}
                />
                {projectPlatformCandidates.length > 0 && (
                  <div className="border border-gray-200 rounded-lg max-h-40 overflow-y-auto">
                    {projectPlatformCandidates.map((candidate) => (
                      <button
                        key={candidate.id}
                        type="button"
                        className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 ${
                          projectAddUserId === String(candidate.id) ? 'bg-blue-50' : ''
                        }`}
                        onClick={() => setProjectAddUserId(String(candidate.id))}
                      >
                        {candidate.username} · {candidate.email}
                      </button>
                    ))}
                  </div>
                )}
                {projectAddUserId && (
                  <p className="text-xs text-blue-600">
                    {t('selectedUser', {
                      name:
                        projectPlatformCandidates.find(
                          (candidate) => String(candidate.id) === projectAddUserId,
                        )?.username || t('userFallback', { id: projectAddUserId }),
                    })}
                  </p>
                )}
              </div>
            )}

            {projectAddMode === 'create' && (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('labelUsername')}</label>
                  <input
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    value={projectCreateForm.username}
                    onChange={(e) =>
                      setProjectCreateForm((form) => ({ ...form, username: e.target.value }))
                    }
                    placeholder={t('placeholderUsernameMin')}
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('labelEmail')}</label>
                  <input
                    type="email"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    value={projectCreateForm.email}
                    onChange={(e) =>
                      setProjectCreateForm((form) => ({ ...form, email: e.target.value }))
                    }
                    placeholder="name@example.com"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('labelInitialPassword')}</label>
                  <input
                    type="password"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    value={projectCreateForm.password}
                    onChange={(e) =>
                      setProjectCreateForm((form) => ({ ...form, password: e.target.value }))
                    }
                    placeholder={t('placeholderPasswordMin')}
                  />
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs text-gray-500 mb-1">{t('labelProjectRole')}</label>
              <select
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                value={projectAddRole}
                onChange={(e) => setProjectAddRole(e.target.value)}
              >
                <option value="owner">owner</option>
                <option value="admin">admin</option>
                <option value="member">member</option>
                <option value="viewer">viewer</option>
              </select>
            </div>
            <div className="flex gap-3 pt-1">
              <button
                type="button"
                className="flex-1 px-4 py-2 text-sm border border-gray-300 rounded-lg"
                onClick={() => setProjectAddTarget(null)}
              >
                {t('btnCancel')}
              </button>
              <button
                type="button"
                className="flex-1 btn-primary disabled:opacity-50"
                disabled={
                  projectAddSaving ||
                  (projectAddMode !== 'create' && !projectAddUserId) ||
                  (projectAddMode === 'create' && !projectCreateFormValid)
                }
                onClick={submitAddToProject}
              >
                {projectAddSaving ? t('submittingEllipsis') : t('btnConfirmJoin')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
