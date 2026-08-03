'use client'

/**
 * 通用分页页脚（客户端分页）：上一页 / 下一页 / 跳页 / 每页大小切换。
 *
 * 这个组件不持有任何数据，只负责把"当前页 / 总数 / 每页大小"渲染成 UI 并
 * 把变化回调给父组件。父组件在 useMemo 里 slice 数据即可。
 *
 * 设计取舍：
 * - 不渲染 1..N 全部页码（数据多时炸屏）；只渲染当前页附近的几个 + 首尾。
 * - 当 totalPages <= 1 时整个组件返回 null，免得空表也带个孤零零的页脚。
 * - 没有引入额外依赖（自己拼按钮），保持和项目里其他 UI 一致的 Tailwind 风格。
 */

import { useMemo, useState } from 'react'

export interface PaginationProps {
  /** 数据总条数 */
  total: number
  /** 当前页（1-based） */
  page: number
  /** 每页条数 */
  pageSize: number
  /** 翻页 / 跳页时的回调 */
  onPageChange: (page: number) => void
  /** 用户切换每页大小时的回调；不传则不显示每页大小选择器 */
  onPageSizeChange?: (size: number) => void
  /** 每页大小可选项（仅在 onPageSizeChange 给出时生效） */
  pageSizeOptions?: number[]
  /** 是否显示"跳至第 N 页"输入框；不传则在 `!compact && totalPages > 7` 时自动显示 */
  showJumper?: boolean
  /** 紧凑布局（slow-queries 这种空间小的地方用） */
  compact?: boolean
  /** 总数为上限截断时展示「N+」（精确 COUNT 过慢时的执行日志等场景） */
  totalCapped?: boolean
  className?: string
}

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 20, 50, 100]

/**
 * 算"当前页周围要显示的页码"。规则：
 *  - 始终展示 1 和最后一页；
 *  - 当前页前后各 1 页；
 *  - 中间断开处用 ellipsis（用 -1 / -2 占位，避免 React key 冲突）。
 */
function buildPageItems(current: number, total: number): number[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1)
  }

  const items: number[] = [1]
  const left = Math.max(2, current - 1)
  const right = Math.min(total - 1, current + 1)

  if (left > 2) items.push(-1) // 左侧 …
  for (let p = left; p <= right; p++) items.push(p)
  if (right < total - 1) items.push(-2) // 右侧 …
  items.push(total)
  return items
}

export default function Pagination({
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  showJumper,
  compact = false,
  totalCapped = false,
  className = '',
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  // 越界保护：删除最后一页的最后一行后 page 可能会越界
  const safePage = Math.min(Math.max(1, page), totalPages)

  const pageItems = useMemo(() => buildPageItems(safePage, totalPages), [safePage, totalPages])

  // 跳转输入的临时值（受控但只在 commit 时通知父组件）。
  // 提交后清空恢复占位，避免和按钮点击后当前页显示重复。
  const [jumpValue, setJumpValue] = useState('')

  if (total === 0) return null
  if (totalPages <= 1 && !onPageSizeChange) return null

  const fromIdx = (safePage - 1) * pageSize + 1
  const toIdx = Math.min(safePage * pageSize, total)

  const goto = (p: number) => {
    if (p < 1 || p > totalPages || p === safePage) return
    onPageChange(p)
  }

  const commitJump = () => {
    if (jumpValue === '') return
    const n = parseInt(jumpValue, 10)
    if (!Number.isNaN(n)) {
      const clamped = Math.min(Math.max(1, n), totalPages)
      if (clamped !== safePage) onPageChange(clamped)
    }
    setJumpValue('')
  }

  // 默认策略：紧凑模式或页数很少（≤7，页码全展开）时不显示跳转框——按钮更快。
  const jumperEnabled = showJumper ?? (!compact && totalPages > 7)

  const btnBase =
    'inline-flex items-center justify-center rounded border text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
  const sizeCls = compact ? 'h-7 min-w-[28px] px-2' : 'h-8 min-w-[32px] px-2.5'
  // 跳转输入宽度固定（比按钮宽），避免每页大小选择器与之高度不一致造成跳动。
  const jumperInputCls = compact ? 'h-7 w-12' : 'h-8 w-14'

  // 三段式：info（左）/ 页码（中）/ 每页大小（右）。
  // 用 flex-1 让左右两段等分侧栏空间，即使一段更长中段仍视觉居中；
  // 也把翻页控件推离右边缘，避免被浮动组件（如右下 AI 助手按钮）盖住。
  return (
    <div
      className={`flex items-center gap-3 flex-wrap ${
        compact ? 'text-xs' : 'text-sm'
      } ${className}`}
    >
      <div className="flex-1 min-w-0 text-gray-500">
        共{' '}
        <span className="font-medium text-gray-900">
          {totalCapped ? `${total}+` : total}
        </span>{' '}
        条 ·
        <span className="ml-1">
          第 {fromIdx}–{toIdx} 条
        </span>
        {totalCapped && (
          <span className="ml-1 text-xs text-gray-400" title="总数过大，已截断精确计数以加快响应">
            （已截断）
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          aria-label="上一页"
          onClick={() => goto(safePage - 1)}
          disabled={safePage <= 1}
          className={`${btnBase} ${sizeCls} border-gray-300 bg-white text-gray-600 hover:bg-gray-50`}
        >
          <i className="fas fa-chevron-left"></i>
        </button>

        {pageItems.map((p, i) => {
          if (p < 0) {
            return (
              <span
                key={`ell-${p}-${i}`}
                className={`${sizeCls} flex items-center justify-center text-gray-400`}
              >
                …
              </span>
            )
          }
          const active = p === safePage
          return (
            <button
              key={p}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => goto(p)}
              className={`${btnBase} ${sizeCls} ${
                active
                  ? 'border-blue-500 bg-blue-500 text-white'
                  : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {p}
            </button>
          )
        })}

        <button
          type="button"
          aria-label="下一页"
          onClick={() => goto(safePage + 1)}
          disabled={safePage >= totalPages}
          className={`${btnBase} ${sizeCls} border-gray-300 bg-white text-gray-600 hover:bg-gray-50`}
        >
          <i className="fas fa-chevron-right"></i>
        </button>
      </div>

      {/* 右侧槽：pageSize 选择器 + 跳转输入。都未启用时留空占位，保持中段居中。 */}
      <div className="flex-1 min-w-0 flex justify-end items-center gap-3">
        {onPageSizeChange && (
          <div className="flex items-center gap-1.5 text-gray-500">
            <span>每页</span>
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              className={`${sizeCls} border-gray-300 bg-white rounded text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-500`}
            >
              {pageSizeOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        )}

        {jumperEnabled && (
          <div className="flex items-center gap-1.5 text-gray-500">
            <span>跳至</span>
            <input
              type="text"
              inputMode="numeric"
              aria-label={`跳至指定页，共 ${totalPages} 页`}
              value={jumpValue}
              onChange={(e) => setJumpValue(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitJump()
                }
              }}
              onBlur={commitJump}
              placeholder={String(safePage)}
              className={`${jumperInputCls} px-1.5 text-center border border-gray-300 bg-white rounded text-gray-700 placeholder-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-500`}
            />
            <span>页</span>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 把数组按 page / pageSize 切片的小工具。给父组件方便 `useMemo` 用：
 *
 *   const pageItems = useMemo(
 *     () => sliceForPage(allRows, page, pageSize),
 *     [allRows, page, pageSize]
 *   )
 */
export function sliceForPage<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize
  return items.slice(start, start + pageSize)
}
