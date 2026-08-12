-- ============================================
-- 多租户功能快速初始化脚本
-- ============================================
-- 在 SQL 查询页面直接复制粘贴执行此脚本

-- 1. 添加超管字段到 users 表
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='users' AND column_name='is_superadmin') THEN
        ALTER TABLE users ADD COLUMN is_superadmin BOOLEAN DEFAULT false;
    END IF;
END $$;

-- 2. 设置 admin 用户为超级管理员
UPDATE users SET is_superadmin = true WHERE username = 'admin';

-- 3. 创建管理 Schema（如果不存在）
CREATE SCHEMA IF NOT EXISTS management;

-- 4. 创建租户表
CREATE TABLE IF NOT EXISTS management.tenants (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(50) UNIQUE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    contact_email VARCHAR(255),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 5. 创建租户数据库连接配置表
CREATE TABLE IF NOT EXISTS management.tenant_databases (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    connection_name VARCHAR(100) NOT NULL,
    db_host VARCHAR(255) NOT NULL,
    db_port INTEGER NOT NULL DEFAULT 5432,
    db_name VARCHAR(100) NOT NULL,
    db_user VARCHAR(100) NOT NULL,
    db_password_encrypted TEXT NOT NULL,
    is_primary BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    max_connections INTEGER DEFAULT 10,
    connection_timeout INTEGER DEFAULT 30,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, connection_name)
);

-- 6. 创建租户业务 Schema 配置表
CREATE TABLE IF NOT EXISTS management.tenant_schemas (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    database_id INTEGER NOT NULL REFERENCES management.tenant_databases(id) ON DELETE CASCADE,
    schema_name VARCHAR(100) NOT NULL,
    business_type VARCHAR(100) NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(database_id, schema_name)
);

-- 7. 创建用户-租户关联表
CREATE TABLE IF NOT EXISTS management.user_tenants (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL DEFAULT 'member',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, tenant_id)
);

-- 8. 创建连接访问日志表
CREATE TABLE IF NOT EXISTS management.connection_access_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    tenant_id INTEGER REFERENCES management.tenants(id),
    database_id INTEGER REFERENCES management.tenant_databases(id),
    action VARCHAR(50) NOT NULL,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 8.5 创建 API Keys 表 (Auto API 认证)
CREATE TABLE IF NOT EXISTS management.api_keys (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    database_id INTEGER NOT NULL REFERENCES management.tenant_databases(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    key_hash VARCHAR(128) NOT NULL,  -- SHA256 哈希
    key_prefix VARCHAR(12) NOT NULL, -- 显示用前缀，如 "ob_abc123..."
    permissions JSONB DEFAULT '{"read": true, "write": true, "delete": true}',
    is_active BOOLEAN DEFAULT true,
    last_used_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,
    UNIQUE(key_hash)
);

-- 9. 创建索引
CREATE INDEX IF NOT EXISTS idx_tenant_databases_tenant_id ON management.tenant_databases(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_databases_active ON management.tenant_databases(is_active);
CREATE INDEX IF NOT EXISTS idx_tenant_schemas_tenant_id ON management.tenant_schemas(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_schemas_database_id ON management.tenant_schemas(database_id);
CREATE INDEX IF NOT EXISTS idx_user_tenants_user_id ON management.user_tenants(user_id);
CREATE INDEX IF NOT EXISTS idx_user_tenants_tenant_id ON management.user_tenants(tenant_id);
CREATE INDEX IF NOT EXISTS idx_connection_logs_tenant_id ON management.connection_access_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_connection_logs_created_at ON management.connection_access_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_users_superadmin ON users(is_superadmin) WHERE is_superadmin = true;
CREATE INDEX IF NOT EXISTS idx_api_keys_database_id ON management.api_keys(database_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON management.api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON management.api_keys(is_active) WHERE is_active = true;

-- 10. 创建更新时间触发器函数
CREATE OR REPLACE FUNCTION management.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- 11. 添加触发器
DROP TRIGGER IF EXISTS update_tenants_updated_at ON management.tenants;
CREATE TRIGGER update_tenants_updated_at 
    BEFORE UPDATE ON management.tenants
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();

DROP TRIGGER IF EXISTS update_tenant_databases_updated_at ON management.tenant_databases;
CREATE TRIGGER update_tenant_databases_updated_at 
    BEFORE UPDATE ON management.tenant_databases
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();

DROP TRIGGER IF EXISTS update_tenant_schemas_updated_at ON management.tenant_schemas;
CREATE TRIGGER update_tenant_schemas_updated_at 
    BEFORE UPDATE ON management.tenant_schemas
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();

-- 12. 创建用户可访问的租户和连接视图
CREATE OR REPLACE VIEW management.v_user_connections AS
SELECT 
    u.id AS user_id,
    u.username,
    t.id AS tenant_id,
    t.name AS tenant_name,
    td.id AS database_id,
    td.connection_name,
    td.db_host,
    td.db_port,
    td.db_name,
    td.is_primary,
    ut.role AS user_role
FROM users u
JOIN management.user_tenants ut ON ut.user_id = u.id AND ut.is_active = true
JOIN management.tenants t ON t.id = ut.tenant_id AND t.status = 'active'
JOIN management.tenant_databases td ON td.tenant_id = t.id AND td.is_active = true;

-- 13. 创建超管视图
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

-- 14. 插入示例数据
INSERT INTO management.tenants (name, slug, contact_email) VALUES
    ('示例公司A', 'company-a', 'admin@company-a.com'),
    ('示例公司B', 'company-b', 'admin@company-b.com')
ON CONFLICT (slug) DO NOTHING;

-- 15-16. 不再自动种 tenant_databases / tenant_schemas
--
-- 历史上这里写死了 db_user='postgres' / password='ENCRYPTED:123456' 占位行，
-- 但大多数本地 / CI / 生产环境根本没有这样的账号，结果 dashboard 一切到这个项目就
-- 报 `password authentication failed`。请通过超管 UI 或 POST /api/admin/tenants/create
-- 创建真实连接（密码会自动用 v2 AES-256-GCM 加密）。
--
-- 想本地一键种几个开发用连接，可以在这里追加 INSERT，跑完后用：
--   cargo run --bin migrate_passwords
-- 把 ENCRYPTED: 前缀的明文密码升级到 v2 格式。

-- 17. 关联 admin 用户到所有租户（作为 owner）
INSERT INTO management.user_tenants (user_id, tenant_id, role)
SELECT 
    u.id,
    t.id,
    'owner'
FROM users u
CROSS JOIN management.tenants t
WHERE u.username = 'admin'
ON CONFLICT (user_id, tenant_id) DO NOTHING;

-- 完成提示
SELECT 
    '✅ 多租户功能初始化完成！' AS message,
    '已创建 management schema 和相关表' AS step1,
    'admin 用户已设置为超级管理员' AS step2,
    '已创建示例租户和连接' AS step3,
    '请重启前端页面查看效果' AS next_step;

