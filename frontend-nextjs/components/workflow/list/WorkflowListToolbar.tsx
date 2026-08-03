'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { TRIGGER_ICON_CLASS, TRIGGER_META } from './constants'
import type { WorkflowListPageState, WorkflowListSort, WorkflowListView } from './types'

interface WorkflowListToolbarProps {
  state: WorkflowListPageState
  authors: string[]
  onSearch: (value: string) => void
  onToggleGlobalSearch: () => void
  onSetStatus: (status: WorkflowListPageState['status']) => void
  onToggleTrig: (key: string, checked: boolean) => void
  onSetAuthor: (author: string | null) => void
  onSetSort: (sort: WorkflowListSort) => void
  onSetView: (view: WorkflowListView) => void
}

function FilterChip({
  active,
  onClick,
  children,
  className,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-2.5 py-1 text-xs rounded-full border font-medium transition-colors',
        active
          ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
        className,
      )}
    >
      {children}
    </button>
  )
}

export default function WorkflowListToolbar({
  state,
  authors,
  onSearch,
  onToggleGlobalSearch,
  onSetStatus,
  onToggleTrig,
  onSetAuthor,
  onSetSort,
  onSetView,
}: WorkflowListToolbarProps) {
  const [openDrop, setOpenDrop] = useState<'trig' | 'author' | 'sort' | null>(null)
  const [authorSearch, setAuthorSearch] = useState('')
  const authorInputRef = useRef<HTMLInputElement>(null)
  const trigDropRef = useRef<HTMLDivElement>(null)
  const authorDropRef = useRef<HTMLDivElement>(null)
  const sortDropRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!openDrop) return
    const dropRefs = {
      trig: trigDropRef,
      author: authorDropRef,
      sort: sortDropRef,
    } as const
    const onPointerDown = (e: PointerEvent) => {
      const root = dropRefs[openDrop].current
      if (root && !root.contains(e.target as Node)) {
        setOpenDrop(null)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [openDrop])

  useEffect(() => {
    if (openDrop === 'author') {
      setAuthorSearch('')
      setTimeout(() => authorInputRef.current?.focus(), 50)
    }
  }, [openDrop])

  const filteredAuthors = authorSearch.trim()
    ? authors.filter((a) => a.toLowerCase().includes(authorSearch.toLowerCase()))
    : authors

  const sortLabel = { updated_at: '最近修改', created_at: '创建时间', name: '名称 A→Z' }[state.sort]

  return (
    <div className="px-5 py-2 border-b border-slate-100 flex items-center gap-2 shrink-0 flex-wrap">
      <div className="relative">
        <i className="fas fa-search text-slate-300 absolute left-2.5 top-1/2 -translate-y-1/2 text-xs" />
        <input
          type="text"
          value={state.search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={
            state.globalSearch ? '全局搜索 ID / 名称 / slug' : '搜索本文件夹 ID / 名称 / slug'
          }
          className="pl-7 pr-8 py-2 border border-slate-200 rounded-lg text-sm w-72 lg:w-80 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-200"
        />
        {state.search && (
          <button
            type="button"
            aria-label="清除搜索"
            onClick={() => onSearch('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 flex items-center justify-center rounded-full text-slate-300 hover:text-slate-500 hover:bg-slate-100"
          >
            <i className="fas fa-xmark text-[11px]" />
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={onToggleGlobalSearch}
        title="在整个项目库的所有文件夹中搜索"
        className={cn(
          'px-2.5 py-2 text-sm border rounded-lg flex items-center gap-1.5',
          state.globalSearch
            ? 'border-indigo-400 bg-indigo-50 text-indigo-700 font-semibold'
            : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50',
        )}
      >
        <i className={cn('fas fa-globe text-[9px]', state.globalSearch ? 'text-indigo-500' : 'text-slate-400')} />
        全局搜索
      </button>

      {/* Trigger dropdown（多选，勾选时不关闭） */}
      <div className="relative" ref={trigDropRef}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setOpenDrop(openDrop === 'trig' ? null : 'trig')
          }}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-2 text-sm border rounded-lg font-medium',
            state.trigs.size
              ? 'border-indigo-400 bg-indigo-50 text-indigo-700'
              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
          )}
        >
          <i className="fas fa-bolt text-slate-400 text-[10px]" />
          {state.trigs.size ? `触发 (${state.trigs.size})` : '触发方式'}
          <i className="fas fa-chevron-down text-slate-300 text-[9px]" />
        </button>
        {openDrop === 'trig' && (
          <div className="absolute top-full mt-1 left-0 bg-white border border-slate-200 rounded-xl py-1.5 z-30 w-44 shadow-lg">
            {Object.entries(TRIGGER_META).map(([k, v]) => (
              <label
                key={k}
                className="flex items-center gap-2 px-3 py-2 hover:bg-slate-50 cursor-pointer text-sm text-slate-700"
              >
                <input
                  type="checkbox"
                  checked={state.trigs.has(k)}
                  onChange={(e) => onToggleTrig(k, e.target.checked)}
                  className="w-3 h-3 rounded accent-indigo-600"
                />
                <i className={cn('fas text-[10px] w-3 text-center', v.icon, TRIGGER_ICON_CLASS[v.color])} />
                {v.label}
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Author dropdown */}
      <div className="relative" ref={authorDropRef}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setOpenDrop(openDrop === 'author' ? null : 'author')
          }}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-2 text-sm border rounded-lg font-medium',
            state.author
              ? 'border-indigo-400 bg-indigo-50 text-indigo-700'
              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
          )}
        >
          <i className="fas fa-user text-slate-400 text-[10px]" />
          {state.author || '作者'}
          <i className="fas fa-chevron-down text-slate-300 text-[9px]" />
        </button>
        {openDrop === 'author' && (
          <div
            className="absolute top-full mt-1 left-0 bg-white border border-slate-200 rounded-xl py-1.5 z-30 w-36 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-2 pt-2 pb-1">
              <div className="relative">
                <i className="fas fa-search text-slate-300 absolute left-2 top-1/2 -translate-y-1/2 text-[9px]" />
                <input
                  ref={authorInputRef}
                  type="text"
                  value={authorSearch}
                  onChange={(e) => setAuthorSearch(e.target.value)}
                  placeholder="搜索作者…"
                  className="w-full pl-6 pr-2 py-1.5 border border-slate-200 rounded-md text-sm placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-300"
                />
              </div>
            </div>
            <div className="h-px bg-slate-100 mx-2 mb-1" />
            <div className="overflow-y-auto max-h-40">
              {!authorSearch.trim() && (
                <button
                  type="button"
                  onClick={() => {
                    onSetAuthor(null)
                    setOpenDrop(null)
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 flex items-center justify-between"
                >
                  全部作者
                  {!state.author && <i className="fas fa-check text-indigo-600 text-[10px]" />}
                </button>
              )}
              {filteredAuthors.length === 0 ? (
                <div className="px-3 py-2 text-sm text-slate-400">无匹配作者</div>
              ) : (
                filteredAuthors.map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => {
                      onSetAuthor(a)
                      setOpenDrop(null)
                    }}
                    className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 flex items-center justify-between"
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="w-5 h-5 rounded-full bg-indigo-100 text-indigo-600 text-[10px] font-bold flex items-center justify-center">
                        {a[0]}
                      </span>
                      {a}
                    </span>
                    {state.author === a && <i className="fas fa-check text-indigo-600 text-[10px]" />}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 ml-auto">
        <FilterChip active={state.status === 'all'} onClick={() => onSetStatus('all')}>
          全部
        </FilterChip>
        <FilterChip active={state.status === 'on'} onClick={() => onSetStatus('on')} className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
          启用
        </FilterChip>
        <FilterChip active={state.status === 'off'} onClick={() => onSetStatus('off')} className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-slate-300 inline-block" />
          禁用
        </FilterChip>
      </div>

      <div className="relative" ref={sortDropRef}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setOpenDrop(openDrop === 'sort' ? null : 'sort')
          }}
          className="flex items-center gap-1.5 px-2.5 py-2 text-sm border border-slate-200 rounded-lg bg-white text-slate-600 hover:bg-slate-50 font-medium"
        >
          <i className="fas fa-arrow-up-wide-short text-slate-400 text-[10px]" />
          {sortLabel}
          <i className="fas fa-chevron-down text-slate-300 text-[9px]" />
        </button>
        {openDrop === 'sort' && (
          <div
            className="absolute top-full mt-1 right-0 bg-white border border-slate-200 rounded-xl py-1.5 z-30 w-36 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            {(
              [
                ['created_at', '创建时间'],
                ['updated_at', '最近修改'],
                ['name', '名称 A→Z'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  onSetSort(key)
                  setOpenDrop(null)
                }}
                className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 flex items-center justify-between"
              >
                {label}
                {state.sort === key && <i className="fas fa-check text-indigo-600 text-[10px]" />}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center border border-slate-200 rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => onSetView('compact')}
          className={cn(
            'px-2.5 py-2 text-sm flex items-center gap-1.5 font-medium',
            state.view === 'compact' ? 'bg-indigo-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50',
          )}
        >
          <i className="fas fa-list text-[9px]" />
          紧凑
        </button>
        <button
          type="button"
          onClick={() => onSetView('card')}
          className={cn(
            'px-2.5 py-2 text-sm flex items-center gap-1.5 font-medium',
            state.view === 'card' ? 'bg-indigo-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50',
          )}
        >
          <i className="fas fa-grip text-[9px]" />
          卡片
        </button>
      </div>
    </div>
  )
}
