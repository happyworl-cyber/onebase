'use client'

/**
 * 自助创建租户已关闭：仅平台超管可在 /platform/organizations 创建。
 */

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function NewOrganizationRedirect() {
  const router = useRouter()
  useEffect(() => {
    let superadmin = false
    try {
      superadmin = !!JSON.parse(localStorage.getItem('current_user') || '{}')?.is_superadmin
    } catch {
      /* ignore */
    }
    router.replace(superadmin ? '/platform/organizations' : '/orgs')
  }, [router])
  return (
    <div className="min-h-screen flex items-center justify-center text-sm text-gray-500">
      租户只能由平台管理员创建，正在跳转…
    </div>
  )
}
