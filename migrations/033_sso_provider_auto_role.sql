-- SSO Provider「适用范围 / 自动授予角色」：通过该 Provider 登录的用户，
-- 在该 Provider 所属项目（tenant）里自动获得的角色。
--
-- 语义：SSO 配置本身已经按 tenant 隔离（sso_providers.tenant_id），所以"适用范围"
-- 就是该 Provider 所属的那个项目；这里补的是"以什么角色加入"。
-- 取值与 user_tenants.role 对齐（owner/admin/member/viewer）；映射到 RBAC 见
-- permissions::default_rbac_role_for_tenant_role（admin→admin, member→editor, viewer→viewer）。
ALTER TABLE management.sso_providers
    ADD COLUMN IF NOT EXISTS auto_role VARCHAR(50) NOT NULL DEFAULT 'member';

ALTER TABLE management.sso_providers
    DROP CONSTRAINT IF EXISTS sso_providers_auto_role_check;

ALTER TABLE management.sso_providers
    ADD CONSTRAINT sso_providers_auto_role_check
    CHECK (auto_role IN ('owner', 'admin', 'member', 'viewer'));
