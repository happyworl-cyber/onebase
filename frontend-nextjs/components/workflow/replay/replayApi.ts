import api from '@/lib/api'
import type { WorkflowNodeDef, WorkflowEdgeDef } from '@/components/workflow/WorkflowCanvas'

/** 单节点执行结果——后端 workflow_engine.rs NodeExecutionResult 的前端镜像。 */
export interface ReplayNodeResult {
  node_id: string
  node_type?: string | null
  status: 'success' | 'failed' | 'failed_allowed' | 'skipped' | string
  elapsed_ms?: number | null
  error?: string | null
  branch?: string | null
  input?: unknown
  output?: unknown
}

/** 运行列表一行——GET /api/admin/workflows/:id/runs。 */
export interface ReplayRunSummary {
  id: number
  workflow_id: number
  status: string
  trigger_type?: string | null
  elapsed_ms: number | null
  started_at: string
  completed_at: string | null
  node_results?: ReplayNodeResult[]
}

/** 单次运行明细——GET /api/admin/workflows/:id/runs/:run_id。 */
export interface ReplayRunDetail extends ReplayRunSummary {
  error_message: string | null
  final_output?: unknown
  node_results: ReplayNodeResult[]
}

export async function fetchReplayRuns(workflowId: number, limit = 20): Promise<ReplayRunSummary[]> {
  const res = await api.get(`/api/admin/workflows/${workflowId}/runs`, { params: { limit } })
  return res.data.runs ?? []
}

export async function fetchReplayRunDetail(workflowId: number, runId: number): Promise<ReplayRunDetail> {
  const res = await api.get(`/api/admin/workflows/${workflowId}/runs/${runId}`)
  return res.data
}

/** 回放图底图：工作流自身结构，与 WorkflowCanvas 编辑器用的是同一份 nodes/edges。 */
export interface ReplayWorkflowStructure {
  nodes: WorkflowNodeDef[]
  edges: WorkflowEdgeDef[]
}
