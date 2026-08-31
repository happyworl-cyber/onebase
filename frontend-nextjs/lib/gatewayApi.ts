import axios, { type AxiosError } from 'axios'

export type GatewayPluginType = 'auth' | 'inject'
export type GatewayAssetType = 'workflow_token' | 'es_app_token'
export type GatewayAccessStatsRange = '1h' | '24h' | '7d'

export interface GatewayPlugin {
  key: string
  type: GatewayPluginType
  label: string
  module: string
  desc: string
  requires?: string[]
  builtin?: boolean
}

export interface GatewaySecretAsset {
  name: string
  type: GatewayAssetType
  project: string
  key_id: string
  masked: string
  desc: string
  created_at: string
  updated_at: string
}

export interface GatewayEncryptedToken {
  mode: 'encrypted'
  alg: 'AES-256-GCM'
  key_id?: string
  iv?: string
  ciphertext?: string
  tag?: string
  redacted?: boolean
}

export interface GatewayRoutePolicy {
  enabled: boolean
  auth: string
  handler?: string
  description?: string
  ip_filter?: {
    enabled: boolean
    blacklist: string[]
    allowlist_enabled?: boolean
    allowlist?: string[]
  }
  timestamp?: {
    enabled: boolean
    salt_env?: string
    window?: number
  }
  waf?: {
    enabled: boolean
    profile?: string
  }
  waf_body_max_bytes?: number
  rate_limit?: {
    enabled: boolean
    qps?: number
    dim?: string
    code?: number
  }
  workflow_token?: GatewayEncryptedToken
  es_app_token?: GatewayEncryptedToken
  workflow_token_asset?: string
  es_app_token_asset?: string
  [key: string]: unknown
}

export interface GatewayRouteRow {
  prefix: string
  policy: GatewayRoutePolicy
}

export interface PublishGatewayRouteInput {
  host: string
  prefix: string
  project?: string
  policy: GatewayRoutePolicy
  workflow_token_asset?: string
  es_app_token_asset?: string
}

export interface CreateGatewayAssetInput {
  name: string
  type: GatewayAssetType
  project: string
  key_id?: string
  plaintext: string
  desc?: string
}

export interface GatewayAccessStatsPoint {
  ts: string
  total_requests: number
  err_4xx: number
  err_5xx: number
  avg_rt: number
  p50_rt: number
  p90_rt: number
  p95_rt: number
  p99_rt: number
}

export interface GatewayAccessStatsURIItem {
  uri: string
  method?: string
  status?: number
  cnt: number
}

export interface GatewayAccessStatsSlowRequest {
  uri: string
  method?: string
  rt: number
  status?: number
  ts?: string
  cnt?: number
}

export interface GatewayAccessStatsSummary {
  total_requests: number
  err_4xx: number
  err_5xx: number
  error_rate: number
  avg_rt: number
  p50_rt: number
  p90_rt: number
  p95_rt: number
  p99_rt: number
  last_ts?: string
}

export interface GatewayAccessStats {
  env: string
  host: string
  gateway_name: string
  range: GatewayAccessStatsRange
  granularity: string
  start: string
  end: string
  summary: GatewayAccessStatsSummary
  previous?: GatewayAccessStatsSummary
  series: GatewayAccessStatsPoint[]
  method_dist: Record<string, number>
  status_dist: Record<string, number>
  top_uri: GatewayAccessStatsURIItem[]
  error_uri: GatewayAccessStatsURIItem[]
  slow_req: GatewayAccessStatsSlowRequest[]
}

export interface GatewayMonitoringTarget {
  project: string
  env: string
  host: string
  gateway_name: string
  base_query: string
  enabled: boolean
  updated_at?: string
}

export interface GatewayCliToken {
  id: number
  name: string
  username: string
  email?: string
  scopes: string[]
  expires_at?: string
  last_used_at?: string
  created_at?: string
  revoked_at?: string
  token?: string
}

export interface GatewayAuditLog {
  id: number
  actor_type: string
  actor_name: string
  actor_token_id?: number
  action: string
  resource_type: string
  resource_key: string
  host?: string
  project?: string
  before_json?: unknown
  after_json?: unknown
  request_json?: unknown
  client_ip?: string
  user_agent?: string
  created_at: string
}

// 浏览器走同源 /gateway-admin/*；健康检查在 /healthz（Go 根路径）。
// K8s 生产：Ingress 同域路由；本地 dev：next.config.js 反代到 GATEWAY_CONTROL_URL。
const gatewayBaseURL = '/gateway-admin'

const gatewayApi = axios.create({
  baseURL: gatewayBaseURL,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
  },
})

gatewayApi.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
  }
  return config
})

export function getGatewayBaseURL() {
  if (typeof window !== 'undefined') {
    return `${window.location.origin}/gateway-admin`
  }
  return '/gateway-admin'
}

export function getGatewayErrorMessage(error: unknown): string {
  const err = error as AxiosError<any>
  const data = err.response?.data
  if (typeof data === 'string' && data) return data
  if (data && typeof data === 'object') {
    if (typeof data.error === 'string' && data.error) return data.error
    if (typeof data.message === 'string' && data.message) return data.message
  }
  if (err.code === 'ECONNABORTED') return '网关控制面请求超时'
  if (err.message === 'Network Error') return '无法连接到网关控制面'
  return err.message || '网关控制面请求失败'
}

export const gatewayControlAPI = {
  health: () =>
    axios.get<{ status: string }>('/healthz', {
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
    }),

  listRoutes: async (host: string, project?: string) => {
    const resp = await gatewayApi.get<{
      host: string
      project?: string
      routes: Record<string, GatewayRoutePolicy>
    }>('/route-policies', {
      params: { host, redact: '1', ...(project ? { project } : {}) },
    })
    return Object.entries(resp.data.routes || {})
      .map(([prefix, policy]) => ({ prefix, policy }))
      .sort((a, b) => a.prefix.localeCompare(b.prefix))
  },

  publishRoute: (input: PublishGatewayRouteInput) =>
    gatewayApi.post('/route-policies', input),

  deleteRoute: (host: string, prefix: string, project: string) =>
    gatewayApi.delete('/route-policies', { params: { host, prefix, project } }),

  getGlobalBlacklist: (host: string) =>
    gatewayApi.get<{ host: string; list: string[] }>('/global-blacklist', {
      params: { host },
    }),

  putGlobalBlacklist: (host: string, list: string[]) =>
    gatewayApi.post('/global-blacklist', { host, list }),

  listAssets: (project?: string) =>
    gatewayApi.get<{ assets: GatewaySecretAsset[] }>('/secret-assets', {
      params: project ? { project } : undefined,
    }),

  createAsset: (input: CreateGatewayAssetInput) =>
    gatewayApi.post('/secret-assets', input),

  replaceAsset: (name: string, input: CreateGatewayAssetInput) =>
    gatewayApi.put(`/secret-assets/${encodeURIComponent(name)}`, input, {
      params: input.project ? { project: input.project } : undefined,
    }),

  listPlugins: () =>
    gatewayApi.get<{ plugins: GatewayPlugin[] }>('/plugins'),

  upsertPlugin: (plugin: GatewayPlugin) =>
    gatewayApi.post('/plugins', plugin),

  deletePlugin: (key: string) =>
    gatewayApi.delete(`/plugins/${encodeURIComponent(key)}`),

  getProjectPlugins: (project: string) =>
    gatewayApi.get<{ project: string; plugin_keys: string[] }>('/project-plugins', {
      params: { project },
    }),

  setProjectPlugins: async (project: string, pluginKeys: string[]) => {
    const resp = await gatewayApi.post<{ project: string; plugin_keys: string[] }>(
      '/project-plugins',
      {
        project,
        plugin_keys: pluginKeys,
      },
    )
    return resp.data.plugin_keys || []
  },

  keyVersions: () =>
    gatewayApi.get<{ active: string; versions: string[] }>('/key-versions'),

  getAccessStats: (params: {
    env?: string
    host?: string
    gateway?: string
    range?: GatewayAccessStatsRange
  }) =>
    gatewayApi.get<GatewayAccessStats>('/access-stats', { params }),

  listMonitoringTargets: (params?: { project?: string; enabled?: boolean }) =>
    gatewayApi.get<{ project: string; targets: GatewayMonitoringTarget[] }>('/monitoring-targets', {
      params: {
        project: params?.project,
        enabled: params?.enabled ? '1' : undefined,
      },
    }),

  setMonitoringTargets: (project: string, targets: GatewayMonitoringTarget[]) =>
    gatewayApi.post<{ project: string; targets: GatewayMonitoringTarget[]; saved: boolean }>(
      '/monitoring-targets',
      { project, targets },
    ),

  listCliTokens: () =>
    gatewayApi.get<{ tokens: GatewayCliToken[] }>('/cli-tokens'),

  createCliToken: (input: {
    name: string
    username: string
    email?: string
    scopes?: string[]
    expires_at?: string
  }) =>
    gatewayApi.post<{ token: GatewayCliToken }>('/cli-tokens', input),

  revokeCliToken: (id: number) =>
    gatewayApi.delete(`/cli-tokens/${id}`),

  listAuditLogs: (params?: { host?: string; project?: string; action?: string; actor?: string; limit?: number }) =>
    gatewayApi.get<{ logs: GatewayAuditLog[] }>('/audit-logs', { params }),
}

export default gatewayApi
