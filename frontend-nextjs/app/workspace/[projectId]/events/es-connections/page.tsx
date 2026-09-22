'use client'

/**
 * `/workspace/[projectId]/events/es-connections` — 项目维度的 Elasticsearch
 * 反向代理管理（W2，原 /dashboard/es-connections）。
 *
 * 视图分两层：
 *   1. **连接列表**（左 / 上）：当前项目的所有 ES 集群配置
 *   2. **连接详情**（右 / 下）：编辑连接 + 管理代理 token + 业务端接入指南
 *
 * 安全要点：
 *   - 凭据明文（ApiKey / basic 密码）**仅在创建/更新表单提交瞬间**经过前端
 *   - 代理 token 明文（obes_es_xxx）**只在创建成功一次性弹窗**显示
 *   - "接入指南"动态生成当前 origin 下的代理 URL + curl / Python / Node 示例
 *
 * tenantId 来自 URL 的 projectId（W2：projectId === tenant.id）。注意 projectId
 * **不等于** database_id（tenants.id 与 tenant_databases.id 是独立序列）；本页只用
 * tenant 维度，不直接拿 projectId 当 database_id 用。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useParams } from 'next/navigation'
import {
  esAPI,
  type EsConnection,
  type EsAccessToken,
  type CreateEsConnectionInput,
  type UpdateEsConnectionInput,
  type CreateEsTokenInput,
} from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import { useNotification } from '@/hooks/useNotification'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'
import { closeOnBackdropPress } from '@/lib/utils'

export default function EsConnectionsPage() {
  const t = useTranslations('wsEsConn')
  const tc = useTranslations('connCommon')
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const caps = useCurrentProjectCapabilities()

  if (!caps.canManageEvents) {
    return (
      <ForbiddenPlaceholder reason={t('forbidden')} />
    )
  }

  if (isNaN(projectId) || projectId <= 0) {
    // 不正常的 projectId；layout 一般会先一步兜底跳走，这里只是渲染期防御
    return (
      <div className="text-center py-12 text-gray-400">
        <i className="fas fa-spinner fa-spin text-2xl"></i>
        <p className="text-sm mt-2">{tc('loadingCtx')}</p>
      </div>
    )
  }

  return <EsConnectionsManager tenantId={projectId} />
}

// ── 内部组件 ──────────────────────────────────────────────────────────

function EsConnectionsManager({ tenantId }: { tenantId: number }) {
  const t = useTranslations('wsEsConn')
  const tc = useTranslations('connCommon')
  const notify = useNotification()
  const [connections, setConnections] = useState<EsConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [activeId, setActiveId] = useState<number | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const loadConnections = useCallback(async () => {
    setLoading(true)
    try {
      const res = await esAPI.listConnections(tenantId)
      const rows = res.data.filter((c) => c.tenant_id === tenantId)
      setConnections(rows)
      // 首次进入或当前选中已被删 → 自动选第一个
      if (rows.length > 0) {
        setActiveId((prev) =>
          prev !== null && rows.some((c) => c.id === prev) ? prev : rows[0].id,
        )
      } else {
        setActiveId(null)
      }
    } catch {
      // 全局拦截器已弹错误
    } finally {
      setLoading(false)
    }
  }, [tenantId])

  useEffect(() => {
    loadConnections()
  }, [loadConnections])

  const activeConnection = useMemo(
    () => connections.find((c) => c.id === activeId) ?? null,
    [connections, activeId],
  )

  return (
    <div className="space-y-4">
      {/* 顶栏 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">
            <i className="fas fa-search-plus mr-2 text-blue-600"></i>
            {t('title')}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {t('subtitle')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="btn-primary"
        >
          <i className="fas fa-plus mr-2"></i>{t('newConn')}
        </button>
      </div>

      {/* 左右分栏：列表 + 详情 */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
        <div className="md:col-span-4 space-y-2">
          {loading ? (
            <div className="text-center py-8 text-gray-400">
              <i className="fas fa-spinner fa-spin"></i>
            </div>
          ) : connections.length === 0 ? (
            <div className="text-center py-12 bg-gray-50 border border-dashed border-gray-300 rounded">
              <i className="fas fa-search text-3xl text-gray-300 mb-2"></i>
              <p className="text-sm text-gray-500">{t('empty')}</p>
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="mt-3 text-sm text-blue-600 hover:underline"
              >
                {t('createFirst')}
              </button>
            </div>
          ) : (
            connections.map((c) => (
              <ConnectionListItem
                key={c.id}
                connection={c}
                active={c.id === activeId}
                onClick={() => setActiveId(c.id)}
              />
            ))
          )}
        </div>

        <div className="md:col-span-8">
          {activeConnection ? (
            <ConnectionDetail
              key={activeConnection.id}
              connection={activeConnection}
              onChanged={loadConnections}
              onDeleted={loadConnections}
            />
          ) : (
            <div className="bg-gray-50 border border-dashed border-gray-300 rounded p-12 text-center text-sm text-gray-400">
              {t('selectOrNew')}
            </div>
          )}
        </div>
      </div>

      {showCreate && (
        <CreateConnectionDialog
          tenantId={tenantId}
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false)
            setActiveId(id)
            loadConnections()
            notify.success(t('created'))
          }}
        />
      )}
    </div>
  )
}

// ── 连接列表项 ────────────────────────────────────────────────────────

function ConnectionListItem({
  connection,
  active,
  onClick,
}: {
  connection: EsConnection
  active: boolean
  onClick: () => void
}) {
  const t = useTranslations('wsEsConn')
  const tc = useTranslations('connCommon')
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left p-3 rounded border transition ${
        active
          ? 'bg-blue-50 border-blue-400'
          : 'bg-white border-gray-200 hover:bg-gray-50'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="font-medium text-sm truncate">{connection.connection_name}</div>
        {!connection.is_active && (
          <span className="text-xs bg-gray-200 text-gray-700 px-1.5 py-0.5 rounded">
            {tc('disabled')}
          </span>
        )}
      </div>
      <div className="text-xs text-gray-500 mt-1 truncate font-mono">
        {connection.base_url}
      </div>
      <div className="flex items-center text-xs text-gray-400 mt-1 space-x-2">
        <span>
          <i className="fas fa-key mr-1"></i>
          {connection.auth_type}
        </span>
        {!connection.verify_tls && (
          <span className="text-amber-600" title={t('tlsUnverified')}>
            <i className="fas fa-shield-alt"></i> TLS off
          </span>
        )}
      </div>
    </button>
  )
}

// ── 连接详情 ──────────────────────────────────────────────────────────

function ConnectionDetail({
  connection,
  onChanged,
  onDeleted,
}: {
  connection: EsConnection
  onChanged: () => void
  onDeleted: () => void
}) {
  const tr = useTranslations('wsEsConn')
  const tc = useTranslations('connCommon')
  const notify = useNotification()
  const [tab, setTab] = useState<'usage' | 'tokens' | 'settings'>('usage')

  const handleDelete = async () => {
    if (
      !window.confirm(
        tr('confirmDelete', { name: connection.connection_name }),
      )
    )
      return
    try {
      await esAPI.deleteConnection(connection.id)
      notify.success(tr('deleted'))
      onDeleted()
    } catch {
      // 全局拦截器已弹错误
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded shadow-sm">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div>
          <div className="font-semibold">{connection.connection_name}</div>
          <div className="text-xs text-gray-500 font-mono mt-0.5">{connection.base_url}</div>
        </div>
        <button
          type="button"
          onClick={handleDelete}
          className="text-sm text-red-600 hover:text-red-700"
          title={tr('deleteTitle')}
        >
          <i className="fas fa-trash"></i>
        </button>
      </div>

      <div className="border-b flex text-sm">
        {[
          { id: 'usage', label: tr('tabUsage'), icon: 'fa-book' },
          { id: 'tokens', label: tr('tabTokens'), icon: 'fa-key' },
          { id: 'settings', label: tr('tabSettings'), icon: 'fa-cog' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id as typeof tab)}
            className={`px-4 py-2 -mb-px border-b-2 ${
              tab === t.id
                ? 'border-blue-500 text-blue-600 font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <i className={`fas ${t.icon} mr-1.5`}></i>
            {t.label}
          </button>
        ))}
      </div>

      <div className="p-4">
        {tab === 'usage' && <UsageTab connection={connection} />}
        {tab === 'tokens' && (
          <TokensTab connectionId={connection.id} />
        )}
        {tab === 'settings' && (
          <SettingsTab connection={connection} onUpdated={onChanged} />
        )}
      </div>
    </div>
  )
}

// ── 接入指南 ──────────────────────────────────────────────────────────

function UsageTab({ connection }: { connection: EsConnection }) {
  const t = useTranslations('wsEsConn')
  const tc = useTranslations('connCommon')
  const notify = useNotification()
  const { currentConnection, currentProject } = useAppStore()
  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'https://platform.example.com'
  const databaseSlug =
    currentConnection?.database_slug ||
    currentProject?.slug ||
    currentProject?.name ||
    null
  const proxyBase = databaseSlug
    ? `${origin}/api/v1/${encodeURIComponent(databaseSlug)}/es`
    : `${origin}/api/es`
  const appBase = databaseSlug
    ? `${origin}/api/v1/${encodeURIComponent(databaseSlug)}/es-app`
    : `${origin}/api/es-app`

  const [mode, setMode] = useState<'app' | 'proxy'>('app')

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      notify.success(t('copied', { label }))
    } catch {
      notify.error(t('copyFail'))
    }
  }

  return (
    <div className="space-y-4 text-sm">
      <div className="bg-blue-50 border border-blue-200 text-blue-900 rounded p-3 space-y-1.5 text-xs">
        <div className="font-semibold">
          <i className="fas fa-lightbulb mr-1"></i>{t('twoModes')}
        </div>
        {!databaseSlug && (
          <p className="text-amber-800">
            {t('twoModesIntro')}
            <code className="bg-white px-1 rounded">/api/v1/&#123;slug&#125;/es-app</code>）。
          </p>
        )}
        <ul className="list-disc list-inside space-y-0.5">
          <li>
            {t.rich('appApiRich', { code: (c: any) => <code className="bg-white px-1 rounded">{c}</code>, b: (c: any) => <strong>{c}</strong> })}。
          </li>
          <li>
            {t.rich('nativeRich', { code: (c: any) => <code className="bg-white px-1 rounded">{c}</code>, b: (c: any) => <strong>{c}</strong> })}
          </li>
          <li>
            {t.rich('sharedTokenRich', { code: (c: any) => <code className="bg-white px-1 rounded">{c}</code>, b: (c: any) => <strong>{c}</strong> })}
          </li>
        </ul>
      </div>

      <div className="inline-flex rounded border border-gray-300 overflow-hidden text-xs">
        <button
          type="button"
          onClick={() => setMode('app')}
          className={`px-3 py-1.5 ${mode === 'app' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
        >
          {t('appApiTab')}
        </button>
        <button
          type="button"
          onClick={() => setMode('proxy')}
          className={`px-3 py-1.5 ${mode === 'proxy' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
        >
          {t('nativeTab')}
        </button>
      </div>

      {mode === 'app' ? (
        <AppApiGuide base={appBase} copy={copy} />
      ) : (
        <ProxyGuide base={proxyBase} copy={copy} />
      )}

      <div className="text-xs text-gray-500 pt-2 border-t">
        {t.rich(connection.verify_tls ? 'timeoutTlsOn' : 'timeoutTlsOff', { b: (c: any) => <strong>{c}</strong>, amber: (c: any) => <span className="text-amber-600 font-semibold">{c}</span>, secs: connection.default_timeout_secs })}
      </div>
    </div>
  )
}

// ── 应用 API 指南：业务无需 ES SDK / DSL ───────────────────────────────

function AppApiGuide({
  base,
  copy,
}: {
  base: string
  copy: (text: string, label: string) => void
}) {
  const t = useTranslations('wsEsConn')
  const tc = useTranslations('connCommon')
  const createDoc = `# Create a document (auto id; put "_id" in the body to upsert by a specific id)
curl -X POST "${base}/orders/docs" \\
  -H "Authorization: ApiKey obes_es_<your_token>" \\
  -H "Content-Type: application/json" \\
  -d '{"order_id":"ORD-1001","amount":199.9,"status":"paid"}'`

  const getDoc = `# Get by id (returns 404 + {"found": false} if not found)
curl "${base}/orders/docs/ORD-1001" \\
  -H "Authorization: ApiKey obes_es_<your_token>"`

  const patchDoc = `# Partial update (bare fields = syntactic sugar for {"doc": {...}})
curl -X PATCH "${base}/orders/docs/ORD-1001" \\
  -H "Authorization: ApiKey obes_es_<your_token>" \\
  -H "Content-Type: application/json" \\
  -d '{"status":"refunded"}'`

  const deleteDoc = `curl -X DELETE "${base}/orders/docs/ORD-1001" \\
  -H "Authorization: ApiKey obes_es_<your_token>"`

  const searchDoc = `# Search: flat where + q + sort + page/size + select
curl -X POST "${base}/orders/search" \\
  -H "Authorization: ApiKey obes_es_<your_token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "where": {
      "status": "paid",
      "amount": {"gte": 10, "lte": 500},
      "tags":   {"in": ["promo", "vip"]},
      "remark": {"contains": "first order"},
      "name":   {"wildcard": {"value": "*iphone*", "case_insensitive": true, "rewrite": "constant_score"}},
      "deleted_at": {"exists": false}
    },
    "q": "urgent OR rush",
    "q_fields": ["remark", "title"],
    "sort":   [{"field": "created_at", "order": "desc"}],
    "page": 1, "size": 20,
    "select": ["order_id","amount","status"]
  }'

# Response (hits.hits nesting removed):
# {"total":123,"page":1,"size":20,"took_ms":12,"data":[{"_id":"...","order_id":"..."}]}`

  const aggregateDoc = `# terms aggregation: filter by where first, then bucket by field
curl -X POST "${base}/articles/search" \\
  -H "Authorization: ApiKey obes_es_<your_token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "where": {"article_type": 0, "delete_status": 0},
    "size": 0,
    "aggs": {
      "topic_counts": {
        "terms": {"field": "topics", "size": 10000}
      }
    }
  }'

# Response:
# {"total":123,"size":0,"data":[],"aggregations":{"topic_counts":{"buckets":[{"key":"AI","doc_count":42}]}}}

# composite aggregation: fully traverse high-cardinality fields; omit after on the first page
curl -X POST "${base}/articles/search" \\
  -H "Authorization: ApiKey obes_es_<your_token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "where": {"article_type": 0, "delete_status": 0},
    "size": 0,
    "aggs": {
      "topic_counts": {
        "composite": {
          "size": 1000,
          "sources": [
            {"topic": {"terms": {"field": "topics"}}}
          ]
        }
      }
    }
  }'

# For the next page, put the previous response's after_key verbatim into composite.after:
# "after": {"topic": "last value of previous page"}`

  const bulkDoc = `# Bulk: up to 1000 per call; results match the order of operations
curl -X POST "${base}/orders/bulk" \\
  -H "Authorization: ApiKey obes_es_<your_token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "operations": [
      {"action":"index",  "id":"1", "doc":{"name":"A"}},
      {"action":"update", "id":"1", "doc":{"name":"A2"}, "upsert": true},
      {"action":"delete", "id":"old-9"}
    ]
  }'`

  const initIndex = `# Simplified index creation: give a field-type dict directly; shards/replicas are aliases for ES number_of_*
curl -X POST "${base}/orders/_init" \\
  -H "Authorization: ApiKey obes_es_<your_token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "if_not_exists": true,
    "settings": {"shards": 1, "replicas": 1},
    "fields": {
      "order_id":   {"type": "keyword"},
      "amount":     {"type": "double"},
      "status":     {"type": "keyword"},
      "created_at": {"type": "date"},
      "remark":     {"type": "text"}
    }
  }'`

  const pythonExample = `# No elasticsearch SDK needed; standard requests works
import requests

BASE = "${base}"
HEADERS = {"Authorization": "ApiKey obes_es_<your_token>"}

# Create
r = requests.post(f"{BASE}/orders/docs", json={
    "order_id": "ORD-1001", "amount": 199.9, "status": "paid",
}, headers=HEADERS)
print(r.json())

# Search
r = requests.post(f"{BASE}/orders/search", json={
    "where": {"status": "paid", "amount": {"gte": 100}},
    "sort":  [{"field": "created_at", "order": "desc"}],
    "page": 1, "size": 20,
}, headers=HEADERS)
print(r.json()["data"])

# Partial update
requests.patch(f"{BASE}/orders/docs/ORD-1001",
    json={"status": "refunded"}, headers=HEADERS)`

  const nodeExample = `// No @elastic/elasticsearch needed; use fetch / axios
const BASE = '${base}'
const headers = {
  'Authorization': 'ApiKey obes_es_<your_token>',
  'Content-Type': 'application/json',
}

// 搜索
const r = await fetch(\`\${BASE}/orders/search\`, {
  method: 'POST', headers,
  body: JSON.stringify({
    where: { status: 'paid', amount: { gte: 100 } },
    sort:  [{ field: 'created_at', order: 'desc' }],
    page: 1, size: 20,
  }),
})
const { total, data } = await r.json()
console.log(total, data)`

  return (
    <div className="space-y-3">
      <div className="bg-gray-50 border border-gray-200 rounded p-3 text-xs text-gray-700 space-y-1">
        <div className="font-semibold">
          <i className="fas fa-cube mr-1"></i>{t('pathQuickRef')}<code>{base}</code>)
        </div>
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-0.5 list-disc list-inside">
          <li><code>POST /:index/docs</code> {t('opCreate')}</li>
          <li><code>GET /:index/docs/:id</code> {t('opRead')}</li>
          <li><code>PUT /:index/docs/:id</code> {t('opReplace')}</li>
          <li><code>PATCH /:index/docs/:id</code> {t('opPatch')}</li>
          <li><code>DELETE /:index/docs/:id</code> {t('opDelete')}</li>
          <li><code>POST /:index/search</code> {t('opSearch')}</li>
          <li><code>POST /:index/count</code> {t('opCount')}</li>
          <li><code>POST /:index/bulk</code> {t('opBulk')}</li>
          <li><code>POST /:index/_init</code> {t('opInit')}</li>
          <li><code>DELETE /:index</code> {t('opDropIndex')}</li>
          <li><code>GET /:index</code> mapping/settings</li>
          <li><code>GET /_indices</code> {t('opList')}</li>
        </ul>
      </div>

      <CodeBlock label={t('cbCreateDoc')} code={createDoc} onCopy={() => copy(createDoc, t('lblCreateDoc'))} />
      <CodeBlock label={t('cbReadDelete')} code={`${getDoc}\n\n${deleteDoc}`} onCopy={() => copy(`${getDoc}\n\n${deleteDoc}`, t('lblReadDelete'))} />
      <CodeBlock label={t('cbPatch')} code={patchDoc} onCopy={() => copy(patchDoc, t('lblPatch'))} />
      <CodeBlock label={t('cbSearch')} code={searchDoc} onCopy={() => copy(searchDoc, t('lblSearch'))} />
      <CodeBlock label={t('cbAgg')} code={aggregateDoc} onCopy={() => copy(aggregateDoc, t('lblAgg'))} />
      <CodeBlock label={t('cbBulk')} code={bulkDoc} onCopy={() => copy(bulkDoc, t('lblBulk'))} />
      <CodeBlock label={t('cbInit')} code={initIndex} onCopy={() => copy(initIndex, t('lblInit'))} />
      <CodeBlock label={t('cbPython')} code={pythonExample} onCopy={() => copy(pythonExample, t('lblPython'))} />
      <CodeBlock label={t('cbNode')} code={nodeExample} onCopy={() => copy(nodeExample, t('lblNode'))} />

      <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded p-2.5 text-xs space-y-1">
        <div className="font-semibold">
          <i className="fas fa-exclamation-triangle mr-1"></i>{t('whereOps')}
        </div>
        <p>
          <code>eq / ne / in / nin / gt / gte / lt / lte / contains / prefix / exists / wildcard</code>；
          {t.rich('whereOpsDetail1', { code: (c: any) => <code>{c}</code> })}
        </p>
        <p>
          {t.rich('whereOpsDetail2', { code: (c: any) => <code>{c}</code> })}
        </p>
      </div>
    </div>
  )
}

// ── 原生代理指南：保留给需要官方 SDK / scroll 等高级 ES 场景 ──────────

function ProxyGuide({
  base,
  copy,
}: {
  base: string
  copy: (text: string, label: string) => void
}) {
  const t = useTranslations('wsEsConn')
  const tc = useTranslations('connCommon')
  const curlExample = `curl -H "Authorization: ApiKey obes_es_<your_token>" \\
     ${base}/_cluster/health`

  const pythonExample = `# pip install elasticsearch
from elasticsearch import Elasticsearch

es = Elasticsearch(
    "${base}",
    api_key="obes_es_<your_token>",
)
print(es.info())`

  const nodeExample = `// npm i @elastic/elasticsearch
import { Client } from '@elastic/elasticsearch'

const es = new Client({
  node: '${base}',
  auth: { apiKey: 'obes_es_<your_token>' },
})
console.log(await es.info())`

  return (
    <div className="space-y-3">
      <div className="bg-gray-50 border border-gray-200 text-gray-700 rounded p-2.5 text-xs">
        <i className="fas fa-info-circle mr-1"></i>
        {t.rich('nativeIntroRich', { code: (c: any) => <code>{c}</code> })}
      </div>
      <CodeBlock label={t('aggProxyLbl')} code={base} onCopy={() => copy(base, t('aggProxyLbl'))} />
      <CodeBlock label={t('aggCurlLbl')} code={curlExample} onCopy={() => copy(curlExample, t('aggCurlLbl'))} />
      <CodeBlock label="Python (elasticsearch-py)" code={pythonExample} onCopy={() => copy(pythonExample, t('lblPython'))} />
      <CodeBlock label="Node.js (@elastic/elasticsearch)" code={nodeExample} onCopy={() => copy(nodeExample, t('lblNode'))} />
    </div>
  )
}

function CodeBlock({
  label,
  code,
  onCopy,
}: {
  label: string
  code: string
  onCopy: () => void
}) {
  const tc = useTranslations('connCommon')
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-gray-700">{label}</span>
        <button
          type="button"
          onClick={onCopy}
          className="text-xs text-blue-600 hover:underline"
        >
          <i className="fas fa-copy mr-1"></i>{tc('copy')}
        </button>
      </div>
      <pre className="bg-gray-900 text-gray-100 text-xs p-3 rounded overflow-x-auto whitespace-pre-wrap break-all">
        {code}
      </pre>
    </div>
  )
}

// ── Token 列表 ────────────────────────────────────────────────────────

function TokensTab({ connectionId }: { connectionId: number }) {
  const tr = useTranslations('wsEsConn')
  const tc = useTranslations('connCommon')
  const notify = useNotification()
  const [tokens, setTokens] = useState<EsAccessToken[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  // 创建成功后一次性显示的明文 token（关闭弹窗即从 state 移除）
  const [revealed, setRevealed] = useState<{ token: string; name: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await esAPI.listTokens(connectionId)
      setTokens(res.data)
    } catch {
      // 拦截器已弹
    } finally {
      setLoading(false)
    }
  }, [connectionId])

  useEffect(() => {
    load()
  }, [load])

  const toggleActive = async (t: EsAccessToken) => {
    try {
      await esAPI.updateToken(connectionId, t.id, { is_active: !t.is_active })
      notify.success(t.is_active ? tr('tokenDisabled') : tr('tokenEnabled'))
      load()
    } catch {
      /* noop */
    }
  }

  const remove = async (t: EsAccessToken) => {
    if (
      !window.confirm(
        tr('confirmDeleteToken', { name: t.name }),
      )
    )
      return
    try {
      await esAPI.deleteToken(connectionId, t.id)
      notify.success(tr('tokenDeleted'))
      load()
    } catch {
      /* noop */
    }
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <div className="text-gray-600 text-xs">
          {tr('tokensDesc')}
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="btn-primary text-xs"
        >
          <i className="fas fa-plus mr-1"></i>{tr('newToken')}
        </button>
      </div>

      {loading ? (
        <div className="text-center py-6 text-gray-400">
          <i className="fas fa-spinner fa-spin"></i>
        </div>
      ) : tokens.length === 0 ? (
        <div className="text-center py-8 text-gray-400 border border-dashed border-gray-300 rounded">
          {tr('noToken')}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-gray-500 border-b">
              <tr>
                <th className="py-2 px-2">{tr('colName')}</th>
                <th className="py-2 px-2">{tr('colPrefix')}</th>
                <th className="py-2 px-2">methods</th>
                <th className="py-2 px-2">indices</th>
                <th className="py-2 px-2">{tr('colUse')}</th>
                <th className="py-2 px-2">{tr('colStatus')}</th>
                <th className="py-2 px-2 text-right">{tr('colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id} className="border-b last:border-b-0">
                  <td className="py-2 px-2 font-medium">
                    {t.name}
                    {t.description && (
                      <div className="text-gray-400 font-normal mt-0.5">{t.description}</div>
                    )}
                  </td>
                  <td className="py-2 px-2 font-mono text-gray-500">
                    {t.token_prefix}…
                  </td>
                  <td className="py-2 px-2">
                    <span className="font-mono text-gray-700">
                      {t.allowed_methods.join(' / ')}
                    </span>
                  </td>
                  <td className="py-2 px-2 font-mono text-gray-700 max-w-[180px] truncate">
                    {t.index_allowlist.join(', ')}
                  </td>
                  <td className="py-2 px-2 text-gray-500">
                    {t.use_count > 0 ? tr('useCount', { n: t.use_count }) : '—'}
                    {t.last_used_at && (
                      <div className="text-gray-400 text-[10px]">
                        {new Date(t.last_used_at).toLocaleString()}
                      </div>
                    )}
                  </td>
                  <td className="py-2 px-2">
                    {t.is_active && !t.revoked_at ? (
                      <span className="bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded">
                        active
                      </span>
                    ) : (
                      <span className="bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded">
                        inactive
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-2 text-right space-x-2">
                    <button
                      type="button"
                      onClick={() => toggleActive(t)}
                      className="text-blue-600 hover:underline"
                    >
                      {t.is_active ? tr('disable') : tr('enable')}
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(t)}
                      className="text-red-600 hover:underline"
                    >
                      {tr('delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateTokenDialog
          connectionId={connectionId}
          onClose={() => setShowCreate(false)}
          onCreated={(plain, record) => {
            setShowCreate(false)
            setRevealed({ token: plain, name: record.name })
            load()
          }}
        />
      )}

      {revealed && (
        <RevealTokenDialog
          token={revealed.token}
          name={revealed.name}
          onClose={() => setRevealed(null)}
        />
      )}
    </div>
  )
}

// ── 设置（编辑连接） ──────────────────────────────────────────────────

function SettingsTab({
  connection,
  onUpdated,
}: {
  connection: EsConnection
  onUpdated: () => void
}) {
  const notify = useNotification()
  const t = useTranslations('wsEsConn')
  const tc = useTranslations('connCommon')
  const [form, setForm] = useState({
    connection_name: connection.connection_name,
    base_url: connection.base_url,
    auth_type: connection.auth_type,
    credential: '', // 留空 = 保留原凭据
    verify_tls: connection.verify_tls,
    default_timeout_secs: connection.default_timeout_secs,
    is_active: connection.is_active,
  })
  const [saving, setSaving] = useState(false)
  const [healthChecking, setHealthChecking] = useState(false)
  const [healthResult, setHealthResult] = useState<{
    ok: boolean
    status_code: number
    cluster_name: unknown
    version: unknown
    raw: string | null
  } | null>(null)

  const save = async () => {
    setSaving(true)
    try {
      const payload: UpdateEsConnectionInput = {
        connection_name: form.connection_name.trim(),
        base_url: form.base_url.trim(),
        auth_type: form.auth_type,
        verify_tls: form.verify_tls,
        default_timeout_secs: form.default_timeout_secs,
        is_active: form.is_active,
      }
      // credential 字段语义：
      //   - 空串 = 不动（除非 auth_type=none，此时后端会自动清空）
      //   - 非空 = 替换为新值
      if (form.credential.trim() !== '') {
        payload.credential = form.credential
      }
      await esAPI.updateConnection(connection.id, payload)
      notify.success(t('updated'))
      setForm({ ...form, credential: '' })
      onUpdated()
    } catch {
      /* noop */
    } finally {
      setSaving(false)
    }
  }

  const probe = async () => {
    setHealthChecking(true)
    setHealthResult(null)
    try {
      const res = await esAPI.healthCheck(connection.id)
      setHealthResult(res.data)
      if (res.data.ok) {
        notify.success(t('reachable'))
      } else {
        notify.warning(t('upstreamReturned', { code: res.data.status_code }))
      }
    } catch (err: any) {
      setHealthResult({
        ok: false,
        status_code: 0,
        cluster_name: null,
        version: null,
        raw: err?.response?.data?.error || err?.message || t('testFail'),
      })
    } finally {
      setHealthChecking(false)
    }
  }

  return (
    <div className="space-y-3 text-sm">
      <FormRow label={t('connName')}>
        <input
          value={form.connection_name}
          onChange={(e) => setForm({ ...form, connection_name: e.target.value })}
          className="input-base w-full"
        />
      </FormRow>
      <FormRow label="base_url">
        <input
          value={form.base_url}
          onChange={(e) => setForm({ ...form, base_url: e.target.value })}
          className="input-base w-full font-mono"
          placeholder="https://es.example.com:9200"
        />
      </FormRow>
      <div className="grid grid-cols-2 gap-3">
        <FormRow label={t('authType')}>
          <select
            value={form.auth_type}
            onChange={(e) => setForm({ ...form, auth_type: e.target.value as typeof form.auth_type })}
            className="input-base w-full"
          >
            <option value="api_key">ApiKey</option>
            <option value="basic">Basic（user:pass）</option>
            <option value="none">{t('noAuth')}</option>
          </select>
        </FormRow>
        <FormRow label={t('timeout')}>
          <input
            type="number"
            min={1}
            max={600}
            value={form.default_timeout_secs}
            onChange={(e) =>
              setForm({ ...form, default_timeout_secs: parseInt(e.target.value, 10) || 30 })
            }
            className="input-base w-full"
          />
        </FormRow>
      </div>
      <FormRow
        label={t('credLabel')}
        hint={t('credHint')}
      >
        <input
          type="password"
          value={form.credential}
          onChange={(e) => setForm({ ...form, credential: e.target.value })}
          disabled={form.auth_type === 'none'}
          placeholder={form.auth_type === 'none' ? t('credPlaceholderNone') : t('credPlaceholder')}
          className="input-base w-full font-mono"
        />
      </FormRow>
      <div className="flex items-center space-x-4 text-sm">
        <label className="flex items-center space-x-2">
          <input
            type="checkbox"
            checked={form.verify_tls}
            onChange={(e) => setForm({ ...form, verify_tls: e.target.checked })}
          />
          <span>{t('verifyTls')}</span>
        </label>
        <label className="flex items-center space-x-2">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
          />
          <span>{t('connEnabled')}</span>
        </label>
      </div>

      <div className="flex items-center space-x-2 pt-3 border-t">
        <button type="button" onClick={save} disabled={saving} className="btn-primary">
          {saving ? (
            <>
              <i className="fas fa-spinner fa-spin mr-2"></i>{t('saving')}
            </>
          ) : (
            <>
              <i className="fas fa-save mr-2"></i>{t('save')}
            </>
          )}
        </button>
        <button
          type="button"
          onClick={probe}
          disabled={healthChecking}
          className="btn-default"
          title={t('testTitle')}
        >
          {healthChecking ? (
            <>
              <i className="fas fa-spinner fa-spin mr-2"></i>{t('testing')}
            </>
          ) : (
            <>
              <i className="fas fa-heartbeat mr-2"></i>{t('test')}
            </>
          )}
        </button>
      </div>

      {healthResult && (
        <div
          className={`text-xs p-3 rounded border ${
            healthResult.ok
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-red-50 border-red-200 text-red-900'
          }`}
        >
          <div className="font-medium mb-1">
            {t('upstreamResp')} {healthResult.status_code || '—'}
            {healthResult.ok && (
              <span className="ml-2 bg-emerald-100 px-1.5 py-0.5 rounded">OK</span>
            )}
          </div>
          {healthResult.ok ? (
            <div>
              cluster：<span className="font-mono">{JSON.stringify(healthResult.cluster_name)}</span> ·
              version：<span className="font-mono">{JSON.stringify(healthResult.version)}</span>
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-all">{healthResult.raw}</pre>
          )}
        </div>
      )}
    </div>
  )
}

// ── 创建连接弹窗 ──────────────────────────────────────────────────────

function CreateConnectionDialog({
  tenantId,
  onClose,
  onCreated,
}: {
  tenantId: number
  onClose: () => void
  onCreated: (id: number) => void
}) {
  const notify = useNotification()
  const t = useTranslations('wsEsConn')
  const tc = useTranslations('connCommon')
  const [form, setForm] = useState({
    connection_name: '',
    base_url: '',
    auth_type: 'api_key' as 'api_key' | 'basic' | 'none',
    credential: '',
    verify_tls: true,
    default_timeout_secs: 30,
  })
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!form.connection_name.trim()) {
      notify.error(t('fillName'))
      return
    }
    if (!form.base_url.trim()) {
      notify.error(t('fillBaseUrl'))
      return
    }
    if (form.auth_type !== 'none' && !form.credential) {
      notify.error(t('credRequired'))
      return
    }
    setSaving(true)
    try {
      const payload: CreateEsConnectionInput = {
        tenant_id: tenantId,
        connection_name: form.connection_name.trim(),
        base_url: form.base_url.trim(),
        auth_type: form.auth_type,
        credential: form.auth_type === 'none' ? null : form.credential,
        verify_tls: form.verify_tls,
        default_timeout_secs: form.default_timeout_secs,
      }
      const res = await esAPI.createConnection(payload)
      onCreated(res.data.id)
    } catch {
      /* noop */
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title={t('createTitle')} onClose={onClose} widthClass="max-w-lg">
      <div className="space-y-3 text-sm">
        <FormRow label={t('connNameReq')} hint={t('connNameHint')}>
          <input
            autoFocus
            value={form.connection_name}
            onChange={(e) => setForm({ ...form, connection_name: e.target.value })}
            className="input-base w-full"
            placeholder="prod-es / staging-es / …"
          />
        </FormRow>
        <FormRow label={t('baseUrlReq')} hint={t('baseUrlHint')}>
          <input
            value={form.base_url}
            onChange={(e) => setForm({ ...form, base_url: e.target.value })}
            className="input-base w-full font-mono"
            placeholder="https://es.example.internal:9200"
          />
        </FormRow>
        <div className="grid grid-cols-2 gap-3">
          <FormRow label={t('authType')}>
            <select
              value={form.auth_type}
              onChange={(e) => setForm({ ...form, auth_type: e.target.value as typeof form.auth_type })}
              className="input-base w-full"
            >
              <option value="api_key">ApiKey</option>
              <option value="basic">Basic（user:pass）</option>
              <option value="none">{t('noAuth')}</option>
            </select>
          </FormRow>
          <FormRow label={t('timeout')}>
            <input
              type="number"
              min={1}
              max={600}
              value={form.default_timeout_secs}
              onChange={(e) =>
                setForm({ ...form, default_timeout_secs: parseInt(e.target.value, 10) || 30 })
              }
              className="input-base w-full"
            />
          </FormRow>
        </div>
        <FormRow
          label={form.auth_type === 'basic' ? t('credBasic') : 'API Key'}
          hint={
            form.auth_type === 'api_key'
              ? t('apiKeyHint')
              : form.auth_type === 'basic'
                ? t('credBasicHint')
                : t('credNoneHint')
          }
        >
          <input
            type="password"
            value={form.credential}
            onChange={(e) => setForm({ ...form, credential: e.target.value })}
            disabled={form.auth_type === 'none'}
            className="input-base w-full font-mono"
          />
        </FormRow>
        <label className="flex items-center space-x-2 text-sm">
          <input
            type="checkbox"
            checked={form.verify_tls}
            onChange={(e) => setForm({ ...form, verify_tls: e.target.checked })}
          />
          <span>
            {t('verifyTlsCreate')}
            <span className="text-xs text-gray-400 ml-1">
              {t('verifyTlsCreateHint')}
            </span>
          </span>
        </label>
      </div>
      <div className="flex justify-end space-x-2 pt-4 border-t mt-4">
        <button type="button" onClick={onClose} className="btn-default">
          {tc('cancel')}
        </button>
        <button type="button" onClick={submit} disabled={saving} className="btn-primary">
          {saving ? (
            <>
              <i className="fas fa-spinner fa-spin mr-2"></i>{t('creating')}
            </>
          ) : (
            <>
              <i className="fas fa-plus mr-2"></i>{t('create')}
            </>
          )}
        </button>
      </div>
    </Dialog>
  )
}

// ── 创建 token 弹窗 ───────────────────────────────────────────────────

const DEFAULT_PATH_DENYLIST = [
  '^/?_cluster(/.*)?$',
  '^/?_security(/.*)?$',
  '^/?_ilm(/.*)?$',
  '^/?_snapshot(/.*)?$',
  '^/?_shutdown(/.*)?$',
  '^/?_nodes/.*/(reload_secure_settings|shutdown)$',
]

function CreateTokenDialog({
  connectionId,
  onClose,
  onCreated,
}: {
  connectionId: number
  onClose: () => void
  onCreated: (plainToken: string, record: EsAccessToken) => void
}) {
  const notify = useNotification()
  const t = useTranslations('wsEsConn')
  const tc = useTranslations('connCommon')
  const [form, setForm] = useState({
    name: '',
    description: '',
    methods: 'GET,HEAD,POST',
    index_allowlist: '*',
    path_denylist: DEFAULT_PATH_DENYLIST.join('\n'),
    expires_at: '',
  })
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!form.name.trim()) {
      notify.error(t('fillTokenName'))
      return
    }
    const methods = form.methods
      .split(/[,，\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
    if (methods.length === 0) {
      notify.error(t('needMethod'))
      return
    }
    const allowlist = form.index_allowlist
      .split(/[,，\n]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (allowlist.length === 0) {
      notify.error(t('needIndex'))
      return
    }
    const denylist = form.path_denylist
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean)

    setSaving(true)
    try {
      const payload: CreateEsTokenInput = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        allowed_methods: methods,
        index_allowlist: allowlist,
        path_denylist: denylist,
        expires_at: form.expires_at ? new Date(form.expires_at).toISOString() : undefined,
      }
      const res = await esAPI.createToken(connectionId, payload)
      onCreated(res.data.token, res.data.record)
    } catch {
      /* noop */
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title={t('createTokenTitle')} onClose={onClose} widthClass="max-w-xl">
      <div className="space-y-3 text-sm">
        <FormRow label={t('tokenNameReq')}>
          <input
            autoFocus
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="input-base w-full"
            placeholder={t('tokenNamePlaceholder')}
          />
        </FormRow>
        <FormRow label={t('tokenDescLabel')}>
          <input
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="input-base w-full"
          />
        </FormRow>
        <FormRow
          label={t('methodsLabel')}
          hint={t('methodsHint')}
        >
          <input
            value={form.methods}
            onChange={(e) => setForm({ ...form, methods: e.target.value })}
            className="input-base w-full font-mono"
          />
        </FormRow>
        <FormRow
          label="index_allowlist *"
          hint={t('indexHint')}
        >
          <textarea
            value={form.index_allowlist}
            onChange={(e) => setForm({ ...form, index_allowlist: e.target.value })}
            className="input-base w-full font-mono"
            rows={2}
          />
        </FormRow>
        <FormRow
          label="path_denylist"
          hint={t('pathDenyHint')}
        >
          <textarea
            value={form.path_denylist}
            onChange={(e) => setForm({ ...form, path_denylist: e.target.value })}
            className="input-base w-full font-mono text-xs"
            rows={6}
          />
        </FormRow>
        <FormRow label={t('expireLabel')} hint={t('expireHint')}>
          <input
            type="datetime-local"
            value={form.expires_at}
            onChange={(e) => setForm({ ...form, expires_at: e.target.value })}
            className="input-base w-full"
          />
        </FormRow>
      </div>
      <div className="flex justify-end space-x-2 pt-4 border-t mt-4">
        <button type="button" onClick={onClose} className="btn-default">
          {tc('cancel')}
        </button>
        <button type="button" onClick={submit} disabled={saving} className="btn-primary">
          {saving ? (
            <>
              <i className="fas fa-spinner fa-spin mr-2"></i>{t('creating')}
            </>
          ) : (
            <>
              <i className="fas fa-key mr-2"></i>{t('createTokenBtn')}
            </>
          )}
        </button>
      </div>
    </Dialog>
  )
}

// ── 一次性 token 展示弹窗 ─────────────────────────────────────────────

function RevealTokenDialog({
  token,
  name,
  onClose,
}: {
  token: string
  name: string
  onClose: () => void
}) {
  const notify = useNotification()
  const t = useTranslations('wsEsConn')
  const tc = useTranslations('connCommon')
  const [acknowledged, setAcknowledged] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token)
      notify.success(t('revealCopied'))
    } catch {
      notify.error(t('copyFail'))
    }
  }

  return (
    <Dialog
      title={
        <>
          <i className="fas fa-key text-amber-500 mr-2"></i>{t('tokenGenerated')}
        </>
      }
      onClose={acknowledged ? onClose : () => {}}
      widthClass="max-w-xl"
    >
      <div className="space-y-3 text-sm">
        <div className="bg-amber-50 border border-amber-200 text-amber-900 p-3 rounded text-xs">
          <i className="fas fa-exclamation-triangle mr-1"></i>
          {t.rich('revealHint2Full', { b: (c: any) => <strong>{c}</strong> })}
        </div>
        <div>
          <div className="text-xs text-gray-500 mb-1">{t('revealName', { name })}</div>
          <pre className="bg-gray-900 text-emerald-300 p-3 rounded font-mono text-xs break-all whitespace-pre-wrap">
            {token}
          </pre>
        </div>
        <div className="flex space-x-2">
          <button type="button" onClick={copy} className="btn-primary text-sm">
            <i className="fas fa-copy mr-2"></i>{t('revealCopy')}
          </button>
        </div>
        <label className="flex items-center space-x-2 text-xs text-gray-600">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>{t('revealSaved')}</span>
        </label>
      </div>
      <div className="flex justify-end pt-3 border-t mt-4">
        <button
          type="button"
          onClick={onClose}
          disabled={!acknowledged}
          className="btn-primary"
        >
          {t('close')}
        </button>
      </div>
    </Dialog>
  )
}

// ── 通用小组件 ────────────────────────────────────────────────────────

function FormRow({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      {children}
      {hint && <div className="text-xs text-gray-400 mt-1">{hint}</div>}
    </div>
  )
}

function Dialog({
  title,
  onClose,
  widthClass,
  children,
}: {
  title: React.ReactNode
  onClose: () => void
  widthClass?: string
  children: React.ReactNode
}) {
  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onMouseDown={closeOnBackdropPress(onClose)}
    >
      <div
        className={`bg-white rounded shadow-lg w-full ${widthClass ?? 'max-w-md'} max-h-[90vh] overflow-y-auto`}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="font-semibold">{title}</div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
          >
            <i className="fas fa-times"></i>
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  )
}
