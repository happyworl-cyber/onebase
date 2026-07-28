'use client'

/**
 * `/dashboard/scheduled-tasks` —— 当前项目（租户）下的定时任务管理。
 *
 * 与 `/platform/scheduled-tasks` 共用同一个 `<ScheduledTasksManager />`，区别
 * 在于这里强制传 `lockedTenantId={currentTenant.id}`，所以：
 *   - 列表只显示当前项目下的任务；不会泄漏其他租户的数据
 *   - 表单内的"租户"选择器被隐藏，tenant_id 由项目上下文自动填入
 *   - 数据库下拉只列当前租户能访问的库
 *
 * 平台级（跨租户 / tenant_id=NULL）任务仍然只能从 `/platform/scheduled-tasks`
 * 创建，避免"在 A 项目内创建一个不属于 A 的任务"这种语义错乱。
 *
 * 鉴权：`/dashboard` 的 layout 已经做了"超管未选项目就跳 /platform"的兜底；
 * 这里再多一层 currentTenant 守卫，纯粹是渲染期防御（避免 race）。
 */

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import ScheduledTasksManager from '@/components/ScheduledTasksManager'
import { useAppStore } from '@/lib/store'

export default function TenantScheduledTasksPage() {
  const router = useRouter()
  const currentTenant = useAppStore((s) => s.currentTenant)

  useEffect(() => {
    if (!currentTenant) {
      // 兜底：极端情况下进到这里没有 tenant，回到首页让 layout 决定走平台 or 选项目。
      router.replace('/dashboard')
    }
  }, [currentTenant, router])

  if (!currentTenant) {
    return (
      <div className="text-center py-12 text-gray-400">
        <i className="fas fa-spinner fa-spin text-2xl"></i>
        <p className="text-sm mt-2">正在加载项目上下文…</p>
      </div>
    )
  }

  return <ScheduledTasksManager lockedTenantId={currentTenant.id} />
}
