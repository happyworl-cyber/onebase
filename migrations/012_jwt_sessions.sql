-- ============================================
-- JWT 会话表（用于 token 吊销 / 服务端注销）
-- ============================================
-- 设计：每次登录签发一个 jti（uuid），同时往 user_sessions 写一条记录。
-- 校验 token 时除验证签名 + 过期外，还要求 jti 在 user_sessions 中存在且 revoked=false。
--
-- 改密码 / 主动登出 / 管理员强制下线 → 把对应行 revoked=true。
-- 后台清理任务定期删除 expires_at < NOW() 的过期行（避免无限增长）。

CREATE TABLE IF NOT EXISTS user_sessions (
    jti           UUID PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    issued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMPTZ NOT NULL,
    revoked       BOOLEAN NOT NULL DEFAULT false,
    revoked_at    TIMESTAMPTZ,
    revoke_reason VARCHAR(64),
    user_agent    TEXT,
    ip            INET
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_user_sessions_active
    ON user_sessions(user_id, revoked, expires_at)
    WHERE revoked = false;
