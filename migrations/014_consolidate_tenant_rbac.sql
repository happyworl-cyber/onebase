-- ============================================
-- 统一 RBAC 角色语义 + 回填 user_roles
-- ============================================
--
-- 背景：
-- 005_rbac_tables.sql 给每个 tenant 都 seed 了 4 个系统角色：
--   superadmin / admin / editor / viewer
-- 其中 tenant 维度的 `superadmin` 与 `users.is_superadmin`（平台超管）
-- 同名但语义不同，已多次造成 confusion；且它和 `admin` 都绑定 `*.ALL`
-- 权限，功能完全重叠，没有保留必要。
--
-- 同时，005~B5（src/permissions.rs::sync_default_rbac_role）之前
-- 加入租户的用户（包括 SSO 自动创建的）**没有**自动获得对应的 RBAC
-- user_roles 行，导致这些老用户在 Auto API / RBAC 数据接口上拿到 0 权限。
--
-- 本迁移幂等地做三件事：
--   1. 把所有挂在 tenant `superadmin` 角色上的 user_roles，平移到同
--      tenant 的 `admin` 角色（语义等价 + 不丢失任何用户的实际权限）；
--   2. 删除所有 tenant 的 `superadmin` 系统角色（role_permissions 经
--      FK ON DELETE CASCADE 自动清理）；
--   3. 给所有 active 的 user_tenants 成员按以下默认映射补 user_roles：
--        owner / admin   → admin
--        member          → editor
--        viewer          → viewer
--      已有同名 role 绑定的不会重复插入（INSERT ... ON CONFLICT）。
--
-- 注意：之后 src/rbac_handlers::seed_tenant_rbac_defaults 不再创建
-- `superadmin` 角色（同 commit 修改），但旧 tenant 经过本迁移会被清掉，
-- 两侧最终一致。

-- ─── 1. 迁移 superadmin → admin 的 user_roles ───
INSERT INTO management.user_roles (user_id, role_id, tenant_id)
SELECT ur.user_id,
       admin_role.id,
       ur.tenant_id
FROM management.user_roles ur
JOIN management.roles super_role
  ON super_role.id = ur.role_id
 AND super_role.name = 'superadmin'
JOIN management.roles admin_role
  ON admin_role.tenant_id = super_role.tenant_id
 AND admin_role.name = 'admin'
ON CONFLICT (user_id, role_id, tenant_id) DO NOTHING;

-- ─── 2. 删除 superadmin 系统角色 ───
-- 注：role_permissions 通过 FK ON DELETE CASCADE 自动清理；
-- 上一步已经把 user_roles 平移到 admin，这里 user_roles 同样会级联清理。
DELETE FROM management.roles
WHERE name = 'superadmin' AND is_system = true;

-- ─── 3. 给现有 user_tenants 成员回填默认 RBAC 角色 ───
-- 用 LATERAL 把"tenant_role → rbac_role_name"映射成一行，再 join roles 表
-- 找到目标 role_id。如果 tenant 还没有对应 role（极少数）则跳过。
INSERT INTO management.user_roles (user_id, role_id, tenant_id)
SELECT ut.user_id, target_role.id, ut.tenant_id
FROM management.user_tenants ut
CROSS JOIN LATERAL (
    SELECT CASE
        WHEN ut.role IN ('owner', 'admin') THEN 'admin'
        WHEN ut.role = 'member'            THEN 'editor'
        WHEN ut.role = 'viewer'            THEN 'viewer'
        ELSE NULL
    END AS rbac_name
) m
JOIN management.roles target_role
  ON target_role.tenant_id = ut.tenant_id
 AND target_role.name = m.rbac_name
WHERE ut.is_active = true
  AND m.rbac_name IS NOT NULL
ON CONFLICT (user_id, role_id, tenant_id) DO NOTHING;
