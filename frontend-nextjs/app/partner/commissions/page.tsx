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

  useEffect(() => {
    loadCommissions()
  }, [page])

  const loadCommissions = async () => {
    try {
      setLoading(true)
      const res = await partnerAPI.listCommissions({ page, page_size: 20 })
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

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">佣金记录</h1>

      {/* 统计卡片 */}
      <div className="grid grid-cols-2 gap-6 mb-6">
        <div className="bg-white rounded-lg shadow p-6">
          <div className="text-sm text-gray-500 mb-2">本页总佣金</div>
          <div className="text-3xl font-bold text-gray-900">¥{totalCommission.toLocaleString()}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-6">
          <div className="text-sm text-gray-500 mb-2">待结算佣金</div>
          <div className="text-3xl font-bold text-yellow-600">¥{pendingCommission.toLocaleString()}</div>
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
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">佣金 ID</th>
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
                  <td className="px-6 py-4 text-sm text-gray-900">#{commission.id}</td>
                  <td className="px-6 py-4 text-sm text-gray-900">¥{parseFloat(commission.base_price).toLocaleString()}</td>
                  <td className="px-6 py-4 text-sm text-gray-900">{commission.commission_rate}%</td>
                  <td className="px-6 py-4 text-sm font-medium text-green-600">¥{parseFloat(commission.commission_amount).toLocaleString()}</td>
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
