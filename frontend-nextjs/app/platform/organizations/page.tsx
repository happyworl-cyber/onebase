'use client'

/**
 * `/platform/organizations` —— 平台超管：创建/管理租户（组织）。
 * 项目创建在租户控制台 `/org/[id]`，不在此页。
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  adminAPI,
  organizationAPI,
  type OrganizationDto,
} from '@/lib/api'
import { useNotification } from '@/hooks/useNotification'
import Drawer from '@/components/Drawer'

const SLUG_REGEX = /^[a-z][a-z0-9_-]{0,49}$/

function suggestSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
}

type UserOpt = { id: number; username: string; email: string }

export default function PlatformOrganizationsPage() {
  const router = useRouter()
  const notify = useNotification()

  const [orgs, setOrgs] = useState<OrganizationDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<OrganizationDto | null>(null)
  const [users, setUsers] = useState<UserOpt[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({
    name: '',
    slug: '',
    contact_email: '',
    owner_user_id: '',
  })
  const [slugTouched, setSlugTouched] = useState(false)
  const [editName, setEditName] = useState('')
  const [editEmail, setEditEmail] = useState('')

  const reload = useCallback(() => {
    organizationAPI
      .list()
      .then((res) => setOrgs(res.data.organizations || []))
      .catch((err) => {
        setError(err?.response?.data?.error || err?.message || '加载失败')
        setOrgs([])
      })
  }, [])

  useEffect(() => {
    reload()
    adminAPI
      .listAllUsers()
      .then((res) => {
        const list = Array.isArray(res.data) ? res.data : []
        setUsers(
          list.map((u: UserOpt) => ({
            id: u.id,
            username: u.username,
            email: u.email,
          })),
        )
      })
      .catch(() => setUsers([]))
  }, [reload])

  function openDetail(o: OrganizationDto) {
    setSelected(o)
    setEditName(o.name)
    setEditEmail(o.contact_email || '')
  }

  async function handleCreate(e?: React.FormEvent) {
    e?.preventDefault()
    if (!form.name.trim() || !SLUG_REGEX.test(form.slug)) {
      notify.error('请填写有效名称与 slug')
      return
    }
    setCreating(true)
    try {
      const body: {
        name: string
        slug: string
        contact_email?: string
        owner_user_id?: number
      } = { name: form.name.trim(), slug: form.slug }
      if (form.contact_email.trim()) body.contact_email = form.contact_email.trim()
      if (form.owner_user_id) body.owner_user_id = Number(form.owner_user_id)
      const res = await organizationAPI.create(body)
      notify.success('租户已创建')
      setShowCreate(false)
      setForm({ name: '', slug: '', contact_email: '', owner_user_id: '' })
      setSlugTouched(false)
      reload()
      openDetail(res.data.organization)
    } catch (err) {
      notify.error(err)
    } finally {
      setCreating(false)
    }
  }

  async function saveMeta() {
    if (!selected) return
    try {
      const res = await organizationAPI.patch(selected.id, {
        name: editName.trim(),
        contact_email: editEmail.trim() || undefined,
      })
      notify.success('已保存')
      setSelected(res.data.organization)
      reload()
    } catch (err) {
      notify.error(err)
    }
  }

  async function setStatus(status: string) {
    if (!selected) return
    if (
      status === 'deleted' &&
      !window.confirm(`确定删除租户「${selected.name}」？此操作将标记为 deleted。`)
    ) {
      return
    }
    try {
      const res = await organizationAPI.patch(selected.id, { status })
      notify.success(status === 'active' ? '已启用' : status === 'suspended' ? '已停用' : '已删除')
      if (status === 'deleted') {
        setSelected(null)
      } else {
        setSelected(res.data.organization)
      }
      reload()
    } catch (err) {
      notify.error(err)
    }
  }

  return (
    <div className="w-full space-y-6">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">租户管理</h1>
          <p className="text-sm text-gray-500 mt-1">
            平台创建与管理租户基本信息。成员、项目等请在租户控制台中管理。
          </p>
        </div>
        <button type="button" className="btn-primary shrink-0" onClick={() => setShowCreate(true)}>
          <i className="fas fa-plus mr-2"></i>
          创建租户
        </button>
      </header>

      {error && (
        <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-4 py-3">
          {error}
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left font-medium">租户</th>
                <th className="px-4 py-3 text-left font-medium">Slug</th>
                <th className="px-4 py-3 text-left font-medium">状态</th>
                <th className="px-4 py-3 text-left font-medium">联系邮箱</th>
                <th className="px-4 py-3 text-right font-medium w-40">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {orgs === null ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-gray-400">
                    <i className="fas fa-spinner fa-spin mr-2"></i>加载中…
                  </td>
                </tr>
              ) : orgs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-gray-400">
                    暂无租户，请先创建
                  </td>
                </tr>
              ) : (
                orgs.map((o) => (
                  <tr key={o.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-lg bg-indigo-100 flex items-center justify-center shrink-0">
                          <i className="fas fa-building text-indigo-600 text-sm"></i>
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium text-gray-900 truncate">{o.name}</p>
                          <p className="text-xs text-gray-400">ID #{o.id}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-gray-600">{o.slug}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex text-xs px-2 py-0.5 rounded-full font-medium ${
                          o.status === 'active'
                            ? 'bg-green-100 text-green-700'
                            : o.status === 'suspended'
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {o.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {o.contact_email || <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button
                        type="button"
                        className="text-xs text-blue-600 hover:underline mr-3"
                        onClick={() => openDetail(o)}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="text-xs text-gray-500 hover:text-blue-600 hover:underline"
                        onClick={() => router.push(`/org/${o.id}`)}
                      >
                        控制台
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Drawer
        isOpen={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? `租户 · ${selected.name}` : ''}
        size="md"
      >
        {selected && (
          <div className="space-y-6">
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
                基本信息
              </h4>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">名称</label>
                  <input
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Slug</label>
                  <input
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono bg-gray-50 text-gray-600"
                    value={selected.slug}
                    disabled
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">联系邮箱</label>
                  <input
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    value={editEmail}
                    onChange={(e) => setEditEmail(e.target.value)}
                  />
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  <button type="button" className="btn-primary text-sm" onClick={saveMeta}>
                    保存信息
                  </button>
                  {selected.status === 'active' ? (
                    <button
                      type="button"
                      className="px-3 py-2 text-sm border border-amber-300 text-amber-700 rounded-lg"
                      onClick={() => setStatus('suspended')}
                    >
                      停用
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="px-3 py-2 text-sm border border-green-300 text-green-700 rounded-lg"
                      onClick={() => setStatus('active')}
                    >
                      启用
                    </button>
                  )}
                  <button
                    type="button"
                    className="px-3 py-2 text-sm border border-red-200 text-red-600 rounded-lg"
                    onClick={() => setStatus('deleted')}
                  >
                    删除
                  </button>
                </div>
              </div>
            </section>
          </div>
        )}
      </Drawer>

      <Drawer
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        title="创建租户"
        size="md"
        footer={
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              className="px-4 py-2 text-sm border border-gray-300 rounded-lg"
              onClick={() => setShowCreate(false)}
            >
              取消
            </button>
            <button
              type="button"
              disabled={creating}
              className="btn-primary text-sm disabled:opacity-50"
              onClick={() => handleCreate()}
            >
              {creating ? '创建中…' : '创建'}
            </button>
          </div>
        }
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">名称</label>
            <input
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              value={form.name}
              onChange={(e) => {
                setForm((f) => ({
                  ...f,
                  name: e.target.value,
                  slug: slugTouched ? f.slug : suggestSlug(e.target.value),
                }))
              }}
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Slug</label>
            <input
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
              value={form.slug}
              onChange={(e) => {
                setSlugTouched(true)
                setForm((f) => ({ ...f, slug: e.target.value }))
              }}
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">联系邮箱</label>
            <input
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              value={form.contact_email}
              onChange={(e) => setForm((f) => ({ ...f, contact_email: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              初始 Owner（可选）
            </label>
            <select
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              value={form.owner_user_id}
              onChange={(e) => setForm((f) => ({ ...f, owner_user_id: e.target.value }))}
            >
              <option value="">— 稍后添加 —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username} ({u.email})
                </option>
              ))}
            </select>
          </div>
        </form>
      </Drawer>
    </div>
  )
}
