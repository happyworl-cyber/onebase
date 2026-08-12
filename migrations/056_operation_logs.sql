-- 操作日志（Operation Logs）—— 面向租户、跨来源、带业务语义的操作审计。
--
-- 设计见 docs/superpowers/specs/2026-08-04-operation-logs-design.md
--
-- 与 audit_logs（HTTP 请求形态、平台视角、写中间件自动采集）区分：
-- 本表由各子系统在业务调用点显式打点（operation_log::record），
-- 覆盖工作流 / MCP / 数据库 / 定时 / 系统等非 HTTP 来源，并带 resource_type /
-- source / actor_type 等业务维度。变更内容存"结构化事实"，读时由后端格式化。

CREATE TABLE IF NOT EXISTS management.operation_logs (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     INTEGER NOT NULL,            -- 租户隔离（= project_id）
    -- 操作者：人 / 机器统一建模。MCP/API 经认证映射为真实用户(actor_type=user)，
    -- 仅 cron/system 为无人类主体的机器(actor_type=system)。
    actor_type    VARCHAR(16) NOT NULL,        -- user | system（token 预留）
    actor_id      INTEGER,                     -- user_id；system 为 NULL
    actor_name    VARCHAR(200),                -- 快照：用户名 / "系统调度器"
    actor_role    VARCHAR(100),                -- 快照：操作时租户角色 / "系统"
    source        VARCHAR(16) NOT NULL,        -- console | api | mcp | cron | system（VARCHAR，加值零成本）
    action        VARCHAR(24) NOT NULL,        -- CREATE|UPDATE|DELETE|READ|EXPORT|IMPORT|LOGIN|PERMISSION|TRIGGER|EXECUTE...
    resource_type VARCHAR(32),                 -- 工作流|数据库|数据表|API|用户|角色|定时任务|系统...
    resource_name VARCHAR(500),                -- 具体对象名（高基数，文本搜索）
    resource_id   VARCHAR(128),                -- 可选：对象主键
    summary       TEXT NOT NULL,               -- 人类可读「操作内容」（写入时给）
    status        VARCHAR(16) NOT NULL DEFAULT 'success',  -- success | failed
    high_risk     BOOLEAN NOT NULL DEFAULT false,
    ip            VARCHAR(64),
    user_agent    TEXT,
    session_id    VARCHAR(64),
    trace_id      VARCHAR(64),
    duration_ms   INTEGER,                     -- 保留字段，前端当前不展示
    detail        JSONB,                       -- method/endpoint/mcp_tool/query/error… + change（结构化事实，带 v）
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oplog_tenant_created ON management.operation_logs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oplog_actor          ON management.operation_logs(tenant_id, actor_id);
CREATE INDEX IF NOT EXISTS idx_oplog_action         ON management.operation_logs(tenant_id, action);
CREATE INDEX IF NOT EXISTS idx_oplog_resource_type  ON management.operation_logs(tenant_id, resource_type);
CREATE INDEX IF NOT EXISTS idx_oplog_source         ON management.operation_logs(tenant_id, source);
-- 高危 / 失败是常看子集，用部分索引省空间
CREATE INDEX IF NOT EXISTS idx_oplog_highrisk ON management.operation_logs(tenant_id, created_at DESC) WHERE high_risk;
CREATE INDEX IF NOT EXISTS idx_oplog_failed   ON management.operation_logs(tenant_id, created_at DESC) WHERE status = 'failed';
