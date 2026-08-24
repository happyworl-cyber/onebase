/**
 * 前端身份/权限派生
 *
 * 与后端 `src/permissions.rs` 对应——同一组判定规则，避免前后端两侧的
 * 角色映射各自实现导致 UI 与 API 错位（典型表现：UI 显示某入口可点，
 * 点进去后端 403）。
 *
 * 三个权威输入：
 *   1. `currentUser.is_superadmin`：平台超管，全局放行（后端 JWT 的权威字段）；
 *   2. `currentConnection.user_role`：用户在 **当前选中连接所属租户** 的 `user_tenants.role`
 *      （来自 `management.v_user_connections` 视图）；
 *   3. `currentTenant`：当前选中的租户（决定鉴权的 tenant_id）。
 *
 * 注意：`currentUser.role` 是遗留 display 字段，**不要**用来做权限判定，
 * 详见后端 `auth.rs::Claims` 的文档。
 */

import { useAppStore } from './store'

/** 租户层"管理员"角色集合，与后端 `permissions::TENANT_ADMIN_ROLES` 一致。 */
export const TENANT_ADMIN_ROLES = ['owner', 'admin'] as const
export type TenantRole = 'owner' | 'admin' | 'member' | 'viewer' | string

export interface EffectiveRole {
  /** 平台超级管理员（`users.is_superadmin = true`），可访问全部入口 */
  isPlatformSuperadmin: boolean
  /** 用户在当前连接所属租户的 user_tenants.role；未选连接时为 null */
  tenantRole: TenantRole | null
  /** 是否为当前租户的 owner / admin（含平台超管） */
  isTenantAdmin: boolean
  /** 是否登入但未选任何 tenant / connection */
  isAuthenticated: boolean
}

/**
 * 纯函数：根据 currentUser + currentConnection 派生有效身份。
 * 没有 hook 依赖，便于在 axios 拦截器、SSR 入口等非组件场景使用。
 */
export function deriveEffectiveRole(
  currentUser: { is_superadmin?: boolean | null } | null,
  currentConnection: { user_role?: string | null } | null,
): EffectiveRole {
  const isPlatformSuperadmin = !!currentUser?.is_superadmin
  const tenantRole = (currentConnection?.user_role as TenantRole | undefined) ?? null
  const isTenantAdmin =
    isPlatformSuperadmin ||
    (typeof tenantRole === 'string' && (TENANT_ADMIN_ROLES as readonly string[]).includes(tenantRole))
  return {
    isPlatformSuperadmin,
    tenantRole,
    isTenantAdmin,
    isAuthenticated: !!currentUser,
  }
}

/**
 * Hook：在组件里读"当前用户在当前租户的有效身份"。
 * 实现层会跟随 `useAppStore` 自动重渲染，不需要手动订阅。
 */
export function useEffectiveRole(): EffectiveRole {
  const currentUser = useAppStore((s) => s.currentUser)
  const currentConnection = useAppStore((s) => s.currentConnection)
  return deriveEffectiveRole(currentUser, currentConnection)
}

/**
 * UI 入口的可见性矩阵。
 *
 * 命名直接对齐后端鉴权语义：
 *   - `canManageRbac` / `canManageSso` / `canManageWebhooks` / `canManageApiKeys`
 *     → 都要求租户 owner/admin 或平台超管（后端走 `require_tenant_admin` /
 *     `require_database_admin`）。
 *   - `canViewMonitor` / `canExport` 同上（B2/B3 落定的语义）。
 *   - `canRunDdl` → schema_handlers::create_schema / drop_schema 用的 require_database_admin。
 *   - `canRunAnySql` → /query / /transaction / export_sql_csv 仍是仅平台超管。
 *
 * 这些标志只控制 UI 可见性，**绝不能**当作真鉴权——所有 API 调用最终都由
 * 后端做权威校验。
 */
export interface UiCapabilities {
  canManageRbac: boolean
  canManageSso: boolean
  canManageWebhooks: boolean
  canManageApiKeys: boolean
  canViewMonitor: boolean
  canExport: boolean
  canRunDdl: boolean
  canRunAnySql: boolean
  canManagePlatformTenants: boolean
  canManagePlatformUsers: boolean
}

export function deriveUiCapabilities(role: EffectiveRole): UiCapabilities {
  const tenantAdmin = role.isTenantAdmin
  return {
    canManageRbac: tenantAdmin,
    canManageSso: tenantAdmin,
    canManageWebhooks: tenantAdmin,
    canManageApiKeys: tenantAdmin,
    canViewMonitor: tenantAdmin,
    canExport: tenantAdmin,
    canRunDdl: tenantAdmin,
    canRunAnySql: role.isPlatformSuperadmin,
    canManagePlatformTenants: role.isPlatformSuperadmin,
    canManagePlatformUsers: role.isPlatformSuperadmin,
  }
}

/** Hook 版本，配合 `useEffectiveRole` 一起用。 */
export function useUiCapabilities(): UiCapabilities {
  return deriveUiCapabilities(useEffectiveRole())
}

// ============================================================
// W1 工作空间：基于 user_tenants.role 的 UI 能力门槛
// ============================================================
//
// 这一套与上面 deriveUiCapabilities 平行存在，原因是：
//   - 上面那套绑定 currentConnection（旧的 dashboard / platform 路径）；
//   - 工作空间走 currentProject.user_role（W1 spec §3.2.5/§3.2.6），
//     输入源不一样，不该塞到一个函数里。
//
// 仍是 UI 提示，不是真值。真值在后端 permissions 表。

export type WorkspaceRole =
  | 'superadmin'
  | 'owner'
  | 'admin'
  | 'member'
  | 'viewer'
  | string // 兜底：未知 role 当 viewer 处理

export interface WorkspaceCapabilities {
  /** 「项目信息」编辑（PATCH /api/projects/:id）→ 仅 owner+ */
  canManageProjectSettings: boolean
  /** 「成员管理」（PROJECT_ID/members CRUD）→ admin+ —— W4 新加。
   *  比 canManageProjectSettings 宽一档：admin 也能加人 / 改角色 / 移除，
   *  与后端 require_tenant_admin 对齐。改项目名 / contact_email 仍只能 owner。*/
  canManageMembers: boolean
  /** 整组「安全（RLS / Roles / RPC-ACL / API Key）」→ admin+ */
  canManageSecurity: boolean
  /** 整组「事件（Webhook / 定时任务）」→ admin+ */
  canManageEvents: boolean
  /** 数据库写入（建表 / 改 schema / CREATE FUNCTION 等）→ member+ */
  canWriteDatabase: boolean
  /** 调用 RPC / 读 API → 任意成员（含 viewer） */
  canCallApi: boolean
}

const WORKSPACE_ROLE_ORDER: Record<string, number> = {
  superadmin: 100,
  owner: 80,
  admin: 60,
  member: 40,
  viewer: 20,
}

function workspaceRank(role: WorkspaceRole): number {
  return WORKSPACE_ROLE_ORDER[role] ?? 0
}

export function deriveWorkspaceCapabilities(
  role: WorkspaceRole,
  viaOrganization = false,
): WorkspaceCapabilities {
  const r = workspaceRank(role)
  return {
    canManageProjectSettings: r >= WORKSPACE_ROLE_ORDER.owner,
    canManageMembers: r >= WORKSPACE_ROLE_ORDER.admin,
    canManageSecurity: r >= WORKSPACE_ROLE_ORDER.admin,
    canManageEvents: r >= WORKSPACE_ROLE_ORDER.admin,
    canWriteDatabase: !viaOrganization && r >= WORKSPACE_ROLE_ORDER.member,
    canCallApi: r >= WORKSPACE_ROLE_ORDER.viewer,
  }
}

/**
 * React hook：基于 store 中的 currentProject.user_role 派生当前能力。
 * 用法：const caps = useCurrentProjectCapabilities()
 *      if (caps.canManageSecurity) { ... }
 *
 * currentProject 为 null 时按 viewer 处理（最保守），等 layout 拉到项目
 * 元数据后会自动重派生，触发 React 重渲染显示更多入口。
 */
export function useCurrentProjectCapabilities(): WorkspaceCapabilities {
  const currentProject = useAppStore((s) => s.currentProject)
  return deriveWorkspaceCapabilities(
    currentProject?.user_role ?? 'viewer',
    !!currentProject?.via_organization,
  )
}

// ============================================================
// 组织（租户）层 UI 能力
// ============================================================

export type OrganizationRole = 'superadmin' | 'owner' | 'admin' | 'member' | string

export interface OrganizationCapabilities {
  canManageOrgSettings: boolean
  canManageOrgMembers: boolean
  canCreateProject: boolean
  canViewAllProjects: boolean
  /** 转让 owner / 授予 owner / 归档项目 */
  canTransferOwner: boolean
  canArchiveProject: boolean
  /** 租户级操作日志 / 执行日志 */
  canViewOrgLogs: boolean
}

const ORG_ROLE_ORDER: Record<string, number> = {
  superadmin: 100,
  owner: 80,
  admin: 60,
  member: 40,
}

export function deriveOrganizationCapabilities(
  role: OrganizationRole,
): OrganizationCapabilities {
  const r = ORG_ROLE_ORDER[role] ?? 0
  const isOwnerPlus = r >= ORG_ROLE_ORDER.owner
  const isAdminPlus = r >= ORG_ROLE_ORDER.admin
  return {
    canManageOrgSettings: isOwnerPlus,
    canManageOrgMembers: isAdminPlus,
    canCreateProject: isAdminPlus,
    canViewAllProjects: isAdminPlus,
    canTransferOwner: isOwnerPlus,
    canArchiveProject: isOwnerPlus,
    canViewOrgLogs: isAdminPlus,
  }
}

export function useCurrentOrganizationCapabilities(): OrganizationCapabilities {
  const role = useAppStore((s) => s.currentOrganization?.user_role ?? 'member')
  return deriveOrganizationCapabilities(role)
}
