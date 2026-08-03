-- migrations/046_redis_connections.sql
--
-- Redis 数据源：让租户把已有的 Redis 实例登记进平台，之后可通过
--   1) 管理 API（/api/admin/redis-connections/*）维护连接
--   2) 数据 API（/api/redis-connections/:id/exec）读写数据
--   3) 工作流 redis 节点
-- 统一使用，而不必在各处硬编码 Redis 地址 / 密码。
--
-- 设计要点（对齐 016_es_proxy.sql）：
--   - 每个连接归属一个租户（tenant_id 不可为 NULL，没有"平台级 Redis 数据源"概念；
--     平台内部缓存 / 限流用的 Redis 走 REDIS_URL，与本表无关）
--   - 密码用 AES-GCM 加密（crate::crypto::encrypt_secret），不存明文；
--     `password_enc` 永不序列化给前端
--   - 仅支持 Standalone 模式（host + port + db_index）；Sentinel / Cluster 留待后续
--   - is_active=false 表示临时停用（不删除，保留配置）

CREATE TABLE IF NOT EXISTS management.redis_connections (
    id                   BIGSERIAL PRIMARY KEY,
    tenant_id            INTEGER NOT NULL
                         REFERENCES management.tenants(id) ON DELETE CASCADE,
    connection_name      VARCHAR(100) NOT NULL,
    host                 TEXT NOT NULL,
    port                 INTEGER NOT NULL DEFAULT 6379
                         CHECK (port BETWEEN 1 AND 65535),
    -- Redis 逻辑库编号；标准部署 0-15，某些配置更多，这里放宽到 0-255。
    db_index             INTEGER NOT NULL DEFAULT 0
                         CHECK (db_index BETWEEN 0 AND 255),
    -- ACL 用户名（Redis 6+）。留空表示传统 `AUTH <password>` 模式。
    username             TEXT,
    -- AES-GCM 加密后的密码；无密码实例为 NULL。**不应直接序列化给前端**。
    password_enc         TEXT,
    -- true → 用 rediss:// 建连（TLS）
    use_tls              BOOLEAN NOT NULL DEFAULT false,
    connect_timeout_secs INTEGER NOT NULL DEFAULT 5
                         CHECK (connect_timeout_secs BETWEEN 1 AND 60),
    is_active            BOOLEAN NOT NULL DEFAULT true,
    -- 用户表在 public.users（与 es_connections / scheduled_tasks 保持一致）
    created_by           INTEGER NOT NULL
                         REFERENCES users(id) ON DELETE RESTRICT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_redis_conn_name UNIQUE (tenant_id, connection_name),
    -- host 不允许空白 / 换行等
    CONSTRAINT chk_redis_conn_host CHECK (
        host ~ '^[^[:space:]]+$'
    )
);

CREATE INDEX IF NOT EXISTS idx_redis_connections_tenant
    ON management.redis_connections(tenant_id)
    WHERE is_active;
