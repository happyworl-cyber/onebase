-- 添加维护费支持
-- Migration 064: 支持年度维护费（AMA）跟踪和代理商分成

BEGIN;

-- ============================================================
-- 1. customer_licenses 表：添加维护费相关字段
-- ============================================================

ALTER TABLE management.customer_licenses
ADD COLUMN IF NOT EXISTS has_maintenance BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS maintenance_expires_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS maintenance_price NUMERIC(12, 2),
ADD COLUMN IF NOT EXISTS maintenance_commission_rate NUMERIC(5, 2) DEFAULT 10.00,
ADD COLUMN IF NOT EXISTS auto_renew_maintenance BOOLEAN DEFAULT false;

COMMENT ON COLUMN management.customer_licenses.has_maintenance
IS '是否购买年度维护服务（Annual Maintenance Agreement）';

COMMENT ON COLUMN management.customer_licenses.maintenance_expires_at
IS '维护服务到期时间（与 License 到期时间独立）';

COMMENT ON COLUMN management.customer_licenses.maintenance_price
IS '年度维护费价格（通常为 License 价格的 20%）';

COMMENT ON COLUMN management.customer_licenses.maintenance_commission_rate
IS '维护费代理商分成比例（0-100），默认 10%，低于新签分成';

COMMENT ON COLUMN management.customer_licenses.auto_renew_maintenance
IS '是否自动续费维护（到期前自动生成续费记录）';

-- ============================================================
-- 2. partner_commissions 表：区分新签和维护续费佣金
-- ============================================================

ALTER TABLE management.partner_commissions
ADD COLUMN IF NOT EXISTS commission_type VARCHAR(20) DEFAULT 'license',
ADD COLUMN IF NOT EXISTS renewal_year INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS related_license_id UUID;

COMMENT ON COLUMN management.partner_commissions.commission_type
IS '佣金类型：license（新签 License）、maintenance（维护费续费）、renewal（License 续期）';

COMMENT ON COLUMN management.partner_commissions.renewal_year
IS '续费年份（0=新签，1=第1年续费，2=第2年续费...），用于跟踪长期收益';

COMMENT ON COLUMN management.partner_commissions.related_license_id
IS '关联的原始 License ID（用于续费溯源）';

-- 添加索引以提升查询性能
CREATE INDEX IF NOT EXISTS idx_partner_commissions_type_year
ON management.partner_commissions(commission_type, renewal_year);

CREATE INDEX IF NOT EXISTS idx_partner_commissions_related_license
ON management.partner_commissions(related_license_id);

-- ============================================================
-- 3. 新建表：maintenance_renewals - 维护费续费记录
-- ============================================================

CREATE TABLE IF NOT EXISTS management.maintenance_renewals (
    id SERIAL PRIMARY KEY,
    license_id UUID NOT NULL REFERENCES management.customer_licenses(id) ON DELETE CASCADE,
    partner_id INTEGER NOT NULL REFERENCES management.partners(id) ON DELETE RESTRICT,

    -- 续费信息
    renewal_year INTEGER NOT NULL,  -- 第几年续费（1, 2, 3...）
    period_start TIMESTAMP WITH TIME ZONE NOT NULL,
    period_end TIMESTAMP WITH TIME ZONE NOT NULL,

    -- 价格与佣金
    maintenance_price NUMERIC(12, 2) NOT NULL,
    commission_rate NUMERIC(5, 2) NOT NULL,
    commission_amount NUMERIC(12, 2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'CNY',

    -- 支付状态
    payment_status VARCHAR(20) DEFAULT 'pending',  -- pending, paid, overdue, cancelled
    paid_at TIMESTAMP WITH TIME ZONE,
    payment_reference TEXT,

    -- 审计
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    CONSTRAINT maintenance_renewals_renewal_year_check CHECK (renewal_year > 0),
    CONSTRAINT maintenance_renewals_price_check CHECK (maintenance_price >= 0),
    CONSTRAINT maintenance_renewals_commission_rate_check CHECK (commission_rate >= 0 AND commission_rate <= 100)
);

CREATE INDEX idx_maintenance_renewals_license_id ON management.maintenance_renewals(license_id);
CREATE INDEX idx_maintenance_renewals_partner_id ON management.maintenance_renewals(partner_id);
CREATE INDEX idx_maintenance_renewals_payment_status ON management.maintenance_renewals(payment_status);
CREATE INDEX idx_maintenance_renewals_period ON management.maintenance_renewals(period_start, period_end);

COMMENT ON TABLE management.maintenance_renewals
IS '维护费续费记录表 - 跟踪每年的维护费续费情况';

COMMENT ON COLUMN management.maintenance_renewals.renewal_year
IS '续费年份：1=首次续费，2=第二次续费...（新签时不记录，从首次续费开始）';

COMMENT ON COLUMN management.maintenance_renewals.payment_status
IS '支付状态：pending（待支付）、paid（已支付）、overdue（逾期）、cancelled（取消）';

-- ============================================================
-- 4. 更新 partner_statements 表：区分 License 和维护费收入
-- ============================================================

ALTER TABLE management.partner_statements
ADD COLUMN IF NOT EXISTS total_maintenance_revenue NUMERIC(12, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_maintenance_commission NUMERIC(12, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS maintenance_count INTEGER DEFAULT 0;

COMMENT ON COLUMN management.partner_statements.total_maintenance_revenue
IS '维护费总收入（本期）';

COMMENT ON COLUMN management.partner_statements.total_maintenance_commission
IS '维护费佣金总额（本期）';

COMMENT ON COLUMN management.partner_statements.maintenance_count
IS '本期维护费续费数量';

-- ============================================================
-- 5. 更新视图：v_partner_stats - 添加维护费统计
-- ============================================================

DROP VIEW IF EXISTS management.v_partner_stats;

CREATE VIEW management.v_partner_stats AS
SELECT
    p.id AS partner_id,
    p.name AS partner_name,
    p.status,

    -- License 统计
    COUNT(DISTINCT cl.id) AS total_licenses,
    COUNT(DISTINCT cl.id) FILTER (WHERE cl.status = 'active') AS active_licenses,
    COUNT(DISTINCT cl.id) FILTER (WHERE cl.license_type = 'subscription') AS subscription_licenses,
    COUNT(DISTINCT cl.id) FILTER (WHERE cl.license_type = 'perpetual') AS perpetual_licenses,

    -- 维护费统计
    COUNT(DISTINCT cl.id) FILTER (WHERE cl.has_maintenance = true) AS licenses_with_maintenance,
    COUNT(DISTINCT cl.id) FILTER (WHERE cl.has_maintenance = true AND cl.maintenance_expires_at > NOW()) AS active_maintenance_count,
    SUM(cl.maintenance_price) FILTER (WHERE cl.has_maintenance = true) AS total_maintenance_value,

    -- 佣金统计（区分类型）
    COALESCE(SUM(pc.commission_amount) FILTER (WHERE pc.commission_type = 'license'), 0) AS license_commission,
    COALESCE(SUM(pc.commission_amount) FILTER (WHERE pc.commission_type = 'maintenance'), 0) AS maintenance_commission,
    COALESCE(SUM(pc.commission_amount), 0) AS total_commission,

    -- 已结算佣金
    COALESCE(SUM(pc.commission_amount) FILTER (WHERE pc.status IN ('paid', 'settled')), 0) AS settled_commission,
    COALESCE(SUM(pc.commission_amount) FILTER (WHERE pc.status = 'pending'), 0) AS pending_commission,

    -- 最近活动
    MAX(cl.created_at) AS last_license_issued,
    MAX(pc.created_at) AS last_commission_date
FROM
    management.partners p
    LEFT JOIN management.customer_licenses cl ON p.id = cl.partner_id
    LEFT JOIN management.partner_commissions pc ON p.id = pc.partner_id
GROUP BY
    p.id, p.name, p.status;

COMMENT ON VIEW management.v_partner_stats
IS '代理商统计视图 - 包含 License、维护费、佣金等综合统计';

-- ============================================================
-- 6. 触发器：自动更新 maintenance_renewals.updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION update_maintenance_renewals_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_maintenance_renewals_updated_at
BEFORE UPDATE ON management.maintenance_renewals
FOR EACH ROW
EXECUTE FUNCTION update_maintenance_renewals_updated_at();

-- ============================================================
-- 7. 示例数据（可选，用于测试）
-- ============================================================

-- 假设已有 License ID: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
-- 可取消以下注释进行测试

/*
-- 示例：为现有 License 添加维护费
UPDATE management.customer_licenses
SET
    has_maintenance = true,
    maintenance_price = 16000.00,  -- Standard 版维护费
    maintenance_expires_at = NOW() + INTERVAL '1 year',
    maintenance_commission_rate = 10.00,
    auto_renew_maintenance = true
WHERE
    edition = 'standard'
    AND license_type = 'perpetual'
    LIMIT 1;

-- 示例：创建维护费续费记录
INSERT INTO management.maintenance_renewals (
    license_id, partner_id, renewal_year,
    period_start, period_end,
    maintenance_price, commission_rate, commission_amount,
    payment_status
)
SELECT
    cl.id,
    cl.partner_id,
    1,  -- 第 1 年续费
    NOW(),
    NOW() + INTERVAL '1 year',
    cl.maintenance_price,
    cl.maintenance_commission_rate,
    cl.maintenance_price * cl.maintenance_commission_rate / 100,
    'pending'
FROM
    management.customer_licenses cl
WHERE
    cl.has_maintenance = true
    LIMIT 1;
*/

COMMIT;
