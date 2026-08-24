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
  /** 最近一条运行的终结状态；进行中/无记录一律 "none"（配色切换器·最近成败用）。 */
  lastRunStatus: 'success' | 'failed' | 'none'
  /** 近 7 天窗口失败率 0~1，窗口内无运行记 0（配色切换器·错误率用）。 */
  errorRate: number
  /** 按最近一条运行距今时长分档（配色切换器·活跃度用）。 */
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
}

export interface DependencyGraphScope {
  department: string
  category: string
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
  const params: Record<string, string | number> = {}
  if (databaseId != null) params.database_id = databaseId
  if (scope) {
    params.department = scope.department
    params.category = scope.category
  }

  const res = await api.get('/api/admin/workflows/dependency-graph', { params })
  return {
    nodes: res.data.nodes ?? [],
    edges: res.data.edges ?? [],
    unresolved: res.data.unresolved ?? 0,
  }
}
