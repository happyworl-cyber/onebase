-- PG NOTIFY → SSE 监听桥配置表
--
-- 监听桥（src/sse_notify_bridge.rs）按本表逐条 LISTEN 业务库的某个 channel，
-- 收到 NOTIFY 后用 topic_template（占位符取 payload 字段，如 {wayUid} {projectId}）
-- 算出 SSE topic 并 publish_local 推给已连接的浏览器。
--
-- 配置维护：后台「实时推送规则 → NOTIFY 监听桥」页可视化增删改
-- （API：/api/admin/sse-notify-bridges，超管 + 库所属租户 owner/admin）。
-- 成长动画即本表的一行配置（也可直接执行文件末尾注释的示例 INSERT）。
CREATE TABLE IF NOT EXISTS management.sse_notify_bridges (
    id SERIAL PRIMARY KEY,
    -- 要监听 NOTIFY 的业务库
    database_id INTEGER NOT NULL REFERENCES management.tenant_databases(id) ON DELETE CASCADE,
    -- LISTEN 的 channel 名（PG 标识符，≤63 字节），如 'growth_animation_available'
    channel VARCHAR(63) NOT NULL,
    -- 目标 SSE topic 模板，{key} 取 NOTIFY payload 字段，如 'way:{wayUid}:growth:{projectId}'
    topic_template TEXT NOT NULL,
    -- SSE event 字段，如 'growth_animation_available'
    event_name VARCHAR(100) NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (database_id, channel, topic_template)
);

CREATE INDEX IF NOT EXISTS idx_sse_notify_bridges_active
    ON management.sse_notify_bridges(is_active) WHERE is_active = true;

CREATE TRIGGER update_sse_notify_bridges_updated_at BEFORE UPDATE ON management.sse_notify_bridges
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();

-- 成长动画启用示例（运维执行一次，把 <BUSINESS_DB_ID> 换成实际业务库 id）：
--
--   INSERT INTO management.sse_notify_bridges (database_id, channel, topic_template, event_name)
--   VALUES (<BUSINESS_DB_ID>, 'growth_animation_available', 'way:{wayUid}:growth:{projectId}', 'growth_animation_available')
--   ON CONFLICT (database_id, channel, topic_template) DO NOTHING;
