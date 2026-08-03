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
 *   - 代理 token 明文（cres_es_xxx）**只在创建成功一次性弹窗**显示
 *   - "接入指南"动态生成当前 origin 下的代理 URL + curl / Python / Node 示例
 *
 * tenantId 来自 URL 的 projectId（W2：projectId === tenant.id）。注意 projectId
 * **不等于** database_id（tenants.id 与 tenant_databases.id 是独立序列）；本页只用
 * tenant 维度，不直接拿 projectId 当 database_id 用。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
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

export default function EsConnectionsPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const caps = useCurrentProjectCapabilities()

  if (!caps.canManageEvents) {
    return (
      <ForbiddenPlaceholder reason="ES 反向代理管理需要 admin+ 角色（owner / admin / 超管）" />
    )
  }

  if (isNaN(projectId) || projectId <= 0) {
    // 不正常的 projectId；layout 一般会先一步兜底跳走，这里只是渲染期防御
    return (
      <div className="text-center py-12 text-gray-400">
        <i className="fas fa-spinner fa-spin text-2xl"></i>
        <p className="text-sm mt-2">正在加载项目上下文…</p>
      </div>
    )
  }

  return <EsConnectionsManager tenantId={projectId} />
}

// ── 内部组件 ──────────────────────────────────────────────────────────

function EsConnectionsManager({ tenantId }: { tenantId: number }) {
  const notify = useNotification()
  const [connections, setConnections] = useState<EsConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [activeId, setActiveId] = useState<number | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const loadConnections = useCallback(async () => {
    setLoading(true)
    try {
      const res = await esAPI.listConnections(tenantId)
      setConnections(res.data)
      // 首次进入或当前选中已被删 → 自动选第一个
      if (res.data.length > 0) {
        setActiveId((prev) =>
          prev !== null && res.data.some((c) => c.id === prev) ? prev : res.data[0].id,
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
            Elasticsearch 反向代理
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            平台保管 ES 真实地址 / ApiKey；业务端用平台代理 URL + cres_es_* token 访问，
            避免把生产凭据散落到各业务端。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="btn-primary"
        >
          <i className="fas fa-plus mr-2"></i>新建连接
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
              <p className="text-sm text-gray-500">还没有 ES 连接</p>
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="mt-3 text-sm text-blue-600 hover:underline"
              >
                立即创建第一个
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
              请从左侧选择一个连接，或新建一个
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
            notify.success('ES 连接已创建')
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
            已停用
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
          <span className="text-amber-600" title="未校验 TLS 证书">
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
  const notify = useNotification()
  const [tab, setTab] = useState<'usage' | 'tokens' | 'settings'>('usage')

  const handleDelete = async () => {
    if (
      !window.confirm(
        `确认删除连接「${connection.connection_name}」？所有挂在它下面的 token 会一并被级联删除，业务端访问立即 401。`,
      )
    )
      return
    try {
      await esAPI.deleteConnection(connection.id)
      notify.success('连接已删除')
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
          title="删除连接（级联清理所有 token）"
        >
          <i className="fas fa-trash"></i>
        </button>
      </div>

      <div className="border-b flex text-sm">
        {[
          { id: 'usage', label: '接入指南', icon: 'fa-book' },
          { id: 'tokens', label: '代理 Token', icon: 'fa-key' },
          { id: 'settings', label: '连接设置', icon: 'fa-cog' },
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
      notify.success(`已复制：${label}`)
    } catch {
      notify.error('复制失败，请手动选择文本')
    }
  }

  return (
    <div className="space-y-4 text-sm">
      <div className="bg-blue-50 border border-blue-200 text-blue-900 rounded p-3 space-y-1.5 text-xs">
        <div className="font-semibold">
          <i className="fas fa-lightbulb mr-1"></i>两种接入方式
        </div>
        {!databaseSlug && (
          <p className="text-amber-800">
            当前项目尚未绑定主数据库连接，接入地址暂用旧版路径；绑定后将自动带上项目 slug（
            <code className="bg-white px-1 rounded">/api/v1/&#123;slug&#125;/es-app</code>）。
          </p>
        )}
        <ul className="list-disc list-inside space-y-0.5">
          <li>
            <strong>应用 API</strong>（推荐）：发简化 JSON 完成增删改查，业务端
            <strong>无需</strong>引入 ES SDK，也不用学 Query DSL。
          </li>
          <li>
            <strong>原生代理</strong>：直接转发 ES REST API，配 elasticsearch-py /
            @elastic/elasticsearch 等官方 SDK 用，适合需要 scroll / KNN / 复杂 agg 的场景。
          </li>
          <li>
            两种模式共用同一个 <code className="bg-white px-1 rounded">cres_es_xxx</code> token，
            按 method / index 白名单约束。
          </li>
        </ul>
      </div>

      <div className="inline-flex rounded border border-gray-300 overflow-hidden text-xs">
        <button
          type="button"
          onClick={() => setMode('app')}
          className={`px-3 py-1.5 ${mode === 'app' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
        >
          应用 API（推荐）
        </button>
        <button
          type="button"
          onClick={() => setMode('proxy')}
          className={`px-3 py-1.5 ${mode === 'proxy' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
        >
          原生代理（带 SDK）
        </button>
      </div>

      {mode === 'app' ? (
        <AppApiGuide base={appBase} copy={copy} />
      ) : (
        <ProxyGuide base={proxyBase} copy={copy} />
      )}

      <div className="text-xs text-gray-500 pt-2 border-t">
        当前连接默认超时 <strong>{connection.default_timeout_secs}s</strong>；
        TLS 校验 {connection.verify_tls ? '开启' : <span className="text-amber-600 font-semibold">关闭（仅自签证书测试用）</span>}。
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
  const createDoc = `# 创建文档（auto id；body 里写 "_id" 则按指定 id upsert）
curl -X POST "${base}/orders/docs" \\
  -H "Authorization: ApiKey cres_es_<your_token>" \\
  -H "Content-Type: application/json" \\
  -d '{"order_id":"ORD-1001","amount":199.9,"status":"paid"}'`

  const getDoc = `# 按 id 获取（找不到返回 404 + {"found": false}）
curl "${base}/orders/docs/ORD-1001" \\
  -H "Authorization: ApiKey cres_es_<your_token>"`

  const patchDoc = `# 部分更新（裸字段 = {"doc": {...}} 的语法糖）
curl -X PATCH "${base}/orders/docs/ORD-1001" \\
  -H "Authorization: ApiKey cres_es_<your_token>" \\
  -H "Content-Type: application/json" \\
  -d '{"status":"refunded"}'`

  const deleteDoc = `curl -X DELETE "${base}/orders/docs/ORD-1001" \\
  -H "Authorization: ApiKey cres_es_<your_token>"`

  const searchDoc = `# 搜索：扁平的 where + q + sort + page/size + select
curl -X POST "${base}/orders/search" \\
  -H "Authorization: ApiKey cres_es_<your_token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "where": {
      "status": "paid",
      "amount": {"gte": 10, "lte": 500},
      "tags":   {"in": ["promo", "vip"]},
      "remark": {"contains": "首单"},
      "name":   {"wildcard": {"value": "*iphone*", "case_insensitive": true, "rewrite": "constant_score"}},
      "deleted_at": {"exists": false}
    },
    "q": "急单 OR 紧急",
    "q_fields": ["remark", "title"],
    "sort":   [{"field": "created_at", "order": "desc"}],
    "page": 1, "size": 20,
    "select": ["order_id","amount","status"]
  }'

# 响应（已去掉 hits.hits 嵌套）：
# {"total":123,"page":1,"size":20,"took_ms":12,"data":[{"_id":"...","order_id":"..."}]}`

  const aggregateDoc = `# terms 聚合：先按 where 过滤，再按字段分桶
curl -X POST "${base}/articles/search" \\
  -H "Authorization: ApiKey cres_es_<your_token>" \\
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

# 响应：
# {"total":123,"size":0,"data":[],"aggregations":{"topic_counts":{"buckets":[{"key":"AI","doc_count":42}]}}}

# composite 聚合：完整遍历高基数字段；首屏省略 after
curl -X POST "${base}/articles/search" \\
  -H "Authorization: ApiKey cres_es_<your_token>" \\
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

# 下一页把上次响应的 after_key 原样放入 composite.after：
# "after": {"topic": "上一页最后一个值"}`

  const bulkDoc = `# 批量：一次最多 1000 条；results 与 operations 顺序一致
curl -X POST "${base}/orders/bulk" \\
  -H "Authorization: ApiKey cres_es_<your_token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "operations": [
      {"action":"index",  "id":"1", "doc":{"name":"A"}},
      {"action":"update", "id":"1", "doc":{"name":"A2"}, "upsert": true},
      {"action":"delete", "id":"old-9"}
    ]
  }'`

  const initIndex = `# 简化建表：直接给字段类型字典；shards/replicas 是 ES number_of_* 的别名
curl -X POST "${base}/orders/_init" \\
  -H "Authorization: ApiKey cres_es_<your_token>" \\
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

  const pythonExample = `# 不需要 elasticsearch SDK；标准 requests 即可
import requests

BASE = "${base}"
HEADERS = {"Authorization": "ApiKey cres_es_<your_token>"}

# 创建
r = requests.post(f"{BASE}/orders/docs", json={
    "order_id": "ORD-1001", "amount": 199.9, "status": "paid",
}, headers=HEADERS)
print(r.json())

# 搜索
r = requests.post(f"{BASE}/orders/search", json={
    "where": {"status": "paid", "amount": {"gte": 100}},
    "sort":  [{"field": "created_at", "order": "desc"}],
    "page": 1, "size": 20,
}, headers=HEADERS)
print(r.json()["data"])

# 部分更新
requests.patch(f"{BASE}/orders/docs/ORD-1001",
    json={"status": "refunded"}, headers=HEADERS)`

  const nodeExample = `// 不需要 @elastic/elasticsearch；用 fetch / axios 即可
const BASE = '${base}'
const headers = {
  'Authorization': 'ApiKey cres_es_<your_token>',
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
          <i className="fas fa-cube mr-1"></i>路径速查（base = <code>{base}</code>）
        </div>
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-0.5 list-disc list-inside">
          <li><code>POST /:index/docs</code> 创建</li>
          <li><code>GET /:index/docs/:id</code> 读取</li>
          <li><code>PUT /:index/docs/:id</code> 整体替换</li>
          <li><code>PATCH /:index/docs/:id</code> 部分更新</li>
          <li><code>DELETE /:index/docs/:id</code> 删除</li>
          <li><code>POST /:index/search</code> 搜索</li>
          <li><code>POST /:index/count</code> 计数</li>
          <li><code>POST /:index/bulk</code> 批量</li>
          <li><code>POST /:index/_init</code> 建索引</li>
          <li><code>DELETE /:index</code> 删索引</li>
          <li><code>GET /:index</code> mapping/settings</li>
          <li><code>GET /_indices</code> 列表（按 allowlist 过滤）</li>
        </ul>
      </div>

      <CodeBlock label="① 创建文档" code={createDoc} onCopy={() => copy(createDoc, '创建文档')} />
      <CodeBlock label="② 读取 / 删除" code={`${getDoc}\n\n${deleteDoc}`} onCopy={() => copy(`${getDoc}\n\n${deleteDoc}`, '读取 / 删除')} />
      <CodeBlock label="③ 部分更新" code={patchDoc} onCopy={() => copy(patchDoc, '部分更新')} />
      <CodeBlock label="④ 搜索（无需 ES DSL）" code={searchDoc} onCopy={() => copy(searchDoc, '搜索')} />
      <CodeBlock label="⑤ terms / composite 聚合" code={aggregateDoc} onCopy={() => copy(aggregateDoc, '聚合')} />
      <CodeBlock label="⑥ 批量" code={bulkDoc} onCopy={() => copy(bulkDoc, '批量')} />
      <CodeBlock label="⑦ 建索引（简化 schema）" code={initIndex} onCopy={() => copy(initIndex, '建索引')} />
      <CodeBlock label="Python（不引 SDK，requests 即可）" code={pythonExample} onCopy={() => copy(pythonExample, 'Python 示例')} />
      <CodeBlock label="Node.js（不引 SDK，fetch 即可）" code={nodeExample} onCopy={() => copy(nodeExample, 'Node 示例')} />

      <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded p-2.5 text-xs space-y-1">
        <div className="font-semibold">
          <i className="fas fa-exclamation-triangle mr-1"></i>where 支持的操作符
        </div>
        <p>
          <code>eq / ne / in / nin / gt / gte / lt / lte / contains / prefix / exists / wildcard</code>；
          标量值默认按 <code>eq</code>，数组按 <code>in</code>，<code>null</code> 等价 <code>exists:false</code>；
          多个 range 操作符自动合并到同字段。<code>prefix / wildcard</code> 除字符串简写外，也支持
          <code>{'{ value, case_insensitive, rewrite, boost }'}</code> 参数对象。
        </p>
        <p>
          <code>aggs</code> 支持受限的顶层 <code>terms / composite</code> 聚合。composite 每页最多
          1000 个 buckets、最多 10 个 terms sources，下一页使用响应中的 <code>after_key</code>；
          每次最多 20 项聚合，所有 size 总和最多 10000。复杂聚合请使用原生代理。
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
  const curlExample = `curl -H "Authorization: ApiKey cres_es_<your_token>" \\
     ${base}/_cluster/health`

  const pythonExample = `# pip install elasticsearch
from elasticsearch import Elasticsearch

es = Elasticsearch(
    "${base}",
    api_key="cres_es_<your_token>",
)
print(es.info())`

  const nodeExample = `// npm i @elastic/elasticsearch
import { Client } from '@elastic/elasticsearch'

const es = new Client({
  node: '${base}',
  auth: { apiKey: 'cres_es_<your_token>' },
})
console.log(await es.info())`

  return (
    <div className="space-y-3">
      <div className="bg-gray-50 border border-gray-200 text-gray-700 rounded p-2.5 text-xs">
        <i className="fas fa-info-circle mr-1"></i>
        透传层把 <code>/api/es/*</code> 一对一转给上游 ES，可继续用 elasticsearch-py /
        @elastic/elasticsearch 等官方 SDK；response 流式直传，scroll / async search 全部支持。
      </div>
      <CodeBlock label="代理 URL" code={base} onCopy={() => copy(base, '代理 URL')} />
      <CodeBlock label="curl 示例" code={curlExample} onCopy={() => copy(curlExample, 'curl 示例')} />
      <CodeBlock label="Python (elasticsearch-py)" code={pythonExample} onCopy={() => copy(pythonExample, 'Python 示例')} />
      <CodeBlock label="Node.js (@elastic/elasticsearch)" code={nodeExample} onCopy={() => copy(nodeExample, 'Node 示例')} />
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
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-gray-700">{label}</span>
        <button
          type="button"
          onClick={onCopy}
          className="text-xs text-blue-600 hover:underline"
        >
          <i className="fas fa-copy mr-1"></i>复制
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
      notify.success(t.is_active ? 'token 已停用' : 'token 已启用')
      load()
    } catch {
      /* noop */
    }
  }

  const remove = async (t: EsAccessToken) => {
    if (
      !window.confirm(
        `确认删除 token「${t.name}」？业务端正在用这个 token 的请求将立即 401。`,
      )
    )
      return
    try {
      await esAPI.deleteToken(connectionId, t.id)
      notify.success('token 已删除')
      load()
    } catch {
      /* noop */
    }
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <div className="text-gray-600 text-xs">
          每个 token 独立配置 method / index / path 黑白名单；明文仅在创建时一次性显示。
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="btn-primary text-xs"
        >
          <i className="fas fa-plus mr-1"></i>新建 token
        </button>
      </div>

      {loading ? (
        <div className="text-center py-6 text-gray-400">
          <i className="fas fa-spinner fa-spin"></i>
        </div>
      ) : tokens.length === 0 ? (
        <div className="text-center py-8 text-gray-400 border border-dashed border-gray-300 rounded">
          还没有 token
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-gray-500 border-b">
              <tr>
                <th className="py-2 px-2">名称</th>
                <th className="py-2 px-2">前缀</th>
                <th className="py-2 px-2">methods</th>
                <th className="py-2 px-2">indices</th>
                <th className="py-2 px-2">使用</th>
                <th className="py-2 px-2">状态</th>
                <th className="py-2 px-2 text-right">操作</th>
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
                    {t.use_count > 0 ? `${t.use_count} 次` : '—'}
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
                      {t.is_active ? '停用' : '启用'}
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(t)}
                      className="text-red-600 hover:underline"
                    >
                      删除
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
      notify.success('连接已更新')
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
        notify.success('上游 ES 可达')
      } else {
        notify.warning(`上游返回 ${res.data.status_code}`)
      }
    } catch (err: any) {
      setHealthResult({
        ok: false,
        status_code: 0,
        cluster_name: null,
        version: null,
        raw: err?.response?.data?.error || err?.message || '探活失败',
      })
    } finally {
      setHealthChecking(false)
    }
  }

  return (
    <div className="space-y-3 text-sm">
      <FormRow label="连接名称">
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
        <FormRow label="鉴权类型">
          <select
            value={form.auth_type}
            onChange={(e) => setForm({ ...form, auth_type: e.target.value as typeof form.auth_type })}
            className="input-base w-full"
          >
            <option value="api_key">ApiKey</option>
            <option value="basic">Basic（user:pass）</option>
            <option value="none">无鉴权</option>
          </select>
        </FormRow>
        <FormRow label="超时（秒）">
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
        label="凭据"
        hint="留空 = 保留原凭据。新输入会替换并加密入库；DB 永远拿不回明文。"
      >
        <input
          type="password"
          value={form.credential}
          onChange={(e) => setForm({ ...form, credential: e.target.value })}
          disabled={form.auth_type === 'none'}
          placeholder={form.auth_type === 'none' ? '无鉴权模式下不需要凭据' : '••••••••（输入新值以替换）'}
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
          <span>验证 TLS 证书</span>
        </label>
        <label className="flex items-center space-x-2">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
          />
          <span>连接启用中</span>
        </label>
      </div>

      <div className="flex items-center space-x-2 pt-3 border-t">
        <button type="button" onClick={save} disabled={saving} className="btn-primary">
          {saving ? (
            <>
              <i className="fas fa-spinner fa-spin mr-2"></i>保存中…
            </>
          ) : (
            <>
              <i className="fas fa-save mr-2"></i>保存
            </>
          )}
        </button>
        <button
          type="button"
          onClick={probe}
          disabled={healthChecking}
          className="btn-default"
          title="对 base_url 跑一次 GET /，验证 URL + 凭据"
        >
          {healthChecking ? (
            <>
              <i className="fas fa-spinner fa-spin mr-2"></i>探活中…
            </>
          ) : (
            <>
              <i className="fas fa-heartbeat mr-2"></i>测试连接
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
            上游响应 {healthResult.status_code || '—'}
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
      notify.error('请填写连接名称')
      return
    }
    if (!form.base_url.trim()) {
      notify.error('请填写 base_url')
      return
    }
    if (form.auth_type !== 'none' && !form.credential) {
      notify.error('该鉴权类型必须提供凭据')
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
    <Dialog title="新建 ES 连接" onClose={onClose} widthClass="max-w-lg">
      <div className="space-y-3 text-sm">
        <FormRow label="连接名称 *" hint="同租户内不可重名">
          <input
            autoFocus
            value={form.connection_name}
            onChange={(e) => setForm({ ...form, connection_name: e.target.value })}
            className="input-base w-full"
            placeholder="prod-es / staging-es / …"
          />
        </FormRow>
        <FormRow label="base_url *" hint="ES 真实地址，业务端永远看不到">
          <input
            value={form.base_url}
            onChange={(e) => setForm({ ...form, base_url: e.target.value })}
            className="input-base w-full font-mono"
            placeholder="https://es.example.internal:9200"
          />
        </FormRow>
        <div className="grid grid-cols-2 gap-3">
          <FormRow label="鉴权类型">
            <select
              value={form.auth_type}
              onChange={(e) => setForm({ ...form, auth_type: e.target.value as typeof form.auth_type })}
              className="input-base w-full"
            >
              <option value="api_key">ApiKey</option>
              <option value="basic">Basic（user:pass）</option>
              <option value="none">无鉴权</option>
            </select>
          </FormRow>
          <FormRow label="超时（秒）">
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
          label={form.auth_type === 'basic' ? '凭据（user:pass）' : 'API Key'}
          hint={
            form.auth_type === 'api_key'
              ? '从 ES Kibana 创建 ApiKey 后拿到的 base64 编码字符串'
              : form.auth_type === 'basic'
                ? '形如 elastic:changeme'
                : '无鉴权模式下留空'
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
            验证 TLS 证书
            <span className="text-xs text-gray-400 ml-1">
              （生产建议开；自签证书测试时可关）
            </span>
          </span>
        </label>
      </div>
      <div className="flex justify-end space-x-2 pt-4 border-t mt-4">
        <button type="button" onClick={onClose} className="btn-default">
          取消
        </button>
        <button type="button" onClick={submit} disabled={saving} className="btn-primary">
          {saving ? (
            <>
              <i className="fas fa-spinner fa-spin mr-2"></i>创建中…
            </>
          ) : (
            <>
              <i className="fas fa-plus mr-2"></i>创建
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
      notify.error('请填写 token 名称')
      return
    }
    const methods = form.methods
      .split(/[,，\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
    if (methods.length === 0) {
      notify.error('至少要允许一种 HTTP 方法')
      return
    }
    const allowlist = form.index_allowlist
      .split(/[,，\n]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (allowlist.length === 0) {
      notify.error('index_allowlist 至少要有一项（用 * 表示不限）')
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
    <Dialog title="新建代理 Token" onClose={onClose} widthClass="max-w-xl">
      <div className="space-y-3 text-sm">
        <FormRow label="名称 *">
          <input
            autoFocus
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="input-base w-full"
            placeholder="如：order-service-readonly"
          />
        </FormRow>
        <FormRow label="描述">
          <input
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="input-base w-full"
          />
        </FormRow>
        <FormRow
          label="允许的 HTTP 方法 *"
          hint="逗号或空格分隔；大小写无关。默认 GET,HEAD,POST（读类）。"
        >
          <input
            value={form.methods}
            onChange={(e) => setForm({ ...form, methods: e.target.value })}
            className="input-base w-full font-mono"
          />
        </FormRow>
        <FormRow
          label="index_allowlist *"
          hint="支持 * 和 ? 通配；多条用逗号或换行分隔。设成 * 表示不限。"
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
          hint="POSIX 正则，逐行；任一命中即拒。默认拦截 _cluster / _security / _ilm / _snapshot / _shutdown 等。"
        >
          <textarea
            value={form.path_denylist}
            onChange={(e) => setForm({ ...form, path_denylist: e.target.value })}
            className="input-base w-full font-mono text-xs"
            rows={6}
          />
        </FormRow>
        <FormRow label="过期时间" hint="留空 = 永不过期">
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
          取消
        </button>
        <button type="button" onClick={submit} disabled={saving} className="btn-primary">
          {saving ? (
            <>
              <i className="fas fa-spinner fa-spin mr-2"></i>创建中…
            </>
          ) : (
            <>
              <i className="fas fa-key mr-2"></i>创建 token
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
  const [acknowledged, setAcknowledged] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token)
      notify.success('已复制到剪贴板；请妥善保存')
    } catch {
      notify.error('复制失败，请手动选择文本')
    }
  }

  return (
    <Dialog
      title={
        <>
          <i className="fas fa-key text-amber-500 mr-2"></i>token 已生成（仅此一次显示）
        </>
      }
      onClose={acknowledged ? onClose : () => {}}
      widthClass="max-w-xl"
    >
      <div className="space-y-3 text-sm">
        <div className="bg-amber-50 border border-amber-200 text-amber-900 p-3 rounded text-xs">
          <i className="fas fa-exclamation-triangle mr-1"></i>
          请立即复制保存。<strong>关闭此窗口后将无法再次查看</strong>，平台数据库里只
          保存 SHA-256 哈希。如果丢失只能撤销重建。
        </div>
        <div>
          <div className="text-xs text-gray-500 mb-1">名称：{name}</div>
          <pre className="bg-gray-900 text-emerald-300 p-3 rounded font-mono text-xs break-all whitespace-pre-wrap">
            {token}
          </pre>
        </div>
        <div className="flex space-x-2">
          <button type="button" onClick={copy} className="btn-primary text-sm">
            <i className="fas fa-copy mr-2"></i>复制 token
          </button>
        </div>
        <label className="flex items-center space-x-2 text-xs text-gray-600">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>我已复制并妥善保存这个 token</span>
        </label>
      </div>
      <div className="flex justify-end pt-3 border-t mt-4">
        <button
          type="button"
          onClick={onClose}
          disabled={!acknowledged}
          className="btn-primary"
        >
          关闭
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
      onClick={onClose}
    >
      <div
        className={`bg-white rounded shadow-lg w-full ${widthClass ?? 'max-w-md'} max-h-[90vh] overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
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
