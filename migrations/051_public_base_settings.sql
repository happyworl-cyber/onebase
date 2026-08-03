-- 对外调用基址（网关域名）设置表，按作用域存储：
--   tenant_id IS NULL  → 平台全局默认（超管配置）
--   tenant_id = <项目id> → 项目级配置（项目 admin 配置，优先级高于平台全局）
--
-- 接口文档展示的调用地址据此拼接。运行期解析优先级：
--   项目级 > 平台全局 > PUBLIC_BASE_URL 环境变量 > 反代转发头 / origin。

CREATE TABLE IF NOT EXISTS management.public_base_settings (
    id SERIAL PRIMARY KEY,
    -- NULL = 平台全局；非空 = 项目(tenant)级。项目删除时级联清理。
    tenant_id INT REFERENCES management.tenants(id) ON DELETE CASCADE,
    public_base_url TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT public_base_settings_url_chk CHECK (
        public_base_url IS NULL OR (
            length(trim(public_base_url)) > 0
            AND public_base_url ~ '^https?://'
        )
    )
);

-- 每个项目至多一行。
CREATE UNIQUE INDEX IF NOT EXISTS uq_public_base_settings_tenant
    ON management.public_base_settings (tenant_id) WHERE tenant_id IS NOT NULL;

-- 平台全局至多一行（tenant_id IS NULL）。
CREATE UNIQUE INDEX IF NOT EXISTS uq_public_base_settings_global
    ON management.public_base_settings ((1)) WHERE tenant_id IS NULL;

-- 预置平台全局行（幂等）。
INSERT INTO management.public_base_settings (tenant_id, public_base_url)
SELECT NULL, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM management.public_base_settings WHERE tenant_id IS NULL
);

COMMENT ON TABLE management.public_base_settings IS '对外调用基址(网关域名)设置：tenant_id NULL=平台全局，非空=项目级；项目级优先。';
