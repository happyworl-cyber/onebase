'use client'

import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { schemaAPI, tenantAPI } from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { BRAND } from '@/lib/brand'

interface SchemaRow {
  schema_name: string
  table_count: number
}

interface ConnectionRow {
  database_id: number
  tenant_id: number
}

export default function DashboardPage() {
  const { currentTenant, currentSchema } = useAppStore()
  const sessionQueryExecutionCount = useAppStore((s) => s.sessionQueryExecutionCount)
  const syncSessionQueryExecutionFromStorage = useAppStore(
    (s) => s.syncSessionQueryExecutionFromStorage,
  )

  const [schemas, setSchemas] = useState<SchemaRow[] | null>(null)
  const [connections, setConnections] = useState<ConnectionRow[] | null>(null)
  const [loading, setLoading] = useState(true)

  useLayoutEffect(() => {
    syncSessionQueryExecutionFromStorage()
  }, [syncSessionQueryExecutionFromStorage])

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    Promise.allSettled([
      schemaAPI.listSchemas(),
      tenantAPI.getMyConnections(),
    ]).then(([schemaRes, connRes]) => {
      if (cancelled) return
      if (schemaRes.status === 'fulfilled') {
        setSchemas(schemaRes.value.data || [])
      } else {
        setSchemas([])
      }
      if (connRes.status === 'fulfilled') {
        setConnections(connRes.value.data || [])
      } else {
        setConnections([])
      }
      setLoading(false)
    })

    return () => {
      cancelled = true
    }
    // 切租户 / 切 schema 时都重新拉一遍——拉 schemas 走的是 X-Database-Id，
    // 切到别的项目（即另一个数据库）后表数自然要变。
  }, [currentTenant?.id, currentSchema])

  const totalTables = useMemo(
    () => (schemas ?? []).reduce((sum, s) => sum + (s.table_count || 0), 0),
    [schemas],
  )

  const currentSchemaTables = useMemo(() => {
    if (!schemas || !currentSchema) return null
    const found = schemas.find((s) => s.schema_name === currentSchema)
    return found ? found.table_count : null
  }, [schemas, currentSchema])

  const tenantConnectionCount = useMemo(() => {
    if (!connections) return null
    if (!currentTenant) return connections.length
    return connections.filter((c) => c.tenant_id === currentTenant.id).length
  }, [connections, currentTenant])

  return (
    <div className="space-y-6">
      <div className="card p-6">
        <h2 className="text-2xl font-semibold text-gray-800 mb-4">
          欢迎使用 {BRAND}
        </h2>
        <p className="text-gray-600">PostgreSQL 企业级数据库管理平台</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          icon="fa-database"
          iconBg="bg-primary-100"
          iconColor="text-primary-600"
          label="数据库连接"
          value={
            loading
              ? '...'
              : tenantConnectionCount != null
              ? String(tenantConnectionCount)
              : '--'
          }
          sub={
            currentTenant?.name
              ? `项目：${currentTenant.name}`
              : '当前未选择项目'
          }
        />

        <StatCard
          icon="fa-table"
          iconBg="bg-green-100"
          iconColor="text-green-600"
          label="数据表"
          value={loading || schemas == null ? '...' : String(totalTables)}
          sub={
            !loading && currentSchema
              ? currentSchemaTables != null
                ? `Schema ${currentSchema}：${currentSchemaTables} 张`
                : `Schema ${currentSchema}：- 张`
              : `${(schemas ?? []).length} 个 Schema`
          }
        />

        <StatCard
          icon="fa-code"
          iconBg="bg-blue-100"
          iconColor="text-blue-600"
          label="查询执行"
          value={String(sessionQueryExecutionCount)}
          sub="本会话累计（同标签页，刷新后保留）"
        />

        <StatCard
          icon="fa-check-circle"
          iconBg="bg-green-100"
          iconColor="text-green-600"
          label="系统状态"
          value="正常"
          valueClass="text-green-600"
        />
      </div>
    </div>
  )
}

function StatCard({
  icon,
  iconBg,
  iconColor,
  label,
  value,
  sub,
  valueClass,
}: {
  icon: string
  iconBg: string
  iconColor: string
  label: string
  value: string
  sub?: string
  valueClass?: string
}) {
  return (
    <div className="card p-6">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <p className="text-sm text-gray-600">{label}</p>
          <p
            className={`text-2xl font-semibold mt-2 ${
              valueClass ?? 'text-gray-900'
            }`}
          >
            {value}
          </p>
          {sub && <p className="text-xs text-gray-500 mt-1 truncate">{sub}</p>}
        </div>
        <div
          className={`w-12 h-12 ${iconBg} rounded-lg flex items-center justify-center flex-shrink-0`}
        >
          <i className={`fas ${icon} ${iconColor} text-xl`}></i>
        </div>
      </div>
    </div>
  )
}
