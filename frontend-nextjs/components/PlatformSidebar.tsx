'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { clearAuthToken } from '@/lib/auth'
import { BRAND } from '@/lib/brand'

interface NavItem {
  name: string
  path: string
  icon: string
  badge?: string
}

const NAV_ITEMS: NavItem[] = [
  { name: '项目管理', path: '/platform', icon: 'fa-folder-tree' },
  { name: '用户管理', path: '/platform/users', icon: 'fa-users' },
  { name: '审计日志', path: '/platform/audit', icon: 'fa-clipboard-list', badge: 'New' },
  { name: 'SSO 登录管理', path: '/platform/sso', icon: 'fa-key' },
  // RPC 授权已下放回 dashboard 工作区（/dashboard/rpc-acl）。本质是 tenant 内部
  // 的"角色 × 函数"绑定，后端 require_tenant_admin_for_db 同时放行租户管理员，
  // 平台超管在切到具体项目后照样能操作，不需要单独的全局视图。
  { name: '定时任务', path: '/platform/scheduled-tasks', icon: 'fa-clock', badge: 'New' },
]

export default function PlatformSidebar() {
  const router = useRouter()
  const pathname = usePathname()
  const [user, setUser] = useState<any>(null)
  const [showUserMenu, setShowUserMenu] = useState(false)

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const userStr = localStorage.getItem('current_user')
      if (userStr) setUser(JSON.parse(userStr))
    }
  }, [])

  const isActive = (path: string) => {
    if (path === '/platform') return pathname === '/platform'
    return pathname === path || pathname.startsWith(path + '/')
  }

  const handleLogout = () => {
    clearAuthToken()
    localStorage.removeItem('current_user')
    localStorage.removeItem('current_tenant')
    localStorage.removeItem('current_connection')
    router.push('/login')
  }

  const handleEnterWorkspace = () => {
    const tenantStr = typeof window !== 'undefined' ? localStorage.getItem('current_tenant') : null
    if (tenantStr) {
      router.push('/dashboard')
    } else {
      router.push('/platform')
    }
  }

  return (
    <div className="w-[220px] min-h-screen self-stretch bg-white border-r border-gray-200 flex flex-col">
      {/* Logo */}
      <div className="h-[60px] flex items-center px-5 border-b border-gray-200">
        <div className="flex items-center space-x-2.5">
          <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-blue-600 rounded-lg flex items-center justify-center shadow-sm">
            <i className="fas fa-database text-white text-sm"></i>
          </div>
          <div>
            <h1 className="text-sm font-semibold text-gray-900">{BRAND}</h1>
            <p className="text-[11px] text-gray-500">平台管理</p>
          </div>
        </div>
      </div>

      {/* 平台徽章 */}
      <div className="px-3 py-3 border-b border-gray-200">
        <div className="bg-gradient-to-r from-purple-50 to-indigo-50 rounded-lg p-3 border border-purple-100">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 bg-gradient-to-br from-purple-500 to-purple-600 rounded-lg flex items-center justify-center">
              <i className="fas fa-crown text-white text-xs"></i>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-900 truncate">超级管理员</p>
              <p className="text-[11px] text-gray-500 truncate">跨租户全局视图</p>
            </div>
          </div>
        </div>
      </div>

      {/* 导航 */}
      <nav className="flex-1 min-h-0 px-3 py-2 overflow-y-auto">
        <div className="space-y-0.5">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.path}
              onClick={() => router.push(item.path)}
              className={`w-full flex items-center space-x-3 px-3 py-2 rounded-md text-[13px] transition-all duration-150 ${
                isActive(item.path)
                  ? 'bg-blue-50 text-blue-600 font-semibold'
                  : 'text-gray-700 hover:bg-gray-50 hover:text-gray-900'
              }`}
            >
              <i
                className={`fas ${item.icon} text-sm w-4 flex-shrink-0 ${
                  isActive(item.path) ? 'text-blue-600' : 'text-gray-400'
                }`}
              ></i>
              <span className="flex-1 text-left">{item.name}</span>
              {item.badge && (
                <span className="text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-600 rounded font-medium">
                  {item.badge}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="mt-4 pt-3 border-t border-gray-100">
          <button
            onClick={handleEnterWorkspace}
            className="w-full flex items-center space-x-3 px-3 py-2 rounded-md text-[13px] text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors"
          >
            <i className="fas fa-arrow-right text-sm w-4 flex-shrink-0 text-gray-400"></i>
            <span className="flex-1 text-left">进入工作区</span>
          </button>
        </div>
      </nav>

      {/* 底部用户区 */}
      <div className="mt-auto shrink-0 border-t border-gray-200 p-3 relative bg-white">
        <button
          onClick={() => setShowUserMenu(!showUserMenu)}
          className="w-full flex items-center space-x-2.5 px-3 py-2 rounded-lg hover:bg-gray-50 transition-colors"
        >
          <div className="w-7 h-7 bg-gradient-to-br from-blue-500 to-blue-600 rounded-full flex items-center justify-center flex-shrink-0">
            <span className="text-white text-xs font-medium">
              {user?.username?.[0]?.toUpperCase() || 'U'}
            </span>
          </div>
          <div className="flex-1 min-w-0 text-left">
            <p className="text-xs font-medium text-gray-900 truncate">{user?.username || '用户'}</p>
            <p className="text-[11px] text-gray-500 truncate">超级管理员</p>
          </div>
          <i
            className={`fas fa-chevron-down text-gray-400 text-[10px] flex-shrink-0 transition-transform ${
              showUserMenu ? 'rotate-180' : ''
            }`}
          ></i>
        </button>

        {showUserMenu && (
          <div className="absolute bottom-full left-3 right-3 mb-2 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden z-20">
            <div className="py-1">
              <button
                onClick={handleLogout}
                className="w-full flex items-center space-x-2.5 px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
              >
                <i className="fas fa-sign-out-alt text-xs w-4"></i>
                <span>退出登录</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
