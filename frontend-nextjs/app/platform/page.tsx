'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { adminAPI, tenantAPI, type Replica, type ReplicaHealth } from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { useNotification } from '@/hooks/useNotification'
import Drawer from '@/components/Drawer'

// 注意：登录态 / 超管校验 / 顶部布局由 app/platform/layout.tsx 统一处理；
// 本页只关心"项目（租户）"业务。

interface Tenant {
  id: number
  name: string
  slug: string
  database_id: number | null  // tenant_databases 表的 ID
  db_host: string
  db_port: number
  db_name: string
  db_user: string
  is_active: boolean
  created_at: string
}

/** 健康状态分级；用于把后端原始字段映射成 UI 颜色 + 文案 */
type HealthLevel = 'unknown' | 'healthy' | 'warn' | 'critical' | 'misconfigured' | 'bypassed'

function classifyHealth(h: ReplicaHealth | undefined): {
  level: HealthLevel
  label: string
  tooltip: string
} {
  if (!h) {
    return { level: 'unknown', label: '探测中…', tooltip: '尚未拿到首次健康快照' }
  }
  // 看护任务的运行时旁路优先于其它分级显示 —— 这是一个“当前不接收读流量”的事实
  if (h.bypassed) {
    return {
      level: 'bypassed',
      label: '已自动旁路',
      tooltip:
        '运行时看护任务连续探活失败 / 延迟超阈值 / 非 standby，已临时把该副本从读流量轮询中摘除。一旦健康探活恢复，会自动重新上线（无需手动操作，也不会改动 is_active）。',
    }
  }
  if (!h.reachable) {
    return {
      level: 'critical',
      label: '不可达',
      tooltip: h.error || '无法 TCP 连接 / 鉴权失败',
    }
  }
  if (h.in_recovery === false) {
    return {
      level: 'misconfigured',
      label: '非 standby',
      tooltip:
        '该机器并不处于物理流复制状态（pg_is_in_recovery() = false）。读流量打过去会读不到 primary 的新写入，请联系 DBA 重新配置流复制。',
    }
  }
  const lag = h.lag_seconds
  if (lag == null) {
    // standby 但还没重放过任何事务 → 视为可疑但不算 critical
    return {
      level: 'warn',
      label: '无延迟数据',
      tooltip: '副本可达，但 pg_last_xact_replay_timestamp() 为空（可能刚建好还没追上）',
    }
  }
  if (lag > 30) {
    return {
      level: 'critical',
      label: `延迟 ${lag.toFixed(1)}s`,
      tooltip: '复制落后超过 30 秒；可能正在追赶，或与 primary 失联。',
    }
  }
  if (lag > 5) {
    return {
      level: 'warn',
      label: `延迟 ${lag.toFixed(1)}s`,
      tooltip: '复制落后 5 ~ 30 秒；轻度滞后，读到旧数据的概率上升。',
    }
  }
  return {
    level: 'healthy',
    label: `延迟 ${Math.max(lag, 0).toFixed(2)}s`,
    tooltip: '物理 standby，复制已基本追平。',
  }
}

const HEALTH_BADGE_CLASS: Record<HealthLevel, string> = {
  unknown: 'bg-gray-100 text-gray-500 border-gray-200',
  healthy: 'bg-green-100 text-green-700 border-green-200',
  warn: 'bg-amber-100 text-amber-700 border-amber-200',
  critical: 'bg-red-100 text-red-700 border-red-200',
  misconfigured: 'bg-orange-100 text-orange-700 border-orange-300',
  bypassed: 'bg-purple-100 text-purple-700 border-purple-300',
}

const HEALTH_DOT_CLASS: Record<HealthLevel, string> = {
  unknown: 'bg-gray-300',
  healthy: 'bg-green-500',
  warn: 'bg-amber-500',
  critical: 'bg-red-500',
  misconfigured: 'bg-orange-500',
  bypassed: 'bg-purple-500',
}

export default function PlatformPage() {
  const router = useRouter()
  const notify = useNotification()
  const { setCurrentTenant, setCurrentConnection } = useAppStore()
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreateDrawer, setShowCreateDrawer] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newTenant, setNewTenant] = useState({
    name: '',
    slug: '',
    db_host: 'localhost',
    db_port: '5432',
    db_name: '',
    db_user: 'postgres',
    db_password: '',
    create_database: false,  // false: 连接现有数据库, true: 创建新数据库
  })

  // 编辑项目相关状态
  const [editingTenant, setEditingTenant] = useState<Tenant | null>(null)
  const [updating, setUpdating] = useState(false)
  const [editForm, setEditForm] = useState({
    name: '',
    status: 'active',
    contact_email: '',
    db_host: '',
    db_port: '5432',
    db_name: '',
    db_user: '',
    db_password: '',  // 留空 = 不修改
  })

  // —— 只读副本（读流量横向扩展）——
  /** 每个项目的副本数量，用于在卡片上显示徽标 */
  const [replicaCounts, setReplicaCounts] = useState<Record<number, number>>({})
  const [replicas, setReplicas] = useState<Replica[]>([])
  const [replicasLoading, setReplicasLoading] = useState(false)
  const [showReplicaForm, setShowReplicaForm] = useState(false)
  const [savingReplica, setSavingReplica] = useState(false)
  const [replicaForm, setReplicaForm] = useState({
    connection_name: '',
    db_host: '',
    db_port: '5432',
    db_name: '',
    db_user: '',
    db_password: '',
    weight: '1',
  })
  /** 行内编辑：哪一行处于编辑态 */
  const [editingReplicaId, setEditingReplicaId] = useState<number | null>(null)
  const [replicaPatch, setReplicaPatch] = useState({
    db_host: '',
    db_port: '5432',
    weight: '1',
    db_password: '',
  })
  /** 添加副本时的「测试连接」状态 */
  const [testingReplica, setTestingReplica] = useState(false)
  const [replicaTestResult, setReplicaTestResult] = useState<{
    success: boolean
    message: string
    server_version?: string | null
  } | null>(null)

  // —— 副本健康轮询 ——
  /** 按 replica.id 索引的实时健康快照 */
  const [replicaHealth, setReplicaHealth] = useState<Record<number, ReplicaHealth>>({})
  /** 轮询定时器，避免组件卸载/抽屉关闭时仍在跑 */
  const healthTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const resetReplicaForm = () => {
    setReplicaForm({
      connection_name: '',
      db_host: '',
      db_port: '5432',
      db_name: '',
      db_user: '',
      db_password: '',
      weight: '1',
    })
    setReplicaTestResult(null)
    setShowReplicaForm(false)
  }

  const handleTestReplicaConnection = async () => {
    if (!editingTenant) return
    const host = replicaForm.db_host.trim()
    if (!host) {
      notify.warning('请先填写副本主机地址')
      return
    }
    const port = parseInt(replicaForm.db_port, 10)
    if (Number.isNaN(port) || port <= 0 || port > 65535) {
      notify.warning('端口必须是 1 ~ 65535 的整数')
      return
    }
    // 副本通常和 primary 共账号同库（流复制），未填则沿用主库
    const db = replicaForm.db_name.trim() || editForm.db_name
    const user = replicaForm.db_user.trim() || editForm.db_user
    const pwd = replicaForm.db_password
    if (!pwd) {
      notify.warning('测试连接必须输入密码（保存时留空可沿用主库密文）')
      return
    }
    setTestingReplica(true)
    setReplicaTestResult(null)
    try {
      const res = await tenantAPI.testConnection({
        host,
        port,
        database: db,
        username: user,
        password: pwd,
      })
      setReplicaTestResult(res.data)
    } catch (err: any) {
      setReplicaTestResult({
        success: false,
        message: err?.response?.data?.error || err?.message || '测试失败',
      })
    } finally {
      setTestingReplica(false)
    }
  }

  const refreshReplicaCount = async (tenantId: number) => {
    try {
      const res = await adminAPI.listReplicas(tenantId)
      setReplicaCounts((prev) => ({ ...prev, [tenantId]: res.data.length }))
    } catch {
      // 旧库未跑 007 迁移时会 500；忽略即可，不影响主流程
    }
  }

  const loadReplicas = async (tenantId: number) => {
    setReplicasLoading(true)
    try {
      const res = await adminAPI.listReplicas(tenantId)
      setReplicas(res.data)
      setReplicaCounts((prev) => ({ ...prev, [tenantId]: res.data.length }))
    } catch (err: any) {
      setReplicas([])
      // 提示但不阻塞主表单
      const msg = err?.response?.data?.error || err?.message || ''
      if (!/未配置主数据库/.test(msg)) {
        notify.error(err)
      }
    } finally {
      setReplicasLoading(false)
    }
  }

  /** 拉一次副本健康快照；失败静默忽略，下次轮询自然恢复 */
  const fetchHealth = async (tenantId: number) => {
    try {
      const res = await adminAPI.replicasHealth(tenantId)
      const map: Record<number, ReplicaHealth> = {}
      res.data.forEach((h) => {
        map[h.id] = h
      })
      setReplicaHealth(map)
    } catch {
      // ignore：旧库无 db_role 字段时会 500，避免吵
    }
  }

  const startHealthPolling = (tenantId: number) => {
    if (healthTimerRef.current) clearInterval(healthTimerRef.current)
    fetchHealth(tenantId)
    healthTimerRef.current = setInterval(() => fetchHealth(tenantId), 8000)
  }

  const stopHealthPolling = () => {
    if (healthTimerRef.current) {
      clearInterval(healthTimerRef.current)
      healthTimerRef.current = null
    }
  }

  // 组件卸载时兜底清掉定时器
  useEffect(() => {
    return () => stopHealthPolling()
  }, [])

  const handleAddReplica = async () => {
    if (!editingTenant) return
    const name = replicaForm.connection_name.trim()
    const host = replicaForm.db_host.trim()
    if (!name || !host) {
      notify.warning('请填写副本名称与主机地址')
      return
    }
    const port = parseInt(replicaForm.db_port, 10)
    if (Number.isNaN(port) || port <= 0 || port > 65535) {
      notify.warning('端口必须是 1 ~ 65535 的整数')
      return
    }
    const weight = parseInt(replicaForm.weight, 10) || 1
    setSavingReplica(true)
    try {
      await adminAPI.addReplica(editingTenant.id, {
        connection_name: name,
        db_host: host,
        db_port: port,
        db_name: replicaForm.db_name.trim() || undefined,
        db_user: replicaForm.db_user.trim() || undefined,
        db_password: replicaForm.db_password || undefined,
        weight,
      })
      notify.success('副本已添加；下次请求将按新拓扑路由读流量')
      resetReplicaForm()
      await loadReplicas(editingTenant.id)
      fetchHealth(editingTenant.id)
    } catch (err: any) {
      notify.error(err)
    } finally {
      setSavingReplica(false)
    }
  }

  const handleToggleReplica = async (replica: Replica) => {
    if (!editingTenant) return
    try {
      await adminAPI.updateReplica(editingTenant.id, replica.id, {
        is_active: !replica.is_active,
      })
      notify.success(replica.is_active ? '副本已停用' : '副本已启用')
      await loadReplicas(editingTenant.id)
      fetchHealth(editingTenant.id)
    } catch (err: any) {
      notify.error(err)
    }
  }

  const handleDeleteReplica = async (replica: Replica) => {
    if (!editingTenant) return
    if (!confirm(`确定要删除副本「${replica.connection_name}」吗？`)) return
    try {
      await adminAPI.deleteReplica(editingTenant.id, replica.id)
      notify.success('副本已删除')
      await loadReplicas(editingTenant.id)
      fetchHealth(editingTenant.id)
    } catch (err: any) {
      notify.error(err)
    }
  }

  const beginEditReplica = (replica: Replica) => {
    setEditingReplicaId(replica.id)
    setReplicaPatch({
      db_host: replica.db_host,
      db_port: String(replica.db_port),
      weight: String(replica.weight),
      db_password: '',
    })
  }

  const handleSaveReplicaPatch = async (replicaId: number) => {
    if (!editingTenant) return
    const port = parseInt(replicaPatch.db_port, 10)
    if (Number.isNaN(port) || port <= 0 || port > 65535) {
      notify.warning('端口必须是 1 ~ 65535 的整数')
      return
    }
    try {
      await adminAPI.updateReplica(editingTenant.id, replicaId, {
        db_host: replicaPatch.db_host.trim(),
        db_port: port,
        weight: parseInt(replicaPatch.weight, 10) || 1,
        ...(replicaPatch.db_password ? { db_password: replicaPatch.db_password } : {}),
      })
      notify.success('副本已更新')
      setEditingReplicaId(null)
      await loadReplicas(editingTenant.id)
      fetchHealth(editingTenant.id)
    } catch (err: any) {
      notify.error(err)
    }
  }

  // 加载项目列表
  const loadTenants = async () => {
    try {
      const response = await adminAPI.listTenants()
      const list: Tenant[] = response.data
      setTenants(list)
      // 异步预取每个项目的副本数量（失败不影响列表渲染）
      list.forEach((t) => {
        if (t.database_id) refreshReplicaCount(t.id)
      })
    } catch (err: any) {
      notify.error(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadTenants()
  }, [])

  // 进入项目工作区
  const enterWorkspace = (tenant: Tenant) => {
    if (!tenant.database_id) {
      notify.error('该项目没有配置数据库连接')
      return
    }
    
    // 保存当前项目到 store 和 localStorage
    setCurrentTenant(tenant)
    setCurrentConnection({
      tenant_id: tenant.id,
      database_id: tenant.database_id,  // 这是 X-Database-Id 需要的值
      tenant_name: tenant.name,
      db_host: tenant.db_host,
      db_port: tenant.db_port,
      db_name: tenant.db_name,
      db_user: tenant.db_user,
    })
    localStorage.setItem('current_tenant', JSON.stringify(tenant))
    
    // 跳转到工作区
    router.push('/dashboard')
  }

  // 创建新项目
  const handleCreateTenant = async () => {
    if (!newTenant.name.trim() || !newTenant.slug.trim()) {
      notify.warning('请填写项目名称和标识')
      return
    }

    // 如果不是创建新数据库，则必须提供数据库名
    if (!newTenant.create_database && !newTenant.db_name.trim()) {
      notify.warning('请填写要连接的数据库名称')
      return
    }

    setCreating(true)
    try {
      await adminAPI.createTenant({
        ...newTenant,
        db_port: parseInt(newTenant.db_port),
      })
      notify.success(newTenant.create_database ? '项目创建成功，新数据库已创建' : '项目创建成功')
      setShowCreateDrawer(false)
      setNewTenant({
        name: '',
        slug: '',
        db_host: 'localhost',
        db_port: '5432',
        db_name: '',
        db_user: 'postgres',
        db_password: '',
        create_database: false,
      })
      loadTenants()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setCreating(false)
    }
  }

  // 打开编辑抽屉，预填当前项目信息
  const openEditDrawer = (tenant: Tenant) => {
    setEditingTenant(tenant)
    setEditForm({
      name: tenant.name,
      status: tenant.is_active ? 'active' : 'suspended',
      contact_email: '',
      db_host: tenant.db_host || '',
      db_port: String(tenant.db_port || 5432),
      db_name: tenant.db_name || '',
      db_user: tenant.db_user || '',
      db_password: '',
    })
    setReplicas([])
    setReplicaHealth({})
    setShowReplicaForm(false)
    setEditingReplicaId(null)
    if (tenant.database_id) {
      loadReplicas(tenant.id)
      startHealthPolling(tenant.id)
    }
  }

  const closeEditDrawer = () => {
    stopHealthPolling()
    setEditingTenant(null)
    setReplicas([])
    setReplicaHealth({})
    setShowReplicaForm(false)
    setEditingReplicaId(null)
  }

  // 保存编辑
  const handleUpdateTenant = async () => {
    if (!editingTenant) return
    if (!editForm.name.trim()) {
      notify.warning('项目名称不能为空')
      return
    }
    const port = parseInt(editForm.db_port, 10)
    if (editForm.db_host && (Number.isNaN(port) || port <= 0 || port > 65535)) {
      notify.warning('端口必须是 1 ~ 65535 的整数')
      return
    }

    setUpdating(true)
    try {
      const payload: any = {
        name: editForm.name.trim(),
        status: editForm.status,
        contact_email: editForm.contact_email.trim() || undefined,
      }
      // 只有项目本身就有数据库连接时，才下发数据库字段
      if (editingTenant.database_id) {
        payload.db_host = editForm.db_host.trim()
        payload.db_port = port
        payload.db_name = editForm.db_name.trim()
        payload.db_user = editForm.db_user.trim()
        if (editForm.db_password) {
          payload.db_password = editForm.db_password
        }
      }

      await adminAPI.updateTenant(editingTenant.id, payload)
      notify.success('项目已更新')
      closeEditDrawer()
      loadTenants()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setUpdating(false)
    }
  }

  // 删除项目
  const handleDeleteTenant = async (tenant: Tenant) => {
    if (!confirm(`确定要删除项目 "${tenant.name}" 吗？此操作不可恢复！`)) {
      return
    }

    try {
      await adminAPI.deleteTenant(tenant.id)
      notify.success('项目已删除')
      loadTenants()
    } catch (err: any) {
      notify.error(err)
    }
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* 页面标题 */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">项目管理</h2>
            <p className="text-gray-600 mt-1">管理所有数据库项目，点击项目进入工作区</p>
          </div>
          <button
            onClick={() => setShowCreateDrawer(true)}
            className="btn-primary"
          >
            <i className="fas fa-plus mr-2"></i>
            新建项目
          </button>
        </div>

        {/* 项目列表 */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <i className="fas fa-spinner fa-spin text-2xl text-gray-400"></i>
          </div>
        ) : tenants.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <i className="fas fa-folder-open text-2xl text-gray-400"></i>
            </div>
            <h3 className="text-lg font-medium text-gray-900 mb-2">暂无项目</h3>
            <p className="text-gray-500 mb-6">创建您的第一个项目开始管理数据库</p>
            <button
              onClick={() => setShowCreateDrawer(true)}
              className="btn-primary"
            >
              <i className="fas fa-plus mr-2"></i>
              新建项目
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {tenants.map((tenant) => (
              <div
                key={tenant.id}
                className="bg-white rounded-xl border border-gray-200 hover:border-blue-300 hover:shadow-lg transition-all duration-200 overflow-hidden group"
              >
                <div className="p-6">
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center space-x-3">
                      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                        tenant.is_active 
                          ? 'bg-gradient-to-br from-blue-500 to-blue-600' 
                          : 'bg-gray-300'
                      }`}>
                        <i className="fas fa-database text-white"></i>
                      </div>
                      <div>
                        <h3 className="font-semibold text-gray-900">{tenant.name}</h3>
                        <p className="text-sm text-gray-500">{tenant.slug}</p>
                      </div>
                    </div>
                    <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                      tenant.is_active 
                        ? 'bg-green-100 text-green-700' 
                        : 'bg-gray-100 text-gray-600'
                    }`}>
                      {tenant.is_active ? '活跃' : '停用'}
                    </span>
                  </div>

                  <div className="space-y-2 text-sm text-gray-600 mb-4">
                    <div className="flex items-center space-x-2">
                      <i className="fas fa-server w-4 text-gray-400"></i>
                      <span>{tenant.db_host}:{tenant.db_port}</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <i className="fas fa-database w-4 text-gray-400"></i>
                      <span>{tenant.db_name}</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <i className="fas fa-user w-4 text-gray-400"></i>
                      <span>{tenant.db_user}</span>
                    </div>
                    {replicaCounts[tenant.id] > 0 && (
                      <div className="flex items-center space-x-2 text-purple-700">
                        <i className="fas fa-project-diagram w-4 text-purple-400"></i>
                        <span className="text-xs">
                          {replicaCounts[tenant.id]} 个只读副本
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center justify-between pt-4 border-t border-gray-100">
                    <span className="text-xs text-gray-400">
                      创建于 {new Date(tenant.created_at).toLocaleDateString()}
                    </span>
                    <div className="flex items-center space-x-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          openEditDrawer(tenant)
                        }}
                        className="p-2 text-gray-400 hover:text-blue-500 transition-colors"
                        title="编辑项目"
                      >
                        <i className="fas fa-pen text-sm"></i>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDeleteTenant(tenant)
                        }}
                        className="p-2 text-gray-400 hover:text-red-500 transition-colors"
                        title="删除项目"
                      >
                        <i className="fas fa-trash text-sm"></i>
                      </button>
                      <button
                        onClick={() => enterWorkspace(tenant)}
                        className="px-4 py-2 bg-blue-500 text-white text-sm font-medium rounded-lg hover:bg-blue-600 transition-colors"
                      >
                        进入工作区
                        <i className="fas fa-arrow-right ml-2"></i>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

      {/* 创建项目抽屉 */}
      <Drawer
        isOpen={showCreateDrawer}
        onClose={() => setShowCreateDrawer(false)}
        title="新建项目"
        size="md"
        footer={
          <div className="flex gap-3">
            <button
              onClick={() => setShowCreateDrawer(false)}
              className="flex-1 h-11 px-5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-all"
            >
              取消
            </button>
            <button
              onClick={handleCreateTenant}
              disabled={creating || !newTenant.name.trim() || !newTenant.slug.trim()}
              className="flex-1 h-11 px-5 text-sm font-medium text-white bg-gradient-to-r from-blue-500 to-blue-600 rounded-lg hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center"
            >
              {creating ? (
                <>
                  <i className="fas fa-spinner fa-spin mr-2"></i>
                  创建中...
                </>
              ) : (
                <>
                  <i className="fas fa-plus mr-2"></i>
                  创建项目
                </>
              )}
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              项目名称 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={newTenant.name}
              onChange={(e) => setNewTenant({ ...newTenant, name: e.target.value })}
              placeholder="例如：电商系统"
              className="w-full input-base"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              项目标识 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={newTenant.slug}
              onChange={(e) => setNewTenant({ ...newTenant, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
              placeholder="例如：ecommerce"
              className="w-full input-base"
            />
            <p className="text-xs text-gray-500 mt-1">只允许小写字母、数字和连字符</p>
          </div>

          <hr className="border-gray-200" />

          <h4 className="text-sm font-semibold text-gray-900">数据库配置</h4>

          {/* 数据库模式选择 */}
          <div className="flex gap-3 p-1 bg-gray-100 rounded-lg">
            <button
              type="button"
              onClick={() => setNewTenant({ ...newTenant, create_database: false })}
              className={`flex-1 py-2.5 px-4 text-sm font-medium rounded-md transition-all ${
                !newTenant.create_database
                  ? 'bg-white text-blue-600 shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              <i className="fas fa-link mr-2"></i>
              连接现有数据库
            </button>
            <button
              type="button"
              onClick={() => setNewTenant({ ...newTenant, create_database: true, db_name: '' })}
              className={`flex-1 py-2.5 px-4 text-sm font-medium rounded-md transition-all ${
                newTenant.create_database
                  ? 'bg-white text-green-600 shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              <i className="fas fa-plus-circle mr-2"></i>
              创建新数据库
            </button>
          </div>

          {newTenant.create_database && (
            <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
              <p className="text-sm text-green-700">
                <i className="fas fa-info-circle mr-2"></i>
                系统将在指定服务器上创建新数据库，数据库名默认为 <code className="bg-green-100 px-1 rounded">project_{newTenant.slug || 'xxx'}</code>
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">主机地址</label>
              <input
                type="text"
                value={newTenant.db_host}
                onChange={(e) => setNewTenant({ ...newTenant, db_host: e.target.value })}
                placeholder="localhost"
                className="w-full input-base"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">端口</label>
              <input
                type="text"
                value={newTenant.db_port}
                onChange={(e) => setNewTenant({ ...newTenant, db_port: e.target.value })}
                placeholder="5432"
                className="w-full input-base"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              数据库名称 {!newTenant.create_database && <span className="text-red-500">*</span>}
            </label>
            <input
              type="text"
              value={newTenant.db_name}
              onChange={(e) => setNewTenant({ ...newTenant, db_name: e.target.value })}
              placeholder={newTenant.create_database ? `留空则自动生成 tenant_${newTenant.slug || 'xxx'}` : '请输入现有数据库名称'}
              className="w-full input-base"
            />
            {newTenant.create_database && (
              <p className="text-xs text-gray-500 mt-1">留空将自动使用项目标识生成数据库名</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">用户名</label>
            <input
              type="text"
              value={newTenant.db_user}
              onChange={(e) => setNewTenant({ ...newTenant, db_user: e.target.value })}
              placeholder="postgres"
              className="w-full input-base"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">密码</label>
            <input
              type="password"
              value={newTenant.db_password}
              onChange={(e) => setNewTenant({ ...newTenant, db_password: e.target.value })}
              placeholder="••••••••"
              className="w-full input-base"
            />
          </div>
        </div>
      </Drawer>

      {/* 编辑项目抽屉 */}
      <Drawer
        isOpen={!!editingTenant}
        onClose={closeEditDrawer}
        title={editingTenant ? `编辑项目：${editingTenant.name}` : '编辑项目'}
        size="md"
        footer={
          <div className="flex gap-3">
            <button
              onClick={closeEditDrawer}
              className="flex-1 h-11 px-5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-all"
            >
              取消
            </button>
            <button
              onClick={handleUpdateTenant}
              disabled={updating || !editForm.name.trim()}
              className="flex-1 h-11 px-5 text-sm font-medium text-white bg-gradient-to-r from-blue-500 to-blue-600 rounded-lg hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center"
            >
              {updating ? (
                <>
                  <i className="fas fa-spinner fa-spin mr-2"></i>
                  保存中...
                </>
              ) : (
                <>
                  <i className="fas fa-save mr-2"></i>
                  保存修改
                </>
              )}
            </button>
          </div>
        }
      >
        {editingTenant && (
          <div className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                项目名称 <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                className="w-full input-base"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">项目标识</label>
              <input
                type="text"
                value={editingTenant.slug}
                disabled
                className="w-full input-base bg-gray-50 text-gray-500 cursor-not-allowed"
              />
              <p className="text-xs text-gray-500 mt-1">项目标识创建后不可修改</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">联系邮箱</label>
              <input
                type="email"
                value={editForm.contact_email}
                onChange={(e) => setEditForm({ ...editForm, contact_email: e.target.value })}
                placeholder="可选"
                className="w-full input-base"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">状态</label>
              <div className="flex gap-3 p-1 bg-gray-100 rounded-lg">
                <button
                  type="button"
                  onClick={() => setEditForm({ ...editForm, status: 'active' })}
                  className={`flex-1 py-2.5 px-4 text-sm font-medium rounded-md transition-all ${
                    editForm.status === 'active'
                      ? 'bg-white text-green-600 shadow-sm'
                      : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  <i className="fas fa-check-circle mr-2"></i>
                  活跃
                </button>
                <button
                  type="button"
                  onClick={() => setEditForm({ ...editForm, status: 'suspended' })}
                  className={`flex-1 py-2.5 px-4 text-sm font-medium rounded-md transition-all ${
                    editForm.status === 'suspended'
                      ? 'bg-white text-orange-600 shadow-sm'
                      : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  <i className="fas fa-pause-circle mr-2"></i>
                  停用
                </button>
              </div>
            </div>

            {editingTenant.database_id ? (
              <>
                <hr className="border-gray-200" />
                <h4 className="text-sm font-semibold text-gray-900">主数据库连接</h4>
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
                  <p className="text-sm text-amber-700">
                    <i className="fas fa-exclamation-triangle mr-2"></i>
                    修改数据库连接信息会失效现有连接池，正在使用该项目的会话需要重新发起请求。
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">主机地址</label>
                    <input
                      type="text"
                      value={editForm.db_host}
                      onChange={(e) => setEditForm({ ...editForm, db_host: e.target.value })}
                      className="w-full input-base"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">端口</label>
                    <input
                      type="text"
                      value={editForm.db_port}
                      onChange={(e) => setEditForm({ ...editForm, db_port: e.target.value })}
                      className="w-full input-base"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">数据库名称</label>
                  <input
                    type="text"
                    value={editForm.db_name}
                    onChange={(e) => setEditForm({ ...editForm, db_name: e.target.value })}
                    className="w-full input-base"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">用户名</label>
                  <input
                    type="text"
                    value={editForm.db_user}
                    onChange={(e) => setEditForm({ ...editForm, db_user: e.target.value })}
                    className="w-full input-base"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">密码</label>
                  <input
                    type="password"
                    value={editForm.db_password}
                    onChange={(e) => setEditForm({ ...editForm, db_password: e.target.value })}
                    placeholder="留空则保持不变"
                    className="w-full input-base"
                  />
                  <p className="text-xs text-gray-500 mt-1">仅当填写新密码时才会更新</p>
                </div>

                {/* —— 只读副本（读流量横向扩展）—— */}
                <hr className="border-gray-200" />
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                      <i className="fas fa-project-diagram text-purple-500"></i>
                      只读副本（读流量横向扩展）
                    </h4>
                    <p className="text-xs text-gray-500 mt-1">
                      写请求始终走主连接；读请求按副本权重在所有活跃副本之间轮询。增删副本会增量生效，不打断主库连接。
                    </p>
                    <p className="text-[11px] text-gray-400 mt-1">
                      健康状态每 8 秒刷新一次；显示「非 standby」表示该机器并未处于 PG 流复制状态，读流量打过去会读不到主库新数据，请联系 DBA 重新搭建复制。
                    </p>
                    <p className="text-[11px] text-purple-500 mt-1">
                      紫色「已自动旁路」徽标 = 后端看护任务连续探活失败 / 延迟超阈值 / 非 standby，已临时把该副本从读路由中摘除；恢复健康会自动重新上线，无需手动操作，is_active 不受影响。
                    </p>
                  </div>
                  <span className="shrink-0 text-xs px-2 py-1 rounded-full bg-purple-50 text-purple-700 border border-purple-100">
                    {replicas.length} 个
                  </span>
                </div>

                {/* —— 拓扑示意图 —— */}
                {!replicasLoading && (
                  <div className="rounded-lg border border-gray-200 bg-gradient-to-br from-gray-50 to-white p-4">
                    <div className="flex items-start gap-4 overflow-x-auto">
                      {/* 写流量入口 */}
                      <div className="flex flex-col items-center gap-1 shrink-0 pt-3">
                        <span className="text-[10px] font-medium text-blue-600 uppercase tracking-wide">
                          写
                        </span>
                        <div className="w-8 h-1 bg-blue-300 rounded"></div>
                        <i className="fas fa-arrow-right text-blue-400 text-xs"></i>
                      </div>

                      {/* Primary 节点 */}
                      <div className="shrink-0 flex flex-col items-center">
                        <div className="px-3 py-2 rounded-lg border-2 border-yellow-400 bg-yellow-50 shadow-sm">
                          <div className="flex items-center gap-1.5">
                            <i className="fas fa-crown text-yellow-600 text-xs"></i>
                            <span className="text-xs font-semibold text-yellow-900">
                              Primary
                            </span>
                          </div>
                          <div className="text-[11px] text-yellow-800 mt-0.5 font-mono">
                            {editForm.db_host || '—'}:{editForm.db_port}
                          </div>
                        </div>
                        <div className="text-[10px] text-gray-500 mt-1">读+写</div>
                      </div>

                      {/* 分叉 + 副本节点 */}
                      {replicas.length > 0 && (
                        <>
                          <div className="flex flex-col items-center gap-1 shrink-0 pt-3">
                            <span className="text-[10px] font-medium text-purple-600 uppercase tracking-wide">
                              读
                            </span>
                            <div className="w-8 h-1 bg-purple-300 rounded"></div>
                            <i className="fas fa-code-branch text-purple-400 text-xs"></i>
                          </div>

                          <div className="flex gap-2 flex-wrap min-w-0">
                            {replicas.map((r) => {
                              const h = replicaHealth[r.id]
                              const cls = classifyHealth(h)
                              return (
                                <div
                                  key={r.id}
                                  className={`shrink-0 flex flex-col items-center ${
                                    r.is_active ? '' : 'opacity-50'
                                  }`}
                                >
                                  <div
                                    className={`relative px-3 py-2 rounded-lg border-2 shadow-sm ${
                                      r.is_active
                                        ? 'border-purple-300 bg-purple-50'
                                        : 'border-gray-300 bg-gray-100'
                                    }`}
                                    title={cls.tooltip}
                                  >
                                    {/* 健康圆点 */}
                                    <span
                                      className={`absolute -top-1 -right-1 inline-flex w-2.5 h-2.5 rounded-full ring-2 ring-white ${HEALTH_DOT_CLASS[cls.level]}`}
                                    >
                                      {cls.level === 'healthy' && (
                                        <span className="absolute inset-0 rounded-full bg-green-400 animate-ping opacity-50"></span>
                                      )}
                                    </span>
                                    <div className="flex items-center gap-1.5">
                                      <i
                                        className={`fas fa-copy text-xs ${
                                          r.is_active ? 'text-purple-500' : 'text-gray-400'
                                        }`}
                                      ></i>
                                      <span
                                        className={`text-xs font-medium ${
                                          r.is_active ? 'text-purple-900' : 'text-gray-600'
                                        }`}
                                      >
                                        {r.connection_name}
                                      </span>
                                    </div>
                                    <div
                                      className={`text-[11px] mt-0.5 font-mono ${
                                        r.is_active ? 'text-purple-800' : 'text-gray-500'
                                      }`}
                                    >
                                      {r.db_host}:{r.db_port}
                                    </div>
                                  </div>
                                  <div className="text-[10px] text-gray-500 mt-1 text-center">
                                    <div>
                                      权重 {r.weight}
                                      {!r.is_active && '（停用）'}
                                    </div>
                                    <div
                                      className={`mt-0.5 ${
                                        cls.level === 'healthy'
                                          ? 'text-green-600'
                                          : cls.level === 'warn'
                                          ? 'text-amber-700'
                                          : cls.level === 'critical' ||
                                            cls.level === 'misconfigured'
                                          ? 'text-red-600'
                                          : 'text-gray-400'
                                      }`}
                                    >
                                      {cls.label}
                                    </div>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        </>
                      )}

                      {replicas.length === 0 && (
                        <div className="self-center text-xs text-gray-400 italic shrink-0 pt-2">
                          暂无副本 → 读写都落到 Primary
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {replicasLoading ? (
                  <div className="py-4 text-center text-sm text-gray-400">
                    <i className="fas fa-spinner fa-spin mr-2"></i>加载副本中…
                  </div>
                ) : replicas.length === 0 ? (
                  <div className="p-3 bg-gray-50 border border-dashed border-gray-300 rounded-lg text-sm text-gray-500">
                    暂无副本。添加副本后，所有读请求会在主库与副本之间轮询，从而把读流量横向扩展到多台机器。
                  </div>
                ) : (
                  <div className="space-y-2">
                    {replicas.map((r) => {
                      const isEditing = editingReplicaId === r.id
                      return (
                        <div
                          key={r.id}
                          className={`border rounded-lg p-3 ${
                            r.is_active ? 'border-gray-200 bg-white' : 'border-gray-200 bg-gray-50'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-medium text-gray-900 truncate">
                                  {r.connection_name}
                                </span>
                                <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-700">
                                  Replica
                                </span>
                                {!r.is_active && (
                                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                                    已停用
                                  </span>
                                )}
                                <span className="text-[11px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-100">
                                  权重 {r.weight}
                                </span>
                                {(() => {
                                  const cls = classifyHealth(replicaHealth[r.id])
                                  return (
                                    <span
                                      title={cls.tooltip}
                                      className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border ${HEALTH_BADGE_CLASS[cls.level]}`}
                                    >
                                      <span
                                        className={`inline-block w-1.5 h-1.5 rounded-full ${HEALTH_DOT_CLASS[cls.level]}`}
                                      ></span>
                                      {cls.label}
                                    </span>
                                  )
                                })()}
                              </div>

                              {isEditing ? (
                                <div className="mt-2 grid grid-cols-2 gap-2">
                                  <input
                                    type="text"
                                    value={replicaPatch.db_host}
                                    onChange={(e) => setReplicaPatch({ ...replicaPatch, db_host: e.target.value })}
                                    placeholder="主机"
                                    className="input-base text-sm"
                                  />
                                  <input
                                    type="text"
                                    value={replicaPatch.db_port}
                                    onChange={(e) => setReplicaPatch({ ...replicaPatch, db_port: e.target.value })}
                                    placeholder="端口"
                                    className="input-base text-sm"
                                  />
                                  <input
                                    type="number"
                                    min={1}
                                    max={1000}
                                    value={replicaPatch.weight}
                                    onChange={(e) => setReplicaPatch({ ...replicaPatch, weight: e.target.value })}
                                    placeholder="权重"
                                    className="input-base text-sm"
                                  />
                                  <input
                                    type="password"
                                    value={replicaPatch.db_password}
                                    onChange={(e) => setReplicaPatch({ ...replicaPatch, db_password: e.target.value })}
                                    placeholder="新密码（留空不改）"
                                    className="input-base text-sm"
                                  />
                                </div>
                              ) : (
                                <p className="mt-1 text-xs text-gray-500 font-mono break-all">
                                  {r.db_host}:{r.db_port} · {r.db_user}@{r.db_name}
                                </p>
                              )}
                            </div>

                            <div className="flex flex-col items-end gap-1 shrink-0">
                              {isEditing ? (
                                <>
                                  <button
                                    onClick={() => handleSaveReplicaPatch(r.id)}
                                    className="text-xs px-2 py-1 rounded bg-blue-500 text-white hover:bg-blue-600"
                                  >
                                    <i className="fas fa-check mr-1"></i>保存
                                  </button>
                                  <button
                                    onClick={() => setEditingReplicaId(null)}
                                    className="text-xs px-2 py-1 rounded text-gray-600 hover:bg-gray-100"
                                  >
                                    取消
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    onClick={() => beginEditReplica(r)}
                                    className="text-xs px-2 py-1 rounded text-gray-600 hover:bg-gray-100"
                                    title="编辑"
                                  >
                                    <i className="fas fa-pen mr-1"></i>编辑
                                  </button>
                                  <button
                                    onClick={() => handleToggleReplica(r)}
                                    className={`text-xs px-2 py-1 rounded ${
                                      r.is_active
                                        ? 'text-yellow-700 hover:bg-yellow-50'
                                        : 'text-green-700 hover:bg-green-50'
                                    }`}
                                  >
                                    {r.is_active ? '停用' : '启用'}
                                  </button>
                                  <button
                                    onClick={() => handleDeleteReplica(r)}
                                    className="text-xs px-2 py-1 rounded text-red-600 hover:bg-red-50"
                                  >
                                    <i className="fas fa-trash mr-1"></i>删除
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {!showReplicaForm ? (
                  <button
                    type="button"
                    onClick={() => {
                      setShowReplicaForm(true)
                      setReplicaForm({
                        connection_name: `${editingTenant.slug}_replica_${replicas.length + 1}`,
                        db_host: '',
                        db_port: '5432',
                        db_name: editForm.db_name,
                        db_user: editForm.db_user,
                        db_password: '',
                        weight: '1',
                      })
                    }}
                    className="w-full h-10 text-sm font-medium text-purple-700 bg-purple-50 hover:bg-purple-100 border border-purple-200 rounded-lg flex items-center justify-center gap-2"
                  >
                    <i className="fas fa-plus"></i>
                    添加只读副本
                  </button>
                ) : (
                  <div className="rounded-lg border border-purple-200 bg-purple-50/50 p-4 space-y-3">
                    <h5 className="text-sm font-semibold text-purple-800">
                      <i className="fas fa-plus-circle mr-1.5"></i>
                      新增副本
                    </h5>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        副本名称 <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={replicaForm.connection_name}
                        onChange={(e) => setReplicaForm({ ...replicaForm, connection_name: e.target.value })}
                        className="w-full input-base text-sm"
                        placeholder="例如：生产-replica-1"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          主机 <span className="text-red-500">*</span>
                        </label>
                        <input
                          type="text"
                          value={replicaForm.db_host}
                          onChange={(e) => setReplicaForm({ ...replicaForm, db_host: e.target.value })}
                          className="w-full input-base text-sm"
                          placeholder="例如：10.0.5.34"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">端口</label>
                        <input
                          type="text"
                          value={replicaForm.db_port}
                          onChange={(e) => setReplicaForm({ ...replicaForm, db_port: e.target.value })}
                          className="w-full input-base text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">数据库名</label>
                        <input
                          type="text"
                          value={replicaForm.db_name}
                          onChange={(e) => setReplicaForm({ ...replicaForm, db_name: e.target.value })}
                          className="w-full input-base text-sm"
                          placeholder={`留空沿用主库 ${editForm.db_name}`}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">用户名</label>
                        <input
                          type="text"
                          value={replicaForm.db_user}
                          onChange={(e) => setReplicaForm({ ...replicaForm, db_user: e.target.value })}
                          className="w-full input-base text-sm"
                          placeholder={`留空沿用主库 ${editForm.db_user}`}
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="block text-xs font-medium text-gray-700 mb-1">密码</label>
                        <input
                          type="password"
                          value={replicaForm.db_password}
                          onChange={(e) => setReplicaForm({ ...replicaForm, db_password: e.target.value })}
                          className="w-full input-base text-sm"
                          placeholder="留空沿用主库密码（流复制场景常用）"
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          负载权重
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={1000}
                          value={replicaForm.weight}
                          onChange={(e) => setReplicaForm({ ...replicaForm, weight: e.target.value })}
                          className="w-full input-base text-sm"
                        />
                        <p className="text-[11px] text-gray-500 mt-1">
                          数值越大被分配到的读请求越多。权重已对接后端加权轮询，1 个副本权重 2 相当于 2 个权重 1 副本。
                        </p>
                      </div>
                    </div>

                    {replicaTestResult && (
                      <div
                        className={`p-2.5 rounded-md text-xs border ${
                          replicaTestResult.success
                            ? 'bg-green-50 border-green-200 text-green-800'
                            : 'bg-red-50 border-red-200 text-red-800'
                        }`}
                      >
                        <i
                          className={`fas ${
                            replicaTestResult.success
                              ? 'fa-check-circle text-green-600'
                              : 'fa-times-circle text-red-600'
                          } mr-1.5`}
                        ></i>
                        {replicaTestResult.message}
                        {replicaTestResult.server_version && (
                          <span className="ml-2 opacity-70">
                            ({replicaTestResult.server_version})
                          </span>
                        )}
                      </div>
                    )}

                    <div className="flex gap-2 pt-1">
                      <button
                        type="button"
                        onClick={resetReplicaForm}
                        className="h-9 px-3 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        onClick={handleTestReplicaConnection}
                        disabled={testingReplica}
                        className="h-9 px-3 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1.5"
                      >
                        {testingReplica ? (
                          <>
                            <i className="fas fa-spinner fa-spin"></i>测试中…
                          </>
                        ) : (
                          <>
                            <i className="fas fa-plug"></i>测试连接
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={handleAddReplica}
                        disabled={savingReplica}
                        className="flex-1 h-9 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700 disabled:opacity-50 flex items-center justify-center gap-1.5"
                      >
                        {savingReplica ? (
                          <>
                            <i className="fas fa-spinner fa-spin"></i>添加中…
                          </>
                        ) : (
                          <>
                            <i className="fas fa-save"></i>保存副本
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg">
                <p className="text-sm text-gray-600">
                  <i className="fas fa-info-circle mr-2"></i>
                  该项目尚未配置数据库连接，配置主连接后即可在此处添加只读副本进行读流量横向扩展。
                </p>
              </div>
            )}
          </div>
        )}
      </Drawer>
    </div>
  )
}

