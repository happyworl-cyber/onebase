'use client'

import { useParams } from 'next/navigation'
import GatewayManager from '@/components/gateway/GatewayManager'
import type { Project } from '@/lib/store'
import { useAppStore } from '@/lib/store'

function fallbackProjectSlug(projectId: string) {
  return `project-${projectId}`
}

export default function WorkspaceGatewayPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const currentProject = useAppStore((state: { currentProject: Project | null }) => state.currentProject)
  const projectSlug = currentProject?.slug || fallbackProjectSlug(params.projectId)
  const projectName = currentProject?.name || projectSlug

  return (
    <GatewayManager
      projectId={Number.isFinite(projectId) ? projectId : undefined}
      projectSlug={projectSlug}
      projectName={projectName}
      workspaceConfig={currentProject?.workspace_config}
    />
  )
}
