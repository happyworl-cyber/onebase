'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ensureCookieSyncedFromLocalStorage } from '@/lib/auth'

export default function Home() {
  const router = useRouter()

  useEffect(() => {
    // 老会话迁移：上线本次改动前的用户只有 localStorage、没 cookie，
    // 直接 push 到 /dashboard 会被 middleware 立即踢回 /login。
    // 先把 cookie 补上再跳，省一次额外往返。
    ensureCookieSyncedFromLocalStorage()
    const token = localStorage.getItem('token')
    if (token) {
      router.push('/dashboard')
    } else {
      router.push('/login')
    }
  }, [router])

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-500"></div>
    </div>
  )
}

