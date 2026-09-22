'use client'

import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import {
  gatewayControlAPI,
  getGatewayBaseURL,
  getGatewayErrorMessage,
} from '@/lib/gatewayApi'
import type {
  CreateGatewayAssetInput,
  GatewayAccessStats,
  GatewayAccessStatsPoint,
  GatewayAccessStatsRange,
  GatewayAccessStatsSlowRequest,
  GatewayAccessStatsURIItem,
  GatewayAuditLog,
  GatewayCliToken,
  GatewayMonitoringTarget,
  GatewayAssetType,
  GatewayPlugin,
  GatewayPluginType,
  GatewayRoutePolicy,
  GatewayRouteRow,
  GatewaySecretAsset,
} from '@/lib/gatewayApi'
import { useNotification } from '@/hooks/useNotification'
import { useTranslations } from 'next-intl'

type MainTab = 'routes' | 'blacklist' | 'monitoring' | 'plugins' | 'keys' | 'cli' | 'audit'
type PluginSubTab = 'registry' | 'assign'
type KeySubTab = 'assets' | 'versions'
type ProjectSlug = string
type GatewayEnv = 'prod' | 'intranet'

interface GatewayWorkspaceConfig {
  env: GatewayEnv
  hosts: Record<GatewayEnv, string[]>
}

export interface GatewayManagerProps {
  projectId?: number
  projectSlug?: string
  projectName?: string
  workspaceConfig?: Record<string, unknown> | null
}

const EMPTY_GATEWAY_CONFIG: GatewayWorkspaceConfig = {
  env: 'prod',
  hosts: {
    prod: [],
    intranet: [],
  },
}

const EMPTY_POLICY: GatewayRoutePolicy = {
  enabled: true,
  auth: 'none',
  ip_filter: {
    enabled: false,
    blacklist: [],
    allowlist_enabled: false,
    allowlist: [],
  },
  timestamp: { enabled: true, salt_env: 'TIMESTAMP_SALT_KEY', window: 60 },
  waf: { enabled: true, profile: 'basic' },
  rate_limit: { enabled: true, qps: 120, dim: 'ip', code: 429 },
}

const PLUGIN_PHASE_LABEL: Record<GatewayPluginType, string> = {
  auth: 'slotAuth',
  inject: 'slotInject',
}

function formatPluginPhase(type: GatewayPluginType, t: (k: string) => string) {
  return PLUGIN_PHASE_LABEL[type] ? t(PLUGIN_PHASE_LABEL[type]) : type
}

const ACCESS_STATS_RANGES: Array<{ value: GatewayAccessStatsRange; labelKey: string }> = [
  { value: '1h', labelKey: 'range1h' },
  { value: '24h', labelKey: 'range24h' },
  { value: '7d', labelKey: 'range7d' },
]

function linesToList(text: string) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function isValidIPv4(value: string) {
  const parts = value.split('.')
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d+$/.test(part)) return false
    if (part.length > 1 && part.startsWith('0')) return false
    const octet = Number(part)
    return octet >= 0 && octet <= 255
  })
}

function isValidIPv4OrCIDR(value: string) {
  const parts = value.split('/')
  if (parts.length === 1) return isValidIPv4(parts[0])
  if (parts.length !== 2 || !isValidIPv4(parts[0]) || !/^\d+$/.test(parts[1])) return false
  if (parts[1].length > 1 && parts[1].startsWith('0')) return false
  const prefix = Number(parts[1])
  return prefix >= 0 && prefix <= 32
}

function normalizeGatewayEnv(value: unknown): GatewayEnv {
  return value === 'intranet' ? 'intranet' : 'prod'
}

function normalizeHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function readGatewayWorkspaceConfig(workspaceConfig?: Record<string, unknown> | null): GatewayWorkspaceConfig {
  const raw = workspaceConfig?.gateway
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_GATEWAY_CONFIG

  const gateway = raw as Record<string, unknown>
  const hosts = gateway.hosts && typeof gateway.hosts === 'object' && !Array.isArray(gateway.hosts)
    ? gateway.hosts as Record<string, unknown>
    : {}

  return {
    env: normalizeGatewayEnv(gateway.env),
    hosts: {
      prod: normalizeHosts(hosts.prod),
      intranet: normalizeHosts(hosts.intranet),
    },
  }
}

function inferRouteOwnerProject(prefix: string, policy: GatewayRoutePolicy): string {
  const fromPolicy = typeof policy.project === 'string' ? policy.project.trim() : ''
  if (fromPolicy) return fromPolicy
  const parts = prefix.split('/').filter(Boolean)
  if (parts[0] === 'api' && parts[1] === 'v1' && parts[2]) return parts[2]
  if (parts[0] === 'workflow' && parts[1]) return parts[1]
  return ''
}

function inferRouteType(prefix: string, policy: GatewayRoutePolicy) {
  if (policy.es_app_token || prefix.includes('/es-app/')) return 'es_app'
  if (policy.auth === 'supabase' || prefix.startsWith('/api/v1/')) return 'supabase'
  if (prefix.startsWith('/events/')) return 'events'
  return 'workflow'
}

function clonePolicy(policy: GatewayRoutePolicy): GatewayRoutePolicy {
  return JSON.parse(JSON.stringify(policy))
}

function scrubPolicyForPreview(policy: GatewayRoutePolicy) {
  const copy = clonePolicy(policy)
  if (copy.workflow_token) {
    copy.workflow_token = {
      mode: 'encrypted',
      alg: 'AES-256-GCM',
      key_id: copy.workflow_token.key_id,
      redacted: true,
    }
  }
  if (copy.es_app_token) {
    copy.es_app_token = {
      mode: 'encrypted',
      alg: 'AES-256-GCM',
      key_id: copy.es_app_token.key_id,
      redacted: true,
    }
  }
  return copy
}

function buildRoutePolicyPayload(
  policy: GatewayRoutePolicy,
  routeBlacklistText: string,
  routeAllowlistText: string,
): GatewayRoutePolicy {
  const auth = policy.auth || 'none'
  const ipFilterEnabled = policy.ip_filter?.enabled ?? false
  const allowlistEnabled = policy.ip_filter?.allowlist_enabled ?? false
  const timestampEnabled = policy.timestamp?.enabled ?? false
  const wafEnabled = policy.waf?.enabled ?? false
  const rateLimitEnabled = policy.rate_limit?.enabled ?? false
  const next: GatewayRoutePolicy = {
    enabled: policy.enabled,
    auth,
    ip_filter: {
      enabled: ipFilterEnabled,
      blacklist: ipFilterEnabled ? linesToList(routeBlacklistText) : [],
      allowlist_enabled: allowlistEnabled,
      allowlist: allowlistEnabled ? linesToList(routeAllowlistText) : [],
    },
    timestamp: timestampEnabled ? {
      enabled: true,
      salt_env: policy.timestamp?.salt_env || 'TIMESTAMP_SALT_KEY',
      window: policy.timestamp?.window || 60,
    } : { enabled: false },
    waf: wafEnabled ? {
      enabled: true,
      profile: policy.waf?.profile || 'basic',
    } : { enabled: false },
    rate_limit: rateLimitEnabled ? {
      enabled: true,
      qps: policy.rate_limit?.qps || 120,
      dim: policy.rate_limit?.dim || 'ip',
      code: policy.rate_limit?.code || 429,
    } : { enabled: false },
  }
  const description = policy.description?.trim()
  if (description) next.description = description
  if (auth === 'supabase') next.handler = policy.handler || 'default'
  if (wafEnabled && typeof policy.waf_body_max_bytes === 'number' && policy.waf_body_max_bytes > 0) {
    next.waf_body_max_bytes = policy.waf_body_max_bytes
  }
  return next
}

function suggestNewRoutePrefix(project: string, existingPrefixes: string[]) {
  const base = `/workflow/${project}/`
  if (!existingPrefixes.includes(base)) return base
  let i = 2
  while (existingPrefixes.includes(`${base}v${i}/`)) i += 1
  return `${base}v${i}/`
}

function resolveProjectPluginKeys(
  plugins: GatewayPlugin[],
  current: string[],
  toggledKey: string,
  enabled: boolean,
): string[] {
  const set = new Set(current)
  if (enabled) {
    set.add(toggledKey)
    let changed = true
    while (changed) {
      changed = false
      for (const key of Array.from(set)) {
        const plugin = plugins.find((item) => item.key === key)
        for (const req of plugin?.requires || []) {
          if (req && !set.has(req)) {
            set.add(req)
            changed = true
          }
        }
      }
    }
    return Array.from(set).sort()
  }

  set.delete(toggledKey)
  let changed = true
  while (changed) {
    changed = false
    for (const plugin of plugins) {
      if (!set.has(plugin.key)) continue
      if ((plugin.requires || []).some((req) => req && !set.has(req))) {
        set.delete(plugin.key)
        changed = true
      }
    }
  }
  return Array.from(set).sort()
}

function formatCount(value?: number) {
  const n = value || 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatPercent(value?: number) {
  return `${((value || 0) * 100).toFixed(2)}%`
}

function formatChange(current: number | undefined, previous: number | undefined, t: (k: string, p?: any) => string) {
  const curr = current || 0
  const prev = previous || 0
  if (prev <= 0) {
    return curr > 0 ? t('trendNew') : t('trendFlat')
  }
  const change = (curr - prev) / prev
  const sign = change > 0 ? '+' : ''
  return t('trendPct', { sign, pct: (change * 100).toFixed(1) })
}

function formatRT(value?: number) {
  const n = value || 0
  if (n >= 1) return `${n.toFixed(2)}s`
  return `${Math.round(n * 1000)}ms`
}

function formatTime(value?: string) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString()
}

function formatAxisTime(value?: string) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${month}/${day} ${hour}:${minute}`
}

function axisTickIndexes(length: number) {
  if (length <= 0) return []
  if (length === 1) return [0]
  const indexes = [0, Math.floor((length - 1) / 2), length - 1]
  return Array.from(new Set(indexes))
}

function monitoringTargetKey(env: string, host: string) {
  return `${env}::${host}`
}

function defaultMonitoringGatewayName(env: GatewayEnv) {
  return env === 'intranet' ? 'openresty-gateway-policy-v3' : 'openresty-gateway-policy'
}

function defaultMonitoringBaseQuery(host: string) {
  return `* and content.host: ${host}`
}

function sumRecord(values: Record<string, number>) {
  return Object.values(values || {}).reduce((sum, value) => sum + value, 0)
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-semibold text-gray-900 mt-2">{value}</div>
      {hint && <div className="text-xs text-gray-400 mt-1">{hint}</div>}
    </div>
  )
}

function TrendChart({
  title,
  points,
  value,
  formatValue,
}: {
  title: string
  points: GatewayAccessStatsPoint[]
  value: (point: GatewayAccessStatsPoint) => number
  formatValue: (value: number) => string
}) {
  const chartPoints = points || []
  const t = useTranslations('wsGateway')
  const max = Math.max(...chartPoints.map(value), 1)
  const width = 640
  const height = 180
  const axisWidth = 54
  const axisBottom = 24
  const ticks = [max, max / 2, 0]
  const xTickIndexes = axisTickIndexes(chartPoints.length)
  const coords = chartPoints.map((point, index) => {
    const x = axisWidth + (chartPoints.length <= 1 ? 0 : (index / (chartPoints.length - 1)) * width)
    const y = height - (value(point) / max) * height
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const latest = chartPoints.length > 0 ? value(chartPoints[chartPoints.length - 1]) : 0

  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold text-gray-900">{title}</div>
        <div className="text-xs text-gray-500">{t('latest', { v: formatValue(latest) })}</div>
      </div>
      <svg viewBox={`0 0 ${width + axisWidth} ${height + axisBottom}`} className="w-full h-48 overflow-visible">
        {ticks.map((tick) => {
          const y = height - (tick / max) * height
          return (
            <g key={tick}>
              <line x1={axisWidth} y1={y} x2={width + axisWidth} y2={y} stroke="#e5e7eb" strokeWidth="1" />
              <text x={axisWidth - 8} y={y + 4} textAnchor="end" className="fill-gray-400 text-[10px]">
                {formatValue(tick)}
              </text>
            </g>
          )
        })}
        {xTickIndexes.map((index) => {
          const x = axisWidth + (chartPoints.length <= 1 ? 0 : (index / (chartPoints.length - 1)) * width)
          return (
            <text key={index} x={x} y={height + 18} textAnchor={index === 0 ? 'start' : index === chartPoints.length - 1 ? 'end' : 'middle'} className="fill-gray-400 text-[10px]">
              {formatAxisTime(chartPoints[index]?.ts)}
            </text>
          )
        })}
        {coords && (
          <polyline
            points={coords}
            fill="none"
            stroke="#2563eb"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
      <div className="text-[11px] text-gray-400 mt-2">
        {chartPoints.length > 0
          ? `${formatTime(chartPoints[0].ts)} → ${formatTime(chartPoints[chartPoints.length - 1].ts)}`
          : t('noStatsPoint')}
      </div>
    </div>
  )
}

function LatencyPercentileChart({ points }: { points: GatewayAccessStatsPoint[] }) {
  const chartPoints = points || []
  const t = useTranslations('wsGateway')
  const series = [
    { key: 'p50_rt', label: 'P50', color: '#16a34a', get: (point: GatewayAccessStatsPoint) => point.p50_rt },
    { key: 'p95_rt', label: 'P95', color: '#2563eb', get: (point: GatewayAccessStatsPoint) => point.p95_rt },
    { key: 'p99_rt', label: 'P99', color: '#dc2626', get: (point: GatewayAccessStatsPoint) => point.p99_rt },
  ]
  const width = 640
  const height = 180
  const axisWidth = 54
  const axisBottom = 24
  const max = Math.max(...chartPoints.flatMap((point) => series.map((item) => item.get(point))), 1)
  const ticks = [max, max / 2, 0]
  const xTickIndexes = axisTickIndexes(chartPoints.length)
  const coordsFor = (get: (point: GatewayAccessStatsPoint) => number) =>
    chartPoints.map((point, index) => {
      const x = axisWidth + (chartPoints.length <= 1 ? 0 : (index / (chartPoints.length - 1)) * width)
      const y = height - (get(point) / max) * height
      return `${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')
  const latest = chartPoints[chartPoints.length - 1]

  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="text-sm font-semibold text-gray-900">{t('latencyPercentileTrend')}</div>
        <div className="flex flex-wrap gap-3 text-xs">
          {series.map((item) => (
            <span key={item.key} className="flex items-center gap-1 text-gray-600">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: item.color }}></span>
              {item.label} {latest ? formatRT(item.get(latest)) : '-'}
            </span>
          ))}
        </div>
      </div>
      <svg viewBox={`0 0 ${width + axisWidth} ${height + axisBottom}`} className="w-full h-48 overflow-visible">
        {ticks.map((tick) => {
          const y = height - (tick / max) * height
          return (
            <g key={tick}>
              <line x1={axisWidth} y1={y} x2={width + axisWidth} y2={y} stroke="#e5e7eb" strokeWidth="1" />
              <text x={axisWidth - 8} y={y + 4} textAnchor="end" className="fill-gray-400 text-[10px]">
                {formatRT(tick)}
              </text>
            </g>
          )
        })}
        {xTickIndexes.map((index) => {
          const x = axisWidth + (chartPoints.length <= 1 ? 0 : (index / (chartPoints.length - 1)) * width)
          return (
            <text key={index} x={x} y={height + 18} textAnchor={index === 0 ? 'start' : index === chartPoints.length - 1 ? 'end' : 'middle'} className="fill-gray-400 text-[10px]">
              {formatAxisTime(chartPoints[index]?.ts)}
            </text>
          )
        })}
        {series.map((item) => {
          const coords = coordsFor(item.get)
          return coords ? (
            <polyline
              key={item.key}
              points={coords}
              fill="none"
              stroke={item.color}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null
        })}
      </svg>
      <div className="text-[11px] text-gray-400 mt-2">
        {chartPoints.length > 0
          ? `${formatTime(chartPoints[0].ts)} → ${formatTime(chartPoints[chartPoints.length - 1].ts)}`
          : t('noStatsPoint')}
      </div>
    </div>
  )
}

function DistributionBars({ title, values }: { title: string; values: Record<string, number> }) {
  const t = useTranslations('wsGateway')
  const entries = Object.entries(values || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
  const total = Math.max(sumRecord(values), 1)
  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white">
      <div className="text-sm font-semibold text-gray-900 mb-3">{title}</div>
      <div className="space-y-3">
        {entries.map(([key, count]) => (
          <div key={key}>
            <div className="flex justify-between text-xs mb-1">
              <span className="font-mono text-gray-700">{key}</span>
              <span className="text-gray-500">{formatCount(count)}</span>
            </div>
            <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
              <div className="h-full bg-blue-500" style={{ width: `${Math.max(2, (count / total) * 100)}%` }} />
            </div>
          </div>
        ))}
        {entries.length === 0 && <div className="text-sm text-gray-400">{t('noDistData')}</div>}
      </div>
    </div>
  )
}

function UriList({ title, items, kind }: { title: string; items: GatewayAccessStatsURIItem[]; kind: 'top' | 'error' }) {
  const t = useTranslations('wsGateway')
  return (
    <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold text-gray-900">{title}</div>
      {(items || []).map((item) => (
        <div key={`${item.uri}-${item.status || ''}`} className="px-4 py-3 border-b border-gray-100 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-xs text-gray-900 break-all">{item.uri}</span>
            <span className="text-xs text-gray-500 whitespace-nowrap">{formatCount(item.cnt)}</span>
          </div>
          {kind === 'error' && (
            <div className="text-[11px] text-red-600 mt-1">status {item.status || '-'}</div>
          )}
        </div>
      ))}
      {(!items || items.length === 0) && <div className="p-6 text-sm text-gray-400 text-center">{t('noData')}</div>}
    </div>
  )
}

function SlowRequestList({ items }: { items: GatewayAccessStatsSlowRequest[] }) {
  const t = useTranslations('wsGateway')
  return (
    <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold text-gray-900">{t('slowSample')}</div>
      {(items || []).slice(0, 10).map((item, index) => (
        <div key={`${item.uri}-${item.rt}-${index}`} className="grid grid-cols-[1fr_70px_70px] gap-3 px-4 py-3 border-b border-gray-100 text-sm">
          <div>
            <div className="font-mono text-xs text-gray-900 break-all">{item.uri}</div>
            <div className="text-[11px] text-gray-400 mt-1">{item.method || '-'} · {formatTime(item.ts)}</div>
          </div>
          <span className="font-mono text-xs text-gray-700">{formatRT(item.rt)}</span>
          <span className="font-mono text-xs text-gray-500">{item.status || '-'}</span>
        </div>
      ))}
      {(!items || items.length === 0) && <div className="p-6 text-sm text-gray-400 text-center">{t('noSlow')}</div>}
    </div>
  )
}

export default function GatewayManager({
  projectSlug,
  projectName: projectNameOverride,
  workspaceConfig,
}: GatewayManagerProps = {}) {
  const notify = useNotification()
  const t = useTranslations('wsGateway')
  const initialGatewayConfig = readGatewayWorkspaceConfig(workspaceConfig)
  const [tab, setTab] = useState<MainTab>('routes')
  const [pluginTab, setPluginTab] = useState<PluginSubTab>('registry')
  const [keyTab, setKeyTab] = useState<KeySubTab>('assets')
  const [project, setProject] = useState<ProjectSlug>(projectSlug || '')
  const [env, setEnv] = useState<GatewayEnv>(initialGatewayConfig.env)
  const [selectedConfiguredHost, setSelectedConfiguredHost] = useState(
    () => initialGatewayConfig.hosts[initialGatewayConfig.env][0] || '',
  )
  const [manualHost, setManualHost] = useState('')
  const [isDraftRoute, setIsDraftRoute] = useState(false)
  const [health, setHealth] = useState<'checking' | 'ok' | 'down'>('checking')
  const [loading, setLoading] = useState(false)
  const [savingGatewayConfig, setSavingGatewayConfig] = useState(false)
  const [configuredHostsText, setConfiguredHostsText] = useState<Record<GatewayEnv, string>>({
    prod: initialGatewayConfig.hosts.prod.join('\n'),
    intranet: initialGatewayConfig.hosts.intranet.join('\n'),
  })

  const [routes, setRoutes] = useState<GatewayRouteRow[]>([])
  const [selectedPrefix, setSelectedPrefix] = useState('')
  const [routeType, setRouteType] = useState('workflow')
  const [policy, setPolicy] = useState<GatewayRoutePolicy>(clonePolicy(EMPTY_POLICY))
  const [routeBlacklistText, setRouteBlacklistText] = useState('')
  const [routeAllowlistText, setRouteAllowlistText] = useState('')
  const [workflowAsset, setWorkflowAsset] = useState('')
  const [esAsset, setEsAsset] = useState('')
  const [routeSearch, setRouteSearch] = useState('')
  const [routeFilter, setRouteFilter] = useState('all')

  const [globalBlacklistText, setGlobalBlacklistText] = useState('')
  const [plugins, setPlugins] = useState<GatewayPlugin[]>([])
  const [projectPluginKeys, setProjectPluginKeys] = useState<string[]>([])
  const [assets, setAssets] = useState<GatewaySecretAsset[]>([])
  const [activeKeyId, setActiveKeyId] = useState('')
  const [keyVersions, setKeyVersions] = useState<string[]>([])
  const [monitoringTargets, setMonitoringTargets] = useState<GatewayMonitoringTarget[]>([])
  const [statsRange, setStatsRange] = useState<GatewayAccessStatsRange>('1h')
  const [accessStats, setAccessStats] = useState<GatewayAccessStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [statsAutoRefresh, setStatsAutoRefresh] = useState(false)
  const [gatewayBaseLabel, setGatewayBaseLabel] = useState('/gateway-admin')
  const [cliTokens, setCliTokens] = useState<GatewayCliToken[]>([])
  const [createdCliToken, setCreatedCliToken] = useState('')
  const [auditLogs, setAuditLogs] = useState<GatewayAuditLog[]>([])
  const [cliTokenForm, setCliTokenForm] = useState({
    name: '',
    username: '',
    email: '',
    scopes: 'route:read,route:write,asset:read,plugin:read',
  })

  const [pluginForm, setPluginForm] = useState<GatewayPlugin>({
    key: '',
    type: 'auth',
    label: '',
    module: '',
    desc: '',
    requires: [],
  })
  const [assetForm, setAssetForm] = useState<CreateGatewayAssetInput>({
    name: '',
    type: 'workflow_token',
    project,
    key_id: '',
    plaintext: '',
    desc: '',
  })

  const configuredHostOptions = linesToList(configuredHostsText[env])
  const hostOptions = configuredHostOptions
  const host = manualHost.trim() || selectedConfiguredHost || hostOptions[0] || ''
  const activeConfiguredHost = selectedConfiguredHost || hostOptions[0] || ''
  const manualHostOverridesPreset =
    !!manualHost.trim() && !!activeConfiguredHost && manualHost.trim() !== activeConfiguredHost
  const projectName = projectNameOverride || project

  const workflowAssets = assets.filter((asset) => asset.type === 'workflow_token')
  const esAssets = assets.filter((asset) => asset.type === 'es_app_token')
  const enabledPluginSet = new Set(projectPluginKeys)
  const authPlugins = plugins.filter((plugin) => plugin.type === 'auth' && enabledPluginSet.has(plugin.key))
  const workflowInjectEnabled = enabledPluginSet.has('workflow_token_inject')
  const esInjectEnabled = enabledPluginSet.has('es_app_token_inject')
  const currentAuthKey = policy.auth || 'none'
  const isSupabaseAuth = currentAuthKey === 'supabase'
  const showWorkflowAsset =
    !isSupabaseAuth && (workflowInjectEnabled || !!workflowAsset || !!policy.workflow_token?.redacted)
  const showEsAsset =
    !isSupabaseAuth && (esInjectEnabled || !!esAsset || !!policy.es_app_token?.redacted)
  const hasLegacySupabaseCredential =
    isSupabaseAuth && !!(
      workflowAsset
      || esAsset
      || policy.workflow_token
      || policy.es_app_token
      || policy.workflow_token_asset
      || policy.es_app_token_asset
    )
  const identityPlugins = plugins.filter((plugin) => plugin.type === 'auth')
  const credentialPlugins = plugins.filter((plugin) => plugin.type === 'inject')
  const currentAuthDisabled = authPlugins.length > 0 && !enabledPluginSet.has(currentAuthKey)

  const filteredRoutes = useMemo(() => {
    return routes.filter((row) => {
      const type = inferRouteType(row.prefix, row.policy)
      const matchesType = routeFilter === 'all' || type === routeFilter
      const q = routeSearch.trim().toLowerCase()
      const matchesSearch =
        !q ||
        row.prefix.toLowerCase().includes(q) ||
        row.policy.auth?.toLowerCase().includes(q) ||
        row.policy.description?.toLowerCase().includes(q)
      return matchesType && matchesSearch
    })
  }, [routeFilter, routeSearch, routes])

  const previewPolicy = useMemo(() => {
    const next = buildRoutePolicyPayload(policy, routeBlacklistText, routeAllowlistText)
    if (!isSupabaseAuth && workflowAsset) {
      next.workflow_token_asset = workflowAsset
      next.workflow_token = {
        mode: 'encrypted',
        alg: 'AES-256-GCM',
        key_id: workflowAssets.find((asset) => asset.name === workflowAsset)?.key_id,
        redacted: true,
      }
    }
    if (!isSupabaseAuth && esAsset) {
      next.es_app_token_asset = esAsset
      next.es_app_token = {
        mode: 'encrypted',
        alg: 'AES-256-GCM',
        key_id: esAssets.find((asset) => asset.name === esAsset)?.key_id,
        redacted: true,
      }
    }
    return scrubPolicyForPreview(next)
  }, [
    esAsset,
    esAssets,
    isSupabaseAuth,
    policy,
    routeAllowlistText,
    routeBlacklistText,
    workflowAsset,
    workflowAssets,
  ])

  const routePreview = `HSET gateway:policy:${host || '{host}'}:routes \\\n  "${selectedPrefix || '/'}" \\\n  '${JSON.stringify(previewPolicy, null, 2)}'`
  const blacklistPreview = linesToList(globalBlacklistText).length
    ? `SET gateway:policy:${host || '{host}'}:global_blacklist \\\n  '${JSON.stringify(linesToList(globalBlacklistText), null, 2)}'`
    : `# ${t('delKeyComment').split('\n')[0].replace(/^# /, '')}\n# DEL gateway:policy:${host || '{host}'}:global_blacklist`

  const findMonitoringTarget = (targetEnv: GatewayEnv, targetHost: string) =>
    monitoringTargets.find((target) => target.env === targetEnv && target.host === targetHost)

  const buildMonitoringTargets = (hosts: GatewayWorkspaceConfig['hosts']) => {
    return (['prod', 'intranet'] as GatewayEnv[]).flatMap((targetEnv) =>
      hosts[targetEnv].map((targetHost) => {
        const current = findMonitoringTarget(targetEnv, targetHost)
        return {
          project,
          env: targetEnv,
          host: targetHost,
          gateway_name: current?.gateway_name || defaultMonitoringGatewayName(targetEnv),
          base_query: current?.base_query || defaultMonitoringBaseQuery(targetHost),
          enabled: true,
        }
      }),
    )
  }

  const saveGatewayConfig = async () => {
    if (!project) {
      notify.warning(t('errNoProjectSave'))
      return
    }

    const hosts: GatewayWorkspaceConfig['hosts'] = {
      prod: linesToList(configuredHostsText.prod),
      intranet: linesToList(configuredHostsText.intranet),
    }
    if (hosts.prod.length === 0 && hosts.intranet.length === 0) {
      notify.warning(t('errAtLeastOneHost'))
      return
    }

    setSavingGatewayConfig(true)
    try {
      const nextTargets = buildMonitoringTargets(hosts)
      const targetsResp = await gatewayControlAPI.setMonitoringTargets(project, nextTargets)
      setMonitoringTargets(targetsResp.data.targets || nextTargets)
      notify.success(t('hostsSaved'))
    } catch (err) {
      notify.error(err)
    } finally {
      setSavingGatewayConfig(false)
    }
  }

  const loadGatewayData = async () => {
    setLoading(true)
    try {
      await gatewayControlAPI.health()
      setHealth('ok')
    } catch {
      setHealth('down')
    }
    try {
      const [nextRoutes, blacklistResp, assetsResp, pluginsResp, projectPluginsResp, versionsResp, targetsResp] =
        await Promise.all([
          host ? gatewayControlAPI.listRoutes(host, project) : Promise.resolve([] as GatewayRouteRow[]),
          host ? gatewayControlAPI.getGlobalBlacklist(host) : Promise.resolve({ data: { host: '', list: [] } }),
          gatewayControlAPI.listAssets(project),
          gatewayControlAPI.listPlugins(),
          gatewayControlAPI.getProjectPlugins(project),
          gatewayControlAPI.keyVersions(),
          gatewayControlAPI.listMonitoringTargets({ project }),
        ])

      setRoutes(nextRoutes)
      if (!isDraftRoute && !selectedPrefix && nextRoutes[0]) applyRoute(nextRoutes[0])
      setGlobalBlacklistText((blacklistResp.data.list || []).join('\n'))
      setAssets(assetsResp.data.assets || [])
      setPlugins(pluginsResp.data.plugins || [])
      setProjectPluginKeys(projectPluginsResp.data.plugin_keys || [])
      setActiveKeyId(versionsResp.data.active || '')
      setKeyVersions(versionsResp.data.versions || [])
      const nextTargets = targetsResp.data.targets || []
      setMonitoringTargets(nextTargets)
      const targetHosts = {
        prod: nextTargets.filter((target) => target.env === 'prod').map((target) => target.host),
        intranet: nextTargets.filter((target) => target.env === 'intranet').map((target) => target.host),
      }
      if (targetHosts.prod.length > 0 || targetHosts.intranet.length > 0) {
        setConfiguredHostsText({
          prod: Array.from(new Set(targetHosts.prod)).join('\n'),
          intranet: Array.from(new Set(targetHosts.intranet)).join('\n'),
        })
      }
    } catch (err) {
      notify.error(getGatewayErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  const loadAccessStats = async () => {
    if (!host) {
      setAccessStats(null)
      return
    }
    setStatsLoading(true)
    try {
      const resp = await gatewayControlAPI.getAccessStats({
        env,
        host,
        range: statsRange,
      })
      setAccessStats(resp.data)
    } catch (err) {
      notify.error(getGatewayErrorMessage(err))
    } finally {
      setStatsLoading(false)
    }
  }

  const loadCliTokens = async () => {
    try {
      const resp = await gatewayControlAPI.listCliTokens()
      setCliTokens(resp.data.tokens || [])
    } catch (err) {
      notify.error(getGatewayErrorMessage(err))
    }
  }

  const loadAuditLogs = async () => {
    try {
      const resp = await gatewayControlAPI.listAuditLogs({ limit: 50 })
      setAuditLogs(resp.data.logs || [])
    } catch (err) {
      notify.error(getGatewayErrorMessage(err))
    }
  }

  const createCliToken = async (event: FormEvent) => {
    event.preventDefault()
    if (!cliTokenForm.name || !cliTokenForm.username) {
      notify.warning(t('errTokenNameUser'))
      return
    }
    try {
      const resp = await gatewayControlAPI.createCliToken({
        name: cliTokenForm.name,
        username: cliTokenForm.username,
        email: cliTokenForm.email || undefined,
        scopes: cliTokenForm.scopes.split(',').map((item) => item.trim()).filter(Boolean),
      })
      setCreatedCliToken(resp.data.token.token || '')
      await loadCliTokens()
      notify.success(t('cliCreated'))
    } catch (err) {
      notify.error(getGatewayErrorMessage(err))
    }
  }

  const revokeCliToken = async (token: GatewayCliToken) => {
    if (!window.confirm(t('confirmRevoke', { name: token.name }))) return
    try {
      await gatewayControlAPI.revokeCliToken(token.id)
      await loadCliTokens()
      notify.success(t('cliRevoked'))
    } catch (err) {
      notify.error(getGatewayErrorMessage(err))
    }
  }

  useEffect(() => {
    setAssetForm((prev) => ({ ...prev, project, key_id: activeKeyId || prev.key_id }))
  }, [activeKeyId, project])

  useEffect(() => {
    setGatewayBaseLabel(getGatewayBaseURL())
  }, [])

  useEffect(() => {
    if (projectSlug && projectSlug !== project) {
      setProject(projectSlug)
    }
  }, [project, projectSlug])

  useEffect(() => {
    const next = readGatewayWorkspaceConfig(workspaceConfig)
    setEnv(next.env)
    setConfiguredHostsText({
      prod: next.hosts.prod.join('\n'),
      intranet: next.hosts.intranet.join('\n'),
    })
    setSelectedConfiguredHost(next.hosts[next.env][0] || '')
  }, [workspaceConfig])

  useEffect(() => {
    const options = linesToList(configuredHostsText[env])
    setSelectedConfiguredHost((current) => (current && options.includes(current) ? current : options[0] || ''))
  }, [env, configuredHostsText])

  useEffect(() => {
    setSelectedPrefix('')
    setIsDraftRoute(false)
    setWorkflowAsset('')
    setEsAsset('')
    loadGatewayData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, env, manualHost, selectedConfiguredHost])

  useEffect(() => {
    if (tab === 'monitoring') {
      loadAccessStats()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, statsRange, host, env])

  useEffect(() => {
    if (!statsAutoRefresh || tab !== 'monitoring') return
    const timer = window.setInterval(() => {
      loadAccessStats()
    }, 60_000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsAutoRefresh, tab, statsRange, host, env])

  useEffect(() => {
    if (tab === 'cli') {
      loadCliTokens()
    }
    if (tab === 'audit') {
      loadAuditLogs()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, host, project])

  const applyRoute = (row: GatewayRouteRow) => {
    setIsDraftRoute(false)
    setSelectedPrefix(row.prefix)
    const next = {
      ...clonePolicy(EMPTY_POLICY),
      ...clonePolicy(row.policy),
      ip_filter: {
        enabled: row.policy.ip_filter?.enabled ?? false,
        blacklist: row.policy.ip_filter?.blacklist || [],
        allowlist_enabled: row.policy.ip_filter?.allowlist_enabled ?? false,
        allowlist: row.policy.ip_filter?.allowlist || [],
      },
      timestamp: {
        enabled: row.policy.timestamp?.enabled ?? true,
        salt_env: row.policy.timestamp?.salt_env || 'TIMESTAMP_SALT_KEY',
        window: row.policy.timestamp?.window || 60,
      },
      waf: {
        enabled: row.policy.waf?.enabled ?? true,
        profile: row.policy.waf?.profile || 'basic',
      },
      rate_limit: {
        enabled: row.policy.rate_limit?.enabled ?? true,
        qps: row.policy.rate_limit?.qps || 120,
        dim: row.policy.rate_limit?.dim || 'ip',
        code: row.policy.rate_limit?.code || 429,
      },
    }
    setPolicy(next)
    setRouteType(inferRouteType(row.prefix, row.policy))
    setRouteBlacklistText(next.ip_filter?.blacklist?.join('\n') || '')
    setRouteAllowlistText(next.ip_filter?.allowlist?.join('\n') || '')
    setWorkflowAsset(row.policy.workflow_token_asset || '')
    setEsAsset(row.policy.es_app_token_asset || '')
  }

  const startNewRoute = () => {
    const existingPrefixes = routes.map((row) => row.prefix)
    setIsDraftRoute(true)
    setSelectedPrefix(suggestNewRoutePrefix(project, existingPrefixes))
    setRouteType('workflow')
    setPolicy(clonePolicy(EMPTY_POLICY))
    setRouteBlacklistText('')
    setRouteAllowlistText('')
    setWorkflowAsset('')
    setEsAsset('')
  }

  const updatePolicy = (patch: Partial<GatewayRoutePolicy>) => {
    setPolicy((prev) => ({ ...prev, ...patch }))
  }

  const updatePolicyAuth = (auth: string) => {
    setPolicy((prev) => {
      const next = { ...prev, auth }
      if (auth !== 'supabase') delete next.handler
      return next
    })
    if (auth === 'supabase') {
      setWorkflowAsset('')
      setEsAsset('')
    }
  }

  const publishRoute = async () => {
    if (!host) {
      notify.warning(t('errSelectHost'))
      return
    }
    if (!selectedPrefix || !selectedPrefix.startsWith('/')) {
      notify.warning(t('errRoutePrefix'))
      return
    }
    if (isDraftRoute && routes.some((row) => row.prefix === selectedPrefix)) {
      notify.warning(t('errRouteDup'))
      return
    }
    const auth = policy.auth || 'none'
    const effectiveWorkflowAsset = auth === 'supabase' ? '' : workflowAsset
    const effectiveEsAsset = auth === 'supabase' ? '' : esAsset
    if (effectiveWorkflowAsset && effectiveEsAsset) {
      notify.warning(t('errBothTokens'))
      return
    }
    if (auth !== 'supabase' && (routeType === 'workflow' || policy.workflow_token)
      && effectiveWorkflowAsset === '' && policy.workflow_token?.redacted) {
      notify.warning(t('errWfTokenMasked'))
      return
    }
    if (auth !== 'supabase' && (routeType === 'es_app' || policy.es_app_token)
      && effectiveEsAsset === '' && policy.es_app_token?.redacted) {
      notify.warning(t('errEsTokenMasked'))
      return
    }

    const allowlist = linesToList(routeAllowlistText)
    if (policy.ip_filter?.allowlist_enabled && allowlist.length === 0) {
      notify.warning(t('errAllowlistEmpty'))
      return
    }
    const invalidAllowlistRule = allowlist.find((rule) => !isValidIPv4OrCIDR(rule))
    if (policy.ip_filter?.allowlist_enabled && invalidAllowlistRule) {
      notify.warning(t('errAllowlistInvalid', { rule: invalidAllowlistRule }))
      return
    }

    const nextPolicy = buildRoutePolicyPayload(policy, routeBlacklistText, routeAllowlistText)
    const authKey = nextPolicy.auth || 'none'
    if (!projectPluginKeys.includes(authKey)) {
      notify.warning(t('errAuthNotEnabled', { key: authKey }))
      return
    }
    if (effectiveWorkflowAsset && !projectPluginKeys.includes('workflow_token_inject')) {
      notify.warning(t('errWfInjectNotEnabled'))
      return
    }
    if (effectiveEsAsset && !projectPluginKeys.includes('es_app_token_inject')) {
      notify.warning(t('errEsInjectNotEnabled'))
      return
    }

    try {
      await gatewayControlAPI.publishRoute({
        host,
        prefix: selectedPrefix,
        project,
        policy: nextPolicy,
        workflow_token_asset: effectiveWorkflowAsset || undefined,
        es_app_token_asset: effectiveEsAsset || undefined,
      })
      notify.success(t('routePublished'))
      setIsDraftRoute(false)
      await loadGatewayData()
    } catch (err) {
      notify.error(getGatewayErrorMessage(err))
    }
  }

  const deleteRoute = async () => {
    if (!host || !selectedPrefix) return
    if (!project) {
      notify.warning(t('errNoProjectDel'))
      return
    }
    if (!window.confirm(t('confirmDeleteRoute', { prefix: selectedPrefix }))) return
    try {
      await gatewayControlAPI.deleteRoute(host, selectedPrefix, project)
      notify.success(t('routeDeleted'))
      setSelectedPrefix('')
      setPolicy(clonePolicy(EMPTY_POLICY))
      setRouteBlacklistText('')
      setRouteAllowlistText('')
      await loadGatewayData()
    } catch (err) {
      notify.error(getGatewayErrorMessage(err))
    }
  }

  const saveBlacklist = async () => {
    if (!host) {
      notify.warning(t('errSelectHost'))
      return
    }
    try {
      await gatewayControlAPI.putGlobalBlacklist(host, linesToList(globalBlacklistText))
      notify.success(t('hostBlacklistPublished'))
    } catch (err) {
      notify.error(getGatewayErrorMessage(err))
    }
  }

  const savePlugin = async (event: FormEvent) => {
    event.preventDefault()
    if (!pluginForm.key.trim() || !pluginForm.label.trim()) {
      notify.warning(t('errPluginKeyLabel'))
      return
    }
    try {
      await gatewayControlAPI.upsertPlugin({
        ...pluginForm,
        key: pluginForm.key.trim(),
        label: pluginForm.label.trim(),
        module: pluginForm.module.trim(),
        desc: pluginForm.desc.trim(),
        requires: (pluginForm.requires || []).filter(Boolean),
      })
      notify.success(t('pluginSaved'))
      setPluginForm({ key: '', type: 'auth', label: '', module: '', desc: '', requires: [] })
      await loadGatewayData()
    } catch (err) {
      notify.error(getGatewayErrorMessage(err))
    }
  }

  const deletePlugin = async (plugin: GatewayPlugin) => {
    if (plugin.builtin) return
    if (!window.confirm(t('confirmDeletePlugin', { key: plugin.key }))) return
    try {
      await gatewayControlAPI.deletePlugin(plugin.key)
      notify.success(t('pluginDeleted'))
      await loadGatewayData()
    } catch (err) {
      notify.error(getGatewayErrorMessage(err))
    }
  }

  const toggleProjectPlugin = async (key: string, enabled: boolean) => {
    const previous = projectPluginKeys
    const next = resolveProjectPluginKeys(plugins, projectPluginKeys, key, enabled)
    try {
      const saved = await gatewayControlAPI.setProjectPlugins(project, next)
      setProjectPluginKeys(saved)
      const autoEnabled = saved.filter((item) => !previous.includes(item))
      if (autoEnabled.length > 0) {
        notify.success(t('projPluginSavedAuto', { deps: autoEnabled.join(', ') }))
      } else {
        notify.success(t('projPluginSaved'))
      }
      if (!enabled) {
        if (workflowAsset && !saved.includes('workflow_token_inject')) setWorkflowAsset('')
        if (esAsset && !saved.includes('es_app_token_inject')) setEsAsset('')
      }
    } catch (err) {
      notify.error(getGatewayErrorMessage(err))
    }
  }

  const saveAsset = async (event: FormEvent) => {
    event.preventDefault()
    if (!assetForm.name.trim() || !assetForm.plaintext.trim()) {
      notify.warning(t('errAssetNameKey'))
      return
    }
    try {
      await gatewayControlAPI.createAsset({
        ...assetForm,
        name: assetForm.name.trim(),
        project,
        key_id: assetForm.key_id || undefined,
        desc: assetForm.desc?.trim(),
      })
      notify.success(t('assetSaved'))
      setAssetForm({
        name: '',
        type: 'workflow_token',
        project,
        key_id: activeKeyId,
        plaintext: '',
        desc: '',
      })
      await loadGatewayData()
    } catch (err) {
      notify.error(getGatewayErrorMessage(err))
    }
  }

  const replaceAsset = async (asset: GatewaySecretAsset) => {
    const plaintext = window.prompt(t('promptNewKey', { name: asset.name }))
    if (!plaintext) return
    try {
      await gatewayControlAPI.replaceAsset(asset.name, {
        name: asset.name,
        type: asset.type,
        project: asset.project,
        key_id: activeKeyId || asset.key_id,
        plaintext,
        desc: asset.desc,
      })
      notify.success(t('assetReplaced'))
      await loadGatewayData()
    } catch (err) {
      notify.error(getGatewayErrorMessage(err))
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">{t('title')}</h1>
            <p className="text-xs text-gray-500 mt-1">
              {t('subtitle', { label: gatewayBaseLabel })}
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span
              className={`text-xs px-2 py-1 rounded-full ${
                health === 'ok'
                  ? 'bg-green-50 text-green-700'
                  : health === 'down'
                    ? 'bg-red-50 text-red-700'
                    : 'bg-gray-50 text-gray-600'
              }`}
            >
              {health === 'ok' && t('cpOnline')}
              {health === 'down' && t('cpDown')}
              {health === 'checking' && t('cpChecking')}
            </span>
            <button
              onClick={loadGatewayData}
              disabled={loading}
              className="px-3 py-2 text-xs rounded-md border border-gray-200 hover:bg-gray-50 disabled:opacity-60"
            >
              <i className={`fas fa-rotate mr-1 ${loading ? 'fa-spin' : ''}`}></i>
              {t('refresh')}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-4">
          <label className="text-xs text-gray-500">
            Project
            <input
              value={`${projectName} (${project})`}
              readOnly
              className="mt-1 w-full border border-gray-200 rounded-md px-3 py-2 text-sm bg-gray-50"
            />
          </label>
          <label className="text-xs text-gray-500">
            Env
            <select
              value={env}
              onChange={(event) => setEnv(event.target.value as GatewayEnv)}
              className="mt-1 w-full border border-gray-200 rounded-md px-3 py-2 text-sm bg-white"
            >
              <option value="prod">prod</option>
              <option value="intranet">intranet</option>
            </select>
          </label>
          <label className="text-xs text-gray-500">
            {t('activeHost')}
            <select
              value={activeConfiguredHost}
              disabled={hostOptions.length === 0 || !!manualHost.trim()}
              className="mt-1 w-full border border-gray-200 rounded-md px-3 py-2 text-sm bg-white disabled:bg-gray-50"
              onChange={(event) => setSelectedConfiguredHost(event.target.value)}
            >
              {hostOptions.length > 0 ? (
                hostOptions.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))
              ) : (
                <option value="">{t('noPresetHost')}</option>
              )}
            </select>
          </label>
          <label className="text-xs text-gray-500">
            {t('manualHost')}
            <input
              value={manualHost}
              onChange={(event) => setManualHost(event.target.value)}
              placeholder="localhost:8080"
              className="mt-1 w-full border border-gray-200 rounded-md px-3 py-2 text-sm font-mono"
            />
          </label>
        </div>
        {manualHostOverridesPreset && (
          <p className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
            {t.rich('manualOverride', {
              manual: () => <span className="font-mono">{manualHost.trim()}</span>,
              active: () => <span className="font-mono">{activeConfiguredHost}</span>,
            })}
          </p>
        )}

        <div className="mt-4 border border-blue-100 bg-blue-50/40 rounded-lg p-3">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-[180px]">
              <h3 className="text-sm font-semibold text-gray-900">{t('hostAccessH')}</h3>
              <p className="text-xs text-gray-500 mt-1">
                {t('hostAccessDesc')}
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1">
              <label className="text-xs text-gray-500">
                {t('prodHosts')}
                <textarea
                  value={configuredHostsText.prod}
                  onChange={(event) =>
                    setConfiguredHostsText((prev) => ({ ...prev, prod: event.target.value }))
                  }
                  rows={3}
                  spellCheck={false}
                  placeholder="planeos-auth.acme.net"
                  className="mt-1 w-full border border-gray-200 rounded-md px-3 py-2 text-sm font-mono bg-white"
                />
              </label>
              <label className="text-xs text-gray-500">
                {t('internalHosts')}
                <textarea
                  value={configuredHostsText.intranet}
                  onChange={(event) =>
                    setConfiguredHostsText((prev) => ({ ...prev, intranet: event.target.value }))
                  }
                  rows={3}
                  spellCheck={false}
                  placeholder="gateway-internal.example.com"
                  className="mt-1 w-full border border-gray-200 rounded-md px-3 py-2 text-sm font-mono bg-white"
                />
              </label>
            </div>
            <button
              type="button"
              onClick={saveGatewayConfig}
              disabled={savingGatewayConfig}
              className="px-3 py-2 text-xs rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
            >
              <i className={`fas fa-save mr-1 ${savingGatewayConfig ? 'fa-spin' : ''}`}></i>
              {t('saveConfig')}
            </button>
          </div>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="flex border-b border-gray-200 px-3">
          {[
            ['routes', 'Route Policies', 'fa-route'],
            ['blacklist', t('tabBlacklist'), 'fa-ban'],
            ['monitoring', t('tabMonitoring'), 'fa-chart-line'],
            ['plugins', t('tabPlugins'), 'fa-plug'],
            ['keys', t('tabKeys'), 'fa-key'],
            ['cli', 'CLI Token', 'fa-terminal'],
            ['audit', t('tabAudit'), 'fa-clipboard-list'],
          ].map(([key, label, icon]) => (
            <button
              key={key}
              onClick={() => setTab(key as MainTab)}
              className={`px-4 py-3 text-sm border-b-2 ${
                tab === key
                  ? 'border-blue-600 text-blue-600 font-semibold'
                  : 'border-transparent text-gray-500 hover:text-gray-900'
              }`}
            >
              <i className={`fas ${icon} mr-2 text-xs`}></i>
              {label}
            </button>
          ))}
        </div>

        {tab === 'routes' && (
          <div className="grid grid-cols-1 xl:grid-cols-[300px_1fr] min-h-[640px]">
            <aside className="border-r border-gray-200 bg-gray-50/50">
              <div className="p-3 border-b border-gray-200">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <div className="text-sm font-semibold text-gray-900">Routes</div>
                    <div className="text-[11px] text-gray-500 font-mono">{project} / {host || '-'}</div>
                  </div>
                  <button
                    onClick={startNewRoute}
                    className="w-8 h-8 rounded-md border border-gray-200 bg-white hover:bg-blue-50 text-gray-500 hover:text-blue-600"
                  >
                    <i className="fas fa-plus text-xs"></i>
                  </button>
                </div>
                <input
                  value={routeSearch}
                  onChange={(event) => setRouteSearch(event.target.value)}
                  placeholder={t('phSearchRoute')}
                  className="w-full border border-gray-200 rounded-md px-3 py-2 text-xs"
                />
                <div className="flex flex-wrap gap-1 mt-2">
                  {['all', 'workflow', 'es_app', 'supabase', 'events'].map((item) => (
                    <button
                      key={item}
                      onClick={() => setRouteFilter(item)}
                      className={`px-2 py-1 text-[11px] rounded-full ${
                        routeFilter === item ? 'bg-blue-50 text-blue-600 border border-blue-200' : 'text-gray-500'
                      }`}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>
              <div className="max-h-[560px] overflow-y-auto">
                {filteredRoutes.map((row) => {
                  const type = inferRouteType(row.prefix, row.policy)
                  return (
                    <button
                      key={row.prefix}
                      onClick={() => applyRoute(row)}
                      className={`w-full text-left p-3 border-b border-gray-100 hover:bg-white ${
                        !isDraftRoute && selectedPrefix === row.prefix
                          ? 'bg-blue-50 border-l-4 border-l-blue-600'
                          : ''
                      }`}
                    >
                      <div className="font-mono text-xs font-semibold text-gray-900 break-all">{row.prefix}</div>
                      <div className="text-[11px] text-gray-500 mt-1">
                        {inferRouteOwnerProject(row.prefix, row.policy) || project} · {type}
                      </div>
                      <div className="flex flex-wrap gap-1 mt-2">
                        <span className="px-2 py-0.5 text-[10px] rounded-full bg-purple-50 text-purple-700">
                          {row.policy.auth || 'none'}
                        </span>
                        {row.policy.timestamp?.enabled && (
                          <span className="px-2 py-0.5 text-[10px] rounded-full bg-green-50 text-green-700">
                            timestamp
                          </span>
                        )}
                        {row.policy.waf?.enabled && (
                          <span className="px-2 py-0.5 text-[10px] rounded-full bg-blue-50 text-blue-700">
                            WAF
                          </span>
                        )}
                      </div>
                    </button>
                  )
                })}
                {filteredRoutes.length === 0 && (
                  <div className="p-6 text-center text-sm text-gray-400">{t('noRoutePolicy')}</div>
                )}
              </div>
            </aside>

            <section className="p-5 space-y-5">
              <div className="flex flex-wrap items-center gap-3">
                <div>
                  <h2 className="font-mono text-base font-semibold text-gray-900">
                    {isDraftRoute ? t('newRoute') : selectedPrefix || t('selectRoute')}
                  </h2>
                  {isDraftRoute && (
                    <p className="text-xs text-blue-600 mt-1">
                      {t('draftHint')}
                    </p>
                  )}
                  <p className="text-xs text-gray-500 mt-1">{t('hsetHint')}</p>
                </div>
                <div className="ml-auto flex gap-2">
                  <button
                    onClick={deleteRoute}
                    disabled={!selectedPrefix || isDraftRoute}
                    className="px-3 py-2 rounded-md text-xs border border-red-200 text-red-600 bg-red-50 disabled:opacity-50"
                  >
                    {t('delRoute')}
                  </button>
                  <button
                    onClick={publishRoute}
                    className="px-4 py-2 rounded-md text-xs bg-blue-600 text-white hover:bg-blue-700"
                  >
                    {t('publishRedis')}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <label className="text-xs text-gray-500">
                  Route Prefix
                  <input
                    value={selectedPrefix}
                    onChange={(event) => setSelectedPrefix(event.target.value)}
                    className="mt-1 w-full border border-gray-200 rounded-md px-3 py-2 text-sm font-mono"
                  />
                </label>
                <label className="text-xs text-gray-500">
                  Route Type
                  <select
                    value={routeType}
                    onChange={(event) => setRouteType(event.target.value)}
                    className="mt-1 w-full border border-gray-200 rounded-md px-3 py-2 text-sm bg-white"
                  >
                    <option value="workflow">workflow</option>
                    <option value="es_app">es_app</option>
                    <option value="supabase">supabase</option>
                    <option value="events">events</option>
                  </select>
                </label>
                <label className="text-xs text-gray-500">
                  {t('status')}
                  <select
                    value={policy.enabled ? 'enabled' : 'disabled'}
                    onChange={(event) => updatePolicy({ enabled: event.target.value === 'enabled' })}
                    className="mt-1 w-full border border-gray-200 rounded-md px-3 py-2 text-sm bg-white"
                  >
                    <option value="enabled">{t('statusEnabled')}</option>
                    <option value="disabled">{t('statusDisabled')}</option>
                  </select>
                </label>
                <label className="md:col-span-3 text-xs text-gray-500">
                  {t('descLabel')}
                  <input
                    value={policy.description || ''}
                    onChange={(event) => updatePolicy({ description: event.target.value })}
                    className="mt-1 w-full border border-gray-200 rounded-md px-3 py-2 text-sm"
                  />
                </label>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="border border-gray-200 rounded-lg p-4 space-y-3">
                  <h3 className="text-sm font-semibold text-gray-900">{t('inboundIdentityH')}</h3>
                  <p className="text-xs text-gray-500">
                    {t.rich('inboundIdentityDesc', {
                      c: (chunks) => <code className="px-1 bg-gray-100 rounded">{chunks}</code>,
                    })}
                  </p>
                  <label className="text-xs text-gray-500 block">
                    {t('authPlugin')}
                    {authPlugins.length === 0 ? (
                      <div className="mt-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        {t('authNeedEnable')}
                      </div>
                    ) : (
                      <select
                        value={policy.auth}
                        onChange={(event) => updatePolicyAuth(event.target.value)}
                        className="mt-1 w-full border border-gray-200 rounded-md px-3 py-2 text-sm bg-white"
                      >
                        {currentAuthDisabled && (
                          <option value={currentAuthKey}>
                            {t('authNotEnabledOpt', { key: currentAuthKey })}
                          </option>
                        )}
                        {authPlugins.map((plugin) => (
                          <option key={plugin.key} value={plugin.key}>
                            {plugin.label} ({plugin.key})
                          </option>
                        ))}
                      </select>
                    )}
                  </label>
                  {currentAuthDisabled && (
                    <p className="text-xs text-amber-700">
                      {t('authRouteWarn', { key: currentAuthKey })}
                    </p>
                  )}
                  <p className="text-xs text-gray-400">
                    {t('projEnabled')}
                    {projectPluginKeys.length > 0 ? projectPluginKeys.join(', ') : t('none')}
                  </p>
                  {policy.auth === 'supabase' && (
                    <label className="text-xs text-gray-500 block">
                      Supabase Handler
                      <select
                        value={policy.handler || 'default'}
                        onChange={(event) => updatePolicy({ handler: event.target.value })}
                        className="mt-1 w-full border border-gray-200 rounded-md px-3 py-2 text-sm bg-white"
                      >
                        <option value="default">default</option>
                        <option value="supabase">supabase</option>
                      </select>
                    </label>
                  )}
                </div>

                <div className="border border-gray-200 rounded-lg p-4 space-y-3">
                  <h3 className="text-sm font-semibold text-gray-900">{t('timestampSign')}</h3>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={policy.timestamp?.enabled ?? false}
                      onChange={(event) => updatePolicy({
                        timestamp: { ...(policy.timestamp || {}), enabled: event.target.checked },
                      })}
                    />
                    {t('enableMd5')}
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="text-xs text-gray-500">
                      salt_env
                      <input
                        value={policy.timestamp?.salt_env || ''}
                        onChange={(event) => updatePolicy({
                          timestamp: { ...(policy.timestamp || { enabled: true }), salt_env: event.target.value },
                        })}
                        className="mt-1 w-full border border-gray-200 rounded-md px-3 py-2 text-sm font-mono"
                      />
                    </label>
                    <label className="text-xs text-gray-500">
                      {t('windowSec')}
                      <input
                        type="number"
                        value={policy.timestamp?.window || 60}
                        onChange={(event) => updatePolicy({
                          timestamp: { ...(policy.timestamp || { enabled: true }), window: Number(event.target.value) },
                        })}
                        className="mt-1 w-full border border-gray-200 rounded-md px-3 py-2 text-sm font-mono"
                      />
                    </label>
                  </div>
                </div>
              </div>

              <div className="border border-gray-200 rounded-lg p-4 space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">{t('securityPlugins')}</h3>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={policy.waf?.enabled ?? false}
                      onChange={(event) => updatePolicy({
                        waf: { ...(policy.waf || { profile: 'basic' }), enabled: event.target.checked },
                      })}
                    />
                    WAF
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={policy.ip_filter?.enabled ?? false}
                      onChange={(event) => updatePolicy({
                        ip_filter: { ...(policy.ip_filter || { blacklist: [] }), enabled: event.target.checked },
                      })}
                    />
                    {t('routeIpBlacklist')}
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={policy.rate_limit?.enabled ?? false}
                      onChange={(event) => updatePolicy({
                        rate_limit: { ...(policy.rate_limit || { qps: 120, dim: 'ip', code: 429 }), enabled: event.target.checked },
                      })}
                    />
                    Rate Limit
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={policy.ip_filter?.allowlist_enabled ?? false}
                      onChange={(event) => updatePolicy({
                        ip_filter: {
                          ...(policy.ip_filter || { enabled: false, blacklist: [] }),
                          allowlist_enabled: event.target.checked,
                        },
                      })}
                    />
                    Route IP Allowlist
                  </label>
                </div>
                {policy.waf?.enabled && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <label className="text-xs text-gray-500 block">
                      WAF Profile
                      <select
                        value={policy.waf?.profile || 'basic'}
                        onChange={(event) => updatePolicy({
                          waf: { ...(policy.waf || { enabled: true }), profile: event.target.value },
                        })}
                        className="mt-1 w-full border border-gray-200 rounded-md px-3 py-2 text-sm bg-white"
                      >
                        <option value="basic">{t('wafBasic')}</option>
                        <option value="strict">{t('wafStrict')}</option>
                      </select>
                    </label>
                    <label className="text-xs text-gray-500 block">
                      {t('wafBodyLimit')}
                      <input
                        type="number"
                        min={1}
                        value={policy.waf_body_max_bytes ?? 8192}
                        onChange={(event) => updatePolicy({
                          waf_body_max_bytes: Number(event.target.value),
                        })}
                        className="mt-1 w-full border border-gray-200 rounded-md px-3 py-2 text-sm font-mono"
                      />
                      <span className="block mt-1 text-[11px] text-gray-400">{t('wafBodyLimitHint')}</span>
                    </label>
                  </div>
                )}
                {policy.ip_filter?.enabled && (
                  <label className="text-xs text-gray-500 block">
                    {t('blacklistLabel')}
                    <textarea
                      value={routeBlacklistText}
                      onChange={(event) => setRouteBlacklistText(event.target.value)}
                      className="mt-1 w-full min-h-[90px] border border-gray-200 rounded-md px-3 py-2 text-sm font-mono"
                    />
                  </label>
                )}
                {policy.ip_filter?.allowlist_enabled && (
                  <label className="text-xs text-gray-500 block">
                    {t('allowlistLabel')}
                    <textarea
                      value={routeAllowlistText}
                      onChange={(event) => setRouteAllowlistText(event.target.value)}
                      placeholder={'203.0.113.10\n10.0.0.0/8'}
                      className="mt-1 w-full min-h-[90px] border border-gray-200 rounded-md px-3 py-2 text-sm font-mono"
                    />
                    <span className="block mt-1 text-[11px] text-gray-400">
                      {t('allowlistHint')}
                    </span>
                  </label>
                )}
                {policy.rate_limit?.enabled && (
                  <div className="grid grid-cols-3 gap-3">
                    <label className="text-xs text-gray-500">
                      QPS
                      <input
                        type="number"
                        value={policy.rate_limit?.qps || 120}
                        onChange={(event) => updatePolicy({
                          rate_limit: { ...(policy.rate_limit || { enabled: true }), qps: Number(event.target.value) },
                        })}
                        className="mt-1 w-full border border-gray-200 rounded-md px-3 py-2 text-sm font-mono"
                      />
                    </label>
                    <label className="text-xs text-gray-500">
                      {t('dimension')}
                      <select
                        value={policy.rate_limit?.dim || 'ip'}
                        onChange={(event) => updatePolicy({
                          rate_limit: { ...(policy.rate_limit || { enabled: true }), dim: event.target.value },
                        })}
                        className="mt-1 w-full border border-gray-200 rounded-md px-3 py-2 text-sm bg-white"
                      >
                        <option value="ip">ip</option>
                      </select>
                    </label>
                    <label className="text-xs text-gray-500">
                      {t('limitCode')}
                      <input
                        type="number"
                        value={policy.rate_limit?.code || 429}
                        onChange={(event) => updatePolicy({
                          rate_limit: { ...(policy.rate_limit || { enabled: true }), code: Number(event.target.value) },
                        })}
                        className="mt-1 w-full border border-gray-200 rounded-md px-3 py-2 text-sm font-mono"
                      />
                    </label>
                  </div>
                )}
              </div>

              <div className="border border-gray-200 rounded-lg p-4 space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">{t('backendInjectH')}</h3>
                <p className="text-xs text-gray-500">
                  {t('backendInjectDesc')}
                </p>
                {isSupabaseAuth ? (
                  <>
                    <p className="text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded-md px-3 py-2">
                      {t('supabaseNoInject')}
                    </p>
                    {hasLegacySupabaseCredential && (
                      <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                        {t('legacyTokenRemove')}
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    {!showWorkflowAsset && !showEsAsset && (
                      <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                        {t('injectNeedEnable')}
                      </p>
                    )}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                      {showWorkflowAsset && (
                        <label className="text-xs text-gray-500">
                          {t('wfKeyAsset')}
                          <select
                            value={workflowAsset}
                            onChange={(event) => {
                              const value = event.target.value
                              setWorkflowAsset(value)
                              if (value) setEsAsset('')
                            }}
                            className="mt-1 w-full border border-gray-200 rounded-md px-3 py-2 text-sm bg-white"
                          >
                            <option value="">{t('noInjectWfToken')}</option>
                            {workflowAssets.map((asset) => (
                              <option key={asset.name} value={asset.name}>
                                {asset.name} · {asset.masked} · {asset.key_id}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      {showEsAsset && (
                        <label className="text-xs text-gray-500">
                          {t('esKeyAsset')}
                          <select
                            value={esAsset}
                            onChange={(event) => {
                              const value = event.target.value
                              setEsAsset(value)
                              if (value) setWorkflowAsset('')
                            }}
                            className="mt-1 w-full border border-gray-200 rounded-md px-3 py-2 text-sm bg-white"
                          >
                            <option value="">{t('noInjectEsToken')}</option>
                            {esAssets.map((asset) => (
                              <option key={asset.name} value={asset.name}>
                                {asset.name} · {asset.masked} · {asset.key_id}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    </div>
                    {(policy.workflow_token?.redacted || policy.es_app_token?.redacted) && (
                      <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2">
                        {t('tokenMaskedWarn')}
                      </div>
                    )}
                  </>
                )}
              </div>

              <div>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{t('redisWritePreview')}</div>
                <pre className="bg-slate-950 text-sky-100 rounded-lg p-4 text-xs overflow-auto max-h-[360px]">
                  {routePreview}
                </pre>
              </div>
            </section>
          </div>
        )}

        {tab === 'blacklist' && (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_420px] min-h-[520px]">
            <section className="p-6 max-w-2xl">
              <h2 className="text-base font-semibold text-gray-900">{t('hostBlacklistH')}</h2>
              <p className="text-sm text-gray-500 mt-2 leading-6">
                {t('hostBlacklistDesc')}
              </p>
              <textarea
                value={globalBlacklistText}
                onChange={(event) => setGlobalBlacklistText(event.target.value)}
                placeholder={'45.153.0.0/20\n185.234.218.0/24\n1.2.3.4'}
                className="mt-5 w-full min-h-[260px] border border-gray-200 rounded-lg px-3 py-3 text-sm font-mono"
              />
              <button
                onClick={saveBlacklist}
                className="mt-4 px-4 py-2 rounded-md text-sm bg-blue-600 text-white hover:bg-blue-700"
              >
                {t('publishHostBlacklist')}
              </button>
            </section>
            <aside className="border-l border-gray-200 p-5 bg-gray-50">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{t('redisWritePreview')}</div>
              <pre className="bg-slate-950 text-sky-100 rounded-lg p-4 text-xs overflow-auto">
                {blacklistPreview}
              </pre>
            </aside>
          </div>
        )}

        {tab === 'monitoring' && (
          <div className="p-5 space-y-5 bg-gray-50/40 min-h-[640px]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-gray-900">{t('gwMonitorH')}</h2>
                <p className="text-xs text-gray-500 mt-1">
                  {t('gwMonitorDesc')}
                </p>
                <div className="text-[11px] text-gray-400 font-mono mt-1">
                  {t('monitorMeta', { env, host: host || '-', gran: accessStats?.granularity || '-' })}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={statsRange}
                  onChange={(event) => setStatsRange(event.target.value as GatewayAccessStatsRange)}
                  className="border border-gray-200 rounded-md px-3 py-2 text-xs bg-white"
                >
                  {ACCESS_STATS_RANGES.map((item) => (
                    <option key={item.value} value={item.value}>{t(item.labelKey)}</option>
                  ))}
                </select>
                <label className="flex items-center gap-2 text-xs text-gray-500 border border-gray-200 rounded-md px-3 py-2 bg-white">
                  <input
                    type="checkbox"
                    checked={statsAutoRefresh}
                    onChange={(event) => setStatsAutoRefresh(event.target.checked)}
                  />
                  {t('autoRefresh')}
                </label>
                <button
                  type="button"
                  onClick={loadAccessStats}
                  disabled={statsLoading || !host}
                  className="px-3 py-2 text-xs rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
                >
                  <i className={`fas fa-sync mr-1 ${statsLoading ? 'fa-spin' : ''}`}></i>
                  {t('refresh')}
                </button>
              </div>
            </div>

            {!host && (
              <div className="border border-amber-200 bg-amber-50 text-amber-800 rounded-lg px-4 py-3 text-sm">
                {t('selectHostFirst')}
              </div>
            )}

            {host && (
              <>
                {accessStats && accessStats.series.length === 0 && !statsLoading && (
                  <div className="border border-amber-200 bg-amber-50 text-amber-800 rounded-lg px-4 py-3 text-sm leading-6">
                    {t('noMonitorData')}
                  </div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                  <MetricCard
                    label={t('mTotalReq')}
                    value={formatCount(accessStats?.summary.total_requests)}
                    hint={formatChange(accessStats?.summary.total_requests, accessStats?.previous?.total_requests, t)}
                  />
                  <MetricCard
                    label={t('mErrorRate')}
                    value={formatPercent(accessStats?.summary.error_rate)}
                    hint={`4xx ${formatCount(accessStats?.summary.err_4xx)} · 5xx ${formatCount(accessStats?.summary.err_5xx)}`}
                  />
                  <MetricCard
                    label={t('mAvgLatency')}
                    value={formatRT(accessStats?.summary.avg_rt)}
                    hint={`P50 ${formatRT(accessStats?.summary.p50_rt)} · P95 ${formatRT(accessStats?.summary.p95_rt)} · P99 ${formatRT(accessStats?.summary.p99_rt)}`}
                  />
                  <MetricCard
                    label={t('mLastAgg')}
                    value={formatTime(accessStats?.summary.last_ts)}
                    hint={statsLoading ? t('mRefreshing') : t('mAggHint')}
                  />
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <TrendChart
                    title={t('reqTrend')}
                    points={accessStats?.series || []}
                    value={(point) => point.total_requests}
                    formatValue={formatCount}
                  />
                  <LatencyPercentileChart points={accessStats?.series || []} />
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <DistributionBars title={t('statusDist')} values={accessStats?.status_dist || {}} />
                  <DistributionBars title={t('methodDist')} values={accessStats?.method_dist || {}} />
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                  <UriList title="Top URI" items={accessStats?.top_uri || []} kind="top" />
                  <UriList title={t('errorUri')} items={accessStats?.error_uri || []} kind="error" />
                  <SlowRequestList items={accessStats?.slow_req || []} />
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'plugins' && (
          <div>
            <div className="flex border-b border-gray-100 px-4">
              <button
                onClick={() => setPluginTab('registry')}
                className={`px-4 py-3 text-sm border-b-2 ${pluginTab === 'registry' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500'}`}
              >
                {t('pluginRegistry')}
              </button>
              <button
                onClick={() => setPluginTab('assign')}
                className={`px-4 py-3 text-sm border-b-2 ${pluginTab === 'assign' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500'}`}
              >
                {t('projAssoc')}
              </button>
            </div>
            {pluginTab === 'registry' && (
              <div className="p-5 space-y-5">
                <p className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-md px-3 py-2 leading-6">
                  {t('orderHint')}
                </p>
                <form onSubmit={savePlugin} className="border border-gray-200 rounded-lg p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
                  <h3 className="md:col-span-2 text-sm font-semibold text-gray-900">{t('registerPlugin')}</h3>
                  <p className="md:col-span-2 text-xs text-gray-500">
                    {t.rich('registerPluginDesc', {
                      b1: (chunks) => <span className="font-medium">{chunks}</span>,
                      b2: (chunks) => <span className="font-medium">{chunks}</span>,
                    })}
                  </p>
                  <input value={pluginForm.key} onChange={(event) => setPluginForm((p) => ({ ...p, key: event.target.value }))} placeholder={t('phPluginKey')} className="border border-gray-200 rounded-md px-3 py-2 text-sm font-mono" />
                  <select value={pluginForm.type} onChange={(event) => setPluginForm((p) => ({ ...p, type: event.target.value as GatewayPlugin['type'] }))} className="border border-gray-200 rounded-md px-3 py-2 text-sm bg-white">
                    <option value="auth">{t('optAuthStage')}</option>
                    <option value="inject">{t('optInjectStage')}</option>
                  </select>
                  <input value={pluginForm.label} onChange={(event) => setPluginForm((p) => ({ ...p, label: event.target.value }))} placeholder={t('phDisplayName')} className="border border-gray-200 rounded-md px-3 py-2 text-sm" />
                  <input value={pluginForm.module} onChange={(event) => setPluginForm((p) => ({ ...p, module: event.target.value }))} placeholder={t('phLuaModule')} className="border border-gray-200 rounded-md px-3 py-2 text-sm font-mono" />
                  <input value={pluginForm.desc} onChange={(event) => setPluginForm((p) => ({ ...p, desc: event.target.value }))} placeholder={t('phPluginDesc')} className="md:col-span-2 border border-gray-200 rounded-md px-3 py-2 text-sm" />
                  <input value={(pluginForm.requires || []).join(',')} onChange={(event) => setPluginForm((p) => ({ ...p, requires: event.target.value.split(',').map((v) => v.trim()).filter(Boolean) }))} placeholder={t('phRequires')} className="md:col-span-2 border border-gray-200 rounded-md px-3 py-2 text-sm font-mono" />
                  <button className="md:col-span-2 justify-self-start px-4 py-2 rounded-md bg-blue-600 text-white text-sm">{t('savePlugin')}</button>
                </form>
                <div className="space-y-4">
                  {(
                    [
                      { title: t('groupAuth'), items: identityPlugins },
                      { title: t('groupInject'), items: credentialPlugins },
                    ] as const
                  ).map(({ title, items }) => (
                    <div key={title} className="border border-gray-200 rounded-lg overflow-hidden">
                      <div className="px-4 py-2 bg-gray-50 text-xs font-semibold text-gray-700">{title}</div>
                      {items.map((plugin) => (
                        <div key={plugin.key} className="grid grid-cols-[160px_100px_1fr_180px_80px] gap-3 items-center px-4 py-3 border-b border-gray-100 text-sm">
                          <span className="font-mono font-semibold">{plugin.key}</span>
                          <span className="text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-700 justify-self-start">
                            {formatPluginPhase(plugin.type, t)}
                          </span>
                          <span className="text-gray-600 text-xs">{plugin.desc}</span>
                          <span className="font-mono text-xs text-gray-500">{plugin.module || '-'}</span>
                          <button
                            onClick={() => deletePlugin(plugin)}
                            disabled={plugin.builtin}
                            className="text-xs text-red-600 disabled:text-gray-400"
                          >
                            {plugin.builtin ? t('builtin') : t('delete')}
                          </button>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {pluginTab === 'assign' && (
              <div className="p-5">
                <h3 className="text-sm font-semibold text-gray-900 mb-2">{t('projAvailPlugins', { name: projectName })}</h3>
                <p className="text-xs text-gray-500 mb-3 leading-6">
                  {t.rich('projAssocDesc', {
                    c: (chunks) => <code className="px-1 bg-gray-100 rounded">{chunks}</code>,
                    b1: (chunks) => <strong>{chunks}</strong>,
                    b2: (chunks) => <strong>{chunks}</strong>,
                  })}
                </p>
                <div className="space-y-4">
                  {(
                    [
                      { title: t('groupAuth'), items: identityPlugins },
                      { title: t('groupInject'), items: credentialPlugins },
                    ] as const
                  ).map(({ title, items }) => (
                    <div key={title} className="border border-gray-200 rounded-lg overflow-hidden">
                      <div className="px-4 py-2 bg-gray-50 text-xs font-semibold text-gray-700">{title}</div>
                      {items.map((plugin) => (
                        <div key={plugin.key} className="grid grid-cols-[180px_100px_1fr_80px] gap-3 items-center px-4 py-3 border-b border-gray-100 text-sm">
                          <div>
                            <div className="font-semibold">{plugin.label}</div>
                            <div className="font-mono text-xs text-gray-400">{plugin.key}</div>
                          </div>
                          <span className="text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-700 justify-self-start">
                            {formatPluginPhase(plugin.type, t)}
                          </span>
                          <span className="text-xs text-gray-600">{plugin.desc}</span>
                          <label className="flex justify-end items-center gap-2">
                            {(plugin.requires || []).length > 0 && (
                              <span className="text-[10px] text-gray-400 font-mono">
                                {t('dependsOn', { deps: (plugin.requires || []).join(', ') })}
                              </span>
                            )}
                            <input
                              type="checkbox"
                              checked={projectPluginKeys.includes(plugin.key)}
                              onChange={(event) => toggleProjectPlugin(plugin.key, event.target.checked)}
                            />
                          </label>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'keys' && (
          <div>
            <div className="flex border-b border-gray-100 px-4">
              <button
                onClick={() => setKeyTab('assets')}
                className={`px-4 py-3 text-sm border-b-2 ${keyTab === 'assets' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500'}`}
              >
                {t('apiKeyAssets')}
              </button>
              <button
                onClick={() => setKeyTab('versions')}
                className={`px-4 py-3 text-sm border-b-2 ${keyTab === 'versions' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500'}`}
              >
                Key Versions
              </button>
            </div>
            {keyTab === 'assets' && (
              <div className="p-5 space-y-5">
                <form onSubmit={saveAsset} className="border border-gray-200 rounded-lg p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
                  <h3 className="md:col-span-2 text-sm font-semibold text-gray-900">{t('newApiKeyAsset')}</h3>
                  <input value={assetForm.name} onChange={(event) => setAssetForm((p) => ({ ...p, name: event.target.value }))} placeholder={t('phAssetName')} className="border border-gray-200 rounded-md px-3 py-2 text-sm font-mono" />
                  <select value={assetForm.type} onChange={(event) => setAssetForm((p) => ({ ...p, type: event.target.value as GatewayAssetType }))} className="border border-gray-200 rounded-md px-3 py-2 text-sm bg-white">
                    <option value="workflow_token">workflow_token</option>
                    <option value="es_app_token">es_app_token</option>
                  </select>
                  <input value={assetForm.key_id || ''} onChange={(event) => setAssetForm((p) => ({ ...p, key_id: event.target.value }))} placeholder={activeKeyId || 'key_id'} className="border border-gray-200 rounded-md px-3 py-2 text-sm font-mono" />
                  <input value={assetForm.plaintext} onChange={(event) => setAssetForm((p) => ({ ...p, plaintext: event.target.value }))} placeholder={t('phPlaintextKey')} type="password" className="border border-gray-200 rounded-md px-3 py-2 text-sm font-mono" />
                  <input value={assetForm.desc || ''} onChange={(event) => setAssetForm((p) => ({ ...p, desc: event.target.value }))} placeholder={t('phAssetDesc')} className="md:col-span-2 border border-gray-200 rounded-md px-3 py-2 text-sm" />
                  <button className="md:col-span-2 justify-self-start px-4 py-2 rounded-md bg-blue-600 text-white text-sm">{t('submitEncrypt')}</button>
                </form>
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  {assets.map((asset) => (
                    <div key={asset.name} className="grid grid-cols-[1fr_110px_90px_100px_1fr_90px] gap-3 items-center px-4 py-3 border-b border-gray-100 text-sm">
                      <span className="font-mono font-semibold">{asset.name}</span>
                      <span className="text-xs px-2 py-1 rounded-full bg-amber-50 text-amber-700 justify-self-start">{asset.type}</span>
                      <span className="text-xs text-gray-600">{asset.project}</span>
                      <span className="font-mono text-xs text-gray-600">{asset.key_id}</span>
                      <span className="font-mono text-xs text-gray-500">{asset.masked}</span>
                      <button onClick={() => replaceAsset(asset)} className="text-xs text-blue-600">{t('replace')}</button>
                    </div>
                  ))}
                  {assets.length === 0 && <div className="p-8 text-center text-sm text-gray-400">{t('noAssets')}</div>}
                </div>
              </div>
            )}
            {keyTab === 'versions' && (
              <div className="p-5">
                <div className="border border-gray-200 rounded-lg overflow-hidden max-w-2xl">
                  {keyVersions.map((version) => (
                    <div key={version} className="grid grid-cols-[120px_120px_1fr] px-4 py-3 border-b border-gray-100 text-sm">
                      <span className="font-mono font-semibold">{version}</span>
                      <span className={`text-xs px-2 py-1 rounded-full justify-self-start ${version === activeKeyId ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                        {version === activeKeyId ? 'active' : 'loaded'}
                      </span>
                      <span className="text-xs text-gray-500">{t('masterKeyHint')}</span>
                    </div>
                  ))}
                  {keyVersions.length === 0 && <div className="p-8 text-center text-sm text-gray-400">{t('noKeyVersions')}</div>}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'cli' && (
          <div className="p-5 space-y-5">
            <form onSubmit={createCliToken} className="border border-gray-200 rounded-lg p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
              <h3 className="md:col-span-2 text-sm font-semibold text-gray-900">{t('createCliToken')}</h3>
              <input value={cliTokenForm.name} onChange={(event) => setCliTokenForm((p) => ({ ...p, name: event.target.value }))} placeholder={t('phTokenName')} className="border border-gray-200 rounded-md px-3 py-2 text-sm" />
              <input value={cliTokenForm.username} onChange={(event) => setCliTokenForm((p) => ({ ...p, username: event.target.value }))} placeholder={t('phOwner')} className="border border-gray-200 rounded-md px-3 py-2 text-sm" />
              <input value={cliTokenForm.email} onChange={(event) => setCliTokenForm((p) => ({ ...p, email: event.target.value }))} placeholder={t('phEmailOptional')} className="border border-gray-200 rounded-md px-3 py-2 text-sm" />
              <input value={cliTokenForm.scopes} onChange={(event) => setCliTokenForm((p) => ({ ...p, scopes: event.target.value }))} placeholder={t('phScopes')} className="border border-gray-200 rounded-md px-3 py-2 text-sm font-mono" />
              <button className="md:col-span-2 justify-self-start px-4 py-2 rounded-md bg-blue-600 text-white text-sm">{t('createToken')}</button>
            </form>
            {createdCliToken && (
              <div className="border border-amber-200 bg-amber-50 rounded-lg p-4">
                <div className="text-sm font-semibold text-amber-900">{t('saveTokenNow')}</div>
                <pre className="mt-2 bg-white border border-amber-100 rounded-md p-3 text-xs font-mono overflow-auto">{createdCliToken}</pre>
              </div>
            )}
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              {cliTokens.map((token) => (
                <div key={token.id} className="grid grid-cols-[80px_1fr_160px_1fr_90px] gap-3 items-center px-4 py-3 border-b border-gray-100 text-sm">
                  <span className="font-mono text-xs">#{token.id}</span>
                  <div>
                    <div className="font-semibold">{token.name}</div>
                    <div className="text-xs text-gray-400">{token.username}</div>
                  </div>
                  <span className="text-xs text-gray-500">{token.revoked_at ? t('revoked') : t('valid')}</span>
                  <span className="text-xs font-mono text-gray-500 truncate">{(token.scopes || []).join(', ')}</span>
                  <button disabled={!!token.revoked_at} onClick={() => revokeCliToken(token)} className="text-xs text-red-600 disabled:text-gray-400">{t('revoke')}</button>
                </div>
              ))}
              {cliTokens.length === 0 && <div className="p-8 text-center text-sm text-gray-400">{t('noCliToken')}</div>}
            </div>
          </div>
        )}

        {tab === 'audit' && (
          <div className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">{t('auditH')}</h3>
                <p className="text-xs text-gray-500 mt-1">{t('auditDesc')}</p>
              </div>
              <button onClick={loadAuditLogs} className="px-3 py-2 text-xs rounded-md border border-gray-200 text-gray-600">{t('refresh')}</button>
            </div>
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              {auditLogs.map((entry) => (
                <div key={entry.id} className="grid grid-cols-[150px_120px_120px_1fr_120px] gap-3 px-4 py-3 border-b border-gray-100 text-sm">
                  <span className="text-xs text-gray-500">{formatTime(entry.created_at)}</span>
                  <span className="font-mono text-xs">{entry.action}</span>
                  <span className="font-mono text-xs">{entry.resource_type}</span>
                  <div>
                    <div className="font-mono text-xs text-gray-900 break-all">{entry.resource_key}</div>
                    <div className="text-[11px] text-gray-400">{entry.host || entry.project || '-'}</div>
                  </div>
                  <span className="text-xs text-gray-500">{entry.actor_name || entry.actor_type}</span>
                </div>
              ))}
              {auditLogs.length === 0 && <div className="p-8 text-center text-sm text-gray-400">{t('noAuditLogs')}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
