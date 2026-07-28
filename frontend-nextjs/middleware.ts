import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { TOKEN_COOKIE } from '@/lib/brand'

/**
 * 受保护路由前缀：未登录用户访问会被 302 到 /login。
 *
 * 之所以要在 middleware 这一层做，而不是仅靠各 layout 的 useEffect：
 *   1. layout 的客户端检查跑在 HTML/JS 已经下发之后 → 页面结构、API 端点
 *      路径会瞬间暴露在浏览器；
 *   2. 在 useEffect 里 router.push('/login') 会出现"闪一下空 dashboard"的
 *      糟糕观感；
 *   3. 复杂场景下（直接打开内层 URL、新标签页打开）很容易出现还没来得及
 *      跳走就已经发了几个 API 请求，被 401 兜底导致多个 toast 同时弹起来。
 *
 * middleware 的职责仅限"边缘剪枝"，不替代后端鉴权 —— 真正的 token 验签 +
 * 会话有效性（jti 是否被吊销、是否过期）仍由后端 `auth_middleware` 完成。
 */
const PROTECTED_PREFIXES = ['/dashboard', '/platform'] as const

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  )
}

/**
 * 仅做"显然失效"的剪枝：
 *  - 形状不对（不是 header.payload.sig 三段）→ 视为失效
 *  - payload 解 base64url + JSON 失败 → 视为失效
 *  - `exp` 字段存在且早于当前时间 → 视为失效
 *
 * 不验签：验签需要把 JWT_SECRET 同步到前端进程，引入 split-brain 风险，
 * 而且 middleware 本来就只是 UX 兜底，权威校验在后端。
 */
function isClearlyInvalid(token: string): boolean {
  const parts = token.split('.')
  if (parts.length !== 3) return true
  try {
    const b64url = parts[1]
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
    const json = atob(b64 + pad)
    const payload = JSON.parse(json)
    if (typeof payload?.exp !== 'number') {
      // 没 exp 就放过，让后端兜底（不应该发生：后端签的所有 token 都带 exp）
      return false
    }
    return payload.exp * 1000 <= Date.now()
  } catch {
    return true
  }
}

function redirectToLogin(
  req: NextRequest,
  reason: 'missing' | 'expired',
): NextResponse {
  const url = req.nextUrl.clone()
  url.pathname = '/login'
  url.search = ''
  // 把"原本想去哪"带过去，登录成功后回跳
  const next = req.nextUrl.pathname + req.nextUrl.search
  url.searchParams.set('next', next)
  if (reason === 'expired') {
    url.searchParams.set('session', 'expired')
  }
  const res = NextResponse.redirect(url)
  if (reason === 'expired') {
    // 显然失效的 token 顺手清掉，避免下一次还在
    res.cookies.delete(TOKEN_COOKIE)
  }
  return res
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  if (!isProtected(pathname)) {
    return NextResponse.next()
  }

  const token = req.cookies.get(TOKEN_COOKIE)?.value
  if (!token) {
    return redirectToLogin(req, 'missing')
  }
  if (isClearlyInvalid(token)) {
    return redirectToLogin(req, 'expired')
  }
  return NextResponse.next()
}

/**
 * matcher 只匹配受保护的两棵子树，避免 middleware 在静态资源 / API rewrite
 * 路径（/api/*、/auth/*、/rest/* 等）上无谓地多跑一次。
 */
export const config = {
  matcher: ['/dashboard/:path*', '/platform/:path*'],
}
