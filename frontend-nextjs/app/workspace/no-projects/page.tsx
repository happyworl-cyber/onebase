'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/lib/store'
import { clearAuthToken } from '@/lib/auth'

/**
 * 无租户 / 无项目引导。租户只能由平台创建。
 */
export default function NoProjectsPage() {
  const router = useRouter()
  const currentUser = useAppStore((s) => s.currentUser)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    setHydrated(true)
  }, [])

  function logout() {
    clearAuthToken()
    try {
      localStorage.removeItem('current_user')
      localStorage.removeItem('current_tenant')
      localStorage.removeItem('current_project')
      localStorage.removeItem('current_organization')
    } catch {}
    router.push('/login')
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-6">
      <div className="max-w-md w-full text-center">
        <div className="w-16 h-16 rounded-full bg-gray-100 mx-auto mb-4 flex items-center justify-center">
          <i className="fas fa-building text-2xl text-gray-400"></i>
        </div>
        <h1 className="text-xl font-semibold text-gray-900 mb-2">暂无可用租户或项目</h1>
        <p className="text-sm text-gray-500 mb-6">
          租户由平台管理员创建并分配成员；租户管理员再创建项目。请联系平台开通，或确认你已被加入租户。
        </p>

        <button
          type="button"
          onClick={() => router.push('/orgs')}
          className="btn-primary w-full mb-3"
        >
          查看我的租户
        </button>

        {hydrated && currentUser?.is_superadmin && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-left text-xs text-amber-800 mb-4">
            你是平台超管：请到「租户管理」创建租户，并添加 owner，再由对方在租户控制台开通项目。
            <button
              type="button"
              className="block mt-2 text-amber-900 font-medium underline"
              onClick={() => router.push('/platform/organizations')}
            >
              前往租户管理 →
            </button>
          </div>
        )}

        <button type="button" onClick={logout} className="text-sm text-gray-500 hover:underline">
          退出登录
        </button>
      </div>
    </div>
  )
}
