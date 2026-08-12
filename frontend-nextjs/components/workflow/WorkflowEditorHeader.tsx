'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { useParams } from 'next/navigation'
import { cn } from '@/lib/utils'
import { kafkaAPI, type KafkaConnection } from '@/lib/api'
import { copyTextToClipboard } from '@/lib/clipboard'
import { TRIGGER_BADGE_CLASS, TRIGGER_ICON_CLASS, TRIGGER_META } from './list/constants'

export interface WorkflowDependencies {
  javascript?: {
    packageJson?: {
      name?: string
      private?: boolean
      dependencies?: Record<string, string>
    }
    packageLock?: string | null
  }
  python?: {
    requirements?: string[]
  }
}

export interface WorkflowDepsStatus {
  status: 'idle' | 'installing' | 'ready' | 'failed'
  error?: string
  hash?: string
}

function depsStatusLabel(status: WorkflowDepsStatus['status']): string {
  switch (status) {
    case 'installing':
      return '安装中'
    case 'ready':
      return '就绪'
    case 'failed':
      return '失败'
    default:
      return '空闲'
  }
}

function depsStatusBadgeClass(status: WorkflowDepsStatus['status']): string {
  switch (status) {
    case 'installing':
      return 'bg-blue-50 text-blue-700 border-blue-200'
    case 'ready':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200'
    case 'failed':
      return 'bg-red-50 text-red-700 border-red-200'
    default:
      return 'bg-slate-100 text-slate-600 border-slate-200'
  }
}

function extractJsDependencies(deps: WorkflowDependencies | null | undefined): Record<string, string> {
  return deps?.javascript?.packageJson?.dependencies ?? {}
}

function mergeJsDependencies(
  existing: WorkflowDependencies | null | undefined,
  slug: string,
  dependencies: Record<string, string>,
): WorkflowDependencies {
  const pkg = existing?.javascript?.packageJson
  return {
    ...existing,
    javascript: {
      packageLock: existing?.javascript?.packageLock ?? null,
      packageJson: {
        name: pkg?.name || `workflow-${slug || 'draft'}`,
        private: true,
        dependencies,
      },
    },
  }
}

/** Drop only the JavaScript section; preserve any Python (and other) deps. */
function removeJsDependencies(
  existing: WorkflowDependencies | null | undefined,
): WorkflowDependencies | null {
  if (!existing) return null
  const { javascript: _js, ...rest } = existing
  return Object.keys(rest).length > 0 ? rest : null
}

function extractPyRequirements(deps: WorkflowDependencies | null | undefined): string[] {
  return deps?.python?.requirements ?? []
}

function mergePyDependencies(
  existing: WorkflowDependencies | null | undefined,
  requirements: string[],
): WorkflowDependencies {
  return {
    ...existing,
    python: { requirements },
  }
}

/** Drop only the Python section; preserve any JavaScript (and other) deps. */
function removePyDependencies(
  existing: WorkflowDependencies | null | undefined,
): WorkflowDependencies | null {
  if (!existing) return null
  const { python: _py, ...rest } = existing
  return Object.keys(rest).length > 0 ? rest : null
}

interface TriggerType {
  value: string
  label: string
  icon: string
}

interface DatabaseOption {
  database_id: number
  connection_name?: string
  db_name: string
  db_host: string
  db_port: number
  is_primary?: boolean
}

interface FormMeta {
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

interface Props {
  editingName?: string
  isEnabled?: boolean
  formMeta: FormMeta
  setFormMeta: React.Dispatch<React.SetStateAction<FormMeta>>
  editorDepartments: string[]
  editorCategories: string[]
  databaseOptions: DatabaseOption[]
  triggerTypes: TriggerType[]
  endpointPath?: string
  saveNote: string
  setSaveNote: (v: string) => void
  onBack: () => void
  onSave: () => void
  onShowHelp: () => void
  onShowDebug: () => void
  onShowVersions?: () => void
  onExport?: () => void
  /** 复制当前工作流的登录深链；仅已保存（有 id）时提供。 */
  onShare?: () => void
  onShowRuns?: () => void
  onDepartmentChange: (department: string) => void
  /** 切换启用/禁用；仅在已保存的工作流（有 id）时提供。 */
  onToggleEnabled?: () => void
  workflowDependencies: WorkflowDependencies | null
  onWorkflowDependenciesChange: (deps: WorkflowDependencies | null) => void
  depsStatus: WorkflowDepsStatus | null
  pyDepsStatus: WorkflowDepsStatus | null
}

function dbLabel(opt: DatabaseOption) {
  const name = opt.connection_name || opt.db_name
  return `${name} (${opt.db_host})${opt.is_primary ? ' · 主' : ''}`
}

const DEFAULT_KAFKA_TRIGGER_CONFIG = {
  connection_id: 0,
  topic: '',
  group_id: '',
  auto_offset_reset: 'latest',
  value_format: 'json',
}

function KafkaTriggerConfig({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const params = useParams<{ projectId: string }>()
  const tenantId = parseInt(params?.projectId ?? '', 10)
  const [connections, setConnections] = useState<KafkaConnection[]>([])
  const [loading, setLoading] = useState(true)
  let parsed: Record<string, unknown> = DEFAULT_KAFKA_TRIGGER_CONFIG
  try {
    const candidate = JSON.parse(value || '{}')
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      parsed = { ...DEFAULT_KAFKA_TRIGGER_CONFIG, ...candidate }
    }
  } catch {
    // Keep the form usable if a legacy draft contains malformed JSON.
  }

  useEffect(() => {
    let alive = true
    setLoading(true)
    kafkaAPI
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

  const update = (key: string, nextValue: string | number) => {
    onChange(JSON.stringify({ ...parsed, [key]: nextValue }, null, 2))
  }

  const fieldClass =
    'h-8 px-2 border border-slate-200 rounded-md bg-white text-xs text-slate-700 outline-none focus:border-emerald-400'

  const offset = String(parsed.auto_offset_reset ?? 'latest')
  const groupId = String(parsed.group_id ?? '').trim()

  return (
    <div className="border-t border-[#f0f1f3]">
      <div className="flex items-end gap-3 px-4 py-2.5 overflow-x-auto">
        <label className="flex flex-col gap-1 min-w-[220px]">
          <span className="text-[10px] font-bold uppercase tracking-[0.06em] text-[#b0bac5]">Kafka 连接</span>
          <select
            value={Number(parsed.connection_id) || 0}
            onChange={(e) => update('connection_id', Number(e.target.value))}
            className={fieldClass}
          >
            <option value={0}>{loading ? '加载中…' : '请选择连接'}</option>
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.connection_name}（{connection.brokers}）
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 min-w-[210px] flex-1">
          <span className="text-[10px] font-bold uppercase tracking-[0.06em] text-[#b0bac5]">Topic</span>
          <input
            value={String(parsed.topic ?? '')}
            onChange={(e) => update('topic', e.target.value)}
            className={`${fieldClass} font-mono`}
            placeholder="与 produce 侧完全一致"
          />
        </label>
        <label className="flex flex-col gap-1 min-w-[220px]">
          <span className="text-[10px] font-bold uppercase tracking-[0.06em] text-[#b0bac5]">Group ID（可选）</span>
          <input
            value={String(parsed.group_id ?? '')}
            onChange={(e) => update('group_id', e.target.value)}
            className={`${fieldClass} font-mono`}
            placeholder="留空则用 onebase-wf-{工作流id}"
          />
        </label>
        <label className="flex flex-col gap-1 min-w-[150px]">
          <span className="text-[10px] font-bold uppercase tracking-[0.06em] text-[#b0bac5]">初始 Offset</span>
          <select
            value={offset}
            onChange={(e) => update('auto_offset_reset', e.target.value)}
            className={fieldClass}
          >
            <option value="latest">latest（跳过历史）</option>
            <option value="earliest">earliest（可读积压）</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 min-w-[130px]">
          <span className="text-[10px] font-bold uppercase tracking-[0.06em] text-[#b0bac5]">消息格式</span>
          <select
            value={String(parsed.value_format ?? 'json')}
            onChange={(e) => update('value_format', e.target.value)}
            className={fieldClass}
          >
            <option value="json">JSON</option>
            <option value="text">Text</option>
          </select>
        </label>
      </div>
      <div className="px-4 pb-2 text-[11px] text-slate-500 space-y-0.5">
        <p>
          Group 建议固定完整名称（如 <code className="font-mono text-slate-700">onebase-ai-close-ticket</code>
          ）；改名等于新消费组。可在「Kafka → 消费组」核对是否在线。
          {groupId ? (
            <span className="ml-1 font-mono text-slate-600">当前：{groupId}</span>
          ) : null}
        </p>
        {offset === 'latest' ? (
          <p className="text-amber-700">
            latest：消费组首次无 committed offset 时从末尾读，已在 topic 里的消息不会被消费。联调积压请改 earliest，或 consumer 就绪后再 produce。
          </p>
        ) : (
          <p>
            earliest：无 committed offset 时从最早可读位置开始（注意历史消息可能被重复处理）。
          </p>
        )}
      </div>
    </div>
  )
}

type SelectMenuOption = {
  value: string
  label: string
  icon?: string
  iconClass?: string
  mono?: boolean
}

function InlineSelectMenu({
  anchorRef,
  value,
  options,
  onPick,
  onDismiss,
  minWidth = 168,
  maxHeight,
}: {
  anchorRef: React.RefObject<HTMLElement | null>
  value: string
  options: SelectMenuOption[]
  onPick: (value: string) => void
  onDismiss: () => void
  minWidth?: number
  maxHeight?: number
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  useLayoutEffect(() => {
    const el = anchorRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ top: r.bottom + 2, left: r.left })
  }, [anchorRef])

  useEffect(() => {
    const onOutside = (e: Event) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t)) return
      if (anchorRef.current?.contains(t)) return
      onDismiss()
    }
    // 捕获阶段监听，避免 React Flow 画布拦截冒泡导致无法关闭
    document.addEventListener('mousedown', onOutside, true)
    document.addEventListener('pointerdown', onOutside, true)
    window.addEventListener('scroll', onDismiss, true)
    return () => {
      document.removeEventListener('mousedown', onOutside, true)
      document.removeEventListener('pointerdown', onOutside, true)
      window.removeEventListener('scroll', onDismiss, true)
    }
  }, [anchorRef, onDismiss])

  return createPortal(
    <div
      ref={menuRef}
      className={cn(
        'fixed z-[200] bg-white border border-slate-200 rounded-xl py-1 shadow-lg',
        maxHeight ? 'overflow-y-auto' : '',
      )}
      style={{ top: pos.top, left: pos.left, minWidth, maxHeight }}
    >
      {options.map((opt) => {
        const selected = opt.value === value
        return (
          <button
            key={opt.value || '__empty__'}
            type="button"
            className={cn(
              'w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-slate-50',
              selected && 'bg-indigo-50',
            )}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(opt.value)}
          >
            {opt.icon && (
              <i className={cn('fas text-[10px] w-3.5 text-center shrink-0', opt.icon, opt.iconClass)} />
            )}
            <span
              className={cn(
                'text-[13px] font-medium text-slate-700 truncate',
                opt.mono && 'font-mono text-[13px]',
              )}
            >
              {opt.label}
            </span>
          </button>
        )
      })}
    </div>,
    document.body,
  )
}

function TriggerTypeBadge({ triggerType, className }: { triggerType: string; className?: string }) {
  const meta = TRIGGER_META[triggerType] ?? TRIGGER_META.manual
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[5px] text-[12px] font-semibold',
        TRIGGER_BADGE_CLASS[meta.color],
        className,
      )}
    >
      <i className={cn('fas text-[10px]', meta.icon, TRIGGER_ICON_CLASS[meta.color])} />
      {meta.label}
    </span>
  )
}

function FieldSelectAnchor({
  editing,
  value,
  options,
  onPick,
  onDismiss,
  children,
  minWidth,
  maxHeight,
}: {
  editing: boolean
  value: string
  options: SelectMenuOption[]
  onPick: (value: string) => void
  onDismiss: () => void
  children: React.ReactNode
  minWidth?: number
  maxHeight?: number
}) {
  const anchorRef = useRef<HTMLDivElement>(null)
  return (
    // min-w-0：作为字段 flex-col 的子项，默认 overflow:visible 会让 min-width:auto
    // 撑到内容 min-content（如超长数据库 host），挤占相邻列。归零后内部 truncate 才生效。
    <div ref={anchorRef} className="min-w-0">
      {children}
      {editing && (
        <InlineSelectMenu
          anchorRef={anchorRef}
          value={value}
          options={options}
          onPick={onPick}
          onDismiss={onDismiss}
          minWidth={minWidth}
          maxHeight={maxHeight}
        />
      )}
    </div>
  )
}

const MENU_FIELD_KEYS = new Set(['department', 'category', 'database_id', 'trigger_type'])
const TEXT_FIELD_KEYS = new Set(['name', 'slug', 'description', 'timeout_ms', 'trigger_config'])

function focusFieldControl(el: HTMLInputElement | null) {
  if (!el) return
  el.focus()
  el.select()
}

function InlineField({
  fieldKey,
  label,
  fieldClassName,
  editing,
  dirty,
  editValue,
  onStartEdit,
  children,
  readOnly,
}: {
  fieldKey: string
  label: string
  fieldClassName?: string
  editing: boolean
  dirty: boolean
  editValue: string
  onStartEdit: (key: string, value: string) => void
  children: React.ReactNode
  readOnly?: boolean
}) {
  return (
    <div
      className={`relative flex flex-col justify-center shrink-0 min-w-0 px-[13px] border-r border-[#f0f1f3] h-full transition-colors ${
        fieldClassName ?? ''
      } ${
        readOnly ? 'cursor-default hover:bg-transparent' : 'cursor-text hover:bg-[#f3f5f8]'
      } ${editing ? 'bg-white shadow-[inset_0_0_0_1.5px_#a5b4fc] z-[2]' : ''}`}
      onMouseDown={(e) => {
        if (readOnly || editing) return
        e.preventDefault()
        onStartEdit(fieldKey, editValue)
      }}
    >
      <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-[#b0bac5] mb-0.5 whitespace-nowrap pointer-events-none">
        {label}
      </span>
      {children}
      {dirty && (
        <span className="absolute top-1.5 right-1.5 w-[5px] h-[5px] rounded-full bg-amber-500" />
      )}
    </div>
  )
}

export default function WorkflowEditorHeader({
  editingName,
  isEnabled,
  formMeta,
  setFormMeta,
  editorDepartments,
  editorCategories,
  databaseOptions,
  triggerTypes,
  endpointPath,
  saveNote,
  setSaveNote,
  onBack,
  onSave,
  onShowHelp,
  onShowDebug,
  onShowVersions,
  onExport,
  onShare,
  onShowRuns,
  onDepartmentChange,
  onToggleEnabled,
  workflowDependencies,
  onWorkflowDependenciesChange,
  depsStatus,
  pyDepsStatus,
}: Props) {
  const [editingField, setEditingField] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [dirtyFields, setDirtyFields] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState('')
  const [alertOpen, setAlertOpen] = useState(false)
  const [npmDepsOpen, setNpmDepsOpen] = useState(false)
  const [npmDepsText, setNpmDepsText] = useState('')
  const [npmDepsError, setNpmDepsError] = useState<string | null>(null)
  const [pipDepsOpen, setPipDepsOpen] = useState(false)
  const [pipDepsText, setPipDepsText] = useState('')
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const editBaseline = useRef('')
  const editingFieldRef = useRef<string | null>(null)
  // 旧 session 草稿可能缺少告警字段；分享深链打开时也要能安全渲染
  const alertConfigured = !!(formMeta.alert_webhook_url ?? '').trim()
  const jsDepsObject = extractJsDependencies(workflowDependencies)
  const npmDepsConfigured = Object.keys(jsDepsObject).length > 0
  const pyRequirements = extractPyRequirements(workflowDependencies)
  const pipDepsConfigured = pyRequirements.length > 0

  const title = formMeta.name || editingName || '新建工作流'
  const selectedDb = databaseOptions.find((d) => String(d.database_id) === formMeta.database_id)

  const markDirty = useCallback((key: string) => {
    setDirtyFields((prev) => new Set(prev).add(key))
    setToast('已修改，记得保存')
  }, [])

  useEffect(() => {
    const obj = extractJsDependencies(workflowDependencies)
    setNpmDepsText(Object.keys(obj).length > 0 ? JSON.stringify(obj, null, 2) : '')
    setNpmDepsError(null)
  }, [workflowDependencies])

  useEffect(() => {
    const reqs = extractPyRequirements(workflowDependencies)
    setPipDepsText(reqs.join('\n'))
  }, [workflowDependencies])

  const commitPipDepsText = useCallback(
    (raw: string) => {
      const requirements = raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      onWorkflowDependenciesChange(
        requirements.length > 0
          ? mergePyDependencies(workflowDependencies, requirements)
          : removePyDependencies(workflowDependencies),
      )
      markDirty('dependencies')
    },
    [markDirty, onWorkflowDependenciesChange, workflowDependencies],
  )

  const commitNpmDepsText = useCallback(
    (raw: string) => {
      const text = raw.trim()
      if (!text) {
        onWorkflowDependenciesChange(removeJsDependencies(workflowDependencies))
        setNpmDepsError(null)
        markDirty('dependencies')
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        setNpmDepsError('不是合法 JSON')
        return
      }
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
        setNpmDepsError('必须是 JSON 对象，如 { "axios": "^1.7.0" }')
        return
      }
      setNpmDepsError(null)
      onWorkflowDependenciesChange(
        mergeJsDependencies(workflowDependencies, formMeta.slug, parsed as Record<string, string>),
      )
      markDirty('dependencies')
    },
    [formMeta.slug, markDirty, onWorkflowDependenciesChange, workflowDependencies],
  )

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 2200)
  }, [])

  const applyFieldValue = useCallback((key: string, raw: string) => {
    switch (key) {
      case 'name':
        setFormMeta((f) => ({ ...f, name: raw }))
        break
      case 'slug':
        setFormMeta((f) => ({ ...f, slug: raw }))
        break
      case 'description':
        setFormMeta((f) => ({ ...f, description: raw }))
        break
      case 'timeout_ms': {
        const v = parseInt(raw, 10) || 30000
        setFormMeta((f) => ({ ...f, timeout_ms: v }))
        break
      }
      case 'trigger_config':
        setFormMeta((f) => ({ ...f, trigger_config: raw }))
        break
    }
  }, [setFormMeta])

  const normalizeFieldValue = useCallback((key: string, raw: string) => {
    if (key === 'timeout_ms') return String(parseInt(raw, 10) || 30000)
    return raw
  }, [])

  const commitFieldValue = useCallback(
    (key: string, next: string, baseline: string) => {
      const normalized = normalizeFieldValue(key, next)
      const base = normalizeFieldValue(key, baseline)
      if (normalized !== base) {
        applyFieldValue(key, normalized)
        markDirty(key)
      }
    },
    [applyFieldValue, markDirty, normalizeFieldValue],
  )

  const startEdit = useCallback(
    (key: string, value: string) => {
      const prev = editingFieldRef.current
      if (prev && prev !== key && TEXT_FIELD_KEYS.has(prev)) {
        const el = inputRefs.current[prev]
        commitFieldValue(prev, el?.value ?? '', editBaseline.current)
      }
      editBaseline.current = value
      setEditDraft(value)
      editingFieldRef.current = key
      flushSync(() => {
        setEditingField(key)
      })
      if (!MENU_FIELD_KEYS.has(key)) {
        focusFieldControl(inputRefs.current[key])
      }
    },
    [commitFieldValue],
  )

  const stopEdit = useCallback(() => {
    editingFieldRef.current = null
    setEditingField(null)
  }, [])

  const pickMenuValue = useCallback(
    (key: string, value: string, apply: (v: string) => void) => {
      apply(value)
      if (value !== editBaseline.current) markDirty(key)
      stopEdit()
    },
    [markDirty, stopEdit],
  )

  const commitDraft = useCallback(
    (key: string, next: string) => {
      if (editingFieldRef.current !== key) return
      commitFieldValue(key, next, editBaseline.current)
      stopEdit()
    },
    [commitFieldValue, stopEdit],
  )

  const handleSave = () => {
    setDirtyFields(new Set())
    onSave()
  }

  const copyEndpoint = async () => {
    if (!endpointPath) return
    const ok = await copyTextToClipboard(endpointPath)
    showToast(ok ? '端点已复制 ✓' : '复制失败，请手动选择复制')
  }

  const isEditing = (key: string) => editingField === key
  const isDirty = (key: string) => dirtyFields.has(key)

  // 定时触发：对用户只暴露 cron 表达式本身，内部仍以 {"schedule": "..."} 存入 trigger_config。
  const cronSchedule = (() => {
    try {
      const o = JSON.parse(formMeta.trigger_config || '{}')
      return o && typeof o.schedule === 'string' ? o.schedule : ''
    } catch {
      return ''
    }
  })()

  const setCronSchedule = (v: string) => {
    // 不 trim 存储值，保留字段间空格以便正常输入多段 cron；仅用是否全空白决定清空。
    const next = v.trim() ? JSON.stringify({ schedule: v }) : '{}'
    setFormMeta((f) => ({ ...f, trigger_config: next }))
    markDirty('trigger_config')
  }

  // 即时校验 cron（与后端 validate_cron 一致，后端保存时再把一次关）。返回错误文案或 null。
  const cronError: string | null = (() => {
    const expr = cronSchedule.trim()
    if (!expr) return null
    const parts = expr.split(/\s+/)
    if (parts.length !== 5) return '需 5 个字段（分 时 日 月 周）'
    const specs: Array<[number, number, boolean]> = [
      [0, 59, false],
      [0, 23, false],
      [1, 31, false],
      [1, 12, false],
      [0, 6, true],
    ]
    const names = ['分', '时', '日', '月', '周']

    const parseNum = (x: string, min: number, max: number, isWd: boolean): number | null => {
      if (!/^\d+$/.test(x)) return null
      let n = Number(x)
      if (isWd && n === 7) n = 0
      return n >= min && n <= max ? n : null
    }
    const validToken = (token: string, min: number, max: number, isWd: boolean): boolean => {
      let range = token
      if (token.includes('/')) {
        const [r, s] = token.split('/')
        const step = Number(s)
        if (!Number.isInteger(step) || step <= 0) return false
        range = r
      }
      if (range === '*') return true
      if (range.includes('-')) {
        const [a, b] = range.split('-')
        const na = parseNum(a, min, max, isWd)
        const nb = parseNum(b, min, max, isWd)
        return na !== null && nb !== null && na <= nb
      }
      return parseNum(range, min, max, isWd) !== null
    }
    for (let i = 0; i < 5; i++) {
      const [min, max, isWd] = specs[i]
      const tokens = parts[i].split(',').map((t: string) => t.trim())
      if (
        tokens.some((t: string) => t === '') ||
        !tokens.every((t: string) => validToken(t, min, max, isWd))
      ) {
        return `${names[i]}字段非法`
      }
    }
    return null
  })()

  useEffect(() => {
    if (!editingField || !MENU_FIELD_KEYS.has(editingField)) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stopEdit()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [editingField, stopEdit])

  return (
    <div className="bg-white border-b border-slate-200 shrink-0 relative max-h-[60%] overflow-y-auto">
      {/* 顶栏 */}
      <div className="sticky top-0 z-20 bg-white flex items-center gap-2.5 px-4 h-[50px] min-h-[50px]">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 px-2 py-1.5 rounded-[7px] text-[13px] text-slate-500 hover:bg-slate-100 shrink-0"
        >
          <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          返回
        </button>
        <div className="w-px h-[18px] bg-slate-200 shrink-0" />
        <span className="text-sm font-semibold text-slate-800 truncate shrink-0">{title}</span>
        {isEnabled != null && (
          onToggleEnabled ? (
            <button
              type="button"
              onClick={onToggleEnabled}
              title={isEnabled ? '点击禁用：禁用后所有触发方式（端点 / 数据变更 / 定时 / 手动）都将无法执行' : '点击启用：启用后可被触发执行'}
              className={`group inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold shrink-0 transition-colors ${
                isEnabled
                  ? 'bg-emerald-50 border border-emerald-200 text-emerald-600 hover:bg-emerald-100'
                  : 'bg-slate-100 border border-slate-200 text-slate-500 hover:bg-slate-200'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${isEnabled ? 'bg-emerald-500' : 'bg-slate-400'}`} />
              {isEnabled ? '已启用' : '已禁用'}
              <span className="text-[10px] font-medium opacity-50 group-hover:opacity-80">
                {isEnabled ? '· 点击禁用' : '· 点击启用'}
              </span>
            </button>
          ) : (
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold shrink-0 ${
                isEnabled
                  ? 'bg-emerald-50 border border-emerald-200 text-emerald-600'
                  : 'bg-slate-100 border border-slate-200 text-slate-500'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${isEnabled ? 'bg-emerald-500' : 'bg-slate-400'}`} />
              {isEnabled ? '已启用' : '已禁用'}
            </span>
          )
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={onShowHelp}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[7px] text-xs font-medium text-slate-500 hover:bg-slate-50 shrink-0"
        >
          接口文档
        </button>
        <button
          type="button"
          onClick={onShowDebug}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[7px] text-xs font-medium border border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100 shrink-0"
        >
          调试
        </button>
        {onShowRuns && (
          <button
            type="button"
            onClick={onShowRuns}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[7px] text-xs font-medium border border-slate-200 text-slate-600 bg-white hover:bg-slate-50 shrink-0"
          >
            <i className="fas fa-clock-rotate-left text-[10px] text-slate-400" />
            执行日志
          </button>
        )}
        {onShowVersions && (
          <button
            type="button"
            onClick={onShowVersions}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[7px] text-xs font-medium border border-slate-200 text-slate-600 bg-white hover:bg-slate-50 shrink-0"
          >
            版本历史
          </button>
        )}
        {onShare && (
          <button
            type="button"
            onClick={onShare}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[7px] text-xs font-medium border border-slate-200 text-slate-600 bg-white hover:bg-slate-50 shrink-0"
          >
            <i className="fas fa-link text-[10px] text-slate-400" />
            复制编辑链接
          </button>
        )}
        {onExport && (
          <button
            type="button"
            onClick={onExport}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[7px] text-xs font-medium border border-slate-200 text-slate-600 bg-white hover:bg-slate-50 shrink-0"
          >
            <i className="fas fa-download text-[10px] text-slate-400" />
            导出
          </button>
        )}
        <input
          value={saveNote}
          onChange={(e) => setSaveNote(e.target.value)}
          placeholder="保存备注（可选）"
          className="w-28 shrink-0 px-2 py-1.5 border border-slate-200 rounded-[7px] text-xs text-slate-600 outline-none focus:border-indigo-300"
        />
        <button
          type="button"
          onClick={handleSave}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-[7px] text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-700 shadow-[0_1px_4px_rgba(79,70,229,0.3)] shrink-0"
        >
          保存
        </button>
      </div>

      {/* 信息栏：两行内联编辑 */}
      <div className="bg-[#fafbfc] border-t border-[#f0f1f3]">
        {/* Row 1：身份 + 触发 + 端点 */}
        <div className="flex items-stretch h-[50px] border-b border-[#f0f1f3] overflow-x-auto">
          <InlineField
            fieldKey="name"
            label="名称"
            fieldClassName="flex-[1.4] min-w-[130px]"
            editValue={formMeta.name}
            editing={isEditing('name')}
            dirty={isDirty('name')}
            onStartEdit={startEdit}
          >
            {isEditing('name') ? (
              <input
                ref={(el) => { inputRefs.current.name = el }}
                className="w-full text-[14px] font-medium text-slate-800 border-none outline-none bg-transparent p-0"
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                onBlur={(e) => commitDraft('name', e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') { setEditDraft(editBaseline.current); stopEdit() }
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="text-[14px] font-medium text-slate-700 truncate leading-tight">
                {formMeta.name || <span className="text-slate-400 italic font-normal">未命名</span>}
              </span>
            )}
          </InlineField>

          <InlineField
            fieldKey="slug"
            label="Slug"
            fieldClassName="flex-[1.8] min-w-[150px]"
            editValue={formMeta.slug}
            editing={isEditing('slug')}
            dirty={isDirty('slug')}
            onStartEdit={startEdit}
          >
            {isEditing('slug') ? (
              <input
                ref={(el) => { inputRefs.current.slug = el }}
                className="w-full text-[13px] font-medium font-mono text-slate-800 border-none outline-none bg-transparent p-0"
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                onBlur={(e) => commitDraft('slug', e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') { setEditDraft(editBaseline.current); stopEdit() }
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="text-[13px] font-medium font-mono text-slate-700 truncate leading-tight">
                {formMeta.slug || <span className="text-slate-400 italic font-sans font-normal">my-api</span>}
              </span>
            )}
          </InlineField>

          <InlineField
            fieldKey="department"
            label="服务"
            fieldClassName="w-[118px]"
            editValue={formMeta.department}
            editing={isEditing('department')}
            dirty={isDirty('department')}
            onStartEdit={startEdit}
          >
            <FieldSelectAnchor
              editing={isEditing('department')}
              value={formMeta.department}
              options={editorDepartments.map((d) => ({ value: d, label: d }))}
              onPick={(v) => pickMenuValue('department', v, onDepartmentChange)}
              onDismiss={stopEdit}
            >
              <span className="block text-[14px] font-medium text-slate-700 truncate leading-tight">
                {formMeta.department}
              </span>
            </FieldSelectAnchor>
          </InlineField>

          <InlineField
            fieldKey="category"
            label="分类"
            fieldClassName="w-[108px]"
            editValue={formMeta.category}
            editing={isEditing('category')}
            dirty={isDirty('category')}
            onStartEdit={startEdit}
          >
            <FieldSelectAnchor
              editing={isEditing('category')}
              value={formMeta.category}
              options={editorCategories.map((c) => ({ value: c, label: c }))}
              onPick={(v) => pickMenuValue('category', v, (val) => setFormMeta((f) => ({ ...f, category: val })))}
              onDismiss={stopEdit}
            >
              <span className="block text-[14px] font-medium text-slate-700 truncate leading-tight">
                {formMeta.category}
              </span>
            </FieldSelectAnchor>
          </InlineField>

          <InlineField
            fieldKey="trigger_type"
            label="触发方式"
            fieldClassName="w-[138px]"
            editValue={formMeta.trigger_type}
            editing={isEditing('trigger_type')}
            dirty={isDirty('trigger_type')}
            onStartEdit={startEdit}
          >
            <FieldSelectAnchor
              editing={isEditing('trigger_type')}
              value={formMeta.trigger_type}
              options={triggerTypes.map((t) => {
                const meta = TRIGGER_META[t.value] ?? TRIGGER_META.manual
                return {
                  value: t.value,
                  label: meta.label,
                  icon: meta.icon,
                  iconClass: TRIGGER_ICON_CLASS[meta.color],
                }
              })}
              onPick={(v) => pickMenuValue('trigger_type', v, (val) => setFormMeta((f) => ({
                ...f,
                trigger_type: val,
                trigger_config: val === 'kafka'
                  ? JSON.stringify(DEFAULT_KAFKA_TRIGGER_CONFIG, null, 2)
                  : f.trigger_config,
              })))}
              onDismiss={stopEdit}
            >
              <TriggerTypeBadge triggerType={formMeta.trigger_type} />
            </FieldSelectAnchor>
          </InlineField>

          {formMeta.trigger_type === 'cron' && (
            <div className="relative flex flex-col justify-center shrink-0 min-w-[220px] flex-[2] px-[13px] border-r-0 h-full">
              <span
                className={`text-[11px] font-bold uppercase tracking-[0.06em] mb-0.5 whitespace-nowrap pointer-events-none ${
                  cronError ? 'text-red-500' : 'text-[#b0bac5]'
                }`}
              >
                {cronError ? `Cron 非法：${cronError}` : '定时（Cron · 北京时间）'}
              </span>
              <input
                className={`w-full text-[13px] font-medium font-mono border-none outline-none bg-transparent p-0 placeholder:text-slate-400 placeholder:font-sans placeholder:font-normal placeholder:italic ${
                  cronError ? 'text-red-600' : 'text-slate-800'
                }`}
                value={cronSchedule}
                placeholder="分 时 日 月 周（北京时间），如 */5 * * * *"
                title={cronError ?? undefined}
                onChange={(e) => setCronSchedule(e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
              />
              {!cronError && isDirty('trigger_config') && (
                <span className="absolute top-1.5 right-1.5 w-[5px] h-[5px] rounded-full bg-amber-500" />
              )}
            </div>
          )}

          {endpointPath && (
            <InlineField
              fieldKey="endpoint"
              label="端点"
              fieldClassName="flex-[2] min-w-[200px] border-r-0"
              editValue=""
              editing={false}
              dirty={false}
              onStartEdit={() => {}}
              readOnly
            >
              <button
                type="button"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={copyEndpoint}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[5px] text-[12px] font-mono bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors max-w-full truncate"
                title="点击复制"
              >
                <span className="text-[10px] font-extrabold tracking-wide opacity-70 shrink-0">POST</span>
                <span className="truncate">{endpointPath.replace(/^POST\s+/, '')}</span>
                <svg className="w-2.5 h-2.5 opacity-45 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            </InlineField>
          )}
        </div>

        {/* Row 2：备注 + 数据库 + 超时 + 触发配置 */}
        <div className="flex items-stretch h-[50px] overflow-x-auto">
          <InlineField
            fieldKey="description"
            label="备注"
            fieldClassName="flex-[2] min-w-[180px]"
            editValue={formMeta.description}
            editing={isEditing('description')}
            dirty={isDirty('description')}
            onStartEdit={startEdit}
          >
            {isEditing('description') ? (
              <input
                ref={(el) => { inputRefs.current.description = el }}
                className="w-full text-[14px] font-medium text-slate-800 border-none outline-none bg-transparent p-0"
                value={editDraft}
                placeholder="用途说明（可选）"
                onChange={(e) => setEditDraft(e.target.value)}
                onBlur={(e) => commitDraft('description', e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') { setEditDraft(editBaseline.current); stopEdit() }
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="text-[14px] font-medium text-slate-700 truncate leading-tight">
                {formMeta.description || <span className="text-slate-400 italic font-normal">用途说明（可选）</span>}
              </span>
            )}
          </InlineField>

          {databaseOptions.length > 0 && (
            <InlineField
              fieldKey="database_id"
              label="数据库"
              fieldClassName="flex-[1.6] min-w-[200px]"
              editValue={formMeta.database_id}
              editing={isEditing('database_id')}
              dirty={isDirty('database_id')}
              onStartEdit={startEdit}
            >
              <FieldSelectAnchor
                editing={isEditing('database_id')}
                value={formMeta.database_id}
                minWidth={280}
                maxHeight={240}
                options={[
                  { value: '', label: '请选择数据库' },
                  ...databaseOptions.map((c) => ({
                    value: String(c.database_id),
                    label: dbLabel(c),
                    mono: true,
                  })),
                ]}
                onPick={(v) => pickMenuValue('database_id', v, (val) => setFormMeta((f) => ({ ...f, database_id: val })))}
                onDismiss={stopEdit}
              >
                <span className="block text-[13px] font-medium font-mono text-slate-700 truncate leading-tight">
                  {selectedDb ? dbLabel(selectedDb) : <span className="text-slate-400 italic font-sans font-normal">未选择</span>}
                </span>
              </FieldSelectAnchor>
            </InlineField>
          )}

          <InlineField
            fieldKey="timeout_ms"
            label="超时时间"
            fieldClassName="w-[108px]"
            editValue={String(formMeta.timeout_ms)}
            editing={isEditing('timeout_ms')}
            dirty={isDirty('timeout_ms')}
            onStartEdit={startEdit}
          >
            {isEditing('timeout_ms') ? (
              <input
                ref={(el) => { inputRefs.current.timeout_ms = el }}
                type="number"
                className="w-full text-[14px] font-medium text-slate-800 border-none outline-none bg-transparent p-0"
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                onBlur={(e) => commitDraft('timeout_ms', e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') { setEditDraft(editBaseline.current); stopEdit() }
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="text-[14px] font-medium text-slate-700 leading-tight inline-flex items-baseline gap-1">
                {formMeta.timeout_ms.toLocaleString()}
                <span className="text-[11px] text-slate-400">ms</span>
              </span>
            )}
          </InlineField>

          {formMeta.trigger_type === 'hook' && (
            <InlineField
              fieldKey="trigger_config"
              label="Hook"
              fieldClassName="flex-[1.8] min-w-[200px] border-r-0"
              editValue={formMeta.trigger_config}
              editing={isEditing('trigger_config')}
              dirty={isDirty('trigger_config')}
              onStartEdit={startEdit}
            >
              {isEditing('trigger_config') ? (
                <input
                  ref={(el) => { inputRefs.current.trigger_config = el }}
                  className="w-full text-[13px] font-medium font-mono text-slate-800 border-none outline-none bg-transparent p-0"
                  value={editDraft}
                  placeholder='{"table":"posts"}'
                  onChange={(e) => setEditDraft(e.target.value)}
                  onBlur={(e) => commitDraft('trigger_config', e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    if (e.key === 'Escape') { setEditDraft(editBaseline.current); stopEdit() }
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="text-[13px] font-medium font-mono text-slate-700 truncate leading-tight">
                  {formMeta.trigger_config || <span className="text-slate-400 italic font-sans font-normal">{'{"table":"..."}'}</span>}
                </span>
              )}
            </InlineField>
          )}

          {formMeta.trigger_type === 'notify' && (
            <InlineField
              fieldKey="trigger_config"
              label="NOTIFY"
              fieldClassName="flex-[1.8] min-w-[200px] border-r-0"
              editValue={formMeta.trigger_config}
              editing={isEditing('trigger_config')}
              dirty={isDirty('trigger_config')}
              onStartEdit={startEdit}
            >
              {isEditing('trigger_config') ? (
                <input
                  ref={(el) => { inputRefs.current.trigger_config = el }}
                  className="w-full text-[13px] font-medium font-mono text-slate-800 border-none outline-none bg-transparent p-0"
                  value={editDraft}
                  placeholder='{"channel":"..."}'
                  onChange={(e) => setEditDraft(e.target.value)}
                  onBlur={(e) => commitDraft('trigger_config', e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    if (e.key === 'Escape') { setEditDraft(editBaseline.current); stopEdit() }
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="text-[13px] font-medium font-mono text-slate-700 truncate leading-tight">
                  {formMeta.trigger_config || <span className="text-slate-400 italic font-sans font-normal">{'{"channel":"..."}'}</span>}
                </span>
              )}
            </InlineField>
          )}

        </div>

        {/* Row 3：JavaScript npm 依赖（默认折叠） */}
        <div className="border-t border-[#f0f1f3]">
          <button
            type="button"
            onClick={() => setNpmDepsOpen((v) => !v)}
            className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-[#f3f5f8] transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              <i
                className={cn(
                  'fas fa-chevron-right text-[10px] text-slate-400 transition-transform',
                  npmDepsOpen && 'rotate-90',
                )}
              />
              <span className="text-[12px] font-bold uppercase tracking-[0.06em] text-[#b0bac5]">
                依赖 (npm)
              </span>
              {depsStatus && (
                <span
                  className={cn(
                    'inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium border',
                    depsStatusBadgeClass(depsStatus.status),
                  )}
                  title={depsStatus.error || undefined}
                >
                  {depsStatusLabel(depsStatus.status)}
                </span>
              )}
              {npmDepsConfigured && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-violet-50 text-violet-700">
                  {Object.keys(jsDepsObject).length} 个包
                </span>
              )}
              {!npmDepsConfigured && !depsStatus && (
                <span className="text-[12px] text-slate-400 font-normal normal-case tracking-normal">
                  点击展开设置
                </span>
              )}
            </div>
          </button>
          {npmDepsOpen && (
            <div className="px-4 pb-3 space-y-2">
              <div className="text-[12px] text-slate-500">
                为 JavaScript 代码节点声明 npm 依赖；保存后后端自动安装。仅编辑 dependencies 对象即可。
              </div>
              <label className="block">
                <span className="block text-[11px] font-semibold text-slate-500 mb-1">
                  package.json dependencies
                </span>
                <textarea
                  value={npmDepsText}
                  onChange={(e) => setNpmDepsText(e.target.value)}
                  onBlur={(e) => commitNpmDepsText(e.target.value)}
                  className={cn(
                    'w-full rounded-md border px-2 py-1.5 text-[12px] font-mono outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100',
                    npmDepsError ? 'border-red-300 bg-red-50/30' : 'border-slate-200',
                  )}
                  rows={4}
                  placeholder={'{\n  "axios": "^1.7.0"\n}'}
                  spellCheck={false}
                />
              </label>
              {npmDepsError && <p className="text-[11px] text-red-600">{npmDepsError}</p>}
              {depsStatus?.status === 'failed' && depsStatus.error && (
                <p className="text-[11px] text-red-600">安装失败：{depsStatus.error}</p>
              )}
              {depsStatus?.status === 'installing' && (
                <p className="text-[11px] text-blue-600">依赖正在安装，请稍后刷新查看状态。</p>
              )}
            </div>
          )}
        </div>

        {/* Row 3b：Python pip 依赖（默认折叠） */}
        <div className="border-t border-[#f0f1f3]">
          <button
            type="button"
            onClick={() => setPipDepsOpen((v) => !v)}
            className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-[#f3f5f8] transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              <i
                className={cn(
                  'fas fa-chevron-right text-[10px] text-slate-400 transition-transform',
                  pipDepsOpen && 'rotate-90',
                )}
              />
              <span className="text-[12px] font-bold uppercase tracking-[0.06em] text-[#b0bac5]">
                依赖 (pip)
              </span>
              {pyDepsStatus && (
                <span
                  className={cn(
                    'inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium border',
                    depsStatusBadgeClass(pyDepsStatus.status),
                  )}
                  title={pyDepsStatus.error || undefined}
                >
                  {depsStatusLabel(pyDepsStatus.status)}
                </span>
              )}
              {pipDepsConfigured && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-violet-50 text-violet-700">
                  {pyRequirements.length} 个包
                </span>
              )}
              {!pipDepsConfigured && !pyDepsStatus && (
                <span className="text-[12px] text-slate-400 font-normal normal-case tracking-normal">
                  点击展开设置
                </span>
              )}
            </div>
          </button>
          {pipDepsOpen && (
            <div className="px-4 pb-3 space-y-2">
              <div className="text-[12px] text-slate-500">
                为 Python 代码节点声明 pip 依赖；保存后后端自动安装。每行一个 requirement。
              </div>
              <label className="block">
                <span className="block text-[11px] font-semibold text-slate-500 mb-1">
                  requirements.txt
                </span>
                <textarea
                  value={pipDepsText}
                  onChange={(e) => setPipDepsText(e.target.value)}
                  onBlur={(e) => commitPipDepsText(e.target.value)}
                  className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-[12px] font-mono outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                  rows={4}
                  placeholder={'requests==2.31.0\nnumpy>=1.24'}
                  spellCheck={false}
                />
              </label>
              {pyDepsStatus?.status === 'failed' && pyDepsStatus.error && (
                <p className="text-[11px] text-red-600">安装失败：{pyDepsStatus.error}</p>
              )}
              {pyDepsStatus?.status === 'installing' && (
                <p className="text-[11px] text-blue-600">依赖正在安装，请稍后刷新查看状态。</p>
              )}
            </div>
          )}
        </div>

        {/* Row 4：失败告警 Webhook（默认折叠） */}
        <div className="border-t border-[#f0f1f3]">
          <button
            type="button"
            onClick={() => setAlertOpen((v) => !v)}
            className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-[#f3f5f8] transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              <i
                className={cn(
                  'fas fa-chevron-right text-[10px] text-slate-400 transition-transform',
                  alertOpen && 'rotate-90',
                )}
              />
              <span className="text-[12px] font-bold uppercase tracking-[0.06em] text-[#b0bac5]">
                失败告警 Webhook
              </span>
              {alertConfigured ? (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-emerald-50 text-emerald-700">
                  已配置
                </span>
              ) : (
                <span className="text-[12px] text-slate-400 font-normal normal-case tracking-normal">
                  点击展开设置
                </span>
              )}
            </div>
            {formMeta.last_alert_sent_at && (
              <div className="text-[12px] text-slate-500 whitespace-nowrap shrink-0">
                上次发送：{new Date(formMeta.last_alert_sent_at).toLocaleString()}
              </div>
            )}
          </button>
          {alertOpen && (
            <div className="px-4 pb-3 space-y-2">
              <div className="text-[12px] text-slate-500">
                仅最终失败后发送；同一工作流按限流小时数最多发送一次。URL 留空即关闭告警。
              </div>
              <div className="grid grid-cols-[minmax(220px,1fr)_120px] gap-3">
                <label className="min-w-0">
                  <span className="block text-[11px] font-semibold text-slate-500 mb-1">Webhook URL</span>
                  <input
                    type="url"
                    value={formMeta.alert_webhook_url ?? ''}
                    onChange={(e) => {
                      setFormMeta((f) => ({ ...f, alert_webhook_url: e.target.value }))
                      markDirty('alert_webhook_url')
                    }}
                    className="w-full h-8 rounded-md border border-slate-200 px-2 text-[12px] font-mono outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                    placeholder="https://example.com/webhook"
                  />
                </label>
                <label>
                  <span className="block text-[11px] font-semibold text-slate-500 mb-1">限流小时</span>
                  <input
                    type="number"
                    min={0}
                    max={720}
                    value={formMeta.alert_throttle_hours}
                    onChange={(e) => {
                      setFormMeta((f) => ({
                        ...f,
                        alert_throttle_hours: parseInt(e.target.value || '24', 10),
                      }))
                      markDirty('alert_throttle_hours')
                    }}
                    className="w-full h-8 rounded-md border border-slate-200 px-2 text-[12px] outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                  />
                </label>
              </div>
              <label className="block">
                <span className="block text-[11px] font-semibold text-slate-500 mb-1">
                  消息模板（JSON object）
                </span>
                  <textarea
                  value={formMeta.alert_webhook_template ?? ''}
                  onChange={(e) => {
                    setFormMeta((f) => ({ ...f, alert_webhook_template: e.target.value }))
                    markDirty('alert_webhook_template')
                  }}
                  className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-[12px] font-mono outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                  rows={4}
                />
                <span className="block mt-1 text-[11px] text-slate-400">
                  变量：{'{{source}} {{name}} {{status}} {{error}} {{time}} {{run_id}} {{object_id}} {{trigger_type}} {{trace_id}}'}
                </span>
              </label>
            </div>
          )}
        </div>

        {formMeta.trigger_type === 'kafka' && (
          <KafkaTriggerConfig
            value={formMeta.trigger_config}
            onChange={(triggerConfig) => {
              setFormMeta((f) => ({ ...f, trigger_config: triggerConfig }))
              markDirty('trigger_config')
            }}
          />
        )}
      </div>

      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[100] bg-slate-800 text-slate-50 px-4 py-1.5 rounded-lg text-xs font-medium shadow-lg whitespace-nowrap pointer-events-none">
          {toast}
        </div>
      )}
    </div>
  )
}
