'use client'

import { useState, useEffect } from 'react'
import { partnerAPI } from '@/lib/api'
import { useNotification } from '@/hooks/useNotification'
import type { PartnerCommission } from '@/lib/types/partner'

const formatDate = (raw: string): string => {
  const d = new Date(raw)
  if (isNaN(d.getTime())) return raw
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  approved: 'bg-blue-100 text-blue-700',
  paid: 'bg-green-100 text-green-700',
  settled: 'bg-gray-100 text-gray-700',
}

const STATUS_LABEL: Record<string, string> = {
  pending: '待审核',
  approved: '已批准',
  paid: '已支付',
  settled: '已结算',
}

export default function CommissionsPage() {
  const notify = useNotification()
  const [commissions, setCommissions] = useState<PartnerCommission[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [typeFilter, setTypeFilter] = useState<string>('all')

  useEffect(() => {
    loadCommissions()
  }, [page, typeFilter])

  const loadCommissions = async () => {
    try {
      setLoading(true)
      const params: any = { page, page_size: 20 }
      if (typeFilter !== 'all') {
        params.commission_type = typeFilter
      }
      const res = await partnerAPI.listCommissions(params)
      setCommissions(res.data.commissions as PartnerCommission[])
      setTotalPages(res.data.pagination.total_pages)
    } catch (error: any) {
      notify.error(error.response?.data?.error || '加载佣金记录失败')
    } finally {
      setLoading(false)
    }
  }

  const totalCommission = commissions.reduce((sum, c) => sum + parseFloat(c.commission_amount), 0)
  const pendingCommission = commissions.filter(c => c.status === 'pending').reduce((sum, c) => sum + parseFloat(c.commission_amount), 0)
  const licenseCommission = commissions.filter(c => c.commission_type === 'license').reduce((sum, c) => sum + parseFloat(c.commission_amount), 0)
  const maintenanceCommission = commissions.filter(c => c.commission_type === 'maintenance').reduce((sum, c) => sum + parseFloat(c.commission_amount), 0)

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">佣金记录</h1>

        {/* 类型筛选 */}
        <div className="flex gap-2">
          <button
            onClick={() => setTypeFilter('all')}
            className={`px-4 py-2 rounded-lg transition-colors ${
              typeFilter === 'all'
                ? 'bg-blue-600 text-white'
                : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
          >
            全部
          </button>
          <button
            onClick={() => setTypeFilter('license')}
            className={`px-4 py-2 rounded-lg transition-colors ${
              typeFilter === 'license'
                ? 'bg-blue-600 text-white'
                : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
          >
            License 佣金
          </button>
          <button
            onClick={() => setTypeFilter('maintenance')}
            className={`px-4 py-2 rounded-lg transition-colors ${
              typeFilter === 'maintenance'
                ? 'bg-blue-600 text-white'
                : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
          >
            维护费佣金
          </button>
        </div>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-4 gap-6 mb-6">
        <div className="bg-white rounded-lg shadow p-6">
          <div className="text-sm text-gray-500 mb-2">本页总佣金</div>
          <div className="text-3xl font-bold text-gray-900">¥{(totalCommission / 100).toLocaleString()}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-6">
          <div className="text-sm text-gray-500 mb-2">待结算佣金</div>
          <div className="text-3xl font-bold text-yellow-600">¥{(pendingCommission / 100).toLocaleString()}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm text-gray-500">License 佣金</div>
            <i className="fas fa-certificate text-blue-500"></i>
          </div>
          <div className="text-3xl font-bold text-blue-600">¥{(licenseCommission / 100).toLocaleString()}</div>
          <div className="text-xs text-gray-500 mt-1">15-20% 佣金比例</div>
        </div>
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm text-gray-500">维护费佣金</div>
            <i className="fas fa-tools text-green-500"></i>
          </div>
          <div className="text-3xl font-bold text-green-600">¥{(maintenanceCommission / 100).toLocaleString()}</div>
          <div className="text-xs text-gray-500 mt-1">10% 佣金比例</div>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12">
          <i className="fas fa-spinner fa-spin text-3xl text-gray-400"></i>
        </div>
      ) : commissions.length === 0 ? (
        <div className="text-center py-12 bg-gray-50 rounded-lg">
          <i className="fas fa-coins text-4xl text-gray-400 mb-3"></i>
          <p className="text-gray-500">暂无佣金记录</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">类型</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">License ID</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">销售价格</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">佣金比例</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">佣金金额</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">状态</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">创建时间</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {commissions.map((commission) => (
                <tr key={commission.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    {commission.commission_type === 'license' ? (
                      <span className="px-2 py-1 text-xs rounded-full bg-blue-100 text-blue-700">
                        <i className="fas fa-certificate mr-1"></i>
                        License
                      </span>
                    ) : (
                      <div>
                        <span className="px-2 py-1 text-xs rounded-full bg-green-100 text-green-700">
                          <i className="fas fa-tools mr-1"></i>
                          维护费
                        </span>
                        {commission.renewal_year && commission.renewal_year > 0 && (
                          <div className="text-xs text-gray-500 mt-1">
                            第 {commission.renewal_year} 年
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-sm font-mono text-gray-900">
                      {commission.license_id ? commission.license_id.slice(0, 8) + '...' : '-'}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-900">¥{(parseFloat(commission.base_price) / 100).toLocaleString()}</td>
                  <td className="px-6 py-4 text-sm text-gray-900">{(parseFloat(commission.commission_rate) / 100).toFixed(1)}%</td>
                  <td className="px-6 py-4 text-sm font-medium text-green-600">¥{(parseFloat(commission.commission_amount) / 100).toLocaleString()}</td>
                  <td className="px-6 py-4">
                    <span className={`px-2 py-1 text-xs rounded-full ${STATUS_BADGE[commission.status]}`}>
                      {STATUS_LABEL[commission.status]}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-900">{formatDate(commission.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
