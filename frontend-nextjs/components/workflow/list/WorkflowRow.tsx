'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import {
  COMPACT_LIST_ACTIONS_CLASS,
  COMPACT_LIST_META_CELL_CLASS,
  COMPACT_LIST_ROW_GRID_CLASS,
  LIST_BODY_TEXT_CLASS,
  LIST_DESCRIPTION_CLAMP_CLASS,
  LIST_DESCRIPTION_TEXT_CLASS,
  LIST_SECONDARY_TEXT_CLASS,
  TRIGGER_BADGE_CLASS,
  TRIGGER_ICON_CLASS,
  TRIGGER_META,
} from './constants'
import TruncatedText from './TruncatedText'
import HighlightText, { searchTerms } from './HighlightText'
import RowIconCheckbox from './RowIconCheckbox'
import { WorkflowRowActions } from './RowMenu'
import { formatRelativeTime, getFolderPath } from './utils'
import type { WorkflowFolder, WorkflowListItem } from './types'

interface WorkflowRowProps {
  workflow: WorkflowListItem
  globalSearch: boolean
  /** 当前搜索关键词，用于结果命中高亮 */
  search?: string
  folders: WorkflowFolder[]
  onEdit: () => void
  onToggle: () => void
  onRun: () => void
  onShowRuns: () => void
  onDuplicate: () => void
  onShare: () => void
  onOpenVersionHistory?: () => void
  onExport: () => void
  onDelete: () => void
  /** 多入口 focus（P1.3⑤）：在依赖图中查看此工作流。缺省则行菜单不出现该项。 */
  onOpenGraph?: () => void
  selected?: boolean
  onSelectToggle?: () => void
}

function TriggerBadge({ triggerType }: { triggerType: string }) {
  const meta = TRIGGER_META[triggerType] ?? TRIGGER_META.manual
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium',
        TRIGGER_BADGE_CLASS[meta.color],
      )}
    >
      <i className={cn('fas text-[10px]', meta.icon)} />
      {meta.label}
    </span>
  )
}

function FolderBadge({ folderId, folders }: { folderId: string; folders: WorkflowFolder[] }) {
  const path = getFolderPath(folders, folderId).filter((f) => f.id !== 'root')
  if (!path.length) return null
  const label = path.map((f) => f.name).join(' / ')
  const leaf = path[path.length - 1]
  return (
    <span className="inline-flex items-center gap-1 text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-md max-w-[200px] min-w-0">
      <i className={cn('fas text-[10px] shrink-0', leaf.icon, leaf.color)} />
      <TruncatedText text={label} className="min-w-0" />
    </span>
  )
}

/** 备注：默认最多 3 行；仅超出时悬浮显示全文 */
function WorkflowDescription({
  text,
  className,
  highlight,
}: {
  text: string
  className?: string
  highlight?: string
}) {
  return (
    <TruncatedText
      as="p"
      text={text}
      highlight={highlight}
      singleLine={false}
      clampClass={LIST_DESCRIPTION_CLAMP_CLASS}
      className={cn(LIST_DESCRIPTION_TEXT_CLASS, 'mt-0.5 pr-1 leading-relaxed break-words', className)}
    />
  )
}

/** 工作流 ID 徽标；当某个搜索 term 精确等于该 ID 时高亮（与后端 w.id 精确匹配语义一致）。 */
function WorkflowIdBadge({ id, search }: { id: number; search?: string }) {
  const hit = searchTerms(search).includes(String(id))
  return (
    <span
      className={cn(
        'text-[11px] font-mono shrink-0 rounded-[2px]',
        hit ? 'bg-amber-200 px-1 text-slate-900 font-semibold' : 'text-slate-400',
      )}
      title={`工作流 ID：${id}`}
    >
      #{id}
    </span>
  )
}

export default function WorkflowRow({
  workflow: w,
  globalSearch,
  search,
  folders,
  folderId,
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
  selected = false,
  onSelectToggle,
}: WorkflowRowProps & { folderId: string }) {
  const meta = TRIGGER_META[w.trigger_type] ?? TRIGGER_META.manual
  const on = w.is_enabled
  const [menuOpen, setMenuOpen] = useState(false)
  const iconBg = on ? TRIGGER_BADGE_CLASS[meta.color].split(' ')[0] : 'bg-slate-100'
  const iconClass = on ? TRIGGER_ICON_CLASS[meta.color] : 'text-slate-400'

  return (
    <div
      className={cn(
        COMPACT_LIST_ROW_GRID_CLASS,
        'group wf-batch-row py-3 border-b border-slate-50 last:border-b-0 hover:bg-slate-50 transition-colors duration-70',
        selected && 'wf-batch-sel',
        menuOpen && 'relative z-30',
      )}
    >
      {onSelectToggle ? (
        <RowIconCheckbox
          selected={selected}
          iconClass={cn(meta.icon, iconClass)}
          bgClass={iconBg}
          onToggle={onSelectToggle}
        />
      ) : (
        <div className={cn(COMPACT_LIST_META_CELL_CLASS, 'w-7 h-7 rounded-lg justify-center shrink-0', iconBg)}>
          <i className={cn('fas text-xs', meta.icon, iconClass)} />
        </div>
      )}

      <div className="min-w-0 cursor-pointer" onClick={onEdit}>
        <div className="flex items-center gap-2 min-w-0">
          <WorkflowIdBadge id={w.id} search={search} />
          <span className={cn('font-semibold text-slate-800 truncate min-w-0', LIST_BODY_TEXT_CLASS)}>
            <HighlightText text={w.name} query={search} />
          </span>
          <code
            className={cn(
              LIST_SECONDARY_TEXT_CLASS,
              'bg-slate-100 px-1.5 py-0.5 rounded text-slate-500 font-mono truncate min-w-0 hidden sm:inline-block',
            )}
          >
            <HighlightText text={w.slug} query={search} />
          </code>
          {globalSearch && <FolderBadge folderId={folderId} folders={folders} />}
        </div>
        {w.description && <WorkflowDescription text={w.description} highlight={search} />}
      </div>

      <div className={cn(COMPACT_LIST_META_CELL_CLASS, 'justify-self-start')}>
        <TriggerBadge triggerType={w.trigger_type} />
      </div>

      <span
        className={cn(
          COMPACT_LIST_META_CELL_CLASS,
          LIST_BODY_TEXT_CLASS,
          'font-medium hidden sm:flex gap-1.5 justify-self-start',
          on ? 'text-emerald-600' : 'text-slate-400',
        )}
      >
        <span className={cn('w-1.5 h-1.5 rounded-full inline-block', on ? 'bg-emerald-400' : 'bg-slate-300')} />
        {on ? '启用' : '禁用'}
      </span>

      <span
        className={cn(
          COMPACT_LIST_META_CELL_CLASS,
          LIST_BODY_TEXT_CLASS,
          'text-slate-500 hidden md:flex truncate justify-self-start min-w-0',
        )}
        title={w.created_by_name || '未知'}
      >
        {w.created_by_name || '未知'}
      </span>

      <span
        className={cn(
          COMPACT_LIST_META_CELL_CLASS,
          LIST_BODY_TEXT_CLASS,
          'text-slate-400 hidden md:flex justify-self-start whitespace-nowrap tabular-nums',
        )}
      >
        {formatRelativeTime(w.updated_at)}
      </span>
      <div className={cn(COMPACT_LIST_ACTIONS_CLASS, COMPACT_LIST_META_CELL_CLASS)} onClick={(e) => e.stopPropagation()}>
        <WorkflowRowActions
          enabled={on}
          onEdit={onEdit}
          onToggle={onToggle}
          onRun={onRun}
          onShowRuns={onShowRuns}
          onDuplicate={onDuplicate}
          onShare={onShare}
          onOpenVersionHistory={onOpenVersionHistory}
          onExport={onExport}
          onDelete={onDelete}
          onOpenGraph={onOpenGraph}
          size="compact"
          onMenuOpenChange={setMenuOpen}
        />
      </div>
    </div>
  )
}

export function WorkflowCard({
  workflow: w,
  globalSearch,
  search,
  folders,
  folderId,
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
  selected = false,
  onSelectToggle,
}: WorkflowRowProps & { folderId: string }) {
  const meta = TRIGGER_META[w.trigger_type] ?? TRIGGER_META.manual
  const on = w.is_enabled
  const [menuOpen, setMenuOpen] = useState(false)
  const iconBg = on ? TRIGGER_BADGE_CLASS[meta.color].split(' ')[0] : 'bg-slate-100'
  const iconClass = on ? TRIGGER_ICON_CLASS[meta.color] : 'text-slate-400'

  return (
    <div
      className={cn(
        'wf-batch-card border rounded-xl p-4 cursor-pointer hover:border-indigo-200 hover:shadow-sm transition-all',
        on ? 'border-slate-200 bg-white' : 'border-dashed border-slate-200 bg-slate-50/50',
        selected && 'wf-batch-sel',
        menuOpen && 'relative z-30',
      )}
      onClick={onEdit}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {onSelectToggle ? (
              <RowIconCheckbox
                variant="card"
                selected={selected}
                iconClass={cn(meta.icon, iconClass)}
                bgClass={iconBg}
                onToggle={onSelectToggle}
              />
            ) : (
              <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0', iconBg)}>
                <i className={cn('fas text-[11px]', meta.icon, iconClass)} />
              </div>
            )}
            <WorkflowIdBadge id={w.id} search={search} />
            <span className="font-semibold text-slate-900 text-sm">
              <HighlightText text={w.name} query={search} />
            </span>
            <TriggerBadge triggerType={w.trigger_type} />
            {globalSearch && <FolderBadge folderId={folderId} folders={folders} />}
            <span className={cn('text-xs font-medium flex items-center gap-1', on ? 'text-emerald-600' : 'text-slate-400')}>
              <span className={cn('w-1.5 h-1.5 rounded-full inline-block', on ? 'bg-emerald-400' : 'bg-slate-300')} />
              {on ? '启用' : '禁用'}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1.5 min-w-0">
            <code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded text-slate-500 font-mono truncate min-w-0">
              <HighlightText text={w.slug} query={search} />
            </code>
          </div>
          {w.description && <WorkflowDescription text={w.description} highlight={search} className="mt-1.5" />}
          <div className={cn('flex items-center gap-3 mt-2 text-slate-400', LIST_SECONDARY_TEXT_CLASS)}>
            <span>{w.nodes?.length || 0} 节点</span>
            <span>·</span>
            <span>{w.created_by_name || '未知'}</span>
            <span>·</span>
            <span>{formatRelativeTime(w.updated_at)}</span>
          </div>
        </div>
        <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
          <WorkflowRowActions
            enabled={on}
            onEdit={onEdit}
            onToggle={onToggle}
            onRun={onRun}
            onShowRuns={onShowRuns}
            onDuplicate={onDuplicate}
            onShare={onShare}
            onOpenVersionHistory={onOpenVersionHistory}
            onExport={onExport}
            onDelete={onDelete}
            onOpenGraph={onOpenGraph}
            size="card"
            onMenuOpenChange={setMenuOpen}
          />
        </div>
      </div>
    </div>
  )
}
