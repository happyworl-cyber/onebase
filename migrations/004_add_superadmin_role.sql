-- 添加超级管理员支持

-- 1. 为 users 表添加超管标识
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN DEFAULT false;

-- 2. 设置 admin 用户为超级管理员
UPDATE users SET is_superadmin = true WHERE username = 'admin';

-- 3. 创建超管视图：查看所有租户和用户信息
CREATE OR REPLACE VIEW management.v_superadmin_dashboard AS
SELECT 
    t.id AS tenant_id,
    t.name AS tenant_name,
    t.slug,
    t.status,
    t.contact_email,
    COUNT(DISTINCT td.id) AS database_count,
    COUNT(DISTINCT ts.id) AS schema_count,
    COUNT(DISTINCT ut.user_id) AS user_count,
    ARRAY_AGG(DISTINCT u.username) FILTER (WHERE u.username IS NOT NULL) AS users,
    t.created_at
FROM management.tenants t
LEFT JOIN management.tenant_databases td ON td.tenant_id = t.id AND td.is_active = true
LEFT JOIN management.tenant_schemas ts ON ts.tenant_id = t.id AND ts.is_active = true
LEFT JOIN management.user_tenants ut ON ut.tenant_id = t.id AND ut.is_active = true
LEFT JOIN users u ON u.id = ut.user_id
GROUP BY t.id, t.name, t.slug, t.status, t.contact_email, t.created_at
ORDER BY t.created_at DESC;

-- 4. 创建索引
CREATE INDEX IF NOT EXISTS idx_users_superadmin ON users(is_superadmin) WHERE is_superadmin = true;

-- 完成
SELECT '✅ 超级管理员功能已添加' AS message;

