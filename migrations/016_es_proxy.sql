-- migrations/016_es_proxy.sql
--
-- Elasticsearch 反向代理：让业务端连"平台暴露的代理 URL"而不是 ES 直连。
--   1) es_connections    每个租户配置 N 个 ES 集群（base_url + 加密的 ApiKey/Basic）
--   2) es_access_tokens  业务端持有的代理 token；每个 token 关联一个 connection，
--                        独立携带 method / index / path_denylist 三层访问控制
--
-- 设计要点：
--   - ApiKey 与 DB 密码同款 AES-GCM 加密（crate::crypto::encrypt_secret），不存明文
--   - 代理 token 走 sha256(token) 入库（与 management.api_keys 同款），明文仅创建时
--     一次性返回；DB 永远拿不回原文
--   - is_active / revoked_at 双字段：is_active=false 临时停用，revoked_at 是不可逆的"销毁"
--   - 安全过滤默认值偏严：仅放行 GET/HEAD/POST；path_denylist 拦截 _cluster / _security /
--     _ilm / _snapshot / _shutdown 等运维类端点

-- ── es_connections ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS management.es_connections (
    id                   BIGSERIAL PRIMARY KEY,
    tenant_id            INTEGER NOT NULL
                         REFERENCES management.tenants(id) ON DELETE CASCADE,
    connection_name      VARCHAR(100) NOT NULL,
    base_url             TEXT NOT NULL,
    -- 'api_key' → Authorization: ApiKey <base64>
    -- 'basic'   → Authorization: Basic <base64(user:pass)>
    -- 'none'    → 不注入鉴权头（适合内网无认证 ES，自担风险）
    auth_type            VARCHAR(20) NOT NULL DEFAULT 'api_key'
                         CHECK (auth_type IN ('api_key','basic','none')),
    -- 加密的凭据明文：
    --   api_key 模式 → 直接是 ES 控制台拿到的 `id:api_key` 或已 base64 的字符串
    --   basic   模式 → `username:password`
    --   none    模式 → NULL
    auth_credential_enc  TEXT,
    verify_tls           BOOLEAN NOT NULL DEFAULT true,
    default_timeout_secs INTEGER NOT NULL DEFAULT 30
                         CHECK (default_timeout_secs BETWEEN 1 AND 600),
    is_active            BOOLEAN NOT NULL DEFAULT true,
    -- 用户表实际在 public.users（与 scheduled_tasks / sso_users 等保持一致），
    -- 不是 management.users —— 历史原因，新表别再走错路径
    created_by           INTEGER NOT NULL
                         REFERENCES users(id) ON DELETE RESTRICT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_es_conn_name UNIQUE (tenant_id, connection_name),
    -- 凭据必须与 auth_type 匹配；防止 'api_key' 模式忘记填 credential 导致 401 风暴
    CONSTRAINT chk_es_conn_cred CHECK (
        (auth_type = 'none' AND auth_credential_enc IS NULL)
        OR (auth_type <> 'none' AND auth_credential_enc IS NOT NULL
            AND length(auth_credential_enc) > 0)
    ),
    -- base_url 必须是 http(s)://；不收 ws:// / ftp:// 等
    CONSTRAINT chk_es_conn_url CHECK (
        base_url ~* '^https?://[^[:space:]]+$'
    )
);

CREATE INDEX IF NOT EXISTS idx_es_connections_tenant
    ON management.es_connections(tenant_id)
    WHERE is_active;

-- ── es_access_tokens ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS management.es_access_tokens (
    id                    BIGSERIAL PRIMARY KEY,
    connection_id         BIGINT NOT NULL
                          REFERENCES management.es_connections(id) ON DELETE CASCADE,
    name                  VARCHAR(100) NOT NULL,
    description           TEXT,
    -- 与 management.api_keys 同款：sha256(plain_token) 的 hex，64 字符
    -- 唯一索引保证查找 O(1) 同时拦截撞库
    token_hash            CHAR(64) NOT NULL UNIQUE,
    -- 列表展示用的"前缀截断"，例如 `cres_es_aB3c…` —— 不参与鉴权
    token_prefix          VARCHAR(20) NOT NULL,

    -- ── 访问控制三层 ──
    -- HTTP 方法白名单。默认拒绝 PUT/DELETE（删索引 / 改 mapping 需另开 token）
    allowed_methods       TEXT[] NOT NULL DEFAULT ARRAY['GET','HEAD','POST']::TEXT[],
    -- index 通配符匹配。元素支持 `*` 与 `?`，例 ['logs-*', 'orders']
    -- 特殊值 ['*'] = 不限制（仍受 path_denylist 约束）
    index_allowlist       TEXT[] NOT NULL DEFAULT ARRAY['*']::TEXT[],
    -- 路径黑名单（POSIX 正则，PG `~` 操作符）；任一匹配整段 path 即拒绝。
    -- 默认值拦截运维 / 安全类端点，避免业务 token 误用挂全集群
    path_denylist         TEXT[] NOT NULL DEFAULT ARRAY[
        '^/?_cluster(/.*)?$',
        '^/?_security(/.*)?$',
        '^/?_ilm(/.*)?$',
        '^/?_snapshot(/.*)?$',
        '^/?_shutdown(/.*)?$',
        '^/?_nodes/.*/(reload_secure_settings|shutdown)$'
    ]::TEXT[],

    expires_at            TIMESTAMPTZ,
    last_used_at          TIMESTAMPTZ,
    use_count             BIGINT NOT NULL DEFAULT 0,
    is_active             BOOLEAN NOT NULL DEFAULT true,
    revoked_at            TIMESTAMPTZ,
    created_by            INTEGER NOT NULL
                          REFERENCES users(id) ON DELETE RESTRICT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- 数组元素都得是非空字符串；防止数组里出现空串导致正则 / 模式匹配崩
    CONSTRAINT chk_es_token_methods CHECK (
        array_length(allowed_methods, 1) IS NOT NULL
        AND NOT (allowed_methods && ARRAY[NULL, '']::TEXT[])
    ),
    CONSTRAINT chk_es_token_allowlist CHECK (
        array_length(index_allowlist, 1) IS NOT NULL
    )
);

-- 鉴权热路径：按 token_hash 直查；is_active 过滤进了 partial index
CREATE INDEX IF NOT EXISTS idx_es_tokens_hash_active
    ON management.es_access_tokens(token_hash)
    WHERE is_active AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_es_tokens_connection
    ON management.es_access_tokens(connection_id);
