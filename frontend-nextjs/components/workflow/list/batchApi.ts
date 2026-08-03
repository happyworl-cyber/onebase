import api from '@/lib/api'

export type BatchWorkflowAction = 'enable' | 'disable' | 'delete'

export interface BatchWorkflowResult {
  action: BatchWorkflowAction
  total: number
  succeeded: number[]
  succeeded_count: number
  failed: { id: number; error: string }[]
  failed_count: number
}

/** 批量启用/禁用/删除：后端单接口处理，前端只调用一次。 */
async function batchWorkflows(
  action: BatchWorkflowAction,
  ids: number[],
): Promise<BatchWorkflowResult> {
  const res = await api.post('/api/admin/workflows/batch', { action, ids })
  return res.data as BatchWorkflowResult
}

export async function batchSetWorkflowEnabled(ids: number[], enabled: boolean) {
  return batchWorkflows(enabled ? 'enable' : 'disable', ids)
}

export async function batchDeleteWorkflows(ids: number[]) {
  return batchWorkflows('delete', ids)
}
