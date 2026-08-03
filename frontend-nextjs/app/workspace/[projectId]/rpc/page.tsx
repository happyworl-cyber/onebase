'use client'

/**
 * RPC 测试器 —— PostgREST 风格的图形化调用面板。
 *
 * 调用形态与 Auto API 一致：项目 slug 直接出现在路径里，便于在迁移 Supabase
 * 代码时可视化地试跑：
 *   const { data } = await supabase.rpc('console_get_user_projects', { user_id: 1 })
 *
 * 直接对应到本项目的：
 *   POST /api/v1/{databaseSlug}/rpc/console_get_user_projects   { "user_id": 1 }
 *
 * 功能：
 *   - 当前 schema 下的 PG 函数列表（pg_proc 内省）
 *   - 点击函数自动按签名 scaffold JSON 参数模板
 *   - POST / GET 方法切换、Content/Accept-Profile schema 切换、Prefer: single-object
 *   - cURL 预览（拷出来给同事 / CI 直接复用）
 *   - 调用结果：状态 / 耗时 / JSON 响应
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { queryAPI, rpcAPI } from '@/lib/api'
import { usePublicApiConfig } from '@/lib/apiBase'
import { useAppStore } from '@/lib/store'
import { pgFunctionIdentity } from '@/lib/utils'
import { useNotification } from '@/hooks/useNotification'

interface FunctionInfo {
  schema_name: string
  function_name: string
  return_type: string
  argument_types: string
  function_type: string
  volatility: string
  language: string
  /**
   * 当前函数所属扩展（如 `citext`）。NULL = 用户自建函数。
   * 默认隐藏扩展函数，避免 citext 这类同名重载在 RPC 函数列表里反复刷屏。
   */
  extension_name: string | null
}

type RpcMethod = 'POST' | 'GET'

interface RpcCallResult {
  status: number
  elapsedMs: number
  data: unknown
  error?: string
}

// 把 `IN p_id integer, IN p_name text DEFAULT 'x'` 之类的签名拆出形参名。
// PG 用 ` ` 分隔修饰符 / 名字 / 类型，逗号分隔参数；忽略 DEFAULT 之后的内容。
// 拿不到名字的位置形参（比如 `integer` 没起名）会被跳过——RPC 命名参数模式
// 本来就要求显式形参名，匿名参数无法用 `arg := $N` 调用。
function parseFunctionArgs(sig: string): string[] {
  if (!sig?.trim()) return []
  const argNames: string[] = []
  let depth = 0
  let buf = ''
  const flush = () => {
    const piece = buf.trim()
    buf = ''
    if (!piece) return
    // 去掉 DEFAULT ... 部分
    const nameAndType = piece.split(/\s+DEFAULT\s+/i)[0].trim()
    // 拆出 token 后剔除 IN/OUT/INOUT/VARIADIC 等修饰符
    const tokens = nameAndType.split(/\s+/)
    const directionless = tokens.filter(
      (t) => !/^(IN|OUT|INOUT|VARIADIC)$/i.test(t),
    )
    // 形参形如 `name type` 或 `name type[]` 或 `name <some type>`；
    // 没显式名字的（只剩类型）跳过
    if (directionless.length < 2) return
    argNames.push(directionless[0])
  }
  for (const ch of sig) {
    if (ch === '(' || ch === '[') depth += 1
    else if (ch === ')' || ch === ']') depth -= 1
    if (ch === ',' && depth === 0) {
      flush()
      continue
    }
    buf += ch
  }
  flush()
  return argNames
}

// 把 JSON 体参数序列化成 cURL 可读的 query string，跟前端 `rpcAPI` GET 编码规则保持一致。
function buildQueryString(args: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(args)) {
    params.append(k, typeof v === 'string' ? v : JSON.stringify(v))
  }
  const s = params.toString()
  return s ? `?${s}` : ''
}

function buildCurl(opts: {
  method: RpcMethod
  fnName: string
  schema: string
  args: Record<string, unknown>
  singleObject: boolean
  baseURL: string
  databaseSlug: string | null
  /** 走网关时隐藏 API Key 鉴权头（网关统一鉴权）。 */
  gatewayMode?: boolean
}): string {
  const { method, fnName, schema, args, singleObject, baseURL, databaseSlug, gatewayMode = false } = opts
  // 没选项目时 fallback 到占位符；实际调用按钮会校验，cURL 也只是给用户看的。
  const dbSeg = databaseSlug ?? '<DATABASE_SLUG>'
  const fnPath = `/api/v1/${dbSeg}/rpc/${encodeURIComponent(fnName)}`
  const lines: string[] = []
  if (method === 'GET') {
    lines.push(`curl -X GET "${baseURL}${fnPath}${buildQueryString(args)}"`)
    // 走网关时鉴权由网关统一处理，示例不再展示 API Key 头。
    if (!gatewayMode) {
      lines[lines.length - 1] += ' \\'
      lines.push(`  -H "Authorization: Bearer <YOUR_TOKEN>"`)
    }
    if (schema && schema !== 'public') {
      lines[lines.length - 1] += ' \\'
      lines.push(`  -H "Accept-Profile: ${schema}"`)
    }
  } else {
    lines.push(`curl -X POST "${baseURL}${fnPath}"`)
    if (!gatewayMode) {
      lines[lines.length - 1] += ' \\'
      lines.push(`  -H "Authorization: Bearer <YOUR_TOKEN>"`)
    }
    lines[lines.length - 1] += ' \\'
    lines.push(`  -H "Content-Type: application/json"`)
    if (schema && schema !== 'public') {
      lines[lines.length - 1] += ' \\'
      lines.push(`  -H "Content-Profile: ${schema}"`)
    }
    if (singleObject) {
      lines[lines.length - 1] += ' \\'
      lines.push(`  -H "Prefer: params=single-object"`)
    }
    lines[lines.length - 1] += ' \\'
    lines.push(`  -d '${JSON.stringify(args, null, 0)}'`)
  }
  return lines.join('\n')
}

export default function RpcPlaygroundPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params?.projectId ?? '', 10)
  const { currentSchema, currentTenant, currentConnection } = useAppStore()
  const notify = useNotification()

  // RPC 路径段优先取当前连接标识；缺失时回退到当前项目 slug。
  const databaseSlug =
    currentConnection?.database_slug ??
    (currentTenant?.slug || null)

  const [functions, setFunctions] = useState<FunctionInfo[]>([])
  const [loadingList, setLoadingList] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [selected, setSelected] = useState<FunctionInfo | null>(null)
  /** 是否把扩展（citext / pg_trgm 等）带进来的函数也列进来。默认隐藏，理由同 functions 页。 */
  const [showExtensionFunctions, setShowExtensionFunctions] = useState(false)

  // 调用面板表单状态
  const [method, setMethod] = useState<RpcMethod>('POST')
  const [fnName, setFnName] = useState('')
  const [schema, setSchema] = useState('public')
  const [singleObject, setSingleObject] = useState(false)
  const [argsJson, setArgsJson] = useState('{}')

  // 结果
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<RpcCallResult | null>(null)

  useEffect(() => {
    if (currentSchema) setSchema(currentSchema)
  }, [currentSchema])

  // 列出当前 schema 下所有 function/procedure（与 functions 页相同口径）。
  // 用 LEFT JOIN pg_depend/pg_extension 把扩展归属带出来；toggle 切换不必重查。
  const loadFunctions = useCallback(async () => {
    if (!currentSchema) return
    setLoadingList(true)
    try {
      const res = await queryAPI.execute(
        `
        SELECT 
          n.nspname  AS schema_name,
          p.proname  AS function_name,
          pg_get_function_result(p.oid)    AS return_type,
          pg_get_function_arguments(p.oid) AS argument_types,
          CASE p.prokind
            WHEN 'f' THEN 'function'
            WHEN 'p' THEN 'procedure'
            WHEN 'a' THEN 'aggregate'
            WHEN 'w' THEN 'window'
          END AS function_type,
          CASE p.provolatile
            WHEN 'i' THEN 'IMMUTABLE'
            WHEN 's' THEN 'STABLE'
            WHEN 'v' THEN 'VOLATILE'
          END AS volatility,
          l.lanname AS language,
          e.extname AS extension_name
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        JOIN pg_language  l ON p.prolang     = l.oid
        LEFT JOIN pg_depend d
          ON d.objid = p.oid
         AND d.deptype = 'e'
         AND d.classid = 'pg_proc'::regclass
        LEFT JOIN pg_extension e ON e.oid = d.refobjid
        WHERE n.nspname = '${currentSchema}'
          AND p.prokind IN ('f', 'p')
        ORDER BY p.proname
        `,
        true,
      )
      setFunctions(res.data.data || [])
    } catch (err: any) {
      notify.error(err)
    } finally {
      setLoadingList(false)
    }
  }, [currentSchema, notify])

  useEffect(() => {
    loadFunctions()
  }, [loadFunctions])

  const filtered = useMemo(
    () =>
      functions.filter((f) => {
        if (!showExtensionFunctions && f.extension_name) return false
        return f.function_name.toLowerCase().includes(searchTerm.toLowerCase())
      }),
    [functions, searchTerm, showExtensionFunctions],
  )
  const hiddenExtensionCount = useMemo(
    () => functions.filter((f) => !!f.extension_name).length,
    [functions],
  )

  // 点击函数 → 同步调用面板
  const pickFunction = (fn: FunctionInfo) => {
    setSelected(fn)
    setFnName(fn.function_name)
    setSchema(fn.schema_name)
    const argNames = parseFunctionArgs(fn.argument_types)
    const scaffold: Record<string, unknown> = {}
    for (const name of argNames) scaffold[name] = null
    setArgsJson(JSON.stringify(scaffold, null, 2))
    setResult(null)
    // STABLE / IMMUTABLE 的函数默认推荐用 GET（可缓存、便于排查）
    if (fn.volatility === 'STABLE' || fn.volatility === 'IMMUTABLE') {
      setMethod('GET')
    } else {
      setMethod('POST')
    }
    setSingleObject(false)
  }

  // 解析输入框中的 JSON
  const parsedArgs = useMemo<{ ok: true; value: Record<string, unknown> } | { ok: false; error: string }>(() => {
    const trimmed = argsJson.trim()
    if (!trimmed) return { ok: true, value: {} }
    try {
      const v = JSON.parse(trimmed)
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        return { ok: false, error: '参数必须是 JSON 对象（{}）' }
      }
      return { ok: true, value: v as Record<string, unknown> }
    } catch (e: any) {
      return { ok: false, error: `JSON 解析失败：${e.message}` }
    }
  }, [argsJson])

  // 对外调用基址：运行期解析(网关域名) > 构建期 NEXT_PUBLIC_API_URL > 浏览器 origin。
  // gatewayMode：配了网关域名时，curl 示例隐藏 API Key 鉴权头（网关统一鉴权）。
  const { apiBase: baseURL, gatewayMode } = usePublicApiConfig(projectId)

  const curl = useMemo(() => {
    if (!fnName) return ''
    if (!parsedArgs.ok) return ''
    return buildCurl({
      method,
      fnName,
      schema,
      args: parsedArgs.value,
      singleObject,
      baseURL,
      databaseSlug,
      gatewayMode,
    })
  }, [fnName, schema, method, singleObject, parsedArgs, baseURL, databaseSlug, gatewayMode])

  const runRpc = async () => {
    if (!fnName.trim()) {
      notify.warning('请填入函数名')
      return
    }
    if (!databaseSlug) {
      notify.warning('请先选择项目（项目标识缺失，无法拼接 RPC 路径）')
      return
    }
    if (!parsedArgs.ok) {
      notify.warning(parsedArgs.error)
      return
    }
    setRunning(true)
    setResult(null)
    const startedAt = performance.now()
    try {
      const resp = await rpcAPI.call(
        databaseSlug,
        fnName.trim(),
        parsedArgs.value,
        {
          method,
          schema,
          singleObject: method === 'POST' ? singleObject : false,
        },
      )
      setResult({
        status: resp.status,
        elapsedMs: Math.round(performance.now() - startedAt),
        data: resp.data,
      })
    } catch (err: any) {
      setResult({
        status: err?.response?.status ?? 0,
        elapsedMs: Math.round(performance.now() - startedAt),
        data: err?.response?.data ?? null,
        error: err?.response?.data?.error || err?.message || '请求失败',
      })
    } finally {
      setRunning(false)
    }
  }

  const copyCurl = async () => {
    if (!curl) return
    try {
      await navigator.clipboard.writeText(curl)
      notify.success('cURL 已复制到剪贴板')
    } catch {
      notify.warning('当前环境不支持剪贴板写入')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">RPC 调用器</h1>
          <p className="text-sm text-gray-500 mt-1">
            PostgREST 风格的图形化测试面板，调用路径
            <code className="px-1.5 py-0.5 bg-gray-100 rounded text-xs ml-1">
              /api/v1/{databaseSlug ?? '{databaseSlug}'}/rpc/&lt;fn&gt;
            </code>
            ，与表 CRUD 同款 URL 形态。
          </p>
        </div>
        <button onClick={loadFunctions} className="btn-secondary" disabled={loadingList}>
          <i className={`fas fa-sync mr-2 ${loadingList ? 'fa-spin' : ''}`}></i>
          刷新函数列表
        </button>
      </div>

      <div className="grid grid-cols-12 gap-6">
        {/* 左列：函数列表 */}
        <div className="col-span-4">
          <div className="card">
            <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 space-y-2">
              <div className="relative">
                <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"></i>
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder={`搜索 ${currentSchema || 'public'} schema 内的函数...`}
                  className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              {hiddenExtensionCount > 0 && (
                <label className="flex items-center justify-between text-xs text-gray-600 cursor-pointer">
                  <span className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={showExtensionFunctions}
                      onChange={(e) => setShowExtensionFunctions(e.target.checked)}
                      className="rounded border-gray-300 text-blue-600"
                    />
                    <span>显示扩展函数</span>
                  </span>
                  <span className="text-gray-400">
                    {showExtensionFunctions
                      ? `共 ${hiddenExtensionCount} 个`
                      : `已隐藏 ${hiddenExtensionCount} 个`}
                  </span>
                </label>
              )}
            </div>
            <div className="max-h-[600px] overflow-y-auto">
              {loadingList && functions.length === 0 ? (
                <div className="p-6 text-center text-gray-500 text-sm">
                  <i className="fas fa-spinner fa-spin mr-2"></i> 加载中…
                </div>
              ) : filtered.length === 0 ? (
                <div className="p-6 text-center text-gray-500 text-sm">
                  当前 schema 下没有可调用的函数
                </div>
              ) : (
                filtered.map((fn) => {
                  const id = pgFunctionIdentity(fn)
                  // 重载场景下"function_name 相同"不够：必须比对完整身份（含 argument_types），
                  // 否则点其中一个，所有同名重载会一起高亮，跟点击体验对不上。
                  const active = selected ? pgFunctionIdentity(selected) === id : false
                  return (
                    <button
                      key={id}
                      onClick={() => pickFunction(fn)}
                      className={`w-full text-left px-4 py-3 border-b border-gray-100 transition-colors ${
                        active ? 'bg-blue-50' : 'hover:bg-gray-50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="font-mono text-sm text-gray-900 truncate">
                            {fn.function_name}
                          </span>
                          {fn.extension_name && (
                            <span
                              className="text-[10px] px-1.5 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 rounded font-mono shrink-0"
                              title={`来自 PostgreSQL 扩展 ${fn.extension_name}`}
                            >
                              ext: {fn.extension_name}
                            </span>
                          )}
                        </div>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
                            fn.volatility === 'IMMUTABLE'
                              ? 'bg-green-100 text-green-700'
                              : fn.volatility === 'STABLE'
                              ? 'bg-blue-100 text-blue-700'
                              : 'bg-orange-100 text-orange-700'
                          }`}
                        >
                          {fn.volatility}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-gray-500 truncate">
                        ({fn.argument_types || '无参'}) → {fn.return_type}
                      </div>
                    </button>
                  )
                })
              )}
            </div>
          </div>
        </div>

        {/* 右列：调用面板 */}
        <div className="col-span-8 space-y-4">
          {/* 表单 */}
          <div className="card p-4 space-y-3">
            <div className="grid grid-cols-12 gap-3 items-end">
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-700 mb-1">方法</label>
                <div className="flex border border-gray-300 rounded-lg overflow-hidden text-sm">
                  {(['POST', 'GET'] as RpcMethod[]).map((m) => (
                    <button
                      key={m}
                      onClick={() => setMethod(m)}
                      className={`flex-1 py-1.5 ${
                        method === m
                          ? 'bg-blue-600 text-white font-semibold'
                          : 'bg-white text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
              <div className="col-span-3">
                <label className="block text-xs font-medium text-gray-700 mb-1">Schema</label>
                <input
                  type="text"
                  value={schema}
                  onChange={(e) => setSchema(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="public"
                />
              </div>
              <div className="col-span-7">
                <label className="block text-xs font-medium text-gray-700 mb-1">函数名</label>
                <input
                  type="text"
                  value={fnName}
                  onChange={(e) => setFnName(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm font-mono border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="console_get_user_projects"
                />
              </div>
            </div>

            {method === 'POST' && (
              <label className="flex items-center space-x-2 text-xs text-gray-700">
                <input
                  type="checkbox"
                  checked={singleObject}
                  onChange={(e) => setSingleObject(e.target.checked)}
                />
                <span>
                  <span className="font-mono">Prefer: params=single-object</span>
                  <span className="text-gray-500 ml-1">
                    （函数签名是 <span className="font-mono">fn(payload jsonb)</span> 时勾选）
                  </span>
                </span>
              </label>
            )}

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-medium text-gray-700">参数（JSON 对象）</label>
                {!parsedArgs.ok && (
                  <span className="text-xs text-red-600">{parsedArgs.error}</span>
                )}
              </div>
              <textarea
                value={argsJson}
                onChange={(e) => setArgsJson(e.target.value)}
                rows={10}
                className={`w-full px-3 py-2 text-sm font-mono border rounded-lg focus:outline-none focus:ring-1 ${
                  parsedArgs.ok
                    ? 'border-gray-300 focus:ring-blue-500'
                    : 'border-red-400 focus:ring-red-500'
                }`}
                placeholder='{ "user_id": 1 }'
                spellCheck={false}
              />
            </div>

            <div className="flex items-center justify-end space-x-2">
              <button
                onClick={runRpc}
                disabled={running || !parsedArgs.ok || !fnName.trim()}
                className="btn-primary"
              >
                {running ? (
                  <>
                    <i className="fas fa-spinner fa-spin mr-2"></i>调用中…
                  </>
                ) : (
                  <>
                    <i className="fas fa-play mr-2"></i>调用
                  </>
                )}
              </button>
            </div>
          </div>

          {/* cURL 预览 */}
          {curl && (
            <div className="card">
              <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 bg-gray-50">
                <span className="text-xs font-semibold text-gray-700">cURL 预览</span>
                <button
                  onClick={copyCurl}
                  className="text-xs text-blue-600 hover:text-blue-700 transition-colors"
                >
                  <i className="fas fa-copy mr-1"></i>复制
                </button>
              </div>
              <pre className="px-4 py-3 text-xs bg-gray-900 text-gray-100 overflow-x-auto whitespace-pre">
{curl}
              </pre>
            </div>
          )}

          {/* 响应 */}
          {result && (
            <div className="card">
              <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 bg-gray-50">
                <div className="flex items-center space-x-3 text-xs">
                  <span
                    className={`px-2 py-0.5 rounded font-mono font-semibold ${
                      result.status >= 200 && result.status < 300
                        ? 'bg-green-100 text-green-700'
                        : 'bg-red-100 text-red-700'
                    }`}
                  >
                    {result.status || 'ERR'}
                  </span>
                  <span className="text-gray-500">{result.elapsedMs} ms</span>
                  {result.error && <span className="text-red-600">{result.error}</span>}
                </div>
              </div>
              <pre className="px-4 py-3 text-xs bg-gray-900 text-gray-100 overflow-x-auto max-h-[400px]">
{JSON.stringify(result.data, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
