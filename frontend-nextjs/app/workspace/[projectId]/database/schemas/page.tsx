'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { schemaAPI } from '@/lib/api'
import { useAppStore } from '@/lib/store'

interface SchemaInfo {
  schema_name: string
  table_count: number
}

interface TableInfo {
  table_name: string
  row_count: number
}

interface ColumnInfo {
  column_name: string
  data_type: string
  is_nullable: string
  column_default: string | null
}

export default function SchemaPage() {
  const t = useTranslations('wsSchemas')
  const { currentSchema } = useAppStore()
  const [tables, setTables] = useState<TableInfo[]>([])
  const [selectedTable, setSelectedTable] = useState<string>('')
  const [columns, setColumns] = useState<ColumnInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // 加载 tables
  useEffect(() => {
    if (currentSchema) {
      loadTables(currentSchema)
    }
  }, [currentSchema])

  // 监听数据库和 Schema 切换
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const handleChange = () => {
        setSelectedTable('')
        setColumns([])
        if (currentSchema) {
          loadTables(currentSchema)
        }
      }
      window.addEventListener('database-changed', handleChange)
      window.addEventListener('schema-changed', handleChange)
      return () => {
        window.removeEventListener('database-changed', handleChange)
        window.removeEventListener('schema-changed', handleChange)
      }
    }
  }, [currentSchema])

  // 加载 table structure
  useEffect(() => {
    if (currentSchema && selectedTable) {
      loadTableStructure(currentSchema, selectedTable)
    }
  }, [currentSchema, selectedTable])

  const loadTables = async (schema: string) => {
    setLoading(true)
    setError('')
    try {
      const response = await schemaAPI.listTables(schema)
      console.log('Tables API 响应:', response.data)
      const data = Array.isArray(response.data) ? response.data : []
      setTables(data)
    } catch (err: any) {
      console.error(t('loadTablesLog'), err)
      setTables([])
      setError(err.response?.data?.error || err.message || t('loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  const loadTableStructure = async (schema: string, table: string) => {
    setLoading(true)
    setError('')
    try {
      const response = await schemaAPI.getTableStructure(schema, table)
      console.log('表结构 API 响应:', response.data)
      
      // API 返回的是一个对象，包含 columns 数组
      const data = response.data
      
      // 检查是对象还是数组
      if (Array.isArray(data)) {
        // 如果直接返回数组
        setColumns(data)
      } else if (data && Array.isArray(data.columns)) {
        // 如果返回的是对象，包含 columns 字段
        setColumns(data.columns)
      } else {
        console.error(t('badFormatLog'), data)
        setColumns([])
        setError(t('badFormat'))
      }
    } catch (err: any) {
      console.error(t('loadStructFailed'), err)
      setColumns([])  // 重置为空数组
      setError(err.response?.data?.error || t('loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">{t('title')}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {t('currentSchema')} <span className="font-mono font-medium text-gray-900">{currentSchema}</span>
          </p>
        </div>
        <button onClick={() => currentSchema && loadTables(currentSchema)} className="btn-default">
          <i className="fas fa-sync-alt text-xs mr-2"></i>
          {t('refresh')}
        </button>
      </div>

      {error && (
        <div className="card p-4 bg-red-50 border-red-200">
          <p className="text-sm text-red-600">{error}</p>
        </div>
      )}

      <div className="grid grid-cols-12 gap-6">
        {/* Tables 列表 */}
        <div className="col-span-4">
          <div className="card">
            <div className="px-4 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-700">Tables</h3>
            </div>
            <div className="divide-y divide-gray-100 max-h-[600px] overflow-y-auto">
              {loading ? (
                <div className="p-4 text-center">
                  <i className="fas fa-spinner fa-spin text-2xl text-primary-500"></i>
                  <p className="text-sm text-gray-500 mt-2">{t('loading')}</p>
                </div>
              ) : tables.length === 0 ? (
                <div className="p-8 text-center">
                  <i className="fas fa-table text-3xl text-gray-300 mb-3"></i>
                  <p className="text-sm text-gray-500">{t('emptyTables')}</p>
                </div>
              ) : (
                tables.map((table) => (
                  <button
                    key={table.table_name}
                    onClick={() => setSelectedTable(table.table_name)}
                    className={`w-full px-4 py-3 text-left hover:bg-gray-50 transition-colors ${
                      selectedTable === table.table_name ? 'bg-blue-50' : ''
                    }`}
                  >
                    <div className="flex items-center space-x-3">
                      <i className={`fas fa-table text-sm ${
                        selectedTable === table.table_name ? 'text-blue-600' : 'text-gray-400'
                      }`}></i>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {table.table_name}
                        </p>
                        <p className="text-xs text-gray-500">
                          {t('rowsApprox', { n: table.row_count })}
                        </p>
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Table Structure */}
        <div className="col-span-8">
          <div className="card">
            <div className="px-4 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-700">
                {selectedTable ? t('structOf', { name: selectedTable }) : t('structTitle')}
              </h3>
            </div>
            <div className="overflow-auto max-h-[600px]">
              {!selectedTable ? (
                <div className="p-12 text-center">
                  <i className="fas fa-table text-4xl text-gray-300 mb-4"></i>
                  <p className="text-gray-500">{t('selectTable')}</p>
                </div>
              ) : loading ? (
                <div className="p-8 text-center">
                  <i className="fas fa-spinner fa-spin text-2xl text-primary-500"></i>
                  <p className="text-sm text-gray-500 mt-2">{t('loading')}</p>
                </div>
              ) : !Array.isArray(columns) || columns.length === 0 ? (
                <div className="p-12 text-center">
                  <i className="fas fa-inbox text-4xl text-gray-300 mb-4"></i>
                  <p className="text-gray-500">{t('noColumns')}</p>
                </div>
              ) : (
                <table className="w-full enterprise-table">
                  <thead>
                    <tr>
                      <th>{t('colName')}</th>
                      <th>{t('colType')}</th>
                      <th>{t('colNullable')}</th>
                      <th>{t('colDefault')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {columns.map((col, idx) => (
                      <tr key={idx}>
                        <td>
                          <span className="font-mono text-primary-600">
                            {col.column_name}
                          </span>
                        </td>
                        <td>
                          <span className="font-mono text-sm text-gray-600">
                            {col.data_type}
                          </span>
                        </td>
                        <td>
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                              col.is_nullable === 'YES'
                                ? 'bg-green-100 text-green-700'
                                : 'bg-red-100 text-red-700'
                            }`}
                          >
                            {col.is_nullable === 'YES' ? t('yes') : t('no')}
                          </span>
                        </td>
                        <td>
                          <span className="font-mono text-xs text-gray-500">
                            {col.column_default || '-'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

