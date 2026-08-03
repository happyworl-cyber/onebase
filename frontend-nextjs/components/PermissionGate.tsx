'use client'

import { useRouter } from 'next/navigation'
import {
  useEffectiveRole,
  useUiCapabilities,
  type UiCapabilities,
} from '@/lib/permissions'

interface PermissionGateProps {
  /** 进入该页面需要的能力，对应 `lib/permissions::UiCapabilities` 字段 */
  requires: keyof UiCapabilities
  /** 显示在降级面板顶端的页面名（中文），如「RBAC 角色管理」 */
  pageName: string
  /** 自定义补充说明；默认会列举一句通用的解释。 */
  description?: string
  children: React.ReactNode
}

/**
 * 页面级权限闸门。
 *
 * 用法：
 * ```tsx
 * export default function RolesPage() {
 *   return (
 *     <PermissionGate requires="canManageRbac" pageName="RBAC 角色管理">
 *       <RolesPageInner />
 *     </PermissionGate>
 *   )
 * }
 * ```
 *
 * 行为：
 *   - 能力满足：直接渲染 children；
 *   - 能力不满足：渲染友好降级面板（解释 + 「返回首页」按钮），不再裸着发请求
 *     被 403 弹红。后端依旧是权威鉴权，这里只为 UX。
 *
 * 与 SidebarV3 的 requires 字段相互独立：SidebarV3 决定"看不看得到入口"，
 * PermissionGate 决定"直链 / 收藏 / 用户切换租户后落地时能否进入"。
 */
export default function PermissionGate({
  requires,
  pageName,
  description,
  children,
}: PermissionGateProps) {
  const router = useRouter()
  const role = useEffectiveRole()
  const capabilities = useUiCapabilities()

  if (capabilities[requires]) {
    return <>{children}</>
  }

  // 未登录：跳到登录页（保留路径以便回跳）
  if (!role.isAuthenticated) {
    if (typeof window !== 'undefined') {
      router.push('/login')
    }
    return null
  }

  return (
    <div className="max-w-2xl mx-auto mt-24 px-6">
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-10 text-center">
        <div className="w-14 h-14 mx-auto bg-amber-50 rounded-full flex items-center justify-center mb-5">
          <i className="fas fa-lock text-amber-500 text-xl" />
        </div>
        <h1 className="text-xl font-semibold text-gray-900">需要管理员权限</h1>
        <p className="text-sm text-gray-500 mt-2 leading-relaxed">
          页面 <span className="text-gray-700 font-medium">「{pageName}」</span>
          仅对当前项目的 <span className="text-gray-700 font-medium">Owner / Admin</span> 或
          <span className="text-gray-700 font-medium"> 平台超级管理员</span>开放。
        </p>
        <p className="text-sm text-gray-500 mt-2 leading-relaxed">
          {description ??
            '你目前在该项目内是普通成员，可继续浏览数据、调用 API；如需配置权限/角色/SSO 等，请联系项目管理员。'}
        </p>
        <div className="mt-3 text-xs text-gray-400">
          当前身份：
          {role.isPlatformSuperadmin
            ? '平台超级管理员'
            : role.tenantRole
              ? `${role.tenantRole}（项目成员）`
              : '未选择项目'}
        </div>
        <div className="flex items-center justify-center gap-3 mt-7">
          <button
            onClick={() => router.push('/workspace')}
            className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-700"
          >
            返回首页
          </button>
          <button
            onClick={() => router.back()}
            className="px-4 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm hover:bg-gray-200"
          >
            返回上一页
          </button>
        </div>
      </div>
    </div>
  )
}
