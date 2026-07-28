'use client'

import { useCallback, useState } from 'react'
import { usePathname } from 'next/navigation'
import { healthAPI } from '@/lib/api'
import { showToast } from '@/components/Toast'

function fmtHealthStatus(s: string): string {
  if (s === 'healthy') return '正常'
  if (s === 'unhealthy') return '异常'
  if (s === 'not_configured') return '未配置'
  return s
}

const pageTitles: Record<string, string> = {
  '/dashboard': '仪表盘',
  '/dashboard/schema': 'Schema 浏览器',
  '/dashboard/tables': '数据表管理',
  '/dashboard/query': 'SQL 查询器',
  '/dashboard/transaction': '批量 SQL 事务',
  '/dashboard/rpc': 'RPC 调用器',
  '/dashboard/rpc-acl': 'RPC 授权',
}

export default function Header() {
  const pathname = usePathname()
  const title = pageTitles[pathname] || '管理后台'
  const [checking, setChecking] = useState(false)

  const handleHealthCheck = useCallback(async () => {
    if (checking) return
    setChecking(true)
    try {
      const { data } = await healthAPI.getDetail()
      const db = fmtHealthStatus(data.database?.status ?? '')
      const redis = fmtHealthStatus(data.redis?.status ?? '')
      const ver = data.version ? ` · v${data.version}` : ''
      const ok = data.status === 'healthy'
      const msg = `整体：${ok ? '正常' : '异常'} · 数据库：${db} · Redis：${redis}${ver}`
      showToast(ok ? 'success' : 'warning', msg, 5500)
    } catch (err: unknown) {
      const e = err as { message?: string; response?: { data?: { error?: string } } }
      const detail =
        (typeof e.response?.data?.error === 'string' && e.response.data.error) ||
        e.message ||
        '请求失败'
      showToast('error', `健康检查失败：${detail}`, 6000)
    } finally {
      setChecking(false)
    }
  }, [checking])

  return (
    <div className="bg-white border-b border-gray-100 shadow-sm">
      <div className="px-6 py-4 flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2 text-sm text-gray-600">
            <i className="fas fa-home text-xs"></i>
            <i className="fas fa-chevron-right text-xs text-gray-400"></i>
            <span className="font-medium text-gray-900">{title}</span>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-2 px-3 py-1.5 bg-gray-50 rounded-lg border border-gray-200">
            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
            <span className="text-xs text-gray-600 font-mono">{process.env.NEXT_PUBLIC_API_URL ? new URL(process.env.NEXT_PUBLIC_API_URL).host : 'API'}</span>
          </div>

          <button
            type="button"
            onClick={handleHealthCheck}
            disabled={checking}
            className="btn-success shadow-sm hover:shadow-md transform transition-all duration-200 hover:-translate-y-0.5 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0"
          >
            <i className={`fas mr-1.5 ${checking ? 'fa-spinner fa-spin' : 'fa-heart-pulse'}`}></i>
            {checking ? '检查中…' : '健康检查'}
          </button>
        </div>
      </div>
    </div>
  )
}

