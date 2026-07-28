'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { tableAPI, schemaAPI } from '@/lib/api'
import { useAppStore } from '@/lib/store'

interface ColumnInfo {
  column_name: string
  data_type: string
  is_nullable: string
  column_default: string | null
  ordinal_position: number
}

interface TableStructure {
  schema_name: string
  table_name: string
  columns: ColumnInfo[]
  constraints: any[]
  indexes: any[]
  foreign_keys: any[]
  row_count: number | null
  table_size: string | null
}

interface TableEditorProps {
  schema: string
  table: string
  onClose?: () => void
}

type EditingCell = {
  rowIndex: number
  column: string
} | null

type SortConfig = {
  column: string
  direction: 'asc' | 'desc'
} | null

export default function TableEditor({ schema, table, onClose }: TableEditorProps) {
  const [records, setRecords] = useState<any[]>([])
  const [structure, setStructure] = useState<TableStructure | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editingCell, setEditingCell] = useState<EditingCell>(null)
  const [editValue, setEditValue] = useState<string>('')
  const [newRow, setNewRow] = useState<Record<string, any> | null>(null)
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set())
  const [sortConfig, setSortConfig] = useState<SortConfig>(null)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [showFilters, setShowFilters] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [totalCount, setTotalCount] = useState(0)
  const [saving, setSaving] = useState(false)
  const [notification, setNotification] = useState<{ type: 'success' | 'error', message: string } | null>(null)
  
  const inputRef = useRef<HTMLInputElement>(null)

  // 获取主键列
  const getPrimaryKeyColumns = useCallback(() => {
    if (!structure) return ['id']
    const pkConstraint = structure.constraints.find(c => c.constraint_type === 'PRIMARY KEY')
    if (pkConstraint?.column_name) {
      return [pkConstraint.column_name]
    }
    // 尝试找第一个列作为标识
    return structure.columns.length > 0 ? [structure.columns[0].column_name] : ['id']
  }, [structure])

  // 加载表结构
  const loadStructure = useCallback(async () => {
    try {
      const response = await schemaAPI.getTableStructure(schema, table)
      setStructure(response.data)
    } catch (err: any) {
      console.error('加载表结构失败:', err)
    }
  }, [schema, table])

  // 加载数据
  const loadRecords = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params: Record<string, any> = {
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }
      
      // 添加排序
      if (sortConfig) {
        params.order = `${sortConfig.column}.${sortConfig.direction}`
      }
      
      // 添加筛选条件
      Object.entries(filters).forEach(([key, value]) => {
        if (value) {
          params[`${key}.ilike`] = `%${value}%`
        }
      })
      
      const response = await tableAPI.getRecords(schema, table, params)
      const data = Array.isArray(response.data) ? response.data : (response.data.data || [])
      setRecords(data)
      
      // 估算总数
      if (structure?.row_count) {
        setTotalCount(structure.row_count)
      } else {
        setTotalCount(data.length >= pageSize ? (page * pageSize) + 1 : (page - 1) * pageSize + data.length)
      }
    } catch (err: any) {
      console.error('加载数据失败:', err)
      setError(err.response?.data?.error || err.message || '加载失败')
      setRecords([])
    } finally {
      setLoading(false)
    }
  }, [schema, table, page, pageSize, sortConfig, filters, structure])

  useEffect(() => {
    loadStructure()
  }, [loadStructure])

  useEffect(() => {
    if (structure) {
      loadRecords()
    }
  }, [loadRecords, structure])

  // 聚焦编辑输入框
  useEffect(() => {
    if (editingCell && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingCell])

  // 显示通知
  const showNotification = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message })
    setTimeout(() => setNotification(null), 3000)
  }

  // 开始编辑单元格
  const startEditing = (rowIndex: number, column: string, value: any) => {
    setEditingCell({ rowIndex, column })
    setEditValue(value === null ? '' : String(value))
  }

  // 保存单元格编辑
  const saveCell = async () => {
    if (!editingCell || !structure) return
    
    const { rowIndex, column } = editingCell
    const row = records[rowIndex]
    const oldValue = row[column]
    
    // 如果值没有变化，直接取消编辑
    if (String(oldValue ?? '') === editValue) {
      setEditingCell(null)
      return
    }
    
    setSaving(true)
    try {
      // 构建主键条件
      const pkColumns = getPrimaryKeyColumns()
      const conditions: Record<string, any> = {}
      pkColumns.forEach(pk => {
        conditions[pk] = row[pk]
      })
      
      // 转换值类型
      let newValue: any = editValue
      const columnInfo = structure.columns.find(c => c.column_name === column)
      if (columnInfo) {
        if (editValue === '' && columnInfo.is_nullable === 'YES') {
          newValue = null
        } else if (['integer', 'bigint', 'smallint'].includes(columnInfo.data_type)) {
          newValue = parseInt(editValue, 10)
        } else if (['numeric', 'decimal', 'real', 'double precision'].includes(columnInfo.data_type)) {
          newValue = parseFloat(editValue)
        } else if (columnInfo.data_type === 'boolean') {
          newValue = editValue.toLowerCase() === 'true' || editValue === '1'
        }
      }
      
      await tableAPI.updateRecord(schema, table, conditions, { [column]: newValue })
      
      // 更新本地数据
      const newRecords = [...records]
      newRecords[rowIndex] = { ...newRecords[rowIndex], [column]: newValue }
      setRecords(newRecords)
      
      showNotification('success', '保存成功')
    } catch (err: any) {
      console.error('保存失败:', err)
      showNotification('error', err.response?.data?.error || '保存失败')
    } finally {
      setSaving(false)
      setEditingCell(null)
    }
  }

  // 取消编辑
  const cancelEditing = () => {
    setEditingCell(null)
    setEditValue('')
  }

  /**
   * 判断 column_default 是否是"函数 / 表达式"型默认值（不能作为字面量发到后端）。
   *
   * 例：`nextval('user_id_seq'::regclass)` / `now()` / `CURRENT_TIMESTAMP` /
   *     `gen_random_uuid()` / `'pending'::text`（带 cast 的） 等。
   *
   * 这些默认值如果原样塞进 INSERT body 会被当成字符串字面量，PostgreSQL 不会
   * 解析执行——而是尝试把字符串塞进列里（`"nextval(...)"` 塞进 SERIAL 列必然失败）。
   * 唯一正确的做法：从 payload 里**忽略**掉这一列，让 PG 自己用 DEFAULT。
   */
  const isFunctionDefault = (def: string | null): boolean => {
    if (!def) return false
    // 形如 `something(...)` 的函数调用
    if (/\b\w+\s*\(/.test(def)) return true
    // sequence 的强转：`'foo'::regclass`
    if (/::regclass\b/i.test(def)) return true
    // 零参 SQL 关键字
    if (
      /^(CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|CURRENT_USER|SESSION_USER|LOCALTIMESTAMP|LOCALTIME)\b/i.test(
        def,
      )
    ) {
      return true
    }
    return false
  }

  // 添加新行
  const startNewRow = () => {
    if (!structure) return
    const emptyRow: Record<string, any> = {}
    structure.columns.forEach(col => {
      // 函数/表达式式默认值不预填——saveNewRow 会把 null/'' 过滤掉，
      // 让后端的 INSERT 绕过该列，从而触发 PostgreSQL 的 DEFAULT。
      emptyRow[col.column_name] = isFunctionDefault(col.column_default)
        ? null
        : col.column_default || null
    })
    setNewRow(emptyRow)
  }

  // 保存新行
  const saveNewRow = async () => {
    if (!newRow) return

    setSaving(true)
    try {
      // 过滤规则：
      // 1) null / '' 直接丢弃；
      // 2) 该列的默认值是函数表达式（nextval / now() / ...）且当前值仍等于
      //    那个表达式字符串（用户没改），同样丢弃——必须让 PG 走 DEFAULT，
      //    不能把字面量字符串塞进非 text 列。
      const defaultByCol = new Map<string, string | null>()
      structure?.columns.forEach((c) =>
        defaultByCol.set(c.column_name, c.column_default),
      )

      const dataToSave: Record<string, any> = {}
      Object.entries(newRow).forEach(([key, value]) => {
        if (value === null || value === '') return
        const def = defaultByCol.get(key) ?? null
        if (isFunctionDefault(def) && value === def) return
        dataToSave[key] = value
      })
      
      const response = await tableAPI.createRecord(schema, table, dataToSave)
      setNewRow(null)
      showNotification('success', '添加成功')
      loadRecords() // 重新加载数据
    } catch (err: any) {
      console.error('添加失败:', err)
      showNotification('error', err.response?.data?.error || '添加失败')
    } finally {
      setSaving(false)
    }
  }

  // 删除选中的行
  const deleteSelectedRows = async () => {
    if (selectedRows.size === 0) return
    
    const confirmed = window.confirm(`确定要删除选中的 ${selectedRows.size} 条记录吗？此操作不可撤销。`)
    if (!confirmed) return
    
    setSaving(true)
    const pkColumns = getPrimaryKeyColumns()
    let successCount = 0
    let failCount = 0
    
    for (const rowIndex of selectedRows) {
      const row = records[rowIndex]
      try {
        const conditions: Record<string, any> = {}
        pkColumns.forEach(pk => {
          conditions[pk] = row[pk]
        })
        await tableAPI.deleteRecord(schema, table, conditions)
        successCount++
      } catch (err) {
        failCount++
      }
    }
    
    setSaving(false)
    setSelectedRows(new Set())
    
    if (failCount === 0) {
      showNotification('success', `成功删除 ${successCount} 条记录`)
    } else {
      showNotification('error', `删除完成: ${successCount} 成功, ${failCount} 失败`)
    }
    
    loadRecords()
  }

  // 切换排序
  const toggleSort = (column: string) => {
    setSortConfig(prev => {
      if (prev?.column === column) {
        if (prev.direction === 'asc') {
          return { column, direction: 'desc' }
        }
        return null
      }
      return { column, direction: 'asc' }
    })
    setPage(1)
  }

  // 全选/取消全选
  const toggleSelectAll = () => {
    if (selectedRows.size === records.length) {
      setSelectedRows(new Set())
    } else {
      setSelectedRows(new Set(records.map((_, i) => i)))
    }
  }

  // 切换单行选择
  const toggleRowSelection = (index: number) => {
    const newSelected = new Set(selectedRows)
    if (newSelected.has(index)) {
      newSelected.delete(index)
    } else {
      newSelected.add(index)
    }
    setSelectedRows(newSelected)
  }

  // 渲染单元格内容
  const renderCellValue = (value: any, column: string, rowIndex: number) => {
    if (editingCell?.rowIndex === rowIndex && editingCell?.column === column) {
      return (
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={saveCell}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              saveCell()
            } else if (e.key === 'Escape') {
              cancelEditing()
            }
          }}
          className="w-full px-2 py-1 text-sm border border-blue-500 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={saving}
        />
      )
    }
    
    if (value === null) {
      return <span className="text-gray-400 italic text-xs">NULL</span>
    }
    
    if (typeof value === 'boolean') {
      return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
          value ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'
        }`}>
          {value ? 'true' : 'false'}
        </span>
      )
    }
    
    if (typeof value === 'object') {
      return (
        <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded max-w-[200px] truncate block">
          {JSON.stringify(value)}
        </code>
      )
    }
    
    const strValue = String(value)
    if (strValue.length > 100) {
      return (
        <span title={strValue} className="block max-w-[200px] truncate">
          {strValue}
        </span>
      )
    }
    
    return strValue
  }

  // 渲染新行输入
  const renderNewRowCell = (column: ColumnInfo) => {
    if (!newRow) return null

    const value = newRow[column.column_name]
    const isAutoIncrement = column.column_default?.includes('nextval')

    if (isAutoIncrement) {
      return <span className="text-gray-400 italic text-xs">自动生成</span>
    }

    // 其余函数式默认（now()、CURRENT_TIMESTAMP、gen_random_uuid() 等）依然给输入框，
    // 但提示用户不填会用默认值。
    const isFnDefault = isFunctionDefault(column.column_default)
    const placeholder = isFnDefault
      ? `默认: ${column.column_default}`
      : column.is_nullable === 'YES'
      ? 'NULL'
      : '必填'

    return (
      <input
        type="text"
        value={value ?? ''}
        onChange={(e) =>
          setNewRow({ ...newRow, [column.column_name]: e.target.value || null })
        }
        placeholder={placeholder}
        className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    )
  }

  const columns = structure?.columns || []
  const totalPages = Math.ceil(totalCount / pageSize)

  return (
    <div className="h-full flex flex-col bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
      {/* 工具栏 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
        <div className="flex items-center space-x-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">{schema}.{table}</h2>
            <p className="text-xs text-gray-500">
              {totalCount} 条记录 {structure?.table_size && `· ${structure.table_size}`}
            </p>
          </div>
        </div>
        
        <div className="flex items-center space-x-2">
          {/* 筛选按钮 */}
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`btn-default text-xs ${showFilters ? 'bg-blue-50 border-blue-300' : ''}`}
          >
            <i className="fas fa-filter mr-1.5"></i>
            筛选
          </button>
          
          {/* 添加行按钮 */}
          <button
            onClick={startNewRow}
            disabled={!!newRow}
            className="btn-primary text-xs"
          >
            <i className="fas fa-plus mr-1.5"></i>
            添加行
          </button>
          
          {/* 删除按钮 */}
          {selectedRows.size > 0 && (
            <button
              onClick={deleteSelectedRows}
              disabled={saving}
              className="btn-danger text-xs"
            >
              <i className="fas fa-trash mr-1.5"></i>
              删除 ({selectedRows.size})
            </button>
          )}
          
          {/* 刷新按钮 */}
          <button
            onClick={loadRecords}
            disabled={loading}
            className="btn-default text-xs"
          >
            <i className={`fas ${loading ? 'fa-spinner fa-spin' : 'fa-sync-alt'} mr-1.5`}></i>
            刷新
          </button>
        </div>
      </div>
      
      {/* 筛选栏 */}
      {showFilters && columns.length > 0 && (
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
          <div className="flex flex-wrap gap-2">
            {columns.slice(0, 6).map(col => (
              <div key={col.column_name} className="flex items-center space-x-1">
                <span className="text-xs text-gray-600">{col.column_name}:</span>
                <input
                  type="text"
                  value={filters[col.column_name] || ''}
                  onChange={(e) => {
                    setFilters({ ...filters, [col.column_name]: e.target.value })
                    setPage(1)
                  }}
                  placeholder="搜索..."
                  className="w-28 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            ))}
            {Object.keys(filters).some(k => filters[k]) && (
              <button
                onClick={() => {
                  setFilters({})
                  setPage(1)
                }}
                className="text-xs text-blue-600 hover:text-blue-800"
              >
                清除筛选
              </button>
            )}
          </div>
        </div>
      )}
      
      {/* 通知 */}
      {notification && (
        <div className={`px-4 py-2 text-sm ${
          notification.type === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
        }`}>
          <i className={`fas ${notification.type === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle'} mr-2`}></i>
          {notification.message}
        </div>
      )}
      
      {/* 错误提示 */}
      {error && (
        <div className="px-4 py-3 bg-red-50 border-b border-red-200">
          <p className="text-sm text-red-600">
            <i className="fas fa-exclamation-circle mr-2"></i>
            {error}
          </p>
        </div>
      )}
      
      {/* 表格 */}
      <div className="flex-1 overflow-auto">
        {loading && records.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <i className="fas fa-spinner fa-spin text-3xl text-blue-500 mb-3"></i>
              <p className="text-gray-500">加载中...</p>
            </div>
          </div>
        ) : columns.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <i className="fas fa-table text-4xl text-gray-300 mb-3"></i>
              <p className="text-gray-500">无法加载表结构</p>
            </div>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10">
              <tr className="bg-gray-100 border-b border-gray-200">
                {/* 选择列 */}
                <th className="w-10 px-3 py-2 text-center">
                  <input
                    type="checkbox"
                    checked={records.length > 0 && selectedRows.size === records.length}
                    onChange={toggleSelectAll}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                </th>
                {/* 数据列 */}
                {columns.map(col => (
                  <th
                    key={col.column_name}
                    className="px-3 py-2 text-left text-xs font-semibold text-gray-700 cursor-pointer hover:bg-gray-200 select-none"
                    onClick={() => toggleSort(col.column_name)}
                  >
                    <div className="flex items-center space-x-1">
                      <span>{col.column_name}</span>
                      <span className="text-gray-400 font-normal">
                        {col.data_type}
                        {col.is_nullable === 'NO' && <span className="text-red-400 ml-0.5">*</span>}
                      </span>
                      {sortConfig?.column === col.column_name && (
                        <i className={`fas fa-sort-${sortConfig.direction === 'asc' ? 'up' : 'down'} text-blue-500`}></i>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* 新行 */}
              {newRow && (
                <tr className="bg-green-50 border-b border-green-200">
                  <td className="px-3 py-2 text-center">
                    <div className="flex items-center space-x-1">
                      <button
                        onClick={saveNewRow}
                        disabled={saving}
                        className="text-green-600 hover:text-green-800"
                        title="保存"
                      >
                        <i className={`fas ${saving ? 'fa-spinner fa-spin' : 'fa-check'}`}></i>
                      </button>
                      <button
                        onClick={() => setNewRow(null)}
                        disabled={saving}
                        className="text-red-600 hover:text-red-800"
                        title="取消"
                      >
                        <i className="fas fa-times"></i>
                      </button>
                    </div>
                  </td>
                  {columns.map(col => (
                    <td key={col.column_name} className="px-3 py-2">
                      {renderNewRowCell(col)}
                    </td>
                  ))}
                </tr>
              )}
              
              {/* 数据行 */}
              {records.map((row, rowIndex) => (
                <tr
                  key={rowIndex}
                  className={`border-b border-gray-100 ${
                    selectedRows.has(rowIndex)
                      ? 'bg-blue-50'
                      : 'hover:bg-gray-50'
                  }`}
                >
                  <td className="px-3 py-2 text-center">
                    <input
                      type="checkbox"
                      checked={selectedRows.has(rowIndex)}
                      onChange={() => toggleRowSelection(rowIndex)}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                  </td>
                  {columns.map(col => (
                    <td
                      key={col.column_name}
                      className="px-3 py-2 cursor-pointer"
                      onDoubleClick={() => startEditing(rowIndex, col.column_name, row[col.column_name])}
                    >
                      {renderCellValue(row[col.column_name], col.column_name, rowIndex)}
                    </td>
                  ))}
                </tr>
              ))}
              
              {/* 空状态 */}
              {records.length === 0 && !loading && (
                <tr>
                  <td colSpan={columns.length + 1} className="px-4 py-12 text-center">
                    <i className="fas fa-inbox text-4xl text-gray-300 mb-3"></i>
                    <p className="text-gray-500">暂无数据</p>
                    <button
                      onClick={startNewRow}
                      className="mt-3 text-blue-600 hover:text-blue-800 text-sm"
                    >
                      <i className="fas fa-plus mr-1"></i>
                      添加第一条记录
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      
      {/* 分页栏 */}
      <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 bg-gray-50">
        <div className="flex items-center space-x-4">
          <span className="text-sm text-gray-600">
            显示 {(page - 1) * pageSize + 1} - {Math.min(page * pageSize, totalCount)} / {totalCount} 条
          </span>
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value))
              setPage(1)
            }}
            className="text-sm border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value={25}>25 条/页</option>
            <option value={50}>50 条/页</option>
            <option value={100}>100 条/页</option>
            <option value={200}>200 条/页</option>
          </select>
        </div>
        
        <div className="flex items-center space-x-2">
          <button
            onClick={() => setPage(1)}
            disabled={page === 1}
            className="px-2 py-1 text-sm border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <i className="fas fa-angle-double-left"></i>
          </button>
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-2 py-1 text-sm border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <i className="fas fa-angle-left"></i>
          </button>
          <span className="px-3 py-1 text-sm">
            第 {page} 页 / {totalPages || 1}
          </span>
          <button
            onClick={() => setPage(p => p + 1)}
            disabled={page >= totalPages}
            className="px-2 py-1 text-sm border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <i className="fas fa-angle-right"></i>
          </button>
          <button
            onClick={() => setPage(totalPages)}
            disabled={page >= totalPages}
            className="px-2 py-1 text-sm border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <i className="fas fa-angle-double-right"></i>
          </button>
        </div>
      </div>
    </div>
  )
}

