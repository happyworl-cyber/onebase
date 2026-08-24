'use client'

/**
 * `/workspace` 兼容入口：统一导向租户层。
 * 真正的租户选择在 /orgs；租户控制台在 /org/[id]；项目工作区在 /workspace/[projectId]。
 */

import { Suspense, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

export default function WorkspaceRedirectPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
          <div className="text-sm text-gray-500">
            <i className="fas fa-spinner fa-spin mr-2"></i>跳转中…
          </div>
        </div>
      }
    >
      <WorkspaceRedirectInner />
    </Suspense>
  )
}

function WorkspaceRedirectInner() {
  const router = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    if (!localStorage.getItem('token')) {
      router.replace('/login')
      return
    }
    let superadmin = false
    try {
      superadmin = !!JSON.parse(localStorage.getItem('current_user') || '{}')?.is_superadmin
    } catch {
      /* ignore */
    }
    const org = searchParams.get('org')
    if (org) {
      router.replace(`/org/${org}`)
      return
    }
    router.replace(superadmin ? '/platform/organizations' : '/orgs')
  }, [router, searchParams])

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-sm text-gray-500">
        <i className="fas fa-spinner fa-spin mr-2"></i>跳转中…
      </div>
    </div>
  )
}
