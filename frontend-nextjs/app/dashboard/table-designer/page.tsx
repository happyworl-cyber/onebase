'use client'

import { useState, useEffect } from 'react'
import { schemaAPI, queryAPI } from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { useNotification } from '@/hooks/useNotification'
import Drawer from '@/components/Drawer'

// PostgreSQL 数据类型
const DATA_TYPES = [
  { value: 'integer', label: 'INTEGER', description: '整数' },
  { value: 'bigint', label: 'BIGINT', description: '大整数' },
  { value: 'smallint', label: 'SMALLINT', description: '小整数' },
  { value: 'serial', label: 'SERIAL', description: '自增整数' },
  { value: 'bigserial', label: 'BIGSERIAL', description: '自增大整数' },
  { value: 'numeric', label: 'NUMERIC', description: '精确数值' },
  { value: 'real', label: 'REAL', description: '浮点数' },
  { value: 'double precision', label: 'DOUBLE PRECISION', description: '双精度' },
  { value: 'varchar', label: 'VARCHAR', description: '可变长字符串' },
  { value: 'text', label: 'TEXT', description: '长文本' },
  { value: 'char', label: 'CHAR', description: '定长字符串' },
  { value: 'boolean', label: 'BOOLEAN', description: '布尔值' },
  { value: 'date', label: 'DATE', description: '日期' },
  { value: 'time', label: 'TIME', description: '时间' },
  { value: 'timestamp', label: 'TIMESTAMP', description: '时间戳' },
  { value: 'timestamptz', label: 'TIMESTAMPTZ', description: '带时区时间戳' },
  { value: 'uuid', label: 'UUID', description: 'UUID' },
  { value: 'json', label: 'JSON', description: 'JSON 数据' },
  { value: 'jsonb', label: 'JSONB', description: '二进制 JSON' },
  { value: 'bytea', label: 'BYTEA', description: '二进制数据' },
  { value: 'inet', label: 'INET', description: 'IP 地址' },
  { value: 'array', label: 'ARRAY', description: '数组' },
]

interface ColumnDefinition {
  id: string
  name: string
  type: string
  length?: number
  precision?: number
  scale?: number
  nullable: boolean
  defaultValue: string
  isPrimaryKey: boolean
  isUnique: boolean
  references?: {
    table: string
    column: string
  }
}

interface IndexDefinition {
  id: string
  name: string
  columns: string[]
  isUnique: boolean
}

interface TableInfo {
  table_name: string
  table_type: string
}

type Mode = 'create' | 'edit'

export default function TableDesignerPage() {
  const { currentSchema } = useAppStore()
  const notify = useNotification()
  const [mode, setMode] = useState<Mode>('create')
  const [tables, setTables] = useState<TableInfo[]>([])
  const [selectedTable, setSelectedTable] = useState<string>('')
  const [tableName, setTableName] = useState('')
  const [columns, setColumns] = useState<ColumnDefinition[]>([])
  const [indexes, setIndexes] = useState<IndexDefinition[]>([])
  const [loading, setLoading] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [generatedSQL, setGeneratedSQL] = useState('')

  // 加载表列表
  const loadTables = async () => {
    if (!currentSchema) return
    setLoading(true)
    try {
      const response = await schemaAPI.listTables(currentSchema)
      setTables(response.data.filter((t: TableInfo) => t.table_type === 'BASE TABLE'))
    } catch (err: any) {
      notify.error(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadTables()
  }, [currentSchema])

  // 加载表结构
  const loadTableStructure = async (tableName: string) => {
    if (!tableName) return
    setLoading(true)
    try {
      const response = await schemaAPI.getTableStructure(currentSchema, tableName)
      const structure = response.data
      
      // 转换为列定义
      const cols: ColumnDefinition[] = structure.columns.map((col: any) => {
        const pkConstraint = structure.constraints.find(
          (c: any) => c.constraint_type === 'PRIMARY KEY' && c.column_name === col.column_name
        )
        const uniqueConstraint = structure.constraints.find(
          (c: any) => c.constraint_type === 'UNIQUE' && c.column_name === col.column_name
        )
        const fkConstraint = structure.constraints.find(
          (c: any) => c.constraint_type === 'FOREIGN KEY' && c.column_name === col.column_name
        )
        
        return {
          id: col.column_name,
          name: col.column_name,
          type: col.data_type,
          length: col.character_maximum_length,
          precision: col.numeric_precision,
          scale: col.numeric_scale,
          nullable: col.is_nullable === 'YES',
          defaultValue: col.column_default || '',
          isPrimaryKey: !!pkConstraint,
          isUnique: !!uniqueConstraint,
          references: fkConstraint ? {
            table: fkConstraint.foreign_table,
            column: fkConstraint.foreign_column,
          } : undefined,
        }
      })
      
      setColumns(cols)
      setTableName(tableName)
      
      // 转换索引
      const idxs: IndexDefinition[] = structure.indexes
        .filter((idx: any) => !idx.is_primary)
        .map((idx: any) => ({
          id: idx.index_name,
          name: idx.index_name,
          columns: idx.columns,
          isUnique: idx.is_unique,
        }))
      setIndexes(idxs)
    } catch (err: any) {
      notify.error(err)
    } finally {
      setLoading(false)
    }
  }

  // 添加新列
  const addColumn = () => {
    const newCol: ColumnDefinition = {
      id: `col_${Date.now()}`,
      name: '',
      type: 'varchar',
      length: 255,
      nullable: true,
      defaultValue: '',
      isPrimaryKey: false,
      isUnique: false,
    }
    setColumns([...columns, newCol])
  }

  // 更新列
  const updateColumn = (id: string, updates: Partial<ColumnDefinition>) => {
    setColumns(columns.map(col => col.id === id ? { ...col, ...updates } : col))
  }

  // 删除列
  const removeColumn = (id: string) => {
    setColumns(columns.filter(col => col.id !== id))
  }

  // 添加索引
  const addIndex = () => {
    const newIdx: IndexDefinition = {
      id: `idx_${Date.now()}`,
      name: `idx_${tableName}_`,
      columns: [],
      isUnique: false,
    }
    setIndexes([...indexes, newIdx])
  }

  // 更新索引
  const updateIndex = (id: string, updates: Partial<IndexDefinition>) => {
    setIndexes(indexes.map(idx => idx.id === id ? { ...idx, ...updates } : idx))
  }

  // 删除索引
  const removeIndex = (id: string) => {
    setIndexes(indexes.filter(idx => idx.id !== id))
  }

  // 生成创建表的 SQL
  const generateCreateTableSQL = () => {
    if (!tableName || columns.length === 0) return ''
    
    const columnDefs = columns.map(col => {
      let def = `  "${col.name}" ${col.type.toUpperCase()}`
      
      // 添加长度/精度
      if (['varchar', 'char'].includes(col.type) && col.length) {
        def += `(${col.length})`
      } else if (['numeric', 'decimal'].includes(col.type)) {
        if (col.precision) {
          def += col.scale ? `(${col.precision}, ${col.scale})` : `(${col.precision})`
        }
      }
      
      // NOT NULL
      if (!col.nullable) {
        def += ' NOT NULL'
      }
      
      // DEFAULT
      if (col.defaultValue) {
        def += ` DEFAULT ${col.defaultValue}`
      }
      
      // PRIMARY KEY
      if (col.isPrimaryKey) {
        def += ' PRIMARY KEY'
      }
      
      // UNIQUE
      if (col.isUnique && !col.isPrimaryKey) {
        def += ' UNIQUE'
      }
      
      // REFERENCES
      if (col.references?.table && col.references?.column) {
        def += ` REFERENCES "${currentSchema}"."${col.references.table}"("${col.references.column}")`
      }
      
      return def
    })
    
    let sql = `CREATE TABLE "${currentSchema}"."${tableName}" (\n${columnDefs.join(',\n')}\n);`
    
    // 添加索引
    indexes.forEach(idx => {
      if (idx.name && idx.columns.length > 0) {
        const unique = idx.isUnique ? 'UNIQUE ' : ''
        const cols = idx.columns.map(c => `"${c}"`).join(', ')
        sql += `\n\nCREATE ${unique}INDEX "${idx.name}" ON "${currentSchema}"."${tableName}" (${cols});`
      }
    })
    
    return sql
  }

  // 生成修改表的 SQL
  const generateAlterTableSQL = () => {
    // 这里简化处理，实际上需要比较新旧结构的差异
    // 暂时只生成重新创建的 SQL
    return `-- 修改表结构\n-- 警告：以下操作将重建表，请确保已备份数据\n\n-- DROP TABLE IF EXISTS "${currentSchema}"."${tableName}";\n\n${generateCreateTableSQL()}`
  }

  // 预览 SQL
  const previewSQL = () => {
    const sql = mode === 'create' ? generateCreateTableSQL() : generateAlterTableSQL()
    setGeneratedSQL(sql)
    setShowPreview(true)
  }

  // 执行 SQL
  const executeSQL = async () => {
    if (!generatedSQL) return
    
    const confirmed = window.confirm(
      '确定要执行此 SQL 操作吗？\n\n' +
      (mode === 'create' 
        ? '这将创建一个新表。'
        : '这将修改现有表结构，可能导致数据丢失。')
    )
    if (!confirmed) return
    
    setExecuting(true)
    
    try {
      // 表设计器已经走过 SQL 预览 + window.confirm，意图明确；executeManaged
      // 直接带 ack，跳过通用 modal。
      await queryAPI.executeManaged(generatedSQL)
      notify.success(mode === 'create' ? '表创建成功！' : '表结构修改成功！')
      setShowPreview(false)
      loadTables()
      
      if (mode === 'create') {
        // 重置表单
        setTableName('')
        setColumns([])
        setIndexes([])
      }
    } catch (err: any) {
      notify.error(err)
    } finally {
      setExecuting(false)
    }
  }

  // 新建表
  const startCreateTable = () => {
    setMode('create')
    setSelectedTable('')
    setTableName('')
    setColumns([{
      id: 'id',
      name: 'id',
      type: 'serial',
      nullable: false,
      defaultValue: '',
      isPrimaryKey: true,
      isUnique: false,
    }])
    setIndexes([])
  }

  // 编辑表
  const startEditTable = (tableName: string) => {
    setMode('edit')
    setSelectedTable(tableName)
    loadTableStructure(tableName)
  }

  return (
    <div className="space-y-6">
      {/* 页面头部 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">表结构设计器</h1>
          <p className="text-sm text-gray-500 mt-1">
            当前 Schema: <span className="font-mono font-medium text-gray-900">{currentSchema}</span>
          </p>
        </div>
        
        <div className="flex items-center space-x-3">
          <button
            onClick={startCreateTable}
            className="btn-primary"
          >
            <i className="fas fa-plus mr-2"></i>
            新建表
          </button>
        </div>
      </div>


      <div className="grid grid-cols-12 gap-6">
        {/* 左侧：表列表 */}
        <div className="col-span-3">
          <div className="card">
            <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
              <h3 className="text-sm font-semibold text-gray-700">现有表</h3>
            </div>
            <div className="max-h-[600px] overflow-y-auto">
              {loading && tables.length === 0 ? (
                <div className="p-4 text-center text-gray-500">
                  <i className="fas fa-spinner fa-spin mr-2"></i>
                  加载中...
                </div>
              ) : tables.length === 0 ? (
                <div className="p-4 text-center text-gray-500">
                  暂无表
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {tables.map(table => (
                    <button
                      key={table.table_name}
                      onClick={() => startEditTable(table.table_name)}
                      className={`w-full px-4 py-3 text-left hover:bg-gray-50 transition-colors ${
                        selectedTable === table.table_name ? 'bg-blue-50 border-l-2 border-blue-500' : ''
                      }`}
                    >
                      <div className="flex items-center space-x-2">
                        <i className="fas fa-table text-gray-400"></i>
                        <span className="text-sm font-medium text-gray-900">{table.table_name}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 右侧：表设计器 */}
        <div className="col-span-9">
          <div className="card">
            <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <h3 className="text-sm font-semibold text-gray-700">
                  {mode === 'create' ? '创建新表' : `编辑表: ${tableName}`}
                </h3>
                <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                  mode === 'create' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'
                }`}>
                  {mode === 'create' ? '新建' : '编辑'}
                </span>
              </div>
              
              <div className="flex items-center space-x-2">
                <button
                  onClick={previewSQL}
                  disabled={!tableName || columns.length === 0}
                  className="btn-default text-sm"
                >
                  <i className="fas fa-eye mr-2"></i>
                  预览 SQL
                </button>
              </div>
            </div>

            <div className="p-4 space-y-6">
              {/* 表名 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">表名</label>
                <input
                  type="text"
                  value={tableName}
                  onChange={(e) => setTableName(e.target.value)}
                  placeholder="输入表名..."
                  className="w-64 input-base"
                  disabled={mode === 'edit'}
                />
              </div>

              {/* 列定义 */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <label className="text-sm font-medium text-gray-700">列定义</label>
                  <button
                    onClick={addColumn}
                    className="text-sm text-blue-600 hover:text-blue-800"
                  >
                    <i className="fas fa-plus mr-1"></i>
                    添加列
                  </button>
                </div>
                
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">列名</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">类型</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">长度</th>
                        <th className="px-3 py-2 text-center text-xs font-semibold text-gray-600">可空</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">默认值</th>
                        <th className="px-3 py-2 text-center text-xs font-semibold text-gray-600">主键</th>
                        <th className="px-3 py-2 text-center text-xs font-semibold text-gray-600">唯一</th>
                        <th className="px-3 py-2 text-center text-xs font-semibold text-gray-600">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {columns.map((col) => (
                        <tr key={col.id} className="hover:bg-gray-50">
                          <td className="px-3 py-2">
                            <input
                              type="text"
                              value={col.name}
                              onChange={(e) => updateColumn(col.id, { name: e.target.value })}
                              placeholder="column_name"
                              className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                          </td>
                          <td className="px-3 py-2">
                            <select
                              value={col.type}
                              onChange={(e) => updateColumn(col.id, { type: e.target.value })}
                              className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                            >
                              {DATA_TYPES.map(dt => (
                                <option key={dt.value} value={dt.value}>
                                  {dt.label}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="px-3 py-2">
                            {['varchar', 'char'].includes(col.type) && (
                              <input
                                type="number"
                                value={col.length || ''}
                                onChange={(e) => updateColumn(col.id, { length: parseInt(e.target.value) || undefined })}
                                placeholder="255"
                                className="w-20 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                              />
                            )}
                          </td>
                          <td className="px-3 py-2 text-center">
                            <input
                              type="checkbox"
                              checked={col.nullable}
                              onChange={(e) => updateColumn(col.id, { nullable: e.target.checked })}
                              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                              disabled={col.isPrimaryKey}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              type="text"
                              value={col.defaultValue}
                              onChange={(e) => updateColumn(col.id, { defaultValue: e.target.value })}
                              placeholder="NULL"
                              className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                          </td>
                          <td className="px-3 py-2 text-center">
                            <input
                              type="checkbox"
                              checked={col.isPrimaryKey}
                              onChange={(e) => updateColumn(col.id, { 
                                isPrimaryKey: e.target.checked,
                                nullable: e.target.checked ? false : col.nullable
                              })}
                              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                            />
                          </td>
                          <td className="px-3 py-2 text-center">
                            <input
                              type="checkbox"
                              checked={col.isUnique}
                              onChange={(e) => updateColumn(col.id, { isUnique: e.target.checked })}
                              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                              disabled={col.isPrimaryKey}
                            />
                          </td>
                          <td className="px-3 py-2 text-center">
                            <button
                              onClick={() => removeColumn(col.id)}
                              className="text-red-500 hover:text-red-700"
                              title="删除"
                            >
                              <i className="fas fa-trash"></i>
                            </button>
                          </td>
                        </tr>
                      ))}
                      {columns.length === 0 && (
                        <tr>
                          <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                            点击"添加列"开始设计表结构
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* 索引定义 */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <label className="text-sm font-medium text-gray-700">索引</label>
                  <button
                    onClick={addIndex}
                    disabled={columns.length === 0}
                    className="text-sm text-blue-600 hover:text-blue-800 disabled:opacity-50"
                  >
                    <i className="fas fa-plus mr-1"></i>
                    添加索引
                  </button>
                </div>
                
                {indexes.length > 0 && (
                  <div className="border border-gray-200 rounded-lg overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">索引名</th>
                          <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">列</th>
                          <th className="px-3 py-2 text-center text-xs font-semibold text-gray-600">唯一</th>
                          <th className="px-3 py-2 text-center text-xs font-semibold text-gray-600">操作</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {indexes.map((idx) => (
                          <tr key={idx.id} className="hover:bg-gray-50">
                            <td className="px-3 py-2">
                              <input
                                type="text"
                                value={idx.name}
                                onChange={(e) => updateIndex(idx.id, { name: e.target.value })}
                                placeholder="idx_table_column"
                                className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                              />
                            </td>
                            <td className="px-3 py-2">
                              <select
                                multiple
                                value={idx.columns}
                                onChange={(e) => updateIndex(idx.id, { 
                                  columns: Array.from(e.target.selectedOptions, option => option.value)
                                })}
                                className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                              >
                                {columns.map(col => (
                                  <option key={col.id} value={col.name}>
                                    {col.name}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="px-3 py-2 text-center">
                              <input
                                type="checkbox"
                                checked={idx.isUnique}
                                onChange={(e) => updateIndex(idx.id, { isUnique: e.target.checked })}
                                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                              />
                            </td>
                            <td className="px-3 py-2 text-center">
                              <button
                                onClick={() => removeIndex(idx.id)}
                                className="text-red-500 hover:text-red-700"
                                title="删除"
                              >
                                <i className="fas fa-trash"></i>
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* SQL 预览抽屉 */}
      <Drawer
        isOpen={showPreview}
        onClose={() => setShowPreview(false)}
        title="SQL 预览"
        size="xl"
        footer={
          <div className="flex gap-3">
            <button
              onClick={() => setShowPreview(false)}
              className="h-11 px-5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 hover:border-gray-400 transition-all duration-200"
            >
              关闭
            </button>
            <button
              onClick={() => {
                navigator.clipboard.writeText(generatedSQL)
                notify.success('SQL 已复制到剪贴板')
              }}
              className="h-11 px-5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 hover:border-gray-400 transition-all duration-200 flex items-center"
            >
              <i className="fas fa-copy mr-2"></i>
              复制
            </button>
            <button
              onClick={executeSQL}
              disabled={executing}
              className="flex-1 h-11 px-5 text-sm font-medium text-white bg-gradient-to-r from-green-500 to-green-600 rounded-lg hover:from-green-600 hover:to-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-sm hover:shadow-md flex items-center justify-center"
            >
              <i className={`fas ${executing ? 'fa-spinner fa-spin' : 'fa-play'} mr-2`}></i>
              {executing ? '执行中...' : '执行 SQL'}
            </button>
          </div>
        }
      >
        <pre className="bg-gray-900 text-green-400 p-4 rounded-lg text-sm font-mono whitespace-pre-wrap overflow-x-auto min-h-[400px]">
          {generatedSQL}
        </pre>
      </Drawer>
    </div>
  )
}

