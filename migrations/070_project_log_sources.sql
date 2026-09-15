-- 070: 项目云日志源；多条 SLS Logstore 共用一份 aliyun_ak 凭证。
-- 密钥在 wf_credentials，本表只引用 credential_id。

CREATE TABLE IF NOT EXISTS management.project_log_sources (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    provider VARCHAR(32) NOT NULL,
    credential_id INTEGER NOT NULL REFERENCES management.wf_credentials(id) ON DELETE RESTRICT,
    region VARCHAR(64) NOT NULL,
    sls_project VARCHAR(128) NOT NULL,
    logstore VARCHAR(128) NOT NULL,
    endpoint VARCHAR(256),
    query_prefix TEXT,
    created_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT project_log_sources_name_unique UNIQUE (tenant_id, name),
    CONSTRAINT project_log_sources_provider_chk CHECK (provider = 'aliyun_sls')
);

CREATE INDEX IF NOT EXISTS idx_project_log_sources_tenant
    ON management.project_log_sources (tenant_id);

CREATE INDEX IF NOT EXISTS idx_project_log_sources_credential
    ON management.project_log_sources (credential_id);

COMMENT ON TABLE management.project_log_sources IS
    '项目云日志源。密钥在 wf_credentials（aliyun_ak），本表只引用。';

DROP TRIGGER IF EXISTS update_project_log_sources_updated_at ON management.project_log_sources;
CREATE TRIGGER update_project_log_sources_updated_at
    BEFORE UPDATE ON management.project_log_sources
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();
