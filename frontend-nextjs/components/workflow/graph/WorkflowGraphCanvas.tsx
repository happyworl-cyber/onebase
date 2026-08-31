'use client'

/**
 * 工作流依赖图浏览器 —— G6 v5 画布（client-only）。
 *
 * G6 依赖 window/document，不兼容 SSR；本组件只能通过 next/dynamic({ ssr:false }) 引入
 * （照 WorkflowsManager.tsx 里 WorkflowCanvas 的先例）。Graph 实例的创建/销毁锁在 useEffect 里。
 *
 * 三方案整包改造后新增的核心概念：
 * - viewMode：明细 / 按分类聚合 / 按服务聚合，三个顶层视图 tab（方案一）。
 * - drilldown：仅在聚合视图下点击簇节点后出现，代表"下钻进某个簇看明细"，不改变 viewMode
 *   本身（tab 高亮仍留在原聚合视图上，用面包屑"返回聚合视图"清空它）。
 * - built：统一成 { mode:'aggregate', data } | { mode:'detail', data } 判别联合——聚合视图
 *   数据来自 buildAggregatedGraphData，明细视图（含下钻切片）数据来自 buildGraphData。
 *   下游几乎所有 effect 都先判 built.mode 再决定要不要跑。
 * - clusterMode：仅明细视图生效（方案二）——不分簇/按分类/按服务三档，控制 combo 分组粒度，
 *   'none' 时完全不建 combo、退化成一层纯 d3-force 力导。
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Graph, type NodeBadgeStyleProps } from '@antv/g6'
import {
  fetchDependencyGraph,
  type DependencyGraphNode,
  type DependencyGraphResponse,
  type DependencyGraphScope,
} from './graphApi'
import {
  buildAdjacency,
  buildGraphData,
  buildAggregatedGraphData,
  sliceClusterForDrilldown,
  topRankings,
  bfsLevels,
  nodeLayoutSize,
  nodeVisualSize,
  aggClusterLabelText,
  aggClusterLabelFontSize,
  AGG_LABEL_MAX_WIDTH,
  SPECIAL_FLAG_META,
  SPECIAL_FLAG_FILTER_ORDER,
  DEPT_COMBO_PREFIX,
  COLOR_MODE_META,
  COLOR_MODE_ORDER,
  COMBO_NEUTRALIZED_OVERLAY,
  nodeSwatchForMode,
  errorRateLegendStops,
  errorRateColor,
  governanceMatches,
  findNodeIdByFocus,
  searchNodes,
  type Adjacency,
  type ColorMode,
  type GovernanceFilter,
  type ClusterMode,
  type AggregationLevel,
  type AggregatedClusterMeta,
  type BuiltGraphData,
  type AggregatedGraphData,
  type Rankings,
} from './graphData'

/** 方案一·聚合视图三档：明细（现状）/ 按分类聚合 / 按服务聚合。 */
type ViewMode = 'detail' | 'aggregate-category' | 'aggregate-service'
const VIEW_MODE_META: Record<ViewMode, { label: string; icon: string }> = {
  detail: { label: '明细', icon: 'fa-diagram-project' },
  'aggregate-category': { label: '按分类聚合', icon: 'fa-layer-group' },
  'aggregate-service': { label: '按服务聚合', icon: 'fa-boxes-stacked' },
}
const VIEW_MODE_ORDER: ViewMode[] = ['detail', 'aggregate-category', 'aggregate-service']

/** 方案二·分簇方式三档：不分簇（纯力导）/ 按分类（现状两级 combo）/ 按服务（只留一级 combo）。 */
const CLUSTER_MODE_META: Record<ClusterMode, { label: string; icon: string }> = {
  none: { label: '不分簇', icon: 'fa-braille' },
  category: { label: '按分类', icon: 'fa-folder-tree' },
  service: { label: '按服务', icon: 'fa-building' },
}
const CLUSTER_MODE_ORDER: ClusterMode[] = ['none', 'category', 'service']

/** 聚合视图点击簇节点后的下钻态：viewMode 本身不变（tab 高亮仍留在原聚合 tab），
 *  只是临时切到该簇的明细子图，靠面包屑"返回聚合视图"清空。 */
interface DrilldownState {
  level: AggregationLevel
  department: string
  category?: string
  members: string[]
}

/** 建图用的判别联合：明细/聚合两套数据结构、两套画布配置完全不同，下游 effect 先判 mode。 */
type BuiltUnion =
  | { mode: 'detail'; data: BuiltGraphData }
  | { mode: 'aggregate'; level: AggregationLevel; data: AggregatedGraphData }

/** 盘点治理过滤（P1.2）三档：全部 / 孤儿（无入边） / 无出边。 */
const GOV_FILTER_META: Record<GovernanceFilter, { label: string; icon: string }> = {
  none: { label: '全部', icon: 'fa-list' },
  orphan: { label: '孤儿（无入边）', icon: 'fa-unlink' },
  'no-outgoing': { label: '无出边', icon: 'fa-hand' },
}
const GOV_FILTER_ORDER: GovernanceFilter[] = ['none', 'orphan', 'no-outgoing']

/** 侧栏排行榜三档 key（方案三③）。 */
type RankingKey = keyof Rankings
const RANKING_META: Record<RankingKey, { label: string; icon: string }> = {
  mostDependedOn: { label: '被依赖最多', icon: 'fa-arrow-down-to-bracket' },
  mostDependencies: { label: '依赖别人最多', icon: 'fa-arrow-up-from-bracket' },
  bulkiest: { label: '最臃肿', icon: 'fa-weight-hanging' },
}
const RANKING_ORDER: RankingKey[] = ['mostDependedOn', 'mostDependencies', 'bulkiest']

// 侧栏选中详情·运行状态指标（方案 B）：与配色图例同一套色值/文案，保证"图上配色刻度"和
// "详情面板文字"读起来是同一件事；这四项与当前 colorMode 无关，选中节点后恒定显示。
const DETAIL_STATUS_LABEL: Record<DependencyGraphNode['lastRunStatus'], string> = { success: '成功', failed: '失败', none: '无记录' }
const DETAIL_STATUS_DOT: Record<DependencyGraphNode['lastRunStatus'], string> = { success: '#10b981', failed: '#f43f5e', none: '#94a3b8' }
const DETAIL_ACTIVITY_LABEL: Record<DependencyGraphNode['activity'], string> = {
  active: '活跃（24 小时内跑过）',
  idle: '一般（7 天内跑过）',
  dormant: '沉寂（7 天以上无运行）',
}
const DETAIL_ACTIVITY_DOT: Record<DependencyGraphNode['activity'], string> = { active: '#22c55e', idle: '#f59e0b', dormant: '#94a3b8' }

/** tooltip 内容用 innerHTML 拼接，工作流 name/slug 是用户可编辑的自由文本，转义防 XSS。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// 方案一②修复：聚合视图簇节点真实占地半径 —— 圆本身与"部门·分类·条数"标签实际渲染宽度的
// 较大者。真数据（20+ 分类、跨簇边密）反馈簇节点大面积堆叠重合、标签互相压住甚至被截断成
// "…"，根因是原先力导的 collide/斥力/连线距离全部只按圆的直径算，完全没算标签比圆大得多这件
// 事——一个 count=1 的分类圆只有二十来像素，但"部门·分类·1"文字轻松上百像素宽，碰撞检测形同
// 虚设。用离屏 canvas 量出文字真实渲染像素宽度（而不是按字符数瞎猜，中英文宽度差太多），
// 与圆直径、按 AGG_LABEL_MAX_WIDTH 换行后的高度三者取最大值作为该簇的等效碰撞半径。
let aggMeasureCtx: CanvasRenderingContext2D | null | undefined
function measureTextWidth(text: string, fontSize: number, fontWeight: number): number {
  if (typeof document === 'undefined') return text.length * fontSize * 0.62
  if (aggMeasureCtx === undefined) {
    aggMeasureCtx = document.createElement('canvas').getContext('2d')
  }
  if (!aggMeasureCtx) return text.length * fontSize * 0.62
  aggMeasureCtx.font = `${fontWeight} ${fontSize}px sans-serif`
  return aggMeasureCtx.measureText(text).width
}

/** 聚合簇节点数据的最小形状——层级/画布/图例/tooltip 各处都只需要这几个字段。 */
interface AggClusterDatum {
  level: AggregationLevel
  department: string
  category?: string
  count: number
}

/**
 * 性能二期"渐进呈现"：冷启动（无布局缓存命中）时，与其让 G6 用默认的原点/随机小抖动当力导
 * 初值——首帧会是一坨挤在一起的圆点，靠力导慢慢"炸开"分离，600+ 节点时这个炸开过程本身
 * 观感就很卡——不如先按簇（部门）质心把节点粗略摆成网格骨架，首帧直接就是"按服务分好区"的
 * 样子，力导只需要在骨架基础上做局部精修（组内松散排布、避免重叠），收敛路径更短、观感也
 * 从第一帧起就是"有意义的结构"而不是一坨。纯几何摆位，不掺入方向/权重语义，够快够简单。
 */
function seedGridPositions(nodeIds: string[], groupKeyOf: (id: string) => string): Map<string, { x: number; y: number }> {
  const groups = new Map<string, string[]>()
  for (const id of nodeIds) {
    const key = groupKeyOf(id)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(id)
  }
  const groupKeys = Array.from(groups.keys())
  const groupCols = Math.max(1, Math.ceil(Math.sqrt(groupKeys.length)))
  const CELL = 340
  const MEMBER_STEP = 38
  const positions = new Map<string, { x: number; y: number }>()
  groupKeys.forEach((key, gi) => {
    const gx = (gi % groupCols) * CELL
    const gy = Math.floor(gi / groupCols) * CELL
    const members = groups.get(key)!
    const memberCols = Math.max(1, Math.ceil(Math.sqrt(members.length)))
    members.forEach((id, mi) => {
      positions.set(id, {
        x: gx + (mi % memberCols) * MEMBER_STEP,
        y: gy + Math.floor(mi / memberCols) * MEMBER_STEP,
      })
    })
  })
  return positions
}

function aggClusterFootprintRadius(datum: AggClusterDatum): number {
  const circleSize = nodeVisualSize(datum.count * 3)
  const label = aggClusterLabelText(datum.level, datum.department, datum.category, datum.count)
  const fontSize = aggClusterLabelFontSize(datum.count)
  const rawWidth = measureTextWidth(label, fontSize, 700)
  const wrappedWidth = Math.min(rawWidth, AGG_LABEL_MAX_WIDTH)
  // 超过一行宽度就按两行估高（与 data.style 里 labelMaxLines:2 的实际渲染行为对齐）。
  const lines = rawWidth > AGG_LABEL_MAX_WIDTH ? 2 : 1
  const labelHeight = fontSize * 1.35 * lines
  return Math.max(circleSize, wrappedWidth, labelHeight) / 2
}

interface Props {
  projectId: number
  databaseId: number
  /** 列表页当前选中的 department+category（都有才生效）；缺省 = 全量渲染（不传 scope）。 */
  scope?: DependencyGraphScope | null
  /**
   * 仅供本地 dev 预览页（app/dev-graph-preview）注入内置 fixture、跳过真实网络请求。
   * 生产路径（workflow-graph/page.tsx）不传这个 prop，行为不变——仍然 fetchDependencyGraph。
   */
  mockData?: DependencyGraphResponse | null
  /**
   * 多入口 focus（P1.3⑤）：URL `?focus=<slug或id>` 传入。数据就绪后自动选中该节点
   * （复用既有 BFS 高亮）并居中视口；只在首次数据就绪时应用一次，不随后续状态变化重复触发。
   */
  focusId?: string | null
}

export default function WorkflowGraphCanvas({
  projectId,
  databaseId,
  scope = null,
  mockData = null,
  focusId = null,
}: Props) {
  const router = useRouter()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const graphRef = useRef<Graph | null>(null)
  // P0 修复⑤：把"配色切换 effect"和"拖拽/缩放交互降级"两处互不感知的独立 graph.draw() 调用
  // 收敛到同一把串行化锁——两者共享 G6 内部同一个"读取并清空"变更队列，各自独立调 draw()
  // 会在时序不巧时互相"没收"对方的待画变更（根因见诊断文档卡点⑤）。建图 effect 每次重建
  // 实例时把当前实例专属的 requestDraw 函数挂到这个 ref 上，任何要重绘的地方一律走它。
  const drawRequestRef = useRef<(() => void) | null>(null)
  // 增量高亮 diff：记录上一次真正 setElementState 过的每个节点/边的状态数组，下一轮只把
  // "状态变化的那些元素"传给 setElementState，不再每次都把全部节点/边的状态重新推一遍
  // （setElementState 是逐元素异步处理，全量推送在大图规模下是主要开销来源）。
  const prevAppliedStatesRef = useRef<{ nodes: Map<string, string[]>; edges: Map<string, string[]> }>({
    nodes: new Map(),
    edges: new Map(),
  })
  // 返工B：setElementState 异步、兑现顺序不保证跟发起顺序一致——hover 高频触发时，若旧的一轮
  // 比新的一轮晚 resolve，旧轮的 .then 会用它自己算出的（已过期）nextNodeStates/nextEdgeStates
  // 覆盖新轮刚提交的 prevAppliedStatesRef，导致新轮的变更在下一次 diff 里被误判成"已经应用过"
  // 而漏推。用自增 generation 给每一轮 effect 领号，.then 兑现时只有"领到的号仍是最新"才允许
  // 提交，旧轮兑现时发现自己已过期就放弃提交（不影响画面，因为新轮已经用它自己的 diff 画对了）。
  const highlightGenerationRef = useRef(0)
  // 返工①：拖拽降级恢复时不能拿建图期的静态快照当"原样"——配色切换 effect 会在非 department
  // 模式下把 combo 底色改成 COMBO_NEUTRALIZED_OVERLAY（更淡的中性叠色），这份改动只写进了
  // G6 的实时模型，不会同步回建图 effect 闭包里那份一次性快照。用这个 ref 记录"当前配色模式
  // 下 combo 应该长什么样"，配色 effect 每次运行都会更新它，拖拽降级恢复时改读它而不是
  // 建图期快照，两处才不会互相踩踏（见下方 applyDegradedVisibility 与 colorMode effect）。
  const comboColorOverlayRef = useRef<Map<string, { fillOpacity?: number; strokeOpacity?: number }>>(new Map())

  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [resp, setResp] = useState<DependencyGraphResponse | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // 方案三①：hover 单独一个 id——选中(点击)优先于 hover，两者共用同一套 BFS 高亮渲染
  // （见 closureInfo），hover 只是"选中"的临时预览态，鼠标移开即恢复。
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [hiddenFlags, setHiddenFlags] = useState<Set<string>>(new Set())
  // 特殊节点筛选器（左上角 chip 组，boss 点名新增）：多选并集语义——命中任一选中类别的节点
  // 保持常态，其余淡出；跟右侧图例的 hiddenFlags（隐藏命中节点）方向相反，两者独立并存。
  // 复用 closureInfo 同一套"选中 > hover > 筛选 > 治理过滤"优先级链路，天然吃到已有的
  // highlight/faded 状态机 + 增量 diff/generation 基建，不另起一套 setElementState 通道。
  const [specialFlagFilter, setSpecialFlagFilter] = useState<Set<string>>(new Set())
  // 配色切换器（P1 诉求⑥）：默认服务色=现状，不改变默认视觉。仅明细视图生效。
  const [colorMode, setColorMode] = useState<ColorMode>('department')
  // 方案一：顶层视图 tab。方案二：仅明细视图下生效的分簇方式。
  const [viewMode, setViewMode] = useState<ViewMode>('detail')
  // boss 拍板：默认不分簇——纯力导让节点按依赖自然聚团，也是性能最好的一档；
  // 需要分组视角时再手动切按分类/按服务。
  const [clusterMode, setClusterMode] = useState<ClusterMode>('none')
  // 聚合视图点击簇节点后的下钻子图；viewMode 不因下钻而改变，靠这个字段单独驱动"临时看明细"。
  const [drilldown, setDrilldown] = useState<DrilldownState | null>(null)
  // render() 是异步的（combo-combined 布局要跑完才有元素坐标）；setElementState 在此之前调用
  // 会因元素还没建好而炸（读 undefined.draw）。用递增 token 而非裸 boolean 来判断就绪——数据/
  // 模式变化会销毁重建 graph 实例，若只用 boolean，重建时旧实例的 ready=true 会在同一次
  // effect flush 里被高亮 effect 读到（新实例还没 render 完），对着刚 destroy/new 出来的实例调
  // setElementState 照样炸。每次开始一轮新建图就领一个新 token（renderTokenRef.current），只有
  // 这轮 render 真正完成、且期间没有更新的 token 抢跑时，才把 readyToken 置成这个 token；下游
  // effect 用 `readyToken === renderTokenRef.current` 判断"当前这轮建图是否已完成"。
  const renderTokenRef = useRef(0)
  const [readyToken, setReadyToken] = useState<number | null>(null)
  // 性能治理②布局缓存：key = `${数据版本}::${模式}` → 该次收敛后的节点坐标。切视图/分簇
  // 切回同一份数据的同一种模式时，把缓存坐标作为力导初值 + 调低起始 alpha，几乎不用重新
  // 模拟就能收敛，观感"秒开"。数据源变化（换 scope/刷新）时全部清空，不能拿旧坐标糊弄新数据。
  const layoutCacheRef = useRef<{ dataVersion: number; positions: Map<string, Map<string, { x: number; y: number }>> }>({
    dataVersion: -1,
    positions: new Map(),
  })
  const dataVersionCounterRef = useRef(0)
  // 盘点治理过滤（P1.2）：孤儿 / 无出边，三档互斥；选中具体节点时该过滤让位给 BFS 高亮
  // （两者语义都是"该亮哪些节点"，同时生效会互相打架，选中优先——见下方 closureInfo）。
  const [govFilter, setGovFilter] = useState<GovernanceFilter>('none')
  // 排障逐跳（P1.3）：选中节点后默认仍是"一次性 BFS 全亮"（stepHopMode=false，兼容原有行为）；
  // 打开逐跳模式后 hopDepth 从 0（只亮选中节点）起步，靠"上一跳/下一跳"按钮递增/递减。
  const [stepHopMode, setStepHopMode] = useState(false)
  const [hopDepth, setHopDepth] = useState(0)
  // 多入口 focus 只在数据就绪后自动应用一次，防止后续 re-render/其它状态变化重复触发跳转。
  const focusAppliedRef = useRef(false)
  // 搜索定位（大规模刚需②）：输入框内容 + 候选下拉的高亮下标（键盘上下键移动）。
  const [searchQuery, setSearchQuery] = useState('')
  const [searchHighlight, setSearchHighlight] = useState(0)
  // 侧栏排行榜（方案三③）点击条目后待定位的节点 id——先切回明细全量视图（清视图/下钻态），
  // 等新 graph 实例 render 完成才能真正 focusElement，中间这段用这个字段挂起请求。
  const [pendingLocate, setPendingLocate] = useState<string | null>(null)

  // 拉取依赖图数据：不传 scope → 全量渲染；带 department+category → 主集收窄，
  // 主集外 1 跳依赖以 external:true 节点一并返回（后端已保证边不悬空）。
  // mockData 存在时（仅 dev 预览页会传）直接用它，完全跳过网络请求。
  useEffect(() => {
    if (mockData) {
      setLoading(false)
      setErrorMsg(null)
      setResp(mockData)
      return
    }
    let cancelled = false
    setLoading(true)
    setErrorMsg(null)
    fetchDependencyGraph(databaseId, scope)
      .then((data) => {
        if (!cancelled) setResp(data)
      })
      .catch((err) => {
        if (!cancelled) setErrorMsg(err?.message || '依赖图加载失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [databaseId, scope?.department, scope?.category, mockData])

  // 数据源变化（scope 切换/刷新）时，之前的下钻子图必然指向旧数据，清掉避免用旧 members 切
  // 出个空图或张冠李戴。
  useEffect(() => {
    setDrilldown(null)
  }, [resp])

  const adjacency: Adjacency | null = useMemo(() => {
    if (!resp) return null
    return buildAdjacency(resp.edges)
  }, [resp])

  const nodeById = useMemo(() => {
    const map = new Map<string, DependencyGraphNode>()
    resp?.nodes.forEach((n) => map.set(String(n.id), n))
    return map
  }, [resp])

  // 方案三③排行榜：基于全量 resp 算，跟当前视图/下钻态无关——不管在哪个视图，榜单反映的
  // 都是整个依赖图的真实枢纽/臃肿工作流，不是"当前看到的这一小块"。
  const rankings: Rankings | null = useMemo(() => {
    if (!resp || !adjacency) return null
    return topRankings(resp.nodes, adjacency, 10)
  }, [resp, adjacency])

  // 统一建图数据：聚合 tab 且未下钻 → 聚合图；明细 tab，或聚合 tab 已下钻 → 明细图
  // （下钻时先用 sliceClusterForDrilldown 从全量里切出"该簇 + 1 跳外部依赖"子集）。
  const built: BuiltUnion | null = useMemo(() => {
    if (!resp) return null
    if (viewMode !== 'detail' && !drilldown) {
      const level: AggregationLevel = viewMode === 'aggregate-service' ? 'service' : 'category'
      return { mode: 'aggregate', level, data: buildAggregatedGraphData(resp.nodes, resp.edges, level) }
    }
    const source = drilldown
      ? sliceClusterForDrilldown(resp.nodes, resp.edges, new Set(drilldown.members))
      : { nodes: resp.nodes, edges: resp.edges }
    return { mode: 'detail', data: buildGraphData(source.nodes, source.edges, clusterMode) }
  }, [resp, viewMode, clusterMode, drilldown])

  const isDetail = built?.mode === 'detail'

  // 布局缓存 key 的"数据版本"部分：resp 引用变化（换 scope/刷新/切 mock fixture）才 +1，
  // 同一份数据下来回切视图/分簇沿用同一个版本号，缓存才认得出"是同一份数据"。
  const dataVersion = useMemo(() => {
    dataVersionCounterRef.current += 1
    return dataVersionCounterRef.current
  }, [resp])

  // 布局缓存 key 的"模式"部分：聚合视图按 level 区分；明细视图按分簇方式 + 下钻簇区分
  // （下钻子图的节点集合跟主图不同，坐标不能混用，用簇内成员排序后的 id 表做 key）。
  const modeKey = useMemo(() => {
    if (!built) return ''
    if (built.mode === 'aggregate') return `agg:${built.level}`
    return `detail:${clusterMode}:${drilldown ? `drill:${drilldown.members.slice().sort().join(',')}` : 'full'}`
  }, [built, clusterMode, drilldown])

  // 每次换选中节点，逐跳进度归零——重新从"只亮选中节点自己"开始，不沿用上一个节点的跳数。
  useEffect(() => {
    setHopDepth(0)
  }, [selectedId])

  // 数据重建（scope 切换/刷新/视图切换）会重新创建 graph 实例——选中/hover 态清空，避免
  // 残留指向旧实例已不存在的节点。
  useEffect(() => {
    setSelectedId(null)
    setHoveredId(null)
  }, [built])

  // focusId 变化（含从 null 变成有值）时重新允许自动定位一次。
  useEffect(() => {
    focusAppliedRef.current = false
  }, [focusId])

  const openWorkflow = useCallback(
    (workflowId: string) => {
      router.push(`/workspace/${projectId}/automation/workflows?workflowId=${workflowId}`)
    },
    [projectId, router],
  )

  // 搜索候选：数字→精确 id；文字→slug+name 模糊。搜索框每次改动都重算一次，节点数百级下
  // 一次 filter 开销可忽略，不必额外做防抖。仅明细视图渲染搜索框，见 JSX。
  const searchMatches = useMemo(() => {
    if (!resp) return []
    return searchNodes(resp.nodes, searchQuery)
  }, [resp, searchQuery])

  // 候选变化时高亮下标归零，避免上一次搜索残留的下标越界指到不存在的候选项。
  useEffect(() => {
    setSearchHighlight(0)
  }, [searchMatches])

  // 命中目标节点：选中（复用既有 BFS 高亮）+ focusElement 居中视口。
  const locateNode = useCallback((id: string) => {
    const graph = graphRef.current
    if (!graph) return
    setSelectedId(id)
    graph.focusElement(id, { duration: 500, easing: 'ease-in-out' } as any).catch(() => undefined)
  }, [])

  // 唯一匹配时不必等用户点下拉/回车——直接跳（spec②"单个直接跳"）。多个匹配留给下拉候选
  // 或键盘 Enter 选择当前高亮项。
  useEffect(() => {
    if (isDetail && searchMatches.length === 1) {
      locateNode(String(searchMatches[0].id))
    }
  }, [searchMatches, locateNode, isDetail])

  const handleSearchKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        setSearchQuery('')
        ;(e.target as HTMLInputElement).blur()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSearchHighlight((i) => Math.min(i + 1, Math.max(searchMatches.length - 1, 0)))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSearchHighlight((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter') {
        const target = searchMatches[searchHighlight]
        if (target) locateNode(String(target.id))
      }
    },
    [searchMatches, searchHighlight, locateNode],
  )

  // 侧栏排行榜条目点击（方案三③）：强制切回明细全量视图（退出聚合/下钻），再挂起定位请求，
  // 等新 graph 实例 render 完成后由下方 effect 消费。
  const focusFromRanking = useCallback((id: string) => {
    setViewMode('detail')
    setDrilldown(null)
    setPendingLocate(id)
  }, [])

  // 视图 tab 切换：三个 tab 互斥，切换时一律清掉下钻态（tab 代表"顶层视图"，下钻只是
  // 某个聚合 tab 内的临时子状态，换 tab 就该回到该 tab 的顶层）。
  const switchViewMode = useCallback((mode: ViewMode) => {
    setViewMode(mode)
    setDrilldown(null)
  }, [])

  // 聚合视图点击簇节点 → 下钻进该簇明细子图。
  const drillIntoCluster = useCallback((cluster: AggregatedClusterMeta) => {
    setDrilldown({ level: cluster.level, department: cluster.department, category: cluster.category, members: cluster.members })
  }, [])

  // 建图：数据 / 视图 / 分簇方式变化时销毁重建（P0 现算数据量不大，重建成本可接受）。
  useEffect(() => {
    if (!built || !containerRef.current) return

    const totalNodes = built.data.graphData.nodes?.length ?? 0
    // 规模收敛因子（真环境暴露的问题）：节点越多，斥力/link 距离/combo 间距按 scale 等比收缩，
    // 向心力同步增强，让整图收拢成团而不是散在空画布里；下限 0.4 防止节点数极大时挤到完全重叠。
    const scale = Math.max(0.4, Math.min(1, 32 / Math.max(totalNodes, 1)))
    const centerBoost = 1 + (1 - scale) * 0.8
    const clampStrength = (v: number) => Math.min(1, v)
    const alphaDecayFor = (base: number) => Math.min(0.12, base + (1 - scale) * 0.05)
    const sizeForLayoutItem = (d: any): [number, number] => nodeLayoutSize(d.data?.nodeCount ?? 0)

    let layout: any
    let comboKind: Map<string, 'dept' | 'cat'> | null = null

    if (built.mode === 'aggregate') {
      // 聚合视图：簇节点仅几十个，用不上 combo-combined 三层递归，纯 d3-force 即可且够流畅。
      // 真数据（20+ 分类、跨簇边密）修复：collide 半径、斥力、连线距离全部改成按每个簇节点
      // 的真实占地（圆 + 标签渲染宽度，见 aggClusterFootprintRadius）逐节点/逐端点计算，
      // 不再用与簇数量无关的常量——常量在分类一多、长短名字混杂时必然算少，标签就会互压
      // 甚至圆圈重叠。footprint 是真实像素尺寸，不随 scale 收缩（收缩只会让本就不够的间距
      // 更不够），scale 只用来调中心引力/收敛速度。
      // 按 id 预算好每个簇的占地半径，布局回调里查表——不依赖 d3-force/@antv/layout 内部把
      // 我们的 NodeData.data 包成什么形状传给 accessor（实测该形状不透明且和 combo-combined
      // 的约定不一致，直接读 d.data 会在 nodeStrength/link.distance 里拿到 undefined 而崩），
      // 只信任 d.id / edge.source.id / edge.target.id 这个 d3-force 自己也依赖的稳定字段。
      const footprintById = new Map<string, number>()
      for (const c of Array.from(built.data.clusters.values())) {
        footprintById.set(
          c.id,
          aggClusterFootprintRadius({ level: c.level, department: c.department, category: c.category, count: c.count }),
        )
      }
      const footprintOf = (d: any): number => footprintById.get(String(d?.id)) ?? 24
      // 圆身直径表（不含标签）——dagre 纵向尺寸用它：簇名居中在圆上、不吃纵向空间，
      // 纵向若也按含标签的占地正方形算，总高被放大 2~3 倍，fitView 后 zoom 掉破 0.2
      // 触发"极低缩放藏标签"降级，全图簇名消失（复测踩过的坑）。
      const diameterById = new Map<string, number>()
      for (const n of built.data.graphData.nodes ?? []) {
        const s = (n.style as { size?: number | number[] } | undefined)?.size
        diameterById.set(String(n.id), typeof s === 'number' ? s : Array.isArray(s) ? Math.max(...s) : 48)
      }
      // 聚合视图换分层有向布局（boss 拍板方案A）：聚合图的数据形状是"节点少（10~70）、
      // 边极密（100~800）"的有向依赖流，力导只优化距离不表达方向，真数据下必然毛线球。
      // dagre/Sugiyama 把上游排上、下游排下，方向一眼可读——这才是"依赖图"的经典画法；
      // 环依赖 dagre 内部自带打环（greedy cycle-breaking），不需要预处理。
      // 稠密交叉靠 hover-activate 聚焦弥补（见下方 behaviors/state 配置），不靠布局硬解。
      layout = {
        type: 'antv-dagre',
        rankdir: 'TB',
        // nodeSize 横向喂真实占地（圆 + 标签渲染宽度，见 aggClusterFootprintRadius）防同层
        // 标签互压，纵向只喂圆身直径 + 呼吸间隙（理由见 diameterById 注释）。dagre 的
        // nodesep/ranksep 是"边到边"间隙，占地算准了间隙就不需要放大到夸张值。
        nodeSize: (d: any): [number, number] => [footprintOf(d) * 2, (diameterById.get(String(d?.id)) ?? 48) + 32],
        nodesep: 28,
        ranksep: 90,
      }
    } else if (clusterMode === 'none') {
      // 方案二·不分簇：彻底去掉 combo 层，单层 d3-force 让节点按依赖自然聚团（枢纽居中/
      // 孤儿边缘）——这是性能关键路径，节点数一多，少一层 combo-combined 递归收敛明显更快。
      layout = {
        type: 'd3-force',
        preventOverlap: true,
        collide: { strength: 1, iterations: 5 },
        nodeSize: sizeForLayoutItem,
        nodeSpacing: 28,
        nodeStrength: -70 * scale,
        distanceMax: 320 * scale,
        link: { distance: 44 * scale, strength: 0.25 },
        centerStrength: clampStrength(0.16 * centerBoost),
        alphaDecay: alphaDecayFor(0.05),
        alphaMin: 0.012,
      }
    } else {
      // combo-combined 的 layout(comboId) 回调只拿得到 comboId，拿不到"这是哪一层"——但不同
      // 层需要的间距天差地别（分组层要拉开到 combo 互不相交，叶子层只要给节点呼吸感）。从
      // combos 数据建一张 comboId → kind 的表，回调里查表分流；clusterMode='service' 时
      // combos 只有 dept 一级，且它的子代直接是工作流叶子节点（不是 cat 子 combo），所以要
      // 按"这一层的子代是不是叶子节点"（而不是单纯按 kind 名字）选力导参数。
      comboKind = new Map<string, 'dept' | 'cat'>()
      for (const c of built.data.graphData.combos ?? []) {
        comboKind.set(String(c.id), (c.data?.kind as 'dept' | 'cat') ?? 'cat')
      }
      const isLeafGroup = (comboId: string) => {
        const kind = comboKind!.get(comboId)
        return kind === 'cat' || (kind === 'dept' && clusterMode === 'service')
      }

      layout = {
        type: 'combo-combined',
        comboPadding: (d: any) =>
          (String(d?.id ?? '').startsWith(DEPT_COMBO_PREFIX) ? 24 : 18) * Math.max(0.65, scale),
        comboSpacing: (d: any) =>
          (String(d?.id ?? '').startsWith(DEPT_COMBO_PREFIX) ? 28 : 22) * Math.max(0.65, scale),
        nodeSize: sizeForLayoutItem,
        nodeSpacing: 28,
        layout: (comboId: string | null) => {
          if (!comboId) {
            // 根层：撑开各服务 combo，只负责"服务不交叠"，靠 collide（真实包围盒）说了算。
            return {
              type: 'd3-force',
              preventOverlap: true,
              collide: { strength: 1, iterations: 4 },
              nodeStrength: -480 * scale,
              distanceMax: 1000 * scale,
              link: { distance: 420 * scale, strength: 0.02 },
              centerStrength: clampStrength(0.05 * centerBoost),
              alphaDecay: alphaDecayFor(0.05),
              alphaMin: 0.012,
            }
          }
          if (isLeafGroup(comboId)) {
            // 叶子层：具体工作流节点直接排在这一层——真正"可拖拽、松手回弹"的那一层。
            return {
              type: 'd3-force',
              preventOverlap: true,
              collide: { strength: 1, iterations: 5 },
              nodeStrength: -25 * scale,
              distanceMax: 160 * scale,
              link: { distance: 30 * scale, strength: 0.3 },
              centerStrength: clampStrength(0.4 * centerBoost),
              alphaDecay: alphaDecayFor(0.045),
              alphaMin: 0.012,
            }
          }
          // 分组层（服务 combo 内部排各分类 combo）：斥力调弱、link 缩短、centerStrength 提高，
          // 让分类 combo 更抱团，collide（真实包围盒）决定主要间距。
          return {
            type: 'd3-force',
            preventOverlap: true,
            collide: { strength: 1, iterations: 5 },
            nodeStrength: -20 * scale,
            distanceMax: 220 * scale,
            link: { distance: 20 * scale, strength: 0.3 },
            centerStrength: clampStrength(0.6 * centerBoost),
            alphaDecay: alphaDecayFor(0.05),
            alphaMin: 0.012,
          }
        },
      }
    }

    // Graph 级节点/边样式随视图分两套：明细图需要底部标签+入度光环+极淡边默认态；聚合图
    // 只需居中大字标签，颜色/大小/边样式完全交给 data.style（聚合数据本就自带完整样式）。
    const nodeGraphStyle =
      built.mode === 'aggregate'
        ? { labelPlacement: 'center' as const, opacity: 1 }
        : {
            // 注意：G6 v5 的合并优先级是 data.style < 这里的 Graph 级 style（见 runtime/element.js
            // getElementComputedStyle 注释），Graph 级配置会覆盖 data 里的值，不是兜底。所以
            // fill/stroke/lineWidth 这类要按部门/入度变化的样式绝不能写在这里——只能留给
            // graphData.ts 里逐节点算好的 data.style（含方案三②的入度描边/光环），这里只放
            // "所有节点统一"的样式（标签排版）。
            labelPlacement: 'bottom' as const,
            labelOffsetY: 6,
            labelFontSize: 15,
            labelFontWeight: 500,
            labelFill: '#334155',
            labelBackground: true,
            labelBackgroundFill: 'rgba(255,255,255,0.88)',
            labelBackgroundRadius: 4,
            labelPadding: [1, 6] as [number, number],
            labelWordWrap: true,
            labelMaxLines: 2,
            labelTextOverflow: 'ellipsis',
            // 默认态显式声明 opacity:1——G6 v5 的状态样式是"整棵合并样式里有没有这个 key"，不是
            // "和上一次比谁变了就覆盖谁"，必须显式声明才能在状态清空后正确合并回不透明。
            opacity: 1,
          }

    const edgeGraphStyle =
      built.mode === 'aggregate'
        ? {}
        : {
            // 方案三①：默认态边极淡、无箭头——满屏灰箭头伤眼的根因就是"默认态已经很显眼"。
            // hover/选中节点时才靠 highlight 状态把上下游边点亮+加箭头（见 closureInfo/状态 effect）。
            stroke: '#cbd5e1',
            opacity: 0.22,
            lineWidth: 1,
            endArrow: false,
          }

    // 性能治理②布局缓存：同一份数据（dataVersion 不变）下切回之前用过的模式（modeKey 命中），
    // 把上次收敛后的坐标喂给这次的节点当初值 + 把力导起始 alpha 调低，几乎不用重新模拟就能
    // 稳定，观感"秒开"；数据源变了（dataVersion 变）整份缓存作废，不能拿旧坐标糊弄新数据。
    const cache = layoutCacheRef.current
    if (cache.dataVersion !== dataVersion) {
      cache.positions.clear()
      cache.dataVersion = dataVersion
    }
    const cachedPositions = cache.positions.get(modeKey) ?? null
    // 追加⑥首屏攻坚：CPU Profile 实测首屏 26s 的最大头（40.2%）不是力导物理计算（仅 0.9%），
    // 是 G6 渲染层给每个入场节点/边/combo 挂 Web-Animations 风格 Promise 记账的
    // updateAnimationsPromises/updatePromises 开销——79 个 combo-combined 递归仿真实例的每一次
    // rAF tick 前后都要扫一遍这张越攒越大的动画对象表。
    // 返工：判断条件不能拿"有没有缓存坐标"当"要不要关动画"的代理——两者互不相关。
    // cachedPositions 只管布局初值（省收敛），但 viewMode 切换（聚合↔明细）必然让 built 变成
    // 新引用、触发 new Graph(...) 整图重建（element.draw() 的 createElements() 把全部元素当
    // "新元素"重新创建），这条"热切换回明细"路径即使缓存坐标命中，依然会重建 1500+ 个元素、
    // 挂同一套入场动画，复现冷启动同款瓶颈（实测 CPU Profile 动画记账占比 17.9%，热切换耗时
    // 33~52s 比冷启动还慢）。只要规模超阈值、这一轮 effect 会重建元素，就该关动画，与坐标
    // 来自网格骨架还是缓存坐标无关。
    const disableAnimation = totalNodes > 200
    // 冷启动（没有布局缓存可用）时改用按部门分组的网格骨架当初值，而不是让力导从一坨挤在
    // 一起的默认位置慢慢炸开——见 seedGridPositions 注释。命中缓存时优先用缓存（更接近真实
    // 收敛结果），两者不会同时生效。
    const seedPositions =
      cachedPositions ??
      (() => {
        const deptById = new Map<string, string>()
        for (const n of built.data.graphData.nodes ?? []) {
          deptById.set(String(n.id), String((n.data as any)?.department ?? ''))
        }
        return seedGridPositions(Array.from(deptById.keys()), (id) => deptById.get(id) ?? '')
      })()
    // 深拷贝一份要喂给 G6 的数据——built.data.graphData 是 useMemo 缓存的引用，直接在它的
    // node.style 上打洞塞 x/y 会污染这份共享引用，下次别的地方读到就带着上一轮的坐标残留。
    const graphData = {
      nodes: (built.data.graphData.nodes ?? []).map((n) => {
        const pos = seedPositions.get(String(n.id))
        return pos ? { ...n, style: { ...n.style, x: pos.x, y: pos.y } } : n
      }),
      edges: built.data.graphData.edges,
      combos: built.data.graphData.combos,
    }
    if (cachedPositions) {
      // 从"已经很接近平衡"的位置起步时，把初始 alpha 调低——d3-force 不需要再从 alpha=1
      // 完整跑一轮，几步小幅修正就能重新收敛，这才是"秒开"的真正来源（而不是跳过力导本身，
      // 跳过力导会让 combo-combined 的包围盒算不出来，见下方分支说明）。
      if (layout?.type === 'd3-force') {
        layout = { ...layout, alpha: 0.15 }
      } else if (layout?.type === 'combo-combined') {
        const innerLayout = layout.layout
        layout = { ...layout, layout: (comboId: string | null) => ({ ...innerLayout(comboId), alpha: 0.15 }) }
      }
    } else {
      // 冷启动（无缓存坐标，走 seedGridPositions 网格骨架当初值）：起点已经是"按部门分好区"
      // 的有意义结构，不再是一坨随机点，力导不需要像"从零炸开"那样跑到 alphaMin 逼近 0 才停——
      // 把 alphaDecay 调大（衰减更快）、alphaMin 调高（更早判定"够稳定了"），用更少轮次收敛，
      // 换首屏更快，代价是最终摆位的精修程度略降（骨架本身已经足够合理，可接受）。
      const COLD_START_ALPHA_DECAY_BOOST = 1.6
      const COLD_START_ALPHA_MIN = 0.02
      const loosenForColdStart = (l: any) => ({
        ...l,
        alphaDecay: Math.min(0.2, (l.alphaDecay ?? 0.0228) * COLD_START_ALPHA_DECAY_BOOST),
        alphaMin: Math.max(l.alphaMin ?? 0.001, COLD_START_ALPHA_MIN),
      })
      if (layout?.type === 'd3-force') {
        layout = loosenForColdStart(layout)
      } else if (layout?.type === 'combo-combined') {
        const innerLayout = layout.layout
        layout = { ...layout, layout: (comboId: string | null) => loosenForColdStart(innerLayout(comboId)) }
      }
    }

    // 追加⑥返工A：曾尝试改用节点/边/combo 各自 spec 里的 animation:{ enter:false }，只想掐掉
    // "新建元素"这一阶段、保留 focusElement 视口缓动和 state 过渡——但实测不成立：CPU Profile
    // 显示这种写法下 updatePromises/updateAnimationsPromises 记账占比不降反升到 60.29%（比不
    // 关动画的 17.9% 基线更差），"enter:false" 大概率仍会创建 Animation 对象只是把时长设成 0，
    // 没有绕开 G6 渲染层的 Promise 记账机制。退回 Graph 级 `animation:false`——如实描述：这是
    // 该 Graph 实例的动画总开关，冷启动/热切换重建大图时连同 focusElement 视口缓动、state
    // （highlight/faded）过渡一起关闭，不是只关入场；小图和未超阈值场景不受影响。
    const nodeSpec = {
      style: nodeGraphStyle,
      state:
        built.mode === 'aggregate'
          ? {
              // 聚合视图 hover 聚焦（方案A 的另一半）：hover-activate 行为给"悬停簇+一跳邻居"
              // 打 active、其余打 inactive——被聚焦的簇加粗描边，无关簇/边整体退隐，
              // 稠密跨簇边在聚焦瞬间只剩当前簇的上下游，交叉噪音即刻清零。
              active: { lineWidth: 4 },
              inactive: { opacity: 0.2, labelOpacity: 0.2 },
            }
          : {
              highlight: { stroke: '#f59e0b', lineWidth: 3, halo: true, haloStrokeColor: '#fde68a' },
              faded: { opacity: 0.15 },
              'legend-hidden': { opacity: 0.1 },
            },
    }
    const edgeSpec = {
      style: edgeGraphStyle,
      state:
        built.mode === 'aggregate'
          ? {
              // active 态才是聚合边的"完全体"：实色、不透明——默认态它们只是淡淡的背景。
              active: { stroke: '#475569', opacity: 0.95 },
              inactive: { opacity: 0.05, labelOpacity: 0.05 },
            }
          : {
              highlight: { stroke: '#f59e0b', lineWidth: 2.5, opacity: 1, endArrow: true, endArrowType: 'triangle', endArrowSize: 9 },
              faded: { opacity: 0.05 },
            },
    }
    // combo 配置在无 combo 场景（聚合视图/不分簇）下留给默认值也无妨——数据里压根没有 combo
    // 元素，这份 spec 不会被用到；不必为"有没有 combo"另写一套 undefined 分支。
    // boss 拍板：combo 形状从 rect 改成 G6 内置 circle——服务/分类卡片改成圆形背景，
    // 既有配色/描边/标签位置语义原样保留（circle 与 rect 共用同一套 BaseComboStyleProps，
    // 只是矩形圆角 radius 字段对圆形无意义，已在 graphData.ts 里去掉）。
    const comboSpec = { type: 'circle' as const, style: { labelPlacement: 'top' as const } }

    // 性能治理①③补充说明：Graph 实例本想整个生命周期复用、用 setData/setNode/setLayout
    // 原地切换，跳过销毁重建的开销——已经实现过一版，但实测在 XL(300+)规模下会触发一个
    // G6 内部竞态：即使 await graph.render() 完成后才发起下一轮 setData，上一轮 d3-force/
    // combo-combined 仿真仍会在某些情况下继续投递 onTick（哪怕 render() 的 Promise 已按
    // 文档语义 resolve），这些迟到的 tick 会对着刚被换掉的新数据集找旧节点/combo id，
    // G6 内部直接抛"Node not found"并刷屏崩溃——已用串行 Promise 链 + token 双重防护过，
    // 仍能稳定复现，判断是 G6 v5 combo-combined 递归多实例仿真与 render() Promise 解析
    // 时机不完全对齐的内部问题，不是我们这层能安全兜住的，为避免把一个"更快但偶发崩溃"的
    // 方案带上线，退回销毁重建（与原实现一致，最稳）。真正生效的性能治理保留三项：
    // ①配色切换零重排（下面 colorMode 的独立 effect 本就不依赖这个 effect，天然零重排，
    // 不需要实例复用）；②布局缓存（上面已经把收敛坐标当初值喂给新实例 + 调低起始 alpha，
    // 不需要复用实例也能"秒开"）；③去掉 shadowBlur（见 graphData.ts）。
    const graph = new Graph({
      container: containerRef.current,
      autoFit: 'view',
      padding: 24,
      data: graphData,
      node: nodeSpec as any,
      edge: edgeSpec as any,
      combo: comboSpec as any,
      layout,
      // 实测 enter:false（节点/边/combo 各自 spec 级）挡不住动画 Promise 记账（见上方
      // nodeSpec 处的返工A说明），退回 Graph 级总开关——如实描述：totalNodes>200 时关闭该
      // Graph 实例的全部动画（含 focusElement 视口缓动、highlight/faded 状态过渡），不止入场。
      animation: !disableAnimation,
      // 聚合视图追加 hover-activate：悬停簇 + 一跳邻居（含连边）进 active、其余 inactive，
      // 状态样式见上方 nodeSpec/edgeSpec。明细视图不用它——那边有自己的 BFS 闭包高亮
      // （closureInfo，支持选中优先/多跳/治理过滤），两套状态机不能叠着跑。
      behaviors:
        built.mode === 'aggregate'
          ? ([
              'drag-canvas',
              'zoom-canvas',
              'drag-element',
              { type: 'hover-activate', degree: 1, state: 'active', inactiveState: 'inactive' },
            ] as any)
          : ['drag-canvas', 'zoom-canvas', 'drag-element'],
      // hover tooltip（①刚需兜底）：标签再怎么放大，长工作流名在真实体量下仍会被
      // labelMaxWidth 截断成省略号——tooltip 显示完整 name + slug + id，保证不管标签
      // 截没截断，鼠标悬停总能看全是哪条流。聚合视图下 tooltip 改显示簇的部门/分类/条数。
      plugins: [
        {
          type: 'tooltip',
          trigger: 'hover',
          enable: (e: any) => e.targetType === 'node',
          getContent: async (_e: any, items: any[]) => {
            const it = items?.[0]
            const d = it?.data ?? {}
            const wrap = document.createElement('div')
            wrap.className = 'max-w-xs rounded-lg bg-slate-800/95 px-3 py-2 text-xs text-white shadow-lg'
            if (d.kind === 'cluster') {
              const label = d.level === 'service' ? d.department : `${d.department} / ${d.category}`
              wrap.innerHTML = `
                <div class="text-sm font-semibold leading-snug">${escapeHtml(label)}</div>
                <div class="mt-1 text-slate-300">工作流条数：${d.count ?? 0}</div>
                <div class="mt-1 text-slate-400">点击下钻查看明细</div>
              `
              return wrap
            }
            const external = d.external
              ? '<span class="ml-1.5 rounded bg-slate-500 px-1 py-0.5 text-[10px] font-medium text-white">外部依赖</span>'
              : ''
            wrap.innerHTML = `
              <div class="text-sm font-semibold leading-snug">${escapeHtml(d.name || d.slug || '')}${external}</div>
              <div class="mt-1 text-slate-300">slug: ${escapeHtml(d.slug || '')}</div>
              <div class="text-slate-300">id: ${escapeHtml(String(it?.id ?? ''))}</div>
              <div class="mt-1 text-slate-400">${escapeHtml(d.department || '共享')} / ${escapeHtml(d.category || '未分类')} · 节点数 ${d.nodeCount ?? 0}${
                typeof d.inDegree === 'number' && d.inDegree > 0 ? ` · 被依赖 ${d.inDegree} 次` : ''
              }</div>
            `
            return wrap
          },
        },
      ],
    })

    // 返工④：提前声明（而非留到 render 完成后才声明），好让下方 requestDraw 能在自己内部
    // 判断"这个 Graph 实例是否已经被 cleanup 销毁"，不对着已销毁实例发起 draw()/排队重试。
    let disposed = false

    // 性能二期③ hover 节流用的定时器句柄声明在 if/else 外层，方便下面 cleanup 统一清理
    // （aggregate 模式下始终为 null，无副作用）。
    let hoverThrottleTimer: ReturnType<typeof setTimeout> | null = null

    if (built.mode === 'aggregate') {
      const clusters = built.data.clusters
      graph.on('node:click', (e: any) => {
        const cluster = clusters.get(String(e.target.id))
        if (cluster) drillIntoCluster(cluster)
      })
    } else {
      graph.on('node:click', (e: any) => {
        const id = String(e.target.id)
        setSelectedId((prev) => (prev === id ? null : id))
      })
      graph.on('node:dblclick', (e: any) => {
        openWorkflow(String(e.target.id))
      })
      // 方案三①：hover 复用选中态同一套 BFS 高亮渲染（见 closureInfo），选中优先——已经
      // 点选了某个节点时，划过别的节点不应该抢走高亮，鼠标移开也不清空真正的选中。
      // 性能二期③/三期 P1：hover 节流 ~40ms——鼠标快速扫过一片密集节点时，原逻辑每个
      // pointerenter 都触发一次 setHoveredId→BFS 重算→setElementState，600+ 节点下这个链路的
      // 重复触发是真实卡顿源；节流成"停顿后才真正响应"，快速划过时中间态全部合并成一次。
      // 三期把阈值从 80ms 降到 40ms（配合下方高亮应用改增量 diff 后单次响应成本已下降，
      // 可以收紧节流换取更跟手的观感，仍保留节流本身以合并密集扫过时的中间态）。
      let pendingHoverId: string | null = null
      const scheduleHover = (id: string | null) => {
        pendingHoverId = id
        if (hoverThrottleTimer) return
        hoverThrottleTimer = setTimeout(() => {
          hoverThrottleTimer = null
          setHoveredId(pendingHoverId)
        }, 40)
      }
      graph.on('node:pointerenter', (e: any) => scheduleHover(String(e.target.id)))
      graph.on('node:pointerleave', () => scheduleHover(null))
      graph.on('canvas:click', () => setSelectedId(null))
    }

    // 力导要"活"：拖拽只是临时挪位，松手后让力导布局用当前局面（含刚拖动到的新位置）
    // 重新收敛。真数据规模性能兜底：节点数超阈值时只挪动被拖节点本身，不重跑全图布局——
    // 用"拖拽顺滑"换"色块/簇形滞后一点"。
    const dragRelayoutThreshold = 150
    graph.on('node:dragend', (e: any) => {
      const draggedId = String(e.target.id)
      if (totalNodes > dragRelayoutThreshold) {
        // 返工·必须：大图不重跑全图布局，但被拖节点自己的世界坐标确实变了——只刷新它一个
        // 的包围盒缓存，否则视口裁剪永远拿它拖动前的旧坐标做相交判断，可能把明明已经在
        // 视口内的节点误判成视口外静默隐藏。
        // 小修①：节点动了，连到它的边（端点跟着位移）和它所属的祖先 combo 链（子节点位置
        // 变化会牵动 combo 包围盒）也一并过期，只刷节点自己会让这些关联元素被误裁。
        const connectedEdgeIds = (graphData.edges ?? [])
          .filter((edge) => String(edge.source) === draggedId || String(edge.target) === draggedId)
          .map((edge) => String(edge.id))
        const comboById = new Map((graphData.combos ?? []).map((c) => [String(c.id), c]))
        const nodeRecord = (graphData.nodes ?? []).find((n) => String(n.id) === draggedId)
        const ancestorComboIds: string[] = []
        let ancestorId = nodeRecord?.combo != null ? String(nodeRecord.combo) : undefined
        while (ancestorId) {
          ancestorComboIds.push(ancestorId)
          const parent = comboById.get(ancestorId)?.combo
          ancestorId = parent != null ? String(parent) : undefined
        }
        refreshElementBounds([draggedId, ...connectedEdgeIds, ...ancestorComboIds])
        return
      }
      graph
        .layout()
        .then(() => {
          // 小图会重新跑一次全图布局，所有元素坐标都可能变，整份包围盒缓存一并刷新。
          refreshElementBounds(allElementIds())
        })
        .catch(() => undefined)
    })

    // 方案三④性能兜底 + 性能二期②交互降级，合并成一套可视性状态机：
    // - 缩放层级低于阈值：只画圆点、隐藏节点文字标签（原有逻辑，长期生效）。
    // - 平移/缩放进行中（不管当前缩放级别）：额外把边整体隐藏，只留节点圆点——拖拽/滚轮
    //   期间边的绘制是主要成本之一，尤其明细图边数可达上千条；停手 ~150ms 判定"真的停了"
    //   才恢复标签+边的完整显示。两套条件独立判断、各自只在状态真正翻转时才 updateNodeData/
    //   updateEdgeData，避免每次 transform 事件都全量重算。
    let appliedHideLabels = false
    // 小修②：veryLowZoom 独立于 interacting 跟踪已应用状态——hideLabels = interacting ||
    // veryLowZoom，若交互全程 interacting 恒为 true（比如边缩边看），跨过 0.2 缩放边界时
    // hideLabels 本身两边都算 true、不会触发下方"值变了才更新"的判断，枢纽节点的
    // 显/隐就卡在跨界前的旧状态，直到 interacting 真正翻转才会被动更新。把 veryLowZoom
    // 也纳入早退守卫的比较项，跨界当场重新计算 labelText。
    let appliedVeryLowZoom = false
    let appliedHideEdges = false
    let appliedSimplifyShapes = false
    // combo 名称字号的"上次已应用"缓存——按 combo id 记录，跳过没有明显变化（<0.5px）的
    // 重复 updateComboData，避免连续滚轮缩放时每一帧都推一次全量 combo 更新。
    const appliedComboLabelFontSizes = new Map<string, number>()
    let interacting = false
    let interactionTimer: ReturnType<typeof setTimeout> | null = null
    // P0 修复⑤：draw() 请求串行化队列——任意时刻只允许一次 graph.draw() 在飞行，期间发生
    // 的其它 draw 请求合并成"飞行中的这次结束后再补画一次"，不丢更新。这是本组件内唯一允许
    // 调用 graph.draw() 的入口，配色切换 effect（下方 colorMode 相关 effect）也通过
    // drawRequestRef 复用同一把锁——两者本质是同一个共享、无锁变更队列的消费者，各自独立调
    // draw() 才是根因（诊断文档卡点⑤），必须收敛到一处。
    let drawInFlight = false
    let drawPending = false
    // 视口裁剪（拖拽帧率预研路线①）：setElementVisibility 文档标注异步，内部实现是
    // model.updateData(...) 入队 + 自己调一次 element.draw() 冲刷共享的"读取并清空"变更队列——
    // 跟我们自己直接调的 graph.draw() 是同一个无锁共享队列的两个独立消费者，各自调用会复现
    // ⑤号 bug 家族的竞态（配色/降级 draw() 互相"没收"对方变更）。不新开一把锁，而是把
    // setElementVisibility 并入 requestDraw 这唯一的串行化队列：待应用的可见性变更暂存在
    // pendingVisibilityChanges，轮到执行时如果有待应用的可见性变更，就用 setElementVisibility
    // （它内部的 draw 会一并冲刷此刻队列里的其它数据变更，等价于顺带做了一次全量 draw）代替
    // 单纯的 graph.draw()，否则退化成普通 draw()。
    let pendingVisibilityChanges: Record<string, 'visible' | 'hidden'> | null = null
    const requestDraw = () => {
      if (disposed) return
      if (drawInFlight) {
        drawPending = true
        return
      }
      drawInFlight = true
      const visibilityChanges = pendingVisibilityChanges
      pendingVisibilityChanges = null
      // 返工④：graph.draw() 文档标注异步，但实例已销毁等异常情况下不能保证它总是走 rejected
      // promise 这条路——也可能同步抛错。同步抛错会跳过 .catch/.finally，drawInFlight 永远
      // 卡在 true，队列从此死锁（后续所有 requestDraw 调用都被"忙"挡住，再也画不出去）。
      // 包一层 try/catch，同步异常也走同一套"释放锁 + 若有排队请求就重试"的收尾。
      try {
        // 评论项 b：setElementVisibility 默认带淡入淡出动画，小图平移时视口外元素少、
        // 裁剪切换频繁，淡入淡出反而显得画面在"闪烁"——传 animation:false 关掉，视口裁剪
        // 本该是瞬时的显隐切换，不是视觉效果。
        const op = visibilityChanges ? graph.setElementVisibility(visibilityChanges, false) : graph.draw()
        op
          .catch(() => undefined)
          .finally(() => {
            drawInFlight = false
            if ((drawPending || pendingVisibilityChanges) && !disposed) {
              drawPending = false
              requestDraw()
            }
          })
      } catch {
        // 返工C：同步抛错这条分支之前只释放了锁，没处理"抛错这一刻是否已经有排队请求"——
        // drawPending 不清、也不补画，等于把那次排队请求静默丢弃（画面停在抛错前的旧状态）。
        // 补齐成与 .finally() 成功路径同一套收尾：有排队请求且实例未销毁就清掉标记、立刻
        // 重新调度一次，不丢更新。
        drawInFlight = false
        if ((drawPending || pendingVisibilityChanges) && !disposed) {
          drawPending = false
          requestDraw()
        }
      }
    }
    drawRequestRef.current = requestDraw
    const requestVisibilityUpdate = (changes: Record<string, 'visible' | 'hidden'>) => {
      pendingVisibilityChanges = { ...(pendingVisibilityChanges ?? {}), ...changes }
      requestDraw()
    }
    const originalLabels = new Map<string, string>()
    for (const n of graphData.nodes ?? []) {
      originalLabels.set(String(n.id), String((n.style as any)?.labelText ?? ''))
    }
    // 拖拽帧率预研路线③：交互中不再无差别隐藏全部标签，改成"视口内 + 高入度枢纽节点"两类保留
    // （视口外节点本身已经被下方视口裁剪整体隐藏，标签自然一起消失，不需要额外判断）。枢纽集合
    // 直接复用已经在算的 topRankings 被依赖最多榜单（rankings 来自组件级 useMemo 闭包捕获），
    // 不新起一套"高入度"判定口径。
    const hubIds = new Set((rankings?.mostDependedOn ?? []).map((entry) => entry.id))
    // 边的"原始"不透明度：明细图边不在 data.style 里声明 opacity（由 Graph 级 edgeGraphStyle
    // 统一给 0.22，见上方"方案三①"注释），聚合图每条边的 opacity 按调用数各不相同、已经算好
    // 写在 data.style 里——交互结束恢复时必须精确恢复到这个值，不能笼统设回同一个数。
    const originalEdgeOpacity = new Map<string, number>()
    for (const e of graphData.edges ?? []) {
      const dataOpacity = (e.style as any)?.opacity
      originalEdgeOpacity.set(String(e.id), typeof dataOpacity === 'number' ? dataOpacity : built.mode === 'aggregate' ? 1 : 0.22)
    }
    // P0 修复②：拖拽/缩放交互降级原先只降标签+边，节点圆本身（角标 badge、按入度加粗的描边）
    // 和 combo 背景卡片（圆角、透明度分层）仍在每帧参与全量重绘，742 节点规模下这部分开销
    // 本身已吃满帧预算。拖拽/缩放进行中额外把这些"装饰性"细节降级成纯色简化圆/直角平色块，
    // 松手后原样恢复——记录每个节点/combo 的原始装饰字段，供恢复时精确复原。
    const originalNodeExtras = new Map<string, { badge?: boolean; badges?: NodeBadgeStyleProps[]; lineWidth?: number }>()
    for (const n of graphData.nodes ?? []) {
      const style = n.style as any
      originalNodeExtras.set(String(n.id), { badge: style?.badge, badges: style?.badges, lineWidth: style?.lineWidth })
    }
    const originalComboExtras = new Map<string, { radius?: number; fillOpacity?: number; strokeOpacity?: number; lineWidth?: number }>()
    for (const c of graphData.combos ?? []) {
      const style = c.style as any
      originalComboExtras.set(String(c.id), {
        radius: style?.radius,
        fillOpacity: style?.fillOpacity,
        strokeOpacity: style?.strokeOpacity,
        lineWidth: style?.lineWidth,
      })
    }
    // boss 反馈：combo 名称（服务/分类）是全景缩小时用户主要的阅读对象，不能像节点名那样
    // 随 zoom 一起糊掉——记下每个 combo 的基准字号 + 层级（服务/分类），供下面按 zoom 反向
    // 补偿字号用（见 comboLabelFontFor）。
    const originalComboLabelFontSize = new Map<string, number>()
    for (const c of graphData.combos ?? []) {
      const style = c.style as any
      originalComboLabelFontSize.set(String(c.id), typeof style?.labelFontSize === 'number' ? style.labelFontSize : 13)
    }
    // 聚合视图：簇名之于聚合图 == combo 名之于明细图，是全景缩小时的主要阅读对象——
    // 同样记基准字号，供 applyDegradedVisibility 里按 zoom 反向补偿（明细节点名不补偿，
    // 那边数量上百、密度高，补偿只会互相压字，两边待遇不同是有意为之）。
    const originalAggNodeLabelFontSize = new Map<string, number>()
    if (built.mode === 'aggregate') {
      for (const n of graphData.nodes ?? []) {
        const style = n.style as any
        originalAggNodeLabelFontSize.set(String(n.id), typeof style?.labelFontSize === 'number' ? style.labelFontSize : 14)
      }
    }
    const appliedAggNodeLabelFontSizes = new Map<string, number>()
    // 返工①：新实例意味着 combo 底色回到建图期快照（department 配色，配色 effect 若非
    // department 模式会在自己的 effect 里紧接着覆盖一次）——先把这份快照同步进
    // comboColorOverlayRef，避免它还留着上一个 Graph 实例的旧 fillOpacity/strokeOpacity。
    comboColorOverlayRef.current = new Map(
      Array.from(originalComboExtras.entries()).map(([id, extra]) => [
        id,
        { fillOpacity: extra.fillOpacity, strokeOpacity: extra.strokeOpacity },
      ]),
    )
    // 拖拽帧率预研路线①：视口裁剪——拖拽/缩放时只有视口内元素需要渲染，视口外整批设
    // visibility:'hidden'。世界坐标包围盒（AABB）在收敛完成后缓存一次（见下方 settle 回调），
    // 节点/combo 收敛后坐标不再变（大图拖拽单节点不触发全图重排，见 dragRelayoutThreshold），
    // 之后每次 aftertransform 只需重算当前视口矩形 + 做 O(N) 的矩形相交判断，不必重新查询
    // 每个元素的几何信息。combo 用"包围盒与视口相交"（而非"完全在视口内"）判定，天然覆盖
    // "有一个子节点可见即部分可见"这条规则——combo 的渲染包围盒本就是其子节点的并集。
    let elementBoundsCache: Map<string, { minX: number; minY: number; maxX: number; maxY: number }> | null = null
    let culledIds = new Set<string>()
    // 返工·必须：AABB 缓存失效路径——拖单个节点/折叠展开 combo 都会让部分元素的世界坐标
    // 过期，若不刷新，被拖过的节点会永远用旧坐标做裁剪判断，可能在明明已经在视口内时被误
    // 判视口外、静默隐藏。原地更新 elementBoundsCache（同一个 Map 实例，调用方不用管失效
    // 时机），单个元素查询失败（比如折叠后子代已不存在）跳过即可，不影响其余元素。
    const refreshElementBounds = (ids: string[]) => {
      if (!elementBoundsCache) return
      for (const id of ids) {
        try {
          const b = graph.getElementRenderBounds(id)
          elementBoundsCache.set(id, { minX: b.min[0], minY: b.min[1], maxX: b.max[0], maxY: b.max[1] })
        } catch {
          // 元素可能因折叠/被移除等原因暂不存在，跳过即可。
        }
      }
      // 每次刷新都顺带更新整图包围盒——调用频率低（拖拽松手/折叠展开这类离散事件，不是
      // 每帧），O(N) 扫一遍 Map 的成本可忽略，换来 churn 三板斧③"全景跳过裁剪"判断始终准确，
      // 不用在每个调用点都记得手动同步。
      recomputeWholeGraphBounds()
    }
    const allElementIds = () => [
      ...(graphData.nodes ?? []).map((n) => String(n.id)),
      ...(graphData.edges ?? []).map((e) => String(e.id)),
      ...(graphData.combos ?? []).map((c) => String(c.id)),
    ]
    // churn 三板斧①：滞回（hysteresis）边距——原先隐藏/恢复共用同一圈 padding，元素刚好卡在
    // 边界附近时，拖拽/缩放的每一次细微抖动都可能来回反转它的可见性，白白触发一堆
    // setElementVisibility。隐藏判定用更宽的外扩（元素得明显离开视口才藏），恢复判定用更窄的
    // 外扩（元素得真正回到视口附近才现），两圈之间留一段"死区"——已经隐藏/已经可见的元素
    // 落在死区内维持原状不翻转，从根上消除边界抖动导致的反复翻转。
    const CULL_HIDE_PADDING = 400
    const CULL_SHOW_PADDING = 150
    // churn 三板斧③：整张图的世界坐标包围盒——收敛/整份刷新时更新，全景缩到整张图都落在
    // （隐藏判定的）视口范围内时，裁剪对这一帧必然是空操作，直接跳过下面的 O(N) 判断。
    let wholeGraphBounds: { minX: number; minY: number; maxX: number; maxY: number } | null = null
    const recomputeWholeGraphBounds = () => {
      if (!elementBoundsCache || elementBoundsCache.size === 0) {
        wholeGraphBounds = null
        return
      }
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      elementBoundsCache.forEach((b) => {
        if (b.minX < minX) minX = b.minX
        if (b.minY < minY) minY = b.minY
        if (b.maxX > maxX) maxX = b.maxX
        if (b.maxY > maxY) maxY = b.maxY
      })
      wholeGraphBounds = { minX, minY, maxX, maxY }
    }
    const applyViewportCullingNow = () => {
      if (!elementBoundsCache || elementBoundsCache.size === 0) return
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect || rect.width <= 0 || rect.height <= 0) return
      let p0: [number, number]
      let p1: [number, number]
      try {
        p0 = graph.getCanvasByViewport([0, 0]) as [number, number]
        p1 = graph.getCanvasByViewport([rect.width, rect.height]) as [number, number]
      } catch {
        return
      }
      const rawMinX = Math.min(p0[0], p1[0])
      const rawMaxX = Math.max(p0[0], p1[0])
      const rawMinY = Math.min(p0[1], p1[1])
      const rawMaxY = Math.max(p0[1], p1[1])

      // churn 三板斧③：整张图都在（宽松的隐藏判定范围）视口内，这一帧不可能有任何元素需要
      // 隐藏——若之前有残留的隐藏态（比如刚从中等缩放缩到全景），批量恢复后直接返回，不跑
      // 下面逐元素的相交判断。
      if (
        wholeGraphBounds &&
        wholeGraphBounds.minX >= rawMinX - CULL_HIDE_PADDING &&
        wholeGraphBounds.maxX <= rawMaxX + CULL_HIDE_PADDING &&
        wholeGraphBounds.minY >= rawMinY - CULL_HIDE_PADDING &&
        wholeGraphBounds.maxY <= rawMaxY + CULL_HIDE_PADDING
      ) {
        if (culledIds.size > 0) {
          const restoreChanges: Record<string, 'visible'> = {}
          culledIds.forEach((id) => { restoreChanges[id] = 'visible' })
          culledIds = new Set()
          requestVisibilityUpdate(restoreChanges)
        }
        return
      }

      const hideMinX = rawMinX - CULL_HIDE_PADDING
      const hideMaxX = rawMaxX + CULL_HIDE_PADDING
      const hideMinY = rawMinY - CULL_HIDE_PADDING
      const hideMaxY = rawMaxY + CULL_HIDE_PADDING
      const showMinX = rawMinX - CULL_SHOW_PADDING
      const showMaxX = rawMaxX + CULL_SHOW_PADDING
      const showMinY = rawMinY - CULL_SHOW_PADDING
      const showMaxY = rawMaxY + CULL_SHOW_PADDING

      const nextCulled = new Set<string>()
      const changes: Record<string, 'visible' | 'hidden'> = {}
      elementBoundsCache.forEach((b, id) => {
        if (culledIds.has(id)) {
          // 已隐藏：只有真正回到（窄边距）视口附近才恢复，否则留在死区里维持隐藏。
          const backInView = b.minX <= showMaxX && b.maxX >= showMinX && b.minY <= showMaxY && b.maxY >= showMinY
          if (backInView) {
            changes[id] = 'visible'
          } else {
            nextCulled.add(id)
          }
        } else {
          // 已可见：只有明显离开（宽边距）视口才隐藏，否则留在死区里维持可见。
          const stillNear = b.minX <= hideMaxX && b.maxX >= hideMinX && b.minY <= hideMaxY && b.maxY >= hideMinY
          if (!stillNear) {
            nextCulled.add(id)
            changes[id] = 'hidden'
          }
        }
      })
      culledIds = nextCulled
      if (Object.keys(changes).length > 0) requestVisibilityUpdate(changes)
    }
    // churn 三板斧②：翻转合帧——拖拽/缩放期间同一个宏任务/短时间窗口里可能连续触发多次
    // aftertransform（比如高频 wheel 事件），每次都各自跑一遍 O(N) 判断没必要，用 rAF 把
    // 一帧内的多次请求合并成一次、用这一帧最新的视口状态判断一次即可。
    let cullingFrameScheduled = false
    const applyViewportCulling = () => {
      if (cullingFrameScheduled) return
      cullingFrameScheduled = true
      requestAnimationFrame(() => {
        cullingFrameScheduled = false
        applyViewportCullingNow()
      })
    }
    const applyDegradedVisibility = () => {
      // 'aftertransform' 在 G6 内部 ViewportController 构造期间（render 之前）也会触发
      // 一次，此时 graph 运行时尚未就绪，getZoom() 会因为内部状态未初始化而抛错——用
      // try/catch 兜底，此时直接跳过即可，真正需要生效的场景（用户缩放/平移）此时运行时早已就绪。
      let zoom = 1
      try {
        zoom = graph.getZoom()
      } catch {
        return
      }
      // boss 反馈：combo（服务/分类）名称是全景缩小时用户主要的阅读对象，不能跟节点名一样
      // 随 zoom 一起糊掉。labelFontSize 是世界坐标单位，画布按 zoom 缩放后屏幕上的实际渲染
      // 大小 ≈ fontSize * zoom——要保证它不低于一个"人眼可读"的像素下限，就得让
      // fontSize >= MIN_SCREEN_PX / zoom，zoom 越小这个世界坐标字号本身就该越大。boss 拍板：
      // combo 圆身分离只按圆身几何算，标签完全不参与碰撞判定（极端缩放下标签互相搭边可
      // 接受）——字号补偿不再需要为"别把圆撑大"设收紧上限，恢复宽松的 safetyCap，只防
      // zoom 趋近 0 时数值失控。用 Math.max(基准字号, 下限) 保证 zoom>=1 时字号维持基准值
      // 不被压小，这段独立于下方 hideLabels 等早退判断，每次 aftertransform 都要按最新
      // zoom 重算。
      if (originalComboLabelFontSize.size > 0) {
        const safetyCap = 600
        const comboFontUpdates: { id: string; style: { labelFontSize: number } }[] = []
        for (const [id, baseFontSize] of Array.from(originalComboLabelFontSize.entries())) {
          const isDept = id.startsWith(DEPT_COMBO_PREFIX)
          const minScreenPx = isDept ? 15 : 11
          const effective = Math.min(safetyCap, Math.max(baseFontSize, minScreenPx / zoom))
          const prev = appliedComboLabelFontSizes.get(id)
          if (prev === undefined || Math.abs(prev - effective) >= 0.5) {
            appliedComboLabelFontSizes.set(id, effective)
            comboFontUpdates.push({ id, style: { labelFontSize: effective } })
          }
        }
        if (comboFontUpdates.length > 0) graph.updateComboData(comboFontUpdates)
      }
      // 聚合视图簇名的 zoom 反向补偿（同上 combo 名待遇）：下限 10 屏幕像素保可读，上限
      // 2.2 倍基准字号防标签胀出圆身太多（簇圆就几十像素，无限放大会互相压字）。
      if (originalAggNodeLabelFontSize.size > 0) {
        const aggFontUpdates: { id: string; style: { labelFontSize: number } }[] = []
        for (const [id, baseFontSize] of Array.from(originalAggNodeLabelFontSize.entries())) {
          const effective = Math.min(baseFontSize * 2.2, Math.max(baseFontSize, 10 / zoom))
          const prev = appliedAggNodeLabelFontSizes.get(id)
          if (prev === undefined || Math.abs(prev - effective) >= 0.5) {
            appliedAggNodeLabelFontSizes.set(id, effective)
            aggFontUpdates.push({ id, style: { labelFontSize: effective } })
          }
        }
        if (aggFontUpdates.length > 0) graph.updateNodeData(aggFontUpdates)
      }
      // 返工建议②：全景（zoom<0.2）下 742 个亚像素灰糊标签照画是纯浪费，且正是全景拖拽 FPS
      // 抬不起来的一个来源——恢复一个极低的缩放阈值，专门覆盖"缩到看不清任何文字"这一档，
      // 跟"名字常显"本意不冲突（0.2 以上、包括静止态默认视距，仍然常显）。
      const veryLowZoom = zoom < 0.2
      // 拖拽帧率预研路线③：去掉原先较高的"缩放低于阈值全局隐藏"这层——静止时名字常显（密集
      // 靠 labelMaxLines/省略号截断，不整体消失）；交互中不再无差别隐藏全部标签，只隐藏"视口内
      // 但非枢纽"的节点标签，枢纽节点（hubIds）和视口外节点（已被裁剪整体隐藏）不受这层影响；
      // veryLowZoom 时无论是否在交互中，连枢纽节点的字也一起藏——那个缩放级别下枢纽标签跟
      // 其它标签一样是不可辨认的亚像素糊字，没有保留的意义。
      // 聚合视图豁免标签隐藏：簇就几十个，交互降级/极低缩放藏字都没必要——簇名是这个
      // 视图唯一的文字信息，藏了等于白屏（配合上方 dagre 纵向压缩后 zoom 一般也到不了 0.2）。
      const hideLabels = built.mode !== 'aggregate' && (interacting || veryLowZoom)
      const hideEdges = interacting
      const simplifyShapes = interacting
      if (
        hideLabels === appliedHideLabels &&
        veryLowZoom === appliedVeryLowZoom &&
        hideEdges === appliedHideEdges &&
        simplifyShapes === appliedSimplifyShapes
      )
        return
      if (hideLabels !== appliedHideLabels || veryLowZoom !== appliedVeryLowZoom) {
        appliedHideLabels = hideLabels
        appliedVeryLowZoom = veryLowZoom
        graph.updateNodeData(
          Array.from(originalLabels.entries()).map(([id, text]) => ({
            id,
            style: { labelText: hideLabels && (veryLowZoom || !hubIds.has(id)) ? '' : text },
          })),
        )
      }
      if (hideEdges !== appliedHideEdges) {
        appliedHideEdges = hideEdges
        graph.updateEdgeData(
          Array.from(originalEdgeOpacity.entries()).map(([id, opacity]) => ({ id, style: { opacity: hideEdges ? 0 : opacity } })),
        )
      }
      if (simplifyShapes !== appliedSimplifyShapes) {
        appliedSimplifyShapes = simplifyShapes
        graph.updateNodeData(
          Array.from(originalNodeExtras.entries()).map(([id, extra]) => ({
            id,
            style: simplifyShapes
              ? { badge: false, badges: [], lineWidth: 1 }
              : { badge: extra.badge, badges: extra.badges, lineWidth: extra.lineWidth },
          })),
        )
        if (originalComboExtras.size > 0) {
          graph.updateComboData(
            Array.from(originalComboExtras.entries()).map(([id, extra]) => {
              // 返工⑤：拖拽中不再强推 fillOpacity:1——那比原样更不透明，闪烁明显；radius:0
              // 去圆角已经拿到了大部分简化收益，填充不透明度维持现状不动即可。
              // 返工①：松手恢复时，fillOpacity/strokeOpacity 必须读"当前配色模式下应有的值"
              // （comboColorOverlayRef，配色 effect 实时维护），不能读建图期的 department 快照——
              // 否则在非 department 配色下平移一次画布，combo 底色会被错误地打回浓服务色。
              const colorOverlay = comboColorOverlayRef.current.get(id)
              return {
                id,
                style: simplifyShapes
                  ? { radius: 0, lineWidth: 1 }
                  : {
                      radius: extra.radius,
                      fillOpacity: colorOverlay?.fillOpacity ?? extra.fillOpacity,
                      strokeOpacity: colorOverlay?.strokeOpacity ?? extra.strokeOpacity,
                      lineWidth: extra.lineWidth,
                    },
              }
            }),
          )
        }
      }
      requestDraw()
    }
    graph.on('aftertransform', () => {
      interacting = true
      // 视口裁剪必须每次 transform 都重算（视口本身在移动），不能像 applyDegradedVisibility
      // 那样"状态没变就早退"——拖拽/缩放全程视口一直在变，即使 interacting 这个布尔值本身
      // 没变化，也需要持续更新哪些元素落在视口内。
      applyViewportCulling()
      applyDegradedVisibility()
      if (interactionTimer) clearTimeout(interactionTimer)
      interactionTimer = setTimeout(() => {
        interacting = false
        applyViewportCulling()
        applyDegradedVisibility()
      }, 150)
    })

    graphRef.current = graph
    // 新实例意味着旧实例上已应用过的高亮状态全部作废（新 Graph 从默认态起步），清空增量 diff
    // 的"上一次已应用状态"记录，防止下一轮高亮 effect 误判"状态没变"而漏推。同步领一个新
    // generation——闭合返工B留下的窗口：旧 Graph 实例身上一次迟到 resolve 的 setElementState，
    // 若不推进 generation，其 .then 里读到的 highlightGenerationRef.current 仍可能等于它自己
    // 领到的旧号（新实例这边还没人跑过高亮 effect 领新号），就会把已经过期的状态写进新实例的
    // prevAppliedStatesRef，污染下一轮 diff。
    prevAppliedStatesRef.current = { nodes: new Map(), edges: new Map() }
    ++highlightGenerationRef.current
    const myToken = ++renderTokenRef.current
    // 特殊节点角标改画 Font Awesome 字形后，canvas 2D 的 fillText 不会像 DOM 那样等
    // webfont 加载完才画——首帧如果字体还没就绪，会拿系统兜底字体的 tofu/无关字符顶上
    // 那个私有区码点，角标就变成乱码方块。先用 document.fonts.load 显式把该字重的 FA
    // 字体拉到位（若已缓存会立即 resolve，不影响首屏速度），再 render，从源头避免这场
    // 竞态，而不是事后再补画一次。
    // boss 拍板：combo 圆形分离——碰撞几何只按 combo 圆身（子内容包围盒对角线/2）算，
    // 标签完全排除在外，极端缩放下标签互相搭边可接受。全程只读写数据层（graphData 原始
    // 数据 + graph.getElementPosition 同步查询），不碰 getElementRenderBounds——那个 API
    // 既会把标签也算进包围盒，又在这次排查里撞见过读取值与实际渲染不同步的问题；数据层
    // 的位置读写是同步、立即一致的，不受这层耦合影响。分离量在内存里算完，最后用
    // updateNodeData 批量落一次绝对坐标（不用 translateElementBy——它内部自带一次
    // draw()，会绕开本文件统一的 requestDraw 串行化队列），再统一走 requestDraw 一次性
    // 落画布。
    const resolveComboOverlaps = async () => {
      const combos = graphData.combos ?? []
      if (combos.length < 2) return
      // comboId -> 直接子节点 id 列表 / 直接子 combo id 列表，用于递归收集某个 combo 下
      // 全部叶子工作流节点（服务 combo 下可能隔着分类 combo 才到节点）。
      const comboDirectNodes = new Map<string, string[]>()
      for (const n of graphData.nodes ?? []) {
        if (!n.combo) continue
        const comboId = String(n.combo)
        if (!comboDirectNodes.has(comboId)) comboDirectNodes.set(comboId, [])
        comboDirectNodes.get(comboId)!.push(String(n.id))
      }
      const comboDirectSubCombos = new Map<string, string[]>()
      const groups = new Map<string, string[]>()
      for (const c of combos) {
        const cid = String(c.id)
        const parentId = (c as { combo?: string }).combo
        const groupKey = parentId ? String(parentId) : '__root__'
        if (!groups.has(groupKey)) groups.set(groupKey, [])
        groups.get(groupKey)!.push(cid)
        if (parentId) {
          const pid = String(parentId)
          if (!comboDirectSubCombos.has(pid)) comboDirectSubCombos.set(pid, [])
          comboDirectSubCombos.get(pid)!.push(cid)
        }
      }
      const leafNodesOf = (comboId: string): string[] => {
        const out: string[] = []
        const stack = [comboId]
        while (stack.length > 0) {
          const cur = stack.pop()!
          for (const n of comboDirectNodes.get(cur) ?? []) out.push(n)
          for (const sub of comboDirectSubCombos.get(cur) ?? []) stack.push(sub)
        }
        return out
      }
      // 一次性把全部节点当前坐标读进内存，后续分离迭代纯在内存里算，不重复调用
      // getElementPosition（742/306 节点量级，一次性读取代价可忽略）。
      const nodePos = new Map<string, [number, number]>()
      for (const n of graphData.nodes ?? []) {
        const p = graph.getElementPosition(String(n.id))
        if (p) nodePos.set(String(n.id), [p[0], p[1]])
      }
      // 返工（boss 截图坐实还在叠）：旧版 circleOf 只拿叶子节点"中心点"bbox 的对角线/2 当
      // 半径，漏了三块真实渲染尺寸——① 节点自身的圆（直径 18~上限）；② combo 的 padding；
      // ③ 服务圆包的是分类"圆"，圆会超出分类叶子 bbox 的四角。三层低估叠加，·2/·3 的小
      // 分类半径能少估几十像素，MARGIN 兜不住，圆照样互相压。改成按渲染层同款几何递归算：
      // 叶子节点按"中心 ± 半径（外加描边/标签下摆的固定余量）"的方盒计入，子 combo 按
      // "圆的外接方盒"计入，最后对角线/2 + 与布局层一致的 comboPadding。仍是纯数据层，
      // combo 标题标签依旧不参与（既定拍板）。
      const nodeHalf = new Map<string, number>()
      for (const n of graphData.nodes ?? []) {
        const s = (n.style as { size?: number | number[] } | undefined)?.size
        const half = typeof s === 'number' ? s / 2 : Array.isArray(s) ? Math.max(...s) / 2 : 12
        // +10 近似描边加粗与节点名标签的下摆，不精确追渲染 bbox（那要回到 getElementRenderBounds 的老坑）
        nodeHalf.set(String(n.id), half + 10)
      }
      // MARGIN 是纯呼吸余量——真实几何已算进半径，不再需要旧版那种"替低估兜底"的大值。
      const MARGIN = 24
      const circleOf = (comboId: string): { cx: number; cy: number; r: number } | null => {
        let minX = Infinity
        let maxX = -Infinity
        let minY = Infinity
        let maxY = -Infinity
        const extend = (x0: number, y0: number, x1: number, y1: number) => {
          if (x0 < minX) minX = x0
          if (x1 > maxX) maxX = x1
          if (y0 < minY) minY = y0
          if (y1 > maxY) maxY = y1
        }
        for (const id of comboDirectNodes.get(comboId) ?? []) {
          const p = nodePos.get(id)
          if (!p) continue
          const h = nodeHalf.get(id) ?? 20
          extend(p[0] - h, p[1] - h, p[0] + h, p[1] + h)
        }
        for (const sub of comboDirectSubCombos.get(comboId) ?? []) {
          const c = circleOf(sub)
          if (!c) continue
          extend(c.cx - c.r, c.cy - c.r, c.cx + c.r, c.cy + c.r)
        }
        if (!Number.isFinite(minX)) return null
        const w = maxX - minX
        const h = maxY - minY
        const padding = (comboId.startsWith(DEPT_COMBO_PREFIX) ? 24 : 18) * Math.max(0.65, scale)
        return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, r: Math.sqrt(w * w + h * h) / 2 + padding }
      }
      const applyDeltaToDescendants = (comboId: string, dx: number, dy: number) => {
        for (const id of leafNodesOf(comboId)) {
          const p = nodePos.get(id)
          if (!p) continue
          nodePos.set(id, [p[0] + dx, p[1] + dy])
        }
      }
      // Gauss-Seidel 式松弛：每一对算完立刻把新坐标写回内存态，同一轮里排在后面的对
      // 已经看到前面对刚做完的修正，比"整批用同一份旧坐标算完再一起应用"收敛快、也更稳。
      const resolveGroup = (ids: string[]) => {
        if (ids.length < 2) return
        const circles = ids
          .map((id) => {
            const c = circleOf(id)
            return c ? { id, ...c } : null
          })
          .filter((c): c is { id: string; cx: number; cy: number; r: number } => c !== null)
        for (let iter = 0; iter < 100; iter++) {
          let moved = false
          for (let i = 0; i < circles.length; i++) {
            for (let j = i + 1; j < circles.length; j++) {
              const a = circles[i]
              const b = circles[j]
              const dx = b.cx - a.cx
              const dy = b.cy - a.cy
              const dist = Math.hypot(dx, dy) || 0.001
              const minDist = a.r + b.r + MARGIN
              if (dist < minDist) {
                moved = true
                const push = (minDist - dist) / 2
                const ux = dx / dist
                const uy = dy / dist
                a.cx -= ux * push
                a.cy -= uy * push
                applyDeltaToDescendants(a.id, -ux * push, -uy * push)
                b.cx += ux * push
                b.cy += uy * push
                applyDeltaToDescendants(b.id, ux * push, uy * push)
              }
            }
          }
          if (!moved) break
        }
      }
      // 分类层先修正（各服务下的分类组互不相交，谁先谁后不影响彼此）——这样根层算服务圆
      // 的内容包围盒时，看到的已经是分类层修正后的最终叶子节点分布，不需要再补一轮根层
      // 修正（此前 getElementRenderBounds 版本因为"分类层撑大服务圆包围盒"踩过这个坑，
      // 数据层直接从叶子节点算包围盒不存在这个问题，但顺序仍然按父子层级来，逻辑更直白）。
      for (const [parentId, ids] of Array.from(groups.entries())) {
        if (parentId === '__root__') continue
        resolveGroup(ids)
      }
      resolveGroup(groups.get('__root__') ?? [])
      // 内存态里的 nodePos 已经是全部层级位移叠加后的最终坐标——直接跟这一刻的真实坐标
      // 比较算 diff，比"给每个 combo 算净位移再逐层转换"更不容易出错。
      const nodeUpdates: { id: string; style: { x: number; y: number } }[] = []
      for (const n of graphData.nodes ?? []) {
        const id = String(n.id)
        const target = nodePos.get(id)
        const orig = graph.getElementPosition(id)
        if (!target || !orig) continue
        if (Math.abs(target[0] - orig[0]) >= 0.5 || Math.abs(target[1] - orig[1]) >= 0.5) {
          nodeUpdates.push({ id, style: { x: target[0], y: target[1] } })
        }
      }
      if (nodeUpdates.length > 0) {
        graph.updateNodeData(nodeUpdates)
        // 根因（boss 复测坐实）：这里原先调 requestDraw()（异步、不等待）之后，调用方
        // 紧接着同步跑 refreshElementBounds(allElementIds())——读 getElementRenderBounds
        // 建视口裁剪的 AABB 缓存，但那次 draw() 到底有没有真正落画布还不确定，缓存里存的
        // 可能是分离位移前的旧渲染包围盒。后续裁剪一直按这份"旧坐标"缓存判定可见性，
        // 放大后视口世界矩形变小，节点实际在视口内、缓存里的旧坐标却落在矩形外，就被
        // setElementVisibility 错误藏起来（"放大后节点消失"）。改成直接 await
        // graph.draw()（不走 requestDraw 队列）——此刻仍处在建图 effect 唯一一条顺序
        // 执行的初始化链路里，没有其它交互触发的并发 draw() 请求跟它抢共享变更队列，
        // 等价于 render()/fitView() 内部同样直接调 draw() 的安全前提；调用方必须等这个
        // Promise resolve 之后才能读 getElementRenderBounds 建缓存，缓存这才对得上分离
        // 后的真实渲染状态。
        await graph.draw().catch(() => undefined)
      }
    }
    const ensureIconFont =
      typeof document !== 'undefined' && 'fonts' in document
        ? document.fonts.load('900 12px "Font Awesome 6 Free"').catch(() => undefined)
        : Promise.resolve()
    ensureIconFont.then(() =>
      graph.render().then(() =>
        // 保险补一次显式 fitView：autoFit:'view' 理论上已经在 render 完成时生效，但
        // d3-force 是渐进收敛的，不同批次/环境下 render() resolve 的时机与仿真收敛帧
        // 可能有微小错位，显式再 fit 一次代价极低、能兜底"大图 fit 到半收敛帧的 bbox"
        // 这种边缘情况，不依赖时序巧合。
        graph.fitView({ when: 'always' }).catch(() => undefined),
      ).then(async () => {
        // 收敛后显式停仿真（belt-and-suspenders），防止未来调参不小心让仿真收敛不到底、
        // 在后台持续无意义地跑（不算"常驻动画"，只是防患于未然）。
        graph.stopLayout()
        // 圆形分离修正放在仿真真正停下之后——纯数据层计算+同步应用，不依赖任何渲染层
        // 状态，不需要像之前 getElementRenderBounds 版本那样纠结时序。修正会挪动节点
        // 坐标，之后补一次 fitView 让视口贴合修正后的最终范围。两步都必须 await 完才能
        // 往下走——下面 refreshElementBounds 建视口裁剪缓存要读的是这两步都落画布之后
        // 的真实渲染包围盒，早一步读到的都是旧状态（见 resolveComboOverlaps 内部注释）。
        await resolveComboOverlaps()
        await graph.fitView({ when: 'always' }).catch(() => undefined)
        // 缓存这轮收敛后的坐标，供下次切回同一 modeKey 时秒开（见上方"布局缓存"）。
        const positions = new Map<string, { x: number; y: number }>()
        for (const n of graphData.nodes ?? []) {
          const p = graph.getElementPosition(String(n.id))
          if (p) positions.set(String(n.id), { x: p[0], y: p[1] })
        }
        cache.positions.set(modeKey, positions)
        // 视口裁剪的世界坐标包围盒缓存：收敛完成、坐标不再变化的这一刻是缓存的正确时机——
        // 缓存早了（比如冷启动网格骨架阶段）会拿到还没收敛的临时坐标，裁剪判断会不准。
        elementBoundsCache = new Map()
        refreshElementBounds(allElementIds())
        culledIds = new Set()
        if (!disposed && renderTokenRef.current === myToken) setReadyToken(myToken)
      }),
    )

    return () => {
      disposed = true
      if (hoverThrottleTimer) clearTimeout(hoverThrottleTimer)
      if (interactionTimer) clearTimeout(interactionTimer)
      if (drawRequestRef.current === requestDraw) drawRequestRef.current = null
      graph.destroy()
      graphRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [built])

  // 选中/hover 节点时的 BFS 高亮范围：默认（stepHopMode=false）仍是一次性全亮全部上下游，
  // hover 复用同一套渲染（选中优先，hover 只是预览态，见上方事件绑定）。未选中/未 hover 时，
  // 盘点治理过滤生效则改成"亮过滤命中的节点、其余淡出"。三者互斥，选中 > hover > 治理过滤。
  // 仅明细视图有意义（聚合视图没有 BFS 语义）。
  const closureInfo = useMemo(() => {
    if (built?.mode !== 'detail') return null
    const focusId2 = selectedId ?? hoveredId
    if (focusId2 && adjacency) {
      const levels = bfsLevels(adjacency, focusId2)
      const limit = stepHopMode && selectedId ? hopDepth : Infinity
      const closure = new Set<string>([focusId2])
      levels.upstream.forEach((lvl, id) => {
        if (lvl <= limit) closure.add(id)
      })
      levels.downstream.forEach((lvl, id) => {
        if (lvl <= limit) closure.add(id)
      })
      return { mode: 'selection' as const, closure, maxDepth: levels.maxDepth }
    }
    // 特殊节点筛选器：多选并集（OR）——命中筛选集合里任一 flag 的节点算命中。优先级排在
    // 选中/hover 之后、既有的盘点治理过滤（govFilter，孤儿/无出边单选）之前，两者互斥
    // （同一时刻只有一套 faded/highlight 语义生效，不叠加计算）。
    if (specialFlagFilter.size > 0) {
      const closure = new Set<string>()
      for (const n of built.data.graphData.nodes ?? []) {
        const flags = (n.data?.specialFlags as string[]) ?? []
        if (flags.some((f) => specialFlagFilter.has(f))) closure.add(String(n.id))
      }
      return { mode: 'special-filter' as const, closure, maxDepth: 0 }
    }
    if (govFilter !== 'none' && adjacency) {
      const ids = (built.data.graphData.nodes ?? []).map((n) => String(n.id))
      const matches = governanceMatches(ids, adjacency, govFilter)
      return { mode: 'governance' as const, closure: matches, maxDepth: 0 }
    }
    return null
  }, [built, selectedId, hoveredId, adjacency, stepHopMode, hopDepth, govFilter, specialFlagFilter])

  // 应用高亮/淡出 + 图例筛显隐。必须是"当前这轮建图已完成 render"（readyToken===当前 token）
  // 才能调 setElementState，否则对着还没画完的元素操作会读 undefined.draw 崩溃。仅明细视图
  // 需要这套状态机。
  useEffect(() => {
    const graph = graphRef.current
    if (!graph || built?.mode !== 'detail' || readyToken !== renderTokenRef.current) return

    const closure = closureInfo?.closure ?? new Set<string>()
    const isSelectionMode = closureInfo?.mode === 'selection'
    const hasActiveFilter = closureInfo !== null

    // P1 修复③：hover/选中态高频触发，BFS 已经算出这一轮的上下游闭包——没必要每次都把
    // "全部节点/边的状态"整体重推给 setElementState（逐元素异步处理，742 节点+700 边规模下
    // 全量推送本身就是开销）。只对比"上一次真正应用过的状态"和"这一轮算出的状态"，把变化
    // 的那部分（本质是上一次高亮集合与本次高亮集合的差集，外加治理过滤/图例隐藏引起的变化）
    // 收进 diff，只推这部分。
    const myGeneration = ++highlightGenerationRef.current
    const prev = prevAppliedStatesRef.current
    const nextNodeStates = new Map<string, string[]>()
    const nextEdgeStates = new Map<string, string[]>()
    const diff: Record<string, string[]> = {}

    const statesEqual = (a: string[] | undefined, b: string[]) =>
      !!a && a.length === b.length && a.every((s, i) => s === b[i])

    for (const n of built.data.graphData.nodes ?? []) {
      const id = String(n.id)
      const states: string[] = []
      const flags = (n.data?.specialFlags as string[]) ?? []
      if (flags.some((f) => hiddenFlags.has(f))) states.push('legend-hidden')
      if (hasActiveFilter) states.push(closure.has(id) ? 'highlight' : 'faded')
      nextNodeStates.set(id, states)
      if (!statesEqual(prev.nodes.get(id), states)) diff[id] = states
    }

    for (const e of built.data.graphData.edges ?? []) {
      const id = String(e.id)
      const source = String(e.source)
      const target = String(e.target)
      const states: string[] = []
      // 治理过滤只标记节点本身（孤儿/无出边是节点属性），边不跟着变淡；只有选中/hover 的
      // BFS 高亮才需要把"链路上的边"也点亮（方案三①：默认极淡，命中才加深+亮箭头）。
      if (isSelectionMode) states.push(closure.has(source) && closure.has(target) ? 'highlight' : 'faded')
      nextEdgeStates.set(id, states)
      if (!statesEqual(prev.edges.get(id), states)) diff[id] = states
    }

    // 返工③：setElementState 是异步的，兑现前就把 prev 写成"已生效"——一旦它 reject（比如
    // 元素中途被销毁），ref 记录的状态和画布实际状态就永久对不上，diff 逻辑会把这批元素误判
    // 成"没变化"而永远跳过重推，残留高亮自愈不了。改成兑现后才提交 prev；失败时保持 prev
    // 不变，让下一轮 effect 重新算出同样的 diff、再推一次，属于自愈重试而不是死状态。
    if (Object.keys(diff).length > 0) {
      graph
        .setElementState(diff)
        .then(() => {
          // 返工B：兑现时再检查一次自己是否还是最新一轮，过期的旧轮放弃提交，不覆盖新轮。
          if (highlightGenerationRef.current === myGeneration) {
            prevAppliedStatesRef.current = { nodes: nextNodeStates, edges: nextEdgeStates }
          }
        })
        .catch(() => undefined)
    } else if (highlightGenerationRef.current === myGeneration) {
      prevAppliedStatesRef.current = { nodes: nextNodeStates, edges: nextEdgeStates }
    }
  }, [closureInfo, hiddenFlags, built, readyToken])

  // 配色切换器（P1⑥）：按当前 colorMode 重算每个节点的 fill/stroke + combo 底色淡化，
  // 用 updateNodeData/updateComboData 局部 patch + draw() 重绘，不触发 layout 重跑。
  // 仅明细视图生效——聚合视图的簇节点没有 enabled/lastRunStatus 等单条工作流字段。
  useEffect(() => {
    const graph = graphRef.current
    if (!graph || built?.mode !== 'detail' || readyToken !== renderTokenRef.current) return

    const nodeUpdates = built.data.graphData.nodes!.map((n) => {
      const raw = nodeById.get(String(n.id))
      const deptSwatch = { fill: (n.style as any)?.fill, stroke: (n.style as any)?.stroke, dot: (n.style as any)?.stroke }
      const swatch = raw ? nodeSwatchForMode(colorMode, raw, deptSwatch) : deptSwatch
      return { id: n.id, style: { fill: swatch.fill, stroke: swatch.stroke } }
    })
    graph.updateNodeData(nodeUpdates)

    const comboUpdates = (built.data.graphData.combos ?? []).map((c) => {
      const kind = (c.data?.kind as 'dept' | 'cat') ?? 'cat'
      const overlay =
        colorMode === 'department'
          ? { fillOpacity: (c.style as any)?.fillOpacity, strokeOpacity: (c.style as any)?.strokeOpacity }
          : COMBO_NEUTRALIZED_OVERLAY[kind]
      // 返工①：同步写进 comboColorOverlayRef——这是"当前配色模式下 combo 应该长什么样"的
      // 唯一真源，拖拽降级结束后的恢复逻辑（applyDegradedVisibility）读的就是这份实时记录，
      // 不是建图期那份写死 department 配色的快照。
      comboColorOverlayRef.current.set(String(c.id), overlay)
      return { id: c.id, style: overlay }
    })
    graph.updateComboData(comboUpdates)

    // P0 修复⑤：不再自己独立调 graph.draw()——改走建图 effect 里挂到 drawRequestRef 的串行化
    // 队列，与 applyDegradedVisibility 的 draw() 共享同一把锁，避免两处并发 draw() 竞争同一个
    // "读取并清空"的共享变更队列（根因见诊断文档卡点⑤）。
    drawRequestRef.current?.()
  }, [colorMode, built, readyToken, nodeById])

  // 多入口 focus（P1.3⑤）：数据就绪后按 focusId（slug 或 id）定位目标节点——自动选中
  // （复用既有 BFS 高亮）+ focusElement 把视口居中过去。只应用一次（focusAppliedRef），
  // 避免用户手动选别的节点后又被 focus 参数拽回去。仅明细视图（含下钻子图）适用。
  useEffect(() => {
    const graph = graphRef.current
    if (!graph || built?.mode !== 'detail' || !resp || readyToken !== renderTokenRef.current) return
    if (!focusId || focusAppliedRef.current) return
    const matchedId = findNodeIdByFocus(resp.nodes, focusId)
    if (!matchedId) return
    focusAppliedRef.current = true
    setSelectedId(matchedId)
    graph.focusElement(matchedId, { duration: 500, easing: 'ease-in-out' } as any).catch(() => undefined)
  }, [focusId, built, resp, readyToken])

  // 侧栏排行榜点击（方案三③）挂起的定位请求：等 focusFromRanking 切完视图、这一轮建图
  // render 完成后消费一次。
  useEffect(() => {
    const graph = graphRef.current
    if (!graph || built?.mode !== 'detail' || readyToken !== renderTokenRef.current || !pendingLocate) return
    locateNode(pendingLocate)
    setPendingLocate(null)
  }, [pendingLocate, built, readyToken, locateNode])

  const toggleFlag = useCallback((flag: string) => {
    setHiddenFlags((prev) => {
      const next = new Set(prev)
      if (next.has(flag)) next.delete(flag)
      else next.add(flag)
      return next
    })
  }, [])

  const toggleSpecialFlagFilter = useCallback((flag: string) => {
    setSpecialFlagFilter((prev) => {
      const next = new Set(prev)
      if (next.has(flag)) next.delete(flag)
      else next.add(flag)
      return next
    })
  }, [])

  // 特殊节点筛选器 chip 组用的逐类计数——只渲染当前这份数据里真实存在的类别（数据没有的类别
  // 不出 chip，避免摆一堆点了也没反应的死 chip）。仅明细视图有意义。
  const specialFlagCounts = useMemo(() => {
    const counts = new Map<string, number>()
    if (built?.mode !== 'detail') return counts
    for (const n of built.data.graphData.nodes ?? []) {
      const flags = (n.data?.specialFlags as string[]) ?? []
      for (const f of flags) counts.set(f, (counts.get(f) ?? 0) + 1)
    }
    return counts
  }, [built])

  // 返工建议③：切视图/scope/下钻会换一批数据，之前选中的筛选类别可能在新数据里根本不存在——
  // 不清理的话 chip 组会整块消失（specialFlagCounts.size===0 时不渲染），但 specialFlagFilter
  // 状态还留着那个死类别，closureInfo 的筛选分支永远查不到命中，全图卡死在"淡出"、且没有
  // chip 可点去清除，成了一个无处可退的死角。built 变化时按新数据实际可用类别求交集裁剪。
  useEffect(() => {
    setSpecialFlagFilter((prev) => {
      if (prev.size === 0) return prev
      const next = new Set(Array.from(prev).filter((f) => specialFlagCounts.has(f)))
      return next.size === prev.size ? prev : next
    })
  }, [specialFlagCounts])

  const selectedNode = selectedId ? nodeById.get(selectedId) ?? null : null
  const drilldownLabel = drilldown
    ? drilldown.level === 'service'
      ? drilldown.department
      : `${drilldown.department} / ${drilldown.category}`
    : null

  return (
    <div data-alt="workflow-dependency-graph" className="flex h-full w-full">
      <div data-alt="graph-canvas-area" className="relative flex-1 min-w-0">
        <div ref={containerRef} data-alt="g6-canvas-container" className="h-full w-full" />

        {/* 方案一②工具栏收纳：视图 tab（明细/聚合×2）+ 分簇选项（仅明细态）+ 配色切换器
            （仅明细态）纵向堆叠成一组紧凑控件，别跟其它面板堆爆左上角。 */}
        <div data-alt="graph-toolbar" className="absolute left-3 top-3 z-10 flex flex-col items-start gap-1.5">
          <div
            data-alt="view-mode-switcher"
            className="flex items-center gap-0.5 rounded-lg border border-slate-200 bg-white/95 p-1 shadow-soft backdrop-blur"
          >
            {VIEW_MODE_ORDER.map((mode) => (
              <button
                key={mode}
                data-alt={`view-mode-${mode}`}
                onClick={() => switchViewMode(mode)}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
                  viewMode === mode
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
                }`}
              >
                <i className={`fas ${VIEW_MODE_META[mode].icon} text-[11px]`} />
                {VIEW_MODE_META[mode].label}
              </button>
            ))}
          </div>

          {isDetail && !drilldown && (
            <div
              data-alt="cluster-mode-switcher"
              className="flex items-center gap-0.5 rounded-lg border border-slate-200 bg-white/95 p-1 shadow-soft backdrop-blur"
            >
              {CLUSTER_MODE_ORDER.map((mode) => (
                <button
                  key={mode}
                  data-alt={`cluster-mode-${mode}`}
                  onClick={() => setClusterMode(mode)}
                  className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
                    clusterMode === mode
                      ? 'bg-slate-700 text-white shadow-sm'
                      : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
                  }`}
                >
                  <i className={`fas ${CLUSTER_MODE_META[mode].icon} text-[11px]`} />
                  {CLUSTER_MODE_META[mode].label}
                </button>
              ))}
            </div>
          )}

          {/* boss 改主意：筛选 chip 不跟分簇切换器同行了，改回独立一行（放它下面，左对齐同一组
              工具栏），分段按钮风格维持不变。父容器 graph-toolbar 是 flex-col，直接作为下一个
              子项就会自动另起一行、左对齐。 */}
          {/* 特殊节点筛选器：多选并集，命中即常态、未命中淡出（复用 closureInfo 的
              highlight/faded 状态机），与配色模式/聚合明细切换互不干扰——仅按当前这份数据里
              真实存在的类别出 chip，boss 点名的四类（定时执行/Redis/Kafka/等待 Notify）
              不存在时同样不渲染死 chip。 */}
          {isDetail && specialFlagCounts.size > 0 && (
            <div
              data-alt="special-flag-filter"
              // boss 反馈：风格要跟分簇切换器统一——同款分段按钮容器（同边框/圆角/内边距），
              // 去掉彩点+图标（纯文字+计数），文案缩短到不需要横向滚动就能一行放下。
              className="flex items-center gap-0.5 rounded-lg border border-slate-200 bg-white/95 p-1 shadow-soft backdrop-blur"
            >
              {SPECIAL_FLAG_FILTER_ORDER.filter((flag) => (specialFlagCounts.get(flag) ?? 0) > 0).map((flag) => {
                const meta = SPECIAL_FLAG_META[flag]
                const count = specialFlagCounts.get(flag) ?? 0
                const active = specialFlagFilter.has(flag)
                return (
                  <button
                    key={flag}
                    data-alt={`special-flag-filter-${flag}`}
                    onClick={() => toggleSpecialFlagFilter(flag)}
                    className={`flex items-center gap-1 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
                      active ? 'bg-slate-700 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
                    }`}
                  >
                    {meta.shortLabel}
                    <span
                      className={`rounded-full px-1.5 text-[10px] ${active ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'}`}
                    >
                      {count}
                    </span>
                  </button>
                )
              })}
              {specialFlagFilter.size > 0 && (
                <button
                  data-alt="special-flag-filter-clear"
                  onClick={() => setSpecialFlagFilter(new Set())}
                  className="whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                >
                  清除
                </button>
              )}
            </div>
          )}

          {drilldown && (
            <button
              data-alt="drilldown-breadcrumb"
              onClick={() => setDrilldown(null)}
              className="flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50/95 px-2.5 py-1.5 text-xs font-medium text-indigo-700 shadow-soft backdrop-blur hover:bg-indigo-100"
            >
              <i className="fas fa-arrow-left text-[10px]" />
              返回聚合视图 · 当前下钻：{drilldownLabel}
            </button>
          )}

          {isDetail && (
            <div
              data-alt="color-mode-switcher"
              className="flex items-center gap-0.5 rounded-lg border border-slate-200 bg-white/95 p-1 shadow-soft backdrop-blur"
            >
              {COLOR_MODE_ORDER.map((mode) => (
                <button
                  key={mode}
                  data-alt={`color-mode-${mode}`}
                  onClick={() => setColorMode(mode)}
                  className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
                    colorMode === mode
                      ? 'bg-indigo-600 text-white shadow-sm'
                      : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
                  }`}
                >
                  <i className={`fas ${COLOR_MODE_META[mode].icon} text-[11px]`} />
                  {COLOR_MODE_META[mode].label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 搜索定位（大规模刚需②）：仅明细视图渲染——聚合视图的簇节点没有 slug/id 语义。 */}
        {isDetail && (
          <div data-alt="graph-search-box" className="absolute right-3 top-3 z-20 w-72">
            <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white/95 px-2.5 py-1.5 shadow-soft backdrop-blur">
              <i className="fas fa-magnifying-glass text-[11px] text-slate-400" />
              <input
                data-alt="graph-search-input"
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder="搜索 workflow id / slug / 名称…"
                className="w-full bg-transparent text-xs text-slate-700 placeholder:text-slate-400 outline-none"
              />
              {searchQuery && (
                <button
                  data-alt="graph-search-clear"
                  onClick={() => setSearchQuery('')}
                  className="text-slate-300 hover:text-slate-500"
                >
                  <i className="fas fa-xmark text-[11px]" />
                </button>
              )}
            </div>
            {searchQuery && searchMatches.length > 1 && (
              <div
                data-alt="graph-search-dropdown"
                className="mt-1 max-h-64 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-soft"
              >
                {searchMatches.map((n, i) => (
                  <button
                    key={n.id}
                    data-alt={`graph-search-result-${n.id}`}
                    onMouseEnter={() => setSearchHighlight(i)}
                    onClick={() => locateNode(String(n.id))}
                    className={`flex w-full flex-col items-start gap-0.5 px-2.5 py-1.5 text-left text-xs transition ${
                      i === searchHighlight ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <span className="font-medium">{n.name || n.slug}</span>
                    <span className="text-[10px] text-slate-400">
                      slug: {n.slug} · id: {n.id}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {searchQuery && searchMatches.length === 0 && (
              <div
                data-alt="graph-search-empty"
                className="mt-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-400 shadow-soft"
              >
                无匹配结果
              </div>
            )}
          </div>
        )}


        {!isDetail && (
          <div
            data-alt="aggregate-hint"
            className="absolute right-3 top-3 z-10 rounded-lg border border-slate-200 bg-white/95 px-2.5 py-1.5 text-[11px] text-slate-400 shadow-soft backdrop-blur"
          >
            <i className="fas fa-hand-pointer text-[10px] mr-1" />
            点击簇节点可下钻查看明细
          </div>
        )}

        {loading && (
          <div
            data-alt="graph-loading-overlay"
            className="absolute inset-0 flex items-center justify-center bg-white/70"
          >
            <div className="flex items-center gap-2 rounded-lg border border-slate-100 bg-white px-4 py-2.5 text-sm text-slate-500 shadow-soft">
              <i className="fas fa-circle-notch fa-spin text-indigo-400" />
              依赖图加载中…
            </div>
          </div>
        )}
        {errorMsg && !loading && (
          <div
            data-alt="graph-error-overlay"
            className="absolute inset-0 flex items-center justify-center bg-white/90"
          >
            <div className="flex items-center gap-2 rounded-lg border border-rose-100 bg-white px-4 py-2.5 text-sm text-rose-600 shadow-soft">
              <i className="fas fa-triangle-exclamation" />
              {errorMsg}
            </div>
          </div>
        )}
        {!loading && !errorMsg && resp && resp.nodes.length === 0 && (
          <div
            data-alt="graph-empty-overlay"
            className="absolute inset-0 flex items-center justify-center"
          >
            <div className="flex items-center gap-2 rounded-lg border border-slate-100 bg-white px-4 py-2.5 text-sm text-slate-400 shadow-soft">
              <i className="fas fa-diagram-project text-slate-300" />
              当前库暂无工作流，无法生成依赖图
            </div>
          </div>
        )}
      </div>

      <aside data-alt="graph-side-panel" className="w-72 shrink-0 border-l border-slate-200 bg-white p-4 overflow-y-auto">
        {isDetail && colorMode === 'department' && (
          <div data-alt="graph-legend" className="mb-6">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
              特殊节点图例（点击筛显隐）
            </div>
            <div className="space-y-1">
              {Object.entries(SPECIAL_FLAG_META).map(([flag, meta]) => (
                <button
                  key={flag}
                  data-alt={`legend-toggle-${flag}`}
                  onClick={() => toggleFlag(flag)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition border border-transparent ${
                    hiddenFlags.has(flag)
                      ? 'opacity-40 line-through'
                      : 'hover:border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dotClass}`} />
                  <i className={`fas ${meta.faClass} text-xs text-slate-500`} />
                  <span className="text-slate-700">{meta.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {isDetail && colorMode !== 'department' && (
          <div data-alt="graph-color-legend" className="mb-6">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
              {COLOR_MODE_META[colorMode].label} 色标
            </div>
            {colorMode === 'errorRate' ? (
              <div data-alt="legend-error-rate-gradient" className="space-y-1.5">
                <div
                  className="h-2.5 w-full rounded-full"
                  style={{
                    background: `linear-gradient(90deg, ${errorRateLegendStops()
                      .map((s) => s.color)
                      .join(', ')})`,
                  }}
                />
                <div className="flex justify-between text-[10px] text-slate-400">
                  {errorRateLegendStops().map((s) => (
                    <span key={s.pct}>{Math.round(s.pct * 100)}%</span>
                  ))}
                </div>
                <div className="text-[11px] text-slate-400">近 7 天失败率（含超时）</div>
              </div>
            ) : (
              <div className="space-y-1">
                {(colorMode === 'enabled'
                  ? [
                      { key: 'on', label: '启用', color: '#10b981' },
                      { key: 'off', label: '禁用', color: '#94a3b8' },
                    ]
                  : colorMode === 'status'
                    ? [
                        { key: 'success', label: '成功', color: '#10b981' },
                        { key: 'failed', label: '失败', color: '#f43f5e' },
                        { key: 'none', label: '无记录', color: '#94a3b8' },
                      ]
                    : [
                        { key: 'active', label: '活跃（24 小时内跑过）', color: '#22c55e' },
                        { key: 'idle', label: '一般（7 天内跑过）', color: '#f59e0b' },
                        { key: 'dormant', label: '沉寂（7 天以上无运行）', color: '#94a3b8' },
                      ]
                ).map((item) => (
                  <div key={item.key} data-alt={`legend-color-${item.key}`} className="flex items-center gap-2 px-2 py-1 text-sm">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
                    <span className="text-slate-700">{item.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {resp && (
          <div data-alt="graph-summary" className="mb-6 text-xs text-slate-500 space-y-1">
            <div>
              范围：{scope ? `${scope.department} / ${scope.category}` : '全部工作流'}
            </div>
            <div>节点数：{resp.nodes.length}</div>
            <div>依赖边数：{resp.edges.length}</div>
            {resp.unresolved > 0 && <div className="text-amber-600">未解析目标：{resp.unresolved}</div>}
          </div>
        )}

        {!isDetail && (
          <div data-alt="aggregate-side-hint" className="border-t border-slate-100 pt-4 text-xs text-slate-400">
            聚合视图下节点是"簇"（{viewMode === 'aggregate-service' ? '按服务' : '按分类'}），大小=簇内工作流条数，
            簇间连线粗细/数字=跨簇调用条数。点击任意簇节点下钻查看该簇明细。
          </div>
        )}

        {isDetail && selectedNode ? (
          <div data-alt="graph-selected-panel" className="border-t border-slate-100 pt-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
              选中工作流（高亮上下游）
            </div>
            <div className="flex items-center gap-1.5 mb-1">
              <div className="text-sm font-medium text-slate-800">{selectedNode.name}</div>
              {selectedNode.external && (
                <span className="rounded bg-slate-500 px-1.5 py-0.5 text-[10px] font-medium text-white">
                  外部依赖
                </span>
              )}
            </div>
            <div className="text-xs text-slate-500 mb-1">slug: {selectedNode.slug}</div>
            <div className="text-xs text-slate-500 mb-1">
              {selectedNode.department || '共享'} / {selectedNode.category || '未分类'}
            </div>
            <div className="text-xs text-slate-500 mb-3">节点数：{selectedNode.nodeCount}</div>

            {/* 方案 B：运行状态指标恒定显示（与当前配色切换器选的是哪一档无关）——启停/
                最近成败/活跃度/错误率，色值与配色切换器的图例刻度同源，两处读起来一致。 */}
            <div data-alt="selected-node-status" className="mb-3 grid grid-cols-2 gap-1.5">
              <div className="flex items-center gap-1.5 rounded-md bg-slate-50 px-2 py-1 text-[11px]">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: selectedNode.enabled ? '#10b981' : '#94a3b8' }}
                />
                <span className="text-slate-500">启停</span>
                <span className="ml-auto font-medium text-slate-700">{selectedNode.enabled ? '启用' : '禁用'}</span>
              </div>
              <div className="flex items-center gap-1.5 rounded-md bg-slate-50 px-2 py-1 text-[11px]">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: DETAIL_STATUS_DOT[selectedNode.lastRunStatus] }}
                />
                <span className="text-slate-500">最近成败</span>
                <span className="ml-auto font-medium text-slate-700">{DETAIL_STATUS_LABEL[selectedNode.lastRunStatus]}</span>
              </div>
              <div className="col-span-2 flex items-center gap-1.5 rounded-md bg-slate-50 px-2 py-1 text-[11px]">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: DETAIL_ACTIVITY_DOT[selectedNode.activity] }}
                />
                <span className="text-slate-500">活跃度</span>
                <span className="ml-auto font-medium text-slate-700">{DETAIL_ACTIVITY_LABEL[selectedNode.activity]}</span>
              </div>
              <div className="col-span-2 flex items-center gap-1.5 rounded-md bg-slate-50 px-2 py-1 text-[11px]">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: errorRateColor(selectedNode.errorRate).stroke }}
                />
                <span className="text-slate-500">近 7 天错误率</span>
                <span className="ml-auto font-medium text-slate-700">{Math.round(selectedNode.errorRate * 100)}%</span>
              </div>
            </div>

            {/* 排障逐跳（P1.3）：默认仍是一次性全亮（stepHopMode=false，行为不变）；
                打开后从"只亮选中节点"起步，靠上一跳/下一跳按当前依赖链深度逐步点亮，
                便于顺链排障时一层一层看，而不是一眼被全量高亮淹没。 */}
            <div data-alt="step-hop-panel" className="mb-3 rounded-lg border border-slate-100 bg-slate-50/60 p-2.5">
              <label className="flex items-center justify-between gap-2 text-xs text-slate-600 cursor-pointer select-none">
                <span className="flex items-center gap-1.5">
                  <i className="fas fa-shoe-prints text-[11px] text-slate-400" />
                  排障逐跳模式
                </span>
                <input
                  data-alt="step-hop-toggle"
                  type="checkbox"
                  checked={stepHopMode}
                  onChange={(e) => setStepHopMode(e.target.checked)}
                  className="accent-indigo-600"
                />
              </label>
              {stepHopMode && closureInfo && (
                <div className="mt-2 flex items-center justify-between gap-2">
                  <button
                    data-alt="step-hop-prev"
                    type="button"
                    disabled={hopDepth <= 0}
                    onClick={() => setHopDepth((d) => Math.max(0, d - 1))}
                    className="flex-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <i className="fas fa-arrow-left text-[10px] mr-1" />
                    上一跳
                  </button>
                  <span className="shrink-0 text-[11px] tabular-nums text-slate-400">
                    第 {hopDepth} / {closureInfo.maxDepth} 跳
                  </span>
                  <button
                    data-alt="step-hop-next"
                    type="button"
                    disabled={hopDepth >= closureInfo.maxDepth}
                    onClick={() => setHopDepth((d) => Math.min(closureInfo.maxDepth, d + 1))}
                    className="flex-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    下一跳
                    <i className="fas fa-arrow-right text-[10px] ml-1" />
                  </button>
                </div>
              )}
            </div>

            <button
              data-alt="open-workflow-button"
              onClick={() => openWorkflow(String(selectedNode.id))}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-700"
            >
              <i className="fas fa-arrow-up-right-from-square text-xs" />
              打开工作流编辑器
            </button>
            <div className="mt-2 text-[11px] text-slate-400">双击节点可直接跳转</div>
          </div>
        ) : isDetail ? (
          <div data-alt="graph-hint" className="border-t border-slate-100 pt-4 text-xs text-slate-400">
            点击节点查看详情并高亮改动影响面；双击节点跳转到工作流编辑器；鼠标悬停节点可预览其上下游。
          </div>
        ) : null}

        {/* 盘点治理过滤（P1.2）：孤儿/无出边二选一，与排行榜合并进同一个侧栏，不再跟画布上的
            浮层堆两套 UI。仅明细视图有意义。选中详情置于最上，榜单类内容沉底。 */}
        {isDetail && (
          <div data-alt="governance-filter-panel" className="mt-6 border-t border-slate-100 pt-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">盘点治理过滤</div>
            <div className="flex flex-wrap gap-1">
              {GOV_FILTER_ORDER.map((f) => (
                <button
                  key={f}
                  data-alt={`gov-filter-${f}`}
                  onClick={() => setGovFilter((prev) => (prev === f ? 'none' : f))}
                  disabled={!!selectedId}
                  title={selectedId ? '已选中节点时治理过滤暂不生效，先取消选中' : undefined}
                  className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-40 disabled:cursor-not-allowed ${
                    govFilter === f
                      ? 'border-amber-500 bg-amber-500 text-white'
                      : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                  }`}
                >
                  <i className={`fas ${GOV_FILTER_META[f].icon} text-[11px]`} />
                  {GOV_FILTER_META[f].label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 方案三③排行榜：基于全量依赖图，不受当前视图/下钻影响；点条目强制切回明细全量视图
            并聚焦选中该节点（复用搜索框同一套 locateNode 逻辑）。抽成独立 memo 组件（见文件
            末尾 RankingsPanel）——性能二期④：排行榜内容只依赖 rankings（不随 hover/选中变），
            React.memo 后 hover 引发的父组件重渲染不会连带重新计算/diff 这块最大的侧栏 JSX。 */}
        <RankingsPanel rankings={rankings} onFocus={focusFromRanking} />
      </aside>
    </div>
  )
}

/**
 * 性能二期④侧栏 memo 隔离：排行榜是侧栏里最大的一块 JSX（三组 Top10，最多 30 个按钮），
 * 但内容只取决于 rankings（源自 resp+adjacency，跟 hover/选中态完全无关）。抽成独立组件 +
 * React.memo，父组件因 hoveredId 变化而重渲染时，只要 rankings 引用没变就跳过这块的
 * reconcile，不拖慢画布交互期间的整体渲染节奏。
 */
const RankingsPanel = memo(function RankingsPanel({
  rankings,
  onFocus,
}: {
  rankings: Rankings | null
  onFocus: (id: string) => void
}) {
  if (!rankings) return null
  return (
    <div data-alt="graph-rankings-panel" className="mt-6 border-t border-slate-100 pt-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">依赖排行榜</div>
      <div className="space-y-3">
        {RANKING_ORDER.map((key) => (
          <div key={key} data-alt={`ranking-group-${key}`}>
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500 mb-1">
              <i className={`fas ${RANKING_META[key].icon} text-[10px]`} />
              {RANKING_META[key].label} Top{rankings[key].length}
            </div>
            {rankings[key].length === 0 ? (
              <div className="text-[11px] text-slate-300 pl-1">暂无数据</div>
            ) : (
              <div className="space-y-0.5">
                {rankings[key].map((entry, idx) => (
                  <button
                    key={entry.id}
                    data-alt={`ranking-item-${key}-${entry.id}`}
                    onClick={() => onFocus(entry.id)}
                    className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[11px] text-slate-600 hover:bg-slate-50"
                  >
                    <span className="w-4 shrink-0 text-right tabular-nums text-slate-300">{idx + 1}</span>
                    <span className="flex-1 truncate">{entry.label}</span>
                    <span className="shrink-0 tabular-nums font-medium text-slate-500">{entry.value}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
})
