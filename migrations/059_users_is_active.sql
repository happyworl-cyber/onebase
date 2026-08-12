-- 059_users_is_active.sql
-- 平台用户启停：false 时禁止登录，且 JWT 会话中间件拒绝后续请求。
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN users.is_active IS
  'false=账号停用：禁止登录，已签发会话在 auth_middleware 中拒绝';
