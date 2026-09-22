'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { partnerAPI } from '@/lib/api'
import { useNotification } from '@/hooks/useNotification'
import type { PartnerStatement } from '@/lib/types/partner'

const formatDate = (raw: string): string => {
  const d = new Date(raw)
  if (isNaN(d.getTime())) return raw
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700',
  pending: 'bg-yellow-100 text-yellow-700',
  paid: 'bg-green-100 text-green-700',
  settled: 'bg-blue-100 text-blue-700',
}

const STATUS_LABEL_KEY: Record<string, string> = {
  draft: 'statusDraft',
  pending: 'statusPending',
  paid: 'statusPaid',
  settled: 'statusSettled',
}

export default function StatementsPage() {
  const t = useTranslations('partnerStatements')
  const notify = useNotification()
  const [statements, setStatements] = useState<PartnerStatement[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)

  useEffect(() => {
    loadStatements()
  }, [page])

  const loadStatements = async () => {
    try {
      setLoading(true)
      const res = await partnerAPI.listStatements({ page, page_size: 20 })
      setStatements(res.data.statements as PartnerStatement[])
      setTotalPages(res.data.pagination.total_pages)
    } catch (error: any) {
      notify.error(error.response?.data?.error || t('loadStatementsFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">{t('pageTitle')}</h1>

      {loading ? (
        <div className="text-center py-12">
          <i className="fas fa-spinner fa-spin text-3xl text-gray-400"></i>
        </div>
      ) : statements.length === 0 ? (
        <div className="text-center py-12 bg-gray-50 rounded-lg">
          <i className="fas fa-file-invoice-dollar text-4xl text-gray-400 mb-3"></i>
          <p className="text-gray-500">{t('noStatements')}</p>
          <p className="text-sm text-gray-400 mt-2">{t('autoGenerateHint')}</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('period')}</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">License</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('maintenanceService')}</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('revenueDetail')}</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('commissionDetail')}</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('status')}</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('paidAt')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {statements.map((statement) => {
                const licenseRevenue = parseFloat(statement.total_revenue) - (parseFloat(statement.total_maintenance_revenue || '0'))
                const licenseCommission = parseFloat(statement.total_commission) - (parseFloat(statement.total_maintenance_commission || '0'))

                return (
                  <tr key={statement.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4">
                      <div className="text-sm text-gray-900">{formatDate(statement.period_start)}</div>
                      <div className="text-xs text-gray-500">{t('until')} {formatDate(statement.period_end)}</div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm text-gray-900">
                        <i className="fas fa-certificate text-blue-500 mr-1"></i>
                        {t('countUnit', { n: statement.total_licenses })}
                      </div>
                      <div className="text-xs text-gray-500">{t('licenseIssuance')}</div>
                    </td>
                    <td className="px-6 py-4">
                      {statement.maintenance_count ? (
                        <>
                          <div className="text-sm text-gray-900">
                            <i className="fas fa-tools text-green-500 mr-1"></i>
                            {t('countUnit', { n: statement.maintenance_count })}
                          </div>
                          <div className="text-xs text-gray-500">{t('maintenanceRenewal')}</div>
                        </>
                      ) : (
                        <span className="text-sm text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm space-y-1">
                        <div className="flex justify-between">
                          <span className="text-gray-600">License:</span>
                          <span className="font-medium">¥{(licenseRevenue / 100).toLocaleString()}</span>
                        </div>
                        {statement.total_maintenance_revenue && parseFloat(statement.total_maintenance_revenue) > 0 && (
                          <div className="flex justify-between">
                            <span className="text-gray-600">{t('maintenanceFeeLabel')}</span>
                            <span className="font-medium">¥{(parseFloat(statement.total_maintenance_revenue) / 100).toLocaleString()}</span>
                          </div>
                        )}
                        <div className="flex justify-between border-t pt-1">
                          <span className="font-semibold">{t('totalLabel')}</span>
                          <span className="font-bold">¥{(parseFloat(statement.total_revenue) / 100).toLocaleString()}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm space-y-1">
                        <div className="flex justify-between">
                          <span className="text-gray-600">License:</span>
                          <span className="text-blue-600 font-medium">¥{(licenseCommission / 100).toLocaleString()}</span>
                        </div>
                        {statement.total_maintenance_commission && parseFloat(statement.total_maintenance_commission) > 0 && (
                          <div className="flex justify-between">
                            <span className="text-gray-600">{t('maintenanceFeeLabel')}</span>
                            <span className="text-green-600 font-medium">¥{(parseFloat(statement.total_maintenance_commission) / 100).toLocaleString()}</span>
                          </div>
                        )}
                        <div className="flex justify-between border-t pt-1">
                          <span className="font-semibold">{t('totalLabel')}</span>
                          <span className="font-bold text-green-600">¥{(parseFloat(statement.total_commission) / 100).toLocaleString()}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`px-2 py-1 text-xs rounded-full ${STATUS_BADGE[statement.status]}`}>
                        {t(STATUS_LABEL_KEY[statement.status])}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-900">
                      {statement.paid_at ? formatDate(statement.paid_at) : '-'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
