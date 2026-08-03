'use client'

import { cn } from '@/lib/utils'
import { COMPACT_LIST_ACTIONS_CLASS, COMPACT_LIST_HEADER_GRID_CLASS } from './constants'

export default function WorkflowListHeader() {
  return (
    <div
      className={cn(
        COMPACT_LIST_HEADER_GRID_CLASS,
        'py-2.5 border-b border-slate-100 bg-slate-50/80 text-xs font-medium uppercase tracking-wider text-slate-500 sticky top-0 z-10',
      )}
    >
      <span aria-hidden className="w-7" />
      <span>工作流</span>
      <span className="justify-self-start">触发方式</span>
      <span className="hidden sm:block justify-self-start">状态</span>
      <span className="hidden md:block justify-self-start">作者</span>
      <span className="hidden md:block justify-self-start">更新时间</span>
      <span className={cn(COMPACT_LIST_ACTIONS_CLASS, 'text-right')}>操作</span>
    </div>
  )
}
