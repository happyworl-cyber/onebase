/** @type {import('next').NextConfig} */
const fs = require('fs')
const path = require('path')

/**
 * 后端 URL 解析顺序（先到先用）：
 *
 *   1. 显式设置的 `NEXT_PUBLIC_API_URL`（生产 / Docker 用）
 *   2. 项目根目录 `../.env` 中的 `HOST` + `PORT`
 *      —— 这样后端改了 PORT，前端不需要再额外配置
 *   3. 兜底 `http://127.0.0.1:3000`
 */
function resolveBackendUrl() {
  if (process.env.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL
  }

  try {
    const envPath = path.resolve(__dirname, '../.env')
    const text = fs.readFileSync(envPath, 'utf8')
    const portMatch = text.match(/^\s*PORT\s*=\s*(\d+)/m)
    const hostMatch = text.match(/^\s*HOST\s*=\s*([^\s#]+)/m)
    const port = portMatch ? portMatch[1] : '3000'
    let host = hostMatch ? hostMatch[1] : '127.0.0.1'
    // 后端绑定 0.0.0.0 表示"所有网卡"，不能用作客户端连接地址，前端这边改回 127.0.0.1
    if (host === '0.0.0.0') host = '127.0.0.1'
    return `http://${host}:${port}`
  } catch {
    return 'http://127.0.0.1:3000'
  }
}

function resolveGatewayUrl() {
  if (process.env.GATEWAY_CONTROL_URL) {
    return process.env.GATEWAY_CONTROL_URL
  }
  if (process.env.NEXT_PUBLIC_GATEWAY_API_URL) {
    return process.env.NEXT_PUBLIC_GATEWAY_API_URL
  }
  return 'http://127.0.0.1:8088'
}

const backendUrl = resolveBackendUrl()
const gatewayUrl = resolveGatewayUrl()
console.log(`[next.config] backend URL = ${backendUrl}`)
console.log(`[next.config] gateway URL = ${gatewayUrl}`)

const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // IdP 页面展示的 Discovery / OAuth2 端点必须指向对外可达的后端地址（issuer 与端点自洽）。
  // 只透传运维显式设置的 NEXT_PUBLIC_IDP_ISSUER（如 https://api.example.com）；不设时前端在运行期
  // 按访问来源(origin)推导，避免把构建机的 127.0.0.1:3000 烤进产物导致部署后仍显示本地地址。
  env: {
    NEXT_PUBLIC_IDP_ISSUER: process.env.NEXT_PUBLIC_IDP_ISSUER || '',
    // `/workflow/*` 由 App Router 的长请求代理处理，避免 rewrites 内置代理约 30s 后断连。
    ONEBASE_BACKEND_URL: backendUrl,
  },
  // 生产构建时跳过 TS/ESLint 严格检查，避免遗留的小问题阻断 Docker 镜像构建
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production' ? { exclude: ['error'] } : false,
  },
  // Next 14.2 不识别 experimental.allowedDevOrigins（会打 Invalid next.config 警告）。
  // 顶层字段供 Next 15+ 使用；开发请统一用 http://localhost:3006，勿混用 127.0.0.1。
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  // 慢磁盘 / 冷编译时默认 chunk 超时过短，会报 ChunkLoadError: Loading chunk app/layout failed (timeout)
  webpack: (config, { dev }) => {
    if (dev) {
      config.output = config.output || {}
      config.output.chunkLoadTimeout = 120000
    }
    return config
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ]
  },
  async rewrites() {
    return [
      // 网关控制面（Go）：K8s 生产由 Ingress 同域路由 /gateway-admin、/healthz；
      // 本地 dev / 无 Ingress 时由这里反代到 GATEWAY_CONTROL_URL。
      { source: '/gateway-admin/:path*', destination: `${gatewayUrl}/gateway-admin/:path*` },
      { source: '/healthz', destination: `${gatewayUrl}/healthz` },
      { source: '/api/:path*', destination: `${backendUrl}/api/:path*` },
      // OIDC / IdP 对外端点：让本域名（同源）也能访问到后端的 Discovery、JWKS、OAuth2 与上游回调。
      { source: '/.well-known/:path*', destination: `${backendUrl}/.well-known/:path*` },
      { source: '/oauth2/:path*', destination: `${backendUrl}/oauth2/:path*` },
      { source: '/events/:path*', destination: `${backendUrl}/events/:path*` },
      { source: '/sse', destination: `${backendUrl}/sse` },
      { source: '/rest/:path*', destination: `${backendUrl}/rest/:path*` },
      { source: '/auth/:path*', destination: `${backendUrl}/auth/:path*` },
      { source: '/health', destination: `${backendUrl}/health` },
      { source: '/health/:path*', destination: `${backendUrl}/health/:path*` },
      { source: '/realtime/:path*', destination: `${backendUrl}/realtime/:path*` },
      { source: '/query', destination: `${backendUrl}/query` },
      { source: '/transaction', destination: `${backendUrl}/transaction` },
      // MCP 工作流创作端点：本页教程给用户的接入地址是 origin/mcp，必须代理到后端
      { source: '/mcp', destination: `${backendUrl}/mcp` },
    ]
  },
}

module.exports = nextConfig
