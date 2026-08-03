'use client'

import { cn } from '@/lib/utils'

interface RowIconCheckboxProps {
  selected: boolean
  iconClass: string
  bgClass: string
  onToggle: () => void
  variant?: 'compact' | 'card'
}

export default function RowIconCheckbox({
  selected,
  iconClass,
  bgClass,
  onToggle,
  variant = 'compact',
}: RowIconCheckboxProps) {
  const wrapClass = variant === 'card' ? 'workflow-card-ico-wrap' : 'workflow-row-ico-wrap'

  return (
    <div
      className={cn(
        wrapClass,
        'relative flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center',
        bgClass,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <i className={cn('workflow-row-ico-inner fas text-xs', iconClass, variant === 'card' && 'text-[11px]')} />
      <div className="workflow-row-ico-cb absolute inset-0 flex items-center justify-center rounded-lg">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle()}
          onClick={(e) => e.stopPropagation()}
          className="w-3.5 h-3.5 cursor-pointer rounded accent-indigo-600"
          aria-label={selected ? '取消选择' : '选择工作流'}
        />
      </div>
    </div>
  )
}
