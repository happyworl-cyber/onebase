ALTER TABLE management.workflows
  ADD COLUMN IF NOT EXISTS dependencies JSONB NOT NULL DEFAULT '{}'::jsonb;
