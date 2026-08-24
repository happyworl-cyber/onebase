'use client'

import { useParams } from 'next/navigation'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'
import { parsePositiveInt } from './paths'
import WorkflowVersionBrowser from './WorkflowVersionBrowser'

export default function WorkflowVersionPage() {
  const params = useParams<{ projectId: string; workflowId: string; version?: string }>()
  const caps = useCurrentProjectCapabilities()
  const projectId = parsePositiveInt(params.projectId)
  const workflowId = parsePositiveInt(params.workflowId)
  const versionRaw = params.version
  const versionParsed = parsePositiveInt(versionRaw ?? null)
  const versionInvalid = versionRaw != null && versionRaw !== '' && versionParsed == null

  if (!caps.canManageEvents) {
    return <ForbiddenPlaceholder reason="工作流需要 admin+ 角色（owner / admin / 超管）" />
  }
  if (projectId == null) {
    return <div className="p-8 text-center text-gray-500">URL 中的 projectId 无效</div>
  }
  if (workflowId == null) {
    return <div className="p-8 text-center text-gray-500">工作流不存在或无权访问</div>
  }

  return (
    <WorkflowVersionBrowser
      projectId={projectId}
      workflowId={workflowId}
      version={versionParsed}
      versionInvalid={versionInvalid}
    />
  )
}
