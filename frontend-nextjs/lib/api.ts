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
      //   2) 平台超管在 /platform 视图下手动切换 tenant 也能命中正确数据；
      //   3) 工作空间（/workspace/:projectId/...）下进入项目即代表锁定租户。
      // 后端 `permissions::TenantContext` 提取器 +query 兜底，可以选择性传 `?tenant_id=`。
      //
      // 解析优先级：
      //   1) 调用方显式塞的 X-Tenant-Id（不覆盖）
      //   2) localStorage.current_tenant（dashboard / platform 视图）
      //   3) localStorage.current_project.id（workspace 视图——W2 不变量
      //      projectId === tenant_id（项目即租户）。注意 **不等于** database_id：
      //      tenants.id 与 tenant_databases.id 是两个独立自增序列，只有 M2 自助
      //      开通的新项目恰好相等，老租户几乎一定不等——database_id 必须从项目主
      //      连接拿（见 settings/connections）。layout 进项目时会清掉 current_tenant，
      //      但 current_project 仍然写在那里）
      // 没有第 3 步兜底的话，superadmin 在 workspace 下访问 RBAC / SSO /
      // Webhook 等租户级接口会触发后端 "超管必须显式指定租户" 的 400。
      const hasExplicitTenant =
        config.headers['X-Tenant-Id'] !== undefined ||
        config.headers['x-tenant-id'] !== undefined
      if (!hasExplicitTenant) {
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
        if (config.headers['X-Tenant-Id'] === undefined) {
          const currentProject = localStorage.getItem('current_project')
          if (currentProject) {
            try {
              const project = JSON.parse(currentProject)
              if (project && project.id) {
                config.headers['X-Tenant-Id'] = project.id.toString()
              }
            } catch (e) {
              console.error('解析 current_project 失败:', e)
            }
          }
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
        // 顺手清掉项目壳 (W1) 用的 currentProject 缓存，避免下次登录后
        // /workspace/[id] layout 用陈旧 user_role 派生能力门槛
        try {
          localStorage.removeItem('current_project')
        } catch {}
        // 仅在不是登录页本身时跳转，避免循环
        if (!window.location.pathname.startsWith('/login')) {
          // W1 §3.3：401 不再弹 toast——跳转本身已经是足够明显的信号，
          // 让红条在离开页面前闪一下纯粹是噪音。错误对象仍打 __toastShown
          // 让组件层 useNotification().error(err) 不会重复加 toast。
          error.__toastShown = true
          window.location.href = '/login'
        }
      }
      return Promise.reject(error)
    }

    if (status === 403) {
      // 强制改密网关：账号需先修改初始密码时，后端对业务端点返回 403 +
      // code=password_change_required。这里统一把用户送去改密页（避免直接
      // 打开内层 URL / 刷新时绕过登录页的跳转逻辑）。已在改密页则不再跳转，防止死循环。
      if (
        typeof window !== 'undefined' &&
        (error.response?.data as any)?.code === 'password_change_required' &&
        !window.location.pathname.startsWith('/change-password')
      ) {
        error.__toastShown = true
        window.location.href = '/change-password'
        return Promise.reject(error)
      }
      // W1 §3.3：403 默认静默。调用方若想 toast，自己 catch + showToast；
      // 工作空间页面会 catch 后渲染 <ForbiddenPlaceholder/>。这里 console.warn
      // 保留排障线索（method + url + body），生产环境 RUM 也能捞到。
      if (typeof console !== 'undefined') {
        console.warn(
          '[api] 403 Forbidden:',
          config.method?.toUpperCase(),
          config.url,
          error.response?.data,
        )
      }
      error.__toastShown = true
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

/** "函数管理"页拉到的函数 / 存储过程元数据。字段与后端 FunctionMetadata 对齐。 */
export interface FunctionMetadata {
  schema_name: string
  function_name: string
  return_type: string | null
  argument_types: string | null
  function_type: string | null
  volatility: string | null
  owner: string | null
  language: string | null
  source_code: string | null
  /** 非 NULL = 该函数随某 PG 扩展（citext / pg_trgm 等）安装进来；前端默认折叠隐藏。 */
  extension_name: string | null
}

/** "触发器管理"页拉到的触发器元数据。 */
export interface TriggerMetadata {
  trigger_name: string
  table_name: string
  action_timing: string | null
  event_manipulation: string | null
  action_orientation: string | null
  action_statement: string | null
  is_enabled: boolean
}

export const schemaAPI = {
  listSchemas: () => api.get('/api/schemas'),
  listTables: (schema: string) => api.get(`/api/schema/${schema}/tables`),
  getTableStructure: (schema: string, table: string) =>
    api.get(`/api/schema/${schema}/table/${table}/structure`),

  /**
   * 列函数 / 存储过程（GET /api/schema/:schema/functions）。
   *
   * 设计目的：让"函数管理"页脱离 `/query`（raw SQL 仅平台超管）通路，
   * 改走结构化只读接口；任意租户成员（含 viewer）都能看到列表。
   */
  listFunctions: (schema: string) =>
    api.get<FunctionMetadata[]>(`/api/schema/${schema}/functions`),

  /** 列触发器（GET /api/schema/:schema/triggers）。 */
  listTriggers: (schema: string) =>
    api.get<TriggerMetadata[]>(`/api/schema/${schema}/triggers`),

  // 创建新 schema
  createSchema: (name: string) => api.post('/api/schemas', { name }),
  
  // 删除 schema
  dropSchema: (schema: string, cascade: boolean = false) => 
    api.delete(`/api/schemas/${schema}`, { data: { cascade } }),
}

// ─── M3 可视化建表：项目级 DDL API（member+） ─────────────────────
//
// 与 /query 的关键差异：body 全结构化，server-side 拼 SQL，前端不传 raw SQL。
// 鉴权门槛 member+（canWriteDatabase）。详见 src/ddl_handlers.rs 文件头。

export interface DdlForeignKeyRef {
  schema: string
  table: string
  column: string
  on_delete?: 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT' | 'NO ACTION'
  on_update?: 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT' | 'NO ACTION'
}

export interface DdlColumnDef {
  name: string
  // 服务端白名单：smallint/integer/bigint/serial 系列 / numeric/real/double precision
  // text/varchar/char / boolean / date/time/timestamp/timestamptz / uuid / json/jsonb / bytea / inet
  data_type: string
  length?: number              // varchar(n) / char(n)
  precision?: number           // numeric(p,s)
  scale?: number
  nullable?: boolean           // 默认 true
  default_value?: string       // 字面量；'CURRENT_TIMESTAMP'/'NOW()'/'GEN_RANDOM_UUID()' 等会按表达式处理
  is_primary_key?: boolean
  is_unique?: boolean
  references?: DdlForeignKeyRef
}

export interface DdlIndexDef {
  name: string
  columns: string[]
  is_unique?: boolean
}

export interface CreateTableBody {
  schema: string
  table: string
  columns: DdlColumnDef[]
  indexes?: DdlIndexDef[]
}

export type AlterOp =
  | { kind: 'rename_table'; new_name: string }
  | { kind: 'add_column'; column: DdlColumnDef }
  | { kind: 'drop_column'; name: string; cascade?: boolean }
  | { kind: 'rename_column'; old_name: string; new_name: string }
  | { kind: 'alter_column_type'; name: string; column: DdlColumnDef }
  | { kind: 'set_not_null'; name: string; value: boolean }   // false → DROP NOT NULL
  | { kind: 'set_default'; name: string; value: string | null }  // null → DROP DEFAULT
  | { kind: 'add_unique'; name: string }

export const ddlAPI = {
  createTable: (body: CreateTableBody) => api.post('/api/ddl/tables', body),

  dropTable: (schema: string, table: string, cascade: boolean = false) =>
    api.delete(`/api/ddl/tables/${schema}/${table}`, {
      params: cascade ? { cascade: 'true' } : undefined,
    }),

  alterTable: (schema: string, table: string, operations: AlterOp[]) =>
    api.patch(`/api/ddl/tables/${schema}/${table}`, { operations }),
}

/** v1 对外 DDL API（JWT 或 API Key；Key 须在 scope 中勾选 DDL 或 ALL） */
export const ddlV1API = {
  createTable: (databaseSlug: string, body: CreateTableBody) =>
    api.post(`/api/v1/${databaseSlug}/ddl/tables`, body),

  dropTable: (
    databaseSlug: string,
    schema: string,
    table: string,
    cascade: boolean = false,
  ) =>
    api.delete(`/api/v1/${databaseSlug}/ddl/tables/${schema}/${table}`, {
      params: cascade ? { cascade: 'true' } : undefined,
    }),

  alterTable: (databaseSlug: string, schema: string, table: string, operations: AlterOp[]) =>
    api.patch(`/api/v1/${databaseSlug}/ddl/tables/${schema}/${table}`, { operations }),
}

export interface RawDdlRequestBody {
  sql: string
  /** 用于 API Key Resources scope 校验，默认 public */
  schema?: string
  acknowledge_destructive: boolean
}

/** v1 对外 raw DDL（直接提交 CREATE/ALTER/DROP SQL 文本） */
export const sqlV1API = {
  execute: (databaseSlug: string, body: RawDdlRequestBody) =>
    api.post(`/api/v1/${databaseSlug}/sql`, body),
}

// ─── M6 项目级简化大盘 ─────────────────────────────────────────
//
// 鉴权 = 任意租户角色（含 viewer）。两个 endpoint 只返回聚合数字 + sanitized 路径，
// 不暴露行级业务数据。详见 src/dashboard_handlers.rs 文件头。

export interface DashboardHourlyBucket {
  hour_utc: string  // rfc3339，UTC 整点
  count: number
  err_5xx: number
}

export interface DashboardOverview {
  qps_5min: number
  p95_ms_5min: number | null
  error_rate_24h: number | null    // 0.0-1.0；null 表示 24h 内 0 调用
  slow_queries_24h: number
  active_api_keys: number
  calls_24h: number
  hourly_24h: DashboardHourlyBucket[]  // 总是 24 条
}

export interface DashboardActivityRow {
  id: number
  action: string
  resource: string
  request_method: string
  response_status: number | null
  duration_ms: number | null
  created_at: string  // rfc3339
}

export const dashboardAPI = {
  getOverview: (tenantId: number) =>
    api.get<DashboardOverview>('/api/dashboard/overview', {
      params: { tenant_id: tenantId },
    }),
  getRecentActivity: (tenantId: number, limit: number = 10) =>
    api.get<DashboardActivityRow[]>('/api/dashboard/recent-activity', {
      params: { tenant_id: tenantId, limit },
    }),
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
    slug?: string
    db_host: string
    db_port: number
    db_name: string
    db_user: string
    db_password: string
    is_primary: boolean
    max_connections?: number
    connection_timeout?: number
  }) => api.post('/api/tenants/connections', data),

  // 更新数据库连接配置：名称 / 路由 slug / 连接池参数，以及实际连接目标
  // （host / port / db / user / password）。后端走 COALESCE 语义——未传字段不变；
  // db_password 留空（不传或空串）表示不修改密码。owner/admin/超管可调。
  updateConnection: (
    databaseSlug: string | number,
    data: {
      connection_name?: string
      slug?: string
      db_host?: string
      db_port?: number
      db_name?: string
      db_user?: string
      db_password?: string
      max_connections?: number
      connection_timeout?: number
    },
  ) => api.patch(`/api/tenants/connections/${encodeURIComponent(String(databaseSlug))}`, data),

  // 删除数据库连接（owner/admin/超管）
  deleteConnection: (databaseSlug: string | number) =>
    api.delete(`/api/tenants/connections/${encodeURIComponent(String(databaseSlug))}`),

  // 调整连接顺序：按 orderedIds 顺序写回 sort_order
  reorderConnections: (tenantId: number, orderedIds: number[]) =>
    api.post('/api/tenants/connections/reorder', { tenant_id: tenantId, ordered_ids: orderedIds }),

  // 切换到指定的数据库连接
  switchConnection: (databaseId: number) => 
    api.post('/api/tenants/switch-connection', { database_id: databaseId }),
  
  // 获取连接池统计信息
  getPoolStats: () => api.get('/api/tenants/pool-stats'),
}

// ─── W4 / PASE Stage E：项目维度自助元信息 + 成员管理 ─────────────────────

export interface ProjectMember {
  user_id: number
  username: string
  email: string
  is_superadmin: boolean
  is_active: boolean
  role: 'owner' | 'admin' | 'member' | 'viewer'
  created_at: string
}

export interface ProjectPatchBody {
  name?: string
  contact_email?: string
  workspace_config?: Record<string, unknown> | null
}

/** 项目元信息：只允许 owner / superadmin 改 name / contact_email / workspace_config。
 *  slug / kind / status / db_* 仍由 `/api/admin/tenants/:id` 走平台超管路径。*/
export const projectAPI = {
  patch: (projectId: number, body: ProjectPatchBody) =>
    api.patch(`/api/projects/${projectId}`, body),
}

// ─── M2 自助开通向导：PG 池 + 模板 + provision ─────────────────────────

/** 超管视角的 PG 池条目（不含密码字段）。 */
export interface PgPoolAdminEntry {
  id: number
  name: string
  db_host: string
  db_port: number
  admin_user: string
  note: string | null
  is_active: boolean
}

/** 用户视角的 PG 池条目（admin_user / 密码均剥除）。 */
export interface PgPoolPublicEntry {
  id: number
  name: string
  db_host: string
  db_port: number
  note: string | null
  is_platform_instance?: boolean
}

/** 当前 Onebase 平台自身 PG 实例（不含凭据）。 */
export interface PlatformPgInstance {
  available: boolean
  db_host?: string
  db_port?: number
  management_db_name?: string
  matching_pool_id?: number | null
  provision_ready?: boolean
  provision_error?: string | null
}

export interface CreatePgPoolBody {
  name: string
  db_host: string
  db_port?: number
  admin_user: string
  admin_password: string
  note?: string | null
}

export interface UpdatePgPoolBody {
  name?: string
  db_host?: string
  db_port?: number
  admin_user?: string
  /** 空字符串视为"不修改密码" */
  admin_password?: string
  note?: string | null
  is_active?: boolean
}

/** 项目模板（wizard step 1/4）。is_coming_soon=true 的卡片需灰掉禁选。 */
export interface ProjectTemplate {
  id: number
  slug: string
  name: string
  description: string | null
  scenario: string
  is_coming_soon: boolean
  sort_order: number
}

export interface ManualPgConnection {
  db_host: string
  db_port?: number
  admin_user: string
  admin_password: string
}

export interface ProvisionWebhookConfig {
  enabled: boolean
  supports_redis?: boolean
  supports_async_poll?: boolean
  poll_interval_secs?: number
  poll_max_secs?: number
  description?: string
}

export interface ProvisionWebhookAdminStatus {
  provision_webhook_enabled: boolean
  supports_redis?: boolean
  deprovision_url_configured: boolean
  token_configured: boolean
  timeout_secs: number
  poll_interval_secs?: number
  poll_max_secs?: number
  supports_async_poll?: boolean
  description?: string
}

export interface ProvisionWebhookProbeResult {
  ok: boolean
  http_status?: number
  message?: string
  error?: string
}

export interface ProvisionRequestBody {
  name: string
  slug: string
  pg_pool_id?: number
  pg_connection?: ManualPgConnection
  template_slug: string
  scenario?: string
}

export interface ProvisionResponse {
  provisioned: boolean
  project_id: number
  slug: string
  name: string
  database_id: number | null
  db_name: string | null
  user_role: string
}

export const projectTemplateAPI = {
  list: () => api.get<ProjectTemplate[]>('/api/project-templates'),
}

export const projectProvisionAPI = {
  provision: (body: ProvisionRequestBody) =>
    api.post<ProvisionResponse>('/api/projects/provision', body),
}

/** PG 池：超管 CRUD + 用户视角只读。 */
export const pgPoolAPI = {
  listAll: () => api.get<PgPoolAdminEntry[]>('/api/admin/pg-pools'),
  create: (body: CreatePgPoolBody) => api.post<PgPoolAdminEntry>('/api/admin/pg-pools', body),
  update: (id: number, body: UpdatePgPoolBody) =>
    api.patch<PgPoolAdminEntry>(`/api/admin/pg-pools/${id}`, body),
  remove: (id: number) => api.delete(`/api/admin/pg-pools/${id}`),
  /** 探活：用 admin 凭据 SELECT 1。返回 {ok, error?} 形式（200 即使 ok=false） */
  test: (id: number) => api.post<{ ok: boolean; error?: string }>(`/api/admin/pg-pools/${id}/test`),
  /** 用户视角：给 wizard 用的下拉数据 */
  listAvailable: () => api.get<PgPoolPublicEntry[]>('/api/provision/pg-pools/available'),
  /** 当前平台 PG 实例（开通向导默认选项） */
  platformInstance: () => api.get<PlatformPgInstance>('/api/provision/pg-pools/platform-instance'),
  /** 运维 Webhook 开通是否可用（不含 secret） */
  webhookConfig: () => api.get<ProvisionWebhookConfig>('/api/provision/webhook-config'),
  /** 超管：Webhook 配置状态（不含 URL / token） */
  adminWebhookStatus: () =>
    api.get<ProvisionWebhookAdminStatus>('/api/admin/provision/webhook-status'),
  adminWebhookProbe: () =>
    api.post<ProvisionWebhookProbeResult>('/api/admin/provision/webhook-probe'),
}

/** 添加成员对话框搜索用：精简过的用户视图 + already_member 标记。 */
export interface MemberCandidate {
  user_id: number
  username: string
  email: string
  is_superadmin: boolean
  /** 已经在本项目里——前端在结果里标灰，避免重复添加 */
  already_member: boolean
}

/** 项目成员管理：admin+ / superadmin。 */
export const projectMembersAPI = {
  list: (projectId: number) =>
    api.get<ProjectMember[]>(`/api/projects/${projectId}/members`),

  add: (projectId: number, body: { user_id: number; role: string }) =>
    api.post<ProjectMember>(`/api/projects/${projectId}/members`, body),

  /** 项目内直接新建账号并加入项目（面向未注册用户） */
  createUser: (
    projectId: number,
    body: { username: string; email: string; password: string; role: string },
  ) =>
    api.post<ProjectMember>(`/api/projects/${projectId}/members/create-user`, body),

  updateRole: (projectId: number, userId: number, role: string) =>
    api.patch<ProjectMember>(`/api/projects/${projectId}/members/${userId}`, { role }),

  remove: (projectId: number, userId: number) =>
    api.delete(`/api/projects/${projectId}/members/${userId}`),

  /** 按 username/email 搜可加为成员的候选人（q 至少 2 字符，限 20 条） */
  search: (projectId: number, q: string) =>
    api.get<MemberCandidate[]>(`/api/projects/${projectId}/members/search`, {
      params: { q },
    }),

  updateProfile: (
    projectId: number,
    userId: number,
    body: { username?: string; email?: string },
  ) =>
    api.patch<{ ok: boolean; user_id: number; username: string; email: string }>(
      `/api/projects/${projectId}/members/${userId}/profile`,
      body,
    ),

  resetPassword: (projectId: number, userId: number, newPassword: string) =>
    api.post<{ ok: boolean; message: string }>(
      `/api/projects/${projectId}/members/${userId}/reset-password`,
      { new_password: newPassword },
    ),

  updateStatus: (projectId: number, userId: number, isActive: boolean) =>
    api.patch<{ ok: boolean; user_id: number; is_active: boolean }>(
      `/api/projects/${projectId}/members/${userId}/status`,
      { is_active: isActive },
    ),
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
 * RPC（存储过程调用）—— 与 Auto API 同款 URL：项目 slug 出现在路径里，
 * 一套规则覆盖表 CRUD 与 RPC，行为对齐 Supabase / PostgREST 的 `rpc/<fn>`。
 *
 * 默认走 POST：
 *   rpcAPI.call(databaseSlug, 'console_get_user_projects', { user_id: 123 })
 *
 * IMMUTABLE / STABLE 函数 + 想走 CDN 缓存时改成 GET：
 *   rpcAPI.call(databaseSlug, 'search_projects', { keyword: 'demo' }, { method: 'GET' })
 *   → GET /api/v1/{databaseSlug}/rpc/search_projects?keyword=%22demo%22
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
    databaseSlug: string | number,
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

    const url = `/api/v1/${encodeURIComponent(String(databaseSlug))}/rpc/${encodeURIComponent(fnName)}`
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

// 锁等待 / 阻塞关系（pg_blocking_pids + pg_locks）。一行 = 一对「被阻塞 ← 阻塞」。
export interface LockWait {
  blocked_pid: number
  blocked_user: string
  blocked_query: string
  blocked_duration_seconds: number | null
  blocked_relation: string | null
  blocked_lock_mode: string | null
  wait_event_type: string | null
  wait_event: string | null
  blocking_pid: number
  blocking_user: string
  blocking_query: string
  blocking_duration_seconds: number | null
  blocking_state: string
}

export const monitorAPI = {
  getDatabaseStats: () => api.get('/api/monitor/stats'),

  getTableSizes: (limit?: number) =>
    api.get('/api/monitor/table-sizes', { params: { limit } }),

  getSlowQueries: (duration_ms?: number) =>
    api.get('/api/monitor/slow-queries', { params: { duration_ms } }),

  getActiveConnections: () => api.get('/api/monitor/connections'),

  getLockWaits: () => api.get<LockWait[]>('/api/monitor/locks'),
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
  alert_webhook_url: string | null
  alert_webhook_template: Record<string, unknown> | null
  alert_throttle_hours: number
  last_alert_sent_at: string | null
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
  alert_webhook_url?: string | null
  alert_webhook_template?: Record<string, unknown> | null
  alert_throttle_hours?: number
}

export interface UpdateScheduledTaskInput {
  name?: string
  description?: string
  cron_expr?: string
  timezone?: string
  rpc_args?: Record<string, unknown>
  /** http_url 允许修改（上游搬家场景）；后端会拒绝空串。http_method 仍不可变。 */
  http_url?: string
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
  alert_webhook_url?: string | null
  alert_webhook_template?: Record<string, unknown> | null
  alert_throttle_hours?: number
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
  list: (databaseSlug: string | number, schema: string, table: string, params?: {
    select?: string
    order?: string
    limit?: number
    offset?: number
    [key: string]: any // 其他过滤条件
  }) => api.get(`/api/v1/${encodeURIComponent(String(databaseSlug))}/${schema}/${table}`, { params }),
  
  // 获取单条记录
  get: (databaseSlug: string | number, schema: string, table: string, id: string | number, params?: {
    select?: string
  }) => api.get(`/api/v1/${encodeURIComponent(String(databaseSlug))}/${schema}/${table}/${id}`, { params }),
  
  // 创建记录
  create: (databaseSlug: string | number, schema: string, table: string, data: any) =>
    api.post(`/api/v1/${encodeURIComponent(String(databaseSlug))}/${schema}/${table}`, data),
  
  // 更新记录
  update: (databaseSlug: string | number, schema: string, table: string, id: string | number, data: any) =>
    api.patch(`/api/v1/${encodeURIComponent(String(databaseSlug))}/${schema}/${table}/${id}`, data),
  
  // 删除记录
  delete: (databaseSlug: string | number, schema: string, table: string, id: string | number) =>
    api.delete(`/api/v1/${encodeURIComponent(String(databaseSlug))}/${schema}/${table}/${id}`),
}

// === RBAC 数据形状（与后端 src/rbac_models.rs 1:1 对齐） ===

// 行级条件操作符（后端 RowOp 序列化为 lowercase）
// '=' | '!=' 是 spec 友好写法；后端也接 'eq' / 'neq'
export type RowOp =
  | '='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'in'
  | 'isnull'
  | 'isnotnull'

// 结构化行级条件，永远是 `[ {field, op, value} ]` 形式
// `value` 支持字面量 + 特殊占位符字符串 '$current_user_id'（后端 resolve_value_template 会替换）
export interface RowCondition {
  field: string
  op: RowOp
  value?: string | number | boolean | Array<string | number | boolean> | null
}

export interface Permission {
  id: number
  tenant_id: number
  resource: string
  action: string
  conditions: RowCondition[]
  allowed_columns: string[] | null
  denied_columns: string[]
  description: string | null
  created_at: string
  updated_at: string
}

// 后端写接口允许：null 清空 allow 列表；undefined 不更新
export interface PermissionWritePayload {
  resource: string
  action: string
  conditions?: RowCondition[]
  allowed_columns?: string[] | null
  denied_columns?: string[]
  description?: string
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
  // conditions 必须是结构化 RowCondition[]；后端 parse_row_conditions 不再接受裸字符串
  listPermissions: () => api.get('/api/rbac/permissions'),
  createPermission: (data: PermissionWritePayload) =>
    api.post('/api/rbac/permissions', data),
  updatePermission: (
    id: number,
    data: Partial<PermissionWritePayload>,
  ) => api.patch(`/api/rbac/permissions/${id}`, data),
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

  // 公开：前端回调页拿到 code+state 后回传，后端换 token 并返回 JWT
  exchange: (code: string, state: string) =>
    api.post('/auth/sso/exchange', { code, state }),

  // 公开：发起 SSO 授权
  authorize: (provider: string, tenantId?: number, redirectUrl?: string) => {
    const params = new URLSearchParams()
    if (tenantId) params.set('tenant_id', String(tenantId))
    if (redirectUrl) params.set('redirect_url', redirectUrl)
    return api.get(`/auth/sso/${provider}/authorize?${params.toString()}`)
  },

  // 管理：列出全部 Provider（SSO 配置按租户隔离，超管须显式指定 tenantId）
  listProviders: (tenantId?: number) =>
    api.get(`/api/sso/providers${tenantId ? `?tenant_id=${tenantId}` : ''}`),

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
    user_id_field?: string
    email_field?: string
    name_field?: string
    avatar_field?: string
    auto_role?: string
  }, tenantId?: number) =>
    api.post(`/api/sso/providers${tenantId ? `?tenant_id=${tenantId}` : ''}`, data),

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
    user_id_field?: string
    email_field?: string
    name_field?: string
    avatar_field?: string
    auto_role?: string
  }, tenantId?: number) =>
    api.patch(`/api/sso/providers/${id}${tenantId ? `?tenant_id=${tenantId}` : ''}`, data),

  // 管理：删除 Provider
  deleteProvider: (id: number, tenantId?: number) =>
    api.delete(`/api/sso/providers/${id}${tenantId ? `?tenant_id=${tenantId}` : ''}`),
}

// API Key 管理
export const apiKeyAPI = {
  // 获取项目的所有 API Keys
  list: (databaseSlug: string | number) => api.get(`/api/admin/api-keys/${encodeURIComponent(String(databaseSlug))}`),
  
  // 创建新的 API Key
  create: (databaseSlug: string | number, data: {
    name: string
    permissions?: { read?: boolean; write?: boolean; delete?: boolean }
    expires_in_days?: number
  }) => api.post(`/api/admin/api-keys/${encodeURIComponent(String(databaseSlug))}`, data),
  
  // 更新 API Key (启用/禁用)
  update: (databaseSlug: string | number, keyId: number, data: { is_active: boolean }) =>
    api.patch(`/api/admin/api-keys/${encodeURIComponent(String(databaseSlug))}/${keyId}`, data),
  
  // 删除 API Key
  delete: (databaseSlug: string | number, keyId: number) =>
    api.delete(`/api/admin/api-keys/${encodeURIComponent(String(databaseSlug))}/${keyId}`),
}

// 个人访问令牌（PAT，crm_ 前缀）—— MCP /mcp 工作流创作的鉴权凭证（绑定用户，非项目/数据库）
export const patAPI = {
  // 当前用户的 PAT 列表（不含明文）
  list: () => api.get('/api/admin/pats'),

  // 生成 PAT；token 明文仅本次响应返回，需立即复制保存
  create: (data: { name: string; expires_days?: number }) =>
    api.post('/api/admin/pats', data),

  // 吊销 PAT（置 is_active=false，立即失效）
  revoke: (id: number) => api.delete(`/api/admin/pats/${id}`),
}

// 平台服务令牌（crp_）管理：仅平台超管，用 JWT 调用。
// 令牌用于机器 / AI 通过 HTTP 或 MCP 创建项目、管理工作流。
export const platformTokenAPI = {
  // 列出自己的令牌（超管返回全部）
  list: () => api.get('/api/platform-tokens'),
  // 创建令牌（明文 token 只在响应里返回一次）
  create: (data: { name: string; scopes?: string[]; expires_in_days?: number }) =>
    api.post('/api/platform-tokens', data),
  // 停用令牌（软删除）
  delete: (id: number) => api.delete(`/api/platform-tokens/${id}`),
}

// 平台全局设置（仅超管）：对外调用基址/网关域名等。保存后即时生效，无需重启/重新构建。
export interface PlatformSettings {
  /** 页面上保存的对外基址；null 表示未配置，走环境变量/转发头兜底。 */
  public_base_url: string | null
  /** 当前实际生效的对外基址（含兜底），供页面展示"目前对外地址"。 */
  effective_base_url: string
  /** 环境变量 PUBLIC_BASE_URL 的兜底值（若有）。 */
  env_public_base_url: string | null
}
export const platformSettingsAPI = {
  get: () => api.get<PlatformSettings>('/api/admin/platform-settings'),
  update: (body: { public_base_url: string | null }) =>
    api.put<{ public_base_url: string | null }>('/api/admin/platform-settings', body),
}

// 项目级对外调用基址（项目 admin+）：每个项目可配置自己的网关域名，优先级高于平台级。
export interface ProjectGatewaySettings {
  /** 本项目保存的值；null 表示未配置，回落平台级/环境。 */
  public_base_url: string | null
  /** 当前实际生效的对外基址（含平台/环境/转发头兜底）。 */
  effective_base_url: string
  /** 平台级默认值，留空本项目时回落到它。 */
  platform_base_url: string | null
}
export const projectGatewayAPI = {
  get: (projectId: number) =>
    api.get<ProjectGatewaySettings>(`/api/projects/${projectId}/gateway-settings`),
  update: (projectId: number, body: { public_base_url: string | null }) =>
    api.put<{ public_base_url: string | null }>(`/api/projects/${projectId}/gateway-settings`, body),
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

// ─── Redis 数据源 ─────────────────────────────────────────────────────
//
// 把租户已有的 Redis 实例登记进平台后，可经三条路径统一使用：连接管理、数据 API
// （exec 精选命令）、工作流 redis 节点。
//
// 注意 `password_enc` 不会出现在响应里（后端 `#[serde(skip_serializing)]`），
// 故 TS 类型也不暴露它。
export interface RedisConnection {
  id: number
  tenant_id: number
  connection_name: string
  host: string
  port: number
  db_index: number
  username: string | null
  use_tls: boolean
  connect_timeout_secs: number
  is_active: boolean
  created_by: number
  created_at: string
  updated_at: string
}

export interface CreateRedisConnectionInput {
  tenant_id: number
  connection_name: string
  host: string
  port?: number
  db_index?: number
  username?: string | null
  /** 明文密码；后端加密入库。无密码实例留空 */
  password?: string | null
  use_tls?: boolean
  connect_timeout_secs?: number
}

export interface UpdateRedisConnectionInput {
  connection_name?: string
  host?: string
  port?: number
  db_index?: number
  username?: string | null
  /** null = 保留原密码；非空 = 替换；'' = 清空（无密码） */
  password?: string | null
  use_tls?: boolean
  connect_timeout_secs?: number
  is_active?: boolean
}

/** 精选命令集合（与后端 `redis_ds::commands::SUPPORTED_OPS` 保持一致） */
export const REDIS_OPS = [
  'get', 'set', 'del', 'exists', 'expire', 'ttl', 'incr', 'decr', 'keys',
  'hget', 'hset', 'hgetall', 'lpush', 'rpush', 'lrange', 'sadd', 'smembers',
] as const
export type RedisOp = (typeof REDIS_OPS)[number]

export interface RedisExecInput {
  op: RedisOp | string
  /** 命令参数：key / value / ttl / field / members / values / pattern / start / stop 等 */
  args?: Record<string, unknown>
}

export const redisAPI = {
  listConnections: (tenantId?: number) =>
    api.get<RedisConnection[]>('/api/admin/redis-connections', {
      params: tenantId !== undefined ? { tenant_id: tenantId } : undefined,
    }),
  getConnection: (id: number) =>
    api.get<RedisConnection>(`/api/admin/redis-connections/${id}`),
  createConnection: (input: CreateRedisConnectionInput) =>
    api.post<RedisConnection>('/api/admin/redis-connections', input),
  updateConnection: (id: number, input: UpdateRedisConnectionInput) =>
    api.put<RedisConnection>(`/api/admin/redis-connections/${id}`, input),
  deleteConnection: (id: number) =>
    api.delete<{ deleted: number }>(`/api/admin/redis-connections/${id}`),

  /** PING + INFO 探活；失败在响应体里以 { ok:false, error } 返回而非抛错 */
  healthCheck: (id: number) =>
    api.post<{ ok: boolean; redis_version?: string | null; error?: string }>(
      `/api/admin/redis-connections/${id}/health`,
      {},
      { suppressErrorToast: true } as ApiRequestConfig,
    ),

  /** 数据 API：执行一条精选命令。写操作需 owner/admin/member，读放行任意成员 */
  exec: (id: number, input: RedisExecInput) =>
    api.post<{ op: string; result: Record<string, unknown> }>(
      `/api/redis-connections/${id}/exec`,
      input,
      { suppressErrorToast: true } as ApiRequestConfig,
    ),
}

// ─────────────────────────────────────────────────────────────────────────
// Kafka 数据源连接

export type KafkaSecurityProtocol = 'PLAINTEXT' | 'SASL_PLAINTEXT' | 'SASL_SSL' | 'SSL'
export type KafkaSaslMechanism = 'PLAIN' | 'SCRAM-SHA-256' | 'SCRAM-SHA-512'

export interface KafkaConnection {
  id: number
  tenant_id: number
  connection_name: string
  brokers: string
  security_protocol: KafkaSecurityProtocol
  sasl_mechanism: KafkaSaslMechanism | null
  sasl_username: string | null
  /** 密码本身永不回传，仅表示当前连接是否已配置密码 */
  has_password?: boolean
  tls_insecure_skip_verify: boolean
  connect_timeout_secs: number
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface CreateKafkaConnectionInput {
  tenant_id: number
  connection_name: string
  brokers: string
  security_protocol?: KafkaSecurityProtocol
  sasl_mechanism?: KafkaSaslMechanism | null
  sasl_username?: string | null
  /** 明文密码；后端加密入库 */
  sasl_password?: string | null
  tls_insecure_skip_verify?: boolean
  connect_timeout_secs?: number
  is_active?: boolean
}

export interface UpdateKafkaConnectionInput {
  connection_name?: string
  brokers?: string
  security_protocol?: KafkaSecurityProtocol
  sasl_mechanism?: KafkaSaslMechanism | null
  sasl_username?: string | null
  /** 省略 = 保留原密码；空字符串 = 清空；非空 = 替换 */
  sasl_password?: string
  tls_insecure_skip_verify?: boolean
  connect_timeout_secs?: number
  is_active?: boolean
}

export interface KafkaTopicsResult {
  topics: string[]
  broker_count: number
}

export interface CreateKafkaTopicInput {
  name: string
  num_partitions: number
  replication_factor: number
}

export interface CreateKafkaTopicResult {
  ok: boolean
  topic: string
  num_partitions: number
  replication_factor: number
}

export interface KafkaConsumerGroupMember {
  member_id: string
  client_id: string
  client_host: string
}

export interface KafkaConsumerGroup {
  name: string
  state: string
  protocol: string
  protocol_type: string
  member_count: number
  members: KafkaConsumerGroupMember[]
}

export interface KafkaConsumerGroupsResult {
  groups: KafkaConsumerGroup[]
  group_count: number
}

export interface KafkaExecInput {
  op: 'produce' | 'list_topics' | string
  args?: Record<string, unknown>
}

export type KafkaTokenOp = 'produce' | 'list_topics' | 'health'

export interface KafkaAccessToken {
  id: number
  connection_id: number
  name: string
  description: string | null
  token_prefix: string
  allowed_ops: string[]
  topic_allowlist: string[]
  expires_at: string | null
  last_used_at: string | null
  use_count: number
  is_active: boolean
  revoked_at: string | null
  created_by: number
  created_at: string
}

export interface CreateKafkaTokenInput {
  name: string
  description?: string
  allowed_ops?: KafkaTokenOp[]
  topic_allowlist?: string[]
  expires_at?: string | null
}

export interface UpdateKafkaTokenInput {
  name?: string
  description?: string
  allowed_ops?: KafkaTokenOp[]
  topic_allowlist?: string[]
  expires_at?: string | null
  is_active?: boolean
}

export const kafkaAPI = {
  listConnections: (tenantId?: number) =>
    api.get<KafkaConnection[]>('/api/admin/kafka-connections', {
      params: tenantId !== undefined ? { tenant_id: tenantId } : undefined,
    }),
  getConnection: (id: number) =>
    api.get<KafkaConnection>(`/api/admin/kafka-connections/${id}`),
  createConnection: (input: CreateKafkaConnectionInput) =>
    api.post<KafkaConnection>('/api/admin/kafka-connections', input),
  updateConnection: (id: number, input: UpdateKafkaConnectionInput) =>
    api.put<KafkaConnection>(`/api/admin/kafka-connections/${id}`, input),
  deleteConnection: (id: number) =>
    api.delete<{ deleted: number }>(`/api/admin/kafka-connections/${id}`),
  healthCheck: (id: number) =>
    api.post<{ ok: boolean; broker_count?: number; error?: string }>(
      `/api/admin/kafka-connections/${id}/health`,
      {},
      { suppressErrorToast: true } as ApiRequestConfig,
    ),
  listTopics: (id: number) =>
    api.get<KafkaTopicsResult>(`/api/admin/kafka-connections/${id}/topics`, {
      suppressErrorToast: true,
    } as ApiRequestConfig),
  createTopic: (id: number, input: CreateKafkaTopicInput) =>
    api.post<CreateKafkaTopicResult>(`/api/admin/kafka-connections/${id}/topics`, input, {
      suppressErrorToast: true,
    } as ApiRequestConfig),
  listConsumerGroups: (id: number) =>
    api.get<KafkaConsumerGroupsResult>(
      `/api/admin/kafka-connections/${id}/consumer-groups`,
      { suppressErrorToast: true } as ApiRequestConfig,
    ),
  exec: (id: number, input: KafkaExecInput) =>
    api.post<{ op: string; result: Record<string, unknown> }>(
      `/api/kafka-connections/${id}/exec`,
      input,
      { suppressErrorToast: true } as ApiRequestConfig,
    ),
  listTokens: (connectionId: number) =>
    api.get<KafkaAccessToken[]>(`/api/admin/kafka-connections/${connectionId}/tokens`),
  createToken: (connectionId: number, input: CreateKafkaTokenInput) =>
    api.post<{ token: string; record: KafkaAccessToken }>(
      `/api/admin/kafka-connections/${connectionId}/tokens`,
      input,
    ),
  updateToken: (connectionId: number, tokenId: number, input: UpdateKafkaTokenInput) =>
    api.patch<KafkaAccessToken>(
      `/api/admin/kafka-connections/${connectionId}/tokens/${tokenId}`,
      input,
    ),
  deleteToken: (connectionId: number, tokenId: number) =>
    api.delete<{ deleted: number }>(
      `/api/admin/kafka-connections/${connectionId}/tokens/${tokenId}`,
    ),
}

// ─────────────────────────────────────────────────────────────────────────
// 对象存储数据源连接（COS / OSS / MinIO，S3 兼容）

export type ObjectStorageProvider = 'minio' | 'cos' | 'oss'

export interface ObjectStorageConnection {
  id: number
  tenant_id: number
  connection_name: string
  provider: ObjectStorageProvider | string
  endpoint: string
  region: string
  bucket: string
  access_key_id: string
  force_path_style: boolean
  connect_timeout_secs: number
  is_active: boolean
  created_by: number
  created_at: string
  updated_at: string
}

export interface CreateObjectStorageConnectionInput {
  tenant_id: number
  connection_name: string
  provider: ObjectStorageProvider
  endpoint: string
  region?: string
  bucket: string
  access_key_id: string
  secret_key: string
  force_path_style?: boolean
  connect_timeout_secs?: number
}

export interface UpdateObjectStorageConnectionInput {
  connection_name?: string
  provider?: ObjectStorageProvider
  endpoint?: string
  region?: string
  bucket?: string
  access_key_id?: string
  /** undefined = keep; non-empty = replace */
  secret_key?: string
  force_path_style?: boolean
  connect_timeout_secs?: number
  is_active?: boolean
}

export const OBJECT_STORAGE_OPS = ['put', 'get', 'delete', 'list', 'presign'] as const
export type ObjectStorageOp = (typeof OBJECT_STORAGE_OPS)[number]

export const OBJECT_STORAGE_TOKEN_OPS = [
  'put',
  'get',
  'delete',
  'list',
  'presign',
  'health',
] as const
export type ObjectStorageTokenOp = (typeof OBJECT_STORAGE_TOKEN_OPS)[number]

export interface ObjectStorageExecInput {
  op: ObjectStorageOp | string
  args?: Record<string, unknown>
}

export interface ObjectStorageAccessToken {
  id: number
  connection_id: number
  name: string
  description: string | null
  token_prefix: string
  allowed_ops: string[]
  key_prefix_allowlist: string[]
  expires_at: string | null
  last_used_at: string | null
  use_count: number
  is_active: boolean
  revoked_at: string | null
  created_by: number
  created_at: string
}

export interface CreateObjectStorageTokenInput {
  name: string
  description?: string
  allowed_ops?: ObjectStorageTokenOp[]
  key_prefix_allowlist?: string[]
  expires_at?: string | null
}

export interface UpdateObjectStorageTokenInput {
  name?: string
  description?: string
  allowed_ops?: ObjectStorageTokenOp[]
  key_prefix_allowlist?: string[]
  expires_at?: string | null
  is_active?: boolean
}

export const objectStorageAPI = {
  listConnections: (tenantId?: number) =>
    api.get<ObjectStorageConnection[]>('/api/admin/object-storage-connections', {
      params: tenantId !== undefined ? { tenant_id: tenantId } : undefined,
    }),
  getConnection: (id: number) =>
    api.get<ObjectStorageConnection>(`/api/admin/object-storage-connections/${id}`),
  createConnection: (input: CreateObjectStorageConnectionInput) =>
    api.post<ObjectStorageConnection>('/api/admin/object-storage-connections', input),
  updateConnection: (id: number, input: UpdateObjectStorageConnectionInput) =>
    api.put<ObjectStorageConnection>(`/api/admin/object-storage-connections/${id}`, input),
  deleteConnection: (id: number) =>
    api.delete<{ deleted: number }>(`/api/admin/object-storage-connections/${id}`),
  healthCheck: (id: number) =>
    api.post<{ ok: boolean; latency_ms?: number; bucket?: string; error?: string }>(
      `/api/admin/object-storage-connections/${id}/health`,
      {},
      { suppressErrorToast: true } as ApiRequestConfig,
    ),
  exec: (id: number, input: ObjectStorageExecInput) =>
    api.post<{ op: string; result: Record<string, unknown> }>(
      `/api/object-storage-connections/${id}/exec`,
      input,
      { suppressErrorToast: true } as ApiRequestConfig,
    ),
  listTokens: (connectionId: number) =>
    api.get<ObjectStorageAccessToken[]>(
      `/api/admin/object-storage-connections/${connectionId}/tokens`,
    ),
  createToken: (connectionId: number, input: CreateObjectStorageTokenInput) =>
    api.post<{ token: string; record: ObjectStorageAccessToken }>(
      `/api/admin/object-storage-connections/${connectionId}/tokens`,
      input,
    ),
  updateToken: (connectionId: number, tokenId: number, input: UpdateObjectStorageTokenInput) =>
    api.patch<ObjectStorageAccessToken>(
      `/api/admin/object-storage-connections/${connectionId}/tokens/${tokenId}`,
      input,
    ),
  deleteToken: (connectionId: number, tokenId: number) =>
    api.delete<{ deleted: number }>(
      `/api/admin/object-storage-connections/${connectionId}/tokens/${tokenId}`,
    ),
}

// ─────────────────────────────────────────────────────────────────────────
// Session Rules（项目级 RPC inject 钩子）
//
// 详细设计：docs/superpowers/specs/2026-05-27-session-rules-design.md
// 后端：src/session_rules_handlers.rs / `/api/admin/session-rules/:database_slug[/:id]`
//
// hooks JSON 数组中每条形如：
//   { header: "X-Way-UID",   guc: "app.current_user_id", type: "text",    max_length: 256 }
//   { header: "X-Project-IDs", guc: "app.project_ids",   type: "int_csv", max_count: 1000 }
//
// 创建/更新失败时，后端可能以 422 `validation_error` 返回逐条错误：
//   { error, code: "validation_error", details: [{ index, field, reason }] }
// 调用方通过 `suppressErrorToast` 自接 catch 并把 details 直接展示给用户。
// ─────────────────────────────────────────────────────────────────────────

export type SessionHookKind = 'text' | 'int_csv'

export interface SessionHook {
  header: string
  guc: string
  type: SessionHookKind
  max_length?: number
  max_count?: number
}

export interface SessionRule {
  id: number
  database_slug: string
  name: string
  description: string | null
  is_active: boolean
  hooks: SessionHook[]
  created_by: number
  created_at: string
  updated_at: string
}

export interface CreateSessionRuleInput {
  name: string
  description?: string | null
  is_active?: boolean
  hooks: SessionHook[]
}

export interface UpdateSessionRuleInput {
  name?: string
  description?: string | null
  is_active?: boolean
  hooks?: SessionHook[]
}

/** 与后端 `HookParseError` 对齐：422 响应里 `details[]` 的元素形态。 */
export interface SessionHookValidationError {
  index: number
  field: string | null
  reason: string
}

export const sessionRuleAPI = {
  /** 列出某 database 下的全部规则（含 is_active=false 的草稿）。鉴权：项目 admin+ / 超管。 */
  list: (databaseSlug: string | number) =>
    api.get<{ data: SessionRule[] }>(`/api/admin/session-rules/${encodeURIComponent(String(databaseSlug))}`),

  get: (databaseSlug: string | number, id: number) =>
    api.get<SessionRule>(`/api/admin/session-rules/${encodeURIComponent(String(databaseSlug))}/${id}`),

  /**
   * 创建规则。失败时 422 会带 `details[]`，调用方通过 `suppressErrorToast`
   * 自己捕获并把字段错误标红到表单行（避免被全局 toast 抢走焦点）。
   */
  create: (databaseSlug: string | number, data: CreateSessionRuleInput) =>
    api.post<SessionRule>(`/api/admin/session-rules/${encodeURIComponent(String(databaseSlug))}`, data, {
      suppressErrorToast: true,
    } as ApiRequestConfig),

  update: (databaseSlug: string | number, id: number, data: UpdateSessionRuleInput) =>
    api.patch<SessionRule>(
      `/api/admin/session-rules/${encodeURIComponent(String(databaseSlug))}/${id}`,
      data,
      { suppressErrorToast: true } as ApiRequestConfig,
    ),

  delete: (databaseSlug: string | number, id: number) =>
    api.delete<{ deleted: boolean; id: number }>(
      `/api/admin/session-rules/${encodeURIComponent(String(databaseSlug))}/${id}`,
    ),
}

// ─────────────────────────────────────────────────────────────────────
// SSE 转发/路由规则：数据变更命中 event_pattern 时自动推到自定义 topic。
// 鉴权：超管全量 / 租户 owner-admin 仅本租户（后端 src/sse_route_handlers.rs）。
// ─────────────────────────────────────────────────────────────────────
export interface SseRoute {
  id: number
  tenant_id: number
  name: string
  database_id: number | null
  event_pattern: string
  topic_template: string
  event_name: string | null
  is_active: boolean
}

export interface CreateSseRouteInput {
  tenant_id: number
  name: string
  database_id?: number | null
  event_pattern: string
  topic_template: string
  event_name?: string | null
}

export interface UpdateSseRouteInput {
  name?: string
  database_id?: number | null
  event_pattern?: string
  topic_template?: string
  event_name?: string | null
  is_active?: boolean
}

export const sseRouteAPI = {
  list: (tenantId?: number) =>
    api.get<{ data: SseRoute[] }>('/api/admin/sse-routes', {
      params: tenantId != null ? { tenant_id: tenantId } : undefined,
    }),
  create: (input: CreateSseRouteInput) =>
    api.post<{ data: { id: number }; message: string }>('/api/admin/sse-routes', input),
  update: (id: number, input: UpdateSseRouteInput) =>
    api.patch<{ message: string }>(`/api/admin/sse-routes/${id}`, input),
  delete: (id: number) =>
    api.delete<{ message: string }>(`/api/admin/sse-routes/${id}`),
}

// PG NOTIFY → SSE 监听桥：CRUD（超管 + 租户 owner/admin）+ 只读监控（限超管）。
export interface SseNotifyBridge {
  id: number
  database_id: number
  tenant_id: number
  channel: string
  topic_template: string
  event_name: string
  is_active: boolean
}

export interface CreateSseNotifyBridgeInput {
  database_id: number
  channel: string
  topic_template: string
  event_name: string
}

export interface UpdateSseNotifyBridgeInput {
  channel?: string
  topic_template?: string
  event_name?: string
  is_active?: boolean
}

export interface SseNotifyListenerStat {
  database_id: number
  channel: string
  connected: boolean
  received: number
  published: number
  parse_error: number
  reconnect: number
}

export interface SseNotifyBridgeStats {
  listeners: SseNotifyListenerStat[]
  connections: {
    total: number
    public: number
    generic: number
    by_endpoint: { slug: string; count: number }[]
  }
  pushes_total: number
}

export const sseNotifyBridgeAPI = {
  // tenantId 可选：传了就只看该项目（后端按 require_tenant_admin 鉴权 + 过滤），
  // 避免跨多租户 admin 在某个项目里看到其它项目的监听桥。
  list: (tenantId?: number) =>
    api.get<{ data: SseNotifyBridge[] }>(
      `/api/admin/sse-notify-bridges${tenantId ? `?tenant_id=${tenantId}` : ''}`,
    ),
  create: (input: CreateSseNotifyBridgeInput) =>
    api.post<{ data: { id: number }; message: string }>('/api/admin/sse-notify-bridges', input),
  update: (id: number, input: UpdateSseNotifyBridgeInput) =>
    api.patch<{ message: string }>(`/api/admin/sse-notify-bridges/${id}`, input),
  delete: (id: number) =>
    api.delete<{ message: string }>(`/api/admin/sse-notify-bridges/${id}`),
  getStats: () => api.get<SseNotifyBridgeStats>('/api/admin/sse-notify-bridges/stats'),
}

// 通用对外订阅端点：CRUD（超管 + 租户 owner/admin）。
export interface SsePublicEndpoint {
  id: number
  tenant_id: number
  slug: string
  name: string
  identity_header: string
  topic_template: string
  event_name: string
  is_active: boolean
}

export interface CreateSsePublicEndpointInput {
  tenant_id: number
  slug: string
  name: string
  identity_header: string
  topic_template: string
  event_name: string
}

export interface UpdateSsePublicEndpointInput {
  name?: string
  identity_header?: string
  topic_template?: string
  event_name?: string
  is_active?: boolean
}

export const ssePublicEndpointAPI = {
  // tenantId 可选：同 sseNotifyBridgeAPI.list，按项目收敛可见范围。
  list: (tenantId?: number) =>
    api.get<{ data: SsePublicEndpoint[] }>(
      `/api/admin/sse-public-endpoints${tenantId ? `?tenant_id=${tenantId}` : ''}`,
    ),
  create: (input: CreateSsePublicEndpointInput) =>
    api.post<{ data: { id: number }; message: string }>('/api/admin/sse-public-endpoints', input),
  update: (id: number, input: UpdateSsePublicEndpointInput) =>
    api.patch<{ message: string }>(`/api/admin/sse-public-endpoints/${id}`, input),
  delete: (id: number) =>
    api.delete<{ message: string }>(`/api/admin/sse-public-endpoints/${id}`),
}

// ─── 项目级环境变量（设置 › 环境变量）─────────────────────────────────
//
// 工作流的业务密钥/配置从此页面统一管理，替代服务器 .env 依赖。
// 安全模型：值加密入库、配置页明文回显（便于确认修改）、执行历史/debug 输出自动脱敏。
// 路由挂在项目路径下，与成员管理同款惯例（/api/projects/:id/...），鉴权 admin+。
//
// GET 返回解密后的明文值（规格明确：页面明文回显），后端已加 Cache-Control: no-store。

/** 单个项目环境变量（值为解密后明文，仅本页明文回显使用）。
 *  字段与后端 env_var_handlers::row_to_json 对齐。 */
export interface ProjectEnvVar {
  id: number
  name: string
  value: string
  description: string | null
  created_at: string
  updated_at: string
  /** 该行解密失败（密钥轮换/数据损坏）：value 为占位串，不可直接保存回写 */
  decrypt_error?: boolean
}

/** 新建 / 更新请求体——与后端 EnvVarRequest 1:1。
 *  注意：后端 PUT 也走同一结构体且校验 name，故更新时 name 必填（变量名不变照样回传）。 */
export interface EnvVarWriteBody {
  name: string
  value: string
  description?: string | null
}

/** 项目环境变量管理：admin+ / superadmin。 */
export const projectEnvVarsAPI = {
  list: (projectId: number) =>
    api.get<ProjectEnvVar[]>(`/api/projects/${projectId}/env-vars`),

  create: (projectId: number, body: EnvVarWriteBody) =>
    api.post<ProjectEnvVar>(`/api/projects/${projectId}/env-vars`, body),

  update: (projectId: number, varId: number, body: EnvVarWriteBody) =>
    api.put<ProjectEnvVar>(`/api/projects/${projectId}/env-vars/${varId}`, body),

  remove: (projectId: number, varId: number) =>
    api.delete(`/api/projects/${projectId}/env-vars/${varId}`),
}

// ─── 工作流「数据源 / 凭证」集成模块（集成 › 数据源）────────────────────
//
// 后端对应 src/datasource_handlers.rs：
//   GET/POST     /api/projects/:id/wf-credentials
//   PUT/DELETE   /api/projects/:id/wf-credentials/:cred_id
//   GET/POST     /api/projects/:id/wf-datasources
//   PUT/DELETE   /api/projects/:id/wf-datasources/:ds_id
//   POST         /api/projects/:id/wf-datasources/:ds_id/test
//
// 凭证密钥永不回显：列表只给 has_secret；更新时 secret 留空表示保持原密文不变。

/** 凭证类型：用户名/密码 或 Bearer 令牌 */
export type WfCredentialKind = 'basic' | 'bearer'

export interface WfCredential {
  id: number
  name: string
  kind: WfCredentialKind
  username: string | null
  description: string | null
  /** 恒为 true——密钥已加密存储、永不回显 */
  has_secret: boolean
  /** 被多少个数据源引用 */
  ref_count: number
  created_at: string
  updated_at: string
}

export interface WfCredentialWriteBody {
  name: string
  kind: WfCredentialKind
  username?: string | null
  /** 明文密码/令牌；新建必填，更新留空表示不改 */
  secret?: string | null
  description?: string | null
}

/** 数据源类型；执行引擎支持 postgresql / mysql */
export type WfDatasourceType = 'postgresql' | 'mysql'
export type WfDatasourceStatus = 'untested' | 'connected' | 'failed'

export interface WfDatasource {
  id: number
  name: string
  description: string | null
  ds_type: WfDatasourceType
  host: string
  port: number | null
  database: string | null
  credential_id: number | null
  credential_name: string | null
  status: WfDatasourceStatus
  last_tested_at: string | null
  last_test_error: string | null
  is_active: boolean
  /** 被多少个工作流的 db 节点引用 */
  ref_count: number
  created_at: string
  updated_at: string
}

export interface WfDatasourceWriteBody {
  name: string
  description?: string | null
  ds_type: WfDatasourceType
  host?: string | null
  port?: number | null
  database?: string | null
  credential_id?: number | null
}

export const wfCredentialAPI = {
  list: (projectId: number) =>
    api.get<WfCredential[]>(`/api/projects/${projectId}/wf-credentials`),
  create: (projectId: number, body: WfCredentialWriteBody) =>
    api.post<WfCredential>(`/api/projects/${projectId}/wf-credentials`, body),
  update: (projectId: number, credId: number, body: WfCredentialWriteBody) =>
    api.put<WfCredential>(`/api/projects/${projectId}/wf-credentials/${credId}`, body),
  remove: (projectId: number, credId: number) =>
    api.delete(`/api/projects/${projectId}/wf-credentials/${credId}`),
}

export const wfDatasourceAPI = {
  list: (projectId: number) =>
    api.get<WfDatasource[]>(`/api/projects/${projectId}/wf-datasources`),
  create: (projectId: number, body: WfDatasourceWriteBody) =>
    api.post<WfDatasource>(`/api/projects/${projectId}/wf-datasources`, body),
  update: (projectId: number, dsId: number, body: WfDatasourceWriteBody) =>
    api.put<WfDatasource>(`/api/projects/${projectId}/wf-datasources/${dsId}`, body),
  remove: (projectId: number, dsId: number) =>
    api.delete(`/api/projects/${projectId}/wf-datasources/${dsId}`),
  /** 测试连接（仅 postgresql）；内联展示错误，不弹全局 toast */
  test: (projectId: number, dsId: number) =>
    api.post<{ ok: boolean; status: WfDatasourceStatus; error?: string }>(
      `/api/projects/${projectId}/wf-datasources/${dsId}/test`,
      {},
      { suppressErrorToast: true } as ApiRequestConfig,
    ),
}

// ─── 项目级 IdP / OIDC 管理（安全 › 身份提供方）────────────────────────
//
// 后端对应：
// - GET/POST   /api/projects/:id/idp/providers
// - PATCH      /api/projects/:id/idp/providers/:provider_type
// - GET/POST   /api/projects/:id/idp/clients
// - PATCH      /api/projects/:id/idp/clients/:client_id
// - POST       /api/projects/:id/idp/clients/:client_id/rotate-secret
// - GET/PUT    /api/projects/:id/idp/clients/:client_id/providers
// - GET        /api/providers?client_id=...

export interface ProjectIdpProvider {
  id: number
  provider_type: string
  display_name: string
  client_id: string
  provider_config?: Record<string, any> | null
  has_client_secret: boolean
  is_enabled: boolean
  enabled_client_count?: number
  created_at: string
  updated_at: string
}

export interface IdpClientProviderToggle {
  provider_type: string
  is_enabled: boolean
  project_enabled?: boolean
  client_enabled?: boolean
  display_name?: string
}

export interface Oauth2ClientRecord {
  id: number
  client_id: string
  display_name: string
  redirect_uris: string[]
  allowed_scopes: string[]
  access_token_ttl: number
  refresh_token_ttl: number
  require_pkce: boolean
  is_active: boolean
  providers: IdpClientProviderToggle[]
  created_at: string
}

export interface IdpSessionRecord {
  family_id: string
  client_id: string
  client_display_name: string
  identity_id: number
  sub: string
  email: string | null
  name: string | null
  auth_method: string | null
  created_at: string
  expires_at: string
}

export interface IdpLoginLog {
  id: number
  created_at: string
  event: string // login | register
  provider: string
  sub: string | null
  email: string | null
  status: string // success | failure
  error: string | null
  ip: string | null
  client_id: string | null
  client_display_name: string | null
}

export interface CreateProjectIdpProviderBody {
  provider_type: string
  display_name?: string
  client_id: string
  client_secret: string
  is_enabled?: boolean
  provider_config?: Record<string, any>
}

export interface UpdateProjectIdpProviderBody {
  display_name?: string
  client_id?: string
  client_secret?: string
  is_enabled?: boolean
  provider_config?: Record<string, any>
}

export interface CreateOauth2ClientBody {
  display_name: string
  redirect_uris: string[]
  allowed_scopes?: string[]
  access_token_ttl?: number
  refresh_token_ttl?: number
  require_pkce?: boolean
  is_active?: boolean
}

export interface UpdateOauth2ClientBody {
  display_name?: string
  redirect_uris?: string[]
  allowed_scopes?: string[]
  access_token_ttl?: number
  refresh_token_ttl?: number
  require_pkce?: boolean
  is_active?: boolean
}

export const idpAPI = {
  listProviders: (projectId: number) =>
    api.get<ProjectIdpProvider[]>(`/api/projects/${projectId}/idp/providers`),

  createProvider: (projectId: number, body: CreateProjectIdpProviderBody) =>
    api.post<ProjectIdpProvider>(`/api/projects/${projectId}/idp/providers`, body),

  updateProvider: (projectId: number, providerType: string, body: UpdateProjectIdpProviderBody) =>
    api.patch<ProjectIdpProvider>(
      `/api/projects/${projectId}/idp/providers/${encodeURIComponent(providerType)}`,
      body,
    ),

  listClients: (projectId: number) =>
    api.get<Oauth2ClientRecord[]>(`/api/projects/${projectId}/idp/clients`),

  createClient: (projectId: number, body: CreateOauth2ClientBody) =>
    api.post<{
      client_id: string
      client_secret: string
      client: Oauth2ClientRecord
    }>(`/api/projects/${projectId}/idp/clients`, body),

  updateClient: (projectId: number, clientId: string, body: UpdateOauth2ClientBody) =>
    api.patch<Oauth2ClientRecord>(
      `/api/projects/${projectId}/idp/clients/${encodeURIComponent(clientId)}`,
      body,
    ),

  rotateClientSecret: (projectId: number, clientId: string) =>
    api.post<{ client_id: string; client_secret: string }>(
      `/api/projects/${projectId}/idp/clients/${encodeURIComponent(clientId)}/rotate-secret`,
      {},
    ),

  getClientProviders: (projectId: number, clientId: string) =>
    api.get<{ client_id: string; providers: IdpClientProviderToggle[] }>(
      `/api/projects/${projectId}/idp/clients/${encodeURIComponent(clientId)}/providers`,
    ),

  replaceClientProviders: (projectId: number, clientId: string, providers: IdpClientProviderToggle[]) =>
    api.put<{ client_id: string; providers: IdpClientProviderToggle[] }>(
      `/api/projects/${projectId}/idp/clients/${encodeURIComponent(clientId)}/providers`,
      { providers: providers.map(({ provider_type, is_enabled }) => ({ provider_type, is_enabled })) },
    ),

  listSessions: (projectId: number) =>
    api.get<IdpSessionRecord[]>(`/api/projects/${projectId}/idp/sessions`),

  revokeSession: (projectId: number, familyId: string) =>
    api.delete<{ revoked: boolean; family_id: string }>(
      `/api/projects/${projectId}/idp/sessions?family_id=${encodeURIComponent(familyId)}`,
    ),

  listLogs: (projectId: number) =>
    api.get<IdpLoginLog[]>(`/api/projects/${projectId}/idp/logs`),

  listPublicProviders: (clientId: string) =>
    api.get<{ providers: Array<{ provider: string; label: string; icon: string }> }>(
      `/api/providers?client_id=${encodeURIComponent(clientId)}`,
    ),
}

// ─── 操作日志（项目级 admin+）────────────────────────────────────────
//
// 后端 src/operation_log_handlers.rs：list / detail / stats / actors / export。
// 变更内容「写事实、读格式化」：detail 接口返回后端已渲染好的 change_view。

export interface OperationLogRow {
  id: number
  actor_type: string
  actor_id: number | null
  actor_name: string | null
  actor_role: string | null
  source: string
  action: string
  resource_type: string | null
  resource_name: string | null
  resource_id: string | null
  summary: string
  status: 'success' | 'failed'
  high_risk: boolean
  ip: string | null
  created_at: string
}

export interface OperationLogListResp {
  data: OperationLogRow[]
  total: number
  limit: number
  offset: number
}

export interface OperationLogStats {
  total: number
  today: number
  active_users: number
  failed: number
  high_risk: number
  mine: number
}

/** 后端 format_change 输出的视图：created/deleted 用 summary；modified 用 groups；imported 用 items。 */
export interface OperationChangeView {
  kind: 'created' | 'deleted' | 'modified' | 'imported' | 'sql'
  summary?: { label: string; value: string }[]
  groups?: {
    op: 'add' | 'modify' | 'delete'
    title: string
    items: {
      name: string
      type?: string
      fields?: { key: string; old: string; new: string }[]
    }[]
  }[]
  /** kind='imported'：批量导入的工作流列表 */
  items?: { name?: string; slug?: string; action?: string }[]
  /** kind='sql'：原始 SQL / 事务执行 */
  sql?: string
  sql_type?: string
  rows?: number | null
  statements?: { op?: string; table?: string }[]
}

export interface OperationLogDetail extends OperationLogRow {
  tenant_id: number
  user_agent: string | null
  session_id: string | null
  trace_id: string | null
  duration_ms: number | null
  detail: Record<string, unknown> | null
  change_view: OperationChangeView | null
}

export interface OperationLogFilterParams {
  actor_name?: string
  actor_id?: number
  action?: string
  resource_type?: string
  q_resource?: string
  source?: string
  status?: string
  start_date?: string
  end_date?: string
  tab?: 'all' | 'failed' | 'highRisk' | 'mine'
  limit?: number
  offset?: number
}

export interface OperationLogActor {
  actor_name: string | null
  actor_type: string | null
  actor_id: number | null
}

export const operationLogAPI = {
  list: (projectId: number, params: OperationLogFilterParams = {}) =>
    api.get<OperationLogListResp>(`/api/projects/${projectId}/operation-logs`, { params }),

  detail: (projectId: number, logId: number) =>
    api.get<OperationLogDetail>(`/api/projects/${projectId}/operation-logs/${logId}`),

  stats: (projectId: number, params: OperationLogFilterParams = {}) =>
    api.get<OperationLogStats>(`/api/projects/${projectId}/operation-logs/stats`, { params }),

  actors: (projectId: number, q?: string) =>
    api.get<{ data: OperationLogActor[] }>(
      `/api/projects/${projectId}/operation-logs/actors`,
      { params: q ? { q } : undefined },
    ),

  /** 筛选项数据源：数据里真实出现过的动作 / 资源类型（用于收敛下拉选项）。 */
  facets: (projectId: number) =>
    api.get<{ actions: string[]; resource_types: string[] }>(
      `/api/projects/${projectId}/operation-logs/facets`,
    ),

  export: (projectId: number, params: OperationLogFilterParams = {}) =>
    api.get<Blob>(`/api/projects/${projectId}/operation-logs/export`, {
      params,
      responseType: 'blob',
    }),
}

