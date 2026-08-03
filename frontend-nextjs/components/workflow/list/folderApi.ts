import api from '@/lib/api'
import { FOLDER_NAME_PRESETS } from './constants'
import { ROOT_FOLDER_ID, type WorkflowFolder } from './types'
import { catIdFromNames, deptIdFromName } from './utils'

export interface ApiWorkflowFolder {
  id: number
  database_id: number
  parent_id: number | null
  name: string
  sort_order: number
  is_shared: boolean
}

function presetForFolderName(name: string): { icon: string; color: string } {
  return FOLDER_NAME_PRESETS[name] ?? { icon: 'fa-folder', color: 'text-slate-500' }
}

export function apiFoldersToCustomFolders(apiFolders: ApiWorkflowFolder[]): WorkflowFolder[] {
  const byId = new Map(apiFolders.map((f) => [f.id, f]))
  const result: WorkflowFolder[] = []

  for (const f of apiFolders) {
    if (f.parent_id === null) {
      result.push({
        id: deptIdFromName(f.name),
        parent_id: ROOT_FOLDER_ID,
        name: f.name,
        ...presetForFolderName(f.name),
        server_id: f.id,
      })
    } else {
      const parent = byId.get(f.parent_id)
      if (!parent) continue
      result.push({
        id: catIdFromNames(parent.name, f.name),
        parent_id: deptIdFromName(parent.name),
        name: f.name,
        icon: 'fa-tag',
        color: 'text-slate-500',
        server_id: f.id,
      })
    }
  }
  return result
}

export async function fetchApiFolders(databaseId: number): Promise<ApiWorkflowFolder[]> {
  const res = await api.get<{ folders: ApiWorkflowFolder[] }>('/api/admin/workflow-folders', {
    params: { database_id: databaseId },
    suppressErrorToast: true,
  } as Parameters<typeof api.get>[1])
  return res.data.folders ?? []
}

export async function createApiFolder(
  databaseId: number,
  name: string,
  parentApiId: number | null,
): Promise<ApiWorkflowFolder> {
  const res = await api.post<{ folder: ApiWorkflowFolder }>('/api/admin/workflow-folders', {
    database_id: databaseId,
    parent_id: parentApiId,
    name,
  })
  return res.data.folder
}

export async function deleteApiFolder(serverId: number): Promise<void> {
  await api.delete(`/api/admin/workflow-folders/${serverId}`)
}

export async function moveApiCategoryFolder(
  categoryServerId: number,
  targetDeptServerId: number,
): Promise<ApiWorkflowFolder> {
  const res = await api.patch<{ folder: ApiWorkflowFolder }>(
    `/api/admin/workflow-folders/${categoryServerId}`,
    { parent_id: targetDeptServerId },
  )
  return res.data.folder
}

/** 目标部门若尚无空文件夹记录，则创建一条（便于挂载空分类） */
export async function ensureApiDeptFolder(
  databaseId: number,
  deptName: string,
  apiFolders: ApiWorkflowFolder[],
): Promise<ApiWorkflowFolder> {
  const existing = apiFolders.find((f) => f.parent_id === null && f.name === deptName)
  if (existing) return existing
  return createApiFolder(databaseId, deptName, null)
}

export function findApiCategoryFolder(
  apiFolders: ApiWorkflowFolder[],
  deptName: string,
  categoryName: string,
): ApiWorkflowFolder | undefined {
  const dept = apiFolders.find((f) => f.parent_id === null && f.name === deptName)
  if (!dept) return undefined
  return apiFolders.find((f) => f.parent_id === dept.id && f.name === categoryName)
}
