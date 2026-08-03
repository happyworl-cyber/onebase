-- Mind SSO 接入：放开 sso_providers.provider_type 的 CHECK 约束，加入 'mind'
--
-- 006 里的 CHECK 是内联匿名约束，PostgreSQL 自动命名为
-- `sso_providers_provider_type_check`。这里先 DROP（IF EXISTS 容忍旧库没有/已改名），
-- 再以同名显式重建——重复跑会命中 "already exists" 被 migrate runner 视为良性 skip。
ALTER TABLE management.sso_providers
    DROP CONSTRAINT IF EXISTS sso_providers_provider_type_check;

ALTER TABLE management.sso_providers
    ADD CONSTRAINT sso_providers_provider_type_check
    CHECK (provider_type IN ('google', 'facebook', 'github', 'oidc', 'mind'));
