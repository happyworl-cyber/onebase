-- 强制默认管理员首次登录改密：
--   must_change_password = true 时，后端 auth 网关只放行改密/登出/查询自身等少量端点，
--   其余一律 403（code=password_change_required），前端据此跳转到 /change-password。
--   改密成功后置为 false 并写 password_changed_at，之后不再拦截。
--
-- 幂等说明：本迁移在每次启动都会跑（无版本表），因此“把默认管理员标记为需改密”的
-- 语句必须自带一次性护栏——只在 password_changed_at 仍为 NULL（从未改过密）时置位，
-- 避免管理员改完密码后被重启迁移再次强制。create_admin 重置默认密码时会把
-- password_changed_at 清回 NULL，从而重新触发强制改密（与“默认密码=必须改”的语义一致）。

ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

-- 首次引入该列时，把仍使用默认密码（从未改过密）的内置管理员标记为需强制改密。
UPDATE users
SET must_change_password = true
WHERE email = 'admin@example.com'
  AND password_changed_at IS NULL;
