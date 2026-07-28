-- 创建用户表
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'user',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_role ON users(role);

-- 创建更新时间触发器
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 插入默认管理员用户（密码: Admin123）
INSERT INTO users (username, email, password_hash, role)
VALUES (
    'admin',
    'admin@example.com',
    '$2b$12$lWU6Xl/ZBMTwceFjCLGxwOAO4NAN4We9wA8c61z25G5jxNhzOIpSS', -- Admin123
    'admin'
)
ON CONFLICT (email) DO NOTHING;

-- 插入测试用户（密码: User1234）
INSERT INTO users (username, email, password_hash, role)
VALUES (
    'testuser',
    'test@example.com',
    '$2b$12$KLspJRkworxQAa2ruPeNBeispBG0nRIZRMKOE0oFoFiiGXvpK5xG.', -- User1234
    'user'
)
ON CONFLICT (email) DO NOTHING;

