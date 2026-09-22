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
import { useTranslations } from 'next-intl'
import type { WorkflowNodeDef } from '@/components/workflow/WorkflowCanvas'
import { copyTextToClipboard } from '@/lib/clipboard'

export type InputRequired = 'yes' | 'no' | 'conditional'
export type InputSource = 'schema' | 'scan'

export interface DocInputField {
  field: string
  type?: string | null
  description?: string | null
  required: InputRequired
  example?: unknown
  template: string
}

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
  input_source: InputSource
  input_fields: DocInputField[]
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

function fallbackPurpose(model: Pick<DocModel, 'name' | 'trigger_type'>, t: (k: string, p?: any) => string): string {
  const name = model.name || t('thisWf')
  if (model.trigger_type === 'endpoint') {
    return t('fpEndpoint', { name })
  }
  if (model.trigger_type === 'hook') {
    return t('fpHook', { name })
  }
  if (model.trigger_type === 'notify') {
    return t('fpNotify', { name })
  }
  if (model.trigger_type === 'cron') {
    return t('fpCron', { name })
  }
  if (model.trigger_type === 'kafka') {
    return t('fpKafka', { name })
  }
  return t('fpManual', { name })
}

export function resolveDocPurpose(model: Pick<DocModel, 'name' | 'description' | 'trigger_type'>, t: (k: string, p?: any) => string): {
  text: string
  source: 'description' | 'generated'
} {
  const description = compactDescription(model.description || '')
  if (description && !looksLikeInternalNotes(description)) {
    return { text: description, source: 'description' }
  }

  return {
    text: fallbackPurpose(model, t),
    source: 'generated',
  }
}

// 与后端 workflow_input_schema::scan_trigger_fields 同一规则（字母数字含非 ASCII、`_`、`-`）。
function collectTriggerFields(nodes: WorkflowNodeDef[]): string[] {
  const re = new RegExp(String.raw`\{\{\s*trigger\.([\p{L}\p{N}_-]+)`, 'gu')
  const found = new Set<string>()
  const blob = JSON.stringify(nodes || [])
  let m: RegExpExecArray | null
  while ((m = re.exec(blob)) !== null) {
    if (m[1]) found.add(m[1])
  }
  return Array.from(found).sort()
}

function requiredNameSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set()
  return new Set(value.filter((item): item is string => typeof item === 'string'))
}

function collectConditionalRequired(schema: Record<string, unknown>): Set<string> {
  const out = new Set<string>()
  for (const key of ['oneOf', 'anyOf'] as const) {
    const arr = schema[key]
    if (!Array.isArray(arr)) continue
    for (const branch of arr) {
      if (branch && typeof branch === 'object' && !Array.isArray(branch)) {
        for (const name of Array.from(
          requiredNameSet((branch as Record<string, unknown>).required),
        )) {
          out.add(name)
        }
      }
    }
  }
  return out
}

function fieldsFromSchema(schema: Record<string, unknown>): DocInputField[] {
  const properties = schema.properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return []
  const topRequired = requiredNameSet(schema.required)
  const conditional = collectConditionalRequired(schema)
  const fields: DocInputField[] = Object.entries(properties as Record<string, unknown>).map(([name, raw]) => {
    const prop = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
    const propRequired = prop.required === true
    const required: InputRequired = topRequired.has(name) || propRequired
      ? 'yes'
      : conditional.has(name)
        ? 'conditional'
        : 'no'
    return {
      field: name,
      type: typeof prop.type === 'string' ? prop.type : null,
      description: typeof prop.description === 'string' ? prop.description : null,
      required,
      example: 'example' in prop ? prop.example : undefined,
      template: `{{trigger.${name}}}`,
    }
  })
  return fields.sort((a, b) => a.field.localeCompare(b.field))
}

function parseInputSchemaValue(raw: unknown): Record<string, unknown> | null {
  if (raw == null || raw === '') return null
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  return null
}

function resolveDocInputs(schema: unknown, nodes: WorkflowNodeDef[]): { source: InputSource; fields: DocInputField[] } {
  const parsed = parseInputSchemaValue(schema)
  if (parsed) {
    return { source: 'schema', fields: fieldsFromSchema(parsed) }
  }
  return {
    source: 'scan',
    fields: collectTriggerFields(nodes).map((name) => ({
      field: name,
      required: 'no' as const,
      template: `{{trigger.${name}}}`,
    })),
  }
}

function requiredLabel(required: InputRequired, t: (k: string) => string): string {
  if (required === 'yes') return t('reqYes')
  if (required === 'conditional') return t('reqConditional')
  return t('reqNo')
}

function emptyInputCopy(source: InputSource, t: (k: string, p?: any) => string): string {
  return source === 'schema'
    ? t('emptySchema')
    : t('emptyScan', { tpl: '{{trigger.field}}' })
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
    input_schema?: string | Record<string, unknown> | null
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
  const resolved = resolveDocInputs(meta.input_schema, nodes)

  return {
    name: meta.name,
    description: meta.description || '',
    slug: meta.slug,
    database_slug: dbSlug || '',
    trigger_type: meta.trigger_type,
    trigger_config,
    timeout_ms: meta.timeout_ms,
    input_source: resolved.source,
    input_fields: resolved.fields,
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

function placeholderForType(typeName: string | null | undefined, field: string): unknown {
  if (typeName === 'number' || typeName === 'integer') return 0
  if (typeName === 'boolean') return false
  if (typeName === 'object') return {}
  if (typeName === 'array') return []
  return `<${field}>`
}

function sampleBody(fields: DocInputField[]): string {
  if (fields.length === 0) return '{}'
  const obj: Record<string, unknown> = {}
  for (const f of fields) {
    obj[f.field] = f.example !== undefined ? f.example : placeholderForType(f.type, f.field)
  }
  return JSON.stringify(obj, null, 2)
}

function curlExample(url: string, fields: DocInputField[], gatewayMode = false): string {
  const lines = [`curl -X POST '${url}' \\`]
  // 走网关时鉴权由网关统一处理，示例不再展示 API Key 头。
  if (!gatewayMode) lines.push(`  -H 'Authorization: Bearer ob_<your_api_key>' \\`)
  lines.push(`  -H 'Content-Type: application/json' \\`)
  lines.push(`  -d '${sampleBody(fields).replace(/\n\s*/g, ' ')}'`)
  return lines.join('\n')
}

/** 把整份接口文档拼成 Markdown（供「复制全部」一次性带走喂 AI）。 */
export function buildDocMarkdown(model: DocModel, apiBase: string, t: (k: string, p?: any) => string, gatewayMode = false): string {
  const isEndpoint = model.trigger_type === 'endpoint'
  const url = endpointUrl(model, apiBase)
  const cfg = model.trigger_config
  const purpose = resolveDocPurpose(model, t)
  const L: string[] = []
  L.push(t('mdDocTitle', { name: model.name || t('unnamed') }))
  L.push('', t('mdPurposeH'), purpose.text)
  L.push('', t('mdCallH'))
  if (isEndpoint) {
    L.push(t('mdCallEndpoint1'), t('mdAddr', { url }), t('mdCallEndpoint3'))
  } else if (model.trigger_type === 'hook') {
    L.push(t('mdHook', { res: `${(cfg.schema as string) || 'public'}.${(cfg.table as string) || '<table>'}` }))
  } else if (model.trigger_type === 'notify') {
    L.push(t('mdNotify', { channel: (cfg.channel as string) || '<channel>' }))
  } else if (model.trigger_type === 'cron') {
    L.push(t('mdCron', { cron: (cfg.cron as string) || (cfg.schedule as string) || '<cron>' }))
  } else if (model.trigger_type === 'kafka') {
    L.push(
      t('mdKafka', { topic: (cfg.topic as string) || '<topic>', fmt: (cfg.value_format as string) || 'json' }),
    )
  } else {
    L.push(t('mdManual'))
  }
  if (isEndpoint) {
    L.push('', t('mdAuthH'))
    if (gatewayMode) {
      L.push(t('mdAuthGateway'))
    } else {
      L.push(t('mdAuthPick'))
      L.push(t('mdAuthApiKey'))
      L.push(t('mdAuthJwt'))
    }
  }
  L.push('', t('mdParamsH'))
  if (model.input_fields.length === 0) {
    L.push(emptyInputCopy(model.input_source, t))
  } else if (model.input_source === 'schema') {
    L.push(t('mdParamsSchema'), '', t('mdTableSchema'), '| --- | --- | --- | --- |')
    for (const f of model.input_fields) {
      L.push(`| ${f.field} | ${f.type || ''} | ${requiredLabel(f.required, t)} | ${f.description || ''} |`)
    }
  } else {
    L.push(t('mdParamsScan'), '', t('mdTableScan'), '| --- | --- |')
    for (const f of model.input_fields) L.push(`| ${f.field} | ${f.template} |`)
  }
  if (isEndpoint) {
    L.push('', t('mdExampleH'), '```bash', curlExample(url, model.input_fields, gatewayMode), '```')
  }
  L.push('', t('mdReturnH'))
  if (model.has_response_node) {
    L.push(t('mdReturnResp', { code: model.status_code }))
    if (model.response_body) {
      L.push('```json', model.response_body, '```')
    } else {
      L.push(t('mdReturnNoBody'))
    }
    L.push(t('mdReturnTplNote'))
  } else {
    L.push(t('mdReturnNoResp'))
  }
  L.push('', t('mdTimeout', { sec: Math.round((model.timeout_ms || 30000) / 1000) }))
  return L.join('\n')
}

// 复制按钮：点击把文本写入剪贴板，短暂显示「已复制」。
export function CopyButton({ text }: { text: string }) {
  const t = useTranslations('wfDoc')
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.preventDefault()
        e.stopPropagation()
        const ok = await copyTextToClipboard(text)
        if (!ok) return
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      }}
      className="text-xs px-2 py-0.5 rounded border border-gray-300 text-gray-500 hover:bg-gray-100 shrink-0"
    >
      {copied ? t('copied') : t('copy')}
    </button>
  )
}

// 「复制全部」按钮：把整份内容拼成 Markdown 一次性复制，便于整段喂给 AI（替代分块复制）。
export function CopyMarkdownButton({ text }: { text: string }) {
  const t = useTranslations('wfDoc')
  const [copied, setCopied] = useState(false)
  return (
    <button
      data-alt="copy-all-markdown"
      onClick={() => { navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800) }) }}
      title={t('copyAllTitle')}
      className="px-3 py-1.5 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium inline-flex items-center gap-1.5 shrink-0"
    >
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
      {copied ? t('copiedAll') : t('copyAll')}
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
  const t = useTranslations('wfDoc')
  const isEndpoint = model.trigger_type === 'endpoint'
  const cfg = model.trigger_config
  const url = useMemo(() => endpointUrl(model, apiBase), [model, apiBase])
  const curl = useMemo(() => curlExample(url, model.input_fields, gatewayMode), [url, model.input_fields, gatewayMode])
  const purpose = useMemo(() => resolveDocPurpose(model, t), [model, t])
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
              <h4 className="font-semibold text-gray-900">{t('purposeH')}</h4>
              <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-indigo-600 ring-1 ring-indigo-100">
                {purpose.source === 'description' ? t('fromDesc') : t('autoOrganized')}
              </span>
            </div>
            <p className="text-sm leading-6 text-gray-700">{purpose.text}</p>
          </div>
        </div>
      </section>

      {/* 调用方式 */}
      <section>
        <h4 className="font-semibold text-gray-900 mb-2">{t('callH')}</h4>
        {isEndpoint ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="px-2 py-0.5 rounded bg-green-100 text-green-700 text-xs font-mono font-semibold">POST</span>
              <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-700 text-xs font-mono font-semibold">GET</span>
              <code className="text-xs bg-gray-100 px-2 py-1 rounded font-mono break-all flex-1 min-w-0">{url}</code>
              <CopyButton text={url} />
            </div>
            <p className="text-xs text-gray-500 leading-relaxed">
              {t.rich('callEndpointDesc', { field: triggerFields[0]?.field || 'key', b: (c) => <strong>{c}</strong>, code: (c) => <code className="bg-gray-100 px-1 rounded">{c}</code> })}
            </p>
          </div>
        ) : model.trigger_type === 'hook' ? (
          <p className="text-xs text-gray-600 leading-relaxed">
            {t.rich('hookDesc', { res: `${(cfg.schema as string) || 'public'}.${(cfg.table as string) || '<table>'}`, b: (c) => <strong>{c}</strong>, code: (c) => <code className="bg-gray-100 px-1 rounded">{c}</code> })}
          </p>
        ) : model.trigger_type === 'notify' ? (
          <p className="text-xs text-gray-600 leading-relaxed">
            {t.rich('notifyDesc', { channel: (cfg.channel as string) || '<channel>', b: (c) => <strong>{c}</strong>, code: (c) => <code className="bg-gray-100 px-1 rounded">{c}</code> })}
          </p>
        ) : model.trigger_type === 'cron' ? (
          <p className="text-xs text-gray-600 leading-relaxed">
            {t.rich('cronDesc', { cron: (cfg.cron as string) || (cfg.schedule as string) || '<cron>', b: (c) => <strong>{c}</strong> })}
          </p>
        ) : model.trigger_type === 'kafka' ? (
          <p className="text-xs text-gray-600 leading-relaxed">
            {t.rich('kafkaDesc', { topic: (cfg.topic as string) || '<topic>', fmt: (cfg.value_format as string) || 'json', b: (c) => <strong>{c}</strong>, code: (c) => <code className="bg-gray-100 px-1 rounded">{c}</code> })}
          </p>
        ) : (
          <p className="text-xs text-gray-600 leading-relaxed">
            {t.rich('manualDesc', { b: (c) => <strong>{c}</strong>, code: (c) => <code className="bg-gray-100 px-1 rounded">{c}</code> })}
          </p>
        )}
      </section>

      {/* 鉴权 */}
      {isEndpoint && (
        <section>
          <h4 className="font-semibold text-gray-900 mb-2">{t('authH')}</h4>
          {gatewayMode ? (
            <p className="text-xs text-gray-600 leading-relaxed">
              {t('authGateway')}
            </p>
          ) : (
            <>
              <p className="text-xs text-gray-600 leading-relaxed mb-1.5">{t('authPick')}</p>
              <ul className="space-y-1 text-xs text-gray-600 list-disc pl-5">
                <li>{t.rich('authApiKeyLi', { b: (c) => <strong>{c}</strong>, code: (c) => <code className="bg-gray-100 px-1 rounded">{c}</code> })}</li>
                <li>{t.rich('authJwtLi', { b: (c) => <strong>{c}</strong>, code: (c) => <code className="bg-gray-100 px-1 rounded">{c}</code> })}</li>
              </ul>
            </>
          )}
        </section>
      )}

      {/* 请求参数 */}
      <section>
        <h4 className="font-semibold text-gray-900 mb-2">{t('paramsH')}</h4>
        {triggerFields.length === 0 ? (
          <p className="text-xs text-gray-500">{emptyInputCopy(model.input_source, t)}</p>
        ) : model.input_source === 'schema' ? (
          <>
            <p className="text-xs text-gray-500 mb-2">{t('paramsSchemaHint')}</p>
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="text-left px-3 py-1.5 font-medium">{t('thField')}</th>
                    <th className="text-left px-3 py-1.5 font-medium">{t('thType')}</th>
                    <th className="text-left px-3 py-1.5 font-medium">{t('thRequired')}</th>
                    <th className="text-left px-3 py-1.5 font-medium">{t('thDesc')}</th>
                  </tr>
                </thead>
                <tbody>
                  {triggerFields.map((f) => (
                    <tr key={f.field} className="border-t">
                      <td className="px-3 py-1.5 font-mono text-gray-700">{f.field}</td>
                      <td className="px-3 py-1.5 font-mono text-gray-500">{f.type || '—'}</td>
                      <td className="px-3 py-1.5 text-gray-600">{requiredLabel(f.required, t)}</td>
                      <td className="px-3 py-1.5 text-gray-600">{f.description || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-gray-500 mb-2">
              {t.rich('paramsScanHint', { tpl: '{{trigger.X}}', code: (c) => <code className="bg-gray-100 px-1 rounded">{c}</code> })}
            </p>
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="text-left px-3 py-1.5 font-medium">{t('thField')}</th>
                    <th className="text-left px-3 py-1.5 font-medium">{t('thTplRef')}</th>
                  </tr>
                </thead>
                <tbody>
                  {triggerFields.map((f) => (
                    <tr key={f.field} className="border-t">
                      <td className="px-3 py-1.5 font-mono text-gray-700">{f.field}</td>
                      <td className="px-3 py-1.5 font-mono text-gray-400">{f.template}</td>
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
            <h4 className="font-semibold text-gray-900">{t('exampleH')}</h4>
            <CopyButton text={curl} />
          </div>
          <pre className="bg-gray-900 text-gray-100 text-xs rounded-lg p-3 overflow-auto font-mono leading-relaxed">{curl}</pre>
        </section>
      )}

      {/* 返回值 */}
      <section>
        <h4 className="font-semibold text-gray-900 mb-2">{t('returnH')}</h4>
        {model.has_response_node ? (
          <div className="space-y-2">
            <p className="text-xs text-gray-500">
              {t.rich('returnRespDesc', { code: model.status_code, c: (c) => <code className="bg-gray-100 px-1 rounded">{c}</code> })}
            </p>
            {model.response_body ? (
              <pre className="bg-gray-50 border text-xs rounded-lg p-3 overflow-auto font-mono leading-relaxed max-h-56">{model.response_body}</pre>
            ) : (
              <p className="text-xs text-gray-400">{t.rich('returnNoBody', { obj: '{ "ok": true }', code: (c) => <code className="bg-gray-100 px-1 rounded">{c}</code> })}</p>
            )}
            <p className="text-xs text-gray-400">{t.rich('returnTplNote', { tpl: '{{...}}', code: (c) => <code className="bg-gray-100 px-1 rounded">{c}</code> })}</p>
          </div>
        ) : (
          <p className="text-xs text-gray-500 leading-relaxed">
            {t.rich('returnNoResp', { b: (c) => <strong>{c}</strong>, code: (c) => <code className="bg-gray-100 px-1 rounded">{c}</code> })}
          </p>
        )}
      </section>

      {/* 其他 */}
      <section className="text-xs text-gray-400 leading-relaxed border-t pt-3">
        {t('timeoutLine', { sec: Math.round((model.timeout_ms || 30000) / 1000) })}
      </section>

      {/* 通用速查（折叠） */}
      <details className="text-xs">
        <summary className="cursor-pointer text-gray-500 hover:text-gray-700 font-medium">{t('cheatSummary')}</summary>
        <div className="mt-2 space-y-2 text-gray-600">
          <p>{t.rich('cheatTpl', { a: '{{trigger.field}}', b: '{{nodeId.field}}', c: '{{q.rows[0].id}}', c1: (c) => <code className="bg-gray-100 px-1 rounded">{c}</code>, c2: (c) => <code className="bg-gray-100 px-1 rounded">{c}</code>, c3: (c) => <code className="bg-gray-100 px-1 rounded">{c}</code> })}</p>
          <ul className="list-disc pl-5 space-y-0.5">
            <li>{t.rich('cheatNodes1', { b: (c) => <strong>{c}</strong> })}</li>
            <li>{t.rich('cheatNodes2', { b: (c) => <strong>{c}</strong> })}</li>
            <li>{t.rich('cheatNodes3', { b: (c) => <strong>{c}</strong> })}</li>
            <li>{t.rich('cheatNodes4', { b: (c) => <strong>{c}</strong> })}</li>
          </ul>
        </div>
      </details>
    </div>
  )
}
