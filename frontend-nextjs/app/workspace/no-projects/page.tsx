'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/lib/store'
import { clearAuthToken } from '@/lib/auth'

/**
 * 无项目用户引导页（W1 spec §3.2.1）。
 *
 * 触发：登录后 /api/projects 返回空数组。常见原因：
 *   1. 新注册用户还没被任何 tenant 加入
 *   2. 用户原本所属的 tenant 被 is_active=false / status='archived'
 *   3. 平台超管首次登录且尚未创建任何 project（此时给 /platform 入口）
 *
 * 设计目标：取代过去登录后立刻批量 403 的红 toast 流，把"没有可访问项目"
 * 作为正常状态显式说明。
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
    } catch {}
    router.push('/login')
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-6">
      <div className="max-w-md w-full text-center">
        <div className="w-16 h-16 rounded-full bg-gray-100 mx-auto mb-4 flex items-center justify-center">
          <i className="fas fa-folder-open text-2xl text-gray-400"></i>
        </div>
        <h1 className="text-xl font-semibold text-gray-900 mb-2">
          你当前没有可访问的项目
        </h1>
        <p className="text-sm text-gray-500 mb-6">
          可以立即用『新建项目』向导自助开通一个，或联系平台管理员把你加入已有项目。
        </p>

        <button
          onClick={() => router.push('/workspace/provision')}
          className="btn-primary w-full mb-3"
        >
          <i className="fas fa-plus mr-2"></i>
          立即创建项目
        </button>

        {hydrated && currentUser?.is_superadmin && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-left text-xs text-amber-800 mb-4">
            <p className="font-medium mb-1">
              <i className="fas fa-info-circle mr-1"></i> 你是平台超管
            </p>
            <p>可以前往平台控制台创建或管理项目。</p>
            <button
              onClick={() => router.push('/platform')}
              className="mt-2 text-amber-900 hover:underline font-medium"
            >
              前往 /platform →
            </button>
          </div>
        )}

        <button onClick={logout} className="text-sm text-gray-600 hover:text-gray-900">
          <i className="fas fa-sign-out-alt mr-1"></i> 退出登录
        </button>
      </div>
    </div>
  )
}
