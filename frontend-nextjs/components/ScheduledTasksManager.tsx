'use client'

/**
 * 定时任务（Scheduled Tasks）管理组件 —— 平台级 / 租户级共用。
 *
 * 通过 `lockedTenantId` 控制两种使用场景：
 *   - `undefined`（默认）：平台模式（仅超管能进入对应的 `/platform/*` 入口），
 *     租户下拉可任选，留空 = 平台级任务。
 *   - `number`：租户模式（嵌在 `/dashboard/*` 内），强制 `tenant_id` 锁定到
 *     当前项目，列表只显示该租户的任务，UI 上**完全隐藏**租户选择器，
 *     避免用户在"已选项目"上下文里被迫再选一次。
 *
 * 表单里的 `tenant_id` / `database_id` / `schema` / `函数名` 都改成了下拉：
 *   - 租户：来自 `tenantAPI.getMyConnections()`（按 user 可见的去重后渲染）
 *   - 数据库：按选中租户从同一份连接列表过滤
 *   - schema / 函数：按选中数据库的 `X-Database-Id` 头打到 `/api/schemas` 与
 *     `/query`（注意：interceptor 已被改为不覆盖 caller 显式传入的 header）
 *
 * 后端接口见 `lib/api.ts::scheduledTaskAPI`，spec：
 * `docs/superpowers/specs/2026-05-14-scheduled-tasks-design.md`
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  scheduledTaskAPI,
  tenantAPI,
  type ScheduledTask,
  type ScheduledTaskRun,
  type ScheduledTaskStats,
  type CreateScheduledTaskInput,
  type CronValidationResult,
} from '@/lib/api'
import { useNotification } from '@/hooks/useNotification'
import { useAppStore } from '@/lib/store'
import { useEffectiveRole } from '@/lib/permissions'

interface ScheduledTasksManagerProps {
  /**
   * 锁定到某个租户的 ID：
   *   - 传 `number` → 租户模式（dashboard 内使用，隐藏租户选择器并固定 tenant_id）
   *   - 不传 / `undefined` → 平台模式（platform 内使用，渲染租户下拉）
   *
   * 显式区分"未传" vs "传 null"：不允许 null（要表达"平台级"任务，请在
   * 平台模式下用下拉里的"平台级"选项；租户模式从语义上就不该创建平台级任务）。
   */
  lockedTenantId?: number
}

// 来自 /api/tenants/my-connections 的一行连接信息。
// 后端返回 user_id / username / tenant_id / tenant_name / database_id /
// connection_name / db_host / db_port / db_name / is_primary / user_role。
interface ConnRow {
  user_id: number
  username: string
  tenant_id: number
  tenant_name: string
  database_id: number
  connection_name: string
  db_host: string
  db_port: number
  db_name: string
  is_primary: boolean
  user_role: string
}

type FormState = {
  tenant_id: string
  name: string
  description: string
  cron_expr: string
  timezone: string
  kind: 'rpc' | 'http' | 'shell'
  database_id: string
  rpc_schema: string
  rpc_fn_name: string
  rpc_args: string
  http_method: string
  http_url: string
  http_headers: string
  http_body: string
  http_secret: string
  // shell 字段（kind='shell' 时启用，其它 kind 留空被忽略）
  shell_interpreter: string
  shell_script: string
  shell_env: string
  shell_cwd: string
  timeout_secs: number
  max_retries: number
  overlap_policy: 'skip' | 'allow'
  alert_webhook_url: string
  alert_webhook_template: string
  alert_throttle_hours: number
}

const DEFAULT_ALERT_WEBHOOK_TEMPLATE = JSON.stringify(
  {
    msg_type: 'markdown',
    content:
      '### 🚨 报警\n- **类型**: {{source}}\n- **名称**: {{name}}\n- **状态**: {{status}}\n- **错误**: {{error}}\n- **时间**: {{time}}\n- **Run ID**: {{run_id}}',
  },
  null,
  2,
)

const EMPTY_FORM: FormState = {
  tenant_id: '',
  name: '',
  description: '',
  cron_expr: '0 */6 * * *',
  timezone: 'UTC',
  kind: 'http',
  database_id: '',
  rpc_schema: 'public',
  rpc_fn_name: '',
  rpc_args: '{}',
  http_method: 'POST',
  http_url: '',
  http_headers: '{}',
  http_body: '{}',
  http_secret: '',
  shell_interpreter: '/bin/sh',
  shell_script: '',
  shell_env: '{}',
  shell_cwd: '',
  timeout_secs: 60,
  max_retries: 0,
  overlap_policy: 'skip',
  alert_webhook_url: '',
  alert_webhook_template: DEFAULT_ALERT_WEBHOOK_TEMPLATE,
  alert_throttle_hours: 24,
}

/** 后端 ShellExecutor 接受的解释器白名单（与 src/scheduler/executors.rs 同步）。 */
const SHELL_INTERPRETERS = ['/bin/sh', '/bin/bash', '/bin/dash', '/bin/zsh', '/usr/bin/python3', '/usr/bin/node', '/usr/bin/ruby']

const CRON_PRESETS: { label: string; value: string }[] = [
  { label: '每分钟', value: '* * * * *' },
  { label: '每 5 分钟', value: '*/5 * * * *' },
  { label: '每小时整', value: '0 * * * *' },
  { label: '每 6 小时', value: '0 */6 * * *' },
  { label: '每天 00:00', value: '0 0 * * *' },
  { label: '每周一 02:00', value: '0 2 * * 1' },
]

const COMMON_TIMEZONES = [
  'UTC',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Europe/London',
  'Europe/Paris',
  'America/New_York',
  'America/Los_Angeles',
]

function formatDateTime(s: string | null | undefined): string {
  if (!s) return '—'
  try {
    return new Date(s).toLocaleString()
  } catch {
    return s
  }
}

function statusColor(status: string | null | undefined): string {
  switch (status) {
    case 'success':
      return 'bg-green-100 text-green-700'
    case 'failed':
      return 'bg-red-100 text-red-700'
    case 'timeout':
      return 'bg-orange-100 text-orange-700'
    case 'cancelled':
      return 'bg-gray-100 text-gray-600'
    case 'running':
      return 'bg-blue-100 text-blue-700'
    default:
      return 'bg-gray-100 text-gray-500'
  }
}

export default function ScheduledTasksManager({
  lockedTenantId,
}: ScheduledTasksManagerProps) {
  const notify = useNotification()
  const tenantMode = lockedTenantId !== undefined
  // shell kind 自 migration 017 起允许租户级：
  //   - 平台模式（!tenantMode）→ 仍只对平台超管可见
  //   - 租户模式（tenantMode）  → 对当前租户的 owner/admin 可见
  // 后端 handler 的 validate_can_manage 在创建时仍会做权威校验，UI 这里隐藏只
  // 是降低无意义的"看到了但建不出来"。
  const currentUser = useAppStore((s) => s.currentUser)
  const isSuperadmin = !!currentUser?.is_superadmin
  const { isTenantAdmin } = useEffectiveRole()
  const shellAvailable = tenantMode ? isTenantAdmin : isSuperadmin

  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [loading, setLoading] = useState(false)
  const [stats, setStats] = useState<ScheduledTaskStats | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<ScheduledTask | null>(null)
  const [alertOpen, setAlertOpen] = useState(false)
  const [form, setForm] = useState<FormState>(() => ({
    ...EMPTY_FORM,
    tenant_id: tenantMode ? String(lockedTenantId) : '',
  }))
  const [cronPreview, setCronPreview] = useState<CronValidationResult | null>(null)
  const [cronError, setCronError] = useState<string | null>(null)
  const [filterKind, setFilterKind] = useState<'all' | 'rpc' | 'http' | 'shell'>('all')
  const [filterActive, setFilterActive] = useState<'all' | 'on' | 'off'>('all')

  // 下拉数据：tenant / database 来自 my-connections；schema / function 按需懒取
  const [connections, setConnections] = useState<ConnRow[]>([])
  const [schemaList, setSchemaList] = useState<string[]>([])
  const [schemaLoading, setSchemaLoading] = useState(false)
  const [functionList, setFunctionList] = useState<
    Array<{ schema_name: string; function_name: string; argument_types: string }>
  >([])
  const [functionLoading, setFunctionLoading] = useState(false)

  // run history drawer
  const [runsTask, setRunsTask] = useState<ScheduledTask | null>(null)
  const [runs, setRuns] = useState<ScheduledTaskRun[]>([])
  const [runsLoading, setRunsLoading] = useState(false)

  // 当前 form 选中的 tenant 数字（平台级 = NaN）。NaN 时 db 下拉显示"全部"
  // —— 仅 platform 模式且用户尚未挑租户时会出现这种状态。
  const selectedTenantNum = useMemo(() => {
    const v = form.tenant_id.trim()
    if (!v) return null
    const n = parseInt(v, 10)
    return Number.isFinite(n) ? n : null
  }, [form.tenant_id])

  // ─────────────────── 数据加载 ───────────────────

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, unknown> = {}
      if (filterKind !== 'all') params.kind = filterKind
      if (filterActive !== 'all') params.is_active = filterActive === 'on'
      // tenantMode：只看当前租户；platform 模式不加 tenant_id 过滤（看全部）。
      if (tenantMode) params.tenant_id = lockedTenantId
      const res = await scheduledTaskAPI.list(params)
      setTasks(res.data || [])
    } catch (err) {
      // 全局拦截器已弹 toast；此处沉默。
    } finally {
      setLoading(false)
    }
  }, [filterKind, filterActive, tenantMode, lockedTenantId])

  const loadStats = useCallback(async () => {
    try {
      const res = await scheduledTaskAPI.stats()
      setStats(res.data)
    } catch {
      // 仅超管可访问；非超管会 403，正常 ignore。
      setStats(null)
    }
  }, [])

  // 一次性把可见的连接列表拉过来：表单要用、列表的展示名也要用。
  // tenantMode（项目内）只取本租户连接；platform 模式（超管）取全部可见。
  const loadConnections = useCallback(async () => {
    try {
      const res = await tenantAPI.getMyConnections(tenantMode ? lockedTenantId : undefined)
      const rows = (res.data || []) as ConnRow[]
      setConnections(rows)
    } catch {
      setConnections([])
    }
  }, [tenantMode, lockedTenantId])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    loadStats()
  }, [loadStats])

  useEffect(() => {
    loadConnections()
  }, [loadConnections])

  // cron 实时校验（debounce 400ms）
  useEffect(() => {
    if (!form.cron_expr) {
      setCronPreview(null)
      setCronError(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const res = await scheduledTaskAPI.validateCron(form.cron_expr, form.timezone)
        if (!cancelled) {
          setCronPreview(res.data)
          setCronError(null)
        }
      } catch (err: any) {
        if (!cancelled) {
          setCronPreview(null)
          setCronError(err?.response?.data?.error || 'cron 表达式或时区无效')
        }
      }
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [form.cron_expr, form.timezone])

  // database_id 改变 → 拉 schema 列表；同时清空旧 schema/fn 选择（避免错配）。
  // editing 模式下不主动重拉（用户已经看到原值），但仍然让 select 显示原值。
  useEffect(() => {
    const dbIdNum = form.database_id ? parseInt(form.database_id, 10) : NaN
    if (!Number.isFinite(dbIdNum)) {
      setSchemaList([])
      return
    }
    let cancelled = false
    setSchemaLoading(true)
    scheduledTaskAPI
      .listSchemasForDb(dbIdNum)
      .then((res) => {
        if (cancelled) return
        setSchemaList((res.data || []).map((s) => s.schema_name))
      })
      .catch(() => {
        if (!cancelled) setSchemaList([])
      })
      .finally(() => {
        if (!cancelled) setSchemaLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [form.database_id])

  // (database_id, rpc_schema) 改变 → 拉函数列表
  useEffect(() => {
    const dbIdNum = form.database_id ? parseInt(form.database_id, 10) : NaN
    if (!Number.isFinite(dbIdNum) || !form.rpc_schema) {
      setFunctionList([])
      return
    }
    let cancelled = false
    setFunctionLoading(true)
    scheduledTaskAPI
      .listFunctionsForDb(dbIdNum, form.rpc_schema)
      .then((res) => {
        if (cancelled) return
        const rows = (res.data?.data || []).filter((r) => !r.extension_name) // 隐藏扩展自带函数
        setFunctionList(
          rows.map((r) => ({
            schema_name: r.schema_name,
            function_name: r.function_name,
            argument_types: r.argument_types,
          })),
        )
      })
      .catch(() => {
        if (!cancelled) setFunctionList([])
      })
      .finally(() => {
        if (!cancelled) setFunctionLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [form.database_id, form.rpc_schema])

  // ─────────────────── 下拉数据派生 ───────────────────

  /** 唯一租户列表（按 tenant_id 去重；保持 backend 顺序）。 */
  const tenantOptions = useMemo(() => {
    const seen = new Map<number, { id: number; name: string }>()
    for (const c of connections) {
      if (!seen.has(c.tenant_id)) {
        seen.set(c.tenant_id, { id: c.tenant_id, name: c.tenant_name })
      }
    }
    return Array.from(seen.values())
  }, [connections])

  /**
   * 当前应展示的 database 候选：
   *   - tenantMode：固定按 lockedTenantId 过滤
   *   - platform 模式：按 form 内选中的 tenant 过滤；平台级（tenant_id 留空）
   *     时没有 tenant 归属 → 候选为空（按 schema：tenant_databases.tenant_id
   *     可为 NULL，但 my-connections 视图只返回挂在某 tenant 下的连接）。
   *   - 编辑模式下若 task 原 database_id 不在候选里（例如用户没有权限再看到），
   *     补一条占位选项，避免显示空白。
   */
  const databaseOptions = useMemo(() => {
    const filterTid = tenantMode ? lockedTenantId : selectedTenantNum
    const list = connections
      .filter((c) => filterTid != null && c.tenant_id === filterTid)
      .map((c) => ({
        id: c.database_id,
        label: `${c.connection_name || c.db_name} (${c.db_host}:${c.db_port}/${c.db_name})${
          c.is_primary ? ' · 主' : ''
        }`,
      }))
    // 去重（同一 db 可能在多 user_role 下重复）
    const seen = new Map<number, { id: number; label: string }>()
    for (const r of list) if (!seen.has(r.id)) seen.set(r.id, r)
    const result = Array.from(seen.values())
    if (
      editing &&
      editing.database_id != null &&
      !result.some((r) => r.id === editing.database_id)
    ) {
      result.unshift({ id: editing.database_id, label: `db#${editing.database_id}（无访问权限）` })
    }
    return result
  }, [connections, tenantMode, lockedTenantId, selectedTenantNum, editing])

  /** 列表展示用：tenant_id → name；缺失时退化成 "#<id>"。 */
  const tenantNameById = useMemo(() => {
    const m = new Map<number, string>()
    for (const t of tenantOptions) m.set(t.id, t.name)
    return m
  }, [tenantOptions])

  /** 列表展示用：database_id → label。 */
  const databaseLabelById = useMemo(() => {
    const m = new Map<number, string>()
    for (const c of connections) {
      if (!m.has(c.database_id)) {
        m.set(c.database_id, c.connection_name || c.db_name)
      }
    }
    return m
  }, [connections])

  // ─────────────────── 表单 ───────────────────

  const resetForm = () => {
    setForm({
      ...EMPTY_FORM,
      tenant_id: tenantMode ? String(lockedTenantId) : '',
    })
    setEditing(null)
    setAlertOpen(false)
    setCronPreview(null)
    setCronError(null)
    setDryRunResult(null)
  }

  const startEdit = (task: ScheduledTask) => {
    setEditing(task)
    setAlertOpen(!!(task.alert_webhook_url ?? '').trim())
    setForm({
      tenant_id: task.tenant_id?.toString() ?? '',
      name: task.name,
      description: task.description ?? '',
      cron_expr: task.cron_expr,
      timezone: task.timezone,
      kind: task.kind,
      database_id: task.database_id?.toString() ?? '',
      rpc_schema: task.rpc_schema ?? 'public',
      rpc_fn_name: task.rpc_fn_name ?? '',
      rpc_args: JSON.stringify(task.rpc_args ?? {}, null, 2),
      http_method: task.http_method ?? 'POST',
      http_url: task.http_url ?? '',
      http_headers: JSON.stringify(task.http_headers ?? {}, null, 2),
      http_body: JSON.stringify(task.http_body ?? {}, null, 2),
      http_secret: '', // 永远不回填明文
      shell_interpreter: task.shell_interpreter ?? '/bin/sh',
      shell_script: task.shell_script ?? '',
      shell_env: JSON.stringify(task.shell_env ?? {}, null, 2),
      shell_cwd: task.shell_cwd ?? '',
      timeout_secs: task.timeout_secs,
      max_retries: task.max_retries,
      overlap_policy: (task.overlap_policy as 'skip' | 'allow') ?? 'skip',
      alert_webhook_url: task.alert_webhook_url ?? '',
      alert_webhook_template: JSON.stringify(
        task.alert_webhook_template ?? JSON.parse(DEFAULT_ALERT_WEBHOOK_TEMPLATE),
        null,
        2,
      ),
      alert_throttle_hours: task.alert_throttle_hours ?? 24,
    })
    setShowForm(true)
  }

  const parseJsonField = (raw: string, label: string): Record<string, unknown> | null => {
    const trimmed = raw.trim()
    if (!trimmed) return {}
    try {
      const parsed = JSON.parse(trimmed)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        notify.error(`${label} 必须是 JSON 对象`)
        return null
      }
      return parsed as Record<string, unknown>
    } catch {
      notify.error(`${label} JSON 解析失败`)
      return null
    }
  }

  /**
   * 从当前 form state 构建出 create-shape 的 payload + 衍生字段。
   * 任一字段校验失败（必填空 / JSON 解析 / cron）就 toast + 返回 null，调用方应直接 return。
   *
   * 返回值同时供"保存"和"试运行"使用 —— dry-run 直接拿 payload 打 /dry-run；
   * 保存路径里如果是 update 还要把 payload 拆成 UpdateScheduledTaskInput（kind 不可变）。
   */
  const buildCreatePayload = (): CreateScheduledTaskInput | null => {
    if (!form.name.trim()) {
      notify.error('请填写任务名称')
      return null
    }
    if (cronError) {
      notify.error('cron 表达式无效，请先修正')
      return null
    }
    if (tenantMode && !form.tenant_id.trim()) {
      notify.error('当前项目上下文缺失 tenant_id；请刷新页面后重试')
      return null
    }

    let rpcArgs: Record<string, unknown> | null = {}
    let httpHeaders: Record<string, unknown> | null = {}
    let httpBody: unknown = {}
    let shellEnv: Record<string, unknown> | null = {}
    let alertTemplate: Record<string, unknown> | null = null
    if (form.kind === 'rpc') {
      rpcArgs = parseJsonField(form.rpc_args, 'rpc_args')
      if (rpcArgs === null) return null
    } else if (form.kind === 'http') {
      httpHeaders = parseJsonField(form.http_headers, 'http_headers')
      if (httpHeaders === null) return null
      const bodyTrim = form.http_body.trim()
      if (bodyTrim) {
        try {
          httpBody = JSON.parse(bodyTrim)
        } catch {
          notify.error('http_body JSON 解析失败')
          return null
        }
      } else {
        httpBody = null
      }
    } else if (form.kind === 'shell') {
      if (!form.shell_script.trim()) {
        notify.error('请填写 shell 脚本内容')
        return null
      }
      shellEnv = parseJsonField(form.shell_env, 'shell_env')
      if (shellEnv === null) return null
    }
    if (form.alert_webhook_url.trim()) {
      alertTemplate = parseJsonField(form.alert_webhook_template, '告警 Webhook 模板')
      if (alertTemplate === null) return null
    }

    const tenantIdNum = form.tenant_id.trim() ? parseInt(form.tenant_id, 10) : null
    const databaseIdNum = form.database_id.trim() ? parseInt(form.database_id, 10) : undefined

    const payload: CreateScheduledTaskInput = {
      // tenant_id 跟随 form：
      //   - 平台模式 → 用户在租户下拉选的值（留空 = 平台级；shell 任务在此模式下仍是平台级）
      //   - 租户模式 → 由 lockedTenantId 写入（含 kind='shell'，自 migration 017 开放）
      // 早先这里对 shell 强制写 null 是因为 DB chk_st_shell_platform_only 不允许租户级
      // shell；017 删了那道约束后不需要再"代办清空"了。
      tenant_id: tenantIdNum,
      name: form.name,
      description: form.description || undefined,
      cron_expr: form.cron_expr,
      timezone: form.timezone,
      kind: form.kind,
      timeout_secs: form.timeout_secs,
      max_retries: form.max_retries,
      overlap_policy: form.overlap_policy,
      alert_webhook_url: form.alert_webhook_url.trim() || null,
      alert_webhook_template: form.alert_webhook_url.trim() ? alertTemplate : null,
      alert_throttle_hours: form.alert_throttle_hours,
    }
    if (form.kind === 'rpc') {
      payload.database_id = databaseIdNum
      payload.rpc_schema = form.rpc_schema || 'public'
      payload.rpc_fn_name = form.rpc_fn_name
      payload.rpc_args = rpcArgs ?? {}
    } else if (form.kind === 'http') {
      payload.http_method = form.http_method
      payload.http_url = form.http_url
      payload.http_headers = httpHeaders ?? {}
      payload.http_body = httpBody
      if (form.http_secret.trim()) payload.http_secret = form.http_secret
    } else if (form.kind === 'shell') {
      payload.shell_interpreter = form.shell_interpreter || undefined
      payload.shell_script = form.shell_script
      payload.shell_env = shellEnv ?? {}
      if (form.shell_cwd.trim()) payload.shell_cwd = form.shell_cwd
    }
    return payload
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const payload = buildCreatePayload()
    if (!payload) return

    try {
      if (editing) {
        // update 不接受 tenant_id / kind / database_id / rpc_schema / rpc_fn_name
        // / http_method（这些字段在创建后视为不可变），所以只挑可改的下发。
        // http_url 允许修改（上游服务搬家场景）。
        await scheduledTaskAPI.update(editing.id, {
          name: payload.name,
          description: payload.description,
          cron_expr: payload.cron_expr,
          timezone: payload.timezone,
          rpc_args: payload.rpc_args,
          http_url: payload.http_url,
          http_headers: payload.http_headers,
          http_body: payload.http_body,
          http_secret: payload.http_secret,
          shell_interpreter: payload.shell_interpreter,
          shell_script: payload.shell_script,
          shell_env: payload.shell_env,
          shell_cwd: payload.shell_cwd,
          timeout_secs: payload.timeout_secs,
          max_retries: payload.max_retries,
          overlap_policy: payload.overlap_policy,
          alert_webhook_url: payload.alert_webhook_url,
          alert_webhook_template: payload.alert_webhook_template,
          alert_throttle_hours: payload.alert_throttle_hours,
        })
        notify.success('任务已更新')
      } else {
        await scheduledTaskAPI.create(payload)
        notify.success('任务已创建')
      }
      setShowForm(false)
      resetForm()
      load()
      loadStats()
    } catch {
      // 全局拦截器已弹错误。
    }
  }

  // ── 试运行 ──
  //
  // 不走 onSubmit（form 的默认提交事件容易误触发），单独一个按钮点击 → 直接调
  // /api/admin/scheduled-tasks/dry-run。dryRunResult 仅 in-memory：关掉表单或切换
  // 任务就丢，不需要持久化。
  const [dryRunning, setDryRunning] = useState(false)
  const [dryRunResult, setDryRunResult] = useState<
    | null
    | {
        status: 'success' | 'failed' | 'timeout'
        output: unknown
        error_message: string | null
        duration_ms: number
      }
  >(null)

  const handleDryRun = async () => {
    const payload = buildCreatePayload()
    if (!payload) return
    setDryRunning(true)
    setDryRunResult(null)
    try {
      const res = await scheduledTaskAPI.dryRun(payload)
      // 后端可能返回 status: 'failed' / 'timeout'，HTTP 仍然是 200 —— 这是设计意图：
      // dry-run **不会** 把"业务失败"当 HTTP 错误抛，否则 axios 全局拦截器就会弹 toast，
      // 用户看到的是"网络错误"而不是"脚本退出码 7"。
      setDryRunResult({
        status: res.data.status,
        output: res.data.output,
        error_message: res.data.error_message,
        duration_ms: res.data.duration_ms,
      })
    } catch (err: any) {
      // 鉴权失败 / 入参不合法等真·HTTP 错误：手动展示，不依赖全局 toast（已 suppressed）
      const msg = err?.response?.data?.error || err?.message || '试运行请求失败'
      setDryRunResult({
        status: 'failed',
        output: null,
        error_message: msg,
        duration_ms: 0,
      })
    } finally {
      setDryRunning(false)
    }
  }

  const handleDelete = async (task: ScheduledTask) => {
    if (!confirm(`确认删除任务「${task.name}」？执行历史会一并清除。`)) return
    try {
      await scheduledTaskAPI.delete(task.id)
      notify.success('已删除')
      load()
      loadStats()
    } catch {
      /* noop */
    }
  }

  const handleToggle = async (task: ScheduledTask) => {
    try {
      if (task.is_active) await scheduledTaskAPI.pause(task.id)
      else await scheduledTaskAPI.resume(task.id)
      load()
    } catch {
      /* noop */
    }
  }

  const handleRunNow = async (task: ScheduledTask) => {
    try {
      await scheduledTaskAPI.runNow(task.id)
      notify.success(`「${task.name}」已派发执行；几秒后可在执行历史里看结果`)
      setTimeout(() => {
        if (runsTask?.id === task.id) loadRuns(task)
        load()
      }, 1500)
    } catch {
      /* noop */
    }
  }

  const loadRuns = async (task: ScheduledTask) => {
    setRunsLoading(true)
    try {
      const res = await scheduledTaskAPI.listRuns(task.id, { limit: 50 })
      setRuns(res.data || [])
    } catch {
      /* noop */
    } finally {
      setRunsLoading(false)
    }
  }

  const openRuns = (task: ScheduledTask) => {
    setRunsTask(task)
    setRuns([])
    loadRuns(task)
  }

  const closeRuns = () => {
    setRunsTask(null)
    setRuns([])
  }

  const handleCleanupZombies = async () => {
    const hours = window.prompt('清理停留在 running 状态超过多少小时的执行记录？（默认 24）', '24')
    if (hours === null) return
    const n = parseInt(hours, 10)
    if (!Number.isFinite(n) || n < 1) {
      notify.error('请输入 ≥1 的正整数')
      return
    }
    try {
      const res = await scheduledTaskAPI.cleanupZombies(n)
      notify.success(`已清理 ${res.data.cleaned} 条僵尸 run`)
    } catch {
      /* noop */
    }
  }

  const filteredTasks = useMemo(
    () => (tenantMode ? tasks.filter((t) => t.tenant_id === lockedTenantId) : tasks),
    [tasks, tenantMode, lockedTenantId],
  )

  return (
    <div className="space-y-6">
      {/* 标题 + 操作区 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">定时任务</h1>
          <p className="text-sm text-gray-500 mt-1">
            {tenantMode
              ? '本项目内按 cron 表达式调用 PG 函数（RPC）或发起 HTTP 请求；多实例自动去重。'
              : '按 cron 表达式调用 PG 函数（RPC）或发起 HTTP 请求；多实例自动去重。'}
          </p>
        </div>
        <div className="flex items-center space-x-2">
          {stats && (
            <button onClick={handleCleanupZombies} className="btn-default text-xs">
              <i className="fas fa-broom mr-1"></i>清理僵尸 run
            </button>
          )}
          <button
            onClick={() => {
              if (showForm) resetForm()
              setShowForm(!showForm)
            }}
            className="btn-primary"
          >
            <i className={`fas ${showForm ? 'fa-times' : 'fa-plus'} text-xs mr-2`}></i>
            {showForm ? '取消' : '新建任务'}
          </button>
        </div>
      </div>

      {/* 超管统计 */}
      {stats && (
        <div className="grid grid-cols-4 gap-3">
          <StatCard label="任务总数" value={stats.total_tasks} />
          <StatCard label="启用中" value={stats.active_tasks} />
          <StatCard label="24h 执行次数" value={stats.runs_24h} />
          <StatCard
            label="24h 失败 / 超时"
            value={stats.failed_24h}
            danger={stats.failed_24h > 0}
          />
        </div>
      )}

      {/* 表单区 */}
      {showForm && (
        <div className="card p-6">
          <h2 className="text-lg font-semibold mb-4">{editing ? `编辑：${editing.name}` : '新建任务'}</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField label="名称 *">
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="input-base w-full"
                  required
                />
              </FormField>
              {/* 租户选择器：仅 platform 模式可见；tenant 模式由 lockedTenantId 强制锁定 */}
              {!tenantMode && (
                <FormField
                  label="租户"
                  hint={editing ? '编辑模式下不允许迁移租户归属' : '留空 = 平台级任务（仅超管可见）'}
                >
                  <select
                    value={form.tenant_id}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        tenant_id: e.target.value,
                        // 切换 tenant 会让原先选中的 database 无效，主动清空避免错配
                        database_id: '',
                        rpc_schema: 'public',
                        rpc_fn_name: '',
                      })
                    }
                    className="input-base w-full"
                    disabled={!!editing}
                  >
                    <option value="">— 平台级（仅超管）—</option>
                    {tenantOptions.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}（#{t.id}）
                      </option>
                    ))}
                  </select>
                </FormField>
              )}
            </div>

            <FormField label="描述">
              <textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                className="input-base w-full"
                rows={2}
              />
            </FormField>

            {/* cron 区块 */}
            <div className="grid grid-cols-3 gap-4">
              <FormField label="cron 表达式 *" className="col-span-2">
                <div className="flex items-center space-x-2">
                  <input
                    type="text"
                    value={form.cron_expr}
                    onChange={(e) => setForm({ ...form, cron_expr: e.target.value })}
                    className="input-base flex-1 font-mono"
                    placeholder="* * * * * (5 字段 cron)"
                    required
                  />
                  {/*
                    预设下拉与 cron_expr 双向绑定，避免选完立刻回弹到 placeholder
                    的迷惑感。三种状态：
                      - 命中预设：直接显示预设名（受控 value 命中其中一个 option）
                      - 用户手敲自定义：插一条隐藏的"自定义：xxx"作为当前选中项
                      - 空：显示"选预设…"占位
                    onChange 里仍只在 value 非空时回写，保护"选回 placeholder"不会
                    把 cron_expr 误清空。
                  */}
                  <select
                    value={form.cron_expr}
                    onChange={(e) => {
                      if (e.target.value) setForm({ ...form, cron_expr: e.target.value })
                    }}
                    className="input-base"
                  >
                    {!CRON_PRESETS.some((p) => p.value === form.cron_expr) && (
                      <option value={form.cron_expr}>
                        {form.cron_expr ? `自定义：${form.cron_expr}` : '选预设…'}
                      </option>
                    )}
                    {CRON_PRESETS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
              </FormField>
              <FormField label="时区">
                <select
                  value={form.timezone}
                  onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                  className="input-base w-full"
                >
                  {COMMON_TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>

            {/* cron 预览 */}
            {cronError && (
              <div className="text-xs text-red-600 bg-red-50 p-2 rounded border border-red-100">
                <i className="fas fa-exclamation-triangle mr-1"></i>{cronError}
              </div>
            )}
            {cronPreview && (
              <div className="text-xs text-gray-600 bg-blue-50 p-3 rounded border border-blue-100">
                <div className="font-medium text-blue-800 mb-1">
                  接下来 5 次触发（{cronPreview.timezone}）：
                </div>
                <ul className="list-disc list-inside space-y-0.5 font-mono text-gray-700">
                  {cronPreview.preview.map((t, i) => (
                    <li key={i}>{new Date(t).toLocaleString()}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* kind 区分 */}
            <div className="grid grid-cols-2 gap-4">
              <FormField
                label="任务类型 *"
                hint={
                  shellAvailable
                    ? tenantMode
                      ? 'shell 以服务进程身份在本租户上下文执行，已默认走 bwrap 沙盒；解释器走白名单，env 不会泄露 onebase 自身 secret'
                      : 'shell 在平台级模式下对超管开放；以服务进程身份执行，已默认走 bwrap 沙盒'
                    : undefined
                }
              >
                <select
                  value={form.kind}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      kind: e.target.value as 'rpc' | 'http' | 'shell',
                    })
                  }
                  className="input-base w-full"
                  disabled={!!editing}
                >
                  <option value="http">HTTP 请求</option>
                  <option value="rpc">PG 函数（RPC）</option>
                  {/* shell 选项：
                      - 平台模式 → 仅平台超管
                      - 租户模式 → 当前租户的 owner/admin
                      编辑既有 shell 任务时即便条件不满足也补一条 option 让 select 不闪烁 */}
                  {(shellAvailable || (editing && editing.kind === 'shell')) && (
                    <option value="shell">
                      Shell 脚本{tenantMode ? '（本租户）' : '（平台级 / 超管）'}
                    </option>
                  )}
                </select>
              </FormField>
              <FormField label="overlap_policy（上次未结束又到点了怎么办）">
                <select
                  value={form.overlap_policy}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      overlap_policy: e.target.value as 'skip' | 'allow',
                    })
                  }
                  className="input-base w-full"
                >
                  <option value="skip">skip — 跳过本次</option>
                  <option value="allow">allow — 并发触发</option>
                </select>
              </FormField>
            </div>

            {/* kind=rpc 字段 */}
            {form.kind === 'rpc' && (
              <div className="space-y-3 border-l-2 border-purple-200 pl-4">
                <div className="grid grid-cols-3 gap-4">
                  <FormField
                    label="数据库 *"
                    hint={
                      !tenantMode && selectedTenantNum == null
                        ? '请先选择租户'
                        : databaseOptions.length === 0
                          ? '当前租户下无可用数据库'
                          : undefined
                    }
                  >
                    <select
                      value={form.database_id}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          database_id: e.target.value,
                          rpc_schema: 'public',
                          rpc_fn_name: '',
                        })
                      }
                      className="input-base w-full"
                      disabled={
                        !!editing ||
                        databaseOptions.length === 0 ||
                        (!tenantMode && selectedTenantNum == null)
                      }
                      required
                    >
                      <option value="">— 选择数据库 —</option>
                      {databaseOptions.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <FormField
                    label="schema"
                    hint={
                      schemaLoading
                        ? '加载中…'
                        : !form.database_id
                          ? '请先选择数据库'
                          : schemaList.length === 0
                            ? '该库没有可见 schema'
                            : undefined
                    }
                  >
                    <select
                      value={form.rpc_schema}
                      onChange={(e) =>
                        setForm({ ...form, rpc_schema: e.target.value, rpc_fn_name: '' })
                      }
                      className="input-base w-full"
                      disabled={!!editing || !form.database_id || schemaList.length === 0}
                    >
                      {/* 若 schemaList 不含当前值，至少把当前值也展示出来（保持编辑兼容） */}
                      {!schemaList.includes(form.rpc_schema) && form.rpc_schema && (
                        <option value={form.rpc_schema}>{form.rpc_schema}</option>
                      )}
                      {schemaList.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <FormField
                    label="函数名 *"
                    hint={
                      functionLoading
                        ? '加载中…'
                        : !form.rpc_schema || !form.database_id
                          ? '请先选择 schema'
                          : functionList.length === 0
                            ? '该 schema 下无函数'
                            : undefined
                    }
                  >
                    <select
                      value={form.rpc_fn_name}
                      onChange={(e) => setForm({ ...form, rpc_fn_name: e.target.value })}
                      className="input-base w-full"
                      disabled={!!editing || functionList.length === 0}
                      required
                    >
                      <option value="">— 选择函数 —</option>
                      {/* 编辑兼容：若当前值不在拉取结果里，先填一条 */}
                      {form.rpc_fn_name &&
                        !functionList.some((f) => f.function_name === form.rpc_fn_name) && (
                          <option value={form.rpc_fn_name}>
                            {form.rpc_fn_name}（已保存）
                          </option>
                        )}
                      {/*
                        key 必须用 `function_name + argument_types` 而不是单独的
                        `function_name`：PG 允许同名不同参的重载（如
                        `refresh_recommendation_pool(p_limit integer)` 与
                        `refresh_recommendation_pool(p_limit bigint)`），用纯
                        function_name 当 key 时 React 会因为 duplicate key 只渲
                        染一条，用户在 UI 上看不到所有重载的存在。
                        option value 仍然是 function_name —— 后端走 rpc.rs 的
                        resolve_overload 按 JSON 实参类型自动挑最匹配的重载。
                      */}
                      {functionList.map((f, idx) => (
                        <option
                          key={`${f.function_name}__${f.argument_types}__${idx}`}
                          value={f.function_name}
                        >
                          {f.function_name}
                          {f.argument_types ? `(${f.argument_types})` : '()'}
                        </option>
                      ))}
                    </select>
                  </FormField>
                </div>
                <FormField label="参数（JSON object）">
                  <textarea
                    value={form.rpc_args}
                    onChange={(e) => setForm({ ...form, rpc_args: e.target.value })}
                    className="input-base w-full font-mono text-xs"
                    rows={4}
                  />
                </FormField>
              </div>
            )}

            {/* kind=http 字段 */}
            {form.kind === 'http' && (
              <div className="space-y-3 border-l-2 border-blue-200 pl-4">
                <div className="grid grid-cols-4 gap-4">
                  <FormField label="method *">
                    <select
                      value={form.http_method}
                      onChange={(e) => setForm({ ...form, http_method: e.target.value })}
                      className="input-base w-full"
                      disabled={!!editing}
                    >
                      {['POST', 'GET', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <FormField label="URL *" className="col-span-3">
                    <input
                      type="url"
                      value={form.http_url}
                      onChange={(e) => setForm({ ...form, http_url: e.target.value })}
                      className="input-base w-full font-mono"
                      placeholder="https://example.com/hook"
                    />
                  </FormField>
                </div>
                <FormField label="自定义 Headers (JSON)">
                  <textarea
                    value={form.http_headers}
                    onChange={(e) => setForm({ ...form, http_headers: e.target.value })}
                    className="input-base w-full font-mono text-xs"
                    rows={3}
                  />
                </FormField>
                <FormField label="Body (JSON)">
                  <textarea
                    value={form.http_body}
                    onChange={(e) => setForm({ ...form, http_body: e.target.value })}
                    className="input-base w-full font-mono text-xs"
                    rows={4}
                  />
                </FormField>
                <FormField
                  label="HMAC 签名密钥（X-Onebase-Signature）"
                  hint={
                    editing
                      ? '留空保留原值；填入新值会覆盖；明文密钥不会回显'
                      : '可选；不填则不附签名头'
                  }
                >
                  <input
                    type="text"
                    value={form.http_secret}
                    onChange={(e) => setForm({ ...form, http_secret: e.target.value })}
                    className="input-base w-full"
                  />
                </FormField>
              </div>
            )}

            {/* kind=shell 字段 */}
            {form.kind === 'shell' && (
              <div className="space-y-3 border-l-2 border-red-300 pl-4">
                {/* 红色 callout：把 shell 任务的安全语义当面摆给操作者，避免被"和 HTTP/RPC 一样"的错觉骗 */}
                <div className="text-xs bg-red-50 border border-red-200 text-red-800 p-3 rounded space-y-1">
                  <div className="font-semibold">
                    <i className="fas fa-shield-alt mr-1"></i>
                    Shell 任务安全须知
                  </div>
                  <ul className="list-disc list-inside space-y-0.5">
                    <li>
                      鉴权：
                      {tenantMode ? (
                        <>
                          本租户的 <b>owner / admin</b> 即可创建；脚本运行在宿主机上但走沙盒隔离
                        </>
                      ) : (
                        <>
                          平台级仅 <b>超管</b> 可创建；本项目跨租户/无 tenant 归属
                        </>
                      )}
                    </li>
                    <li>
                      运行时沙盒由 <code>SCHEDULER_SHELL_SANDBOX_MODE</code> 决定（默认 <code>auto</code>：bwrap → nsjail → direct）
                    </li>
                    <li>
                      <code>direct</code> 模式无沙盒，脚本以 onebase 进程身份执行；生产环境请用 <code>bwrap</code> 或 <code>off</code>
                    </li>
                    <li>
                      子进程 <code>env_clear</code> 后只注入白名单（PATH/HOME + 你在 shell_env 里显式填的项），不会泄露 onebase 自身的 secret
                    </li>
                    <li>
                      解释器走白名单（sh / bash / dash / zsh / python3 / node / ruby），无法直接调 <code>rm</code> / <code>dd</code> 等危险二进制
                    </li>
                  </ul>
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <FormField label="解释器" hint="后端白名单：sh/bash/dash/zsh/python3/node/ruby">
                    <select
                      value={form.shell_interpreter}
                      onChange={(e) => setForm({ ...form, shell_interpreter: e.target.value })}
                      className="input-base w-full"
                      disabled={!!editing}
                    >
                      {!SHELL_INTERPRETERS.includes(form.shell_interpreter) && form.shell_interpreter && (
                        <option value={form.shell_interpreter}>{form.shell_interpreter}（自定义）</option>
                      )}
                      {SHELL_INTERPRETERS.map((interp) => (
                        <option key={interp} value={interp}>
                          {interp}
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <FormField
                    label="工作目录 (cwd)"
                    hint="留空 → 沙盒内的 /tmp"
                    className="col-span-2"
                  >
                    <input
                      type="text"
                      value={form.shell_cwd}
                      onChange={(e) => setForm({ ...form, shell_cwd: e.target.value })}
                      className="input-base w-full font-mono"
                      placeholder="/tmp"
                    />
                  </FormField>
                </div>
                <FormField
                  label="脚本内容 *"
                  hint='以 `<interpreter> -c <script>` 形式执行；stdout/stderr 各 64KB 上限。'
                >
                  <textarea
                    value={form.shell_script}
                    onChange={(e) => setForm({ ...form, shell_script: e.target.value })}
                    className="input-base w-full font-mono text-xs"
                    rows={10}
                    placeholder={'#!/bin/sh\nset -eu\necho "hello from onebase"'}
                    required
                  />
                </FormField>
                <FormField
                  label="环境变量 (JSON object，key/val 都是字符串)"
                  hint="支持 number/bool（会被 stringify），其它类型会被忽略。key 含 `=` 或 NUL 会被丢弃。"
                >
                  <textarea
                    value={form.shell_env}
                    onChange={(e) => setForm({ ...form, shell_env: e.target.value })}
                    className="input-base w-full font-mono text-xs"
                    rows={3}
                    placeholder='{"BACKUP_DIR": "/data/backup"}'
                  />
                </FormField>
              </div>
            )}

            <div className="grid grid-cols-3 gap-4">
              <FormField label="单次超时 (秒)" hint="1–86400">
                <input
                  type="number"
                  value={form.timeout_secs}
                  onChange={(e) =>
                    setForm({ ...form, timeout_secs: parseInt(e.target.value || '60', 10) })
                  }
                  className="input-base w-full"
                  min={1}
                  max={86400}
                />
              </FormField>
              <FormField label="最大重试次数" hint="0–10">
                <input
                  type="number"
                  value={form.max_retries}
                  onChange={(e) =>
                    setForm({ ...form, max_retries: parseInt(e.target.value || '0', 10) })
                  }
                  className="input-base w-full"
                  min={0}
                  max={10}
                />
              </FormField>
            </div>

            <div className="space-y-3 border-l-2 border-orange-200 pl-4">
              <button
                type="button"
                onClick={() => setAlertOpen((v) => !v)}
                className="w-full flex items-center justify-between gap-2 text-left"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <i
                    className={`fas fa-chevron-right text-[10px] text-gray-400 transition-transform ${
                      alertOpen ? 'rotate-90' : ''
                    }`}
                  />
                  <span className="text-sm font-medium text-gray-800">失败告警 Webhook</span>
                  {form.alert_webhook_url.trim() ? (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-emerald-50 text-emerald-700">
                      已配置
                    </span>
                  ) : (
                    <span className="text-xs text-gray-400">点击展开设置</span>
                  )}
                </div>
              </button>
              {alertOpen && (
                <>
                  <div className="text-xs text-gray-500">
                    仅最终失败后发送；同一任务按限流小时数最多发送一次。URL 留空即关闭告警。
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <FormField label="Webhook URL" className="col-span-2">
                      <input
                        type="url"
                        value={form.alert_webhook_url}
                        onChange={(e) => setForm({ ...form, alert_webhook_url: e.target.value })}
                        className="input-base w-full font-mono"
                        placeholder="https://example.com/webhook"
                      />
                    </FormField>
                    <FormField label="限流小时数" hint="0 = 不限流；默认 24">
                      <input
                        type="number"
                        value={form.alert_throttle_hours}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            alert_throttle_hours: parseInt(e.target.value || '24', 10),
                          })
                        }
                        className="input-base w-full"
                        min={0}
                        max={720}
                      />
                    </FormField>
                  </div>
                  <FormField
                    label="消息模板（JSON object）"
                    hint="可用变量：{{source}} {{name}} {{status}} {{error}} {{time}} {{run_id}} {{object_id}} {{trigger_type}} {{trace_id}}"
                  >
                    <textarea
                      value={form.alert_webhook_template}
                      onChange={(e) => setForm({ ...form, alert_webhook_template: e.target.value })}
                      className="input-base w-full font-mono text-xs"
                      rows={6}
                    />
                  </FormField>
                </>
              )}
            </div>

            {/* 试运行结果面板：仅当用户点过"测试运行"才出现；放在按钮上方，更靠近 stdout 来源。 */}
            {dryRunResult && (
              <div
                className={`pt-4 border-t space-y-2 ${
                  dryRunResult.status === 'success'
                    ? 'text-emerald-800'
                    : dryRunResult.status === 'timeout'
                      ? 'text-amber-800'
                      : 'text-red-800'
                }`}
              >
                <div className="flex items-center justify-between text-sm">
                  <div>
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        dryRunResult.status === 'success'
                          ? 'bg-emerald-100'
                          : dryRunResult.status === 'timeout'
                            ? 'bg-amber-100'
                            : 'bg-red-100'
                      }`}
                    >
                      试运行 · {dryRunResult.status}
                    </span>
                    <span className="text-gray-500 ml-2">
                      <i className="fas fa-clock mr-1"></i>
                      {dryRunResult.duration_ms} ms
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDryRunResult(null)}
                    className="text-xs text-gray-400 hover:text-gray-600"
                  >
                    <i className="fas fa-times mr-1"></i>关闭
                  </button>
                </div>
                {dryRunResult.error_message && (
                  <div className="bg-red-50 border border-red-200 rounded p-2 text-xs font-mono whitespace-pre-wrap break-all">
                    {dryRunResult.error_message}
                  </div>
                )}
                {dryRunResult.output !== null && dryRunResult.output !== undefined && (
                  <details open className="bg-gray-50 border border-gray-200 rounded">
                    <summary className="cursor-pointer text-xs px-2 py-1 text-gray-700 hover:bg-gray-100">
                      输出 (JSON)
                    </summary>
                    <pre className="text-xs p-2 overflow-x-auto max-h-64 whitespace-pre-wrap break-all">
                      {JSON.stringify(dryRunResult.output, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            )}

            <div className="flex space-x-3 pt-4 border-t">
              <button type="submit" className="btn-primary">
                <i className="fas fa-save mr-2"></i>{editing ? '保存' : '创建'}
              </button>
              {/*
                测试运行按钮：与"保存"用同一份 buildCreatePayload，所以必填校验 / JSON
                解析的错误信息行为完全一致；后端再走完整的执行器调用，但不写 DB。
                  - 对 shell：真的会在宿主机 spawn 子进程（沙盒内），所以脚本里的副作用
                    （文件写入 / curl 外发）会真实发生 —— 这里在 hint 里提示用户。
                  - 对 http：会真的请求 URL。
                  - 对 rpc：会真的调用 PG 函数（含写库）。
              */}
              <button
                type="button"
                onClick={handleDryRun}
                disabled={dryRunning}
                className="btn-default"
                title="使用当前表单立即执行一次；不持久化为任务、不入运行历史。注意：脚本/HTTP/RPC 的实际副作用会真实发生。"
              >
                {dryRunning ? (
                  <>
                    <i className="fas fa-spinner fa-spin mr-2"></i>测试中…
                  </>
                ) : (
                  <>
                    <i className="fas fa-vial mr-2"></i>测试运行
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowForm(false)
                  resetForm()
                }}
                className="btn-default"
              >
                取消
              </button>
            </div>
          </form>
        </div>
      )}

      {/* 过滤器 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2 text-xs">
          <span className="text-gray-500">筛选：</span>
          <FilterChip
            label="全部类型"
            active={filterKind === 'all'}
            onClick={() => setFilterKind('all')}
          />
          <FilterChip label="HTTP" active={filterKind === 'http'} onClick={() => setFilterKind('http')} />
          <FilterChip label="RPC" active={filterKind === 'rpc'} onClick={() => setFilterKind('rpc')} />
          {/* 自 migration 017 起租户级也可以有 shell 任务 → 筛选器在两种模式都渲染。 */}
          <FilterChip
            label="Shell"
            active={filterKind === 'shell'}
            onClick={() => setFilterKind('shell')}
          />
          {/* (历史注释：曾因 DB CHECK 强制 shell 仅平台级，租户模式隐藏此 chip；
              017 删除该约束后已无意义) */}
          <span className="text-gray-300 px-1">|</span>
          <FilterChip
            label="全部状态"
            active={filterActive === 'all'}
            onClick={() => setFilterActive('all')}
          />
          <FilterChip
            label="启用"
            active={filterActive === 'on'}
            onClick={() => setFilterActive('on')}
          />
          <FilterChip
            label="停用"
            active={filterActive === 'off'}
            onClick={() => setFilterActive('off')}
          />
        </div>
        <button onClick={load} className="text-xs text-gray-500 hover:text-primary-600">
          <i className="fas fa-sync-alt mr-1"></i>刷新
        </button>
      </div>

      {/* 列表 */}
      <div className="space-y-3">
        {loading ? (
          <div className="text-center py-12 text-gray-400">
            <i className="fas fa-spinner fa-spin text-2xl"></i>
          </div>
        ) : filteredTasks.length === 0 ? (
          <div className="text-center py-12 card">
            <i className="fas fa-clock text-5xl text-gray-300 mb-4"></i>
            <p className="text-gray-500">暂无定时任务</p>
          </div>
        ) : (
          filteredTasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              tenantName={
                task.tenant_id != null ? tenantNameById.get(task.tenant_id) ?? null : null
              }
              databaseLabel={
                task.database_id != null
                  ? databaseLabelById.get(task.database_id) ?? null
                  : null
              }
              showTenant={!tenantMode}
              onEdit={() => startEdit(task)}
              onDelete={() => handleDelete(task)}
              onToggle={() => handleToggle(task)}
              onRunNow={() => handleRunNow(task)}
              onViewRuns={() => openRuns(task)}
            />
          ))
        )}
      </div>

      {/* 执行历史抽屉 */}
      {runsTask && (
        <RunsDrawer
          task={runsTask}
          runs={runs}
          loading={runsLoading}
          onClose={closeRuns}
          onRefresh={() => loadRuns(runsTask)}
        />
      )}
    </div>
  )
}

// ───────── 子组件 ─────────

function StatCard({
  label,
  value,
  danger = false,
}: {
  label: string
  value: number
  danger?: boolean
}) {
  return (
    <div className="card p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${danger ? 'text-red-600' : 'text-gray-900'}`}>
        {value}
      </div>
    </div>
  )
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-1 rounded ${
        active
          ? 'bg-primary-100 text-primary-700 font-medium'
          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
      }`}
    >
      {label}
    </button>
  )
}

function FormField({
  label,
  hint,
  className = '',
  children,
}: {
  label: string
  hint?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={className}>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  )
}

function TaskRow({
  task,
  tenantName,
  databaseLabel,
  showTenant,
  onEdit,
  onDelete,
  onToggle,
  onRunNow,
  onViewRuns,
}: {
  task: ScheduledTask
  /** 解析过的 tenant 名（缺失时退化为 #id） */
  tenantName: string | null
  /** 解析过的 database 名（缺失时退化为 #id） */
  databaseLabel: string | null
  /** 租户列展示开关：tenant 模式下隐藏（信息冗余） */
  showTenant: boolean
  onEdit: () => void
  onDelete: () => void
  onToggle: () => void
  onRunNow: () => void
  onViewRuns: () => void
}) {
  // 列表展示目标：rpc 显示函数签名，http 显示 method+url，shell 显示
  // 解释器 + 脚本首行（避免把整段脚本铺开）。脚本首行还做了截断。
  const shellFirstLine = task.shell_script?.split('\n')[0] ?? ''
  const shellPreview =
    shellFirstLine.length > 80 ? `${shellFirstLine.slice(0, 80)}…` : shellFirstLine
  const target =
    task.kind === 'rpc'
      ? `${task.rpc_schema}.${task.rpc_fn_name}() @ ${databaseLabel ?? `db#${task.database_id}`}`
      : task.kind === 'shell'
        ? `${task.shell_interpreter ?? '/bin/sh'} -c '${shellPreview}'`
        : `${task.http_method} ${task.http_url}`
  const tenantBadge = task.tenant_id === null ? '平台级' : tenantName ?? `租户 #${task.tenant_id}`
  return (
    <div className={`card p-5 ${!task.is_active ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center flex-wrap gap-2 mb-2">
            <h3 className="text-sm font-semibold text-gray-900">{task.name}</h3>
            <span
              className={`px-2 py-0.5 rounded text-xs font-medium ${
                task.is_active
                  ? 'bg-green-100 text-green-800'
                  : 'bg-gray-100 text-gray-500'
              }`}
            >
              {task.is_active ? '启用' : '停用'}
            </span>
            <span
              className={`px-2 py-0.5 rounded text-xs font-mono ${
                task.kind === 'rpc'
                  ? 'bg-purple-100 text-purple-700'
                  : task.kind === 'shell'
                    ? 'bg-red-100 text-red-700'
                    : 'bg-blue-100 text-blue-700'
              }`}
            >
              {task.kind.toUpperCase()}
            </span>
            <span className="px-2 py-0.5 rounded text-xs font-mono bg-gray-100 text-gray-700">
              {task.cron_expr} · {task.timezone}
            </span>
            {task.last_run_status && (
              <span
                className={`px-2 py-0.5 rounded text-xs ${statusColor(task.last_run_status)}`}
              >
                上次：{task.last_run_status}
              </span>
            )}
            {showTenant && (
              <span className="px-2 py-0.5 rounded text-xs bg-gray-50 text-gray-500">
                {tenantBadge}
              </span>
            )}
          </div>
          {task.description && (
            <p className="text-xs text-gray-500 mb-1">{task.description}</p>
          )}
          <p className="text-xs text-gray-500 font-mono break-all">{target}</p>
          <div className="text-xs text-gray-400 mt-1 space-x-4">
            <span title={task.created_by_email || undefined}>
              <i className="fas fa-user text-gray-300 mr-1"></i>创建人：
              {task.created_by_name || '未知'}
            </span>
            <span>
              <i className="fas fa-arrow-right text-gray-300 mr-1"></i>下次：
              {formatDateTime(task.next_run_at)}
            </span>
            <span>
              <i className="fas fa-history text-gray-300 mr-1"></i>上次：
              {formatDateTime(task.last_run_at)}
            </span>
            <span>
              超时 {task.timeout_secs}s · 重试 {task.max_retries} · overlap=
              {task.overlap_policy}
            </span>
          </div>
        </div>
        <div className="flex items-center space-x-2 flex-shrink-0 ml-3">
          <button onClick={onRunNow} className="btn-default text-xs" disabled={!task.is_active}>
            <i className="fas fa-bolt mr-1"></i>立即运行
          </button>
          <button onClick={onViewRuns} className="btn-default text-xs">
            <i className="fas fa-list mr-1"></i>历史
          </button>
          <button onClick={onEdit} className="btn-default text-xs">
            <i className="fas fa-edit mr-1"></i>编辑
          </button>
          <button onClick={onToggle} className="btn-default text-xs">
            <i className={`fas ${task.is_active ? 'fa-pause' : 'fa-play'} mr-1`}></i>
            {task.is_active ? '停用' : '启用'}
          </button>
          <button
            onClick={onDelete}
            className="text-red-500 hover:text-red-700 text-xs px-2 py-1"
            title="删除"
          >
            <i className="fas fa-trash"></i>
          </button>
        </div>
      </div>
    </div>
  )
}

function RunsDrawer({
  task,
  runs,
  loading,
  onClose,
  onRefresh,
}: {
  task: ScheduledTask
  runs: ScheduledTaskRun[]
  loading: boolean
  onClose: () => void
  onRefresh: () => void
}) {
  const [expanded, setExpanded] = useState<number | null>(null)
  return (
    <div
      className="fixed z-50 flex"
      style={{ top: 0, left: 0, right: 'var(--ai-panel-offset, 0px)', bottom: 0 }}
    >
      <div className="flex-1 bg-black/30" onClick={onClose}></div>
      <div className="w-[640px] max-w-full bg-white shadow-2xl overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <div className="min-w-0">
            <h3 className="font-semibold text-gray-900 truncate">{task.name}</h3>
            <p className="text-xs text-gray-500 mt-0.5">执行历史 · 最近 50 行</p>
          </div>
          <div className="flex items-center space-x-2">
            <button onClick={onRefresh} className="btn-default text-xs">
              <i className="fas fa-sync-alt mr-1"></i>刷新
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-700">
              <i className="fas fa-times text-lg"></i>
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-2">
          {loading ? (
            <div className="text-center py-12 text-gray-400">
              <i className="fas fa-spinner fa-spin text-2xl"></i>
            </div>
          ) : runs.length === 0 ? (
            <div className="text-center py-12 text-gray-400">
              <i className="fas fa-history text-3xl mb-2"></i>
              <p className="text-sm">尚无执行记录</p>
            </div>
          ) : (
            runs.map((run) => (
              <div key={run.id} className="border border-gray-200 rounded-lg">
                <button
                  type="button"
                  onClick={() => setExpanded(expanded === run.id ? null : run.id)}
                  className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-gray-50"
                >
                  <div className="flex items-center space-x-3 min-w-0">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor(run.status)}`}
                    >
                      {run.status}
                    </span>
                    <span className="text-xs text-gray-600 whitespace-nowrap">
                      {formatDateTime(run.started_at)}
                    </span>
                    <span className="text-xs text-gray-400">
                      {run.duration_ms != null ? `${run.duration_ms}ms` : '—'}
                    </span>
                    <span className="text-xs text-gray-400">
                      尝试 #{run.attempt_number} · {run.triggered_by}
                    </span>
                  </div>
                  <i
                    className={`fas fa-chevron-${expanded === run.id ? 'up' : 'down'} text-xs text-gray-400`}
                  ></i>
                </button>
                {expanded === run.id && (
                  <div className="px-4 pb-3 text-xs space-y-2 border-t bg-gray-50">
                    {run.error_message && (
                      <div className="pt-2">
                        <div className="font-medium text-red-700 mb-1">错误信息</div>
                        <pre className="bg-red-50 text-red-800 p-2 rounded whitespace-pre-wrap break-all">
                          {run.error_message}
                        </pre>
                      </div>
                    )}
                    {run.output !== null && run.output !== undefined && (
                      <div className="pt-2">
                        <div className="font-medium text-gray-700 mb-1">输出</div>
                        <pre className="bg-white border border-gray-200 p-2 rounded font-mono overflow-x-auto max-h-64">
                          {typeof run.output === 'string'
                            ? run.output
                            : JSON.stringify(run.output, null, 2)}
                        </pre>
                      </div>
                    )}
                    <div className="pt-2 text-gray-500 grid grid-cols-2 gap-1">
                      <span>runner_id：{run.runner_id ?? '—'}</span>
                      <span>finished_at：{formatDateTime(run.finished_at)}</span>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
