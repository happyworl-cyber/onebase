'use client'

import { cn } from '@/lib/utils'
import {
  DEFAULT_LIST_PER_PAGE,
  WORKFLOW_LIST_PER_PAGE_OPTIONS,
  type WorkflowListPerPage,
} from './types'

function coercePerPage(value: number): WorkflowListPerPage {
  return WORKFLOW_LIST_PER_PAGE_OPTIONS.includes(value as WorkflowListPerPage)
    ? (value as WorkflowListPerPage)
    : DEFAULT_LIST_PER_PAGE
}

interface WorkflowListPaginationProps {
  page: number
  perPage: number
  total: number
  onPageChange: (page: number) => void
  onPerPageChange: (perPage: WorkflowListPerPage) => void
}

export default function WorkflowListPagination({
  page,
  perPage,
  total,
  onPageChange,
  onPerPageChange,
}: WorkflowListPaginationProps) {
  if (total <= 0) return null

  const pageSize = coercePerPage(perPage)
  const totalPages = Math.ceil(total / pageSize)
  const hasMultiplePages = totalPages > 1
  const start = (page - 1) * pageSize + 1
  const end = Math.min(page * pageSize, total)

  const pages = hasMultiplePages
    ? Array.from(
        new Set([1, totalPages, page, page - 1, page + 1].filter((p) => p >= 1 && p <= totalPages)),
      ).sort((a, b) => a - b)
    : []

  return (
    <div className="shrink-0 border-t border-slate-100 bg-white px-5 py-2 flex items-center justify-between gap-3">
      <span className="text-sm text-slate-400 shrink-0">
        {hasMultiplePages ? `第 ${start}–${end} 条，共 ${total} 条` : `共 ${total} 条`}
      </span>

      {hasMultiplePages ? (
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
            className="w-7 h-7 border border-slate-200 rounded-md flex items-center justify-center text-xs text-slate-500 hover:bg-slate-50 disabled:opacity-35 disabled:cursor-not-allowed"
            aria-label="上一页"
          >
            <i className="fas fa-chevron-left text-[9px]" />
          </button>
          {pages.map((p, idx) => {
            const prev = pages[idx - 1]
            const showEllipsis = prev && p - prev > 1
            return (
              <span key={p} className="flex items-center gap-1">
                {showEllipsis && <span className="text-slate-400 text-xs">…</span>}
                <button
                  type="button"
                  onClick={() => onPageChange(p)}
                  className={cn(
                    'w-7 h-7 border rounded-md flex items-center justify-center text-xs font-medium',
                    page === p
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50',
                  )}
                >
                  {p}
                </button>
              </span>
            )
          })}
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
            className="w-7 h-7 border border-slate-200 rounded-md flex items-center justify-center text-xs text-slate-500 hover:bg-slate-50 disabled:opacity-35 disabled:cursor-not-allowed"
            aria-label="下一页"
          >
            <i className="fas fa-chevron-right text-[9px]" />
          </button>
        </div>
      ) : (
        <span className="flex-1" aria-hidden />
      )}

      <select
        value={pageSize}
        onChange={(e) => onPerPageChange(Number(e.target.value) as WorkflowListPerPage)}
        className="text-sm border border-slate-200 rounded-md px-2 py-1.5 bg-white text-slate-600 shrink-0"
        aria-label="每页条数"
      >
        {WORKFLOW_LIST_PER_PAGE_OPTIONS.map((n) => (
          <option key={n} value={n}>
            {n} 条/页
          </option>
        ))}
      </select>
    </div>
  )
}
