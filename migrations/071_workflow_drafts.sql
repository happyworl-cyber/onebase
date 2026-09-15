-- 071: 工作流草稿 / 已发布指针。
-- workflows = 线上定义；workflow_drafts = 未发布编辑稿；published_version NULL = 从未发布。

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'management'
      AND table_name = 'workflows'
      AND column_name = 'published_version'
  ) THEN
    ALTER TABLE management.workflows
      ADD COLUMN published_version INTEGER;

    -- 没有版本快照的旧行补 v1，然后全部视为已发布。
    INSERT INTO management.workflow_versions
      (workflow_id, version, name, slug, description, category, department,
       trigger_type, trigger_config, input_schema, nodes, edges, timeout_ms, max_retries,
       note, created_by)
    SELECT w.id, 1, w.name, w.slug, w.description, w.category, w.department,
           w.trigger_type, w.trigger_config, w.input_schema, w.nodes, w.edges,
           w.timeout_ms, w.max_retries, '迁移标记已发布', w.created_by
    FROM management.workflows w
    WHERE NOT EXISTS (
      SELECT 1 FROM management.workflow_versions v WHERE v.workflow_id = w.id
    );

    UPDATE management.workflows w
    SET published_version = (
      SELECT MAX(v.version) FROM management.workflow_versions v WHERE v.workflow_id = w.id
    )
    WHERE w.published_version IS NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS management.workflow_drafts (
    workflow_id    INTEGER PRIMARY KEY REFERENCES management.workflows(id) ON DELETE CASCADE,
    name           VARCHAR(200) NOT NULL,
    slug           VARCHAR(64) NOT NULL,
    description    TEXT,
    category       VARCHAR(128),
    department     VARCHAR(64),
    trigger_type   VARCHAR(20) NOT NULL DEFAULT 'endpoint',
    trigger_config JSONB NOT NULL DEFAULT '{}',
    input_schema   JSONB,
    nodes          JSONB NOT NULL DEFAULT '[]',
    edges          JSONB NOT NULL DEFAULT '[]',
    dependencies   JSONB NOT NULL DEFAULT '{}'::jsonb,
    timeout_ms     INTEGER NOT NULL DEFAULT 30000,
    max_retries    INTEGER NOT NULL DEFAULT 0,
    note           VARCHAR(500),
    updated_by     INTEGER,
    updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_drafts_slug
    ON management.workflow_drafts (slug);
