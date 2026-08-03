-- ============================================
-- Workflow DAG 引擎（工作流：可视化编排自定义 API）
-- ============================================
-- 背景：原先 workflow 的建表只存在于独立 binary `src/bin/migrate_workflow.rs`，
-- 不在 `migrate_all` 范围内，导致新库只跑 migrate_all 时 `management.workflows`
-- 缺失、工作流页面一进去就 500。本迁移把"全新库建表"纳入统一入口。
--
-- 分工：
-- - 本 SQL：全新库 / 增量库的幂等建表（CREATE ... IF NOT EXISTS），由 migrate_all 执行。
-- - migrate_workflow.rs：仍保留，专门处理"旧版线性 steps 模型 → DAG 模型"的备份重命名
--   迁移（旧库升级场景）；全新库不需要它。
--
-- 两边 schema 必须保持一致，改字段时记得同步 migrate_workflow.rs。

CREATE TABLE IF NOT EXISTS management.workflows (
    id            SERIAL PRIMARY KEY,
    tenant_id     INTEGER REFERENCES management.tenants(id) ON DELETE CASCADE,
    database_id   INTEGER,
    name          VARCHAR(200) NOT NULL,
    slug          VARCHAR(64) NOT NULL,
    description   TEXT,
    trigger_type  VARCHAR(20) NOT NULL DEFAULT 'endpoint',
    trigger_config JSONB NOT NULL DEFAULT '{}',
    nodes         JSONB NOT NULL DEFAULT '[]',
    edges         JSONB NOT NULL DEFAULT '[]',
    is_enabled    BOOLEAN NOT NULL DEFAULT true,
    timeout_ms    INTEGER NOT NULL DEFAULT 30000,
    max_retries   INTEGER NOT NULL DEFAULT 0,
    created_by    INTEGER,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT workflows_slug_db_unique UNIQUE (database_id, slug)
);

CREATE TABLE IF NOT EXISTS management.workflow_runs (
    id            BIGSERIAL PRIMARY KEY,
    workflow_id   INTEGER NOT NULL REFERENCES management.workflows(id) ON DELETE CASCADE,
    tenant_id     INTEGER,
    trigger_type  VARCHAR(20) NOT NULL DEFAULT 'manual',
    trigger_data  JSONB,
    status        VARCHAR(20) NOT NULL DEFAULT 'pending',
    node_results  JSONB NOT NULL DEFAULT '[]',
    final_output  JSONB,
    error_message TEXT,
    elapsed_ms    BIGINT,
    started_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    completed_at  TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_workflows_slug    ON management.workflows(database_id, slug);
CREATE INDEX IF NOT EXISTS idx_workflows_tenant  ON management.workflows(tenant_id);
CREATE INDEX IF NOT EXISTS idx_workflows_trigger ON management.workflows(trigger_type) WHERE is_enabled = true;
CREATE INDEX IF NOT EXISTS idx_workflow_runs_wid    ON management.workflow_runs(workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON management.workflow_runs(status) WHERE status = 'running';

-- updated_at 自动维护触发器：函数 CREATE OR REPLACE 幂等；触发器先 DROP 再建（PG 的
-- CREATE TRIGGER 不支持 IF NOT EXISTS，DROP IF EXISTS + CREATE 是标准幂等写法）。
CREATE OR REPLACE FUNCTION management.update_workflows_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_workflows_updated_at ON management.workflows;

CREATE TRIGGER trigger_workflows_updated_at
    BEFORE UPDATE ON management.workflows
    FOR EACH ROW EXECUTE FUNCTION management.update_workflows_updated_at();
