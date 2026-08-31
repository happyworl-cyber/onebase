import type { EdgeData, GraphData, NodeBadgeStyleProps, NodeData } from '@antv/g6'
import type { WorkflowEdgeDef, WorkflowNodeDef } from '@/components/workflow/WorkflowCanvas'
import type { ReplayNodeResult } from './replayApi'

/**
 * 特殊节点角标（回放图专用）——比依赖图的 SPECIAL_FLAG_META 多一个 call_workflow
 * （回放场景关心"这一跳调了别的工作流"，依赖图那边 call_workflow 是拿去算依赖边而非角标，
 * 两处语义不同，不能共用同一张表）。图标语言仍对齐 Font Awesome 6 Free solid。
 */
export const REPLAY_SPECIAL_META: Record<string, { label: string; glyph: string; color: string }> = {
  redis: { label: 'Redis', glyph: '', color: '#f43f5e' },
  kafka: { label: 'Kafka', glyph: '', color: '#10b981' },
  sse_publish: { label: 'SSE', glyph: '', color: '#6366f1' },
  http_call: { label: 'HTTP', glyph: '', color: '#0ea5e9' },
  call_workflow: { label: '子流程', glyph: '', color: '#a855f7' },
}

/**
 * 特殊节点角标对应的中文语义一句话——侧栏"标记说明"用，别让人对着图标猜这个角标是干嘛的。
 * key 集合与 REPLAY_SPECIAL_META 一致。
 */
export const REPLAY_SPECIAL_DESCRIPTION: Record<string, string> = {
  redis: 'Redis 缓存读写操作',
  kafka: 'Kafka 消息发送',
  sse_publish: 'SSE 前端实时推送',
  http_call: 'HTTP 外部接口调用',
  call_workflow: '调用子工作流',
}

/** 节点执行状态 → 描边/填充色，与 WorkflowsManager 的 STATUS_COLORS 语义对齐（success/failed/failed_allowed/skipped）。 */
const STATUS_SWATCH: Record<string, { fill: string; stroke: string }> = {
  success: { fill: '#d1fae5', stroke: '#059669' },
  failed: { fill: '#fecdd3', stroke: '#e11d48' },
  failed_allowed: { fill: '#fef3c7', stroke: '#d97706' },
  skipped: { fill: '#f1f5f9', stroke: '#94a3b8' },
  /** 该运行压根没走到的节点——不是"跳过"（skipped 是引擎判定过的），是回放图自己的兜底态。 */
  unvisited: { fill: '#f8fafc', stroke: '#cbd5e1' },
}

/** 空响应专用琥珀色——与失败红/跳过灰/成功绿都不同，避免与既有状态色混淆。 */
const EMPTY_RESPONSE_AMBER = '#d97706'

/**
 * 值是否为「空」：null/undefined、空串（trim 后）、空数组、空对象。数字 0/布尔 false 不算空。
 * 导出给侧栏入参/出参快照复用，判空口径必须与图上空响应角标保持一致。
 */
export function isEmptyValue(v: unknown): boolean {
  if (v == null) return true
  if (typeof v === 'string') return v.trim() === ''
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') return Object.keys(v as Record<string, unknown>).length === 0
  return false
}

/**
 * 空响应判定规则表：按节点类型 → 判定函数，命中返回人话原因、未命中返回 null，一行一种类型，
 * 判据依据各节点真实 output 结构（对照 src/workflow_engine.rs 各 exec_*_node 的返回值，非臆测字段名）。
 * 未在表中的类型（condition/code/response/...）走 emptyResponseReason 里的通用兜底判定。
 */
const EMPTY_RESPONSE_RULES: Record<string, (output: any) => string | null> = {
  // http_call 输出 { status, headers, body }：204 无内容，或响应体为空
  http_call: (o) => {
    if (o?.status === 204) return 'HTTP 响应状态码 204（无内容）'
    if (isEmptyValue(o?.body)) return `HTTP 响应状态码 ${o?.status ?? '?'}，但响应体为空`
    return null
  },
  // db_query 输出 { rows, count }：查询命中 0 行
  db_query: (o) => (o?.count === 0 ? '查询命中 0 行' : null),
  // db_execute 输出 { rows_affected }：写入未影响任何行（如 WHERE 条件未匹配到记录）
  db_execute: (o) => (o?.rows_affected === 0 ? '写入未影响任何行（rows_affected=0）' : null),
  // db_transaction/foreach 同为批量写库节点，输出同样带 rows_affected
  db_transaction: (o) => (o?.rows_affected === 0 ? '写入未影响任何行（rows_affected=0）' : null),
  foreach: (o) => (o?.rows_affected === 0 ? '写入未影响任何行（rows_affected=0）' : null),
  // call_workflow 输出为子流程 response 节点的 { status_code, body, headers }；
  // 子流程没有任何 response 被执行到时会退化成 { nodes: {...} } 兜底形态，此时不判空（语义不同）。
  call_workflow: (o) =>
    o != null && typeof o === 'object' && 'body' in o && isEmptyValue((o as any).body)
      ? '子工作流返回的 body 为空'
      : null,
  // kafka/redis 输出 { op, result }：result 为空即视为没有 ack/返回值（含 dry_run 场景本就未真正投递）
  kafka: (o) => (o?.result == null ? 'Kafka 命令未返回 result（无 ack）' : null),
  redis: (o) => (o?.result == null ? 'Redis 命令未返回 result' : null),
  // sse_publish 输出 { topic, event, delivered }：投递数为 0，没有任何订阅端收到
  sse_publish: (o) => (o?.delivered === 0 ? '推送 delivered=0，没有订阅端收到' : null),
}

/**
 * 空响应命中的具体原因（人话一句），供侧栏"标记说明"展示——不只是"是不是空"，
 * 还要说清"哪条规则判的"。只在 status===success 时才有意义（failed/skipped 已经有明确的
 * 红/灰视觉，不需要再叠一层空响应判定）。命中专用规则时不再回退通用兜底，避免误判。
 */
export function emptyResponseReason(nodeType: string | null | undefined, status: string, output: unknown): string | null {
  if (status !== 'success') return null
  const rule = nodeType ? EMPTY_RESPONSE_RULES[nodeType] : undefined
  if (rule) {
    try {
      return rule(output)
    } catch {
      return null // 规则函数访问了非预期结构，视为未命中而不是让判定崩掉
    }
  }
  return isEmptyValue(output) ? '输出为空（null / 空对象 / 空数组 / 空串）' : null
}

/** 判定「连接通、不报错、但没拿到数据」的静默空响应——判据见 emptyResponseReason。 */
export function isEmptyResponseNode(nodeType: string | null | undefined, status: string, output: unknown): boolean {
  return emptyResponseReason(nodeType, status, output) != null
}

/**
 * 耗时热力绝对毫秒阈值锚点（boss 拍板：≥1s 一律红，不再按本次运行相对最慢归一化——
 * 同一运行里最慢的节点哪怕只有 80ms 也不该染红，热力要能跨运行横向比较绝对快慢）。
 */
const HEAT_GREEN: [number, number, number] = [5, 150, 105] // #059669，<=100ms
const HEAT_AMBER: [number, number, number] = [217, 119, 6] // #d97706，500ms 附近
const HEAT_RED: [number, number, number] = [225, 29, 72] // #e11d48，>=1000ms 封顶

function mixRgb(c1: [number, number, number], c2: [number, number, number], t: number): [number, number, number] {
  return [c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t]
}
function rgbToHex(rgb: [number, number, number]): string {
  const h = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0')
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`
}

/**
 * 按绝对毫秒数算热力色：≤100ms 绿，100~500ms 绿→琥珀，500~1000ms 琥珀→红，≥1000ms 封顶红。
 */
export function heatColorForElapsedMs(elapsedMs: number): string {
  if (elapsedMs <= 100) return rgbToHex(HEAT_GREEN)
  if (elapsedMs >= 1000) return rgbToHex(HEAT_RED)
  if (elapsedMs <= 500) return rgbToHex(mixRgb(HEAT_GREEN, HEAT_AMBER, (elapsedMs - 100) / 400))
  return rgbToHex(mixRgb(HEAT_AMBER, HEAT_RED, (elapsedMs - 500) / 500))
}

function specialBadges(nodeType: string | undefined): NodeBadgeStyleProps[] {
  const meta = nodeType ? REPLAY_SPECIAL_META[nodeType] : undefined
  if (!meta) return []
  return [
    {
      text: meta.glyph,
      fontFamily: '"Font Awesome 6 Free"',
      fontWeight: 900,
      placement: 'right-top' as any,
      fontSize: 11,
      fill: '#ffffff',
      backgroundFill: meta.color,
      backgroundRadius: 6,
      padding: [2, 3] as [number, number],
    },
  ]
}

/** 耗时徽标文案：<1s 显示毫秒，否则显示 1 位小数的秒。 */
function formatElapsedBadge(elapsedMs: number): string {
  return elapsedMs < 1000 ? `${elapsedMs}ms` : `${(elapsedMs / 1000).toFixed(1)}s`
}

/**
 * 耗时徽标（回放图专用）——放节点左下角，比 tooltip 常显、比热力色更直读。
 * 放左下角而非正下方：节点下方已被节点名 label 占用，corner 角标不与其叠字。
 * 只给"执行过"的节点显示（success/failed/failed_allowed）；skipped 后端 elapsed_ms 恒为 0
 * 无参考意义、unvisited 本就淡出，两者都不显示，避免图上到处都是徽标。
 */
function elapsedBadge(status: string, elapsedMs: number | null, strokeColor: string): NodeBadgeStyleProps[] {
  if (elapsedMs == null || elapsedMs <= 0) return []
  if (status !== 'success' && status !== 'failed' && status !== 'failed_allowed') return []
  return [
    {
      text: formatElapsedBadge(elapsedMs),
      placement: 'left-bottom' as any,
      fontSize: 10,
      fontWeight: 600,
      fill: '#ffffff',
      backgroundFill: strokeColor,
      backgroundRadius: 5,
      padding: [1, 4] as [number, number],
    },
  ]
}

export interface ConfigHighlight {
  label: string
  value: string
}

/** 值截断展示，避免长 JSON/SQL 把详情面板撑爆。 */
function truncate(v: unknown, max = 160): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  if (s == null) return ''
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * 节点配置关键字段摘要（回放侧栏用）——按节点类型挑最常需要一眼看到的字段，
 * 而不是让人展开完整 JSON 去找。字段结构对齐 node_spec；未识别的类型/字段
 * 交给调用方兜底展示完整 config JSON，这里不用为全部 15 种类型逐一穷举。
 */
export function nodeConfigHighlights(nodeType: string, config: unknown): ConfigHighlight[] {
  if (!config || typeof config !== 'object') return []
  const c = config as Record<string, any>
  const out: ConfigHighlight[] = []
  const push = (label: string, value: unknown) => {
    if (value == null || value === '') return
    out.push({ label, value: truncate(value) })
  }
  switch (nodeType) {
    case 'redis':
      push('操作', c.op)
      push('连接', c.connection_id)
      push('Key', c.key)
      push('Field', c.field)
      push('Value', c.value ?? c.values ?? c.members)
      push('TTL', c.ttl)
      break
    case 'kafka':
      push('Topic', c.topic)
      push('Key', c.key)
      push('Value', c.value)
      push('连接', c.connection_id)
      break
    case 'http_call':
      push('请求', c.method && c.url ? `${c.method} ${c.url}` : c.url)
      push('Headers', c.headers)
      push('Body', c.body)
      break
    case 'call_workflow':
      push('目标工作流', c.workflow)
      push('Input', c.input)
      push('失败可容错', c.allow_failure === true ? '是' : c.allow_failure === false ? '否' : null)
      break
    case 'db_query':
    case 'db_execute':
      push('SQL', c.sql)
      push('参数', c.params)
      push('数据源', c.datasource_id)
      break
    case 'db_transaction':
    case 'foreach':
      push('SQL', Array.isArray(c.statements) ? c.statements.map((s: any) => s?.sql).filter(Boolean).join(' ; ') : null)
      push('数据源', c.datasource_id)
      break
    case 'condition':
      push(
        '分支条件',
        Array.isArray(c.conditions)
          ? c.conditions.map((cond: any) => `${cond?.branch}: ${cond?.expression}`).join(' / ')
          : null,
      )
      push('默认分支', c.default_branch)
      break
    case 'response':
      push('状态码', c.status_code)
      push('Body', c.body)
      break
    case 'sse_publish':
      push('Topic', c.topic)
      push('事件', c.event)
      break
    case 'email_send':
      push('收件人', c.to)
      push('主题', c.subject)
      break
    case 'code':
      push('语言', c.language || 'lua')
      break
    case 'loop':
      push('模式', c.loop_mode)
      push('表达式/次数/数组', c.expression ?? c.count ?? c.items)
      break
    case 'object_storage':
      push('操作', c.op)
      push('Key', c.key ?? c.prefix)
      break
    default:
      break
  }
  return out
}

/**
 * 空响应角标——放左上角（右上角已被特殊节点类型占用、左下角已被耗时徽标占用）。
 * 用 Font Awesome 的 triangle-exclamation（），琥珀底与 REPLAY_SPECIAL_META 的配色区分开。
 */
function emptyResponseBadge(): NodeBadgeStyleProps[] {
  return [
    {
      text: '',
      fontFamily: '"Font Awesome 6 Free"',
      fontWeight: 900,
      placement: 'top-left' as any,
      fontSize: 11,
      fill: '#ffffff',
      backgroundFill: EMPTY_RESPONSE_AMBER,
      backgroundRadius: 6,
      padding: [2, 3] as [number, number],
    },
  ]
}

export interface ReplayBuiltGraph {
  graphData: GraphData
  /** 走过（有 node_result 且非 unvisited）的节点 id 集合——供图例/统计用。 */
  visitedNodeIds: Set<string>
  /** 本次运行里判定为「空响应」的节点 id 列表——供总览统计/逐个聚焦用。 */
  emptyResponseNodeIds: string[]
}

/**
 * 工作流结构 + 单次运行 node_results → G6 图数据。
 * 未被 run 记录到的节点/边（该次运行没走到）显式给 unvisited 状态，视觉上淡出而不是删除——
 * 保留完整拓扑让人看清"这条路径为什么没走"，而不是回放一次就把图砍得只剩执行子集。
 */
export function buildReplayGraphData(
  nodes: WorkflowNodeDef[],
  edges: WorkflowEdgeDef[],
  nodeResults: ReplayNodeResult[],
): ReplayBuiltGraph {
  const resultByNodeId = new Map<string, ReplayNodeResult>()
  for (const r of nodeResults) resultByNodeId.set(r.node_id, r)

  const visitedNodeIds = new Set<string>(
    nodeResults.filter((r) => r.status !== 'skipped').map((r) => r.node_id),
  )
  const emptyResponseNodeIds: string[] = []
  const g6Nodes: NodeData[] = nodes.map((n) => {
    const result = resultByNodeId.get(n.id)
    const status = result ? result.status : 'unvisited'
    const swatch = STATUS_SWATCH[status] ?? STATUS_SWATCH.unvisited
    const elapsed = result?.elapsed_ms ?? null
    // 热力只染 success 且 elapsed>0 的节点；failed/failed_allowed/skipped 必须保留状态描边
    // （红/灰框是"一眼看出卡在哪出错"的信号，不能被热力色覆盖——即使失败节点跑得很快也要红框）。
    const heat = status === 'success' && elapsed != null && elapsed > 0 ? heatColorForElapsedMs(elapsed) : null
    const stroke = heat ?? swatch.stroke
    const isEmptyResponse = isEmptyResponseNode(result?.node_type ?? n.type, status, result?.output)
    if (isEmptyResponse) emptyResponseNodeIds.push(n.id)
    // label 下方已占用给节点名，耗时徽标再往下让一档，避免和节点名重叠。
    const badges = [
      ...specialBadges(n.type),
      ...elapsedBadge(status, elapsed, stroke),
      ...(isEmptyResponse ? emptyResponseBadge() : []),
    ]
    return {
      id: n.id,
      data: {
        label: n.label || n.id,
        nodeType: n.type,
        status,
        elapsedMs: elapsed,
        error: result?.error ?? null,
        branch: result?.branch ?? null,
        emptyResponse: isEmptyResponse,
      },
      style: {
        size: 44,
        fill: swatch.fill,
        stroke,
        lineWidth: status === 'unvisited' ? 1.2 : 2.2,
        // 真数据踩坑：0.35 的未走到淡出叠在白底上约等于隐形，未走到的分支一"消失"，
        // 剩下的执行路径看起来像凭空断开（boss 截图坐实）。提到 0.55——仍明显弱于
        // 执行路径，但拓扑连通性肉眼可辨，"没走到"读作"淡"而不是"没有"。
        opacity: status === 'unvisited' ? 0.55 : 1,
        labelText: n.label || n.id,
        labelPlacement: 'bottom',
        labelOffsetY: 6,
        labelFontSize: 12,
        labelFill: status === 'unvisited' ? '#94a3b8' : '#334155',
        labelBackground: true,
        labelBackgroundFill: 'rgba(255,255,255,0.88)',
        labelBackgroundRadius: 4,
        labelPadding: [1, 5] as [number, number],
        // 真数据修复：labelMaxWidth 不配 labelWordWrap 在 G6 v5 里不生效——长节点名会原样
        // 单行铺开，相邻节点的名字连成一片互相压字。开换行 + 两行封顶 + 省略号截断，
        // 完整名字靠 hover tooltip 兜底（tooltip 一直显示全名，信息不丢）。
        labelMaxWidth: 96,
        labelWordWrap: true,
        labelMaxLines: 2,
        labelTextOverflow: 'ellipsis',
        badge: badges.length > 0,
        badges,
        // 空响应琥珀色空心环：与选中态的品牌紫 halo（14px）区分开，用更窄的圈层叠加在描边外，
        // 不遮挡状态色描边本身——两者叠加时（选中+空响应）选中态会覆盖这层，靠角标兜底不丢信息。
        ...(isEmptyResponse
          ? { halo: true, haloStroke: EMPTY_RESPONSE_AMBER, haloLineWidth: 6, haloOpacity: 0.5 }
          : {}),
      },
    }
  })

  // condition 节点的多条出边按 edge.branch 是否等于该节点 node_result.branch 判定"是否被实际选中"；
  // 非 condition 节点的出边只要两端都在 visited 集合里即视为走过。
  const g6Edges: EdgeData[] = edges.map((e, idx) => {
    const sourceResult = resultByNodeId.get(e.from)
    const targetVisited = visitedNodeIds.has(e.to)
    const sourceVisited = visitedNodeIds.has(e.from)
    const isConditionEdge = e.branch != null && e.branch !== ''
    const walked = isConditionEdge
      ? sourceResult?.branch != null && sourceResult.branch === e.branch && targetVisited
      : sourceVisited && targetVisited
    return {
      id: `re:${e.from}->${e.to}:${idx}`,
      source: e.from,
      target: e.to,
      data: { branch: e.branch ?? null, walked },
      // 曾经用自定义 replay-flow-edge 边类型叠加飞行光点（fly-marker），boss 拍板去掉——
      // 执行方向靠 endArrow 箭头表达即可，回退成 G6 内置 line 边，不再需要自定义边类型。
      type: 'line',
      style: {
        // 未走过的边同步提可见度（理由见节点侧 opacity 注释）：描边加深一档 + 透明度提到
        // 0.5，白底上能看出"这里有条没走的路"，与紫色虚线执行路径仍一眼可分。
        stroke: walked ? '#4f46e5' : '#94a3b8',
        lineWidth: walked ? 2.4 : 1.2,
        opacity: walked ? 1 : 0.5,
        endArrow: true,
        endArrowType: 'triangle',
        endArrowSize: 10,
        labelText: e.branch || undefined,
        labelFontSize: 10,
        labelFill: walked ? '#4338ca' : '#94a3b8',
        lineDash: walked ? [6, 4] : undefined,
      },
    }
  })

  return { graphData: { nodes: g6Nodes, edges: g6Edges }, visitedNodeIds, emptyResponseNodeIds }
}
