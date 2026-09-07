-- 066: 依赖图运行状态聚合（workflow_handlers::query_dependency_graph_run_stats）。
-- 最近 N 天窗口的 total/failed 两个 COUNT 都要走 index-only scan，不回堆。
--   total  → 现有 idx_workflow_runs_wid(workflow_id, started_at DESC) 已覆盖；
--   failed → 失败是极少数（实测 67 万运行里 246 条），单独建 partial index，
--            体积几十 KB，且只有失败才写入，对运行写路径几乎零开销。
--
-- 谓词耦合（红线）：查询侧 workflow_handlers.rs 里的 `r.status IN ('failed', 'timeout')`
-- 必须与这里的谓词相同或为其子集，计划器才会用这个索引；改任何一边都要同步改另一边，
-- 否则不报错、不告警，直接退回 Bitmap Heap Scan（5s / 2.8GB 堆扫）。
-- 'timeout' 目前不会写进 workflow_runs.status（超时路径落的是 'failed'），保留它只是
-- 让谓词对未来可能的取值向前兼容，索引里不会因此多出任何行。
--
-- 部署方式：建议上线前在生产手工先跑本语句（CONCURRENTLY 不锁读写，客户端需自动提交），
-- 应用启动时的自动迁移因 IF NOT EXISTS 直接跳过，不占用启动时间、也不会让多副本堵在
-- 迁移 advisory lock 上等 CONCURRENTLY 的两轮快照等待。
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workflow_runs_failed
    ON management.workflow_runs (workflow_id, started_at DESC)
    WHERE status IN ('failed', 'timeout');

-- CONCURRENTLY 被中断会留下 INVALID 索引：计划器不用它、写路径却照样维护它，而上面的
-- IF NOT EXISTS 看到同名索引会静默跳过。这里主动把这种状态变成迁移 ERROR 日志，
-- 处理方式：DROP INDEX CONCURRENTLY management.idx_workflow_runs_failed; 再重跑本迁移。
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_index
        WHERE indexrelid = 'management.idx_workflow_runs_failed'::regclass
          AND NOT indisvalid
    ) THEN
        RAISE EXCEPTION 'idx_workflow_runs_failed 处于 INVALID 状态（上次 CONCURRENTLY 建索引被中断），请 DROP INDEX CONCURRENTLY 后重跑迁移 066';
    END IF;
END $$;
