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
      const user = JSON.parse(userStr)
      
      // 超级管理员未选择项目时，跳转到平台管理页面
      if (user.is_superadmin && !tenantStr) {
        router.push('/platform')
        return
      }
      
      // 普通用户如果没有项目信息，可能需要后端分配默认项目
      // 这里暂时允许访问
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

