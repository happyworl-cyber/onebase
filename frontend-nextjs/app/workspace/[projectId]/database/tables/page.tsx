'use client'

import { useState, useEffect, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { schemaAPI, tableAPI } from '@/lib/api'
import { downloadFile } from '@/lib/utils'
import { useAppStore } from '@/lib/store'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import TableEditor from '@/components/TableEditor'
import { askAi } from '@/lib/aiAssistant'
import { genRequestId } from '@/lib/embedBridge'

interface TableInfo {
  table_name: string
  table_type: string
  row_count: number | null
  size: string | null
}

export default function TablesPage() {
  const { currentSchema } = useAppStore()
  const { canWriteDatabase } = useCurrentProjectCapabilities()
  const router = useRouter()
  const params = useParams<{ projectId: string }>()
  // M3 入口跳转辅助：所有 CTA 都通过 router.push 跳同项目下的 table-designer。
  // 用 params.projectId 兼容路由层带斜杠的项目 id。
  const designerHref = (qs: string = '') =>
    `/workspace/${params.projectId}/database/table-designer${qs}`
  const [tables, setTables] = useState<TableInfo[]>([])
  const [selectedTable, setSelectedTable] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  // 自增的请求令牌：切 schema / 切库会连续触发多次 loadTables，只有"最新一次"
  // 的响应能写回 state，避免旧 schema 的响应后到把新列表覆盖成旧数据。
  const loadTokenRef = useRef(0)

  // 加载表列表
  const loadTables = async () => {
    if (!currentSchema) {
      setTables([])
      setLoading(false)
      return
    }

    const token = ++loadTokenRef.current
    setLoading(true)
    setError('')
    try {
      const response = await schemaAPI.listTables(currentSchema)
      if (token !== loadTokenRef.current) return
      setTables(response.data)
    } catch (err: any) {
      if (token !== loadTokenRef.current) return
      console.error('加载表列表失败:', err)
      setError(err.response?.data?.error || err.message || '加载失败')
      setTables([])
    } finally {
      if (token === loadTokenRef.current) setLoading(false)
    }
  }

  // 监听 Schema 变化：currentSchema 一变（含侧栏切 schema）就重新拉表并清空选中。
  useEffect(() => {
    loadTables()
    setSelectedTable(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSchema])

  // 监听数据库连接切换：切库后 currentSchema 字符串可能不变（如两库都有 public），
  // 此时上面的 [currentSchema] effect 不会重跑，需要显式重载。
  // 依赖 [currentSchema] 让 handleChange 始终闭包到最新的 loadTables，
  // 否则会用到首帧的旧 schema 造成列表刷不新。
  // 注意：不再监听 schema-changed —— 切 schema 已由上面的 effect 覆盖，
  // 再挂一份会并发发起"旧 schema"的重复请求，竞态下把新列表覆盖回旧数据。
  useEffect(() => {
    const handleChange = () => {
      setSelectedTable(null)
      loadTables()
    }
    window.addEventListener('database-changed', handleChange)
    return () => {
      window.removeEventListener('database-changed', handleChange)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSchema])

  // 导出功能
  const handleExportCSV = async (tableName: string) => {
    try {
      const response = await tableAPI.exportCSV(currentSchema, tableName, { limit: 10000 })
      downloadFile(response.data, `${currentSchema}_${tableName}.csv`)
    } catch (err: any) {
      alert('导出失败：' + (err.response?.data?.error || err.message))
    }
  }

  const handleExportJSON = async (tableName: string) => {
    try {
      const response = await tableAPI.exportJSON(currentSchema, tableName, { limit: 10000 })
      const blob = new Blob([JSON.stringify(response.data, null, 2)], { type: 'application/json' })
      downloadFile(blob, `${currentSchema}_${tableName}.json`)
    } catch (err: any) {
      alert('导出失败：' + (err.response?.data?.error || err.message))
    }
  }

  // 让 AI 助手分析某张表（结构 / 索引 / 优化点）。表名通过 currentSchema 限定，
  // 当前连接信息已通过面板的 meta 注入（database_id / db_name）。
  const analyzeTableWithAi = (tableName: string) => {
    const fq = `${currentSchema}.${tableName}`
    askAi({
      prompt:
        `请分析数据库表 \`${fq}\` 的表结构、字段类型、索引设计与潜在优化点，` +
        '并指出可能的范式 / 性能 / 数据一致性问题。当前数据库连接信息见环境变量（database_id / db_name）。',
      requestId: genRequestId('table-analyze'),
    })
  }

  // 过滤表列表
  const filteredTables = tables.filter(t => 
    t.table_name.toLowerCase().includes(searchTerm.toLowerCase())
  )

  // 如果选中了表，显示表格编辑器
  if (selectedTable) {
    return (
      <div className="h-full flex flex-col">
        {/* 面包屑导航 */}
        <div className="flex items-center space-x-2 mb-4">
          <button
            onClick={() => setSelectedTable(null)}
            className="flex items-center text-sm text-gray-600 hover:text-gray-900"
          >
            <i className="fas fa-arrow-left mr-2"></i>
            返回表列表
          </button>
          <span className="text-gray-400">/</span>
          <span className="text-sm font-medium text-gray-900">{currentSchema}.{selectedTable}</span>
        </div>
        
        {/* 表格编辑器 */}
        <div className="flex-1 min-h-0">
          <TableEditor
            schema={currentSchema}
            table={selectedTable}
            onClose={() => setSelectedTable(null)}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* 页面头部 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">数据表管理</h1>
          <p className="text-sm text-gray-500 mt-1">
            当前 Schema: <span className="font-mono font-medium text-gray-900">{currentSchema}</span>
            {!loading && <span className="ml-2">· {tables.length} 个表</span>}
          </p>
        </div>
        
        <div className="flex items-center space-x-3">
          {/* 搜索框 */}
          <div className="relative">
            <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm"></i>
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="搜索表名..."
              className="pl-9 pr-4 py-2 text-sm border border-gray-300 rounded-lg w-64 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          
          {/* 视图切换 */}
          <div className="flex items-center border border-gray-300 rounded-lg overflow-hidden">
            <button
              onClick={() => setViewMode('grid')}
              className={`px-3 py-2 text-sm ${viewMode === 'grid' ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              <i className="fas fa-th-large"></i>
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`px-3 py-2 text-sm ${viewMode === 'list' ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              <i className="fas fa-list"></i>
            </button>
          </div>
          
          {/* 刷新按钮 */}
          <button
            onClick={loadTables}
            disabled={loading}
            className="btn-default"
          >
            <i className={`fas ${loading ? 'fa-spinner fa-spin' : 'fa-sync-alt'} text-xs mr-2`}></i>
            刷新
          </button>

          {/* M3 入口：建表 CTA。viewer 角色按钮还是显示，但点了会跳到 designer，
              那边 button 会按 canWriteDatabase 灰掉——避免在两处重复 gate 逻辑。 */}
          <button
            onClick={() => router.push(designerHref('?mode=create'))}
            className="btn-primary"
            title={canWriteDatabase ? '在当前 Schema 下创建新表' : '需 member+ 角色才能建表'}
          >
            <i className="fas fa-plus text-xs mr-2"></i>
            新建表
          </button>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="card p-4 bg-red-50 border-red-200">
          <div className="flex items-start space-x-3">
            <i className="fas fa-exclamation-circle text-red-500 mt-0.5"></i>
            <div className="flex-1">
              <p className="text-sm font-medium text-red-800">加载失败</p>
              <p className="text-sm text-red-600 mt-1">{error}</p>
            </div>
          </div>
        </div>
      )}

      {/* 加载状态 */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="text-center">
            <i className="fas fa-spinner fa-spin text-4xl text-blue-500 mb-4"></i>
            <p className="text-gray-500">加载表列表...</p>
          </div>
        </div>
      ) : filteredTables.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <div className="text-center max-w-md">
            <i className="fas fa-table text-5xl text-gray-300 mb-4"></i>
            {searchTerm ? (
              <>
                <p className="text-gray-500 mb-2">没有找到匹配的表</p>
                <button
                  onClick={() => setSearchTerm('')}
                  className="text-blue-600 hover:text-blue-800 text-sm"
                >
                  清除搜索
                </button>
              </>
            ) : (
              <>
                {/* M3：空 schema 不再死路一条——直接给"建第一张表" CTA。 */}
                <h3 className="text-base font-medium text-gray-800 mb-2">
                  当前 Schema 还没有数据表
                </h3>
                <p className="text-sm text-gray-500 mb-5">
                  你的项目刚开通时是空白的——点下方按钮设计第一张表，几秒钟就能跑起 API。
                </p>
                <button
                  onClick={() => router.push(designerHref('?mode=create'))}
                  className="btn-primary"
                >
                  <i className="fas fa-plus mr-2"></i>
                  建第一张表
                </button>
              </>
            )}
          </div>
        </div>
      ) : viewMode === 'grid' ? (
        /* 网格视图 */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredTables.map((table) => (
            <div
              key={table.table_name}
              className="card p-4 cursor-pointer hover:border-blue-300 hover:shadow-md transition-all group"
              onClick={() => setSelectedTable(table.table_name)}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center space-x-2">
                  <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                    <i className={`fas ${table.table_type === 'VIEW' ? 'fa-eye' : 'fa-table'} text-blue-600`}></i>
                  </div>
                  <div>
                    <h3 className="font-medium text-gray-900 group-hover:text-blue-600 transition-colors">
                      {table.table_name}
                    </h3>
                    <span className="text-xs text-gray-400">{table.table_type}</span>
                  </div>
                </div>
                
                {/* 操作菜单 */}
                <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                  <div className="flex items-center space-x-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        analyzeTableWithAi(table.table_name)
                      }}
                      className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded"
                      title="用 AI 分析这张表"
                    >
                      <i className="fas fa-robot text-xs"></i>
                    </button>
                    {/* M3 入口：直跳 designer edit 模式编辑表结构 */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        router.push(designerHref(`?mode=edit&table=${encodeURIComponent(table.table_name)}`))
                      }}
                      className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded"
                      title="编辑结构（加列 / 删列 / 改 NOT NULL / 改默认）"
                    >
                      <i className="fas fa-pen-ruler text-xs"></i>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleExportCSV(table.table_name)
                      }}
                      className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded"
                      title="导出 CSV"
                    >
                      <i className="fas fa-file-csv text-xs"></i>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleExportJSON(table.table_name)
                      }}
                      className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded"
                      title="导出 JSON"
                    >
                      <i className="fas fa-file-code text-xs"></i>
                    </button>
                  </div>
                </div>
              </div>
              
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>
                  <i className="fas fa-list-ol mr-1"></i>
                  {table.row_count != null ? `${table.row_count.toLocaleString()} 行` : '-'}
                </span>
                <span>
                  <i className="fas fa-database mr-1"></i>
                  {table.size || '-'}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* 列表视图 */
        <div className="card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">表名</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">类型</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600 uppercase">行数</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600 uppercase">大小</th>
                <th className="px-4 py-3 text-center text-xs font-semibold text-gray-600 uppercase">操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredTables.map((table) => (
                <tr
                  key={table.table_name}
                  className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
                  onClick={() => setSelectedTable(table.table_name)}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center space-x-3">
                      <div className="w-8 h-8 bg-blue-100 rounded flex items-center justify-center">
                        <i className={`fas ${table.table_type === 'VIEW' ? 'fa-eye' : 'fa-table'} text-blue-600 text-xs`}></i>
                      </div>
                      <span className="font-medium text-gray-900">{table.table_name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                      table.table_type === 'VIEW'
                        ? 'bg-purple-100 text-purple-700'
                        : 'bg-blue-100 text-blue-700'
                    }`}>
                      {table.table_type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-sm text-gray-600">
                    {table.row_count != null ? table.row_count.toLocaleString() : '-'}
                  </td>
                  <td className="px-4 py-3 text-right text-sm text-gray-600">
                    {table.size || '-'}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="flex items-center justify-center space-x-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          analyzeTableWithAi(table.table_name)
                        }}
                        className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded"
                        title="用 AI 分析这张表"
                      >
                        <i className="fas fa-robot"></i>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          router.push(designerHref(`?mode=edit&table=${encodeURIComponent(table.table_name)}`))
                        }}
                        className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded"
                        title="编辑结构（加列 / 删列 / 改 NOT NULL / 改默认）"
                      >
                        <i className="fas fa-pen-ruler"></i>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleExportCSV(table.table_name)
                        }}
                        className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded"
                        title="导出 CSV"
                      >
                        <i className="fas fa-file-csv"></i>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleExportJSON(table.table_name)
                        }}
                        className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded"
                        title="导出 JSON"
                      >
                        <i className="fas fa-file-code"></i>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setSelectedTable(table.table_name)
                        }}
                        className="p-1.5 text-blue-500 hover:text-blue-700 hover:bg-blue-50 rounded"
                        title="编辑数据"
                      >
                        <i className="fas fa-edit"></i>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
