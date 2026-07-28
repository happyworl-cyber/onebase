'use client'

import { usePathname, useRouter } from 'next/navigation'
import { clearAuthToken } from '@/lib/auth'

interface MenuItem {
  name: string
  icon: string
  path: string
  isDivider?: boolean
}

const menuItems: MenuItem[] = [
  { name: 'Schema 浏览器', icon: 'fa-database', path: '/dashboard/schema' },
  { name: '数据表', icon: 'fa-table', path: '/dashboard/tables' },
  { name: 'SQL 查询', icon: 'fa-code', path: '/dashboard/query' },
  { name: '事务管理', icon: 'fa-exchange-alt', path: '/dashboard/transaction' },
  // 用户管理已迁至 /platform/users（跨租户，仅超管），见 PlatformSidebar
  // { name: '用户管理', icon: 'fa-users', path: '/dashboard/users' },
  { name: 'API 测试', icon: 'fa-vial', path: '/test', isDivider: true },
]

export default function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()

  const handleLogout = () => {
    clearAuthToken()
    router.push('/login')
  }

  return (
    <div className="w-56 flex flex-col bg-slate-800 shadow-2xl">
      {/* Logo */}
      <div className="px-4 py-4 border-b border-white/10">
        <div className="flex items-center space-x-2 mb-3">
          <div className="w-8 h-8 bg-primary-500 rounded-lg flex items-center justify-center shadow-lg 
                        transform transition-all duration-300 hover:scale-110 hover:rotate-3">
            <i className="fas fa-database text-white text-sm"></i>
          </div>
          <h1 className="text-base font-semibold text-white tracking-wide">OneBase</h1>
        </div>
        <div className="flex items-center space-x-2 px-2 py-1.5 bg-white/5 rounded">
          <i className="fas fa-user-circle text-xs text-white/60"></i>
          <p className="text-xs text-white/65 truncate flex-1">admin</p>
        </div>
      </div>

      {/* 菜单 */}
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {menuItems.map((item) => (
          <div key={item.path}>
            {item.isDivider && <div className="border-t border-white/10 my-2"></div>}
            <button
              onClick={() => router.push(item.path)}
              className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all duration-200
                         flex items-center space-x-3 group ${
                           pathname === item.path
                             ? 'bg-primary-500 text-white shadow-md'
                             : 'text-white/80 hover:bg-white/10 hover:text-white'
                         }`}
            >
              <i className={`fas ${item.icon} text-xs w-4`}></i>
              <span>{item.name}</span>
            </button>
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

