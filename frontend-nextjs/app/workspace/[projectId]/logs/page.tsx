'use client'

import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import ExecutionLogsView from '@/components/ExecutionLogsView'

/**
 * `/workspace/[projectId]/logs` —— 项目维度的执行日志。
 *
 * W2 不变量：projectId === tenant_id（项目即租户）。把它作为 `tenant_id` 传给
 * 统一执行日志接口，后端按该租户收敛（非超管再与其可管理租户集合求交）。
 * 与平台页 `/platform/logs` 共用 `ExecutionLogsView`。
 */
export default function ProjectLogsPage() {
  const params = useParams<{ projectId: string }>()
  const t = useTranslations('wsLogs')
  const tenantId = Number(params.projectId)

  return (
    <ExecutionLogsView
      tenantId={Number.isFinite(tenantId) ? tenantId : undefined}
      title={t('title')}
      subtitle={t('subtitle')}
    />
  )
}
