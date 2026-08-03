-- 工作流「数据源 / 凭证」集成模块
--
-- 目标：让工作流的 db_query / db_execute 节点除了默认使用「工作流绑定库」
-- （workflows.database_id → management.tenant_databases）之外，还能显式选择
-- 项目内共享的数据源（management.wf_datasources）。数据源携带连接信息 + 引用
-- 一份加密凭证（management.wf_credentials）。
--
-- 前端「项目」= 后端 management.tenants，作用域键为 tenant_id。
--
-- 老数据兼容（关键）：
--   本次**不改** workflows 表、也不给已有节点回填字段。db 节点的数据源是
--   「可选覆盖」：节点 config 里没有 datasource_id（老数据即如此）时，执行引擎
--   继续走 workflow.database_id 的默认路径——即设计稿里的「默认（工作流绑定库）」。
--   因此老工作流无需迁移即保持原行为，默认值在**后端执行层**真实存在，
--   不是仅前端展示。

-- ── 凭证：加密存储的连接密钥（用户名/密码 或 Bearer Token）──────────────
CREATE TABLE IF NOT EXISTS management.wf_credentials (
    id            SERIAL PRIMARY KEY,
    -- 所属项目（租户）；项目删除时级联清理
    tenant_id     INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    -- 凭证名（项目内唯一），供数据源下拉引用
    name          VARCHAR(100) NOT NULL,
    -- 凭证类型：basic（用户名/密码）| bearer（令牌）
    kind          VARCHAR(32) NOT NULL DEFAULT 'basic',
    -- basic 类型的用户名；bearer 类型为空
    username      VARCHAR(255),
    -- 密码 / 令牌：crypto::encrypt_secret（AES-256-GCM）密文（v2:base64...）
    secret_encrypted TEXT NOT NULL,
    description   TEXT,
    -- 审计：创建 / 最后修改人（users.id，弱引用不加外键）
    created_by    INTEGER,
    updated_by    INTEGER,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id, name)
);

COMMENT ON COLUMN management.wf_credentials.secret_encrypted IS
    'AES-256-GCM 加密的密码 / 令牌；用 crate::crypto::encrypt_secret 写入，decrypt_secret 读出。密文永不回显。';

-- ── 数据源：连接信息 + 引用一份凭证 ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS management.wf_datasources (
    id            SERIAL PRIMARY KEY,
    tenant_id     INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    -- 数据源名（项目内唯一），节点下拉与画布标记均展示它
    name          VARCHAR(100) NOT NULL,
    description   TEXT,
    -- 数据源类型：postgresql | mysql（执行引擎均已支持）
    ds_type       VARCHAR(32) NOT NULL DEFAULT 'postgresql',
    -- 连接信息：主机名 / IP
    host          VARCHAR(255) NOT NULL DEFAULT '',
    port          INTEGER,
    database      VARCHAR(255),
    -- 引用的凭证；置空表示免密 / 匿名。凭证删除时置空（SET NULL），不连带删数据源
    credential_id INTEGER REFERENCES management.wf_credentials(id) ON DELETE SET NULL,
    -- 连通性状态：untested | connected | failed（由「测试连接」更新）
    status        VARCHAR(32) NOT NULL DEFAULT 'untested',
    last_tested_at   TIMESTAMPTZ,
    last_test_error  TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT true,
    created_by    INTEGER,
    updated_by    INTEGER,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id, name)
);

-- 凭证反查「被哪些数据源引用」——用于删除保护与引用计数
CREATE INDEX IF NOT EXISTS idx_wf_datasources_credential
    ON management.wf_datasources(credential_id);

-- updated_at 由全库统一触发器维护（函数定义见 003_create_management_schema.sql）。
DROP TRIGGER IF EXISTS update_wf_credentials_updated_at ON management.wf_credentials;
CREATE TRIGGER update_wf_credentials_updated_at
    BEFORE UPDATE ON management.wf_credentials
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();

DROP TRIGGER IF EXISTS update_wf_datasources_updated_at ON management.wf_datasources;
CREATE TRIGGER update_wf_datasources_updated_at
    BEFORE UPDATE ON management.wf_datasources
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();
