// M4：5 个开箱即用的 RBAC 权限模板
//
// 模板按下后 **填进 ConditionBuilder**，用户可继续微调再保存；不直接 POST，避免假定字段
// （如 department_id）一定存在于业务表。
//
// 字段名假设遵循 OneBase 命名约定：
// - `author_id` / `user_id` / `owner_id` — 数据归属人
// - `department_id` — 部门字段（如不存在，模板加载后用户改自己的字段）
// - `status` — 文章/订单等的发布态
//
// 不在前端硬编码 SQL 字符串，全部走结构化 RowCondition。

import type { RowCondition } from '@/lib/api'

export interface PermissionTemplate {
  id: string
  /** 短标签（按钮显示） */
  label: string
  /** 一句话解释，drawer 内 tooltip / 提示框 */
  hint: string
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
    label: '仅自己',
    hint: '用户只能访问自己创建的数据。要求表有 author_id 或 user_id 字段。',
    suggestedActions: ['SELECT', 'UPDATE', 'DELETE'],
    buildConditions: () => [
      { field: 'author_id', op: '=', value: '$current_user_id' },
    ],
  },
  {
    id: 'same_department',
    label: '同部门',
    hint: '用户能访问同部门数据。要求表有 department_id 字段；如无请改成业务字段。',
    buildConditions: () => [
      { field: 'department_id', op: '=', value: '$current_user_department_id' },
    ],
  },
  {
    id: 'same_tenant',
    label: '同租户',
    hint: '租户内全开放（默认行为）。一般用于覆盖更严的默认策略。',
    buildConditions: () => [],
  },
  {
    id: 'public_readonly',
    label: '公开只读',
    hint: '仅暴露已发布且未删除的数据。仅做 SELECT。',
    suggestedActions: ['SELECT'],
    buildConditions: () => [
      { field: 'status', op: '=', value: 'published' },
      { field: 'deleted_at', op: 'isnull' },
    ],
  },
  {
    id: 'deny_all',
    label: '禁止',
    hint: '完全禁止该资源 × 动作。用恒不成立条件实现。',
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
export function describeCondition(cond: RowCondition): string {
  const v = cond.value
  switch (cond.op) {
    case 'isnull':
      return `${cond.field} 为空`
    case 'isnotnull':
      return `${cond.field} 非空`
    case 'in':
      return `${cond.field} ∈ [${Array.isArray(v) ? v.join(', ') : v}]`
    case '=':
    case '!=':
    case '>':
    case '>=':
    case '<':
    case '<=':
      return `${cond.field} ${cond.op} ${formatValue(v)}`
    default:
      return `${cond.field} ${cond.op} ${formatValue(v)}`
  }
}

function formatValue(v: unknown): string {
  if (v === '$current_user_id') return '当前用户'
  if (v === '$current_user_department_id') return '当前部门'
  if (typeof v === 'string') return `'${v}'`
  if (v == null) return '∅'
  return String(v)
}
