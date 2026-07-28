-- ============================================
-- RBAC 权限引擎数据表
-- ============================================
-- 运行方式: cargo run --bin migrate_rbac

-- 1. 角色表
CREATE TABLE IF NOT EXISTS management.roles (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    is_system BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, name)
);

-- 2. 权限定义表
CREATE TABLE IF NOT EXISTS management.permissions (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    resource VARCHAR(200) NOT NULL,
    action VARCHAR(20) NOT NULL CHECK (action IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL')),
    conditions JSONB DEFAULT '[]'::jsonb,
    allowed_columns JSONB DEFAULT NULL,
    denied_columns JSONB DEFAULT '[]'::jsonb,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. 角色-权限关联表
CREATE TABLE IF NOT EXISTS management.role_permissions (
    id SERIAL PRIMARY KEY,
    role_id INTEGER NOT NULL REFERENCES management.roles(id) ON DELETE CASCADE,
    permission_id INTEGER NOT NULL REFERENCES management.permissions(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(role_id, permission_id)
);

-- 4. 用户-角色关联表
CREATE TABLE IF NOT EXISTS management.user_roles (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES management.roles(id) ON DELETE CASCADE,
    tenant_id INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, role_id, tenant_id)
);

-- 5. 索引
CREATE INDEX IF NOT EXISTS idx_roles_tenant_id ON management.roles(tenant_id);
CREATE INDEX IF NOT EXISTS idx_permissions_tenant_id ON management.permissions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_permissions_resource_action ON management.permissions(tenant_id, resource, action);
CREATE INDEX IF NOT EXISTS idx_role_permissions_role_id ON management.role_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_permission_id ON management.role_permissions(permission_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON management.user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_tenant_id ON management.user_roles(tenant_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_user_tenant ON management.user_roles(user_id, tenant_id);

-- 6. 更新时间触发器
DROP TRIGGER IF EXISTS update_roles_updated_at ON management.roles;
CREATE TRIGGER update_roles_updated_at
    BEFORE UPDATE ON management.roles
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();

DROP TRIGGER IF EXISTS update_permissions_updated_at ON management.permissions;
CREATE TRIGGER update_permissions_updated_at
    BEFORE UPDATE ON management.permissions
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();

-- 7. 为每个现有租户插入系统预设角色
INSERT INTO management.roles (tenant_id, name, description, is_system)
SELECT t.id, r.name, r.description, true
FROM management.tenants t
CROSS JOIN (VALUES
    ('superadmin', '超级管理员，拥有全部权限'),
    ('admin', '管理员，拥有所有 CRUD 权限'),
    ('editor', '编辑者，可查询、创建和更新'),
    ('viewer', '观察者，仅可查询')
) AS r(name, description)
ON CONFLICT (tenant_id, name) DO NOTHING;
