-- ============================================
-- 默认 RBAC 权限种子（让 superadmin/admin/editor/viewer 开箱可用）
-- ============================================
-- 1. 给 permissions 加唯一约束，避免重复种子
-- 2. 为每个已存在 tenant 创建 4 条基础 permission
-- 3. 把这些 permission 绑定到对应系统角色
--
-- resource = '*' 表示通配该 tenant 下所有 schema/table（在 query_user_permissions
-- 的 SQL 中按 OR 匹配）。租户管理员可以再创建更细粒度的 resource = 'schema.table'
-- 权限来覆盖。

-- 唯一约束（幂等：使用 IF NOT EXISTS 兼容 PG 12+）
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'management'
          AND indexname = 'uq_permissions_tenant_resource_action'
    ) THEN
        EXECUTE 'CREATE UNIQUE INDEX uq_permissions_tenant_resource_action
                 ON management.permissions (tenant_id, resource, action)';
    END IF;
END$$;

-- 为每个 tenant 插入 4 条基础权限（幂等）
INSERT INTO management.permissions
    (tenant_id, resource, action, conditions, allowed_columns, denied_columns, description)
SELECT t.id, src.resource, src.action,
       '[]'::jsonb, NULL, '[]'::jsonb, src.description
FROM management.tenants t
CROSS JOIN (VALUES
    ('*', 'SELECT', '只读所有资源（viewer/editor/admin/superadmin 共用）'),
    ('*', 'INSERT', '插入所有资源（editor/admin/superadmin 共用）'),
    ('*', 'UPDATE', '更新所有资源（editor/admin/superadmin 共用）'),
    ('*', 'ALL',    '完全访问所有资源（admin/superadmin 共用）')
) AS src(resource, action, description)
ON CONFLICT (tenant_id, resource, action) DO NOTHING;

-- viewer → SELECT
INSERT INTO management.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM management.roles r
JOIN management.permissions p
  ON p.tenant_id = r.tenant_id AND p.resource = '*' AND p.action = 'SELECT'
WHERE r.name = 'viewer'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- editor → SELECT + INSERT + UPDATE
INSERT INTO management.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM management.roles r
JOIN management.permissions p
  ON p.tenant_id = r.tenant_id
 AND p.resource = '*'
 AND p.action IN ('SELECT', 'INSERT', 'UPDATE')
WHERE r.name = 'editor'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- admin → ALL
INSERT INTO management.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM management.roles r
JOIN management.permissions p
  ON p.tenant_id = r.tenant_id AND p.resource = '*' AND p.action = 'ALL'
WHERE r.name = 'admin'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- superadmin（角色名，区别于 users.is_superadmin 的平台超管）→ ALL
INSERT INTO management.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM management.roles r
JOIN management.permissions p
  ON p.tenant_id = r.tenant_id AND p.resource = '*' AND p.action = 'ALL'
WHERE r.name = 'superadmin'
ON CONFLICT (role_id, permission_id) DO NOTHING;
