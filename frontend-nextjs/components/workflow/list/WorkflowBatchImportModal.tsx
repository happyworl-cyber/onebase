'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { showToast } from '@/components/Toast'
import { TRIGGER_META } from './constants'
import { parseImportedWorkflowFile } from './exportUtils'
import { fetchExistingWorkflows } from './listApi'
import { importWorkflows, type ImportItem, type ImportResult, type ImportWorkflowDef } from './importApi'
import type { WorkflowListItem } from './types'

type ParseStatus = 'ok' | 'conflict' | 'error'
type ConflictAction = 'overwrite' | 'rename' | 'skip'

interface ExistingMeta {
  id: number
  description: string | null
  triggerType: string
  nodeCount: number
  updatedAt: string
  isEnabled: boolean
}

interface ParsedFile {
  key: string
  filename: string
  status: ParseStatus
  error?: string
  name: string
  slug: string
  description: string | null
  triggerType: string
  nodeCount: number
  def?: ImportWorkflowDef
  existing?: ExistingMeta
}

interface Resolution {
  action: ConflictAction | null
  newSlug: string
}

interface Props {
  databaseId?: number | null
  onClose: () => void
  onDone: () => void
}

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

function triggerLabel(type: string): string {
  const meta = TRIGGER_META[type] ?? TRIGGER_META.manual
  return meta.label
}

function buildDef(file: ParsedFile): ImportWorkflowDef {
  return {
    name: file.name,
    slug: file.slug,
    description: file.description,
    department: file.def?.department ?? '',
    category: file.def?.category ?? '',
    trigger_type: file.triggerType,
    trigger_config: file.def?.trigger_config ?? {},
    nodes: file.def?.nodes ?? [],
    edges: file.def?.edges ?? [],
    dependencies: file.def?.dependencies ?? null,
    timeout_ms: file.def?.timeout_ms ?? 30000,
    max_retries: file.def?.max_retries ?? 0,
    alert_webhook_url:
      typeof file.def?.alert_webhook_url === 'string' ? file.def.alert_webhook_url : null,
    alert_webhook_template:
      file.def?.alert_webhook_template &&
      typeof file.def.alert_webhook_template === 'object' &&
      !Array.isArray(file.def.alert_webhook_template)
        ? (file.def.alert_webhook_template as Record<string, unknown>)
        : null,
    alert_throttle_hours:
      typeof file.def?.alert_throttle_hours === 'number' ? file.def.alert_throttle_hours : 24,
  }
}

export default function WorkflowBatchImportModal({ databaseId, onClose, onDone }: Props) {
  const [step, setStep] = useState<'select' | 'review' | 'progress' | 'done'>('select')
  const [parsing, setParsing] = useState(false)
  const [files, setFiles] = useState<ParsedFile[]>([])
  const [res, setRes] = useState<Record<string, Resolution>>({})
  const [existingSlugs, setExistingSlugs] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [])

  const conflicts = useMemo(() => files.filter((f) => f.status === 'conflict'), [files])

  const handlePick = () => fileInputRef.current?.click()

  const handleFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return
      // 必须在任何 await 之前快照：onChange 里会同步把 input.value 置空，
      // 那会清空这个 FileList，await 之后再读就成 0 个文件了。
      const arr = Array.from(fileList)
      setParsing(true)
      try {
        const existing = await fetchExistingWorkflows(databaseId)
        const existingMap = new Map<string, ExistingMeta>()
        const slugSet = new Set<string>()
        for (const w of existing as WorkflowListItem[]) {
          slugSet.add(w.slug)
          existingMap.set(w.slug, {
            id: w.id,
            description: w.description,
            triggerType: w.trigger_type,
            nodeCount: Array.isArray(w.nodes) ? w.nodes.length : 0,
            updatedAt: w.updated_at,
            isEnabled: w.is_enabled,
          })
        }
        setExistingSlugs(slugSet)

        const parsed: ParsedFile[] = []
        const nextRes: Record<string, Resolution> = {}
        for (let i = 0; i < arr.length; i++) {
          const file = arr[i]
          const key = `${file.name}-${i}`
          try {
            const text = await file.text()
            const json = JSON.parse(text)
            const { workflow, department, category } = parseImportedWorkflowFile(json)
            const slug = typeof workflow.slug === 'string' ? workflow.slug : ''
            const name =
              typeof workflow.name === 'string' && workflow.name ? workflow.name : '未命名工作流'
            const triggerType =
              typeof workflow.trigger_type === 'string' ? workflow.trigger_type : 'endpoint'
            const description =
              typeof workflow.description === 'string' ? workflow.description : null
            const nodeCount = Array.isArray(workflow.nodes) ? workflow.nodes.length : 0
            if (!slug) {
              parsed.push({
                key,
                filename: file.name,
                status: 'error',
                error: '文件缺少 slug',
                name,
                slug: '',
                description,
                triggerType,
                nodeCount,
              })
              continue
            }
            const def: ImportWorkflowDef = {
              name,
              slug,
              description,
              department,
              category,
              trigger_type: triggerType,
              trigger_config:
                workflow.trigger_config && typeof workflow.trigger_config === 'object'
                  ? (workflow.trigger_config as Record<string, unknown>)
                  : {},
              nodes: Array.isArray(workflow.nodes) ? workflow.nodes : [],
              edges: Array.isArray(workflow.edges) ? workflow.edges : [],
              dependencies:
                workflow.dependencies &&
                typeof workflow.dependencies === 'object' &&
                !Array.isArray(workflow.dependencies)
                  ? (workflow.dependencies as Record<string, unknown>)
                  : null,
              timeout_ms: typeof workflow.timeout_ms === 'number' ? workflow.timeout_ms : 30000,
              max_retries: typeof workflow.max_retries === 'number' ? workflow.max_retries : 0,
              alert_webhook_url:
                typeof workflow.alert_webhook_url === 'string' ? workflow.alert_webhook_url : null,
              alert_webhook_template:
                workflow.alert_webhook_template &&
                typeof workflow.alert_webhook_template === 'object' &&
                !Array.isArray(workflow.alert_webhook_template)
                  ? (workflow.alert_webhook_template as Record<string, unknown>)
                  : null,
              alert_throttle_hours:
                typeof workflow.alert_throttle_hours === 'number'
                  ? workflow.alert_throttle_hours
                  : 24,
            }
            const ex = existingMap.get(slug)
            const status: ParseStatus = ex ? 'conflict' : 'ok'
            if (status === 'conflict') {
              nextRes[slug] = { action: null, newSlug: `${slug}-copy` }
            }
            parsed.push({
              key,
              filename: file.name,
              status,
              name,
              slug,
              description,
              triggerType,
              nodeCount,
              def,
              existing: ex,
            })
          } catch (err) {
            parsed.push({
              key,
              filename: file.name,
              status: 'error',
              error: err instanceof Error ? err.message : '文件解析失败',
              name: file.name,
              slug: '',
              description: null,
              triggerType: 'endpoint',
              nodeCount: 0,
            })
          }
        }
        setFiles(parsed)
        setRes(nextRes)
        setStep('review')
      } catch {
        showToast('error', '读取已有工作流失败，请重试')
      } finally {
        setParsing(false)
      }
    },
    [databaseId],
  )

  const checkNewSlug = useCallback(
    (originalSlug: string, newSlug: string): { valid: boolean; msg: string } => {
      const v = (newSlug || '').trim()
      if (!v) return { valid: false, msg: 'Slug 不能为空' }
      if (!SLUG_RE.test(v))
        return { valid: false, msg: '只能用小写字母、数字、连字符，且首尾不能是连字符' }
      if (existingSlugs.has(v)) return { valid: false, msg: '该 Slug 在系统中已存在，请换一个' }
      // 与批次中其他文件原始 slug 冲突
      const batchSlugs = files.filter((f) => f.slug && f.slug !== originalSlug).map((f) => f.slug)
      if (batchSlugs.includes(v)) return { valid: false, msg: '与批次中另一个文件的 Slug 重复' }
      // 与其他重命名目标冲突
      const otherRenames = files
        .filter(
          (f) => f.status === 'conflict' && f.slug !== originalSlug && res[f.slug]?.action === 'rename',
        )
        .map((f) => res[f.slug]?.newSlug)
        .filter(Boolean)
      if (otherRenames.includes(v)) return { valid: false, msg: '与另一条重命名的目标 Slug 重复' }
      return { valid: true, msg: '' }
    },
    [existingSlugs, files, res],
  )

  const setAction = (slug: string, action: ConflictAction) => {
    setRes((prev) => ({ ...prev, [slug]: { action, newSlug: prev[slug]?.newSlug || `${slug}-copy` } }))
  }
  const updateSlug = (slug: string, val: string) => {
    setRes((prev) => ({ ...prev, [slug]: { action: prev[slug]?.action ?? 'rename', newSlug: val } }))
  }
  const autoSlug = (slug: string) => {
    setRes((prev) => ({
      ...prev,
      [slug]: { action: 'rename', newSlug: `${slug}-${Date.now().toString().slice(-5)}` },
    }))
  }
  const bulkAction = (action: ConflictAction) => {
    setRes((prev) => {
      const next = { ...prev }
      for (const f of conflicts) next[f.slug] = { action, newSlug: prev[f.slug]?.newSlug || `${f.slug}-copy` }
      return next
    })
  }
  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const stats = useMemo(() => {
    const ok = files.filter((f) => f.status === 'ok').length
    const con = files.filter((f) => f.status === 'conflict').length
    const err = files.filter((f) => f.status === 'error').length
    return { total: files.length, ok, con, err }
  }, [files])

  const unresolvedCount = conflicts.filter((f) => !res[f.slug]?.action).length
  const invalidRenameCount = conflicts.filter(
    (f) => res[f.slug]?.action === 'rename' && !checkNewSlug(f.slug, res[f.slug]?.newSlug ?? '').valid,
  ).length
  const willImportCount = files.filter((f) => {
    if (f.status === 'error') return false
    if (f.status === 'conflict') {
      const a = res[f.slug]?.action
      return a && a !== 'skip'
    }
    return true
  }).length

  const buildItems = (): ImportItem[] => {
    const items: ImportItem[] = []
    for (const f of files) {
      if (f.status === 'error' || !f.def) continue
      if (f.status === 'ok') {
        items.push({ action: 'create', slug: f.slug, workflow: buildDef(f) })
        continue
      }
      const r = res[f.slug]
      if (!r?.action || r.action === 'skip') continue
      if (r.action === 'overwrite') {
        items.push({ action: 'overwrite', slug: f.slug, workflow: buildDef(f) })
      } else {
        items.push({ action: 'rename', slug: r.newSlug.trim(), workflow: buildDef(f) })
      }
    }
    return items
  }

  const doImport = async () => {
    const items = buildItems()
    if (items.length === 0) return
    setStep('progress')
    setImporting(true)
    try {
      const r = await importWorkflows(databaseId, items)
      setResult(r)
      setStep('done')
      const warnCount = r.succeeded.reduce((n, s) => n + (s.warnings?.length ?? 0), 0)
      if (r.failed_count > 0) {
        showToast('warning', `导入完成：成功 ${r.succeeded_count}，失败 ${r.failed_count}`)
      } else if (warnCount > 0) {
        showToast('warning', `已导入 ${r.succeeded_count} 个工作流，有 ${warnCount} 条提示（如新增节点的连接需手动选择），详见结果页`)
      } else {
        // 按 action 分类计数：新建/重命名 = 默认启用；覆盖 = 保留原启用状态。
        const created = r.succeeded.filter((s) => s.action === 'create' || s.action === 'rename').length
        const overwritten = r.succeeded.filter((s) => s.action === 'overwrite').length
        const parts: string[] = []
        if (created) parts.push(`新建 ${created}（已启用）`)
        if (overwritten) parts.push(`覆盖 ${overwritten}（保留原状态）`)
        const detail = parts.length ? `：${parts.join(' · ')}` : ''
        showToast('success', `已导入 ${r.succeeded_count} 个工作流${detail}`)
      }
      onDone()
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      showToast('error', msg || '批量导入失败')
      setStep('review')
    } finally {
      setImporting(false)
    }
  }

  const stepNum = step === 'select' ? 1 : step === 'review' ? 1 : step === 'progress' ? 2 : 3

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !importing) onClose()
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        multiple
        className="hidden"
        onChange={(e) => {
          void handleFiles(e.target.files)
          e.target.value = ''
        }}
      />
      <div className="bg-white w-[740px] max-w-[94vw] max-h-[90vh] flex flex-col rounded-2xl shadow-2xl overflow-hidden">
        {/* 头部 */}
        <div className="px-6 pt-5 pb-0 shrink-0">
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 bg-gradient-to-br from-indigo-500 to-indigo-400">
                <i className="fas fa-layer-group text-white text-sm" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-gray-900">批量导入工作流</h2>
                <p className="text-xs text-gray-400 mt-0.5">
                  {step === 'select' && '选择一个或多个 .workflow.json 文件'}
                  {step === 'review' && `已解析 ${files.length} 个文件，请确认导入计划`}
                  {step === 'progress' && '正在将工作流写入系统…'}
                  {step === 'done' && '全部处理完毕'}
                </p>
              </div>
            </div>
            <button
              onClick={() => !importing && onClose()}
              className="p-1.5 text-gray-300 hover:text-gray-600 hover:bg-gray-100 rounded-xl mt-0.5"
            >
              <i className="fas fa-times text-sm" />
            </button>
          </div>

          {step !== 'select' && (
            <div className="flex items-center pb-4 border-b border-gray-100">
              {[
                { n: 1, t: '选择文件' },
                { n: 2, t: '确认并导入' },
                { n: 3, t: '完成' },
              ].map((s, idx) => (
                <div key={s.n} className="flex items-center flex-1 last:flex-none">
                  <div className="flex flex-col items-center gap-1 shrink-0">
                    <div
                      className={cn(
                        'w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center',
                        stepNum === s.n
                          ? 'bg-indigo-600 text-white'
                          : stepNum > s.n
                            ? 'bg-indigo-100 text-indigo-600'
                            : 'bg-gray-100 text-gray-400',
                      )}
                    >
                      {s.n}
                    </div>
                    <span
                      className={cn(
                        'text-[11px] whitespace-nowrap',
                        stepNum === s.n ? 'font-semibold text-indigo-700' : 'text-gray-400',
                      )}
                    >
                      {s.t}
                    </span>
                  </div>
                  {idx < 2 && (
                    <div
                      className={cn(
                        'h-[1.5px] flex-1 mx-2 mt-[-1rem]',
                        stepNum > s.n ? 'bg-indigo-500' : 'bg-gray-200',
                      )}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto">
          {step === 'select' && (
            <div className="p-6">
              <div
                onClick={handlePick}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  void handleFiles(e.dataTransfer.files)
                }}
                className="border-2 border-dashed border-gray-200 rounded-2xl p-12 flex flex-col items-center gap-4 hover:border-indigo-300 hover:bg-indigo-50/20 transition-all cursor-pointer group"
              >
                <div className="w-14 h-14 rounded-2xl bg-indigo-50 group-hover:bg-indigo-100 flex items-center justify-center transition-colors">
                  {parsing ? (
                    <div className="w-7 h-7 border-2 border-gray-200 border-t-indigo-500 rounded-full animate-spin" />
                  ) : (
                    <i className="fas fa-cloud-upload-alt text-indigo-400 text-2xl" />
                  )}
                </div>
                <div className="text-center">
                  <p className="text-sm font-medium text-gray-700">
                    {parsing ? '正在解析文件…' : '拖拽文件到此处，或'}
                    {!parsing && <span className="text-indigo-600"> 点击选择</span>}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    支持多选 · 仅限 <code className="bg-gray-100 px-1.5 py-0.5 rounded font-mono">.workflow.json</code> 格式
                  </p>
                </div>
              </div>
              <div className="mt-4 flex items-start gap-2.5 text-xs text-gray-500 bg-blue-50/40 rounded-xl px-4 py-3.5 border border-blue-100/60">
                <i className="fas fa-info-circle text-blue-400 mt-0.5 shrink-0" />
                批量导入会直接写入系统：新建/重命名默认为启用状态，覆盖保留原启用状态及数据源/Redis 连接配置（不会被导入文件里的环境连接覆盖）。请确认文件来源可信。
              </div>
            </div>
          )}

          {step === 'review' && (
            <div>
              <div className="grid grid-cols-4 gap-3 px-6 py-4 bg-gray-50/50 border-b border-gray-100">
                {[
                  { n: stats.total, l: '全部文件', c: '#6366f1', i: 'fa-file-alt' },
                  { n: stats.ok, l: '可直接导入', c: '#10b981', i: 'fa-check-circle' },
                  { n: stats.con, l: 'Slug 冲突', c: '#f59e0b', i: 'fa-exclamation-circle' },
                  { n: stats.err, l: '格式错误', c: '#ef4444', i: 'fa-times-circle' },
                ].map((s) => (
                  <div key={s.l} className="bg-white rounded-xl border border-gray-100 px-4 py-3 flex items-center gap-3 shadow-sm">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${s.c}1a` }}>
                      <i className={cn('fas', s.i, 'text-sm')} style={{ color: s.c }} />
                    </div>
                    <div>
                      <div className="text-xl font-bold text-gray-800">{s.n}</div>
                      <div className="text-[11px] text-gray-400">{s.l}</div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="px-6 pt-5 pb-6">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">解析结果</span>
                  {stats.con > 0 && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-gray-400">冲突快速应用：</span>
                      <button
                        onClick={() => bulkAction('overwrite')}
                        className="text-xs px-2.5 py-1 rounded-lg border border-gray-200 text-gray-600 hover:border-indigo-300 hover:text-indigo-600 hover:bg-indigo-50 font-medium"
                      >
                        全部覆盖
                      </button>
                      <button
                        onClick={() => bulkAction('skip')}
                        className="text-xs px-2.5 py-1 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 font-medium"
                      >
                        全部放弃
                      </button>
                    </div>
                  )}
                </div>
                <div className="space-y-2.5">
                  {files.map((f) => (
                    <FileItem
                      key={f.key}
                      file={f}
                      resolution={res[f.slug]}
                      collapsed={collapsed.has(f.key)}
                      onToggleCollapse={() => toggleCollapse(f.key)}
                      onSetAction={setAction}
                      onUpdateSlug={updateSlug}
                      onAutoSlug={autoSlug}
                      checkNewSlug={checkNewSlug}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          {step === 'progress' && (
            <div className="p-6 flex flex-col items-center justify-center gap-4 py-16">
              <div className="w-12 h-12 border-2 border-gray-200 border-t-indigo-500 rounded-full animate-spin" />
              <p className="text-sm text-gray-500">正在导入 {willImportCount} 个工作流…</p>
            </div>
          )}

          {step === 'done' && result && (
            <div className="flex flex-col items-center py-10 px-8 text-center gap-5">
              <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center">
                <i className="fas fa-check text-emerald-600 text-2xl" />
              </div>
              <div>
                <h3 className="text-xl font-semibold text-gray-900">导入完成</h3>
                <p className="text-sm text-gray-400 mt-1">
                  共处理 {files.length} 个文件，{result.succeeded_count} 个成功写入
                </p>
              </div>
              <div className="grid grid-cols-3 gap-3 w-full max-w-sm">
                <div className="rounded-2xl bg-emerald-50 border border-emerald-100 px-4 py-4 text-center">
                  <div className="text-3xl font-bold text-emerald-700">{result.succeeded_count}</div>
                  <div className="text-xs text-emerald-500 mt-1 font-medium">成功导入</div>
                </div>
                <div className="rounded-2xl bg-gray-50 border border-gray-100 px-4 py-4 text-center">
                  <div className="text-3xl font-bold text-gray-500">{stats.con - result.succeeded.filter((s) => s.action === 'overwrite' || s.action === 'rename').length}</div>
                  <div className="text-xs text-gray-400 mt-1 font-medium">已跳过</div>
                </div>
                <div className="rounded-2xl bg-red-50 border border-red-100 px-4 py-4 text-center">
                  <div className="text-3xl font-bold text-red-500">{stats.err + result.failed_count}</div>
                  <div className="text-xs text-red-400 mt-1 font-medium">未写入</div>
                </div>
              </div>
              {result.succeeded.length > 0 && (
                <div className="w-full text-left bg-gray-50 rounded-2xl border border-gray-100 overflow-hidden divide-y divide-gray-100 max-h-48 overflow-y-auto">
                  <div className="px-4 py-2.5 text-[11px] font-bold text-gray-400 uppercase tracking-wider bg-gray-50">
                    已写入的工作流
                  </div>
                  {result.succeeded.map((s) => (
                    <div key={s.id} className="px-4 py-3">
                      <div className="flex items-center gap-2 text-sm font-medium text-gray-800">
                        {s.name}
                        {s.action === 'overwrite' && (
                          <span className="text-[11px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">覆盖</span>
                        )}
                        {s.action === 'rename' && (
                          <span className="text-[11px] bg-sky-100 text-sky-700 px-1.5 py-0.5 rounded">重命名</span>
                        )}
                      </div>
                      <div className="font-mono text-[11px] text-gray-400 mt-0.5">{s.slug}</div>
                      {s.warnings && s.warnings.length > 0 && (
                        <ul className="mt-2 space-y-1">
                          {s.warnings.map((w, i) => (
                            <li
                              key={i}
                              className="flex items-start gap-1.5 text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2 py-1.5"
                            >
                              <i className="fas fa-exclamation-triangle text-amber-500 mt-0.5 shrink-0" />
                              <span className="leading-relaxed">{w}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {result.failed.length > 0 && (
                <div className="w-full text-left bg-red-50/50 rounded-2xl border border-red-100 overflow-hidden divide-y divide-red-100 max-h-40 overflow-y-auto">
                  <div className="px-4 py-2.5 text-[11px] font-bold text-red-400 uppercase tracking-wider">写入失败</div>
                  {result.failed.map((f, i) => (
                    <div key={i} className="px-4 py-2.5 text-xs text-red-600">
                      <span className="font-medium">{f.name || f.slug}</span>
                      <span className="text-red-400 ml-2">{f.error}</span>
                    </div>
                  ))}
                </div>
              )}
              <button
                onClick={onClose}
                className="mt-2 px-6 py-2.5 bg-gray-900 text-white text-sm font-semibold rounded-xl hover:bg-gray-700"
              >
                完成，返回列表
              </button>
            </div>
          )}
        </div>

        {/* 底部 */}
        {(step === 'select' || step === 'review') && (
          <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between shrink-0 bg-gray-50/40">
            <button onClick={onClose} className="text-sm text-gray-400 hover:text-gray-600 px-3 py-1.5 rounded-lg hover:bg-gray-100">
              取消
            </button>
            {step === 'review' && (
              <div className="flex items-center gap-3">
                {unresolvedCount === 0 && invalidRenameCount === 0 && (
                  <ConflictHint conflicts={conflicts} res={res} />
                )}
                <button
                  disabled={unresolvedCount > 0 || invalidRenameCount > 0 || willImportCount === 0}
                  onClick={() => void doImport()}
                  className={cn(
                    'flex items-center gap-2 px-5 py-2 text-sm font-semibold rounded-xl',
                    unresolvedCount > 0
                      ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                      : invalidRenameCount > 0
                        ? 'bg-red-50 text-red-400 cursor-not-allowed'
                        : willImportCount === 0
                          ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                          : 'bg-indigo-600 text-white hover:bg-indigo-700',
                  )}
                >
                  {unresolvedCount > 0
                    ? `还有 ${unresolvedCount} 个冲突未处理`
                    : invalidRenameCount > 0
                      ? 'Slug 冲突未解决，请修改后再导入'
                      : `导入 ${willImportCount} 个工作流`}
                  {unresolvedCount === 0 && invalidRenameCount === 0 && willImportCount > 0 && (
                    <i className="fas fa-arrow-right text-xs" />
                  )}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function ConflictHint({
  conflicts,
  res,
}: {
  conflicts: ParsedFile[]
  res: Record<string, Resolution>
}) {
  const ov = conflicts.filter((f) => res[f.slug]?.action === 'overwrite').length
  const rn = conflicts.filter((f) => res[f.slug]?.action === 'rename').length
  const sk = conflicts.filter((f) => res[f.slug]?.action === 'skip').length
  const parts: string[] = []
  if (ov) parts.push(`覆盖 ${ov}`)
  if (rn) parts.push(`重命名 ${rn}`)
  if (sk) parts.push(`跳过 ${sk}`)
  if (parts.length === 0) return null
  return <span className="text-xs text-gray-400">{parts.join(' · ')}</span>
}

function FileItem({
  file,
  resolution,
  collapsed,
  onToggleCollapse,
  onSetAction,
  onUpdateSlug,
  onAutoSlug,
  checkNewSlug,
}: {
  file: ParsedFile
  resolution?: Resolution
  collapsed: boolean
  onToggleCollapse: () => void
  onSetAction: (slug: string, action: ConflictAction) => void
  onUpdateSlug: (slug: string, val: string) => void
  onAutoSlug: (slug: string) => void
  checkNewSlug: (originalSlug: string, newSlug: string) => { valid: boolean; msg: string }
}) {
  if (file.status === 'error') {
    return (
      <div className="rounded-2xl border-[1.5px] border-red-200 bg-red-50/40 overflow-hidden">
        <div className="flex items-start gap-3 px-4 py-3.5">
          <div className="w-8 h-8 rounded-lg bg-red-100 flex items-center justify-center shrink-0">
            <i className="fas fa-times text-red-500 text-xs" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-red-700 truncate">{file.filename}</span>
              <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full font-medium shrink-0">格式错误</span>
            </div>
            <div className="text-xs text-red-400 mt-1 font-mono">{file.error}</div>
          </div>
        </div>
      </div>
    )
  }

  if (file.status === 'ok') {
    return (
      <div className="rounded-2xl border-[1.5px] border-emerald-100 bg-emerald-50/40 overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3.5">
          <div className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center shrink-0">
            <i className="fas fa-file-code text-emerald-500 text-xs" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-gray-800 truncate">{file.name}</span>
              <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-medium shrink-0">
                ✓ 正常
              </span>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="font-mono text-xs text-gray-400">{file.slug}</span>
              <span className="text-gray-300">·</span>
              <span className="text-xs text-gray-400">
                {triggerLabel(file.triggerType)} · {file.nodeCount} 节点
              </span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // conflict
  const r = resolution ?? { action: null, newSlug: `${file.slug}-copy` }
  const ex = file.existing
  const resolved = !!r.action
  const diffs = ex
    ? [
        { label: '描述', old: ex.description || '—', nw: file.description || '—' },
        { label: '触发', old: triggerLabel(ex.triggerType), nw: triggerLabel(file.triggerType) },
        { label: '节点', old: `${ex.nodeCount} 个`, nw: `${file.nodeCount} 个` },
      ]
    : []
  const renameCheck = r.action === 'rename' ? checkNewSlug(file.slug, r.newSlug) : { valid: true, msg: '' }

  const actions: { a: ConflictAction; icon: string; iconColor: string; bg: string; title: string; sub: string }[] = [
    { a: 'overwrite', icon: 'fa-redo', iconColor: 'text-indigo-500', bg: 'bg-indigo-50', title: '覆盖', sub: '替换为导入版本，保留 ID 及数据源/Redis 连接' },
    { a: 'rename', icon: 'fa-pen', iconColor: 'text-sky-500', bg: 'bg-sky-50', title: '重命名', sub: '另存为新工作流，用新 slug' },
    { a: 'skip', icon: 'fa-ban', iconColor: 'text-gray-400', bg: 'bg-gray-50', title: '放弃', sub: '跳过，不做任何操作' },
  ]

  const resolvedTag =
    r.action === 'overwrite' ? (
      <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-medium">覆盖</span>
    ) : r.action === 'rename' ? (
      <span className="text-xs bg-sky-100 text-sky-700 px-2 py-0.5 rounded-full font-medium">重命名</span>
    ) : r.action === 'skip' ? (
      <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full font-medium">放弃</span>
    ) : null

  return (
    <div
      className={cn(
        'rounded-2xl border-[1.5px] overflow-hidden',
        resolved ? 'border-indigo-200 bg-white' : 'border-amber-200 bg-white',
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3.5">
        <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
          <i className="fas fa-exclamation text-amber-500 text-xs" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center flex-wrap gap-x-2 gap-y-1">
            <span className="text-sm font-medium text-gray-800">{file.name}</span>
            <span className="font-mono text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">{file.slug}</span>
            {!resolved && <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />}
            {resolvedTag}
          </div>
          <div className="text-xs text-gray-400 mt-0.5">
            {triggerLabel(file.triggerType)} · {file.nodeCount} 节点
          </div>
        </div>
        <button
          onClick={onToggleCollapse}
          className="shrink-0 flex items-center gap-1 text-xs text-gray-400 hover:text-indigo-600 px-2 py-1 rounded-lg hover:bg-indigo-50"
        >
          <i className={cn('fas text-xs', collapsed ? 'fa-chevron-down' : 'fa-chevron-up')} />
          <span>{collapsed ? '展开' : '收起'}</span>
        </button>
      </div>

      {!collapsed && (
        <div className="border-t border-amber-100/80">
          {ex && (
            <div className="border-b border-amber-100/60">
              <div className="grid bg-gray-50 border-b border-gray-100" style={{ gridTemplateColumns: '3.5rem 1fr 1fr' }}>
                <div className="px-2.5 py-1.5" />
                <div className="px-2.5 py-1.5 border-r border-gray-100 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-gray-400" />
                  <span className="text-[11px] font-semibold text-gray-400 uppercase">现有版本</span>
                </div>
                <div className="px-2.5 py-1.5 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-indigo-500" />
                  <span className="text-[11px] font-semibold text-gray-400 uppercase">导入版本</span>
                </div>
              </div>
              {diffs.map((d) => {
                const ch = d.old !== d.nw
                return (
                  <div key={d.label} className="grid border-b border-gray-50 last:border-0" style={{ gridTemplateColumns: '3.5rem 1fr 1fr' }}>
                    <div className="px-2.5 py-1.5 text-[11px] text-gray-500 font-medium flex items-center">{d.label}</div>
                    <div className={cn('px-2.5 py-1.5 text-xs border-r border-gray-100', ch ? 'bg-amber-50 text-amber-800 line-through opacity-75' : 'text-gray-600')}>
                      {d.old}
                    </div>
                    <div className={cn('px-2.5 py-1.5 text-xs', ch ? 'bg-green-50 text-green-800 font-medium' : 'text-gray-600')}>
                      {d.nw}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <div className="px-4 py-4">
            <p className="text-[11px] font-semibold text-gray-400 mb-3">选择处理方式</p>
            <div className="flex gap-2">
              {actions.map((act) => (
                <div
                  key={act.a}
                  onClick={() => onSetAction(file.slug, act.a)}
                  className={cn(
                    'flex-1 border-[1.5px] rounded-xl px-2 py-2.5 cursor-pointer text-center transition-all',
                    r.action === act.a
                      ? act.a === 'overwrite'
                        ? 'border-indigo-500 bg-indigo-50'
                        : act.a === 'rename'
                          ? 'border-sky-500 bg-sky-50'
                          : 'border-slate-400 bg-slate-50'
                      : 'border-gray-200 hover:border-indigo-300 hover:bg-violet-50/40',
                  )}
                >
                  <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center mb-2 mx-auto', act.bg)}>
                    <i className={cn('fas text-xs', act.icon, act.iconColor)} />
                  </div>
                  <div className="text-xs font-semibold text-gray-700">{act.title}</div>
                  <div className="text-[11px] text-gray-400 leading-relaxed mt-0.5">{act.sub}</div>
                </div>
              ))}
            </div>

            {r.action === 'rename' && (
              <div className="mt-3">
                <label className="block text-[11px] text-gray-400 font-medium mb-1.5">新 Slug（需全局唯一）</label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={r.newSlug}
                    onChange={(e) => onUpdateSlug(file.slug, e.target.value)}
                    placeholder="new-workflow-slug"
                    className={cn(
                      'flex-1 border-[1.5px] rounded-xl px-3 py-1.5 font-mono text-[13px] outline-none',
                      renameCheck.valid
                        ? 'border-green-300 focus:border-green-400'
                        : 'border-red-300 focus:border-red-400',
                    )}
                  />
                  <button
                    onClick={() => onAutoSlug(file.slug)}
                    className="shrink-0 text-xs text-gray-400 hover:text-gray-600 px-3 py-2 border border-gray-200 rounded-xl hover:border-gray-300"
                  >
                    自动
                  </button>
                </div>
                {!renameCheck.valid && (
                  <p className="mt-1.5 text-xs text-red-500 flex items-center gap-1">
                    <i className="fas fa-exclamation-circle text-xs" /> {renameCheck.msg}
                  </p>
                )}
                <p className="mt-1 text-[11px] text-gray-400">重命名后将创建一条新工作流，原工作流不受影响</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
