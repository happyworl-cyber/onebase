ALTER TABLE management.operation_logs
  ADD COLUMN IF NOT EXISTS summary_code TEXT,
  ADD COLUMN IF NOT EXISTS summary_params JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Backfill history: generic code that the frontend recomposes from structured columns.
UPDATE management.operation_logs
SET summary_code = 'oplog_generic',
    summary_params = jsonb_build_object(
      'verb', action,
      'resource_type', COALESCE(resource_type, ''),
      'resource_name', COALESCE(resource_name, '')
    )
WHERE summary_code IS NULL;
