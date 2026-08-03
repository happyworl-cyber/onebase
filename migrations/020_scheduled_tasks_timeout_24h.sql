-- Expand scheduled task per-run timeout upper bound from 1 hour to 24 hours.
ALTER TABLE management.scheduled_tasks
    DROP CONSTRAINT IF EXISTS chk_st_timeout;

ALTER TABLE management.scheduled_tasks
    ADD CONSTRAINT chk_st_timeout
    CHECK (timeout_secs > 0 AND timeout_secs <= 86400);
