'use client'

/**
 * `/platform/scheduled-tasks` —— 跨租户 / 平台级定时任务管理（仅超管入口）。
 *
 * 真正的 UI 与状态机在 `components/ScheduledTasksManager.tsx`，这里只是一个
 * 薄壳：保留 `/platform/*` 的导航语义（与「用户管理 / 审计日志 / SSO / RPC
 * 授权」并列），并以"平台模式"挂载 manager（`lockedTenantId` 不传 →
 * 显示租户下拉，留空选项 = 平台级任务）。
 *
 * 同一个 manager 也被 `/dashboard/scheduled-tasks` 以"租户模式"复用，避免
 * 两边代码长成两份。租户模式的入口见 app/dashboard/scheduled-tasks/page.tsx。
 */

import ScheduledTasksManager from '@/components/ScheduledTasksManager'

export default function PlatformScheduledTasksPage() {
  return <ScheduledTasksManager />
}
