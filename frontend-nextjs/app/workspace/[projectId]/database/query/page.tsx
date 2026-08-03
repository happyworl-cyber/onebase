'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { queryAPI } from '@/lib/api'
import { formatDateTime, downloadFile } from '@/lib/utils'
import Pagination, { sliceForPage } from '@/components/Pagination'
import { askAi } from '@/lib/aiAssistant'
import { genRequestId } from '@/lib/embedBridge'

interface QueryResult {
  type: string
  data: any[]
  elapsed_ms: number
  row_count: number
  rows_affected?: number
  message?: string
}

// 一条语句的执行结果（批量执行时每条对应一个）
interface ExecItem {
  sql: string
  type: string
  success: boolean
  result?: QueryResult
  error?: string
}

interface QueryHistory {
  sql: string
  timestamp: string
  success: boolean
  type?: string
  row_count?: number
  rows_affected?: number
  elapsed_ms?: number
  error?: string
}

interface SavedQuery {
  id: string
  name: string
  sql: string
  createdAt: string
}

// localStorage 按当前连接 ID 分桶，避免在 A 项目下看到 / 重放 B 项目的历史。
// 拿不到 database_id 时（比如还没选连接）一律落到 'none' 桶里，与任何具体
// 项目都不重叠。读取 current_connection 的格式见 lib/api.ts 的请求拦截器。
function getCurrentDbId(): string {
  if (typeof window === 'undefined') return 'none'
  try {
    const raw = localStorage.getItem('current_connection')
    if (!raw) return 'none'
    const conn = JSON.parse(raw)
    if (conn && conn.database_id != null) return String(conn.database_id)
  } catch {
    /* localStorage 里塞了非 JSON 串就当没选连接处理 */
  }
  return 'none'
}

function historyKey(dbId: string) {
  return `query_history:db_${dbId}`
}
function savedKey(dbId: string) {
  return `saved_queries:db_${dbId}`
}

// 老版本是无桶的全局键，会在 A 项目下泄漏到 B 项目。一次性清掉这两个键，
// 避免新装老用户继续看到老历史；新写入会落到带 db 后缀的新键里。
function pruneLegacyGlobalKeys() {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem('query_history')
    localStorage.removeItem('saved_queries')
  } catch {
    /* localStorage 不可用就算了 */
  }
}

// SQL 语法高亮的关键字
const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'ILIKE',
  'ORDER BY', 'GROUP BY', 'HAVING', 'LIMIT', 'OFFSET', 'JOIN', 'LEFT JOIN',
  'RIGHT JOIN', 'INNER JOIN', 'OUTER JOIN', 'ON', 'AS', 'DISTINCT', 'COUNT',
  'SUM', 'AVG', 'MIN', 'MAX', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET',
  'DELETE', 'CREATE', 'TABLE', 'INDEX', 'VIEW', 'ALTER', 'DROP', 'ADD',
  'COLUMN', 'PRIMARY KEY', 'FOREIGN KEY', 'REFERENCES', 'CONSTRAINT',
  'DEFAULT', 'NULL', 'NOT NULL', 'UNIQUE', 'CASCADE', 'RETURNING', 'WITH',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'IS', 'BETWEEN', 'EXISTS',
  'UNION', 'INTERSECT', 'EXCEPT', 'ALL', 'ANY', 'SOME', 'TRUE', 'FALSE',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION', 'GRANT', 'REVOKE', 'TRUNCATE'
]

// 剥掉 SQL 开头的 -- 行注释 和 /* */ 块注释，让 getSqlType 能识别
// "脚本第一行是注释" 的常见写法。逻辑必须和后端
// `raw_sql_guard::strip_leading_sql_comments` 保持一致——任何一边漏剥都会
// 让首关键字误判，进而触发 acknowledge_destructive 不一致的 400。
function stripLeadingSqlComments(sql: string): string {
  let rest = sql
  while (true) {
    const trimmed = rest.replace(/^\s+/, '')
    if (trimmed.startsWith('--')) {
      const nl = trimmed.indexOf('\n', 2)
      if (nl < 0) return ''
      rest = trimmed.slice(nl + 1)
    } else if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/', 2)
      if (end < 0) return ''
      rest = trimmed.slice(end + 2)
    } else {
      return trimmed
    }
  }
}

// 判断 SQL 类型——返回的是"裸首关键字"（如 'GRANT' / 'BEGIN'），
// 不是后端那种归类标签（'PERMISSION' / 'TRANSACTION'）；后端审计日志
// 用的是分类标签，但前端 UI 直接给用户看关键字更直白。
function getSqlType(sql: string): string {
  const body = stripLeadingSqlComments(sql)
  const firstWord = body.toUpperCase().split(/\s+/)[0]
  return firstWord || 'UNKNOWN'
}

// 是否需要后端的 acknowledge_destructive=true。和
// `raw_sql_guard::require_destructive_ack` 对齐：只有 SELECT 类（含
// WITH/EXPLAIN/SHOW）放行；其余包括 GRANT/REVOKE/BEGIN/COMMIT/ROLLBACK
// 在内都必须二次确认。漏掉任何一类都会让前端默默发 `false`、被后端拒，
// 用户只能看到 400 而看不到确认弹窗。
function requiresDestructiveAck(sql: string): boolean {
  const type = getSqlType(sql)
  if (type === 'UNKNOWN') return false
  return !['SELECT', 'WITH', 'EXPLAIN', 'SHOW'].includes(type)
}

// 判断是否是"会改业务数据"的写操作——只用于 UI 染色和按钮文案，
// 不用于决定要不要弹确认窗（那个看 requiresDestructiveAck）。
function isWriteOperation(sql: string): boolean {
  const type = getSqlType(sql)
  return ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE'].includes(type)
}

// 剥掉 SQL 里所有 `--` / `/* */` 注释（保留字符串与美元引用），执行前调用。
// 逻辑与后端 `raw_sql_guard::strip_sql_comments` 对齐。
function stripSqlComments(sql: string): string {
  let out = ''
  let i = 0
  const n = sql.length
  let inSingle = false
  let inDouble = false
  let inLineComment = false
  let inBlockComment = false
  let dollarTag: string | null = null

  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false
        out += ch
      }
      i++
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        i += 2
        inBlockComment = false
      } else if (ch === '\n') {
        out += ch
        i++
      } else {
        i++
      }
      continue
    }
    if (dollarTag) {
      if (ch === '$' && sql.startsWith(dollarTag, i)) {
        out += dollarTag
        i += dollarTag.length
        dollarTag = null
        continue
      }
      out += ch
      i++
      continue
    }
    if (inSingle) {
      out += ch
      if (ch === "'") {
        if (next === "'") {
          out += next
          i += 2
          continue
        }
        inSingle = false
      }
      i++
      continue
    }
    if (inDouble) {
      out += ch
      if (ch === '"') {
        if (next === '"') {
          out += next
          i += 2
          continue
        }
        inDouble = false
      }
      i++
      continue
    }
    if (ch === '-' && next === '-') {
      inLineComment = true
      i += 2
      continue
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true
      i += 2
      continue
    }
    if (ch === "'") {
      inSingle = true
      out += ch
      i++
      continue
    }
    if (ch === '"') {
      inDouble = true
      out += ch
      i++
      continue
    }
    if (ch === '$') {
      const m = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i))
      if (m) {
        dollarTag = m[0]
        out += dollarTag
        i += dollarTag.length
        continue
      }
    }
    out += ch
    i++
  }
  return out.trim()
}

// 判断是否是危险操作
function isDangerousOperation(sql: string): boolean {
  const upper = sql.toUpperCase()
  return upper.includes('DROP') || upper.includes('TRUNCATE') || upper.includes('DELETE FROM') && !upper.includes('WHERE')
}

// 把一段可能含多条语句的 SQL 脚本拆成单条语句（按分号切分）。
// 需要正确跳过：单引号字符串（含 '' 转义）、双引号标识符、行注释 --、
// 块注释 /* */、以及美元引用 $$...$$ / $tag$...$tag$（函数体常用）。
// 否则字符串/注释里的分号会被误当成语句边界。
function splitSqlStatements(sql: string): string[] {
  const stmts: string[] = []
  let cur = ''
  let i = 0
  const n = sql.length
  let inSingle = false
  let inDouble = false
  let inLineComment = false
  let inBlockComment = false
  let dollarTag: string | null = null

  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false
        cur += ch
      }
      i++
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        i += 2
        inBlockComment = false
        continue
      }
      if (ch === '\n') cur += ch
      i++
      continue
    }
    if (dollarTag) {
      if (ch === '$' && sql.startsWith(dollarTag, i)) {
        cur += dollarTag
        i += dollarTag.length
        dollarTag = null
        continue
      }
      cur += ch
      i++
      continue
    }
    if (inSingle) {
      cur += ch
      if (ch === "'") {
        if (next === "'") {
          cur += next
          i += 2
          continue
        }
        inSingle = false
      }
      i++
      continue
    }
    if (inDouble) {
      cur += ch
      if (ch === '"') {
        if (next === '"') {
          cur += next
          i += 2
          continue
        }
        inDouble = false
      }
      i++
      continue
    }
    // 普通状态
    if (ch === '-' && next === '-') {
      inLineComment = true
      i += 2
      continue
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true
      i += 2
      continue
    }
    if (ch === "'") {
      inSingle = true
      cur += ch
      i++
      continue
    }
    if (ch === '"') {
      inDouble = true
      cur += ch
      i++
      continue
    }
    if (ch === '$') {
      const m = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i))
      if (m) {
        dollarTag = m[0]
        cur += dollarTag
        i += dollarTag.length
        continue
      }
    }
    if (ch === ';') {
      if (cur.trim()) stmts.push(cur.trim())
      cur = ''
      i++
      continue
    }
    cur += ch
    i++
  }
  if (cur.trim()) stmts.push(cur.trim())
  // 丢掉纯注释 / 空白的“语句”
  return stmts.filter((s) => stripLeadingSqlComments(s).trim() !== '')
}

export default function QueryPage() {
  const [sql, setSql] = useState('SELECT * FROM public.users LIMIT 10;')
  // 批量执行：每条语句一个结果项（按执行顺序）
  const [results, setResults] = useState<ExecItem[]>([])
  const [loading, setLoading] = useState(false)
  const [history, setHistory] = useState<QueryHistory[]>([])
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([])
  const [activeTab, setActiveTab] = useState<'history' | 'saved'>('history')
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [readOnly, setReadOnly] = useState(false)
  // E5：写/DDL 操作触发的二次确认 modal。confirmText 用户必须手抄输入；
  // 抄对了 onConfirm 才被 enabled，避免"无脑回车点确定"。
  const [confirmModal, setConfirmModal] = useState<null | {
    sqlType: string
    isDangerous: boolean
    confirmPhrase: string
    statements: string[]
  }>(null)
  const [confirmInput, setConfirmInput] = useState('')
  // 当前连接 ID（"none" 表示未选择连接）。切连接时 reload 一次 history / saved。
  const [dbId, setDbId] = useState<string>('none')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 历史 / 已保存的客户端分页：每页 10 条，切 tab / 切连接 / 删除条目时 reset 到第 1 页。
  const [historyPage, setHistoryPage] = useState(1)
  const [savedPage, setSavedPage] = useState(1)
  const HISTORY_PAGE_SIZE = 10
  const SAVED_PAGE_SIZE = 10
  const pagedHistory = useMemo(
    () => sliceForPage(history, historyPage, HISTORY_PAGE_SIZE),
    [history, historyPage],
  )
  const pagedSavedQueries = useMemo(
    () => sliceForPage(savedQueries, savedPage, SAVED_PAGE_SIZE),
    [savedQueries, savedPage],
  )

  // 当前编辑器里拆出来的语句列表（用于按钮文案 / 批量执行 / 类型徽标）
  const statements = useMemo(() => splitSqlStatements(sql), [sql])
  const isMulti = statements.length > 1
  const firstError = useMemo(() => results.find((r) => !r.success), [results])

  // 按当前 dbId 重新加载历史 / 保存的查询。封装出来给挂载和切换连接时复用。
  const reloadFromStorage = useCallback((id: string) => {
    if (typeof window === 'undefined') return
    try {
      const h = localStorage.getItem(historyKey(id))
      setHistory(h ? JSON.parse(h) : [])
    } catch {
      setHistory([])
    }
    try {
      const s = localStorage.getItem(savedKey(id))
      setSavedQueries(s ? JSON.parse(s) : [])
    } catch {
      setSavedQueries([])
    }
    // 切连接 / 切桶时把页码归位，防止从"第 5 页"跳到"只有 2 页"的连接看到空列表
    setHistoryPage(1)
    setSavedPage(1)
  }, [])

  // 首次挂载：清掉旧的全局键，按当前连接读取
  useEffect(() => {
    pruneLegacyGlobalKeys()
    const id = getCurrentDbId()
    setDbId(id)
    reloadFromStorage(id)
  }, [reloadFromStorage])

  // 监听数据库和 Schema 切换
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handleDbChange = () => {
      // 切了连接：清掉上一份结果，并重新拉对应连接桶里的历史
      setResults([])
      const id = getCurrentDbId()
      setDbId(id)
      reloadFromStorage(id)
    }
    const handleSchemaChange = () => {
      setResults([])
    }
    window.addEventListener('database-changed', handleDbChange)
    window.addEventListener('schema-changed', handleSchemaChange)
    return () => {
      window.removeEventListener('database-changed', handleDbChange)
      window.removeEventListener('schema-changed', handleSchemaChange)
    }
  }, [reloadFromStorage])

  // 批量保存历史记录到当前连接对应的桶（最后执行的排在最前）
  const saveHistoryBatch = (items: QueryHistory[]) => {
    if (!items.length) return
    setHistory((prev) => {
      const merged = [...[...items].reverse(), ...prev].slice(0, 100) // 保留最近 100 条
      if (typeof window !== 'undefined') {
        localStorage.setItem(historyKey(dbId), JSON.stringify(merged))
      }
      return merged
    })
    // 新执行的查询是最新的——把分页跳回第 1 页才能让用户立刻看到
    setHistoryPage(1)
  }

  // 顺序执行多条语句：每条单独发请求（各自带上正确的 acknowledge_destructive），
  // 实时把结果追加到 results；任一条报错即停止后续执行（类似 psql 默认行为）。
  const runStatements = async (stmts: string[]) => {
    if (!stmts.length) return
    setLoading(true)
    setResults([])
    const items: ExecItem[] = []
    const hist: QueryHistory[] = []
    try {
      for (const stmt of stmts) {
        const execSql = stripSqlComments(stmt)
        if (!execSql.trim()) continue
        const ack = !readOnly && requiresDestructiveAck(execSql)
        try {
          const response = await queryAPI.execute(execSql, readOnly, ack)
          const data = response.data
          items.push({ sql: stmt, type: data.type ?? getSqlType(stmt), success: true, result: data })
          hist.push({
            sql: stmt,
            timestamp: new Date().toISOString(),
            success: true,
            type: data.type,
            row_count: data.row_count,
            rows_affected: data.rows_affected,
            elapsed_ms: data.elapsed_ms,
          })
          setResults([...items])
        } catch (err: any) {
          console.error('SQL 查询失败:', err)
          const errorMsg = err.response?.data?.error || err.message || '查询失败'
          items.push({ sql: stmt, type: getSqlType(stmt), success: false, error: errorMsg })
          hist.push({
            sql: stmt,
            timestamp: new Date().toISOString(),
            success: false,
            type: getSqlType(stmt),
            error: errorMsg,
          })
          setResults([...items])
          break // 出错即停，避免在不一致状态下继续跑后面的语句
        }
      }
    } finally {
      saveHistoryBatch(hist)
      setLoading(false)
    }
  }

  // 执行查询入口：根据 SQL 类型决定是否要走二次确认弹窗（E5）。
  // SELECT / read_only 模式：直接跑；
  // 任何"非 SELECT"（写 / DDL / GRANT / BEGIN ...）都得弹 modal，让用户手输
  // SQL 类型短语再放行——这里用 requiresDestructiveAck 而不是 isWriteOperation，
  // 因为后端的 ack 闸覆盖范围更宽（包含 PERMISSION / TRANSACTION / OTHER），
  // 漏掉任何一类都会让前端默默发 false → 用户只看到 400 不看到弹窗。
  const executeQuery = async () => {
    const stmts = splitSqlStatements(sql)
    if (stmts.length === 0) return

    // 需要二次确认的写/DDL 语句（只读模式下后端只允许 SELECT，无需弹窗）
    const writeStmts = readOnly ? [] : stmts.filter(requiresDestructiveAck)

    if (writeStmts.length === 0) {
      // 全是 SELECT / 只读模式：直接顺序执行
      await runStatements(stmts)
      return
    }

    const isDangerous = stmts.some(isDangerousOperation)

    if (stmts.length === 1) {
      // 单条写操作：沿用原来的"手抄 SQL 类型"确认 UX
      const sqlType = getSqlType(stmts[0])
      setConfirmModal({
        sqlType,
        isDangerous,
        confirmPhrase: isDangerous ? `${sqlType} CONFIRM` : sqlType,
        statements: stmts,
      })
    } else {
      // 批量：手抄 CONFIRM 放行（含写操作的多条脚本）
      setConfirmModal({
        sqlType: `批量 ${stmts.length} 条（含 ${writeStmts.length} 条写/DDL）`,
        isDangerous,
        confirmPhrase: 'CONFIRM',
        statements: stmts,
      })
    }
    setConfirmInput('')
  }

  const onConfirmExecute = async () => {
    const stmts = confirmModal?.statements ?? []
    setConfirmModal(null)
    await runStatements(stmts)
  }

  // 导出某条结果的 CSV（按该条语句重新走导出接口）
  const exportItemCSV = async (item: ExecItem) => {
    if (!item.sql.trim() || !item.result?.data?.length) return

    try {
      const response = await queryAPI.exportCSV(item.sql)
      downloadFile(response.data, `query_${Date.now()}.csv`)
    } catch (err: any) {
      alert('导出失败：' + (err.response?.data?.error || err.message))
    }
  }

  // 保存查询
  const saveQuery = () => {
    if (!saveName.trim() || !sql.trim()) return
    
    const newQuery: SavedQuery = {
      id: Date.now().toString(),
      name: saveName,
      sql: sql,
      createdAt: new Date().toISOString(),
    }
    
    const updated = [newQuery, ...savedQueries]
    setSavedQueries(updated)
    localStorage.setItem(savedKey(dbId), JSON.stringify(updated))
    setShowSaveDialog(false)
    setSaveName('')
  }

  // 删除保存的查询
  const deleteSavedQuery = (id: string) => {
    const updated = savedQueries.filter(q => q.id !== id)
    setSavedQueries(updated)
    localStorage.setItem(savedKey(dbId), JSON.stringify(updated))
  }

  // 清空当前连接的历史
  const clearHistory = () => {
    setHistory([])
    localStorage.removeItem(historyKey(dbId))
    setHistoryPage(1)
  }

  // 格式化 SQL（简单格式化）。只折叠行内空白，保留换行——
  // 全局 `\s+` 会把 `-- 注释\nCREATE` 压成一行，注释会吞掉后续语句。
  const formatSQL = () => {
    let formatted = sql
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
      .join('\n')
      .replace(/,\s*/g, ',\n  ')
      .replace(/\bSELECT\b/gi, 'SELECT\n  ')
      .replace(/\bFROM\b/gi, '\nFROM')
      .replace(/\bWHERE\b/gi, '\nWHERE')
      .replace(/\bAND\b/gi, '\n  AND')
      .replace(/\bOR\b/gi, '\n  OR')
      .replace(/\bORDER BY\b/gi, '\nORDER BY')
      .replace(/\bGROUP BY\b/gi, '\nGROUP BY')
      .replace(/\bHAVING\b/gi, '\nHAVING')
      .replace(/\bLIMIT\b/gi, '\nLIMIT')
      .replace(/\bJOIN\b/gi, '\nJOIN')
      .replace(/\bLEFT JOIN\b/gi, '\nLEFT JOIN')
      .replace(/\bRIGHT JOIN\b/gi, '\nRIGHT JOIN')
      .replace(/\bINNER JOIN\b/gi, '\nINNER JOIN')
    setSql(formatted.trim())
  }

  // 键盘快捷键
  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Ctrl/Cmd + Enter 执行查询
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      executeQuery()
    }
    // Ctrl/Cmd + S 保存查询
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault()
      setShowSaveDialog(true)
    }
  }

  // 把当前 SQL 交给 AI 助手分析（打开右侧面板并自动发起一轮提问）
  const analyzeWithAi = () => {
    if (!sql.trim()) return
    askAi({
      prompt:
        '请分析下面这条 SQL 的作用、性能与潜在风险，并给出优化建议：\n\n' +
        '```sql\n' +
        sql.trim() +
        '\n```',
      requestId: genRequestId('sql-analyze'),
    })
  }

  // 把某条出错的 SQL + 报错信息交给 AI 助手排查
  const debugErrorWithAi = (item: ExecItem) => {
    if (!item.error) return
    askAi({
      prompt:
        '我执行下面这条 SQL 时报错了，请帮我分析原因并给出修复方案：\n\n' +
        '```sql\n' +
        item.sql.trim() +
        '\n```\n\n报错信息：\n```\n' +
        item.error +
        '\n```',
      requestId: genRequestId('sql-debug'),
    })
  }

  const sqlType = getSqlType(sql)
  const isWrite = statements.some(isWriteOperation)

  return (
    <div className="h-full flex flex-col">
      {/* E5：高风险通道警示横幅。/query 是平台超管直连接口，绕过 RBAC，
            所有调用都被 audit_logs 留痕；面板里能看到。 */}
      <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <div className="flex items-start gap-3">
          <i className="fas fa-exclamation-triangle mt-0.5 text-amber-600"></i>
          <div className="space-y-1">
            <div className="font-semibold">这是 SQL 编辑器 —— 平台级原始 SQL 通道</div>
            <ul className="list-disc list-inside text-xs text-amber-800 space-y-0.5">
              <li>所有调用都会被记录在 <span className="font-mono">management.audit_logs</span>（含 SQL 类型、长度、调用者），可在「平台 → 审计 → 原始 SQL 审计」面板回溯。</li>
              <li>禁止访问 <span className="font-mono">management.*</span> schema 与 <span className="font-mono">pg_catalog</span> / <span className="font-mono">information_schema</span> 系统视图，请求会被后端拦截。</li>
              <li>必须先在右上角选定目标数据库（<span className="font-mono">X-Database-Id</span>），否则后端直接 403。</li>
              <li>写 / DDL 类操作需要二次手动输入确认，避免误执行。</li>
            </ul>
          </div>
        </div>
      </div>

      {/* 页面头部 */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">SQL 编辑器</h1>
          <p className="text-sm text-gray-500 mt-1">
            支持所有 SQL 操作 · 可用 ; 分隔一次执行多条语句 · 快捷键: Ctrl+Enter 执行
          </p>
        </div>
        
        <div className="flex items-center space-x-3">
          {/* 只读模式切换 */}
          <label className="flex items-center space-x-2 text-sm">
            <input
              type="checkbox"
              checked={readOnly}
              onChange={(e) => setReadOnly(e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-gray-600">只读模式</span>
          </label>
        </div>
      </div>

      <div className="flex-1 grid grid-cols-12 gap-4 min-h-0">
        {/* 左侧：查询编辑器 */}
        <div className="col-span-8 flex flex-col min-h-0">
          {/* 编辑器 */}
          <div className="card flex-1 flex flex-col min-h-0">
            <div className="px-4 py-2 border-b border-gray-200 flex items-center justify-between bg-gray-50">
              <div className="flex items-center space-x-3">
                <span className="text-sm font-medium text-gray-700">SQL 查询</span>
                {isMulti ? (
                  <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                    isWrite ? 'bg-yellow-100 text-yellow-700' : 'bg-indigo-100 text-indigo-700'
                  }`}>
                    {statements.length} 条语句
                  </span>
                ) : sql.trim() ? (
                  <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                    isWrite
                      ? isDangerousOperation(sql)
                        ? 'bg-red-100 text-red-700'
                        : 'bg-yellow-100 text-yellow-700'
                      : 'bg-green-100 text-green-700'
                  }`}>
                    {sqlType}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center space-x-2">
                <button
                  onClick={formatSQL}
                  className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1"
                  title="格式化 SQL"
                >
                  <i className="fas fa-align-left mr-1"></i>
                  格式化
                </button>
                <button
                  onClick={() => setShowSaveDialog(true)}
                  disabled={!sql.trim()}
                  className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 disabled:opacity-50"
                  title="保存查询"
                >
                  <i className="fas fa-save mr-1"></i>
                  保存
                </button>
              </div>
            </div>
            
            <div className="flex-1 min-h-0">
              <textarea
                ref={textareaRef}
                value={sql}
                onChange={(e) => setSql(e.target.value)}
                onKeyDown={handleKeyDown}
                className="w-full h-full p-4 font-mono text-sm resize-none focus:outline-none border-0"
                placeholder="输入 SQL 查询语句... (支持 SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP 等)"
                spellCheck={false}
              />
            </div>

            <div className="px-4 py-3 border-t border-gray-200 flex items-center justify-between bg-gray-50">
              <div className="flex items-center space-x-2">
                <button
                  onClick={executeQuery}
                  disabled={loading || statements.length === 0}
                  className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                    isWrite && !readOnly
                      ? 'bg-yellow-500 hover:bg-yellow-600 text-white'
                      : 'bg-green-500 hover:bg-green-600 text-white'
                  } disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  <i className={`fas ${loading ? 'fa-spinner fa-spin' : 'fa-play'} mr-2`}></i>
                  {loading
                    ? '执行中...'
                    : isMulti
                      ? `执行 ${statements.length} 条语句`
                      : isWrite && !readOnly
                        ? '执行写操作'
                        : '执行查询'}
                </button>

                <button
                  onClick={() => setSql('')}
                  className="btn-default text-sm"
                >
                  <i className="fas fa-eraser mr-2"></i>
                  清空
                </button>

                <button
                  onClick={analyzeWithAi}
                  disabled={!sql.trim()}
                  className="px-3 py-2 text-sm font-medium rounded-lg text-white bg-gradient-to-br from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  title="用 AI 分析当前 SQL"
                >
                  <i className="fas fa-robot mr-2"></i>
                  AI 分析
                </button>
              </div>
              
              <span className="text-xs text-gray-500">
                Ctrl+Enter 执行 · Ctrl+S 保存
              </span>
            </div>
          </div>

          {/* 查询结果（批量执行时每条语句一个结果块） */}
          <div className="mt-4 flex-1 min-h-[200px] max-h-[420px] overflow-auto space-y-3">
            {results.length === 0 ? (
              <div className="card h-full flex items-center justify-center text-gray-400">
                <div className="text-center">
                  <i className="fas fa-terminal text-4xl mb-3"></i>
                  <p>执行查询后结果将显示在这里</p>
                </div>
              </div>
            ) : (
              results.map((item, idx) =>
                item.success && item.result ? (
                  <div key={idx} className="card flex flex-col">
                    <div className="px-4 py-2 border-b border-gray-200 flex items-center justify-between bg-gray-50">
                      <div className="flex items-center space-x-3 min-w-0">
                        {isMulti && (
                          <span className="text-xs font-mono text-gray-400 flex-shrink-0">#{idx + 1}</span>
                        )}
                        <h3 className="text-sm font-semibold text-gray-700 truncate">
                          {item.result.message || '查询结果'}
                        </h3>
                        <span className={`text-xs px-2 py-0.5 rounded font-medium flex-shrink-0 ${
                          item.result.type === 'SELECT' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                        }`}>
                          {item.result.type}
                        </span>
                      </div>
                      <div className="flex items-center space-x-3 text-xs text-gray-500 flex-shrink-0">
                        <span>
                          <i className="fas fa-clock mr-1"></i>
                          {item.result.elapsed_ms} ms
                        </span>
                        {item.result.rows_affected !== undefined && (
                          <span>
                            <i className="fas fa-edit mr-1"></i>
                            影响 {item.result.rows_affected} 行
                          </span>
                        )}
                        <span>
                          <i className="fas fa-list mr-1"></i>
                          返回 {item.result.row_count} 行
                        </span>
                        {item.result.data.length > 0 && (
                          <button
                            onClick={() => exportItemCSV(item)}
                            className="text-gray-500 hover:text-gray-700"
                            title="导出 CSV"
                          >
                            <i className="fas fa-download"></i>
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="max-h-[300px] overflow-auto">
                      {item.result.data.length === 0 ? (
                        <div className="p-6 text-center">
                          <i className="fas fa-check-circle text-2xl text-green-500 mb-2"></i>
                          <p className="text-sm text-gray-600">{item.result.message || '操作成功，无返回数据'}</p>
                        </div>
                      ) : (
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-gray-100">
                            <tr>
                              {Object.keys(item.result.data[0]).map((key) => (
                                <th key={key} className="px-3 py-2 text-left text-xs font-semibold text-gray-600 uppercase">
                                  {key}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {item.result.data.map((row, ri) => (
                              <tr key={ri} className="border-b border-gray-100 hover:bg-gray-50">
                                {Object.values(row).map((value: any, ci) => (
                                  <td key={ci} className="px-3 py-2">
                                    {value === null ? (
                                      <span className="text-gray-400 italic text-xs">NULL</span>
                                    ) : typeof value === 'object' ? (
                                      <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">
                                        {JSON.stringify(value)}
                                      </code>
                                    ) : typeof value === 'boolean' ? (
                                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                                        value ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'
                                      }`}>
                                        {value ? 'true' : 'false'}
                                      </span>
                                    ) : (
                                      <span className="max-w-[300px] truncate block" title={String(value)}>
                                        {String(value)}
                                      </span>
                                    )}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </div>
                ) : (
                  <div key={idx} className="card p-4 bg-red-50 border-red-200">
                    <div className="flex items-start space-x-3">
                      <i className="fas fa-exclamation-circle text-red-500 mt-0.5"></i>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-red-800">
                          查询错误{isMulti ? `（第 ${idx + 1} 条）` : ''}
                        </p>
                        {isMulti && (
                          <p className="text-xs text-red-700/80 mt-1 font-mono line-clamp-2">{item.sql}</p>
                        )}
                        <p className="text-sm text-red-600 mt-1 font-mono whitespace-pre-wrap">{item.error}</p>
                        <button
                          onClick={() => debugErrorWithAi(item)}
                          className="mt-3 inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-lg text-white bg-gradient-to-br from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 transition-colors"
                        >
                          <i className="fas fa-robot mr-1.5"></i>
                          问 AI 这个错误
                        </button>
                      </div>
                    </div>
                  </div>
                ),
              )
            )}
          </div>
        </div>

        {/* 右侧：历史和保存的查询 */}
        <div className="col-span-4 flex flex-col min-h-0">
          <div className="card flex-1 flex flex-col min-h-0">
            {/* Tab 切换 */}
            <div className="flex border-b border-gray-200">
              <button
                onClick={() => setActiveTab('history')}
                className={`flex-1 px-4 py-3 text-sm font-medium ${
                  activeTab === 'history'
                    ? 'text-blue-600 border-b-2 border-blue-600 bg-blue-50'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                <i className="fas fa-history mr-2"></i>
                历史 ({history.length})
              </button>
              <button
                onClick={() => setActiveTab('saved')}
                className={`flex-1 px-4 py-3 text-sm font-medium ${
                  activeTab === 'saved'
                    ? 'text-blue-600 border-b-2 border-blue-600 bg-blue-50'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                <i className="fas fa-star mr-2"></i>
                已保存 ({savedQueries.length})
              </button>
            </div>

            {/* 内容区域 */}
            <div className="flex-1 overflow-y-auto">
              {activeTab === 'history' ? (
                <>
                  {history.length > 0 && (
                    <div className="px-4 py-2 border-b border-gray-100 flex justify-end">
                      <button
                        onClick={clearHistory}
                        className="text-xs text-red-600 hover:text-red-700"
                      >
                        <i className="fas fa-trash mr-1"></i>
                        清空历史
                      </button>
                    </div>
                  )}
                  
                  {history.length === 0 ? (
                    <div className="p-8 text-center">
                      <i className="fas fa-history text-3xl text-gray-300 mb-3"></i>
                      <p className="text-sm text-gray-500">暂无查询历史</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-gray-100">
                      {pagedHistory.map((item, idx) => (
                        <div
                          key={`${item.timestamp}-${idx}`}
                          className="p-3 hover:bg-gray-50 cursor-pointer transition-colors"
                          onClick={() => setSql(item.sql)}
                        >
                          <div className="flex items-start space-x-2">
                            <i
                              className={`fas ${
                                item.success ? 'fa-check-circle text-green-500' : 'fa-times-circle text-red-500'
                              } text-sm mt-0.5 flex-shrink-0`}
                            ></i>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center space-x-2 mb-1">
                                {item.type && (
                                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                                    item.type === 'SELECT' ? 'bg-blue-100 text-blue-600' :
                                    ['INSERT', 'UPDATE', 'DELETE'].includes(item.type) ? 'bg-yellow-100 text-yellow-600' :
                                    'bg-gray-100 text-gray-600'
                                  }`}>
                                    {item.type}
                                  </span>
                                )}
                                <span className="text-xs text-gray-400">
                                  {formatDateTime(item.timestamp)}
                                </span>
                              </div>
                              <p className="text-xs font-mono text-gray-800 line-clamp-2">
                                {item.sql}
                              </p>
                              {item.success && (
                                <div className="flex items-center space-x-2 mt-1 text-xs text-gray-500">
                                  {item.rows_affected !== undefined && (
                                    <span>影响 {item.rows_affected} 行</span>
                                  )}
                                  {item.row_count !== undefined && (
                                    <span>返回 {item.row_count} 行</span>
                                  )}
                                  {item.elapsed_ms !== undefined && (
                                    <span>{item.elapsed_ms} ms</span>
                                  )}
                                </div>
                              )}
                              {item.error && (
                                <p className="text-xs text-red-600 mt-1 line-clamp-1">{item.error}</p>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {history.length > HISTORY_PAGE_SIZE && (
                    <div className="px-3 py-2 border-t border-gray-100 bg-gray-50/40 sticky bottom-0">
                      <Pagination
                        total={history.length}
                        page={historyPage}
                        pageSize={HISTORY_PAGE_SIZE}
                        onPageChange={setHistoryPage}
                        compact
                      />
                    </div>
                  )}
                </>
              ) : (
                <>
                  {savedQueries.length === 0 ? (
                    <div className="p-8 text-center">
                      <i className="fas fa-star text-3xl text-gray-300 mb-3"></i>
                      <p className="text-sm text-gray-500">暂无保存的查询</p>
                      <p className="text-xs text-gray-400 mt-1">使用 Ctrl+S 保存常用查询</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-gray-100">
                      {pagedSavedQueries.map((item) => (
                        <div
                          key={item.id}
                          className="p-3 hover:bg-gray-50 cursor-pointer transition-colors group"
                          onClick={() => setSql(item.sql)}
                        >
                          <div className="flex items-start justify-between">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-gray-900">{item.name}</p>
                              <p className="text-xs font-mono text-gray-600 mt-1 line-clamp-2">
                                {item.sql}
                              </p>
                              <span className="text-xs text-gray-400 mt-1 block">
                                {formatDateTime(item.createdAt)}
                              </span>
                            </div>
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                deleteSavedQuery(item.id)
                              }}
                              className="opacity-0 group-hover:opacity-100 p-1 text-red-500 hover:text-red-700 transition-opacity"
                              title="删除"
                            >
                              <i className="fas fa-trash text-xs"></i>
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {savedQueries.length > SAVED_PAGE_SIZE && (
                    <div className="px-3 py-2 border-t border-gray-100 bg-gray-50/40 sticky bottom-0">
                      <Pagination
                        total={savedQueries.length}
                        page={savedPage}
                        pageSize={SAVED_PAGE_SIZE}
                        onPageChange={setSavedPage}
                        compact
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* E5：写/DDL 二次确认 modal。必须手抄 SQL 类型短语（DROP / TRUNCATE 等
            高危的还要附 " CONFIRM"），抄对才能点确认。这是发到后端
            `acknowledge_destructive=true` 的前置闸——避免误点 / 误回车。 */}
      {confirmModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-[440px] p-6 space-y-4">
            <div className="flex items-start gap-3">
              <i
                className={`fas ${confirmModal.isDangerous ? 'fa-skull-crossbones text-red-600' : 'fa-exclamation-triangle text-amber-500'} text-2xl mt-1`}
              ></i>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">
                  {confirmModal.isDangerous ? '危险操作二次确认' : '写操作确认'}
                </h3>
                <p className="text-sm text-gray-600 mt-1">
                  即将执行 <span className="font-mono font-semibold">{confirmModal.sqlType}</span> 操作；
                  {confirmModal.isDangerous
                    ? '该操作可能不可逆并影响整张表。'
                    : '该操作会修改数据库数据。'}
                </p>
              </div>
            </div>
            <div className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded p-2">
              请在下方输入框中手动键入 <span className="font-mono text-gray-900">{confirmModal.confirmPhrase}</span> 以继续：
            </div>
            <input
              type="text"
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              placeholder={confirmModal.confirmPhrase}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500 font-mono"
              autoFocus
            />
            <div className="flex justify-end gap-3 pt-1">
              <button
                onClick={() => {
                  setConfirmModal(null)
                  setConfirmInput('')
                }}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
              >
                取消
              </button>
              <button
                onClick={onConfirmExecute}
                disabled={confirmInput.trim() !== confirmModal.confirmPhrase}
                className={`px-4 py-2 text-sm rounded-lg text-white ${
                  confirmModal.isDangerous
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-amber-500 hover:bg-amber-600'
                } disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                我已知晓，确认执行
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 保存对话框 */}
      {showSaveDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-96 p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">保存查询</h3>
            <input
              type="text"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="输入查询名称..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && saveQuery()}
            />
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => {
                  setShowSaveDialog(false)
                  setSaveName('')
                }}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
              >
                取消
              </button>
              <button
                onClick={saveQuery}
                disabled={!saveName.trim()}
                className="px-4 py-2 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
