'use client'

// M4：列级可见性 UI
//
// 心智模型（deny-first）：
//   1. 默认"全部可见"
//   2. 用户在表头扫到的列名旁勾选 → 加进 denied_columns（黑名单）
//   3. 切到 "白名单模式" → allowed_columns 接管，denied_columns 不再出面
//
// 后端字段对照：
//   - allowed_columns: Option<Vec<String>>
//       null → 全部允许
//       []   → 全部不可见
//       ["id","title"] → 仅这些可见
//   - denied_columns:  Vec<String>
//       在 allowed 基础上再删
//
// UI 提供二选一切换以避免用户同时配置 allow + deny 造成认知冲突。
// 高级用户依然可以通过后端 API 同时设置；UI 仅暴露常见用法。

import { useMemo } from 'react'

export type ColumnMode = 'deny' | 'allow'

interface ColumnControlProps {
  /** 可用的全表列名（来自 schemaAPI.getTableStructure） */
  availableColumns: string[]
  /** 后端字段 1:1 透传 */
  allowed_columns: string[] | null
  denied_columns: string[]
  /** 切换模式后会清空对方字段 */
  mode: ColumnMode
  onChange: (next: {
    mode: ColumnMode
    allowed_columns: string[] | null
    denied_columns: string[]
  }) => void
}

export default function ColumnControl({
  availableColumns,
  allowed_columns,
  denied_columns,
  mode,
  onChange,
}: ColumnControlProps) {
  const switchMode = (m: ColumnMode) => {
    if (m === mode) return
    if (m === 'deny') {
      onChange({ mode: 'deny', allowed_columns: null, denied_columns: [] })
    } else {
      onChange({ mode: 'allow', allowed_columns: [], denied_columns: [] })
    }
  }

  const isCurrentlyHidden = useMemo(() => {
    if (mode === 'deny') {
      return (col: string) => denied_columns.includes(col)
    }
    // allow 模式：不在 allowed 列表里 = 隐藏
    const list = allowed_columns ?? []
    return (col: string) => !list.includes(col)
  }, [mode, allowed_columns, denied_columns])

  const toggle = (col: string) => {
    if (mode === 'deny') {
      const next = denied_columns.includes(col)
        ? denied_columns.filter((c) => c !== col)
        : [...denied_columns, col]
      onChange({ mode: 'deny', allowed_columns: null, denied_columns: next })
    } else {
      const list = allowed_columns ?? []
      const next = list.includes(col)
        ? list.filter((c) => c !== col)
        : [...list, col]
      onChange({ mode: 'allow', allowed_columns: next, denied_columns: [] })
    }
  }

  return (
    <div className="space-y-3">
      {/* 模式切换 */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-gray-500">模式：</span>
        <button
          type="button"
          onClick={() => switchMode('deny')}
          className={`px-3 py-1 rounded transition-colors ${
            mode === 'deny'
              ? 'bg-blue-500 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          黑名单（隐藏指定列）
        </button>
        <button
          type="button"
          onClick={() => switchMode('allow')}
          className={`px-3 py-1 rounded transition-colors ${
            mode === 'allow'
              ? 'bg-blue-500 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          白名单（仅显示指定列）
        </button>
      </div>

      <p className="text-xs text-gray-500">
        {mode === 'deny'
          ? '默认全部可见，勾选的列会被隐藏。'
          : '默认全部隐藏，仅勾选的列可见。'}
      </p>

      {/* 列网格 */}
      {availableColumns.length === 0 ? (
        <div className="text-xs text-gray-400 italic px-3 py-3 border border-dashed border-gray-200 rounded">
          无法加载列名 — 请先选择 schema.table 资源
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-1 max-h-48 overflow-y-auto p-2 border border-gray-200 rounded">
          {availableColumns.map((col) => {
            const hidden = isCurrentlyHidden(col)
            return (
              <label
                key={col}
                className={`flex items-center gap-2 px-2 py-1 text-xs rounded cursor-pointer hover:bg-gray-50 ${
                  hidden ? 'opacity-60' : ''
                }`}
                title={hidden ? '当前已隐藏' : '当前可见'}
              >
                <input
                  type="checkbox"
                  checked={
                    mode === 'deny'
                      ? denied_columns.includes(col)
                      : (allowed_columns ?? []).includes(col)
                  }
                  onChange={() => toggle(col)}
                  className="rounded border-gray-300"
                />
                <span
                  className={`font-mono ${
                    hidden ? 'text-gray-400 line-through' : 'text-gray-700'
                  }`}
                >
                  {col}
                </span>
              </label>
            )
          })}
        </div>
      )}

      {/* 摘要 */}
      <p className="text-[11px] text-gray-400">
        {mode === 'deny'
          ? denied_columns.length === 0
            ? '当前：全部可见'
            : `当前：隐藏 ${denied_columns.length} 列`
          : (allowed_columns ?? []).length === 0
            ? '当前：全部隐藏（无可见列）'
            : `当前：仅 ${(allowed_columns ?? []).length} 列可见`}
      </p>
    </div>
  )
}
