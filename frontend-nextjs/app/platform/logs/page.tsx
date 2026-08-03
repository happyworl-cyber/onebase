'use client'

import ExecutionLogsView from '@/components/ExecutionLogsView'

/**
 * 平台级执行日志：超管看全部租户，租户 owner/admin 看自己租户（后端按身份收敛）。
 * 视图主体见 `components/ExecutionLogsView`（与项目级 `/workspace/[id]/logs` 共用）。
 */
export default function ExecutionLogsPage() {
  return <ExecutionLogsView />
}
