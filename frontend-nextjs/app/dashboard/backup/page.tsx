'use client'

import { useState, useEffect } from 'react'
import { queryAPI } from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { formatDateTime } from '@/lib/utils'
import { useNotification } from '@/hooks/useNotification'
import Drawer from '@/components/Drawer'
import { BRAND } from '@/lib/brand'

interface BackupInfo {
  id: string
  name: string
  type: 'full' | 'schema' | 'table'
  status: 'pending' | 'running' | 'completed' | 'failed'
  size?: string
  createdAt: string
  completedAt?: string
  error?: string
}

interface DatabaseInfo {
  database_name: string
  database_size: string
  table_count: number
}

export default function BackupPage() {
  const { currentSchema, currentConnection } = useAppStore()
  const notify = useNotification()
  const [dbInfo, setDbInfo] = useState<DatabaseInfo | null>(null)
  const [backups, setBackups] = useState<BackupInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [showBackupDialog, setShowBackupDialog] = useState(false)
  const [showRestoreDialog, setShowRestoreDialog] = useState(false)
  
  // 备份选项
  const [backupOptions, setBackupOptions] = useState({
    type: 'schema' as 'full' | 'schema' | 'table',
    format: 'sql' as 'sql' | 'custom',
    includeData: true,
    includeSchema: true,
    tableName: '',
  })

  // 加载数据库信息
  const loadDbInfo = async () => {
    try {
      const result = await queryAPI.execute(`
        SELECT 
          current_database() as database_name,
          pg_size_pretty(pg_database_size(current_database())) as database_size,
          (SELECT count(*) FROM information_schema.tables WHERE table_schema = '${currentSchema}')::int as table_count
      `)
      if (result.data.data?.length > 0) {
        setDbInfo(result.data.data[0])
      }
    } catch (err: any) {
      console.error('加载数据库信息失败:', err)
    }
  }

  // 加载备份历史（从 localStorage）
  const loadBackups = () => {
    const saved = localStorage.getItem('backup_history')
    if (saved) {
      setBackups(JSON.parse(saved))
    }
  }

  // 保存备份历史
  const saveBackups = (newBackups: BackupInfo[]) => {
    setBackups(newBackups)
    localStorage.setItem('backup_history', JSON.stringify(newBackups))
  }

  useEffect(() => {
    loadDbInfo()
    loadBackups()
  }, [currentSchema])

  // 生成备份 SQL
  const generateBackupSQL = async () => {
    setLoading(true)
    
    try {
      let sql = ''
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      
      if (backupOptions.type === 'schema' || backupOptions.type === 'full') {
        // 获取 Schema 中所有表的 CREATE TABLE 语句
        if (backupOptions.includeSchema) {
          const tablesResult = await queryAPI.execute(`
            SELECT table_name FROM information_schema.tables 
            WHERE table_schema = '${currentSchema}' AND table_type = 'BASE TABLE'
            ORDER BY table_name
          `)
          
          const tables = tablesResult.data.data || []
          sql += `-- ${BRAND} Database Backup\n`
          sql += `-- Schema: ${currentSchema}\n`
          sql += `-- Date: ${new Date().toISOString()}\n`
          sql += `-- Tables: ${tables.length}\n\n`
          
          for (const table of tables) {
            // 获取表结构
            const structureResult = await queryAPI.execute(`
              SELECT 
                'CREATE TABLE IF NOT EXISTS "${currentSchema}"."${table.table_name}" (' ||
                string_agg(
                  '"' || column_name || '" ' || 
                  CASE 
                    WHEN data_type = 'character varying' THEN 'VARCHAR(' || character_maximum_length || ')'
                    WHEN data_type = 'character' THEN 'CHAR(' || character_maximum_length || ')'
                    WHEN data_type = 'numeric' THEN 'NUMERIC(' || COALESCE(numeric_precision::text, '') || ',' || COALESCE(numeric_scale::text, '') || ')'
                    ELSE UPPER(data_type)
                  END ||
                  CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END ||
                  CASE WHEN column_default IS NOT NULL THEN ' DEFAULT ' || column_default ELSE '' END,
                  ', '
                  ORDER BY ordinal_position
                ) || ');' as create_statement
              FROM information_schema.columns
              WHERE table_schema = '${currentSchema}' AND table_name = '${table.table_name}'
              GROUP BY table_name
            `)
            
            if (structureResult.data.data?.[0]?.create_statement) {
              sql += `\n-- Table: ${table.table_name}\n`
              sql += structureResult.data.data[0].create_statement + '\n'
            }
          }
        }
        
        // 导出数据
        if (backupOptions.includeData) {
          const tablesResult = await queryAPI.execute(`
            SELECT table_name FROM information_schema.tables 
            WHERE table_schema = '${currentSchema}' AND table_type = 'BASE TABLE'
            ORDER BY table_name
          `)
          
          sql += '\n-- Data\n'
          
          for (const table of tablesResult.data.data || []) {
            const dataResult = await queryAPI.execute(`
              SELECT * FROM "${currentSchema}"."${table.table_name}" LIMIT 1000
            `)
            
            if (dataResult.data.data?.length > 0) {
              const rows = dataResult.data.data
              const columns = Object.keys(rows[0])
              
              sql += `\n-- Data for ${table.table_name}\n`
              
              for (const row of rows) {
                const values = columns.map(col => {
                  const val = row[col]
                  if (val === null) return 'NULL'
                  if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`
                  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE'
                  if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`
                  return val
                })
                
                sql += `INSERT INTO "${currentSchema}"."${table.table_name}" (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${values.join(', ')});\n`
              }
            }
          }
        }
      } else if (backupOptions.type === 'table' && backupOptions.tableName) {
        // 单表备份
        sql += `-- ${BRAND} Table Backup\n`
        sql += `-- Table: ${currentSchema}.${backupOptions.tableName}\n`
        sql += `-- Date: ${new Date().toISOString()}\n\n`
        
        if (backupOptions.includeSchema) {
          const structureResult = await queryAPI.execute(`
            SELECT 
              'CREATE TABLE IF NOT EXISTS "${currentSchema}"."${backupOptions.tableName}" (' ||
              string_agg(
                '"' || column_name || '" ' || 
                CASE 
                  WHEN data_type = 'character varying' THEN 'VARCHAR(' || character_maximum_length || ')'
                  WHEN data_type = 'character' THEN 'CHAR(' || character_maximum_length || ')'
                  ELSE UPPER(data_type)
                END ||
                CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END ||
                CASE WHEN column_default IS NOT NULL THEN ' DEFAULT ' || column_default ELSE '' END,
                ', '
                ORDER BY ordinal_position
              ) || ');' as create_statement
            FROM information_schema.columns
            WHERE table_schema = '${currentSchema}' AND table_name = '${backupOptions.tableName}'
            GROUP BY table_name
          `)
          
          if (structureResult.data.data?.[0]?.create_statement) {
            sql += structureResult.data.data[0].create_statement + '\n'
          }
        }
        
        if (backupOptions.includeData) {
          const dataResult = await queryAPI.execute(`
            SELECT * FROM "${currentSchema}"."${backupOptions.tableName}"
          `)
          
          if (dataResult.data.data?.length > 0) {
            const rows = dataResult.data.data
            const columns = Object.keys(rows[0])
            
            sql += `\n-- Data\n`
            
            for (const row of rows) {
              const values = columns.map(col => {
                const val = row[col]
                if (val === null) return 'NULL'
                if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`
                if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE'
                if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`
                return val
              })
              
              sql += `INSERT INTO "${currentSchema}"."${backupOptions.tableName}" (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${values.join(', ')});\n`
            }
          }
        }
      }
      
      // 创建备份记录
      const backup: BackupInfo = {
        id: Date.now().toString(),
        name: `backup_${currentSchema}_${timestamp}.sql`,
        type: backupOptions.type,
        status: 'completed',
        size: `${(sql.length / 1024).toFixed(2)} KB`,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }
      
      // 保存到历史
      saveBackups([backup, ...backups].slice(0, 20))
      
      // 下载文件
      const blob = new Blob([sql], { type: 'application/sql' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = backup.name
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      
      notify.success('备份已生成并下载')
      setShowBackupDialog(false)
    } catch (err: any) {
      notify.error(err)
    } finally {
      setLoading(false)
    }
  }

  // 恢复功能（执行上传的 SQL）
  const handleRestore = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    
    const confirmed = window.confirm(
      '⚠️ 警告：恢复操作可能会覆盖现有数据！\n\n' +
      '请确保您已备份当前数据。\n\n' +
      '确定要继续吗？'
    )
    if (!confirmed) return
    
    setLoading(true)
    
    try {
      const text = await file.text()
      
      // 分割 SQL 语句并执行
      const statements = text
        .split(';')
        .map(s => s.trim())
        .filter(s => s && !s.startsWith('--'))
      
      let successCount = 0
      let failCount = 0
      
      for (const statement of statements) {
        if (!statement) continue
        try {
          // 用户已经在恢复对话里上传了 .sql 文件并点了确认；每条语句直接
          // 走 executeManaged 带 ack（CREATE / INSERT / ALTER 都会出现）。
          await queryAPI.executeManaged(statement + ';')
          successCount++
        } catch {
          failCount++
        }
      }
      
      notify.success(`恢复完成：${successCount} 条语句成功，${failCount} 条失败`)
      setShowRestoreDialog(false)
    } catch (err: any) {
      notify.error(err)
    } finally {
      setLoading(false)
      // 清空文件输入
      event.target.value = ''
    }
  }

  return (
    <div className="space-y-6">
      {/* 页面头部 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">数据库备份与恢复</h1>
          <p className="text-sm text-gray-500 mt-1">
            创建数据库备份或从备份文件恢复
          </p>
        </div>
        
        <div className="flex items-center space-x-3">
          <button
            onClick={() => setShowRestoreDialog(true)}
            className="btn-default"
          >
            <i className="fas fa-upload mr-2"></i>
            恢复
          </button>
          <button
            onClick={() => setShowBackupDialog(true)}
            className="btn-primary"
          >
            <i className="fas fa-download mr-2"></i>
            创建备份
          </button>
        </div>
      </div>


      {/* 数据库概览 */}
      <div className="grid grid-cols-3 gap-6">
        <div className="card p-6">
          <div className="flex items-center space-x-4">
            <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
              <i className="fas fa-database text-blue-600 text-xl"></i>
            </div>
            <div>
              <p className="text-sm text-gray-500">当前数据库</p>
              <p className="text-xl font-semibold text-gray-900">
                {dbInfo?.database_name || '-'}
              </p>
            </div>
          </div>
        </div>
        
        <div className="card p-6">
          <div className="flex items-center space-x-4">
            <div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center">
              <i className="fas fa-hdd text-green-600 text-xl"></i>
            </div>
            <div>
              <p className="text-sm text-gray-500">数据库大小</p>
              <p className="text-xl font-semibold text-gray-900">
                {dbInfo?.database_size || '-'}
              </p>
            </div>
          </div>
        </div>
        
        <div className="card p-6">
          <div className="flex items-center space-x-4">
            <div className="w-12 h-12 bg-purple-100 rounded-lg flex items-center justify-center">
              <i className="fas fa-table text-purple-600 text-xl"></i>
            </div>
            <div>
              <p className="text-sm text-gray-500">{currentSchema} 中的表</p>
              <p className="text-xl font-semibold text-gray-900">
                {dbInfo?.table_count || 0}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* 备份历史 */}
      <div className="card">
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-700">备份历史</h3>
          {backups.length > 0 && (
            <button
              onClick={() => {
                if (window.confirm('确定要清空备份历史吗？')) {
                  saveBackups([])
                }
              }}
              className="text-xs text-red-600 hover:text-red-700"
            >
              <i className="fas fa-trash mr-1"></i>
              清空历史
            </button>
          )}
        </div>
        
        {backups.length === 0 ? (
          <div className="p-8 text-center">
            <i className="fas fa-archive text-4xl text-gray-300 mb-3"></i>
            <p className="text-gray-500">暂无备份记录</p>
            <p className="text-sm text-gray-400 mt-1">点击"创建备份"开始您的第一次备份</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {backups.map(backup => (
              <div key={backup.id} className="p-4 hover:bg-gray-50">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-4">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                      backup.status === 'completed' ? 'bg-green-100' :
                      backup.status === 'failed' ? 'bg-red-100' :
                      'bg-yellow-100'
                    }`}>
                      <i className={`fas ${
                        backup.status === 'completed' ? 'fa-check text-green-600' :
                        backup.status === 'failed' ? 'fa-times text-red-600' :
                        'fa-spinner fa-spin text-yellow-600'
                      }`}></i>
                    </div>
                    <div>
                      <p className="font-medium text-gray-900">{backup.name}</p>
                      <div className="flex items-center space-x-3 mt-1 text-xs text-gray-500">
                        <span className={`px-1.5 py-0.5 rounded ${
                          backup.type === 'full' ? 'bg-purple-100 text-purple-700' :
                          backup.type === 'schema' ? 'bg-blue-100 text-blue-700' :
                          'bg-gray-100 text-gray-700'
                        }`}>
                          {backup.type === 'full' ? '完整备份' :
                           backup.type === 'schema' ? 'Schema 备份' : '表备份'}
                        </span>
                        {backup.size && <span>{backup.size}</span>}
                        <span>{formatDateTime(backup.createdAt)}</span>
                      </div>
                    </div>
                  </div>
                  
                  <div className="flex items-center space-x-2">
                    <span className={`text-xs px-2 py-1 rounded-full ${
                      backup.status === 'completed' ? 'bg-green-100 text-green-700' :
                      backup.status === 'failed' ? 'bg-red-100 text-red-700' :
                      'bg-yellow-100 text-yellow-700'
                    }`}>
                      {backup.status === 'completed' ? '已完成' :
                       backup.status === 'failed' ? '失败' :
                       backup.status === 'running' ? '进行中' : '等待中'}
                    </span>
                  </div>
                </div>
                {backup.error && (
                  <p className="mt-2 text-sm text-red-600">{backup.error}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 创建备份抽屉 */}
      <Drawer
        isOpen={showBackupDialog}
        onClose={() => setShowBackupDialog(false)}
        title="创建备份"
        size="md"
        footer={
          <div className="flex gap-3">
            <button
              onClick={() => setShowBackupDialog(false)}
              className="flex-1 h-11 px-5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 hover:border-gray-400 transition-all duration-200"
            >
              取消
            </button>
            <button
              onClick={generateBackupSQL}
              disabled={loading || (backupOptions.type === 'table' && !backupOptions.tableName)}
              className="flex-1 h-11 px-5 text-sm font-medium text-white bg-gradient-to-r from-blue-500 to-blue-600 rounded-lg hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-sm hover:shadow-md flex items-center justify-center"
            >
              {loading ? (
                <>
                  <i className="fas fa-spinner fa-spin mr-2"></i>
                  生成中...
                </>
              ) : (
                <>
                  <i className="fas fa-download mr-2"></i>
                  生成备份
                </>
              )}
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">备份类型</label>
            <div className="grid grid-cols-2 gap-3">
              {(['schema', 'table'] as const).map(type => (
                <button
                  key={type}
                  onClick={() => setBackupOptions({ ...backupOptions, type })}
                  className={`p-4 border-2 rounded-lg text-center transition-colors ${
                    backupOptions.type === type
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <i className={`fas ${
                    type === 'schema' ? 'fa-layer-group' : 'fa-table'
                  } text-xl mb-2`}></i>
                  <p className="text-sm font-medium">
                    {type === 'schema' ? 'Schema 备份' : '单表备份'}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {type === 'schema' ? '备份整个 Schema' : '备份指定表'}
                  </p>
                </button>
              ))}
            </div>
          </div>
          
          {backupOptions.type === 'table' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">选择表</label>
              <input
                type="text"
                value={backupOptions.tableName}
                onChange={(e) => setBackupOptions({ ...backupOptions, tableName: e.target.value })}
                placeholder="输入表名..."
                className="w-full input-base"
              />
            </div>
          )}
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">备份内容</label>
            <div className="space-y-2">
              <label className="flex items-center space-x-3 p-3 bg-gray-50 rounded-lg hover:bg-gray-100 cursor-pointer">
                <input
                  type="checkbox"
                  checked={backupOptions.includeSchema}
                  onChange={(e) => setBackupOptions({ ...backupOptions, includeSchema: e.target.checked })}
                  className="rounded border-gray-300 text-blue-600 w-4 h-4"
                />
                <div>
                  <span className="text-sm font-medium text-gray-900">包含表结构</span>
                  <p className="text-xs text-gray-500">CREATE TABLE 语句</p>
                </div>
              </label>
              <label className="flex items-center space-x-3 p-3 bg-gray-50 rounded-lg hover:bg-gray-100 cursor-pointer">
                <input
                  type="checkbox"
                  checked={backupOptions.includeData}
                  onChange={(e) => setBackupOptions({ ...backupOptions, includeData: e.target.checked })}
                  className="rounded border-gray-300 text-blue-600 w-4 h-4"
                />
                <div>
                  <span className="text-sm font-medium text-gray-900">包含数据</span>
                  <p className="text-xs text-gray-500">INSERT 语句</p>
                </div>
              </label>
            </div>
          </div>
          
          <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
            <p className="text-sm text-yellow-700">
              <i className="fas fa-info-circle mr-2"></i>
              备份将生成 SQL 文件并自动下载。大型数据库可能需要较长时间。
            </p>
          </div>
        </div>
      </Drawer>

      {/* 恢复抽屉 */}
      <Drawer
        isOpen={showRestoreDialog}
        onClose={() => setShowRestoreDialog(false)}
        title="恢复数据库"
        size="md"
        footer={
          <button
            onClick={() => setShowRestoreDialog(false)}
            className="w-full h-11 px-5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 hover:border-gray-400 transition-all duration-200"
          >
            关闭
          </button>
        }
      >
        <div className="space-y-5">
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-sm text-red-700 font-medium">
              <i className="fas fa-exclamation-triangle mr-2"></i>
              警告
            </p>
            <p className="text-sm text-red-600 mt-1">
              恢复操作可能会覆盖现有数据。请确保您已备份当前数据，并且选择了正确的备份文件。
            </p>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">选择备份文件</label>
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-blue-400 transition-colors">
              <input
                type="file"
                accept=".sql"
                onChange={handleRestore}
                className="hidden"
                id="restore-file"
                disabled={loading}
              />
              <label htmlFor="restore-file" className="cursor-pointer block">
                <i className="fas fa-upload text-4xl text-gray-400 mb-3 block"></i>
                <p className="text-gray-600">点击或拖拽 SQL 文件到此处</p>
                <p className="text-sm text-gray-400 mt-1">支持 .sql 格式</p>
              </label>
            </div>
          </div>
          
          {loading && (
            <div className="text-center py-4">
              <i className="fas fa-spinner fa-spin text-2xl text-blue-500 mb-2"></i>
              <p className="text-gray-600">正在恢复...</p>
            </div>
          )}
        </div>
      </Drawer>
    </div>
  )
}

