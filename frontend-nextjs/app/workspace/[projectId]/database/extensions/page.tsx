'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'
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
const EXTENSION_DESCRIPTIONS: Record<string, { icon: string, descKey: string, categoryKey: string }> = {
  'uuid-ossp': {
    icon: 'fa-fingerprint',
    descKey: 'descUuidOssp',
    categoryKey: 'catDataType',
  },
  'pgcrypto': {
    icon: 'fa-lock',
    descKey: 'descPgcrypto',
    categoryKey: 'catSecurity',
  },
  'pg_trgm': {
    icon: 'fa-search',
    descKey: 'descPgTrgm',
    categoryKey: 'catSearch',
  },
  'btree_gin': {
    icon: 'fa-tree',
    descKey: 'descBtreeGin',
    categoryKey: 'catIndex',
  },
  'btree_gist': {
    icon: 'fa-tree',
    descKey: 'descBtreeGist',
    categoryKey: 'catIndex',
  },
  'hstore': {
    icon: 'fa-database',
    descKey: 'descHstore',
    categoryKey: 'catDataType',
  },
  'citext': {
    icon: 'fa-font',
    descKey: 'descCitext',
    categoryKey: 'catDataType',
  },
  'pg_stat_statements': {
    icon: 'fa-chart-bar',
    descKey: 'descPgStat',
    categoryKey: 'catMonitor',
  },
  'postgis': {
    icon: 'fa-globe',
    descKey: 'descPostgis',
    categoryKey: 'catGeo',
  },
  'vector': {
    icon: 'fa-brain',
    descKey: 'descVector',
    categoryKey: 'catAI',
  },
  'timescaledb': {
    icon: 'fa-clock',
    descKey: 'descTimescale',
    categoryKey: 'catTimeseries',
  },
  'plpgsql': {
    icon: 'fa-code',
    descKey: 'descPlpgsql',
    categoryKey: 'catLanguage',
  },
  'ltree': {
    icon: 'fa-sitemap',
    descKey: 'descLtree',
    categoryKey: 'catDataType',
  },
  'fuzzystrmatch': {
    icon: 'fa-spell-check',
    descKey: 'descFuzzy',
    categoryKey: 'catSearch',
  },
  'unaccent': {
    icon: 'fa-language',
    descKey: 'descUnaccent',
    categoryKey: 'catSearch',
  },
}

export default function ExtensionsPage() {
  const t = useTranslations('wsExtensions')
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
      notify.success(t('installOk', { name }))
      loadExtensions()
    } catch (err: any) {
      notify.error(err)
    }
  }

  // 卸载扩展
  const uninstallExtension = async (name: string) => {
    const confirmed = window.confirm(t('confirmUninstall', { name }))
    if (!confirmed) return
    
    try {
      await queryAPI.executeManaged(`DROP EXTENSION IF EXISTS "${name}" CASCADE;`)
      notify.success(t('uninstallOk', { name }))
      loadExtensions()
    } catch (err: any) {
      notify.error(err)
    }
  }

  // 更新扩展
  const updateExtension = async (name: string) => {
    try {
      await queryAPI.executeManaged(`ALTER EXTENSION "${name}" UPDATE;`)
      notify.success(t('updateOk', { name }))
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
      descKey: '',
      categoryKey: 'catOther',
    }
  }

  // 按类别分组
  const groupedExtensions = filteredExtensions.reduce((acc, ext) => {
    const info = getExtensionInfo(ext.name)
    const category = info.categoryKey
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
          <h1 className="text-2xl font-semibold text-gray-800">{t('title')}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {t('summary', { installed: installedCount, total: extensions.length })}
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
              placeholder={t('searchPlaceholder')}
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
              {t('tabAll', { n: extensions.length })}
            </button>
            <button
              onClick={() => setFilterInstalled('installed')}
              className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                filterInstalled === 'installed' ? 'bg-green-100 text-green-700' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {t('tabInstalled', { n: installedCount })}
            </button>
            <button
              onClick={() => setFilterInstalled('available')}
              className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                filterInstalled === 'available' ? 'bg-gray-200 text-gray-700' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {t('tabAvailable', { n: extensions.length - installedCount })}
            </button>
          </div>
          
          <button
            onClick={loadExtensions}
            disabled={loading}
            className="btn-default text-sm"
          >
            <i className={`fas ${loading ? 'fa-spinner fa-spin' : 'fa-sync-alt'} mr-2`}></i>
            {t('refresh')}
          </button>
        </div>
      </div>

      {/* 扩展列表 */}
      {loading && extensions.length === 0 ? (
        <div className="card p-12 text-center">
          <i className="fas fa-spinner fa-spin text-3xl text-blue-500 mb-3"></i>
          <p className="text-gray-500">{t('loading')}</p>
        </div>
      ) : filteredExtensions.length === 0 ? (
        <div className="card p-12 text-center">
          <i className="fas fa-puzzle-piece text-5xl text-gray-300 mb-4"></i>
          <p className="text-gray-500">
            {searchTerm ? t('noMatch') : t('empty')}
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
                            {t('installed')}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mt-1 line-clamp-2">
                        {(info.descKey ? t(info.descKey) : '') || ext.comment || t('noDesc')}
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
                          {t(info.categoryKey)}
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
                          {t('update')}
                        </button>
                      )}
                      <button
                        onClick={() => uninstallExtension(ext.name)}
                        className="flex-1 px-3 py-1.5 text-xs bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition-colors"
                      >
                        <i className="fas fa-trash mr-1"></i>
                        {t('uninstall')}
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => installExtension(ext.name)}
                      className="w-full px-3 py-1.5 text-xs bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200 transition-colors"
                    >
                      <i className="fas fa-download mr-1"></i>
                      {t('install')}
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

