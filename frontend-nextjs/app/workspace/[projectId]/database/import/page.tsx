'use client'

import { useState, useEffect, useCallback } from 'react'
import { schemaAPI, queryAPI, tableAPI } from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { useNotification } from '@/hooks/useNotification'

interface TableInfo {
  table_name: string
  table_type: string
}

interface ColumnMapping {
  csvColumn: string
  dbColumn: string
  transform?: 'none' | 'trim' | 'uppercase' | 'lowercase' | 'nullify_empty'
}

interface ImportPreview {
  columns: string[]
  rows: string[][]
  totalRows: number
}

export default function ImportPage() {
  const { currentSchema } = useAppStore()
  const notify = useNotification()
  const [tables, setTables] = useState<TableInfo[]>([])
  const [selectedTable, setSelectedTable] = useState('')
  const [tableColumns, setTableColumns] = useState<string[]>([])
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [columnMappings, setColumnMappings] = useState<ColumnMapping[]>([])
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState({ current: 0, total: 0 })
  
  // 导入选项
  const [options, setOptions] = useState({
    skipHeader: true,
    delimiter: ',',
    quoteChar: '"',
    onConflict: 'skip' as 'skip' | 'update' | 'error',
    batchSize: 100,
  })

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

  // 加载表列信息
  const loadTableColumns = useCallback(async () => {
    if (!selectedTable) return
    try {
      const response = await schemaAPI.getTableStructure(currentSchema, selectedTable)
      const columns = response.data.columns.map((c: any) => c.column_name)
      setTableColumns(columns)
    } catch (err: any) {
      console.error('加载表结构失败:', err)
    }
  }, [currentSchema, selectedTable])

  useEffect(() => {
    if (selectedTable) {
      loadTableColumns()
    }
  }, [selectedTable, loadTableColumns])

  // 解析 CSV 文件
  const parseCSV = (text: string, delimiter: string, quoteChar: string): string[][] => {
    const rows: string[][] = []
    let currentRow: string[] = []
    let currentField = ''
    let inQuotes = false
    
    for (let i = 0; i < text.length; i++) {
      const char = text[i]
      const nextChar = text[i + 1]
      
      if (inQuotes) {
        if (char === quoteChar && nextChar === quoteChar) {
          currentField += quoteChar
          i++
        } else if (char === quoteChar) {
          inQuotes = false
        } else {
          currentField += char
        }
      } else {
        if (char === quoteChar) {
          inQuotes = true
        } else if (char === delimiter) {
          currentRow.push(currentField)
          currentField = ''
        } else if (char === '\n' || (char === '\r' && nextChar === '\n')) {
          currentRow.push(currentField)
          if (currentRow.length > 0 && currentRow.some(f => f.trim())) {
            rows.push(currentRow)
          }
          currentRow = []
          currentField = ''
          if (char === '\r') i++
        } else if (char !== '\r') {
          currentField += char
        }
      }
    }
    
    // 处理最后一行
    if (currentField || currentRow.length > 0) {
      currentRow.push(currentField)
      if (currentRow.some(f => f.trim())) {
        rows.push(currentRow)
      }
    }
    
    return rows
  }

  // 解析 JSON 文件
  const parseJSON = (text: string): { columns: string[], rows: string[][] } => {
    const data = JSON.parse(text)
    const records = Array.isArray(data) ? data : [data]
    
    if (records.length === 0) {
      return { columns: [], rows: [] }
    }
    
    const columns = Object.keys(records[0])
    const rows = records.map(record => 
      columns.map(col => {
        const val = record[col]
        if (val === null || val === undefined) return ''
        if (typeof val === 'object') return JSON.stringify(val)
        return String(val)
      })
    )
    
    return { columns, rows }
  }

  // 处理文件上传
  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = event.target.files?.[0]
    if (!uploadedFile) return
    
    setFile(uploadedFile)
    setPreview(null)
    setColumnMappings([])
    
    try {
      const text = await uploadedFile.text()
      let columns: string[] = []
      let rows: string[][] = []
      
      if (uploadedFile.name.endsWith('.json')) {
        const result = parseJSON(text)
        columns = result.columns
        rows = result.rows
      } else {
        // CSV / TSV
        const delimiter = uploadedFile.name.endsWith('.tsv') ? '\t' : options.delimiter
        const allRows = parseCSV(text, delimiter, options.quoteChar)
        
        if (allRows.length === 0) {
          notify.error('文件为空或格式不正确')
          return
        }
        
        if (options.skipHeader) {
          columns = allRows[0]
          rows = allRows.slice(1)
        } else {
          columns = allRows[0].map((_, i) => `column_${i + 1}`)
          rows = allRows
        }
      }
      
      setPreview({
        columns,
        rows: rows.slice(0, 10), // 只预览前10行
        totalRows: rows.length,
      })
      
      // 自动映射列（尝试匹配名称）
      const mappings: ColumnMapping[] = columns.map(csvCol => {
        const matchedDbCol = tableColumns.find(
          dbCol => dbCol.toLowerCase() === csvCol.toLowerCase()
        )
        return {
          csvColumn: csvCol,
          dbColumn: matchedDbCol || '',
          transform: 'none',
        }
      })
      setColumnMappings(mappings)
    } catch (err: any) {
      notify.error('解析文件失败: ' + err.message)
    }
  }

  // 更新列映射
  const updateMapping = (index: number, updates: Partial<ColumnMapping>) => {
    setColumnMappings(mappings =>
      mappings.map((m, i) => i === index ? { ...m, ...updates } : m)
    )
  }

  // 执行导入
  const executeImport = async () => {
    if (!file || !selectedTable || !preview) return
    
    const validMappings = columnMappings.filter(m => m.dbColumn)
    if (validMappings.length === 0) {
      notify.warning('请至少映射一列')
      return
    }
    
    setImporting(true)
    setImportProgress({ current: 0, total: preview.totalRows })
    
    try {
      const text = await file.text()
      let allRows: string[][] = []
      
      if (file.name.endsWith('.json')) {
        const result = parseJSON(text)
        allRows = result.rows
      } else {
        const delimiter = file.name.endsWith('.tsv') ? '\t' : options.delimiter
        const parsed = parseCSV(text, delimiter, options.quoteChar)
        allRows = options.skipHeader ? parsed.slice(1) : parsed
      }
      
      // 批量导入
      let successCount = 0
      let errorCount = 0
      const csvColumnIndexes = validMappings.map(m => preview.columns.indexOf(m.csvColumn))
      
      for (let i = 0; i < allRows.length; i += options.batchSize) {
        const batch = allRows.slice(i, i + options.batchSize)
        const records = batch.map(row => {
          const record: Record<string, any> = {}
          validMappings.forEach((mapping, idx) => {
            let value: any = row[csvColumnIndexes[idx]] ?? ''
            
            // 应用转换
            switch (mapping.transform) {
              case 'trim':
                value = value.trim()
                break
              case 'uppercase':
                value = value.toUpperCase()
                break
              case 'lowercase':
                value = value.toLowerCase()
                break
              case 'nullify_empty':
                value = value.trim() === '' ? null : value
                break
            }
            
            record[mapping.dbColumn] = value === '' ? null : value
          })
          return record
        })
        
        // 逐条插入（更可靠，可以处理错误）
        for (const record of records) {
          try {
            await tableAPI.createRecord(currentSchema, selectedTable, record)
            successCount++
          } catch {
            errorCount++
          }
        }
        
        setImportProgress({ current: Math.min(i + options.batchSize, allRows.length), total: allRows.length })
      }
      
      notify.success(`导入完成！成功: ${successCount} 条，失败: ${errorCount} 条`)
    } catch (err: any) {
      notify.error(err)
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* 页面头部 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">数据导入</h1>
          <p className="text-sm text-gray-500 mt-1">
            从 CSV、JSON 文件导入数据到数据库表
          </p>
        </div>
      </div>


      {/* 步骤指示器 */}
      <div className="flex items-center space-x-4">
        <div className={`flex items-center space-x-2 ${selectedTable ? 'text-green-600' : 'text-blue-600'}`}>
          <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
            selectedTable ? 'bg-green-100' : 'bg-blue-100'
          }`}>
            {selectedTable ? <i className="fas fa-check"></i> : '1'}
          </div>
          <span className="text-sm font-medium">选择目标表</span>
        </div>
        <div className="flex-1 h-px bg-gray-300"></div>
        <div className={`flex items-center space-x-2 ${preview ? 'text-green-600' : file ? 'text-blue-600' : 'text-gray-400'}`}>
          <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
            preview ? 'bg-green-100' : file ? 'bg-blue-100' : 'bg-gray-100'
          }`}>
            {preview ? <i className="fas fa-check"></i> : '2'}
          </div>
          <span className="text-sm font-medium">上传文件</span>
        </div>
        <div className="flex-1 h-px bg-gray-300"></div>
        <div className={`flex items-center space-x-2 ${columnMappings.some(m => m.dbColumn) ? 'text-blue-600' : 'text-gray-400'}`}>
          <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
            columnMappings.some(m => m.dbColumn) ? 'bg-blue-100' : 'bg-gray-100'
          }`}>
            3
          </div>
          <span className="text-sm font-medium">映射列</span>
        </div>
        <div className="flex-1 h-px bg-gray-300"></div>
        <div className="flex items-center space-x-2 text-gray-400">
          <div className="w-8 h-8 rounded-full flex items-center justify-center bg-gray-100">
            4
          </div>
          <span className="text-sm font-medium">导入</span>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6">
        {/* 左侧：配置 */}
        <div className="col-span-4 space-y-4">
          {/* 选择表 */}
          <div className="card p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">1. 选择目标表</h3>
            <select
              value={selectedTable}
              onChange={(e) => setSelectedTable(e.target.value)}
              className="w-full input-base"
            >
              <option value="">选择表...</option>
              {tables.map(table => (
                <option key={table.table_name} value={table.table_name}>
                  {table.table_name}
                </option>
              ))}
            </select>
            {selectedTable && tableColumns.length > 0 && (
              <p className="text-xs text-gray-500 mt-2">
                表列: {tableColumns.join(', ')}
              </p>
            )}
          </div>

          {/* 上传文件 */}
          <div className="card p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">2. 上传数据文件</h3>
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:border-blue-400 transition-colors">
              <input
                type="file"
                accept=".csv,.tsv,.json"
                onChange={handleFileUpload}
                className="hidden"
                id="import-file"
                disabled={!selectedTable}
              />
              <label htmlFor="import-file" className={`cursor-pointer ${!selectedTable ? 'opacity-50' : ''}`}>
                {file ? (
                  <div>
                    <i className="fas fa-file-alt text-3xl text-blue-500 mb-2"></i>
                    <p className="text-sm font-medium text-gray-900">{file.name}</p>
                    <p className="text-xs text-gray-500">{(file.size / 1024).toFixed(2)} KB</p>
                  </div>
                ) : (
                  <>
                    <i className="fas fa-cloud-upload-alt text-3xl text-gray-400 mb-2"></i>
                    <p className="text-gray-600">点击或拖拽文件到此处</p>
                    <p className="text-xs text-gray-400 mt-1">支持 CSV, TSV, JSON</p>
                  </>
                )}
              </label>
            </div>
          </div>

          {/* 导入选项 */}
          <div className="card p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">导入选项</h3>
            <div className="space-y-3">
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={options.skipHeader}
                  onChange={(e) => setOptions({ ...options, skipHeader: e.target.checked })}
                  className="rounded border-gray-300 text-blue-600"
                />
                <span className="text-sm text-gray-700">首行为表头</span>
              </label>
              
              <div>
                <label className="block text-xs text-gray-600 mb-1">分隔符</label>
                <select
                  value={options.delimiter}
                  onChange={(e) => setOptions({ ...options, delimiter: e.target.value })}
                  className="w-full input-base text-sm"
                >
                  <option value=",">逗号 (,)</option>
                  <option value=";">分号 (;)</option>
                  <option value="\t">制表符 (Tab)</option>
                  <option value="|">竖线 (|)</option>
                </select>
              </div>
              
              <div>
                <label className="block text-xs text-gray-600 mb-1">批量大小</label>
                <input
                  type="number"
                  value={options.batchSize}
                  onChange={(e) => setOptions({ ...options, batchSize: parseInt(e.target.value) || 100 })}
                  min={1}
                  max={1000}
                  className="w-full input-base text-sm"
                />
              </div>
            </div>
          </div>
        </div>

        {/* 右侧：预览和映射 */}
        <div className="col-span-8 space-y-4">
          {/* 列映射 */}
          {preview && (
            <div className="card">
              <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
                <h3 className="text-sm font-semibold text-gray-700">3. 列映射</h3>
              </div>
              <div className="p-4">
                <div className="overflow-auto max-h-[300px]">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">文件列</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">数据库列</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">转换</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">预览值</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {columnMappings.map((mapping, idx) => (
                        <tr key={idx}>
                          <td className="px-3 py-2 font-mono text-gray-900">{mapping.csvColumn}</td>
                          <td className="px-3 py-2">
                            <select
                              value={mapping.dbColumn}
                              onChange={(e) => updateMapping(idx, { dbColumn: e.target.value })}
                              className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                            >
                              <option value="">-- 跳过 --</option>
                              {tableColumns.map(col => (
                                <option key={col} value={col}>{col}</option>
                              ))}
                            </select>
                          </td>
                          <td className="px-3 py-2">
                            <select
                              value={mapping.transform || 'none'}
                              onChange={(e) => updateMapping(idx, { transform: e.target.value as any })}
                              className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                            >
                              <option value="none">无</option>
                              <option value="trim">去空格</option>
                              <option value="uppercase">大写</option>
                              <option value="lowercase">小写</option>
                              <option value="nullify_empty">空值转NULL</option>
                            </select>
                          </td>
                          <td className="px-3 py-2 text-gray-500 font-mono text-xs max-w-[150px] truncate">
                            {preview.rows[0]?.[idx] || '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* 数据预览 */}
          {preview && (
            <div className="card">
              <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-700">数据预览</h3>
                <span className="text-xs text-gray-500">
                  共 {preview.totalRows} 行，预览前 {preview.rows.length} 行
                </span>
              </div>
              <div className="overflow-auto max-h-[300px]">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600 w-12">#</th>
                      {preview.columns.map((col, idx) => (
                        <th key={idx} className="px-3 py-2 text-left text-xs font-semibold text-gray-600">
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {preview.rows.map((row, rowIdx) => (
                      <tr key={rowIdx} className="hover:bg-gray-50">
                        <td className="px-3 py-2 text-gray-400">{rowIdx + 1}</td>
                        {row.map((cell, cellIdx) => (
                          <td key={cellIdx} className="px-3 py-2 max-w-[150px] truncate" title={cell}>
                            {cell || <span className="text-gray-300 italic">空</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 导入按钮 */}
          {preview && (
            <div className="card p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-700">
                    准备导入 <span className="font-semibold">{preview.totalRows}</span> 条记录到 
                    <span className="font-mono text-blue-600 ml-1">{currentSchema}.{selectedTable}</span>
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    已映射 {columnMappings.filter(m => m.dbColumn).length} / {columnMappings.length} 列
                  </p>
                </div>
                
                <button
                  onClick={executeImport}
                  disabled={importing || !columnMappings.some(m => m.dbColumn)}
                  className="btn-primary"
                >
                  {importing ? (
                    <>
                      <i className="fas fa-spinner fa-spin mr-2"></i>
                      导入中 ({importProgress.current}/{importProgress.total})
                    </>
                  ) : (
                    <>
                      <i className="fas fa-upload mr-2"></i>
                      开始导入
                    </>
                  )}
                </button>
              </div>
              
              {importing && (
                <div className="mt-4">
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div
                      className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                      style={{ width: `${(importProgress.current / importProgress.total) * 100}%` }}
                    ></div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

