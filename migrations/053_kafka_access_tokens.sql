-- Kafka 访问令牌：外部系统用 cres_kafka_* 调 produce / topics / health，无需平台登录。
-- 对齐 016_es_proxy.sql 的 es_access_tokens；ACL 为 allowed_ops + topic_allowlist。

CREATE TABLE IF NOT EXISTS management.kafka_access_tokens (
    id                    BIGSERIAL PRIMARY KEY,
    connection_id         BIGINT NOT NULL
                          REFERENCES management.kafka_connections(id) ON DELETE CASCADE,
    name                  VARCHAR(100) NOT NULL,
    description           TEXT,
    token_hash            CHAR(64) NOT NULL UNIQUE,
    token_prefix          VARCHAR(24) NOT NULL,
    allowed_ops           TEXT[] NOT NULL DEFAULT ARRAY['produce','list_topics','health']::TEXT[],
    topic_allowlist       TEXT[] NOT NULL DEFAULT ARRAY['*']::TEXT[],
    expires_at            TIMESTAMPTZ,
    last_used_at          TIMESTAMPTZ,
    use_count             BIGINT NOT NULL DEFAULT 0,
    is_active             BOOLEAN NOT NULL DEFAULT true,
    revoked_at            TIMESTAMPTZ,
    created_by            INTEGER NOT NULL
                          REFERENCES users(id) ON DELETE RESTRICT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_kafka_token_ops CHECK (
        array_length(allowed_ops, 1) IS NOT NULL
        AND NOT (allowed_ops && ARRAY[NULL, '']::TEXT[])
    ),
    CONSTRAINT chk_kafka_token_topics CHECK (
        array_length(topic_allowlist, 1) IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_kafka_tokens_hash_active
    ON management.kafka_access_tokens(token_hash)
    WHERE is_active AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_kafka_tokens_connection
    ON management.kafka_access_tokens(connection_id);
