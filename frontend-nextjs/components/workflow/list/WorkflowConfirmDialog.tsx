'use client'

import { cn } from '@/lib/utils'

export interface WorkflowConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'default' | 'danger'
  loading?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function WorkflowConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  variant = 'default',
  loading = false,
  onConfirm,
  onCancel,
}: WorkflowConfirmDialogProps) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={loading ? undefined : onCancel}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative bg-white rounded-xl shadow-xl w-full max-w-sm p-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-confirm-title"
      >
        <div className="flex items-start gap-3 mb-4">
          <div
            className={cn(
              'w-9 h-9 rounded-full flex items-center justify-center shrink-0',
              variant === 'danger' ? 'bg-red-50 text-red-500' : 'bg-indigo-50 text-indigo-500',
            )}
          >
            <i className={cn('fas text-sm', variant === 'danger' ? 'fa-trash' : 'fa-folder-tree')} />
          </div>
          <div className="min-w-0 pt-0.5">
            <h3 id="workflow-confirm-title" className="font-semibold text-slate-800">
              {title}
            </h3>
            <p className="text-sm text-slate-500 mt-1 leading-relaxed whitespace-pre-line">{message}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={cn(
              'px-4 py-2 text-sm rounded-lg font-medium disabled:opacity-50 min-w-[4.5rem]',
              variant === 'danger'
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'bg-indigo-600 text-white hover:bg-indigo-700',
            )}
          >
            {loading ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
