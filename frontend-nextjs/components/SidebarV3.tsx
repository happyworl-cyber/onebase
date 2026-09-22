'use client'

import { useState, useEffect, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { usePathname, useRouter } from 'next/navigation'
import { useAppStore } from '@/lib/store'
import { clearAuthToken } from '@/lib/auth'
import InlineLocaleSwitcher from '@/components/InlineLocaleSwitcher'
import { useUiCapabilities, type UiCapabilities } from '@/lib/permissions'
import SchemaSelector from './SchemaSelector'

interface MenuItem {
  id: string
  nameKey: string
  icon: string
  path?: string
  badge?: string
  children?: SubMenuItem[]
  /**
   * 该条目仅在用户具备指定 UI 能力时显示。
   * 取值对应 `lib/permissions::UiCapabilities` 的字段名；不设则默认所有登入用户可见。
   * 顶层条目若 children 全部被过滤掉，则该组也整组隐藏。
   */
  requires?: keyof UiCapabilities
}

interface SubMenuItem {
  nameKey: string
  path: string
  badge?: string
  comingSoon?: boolean
  requires?: keyof UiCapabilities
}

// ── 菜单结构（5+1 方案）──
// 设计原则：
//   语义唯一 —— 每个一级分组有且只有一个明确含义
//   子项内聚 —— 同组子项操作同一对象或服务同一场景
//   层级最小 —— 子项不超过 8 个
//
// `requires` 字段对齐 `lib/permissions::deriveUiCapabilities`：
// - 不带 requires 的条目面向所有租户成员
// - 带 requires 的条目仅 UX 隐藏，后端始终鉴权兜底
const menuStructure: MenuItem[] = [
  {
    id: 'home',
    nameKey: 'navHome',
    icon: 'fa-home',
    path: '/dashboard',
  },
  {
    id: 'data',
    nameKey: 'grpData',
    icon: 'fa-database',
    children: [
      { nameKey: 'navVisualizer', path: '/dashboard/visualizer' },
      { nameKey: 'navTables', path: '/dashboard/tables', badge: 'New' },
      { nameKey: 'navTableDesigner', path: '/dashboard/table-designer', badge: 'New', requires: 'canRunDdl' },
      { nameKey: 'navQuery', path: '/dashboard/query', requires: 'canRunAnySql' },
      { nameKey: 'navImport', path: '/dashboard/import', badge: 'New', requires: 'canRunDdl' },
      { nameKey: 'navTransaction', path: '/dashboard/transaction', requires: 'canRunAnySql' },
      { nameKey: 'navBackup', path: '/dashboard/backup', requires: 'canExport' },
      { nameKey: 'navExtensions', path: '/dashboard/extensions', badge: 'New', requires: 'canRunDdl' },
    ],
  },
  {
    id: 'api',
    nameKey: 'grpApi',
    icon: 'fa-plug',
    children: [
      { nameKey: 'navApiDoc', path: '/dashboard/api', badge: 'New' },
      { nameKey: 'navWebhooks', path: '/dashboard/webhooks', requires: 'canManageWebhooks' },
      { nameKey: 'navEs', path: '/dashboard/es-connections', requires: 'canManageApiKeys' },
      { nameKey: 'navApiTest', path: '/dashboard/test' },
    ],
  },
  {
    id: 'automation',
    nameKey: 'grpAutomation',
    icon: 'fa-bolt',
    children: [
      { nameKey: 'navFunctions', path: '/dashboard/functions' },
      { nameKey: 'navRpc', path: '/dashboard/rpc' },
      { nameKey: 'navTriggers', path: '/dashboard/triggers' },
      { nameKey: 'navWorkflows', path: '/dashboard/workflows', requires: 'canManageWebhooks' },
      { nameKey: 'navScheduled', path: '/dashboard/scheduled-tasks', requires: 'canManageWebhooks' },
    ],
  },
  {
    id: 'security',
    nameKey: 'grpSecurity',
    icon: 'fa-shield-alt',
    requires: 'canManageRbac',
    children: [
      { nameKey: 'navRls', path: '/dashboard/rls', badge: 'RBAC' },
      { nameKey: 'navRoles', path: '/dashboard/roles', badge: 'RBAC' },
      { nameKey: 'navRpcAcl', path: '/dashboard/rpc-acl', badge: 'RBAC' },
    ],
  },
  {
    id: 'monitor',
    nameKey: 'grpMonitor',
    icon: 'fa-chart-line',
    children: [
      { nameKey: 'navMonitor', path: '/dashboard/monitor', badge: 'New', requires: 'canViewMonitor' },
      { nameKey: 'navConnections', path: '/dashboard/connections' },
      { nameKey: 'navIndexes', path: '/dashboard/indexes', requires: 'canRunDdl' },
      { nameKey: 'navQueryAnalyzer', path: '/dashboard/query-analyzer', requires: 'canRunAnySql' },
      { nameKey: 'navSlowQueries', path: '/dashboard/slow-queries', requires: 'canRunAnySql' },
      { nameKey: 'navMigrations', path: '/dashboard/migrations', comingSoon: true },
      { nameKey: 'navAdvisor', path: '/dashboard/advisor', comingSoon: true },
    ],
  },
]

/**
 * 根据用户当前能力过滤菜单：
 *   1. 先过滤每个 group 下的 children；
 *   2. 再把自己 `requires` 不满足、或者过滤后既无 path 又无 children 的 group 整组移除。
 * 注：当能力变化时 useMemo 会重算，路由不会被强制跳转——若用户深链到已隐藏页面，
 * 后端会以 403 兜底，前端 D3 任务里另给"友好降级"。
 */
function filterMenuByCapabilities(menu: MenuItem[], caps: UiCapabilities): MenuItem[] {
  return menu
    .map((group) => {
      if (group.requires && !caps[group.requires]) return null
      if (!group.children) return group
      const visibleChildren = group.children.filter(
        (c) => !c.requires || caps[c.requires],
      )
      if (visibleChildren.length === 0 && !group.path) return null
      return { ...group, children: visibleChildren }
    })
    .filter((g): g is MenuItem => g !== null)
}

export default function SidebarV3() {
  const t = useTranslations('dashboardSidebar')
  const pathname = usePathname()
  const router = useRouter()
  const [activeGroup, setActiveGroup] = useState<string>('')
  const [showUserMenu, setShowUserMenu] = useState(false)
  
  // 从 store 获取用户和项目信息
  const { currentTenant, currentUser } = useAppStore()
  const capabilities = useUiCapabilities()
  const visibleMenu = useMemo(
    () => filterMenuByCapabilities(menuStructure, capabilities),
    [capabilities],
  )
  const [user, setUser] = useState<any>(null)
  const [tenant, setTenant] = useState<any>(null)

  useEffect(() => {
    // 从 localStorage 读取用户和项目信息（避免 SSR 问题）
    if (typeof window !== 'undefined') {
      const userStr = localStorage.getItem('current_user')
      const tenantStr = localStorage.getItem('current_tenant')
      if (userStr) {
        setUser(JSON.parse(userStr))
      }
      if (tenantStr) {
        setTenant(JSON.parse(tenantStr))
      }
    }
  }, [currentTenant, currentUser])

  // 根据当前路径自动设置激活的分组
  // 关键：若当前路径不属于任何带 children 的分组（如 /dashboard、/dashboard/api 这种顶层条目），
  // 必须清空 activeGroup，否则中间那栏会保留上一次进入分组时的子菜单。
  useEffect(() => {
    const matched = visibleMenu.find(
      (item) => item.children?.some((child) => child.path === pathname),
    )
    setActiveGroup(matched?.id ?? '')
  }, [pathname, visibleMenu])

  const handleLogout = () => {
    clearAuthToken()
    localStorage.removeItem('current_user')
    localStorage.removeItem('current_tenant')
    localStorage.removeItem('current_connection')
    router.push('/login')
  }

  const handleBackToPlatform = () => {
    // 清除当前项目，返回平台管理页面
    localStorage.removeItem('current_tenant')
    localStorage.removeItem('current_connection')
    router.push('/platform')
  }

  const isActive = (path: string) => {
    if (path === '/dashboard') {
      return pathname === '/dashboard'
    }
    return pathname === path
  }

  const handleGroupClick = (group: MenuItem) => {
    if (group.path) {
      router.push(group.path)
    } else if (group.children && group.children.length > 0) {
      setActiveGroup(group.id)
      const firstChild = group.children[0]
      if (!firstChild.comingSoon && firstChild.path) {
        router.push(firstChild.path)
      }
    }
  }

  const handleSubMenuClick = (path: string, comingSoon?: boolean) => {
    if (!comingSoon) {
      router.push(path)
    }
  }

  const currentMenu = visibleMenu.find((m) => m.id === activeGroup)
  const isSuperAdmin = user?.is_superadmin === true

  return (
    // 与 dashboard layout 的 min-h-screen 同行：主内容增高时侧栏需随列拉伸，不能锁死 h-screen，
    // 否则底部用户信息无法真正「吸底」到可视区域底部。
    <div className="flex min-h-screen self-stretch bg-slate-50">
      {/* 左侧主菜单栏 */}
      <div className="w-[220px] h-full min-h-0 bg-white border-r border-gray-200 flex flex-col">
        {/* Logo */}
        <div className="h-[60px] flex items-center px-5 border-b border-gray-200">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-blue-600 rounded-lg flex items-center justify-center shadow-sm">
              <i className="fas fa-database text-white text-sm"></i>
            </div>
            <div>
              <h1 className="text-sm font-semibold text-gray-900">PlaneOS</h1>
              <p className="text-[11px] text-gray-500">Database Management</p>
            </div>
          </div>
        </div>

        {/* 当前项目信息 */}
        <div className="px-3 py-3 border-b border-gray-200">
          {tenant ? (
            <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg p-3 border border-blue-100">
              <div className="flex items-center space-x-2.5 mb-2">
                <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-blue-600 rounded-lg flex items-center justify-center">
                  <i className="fas fa-folder text-white text-xs"></i>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">{tenant.name}</p>
                  <p className="text-[11px] text-gray-500 truncate">{tenant.db_name}</p>
                </div>
              </div>
              {isSuperAdmin && (
                <button
                  onClick={handleBackToPlatform}
                  className="w-full text-xs text-blue-600 hover:text-blue-700 flex items-center justify-center space-x-1 mt-1 py-1.5 hover:bg-blue-100/50 rounded transition-colors"
                >
                  <i className="fas fa-arrow-left"></i>
                  <span>{t('backToList')}</span>
                </button>
              )}
            </div>
          ) : (
            <div className="bg-yellow-50 rounded-lg p-3 border border-yellow-200">
              <p className="text-xs text-yellow-700 flex items-center">
                <i className="fas fa-exclamation-triangle mr-2"></i>
                {t('noProject')}
              </p>
              {isSuperAdmin && (
                <button
                  onClick={handleBackToPlatform}
                  className="w-full text-xs text-yellow-700 hover:text-yellow-800 flex items-center justify-center space-x-1 mt-2 py-1.5 hover:bg-yellow-100 rounded transition-colors"
                >
                  <span>{t('goSelectProject')}</span>
                  <i className="fas fa-arrow-right"></i>
                </button>
              )}
            </div>
          )}
          
          {/* Schema 选择器 */}
          {tenant && (
            <div className="mt-2">
              <SchemaSelector />
            </div>
          )}
        </div>

        {/* 主菜单：min-h-0 保证 flex 子项可收缩，长菜单在列内滚动 */}
        <nav className="flex-1 min-h-0 px-3 py-2 overflow-y-auto">
          <div className="space-y-0.5">
            {visibleMenu.map((item) => (
              <button
                key={item.id}
                onClick={() => handleGroupClick(item)}
                className={`w-full flex items-center space-x-3 px-3 py-2 rounded-md text-[13px] transition-all duration-150
                  ${activeGroup === item.id && item.children
                    ? 'bg-gray-100 text-gray-900 font-semibold'
                    : isActive(item.path || '')
                    ? 'bg-blue-50 text-blue-600 font-semibold'
                    : 'text-gray-700 hover:bg-gray-50 hover:text-gray-900'
                  }`}
              >
                <i className={`fas ${item.icon} text-sm w-4 flex-shrink-0 ${
                  activeGroup === item.id && item.children
                    ? 'text-gray-700'
                    : isActive(item.path || '')
                    ? 'text-blue-600'
                    : 'text-gray-400'
                }`}></i>
                <span className="flex-1 text-left">{t(item.nameKey)}</span>
                {item.children && activeGroup === item.id && (
                  <i className="fas fa-chevron-right text-[10px] text-gray-400"></i>
                )}
              </button>
            ))}
          </div>
        </nav>

        {/* 底部用户信息：shrink-0 + mt-auto 双保险，始终贴在侧栏列底 */}
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
              <p className="text-xs font-medium text-gray-900 truncate">{user?.username || t('user')}</p>
              <p className="text-[11px] text-gray-500 truncate">
                {isSuperAdmin ? t('superAdmin') : t('user')}
              </p>
            </div>
            <i className={`fas fa-chevron-down text-gray-400 text-[10px] flex-shrink-0 transition-transform ${showUserMenu ? 'rotate-180' : ''}`}></i>
          </button>
          
          {/* 用户下拉菜单 */}
          {showUserMenu && (
            <div className="absolute bottom-full left-3 right-3 mb-2 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
              <div className="py-1">
                <button
                  type="button"
                  onClick={() => {
                    setShowUserMenu(false)
                    router.push('/account')
                  }}
                  className="w-full flex items-center space-x-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  <i className="fas fa-user text-xs w-4 text-gray-400"></i>
                  <span>{t('accountSettings')}</span>
                </button>
                <button
                  className="w-full flex items-center space-x-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  <i className="fas fa-cog text-xs w-4 text-gray-400"></i>
                  <span>{t('settings')}</span>
                </button>
                {isSuperAdmin && (
                  <>
                    <div className="border-t border-gray-100 my-1"></div>
                    <button
                      onClick={handleBackToPlatform}
                      className="w-full flex items-center space-x-2.5 px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 transition-colors"
                    >
                      <i className="fas fa-building text-xs w-4"></i>
                      <span>{t('platformAdmin')}</span>
                    </button>
                  </>
                )}
                <div className="border-t border-gray-100 my-1"></div>
                <InlineLocaleSwitcher onChosen={() => setShowUserMenu(false)} />
                <div className="border-t border-gray-100 my-1"></div>
                <button
                  onClick={handleLogout}
                  className="w-full flex items-center space-x-2.5 px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
                >
                  <i className="fas fa-sign-out-alt text-xs w-4"></i>
                  <span>{t('logout')}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 右侧子菜单栏 */}
      {currentMenu?.children && (
        <div className="w-[200px] h-full min-h-0 bg-white border-r border-gray-200 flex flex-col">
          {/* 子菜单标题 */}
          <div className="h-[60px] flex items-center px-4 border-b border-gray-200">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              {t(currentMenu.nameKey)}
            </h2>
          </div>

          {/* 子菜单列表 */}
          <nav className="flex-1 px-3 py-3 overflow-y-auto">
            <div className="space-y-0.5">
              {currentMenu.children.map((subItem) => (
                <button
                  key={subItem.path}
                  onClick={() => handleSubMenuClick(subItem.path, subItem.comingSoon)}
                  disabled={subItem.comingSoon}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-md text-[13px] transition-all duration-150
                    ${isActive(subItem.path)
                      ? 'bg-blue-50 text-blue-600 font-semibold'
                      : subItem.comingSoon
                      ? 'text-gray-400 cursor-not-allowed'
                      : 'text-gray-700 hover:bg-gray-50 hover:text-gray-900'
                    }`}
                >
                  <span>{t(subItem.nameKey)}</span>
                  {subItem.comingSoon && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded font-medium">
                      Soon
                    </span>
                  )}
                  {subItem.badge && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-600 rounded font-medium">
                      {subItem.badge}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </nav>

          {/* 帮助链接 */}
          <div className="border-t border-gray-200 px-3 py-3">
            <a
              href="#"
              className="flex items-center space-x-2 px-3 py-2 text-xs text-gray-600 hover:text-gray-900 transition-colors"
            >
              <i className="fas fa-question-circle"></i>
              <span>{t('helpDocs')}</span>
            </a>
          </div>
        </div>
      )}
    </div>
  )
}
