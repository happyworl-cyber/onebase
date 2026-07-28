'use client'

import { useState, useEffect } from 'react'
import { useAppStore } from '@/lib/store'
import { tenantAPI } from '@/lib/api'

export default function ConnectionsPage() {
  const { userConnections, setUserConnections, currentConnection, setCurrentConnection, currentTenant } = useAppStore()
  const [showForm, setShowForm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [testingConnection, setTestingConnection] = useState(false)
  const [testResult, setTestResult] = useState<any>(null)

  const [formData, setFormData] = useState({
    tenant_id: 1,
    connection_name: '',
    db_host: 'localhost',
    db_port: 5432,
    db_name: '',
    db_user: 'postgres',
    db_password: '',
    is_primary: false,
    db_role: 'primary' as 'primary' | 'replica',
    primary_id: null as number | null,
    max_connections: 10,
    connection_timeout: 30,
  })

  useEffect(() => {
    loadConnections()
  }, [currentTenant])

  const loadConnections = async () => {
    setLoading(true)
    try {
      const response = await tenantAPI.getMyConnections(currentTenant?.id)
      const connections = Array.isArray(response.data) ? response.data : []
      // Defensive client-side filter: only show connections for the current project
      const filtered = currentTenant
        ? connections.filter((c: any) => c.tenant_id === currentTenant.id)
        : connections
      setUserConnections(filtered)
    } catch (err: any) {
      console.error('加载连接失败:', err)
      alert('加载连接失败: ' + (err.response?.data?.error || err.message))
    } finally {
      setLoading(false)
    }
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
      tenant_id: 1,
      connection_name: '',
      db_host: 'localhost',
      db_port: 5432,
      db_name: '',
      db_user: 'postgres',
      db_password: '',
      is_primary: false,
      db_role: 'primary',
      primary_id: null,
      max_connections: 10,
      connection_timeout: 30,
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
                  max="100"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">连接超时（秒）</label>
                <input
                  type="number"
                  value={formData.connection_timeout}
                  onChange={(e) => setFormData({ ...formData, connection_timeout: parseInt(e.target.value) })}
                  className="input-base w-full"
                  min="5"
                  max="300"
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
          primaryConnections.map((conn: any) => {
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
                        {replicas.length > 0 && (
                          <p className="text-xs text-green-600 mt-1">
                            <i className="fas fa-project-diagram mr-1"></i>
                            {replicas.length} 个只读副本
                          </p>
                        )}
                      </div>
                    </div>
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
    </div>
  )
}
