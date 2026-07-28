-- 读写分离：扩展 tenant_databases 表支持 Replica 角色

-- 添加 role 字段：primary / replica
ALTER TABLE management.tenant_databases
    ADD COLUMN IF NOT EXISTS db_role VARCHAR(20) DEFAULT 'primary'
        CHECK (db_role IN ('primary', 'replica'));

-- replica 指向其 primary
ALTER TABLE management.tenant_databases
    ADD COLUMN IF NOT EXISTS primary_id INTEGER REFERENCES management.tenant_databases(id) ON DELETE SET NULL;

-- 连接权重（用于负载均衡）
ALTER TABLE management.tenant_databases
    ADD COLUMN IF NOT EXISTS weight INTEGER DEFAULT 1;

-- 索引
CREATE INDEX IF NOT EXISTS idx_tenant_databases_role
    ON management.tenant_databases(db_role);
CREATE INDEX IF NOT EXISTS idx_tenant_databases_primary
    ON management.tenant_databases(primary_id);
