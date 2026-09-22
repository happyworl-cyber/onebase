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
import { useTranslations } from 'next-intl'
import dynamic from 'next/dynamic'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import api, { tenantAPI } from '@/lib/api'
import { usePublicApiConfig } from '@/lib/apiBase'
import { copyTextToClipboard } from '@/lib/clipboard'
import { formatDateTime, closeOnBackdropPress } from '@/lib/utils'
import { EXECUTION_REPLAY_ENTRY_VISIBLE } from '@/lib/featureFlags'
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
import ExecutionReplayView from '@/components/workflow/replay/ExecutionReplayView'
import {
  fetchReplayRunDetail,
  type ReplayRunDetail,
  type ReplayRunSummary,
} from '@/components/workflow/replay/replayApi'
import { runDetailFetchId } from '@/components/workflow/runDetailLoad'
import WorkflowConfirmDialog from '@/components/workflow/list/WorkflowConfirmDialog'
import { showToast } from '@/components/Toast'
import Modal from '@/components/Modal'
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
import { fetchWorkflowSummary, fetchWorkflowsByCategory, fetchWorkflowsByDepartment } from '@/components/workflow/list/listApi'
import { downloadWorkflowJson, auditWorkflowExport } from '@/components/workflow/list/exportUtils'
import { fetchApiFolders, type ApiWorkflowFolder } from '@/components/workflow/list/folderApi'
import { UNCATEGORIZED_FOLDER_NAME } from '@/components/workflow/list/types'
import { workflowVersionsPath } from '@/components/workflow/version/paths'

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
  input_schema?: Record<string, unknown> | null
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
  published_version?: number | null
  has_unpublished?: boolean
  published_slug?: string | null
}
type QaFinding = {
  severity: 'crit' | 'high' | 'med' | 'low'
  code: string
  title: string
  detail: string
  node_id?: string | null
  node_label?: string | null
  evidence?: string
}

const QA_DOT: Record<QaFinding['severity'], string> = {
  crit: 'bg-red-500',
  high: 'bg-orange-500',
  med: 'bg-amber-400',
  low: 'bg-gray-400',
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
  input_schema: string
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

const EDITOR_DRAFT_KEY_PREFIX = 'planeos:wf-editor-draft:'

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

const TRIGGER_TYPES = [
  { value: 'endpoint', label: 'HTTP endpoint', icon: '🌐', desc: 'POST /workflow/:project/:workflow_slug' },
  { value: 'hook', label: 'Data change', icon: '⚡', desc: 'Auto-triggered by table CRUD' },
  { value: 'notify', label: 'PG NOTIFY', icon: '📣', desc: 'Auto-triggered by business DB LISTEN/NOTIFY' },
  { value: 'cron', label: 'Scheduled', icon: '⏰', desc: 'Runs periodically per a Cron expression' },
  { value: 'kafka', label: 'Kafka message', icon: '📨', desc: 'Auto-triggered by consuming Kafka topic messages' },
  { value: 'manual', label: 'Manual', icon: '👆', desc: 'Run manually only from the panel' },
]

const DEFAULT_ALERT_WEBHOOK_TEMPLATE = JSON.stringify(
  {
    msg_type: 'markdown',
    content:
      '### 🚨 Alert\n- **Source**: {{source}}\n- **Name**: {{name}}\n- **Status**: {{status}}\n- **Error**: {{error}}\n- **Time**: {{time}}\n- **Run ID**: {{run_id}}',
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
  t: (k: string, p?: any) => string,
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
    throw new Error(t('nodeFieldInvalidJson', { id: nodeId, type: nodeType, field }))
  }
  if (
    requireObject &&
    (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object')
  ) {
    throw new Error(t('nodeFieldMustObject', { id: nodeId, type: nodeType, field }))
  }
  return parsed
}

function normalizeNodesForExecution(nodes: WorkflowNodeDef[], t: (k: string, p?: any) => string): WorkflowNodeDef[] {
  return nodes.map((node) => {
    const config = { ...(node.config || {}) } as Record<string, unknown>
    for (const field of JSON_OBJECT_FIELDS_BY_NODE[node.type] || []) {
      if (field in config) {
        config[field] = parseNodeJsonField(t, node.id, node.type, field, config[field], true)
      }
    }
    for (const field of JSON_FIELDS_BY_NODE[node.type] || []) {
      if (field in config) {
        config[field] = parseNodeJsonField(t, node.id, node.type, field, config[field], false)
      }
    }
    return { ...node, config }
  })
}

interface NodeLogLine {
  level: string
  message: string
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
  logs?: NodeLogLine[]
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

function JsonLogBlock({ title, value }: { title?: string; value: unknown }) {
  const text = JSON.stringify(value, null, 2)
  return (
    <>
      <div className={`flex items-center gap-2 ${title ? 'mt-2 justify-between' : 'mt-1 justify-end'}`}>
        {title ? <div className="text-[11px] font-medium text-gray-500">{title}</div> : null}
        <CopyButton text={text} />
      </div>
      <pre className="mt-1 p-2 bg-white border rounded font-mono overflow-auto max-h-48 text-[11px] leading-relaxed">
        {text}
      </pre>
    </>
  )
}

function DebugLogsBlock({ logs }: { logs: NodeLogLine[] }) {
  const t = useTranslations('wfMgr')
  const text = logs.map((line) => `${line.level}  ${line.message}`).join('\n')
  return (
    <>
      <div className="flex items-center gap-2 mt-2 justify-between">
        <div className="text-[11px] font-medium text-gray-500">{t('debugLogs')}</div>
        <CopyButton text={text} />
      </div>
      <pre className="mt-1 p-2 bg-white border rounded font-mono overflow-auto max-h-48 text-[11px] leading-relaxed">
        {text}
      </pre>
    </>
  )
}

function NodeResultCard({ nr, defaultOpen = false }: { nr: NodeResultItem; defaultOpen?: boolean }) {
  const t = useTranslations('wfMgr')
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
  const statusLabel = nr.status === 'failed_allowed' ? t('statusFailedAllowed') : nr.status

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
              <span className="truncate text-amber-700" title={nr.error || ''}>{t('tolerated')}</span>
            )}
          </div>
          <span className="flex items-center gap-2 shrink-0">
            {!!(nr.output && typeof nr.output === 'object' && (nr.output as Record<string, unknown>).dry_run === true) && (
              <span className="px-1.5 py-0.5 rounded bg-sky-100 text-sky-700">{t('skipped')}</span>
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
          <JsonLogBlock title={t('inputActual')} value={nr.input} />
        )}
        {nr.output != null && (
          <JsonLogBlock title={t('outputResp')} value={nr.output} />
        )}
        {!!nr.logs?.length && <DebugLogsBlock logs={nr.logs} />}
      </div>
    </details>
  )
}

function NodeResultList({ results }: { results: NodeResultItem[] }) {
  const t = useTranslations('wfMgr')
  if (!results?.length) {
    return <p className="text-xs text-gray-400">{t('noNodeResults')}</p>
  }
  return (
    <div className="space-y-2">
      {results.map((nr, idx) => (
        <NodeResultCard
          key={`${nr.node_id}-${idx}`}
          nr={nr}
          defaultOpen={nr.status === 'failed' || nr.status === 'failed_allowed' || !!extractOutputHint(nr.output) || !!nr.logs?.length}
        />
      ))}
    </div>
  )
}

// MCP 工具清单（与后端 mcp_tools.rs 注册的工具一一对应）。
// Markdown「复制全部」与页面表格共用这一份，新增工具只改这里。
const MCP_TOOLS: ReadonlyArray<readonly [string, string]> = [
  ['node_spec', 'MCPKEY:tNodeSpec'],
  ['list_skills / get_skill', 'MCPKEY:tSkills'],
  ['list_workflows / get_workflow', 'MCPKEY:tListWf'],
  ['list_env_vars', 'MCPKEY:tListEnv'],
  ['create_workflow', 'MCPKEY:tCreate'],
  ['update_workflow', 'MCPKEY:tUpdate'],
  ['publish_workflow', 'MCPKEY:tPublish'],
  ['discard_workflow_draft', 'MCPKEY:tDiscard'],
  ['duplicate_workflow', 'MCPKEY:tDuplicate'],
  ['debug_workflow', 'MCPKEY:tDebug'],
  ['review_workflow / review_workflows', 'MCPKEY:tReview'],
  ['workflow_api_doc', 'MCPKEY:tApiDoc'],
  ['get_workflow_runs', 'MCPKEY:tRuns'],
  ['get_workflow_run_detail', 'MCPKEY:tRunDetail'],
  ['list_workflow_versions', 'MCPKEY:tListVersions'],
  ['get_workflow_version', 'MCPKEY:tGetVersion'],
]

// MCP 接入教程：指导用户把本实例接入本地 AI 客户端，让 AI 创作/调试工作流。
// 接入地址取当前页面 origin——测试/生产是独立部署（不同域名），在哪个环境打开本页，
// 教程里的 URL 就指向哪个环境，无需手动区分。
function McpGuideModal({ onClose }: { onClose: () => void }) {
  const t = useTranslations('wfMgr')
  const base = typeof window !== 'undefined' ? window.location.origin : ''
  const mcpUrl = `${base}/mcp`
  const claudeCmd = `claude mcp add --transport http planeos ${mcpUrl} --header "Authorization: Bearer ${t('tokenPlaceholder')}"`
  const genericConfig = JSON.stringify(
    {
      mcpServers: {
        planeos: {
          type: 'http',
          url: mcpUrl,
          headers: { Authorization: `Bearer ${t('tokenPlaceholder')}` },
        },
      },
    },
    null,
    2,
  )

  // 整份接入指南拼成 Markdown，供「复制全部」一次性带走喂 AI。
  const mcpMarkdown = useMemo(() => [
    t('mdTitle'),
    '',
    t('mdIntro'),
    '',
    t('mdAddrH'),
    mcpUrl,
    '',
    t('mdAddrNote'),
    '',
    t('mdStep1H'),
    t('mdStep1'),
    '',
    t('mdStep2H'),
    '',
    t('mdStep2Claude'),
    '```bash',
    claudeCmd,
    '```',
    '',
    t('mdStep2Other'),
    '```json',
    genericConfig,
    '```',
    '',
    t('mdStep3H'),
    t('mdStep3'),
    t('mdStep3Eg'),
    '',
    t('mdStep3Flow'),
    '',
    t('mdToolsH'),
    ...MCP_TOOLS.map(([name, desc]) => `- \`${name}\`：${desc.startsWith('MCPKEY:') ? t(desc.slice(7)) : desc}`),
  ].join('\n'), [mcpUrl, claudeCmd, genericConfig])

  return (
    <div data-alt="mcp-guide-modal" className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onMouseDown={onClose} />
      <div className="relative bg-white w-[720px] max-w-[92vw] max-h-[85vh] rounded-xl shadow-xl flex flex-col">
        <div className="px-6 py-4 border-b flex items-center justify-between shrink-0">
          <div>
            <h3 className="font-semibold text-gray-800">{t('guideTitle')}</h3>
            <p className="text-xs text-gray-400 mt-0.5">{t('guideSubtitle')}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <CopyMarkdownButton text={mcpMarkdown} />
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
          </div>
        </div>

        <div className="p-6 overflow-y-auto space-y-6 text-sm text-gray-700">
          {/* 接入地址 */}
          <section>
            <h4 className="font-semibold text-gray-900 mb-2">{t('addrH')}</h4>
            <div className="flex items-center gap-2 flex-wrap">
              <code className="text-xs bg-gray-100 px-2 py-1 rounded font-mono break-all flex-1 min-w-0">{mcpUrl}</code>
              <CopyButton text={mcpUrl} />
            </div>
            <p className="text-xs text-gray-500 mt-2 leading-relaxed">
              {t('addrDesc')}
            </p>
          </section>

          {/* 第一步：令牌 */}
          <section>
            <h4 className="font-semibold text-gray-900 mb-2">{t('step1H')}</h4>
            <p className="text-xs text-gray-600 leading-relaxed">
              {t('step1Desc', { a: 'obm_', b: 'obp_' })}
            </p>
          </section>

          {/* 第二步：接入 */}
          <section>
            <h4 className="font-semibold text-gray-900 mb-2">{t('step2H')}</h4>
            <p className="text-xs text-gray-500 mb-2">{t('step2Claude')}</p>
            <div className="relative">
              <pre className="text-xs bg-gray-900 text-gray-100 rounded-lg p-3 overflow-x-auto font-mono whitespace-pre-wrap break-all">{claudeCmd}</pre>
              <div className="absolute top-2 right-2"><CopyButton text={claudeCmd} /></div>
            </div>
            <p className="text-xs text-gray-500 mt-3 mb-2">{t('step2Other')}</p>
            <div className="relative">
              <pre className="text-xs bg-gray-900 text-gray-100 rounded-lg p-3 overflow-x-auto font-mono">{genericConfig}</pre>
              <div className="absolute top-2 right-2"><CopyButton text={genericConfig} /></div>
            </div>
          </section>

          {/* 第三步：使用 */}
          <section>
            <h4 className="font-semibold text-gray-900 mb-2">{t('step3H')}</h4>
            <p className="text-xs text-gray-600 leading-relaxed mb-2">
              {t('step3Desc')}
            </p>
            <blockquote className="text-xs bg-indigo-50 text-indigo-800 rounded-lg px-3 py-2 leading-relaxed">
              {t('step3Eg')}
            </blockquote>
            <p className="text-xs text-gray-500 mt-2 leading-relaxed">
              {t('step3Flow')}
            </p>
          </section>

          {/* 工具清单 */}
          <section>
            <h4 className="font-semibold text-gray-900 mb-2">{t('toolsH', { n: MCP_TOOLS.length })}</h4>
            <table className="w-full text-xs border-separate border-spacing-0">
              <tbody>
                {MCP_TOOLS.map(([name, desc]) => (
                  <tr key={name}>
                    <td className="py-1 pr-3 font-mono text-indigo-700 whitespace-nowrap align-top">{name}</td>
                    <td className="py-1 text-gray-600">{desc.startsWith('MCPKEY:') ? t(desc.slice(7)) : desc}</td>
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
  const t = useTranslations('wfMgr')
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
      showToast('error', t('loadShareFailed'))
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
      showToast('error', t('opFailed'))
    } finally {
      setLoading(false)
    }
  }

  if (workflowId == null) {
    return (
      <button
        disabled
        title={t('saveFirstShare')}
        className="px-3 py-1.5 text-xs border border-gray-200 text-gray-300 rounded-lg font-medium cursor-not-allowed inline-flex items-center gap-1.5 shrink-0"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" /></svg>
        {t('share')}
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
        {enabled ? t('shared') : t('share')}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-white border rounded-xl shadow-xl p-4 z-10 text-left" onClick={e => e.stopPropagation()}>
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
                <CopyButton text={shareUrl} />
              </div>
              <div className="flex items-center gap-2">
                <a href={shareUrl} target="_blank" rel="noreferrer" className="text-xs text-indigo-600 hover:underline">{t('openNewTab')}</a>
                <span className="text-gray-300">·</span>
                <button onClick={() => setShare(false)} disabled={loading} className="text-xs text-red-500 hover:text-red-600 disabled:opacity-50">{t('closeShare')}</button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShare(true)}
              disabled={loading}
              className="w-full px-3 py-2 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium disabled:opacity-50"
            >
              {loading ? t('generating') : t('genPublicLink')}
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
    input_schema?: string | Record<string, unknown> | null
  }
  nodes: WorkflowNodeDef[]
  dbSlug: string
  projectId?: number | null
  rightOffset?: number
  workflowId?: number | null
  onClose: () => void
}) {
  const t = useTranslations('wfMgr')
  // 对外调用基址走运行期解析：项目级(网关域名) > 平台级 > 构建期 NEXT_PUBLIC_API_URL > 浏览器 origin。
  // gatewayMode：配了网关域名时，接口文档隐藏 API Key 鉴权头（网关统一鉴权）。
  const { apiBase, gatewayMode } = usePublicApiConfig(projectId ?? undefined)
  const model = useMemo(() => deriveDocModel(meta, nodes, dbSlug), [meta, nodes, dbSlug])
  const tDoc = useTranslations('wfDoc')
  const docMarkdown = useMemo(() => buildDocMarkdown(model, apiBase, tDoc, gatewayMode), [model, apiBase, tDoc, gatewayMode])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ paddingRight: rightOffset }}>
      <div className="absolute inset-0 bg-black/40" onMouseDown={onClose} />
      <div className="relative bg-white w-[720px] max-w-[92vw] max-h-[85vh] rounded-xl shadow-xl flex flex-col">
        <div className="px-6 py-4 border-b flex items-center justify-between shrink-0">
          <div>
            <h3 className="font-semibold text-gray-800">{t('docTitle', { name: meta.name || t('unnamed') })}</h3>
            <p className="text-xs text-gray-400 mt-0.5">{t('docSubtitle')}</p>
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
  const t = useTranslations('wfMgr')
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
  const [runs, setRuns] = useState<ReplayRunSummary[]>([])
  const [showRuns, setShowRuns] = useState<number | null>(null)
  const [runDetails, setRunDetails] = useState<Record<number, ReplayRunDetail>>({})
  const [runDetailLoading, setRunDetailLoading] = useState<Record<number, boolean>>({})
  const [runDetailError, setRunDetailError] = useState<Record<number, string>>({})
  const [openRunDetails, setOpenRunDetails] = useState<Record<number, boolean>>({})
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

  // 执行回放（P0）：全屏层开关。入口原先与依赖图共用控制台暗号隐藏门（window.__depGraph +
  // localStorage），boss 拍板功能转正后整套门已拆除，入口默认展示。
  const [showReplay, setShowReplay] = useState(false)
  // 从"执行记录"某一行的"查看执行回放"点进来时，带上要预选的 run id；关闭回放层要清掉，
  // 避免下次从别处（比如依赖图入口）打开回放时被上一次的预选值污染。
  const [replayInitialRunId, setReplayInitialRunId] = useState<number | null>(null)

  // 版本控制：历史抽屉 + 本次保存备注。
  const [showVersions, setShowVersions] = useState(false)
  const [versions, setVersions] = useState<any[]>([])
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [versionDetail, setVersionDetail] = useState<any>(null)
  const [saveNote, setSaveNote] = useState(initialDraft?.saveNote ?? '')
  const [qaFindings, setQaFindings] = useState<QaFinding[] | null>(null)
  const [qaFailed, setQaFailed] = useState(false)
  const pendingPayloadRef = useRef<Record<string, unknown> | null>(null)
  const pendingPublishRef = useRef(false)
  const [canvasNonce, setCanvasNonce] = useState(0)
  const [canvasDirty, setCanvasDirty] = useState(() => !!initialDraft)
  const [dirtyResetNonce, setDirtyResetNonce] = useState(0)
  const editorGenRef = useRef(0)
  const persistEditorGenRef = useRef(0)
  const bumpEditorGen = () => {
    editorGenRef.current += 1
  }

  const markEditorClean = useCallback(() => {
    setCanvasDirty(false)
    setDirtyResetNonce((n) => n + 1)
  }, [])

  const markEditorCleanIfUnchanged = (gen: number) => {
    if (editorGenRef.current === gen) markEditorClean()
  }

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
    window.addEventListener('planeos:ai-panel', onAiPanel)
    return () => window.removeEventListener('planeos:ai-panel', onAiPanel)
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

  const blankMeta = (): WorkflowFormMeta => ({
    name: '', slug: '', description: '',
    department: SHARED_DEPARTMENT_NAME, category: UNCATEGORIZED_FOLDER_NAME,
    database_id: defaultDatabaseId != null ? String(defaultDatabaseId) : '',
    trigger_type: 'endpoint', trigger_config: '{}',
    input_schema: '',
    timeout_ms: 120000, max_retries: 0,
    alert_webhook_url: '',
    alert_webhook_template: DEFAULT_ALERT_WEBHOOK_TEMPLATE,
    alert_throttle_hours: 24,
    last_alert_sent_at: null,
  })

  function inputSchemaToForm(value: unknown): string {
    if (value == null || value === '') return ''
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return ''
    }
  }

  function parseInputSchemaForSave(raw: string): { ok: true; value: Record<string, unknown> | null } | { ok: false; error: string } {
    const trimmed = raw.trim()
    if (!trimmed) return { ok: true, value: null }
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed === null) return { ok: true, value: null }
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: t('inputSchemaMustObject') }
      }
      return { ok: true, value: parsed }
    } catch {
      return { ok: false, error: t('inputSchemaInvalidJson') }
    }
  }

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
      input_schema: draftMeta.input_schema ?? '',
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
      console.warn(t('loadCatOptsFailed'), err)
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
      console.error(t('loadDbConnFailed'), err)
    }
  }, [currentProject?.id])

  useEffect(() => { loadConnections() }, [loadConnections])

  // 手动收口卡住的执行
  // 不必等后台周期自检。作用域：workspace 场景仅当前库，老后台按后端权限（所辖租户 / 超管全量）。
  const handleCleanupRuns = async () => {
    if (
      !confirm(
        t('confirmCleanStuck'),
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
      alert(n > 0 ? t('cleanedN', { n }) : t('noStuck'))
    } catch (err: any) {
      alert(err?.response?.data?.error || t('cleanFailed'))
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
        console.error(t('fetchLatestFailed'), err)
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
        input_schema: inputSchemaToForm(latest.input_schema),
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
        { id: 'start', type: 'code', label: t('procLogic'), config: { code: 'function execute(ctx)\n  ctx.body = { ok = true }\nend' } }
      ])
      setEditorEdges([])
      syncWorkflowIdInUrl(null)
    }
    void ensureEditorTaxonomy()
    markEditorClean()
    setView('editor')
  }

  const handleCopyWorkflowLink = useCallback(
    async (workflowId: number) => {
      if (projectId == null || !Number.isFinite(projectId)) {
        showToast('error', t('copyLinkNoProject'))
        return
      }
      const url = buildWorkflowEditorUrl(projectId, workflowId)
      const ok = await copyTextToClipboard(url)
      if (ok) showToast('success', t('editLinkCopied'))
      else showToast('error', t('copyEditLinkFailed'))
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
        if (!wf) throw new Error(t('wfNotFound'))
        if (cancelled) return
        // 成功后再标记，避免 Strict Mode 二次挂载时被错误跳过
        consumedShareIdRef.current = id
        await openEditor(wf)
      } catch (err: any) {
        if (cancelled) return
        const msg =
          err?.response?.data?.error ||
          err?.message ||
          t('cantOpenShared')
        showToast('error', typeof msg === 'string' ? msg : t('cantOpenShared'))
        syncWorkflowIdInUrl(null)
      }
    })()
    return () => {
      cancelled = true
    }
    // 只跟随 workflowId 字符串；openEditor / view 用渲染时闭包即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareWorkflowIdParam])

  // 消费 ?replayRun=<运行id> 深链：须与 workflowId 同时给，等上面的深链把编辑器打开后再弹出回放层。
  // 「查看执行回放」按钮已按 lib/featureFlags.ts 隐藏，这条 URL 是线上打开回放的唯一入口。
  const replayRunParam = searchParams.get('replayRun')
  const consumedReplayRunRef = useRef<number | null>(null)
  useEffect(() => {
    if (!replayRunParam || !shareWorkflowIdParam) return
    const runId = parseInt(replayRunParam, 10)
    if (!Number.isFinite(runId) || runId <= 0) return
    if (consumedReplayRunRef.current === runId) return
    if (view !== 'editor' || editing?.id !== parseInt(shareWorkflowIdParam, 10)) return
    consumedReplayRunRef.current = runId
    setReplayInitialRunId(runId)
    setShowReplay(true)
  }, [replayRunParam, shareWorkflowIdParam, view, editing?.id])

  // 从 session 草稿恢复到已有工作流时，补齐地址栏 workflowId。
  useEffect(() => {
    if (initialDraft?.editing?.id) {
      syncWorkflowIdInUrl(initialDraft.editing.id)
      consumedShareIdRef.current = initialDraft.editing.id
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleCanvasChange = useCallback((nodes: WorkflowNodeDef[], edges: WorkflowEdgeDef[]) => {
    bumpEditorGen()
    setEditorNodes(nodes)
    setEditorEdges(edges)
    setCanvasDirty(true)
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
        console.error(t('moveCatFailed'), err)
        showToast('error', t('moveCatFailedToast'))
        throw err
      }
    },
    [defaultDatabaseId, refreshList],
  )

  const handleRenameFolder = useCallback(
    async (folderId: string, newName: string, opts: { workflowCount: number }) => {
      if (opts.workflowCount <= 0) return

      try {
        const dept = deptNameFromId(folderId)
        if (dept) {
          const affected = await fetchWorkflowsByDepartment(dept, defaultDatabaseId)
          await Promise.all(
            affected.map((wf) =>
              api.patch(`/api/admin/workflows/${wf.id}`, { department: newName }),
            ),
          )
        } else {
          const cat = catNamesFromId(folderId)
          if (!cat) return
          const affected = await fetchWorkflowsByCategory(cat.dept, cat.cat, defaultDatabaseId)
          await Promise.all(
            affected.map((wf) =>
              api.patch(`/api/admin/workflows/${wf.id}`, { category: newName }),
            ),
          )
        }
        refreshList()
      } catch (err) {
        console.error(t('renameSyncFailed'), err)
        showToast('error', t('renameSyncFailedToast'))
        throw err
      }
    },
    [defaultDatabaseId, refreshList],
  )

  const applyEditorWorkflow = (
    wf: Workflow,
    extras?: { depsStatus?: WorkflowDepsStatus | null; pyDepsStatus?: WorkflowDepsStatus | null },
  ) => {
    const tax = resolveWorkflowTaxonomy(wf)
    setEditing(wf)
    setWorkflowDependencies(wf.dependencies ?? null)
    if (extras && 'depsStatus' in extras) setDepsStatus(extras.depsStatus ?? null)
    if (extras && 'pyDepsStatus' in extras) setPyDepsStatus(extras.pyDepsStatus ?? null)
    setFormMeta({
      name: wf.name, slug: wf.slug,
      description: wf.description || '',
      department: tax.department || SHARED_DEPARTMENT_NAME,
      category: tax.category || '',
      database_id: wf.database_id?.toString() || '',
      trigger_type: wf.trigger_type,
      trigger_config: JSON.stringify(wf.trigger_config || {}, null, 2),
      input_schema: inputSchemaToForm(wf.input_schema),
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
    setCanvasNonce((n) => n + 1)
    markEditorClean()
  }

  const buildPayload = (): Record<string, unknown> | null => {
    let triggerConfig: any
    try { triggerConfig = JSON.parse(formMeta.trigger_config) } catch {
      alert(t('triggerJsonError'))
      return null
    }
    const parsedInputSchema = parseInputSchemaForSave(formMeta.input_schema ?? '')
    if (!parsedInputSchema.ok) {
      alert(parsedInputSchema.error)
      return null
    }
    let alertWebhookTemplate: Record<string, unknown> | null = null
    if ((formMeta.alert_webhook_url ?? '').trim()) {
      try {
        const parsed = JSON.parse(formMeta.alert_webhook_template || '{}')
        if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
          alert(t('alertTemplateMustObject'))
          return null
        }
        alertWebhookTemplate = parsed as Record<string, unknown>
      } catch {
        alert(t('alertTemplateJsonError'))
        return null
      }
    }
    let normalizedNodes: WorkflowNodeDef[]
    try {
      normalizedNodes = normalizeNodesForExecution(editorNodes, t)
    } catch (err: any) {
      alert(err?.message || t('nodeConfigJsonError'))
      return null
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
    return {
      name: formMeta.name,
      slug: formMeta.slug,
      description: formMeta.description || null,
      department: placement.department,
      category: placement.category,
      database_id: formMeta.database_id ? parseInt(formMeta.database_id) : null,
      trigger_type: formMeta.trigger_type,
      trigger_config: triggerConfig,
      input_schema: parsedInputSchema.value,
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
  }

  const persistWorkflow = async ({ closeEditor }: { closeEditor: boolean }): Promise<Workflow | undefined> => {
    const payload = pendingPayloadRef.current
    if (!payload) return undefined
    const gen = persistEditorGenRef.current
    try {
      const res = editing
        ? await api.patch(`/api/admin/workflows/${editing.id}`, payload)
        : await api.post('/api/admin/workflows', payload)
      const workflow = res.data?.workflow as Workflow | undefined
      pendingPayloadRef.current = null
      markEditorCleanIfUnchanged(gen)
      if (closeEditor) {
        setSaveNote('')
        setView('list')
        consumedShareIdRef.current = null
        syncWorkflowIdInUrl(null)
        refreshList()
      } else if (workflow) {
        setEditing(workflow)
        consumedShareIdRef.current = workflow.id
        syncWorkflowIdInUrl(workflow.id)
        refreshList()
      }
      return workflow
    } catch (err: any) {
      alert(err.response?.data?.error || t('saveFailed'))
      return undefined
    }
  }

  const persistThenPublish = async () => {
    const gen = persistEditorGenRef.current
    const saved = await persistWorkflow({ closeEditor: false })
    if (!saved) {
      pendingPublishRef.current = false
      return
    }
    try {
      const res = await api.post(`/api/admin/workflows/${saved.id}/publish`, {
        version_note: saveNote.trim() || null,
      })
      const workflow = res.data?.workflow as Workflow | undefined
      if (workflow) setEditing(workflow)
      setSaveNote('')
      pendingPublishRef.current = false
      markEditorCleanIfUnchanged(gen)
      showToast('success', t('published'))
      refreshList()
    } catch (err: any) {
      pendingPublishRef.current = false
      alert(err.response?.data?.error || t('publishFailed'))
    }
  }

  const runSaveQa = async () => {
    const payload = pendingPayloadRef.current
    if (!payload) return
    try {
      const res = await api.post('/api/admin/workflows/qa', {
        id: editing?.id ?? null,
        slug: payload.slug,
        database_id: payload.database_id,
        trigger_type: payload.trigger_type,
        input_schema: payload.input_schema,
        nodes: payload.nodes,
        edges: payload.edges,
      })
      const findings = (res.data?.findings ?? []) as QaFinding[]
      if (findings.length === 0) {
        if (pendingPublishRef.current) {
          await persistThenPublish()
        } else {
          await persistWorkflow({ closeEditor: true })
        }
        return
      }
      setQaFailed(false)
      setQaFindings(findings)
    } catch {
      showToast('error', t('qaPrecheckFailed'))
      setQaFailed(true)
      setQaFindings([])
    }
  }

  const dismissQaModal = () => {
    setQaFindings(null)
    setQaFailed(false)
  }

  const handleSave = async () => {
    const payload = buildPayload()
    if (!payload) return
    pendingPayloadRef.current = payload
    pendingPublishRef.current = false
    persistEditorGenRef.current = editorGenRef.current
    await runSaveQa()
  }

  const handlePublish = async () => {
    const payload = buildPayload()
    if (!payload) return
    pendingPayloadRef.current = payload
    pendingPublishRef.current = true
    persistEditorGenRef.current = editorGenRef.current
    await runSaveQa()
  }

  const handleDiscardDraft = async () => {
    if (!editing) return
    if (!confirm(t('confirmDiscard'))) return
    try {
      const res = await api.post(`/api/admin/workflows/${editing.id}/discard-draft`)
      const workflow = res.data?.workflow as Workflow | undefined
      if (!workflow) throw new Error('empty')
      applyEditorWorkflow(workflow)
      showToast('success', t('draftDiscarded'))
      refreshList()
    } catch (err: any) {
      alert(err.response?.data?.error || t('discardDraftFailed'))
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
      alert(err?.response?.data?.error || t('loadVersionsFailed'))
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
      alert(err?.response?.data?.error || t('loadVersionDetailFailed'))
    }
  }

  // 恢复到某版本：后端把该快照写入草稿（不上线），前端重新载入编辑器。
  const restoreVersion = async (version: number) => {
    if (!editing) return
    if (!confirm(t('confirmRestore', { v: version }))) {
      return
    }
    try {
      await api.post(`/api/admin/workflows/${editing.id}/versions/${version}/restore`)
      const res = await api.get(`/api/admin/workflows/${editing.id}`)
      const wf: Workflow = res.data.workflow
      applyEditorWorkflow(wf, {
        depsStatus: (res.data?.deps_status as WorkflowDepsStatus | undefined) ?? null,
        pyDepsStatus: (res.data?.py_deps_status as WorkflowDepsStatus | undefined) ?? null,
      })
      setShowVersions(false)
      setVersionDetail(null)
      refreshList()
      alert(t('restoredOk', { v: version }))
    } catch (err: any) {
      alert(err?.response?.data?.error || t('restoreFailed'))
    }
  }

  // 编辑态调试：对当前（可能未保存）的 nodes/edges 跑一遍，返回逐节点结果。
  const handleDebugRun = async () => {
    let triggerData: any
    try {
      triggerData = debugInput.trim() ? JSON.parse(debugInput) : {}
    } catch {
      setDebugError(t('debugInputInvalidJson'))
      return
    }
    let normalizedNodes: WorkflowNodeDef[]
    try {
      normalizedNodes = normalizeNodesForExecution(editorNodes, t)
    } catch (err: any) {
      setDebugError(err?.message || t('nodeConfigJsonError'))
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
      setDebugError(err.response?.data?.error || t('debugRunFailed'))
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
      showToast('success', t('wfDeleted'))
    } catch (err: any) {
      showToast('error', err.response?.data?.error || t('deleteFailed'))
    } finally {
      setDeleting(false)
    }
  }

  const handleListPublish = async (id: number) => {
    try {
      await api.post(`/api/admin/workflows/${id}/publish`, { version_note: null })
      refreshList()
      showToast('success', t('published'))
    } catch (err: any) {
      showToast('error', err.response?.data?.error || t('publishFailed'))
    }
  }

  const handleListDiscardDraft = async (id: number) => {
    if (!confirm(t('confirmDiscard2'))) return
    try {
      await api.post(`/api/admin/workflows/${id}/discard-draft`)
      refreshList()
      showToast('success', t('draftDiscarded'))
    } catch (err: any) {
      showToast('error', err.response?.data?.error || t('discardDraftFailed'))
    }
  }

  const handleTrigger = async (wf: { id: number; published_version?: number | null }) => {
    if (wf.published_version == null) {
      showToast('error', t('notPublished'))
      return
    }
    // 二次确认：手动运行会真实执行全部节点（写库 / HTTP / 邮件 / Stripe 等副作用与费用），不可逆。
    if (!confirm(t('confirmManualRun'))) return
    try {
      await api.post(`/api/admin/workflows/${wf.id}/trigger`, {})
      showToast('success', t('wfTriggered'))
      if (showRuns === wf.id) loadRuns(wf.id)
    } catch (err: any) {
      showToast('error', err.response?.data?.error || t('triggerFailed'))
    }
  }

  const loadRuns = async (id: number) => {
    try {
      const res = await api.get(`/api/admin/workflows/${id}/runs?limit=20`)
      setRuns(res.data.runs || [])
      setShowRuns(id)
      setRunDetails({})
      setRunDetailLoading({})
      setRunDetailError({})
      setOpenRunDetails({})
    } catch {}
  }

  const ensureRunDetail = async (workflowId: number, runId: number) => {
    const loaded = new Set(Object.keys(runDetails).map(Number))
    if (runDetailFetchId(runId, true, loaded) == null) return
    if (runDetailLoading[runId]) return
    setRunDetailLoading((s) => ({ ...s, [runId]: true }))
    setRunDetailError((s) => {
      const next = { ...s }
      delete next[runId]
      return next
    })
    try {
      const detail = await fetchReplayRunDetail(workflowId, runId)
      setRunDetails((s) => ({ ...s, [runId]: detail }))
    } catch (err: unknown) {
      const ax = err as { response?: { data?: { error?: string } }; message?: string }
      setRunDetailError((s) => ({
        ...s,
        [runId]: ax.response?.data?.error || ax.message || t('loadFailed'),
      }))
    } finally {
      setRunDetailLoading((s) => ({ ...s, [runId]: false }))
    }
  }

  // "执行记录"某一行点"查看执行回放"：预选这次 run 并打开回放层。回放图要画节点/连线结构，
  // 而"执行记录"弹层可能是从列表直接打开的（没进编辑器、editorNodes/editorEdges 是空的）——
  // 此时借用 openEditor 把该工作流的最新定义拉进编辑器状态，和"编辑"按钮走的是同一条路径，
  // 不重复发明一套加载逻辑；已经在编辑同一个工作流时跳过这一步，避免多余的网络请求。
  const handleViewReplay = async (run: ReplayRunSummary) => {
    setReplayInitialRunId(run.id)
    if (editing?.id !== run.workflow_id) {
      await openEditor({ id: run.workflow_id } as Workflow)
    }
    setShowRuns(null)
    setShowReplay(true)
  }

  const handleToggle = async (wf: Workflow) => {
    try {
      await api.patch(`/api/admin/workflows/${wf.id}`, { is_enabled: !wf.is_enabled })
      refreshList()
      showToast('success', wf.is_enabled ? t('disabled') : t('enabled'))
    } catch (err: any) {
      showToast('error', err.response?.data?.error || t('opFailed2'))
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
      showToast('success', next ? t('enabled') : t('disabled'))
    } catch (err: any) {
      showToast('error', err.response?.data?.error || t('opFailed2'))
    }
  }

  // 复制：服务端一键克隆（自动生成唯一 slug、默认禁用），刷新列表。
  const handleDuplicate = async (id: number) => {
    try {
      await api.post(`/api/admin/workflows/${id}/duplicate`, {})
      await refreshList()
    } catch (err: any) {
      alert(err.response?.data?.error || t('copyFailed'))
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
      return showToast('error', t('triggerJsonExportErr'))
    }
    const parsedInputSchema = parseInputSchemaForSave(formMeta.input_schema ?? '')
    if (!parsedInputSchema.ok) return showToast('error', `${parsedInputSchema.error}${t('cantExportSuffix')}`)
    let alertWebhookTemplate: Record<string, unknown> | null = null
    if ((formMeta.alert_webhook_url ?? '').trim()) {
      try {
        const parsed = JSON.parse(formMeta.alert_webhook_template || '{}')
        if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
          return showToast('error', t('alertTemplateMustObjectExport'))
        }
        alertWebhookTemplate = parsed as Record<string, unknown>
      } catch {
        return showToast('error', t('alertTemplateJsonErrExport'))
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
      input_schema: parsedInputSchema.value,
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

  const liveSlug = editing ? (editing.published_slug ?? editing.slug) : formMeta.slug
  const editorEndpointPath =
    formMeta.trigger_type === 'endpoint' && liveSlug
      ? `POST /workflow/${endpointRouteForDb(formMeta.database_id ? parseInt(formMeta.database_id) : null)}/${liveSlug}`
      : undefined

  // ── List + Editor：列表保持挂载，进入详情时仅隐藏，返回后保留翻页等状态 ──
  return (
    <>
      <div className={view === 'editor' ? 'hidden' : undefined} aria-hidden={view === 'editor'}>
        <WorkflowListView
          cleaning={cleaning}
          defaultDatabaseId={defaultDatabaseId}
          projectId={projectId}
          refreshToken={listRefreshToken}
          onSummaryChange={handleSummaryChange}
          onNewWorkflow={(folderPlacement) => openEditor(undefined, folderPlacement)}
          onEdit={(wf) => openEditor(wf)}
          onToggle={handleToggle}
          onPublish={(wf) => void handleListPublish(wf.id)}
          onDiscardDraft={(wf) => void handleListDiscardDraft(wf.id)}
          onRun={(wf) => handleTrigger(wf)}
          onShowRuns={(wf) => loadRuns(wf.id)}
          onDuplicate={(wf) => handleDuplicate(wf.id)}
          onShare={(wf) => void handleCopyWorkflowLink(wf.id)}
          onOpenVersionHistory={
            projectId != null
              ? (wf) => router.push(workflowVersionsPath(projectId, wf.id))
              : undefined
          }
          onExport={(wf) => handleExport(wf as Workflow)}
          onDelete={handleDeleteRequest}
          onCleanupRuns={handleCleanupRuns}
          onShowMcpGuide={() => setShowMcpGuide(true)}
          onMoveCategory={handleMoveCategory}
          onRenameFolder={handleRenameFolder}
        />

        {showMcpGuide && <McpGuideModal onClose={() => setShowMcpGuide(false)} />}

        <WorkflowConfirmDialog
          open={deleteTarget !== null}
          title={t('deleteWfTitle')}
          message={
            deleteTarget
              ? t('confirmDeleteWf', { name: deleteTarget.name })
              : ''
          }
          confirmLabel={t('delete')}
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
          setFormMeta={(update) => {
            bumpEditorGen()
            setFormMeta(update)
          }}
          editorDepartments={editorDepartments}
          editorCategories={editorCategories}
          databaseOptions={databaseOptions}
          triggerTypes={TRIGGER_TYPES}
          endpointPath={editorEndpointPath}
          saveNote={saveNote}
          setSaveNote={setSaveNote}
          onBack={backToList}
          onSave={handleSave}
          onPublish={handlePublish}
          onDiscardDraft={editing ? handleDiscardDraft : undefined}
          hasUnpublished={!!editing?.has_unpublished}
          publishedVersion={editing?.published_version ?? null}
          liveSlug={liveSlug}
          canvasDirty={canvasDirty}
          dirtyResetNonce={dirtyResetNonce}
          onShowHelp={() => setShowHelp(true)}
          onShowDebug={() => { setShowDebug(true); setDebugResult(null); setDebugError(null) }}
          onShowVersions={editing ? openVersions : undefined}
          onShowRuns={editing ? () => loadRuns(editing.id) : undefined}
          onToggleEnabled={editing ? handleToggleEditing : undefined}
          onShare={editing ? () => void handleCopyWorkflowLink(editing.id) : undefined}
          onExport={handleExportEditor}
          onDepartmentChange={(department) => {
            bumpEditorGen()
            setFormMeta((f) => {
              const cats = editorCategoryOptions(taxonomyGroups, editorFolders, department, f.category)
              const category = f.category && cats.includes(f.category) ? f.category : UNCATEGORIZED_FOLDER_NAME
              return { ...f, department, category }
            })
          }}
          workflowDependencies={workflowDependencies}
          onWorkflowDependenciesChange={(deps) => {
            bumpEditorGen()
            setWorkflowDependencies(deps)
          }}
          depsStatus={depsStatus}
          pyDepsStatus={pyDepsStatus}
        />

        {/* Canvas */}
        <div className="flex-1 min-h-0">
          <WorkflowCanvas
            key={`${editing?.id || 'new'}-${canvasNonce}`}
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
          <div className="fixed inset-0 z-50 flex justify-end" style={{ paddingRight: aiOffset }}>
            <div className="absolute inset-0 bg-black/30" onMouseDown={() => setShowVersions(false)} />
            <div className="relative bg-white w-full max-w-lg h-full shadow-xl flex flex-col">
              <div className="px-5 py-4 border-b flex items-center justify-between shrink-0">
                <h3 className="font-semibold text-gray-800 flex items-center gap-2">
                  <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  {t('versionHistory')}
                </h3>
                <div className="flex items-center gap-2 shrink-0">
                  {projectId != null && editing && (
                    <a
                      href={workflowVersionsPath(projectId, editing.id)}
                      onClick={(e) => {
                        e.preventDefault()
                        router.push(workflowVersionsPath(projectId, editing.id))
                      }}
                      className="text-xs text-indigo-600 hover:underline"
                    >
                      {t('openInPage')}
                    </a>
                  )}
                  <button onClick={() => setShowVersions(false)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
                </div>
              </div>

              <div className="p-5 overflow-y-auto flex-1 space-y-3">
                <p className="text-xs text-gray-400">
                  {t('versionHistoryDesc')}
                </p>
                {versionsLoading ? (
                  <div className="text-center py-10 text-gray-400 text-sm">{t('loading')}</div>
                ) : versions.length === 0 ? (
                  <div className="text-center py-10 text-gray-400 text-sm">{t('noVersions')}</div>
                ) : (
                  versions.map((v, idx) => (
                    <div key={v.id} className="border rounded-lg p-3 text-sm">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-semibold text-gray-800">v{v.version}</span>
                          {idx === 0 && <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-xs">{t('latest')}</span>}
                          {typeof v.node_count === 'number' && <span className="text-xs text-gray-400">{t('nodesCount', { n: v.node_count })}</span>}
                        </div>
                        <div className="flex items-center gap-2">
                          <button onClick={() => viewVersion(v.version)} className="text-xs px-2 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50">{t('view')}</button>
                          {projectId != null && editing && (
                            <button
                              type="button"
                              onClick={() => router.push(workflowVersionsPath(projectId, editing.id, v.version))}
                              className="text-xs px-2 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
                            >
                              {t('page')}
                            </button>
                          )}
                          {idx !== 0 && (
                            <button onClick={() => restoreVersion(v.version)} className="text-xs px-2 py-0.5 rounded border border-indigo-300 text-indigo-600 hover:bg-indigo-50">{t('restore')}</button>
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
                            {t.rich('versionMeta', { name: versionDetail.name, slug: versionDetail.slug, trigger: versionDetail.trigger_type, s: (c) => <span className="text-gray-700">{c}</span>, m: (c) => <span className="font-mono text-gray-700">{c}</span> })}
                          </div>
                          <details>
                            <summary className="cursor-pointer text-gray-500 hover:text-gray-700">{t('nodesEdgesJson')}</summary>
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
          <div className="fixed inset-0 z-50 flex justify-end" style={{ paddingRight: aiOffset }}>
            <div className="absolute inset-0 bg-black/30" onMouseDown={() => setShowDebug(false)} />
            <div className="relative bg-white w-full max-w-xl h-full shadow-xl flex flex-col">
              <div className="px-5 py-4 border-b flex items-center justify-between shrink-0">
                <h3 className="font-semibold text-gray-800 flex items-center gap-2">
                  <span className="text-amber-500">●</span> {t('debugRun')}
                </h3>
                <button onClick={() => setShowDebug(false)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
              </div>

              <div className="p-5 overflow-y-auto flex-1 space-y-4">
                {debugDryRun ? (
                  <div className="bg-sky-50 border border-sky-200 text-sky-800 text-xs rounded-lg p-3 leading-relaxed">
                    {t('dryRunHint')}
                  </div>
                ) : (
                  <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-lg p-3 leading-relaxed">
                    {t('realRunHint')}
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
                    {t('dryRunCheckbox')}
                  </span>
                </label>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('testInput')}
                  </label>
                  <textarea
                    value={debugInput}
                    onChange={e => setDebugInput(e.target.value)}
                    className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
                    rows={6}
                    placeholder={'{\n  "candidate_email": "test@example.com"\n}'}
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    {t.rich('testInputHint', { tpl: '{{trigger.field}}', code: (c) => <code className="bg-gray-100 px-1 rounded">{c}</code> })}
                  </p>
                </div>

                <button
                  onClick={handleDebugRun}
                  disabled={debugRunning}
                  className={`w-full py-2 text-white rounded-lg font-medium disabled:opacity-50 ${debugDryRun ? 'bg-sky-500 hover:bg-sky-600' : 'bg-amber-500 hover:bg-amber-600'}`}
                >
                  {debugRunning ? t('debugRunning') : debugDryRun ? t('dryDebug') : t('realDebug')}
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
                      <div className="text-xs font-medium text-gray-500">{t('perNodeResults')}</div>
                      <NodeResultList results={debugResult.node_results || []} />
                    </div>

                    {debugResult.final_output != null && (
                      <details>
                        <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600">{t('finalOutput')}</summary>
                        <JsonLogBlock value={debugResult.final_output} />
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

      {showReplay && editing && (
        <ExecutionReplayView
          workflowId={editing.id}
          nodes={editorNodes}
          edges={editorEdges}
          initialRunId={replayInitialRunId}
          onClose={() => {
            setShowReplay(false)
            setReplayInitialRunId(null)
          }}
        />
      )}

      {showRuns !== null && (
        <div
          className="fixed bg-black/30 flex items-center justify-center z-50"
          style={{ top: 0, left: 0, right: 'var(--ai-panel-offset, 0px)', bottom: 0 }}
          onMouseDown={closeOnBackdropPress(() => setShowRuns(null))}
        >
          <div className="bg-white rounded-xl shadow-xl w-[960px] max-w-[95vw] max-h-[85vh] overflow-hidden">
            <div className="p-4 border-b flex justify-between items-center">
              <div>
                <h3 className="font-semibold">{t('execRecords')}</h3>
                <p className="text-xs text-gray-400 mt-0.5">{t('execRecordsDesc')}</p>
              </div>
              <button onClick={() => setShowRuns(null)} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
            </div>
            <div className="overflow-auto max-h-[70vh] p-4">
              {runs.length === 0 ? (
                <p className="text-center text-gray-400 py-8">{t('noExecRecords')}</p>
              ) : (
                <div className="space-y-4">
                  {runs.map(run => {
                    const executed = run.executed_count ?? 0
                    const failed = run.failed_count ?? 0
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
                            {executed > 0 && (
                              <span className="text-xs text-gray-400">
                                {t('nodesExecuted', { n: executed })}
                                {failed > 0 && <span className="text-red-500 ml-1">{t('failedN', { n: failed })}</span>}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            <span className="text-xs text-gray-400">{formatDateTime(run.started_at)}</span>
                            {EXECUTION_REPLAY_ENTRY_VISIBLE && (
                              <button
                                onClick={() => handleViewReplay(run)}
                                className="text-xs text-indigo-600 hover:text-indigo-800 whitespace-nowrap"
                              >
                                <i className="fas fa-diagram-project mr-1"></i>{t('viewReplay')}
                              </button>
                            )}
                          </div>
                        </div>
                        {run.error_message && (
                          <div className="mt-2 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg p-2 font-mono">
                            {run.error_message}
                          </div>
                        )}
                        <details
                          className="mt-3"
                          open={!!openRunDetails[run.id]}
                          onToggle={(e) => {
                            const open = (e.currentTarget as HTMLDetailsElement).open
                            setOpenRunDetails((s) => ({ ...s, [run.id]: open }))
                            if (open && showRuns != null) void ensureRunDetail(showRuns, run.id)
                          }}
                        >
                          <summary className="text-xs font-medium text-gray-500 cursor-pointer hover:text-gray-700 select-none">
                            {t('perNodeDetail', { n: run.node_count ?? 0 })}
                          </summary>
                          <div className="mt-2">
                            {runDetailLoading[run.id] && <p className="text-xs text-gray-400">{t('loading')}</p>}
                            {runDetailError[run.id] && (
                              <p className="text-xs text-red-600">
                                {runDetailError[run.id]}{' '}
                                <button
                                  type="button"
                                  className="underline"
                                  onClick={() => showRuns != null && void ensureRunDetail(showRuns, run.id)}
                                >
                                  {t('retry')}
                                </button>
                              </p>
                            )}
                            {runDetails[run.id]?.node_results && (
                              <NodeResultList results={runDetails[run.id].node_results as NodeResultItem[]} />
                            )}
                            {runDetails[run.id]?.final_output != null && (
                              <details className="mt-2">
                                <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600">{t('finalOutput')}</summary>
                                <JsonLogBlock value={runDetails[run.id].final_output} />
                              </details>
                            )}
                          </div>
                        </details>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <Modal
        isOpen={qaFindings !== null}
        onClose={dismissQaModal}
        title={qaFailed ? t('qaPrecheckFailed') : t('qaTitle', { n: qaFindings?.length ?? 0 })}
        size="md"
        closeOnOverlayClick={false}
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={dismissQaModal}
              className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800"
            >
              {t('backToEdit')}
            </button>
            <button
              type="button"
              onClick={() => {
                dismissQaModal()
                if (pendingPublishRef.current) {
                  void persistThenPublish()
                } else {
                  void persistWorkflow({ closeEditor: true })
                }
              }}
              className="px-4 py-2 text-sm rounded-lg font-medium bg-indigo-600 text-white hover:bg-indigo-700"
            >
              {t('saveAnyway')}
            </button>
          </div>
        }
      >
        {qaFailed && (qaFindings?.length ?? 0) === 0 ? (
          <p className="text-sm text-slate-600">{t('canStillSave')}</p>
        ) : (
          <ul className="space-y-3 max-h-80 overflow-y-auto">
            {(qaFindings ?? []).map((finding, idx) => (
              <li key={`${finding.code}-${finding.node_id ?? ''}-${idx}`} className="flex gap-2.5">
                <span
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${QA_DOT[finding.severity] ?? QA_DOT.low}`}
                />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-800">{finding.title}</div>
                  {finding.node_label ? (
                    <div className="text-xs text-slate-400 mt-0.5">{finding.node_label}</div>
                  ) : null}
                  <div className="text-sm text-slate-600 mt-0.5">{finding.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </>
  )
}
