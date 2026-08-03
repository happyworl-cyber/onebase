-- 平台监控：分钟采样 + 平台级阈值告警配置

CREATE TABLE IF NOT EXISTS management.platform_metric_samples (
    id BIGSERIAL PRIMARY KEY,
    sampled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    qps_5min DOUBLE PRECISION,
    p95_ms_5min DOUBLE PRECISION,
    error_rate_24h DOUBLE PRECISION,
    calls_5min BIGINT,
    slow_queries_5min BIGINT,
    mgmt_db_ok BOOLEAN,
    redis_ok BOOLEAN,
    mgmt_pool_size INT,
    mgmt_pool_idle INT,
    active_pools INT,
    circuit_open_count INT,
    rate_limit_degraded BOOLEAN,
    rate_limit_fallback_rejected BIGINT,
    exec_failed_24h BIGINT,
    scheduler_failed_24h BIGINT,
    sse_connections INT
);

CREATE INDEX IF NOT EXISTS idx_platform_metric_samples_sampled_at
    ON management.platform_metric_samples (sampled_at DESC);

CREATE TABLE IF NOT EXISTS management.platform_alert_config (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled BOOLEAN NOT NULL DEFAULT false,
    webhook_url TEXT,
    webhook_template JSONB,
    default_throttle_hours INT NOT NULL DEFAULT 1
        CHECK (default_throttle_hours BETWEEN 0 AND 720),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT platform_alert_config_url_chk CHECK (
        webhook_url IS NULL OR (
            length(trim(webhook_url)) > 0
            AND webhook_url ~ '^https?://'
        )
    ),
    CONSTRAINT platform_alert_config_template_chk CHECK (
        webhook_template IS NULL OR jsonb_typeof(webhook_template) = 'object'
    )
);

INSERT INTO management.platform_alert_config (id, enabled)
VALUES (1, false)
ON CONFLICT (id) DO NOTHING;

-- metric_window：勿用 window（PG 保留字）
CREATE TABLE IF NOT EXISTS management.platform_alert_rules (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    metric TEXT NOT NULL,
    operator TEXT NOT NULL CHECK (operator IN ('>', '>=', '==', '<', '<=')),
    threshold DOUBLE PRECISION NOT NULL,
    metric_window TEXT NOT NULL DEFAULT 'live',
    enabled BOOLEAN NOT NULL DEFAULT true,
    throttle_hours INT CHECK (throttle_hours IS NULL OR throttle_hours BETWEEN 0 AND 720),
    last_fired_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT platform_alert_rules_metric_chk CHECK (
        metric IN (
            'error_rate_24h',
            'circuit_open_count',
            'rate_limit_degraded',
            'slow_queries_5min',
            'exec_failed_24h',
            'mgmt_db_ok',
            'redis_ok',
            'qps_5min',
            'p95_ms_5min',
            'scheduler_failed_24h'
        )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_alert_rules_name
    ON management.platform_alert_rules (name);

CREATE TABLE IF NOT EXISTS management.platform_alert_events (
    id BIGSERIAL PRIMARY KEY,
    rule_id BIGINT REFERENCES management.platform_alert_rules(id) ON DELETE SET NULL,
    rule_name TEXT NOT NULL,
    metric TEXT NOT NULL,
    value DOUBLE PRECISION,
    threshold DOUBLE PRECISION,
    status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'throttled', 'skipped')),
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_alert_events_created_at
    ON management.platform_alert_events (created_at DESC);

INSERT INTO management.platform_alert_rules (name, metric, operator, threshold, metric_window, enabled)
VALUES
    ('24h 错误率过高', 'error_rate_24h', '>', 0.05, '24h', true),
    ('存在熔断 Open', 'circuit_open_count', '>=', 1, 'live', true),
    ('限流 Redis 降级', 'rate_limit_degraded', '>=', 1, 'live', true),
    ('5 分钟慢查询突增', 'slow_queries_5min', '>', 20, '5m', true),
    ('24h 异步执行失败过多', 'exec_failed_24h', '>', 50, '24h', true),
    ('管理库不健康', 'mgmt_db_ok', '==', 0, 'live', true),
    ('Redis 不健康', 'redis_ok', '==', 0, 'live', true)
ON CONFLICT (name) DO NOTHING;
