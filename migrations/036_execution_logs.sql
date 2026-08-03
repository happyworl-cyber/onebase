-- ============================================
-- 统一执行日志（Unified Execution Logs）
-- ============================================
-- 背景：系统的执行记录此前散落在四张互不相干的表里
--   - API/HTTP 写操作   → management.audit_logs
--   - 数据库慢查询      → management.slow_query_logs
--   - 定时任务          → management.scheduled_task_runs
--   - 工作流            → management.workflow_runs
-- 加上只进 stdout 的 tracing JSON 日志，排障要同时翻四张表 + grep 文件，且没有
-- 统一的关联键把"一次执行 → N 条细节日志"串起来。
--
-- 本迁移加两层结构 + 一个贯穿全栈的关联键 trace_id：
--   1. execution_index：一次执行一行，四类来源统一字段 → 列表 + 筛选 + 一眼定位失败。
--   2. execution_logs ：一次执行下的逐条细节日志（P1 由 tracing DbLogLayer 写入）→
--      点进去看完整时间线。量大，保留 1 天（由后台清理任务按 ts 滚动删除）。
--   3. 给 workflow_runs / scheduled_task_runs 各加 trace_id 列，让"索引行 ↔ 权威 run
--      记录 ↔ 细节日志"三方靠 trace_id 闭环。
--
-- trace_id 用 TEXT 而非 UUID：复用 HTTP 链路已有的 x-request-id（见 request_id.rs，
-- 允许 UUID/KSUID/自研短 ID 等形态），后台/cron 无请求上下文时由应用层生成 UUID。

-- ── 执行索引层：一次执行一行，跨来源统一 ──
CREATE TABLE IF NOT EXISTS management.execution_index (
    id           BIGSERIAL PRIMARY KEY,
    trace_id     TEXT NOT NULL,                 -- 贯穿全栈的关联键（= x-request-id 或后台生成）
    source       VARCHAR(20) NOT NULL,          -- 'api' | 'db' | 'workflow' | 'scheduler' | 'rpc'
    ref_table    VARCHAR(40),                   -- 指回权威 run 表，如 'workflow_runs'
    ref_id       BIGINT,                        -- 权威 run 表的主键
    tenant_id    INTEGER,
    user_id      INTEGER,
    name         TEXT,                          -- 工作流名 / 任务名 / 请求路径
    status       VARCHAR(20) NOT NULL,          -- running|success|failed|timeout|cancelled
    started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at  TIMESTAMPTZ,
    duration_ms  INTEGER,
    error_brief  TEXT,                          -- 失败摘要，列表直接展示
    CONSTRAINT chk_ei_source CHECK (source IN ('api','db','workflow','scheduler','rpc'))
);

CREATE INDEX IF NOT EXISTS idx_ei_started ON management.execution_index(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ei_trace   ON management.execution_index(trace_id);
CREATE INDEX IF NOT EXISTS idx_ei_tenant  ON management.execution_index(tenant_id, started_at DESC);
-- 排障主路径：只扫失败/超时，部分索引很小、很快。
CREATE INDEX IF NOT EXISTS idx_ei_failed  ON management.execution_index(status, started_at DESC)
    WHERE status IN ('failed','timeout');

-- ── 细节事件层：逐条日志，量大，保留 1 天 ──
CREATE TABLE IF NOT EXISTS management.execution_logs (
    id           BIGSERIAL PRIMARY KEY,
    trace_id     TEXT NOT NULL,
    ts           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    level        VARCHAR(10) NOT NULL,          -- ERROR|WARN|INFO|DEBUG
    source       VARCHAR(20),                   -- api|db|workflow|scheduler|rpc
    logger       VARCHAR(80),                   -- tracing target：workflow/scheduler/access_log...
    span         VARCHAR(160),                  -- taskName：节点名 / 步骤名
    message      TEXT NOT NULL,
    fields       JSONB,                         -- 平铺的结构化字段（node_id/sql_type/status...）
    tenant_id    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_el_trace ON management.execution_logs(trace_id, ts);
CREATE INDEX IF NOT EXISTS idx_el_ts    ON management.execution_logs(ts);   -- 给 TTL 清理用
CREATE INDEX IF NOT EXISTS idx_el_level ON management.execution_logs(level, ts DESC)
    WHERE level IN ('ERROR','WARN');

-- ── 权威 run 表回填 trace_id（幂等加列）──
ALTER TABLE management.workflow_runs        ADD COLUMN IF NOT EXISTS trace_id TEXT;
ALTER TABLE management.scheduled_task_runs  ADD COLUMN IF NOT EXISTS trace_id TEXT;

CREATE INDEX IF NOT EXISTS idx_workflow_runs_trace ON management.workflow_runs(trace_id);
CREATE INDEX IF NOT EXISTS idx_str_trace           ON management.scheduled_task_runs(trace_id);
