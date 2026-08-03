'use client'

import { useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { clearAuthToken } from '@/lib/auth'

interface MenuItem {
  name: string
  icon: string
  path?: string
  children?: MenuItem[]
}

const menuStructure: MenuItem[] = [
  {
    name: '首页',
    icon: 'fa-home',
    path: '/dashboard',
  },
  {
    name: '数据库管理',
    icon: 'fa-database',
    children: [
      { name: 'Schema 浏览器', icon: 'fa-sitemap', path: '/dashboard/schema' },
      { name: '数据表', icon: 'fa-table', path: '/dashboard/tables' },
      { name: '表结构设计', icon: 'fa-drafting-compass', path: '/dashboard/table-designer' },
      { name: '数据导入', icon: 'fa-file-import', path: '/dashboard/import' },
      { name: '索引管理', icon: 'fa-list-ol', path: '/dashboard/indexes' },
    ],
  },
  {
    name: '查询工具',
    icon: 'fa-code',
    children: [
      { name: 'SQL 查询器', icon: 'fa-terminal', path: '/dashboard/query' },
      { name: '查询性能', icon: 'fa-tachometer-alt', path: '/dashboard/query-analyzer' },
      { name: '慢查询日志', icon: 'fa-clock', path: '/dashboard/slow-queries' },
    ],
  },
  {
    name: '角色与权限',
    icon: 'fa-shield-alt',
    children: [
      { name: '角色管理', icon: 'fa-user-tag', path: '/dashboard/roles' },
      { name: '权限管理', icon: 'fa-key', path: '/dashboard/permissions' },
      // 用户管理已迁至 /platform/users（跨租户，仅超管），见 PlatformSidebar
      // { name: '用户管理', icon: 'fa-users', path: '/dashboard/users' },
    ],
  },
  {
    name: '性能监控',
    icon: 'fa-chart-line',
    children: [
      { name: '实时监控', icon: 'fa-heartbeat', path: '/dashboard/monitor' },
      { name: '数据库健康', icon: 'fa-stethoscope', path: '/dashboard/health' },
      { name: '连接管理', icon: 'fa-plug', path: '/dashboard/connections' },
    ],
  },
  {
    name: '高级功能',
    icon: 'fa-cogs',
    children: [
      { name: '函数管理', icon: 'fa-function', path: '/dashboard/functions' },
      { name: '触发器', icon: 'fa-bolt', path: '/dashboard/triggers' },
      { name: '事务管理', icon: 'fa-exchange-alt', path: '/dashboard/transaction' },
      { name: '备份恢复', icon: 'fa-save', path: '/dashboard/backup' },
    ],
  },
  {
    name: '开发工具',
    icon: 'fa-wrench',
    children: [
      { name: 'API 测试', icon: 'fa-vial', path: '/test' },
      { name: 'Schema 迁移', icon: 'fa-project-diagram', path: '/dashboard/migrations' },
    ],
  },
]

export default function SidebarV2() {
  const pathname = usePathname()
  const router = useRouter()
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(['数据库管理', '查询工具']))

  const toggleGroup = (groupName: string) => {
    const newExpanded = new Set(expandedGroups)
    if (newExpanded.has(groupName)) {
      newExpanded.delete(groupName)
    } else {
      newExpanded.add(groupName)
    }
    setExpandedGroups(newExpanded)
  }

  const handleLogout = () => {
    clearAuthToken()
    router.push('/login')
  }

  const isActive = (path: string) => pathname === path

  return (
    <div className="w-64 flex flex-col bg-slate-800 shadow-2xl">
      {/* Logo */}
      <div className="px-4 py-4 border-b border-white/10">
        <div className="flex items-center space-x-3 mb-3">
          <div
            className="w-10 h-10 bg-primary-500 rounded-lg flex items-center justify-center shadow-lg 
                        transform transition-all duration-300 hover:scale-110 hover:rotate-3"
          >
            <i className="fas fa-database text-white text-lg"></i>
          </div>
          <div>
            <h1 className="text-lg font-bold text-white tracking-wide">OneBase</h1>
            <p className="text-xs text-white/60">数据库管理平台</p>
          </div>
        </div>
        <div className="flex items-center space-x-2 px-2 py-1.5 bg-white/5 rounded">
          <i className="fas fa-user-circle text-xs text-white/60"></i>
          <p className="text-xs text-white/65 truncate flex-1">admin</p>
        </div>
      </div>

      {/* 菜单 */}
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {menuStructure.map((item) => (
          <div key={item.name}>
            {item.children ? (
              // 有子菜单的分组
              <div>
                <button
                  onClick={() => toggleGroup(item.name)}
                  className="w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all duration-200
                           flex items-center justify-between group
                           text-white/80 hover:bg-white/10 hover:text-white"
                >
                  <div className="flex items-center space-x-3">
                    <i className={`fas ${item.icon} text-xs w-4`}></i>
                    <span className="font-medium">{item.name}</span>
                  </div>
                  <i
                    className={`fas fa-chevron-right text-xs transition-transform duration-200 ${
                      expandedGroups.has(item.name) ? 'rotate-90' : ''
                    }`}
                  ></i>
                </button>

                {/* 子菜单 */}
                {expandedGroups.has(item.name) && (
                  <div className="mt-1 ml-4 space-y-1">
                    {item.children.map((child) => (
                      <button
                        key={child.path}
                        onClick={() => child.path && router.push(child.path)}
                        className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all duration-200
                                   flex items-center space-x-3 ${
                                     isActive(child.path || '')
                                       ? 'bg-primary-500 text-white shadow-md'
                                       : 'text-white/70 hover:bg-white/10 hover:text-white'
                                   }`}
                      >
                        <i className={`fas ${child.icon} text-xs w-4`}></i>
                        <span>{child.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              // 单独的菜单项
              <button
                onClick={() => item.path && router.push(item.path)}
                className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all duration-200
                           flex items-center space-x-3 ${
                             isActive(item.path || '')
                               ? 'bg-primary-500 text-white shadow-md'
                               : 'text-white/80 hover:bg-white/10 hover:text-white'
                           }`}
              >
                <i className={`fas ${item.icon} text-xs w-4`}></i>
                <span className="font-medium">{item.name}</span>
              </button>
            )}
          </div>
        ))}
      </nav>

      {/* 退出 */}
      <div className="p-3 border-t border-white/10">
        <button
          onClick={handleLogout}
          className="w-full text-left px-3 py-2.5 rounded-lg text-sm text-white/80 
                   hover:bg-red-500/20 hover:text-red-400 transition-all duration-200
                   flex items-center space-x-3"
        >
          <i className="fas fa-sign-out-alt text-xs w-4"></i>
          <span>退出登录</span>
        </button>
      </div>
    </div>
  )
}

