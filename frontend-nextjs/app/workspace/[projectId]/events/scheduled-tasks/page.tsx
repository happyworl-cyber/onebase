'use client'

/**
 * `/workspace/[projectId]/events/scheduled-tasks` — 项目维度的定时任务管理（W2）。
 *
 * 与 `/platform/scheduled-tasks` 共用 `<ScheduledTasksManager />`，区别仅在传
 * `lockedTenantId`：本页强制锁定为 URL 里的 projectId，因此：
 *   - 列表只看见本项目下的任务
 *   - 表单"租户"选择器被隐藏，tenant_id 由项目上下文写入
 *   - 数据库下拉只列本租户的库
 *
 * 平台级（tenant_id=NULL）任务仍只能在 `/platform/scheduled-tasks` 创建，避免
 * "在 A 项目内造一个不属于 A 的任务" 这种语义错乱。
 *
 * 鉴权：`/workspace/[projectId]/layout.tsx` 已经做了 token + 项目成员校验；
 * 角色门槛靠 `useCurrentProjectCapabilities().canManageEvents`（admin+）。
 */

import { useParams } from 'next/navigation'
import ScheduledTasksManager from '@/components/ScheduledTasksManager'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'

export default function ProjectScheduledTasksPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const caps = useCurrentProjectCapabilities()

  if (!caps.canManageEvents) {
    return (
      <ForbiddenPlaceholder reason="定时任务管理需要 admin+ 角色（owner / admin / 超管）" />
    )
  }

  return <ScheduledTasksManager lockedTenantId={projectId} />
}
