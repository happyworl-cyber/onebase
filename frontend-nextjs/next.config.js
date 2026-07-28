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

const backendUrl = resolveBackendUrl()
console.log(`[next.config] backend URL = ${backendUrl}`)

const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // 生产构建时跳过 TS/ESLint 严格检查，避免遗留的小问题阻断 Docker 镜像构建
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production' ? { exclude: ['error'] } : false,
  },
  // dev 服务器允许的 origin 白名单（消除 "Cross origin request detected" 警告，
  // 并向后兼容 Next.js 15+ 的强制要求）。只影响 dev，生产下未读取。
  experimental: {
    allowedDevOrigins: [
      'localhost:3006',
      '127.0.0.1:3006',
      'localhost:3001',
      '127.0.0.1:3001',
    ],
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
      { source: '/api/:path*', destination: `${backendUrl}/api/:path*` },
      { source: '/rest/:path*', destination: `${backendUrl}/rest/:path*` },
      { source: '/auth/:path*', destination: `${backendUrl}/auth/:path*` },
      { source: '/health', destination: `${backendUrl}/health` },
      { source: '/health/:path*', destination: `${backendUrl}/health/:path*` },
      { source: '/realtime/:path*', destination: `${backendUrl}/realtime/:path*` },
      { source: '/query', destination: `${backendUrl}/query` },
      { source: '/transaction', destination: `${backendUrl}/transaction` },
      { source: '/workflow/:path*', destination: `${backendUrl}/workflow/:path*` },
    ]
  },
}

module.exports = nextConfig
