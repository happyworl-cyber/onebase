-- 对象存储访问令牌：外部系统用 cres_os_* 调 put/get/delete/list/presign/health，无需平台登录。
-- 对齐 053_kafka_access_tokens；ACL 为 allowed_ops + key_prefix_allowlist。

CREATE TABLE IF NOT EXISTS management.object_storage_access_tokens (
    id                    BIGSERIAL PRIMARY KEY,
    connection_id         BIGINT NOT NULL
                          REFERENCES management.object_storage_connections(id) ON DELETE CASCADE,
    name                  VARCHAR(100) NOT NULL,
    description           TEXT,
    token_hash            CHAR(64) NOT NULL UNIQUE,
    token_prefix          VARCHAR(24) NOT NULL,
    allowed_ops           TEXT[] NOT NULL DEFAULT ARRAY['put','get','delete','list','presign','health']::TEXT[],
    key_prefix_allowlist  TEXT[] NOT NULL DEFAULT ARRAY['*']::TEXT[],
    expires_at            TIMESTAMPTZ,
    last_used_at          TIMESTAMPTZ,
    use_count             BIGINT NOT NULL DEFAULT 0,
    is_active             BOOLEAN NOT NULL DEFAULT true,
    revoked_at            TIMESTAMPTZ,
    created_by            INTEGER NOT NULL
                          REFERENCES users(id) ON DELETE RESTRICT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_object_storage_token_ops CHECK (
        array_length(allowed_ops, 1) IS NOT NULL
        AND NOT (allowed_ops && ARRAY[NULL, '']::TEXT[])
    ),
    CONSTRAINT chk_object_storage_token_keys CHECK (
        array_length(key_prefix_allowlist, 1) IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_object_storage_tokens_hash_active
    ON management.object_storage_access_tokens(token_hash)
    WHERE is_active AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_object_storage_tokens_connection
    ON management.object_storage_access_tokens(connection_id);
