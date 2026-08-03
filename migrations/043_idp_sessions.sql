-- IdP Session 管理补充字段
--
-- 设计要求：项目级查看活跃 session，并支持踢出。
-- 当前实现以 refresh token family 作为“活跃 session”的权威来源；
-- 为了在管理页展示“本次使用的上游 Provider”，补一个 auth_method 字段。

ALTER TABLE management.oauth2_refresh_tokens
    ADD COLUMN IF NOT EXISTS auth_method VARCHAR(32);
