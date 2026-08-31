import type {
  DependencyGraphResponse,
  DependencyGraphNode,
  DependencyGraphEdge,
} from '@/components/workflow/graph/graphApi'

/**
 * 本地 dev 预览页专用的内置 mock 数据 —— 不接后端，纯前端常量。
 * 覆盖已实现的全部能力：多 department▸category combo 嵌套、节点大小随 nodeCount、
 * SSE/Kafka/Redis/HTTP 四种特殊标记、call_workflow 依赖边（含跨 combo 长边）、
 * external:true 外部依赖节点（分类 scope 视图专用）。
 */

/** "全量" fixture：不带 scope 时的全景视图，5 个 department、8 个 category、18 个工作流节点。 */
export const FULL_FIXTURE: DependencyGraphResponse = {
  unresolved: 1,
  nodes: [
    { id: 1, slug: 'order-create', name: '创建订单', department: '订单服务', category: '支付', nodeCount: 8, specialFlags: [], external: false, enabled: true, lastRunStatus: 'success', errorRate: 0.02, activity: 'active' },
    { id: 2, slug: 'order-pay', name: '订单支付', department: '订单服务', category: '支付', nodeCount: 14, specialFlags: ['http_call'], external: false, enabled: true, lastRunStatus: 'success', errorRate: 0.08, activity: 'active' },
    { id: 3, slug: 'order-pay-callback', name: '支付回调', department: '订单服务', category: '支付', nodeCount: 6, specialFlags: ['http_call'], external: false, enabled: true, lastRunStatus: 'failed', errorRate: 0.35, activity: 'active' },
    { id: 4, slug: 'order-refund', name: '发起退款', department: '订单服务', category: '退款', nodeCount: 5, specialFlags: [], external: false, enabled: true, lastRunStatus: 'success', errorRate: 0.0, activity: 'idle' },
    { id: 5, slug: 'order-refund-audit', name: '退款审核', department: '订单服务', category: '退款', nodeCount: 3, specialFlags: [], external: false, enabled: false, lastRunStatus: 'none', errorRate: 0.0, activity: 'dormant' },
    { id: 6, slug: 'user-login', name: '用户登录', department: '用户服务', category: '账户', nodeCount: 10, specialFlags: ['redis'], external: false, enabled: true, lastRunStatus: 'success', errorRate: 0.01, activity: 'active' },
    { id: 7, slug: 'user-profile', name: '用户资料', department: '用户服务', category: '账户', nodeCount: 4, specialFlags: [], external: false, enabled: true, lastRunStatus: 'none', errorRate: 0.0, activity: 'dormant' },
    { id: 8, slug: 'user-bind-phone', name: '绑定手机号', department: '用户服务', category: '账户', nodeCount: 7, specialFlags: [], external: false, enabled: true, lastRunStatus: 'failed', errorRate: 0.6, activity: 'idle' },
    { id: 9, slug: 'notify-order', name: '订单通知', department: '用户服务', category: '通知', nodeCount: 12, specialFlags: ['sse_publish', 'kafka'], external: false, enabled: true, lastRunStatus: 'success', errorRate: 0.12, activity: 'active' },
    { id: 10, slug: 'notify-refund', name: '退款通知', department: '用户服务', category: '通知', nodeCount: 6, specialFlags: ['sse_publish'], external: false, enabled: false, lastRunStatus: 'none', errorRate: 0.0, activity: 'dormant' },
    { id: 11, slug: 'notify-digest', name: '通知摘要', department: '用户服务', category: '通知', nodeCount: 40, specialFlags: ['kafka'], external: false, enabled: true, lastRunStatus: 'failed', errorRate: 0.9, activity: 'idle' },
    { id: 12, slug: 'shared-log', name: '共享审计日志', department: '', category: '', nodeCount: 2, specialFlags: [], external: false, enabled: true, lastRunStatus: 'success', errorRate: 0.0, activity: 'active' },
    { id: 13, slug: 'shared-cleanup', name: '共享清理任务', department: '', category: '', nodeCount: 3, specialFlags: ['redis'], external: false, enabled: true, lastRunStatus: 'none', errorRate: 0.0, activity: 'idle' },
    { id: 14, slug: 'gw-route', name: '网关路由分发', department: '网关', category: '路由', nodeCount: 9, specialFlags: ['http_call'], external: false, enabled: true, lastRunStatus: 'success', errorRate: 0.05, activity: 'active' },
    { id: 15, slug: 'gw-ratelimit', name: '限流校验', department: '网关', category: '路由', nodeCount: 5, specialFlags: ['redis', 'http_call'], external: false, enabled: true, lastRunStatus: 'failed', errorRate: 0.45, activity: 'active' },
    { id: 16, slug: 'risk-check', name: '风控检查', department: '风控服务', category: '规则', nodeCount: 5, specialFlags: ['redis'], external: false, enabled: true, lastRunStatus: 'success', errorRate: 0.0, activity: 'idle' },
    { id: 17, slug: 'risk-blacklist-sync', name: '黑名单同步', department: '风控服务', category: '规则', nodeCount: 11, specialFlags: ['kafka'], external: false, enabled: false, lastRunStatus: 'failed', errorRate: 0.7, activity: 'dormant' },
    { id: 18, slug: 'risk-report', name: '风控报表', department: '风控服务', category: '报表', nodeCount: 16, specialFlags: ['sse_publish', 'http_call'], external: false, enabled: true, lastRunStatus: 'none', errorRate: 0.0, activity: 'dormant' },
  ],
  edges: [
    { from: 15, to: 14 },
    { from: 14, to: 1 },
    { from: 1, to: 2 },
    // 重复边用例：模拟工作流 1 里有两个 call_workflow 节点各自调用同一目标 2
    // （后端修复前会重复吐出这条 (from,to)，导致 G6 报 "Edge already exists"）。
    { from: 1, to: 2 },
    { from: 2, to: 3 },
    { from: 1, to: 4 },
    { from: 4, to: 5 },
    { from: 4, to: 10 },
    { from: 2, to: 9 },
    { from: 9, to: 11 },
    { from: 6, to: 8 },
    { from: 6, to: 9 },
    { from: 9, to: 12 },
    { from: 1, to: 16 },
    { from: 16, to: 17 },
    { from: 17, to: 18 },
  ],
}

/**
 * "分类 scope" fixture：模拟带 department=订单服务&category=支付 请求后的响应——
 * 主集 3 个节点，外部依赖 3 个节点（external:true，来自用户服务/风控服务/网关三个不同服务），
 * 用于演示外部节点的虚线描边+灰底角标+跨 combo 连边。
 */
export const SCOPE_FIXTURE: DependencyGraphResponse = {
  unresolved: 0,
  nodes: [
    { id: 1, slug: 'order-create', name: '创建订单', department: '订单服务', category: '支付', nodeCount: 8, specialFlags: [], external: false, enabled: true, lastRunStatus: 'success', errorRate: 0.02, activity: 'active' },
    { id: 2, slug: 'order-pay', name: '订单支付', department: '订单服务', category: '支付', nodeCount: 14, specialFlags: ['http_call'], external: false, enabled: true, lastRunStatus: 'success', errorRate: 0.08, activity: 'active' },
    { id: 3, slug: 'order-pay-callback', name: '支付回调', department: '订单服务', category: '支付', nodeCount: 6, specialFlags: ['http_call'], external: false, enabled: true, lastRunStatus: 'failed', errorRate: 0.35, activity: 'active' },
    { id: 9, slug: 'notify-order', name: '订单通知', department: '用户服务', category: '通知', nodeCount: 12, specialFlags: ['sse_publish', 'kafka'], external: true, enabled: true, lastRunStatus: 'success', errorRate: 0.12, activity: 'active' },
    { id: 16, slug: 'risk-check', name: '风控检查', department: '风控服务', category: '规则', nodeCount: 5, specialFlags: ['redis'], external: true, enabled: true, lastRunStatus: 'success', errorRate: 0.0, activity: 'idle' },
    { id: 14, slug: 'gw-route', name: '网关路由分发', department: '网关', category: '路由', nodeCount: 9, specialFlags: ['http_call'], external: true, enabled: false, lastRunStatus: 'none', errorRate: 0.0, activity: 'dormant' },
  ],
  edges: [
    { from: 14, to: 1 },
    { from: 1, to: 2 },
    { from: 2, to: 3 },
    { from: 2, to: 9 },
    { from: 1, to: 16 },
  ],
}

export const SCOPE_FIXTURE_SCOPE = { department: '订单服务', category: '支付' }

/**
 * "大规模" fixture —— 模拟真实体量（约 120~150 节点）。之前所有布局/配色调整只在 18 节点的
 * FULL_FIXTURE 上验过，上线后 boss 实测截图暴露：节点一多，力导把图摊得极开、大片空白，
 * 整图被 zoom-to-fit 缩得极小，颜色又浅，几乎看不清。这份 fixture 用来在本地复现该规模问题，
 * 所有布局收敛/配色加深的调整都要在它上面验证，不能再只看小图。
 *
 * 8 个 department、每个 2~4 个 category，nodeCount/状态/特殊标记/external 都按索引取模制造梯度
 * （确定性生成，不用随机数，保证截图可复现）；边：每个分类内部按序链式依赖 + 少量跨部门长边
 * + 1 组重复边（复用去重用例）。
 */
function generateLargeFixture(): DependencyGraphResponse {
  const DEPARTMENTS: { name: string; categories: string[] }[] = [
    { name: '订单服务', categories: ['下单', '支付', '退款'] },
    { name: '用户服务', categories: ['账户', '通知'] },
    { name: '网关', categories: ['路由', '限流'] },
    { name: '风控服务', categories: ['规则', '报表', '黑名单'] },
    { name: '支付服务', categories: ['渠道', '对账'] },
    { name: '消息服务', categories: ['站内信', '推送', '短信', '邮件'] },
    { name: '运营服务', categories: ['活动', '优惠券'] },
    { name: '数据服务', categories: ['报表', '同步', '归档'] },
  ]
  // nodeCount 梯度：小到大循环取值，保证同一 fixture 里既有臃肿工作流也有轻量工作流。
  const NODE_COUNT_CYCLE = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 22, 26, 32, 40]
  const FLAG_CYCLE: string[][] = [
    [],
    [],
    ['http_call'],
    ['redis'],
    ['kafka'],
    ['sse_publish'],
    [],
    ['http_call', 'redis'],
    ['kafka', 'sse_publish'],
    [],
  ]
  const STATUS_CYCLE: DependencyGraphNode['lastRunStatus'][] = ['success', 'success', 'failed', 'none', 'success']
  const ACTIVITY_CYCLE: DependencyGraphNode['activity'][] = ['active', 'active', 'idle', 'dormant', 'idle']

  const nodes: DependencyGraphNode[] = []
  // 分类内工作流 id 表，供边生成阶段按分类内链式依赖 + 跨部门长边取用。
  const catNodeIds: string[][] = []
  let seq = 1
  let cursor = 0
  for (const dept of DEPARTMENTS) {
    for (const cat of dept.categories) {
      // 每个分类 5~8 条工作流，累计到 8 部门 × 2~4 分类（共 21 分类）后落在 120~150 节点区间。
      const count = 5 + (cursor % 4)
      const ids: string[] = []
      for (let i = 0; i < count; i++) {
        const id = seq
        const isExternal = seq % 17 === 0
        nodes.push({
          id,
          slug: `${dept.name}-${cat}-${i}`.toLowerCase(),
          name: `${dept.name}·${cat}·工作流${i + 1}`,
          department: dept.name,
          category: cat,
          nodeCount: NODE_COUNT_CYCLE[seq % NODE_COUNT_CYCLE.length],
          specialFlags: FLAG_CYCLE[seq % FLAG_CYCLE.length],
          external: isExternal,
          enabled: seq % 9 !== 0,
          lastRunStatus: STATUS_CYCLE[seq % STATUS_CYCLE.length],
          errorRate: [0, 0.02, 0.08, 0.15, 0.35, 0.6, 0.9][seq % 7],
          activity: ACTIVITY_CYCLE[seq % ACTIVITY_CYCLE.length],
        })
        ids.push(String(id))
        seq += 1
      }
      catNodeIds.push(ids)
      cursor += 1
    }
  }

  const edges: DependencyGraphEdge[] = []
  // 分类内链式依赖：工作流[i] 调用 工作流[i+1]，模拟同分类内的调用编排。
  for (const ids of catNodeIds) {
    for (let i = 0; i < ids.length - 1; i++) {
      edges.push({ from: Number(ids[i]), to: Number(ids[i + 1]) })
    }
  }
  // 跨部门/跨分类长边：每个分类的第一个节点依赖前一个分类的最后一个节点，制造需要跨 combo
  // 绘制的长边（治理长边穿插曲率/颜色的用例），同时保证图整体连通、非孤立多个碎片。
  for (let i = 1; i < catNodeIds.length; i++) {
    const from = catNodeIds[i][0]
    const to = catNodeIds[i - 1][catNodeIds[i - 1].length - 1]
    edges.push({ from: Number(from), to: Number(to) })
  }
  // 重复边用例（沿用 FULL_FIXTURE 的去重回归覆盖）：复制第一条边。
  if (edges.length > 0) edges.push({ ...edges[0] })

  return { nodes, edges, unresolved: 2 }
}

export const LARGE_FIXTURE: DependencyGraphResponse = generateLargeFixture()

/**
 * "超大规模" fixture（P0 真数据规模复现）—— 真环境反馈两个问题都要在这份 fixture 上复现：
 * ①长名字被截断读不全（真实案例形如"购买插件Chapter Pass订阅"/"续费(Airwallex渠道)自动
 * 扣款失败处理"，中英混排+括号+专有名词，比 LARGE_FIXTURE 里的短中文名更接近真实痛点）；
 * ②300~400 节点量级下的拖拽/缩放卡顿。department/category 数量也比 LARGE_FIXTURE 翻倍
 * （13 个部门、跨度更宽），逼近真实租户"部门多、每部门下又分好几类"的分布，而不是只把
 * 单个分类里的节点数堆多——后者测不出 combo-combined 三层递归在"层数多、combo 数多"时的
 * 真实开销。生成逻辑与 generateLargeFixture 同构（确定性、无随机数，保证截图可复现），
 * 只是参数拉大 + 插入一批真实长名字节点。
 */
function generateXLFixture(): DependencyGraphResponse {
  const DEPARTMENTS: { name: string; categories: string[] }[] = [
    { name: '订单服务', categories: ['下单', '支付', '退款', '售后'] },
    { name: '用户服务', categories: ['账户', '通知', '权限'] },
    { name: '网关', categories: ['路由', '限流', '鉴权'] },
    { name: '风控服务', categories: ['规则', '报表', '黑名单'] },
    { name: '支付服务', categories: ['渠道', '对账', '结算'] },
    { name: '消息服务', categories: ['站内信', '推送', '短信', '邮件'] },
    { name: '运营服务', categories: ['活动', '优惠券', '积分'] },
    { name: '数据服务', categories: ['报表', '同步', '归档'] },
    { name: '插件市场', categories: ['购买', '续费', '退订', '试用'] },
    { name: '内容服务', categories: ['帖子', '评论', '审核'] },
    { name: '客服服务', categories: ['工单', '客服消息'] },
    { name: '直播服务', categories: ['连麦', '礼物', '弹幕'] },
    { name: '社区服务', categories: ['话题', '关注', '举报'] },
  ]
  // 真实痛点复现：长名字节点——中英混排、括号、专有名词，插进 catNodeIds 首位节点里，
  // 保证每个分类至少有一个长名字节点被真实渲染到（不是散落在随机位置靠概率碰上）。
  const LONG_NAME_CYCLE = [
    '购买插件Chapter Pass订阅',
    '续费(Airwallex渠道)自动扣款',
    '取消订阅并退还剩余额度到钱包余额',
    'Stripe Webhook回调签名校验与幂等处理',
    '插件试用到期自动降级为免费版',
    '多币种价格换算(USD/EUR/JPY/CNY)缓存刷新',
  ]
  const NODE_COUNT_CYCLE = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 22, 26, 32, 40]
  const FLAG_CYCLE: string[][] = [
    [],
    [],
    ['http_call'],
    ['redis'],
    ['kafka'],
    ['sse_publish'],
    [],
    ['http_call', 'redis'],
    ['kafka', 'sse_publish'],
    [],
  ]
  const STATUS_CYCLE: DependencyGraphNode['lastRunStatus'][] = ['success', 'success', 'failed', 'none', 'success']
  const ACTIVITY_CYCLE: DependencyGraphNode['activity'][] = ['active', 'active', 'idle', 'dormant', 'idle']

  const nodes: DependencyGraphNode[] = []
  const catNodeIds: string[][] = []
  let seq = 1
  let cursor = 0
  let longNameCursor = 0
  for (const dept of DEPARTMENTS) {
    for (const cat of dept.categories) {
      // 每分类 6~9 条工作流，13 部门 × 若干分类（共 41 分类）落在 300~400 节点区间。
      const count = 6 + (cursor % 4)
      const ids: string[] = []
      for (let i = 0; i < count; i++) {
        const id = seq
        const isExternal = seq % 19 === 0
        // 每个分类首个节点用长名字循环表，保证长名字均匀分布在各服务/分类下，不是扎堆。
        const name =
          i === 0
            ? LONG_NAME_CYCLE[longNameCursor % LONG_NAME_CYCLE.length]
            : `${dept.name}·${cat}·工作流${i + 1}`
        if (i === 0) longNameCursor += 1
        nodes.push({
          id,
          slug: `${dept.name}-${cat}-${i}`.toLowerCase(),
          name,
          department: dept.name,
          category: cat,
          nodeCount: NODE_COUNT_CYCLE[seq % NODE_COUNT_CYCLE.length],
          specialFlags: FLAG_CYCLE[seq % FLAG_CYCLE.length],
          external: isExternal,
          enabled: seq % 9 !== 0,
          lastRunStatus: STATUS_CYCLE[seq % STATUS_CYCLE.length],
          errorRate: [0, 0.02, 0.08, 0.15, 0.35, 0.6, 0.9][seq % 7],
          activity: ACTIVITY_CYCLE[seq % ACTIVITY_CYCLE.length],
        })
        ids.push(String(id))
        seq += 1
      }
      catNodeIds.push(ids)
      cursor += 1
    }
  }

  const edges: DependencyGraphEdge[] = []
  for (const ids of catNodeIds) {
    for (let i = 0; i < ids.length - 1; i++) {
      edges.push({ from: Number(ids[i]), to: Number(ids[i + 1]) })
    }
  }
  for (let i = 1; i < catNodeIds.length; i++) {
    const from = catNodeIds[i][0]
    const to = catNodeIds[i - 1][catNodeIds[i - 1].length - 1]
    edges.push({ from: Number(from), to: Number(to) })
  }
  if (edges.length > 0) edges.push({ ...edges[0] })

  return { nodes, edges, unresolved: 3 }
}

export const XL_FIXTURE: DependencyGraphResponse = generateXLFixture()

/**
 * "聚合压力" fixture（方案一聚合视图节点重叠修复专用复现用例）——boss 真实环境反馈：分类数
 * 20+、簇间调用边密集时，"按分类聚合"视图节点大面积堆叠重合、标签互相压住甚至被截断成
 * "各…"。之前的 LARGE/XL fixture 虽然分类数也不少（分别 21/41 个），但没暴露这问题，
 * 因为：①簇间边只是"每个分类第一个节点依赖前一个分类最后一个节点"的稀疏链式关系，聚合后
 * 每个簇最多一进一出，力导随便摆都不挤；②长名字只集中在个别节点，分类名本身都很短。
 * 这份 fixture 专门复现真实痛点：
 * - 22 个分类，每类工作流条数从 1 到 8 强烈不均（1 条的最容易被长标签压垮，因为圆本身极小）；
 * - 分类名长短混排——一半是短分类名（"对账"/"发货"），一半是真实业务里那种长分类名
 *   （"各类活动与优惠券自动核销异常处理"这类），逼真复现"Acme·各…"被截断的痛点；
 * - 簇间调用边不再是稀疏链式，而是每个分类额外向另外 3 个不相邻分类建边（确定性取模，不用
 *   随机数保证截图可复现），聚合后是一张密集的多对多网，而不是一条项链。
 */
function generateAggStressFixture(): DependencyGraphResponse {
  const CATEGORIES: { dept: string; cat: string }[] = [
    { dept: '订单服务', cat: '下单' },
    { dept: '订单服务', cat: '支付' },
    { dept: '订单服务', cat: '退款审核与仲裁处理' },
    { dept: '订单服务', cat: '售后' },
    { dept: '用户服务', cat: '账户' },
    { dept: '用户服务', cat: '实名认证与风控黑名单核验' },
    { dept: '用户服务', cat: '权限' },
    { dept: '网关', cat: '路由' },
    { dept: '网关', cat: '限流与熔断降级策略' },
    { dept: '风控服务', cat: '规则' },
    { dept: '风控服务', cat: '报表' },
    { dept: '支付服务', cat: '渠道对接与签名校验' },
    { dept: '支付服务', cat: '对账' },
    { dept: '消息服务', cat: '推送' },
    { dept: '消息服务', cat: '站内信与系统公告分发' },
    { dept: '运营服务', cat: '活动与优惠券自动核销异常处理' },
    { dept: '运营服务', cat: '积分' },
    { dept: '数据服务', cat: '同步' },
    { dept: '插件市场', cat: '购买与订阅生命周期管理' },
    { dept: '插件市场', cat: '退订' },
    { dept: '内容服务', cat: '审核' },
    { dept: '社区服务', cat: '举报与仲裁裁决流程' },
  ]
  // 条数梯度刻意从 1 起步——1 条的分类圆最小（nodeVisualSize 幂律曲线下限附近），
  // 最容易被长标签压垮，正是要复现的痛点。
  const COUNT_CYCLE = [1, 1, 2, 3, 5, 8]
  const FLAG_CYCLE: string[][] = [[], ['http_call'], ['redis'], [], ['kafka'], ['sse_publish']]

  const nodes: DependencyGraphNode[] = []
  const catNodeIds: string[][] = []
  let seq = 1
  CATEGORIES.forEach((c, ci) => {
    const count = COUNT_CYCLE[ci % COUNT_CYCLE.length]
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      const id = seq
      nodes.push({
        id,
        slug: `${c.dept}-${c.cat}-${i}`.toLowerCase(),
        name: `${c.dept}·${c.cat}·工作流${i + 1}`,
        department: c.dept,
        category: c.cat,
        nodeCount: [3, 5, 8, 12, 18, 26][seq % 6],
        specialFlags: FLAG_CYCLE[seq % FLAG_CYCLE.length],
        external: false,
        enabled: seq % 7 !== 0,
        lastRunStatus: (['success', 'success', 'failed', 'none'] as const)[seq % 4],
        errorRate: [0, 0.05, 0.2, 0.5][seq % 4],
        activity: (['active', 'idle', 'dormant'] as const)[seq % 3],
      })
      ids.push(String(id))
      seq += 1
    }
    catNodeIds.push(ids)
  })

  const edges: DependencyGraphEdge[] = []
  // 分类内链式依赖（条数 ≥2 的分类才有内部编排）。
  for (const ids of catNodeIds) {
    for (let i = 0; i < ids.length - 1; i++) {
      edges.push({ from: Number(ids[i]), to: Number(ids[i + 1]) })
    }
  }
  // 密集跨分类边：每个分类额外向 3 个"跳跃距离不同"的分类建边（+3/+7/+11，确定性取模），
  // 聚合后每个簇节点周围挂着好几条边，而不是稀疏链条——这才是真实环境"边密"的复现关键。
  const JUMPS = [3, 7, 11]
  catNodeIds.forEach((ids, i) => {
    if (ids.length === 0) return
    JUMPS.forEach((jump) => {
      const targetIdx = (i + jump) % catNodeIds.length
      const targetIds = catNodeIds[targetIdx]
      if (targetIdx === i || targetIds.length === 0) return
      edges.push({ from: Number(ids[0]), to: Number(targetIds[targetIds.length - 1]) })
    })
  })

  return { nodes, edges, unresolved: 0 }
}

export const AGG_STRESS_FIXTURE: DependencyGraphResponse = generateAggStressFixture()

/**
 * "600 节点" fixture（性能二期验收专用）——boss 批准的二期目标规模，逼近真实大租户体量。
 * 贴近真实分布的三个刻意设计点：
 * - 部门/分类条数强烈不均（3~34 条一个分类都有），不是均匀切块；
 * - 少数"hub"节点（网关鉴权/风控核验/统一通知这类被到处调用的公共能力）被跨部门大量指向，
 *   被依赖数远超其余节点，用来验收入度光环/排行榜在真实偏斜分布下是否还读得清楚；
 * - 长短工作流名混排（复用 XL fixture 的真实业务长名字库），验收标签换行/省略号策略。
 * 边生成仍是确定性（无随机数）：分类内链式 + 跨分类稀疏跳跃 + hub 集中调用三层叠加。
 */
function generateHugeFixture(): DependencyGraphResponse {
  const DEPARTMENTS: { name: string; categories: string[] }[] = [
    { name: '订单服务', categories: ['下单', '支付', '退款', '售后', '发票'] },
    { name: '用户服务', categories: ['账户', '通知', '权限', '实名认证'] },
    { name: '网关', categories: ['路由', '限流', '鉴权', '熔断降级'] },
    { name: '风控服务', categories: ['规则', '报表', '黑名单', '设备指纹'] },
    { name: '支付服务', categories: ['渠道', '对账', '结算'] },
    { name: '消息服务', categories: ['站内信', '推送', '短信', '邮件', '模板管理'] },
    { name: '运营服务', categories: ['活动', '优惠券', '积分', '签到'] },
    { name: '数据服务', categories: ['报表', '同步', '归档'] },
    { name: '插件市场', categories: ['购买', '续费', '退订', '试用'] },
    { name: '内容服务', categories: ['帖子', '评论', '审核', '推荐'] },
    { name: '客服服务', categories: ['工单', '客服消息'] },
    { name: '直播服务', categories: ['连麦', '礼物', '弹幕'] },
    { name: '社区服务', categories: ['话题', '关注', '举报'] },
    { name: '搜索服务', categories: ['索引构建', '查询'] },
    { name: '认证服务', categories: ['登录', '第三方授权', '会话管理'] },
    { name: '统计服务', categories: ['埋点', '报表生成'] },
    { name: '库存服务', categories: ['扣减', '预占', '同步'] },
    { name: '物流服务', categories: ['运单', '轨迹同步'] },
  ]
  const LONG_NAME_CYCLE = [
    '购买插件Chapter Pass订阅',
    '续费(Airwallex渠道)自动扣款',
    '取消订阅并退还剩余额度到钱包余额',
    'Stripe Webhook回调签名校验与幂等处理',
    '插件试用到期自动降级为免费版',
    '多币种价格换算(USD/EUR/JPY/CNY)缓存刷新',
    '设备指纹采集与风险评分批量核验',
    '第三方授权令牌过期自动刷新重试',
  ]
  // 条数梯度刻意拉宽跨度（3~34），比 XL fixture 更极端不均——真实大租户里"账户/支付"这类
  // 核心分类条数远超"关注/举报"这类边缘分类，用固定循环表模拟这种偏斜而不是均匀切块。
  const COUNT_CYCLE = [3, 5, 6, 8, 10, 12, 14, 18, 22, 28, 34, 4, 7, 9]
  const NODE_COUNT_CYCLE = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 22, 26, 32, 40]
  // trigger_cron / trigger_notify 是特殊节点筛选器新增的两类（对齐后端按 trigger_type 派生
  // 的合成标记，见 graphData.ts SPECIAL_FLAG_META 注释）——补进循环表让筛选器四类必选项
  // （定时执行/Redis/Kafka/等待Notify）在这份验收 fixture 里都有非零命中。
  const FLAG_CYCLE: string[][] = [
    [],
    [],
    ['http_call'],
    ['redis'],
    ['kafka'],
    ['sse_publish'],
    ['trigger_cron'],
    ['http_call', 'redis'],
    ['kafka', 'sse_publish'],
    ['trigger_notify'],
    [],
    ['redis', 'trigger_cron'],
    ['kafka', 'trigger_notify'],
    [],
  ]
  const STATUS_CYCLE: DependencyGraphNode['lastRunStatus'][] = ['success', 'success', 'failed', 'none', 'success']
  const ACTIVITY_CYCLE: DependencyGraphNode['activity'][] = ['active', 'active', 'idle', 'dormant', 'idle']

  const nodes: DependencyGraphNode[] = []
  const catNodeIds: string[][] = []
  let seq = 1
  let cursor = 0
  let longNameCursor = 0
  DEPARTMENTS.forEach((dept) => {
    dept.categories.forEach((cat) => {
      const count = COUNT_CYCLE[cursor % COUNT_CYCLE.length]
      const ids: string[] = []
      for (let i = 0; i < count; i++) {
        const id = seq
        const isExternal = seq % 23 === 0
        const name = i === 0 ? LONG_NAME_CYCLE[longNameCursor % LONG_NAME_CYCLE.length] : `${dept.name}·${cat}·工作流${i + 1}`
        if (i === 0) longNameCursor += 1
        nodes.push({
          id,
          slug: `${dept.name}-${cat}-${i}`.toLowerCase(),
          name,
          department: dept.name,
          category: cat,
          nodeCount: NODE_COUNT_CYCLE[seq % NODE_COUNT_CYCLE.length],
          specialFlags: FLAG_CYCLE[seq % FLAG_CYCLE.length],
          external: isExternal,
          enabled: seq % 9 !== 0,
          lastRunStatus: STATUS_CYCLE[seq % STATUS_CYCLE.length],
          errorRate: [0, 0.02, 0.08, 0.15, 0.35, 0.6, 0.9][seq % 7],
          activity: ACTIVITY_CYCLE[seq % ACTIVITY_CYCLE.length],
        })
        ids.push(String(id))
        seq += 1
      }
      catNodeIds.push(ids)
      cursor += 1
    })
  })

  const edges: DependencyGraphEdge[] = []
  // 分类内链式依赖：同分类工作流按序号编排调用。
  for (const ids of catNodeIds) {
    for (let i = 0; i < ids.length - 1; i++) {
      edges.push({ from: Number(ids[i]), to: Number(ids[i + 1]) })
    }
  }
  // 跨分类稀疏跳跃：制造需要跨 combo 绘制的长边，同时保证整图连通。
  for (let i = 1; i < catNodeIds.length; i++) {
    const from = catNodeIds[i][0]
    const to = catNodeIds[i - 1][catNodeIds[i - 1].length - 1]
    if (from && to) edges.push({ from: Number(from), to: Number(to) })
  }
  // Hub 集中调用：挑 8 个分布在不同部门的"公共能力"节点当 hub（网关鉴权/风控核验/统一通知
  // 这类现实中确实会被到处调用的节点），让其余每个分类里挑一个节点按确定性取模指向某个 hub，
  // 制造真实分布常见的"少数节点入度极高"偏斜，而不是所有节点入度均匀。
  const hubCandidates = ['网关-鉴权-0', '风控服务-规则-0', '用户服务-账户-0', '认证服务-登录-0', '消息服务-站内信-0', '数据服务-同步-0', '支付服务-渠道-0', '库存服务-扣减-0']
  const slugToId = new Map<string, string>()
  nodes.forEach((n) => slugToId.set(n.slug, String(n.id)))
  const hubIds = hubCandidates.map((slug) => slugToId.get(slug)).filter((id): id is string => !!id)
  if (hubIds.length > 0) {
    catNodeIds.forEach((ids, i) => {
      const caller = ids[ids.length - 1]
      const hub = hubIds[i % hubIds.length]
      if (caller && hub && caller !== hub) edges.push({ from: Number(caller), to: Number(hub) })
    })
  }
  if (edges.length > 0) edges.push({ ...edges[0] })

  return { nodes, edges, unresolved: 4 }
}

export const HUGE_FIXTURE: DependencyGraphResponse = generateHugeFixture()
