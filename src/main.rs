mod admin_handlers;
mod audit_handlers;
mod es;
mod postgrest_compat;
mod audit_middleware;
mod auth;
mod auth_handlers;
mod auto_api_handlers;
mod circuit_breaker;
mod config;
mod crypto;
mod db;
mod error;
mod events;
mod export_handlers;
mod handlers;
mod index_handlers;
mod logging;
mod lua_builtins;
mod lua_engine;
mod middleware;
mod workflow_engine;
mod workflow_handlers;
mod workflow_trigger;
mod query_perf_handlers;
mod models;
mod monitor_handlers;
mod permissions;
mod pool_manager;
mod query_builder;
mod raw_sql_guard;
mod rbac_handlers;
mod rbac_middleware;
mod rbac_models;
mod rate_limiter;
mod realtime;
mod request_id;
mod redis_manager;
mod redis_pubsub;
mod rpc;
mod permission_cache;
mod query_cache;
mod schema_handlers;
mod scheduler;
mod scheduler_handlers;
mod sso;
mod sso_handlers;
mod tenant_handlers;
mod tenant_models;
mod transaction;
mod gateway_handlers;
mod watchdog;
mod webhook_handlers;
mod webhook_manager;

use axum::{
    extract::State,
    middleware as axum_middleware,
    routing::{delete, get, patch, post},
    Json, Router,
};
use config::Config;
use error::AppError;
use serde_json::Value;
use sqlx::PgPool;
use std::time::Duration;
use tower_http::{
    catch_panic::CatchPanicLayer,
    cors::CorsLayer,
    set_header::SetResponseHeaderLayer,
    timeout::TimeoutLayer,
};
use axum::http::HeaderValue;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // `_log_guard` 必须存活到 main 结束。`tracing-appender` 的非阻塞 writer 把后台
    // flush 线程的句柄塞在 guard 里，guard 一 drop 后台线程就停了，文件日志会被
    // 静默吞掉。前缀 `_` 是表明"故意不读取它，只为了延长生命周期"。
    let _log_guard = logging::init();

    let config = Config::from_env()?;
    tracing::info!("配置加载成功");

    // 启动期 fail-fast：缺少 ENCRYPTION_KEY 直接 panic（与 JWT_SECRET 一致）
    crypto::ensure_initialized();

    let pool = db::create_pool(&config.database_url).await?;

    // Redis 是可选基础设施，但缺失会让多个能力降级 / 失效。
    // - REQUIRE_REDIS=true 时启动失败直接 panic，避免多实例部署下静默运行
    //   出问题（典型是 Pub/Sub 事件桥不挂载，WebSocket 实时推送在多实例间不工作）。
    // - 默认（REQUIRE_REDIS=false）保持向后兼容：单实例 / 开发环境可继续无 Redis 跑。
    let redis = match redis_manager::RedisManager::new(&config.redis_url).await {
        Ok(r) => {
            tracing::info!("Redis 连接成功 ({})", config.redis_url);
            Some(r)
        }
        Err(e) => {
            if config.require_redis {
                panic!(
                    "REQUIRE_REDIS=true 但 Redis 连接失败 ({}): {}。\
                     生产 / 多实例部署必须有 Redis；如确实要在无 Redis 下运行请取消 REQUIRE_REDIS。",
                    config.redis_url, e
                );
            }
            tracing::warn!(
                "Redis 不可用 ({}): {}。组件降级状态：\n\
                 \t- RateLimiter:      启用本地内存兑底（每实例独立计数，跨实例无全局上限）\n\
                 \t- PermissionCache:  禁用（每次 RBAC 都打 DB）\n\
                 \t- QueryCache:       禁用（Auto API 无查询结果缓存）\n\
                 \t- Redis Pub/Sub:    \u{26a0} 未挂载（多实例部署下 WebSocket / 实时推送在实例间不工作）\n\
                 多实例部署请设置 REQUIRE_REDIS=true 让启动 fail-fast 而非静默降级。",
                config.redis_url, e
            );
            None
        }
    };

    let cors = if config.cors_origins.len() == 1 && config.cors_origins[0] == "*" {
        CorsLayer::new()
            .allow_origin(tower_http::cors::Any)
            .allow_methods(tower_http::cors::Any)
            .allow_headers(tower_http::cors::Any)
    } else {
        let origins: Vec<_> = config
            .cors_origins
            .iter()
            .filter_map(|o| o.parse::<axum::http::HeaderValue>().ok())
            .collect();
        CorsLayer::new()
            .allow_origin(origins)
            .allow_methods(tower_http::cors::Any)
            .allow_headers(tower_http::cors::Any)
    };

    // 公开路由（无需认证）
    let public_routes = Router::new()
        .route("/", get(root_handler))
        .route("/health", get(health_check))
        .route("/health/live", get(health_live))
        .route("/health/ready", get(health_ready))
        .route("/auth/register", post(auth_handlers::register))
        .route("/auth/login", post(auth_handlers::login));

    // ─── /query 与 /transaction：高危原始 SQL 通道（仅超管） ─────────────────────
    //
    // 这两条路由的访问控制策略由本组中间件链**自洽**地完成（不依赖任何全局兜底）：
    //   1. `auth_middleware`            —— 强制 Bearer token + JTI 会话有效；
    //   2. `require_superadmin_middleware` —— 非超管立即 403；
    //   3. `dynamic_db_middleware`      —— 按 `X-Database-Id` 切到目标租户库连接池，
    //      没带头时 handler 会回落 main_pool（管理库）。
    //
    // ⚠️ 关于"SQL 注入过滤"：/query 的本质就是"执行任意 SQL"，不存在解析器级过滤；
    //    护栏只有三道——**仅超管**、`read_only` 标记拒绝写、`is_dangerous_operation()`
    //    黑名单拦 `DROP DATABASE / DROP SCHEMA / TRUNCATE`。handler 还会写一条
    //    `raw_sql_audit` 结构化日志（user_id / database_id / sql_type / sql_len）。
    //
    // ⚠️ 数据隔离：必须串接 dynamic_db_middleware，按请求头 X-Database-Id 切换到
    // 目标租户库的连接池；否则不带 / 误带头时 handler 会 fallback 到管理库
    // (onebase) 上跑 SELECT * FROM users，把超管 / 租户元数据当作业务数据返回，
    // 这是严重的跨租户数据泄漏。
    let sql_routes = Router::new()
        .route("/transaction", post(transaction::execute_transaction))
        .route("/query", post(execute_sql_query))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::dynamic_db_middleware))
        .layer(axum_middleware::from_fn(middleware::require_superadmin_middleware))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::auth_middleware));

    let protected_routes = Router::new()
        .route("/auth/me", get(auth_handlers::get_me))
        .route("/auth/refresh", post(auth_handlers::refresh_token))
        .route("/auth/logout", post(auth_handlers::logout))
        .route("/auth/change-password", post(auth_handlers::change_password))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::auth_middleware));

    // Schema 元数据 / DDL：
    // - 只读接口（list_schemas / list_tables / get_table_structure / get_table_relationships）
    //   对所有租户成员开放——`dynamic_db_middleware` 已经把"用户必须属于该 tenant"
    //   作为前置条件，不再叠加超管锁，避免租户 admin 也看不到自己库的表。
    // - 写接口（create_schema / drop_schema）在 handler 内部用 `require_database_admin`
    //   二次校验：仅平台超管或租户 owner/admin 可执行 DDL。
    let schema_routes = Router::new()
        .route("/api/schemas", get(schema_handlers::list_schemas).post(schema_handlers::create_schema))
        .route("/api/schemas/:schema", delete(schema_handlers::drop_schema))
        .route("/api/schema/:schema/tables", get(schema_handlers::list_tables))
        .route("/api/schema/:schema/table/:table/structure", get(schema_handlers::get_table_structure))
        .route("/api/schema/:schema/table/:table/relationships", get(schema_handlers::get_table_relationships))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::dynamic_db_middleware))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::auth_middleware));

    // 索引管理（按 RBAC 鉴权）— 在 handler 内对目标表做 SELECT/ALL 校验，
    // 超管由 require_table_permission/require_schema_permission 内部短路放行。
    let index_routes = Router::new()
        .route("/api/indexes", post(index_handlers::create_index))
        .route("/api/indexes/:schema", get(index_handlers::list_indexes))
        .route("/api/indexes/:schema/:index_name", delete(index_handlers::drop_index))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::dynamic_db_middleware))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::auth_middleware));

    // 查询性能 / 慢查询日志 — 走租户库（X-Database-Id），handler 内做读权限校验，
    // 重置统计 / 取消查询这种破坏性操作 handler 内强制超管。
    let query_perf_routes = Router::new()
        .route("/api/query-perf/extension", get(query_perf_handlers::get_extension_status))
        .route("/api/query-perf/statements", get(query_perf_handlers::list_statements))
        .route("/api/query-perf/statements/reset", post(query_perf_handlers::reset_statements))
        .route("/api/query-perf/active", get(query_perf_handlers::list_active_queries))
        .route("/api/query-perf/active/:pid/cancel", post(query_perf_handlers::cancel_active_query))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::dynamic_db_middleware))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::auth_middleware));

    // 数据导出：
    // - per-table CSV/JSON 导出（/api/export/csv|json/:schema/:table）→ 租户 owner/admin。
    // - 任意 SELECT 导出（/api/export/sql/csv）→ 仍仅平台超管，避免给 RBAC 一个后门。
    // 之前所有 handler 都接 `State<PgPool>`（管理库），且没挂 `dynamic_db_middleware`，
    // 等价于"超管在 management 库上导数据"——这里补上路由 + handler 内 strict 校验。
    let export_routes = Router::new()
        .route("/api/export/csv/:schema/:table", get(export_handlers::export_csv))
        .route("/api/export/json/:schema/:table", get(export_handlers::export_json))
        .route("/api/export/sql/csv", post(export_handlers::export_sql_csv))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::dynamic_db_middleware))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::auth_middleware));

    // 监控 / 慢查询 / 连接：
    // - 路由层只挂 auth + dynamic_db；handler 内部统一调用 `require_monitor_access`
    //   断言 "X-Database-Id 存在 + 当前用户是 db 的 owner/admin（或平台超管）"。
    // - 收窄到 owner/admin 是因为 slow-queries / active-connections 会暴露 SQL 文本
    //   （WHERE 子句参数可能含业务数据），不是 viewer 应当看到的。
    let monitor_routes = Router::new()
        .route("/api/monitor/stats", get(monitor_handlers::get_database_stats))
        .route("/api/monitor/tables", get(monitor_handlers::get_table_sizes))
        .route("/api/monitor/slow-queries", get(monitor_handlers::get_slow_queries))
        .route("/api/monitor/connections", get(monitor_handlers::get_active_connections))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::dynamic_db_middleware))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::auth_middleware));

    let tenant_routes = Router::new()
        .route("/api/tenants/my-connections", get(tenant_handlers::get_my_connections))
        .route("/api/tenants/:tenant_id/schemas", get(tenant_handlers::get_tenant_schemas))
        .route("/api/tenants/test-connection", post(tenant_handlers::test_connection))
        .route("/api/tenants/connections", post(tenant_handlers::create_database_connection))
        .route("/api/tenants/switch-connection", post(tenant_handlers::switch_connection))
        .route("/api/tenants/pool-stats", get(tenant_handlers::get_pool_stats))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::auth_middleware));
    
    // 超管租户管理（仅超管）
    let superadmin_tenant_routes = Router::new()
        .route("/api/admin/all-tenants", get(tenant_handlers::list_all_tenants))
        .route("/api/admin/tenants/create", post(tenant_handlers::create_tenant))
        .route(
            "/api/admin/tenants/:tenant_id",
            delete(tenant_handlers::delete_tenant)
                .patch(tenant_handlers::update_tenant),
        )
        .route(
            "/api/admin/tenants/:tenant_id/replicas",
            get(tenant_handlers::list_tenant_replicas)
                .post(tenant_handlers::add_tenant_replica),
        )
        // 健康检查放到一个独立路径，避免与 :replica_id 路由参数冲突
        .route(
            "/api/admin/tenants/:tenant_id/replicas-health",
            get(tenant_handlers::get_replicas_health),
        )
        .route(
            "/api/admin/tenants/:tenant_id/replicas/:replica_id",
            patch(tenant_handlers::update_tenant_replica)
                .delete(tenant_handlers::delete_tenant_replica),
        )
        .route("/api/admin/all-users", get(tenant_handlers::list_all_users))
        .route("/api/admin/users/:user_id/assign-tenant", post(tenant_handlers::assign_user_to_tenant))
        .layer(axum_middleware::from_fn(middleware::require_superadmin_middleware))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::auth_middleware));

    // 平台租户/用户管理（仅超管）
    let admin_routes = Router::new()
        .route("/api/admin/tenants", get(admin_handlers::list_tenants))
        .route("/api/admin/tenants", post(admin_handlers::create_tenant))
        .route("/api/admin/tenants/:tenant_id/status", patch(admin_handlers::update_tenant_status))
        .route("/api/admin/tenants/:tenant_id/users", get(admin_handlers::list_tenant_users))
        .route("/api/admin/users", get(admin_handlers::list_users).post(admin_handlers::admin_create_user))
        .route("/api/admin/users/:user_id",
            patch(admin_handlers::admin_update_user)
            .delete(admin_handlers::admin_delete_user))
        .route("/api/admin/users/:user_id/reset-password", post(admin_handlers::admin_reset_password))
        .route("/api/admin/tenant-users", post(admin_handlers::add_user_to_tenant))
        .route("/api/admin/tenant-users/:user_id/:tenant_id", delete(admin_handlers::remove_user_from_tenant))
        .route("/api/admin/stats", get(admin_handlers::get_system_stats))
        .layer(axum_middleware::from_fn(middleware::require_superadmin_middleware))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::auth_middleware));

    // 旧版 PostgREST 风格路由（**仅超管 / admin-direct CRUD**，故意旁路 RBAC）
    //
    // 这是平台维护接口，不是业务 API：
    //   * 中间件链 `auth + require_superadmin + dynamic_db` 决定了非超管直接 403，
    //     所以"普通用户能绕过 RBAC"的担心在路由层就被挡住了。
    //   * 行/列条件、API Key scope、审计写表等业务约束**全部不走** —— 它和直连 psql
    //     基本等价，仅为 dashboard 表编辑器 / 运维快速调试保留。
    //   * 业务集成必须改用 `/api/v1/{database_id}/{schema}/{table}`，它走 rbac_middleware。
    //
    // `deprecated_legacy_crud_middleware` 会在响应里注入 `Deprecation`/`Link`/`Sunset`
    // 头，并打 `legacy_api` 结构化日志，便于后续根据真实调用量决定何时改判 410 Gone。
    //
    // 注：必须挂 dynamic_db_middleware，否则 X-Database-Id 头被丢弃，
    // 所有请求都会落到管理库（最常见的表现：访问租户里刚建的表，提示 relation does not exist）。
    let api_routes = Router::new()
        .route("/api/:schema/:table", get(handlers::get_records))
        .route("/api/:schema/:table", post(handlers::create_record))
        .route("/api/:schema/:table", patch(handlers::update_records))
        .route("/api/:schema/:table", delete(handlers::delete_records))
        // 放在最内层（紧贴 handler）：此时 Claims 已经被 auth_middleware 注入，
        // 审计日志可以记录到 user_id；同时只有真正命中 handler 的请求才被打弃用标签，
        // 401/403 不会被打——它们本来就是"这条路不通"，不需要再多余地宣告弃用。
        .layer(axum_middleware::from_fn(middleware::deprecated_legacy_crud_middleware))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::dynamic_db_middleware))
        .layer(axum_middleware::from_fn(middleware::require_superadmin_middleware))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::auth_middleware));

    let rbac_routes = Router::new()
        .route("/api/rbac/roles", get(rbac_handlers::list_roles).post(rbac_handlers::create_role))
        .route("/api/rbac/roles/:id", patch(rbac_handlers::update_role).delete(rbac_handlers::delete_role))
        .route("/api/rbac/roles/:id/permissions", get(rbac_handlers::get_role_permissions).put(rbac_handlers::set_role_permissions))
        .route("/api/rbac/permissions", get(rbac_handlers::list_permissions).post(rbac_handlers::create_permission))
        .route("/api/rbac/permissions/:id", patch(rbac_handlers::update_permission).delete(rbac_handlers::delete_permission))
        .route("/api/rbac/users/:user_id/roles", get(rbac_handlers::get_user_roles).post(rbac_handlers::assign_user_role))
        .route("/api/rbac/users/:user_id/roles/:role_id", delete(rbac_handlers::remove_user_role))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::auth_middleware));

    let sso_public_routes = Router::new()
        .route("/auth/sso/providers", get(sso_handlers::list_public_providers))
        .route("/auth/sso/:provider/authorize", get(sso_handlers::sso_authorize))
        .route("/auth/sso/:provider/callback", get(sso_handlers::sso_callback));

    // SSO Provider 管理（超管 + 租户 owner/admin）
    //
    // 路由层只做认证；handler 内部用 `TenantContext` 把请求绑定到指定租户，
    // 然后调用 `permissions::require_tenant_admin` 再断言一次"超管或该租户管理员"。
    // 之前路由层挂 `require_superadmin_middleware` → 租户 admin 自己配自家 SSO 不行，
    // 必须找平台超管，不现实。
    let sso_admin_routes = Router::new()
        .route("/api/sso/providers", get(sso_handlers::admin_list_providers).post(sso_handlers::admin_create_provider))
        .route("/api/sso/providers/:id", patch(sso_handlers::admin_update_provider).delete(sso_handlers::admin_delete_provider))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::auth_middleware));

    let auto_api_routes = Router::new()
        .route("/api/v1/:database_id/:schema/:table",
            get(auto_api_handlers::list_records)
            .post(auto_api_handlers::create_record)
            // 批量按 query filter 更新 / 删除；handler 强制至少要一个 filter，
            // 防止漏写 WHERE 把整张表改没了。和 PostgREST `PATCH /t?pk=eq.v` 同语义。
            .patch(auto_api_handlers::update_records)
            .delete(auto_api_handlers::delete_records))
        .route("/api/v1/:database_id/:schema/:table/:id",
            get(auto_api_handlers::get_record)
            .patch(auto_api_handlers::update_record)
            .delete(auto_api_handlers::delete_record))
        // PostgREST 兼容两段路径：schema 由 Accept-Profile / Content-Profile 头决定，
        // X-Project-IDs 头自动转 `project_id.in=(...)`。**不是 layer-rewrite**：早期
        // 用 `Router::layer` 改 URI 的方案行不通 —— axum 0.7 的 layer 是 per-route 包
        // 装，路由匹配在 layer 之前完成（未匹配时落 fallback 的 NotFound，layer 改
        // URI 来不及）。改成显式注册路由 + handler 内部 forward 才能用同一套 RBAC /
        // 熔断 / 缓存。详见 src/postgrest_compat.rs 顶部注释。
        //
        // GET / POST / PATCH / DELETE 全套支持：
        //   GET    /api/v1/:db/:table?filter=...  → list_records_pgrest
        //   POST   /api/v1/:db/:table             → create_record_pgrest
        //   PATCH  /api/v1/:db/:table?filter=...  → update_records_pgrest（批量按 filter）
        //   DELETE /api/v1/:db/:table?filter=...  → delete_records_pgrest（批量按 filter）
        //
        // 单条记录按主键操作请用 PostgREST 标准 `?pk=eq.value`；不再提供
        // `/api/v1/:db/:table/:id` 形态（会与 :db/:schema/:table 撞段数）。
        .route("/api/v1/:database_id/:table",
            get(auto_api_handlers::list_records_pgrest)
            .post(auto_api_handlers::create_record_pgrest)
            .patch(auto_api_handlers::update_records_pgrest)
            .delete(auto_api_handlers::delete_records_pgrest))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), rbac_middleware::rbac_middleware))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::dynamic_db_middleware))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::auth_middleware));

    // PostgREST 风格的 RPC（存储过程调用）路由：/api/v1/:database_id/rpc/:fn_name
    //
    // URL 形态与 Auto API（/api/v1/:database_id/:schema/:table）一致——项目 ID
    // 直接出现在路径里，调用方组路径只需要一套规则；不再依赖 X-Database-Id 头。
    // 路由匹配上 axum 的 matchit 优先静态段（"rpc"），所以不会与 Auto API 冲突。
    //
    // 行为对齐 PostgREST：
    //   POST  body 是 JSON object，字段名 = 形参名；schema 由 Content-Profile 头选
    //   GET   形参从 query string 取（每个值先按 JSON 解析再兜底字符串）；
    //         schema 由 Accept-Profile 头选
    //
    // 身份：rpc_auth_middleware 同时支持 JWT 与 API Key（`apikey` 或
    //   `Authorization: Bearer cr_*`），与 supabase-js 兼容。
    //
    // 细粒度授权（在 handler 内部）：
    //   - 用户主体 → management.permissions / role_permissions（同表权限模型）
    //   - API Key  → api_keys.permissions JSONB 的 scope（与 Auto API 同款）
    //   - 用户主体未配 ACL 的函数走兼容模式；API Key 必须显式声明 scope。
    //
    // 中间件顺序：rpc_auth → dynamic_db_middleware（rpc_auth 会按 URL 路径覆盖
    // X-Database-Id 头，必须先于 dynamic_db 执行才能正确切池）。
    let rpc_routes = Router::new()
        .route(
            "/api/v1/:database_id/rpc/:fn_name",
            post(rpc::execute_rpc).get(rpc::execute_rpc_get),
        )
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::dynamic_db_middleware))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), rpc::rpc_auth_middleware));

    // RPC ACL 管理（超管 + 租户 owner/admin）—— handler 内部按 database_id → tenant_id 校验。
    let rpc_acl_routes = Router::new()
        .route(
            "/api/admin/rpc-acls",
            get(rpc::list_rpc_acls)
                .post(rpc::grant_rpc_acl)
                .delete(rpc::revoke_rpc_acl),
        )
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::auth_middleware));
    
    // 速率限制 / 熔断器 / 网关信息（仅超管）
    let gateway_routes = Router::new()
        .route("/api/admin/rate-limit-rules", get(gateway_handlers::list_rules).post(gateway_handlers::create_rule))
        .route("/api/admin/rate-limit-rules/:id", patch(gateway_handlers::update_rule).delete(gateway_handlers::delete_rule))
        .route("/api/admin/rate-limit-stats", get(gateway_handlers::rate_limit_stats))
        .route("/api/admin/circuit-breakers", get(gateway_handlers::circuit_breaker_status))
        .route("/api/admin/gateway-info", get(gateway_handlers::gateway_info))
        .layer(axum_middleware::from_fn(middleware::require_superadmin_middleware))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::auth_middleware));

    // 审计日志 / 慢查询（超管 + 租户 owner/admin）— handler 内按 tenant 隔离
    let audit_routes = Router::new()
        .route("/api/admin/audit-logs", get(audit_handlers::list_audit_logs))
        .route("/api/admin/slow-queries", get(audit_handlers::list_slow_queries))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::auth_middleware));

    // 平台 raw SQL 审计面板（仅超管）—— handler 里调 require_platform_superadmin
    // 自己鉴权；这里不挂 require_superadmin_middleware 是因为 handler 也要响应
    // "403 但带 JSON 错误体"的语义，比 middleware 401 更友好。
    let platform_audit_routes = Router::new()
        .route(
            "/api/platform/raw-sql-audit",
            get(audit_handlers::list_raw_sql_audit),
        )
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // Webhook 配置（超管 + 租户 owner/admin）— handler 内按 tenant 隔离
    let webhook_routes = Router::new()
        .route("/api/admin/webhooks", get(webhook_handlers::list_webhooks).post(webhook_handlers::create_webhook))
        .route("/api/admin/webhooks/:id", patch(webhook_handlers::update_webhook).delete(webhook_handlers::delete_webhook))
        .route("/api/admin/webhooks/:id/test", post(webhook_handlers::test_webhook))
        .route("/api/admin/webhooks/:id/logs", get(webhook_handlers::webhook_logs))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::auth_middleware));

    // 工作流管理 API
    let workflow_routes = Router::new()
        .route("/api/admin/workflows", get(workflow_handlers::list_workflows).post(workflow_handlers::create_workflow))
        .route("/api/admin/workflows/:id", get(workflow_handlers::get_workflow).patch(workflow_handlers::update_workflow).delete(workflow_handlers::delete_workflow))
        .route("/api/admin/workflows/:id/trigger", post(workflow_handlers::trigger_workflow))
        .route("/api/admin/workflows/:id/runs", get(workflow_handlers::get_workflow_runs))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::auth_middleware));

    // 工作流 Endpoint 触发器路由：GET/POST /workflow/:database_id/:slug
    // 走 auth_middleware 认证（JWT 或 API Key），允许外部调用
    let workflow_endpoint_routes = Router::new()
        .route("/workflow/:database_id/:slug", get(workflow_handlers::endpoint_trigger_get).post(workflow_handlers::endpoint_trigger))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::auth_middleware));

    let realtime_routes = Router::new()
        .route("/realtime/ws", get(realtime::ws_handler));

    // API Key 管理（超管 + 租户 owner/admin）— handler 内部按 database_id 校验是否租户管理员
    let api_key_routes = Router::new()
        .route("/api/admin/api-keys/:database_id",
            get(auto_api_handlers::list_api_keys)
            .post(auto_api_handlers::create_api_key))
        .route("/api/admin/api-keys/:database_id/:key_id",
            patch(auto_api_handlers::update_api_key)
            .delete(auto_api_handlers::delete_api_key))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::auth_middleware));

    // 定时任务管理 API（超管 + 租户 owner/admin）— handler 内部按 tenant_id 区分平台 / 租户级
    //
    // 11 个端点：CRUD（5）+ run-now / pause / resume + list_runs + stats + validate-cron + cleanup-zombies。
    // 全部走 auth_middleware（注入 Claims）；细粒度授权由 handler 内 validate_can_manage 完成。
    // `Arc<SchedulerRunner>` 通过 axum Extension 暴露给 /run-now —— Extension 在 app 层注入，
    // 这里只挂路由不挂 runner（runner 在 watchdog 附近 start，见下文）。
    let scheduled_task_routes = Router::new()
        .route(
            "/api/admin/scheduled-tasks",
            post(scheduler_handlers::create_task).get(scheduler_handlers::list_tasks),
        )
        .route(
            "/api/admin/scheduled-tasks/stats",
            get(scheduler_handlers::stats),
        )
        .route(
            "/api/admin/scheduled-tasks/validate-cron",
            post(scheduler_handlers::validate_cron),
        )
        // 试运行：表单里点"测试"按钮触发；不写 DB，直接喂给 executor。
        // 鉴权 / 字段校验与 create 等价（handler 内部复用 validate_can_manage）。
        .route(
            "/api/admin/scheduled-tasks/dry-run",
            post(scheduler_handlers::dry_run),
        )
        .route(
            "/api/admin/scheduled-tasks/runs/cleanup-zombies",
            post(scheduler_handlers::cleanup_zombies),
        )
        .route(
            "/api/admin/scheduled-tasks/:id",
            get(scheduler_handlers::get_task)
                .patch(scheduler_handlers::update_task)
                .delete(scheduler_handlers::delete_task),
        )
        .route(
            "/api/admin/scheduled-tasks/:id/run-now",
            post(scheduler_handlers::run_now),
        )
        .route(
            "/api/admin/scheduled-tasks/:id/pause",
            post(scheduler_handlers::pause_task),
        )
        .route(
            "/api/admin/scheduled-tasks/:id/resume",
            post(scheduler_handlers::resume_task),
        )
        .route(
            "/api/admin/scheduled-tasks/:id/runs",
            get(scheduler_handlers::list_runs),
        )
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::auth_middleware));

    // ─── Elasticsearch 反向代理 ─────────────────────────────────────────
    //
    // 两组路由：
    //  1) `/api/admin/es-connections/*`  — 连接 + token CRUD，走 auth_middleware
    //     （JWT only；token 在 handler 里按租户 owner/admin 校验）。
    //  2) `/api/es/*es_path`             — 业务端实际打的代理，**不走 auth_middleware**：
    //     用业务专属 `cres_es_xxx` token 在 handler 内自鉴权，故意不耦合 JWT —— 业务
    //     端的 ES client（Python / Node / curl）不需要登录平台拿 JWT，开箱即用。
    //
    // proxy 路由用 axum 通配 `*es_path`，匹配 `/api/es/` 之后的所有 path（含多级）。
    // 也因此故意放在 `auto_api_routes` 之后避免与其它 `/api/*` 通配冲突。
    let es_admin_routes = Router::new()
        .route(
            "/api/admin/es-connections",
            get(es::admin_handlers::list_connections)
                .post(es::admin_handlers::create_connection),
        )
        .route(
            "/api/admin/es-connections/:id",
            get(es::admin_handlers::get_connection)
                .put(es::admin_handlers::update_connection)
                .delete(es::admin_handlers::delete_connection),
        )
        .route(
            "/api/admin/es-connections/:id/health",
            post(es::admin_handlers::health_check),
        )
        .route(
            "/api/admin/es-connections/:id/tokens",
            get(es::admin_handlers::list_tokens).post(es::admin_handlers::create_token),
        )
        .route(
            "/api/admin/es-connections/:id/tokens/:token_id",
            patch(es::admin_handlers::update_token).delete(es::admin_handlers::delete_token),
        )
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // 代理路由：不挂 auth_middleware（token 自鉴权）。注册所有 ES 用的 HTTP 方法。
    // 注意 axum 通配语法是 `/*es_path`（前缀必须有 `/`）。
    let es_proxy_routes = Router::new().route(
        "/api/es/*es_path",
        get(es::proxy_handler::proxy)
            .post(es::proxy_handler::proxy)
            .put(es::proxy_handler::proxy)
            .delete(es::proxy_handler::proxy)
            .head(es::proxy_handler::proxy)
            .patch(es::proxy_handler::proxy),
    );

    // ES 高层「应用」API：业务侧无需 ES DSL / SDK，直接发简化 JSON。
    // 复用与 proxy 同一套 `cres_es_xxx` token；handler 自鉴权，同样不走 auth_middleware。
    //
    // 路由顺序：静态段（`_indices`）放最前，单 `:index` 必须避免吃掉它。
    // axum matchit 在同长度路径下静态段优先于参数段，所以不会出现冲突。
    let es_app_routes = Router::new()
        .route(
            "/api/es-app/_indices",
            get(es::app_handlers::list_indices),
        )
        .route(
            "/api/es-app/:index",
            get(es::app_handlers::get_index_info).delete(es::app_handlers::delete_index),
        )
        .route(
            "/api/es-app/:index/_init",
            post(es::app_handlers::init_index),
        )
        .route("/api/es-app/:index/docs", post(es::app_handlers::create_doc))
        .route(
            "/api/es-app/:index/docs/:id",
            get(es::app_handlers::get_doc)
                .put(es::app_handlers::upsert_doc)
                .patch(es::app_handlers::patch_doc)
                .delete(es::app_handlers::delete_doc),
        )
        .route("/api/es-app/:index/search", post(es::app_handlers::search))
        .route("/api/es-app/:index/count", post(es::app_handlers::count))
        .route("/api/es-app/:index/bulk", post(es::app_handlers::bulk));

    let mut app = Router::new()
        .merge(public_routes)
        .merge(sql_routes)
        .merge(protected_routes)
        .merge(schema_routes)
        .merge(index_routes)
        .merge(query_perf_routes)
        .merge(export_routes)
        .merge(monitor_routes)
        .merge(tenant_routes)
        .merge(superadmin_tenant_routes)
        .merge(admin_routes)
        .merge(rbac_routes)
        .merge(sso_public_routes)
        .merge(sso_admin_routes)
        .merge(api_routes)
        .merge(auto_api_routes)
        .merge(rpc_routes)
        .merge(rpc_acl_routes)
        .merge(api_key_routes)
        .merge(webhook_routes)
        .merge(realtime_routes)
        .merge(audit_routes)
        .merge(platform_audit_routes)
        .merge(gateway_routes)
        .merge(scheduled_task_routes)
        .merge(es_admin_routes)
        .merge(es_proxy_routes)
        .merge(es_app_routes)
        .merge(workflow_routes)
        .merge(workflow_endpoint_routes)
        .with_state(pool.clone())
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::HeaderName::from_static("x-xss-protection"),
            HeaderValue::from_static("1; mode=block"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::HeaderName::from_static("referrer-policy"),
            HeaderValue::from_static("strict-origin-when-cross-origin"),
        ))
        .layer(cors)
        .layer(CatchPanicLayer::new())
        .layer(TimeoutLayer::new(Duration::from_secs(config.request_timeout_secs)))
        // X-Request-Id 中间件挂在最外层：要让它"包"住所有下游中间件 + handler，
        // 这些 future 都跑在 REQUEST_ID task_local scope 里，日志才能自动带 ID。
        // axum 0.7 layer 顺序：靠后写的更外层，所以 request_id 写在最后。
        .layer(axum_middleware::from_fn(request_id::request_id_middleware));

    let pool_for_events = pool.clone();

    // PostgREST 兼容不在这里挂 layer —— axum 0.7 的 Router::layer 是 per-route 包装，
    // 路由匹配先发生 layer 才进，未匹配的请求会落到 fallback 的 NotFound（layer 仍跑
    // 但改 URI 已经晚了），最终客户端拿 404。改成在 auto_api_routes 显式注册两段
    // 路由 + handler 内部 forward 到三段版本。详见 src/postgrest_compat.rs。

    // 审计中间件
    //
    // ⚠️ Layer 顺序很关键：axum 的 `.layer()` 是栈式叠加 —— **后 .layer() 的在外层，先执行**。
    // `audit_middleware` 入参 `pool: Option<Extension<AuditPool>>` 是 extractor，在中间件
    // 函数入口就读 `req.extensions()`；如果 `Extension(AuditPool)` 在 audit_middleware
    // 的**内层**，AuditPool 还没注入，extractor 拿到 None，spawn 写库分支被静默跳过 →
    // audit_logs 表永远 0 行。
    //
    // 所以必须先 .layer(audit_middleware)（变成内层），再 .layer(Extension(AuditPool))
    // （变成外层，请求一进 router 就把 pool 塞进 extensions，下游 audit_middleware
    // 才读得到）。任何挪动这两行顺序的修改都请保留这条不变式。
    app = app.layer(axum_middleware::from_fn(audit_middleware::audit_middleware));
    app = app.layer(axum::Extension(audit_middleware::AuditPool(pool.clone())));

    // 熔断器（使用可配置阈值）
    let cb_config = circuit_breaker::CircuitBreakerConfig {
        failure_threshold: config.cb_failure_threshold,
        success_threshold: 3,
        timeout_secs: config.cb_timeout_secs,
    };
    let cb_manager = circuit_breaker::CircuitBreakerManager::new(cb_config);
    app = app.layer(axum::Extension(cb_manager));

    // Redis 注入（仅在配置可用时；缺失时下游 handler 通过 Option<Extension<RedisManager>>
    // 自行降级 —— 当前 rbac_middleware / auto_api_handlers 都已正确处理 None）
    if let Some(ref redis) = redis {
        app = app.layer(axum::Extension(redis.clone()));
    }

    // 限流器：⚠️ 始终挂载，与 Redis 是否可用解耦。
    // - 有 Redis：分布式滑动窗口（全局精确）
    // - 无 Redis：本地内存兑底（每实例独立计数，由 FallbackMode 控制）
    // 之前把限流挂在 `if let Some(redis)` 里 → Redis 缺失 = 完全无保护，
    // 任何接口（含 /auth/login 暴破、/query 任意 SQL）裸奔。
    {
        let fallback = rate_limiter::FallbackConfig {
            mode: rate_limiter::FallbackMode::from_env_str(&config.rate_limit_fallback_mode),
            multiplier: config.rate_limit_fallback_multiplier,
        };
        let limiter = rate_limiter::RateLimiter::new(
            redis.clone(),
            pool.clone(),
            config.rate_limit_per_minute,
            fallback,
        );
        app = app.layer(axum::Extension(limiter));
        app = app.layer(axum_middleware::from_fn(rate_limiter::rate_limit_middleware));
    }

    // 事件系统 + Webhook + Realtime
    let event_bus = events::EventBus::new(4096);
    app = app.layer(axum::Extension(event_bus.clone()));

    let wh_manager = webhook_manager::WebhookManager::new(pool_for_events.clone());
    wh_manager.start(event_bus.clone());

    let rt_manager = realtime::RealtimeManager::new(event_bus.clone());
    let broadcaster = rt_manager.start_broadcaster();
    app = app.layer(axum::Extension(rt_manager));
    app = app.layer(axum::Extension(broadcaster));

    // 跨实例 Redis Pub/Sub 事件桥接
    if let Some(ref redis) = redis {
        redis_pubsub::RedisPubSubBridge::start_publisher(event_bus.clone(), redis.clone());
        redis_pubsub::RedisPubSubBridge::start_subscriber(event_bus.clone(), config.redis_url.clone());
        tracing::info!("Redis Pub/Sub 事件桥接已启动");
    }

    // 工作流事件触发器：订阅 EventBus，自动触发 event 类型工作流
    workflow_trigger::start_event_trigger(event_bus.clone(), pool.clone());

    // 定时任务调度
    //
    // SchedulerRunner 是 `Arc<Self>`：handler 端通过 axum Extension 拿同一份引用调
    // `trigger_now`，循环也持有 Arc 在后台 tick。优雅停机由 `scheduler_shutdown` 控制——
    // 与 Watchdog 一起在停机信号里 store(false) 让循环退出。
    let scheduler_cfg = scheduler::runner::SchedulerConfig {
        tick_interval: Duration::from_secs(config.scheduler_tick_interval_secs),
        batch_size: config.scheduler_batch_size,
        stale_claim_grace_secs: config.scheduler_stale_claim_grace_secs,
        retry_base_secs: config.scheduler_retry_base_secs,
        retry_factor: config.scheduler_retry_factor,
        allow_insecure_http: config.allow_insecure_scheduled_http,
    };
    let rpc_exec = std::sync::Arc::new(scheduler::executors::RpcExecutor::new(
        pool.clone(),
        redis.clone(),
    ));
    let http_exec = std::sync::Arc::new(scheduler::executors::HttpExecutor::new(
        config.allow_insecure_scheduled_http,
    ));
    // ShellExecutor 在 new() 里就完成沙盒探测 + 日志，所以这里只是个普通 Arc 装箱。
    let shell_exec = std::sync::Arc::new(scheduler::executors::ShellExecutor::new(
        config.scheduler_shell_sandbox_mode,
    ));
    let scheduler_runner = std::sync::Arc::new(scheduler::runner::SchedulerRunner::new(
        pool.clone(),
        scheduler_cfg,
        rpc_exec,
        http_exec,
        shell_exec,
    ));
    let scheduler_shutdown = scheduler_runner.shutdown_handle();
    app = app.layer(axum::Extension(scheduler_runner.clone()));
    scheduler_runner.clone().start();

    // 后台守护 Watchdog
    let wd = watchdog::Watchdog::new(pool.clone(), redis.clone());
    let wd_shutdown = wd.shutdown_handle();
    wd.start();

    // 副本健康看护任务（运行时自动旁路 + 自动恢复）
    {
        use watchdog::ReplicaWatchdogConfig;
        let env_u64 = |k: &str, default: u64| {
            std::env::var(k).ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(default)
        };
        let env_u32 = |k: &str, default: u32| {
            std::env::var(k).ok().and_then(|v| v.parse::<u32>().ok()).unwrap_or(default)
        };
        let env_f64_opt = |k: &str, default: Option<f64>| {
            match std::env::var(k).ok() {
                None => default,
                Some(s) if s.eq_ignore_ascii_case("off") || s.eq_ignore_ascii_case("none") => None,
                Some(s) => s.parse::<f64>().ok().or(default),
            }
        };
        let env_bool = |k: &str, default: bool| {
            match std::env::var(k).ok().map(|v| v.to_ascii_lowercase()) {
                Some(s) if s == "false" || s == "0" || s == "no" => false,
                Some(s) if s == "true" || s == "1" || s == "yes" => true,
                _ => default,
            }
        };
        let cfg = ReplicaWatchdogConfig {
            interval: Duration::from_secs(env_u64("REPLICA_WATCHDOG_INTERVAL_SECS", 15)),
            probe_timeout: Duration::from_secs(env_u64("REPLICA_WATCHDOG_TIMEOUT_SECS", 3)),
            max_consecutive_failures: env_u32("REPLICA_WATCHDOG_MAX_FAIL", 2),
            lag_threshold_seconds: env_f64_opt("REPLICA_WATCHDOG_LAG_THRESHOLD_SECS", Some(60.0)),
            require_standby: env_bool("REPLICA_WATCHDOG_REQUIRE_STANDBY", true),
        };
        watchdog::spawn_replica_watchdog(cfg);
    }

    // 优雅停机信号
    let graceful_shutdown_secs = config.graceful_shutdown_secs;
    let shutdown = async move {
        let ctrl_c = tokio::signal::ctrl_c();
        #[cfg(unix)]
        let terminate = async {
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("failed to install SIGTERM handler")
                .recv()
                .await;
        };
        #[cfg(not(unix))]
        let terminate = std::future::pending::<()>();

        tokio::select! {
            _ = ctrl_c => {},
            _ = terminate => {},
        }

        tracing::info!("收到停机信号，开始优雅关闭（最长等待 {}s）...", graceful_shutdown_secs);

        // 停止 Watchdog
        wd_shutdown.store(false, std::sync::atomic::Ordering::Relaxed);
        // 停止 SchedulerRunner（循环每 tick 自检 running 标志位）
        scheduler_shutdown.store(false, std::sync::atomic::Ordering::Relaxed);

        // 给一个宽限期让正在处理的请求完成
        tokio::time::sleep(Duration::from_secs(graceful_shutdown_secs)).await;
        tracing::info!("优雅关闭完成");
    };

    let addr = format!("{}:{}", config.host, config.port);
    tracing::info!("服务器启动在 http://{}", addr);
    tracing::info!("API 端点: http://{}/api/:schema/:table", addr);
    tracing::info!("健康探针: /health/live (存活) | /health/ready (就绪) | /health (详情)");

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await?;

    Ok(())
}

/// 根路径处理器
async fn root_handler() -> Result<Json<Value>, AppError> {
    use serde_json::json;
    
    Ok(Json(json!({
        "name": "OneBase API",
        "version": env!("CARGO_PKG_VERSION"),
        "status": "running",
        "endpoints": {
            "health": "/health",
            "health_live": "/health/live",
            "health_ready": "/health/ready",
            "admin": "/admin/",
            "api": "/api/:schema/:table",
            "auto_api": {
                "description": "Auto-generated REST API for your database tables",
                "list": "GET /api/v1/{database_id}/{schema}/{table}",
                "get": "GET /api/v1/{database_id}/{schema}/{table}/{id}",
                "create": "POST /api/v1/{database_id}/{schema}/{table}",
                "update": "PATCH /api/v1/{database_id}/{schema}/{table}/{id}",
                "delete": "DELETE /api/v1/{database_id}/{schema}/{table}/{id}"
            },
            "auth": {
                "register": "/auth/register",
                "login": "/auth/login",
                "me": "/auth/me",
                "refresh": "/auth/refresh",
                "change_password": "/auth/change-password"
            },
            "transaction": "/transaction"
        },
        "documentation": "https://github.com/yourusername/onebase"
    })))
}

/// SQL 查询执行端点
#[derive(serde::Deserialize)]
struct SqlQueryRequest {
    sql: String,
    #[serde(default)]
    read_only: bool,
    /// 写 / DDL / 事务等"非 SELECT"类操作必须在请求里把这个字段显式置为 true，
    /// 让前端强制弹出二次确认；服务端只是兜底，前端 UI 才是主门面。
    /// 详见 `raw_sql_guard::require_destructive_ack`。
    #[serde(default)]
    acknowledge_destructive: bool,
}

fn get_sql_type(sql: &str) -> &'static str {
    // 先剥掉前导注释——脚本第一行写 `-- 授权 ...` 是常见习惯，没这步
    // `first_word` 会拿到 `--`，把 `GRANT/CREATE/...` 全错判成 `OTHER`，
    // 审计日志和错误信息也会跟着不准。
    let body = raw_sql_guard::strip_leading_sql_comments(sql);
    let sql_upper = body.to_uppercase();
    let first_word = sql_upper.split_whitespace().next().unwrap_or("");

    match first_word {
        "SELECT" | "WITH" | "EXPLAIN" | "SHOW" => "SELECT",
        "INSERT" => "INSERT",
        "UPDATE" => "UPDATE",
        "DELETE" => "DELETE",
        "CREATE" => "CREATE",
        "ALTER" => "ALTER",
        "DROP" => "DROP",
        "TRUNCATE" => "TRUNCATE",
        "GRANT" | "REVOKE" => "PERMISSION",
        "BEGIN" | "COMMIT" | "ROLLBACK" => "TRANSACTION",
        _ => "OTHER",
    }
}

/// 把 raw SQL 通道（`/query`）里**用户 SQL 真正执行**时返回的 `sqlx::Error`
/// 转成 `AppError::InvalidQuery`，让 PG 原始消息（+ SQLSTATE）能原样回前端。
///
/// 为什么要单独写：默认的 `AppError::Database` 会过 `classify_db_error` 这道
/// 脱敏闸——对业务 API（Auto-API / RPC）合理，因为外部用户不该看到「表名 /
/// schema 名 / role 名」之类的内部细节；但对**SQL 编辑器里手写 SQL 的超管**
/// 来说就是灾难：你写错一行 GRANT，UI 只会给「数据库结构异常，请联系管理员」
/// 这种和实际原因完全无关的兜底文案，最后还要去翻服务端 JSON 日志找
/// `db_err.message()`。
///
/// 这里把 PG 自己的错误（语法错、约束冲突、role 不存在、字段不存在、权限
/// 不足……）原样回给前端——反正调用者必然是超管（被 `require_superadmin`
/// 守过），让他能直接看到 root cause 自己改 SQL。pool / 协议 / 解码这类
/// **平台侧**错误仍然走 `AppError::Database`（仍然脱敏），那些不是用户 SQL
/// 的锅。
fn map_user_sql_err(e: sqlx::Error) -> AppError {
    match e {
        sqlx::Error::Database(db_err) => {
            let sqlstate = db_err
                .code()
                .as_deref()
                .map(str::to_string)
                .unwrap_or_default();
            let msg = if sqlstate.is_empty() {
                db_err.message().to_string()
            } else {
                format!("{} (SQLSTATE {})", db_err.message(), sqlstate)
            };
            tracing::warn!(
                error.kind = "raw_sql_execution_error",
                sqlstate = %sqlstate,
                "原始 SQL 通道执行失败，将 PG 原文回给前端: {}",
                db_err.message()
            );
            AppError::InvalidQuery(msg)
        }
        // I/O / pool / protocol / decode / row-not-found 等都是平台侧问题，
        // 不是用户 SQL 写错——走默认脱敏。
        other => AppError::Database(other),
    }
}

fn is_dangerous_operation(sql: &str) -> bool {
    // 旧的"关键字黑名单"：只是兜底；真正的护栏在 raw_sql_guard 模块（强制
    // X-Database-Id、management deny-list、acknowledge_destructive、
    // statement_timeout、行数截断）。这里保留是为了让"DROP DATABASE / DROP
    // SCHEMA / TRUNCATE"这种"几乎一定是误操作"的语句给出更具体的错误信息。
    let sql_upper = sql.trim().to_uppercase();
    sql_upper.contains("DROP DATABASE") ||
    sql_upper.contains("DROP SCHEMA") ||
    sql_upper.starts_with("TRUNCATE")
}

async fn execute_sql_query(
    State(_main_pool): State<PgPool>,
    dynamic_pool: Option<axum::extract::Extension<PgPool>>,
    db_id: Option<axum::extract::Extension<middleware::CurrentDatabaseId>>,
    claims: Option<axum::extract::Extension<crate::auth::Claims>>,
    audit_sink: Option<axum::extract::Extension<audit_middleware::AuditDetailSink>>,
    Json(req): Json<SqlQueryRequest>,
) -> Result<Json<Value>, AppError> {
    use serde_json::json;

    let start = std::time::Instant::now();
    let sql_type = get_sql_type(&req.sql);
    let user_id = claims.as_deref().map(|c| c.sub).unwrap_or(-1);
    let target_db_id = db_id.as_deref().map(|d| d.0).unwrap_or(0);
    tracing::warn!(
        target: "raw_sql_audit",
        event = "raw_sql_query_invoked",
        user_id = user_id,
        database_id = target_db_id,
        sql_type = sql_type,
        sql_len = req.sql.len(),
        read_only = req.read_only,
        acknowledge_destructive = req.acknowledge_destructive,
        "超管直接执行原始 SQL（/query）；该接口绕过所有 RBAC，靠 raw_sql_guard 守门"
    );
    let push_audit = |kind: &'static str, blocked_reason: Option<&str>| {
        if let Some(axum::extract::Extension(ref sink)) = audit_sink {
            sink.set(json!({
                "kind": kind,
                "user_id": user_id,
                "database_id": target_db_id,
                "sql_type": sql_type,
                "sql_len": req.sql.len(),
                "read_only": req.read_only,
                "acknowledge_destructive": req.acknowledge_destructive,
                "blocked_reason": blocked_reason,
            }));
        }
    };
    push_audit("raw_sql_query", None);

    // ─── E1 / E3：安全闸 ────────────────────────────────────────────────
    let pool = match raw_sql_guard::require_target_pool(dynamic_pool.as_deref()) {
        Ok(p) => p,
        Err(e) => {
            push_audit("raw_sql_query_blocked", Some("missing_database_id"));
            return Err(e);
        }
    };
    if let Err(e) = raw_sql_guard::check_management_references(&req.sql) {
        push_audit("raw_sql_query_blocked", Some("management_schema_reference"));
        return Err(e);
    }
    if !req.read_only {
        if let Err(e) = raw_sql_guard::require_destructive_ack(sql_type, req.acknowledge_destructive)
        {
            push_audit("raw_sql_query_blocked", Some("missing_destructive_ack"));
            return Err(e);
        }
    }
    if req.read_only && sql_type != "SELECT" {
        push_audit(
            "raw_sql_query_blocked",
            Some("read_only_mode_rejects_non_select"),
        );
        return Err(AppError::InvalidQuery(
            "只读模式下只允许执行 SELECT 查询语句".to_string(),
        ));
    }
    if is_dangerous_operation(&req.sql) {
        push_audit("raw_sql_query_blocked", Some("dangerous_keyword_blacklist"));
        return Err(AppError::InvalidQuery(
            "检测到危险操作，请使用专门的管理工具执行此类操作".to_string(),
        ));
    }

    // ─── E2：单独 acquire 一条连接，设 statement_timeout，结束 RESET ───
    let policy = raw_sql_guard::policy();
    let mut conn = pool.acquire().await.map_err(AppError::Database)?;
    raw_sql_guard::apply_session_guards(&mut conn, policy).await?;
    let max_rows = policy.max_returned_rows;

    let exec_result: Result<Value, AppError> = match sql_type {
        "SELECT" => {
            let rows = sqlx::query(&req.sql)
                .fetch_all(&mut *conn)
                .await
                .map_err(map_user_sql_err);
            rows.map(|rows| {
                let total = rows.len();
                let truncated = total > max_rows;
                let take = total.min(max_rows);
                let results: Vec<Value> = rows
                    .iter()
                    .take(take)
                    .map(row_to_json_object_select)
                    .collect();
                json!({
                    "type": "SELECT",
                    "data": results,
                    "row_count": results.len(),
                    "total_rows": total,
                    "truncated": truncated,
                    "max_returned_rows": max_rows,
                })
            })
        }
        "INSERT" | "UPDATE" | "DELETE" => {
            let sql_with_returning = if !req.sql.to_uppercase().contains("RETURNING") {
                format!("{} RETURNING *", req.sql.trim().trim_end_matches(';'))
            } else {
                req.sql.clone()
            };
            match sqlx::query(&sql_with_returning).fetch_all(&mut *conn).await {
                Ok(rows) => {
                    let total = rows.len();
                    let truncated = total > max_rows;
                    let take = total.min(max_rows);
                    let results: Vec<Value> = rows
                        .iter()
                        .take(take)
                        .map(row_to_json_object_write)
                        .collect();
                    Ok(json!({
                        "type": sql_type,
                        "data": results,
                        "row_count": results.len(),
                        "total_rows": total,
                        "truncated": truncated,
                        "max_returned_rows": max_rows,
                        "rows_affected": total,
                        "message": format!("{} 操作成功，影响 {} 行", sql_type, total)
                    }))
                }
                Err(_) => {
                    // 部分表 RETURNING * 不可用——回退到 execute，只拿到 rows_affected。
                    let r = sqlx::query(&req.sql)
                        .execute(&mut *conn)
                        .await
                        .map_err(map_user_sql_err)?;
                    let rows_affected = r.rows_affected();
                    Ok(json!({
                        "type": sql_type,
                        "data": [],
                        "row_count": 0,
                        "rows_affected": rows_affected,
                        "message": format!("{} 操作成功，影响 {} 行", sql_type, rows_affected)
                    }))
                }
            }
        }
        // CREATE / ALTER / DROP 以及 BEGIN/COMMIT 这类未识别类型：用 simple query
        // protocol（`sqlx::raw_sql`）跑，允许多语句脚本。
        //
        // 这里**故意**用 `pool` 而非 `&mut *conn`：实测 `sqlx::raw_sql(...).execute(&mut PgConnection)`
        // 推断出来的 Future 不是 `Send`，会让 axum 的 `Handler` trait 拒绝整个 handler。
        // 换成 `&PgPool` 之后 sqlx 自动 acquire 一条临时连接，Future 是 Send，可以挂上。
        // 副作用：本次 raw_sql 不能复用前面 `apply_session_guards` 设的 GUC——所以
        // 我们把 `SET LOCAL` 直接拼进 SQL 里，靠 BEGIN/COMMIT 包一个事务自动保证作用域。
        "CREATE" | "ALTER" | "DROP" => {
            let wrapped = wrap_raw_sql_with_guards(&req.sql, policy);
            sqlx::raw_sql(&wrapped)
                .execute(pool)
                .await
                .map_err(map_user_sql_err)
                .map(|_| {
                    json!({
                        "type": sql_type,
                        "data": [],
                        "row_count": 0,
                        "message": format!("{} 操作执行成功", sql_type)
                    })
                })
        }
        _ => {
            let wrapped = wrap_raw_sql_with_guards(&req.sql, policy);
            sqlx::raw_sql(&wrapped)
                .execute(pool)
                .await
                .map_err(map_user_sql_err)
                .map(|_| {
                    json!({
                        "type": sql_type,
                        "data": [],
                        "row_count": 0,
                        "rows_affected": 0,
                        "message": "操作执行成功"
                    })
                })
        }
    };
    raw_sql_guard::reset_session_guards(&mut conn).await;
    drop(conn);

    let mut value = match exec_result {
        Ok(v) => v,
        Err(e) => {
            push_audit("raw_sql_query_blocked", Some("execution_error"));
            return Err(e);
        }
    };
    if let Value::Object(ref mut obj) = value {
        obj.insert("elapsed_ms".into(), json!(start.elapsed().as_millis()));
    }
    push_audit("raw_sql_query_done", None);
    Ok(Json(value))
}

/// 把用户 SQL 包进一个迷你事务，SET LOCAL statement_timeout 在事务内生效，
/// COMMIT 后自动回到服务器默认。专门给"必须经 simple query protocol 跑"的
/// 路径用（DDL / 多语句脚本）——这些路径走 `&PgPool` 而不是持久 conn，
/// 因此没法用 `apply_session_guards` 提前 SET。
fn wrap_raw_sql_with_guards(user_sql: &str, policy: raw_sql_guard::RawSqlPolicy) -> String {
    let trimmed = user_sql.trim().trim_end_matches(';');
    format!(
        "BEGIN; SET LOCAL statement_timeout = {}; SET LOCAL idle_in_transaction_session_timeout = {}; {}; COMMIT;",
        policy.statement_timeout_ms,
        policy.statement_timeout_ms,
        trimmed
    )
}

fn row_to_json_object_select(row: &sqlx::postgres::PgRow) -> Value {
    use sqlx::{Column, Row};
    let mut obj = serde_json::Map::new();
    for column in row.columns() {
        let key = column.name().to_string();
        let idx = column.ordinal();
        let value: Value = if let Ok(v) = row.try_get::<String, _>(idx) {
            Value::String(v)
        } else if let Ok(v) = row.try_get::<i32, _>(idx) {
            serde_json::json!(v)
        } else if let Ok(v) = row.try_get::<i64, _>(idx) {
            serde_json::json!(v)
        } else if let Ok(v) = row.try_get::<f64, _>(idx) {
            serde_json::json!(v)
        } else if let Ok(v) = row.try_get::<bool, _>(idx) {
            Value::Bool(v)
        } else if let Ok(v) = row.try_get::<Option<String>, _>(idx) {
            v.map(Value::String).unwrap_or(Value::Null)
        } else if let Ok(v) = row.try_get::<Option<i32>, _>(idx) {
            v.map(|n| serde_json::json!(n)).unwrap_or(Value::Null)
        } else if let Ok(v) = row.try_get::<Option<i64>, _>(idx) {
            v.map(|n| serde_json::json!(n)).unwrap_or(Value::Null)
        } else if let Ok(v) = row.try_get::<serde_json::Value, _>(idx) {
            v
        } else {
            Value::Null
        };
        obj.insert(key, value);
    }
    Value::Object(obj)
}

fn row_to_json_object_write(row: &sqlx::postgres::PgRow) -> Value {
    use sqlx::{Column, Row};
    let mut obj = serde_json::Map::new();
    for column in row.columns() {
        let key = column.name().to_string();
        let idx = column.ordinal();
        let value: Value = if let Ok(v) = row.try_get::<String, _>(idx) {
            Value::String(v)
        } else if let Ok(v) = row.try_get::<i32, _>(idx) {
            serde_json::json!(v)
        } else if let Ok(v) = row.try_get::<i64, _>(idx) {
            serde_json::json!(v)
        } else if let Ok(v) = row.try_get::<f64, _>(idx) {
            serde_json::json!(v)
        } else if let Ok(v) = row.try_get::<bool, _>(idx) {
            Value::Bool(v)
        } else if let Ok(v) = row.try_get::<serde_json::Value, _>(idx) {
            v
        } else {
            Value::Null
        };
        obj.insert(key, value);
    }
    Value::Object(obj)
}

/// GET /health - 详细健康检查（向后兼容）
async fn health_check(
    State(pool): State<PgPool>,
    redis: Option<axum::extract::Extension<redis_manager::RedisManager>>,
) -> Result<Json<Value>, AppError> {
    use serde_json::json;
    
    let db_status = match sqlx::query("SELECT 1").execute(&pool).await {
        Ok(_) => "healthy",
        Err(_) => "unhealthy",
    };
    
    let redis_status = match redis {
        Some(axum::extract::Extension(r)) => {
            if r.ping().await.unwrap_or(false) { "healthy" } else { "unhealthy" }
        }
        None => "not_configured",
    };
    
    let pool_size = pool.size();
    let idle_connections = pool.num_idle();
    let overall = if db_status == "healthy" { "healthy" } else { "unhealthy" };
    
    Ok(Json(json!({
        "status": overall,
        "database": {
            "status": db_status,
            "pool_size": pool_size,
            "idle": idle_connections,
        },
        "redis": {
            "status": redis_status,
        },
        "version": env!("CARGO_PKG_VERSION")
    })))
}

/// GET /health/live - 存活探针（只要进程在运行就返回 200）
async fn health_live() -> Json<Value> {
    use serde_json::json;
    Json(json!({ "status": "alive" }))
}

/// GET /health/ready - 就绪探针（检查 DB + Redis 是否可用）
async fn health_ready(
    State(pool): State<PgPool>,
    redis: Option<axum::extract::Extension<redis_manager::RedisManager>>,
) -> Result<Json<Value>, AppError> {
    use serde_json::json;

    let db_ok = sqlx::query("SELECT 1").execute(&pool).await.is_ok();

    let redis_ok = match redis {
        Some(axum::extract::Extension(r)) => r.ping().await.unwrap_or(false),
        None => true, // Redis 未配置时不视为不就绪
    };

    if db_ok && redis_ok {
        Ok(Json(json!({
            "status": "ready",
            "database": "ok",
            "redis": if redis_ok { "ok" } else { "unavailable" }
        })))
    } else {
        Err(AppError::ServiceUnavailable(format!(
            "服务未就绪: db={}, redis={}",
            if db_ok { "ok" } else { "fail" },
            if redis_ok { "ok" } else { "fail" }
        )))
    }
}
