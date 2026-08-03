-- 工作流 Cron 触发去重表
--
-- 目的：解决「多实例部署 / 同一分钟多次 tick」导致同一 cron 工作流被重复触发。
-- 触发前用唯一键 (workflow_id, fired_minute) 做一次原子抢占（INSERT ... ON CONFLICT
-- DO NOTHING）：插入成功的实例才执行，冲突者跳过。fired_minute 为分钟粒度的时间桶。
--
-- 表会持续增长，由触发器循环里的定期 DELETE（保留最近若干天）清理。
CREATE TABLE IF NOT EXISTS management.workflow_cron_fires (
    workflow_id  INTEGER NOT NULL,
    -- 分钟粒度时间桶（秒/纳秒清零）。同一 (workflow_id, fired_minute) 只允许触发一次。
    fired_minute TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workflow_id, fired_minute)
);

-- 清理旧行时按时间扫描
CREATE INDEX IF NOT EXISTS idx_workflow_cron_fires_minute
    ON management.workflow_cron_fires(fired_minute);
