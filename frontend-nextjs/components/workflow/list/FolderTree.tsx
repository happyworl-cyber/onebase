'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import TruncatedText from './TruncatedText'
import {
  canMoveCategoryToDept,
  countInFolderFromGroups,
  DEPT_PREFIX,
  getFolderChildren,
  isCategoryFolderId,
  isDepartmentFolderId,
  type WorkflowGroupCount,
} from './utils'
import { ROOT_FOLDER_ID, type WorkflowFolder } from './types'

const DRAG_MIME = 'application/x-onebase-category-folder'

interface FolderTreeProps {
  folders: WorkflowFolder[]
  summaryGroups: WorkflowGroupCount[]
  totalCount?: number
  activeId: string
  expanded: Set<string>
  onSelect: (folderId: string) => void
  onToggleExpand: (folderId: string) => void
  onNewFolder: (parentId: string | null) => void
  onDeleteFolder?: (folderId: string) => void
  onMoveCategory?: (categoryFolderId: string, targetDeptFolderId: string) => void | Promise<void>
  movingCategory?: boolean
}

function TreeNode({
  folderId,
  depth,
  folders,
  summaryGroups,
  activeId,
  expanded,
  onSelect,
  onToggleExpand,
  onNewFolder,
  onDeleteFolder,
  onMoveCategory,
  movingCategory,
  dropDeptId,
  setDropDeptId,
  draggingCategoryId,
  setDraggingCategoryId,
}: FolderTreeProps & {
  folderId: string
  depth: number
  dropDeptId: string | null
  setDropDeptId: (id: string | null) => void
  draggingCategoryId: string | null
  setDraggingCategoryId: (id: string | null) => void
}) {
  const folder = folders.find((f) => f.id === folderId)
  if (!folder) return null

  const children = getFolderChildren(folders, folderId)
  const isExpanded = expanded.has(folderId)
  const isActive = activeId === folderId
  const count = countInFolderFromGroups(summaryGroups, folderId)
  const isRoot = folderId === ROOT_FOLDER_ID
  const isCategory = isCategoryFolderId(folderId)
  const isDept = isDepartmentFolderId(folderId)
  const isDropTarget = isDept && dropDeptId === folderId
  const indent = depth === 0 ? 'pl-2' : depth === 1 ? 'pl-5' : 'pl-8'

  const handleDragStart = (e: React.DragEvent) => {
    if (!isCategory || movingCategory) {
      e.preventDefault()
      return
    }
    e.dataTransfer.setData(DRAG_MIME, folderId)
    e.dataTransfer.effectAllowed = 'move'
    setDraggingCategoryId(folderId)
  }

  const handleDragOver = (e: React.DragEvent) => {
    if (!isDept || !onMoveCategory || movingCategory || !draggingCategoryId) return
    if (!canMoveCategoryToDept(draggingCategoryId, folderId)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropDeptId(folderId)
  }

  const handleDrop = (e: React.DragEvent) => {
    if (!isDept || !onMoveCategory || movingCategory) return
    e.preventDefault()
    const categoryId = e.dataTransfer.getData(DRAG_MIME) || draggingCategoryId
    setDropDeptId(null)
    setDraggingCategoryId(null)
    if (categoryId && canMoveCategoryToDept(categoryId, folderId)) {
      void onMoveCategory(categoryId, folderId)
    }
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        draggable={isCategory && !movingCategory}
        onDragStart={handleDragStart}
        onDragEnd={() => {
          setDropDeptId(null)
          setDraggingCategoryId(null)
        }}
        onDragOver={handleDragOver}
        onDragLeave={() => {
          if (isDropTarget) setDropDeptId(null)
        }}
        onDrop={handleDrop}
        onClick={() => onSelect(folderId)}
        onKeyDown={(e) => e.key === 'Enter' && onSelect(folderId)}
        className={cn(
          'group flex items-center gap-1.5 px-2 py-1.5 mx-1 rounded-lg select-none transition-colors duration-70',
          indent,
          isCategory && !movingCategory && 'cursor-grab active:cursor-grabbing',
          !isCategory && 'cursor-pointer',
          isActive ? 'bg-indigo-50' : 'hover:bg-slate-100',
          isDropTarget && 'ring-2 ring-indigo-400 bg-indigo-50/80',
          movingCategory && isCategory && 'opacity-50',
        )}
      >
        {children.length > 0 ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onToggleExpand(folderId)
            }}
            className="w-3.5 h-3.5 flex items-center justify-center text-slate-400 shrink-0"
          >
            <i className={cn('fas text-[8px]', isExpanded ? 'fa-chevron-down' : 'fa-chevron-right')} />
          </button>
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        {isCategory && (
          <i
            className="fas fa-grip-vertical text-[8px] text-slate-300 shrink-0 opacity-0 group-hover:opacity-100"
            title="拖拽到其他服务以移动此分类"
          />
        )}
        <i
          className={cn(
            'fas text-[11px] w-3.5 text-center shrink-0',
            folder.icon,
            isActive ? 'text-indigo-500' : folder.color,
          )}
        />
        <TruncatedText
          text={folder.name}
          singleLine={false}
          className={cn(
            'text-sm flex-1 min-w-0 break-words leading-snug',
            isActive ? 'text-indigo-700 font-semibold' : 'text-slate-700 font-medium',
          )}
        />
        <div className="flex items-center gap-0.5 shrink-0">
          <span
            className={cn(
              'w-6 text-right text-xs tabular-nums',
              isActive ? 'text-indigo-400' : 'text-slate-400',
            )}
          >
            {count || ''}
          </span>
          {!isRoot && isDept && (
            <button
              type="button"
              title="新建分类"
              onClick={(e) => {
                e.stopPropagation()
                onNewFolder(folderId)
              }}
              className="w-4 h-4 flex items-center justify-center rounded hover:bg-slate-200 text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <i className="fas fa-plus text-[8px]" />
            </button>
          )}
          {!isRoot && onDeleteFolder && (isDept || isCategory) && (
            <button
              type="button"
              title="删除"
              onClick={(e) => {
                e.stopPropagation()
                onDeleteFolder(folderId)
              }}
              className="w-4 h-4 flex items-center justify-center rounded hover:bg-red-100 text-slate-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <i className="fas fa-trash text-[8px]" />
            </button>
          )}
        </div>
      </div>
      {isExpanded &&
        children.map((c) => (
          <TreeNode
            key={c.id}
            folderId={c.id}
            depth={depth + 1}
            folders={folders}
            summaryGroups={summaryGroups}
            activeId={activeId}
            expanded={expanded}
            onSelect={onSelect}
            onToggleExpand={onToggleExpand}
            onNewFolder={onNewFolder}
            onDeleteFolder={onDeleteFolder}
            onMoveCategory={onMoveCategory}
            movingCategory={movingCategory}
            dropDeptId={dropDeptId}
            setDropDeptId={setDropDeptId}
            draggingCategoryId={draggingCategoryId}
            setDraggingCategoryId={setDraggingCategoryId}
          />
        ))}
    </div>
  )
}

export default function FolderTree({
  folders,
  summaryGroups,
  totalCount,
  activeId,
  expanded,
  onSelect,
  onToggleExpand,
  onNewFolder,
  onDeleteFolder,
  onMoveCategory,
  movingCategory,
}: FolderTreeProps) {
  const [dropDeptId, setDropDeptId] = useState<string | null>(null)
  const [draggingCategoryId, setDraggingCategoryId] = useState<string | null>(null)
  const folderCount = folders.filter((f) => f.id !== ROOT_FOLDER_ID).length

  return (
    <div className="w-60 border-r border-slate-100 bg-slate-50/60 flex flex-col shrink-0 select-none">
      <div className="px-3 pt-3 pb-2 border-b border-slate-100 flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-400 uppercase tracking-widest">工作流</span>
        <button
          type="button"
          title="新建服务"
          onClick={() => onNewFolder(null)}
          className="w-5 h-5 flex items-center justify-center rounded hover:bg-slate-200 text-slate-400 hover:text-slate-600"
        >
          <i className="fas fa-folder-plus text-[10px]" />
        </button>
      </div>

      {onMoveCategory && (
        <p className="px-3 py-1.5 text-xs text-slate-400 leading-snug border-b border-slate-100">
          拖拽分类到目标服务可移动
        </p>
      )}

      <div className="flex-1 overflow-y-auto py-1.5">
        <TreeNode
          folderId={ROOT_FOLDER_ID}
          depth={0}
          folders={folders}
          summaryGroups={summaryGroups}
          activeId={activeId}
          expanded={expanded}
          onSelect={onSelect}
          onToggleExpand={onToggleExpand}
          onNewFolder={onNewFolder}
          onDeleteFolder={onDeleteFolder}
          onMoveCategory={onMoveCategory}
          movingCategory={movingCategory}
          dropDeptId={dropDeptId}
          setDropDeptId={setDropDeptId}
          draggingCategoryId={draggingCategoryId}
          setDraggingCategoryId={setDraggingCategoryId}
        />
      </div>

      <div className="px-3 py-2 border-t border-slate-100 text-xs text-slate-400 leading-relaxed">
        <div className="flex items-center justify-between">
          <span>工作流总数</span>
          <span className="font-semibold text-slate-600">{totalCount ?? 0}</span>
        </div>
        <div className="flex items-center justify-between mt-0.5">
          <span>文件夹</span>
          <span className="font-semibold text-slate-600">{folderCount}</span>
        </div>
      </div>
    </div>
  )
}
