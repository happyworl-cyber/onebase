-- 072: 项目级 LLM 连接：OpenAI 兼容 Chat Completions 根地址 + 可选凭证 + 模型列表。
-- 密钥不进本表，走 management.wf_credentials（credential_id）。
-- 工作流 llm 节点只引用 connection_id，运行时不可改写 base_url。

CREATE TABLE IF NOT EXISTS management.llm_connections (
    id                   BIGSERIAL PRIMARY KEY,
    tenant_id            INTEGER NOT NULL
                         REFERENCES management.tenants(id) ON DELETE CASCADE,
    connection_name      VARCHAR(100) NOT NULL,
    base_url             TEXT NOT NULL,
    credential_id        INTEGER
                         REFERENCES management.wf_credentials(id) ON DELETE SET NULL,
    models               TEXT[] NOT NULL DEFAULT '{}',
    is_active            BOOLEAN NOT NULL DEFAULT true,
    created_by           INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_llm_conn_name UNIQUE (tenant_id, connection_name)
);

CREATE INDEX IF NOT EXISTS idx_llm_connections_tenant
    ON management.llm_connections(tenant_id)
    WHERE is_active;
