'use client'

/**
 * `/dashboard` 根路由（W2 之后）—— 重定向兜底。
 *
 * 旧时代的 dashboard 首页（数据库连接 / 数据表 / 查询执行 stat card 那张）
 * 已经退役。当前角色分流：
 *   - 超管：去 /platform
 *   - 普通用户：去 /workspace（再由它根据项目数自动跳）
 *
 * 注：`/dashboard/layout.tsx` 已经独立做了"非超管 → /workspace"的拦截，
 * 所以这里其实只有超管能进。但保留双分支兜底，避免 layout 行为变化时
 * 这里就静默坏掉。
 */

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function DashboardRoot() {
  const router = useRouter()

  useEffect(() => {
    let isSuperadmin = false
    try {
      const userStr = localStorage.getItem('current_user')
      if (userStr) {
        const user = JSON.parse(userStr)
        isSuperadmin = !!user?.is_superadmin
      }
    } catch {
      /* 解析失败就走非超管分支 */
    }
    router.replace(isSuperadmin ? '/platform' : '/workspace')
  }, [router])

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center text-gray-500">
        <i className="fas fa-spinner fa-spin text-2xl mb-2"></i>
        <p className="text-sm">正在跳转…</p>
      </div>
    </div>
  )
}
