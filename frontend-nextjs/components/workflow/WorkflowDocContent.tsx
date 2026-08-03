'use client'

/**
 * 工作流「接口文档」的共享渲染层。
 *
 * 文档的「排版渲染」只此一份，两处复用：
 *  - 登录态编辑器里的 `WorkflowDocModal`（弹窗）：用 `deriveDocModel` 从内存中的工作流定义推导；
 *  - 公开分享页 `app/doc/[token]`（免登录）：从后端 `GET /api/public/workflow-doc/:token` 取 `DocModel`。
 *
 * 两端都把一个提炼后的 `DocModel` 喂给 `WorkflowDocContent`，保证展示、文案、Markdown 完全一致。
 */

import { useMemo, useState } from 'react'
import type { WorkflowNodeDef } from '@/components/workflow/WorkflowCanvas'

/** 提炼后的接口文档模型：前后端一致的数据契约（不含 nodes/edges）。 */
export interface DocModel {
  name: string
  description: string
  slug: string
  /** tenant_databases.slug，用于拼调用地址；缺省时展示占位符。 */
  database_slug: string
  trigger_type: string
  trigger_config: Record<string, unknown>
  timeout_ms: number
  /** 节点里 {{trigger.X}} 引用扫描出的入参字段名（已去重排序）。 */
  input_fields: string[]
  /** response 节点的 body 模板（字符串化）；无则 null。 */
  response_body: string | null
  status_code: number
  has_response_node: boolean
  /** 后端下发的对外调用基址（网关域名）；公开文档页据此拼调用地址，缺省时前端兜底。 */
  api_base_url?: string
  /** 后端下发的是否走网关；true 时隐藏 API Key 鉴权头（网关统一鉴权）。 */
  gateway_mode?: boolean
}

const DOC_DESCRIPTION_LIMIT = 160

function compactDescription(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function looksLikeInternalNotes(value: string): boolean {
  const text = value.trim()
  if (!text) return false

  const versionMarkers = (text.match(/\bv\d+\b/gi) || []).length
  const fixMarkers = (text.match(/\bFIX-\d+\b/gi) || []).length
  const technicalMarkers = (text.match(/\b[a-z][a-z0-9_]{2,}\b/gi) || []).length

  return (
    text.length > DOC_DESCRIPTION_LIMIT ||
    versionMarkers >= 2 ||
    fixMarkers >= 2 ||
    (technicalMarkers >= 8 && /[；;、]/.test(text))
  )
}

function fallbackPurpose(model: Pick<DocModel, 'name' | 'trigger_type'>): string {
  const name = model.name || '该工作流'
  if (model.trigger_type === 'endpoint') {
    return `通过接口触发「${name}」，按文档传入参数后返回处理结果。`
  }
  if (model.trigger_type === 'hook') {
    return `监听数据变更并自动执行「${name}」。`
  }
  if (model.trigger_type === 'notify') {
    return `接收 PG NOTIFY 消息并自动执行「${name}」。`
  }
  if (model.trigger_type === 'cron') {
    return `按定时计划自动执行「${name}」。`
  }
  if (model.trigger_type === 'kafka') {
    return `消费 Kafka Topic 消息并自动执行「${name}」。`
  }
  return `在工作流面板中手动执行「${name}」。`
}

export function resolveDocPurpose(model: Pick<DocModel, 'name' | 'description' | 'trigger_type'>): {
  text: string
  source: 'description' | 'generated'
} {
  const description = compactDescription(model.description || '')
  if (description && !looksLikeInternalNotes(description)) {
    return { text: description, source: 'description' }
  }

  return {
    text: fallbackPurpose(model),
    source: 'generated',
  }
}

// 从节点配置里扫描所有 {{trigger.xxx}} 引用，提取顶层字段名作为入参清单。
// 与后端 mcp_tools::scan_trigger_fields 同一业务规则。
function collectTriggerFields(nodes: WorkflowNodeDef[]): string[] {
  const re = /\{\{\s*trigger\.([A-Za-z0-9_]+)/g
  const found = new Set<string>()
  const blob = JSON.stringify(nodes || [])
  let m: RegExpExecArray | null
  while ((m = re.exec(blob)) !== null) {
    if (m[1]) found.add(m[1])
  }
  return Array.from(found).sort()
}

/** 登录态：从内存中的工作流定义推导 DocModel（与后端 build_doc_model 等价）。 */
export function deriveDocModel(
  meta: {
    name: string
    slug: string
    description: string
    trigger_type: string
    trigger_config: string
    timeout_ms: number
  },
  nodes: WorkflowNodeDef[],
  dbSlug: string,
): DocModel {
  let trigger_config: Record<string, unknown> = {}
  try {
    trigger_config = meta.trigger_config ? JSON.parse(meta.trigger_config) : {}
  } catch {
    trigger_config = {}
  }

  const responseNode = (nodes || []).find((n) => n.type === 'response')
  let response_body: string | null = null
  if (responseNode) {
    const b = responseNode.config?.body
    if (b != null) {
      response_body = typeof b === 'string' ? b : JSON.stringify(b, null, 2)
    }
  }
  const status_code = Number(responseNode?.config?.status_code) || 200

  return {
    name: meta.name,
    description: meta.description || '',
    slug: meta.slug,
    database_slug: dbSlug || '',
    trigger_type: meta.trigger_type,
    trigger_config,
    timeout_ms: meta.timeout_ms,
    input_fields: collectTriggerFields(nodes),
    response_body,
    status_code,
    has_response_node: !!responseNode,
  }
}

function endpointUrl(model: DocModel, apiBase: string): string {
  const base = apiBase || (typeof window !== 'undefined' ? window.location.origin : '')
  const dbSlug = model.database_slug || ':database_slug'
  const slug = model.slug || ':slug'
  return `${base}/workflow/${dbSlug}/${slug}`
}

function sampleBody(fields: string[]): string {
  if (fields.length === 0) return '{}'
  const obj: Record<string, string> = {}
  for (const f of fields) obj[f] = `<${f}>`
  return JSON.stringify(obj, null, 2)
}

function curlExample(url: string, fields: string[], gatewayMode = false): string {
  const lines = [`curl -X POST '${url}' \\`]
  // 走网关时鉴权由网关统一处理，示例不再展示 API Key 头。
  if (!gatewayMode) lines.push(`  -H 'Authorization: Bearer cr_<your_api_key>' \\`)
  lines.push(`  -H 'Content-Type: application/json' \\`)
  lines.push(`  -d '${sampleBody(fields).replace(/\n\s*/g, ' ')}'`)
  return lines.join('\n')
}

/** 把整份接口文档拼成 Markdown（供「复制全部」一次性带走喂 AI）。 */
export function buildDocMarkdown(model: DocModel, apiBase: string, gatewayMode = false): string {
  const isEndpoint = model.trigger_type === 'endpoint'
  const url = endpointUrl(model, apiBase)
  const cfg = model.trigger_config
  const purpose = resolveDocPurpose(model)
  const L: string[] = []
  L.push(`# 接口文档 · ${model.name || '未命名工作流'}`)
  L.push('', '## 用途说明', purpose.text)
  L.push('', '## 调用方式')
  if (isEndpoint) {
    L.push('- 方法：POST / GET', `- 地址：${url}`, '- POST 用 JSON body 传参；GET 用 query string 传参。')
  } else if (model.trigger_type === 'hook') {
    L.push(`数据变更自动触发：监听 ${(cfg.schema as string) || 'public'}.${(cfg.table as string) || '<表>'} 的 INSERT/UPDATE/DELETE，变更行作为 trigger 数据传入。`)
  } else if (model.trigger_type === 'notify') {
    L.push(`PG NOTIFY 自动触发：监听 channel ${(cfg.channel as string) || '<channel>'}，payload 作为 trigger 数据。`)
  } else if (model.trigger_type === 'cron') {
    L.push(`定时触发：Cron \`${(cfg.cron as string) || (cfg.schedule as string) || '<cron>'}\` 自动执行，无外部入参。`)
  } else if (model.trigger_type === 'kafka') {
    L.push(
      `Kafka 自动触发：消费 Topic \`${(cfg.topic as string) || '<topic>'}\` 的消息，按 ${(cfg.value_format as string) || 'json'} 解析后作为 trigger 数据。`,
    )
  } else {
    L.push('手动触发：面板点「运行」，或 POST /api/admin/workflows/<id>/trigger（需管理员 JWT）。')
  }
  if (isEndpoint) {
    L.push('', '## 鉴权')
    if (gatewayMode) {
      L.push('请求经网关统一鉴权，无需在调用侧携带 API Key。')
    } else {
      L.push('请求头二选一：')
      L.push('- API Key：`Authorization: Bearer cr_xxx` 或 `apikey: cr_xxx`（须绑定本数据库）')
      L.push('- 用户 JWT：`Authorization: Bearer <登录 token>`（须有该数据库所属租户权限）')
    }
  }
  L.push('', '## 请求参数')
  if (model.input_fields.length === 0) {
    L.push('未检测到 {{trigger.字段}} 引用——不依赖外部入参，传空 body 即可。')
  } else {
    L.push('以下字段来自节点中 {{trigger.X}} 引用（自动扫描，类型需按业务确认）：', '', '| 字段 | 模板引用 |', '| --- | --- |')
    for (const f of model.input_fields) L.push(`| ${f} | {{trigger.${f}}} |`)
  }
  if (isEndpoint) {
    L.push('', '## 请求示例', '```bash', curlExample(url, model.input_fields, gatewayMode), '```')
  }
  L.push('', '## 返回值')
  if (model.has_response_node) {
    L.push(`由 response 节点决定，HTTP 状态码 ${model.status_code}，响应体：`)
    if (model.response_body) {
      L.push('```json', model.response_body, '```')
    } else {
      L.push('response 节点未配置 body，将返回 { "ok": true }。')
    }
    L.push('注：响应体里的 {{...}} 会在运行时替换成实际值。')
  } else {
    L.push('无 response 节点：返回最后一个成功节点的输出（JSON）。建议加 response 节点固定返回结构。')
  }
  L.push('', `> 超时 ${Math.round((model.timeout_ms || 30000) / 1000)}s（超时强制中止）。`)
  return L.join('\n')
}

// 复制按钮：点击把文本写入剪贴板，短暂显示「已复制」。
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className="text-xs px-2 py-0.5 rounded border border-gray-300 text-gray-500 hover:bg-gray-100"
    >
      {copied ? '已复制' : '复制'}
    </button>
  )
}

// 「复制全部」按钮：把整份内容拼成 Markdown 一次性复制，便于整段喂给 AI（替代分块复制）。
export function CopyMarkdownButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      data-alt="copy-all-markdown"
      onClick={() => { navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800) }) }}
      title="把整份文档复制为 Markdown，可直接粘贴给 AI"
      className="px-3 py-1.5 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium inline-flex items-center gap-1.5 shrink-0"
    >
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
      {copied ? '已复制 ✓' : '复制全部 (Markdown)'}
    </button>
  )
}

/** 接口文档正文（各分节）。不含标题栏；由外层（弹窗 / 页面）自行提供标题和「复制全部」。 */
export default function WorkflowDocContent({
  model,
  apiBase,
  gatewayMode = false,
}: {
  model: DocModel
  apiBase: string
  gatewayMode?: boolean
}) {
  const isEndpoint = model.trigger_type === 'endpoint'
  const cfg = model.trigger_config
  const url = useMemo(() => endpointUrl(model, apiBase), [model, apiBase])
  const curl = useMemo(() => curlExample(url, model.input_fields, gatewayMode), [url, model.input_fields, gatewayMode])
  const purpose = useMemo(() => resolveDocPurpose(model), [model])
  const triggerFields = model.input_fields

  return (
    <div className="space-y-6 text-sm text-gray-700">
      {/* 用途说明 */}
      <section className="rounded-xl border border-indigo-100 bg-gradient-to-br from-indigo-50 via-white to-sky-50 p-4 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M12 3a9 9 0 110 18 9 9 0 010-18z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex items-center gap-2">
              <h4 className="font-semibold text-gray-900">用途说明</h4>
              <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-indigo-600 ring-1 ring-indigo-100">
                {purpose.source === 'description' ? '来自描述' : '自动整理'}
              </span>
            </div>
            <p className="text-sm leading-6 text-gray-700">{purpose.text}</p>
          </div>
        </div>
      </section>

      {/* 调用方式 */}
      <section>
        <h4 className="font-semibold text-gray-900 mb-2">调用方式</h4>
        {isEndpoint ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="px-2 py-0.5 rounded bg-green-100 text-green-700 text-xs font-mono font-semibold">POST</span>
              <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-700 text-xs font-mono font-semibold">GET</span>
              <code className="text-xs bg-gray-100 px-2 py-1 rounded font-mono break-all flex-1 min-w-0">{url}</code>
              <CopyButton text={url} />
            </div>
            <p className="text-xs text-gray-500 leading-relaxed">
              外部系统直接请求该地址即可触发。<strong>POST</strong> 用 JSON body 传参；
              <strong>GET</strong> 用 query string 传参（如 <code className="bg-gray-100 px-1 rounded">?{triggerFields[0] || 'key'}=值</code>）。
            </p>
          </div>
        ) : model.trigger_type === 'hook' ? (
          <p className="text-xs text-gray-600 leading-relaxed">
            <strong>数据变更自动触发</strong>，无需手动调用。监听
            <code className="bg-gray-100 px-1 rounded mx-1">{(cfg.schema as string) || 'public'}.{(cfg.table as string) || '<表>'}</code>
            的 INSERT/UPDATE/DELETE，变更的行作为 <code className="bg-gray-100 px-1 rounded">trigger</code> 数据传入。
          </p>
        ) : model.trigger_type === 'notify' ? (
          <p className="text-xs text-gray-600 leading-relaxed">
            <strong>PG NOTIFY 自动触发</strong>：监听 channel
            <code className="bg-gray-100 px-1 rounded mx-1">{(cfg.channel as string) || '<channel>'}</code>，
            NOTIFY 的 payload 作为 <code className="bg-gray-100 px-1 rounded">trigger</code> 数据。
          </p>
        ) : model.trigger_type === 'cron' ? (
          <p className="text-xs text-gray-600 leading-relaxed">
            <strong>定时触发</strong>：按 Cron 表达式
            <code className="bg-gray-100 px-1 rounded mx-1">{(cfg.cron as string) || (cfg.schedule as string) || '<cron>'}</code>
            自动执行，无外部入参。
          </p>
        ) : model.trigger_type === 'kafka' ? (
          <p className="text-xs text-gray-600 leading-relaxed">
            <strong>Kafka 自动触发</strong>：消费 Topic
            <code className="bg-gray-100 px-1 rounded mx-1">{(cfg.topic as string) || '<topic>'}</code>
            的消息，按
            <code className="bg-gray-100 px-1 rounded mx-1">{(cfg.value_format as string) || 'json'}</code>
            解析后作为 <code className="bg-gray-100 px-1 rounded">trigger</code> 数据传入。
          </p>
        ) : (
          <p className="text-xs text-gray-600 leading-relaxed">
            <strong>手动触发</strong>：仅在本面板点「运行」执行，或通过
            <code className="bg-gray-100 px-1 rounded mx-1">POST /api/admin/workflows/&lt;id&gt;/trigger</code> 调用（需管理员 JWT）。
          </p>
        )}
      </section>

      {/* 鉴权 */}
      {isEndpoint && (
        <section>
          <h4 className="font-semibold text-gray-900 mb-2">鉴权</h4>
          {gatewayMode ? (
            <p className="text-xs text-gray-600 leading-relaxed">
              请求经网关统一鉴权，无需在调用侧携带 API Key。
            </p>
          ) : (
            <>
              <p className="text-xs text-gray-600 leading-relaxed mb-1.5">二选一，请求头携带：</p>
              <ul className="space-y-1 text-xs text-gray-600 list-disc pl-5">
                <li><strong>API Key</strong>：<code className="bg-gray-100 px-1 rounded">Authorization: Bearer cr_xxx</code> 或 <code className="bg-gray-100 px-1 rounded">apikey: cr_xxx</code>（该 Key 须绑定本数据库）。</li>
                <li><strong>用户 JWT</strong>：<code className="bg-gray-100 px-1 rounded">Authorization: Bearer &lt;登录 token&gt;</code>（须有该数据库所属租户权限）。</li>
              </ul>
            </>
          )}
        </section>
      )}

      {/* 请求参数 */}
      <section>
        <h4 className="font-semibold text-gray-900 mb-2">请求参数</h4>
        {triggerFields.length === 0 ? (
          <p className="text-xs text-gray-500">
            未检测到 <code className="bg-gray-100 px-1 rounded">{'{{trigger.字段}}'}</code> 引用——本工作流不依赖外部入参，传空 body 即可。
          </p>
        ) : (
          <>
            <p className="text-xs text-gray-500 mb-2">
              以下字段来自节点中对 <code className="bg-gray-100 px-1 rounded">{'{{trigger.X}}'}</code> 的引用（自动扫描，仅供参考，类型需按业务确认）：
            </p>
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="text-left px-3 py-1.5 font-medium">字段</th>
                    <th className="text-left px-3 py-1.5 font-medium">模板引用</th>
                  </tr>
                </thead>
                <tbody>
                  {triggerFields.map(f => (
                    <tr key={f} className="border-t">
                      <td className="px-3 py-1.5 font-mono text-gray-700">{f}</td>
                      <td className="px-3 py-1.5 font-mono text-gray-400">{`{{trigger.${f}}}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {/* 请求示例 */}
      {isEndpoint && (
        <section>
          <div className="flex items-center justify-between mb-2">
            <h4 className="font-semibold text-gray-900">请求示例</h4>
            <CopyButton text={curl} />
          </div>
          <pre className="bg-gray-900 text-gray-100 text-xs rounded-lg p-3 overflow-auto font-mono leading-relaxed">{curl}</pre>
        </section>
      )}

      {/* 返回值 */}
      <section>
        <h4 className="font-semibold text-gray-900 mb-2">返回值</h4>
        {model.has_response_node ? (
          <div className="space-y-2">
            <p className="text-xs text-gray-500">
              由 <code className="bg-gray-100 px-1 rounded">response</code> 节点决定，
              HTTP 状态码 <code className="bg-gray-100 px-1 rounded">{String(model.status_code)}</code>，响应体：
            </p>
            {model.response_body ? (
              <pre className="bg-gray-50 border text-xs rounded-lg p-3 overflow-auto font-mono leading-relaxed max-h-56">{model.response_body}</pre>
            ) : (
              <p className="text-xs text-gray-400">response 节点未配置 body，将返回 <code className="bg-gray-100 px-1 rounded">{'{ "ok": true }'}</code>。</p>
            )}
            <p className="text-xs text-gray-400">注：响应体里的 <code className="bg-gray-100 px-1 rounded">{'{{...}}'}</code> 会在运行时替换成实际值。</p>
          </div>
        ) : (
          <p className="text-xs text-gray-500 leading-relaxed">
            无 <code className="bg-gray-100 px-1 rounded">response</code> 节点：接口返回<strong>最后一个成功节点的输出</strong>（JSON）；
            若想固定返回结构，建议加一个 response 节点。
          </p>
        )}
      </section>

      {/* 其他 */}
      <section className="text-xs text-gray-400 leading-relaxed border-t pt-3">
        超时 {Math.round((model.timeout_ms || 30000) / 1000)}s（超时强制中止）。
      </section>

      {/* 通用速查（折叠） */}
      <details className="text-xs">
        <summary className="cursor-pointer text-gray-500 hover:text-gray-700 font-medium">节点类型 &amp; 模板变量速查</summary>
        <div className="mt-2 space-y-2 text-gray-600">
          <p><code className="bg-gray-100 px-1 rounded">{'{{trigger.字段}}'}</code> 引用入参；<code className="bg-gray-100 px-1 rounded">{'{{节点ID.字段}}'}</code> 引用上游节点输出，支持 <code className="bg-gray-100 px-1 rounded">{'{{q.rows[0].id}}'}</code> 这样的嵌套/下标。</p>
          <ul className="list-disc pl-5 space-y-0.5">
            <li><strong>code</strong> Lua / JavaScript / Python 脚本 · <strong>db_query</strong> 只读 SQL · <strong>db_execute</strong> 写库</li>
            <li><strong>http_call</strong> 调外部接口 · <strong>email_send</strong> 发邮件 · <strong>sse_publish</strong> 推送</li>
            <li><strong>redis</strong> Redis 读写 · <strong>kafka</strong> 生产消息 · <strong>call_workflow</strong> 调子工作流</li>
            <li><strong>condition</strong> 条件分支 · <strong>loop</strong> 循环 · <strong>transform</strong> 拼装 · <strong>response</strong> HTTP 返回体</li>
          </ul>
        </div>
      </details>
    </div>
  )
}
