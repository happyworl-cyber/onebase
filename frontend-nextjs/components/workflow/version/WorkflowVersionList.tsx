'use client'

import { formatDateTime } from '@/lib/utils'
import type { WorkflowVersionListItem } from './types'

export default function WorkflowVersionList({
  versions,
  selectedVersion,
  loading,
  error,
  onRetry,
  onSelect,
}: {
  versions: WorkflowVersionListItem[]
  selectedVersion: number | null
  loading: boolean
  error: string | null
  onRetry: () => void
  onSelect: (version: number) => void
}) {
  const latest = versions.reduce((max, v) => Math.max(max, v.version), 0)

  return (
    <aside className="w-72 shrink-0 border-r border-slate-200 bg-white flex flex-col min-h-0">
      <div className="px-4 py-3 border-b text-sm font-medium text-slate-700">版本</div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {loading ? (
          <div className="text-center py-10 text-slate-400 text-sm">加载中…</div>
        ) : error ? (
          <div className="text-sm text-red-600 space-y-2">
            <p>{error}</p>
            <button type="button" onClick={onRetry} className="text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-50">
              重试
            </button>
          </div>
        ) : versions.length === 0 ? (
          <div className="text-center py-10 text-slate-400 text-sm">暂无版本记录</div>
        ) : (
          versions.map((v) => {
            const selected = selectedVersion === v.version
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => { if (!selected) onSelect(v.version) }}
                className={`w-full text-left border rounded-lg p-3 text-sm ${
                  selected ? 'border-indigo-300 bg-indigo-50' : 'border-slate-200 hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold text-slate-800">v{v.version}</span>
                  {v.version === latest && (
                    <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-xs">最新</span>
                  )}
                  {typeof v.node_count === 'number' && (
                    <span className="text-xs text-slate-400">{v.node_count} 节点</span>
                  )}
                </div>
                {v.note && <div className="mt-1 text-slate-600 line-clamp-2">{v.note}</div>}
                <div className="mt-1 text-xs text-slate-400">
                  {v.created_by_name && <span title={v.created_by_email || undefined}>{v.created_by_name} · </span>}
                  {v.created_at ? formatDateTime(v.created_at) : ''}
                </div>
              </button>
            )
          })
        )}
        {!loading && !error && versions.length === 200 && (
          <p className="text-xs text-slate-400 px-1">仅显示最近 200 个版本</p>
        )}
      </div>
    </aside>
  )
}
