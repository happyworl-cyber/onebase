'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import SidebarV3 from '@/components/SidebarV3'
import Header from '@/components/Header'
import { ToastProvider } from '@/components/Toast'

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  const [mounted, setMounted] = useState(false)
  const [authorized, setAuthorized] = useState(false)

  useEffect(() => {
    setMounted(true)
    
    const token = localStorage.getItem('token')
    if (!token) {
      router.push('/login')
      return
    }

    // 检查用户和项目
    const userStr = localStorage.getItem('current_user')
    const tenantStr = localStorage.getItem('current_tenant')

    if (userStr) {
      let user: any
      try {
        user = JSON.parse(userStr)
      } catch {
        user = null
      }

      // 超级管理员未选择项目时，跳转到平台管理页面
      if (user?.is_superadmin && !tenantStr) {
        router.push('/platform')
        return
      }

      // W1 spec §3.2.8：非超管不再允许停留在 /dashboard，统一进 /workspace 让
      // picker 派发。/dashboard/* 在 W1 保留作为兼容层（旧链接仍能工作），但入口
      // 一律走 /workspace。等 W2 物理迁移完后，本守卫升级为彻底 404。
      if (user && !user.is_superadmin) {
        router.push('/workspace')
        return
      }
    }

    setAuthorized(true)
  }, [router])

  if (!mounted || !authorized) {
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
      <div className="min-h-screen flex bg-gray-50">
        <SidebarV3 />
        <div className="flex-1 flex flex-col overflow-hidden">
          <Header />
          <main className="flex-1 overflow-auto p-6">{children}</main>
        </div>
      </div>
    </ToastProvider>
  )
}

