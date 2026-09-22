// M4：5 个开箱即用的 RBAC 权限模板
//
// 模板按下后 **填进 ConditionBuilder**，用户可继续微调再保存；不直接 POST，避免假定字段
// （如 department_id）一定存在于业务表。
//
// 字段名假设遵循 PlaneOS 命名约定：
// - `author_id` / `user_id` / `owner_id` — 数据归属人
// - `department_id` — 部门字段（如不存在，模板加载后用户改自己的字段）
// - `status` — 文章/订单等的发布态
//
// 不在前端硬编码 SQL 字符串，全部走结构化 RowCondition。

import type { RowCondition } from '@/lib/api'

export interface PermissionTemplate {
  id: string
  /** 短标签 key（按钮显示） */
  labelKey: string
  /** 一句话解释 key，drawer 内 tooltip / 提示框 */
  hintKey: string
  /** 模板适用的 action 建议（默认全部） */
  suggestedActions?: string[]
  /** 生成行级条件 */
  buildConditions: () => RowCondition[]
  /** 生成列级控制建议（可选） */
  buildColumns?: () => {
    mode: 'deny' | 'allow'
    allowed_columns: string[] | null
    denied_columns: string[]
  }
}

export const PERMISSION_TEMPLATES: PermissionTemplate[] = [
  {
    id: 'only_self',
    labelKey: 'tplOnlySelf',
    hintKey: 'hintOnlySelf',
    suggestedActions: ['SELECT', 'UPDATE', 'DELETE'],
    buildConditions: () => [
      { field: 'author_id', op: '=', value: '$current_user_id' },
    ],
  },
  {
    id: 'same_department',
    labelKey: 'tplSameDept',
    hintKey: 'hintSameDept',
    buildConditions: () => [
      { field: 'department_id', op: '=', value: '$current_user_department_id' },
    ],
  },
  {
    id: 'same_tenant',
    labelKey: 'tplSameTenant',
    hintKey: 'hintSameTenant',
    buildConditions: () => [],
  },
  {
    id: 'public_readonly',
    labelKey: 'tplPublicRo',
    hintKey: 'hintPublicRo',
    suggestedActions: ['SELECT'],
    buildConditions: () => [
      { field: 'status', op: '=', value: 'published' },
      { field: 'deleted_at', op: 'isnull' },
    ],
  },
  {
    id: 'deny_all',
    labelKey: 'tplDeny',
    hintKey: 'hintDeny',
    buildConditions: () => [
      // 1=2 形式无法走结构化 DSL；用 IsNull 配合一个一定为非空的字段
      // 这里用 id IS NULL 作为永远不命中的过滤（id 是 PK 永不空）
      { field: 'id', op: 'isnull' },
    ],
  },
]

/** 按 id 查 */
export function findTemplate(id: string): PermissionTemplate | undefined {
  return PERMISSION_TEMPLATES.find((t) => t.id === id)
}

/** 把 RowCondition 渲染成"人话"：用于矩阵 cell + 权限列表的紧凑显示 */
type CondTranslator = (key: string, params?: any) => string

export function describeCondition(cond: RowCondition, t: CondTranslator): string {
  const v = cond.value
  switch (cond.op) {
    case 'isnull':
      return t('condIsNull', { field: cond.field })
    case 'isnotnull':
      return t('condIsNotNull', { field: cond.field })
    case 'in':
      return t('condIn', { field: cond.field, vals: Array.isArray(v) ? v.join(', ') : String(v) })
    default:
      return t('condOp', { field: cond.field, op: cond.op, val: formatValue(v, t) })
  }
}

function formatValue(v: unknown, t: CondTranslator): string {
  if (v === '$current_user_id') return t('valCurrentUser')
  if (v === '$current_user_department_id') return t('valCurrentDept')
  if (typeof v === 'string') return `'${v}'`
  if (v == null) return t('valNull')
  return String(v)
}
