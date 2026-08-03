import api from '@/lib/api'

export type ImportAction = 'create' | 'overwrite' | 'rename'

export interface ImportWorkflowDef {
  name: string
  slug: string
  description: string | null
  department: string
  category: string
  trigger_type: string
  trigger_config: Record<string, unknown>
  nodes: unknown[]
  edges: unknown[]
  dependencies?: Record<string, unknown> | null
  timeout_ms: number
  max_retries: number
  alert_webhook_url?: string | null
  alert_webhook_template?: Record<string, unknown> | null
  alert_throttle_hours?: number
}

export interface ImportItem {
  action: ImportAction
  /** 最终落库 slug：rename 为新 slug，create/overwrite 为原 slug */
  slug: string
  workflow: ImportWorkflowDef
}

export interface ImportResultItem {
  action: string
  id: number
  slug: string
  name: string
  /** 后端处理提示（如覆盖时新增节点的数据源/Redis 连接已留空、按名重映射失败等） */
  warnings?: string[]
}

export interface ImportResult {
  total: number
  succeeded: ImportResultItem[]
  succeeded_count: number
  failed: { slug?: string; name?: string; error: string }[]
  failed_count: number
}

/**
 * 批量导入：后端逐条 create/overwrite/rename。新建/重命名默认启用（与手工新建一致），
 * 覆盖保留原启用状态；且覆盖时保留目标环境的连接类配置（节点里的数据源 datasource_id/ref、
 * Redis connection_id），不会被导入文件里的（测试环境）连接覆盖；文件里新增的节点则连接字段
 * 留空，交给用户在编辑器里手动选择。
 */
export async function importWorkflows(
  databaseId: number | null | undefined,
  items: ImportItem[],
): Promise<ImportResult> {
  const res = await api.post('/api/admin/workflows/import', {
    database_id: databaseId ?? null,
    items,
  })
  return res.data as ImportResult
}
