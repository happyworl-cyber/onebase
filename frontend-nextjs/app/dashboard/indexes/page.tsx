'use client'

import { useState, useEffect, useMemo } from 'react'
import { schemaAPI, indexAPI, IndexRow, IndexColumnInput } from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { useNotification } from '@/hooks/useNotification'
import Drawer from '@/components/Drawer'

interface TableInfo {
  table_name: string
  table_type: string
}

interface ColumnInfo {
  column_name: string
}

type IndexMethod = 'btree' | 'hash' | 'gin' | 'gist' | 'brin' | 'spgist'

interface ColumnFormItem {
  mode: 'column' | 'expression'
  name: string
  expression: string
  ordering: '' | 'ASC' | 'DESC'
  nulls: '' | 'FIRST' | 'LAST'
}

const METHOD_OPTIONS: { value: IndexMethod; label: string; hint: string }[] = [
  { value: 'btree', label: 'btree', hint: '默认；等值与范围查询' },
  { value: 'hash', label: 'hash', hint: '只支持等值查询' },
  { value: 'gin', label: 'gin', hint: '数组、jsonb、全文检索' },
  { value: 'gist', label: 'gist', hint: '几何、范围、相似度' },
  { value: 'brin', label: 'brin', hint: '超大表的稀疏索引' },
  { value: 'spgist', label: 'spgist', hint: '空间分区树' },
]

const emptyColumn = (): ColumnFormItem => ({
  mode: 'column',
  name: '',
  expression: '',
  ordering: '',
  nulls: '',
})

export default function IndexesPage() {
  const { currentSchema } = useAppStore()
  const notify = useNotification()

  const [indexes, setIndexes] = useState<IndexRow[]>([])
  const [loading, setLoading] = useState(false)
  const [tables, setTables] = useState<TableInfo[]>([])
  const [filterTable, setFilterTable] = useState<string>('')
  const [search, setSearch] = useState('')

  // 创建抽屉状态
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({
    table: '',
    name: '',
    method: 'btree' as IndexMethod,
    unique: false,
    concurrent: false,
    ifNotExists: true,
    columns: [emptyColumn()] as ColumnFormItem[],
    include: [] as string[],
    whereClause: '',
  })
  const [tableColumns, setTableColumns] = useState<string[]>([])

  // 删除确认状态
  const [pendingDelete, setPendingDelete] = useState<IndexRow | null>(null)
  const [deleteConcurrent, setDeleteConcurrent] = useState(true)
  const [deleting, setDeleting] = useState(false)

  // ----- 数据加载 -----
  const loadIndexes = async () => {
    if (!currentSchema) return
    setLoading(true)
    try {
      const res = await indexAPI.list(currentSchema, filterTable || undefined)
      setIndexes(res.data)
    } catch (err: any) {
      notify.error(err)
    } finally {
      setLoading(false)
    }
  }

  const loadTables = async () => {
    if (!currentSchema) return
    try {
      const res = await schemaAPI.listTables(currentSchema)
      setTables(res.data.filter((t: TableInfo) => t.table_type === 'BASE TABLE'))
    } catch (err: any) {
      notify.error(err)
    }
  }

  useEffect(() => {
    loadTables()
    loadIndexes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSchema])

  useEffect(() => {
    loadIndexes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterTable])

  // 选定要建索引的表后，加载列名供下拉选择
  useEffect(() => {
    let aborted = false
    if (!form.table || !currentSchema) {
      setTableColumns([])
      return
    }
    schemaAPI
      .getTableStructure(currentSchema, form.table)
      .then((res) => {
        if (aborted) return
        const cols: string[] = (res.data.columns || []).map(
          (c: ColumnInfo) => c.column_name,
        )
        setTableColumns(cols)
      })
      .catch((err) => {
        if (!aborted) console.error('加载列失败', err)
      })
    return () => {
      aborted = true
    }
  }, [form.table, currentSchema])

  const filteredIndexes = useMemo(() => {
    const kw = search.trim().toLowerCase()
    if (!kw) return indexes
    return indexes.filter(
      (ix) =>
        ix.name.toLowerCase().includes(kw) ||
        ix.table.toLowerCase().includes(kw) ||
        ix.columns.join(',').toLowerCase().includes(kw),
    )
  }, [indexes, search])

  // ----- 表单：列项操作 -----
  const updateColumn = (idx: number, patch: Partial<ColumnFormItem>) => {
    setForm((f) => ({
      ...f,
      columns: f.columns.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    }))
  }
  const addColumn = () =>
    setForm((f) => ({ ...f, columns: [...f.columns, emptyColumn()] }))
  const removeColumn = (idx: number) =>
    setForm((f) => ({
      ...f,
      columns: f.columns.length === 1 ? f.columns : f.columns.filter((_, i) => i !== idx),
    }))

  const toggleInclude = (col: string) => {
    setForm((f) => ({
      ...f,
      include: f.include.includes(col)
        ? f.include.filter((c) => c !== col)
        : [...f.include, col],
    }))
  }

  // 自动给个合理默认索引名：idx_<table>_<col1>[_uniq]
  const suggestedName = useMemo(() => {
    if (!form.table) return ''
    const first = form.columns[0]
    const colKey =
      first?.mode === 'column'
        ? first.name
        : first?.expression
            ?.replace(/[^a-zA-Z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 20) || 'expr'
    if (!colKey) return ''
    return `idx_${form.table}_${colKey}${form.unique ? '_uniq' : ''}`
  }, [form.table, form.columns, form.unique])

  const openCreateDrawer = () => {
    setForm({
      table: filterTable || '',
      name: '',
      method: 'btree',
      unique: false,
      concurrent: false,
      ifNotExists: true,
      columns: [emptyColumn()],
      include: [],
      whereClause: '',
    })
    setShowCreate(true)
  }

  const handleCreate = async () => {
    if (!currentSchema) {
      notify.warning('请先选择 Schema')
      return
    }
    if (!form.table) {
      notify.warning('请选择目标表')
      return
    }
    const finalName = form.name.trim() || suggestedName
    if (!finalName) {
      notify.warning('请填写索引名称')
      return
    }
    if (form.columns.length === 0) {
      notify.warning('至少需要一列或一个表达式')
      return
    }
    for (let i = 0; i < form.columns.length; i++) {
      const c = form.columns[i]
      if (c.mode === 'column' && !c.name) {
        notify.warning(`第 ${i + 1} 列：请选择列名`)
        return
      }
      if (c.mode === 'expression' && !c.expression.trim()) {
        notify.warning(`第 ${i + 1} 列：请填写表达式`)
        return
      }
    }
    if (form.method === 'hash' && form.unique) {
      notify.warning('hash 索引不支持 UNIQUE')
      return
    }

    const columns: IndexColumnInput[] = form.columns.map((c) => ({
      name: c.mode === 'column' ? c.name : undefined,
      expression: c.mode === 'expression' ? c.expression.trim() : undefined,
      ordering: c.ordering || undefined,
      nulls: c.nulls || undefined,
    }))

    setCreating(true)
    try {
      await indexAPI.create({
        schema: currentSchema,
        table: form.table,
        name: finalName,
        method: form.method,
        unique: form.unique,
        concurrent: form.concurrent,
        if_not_exists: form.ifNotExists,
        columns,
        include: form.include.length ? form.include : undefined,
        where_clause: form.whereClause.trim() || undefined,
      })
      notify.success('索引已创建')
      setShowCreate(false)
      loadIndexes()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async () => {
    if (!pendingDelete || !currentSchema) return
    setDeleting(true)
    try {
      await indexAPI.drop(currentSchema, pendingDelete.name, {
        concurrent: deleteConcurrent,
        if_exists: true,
      })
      notify.success(`索引 ${pendingDelete.name} 已删除`)
      setPendingDelete(null)
      loadIndexes()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setDeleting(false)
    }
  }

  const copyToClipboard = (text: string) => {
    if (!text) return
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text).then(
        () => notify.success('已复制到剪贴板'),
        () => notify.warning('复制失败'),
      )
    }
  }

  // ----- 渲染 -----
  if (!currentSchema) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-gray-500">
        <i className="fas fa-layer-group text-3xl mb-3 text-gray-300"></i>
        <p>请先选择 Schema</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* 标题区 */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">索引管理</h2>
          <p className="text-sm text-gray-500 mt-1">
            管理 <span className="font-mono text-gray-700">{currentSchema}</span> 下的索引
          </p>
        </div>
        <button onClick={openCreateDrawer} className="btn-primary">
          <i className="fas fa-plus mr-2"></i>
          新建索引
        </button>
      </div>

      {/* 工具条 */}
      <div className="card p-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600">表：</label>
          <select
            value={filterTable}
            onChange={(e) => setFilterTable(e.target.value)}
            className="input-base h-9 min-w-[180px]"
          >
            <option value="">全部表</option>
            {tables.map((t) => (
              <option key={t.table_name} value={t.table_name}>
                {t.table_name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
          <i className="fas fa-search text-gray-400 text-sm"></i>
          <input
            type="text"
            placeholder="按名称 / 表 / 列 过滤"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input-base h-9 flex-1"
          />
        </div>
        <button
          onClick={loadIndexes}
          className="h-9 px-3 text-sm rounded-md border border-gray-200 hover:bg-gray-50 text-gray-600"
          title="刷新"
        >
          <i className="fas fa-sync-alt mr-1.5"></i>
          刷新
        </button>
      </div>

      {/* 索引列表 */}
      <div className="card overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <i className="fas fa-spinner fa-spin text-2xl text-gray-400"></i>
          </div>
        ) : filteredIndexes.length === 0 ? (
          <div className="py-16 text-center text-gray-500">
            <i className="fas fa-database text-3xl mb-3 text-gray-300"></i>
            <p>{indexes.length === 0 ? '当前 Schema 暂无索引' : '没有匹配的索引'}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    索引
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    表
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    类型
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    列
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    大小
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-100">
                {filteredIndexes.map((ix) => (
                  <tr key={`${ix.schema}.${ix.name}`} className="hover:bg-gray-50">
                    <td className="px-4 py-3 align-top">
                      <div className="font-mono text-sm text-gray-900">{ix.name}</div>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {ix.is_primary && (
                          <span className="px-1.5 py-0.5 text-[10px] rounded bg-purple-100 text-purple-700 font-medium">
                            PRIMARY
                          </span>
                        )}
                        {ix.is_unique && !ix.is_primary && (
                          <span className="px-1.5 py-0.5 text-[10px] rounded bg-blue-100 text-blue-700 font-medium">
                            UNIQUE
                          </span>
                        )}
                        {!ix.is_valid && (
                          <span className="px-1.5 py-0.5 text-[10px] rounded bg-red-100 text-red-700 font-medium">
                            INVALID
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 align-top font-mono">
                      {ix.table}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 align-top">
                      <span className="px-2 py-0.5 text-xs rounded bg-gray-100 text-gray-700 font-medium">
                        {ix.method}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 align-top">
                      <div className="flex flex-wrap gap-1 max-w-md">
                        {ix.columns.map((c, i) => (
                          <span
                            key={i}
                            className="px-1.5 py-0.5 text-xs rounded bg-gray-50 border border-gray-200 font-mono text-gray-700"
                          >
                            {c}
                          </span>
                        ))}
                      </div>
                      <button
                        onClick={() => copyToClipboard(ix.definition)}
                        className="mt-1 text-[11px] text-gray-400 hover:text-blue-600"
                        title="复制建索引 SQL"
                      >
                        <i className="fas fa-copy mr-1"></i>
                        复制 SQL
                      </button>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 text-right align-top">
                      {ix.size}
                    </td>
                    <td className="px-4 py-3 text-right align-top">
                      <button
                        disabled={ix.is_primary}
                        onClick={() => {
                          setPendingDelete(ix)
                          setDeleteConcurrent(true)
                        }}
                        className={`text-sm px-2 py-1 rounded transition-colors ${
                          ix.is_primary
                            ? 'text-gray-300 cursor-not-allowed'
                            : 'text-red-600 hover:bg-red-50'
                        }`}
                        title={ix.is_primary ? '主键索引不能从这里删除' : '删除索引'}
                      >
                        <i className="fas fa-trash mr-1"></i>
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 创建抽屉 */}
      <Drawer
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        title="新建索引"
        size="xl"
        footer={
          <div className="flex gap-3">
            <button
              onClick={() => setShowCreate(false)}
              className="flex-1 h-11 px-5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-all"
            >
              取消
            </button>
            <button
              onClick={handleCreate}
              disabled={creating || !form.table}
              className="flex-1 h-11 px-5 text-sm font-medium text-white bg-gradient-to-r from-blue-500 to-blue-600 rounded-lg hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center"
            >
              {creating ? (
                <>
                  <i className="fas fa-spinner fa-spin mr-2"></i>
                  创建中...
                </>
              ) : (
                <>
                  <i className="fas fa-plus mr-2"></i>
                  创建索引
                </>
              )}
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          {/* 目标表 + 索引名 */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                目标表 <span className="text-red-500">*</span>
              </label>
              <select
                value={form.table}
                onChange={(e) => setForm({ ...form, table: e.target.value })}
                className="w-full input-base"
              >
                <option value="">选择表...</option>
                {tables.map((t) => (
                  <option key={t.table_name} value={t.table_name}>
                    {t.table_name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                索引名称
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={suggestedName || 'idx_xxx'}
                className="w-full input-base font-mono"
              />
              <p className="text-xs text-gray-500 mt-1">
                留空将使用 <span className="font-mono">{suggestedName || 'idx_<table>_<col>'}</span>
              </p>
            </div>
          </div>

          {/* 索引类型 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">索引类型</label>
            <div className="grid grid-cols-3 gap-2">
              {METHOD_OPTIONS.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setForm({ ...form, method: m.value })}
                  className={`text-left px-3 py-2 rounded-md border transition-all ${
                    form.method === m.value
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 hover:border-gray-300 text-gray-700'
                  }`}
                >
                  <div className="text-sm font-mono font-semibold">{m.label}</div>
                  <div className="text-[11px] text-gray-500 mt-0.5">{m.hint}</div>
                </button>
              ))}
            </div>
          </div>

          {/* 选项 */}
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={form.unique}
                onChange={(e) => setForm({ ...form, unique: e.target.checked })}
                disabled={form.method === 'hash'}
              />
              <span>UNIQUE 唯一索引</span>
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={form.concurrent}
                onChange={(e) => setForm({ ...form, concurrent: e.target.checked })}
              />
              <span>CONCURRENTLY 在线创建（不锁表，但耗时更长）</span>
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={form.ifNotExists}
                onChange={(e) => setForm({ ...form, ifNotExists: e.target.checked })}
              />
              <span>IF NOT EXISTS</span>
            </label>
          </div>

          {/* 列 / 表达式 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-700">
                列 / 表达式 <span className="text-red-500">*</span>
              </label>
              <button
                type="button"
                onClick={addColumn}
                className="text-xs text-blue-600 hover:text-blue-700"
              >
                <i className="fas fa-plus mr-1"></i>
                添加一列
              </button>
            </div>
            <div className="space-y-2">
              {form.columns.map((c, idx) => (
                <div
                  key={idx}
                  className="border border-gray-200 rounded-md p-3 space-y-2 bg-gray-50/40"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 w-10">#{idx + 1}</span>
                    <div className="inline-flex rounded-md border border-gray-200 overflow-hidden text-xs">
                      <button
                        type="button"
                        onClick={() => updateColumn(idx, { mode: 'column' })}
                        className={`px-2.5 py-1 ${
                          c.mode === 'column'
                            ? 'bg-blue-500 text-white'
                            : 'bg-white text-gray-600 hover:bg-gray-50'
                        }`}
                      >
                        列名
                      </button>
                      <button
                        type="button"
                        onClick={() => updateColumn(idx, { mode: 'expression' })}
                        className={`px-2.5 py-1 ${
                          c.mode === 'expression'
                            ? 'bg-blue-500 text-white'
                            : 'bg-white text-gray-600 hover:bg-gray-50'
                        }`}
                      >
                        表达式
                      </button>
                    </div>
                    <div className="flex-1" />
                    {form.columns.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeColumn(idx)}
                        className="text-gray-400 hover:text-red-500 text-sm"
                        title="删除该列"
                      >
                        <i className="fas fa-times"></i>
                      </button>
                    )}
                  </div>
                  {c.mode === 'column' ? (
                    <select
                      value={c.name}
                      onChange={(e) => updateColumn(idx, { name: e.target.value })}
                      className="w-full input-base h-9"
                      disabled={!form.table}
                    >
                      <option value="">
                        {form.table ? '选择列...' : '请先选择表'}
                      </option>
                      {tableColumns.map((col) => (
                        <option key={col} value={col}>
                          {col}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={c.expression}
                      onChange={(e) =>
                        updateColumn(idx, { expression: e.target.value })
                      }
                      placeholder="例如：lower(email)"
                      className="w-full input-base h-9 font-mono"
                    />
                  )}
                  <div className="flex items-center gap-3">
                    <select
                      value={c.ordering}
                      onChange={(e) =>
                        updateColumn(idx, {
                          ordering: e.target.value as ColumnFormItem['ordering'],
                        })
                      }
                      className="input-base h-8 text-sm"
                    >
                      <option value="">排序：默认</option>
                      <option value="ASC">ASC</option>
                      <option value="DESC">DESC</option>
                    </select>
                    <select
                      value={c.nulls}
                      onChange={(e) =>
                        updateColumn(idx, {
                          nulls: e.target.value as ColumnFormItem['nulls'],
                        })
                      }
                      className="input-base h-8 text-sm"
                    >
                      <option value="">NULLS：默认</option>
                      <option value="FIRST">NULLS FIRST</option>
                      <option value="LAST">NULLS LAST</option>
                    </select>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* INCLUDE 覆盖列 */}
          {form.method === 'btree' && tableColumns.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                INCLUDE 覆盖列
                <span className="text-xs text-gray-500 ml-2">
                  非 key 列，仅 PostgreSQL 11+ 的 btree 支持
                </span>
              </label>
              <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto p-2 border border-gray-200 rounded-md">
                {tableColumns.map((col) => {
                  const checked = form.include.includes(col)
                  const isKey = form.columns.some(
                    (c) => c.mode === 'column' && c.name === col,
                  )
                  return (
                    <button
                      key={col}
                      type="button"
                      disabled={isKey}
                      onClick={() => toggleInclude(col)}
                      className={`px-2 py-1 text-xs rounded font-mono border transition-colors ${
                        isKey
                          ? 'bg-gray-50 border-gray-200 text-gray-300 cursor-not-allowed'
                          : checked
                          ? 'bg-blue-500 border-blue-500 text-white'
                          : 'bg-white border-gray-200 text-gray-700 hover:border-blue-300'
                      }`}
                      title={isKey ? '已作为 key 列' : ''}
                    >
                      {col}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* WHERE 部分索引 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              WHERE 子句（部分索引，可选）
            </label>
            <textarea
              value={form.whereClause}
              onChange={(e) => setForm({ ...form, whereClause: e.target.value })}
              placeholder="例如：deleted_at IS NULL"
              rows={2}
              className="w-full input-base font-mono"
            />
            <p className="text-xs text-gray-500 mt-1">
              仅对满足该条件的行建索引，可显著降低索引大小
            </p>
          </div>
        </div>
      </Drawer>

      {/* 删除确认抽屉 */}
      <Drawer
        isOpen={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        title="删除索引"
        size="md"
        footer={
          <div className="flex gap-3">
            <button
              onClick={() => setPendingDelete(null)}
              className="flex-1 h-11 px-5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-all"
            >
              取消
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="flex-1 h-11 px-5 text-sm font-medium text-white bg-gradient-to-r from-red-500 to-red-600 rounded-lg hover:from-red-600 hover:to-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center"
            >
              {deleting ? (
                <>
                  <i className="fas fa-spinner fa-spin mr-2"></i>
                  删除中...
                </>
              ) : (
                <>
                  <i className="fas fa-trash mr-2"></i>
                  确认删除
                </>
              )}
            </button>
          </div>
        }
      >
        {pendingDelete && (
          <div className="space-y-4">
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-700">
                <i className="fas fa-exclamation-triangle mr-2"></i>
                即将删除索引 <span className="font-mono font-semibold">{pendingDelete.name}</span>，
                此操作不可恢复。
              </p>
            </div>
            <div className="text-sm text-gray-600 space-y-1">
              <div>
                表：<span className="font-mono">{pendingDelete.schema}.{pendingDelete.table}</span>
              </div>
              <div>类型：{pendingDelete.method}</div>
              <div>大小：{pendingDelete.size}</div>
            </div>
            <pre className="code-block text-xs whitespace-pre-wrap">
              {pendingDelete.definition}
            </pre>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={deleteConcurrent}
                onChange={(e) => setDeleteConcurrent(e.target.checked)}
              />
              <span>CONCURRENTLY 在线删除（不锁表）</span>
            </label>
          </div>
        )}
      </Drawer>
    </div>
  )
}
