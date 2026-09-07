-- 为 License 添加每租户账号数量限制字段

-- 1. 为 customer_licenses 表添加 max_accounts_per_tenant 字段
ALTER TABLE management.customer_licenses
ADD COLUMN IF NOT EXISTS max_accounts_per_tenant INTEGER;

COMMENT ON COLUMN management.customer_licenses.max_accounts_per_tenant IS '每个租户的账号上限（NULL = 不限制）';

-- 2. 为 CustomerLicense 模型添加字段（更新后需要同步 Rust 结构体）
-- 注：此字段存储在 customer_licenses 表中，用于记录签发时的限制
-- 实际限制检查在 license_enforcement.rs 中基于 LicenseClaims.max_accounts_per_tenant 进行
