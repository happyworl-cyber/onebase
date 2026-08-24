'use client'

/**
 * 本地 dev 预览页 —— 执行回放图，零后端依赖，数据来自内置 fixture（见 ./fixtures.ts）。
 * 同 app/dev-graph-preview/page.tsx（依赖图）的先例：不是生产路由，生产页
 * （WorkflowsManager 里的"执行回放"按钮）不依赖这个文件。
 *
 * 支持 `?run=<id>` 透传给 ExecutionReplayView 的 initialRunId prop，方便本地/playwright
 * 免后端验证"从执行记录进来预选某次 run"这个能力。
 */

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import ExecutionReplayView from '@/components/workflow/replay/ExecutionReplayView'
import { MOCK_RUNS, MOCK_RUN_DETAILS, MOCK_WORKFLOW_EDGES, MOCK_WORKFLOW_NODES } from './fixtures'

/** useSearchParams 在 App Router 里必须包一层 Suspense 才能静态导出，见外层 default export。 */
export default function DevReplayPreviewPage() {
  return (
    <Suspense fallback={null}>
      <DevReplayPreviewInner />
    </Suspense>
  )
}

function DevReplayPreviewInner() {
  const searchParams = useSearchParams()
  const runParam = searchParams.get('run')
  const initialRunId = runParam ? Number(runParam) : null

  return (
    <div style={{ height: '100vh', width: '100vw' }}>
      <ExecutionReplayView
        workflowId={1}
        nodes={MOCK_WORKFLOW_NODES}
        edges={MOCK_WORKFLOW_EDGES}
        mockRuns={MOCK_RUNS}
        mockRunDetails={MOCK_RUN_DETAILS}
        initialRunId={Number.isFinite(initialRunId) ? initialRunId : null}
        onClose={() => {}}
      />
    </div>
  )
}
