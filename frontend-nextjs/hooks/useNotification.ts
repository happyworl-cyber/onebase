'use client'

import { useCallback, useMemo } from 'react'
import { useToast } from '@/components/Toast'

/**
 * 通知 Hook - 包装 Toast 功能，提供更简洁的 API
 */
export function useNotification() {
  const toast = useToast()

  const notifySuccess = useCallback((message: string) => {
    toast.success(message)
  }, [toast])

  const notifyError = useCallback((error: any) => {
    // axios 拦截器已经在 lib/api.ts 里弹过 toast（除非该请求显式 suppressErrorToast），
    // 这里再弹会重复。统一以拦截器为准，页面里继续写 catch + notify.error 也安全。
    if (error?.__toastShown) return

    const message = typeof error === 'string'
      ? error
      : error?.response?.data?.error || error?.response?.data?.message || error?.message || '操作失败'
    toast.error(message)
  }, [toast])

  const notifyWarning = useCallback((message: string) => {
    toast.warning(message)
  }, [toast])

  const notifyInfo = useCallback((message: string) => {
    toast.info(message)
  }, [toast])

  return useMemo(() => ({
    success: notifySuccess,
    error: notifyError,
    warning: notifyWarning,
    info: notifyInfo,
    toast,
  }), [notifySuccess, notifyError, notifyWarning, notifyInfo, toast])
}

