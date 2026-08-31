'use client'

/**
 * 执行回放图 —— G6 v5 画布（client-only，同依赖图一样必须 dynamic({ ssr:false })）。
 *
 * 与依赖图（WorkflowGraphCanvas，combo-combined + d3-force，画的是"工作流之间"的依赖关系）
 * 是两个不同的图：这里画的是"单个工作流内部"的执行流程，用 dagre 层级布局（DAG，非力导/combo），
 * 底图是工作流自身的 nodes/edges 结构，叠加所选一次运行的 node_results 做路径高亮/分支/热力/报错。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Graph } from '@antv/g6'
import type { WorkflowEdgeDef, WorkflowNodeDef } from '@/components/workflow/WorkflowCanvas'
import { buildReplayGraphData, REPLAY_SPECIAL_META } from './replayGraphData'
import type { ReplayNodeResult } from './replayApi'

/** tooltip 内容用 innerHTML 拼接，节点 label 是用户可编辑文本，转义防 XSS（同依赖图先例）。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

interface Props {
  nodes: WorkflowNodeDef[]
  edges: WorkflowEdgeDef[]
  nodeResults: ReplayNodeResult[]
  selectedNodeId: string | null
  onSelectNode: (nodeId: string | null) => void
}

export default function ReplayGraphCanvas({ nodes, edges, nodeResults, selectedNodeId, onSelectNode }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const graphRef = useRef<Graph | null>(null)
  const [readyGraph, setReadyGraph] = useState<Graph | null>(null)

  const built = useMemo(() => buildReplayGraphData(nodes, edges, nodeResults), [nodes, edges, nodeResults])

  useEffect(() => {
    if (!containerRef.current) return

    const graph = new Graph({
      container: containerRef.current,
      autoFit: 'view',
      padding: 32,
      data: built.graphData,
      node: {
        state: {
          // 换掉 G6 默认 selected 的黑色粗边框：品牌靛紫 halo 光晕 + 适度加粗描边。
          // 注：G6 v5 halo 相关样式走 `halo` 前缀（haloStroke/haloLineWidth/haloOpacity），
          // 不存在 haloStrokeColor 这个属性名——写错会静默不生效，退回默认黑框。
          selected: {
            lineWidth: 3,
            stroke: '#4f46e5',
            halo: true,
            haloStroke: '#818cf8',
            haloLineWidth: 14,
            haloOpacity: 0.35,
          },
        },
      },
      layout: {
        // DAG 执行流布局，非力导/combo：从左到右按拓扑层级排开，读作"触发 → … → 结束"。
        type: 'antv-dagre',
        rankdir: 'LR',
        // 间距按"节点圆 + 下方两行名字标签"的真实占地给：dagre 只认节点尺寸不算标签，
        // nodesep（LR 下是同层纵向间隙）不留够会让下一行节点压住上一行的名字。
        nodesep: 56,
        ranksep: 88,
      } as any,
      behaviors: ['drag-canvas', 'zoom-canvas', 'drag-element'],
      plugins: [
        {
          type: 'tooltip',
          trigger: 'hover',
          enable: (e: any) => e.targetType === 'node',
          getContent: async (_e: any, items: any[]) => {
            const it = items?.[0]
            const d = it?.data ?? {}
            const special = d.nodeType ? REPLAY_SPECIAL_META[d.nodeType as string] : undefined
            const wrap = document.createElement('div')
            wrap.className = 'max-w-xs rounded-lg bg-slate-800/95 px-3 py-2 text-xs text-white shadow-lg'
            wrap.innerHTML = `
              <div class="text-sm font-semibold leading-snug">${escapeHtml(String(d.label ?? it?.id ?? ''))}</div>
              <div class="mt-1 text-slate-300">类型：${escapeHtml(String(d.nodeType ?? '未知'))}${special ? ` · ${escapeHtml(special.label)}` : ''}</div>
              <div class="text-slate-300">状态：${escapeHtml(String(d.status ?? ''))}</div>
              ${d.elapsedMs != null ? `<div class="text-slate-300">耗时：${d.elapsedMs}ms</div>` : ''}
              ${d.branch ? `<div class="text-slate-300">分支：${escapeHtml(String(d.branch))}</div>` : ''}
              ${d.emptyResponse ? `<div class="mt-1 text-amber-300">⚠ 空响应</div>` : ''}
              ${d.error ? `<div class="mt-1 text-rose-300">错误：${escapeHtml(String(d.error))}</div>` : ''}
            `
            return wrap
          },
        },
      ],
    })

    graph.on('node:click', (e: any) => {
      const id = String(e.target.id)
      onSelectNode(id)
    })
    graph.on('canvas:click', () => onSelectNode(null))

    graphRef.current = graph
    let disposed = false
    const ensureIconFont =
      typeof document !== 'undefined' && 'fonts' in document
        ? document.fonts.load('900 12px "Font Awesome 6 Free"').catch(() => undefined)
        : Promise.resolve()
    // React StrictMode（dev）会先挂载一次、立刻清理、再挂载一次——若不在每一步都查 disposed，
    // 第一次挂载的 render()/fitView() 可能在 cleanup 已 destroy() 该实例后才 resolve，继续对
    // 已销毁实例调用库内部方法会抛"Cannot read properties of undefined (reading 'draw')"。
    // 每一步前置 disposed 判断 + 整条链兜底 .catch，生产环境（无 StrictMode 双挂载）不受影响。
    ensureIconFont
      .then(() => {
        if (disposed) return undefined
        return graph.render()
      })
      .then(() => {
        if (disposed) return undefined
        return graph.fitView({ when: 'always' }).catch(() => undefined)
      })
      .then(() => {
        if (!disposed) setReadyGraph(graph)
      })
      .catch(() => undefined)

    return () => {
      disposed = true
      graph.destroy()
      graphRef.current = null
      setReadyGraph((prev) => (prev === graph ? null : prev))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [built])

  // 选中态：只驱动 G6 element state，不重建图；与依赖图同款"绑定就绪实例"判据，避免对着
  // 刚 destroy/new 出来的实例调 setElementState 崩溃。
  useEffect(() => {
    const graph = graphRef.current
    if (!graph || readyGraph !== graph) return
    const states: Record<string, string[]> = {}
    for (const n of built.graphData.nodes ?? []) {
      states[String(n.id)] = selectedNodeId === String(n.id) ? ['selected'] : []
    }
    graph.setElementState(states)
    // 侧栏"空响应节点：N 个"点击聚焦/循环跳转时，选中节点未必在当前视口内，需要把画布摇过去；
    // 直接点节点本身就在视口里，focusElement 只是多余的轻微 pan，不影响体验。
    if (selectedNodeId != null) {
      ;(graph as any).focusElement?.(selectedNodeId, { duration: 300 }).catch(() => undefined)
    }
  }, [selectedNodeId, built, readyGraph])

  return (
    <div data-alt="replay-graph-canvas-area" className="relative h-full w-full">
      <div ref={containerRef} data-alt="replay-g6-canvas-container" className="h-full w-full" />
      {built.graphData.nodes?.length === 0 && (
        <div data-alt="replay-graph-empty" className="absolute inset-0 flex items-center justify-center">
          <div className="flex items-center gap-2 rounded-lg border border-slate-100 bg-white px-4 py-2.5 text-sm text-slate-400 shadow-soft">
            该工作流暂无节点，无法渲染执行图
          </div>
        </div>
      )}
    </div>
  )
}
