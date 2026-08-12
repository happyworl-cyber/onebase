'use client'

/**
 * 项目 REST / RPC / DDL 接口文档的只读渲染器。
 *
 * 用 `buildRestApiDoc` 生成的模板渲染（占位 `{table}` / `{function}`），公开分享页
 * `app/doc/api/[token]` 使用；登录态页面自己有更丰富的两 tab UI（含真实表下拉），
 * 但两者共用 `restApiDoc.ts` 的模板，保证内容一致。
 */

import { useMemo, useState } from 'react'
import {
  buildRestApiDoc,
  type DocEndpoint,
  type DocEndpointColor,
} from '@/components/api/restApiDoc'

function useCopy() {
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const copy = (text: string, key: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedKey(key)
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500)
    })
  }
  return { copiedKey, copy }
}

function EndpointCard({
  ep,
  cardKey,
  copiedKey,
  onCopy,
}: {
  ep: DocEndpoint
  cardKey: string
  copiedKey: string | null
  onCopy: (text: string, key: string) => void
}) {
  const headerBg: Record<DocEndpointColor, string> = {
    green: 'bg-green-50',
    blue: 'bg-blue-50',
    yellow: 'bg-yellow-50',
    red: 'bg-red-50',
    purple: 'bg-purple-50',
  }
  const badgeBg: Record<DocEndpointColor, string> = {
    green: 'bg-green-500',
    blue: 'bg-blue-500',
    yellow: 'bg-yellow-500',
    red: 'bg-red-500',
    purple: 'bg-purple-600',
  }
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
      <div className={`px-4 py-3 ${headerBg[ep.color]} border-b border-gray-200 flex items-center justify-between`}>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <span className={`px-2 py-1 ${badgeBg[ep.color]} text-white text-xs font-bold rounded`}>{ep.method}</span>
          <span className="font-mono text-sm break-all">{ep.path}</span>
          <span className="text-gray-500 text-sm">{ep.desc}</span>
        </div>
        <button
          type="button"
          onClick={() => onCopy(ep.body, cardKey)}
          className="text-gray-400 hover:text-gray-600 text-xs shrink-0 p-1"
          title="复制示例"
        >
          {copiedKey === cardKey ? '已复制' : <i className="fas fa-copy"></i>}
        </button>
      </div>
      <pre className="p-4 bg-gray-900 text-gray-100 font-mono text-sm overflow-x-auto">{ep.body}</pre>
    </div>
  )
}

const QUERY_PARAMS: { param: string; desc: string; example: string }[] = [
  { param: 'select', desc: '选择返回的字段', example: '?select=id,name,email' },
  { param: 'order', desc: '排序字段和方向', example: '?order=created_at.desc' },
  { param: 'limit', desc: '返回记录数量（最大 1000）', example: '?limit=20' },
  { param: 'offset', desc: '跳过记录数量（分页）', example: '?offset=20' },
  { param: 'field.eq', desc: '等于过滤', example: '?status.eq=active' },
  { param: 'field.neq', desc: '不等于过滤', example: '?status.neq=deleted' },
  { param: 'field.gt/gte', desc: '大于/大于等于', example: '?age.gte=18' },
  { param: 'field.lt/lte', desc: '小于/小于等于', example: '?price.lt=100' },
  { param: 'field.like', desc: '模糊匹配（区分大小写）', example: '?name.like=%john%' },
  { param: 'field.ilike', desc: '模糊匹配（不区分大小写）', example: '?name.ilike=%john%' },
  { param: 'field.in', desc: '集合匹配（IN，逗号分隔多个值）', example: '?status.in=active,pending' },
  { param: 'count', desc: '总行数（COUNT(*)），返回字段名 count', example: '?select=count' },
  { param: 'field.聚合', desc: '聚合 count/sum/avg/min/max，返回字段名 字段_函数', example: '?select=amount.sum,amount.avg' },
  { param: '分组聚合', desc: 'select 里同时带普通列与聚合，普通列自动 GROUP BY', example: '?select=status,count' },
]

export default function RestApiDocContent({
  apiBaseUrl,
  databaseSlug,
  schema,
  gatewayMode = false,
}: {
  apiBaseUrl: string
  databaseSlug: string
  schema: string
  gatewayMode?: boolean
}) {
  const doc = useMemo(
    () => buildRestApiDoc({ apiBaseUrl, databaseSlug, schema, gatewayMode }),
    [apiBaseUrl, databaseSlug, schema, gatewayMode],
  )
  const { copiedKey, copy } = useCopy()

  return (
    <div className="space-y-6">
      {/* 端点与鉴权概要 */}
      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-xl p-6 border border-blue-100">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">
          <i className="fas fa-plug mr-2 text-blue-500"></i>
          API 端点
        </h2>
        <p className="text-sm text-gray-500 mb-4">
          项目标识 <code className="bg-white px-1 rounded">{databaseSlug}</code> + Schema{' '}
          <code className="bg-white px-1 rounded">{schema}</code> 的统一访问入口
        </p>
        <div className="space-y-3 text-sm font-mono">
          <div className="bg-white rounded-lg p-3 break-all">
            <div className="text-xs text-gray-500 mb-1">数据表 REST</div>
            {doc.endpointBase}/<span className="text-blue-600">{'{table}'}</span>
          </div>
          <div className="bg-white rounded-lg p-3 break-all">
            <div className="text-xs text-gray-500 mb-1">Raw DDL（直接 SQL）</div>
            {doc.sqlEndpoint}
          </div>
          <div className="bg-white rounded-lg p-3 break-all">
            <div className="text-xs text-gray-500 mb-1">表结构 DDL（结构化）</div>
            {doc.ddlEndpointRoot}
          </div>
          <div className="bg-white rounded-lg p-3 break-all">
            <div className="text-xs text-gray-500 mb-1">RPC（存储过程 / 函数）</div>
            {doc.rpcEndpointRoot}/<span className="text-purple-600">{'{function}'}</span>
          </div>
        </div>
        {gatewayMode ? (
          <p className="text-sm text-gray-600 mt-4 leading-relaxed">
            <i className="fas fa-key mr-1.5 text-amber-600"></i>
            请求经网关统一鉴权，无需在调用侧携带 API Key。
          </p>
        ) : (
          <p className="text-sm text-gray-600 mt-4 leading-relaxed">
            <i className="fas fa-key mr-1.5 text-amber-600"></i>
            所有请求需带 <span className="font-mono text-xs">Authorization: Bearer YOUR_API_KEY</span>
            （API Key 以 <span className="font-mono text-xs">ob_</span> 开头；也支持{' '}
            <span className="font-mono text-xs">apikey: ob_…</span> 头）。RPC 需 API Key scope 含{' '}
            <span className="font-mono text-xs">EXECUTE</span>；DDL 需 <span className="font-mono text-xs">DDL</span> 或{' '}
            <span className="font-mono text-xs">ALL</span>。
          </p>
        )}
      </div>

      {/* 数据表 REST */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <i className="fas fa-table text-blue-500"></i>
            数据表 REST
            <span className="font-mono font-normal text-gray-400 text-xs break-all">{doc.endpointBase}/{'{table}'}</span>
          </h2>
          <button
            type="button"
            onClick={() => copy(doc.fullDocText, 'full')}
            className="px-3 py-1.5 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium inline-flex items-center gap-1.5 shrink-0"
            title="复制全部接口文档（Markdown），可粘贴给 AI"
          >
            <i className="fas fa-copy"></i>
            {copiedKey === 'full' ? '已复制 ✓' : '复制全部（给 AI）'}
          </button>
        </div>
        <p className="text-xs text-gray-500">把 <code className="bg-gray-100 px-1 rounded">{'{table}'}</code> 换成实际表名。</p>
        {doc.genericTableEndpoints.map((ep, idx) => (
          <EndpointCard key={`gt-${idx}`} ep={ep} cardKey={`gt-${idx}`} copiedKey={copiedKey} onCopy={copy} />
        ))}
      </div>

      {/* 表结构 DDL */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
        <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
          <i className="fas fa-hammer text-amber-600"></i>
          表结构 DDL
          <span className="font-mono font-normal text-gray-400 text-xs break-all">{doc.ddlEndpointRoot}</span>
        </h2>
        <p className="text-xs text-gray-500">
          建表 / 改表 / 删表，请求体为结构化 JSON（非 raw SQL）。API Key scope 须含{' '}
          <span className="font-mono">DDL</span> 或 <span className="font-mono">ALL</span>，Resources 允许目标 schema（如{' '}
          <span className="font-mono">{schema}.*</span>）。
        </p>
        {doc.genericDdlEndpoints.map((ep, idx) => (
          <EndpointCard key={`gd-${idx}`} ep={ep} cardKey={`gd-${idx}`} copiedKey={copiedKey} onCopy={copy} />
        ))}
      </div>

      {/* Raw DDL */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
        <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
          <i className="fas fa-code text-amber-700"></i>
          Raw DDL（直接 SQL）
          <span className="font-mono font-normal text-gray-400 text-xs break-all">{doc.sqlEndpoint}</span>
        </h2>
        <p className="text-xs text-gray-500">
          仅允许 <span className="font-mono">CREATE / ALTER / DROP / COMMENT</span>；必须设{' '}
          <span className="font-mono">acknowledge_destructive: true</span>。
        </p>
        {doc.genericRawDdlEndpoints.map((ep, idx) => (
          <EndpointCard key={`grd-${idx}`} ep={ep} cardKey={`grd-${idx}`} copiedKey={copiedKey} onCopy={copy} />
        ))}
      </div>

      {/* RPC */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
        <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
          <i className="fas fa-terminal text-purple-600"></i>
          RPC（存储过程 / 函数）
          <span className="font-mono font-normal text-gray-400 text-xs break-all">{doc.rpcEndpointRoot}/{'{function}'}</span>
        </h2>
        <p className="text-xs text-gray-500">
          把 <code className="bg-gray-100 px-1 rounded">{'{function}'}</code> 换成实际函数名。
          <span className="font-mono">POST</span> 用 JSON body 按形参名传参；<span className="font-mono">GET</span> 用 Query（每个值先按 JSON 解析）。
          {schema !== 'public' && (
            <> 非 public 的函数需加 <span className="font-mono">Content-Profile / Accept-Profile: {schema}</span> 头。</>
          )}
        </p>
        {doc.genericRpcEndpoints.map((ep, idx) => (
          <EndpointCard key={`gr-${idx}`} ep={ep} cardKey={`gr-${idx}`} copiedKey={copiedKey} onCopy={copy} />
        ))}
      </div>

      {/* 查询参数 */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">查询参数（仅数据表 REST）</h2>
          <p className="text-sm text-gray-500">下列参数仅适用于「数据表 REST」的 GET 列表接口，不用于 RPC</p>
        </div>
        <div className="p-6 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b border-gray-200">
                <th className="pb-3 font-medium text-gray-700">参数</th>
                <th className="pb-3 font-medium text-gray-700">说明</th>
                <th className="pb-3 font-medium text-gray-700">示例</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {QUERY_PARAMS.map((q) => (
                <tr key={q.param}>
                  <td className="py-3 font-mono text-blue-600 whitespace-nowrap align-top">{q.param}</td>
                  <td className="py-3 text-gray-600">{q.desc}</td>
                  <td className="py-3 font-mono text-gray-500 whitespace-nowrap">{q.example}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
