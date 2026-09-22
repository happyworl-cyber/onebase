'use client'

/**
 * Local dev preview page -- zero backend dependency, data comes from the built-in fixtures
 * (see ./fixtures.ts). After running `npm run dev` locally, open this in the browser to see
 * the real dependency graph interactions (G6 combo/badges/BFS highlight/navigation).
 * Use this route in place of a real backend integration when the backend doesn't build on
 * Windows or the real endpoint has no local data.
 *
 * Not a production route: the real page `/workspace/[projectId]/automation/workflow-graph`
 * does not depend on this file, and this file is never imported by the production page.
 *
 * Supports `?focus=<slug or id>`, forwarded to WorkflowGraphCanvas's focusId prop, to make it
 * easy to verify locally/via playwright, without a backend, whether the multi-entry focus
 * feature (P1.3 (5)) auto-selects and centers the target node once the data is ready.
 */

import { Suspense, useState } from 'react'
import dynamic from 'next/dynamic'
import { useSearchParams } from 'next/navigation'
import { FULL_FIXTURE, SCOPE_FIXTURE, SCOPE_FIXTURE_SCOPE, LARGE_FIXTURE, XL_FIXTURE, AGG_STRESS_FIXTURE, HUGE_FIXTURE } from './fixtures'

const WorkflowGraphCanvas = dynamic(
  () => import('@/components/workflow/graph/WorkflowGraphCanvas'),
  { ssr: false },
)

/** useSearchParams requires wrapping in Suspense under the App Router for static export to
 * work -- see the outer default export. */
export default function DevGraphPreviewPage() {
  return (
    <Suspense fallback={null}>
      <DevGraphPreviewInner />
    </Suspense>
  )
}

function DevGraphPreviewInner() {
  const [mode, setMode] = useState<'full' | 'scope' | 'large' | 'xl' | 'agg-stress' | 'huge'>('full')
  const searchParams = useSearchParams()
  const focusId = searchParams.get('focus')

  return (
    <div style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          padding: '8px 16px',
          borderBottom: '1px solid #e2e8f0',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          fontFamily: 'sans-serif',
          fontSize: 13,
          flexShrink: 0,
        }}
      >
        <span style={{ color: '#64748b' }}>Local mock preview (no backend):</span>
        <button
          onClick={() => setMode('full')}
          style={{
            padding: '4px 10px',
            borderRadius: 6,
            border: '1px solid #cbd5e1',
            background: mode === 'full' ? '#4f46e5' : '#fff',
            color: mode === 'full' ? '#fff' : '#334155',
            cursor: 'pointer',
          }}
        >
          Full fixture (18 nodes)
        </button>
        <button
          onClick={() => setMode('scope')}
          style={{
            padding: '4px 10px',
            borderRadius: 6,
            border: '1px solid #cbd5e1',
            background: mode === 'scope' ? '#4f46e5' : '#fff',
            color: mode === 'scope' ? '#fff' : '#334155',
            cursor: 'pointer',
          }}
        >
          Category scope fixture (includes external dependency nodes)
        </button>
        <button
          onClick={() => setMode('large')}
          style={{
            padding: '4px 10px',
            borderRadius: 6,
            border: '1px solid #cbd5e1',
            background: mode === 'large' ? '#4f46e5' : '#fff',
            color: mode === 'large' ? '#fff' : '#334155',
            cursor: 'pointer',
          }}
        >
          Large fixture ({LARGE_FIXTURE.nodes.length} nodes)
        </button>
        <button
          onClick={() => setMode('xl')}
          style={{
            padding: '4px 10px',
            borderRadius: 6,
            border: '1px solid #cbd5e1',
            background: mode === 'xl' ? '#4f46e5' : '#fff',
            color: mode === 'xl' ? '#fff' : '#334155',
            cursor: 'pointer',
          }}
        >
          XL fixture ({XL_FIXTURE.nodes.length} nodes, includes long names)
        </button>
        <button
          onClick={() => setMode('agg-stress')}
          style={{
            padding: '4px 10px',
            borderRadius: 6,
            border: '1px solid #cbd5e1',
            background: mode === 'agg-stress' ? '#4f46e5' : '#fff',
            color: mode === 'agg-stress' ? '#fff' : '#334155',
            cursor: 'pointer',
          }}
        >
          Aggregation stress fixture (22 categories, mixed long/short names + dense cross-cluster edges)
        </button>
        <button
          onClick={() => setMode('huge')}
          style={{
            padding: '4px 10px',
            borderRadius: 6,
            border: '1px solid #cbd5e1',
            background: mode === 'huge' ? '#4f46e5' : '#fff',
            color: mode === 'huge' ? '#fff' : '#334155',
            cursor: 'pointer',
          }}
        >
          Performance phase-2 fixture ({HUGE_FIXTURE.nodes.length} nodes, hub + mixed long/short names)
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <WorkflowGraphCanvas
          projectId={1}
          databaseId={1}
          scope={mode === 'scope' ? SCOPE_FIXTURE_SCOPE : null}
          mockData={
            mode === 'scope'
              ? SCOPE_FIXTURE
              : mode === 'large'
                ? LARGE_FIXTURE
                : mode === 'xl'
                  ? XL_FIXTURE
                  : mode === 'agg-stress'
                    ? AGG_STRESS_FIXTURE
                    : mode === 'huge'
                      ? HUGE_FIXTURE
                      : FULL_FIXTURE
          }
          focusId={focusId}
        />
      </div>
    </div>
  )
}
