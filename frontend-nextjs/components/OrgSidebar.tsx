'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { clearAuthToken } from '@/lib/auth'

export type OrgNavId =
  | 'projects'
  | 'members'
  | 'access'
  | 'stats'
  | 'monitor'
  | 'audit'
  | 'operation-logs'
  | 'execution-logs'
  | 'security-overview'
  | 'settings'

interface OrgSidebarProps {
  orgName: string
  orgSlug: string
  userRole: string
  active: OrgNavId
  onNavigate: (id: OrgNavId) => void
  showMembers: boolean
  showSettings: boolean
  /** 操作日志 / 执行日志（org admin+） */
  showLogs: boolean
  isSuperadmin: boolean
}

export default function OrgSidebar({
  orgName,
  orgSlug,
  userRole,
  active,
  onNavigate,
  showMembers,
  showSettings,
  showLogs,
  isSuperadmin,
}: OrgSidebarProps) {
  const router = useRouter()
  const [user, setUser] = useState<{ username?: string } | null>(null)
  const [showUserMenu, setShowUserMenu] = useState(false)

  useEffect(() => {
    try {
      const raw = localStorage.getItem('current_user')
      if (raw) setUser(JSON.parse(raw))
    } catch {
      /* ignore */
    }
  }, [])

  const navItems: Array<{ id: OrgNavId; name: string; icon: string }> = [
    { id: 'projects', name: '项目', icon: 'fa-cube' },
    ...(showMembers ? [{ id: 'members' as const, name: '成员', icon: 'fa-users' }] : []),
    ...(showLogs
      ? [
          { id: 'access' as const, name: '访问', icon: 'fa-th' },
          { id: 'stats' as const, name: '统计', icon: 'fa-chart-pie' },
          { id: 'monitor' as const, name: '监控', icon: 'fa-chart-line' },
          { id: 'audit' as const, name: '审计', icon: 'fa-shield-alt' },
          { id: 'operation-logs' as const, name: '操作日志', icon: 'fa-clipboard-list' },
          { id: 'execution-logs' as const, name: '执行日志', icon: 'fa-stream' },
          { id: 'security-overview' as const, name: '安全总览', icon: 'fa-lock' },
        ]
      : []),
    ...(showSettings ? [{ id: 'settings' as const, name: '设置', icon: 'fa-cog' }] : []),
  ]

  const handleLogout = () => {
    clearAuthToken()
    localStorage.removeItem('current_user')
    localStorage.removeItem('current_tenant')
    localStorage.removeItem('current_connection')
    router.push('/login')
  }

  return (
    <div className="w-[220px] min-h-screen self-stretch bg-white border-r border-gray-200 flex flex-col shrink-0">
      <div className="h-[60px] flex items-center px-5 border-b border-gray-200">
        <div className="flex items-center space-x-2.5 min-w-0">
          <div className="w-8 h-8 bg-gradient-to-br from-indigo-500 to-indigo-600 rounded-lg flex items-center justify-center shadow-sm shrink-0">
            <i className="fas fa-building text-white text-sm"></i>
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-gray-900 truncate">OneBase</h1>
            <p className="text-[11px] text-gray-500">租户控制台</p>
          </div>
        </div>
      </div>

      <div className="px-3 py-3 border-b border-gray-200">
        <div className="bg-gradient-to-r from-indigo-50 to-blue-50 rounded-lg p-3 border border-indigo-100">
          <div className="flex items-center space-x-2.5 min-w-0">
            <div className="w-8 h-8 bg-gradient-to-br from-indigo-500 to-indigo-600 rounded-lg flex items-center justify-center shrink-0">
              <i className="fas fa-building text-white text-xs"></i>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-900 truncate">{orgName}</p>
              <p className="text-[11px] text-gray-500 truncate font-mono">
                {orgSlug} · {userRole}
              </p>
            </div>
          </div>
        </div>
      </div>

      <nav className="flex-1 min-h-0 px-3 py-2 overflow-y-auto">
        <div className="space-y-0.5">
          {navItems.map((item) => {
            const isActive = active === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                className={`w-full flex items-center space-x-3 px-3 py-2 rounded-md text-[13px] transition-all duration-150 ${
                  isActive
                    ? 'bg-blue-50 text-blue-600 font-semibold'
                    : 'text-gray-700 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                <i
                  className={`fas ${item.icon} text-sm w-4 flex-shrink-0 ${
                    isActive ? 'text-blue-600' : 'text-gray-400'
                  }`}
                ></i>
                <span className="flex-1 text-left">{item.name}</span>
              </button>
            )
          })}
        </div>

        <div className="mt-4 pt-3 border-t border-gray-100 space-y-0.5">
          <button
            type="button"
            onClick={() =>
              router.push(isSuperadmin ? '/platform/organizations' : '/orgs')
            }
            className="w-full flex items-center space-x-3 px-3 py-2 rounded-md text-[13px] text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors"
          >
            <i className="fas fa-arrow-left text-sm w-4 flex-shrink-0 text-gray-400"></i>
            <span className="flex-1 text-left">
              {isSuperadmin ? '平台租户管理' : '切换租户'}
            </span>
          </button>
        </div>
      </nav>

      <div className="mt-auto shrink-0 border-t border-gray-200 p-3 relative bg-white">
        <button
          type="button"
          onClick={() => setShowUserMenu(!showUserMenu)}
          className="w-full flex items-center space-x-2.5 px-3 py-2 rounded-lg hover:bg-gray-50 transition-colors"
        >
          <div className="w-7 h-7 bg-gradient-to-br from-indigo-500 to-indigo-600 rounded-full flex items-center justify-center flex-shrink-0">
            <span className="text-white text-xs font-medium">
              {user?.username?.[0]?.toUpperCase() || 'U'}
            </span>
          </div>
          <div className="flex-1 min-w-0 text-left">
            <p className="text-xs font-medium text-gray-900 truncate">
              {user?.username || '用户'}
            </p>
            <p className="text-[11px] text-gray-500 truncate">{userRole}</p>
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
              <Link
                href="/account"
                onClick={() => setShowUserMenu(false)}
                className="flex items-center space-x-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
              >
                <i className="fas fa-user-cog text-xs w-4 text-gray-400"></i>
                <span>账号设置</span>
              </Link>
              <button
                type="button"
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
