'use client'

import { ToastProvider } from '@/components/Toast'

/**
 * /workspace/* 全部页面共享的最外层 layout（W1 spec §3.2.2）。
 *
 * 只负责 ToastProvider 包裹。token 检查与项目元数据加载放在
 * `/workspace/[projectId]/layout.tsx`，因为：
 *   - 项目选择页 `/workspace` 没有 projectId
 *   - 无项目引导页 `/workspace/no-projects` 也没有 projectId
 *   - 把它们的鉴权放到本 layout 会让"层"职责混乱
 */
export default function WorkspaceRootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <ToastProvider>{children}</ToastProvider>
}
