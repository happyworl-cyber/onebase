'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { ssoAPI } from '@/lib/api'
import { setAuthToken } from '@/lib/auth'
import { useAppStore } from '@/lib/store'

export default function SsoCallbackPage() {
  return (
    <Suspense fallback={<CallbackShell message="正在完成登录..." />}>
      <SsoCallbackInner />
    </Suspense>
  )
}

function SsoCallbackInner() {
  const searchParams = useSearchParams()
  const setCurrentUser = useAppStore((state) => state.setCurrentUser)
  const [error, setError] = useState('')
  // StrictMode/重渲染下避免重复用同一个 code 换取（code 一次性，第二次会失败）。
  const exchangedRef = useRef(false)

  useEffect(() => {
    if (exchangedRef.current) return
    exchangedRef.current = true

    const code = searchParams.get('code')
    const state = searchParams.get('state')
    const providerError = searchParams.get('error')

    if (providerError) {
      setError(`第三方登录失败：${providerError}`)
      return
    }
    if (!code || !state) {
      setError('回调缺少 code 或 state 参数')
      return
    }

    ssoAPI
      .exchange(code, state)
      .then((res) => {
        const token = res.data?.token
        if (!token) {
          setError('登录失败：未返回令牌')
          return
        }
        setAuthToken(token)
        // 持久化当前用户，否则登录后顶栏/侧栏拿不到用户名与头像（与密码登录一致）。
        if (res.data?.user) {
          setCurrentUser(res.data.user)
        }
        // 整页导航确保 cookie 参与下一次受保护路由的服务端判定（与 /login 一致）。
        window.location.assign('/workspace')
      })
      .catch((err: any) => {
        setError(err.response?.data?.error || '登录失败，请重试')
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (error) {
    return (
      <CallbackShell
        message={error}
        isError
        action={
          <a
            href="/login"
            className="inline-flex items-center justify-center h-10 px-6 bg-primary-500 hover:bg-primary-400 text-white font-medium rounded-lg transition-colors"
          >
            返回登录
          </a>
        }
      />
    )
  }

  return <CallbackShell message="正在完成登录..." />
}

function CallbackShell({
  message,
  isError,
  action,
}: {
  message: string
  isError?: boolean
  action?: React.ReactNode
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 p-8">
      <div className="bg-white rounded-2xl shadow-2xl px-10 py-12 max-w-md w-full text-center space-y-5">
        <div
          className={`w-14 h-14 mx-auto rounded-xl flex items-center justify-center ${
            isError ? 'bg-red-50 text-red-500' : 'bg-indigo-50 text-indigo-500'
          }`}
        >
          <i className={`fas ${isError ? 'fa-exclamation-circle' : 'fa-spinner fa-spin'} text-2xl`} />
        </div>
        <p className={`text-sm ${isError ? 'text-red-600' : 'text-gray-600'}`}>{message}</p>
        {action}
      </div>
    </div>
  )
}
