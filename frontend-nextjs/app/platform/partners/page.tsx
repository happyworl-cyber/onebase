'use client'

import { useState, useEffect } from 'react'
import { adminPartnerAPI } from '@/lib/api'
import { useNotification } from '@/hooks/useNotification'
import Drawer from '@/components/Drawer'
import type { PartnerStats, CreatePartnerRequest, UpdatePartnerRequest } from '@/lib/types/partner'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'active', label: '活跃' },
  { value: 'suspended', label: '已挂起' },
  { value: 'inactive', label: '未激活' },
]

const STATUS_BADGE: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  suspended: 'bg-red-100 text-red-700',
  inactive: 'bg-gray-100 text-gray-700',
}

const STATUS_LABEL: Record<string, string> = {
  active: '活跃',
  suspended: '已挂起',
  inactive: '未激活',
}

const EDITION_OPTIONS = [
  { value: 'standard', label: 'Standard（标准版）' },
  { value: 'enterprise', label: 'Enterprise（企业版）' },
  { value: 'trial', label: 'Trial（试用版）' },
]

const MODULE_OPTIONS = [
  { value: 'ai', label: 'AI 能力' },
  { value: 'ha', label: '高可用（HA）' },
  { value: 'backup', label: '备份恢复' },
  { value: 'multitenant', label: '多租户' },
  { value: 'audit', label: '审计日志' },
  { value: 'pipeline', label: 'CI/CD 流水线' },
]

const formatDate = (raw: string): string => {
  const d = new Date(raw)
  if (isNaN(d.getTime())) return raw
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const formatNumber = (n: number | string | null | undefined): string => {
  if (n === null || n === undefined) return '0'
  return Number(n).toLocaleString()
}

// ═══════════════════════════════════════════════════════════
// 页面组件
// ═══════════════════════════════════════════════════════════

export default function PartnersPage() {
  const notify = useNotification()

  const [partners, setPartners] = useState<PartnerStats[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)

  // 创建代理商抽屉
  const [showCreate, setShowCreate] = useState(false)
  const [newPartner, setNewPartner] = useState<CreatePartnerRequest>({
    name: '',
    company_name: '',
    slug: '',
    contact_email: '',
    contact_phone: '',
    commission_rate: 10,
    payment_terms: 30,
    license_quota: 100,
    quota_expires_at: '',
    allowed_editions: ['standard', 'enterprise'],
    allowed_modules: ['ai', 'ha'],
    max_license_days: 365,
  })
  const [creating, setCreating] = useState(false)

  // 编辑代理商抽屉
  const [showEdit, setShowEdit] = useState(false)
  const [editingPartner, setEditingPartner] = useState<PartnerStats | null>(null)
  const [editData, setEditData] = useState<UpdatePartnerRequest>({})
  const [updating, setUpdating] = useState(false)

  // 详情抽屉
  const [showDetail, setShowDetail] = useState(false)
  const [detailPartner, setDetailPartner] = useState<PartnerStats | null>(null)

  // ──────────────────────────────────────────────
  // 数据加载
  // ──────────────────────────────────────────────

  const loadPartners = async () => {
    try {
      setLoading(true)
      const res = await adminPartnerAPI.list({
        status: statusFilter || undefined,
        page,
        page_size: 20,
      })
      setPartners(res.data.partners as PartnerStats[])
      setTotalPages(res.data.pagination.total_pages)
    } catch (error: any) {
      notify.error(error.response?.data?.error || '加载代理商列表失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadPartners()
  }, [statusFilter, page])

  // ──────────────────────────────────────────────
  // 创建代理商
  // ──────────────────────────────────────────────

  const handleCreate = async () => {
    if (!newPartner.name || !newPartner.company_name || !newPartner.slug || !newPartner.contact_email) {
      notify.error('请填写所有必填字段')
      return
    }

    try {
      setCreating(true)
      await adminPartnerAPI.create(newPartner)
      notify.success('代理商创建成功')
      setShowCreate(false)
      setNewPartner({
        name: '',
        company_name: '',
        slug: '',
        contact_email: '',
        contact_phone: '',
        commission_rate: 10,
        payment_terms: 30,
        license_quota: 100,
        quota_expires_at: '',
        allowed_editions: ['standard', 'enterprise'],
        allowed_modules: ['ai', 'ha'],
        max_license_days: 365,
      })
      loadPartners()
    } catch (error: any) {
      notify.error(error.response?.data?.error || '创建代理商失败')
    } finally {
      setCreating(false)
    }
  }

  // ──────────────────────────────────────────────
  // 编辑代理商
  // ──────────────────────────────────────────────

  const openEdit = (partner: PartnerStats) => {
    setEditingPartner(partner)
    setEditData({
      commission_rate: parseFloat(partner.commission_rate),
      license_quota: partner.license_quota,
      status: partner.status as any,
    })
    setShowEdit(true)
  }

  const handleUpdate = async () => {
    if (!editingPartner) return

    try {
      setUpdating(true)
      await adminPartnerAPI.update(editingPartner.partner_id, editData)
      notify.success('代理商信息更新成功')
      setShowEdit(false)
      loadPartners()
    } catch (error: any) {
      notify.error(error.response?.data?.error || '更新代理商失败')
    } finally {
      setUpdating(false)
    }
  }

  // ──────────────────────────────────────────────
  // 挂起代理商
  // ──────────────────────────────────────────────

  const handleSuspend = async (partner: PartnerStats) => {
    if (!confirm(`确定要挂起代理商「${partner.name}」吗？挂起后将无法签发新 License。`)) {
      return
    }

    try {
      await adminPartnerAPI.suspend(partner.partner_id)
      notify.success('代理商已挂起')
      loadPartners()
    } catch (error: any) {
      notify.error(error.response?.data?.error || '挂起代理商失败')
    }
  }

  // ──────────────────────────────────────────────
  // 查看详情
  // ──────────────────────────────────────────────

  const viewDetail = (partner: PartnerStats) => {
    setDetailPartner(partner)
    setShowDetail(true)
  }

  // ──────────────────────────────────────────────
  // 渲染
  // ──────────────────────────────────────────────

  return (
    <div className="p-6">
      {/* 标题栏 */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">代理商管理</h1>
          <p className="text-sm text-gray-500 mt-1">管理代理商配额、佣金比例和授权范围</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          <i className="fas fa-plus mr-2"></i>
          创建代理商
        </button>
      </div>

      {/* 筛选栏 */}
      <div className="mb-4 flex items-center gap-4">
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600">状态：</label>
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value)
              setPage(1)
            }}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 表格 */}
      {loading ? (
        <div className="text-center py-12">
          <i className="fas fa-spinner fa-spin text-3xl text-gray-400"></i>
          <p className="text-gray-500 mt-2">加载中...</p>
        </div>
      ) : partners.length === 0 ? (
        <div className="text-center py-12 bg-gray-50 rounded-lg">
          <i className="fas fa-inbox text-4xl text-gray-400 mb-3"></i>
          <p className="text-gray-500">暂无代理商</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  代理商信息
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  状态
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  配额使用
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  佣金比例
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  License 统计
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  佣金统计
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  操作
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {partners.map((partner) => {
                const usagePercent = partner.license_quota > 0
                  ? Math.round((partner.used_quota / partner.license_quota) * 100)
                  : 0
                return (
                  <tr key={partner.partner_id} className="hover:bg-gray-50">
                    <td className="px-6 py-4">
                      <div className="font-medium text-gray-900">{partner.name}</div>
                      <div className="text-sm text-gray-500">{partner.slug}</div>
                    </td>
                    <td className="px-6 py-4">
                      <span
                        className={`px-2 py-1 text-xs font-medium rounded-full ${
                          STATUS_BADGE[partner.status] || 'bg-gray-100 text-gray-700'
                        }`}
                      >
                        {STATUS_LABEL[partner.status] || partner.status}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm text-gray-900">
                        {partner.used_quota} / {partner.license_quota}
                      </div>
                      <div className="w-full bg-gray-200 rounded-full h-2 mt-1">
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
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-900">{partner.commission_rate}%</td>
                    <td className="px-6 py-4">
                      <div className="text-sm text-gray-900">
                        总数: {formatNumber(partner.total_licenses)}
                      </div>
                      <div className="text-xs text-gray-500">
                        活跃: {formatNumber(partner.active_licenses)}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm text-gray-900">
                        总计: ¥{formatNumber(partner.total_commission)}
                      </div>
                      <div className="text-xs text-gray-500">
                        待结算: ¥{formatNumber(partner.pending_commission)}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right space-x-2">
                      <button
                        onClick={() => viewDetail(partner)}
                        className="text-blue-600 hover:text-blue-800 text-sm"
                      >
                        详情
                      </button>
                      <button
                        onClick={() => openEdit(partner)}
                        className="text-green-600 hover:text-green-800 text-sm"
                      >
                        编辑
                      </button>
                      {partner.status === 'active' && (
                        <button
                          onClick={() => handleSuspend(partner)}
                          className="text-red-600 hover:text-red-800 text-sm"
                        >
                          挂起
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <div className="text-sm text-gray-600">
            第 {page} / {totalPages} 页
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
            >
              上一页
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
            >
              下一页
            </button>
          </div>
        </div>
      )}

      {/* 创建代理商抽屉 */}
      <Drawer
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        title="创建代理商"
        size="lg"
        footer={
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setShowCreate(false)}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              取消
            </button>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {creating ? '创建中...' : '创建'}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              代理商名称 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={newPartner.name}
              onChange={(e) => setNewPartner({ ...newPartner, name: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="例如：华东区代理商"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              公司名称 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={newPartner.company_name}
              onChange={(e) => setNewPartner({ ...newPartner, company_name: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="例如：上海云联科技有限公司"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Slug <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={newPartner.slug}
              onChange={(e) => setNewPartner({ ...newPartner, slug: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="例如：huadong-partner"
            />
            <p className="text-xs text-gray-500 mt-1">用于 URL 识别，仅支持小写字母、数字、连字符</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                联系邮箱 <span className="text-red-500">*</span>
              </label>
              <input
                type="email"
                value={newPartner.contact_email}
                onChange={(e) => setNewPartner({ ...newPartner, contact_email: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">联系电话</label>
              <input
                type="text"
                value={newPartner.contact_phone}
                onChange={(e) => setNewPartner({ ...newPartner, contact_phone: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">佣金比例 (%)</label>
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={newPartner.commission_rate}
                onChange={(e) =>
                  setNewPartner({ ...newPartner, commission_rate: parseFloat(e.target.value) || 0 })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">账期天数</label>
              <input
                type="number"
                value={newPartner.payment_terms}
                onChange={(e) =>
                  setNewPartner({ ...newPartner, payment_terms: parseInt(e.target.value) || 30 })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">License 配额</label>
              <input
                type="number"
                min="0"
                value={newPartner.license_quota}
                onChange={(e) =>
                  setNewPartner({ ...newPartner, license_quota: parseInt(e.target.value) || 0 })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                最长签发天数
              </label>
              <input
                type="number"
                value={newPartner.max_license_days || ''}
                onChange={(e) =>
                  setNewPartner({
                    ...newPartner,
                    max_license_days: e.target.value ? parseInt(e.target.value) : undefined,
                  })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="不限制"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">允许的版本</label>
            <div className="space-y-2">
              {EDITION_OPTIONS.map((opt) => (
                <label key={opt.value} className="flex items-center">
                  <input
                    type="checkbox"
                    checked={newPartner.allowed_editions.includes(opt.value)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setNewPartner({
                          ...newPartner,
                          allowed_editions: [...newPartner.allowed_editions, opt.value],
                        })
                      } else {
                        setNewPartner({
                          ...newPartner,
                          allowed_editions: newPartner.allowed_editions.filter((v) => v !== opt.value),
                        })
                      }
                    }}
                    className="mr-2"
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">允许的模块</label>
            <div className="space-y-2">
              {MODULE_OPTIONS.map((opt) => (
                <label key={opt.value} className="flex items-center">
                  <input
                    type="checkbox"
                    checked={newPartner.allowed_modules.includes(opt.value)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setNewPartner({
                          ...newPartner,
                          allowed_modules: [...newPartner.allowed_modules, opt.value],
                        })
                      } else {
                        setNewPartner({
                          ...newPartner,
                          allowed_modules: newPartner.allowed_modules.filter((v) => v !== opt.value),
                        })
                      }
                    }}
                    className="mr-2"
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>
        </div>
      </Drawer>

      {/* 编辑代理商抽屉 */}
      <Drawer
        isOpen={showEdit}
        onClose={() => setShowEdit(false)}
        title="编辑代理商"
        size="md"
        footer={
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setShowEdit(false)}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              取消
            </button>
            <button
              onClick={handleUpdate}
              disabled={updating}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {updating ? '保存中...' : '保存'}
            </button>
          </div>
        }
      >
        {editingPartner && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">状态</label>
              <select
                value={editData.status || editingPartner.status}
                onChange={(e) => setEditData({ ...editData, status: e.target.value as any })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="active">活跃</option>
                <option value="suspended">已挂起</option>
                <option value="inactive">未激活</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">佣金比例 (%)</label>
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={editData.commission_rate ?? parseFloat(editingPartner.commission_rate)}
                onChange={(e) =>
                  setEditData({ ...editData, commission_rate: parseFloat(e.target.value) || 0 })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">License 配额</label>
              <input
                type="number"
                min="0"
                value={editData.license_quota ?? editingPartner.license_quota}
                onChange={(e) =>
                  setEditData({ ...editData, license_quota: parseInt(e.target.value) || 0 })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-500 mt-1">
                当前已用：{editingPartner.used_quota}
              </p>
            </div>
          </div>
        )}
      </Drawer>

      {/* 详情抽屉 */}
      <Drawer
        isOpen={showDetail}
        onClose={() => setShowDetail(false)}
        title="代理商详情"
        size="lg"
      >
        {detailPartner && (
          <div className="space-y-6">
            <div>
              <h3 className="text-sm font-medium text-gray-500 mb-2">基本信息</h3>
              <dl className="grid grid-cols-2 gap-4">
                <div>
                  <dt className="text-xs text-gray-500">代理商名称</dt>
                  <dd className="text-sm font-medium text-gray-900">{detailPartner.name}</dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">Slug</dt>
                  <dd className="text-sm font-medium text-gray-900">{detailPartner.slug}</dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">状态</dt>
                  <dd>
                    <span
                      className={`px-2 py-1 text-xs font-medium rounded-full ${
                        STATUS_BADGE[detailPartner.status]
                      }`}
                    >
                      {STATUS_LABEL[detailPartner.status]}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">创建时间</dt>
                  <dd className="text-sm text-gray-900">{formatDate(detailPartner.created_at)}</dd>
                </div>
              </dl>
            </div>

            <div>
              <h3 className="text-sm font-medium text-gray-500 mb-2">配额与佣金</h3>
              <dl className="grid grid-cols-2 gap-4">
                <div>
                  <dt className="text-xs text-gray-500">佣金比例</dt>
                  <dd className="text-sm font-medium text-gray-900">
                    {detailPartner.commission_rate}%
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">配额使用</dt>
                  <dd className="text-sm font-medium text-gray-900">
                    {detailPartner.used_quota} / {detailPartner.license_quota}
                  </dd>
                </div>
              </dl>
            </div>

            <div>
              <h3 className="text-sm font-medium text-gray-500 mb-2">License 统计</h3>
              <dl className="grid grid-cols-2 gap-4">
                <div>
                  <dt className="text-xs text-gray-500">总 License 数</dt>
                  <dd className="text-sm font-medium text-gray-900">
                    {formatNumber(detailPartner.total_licenses)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">活跃 License</dt>
                  <dd className="text-sm font-medium text-gray-900">
                    {formatNumber(detailPartner.active_licenses)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">订阅制</dt>
                  <dd className="text-sm text-gray-900">
                    {formatNumber(detailPartner.subscription_licenses)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">永久买断</dt>
                  <dd className="text-sm text-gray-900">
                    {formatNumber(detailPartner.perpetual_licenses)}
                  </dd>
                </div>
              </dl>
            </div>

            <div>
              <h3 className="text-sm font-medium text-gray-500 mb-2">佣金统计</h3>
              <dl className="grid grid-cols-2 gap-4">
                <div>
                  <dt className="text-xs text-gray-500">总佣金</dt>
                  <dd className="text-sm font-medium text-gray-900">
                    ¥{formatNumber(detailPartner.total_commission)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">已结算</dt>
                  <dd className="text-sm text-gray-900">
                    ¥{formatNumber(detailPartner.settled_commission)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">待结算</dt>
                  <dd className="text-sm text-gray-900">
                    ¥{formatNumber(detailPartner.pending_commission)}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  )
}
