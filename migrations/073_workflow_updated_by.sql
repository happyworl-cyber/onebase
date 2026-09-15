-- 073: 工作流最近修改人；保存草稿 / 发布时写入，启停与挪分类不改。
ALTER TABLE management.workflows
  ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_workflows_updated_by
  ON management.workflows(updated_by);

UPDATE management.workflows w
SET updated_by = COALESCE(
  (SELECT d.updated_by FROM management.workflow_drafts d WHERE d.workflow_id = w.id),
  (SELECT v.created_by FROM management.workflow_versions v
    WHERE v.workflow_id = w.id ORDER BY v.version DESC LIMIT 1),
  w.created_by
)
WHERE w.updated_by IS NULL;
