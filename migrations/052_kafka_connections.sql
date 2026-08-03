-- Kafka 数据源：租户登记 broker，供管理 API / kafka 节点 / kafka 触发器共用。
-- 对齐 046_redis_connections.sql：租户隔离、密钥 AES-GCM、is_active 软停用。

CREATE TABLE IF NOT EXISTS management.kafka_connections (
    id                        BIGSERIAL PRIMARY KEY,
    tenant_id                 INTEGER NOT NULL
                              REFERENCES management.tenants(id) ON DELETE CASCADE,
    connection_name           VARCHAR(100) NOT NULL,
    brokers                   TEXT NOT NULL,
    security_protocol         TEXT NOT NULL DEFAULT 'PLAINTEXT'
                              CHECK (security_protocol IN (
                                  'PLAINTEXT', 'SASL_PLAINTEXT', 'SASL_SSL', 'SSL'
                              )),
    sasl_mechanism            TEXT
                              CHECK (sasl_mechanism IS NULL OR sasl_mechanism IN (
                                  'PLAIN', 'SCRAM-SHA-256', 'SCRAM-SHA-512'
                              )),
    sasl_username             TEXT,
    sasl_password_enc         TEXT,
    tls_insecure_skip_verify  BOOLEAN NOT NULL DEFAULT false,
    connect_timeout_secs      INTEGER NOT NULL DEFAULT 5
                              CHECK (connect_timeout_secs BETWEEN 1 AND 60),
    is_active                 BOOLEAN NOT NULL DEFAULT true,
    created_by                INTEGER NOT NULL
                              REFERENCES users(id) ON DELETE RESTRICT,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_kafka_conn_name UNIQUE (tenant_id, connection_name),
    CONSTRAINT chk_kafka_conn_brokers CHECK (brokers ~ '^[^[:space:]]')
);

CREATE INDEX IF NOT EXISTS idx_kafka_connections_tenant
    ON management.kafka_connections(tenant_id)
    WHERE is_active;
