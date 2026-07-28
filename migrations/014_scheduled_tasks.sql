-- ============================================
-- 定时任务（Scheduled Tasks）
-- ============================================
-- 单表设计：任务定义 + 调度状态合一存一行，避免双表事务。
-- 多实例去重靠 SELECT ... FOR UPDATE SKIP LOCKED。
-- claimed_at 列在实例崩溃后由下一个活着的 runner 在 tick Step 1 回收。

CREATE TABLE IF NOT EXISTS management.scheduled_tasks (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       INTEGER NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    name            VARCHAR(200) NOT NULL,
    description     TEXT,

    cron_expr       VARCHAR(100) NOT NULL,
    timezone        VARCHAR(50)  NOT NULL DEFAULT 'UTC',

    kind            VARCHAR(20)  NOT NULL,

    database_id     INTEGER REFERENCES management.tenant_databases(id) ON DELETE CASCADE,
    rpc_schema      VARCHAR(63),
    rpc_fn_name     VARCHAR(63),
    rpc_args        JSONB,

    http_method     VARCHAR(10),
    http_url        TEXT,
    http_headers    JSONB,
    http_body       JSONB,
    http_secret_enc TEXT,

    is_active       BOOLEAN NOT NULL DEFAULT true,
    timeout_secs    INTEGER NOT NULL DEFAULT 60,
    max_retries     INTEGER NOT NULL DEFAULT 0,
    overlap_policy  VARCHAR(20) NOT NULL DEFAULT 'skip',

    next_run_at     TIMESTAMPTZ,
    last_run_at     TIMESTAMPTZ,
    last_run_status VARCHAR(20),
    claimed_at      TIMESTAMPTZ,
    claimed_by      VARCHAR(100),

    created_by      INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_st_kind CHECK (kind IN ('rpc', 'http')),
    CONSTRAINT chk_st_kind_rpc CHECK (
        kind <> 'rpc' OR (database_id IS NOT NULL AND rpc_schema IS NOT NULL AND rpc_fn_name IS NOT NULL)
    ),
    CONSTRAINT chk_st_kind_http CHECK (
        kind <> 'http' OR (http_method IS NOT NULL AND http_url IS NOT NULL)
    ),
    CONSTRAINT chk_st_overlap CHECK (overlap_policy IN ('skip', 'allow')),
    CONSTRAINT chk_st_timeout CHECK (timeout_secs > 0 AND timeout_secs <= 3600),
    CONSTRAINT chk_st_retries CHECK (max_retries >= 0 AND max_retries <= 10)
);

CREATE INDEX IF NOT EXISTS idx_st_due ON management.scheduled_tasks(next_run_at)
    WHERE is_active = true AND claimed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_st_tenant ON management.scheduled_tasks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_st_stale_claim ON management.scheduled_tasks(claimed_at)
    WHERE claimed_at IS NOT NULL;


CREATE TABLE IF NOT EXISTS management.scheduled_task_runs (
    id              BIGSERIAL PRIMARY KEY,
    task_id         BIGINT NOT NULL REFERENCES management.scheduled_tasks(id) ON DELETE CASCADE,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at     TIMESTAMPTZ,
    status          VARCHAR(20) NOT NULL,
    runner_id       VARCHAR(100),
    output          JSONB,
    error_message   TEXT,
    duration_ms     INTEGER,
    attempt_number  INTEGER NOT NULL DEFAULT 1,
    triggered_by    VARCHAR(20) NOT NULL DEFAULT 'cron',

    CONSTRAINT chk_str_status CHECK (status IN ('running', 'success', 'failed', 'timeout', 'cancelled')),
    CONSTRAINT chk_str_trigger CHECK (triggered_by IN ('cron', 'manual'))
);

CREATE INDEX IF NOT EXISTS idx_str_task ON management.scheduled_task_runs(task_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_str_status ON management.scheduled_task_runs(status, started_at DESC);
