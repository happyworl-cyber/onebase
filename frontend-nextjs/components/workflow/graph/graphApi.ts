import api from '@/lib/api'

/** 后端契约：GET /api/admin/workflows/dependency-graph 返回的单个节点（=一条工作流）。 */
export interface DependencyGraphNode {
  id: number
  slug: string
  name: string
  department: string | null
  category: string | null
  nodeCount: number
  specialFlags: string[]
  /** 主集内 false；主集 call_workflow 1 跳依赖到的分类外工作流为 true（只展开 1 跳，不递归）。 */
  external: boolean
  /** 工作流启停开关（对齐 workflows.is_enabled）。 */
  enabled: boolean
  /** 统计窗口内失败率 0~1，窗口内无运行记 0（配色切换器·错误率用）。窗口天数见响应 windowDays。 */
  errorRate: number
  /** 窗口内运行次数 / 失败次数——追踪错误时要看量级，不只是百分比。 */
  windowRuns: number
  windowFailed: number
  /** 窗口内无运行 dormant；有则按最晚一次距今分档：24h 内 active、否则 idle（判断是否该废弃用）。 */
  activity: 'active' | 'idle' | 'dormant'
}

/** 后端契约：有向边，from/to 均为工作流数字 id（同 node.id）。 */
export interface DependencyGraphEdge {
  from: number
  to: number
}

export interface DependencyGraphResponse {
  nodes: DependencyGraphNode[]
  edges: DependencyGraphEdge[]
  unresolved: number
  /** 运行状态统计窗口天数（后端取 min(3, 运行记录保留期)）；所有"近 N 天"文案读这个值。 */
  windowDays: number
}

export interface DependencyGraphScope {
  department: string
  category: string
}

/**
 * 同参数请求去重 + 短缓存。依赖图画布会因为外层原因反复卸载重挂（workspace layout 的
 * "先清空连接再填回"让 databaseId 抖动、开发模式 StrictMode 双挂载、多个保活 tab 同时重挂），
 * 每次重挂都是一次一模一样的请求，实测一次进页能打出 5 条。这里按参数做两层收敛：
 * - 在途去重：同参数请求还没返回时，后来者直接共享同一个 Promise；
 * - 结果缓存：返回后按参数保留 CACHE_TTL_MS，期间的重复请求直接命中。
 * 只影响本函数的调用方（仅依赖图画布），不动 store / layout / 全局拦截器。
 * TTL 刻意取得短：改完工作流再进图不该拿到旧结构；后端运行状态本身另有更长的缓存。
 */
const CACHE_TTL_MS = 15_000
const inflight = new Map<string, Promise<DependencyGraphResponse>>()
const cache = new Map<string, { at: number; data: DependencyGraphResponse }>()

function requestKey(databaseId?: number | null, scope?: DependencyGraphScope | null): string {
  return `${databaseId ?? ''}|${scope?.department ?? ''}|${scope?.category ?? ''}`
}

/**
 * 拉取依赖图数据。不传 scope → 主集 = 当前视图 scope 内全部工作流（全量渲染）；
 * 传 department+category（两者都要有，风格同工作流列表页的 buildListQueryParams）
 * → 主集收窄为该分类下工作流，主集外 1 跳依赖以 external:true 节点一并返回。
 */
export async function fetchDependencyGraph(
  databaseId?: number | null,
  scope?: DependencyGraphScope | null,
): Promise<DependencyGraphResponse> {
  const key = requestKey(databaseId, scope)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data
  const pending = inflight.get(key)
  if (pending) return pending

  const params: Record<string, string | number> = {}
  if (databaseId != null) params.database_id = databaseId
  if (scope) {
    params.department = scope.department
    params.category = scope.category
  }

  const p = api
    .get('/api/admin/workflows/dependency-graph', { params })
    .then((res) => {
      const data: DependencyGraphResponse = {
        nodes: res.data.nodes ?? [],
        edges: res.data.edges ?? [],
        unresolved: res.data.unresolved ?? 0,
        windowDays: res.data.windowDays ?? 3,
      }
      cache.set(key, { at: Date.now(), data })
      return data
    })
    .finally(() => {
      inflight.delete(key)
    })
  inflight.set(key, p)
  return p
}
