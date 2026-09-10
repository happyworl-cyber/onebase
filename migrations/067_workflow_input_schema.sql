-- 067: 工作流显式输入 Schema。
ALTER TABLE management.workflows
  ADD COLUMN IF NOT EXISTS input_schema JSONB DEFAULT NULL;

ALTER TABLE management.workflow_versions
  ADD COLUMN IF NOT EXISTS input_schema JSONB DEFAULT NULL;
