'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/lib/store'
import { authAPI } from '@/lib/api'
import { getAuthToken } from '@/lib/auth'

function isStrongPassword(p: string): boolean {
  return p.length >= 8 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p)
}

function validateForm(
  oldPassword: string,
  newPassword: string,
  confirmPassword: string,
  t: (key: string) => string,
): string | null {
  if (!oldPassword) return t('errCurrentPwdRequired')
  if (newPassword.length < 8) return t('errPwdMinLength')
  if (!isStrongPassword(newPassword)) return t('errPwdComplexity')
  if (newPassword === oldPassword) return t('errPwdSameAsOld')
  if (newPassword !== confirmPassword) return t('errPwdMismatch')
  return null
}

export default function AccountPage() {
  const t = useTranslations('accountPage')
  const router = useRouter()
  const currentUser = useAppStore((s) => s.currentUser)

  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    if (typeof window !== 'undefined' && !getAuthToken()) {
      router.replace('/login')
      return
    }
    if (currentUser?.must_change_password) {
      router.replace('/change-password')
    }
  }, [router, currentUser?.must_change_password])

  function goBack() {
    if (typeof document !== 'undefined') {
      try {
        const ref = document.referrer
        if (ref) {
          const url = new URL(ref)
          if (url.origin === window.location.origin) {
            router.back()
            return
          }
        }
      } catch {
        /* ignore */
      }
    }
    router.replace(currentUser?.is_superadmin ? '/platform' : '/orgs')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const v = validateForm(oldPassword, newPassword, confirmPassword, t)
    if (v) {
      setSuccess('')
      setError(v)
      return
    }
    setLoading(true)
    setError('')
    setSuccess('')
    try {
      const res = await authAPI.changePassword(oldPassword, newPassword)
      const revoked = res.data?.other_sessions_revoked ?? 0
      setOldPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setSuccess(
        revoked > 0
          ? t('pwdChangedRevoked')
          : t('pwdChanged'),
      )
    } catch (err: any) {
      setError(err?.response?.data?.error || t('errChangePwdFailed'))
    } finally {
      setLoading(false)
    }
  }

  const inputClass =
    'w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500'

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="h-14 bg-white border-b border-gray-200 flex items-center px-4 gap-3">
        <button
          type="button"
          onClick={goBack}
          className="text-sm text-gray-600 hover:text-gray-900 px-2 py-1 rounded hover:bg-gray-50"
        >
          <i className="fas fa-arrow-left mr-2" />
          {t('back')}
        </button>
        <h1 className="text-sm font-semibold text-gray-900">{t('title')}</h1>
      </header>

      <main className="max-w-xl mx-auto px-4 py-8 space-y-6">
        <section className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">{t('accountInfo')}</h2>
          <div>
            <div className="text-xs text-gray-500 mb-0.5">{t('username')}</div>
            <div className="text-sm text-gray-800">{currentUser?.username || '—'}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-0.5">{t('email')}</div>
            <div className="text-sm text-gray-800">{currentUser?.email || '—'}</div>
          </div>
        </section>

        <section className="bg-white border border-gray-200 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">{t('changePassword')}</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('currentPassword')}</label>
              <input
                type="password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                autoComplete="current-password"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('newPassword')}</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                className={inputClass}
                placeholder={t('newPasswordPlaceholder')}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('confirmNewPassword')}</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                className={inputClass}
              />
            </div>

            {error && (
              <div className="flex items-start space-x-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded p-3">
                <i className="fas fa-exclamation-circle mt-0.5" />
                <span>{error}</span>
              </div>
            )}
            {success && (
              <div className="flex items-start space-x-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded p-3">
                <i className="fas fa-check-circle mt-0.5" />
                <span>{success}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-500 disabled:opacity-50"
            >
              {loading ? t('submitting') : t('changePassword')}
            </button>
          </form>
        </section>
      </main>
    </div>
  )
}
