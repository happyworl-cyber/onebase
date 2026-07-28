'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/lib/store'

export default function DatabaseSelector() {
  const router = useRouter()
  const { currentDatabase, databases, setCurrentDatabase } = useAppStore()
  const [showMenu, setShowMenu] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return (
      <div className="px-3 py-2 bg-gray-50 rounded-lg border border-gray-200">
        <div className="flex items-center space-x-2">
          <i className="fas fa-database text-gray-400 text-xs"></i>
          <span className="text-xs text-gray-700">加载中...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="relative">
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="w-full px-3 py-2 bg-gray-50 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2 min-w-0 flex-1">
            <i className="fas fa-database text-gray-400 text-xs flex-shrink-0"></i>
            <div className="flex-1 min-w-0 text-left">
              <p className="text-xs font-medium text-gray-700 truncate">
                {currentDatabase?.name || '选择数据库'}
              </p>
              {currentDatabase && (
                <p className="text-[10px] text-gray-500 truncate">
                  {currentDatabase.host}:{currentDatabase.port}/{currentDatabase.database}
                </p>
              )}
            </div>
            {currentDatabase?.id !== 'default' && (
              <i className="fas fa-exclamation-triangle text-yellow-500 text-xs flex-shrink-0" title="配置未生效，仍使用默认连接"></i>
            )}
          </div>
          <i className={`fas fa-chevron-down text-gray-400 text-[10px] flex-shrink-0 transition-transform ${showMenu ? 'rotate-180' : ''}`}></i>
        </div>
      </button>

      {/* 下拉菜单 */}
      {showMenu && (
        <>
          {/* 遮罩层 */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setShowMenu(false)}
          ></div>

          {/* 菜单内容 */}
          <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 max-h-80 overflow-y-auto">
            <div className="p-2">
              {/* 数据库列表 */}
              <div className="space-y-1">
                {databases.map((db) => (
                  <button
                    key={db.id}
                    onClick={() => {
                      setCurrentDatabase(db)
                      setShowMenu(false)
                      // 触发自定义事件通知页面刷新
                      if (typeof window !== 'undefined') {
                        window.dispatchEvent(new Event('database-changed'))
                      }
                    }}
                    className={`w-full px-3 py-2 rounded-md text-left transition-colors ${
                      currentDatabase?.id === db.id
                        ? 'bg-blue-50 text-blue-600'
                        : 'hover:bg-gray-50 text-gray-700'
                    }`}
                  >
                    <div className="flex items-start space-x-2">
                      <i
                        className={`fas fa-database text-xs mt-0.5 ${
                          currentDatabase?.id === db.id
                            ? 'text-blue-600'
                            : 'text-gray-400'
                        }`}
                      ></i>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">{db.name}</p>
                        <p className="text-[10px] text-gray-500 truncate">
                          {db.host}:{db.port}/{db.database}
                        </p>
                      </div>
                      {currentDatabase?.id === db.id && (
                        <i className="fas fa-check text-blue-600 text-xs"></i>
                      )}
                    </div>
                  </button>
                ))}
              </div>

              {/* 分隔线 */}
              <div className="border-t border-gray-100 my-2"></div>

              {/* 管理连接 */}
              <button
                onClick={() => {
                  setShowMenu(false)
                  router.push('/dashboard/connections')
                }}
                className="w-full px-3 py-2 rounded-md text-left hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center space-x-2">
                  <i className="fas fa-cog text-xs text-gray-400"></i>
                  <span className="text-xs text-gray-700">管理数据库连接</span>
                </div>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

