-- ============================================================
-- 校验 Organization → Project 层级迁移完整性
-- 用法：psql "$DATABASE_URL" -f scripts/validate_organizations.sql
-- 期望：各检查段结果为空（或 count = 0）
-- ============================================================

\echo '=== 1. 孤儿项目：tenants 缺少 organization_id ==='
SELECT id, name, slug, status
FROM management.tenants
WHERE organization_id IS NULL
ORDER BY id;

\echo '=== 2. 项目指向不存在的组织 ==='
SELECT t.id AS project_id, t.name, t.organization_id
FROM management.tenants t
LEFT JOIN management.organizations o ON o.id = t.organization_id
WHERE t.organization_id IS NOT NULL AND o.id IS NULL
ORDER BY t.id;

\echo '=== 3. 活跃项目成员缺少对应活跃租户成员 ==='
SELECT ut.user_id, ut.tenant_id AS project_id, t.organization_id, ut.role AS project_role
FROM management.user_tenants ut
JOIN management.tenants t ON t.id = ut.tenant_id
LEFT JOIN management.organization_members om
  ON om.organization_id = t.organization_id
 AND om.user_id = ut.user_id
 AND om.is_active = true
WHERE ut.is_active = true
  AND t.status = 'active'
  AND om.id IS NULL
ORDER BY t.organization_id, ut.tenant_id, ut.user_id;

\echo '=== 4. 无任何 owner 的活跃组织 ==='
SELECT o.id, o.name, o.slug
FROM management.organizations o
WHERE o.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM management.organization_members om
    WHERE om.organization_id = o.id AND om.is_active = true AND om.role = 'owner'
  )
ORDER BY o.id;

\echo '=== 5. 汇总 ==='
SELECT
  (SELECT COUNT(*) FROM management.organizations) AS organizations,
  (SELECT COUNT(*) FROM management.tenants WHERE organization_id IS NOT NULL) AS projects_with_org,
  (SELECT COUNT(*) FROM management.tenants WHERE organization_id IS NULL) AS orphan_projects,
  (SELECT COUNT(*) FROM management.organization_members WHERE is_active) AS active_org_members;
