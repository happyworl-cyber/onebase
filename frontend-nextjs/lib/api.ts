import axios, { AxiosError, AxiosRequestConfig } from 'axios'
import { showToast } from '@/components/Toast'
import { useAppStore } from '@/lib/store'
import { clearAuthToken } from '@/lib/auth'

/**
 * 给单个请求关闭"全局错误 toast"的开关。
 * 用于：批量获取数据、轮询、健康检查等"静默失败"场景。
 *
 * 用法：api.get('/foo', { suppressErrorToast: true } as ApiRequestConfig)
 */
export interface ApiRequestConfig extends AxiosRequestConfig {
  suppressErrorToast?: boolean
}

/**
 * 从后端 / axios 错误对象里抽取最合适的人类可读消息。
 * 后端约定（见 src/error.rs）：失败响应体形如 { "error": "..." }。
 */
function extractErrorMessage(error: AxiosError<any>): string {
  const data = error.response?.data
  if (typeof data === 'string' && data) return data
  if (data && typeof data === 'object') {
    if (typeof data.error === 'string' && data.error) return data.error
    if (typeof data.message === 'string' && data.message) return data.message
  }
  if (error.code === 'ECONNABORTED') return '请求超时，请稍后重试'
  if (error.message === 'Network Error') return '网络异常，无法连接到后端'
  if (error.message) return error.message
  return '请求失败，请稍后重试'
}

const api = axios.create({
  // 留空时浏览器使用与前端相同的 origin，请求会经 Next.js 的 rewrites 在容器内反代到后端，
  // 这样从任何 IP/域名访问前端都能正确转发，不需要改打包参数。
  baseURL: process.env.NEXT_PUBLIC_API_URL || '',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: false,
})

// 请求拦截器
api.interceptors.request.use(
  (config) => {
    // 从 localStorage 获取 token
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('token')
      if (token) {
        config.headers.Authorization = `Bearer ${token}`
      }
      
      // 当前数据库连接 ID 用于 `dynamic_db_middleware` 路由到对应租户的数据库。
      // **不覆盖调用方显式传入的 X-Database-Id** —— 让定时任务表单这类"想查任意库
      // 而不是当前选中库"的场景能 per-request 指定目标库（如 scheduledTaskAPI
      // 的 listSchemas / listFunctions）。
      const hasExplicitDbId =
        config.headers['X-Database-Id'] !== undefined ||
        config.headers['x-database-id'] !== undefined
      if (!hasExplicitDbId) {
        const currentConnection = localStorage.getItem('current_connection')
        if (currentConnection) {
          try {
            const conn = JSON.parse(currentConnection)
            if (conn && conn.database_id) {
              config.headers['X-Database-Id'] = conn.database_id.toString()
            }
          } catch (e) {
            console.error('解析 current_connection 失败:', e)
          }
        }
      }

      // 当前租户 ID。所有"租户级元数据"接口（RBAC 角色/权限、SSO Provider、Webhook 等）
      // 都通过 `X-Tenant-Id` 来确定要操作的租户——这样：
      //   1) 一个用户加入多个租户时不再"猜第一个"；
      //   2) 平台超管在 /platform 视图下手动切换 tenant 也能命中正确数据。
      // 后端 `permissions::TenantContext` 提取器 +query 兜底，可以选择性传 `?tenant_id=`。
      const currentTenant = localStorage.getItem('current_tenant')
      if (currentTenant) {
        try {
          const tenant = JSON.parse(currentTenant)
          if (tenant && tenant.id) {
            config.headers['X-Tenant-Id'] = tenant.id.toString()
          }
        } catch (e) {
          console.error('解析 current_tenant 失败:', e)
        }
      }
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// 响应拦截器：
//   1. 401 → 清 token、跳登录页（同时弹一条提示，免得用户莫名其妙被踢）。
//   2. 其它失败 → 全局 toast 弹错误信息；并在 error 对象上打 __toastShown 标记，
//      让页面里调用 useNotification().error(err) 时不再重复弹一次。
//   3. 调用方若想"静默失败"（如轮询、可选数据加载），把 config 里加上
//      `suppressErrorToast: true` 即可。
function isPostQueryUrl(url: string | undefined): boolean {
  if (!url) return false
  const path = url.split('?')[0].replace(/\/+$/, '') || ''
  return path === '/query' || path.endsWith('/query')
}

api.interceptors.response.use(
  (response) => {
    if (typeof window !== 'undefined') {
      const method = response.config.method?.toLowerCase()
      if (method === 'post' && isPostQueryUrl(response.config.url)) {
        useAppStore.getState().recordSessionQueryExecution()
      }
    }
    return response
  },
  (error: AxiosError<any> & { __toastShown?: boolean }) => {
    const status = error.response?.status
    const config = (error.config || {}) as ApiRequestConfig
    const message = extractErrorMessage(error)

    if (status === 401) {
      if (typeof window !== 'undefined') {
        useAppStore.getState().resetSessionQueryExecution()
        // 通过 helper 同时清掉 localStorage 与 middleware 用的 cookie，
        // 避免下次进入受保护路由时仍被旧 cookie 放行又被后端 401 弹回
        clearAuthToken()
        // 仅在不是登录页本身时跳转，避免循环
        if (!window.location.pathname.startsWith('/login')) {
          showToast('warning', '登录已过期，请重新登录', 3000)
          error.__toastShown = true
          window.location.href = '/login'
        }
      }
      return Promise.reject(error)
    }

    if (!config.suppressErrorToast) {
      showToast('error', message)
      error.__toastShown = true
    }

    return Promise.reject(error)
  }
)

export default api

// API 方法封装
/** GET /health 响应（与后端 health_check 对齐） */
export interface HealthDetailResponse {
  status: string
  database: { status: string; pool_size?: number; idle?: number }
  redis: { status: string }
  version: string
}

export const healthAPI = {
  getDetail: () =>
    api.get<HealthDetailResponse>('/health', { suppressErrorToast: true } as ApiRequestConfig),
}

export const authAPI = {
  login: (email: string, password: string) =>
    api.post('/auth/login', { email, password }),
  
  register: (email: string, password: string) =>
    api.post('/auth/register', { email, password }),
  
  me: () => api.get('/auth/me'),
  
  changePassword: (old_password: string, new_password: string) =>
    api.post('/auth/change-password', { old_password, new_password }),
}

export const schemaAPI = {
  listSchemas: () => api.get('/api/schemas'),
  listTables: (schema: string) => api.get(`/api/schema/${schema}/tables`),
  getTableStructure: (schema: string, table: string) =>
    api.get(`/api/schema/${schema}/table/${table}/structure`),
  
  // 创建新 schema
  createSchema: (name: string) => api.post('/api/schemas', { name }),
  
  // 删除 schema
  dropSchema: (schema: string, cascade: boolean = false) => 
    api.delete(`/api/schemas/${schema}`, { data: { cascade } }),
}

// 索引管理 API
export interface IndexRow {
  schema: string
  table: string
  name: string
  method: string
  is_unique: boolean
  is_primary: boolean
  is_valid: boolean
  columns: string[]
  definition: string
  size: string
  size_bytes: number
}

export interface IndexColumnInput {
  // 列名 / 表达式 二选一
  name?: string
  expression?: string
  ordering?: 'ASC' | 'DESC'
  nulls?: 'FIRST' | 'LAST'
}

export interface CreateIndexRequest {
  schema: string
  table: string
  name: string
  method?: 'btree' | 'hash' | 'gin' | 'gist' | 'brin' | 'spgist'
  unique?: boolean
  concurrent?: boolean
  if_not_exists?: boolean
  columns: IndexColumnInput[]
  include?: string[]
  // 部分索引的 WHERE 子句
  where_clause?: string
}

export const indexAPI = {
  list: (schema: string, table?: string) =>
    api.get<IndexRow[]>(`/api/indexes/${schema}`, {
      params: table ? { table } : undefined,
    }),

  create: (data: CreateIndexRequest) => api.post('/api/indexes', data),

  drop: (
    schema: string,
    name: string,
    options: { concurrent?: boolean; cascade?: boolean; if_exists?: boolean } = {},
  ) =>
    api.delete(`/api/indexes/${schema}/${name}`, {
      params: options,
    }),
}

// 项目管理 API
export const tenantAPI = {
  // 获取当前用户可访问的所有连接（可按项目筛选）
  getMyConnections: (tenantId?: number) => api.get(`/api/tenants/my-connections${tenantId ? `?tenant_id=${tenantId}` : ''}`),
  
  // 获取指定项目的业务 Schema
  getTenantSchemas: (tenantId: number) => api.get(`/api/tenants/${tenantId}/schemas`),
  
  // 测试数据库连接
  testConnection: (data: {
    host: string
    port: number
    database: string
    username: string
    password: string
  }) => api.post('/api/tenants/test-connection', data),
  // 创建新的数据库连接
  createConnection: (data: {
    tenant_id: number
    connection_name: string
    db_host: string
    db_port: number
    db_name: string
    db_user: string
    db_password: string
    is_primary: boolean
    max_connections?: number
    connection_timeout?: number
  }) => api.post('/api/tenants/connections', data),
  
  // 切换到指定的数据库连接
  switchConnection: (databaseId: number) => 
    api.post('/api/tenants/switch-connection', { database_id: databaseId }),
  
  // 获取连接池统计信息
  getPoolStats: () => api.get('/api/tenants/pool-stats'),
}

// 超管 API（仅超级管理员可访问）
export const adminAPI = {
  // 获取所有项目列表（使用旧的超管接口）
  listAllTenants: () => api.get('/api/admin/all-tenants'),
  
  // 获取项目列表（包含数据库连接信息）
  listTenants: () => api.get('/api/admin/all-tenants'),
  
  // 创建新项目（使用新接口）
  createTenant: (data: {
    name: string
    slug: string
    contact_email?: string
    db_host?: string
    db_port?: number
    db_name?: string
    db_user?: string
    db_password?: string
    create_database?: boolean  // true: 创建新数据库, false: 连接现有数据库
  }) => api.post('/api/admin/tenants/create', data),
  
  // 删除项目
  deleteTenant: (tenantId: number) => api.delete(`/api/admin/tenants/${tenantId}`),
  
  // 获取所有用户列表
  listAllUsers: () => api.get('/api/admin/all-users'),
  
  // 将用户分配给项目
  assignUserToTenant: (userId: number, data: {
    tenant_id: number
    role: string
  }) => api.post(`/api/admin/users/${userId}/assign-tenant`, data),

  // 从项目移除用户（软删除：is_active = false）
  removeUserFromTenant: (userId: number, tenantId: number) =>
    api.delete(`/api/admin/tenant-users/${userId}/${tenantId}`),

  // 管理员侧创建用户（与 /auth/register 不同，可直接置 is_superadmin）
  createUser: (data: {
    username: string
    email: string
    password: string
    is_superadmin?: boolean
  }) => api.post('/api/admin/users', data),

  // 更新用户名 / 超管标志
  updateUser: (userId: number, data: {
    username?: string
    is_superadmin?: boolean
  }) => api.patch(`/api/admin/users/${userId}`, data),

  // 重置他人密码（会自动吊销该用户的活跃会话）
  resetUserPassword: (userId: number, newPassword: string) =>
    api.post(`/api/admin/users/${userId}/reset-password`, { new_password: newPassword }),

  // 彻底删除用户（不可逆；user_tenants / user_sessions / sso_user_links / user_roles
  // 全部因 ON DELETE CASCADE 自动清理）
  deleteUser: (userId: number) => api.delete(`/api/admin/users/${userId}`),
  
  // 获取项目详情
  getTenantDetail: (tenantId: number) => api.get(`/api/admin/tenants/${tenantId}`),
  
  // 更新项目信息（仅传入的字段会被修改）
  // - 租户层：name / status (active|suspended|deleted) / contact_email
  // - 主数据库连接：db_host / db_port / db_name / db_user / db_password / is_active
  // 注意：db_password 留空表示不修改密码；slug 不可修改。
  updateTenant: (tenantId: number, data: {
    name?: string
    status?: string
    contact_email?: string
    db_host?: string
    db_port?: number
    db_name?: string
    db_user?: string
    db_password?: string
    is_active?: boolean
  }) => api.patch(`/api/admin/tenants/${tenantId}`, data),
  
  // 获取系统统计信息
  getSystemStats: () => api.get('/api/admin/stats'),

  // === 只读副本（读流量横向扩展）===
  // 仅超管可用；副本挂在该租户的主连接下（is_primary=true）。
  // 添加 / 修改 / 删除后，后端会失效主连接的连接池，下次请求按新拓扑重建。
  listReplicas: (tenantId: number) =>
    api.get<Replica[]>(`/api/admin/tenants/${tenantId}/replicas`),

  addReplica: (
    tenantId: number,
    data: {
      connection_name: string
      db_host: string
      db_port?: number
      db_name?: string
      db_user?: string
      db_password?: string
      weight?: number
      max_connections?: number
      connection_timeout?: number
    },
  ) => api.post<Replica>(`/api/admin/tenants/${tenantId}/replicas`, data),

  updateReplica: (
    tenantId: number,
    replicaId: number,
    data: {
      connection_name?: string
      db_host?: string
      db_port?: number
      db_name?: string
      db_user?: string
      db_password?: string
      weight?: number
      is_active?: boolean
    },
  ) =>
    api.patch(`/api/admin/tenants/${tenantId}/replicas/${replicaId}`, data),

  deleteReplica: (tenantId: number, replicaId: number) =>
    api.delete(`/api/admin/tenants/${tenantId}/replicas/${replicaId}`),

  /**
   * 拉取该租户所有副本的实时健康状态：是否可达 / 是否处于物理 standby / 复制延迟（秒）。
   * 接口不会写元数据；适合前端按秒/数秒级轮询。
   * 每个副本探测都有 3s 超时；副本越多耗时越长（串行）。
   */
  replicasHealth: (tenantId: number) =>
    api.get<ReplicaHealth[]>(`/api/admin/tenants/${tenantId}/replicas-health`),
}

export interface Replica {
  id: number
  tenant_id: number
  primary_id: number
  connection_name: string
  db_host: string
  db_port: number
  db_name: string
  db_user: string
  db_role: 'replica'
  weight: number
  is_active: boolean
  max_connections: number | null
  connection_timeout: number | null
  created_at: string
}

export interface ReplicaHealth {
  id: number
  /** tenant_databases.is_active —— 是否处于轮询池中（false 即使健康也不会接收读流量） */
  is_active: boolean
  /**
   * 是否被 **运行时看护任务** 自动旁路（连续探活失败 / 复制延迟超阈值 / 非 standby）。
   * 与 is_active 的区别：bypassed 不写库，副本恢复健康会被自动重新上线。
   */
  bypassed: boolean
  /** TCP/握手是否成功 */
  reachable: boolean
  /**
   * 是否为物理 standby：
   * - true  : 物理流复制副本，真正会自动跟随 primary
   * - false : 是一个独立可写库（误用！只读流量打过去会读不到主库的新数据）
   * - null  : 探测失败 / 不可达，未取到
   */
  in_recovery: boolean | null
  /**
   * 当前复制延迟（秒）。来自 now() - pg_last_xact_replay_timestamp()
   * - null    : 还未重放任何事务、不是 standby、或查询失败
   * - 0 附近 : 正常追平
   * - 较大值 : 落后；超过几十秒通常需排查
   */
  lag_seconds: number | null
  /** 上次重放事务的时间戳（PG 字面量） */
  last_replay_ts: string | null
  /** version() —— 第一次接入或排查时有用 */
  server_version: string | null
  /** 任何探测失败的可读原因 */
  error: string | null
  /** 后端探测完成时间（ISO 8601） */
  probed_at: string
}

export const tableAPI = {
  // 获取记录（支持分页、排序、筛选）
  getRecords: (schema: string, table: string, params?: any) =>
    api.get(`/api/${schema}/${table}`, { params }),
  
  // 创建记录
  createRecord: (schema: string, table: string, data: any) =>
    api.post(`/api/${schema}/${table}`, data),
  
  // 更新记录（通过主键条件）
  updateRecord: (schema: string, table: string, conditions: Record<string, any>, data: any) =>
    api.patch(`/api/${schema}/${table}`, data, { params: conditions }),
  
  // 删除记录（通过主键条件）
  deleteRecord: (schema: string, table: string, conditions: Record<string, any>) =>
    api.delete(`/api/${schema}/${table}`, { params: conditions }),
  
  // 批量创建记录
  createRecords: (schema: string, table: string, records: any[]) =>
    api.post(`/api/${schema}/${table}`, records),
  
  // 获取表记录总数
  getRecordCount: (schema: string, table: string, filters?: Record<string, any>) =>
    api.get(`/api/${schema}/${table}`, { params: { ...filters, select: 'count(*)' } }),
  
  exportCSV: (schema: string, table: string, params?: any) =>
    api.get(`/api/export/csv/${schema}/${table}`, {
      params,
      responseType: 'blob',
    }),
  
  exportJSON: (schema: string, table: string, params?: any) =>
    api.get(`/api/export/json/${schema}/${table}`, { params }),
}

export const queryAPI = {
  /**
   * 执行原始 SQL。
   *
   * 参数：
   * - readOnly：only 模式，后端只允许 SELECT。
   * - acknowledgeDestructive：写 / DDL 类 SQL 必须设 `true`，否则后端 raw_sql_guard
   *   会直接拒。这个标志由前端"二次确认"弹窗触发——不是默认 true，避免误点。
   *
   * 适用场景：SQL 自由编辑器（/dashboard/query）。受管 UI（函数编辑器 /
   * 触发器面板 / 表设计器等）用 [`executeManaged`]，避免多套一层 modal。
   */
  execute: (sql: string, readOnly: boolean = false, acknowledgeDestructive: boolean = false) =>
    api.post('/query', {
      sql,
      read_only: readOnly,
      acknowledge_destructive: acknowledgeDestructive,
    }),

  /**
   * 受管 UI 发起的 DDL/DML（函数 / 触发器 / 扩展 / 表设计器 / 备份恢复 等），
   * 自动带 `acknowledge_destructive: true`。
   *
   * 与 [`execute`] 的边界：
   *   - `execute()` 给 SQL 自由编辑器用，DDL 必须由编辑器自己的 modal 主动设 ack；
   *   - `executeManaged()` 给"按钮 = 意图明确"的专用面板用——例如「编辑函数」
   *     弹窗里点保存、`window.confirm('确定要删除？')` 通过后点删除——UI 本身
   *     就是二次确认，再叠一个通用 modal 反而干扰。
   *
   * **不要**用 executeManaged 跑用户随手输入的 SQL；那条路必须经过显式确认。
   */
  executeManaged: (sql: string) =>
    api.post('/query', {
      sql,
      read_only: false,
      acknowledge_destructive: true,
    }),

  exportCSV: (sql: string) =>
    api.post('/api/export/sql/csv', { sql }, { responseType: 'blob' }),
}

export const transactionAPI = {
  execute: (operations: any[]) => api.post('/transaction', { operations }),
}

/**
 * RPC（存储过程调用）—— 与 Auto API 同款 URL：项目 ID 出现在路径里，
 * 一套规则覆盖表 CRUD 与 RPC，行为对齐 Supabase / PostgREST 的 `rpc/<fn>`。
 *
 * 默认走 POST：
 *   rpcAPI.call(databaseId, 'console_get_user_projects', { user_id: 123 })
 *
 * IMMUTABLE / STABLE 函数 + 想走 CDN 缓存时改成 GET：
 *   rpcAPI.call(databaseId, 'search_projects', { keyword: 'demo' }, { method: 'GET' })
 *   → GET /api/v1/{databaseId}/rpc/search_projects?keyword=%22demo%22
 *
 * 可选项：
 *   - method:        'POST'（默认）或 'GET'
 *   - schema:        指定 schema（默认 public）
 *                    POST 走 Content-Profile，GET 走 Accept-Profile
 *   - singleObject:  Prefer: params=single-object，把 body 整体当成 jsonb 单参（仅 POST）
 *
 * 返回值结构对齐 PostgREST：
 *   - RETURNS void          → null
 *   - RETURNS scalar        → 标量值
 *   - RETURNS RECORD/复合   → 单个对象
 *   - SETOF / TABLE         → 数组
 */
export const rpcAPI = {
  call: <T = unknown>(
    databaseId: number,
    fnName: string,
    args: Record<string, unknown> = {},
    options: {
      method?: 'POST' | 'GET'
      schema?: string
      singleObject?: boolean
      suppressErrorToast?: boolean
    } = {},
  ) => {
    const method = options.method ?? 'POST'
    const headers: Record<string, string> = {}
    if (options.schema) {
      headers[method === 'GET' ? 'Accept-Profile' : 'Content-Profile'] = options.schema
    }
    if (options.singleObject && method === 'POST') {
      headers['Prefer'] = 'params=single-object'
    }

    const url = `/api/v1/${databaseId}/rpc/${encodeURIComponent(fnName)}`
    const config = { headers, suppressErrorToast: options.suppressErrorToast } as any

    if (method === 'GET') {
      // 后端 GET 模式下每个 value 会先做 JSON 解析；这里把非字符串值按 JSON 序列化
      // 才能正确还原（数字 / bool / 数组 / 对象）；字符串保持原样让 URL 编码即可。
      const params: Record<string, string> = {}
      for (const [k, v] of Object.entries(args)) {
        params[k] = typeof v === 'string' ? v : JSON.stringify(v)
      }
      return api.get<T>(url, { ...config, params })
    }

    return api.post<T>(url, args, config)
  },
}

/**
 * RPC 细粒度授权（ACL）—— 后端把 management.permissions / role_permissions 封装成
 * "RPC 视角"的三件套，省掉前端手工拼底层 RBAC。
 *
 * 资源命名约定：resource = `<schema>.<function_name>`，action = `EXECUTE`。
 * 配置策略（opt-in）：
 *   - 函数从未配过任何 EXECUTE 行 → 兼容模式，任何登录用户都能调
 *   - 一旦配过任何角色 → 立即转严格模式，未授权角色拿到 403
 */
export interface RpcAclEntry {
  permission_id: number
  schema: string
  function_name: string
  resource: string
  role_id: number
  role_name: string
}

export const rpcAclAPI = {
  list: (databaseId: number, schema?: string) =>
    api.get<RpcAclEntry[]>('/api/admin/rpc-acls', {
      params: { database_id: databaseId, ...(schema ? { schema } : {}) },
    }),

  grant: (data: {
    database_id: number
    schema: string
    function_name: string
    role_id: number
  }) => api.post<RpcAclEntry>('/api/admin/rpc-acls', data),

  revoke: (permissionId: number, roleId: number) =>
    api.delete('/api/admin/rpc-acls', {
      params: { permission_id: permissionId, role_id: roleId },
    }),
}

export const monitorAPI = {
  getDatabaseStats: () => api.get('/api/monitor/stats'),

  getTableSizes: (limit?: number) =>
    api.get('/api/monitor/table-sizes', { params: { limit } }),

  getSlowQueries: (duration_ms?: number) =>
    api.get('/api/monitor/slow-queries', { params: { duration_ms } }),

  getActiveConnections: () => api.get('/api/monitor/connections'),
}

// 查询性能 / 慢查询日志相关接口（依赖 pg_stat_statements 扩展 + pg_stat_activity）
export interface QueryPerfExtensionStatus {
  installed: boolean
  available: boolean
  version: string | null
  install_hint: string | null
  shared_preload: string | null
}

export interface StatementStat {
  queryid: number | null
  query: string
  calls: number
  total_exec_time: number
  mean_exec_time: number
  min_exec_time: number
  max_exec_time: number
  stddev_exec_time: number
  rows: number
  shared_blks_hit: number
  shared_blks_read: number
  hit_ratio: number
}

export interface ActiveQuery {
  pid: number
  user: string
  database: string
  client_addr: string | null
  application_name: string
  state: string
  query: string
  duration_seconds: number
  wait_event_type: string | null
  wait_event: string | null
}

export const queryPerfAPI = {
  getExtensionStatus: () =>
    api.get<QueryPerfExtensionStatus>('/api/query-perf/extension'),

  listStatements: (params: {
    order_by?: 'mean_exec_time' | 'total_exec_time' | 'calls' | 'rows' | 'max_exec_time'
    limit?: number
    offset?: number
    min_calls?: number
    min_mean_ms?: number
    search?: string
  } = {}) =>
    api.get<StatementStat[]>('/api/query-perf/statements', { params }),

  resetStatements: () => api.post('/api/query-perf/statements/reset'),

  listActiveQueries: (params: { min_duration_ms?: number; limit?: number } = {}) =>
    api.get<ActiveQuery[]>('/api/query-perf/active', { params }),

  cancelActiveQuery: (pid: number, terminate = false) =>
    api.post(`/api/query-perf/active/${pid}/cancel`, undefined, {
      params: { terminate },
    }),
}

/**
 * 定时任务（Scheduled Tasks）—— 平台内置 cron 调度。
 *
 * 任务可调 PG 函数（RPC）或发起 HTTP 请求；多实例部署下用 PostgreSQL
 * `FOR UPDATE SKIP LOCKED` 保证去重；详见后端 spec
 * `docs/superpowers/specs/2026-05-14-scheduled-tasks-design.md`。
 */
export interface ScheduledTask {
  id: number
  tenant_id: number | null
  name: string
  description: string | null
  cron_expr: string
  timezone: string
  kind: 'rpc' | 'http' | 'shell'
  database_id: number | null
  rpc_schema: string | null
  rpc_fn_name: string | null
  rpc_args: Record<string, unknown> | null
  http_method: string | null
  http_url: string | null
  http_headers: Record<string, unknown> | null
  http_body: unknown
  /** 后端返回时若任务已配 secret 会是 "***"，否则 null —— 明文绝不回显。 */
  http_secret_enc: string | null
  // ── kind='shell' 专属；其它 kind 始终 null ──
  /** 解释器二进制名（白名单：sh/bash/dash/zsh/python3/node/ruby）。null → /bin/sh */
  shell_interpreter: string | null
  /** 脚本内容；kind='shell' 时由后端 CHECK 保证非空 */
  shell_script: string | null
  /** 注入子进程的环境变量（JSON object，key/val 都是字符串） */
  shell_env: Record<string, unknown> | null
  /** 子进程工作目录；null → 沙盒内的 /tmp */
  shell_cwd: string | null
  is_active: boolean
  timeout_secs: number
  max_retries: number
  overlap_policy: 'skip' | 'allow'
  next_run_at: string | null
  last_run_at: string | null
  last_run_status: string | null
  claimed_at: string | null
  claimed_by: string | null
  created_by: number
  created_at: string
  updated_at: string
}

export interface ScheduledTaskRun {
  id: number
  task_id: number
  started_at: string
  finished_at: string | null
  status: 'running' | 'success' | 'failed' | 'timeout' | 'cancelled'
  runner_id: string | null
  output: unknown
  error_message: string | null
  duration_ms: number | null
  attempt_number: number
  triggered_by: 'cron' | 'manual'
}

export interface CreateScheduledTaskInput {
  tenant_id?: number | null
  name: string
  description?: string
  cron_expr: string
  timezone?: string
  kind: 'rpc' | 'http' | 'shell'
  database_id?: number
  rpc_schema?: string
  rpc_fn_name?: string
  rpc_args?: Record<string, unknown>
  http_method?: string
  http_url?: string
  http_headers?: Record<string, unknown>
  http_body?: unknown
  http_secret?: string
  /** kind='shell' 专属：解释器白名单（sh/bash/dash/zsh/python3/node/ruby），留空 → /bin/sh */
  shell_interpreter?: string
  /** kind='shell' 专属：脚本内容；后端要求 trim() 非空。
   *  鉴权（自 migration 017）：平台级仅超管；租户级允许该租户 owner/admin。 */
  shell_script?: string
  /** kind='shell' 专属：环境变量 JSON object（key/val 字符串） */
  shell_env?: Record<string, unknown>
  /** kind='shell' 专属：子进程 cwd；留空 → 沙盒内的 /tmp */
  shell_cwd?: string
  timeout_secs?: number
  max_retries?: number
  overlap_policy?: 'skip' | 'allow'
}

export interface UpdateScheduledTaskInput {
  name?: string
  description?: string
  cron_expr?: string
  timezone?: string
  rpc_args?: Record<string, unknown>
  http_headers?: Record<string, unknown>
  http_body?: unknown
  /** 传非空字符串会覆盖；传 undefined / 空串保留原值。明文密文不回显。 */
  http_secret?: string
  // shell 字段允许在 update 时修改（脚本迭代场景）；后端走 COALESCE 语义，
  // undefined → 保留原值；显式传值 → 覆盖。
  shell_interpreter?: string
  shell_script?: string
  shell_env?: Record<string, unknown>
  shell_cwd?: string
  timeout_secs?: number
  max_retries?: number
  overlap_policy?: 'skip' | 'allow'
  is_active?: boolean
}

export interface ScheduledTaskStats {
  total_tasks: number
  active_tasks: number
  runs_24h: number
  failed_24h: number
}

export interface CronValidationResult {
  valid: boolean
  timezone: string
  /** ISO 8601 时间戳数组，前 5 个触发点。 */
  preview: string[]
}

export const scheduledTaskAPI = {
  list: (params?: {
    tenant_id?: number
    kind?: 'rpc' | 'http' | 'shell'
    is_active?: boolean
    limit?: number
    offset?: number
  }) => api.get<ScheduledTask[]>('/api/admin/scheduled-tasks', { params }),

  get: (id: number) =>
    api.get<{ task: ScheduledTask; recent_runs: ScheduledTaskRun[] }>(
      `/api/admin/scheduled-tasks/${id}`,
    ),

  create: (data: CreateScheduledTaskInput) =>
    api.post<ScheduledTask>('/api/admin/scheduled-tasks', data),

  update: (id: number, data: UpdateScheduledTaskInput) =>
    api.patch<ScheduledTask>(`/api/admin/scheduled-tasks/${id}`, data),

  delete: (id: number) =>
    api.delete<{ deleted: boolean; id: number }>(`/api/admin/scheduled-tasks/${id}`),

  pause: (id: number) =>
    api.post<{ id: number; is_active: boolean }>(
      `/api/admin/scheduled-tasks/${id}/pause`,
    ),

  resume: (id: number) =>
    api.post<{ id: number; is_active: boolean }>(
      `/api/admin/scheduled-tasks/${id}/resume`,
    ),

  /** 立即触发一次（triggered_by='manual'）；后端异步派发，不阻塞调用。 */
  runNow: (id: number) =>
    api.post<{ triggered: boolean; id: number }>(
      `/api/admin/scheduled-tasks/${id}/run-now`,
    ),

  listRuns: (
    id: number,
    params?: { limit?: number; offset?: number },
  ) => api.get<ScheduledTaskRun[]>(`/api/admin/scheduled-tasks/${id}/runs`, { params }),

  /** 仅超管可调。 */
  stats: () => api.get<ScheduledTaskStats>('/api/admin/scheduled-tasks/stats'),

  validateCron: (cron_expr: string, timezone?: string) =>
    api.post<CronValidationResult>(
      '/api/admin/scheduled-tasks/validate-cron',
      { cron_expr, ...(timezone ? { timezone } : {}) },
      { suppressErrorToast: true } as ApiRequestConfig,
    ),

  /** 仅超管可调；将卡在 running 状态超过 older_than_hours 的 run 标 timeout。 */
  cleanupZombies: (older_than_hours?: number) =>
    api.post<{ cleaned: number }>(
      '/api/admin/scheduled-tasks/runs/cleanup-zombies',
      older_than_hours !== undefined ? { older_than_hours } : {},
    ),

  /**
   * 试运行：把当前表单里的"未保存任务"喂给后端 executor 跑一次，不写 DB。
   * 鉴权与 create 一致：平台级 → 超管；租户级 → 该租户 owner/admin（含 shell，自 017 起）。
   * `suppressErrorToast`：试运行失败（exit_code != 0、HTTP 5xx 等）应在表单内联展示，
   * 而不是触发全局 toast —— 避免覆盖用户正在写的脚本。
   */
  dryRun: (input: CreateScheduledTaskInput) =>
    api.post<{
      dry_run: true
      status: 'success' | 'failed' | 'timeout'
      output: unknown
      error_message: string | null
      duration_ms: number
    }>('/api/admin/scheduled-tasks/dry-run', input, {
      suppressErrorToast: true,
    } as ApiRequestConfig),

  // ─────────────────────────────────────────────────────────────────────
  // 表单级别的内省助手（不是后端 scheduled-tasks 路由，而是用 X-Database-Id
  // 头打到 /api/schemas + /query 上）。目的是：表单里选完 database_id 后，
  // 立刻能拉出该库的 schemas / functions 给用户继续下拉，而不是让用户手敲。
  // 关键点：必须 per-request 把 X-Database-Id 显式传进去，因为表单想看的
  // 库通常**不是**当前侧边栏选中的 current_connection。
  // ─────────────────────────────────────────────────────────────────────

  /** 列出某个 database_id 下可见的 schema（已剔除 pg_*、information_schema）。 */
  listSchemasForDb: (databaseId: number) =>
    api.get<Array<{ schema_name: string; table_count: number }>>('/api/schemas', {
      headers: { 'X-Database-Id': databaseId.toString() },
    } as ApiRequestConfig),

  /**
   * 列出某个 database_id + schema 下的函数 / procedure（pg_proc 内省）。
   * 与 dashboard/rpc 页同口径，过滤掉扩展自带的函数后台再叠加。
   *
   * /query 端点目前只接受 { sql, read_only }，不支持 bind param，所以这里
   * 走"白名单 + 单引号转义"的双重防御：
   *   1) 调用方传入的 schema 必须匹配 [A-Za-z0-9_$] —— PG 合法 identifier 字符；
   *      不匹配直接 reject 而不是走查询（防御 ReDoS 与脏数据），即使 schema
   *      是从后端 listSchemasForDb 来的也兜底校验。
   *   2) 通过后再把单引号 doubled 一遍，写入字符串字面量。
   */
  listFunctionsForDb: (databaseId: number, schema: string) => {
    if (!/^[A-Za-z0-9_$]+$/.test(schema)) {
      return Promise.reject(new Error(`非法 schema 名: ${schema}`))
    }
    const literal = schema.replace(/'/g, "''")
    return api.post<{
      data: Array<{
        schema_name: string
        function_name: string
        return_type: string
        argument_types: string
        function_type: string
        extension_name: string | null
      }>
    }>(
      '/query',
      {
        sql: `
          SELECT
            n.nspname  AS schema_name,
            p.proname  AS function_name,
            pg_get_function_result(p.oid)    AS return_type,
            pg_get_function_arguments(p.oid) AS argument_types,
            CASE p.prokind WHEN 'f' THEN 'function' WHEN 'p' THEN 'procedure' END AS function_type,
            e.extname AS extension_name
          FROM pg_proc p
          JOIN pg_namespace n ON p.pronamespace = n.oid
          LEFT JOIN pg_depend d
            ON d.objid = p.oid
           AND d.deptype = 'e'
           AND d.classid = 'pg_proc'::regclass
          LEFT JOIN pg_extension e ON e.oid = d.refobjid
          WHERE n.nspname = '${literal}'
            AND p.prokind IN ('f', 'p')
          ORDER BY p.proname
        `,
        read_only: true,
      },
      { headers: { 'X-Database-Id': databaseId.toString() } } as ApiRequestConfig,
    )
  },
}

// Auto API - 自动生成的 RESTful API
export const autoAPI = {
  // 获取记录列表
  list: (databaseId: number, schema: string, table: string, params?: {
    select?: string
    order?: string
    limit?: number
    offset?: number
    [key: string]: any // 其他过滤条件
  }) => api.get(`/api/v1/${databaseId}/${schema}/${table}`, { params }),
  
  // 获取单条记录
  get: (databaseId: number, schema: string, table: string, id: string | number, params?: {
    select?: string
  }) => api.get(`/api/v1/${databaseId}/${schema}/${table}/${id}`, { params }),
  
  // 创建记录
  create: (databaseId: number, schema: string, table: string, data: any) =>
    api.post(`/api/v1/${databaseId}/${schema}/${table}`, data),
  
  // 更新记录
  update: (databaseId: number, schema: string, table: string, id: string | number, data: any) =>
    api.patch(`/api/v1/${databaseId}/${schema}/${table}/${id}`, data),
  
  // 删除记录
  delete: (databaseId: number, schema: string, table: string, id: string | number) =>
    api.delete(`/api/v1/${databaseId}/${schema}/${table}/${id}`),
}

// RBAC 权限管理
export const rbacAPI = {
  // === 角色管理 ===
  listRoles: () => api.get('/api/rbac/roles'),
  createRole: (data: { name: string; description?: string }) =>
    api.post('/api/rbac/roles', data),
  updateRole: (id: number, data: { name?: string; description?: string }) =>
    api.patch(`/api/rbac/roles/${id}`, data),
  deleteRole: (id: number) => api.delete(`/api/rbac/roles/${id}`),

  // === 角色权限关联 ===
  getRolePermissions: (roleId: number) =>
    api.get(`/api/rbac/roles/${roleId}/permissions`),
  setRolePermissions: (roleId: number, permissionIds: number[]) =>
    api.put(`/api/rbac/roles/${roleId}/permissions`, { permission_ids: permissionIds }),

  // === 权限管理 ===
  listPermissions: () => api.get('/api/rbac/permissions'),
  createPermission: (data: {
    resource: string
    action: string
    conditions?: string[]
    allowed_columns?: string[]
    denied_columns?: string[]
    description?: string
  }) => api.post('/api/rbac/permissions', data),
  updatePermission: (id: number, data: {
    resource?: string
    action?: string
    conditions?: string[]
    allowed_columns?: string[] | null
    denied_columns?: string[]
    description?: string
  }) => api.patch(`/api/rbac/permissions/${id}`, data),
  deletePermission: (id: number) => api.delete(`/api/rbac/permissions/${id}`),

  // === 用户角色 ===
  getUserRoles: (userId: number) => api.get(`/api/rbac/users/${userId}/roles`),
  assignUserRole: (userId: number, data: { role_id: number; tenant_id: number }) =>
    api.post(`/api/rbac/users/${userId}/roles`, data),
  removeUserRole: (userId: number, roleId: number) =>
    api.delete(`/api/rbac/users/${userId}/roles/${roleId}`),
}

// SSO 管理
export const ssoAPI = {
  // 公开：获取可用的 SSO 登录方式
  listPublicProviders: (tenantId?: number) =>
    api.get(`/auth/sso/providers${tenantId ? `?tenant_id=${tenantId}` : ''}`),

  // 公开：发起 SSO 授权
  authorize: (provider: string, tenantId?: number, redirectUrl?: string) => {
    const params = new URLSearchParams()
    if (tenantId) params.set('tenant_id', String(tenantId))
    if (redirectUrl) params.set('redirect_url', redirectUrl)
    return api.get(`/auth/sso/${provider}/authorize?${params.toString()}`)
  },

  // 管理：列出全部 Provider
  listProviders: () => api.get('/api/sso/providers'),

  // 管理：创建 Provider
  createProvider: (data: {
    provider_type: string
    display_name: string
    client_id: string
    client_secret: string
    authorization_url?: string
    token_url?: string
    userinfo_url?: string
    scopes?: string
  }) => api.post('/api/sso/providers', data),

  // 管理：更新 Provider
  updateProvider: (id: number, data: {
    display_name?: string
    client_id?: string
    client_secret?: string
    authorization_url?: string
    token_url?: string
    userinfo_url?: string
    scopes?: string
    is_active?: boolean
  }) => api.patch(`/api/sso/providers/${id}`, data),

  // 管理：删除 Provider
  deleteProvider: (id: number) => api.delete(`/api/sso/providers/${id}`),
}

// API Key 管理
export const apiKeyAPI = {
  // 获取项目的所有 API Keys
  list: (databaseId: number) => api.get(`/api/admin/api-keys/${databaseId}`),
  
  // 创建新的 API Key
  create: (databaseId: number, data: {
    name: string
    permissions?: { read?: boolean; write?: boolean; delete?: boolean }
    expires_in_days?: number
  }) => api.post(`/api/admin/api-keys/${databaseId}`, data),
  
  // 更新 API Key (启用/禁用)
  update: (databaseId: number, keyId: number, data: { is_active: boolean }) =>
    api.patch(`/api/admin/api-keys/${databaseId}/${keyId}`, data),
  
  // 删除 API Key
  delete: (databaseId: number, keyId: number) =>
    api.delete(`/api/admin/api-keys/${databaseId}/${keyId}`),
}

// ─── Elasticsearch 反向代理 ───────────────────────────────────────────
//
// 业务端拿"平台代理 URL + cres_es_xxx token"访问 ES，永远见不到真实 ES 地址 /
// ApiKey。两套类型分别对应：
//   - EsConnection：管理员视角的连接配置（含 verify_tls / timeout 等运维参数）
//   - EsAccessToken：业务端视角的访问凭据（含 method/index/path 三层 ACL）
//
// 注意 `auth_credential_enc` / `token_hash` 不会出现在 API 响应里（后端
// `#[serde(skip_serializing)]`），所以 TS 类型也不暴露这两个字段。
export interface EsConnection {
  id: number
  tenant_id: number
  connection_name: string
  base_url: string
  /** 'api_key' | 'basic' | 'none' */
  auth_type: 'api_key' | 'basic' | 'none'
  verify_tls: boolean
  default_timeout_secs: number
  is_active: boolean
  created_by: number
  created_at: string
  updated_at: string
}

export interface EsAccessToken {
  id: number
  connection_id: number
  name: string
  description: string | null
  /** token 前 16 字符；用于列表区分，**不能用来鉴权** */
  token_prefix: string
  allowed_methods: string[]
  /** ['*'] = 不限。元素支持 `*` `?` glob */
  index_allowlist: string[]
  /** POSIX 正则数组；任一命中即拒 */
  path_denylist: string[]
  expires_at: string | null
  last_used_at: string | null
  use_count: number
  is_active: boolean
  revoked_at: string | null
  created_by: number
  created_at: string
}

export interface CreateEsConnectionInput {
  tenant_id: number
  connection_name: string
  base_url: string
  auth_type: 'api_key' | 'basic' | 'none'
  /** 明文凭据；后端加密入库。auth_type='none' 时留空 */
  credential?: string | null
  verify_tls?: boolean
  default_timeout_secs?: number
}

export interface UpdateEsConnectionInput {
  connection_name?: string
  base_url?: string
  auth_type?: 'api_key' | 'basic' | 'none'
  /** null = 保留原凭据；非空 = 替换；'' = 仅在切到 none 时配合清空 */
  credential?: string | null
  verify_tls?: boolean
  default_timeout_secs?: number
  is_active?: boolean
}

export interface CreateEsTokenInput {
  name: string
  description?: string
  allowed_methods?: string[]
  index_allowlist?: string[]
  path_denylist?: string[]
  /** ISO8601；不传 = 永不过期 */
  expires_at?: string
}

export interface UpdateEsTokenInput {
  name?: string
  description?: string
  allowed_methods?: string[]
  index_allowlist?: string[]
  path_denylist?: string[]
  expires_at?: string | null
  is_active?: boolean
}

export const esAPI = {
  // ── 连接 CRUD ──
  listConnections: (tenantId?: number) =>
    api.get<EsConnection[]>('/api/admin/es-connections', {
      params: tenantId !== undefined ? { tenant_id: tenantId } : undefined,
    }),
  getConnection: (id: number) => api.get<EsConnection>(`/api/admin/es-connections/${id}`),
  createConnection: (input: CreateEsConnectionInput) =>
    api.post<EsConnection>('/api/admin/es-connections', input),
  updateConnection: (id: number, input: UpdateEsConnectionInput) =>
    api.put<EsConnection>(`/api/admin/es-connections/${id}`, input),
  deleteConnection: (id: number) =>
    api.delete<{ deleted: number }>(`/api/admin/es-connections/${id}`),

  /**
   * 对上游 ES 探活一次；失败返回 ServiceUnavailable。
   * `suppressErrorToast` 让前端能在表单内联展示错误而不被全局 toast 覆盖。
   */
  healthCheck: (id: number) =>
    api.post<{
      status_code: number
      ok: boolean
      cluster_name: unknown
      version: unknown
      raw: string | null
    }>(`/api/admin/es-connections/${id}/health`, {}, {
      suppressErrorToast: true,
    } as ApiRequestConfig),

  // ── Token CRUD ──
  listTokens: (connectionId: number) =>
    api.get<EsAccessToken[]>(`/api/admin/es-connections/${connectionId}/tokens`),
  /**
   * 创建 token；响应里的 `token` 字段是明文（cres_es_xxx），**仅此一次**
   * 出现在 API 响应里。前端必须立刻显示并让用户复制保存。
   */
  createToken: (connectionId: number, input: CreateEsTokenInput) =>
    api.post<{ token: string; record: EsAccessToken }>(
      `/api/admin/es-connections/${connectionId}/tokens`,
      input,
    ),
  updateToken: (connectionId: number, tokenId: number, input: UpdateEsTokenInput) =>
    api.patch<EsAccessToken>(
      `/api/admin/es-connections/${connectionId}/tokens/${tokenId}`,
      input,
    ),
  deleteToken: (connectionId: number, tokenId: number) =>
    api.delete<{ deleted: number }>(
      `/api/admin/es-connections/${connectionId}/tokens/${tokenId}`,
    ),
}

