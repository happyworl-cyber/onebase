'use client'

import { useTranslations } from 'next-intl'

import { useParams } from 'next/navigation'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'
import { parsePositiveInt } from './paths'
import WorkflowVersionBrowser from './WorkflowVersionBrowser'

export default function WorkflowVersionPage() {
  const t = useTranslations('wfCanvas')
  const params = useParams<{ projectId: string; workflowId: string; version?: string }>()
  const caps = useCurrentProjectCapabilities()
  const projectId = parsePositiveInt(params.projectId)
  const workflowId = parsePositiveInt(params.workflowId)
  const versionRaw = params.version
  const versionParsed = parsePositiveInt(versionRaw ?? null)
  const versionInvalid = versionRaw != null && versionRaw !== '' && versionParsed == null

  if (!caps.canManageEvents) {
    return <ForbiddenPlaceholder reason={t('forbidden')} />
  }
  if (projectId == null) {
    return <div className="p-8 text-center text-gray-500">{t('invalidProject')}</div>
  }
  if (workflowId == null) {
    return <div className="p-8 text-center text-gray-500">{t('notFound')}</div>
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
