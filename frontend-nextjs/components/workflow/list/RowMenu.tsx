'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

export interface RowMenuProps {
  onRun: () => void
  onShowRuns: () => void
  onDuplicate: () => void
  onShare: () => void
  onOpenVersionHistory?: () => void
  onExport: () => void
  onDelete: () => void
  /** 多入口 focus（P1.3⑤）：在依赖图中查看此工作流，带 focus 参数进图并自动定位。缺省则不渲染该菜单项。 */
  onOpenGraph?: () => void
  size?: 'compact' | 'card'
  onOpenChange?: (open: boolean) => void
}

function MenuItem({
  onClick,
  children,
  destructive,
  close,
}: {
  onClick: () => void
  children: React.ReactNode
  destructive?: boolean
  close: () => void
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        close()
        onClick()
      }}
      className={cn(
        'w-full text-left px-3 py-2 text-sm hover:bg-slate-50 flex items-center gap-2',
        destructive ? 'text-red-600 hover:bg-red-50' : 'text-slate-700',
      )}
    >
      {children}
    </button>
  )
}

export default function RowMenu({
  onRun,
  onShowRuns,
  onDuplicate,
  onShare,
  onOpenVersionHistory,
  onExport,
  onDelete,
  onOpenGraph,
  size = 'compact',
  onOpenChange,
}: RowMenuProps) {
  const [open, setOpen] = useState(false)

  const setMenuOpen = (next: boolean | ((prev: boolean) => boolean)) => {
    setOpen((prev) => {
      const value = typeof next === 'function' ? next(prev) : next
      onOpenChange?.(value)
      return value
    })
  }

  useEffect(() => {
    if (!open) return
    const close = () => setMenuOpen(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [open])

  const triggerClass =
    size === 'card'
      ? 'px-2 py-1.5 text-xs rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:border-slate-300 hover:text-slate-700 leading-none transition-colors'
      : 'w-8 h-8 flex items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:border-slate-300 hover:text-slate-700 text-sm leading-none transition-colors'

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="更多操作"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation()
          setMenuOpen((v) => !v)
        }}
        className={triggerClass}
      >
        ⋯
      </button>
      {open && (
        <div
          className="absolute top-full mt-1 right-0 bg-white border border-slate-200 rounded-xl py-1 z-30 w-40 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <MenuItem onClick={onRun} close={() => setMenuOpen(false)}>
            <i className="fas fa-play text-[10px] w-3.5 text-amber-500" />
            运行
          </MenuItem>
          <MenuItem onClick={onShowRuns} close={() => setMenuOpen(false)}>
            <i className="fas fa-clock-rotate-left text-[10px] w-3.5 text-slate-400" />
            执行记录
          </MenuItem>
          <MenuItem onClick={onDuplicate} close={() => setMenuOpen(false)}>
            <i className="fas fa-copy text-[10px] w-3.5 text-slate-400" />
            复制
          </MenuItem>
          <MenuItem onClick={onShare} close={() => setMenuOpen(false)}>
            <i className="fas fa-link text-[10px] w-3.5 text-slate-400" />
            复制编辑链接
          </MenuItem>
          {onOpenVersionHistory && (
            <MenuItem onClick={onOpenVersionHistory} close={() => setMenuOpen(false)}>
              <i className="fas fa-clock-rotate-left text-[10px] w-3.5 text-slate-400" />
              版本历史
            </MenuItem>
          )}
          <MenuItem onClick={onExport} close={() => setMenuOpen(false)}>
            <i className="fas fa-download text-[10px] w-3.5 text-slate-400" />
            导出
          </MenuItem>
          {onOpenGraph && (
            <MenuItem onClick={onOpenGraph} close={() => setMenuOpen(false)}>
              <i className="fas fa-share-nodes text-[10px] w-3.5 text-slate-400" />
              在依赖图中查看
            </MenuItem>
          )}
          <div className="h-px bg-slate-100 my-1" />
          <MenuItem onClick={onDelete} destructive close={() => setMenuOpen(false)}>
            <i className="fas fa-trash text-[10px] w-3.5" />
            删除
          </MenuItem>
        </div>
      )}
    </div>
  )
}

interface WorkflowRowActionsProps {
  enabled: boolean
  onEdit: () => void
  onToggle: () => void
  onRun: () => void
  onShowRuns: () => void
  onDuplicate: () => void
  onShare: () => void
  onOpenVersionHistory?: () => void
  onExport: () => void
  onDelete: () => void
  onOpenGraph?: () => void
  size?: 'compact' | 'card'
  onMenuOpenChange?: (open: boolean) => void
}

export function WorkflowRowActions({
  enabled,
  onEdit,
  onToggle,
  onRun,
  onShowRuns,
  onDuplicate,
  onShare,
  onOpenVersionHistory,
  onExport,
  onDelete,
  onOpenGraph,
  size = 'compact',
  onMenuOpenChange,
}: WorkflowRowActionsProps) {
  const isCard = size === 'card'
  const base = cn(
    'px-2.5 py-1.5 rounded-lg whitespace-nowrap transition-colors',
    isCard ? 'text-xs border' : 'text-sm',
  )

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <button
        type="button"
        onClick={onEdit}
        className={cn(
          base,
          isCard
            ? 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 hover:border-indigo-300 font-medium'
            : 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-medium',
        )}
      >
        编辑
      </button>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          base,
          enabled
            ? isCard
              ? 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:border-slate-300'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            : isCard
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:border-emerald-300'
              : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100',
        )}
      >
        {enabled ? '禁用' : '启用'}
      </button>
      <RowMenu
        size={size}
        onRun={onRun}
        onShowRuns={onShowRuns}
        onDuplicate={onDuplicate}
        onShare={onShare}
        onOpenVersionHistory={onOpenVersionHistory}
        onExport={onExport}
        onDelete={onDelete}
        onOpenGraph={onOpenGraph}
        onOpenChange={onMenuOpenChange}
      />
    </div>
  )
}
