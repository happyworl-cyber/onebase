'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactFlow, {
  Background,
  MiniMap,
  Connection,
  Edge,
  Node,
  Panel,
  ReactFlowInstance,
  MarkerType,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  useOnViewportChange,
} from 'reactflow'
import { nodeTypes, NODE_TYPE_META } from './NodeTypes'
import NodeConfigPanel from './NodeConfigPanel'
import WorkflowEdge from './WorkflowEdge'
import {
  layoutWorkflow,
  nodesOverlap,
  clampDragToCanvas,
  ensureNodeVisibleInCanvas,
  fitWorkflowToCanvas,
  normalizeSourceHandle,
  branchColor,
  FIT_ALL_VIEW,
  FIT_FOCUS_VIEW,
  getInitialFocusNodeIds,
  needsFocusView,
  shouldUseFocusFit,
  WF_NODE_WIDTH,
  WF_NODE_HEIGHT,
} from './workflowLayout'

export interface WorkflowNodeDef {
  id: string
  type: string
  label?: string
  config: any
}

export interface WorkflowEdgeDef {
  from: string
  to: string
  branch?: string
  /** 特殊边类型；目前仅 'loop_back'（loop 循环回边）。 */
  edge_type?: string
  edgeType?: string
  /** 目标 handle id；loop 回边落在目标 loop 节点的 'back' handle。 */
  target_handle?: string
  targetHandle?: string
}

/** loop 回边固定色（同循环体出口 fuchsia） */
const LOOP_BACK_COLOR = '#d946ef'

/** 判断一条画布边是否为 loop 回边 */
function isFlowLoopBack(e: { data?: any; targetHandle?: string | null }): boolean {
  return (e.data as any)?.edgeType === 'loop_back' || e.targetHandle === 'back'
}

function isReachableByNormalEdges(
  edges: Edge[],
  start: string,
  target: string,
): boolean {
  const seen = new Set<string>()
  const queue = [start]
  while (queue.length > 0) {
    const nodeId = queue.shift()!
    if (nodeId === target) return true
    if (seen.has(nodeId)) continue
    seen.add(nodeId)
    edges.forEach((edge) => {
      if (edge.source === nodeId && !isFlowLoopBack(edge)) {
        queue.push(edge.target)
      }
    })
  }
  return false
}

/** 添加节点面板分组（控制流 / 数据操作 / 集成 / 输出），loop 归控制流并与 condition 并列 */
const NODE_PALETTE_GROUPS: { label: string; types: string[] }[] = [
  { label: '数据操作', types: ['db_query', 'db_execute', 'db_transaction', 'foreach', 'transform', 'code'] },
  { label: '控制流', types: ['condition', 'loop'] },
  { label: '集成', types: ['http_call', 'email_send', 'sse_publish', 'call_workflow', 'redis', 'kafka', 'object_storage'] },
  { label: '输出', types: ['response'] },
]

interface Props {
  initialNodes: WorkflowNodeDef[]
  initialEdges: WorkflowEdgeDef[]
  workflowSlug?: string
  onChange: (nodes: WorkflowNodeDef[], edges: WorkflowEdgeDef[]) => void
}

const edgeTypes = { workflowEdge: WorkflowEdge }
const MINIMAP_PREF_KEY = 'workflow-minimap-visible'
let nodeIdCounter = 0

function generateNodeId(type: string) {
  nodeIdCounter++
  return `${type}_${Date.now().toString(36)}_${nodeIdCounter}`
}

function edgeStyle(branch?: string | null) {
  const color = branchColor(branch)
  return { stroke: color, markerEnd: { type: MarkerType.ArrowClosed, color } }
}

function toFlowNodes(defs: WorkflowNodeDef[]): Node[] {
  return defs.map((n, i) => ({
    id: n.id,
    type: 'workflowNode',
    position: n.config?._position || { x: 80 + (i % 4) * 240, y: 60 + Math.floor(i / 4) * 140 },
    width: WF_NODE_WIDTH,
    height: WF_NODE_HEIGHT,
    data: { ...n, nodeType: n.type },
  }))
}

function toFlowEdges(defs: WorkflowEdgeDef[], nodes: WorkflowNodeDef[]): Edge[] {
  const nodeTypeById = new Map(nodes.map((node) => [node.id, node.type]))
  return defs.map((e, i) => {
    const edgeType = e.edge_type ?? e.edgeType
    const targetHandle = e.target_handle ?? e.targetHandle
    const isLoopBack = edgeType === 'loop_back' || targetHandle === 'back'
    const handle = normalizeSourceHandle(e.branch)
    const { stroke, markerEnd } = isLoopBack
      ? { stroke: LOOP_BACK_COLOR, markerEnd: { type: MarkerType.ArrowClosed, color: LOOP_BACK_COLOR } }
      : edgeStyle(handle)
    return {
      id: `e-${e.from}-${e.to}-${i}`,
      type: 'workflowEdge',
      source: e.from,
      target: e.to,
      sourceHandle: handle,
      targetHandle: isLoopBack ? 'back' : targetHandle || undefined,
      label: isLoopBack ? '↺ 回边' : e.branch || undefined,
      data: {
        ...(isLoopBack ? { edgeType: 'loop_back' } : {}),
        sourceNodeType: nodeTypeById.get(e.from),
      },
      style: { stroke, strokeWidth: 2 },
      markerEnd,
    }
  })
}

function fromFlowNodes(nodes: Node[]): WorkflowNodeDef[] {
  return nodes.map((n) => ({
    id: n.id,
    type: n.data.nodeType,
    label: n.data.label,
    config: { ...n.data.config, _position: n.position },
  }))
}

function fromFlowEdges(edges: Edge[]): WorkflowEdgeDef[] {
  return edges.map((e) => {
    // loop 回边：持久化 edge_type/target_handle，不写 branch（其 label 是展示文案而非分支名）。
    if (isFlowLoopBack(e)) {
      return { from: e.source, to: e.target, edge_type: 'loop_back', target_handle: 'back' }
    }
    return {
      from: e.source,
      to: e.target,
      ...(e.sourceHandle ? { branch: (typeof e.label === 'string' ? e.label : e.sourceHandle) } : {}),
    }
  })
}

function ZoomControls({ onFit }: { onFit: () => void }) {
  const { zoomIn, zoomOut, getZoom } = useReactFlow()
  const [zoom, setZoom] = useState(100)

  const refresh = useCallback(() => setZoom(Math.round(getZoom() * 100)), [getZoom])
  useOnViewportChange({ onEnd: refresh })

  const handleFit = () => {
    onFit()
    setTimeout(refresh, 320)
  }

  return (
    <Panel position="bottom-left" className="!m-3.5">
      <div className="flex flex-col gap-0.5 bg-white border border-slate-200 rounded-[10px] p-1 shadow-sm">
        <button type="button" onClick={() => { zoomIn({ duration: 150 }); setTimeout(refresh, 160) }} className="w-[30px] h-[30px] flex items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 text-[15px]">+</button>
        <div className="text-center text-[10px] font-bold text-slate-400 leading-4">{zoom}%</div>
        <button type="button" onClick={() => { zoomOut({ duration: 150 }); setTimeout(refresh, 160) }} className="w-[30px] h-[30px] flex items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 text-[15px]">−</button>
        <button type="button" onClick={handleFit} className="w-[30px] h-[30px] flex items-center justify-center rounded-md text-indigo-500 hover:bg-indigo-50 text-[11px] font-bold" title="适配视图">⊡</button>
      </div>
    </Panel>
  )
}

function WorkflowCanvasInner({ initialNodes, initialEdges, workflowSlug, onChange }: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState(toFlowNodes(initialNodes))
  const [edges, setEdges, onEdgesChange] = useEdgesState(
    toFlowEdges(initialEdges, initialNodes),
  )
  const [selectedNode, setSelectedNode] = useState<WorkflowNodeDef | null>(null)
  const [showPalette, setShowPalette] = useState(false)
  const paletteBtnRef = useRef<HTMLButtonElement | null>(null)
  const [paletteMaxH, setPaletteMaxH] = useState(420)
  const [showMinimap, setShowMinimap] = useState(true)
  // Cap the "添加节点" menu height to the space between the button and the
  // canvas container's bottom, so it always scrolls internally instead of
  // overflowing past the container's `overflow-hidden` edge (unreachable items).
  useEffect(() => {
    if (!showPalette) return
    const measure = () => {
      const btn = paletteBtnRef.current?.getBoundingClientRect()
      if (!btn) return
      const containerBottom =
        canvasRef.current?.getBoundingClientRect().bottom ?? window.innerHeight
      const bottom = Math.min(containerBottom, window.innerHeight)
      setPaletteMaxH(Math.max(160, Math.floor(bottom - btn.bottom - 16)))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [showPalette])
  const [layouting, setLayouting] = useState(false)
  const reactFlowInstance = useRef<ReactFlowInstance | null>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const didAutoLayout = useRef(false)
  const { setViewport } = useReactFlow()

  // 始终指向最新的 nodes/edges，避免回调闭包在同一批更新里拿到过期值。
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const edgesRef = useRef(edges)
  edgesRef.current = edges

  useEffect(() => {
    try {
      const stored = localStorage.getItem(MINIMAP_PREF_KEY)
      if (stored === '0') setShowMinimap(false)
      else if (stored === '1') setShowMinimap(true)
    } catch { /* ignore */ }
  }, [])

  const setShowMinimapPersisted = useCallback((next: boolean) => {
    setShowMinimap(next)
    try {
      localStorage.setItem(MINIMAP_PREF_KEY, next ? '1' : '0')
    } catch { /* ignore */ }
  }, [])

  const toggleMinimap = useCallback(() => {
    setShowMinimapPersisted(!showMinimap)
  }, [showMinimap, setShowMinimapPersisted])

  const syncChange = useCallback(
    (newNodes: Node[], newEdges: Edge[]) => onChange(fromFlowNodes(newNodes), fromFlowEdges(newEdges)),
    [onChange],
  )

  const fitCanvas = useCallback((focusTop = false) => {
    const el = canvasRef.current
    const inst = reactFlowInstance.current
    if (!inst || !el) return

    const currentNodes = inst.getNodes()
    const currentEdges = inst.getEdges()
    const ch = el.clientHeight
    const useFocus = focusTop || shouldUseFocusFit(currentNodes, ch)

    if (useFocus && currentNodes.length > 0) {
      const ids = getInitialFocusNodeIds(currentNodes, currentEdges, 3)
      fitWorkflowToCanvas(currentNodes, inst, el, {
        ...FIT_FOCUS_VIEW,
        nodeIds: ids,
        align: 'top',
        duration: 300,
      })
    } else {
      fitWorkflowToCanvas(currentNodes, inst, el, {
        ...FIT_ALL_VIEW,
        align: 'top',
        duration: 300,
      })
    }
  }, [])

  const refreshEdges = useCallback(() => {
    setEdges((eds) => eds.map((e) => ({ ...e })))
  }, [setEdges])

  const closePanel = useCallback(() => {
    setSelectedNode(null)
  }, [])

  const applyLayout = useCallback(
    async (nodeList: Node[], edgeList: Edge[], focusTop = false) => {
      const layouted = await layoutWorkflow(nodeList, edgeList)
      setNodes(layouted)
      syncChange(layouted, edgeList)
      setViewport({ x: 0, y: 0, zoom: 1 })
      requestAnimationFrame(() => {
        refreshEdges()
        const inst = reactFlowInstance.current
        const el = canvasRef.current
        if (focusTop) fitCanvas(true)
        else if (inst && el) {
          fitWorkflowToCanvas(layouted, inst, el, { ...FIT_ALL_VIEW, duration: 250 })
        }
      })
      return layouted
    },
    [setNodes, syncChange, setViewport, refreshEdges, fitCanvas],
  )

  const runAutoLayout = useCallback(() => {
    setLayouting(true)
    void applyLayout(nodes, edges)
      .catch((err) => console.error('自动排布失败:', err))
      .finally(() => setTimeout(() => setLayouting(false), 300))
  }, [nodes, edges, applyLayout])

  useEffect(() => {
    if (didAutoLayout.current || nodes.length < 2) return
    if (nodesOverlap(nodes)) {
      didAutoLayout.current = true
      void applyLayout(nodes, edges, true).catch((err) =>
        console.error('初始自动排布失败:', err),
      )
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 详情面板展开后画布变窄，将选中节点平移进可见区域
  useEffect(() => {
    if (!selectedNode) return
    const inst = reactFlowInstance.current
    const el = canvasRef.current
    if (!inst || !el) return

    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const flowNode = inst.getNodes().find((n) => n.id === selectedNode.id)
        if (flowNode) ensureNodeVisibleInCanvas(flowNode, inst, el)
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [selectedNode])

  const onConnect = useCallback((params: Connection) => {
    // 连到 loop 节点的 back handle ⇒ 生成 loop 回边（虚线 fuchsia，携带 edgeType 标记持久化）。
    const isLoopBack = params.targetHandle === 'back'
    const handle = normalizeSourceHandle(params.sourceHandle)
    const sourceNodeType = nodesRef.current.find(
      (node) => node.id === params.source,
    )?.data?.nodeType
    const { stroke, markerEnd } = isLoopBack
      ? { stroke: LOOP_BACK_COLOR, markerEnd: { type: MarkerType.ArrowClosed, color: LOOP_BACK_COLOR } }
      : edgeStyle(handle)
    setEdges((eds) => {
      const newEdges = addEdge({
        ...params,
        sourceHandle: handle,
        targetHandle: isLoopBack ? 'back' : params.targetHandle,
        type: 'workflowEdge',
        data: {
          ...(isLoopBack ? { edgeType: 'loop_back' } : {}),
          sourceNodeType,
        },
        style: { stroke, strokeWidth: 2 },
        markerEnd,
        label: isLoopBack ? '↺ 回边' : params.sourceHandle || undefined,
      }, eds)
      setTimeout(() => syncChange(nodes, newEdges), 0)
      return newEdges
    })
  }, [nodes, setEdges, syncChange])

  // 连线合法性：每个 loop 节点的 back handle 只允许一条回边接入（设计决策⑥：回边必须唯一）。
  const isValidConnection = useCallback((conn: Connection) => {
    const currentNodes = nodesRef.current
    const currentEdges = edgesRef.current
    const sourceNode = currentNodes.find((node) => node.id === conn.source)
    const targetNode = currentNodes.find((node) => node.id === conn.target)

    if (conn.sourceHandle === 'body') {
      if (sourceNode?.data?.nodeType !== 'loop') return false
      if (
        currentEdges.some(
          (edge) => edge.source === conn.source && edge.sourceHandle === 'body',
        )
      ) {
        return false
      }
    }
    if (conn.sourceHandle === 'done') {
      if (sourceNode?.data?.nodeType !== 'loop') return false
      if (
        currentEdges.some(
          (edge) => edge.source === conn.source && edge.sourceHandle === 'done',
        )
      ) {
        return false
      }
    }
    if (conn.targetHandle === 'back') {
      if (targetNode?.data?.nodeType !== 'loop' || conn.source === conn.target) {
        return false
      }
      const already = currentEdges.some(
        (e) => e.target === conn.target && isFlowLoopBack(e),
      )
      if (already) return false
      const bodyEdge = currentEdges.find(
        (edge) =>
          edge.source === conn.target && edge.sourceHandle === 'body',
      )
      if (
        !bodyEdge ||
        !conn.source ||
        !isReachableByNormalEdges(currentEdges, bodyEdge.target, conn.source)
      ) {
        return false
      }
    }
    return true
  }, [])

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    setSelectedNode({ id: node.id, type: node.data.nodeType, label: node.data.label, config: node.data.config })
  }, [])

  const onPaneClick = useCallback(() => {
    if (selectedNode) closePanel()
  }, [selectedNode, closePanel])

  const handleNodeConfigChange = useCallback((updated: WorkflowNodeDef) => {
    setNodes((nds) => {
      const newNodes = nds.map((n) => n.id === updated.id ? { ...n, data: { ...updated, nodeType: updated.type } } : n)
      syncChange(newNodes, edges)
      return newNodes
    })
    setSelectedNode(updated)
  }, [edges, setNodes, syncChange])

  // 条件节点分支改名时，把该节点上引用旧分支名的连线（sourceHandle/label/branch）同步成新名，
  // 避免出口 handle 改名后旧连线 branch 失配（锚点错位 + 后端路由匹配不到分支）。
  const handleBranchRename = useCallback((nodeId: string, oldBranch: string, newBranch: string) => {
    if (oldBranch === newBranch || !newBranch) return
    setEdges((eds) => {
      let changed = false
      const newEdges = eds.map((e) => {
        if (e.source === nodeId && (e.sourceHandle === oldBranch || (typeof e.label === 'string' && e.label === oldBranch))) {
          changed = true
          const { stroke, markerEnd } = edgeStyle(newBranch)
          return { ...e, sourceHandle: newBranch, label: newBranch, style: { stroke, strokeWidth: 2 }, markerEnd }
        }
        return e
      })
      if (!changed) return eds
      setTimeout(() => syncChange(nodesRef.current, newEdges), 0)
      return newEdges
    })
  }, [setEdges, syncChange])

  const handleNodeDelete = useCallback(() => {
    if (!selectedNode) return
    setNodes((nds) => {
      const newNodes = nds.filter((n) => n.id !== selectedNode.id)
      setEdges((eds) => {
        const newEdges = eds.filter((e) => e.source !== selectedNode.id && e.target !== selectedNode.id)
        setTimeout(() => syncChange(newNodes, newEdges), 0)
        return newEdges
      })
      return newNodes
    })
    setSelectedNode(null)
  }, [selectedNode, setNodes, setEdges, syncChange])

  const addNode = useCallback((type: string) => {
    const id = generateNodeId(type)
    const vp = reactFlowInstance.current?.getViewport()
    const cx = vp ? (-vp.x + 400) / vp.zoom : 300
    const cy = vp ? (-vp.y + 200) / vp.zoom : 150 + nodes.length * 40
    const newNode: Node = {
      id, type: 'workflowNode', position: { x: cx, y: cy },
      data: { id, nodeType: type, label: '', config: getDefaultConfig(type) },
    }
    setNodes((nds) => { const nn = [...nds, newNode]; syncChange(nn, edges); return nn })
    setShowPalette(false)
    setSelectedNode({ id, type, label: '', config: getDefaultConfig(type) })
  }, [nodes, edges, setNodes, syncChange])

  const onNodesChangeWrapper = useCallback((changes: Parameters<typeof onNodesChange>[0]) => {
    const inst = reactFlowInstance.current
    const el = canvasRef.current
    const clamped = inst && el
      ? changes.map((ch) => {
          if (ch.type !== 'position' || !ch.position || !ch.dragging) return ch
          return { ...ch, position: clampDragToCanvas(ch.position, inst, el) }
        })
      : changes
    onNodesChange(clamped)
    const hasDragEnd = changes.some((ch) => ch.type === 'position' && ch.dragging === false)
    if (hasDragEnd) {
      setTimeout(() => refreshEdges(), 0)
    }
    setTimeout(() => { setNodes((nds) => { syncChange(nds, edges); return nds }) }, 0)
  }, [onNodesChange, setNodes, edges, syncChange, refreshEdges])

  const onEdgesChangeWrapper = useCallback((changes: Parameters<typeof onEdgesChange>[0]) => {
    onEdgesChange(changes)
    setTimeout(() => { setEdges((eds) => { syncChange(nodes, eds); return eds }) }, 0)
  }, [onEdgesChange, setEdges, nodes, syncChange])

  const defaultEdgeOptions = useMemo(() => ({ type: 'workflowEdge' }), [])

  return (
    <div className="flex h-full workflow-canvas overflow-hidden">
      <div ref={canvasRef} className="flex-1 relative min-w-0 overflow-hidden">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChangeWrapper}
          onEdgesChange={onEdgesChangeWrapper}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          onInit={(instance) => {
            reactFlowInstance.current = instance
            requestAnimationFrame(() => {
              const el = canvasRef.current
              if (!el) return
              const ch = el.clientHeight
              const nodeList = instance.getNodes()
              const edgeList = instance.getEdges()
              if (needsFocusView(nodeList, ch) && nodeList.length > 0) {
                const ids = getInitialFocusNodeIds(nodeList, edgeList, 3)
                fitWorkflowToCanvas(nodeList, instance, el, {
                  ...FIT_FOCUS_VIEW,
                  nodeIds: ids,
                  align: 'top',
                  duration: 0,
                })
              } else {
                fitWorkflowToCanvas(nodeList, instance, el, {
                  ...FIT_ALL_VIEW,
                  align: 'top',
                  duration: 0,
                })
              }
            })
          }}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          minZoom={0.25}
          maxZoom={2}
          snapToGrid
          snapGrid={[16, 16]}
          deleteKeyCode={['Backspace', 'Delete']}
          className="bg-slate-50 workflow-canvas-flow"
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={16} size={1} color="#dde3ed" />
          <ZoomControls onFit={() => fitCanvas(false)} />
          {showMinimap && (
            <>
              <MiniMap
                position="bottom-right"
                className="!m-3.5 !bg-white !border !border-slate-200 !rounded-[10px] !shadow-sm"
                style={{ width: 168, height: 108 }}
                maskColor="rgba(0,0,0,0.08)"
                nodeColor={(node) => NODE_TYPE_META[node.data?.nodeType as string]?.minimapColor || '#818cf8'}
                nodeStrokeWidth={0}
                pannable
                zoomable
              />
              <Panel
                position="bottom-right"
                className="!m-3.5 !w-[168px] !h-[108px] !pointer-events-none !border-0 !bg-transparent !shadow-none !relative"
              >
                <button
                  type="button"
                  aria-label="收起概览图"
                  onClick={(e) => {
                    e.stopPropagation()
                    setShowMinimapPersisted(false)
                  }}
                  className="absolute top-1 right-1 z-10 pointer-events-auto w-5 h-5 flex items-center justify-center rounded-full bg-white border border-slate-200 text-slate-400 hover:text-slate-600 hover:bg-slate-50 text-[11px] leading-none shadow-sm"
                >
                  ×
                </button>
              </Panel>
            </>
          )}
          <Panel position="top-left" className="!m-3.5">
            <div className="flex items-center gap-0.5 bg-white border border-slate-200 rounded-[10px] p-1 shadow-sm">
              <div className="relative">
                <button ref={paletteBtnRef} type="button" onClick={() => setShowPalette(!showPalette)} className="flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium bg-indigo-50 text-indigo-600 hover:bg-indigo-100">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                  添加节点
                </button>
                {showPalette && (
                  <div className="nowheel absolute top-full left-0 mt-1.5 bg-white border border-slate-200 rounded-xl shadow-lg p-1.5 w-[220px] z-50 overflow-y-auto" style={{ maxHeight: paletteMaxH }}>
                    {NODE_PALETTE_GROUPS.map((group) => (
                      <div key={group.label} className="mb-1.5 last:mb-0">
                        <div className="px-2 pt-1 pb-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-300">{group.label}</div>
                        {group.types.filter((t) => NODE_TYPE_META[t]).map((type) => {
                          const meta = NODE_TYPE_META[type]
                          return (
                            <button key={type} type="button" onClick={() => addNode(type)} className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-slate-50 flex items-center gap-2">
                              <span className="text-base">{meta.icon}</span>
                              <span className="text-sm text-slate-700">{meta.label}</span>
                            </button>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="w-px h-5 bg-slate-200 mx-0.5" />
              <button type="button" onClick={runAutoLayout} disabled={layouting || nodes.length === 0} className="flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50">
                <svg className={`w-4 h-4 ${layouting ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" /></svg>
                {layouting ? '排布中…' : '自动排布'}
              </button>
              <button type="button" onClick={() => fitCanvas(false)} className="flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium text-slate-600 hover:bg-slate-100">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg>
                适配视图
              </button>
              <button
                type="button"
                aria-label="概览图"
                aria-pressed={showMinimap}
                onClick={toggleMinimap}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  showMinimap
                    ? 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A2 2 0 013 15.382V6.618a2 2 0 011.553-1.894L9 2m0 18l6-3m-6 3V2m6 15l5.447 2.724A2 2 0 0021 17.382V8.618a2 2 0 00-1.553-1.894L15 4m0 13V4m0 0L9 2" />
                </svg>
                概览
              </button>
            </div>
          </Panel>
        </ReactFlow>
      </div>

      {selectedNode && (
        <NodeConfigPanel
          node={selectedNode}
          workflowSlug={workflowSlug}
          onChange={handleNodeConfigChange}
          onClose={closePanel}
          onDelete={handleNodeDelete}
          onBranchRename={handleBranchRename}
        />
      )}
    </div>
  )
}

export default function WorkflowCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <WorkflowCanvasInner {...props} />
    </ReactFlowProvider>
  )
}

function getDefaultConfig(type: string): Record<string, unknown> {
  switch (type) {
    case 'code': return { code: 'function execute(ctx)\n  ctx.body = { ok = true }\nend' }
    case 'db_query': return { sql: '', params: '' }
    case 'db_execute': return { sql: '', params: '' }
    case 'db_transaction': return { statements: [{ sql: '', params: [] }] }
    case 'foreach': return { items: '', item_var: 'item', statements: [{ sql: '', params: [] }] }
    case 'http_call': return { method: 'GET', url: '', headers: '', body: '' }
    case 'email_send': return { from: '', to: '', cc: '', bcc: '', subject: '', text_body: '', html_body: '', smtp_host: '', smtp_port: 587, smtp_username: '', smtp_password: '', smtp_starttls: true }
    case 'condition': return { expression: '' }
    case 'transform': return { output: '' }
    case 'response': return { status_code: 200, body: '', headers: '' }
    case 'sse_publish': return { topic: 'db:{database_id}:workflow:{workflow_id}', event: 'message', data: '' }
    case 'call_workflow': return { workflow: '', input: '{\n  "key": "{{trigger.value}}"\n}' }
    case 'redis': return { connection_id: 0, op: 'get', key: '' }
    case 'kafka': return { connection_id: 0, op: 'produce', topic: '', key: '', value: '' }
    case 'object_storage': return { connection_id: 0, op: 'get', key: '' }
    case 'loop': return { loop_mode: 'while', expression: '', max_iterations: 100, delay_ms: 0, allow_failure: false }
    default: return {}
  }
}
