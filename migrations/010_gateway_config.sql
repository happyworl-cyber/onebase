-- 精细化限流规则表
CREATE TABLE IF NOT EXISTS management.rate_limit_rules (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER REFERENCES management.tenants(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    rule_type VARCHAR(20) NOT NULL CHECK (rule_type IN ('tenant', 'user', 'endpoint', 'ip')),
    match_pattern VARCHAR(500),       -- 例如 "/api/v1/*" 或具体 user_id
    max_requests INTEGER NOT NULL,
    window_seconds INTEGER NOT NULL DEFAULT 60,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_rules_active ON management.rate_limit_rules(is_active) WHERE is_active = true;

CREATE TRIGGER update_rate_limit_rules_updated_at BEFORE UPDATE ON management.rate_limit_rules
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();
