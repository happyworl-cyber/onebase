'use client'

import { useState } from 'react'
import { validateFolderRename } from './utils'

interface NewFolderDialogProps {
  parentName: string
  kind: 'department' | 'category'
  mode?: 'create' | 'rename'
  initialName?: string
  workflowCount?: number
  siblingNames?: string[]
  onConfirm: (name: string) => void
  onCancel: () => void
}

export default function NewFolderDialog({
  parentName,
  kind,
  mode = 'create',
  initialName = '',
  workflowCount = 0,
  siblingNames = [],
  onConfirm,
  onCancel,
}: NewFolderDialogProps) {
  const [error, setError] = useState<string | null>(null)
  const isRename = mode === 'rename'
  const label = kind === 'department' ? '服务' : '分类'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onCancel}>
      <div className="absolute inset-0 bg-black/40" />
      <form
        className="relative bg-white rounded-xl shadow-xl w-full max-w-sm p-5"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          const fd = new FormData(e.currentTarget)
          const name = String(fd.get('name') || '').trim()
          if (isRename) {
            if (name === initialName.trim()) {
              onCancel()
              return
            }
            const err = validateFolderRename(name, siblingNames, initialName.trim())
            if (err) {
              setError(err)
              return
            }
          }
          if (name) onConfirm(name)
        }}
      >
        <h3 className="font-semibold text-slate-800 mb-1">
          {isRename ? `重命名${label}` : `新建${label}`}
        </h3>
        <p className="text-xs text-slate-500 mb-4">
          {isRename
            ? `将「${initialName}」改为新的${label}名称`
            : `在「${parentName}」下创建${kind === 'department' ? '服务（一级）' : '分类（二级）'}`}
        </p>
        <input
          name="name"
          autoFocus
          required
          defaultValue={initialName}
          placeholder={kind === 'department' ? '如：用户服务' : '如：订单同步'}
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
          onChange={() => {
            if (error) setError(null)
          }}
        />
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        {isRename && workflowCount > 0 && (
          <p className="mt-2 text-xs text-slate-500">将同步更新 {workflowCount} 个工作流的归属</p>
        )}
        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800"
          >
            取消
          </button>
          <button
            type="submit"
            className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium"
          >
            {isRename ? '保存' : '创建'}
          </button>
        </div>
      </form>
    </div>
  )
}
