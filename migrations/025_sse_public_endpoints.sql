-- 通用对外事件订阅端点配置表
--
-- 通用 handler GET /events/{slug}（src/sse.rs）按本表逐条驱动：
-- 从 identity_header 指定的可信请求头取身份，按 topic_template 渲染订阅 topic
-- （{identity} 必填、保证只能订到自己的；{query.X} 取 URL query，缺省退化为末尾通配 *），
-- 命中的消息以 event_name 为事件名、payload 原样透传给客户端。
--
-- 配置维护：后台「实时推送规则 → 对外端点」页可视化增删改
-- （API：/api/admin/sse-public-endpoints，超管 + 端点所属租户 owner/admin）。
CREATE TABLE IF NOT EXISTS management.sse_public_endpoints (
    id              SERIAL PRIMARY KEY,
    tenant_id       INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    -- URL 路径：GET /events/{slug}，全局唯一，仅 [a-z0-9-]
    slug            VARCHAR(64)  NOT NULL UNIQUE,
    name            VARCHAR(100) NOT NULL,
    -- 可信身份头（网关注入），如 X-Way-UID
    identity_header VARCHAR(64)  NOT NULL,
    -- 订阅 topic 模板，必含 {identity}，可含 {query.X}；{identity} 必须在所有 {query.X} 之前
    topic_template  TEXT         NOT NULL,
    -- 下发的 SSE event 名
    event_name      VARCHAR(100) NOT NULL,
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sse_public_endpoints_active
    ON management.sse_public_endpoints(is_active) WHERE is_active = true;

CREATE TRIGGER update_sse_public_endpoints_updated_at BEFORE UPDATE ON management.sse_public_endpoints
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();

-- 成长动画启用示例（运维执行一次，或在页面「对外端点」新建；<TENANT_ID> 换成实际租户 id）：
--
--   INSERT INTO management.sse_public_endpoints (tenant_id, slug, name, identity_header, topic_template, event_name)
--   VALUES (<TENANT_ID>, 'growth-animation', '成长动画', 'X-Way-UID',
--           'way:{identity}:growth:{query.projectId}', 'growth_animation_available')
--   ON CONFLICT (slug) DO NOTHING;
