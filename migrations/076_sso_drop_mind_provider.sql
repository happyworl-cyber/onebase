-- 移除 Mind SSO provider，收敛 provider_type 约束到内置集合。
--
-- 背景：早期 032 曾把 'mind'（内部 IM 办公平台）加进 provider_type 的 CHECK。
-- 产品统一后不再内置 Mind，仅保留标准 OAuth2/OIDC provider（google / apple /
-- facebook / github / oidc）。032 已就地改成新集合，但**已部署库**先跑过旧的
-- 032（约束含 mind、且可能已存在 mind 类型的 provider 行），需要这条收敛：
--   1. 先停用并删除任何遗留的 mind provider（否则新 CHECK 无法建立）；
--   2. 重建 CHECK 到内置集合（含 apple，与后端 VALID_PROVIDER_TYPES 对齐）。
--
-- 幂等：删除按 provider_type 过滤，无 mind 行时是 no-op；约束 DROP IF EXISTS +
-- 重建，重复跑命中 "already exists" 被 migrate runner 视为良性 skip。

-- 1. 清掉遗留的 Mind provider（连带其配置；关联用户的 SSO 绑定会因此失效，
--    需改用其它登录方式，这是移除该 provider 的预期结果）。
DELETE FROM management.sso_providers WHERE provider_type = 'mind';

-- 2. 收敛约束到内置 provider 集合。
ALTER TABLE management.sso_providers
    DROP CONSTRAINT IF EXISTS sso_providers_provider_type_check;

ALTER TABLE management.sso_providers
    ADD CONSTRAINT sso_providers_provider_type_check
    CHECK (provider_type IN ('google', 'apple', 'facebook', 'github', 'oidc'));
