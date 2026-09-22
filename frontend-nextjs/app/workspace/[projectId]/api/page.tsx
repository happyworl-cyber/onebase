'use client'

/**
 * `/workspace/[projectId]/api` —— 项目维度的 REST API 概览 + 接口文档（W3 拆分后）。
 *
 * 历史：早期跟 API Key 管理挤一个页面（三 tab：overview / keys / docs）。
 * W3 把 keys 抽到了 `/workspace/[projectId]/security/api-keys`，本页留下两个
 * 只读 tab：overview（端点 + 快速开始）+ docs（接口文档 / curl 示例）。
 *
 * 改成只读心智后，本页不再需要 admin+ 角色门槛——所有项目成员都可以看；
 * 创建/删除 key 的操作都跳转到 security/api-keys（admin+）。
 *
 * tenant_id 直接取自 URL 的 projectId（W2 invariant）；
 * database_slug 必须从 currentConnection（layout 从 /api/projects/:id 的
 * primary_connection 拿到再铺过来）读真值，**不能**和 projectId 混为一谈
 * ——老租户里 tenants.id 与 tenant_databases.id 是两个独立自增序列。
 * 历史教训 commit 1957ed5 把它俩当一回事，导致 api-keys 页和文档示例 URL
 * 全是错的；W3 这里修回真值。
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useAppStore } from '@/lib/store'
import api, { schemaAPI } from '@/lib/api'
import { usePublicApiConfig } from '@/lib/apiBase'
import { useNotification } from '@/hooks/useNotification'
import { buildRestApiDoc, type DocEndpoint } from '@/components/api/restApiDoc'

interface TableInfo {
  table_name: string
  table_type: string
}

type ApiTab = 'overview' | 'docs'

// REST API 接口文档「分享」按钮：生成 / 展示 / 关闭一个免登录的公开文档链接（<origin>/doc/api/<token>）。
// 未绑定主连接（无 database_id）时置灰。
function ShareApiDocButton({ databaseId }: { databaseId: number | null }) {
  const t = useTranslations('wsApi')
  const notify = useNotification()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const shareUrl = token && typeof window !== 'undefined' ? `${window.location.origin}/doc/api/${token}` : ''

  const loadState = useCallback(async () => {
    if (databaseId == null) return
    setLoading(true)
    try {
      const res = await api.get(`/api/admin/databases/${databaseId}/rest-doc-share`)
      setToken(res.data?.share_token ?? null)
      setEnabled(!!res.data?.share_enabled)
      setLoaded(true)
    } catch {
      notify.error(t('readShareFailed'))
    } finally {
      setLoading(false)
    }
  }, [databaseId, notify])

  const toggleOpen = () => {
    const next = !open
    setOpen(next)
    if (next && !loaded && databaseId != null) loadState()
  }

  const setShare = async (nextEnabled: boolean) => {
    if (databaseId == null) return
    setLoading(true)
    try {
      const res = await api.post(`/api/admin/databases/${databaseId}/rest-doc-share`, { enabled: nextEnabled })
      setToken(res.data?.share_token ?? null)
      setEnabled(!!res.data?.share_enabled)
      setLoaded(true)
    } catch {
      notify.error(t('opFailed'))
    } finally {
      setLoading(false)
    }
  }

  const copyLink = () => {
    if (!shareUrl) return
    navigator.clipboard?.writeText(shareUrl)
    notify.success(t('linkCopied'))
  }

  if (databaseId == null) {
    return (
      <button
        disabled
        title={t('shareNoDbTitle')}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-200 text-gray-300 text-sm font-medium cursor-not-allowed"
      >
        <i className="fas fa-share-nodes"></i>
        {t('share')}
      </button>
    )
  }

  return (
    <div className="relative">
      <button
        onClick={toggleOpen}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300 text-gray-600 text-sm font-medium hover:bg-gray-100"
      >
        <i className="fas fa-share-nodes"></i>
        {enabled ? t('shared') : t('share')}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-white border rounded-xl shadow-xl p-4 z-20 text-left" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between mb-2">
            <h5 className="font-semibold text-gray-800 text-sm">{t('publicShare')}</h5>
            <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
          </div>
          <p className="text-xs text-gray-500 leading-relaxed mb-3">
            {t('publicShareDesc')}
          </p>
          {loading && !loaded ? (
            <p className="text-xs text-gray-400">{t('loading')}</p>
          ) : enabled && shareUrl ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <code className="text-xs bg-gray-100 px-2 py-1.5 rounded font-mono break-all flex-1 min-w-0">{shareUrl}</code>
                <button onClick={copyLink} className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-500 hover:bg-gray-100 shrink-0">{t('copy')}</button>
              </div>
              <div className="flex items-center gap-2">
                <a href={shareUrl} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline">{t('openNewTab')}</a>
                <span className="text-gray-300">·</span>
                <button onClick={() => setShare(false)} disabled={loading} className="text-xs text-red-500 hover:text-red-600 disabled:opacity-50">{t('closeShare')}</button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShare(true)}
              disabled={loading}
              className="w-full px-3 py-2 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium disabled:opacity-50"
            >
              {loading ? t('generating') : t('genLink')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default function ApiPage() {
  const tr = useTranslations('wsApi')
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const currentConnection = useAppStore((s) => s.currentConnection)
  const currentProject = useAppStore((s) => s.currentProject)
  const { currentSchema } = useAppStore()
  const notify = useNotification()

  const [activeTab, setActiveTab] = useState<ApiTab>('overview')
  const [tables, setTables] = useState<TableInfo[]>([])
  const [selectedTable, setSelectedTable] = useState<string>('')
  /** 接口文档里 RPC 示例用的函数名（占位，可改成你的函数名） */
  const [rpcDocFunctionName, setRpcDocFunctionName] = useState('my_rpc_function')

  // 路由段优先使用连接上的 database_slug；缺失时回落到当前项目标识（slug/name），
  // 不再把数字 database_id 暴露给最终用户，避免出现 "database_slug=2" 的不友好文案。
  const databaseSlug =
    currentConnection?.database_slug ||
    currentProject?.slug ||
    currentProject?.name ||
    null

  useEffect(() => {
    if (databaseSlug) loadTables()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseSlug, currentSchema])

  const loadTables = async () => {
    try {
      const response = await schemaAPI.listTables(currentSchema)
      setTables(response.data || [])
      if (response.data?.length > 0) {
        setSelectedTable(response.data[0].table_name)
      }
    } catch (err) {
      console.error(tr('loadTablesFailed'), err)
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    notify.success(tr('copiedClipboard'))
  }

  // 对外调用基址：运行期解析(网关域名) > 构建期 NEXT_PUBLIC_API_URL > 浏览器 origin，
  // 跨机器/HTTPS/网关 场景下示例 URL 自动正确，不会硬编码 :3000 或内网 IP。
  // gatewayMode：配了网关域名时，示例 curl 隐藏 API Key 鉴权头（网关统一鉴权）。
  const { apiBase: apiBaseUrl, gatewayMode } = usePublicApiConfig(projectId)
  // 走网关时鉴权由网关统一处理，示例不再展示 API Key 头。
  const authHeaderLine = gatewayMode ? '' : ` \\\n  -H "Authorization: Bearer YOUR_API_KEY"`
  const endpointBase = `${apiBaseUrl}/api/v1/${databaseSlug}/${currentSchema}`
  /** RPC 路径前缀：与表 CRUD 共用 /api/v1/{databaseSlug}/，仅末段从 schema/table 换成 rpc/{fn} */
  const rpcEndpointRoot = `${apiBaseUrl}/api/v1/${databaseSlug}/rpc`
  /** DDL 路径前缀：建表 / 改表 / 删表 */
  const ddlEndpointRoot = `${apiBaseUrl}/api/v1/${databaseSlug}/ddl/tables`
  const sqlEndpoint = `${apiBaseUrl}/api/v1/${databaseSlug}/sql`

  if (isNaN(projectId)) {
    return (
      <div className="p-8 text-center text-gray-500">
        {tr('invalidProjectId')}
      </div>
    )
  }

  if (!databaseSlug) {
    // 没绑主连接时 /api/v1/{database_slug}/... 这条路根本走不通，与其展示
    // 一堆带 NaN 的示例 URL 误导，不如引导用户去绑库。
    return (
      <div className="p-8 text-center text-gray-500 space-y-3">
        <i className="fas fa-plug text-4xl text-gray-300"></i>
        <p>{tr('noDbConn')}</p>
        <Link
          href={`/workspace/${projectId}/settings/connections`}
          className="text-blue-600 hover:underline"
        >
          {tr('goToDbConn')}
        </Link>
      </div>
    )
  }

  const rpcFnEncoded = encodeURIComponent(rpcDocFunctionName.trim() || 'my_rpc_function')

  const rpcPostCurl = (() => {
    let s = `curl -X POST "${rpcEndpointRoot}/${rpcFnEncoded}"${authHeaderLine} \\\n`
    s += `  -H "Content-Type: application/json"`
    if (currentSchema !== 'public') {
      s += ` \\\n  -H "Content-Profile: ${currentSchema}"`
    }
    s += ` \\\n  -d '{"user_id": 1, "keyword": "demo"}'`
    return s
  })()

  const rpcGetCurl = (() => {
    let s = `curl -X GET "${rpcEndpointRoot}/${rpcFnEncoded}?user_id=1&keyword=%22demo%22"${authHeaderLine}`
    if (currentSchema !== 'public') {
      s += ` \\\n  -H "Accept-Profile: ${currentSchema}"`
    }
    return s
  })()

  const rpcPreferCurl = (() => {
    let s = `curl -X POST "${rpcEndpointRoot}/${rpcFnEncoded}"${authHeaderLine} \\\n`
    s += `  -H "Content-Type: application/json" \\\n`
    s += `  -H "Prefer: params=single-object"`
    if (currentSchema !== 'public') {
      s += ` \\\n  -H "Content-Profile: ${currentSchema}"`
    }
    s += ` \\\n  -d '{"payload": {"nested": true}}'`
    return s
  })()

  // 通用接口模板（占位 {table}/{function}）来自共享模块 restApiDoc.ts：
  // 登录态本页与免登录公开分享页（RestApiDocContent）共用同一份，避免两处漂移。
  const {
    genericTableEndpoints,
    genericDdlEndpoints,
    genericRawDdlEndpoints,
    genericRpcEndpoints,
    fullDocText,
  } = buildRestApiDoc({ apiBaseUrl, databaseSlug: databaseSlug || '', schema: currentSchema, gatewayMode })

  const renderEndpointCard = (ep: DocEndpoint, key: string) => {
    const headerBg: Record<DocEndpoint['color'], string> = {
      green: 'bg-green-50',
      blue: 'bg-blue-50',
      yellow: 'bg-yellow-50',
      red: 'bg-red-50',
      purple: 'bg-purple-50',
    }
    const badgeBg: Record<DocEndpoint['color'], string> = {
      green: 'bg-green-500',
      blue: 'bg-blue-500',
      yellow: 'bg-yellow-500',
      red: 'bg-red-500',
      purple: 'bg-purple-600',
    }
    return (
      <div key={key} className="border border-gray-200 rounded-lg overflow-hidden bg-white">
        <div
          className={`px-4 py-3 ${headerBg[ep.color]} border-b border-gray-200 flex items-center justify-between`}
        >
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <span className={`px-2 py-1 ${badgeBg[ep.color]} text-white text-xs font-bold rounded`}>
              {ep.method}
            </span>
            <span className="font-mono text-sm break-all">{ep.path}</span>
            <span className="text-gray-500 text-sm">{ep.desc}</span>
          </div>
          <button
            type="button"
            onClick={() => copyToClipboard(ep.body)}
            className="text-gray-400 hover:text-gray-600 text-sm shrink-0 p-1"
            title={tr('copyExample')}
          >
            <i className="fas fa-copy"></i>
          </button>
        </div>
        <pre className="p-4 bg-gray-900 text-gray-100 font-mono text-sm overflow-x-auto">
          {ep.body}
        </pre>
      </div>
    )
  }

  const tabs: { id: ApiTab; label: string; icon: string; desc: string }[] = [
    { id: 'overview', label: tr('tabOverview'), icon: 'fa-plug', desc: tr('tabOverviewDesc') },
    { id: 'docs', label: tr('tabDocs'), icon: 'fa-book', desc: tr('tabDocsDesc') },
  ]

  return (
    <div className="p-6 space-y-6">
      {/* 页面标题 */}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">API</h1>
          <p className="text-gray-600 mt-1">
            {tr.rich('crudShareFull', { code: (c: any) => <span className="font-mono text-xs">{c}</span>, b: (c: any) => <strong>{c}</strong>, prefix: '/api/v1/{project}/…' })}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <ShareApiDocButton databaseId={currentConnection?.database_id ?? null} />
          <Link
            href={`/workspace/${projectId}/security/api-keys`}
            className="btn-primary"
          >
            <i className="fas fa-key mr-2"></i>
            {tr('manageApiKey')}
          </Link>
        </div>
      </div>

      {/* Tab 导航 */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex space-x-6">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`group inline-flex items-center gap-2 py-3 px-1 border-b-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                <i className={`fas ${tab.icon}`}></i>
                <span>{tab.label}</span>
              </button>
            )
          })}
        </nav>
      </div>

      {/* —— 概览 Tab —— */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* 端点信息 */}
          <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-xl p-6 border border-blue-100">
            <h2 className="text-lg font-semibold text-gray-900 mb-1">
              <i className="fas fa-plug mr-2 text-blue-500"></i>
              {tr('apiEndpoints')}
            </h2>
            <p className="text-sm text-gray-500 mb-4">
              {tr.rich('endpointsDescRich', { code: (c: any) => <span className="font-mono text-xs">{c}</span>, b: (c: any) => <strong>{c}</strong>, slug: databaseSlug, schema: currentSchema })}
            </p>
            <div className="space-y-3">
              <div className="bg-white rounded-lg p-4 font-mono text-sm">
                <div className="text-xs text-gray-500 mb-1">{tr('tableRest')}</div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-700 break-all">
                    {endpointBase}/<span className="text-blue-600">{'{table}'}</span>
                  </span>
                  <button
                    onClick={() => copyToClipboard(`${endpointBase}/`)}
                    className="ml-3 text-gray-400 hover:text-gray-600 shrink-0"
                    title={tr('copyBtn')}
                  >
                    <i className="fas fa-copy"></i>
                  </button>
                </div>
              </div>
              <div className="bg-white rounded-lg p-4 font-mono text-sm">
                <div className="text-xs text-gray-500 mb-1">{tr('rawDdl')}</div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-700 break-all">{sqlEndpoint}</span>
                  <button
                    onClick={() => copyToClipboard(sqlEndpoint)}
                    className="ml-3 text-gray-400 hover:text-gray-600 shrink-0"
                    title={tr('copyBtn')}
                  >
                    <i className="fas fa-copy"></i>
                  </button>
                </div>
              </div>
              <div className="bg-white rounded-lg p-4 font-mono text-sm">
                <div className="text-xs text-gray-500 mb-1">{tr('structDdl')}</div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-700 break-all">
                    {ddlEndpointRoot}
                  </span>
                  <button
                    onClick={() => copyToClipboard(`${ddlEndpointRoot}`)}
                    className="ml-3 text-gray-400 hover:text-gray-600 shrink-0"
                    title={tr('copyBtn')}
                  >
                    <i className="fas fa-copy"></i>
                  </button>
                </div>
              </div>
              <div className="bg-white rounded-lg p-4 font-mono text-sm">
                <div className="text-xs text-gray-500 mb-1">{tr('rpc')}</div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-700 break-all">
                    {rpcEndpointRoot}/<span className="text-purple-600">{'{function}'}</span>
                  </span>
                  <button
                    onClick={() => copyToClipboard(`${rpcEndpointRoot}/`)}
                    className="ml-3 text-gray-400 hover:text-gray-600 shrink-0"
                    title={tr('copyBtn')}
                  >
                    <i className="fas fa-copy"></i>
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* 快速开始三步 */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              {
                step: '1',
                title: tr('step1Title'),
                desc: tr('step1Desc'),
                href: `/workspace/${projectId}/security/api-keys`,
                actionLabel: tr('step1Action'),
                color: 'blue' as const,
              },
              {
                step: '2',
                title: tr('step2Title'),
                desc: tr('step2Desc'),
                onClick: () => setActiveTab('docs'),
                actionLabel: tr('step2Action'),
                color: 'purple' as const,
              },
              {
                step: '3',
                title: tr('step3Title'),
                desc: gatewayMode
                  ? tr('step3DescGw')
                  : tr('step3DescKey'),
                color: 'green' as const,
              },
            ].map((s) => (
              <div
                key={s.step}
                className="bg-white border border-gray-200 rounded-xl p-5 hover:shadow-sm transition-shadow"
              >
                <div className="flex items-center gap-3 mb-3">
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold ${
                      s.color === 'blue'
                        ? 'bg-blue-100 text-blue-600'
                        : s.color === 'purple'
                        ? 'bg-purple-100 text-purple-600'
                        : 'bg-green-100 text-green-600'
                    }`}
                  >
                    {s.step}
                  </div>
                  <h3 className="font-semibold text-gray-900">{s.title}</h3>
                </div>
                <p className="text-sm text-gray-600 mb-3">{s.desc}</p>
                {'href' in s && s.href && (
                  <Link
                    href={s.href}
                    className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                  >
                    {s.actionLabel} <i className="fas fa-arrow-right ml-1 text-xs"></i>
                  </Link>
                )}
                {'onClick' in s && s.onClick && (
                  <button
                    onClick={s.onClick}
                    className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                  >
                    {s.actionLabel} <i className="fas fa-arrow-right ml-1 text-xs"></i>
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* 最小请求示例：表 REST + RPC */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-700">{tr('minExample')}</h3>
              <span className="text-xs text-gray-500">{tr('minExampleHint')}</span>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-gray-200">
              <div>
                <div className="px-4 py-2 bg-gray-50 text-xs font-medium text-gray-600">{tr('tableList')}</div>
                <pre className="p-4 bg-gray-900 text-gray-100 font-mono text-sm overflow-x-auto">
{gatewayMode
  ? `curl "${endpointBase}/${selectedTable || '{table}'}?limit=5"`
  : `curl "${endpointBase}/${selectedTable || '{table}'}?limit=5" \\
  -H "Authorization: Bearer YOUR_API_KEY"`}
                </pre>
              </div>
              <div>
                <div className="px-4 py-2 bg-gray-50 text-xs font-medium text-gray-600">RPC（POST）</div>
                <pre className="p-4 bg-gray-900 text-gray-100 font-mono text-sm overflow-x-auto">
{gatewayMode
  ? `curl -X POST "${rpcEndpointRoot}/my_function" \\
  -H "Content-Type: application/json" \\
  -d '{"arg1": 1}'`
  : `curl -X POST "${rpcEndpointRoot}/my_function" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"arg1": 1}'`}
                </pre>
              </div>
            </div>
          </div>

          {/* 完整接口参考：占位 {table}/{function}，提供整页复制（给 AI 生成调用方法） */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-gray-700">
                  <i className="fas fa-file-code mr-2 text-blue-500"></i>
                  {tr('fullRef')}
                </h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  {tr.rich('fullRefRich', { code: (c: any) => <code className="bg-gray-100 px-1 rounded">{c}</code>, b: (c: any) => <strong>{c}</strong> })}
                </p>
              </div>
              <button
                onClick={() => copyToClipboard(fullDocText)}
                className="btn-primary shrink-0"
                title={tr('copyAllTitle')}
              >
                <i className="fas fa-copy mr-2"></i>
                {tr('copyAll')}
              </button>
            </div>
            <div className="p-5 space-y-3">
              <div className="text-xs font-semibold text-gray-500 tracking-wide flex items-center gap-2">
                <i className="fas fa-table text-blue-500"></i>
                {tr('tableRest')}
                <span className="font-mono font-normal text-gray-400 break-all">
                  {endpointBase}/{'{table}'}
                </span>
              </div>
              {genericTableEndpoints.map((ep, idx) => renderEndpointCard(ep, `gt-${idx}`))}

              <div className="text-xs font-semibold text-gray-500 tracking-wide flex items-center gap-2 pt-3">
                <i className="fas fa-hammer text-amber-600"></i>
                {tr('structDdl')}
                <span className="font-mono font-normal text-gray-400 break-all">
                  {ddlEndpointRoot}
                </span>
              </div>
              {genericDdlEndpoints.map((ep, idx) => renderEndpointCard(ep, `gd-${idx}`))}

              <div className="text-xs font-semibold text-gray-500 tracking-wide flex items-center gap-2 pt-3">
                <i className="fas fa-code text-amber-700"></i>
                {tr('rawDdl')}
                <span className="font-mono font-normal text-gray-400 break-all">{sqlEndpoint}</span>
              </div>
              {genericRawDdlEndpoints.map((ep, idx) => renderEndpointCard(ep, `grd-${idx}`))}

              <div className="text-xs font-semibold text-gray-500 tracking-wide flex items-center gap-2 pt-3">
                <i className="fas fa-terminal text-purple-600"></i>
                {tr('rpc')}
                <span className="font-mono font-normal text-gray-400 break-all">
                  {rpcEndpointRoot}/{'{function}'}
                </span>
              </div>
              {genericRpcEndpoints.map((ep, idx) => renderEndpointCard(ep, `gr-${idx}`))}
            </div>
          </div>
        </div>
      )}

      {/* —— 接口文档 Tab —— */}
      {activeTab === 'docs' && (
        <div className="space-y-6">
          {/* 表选择 */}
          <div className="bg-white border border-gray-200 rounded-xl p-5">
            <h2 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2">
              <i className="fas fa-table text-blue-500"></i>
              {tr('tableRest')}
            </h2>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {tr('selectTable')}
              <span className="ml-2 text-xs text-gray-400 font-normal">
                {tr('fromSchema', { schema: currentSchema })}
              </span>
            </label>
            {tables.length === 0 ? (
              <div className="text-sm text-gray-500 py-2">{tr('noTableInSchema')}</div>
            ) : (
              <select
                value={selectedTable}
                onChange={(e) => setSelectedTable(e.target.value)}
                className="input-base max-w-xs"
              >
                {tables.map((t) => (
                  <option key={t.table_name} value={t.table_name}>
                    {t.table_name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* 端点示例 */}
          {selectedTable && (
            <div className="space-y-4">
              <p className="text-sm text-gray-500 -mt-2 mb-2">
                {tr('pathPrefixLabel')}
                <span className="font-mono text-xs">
                  /api/v1/{databaseSlug}/{currentSchema}/…
                </span>
              </p>
              {[
                {
                  method: 'GET',
                  color: 'green',
                  path: `/${currentSchema}/${selectedTable}`,
                  desc: tr('opList'),
                  body: `curl "${endpointBase}/${selectedTable}?limit=10"${authHeaderLine}`,
                },
                {
                  method: 'GET',
                  color: 'green',
                  path: `/${currentSchema}/${selectedTable}/:id`,
                  desc: tr('opGet'),
                  body: `curl "${endpointBase}/${selectedTable}/1"${authHeaderLine}`,
                },
                {
                  method: 'POST',
                  color: 'blue',
                  path: `/${currentSchema}/${selectedTable}`,
                  desc: tr('opCreate'),
                  body: `curl -X POST "${endpointBase}/${selectedTable}"${authHeaderLine} \\
  -H "Content-Type: application/json" \\
  -d '{"column1": "value1", "column2": "value2"}'`,
                },
                {
                  method: 'PATCH',
                  color: 'yellow',
                  path: `/${currentSchema}/${selectedTable}/:id`,
                  desc: tr('opUpdate'),
                  body: `curl -X PATCH "${endpointBase}/${selectedTable}/1"${authHeaderLine} \\
  -H "Content-Type: application/json" \\
  -d '{"column1": "new_value"}'`,
                },
                {
                  method: 'DELETE',
                  color: 'red',
                  path: `/${currentSchema}/${selectedTable}/:id`,
                  desc: tr('opDelete'),
                  body: `curl -X DELETE "${endpointBase}/${selectedTable}/1"${authHeaderLine}`,
                },
              ].map((ep, idx) => {
                const headerBg = {
                  green: 'bg-green-50',
                  blue: 'bg-blue-50',
                  yellow: 'bg-yellow-50',
                  red: 'bg-red-50',
                  purple: 'bg-purple-50',
                }[ep.color]
                const badgeBg = {
                  green: 'bg-green-500',
                  blue: 'bg-blue-500',
                  yellow: 'bg-yellow-500',
                  red: 'bg-red-500',
                  purple: 'bg-purple-600',
                }[ep.color]
                return (
                  <div
                    key={idx}
                    className="border border-gray-200 rounded-lg overflow-hidden bg-white"
                  >
                    <div
                      className={`px-4 py-3 ${headerBg} border-b border-gray-200 flex items-center justify-between`}
                    >
                      <div className="flex items-center space-x-3">
                        <span
                          className={`px-2 py-1 ${badgeBg} text-white text-xs font-bold rounded`}
                        >
                          {ep.method}
                        </span>
                        <span className="font-mono text-sm">{ep.path}</span>
                        <span className="text-gray-500 text-sm">{ep.desc}</span>
                      </div>
                      <button
                        onClick={() => copyToClipboard(ep.body)}
                        className="text-gray-400 hover:text-gray-600 text-sm"
                        title={tr('copyExample')}
                      >
                        <i className="fas fa-copy"></i>
                      </button>
                    </div>
                    <pre className="p-4 bg-gray-900 text-gray-100 font-mono text-sm overflow-x-auto">
                      {ep.body}
                    </pre>
                  </div>
                )
              })}
            </div>
          )}

          {/* 表结构 DDL */}
          <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <i className="fas fa-hammer text-amber-600"></i>
                {tr('structDdl')}
              </h2>
              <p className="text-sm text-gray-500 mt-1">
                {tr.rich('structDdlRich', { code: (c: any) => <span className="font-mono text-xs">{c}</span>, b: (c: any) => <strong>{c}</strong>, schema: currentSchema })}
              </p>
            </div>
            {genericDdlEndpoints.map((ep, idx) => renderEndpointCard(ep, `doc-ddl-${idx}`))}
          </div>

          <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <i className="fas fa-code text-amber-700"></i>
                {tr('rawDdl')}
              </h2>
              <p className="text-sm text-gray-500 mt-1">
                {tr.rich('rawDdlRich', { code: (c: any) => <span className="font-mono text-xs">{c}</span>, b: (c: any) => <strong>{c}</strong> })}
              </p>
            </div>
            {genericRawDdlEndpoints.map((ep, idx) => renderEndpointCard(ep, `doc-raw-ddl-${idx}`))}
          </div>

          {/* RPC：与 PostgREST / Supabase 一致 */}
          <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-5">
            <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
              <div className="space-y-2">
                <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                  <i className="fas fa-terminal text-purple-600"></i>
                  {tr('rpc')}
                </h2>
                <p className="text-sm text-gray-600 max-w-3xl leading-relaxed">
                  {tr('rpcDescRich')}{' '}
                  <code className="text-xs bg-gray-100 px-1 rounded">/api/v1/{databaseSlug}/rpc/&lt;name&gt;</code>
                  {' '}
                  {tr.rich('rpcSemanticsRich', { code: (c: any) => <span className="font-mono text-xs">{c}</span>, b: (c: any) => <strong>{c}</strong>, schema: currentSchema })}
                </p>
                <p className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                  <i className="fas fa-key mr-1.5"></i>
                  {tr.rich('rpcKeyRich', { code: (c: any) => <span className="font-mono text-xs">{c}</span>, b: (c: any) => <strong>{c}</strong>, schema: currentSchema })}
                </p>
              </div>
              <Link
                href={`/workspace/${projectId}/rpc`}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-purple-200 bg-purple-50 text-purple-800 text-sm font-medium hover:bg-purple-100 shrink-0"
              >
                <i className="fas fa-flask"></i>
                {tr('rpcCaller')}
              </Link>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                {tr('rpcFnExample')}
              </label>
              <input
                type="text"
                value={rpcDocFunctionName}
                onChange={(e) => setRpcDocFunctionName(e.target.value)}
                className="input-base max-w-lg font-mono text-sm"
                placeholder="my_rpc_function"
                spellCheck={false}
              />
            </div>

            <div className="space-y-4">
              {[
                {
                  method: 'POST',
                  color: 'blue' as const,
                  path: `/api/v1/${databaseSlug}/rpc/${rpcFnEncoded}`,
                  desc: tr('rpcModePost'),
                  body: rpcPostCurl,
                },
                {
                  method: 'GET',
                  color: 'green' as const,
                  path: `/api/v1/${databaseSlug}/rpc/${rpcFnEncoded}`,
                  desc: tr('rpcModeGet'),
                  body: rpcGetCurl,
                },
                {
                  method: 'POST',
                  color: 'purple' as const,
                  path: `/api/v1/${databaseSlug}/rpc/${rpcFnEncoded}`,
                  desc: tr('rpcModeSingle'),
                  body: rpcPreferCurl,
                },
              ].map((ep, idx) => {
                const headerBg = {
                  green: 'bg-green-50',
                  blue: 'bg-blue-50',
                  yellow: 'bg-yellow-50',
                  red: 'bg-red-50',
                  purple: 'bg-purple-50',
                }[ep.color]
                const badgeBg = {
                  green: 'bg-green-500',
                  blue: 'bg-blue-500',
                  yellow: 'bg-yellow-500',
                  red: 'bg-red-500',
                  purple: 'bg-purple-600',
                }[ep.color]
                return (
                  <div
                    key={`rpc-${idx}`}
                    className="border border-gray-200 rounded-lg overflow-hidden bg-white"
                  >
                    <div
                      className={`px-4 py-3 ${headerBg} border-b border-gray-200 flex items-center justify-between`}
                    >
                      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                        <span
                          className={`px-2 py-1 ${badgeBg} text-white text-xs font-bold rounded`}
                        >
                          {ep.method}
                        </span>
                        <span className="font-mono text-sm break-all">{ep.path}</span>
                        <span className="text-gray-500 text-sm">{ep.desc}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(ep.body)}
                        className="text-gray-400 hover:text-gray-600 text-sm shrink-0 p-1"
                        title={tr('copyExample')}
                      >
                        <i className="fas fa-copy"></i>
                      </button>
                    </div>
                    <pre className="p-4 bg-gray-900 text-gray-100 font-mono text-sm overflow-x-auto">
                      {ep.body}
                    </pre>
                  </div>
                )
              })}
            </div>

            {gatewayMode ? (
              <p className="text-xs text-gray-500 border-t border-gray-100 pt-4">
                {tr('authGwFull')}
              </p>
            ) : (
              <p className="text-xs text-gray-500 border-t border-gray-100 pt-4">
                {tr.rich('authKeyRich', { code: (c: any) => <span className="font-mono text-xs">{c}</span>, b: (c: any) => <strong>{c}</strong> })}
              </p>
            )}
          </div>

          {/* 查询参数说明 */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">{tr('queryParams')}</h2>
              <p className="text-sm text-gray-500">
                {tr('queryParamsDesc')}
              </p>
            </div>
            <div className="p-6">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b border-gray-200">
                    <th className="pb-3 font-medium text-gray-700">{tr('colParam')}</th>
                    <th className="pb-3 font-medium text-gray-700">{tr('colDesc')}</th>
                    <th className="pb-3 font-medium text-gray-700">{tr('colExample')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  <tr>
                    <td className="py-3 font-mono text-blue-600">select</td>
                    <td className="py-3 text-gray-600">{tr('qpSelect')}</td>
                    <td className="py-3 font-mono text-gray-500">?select=id,name,email</td>
                  </tr>
                  <tr>
                    <td className="py-3 font-mono text-blue-600">order</td>
                    <td className="py-3 text-gray-600">{tr('qpOrder')}</td>
                    <td className="py-3 font-mono text-gray-500">?order=created_at.desc</td>
                  </tr>
                  <tr>
                    <td className="py-3 font-mono text-blue-600">limit</td>
                    <td className="py-3 text-gray-600">{tr('qpLimit')}</td>
                    <td className="py-3 font-mono text-gray-500">?limit=20</td>
                  </tr>
                  <tr>
                    <td className="py-3 font-mono text-blue-600">offset</td>
                    <td className="py-3 text-gray-600">{tr('qpOffset')}</td>
                    <td className="py-3 font-mono text-gray-500">?offset=20</td>
                  </tr>
                  <tr>
                    <td className="py-3 font-mono text-blue-600">field.eq</td>
                    <td className="py-3 text-gray-600">{tr('qpEq')}</td>
                    <td className="py-3 font-mono text-gray-500">?status.eq=active</td>
                  </tr>
                  <tr>
                    <td className="py-3 font-mono text-blue-600">field.neq</td>
                    <td className="py-3 text-gray-600">{tr('qpNeq')}</td>
                    <td className="py-3 font-mono text-gray-500">?status.neq=deleted</td>
                  </tr>
                  <tr>
                    <td className="py-3 font-mono text-blue-600">field.gt/gte</td>
                    <td className="py-3 text-gray-600">{tr('qpGt')}</td>
                    <td className="py-3 font-mono text-gray-500">?age.gte=18</td>
                  </tr>
                  <tr>
                    <td className="py-3 font-mono text-blue-600">field.lt/lte</td>
                    <td className="py-3 text-gray-600">{tr('qpLt')}</td>
                    <td className="py-3 font-mono text-gray-500">?price.lt=100</td>
                  </tr>
                  <tr>
                    <td className="py-3 font-mono text-blue-600">field.like</td>
                    <td className="py-3 text-gray-600">{tr('qpLike')}</td>
                    <td className="py-3 font-mono text-gray-500">?name.like=%john%</td>
                  </tr>
                  <tr>
                    <td className="py-3 font-mono text-blue-600">field.ilike</td>
                    <td className="py-3 text-gray-600">{tr('qpIlike')}</td>
                    <td className="py-3 font-mono text-gray-500">?name.ilike=%john%</td>
                  </tr>
                  <tr>
                    <td className="py-3 font-mono text-blue-600">field.in</td>
                    <td className="py-3 text-gray-600">{tr('qpIn')}</td>
                    <td className="py-3 font-mono text-gray-500">?status.in=active,pending</td>
                  </tr>
                  <tr>
                    <td className="py-3 font-mono text-blue-600">count</td>
                    <td className="py-3 text-gray-600">{tr('qpCount')}</td>
                    <td className="py-3 font-mono text-gray-500">?select=count</td>
                  </tr>
                  <tr>
                    <td className="py-3 font-mono text-blue-600">{tr('aggLabel')}</td>
                    <td className="py-3 text-gray-600">{tr('qpAgg')}</td>
                    <td className="py-3 font-mono text-gray-500">?select=amount.sum,amount.avg</td>
                  </tr>
                  <tr>
                    <td className="py-3 font-mono text-blue-600">{tr('groupLabel')}</td>
                    <td className="py-3 text-gray-600">{tr('qpGroup')}</td>
                    <td className="py-3 font-mono text-gray-500">?select=status,count</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

