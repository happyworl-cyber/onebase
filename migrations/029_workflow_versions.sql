-- ============================================
-- 工作流版本控制（每次编辑器保存 / 恢复都留一份定义快照）
-- ============================================
-- 设计：append-only 线性历史。每个 workflow 的 version 从 1 自增，保存定义时插入一条快照，
-- 恢复某历史版本 = 把该快照写回 workflows，并再追加一条新版本（note 标注"恢复自 vN"），
-- 历史永不被改写，便于审计与回滚。
--
-- 只快照"定义相关"字段（不含 is_enabled / database_id / tenant_id 这类绑定/开关），
-- 避免在列表里点启用/禁用也产生版本噪音。

CREATE TABLE IF NOT EXISTS management.workflow_versions (
    id             BIGSERIAL PRIMARY KEY,
    workflow_id    INTEGER NOT NULL REFERENCES management.workflows(id) ON DELETE CASCADE,
    version        INTEGER NOT NULL,
    name           VARCHAR(200) NOT NULL,
    slug           VARCHAR(64) NOT NULL,
    description    TEXT,
    category       VARCHAR(64),
    trigger_type   VARCHAR(20) NOT NULL DEFAULT 'endpoint',
    trigger_config JSONB NOT NULL DEFAULT '{}',
    nodes          JSONB NOT NULL DEFAULT '[]',
    edges          JSONB NOT NULL DEFAULT '[]',
    timeout_ms     INTEGER NOT NULL DEFAULT 30000,
    max_retries    INTEGER NOT NULL DEFAULT 0,
    note           VARCHAR(500),
    created_by     INTEGER,
    created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT workflow_versions_unique UNIQUE (workflow_id, version)
);

CREATE INDEX IF NOT EXISTS idx_workflow_versions_wid
    ON management.workflow_versions(workflow_id, version DESC);
