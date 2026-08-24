'use client'

/**
 * 本地 dev 预览页 —— 零后端依赖，数据来自内置 fixture（见 ./fixtures.ts），
 * 供本机 `npm run dev` 后直接在浏览器打开查看依赖图真实交互（G6 combo/角标/BFS高亮/跳转）。
 * 后端在 Windows 编译不过 + 真实 endpoint 本地无数据时，用这个路由代替真实接口联调。
 *
 * 不是生产路由：`/workspace/[projectId]/automation/workflow-graph`（真实页）不依赖这个文件，
 * 该文件也不会被生产页 import。
 *
 * 支持 `?focus=<slug或id>` 透传给 WorkflowGraphCanvas 的 focusId prop，方便本地/playwright
 * 免后端验证多入口 focus（P1.3⑤）能否在数据就绪后自动选中并居中目标节点。
 */

import { Suspense, useState } from 'react'
import dynamic from 'next/dynamic'
import { useSearchParams } from 'next/navigation'
import { FULL_FIXTURE, SCOPE_FIXTURE, SCOPE_FIXTURE_SCOPE, LARGE_FIXTURE, XL_FIXTURE, AGG_STRESS_FIXTURE, HUGE_FIXTURE } from './fixtures'

const WorkflowGraphCanvas = dynamic(
  () => import('@/components/workflow/graph/WorkflowGraphCanvas'),
  { ssr: false },
)

/** useSearchParams 在 App Router 里必须包一层 Suspense 才能静态导出，见外层 default export。 */
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
        <span style={{ color: '#64748b' }}>本地 mock 预览（不接后端）：</span>
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
          全量 fixture（18 节点）
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
          分类 scope fixture（含外部依赖节点）
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
          大规模 fixture（{LARGE_FIXTURE.nodes.length} 节点）
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
          超大规模 fixture（{XL_FIXTURE.nodes.length} 节点，含长名字）
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
          聚合压力 fixture（22 分类，长短名混排+密集跨簇边）
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
          性能二期 fixture（{HUGE_FIXTURE.nodes.length} 节点，hub+长短名混排）
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
