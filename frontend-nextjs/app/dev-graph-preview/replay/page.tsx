'use client'

/**
 * Local dev preview page — execution replay graph, zero backend dependency, data from the
 * built-in fixtures (see ./fixtures.ts). Same precedent as app/dev-graph-preview/page.tsx
 * (dependency graph): not a production route; the production page (the "Execution replay"
 * button in WorkflowsManager) does not depend on this file.
 *
 * Supports `?run=<id>` passed through to ExecutionReplayView's initialRunId prop, making it
 * easy to verify "enter from an execution record and preselect a run" locally / in Playwright
 * without a backend.
 */

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import ExecutionReplayView from '@/components/workflow/replay/ExecutionReplayView'
import { MOCK_RUNS, MOCK_RUN_DETAILS, MOCK_WORKFLOW_EDGES, MOCK_WORKFLOW_NODES } from './fixtures'

/** useSearchParams must be wrapped in a Suspense boundary in the App Router for static export; see the outer default export. */
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
