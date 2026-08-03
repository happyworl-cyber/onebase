import api from '@/lib/api'
import {
  CAT_PREFIX,
  DEPT_PREFIX,
  SHARED_DEPARTMENT_NAME,
  catNamesFromId,
  deptNameFromId,
  sharedUncategorizedFolderId,
} from './utils'
import {
  ROOT_FOLDER_ID,
  UNCATEGORIZED_FOLDER_ID,
  type WorkflowListItem,
  type WorkflowListPageState,
} from './types'

function effectiveFolderId(folderId: string): string {
  if (folderId === UNCATEGORIZED_FOLDER_ID) {
    return sharedUncategorizedFolderId()
  }
  return folderId
}

import type { WorkflowGroupCount } from './utils'

export interface WorkflowListSummary {
  groups: WorkflowGroupCount[]
  total: number
}

export interface PaginatedWorkflowList {
  workflows: WorkflowListItem[]
  total: number
  page: number
  page_size: number
  authors?: string[]
}

export function buildListQueryParams(
  state: WorkflowListPageState,
  defaultDatabaseId?: number | null,
): Record<string, string | number> {
  const params: Record<string, string | number> = {
    page: state.page,
    page_size: state.perPage,
    sort: state.sort,
    include_authors: '1',
  }

  if (defaultDatabaseId != null) {
    params.database_id = defaultDatabaseId
  }

  const folderId = effectiveFolderId(state.folderId)

  if (state.globalSearch) {
    // 全局搜索：横跨该项目库的所有文件夹，不带部门/分类过滤。
    params.global_search = '1'
  } else if (folderId.startsWith(CAT_PREFIX)) {
    const cat = catNamesFromId(folderId)
    if (cat) {
      params.department = cat.dept
      params.category = cat.cat
    }
  } else if (folderId.startsWith(DEPT_PREFIX)) {
    const dept = deptNameFromId(folderId)
    if (dept) params.department = dept
  }

  if (state.status === 'on') params.is_enabled = 'true'
  else if (state.status === 'off') params.is_enabled = 'false'

  if (state.trigs.size > 0) {
    params.trigger_type = Array.from(state.trigs).join(',')
  }

  if (state.author) params.author = state.author

  const q = state.search.trim()
  if (q) params.search = q

  return params
}

export async function fetchWorkflowList(
  state: WorkflowListPageState,
  defaultDatabaseId?: number | null,
): Promise<PaginatedWorkflowList> {
  const res = await api.get('/api/admin/workflows', {
    params: buildListQueryParams(state, defaultDatabaseId),
  })
  const data = res.data
  return {
    workflows: data.workflows ?? [],
    total: data.total ?? 0,
    page: data.page ?? state.page,
    page_size: data.page_size ?? state.perPage,
    authors: data.authors,
  }
}

export async function fetchWorkflowSummary(
  defaultDatabaseId?: number | null,
  tenantId?: number | null,
): Promise<WorkflowListSummary> {
  const params: Record<string, number> = {}
  if (defaultDatabaseId != null) params.database_id = defaultDatabaseId
  else if (tenantId != null) params.tenant_id = tenantId

  const res = await api.get('/api/admin/workflows/summary', { params })
  return {
    groups: res.data.groups ?? [],
    total: res.data.total ?? 0,
  }
}

/** 批量导入预检用：拉取目标库下全部工作流（用于 slug 冲突检测与差异对比）。 */
export async function fetchExistingWorkflows(
  defaultDatabaseId?: number | null,
): Promise<WorkflowListItem[]> {
  const params: Record<string, string | number> = {}
  if (defaultDatabaseId != null) params.database_id = defaultDatabaseId
  const res = await api.get('/api/admin/workflows', { params })
  return res.data.workflows ?? []
}

export async function fetchWorkflowsByCategory(
  department: string,
  category: string,
  defaultDatabaseId?: number | null,
): Promise<WorkflowListItem[]> {
  const params: Record<string, string | number> = {
    department,
    category,
  }
  if (defaultDatabaseId != null) params.database_id = defaultDatabaseId

  const res = await api.get('/api/admin/workflows', { params })
  return res.data.workflows ?? []
}
