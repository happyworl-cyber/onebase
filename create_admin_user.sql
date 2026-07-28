-- ============================================
-- 创建超级管理员账户
-- ============================================
-- 邮箱: admin@example.com
-- 密码: Admin123
--
-- 下面的 password_hash 是用 bcrypt(cost=12) 对 "Admin123" 真实生成并验证过的，
-- 直接执行本脚本即可创建可登录的超管账户。
-- 如需重置密码，推荐使用：cargo run --bin create_admin

-- 1. 删除已存在的 admin 用户（如果有）
DELETE FROM users WHERE email = 'admin@example.com';

-- 2. 插入新的 admin 用户（password = "Admin123"）
INSERT INTO users (username, email, password_hash, role, is_superadmin, created_at)
VALUES (
    'admin',
    'admin@example.com',
    '$2b$12$lWU6Xl/ZBMTwceFjCLGxwOAO4NAN4We9wA8c61z25G5jxNhzOIpSS', -- bcrypt("Admin123", cost=12)
    'admin',
    true,
    CURRENT_TIMESTAMP
);

-- 3. 验证创建结果
SELECT id, username, email, role, is_superadmin, created_at 
FROM users 
WHERE email = 'admin@example.com';

