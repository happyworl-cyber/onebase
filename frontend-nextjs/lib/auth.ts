/**
 * 客户端身份令牌存取（localStorage + cookie 双写）。
 *
 * ## 为什么是双写
 *
 * - **localStorage**：现有 axios 请求拦截器（`lib/api.ts`）从这里取 token 写到
 *   `Authorization: Bearer ...` 请求头。后端 axum 也按这个 scheme 校验。
 * - **cookie**：Next.js middleware 跑在 server 端，**读不到 localStorage**。要在
 *   路由层就把"未登录"挡掉（避免页面 HTML/JS 暴露 + 闪烁空页面），就必须把
 *   token 也写一份到 cookie 给 middleware 读。
 *
 * 任何地方改 / 清 token 都应该通过本文件的 helper，避免两边走偏。
 *
 * ## 安全说明
 *
 * - cookie **不是** `HttpOnly`（必须能从 JS 写），所以本质仍是 XSS 易受影响，
 *   与 localStorage 同档。本文件解决的是"前端路由保护"，**不是 XSS 加固**。
 * - 边缘 middleware **不验签**（验签需要把 `JWT_SECRET` 同步到前端进程，
 *   split-brain 风险），仅按 `exp` 字段剪枝；真正的权威鉴权在后端
 *   `auth_middleware` + `user_sessions` 表。
 *
 * ## Cookie 属性
 *
 * - `Path=/`：所有路径可见，middleware 才能读到。
 * - `Max-Age=24h`：与后端 `JWT_EXPIRATION` 默认值对齐。后端通过 jti 表实现
 *   服务端吊销，cookie 过期与否不是权威信号，仅作为前端早期剪枝。
 * - `SameSite=Lax`：跨站点表单提交不带过来（缓解 CSRF），普通导航带过来。
 * - 生产环境（HTTPS）自动加 `Secure`：根据 `location.protocol` 判定。
 */

import { TOKEN_COOKIE } from '@/lib/brand'

export const TOKEN_KEY = 'token'
export { TOKEN_COOKIE }

const COOKIE_MAX_AGE_SECS = 24 * 60 * 60

function cookieAttrs(): string {
  const parts = [`Path=/`, `Max-Age=${COOKIE_MAX_AGE_SECS}`, `SameSite=Lax`]
  if (typeof window !== 'undefined' && window.location.protocol === 'https:') {
    parts.push('Secure')
  }
  return parts.join('; ')
}

function clearCookieAttrs(): string {
  const parts = [`Path=/`, `Max-Age=0`, `SameSite=Lax`]
  if (typeof window !== 'undefined' && window.location.protocol === 'https:') {
    parts.push('Secure')
  }
  return parts.join('; ')
}

/** 登录成功 / SSO 回调时写入；务必两边一起写。 */
export function setAuthToken(token: string) {
  if (typeof window === 'undefined') return
  localStorage.setItem(TOKEN_KEY, token)
  document.cookie = `${TOKEN_COOKIE}=${encodeURIComponent(token)}; ${cookieAttrs()}`
}

/** 退出 / 401 / 会话过期时调用；两边一起清。 */
export function clearAuthToken() {
  if (typeof window === 'undefined') return
  localStorage.removeItem(TOKEN_KEY)
  document.cookie = `${TOKEN_COOKIE}=; ${clearCookieAttrs()}`
}

/** 现有代码里读 token 还是按 localStorage 来；保留一个统一入口便于以后切换。 */
export function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(TOKEN_KEY)
}

/**
 * 升级迁移用：上线本次改动前的老会话只有 localStorage、没有 cookie。
 * 让"已登录"的老用户在第一次进入页面时自动补 cookie，避免被 middleware 立即踢出。
 *
 * 适合放在公开页（如 `/login`）或 root layout 的客户端入口处一次性调用。
 */
export function ensureCookieSyncedFromLocalStorage() {
  if (typeof window === 'undefined') return
  const ls = localStorage.getItem(TOKEN_KEY)
  if (!ls) return
  const cookieHit = document.cookie
    .split(';')
    .some((c) => c.trim().startsWith(`${TOKEN_COOKIE}=`))
  if (!cookieHit) {
    document.cookie = `${TOKEN_COOKIE}=${encodeURIComponent(ls)}; ${cookieAttrs()}`
  }
}
