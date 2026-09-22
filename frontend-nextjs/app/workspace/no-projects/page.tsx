'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/lib/store'
import { clearAuthToken } from '@/lib/auth'

/**
 * 无租户 / 无项目引导。租户只能由平台创建。
 */
export default function NoProjectsPage() {
  const t = useTranslations('noProjectsPage')
  const router = useRouter()
  const currentUser = useAppStore((s) => s.currentUser)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    setHydrated(true)
  }, [])

  function logout() {
    clearAuthToken()
    try {
      localStorage.removeItem('current_user')
      localStorage.removeItem('current_tenant')
      localStorage.removeItem('current_project')
      localStorage.removeItem('current_organization')
    } catch {}
    router.push('/login')
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-6">
      <div className="max-w-md w-full text-center">
        <div className="w-16 h-16 rounded-full bg-gray-100 mx-auto mb-4 flex items-center justify-center">
          <i className="fas fa-building text-2xl text-gray-400"></i>
        </div>
        <h1 className="text-xl font-semibold text-gray-900 mb-2">{t('title')}</h1>
        <p className="text-sm text-gray-500 mb-6">
          {t('desc')}
        </p>

        <button
          type="button"
          onClick={() => router.push('/orgs')}
          className="btn-primary w-full mb-3"
        >
          {t('viewMyOrgs')}
        </button>

        {hydrated && currentUser?.is_superadmin && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-left text-xs text-amber-800 mb-4">
            {t('superadminHint')}
            <button
              type="button"
              className="block mt-2 text-amber-900 font-medium underline"
              onClick={() => router.push('/platform/organizations')}
            >
              {t('goToOrgManagement')}
            </button>
          </div>
        )}

        <button type="button" onClick={logout} className="text-sm text-gray-500 hover:underline">
          {t('logout')}
        </button>
      </div>
    </div>
  )
}
