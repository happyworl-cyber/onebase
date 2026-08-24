'use client'

import { ToastProvider } from '@/components/Toast'

/**
 * /org/* 租户控制台：与 /workspace、/platform 一样需要 ToastProvider，
 * 供 useNotification / useToast 使用。
 */
export default function OrgRootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <ToastProvider>{children}</ToastProvider>
}
