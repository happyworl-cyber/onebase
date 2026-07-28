/**
 * 前端品牌集中配置。
 *
 * 上游/下游同步时，源码保持一致，只需在各自的 `.env` 里设置：
 *   NEXT_PUBLIC_BRAND       展示名（大小写敏感），如 "OneBase"
 *   NEXT_PUBLIC_BRAND_SLUG  小写机器标识，如 "onebase"（须与后端 crate 名一致）
 * 未设置时回退到 OneBase 默认值。
 */
export const BRAND = process.env.NEXT_PUBLIC_BRAND ?? 'OneBase'
export const BRAND_SLUG = process.env.NEXT_PUBLIC_BRAND_SLUG ?? 'onebase'

/** 前端登录态 cookie 名（须与 middleware 一致）。 */
export const TOKEN_COOKIE = `${BRAND_SLUG}_token`

/** Webhook/定时任务 HMAC 签名头名称（须与后端 brand::signature_header 一致）。 */
export const SIGNATURE_HEADER = `X-${BRAND}-Signature`
