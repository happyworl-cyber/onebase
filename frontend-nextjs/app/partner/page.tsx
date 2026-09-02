'use client'

import { useState, useEffect } from 'react'
import { partnerAPI } from '@/lib/api'
import { useNotification } from '@/hooks/useNotification'
import type { PartnerProfile } from '@/lib/types/partner'

export default function PartnerDashboard() {
  const notify = useNotification()
  const [profile, setProfile] = useState<PartnerProfile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadProfile()
  }, [])

  const loadProfile = async () => {
    try {
      setLoading(true)
      const res = await partnerAPI.getProfile()
      setProfile(res.data)
    } catch (error: any) {
      notify.error(error.response?.data?.error || '加载配置失败')
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <i className="fas fa-spinner fa-spin text-3xl text-gray-400"></i>
      </div>
    )
  }

  if (!profile) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-700">无法加载代理商配置，请联系管理员</p>
        </div>
      </div>
    )
  }

  const { partner, available_quota, quota_usage_percent } = profile
  const usagePercent = parseFloat(quota_usage_percent)

  return (
    <div className="p-6">
      {/* 标题 */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">代理商概览</h1>
        <p className="text-sm text-gray-500 mt-1">欢迎使用 OneBase 代理商控制台</p>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        {/* 配额使用率 */}
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-gray-500">配额使用率</h3>
            <i className="fas fa-chart-pie text-blue-500 text-xl"></i>
          </div>
          <div className="text-3xl font-bold text-gray-900 mb-2">{usagePercent.toFixed(1)}%</div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className={`h-2 rounded-full ${
                usagePercent >= 90
                  ? 'bg-red-500'
                  : usagePercent >= 80
                  ? 'bg-yellow-500'
                  : 'bg-green-500'
              }`}
              style={{ width: `${Math.min(usagePercent, 100)}%` }}
            ></div>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            已用 {partner.used_quota} / 总计 {partner.license_quota}
          </p>
        </div>

        {/* 可用配额 */}
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-gray-500">可用配额</h3>
            <i className="fas fa-box text-green-500 text-xl"></i>
          </div>
          <div className="text-3xl font-bold text-gray-900">{available_quota}</div>
          <p className="text-xs text-gray-500 mt-2">还可签发 License 数量</p>
        </div>

        {/* 佣金比例 */}
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-gray-500">佣金比例</h3>
            <i className="fas fa-percent text-purple-500 text-xl"></i>
          </div>
          <div className="text-3xl font-bold text-gray-900">{partner.commission_rate}%</div>
          <p className="text-xs text-gray-500 mt-2">每笔销售的佣金比例</p>
        </div>
      </div>

      {/* 代理商信息 */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">代理商信息</h3>
        <dl className="grid grid-cols-2 gap-4">
          <div>
            <dt className="text-sm text-gray-500">代理商名称</dt>
            <dd className="text-sm font-medium text-gray-900 mt-1">{partner.name}</dd>
          </div>
          <div>
            <dt className="text-sm text-gray-500">公司名称</dt>
            <dd className="text-sm font-medium text-gray-900 mt-1">{partner.company_name}</dd>
          </div>
          <div>
            <dt className="text-sm text-gray-500">联系邮箱</dt>
            <dd className="text-sm text-gray-900 mt-1">{partner.contact_email}</dd>
          </div>
          <div>
            <dt className="text-sm text-gray-500">联系电话</dt>
            <dd className="text-sm text-gray-900 mt-1">{partner.contact_phone || '未设置'}</dd>
          </div>
          <div>
            <dt className="text-sm text-gray-500">状态</dt>
            <dd className="mt-1">
              <span
                className={`px-2 py-1 text-xs font-medium rounded-full ${
                  partner.status === 'active'
                    ? 'bg-green-100 text-green-700'
                    : partner.status === 'suspended'
                    ? 'bg-red-100 text-red-700'
                    : 'bg-gray-100 text-gray-700'
                }`}
              >
                {partner.status === 'active' ? '活跃' : partner.status === 'suspended' ? '已挂起' : '未激活'}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-sm text-gray-500">账期天数</dt>
            <dd className="text-sm text-gray-900 mt-1">{partner.payment_terms} 天</dd>
          </div>
        </dl>
      </div>

      {/* 授权范围 */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">授权范围</h3>
        <div className="grid grid-cols-2 gap-6">
          <div>
            <h4 className="text-sm font-medium text-gray-700 mb-2">允许的版本</h4>
            <div className="flex flex-wrap gap-2">
              {(partner.allowed_editions as any[]).map((edition) => (
                <span
                  key={edition}
                  className="px-3 py-1 bg-blue-100 text-blue-700 text-sm rounded-full"
                >
                  {edition}
                </span>
              ))}
            </div>
          </div>
          <div>
            <h4 className="text-sm font-medium text-gray-700 mb-2">允许的模块</h4>
            <div className="flex flex-wrap gap-2">
              {(partner.allowed_modules as any[]).map((module) => (
                <span
                  key={module}
                  className="px-3 py-1 bg-green-100 text-green-700 text-sm rounded-full"
                >
                  {module}
                </span>
              ))}
            </div>
          </div>
        </div>
        {partner.max_license_days && (
          <div className="mt-4">
            <h4 className="text-sm font-medium text-gray-700 mb-1">最长签发天数</h4>
            <p className="text-sm text-gray-600">{partner.max_license_days} 天</p>
          </div>
        )}
      </div>

      {/* 快捷操作 */}
      <div className="mt-6 flex gap-4">
        <a
          href="/partner/licenses"
          className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
        >
          <i className="fas fa-certificate mr-2"></i>
          签发 License
        </a>
        <a
          href="/partner/commissions"
          className="px-6 py-3 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium"
        >
          <i className="fas fa-coins mr-2"></i>
          查看佣金
        </a>
      </div>
    </div>
  )
}
