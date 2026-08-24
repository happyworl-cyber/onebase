'use client'

/**
 * `/orgs` —— 普通用户选择租户（进入租户控制台）。
 * 创建租户仅平台超管可做。
 */

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { organizationAPI } from '@/lib/api'
import { useAppStore, type Organization } from '@/lib/store'

export default function OrgsPickerPage() {
  const router = useRouter()
  const setCurrentOrganization = useAppStore((s) => s.setCurrentOrganization)
  const [orgs, setOrgs] = useState<Organization[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!localStorage.getItem('token')) {
      router.replace('/login')
      return
    }
    let superadmin = false
    try {
      superadmin = !!JSON.parse(localStorage.getItem('current_user') || '{}')?.is_superadmin
    } catch {
      /* ignore */
    }
    if (superadmin) {
      router.replace('/platform/organizations')
      return
    }

    organizationAPI
      .list()
      .then((res) => {
        const list = (res.data.organizations || []) as Organization[]
        if (list.length === 0) {
          setOrgs([])
        } else if (list.length === 1) {
          setCurrentOrganization(list[0])
          router.replace(`/org/${list[0].id}`)
        } else {
          setOrgs(list)
        }
      })
      .catch((err) => {
        setError(err?.response?.data?.error || err?.message || '加载失败')
      })
  }, [router, setCurrentOrganization])

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <p className="text-sm text-gray-700 mb-4">{error}</p>
          <button type="button" className="text-sm text-blue-600" onClick={() => location.reload()}>
            重试
          </button>
        </div>
      </div>
    )
  }

  if (orgs === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center text-sm text-gray-500">
          <i className="fas fa-spinner fa-spin text-2xl text-gray-400 mb-2 block"></i>
          加载租户…
        </div>
      </div>
    )
  }

  if (orgs.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-6">
        <div className="max-w-md text-center bg-white border border-gray-200 rounded-lg p-8">
          <i className="fas fa-building text-3xl text-gray-300 mb-3"></i>
          <h1 className="text-lg font-semibold text-gray-900 mb-2">尚未加入任何租户</h1>
          <p className="text-sm text-gray-500">
            租户由平台管理员创建并分配成员。请联系平台开通租户，或确认账号已被加入租户。
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-6">
      <div className="max-w-3xl mx-auto">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold text-gray-900">选择租户</h1>
          <p className="text-sm text-gray-500 mt-1">
            进入租户后可管理项目；项目内再使用数据库、工作流等功能。
          </p>
        </header>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {orgs.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => {
                setCurrentOrganization(o)
                router.push(`/org/${o.id}`)
              }}
              className="bg-white border border-gray-200 rounded-lg p-4 text-left hover:shadow-sm hover:border-indigo-300 transition"
            >
              <div className="flex items-start justify-between mb-2">
                <div className="w-10 h-10 rounded-lg bg-indigo-100 flex items-center justify-center">
                  <i className="fas fa-building text-indigo-600"></i>
                </div>
                <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded font-mono">
                  {o.user_role}
                </span>
              </div>
              <div className="text-base font-medium text-gray-900 truncate">{o.name}</div>
              <div className="text-xs text-gray-500 font-mono mt-0.5 truncate">{o.slug}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
