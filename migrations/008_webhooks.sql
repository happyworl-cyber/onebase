-- Webhook 配置表
CREATE TABLE IF NOT EXISTS management.webhooks (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    url TEXT NOT NULL,
    event_pattern VARCHAR(200) NOT NULL,  -- 如 "public.posts.INSERT" 或 "public.*.UPDATE" 或 "*.*.*"
    headers JSONB DEFAULT '{}',
    secret VARCHAR(500),                   -- 用于签名验证
    retry_count INTEGER DEFAULT 3,
    timeout_ms INTEGER DEFAULT 5000,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Webhook 执行日志
CREATE TABLE IF NOT EXISTS management.webhook_logs (
    id BIGSERIAL PRIMARY KEY,
    webhook_id INTEGER NOT NULL REFERENCES management.webhooks(id) ON DELETE CASCADE,
    event_data JSONB NOT NULL,
    response_status INTEGER,
    response_body TEXT,
    attempt INTEGER DEFAULT 1,
    success BOOLEAN DEFAULT false,
    error_message TEXT,
    duration_ms INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhooks_tenant ON management.webhooks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_active ON management.webhooks(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_webhook_logs_webhook ON management.webhook_logs(webhook_id);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_created ON management.webhook_logs(created_at);

CREATE TRIGGER update_webhooks_updated_at BEFORE UPDATE ON management.webhooks
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();
