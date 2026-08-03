import { UNCATEGORIZED_FOLDER_NAME } from './types'

export const TRIGGER_META: Record<
  string,
  { icon: string; label: string; color: 'indigo' | 'amber' | 'sky' | 'slate' | 'violet' | 'emerald' }
> = {
  endpoint: { icon: 'fa-globe', label: 'HTTP 端点', color: 'indigo' },
  hook: { icon: 'fa-bolt', label: '数据变更', color: 'amber' },
  notify: { icon: 'fa-bell', label: 'PG NOTIFY', color: 'violet' },
  cron: { icon: 'fa-clock', label: '定时任务', color: 'sky' },
  kafka: { icon: 'fa-envelope', label: 'Kafka 消息', color: 'emerald' },
  manual: { icon: 'fa-hand-pointer', label: '手动触发', color: 'slate' },
}

export const TRIGGER_BADGE_CLASS: Record<string, string> = {
  indigo: 'bg-indigo-50 text-indigo-600',
  amber: 'bg-amber-50 text-amber-600',
  sky: 'bg-sky-50 text-sky-600',
  slate: 'bg-slate-100 text-slate-500',
  violet: 'bg-violet-50 text-violet-600',
  emerald: 'bg-emerald-50 text-emerald-600',
}

export const TRIGGER_ICON_CLASS: Record<string, string> = {
  indigo: 'text-indigo-500',
  amber: 'text-amber-500',
  sky: 'text-sky-500',
  slate: 'text-slate-400',
  violet: 'text-violet-500',
  emerald: 'text-emerald-500',
}

/** 常见部门 / 分类名称 → 图标 / 颜色预设 */
export const FOLDER_NAME_PRESETS: Record<string, { icon: string; color: string }> = {
  共享: { icon: 'fa-globe', color: 'text-indigo-600' },
  招聘组: { icon: 'fa-user-tie', color: 'text-violet-600' },
  用户组: { icon: 'fa-user', color: 'text-sky-600' },
  通知中心: { icon: 'fa-bell', color: 'text-amber-600' },
  报表: { icon: 'fa-chart-bar', color: 'text-emerald-600' },
  '公共/共享': { icon: 'fa-globe', color: 'text-indigo-600' },
  归档: { icon: 'fa-box-archive', color: 'text-slate-400' },
  [UNCATEGORIZED_FOLDER_NAME]: { icon: 'fa-inbox', color: 'text-slate-400' },
}

export const LIST_PREFS_KEY = 'onebase:workflow-list-prefs'

export function customFoldersStorageKey(databaseId?: number | null) {
  return `onebase:workflow-folders:${databaseId ?? 'all'}`
}

/** 紧凑列表：表头与数据行共用同一 grid（固定操作列宽度，避免 flex 挤压导致列错位） */
export const COMPACT_LIST_GRID_CLASS =
  'grid gap-x-3 px-5 [grid-template-columns:28px_minmax(0,1fr)_6.5rem_9.75rem] sm:[grid-template-columns:28px_minmax(0,1fr)_6.5rem_3.5rem_9.75rem] md:[grid-template-columns:28px_minmax(0,1fr)_6.5rem_3.5rem_minmax(0,5rem)_5.5rem_9.75rem]'

/** 数据行：名称列顶对齐，其余列在整行高度内垂直居中 */
export const COMPACT_LIST_ROW_GRID_CLASS = `${COMPACT_LIST_GRID_CLASS} items-start`

/** 表头行 */
export const COMPACT_LIST_HEADER_GRID_CLASS = `${COMPACT_LIST_GRID_CLASS} items-center`

/** 除名称列外的单元格：行内垂直居中，多行备注时与触发/状态等同高对齐 */
export const COMPACT_LIST_META_CELL_CLASS = 'flex items-center self-center min-h-[1.5rem]'

/** 列表页正文字号（与 workspace 其他页面 text-sm 一致） */
export const LIST_BODY_TEXT_CLASS = 'text-sm'
/** 列表页次要信息 / 表头 */
export const LIST_SECONDARY_TEXT_CLASS = 'text-xs'

/** 列表备注默认展示行数（超出 line-clamp + title 悬浮全文） */
export const LIST_DESCRIPTION_CLAMP_CLASS = 'line-clamp-3'

/** 列表备注：与次要信息同字号，对比度略高 */
export const LIST_DESCRIPTION_TEXT_CLASS = 'text-xs text-slate-500'

/** @deprecated 使用 COMPACT_LIST_GRID_CLASS */
export const COMPACT_LIST_ROW_CLASS = COMPACT_LIST_GRID_CLASS

/** @deprecated 列已并入 COMPACT_LIST_GRID_CLASS */
export const COMPACT_LIST_META_GRID_CLASS = 'contents'

/** 操作列单元格对齐 */
export const COMPACT_LIST_ACTIONS_CLASS = 'justify-self-end'
