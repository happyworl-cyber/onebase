'use client'

/**
 * 工作流管理器（列表 + 可视化编辑器）。
 *
 * 入口：`/workspace/[projectId]/automation/workflows`（项目工作区，WorkspaceSidebar）。
 * 老后台 `/dashboard/workflows` 已在 W2/W3 收尾时删除，旧链接由 dashboard catch-all
 * 重定向到 workspace 版（见 `app/dashboard/[...slug]/page.tsx`）。
 *
 * 走 `/api/admin/workflows` 接口；workspace 进入时带上 `defaultDatabaseId`
 * （当前项目主连接的 database_id），列表按该库过滤，新建工作流也自动预填。
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import dynamic from 'next/dynamic'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import api, { tenantAPI } from '@/lib/api'
import { usePublicApiConfig } from '@/lib/apiBase'
import { copyTextToClipboard } from '@/lib/clipboard'
import { formatDateTime } from '@/lib/utils'
import { useAppStore } from '@/lib/store'
import type { WorkflowNodeDef, WorkflowEdgeDef } from '@/components/workflow/WorkflowCanvas'
import WorkflowEditorHeader, {
  type WorkflowDependencies,
  type WorkflowDepsStatus,
} from '@/components/workflow/WorkflowEditorHeader'
import WorkflowDocContent, {
  deriveDocModel,
  buildDocMarkdown,
  CopyButton,
  CopyMarkdownButton,
} from '@/components/workflow/WorkflowDocContent'
import WorkflowListView from '@/components/workflow/list/WorkflowListView'
import WorkflowConfirmDialog from '@/components/workflow/list/WorkflowConfirmDialog'
import { showToast } from '@/components/Toast'
import {
  catNamesFromId,
  deptNameFromId,
  editorCategoryOptions,
  editorDepartmentOptions,
  formatWorkflowPlacement,
  resolveWorkflowTaxonomy,
  SHARED_DEPARTMENT_NAME,
  type WorkflowGroupCount,
} from '@/components/workflow/list/utils'
import { fetchWorkflowSummary, fetchWorkflowsByCategory } from '@/components/workflow/list/listApi'
import { downloadWorkflowJson, auditWorkflowExport } from '@/components/workflow/list/exportUtils'
import { fetchApiFolders, type ApiWorkflowFolder } from '@/components/workflow/list/folderApi'
import { UNCATEGORIZED_FOLDER_NAME } from '@/components/workflow/list/types'

// 来自 /api/tenants/my-connections 的一行连接信息（数据库下拉数据源）。
interface ConnRow {
  tenant_id: number
  tenant_name: string
  database_id: number
  database_slug?: string | null
  connection_name: string
  db_host: string
  db_port: number
  db_name: string
  is_primary: boolean
}

const WorkflowCanvas = dynamic(() => import('@/components/workflow/WorkflowCanvas'), { ssr: false })

interface Workflow {
  id: number
  name: string
  slug: string
  description: string | null
  category: string | null
  department: string | null
  database_id: number | null
  trigger_type: string
  trigger_config: any
  nodes: WorkflowNodeDef[]
  edges: WorkflowEdgeDef[]
  dependencies?: WorkflowDependencies | null
  is_enabled: boolean
  timeout_ms: number
  max_retries: number
  alert_webhook_url: string | null
  alert_webhook_template: Record<string, unknown> | null
  alert_throttle_hours: number
  last_alert_sent_at: string | null
  created_by: number | null
  created_by_name: string | null
  created_by_email: string | null
  created_at: string
  updated_at: string
}
interface WorkflowFormMeta {
  name: string
  slug: string
  description: string
  department: string
  category: string
  database_id: string
  trigger_type: string
  trigger_config: string
  timeout_ms: number
  max_retries: number
  alert_webhook_url: string
  alert_webhook_template: string
  alert_throttle_hours: number
  last_alert_sent_at: string | null
}

/**
 * 编辑器草稿：把「正在编辑」的完整状态镜像到 sessionStorage。
 *
 * 动机：编辑器的开合是组件内存态（view/editing/...），URL 不变。多 Tab 场景下
 * KeepAliveOutlet 通常能保活，但当浏览器把非激活页丢弃/刷新（如 Chrome 省内存模式）
 * 后再切回时，组件会重新挂载并回落到列表页，未保存的改动一并丢失。把草稿写入
 * sessionStorage（随本 Tab 会话存活），挂载时若有草稿即恢复到原编辑页。
 */
interface EditorDraft {
  view: 'editor'
  editing: Workflow | null
  formMeta: WorkflowFormMeta
  editorNodes: WorkflowNodeDef[]
  editorEdges: WorkflowEdgeDef[]
  workflowDependencies: WorkflowDependencies | null
  depsStatus: WorkflowDepsStatus | null
  pyDepsStatus: WorkflowDepsStatus | null
  saveNote: string
}

const EDITOR_DRAFT_KEY_PREFIX = 'onebase:wf-editor-draft:'

function editorDraftKey(databaseId?: number | null): string {
  return `${EDITOR_DRAFT_KEY_PREFIX}${databaseId ?? 'default'}`
}

function readEditorDraft(databaseId?: number | null): EditorDraft | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(editorDraftKey(databaseId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && parsed.view === 'editor' ? (parsed as EditorDraft) : null
  } catch {
    return null
  }
}

function writeEditorDraft(databaseId: number | null | undefined, draft: EditorDraft): void {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.setItem(editorDraftKey(databaseId), JSON.stringify(draft))
  } catch {
    /* 配额/隐私模式等失败时静默降级：保活失效但不影响正常编辑 */
  }
}

function clearEditorDraft(databaseId?: number | null): void {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.removeItem(editorDraftKey(databaseId))
  } catch {
    /* ignore */
  }
}

interface WorkflowRun {
  id: number
  workflow_id: number
  trigger_type: string
  status: string
  node_results: any[]
  final_output: any
  error_message: string | null
  elapsed_ms: number | null
  started_at: string
  completed_at: string | null
}

const TRIGGER_TYPES = [
  { value: 'endpoint', label: 'HTTP 端点', icon: '🌐', desc: 'POST /workflow/:project/:workflow_slug' },
  { value: 'hook', label: '数据变更', icon: '⚡', desc: '监听表 CRUD 自动触发' },
  { value: 'notify', label: 'PG NOTIFY', icon: '📣', desc: '监听业务库 LISTEN/NOTIFY 自动触发' },
  { value: 'cron', label: '定时任务', icon: '⏰', desc: '按 Cron 表达式定期执行' },
  { value: 'kafka', label: 'Kafka 消息', icon: '📨', desc: '消费 Kafka Topic 消息自动触发' },
  { value: 'manual', label: '手动触发', icon: '👆', desc: '仅通过面板手动执行' },
]

const DEFAULT_ALERT_WEBHOOK_TEMPLATE = JSON.stringify(
  {
    msg_type: 'markdown',
    content:
      '### 🚨 报警\n- **类型**: {{source}}\n- **名称**: {{name}}\n- **状态**: {{status}}\n- **错误**: {{error}}\n- **时间**: {{time}}\n- **Run ID**: {{run_id}}',
  },
  null,
  2,
)

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  running: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
}

const JSON_OBJECT_FIELDS_BY_NODE: Record<string, string[]> = {
  call_workflow: ['input'],
  http_call: ['headers'],
  response: ['headers'],
  kafka: ['headers'],
}

const JSON_FIELDS_BY_NODE: Record<string, string[]> = {
  http_call: ['body'],
  response: ['body'],
  sse_publish: ['data'],
}

// 整段模板表达式（`{{...}}`，且只出现一次）在运行时由后端 resolve_template 先解析成
// 原始类型（object/array/...）再交给 parse_json_field，因此保存前不能按字面 JSON 校验，
// 否则像 body: "{{clean_body}}" 这种引用会被误判为「不是合法 JSON」。
function isWholeTemplateExpr(text: string): boolean {
  return text.startsWith('{{') && text.endsWith('}}') && text.slice(2).indexOf('{{') === -1
}

function parseNodeJsonField(
  nodeId: string,
  nodeType: string,
  field: string,
  value: unknown,
  requireObject: boolean,
): unknown {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!text) return requireObject ? {} : value
  if (isWholeTemplateExpr(text)) return value
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`节点 ${nodeId}（${nodeType}）字段 ${field} 不是合法 JSON`)
  }
  if (
    requireObject &&
    (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object')
  ) {
    throw new Error(`节点 ${nodeId}（${nodeType}）字段 ${field} 必须是 JSON 对象`)
  }
  return parsed
}

function normalizeNodesForExecution(nodes: WorkflowNodeDef[]): WorkflowNodeDef[] {
  return nodes.map((node) => {
    const config = { ...(node.config || {}) } as Record<string, unknown>
    for (const field of JSON_OBJECT_FIELDS_BY_NODE[node.type] || []) {
      if (field in config) {
        config[field] = parseNodeJsonField(node.id, node.type, field, config[field], true)
      }
    }
    for (const field of JSON_FIELDS_BY_NODE[node.type] || []) {
      if (field in config) {
        config[field] = parseNodeJsonField(node.id, node.type, field, config[field], false)
      }
    }
    return { ...node, config }
  })
}

interface NodeResultItem {
  node_id: string
  status: string
  input?: unknown
  output?: unknown
  elapsed_ms?: number
  error?: string | null
  branch?: string | null
  node_type?: string | null
}

/** 从节点输出中提取简短摘要，便于在折叠状态下定位问题节点 */
function extractOutputHint(output: unknown): string | null {
  if (output == null || typeof output !== 'object') return null
  const obj = output as Record<string, unknown>
  const body = obj.body && typeof obj.body === 'object' ? (obj.body as Record<string, unknown>) : null
  for (const key of ['msg', 'message', 'error', 'result']) {
    const val = obj[key] ?? body?.[key]
    if (val != null && String(val).trim()) return String(val)
  }
  return null
}

function NodeResultCard({ nr, defaultOpen = false }: { nr: NodeResultItem; defaultOpen?: boolean }) {
  const hint = extractOutputHint(nr.output)
  const borderClass =
    nr.status === 'success' ? 'border-green-200 bg-green-50/40'
    : nr.status === 'failed' ? 'border-red-200 bg-red-50/40'
    : nr.status === 'failed_allowed' ? 'border-amber-200 bg-amber-50/40'
    : 'border-gray-200 bg-gray-50'
  const statusClass =
    nr.status === 'success' ? 'bg-green-100 text-green-700'
    : nr.status === 'failed' ? 'bg-red-100 text-red-700'
    : nr.status === 'failed_allowed' ? 'bg-amber-100 text-amber-700'
    : 'bg-gray-100 text-gray-500'
  const statusLabel = nr.status === 'failed_allowed' ? '失败(已容错)' : nr.status

  return (
    <details open={defaultOpen} className={`border rounded-lg text-xs ${borderClass}`}>
      <summary className="p-3 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-mono font-medium text-gray-700 shrink-0">{nr.node_id}</span>
            {nr.node_type && <span className="text-gray-400 shrink-0">{nr.node_type}</span>}
            {hint && (
              <span className={`truncate ${nr.status === 'failed' ? 'text-red-600' : 'text-amber-700'}`} title={hint}>
                · {hint}
              </span>
            )}
            {nr.status === 'failed_allowed' && !hint && (
              <span className="truncate text-amber-700" title={nr.error || ''}>· 已容错（allow_failure）</span>
            )}
          </div>
          <span className="flex items-center gap-2 shrink-0">
            {!!(nr.output && typeof nr.output === 'object' && (nr.output as Record<string, unknown>).dry_run === true) && (
              <span className="px-1.5 py-0.5 rounded bg-sky-100 text-sky-700">已跳过</span>
            )}
            {nr.branch && <span className="text-indigo-500">→ {nr.branch}</span>}
            <span className={`px-1.5 py-0.5 rounded ${statusClass}`}>{statusLabel}</span>
            <span className="text-gray-400">{nr.elapsed_ms ?? 0}ms</span>
          </span>
        </div>
      </summary>
      <div className="px-3 pb-3 border-t border-black/5">
        {nr.error && <p className="text-red-600 mt-2 font-mono">{nr.error}</p>}
        {nr.input != null && (
          <>
            <div className="mt-2 text-[11px] font-medium text-gray-500">入参（实际传递的参数）</div>
            <pre className="mt-1 p-2 bg-white border rounded font-mono overflow-auto max-h-48 text-[11px] leading-relaxed">
              {JSON.stringify(nr.input, null, 2)}
            </pre>
          </>
        )}
        {nr.output != null && (
          <>
            <div className="mt-2 text-[11px] font-medium text-gray-500">输出（对方响应）</div>
            <pre className="mt-1 p-2 bg-white border rounded font-mono overflow-auto max-h-48 text-[11px] leading-relaxed">
              {JSON.stringify(nr.output, null, 2)}
            </pre>
          </>
        )}
      </div>
    </details>
  )
}

function NodeResultList({ results }: { results: NodeResultItem[] }) {
  if (!results?.length) {
    return <p className="text-xs text-gray-400">没有节点结果</p>
  }
  return (
    <div className="space-y-2">
      {results.map((nr, idx) => (
        <NodeResultCard
          key={`${nr.node_id}-${idx}`}
          nr={nr}
          defaultOpen={nr.status === 'failed' || nr.status === 'failed_allowed' || !!extractOutputHint(nr.output)}
        />
      ))}
    </div>
  )
}

// MCP 接入教程：指导用户把本实例接入本地 AI 客户端，让 AI 创作/调试工作流。
// 接入地址取当前页面 origin——测试/生产是独立部署（不同域名），在哪个环境打开本页，
// 教程里的 URL 就指向哪个环境，无需手动区分。
function McpGuideModal({ onClose }: { onClose: () => void }) {
  const base = typeof window !== 'undefined' ? window.location.origin : ''
  const mcpUrl = `${base}/mcp`
  const claudeCmd = `claude mcp add --transport http onebase ${mcpUrl} --header "Authorization: Bearer crm_你的令牌"`
  const genericConfig = JSON.stringify(
    {
      mcpServers: {
        onebase: {
          type: 'http',
          url: mcpUrl,
          headers: { Authorization: 'Bearer crm_你的令牌' },
        },
      },
    },
    null,
    2,
  )

  // 整份接入指南拼成 Markdown，供「复制全部」一次性带走喂 AI。
  const mcpMarkdown = useMemo(() => [
    '# OneBase MCP 接入指南',
    '',
    '让 AI 客户端（Claude Code 等）接入 OneBase，由 AI 创作 / 调试工作流。',
    '',
    '## 接入地址（当前环境）',
    mcpUrl,
    '',
    '> 测试与生产独立部署：在哪个环境打开页面，地址即指向该环境。非生产实例 AI 可真实增删改查调试；生产实例仅允许干跑 + 只读查询，写操作被引擎拦截。',
    '',
    '## 第一步 · 生成个人访问令牌（PAT）',
    '前往「安全 → API Key」页面底部「个人访问令牌」区块，点「生成令牌」。令牌以 `crm_` 开头（MCP 专用，区别于平台令牌的 `crp_`），明文只显示一次，请立即复制；可随时吊销。',
    '',
    '## 第二步 · 接入 AI 客户端',
    '',
    'Claude Code（终端执行，替换为你的令牌）：',
    '```bash',
    claudeCmd,
    '```',
    '',
    '其他支持 MCP 的客户端（Cursor 等）通用 HTTP 配置：',
    '```json',
    genericConfig,
    '```',
    '',
    '## 第三步 · 跟 AI 说需求',
    '重开一个 AI 会话，直接描述接口需求，例如：',
    '> 帮我在 onebase 建一个工作流：按用户 ID 查询最近 10 笔订单，调试通过后给我接口文档',
    '',
    'AI 会：读节点规范 → 创建工作流（创建即启用）→ 调试验证 → 生成接口文档。如需下线在页面禁用即可（启停留人）。',
    '',
    '## AI 可用工具',
    '- `node_spec`：节点规范知识库（写定义前必读）',
    '- `list_workflows` / `get_workflow`：查列表 / 查完整定义',
    '- `create_workflow`：创建（创建即启用，下线归人）',
    '- `update_workflow`：更新（不能改启用状态）',
    '- `debug_workflow`：调试试跑，默认干跑；真实执行受环境护栏约束',
    '- `workflow_api_doc`：生成入参清单 + curl 示例',
    '- `get_workflow_runs`：查执行历史排错',
    '- `duplicate_workflow`：复制一个已有工作流为新副本（强制禁用态，启用归人）',
    '- `list_workflow_versions`：查询工作流版本历史（仅元信息）',
    '- `get_workflow_version`：获取工作流某个历史版本的完整快照',
  ].join('\n'), [mcpUrl, claudeCmd, genericConfig])

  return (
    <div data-alt="mcp-guide-modal" className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative bg-white w-[720px] max-w-[92vw] max-h-[85vh] rounded-xl shadow-xl flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b flex items-center justify-between shrink-0">
          <div>
            <h3 className="font-semibold text-gray-800">MCP 接入 · 让你的 AI 来写工作流</h3>
            <p className="text-xs text-gray-400 mt-0.5">把 OneBase 接入本地 AI 客户端（Claude Code 等），描述需求即可由 AI 创作、调试工作流</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <CopyMarkdownButton text={mcpMarkdown} />
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
          </div>
        </div>

        <div className="p-6 overflow-y-auto space-y-6 text-sm text-gray-700">
          {/* 接入地址 */}
          <section>
            <h4 className="font-semibold text-gray-900 mb-2">接入地址（当前环境）</h4>
            <div className="flex items-center gap-2 flex-wrap">
              <code className="text-xs bg-gray-100 px-2 py-1 rounded font-mono break-all flex-1 min-w-0">{mcpUrl}</code>
              <CopyButton text={mcpUrl} />
            </div>
            <p className="text-xs text-gray-500 mt-2 leading-relaxed">
              测试与生产是独立部署：<strong>在哪个环境打开本页，这里就是哪个环境的地址</strong>。
              两个环境都要用的话，分别打开各自的页面按本教程接入一次（建议各生成各的令牌）。
              非生产实例 AI 可真实增删改查调试；生产实例只允许干跑 + 只读查询，写操作会被引擎拦截。
            </p>
          </section>

          {/* 第一步：令牌 */}
          <section>
            <h4 className="font-semibold text-gray-900 mb-2">第一步 · 生成个人访问令牌（PAT）</h4>
            <p className="text-xs text-gray-600 leading-relaxed">
              前往 <strong>安全 → API Key</strong> 页面底部的「<strong>个人访问令牌</strong>」区块，点「生成令牌」。
              令牌为 <code className="bg-gray-100 px-1 rounded font-mono">crm_</code> 开头（MCP 专用，区别于平台令牌的 <code className="bg-gray-100 px-1 rounded font-mono">crp_</code>），<strong>明文只显示一次</strong>，
              请立即复制；泄露或不用了可随时在同一页面吊销。
            </p>
          </section>

          {/* 第二步：接入 */}
          <section>
            <h4 className="font-semibold text-gray-900 mb-2">第二步 · 接入你的 AI 客户端</h4>
            <p className="text-xs text-gray-500 mb-2">Claude Code（终端执行，令牌替换成第一步生成的）：</p>
            <div className="relative">
              <pre className="text-xs bg-gray-900 text-gray-100 rounded-lg p-3 overflow-x-auto font-mono whitespace-pre-wrap break-all">{claudeCmd}</pre>
              <div className="absolute top-2 right-2"><CopyButton text={claudeCmd} /></div>
            </div>
            <p className="text-xs text-gray-500 mt-3 mb-2">其他支持 MCP 的客户端（Cursor 等），用通用 HTTP 配置：</p>
            <div className="relative">
              <pre className="text-xs bg-gray-900 text-gray-100 rounded-lg p-3 overflow-x-auto font-mono">{genericConfig}</pre>
              <div className="absolute top-2 right-2"><CopyButton text={genericConfig} /></div>
            </div>
          </section>

          {/* 第三步：使用 */}
          <section>
            <h4 className="font-semibold text-gray-900 mb-2">第三步 · 跟 AI 说需求</h4>
            <p className="text-xs text-gray-600 leading-relaxed mb-2">
              重开一个 AI 会话，直接描述接口需求，例如：
            </p>
            <blockquote className="text-xs bg-indigo-50 text-indigo-800 rounded-lg px-3 py-2 leading-relaxed">
              "帮我在 onebase 建一个工作流：按用户 ID 查询最近 10 笔订单，调试通过后给我接口文档"
            </blockquote>
            <p className="text-xs text-gray-500 mt-2 leading-relaxed">
              AI 会自动完成：读节点规范 → 创建工作流（<strong>创建即启用</strong>）→ 调试验证 → 生成接口文档。
              如需下线，在本页面点<strong>禁用</strong>即可——启停始终在人手里。
            </p>
          </section>

          {/* 工具清单 */}
          <section>
            <h4 className="font-semibold text-gray-900 mb-2">AI 可用的工具（11 个）</h4>
            <table className="w-full text-xs border-separate border-spacing-0">
              <tbody>
                {[
                  ['node_spec', '节点规范知识库（AI 写定义前必读）'],
                  ['list_workflows / get_workflow', '查列表 / 查完整定义'],
                  ['create_workflow', '创建（创建即启用，下线归人）'],
                  ['update_workflow', '更新（不能改启用状态）'],
                  ['duplicate_workflow', '复制一个已有工作流为新副本（强制禁用态，启用归人）'],
                  ['debug_workflow', '调试试跑，默认干跑；真实执行受环境护栏约束'],
                  ['workflow_api_doc', '生成入参清单 + curl 示例'],
                  ['get_workflow_runs', '查执行历史排错'],
                  ['list_workflow_versions', '查询工作流版本历史（仅元信息）'],
                  ['get_workflow_version', '获取历史版本完整快照（含 nodes/edges）'],
                ].map(([name, desc]) => (
                  <tr key={name}>
                    <td className="py-1 pr-3 font-mono text-indigo-700 whitespace-nowrap align-top">{name}</td>
                    <td className="py-1 text-gray-600">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </div>
  )
}

// 接口文档「分享」按钮：生成 / 展示 / 关闭一个免登录的公开文档链接（<origin>/doc/<token>）。
// 未保存的新工作流（无 id）置灰，提示先保存。
function ShareDocButton({ workflowId }: { workflowId: number | null }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const shareUrl = token && typeof window !== 'undefined' ? `${window.location.origin}/doc/${token}` : ''

  const loadState = useCallback(async () => {
    if (workflowId == null) return
    setLoading(true)
    try {
      const res = await api.get(`/api/admin/workflows/${workflowId}/doc-share`)
      setToken(res.data?.share_token ?? null)
      setEnabled(!!res.data?.share_enabled)
      setLoaded(true)
    } catch {
      showToast('error', '读取分享状态失败')
    } finally {
      setLoading(false)
    }
  }, [workflowId])

  const toggleOpen = () => {
    const next = !open
    setOpen(next)
    if (next && !loaded && workflowId != null) loadState()
  }

  const setShare = async (nextEnabled: boolean) => {
    if (workflowId == null) return
    setLoading(true)
    try {
      const res = await api.post(`/api/admin/workflows/${workflowId}/doc-share`, { enabled: nextEnabled })
      setToken(res.data?.share_token ?? null)
      setEnabled(!!res.data?.share_enabled)
      setLoaded(true)
    } catch {
      showToast('error', '操作失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  if (workflowId == null) {
    return (
      <button
        disabled
        title="请先保存工作流，再生成分享链接"
        className="px-3 py-1.5 text-xs border border-gray-200 text-gray-300 rounded-lg font-medium cursor-not-allowed inline-flex items-center gap-1.5 shrink-0"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" /></svg>
        分享
      </button>
    )
  }

  return (
    <div className="relative shrink-0">
      <button
        onClick={toggleOpen}
        className="px-3 py-1.5 text-xs border border-gray-300 text-gray-600 rounded-lg font-medium hover:bg-gray-100 inline-flex items-center gap-1.5"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" /></svg>
        {enabled ? '已分享' : '分享'}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-white border rounded-xl shadow-xl p-4 z-10 text-left" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between mb-2">
            <h5 className="font-semibold text-gray-800 text-sm">公开分享</h5>
            <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
          </div>
          <p className="text-xs text-gray-500 leading-relaxed mb-3">
            生成一个免登录的公开链接，任何人打开都能查看这份接口文档（只读、实时、不含任何密钥）。可随时关闭使其失效。
          </p>
          {loading && !loaded ? (
            <p className="text-xs text-gray-400">加载中…</p>
          ) : enabled && shareUrl ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <code className="text-xs bg-gray-100 px-2 py-1.5 rounded font-mono break-all flex-1 min-w-0">{shareUrl}</code>
                <CopyButton text={shareUrl} />
              </div>
              <div className="flex items-center gap-2">
                <a href={shareUrl} target="_blank" rel="noreferrer" className="text-xs text-indigo-600 hover:underline">在新标签打开</a>
                <span className="text-gray-300">·</span>
                <button onClick={() => setShare(false)} disabled={loading} className="text-xs text-red-500 hover:text-red-600 disabled:opacity-50">关闭分享</button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShare(true)}
              disabled={loading}
              className="w-full px-3 py-2 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium disabled:opacity-50"
            >
              {loading ? '生成中…' : '生成公开链接'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// 当前工作流的「接口文档」：根据正在编辑的定义自动推导调用方式、入参、返回值。
function WorkflowDocModal({
  meta,
  nodes,
  dbSlug,
  projectId = null,
  rightOffset = 0,
  workflowId = null,
  onClose,
}: {
  meta: {
    name: string
    slug: string
    description: string
    trigger_type: string
    trigger_config: string
    timeout_ms: number
  }
  nodes: WorkflowNodeDef[]
  dbSlug: string
  projectId?: number | null
  rightOffset?: number
  workflowId?: number | null
  onClose: () => void
}) {
  // 对外调用基址走运行期解析：项目级(网关域名) > 平台级 > 构建期 NEXT_PUBLIC_API_URL > 浏览器 origin。
  // gatewayMode：配了网关域名时，接口文档隐藏 API Key 鉴权头（网关统一鉴权）。
  const { apiBase, gatewayMode } = usePublicApiConfig(projectId ?? undefined)
  const model = useMemo(() => deriveDocModel(meta, nodes, dbSlug), [meta, nodes, dbSlug])
  const docMarkdown = useMemo(() => buildDocMarkdown(model, apiBase, gatewayMode), [model, apiBase, gatewayMode])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ paddingRight: rightOffset }} onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative bg-white w-[720px] max-w-[92vw] max-h-[85vh] rounded-xl shadow-xl flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b flex items-center justify-between shrink-0">
          <div>
            <h3 className="font-semibold text-gray-800">接口文档 · {meta.name || '未命名工作流'}</h3>
            <p className="text-xs text-gray-400 mt-0.5">外部系统接入与调试说明</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <ShareDocButton workflowId={workflowId} />
            <CopyMarkdownButton text={docMarkdown} />
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
          </div>
        </div>

        <div className="p-6 overflow-y-auto">
          <WorkflowDocContent model={model} apiBase={apiBase} gatewayMode={gatewayMode} />
        </div>
      </div>
    </div>
  )
}

// 列表筛选用的小胶囊按钮 —— 已迁移至 WorkflowListView / WorkflowListToolbar

export interface WorkflowsManagerProps {
  /** workspace 场景下传入当前项目的 database_id，用于列表过滤和新建预填。 */
  defaultDatabaseId?: number | null
  /** workspace 的 projectId（tenants.id），用于拼编辑深链。 */
  projectId?: number | null
}

function buildWorkflowEditorUrl(projectId: number, workflowId: number): string {
  return `${window.location.origin}/workspace/${projectId}/automation/workflows?workflowId=${workflowId}`
}

export default function WorkflowsManager({
  defaultDatabaseId,
  projectId = null,
}: WorkflowsManagerProps = {}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const currentProject = useAppStore((s) => s.currentProject)
  // 挂载时读取一次编辑器草稿（若有），用于把各编辑态初始化回原编辑页。
  // 若 URL 带分享深链 workflowId，优先深链，不用草稿抢占编辑器。
  const initialDraftRef = useRef<EditorDraft | null>(readEditorDraft(defaultDatabaseId))
  const shareIdOnMount = (() => {
    // useSearchParams 首屏偶发为空；同时看 location，避免分享链被旧草稿抢走并因缺字段崩溃
    const raw =
      searchParams.get('workflowId') ||
      (typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('workflowId')
        : null)
    if (!raw) return null
    const id = parseInt(raw, 10)
    return Number.isFinite(id) && id > 0 ? id : null
  })()
  const initialDraft = shareIdOnMount != null ? null : initialDraftRef.current
  /** 已尝试消费的分享 deep-link id，避免同一会话重复自动打开。 */
  const consumedShareIdRef = useRef<number | null>(null)
  const [taxonomyGroups, setTaxonomyGroups] = useState<WorkflowGroupCount[]>([])
  const [editorFolders, setEditorFolders] = useState<ApiWorkflowFolder[]>([])
  const [cleaning, setCleaning] = useState(false)
  const [view, setView] = useState<'list' | 'editor'>(initialDraft ? 'editor' : 'list')
  const [editing, setEditing] = useState<Workflow | null>(initialDraft?.editing ?? null)
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [showRuns, setShowRuns] = useState<number | null>(null)
  const [connections, setConnections] = useState<ConnRow[]>([])

  // 编辑器内：使用说明 + 调试
  const [showHelp, setShowHelp] = useState(false)
  const [showDebug, setShowDebug] = useState(false)
  /** MCP 接入教程弹层：指导用户把本实例的工作流创作能力接到本地 AI（Claude Code 等） */
  const [showMcpGuide, setShowMcpGuide] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [debugInput, setDebugInput] = useState('{}')
  const [debugDryRun, setDebugDryRun] = useState(true)
  const [debugRunning, setDebugRunning] = useState(false)
  const [debugResult, setDebugResult] = useState<any>(null)
  const [debugError, setDebugError] = useState<string | null>(null)

  // 版本控制：历史抽屉 + 本次保存备注。
  const [showVersions, setShowVersions] = useState(false)
  const [versions, setVersions] = useState<any[]>([])
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [versionDetail, setVersionDetail] = useState<any>(null)
  const [saveNote, setSaveNote] = useState(initialDraft?.saveNote ?? '')

  // AI 助手面板布局（右侧抽屉），用于让接口文档 / 调试抽屉避让，避免重叠。
  const [aiPanel, setAiPanel] = useState<{ open: boolean; width: number; mobile: boolean }>(
    { open: false, width: 0, mobile: false },
  )
  useEffect(() => {
    try {
      const open = localStorage.getItem('ai-assistant-open') === '1'
      const w = Number(localStorage.getItem('ai-assistant-width')) || 440
      if (open) setAiPanel({ open, width: w, mobile: false })
    } catch { /* ignore */ }
    const onAiPanel = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      setAiPanel({ open: !!d.open, width: Number(d.width) || 0, mobile: !!d.mobile })
    }
    window.addEventListener('onebase:ai-panel', onAiPanel)
    return () => window.removeEventListener('onebase:ai-panel', onAiPanel)
  }, [])
  // AI 面板占用的右侧宽度（小屏全屏时不避让，由 z-index 决定层级）。
  const aiOffset = aiPanel.open && !aiPanel.mobile ? aiPanel.width : 0

  // 在具体项目内（workspace 传入 defaultDatabaseId）时，下拉只列当前项目所属租户的库；
  // 老后台（无 defaultDatabaseId）则列全部可见库。
  const activeTenantId = useMemo(() => {
    if (defaultDatabaseId == null) return null
    return connections.find((c) => c.database_id === defaultDatabaseId)?.tenant_id ?? null
  }, [connections, defaultDatabaseId])

  const databaseOptions = useMemo(() => {
    const seen = new Set<number>()
    return connections
      .filter((c) => activeTenantId == null || c.tenant_id === activeTenantId)
      .filter((c) => (seen.has(c.database_id) ? false : (seen.add(c.database_id), true)))
  }, [connections, activeTenantId])

  const blankMeta = () => ({
    name: '', slug: '', description: '',
    department: SHARED_DEPARTMENT_NAME, category: UNCATEGORIZED_FOLDER_NAME,
    database_id: defaultDatabaseId != null ? String(defaultDatabaseId) : '',
    trigger_type: 'endpoint', trigger_config: '{}',
    timeout_ms: 120000, max_retries: 0,
    alert_webhook_url: '',
    alert_webhook_template: DEFAULT_ALERT_WEBHOOK_TEMPLATE,
    alert_throttle_hours: 24,
    last_alert_sent_at: null,
  })

  const [formMeta, setFormMeta] = useState<WorkflowFormMeta>(() => {
    const base = blankMeta()
    const draftMeta = initialDraft?.formMeta
    if (!draftMeta) return base
    // 兼容告警字段加入前写入的草稿，避免 header 里对 undefined 调 trim 崩溃
    return {
      ...base,
      ...draftMeta,
      alert_webhook_url: draftMeta.alert_webhook_url ?? '',
      alert_webhook_template: draftMeta.alert_webhook_template ?? base.alert_webhook_template,
      alert_throttle_hours: draftMeta.alert_throttle_hours ?? 24,
      last_alert_sent_at: draftMeta.last_alert_sent_at ?? null,
    }
  })
  const [editorNodes, setEditorNodes] = useState<WorkflowNodeDef[]>(() => initialDraft?.editorNodes ?? [])
  const [editorEdges, setEditorEdges] = useState<WorkflowEdgeDef[]>(() => initialDraft?.editorEdges ?? [])
  const [workflowDependencies, setWorkflowDependencies] = useState<WorkflowDependencies | null>(
    () => initialDraft?.workflowDependencies ?? null,
  )
  const [depsStatus, setDepsStatus] = useState<WorkflowDepsStatus | null>(
    () => initialDraft?.depsStatus ?? null,
  )
  const [pyDepsStatus, setPyDepsStatus] = useState<WorkflowDepsStatus | null>(
    () => initialDraft?.pyDepsStatus ?? null,
  )

  const databaseSlugById = useMemo(() => {
    const m = new Map<number, string>()
    for (const c of connections) {
      if (typeof c.database_id === 'number' && c.database_slug) {
        m.set(c.database_id, c.database_slug)
      }
    }
    return m
  }, [connections])

  // 编辑器部门 / 分类下拉选项（含空文件夹与当前值）
  const editorDepartments = useMemo(
    () => editorDepartmentOptions(taxonomyGroups, editorFolders, formMeta.department),
    [taxonomyGroups, editorFolders, formMeta.department],
  )
  const editorCategories = useMemo(
    () => editorCategoryOptions(taxonomyGroups, editorFolders, formMeta.department, formMeta.category),
    [taxonomyGroups, editorFolders, formMeta.department, formMeta.category],
  )

  const ensureEditorTaxonomy = useCallback(async () => {
    try {
      const summary = await fetchWorkflowSummary(defaultDatabaseId ?? undefined)
      setTaxonomyGroups(summary.groups)
      if (defaultDatabaseId != null) {
        setEditorFolders(await fetchApiFolders(defaultDatabaseId))
      } else {
        setEditorFolders([])
      }
    } catch (err) {
      console.warn('加载编辑器分类选项失败:', err)
    }
  }, [defaultDatabaseId])

  // 从草稿恢复进入编辑器时（挂载即 view==='editor'），补载部门/分类下拉选项——
  // 正常路径由 openEditor() 负责，这里为「刷新/丢弃后重挂载」补上这一步。
  useEffect(() => {
    if (initialDraft) void ensureEditorTaxonomy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 编辑器草稿持久化：编辑中把完整状态镜像到 sessionStorage；回到列表（返回/保存成功）即清除。
  // 这样切到别的 Tab 后即便本页被浏览器丢弃/刷新，切回时仍停留在原编辑页且不丢未保存改动。
  useEffect(() => {
    if (view === 'editor') {
      writeEditorDraft(defaultDatabaseId, {
        view: 'editor',
        editing,
        formMeta,
        editorNodes,
        editorEdges,
        workflowDependencies,
        depsStatus,
        pyDepsStatus,
        saveNote,
      })
    } else {
      clearEditorDraft(defaultDatabaseId)
    }
  }, [defaultDatabaseId, view, editing, formMeta, editorNodes, editorEdges, workflowDependencies, depsStatus, pyDepsStatus, saveNote])

  const projectRouteSeg =
    currentProject?.slug || currentProject?.name || ':project'

  const endpointRouteForDb = (databaseId?: number | null) =>
    (databaseId != null && databaseSlugById.get(databaseId)) || projectRouteSeg

  const [listRefreshToken, setListRefreshToken] = useState(0)

  const refreshList = useCallback(() => {
    setListRefreshToken((t) => t + 1)
  }, [])

  const handleSummaryChange = useCallback((groups: WorkflowGroupCount[]) => {
    setTaxonomyGroups(groups)
  }, [])

  const loadConnections = useCallback(async () => {
    try {
      // workspace 场景（有 currentProject）只取本项目连接；老后台无 currentProject 时取全部可见。
      const res = await tenantAPI.getMyConnections(currentProject?.id ?? undefined)
      setConnections(Array.isArray(res.data) ? res.data : [])
    } catch (err) {
      console.error('加载数据库连接失败:', err)
    }
  }, [currentProject?.id])

  useEffect(() => { loadConnections() }, [loadConnections])

  // 手动收口卡住的执行
  // 不必等后台周期自检。作用域：workspace 场景仅当前库，老后台按后端权限（所辖租户 / 超管全量）。
  const handleCleanupRuns = async () => {
    if (
      !confirm(
        '将把“运行中”但已卡住超过 10 分钟的工作流执行记录收口为“失败”。\n' +
          '正常执行中的任务（10 分钟内）不受影响。\n\n确认清理？',
      )
    ) {
      return
    }
    setCleaning(true)
    try {
      const res = await api.post('/api/admin/workflows/runs/cleanup', {
        database_id: defaultDatabaseId ?? undefined,
        grace_secs: 600,
      })
      const n = res.data?.cleaned ?? 0
      alert(n > 0 ? `已清理 ${n} 条卡住的执行记录。` : '没有需要清理的卡住记录。')
    } catch (err: any) {
      alert(err?.response?.data?.error || '清理失败')
    } finally {
      setCleaning(false)
    }
  }

  const syncWorkflowIdInUrl = useCallback(
    (workflowId: number | null) => {
      const sp = new URLSearchParams(searchParams.toString())
      const current = sp.get('workflowId')
      const next = workflowId != null ? String(workflowId) : null
      if (current === next) return
      if (next) sp.set('workflowId', next)
      else sp.delete('workflowId')
      const qs = sp.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [pathname, router, searchParams],
  )

  const openEditor = async (wf?: Workflow, folderPlacement?: { department: string; category?: string | null }) => {
    if (wf) {
      // 每次打开已存在的工作流都从后端拉取最新定义，避免复用列表里缓存的旧 nodes/edges；
      // 拉取失败时回退到列表缓存的对象，保证仍可进入编辑器。
      let latest: Workflow = wf
      let latestDepsStatus: WorkflowDepsStatus | null = null
      let latestPyDepsStatus: WorkflowDepsStatus | null = null
      try {
        const res = await api.get(`/api/admin/workflows/${wf.id}`)
        if (res.data?.workflow) latest = res.data.workflow
        if (res.data?.deps_status) latestDepsStatus = res.data.deps_status as WorkflowDepsStatus
        if (res.data?.py_deps_status) latestPyDepsStatus = res.data.py_deps_status as WorkflowDepsStatus
      } catch (err) {
        console.error('拉取工作流最新定义失败，使用列表缓存:', err)
      }
      const tax = resolveWorkflowTaxonomy(latest)
      setEditing(latest)
      setWorkflowDependencies(latest.dependencies ?? null)
      setDepsStatus(latestDepsStatus)
      setPyDepsStatus(latestPyDepsStatus)
      setFormMeta({
        name: latest.name, slug: latest.slug,
        description: latest.description || '',
        department: tax.department ?? SHARED_DEPARTMENT_NAME,
        category: tax.category ?? UNCATEGORIZED_FOLDER_NAME,
        database_id: latest.database_id?.toString() || '',
        trigger_type: latest.trigger_type,
        trigger_config: JSON.stringify(latest.trigger_config || {}, null, 2),
        timeout_ms: latest.timeout_ms, max_retries: latest.max_retries,
        alert_webhook_url: latest.alert_webhook_url ?? '',
        alert_webhook_template: JSON.stringify(
          latest.alert_webhook_template ?? JSON.parse(DEFAULT_ALERT_WEBHOOK_TEMPLATE),
          null,
          2,
        ),
        alert_throttle_hours: latest.alert_throttle_hours ?? 24,
        last_alert_sent_at: latest.last_alert_sent_at ?? null,
      })
      setEditorNodes(latest.nodes || [])
      setEditorEdges(latest.edges || [])
      consumedShareIdRef.current = latest.id
      syncWorkflowIdInUrl(latest.id)
    } else {
      setEditing(null)
      setWorkflowDependencies(null)
      setDepsStatus(null)
      setPyDepsStatus(null)
      setFormMeta({
        ...blankMeta(),
        department: folderPlacement?.department || SHARED_DEPARTMENT_NAME,
        category: folderPlacement?.category ?? UNCATEGORIZED_FOLDER_NAME,
      })
      setEditorNodes([
        { id: 'start', type: 'code', label: '处理逻辑', config: { code: 'function execute(ctx)\n  ctx.body = { ok = true }\nend' } }
      ])
      setEditorEdges([])
      syncWorkflowIdInUrl(null)
    }
    void ensureEditorTaxonomy()
    setView('editor')
  }

  const handleCopyWorkflowLink = useCallback(
    async (workflowId: number) => {
      if (projectId == null || !Number.isFinite(projectId)) {
        showToast('error', '无法复制编辑链接：缺少项目信息')
        return
      }
      const url = buildWorkflowEditorUrl(projectId, workflowId)
      const ok = await copyTextToClipboard(url)
      if (ok) showToast('success', '编辑链接已复制')
      else showToast('error', '复制失败，请手动复制地址栏中的编辑链接')
    },
    [projectId],
  )

  const backToList = useCallback(() => {
    setView('list')
    consumedShareIdRef.current = null
    syncWorkflowIdInUrl(null)
  }, [syncWorkflowIdInUrl])

  // 消费 ?workflowId= 深链：登录后直达工作流详情（权限走现有 GET /api/admin/workflows/:id）。
  // 注意：React Strict Mode 会 mount→cleanup→mount；不能在发请求前就把 id 记为已消费，
  // 否则第一次被 cancel 后第二次会直接跳过，永远打不开编辑器。
  const shareWorkflowIdParam = searchParams.get('workflowId')
  useEffect(() => {
    if (!shareWorkflowIdParam) return
    const id = parseInt(shareWorkflowIdParam, 10)
    if (!Number.isFinite(id) || id <= 0) {
      syncWorkflowIdInUrl(null)
      return
    }
    if (consumedShareIdRef.current === id) return
    if (view === 'editor' && editing?.id === id) {
      consumedShareIdRef.current = id
      return
    }

    let cancelled = false
    ;(async () => {
      try {
        const res = await api.get(`/api/admin/workflows/${id}`)
        const wf = res.data?.workflow as Workflow | undefined
        if (!wf) throw new Error('工作流不存在')
        if (cancelled) return
        // 成功后再标记，避免 Strict Mode 二次挂载时被错误跳过
        consumedShareIdRef.current = id
        await openEditor(wf)
      } catch (err: any) {
        if (cancelled) return
        const msg =
          err?.response?.data?.error ||
          err?.message ||
          '无法打开分享的工作流'
        showToast('error', typeof msg === 'string' ? msg : '无法打开分享的工作流')
        syncWorkflowIdInUrl(null)
      }
    })()
    return () => {
      cancelled = true
    }
    // 只跟随 workflowId 字符串；openEditor / view 用渲染时闭包即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareWorkflowIdParam])

  // 从 session 草稿恢复到已有工作流时，补齐地址栏 workflowId。
  useEffect(() => {
    if (initialDraft?.editing?.id) {
      syncWorkflowIdInUrl(initialDraft.editing.id)
      consumedShareIdRef.current = initialDraft.editing.id
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleCanvasChange = useCallback((nodes: WorkflowNodeDef[], edges: WorkflowEdgeDef[]) => {
    setEditorNodes(nodes)
    setEditorEdges(edges)
  }, [])

  const handleMoveCategory = useCallback(
    async (
      categoryFolderId: string,
      targetDeptFolderId: string,
      opts: { workflowCount: number },
    ) => {
      if (opts.workflowCount <= 0) return

      const cat = catNamesFromId(categoryFolderId)
      const targetDept = deptNameFromId(targetDeptFolderId)
      if (!cat || !targetDept || cat.dept === targetDept) return

      const affected = await fetchWorkflowsByCategory(cat.dept, cat.cat, defaultDatabaseId)

      try {
        await Promise.all(
          affected.map((wf) =>
            api.patch(`/api/admin/workflows/${wf.id}`, {
              department: targetDept,
              category: cat.cat,
            }),
          ),
        )
        refreshList()
      } catch (err) {
        console.error('移动分类失败:', err)
        showToast('error', '移动分类失败，请重试')
        throw err
      }
    },
    [defaultDatabaseId, refreshList],
  )

  const handleSave = async () => {
    let triggerConfig: any
    try { triggerConfig = JSON.parse(formMeta.trigger_config) } catch { return alert('触发配置 JSON 格式错误') }
    let alertWebhookTemplate: Record<string, unknown> | null = null
    if ((formMeta.alert_webhook_url ?? '').trim()) {
      try {
        const parsed = JSON.parse(formMeta.alert_webhook_template || '{}')
        if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
          return alert('告警模板必须是 JSON 对象')
        }
        alertWebhookTemplate = parsed as Record<string, unknown>
      } catch {
        return alert('告警模板 JSON 格式错误')
      }
    }
    let normalizedNodes: WorkflowNodeDef[]
    try {
      normalizedNodes = normalizeNodesForExecution(editorNodes)
    } catch (err: any) {
      return alert(err?.message || '节点配置 JSON 格式错误')
    }

    // Strip internal _position from config before saving (keep for frontend)
    const cleanNodes = normalizedNodes.map(n => ({
      ...n,
      config: { ...n.config, _position: n.config._position },
    }))

    const placement = formatWorkflowPlacement(
      (formMeta.department ?? '').trim() || SHARED_DEPARTMENT_NAME,
      formMeta.category,
    )
    const payload = {
      name: formMeta.name,
      slug: formMeta.slug,
      description: formMeta.description || null,
      department: placement.department,
      category: placement.category,
      database_id: formMeta.database_id ? parseInt(formMeta.database_id) : null,
      trigger_type: formMeta.trigger_type,
      trigger_config: triggerConfig,
      nodes: cleanNodes,
      edges: editorEdges,
      timeout_ms: formMeta.timeout_ms,
      max_retries: formMeta.max_retries,
      alert_webhook_url: (formMeta.alert_webhook_url ?? '').trim() || null,
      alert_webhook_template: (formMeta.alert_webhook_url ?? '').trim() ? alertWebhookTemplate : null,
      alert_throttle_hours: formMeta.alert_throttle_hours,
      dependencies: workflowDependencies,
      version_note: saveNote.trim() || null,
    }

    try {
      if (editing) {
        await api.patch(`/api/admin/workflows/${editing.id}`, payload)
      } else {
        await api.post('/api/admin/workflows', payload)
      }
      setSaveNote('')
      setView('list')
      consumedShareIdRef.current = null
      syncWorkflowIdInUrl(null)
      refreshList()
    } catch (err: any) {
      alert(err.response?.data?.error || '保存失败')
    }
  }

  // 打开版本历史抽屉并加载列表。
  const openVersions = async () => {
    if (!editing) return
    setShowVersions(true)
    setVersionDetail(null)
    setVersionsLoading(true)
    try {
      const res = await api.get(`/api/admin/workflows/${editing.id}/versions`)
      setVersions(res.data.versions || [])
    } catch (err: any) {
      alert(err?.response?.data?.error || '加载版本历史失败')
    } finally {
      setVersionsLoading(false)
    }
  }

  // 查看某版本的完整快照（含 nodes/edges），用于预览。
  const viewVersion = async (version: number) => {
    if (!editing) return
    try {
      const res = await api.get(`/api/admin/workflows/${editing.id}/versions/${version}`)
      setVersionDetail(res.data.version)
    } catch (err: any) {
      alert(err?.response?.data?.error || '加载版本详情失败')
    }
  }

  // 恢复到某版本：后端把该快照写回当前定义并追加一条新版本，前端重新载入编辑器。
  const restoreVersion = async (version: number) => {
    if (!editing) return
    if (!confirm(`确认把工作流恢复到版本 v${version}？\n当前未保存的改动将被覆盖；恢复会作为一个新版本记录，可再次回滚。`)) {
      return
    }
    try {
      await api.post(`/api/admin/workflows/${editing.id}/versions/${version}/restore`)
      // 重新拉取最新工作流并载回编辑器。
      const res = await api.get(`/api/admin/workflows/${editing.id}`)
      const wf: Workflow = res.data.workflow
      const tax = resolveWorkflowTaxonomy(wf)
      setEditing(wf)
      setWorkflowDependencies(wf.dependencies ?? null)
      setDepsStatus((res.data?.deps_status as WorkflowDepsStatus | undefined) ?? null)
      setPyDepsStatus((res.data?.py_deps_status as WorkflowDepsStatus | undefined) ?? null)
      setFormMeta({
        name: wf.name, slug: wf.slug,
        description: wf.description || '',
        department: tax.department || SHARED_DEPARTMENT_NAME,
        category: tax.category || '',
        database_id: wf.database_id?.toString() || '',
        trigger_type: wf.trigger_type,
        trigger_config: JSON.stringify(wf.trigger_config || {}, null, 2),
        timeout_ms: wf.timeout_ms, max_retries: wf.max_retries,
        alert_webhook_url: wf.alert_webhook_url ?? '',
        alert_webhook_template: JSON.stringify(
          wf.alert_webhook_template ?? JSON.parse(DEFAULT_ALERT_WEBHOOK_TEMPLATE),
          null,
          2,
        ),
        alert_throttle_hours: wf.alert_throttle_hours ?? 24,
        last_alert_sent_at: wf.last_alert_sent_at ?? null,
      })
      setEditorNodes(wf.nodes || [])
      setEditorEdges(wf.edges || [])
      setShowVersions(false)
      setVersionDetail(null)
      refreshList()
      alert(`已恢复到 v${version}。`)
    } catch (err: any) {
      alert(err?.response?.data?.error || '恢复失败')
    }
  }

  // 编辑态调试：对当前（可能未保存）的 nodes/edges 跑一遍，返回逐节点结果。
  const handleDebugRun = async () => {
    let triggerData: any
    try {
      triggerData = debugInput.trim() ? JSON.parse(debugInput) : {}
    } catch {
      setDebugError('测试输入不是合法 JSON')
      return
    }
    let normalizedNodes: WorkflowNodeDef[]
    try {
      normalizedNodes = normalizeNodesForExecution(editorNodes)
    } catch (err: any) {
      setDebugError(err?.message || '节点配置 JSON 格式错误')
      return
    }
    setDebugError(null)
    setDebugRunning(true)
    setDebugResult(null)
    try {
      const res = await api.post('/api/admin/workflows/debug', {
        nodes: normalizedNodes,
        edges: editorEdges,
        database_id: formMeta.database_id ? parseInt(formMeta.database_id) : null,
        trigger_type: formMeta.trigger_type,
        trigger_data: triggerData,
        timeout_ms: formMeta.timeout_ms,
        dry_run: debugDryRun,
      })
      setDebugResult(res.data)
    } catch (err: any) {
      setDebugError(err.response?.data?.error || '调试运行失败')
    } finally {
      setDebugRunning(false)
    }
  }

  const handleDeleteRequest = (wf: Pick<Workflow, 'id' | 'name'>) => {
    setDeleteTarget({ id: wf.id, name: wf.name })
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api.delete(`/api/admin/workflows/${deleteTarget.id}`)
      setDeleteTarget(null)
      refreshList()
      showToast('success', '工作流已删除')
    } catch (err: any) {
      showToast('error', err.response?.data?.error || '删除失败')
    } finally {
      setDeleting(false)
    }
  }

  const handleTrigger = async (id: number) => {
    // 二次确认：手动运行会真实执行全部节点（写库 / HTTP / 邮件 / Stripe 等副作用与费用），不可逆。
    if (!confirm('确认手动运行此工作流？\n这会真实执行所有节点（可能写库 / 发 HTTP / 产生 Stripe 等外部副作用与费用）。')) return
    try {
      await api.post(`/api/admin/workflows/${id}/trigger`, {})
      showToast('success', '工作流已触发')
      if (showRuns === id) loadRuns(id)
    } catch (err: any) {
      showToast('error', err.response?.data?.error || '触发失败')
    }
  }

  const loadRuns = async (id: number) => {
    try {
      const res = await api.get(`/api/admin/workflows/${id}/runs?limit=20`)
      setRuns(res.data.runs || [])
      setShowRuns(id)
    } catch {}
  }

  const handleToggle = async (wf: Workflow) => {
    try {
      await api.patch(`/api/admin/workflows/${wf.id}`, { is_enabled: !wf.is_enabled })
      refreshList()
      showToast('success', wf.is_enabled ? '已禁用' : '已启用')
    } catch (err: any) {
      showToast('error', err.response?.data?.error || '操作失败')
    }
  }

  // 详情页启用/禁用：切换当前正在编辑的工作流，并把新状态同步回 editing（更新头部徽标）与列表。
  const handleToggleEditing = async () => {
    if (!editing) return
    const next = !editing.is_enabled
    try {
      await api.patch(`/api/admin/workflows/${editing.id}`, { is_enabled: next })
      setEditing({ ...editing, is_enabled: next })
      refreshList()
      showToast('success', next ? '已启用' : '已禁用')
    } catch (err: any) {
      showToast('error', err.response?.data?.error || '操作失败')
    }
  }

  // 复制：服务端一键克隆（自动生成唯一 slug、默认禁用），刷新列表。
  const handleDuplicate = async (id: number) => {
    try {
      await api.post(`/api/admin/workflows/${id}/duplicate`, {})
      await refreshList()
    } catch (err: any) {
      alert(err.response?.data?.error || '复制失败')
    }
  }

  // 导出：可移植 JSON 信封；保留 nodes/edges 与服务(department)/分类(category)，剥掉 id / database_id 等环境字段。
  const handleExport = (wf: Workflow) => {
    downloadWorkflowJson(wf)
    auditWorkflowExport([wf.id])
  }

  // 详情页导出：以「当前编辑器里的定义」为准（含未保存改动），trigger_config 由字符串解析为对象。
  const handleExportEditor = () => {
    let triggerConfig: any = {}
    try { triggerConfig = formMeta.trigger_config ? JSON.parse(formMeta.trigger_config) : {} } catch {
      return showToast('error', '触发配置 JSON 格式错误，无法导出')
    }
    let alertWebhookTemplate: Record<string, unknown> | null = null
    if ((formMeta.alert_webhook_url ?? '').trim()) {
      try {
        const parsed = JSON.parse(formMeta.alert_webhook_template || '{}')
        if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
          return showToast('error', '告警模板必须是 JSON 对象，无法导出')
        }
        alertWebhookTemplate = parsed as Record<string, unknown>
      } catch {
        return showToast('error', '告警模板 JSON 格式错误，无法导出')
      }
    }
    downloadWorkflowJson({
      name: formMeta.name,
      slug: formMeta.slug,
      description: formMeta.description || null,
      department: formMeta.department,
      category: formMeta.category,
      trigger_type: formMeta.trigger_type,
      trigger_config: triggerConfig,
      nodes: editorNodes,
      edges: editorEdges,
      dependencies: workflowDependencies,
      timeout_ms: formMeta.timeout_ms,
      max_retries: formMeta.max_retries,
      alert_webhook_url: (formMeta.alert_webhook_url ?? '').trim() || null,
      alert_webhook_template: (formMeta.alert_webhook_url ?? '').trim() ? alertWebhookTemplate : null,
      alert_throttle_hours: formMeta.alert_throttle_hours,
    })
    // 编辑器导出：仅在编辑已存在工作流时可审计（新建未保存无 id，auditWorkflowExport 会自动跳过）。
    auditWorkflowExport([editing?.id])
  }

  const editorEndpointPath =
    formMeta.trigger_type === 'endpoint' && formMeta.slug
      ? `POST /workflow/${endpointRouteForDb(formMeta.database_id ? parseInt(formMeta.database_id) : null)}/${formMeta.slug}`
      : undefined

  // ── List + Editor：列表保持挂载，进入详情时仅隐藏，返回后保留翻页等状态 ──
  return (
    <>
      <div className={view === 'editor' ? 'hidden' : undefined} aria-hidden={view === 'editor'}>
        <WorkflowListView
          cleaning={cleaning}
          defaultDatabaseId={defaultDatabaseId}
          refreshToken={listRefreshToken}
          onSummaryChange={handleSummaryChange}
          onNewWorkflow={(folderPlacement) => openEditor(undefined, folderPlacement)}
          onEdit={(wf) => openEditor(wf)}
          onToggle={handleToggle}
          onRun={(wf) => handleTrigger(wf.id)}
          onShowRuns={(wf) => loadRuns(wf.id)}
          onDuplicate={(wf) => handleDuplicate(wf.id)}
          onShare={(wf) => void handleCopyWorkflowLink(wf.id)}
          onExport={(wf) => handleExport(wf as Workflow)}
          onDelete={handleDeleteRequest}
          onCleanupRuns={handleCleanupRuns}
          onShowMcpGuide={() => setShowMcpGuide(true)}
          onMoveCategory={handleMoveCategory}
        />

        {showMcpGuide && <McpGuideModal onClose={() => setShowMcpGuide(false)} />}

        <WorkflowConfirmDialog
          open={deleteTarget !== null}
          title="删除工作流"
          message={
            deleteTarget
              ? `确定删除工作流「${deleteTarget.name}」？此操作不可撤销。`
              : ''
          }
          confirmLabel="删除"
          variant="danger"
          loading={deleting}
          onConfirm={() => void confirmDelete()}
          onCancel={() => {
            if (!deleting) setDeleteTarget(null)
          }}
        />

      </div>

      {view === 'editor' && (
      <div className="h-[calc(100vh-64px)] flex flex-col">
        <WorkflowEditorHeader
          editingName={editing?.name}
          isEnabled={editing?.is_enabled}
          formMeta={formMeta}
          setFormMeta={setFormMeta}
          editorDepartments={editorDepartments}
          editorCategories={editorCategories}
          databaseOptions={databaseOptions}
          triggerTypes={TRIGGER_TYPES}
          endpointPath={editorEndpointPath}
          saveNote={saveNote}
          setSaveNote={setSaveNote}
          onBack={backToList}
          onSave={handleSave}
          onShowHelp={() => setShowHelp(true)}
          onShowDebug={() => { setShowDebug(true); setDebugResult(null); setDebugError(null) }}
          onShowVersions={editing ? openVersions : undefined}
          onShowRuns={editing ? () => loadRuns(editing.id) : undefined}
          onToggleEnabled={editing ? handleToggleEditing : undefined}
          onShare={editing ? () => void handleCopyWorkflowLink(editing.id) : undefined}
          onExport={handleExportEditor}
          onDepartmentChange={(department) => {
            setFormMeta((f) => {
              const cats = editorCategoryOptions(taxonomyGroups, editorFolders, department, f.category)
              const category = f.category && cats.includes(f.category) ? f.category : UNCATEGORIZED_FOLDER_NAME
              return { ...f, department, category }
            })
          }}
          workflowDependencies={workflowDependencies}
          onWorkflowDependenciesChange={setWorkflowDependencies}
          depsStatus={depsStatus}
          pyDepsStatus={pyDepsStatus}
        />

        {/* Canvas */}
        <div className="flex-1 min-h-0">
          <WorkflowCanvas
            key={editing?.id || 'new'}
            initialNodes={editorNodes}
            initialEdges={editorEdges}
            workflowSlug={formMeta.slug}
            onChange={handleCanvasChange}
          />
        </div>

        {showHelp && (
          <WorkflowDocModal
            meta={formMeta}
            nodes={editorNodes}
            dbSlug={endpointRouteForDb(formMeta.database_id ? parseInt(formMeta.database_id) : null)}
            projectId={projectId}
            rightOffset={aiOffset}
            workflowId={editing?.id ?? null}
            onClose={() => setShowHelp(false)}
          />
        )}

        {/* 版本历史抽屉 */}
        {showVersions && (
          <div className="fixed inset-0 z-50 flex justify-end" style={{ paddingRight: aiOffset }} onClick={() => setShowVersions(false)}>
            <div className="absolute inset-0 bg-black/30" />
            <div className="relative bg-white w-full max-w-lg h-full shadow-xl flex flex-col" onClick={e => e.stopPropagation()}>
              <div className="px-5 py-4 border-b flex items-center justify-between shrink-0">
                <h3 className="font-semibold text-gray-800 flex items-center gap-2">
                  <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  版本历史
                </h3>
                <button onClick={() => setShowVersions(false)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
              </div>

              <div className="p-5 overflow-y-auto flex-1 space-y-3">
                <p className="text-xs text-gray-400">
                  每次在编辑器里保存都会留一份定义快照。恢复某版本会写回当前定义并记为新版本，可反复回滚。
                </p>
                {versionsLoading ? (
                  <div className="text-center py-10 text-gray-400 text-sm">加载中…</div>
                ) : versions.length === 0 ? (
                  <div className="text-center py-10 text-gray-400 text-sm">暂无版本记录</div>
                ) : (
                  versions.map((v, idx) => (
                    <div key={v.id} className="border rounded-lg p-3 text-sm">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-semibold text-gray-800">v{v.version}</span>
                          {idx === 0 && <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-xs">最新</span>}
                          {typeof v.node_count === 'number' && <span className="text-xs text-gray-400">{v.node_count} 节点</span>}
                        </div>
                        <div className="flex items-center gap-2">
                          <button onClick={() => viewVersion(v.version)} className="text-xs px-2 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50">查看</button>
                          {idx !== 0 && (
                            <button onClick={() => restoreVersion(v.version)} className="text-xs px-2 py-0.5 rounded border border-indigo-300 text-indigo-600 hover:bg-indigo-50">恢复</button>
                          )}
                        </div>
                      </div>
                      {v.note && <div className="mt-1 text-gray-600">{v.note}</div>}
                      <div className="mt-1 text-xs text-gray-400">
                        {v.created_by_name && (
                          <span title={v.created_by_email || undefined}>{v.created_by_name} · </span>
                        )}
                        {v.created_at ? formatDateTime(v.created_at) : ''}
                      </div>

                      {versionDetail && versionDetail.version === v.version && (
                        <div className="mt-2 border-t pt-2 space-y-1.5 text-xs">
                          <div className="text-gray-500">
                            名称 <span className="text-gray-700">{versionDetail.name}</span> · slug <span className="font-mono text-gray-700">{versionDetail.slug}</span> · 触发 {versionDetail.trigger_type}
                          </div>
                          <details>
                            <summary className="cursor-pointer text-gray-500 hover:text-gray-700">节点 / 连线 JSON</summary>
                            <pre className="mt-1 p-2 bg-gray-50 border rounded font-mono overflow-auto max-h-60">{JSON.stringify({ nodes: versionDetail.nodes, edges: versionDetail.edges }, null, 2)}</pre>
                          </details>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* 调试抽屉 */}
        {showDebug && (
          <div className="fixed inset-0 z-50 flex justify-end" style={{ paddingRight: aiOffset }} onClick={() => setShowDebug(false)}>
            <div className="absolute inset-0 bg-black/30" />
            <div className="relative bg-white w-full max-w-xl h-full shadow-xl flex flex-col" onClick={e => e.stopPropagation()}>
              <div className="px-5 py-4 border-b flex items-center justify-between shrink-0">
                <h3 className="font-semibold text-gray-800 flex items-center gap-2">
                  <span className="text-amber-500">●</span> 调试运行
                </h3>
                <button onClick={() => setShowDebug(false)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
              </div>

              <div className="p-5 overflow-y-auto flex-1 space-y-4">
                {debugDryRun ? (
                  <div className="bg-sky-50 border border-sky-200 text-sky-800 text-xs rounded-lg p-3 leading-relaxed">
                    <strong>干跑模式</strong>：用<strong>当前编辑器里的定义</strong>（无需先保存）跑一遍，
                    但会<strong>跳过写数据库、HTTP 请求、发送邮件、SSE 推送</strong>等副作用节点（返回 mock 输出）。
                    用于安全地验证流程走向与模板变量。
                  </div>
                ) : (
                  <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-lg p-3 leading-relaxed">
                    调试会用<strong>当前编辑器里的定义</strong>（无需先保存）<strong>真实执行</strong>每个节点——
                    包括<strong>写数据库、发起 HTTP 请求、发送邮件</strong>等副作用。请使用测试数据。
                  </div>
                )}

                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={debugDryRun}
                    onChange={e => setDebugDryRun(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-300 text-sky-600 focus:ring-sky-500"
                  />
                  <span className="text-sm text-gray-700">
                    干跑（跳过副作用，不真实写库 / 请求 / 发信）
                  </span>
                </label>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    测试输入（trigger，JSON）
                  </label>
                  <textarea
                    value={debugInput}
                    onChange={e => setDebugInput(e.target.value)}
                    className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
                    rows={6}
                    placeholder={'{\n  "candidate_email": "test@example.com"\n}'}
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    在节点里用 <code className="bg-gray-100 px-1 rounded">{'{{trigger.字段}}'}</code> 引用这里的数据。
                  </p>
                </div>

                <button
                  onClick={handleDebugRun}
                  disabled={debugRunning}
                  className={`w-full py-2 text-white rounded-lg font-medium disabled:opacity-50 ${debugDryRun ? 'bg-sky-500 hover:bg-sky-600' : 'bg-amber-500 hover:bg-amber-600'}`}
                >
                  {debugRunning ? '运行中…' : debugDryRun ? '▶ 干跑调试' : '▶ 真实运行调试'}
                </button>

                {debugError && (
                  <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3 font-mono">
                    {debugError}
                  </div>
                )}

                {debugResult && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[debugResult.status] || 'bg-gray-100'}`}>
                        {debugResult.status}
                      </span>
                      {typeof debugResult.elapsed_ms === 'number' && (
                        <span className="text-xs text-gray-400">{debugResult.elapsed_ms}ms</span>
                      )}
                    </div>

                    {debugResult.error_message && (
                      <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg p-3 font-mono">
                        {debugResult.error_message}
                      </div>
                    )}

                    <div className="space-y-2">
                      <div className="text-xs font-medium text-gray-500">逐节点结果</div>
                      <NodeResultList results={debugResult.node_results || []} />
                    </div>

                    {debugResult.final_output != null && (
                      <details>
                        <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600">最终输出</summary>
                        <pre className="mt-1 p-2 bg-gray-50 rounded text-xs font-mono overflow-auto max-h-48">
                          {JSON.stringify(debugResult.final_output, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      )}

      {showRuns !== null && (
        <div
          className="fixed bg-black/30 flex items-center justify-center z-50"
          style={{ top: 0, left: 0, right: 'var(--ai-panel-offset, 0px)', bottom: 0 }}
          onClick={() => setShowRuns(null)}
        >
          <div className="bg-white rounded-xl shadow-xl w-[960px] max-w-[95vw] max-h-[85vh] overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="p-4 border-b flex justify-between items-center">
              <div>
                <h3 className="font-semibold">执行记录</h3>
                <p className="text-xs text-gray-400 mt-0.5">展开节点可查看输出、错误与分支详情</p>
              </div>
              <button onClick={() => setShowRuns(null)} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
            </div>
            <div className="overflow-auto max-h-[70vh] p-4">
              {runs.length === 0 ? (
                <p className="text-center text-gray-400 py-8">暂无执行记录</p>
              ) : (
                <div className="space-y-4">
                  {runs.map(run => {
                    const executed = (run.node_results || []).filter((nr: NodeResultItem) => nr.status !== 'skipped')
                    const failed = (run.node_results || []).filter((nr: NodeResultItem) => nr.status === 'failed')
                    return (
                      <div key={run.id} className="border rounded-lg p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3 flex-wrap">
                            <span className="text-sm font-mono text-gray-500">#{run.id}</span>
                            <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[run.status] || 'bg-gray-100'}`}>
                              {run.status}
                            </span>
                            {run.trigger_type && (
                              <span className="text-xs text-gray-400">{run.trigger_type}</span>
                            )}
                            {run.elapsed_ms != null && <span className="text-xs text-gray-400">{run.elapsed_ms}ms</span>}
                            {executed.length > 0 && (
                              <span className="text-xs text-gray-400">
                                {executed.length} 个节点执行
                                {failed.length > 0 && <span className="text-red-500 ml-1">· {failed.length} 失败</span>}
                              </span>
                            )}
                          </div>
                          <span className="text-xs text-gray-400 shrink-0">{formatDateTime(run.started_at)}</span>
                        </div>
                        {run.error_message && (
                          <div className="mt-2 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg p-2 font-mono">
                            {run.error_message}
                          </div>
                        )}
                        {run.node_results && run.node_results.length > 0 && (
                          <details className="mt-3" open={failed.length > 0}>
                            <summary className="text-xs font-medium text-gray-500 cursor-pointer hover:text-gray-700 select-none">
                              逐节点详情 ({run.node_results.length})
                            </summary>
                            <div className="mt-2">
                              <NodeResultList results={run.node_results} />
                            </div>
                          </details>
                        )}
                        {run.final_output && (
                          <details className="mt-2">
                            <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600">最终输出</summary>
                            <pre className="mt-1 p-2 bg-gray-50 rounded text-xs font-mono overflow-auto max-h-40">
                              {JSON.stringify(run.final_output, null, 2)}
                            </pre>
                          </details>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
