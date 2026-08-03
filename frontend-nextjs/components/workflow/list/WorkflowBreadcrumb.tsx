'use client'

import { cn } from '@/lib/utils'
import { getFolderPath } from './utils'
import { type WorkflowFolder } from './types'

interface WorkflowBreadcrumbProps {
  folders: WorkflowFolder[]
  folderId: string
  globalSearch: boolean
  search: string
  onSelectFolder: (folderId: string) => void
}

export default function WorkflowBreadcrumb({
  folders,
  folderId,
  globalSearch,
  search,
  onSelectFolder,
}: WorkflowBreadcrumbProps) {
  if (globalSearch) {
    return (
      <div className="flex items-center gap-1.5 text-sm min-w-0">
        <i className="fas fa-globe text-indigo-500 text-[11px]" />
        <span className="font-semibold text-slate-800">全局搜索</span>
        <span className="text-xs text-slate-400">（全部文件夹）</span>
        {search.trim() && <span className="text-xs text-slate-400 ml-1">— &quot;{search}&quot;</span>}
      </div>
    )
  }

  const path = getFolderPath(folders, folderId)

  return (
    <div className="flex items-center gap-1.5 text-sm min-w-0 flex-wrap">
      {path.map((f, i) => {
        const isLast = i === path.length - 1
        return (
          <span key={f.id} className="flex items-center gap-1.5">
            {i > 0 && <i className="fas fa-chevron-right text-slate-300 text-[9px]" />}
            {isLast ? (
              <span className="flex items-center gap-1.5">
                <i className={cn(`fas ${f.icon} ${f.color} text-[11px]`)} />
                <span className="font-semibold text-slate-900">{f.name}</span>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onSelectFolder(f.id)}
                className="text-slate-400 hover:text-slate-600 text-sm"
              >
                {f.name}
              </button>
            )}
          </span>
        )
      })}
    </div>
  )
}
