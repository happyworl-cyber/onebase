-- ============================================================
-- 062: Partner Distribution System
-- ============================================================
-- 代理商分销系统：原厂 → 代理商 → 企业客户（self-hosted）
--
-- 核心功能：
-- - 代理商管理（配额分配、佣金比例设置）
-- - License 自助签发（从配额扣减）
-- - 佣金自动计算
-- - 对账单生成（月度结算）
-- ============================================================

-- 1. partners - 代理商主表
CREATE TABLE IF NOT EXISTS management.partners (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    company_name VARCHAR(200) NOT NULL,
    slug VARCHAR(50) UNIQUE NOT NULL,
    contact_email VARCHAR(255) NOT NULL,
    contact_phone VARCHAR(50),
    status VARCHAR(20) NOT NULL DEFAULT 'active', -- active | suspended | inactive

    -- 佣金与配额
    commission_rate DECIMAL(5,2) NOT NULL DEFAULT 0.00 CHECK (commission_rate >= 0 AND commission_rate <= 100),
    payment_terms INTEGER NOT NULL DEFAULT 30, -- 账期天数
    license_quota INTEGER NOT NULL DEFAULT 0 CHECK (license_quota >= 0),
    used_quota INTEGER NOT NULL DEFAULT 0 CHECK (used_quota >= 0),
    quota_expires_at TIMESTAMP,

    -- 授权范围限制
    allowed_editions JSONB NOT NULL DEFAULT '[]'::jsonb, -- ["standard", "enterprise"]
    allowed_modules JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ["ai", "ha", "backup"]
    max_license_days INTEGER, -- 最长签发天数限制，NULL 表示不限制

    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT partners_status_check CHECK (status IN ('active', 'suspended', 'inactive')),
    CONSTRAINT partners_quota_check CHECK (used_quota <= license_quota)
);

CREATE INDEX IF NOT EXISTS idx_partners_status ON management.partners(status);
CREATE INDEX IF NOT EXISTS idx_partners_slug ON management.partners(slug);

COMMENT ON TABLE management.partners IS '代理商主表：管理配额、佣金、授权范围';
COMMENT ON COLUMN management.partners.commission_rate IS '佣金比例 (0-100)';
COMMENT ON COLUMN management.partners.license_quota IS '总 License 配额';
COMMENT ON COLUMN management.partners.used_quota IS '已使用配额';
COMMENT ON COLUMN management.partners.allowed_editions IS '允许签发的版本：["standard", "enterprise"]';
COMMENT ON COLUMN management.partners.allowed_modules IS '允许签发的模块：["ai", "ha", "backup"]';

-- 2. partner_users - 代理商用户关联表
CREATE TABLE IF NOT EXISTS management.partner_users (
    id SERIAL PRIMARY KEY,
    partner_id INTEGER NOT NULL REFERENCES management.partners(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL DEFAULT 'member', -- admin | member
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(partner_id, user_id),
    CONSTRAINT partner_users_role_check CHECK (role IN ('admin', 'member'))
);

CREATE INDEX IF NOT EXISTS idx_partner_users_partner_id ON management.partner_users(partner_id);
CREATE INDEX IF NOT EXISTS idx_partner_users_user_id ON management.partner_users(user_id);

COMMENT ON TABLE management.partner_users IS '代理商用户关联：管理代理商成员权限';

-- 3. customer_licenses - 客户 License 记录
CREATE TABLE IF NOT EXISTS management.customer_licenses (
    id SERIAL PRIMARY KEY,
    partner_id INTEGER NOT NULL REFERENCES management.partners(id) ON DELETE RESTRICT,
    license_id UUID NOT NULL UNIQUE, -- 对应 LicenseClaims.license_id

    -- 客户信息
    customer_name VARCHAR(200) NOT NULL,
    customer_company VARCHAR(200),
    customer_email VARCHAR(255),
    customer_contact_phone VARCHAR(50),

    -- License 配置
    edition VARCHAR(50) NOT NULL, -- standard | enterprise | trial
    modules JSONB NOT NULL DEFAULT '[]'::jsonb, -- ["ai", "ha"]
    max_nodes INTEGER NOT NULL DEFAULT 1,
    max_tenants INTEGER NOT NULL DEFAULT 1,
    fingerprint_encrypted TEXT, -- 客户硬件指纹（加密存储，可选）

    -- 时间配置
    issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    grace_days INTEGER NOT NULL DEFAULT 0, -- 宽限期天数

    -- License 类型与价格
    license_type VARCHAR(20) NOT NULL DEFAULT 'subscription', -- subscription | perpetual
    price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    currency VARCHAR(10) NOT NULL DEFAULT 'CNY',

    -- License 文件内容（完整的 LicenseFile JSON）
    license_file_content JSONB NOT NULL,

    -- 状态与续费关联
    status VARCHAR(20) NOT NULL DEFAULT 'active', -- active | grace | expired | revoked
    parent_license_id INTEGER REFERENCES management.customer_licenses(id), -- 续费的原 License
    renewed_to_license_id INTEGER REFERENCES management.customer_licenses(id), -- 被续费后的新 License

    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT customer_licenses_status_check
        CHECK (status IN ('active', 'grace', 'expired', 'revoked')),
    CONSTRAINT customer_licenses_type_check
        CHECK (license_type IN ('subscription', 'perpetual'))
);

CREATE INDEX IF NOT EXISTS idx_customer_licenses_partner_id ON management.customer_licenses(partner_id);
CREATE INDEX IF NOT EXISTS idx_customer_licenses_customer_name ON management.customer_licenses(customer_name);
CREATE INDEX IF NOT EXISTS idx_customer_licenses_status ON management.customer_licenses(status);
CREATE INDEX IF NOT EXISTS idx_customer_licenses_expires_at ON management.customer_licenses(expires_at);
CREATE INDEX IF NOT EXISTS idx_customer_licenses_license_id ON management.customer_licenses(license_id);

COMMENT ON TABLE management.customer_licenses IS '客户 License 记录：代理商签发的所有 License';
COMMENT ON COLUMN management.customer_licenses.license_file_content IS '完整的 LicenseFile JSON（含签名）';
COMMENT ON COLUMN management.customer_licenses.fingerprint_encrypted IS '客户硬件指纹（加密存储）';
COMMENT ON COLUMN management.customer_licenses.parent_license_id IS '续费时指向原 License ID';

-- 4. partner_commissions - 佣金记录
CREATE TABLE IF NOT EXISTS management.partner_commissions (
    id SERIAL PRIMARY KEY,
    partner_id INTEGER NOT NULL REFERENCES management.partners(id) ON DELETE RESTRICT,
    license_id INTEGER NOT NULL REFERENCES management.customer_licenses(id) ON DELETE RESTRICT,

    -- 佣金计算
    base_price DECIMAL(12,2) NOT NULL, -- License 销售价
    commission_rate DECIMAL(5,2) NOT NULL, -- 签发时的佣金比例快照
    commission_amount DECIMAL(12,2) NOT NULL, -- = base_price * commission_rate / 100
    currency VARCHAR(10) NOT NULL DEFAULT 'CNY',

    -- 结算状态
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | approved | paid | settled
    settlement_date TIMESTAMP, -- 结算日期
    statement_id INTEGER REFERENCES management.partner_statements(id), -- 关联对账单

    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT partner_commissions_status_check
        CHECK (status IN ('pending', 'approved', 'paid', 'settled'))
);

CREATE INDEX IF NOT EXISTS idx_partner_commissions_partner_id ON management.partner_commissions(partner_id);
CREATE INDEX IF NOT EXISTS idx_partner_commissions_license_id ON management.partner_commissions(license_id);
CREATE INDEX IF NOT EXISTS idx_partner_commissions_status ON management.partner_commissions(status);
CREATE INDEX IF NOT EXISTS idx_partner_commissions_settlement_date ON management.partner_commissions(settlement_date);

COMMENT ON TABLE management.partner_commissions IS '佣金记录：每个 License 自动计算佣金';
COMMENT ON COLUMN management.partner_commissions.commission_rate IS '签发时的佣金比例快照（避免代理商比例变更影响历史记录）';

-- 5. partner_statements - 对账单
CREATE TABLE IF NOT EXISTS management.partner_statements (
    id SERIAL PRIMARY KEY,
    partner_id INTEGER NOT NULL REFERENCES management.partners(id) ON DELETE RESTRICT,

    -- 账期
    period_start TIMESTAMP NOT NULL,
    period_end TIMESTAMP NOT NULL,

    -- 统计汇总
    total_licenses INTEGER NOT NULL DEFAULT 0,
    total_revenue DECIMAL(12,2) NOT NULL DEFAULT 0.00, -- 总营收
    total_commission DECIMAL(12,2) NOT NULL DEFAULT 0.00, -- 总佣金
    currency VARCHAR(10) NOT NULL DEFAULT 'CNY',

    -- 状态与支付
    status VARCHAR(20) NOT NULL DEFAULT 'draft', -- draft | pending | paid | settled
    statement_file_url TEXT, -- 对账单文件 URL（PDF/Excel）
    paid_at TIMESTAMP,
    payment_reference VARCHAR(200), -- 支付凭证号

    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT partner_statements_status_check
        CHECK (status IN ('draft', 'pending', 'paid', 'settled'))
);

CREATE INDEX IF NOT EXISTS idx_partner_statements_partner_id ON management.partner_statements(partner_id);
CREATE INDEX IF NOT EXISTS idx_partner_statements_period ON management.partner_statements(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_partner_statements_status ON management.partner_statements(status);

COMMENT ON TABLE management.partner_statements IS '对账单：月度自动生成，汇总佣金';
COMMENT ON COLUMN management.partner_statements.statement_file_url IS '对账单文件 URL（PDF/Excel）';

-- 6. 视图：v_partner_stats - 代理商统计
CREATE OR REPLACE VIEW management.v_partner_stats AS
SELECT
    p.id AS partner_id,
    p.name,
    p.slug,
    p.status,
    p.license_quota,
    p.used_quota,
    p.commission_rate,

    -- License 统计
    COUNT(DISTINCT cl.id) FILTER (WHERE cl.status != 'revoked') AS total_licenses,
    COUNT(DISTINCT cl.id) FILTER (WHERE cl.status = 'active') AS active_licenses,
    COUNT(DISTINCT cl.id) FILTER (WHERE cl.license_type = 'subscription' AND cl.status != 'revoked') AS subscription_licenses,
    COUNT(DISTINCT cl.id) FILTER (WHERE cl.license_type = 'perpetual' AND cl.status != 'revoked') AS perpetual_licenses,

    -- 佣金统计
    COALESCE(SUM(pc.commission_amount) FILTER (WHERE pc.status != 'settled'), 0) AS total_commission,
    COALESCE(SUM(pc.commission_amount) FILTER (WHERE pc.status = 'settled'), 0) AS settled_commission,
    COALESCE(SUM(pc.commission_amount) FILTER (WHERE pc.status = 'pending'), 0) AS pending_commission,

    p.created_at
FROM management.partners p
LEFT JOIN management.customer_licenses cl ON cl.partner_id = p.id
LEFT JOIN management.partner_commissions pc ON pc.partner_id = p.id
GROUP BY p.id;

COMMENT ON VIEW management.v_partner_stats IS '代理商统计视图：汇总 License 与佣金数据';

-- 触发器：自动更新 updated_at
DROP TRIGGER IF EXISTS update_partners_updated_at ON management.partners;
CREATE TRIGGER update_partners_updated_at
    BEFORE UPDATE ON management.partners
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();

DROP TRIGGER IF EXISTS update_customer_licenses_updated_at ON management.customer_licenses;
CREATE TRIGGER update_customer_licenses_updated_at
    BEFORE UPDATE ON management.customer_licenses
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();

DROP TRIGGER IF EXISTS update_partner_commissions_updated_at ON management.partner_commissions;
CREATE TRIGGER update_partner_commissions_updated_at
    BEFORE UPDATE ON management.partner_commissions
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();

DROP TRIGGER IF EXISTS update_partner_statements_updated_at ON management.partner_statements;
CREATE TRIGGER update_partner_statements_updated_at
    BEFORE UPDATE ON management.partner_statements
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();
