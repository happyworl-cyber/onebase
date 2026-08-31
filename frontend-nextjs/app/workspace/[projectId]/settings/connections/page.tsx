'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { useAppStore } from '@/lib/store'
import { tenantAPI } from '@/lib/api'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'
import {
  DEFAULT_TENANT_ACQUIRE_TIMEOUT_SECS,
  DEFAULT_TENANT_MAX_CONNECTIONS,
  TENANT_MAX_CONNECTIONS_CAP,
  TenantPoolSettingsForm,
} from '@/components/TenantPoolSettings'

export default function ConnectionsPage() {
  // W2：项目维度的连接管理。tenant_id 来自 URL 而不再来自 currentTenant
  // （工作空间下 currentTenant 是 null）。currentConnection 已由
  // workspace 层从 primary_connection 铺好，本页负责给用户列出 / 新建 / 切换。
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const caps = useCurrentProjectCapabilities()

  const { userConnections, setUserConnections, currentConnection, setCurrentConnection } = useAppStore()
  const [showForm, setShowForm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [testingConnection, setTestingConnection] = useState(false)
  const [testResult, setTestResult] = useState<any>(null)
  const [updatingId, setUpdatingId] = useState<number | null>(null)

  // 编辑连接弹窗：项目 owner/admin 可改名称 / slug / 实际连接目标（host/port/db/user/password）。
  const [editConn, setEditConn] = useState<any>(null)
  const [editForm, setEditForm] = useState({
    connection_name: '',
    slug: '',
    db_host: '',
    db_port: 5432,
    db_name: '',
    db_user: '',
    db_password: '',
    max_connections: DEFAULT_TENANT_MAX_CONNECTIONS,
    connection_timeout: DEFAULT_TENANT_ACQUIRE_TIMEOUT_SECS,
  })
  const [editTestResult, setEditTestResult] = useState<any>(null)
  const [editTesting, setEditTesting] = useState(false)
  const [editSaving, setEditSaving] = useState(false)
  const [poolConn, setPoolConn] = useState<any>(null)

  const [formData, setFormData] = useState({
    tenant_id: projectId,
    connection_name: '',
    slug: '',
    db_host: 'localhost',
    db_port: 5432,
    db_name: '',
    db_user: 'postgres',
    db_password: '',
    is_primary: false,
    db_role: 'primary' as 'primary' | 'replica',
    primary_id: null as number | null,
    max_connections: DEFAULT_TENANT_MAX_CONNECTIONS,
    connection_timeout: DEFAULT_TENANT_ACQUIRE_TIMEOUT_SECS,
  })

  useEffect(() => {
    if (!isNaN(projectId)) loadConnections()
  }, [projectId])

  const loadConnections = async () => {
    setLoading(true)
    try {
      const response = await tenantAPI.getMyConnections(projectId)
      const connections = Array.isArray(response.data) ? response.data : []
      // 防御性过滤：只显示本项目的连接
      const filtered = connections.filter((c: any) => c.tenant_id === projectId)
      setUserConnections(filtered)
    } catch (err: any) {
      console.error('加载连接失败:', err)
      alert('加载连接失败: ' + (err.response?.data?.error || err.message))
    } finally {
      setLoading(false)
    }
  }

  if (!caps.canManageProjectSettings) {
    return (
      <ForbiddenPlaceholder reason="连接管理需要 owner / admin / 超管 角色" />
    )
  }

  const handleTestConnection = async () => {
    if (!formData.db_name || !formData.db_user || !formData.db_password) {
      alert('请填写完整的连接信息')
      return
    }
    setTestingConnection(true)
    setTestResult(null)
    try {
      const response = await tenantAPI.testConnection({
        host: formData.db_host,
        port: formData.db_port,
        database: formData.db_name,
        username: formData.db_user,
        password: formData.db_password,
      })
      setTestResult(response.data)
    } catch (err: any) {
      setTestResult({
        success: false,
        message: err.response?.data?.error || err.message || '测试失败',
      })
    } finally {
      setTestingConnection(false)
    }
  }

  const resetForm = () => {
    setFormData({
      tenant_id: projectId,
      connection_name: '',
      slug: '',
      db_host: 'localhost',
      db_port: 5432,
      db_name: '',
      db_user: 'postgres',
      db_password: '',
      is_primary: false,
      db_role: 'primary',
      primary_id: null,
      max_connections: DEFAULT_TENANT_MAX_CONNECTIONS,
      connection_timeout: DEFAULT_TENANT_ACQUIRE_TIMEOUT_SECS,
    })
    setTestResult(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.connection_name || !formData.db_name) {
      alert('请填写连接名称和数据库名')
      return
    }
    if (formData.db_role === 'replica' && !formData.primary_id) {
      alert('Replica 必须选择对应的 Primary 连接')
      return
    }
    setLoading(true)
    try {
      await tenantAPI.createConnection(formData)
      alert('连接创建成功！')
      setShowForm(false)
      resetForm()
      loadConnections()
    } catch (err: any) {
      console.error('创建连接失败:', err)
      alert('创建连接失败: ' + (err.response?.data?.error || err.message))
    } finally {
      setLoading(false)
    }
  }

  const handleUseConnection = async (databaseId: number) => {
    try {
      await tenantAPI.switchConnection(databaseId)
      const conn = userConnections.find((c: any) => c.database_id === databaseId)
      if (conn) setCurrentConnection(conn)
      alert('已切换到该连接')
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('connection-changed'))
      }
    } catch (err: any) {
      console.error('切换连接失败:', err)
      alert('切换连接失败: ' + (err.response?.data?.error || err.message))
    }
  }

  const handleDeleteConnection = async (conn: any) => {
    const label = conn.connection_name || conn.database_slug || conn.database_id
    if (!window.confirm(`确定要删除连接「${label}」吗？此操作不可恢复。`)) return
    setUpdatingId(conn.database_id)
    try {
      await tenantAPI.deleteConnection(conn.database_slug || conn.database_id)
      if (currentConnection?.database_id === conn.database_id) {
        setCurrentConnection(null)
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event('connection-changed'))
        }
      }
      await loadConnections()
      alert('连接已删除')
    } catch (err: any) {
      alert('删除失败: ' + (err.response?.data?.error || err.message))
    } finally {
      setUpdatingId(null)
    }
  }

  const handleMoveConnection = async (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= primaryConnections.length) return
    const reordered = [...primaryConnections]
    ;[reordered[index], reordered[target]] = [reordered[target], reordered[index]]
    // 乐观更新：立即反映新顺序（保留副本），失败再回滚重载。
    const replicasFlat = userConnections.filter((c: any) => c.db_role === 'replica')
    setUserConnections([...reordered, ...replicasFlat])
    try {
      await tenantAPI.reorderConnections(projectId, reordered.map((c: any) => c.database_id))
    } catch (err: any) {
      alert('调整顺序失败: ' + (err.response?.data?.error || err.message))
      await loadConnections()
    }
  }

  const openEditModal = (conn: any) => {
    setEditConn(conn)
    setEditForm({
      connection_name: conn.connection_name || '',
      slug: conn.database_slug || '',
      db_host: conn.db_host || 'localhost',
      db_port: conn.db_port || 5432,
      db_name: conn.db_name || '',
      db_user: conn.db_user || 'postgres',
      db_password: '',
      max_connections: conn.max_connections || DEFAULT_TENANT_MAX_CONNECTIONS,
      connection_timeout: conn.connection_timeout || DEFAULT_TENANT_ACQUIRE_TIMEOUT_SECS,
    })
    setEditTestResult(null)
  }

  const handleEditTest = async () => {
    if (!editForm.db_name || !editForm.db_user || !editForm.db_password) {
      alert('请填写数据库名、用户名和密码后再测试（测试需要明文密码）')
      return
    }
    setEditTesting(true)
    setEditTestResult(null)
    try {
      const response = await tenantAPI.testConnection({
        host: editForm.db_host,
        port: editForm.db_port,
        database: editForm.db_name,
        username: editForm.db_user,
        password: editForm.db_password,
      })
      setEditTestResult(response.data)
    } catch (err: any) {
      setEditTestResult({
        success: false,
        message: err.response?.data?.error || err.message || '测试失败',
      })
    } finally {
      setEditTesting(false)
    }
  }

  const handleEditSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editConn) return
    if (!editForm.connection_name.trim() || !editForm.slug.trim()) {
      alert('连接名称和 Slug 不能为空')
      return
    }
    if (!editForm.db_host.trim() || !editForm.db_name.trim() || !editForm.db_user.trim()) {
      alert('主机、数据库名、用户名不能为空')
      return
    }
    setEditSaving(true)
    setUpdatingId(editConn.database_id)
    try {
      await tenantAPI.updateConnection(editConn.database_slug || editConn.database_id, {
        connection_name: editForm.connection_name.trim(),
        slug: editForm.slug.trim().toLowerCase(),
        db_host: editForm.db_host.trim(),
        db_port: editForm.db_port,
        db_name: editForm.db_name.trim(),
        db_user: editForm.db_user.trim(),
        // 留空 = 不修改密码（后端 COALESCE 语义）
        ...(editForm.db_password ? { db_password: editForm.db_password } : {}),
        max_connections: editForm.max_connections,
        connection_timeout: editForm.connection_timeout,
      })
      setEditConn(null)
      await loadConnections()
      alert('连接已更新')
    } catch (err: any) {
      alert('更新失败: ' + (err.response?.data?.error || err.message))
    } finally {
      setEditSaving(false)
      setUpdatingId(null)
    }
  }

  const primaryConnections = userConnections.filter((c: any) => !c.db_role || c.db_role === 'primary')
  const getReplicasFor = (primaryId: number) =>
    userConnections.filter((c: any) => c.db_role === 'replica' && c.primary_id === primaryId)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">数据库连接</h1>
          <p className="text-sm text-gray-500 mt-1">管理主从数据库连接配置</p>
        </div>
        <button
          onClick={() => { setShowForm(!showForm); if (showForm) resetForm(); }}
          className="btn-primary"
        >
          <i className={`fas ${showForm ? 'fa-times' : 'fa-plus'} text-xs mr-2`}></i>
          {showForm ? '取消' : '添加连接'}
        </button>
      </div>

      {currentConnection && (
        <div className="card p-4 bg-blue-50 border-blue-200">
          <div className="flex items-start space-x-3">
            <i className="fas fa-info-circle text-blue-500 mt-0.5"></i>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-blue-900 mb-1">当前连接</h3>
              <p className="text-sm text-blue-700">
                项目：<span className="font-medium">{currentConnection.tenant_name}</span>
                {' / '}
                连接：<span className="font-medium">{currentConnection.connection_name}</span>
              </p>
              <p className="text-xs text-blue-600 mt-1">
                {currentConnection.db_host}:{currentConnection.db_port}/{currentConnection.db_name}
                {' · '}
                连接池 {currentConnection.max_connections ?? DEFAULT_TENANT_MAX_CONNECTIONS}
                {' · '}
                获取超时 {currentConnection.connection_timeout ?? DEFAULT_TENANT_ACQUIRE_TIMEOUT_SECS}s
              </p>
            </div>
          </div>
        </div>
      )}

      {showForm && (
        <div className="card p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">添加新连接</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* 角色选择 */}
            <div className="flex items-center space-x-6 p-3 bg-gray-50 rounded-lg">
              <span className="text-sm font-medium text-gray-700">连接角色：</span>
              <label className="flex items-center space-x-2 cursor-pointer">
                <input
                  type="radio"
                  name="db_role"
                  value="primary"
                  checked={formData.db_role === 'primary'}
                  onChange={() => setFormData({ ...formData, db_role: 'primary', primary_id: null })}
                  className="text-blue-600"
                />
                <span className="text-sm text-gray-700">
                  <i className="fas fa-crown text-yellow-500 mr-1"></i>Primary（主库）
                </span>
              </label>
              <label className="flex items-center space-x-2 cursor-pointer">
                <input
                  type="radio"
                  name="db_role"
                  value="replica"
                  checked={formData.db_role === 'replica'}
                  onChange={() => setFormData({ ...formData, db_role: 'replica', is_primary: false })}
                  className="text-blue-600"
                />
                <span className="text-sm text-gray-700">
                  <i className="fas fa-copy text-gray-500 mr-1"></i>Replica（只读副本）
                </span>
              </label>
            </div>

            {formData.db_role === 'replica' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  绑定 Primary 连接 *
                </label>
                <select
                  value={formData.primary_id ?? ''}
                  onChange={(e) => setFormData({ ...formData, primary_id: e.target.value ? parseInt(e.target.value) : null })}
                  className="input-base w-full"
                  required
                >
                  <option value="">请选择主库连接</option>
                  {primaryConnections.map((c: any) => (
                    <option key={c.database_id} value={c.database_id}>
                      {c.connection_name} ({c.db_host}:{c.db_port}/{c.db_name})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">连接名称 *</label>
                <input
                  type="text"
                  value={formData.connection_name}
                  onChange={(e) => setFormData({ ...formData, connection_name: e.target.value })}
                  className="input-base w-full"
                  placeholder={formData.db_role === 'replica' ? '例如：生产数据库-replica-1' : '例如：生产数据库'}
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Slug（路由别名）</label>
                <input
                  type="text"
                  value={formData.slug}
                  onChange={(e) => setFormData({ ...formData, slug: e.target.value.toLowerCase() })}
                  className="input-base w-full"
                  placeholder="例如：myapp / crm-system"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">数据库名 *</label>
                <input
                  type="text"
                  value={formData.db_name}
                  onChange={(e) => setFormData({ ...formData, db_name: e.target.value })}
                  className="input-base w-full"
                  placeholder="例如：myapp_db"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">主机地址</label>
                <input
                  type="text"
                  value={formData.db_host}
                  onChange={(e) => setFormData({ ...formData, db_host: e.target.value })}
                  className="input-base w-full"
                  placeholder="localhost"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">端口</label>
                <input
                  type="number"
                  value={formData.db_port}
                  onChange={(e) => setFormData({ ...formData, db_port: parseInt(e.target.value) })}
                  className="input-base w-full"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">用户名 *</label>
                <input
                  type="text"
                  value={formData.db_user}
                  onChange={(e) => setFormData({ ...formData, db_user: e.target.value })}
                  className="input-base w-full"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">密码 *</label>
                <input
                  type="password"
                  value={formData.db_password}
                  onChange={(e) => setFormData({ ...formData, db_password: e.target.value })}
                  className="input-base w-full"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">最大连接数</label>
                <input
                  type="number"
                  value={formData.max_connections}
                  onChange={(e) => setFormData({ ...formData, max_connections: parseInt(e.target.value) })}
                  className="input-base w-full"
                  min="1"
                  max={TENANT_MAX_CONNECTIONS_CAP}
                />
                <p className="text-xs text-gray-400 mt-1">
                  建议 20–30。单次页面若并行打多个工作流，10 个连接很容易打满。上限 {TENANT_MAX_CONNECTIONS_CAP}。
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">连接超时（秒）</label>
                <input
                  type="number"
                  value={formData.connection_timeout}
                  onChange={(e) => setFormData({ ...formData, connection_timeout: parseInt(e.target.value) })}
                  className="input-base w-full"
                  min="1"
                  max="600"
                />
              </div>
            </div>

            {formData.db_role === 'primary' && (
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="is_primary"
                  checked={formData.is_primary}
                  onChange={(e) => setFormData({ ...formData, is_primary: e.target.checked })}
                  className="w-4 h-4 text-blue-600 rounded"
                />
                <label htmlFor="is_primary" className="ml-2 text-sm text-gray-700">
                  设为主连接（默认使用的数据库）
                </label>
              </div>
            )}

            {testResult && (
              <div className={`p-3 rounded-lg ${testResult.success ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                <div className="flex items-start space-x-2">
                  <i className={`fas ${testResult.success ? 'fa-check-circle text-green-600' : 'fa-times-circle text-red-600'} mt-0.5`}></i>
                  <div className="flex-1">
                    <p className={`text-sm font-medium ${testResult.success ? 'text-green-800' : 'text-red-800'}`}>
                      {testResult.message}
                    </p>
                    {testResult.server_version && (
                      <p className="text-xs text-green-600 mt-1">服务器版本: {testResult.server_version}</p>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="flex items-center space-x-3 pt-4 border-t">
              <button type="button" onClick={handleTestConnection} disabled={testingConnection} className="btn-default">
                <i className={`fas ${testingConnection ? 'fa-spinner fa-spin' : 'fa-plug'} text-xs mr-2`}></i>
                {testingConnection ? '测试中...' : '测试连接'}
              </button>
              <button type="submit" disabled={loading || !testResult?.success} className="btn-primary disabled:opacity-50">
                <i className={`fas ${loading ? 'fa-spinner fa-spin' : 'fa-save'} text-xs mr-2`}></i>
                {loading ? '保存中...' : '保存连接'}
              </button>
              <button type="button" onClick={() => { setShowForm(false); resetForm(); }} className="btn-default">
                取消
              </button>
            </div>
          </form>
        </div>
      )}

      {/* 连接列表 - 拓扑视图 */}
      <div className="space-y-4">
        {loading && userConnections.length === 0 ? (
          <div className="text-center py-12">
            <i className="fas fa-spinner fa-spin text-3xl text-gray-400 mb-3"></i>
            <p className="text-gray-500">加载中...</p>
          </div>
        ) : userConnections.length === 0 ? (
          <div className="text-center py-12">
            <i className="fas fa-database text-5xl text-gray-300 mb-4"></i>
            <p className="text-gray-500 mb-4">暂无数据库连接</p>
            <button onClick={() => setShowForm(true)} className="btn-primary">
              <i className="fas fa-plus text-xs mr-2"></i>
              添加第一个连接
            </button>
          </div>
        ) : (
          primaryConnections.map((conn: any, index: number) => {
            const replicas = getReplicasFor(conn.database_id)
            return (
              <div key={conn.database_id} className="space-y-2">
                {/* Primary 卡片 */}
                <div className={`card p-5 ${currentConnection?.database_id === conn.database_id ? 'ring-2 ring-blue-500' : ''}`}>
                  <div className="flex items-start justify-between">
                    <div className="flex items-start space-x-3">
                      <div className="w-10 h-10 bg-yellow-100 rounded-lg flex items-center justify-center flex-shrink-0">
                        <i className="fas fa-crown text-yellow-600"></i>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center space-x-2">
                          <h3 className="text-sm font-semibold text-gray-900 truncate">{conn.connection_name}</h3>
                          {conn.database_slug && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-indigo-50 text-indigo-700 font-mono">
                              {conn.database_slug}
                            </span>
                          )}
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800">
                            Primary
                          </span>
                          {conn.is_primary && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
                              <i className="fas fa-star text-xs mr-1"></i>默认
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">{conn.db_host}:{conn.db_port}/{conn.db_name}</p>
                        <p className="text-xs text-gray-600 mt-1">
                          连接池 {conn.max_connections ?? DEFAULT_TENANT_MAX_CONNECTIONS}
                          {' · '}
                          获取超时 {conn.connection_timeout ?? DEFAULT_TENANT_ACQUIRE_TIMEOUT_SECS}s
                        </p>
                        {replicas.length > 0 && (
                          <p className="text-xs text-green-600 mt-1">
                            <i className="fas fa-project-diagram mr-1"></i>
                            {replicas.length} 个只读副本
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex flex-col mr-1">
                        <button
                          onClick={() => handleMoveConnection(index, -1)}
                          disabled={index === 0}
                          title="上移"
                          className="px-2 py-0.5 rounded text-xs text-gray-500 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          <i className="fas fa-chevron-up"></i>
                        </button>
                        <button
                          onClick={() => handleMoveConnection(index, 1)}
                          disabled={index === primaryConnections.length - 1}
                          title="下移"
                          className="px-2 py-0.5 rounded text-xs text-gray-500 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          <i className="fas fa-chevron-down"></i>
                        </button>
                      </div>
                      <button
                        onClick={() => setPoolConn(conn)}
                        className="px-3 py-2 rounded-lg text-xs font-medium bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
                      >
                        连接池
                      </button>
                      <button
                        onClick={() => openEditModal(conn)}
                        disabled={updatingId === conn.database_id}
                        className="px-3 py-2 rounded-lg text-xs font-medium bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50"
                      >
                        {updatingId === conn.database_id ? '更新中...' : '编辑'}
                      </button>
                      <button
                        onClick={() => handleUseConnection(conn.database_id)}
                        disabled={currentConnection?.database_id === conn.database_id}
                        className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                          currentConnection?.database_id === conn.database_id
                            ? 'bg-blue-100 text-blue-700 cursor-default'
                            : 'bg-blue-600 text-white hover:bg-blue-700'
                        }`}
                      >
                        <i className={`fas ${currentConnection?.database_id === conn.database_id ? 'fa-check' : 'fa-plug'} text-xs mr-1`}></i>
                        {currentConnection?.database_id === conn.database_id ? '当前' : '使用'}
                      </button>
                      <button
                        onClick={() => handleDeleteConnection(conn)}
                        disabled={updatingId === conn.database_id}
                        title="删除连接"
                        className="px-3 py-2 rounded-lg text-xs font-medium bg-red-50 text-red-600 hover:bg-red-100 disabled:opacity-50"
                      >
                        <i className="fas fa-trash text-xs"></i>
                      </button>
                    </div>
                  </div>
                </div>

                {/* Replica 卡片列表 */}
                {replicas.length > 0 && (
                  <div className="ml-8 space-y-2 border-l-2 border-gray-200 pl-4">
                    {replicas.map((replica: any) => (
                      <div key={replica.database_id} className="card p-4 bg-gray-50">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-3">
                            <div className="w-8 h-8 bg-gray-200 rounded-lg flex items-center justify-center flex-shrink-0">
                              <i className="fas fa-copy text-gray-500 text-sm"></i>
                            </div>
                            <div>
                              <div className="flex items-center space-x-2">
                                <h4 className="text-sm font-medium text-gray-700">{replica.connection_name}</h4>
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-200 text-gray-600">
                                  Replica
                                </span>
                              </div>
                              <p className="text-xs text-gray-500">{replica.db_host}:{replica.db_port}</p>
                            </div>
                          </div>
                          <span className="text-xs text-green-600">
                            <i className="fas fa-circle text-xs mr-1"></i>只读
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* 编辑连接弹窗 */}
      {editConn && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setEditConn(null)}>
          <div className="absolute inset-0 bg-black/30" />
          <div
            className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-white rounded-xl shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-white border-b px-6 py-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">编辑数据库连接</h2>
                <p className="text-xs text-gray-500 mt-0.5">{editConn.connection_name}</p>
              </div>
              <button onClick={() => setEditConn(null)} className="text-gray-400 hover:text-gray-600">
                <i className="fas fa-times text-lg"></i>
              </button>
            </div>

            <form onSubmit={handleEditSave} className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">连接名称 *</label>
                  <input
                    type="text"
                    value={editForm.connection_name}
                    onChange={(e) => setEditForm({ ...editForm, connection_name: e.target.value })}
                    className="input-base w-full"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Slug（路由别名）*</label>
                  <input
                    type="text"
                    value={editForm.slug}
                    onChange={(e) => setEditForm({ ...editForm, slug: e.target.value.toLowerCase() })}
                    className="input-base w-full font-mono"
                    required
                  />
                  <p className="text-[11px] text-amber-600 mt-1">
                    <i className="fas fa-exclamation-triangle mr-1"></i>修改后 API / 工作流 URL 会变化
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">数据库名 *</label>
                  <input
                    type="text"
                    value={editForm.db_name}
                    onChange={(e) => setEditForm({ ...editForm, db_name: e.target.value })}
                    className="input-base w-full"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">主机地址 *</label>
                  <input
                    type="text"
                    value={editForm.db_host}
                    onChange={(e) => setEditForm({ ...editForm, db_host: e.target.value })}
                    className="input-base w-full"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">端口 *</label>
                  <input
                    type="number"
                    value={editForm.db_port}
                    onChange={(e) => setEditForm({ ...editForm, db_port: parseInt(e.target.value) || 0 })}
                    className="input-base w-full"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">用户名 *</label>
                  <input
                    type="text"
                    value={editForm.db_user}
                    onChange={(e) => setEditForm({ ...editForm, db_user: e.target.value })}
                    className="input-base w-full"
                    required
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">密码</label>
                  <input
                    type="password"
                    value={editForm.db_password}
                    onChange={(e) => setEditForm({ ...editForm, db_password: e.target.value })}
                    className="input-base w-full"
                    placeholder="留空表示不修改当前密码"
                    autoComplete="new-password"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">最大连接数</label>
                  <input
                    type="number"
                    value={editForm.max_connections}
                    onChange={(e) => setEditForm({ ...editForm, max_connections: parseInt(e.target.value) || 1 })}
                    className="input-base w-full"
                    min="1"
                    max={TENANT_MAX_CONNECTIONS_CAP}
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    建议 20–30。保存后立即重建该库连接池，无需重启服务。上限 {TENANT_MAX_CONNECTIONS_CAP}。
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">连接超时（秒）</label>
                  <input
                    type="number"
                    value={editForm.connection_timeout}
                    onChange={(e) => setEditForm({ ...editForm, connection_timeout: parseInt(e.target.value) || 1 })}
                    className="input-base w-full"
                    min="1"
                    max="600"
                  />
                </div>
              </div>

              {editTestResult && (
                <div className={`p-3 rounded-lg ${editTestResult.success ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                  <div className="flex items-start space-x-2">
                    <i className={`fas ${editTestResult.success ? 'fa-check-circle text-green-600' : 'fa-times-circle text-red-600'} mt-0.5`}></i>
                    <div className="flex-1">
                      <p className={`text-sm font-medium ${editTestResult.success ? 'text-green-800' : 'text-red-800'}`}>
                        {editTestResult.message}
                      </p>
                      {editTestResult.server_version && (
                        <p className="text-xs text-green-600 mt-1">服务器版本: {editTestResult.server_version}</p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <div className="flex items-center space-x-3 pt-4 border-t">
                <button type="button" onClick={handleEditTest} disabled={editTesting} className="btn-default">
                  <i className={`fas ${editTesting ? 'fa-spinner fa-spin' : 'fa-plug'} text-xs mr-2`}></i>
                  {editTesting ? '测试中...' : '测试连接'}
                </button>
                <button type="submit" disabled={editSaving} className="btn-primary disabled:opacity-50">
                  <i className={`fas ${editSaving ? 'fa-spinner fa-spin' : 'fa-save'} text-xs mr-2`}></i>
                  {editSaving ? '保存中...' : '保存修改'}
                </button>
                <button type="button" onClick={() => setEditConn(null)} className="btn-default">
                  取消
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {poolConn && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setPoolConn(null)}>
          <div className="absolute inset-0 bg-black/30" />
          <div
            className="relative w-full max-w-lg bg-white rounded-xl shadow-xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">连接池设置</h2>
                <p className="text-xs text-gray-500 mt-0.5">{poolConn.connection_name}</p>
              </div>
              <button onClick={() => setPoolConn(null)} className="text-gray-400 hover:text-gray-600">
                <i className="fas fa-times text-lg"></i>
              </button>
            </div>
            <TenantPoolSettingsForm
              databaseId={poolConn.database_id}
              databaseSlug={poolConn.database_slug || poolConn.database_id}
              initialMax={poolConn.max_connections || DEFAULT_TENANT_MAX_CONNECTIONS}
              initialTimeout={poolConn.connection_timeout || DEFAULT_TENANT_ACQUIRE_TIMEOUT_SECS}
              onSaved={async (max, timeout) => {
                await loadConnections()
                const current = useAppStore.getState().currentConnection
                if (current?.database_id === poolConn.database_id) {
                  useAppStore.getState().setCurrentConnection({
                    ...current,
                    max_connections: max,
                    connection_timeout: timeout,
                  })
                }
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
