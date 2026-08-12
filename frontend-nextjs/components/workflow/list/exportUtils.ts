import type { WorkflowListItem } from './types'
import { resolveWorkflowTaxonomy } from './utils'
import api, { type ApiRequestConfig } from '@/lib/api'

/**
 * 导出审计回执：工作流导出是前端本地生成 JSON（无后端调用），
 * 因此在触发下载后 fire-and-forget 通知后端记 EXPORT 打点。
 * 审计失败不影响导出体验（suppressErrorToast + 吞掉异常）。
 */
export function auditWorkflowExport(ids: Array<number | null | undefined>) {
  const valid = ids.filter((id): id is number => typeof id === 'number' && Number.isFinite(id) && id > 0)
  if (valid.length === 0) return
  api
    .post('/api/admin/workflows/export-audit', { ids: valid }, { suppressErrorToast: true } as ApiRequestConfig)
    .catch(() => {})
}

export const WORKFLOW_EXPORT_FORMAT = 'onebase.workflow'
export const WORKFLOW_EXPORT_VERSION = 1

type ExportableWorkflow = Pick<
  WorkflowListItem,
  | 'name'
  | 'slug'
  | 'description'
  | 'department'
  | 'category'
  | 'trigger_type'
  | 'trigger_config'
  | 'nodes'
  | 'edges'
  | 'timeout_ms'
  | 'max_retries'
  | 'alert_webhook_url'
  | 'alert_webhook_template'
  | 'alert_throttle_hours'
> & { dependencies?: unknown | null }

/** 导出时写入明确的服务 / 分类（与列表文件夹树一致，避免 DB 空值导出为 null） */
export function resolveExportPlacement(wf: Pick<WorkflowListItem, 'department' | 'category'>) {
  const tax = resolveWorkflowTaxonomy(wf)
  return {
    department: tax.department ?? '',
    category: tax.category ?? '',
  }
}

export function buildWorkflowExportEnvelope(wf: ExportableWorkflow) {
  const placement = resolveExportPlacement(wf)
  return {
    format: WORKFLOW_EXPORT_FORMAT,
    version: WORKFLOW_EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    workflow: {
      name: wf.name,
      slug: wf.slug,
      description: wf.description,
      department: placement.department,
      category: placement.category,
      trigger_type: wf.trigger_type,
      trigger_config: wf.trigger_config ?? {},
      nodes: wf.nodes ?? [],
      edges: wf.edges ?? [],
      dependencies: wf.dependencies ?? {},
      timeout_ms: wf.timeout_ms,
      max_retries: wf.max_retries,
      alert_webhook_url: wf.alert_webhook_url ?? null,
      alert_webhook_template: wf.alert_webhook_template ?? null,
      alert_throttle_hours: wf.alert_throttle_hours ?? 24,
    },
  }
}

export function downloadWorkflowJson(wf: ExportableWorkflow) {
  const envelope = buildWorkflowExportEnvelope(wf)
  const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${wf.slug || 'workflow'}.workflow.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export async function downloadWorkflowJsonBatch(
  workflows: ExportableWorkflow[],
  onProgress?: (index: number, total: number, wf: ExportableWorkflow) => void,
) {
  for (let i = 0; i < workflows.length; i++) {
    const wf = workflows[i]
    onProgress?.(i, workflows.length, wf)
    downloadWorkflowJson(wf)
    if (i < workflows.length - 1) {
      await new Promise((r) => window.setTimeout(r, 200))
    }
  }
}

/** 从导入 JSON 解析工作流定义，并还原服务 / 分类 */
export function parseImportedWorkflowFile(parsed: unknown): {
  workflow: Record<string, unknown>
  department: string
  category: string
} {
  const root = parsed as { workflow?: unknown; format?: string }
  const wf = (root?.workflow ?? parsed) as Record<string, unknown>
  if (!wf || typeof wf !== 'object' || !Array.isArray(wf.nodes)) {
    throw new Error('文件内容不是有效的工作流定义（缺少 nodes）')
  }
  const tax = resolveWorkflowTaxonomy({
    department: typeof wf.department === 'string' ? wf.department : null,
    category: typeof wf.category === 'string' ? wf.category : null,
  })
  return {
    workflow: wf,
    department: tax.department ?? '',
    category: tax.category ?? '',
  }
}
