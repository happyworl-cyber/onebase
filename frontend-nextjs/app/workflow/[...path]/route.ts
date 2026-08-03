import type { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// 给后端 300s 工作流超时留出响应封装余量；自托管 Next.js 不强制此值，
// 支持 maxDuration 的托管平台会据此放宽 Route Handler 执行时长。
export const maxDuration = 310

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function backendUrl() {
  return (process.env.ONEBASE_BACKEND_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '')
}

function forwardedHeaders(source: Headers) {
  const headers = new Headers()
  source.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value)
    }
  })
  return headers
}

async function proxyWorkflow(request: NextRequest, context: { params: { path: string[] } }) {
  const path = context.params.path.map(encodeURIComponent).join('/')
  const target = `${backendUrl()}/workflow/${path}${request.nextUrl.search}`
  const method = request.method.toUpperCase()
  const hasBody = method !== 'GET' && method !== 'HEAD'

  try {
    const upstream = await fetch(target, {
      method,
      headers: forwardedHeaders(request.headers),
      body: hasBody ? await request.arrayBuffer() : undefined,
      cache: 'no-store',
      redirect: 'manual',
    })

    const headers = forwardedHeaders(upstream.headers)
    // Node fetch 会解压响应体，不能继续透传原始压缩长度/编码。
    headers.delete('content-encoding')
    headers.delete('content-length')

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[workflow proxy] ${method} ${target} failed: ${message}`)
    return Response.json(
      { error: `工作流代理请求失败: ${message}` },
      { status: 502 },
    )
  }
}

export const GET = proxyWorkflow
export const POST = proxyWorkflow
export const OPTIONS = proxyWorkflow
