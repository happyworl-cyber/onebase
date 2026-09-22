'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/lib/store'
import { authAPI } from '@/lib/api'
import { getAuthToken } from '@/lib/auth'

export default function ChangePasswordPage() {
  const t = useTranslations('changePasswordPage')
  const router = useRouter()
  const currentUser = useAppStore((s) => s.currentUser)
  const setCurrentUser = useAppStore((s) => s.setCurrentUser)

  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // 未登录直接打开本页 → 回登录页
  useEffect(() => {
    if (typeof window !== 'undefined' && !getAuthToken()) {
      router.replace('/login')
    }
  }, [router])

  const targetAfterDone = () =>
    currentUser?.is_superadmin ? '/platform' : '/workspace'

  const validate = (): string | null => {
    if (!oldPassword) return t('errCurrentPwdRequired')
    if (newPassword.length < 8) return t('errNewPwdMinLength')
    if (newPassword === oldPassword) return t('errPwdSameAsOld')
    if (newPassword !== confirmPassword) return t('errPwdMismatch')
    return null
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const v = validate()
    if (v) {
      setError(v)
      return
    }
    setLoading(true)
    setError('')
    try {
      await authAPI.changePassword(oldPassword, newPassword)

      // 改密成功后拉取最新的自身信息（must_change_password 已被后端清除），
      // 刷新本地缓存，避免再次被拦回本页。
      try {
        const me = await authAPI.me()
        setCurrentUser(me.data)
      } catch {
        if (currentUser) setCurrentUser({ ...currentUser, must_change_password: false })
      }

      if (typeof window !== 'undefined') {
        window.location.assign(targetAfterDone())
      } else {
        router.replace(targetAfterDone())
      }
    } catch (err: any) {
      setError(err?.response?.data?.error || t('errChangePwdFailed'))
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 p-6">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl p-8 space-y-6">
        <div className="space-y-2">
          <div className="w-12 h-12 rounded-xl bg-amber-100 flex items-center justify-center">
            <i className="fas fa-shield-alt text-xl text-amber-600" />
          </div>
          <h1 className="text-2xl font-semibold text-gray-800">{t('title')}</h1>
          <p className="text-sm text-gray-500 leading-relaxed">
            {t('securityNote')}
            {currentUser?.email ? (
              <>
                {' '}
                {t.rich('setNewPwdForEmail', {
                  email: currentUser.email,
                  emailTag: (chunks) => <span className="font-medium text-gray-700">{chunks}</span>,
                })}
              </>
            ) : (
              ` ${t('setNewPwdGeneric')}`
            )}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">{t('currentPassword')}</label>
            <div className="relative">
              <input
                type="password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                required
                autoComplete="current-password"
                className="w-full input-with-icon pl-10"
                placeholder={t('currentPasswordPlaceholder')}
              />
              <i className="fas fa-lock absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none" />
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">{t('newPassword')}</label>
            <div className="relative">
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                autoComplete="new-password"
                className="w-full input-with-icon pl-10"
                placeholder={t('newPasswordPlaceholder')}
              />
              <i className="fas fa-key absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none" />
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">{t('confirmNewPassword')}</label>
            <div className="relative">
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                autoComplete="new-password"
                className="w-full input-with-icon pl-10"
                placeholder={t('confirmNewPasswordPlaceholder')}
              />
              <i className="fas fa-key absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none" />
            </div>
          </div>

          {error && (
            <div className="flex items-start space-x-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded p-3">
              <i className="fas fa-exclamation-circle mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full h-10 bg-primary-500 hover:bg-primary-400 active:bg-primary-600
                     text-white font-medium rounded-lg shadow-lg hover:shadow-xl
                     transform transition-all duration-200 hover:-translate-y-0.5
                     focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2
                     disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
          >
            {loading ? (
              <span className="flex items-center justify-center space-x-2">
                <i className="fas fa-spinner fa-spin" />
                <span>{t('submitting')}</span>
              </span>
            ) : (
              <span className="flex items-center justify-center space-x-2">
                <span>{t('submitAndContinue')}</span>
                <i className="fas fa-arrow-right text-sm" />
              </span>
            )}
          </button>
        </form>
      </div>
    </div>
  )
}
