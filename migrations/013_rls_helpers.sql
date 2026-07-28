-- ============================================================
-- PostgreSQL Row-Level Security 辅助函数
-- ============================================================
-- 此迁移在【业务库】（即 tenant_databases 里挂载的库）执行，
-- 不在 management 库里执行。
--
-- 核心：Onebase 每次请求会在事务里执行
--      SELECT set_config('app.current_user_id', '<jwt.sub>', true);
-- 业务表的 RLS POLICY 可以直接调用 app.current_user_id() 拿到当前用户 ID，
-- 写起来比 NULLIF(current_setting(...), '')::int 更短、更可读。
--
-- 注意：迁移管理目前是 Onebase 容器启动时自动跑控制库的 SQL；
--      业务库的 RLS 启用 / POLICY 由 DBA 手动 / CI 流水线在业务库执行。
--      本文件可以直接 psql -f 到业务库，**不会**对控制库产生影响。

-- 创建 app schema（避免污染 public 命名空间）
CREATE SCHEMA IF NOT EXISTS app;

-- 取当前 JWT 用户 ID
-- - 没有 SET 时返回 NULL（current_setting 第二个参数 true 表示 missing_ok）
-- - SET 为 '0' 时（API Key / 匿名）返回 NULL
-- - 其它情况转 int 返回
CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS INT
LANGUAGE SQL
STABLE
PARALLEL SAFE
AS $$
    SELECT NULLIF(current_setting('app.current_user_id', true), '0')::int
$$;

COMMENT ON FUNCTION app.current_user_id() IS
    'Onebase 当前请求 JWT 用户 ID；未登录或匿名（API Key）返回 NULL';

-- 给所有可登录角色 USAGE 权限（business DB 里的应用角色都需要能调用）
GRANT USAGE ON SCHEMA app TO PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO PUBLIC;
