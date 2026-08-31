-- 定时任务 kind=workflow：进程内调用 execute_workflow_internal。

ALTER TABLE management.scheduled_tasks
    ADD COLUMN IF NOT EXISTS workflow_id INTEGER
        REFERENCES management.workflows(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS workflow_slug VARCHAR(200),
    ADD COLUMN IF NOT EXISTS workflow_input JSONB;

ALTER TABLE management.scheduled_tasks
    DROP CONSTRAINT IF EXISTS chk_st_kind;

ALTER TABLE management.scheduled_tasks
    ADD CONSTRAINT chk_st_kind CHECK (kind IN ('rpc', 'http', 'shell', 'workflow'));

ALTER TABLE management.scheduled_tasks
    DROP CONSTRAINT IF EXISTS chk_st_kind_workflow;

ALTER TABLE management.scheduled_tasks
    ADD CONSTRAINT chk_st_kind_workflow CHECK (
        kind <> 'workflow'
        OR (
            tenant_id IS NOT NULL
            AND workflow_id IS NOT NULL
        )
    );
