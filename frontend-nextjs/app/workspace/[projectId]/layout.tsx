'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter, usePathname } from 'next/navigation'
import api, { type ApiRequestConfig } from '@/lib/api'
import { useAppStore, type Project } from '@/lib/store'
import WorkspaceSidebar from '@/components/workspace/WorkspaceSidebar'
import ProjectTopbar from '@/components/workspace/ProjectTopbar'
import WorkspaceTabBar from '@/components/workspace/WorkspaceTabBar'
import KeepAliveOutlet from '@/components/workspace/KeepAliveOutlet'
import { useWorkspaceTabs } from '@/lib/workspaceTabs'
import { resolveNavMeta } from '@/components/workspace/workspaceNav'

/**
 * 项目壳 layout（W1 spec §3.2.3）。
 *
 * 流程：
 *   1. token 守卫 → 无则跳 /login
 *   2. 校验 projectId 合法（正整数）→ 否则跳 /workspace 让选择页兜底
 *   3. 进入工作空间时清掉旧的 currentTenant，避免与 currentProject 串扰
 *      （旧 dashboard 是按 currentTenant 派生权限的，这里清掉避免回头切换时
 *      用错上下文）
 *   4. GET /api/projects/:id → setCurrentProject
 *   5. 失败兜底：
 *      - 403 → 友好页"你不是此项目成员"
 *      - 404 → 友好页"项目不存在"
 *      - 其他 → 通用错误页
 *   6. 渲染壳：ProjectTopbar + WorkspaceSidebar + main
 *
 * URL 是单一信源：projectId 始终来自 useParams（不读 Zustand 的 currentProject.id），
 * 这样切项目时 URL 一变就重跑 effect、重新派 setCurrentProject，不会用陈旧数据。
 */
export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const params = useParams<{ projectId: string }>()
  const pathname = usePathname()
  const setCurrentProject = useAppStore((s) => s.setCurrentProject)
  const setCurrentOrganization = useAppStore((s) => s.setCurrentOrganization)
  const currentOrganization = useAppStore((s) => s.currentOrganization)
  const setCurrentTenant = useAppStore((s) => s.setCurrentTenant)
  const setCurrentConnection = useAppStore((s) => s.setCurrentConnection)

  // 多 Tab：base + 当前相对路径（'' = 项目首页），以及 tabs store 相关。
  const base = `/workspace/${params.projectId}`
  const relPath =
    pathname === base ? '' : pathname.startsWith(base + '/') ? pathname.slice(base.length) : ''
  const initProject = useWorkspaceTabs((s) => s.initProject)
  const openTab = useWorkspaceTabs((s) => s.openTab)
  // 选稳定的 tabs 引用（仅在 tab 变更时换新），再派生 openPaths，避免选择器每次
  // 返回新数组（zustand v4 下会触发多余渲染）。
  const tabs = useWorkspaceTabs((s) => s.tabs)
  const openPaths = useMemo(() => tabs.map((t) => t.path), [tabs])

  const [authorized, setAuthorized] = useState(false)
  const [errorState, setErrorState] = useState<{
    status: number | null
    message: string
  } | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return

    const token = localStorage.getItem('token')
    if (!token) {
      router.replace('/login')
      return
    }

    const projectId = parseInt(params.projectId, 10)
    if (isNaN(projectId) || projectId <= 0) {
      router.replace('/workspace')
      return
    }

    setCurrentTenant(null)
    // 切项目立刻清掉，避免异步拉取期间拦截器仍带上一项目的 X-Database-Id。
    setCurrentConnection(null)

    setErrorState(null)
    setAuthorized(false)

    api
      .get<Project>(`/api/projects/${projectId}`, {
        suppressErrorToast: true,
      } as ApiRequestConfig)
      .then((resp) => {
        setCurrentProject(resp.data)

        // 从项目响应回填组织上下文（直链进 workspace 时 store 可能为空）
        if (
          resp.data.organization_id != null &&
          (!currentOrganization ||
            currentOrganization.id !== resp.data.organization_id)
        ) {
          setCurrentOrganization({
            id: resp.data.organization_id,
            name: resp.data.organization_name || `组织 #${resp.data.organization_id}`,
            slug: '',
            status: 'active',
            user_role: currentOrganization?.user_role || 'member',
          })
        }

        // 把项目主连接铺到 currentConnection，让 schema/query/rpc 拦截器
        // 读到正确的 X-Database-Id。无主连接时必须清空——否则切到无库项目
        // 会残留上一项目的 database_id，API Key 页会列出别的项目的 key。
        const pc = resp.data.primary_connection
        if (pc) {
          setCurrentConnection({
            // user_id / username 在拦截器和大多数 page 里都不被读，但接口
            // 形状里有；W2 阶段先填 0/'' 占位，等 W4 设置页接入时再补
            user_id: 0,
            username: '',
            tenant_id: resp.data.id,
            tenant_name: resp.data.name,
            database_id: pc.database_id,
            database_slug: pc.database_slug,
            connection_name: pc.db_name,
            db_host: pc.db_host,
            db_port: pc.db_port,
            db_name: pc.db_name,
            is_primary: pc.is_primary,
            user_role: resp.data.user_role,
          })
        } else {
          setCurrentConnection(null)
        }

        setAuthorized(true)
      })
      .catch((err) => {
        const status = err?.response?.status ?? null
        const message =
          err?.response?.data?.error || err?.message || '加载项目失败'
        setErrorState({ status, message })
      })
  }, [params.projectId, router, setCurrentProject, setCurrentTenant, setCurrentConnection])

  // 多 Tab：绑定项目（切项目时从 sessionStorage 恢复该项目 Tab），并在授权且
  // 路由变化时打开/激活对应 Tab（标题 / 图标取自共享 NAV 元数据）。
  useEffect(() => {
    if (!params.projectId) return
    initProject(params.projectId)
    if (!authorized) return
    const meta = resolveNavMeta(relPath)
    openTab({ path: relPath, title: meta.label, icon: meta.icon })
  }, [params.projectId, relPath, authorized, initProject, openTab])

  if (errorState) {
    const isForbidden = errorState.status === 403
    const isNotFound = errorState.status === 404
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-6">
        <div className="max-w-md text-center">
          <div className="w-16 h-16 rounded-full bg-amber-50 border border-amber-200 mx-auto mb-4 flex items-center justify-center">
            <i className="fas fa-lock text-2xl text-amber-600"></i>
          </div>
          <h2 className="text-base font-medium text-gray-900 mb-2">
            {isForbidden && '你不是此项目的成员'}
            {isNotFound && '项目不存在'}
            {!isForbidden && !isNotFound && '加载项目失败'}
          </h2>
          <p className="text-sm text-gray-500 mb-6">{errorState.message}</p>
          <button
            onClick={() => router.push('/workspace')}
            className="text-sm text-blue-600 hover:underline"
          >
            ← 返回项目列表
          </button>
        </div>
      </div>
    )
  }

  if (!authorized) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <i className="fas fa-spinner fa-spin text-2xl text-gray-400 mb-2"></i>
          <p className="text-sm text-gray-500">加载项目…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <ProjectTopbar />
      <div className="flex-1 flex overflow-hidden">
        <WorkspaceSidebar />
        {/* 内容区：Tab 栏 + 保活容器。各页面的滚动/内边距下沉到 KeepAliveOutlet
            的每个面板里（p-6 overflow-auto），非激活面板 display:none 但保持挂载。 */}
        <main className="flex-1 flex flex-col overflow-hidden min-w-0">
          <WorkspaceTabBar base={base} />
          <div className="flex-1 min-h-0">
            <KeepAliveOutlet currentPath={relPath} openPaths={openPaths}>
              {children}
            </KeepAliveOutlet>
          </div>
        </main>
      </div>
    </div>
  )
}
