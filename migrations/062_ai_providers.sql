-- 项目级 AI Provider 配置。
-- api_key_enc 使用 crypto::encrypt_secret(AES-256-GCM) 加密，任何 API 响应均不得返回该列。
CREATE TABLE IF NOT EXISTS management.ai_providers (
    id              SERIAL PRIMARY KEY,
    tenant_id       INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    provider        VARCHAR(24) NOT NULL,
    name            VARCHAR(120) NOT NULL,
    base_url        TEXT NOT NULL,
    model           VARCHAR(160) NOT NULL,
    api_key_enc     TEXT NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    is_default      BOOLEAN NOT NULL DEFAULT false,
    created_by      INTEGER,
    updated_by      INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ai_providers_kind_check CHECK (provider IN ('openai', 'anthropic', 'qwen')),
    CONSTRAINT ai_providers_default_active_check CHECK (NOT is_default OR is_active),
    CONSTRAINT ai_providers_tenant_name_unique UNIQUE (tenant_id, name)
);

-- 幂等升级早期 062：首版其余列已存在，状态列是在后续复核中补入。
ALTER TABLE management.ai_providers
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

-- 先修复历史脏状态，再添加 CHECK。停用项永远不能是默认项。
UPDATE management.ai_providers
SET is_default = false
WHERE is_active = false AND is_default = true;

-- 防御性收敛：若旧索引曾缺失而产生多个 active default，每项目只保留 id 最小的一项。
WITH ranked_defaults AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY id) AS rn
    FROM management.ai_providers
    WHERE is_active = true AND is_default = true
)
UPDATE management.ai_providers p
SET is_default = false
FROM ranked_defaults r
WHERE p.id = r.id AND r.rn > 1;

-- 每个存在 active Provider、但没有 active default 的项目，回填 id 最小的一项。
WITH missing_defaults AS (
    SELECT tenant_id, MIN(id) AS provider_id
    FROM management.ai_providers p
    WHERE p.is_active = true
      AND NOT EXISTS (
          SELECT 1
          FROM management.ai_providers d
          WHERE d.tenant_id = p.tenant_id
            AND d.is_active = true
            AND d.is_default = true
      )
    GROUP BY tenant_id
)
UPDATE management.ai_providers p
SET is_default = true
FROM missing_defaults m
WHERE p.id = m.provider_id;

-- CREATE TABLE IF NOT EXISTS 不会给已存在表补约束，故通过 catalog 幂等添加。
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'management.ai_providers'::regclass
          AND conname = 'ai_providers_default_active_check'
    ) THEN
        ALTER TABLE management.ai_providers
            ADD CONSTRAINT ai_providers_default_active_check
            CHECK (NOT is_default OR is_active);
    END IF;
END
$$;

-- 每个项目至多一个“已启用的默认 Provider”；停用项不参与唯一约束。
-- DROP + CREATE 确保已运行早期 062 的数据库也能替换旧 predicate。
DROP INDEX IF EXISTS management.uq_ai_providers_one_default;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_providers_one_default
    ON management.ai_providers(tenant_id) WHERE is_active = true AND is_default = true;
CREATE INDEX IF NOT EXISTS idx_ai_providers_tenant
    ON management.ai_providers(tenant_id, id);

DROP TRIGGER IF EXISTS update_ai_providers_updated_at ON management.ai_providers;
CREATE TRIGGER update_ai_providers_updated_at
    BEFORE UPDATE ON management.ai_providers
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();
