'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { schemaAPI } from '@/lib/api'
import { useAppStore } from '@/lib/store'
import dynamic from 'next/dynamic'

// 动态导入 ERDiagram 避免 SSR 问题
const ERDiagram = dynamic(
  () => import('@/components/ERDiagram').then((mod) => mod.default),
  {
    ssr: false,
    loading: () => (
      <div className="h-[calc(100vh-200px)] w-full border border-gray-200 rounded-lg bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <i className="fas fa-spinner fa-spin text-3xl text-blue-500 mb-3"></i>
          <p className="text-sm text-gray-500">加载 ER 图...</p>
        </div>
      </div>
    ),
  }
)

interface Table {
  table_name: string
  row_count: number
  columns?: number
}

interface Column {
  column_name: string
  data_type: string
  is_nullable: string
  column_default?: string | null
  is_primary_key?: boolean
}

interface TableNode {
  table_name: string
  columns: Column[]
}

interface ForeignKey {
  constraint_name: string
  table_name: string
  column_name: string
  foreign_table_name: string
  foreign_column_name: string
}

export default function SchemaVisualizerPage() {
  const { currentSchema } = useAppStore()
  const router = useRouter()
  const params = useParams<{ projectId: string }>()
  const [tables, setTables] = useState<Table[]>([])
  const [error, setError] = useState('')
  
  // ER 图数据
  const [tableNodes, setTableNodes] = useState<TableNode[]>([])
  const [foreignKeys, setForeignKeys] = useState<ForeignKey[]>([])
  const [loadingER, setLoadingER] = useState(false)

  useEffect(() => {
    if (currentSchema) {
      loadERData()
    }
  }, [currentSchema])

  // 监听数据库和 Schema 切换
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const handleChange = () => {
        if (currentSchema) {
          loadERData()
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

  // 加载 ER 图所需的所有数据
  const loadERData = async () => {
    if (!currentSchema) return

    setLoadingER(true)
    setError('')
    
    try {
      // 1. 获取所有表
      const tablesResponse = await schemaAPI.listTables(currentSchema)
      const tablesData = Array.isArray(tablesResponse.data) ? tablesResponse.data : []
      setTables(tablesData)

      // 2. 获取每个表的详细结构
      const tableDetailsPromises = tablesData.map(async (table: Table) => {
        try {
          const response = await schemaAPI.getTableStructure(currentSchema, table.table_name)
          const data = response.data

          // 标记主键
          const columns = data.columns?.map((col: Column) => ({
            ...col,
            is_primary_key: data.constraints?.some(
              (c: any) => c.constraint_type === 'PRIMARY KEY' && c.column_name === col.column_name
            ) || false,
          })) || []

          return {
            table_name: table.table_name,
            columns: columns,
            foreign_keys: data.foreign_keys || [],
          }
        } catch (err) {
          console.error(`加载表 ${table.table_name} 失败:`, err)
          return {
            table_name: table.table_name,
            columns: [],
            foreign_keys: [],
          }
        }
      })

      const allTableDetails = await Promise.all(tableDetailsPromises)

      // 3. 构建表节点数据
      const nodes: TableNode[] = allTableDetails.map(detail => ({
        table_name: detail.table_name,
        columns: detail.columns,
      }))

      // 4. 构建外键关系数据
      const fks: ForeignKey[] = []
      allTableDetails.forEach(detail => {
        detail.foreign_keys?.forEach((fk: any) => {
          fks.push({
            constraint_name: fk.constraint_name,
            table_name: detail.table_name,
            column_name: fk.column_name,
            foreign_table_name: fk.referenced_table,
            foreign_column_name: fk.referenced_column,
          })
        })
      })
      setTableNodes(nodes)
      setForeignKeys(fks)
    } catch (err: any) {
      console.error('加载 ER 数据失败:', err)
      setError(err.response?.data?.error || '加载失败')
      setTableNodes([])
      setForeignKeys([])
    } finally {
      setLoadingER(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Schema 可视化 (ER 图)</h1>
          <p className="text-sm text-gray-500 mt-1">
            当前 Schema: <span className="font-mono font-medium text-gray-900">{currentSchema}</span>
            {tables.length > 0 && (
              <span className="ml-3">
                <i className="fas fa-table text-blue-500 mr-1"></i>
                {tables.length} 张表
                <i className="fas fa-link text-green-500 ml-3 mr-1"></i>
                {foreignKeys.length} 个关系
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center space-x-3">
          <button 
            onClick={() => currentSchema && loadERData()}
            disabled={loadingER}
            className="btn-default text-sm disabled:opacity-50"
          >
            <i className={`fas ${loadingER ? 'fa-spinner fa-spin' : 'fa-sync-alt'} text-xs mr-2`}></i>
            刷新
          </button>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="card p-4 bg-red-50 border-red-200">
          <p className="text-sm text-red-600">{error}</p>
        </div>
      )}

      {/* ER 图 */}
      {loadingER ? (
        <div className="h-[calc(100vh-200px)] w-full border border-gray-200 rounded-lg bg-gray-50 flex items-center justify-center">
          <div className="text-center">
            <i className="fas fa-spinner fa-spin text-3xl text-blue-500 mb-3"></i>
            <p className="text-sm text-gray-500">加载数据中...</p>
          </div>
        </div>
      ) : tableNodes.length === 0 ? (
        <div className="h-[calc(100vh-200px)] w-full border border-gray-200 rounded-lg bg-gray-50 flex items-center justify-center">
          <div className="text-center max-w-md">
            <i className="fas fa-project-diagram text-5xl text-gray-300 mb-4"></i>
            <h3 className="text-base font-medium text-gray-800 mb-2">还没有数据表可以画</h3>
            <p className="text-sm text-gray-500 mb-5">
              ER 图会自动展现表之间的外键关系——先建几张表，这里就会动起来。
            </p>
            {/* M3：空 ER 图也能直跳建表器，避免用户被"请先创建表"卡住找不到入口。 */}
            <button
              onClick={() =>
                router.push(`/workspace/${params.projectId}/database/table-designer?mode=create`)
              }
              className="btn-primary"
            >
              <i className="fas fa-plus mr-2"></i>
              去建一张表
            </button>
          </div>
        </div>
      ) : (
        <ERDiagram tables={tableNodes} foreignKeys={foreignKeys} />
      )}
    </div>
  )
}
