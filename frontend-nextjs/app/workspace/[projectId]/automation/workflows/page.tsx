'use client'

/**
 * `/workspace/[projectId]/automation/workflows` —— 项目工作区的工作流页。
 *
 * 逻辑复用共享组件 `WorkflowsManager`（与老后台 `/dashboard/workflows` 同源）。
 * 与会话规则页一致：
 * - database_id 取自 currentConnection（不是 projectId；tenants.id ≠ tenant_databases.id）；
 *   传给 WorkflowsManager 做新建时的预填。
 * - 权限门槛 canManageEvents（admin+），与会话规则 / 定时任务同档。
 */

import { useParams } from 'next/navigation'
import Link from 'next/link'
import { useAppStore } from '@/lib/store'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'
import WorkflowsManager from '@/components/workflow/WorkflowsManager'

export default function WorkspaceWorkflowsPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const currentConnection = useAppStore((s) => s.currentConnection)
  const databaseId = currentConnection?.database_id ?? null
  const caps = useCurrentProjectCapabilities()

  if (!caps.canManageEvents) {
    return <ForbiddenPlaceholder reason="工作流需要 admin+ 角色（owner / admin / 超管）" />
  }

  if (isNaN(projectId)) {
    return <div className="p-8 text-center text-gray-500">URL 中的 projectId 无效</div>
  }

  if (!databaseId) {
    return (
      <div className="p-8 text-center text-gray-500 space-y-3">
        <i className="fas fa-plug text-4xl text-gray-300"></i>
        <p>本项目尚未绑定主数据库连接，无法管理工作流。</p>
        <Link
          href={`/workspace/${projectId}/settings/connections`}
          className="text-blue-600 hover:underline"
        >
          前往设置 → 数据库连接
        </Link>
      </div>
    )
  }

  return <WorkflowsManager defaultDatabaseId={databaseId} projectId={projectId} />
}
