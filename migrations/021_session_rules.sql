-- ============================================
-- Session Rules（项目级 RPC 会话钩子规则）
-- ============================================
-- v1 范围（详见 docs/superpowers/specs/2026-05-27-session-rules-design.md）：
-- - 仅作用于 RPC inject 路径（同步、声明式、API Key 主体）
-- - 一行 = 一组绑定到该项目的 hooks 配置
-- - 同项目多条 active 规则按 id 升序合并；之后 api_key.permissions.session_hooks
--   再做细粒度覆盖
-- - 规则 CRUD 走通用 audit_logs；不复用 workflow_runs

CREATE TABLE IF NOT EXISTS management.session_rules (
    id            BIGSERIAL PRIMARY KEY,
    database_id   INTEGER NOT NULL REFERENCES management.tenant_databases(id) ON DELETE CASCADE,
    name          VARCHAR(100) NOT NULL,
    description   TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT true,
    hooks         JSONB NOT NULL,
    created_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- 同一个项目里规则名要唯一，避免运维抓瞎
    CONSTRAINT session_rules_name_db_unique UNIQUE (database_id, name)
);

-- inject 热路径会按 (database_id, is_active=true) 过滤；partial index 让 active=true
-- 的查询直接走索引扫，规避全表扫描
CREATE INDEX IF NOT EXISTS idx_session_rules_active
    ON management.session_rules(database_id)
    WHERE is_active = true;

-- 列表 / 详情场景按 database_id 过滤
CREATE INDEX IF NOT EXISTS idx_session_rules_db
    ON management.session_rules(database_id);
