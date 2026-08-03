/** 工作流列表页 · 文件夹树：全部工作流 → 部门 → 分类 */

import type { WorkflowNodeDef, WorkflowEdgeDef } from '@/components/workflow/WorkflowCanvas'

export const ROOT_FOLDER_ID = 'root'
export const SHARED_DEPARTMENT_NAME = '共享'
export const UNCATEGORIZED_FOLDER_ID = 'folder-uncategorized'
export const UNCATEGORIZED_FOLDER_NAME = '未分类'

export interface WorkflowFolder {
  id: string
  parent_id: string | null
  name: string
  icon: string
  color: string
  /** 后端 workflow_folders 表主键（空文件夹持久化） */
  server_id?: number
}

export type WorkflowListStatus = 'all' | 'on' | 'off'
export type WorkflowListSort = 'updated_at' | 'created_at' | 'name'
export type WorkflowListView = 'compact' | 'card'

export const DEFAULT_LIST_SORT: WorkflowListSort = 'created_at'

export const WORKFLOW_LIST_PER_PAGE_OPTIONS = [10, 20, 50] as const
export type WorkflowListPerPage = (typeof WORKFLOW_LIST_PER_PAGE_OPTIONS)[number]
export const DEFAULT_LIST_PER_PAGE: WorkflowListPerPage = 10

export interface WorkflowListPageState {
  folderId: string
  expanded: Set<string>
  status: WorkflowListStatus
  trigs: Set<string>
  author: string | null
  sort: WorkflowListSort
  view: WorkflowListView
  search: string
  globalSearch: boolean
  page: number
  perPage: WorkflowListPerPage
}

export interface WorkflowListItem {
  id: number
  name: string
  slug: string
  description: string | null
  /** 分类名（部门下的二级目录） */
  category: string | null
  /** 部门名（含「共享」） */
  department: string | null
  database_id: number | null
  trigger_type: string
  trigger_config: Record<string, unknown> | null
  nodes: WorkflowNodeDef[]
  edges: WorkflowEdgeDef[]
  is_enabled: boolean
  timeout_ms: number
  max_retries: number
  alert_webhook_url: string | null
  alert_webhook_template: Record<string, unknown> | null
  alert_throttle_hours: number
  last_alert_sent_at: string | null
  created_by: number | null
  created_by_name: string | null
  created_by_email: string | null
  created_at: string
  updated_at: string
}
