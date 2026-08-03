-- IdP 登录日志（审计事件流）
--
-- 记录每次通过 OneBase 完成的社交登录事件，供项目管理台「登录日志」查看：
-- - event：login（已有身份登录）/ register（首次创建身份）
-- - status：success / failure（上游授权失败等）
-- 仅存审计所需的最小信息，不含 token 明文。

CREATE TABLE IF NOT EXISTS management.idp_login_logs (
    id            SERIAL PRIMARY KEY,
    tenant_id     INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    client_id     VARCHAR(64),
    provider      VARCHAR(32) NOT NULL,
    identity_id   INTEGER,
    sub           VARCHAR(36),
    email         VARCHAR(320),
    event         VARCHAR(16) NOT NULL DEFAULT 'login',   -- login | register
    status        VARCHAR(16) NOT NULL DEFAULT 'success', -- success | failure
    error         TEXT,
    ip            VARCHAR(64),
    user_agent    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_idp_login_logs_tenant_created
    ON management.idp_login_logs(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_idp_login_logs_client
    ON management.idp_login_logs(client_id);
