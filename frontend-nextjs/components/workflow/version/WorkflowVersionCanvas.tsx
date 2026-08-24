'use client'

import { formatDateTime } from '@/lib/utils'
import WorkflowCanvas from '@/components/workflow/WorkflowCanvas'
import type { WorkflowVersionSnapshot } from './types'

export default function WorkflowVersionCanvas({ snapshot }: { snapshot: WorkflowVersionSnapshot }) {
  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col">
      <div className="px-4 py-3 border-b text-xs text-slate-500 space-y-1 shrink-0">
        <div>
          名称 <span className="text-slate-800">{snapshot.name}</span>
          {' · '}slug <span className="font-mono text-slate-800">{snapshot.slug}</span>
          {' · '}触发 {snapshot.trigger_type}
        </div>
        <div>
          timeout {snapshot.timeout_ms}ms · retries {snapshot.max_retries}
          {snapshot.note ? ` · ${snapshot.note}` : ''}
        </div>
        <div>
          {snapshot.created_by_name && <span>{snapshot.created_by_name} · </span>}
          {snapshot.created_at ? formatDateTime(snapshot.created_at) : ''}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <WorkflowCanvas
          key={snapshot.version}
          readOnly
          initialNodes={snapshot.nodes || []}
          initialEdges={snapshot.edges || []}
          workflowSlug={snapshot.slug}
        />
      </div>
      <details className="shrink-0 border-t px-4 py-2 text-xs text-slate-500">
        <summary className="cursor-pointer hover:text-slate-700">节点 / 连线 / 触发配置 JSON</summary>
        <pre className="mt-2 p-2 bg-slate-50 border rounded font-mono overflow-auto max-h-48">
          {JSON.stringify(
            { nodes: snapshot.nodes, edges: snapshot.edges, trigger_config: snapshot.trigger_config },
            null,
            2,
          )}
        </pre>
      </details>
    </div>
  )
}
