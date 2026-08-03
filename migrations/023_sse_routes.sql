-- SSE 转发/路由规则表
--
-- 当数据变更命中 event_pattern（schema.table.action，支持 * 通配）时，由 SseRouteManager
-- 把事件推到 topic_template 解析出的 topic（占位符 {database_id} {schema} {table} {action}）。
-- 与 webhooks 同范式；内置的 db:{id}:table:{schema}.{table} 桥接仍然保留，本表是额外的自定义路由。
CREATE TABLE IF NOT EXISTS management.sse_routes (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    -- NULL = 该租户下所有库；否则仅限定的具体库
    database_id INTEGER REFERENCES management.tenant_databases(id) ON DELETE CASCADE,
    event_pattern VARCHAR(200) NOT NULL,   -- 如 "public.orders.INSERT" / "public.*.UPDATE" / "*.*.*"
    topic_template TEXT NOT NULL,          -- 如 "db:{database_id}:orders:{action}"
    event_name VARCHAR(100),               -- SSE event 字段；NULL 时默认用 action
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sse_routes_tenant ON management.sse_routes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sse_routes_active ON management.sse_routes(is_active) WHERE is_active = true;

CREATE TRIGGER update_sse_routes_updated_at BEFORE UPDATE ON management.sse_routes
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();
