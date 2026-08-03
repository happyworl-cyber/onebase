-- 030: 个人访问令牌（PAT）—— MCP 工作流创作的鉴权凭证
--
-- - 绑定用户（非 database），审计可定位到人；
-- - token_hash 存 sha256(plain) 的 hex（64 字符），与 management.api_keys 同款，明文仅创建时返回一次；
-- - scope 预留扩展，本期固定 'workflow_author'。
--
-- 环境隔离说明：生产/测试是独立部署（不同 URL + 不同 env），MCP 的权限边界由实例级
-- RUST_ENV 判定（development/staging/test = 非生产），不在数据层做按库标记。

CREATE TABLE IF NOT EXISTS management.personal_access_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    scope VARCHAR(50) NOT NULL DEFAULT 'workflow_author',
    is_active BOOLEAN DEFAULT true,
    expires_at TIMESTAMP,
    last_used_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pats_user_id ON management.personal_access_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_pats_token_hash ON management.personal_access_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_pats_active ON management.personal_access_tokens(is_active) WHERE is_active = true;
