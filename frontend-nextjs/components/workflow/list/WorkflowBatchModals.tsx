'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { downloadWorkflowJsonBatch } from './exportUtils'
import { batchDeleteWorkflows, batchSetWorkflowEnabled } from './batchApi'
import { showToast } from '@/components/Toast'
import type { WorkflowListItem } from './types'
import type { BatchModalType } from './WorkflowBatchBar'

interface WorkflowBatchModalsProps {
  modal: BatchModalType
  workflows: WorkflowListItem[]
  onClose: () => void
  onComplete: () => void
}

function ModalOverlay({
  open,
  onClose,
  children,
  widthClass = 'w-[440px]',
}: {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  widthClass?: string
}) {
  if (!open) return null
  return (
    <div
      className="workflow-batch-ov open"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className={cn('workflow-batch-box', widthClass)} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

function ModalHead({ title, icon, iconColor, onClose }: { title: string; icon: string; iconColor: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between px-[18px] py-3.5 border-b border-slate-100">
      <div className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
        <i className={cn('fas', icon)} style={{ color: iconColor }} />
        {title}
      </div>
      <button type="button" onClick={onClose} className="workflow-batch-xbtn" aria-label="关闭">
        <i className="fas fa-xmark" />
      </button>
    </div>
  )
}

function BatchExportModal({
  open,
  workflows,
  onClose,
  onComplete,
}: {
  open: boolean
  workflows: WorkflowListItem[]
  onClose: () => void
  onComplete: () => void
}) {
  const [exporting, setExporting] = useState(false)
  const [pct, setPct] = useState(0)
  const [currentFile, setCurrentFile] = useState('准备中…')
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (!open) {
      setExporting(false)
      setPct(0)
      setCurrentFile('准备中…')
      setDone(false)
    }
  }, [open])

  const startExport = async () => {
    setExporting(true)
    setPct(0)
    try {
      await downloadWorkflowJsonBatch(workflows, (index, total, wf) => {
        const progress = Math.round(((index + 1) / total) * 100)
        setPct(progress)
        setCurrentFile(`正在导出：${wf.slug || wf.name}.workflow.json`)
      })
      setPct(100)
      setCurrentFile('导出完成！')
      setDone(true)
      window.setTimeout(() => {
        showToast('success', `已成功导出 ${workflows.length} 个工作流（JSON）`)
        onComplete()
        onClose()
      }, 600)
    } catch {
      showToast('error', '导出失败，请重试')
      setExporting(false)
    }
  }

  return (
    <ModalOverlay open={open} onClose={exporting ? () => {} : onClose}>
      <ModalHead title="批量导出工作流" icon="fa-arrow-down-to-line" iconColor="#4f46e5" onClose={exporting ? () => {} : onClose} />
      <div className="px-[18px] py-4">
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">导出格式</div>
        <div className="workflow-batch-fmt-row mb-4">
          <div className="workflow-batch-fmt-icon bg-[#ffe4c4] text-[#c05621]">
            <i className="fas fa-code" />
          </div>
          <div>
            <div className="text-[12.5px] font-bold text-slate-800">JSON</div>
            <div className="text-[10.5px] text-slate-400 mt-px">可直接再导入 OneBase</div>
          </div>
          <span className="ml-auto text-[10px] text-slate-300 font-medium">
            <i className="fas fa-lock text-[10px]" /> 当前仅支持
          </span>
        </div>
        <div className="workflow-batch-fmt-row mb-0">
          <div className="workflow-batch-fmt-icon bg-indigo-100 text-indigo-600">
            <i className="fas fa-check-square" />
          </div>
          <div>
            <div className="text-[12.5px] font-bold text-slate-800">已选中 {workflows.length} 个工作流</div>
            <div className="text-[10.5px] text-slate-400 mt-px">将导出为独立的 JSON 文件</div>
          </div>
        </div>
        {exporting && (
          <div className="mt-3.5 bg-slate-50 border border-slate-200 rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-semibold text-slate-800 flex items-center gap-1">
                {done ? (
                  <>
                    <i className="fas fa-check text-green-600" />
                    导出成功
                  </>
                ) : (
                  <>
                    <i className="fas fa-spinner fa-spin text-indigo-600" />
                    正在导出…
                  </>
                )}
              </div>
              <span className="text-xs font-bold text-indigo-600">{pct}%</span>
            </div>
            <div className="h-1.5 bg-slate-200 rounded overflow-hidden">
              <div className="h-full bg-gradient-to-r from-indigo-600 to-indigo-400 rounded transition-all duration-300" style={{ width: `${pct}%` }} />
            </div>
            <div className="text-[10.5px] text-slate-400 mt-1.5">{currentFile}</div>
          </div>
        )}
      </div>
      {!exporting && (
        <div className="flex items-center justify-end gap-1.5 px-[18px] py-3 border-t border-slate-100 bg-slate-50/80">
          <button type="button" onClick={onClose} className="workflow-batch-btn-cancel">
            取消
          </button>
          <button type="button" onClick={() => void startExport()} className="workflow-batch-btn-ok bg-indigo-600">
            <i className="fas fa-arrow-down-to-line text-[10px]" />
            开始导出
          </button>
        </div>
      )}
    </ModalOverlay>
  )
}

function BatchStatusModal({
  open,
  workflows,
  onClose,
  onComplete,
}: {
  open: boolean
  workflows: WorkflowListItem[]
  onClose: () => void
  onComplete: () => void
}) {
  const [target, setTarget] = useState<'on' | 'off' | null>(null)
  const [loading, setLoading] = useState(false)

  const mixedStatus = new Set(workflows.map((w) => (w.is_enabled ? 'on' : 'off'))).size > 1

  useEffect(() => {
    if (!open) setTarget(null)
  }, [open])

  const confirm = async () => {
    if (!target) return
    setLoading(true)
    try {
      const result = await batchSetWorkflowEnabled(
        workflows.map((w) => w.id),
        target === 'on',
      )
      const label = target === 'on' ? '启用' : '禁用'
      if (result.failed_count > 0) {
        showToast('warning', `已设为「${label}」${result.succeeded_count} 个，${result.failed_count} 个失败`)
      } else {
        showToast('success', `已将 ${result.succeeded_count} 个工作流设为「${label}」`)
      }
      onComplete()
      onClose()
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      showToast('error', msg || '修改状态失败')
    } finally {
      setLoading(false)
    }
  }

  const statusLabel = { on: '已启用', off: '已禁用' }
  const targetLabel = { on: '→ 启用', off: '→ 禁用' }
  const dotColor = { on: '#22c55e', off: '#cbd5e1' }

  return (
    <ModalOverlay open={open} onClose={loading ? () => {} : onClose}>
      <ModalHead title="批量修改状态" icon="fa-toggle-on" iconColor="#4f46e5" onClose={loading ? () => {} : onClose} />
      <div className="px-[18px] py-4">
        {mixedStatus && (
          <div className="flex items-start gap-1.5 p-2.5 bg-amber-50 border border-amber-200 rounded-lg mb-3 text-[11px] text-amber-800 leading-relaxed">
            <i className="fas fa-triangle-exclamation text-amber-600 text-[11px] shrink-0 mt-px" />
            <span>
              选中的工作流包含<strong>多种状态</strong>，统一修改后将覆盖各自原有状态。
            </span>
          </div>
        )}
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">目标状态</div>
        <div className="mb-4 space-y-1.5">
          {(['on', 'off'] as const).map((val) => (
            <label
              key={val}
              className={cn(
                'flex items-center gap-2.5 px-3 py-2.5 border-2 rounded-[10px] cursor-pointer transition-colors',
                target === val ? 'border-indigo-600 bg-indigo-50/60' : 'border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/30',
              )}
              onClick={() => setTarget(val)}
            >
              <input type="radio" name="batch-status" checked={target === val} onChange={() => setTarget(val)} className="accent-indigo-600 w-3.5 h-3.5" />
              <div
                className={cn(
                  'w-[30px] h-[30px] rounded-lg flex items-center justify-center text-xs shrink-0',
                  val === 'on' ? 'bg-green-50 text-green-600' : 'bg-slate-50 text-slate-400',
                )}
              >
                <i className={cn('fas', val === 'on' ? 'fa-play' : 'fa-pause')} />
              </div>
              <div>
                <div className="text-xs font-semibold text-slate-800">{val === 'on' ? '启用' : '禁用'}</div>
                <div className="text-[10.5px] text-slate-400 mt-px">
                  {val === 'on' ? '激活工作流，下次触发时开始执行' : '停止响应，但保留节点配置'}
                </div>
              </div>
            </label>
          ))}
        </div>
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">将影响以下工作流</div>
        <div className="bg-slate-50 border border-slate-200 rounded-lg max-h-24 overflow-y-auto p-2 flex flex-col gap-1">
          {workflows.map((w) => {
            const st = w.is_enabled ? 'on' : 'off'
            return (
              <div key={w.id} className="flex items-center gap-1.5 text-[11px] text-slate-600 py-0.5">
                <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dotColor[st] }} />
                <span className="font-semibold truncate">{w.name}</span>
                <span className="ml-auto text-[10px] text-slate-400 whitespace-nowrap shrink-0">
                  {statusLabel[st]} {target ? targetLabel[target] : ''}
                </span>
              </div>
            )
          })}
        </div>
      </div>
      <div className="flex items-center justify-end gap-1.5 px-[18px] py-3 border-t border-slate-100 bg-slate-50/80">
        <button type="button" onClick={onClose} disabled={loading} className="workflow-batch-btn-cancel">
          取消
        </button>
        <button
          type="button"
          disabled={!target || loading}
          onClick={() => void confirm()}
          className={cn(
            'workflow-batch-btn-ok',
            target === 'on' ? 'bg-green-600' : target === 'off' ? 'bg-slate-500' : 'bg-indigo-600 opacity-45 cursor-not-allowed',
          )}
        >
          <i className="fas fa-check text-[10px]" />
          {loading ? '处理中…' : '确认修改'}
        </button>
      </div>
    </ModalOverlay>
  )
}

function BatchDeleteModal({
  open,
  workflows,
  onClose,
  onComplete,
}: {
  open: boolean
  workflows: WorkflowListItem[]
  onClose: () => void
  onComplete: () => void
}) {
  const [loading, setLoading] = useState(false)

  const confirm = async () => {
    setLoading(true)
    try {
      const result = await batchDeleteWorkflows(workflows.map((w) => w.id))
      if (result.failed_count > 0) {
        showToast('warning', `已删除 ${result.succeeded_count} 个，${result.failed_count} 个失败`)
      } else {
        showToast('success', `已删除 ${result.succeeded_count} 个工作流`)
      }
      onComplete()
      onClose()
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      showToast('error', msg || '删除失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <ModalOverlay open={open} onClose={loading ? () => {} : onClose} widthClass="w-[420px]">
      <ModalHead title="确认删除工作流" icon="fa-trash" iconColor="#dc2626" onClose={loading ? () => {} : onClose} />
      <div className="px-[18px] py-4">
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-3">
          <div className="text-[11.5px] text-red-900 font-semibold mb-1.5 flex items-center gap-1.5">
            <i className="fas fa-triangle-exclamation text-red-600" />
            此操作不可撤销，将永久删除以下工作流
          </div>
          {workflows.map((w) => (
            <div key={w.id} className="flex items-center gap-1 text-[11px] text-red-800 py-0.5">
              <i className="fas fa-minus-circle text-[9px] text-red-600 shrink-0" />
              {w.name}
            </div>
          ))}
        </div>
        <div className="text-xs text-slate-500 leading-relaxed bg-slate-50 border border-slate-200 rounded-lg p-2.5">
          <div className="font-semibold text-slate-600 mb-1">删除前请注意</div>
          <div>• 运行中的工作流将被强制终止</div>
          <div>• 执行记录将一并清除</div>
          <div>• 被其他工作流引用的节点可能产生错误</div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-1.5 px-[18px] py-3 border-t border-slate-100 bg-slate-50/80">
        <button type="button" onClick={onClose} disabled={loading} className="workflow-batch-btn-cancel">
          取消
        </button>
        <button type="button" disabled={loading} onClick={() => void confirm()} className="workflow-batch-btn-ok bg-red-600">
          <i className="fas fa-trash text-[10px]" />
          {loading ? '删除中…' : '确认删除'}
        </button>
      </div>
    </ModalOverlay>
  )
}

export default function WorkflowBatchModals({ modal, workflows, onClose, onComplete }: WorkflowBatchModalsProps) {
  return (
    <>
      <BatchExportModal open={modal === 'export'} workflows={workflows} onClose={onClose} onComplete={onComplete} />
      <BatchStatusModal open={modal === 'status'} workflows={workflows} onClose={onClose} onComplete={onComplete} />
      <BatchDeleteModal open={modal === 'delete'} workflows={workflows} onClose={onClose} onComplete={onComplete} />
    </>
  )
}
