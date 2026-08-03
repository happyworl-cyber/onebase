-- 平台服务令牌（Platform Service Token）
--
-- 用途：给「机器 / AI / 外部系统」一种长期有效、可携带 scope 的管理级凭证，
-- 让它们能通过纯 HTTP 调用原本「仅 JWT」的管理端点（创建项目 provision、
-- 创建/管理工作流等），无需走人工登录拿 JWT、也不必处理 JWT 过期/刷新。
--
-- 与 management.api_keys（cr_ 前缀，绑定单个 database_id、只能走数据面）的区别：
--   - platform_tokens 绑定到一个「用户」(user_id)，鉴权时被解析成该用户的 Claims，
--     因此能复用现有 owner/admin/superadmin 权限体系；
--   - 令牌明文前缀为 crp_（platform），与 cr_（数据面）区分；
--   - scopes 控制该令牌能做哪些管理动作（project:create / workflow:read|write|run）。
CREATE TABLE IF NOT EXISTS management.platform_tokens (
    id             SERIAL PRIMARY KEY,
    -- 令牌「代表」哪个用户：provision 的 owner、workflow 的 created_by 都按这个用户算，
    -- 权限校验也按这个用户的 owner/admin/superadmin 身份走。
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name           VARCHAR(100) NOT NULL,
    -- SHA-256(明文) 的十六进制，绝不存明文。
    token_hash     VARCHAR(128) NOT NULL,
    -- 仅用于列表展示，如 crp_1a2b3c...
    token_prefix   VARCHAR(16) NOT NULL,
    -- scope 列表，如 ["project:create","workflow:write","workflow:run"]；
    -- 含 "*" 表示全部管理动作。
    scopes         JSONB NOT NULL DEFAULT '[]',
    is_active      BOOLEAN NOT NULL DEFAULT true,
    last_used_at   TIMESTAMP,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at     TIMESTAMP,
    UNIQUE(token_hash)
);

CREATE INDEX IF NOT EXISTS idx_platform_tokens_user_id   ON management.platform_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_platform_tokens_token_hash ON management.platform_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_platform_tokens_active     ON management.platform_tokens(is_active) WHERE is_active = true;
