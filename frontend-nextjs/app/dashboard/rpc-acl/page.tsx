'use client'

/**
 * RPC 细粒度授权（租户内） —— 在当前项目工作区里管理「哪个角色可以调哪个函数」。
 *
 * 与历史 /platform/rpc-acl 的区别：
 *   - 没有顶部的"项目选择器"。当前项目由侧边栏 / 顶栏的数据库连接切换来表达，
 *     页面只关心 `currentConnection.database_id` + `currentSchema`。
 *   - 鉴权交给 PermissionGate(`canManageRbac`)，与"角色管理"和"权限管理"同档。
 *     后端 `require_tenant_admin_for_db` 同时放行平台超管，无需前端二次判分支。
 *
 * 已知限制（与 /dashboard/rpc 调用页同源）：
 *   函数枚举走 `/query` 端点，目前后端要求平台超管才能调；纯租户管理员暂时只能看
 *   `已配置授权` 列表，无法用下拉拉到 pg_proc 全量。后续会单独拉一条专用 schema
 *   元数据接口（不走 /query），届时本页可平滑接入。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import api, { rbacAPI, rpcAclAPI, type RpcAclEntry } from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { useNotification } from '@/hooks/useNotification'
import PermissionGate from '@/components/PermissionGate'

interface FunctionInfo {
  schema_name: string
  function_name: string
  argument_types: string
  return_type: string
  volatility: string
}

interface Role {
  id: number
  name: string
  description?: string | null
  is_system: boolean
}

export default function RpcAclPage() {
  return (
    <PermissionGate requires="canManageRbac" pageName="RPC 授权管理">
      <RpcAclPageInner />
    </PermissionGate>
  )
}

function RpcAclPageInner() {
  const notify = useNotification()
  const currentConnection = useAppStore((s) => s.currentConnection)
  const storeSchema = useAppStore((s) => s.currentSchema)

  const databaseId = currentConnection?.database_id ?? null

  // ─── 业务数据 ───
  const [functions, setFunctions] = useState<FunctionInfo[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [acls, setAcls] = useState<RpcAclEntry[]>([])

  const [loadingFns, setLoadingFns] = useState(false)
  const [loadingAcls, setLoadingAcls] = useState(false)
  const [fnError, setFnError] = useState<string | null>(null)

  // ─── 授予表单 ───
  // 默认 schema 跟随侧边栏，但允许用户改成同库其它 schema 而不污染全局 store。
  const [formSchema, setFormSchema] = useState(storeSchema || 'public')
  const [formFunction, setFormFunction] = useState('')
  const [formRoleId, setFormRoleId] = useState<number | ''>('')
  const [granting, setGranting] = useState(false)

  useEffect(() => {
    // store 切到新 schema 时同步进表单；用户已手动改过则保持不变。
    if (storeSchema && storeSchema !== formSchema && !formFunction) {
      setFormSchema(storeSchema)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeSchema])

  const loadFunctions = useCallback(async () => {
    if (!databaseId) return
    setLoadingFns(true)
    setFnError(null)
    try {
      // /query 仅平台超管可用；租户管理员会拿到 403，UI 上要降级到"只显示
      // 已配置授权"分支而不是整个页面崩。
      const res = await api.post(
        '/query',
        {
          sql: `
            SELECT
              n.nspname  AS schema_name,
              p.proname  AS function_name,
              pg_get_function_arguments(p.oid) AS argument_types,
              pg_get_function_result(p.oid)    AS return_type,
              CASE p.provolatile
                WHEN 'i' THEN 'IMMUTABLE'
                WHEN 's' THEN 'STABLE'
                WHEN 'v' THEN 'VOLATILE'
              END AS volatility
            FROM pg_proc p
            JOIN pg_namespace n ON p.pronamespace = n.oid
            WHERE n.nspname = '${formSchema}'
              AND p.prokind IN ('f', 'p')
            ORDER BY p.proname
          `,
          read_only: true,
        },
        { headers: { 'X-Database-Id': String(databaseId) }, suppressErrorToast: true } as any,
      )
      setFunctions(res.data.data || [])
    } catch (err: any) {
      const status = err?.response?.status
      if (status === 403) {
        setFnError('当前账号无 /query 访问权限，无法列出函数（仅平台超管可枚举）。已配置的授权可正常查看与收回。')
      } else {
        setFnError(err?.response?.data?.error || err?.message || '加载函数失败')
        notify.error(err)
      }
      setFunctions([])
    } finally {
      setLoadingFns(false)
    }
  }, [databaseId, formSchema, notify])

  const loadRoles = useCallback(async () => {
    try {
      const res = await rbacAPI.listRoles()
      setRoles(res.data || [])
    } catch (err: any) {
      notify.error(err)
    }
  }, [notify])

  const loadAcls = useCallback(async () => {
    if (!databaseId) return
    setLoadingAcls(true)
    try {
      const res = await rpcAclAPI.list(databaseId)
      setAcls(res.data || [])
    } catch (err: any) {
      notify.error(err)
    } finally {
      setLoadingAcls(false)
    }
  }, [databaseId, notify])

  useEffect(() => {
    if (databaseId) {
      loadFunctions()
      loadRoles()
      loadAcls()
    } else {
      setFunctions([])
      setAcls([])
    }
  }, [databaseId, loadFunctions, loadRoles, loadAcls])

  const aclResources = useMemo(
    () => new Set(acls.map((a) => `${a.schema}.${a.function_name}`)),
    [acls],
  )

  const grant = async () => {
    if (!databaseId) {
      notify.warning('请先选择数据库连接')
      return
    }
    if (!formSchema.trim() || !formFunction.trim()) {
      notify.warning('请选择 schema 和函数')
      return
    }
    if (!formRoleId) {
      notify.warning('请选择角色')
      return
    }
    setGranting(true)
    try {
      await rpcAclAPI.grant({
        database_id: databaseId,
        schema: formSchema.trim(),
        function_name: formFunction.trim(),
        role_id: Number(formRoleId),
      })
      notify.success('授权成功')
      setFormFunction('')
      loadAcls()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setGranting(false)
    }
  }

  const revoke = async (entry: RpcAclEntry) => {
    const confirmed = window.confirm(
      `确定要从角色「${entry.role_name}」移除对 ${entry.resource} 的 EXECUTE 权限吗？`,
    )
    if (!confirmed) return
    try {
      await rpcAclAPI.revoke(entry.permission_id, entry.role_id)
      notify.success('已收回')
      loadAcls()
    } catch (err: any) {
      notify.error(err)
    }
  }

  const grouped = useMemo(() => {
    const map = new Map<string, RpcAclEntry[]>()
    for (const a of acls) {
      const key = a.resource
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(a)
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [acls])

  // 未选连接 —— 早返回，避免下面到处判 databaseId。
  if (!databaseId) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">RPC 授权</h1>
          <p className="text-sm text-gray-500 mt-1">
            管理当前项目 PostgreSQL 函数（
            <code className="px-1 bg-gray-100 rounded">/api/v1/&#123;database_id&#125;/rpc/&lt;fn&gt;</code>
            ）的基于角色 EXECUTE 权限。
          </p>
        </div>
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-900">
          <i className="fas fa-exclamation-triangle mr-2"></i>
          当前未选数据库连接。请到 <code className="px-1 bg-yellow-100 rounded">数据库连接</code> 页选一个项目数据库，
          再回到本页配置 RPC 授权。
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-800">RPC 授权</h1>
        <p className="text-sm text-gray-500 mt-1">
          管理当前项目 PostgreSQL 函数（
          <code className="px-1 bg-gray-100 rounded">/api/v1/&#123;database_id&#125;/rpc/&lt;fn&gt;</code>
          ）的基于角色 EXECUTE 权限。
        </p>
        <p className="mt-1 text-xs text-gray-400">
          当前连接：
          <code className="px-1 bg-gray-100 rounded">
            {currentConnection?.db_host || '?'}:{currentConnection?.db_port ?? '?'}/{currentConnection?.db_name ?? '?'}
          </code>
          &nbsp;·&nbsp;database_id: {databaseId}
        </p>
      </div>

      {/* 兼容模式说明 */}
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
        <div className="flex items-start space-x-3">
          <i className="fas fa-info-circle text-blue-500 mt-0.5"></i>
          <div className="space-y-1">
            <p>
              <span className="font-semibold">opt-in 工作模式：</span>
              一个函数 <span className="font-semibold">从未</span> 被配过任何 EXECUTE
              授权时，处于「兼容模式」，任何登录用户都能调用。
            </p>
            <p>
              一旦你给某个函数配了哪怕一行授权，它会立即转入「严格模式」——
              <span className="font-semibold">未授权角色调用会得到 403</span>。
            </p>
            <p className="text-blue-700">
              超级管理员永远跳过 ACL 检查；普通用户调用 RPC 必须带{' '}
              <code className="px-1 bg-blue-100 rounded">X-Database-Id</code> 头。
            </p>
          </div>
        </div>
      </div>

      {/* 函数枚举错误提示（403 / 网络异常等） */}
      {fnError && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <i className="fas fa-info-circle mr-2"></i>
          {fnError}
        </div>
      )}

      {/* 授予表单 */}
      <div className="card p-4">
        <div className="text-sm font-semibold text-gray-700 mb-3">
          <i className="fas fa-plus-circle mr-2 text-blue-500"></i>新增授权
        </div>
        <div className="grid grid-cols-12 gap-3 items-end">
          <div className="col-span-2">
            <label className="block text-xs font-medium text-gray-700 mb-1">Schema</label>
            <input
              type="text"
              value={formSchema}
              onChange={(e) => setFormSchema(e.target.value)}
              onBlur={() => loadFunctions()}
              className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="public"
            />
          </div>
          <div className="col-span-5">
            <label className="block text-xs font-medium text-gray-700 mb-1">
              函数（来自 {formSchema} schema）
              {loadingFns && (
                <span className="ml-2 text-gray-400">
                  <i className="fas fa-spinner fa-spin"></i>
                </span>
              )}
            </label>
            <select
              value={formFunction}
              onChange={(e) => setFormFunction(e.target.value)}
              disabled={functions.length === 0}
              className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono disabled:bg-gray-50 disabled:text-gray-400"
            >
              <option value="">
                {functions.length === 0
                  ? fnError
                    ? '— 无法枚举函数 —'
                    : '— 该 schema 下无函数 —'
                  : '— 选择函数 —'}
              </option>
              {functions.map((f) => {
                const resKey = `${f.schema_name}.${f.function_name}`
                const isConfigured = aclResources.has(resKey)
                return (
                  <option key={resKey} value={f.function_name}>
                    {isConfigured ? '● ' : '○ '}
                    {f.function_name}({f.argument_types || ''}) → {f.return_type}
                  </option>
                )
              })}
            </select>
          </div>
          <div className="col-span-3">
            <label className="block text-xs font-medium text-gray-700 mb-1">角色</label>
            <select
              value={formRoleId}
              onChange={(e) =>
                setFormRoleId(e.target.value === '' ? '' : Number(e.target.value))
              }
              className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">— 选择角色 —</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.is_system ? ' (system)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="col-span-2">
            <button
              onClick={grant}
              disabled={granting || !databaseId}
              className="btn-primary w-full"
            >
              {granting ? (
                <>
                  <i className="fas fa-spinner fa-spin mr-2"></i>授予中…
                </>
              ) : (
                <>
                  <i className="fas fa-check mr-2"></i>授予
                </>
              )}
            </button>
          </div>
        </div>
        <p className="mt-2 text-xs text-gray-500">
          下拉里 ● 表示已配过 ACL（严格模式）；○ 表示尚处兼容模式。
        </p>
      </div>

      {/* ACL 列表 */}
      <div className="card">
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-700">已配置授权</span>
          <button
            onClick={loadAcls}
            disabled={loadingAcls}
            className="text-xs text-blue-600 hover:text-blue-700"
          >
            <i className={`fas fa-sync mr-1 ${loadingAcls ? 'fa-spin' : ''}`}></i>刷新
          </button>
        </div>
        {grouped.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">
            {loadingAcls ? (
              <>
                <i className="fas fa-spinner fa-spin mr-2"></i>加载中…
              </>
            ) : (
              <>
                当前还没有任何 RPC 授权。所有函数都在「兼容模式」下：
                <br />
                登录用户都可调用，直到你为它新增第一条授权为止。
              </>
            )}
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {grouped.map(([resource, entries]) => (
              <div key={resource} className="px-4 py-3">
                <div className="flex items-center justify-between mb-2">
                  <code className="text-sm font-mono text-gray-900">{resource}()</code>
                  <span className="text-[10px] px-1.5 py-0.5 bg-orange-100 text-orange-700 rounded font-medium">
                    严格模式
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {entries.map((e) => (
                    <div
                      key={`${e.permission_id}-${e.role_id}`}
                      className="flex items-center space-x-2 px-3 py-1.5 bg-blue-50 border border-blue-200 rounded-full text-xs"
                    >
                      <i className="fas fa-user-tag text-blue-500"></i>
                      <span className="text-gray-900">{e.role_name}</span>
                      <button
                        onClick={() => revoke(e)}
                        className="text-red-500 hover:text-red-700 transition-colors"
                        title="收回"
                      >
                        <i className="fas fa-times"></i>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
