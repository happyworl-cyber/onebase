'use client'

import { Suspense, useState, useEffect } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { schemaAPI, ddlAPI, type AlterOp, type DdlColumnDef, type DdlIndexDef } from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { useNotification } from '@/hooks/useNotification'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
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
  return (
    <Suspense
      fallback={
        <div className="p-6 text-sm text-gray-500">
          <i className="fas fa-spinner fa-spin mr-2"></i>加载中…
        </div>
      }
    >
      <TableDesignerInner />
    </Suspense>
  )
}

function TableDesignerInner() {
  const { currentSchema } = useAppStore()
  const notify = useNotification()
  const { canWriteDatabase } = useCurrentProjectCapabilities()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [mode, setMode] = useState<Mode>('create')
  const [tables, setTables] = useState<TableInfo[]>([])
  const [selectedTable, setSelectedTable] = useState<string>('')
  const [tableName, setTableName] = useState('')
  const [originalTableName, setOriginalTableName] = useState('')
  const [columns, setColumns] = useState<ColumnDefinition[]>([])
  const [indexes, setIndexes] = useState<IndexDefinition[]>([])
  // M3 ALTER 极简集：edit 模式要"按差异生成 AlterOp[]"，必须留一份原结构快照供 diff。
  // 新增列的 id 用 col_${ts}；原始列的 id 用 original_${name}——靠这点区分。
  const [originalColumns, setOriginalColumns] = useState<ColumnDefinition[]>([])
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
      
      // 转换为列定义。id 用 `original_${name}` 前缀以便 diff 时识别"原始列"。
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
          id: `original_${col.column_name}`,
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
      // 深拷贝快照——避免后续 setColumns 时把原值也改了
      setOriginalColumns(cols.map(c => ({ ...c, references: c.references ? { ...c.references } : undefined })))
      setTableName(tableName)
      setOriginalTableName(tableName)
      
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

  const computeAlterOps = (): AlterOp[] => {
    const ops: AlterOp[] = []
    const originalById = new Map(originalColumns.map(c => [c.id, c]))
    const currentById = new Map(columns.map(c => [c.id, c]))

    if (mode === 'edit' && originalTableName && tableName && originalTableName !== tableName) {
      ops.push({ kind: 'rename_table', new_name: tableName })
    }

    // 1. 删列：先释放旧列名，避免后续重命名 / 新增同名列冲突
    for (const orig of originalColumns) {
      if (!currentById.has(orig.id)) {
        ops.push({ kind: 'drop_column', name: orig.name, cascade: false })
      }
    }

    // 2. 改列名：先完成 RENAME，后续类型 / 约束操作都用新列名
    for (const orig of originalColumns) {
      const cur = currentById.get(orig.id)
      if (!cur) continue
      if (orig.name !== cur.name) {
        ops.push({ kind: 'rename_column', old_name: orig.name, new_name: cur.name })
      }
    }

    // 3. 加列：放在删列和重命名之后，降低命名冲突概率
    for (const col of columns) {
      if (!col.id.startsWith('original_')) {
        ops.push({ kind: 'add_column', column: toApiColumn(col) })
      }
    }

    // 4. 原始列属性变更：改类型 / 改 NOT NULL / DEFAULT / 新增 UNIQUE
    for (const orig of originalColumns) {
      const cur = currentById.get(orig.id)
      if (!cur) continue
      const effectiveName = cur.name
      if (
        orig.type !== cur.type ||
        orig.length !== cur.length ||
        orig.precision !== cur.precision ||
        orig.scale !== cur.scale
      ) {
        ops.push({ kind: 'alter_column_type', name: effectiveName, column: toApiColumn(cur) })
      }
      if (orig.nullable !== cur.nullable) {
        ops.push({ kind: 'set_not_null', name: effectiveName, value: !cur.nullable })
      }
      // DEFAULT 空字符串视作"无默认"
      const oDef = (orig.defaultValue || '').trim()
      const cDef = (cur.defaultValue || '').trim()
      if (oDef !== cDef) {
        ops.push({
          kind: 'set_default',
          name: effectiveName,
          value: cDef.length > 0 ? cDef : null,
        })
      }
      if (!orig.isUnique && cur.isUnique && !cur.isPrimaryKey) {
        ops.push({ kind: 'add_unique', name: effectiveName })
      }
    }

    return ops
  }

  // 把 UI ColumnDefinition 转后端 DdlColumnDef 字段名
  const toApiColumn = (col: ColumnDefinition): DdlColumnDef => ({
    name: col.name,
    data_type: col.type,
    length: col.length,
    precision: col.precision,
    scale: col.scale,
    nullable: col.nullable,
    default_value: col.defaultValue && col.defaultValue.length > 0 ? col.defaultValue : undefined,
    is_primary_key: col.isPrimaryKey,
    is_unique: col.isUnique,
    references: col.references && col.references.table && col.references.column
      ? { schema: currentSchema, table: col.references.table, column: col.references.column }
      : undefined,
  })

  // 把 IndexDefinition 转后端 DdlIndexDef
  const toApiIndex = (idx: IndexDefinition): DdlIndexDef => ({
    name: idx.name,
    columns: idx.columns,
    is_unique: idx.isUnique,
  })

  // 生成 ALTER 的可读预览。基于 computeAlterOps 拼一遍 SQL，
  // 仅用于让用户在执行前直观看到将下发的语句。**实际下发的是结构化 body**。
  const generateAlterTableSQL = () => {
    const ops = computeAlterOps()
    if (ops.length === 0) {
      return '-- 当前编辑没有可识别的结构变更'
    }
    let targetTable = originalTableName || tableName
    const lines = ops.map(op => {
      const target = `"${currentSchema}"."${targetTable}"`
      switch (op.kind) {
        case 'rename_table': {
          const sql = `ALTER TABLE ${target} RENAME TO "${op.new_name}";`
          targetTable = op.new_name
          return sql
        }
        case 'add_column': {
          const c = op.column
          let s = `"${c.name}" ${c.data_type.toUpperCase()}`
          if (c.length && ['varchar', 'char'].includes(c.data_type)) s += `(${c.length})`
          if (c.is_primary_key) s += ' PRIMARY KEY'
          if (c.is_unique && !c.is_primary_key) s += ' UNIQUE'
          if (c.nullable === false && !c.is_primary_key) s += ' NOT NULL'
          if (c.default_value) s += ` DEFAULT ${c.default_value}`
          return `ALTER TABLE ${target} ADD COLUMN ${s};`
        }
        case 'drop_column':
          return `ALTER TABLE ${target} DROP COLUMN "${op.name}"${op.cascade ? ' CASCADE' : ''};`
        case 'rename_column':
          return `ALTER TABLE ${target} RENAME COLUMN "${op.old_name}" TO "${op.new_name}";`
        case 'alter_column_type': {
          const c = op.column
          let t = c.data_type.toUpperCase()
          if (c.length && ['varchar', 'char'].includes(c.data_type)) t += `(${c.length})`
          if (c.precision && c.data_type === 'numeric') t += c.scale ? `(${c.precision}, ${c.scale})` : `(${c.precision})`
          return `ALTER TABLE ${target} ALTER COLUMN "${op.name}" TYPE ${t};`
        }
        case 'set_not_null':
          return `ALTER TABLE ${target} ALTER COLUMN "${op.name}" ${op.value ? 'SET NOT NULL' : 'DROP NOT NULL'};`
        case 'set_default':
          return op.value === null || op.value === ''
            ? `ALTER TABLE ${target} ALTER COLUMN "${op.name}" DROP DEFAULT;`
            : `ALTER TABLE ${target} ALTER COLUMN "${op.name}" SET DEFAULT ${op.value};`
        case 'add_unique':
          return `ALTER TABLE ${target} ADD CONSTRAINT "${tableName}_${op.name}_key" UNIQUE ("${op.name}");`
      }
    })
    return lines.join('\n')
  }

  // 预览 SQL
  const previewSQL = () => {
    const sql = mode === 'create' ? generateCreateTableSQL() : generateAlterTableSQL()
    setGeneratedSQL(sql)
    setShowPreview(true)
  }

  // 执行：create → POST /api/ddl/tables；edit → PATCH /api/ddl/tables/:s/:t
  // 注意：不走 /query。结构化 body 由 ddlAPI 拼，服务端 100% 走白名单 + ident 校验。
  const executeSQL = async () => {
    if (!canWriteDatabase) {
      notify.error('需要 owner / admin / member 角色才能执行 DDL；当前账号为 viewer。')
      return
    }
    if (!tableName) return

    if (mode === 'create') {
      if (columns.length === 0) return
      const ok = window.confirm(
        `确定在 schema "${currentSchema}" 下创建表 "${tableName}" 吗？\n` +
        `共 ${columns.length} 列${indexes.length > 0 ? ` / ${indexes.length} 个索引` : ''}。`
      )
      if (!ok) return
      setExecuting(true)
      try {
        await ddlAPI.createTable({
          schema: currentSchema,
          table: tableName,
          columns: columns.map(toApiColumn),
          indexes: indexes.filter(i => i.name && i.columns.length > 0).map(toApiIndex),
        })
        notify.success(`表 "${tableName}" 创建成功`)
        setShowPreview(false)
        await loadTables()
        // 触发 ER 图、表列表的 schema-changed 监听，让其他页面同步
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event('schema-changed'))
        }
        startCreateTable()
      } catch (err: any) {
        notify.error(err)
      } finally {
        setExecuting(false)
      }
      return
    }

    // edit 模式
    const ops = computeAlterOps()
    if (ops.length === 0) {
      notify.error('没有可应用的变更')
      return
    }
    const summary = ops.map(o => o.kind).join(', ')
    const ok = window.confirm(
      `确定对表 "${tableName}" 应用 ${ops.length} 个变更？\n操作：${summary}`
    )
    if (!ok) return
    setExecuting(true)
    try {
      await ddlAPI.alterTable(currentSchema, originalTableName || tableName, ops)
      notify.success('表结构修改成功！')
      setShowPreview(false)
      await loadTables()
      // 重新拉一次结构作为新基线，并重置 originals
      await loadTableStructure(tableName)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('schema-changed'))
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
    setOriginalTableName('')
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
    setOriginalColumns([])
  }

  // 编辑表
  const startEditTable = (tableName: string) => {
    setMode('edit')
    setSelectedTable(tableName)
    loadTableStructure(tableName)
  }

  // M3 深度链接：从 sidebar/tables/visualizer 跳进来时支持 `?mode=create` 或
  // `?mode=edit&table=foo`，让"+ 新建表"一键直达。表列表加载完成后再触发 edit，
  // 否则 startEditTable 调用 loadTableStructure 仍然 OK，但表项不会被高亮选中。
  useEffect(() => {
    const m = searchParams.get('mode')
    const t = searchParams.get('table')
    if (m === 'create') {
      startCreateTable()
    } else if (m === 'edit' && t) {
      startEditTable(t)
    }
    // 仅在 URL 变化时跑；不依赖 tables 列表的 ready 状态
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

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
                {mode === 'edit' && (
                  <span className="text-xs text-gray-500">
                    <i className="fas fa-info-circle mr-1"></i>
                    支持改表名 / 列名 / 类型 / 可空 / 默认值 / 新增唯一
                  </span>
                )}
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
                      {columns.map((col) => {
                        const isOriginal = mode === 'edit' && col.id.startsWith('original_')
                        const original = originalColumns.find(o => o.id === col.id)
                        const originalUniqueLocked = isOriginal && original?.isUnique
                        return (
                        <tr key={col.id} className="hover:bg-gray-50">
                          <td className="px-3 py-2">
                            <input
                              type="text"
                              value={col.name}
                              onChange={(e) => updateColumn(col.id, { name: e.target.value })}
                              placeholder="column_name"
                              className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-500"
                            />
                          </td>
                          <td className="px-3 py-2">
                            <select
                              value={col.type}
                              onChange={(e) => updateColumn(col.id, { type: e.target.value })}
                              className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-500"
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
                                className="w-20 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-500"
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
                              disabled={isOriginal}
                              title={isOriginal ? '原始列主键不可改' : undefined}
                              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                            />
                          </td>
                          <td className="px-3 py-2 text-center">
                            <input
                              type="checkbox"
                              checked={col.isUnique}
                              onChange={(e) => updateColumn(col.id, { isUnique: e.target.checked })}
                              disabled={col.isPrimaryKey || originalUniqueLocked}
                              title={originalUniqueLocked ? '已有唯一约束暂不支持从这里删除' : undefined}
                              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
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
                        )
                      })}
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
              disabled={executing || !canWriteDatabase}
              title={!canWriteDatabase ? '需要 owner / admin / member 角色才能执行 DDL（viewer 只读）' : undefined}
              className="flex-1 h-11 px-5 text-sm font-medium text-white bg-gradient-to-r from-green-500 to-green-600 rounded-lg hover:from-green-600 hover:to-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-sm hover:shadow-md flex items-center justify-center"
            >
              <i className={`fas ${executing ? 'fa-spinner fa-spin' : 'fa-play'} mr-2`}></i>
              {executing ? '执行中...' : !canWriteDatabase ? '无权执行' : '执行 SQL'}
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

