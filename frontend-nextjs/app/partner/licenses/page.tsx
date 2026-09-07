'use client'

import { useState, useEffect } from 'react'
import { partnerAPI } from '@/lib/api'
import { useNotification } from '@/hooks/useNotification'
import Drawer from '@/components/Drawer'
import type { CustomerLicense, IssueLicenseRequest, IssueLicenseResponse, PartnerProfile } from '@/lib/types/partner'

const formatDate = (raw: string): string => {
  const d = new Date(raw)
  if (isNaN(d.getTime())) return raw
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function LicensesPage() {
  const notify = useNotification()
  const [profile, setProfile] = useState<PartnerProfile | null>(null)
  const [licenses, setLicenses] = useState<CustomerLicense[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)

  // 签发 License 抽屉
  const [showIssue, setShowIssue] = useState(false)
  const [issuing, setIssuing] = useState(false)
  const [issueData, setIssueData] = useState<IssueLicenseRequest>({
    customer_name: '',
    customer_company: '',
    customer_email: '',
    customer_contact_phone: '',
    edition: 'standard',
    modules: ['ai'],
    max_nodes: 1,
    max_tenants: 1,
    fingerprint: '',
    days: 365,
    grace_days: 30,
    license_type: 'subscription',
    price: 100000,
    currency: 'CNY',
    include_maintenance: true,
    maintenance_years: 1,
    maintenance_price_override: undefined,
    maintenance_commission_rate: 1000,
    auto_renew_maintenance: false,
  })

  // License 文件预览抽屉
  const [showLicenseFile, setShowLicenseFile] = useState(false)
  const [licenseFileData, setLicenseFileData] = useState<IssueLicenseResponse | null>(null)

  useEffect(() => {
    loadProfile()
    loadLicenses()
  }, [page])

  const loadProfile = async () => {
    try {
      const res = await partnerAPI.getProfile()
      setProfile(res.data)
    } catch (error: any) {
      notify.error(error.response?.data?.error || '加载配置失败')
    }
  }

  const loadLicenses = async () => {
    try {
      setLoading(true)
      const res = await partnerAPI.listCustomers({ page, page_size: 20 })
      setLicenses(res.data.licenses as CustomerLicense[])
      setTotalPages(res.data.pagination.total_pages)
    } catch (error: any) {
      notify.error(error.response?.data?.error || '加载 License 列表失败')
    } finally {
      setLoading(false)
    }
  }

  const handleIssue = async () => {
    if (!issueData.customer_name || !issueData.edition || issueData.modules.length === 0) {
      notify.error('请填写所有必填字段')
      return
    }

    try {
      setIssuing(true)
      const res = await partnerAPI.issueLicense(issueData)
      notify.success('License 签发成功！')

      // 显示 License 文件
      setLicenseFileData(res.data)
      setShowLicenseFile(true)
      setShowIssue(false)

      // 重新加载列表和配置
      loadLicenses()
      loadProfile()

      // 重置表单
      setIssueData({
        customer_name: '',
        customer_company: '',
        customer_email: '',
        customer_contact_phone: '',
        edition: 'standard',
        modules: ['ai'],
        max_nodes: 1,
        max_tenants: 1,
        fingerprint: '',
        days: 365,
        grace_days: 30,
        license_type: 'subscription',
        price: 100000,
        currency: 'CNY',
        include_maintenance: true,
        maintenance_years: 1,
        maintenance_price_override: undefined,
        maintenance_commission_rate: 1000,
        auto_renew_maintenance: false,
      })
    } catch (error: any) {
      notify.error(error.response?.data?.error || 'License 签发失败')
    } finally {
      setIssuing(false)
    }
  }

  const downloadLicenseFile = (licenseFile: any, fileName: string) => {
    const blob = new Blob([JSON.stringify(licenseFile, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">License 管理</h1>
          <p className="text-sm text-gray-500 mt-1">签发、续费和管理客户 License</p>
        </div>
        <button
          onClick={() => setShowIssue(true)}
          disabled={!profile || profile.available_quota <= 0}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <i className="fas fa-plus mr-2"></i>
          签发 License
        </button>
      </div>

      {profile && profile.available_quota <= 0 && (
        <div className="mb-4 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <p className="text-yellow-800">配额已耗尽，无法签发新 License。请联系管理员增加配额。</p>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12">
          <i className="fas fa-spinner fa-spin text-3xl text-gray-400"></i>
        </div>
      ) : licenses.length === 0 ? (
        <div className="text-center py-12 bg-gray-50 rounded-lg">
          <i className="fas fa-certificate text-4xl text-gray-400 mb-3"></i>
          <p className="text-gray-500">暂无 License</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">客户信息</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">版本/模块</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">类型</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">License 到期</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">维护服务</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">状态</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">价格</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {licenses.map((license) => {
                const hasActiveMaintenance = license.has_maintenance &&
                  license.maintenance_expires_at &&
                  new Date(license.maintenance_expires_at) > new Date()

                return (
                  <tr key={license.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4">
                      <div className="font-medium text-gray-900">{license.customer_name}</div>
                      {license.customer_email && (
                        <div className="text-sm text-gray-500">{license.customer_email}</div>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm text-gray-900">{license.edition}</div>
                      <div className="text-xs text-gray-500">{(license.modules as any[]).join(', ')}</div>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`px-2 py-1 text-xs rounded-full ${
                        license.license_type === 'subscription'
                          ? 'bg-blue-100 text-blue-700'
                          : 'bg-purple-100 text-purple-700'
                      }`}>
                        {license.license_type === 'subscription' ? '订阅制' : '永久'}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-900">{formatDate(license.expires_at)}</td>
                    <td className="px-6 py-4">
                      {license.has_maintenance ? (
                        <div className="text-sm">
                          <div className={`font-medium ${hasActiveMaintenance ? 'text-green-600' : 'text-red-600'}`}>
                            {hasActiveMaintenance ? (
                              <>
                                <i className="fas fa-shield-alt mr-1"></i>
                                有效
                              </>
                            ) : (
                              <>
                                <i className="fas fa-exclamation-circle mr-1"></i>
                                已过期
                              </>
                            )}
                          </div>
                          {license.maintenance_expires_at && (
                            <div className="text-xs text-gray-500">
                              至 {formatDate(license.maintenance_expires_at)}
                            </div>
                          )}
                          {license.auto_renew_maintenance && (
                            <div className="text-xs text-blue-600 mt-1">
                              <i className="fas fa-sync-alt mr-1"></i>
                              自动续费
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`px-2 py-1 text-xs rounded-full ${
                        license.status === 'active'
                          ? 'bg-green-100 text-green-700'
                          : license.status === 'grace'
                          ? 'bg-yellow-100 text-yellow-700'
                          : license.status === 'expired'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-gray-100 text-gray-700'
                      }`}>
                        {license.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-900">¥{(parseFloat(license.price) / 100).toLocaleString()}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 签发 License 抽屉 */}
      <Drawer
        isOpen={showIssue}
        onClose={() => setShowIssue(false)}
        title="签发 License"
        size="xl"
        footer={
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setShowIssue(false)}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              取消
            </button>
            <button
              onClick={handleIssue}
              disabled={issuing}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {issuing ? '签发中...' : '签发 License'}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              客户名称 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={issueData.customer_name}
              onChange={(e) => setIssueData({ ...issueData, customer_name: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="例如：上海某某科技有限公司"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">版本</label>
              <select
                value={issueData.edition}
                onChange={(e) => setIssueData({ ...issueData, edition: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {profile?.partner.allowed_editions && (profile.partner.allowed_editions as any[]).map((ed) => (
                  <option key={ed} value={ed}>{ed}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">类型</label>
              <select
                value={issueData.license_type}
                onChange={(e) => setIssueData({ ...issueData, license_type: e.target.value as any })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="subscription">订阅制</option>
                <option value="perpetual">永久买断</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">模块</label>
            <div className="flex flex-wrap gap-2">
              {profile?.partner.allowed_modules && (profile.partner.allowed_modules as any[]).map((mod) => (
                <label key={mod} className="flex items-center">
                  <input
                    type="checkbox"
                    checked={issueData.modules.includes(mod)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setIssueData({ ...issueData, modules: [...issueData.modules, mod] })
                      } else {
                        setIssueData({ ...issueData, modules: issueData.modules.filter((m) => m !== mod) })
                      }
                    }}
                    className="mr-2"
                  />
                  {mod}
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">有效天数</label>
              <input
                type="number"
                min="1"
                max={profile?.partner.max_license_days || undefined}
                value={issueData.days}
                onChange={(e) => setIssueData({ ...issueData, days: parseInt(e.target.value) || 1 })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">最大节点数</label>
              <input
                type="number"
                min="1"
                value={issueData.max_nodes}
                onChange={(e) => setIssueData({ ...issueData, max_nodes: parseInt(e.target.value) || 1 })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">最大租户数</label>
              <input
                type="number"
                min="1"
                value={issueData.max_tenants}
                onChange={(e) => setIssueData({ ...issueData, max_tenants: parseInt(e.target.value) || 1 })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">License 价格（分）</label>
            <input
              type="number"
              min="0"
              value={issueData.price}
              onChange={(e) => setIssueData({ ...issueData, price: parseFloat(e.target.value) || 0 })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {profile && (
              <p className="text-xs text-gray-500 mt-1">
                License 佣金（{profile.partner.commission_rate}%）：¥{(issueData.price * parseFloat(profile.partner.commission_rate) / 100 / 100).toLocaleString()}
              </p>
            )}
          </div>

          {/* 维护费配置 */}
          <div className="border-t pt-4">
            <div className="flex items-center mb-4">
              <input
                type="checkbox"
                id="include_maintenance"
                checked={issueData.include_maintenance}
                onChange={(e) => setIssueData({ ...issueData, include_maintenance: e.target.checked })}
                className="mr-2"
              />
              <label htmlFor="include_maintenance" className="text-sm font-medium text-gray-700">
                包含年度维护服务（AMA）
              </label>
            </div>

            {issueData.include_maintenance && (
              <div className="space-y-4 bg-gray-50 p-4 rounded-lg">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">维护年限</label>
                    <select
                      value={issueData.maintenance_years}
                      onChange={(e) => setIssueData({ ...issueData, maintenance_years: parseInt(e.target.value) })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      {[1, 2, 3, 4, 5].map((year) => (
                        <option key={year} value={year}>{year} 年</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      维护费/年（分，默认 License 价格的 20%）
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={issueData.maintenance_price_override || Math.round(issueData.price * 0.2)}
                      onChange={(e) => setIssueData({
                        ...issueData,
                        maintenance_price_override: parseFloat(e.target.value) || undefined
                      })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>

                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="auto_renew"
                    checked={issueData.auto_renew_maintenance}
                    onChange={(e) => setIssueData({ ...issueData, auto_renew_maintenance: e.target.checked })}
                    className="mr-2"
                  />
                  <label htmlFor="auto_renew" className="text-sm text-gray-700">
                    启用自动续费（到期前 7 天自动续费）
                  </label>
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded p-3 text-sm">
                  <div className="flex justify-between mb-1">
                    <span className="text-gray-600">维护费单价：</span>
                    <span className="font-medium">
                      ¥{((issueData.maintenance_price_override || Math.round(issueData.price * 0.2)) / 100).toLocaleString()}/年
                    </span>
                  </div>
                  <div className="flex justify-between mb-1">
                    <span className="text-gray-600">维护费总计（{issueData.maintenance_years}年）：</span>
                    <span className="font-medium">
                      ¥{((issueData.maintenance_price_override || Math.round(issueData.price * 0.2)) * issueData.maintenance_years / 100).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between border-t border-blue-300 pt-1 mt-1">
                    <span className="text-gray-600">维护费佣金（10%）：</span>
                    <span className="font-bold text-green-600">
                      ¥{((issueData.maintenance_price_override || Math.round(issueData.price * 0.2)) * issueData.maintenance_years * 0.1 / 100).toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 总计预览 */}
          <div className="border-t pt-4 bg-indigo-50 rounded-lg p-4">
            <h4 className="font-semibold text-gray-900 mb-3">费用总览</h4>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-600">License 费用：</span>
                <span className="font-medium">¥{(issueData.price / 100).toLocaleString()}</span>
              </div>
              {issueData.include_maintenance && (
                <div className="flex justify-between">
                  <span className="text-gray-600">维护费（{issueData.maintenance_years}年）：</span>
                  <span className="font-medium">
                    ¥{((issueData.maintenance_price_override || Math.round(issueData.price * 0.2)) * issueData.maintenance_years / 100).toLocaleString()}
                  </span>
                </div>
              )}
              <div className="flex justify-between border-t border-indigo-200 pt-2 mt-2">
                <span className="font-semibold text-gray-900">客户总计：</span>
                <span className="font-bold text-lg">
                  ¥{((issueData.price + (issueData.include_maintenance ? (issueData.maintenance_price_override || Math.round(issueData.price * 0.2)) * issueData.maintenance_years : 0)) / 100).toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between border-t border-indigo-200 pt-2">
                <span className="font-semibold text-gray-900">您的佣金：</span>
                <span className="font-bold text-xl text-green-600">
                  ¥{(
                    (issueData.price * parseFloat(profile?.partner.commission_rate || '0') / 100 / 100) +
                    (issueData.include_maintenance ? (issueData.maintenance_price_override || Math.round(issueData.price * 0.2)) * issueData.maintenance_years * 0.1 / 100 : 0)
                  ).toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        </div>
      </Drawer>

      {/* License 文件下载抽屉 */}
      <Drawer
        isOpen={showLicenseFile}
        onClose={() => setShowLicenseFile(false)}
        title="License 签发成功"
        size="lg"
      >
        {licenseFileData && (
          <div className="space-y-4">
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <i className="fas fa-check-circle text-green-600 mr-2"></i>
              <span className="text-green-800">License 签发成功！请下载 License 文件并交付给客户。</span>
            </div>

            <div className="space-y-2">
              <div className="text-sm text-gray-600">License ID:</div>
              <div className="font-mono text-sm bg-gray-100 p-3 rounded">{licenseFileData.license_id}</div>
            </div>

            <div className="space-y-2">
              <div className="text-sm text-gray-600">到期时间:</div>
              <div className="text-sm font-medium">{formatDate(licenseFileData.expires_at)}</div>
            </div>

            <div className="space-y-2">
              <div className="text-sm text-gray-600">佣金金额:</div>
              <div className="text-xl font-bold text-green-600">
                ¥{parseFloat(licenseFileData.commission_amount).toLocaleString()}
              </div>
            </div>

            <button
              onClick={() => downloadLicenseFile(licenseFileData.license_file, `license_${licenseFileData.license_id.slice(0, 8)}.lic`)}
              className="w-full px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              <i className="fas fa-download mr-2"></i>
              下载 License 文件
            </button>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm">
              <p className="text-blue-800 font-medium mb-2">交付说明：</p>
              <ol className="text-blue-700 space-y-1 list-decimal list-inside">
                <li>下载 license.lic 文件</li>
                <li>将文件交付给客户</li>
                <li>客户需将文件放置到 /etc/onebase/license.lic</li>
                <li>重启 OneBase 服务即可激活</li>
              </ol>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  )
}
