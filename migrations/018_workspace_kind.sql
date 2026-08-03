-- ============================================================
-- W1: 工作空间元数据
-- ============================================================
-- 给 management.tenants 加两列：
--   kind             - 'legacy_tenant' | 'project'，区分历史租户与 M2 起的项目
--   workspace_config - JSONB，存项目级 UI 偏好（首页布局、AI 开关等）
--
-- W1 阶段 kind 字段不强制读，工作空间不按 kind 过滤项目列表（普通用户能看到
-- 自己加入的所有 tenants）；M2 自助开通向导落地后才用 kind 区分。

ALTER TABLE management.tenants
    ADD COLUMN IF NOT EXISTS kind VARCHAR(32) NOT NULL DEFAULT 'legacy_tenant',
    ADD COLUMN IF NOT EXISTS workspace_config JSONB;

ALTER TABLE management.tenants
    DROP CONSTRAINT IF EXISTS tenants_kind_check;
ALTER TABLE management.tenants
    ADD CONSTRAINT tenants_kind_check
    CHECK (kind IN ('legacy_tenant', 'project'));

CREATE INDEX IF NOT EXISTS idx_tenants_kind ON management.tenants(kind);

COMMENT ON COLUMN management.tenants.kind IS
    'W1 工作空间元数据：legacy_tenant=历史租户；project=M2 自助开通的项目';
COMMENT ON COLUMN management.tenants.workspace_config IS
    'W1 工作空间元数据：项目 UI 偏好的 JSONB（首页布局 / AI 开关 / 通知偏好等），允许 NULL';
