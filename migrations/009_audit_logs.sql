-- 审计日志表
CREATE TABLE IF NOT EXISTS management.audit_logs (
    id BIGSERIAL PRIMARY KEY,
    tenant_id INTEGER,
    user_id INTEGER,
    action VARCHAR(20) NOT NULL,        -- GET, POST, PATCH, DELETE
    resource VARCHAR(500) NOT NULL,      -- 请求路径
    request_method VARCHAR(10) NOT NULL,
    request_path TEXT NOT NULL,
    request_body JSONB,
    response_status INTEGER,
    ip_address VARCHAR(45),
    user_agent TEXT,
    duration_ms INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 慢查询日志表
CREATE TABLE IF NOT EXISTS management.slow_query_logs (
    id BIGSERIAL PRIMARY KEY,
    tenant_id INTEGER,
    user_id INTEGER,
    database_id INTEGER,
    schema_name VARCHAR(200),
    table_name VARCHAR(200),
    sql_preview TEXT,
    duration_ms INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant ON management.audit_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON management.audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON management.audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON management.audit_logs(action);

CREATE INDEX IF NOT EXISTS idx_slow_query_created ON management.slow_query_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_slow_query_duration ON management.slow_query_logs(duration_ms);
