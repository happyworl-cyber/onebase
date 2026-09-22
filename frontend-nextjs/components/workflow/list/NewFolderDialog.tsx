'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
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
  const t = useTranslations('wfList')
  const [error, setError] = useState<string | null>(null)
  const isRename = mode === 'rename'
  const label = kind === 'department' ? t('kindService') : t('kindCategory')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onMouseDown={onCancel} />
      <form
        className="relative bg-white rounded-xl shadow-xl w-full max-w-sm p-5"
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
          {isRename ? t('renameLabel', { label }) : t('newLabel', { label })}
        </h3>
        <p className="text-xs text-slate-500 mb-4">
          {isRename
            ? t('renameDesc', { name: initialName, label })
            : t('createDesc', { parent: parentName, sub: kind === 'department' ? t('subServiceL1') : t('subCategoryL2') })}
        </p>
        <input
          name="name"
          autoFocus
          required
          defaultValue={initialName}
          placeholder={kind === 'department' ? t('phService') : t('phCategory')}
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
          onChange={() => {
            if (error) setError(null)
          }}
        />
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        {isRename && workflowCount > 0 && (
          <p className="mt-2 text-xs text-slate-500">{t('syncNote', { n: workflowCount })}</p>
        )}
        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800"
          >
            {t('cancel')}
          </button>
          <button
            type="submit"
            className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium"
          >
            {isRename ? t('save') : t('create')}
          </button>
        </div>
      </form>
    </div>
  )
}
