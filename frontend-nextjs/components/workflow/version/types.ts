import type { WorkflowEdgeDef, WorkflowNodeDef } from '@/components/workflow/WorkflowCanvas'

export interface WorkflowVersionListItem {
  id: number
  version: number
  name: string
  note: string | null
  trigger_type: string
  node_count: number | null
  created_at: string
  created_by: number | null
  created_by_name: string | null
  created_by_email: string | null
}

export interface WorkflowVersionSnapshot {
  id: number
  workflow_id: number
  version: number
  name: string
  slug: string
  description: string | null
  category: string | null
  department: string | null
  trigger_type: string
  trigger_config: Record<string, unknown>
  nodes: WorkflowNodeDef[]
  edges: WorkflowEdgeDef[]
  timeout_ms: number
  max_retries: number
  note: string | null
  created_by: number | null
  created_at: string
  created_by_name: string | null
  created_by_email: string | null
}

export interface WorkflowVersionHeader {
  id: number
  name: string
  slug: string
}
