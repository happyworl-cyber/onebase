-- IdP / OIDC 基础表（Phase 1, slice 1）
--
-- 设计映射：
-- - 设计文档里的“项目”在当前仓库中对应 management.tenants
-- - 项目级凭证库          -> management.project_idp_providers
-- - OAuth2 应用注册表     -> management.oauth2_clients
-- - 应用级 Provider 开关  -> management.oauth2_client_providers

CREATE TABLE IF NOT EXISTS management.project_idp_providers (
    id                SERIAL PRIMARY KEY,
    tenant_id         INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    provider_type     VARCHAR(32) NOT NULL,
    display_name      VARCHAR(64),
    client_id         VARCHAR(256) NOT NULL,
    client_secret_enc TEXT NOT NULL,
    is_enabled        BOOLEAN NOT NULL DEFAULT true,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, provider_type)
);

CREATE INDEX IF NOT EXISTS idx_project_idp_providers_tenant_id
    ON management.project_idp_providers(tenant_id);

CREATE TABLE IF NOT EXISTS management.oauth2_clients (
    id                 SERIAL PRIMARY KEY,
    tenant_id          INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    client_id          VARCHAR(64) NOT NULL UNIQUE,
    client_secret_hash VARCHAR(128) NOT NULL,
    display_name       VARCHAR(200) NOT NULL,
    redirect_uris      TEXT[] NOT NULL,
    allowed_scopes     TEXT[] NOT NULL DEFAULT ARRAY['openid', 'email', 'profile'],
    access_token_ttl   INTEGER NOT NULL DEFAULT 900,
    refresh_token_ttl  INTEGER NOT NULL DEFAULT 2592000,
    require_pkce       BOOLEAN NOT NULL DEFAULT true,
    is_active          BOOLEAN NOT NULL DEFAULT true,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth2_clients_tenant_id
    ON management.oauth2_clients(tenant_id);

CREATE TABLE IF NOT EXISTS management.oauth2_client_providers (
    id            SERIAL PRIMARY KEY,
    client_id     VARCHAR(64) NOT NULL REFERENCES management.oauth2_clients(client_id) ON DELETE CASCADE,
    provider_type VARCHAR(32) NOT NULL,
    is_enabled    BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (client_id, provider_type)
);

CREATE INDEX IF NOT EXISTS idx_oauth2_client_providers_client_id
    ON management.oauth2_client_providers(client_id);

DROP TRIGGER IF EXISTS tr_project_idp_providers_updated ON management.project_idp_providers;
CREATE TRIGGER tr_project_idp_providers_updated
    BEFORE UPDATE ON management.project_idp_providers
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();
