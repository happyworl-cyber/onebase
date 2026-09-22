'use client'

import Link from 'next/link'
import { useAppStore } from '@/lib/store'
import { useTranslations } from 'next-intl'

/**
 * Tab 栏右侧：当前激活的数据源指示。
 *
 * 为什么需要它：schema / 表 / RPC / API Key 等页面都靠 axios 拦截器带上
 * `X-Database-Id` 才能定位目标库（见 lib/api.ts），而这个值来自
 * `currentConnection` —— 由 workspace layout 自动绑定项目的 primary_connection。
 * 项目没有主连接时它是 null，页面只会收到后端的
 * 「缺少有效的 X-Database-Id 请求头」400，界面上却完全看不出原因。
 *
 * 所以这里把它显式画出来：有连接时显示库名，没有时显示琥珀色告警并直接
 * 指向连接设置页 —— 把一个只能从控制台报错里看出来的状态变成可见状态。
 */
export default function ActiveDataSourceBadge({ base }: { base: string }) {
  const t = useTranslations('dataSourceBadge')
  const conn = useAppStore((s) => s.currentConnection)
  const href = `${base}/settings/connections`

  if (!conn) {
    return (
      <Link
        href={href}
        title={t('unboundTitle')}
        className="flex shrink-0 items-center gap-1.5 border-l border-gray-200 px-3 text-[12px] text-amber-700 transition-colors hover:bg-amber-50"
      >
        <i className="fas fa-triangle-exclamation text-[11px] text-amber-500" />
        <span className="whitespace-nowrap">{t('unbound')}</span>
      </Link>
    )
  }

  const label = conn.db_name || conn.connection_name
  return (
    <Link
      href={href}
      title={t('boundTitle', { name: label, host: conn.db_host, port: conn.db_port, primary: conn.is_primary ? t('primarySuffix') : '' })}
      className="flex shrink-0 items-center gap-1.5 border-l border-gray-200 px-3 text-[12px] text-gray-600 transition-colors hover:bg-gray-100"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
      <span className="hidden text-gray-400 sm:inline">{t('label')}</span>
      <span className="max-w-[160px] truncate font-medium text-gray-700">{label}</span>
    </Link>
  )
}
