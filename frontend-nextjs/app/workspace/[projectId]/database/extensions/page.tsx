'use client'

import { useState, useEffect, useCallback } from 'react'
import { queryAPI } from '@/lib/api'
import { useNotification } from '@/hooks/useNotification'

interface Extension {
  name: string
  default_version: string
  installed_version: string | null
  comment: string
  is_installed: boolean
}

// 常用扩展描述
const EXTENSION_DESCRIPTIONS: Record<string, { icon: string, description: string, category: string }> = {
  'uuid-ossp': {
    icon: 'fa-fingerprint',
    description: '生成通用唯一标识符 (UUID)',
    category: '数据类型',
  },
  'pgcrypto': {
    icon: 'fa-lock',
    description: '加密函数，包括密码哈希',
    category: '安全',
  },
  'pg_trgm': {
    icon: 'fa-search',
    description: '模糊搜索和相似度匹配',
    category: '搜索',
  },
  'btree_gin': {
    icon: 'fa-tree',
    description: '为 GIN 索引添加 B-tree 操作符支持',
    category: '索引',
  },
  'btree_gist': {
    icon: 'fa-tree',
    description: '为 GiST 索引添加 B-tree 操作符支持',
    category: '索引',
  },
  'hstore': {
    icon: 'fa-database',
    description: '键值对存储',
    category: '数据类型',
  },
  'citext': {
    icon: 'fa-font',
    description: '不区分大小写的文本类型',
    category: '数据类型',
  },
  'pg_stat_statements': {
    icon: 'fa-chart-bar',
    description: '跟踪 SQL 执行统计',
    category: '监控',
  },
  'postgis': {
    icon: 'fa-globe',
    description: '地理空间数据支持',
    category: '地理',
  },
  'vector': {
    icon: 'fa-brain',
    description: '向量存储和相似度搜索 (AI/ML)',
    category: 'AI',
  },
  'timescaledb': {
    icon: 'fa-clock',
    description: '时序数据优化',
    category: '时序',
  },
  'plpgsql': {
    icon: 'fa-code',
    description: 'PL/pgSQL 过程语言',
    category: '语言',
  },
  'ltree': {
    icon: 'fa-sitemap',
    description: '层次树状数据类型',
    category: '数据类型',
  },
  'fuzzystrmatch': {
    icon: 'fa-spell-check',
    description: '模糊字符串匹配',
    category: '搜索',
  },
  'unaccent': {
    icon: 'fa-language',
    description: '删除重音符号的文本搜索',
    category: '搜索',
  },
}

export default function ExtensionsPage() {
  const notify = useNotification()
  const [extensions, setExtensions] = useState<Extension[]>([])
  const [loading, setLoading] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [filterInstalled, setFilterInstalled] = useState<'all' | 'installed' | 'available'>('all')

  // 加载扩展列表
  const loadExtensions = useCallback(async () => {
    setLoading(true)
    try {
      const result = await queryAPI.execute(`
        SELECT 
          ae.name,
          ae.default_version,
          e.extversion as installed_version,
          ae.comment,
          e.extname IS NOT NULL as is_installed
        FROM pg_available_extensions ae
        LEFT JOIN pg_extension e ON ae.name = e.extname
        ORDER BY ae.name
      `)
      setExtensions(result.data.data || [])
    } catch (err: any) {
      notify.error(err)
    } finally {
      setLoading(false)
    }
  }, [notify])

  useEffect(() => {
    loadExtensions()
  }, [loadExtensions])

  // 安装扩展
  const installExtension = async (name: string) => {
    try {
      // 受管按钮 = 明确意图；用 executeManaged 自动带 ack
      await queryAPI.executeManaged(`CREATE EXTENSION IF NOT EXISTS "${name}";`)
      notify.success(`扩展 "${name}" 安装成功`)
      loadExtensions()
    } catch (err: any) {
      notify.error(err)
    }
  }

  // 卸载扩展
  const uninstallExtension = async (name: string) => {
    const confirmed = window.confirm(`确定要卸载扩展 "${name}" 吗？\n\n警告：这可能会删除依赖此扩展的对象。`)
    if (!confirmed) return
    
    try {
      await queryAPI.executeManaged(`DROP EXTENSION IF EXISTS "${name}" CASCADE;`)
      notify.success(`扩展 "${name}" 已卸载`)
      loadExtensions()
    } catch (err: any) {
      notify.error(err)
    }
  }

  // 更新扩展
  const updateExtension = async (name: string) => {
    try {
      await queryAPI.executeManaged(`ALTER EXTENSION "${name}" UPDATE;`)
      notify.success(`扩展 "${name}" 已更新`)
      loadExtensions()
    } catch (err: any) {
      notify.error(err)
    }
  }

  // 过滤扩展
  const filteredExtensions = extensions.filter(ext => {
    const matchesSearch = ext.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (ext.comment?.toLowerCase() || '').includes(searchTerm.toLowerCase())
    
    if (filterInstalled === 'installed') return matchesSearch && ext.is_installed
    if (filterInstalled === 'available') return matchesSearch && !ext.is_installed
    return matchesSearch
  })

  // 获取扩展信息
  const getExtensionInfo = (name: string) => {
    return EXTENSION_DESCRIPTIONS[name] || {
      icon: 'fa-puzzle-piece',
      description: '',
      category: '其他',
    }
  }

  // 按类别分组
  const groupedExtensions = filteredExtensions.reduce((acc, ext) => {
    const info = getExtensionInfo(ext.name)
    const category = info.category
    if (!acc[category]) acc[category] = []
    acc[category].push(ext)
    return acc
  }, {} as Record<string, Extension[]>)

  const installedCount = extensions.filter(e => e.is_installed).length

  return (
    <div className="space-y-6">
      {/* 页面头部 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">扩展管理</h1>
          <p className="text-sm text-gray-500 mt-1">
            已安装 {installedCount} 个扩展 / 共 {extensions.length} 个可用
          </p>
        </div>
      </div>


      {/* 搜索和筛选 */}
      <div className="card p-4">
        <div className="flex items-center space-x-4">
          <div className="relative flex-1 max-w-md">
            <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"></i>
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="搜索扩展..."
              className="w-full pl-10 pr-4 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          
          <div className="flex items-center space-x-2">
            <button
              onClick={() => setFilterInstalled('all')}
              className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                filterInstalled === 'all' ? 'bg-blue-100 text-blue-700' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              全部 ({extensions.length})
            </button>
            <button
              onClick={() => setFilterInstalled('installed')}
              className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                filterInstalled === 'installed' ? 'bg-green-100 text-green-700' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              已安装 ({installedCount})
            </button>
            <button
              onClick={() => setFilterInstalled('available')}
              className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                filterInstalled === 'available' ? 'bg-gray-200 text-gray-700' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              可安装 ({extensions.length - installedCount})
            </button>
          </div>
          
          <button
            onClick={loadExtensions}
            disabled={loading}
            className="btn-default text-sm"
          >
            <i className={`fas ${loading ? 'fa-spinner fa-spin' : 'fa-sync-alt'} mr-2`}></i>
            刷新
          </button>
        </div>
      </div>

      {/* 扩展列表 */}
      {loading && extensions.length === 0 ? (
        <div className="card p-12 text-center">
          <i className="fas fa-spinner fa-spin text-3xl text-blue-500 mb-3"></i>
          <p className="text-gray-500">加载扩展列表...</p>
        </div>
      ) : filteredExtensions.length === 0 ? (
        <div className="card p-12 text-center">
          <i className="fas fa-puzzle-piece text-5xl text-gray-300 mb-4"></i>
          <p className="text-gray-500">
            {searchTerm ? '未找到匹配的扩展' : '暂无可用扩展'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredExtensions.map(ext => {
            const info = getExtensionInfo(ext.name)
            const needsUpdate = ext.is_installed && ext.installed_version !== ext.default_version
            
            return (
              <div key={ext.name} className="card p-4 hover:shadow-md transition-shadow">
                <div className="flex items-start justify-between">
                  <div className="flex items-start space-x-3">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                      ext.is_installed ? 'bg-green-100' : 'bg-gray-100'
                    }`}>
                      <i className={`fas ${info.icon} ${
                        ext.is_installed ? 'text-green-600' : 'text-gray-400'
                      }`}></i>
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center space-x-2">
                        <h3 className="font-medium text-gray-900">{ext.name}</h3>
                        {ext.is_installed && (
                          <span className="text-xs px-1.5 py-0.5 bg-green-100 text-green-700 rounded">
                            已安装
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mt-1 line-clamp-2">
                        {info.description || ext.comment || '无描述'}
                      </p>
                      <div className="flex items-center space-x-2 mt-2">
                        <span className="text-xs text-gray-400">
                          v{ext.is_installed ? ext.installed_version : ext.default_version}
                        </span>
                        {needsUpdate && (
                          <span className="text-xs text-yellow-600">
                            → v{ext.default_version}
                          </span>
                        )}
                        <span className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded">
                          {info.category}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
                
                <div className="mt-4 flex items-center space-x-2">
                  {ext.is_installed ? (
                    <>
                      {needsUpdate && (
                        <button
                          onClick={() => updateExtension(ext.name)}
                          className="flex-1 px-3 py-1.5 text-xs bg-yellow-100 text-yellow-700 rounded-lg hover:bg-yellow-200 transition-colors"
                        >
                          <i className="fas fa-arrow-up mr-1"></i>
                          更新
                        </button>
                      )}
                      <button
                        onClick={() => uninstallExtension(ext.name)}
                        className="flex-1 px-3 py-1.5 text-xs bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition-colors"
                      >
                        <i className="fas fa-trash mr-1"></i>
                        卸载
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => installExtension(ext.name)}
                      className="w-full px-3 py-1.5 text-xs bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200 transition-colors"
                    >
                      <i className="fas fa-download mr-1"></i>
                      安装
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

