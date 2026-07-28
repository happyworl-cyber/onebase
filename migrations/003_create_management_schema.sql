-- ============================================
-- 多租户管理架构
-- ============================================

-- 创建管理 Schema（存储租户元数据）
CREATE SCHEMA IF NOT EXISTS management;

-- 租户表
CREATE TABLE IF NOT EXISTS management.tenants (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(50) UNIQUE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active', -- active, suspended, deleted
    contact_email VARCHAR(255),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 租户数据库连接配置表
CREATE TABLE IF NOT EXISTS management.tenant_databases (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    connection_name VARCHAR(100) NOT NULL, -- 连接显示名称
    db_host VARCHAR(255) NOT NULL,
    db_port INTEGER NOT NULL DEFAULT 5432,
    db_name VARCHAR(100) NOT NULL,
    db_user VARCHAR(100) NOT NULL,
    db_password_encrypted TEXT NOT NULL, -- 加密存储密码
    is_primary BOOLEAN DEFAULT false, -- 是否为主连接
    is_active BOOLEAN DEFAULT true,
    max_connections INTEGER DEFAULT 10, -- 连接池大小
    connection_timeout INTEGER DEFAULT 30, -- 连接超时（秒）
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, connection_name)
);

-- 租户业务 Schema 配置表
CREATE TABLE IF NOT EXISTS management.tenant_schemas (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    database_id INTEGER NOT NULL REFERENCES management.tenant_databases(id) ON DELETE CASCADE,
    schema_name VARCHAR(100) NOT NULL,
    business_type VARCHAR(100) NOT NULL, -- 业务类型：order, inventory, crm, finance, hr 等
    display_name VARCHAR(100) NOT NULL, -- 显示名称
    description TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(database_id, schema_name)
);

-- 用户-租户关联表（支持用户属于多个租户）
CREATE TABLE IF NOT EXISTS management.user_tenants (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL DEFAULT 'member', -- owner, admin, member, viewer
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, tenant_id)
);

-- 连接访问日志表（可选，用于审计）
CREATE TABLE IF NOT EXISTS management.connection_access_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    tenant_id INTEGER REFERENCES management.tenants(id),
    database_id INTEGER REFERENCES management.tenant_databases(id),
    action VARCHAR(50) NOT NULL, -- connect, disconnect, query, error
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_tenant_databases_tenant_id ON management.tenant_databases(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_databases_active ON management.tenant_databases(is_active);
CREATE INDEX IF NOT EXISTS idx_tenant_schemas_tenant_id ON management.tenant_schemas(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_schemas_database_id ON management.tenant_schemas(database_id);
CREATE INDEX IF NOT EXISTS idx_user_tenants_user_id ON management.user_tenants(user_id);
CREATE INDEX IF NOT EXISTS idx_user_tenants_tenant_id ON management.user_tenants(tenant_id);
CREATE INDEX IF NOT EXISTS idx_connection_logs_tenant_id ON management.connection_access_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_connection_logs_created_at ON management.connection_access_logs(created_at);

-- 创建更新时间触发器
CREATE OR REPLACE FUNCTION management.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_tenants_updated_at 
    BEFORE UPDATE ON management.tenants
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();

CREATE TRIGGER update_tenant_databases_updated_at 
    BEFORE UPDATE ON management.tenant_databases
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();

CREATE TRIGGER update_tenant_schemas_updated_at 
    BEFORE UPDATE ON management.tenant_schemas
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();

-- ============================================
-- 插入示例数据
-- ============================================

-- 示例租户
INSERT INTO management.tenants (name, slug, contact_email) VALUES
    ('示例公司A', 'company-a', 'admin@company-a.com'),
    ('示例公司B', 'company-b', 'admin@company-b.com')
ON CONFLICT (slug) DO NOTHING;

-- 注意：示例租户的数据库连接（management.tenant_databases）和业务 schema
-- (management.tenant_schemas) 不在此处自动种入——曾经种过的占位行
-- (db_user='postgres', password='ENCRYPTED:123456') 在大多数环境里都连不上，
-- 反而会让 dashboard 一加载就报 `password authentication failed`。
--
-- 正确做法：
--   1. 通过超管登录 → "项目管理" 页面，调用 POST /api/admin/tenants/create
--      或 POST /api/tenants/connections 创建真实连接（密码会用 v2 AES-256-GCM 加密）；
--   2. 想批量种入开发环境，可在本文件后面追加自定义 INSERT，
--      使用 cargo run --bin migrate_passwords 把明文密码升级到 v2 格式。

-- 关联 admin 用户到租户
INSERT INTO management.user_tenants (user_id, tenant_id, role)
SELECT 
    u.id,
    t.id,
    'owner'
FROM users u
CROSS JOIN management.tenants t
WHERE u.username = 'admin'
ON CONFLICT (user_id, tenant_id) DO NOTHING;

-- ============================================
-- 实用查询视图
-- ============================================

-- 租户完整信息视图
CREATE OR REPLACE VIEW management.v_tenant_info AS
SELECT 
    t.id AS tenant_id,
    t.name AS tenant_name,
    t.slug AS tenant_slug,
    t.status,
    COUNT(DISTINCT td.id) AS database_count,
    COUNT(DISTINCT ts.id) AS schema_count,
    COUNT(DISTINCT ut.user_id) AS user_count,
    t.created_at
FROM management.tenants t
LEFT JOIN management.tenant_databases td ON td.tenant_id = t.id AND td.is_active = true
LEFT JOIN management.tenant_schemas ts ON ts.tenant_id = t.id AND ts.is_active = true
LEFT JOIN management.user_tenants ut ON ut.tenant_id = t.id AND ut.is_active = true
GROUP BY t.id, t.name, t.slug, t.status, t.created_at;

-- 用户可访问的租户和连接视图
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

