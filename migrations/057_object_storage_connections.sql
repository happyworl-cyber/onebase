-- migrations/057_object_storage_connections.sql
--
-- 对象存储数据源：租户登记 COS / OSS / MinIO（S3 兼容），之后可通过
--   1) 管理 API（/api/admin/object-storage-connections/*）维护连接 + health
--   2) 数据 API（/api/object-storage-connections/:id/exec）put/get/delete/list/presign
-- 统一使用。工作流节点 / Access Token 代理留待后续期。

CREATE TABLE IF NOT EXISTS management.object_storage_connections (
    id                   BIGSERIAL PRIMARY KEY,
    tenant_id            INTEGER NOT NULL
                         REFERENCES management.tenants(id) ON DELETE CASCADE,
    connection_name      VARCHAR(100) NOT NULL,
    provider             TEXT NOT NULL
                         CHECK (provider IN ('minio', 'cos', 'oss')),
    endpoint             TEXT NOT NULL,
    region               TEXT NOT NULL DEFAULT 'us-east-1',
    bucket               TEXT NOT NULL,
    access_key_id        TEXT NOT NULL,
    secret_key_enc       TEXT NOT NULL,
    force_path_style     BOOLEAN NOT NULL DEFAULT false,
    connect_timeout_secs INTEGER NOT NULL DEFAULT 5
                         CHECK (connect_timeout_secs BETWEEN 1 AND 60),
    is_active            BOOLEAN NOT NULL DEFAULT true,
    created_by           INTEGER NOT NULL
                         REFERENCES users(id) ON DELETE RESTRICT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_object_storage_conn_name UNIQUE (tenant_id, connection_name),
    CONSTRAINT chk_object_storage_endpoint CHECK (
        endpoint ~ '^https?://[^[:space:]]+$'
    ),
    CONSTRAINT chk_object_storage_bucket CHECK (
        bucket ~ '^[^[:space:]]+$'
    )
);

CREATE INDEX IF NOT EXISTS idx_object_storage_connections_tenant
    ON management.object_storage_connections(tenant_id)
    WHERE is_active;
