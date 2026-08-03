-- IdP / OIDC 运行期表（Phase 1, slice 2）
--
-- 目标：
-- - 支撑 authorize -> upstream callback -> token 授权码流
-- - 支撑 RS256 签名与 JWKS 暴露
-- - 维持“OneBase 仅保存最小身份数据”的边界

CREATE TABLE IF NOT EXISTS management.idp_identities (
    id         SERIAL PRIMARY KEY,
    sub        VARCHAR(36) NOT NULL UNIQUE,
    email      VARCHAR(320),
    name       VARCHAR(200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_idp_identities_email_unique
    ON management.idp_identities(email)
    WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS management.idp_provider_links (
    id            SERIAL PRIMARY KEY,
    identity_id   INTEGER NOT NULL REFERENCES management.idp_identities(id) ON DELETE CASCADE,
    provider      VARCHAR(32) NOT NULL,
    provider_sub  VARCHAR(256) NOT NULL,
    linked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_sub)
);

CREATE INDEX IF NOT EXISTS idx_idp_provider_links_identity_id
    ON management.idp_provider_links(identity_id);

CREATE TABLE IF NOT EXISTS management.idp_authorization_states (
    id                   SERIAL PRIMARY KEY,
    state_token          VARCHAR(200) NOT NULL UNIQUE,
    tenant_id            INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    client_id            VARCHAR(64) NOT NULL REFERENCES management.oauth2_clients(client_id) ON DELETE CASCADE,
    provider_type        VARCHAR(32) NOT NULL,
    redirect_uri         TEXT NOT NULL,
    requested_scopes     TEXT[] NOT NULL,
    downstream_state     TEXT,
    nonce                TEXT,
    response_mode        VARCHAR(32),
    code_challenge       VARCHAR(200),
    code_challenge_method VARCHAR(16),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at           TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '10 minutes'
);

CREATE INDEX IF NOT EXISTS idx_idp_authorization_states_expires_at
    ON management.idp_authorization_states(expires_at);

CREATE TABLE IF NOT EXISTS management.oauth2_auth_codes (
    id               SERIAL PRIMARY KEY,
    code_hash        VARCHAR(128) NOT NULL UNIQUE,
    client_id        VARCHAR(64) NOT NULL REFERENCES management.oauth2_clients(client_id) ON DELETE CASCADE,
    identity_id      INTEGER NOT NULL REFERENCES management.idp_identities(id) ON DELETE CASCADE,
    redirect_uri     TEXT NOT NULL,
    scopes           TEXT[] NOT NULL,
    code_challenge   VARCHAR(200),
    challenge_method VARCHAR(16),
    nonce            TEXT,
    used             BOOLEAN NOT NULL DEFAULT false,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at       TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '10 minutes'
);

CREATE INDEX IF NOT EXISTS idx_oauth2_auth_codes_client_id
    ON management.oauth2_auth_codes(client_id);

CREATE INDEX IF NOT EXISTS idx_oauth2_auth_codes_expires_at
    ON management.oauth2_auth_codes(expires_at);

CREATE TABLE IF NOT EXISTS management.oauth2_refresh_tokens (
    id           SERIAL PRIMARY KEY,
    token_hash   VARCHAR(128) NOT NULL UNIQUE,
    client_id    VARCHAR(64) NOT NULL REFERENCES management.oauth2_clients(client_id) ON DELETE CASCADE,
    identity_id  INTEGER NOT NULL REFERENCES management.idp_identities(id) ON DELETE CASCADE,
    scopes       TEXT[] NOT NULL,
    family_id    VARCHAR(36) NOT NULL,
    revoked      BOOLEAN NOT NULL DEFAULT false,
    rotated      BOOLEAN NOT NULL DEFAULT false,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth2_refresh_tokens_client_id
    ON management.oauth2_refresh_tokens(client_id);

CREATE INDEX IF NOT EXISTS idx_oauth2_refresh_tokens_family_id
    ON management.oauth2_refresh_tokens(family_id);

CREATE TABLE IF NOT EXISTS management.oauth2_signing_keys (
    kid             VARCHAR(64) PRIMARY KEY,
    public_key_pem  TEXT NOT NULL,
    private_key_enc TEXT NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth2_signing_keys_active
    ON management.oauth2_signing_keys(is_active);
