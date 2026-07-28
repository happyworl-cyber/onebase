'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ToastProvider } from '@/components/Toast'
import PlatformSidebar from '@/components/PlatformSidebar'

/**
 * /platform/* 路径仅平台超级管理员可见。
 *
 * 这一层是"客户端门卫"：拦截非超管用户直接打 URL 访问平台管理页面，
 * 给他们重定向回普通 dashboard，避免让后端在每个接口位置都弹 403。
 *
 * 注意：这只是 UX，**真正的鉴权**在后端的 `permissions::require_platform_superadmin`
 * 上——`/api/admin/*` 和 SSO 平台级接口都会强制校验 JWT 里的 `is_superadmin`。
 */
export default function PlatformLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  const [authorized, setAuthorized] = useState(false)

  useEffect(() => {
    const token = localStorage.getItem('token')
    if (!token) {
      router.push('/login')
      return
    }

    const userStr = localStorage.getItem('current_user')
    if (!userStr) {
      router.push('/login')
      return
    }

    // 防御性 JSON 解析：localStorage 内容可能被外部脚本/扩展污染，
    // 直接 JSON.parse 抛错会导致整个布局白屏。
    let user: { is_superadmin?: boolean } | null = null
    try {
      user = JSON.parse(userStr)
    } catch {
      router.push('/login')
      return
    }

    if (!user?.is_superadmin) {
      // 非平台超管直接踢回普通工作区。这是用户视角的最快路径——
      // 后端同样会以 403 兜底，所以不存在"绕过"的可能。
      router.push('/dashboard')
      return
    }

    setAuthorized(true)
  }, [router])

  if (!authorized) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <i className="fas fa-spinner fa-spin text-2xl text-gray-400 mb-2"></i>
          <p className="text-sm text-gray-500">加载中...</p>
        </div>
      </div>
    )
  }

  return (
    <ToastProvider>
      <div className="min-h-screen flex bg-slate-50">
        <PlatformSidebar />
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </ToastProvider>
  )
}
