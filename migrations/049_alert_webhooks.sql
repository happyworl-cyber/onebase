ALTER TABLE management.workflows
    ADD COLUMN IF NOT EXISTS alert_webhook_url TEXT,
    ADD COLUMN IF NOT EXISTS alert_webhook_template JSONB,
    ADD COLUMN IF NOT EXISTS alert_throttle_hours INTEGER NOT NULL DEFAULT 24,
    ADD COLUMN IF NOT EXISTS last_alert_sent_at TIMESTAMPTZ;

ALTER TABLE management.workflows
    DROP CONSTRAINT IF EXISTS chk_workflows_alert_webhook_url;
ALTER TABLE management.workflows
    ADD CONSTRAINT chk_workflows_alert_webhook_url CHECK (
        alert_webhook_url IS NULL
        OR (
            length(trim(alert_webhook_url)) > 0
            AND alert_webhook_url ~ '^https?://'
        )
    );

ALTER TABLE management.workflows
    DROP CONSTRAINT IF EXISTS chk_workflows_alert_webhook_template_object;
ALTER TABLE management.workflows
    ADD CONSTRAINT chk_workflows_alert_webhook_template_object CHECK (
        alert_webhook_template IS NULL
        OR jsonb_typeof(alert_webhook_template) = 'object'
    );

ALTER TABLE management.workflows
    DROP CONSTRAINT IF EXISTS chk_workflows_alert_throttle_hours;
ALTER TABLE management.workflows
    ADD CONSTRAINT chk_workflows_alert_throttle_hours CHECK (
        alert_throttle_hours BETWEEN 0 AND 720
    );

ALTER TABLE management.scheduled_tasks
    ADD COLUMN IF NOT EXISTS alert_webhook_url TEXT,
    ADD COLUMN IF NOT EXISTS alert_webhook_template JSONB,
    ADD COLUMN IF NOT EXISTS alert_throttle_hours INTEGER NOT NULL DEFAULT 24,
    ADD COLUMN IF NOT EXISTS last_alert_sent_at TIMESTAMPTZ;

ALTER TABLE management.scheduled_tasks
    DROP CONSTRAINT IF EXISTS chk_st_alert_webhook_url;
ALTER TABLE management.scheduled_tasks
    ADD CONSTRAINT chk_st_alert_webhook_url CHECK (
        alert_webhook_url IS NULL
        OR (
            length(trim(alert_webhook_url)) > 0
            AND alert_webhook_url ~ '^https?://'
        )
    );

ALTER TABLE management.scheduled_tasks
    DROP CONSTRAINT IF EXISTS chk_st_alert_webhook_template_object;
ALTER TABLE management.scheduled_tasks
    ADD CONSTRAINT chk_st_alert_webhook_template_object CHECK (
        alert_webhook_template IS NULL
        OR jsonb_typeof(alert_webhook_template) = 'object'
    );

ALTER TABLE management.scheduled_tasks
    DROP CONSTRAINT IF EXISTS chk_st_alert_throttle_hours;
ALTER TABLE management.scheduled_tasks
    ADD CONSTRAINT chk_st_alert_throttle_hours CHECK (
        alert_throttle_hours BETWEEN 0 AND 720
    );
