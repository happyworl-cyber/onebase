'use client'

interface NewFolderDialogProps {
  parentName: string
  kind: 'department' | 'category'
  onConfirm: (name: string) => void
  onCancel: () => void
}

export default function NewFolderDialog({ parentName, kind, onConfirm, onCancel }: NewFolderDialogProps) {
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
          if (name) onConfirm(name)
        }}
      >
        <h3 className="font-semibold text-slate-800 mb-1">
          新建{kind === 'department' ? '服务' : '分类'}
        </h3>
        <p className="text-xs text-slate-500 mb-4">
          在「{parentName}」下创建{kind === 'department' ? '服务（一级）' : '分类（二级）'}
        </p>
        <input
          name="name"
          autoFocus
          required
          placeholder={kind === 'department' ? '如：用户服务' : '如：订单同步'}
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
        />
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
            创建
          </button>
        </div>
      </form>
    </div>
  )
}
