import type { GraphData, NodeData, ComboData, EdgeData, NodeBadgeStyleProps } from '@antv/g6'
import { SHARED_DEPARTMENT_NAME, UNCATEGORIZED_FOLDER_NAME } from '@/components/workflow/list/types'
import type { DependencyGraphEdge, DependencyGraphNode } from './graphApi'

/**
 * 关注的特殊节点类型 —— 节点级四类（sse_publish/http_call/kafka/redis）与后端
 * DEPENDENCY_GRAPH_SPECIAL_TYPES 完全对齐；trigger_cron/trigger_notify 两类是后端按
 * 工作流 trigger_type（node_spec 触发类型清单）派生出的合成标记，同样塞进 specialFlags
 * 数组（不是 spec 里的松散别名）。
 * 图标语言与控制台侧栏对齐（同用 Font Awesome 6 Free solid），不再用 emoji：
 * - faClass 供右侧图例 DOM 渲染（`<i className="fas {faClass}">`，与侧栏图标同一套字体）；
 * - glyph 是同一枚图标的 FA unicode 码点，供 G6 canvas 角标绘制文字用（canvas 画不出 <i> 标签，
 *   只能把 fontFamily 设成 "Font Awesome 6 Free"、fontWeight 900 后画对应码点字符）。
 * color 供画布角标底色 + 图例圆点取色，与部门配色板同源于既有触发器徽标色系
 * indigo/sky/emerald/rose/violet/teal。
 */
export const SPECIAL_FLAG_META: Record<
  string,
  { label: string; shortLabel: string; faClass: string; glyph: string; color: string; dotClass: string }
> = {
  sse_publish: { label: 'SSE 推送', shortLabel: 'SSE', faClass: 'fa-satellite-dish', glyph: '', color: '#6366f1', dotClass: 'bg-indigo-500' },
  http_call: { label: 'HTTP 调用', shortLabel: 'HTTP', faClass: 'fa-globe', glyph: '', color: '#0ea5e9', dotClass: 'bg-sky-500' },
  kafka: { label: 'Kafka 消息', shortLabel: 'Kafka', faClass: 'fa-layer-group', glyph: '', color: '#10b981', dotClass: 'bg-emerald-500' },
  redis: { label: 'Redis 操作', shortLabel: 'Redis', faClass: 'fa-bolt', glyph: '', color: '#f43f5e', dotClass: 'bg-rose-500' },
  trigger_cron: { label: '定时执行', shortLabel: '定时', faClass: 'fa-clock', glyph: '', color: '#7c3aed', dotClass: 'bg-violet-500' },
  trigger_notify: { label: '等待 Notify', shortLabel: 'Notify', faClass: 'fa-bell', glyph: '', color: '#0d9488', dotClass: 'bg-teal-500' },
}

/** 特殊节点筛选器（左上角 chip 组）展示顺序：boss 点名的四类在前（定时/redis/kafka/notify），
 *  其余数据里实际存在的特殊类型追加在后。与 SPECIAL_FLAG_META 的 key 集合保持一致。 */
export const SPECIAL_FLAG_FILTER_ORDER = ['trigger_cron', 'redis', 'kafka', 'trigger_notify', 'sse_publish', 'http_call']

export const DEPT_COMBO_PREFIX = 'graph-dept::'
export const CAT_COMBO_PREFIX = 'graph-cat::'

export function deptComboId(dept: string): string {
  return `${DEPT_COMBO_PREFIX}${dept}`
}

export function catComboId(dept: string, cat: string): string {
  return `${CAT_COMBO_PREFIX}${dept}::${cat}`
}

/**
 * 部门配色板 —— 与工作流列表页触发器徽标同源色系。顺序刻意按"相邻项色相冷暖交替、
 * 尽量拉开"排列（indigo 冷紫蓝 → amber 暖橙黄 → emerald 冷绿 → rose 暖粉红 → sky 冷青蓝 →
 * violet 暖紫 → cyan 冷青 → orange 暖橙 → teal 冷青绿 → fuchsia 暖品红），不是按色相环顺序堆放。
 * 目的：在场 department 只有 2、3 个这种最常见的情况下，依次分配到的前几个颜色天然拉开，
 * 不会像"indigo 紧挨 violet"那样两个蓝紫系挤在最前面、远看分不清（原顺序的问题）。
 * "共享"固定归 slate 兜底档，不占用这 10 色。
 */
// boss 实测大规模截图反馈：这套色原先取的是 Tailwind-50 级极浅填充 + 500 级描边，图缩小/
// 节点一多之后填充色几乎糊成白色、只剩描边能看见。填充从 50 级提到 100~200 级（更饱和一档），
// 描边从 500 级提到 600 级、label 从 600~700 提到 700~800，整体对比在缩放/多节点下更扛得住，
// 色相顺序不变（仍是冷暖交替拉开），只是每一级都往"更深"挪。
const DEPT_PALETTE: { fill: string; stroke: string; label: string }[] = [
  { fill: '#c7d2fe', stroke: '#4f46e5', label: '#3730a3' }, // indigo
  { fill: '#fde68a', stroke: '#d97706', label: '#92400e' }, // amber
  { fill: '#a7f3d0', stroke: '#059669', label: '#065f46' }, // emerald
  { fill: '#fecdd3', stroke: '#e11d48', label: '#9f1239' }, // rose
  { fill: '#bae6fd', stroke: '#0284c7', label: '#075985' }, // sky
  { fill: '#ddd6fe', stroke: '#7c3aed', label: '#5b21b6' }, // violet
  { fill: '#a5f3fc', stroke: '#0891b2', label: '#155e75' }, // cyan
  { fill: '#fed7aa', stroke: '#ea580c', label: '#9a3412' }, // orange
  { fill: '#99f6e4', stroke: '#0d9488', label: '#115e59' }, // teal
  { fill: '#f5d0fe', stroke: '#c026d3', label: '#86198f' }, // fuchsia
]
const SHARED_DEPT_COLOR = { fill: '#e2e8f0', stroke: '#475569', label: '#1e293b' } // slate 兜底（同步加深）

function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/**
 * 按当前图里**实际出现**的 department 去重、按名称排序后依次分配调色板颜色，
 * 保证只要在场 department 数 ≤ 调色板长度，同一张图里绝不会有两个 department 撞色
 * （原来按哈希取色，网关/用户服务这类会哈希碰撞落到同一色——已弃用）。
 * 超出调色板长度时循环取色，此时才会出现视觉上的"回退式"撞色，属预期降级。
 */
function buildDeptColorMap(depts: Iterable<string>): Map<string, { fill: string; stroke: string; label: string }> {
  const uniqueSorted = Array.from(new Set(depts))
    .filter((d) => d !== SHARED_DEPARTMENT_NAME)
    .sort((a, b) => a.localeCompare(b, 'zh'))
  const map = new Map<string, { fill: string; stroke: string; label: string }>()
  uniqueSorted.forEach((d, i) => {
    map.set(d, DEPT_PALETTE[i % DEPT_PALETTE.length])
  })
  return map
}

/**
 * 部门配色取色器 —— 明细图（buildGraphData）与聚合图（buildAggregatedGraphData）共用同一套
 * "先扫全量 department 去重排序分配、同图不撞色"的规则，避免两处各自维护一份颜色逻辑走偏。
 */
export function deptColorResolver(depts: Iterable<string>): (dept: string) => { fill: string; stroke: string; label: string } {
  const map = buildDeptColorMap(depts)
  return (dept: string) => (dept === SHARED_DEPARTMENT_NAME ? SHARED_DEPT_COLOR : map.get(dept) ?? SHARED_DEPT_COLOR)
}

/**
 * 工作流节点视觉大小：按 nodeCount 幂律缩放。boss 反复反馈"看不出差异"，20+3.4*n^0.85
 * 版（2cb4c6d）已解决了常见区间被压平的问题，但 boss 再反馈"多的和少的区别还是有点不明显"，
 * 要求在不换方案、不搞离散档位的前提下再稍微拉大对比。换成 18+3.8*n^0.92——底数系数略降、
 * 指数从 0.85 提到 0.92（更接近线性，边际递减更弱），整体把中大节点区间的直径差再拉开约
 * 25%~30%；MIN 从 20 提到 22（保证小节点仍装得下圆内图标/标签），MAX 从 70 提到 78
 * （大节点略微更大但仍留合理上限，不撑爆 combo）。
 */
export function nodeVisualSize(nodeCount: number): number {
  const MIN = 22
  const MAX = 78
  const size = 18 + 3.8 * Math.pow(Math.max(nodeCount, 0), 0.92)
  return Math.min(MAX, Math.max(MIN, size))
}

/**
 * 布局碰撞用尺寸：在视觉大小基础上叠加下方标签占用的空间 + 呼吸间距，传给 layout.nodeSize
 * 做防重叠碰撞检测。缓冲量按视觉尺寸等比例放大（而非维持旧的定值 +64/+72）——节点越大，
 * 需要的呼吸间距也越大，否则放大后的大节点会重新挤在一起撞回旧问题。
 */
export function nodeLayoutSize(nodeCount: number): [number, number] {
  const visual = nodeVisualSize(nodeCount)
  return [visual * 1.5 + 50, visual * 1.55 + 60]
}

/**
 * 标签可读性（真数据规模暴露①）：真环境长插件名（"购买插件Chapter Pass"这类）在固定
 * 92px 宽度下大段吃省略号，读不出关键信息。改成随节点视觉大小分档：节点越大越能"喂"给
 * 标签更多宽度（大节点本就有更多呼吸空间），小节点仍保 90px 底线（不比原来 92 差）。
 * 这个值必须写进逐节点 data.style（而非 Graph 级 node.style），原因见 WorkflowGraphCanvas.tsx
 * 里 Graph 级样式覆盖 data.style 的说明——labelMaxWidth 要按节点变化，不能是全图统一常量。
 * 配合 Graph 级 labelMaxLines:2 + labelWordWrap:true，长名优先换行，仍超出才省略号。
 */
export function nodeLabelMaxWidth(nodeCount: number): number {
  const visual = nodeVisualSize(nodeCount)
  return Math.round(Math.max(90, Math.min(170, visual * 2.1)))
}

/**
 * 估算一个 combo（服务或分类）在"被当成一个不可拆的整体来跟兄弟 combo 一起摆放"这层布局里
 * 应占的包围盒。combo-combined 在排"服务之间"/"分类之间"这层时，若仍按叶子节点的 nodeSize
 * （几十像素）估 combo 的体积，会严重低估其真实占地——即使调大 nodeSpacing，combo 之间实际
 * 还是会贴在一起甚至压住，这正是 hull 轮廓互相交叠的根因。按 combo 内工作流条数粗略估一个
 * 近似方阵：每格用 nodeLayoutSize 的中位典型值（约 150x160，对应常见工作流节点数规模）。
 */
export function estimateClusterSize(memberCount: number): [number, number] {
  const CELL_W = 150
  const CELL_H = 160
  const n = Math.max(memberCount, 1)
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)))
  const rows = Math.max(1, Math.ceil(n / cols))
  return [cols * CELL_W, rows * CELL_H]
}

/**
 * 圆内多图标排布表：badge 实际只支持字符串 placement（源码 getTextStyleByPlacement 里直接对
 * placement 调 .split('-')，传数组会直接抛异常——G6 v5 badge 并不像其它地方的 Placement
 * 类型那样支持 [x,y] 相对坐标，这是踩过一次运行时错误后确认的真实能力边界，不是猜的）。
 * 改用 placement:'center' 钉在圆心 + offsetX/offsetY 像素偏移来在圆内错开多个图标：
 * 偏移量按"节点直径的比例"给，而不是定值像素，这样大小节点里图标间距都合理，不会小节点里
 * 挤爆、大节点里又显得稀疏。按角标数量给 1~4 个预设槽位：1 个居中；2 个水平并排；
 * 3 个一排；4 个两行两列。
 */
const INSIDE_BADGE_OFFSETS: Record<number, [number, number][]> = {
  1: [[0, 0]],
  2: [
    [-0.18, 0],
    [0.18, 0],
  ],
  3: [
    [-0.27, 0],
    [0, 0],
    [0.27, 0],
  ],
  4: [
    [-0.2, -0.18],
    [0.2, -0.18],
    [-0.2, 0.18],
    [0.2, 0.18],
  ],
}

/**
 * 特殊节点角标：从"挂在圆外的色块"改成"画进圆内的纯色字形"——boss 嫌外挂角标浮在边缘不好看。
 * 改用 Font Awesome 字形（与控制台侧栏同一套图标语言）、不再叠背景色块，直接用该类型的主题色
 * 画在节点圆心附近，配色克制、不额外占外部空间。多个特殊能力共存时按 INSIDE_BADGE_OFFSETS
 * 分槽位摆放，且字号随图标数量和节点自身大小收缩，避免在小节点里塞挤糊成一团。
 * canvas 画字形必须显式把 fontFamily 指到 FA 的 solid 字重（"Font Awesome 6 Free" + fontWeight 900），
 * 否则字体没加载完/映射不到就会退化成方块或不相关字符。
 */
function specialFlagBadges(flags: string[], nodeCount: number): NodeBadgeStyleProps[] {
  // 返工建议④：后端 specialFlags 数组按 BTreeSet 字典序排列（http_call < kafka < redis <
  // sse_publish < trigger_cron < trigger_notify）——若直接按数组原序取前 4，trigger_cron/
  // trigger_notify（boss 点名的定时/notify）会被字典序更靠前的四个挤出去、角标静默丢失。
  // 截断前先按 SPECIAL_FLAG_FILTER_ORDER（筛选器展示顺序，boss 点名的四类在前）重排。
  const active = flags
    .filter((f) => SPECIAL_FLAG_META[f])
    .sort((a, b) => SPECIAL_FLAG_FILTER_ORDER.indexOf(a) - SPECIAL_FLAG_FILTER_ORDER.indexOf(b))
    .slice(0, 4)
  if (active.length === 0) return []
  const offsets = INSIDE_BADGE_OFFSETS[active.length]
  const size = nodeVisualSize(nodeCount)
  // boss 反馈圆内图标仍偏糊——再提一档：换算比例从 /2.6 提到 /2.1(同尺寸节点图标占比
  // 进一步放大),各槽位数量对应的上限同步各加 2,下限从 8 提到 9,小节点也能看清是哪个图标。
  const baseFontSize = active.length >= 4 ? 11 : active.length === 3 ? 12 : active.length === 2 ? 13 : 15
  const fontSize = Math.max(9, Math.min(baseFontSize, Math.round(size / 2.1)))
  return active.map((f, i) => ({
    text: SPECIAL_FLAG_META[f].glyph,
    fontFamily: '"Font Awesome 6 Free"',
    fontWeight: 900,
    // 'center' 在运行时是合法值（parsePlacement 对任意字符串都按 split('-') 兜底成 [0.5,0.5]），
    // 但 NodeBadgeStyleProps 的 TS 类型只声明了 Cardinal/CornerPlacement，这里按实际能力松绑。
    placement: 'center' as any,
    offsetX: offsets[i][0] * size,
    offsetY: offsets[i][1] * size,
    fontSize,
    // 圆内图标发白看不见的根因：NodeBadgeStyleProps 继承自 @antv/g 的 TextStyleProps，
    // 文字颜色字段是 `fill`——之前写的 `textFill` 不是合法字段名，TS 用 any 松绑放过了，
    // 运行时被静默丢弃，退化成 Text 图形的默认填充色（近乎不可见）。改用正确字段名 `fill`。
    fill: SPECIAL_FLAG_META[f].color,
    // 图标本身已是饱和主题色，但节点圆填充是极浅的部门底色（如 #eef2ff）——同色系浅底上
    // 饱和色也可能偏糊，叠一层白色描边当"对比底"，不额外占用圆内空间也不需要背景色块。
    stroke: '#ffffff',
    lineWidth: 2.5,
    background: false,
  }))
}

/**
 * 配色切换器（P1 诉求⑥）五档色源。department 是现状默认；其余四档读后端 P1 补的
 * enabled/lastRunStatus/errorRate/activity 字段，跟部门/结构色完全解耦。
 */
export type ColorMode = 'department' | 'enabled' | 'status' | 'errorRate' | 'activity'

export const COLOR_MODE_META: Record<ColorMode, { label: string; icon: string }> = {
  department: { label: '服务色', icon: 'fa-diagram-project' },
  enabled: { label: '启停', icon: 'fa-power-off' },
  status: { label: '最近成败', icon: 'fa-circle-check' },
  errorRate: { label: '错误率', icon: 'fa-triangle-exclamation' },
  activity: { label: '活跃度', icon: 'fa-signal' },
}
export const COLOR_MODE_ORDER: ColorMode[] = ['department', 'enabled', 'status', 'errorRate', 'activity']

export interface NodeSwatch {
  fill: string
  stroke: string
  /** 图例圆点用（画布节点本身不改标签色，保持全局统一深灰，避免五种模式来回跳字色）。 */
  dot: string
}

// 同 DEPT_PALETTE：填充从 50 级提到 100~200 级、描边从 500 提到 600，四种状态配色模式
// 跟服务色模式统一加深，不然切换到这些模式后大规模图又会重新变淡。
const ENABLED_ON: NodeSwatch = { fill: '#a7f3d0', stroke: '#059669', dot: '#059669' }
const ENABLED_OFF: NodeSwatch = { fill: '#cbd5e1', stroke: '#475569', dot: '#475569' }

const STATUS_SUCCESS: NodeSwatch = { fill: '#a7f3d0', stroke: '#059669', dot: '#059669' }
const STATUS_FAILED: NodeSwatch = { fill: '#fecdd3', stroke: '#e11d48', dot: '#e11d48' }
const STATUS_NONE: NodeSwatch = { fill: '#cbd5e1', stroke: '#475569', dot: '#475569' }

const ACTIVITY_ACTIVE: NodeSwatch = { fill: '#bbf7d0', stroke: '#16a34a', dot: '#16a34a' }
const ACTIVITY_IDLE: NodeSwatch = { fill: '#fde68a', stroke: '#d97706', dot: '#d97706' }
const ACTIVITY_DORMANT: NodeSwatch = { fill: '#cbd5e1', stroke: '#475569', dot: '#475569' }

/** 错误率连续渐变的三个锚点（emerald→amber→red），专业刻度，避免撞色刺眼。 */
const ERROR_RATE_STOPS: [number, number, number][] = [
  [16, 185, 129], // 0.0 emerald-500
  [245, 158, 11], // 0.5 amber-500
  [239, 68, 68], // 1.0 red-500
]

function mixRgb(c1: [number, number, number], c2: [number, number, number], t: number): [number, number, number] {
  return [c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t]
}
function rgbToHex(rgb: [number, number, number]): string {
  const h = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0')
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`
}

/** 按 0~1 的错误率取渐变色：<0.5 段 emerald→amber，≥0.5 段 amber→red，均线性插值。 */
export function errorRateColor(rate: number): NodeSwatch {
  const t = Math.max(0, Math.min(1, Number.isFinite(rate) ? rate : 0))
  const [lo, hi, localT] = t <= 0.5 ? [ERROR_RATE_STOPS[0], ERROR_RATE_STOPS[1], t / 0.5] : [ERROR_RATE_STOPS[1], ERROR_RATE_STOPS[2], (t - 0.5) / 0.5]
  const strokeRgb = mixRgb(lo, hi, localT)
  const stroke = rgbToHex(strokeRgb)
  // 混白比例从 78% 降到 60%（fill 更深一档），大规模缩小截图里仍分辨得出色相；
  // 描边仍是饱和色，两者同色相不会像纯色块那样刺眼。
  const fill = rgbToHex(mixRgb([255, 255, 255], strokeRgb, 0.4))
  return { fill, stroke, dot: stroke }
}

/** 错误率图例用：0/25/50/75/100% 五档刻度色，与 errorRateColor 同一套插值，保证图例=画布同色。 */
export function errorRateLegendStops(): { pct: number; color: string }[] {
  return [0, 0.25, 0.5, 0.75, 1].map((pct) => ({ pct, color: errorRateColor(pct).stroke }))
}

/**
 * 给定色源模式 + 一条工作流的运行状态字段，算出该节点应显示的 fill/stroke。
 * department 模式直接吃 buildGraphData 已算好的部门色（deptSwatch），不重算。
 */
export function nodeSwatchForMode(
  mode: ColorMode,
  node: Pick<DependencyGraphNode, 'enabled' | 'lastRunStatus' | 'errorRate' | 'activity'>,
  deptSwatch: NodeSwatch,
): NodeSwatch {
  switch (mode) {
    case 'department':
      return deptSwatch
    case 'enabled':
      return node.enabled ? ENABLED_ON : ENABLED_OFF
    case 'status':
      return node.lastRunStatus === 'success' ? STATUS_SUCCESS : node.lastRunStatus === 'failed' ? STATUS_FAILED : STATUS_NONE
    case 'errorRate':
      return errorRateColor(node.errorRate)
    case 'activity':
      return node.activity === 'active' ? ACTIVITY_ACTIVE : node.activity === 'idle' ? ACTIVITY_IDLE : ACTIVITY_DORMANT
  }
}

/** 非服务色模式下，服务/分类 combo 卡片底色统一淡化的叠加量——让节点状态色不被服务底色盖过。 */
export const COMBO_NEUTRALIZED_OVERLAY: Record<'dept' | 'cat', { fillOpacity: number; strokeOpacity: number }> = {
  dept: { fillOpacity: 0.12, strokeOpacity: 0.25 },
  cat: { fillOpacity: 0.18, strokeOpacity: 0.2 },
}

/** 方案二·分簇方式：不分簇（纯力导自然聚团）/ 按分类（服务▸分类两级 combo，现状默认）/ 按服务（只保留服务一级 combo）。 */
export type ClusterMode = 'none' | 'category' | 'service'

export interface BuiltGraphData {
  graphData: GraphData
  /** 部门 → 该部门下工作流条数（诉求③服务体量，前端算，不必再让后端出这个数）。 */
  deptCounts: Map<string, number>
  /** 被丢弃的悬空边数（目标不在当前节点集里）。 */
  droppedEdges: number
  /**
   * combo id（服务/分类）→ 其下工作流总数。供画布层的布局 nodeSize 回调按 combo 真实体量
   * 估算占地，而不是像叶子节点那样按 nodeCount 给几十像素——那样会让"服务/分类之间"
   * 这层布局严重低估 combo 实际大小。
   */
  comboMemberCount: Map<string, number>
  /** 每个工作流节点的入边条数（被多少条边指向），供方案三·入度描边/光环编码使用。 */
  inDegree: Map<string, number>
}

/**
 * 后端契约 → G6 图数据。department/category 为空的工作流归"共享/未分类"桶，
 * 口径对齐工作流列表页（SHARED_DEPARTMENT_NAME / UNCATEGORIZED_FOLDER_NAME），不另造分组语义。
 * clusterMode 控制分组粒度（方案二）：'category'（默认，现状不变）保留服务▸分类两级 combo；
 * 'service' 只保留服务一级 combo（少一层递归布局，性能更好）；'none' 完全不建 combo，
 * 节点直接扔进纯 d3-force 让其按依赖自然聚团（枢纽居中/孤儿边缘），是性能关键路径。
 */
export function buildGraphData(
  nodes: DependencyGraphNode[],
  edges: DependencyGraphEdge[],
  clusterMode: ClusterMode = 'category',
): BuiltGraphData {
  const deptCounts = new Map<string, number>()
  const comboSeen = new Set<string>()
  const combos: ComboData[] = []
  // combo id → 其在 combos 数组里的下标，供节点循环结束、deptCounts 全部落定后回填样式
  // （combo 数量/标签依赖遍历完的最终计数，不能在首次遇到该 combo 时就地算出）。
  const comboIndexById = new Map<string, number>()
  const nodeIds = new Set<string>()
  // Hull 成员表：dept → 该服务下全部节点 id；cat combo id → { dept, cat, 该分类下全部节点 id }。
  // combo 结构仍保留（给 combo-combined 布局算坐标用），但视觉上不再画 combo 矩形卡片——
  // 改由下面按这两张表生成的 Hull 插件画有机轮廓，两者共享同一份分组事实，不会对不上。
  const deptMembers = new Map<string, string[]>()
  const catMembers = new Map<string, { dept: string; cat: string; members: string[] }>()

  // 先扫一遍拿到全部在场 department，按名称排序去重分配颜色——保证同图不撞色（见 buildDeptColorMap 注释）。
  const colorForDept = deptColorResolver(
    nodes.map((n) => (n.department || '').trim() || SHARED_DEPARTMENT_NAME),
  )

  // 方案三②入度编码：先扫一遍边算出去重后的入度，供下面逐节点算描边/光环强度——必须在节点
  // 样式循环之前算完，不能像 deptCounts 那样等循环里累加（circular：节点样式当场就要用到）。
  const inDegree = new Map<string, number>()
  {
    const seenPair = new Set<string>()
    for (const e of edges) {
      const key = `${e.from}->${e.to}`
      if (seenPair.has(key)) continue
      seenPair.add(key)
      const to = String(e.to)
      inDegree.set(to, (inDegree.get(to) ?? 0) + 1)
    }
  }
  const maxInDegree = Math.max(1, ...Array.from(inDegree.values()))

  const g6Nodes: NodeData[] = nodes.map((n) => {
    const dept = (n.department || '').trim() || SHARED_DEPARTMENT_NAME
    const cat = (n.category || '').trim() || UNCATEGORIZED_FOLDER_NAME
    deptCounts.set(dept, (deptCounts.get(dept) ?? 0) + 1)

    const dId = deptComboId(dept)
    const cId = clusterMode === 'service' ? dId : catComboId(dept, cat)
    if (clusterMode !== 'none') {
      if (!comboSeen.has(dId)) {
        comboSeen.add(dId)
        comboIndexById.set(dId, combos.length)
        combos.push({ id: dId, data: { kind: 'dept', name: dept } })
      }
      if (clusterMode === 'category' && !comboSeen.has(cId)) {
        comboSeen.add(cId)
        comboIndexById.set(cId, combos.length)
        combos.push({ id: cId, combo: dId, data: { kind: 'cat', name: cat, dept } })
      }
    }

    const id = String(n.id)
    nodeIds.add(id)
    if (!deptMembers.has(dept)) deptMembers.set(dept, [])
    deptMembers.get(dept)!.push(id)
    if (clusterMode === 'category') {
      if (!catMembers.has(cId)) catMembers.set(cId, { dept, cat, members: [] })
      catMembers.get(cId)!.members.push(id)
    }
    const color = colorForDept(dept)
    // 外部依赖节点（分类主集之外、1 跳 call_workflow 命中）：延用同一部门配色（仍能一眼看出
    // "它属于哪个服务"），但叠加虚线描边 + 降低填充不透明度 + 角标——跟 designer 已有的
    // "分类 combo 白底虚线描边"是同一套"次要/外围元素"视觉语言，不生造新样式规则。
    const externalOverlay = n.external
      ? { lineDash: [3, 2] as [number, number], fillOpacity: 0.5 }
      : {}
    const badges = specialFlagBadges(n.specialFlags, n.nodeCount)
    if (n.external) {
      badges.push({
        text: '外部',
        placement: 'top',
        fontSize: 9,
        padding: 2,
        backgroundFill: '#64748b',
        backgroundRadius: 6,
        fill: '#ffffff',
      })
    }
    // 方案三②：入度越高，描边越粗，一眼识别枢纽节点；入度 0 的节点只保留基础描边
    // （1.8px，与原先 Graph 级统一线宽等价），不产生视觉噪音。lineWidth 必须写在这里
    // （data.style）而非 Graph 级 —— 见 WorkflowGraphCanvas.tsx 里对该合并优先级的说明，
    // Graph 级会整段覆盖 data.style，这里写了那边就绝不能再统一写死 lineWidth。
    // 性能治理：原先这里还叠了 shadowColor/shadowBlur 画"光环"，300+ 节点下 canvas 阴影是
    // 头号帧率杀手（每节点一次昂贵的模糊合成，且入度>0 的节点往往不在少数）——改成单纯加粗
    // 描边这种最便宜的画法，一样能读出"越粗=越多人依赖"，只是没有发光效果。选中/hover 态
    // 的高亮环（G6 内建 halo:true state）不受影响：那是只对当前 1 个节点生效的独立形状，
    // 不是逐节点常驻的 canvas shadow，成本可忽略。
    const degree = inDegree.get(id) ?? 0
    const degreeT = Math.min(1, degree / maxInDegree)
    const haloOverlay = { lineWidth: degree > 0 ? 1.8 + degreeT * 3.4 : 1.8 }
    return {
      id,
      combo: clusterMode === 'none' ? undefined : cId,
      data: {
        slug: n.slug,
        name: n.name,
        department: n.department,
        category: n.category,
        nodeCount: n.nodeCount,
        specialFlags: n.specialFlags,
        external: n.external,
        inDegree: degree,
      },
      style: {
        size: nodeVisualSize(n.nodeCount),
        fill: color.fill,
        stroke: color.stroke,
        labelText: n.external ? `${n.name || n.slug} (外部)` : n.name || n.slug,
        labelMaxWidth: nodeLabelMaxWidth(n.nodeCount),
        badge: badges.length > 0,
        badges,
        ...haloOverlay,
        ...externalOverlay,
      },
    }
  })

  // 分组视觉改回 G6 v5 原生 combo（柔和圆角矩形背景卡片），不再叠 Hull 插件——combo 的包围盒
  // 由库按成员真实坐标自动算，节点动它跟着动，天然不会出现"节点跑出轮廓"。两级样式对比：
  // 服务(dept) 层填充更实、描边更深一档，带"名称 · 数量"标签；分类(cat) 层嵌套在服务内部，
  // 填充更浅更淡（同色但透明度更低）、描边细，只带分类名标签，读作"服务卡片里的分类子卡片"。
  // clusterMode='none' 时 combos 数组从未被填充（上面节点循环里整体跳过），下面两段循环
  // 自然空跑，不需要额外判断。
  for (const [dept, members] of Array.from(deptMembers.entries())) {
    const idx = comboIndexById.get(deptComboId(dept))
    if (idx === undefined) continue
    const color = colorForDept(dept)
    const count = deptCounts.get(dept) ?? members.length
    combos[idx] = {
      ...combos[idx],
      style: {
        fill: color.fill,
        fillOpacity: 0.55,
        stroke: color.stroke,
        strokeOpacity: 0.85,
        lineWidth: 1.5,
        labelText: `${dept} · ${count}`,
        labelFill: color.label,
        labelFontWeight: 600,
        // boss 反馈：全景缩到很小时服务名糊成一个灰点——静态字号在这里先给一个更大的基准
        // （原 13→17），配合下方 applyDegradedVisibility 里按 zoom 反向补偿的动态字号
        // （见 comboLabelBaseFontSize/effectiveComboLabelFontSize），两者共同保证任意缩放
        // 级别下服务名都读得清。
        labelFontSize: 17,
        labelPlacement: 'top',
        labelBackground: true,
        labelBackgroundFill: 'rgba(255,255,255,0.85)',
        labelBackgroundRadius: 4,
        labelPadding: [1, 5] as [number, number],
      },
    }
  }
  for (const [cId, { dept, cat, members }] of Array.from(catMembers.entries())) {
    const idx = comboIndexById.get(cId)
    if (idx === undefined) continue
    const color = colorForDept(dept)
    combos[idx] = {
      ...combos[idx],
      style: {
        // 分类子卡片比服务卡片更浅更淡：叠一层近白的填充在服务底色之上（视觉上就是"更浅一档"），
        // 描边沿用同一部门色但更细，天然读作嵌套在服务卡片内的子卡片，不需要额外配色表。
        fill: '#ffffff',
        fillOpacity: 0.55,
        stroke: color.stroke,
        strokeOpacity: 0.45,
        lineWidth: 1,
        lineDash: [4, 3] as [number, number],
        // 折叠态（P1.2 combo 折叠）需要"分类名 · N"聚合标签，与服务层同口径，未折叠时同样显示
        // 数量不额外增加视觉噪音（本就有分类名标签，多加数量是同一行的自然延伸）。
        labelText: `${cat} · ${members.length}`,
        labelFill: '#475569',
        // 分类层字号维持比服务层小一档（层级感），基准同样上调（原 11→13），动态补偿见
        // WorkflowGraphCanvas 的 applyDegradedVisibility。
        labelFontSize: 13,
        labelPlacement: 'top',
        labelBackground: true,
        labelBackgroundFill: 'rgba(255,255,255,0.75)',
        labelBackgroundRadius: 4,
        labelPadding: [1, 4] as [number, number],
      },
    }
  }

  let droppedEdges = 0
  const g6Edges: EdgeData[] = []
  // 性能二期①：曲线边（quadratic + curveOffset）改直线——边默认极淡（方案三①），曲率带来的
  // 视觉分离度在淡边状态下本就分辨不出来，却要多算一条贝塞尔曲线的路径几何，600+ 节点、
  // 上千条边时这笔几何计算是实打实的绘制开销。直线边渲染成本只是两点连线，视觉上"淡边无损"，
  // 换来的是真金白银的绘制耗时下降。
  // 方案三①：常态描边/透明度/箭头改由 WorkflowGraphCanvas.tsx 的 Graph 级 edge.style 统一
  // 控制成"极淡无箭头"，这里的 data.style 不再需要声明任何东西——stroke/opacity/lineWidth/
  // endArrow 若写在这里会被 Graph 级整段覆盖（同节点 lineWidth 那条合并优先级规则）。
  // 前端兜底去重：后端已按 (from,to) 去重，但这里仍做一层防御——即使后端将来又吐出
  // 重复边（如同一工作流多个 call_workflow 节点指向同一目标），也不能让 G6 因重复
  // edge id 报 "Edge already exists" 崩掉整个画布。
  const seenEdgeIds = new Set<string>()
  for (const e of edges) {
    const source = String(e.from)
    const target = String(e.to)
    // P0 全景视图请求整租户全量节点，理论上不该有悬空边；仍防御性丢弃，避免 G6 报错。
    if (!nodeIds.has(source) || !nodeIds.has(target)) {
      droppedEdges += 1
      continue
    }
    const edgeId = `e:${source}->${target}`
    if (seenEdgeIds.has(edgeId)) {
      continue
    }
    seenEdgeIds.add(edgeId)
    g6Edges.push({
      id: edgeId,
      source,
      target,
      style: { type: 'line' },
    })
  }

  const comboMemberCount = new Map<string, number>()
  for (const [dept, members] of Array.from(deptMembers.entries())) {
    comboMemberCount.set(deptComboId(dept), members.length)
  }
  for (const [cId, { members }] of Array.from(catMembers.entries())) {
    comboMemberCount.set(cId, members.length)
  }

  return {
    graphData: { nodes: g6Nodes, edges: g6Edges, combos },
    deptCounts,
    droppedEdges,
    comboMemberCount,
    inDegree,
  }
}

/** 邻接表：id → 出边目标集合 / 入边来源集合，供改动影响面 BFS 使用。 */
export interface Adjacency {
  out: Map<string, Set<string>>
  in: Map<string, Set<string>>
}

export function buildAdjacency(edges: DependencyGraphEdge[]): Adjacency {
  const out = new Map<string, Set<string>>()
  const inn = new Map<string, Set<string>>()
  for (const e of edges) {
    const from = String(e.from)
    const to = String(e.to)
    if (!out.has(from)) out.set(from, new Set())
    out.get(from)!.add(to)
    if (!inn.has(to)) inn.set(to, new Set())
    inn.get(to)!.add(from)
  }
  return { out, in: inn }
}

/** 从选中节点出发，BFS 求全部正向下游 + 反向上游（谁调它），不限跳数。 */
export function bfsNeighborhood(
  adjacency: Adjacency,
  selectedId: string,
): { upstream: Set<string>; downstream: Set<string> } {
  const bfs = (start: string, dir: Map<string, Set<string>>): Set<string> => {
    const visited = new Set<string>()
    const queue = [start]
    while (queue.length) {
      const cur = queue.shift()!
      for (const next of Array.from(dir.get(cur) ?? [])) {
        if (!visited.has(next)) {
          visited.add(next)
          queue.push(next)
        }
      }
    }
    return visited
  }
  return {
    downstream: bfs(selectedId, adjacency.out),
    upstream: bfs(selectedId, adjacency.in),
  }
}

/**
 * 排障逐跳（P1.3）：同 bfsNeighborhood 一样双向 BFS，但额外记录每个节点到 selectedId 的
 * 跳数（第 1 跳、第 2 跳……），供"上一跳/下一跳"按当前深度截取子集，而不是一次性全亮。
 */
export function bfsLevels(
  adjacency: Adjacency,
  selectedId: string,
): { upstream: Map<string, number>; downstream: Map<string, number>; maxDepth: number } {
  const bfs = (start: string, dir: Map<string, Set<string>>): Map<string, number> => {
    const level = new Map<string, number>()
    let frontier = [start]
    let depth = 0
    const visited = new Set<string>([start])
    while (frontier.length) {
      const next: string[] = []
      for (const cur of frontier) {
        for (const nb of Array.from(dir.get(cur) ?? [])) {
          if (!visited.has(nb)) {
            visited.add(nb)
            level.set(nb, depth + 1)
            next.push(nb)
          }
        }
      }
      frontier = next
      depth += 1
    }
    return level
  }
  const upstream = bfs(selectedId, adjacency.in)
  const downstream = bfs(selectedId, adjacency.out)
  const maxDepth = Math.max(0, ...Array.from(upstream.values()), ...Array.from(downstream.values()))
  return { upstream, downstream, maxDepth }
}

/**
 * 盘点治理过滤（P1.2）：孤儿（在当前节点集内无任何入边——没人调它）/ 无出边（不依赖任何人）。
 * 只统计当前图里在场的节点，外部依赖节点的边已在 buildAdjacency 里正常纳入。
 */
export type GovernanceFilter = 'none' | 'orphan' | 'no-outgoing'

export function governanceMatches(
  nodeIds: string[],
  adjacency: Adjacency,
  filter: GovernanceFilter,
): Set<string> {
  if (filter === 'none') return new Set()
  const matches = new Set<string>()
  for (const id of nodeIds) {
    if (filter === 'orphan' && !(adjacency.in.get(id)?.size)) matches.add(id)
    if (filter === 'no-outgoing' && !(adjacency.out.get(id)?.size)) matches.add(id)
  }
  return matches
}

/**
 * 多入口 focus（P1.3）：URL `?focus=<slug或id>` 进图时定位目标节点——先按 id 精确匹配，
 * 找不到再按 slug 匹配（两种入口形态都要支持，见 spec P1.3）。
 */
export function findNodeIdByFocus(
  nodes: DependencyGraphNode[],
  focus: string,
): string | null {
  const byId = nodes.find((n) => String(n.id) === focus)
  if (byId) return String(byId.id)
  const bySlug = nodes.find((n) => n.slug === focus)
  return bySlug ? String(bySlug.id) : null
}

/**
 * 工具栏搜索定位（大规模刚需）：输入纯数字 → 按 workflow id 精确匹配（不做子串，语义是
 * "定位到这一条"，不是模糊列举）；输入其它文本 → 按 slug + name 做大小写不敏感子串模糊匹配。
 * 结果数上限 limit，避免大图下拉框被灌爆。
 */
export function searchNodes(
  nodes: DependencyGraphNode[],
  query: string,
  limit = 30,
): DependencyGraphNode[] {
  const q = query.trim()
  if (!q) return []
  if (/^\d+$/.test(q)) {
    return nodes.filter((n) => String(n.id) === q)
  }
  const lower = q.toLowerCase()
  return nodes
    .filter((n) => n.slug.toLowerCase().includes(lower) || (n.name || '').toLowerCase().includes(lower))
    .slice(0, limit)
}

/* ------------------------------------------------------------------------------------------ *
 * 方案一·聚合视图 —— 把明细图按分类/服务压成大节点：大小=簇内工作流条数、簇间边=跨簇
 * call_workflow 调用聚合（边粗细/标签=调用条数）。聚合节点仅几十个，用不到 combo-combined
 * 三层递归，画布层对聚合图走一套更简单的纯 d3-force 布局（见 WorkflowGraphCanvas.tsx）。
 * ------------------------------------------------------------------------------------------ */

/** 聚合级别：按服务（department）还是按分类（department+category）压缩。 */
export type AggregationLevel = 'service' | 'category'

export const AGG_SVC_PREFIX = 'agg-svc::'
export const AGG_CAT_PREFIX = 'agg-cat::'

export interface AggregatedClusterMeta {
  id: string
  level: AggregationLevel
  department: string
  category?: string
  /** 簇内工作流条数——聚合节点大小与该数字挂钩。 */
  count: number
  /** 簇内全部工作流 id，供点击下钻时按成员切出明细子图（sliceClusterForDrilldown）。 */
  members: string[]
}

export interface AggregatedGraphData {
  graphData: GraphData
  clusters: Map<string, AggregatedClusterMeta>
}

/**
 * 聚合簇标签文案：level='service' 只显示部门名，'category' 显示"部门 · 分类"，统一带条数后缀。
 * 单独抽出来是因为画布层算力导 collide/斥力/连线距离时（WorkflowGraphCanvas.tsx）要按这份
 * 文案的真实渲染宽度算节点占地，必须跟这里建 label 时用同一份逻辑，不能各写一份公式走偏
 * （这正是真数据 20+ 分类下标签互压/圆圈重叠的根因——原先画布层的力导完全没算过标签宽度）。
 */
export function aggClusterLabelText(level: AggregationLevel, department: string, category: string | undefined, count: number): string {
  const label = level === 'service' ? department : `${department} · ${category}`
  return `${label} · ${count}`
}

/** 聚合簇标签字号：条数越多字号略增，封顶 20px，跟节点大小的幂律节奏呼应，不单独定义新曲线。 */
export function aggClusterLabelFontSize(count: number): number {
  return Math.min(20, 13 + Math.sqrt(count) * 1.4)
}

/**
 * 聚合簇标签最多显示的宽度——真数据 20+ 分类下反馈"部门·分类"这类长文案被截断成"…"看不出
 * 是哪个分类。聚合视图节点总数就几十个（不像明细节点上百），不需要像 nodeLabelMaxWidth 那样
 * 为了防挤爆而收窄，放宽到 200px + 最多两行，尽量显示完整文案。
 */
export const AGG_LABEL_MAX_WIDTH = 200

/**
 * 明细节点/边 → 聚合图。level='service' 时每个部门一个大节点；level='category' 时
 * 部门+分类一个大节点。簇间边只统计"跨簇"的 call_workflow 调用（簇内调用属于该簇内部
 * 编排细节，聚合视图不关心），按 (源簇,目标簇) 去重计数——计数即为该方向上有多少条不同的
 * 工作流间调用关系，用作边粗细/标签。
 */
export function buildAggregatedGraphData(
  nodes: DependencyGraphNode[],
  edges: DependencyGraphEdge[],
  level: AggregationLevel,
): AggregatedGraphData {
  const clusters = new Map<string, AggregatedClusterMeta>()
  const clusterOfNode = new Map<string, string>()

  for (const n of nodes) {
    const dept = (n.department || '').trim() || SHARED_DEPARTMENT_NAME
    const cat = (n.category || '').trim() || UNCATEGORIZED_FOLDER_NAME
    const id = level === 'service' ? `${AGG_SVC_PREFIX}${dept}` : `${AGG_CAT_PREFIX}${dept}::${cat}`
    clusterOfNode.set(String(n.id), id)
    const existing = clusters.get(id)
    if (existing) {
      existing.count += 1
      existing.members.push(String(n.id))
    } else {
      clusters.set(id, {
        id,
        level,
        department: dept,
        category: level === 'category' ? cat : undefined,
        count: 1,
        members: [String(n.id)],
      })
    }
  }

  const colorForDept = deptColorResolver(nodes.map((n) => (n.department || '').trim() || SHARED_DEPARTMENT_NAME))

  const g6Nodes: NodeData[] = Array.from(clusters.values()).map((c) => {
    const color = colorForDept(c.department)
    return {
      id: c.id,
      data: { kind: 'cluster', level: c.level, department: c.department, category: c.category, count: c.count },
      style: {
        // 簇节点大小直接复用 nodeVisualSize 的幂律曲线（同一套"数量→大小"手感），簇体量
        // 天然比单条工作流大一截，乘 3 放大系数拉开与明细节点的量级差异。
        size: nodeVisualSize(c.count * 3),
        fill: color.fill,
        stroke: color.stroke,
        lineWidth: 2.5,
        labelText: aggClusterLabelText(c.level, c.department, c.category, c.count),
        labelPlacement: 'center',
        labelFontSize: aggClusterLabelFontSize(c.count),
        labelFontWeight: 700,
        labelFill: color.label,
        labelWordWrap: true,
        labelMaxWidth: AGG_LABEL_MAX_WIDTH,
        labelMaxLines: 2,
        labelTextOverflow: 'ellipsis',
        opacity: 1,
      },
    }
  })

  // 簇间边聚合：按 (源簇,目标簇) 去重计数，源明细边先按 (from,to) 去重一次，避免重复
  // call_workflow 节点把计数灌水。
  const edgeCount = new Map<string, { source: string; target: string; count: number }>()
  const seenRaw = new Set<string>()
  for (const e of edges) {
    const rawKey = `${e.from}->${e.to}`
    if (seenRaw.has(rawKey)) continue
    seenRaw.add(rawKey)
    const s = clusterOfNode.get(String(e.from))
    const t = clusterOfNode.get(String(e.to))
    if (!s || !t || s === t) continue
    const key = `${s}=>${t}`
    const cur = edgeCount.get(key)
    if (cur) cur.count += 1
    else edgeCount.set(key, { source: s, target: t, count: 1 })
  }
  const maxCount = Math.max(1, ...Array.from(edgeCount.values()).map((e) => e.count))
  // 聚合视图降噪返工（boss 复测：22 分类 ×111 边时旧样式是"毛线球"，边墨水量压倒节点）：
  // ① 边宽上限 12px→6px、默认态透明度压到 0.25~0.5——边是背景信息，结构主体是簇节点；
  // ② count=1 的边不打数字标签（一屏"1"是纯噪音），count 细节靠 hover 聚焦时读；
  // ③ 弧线只留给"双向对"（A→B 与 B→A 同时存在时对拉分开避免重叠），单向边一律直线——
  //    旧版按 index 奇偶随机给弧度，直线更贴合分层布局的"上游→下游"阅读方向。
  const g6Edges: EdgeData[] = Array.from(edgeCount.entries()).map(([key, e]) => {
    const t = Math.min(1, e.count / maxCount)
    const hasReverse = edgeCount.has(`${e.target}=>${e.source}`)
    return {
      id: `agg-edge:${key}`,
      source: e.source,
      target: e.target,
      style: {
        ...(hasReverse ? { type: 'quadratic', curveOffset: 24 } : { type: 'line' }),
        stroke: '#94a3b8',
        opacity: 0.25 + t * 0.25,
        lineWidth: 1.2 + t * 4.8,
        endArrow: true,
        endArrowType: 'triangle',
        endArrowSize: 7 + t * 3,
        ...(e.count > 1
          ? {
              labelText: String(e.count),
              labelFontSize: 10,
              labelFontWeight: 600,
              labelFill: '#64748b',
              labelBackground: true,
              labelBackgroundFill: 'rgba(255,255,255,0.9)',
              labelBackgroundRadius: 4,
              labelPadding: [1, 4] as [number, number],
            }
          : {}),
      },
    }
  })

  return { graphData: { nodes: g6Nodes, edges: g6Edges }, clusters }
}

/**
 * 下钻切片：给定聚合簇的成员工作流 id 集合，从全量明细节点/边里切出"该簇本身 + 1 跳外部依赖"
 * 子图——外部依赖节点标记 external:true（复用 buildGraphData 已有的虚线描边/角标视觉语言，
 * 不生造新样式规则），边只保留两端都在保留节点集内的。切出来的结果可以直接喂给 buildGraphData。
 */
export function sliceClusterForDrilldown(
  nodes: DependencyGraphNode[],
  edges: DependencyGraphEdge[],
  memberIds: Set<string>,
): { nodes: DependencyGraphNode[]; edges: DependencyGraphEdge[] } {
  const neighborIds = new Set<string>()
  for (const e of edges) {
    const from = String(e.from)
    const to = String(e.to)
    if (memberIds.has(from) && !memberIds.has(to)) neighborIds.add(to)
    if (memberIds.has(to) && !memberIds.has(from)) neighborIds.add(from)
  }
  const keepIds = new Set<string>([...Array.from(memberIds), ...Array.from(neighborIds)])
  const slicedNodes = nodes
    .filter((n) => keepIds.has(String(n.id)))
    .map((n) => (memberIds.has(String(n.id)) ? n : { ...n, external: true }))
  const slicedEdges = edges.filter((e) => keepIds.has(String(e.from)) && keepIds.has(String(e.to)))
  return { nodes: slicedNodes, edges: slicedEdges }
}

/* ------------------------------------------------------------------------------------------ *
 * 方案三③·侧栏排行榜 —— 被依赖最多 / 依赖别人最多 / 最臃肿，三个 Top10。
 * ------------------------------------------------------------------------------------------ */

export interface RankingEntry {
  id: string
  label: string
  value: number
}

export interface Rankings {
  mostDependedOn: RankingEntry[]
  mostDependencies: RankingEntry[]
  bulkiest: RankingEntry[]
}

/** 三个 Top10 榜单：被依赖最多(入度)/依赖别人最多(出度)/最臃肿(内部节点数)，值为 0 的不上榜。 */
export function topRankings(nodes: DependencyGraphNode[], adjacency: Adjacency, limit = 10): Rankings {
  const rank = (value: (n: DependencyGraphNode) => number) =>
    nodes
      .map((n) => ({ id: String(n.id), label: n.name || n.slug, value: value(n) }))
      .filter((e) => e.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, limit)
  return {
    mostDependedOn: rank((n) => adjacency.in.get(String(n.id))?.size ?? 0),
    mostDependencies: rank((n) => adjacency.out.get(String(n.id))?.size ?? 0),
    bulkiest: rank((n) => n.nodeCount),
  }
}

// 方案三④原有的"缩放层级低于阈值全局隐藏标签"规则已废弃（拖拽帧率预研③）：静止时名字应当
// 常显，密集靠 labelMaxWidth/labelMaxLines/省略号降级，不该靠整体消失解决可读性问题；交互中的
// 标签降级改用 WorkflowGraphCanvas.tsx 里"视口内 + 高入度枢纽节点保留、其余临时隐藏"的精细化
// 策略，不再是全局按缩放级别一刀切。
