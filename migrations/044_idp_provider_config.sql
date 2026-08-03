-- 项目级 IdP Provider 扩展配置
--
-- 设计稿里 Apple / 自定义 OIDC 等 Provider 需要额外字段：
-- - Apple: team_id / key_id / private_key_pem
-- - OIDC: authorization_url / token_url / userinfo_url / scopes
-- 为避免给主表加过多 provider-specific 列，这里用 jsonb 承载扩展配置。

ALTER TABLE management.project_idp_providers
    ADD COLUMN IF NOT EXISTS provider_config JSONB;
