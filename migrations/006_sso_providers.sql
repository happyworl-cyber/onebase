-- SSO / OAuth2 Provider 配置表
-- 每个租户可以配置自己的 SSO 提供商

CREATE TABLE IF NOT EXISTS management.sso_providers (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    provider_type VARCHAR(50) NOT NULL CHECK (provider_type IN ('google', 'facebook', 'github', 'oidc')),
    display_name VARCHAR(200) NOT NULL,
    client_id VARCHAR(500) NOT NULL,
    client_secret_encrypted VARCHAR(1000) NOT NULL,
    -- OAuth2 端点（OIDC 类型需手动配置，其余自动填充）
    authorization_url VARCHAR(1000),
    token_url VARCHAR(1000),
    userinfo_url VARCHAR(1000),
    -- 额外配置
    scopes VARCHAR(500) DEFAULT 'openid email profile',
    extra_params JSONB DEFAULT '{}'::jsonb,
    -- 用户映射配置
    user_id_field VARCHAR(100) DEFAULT 'sub',
    email_field VARCHAR(100) DEFAULT 'email',
    name_field VARCHAR(100) DEFAULT 'name',
    avatar_field VARCHAR(100) DEFAULT 'picture',
    -- 状态
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, provider_type)
);

-- SSO 用户关联表（将外部身份映射到本地用户）
CREATE TABLE IF NOT EXISTS management.sso_user_links (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_id INTEGER NOT NULL REFERENCES management.sso_providers(id) ON DELETE CASCADE,
    external_user_id VARCHAR(500) NOT NULL,
    external_email VARCHAR(320),
    external_name VARCHAR(200),
    external_avatar VARCHAR(1000),
    access_token_encrypted VARCHAR(2000),
    refresh_token_encrypted VARCHAR(2000),
    token_expires_at TIMESTAMPTZ,
    raw_profile JSONB,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(provider_id, external_user_id)
);

-- SSO 登录状态表（防止 CSRF，存储 OAuth state）
CREATE TABLE IF NOT EXISTS management.sso_states (
    id SERIAL PRIMARY KEY,
    state_token VARCHAR(200) NOT NULL UNIQUE,
    provider_id INTEGER NOT NULL REFERENCES management.sso_providers(id) ON DELETE CASCADE,
    redirect_url VARCHAR(1000),
    tenant_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '10 minutes'
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_sso_providers_tenant ON management.sso_providers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sso_user_links_user ON management.sso_user_links(user_id);
CREATE INDEX IF NOT EXISTS idx_sso_user_links_external ON management.sso_user_links(provider_id, external_user_id);
CREATE INDEX IF NOT EXISTS idx_sso_states_token ON management.sso_states(state_token);
CREATE INDEX IF NOT EXISTS idx_sso_states_expires ON management.sso_states(expires_at);

-- 自动清理过期的 state（可选，由应用定期调用）
-- DELETE FROM management.sso_states WHERE expires_at < NOW();

-- updated_at 触发器
CREATE OR REPLACE FUNCTION management.update_sso_provider_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_sso_providers_updated ON management.sso_providers;
CREATE TRIGGER tr_sso_providers_updated
    BEFORE UPDATE ON management.sso_providers
    FOR EACH ROW EXECUTE FUNCTION management.update_sso_provider_timestamp();
