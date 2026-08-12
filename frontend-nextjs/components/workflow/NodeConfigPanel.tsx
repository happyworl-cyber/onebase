'use client'

import { useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import { NODE_TYPE_META } from './NodeTypes'
import { wfDatasourceAPI, type WfDatasource } from '@/lib/api'
import { redisAPI, REDIS_OPS, type RedisConnection, type RedisOp } from '@/lib/api'
import { kafkaAPI, type KafkaConnection } from '@/lib/api'
import {
  objectStorageAPI,
  OBJECT_STORAGE_OPS,
  type ObjectStorageConnection,
  type ObjectStorageOp,
} from '@/lib/api'

interface WorkflowNodeData {
  id: string
  type: string
  label?: string
  config: any
}

interface Props {
  node: WorkflowNodeData | null
  workflowSlug?: string
  onChange: (node: WorkflowNodeData) => void
  onClose: () => void
  onDelete: () => void
  /** 条件节点分支改名时通知画布同步旧连线的 branch，避免失配 */
  onBranchRename?: (nodeId: string, oldBranch: string, newBranch: string) => void
}

const STORAGE_WIDTH_KEY = 'workflow-node-panel-width'
const MIN_WIDTH = 280
const MAX_WIDTH = 900
const DEFAULT_WIDTH = 280

interface JsonFieldRule {
  label: string
  requireObject?: boolean
}

const JSON_FIELD_RULES: Record<string, Record<string, JsonFieldRule>> = {
  call_workflow: {
    input: { label: '入参 input', requireObject: true },
  },
  transform: {
    // output 可为对象/数组/标量的 JSON 模板，不强制对象；仅校验合法 JSON（整段 {{模板}} 放行）。
    output: { label: '转换映射' },
  },
  http_call: {
    headers: { label: 'Headers', requireObject: true },
    body: { label: 'Body' },
  },
  response: {
    headers: { label: '响应 Headers', requireObject: true },
    body: { label: '响应 Body' },
  },
  sse_publish: {
    data: { label: '推送数据' },
  },
}

// 整段模板表达式（`{{...}}`，且只出现一次）运行时才由后端解析成实际类型，保存前不能
// 按字面 JSON 校验，否则 body: "{{clean_body}}" 之类的节点引用会被误报为非法 JSON。
function isWholeTemplateExpr(text: string): boolean {
  return text.startsWith('{{') && text.endsWith('}}') && text.slice(2).indexOf('{{') === -1
}

const CODE_LUA_TEMPLATE = 'function execute(ctx)\n  ctx.body = { ok = true }\nend'
const CODE_JS_TEMPLATE = 'async function execute(ctx) {\n  ctx.body = { ok: true };\n}'
const CODE_PY_TEMPLATE = 'def execute(ctx):\n    return { "ok": True }'

type CodeLanguage = 'lua' | 'javascript' | 'python'

const CODE_TEMPLATES: Record<CodeLanguage, string> = {
  lua: CODE_LUA_TEMPLATE,
  javascript: CODE_JS_TEMPLATE,
  python: CODE_PY_TEMPLATE,
}

function codeLanguage(config: any): CodeLanguage {
  if (config?.language === 'javascript') return 'javascript'
  if (config?.language === 'python') return 'python'
  return 'lua'
}

function validateJsonFieldValue(value: string, rule: JsonFieldRule): string | null {
  const text = value.trim()
  if (!text) return null
  if (isWholeTemplateExpr(text)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return `${rule.label} 不是合法 JSON`
  }
  if (rule.requireObject && (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object')) {
    return `${rule.label} 必须是 JSON 对象`
  }
  return null
}

export default function NodeConfigPanel({ node, workflowSlug, onChange, onClose, onDelete, onBranchRename }: Props) {
  // 面板宽度（受控 + localStorage 持久化），用户可拖拽左边缘调整。
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [isResizing, setIsResizing] = useState(false)
  const [jsonFieldErrors, setJsonFieldErrors] = useState<Record<string, string>>({})
  // 分支名输入聚焦时的旧值，失焦时用「旧值→新值」原子提交改名，避免逐字编辑过程中的中间态错配。
  const branchEditStart = useRef<string>('')
  const widthRef = useRef(width)
  widthRef.current = width
  // 拖拽起点：记录按下时的指针 X 与当时宽度，move 时按位移反推新宽度（向左拖变宽）。
  const resizeStart = useRef({ x: 0, w: DEFAULT_WIDTH })

  // 数据源列表：供 db_query / db_execute 节点选择「数据源」（覆盖工作流绑定的默认库）。
  // 按当前项目（URL projectId）懒加载一次。加载失败静默降级为空列表，节点仍可保存
  // （不选即默认库），不阻塞编辑。
  const params = useParams<{ projectId?: string }>()
  const [datasources, setDatasources] = useState<WfDatasource[]>([])
  const isDbNode =
    node?.type === 'db_query' ||
    node?.type === 'db_execute' ||
    node?.type === 'db_transaction' ||
    node?.type === 'foreach'
  useEffect(() => {
    const pid = Number(params?.projectId)
    if (!isDbNode || !Number.isFinite(pid)) return
    let cancelled = false
    wfDatasourceAPI
      .list(pid)
      .then((res) => {
        if (!cancelled) setDatasources(res.data)
      })
      .catch(() => {
        /* 无权限 / 未配置：留空，节点走默认库 */
      })
    return () => {
      cancelled = true
    }
  }, [params?.projectId, isDbNode])

  // 当前节点选中的数据源（用于信息条展示）。config.datasource_id 兼容数字/字符串。
  const selectedDatasource = (() => {
    const raw = node?.config?.datasource_id
    if (raw === undefined || raw === null || raw === '') return null
    const id = typeof raw === 'number' ? raw : parseInt(String(raw), 10)
    return datasources.find((d) => d.id === id) ?? null
  })()

  // 初始化：读取持久化宽度
  useEffect(() => {
    const saved = Number(localStorage.getItem(STORAGE_WIDTH_KEY))
    if (saved >= MIN_WIDTH && saved <= MAX_WIDTH) setWidth(saved)
  }, [])

  // 拖拽期间：监听全局指针事件计算宽度，结束时持久化。
  useEffect(() => {
    if (!isResizing) return
    const onMove = (e: PointerEvent) => {
      const maxAllowed = Math.min(MAX_WIDTH, window.innerWidth - 120)
      const dx = e.clientX - resizeStart.current.x
      const next = Math.min(maxAllowed, Math.max(MIN_WIDTH, resizeStart.current.w - dx))
      setWidth(next)
    }
    const onUp = () => {
      setIsResizing(false)
      localStorage.setItem(STORAGE_WIDTH_KEY, String(widthRef.current))
    }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [isResizing])

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    resizeStart.current = { x: e.clientX, w: widthRef.current }
    setIsResizing(true)
  }

  const subscriptionSlug = node?.config?.subscription_slug || node?.config?.public_endpoint_slug
  const publicEndpointSlug = subscriptionSlug?.trim() || workflowSlug?.trim() || 'growth-animation'
  const sampleIdentity = node?.config?.sample_identity || 'adosp9duiiysjbwzetodwomnie'
  const sampleProjectId = node?.config?.sample_project_id || '1'
  const configText = JSON.stringify(node?.config || {})
  const includeProjectId = configText.includes('projectId')
  const ssePath = `/events/${publicEndpointSlug}?wayUid=${encodeURIComponent(sampleIdentity)}${includeProjectId ? `&projectId=${encodeURIComponent(sampleProjectId)}` : ''}`
  const sseUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}${ssePath}`
      : ssePath

  if (!node) return null

  const meta = NODE_TYPE_META[node.type] || NODE_TYPE_META.code

  const updateConfig = (key: string, value: any) => {
    onChange({ ...node, config: { ...node.config, [key]: value } })
    setJsonFieldErrors((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const switchLoopMode = (mode: string) => {
    const canvasMeta = Object.fromEntries(
      Object.entries(node.config).filter(([key]) => key.startsWith('_')),
    )
    const common = {
      ...canvasMeta,
      loop_mode: mode,
      delay_ms: node.config.delay_ms ?? 0,
      allow_failure: !!node.config.allow_failure,
    }
    const modeConfig =
      mode === 'while' || mode === 'until'
        ? {
            expression: node.config.expression || '',
            max_iterations: node.config.max_iterations || 100,
          }
        : mode === 'count'
          ? { count: node.config.count || 1 }
          : { items: node.config.items || '', concurrency: 1 }
    onChange({ ...node, config: { ...common, ...modeConfig } })
  }

  const updateCondition = (idx: number, key: 'branch' | 'expression', value: string) => {
    const conds = Array.isArray(node.config.conditions) ? [...node.config.conditions] : []
    conds[idx] = { ...conds[idx], [key]: value }
    updateConfig('conditions', conds)
  }

  const addCondition = () => {
    const conds = Array.isArray(node.config.conditions) ? [...node.config.conditions] : []
    conds.push({ branch: '', expression: '' })
    updateConfig('conditions', conds)
  }

  const removeCondition = (idx: number) => {
    const conds = Array.isArray(node.config.conditions) ? [...node.config.conditions] : []
    updateConfig('conditions', conds.filter((_: unknown, i: number) => i !== idx))
  }

  const beginBranchEdit = (value: string) => {
    branchEditStart.current = value || ''
  }

  const commitBranchRename = (newValue: string) => {
    const oldValue = branchEditStart.current
    const next = newValue || ''
    if (onBranchRename && oldValue && oldValue !== next) {
      onBranchRename(node.id, oldValue, next)
    }
    branchEditStart.current = ''
  }

  // 单表达式(form B) → 多分支(form A)：把当前表达式转为命中走 true、否则走 false 的显式结构，
  // 分支名沿用 true/false，保证已有 true/false 连线不失配。
  const switchToMultiBranch = () => {
    const expr = typeof node.config.expression === 'string' ? node.config.expression : ''
    const { expression: _drop, ...rest } = node.config
    void _drop
    onChange({
      ...node,
      config: {
        ...rest,
        conditions: [{ branch: 'true', expression: expr }],
        default_branch: 'false',
      },
    })
  }

  // 多分支(form A) → 单表达式(form B)：取第一条分支的表达式回填，去掉 conditions/default_branch。
  const switchToSingleExpression = () => {
    const first = Array.isArray(node.config.conditions) ? node.config.conditions[0] : null
    const expr = first && typeof first.expression === 'string' ? first.expression : ''
    const { conditions: _c, default_branch: _d, ...rest } = node.config
    void _c
    void _d
    onChange({ ...node, config: { ...rest, expression: expr } })
  }

  const validateJsonField = (key: string, raw: string) => {
    const rule = JSON_FIELD_RULES[node.type]?.[key]
    if (!rule) return
    const err = validateJsonFieldValue(raw, rule)
    setJsonFieldErrors((prev) => {
      if (!err && !prev[key]) return prev
      const next = { ...prev }
      if (err) next[key] = err
      else delete next[key]
      return next
    })
  }

  useEffect(() => {
    setJsonFieldErrors({})
  }, [node.id, node.type])

  return (
    <div
      className="relative shrink-0 border-l border-slate-200 bg-white flex flex-col h-full overflow-hidden"
      style={{ width: `${width}px` }}
    >
      {/* 左边缘拖拽手柄：拖动调整面板宽度，双击复位默认宽度 */}
      <div
        onPointerDown={startResize}
        onDoubleClick={() => {
          setWidth(DEFAULT_WIDTH)
          localStorage.setItem(STORAGE_WIDTH_KEY, String(DEFAULT_WIDTH))
        }}
        title="拖拽调整宽度（双击复位）"
        className={`absolute left-0 top-0 z-20 h-full w-1.5 cursor-col-resize transition-colors hover:bg-indigo-400/40 ${
          isResizing ? 'bg-indigo-400/60' : 'bg-transparent'
        }`}
      />
      {/* 拖拽期间的全屏遮罩：接住指针事件，避免移到画布上时被 ReactFlow 吞掉导致拖拽中断 */}
      {isResizing && <div className="fixed inset-0 z-[9999] cursor-col-resize" />}
      <div className="p-3.5 border-b border-slate-100 flex items-start justify-between">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-0.5">{meta.label}</div>
          <div className="text-sm font-semibold text-slate-800">{node.label || node.id}</div>
        </div>
        <button onClick={onClose} className="w-6 h-6 rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-600 text-lg leading-none flex items-center justify-center">&times;</button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">节点 ID</label>
          <input
            value={node.id}
            disabled
            className="w-full px-3 py-2 border rounded-lg bg-gray-50 text-sm font-mono text-gray-500"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">标签名称</label>
          <input
            value={node.label || ''}
            onChange={e => onChange({ ...node, label: e.target.value })}
            className="w-full px-3 py-2 border rounded-lg text-sm"
            placeholder="给节点起个名字"
          />
        </div>

        <hr className="border-gray-100" />

        {node.type === 'code' && (() => {
          const lang = codeLanguage(node.config)
          const switchCodeLanguage = (nextLang: CodeLanguage) => {
            if (nextLang === lang) return
            const currentCode = node.config.code || ''
            const oldTemplate = CODE_TEMPLATES[lang]
            const newTemplate = CODE_TEMPLATES[nextLang]
            const nextCode = !currentCode.trim() || currentCode === oldTemplate ? newTemplate : currentCode
            onChange({
              ...node,
              config: { ...node.config, language: nextLang, code: nextCode },
            })
          }
          return (
            <>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">语言</label>
                <select
                  value={lang}
                  onChange={(e) => switchCodeLanguage(e.target.value as CodeLanguage)}
                  className="w-full px-3 py-2 border rounded-lg text-sm bg-white"
                >
                  <option value="lua">Lua</option>
                  <option value="javascript">JavaScript</option>
                  <option value="python">Python</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">代码</label>
                <textarea
                  value={node.config.code || ''}
                  onChange={e => updateConfig('code', e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg font-mono text-sm bg-gray-900 text-green-400 leading-relaxed"
                  rows={12}
                  spellCheck={false}
                  placeholder={
                    lang === 'javascript'
                      ? 'async function execute(ctx) {\n  // ctx.body: trigger payload\n  // ctx.nodes.nodeId: upstream output\n  ctx.body = { ok: true };\n}'
                      : lang === 'python'
                      ? 'def execute(ctx):\n    # ctx.body: 触发 payload\n    # ctx.nodes["nodeId"]: 上游输出\n    return { "ok": True }'
                      : 'function execute(ctx)\n  -- ctx.body: 触发 payload\n  -- ctx.nodes.xxx: 上游输出\n  ctx.body = { ok = true }\nend'
                  }
                />
                <p className="text-xs text-gray-400 mt-1">
                  可用变量: ctx.body（触发 payload）、ctx.nodes.nodeId（上游输出）
                </p>
              </div>
            </>
          )
        })()}

        {(node.type === 'db_query' ||
          node.type === 'db_execute' ||
          node.type === 'db_transaction' ||
          node.type === 'foreach') && (
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">
              数据源
              <span className="ml-1 text-[10px] text-gray-400">（不选则用工作流绑定的默认库）</span>
            </label>
            <select
              value={node.config.datasource_id != null && node.config.datasource_id !== '' ? String(node.config.datasource_id) : ''}
              onChange={(e) => {
                // 同时存 id（本项目精确引用）与 ref（数据源名称，供跨项目/跨环境导入按名重映射）。
                const v = e.target.value
                if (v === '') {
                  onChange({ ...node, config: { ...node.config, datasource_id: null, datasource_ref: null } })
                } else {
                  const id = parseInt(v, 10)
                  const ds = datasources.find((d) => d.id === id)
                  onChange({ ...node, config: { ...node.config, datasource_id: id, datasource_ref: ds?.name ?? null } })
                }
              }}
              className="w-full px-3 py-2 border rounded-lg text-sm bg-white focus:border-blue-400 focus:ring-1 focus:ring-blue-100 outline-none"
            >
              <option value="">默认（工作流绑定库）</option>
              {datasources.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.description ? ` — ${d.description}` : ''}
                </option>
              ))}
            </select>
            {/* 选中的数据源不在已加载列表里（无权限/被删）：提示 ID，避免静默丢失 */}
            {node.config.datasource_id != null &&
              node.config.datasource_id !== '' &&
              !selectedDatasource && (
                <p className="mt-1 text-[11px] text-amber-600">
                  已选数据源 #{String(node.config.datasource_id)} 当前不可见（可能已删除或无权限），执行时若解析失败会报错。
                </p>
              )}
            {selectedDatasource && (
              <div className="mt-2 rounded-lg border border-emerald-100 bg-emerald-50/60 p-2.5">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-md bg-emerald-100 flex items-center justify-center">
                    <i className="fas fa-database text-emerald-600 text-[10px]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-emerald-800">{selectedDatasource.name}</div>
                    <div className="text-[10px] text-emerald-600 truncate">
                      {`${selectedDatasource.host}${selectedDatasource.port ? ':' + selectedDatasource.port : ''}${
                        selectedDatasource.database ? '/' + selectedDatasource.database : ''
                      }`}
                      {selectedDatasource.credential_name ? ` · 凭证: ${selectedDatasource.credential_name}` : ''}
                    </div>
                  </div>
                </div>
              </div>
            )}
            {params?.projectId && (
              <div className="mt-1.5 text-[11px]">
                <a
                  href={`/workspace/${params.projectId}/events/datasources`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 hover:text-blue-700 hover:underline inline-flex items-center gap-1"
                >
                  <i className="fas fa-cog text-[9px]" />管理数据源
                </a>
              </div>
            )}
          </div>
        )}

        {(node.type === 'db_query' || node.type === 'db_execute') && (
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={node.config.dynamic_sql === true}
              onChange={(e) => updateConfig('dynamic_sql', e.target.checked)}
            />
            <span>
              <span className="block text-sm font-medium text-gray-700">动态 SQL（整条来自上游/模板）</span>
              <span className="block text-xs text-gray-400 mt-0.5">
                开启后 SQL 会被整条解析成文本后原样执行（跳过参数化），用于表名/字段随上游变化的场景。
                <span className="text-amber-600">此模式下参数不再自动绑定，请在上游自行转义用户输入以防注入。</span>
              </span>
            </span>
          </label>
        )}

        {node.type === 'db_query' && (
          <>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">SQL 查询</label>
              <textarea
                value={node.config.sql || ''}
                onChange={e => updateConfig('sql', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
                rows={5}
                placeholder="SELECT * FROM users WHERE id = $1"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">参数 (JSON 数组)</label>
              <input
                value={node.config.params || ''}
                onChange={e => updateConfig('params', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
                placeholder='["{{trigger.id}}"]'
              />
              <p className="text-xs text-gray-400 mt-1">支持模板: {'{{trigger.x}}'}, {'{{nodeId.field}}'}</p>
            </div>
          </>
        )}

        {node.type === 'db_execute' && (
          <>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">SQL 语句</label>
              <textarea
                value={node.config.sql || ''}
                onChange={e => updateConfig('sql', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
                rows={5}
                placeholder="INSERT INTO logs(msg) VALUES($1)"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">参数 (JSON 数组)</label>
              <input
                value={node.config.params || ''}
                onChange={e => updateConfig('params', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
                placeholder='["{{trigger.message}}"]'
              />
            </div>
          </>
        )}

        {node.type === 'db_transaction' && (
          <>
            <div className="rounded-lg bg-emerald-50 border border-emerald-100 p-2.5 text-xs text-emerald-700 leading-5">
              <strong>数据库事务</strong>：下列语句在<strong>同一个事务</strong>内按顺序执行，全部成功才提交，任一失败整体回滚。仅支持 PostgreSQL。
            </div>
            <StatementsEditor node={node} updateConfig={updateConfig} />
          </>
        )}

        {node.type === 'foreach' && (
          <>
            <div className="rounded-lg bg-green-50 border border-green-100 p-2.5 text-xs text-green-700 leading-5">
              <strong>批量遍历</strong>：遍历数组每个元素，<strong>每个元素在独立事务</strong>内执行下列语句；语句中用 <code className="font-mono">{'{{'}{node.config.item_var || 'item'}.字段{'}}'}</code> 引用当前元素。仅支持 PostgreSQL。
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">遍历数组来源 *</label>
              <input
                value={node.config.items || ''}
                onChange={e => updateConfig('items', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
                placeholder="q.rows"
              />
              <p className="text-xs text-gray-400 mt-1">
                上游数据路径，<strong>不含花括号</strong>（如 <code className="font-mono">q.rows</code>）；必须解析为数组。
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">元素变量名 item_var</label>
              <input
                value={node.config.item_var ?? ''}
                onChange={e => updateConfig('item_var', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
                placeholder="item"
              />
              <p className="text-xs text-gray-400 mt-1">留空默认 <code className="font-mono">item</code>，语句内以 <code className="font-mono">{'{{'}变量名.字段{'}}'}</code> 引用当前元素。</p>
            </div>
            <StatementsEditor node={node} updateConfig={updateConfig} />
          </>
        )}

        {node.type === 'http_call' && (
          <>
            <div className="grid grid-cols-4 gap-2">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">方法</label>
                <select
                  value={node.config.method || 'GET'}
                  onChange={e => updateConfig('method', e.target.value)}
                  className="w-full px-2 py-2 border rounded-lg text-sm"
                >
                  {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div className="col-span-3">
                <label className="block text-xs font-medium text-gray-500 mb-1">URL</label>
                <input
                  value={node.config.url || ''}
                  onChange={e => updateConfig('url', e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
                  placeholder="https://api.example.com/data"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Headers (JSON)</label>
              <textarea
                value={node.config.headers ? (typeof node.config.headers === 'string' ? node.config.headers : JSON.stringify(node.config.headers, null, 2)) : ''}
                onChange={e => updateConfig('headers', e.target.value)}
                onBlur={e => validateJsonField('headers', e.target.value)}
                className={`w-full px-3 py-2 border rounded-lg font-mono text-sm ${jsonFieldErrors.headers ? 'border-red-300 bg-red-50/30' : ''}`}
                rows={3}
                placeholder='{"Authorization": "Bearer xxx"}'
              />
              {jsonFieldErrors.headers && (
                <p className="text-xs text-red-600 mt-1">{jsonFieldErrors.headers}</p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Body (JSON)</label>
              <textarea
                value={node.config.body ? (typeof node.config.body === 'string' ? node.config.body : JSON.stringify(node.config.body, null, 2)) : ''}
                onChange={e => updateConfig('body', e.target.value)}
                onBlur={e => validateJsonField('body', e.target.value)}
                className={`w-full px-3 py-2 border rounded-lg font-mono text-sm ${jsonFieldErrors.body ? 'border-red-300 bg-red-50/30' : ''}`}
                rows={3}
                placeholder='{"key": "{{trigger.value}}"}'
              />
              {jsonFieldErrors.body && (
                <p className="text-xs text-red-600 mt-1">{jsonFieldErrors.body}</p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">超时时间（秒）</label>
              <input
                type="number"
                min={0}
                value={node.config.timeout_secs ?? ''}
                onChange={e => updateConfig('timeout_secs', e.target.value === '' ? undefined : Number(e.target.value))}
                className="w-full px-3 py-2 border rounded-lg text-sm"
                placeholder="默认 120，填 0 表示不限制（适合 AI 等长耗时接口）"
              />
              <p className="text-xs text-gray-400 mt-1">单次 HTTP 请求超时；异步轮询时每次请求都受此限制。</p>
            </div>

            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={!!node.config.async_poll}
                onChange={e => updateConfig('async_poll', e.target.checked)}
              />
              <span>
                <span className="block text-sm font-medium text-gray-700">启用异步轮询</span>
                <span className="block text-xs text-gray-400 mt-0.5">
                  开启后，收到 HTTP 202 或 body.status=pending 时自动轮询直至完成（协议对齐 Provisioner）。
                  总等待仍受工作流超时（timeout_ms）限制，长任务请一并调大。
                </span>
              </span>
            </label>

            {!!node.config.async_poll && (
              <div className="grid grid-cols-2 gap-2 p-3 bg-gray-50 border rounded-lg">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">轮询间隔（秒）</label>
                  <input
                    type="number"
                    min={1}
                    value={node.config.poll_interval_secs ?? 5}
                    onChange={e => updateConfig('poll_interval_secs', Number(e.target.value) || 5)}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">最长等待（秒）</label>
                  <input
                    type="number"
                    min={1}
                    value={node.config.poll_max_secs ?? 600}
                    onChange={e => updateConfig('poll_max_secs', Number(e.target.value) || 600)}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                  />
                </div>
              </div>
            )}
          </>
        )}

        {node.type === 'email_send' && (
          <>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">发件人 From *</label>
              <input
                value={node.config.from || ''}
                onChange={e => updateConfig('from', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
                placeholder="HR <hr@example.com>"
              />
              <p className="text-xs text-gray-400 mt-1">也可通过 ONEBASE_SMTP_FROM / SMTP_FROM 环境变量提供。</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">收件人 To *</label>
              <textarea
                value={node.config.to || ''}
                onChange={e => updateConfig('to', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
                rows={2}
                placeholder="{{trigger.candidate_email}}"
              />
              <p className="text-xs text-gray-400 mt-1">多个地址可用逗号、分号或换行分隔；支持模板变量。</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">抄送 Cc</label>
                <input
                  value={node.config.cc || ''}
                  onChange={e => updateConfig('cc', e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
                  placeholder="manager@example.com"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">密送 Bcc</label>
                <input
                  value={node.config.bcc || ''}
                  onChange={e => updateConfig('bcc', e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
                  placeholder="audit@example.com"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">主题 Subject *</label>
              <input
                value={node.config.subject || ''}
                onChange={e => updateConfig('subject', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm"
                placeholder="Offer {{trigger.candidate_name}}"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">纯文本正文</label>
              <textarea
                value={node.config.text_body || ''}
                onChange={e => updateConfig('text_body', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
                rows={4}
                placeholder={'Hello {{trigger.candidate_name}},\nYour offer is ready.'}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">HTML 正文</label>
              <textarea
                value={node.config.html_body || ''}
                onChange={e => updateConfig('html_body', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
                rows={4}
                placeholder={'<p>Hello {{trigger.candidate_name}}</p>'}
              />
              <p className="text-xs text-gray-400 mt-1">纯文本和 HTML 至少填写一个；两者都填时发送 multipart/alternative。</p>
            </div>
            <div className="rounded-lg border border-sky-100 bg-sky-50 p-3 space-y-3">
              <div className="text-xs font-medium text-sky-700">SMTP 设置</div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">SMTP Host *</label>
                <input
                  value={node.config.smtp_host || ''}
                  onChange={e => updateConfig('smtp_host', e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
                  placeholder="smtp.example.com"
                />
                <p className="text-xs text-sky-600 mt-1">留空时读取 ONEBASE_SMTP_HOST / SMTP_HOST。</p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">端口</label>
                  <input
                    type="number"
                    value={node.config.smtp_port || 587}
                    onChange={e => updateConfig('smtp_port', parseInt(e.target.value) || 587)}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                  />
                </div>
                <label className="flex items-end gap-2 text-xs text-gray-600 pb-2">
                  <input
                    type="checkbox"
                    checked={node.config.smtp_starttls !== false}
                    onChange={e => updateConfig('smtp_starttls', e.target.checked)}
                  />
                  使用 STARTTLS
                </label>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">SMTP 用户名</label>
                <input
                  value={node.config.smtp_username || ''}
                  onChange={e => updateConfig('smtp_username', e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
                  placeholder="smtp-user"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">SMTP 密码</label>
                <input
                  type="password"
                  value={node.config.smtp_password || ''}
                  onChange={e => updateConfig('smtp_password', e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
                  placeholder="留空时读取环境变量"
                />
                <p className="text-xs text-sky-600 mt-1">
                  生产环境建议留空，改用 ONEBASE_SMTP_USERNAME / ONEBASE_SMTP_PASSWORD。
                </p>
              </div>
            </div>
          </>
        )}

        {node.type === 'condition' && (
          Array.isArray(node.config.conditions) ? (
            <div className="space-y-3">
              <label className="block text-xs font-medium text-gray-500">
                条件分支（按顺序匹配，命中即走对应分支）
              </label>
              {node.config.conditions.map((cond: any, idx: number) => (
                <div key={idx} className="rounded-lg border border-gray-200 p-2.5 space-y-2 bg-gray-50/40">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400 shrink-0">分支</span>
                    <input
                      value={cond?.branch || ''}
                      onFocus={() => beginBranchEdit(cond?.branch || '')}
                      onChange={e => updateCondition(idx, 'branch', e.target.value)}
                      onBlur={() => commitBranchRename(cond?.branch || '')}
                      className="flex-1 px-2 py-1.5 border rounded-md text-sm font-mono"
                      placeholder="valid"
                    />
                    <button
                      onClick={() => removeCondition(idx)}
                      className="w-6 h-6 rounded-md text-gray-400 hover:bg-red-50 hover:text-red-500 text-base leading-none flex items-center justify-center shrink-0"
                      title="删除该分支"
                    >
                      &times;
                    </button>
                  </div>
                  <input
                    value={cond?.expression || ''}
                    onChange={e => updateCondition(idx, 'expression', e.target.value)}
                    className="w-full px-2 py-1.5 border rounded-md font-mono text-sm"
                    placeholder="{{trigger.age}} > 18"
                  />
                </div>
              ))}
              <button
                onClick={addCondition}
                className="w-full px-3 py-1.5 text-xs font-medium text-indigo-600 border border-dashed border-indigo-300 rounded-lg hover:bg-indigo-50"
              >
                + 添加条件分支
              </button>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">默认分支 default_branch（都不命中时）</label>
                <input
                  value={node.config.default_branch || ''}
                  onFocus={() => beginBranchEdit(node.config.default_branch || '')}
                  onChange={e => updateConfig('default_branch', e.target.value)}
                  onBlur={() => commitBranchRename(node.config.default_branch || '')}
                  className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
                  placeholder="invalid"
                />
              </div>
              <p className="text-xs text-gray-400">
                支持: ==, !=, &gt;, &lt;, &gt;=, &lt;=, contains, starts_with。每个分支对应节点底部一个出口，连线标签即分支名。
              </p>
              <button
                onClick={switchToSingleExpression}
                className="w-full px-3 py-1.5 text-xs font-medium text-gray-500 border border-dashed border-gray-300 rounded-lg hover:bg-gray-50"
              >
                切换回单表达式模式
              </button>
            </div>
          ) : (
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">条件表达式</label>
              <input
                value={node.config.expression || ''}
                onChange={e => updateConfig('expression', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
                placeholder="{{trigger.age}} > 18"
              />
              <p className="text-xs text-gray-400 mt-1">
                支持: ==, !=, &gt;, &lt;, &gt;=, &lt;=, contains, starts_with
              </p>
              <p className="text-xs text-gray-400">
                true 分支从右侧出口连接，false 分支从左侧出口连接
              </p>
              <button
                onClick={switchToMultiBranch}
                className="mt-3 w-full px-3 py-1.5 text-xs font-medium text-indigo-600 border border-dashed border-indigo-300 rounded-lg hover:bg-indigo-50"
              >
                切换为多分支模式
              </button>
              <p className="text-xs text-gray-400 mt-1">
                切换后当前表达式命中走 <code className="font-mono">true</code> 分支、否则走 <code className="font-mono">false</code> 分支，可继续增删自定义分支。
              </p>
            </div>
          )
        )}

        {node.type === 'loop' && (
          <div className="space-y-4">
            {/* 模式切换 */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">循环模式</label>
              <div className="grid grid-cols-4 gap-1 p-1 bg-gray-100 rounded-lg">
                {[
                  { v: 'while', label: 'While' },
                  { v: 'until', label: 'Until' },
                  { v: 'count', label: 'Count' },
                  { v: 'for_each', label: 'ForEach' },
                ].map((m) => (
                  <button
                    key={m.v}
                    type="button"
                    onClick={() => switchLoopMode(m.v)}
                    className={`py-1.5 text-xs font-medium rounded-md transition-colors ${
                      (node.config.loop_mode || 'while') === m.v
                        ? 'bg-white text-fuchsia-700 shadow-sm'
                        : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {/* while / until：条件表达式 + 最大迭代次数 */}
            {['while', 'until'].includes(node.config.loop_mode || 'while') && (
              <>
                <div className="rounded-lg bg-fuchsia-50 border border-fuchsia-100 p-2.5 text-xs text-fuchsia-700 leading-5">
                  {(node.config.loop_mode || 'while') === 'while' ? (
                    <><strong>While 模式</strong>：每次进入循环体 <strong>之前</strong> 评估条件，为真则循环、为假则退出。</>
                  ) : (
                    <><strong>Until 模式</strong>：每次循环体执行 <strong>之后</strong> 评估条件，为真则退出（至少执行一次）。</>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">
                    {(node.config.loop_mode || 'while') === 'while' ? '循环条件表达式 *' : '退出条件表达式 *'}
                  </label>
                  <input
                    value={node.config.expression || ''}
                    onChange={e => updateConfig('expression', e.target.value)}
                    className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
                    placeholder={'{{db_query.rows.0.status}} != "done"'}
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    支持 ==, !=, &gt;, &gt;=, &lt;, &lt;=；可引用上游 / 循环体节点输出与 <code className="font-mono">{'{{loop.*}}'}</code>。
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">最大迭代次数（安全上限）*</label>
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={node.config.max_iterations ?? 100}
                    onChange={e => updateConfig('max_iterations', e.target.value === '' ? '' : Number(e.target.value))}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    防死循环；达上限强制走完成出口，<code className="font-mono">{'{{loop.reached_max}}'}</code> 置为 true。
                  </p>
                </div>
              </>
            )}

            {/* count：执行次数 */}
            {node.config.loop_mode === 'count' && (
              <>
                <div className="rounded-lg bg-blue-50 border border-blue-100 p-2.5 text-xs text-blue-700 leading-5">
                  <strong>Count 模式</strong>：执行固定次数后自动退出，适合批处理 / 定次重试。
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">执行次数 *</label>
                  <input
                    value={node.config.count ?? ''}
                    onChange={e => updateConfig('count', e.target.value)}
                    className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
                    placeholder="3 或 {{trigger.retry_count}}"
                  />
                  <p className="text-xs text-gray-400 mt-1">支持数字或模板引用。</p>
                </div>
              </>
            )}

            {/* for_each：数组来源 + 并发 */}
            {node.config.loop_mode === 'for_each' && (
              <>
                <div className="rounded-lg bg-emerald-50 border border-emerald-100 p-2.5 text-xs text-emerald-700 leading-5">
                  <strong>ForEach 模式</strong>：遍历数组每个元素依次执行循环体；当前元素用 <code className="font-mono">{'{{loop.item}}'}</code> 引用。
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">遍历数组来源 *</label>
                  <input
                    value={node.config.items || ''}
                    onChange={e => updateConfig('items', e.target.value)}
                    className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
                    placeholder="{{trigger.items}}"
                  />
                  <p className="text-xs text-gray-400 mt-1">必须解析为数组类型。</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">并发数（可选，默认串行）</label>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={node.config.concurrency ?? 1}
                    onChange={e => {
                      const raw = e.target.value === '' ? 1 : Number(e.target.value)
                      const clamped = Math.min(8, Math.max(1, Math.floor(raw) || 1))
                      updateConfig('concurrency', clamped)
                    }}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                  />
                  <p className="text-xs text-gray-400 mt-1">1=串行；&gt;1 并发执行各元素（上限 8）。并发模式下循环体不可引用 <code className="font-mono">{'{{loop.results}}'}</code>，迭代间延迟被忽略。</p>
                </div>
              </>
            )}

            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">每次迭代间延迟（毫秒，可选）</label>
              <input
                type="number"
                min={0}
                value={node.config.delay_ms ?? 0}
                onChange={e => updateConfig('delay_ms', e.target.value === '' ? 0 : Number(e.target.value))}
                className="w-full px-3 py-2 border rounded-lg text-sm"
                placeholder="0（不延迟）"
              />
              <p className="text-xs text-gray-400 mt-1">仅在两轮之间等待；适合轮询或限速场景。</p>
            </div>

            {/* 内置变量说明 */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">循环内置变量（在循环体节点中引用）</label>
              <div className="rounded-lg border border-slate-200 overflow-hidden text-xs">
                {([
                  ['{{loop.index}}', '当前迭代索引（从 0 开始）'],
                  ['{{loop.count}}', '已执行次数（从 1 开始）'],
                  ['{{loop.item}}', '当前遍历元素（ForEach 专用）'],
                  ['{{loop.reached_max}}', '是否因超出最大次数而退出'],
                  ['{{loop.results}}', '每轮循环末节点的输出数组（串行模式；并发 for_each 不可用）'],
                ] as [string, string][]).map(([k, d]) => (
                  <div key={k} className="flex gap-2 px-2.5 py-1.5 border-b border-slate-100 last:border-0">
                    <code className="font-mono text-fuchsia-700 shrink-0">{k}</code>
                    <span className="text-slate-500">{d}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* allow_failure */}
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={!!node.config.allow_failure}
                onChange={e => updateConfig('allow_failure', e.target.checked)}
              />
              <span>
                <span className="block text-sm font-medium text-gray-700">失败时继续（allow_failure）</span>
                <span className="block text-xs text-gray-400 mt-0.5">
                  开启后循环体节点报错不中断工作流，循环继续执行下一轮。
                </span>
              </span>
            </label>

            <p className="text-xs text-gray-400 leading-5">
              连线：底部左出口 <span className="text-fuchsia-600 font-medium">循环体(body)</span> 进入循环，右出口 <span className="text-green-600 font-medium">完成(done)</span> 走后续节点；循环体末节点连回本节点左侧 <span className="text-fuchsia-600 font-medium">回边</span>。
            </p>
          </div>
        )}

        {node.type === 'transform' && (
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">转换映射 (JSON)</label>
            <textarea
              // 引擎读的是 config.output（见 workflow_engine.rs exec_transform_node / node_spec）。
              // 兼容读取历史误写的 mapping：仅当 output 缺失或为空白字符串时才回退到 mapping，
              // 杜绝「output:'' + mapping:有值」这类边界把已有 mapping 内容显示成空。
              value={(() => {
                const rawOut = node.config.output
                const outMeaningful =
                  rawOut != null && !(typeof rawOut === 'string' && rawOut.trim() === '')
                const out = outMeaningful ? rawOut : node.config.mapping
                if (out == null || out === '') return ''
                return typeof out === 'string' ? out : JSON.stringify(out, null, 2)
              })()}
              // 存成对象（而非原始字符串），让后端按字段逐个 resolve_template，避免译文含
              // 引号/换行时把整段 JSON 串替换破坏；无法解析（半成品/整段 {{模板}}）时暂存原文。
              onChange={e => {
                const raw = e.target.value
                let value: unknown = raw
                try { value = raw.trim() ? JSON.parse(raw) : '' } catch { value = raw }
                updateConfig('output', value)
              }}
              onBlur={e => validateJsonField('output', e.target.value)}
              className={`w-full px-3 py-2 border rounded-lg font-mono text-sm ${jsonFieldErrors.output ? 'border-red-300 bg-red-50/30' : ''}`}
              rows={6}
              placeholder={'{\n  "user_name": "{{query.rows.0.name}}",\n  "total": "{{query.rows.length}}"\n}'}
            />
            {jsonFieldErrors.output && (
              <p className="text-xs text-red-600 mt-1">{jsonFieldErrors.output}</p>
            )}
            <p className="text-xs text-gray-400 mt-1">键值对映射，值支持模板变量</p>
          </div>
        )}

        {node.type === 'response' && (
          <>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">HTTP 状态码</label>
              <input
                type="number"
                value={node.config.status_code || 200}
                onChange={e => updateConfig('status_code', parseInt(e.target.value) || 200)}
                className="w-full px-3 py-2 border rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">响应 Body (JSON 模板)</label>
              <textarea
                value={node.config.body ? (typeof node.config.body === 'string' ? node.config.body : JSON.stringify(node.config.body, null, 2)) : ''}
                onChange={e => updateConfig('body', e.target.value)}
                onBlur={e => validateJsonField('body', e.target.value)}
                className={`w-full px-3 py-2 border rounded-lg font-mono text-sm ${jsonFieldErrors.body ? 'border-red-300 bg-red-50/30' : ''}`}
                rows={5}
                placeholder={'{\n  "success": true,\n  "data": "{{transform.result}}"\n}'}
              />
              {jsonFieldErrors.body && (
                <p className="text-xs text-red-600 mt-1">{jsonFieldErrors.body}</p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">响应 Headers (JSON)</label>
              <textarea
                value={node.config.headers ? (typeof node.config.headers === 'string' ? node.config.headers : JSON.stringify(node.config.headers, null, 2)) : ''}
                onChange={e => updateConfig('headers', e.target.value)}
                onBlur={e => validateJsonField('headers', e.target.value)}
                className={`w-full px-3 py-2 border rounded-lg font-mono text-sm ${jsonFieldErrors.headers ? 'border-red-300 bg-red-50/30' : ''}`}
                rows={2}
                placeholder='{"X-Custom": "value"}'
              />
              {jsonFieldErrors.headers && (
                <p className="text-xs text-red-600 mt-1">{jsonFieldErrors.headers}</p>
              )}
            </div>
          </>
        )}
        {node.type === 'sse_publish' && (
          <>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">
                订阅 slug（工作流内设置，直接拼到 /events/:slug）*
              </label>
              <input
                value={node.config.subscription_slug || node.config.public_endpoint_slug || ''}
                onChange={e => updateConfig('subscription_slug', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
                placeholder="growth-animation"
              />
              <p className="text-xs text-gray-400 mt-1">
                这里填什么，客户端地址就是 /events/什么。例：填 growth-animation，地址就是 /events/growth-animation。
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">
                示例 wayUid（用于生成可复制访问链接）
              </label>
              <input
                value={node.config.sample_identity || 'adosp9duiiysjbwzetodwomnie'}
                onChange={e => updateConfig('sample_identity', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
                placeholder="adosp9duiiysjbwzetodwomnie"
              />
            </div>
            {includeProjectId && (
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  示例 projectId（用于生成可复制访问链接）
                </label>
                <input
                  value={node.config.sample_project_id || '1'}
                  onChange={e => updateConfig('sample_project_id', e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
                  placeholder="1"
                />
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">目标 topic *</label>
              <input
                value={node.config.topic || ''}
                onChange={e => updateConfig('topic', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
                placeholder="db:{database_id}:workflow:{workflow_id}"
              />
              <p className="text-xs text-gray-400 mt-1">
                占位符: {'{database_id}'} {'{tenant_id}'} {'{workflow_id}'} {'{run_id}'}
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">
                接收者 user_ids（可选，按用户批量推送）
              </label>
              <input
                value={node.config.user_ids ?? ''}
                onChange={e =>
                  updateConfig('user_ids', e.target.value.trim() === '' ? undefined : e.target.value)
                }
                className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
                placeholder="{{trigger.recipient_ids}} 或 5,6,7"
              />
              <p className="text-xs text-gray-400 mt-1">
                填模板或列表（如 <code className="font-mono">{'{{trigger.recipient_ids}}'}</code>、
                <code className="font-mono">5,6,7</code> 或 JSON 数组），会对每个 id 单独推送。
                此时上面的 topic 需含 <code className="font-mono">{'{uid}'}</code>（推荐 <code className="font-mono">user:{'{uid}'}:notify</code>）
                或为 <code className="font-mono">user:...:后缀</code> 格式。留空 = 只按 topic 单条广播。
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">SSE event 名</label>
              <input
                value={node.config.event || ''}
                onChange={e => updateConfig('event', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm"
                placeholder="message"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">推送数据 (JSON)</label>
              <textarea
                value={
                  typeof node.config.data === 'string'
                    ? node.config.data
                    : node.config.data != null
                      ? JSON.stringify(node.config.data, null, 2)
                      : ''
                }
                onChange={e => updateConfig('data', e.target.value)}
                onBlur={e => validateJsonField('data', e.target.value)}
                className={`w-full px-3 py-2 border rounded-lg font-mono text-sm ${jsonFieldErrors.data ? 'border-red-300 bg-red-50/30' : ''}`}
                rows={5}
                placeholder={'留空则推送本次触发数据，或填:\n{\n  "pct": 50,\n  "msg": "处理中"\n}'}
              />
              {jsonFieldErrors.data && (
                <p className="text-xs text-red-600 mt-1">{jsonFieldErrors.data}</p>
              )}
              <p className="text-xs text-gray-400 mt-1">留空 = 推送触发数据；填 JSON 则推送该内容</p>
            </div>
            <div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={node.config.graceful_close_enabled === true}
                  onChange={e => {
                    const on = e.target.checked
                    const cfg = { ...node.config, graceful_close_enabled: on }
                    // 勾选时把默认秒数真正写入 config（否则只显示不保存，后端拿不到时长）。
                    if (on && (cfg.graceful_close_seconds === undefined || cfg.graceful_close_seconds === null || cfg.graceful_close_seconds === '')) {
                      cfg.graceful_close_seconds = 1500
                    }
                    onChange({ ...node, config: cfg })
                  }}
                />
                <span className="text-xs font-medium text-gray-500">启用超时自动断开（不勾选 = 一直保持连接）</span>
              </label>
              {node.config.graceful_close_enabled === true && (
                <div className="mt-2">
                  <label className="block text-xs font-medium text-gray-500 mb-1">超时时长（秒）</label>
                  <input
                    type="number"
                    min={1}
                    value={node.config.graceful_close_seconds ?? 1500}
                    onChange={e => updateConfig('graceful_close_seconds', e.target.value === '' ? undefined : Number(e.target.value))}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                    placeholder="1500"
                  />
                  <p className="text-xs text-gray-400 mt-1">到时先发 <code className="font-mono">event: exit</code> 再断开。例：1500 = 25 分钟；600 = 10 分钟。</p>
                </div>
              )}
            </div>
            <p className="text-xs text-gray-400">
              客户端优先使用下方公开订阅地址；通用鉴权通道也可用 <code className="font-mono">/sse?topics=...</code>。
            </p>
            <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 space-y-2">
              <div className="text-xs font-medium text-blue-700">客户端订阅地址（复制即可使用）</div>
              <div className="text-xs text-blue-600">
                拼接规则：当前域名 + <span className="font-mono">/events/{publicEndpointSlug}</span> + 身份参数。
              </div>
              <div className="rounded bg-white border border-blue-100 px-2 py-1.5 text-xs font-mono text-blue-800 break-all">
                {sseUrl}
              </div>
              <div className="rounded bg-white border border-blue-100 px-2 py-1.5 text-xs font-mono text-gray-600 break-all">
                new EventSource(&apos;{ssePath}&apos;)
              </div>
              <p className="text-xs text-blue-600">
                这个地址由当前工作流的 SSE 推送节点承接；保存并启用工作流后即可订阅。客户端 EventSource 无法带 Header，所以固定用 URL 参数 wayUid 传身份。
              </p>
            </div>
          </>
        )}

        {node.type === 'call_workflow' && (
          <>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">子工作流 slug *</label>
              <input
                value={node.config.workflow || ''}
                onChange={e => updateConfig('workflow', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
                placeholder="get-official-detail"
              />
              <p className="text-xs text-gray-400 mt-1">
                只能调用<strong>同项目</strong>内已启用的工作流（按 slug 匹配，优先同库）。
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">入参 input (JSON)</label>
              <textarea
                value={node.config.input ? (typeof node.config.input === 'string' ? node.config.input : JSON.stringify(node.config.input, null, 2)) : ''}
                onChange={e => updateConfig('input', e.target.value)}
                onBlur={e => validateJsonField('input', e.target.value)}
                className={`w-full px-3 py-2 border rounded-lg font-mono text-sm ${jsonFieldErrors.input ? 'border-red-300 bg-red-50/30' : ''}`}
                rows={6}
                placeholder={'{\n  "way_uid": "{{trigger.uid}}",\n  "lang": "{{trigger.lang}}"\n}'}
              />
              {jsonFieldErrors.input && (
                <p className="text-xs text-red-600 mt-1">{jsonFieldErrors.input}</p>
              )}
              <p className="text-xs text-gray-400 mt-1">
                作为子工作流的 trigger_data，子工作流用 <code className="bg-gray-100 px-1 rounded">{'{{trigger.字段}}'}</code> 读取。支持模板：<code className="bg-gray-100 px-1 rounded">{'{{trigger.x}}'}</code>、<code className="bg-gray-100 px-1 rounded">{'{{nodeId.field}}'}</code>。
              </p>
            </div>
            <p className="text-xs text-gray-400">
              返回值取子工作流 <strong>response 节点</strong>的输出，本节点后续可用 <code className="bg-gray-100 px-1 rounded">{'{{本节点id.字段}}'}</code> 引用。检测到递归调用或层级超过 5 层会报错。
            </p>
          </>
        )}

        {node.type === 'redis' && (
          <RedisNodeConfig node={node} updateConfig={updateConfig} />
        )}

        {node.type === 'kafka' && (
          <KafkaNodeConfig node={node} updateConfig={updateConfig} />
        )}

        {node.type === 'object_storage' && (
          <ObjectStorageNodeConfig node={node} updateConfig={updateConfig} />
        )}

        {node.type !== 'response' && (
          <>
            <hr className="border-gray-100" />
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={node.config.allow_failure === true}
                onChange={e => updateConfig('allow_failure', e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm font-medium text-gray-700">失败时继续（allow_failure）</span>
                <span className="block text-xs text-gray-400 mt-0.5">
                  开启后，本节点的任何错误（超时、连接失败、URL 构建失败、HTTP 4xx/5xx、参数缺失等）都不会中断工作流，后续节点继续执行。下游可用 <code className="font-mono">{'{{'}{node.id}.error{'}}'}</code> 引用错误信息。
                </span>
              </span>
            </label>
          </>
        )}
      </div>

      <div className="p-4 border-t bg-gray-50 flex justify-between">
        <button
          onClick={onDelete}
          className="px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded-lg transition-colors"
        >
          删除节点
        </button>
        <button
          onClick={onClose}
          className="px-4 py-1.5 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
        >
          完成
        </button>
      </div>
    </div>
  )
}

// ── db_transaction / foreach 的 SQL 语句列表编辑 ────────────────────────
//
// statements 每条 = { sql, params }。后端按 params 为 JSON「数组」读取（as_array），
// 存成字符串会被静默丢弃，所以这里提交的 params 一定是字符串数组。
// 编辑期用本地草稿保留原始多行文本（含空行），提交前才 split→trim→去空行，
// 既能顺畅换行加参数，又不会把空参数写进 config（多绑一个 $N 会让 SQL 报错）。

interface StatementDraft {
  sql: string
  paramsText: string
}

function statementToDraft(stmt: any): StatementDraft {
  return {
    sql: typeof stmt?.sql === 'string' ? stmt.sql : '',
    paramsText: Array.isArray(stmt?.params)
      ? stmt.params.map((x: unknown) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n')
      : typeof stmt?.params === 'string'
        ? stmt.params
        : '',
  }
}

function StatementsEditor({
  node,
  updateConfig,
}: {
  node: WorkflowNodeData
  updateConfig: (key: string, value: any) => void
}) {
  const buildInitial = (): StatementDraft[] => {
    const arr = Array.isArray(node.config.statements) ? node.config.statements : []
    return arr.length ? arr.map(statementToDraft) : [{ sql: '', paramsText: '' }]
  }
  const [drafts, setDrafts] = useState<StatementDraft[]>(buildInitial)

  // 切换到别的节点时按新节点的 config 重建草稿
  useEffect(() => {
    setDrafts(buildInitial())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id])

  const commit = (next: StatementDraft[]) => {
    setDrafts(next)
    const statements = next.map((d) => ({
      sql: d.sql,
      params: d.paramsText
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    }))
    updateConfig('statements', statements)
  }

  const updateDraft = (idx: number, key: keyof StatementDraft, value: string) => {
    commit(drafts.map((d, i) => (i === idx ? { ...d, [key]: value } : d)))
  }
  const addStmt = () => commit([...drafts, { sql: '', paramsText: '' }])
  const removeStmt = (idx: number) => commit(drafts.filter((_, i) => i !== idx))

  return (
    <div className="space-y-3">
      <label className="block text-xs font-medium text-gray-500">SQL 语句（按顺序执行）</label>
      {drafts.map((d, idx) => (
        <div key={idx} className="rounded-lg border border-gray-200 p-2.5 space-y-2 bg-gray-50/40">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">语句 {idx + 1}</span>
            <button
              onClick={() => removeStmt(idx)}
              disabled={drafts.length <= 1}
              className="w-6 h-6 rounded-md text-gray-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400 text-base leading-none flex items-center justify-center shrink-0"
              title={drafts.length <= 1 ? '至少保留一条语句' : '删除该语句'}
            >
              &times;
            </button>
          </div>
          <textarea
            value={d.sql}
            onChange={(e) => updateDraft(idx, 'sql', e.target.value)}
            className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
            rows={4}
            placeholder="UPDATE t SET x=$1 WHERE id=($2)::int"
          />
          <div>
            <label className="block text-[11px] font-medium text-gray-500 mb-1">参数（每行一个，依次对应 $1、$2…）</label>
            <textarea
              value={d.paramsText}
              onChange={(e) => updateDraft(idx, 'paramsText', e.target.value)}
              className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
              rows={Math.max(2, d.paramsText.split('\n').length)}
              placeholder={'{{trigger.id}}\n{{trigger.hide_status}}'}
            />
            <p className="text-[11px] text-gray-400 mt-1">
              支持模板 <code className="font-mono">{'{{trigger.x}}'}</code>、<code className="font-mono">{'{{nodeId.field}}'}</code>；空行忽略。
            </p>
          </div>
        </div>
      ))}
      <button
        onClick={addStmt}
        className="w-full px-3 py-1.5 text-xs font-medium text-emerald-600 border border-dashed border-emerald-300 rounded-lg hover:bg-emerald-50"
      >
        + 添加 SQL 语句
      </button>
      <p className="text-xs text-gray-400">
        禁止 DROP / TRUNCATE。SQL 里也可直接写 <code className="font-mono">{'{{...}}'}</code> 模板（会自动参数化防注入）。
      </p>
    </div>
  )
}

// ── Redis 节点配置 ──────────────────────────────────────────────────────
//
// 连接下拉从当前项目（tenantId = URL projectId）的 redis-connections 拉取；
// 操作 + 参数字段随 op 动态渲染。所有文本字段支持 {{trigger.x}} / {{nodeId.field}} 模板。

const REDIS_OP_FIELDS: Record<RedisOp, ReadonlyArray<'key' | 'value' | 'field' | 'ttl' | 'nx' | 'pattern' | 'count' | 'start' | 'stop' | 'members' | 'values'>> = {
  get: ['key'],
  set: ['key', 'value', 'ttl', 'nx'],
  del: ['key'],
  exists: ['key'],
  expire: ['key', 'ttl'],
  ttl: ['key'],
  incr: ['key'],
  decr: ['key'],
  keys: ['pattern', 'count'],
  hget: ['key', 'field'],
  hset: ['key', 'field', 'value'],
  hgetall: ['key'],
  lpush: ['key', 'values'],
  rpush: ['key', 'values'],
  lrange: ['key', 'start', 'stop'],
  sadd: ['key', 'members'],
  smembers: ['key'],
}

function RedisNodeConfig({
  node,
  updateConfig,
}: {
  node: WorkflowNodeData
  updateConfig: (key: string, value: any) => void
}) {
  const params = useParams<{ projectId: string }>()
  const tenantId = parseInt(params?.projectId ?? '', 10)
  const [connections, setConnections] = useState<RedisConnection[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    redisAPI
      .listConnections(Number.isNaN(tenantId) ? undefined : tenantId)
      .then((res) => {
        if (alive) {
          const rows = Number.isNaN(tenantId)
            ? res.data
            : res.data.filter((c) => c.tenant_id === tenantId)
          setConnections(rows)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [tenantId])

  const op: RedisOp = (node.config.op as RedisOp) || 'get'
  const fields = REDIS_OP_FIELDS[op] ?? ['key']
  const connId = Number(node.config.connection_id) || 0

  const textField = (
    key: 'key' | 'value' | 'field' | 'pattern' | 'members' | 'values',
    label: string,
    placeholder: string,
    multiline = false,
  ) =>
    multiline ? (
      <div key={key}>
        <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
        <textarea
          value={node.config[key] ?? ''}
          onChange={(e) => updateConfig(key, e.target.value)}
          className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
          rows={2}
          placeholder={placeholder}
        />
      </div>
    ) : (
      <div key={key}>
        <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
        <input
          value={node.config[key] ?? ''}
          onChange={(e) => updateConfig(key, e.target.value)}
          className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
          placeholder={placeholder}
        />
      </div>
    )

  const numField = (key: 'ttl' | 'count' | 'start' | 'stop', label: string, placeholder: string) => (
    <div key={key}>
      <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
      <input
        value={node.config[key] ?? ''}
        onChange={(e) => updateConfig(key, e.target.value === '' ? undefined : Number(e.target.value))}
        type="number"
        className="w-full px-3 py-2 border rounded-lg text-sm"
        placeholder={placeholder}
      />
    </div>
  )

  return (
    <>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Redis 连接 *</label>
        <select
          value={connId}
          onChange={(e) => updateConfig('connection_id', Number(e.target.value))}
          className="w-full px-3 py-2 border rounded-lg text-sm"
        >
          <option value={0}>{loading ? '加载中…' : '请选择连接'}</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.connection_name}（{c.host}:{c.port}/db{c.db_index}）
            </option>
          ))}
        </select>
        {!loading && connections.length === 0 && (
          <p className="text-xs text-amber-600 mt-1">
            当前项目还没有 Redis 连接，请先到「集成 → Redis」创建。
          </p>
        )}
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">操作 *</label>
        <select
          value={op}
          onChange={(e) => updateConfig('op', e.target.value)}
          className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
        >
          {REDIS_OPS.map((o) => (
            <option key={o} value={o}>
              {o.toUpperCase()}
            </option>
          ))}
        </select>
      </div>

      {fields.includes('key') && textField('key', 'key', 'user:{{trigger.id}}')}
      {fields.includes('field') && textField('field', 'field', 'name')}
      {fields.includes('value') && textField('value', 'value', '{{trigger.value}}')}
      {fields.includes('ttl') && numField('ttl', 'TTL（秒）', op === 'set' ? '留空 = 不过期' : '过期秒数')}
      {fields.includes('pattern') && textField('pattern', 'pattern', 'user:*')}
      {fields.includes('count') && numField('count', '上限', '最多返回条数（≤10000）')}
      {fields.includes('start') && numField('start', 'start', '0')}
      {fields.includes('stop') && numField('stop', 'stop', '-1（末尾）')}
      {fields.includes('members') && textField('members', 'members', 'a, b, c', true)}
      {fields.includes('values') && textField('values', 'values', 'a, b, c', true)}

      {fields.includes('nx') && (
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={node.config.nx === true}
            onChange={(e) => updateConfig('nx', e.target.checked)}
          />
          <span className="text-xs font-medium text-gray-500">NX（仅当 key 不存在时写入）</span>
        </label>
      )}

      <p className="text-xs text-gray-400">
        文本字段支持模板：<code className="bg-gray-100 px-1 rounded">{'{{trigger.x}}'}</code>、
        <code className="bg-gray-100 px-1 rounded">{'{{nodeId.field}}'}</code>。写操作在
        dry_run / 生产只读调试下返回 mock，不落库。
      </p>
    </>
  )
}

// ── Kafka 节点配置 ──────────────────────────────────────────────────────

function KafkaNodeConfig({
  node,
  updateConfig,
}: {
  node: WorkflowNodeData
  updateConfig: (key: string, value: any) => void
}) {
  const params = useParams<{ projectId: string }>()
  const tenantId = parseInt(params?.projectId ?? '', 10)
  const [connections, setConnections] = useState<KafkaConnection[]>([])
  const [loading, setLoading] = useState(true)
  const connId = Number(node.config.connection_id) || 0

  useEffect(() => {
    let alive = true
    setLoading(true)
    kafkaAPI
      .listConnections(Number.isNaN(tenantId) ? undefined : tenantId)
      .then((res) => {
        if (alive) {
          const rows = Number.isNaN(tenantId)
            ? res.data
            : res.data.filter((c) => c.tenant_id === tenantId)
          setConnections(rows)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [tenantId])

  return (
    <>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Kafka 连接 *</label>
        <select
          value={connId}
          onChange={(e) => updateConfig('connection_id', Number(e.target.value))}
          className="w-full px-3 py-2 border rounded-lg text-sm"
        >
          <option value={0}>{loading ? '加载中…' : '请选择连接'}</option>
          {connections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.connection_name}（{connection.brokers}）
            </option>
          ))}
        </select>
        {!loading && connections.length === 0 && (
          <p className="text-xs text-amber-600 mt-1">
            当前项目还没有 Kafka 连接，请先到「集成 → Kafka」创建。
          </p>
        )}
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">操作 *</label>
        <select
          value={node.config.op || 'produce'}
          onChange={(e) => updateConfig('op', e.target.value)}
          className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
        >
          <option value="produce">PRODUCE</option>
        </select>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Topic *</label>
        <input
          value={node.config.topic || ''}
          onChange={(e) => updateConfig('topic', e.target.value)}
          className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
          placeholder="events.user-created"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Key（可选）</label>
        <input
          value={node.config.key || ''}
          onChange={(e) => updateConfig('key', e.target.value)}
          className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
          placeholder="{{trigger.user_id}}"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Value *</label>
        <textarea
          value={node.config.value || ''}
          onChange={(e) => updateConfig('value', e.target.value)}
          className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
          rows={4}
          placeholder={'{"id":"{{trigger.user_id}}"}'}
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Headers（可选 JSON 对象）</label>
        <textarea
          value={
            typeof node.config.headers === 'string'
              ? node.config.headers
              : node.config.headers
                ? JSON.stringify(node.config.headers, null, 2)
                : ''
          }
          onChange={(e) => {
            const raw = e.target.value
            try {
              const parsed = raw.trim() ? JSON.parse(raw) : undefined
              updateConfig('headers', parsed)
            } catch {
              updateConfig('headers', raw)
            }
          }}
          className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
          rows={3}
          placeholder={'{\n  "x-trace-id": "{{trigger.trace_id}}"\n}'}
        />
      </div>

      <p className="text-xs text-gray-400">
        Topic、Key、Value、Headers 支持模板：<code className="bg-gray-100 px-1 rounded">{'{{trigger.x}}'}</code>、
        <code className="bg-gray-100 px-1 rounded">{'{{nodeId.field}}'}</code>。
      </p>
    </>
  )
}

// ── 对象存储节点配置 ────────────────────────────────────────────────────

const OS_OP_FIELDS: Record<
  ObjectStorageOp,
  ReadonlyArray<'key' | 'content' | 'prefix' | 'max_keys' | 'method' | 'expires_secs' | 'keys'>
> = {
  put: ['key', 'content'],
  get: ['key'],
  delete: ['key', 'keys'],
  list: ['prefix', 'max_keys'],
  presign: ['key', 'method', 'expires_secs'],
}

function ObjectStorageNodeConfig({
  node,
  updateConfig,
}: {
  node: WorkflowNodeData
  updateConfig: (key: string, value: any) => void
}) {
  const params = useParams<{ projectId: string }>()
  const tenantId = parseInt(params?.projectId ?? '', 10)
  const [connections, setConnections] = useState<ObjectStorageConnection[]>([])
  const [loading, setLoading] = useState(true)
  const op: ObjectStorageOp = (node.config.op as ObjectStorageOp) || 'get'
  const fields = OS_OP_FIELDS[op] ?? ['key']
  const connId = Number(node.config.connection_id) || 0

  useEffect(() => {
    let alive = true
    setLoading(true)
    objectStorageAPI
      .listConnections(Number.isNaN(tenantId) ? undefined : tenantId)
      .then((res) => {
        if (alive) setConnections(res.data)
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [tenantId])

  return (
    <>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">对象存储连接 *</label>
        <select
          value={connId}
          onChange={(e) => updateConfig('connection_id', Number(e.target.value))}
          className="w-full px-3 py-2 border rounded-lg text-sm"
        >
          <option value={0}>{loading ? '加载中…' : '请选择连接'}</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.connection_name}（{c.bucket}）
            </option>
          ))}
        </select>
        {!loading && connections.length === 0 && (
          <p className="text-xs text-amber-600 mt-1">
            当前项目还没有对象存储连接，请先到「集成 → 对象存储」创建。
          </p>
        )}
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">操作 *</label>
        <select
          value={op}
          onChange={(e) => updateConfig('op', e.target.value)}
          className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
        >
          {OBJECT_STORAGE_OPS.map((o) => (
            <option key={o} value={o}>
              {o.toUpperCase()}
            </option>
          ))}
        </select>
      </div>

      {fields.includes('key') && (
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">key *</label>
          <input
            value={node.config.key ?? ''}
            onChange={(e) => updateConfig('key', e.target.value)}
            className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
            placeholder="uploads/{{trigger.id}}.txt"
          />
        </div>
      )}

      {fields.includes('content') && (
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">content</label>
          <textarea
            value={node.config.content ?? ''}
            onChange={(e) => updateConfig('content', e.target.value)}
            className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
            rows={3}
            placeholder="{{trigger.body}}"
          />
        </div>
      )}

      {fields.includes('keys') && (
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">
            keys（可选，JSON 数组；优先于单个 key）
          </label>
          <textarea
            value={
              typeof node.config.keys === 'string'
                ? node.config.keys
                : node.config.keys
                  ? JSON.stringify(node.config.keys, null, 2)
                  : ''
            }
            onChange={(e) => {
              const raw = e.target.value
              try {
                const parsed = raw.trim() ? JSON.parse(raw) : undefined
                updateConfig('keys', parsed)
              } catch {
                updateConfig('keys', raw)
              }
            }}
            className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
            rows={2}
            placeholder={'["a.txt", "b.txt"]'}
          />
        </div>
      )}

      {fields.includes('prefix') && (
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">prefix</label>
          <input
            value={node.config.prefix ?? ''}
            onChange={(e) => updateConfig('prefix', e.target.value)}
            className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
            placeholder="uploads/"
          />
        </div>
      )}

      {fields.includes('max_keys') && (
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">max_keys</label>
          <input
            type="number"
            value={node.config.max_keys ?? ''}
            onChange={(e) =>
              updateConfig('max_keys', e.target.value === '' ? undefined : Number(e.target.value))
            }
            className="w-full px-3 py-2 border rounded-lg text-sm"
            placeholder="默认 100，上限 1000"
          />
        </div>
      )}

      {fields.includes('method') && (
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">presign method</label>
          <select
            value={node.config.method || 'PUT'}
            onChange={(e) => updateConfig('method', e.target.value)}
            className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
          >
            <option value="PUT">PUT</option>
            <option value="GET">GET</option>
          </select>
        </div>
      )}

      {fields.includes('expires_secs') && (
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">expires_secs</label>
          <input
            type="number"
            value={node.config.expires_secs ?? ''}
            onChange={(e) =>
              updateConfig(
                'expires_secs',
                e.target.value === '' ? undefined : Number(e.target.value),
              )
            }
            className="w-full px-3 py-2 border rounded-lg text-sm"
            placeholder="默认 3600，上限 86400"
          />
        </div>
      )}

      <p className="text-xs text-gray-400">
        文本字段支持模板：<code className="bg-gray-100 px-1 rounded">{'{{trigger.x}}'}</code>、
        <code className="bg-gray-100 px-1 rounded">{'{{nodeId.field}}'}</code>。写操作在
        dry_run / 生产只读调试下返回 mock，不落桶。
      </p>
    </>
  )
}
