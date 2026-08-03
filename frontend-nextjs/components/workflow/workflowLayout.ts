import type { Edge, Node, ReactFlowInstance } from 'reactflow'
import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js'

export const WF_NODE_WIDTH = 180
export const WF_NODE_HEIGHT = 88

const elk = new ELK()

const ELK_LAYOUT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.spacing.nodeNode': '56',
  'elk.layered.spacing.nodeNodeBetweenLayers': '72',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.edgeRouting': 'SPLINES',
}

function isConditionNode(node: Node) {
  return node.data?.nodeType === 'condition'
}

function isLoopNode(node: Node) {
  return node.data?.nodeType === 'loop'
}

/** loop 回边（loop_back）：不参与自动布局，避免层次布局被环干扰。 */
function isLoopBackEdge(edge: Edge): boolean {
  return edge.type === 'loopBack' || (edge.data as any)?.edgeType === 'loop_back'
}

const FALSE_LIKE_BRANCHES = ['false', 'invalid', 'no', 'fail', 'failure', 'default', 'else']
const TRUE_LIKE_BRANCHES = ['true', 'valid', 'yes', 'ok', 'success', 'pass']

/**
 * 按分支名给出语义颜色：false/invalid 类为红，true/valid 类为绿，其余自定义分支用中性靛蓝。
 * 供节点出口、连线颜色统一使用，保证画布语义一致。
 */
export function branchColor(branch?: string | null): string {
  if (!branch) return '#94a3b8'
  const b = branch.toLowerCase()
  // loop 节点出口/回边固定语义色：循环体 fuchsia、完成 green、回边 fuchsia。
  if (b === 'body') return '#d946ef'
  if (b === 'done') return '#22c55e'
  if (b === 'back') return '#e879f9'
  if (FALSE_LIKE_BRANCHES.includes(b)) return '#ef4444'
  if (TRUE_LIKE_BRANCHES.includes(b)) return '#22c55e'
  return '#6366f1'
}

/**
 * 由 condition 节点 config 推导它的分支出口列表（顺序即出口从左到右的排列）。
 * - 形态 A：config.conditions[].branch + default_branch（默认分支放最左，语义同 false 出口）。
 * - 形态 B（或新建节点）：回退到 ['false', 'true'] 两个出口。
 */
export function getConditionBranches(config: any): string[] {
  const conds = config?.conditions
  if (Array.isArray(conds) && conds.length > 0) {
    const matched = conds
      .map((c: any) => (c?.branch != null ? String(c.branch) : ''))
      .filter((b: string) => b.length > 0)
    const def = config?.default_branch != null ? String(config.default_branch) : ''
    const ordered = def
      ? [def, ...matched.filter((b: string) => b !== def)]
      : matched
    return ordered.length > 0 ? ordered : ['false', 'true']
  }
  return ['false', 'true']
}

/** 出口在节点底边的水平百分比（0~1），沿底边均匀分布 */
export function branchHandleFraction(index: number, total: number): number {
  return (index + 1) / (total + 1)
}

function targetPortId(nodeId: string, handle?: string | null) {
  return handle ? `${nodeId}__${handle}` : `${nodeId}__in`
}

function sourcePortId(nodeId: string, handle?: string | null) {
  return handle ? `${nodeId}__${handle}` : `${nodeId}__out`
}

function buildElkPorts(node: Node): ElkNode['ports'] {
  const w = WF_NODE_WIDTH
  const h = WF_NODE_HEIGHT
  const portSize = 1

  const target = {
    id: targetPortId(node.id),
    width: portSize,
    height: portSize,
    x: w / 2,
    y: 0,
    properties: { 'port.side': 'NORTH', 'port.borderOffset': '0' },
  }

  if (isConditionNode(node)) {
    const branches = getConditionBranches(node.data?.config)
    return [
      target,
      ...branches.map((branch, i) => ({
        id: sourcePortId(node.id, branch),
        width: portSize,
        height: portSize,
        x: w * branchHandleFraction(i, branches.length),
        y: h,
        properties: { 'port.side': 'SOUTH', 'port.borderOffset': '0' },
      })),
    ]
  }

  if (isLoopNode(node)) {
    // loop：顶部 in + 左侧 back（回边入口），底部 body(左) / done(右) 双出口。
    return [
      target,
      {
        id: targetPortId(node.id, 'back'),
        width: portSize,
        height: portSize,
        x: 0,
        y: h * 0.35,
        properties: { 'port.side': 'WEST', 'port.borderOffset': '0' },
      },
      {
        id: sourcePortId(node.id, 'body'),
        width: portSize,
        height: portSize,
        x: w * 0.35,
        y: h,
        properties: { 'port.side': 'SOUTH', 'port.borderOffset': '0' },
      },
      {
        id: sourcePortId(node.id, 'done'),
        width: portSize,
        height: portSize,
        x: w * 0.65,
        y: h,
        properties: { 'port.side': 'SOUTH', 'port.borderOffset': '0' },
      },
    ]
  }

  return [
    target,
    {
      id: sourcePortId(node.id),
      width: portSize,
      height: portSize,
      x: w / 2,
      y: h,
      properties: { 'port.side': 'SOUTH', 'port.borderOffset': '0' },
    },
  ]
}

function buildElkGraph(nodes: Node[], edges: Edge[]): ElkNode {
  return {
    id: 'workflow-root',
    layoutOptions: ELK_LAYOUT_OPTIONS,
    children: nodes.map((node) => ({
      id: node.id,
      width: WF_NODE_WIDTH,
      height: WF_NODE_HEIGHT,
      ports: buildElkPorts(node),
      properties: {
        'org.eclipse.elk.portConstraints': 'FIXED_ORDER',
      },
    })),
    // loop 回边不参与层次布局（否则会被当成环，破坏自上而下的排布）。
    edges: edges
      .filter((edge) => !isLoopBackEdge(edge))
      .map((edge) => ({
        id: edge.id,
        sources: [sourcePortId(edge.source, edge.sourceHandle)],
        targets: [targetPortId(edge.target, edge.targetHandle)],
      })),
  }
}

function collectNodePositions(
  graph: ElkNode,
  acc = new Map<string, { x: number; y: number }>(),
): Map<string, { x: number; y: number }> {
  for (const child of graph.children ?? []) {
    if (child.id && child.x != null && child.y != null) {
      acc.set(child.id, { x: child.x, y: child.y })
    }
    collectNodePositions(child, acc)
  }
  return acc
}

/** 使用 ELK layered 算法自动排布（行业主流方案，适配 React Flow） */
export async function layoutWorkflow(nodes: Node[], edges: Edge[]): Promise<Node[]> {
  if (nodes.length === 0) return nodes

  const graph = buildElkGraph(nodes, edges)
  const layouted = await elk.layout(graph)
  const positions = collectNodePositions(layouted)

  return nodes.map((node) => ({
    ...node,
    position: positions.get(node.id) ?? node.position ?? { x: 0, y: 0 },
  }))
}

export function nodesOverlap(nodes: Node[], threshold = 40): boolean {
  if (nodes.length < 2) return false
  let overlaps = 0
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = Math.abs(nodes[i].position.x - nodes[j].position.x)
      const dy = Math.abs(nodes[i].position.y - nodes[j].position.y)
      if (dx < threshold && dy < threshold) overlaps++
    }
  }
  return overlaps >= Math.max(1, Math.floor(nodes.length / 3))
}

export function clampDragToCanvas(
  position: { x: number; y: number },
  instance: ReactFlowInstance,
  canvasEl: HTMLElement,
): { x: number; y: number } {
  const { x: vx, y: vy, zoom } = instance.getViewport()
  const cw = canvasEl.clientWidth
  const ch = canvasEl.clientHeight
  const nodeW = WF_NODE_WIDTH * zoom
  const nodeH = WF_NODE_HEIGHT * zoom

  const screenX = position.x * zoom + vx
  const screenY = position.y * zoom + vy

  const clampedX = Math.max(0, Math.min(cw - nodeW, screenX))
  const clampedY = Math.max(0, Math.min(ch - nodeH, screenY))

  return {
    x: (clampedX - vx) / zoom,
    y: (clampedY - vy) / zoom,
  }
}

/** 详情面板打开后，将节点平移进当前画布可见区（不改变缩放） */
export function ensureNodeVisibleInCanvas(
  node: { position: { x: number; y: number } },
  instance: ReactFlowInstance,
  canvasEl: HTMLElement,
  padding = 24,
): void {
  const { x: vx, y: vy, zoom } = instance.getViewport()
  const cw = canvasEl.clientWidth
  const ch = canvasEl.clientHeight
  const nodeW = WF_NODE_WIDTH * zoom
  const nodeH = WF_NODE_HEIGHT * zoom

  const screenX = node.position.x * zoom + vx
  const screenY = node.position.y * zoom + vy
  const screenRight = screenX + nodeW
  const screenBottom = screenY + nodeH

  let newVx = vx
  let newVy = vy

  if (screenRight > cw - padding) {
    newVx -= screenRight - (cw - padding)
  }
  if (screenX < padding) {
    newVx += padding - screenX
  }
  if (screenBottom > ch - padding) {
    newVy -= screenBottom - (ch - padding)
  }
  if (screenY < padding) {
    newVy += padding - screenY
  }

  if (newVx !== vx || newVy !== vy) {
    instance.setViewport({ x: newVx, y: newVy, zoom }, { duration: 220 })
  }
}

export function normalizeSourceHandle(branch?: string | null): string | null {
  if (!branch) return null
  return String(branch)
}

export const FIT_ALL_VIEW = { padding: 40, maxZoom: 1, minZoom: 0.65 } as const
export const FIT_FOCUS_VIEW = { padding: 40, maxZoom: 1, minZoom: 0.78 } as const

/** 全览时超过该行数则改为聚焦顶部，避免缩放过小看不清 */
const FOCUS_LAYER_THRESHOLD = 4
/** 聚焦适配时从入口向下包含的层数（约 4 行节点） */
const FOCUS_MAX_DEPTH = 3
const READABLE_ZOOM = FIT_FOCUS_VIEW.minZoom
const LAYER_Y_THRESHOLD = (WF_NODE_HEIGHT + 52) * 0.55

export type FitWorkflowOptions = {
  padding?: number
  maxZoom?: number
  minZoom?: number
  duration?: number
  nodeIds?: string[]
  /** 工作流自上而下阅读：顶部对齐比垂直居中更清晰 */
  align?: 'top' | 'center'
}

export function countVisualLayers(nodes: Node[]): number {
  if (nodes.length === 0) return 0
  const ys = nodes.map((n) => n.position.y).sort((a, b) => a - b)
  let layers = 1
  let bandY = ys[0]
  for (let i = 1; i < ys.length; i++) {
    if (ys[i] - bandY > LAYER_Y_THRESHOLD) {
      layers++
      bandY = ys[i]
    }
  }
  return layers
}

/** 多行/多节点时优先聚焦顶部，而非把整图缩到难以辨认 */
export function shouldUseFocusFit(nodes: Node[], canvasHeight: number): boolean {
  if (nodes.length <= 6) return false
  if (countVisualLayers(nodes) > FOCUS_LAYER_THRESHOLD) return true
  if (nodes.length > 10) return true
  const span = graphVerticalSpan(nodes)
  const zoomY = (canvasHeight - FIT_FOCUS_VIEW.padding * 2) / Math.max(span, 1)
  return zoomY < READABLE_ZOOM
}

/**
 * 按节点真实宽高（WF_NODE_WIDTH × WF_NODE_HEIGHT）计算包围盒并适配视口，
 * 避免 React Flow 默认 fitView 忽略节点尺寸导致最右侧节点被裁切。
 */
export function fitWorkflowToCanvas(
  nodes: Node[],
  instance: ReactFlowInstance,
  canvasEl: HTMLElement,
  options: FitWorkflowOptions = {},
): void {
  const {
    padding = FIT_ALL_VIEW.padding,
    maxZoom = FIT_ALL_VIEW.maxZoom,
    minZoom = FIT_ALL_VIEW.minZoom,
    duration = 300,
    nodeIds,
    align = 'top',
  } = options

  const list = nodeIds?.length ? nodes.filter((n) => nodeIds.includes(n.id)) : nodes
  if (list.length === 0) return

  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const n of list) {
    x0 = Math.min(x0, n.position.x)
    y0 = Math.min(y0, n.position.y)
    x1 = Math.max(x1, n.position.x + WF_NODE_WIDTH)
    y1 = Math.max(y1, n.position.y + WF_NODE_HEIGHT)
  }

  const graphW = Math.max(x1 - x0, 1)
  const graphH = Math.max(y1 - y0, 1)
  const cw = Math.max(canvasEl.clientWidth, 1)
  const ch = Math.max(canvasEl.clientHeight, 1)

  const zoomX = (cw - padding * 2) / graphW
  const zoomY = (ch - padding * 2) / graphH
  let zoom = Math.min(zoomX, zoomY, maxZoom)
  const isFocusSubset = Boolean(nodeIds?.length && nodeIds.length < nodes.length)
  if (isFocusSubset) {
    // 聚焦模式：保证可读缩放，底部未纳入的节点靠滚动画布查看
    zoom = Math.max(Math.min(zoomX, zoomY, maxZoom), minZoom)
  } else if (zoom >= minZoom) {
    zoom = Math.max(zoom, minZoom)
  }
  zoom = Math.max(zoom, 0.2)

  const centerX = x0 + graphW / 2
  const centerY = y0 + graphH / 2

  const vx = cw / 2 - centerX * zoom
  const vy = align === 'top' ? padding - y0 * zoom : ch / 2 - centerY * zoom
  instance.setViewport({ x: vx, y: vy, zoom }, { duration })
}

export function graphVerticalSpan(nodes: Node[]): number {
  if (nodes.length === 0) return 0
  let y0 = Infinity
  let y1 = -Infinity
  for (const n of nodes) {
    y0 = Math.min(y0, n.position.y)
    y1 = Math.max(y1, n.position.y + WF_NODE_HEIGHT)
  }
  return y1 - y0
}

export function getInitialFocusNodeIds(nodes: Node[], edges: Edge[], maxDepth = 5): string[] {
  if (nodes.length <= 8) return nodes.map((n) => n.id)

  const inCount = new Map<string, number>()
  nodes.forEach((n) => inCount.set(n.id, 0))
  edges.forEach((e) => inCount.set(e.target, (inCount.get(e.target) || 0) + 1))

  const outMap = new Map<string, string[]>()
  nodes.forEach((n) => outMap.set(n.id, []))
  edges.forEach((e) => outMap.get(e.source)!.push(e.target))

  const roots = nodes.filter((n) => (inCount.get(n.id) || 0) === 0).map((n) => n.id)
  const startIds = roots.length > 0 ? roots : [nodes[0].id]

  const result = new Set<string>()
  const queue: { id: string; depth: number }[] = startIds.map((id) => ({ id, depth: 0 }))

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!
    if (result.has(id)) continue
    result.add(id)
    if (depth >= maxDepth) continue
    for (const t of outMap.get(id) || []) {
      if (!result.has(t)) queue.push({ id: t, depth: depth + 1 })
    }
  }
  return Array.from(result)
}

export function needsFocusView(nodes: Node[], canvasHeight: number): boolean {
  return shouldUseFocusFit(nodes, canvasHeight)
}
