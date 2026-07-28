-- ============================================
-- 将现有用户设置为超级管理员
-- ============================================
-- 使用方法：
-- 1. 先通过注册页面注册 admin@example.com 账户
-- 2. 然后在 psql 中执行此脚本：
--    psql -U postgres -d onebase -f set_superadmin.sql

-- 将指定邮箱的用户设置为超级管理员
UPDATE users 
SET is_superadmin = true, 
    role = 'admin',
    username = 'admin'
WHERE email = 'admin@example.com';

-- 验证结果
SELECT id, username, email, role, is_superadmin, created_at 
FROM users 
WHERE email = 'admin@example.com';

