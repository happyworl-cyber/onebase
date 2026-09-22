'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { schemaAPI, transactionAPI } from '@/lib/api'
import { useNotification } from '@/hooks/useNotification'
import Drawer from '@/components/Drawer'

// ──────────────────────────────────────────────────────────────────────────────
// 类型 & 工具
// ──────────────────────────────────────────────────────────────────────────────

type Method = 'POST' | 'PATCH' | 'DELETE'

interface KVEntry {
  id: string
  key: string
  value: string
}

interface Operation {
  id: string
  method: Method
  schema: string
  table: string
  /** 仅 PATCH / DELETE 用 */
  where: KVEntry[]
  /** 仅 POST / PATCH 用；值会按字面量自动判类型（数字 / 布尔 / null / JSON） */
  data: KVEntry[]
}

interface ExecResult {
  success_count: number
  elapsed_ms: number
  results: any[]
}

const METHOD_OPTIONS: { value: Method; label: string; color: string; descKey: string }[] = [
  { value: 'POST', label: 'INSERT', color: 'bg-green-100 text-green-700', descKey: 'descInsert' },
  { value: 'PATCH', label: 'UPDATE', color: 'bg-amber-100 text-amber-700', descKey: 'descUpdate' },
  { value: 'DELETE', label: 'DELETE', color: 'bg-red-100 text-red-700', descKey: 'descDelete' },
]

const newId = () => Math.random().toString(36).slice(2, 10)

const newKV = (key = '', value = ''): KVEntry => ({ id: newId(), key, value })

const newOp = (overrides: Partial<Operation> = {}): Operation => ({
  id: newId(),
  method: 'POST',
  schema: 'public',
  table: '',
  where: [],
  data: [],
  ...overrides,
})

/**
 * data 字段值会按字面量推断类型，这样 KV 编辑器既保持简单（只要输入字符串），
 * 又能正确传递数字 / 布尔 / null / JSON 给后端。
 *
 * - "null" / "NULL"        → null
 * - "true" / "false"       → boolean
 * - 纯数字（含负号）       → number
 * - 以 { / [ 开头的合法 JSON → 解析后的对象 / 数组
 * - 其它                   → 原样字符串
 */
function inferTypedValue(raw: string): unknown {
  if (raw === '') return null
  if (raw === 'null' || raw === 'NULL') return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw)
    if (Number.isSafeInteger(n)) return n
  }
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw)
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      return JSON.parse(raw)
    } catch {
      /* 落回字符串 */
    }
  }
  return raw
}

function kvListToObject(kvs: KVEntry[], coerce: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const kv of kvs) {
    const k = kv.key.trim()
    if (!k) continue
    out[k] = coerce ? inferTypedValue(kv.value) : kv.value
  }
  return out
}

function buildPayload(ops: Operation[]) {
  return {
    operations: ops.map((op) => {
      const payload: any = {
        method: op.method,
        schema: op.schema.trim(),
        table: op.table.trim(),
      }
      if (op.method === 'PATCH' || op.method === 'DELETE') {
        payload.where = kvListToObject(op.where, false)
      }
      if (op.method === 'POST' || op.method === 'PATCH') {
        payload.data = kvListToObject(op.data, true)
      }
      return payload
    }),
  }
}

function validate(ops: Operation[]): { key: string; params?: Record<string, unknown> } | null {
  if (ops.length === 0) return { key: 'vNeedOp' }
  if (ops.length > 100) return { key: 'vMaxOps', params: { n: ops.length } }
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    const tag = { i: i + 1, method: op.method }
    if (!op.schema.trim()) return { key: 'vNoSchema', params: { tag: `Step ${i + 1} ${op.method}` } }
    if (!op.table.trim()) return { key: 'vNoTable', params: { tag: `Step ${i + 1} ${op.method}` } }
    const dataMissing = op.data.length === 0 || op.data.every((kv) => !kv.key.trim())
    const whereMissing = op.where.length === 0 || op.where.every((kv) => !kv.key.trim())
    if ((op.method === 'POST' || op.method === 'PATCH') && dataMissing) {
      return { key: 'vNoData', params: { tag: `Step ${i + 1} ${op.method}` } }
    }
    if ((op.method === 'PATCH' || op.method === 'DELETE') && whereMissing) {
      return { key: 'vNoWhere', params: { tag: `Step ${i + 1} ${op.method}` } }
    }
  }
  return null
}

// ──────────────────────────────────────────────────────────────────────────────
// 页面
// ──────────────────────────────────────────────────────────────────────────────

export default function TransactionPage() {
  const t = useTranslations('wsTransaction')
  const notify = useNotification()
  const [ops, setOps] = useState<Operation[]>([newOp()])
  const [executing, setExecuting] = useState(false)
  const [lastResult, setLastResult] = useState<ExecResult | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)

  // schema / table 选项缓存
  const [schemas, setSchemas] = useState<string[]>([])
  const [tablesBySchema, setTablesBySchema] = useState<Record<string, string[]>>({})
  const [columnsByTable, setColumnsByTable] = useState<Record<string, string[]>>({})

  const loadSchemas = async () => {
    try {
      const res = await schemaAPI.listSchemas()
      const list = (Array.isArray(res.data) ? res.data : []).map((s: any) => s.schema_name).filter(Boolean)
      setSchemas(list)
    } catch {
      /* 全局拦截器已弹 toast，这里无需重复 */
    }
  }

  const ensureTablesLoaded = async (schema: string) => {
    if (!schema || tablesBySchema[schema]) return
    try {
      const res = await schemaAPI.listTables(schema)
      const names = (Array.isArray(res.data) ? res.data : [])
        .filter((t: any) => !t.table_type || t.table_type === 'BASE TABLE')
        .map((t: any) => t.table_name)
        .filter(Boolean)
      setTablesBySchema((prev) => ({ ...prev, [schema]: names }))
    } catch {
      setTablesBySchema((prev) => ({ ...prev, [schema]: [] }))
    }
  }

  const ensureColumnsLoaded = async (schema: string, table: string) => {
    if (!schema || !table) return
    const key = `${schema}.${table}`
    if (columnsByTable[key]) return
    try {
      const res = await schemaAPI.getTableStructure(schema, table)
      const names = (res.data?.columns || []).map((c: any) => c.column_name).filter(Boolean)
      setColumnsByTable((prev) => ({ ...prev, [key]: names }))
    } catch {
      setColumnsByTable((prev) => ({ ...prev, [key]: [] }))
    }
  }

  useEffect(() => {
    loadSchemas()
    // 切换数据库连接时重新加载
    const reload = () => {
      loadSchemas()
      setTablesBySchema({})
      setColumnsByTable({})
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('database-changed', reload)
      window.addEventListener('connection-changed', reload)
      return () => {
        window.removeEventListener('database-changed', reload)
        window.removeEventListener('connection-changed', reload)
      }
    }
  }, [])

  // 任意操作切换 schema 后预拉表
  useEffect(() => {
    ops.forEach((op) => {
      if (op.schema) ensureTablesLoaded(op.schema)
      if (op.schema && op.table) ensureColumnsLoaded(op.schema, op.table)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ops])

  // ────────────────────────────────────────────────────────────────────────────
  // 操作列表的增删改
  // ────────────────────────────────────────────────────────────────────────────
  const updateOp = (id: string, patch: Partial<Operation>) => {
    setOps((prev) => prev.map((o) => (o.id === id ? { ...o, ...patch } : o)))
  }

  const addOp = () => setOps((prev) => [...prev, newOp({ schema: prev[prev.length - 1]?.schema || 'public' })])

  const removeOp = (id: string) => setOps((prev) => prev.filter((o) => o.id !== id))

  const duplicateOp = (id: string) =>
    setOps((prev) => {
      const idx = prev.findIndex((o) => o.id === id)
      if (idx < 0) return prev
      const copy: Operation = JSON.parse(JSON.stringify(prev[idx]))
      copy.id = newId()
      copy.where = copy.where.map((kv) => ({ ...kv, id: newId() }))
      copy.data = copy.data.map((kv) => ({ ...kv, id: newId() }))
      const next = [...prev]
      next.splice(idx + 1, 0, copy)
      return next
    })

  const moveOp = (id: string, dir: -1 | 1) =>
    setOps((prev) => {
      const idx = prev.findIndex((o) => o.id === id)
      const target = idx + dir
      if (idx < 0 || target < 0 || target >= prev.length) return prev
      const next = [...prev]
      ;[next[idx], next[target]] = [next[target], next[idx]]
      return next
    })

  const clearAll = () => {
    if (ops.length === 1 && !ops[0].table && ops[0].where.length === 0 && ops[0].data.length === 0) return
    if (!window.confirm(t('confirmClear'))) return
    setOps([newOp()])
    setLastResult(null)
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 执行
  // ────────────────────────────────────────────────────────────────────────────
  const payload = useMemo(() => buildPayload(ops), [ops])

  const execute = async () => {
    const err = validate(ops)
    if (err) {
      notify.warning(t(err.key, err.params as any))
      return
    }
    setExecuting(true)
    try {
      const res = await transactionAPI.execute(payload.operations)
      setLastResult(res.data as ExecResult)
      notify.success(t('execOk', { n: res.data.success_count, ms: res.data.elapsed_ms }))
    } catch (e: any) {
      // 失败时清掉上次结果，避免与新错误混淆
      setLastResult(null)
      // 全局拦截器已经弹过 toast，这里不再重复
    } finally {
      setExecuting(false)
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 渲染
  // ────────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* 标题与工具栏 */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">{t('title')}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {t('subtitle')}
          </p>
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <button
            onClick={() => setPreviewOpen(true)}
            className="h-9 px-4 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <i className="fas fa-code mr-2"></i>{t('previewJson')}
          </button>
          <button
            onClick={clearAll}
            className="h-9 px-4 text-sm text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <i className="fas fa-broom mr-2"></i>{t('clear')}
          </button>
          <button
            onClick={addOp}
            className="h-9 px-4 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <i className="fas fa-plus mr-2"></i>{t('addOp')}
          </button>
          <button
            onClick={execute}
            disabled={executing}
            className="h-9 px-5 text-sm font-medium text-white bg-gradient-to-r from-blue-500 to-blue-600 rounded-lg hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 transition-all"
          >
            {executing ? (
              <>
                <i className="fas fa-spinner fa-spin mr-2"></i>{t('executing')}
              </>
            ) : (
              <>
                <i className="fas fa-play mr-2"></i>{t('execTxn', { n: ops.length })}
              </>
            )}
          </button>
        </div>
      </div>

      {/* 操作清单 */}
      <div className="space-y-4">
        {ops.map((op, idx) => (
          <OperationCard
            key={op.id}
            index={idx}
            total={ops.length}
            op={op}
            schemas={schemas}
            tables={tablesBySchema[op.schema] || []}
            columns={columnsByTable[`${op.schema}.${op.table}`] || []}
            onChange={(patch) => updateOp(op.id, patch)}
            onRemove={() => removeOp(op.id)}
            onDuplicate={() => duplicateOp(op.id)}
            onMoveUp={() => moveOp(op.id, -1)}
            onMoveDown={() => moveOp(op.id, 1)}
          />
        ))}
        <button
          onClick={addOp}
          className="w-full border-2 border-dashed border-gray-300 rounded-xl py-6 text-sm text-gray-600 hover:border-blue-300 hover:bg-blue-50/30 hover:text-blue-600 transition-colors"
        >
          <i className="fas fa-plus mr-2"></i>{t('addFirstOp')}
        </button>
      </div>

      {/* 上次执行结果 */}
      {lastResult && <ResultPanel result={lastResult} ops={ops} />}

      {/* 预览 JSON */}
      <Drawer
        isOpen={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={t('previewTitle')}
        size="lg"
      >
        <div className="space-y-3">
          <p className="text-xs text-gray-500">
            {t('previewDescPre')}<code className="bg-gray-100 px-1 rounded">POST /transaction</code>{t('previewDescPost')}
          </p>
          <pre className="bg-gray-900 text-gray-100 text-xs p-4 rounded-lg overflow-auto max-h-[60vh] font-mono leading-relaxed">
            {JSON.stringify(payload, null, 2)}
          </pre>
        </div>
      </Drawer>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────────
// 子组件
// ──────────────────────────────────────────────────────────────────────────────

interface OperationCardProps {
  index: number
  total: number
  op: Operation
  schemas: string[]
  tables: string[]
  columns: string[]
  onChange: (patch: Partial<Operation>) => void
  onRemove: () => void
  onDuplicate: () => void
  onMoveUp: () => void
  onMoveDown: () => void
}

function OperationCard({
  index,
  total,
  op,
  schemas,
  tables,
  columns,
  onChange,
  onRemove,
  onDuplicate,
  onMoveUp,
  onMoveDown,
}: OperationCardProps) {
  const showWhere = op.method === 'PATCH' || op.method === 'DELETE'
  const showData = op.method === 'POST' || op.method === 'PATCH'
  const t = useTranslations('wsTransaction')
  const methodMeta = METHOD_OPTIONS.find((m) => m.value === op.method)!

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-100 bg-gray-50/60">
        <span className="text-sm font-mono text-gray-400 w-7">#{index + 1}</span>
        <span className={`text-xs px-2 py-1 rounded font-semibold ${methodMeta.color}`}>{methodMeta.label}</span>
        <span className="text-xs text-gray-500">{t(methodMeta.descKey)}</span>
        <div className="flex-1"></div>
        <IconButton title={t('moveUp')} disabled={index === 0} onClick={onMoveUp} icon="fa-arrow-up" />
        <IconButton title={t('moveDown')} disabled={index === total - 1} onClick={onMoveDown} icon="fa-arrow-down" />
        <IconButton title={t('duplicate')} onClick={onDuplicate} icon="fa-clone" />
        <IconButton title={t('delete')} onClick={onRemove} icon="fa-trash" danger disabled={total === 1} />
      </div>

      <div className="p-5 space-y-4">
        {/* method / schema / table */}
        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-3">
            <label className="block text-xs font-medium text-gray-600 mb-1.5">{t('opType')}</label>
            <select
              value={op.method}
              onChange={(e) => onChange({ method: e.target.value as Method })}
              className="w-full h-9 px-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              {METHOD_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div className="col-span-4">
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Schema</label>
            <SchemaInput
              value={op.schema}
              options={schemas}
              onChange={(v) => onChange({ schema: v, table: '' })}
            />
          </div>
          <div className="col-span-5">
            <label className="block text-xs font-medium text-gray-600 mb-1.5">{t('tableName')}</label>
            <SchemaInput value={op.table} options={tables} onChange={(v) => onChange({ table: v })} placeholder={t('selectOrInputTable')} />
          </div>
        </div>

        {/* WHERE */}
        {showWhere && (
          <KVSection
            title={t('whereTitle')}
            hint={t('whereHint')}
            entries={op.where}
            columns={columns}
            onChange={(where) => onChange({ where })}
          />
        )}

        {/* DATA */}
        {showData && (
          <KVSection
            title={op.method === 'POST' ? t('insertData') : t('setFields')}
            hint={t('dataHint')}
            entries={op.data}
            columns={columns}
            onChange={(data) => onChange({ data })}
          />
        )}
      </div>
    </div>
  )
}

interface SchemaInputProps {
  value: string
  options: string[]
  onChange: (v: string) => void
  placeholder?: string
}

/**
 * 兼具下拉与手输的小组件：用 datalist 提供建议但不强制。
 * 这样如果列表还没加载好或者用户想用列表外的名字，也能继续工作。
 */
function SchemaInput({ value, options, onChange, placeholder }: SchemaInputProps) {
  const listId = useMemo(() => `dl-${Math.random().toString(36).slice(2, 9)}`, [])
  return (
    <>
      <input
        type="text"
        list={listId}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-9 px-3 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  )
}

interface KVSectionProps {
  title: string
  hint: string
  entries: KVEntry[]
  columns: string[]
  onChange: (next: KVEntry[]) => void
}

function KVSection({ title, hint, entries, columns, onChange }: KVSectionProps) {
  const t = useTranslations('wsTransaction')
  const updateEntry = (id: string, patch: Partial<KVEntry>) => {
    onChange(entries.map((e) => (e.id === id ? { ...e, ...patch } : e)))
  }
  const addEntry = () => onChange([...entries, newKV()])
  const removeEntry = (id: string) => onChange(entries.filter((e) => e.id !== id))

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-700 uppercase tracking-wider">{title}</span>
        <button onClick={addEntry} className="text-xs text-blue-600 hover:text-blue-700">
          <i className="fas fa-plus mr-1"></i>{t('addField')}
        </button>
      </div>
      <p className="text-[11px] text-gray-500 mb-2 leading-relaxed">{hint}</p>
      {entries.length === 0 ? (
        <button
          onClick={addEntry}
          className="w-full border border-dashed border-gray-300 rounded-lg py-3 text-xs text-gray-500 hover:border-gray-400 hover:bg-gray-50 transition-colors"
        >
          <i className="fas fa-plus mr-1.5"></i>{t('addFirstField')}
        </button>
      ) : (
        <div className="space-y-2">
          {entries.map((kv) => (
            <div key={kv.id} className="flex items-center gap-2">
              <SchemaInput
                value={kv.key}
                options={columns}
                onChange={(v) => updateEntry(kv.id, { key: v })}
                placeholder={t('fieldName')}
              />
              <input
                type="text"
                value={kv.value}
                placeholder={t('fieldValueHint')}
                onChange={(e) => updateEntry(kv.id, { value: e.target.value })}
                className="flex-1 h-9 px-3 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono"
              />
              <button
                onClick={() => removeEntry(kv.id)}
                className="w-9 h-9 flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors flex-shrink-0"
                title={t('deleteField')}
              >
                <i className="fas fa-times"></i>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

interface IconButtonProps {
  title: string
  icon: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}

function IconButton({ title, icon, onClick, disabled, danger }: IconButtonProps) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${
        disabled
          ? 'text-gray-300 cursor-not-allowed'
          : danger
          ? 'text-gray-500 hover:text-red-500 hover:bg-red-50'
          : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100'
      }`}
    >
      <i className={`fas ${icon} text-xs`}></i>
    </button>
  )
}

interface ResultPanelProps {
  result: ExecResult
  ops: Operation[]
}

function ResultPanel({ result, ops }: ResultPanelProps) {
  const t = useTranslations('wsTransaction')
  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 bg-green-50/60 flex items-center gap-3">
        <i className="fas fa-check-circle text-green-500"></i>
        <span className="text-sm font-semibold text-gray-900">{t('execOkTitle')}</span>
        <span className="text-xs text-gray-500">
          {t('execOkSummary', { n: result.success_count, ms: result.elapsed_ms })}
        </span>
      </div>
      <div className="divide-y divide-gray-100">
        {result.results.map((rows, idx) => {
          const op = ops[idx]
          const arr = Array.isArray(rows) ? rows : []
          const methodMeta = op ? METHOD_OPTIONS.find((m) => m.value === op.method) : null
          return (
            <div key={idx} className="px-5 py-3 flex items-start gap-3">
              <span className="text-xs font-mono text-gray-400 w-7 mt-0.5">#{idx + 1}</span>
              {methodMeta && (
                <span className={`text-[11px] px-2 py-0.5 rounded font-semibold ${methodMeta.color}`}>
                  {methodMeta.label}
                </span>
              )}
              {op && (
                <span className="text-xs text-gray-700 font-mono">
                  {op.schema}.{op.table}
                </span>
              )}
              <span className="text-xs text-gray-500 ml-auto">{t('affectedRows', { n: arr.length })}</span>
            </div>
          )
        })}
      </div>
      {result.results.some((r) => Array.isArray(r) && r.length > 0) && (
        <details className="px-5 py-3 border-t border-gray-100 bg-gray-50/60">
          <summary className="text-xs text-gray-600 cursor-pointer select-none">{t('viewReturning')}</summary>
          <pre className="mt-2 bg-gray-900 text-gray-100 text-[11px] p-3 rounded-lg overflow-auto max-h-72 font-mono">
            {JSON.stringify(result.results, null, 2)}
          </pre>
        </details>
      )}
    </div>
  )
}
