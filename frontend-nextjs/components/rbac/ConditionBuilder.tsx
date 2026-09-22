'use client'

import { useTranslations } from 'next-intl'

// M4：通用结构化条件 builder
//
// 输出形状严格对齐 backend Vec<RowCondition>：
//   [{ field, op, value }, ...]
// op ∈ '=' | '!=' | '>' | '>=' | '<' | '<=' | 'in' | 'isnull' | 'isnotnull'
//
// value 支持特殊占位符（点选下拉给出建议）：
//   $current_user_id            → 当前用户 ID
//   $current_user_department_id → 当前用户部门 ID
//
// IsNull / IsNotNull 操作符不需要 value；In 操作符需要逗号分隔多值
//
// 不在前端做完整 SQL AST 校验——后端 parse_row_conditions 会兜底拒绝非法字段名。

import { useMemo } from 'react'
import type { RowCondition, RowOp } from '@/lib/api'

const OP_OPTIONS: { value: RowOp; labelKey: string; needValue: boolean; multi?: boolean }[] = [
  { value: '=', labelKey: 'opEq', needValue: true },
  { value: '!=', labelKey: 'opNe', needValue: true },
  { value: '>', labelKey: 'opGt', needValue: true },
  { value: '>=', labelKey: 'opGte', needValue: true },
  { value: '<', labelKey: 'opLt', needValue: true },
  { value: '<=', labelKey: 'opLte', needValue: true },
  { value: 'in', labelKey: 'opIn', needValue: true, multi: true },
  { value: 'isnull', labelKey: 'opIsNull', needValue: false },
  { value: 'isnotnull', labelKey: 'opIsNotNull', needValue: false },
]

const VALUE_SUGGESTIONS: { value: string; labelKey: string }[] = [
  { value: '$current_user_id', labelKey: 'valCurrentUserId' },
  { value: '$current_user_department_id', labelKey: 'valCurrentDeptId' },
]

interface ConditionBuilderProps {
  value: RowCondition[]
  onChange: (next: RowCondition[]) => void
  /** 字段名候选（来自表 schema） */
  fieldOptions?: string[]
  /** 折叠提示，默认显示 */
  showHint?: boolean
}

export default function ConditionBuilder({
  value,
  onChange,
  fieldOptions,
  showHint = true,
}: ConditionBuilderProps) {
  const t = useTranslations('rbacConditionBuilder')
  const rows = value ?? []

  const addRow = () => {
    onChange([...rows, { field: '', op: '=', value: '' }])
  }

  const removeRow = (idx: number) => {
    onChange(rows.filter((_, i) => i !== idx))
  }

  const updateRow = (idx: number, patch: Partial<RowCondition>) => {
    onChange(
      rows.map((row, i) => {
        if (i !== idx) return row
        const next: RowCondition = { ...row, ...patch }
        const opMeta = OP_OPTIONS.find((o) => o.value === next.op)
        if (opMeta && !opMeta.needValue) {
          next.value = null
        }
        return next
      }),
    )
  }

  return (
    <div className="space-y-3">
      {showHint && (
        <p className="text-xs text-gray-500 leading-relaxed">
          {t.rich('andRelation', { b: (c) => <span className="font-medium text-gray-700">{c}</span> })}
          <br />
          <span className="text-gray-400">
            {t.rich('tip', { code: (c) => <code className="bg-gray-100 px-1 rounded text-[10px]">{c}</code> })}
          </span>
        </p>
      )}

      {rows.length === 0 ? (
        <div className="text-xs text-gray-400 italic px-3 py-4 border border-dashed border-gray-200 rounded">
          {t.rich('noConditions', { b: (c) => <strong className="text-gray-600">{c}</strong> })}
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((cond, idx) => {
            const opMeta = OP_OPTIONS.find((o) => o.value === cond.op)
            return (
              <ConditionRow
                key={idx}
                cond={cond}
                opMeta={opMeta}
                fieldOptions={fieldOptions}
                onPatch={(patch) => updateRow(idx, patch)}
                onRemove={() => removeRow(idx)}
              />
            )
          })}
        </ul>
      )}

      <button
        type="button"
        onClick={addRow}
        className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1"
      >
        <i className="fas fa-plus text-[10px]"></i>
        {t('addCondition')}
      </button>
    </div>
  )
}

function ConditionRow({
  cond,
  opMeta,
  fieldOptions,
  onPatch,
  onRemove,
}: {
  cond: RowCondition
  opMeta?: { value: RowOp; needValue: boolean; multi?: boolean }
  fieldOptions?: string[]
  onPatch: (patch: Partial<RowCondition>) => void
  onRemove: () => void
}) {
  const t = useTranslations('rbacConditionBuilder')
  // value 展示形式：In 用逗号分隔；标量直接显示
  const displayValue = useMemo(() => {
    if (Array.isArray(cond.value)) return cond.value.join(',')
    if (cond.value == null) return ''
    return String(cond.value)
  }, [cond.value])

  const setValueRaw = (raw: string) => {
    if (opMeta?.multi) {
      const items = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      onPatch({ value: items })
    } else {
      // 数字直接转 Number，避免后端比较 string vs i32
      const trimmed = raw.trim()
      if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        onPatch({ value: Number(trimmed) })
      } else {
        onPatch({ value: trimmed })
      }
    }
  }

  return (
    <li className="flex items-start gap-2 p-2 bg-gray-50 rounded border border-gray-200">
      {/* 字段 */}
      <div className="flex-1 min-w-0">
        {fieldOptions && fieldOptions.length > 0 ? (
          <input
            type="text"
            list="rbac-field-options"
            value={cond.field}
            onChange={(e) => onPatch({ field: e.target.value })}
            placeholder={t('phField')}
            className="input-base w-full text-xs h-8"
          />
        ) : (
          <input
            type="text"
            value={cond.field}
            onChange={(e) => onPatch({ field: e.target.value })}
            placeholder={t('phField')}
            className="input-base w-full text-xs h-8"
          />
        )}
        {fieldOptions && fieldOptions.length > 0 && (
          <datalist id="rbac-field-options">
            {fieldOptions.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        )}
      </div>

      {/* 操作符 */}
      <select
        value={cond.op}
        onChange={(e) => onPatch({ op: e.target.value as RowOp })}
        className="input-base text-xs h-8 w-28"
      >
        {OP_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {t(o.labelKey)}
          </option>
        ))}
      </select>

      {/* 值 */}
      <div className="flex-1 min-w-0">
        {opMeta?.needValue ? (
          <>
            <input
              type="text"
              list={`rbac-value-suggestions-${cond.field || 'x'}`}
              value={displayValue}
              onChange={(e) => setValueRaw(e.target.value)}
              placeholder={opMeta.multi ? t('phMulti') : t('phValue')}
              className="input-base w-full text-xs h-8"
            />
            <datalist id={`rbac-value-suggestions-${cond.field || 'x'}`}>
              {VALUE_SUGGESTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {t(s.labelKey)}
                </option>
              ))}
            </datalist>
          </>
        ) : (
          <span className="block text-xs text-gray-400 italic h-8 leading-8">
            {t('noValueNeeded')}
          </span>
        )}
      </div>

      {/* 删除 */}
      <button
        type="button"
        onClick={onRemove}
        className="text-gray-300 hover:text-red-500 h-8 px-1"
        title={t('removeCondition')}
      >
        <i className="fas fa-times"></i>
      </button>
    </li>
  )
}
