'use client'

/**
 * 对外调用基址（网关域名）的前端单一真源。
 *
 * 背景：运维在网关层新增了对外域名，接口文档展示的调用地址应统一走网关，而不是
 * 前端浏览器碰巧访问到的内网 IP:端口。历史实现散落着 `NEXT_PUBLIC_API_URL || window.location.origin`
 * 的写法，而 `NEXT_PUBLIC_API_URL` 是 **构建期** 变量（会被烤进产物），改域名要重新构建，
 * 谈不上"可配置"。这里统一收敛，并优先采用后端 **运行期** 下发的基址：
 *
 *   1. 后端运行期基址（`GET /api/public/frontend/config` 的 `api_base_url`，或公开文档载荷里的同名字段）
 *      —— 由后端按 `PUBLIC_BASE_URL` 环境变量 / 反代转发头解析，改网关域名无需重建前端。
 *   2. 构建期 `NEXT_PUBLIC_API_URL`（向后兼容旧部署）。
 *   3. 浏览器 `window.location.origin`（最终兜底）。
 */

import { useEffect, useState } from 'react'

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '')
}

/**
 * 纯函数：给定后端下发的运行期基址，按优先级解析最终对外调用基址。
 * `runtimeBase` 为空时回落到构建期变量，再回落到浏览器 origin。
 */
export function resolvePublicApiBase(runtimeBase?: string | null): string {
  const runtime = stripTrailingSlash((runtimeBase || '').trim())
  if (runtime) return runtime

  const built = stripTrailingSlash((process.env.NEXT_PUBLIC_API_URL || '').trim())
  if (built) return built

  if (typeof window !== 'undefined') return window.location.origin
  return ''
}

export interface PublicApiConfig {
  /** 解析后的对外调用基址。 */
  apiBase: string
  /** 是否走网关（后端显式配置了对外基址）：接口文档据此隐藏 API Key 鉴权头。 */
  gatewayMode: boolean
}

interface RuntimeConfig {
  apiBaseRuntime: string
  gatewayMode: boolean
}

// 按作用域缓存：key = tenantId 字符串，或 'platform'（不带 tenant）。
const runtimeConfigCache = new Map<string, Promise<RuntimeConfig>>()

/**
 * 运行期从后端取配置（对外基址 + 是否走网关），按作用域缓存。
 * 传 `tenantId` 时取项目级基址(`?tenant_id=`，项目级 > 平台级)；不传则取平台级。
 * 失败（离线 / 老后端无此端点）时回退默认值，由 `resolvePublicApiBase` 继续兜底。
 */
export function fetchRuntimeConfig(tenantId?: number): Promise<RuntimeConfig> {
  if (typeof window === 'undefined') return Promise.resolve({ apiBaseRuntime: '', gatewayMode: false })
  const key = tenantId != null && Number.isFinite(tenantId) ? String(tenantId) : 'platform'
  let cached = runtimeConfigCache.get(key)
  if (!cached) {
    const qs = key === 'platform' ? '' : `?tenant_id=${key}`
    cached = fetch(`/api/public/frontend/config${qs}`, { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => ({
        apiBaseRuntime: j && typeof j.api_base_url === 'string' ? j.api_base_url : '',
        gatewayMode: !!(j && j.gateway_mode),
      }))
      .catch(() => ({ apiBaseRuntime: '', gatewayMode: false }))
    runtimeConfigCache.set(key, cached)
  }
  return cached
}

/**
 * React hook：返回对外基址 + 是否走网关。
 * 传 `tenantId`（当前项目 id）时取项目级配置；不传取平台级。
 * 运行期配置到达前先用构建期变量 / 浏览器 origin 兜底，拿到后自动切换。
 */
export function usePublicApiConfig(tenantId?: number): PublicApiConfig {
  const [cfg, setCfg] = useState<RuntimeConfig>({ apiBaseRuntime: '', gatewayMode: false })
  useEffect(() => {
    let alive = true
    fetchRuntimeConfig(tenantId).then((v) => {
      if (alive) setCfg(v)
    })
    return () => {
      alive = false
    }
  }, [tenantId])
  return { apiBase: resolvePublicApiBase(cfg.apiBaseRuntime), gatewayMode: cfg.gatewayMode }
}

/** React hook：仅返回解析后的对外调用基址（兼容旧用法）。可传 `tenantId` 取项目级。 */
export function usePublicApiBase(tenantId?: number): string {
  return usePublicApiConfig(tenantId).apiBase
}
