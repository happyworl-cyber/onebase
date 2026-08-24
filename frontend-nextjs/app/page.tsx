'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ensureCookieSyncedFromLocalStorage } from '@/lib/auth'

export default function Home() {
  const router = useRouter()

  useEffect(() => {
    // 老会话迁移：上线本次改动前的用户只有 localStorage、没 cookie，
    // 直接 push 会被 middleware 立即踢回 /login。先把 cookie 补上再跳。
    ensureCookieSyncedFromLocalStorage()
    const token = localStorage.getItem('token')
    if (!token) {
      router.push('/login')
      return
    }
    // 按角色直接分发，不再经过已退役的 /dashboard 跳板：
    // 超管 → 平台控制台；普通用户 → 项目工作区（picker 再派发到具体项目）。
    let isSuperadmin = false
    try {
      isSuperadmin = !!JSON.parse(localStorage.getItem('current_user') || '{}')?.is_superadmin
    } catch {
      /* current_user 损坏时按普通用户处理 */
    }
    // 超管 → 平台租户管理；普通用户 → 租户选择 / 租户控制台
    router.push(isSuperadmin ? '/platform/organizations' : '/orgs')
  }, [router])

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-500"></div>
    </div>
  )
}

