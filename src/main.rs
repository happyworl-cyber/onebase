mod admin_handlers;
mod ai;
mod alert_webhook;
mod audit_handlers;
mod audit_middleware;
mod auth;
mod auth_handlers;
mod auto_api_handlers;
mod circuit_breaker;
mod config;
mod crypto;
mod crypto_primitives;
mod dashboard_handlers;
mod datasource_handlers;
mod db;
mod ddl_handlers;
mod env_var_handlers;
mod error;
mod es;
mod events;
mod execution_log;
mod execution_log_handlers;
mod export_handlers;
mod gateway_handlers;
mod handlers;
mod http_async_poll;
mod idp_handlers;
mod idp_oidc;
mod index_handlers;
mod js_deps;
mod js_host_bridge;
mod js_runner;
mod kafka_app_handlers;
mod kafka_ds;
mod kafka_handlers;
mod logging;
mod lua_builtins;
mod lua_engine;
mod mcp_server;
mod mcp_tools;
mod middleware;
mod models;
mod monitor_handlers;
mod object_storage_app_handlers;
mod object_storage_ds;
mod object_storage_handlers;
mod operation_log;
mod operation_log_handlers;
mod organization_handlers;
mod pat_handlers;
mod permission_cache;
mod permissions;
mod pg_listen_hub;
mod pg_pool_handlers;
mod pg_pool_helpers;
mod pg_row_json;
mod platform_monitor_handlers;
mod platform_token;
mod platform_token_handlers;
mod pool_manager;
mod pool_metrics;
mod postgrest_compat;
mod provision_webhook;
mod public_base;
mod public_base_settings;
mod py_deps;
mod py_runner;
mod query_builder;
mod query_cache;
mod query_perf_handlers;
mod rate_limiter;
mod raw_sql_guard;
mod rbac_handlers;
mod rbac_middleware;
mod rbac_models;
mod realtime;
mod redis_ds;
mod redis_handlers;
mod redis_manager;
mod redis_pubsub;
mod request_id;
mod rpc;
mod scheduler;
mod scheduler_handlers;
mod scheduler_workflow;
mod schema_handlers;
mod session_hooks;
mod session_rules_handlers;
mod sql_v1_handlers;
mod sse;
mod sse_notify_bridge;
mod sse_notify_bridge_handlers;
mod sse_public_endpoint_handlers;
mod sse_publisher;
mod sse_redis;
mod sse_route_handlers;
mod sse_route_manager;
mod sso;
mod sso_handlers;
mod tenant_handlers;
mod tenant_models;
mod transaction;
mod watchdog;
mod webhook_handlers;
mod webhook_manager;
mod workflow_cron_trigger;
mod workflow_engine;
mod workflow_folder_handlers;
mod workflow_handlers;
mod workflow_kafka_trigger;
mod workflow_notify_trigger;
mod workflow_taxonomy;
mod workflow_trigger;

// binary 侧 `mod workflow_engine` 与 lib 共用源文件，需在此 re-export 批量配置模块。
pub(crate) use onebase::sse_batch_config;

use axum::http::HeaderValue;
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
    catch_panic::CatchPanicLayer, cors::CorsLayer, set_header::SetResponseHeaderLayer,
    timeout::TimeoutLayer,
};

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

    // 商用授权（License）加载：读取签名 License 文件并判定状态。
    // - 默认 enforce=warn：只校验 + 告警，不拦截，兼容既有部署；
    // - 客户交付镜像设 ONEBASE_LICENSE_ENFORCE=enforce 后，到期/无效将只读降级。
    // 后台任务周期重载，续期换文件 / 到期迁移无需重启即可生效。
    let license_state = onebase::license::LicenseState::init_from_env();
    license_state.log_startup();
    license_state.spawn_refresh();

    let pool = db::create_pool(&config.database_url).await?;

    // 启动期自动迁移：发版重启即同步管理库 schema，免去生产环境手动跑 migrate_all。
    // - 受 AUTO_MIGRATE 控制（默认开；设 off 可交回 CI/CD 的 gated 迁移流程）。
    // - 内部用 pg_advisory_lock 跨实例互斥，多副本同时启动只有一个真正执行。
    // - 失败不 panic：健康库重复跑只会是 skipped/ok（零错误）；真出错就大声告警，
    //   但不让一次迁移问题把 API 拖崩或陷入崩溃重启循环。
    if config.auto_migrate {
        match onebase::migrate::run_all_migrations(&pool).await {
            Ok(stats) if stats.has_error() => {
                tracing::error!(
                    ok = stats.ok,
                    skipped = stats.skipped,
                    errors = stats.errors,
                    "启动期自动迁移存在 {} 处错误，请尽快检查管理库 schema（服务仍继续启动）",
                    stats.errors
                );
            }
            Ok(stats) => {
                tracing::info!(ok = stats.ok, skipped = stats.skipped, "启动期自动迁移完成");
            }
            Err(e) => {
                tracing::error!(
                    "启动期自动迁移执行失败（连接 / advisory lock 异常）：{e}（服务仍继续启动）"
                );
            }
        }
    } else {
        tracing::info!("AUTO_MIGRATE 已关闭，跳过启动期自动迁移");
    }

    // 平台 PG 自动建库：启动时探活 + 同步 PG 池条目（失败不阻断服务，仅告警）。
    match pg_pool_helpers::probe_platform_provision().await {
        Ok(()) => {
            if let Ok(inst) = pg_pool_helpers::platform_instance_from_env() {
                tracing::info!(
                    "平台 PG 建库探活 OK（{}:{}, 管理库 {}）；use_platform_pg 开通已就绪",
                    inst.db_host,
                    inst.db_port,
                    inst.management_db_name
                );
            }
            if let Err(e) = pg_pool_helpers::ensure_platform_pg_pool_entry(&pool).await {
                tracing::warn!(
                    "自动注册 platform-default PG 池失败（可手工在 /platform/pg-pools 添加）: {}",
                    e
                );
            }
        }
        Err(e) => {
            tracing::warn!(
                "平台 PG 建库探活失败：{}。开通向导「当前平台数据库」不可用；请配置 PROVISION_PG_URL（需 CREATEDB）或改用 PG 池/手填",
                e
            );
        }
    }

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

    // 显式枚举允许的方法，而不是用 `Any`。
    //
    // 用 `Any` 时 tower-http 会把预检响应写成字面量 `Access-Control-Allow-Methods: *`；
    // 而按 Fetch 规范，带凭据（credentials:'include' / axios withCredentials）的请求
    // **不把 `*` 当通配符**，导致 PATCH / PUT / DELETE 等非简单方法预检失败
    // （报 "Method PATCH is not allowed by Access-Control-Allow-Methods"）。
    // 显式列出方法后返回的是字面量列表，带不带凭据都能正确匹配。
    let allow_methods = [
        axum::http::Method::GET,
        axum::http::Method::POST,
        axum::http::Method::PUT,
        axum::http::Method::PATCH,
        axum::http::Method::DELETE,
        axum::http::Method::OPTIONS,
        axum::http::Method::HEAD,
    ];
    let cors = if config.cors_origins.len() == 1 && config.cors_origins[0] == "*" {
        CorsLayer::new()
            .allow_origin(tower_http::cors::Any)
            .allow_methods(allow_methods)
            .allow_headers(tower_http::cors::Any)
    } else {
        let origins: Vec<_> = config
            .cors_origins
            .iter()
            .filter_map(|o| o.parse::<axum::http::HeaderValue>().ok())
            .collect();
        CorsLayer::new()
            .allow_origin(origins)
            .allow_methods(allow_methods)
            .allow_headers(tower_http::cors::Any)
    };

    // 公开路由（无需认证）
    let public_routes = Router::new()
        .route("/", get(root_handler))
        .route("/health", get(health_check))
        .route("/health/live", get(health_live))
        .route("/health/ready", get(health_ready))
        .route("/api/license", get(license_status_handler))
        .route(
            "/api/providers",
            get(idp_handlers::list_available_providers),
        )
        .route(
            "/.well-known/openid-configuration",
            get(idp_oidc::oidc_discovery),
        )
        .route("/.well-known/jwks.json", get(idp_oidc::jwks))
        .route("/oauth2/authorize", get(idp_oidc::oauth2_authorize))
        .route("/oauth2/token", post(idp_oidc::oauth2_token))
        .route("/oauth2/revoke", post(idp_oidc::oauth2_revoke))
        .route(
            "/oauth2/userinfo",
            get(idp_oidc::oauth2_userinfo).post(idp_oidc::oauth2_userinfo_post),
        )
        .route(
            "/oauth2/callback/:provider",
            get(idp_oidc::oauth2_upstream_callback).post(idp_oidc::oauth2_upstream_callback_post),
        )
        .route(
            "/auth/sso/:provider/callback",
            get(idp_oidc::oauth2_upstream_callback).post(idp_oidc::oauth2_upstream_callback_post),
        )
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
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::dynamic_db_middleware,
        ))
        .layer(axum_middleware::from_fn(
            middleware::require_superadmin_middleware,
        ))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    let protected_routes = Router::new()
        .route("/auth/me", get(auth_handlers::get_me))
        .route("/auth/refresh", post(auth_handlers::refresh_token))
        .route("/auth/logout", post(auth_handlers::logout))
        .route(
            "/auth/change-password",
            post(auth_handlers::change_password),
        )
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // Schema 元数据 / DDL：
    // - 只读接口（list_schemas / list_tables / get_table_structure / get_table_relationships）
    //   对所有租户成员开放——`dynamic_db_middleware` 已经把"用户必须属于该 tenant"
    //   作为前置条件，不再叠加超管锁，避免租户 admin 也看不到自己库的表。
    // - 写接口（create_schema / drop_schema）在 handler 内部用 `require_database_admin`
    //   二次校验：仅平台超管或租户 owner/admin 可执行 DDL。
    let schema_routes = Router::new()
        .route(
            "/api/schemas",
            get(schema_handlers::list_schemas).post(schema_handlers::create_schema),
        )
        .route("/api/schemas/:schema", delete(schema_handlers::drop_schema))
        .route(
            "/api/schema/:schema/tables",
            get(schema_handlers::list_tables),
        )
        .route(
            "/api/schema/:schema/table/:table/structure",
            get(schema_handlers::get_table_structure),
        )
        .route(
            "/api/schema/:schema/table/:table/relationships",
            get(schema_handlers::get_table_relationships),
        )
        // 函数 / 触发器 catalog 元数据列表 —— 给"函数管理"/"触发器管理"页拉数据用。
        // 之前这两页直接用 `/query` 跑 raw SQL，触到平台超管限制，项目成员看不到列表；
        // 改成结构化 GET 后，鉴权交给 `dynamic_db_middleware`（任意租户成员），
        // 同时保留写操作（CREATE / DROP function/trigger）走 raw SQL 的安全边界。
        .route(
            "/api/schema/:schema/functions",
            get(schema_handlers::list_functions),
        )
        .route(
            "/api/schema/:schema/triggers",
            get(schema_handlers::list_triggers),
        )
        // M3 可视化建表：项目级 DDL endpoints。鉴权门槛 member+（详见 ddl_handlers.rs 文件头）。
        // 与 /query（仅超管 raw SQL）的关键不同：body 全结构化，server-side 100% 走白名单 + ident 校验，
        // 杜绝 raw SQL 注入面，从而才敢放开给 member。
        .route("/api/ddl/tables", post(ddl_handlers::create_table))
        .route(
            "/api/ddl/tables/:schema/:table",
            delete(ddl_handlers::drop_table).patch(ddl_handlers::alter_table),
        )
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::dynamic_db_middleware,
        ))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // 索引管理（按 RBAC 鉴权）— 在 handler 内对目标表做 SELECT/ALL 校验，
    // 超管由 require_table_permission/require_schema_permission 内部短路放行。
    let index_routes = Router::new()
        .route("/api/indexes", post(index_handlers::create_index))
        .route("/api/indexes/:schema", get(index_handlers::list_indexes))
        .route(
            "/api/indexes/:schema/:index_name",
            delete(index_handlers::drop_index),
        )
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::dynamic_db_middleware,
        ))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // 查询性能 / 慢查询日志 — 走租户库（X-Database-Id），handler 内做读权限校验，
    // 重置统计 / 取消查询这种破坏性操作 handler 内强制超管。
    let query_perf_routes = Router::new()
        .route(
            "/api/query-perf/extension",
            get(query_perf_handlers::get_extension_status),
        )
        .route(
            "/api/query-perf/statements",
            get(query_perf_handlers::list_statements),
        )
        .route(
            "/api/query-perf/statements/reset",
            post(query_perf_handlers::reset_statements),
        )
        .route(
            "/api/query-perf/active",
            get(query_perf_handlers::list_active_queries),
        )
        .route(
            "/api/query-perf/active/:pid/cancel",
            post(query_perf_handlers::cancel_active_query),
        )
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::dynamic_db_middleware,
        ))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // 数据导出：
    // - per-table CSV/JSON 导出（/api/export/csv|json/:schema/:table）→ 租户 owner/admin。
    // - 任意 SELECT 导出（/api/export/sql/csv）→ 仍仅平台超管，避免给 RBAC 一个后门。
    // 之前所有 handler 都接 `State<PgPool>`（管理库），且没挂 `dynamic_db_middleware`，
    // 等价于"超管在 management 库上导数据"——这里补上路由 + handler 内 strict 校验。
    let export_routes = Router::new()
        .route(
            "/api/export/csv/:schema/:table",
            get(export_handlers::export_csv),
        )
        .route(
            "/api/export/json/:schema/:table",
            get(export_handlers::export_json),
        )
        .route("/api/export/sql/csv", post(export_handlers::export_sql_csv))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::dynamic_db_middleware,
        ))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // 监控 / 慢查询 / 连接：
    // - 路由层只挂 auth + dynamic_db；handler 内部统一调用 `require_monitor_access`
    //   断言 "X-Database-Id 存在 + 当前用户是 db 的 owner/admin（或平台超管）"。
    // - 收窄到 owner/admin 是因为 slow-queries / active-connections 会暴露 SQL 文本
    //   （WHERE 子句参数可能含业务数据），不是 viewer 应当看到的。
    let monitor_routes = Router::new()
        .route(
            "/api/monitor/stats",
            get(monitor_handlers::get_database_stats),
        )
        .route(
            "/api/monitor/pool-health",
            get(monitor_handlers::get_pool_health),
        )
        .route(
            "/api/monitor/pool-reset",
            post(monitor_handlers::reset_tenant_pool),
        )
        .route(
            "/api/monitor/tables",
            get(monitor_handlers::get_table_sizes),
        )
        .route(
            "/api/monitor/slow-queries",
            get(monitor_handlers::get_slow_queries),
        )
        .route(
            "/api/monitor/connections",
            get(monitor_handlers::get_active_connections),
        )
        .route("/api/monitor/locks", get(monitor_handlers::get_lock_waits))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::dynamic_db_middleware,
        ))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    let tenant_routes = Router::new()
        .route(
            "/api/tenants/my-connections",
            get(tenant_handlers::get_my_connections),
        )
        .route(
            "/api/tenants/:tenant_id/schemas",
            get(tenant_handlers::get_tenant_schemas),
        )
        .route(
            "/api/tenants/test-connection",
            post(tenant_handlers::test_connection),
        )
        .route(
            "/api/tenants/connections",
            post(tenant_handlers::create_database_connection),
        )
        .route(
            "/api/tenants/connections/reorder",
            post(tenant_handlers::reorder_connections),
        )
        .route(
            "/api/tenants/connections/:database_slug",
            patch(tenant_handlers::update_database_connection)
                .delete(tenant_handlers::delete_database_connection),
        )
        .route(
            "/api/tenants/switch-connection",
            post(tenant_handlers::switch_connection),
        )
        .route(
            "/api/tenants/pool-stats",
            get(tenant_handlers::get_pool_stats),
        )
        .route("/api/projects", get(tenant_handlers::list_projects))
        .route(
            "/api/projects/:id",
            get(tenant_handlers::get_project).patch(tenant_handlers::patch_project),
        )
        // Organization（产品「租户」）→ Project 层级
        .route(
            "/api/organizations",
            get(organization_handlers::list_organizations)
                .post(organization_handlers::create_organization),
        )
        .route(
            "/api/organizations/:id",
            get(organization_handlers::get_organization)
                .patch(organization_handlers::patch_organization),
        )
        .route(
            "/api/organizations/:id/members",
            get(organization_handlers::list_organization_members)
                .post(organization_handlers::add_organization_member),
        )
        .route(
            "/api/organizations/:id/member-candidates",
            get(organization_handlers::search_organization_member_candidates),
        )
        .route(
            "/api/organizations/:id/members/:user_id",
            patch(organization_handlers::update_organization_member)
                .delete(organization_handlers::remove_organization_member),
        )
        .route(
            "/api/organizations/:id/projects",
            get(organization_handlers::list_organization_projects)
                .post(organization_handlers::create_organization_project),
        )
        .route(
            "/api/organizations/:id/stats",
            get(organization_handlers::organization_stats),
        )
        .route(
            "/api/organizations/:id/member-project-matrix",
            get(organization_handlers::organization_member_project_matrix),
        )
        .route(
            "/api/organizations/:id/security-overview",
            get(organization_handlers::organization_security_overview),
        )
        .route(
            "/api/organizations/:id/transfer-owner",
            post(organization_handlers::transfer_organization_owner),
        )
        .route(
            "/api/organizations/:id/projects/:project_id",
            patch(organization_handlers::patch_organization_project),
        )
        .route(
            "/api/organizations/:id/projects/:project_id/members",
            post(organization_handlers::add_organization_project_member),
        )
        .route(
            "/api/organizations/:id/operation-logs",
            get(operation_log_handlers::list_organization_operation_logs),
        )
        .route(
            "/api/organizations/:id/operation-logs/stats",
            get(operation_log_handlers::organization_operation_log_stats),
        )
        .route(
            "/api/organizations/:id/operation-logs/actors",
            get(operation_log_handlers::list_organization_operation_log_actors),
        )
        .route(
            "/api/organizations/:id/operation-logs/facets",
            get(operation_log_handlers::organization_operation_log_facets),
        )
        .route(
            "/api/organizations/:id/operation-logs/export",
            get(operation_log_handlers::export_organization_operation_logs),
        )
        .route(
            "/api/organizations/:id/operation-logs/:log_id",
            get(operation_log_handlers::get_organization_operation_log),
        )
        // M2 wizard 只读支撑数据（用户视角）：池清单 + 平台 PG 实例。
        // 路径挂在 /api/provision/... 下，避免被旧版 `/api/:schema/:table` 误匹配。
        .route(
            "/api/provision/pg-pools/available",
            get(pg_pool_handlers::list_available_pg_pools),
        )
        .route(
            "/api/provision/pg-pools/platform-instance",
            get(pg_pool_handlers::get_platform_pg_instance),
        )
        .route(
            "/api/provision/webhook-config",
            get(pg_pool_handlers::get_provision_webhook_config),
        )
        .route(
            "/api/project-templates",
            get(tenant_handlers::list_project_templates),
        )
        // M2 主端点：自助开通新项目；caller 自动成为 owner。
        // Deprecated：无 organization_id 时会隐式建个人组织——新客户端请用
        // POST /api/organizations/:id/projects，或在 body 中传 organization_id。
        // 路由级再叠一层平台令牌 scope 校验：obp_ 令牌须持有 project:create（JWT 用户不受限）。
        .route(
            "/api/projects/provision",
            post(tenant_handlers::provision_project).layer(axum_middleware::from_fn(
                |req, next| {
                    middleware::enforce_platform_scope(
                        req,
                        next,
                        platform_token::SCOPE_PROJECT_CREATE,
                    )
                },
            )),
        )
        // W4 / PASE Stage E：项目自助成员管理（admin+）+ 项目元信息编辑（owner+）
        // 路由级走 auth_middleware；handler 内再做 require_tenant_admin / require_tenant_owner
        .route(
            "/api/projects/:id/members",
            get(tenant_handlers::list_project_members).post(tenant_handlers::add_project_member),
        )
        // 添加成员对话框搜索用——必须在 `/:id/members/:user_id` 前面注册，否则
        // axum 会把 `search` 当成 user_id 路径参数。
        .route(
            "/api/projects/:id/members/search",
            get(tenant_handlers::search_project_member_candidates),
        )
        // 项目内直接建号 + 入项目；同样必须在 `/:id/members/:user_id` 前注册。
        .route(
            "/api/projects/:id/members/create-user",
            axum::routing::post(tenant_handlers::create_project_member),
        )
        .route(
            "/api/projects/:id/members/:user_id/profile",
            axum::routing::patch(tenant_handlers::update_project_member_profile),
        )
        .route(
            "/api/projects/:id/members/:user_id/reset-password",
            axum::routing::post(tenant_handlers::reset_project_member_password),
        )
        .route(
            "/api/projects/:id/members/:user_id/status",
            axum::routing::patch(tenant_handlers::update_project_member_status),
        )
        .route(
            "/api/projects/:id/members/:user_id",
            axum::routing::patch(tenant_handlers::update_project_member)
                .delete(tenant_handlers::remove_project_member),
        )
        // 项目级环境变量（admin+）：与成员管理同款惯例，路由级 auth_middleware，
        // handler 内再做 require_tenant_admin。明文 GET 带 Cache-Control: no-store。
        .route(
            "/api/projects/:id/env-vars",
            get(env_var_handlers::list_env_vars).post(env_var_handlers::create_env_var),
        )
        .route(
            "/api/projects/:id/env-vars/:var_id",
            axum::routing::put(env_var_handlers::update_env_var)
                .delete(env_var_handlers::delete_env_var),
        )
        // 项目级对外调用基址（网关域名）：admin+ 读写；路由级 auth_middleware，
        // handler 内 require_tenant_admin。项目级优先于平台全局。
        .route(
            "/api/projects/:id/gateway-settings",
            get(public_base_settings::get_project_gateway_settings)
                .put(public_base_settings::update_project_gateway_settings),
        )
        // 工作流「数据源 / 凭证」集成模块（admin+）：与环境变量同款惯例，
        // 路由级 auth_middleware，handler 内 require_tenant_admin。凭证密钥永不回显。
        .route(
            "/api/projects/:id/wf-credentials",
            get(datasource_handlers::list_credentials).post(datasource_handlers::create_credential),
        )
        .route(
            "/api/projects/:id/wf-credentials/:cred_id",
            axum::routing::put(datasource_handlers::update_credential)
                .delete(datasource_handlers::delete_credential),
        )
        .route(
            "/api/projects/:id/wf-datasources",
            get(datasource_handlers::list_datasources).post(datasource_handlers::create_datasource),
        )
        // 测试连接需注册在 `/:ds_id` 之前，避免 axum 把 "test" 当作 ds_id 之外的静态段冲突。
        .route(
            "/api/projects/:id/wf-datasources/:ds_id/test",
            post(datasource_handlers::test_datasource),
        )
        .route(
            "/api/projects/:id/wf-datasources/:ds_id",
            axum::routing::put(datasource_handlers::update_datasource)
                .delete(datasource_handlers::delete_datasource),
        )
        .route(
            "/api/projects/:id/idp/providers",
            get(idp_handlers::list_project_idp_providers)
                .post(idp_handlers::create_project_idp_provider),
        )
        .route(
            "/api/projects/:id/idp/providers/:provider_type",
            patch(idp_handlers::update_project_idp_provider),
        )
        .route(
            "/api/projects/:id/idp/clients",
            get(idp_handlers::list_oauth2_clients).post(idp_handlers::create_oauth2_client),
        )
        .route(
            "/api/projects/:id/idp/clients/:client_id",
            patch(idp_handlers::update_oauth2_client),
        )
        .route(
            "/api/projects/:id/idp/clients/:client_id/rotate-secret",
            post(idp_handlers::rotate_oauth2_client_secret),
        )
        .route(
            "/api/projects/:id/idp/clients/:client_id/providers",
            get(idp_handlers::get_oauth2_client_providers)
                .put(idp_handlers::replace_oauth2_client_providers),
        )
        .route(
            "/api/projects/:id/idp/sessions",
            get(idp_handlers::list_idp_sessions).delete(idp_handlers::revoke_idp_session),
        )
        .route(
            "/api/projects/:id/idp/logs",
            get(idp_handlers::list_idp_login_logs),
        )
        // 操作日志（项目/租户级，admin+）：list/detail/stats/actors/export。
        // 静态段路由（stats/actors/export）必须注册在 `/:log_id` 之前，否则 axum 会把
        // "stats" 当成 log_id 路径参数（与上面 members/search 同款惯例）。
        .route(
            "/api/projects/:id/operation-logs",
            get(operation_log_handlers::list_operation_logs),
        )
        .route(
            "/api/projects/:id/operation-logs/stats",
            get(operation_log_handlers::operation_log_stats),
        )
        .route(
            "/api/projects/:id/operation-logs/actors",
            get(operation_log_handlers::list_operation_log_actors),
        )
        .route(
            "/api/projects/:id/operation-logs/facets",
            get(operation_log_handlers::operation_log_facets),
        )
        .route(
            "/api/projects/:id/operation-logs/export",
            get(operation_log_handlers::export_operation_logs),
        )
        .route(
            "/api/projects/:id/operation-logs/:log_id",
            get(operation_log_handlers::get_operation_log),
        )
        // M6 项目级简化大盘：6 个聚合指标 + 24h hourly bucket（供 sparkline）+ sanitized
        // 最近活动 feed。鉴权 = 租户任意角色（含 viewer）；纯只读、纯聚合数字，无行级业务数据。
        // handler 内走 permissions::require_tenant_membership_any。
        .route(
            "/api/dashboard/overview",
            get(dashboard_handlers::get_overview),
        )
        .route(
            "/api/dashboard/recent-activity",
            get(dashboard_handlers::get_recent_activity),
        )
        // REST API 接口文档公开分享：读状态 / 开关分享（成员即可，handler 内校验）。
        .route(
            "/api/admin/databases/:id/rest-doc-share",
            get(tenant_handlers::get_rest_doc_share).post(tenant_handlers::set_rest_doc_share),
        )
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // 平台服务令牌管理（obp_）：仅 JWT 用户可管理自己的令牌（超管可管全部）。
    // create 接口内部禁止用平台令牌调用（防提权链）。
    //
    // 注意：平台令牌（表 platform_tokens，`obp_`）≠ 内置 /mcp 用的 PAT（表 personal_access_tokens，`obm_`），
    // 前缀不同、互不通用。两套 MCP 实现的鉴权对照详见下方 pat_routes 处的注释。
    let platform_token_routes = Router::new()
        .route(
            "/api/platform-tokens",
            get(platform_token_handlers::list_platform_tokens)
                .post(platform_token_handlers::create_platform_token),
        )
        .route(
            "/api/platform-tokens/:id",
            axum::routing::delete(platform_token_handlers::delete_platform_token),
        )
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // 超管租户管理（仅超管）
    let superadmin_tenant_routes = Router::new()
        .route(
            "/api/admin/all-tenants",
            get(tenant_handlers::list_all_tenants),
        )
        .route(
            "/api/admin/tenants/create",
            post(tenant_handlers::create_tenant),
        )
        .route(
            "/api/admin/tenants/:tenant_id",
            delete(tenant_handlers::delete_tenant).patch(tenant_handlers::update_tenant),
        )
        .route(
            "/api/admin/tenants/:tenant_id/replicas",
            get(tenant_handlers::list_tenant_replicas).post(tenant_handlers::add_tenant_replica),
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
        .route(
            "/api/admin/users/:user_id/assign-tenant",
            post(tenant_handlers::assign_user_to_tenant),
        )
        // M2 自助开通：PG 池超管 CRUD
        .route(
            "/api/admin/provision/webhook-status",
            get(pg_pool_handlers::get_admin_provision_webhook_status),
        )
        .route(
            "/api/admin/provision/webhook-probe",
            post(pg_pool_handlers::probe_admin_provision_webhook),
        )
        .route(
            "/api/admin/pg-pools",
            get(pg_pool_handlers::list_pg_pools).post(pg_pool_handlers::create_pg_pool),
        )
        .route(
            "/api/admin/pg-pools/:id",
            patch(pg_pool_handlers::update_pg_pool).delete(pg_pool_handlers::delete_pg_pool),
        )
        .route(
            "/api/admin/pg-pools/:id/test",
            post(pg_pool_handlers::test_pg_pool),
        )
        // 平台全局设置（对外基址/网关域名）：超管读 / 写，写后即时生效。
        .route(
            "/api/admin/platform-settings",
            get(public_base_settings::get_platform_settings)
                .put(public_base_settings::update_platform_settings),
        )
        .layer(axum_middleware::from_fn(
            middleware::require_superadmin_middleware,
        ))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // 平台租户/用户管理（仅超管）
    let admin_routes = Router::new()
        .route("/api/admin/tenants", get(admin_handlers::list_tenants))
        .route("/api/admin/tenants", post(admin_handlers::create_tenant))
        .route(
            "/api/admin/tenants/:tenant_id/status",
            patch(admin_handlers::update_tenant_status),
        )
        .route(
            "/api/admin/tenants/:tenant_id/users",
            get(admin_handlers::list_tenant_users),
        )
        .route(
            "/api/admin/users",
            get(admin_handlers::list_users).post(admin_handlers::admin_create_user),
        )
        .route(
            "/api/admin/users/:user_id",
            patch(admin_handlers::admin_update_user).delete(admin_handlers::admin_delete_user),
        )
        .route(
            "/api/admin/users/:user_id/reset-password",
            post(admin_handlers::admin_reset_password),
        )
        .route(
            "/api/admin/tenant-users",
            post(admin_handlers::add_user_to_tenant),
        )
        .route(
            "/api/admin/tenant-users/:user_id/:tenant_id",
            delete(admin_handlers::remove_user_from_tenant),
        )
        .route("/api/admin/stats", get(admin_handlers::get_system_stats))
        .layer(axum_middleware::from_fn(
            middleware::require_superadmin_middleware,
        ))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // 旧版 PostgREST 风格路由（**仅超管 / admin-direct CRUD**，故意旁路 RBAC）
    //
    // 这是平台维护接口，不是业务 API：
    //   * 中间件链 `auth + require_superadmin + dynamic_db` 决定了非超管直接 403，
    //     所以"普通用户能绕过 RBAC"的担心在路由层就被挡住了。
    //   * 行/列条件、API Key scope、审计写表等业务约束**全部不走** —— 它和直连 psql
    //     基本等价，仅为 dashboard 表编辑器 / 运维快速调试保留。
    //   * 业务集成必须改用 `/api/v1/{database_slug}/{schema}/{table}`，它走 rbac_middleware。
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
        .layer(axum_middleware::from_fn(
            middleware::deprecated_legacy_crud_middleware,
        ))
        // 访问门槛：原来挂 `require_superadmin_middleware`（仅平台超管），导致项目
        // owner/成员浏览/编辑自己项目数据时被「该接口仅平台超级管理员可访问」挡住。
        // 改为项目级门槛：必须已切到具体租户库（堵管理库回落）+ 租户成员（dynamic_db
        // 已校验）+ 写操作 member+（viewer 只读）。必须排在 dynamic_db 之后（更内层）。
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::legacy_crud_access_middleware,
        ))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::dynamic_db_middleware,
        ))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    let rbac_routes = Router::new()
        .route(
            "/api/rbac/roles",
            get(rbac_handlers::list_roles).post(rbac_handlers::create_role),
        )
        .route(
            "/api/rbac/roles/:id",
            patch(rbac_handlers::update_role).delete(rbac_handlers::delete_role),
        )
        .route(
            "/api/rbac/roles/:id/permissions",
            get(rbac_handlers::get_role_permissions).put(rbac_handlers::set_role_permissions),
        )
        .route(
            "/api/rbac/permissions",
            get(rbac_handlers::list_permissions).post(rbac_handlers::create_permission),
        )
        .route(
            "/api/rbac/permissions/:id",
            patch(rbac_handlers::update_permission).delete(rbac_handlers::delete_permission),
        )
        .route(
            "/api/rbac/users/:user_id/roles",
            get(rbac_handlers::get_user_roles).post(rbac_handlers::assign_user_role),
        )
        .route(
            "/api/rbac/users/:user_id/roles/:role_id",
            delete(rbac_handlers::remove_user_role),
        )
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    let sso_public_routes = Router::new()
        .route(
            "/auth/sso/providers",
            get(sso_handlers::list_public_providers),
        )
        .route(
            "/auth/sso/:provider/authorize",
            get(sso_handlers::sso_authorize),
        )
        .route("/auth/sso/exchange", post(sso_handlers::sso_exchange));

    // SSO Provider 管理（超管 + 租户 owner/admin）
    //
    // 路由层只做认证；handler 内部用 `TenantContext` 把请求绑定到指定租户，
    // 然后调用 `permissions::require_tenant_admin` 再断言一次"超管或该租户管理员"。
    // 之前路由层挂 `require_superadmin_middleware` → 租户 admin 自己配自家 SSO 不行，
    // 必须找平台超管，不现实。
    let sso_admin_routes = Router::new()
        .route(
            "/api/sso/providers",
            get(sso_handlers::admin_list_providers).post(sso_handlers::admin_create_provider),
        )
        .route(
            "/api/sso/providers/:id",
            patch(sso_handlers::admin_update_provider).delete(sso_handlers::admin_delete_provider),
        )
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    let auto_api_routes = Router::new()
        .route(
            "/api/v1/:database_slug/:schema/:table",
            get(auto_api_handlers::list_records)
                .post(auto_api_handlers::create_record)
                // 批量按 query filter 更新 / 删除；handler 强制至少要一个 filter，
                // 防止漏写 WHERE 把整张表改没了。和 PostgREST `PATCH /t?pk=eq.v` 同语义。
                .patch(auto_api_handlers::update_records)
                .delete(auto_api_handlers::delete_records),
        )
        .route(
            "/api/v1/:database_slug/:schema/:table/:id",
            get(auto_api_handlers::get_record)
                .patch(auto_api_handlers::update_record)
                .delete(auto_api_handlers::delete_record),
        )
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
        .route(
            "/api/v1/:database_slug/:table",
            get(auto_api_handlers::list_records_pgrest)
                .post(auto_api_handlers::create_record_pgrest)
                .patch(auto_api_handlers::update_records_pgrest)
                .delete(auto_api_handlers::delete_records_pgrest),
        )
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            rbac_middleware::rbac_middleware,
        ))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::dynamic_db_middleware,
        ))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auto_api_database_slug_middleware,
        ))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // PostgREST 风格的 RPC（存储过程调用）路由：/api/v1/:database_slug/rpc/:fn_name
    //
    // URL 形态与 Auto API（/api/v1/:database_slug/:schema/:table）一致——项目 slug
    // 直接出现在路径里，调用方组路径只需要一套规则；不再依赖 X-Database-Id 头。
    // 路由匹配上 axum 的 matchit 优先静态段（"rpc"），所以不会与 Auto API 冲突。
    //
    // 行为对齐 PostgREST：
    //   POST  body 是 JSON object，字段名 = 形参名；schema 由 Content-Profile 头选
    //   GET   形参从 query string 取（每个值先按 JSON 解析再兜底字符串）；
    //         schema 由 Accept-Profile 头选
    //
    // 身份：rpc_auth_middleware 同时支持 JWT 与 API Key（`apikey` 或
    //   `Authorization: Bearer ob_*`），与 supabase-js 兼容。
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
            "/api/v1/:database_slug/rpc/:fn_name",
            post(rpc::execute_rpc).get(rpc::execute_rpc_get),
        )
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::dynamic_db_middleware,
        ))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            rpc::rpc_auth_middleware,
        ));

    // v1 DDL：建表 / 改表 / 删表。路径 `/api/v1/:database_slug/ddl/tables/...`
    // 鉴权同 RPC——JWT 或 API Key；Key 须在 scope 中声明 DDL 或 ALL。
    let ddl_v1_routes = Router::new()
        .route(
            "/api/v1/:database_slug/ddl/tables",
            post(ddl_handlers::v1_create_table),
        )
        .route(
            "/api/v1/:database_slug/ddl/tables/:schema/:table",
            delete(ddl_handlers::v1_drop_table).patch(ddl_handlers::v1_alter_table),
        )
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::dynamic_db_middleware,
        ))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            ddl_handlers::ddl_auth_middleware,
        ));

    let sql_v1_routes = Router::new()
        .route(
            "/api/v1/:database_slug/sql",
            post(sql_v1_handlers::v1_execute_raw_ddl),
        )
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::dynamic_db_middleware,
        ))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            sql_v1_handlers::sql_auth_middleware,
        ));

    // RPC ACL 管理（超管 + 租户 owner/admin）—— handler 内部按 database_id → tenant_id 校验。
    let rpc_acl_routes = Router::new()
        .route(
            "/api/admin/rpc-acls",
            get(rpc::list_rpc_acls)
                .post(rpc::grant_rpc_acl)
                .delete(rpc::revoke_rpc_acl),
        )
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // 速率限制 / 熔断器 / 网关信息（仅超管）
    let gateway_routes = Router::new()
        .route(
            "/api/admin/rate-limit-rules",
            get(gateway_handlers::list_rules).post(gateway_handlers::create_rule),
        )
        .route(
            "/api/admin/rate-limit-rules/:id",
            patch(gateway_handlers::update_rule).delete(gateway_handlers::delete_rule),
        )
        .route(
            "/api/admin/rate-limit-stats",
            get(gateway_handlers::rate_limit_stats),
        )
        .route(
            "/api/admin/circuit-breakers",
            get(gateway_handlers::circuit_breaker_status),
        )
        .route(
            "/api/admin/gateway-info",
            get(gateway_handlers::gateway_info),
        )
        .layer(axum_middleware::from_fn(
            middleware::require_superadmin_middleware,
        ))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // 平台监控总览 / 时序 / 告警（仅超管）
    let platform_monitor_routes = Router::new()
        .route(
            "/api/admin/platform-monitor/overview",
            get(platform_monitor_handlers::overview),
        )
        .route(
            "/api/admin/platform-monitor/timeseries",
            get(platform_monitor_handlers::timeseries),
        )
        .route(
            "/api/admin/platform-monitor/top-endpoints",
            get(platform_monitor_handlers::top_endpoints),
        )
        .route(
            "/api/admin/platform-monitor/recent-errors",
            get(platform_monitor_handlers::recent_errors),
        )
        .route(
            "/api/admin/platform-monitor/tenant-breakdown",
            get(platform_monitor_handlers::tenant_breakdown),
        )
        .route(
            "/api/admin/platform-monitor/alert-config",
            get(platform_monitor_handlers::get_alert_config)
                .put(platform_monitor_handlers::put_alert_config),
        )
        .route(
            "/api/admin/platform-monitor/alert-rules",
            get(platform_monitor_handlers::list_alert_rules)
                .post(platform_monitor_handlers::create_alert_rule),
        )
        .route(
            "/api/admin/platform-monitor/alert-rules/:id",
            patch(platform_monitor_handlers::patch_alert_rule)
                .delete(platform_monitor_handlers::delete_alert_rule),
        )
        .route(
            "/api/admin/platform-monitor/alert-events",
            get(platform_monitor_handlers::list_alert_events),
        )
        .layer(axum_middleware::from_fn(
            middleware::require_superadmin_middleware,
        ))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // 审计日志 / 慢查询（超管 + 租户 owner/admin）— handler 内按 tenant 隔离
    let audit_routes = Router::new()
        .route(
            "/api/admin/audit-logs",
            get(audit_handlers::list_audit_logs),
        )
        .route(
            "/api/admin/slow-queries",
            get(audit_handlers::list_slow_queries),
        )
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // 平台 raw SQL 审计面板（仅超管）—— handler 里调 require_platform_superadmin
    // 自己鉴权；这里不挂 require_superadmin_middleware 是因为 handler 也要响应
    // "403 但带 JSON 错误体"的语义，比 middleware 401 更友好。
    let platform_audit_routes = Router::new()
        .route(
            "/api/platform/admin-audit-logs",
            get(audit_handlers::list_platform_admin_audit),
        )
        .route(
            "/api/platform/raw-sql-audit",
            get(audit_handlers::list_raw_sql_audit),
        )
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // 统一执行日志查询面板（超管 + 租户 owner/admin）—— handler 内按 tenant 隔离。
    // stats 用独立路径（/execution-stats），避免与 /executions/:trace_id 的静态/参数段冲突。
    let execution_log_routes = Router::new()
        .route(
            "/api/platform/executions",
            get(execution_log_handlers::list_executions),
        )
        // 总数单独成路（含连字符，避免撞 /executions/:trace_id 参数段）：前端仅在筛选变化时拉一次。
        .route(
            "/api/platform/execution-count",
            get(execution_log_handlers::count_executions),
        )
        .route(
            "/api/platform/execution-stats",
            get(execution_log_handlers::execution_stats),
        )
        .route(
            "/api/platform/executions/:trace_id",
            get(execution_log_handlers::get_execution_detail),
        )
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // Webhook 配置（超管 + 租户 owner/admin）— handler 内按 tenant 隔离
    let webhook_routes = Router::new()
        .route(
            "/api/admin/webhooks",
            get(webhook_handlers::list_webhooks).post(webhook_handlers::create_webhook),
        )
        .route(
            "/api/admin/webhooks/:id",
            patch(webhook_handlers::update_webhook).delete(webhook_handlers::delete_webhook),
        )
        .route(
            "/api/admin/webhooks/:id/test",
            post(webhook_handlers::test_webhook),
        )
        .route(
            "/api/admin/webhooks/:id/logs",
            get(webhook_handlers::webhook_logs),
        )
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // 工作流管理 API
    let workflow_folder_routes = Router::new()
        .route(
            "/api/admin/workflow-folders",
            get(workflow_folder_handlers::list_workflow_folders)
                .post(workflow_folder_handlers::create_workflow_folder),
        )
        .route(
            "/api/admin/workflow-folders/:id",
            patch(workflow_folder_handlers::update_workflow_folder)
                .delete(workflow_folder_handlers::delete_workflow_folder),
        )
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    let workflow_routes = Router::new()
        .route(
            "/api/admin/workflows/summary",
            get(workflow_handlers::workflow_list_summary),
        )
        .route(
            "/api/admin/workflows",
            get(workflow_handlers::list_workflows).post(workflow_handlers::create_workflow),
        )
        // 编辑态调试：必须在 `/:id` 之前注册，避免 "debug" 被当成 id 路径参数。
        .route(
            "/api/admin/workflows/debug",
            post(workflow_handlers::debug_workflow),
        )
        // 手动收口残留 running 的执行记录（卡死事故时清积压）。
        .route(
            "/api/admin/workflows/runs/cleanup",
            post(workflow_handlers::cleanup_stale_runs),
        )
        // 批量启用/禁用/删除：必须在 `/:id` 之前注册，避免 "batch" 被当成 id 路径参数。
        .route(
            "/api/admin/workflows/batch",
            post(workflow_handlers::batch_workflows),
        )
        // 批量导入：同样需在 `/:id` 之前注册。
        .route(
            "/api/admin/workflows/import",
            post(workflow_handlers::import_workflows),
        )
        // 导出审计回执（前端本地下载后回调记 EXPORT 打点）；静态段，须在 `/:id` 之前。
        .route(
            "/api/admin/workflows/export-audit",
            post(workflow_handlers::export_workflows_audit),
        )
        // 依赖图浏览器：全量工作流 + call_workflow 依赖边，只读聚合；静态段，须在 `/:id` 之前。
        .route(
            "/api/admin/workflows/dependency-graph",
            get(workflow_handlers::workflow_dependency_graph),
        )
        .route(
            "/api/admin/workflows/:id",
            get(workflow_handlers::get_workflow)
                .patch(workflow_handlers::update_workflow)
                .delete(workflow_handlers::delete_workflow),
        )
        .route(
            "/api/admin/workflows/:id/duplicate",
            post(workflow_handlers::duplicate_workflow),
        )
        .route(
            "/api/admin/workflows/:id/trigger",
            post(workflow_handlers::trigger_workflow),
        )
        .route(
            "/api/admin/workflows/:id/runs",
            get(workflow_handlers::get_workflow_runs),
        )
        .route(
            "/api/admin/workflows/:id/runs/:run_id",
            get(workflow_handlers::get_workflow_run_detail),
        )
        // 接口文档公开分享：读状态 / 开关分享。
        .route(
            "/api/admin/workflows/:id/doc-share",
            get(workflow_handlers::get_workflow_doc_share)
                .post(workflow_handlers::set_workflow_doc_share),
        )
        // 版本控制：列表 / 取某版本完整快照 / 恢复到某版本。
        .route(
            "/api/admin/workflows/:id/versions",
            get(workflow_handlers::list_workflow_versions),
        )
        .route(
            "/api/admin/workflows/:id/versions/:version",
            get(workflow_handlers::get_workflow_version),
        )
        .route(
            "/api/admin/workflows/:id/versions/:version/restore",
            post(workflow_handlers::restore_workflow_version),
        )
        // 平台令牌 scope 校验（按方法/路径细分 read/write/run）。必须排在 auth 之内层：
        // auth_middleware（更外层、后注册）先注入 PlatformTokenContext，本层再据此校验。
        .layer(axum_middleware::from_fn(
            middleware::enforce_workflow_token_scope,
        ))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // 工作流公开端点：POST /pub/workflow/:database_slug/*workflow_slug（无需认证，供 Stripe webhook 等使用）
    // workflow_slug 用通配 `*` 捕获，支持 slug 含 `/`（如 `public/kop-callback`）。
    let workflow_public_routes = Router::new().route(
        "/pub/workflow/:database_slug/*workflow_slug",
        post(workflow_handlers::endpoint_trigger_public),
    );

    // 接口文档公开只读：GET /api/public/workflow-doc/:token（无需认证）。
    // 凭分享 token 返回提炼后的文档数据（不含 nodes），供未登录访客查看接口文档。
    let public_workflow_doc_routes = Router::new().route(
        "/api/public/workflow-doc/:token",
        get(workflow_handlers::public_workflow_doc),
    );

    // 项目 REST API 接口文档公开只读：GET /api/public/rest-api-doc/:token（无需认证）。
    // 凭分享 token 返回 database_slug/schema/项目名，供未登录访客查看该库 REST/RPC/DDL 接口文档。
    let public_rest_api_doc_routes = Router::new().route(
        "/api/public/rest-api-doc/:token",
        get(tenant_handlers::public_rest_api_doc),
    );

    // 运行期前端配置公开只读：GET /api/public/frontend/config（无需认证）。
    // 返回对外调用基址（网关域名），供接口文档等在运行期拼接调用地址，
    // 取代构建期烤死的 NEXT_PUBLIC_API_URL —— 运维改网关域名无需重建前端。
    // ⚠️ 路径必须 ≥3 段：两段的 `/api/public/config` 会被通配 REST 路由 `/api/:schema/:table`
    //    当成 schema=public/table=config 抢走并要求鉴权（见下方 handlers::get_records 注册）。
    let public_config_routes = Router::new().route(
        "/api/public/frontend/config",
        get(public_base_settings::public_frontend_config),
    );

    // ⚠️ MCP 有两套并存实现，鉴权令牌前缀不同、查不同的表，务必分清：
    //
    //   ┌─ 内置 /mcp（本进程，mcp_server.rs + mcp_tools.rs）
    //   │    令牌：PAT（`obm_` 前缀），表 management.personal_access_tokens
    //   │    管理：/api/admin/pats（下面的 pat_routes），前端 patAPI
    //   │    用途：仅工作流创作（list/get/create/update/debug_workflow 等）
    //   │
    //   └─ 外部 mcp-server/（独立 Node 进程，转调本服务 HTTP API）
    //        令牌：平台服务令牌（`obp_` 前缀），表 management.platform_tokens
    //        管理：/api/platform-tokens（platform_token_routes），前端 platformTokenAPI
    //        用途：建项目 + 工作流全套（走 auth_middleware 的 obp_ 分支 + scope 校验）
    //
    // 令牌不可混用：拿 `obm_` PAT 打 HTTP API、或拿 `obp_` 平台令牌打 /mcp，
    // 都会查不到记录而 401。这是设计如此（两套各自独立），不是 bug。
    //
    // PAT 管理 API（个人访问令牌）：普通登录态即可管理自己的令牌。
    let pat_routes = Router::new()
        .route(
            "/api/admin/pats",
            get(pat_handlers::list_pats).post(pat_handlers::create_pat),
        )
        .route("/api/admin/pats/:id", delete(pat_handlers::revoke_pat))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // 内置 MCP 工作流创作端点：不挂 auth_middleware（那条链路只认 JWT / ob_ API Key），
    // handler 内自行调 pat_handlers::verify_pat 做 PAT 鉴权，详见 mcp_server.rs 模块注释。
    // 模块闸门：MCP（智能体接入）属于「AI / MCP」加购模块。
    let mcp_routes = Router::new()
        .route("/mcp", post(mcp_server::mcp_endpoint))
        .layer(axum_middleware::from_fn(|req, next| {
            onebase::license::require_module(req, next, "ai")
        }));

    // 项目级通用 AI 助手：Provider 配置 admin+，聊天 member+。
    // 配置和聊天均挂 AI License 模块闸门；聊天是长连接 SSE，不进入全局 TimeoutLayer。
    let ai_config_routes = Router::new()
        .route(
            "/api/projects/:id/ai/providers",
            get(ai::list_providers).post(ai::create_provider),
        )
        .route(
            "/api/projects/:id/ai/providers/:provider_id",
            axum::routing::put(ai::update_provider).delete(ai::delete_provider),
        )
        .route(
            "/api/projects/:id/ai/providers/:provider_id/test",
            post(ai::test_provider),
        )
        .layer(axum_middleware::from_fn(|req, next| {
            onebase::license::require_module(req, next, "ai")
        }))
        .layer(axum_middleware::from_fn(ai::interactive_jwt_guard))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));
    let ai_chat_routes = Router::new()
        .route("/api/projects/:id/ai/chat", post(ai::chat))
        .layer(axum_middleware::from_fn(|req, next| {
            onebase::license::require_module(req, next, "ai")
        }))
        .layer(axum_middleware::from_fn(ai::interactive_jwt_guard))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // 工作流 Endpoint 触发器路由：GET/POST /workflow/:database_slug/*workflow_slug
    // 走 auth_middleware 认证（JWT 或 API Key），允许外部调用。
    // workflow_slug 用通配 `*` 捕获，支持 slug 含 `/`（如 `public/kop-callback`）。
    let workflow_endpoint_routes = Router::new()
        .route(
            "/workflow/:database_slug/*workflow_slug",
            get(workflow_handlers::endpoint_trigger_get).post(workflow_handlers::endpoint_trigger),
        )
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    let realtime_routes = Router::new().route("/realtime/ws", get(realtime::ws_handler));

    // 通用 SSE 推送：
    //  - GET /sse —— 浏览器 EventSource 入口，用 ?token= query 鉴权（不挂 auth_middleware，
    //    与 /realtime/ws 同理：EventSource 无法设置自定义 header）。
    //  - POST /api/sse/publish —— 业务/外部主动推消息，挂 auth_middleware 注入 Claims。
    let sse_stream_routes = Router::new()
        .route("/sse", get(sse::sse_handler))
        // 通用对外订阅端点：浏览器 EventSource，身份取网关注入的可信头（不挂 auth_middleware）。
        .route("/events/:slug", get(sse::public_event_handler));
    let sse_publish_routes = Router::new()
        .route("/api/sse/publish", post(sse::publish_handler))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // SSE 转发/路由规则管理（超管 + 租户 owner/admin）— handler 内按 tenant 隔离
    let sse_route_routes = Router::new()
        .route(
            "/api/admin/sse-routes",
            get(sse_route_handlers::list_routes).post(sse_route_handlers::create_route),
        )
        .route(
            "/api/admin/sse-routes/:id",
            patch(sse_route_handlers::update_route).delete(sse_route_handlers::delete_route),
        )
        // NOTIFY 监听桥管理（超管 + 租户 owner/admin）— handler 内按库归属租户隔离
        .route(
            "/api/admin/sse-notify-bridges",
            get(sse_notify_bridge_handlers::list_bridges)
                .post(sse_notify_bridge_handlers::create_bridge),
        )
        .route(
            "/api/admin/sse-notify-bridges/:id",
            patch(sse_notify_bridge_handlers::update_bridge)
                .delete(sse_notify_bridge_handlers::delete_bridge),
        )
        // NOTIFY 监听桥只读监控（限超管，handler 内校验）
        .route(
            "/api/admin/sse-notify-bridges/stats",
            get(sse_notify_bridge_handlers::stats),
        )
        // 对外订阅端点管理（超管 + 端点所属租户 owner/admin）— handler 内按 tenant 隔离
        .route(
            "/api/admin/sse-public-endpoints",
            get(sse_public_endpoint_handlers::list_endpoints)
                .post(sse_public_endpoint_handlers::create_endpoint),
        )
        .route(
            "/api/admin/sse-public-endpoints/:id",
            patch(sse_public_endpoint_handlers::update_endpoint)
                .delete(sse_public_endpoint_handlers::delete_endpoint),
        )
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // API Key 管理（超管 + 租户 owner/admin）— handler 内部按 database_id 校验是否租户管理员
    let api_key_routes = Router::new()
        .route(
            "/api/admin/api-keys/:database_slug",
            get(auto_api_handlers::list_api_keys).post(auto_api_handlers::create_api_key),
        )
        .route(
            "/api/admin/api-keys/:database_slug/:key_id",
            patch(auto_api_handlers::update_api_key).delete(auto_api_handlers::delete_api_key),
        )
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

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
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // 会话规则（Session Rules）：项目级 RPC inject 路径的可配置钩子。
    //
    // 详细设计：docs/superpowers/specs/2026-05-27-session-rules-design.md
    // 与 workflow_engine 的关系：两套并存，UI 共享"自动化"区域；rules 走同步声明式，
    // workflow 走异步脚本式，互不替代。
    //
    // 鉴权：handler 内走 permissions::require_database_admin（超管 / 项目 owner|admin）。
    // 审计：全局 audit_middleware 自动落 audit_logs，handler 通过 AuditDetailSink
    //       塞结构化字段。
    let session_rules_routes = Router::new()
        .route(
            "/api/admin/session-rules/:database_slug",
            get(session_rules_handlers::list_rules).post(session_rules_handlers::create_rule),
        )
        .route(
            "/api/admin/session-rules/:database_slug/:id",
            get(session_rules_handlers::get_rule)
                .patch(session_rules_handlers::update_rule)
                .delete(session_rules_handlers::delete_rule),
        )
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // ─── Elasticsearch 反向代理 ─────────────────────────────────────────
    //
    // 两组路由：
    //  1) `/api/admin/es-connections/*`  — 连接 + token CRUD，走 auth_middleware
    //     （JWT only；token 在 handler 里按租户 owner/admin 校验）。
    //  2) `/api/es/*es_path`             — 业务端实际打的代理，**不走 auth_middleware**：
    //     用业务专属 `obes_es_xxx` token 在 handler 内自鉴权，故意不耦合 JWT —— 业务
    //     端的 ES client（Python / Node / curl）不需要登录平台拿 JWT，开箱即用。
    //
    // proxy 路由用 axum 通配 `*es_path`，匹配 `/api/es/` 之后的所有 path（含多级）。
    // 也因此故意放在 `auto_api_routes` 之后避免与其它 `/api/*` 通配冲突。
    let es_admin_routes = Router::new()
        .route(
            "/api/admin/es-connections",
            get(es::admin_handlers::list_connections).post(es::admin_handlers::create_connection),
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
        // 模块闸门：ES 属于「数据管道」加购模块。
        .layer(axum_middleware::from_fn(|req, next| {
            onebase::license::require_module(req, next, "pipeline")
        }))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // ─── Redis 数据源 ───────────────────────────────────────────────────
    //
    // 两组路由，都走 auth_middleware（JWT）：
    //  1) `/api/admin/redis-connections/*` — 连接 CRUD + health，handler 内按
    //     租户 owner/admin 校验（与 ES 连接管理同款）。
    //  2) `/api/redis-connections/:id/exec` — 数据读写，handler 内按租户成员校验
    //     （写要 member，读放行任意成员）。
    let redis_admin_routes = Router::new()
        .route(
            "/api/admin/redis-connections",
            get(redis_handlers::list_connections).post(redis_handlers::create_connection),
        )
        .route(
            "/api/admin/redis-connections/:id",
            get(redis_handlers::get_connection)
                .put(redis_handlers::update_connection)
                .delete(redis_handlers::delete_connection),
        )
        .route(
            "/api/admin/redis-connections/:id/health",
            post(redis_handlers::health_check),
        )
        .route(
            "/api/redis-connections/:id/exec",
            post(redis_handlers::exec),
        )
        // 模块闸门：Redis 属于「数据管道」加购模块。
        .layer(axum_middleware::from_fn(|req, next| {
            onebase::license::require_module(req, next, "pipeline")
        }))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // ─── Kafka 数据源 ───────────────────────────────────────────────────
    //
    // 管理接口限租户 owner/admin；exec 的 produce 限 member+，只读操作允许 viewer。
    let kafka_admin_routes = Router::new()
        .route(
            "/api/admin/kafka-connections",
            get(kafka_handlers::list_connections).post(kafka_handlers::create_connection),
        )
        .route(
            "/api/admin/kafka-connections/:id",
            get(kafka_handlers::get_connection)
                .put(kafka_handlers::update_connection)
                .delete(kafka_handlers::delete_connection),
        )
        .route(
            "/api/admin/kafka-connections/:id/health",
            post(kafka_handlers::health_check),
        )
        .route(
            "/api/admin/kafka-connections/:id/topics",
            get(kafka_handlers::list_topics).post(kafka_handlers::create_topic),
        )
        .route(
            "/api/admin/kafka-connections/:id/consumer-groups",
            get(kafka_handlers::list_consumer_groups),
        )
        .route(
            "/api/admin/kafka-connections/:id/tokens",
            get(kafka_handlers::list_tokens).post(kafka_handlers::create_token),
        )
        .route(
            "/api/admin/kafka-connections/:id/tokens/:token_id",
            axum::routing::patch(kafka_handlers::update_token).delete(kafka_handlers::delete_token),
        )
        .route(
            "/api/kafka-connections/:id/exec",
            post(kafka_handlers::exec),
        )
        // 模块闸门：Kafka 属于「数据管道」加购模块（enforce 模式下未授权即 402）。
        .layer(axum_middleware::from_fn(|req, next| {
            onebase::license::require_module(req, next, "pipeline")
        }))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // ─── 对象存储数据源（COS / OSS / MinIO，S3 兼容）─────────────────────
    //
    // JWT 面：
    //  1) `/api/admin/object-storage-connections/*` — 连接 CRUD + health + tokens
    //  2) `/api/object-storage-connections/:id/exec` — 租户成员数据读写
    // 令牌面（见下方 object_storage_app_routes）：`obes_os_*` 自鉴权，不挂 JWT。
    let object_storage_admin_routes = Router::new()
        .route(
            "/api/admin/object-storage-connections",
            get(object_storage_handlers::list_connections)
                .post(object_storage_handlers::create_connection),
        )
        .route(
            "/api/admin/object-storage-connections/:id",
            get(object_storage_handlers::get_connection)
                .put(object_storage_handlers::update_connection)
                .delete(object_storage_handlers::delete_connection),
        )
        .route(
            "/api/admin/object-storage-connections/:id/health",
            post(object_storage_handlers::health_check),
        )
        .route(
            "/api/admin/object-storage-connections/:id/tokens",
            get(object_storage_handlers::list_tokens).post(object_storage_handlers::create_token),
        )
        .route(
            "/api/admin/object-storage-connections/:id/tokens/:token_id",
            axum::routing::patch(object_storage_handlers::update_token)
                .delete(object_storage_handlers::delete_token),
        )
        .route(
            "/api/object-storage-connections/:id/exec",
            post(object_storage_handlers::exec),
        )
        // 模块闸门：对象存储属于「数据管道」加购模块。
        .layer(axum_middleware::from_fn(|req, next| {
            onebase::license::require_module(req, next, "pipeline")
        }))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // Kafka 令牌面 REST：obes_kafka_* 自鉴权，不挂 JWT。
    fn kafka_app_inner() -> Router<PgPool> {
        Router::new()
            .route("/:id/produce", post(kafka_app_handlers::produce))
            .route("/:id/topics", get(kafka_app_handlers::list_topics))
            .route("/:id/health", get(kafka_app_handlers::health))
    }
    let kafka_app_routes = Router::new()
        .nest("/api/kafka", kafka_app_inner())
        .merge(
            Router::new()
                .nest("/api/v1/:database_slug/kafka", kafka_app_inner())
                .route_layer(axum_middleware::from_fn_with_state(
                    pool.clone(),
                    es::proxy_common::es_tenant_scope_middleware,
                )),
        )
        // 模块闸门：Kafka 数据面属于「数据管道」加购模块。
        .layer(axum_middleware::from_fn(|req, next| {
            onebase::license::require_module(req, next, "pipeline")
        }));

    // 对象存储令牌面 REST：obes_os_* 自鉴权，不挂 JWT。
    fn object_storage_app_inner() -> Router<PgPool> {
        Router::new()
            .route("/:id/exec", post(object_storage_app_handlers::exec))
            .route("/:id/health", get(object_storage_app_handlers::health))
    }
    let object_storage_app_routes = Router::new()
        .nest("/api/object-storage", object_storage_app_inner())
        .merge(
            Router::new()
                .nest(
                    "/api/v1/:database_slug/object-storage",
                    object_storage_app_inner(),
                )
                .route_layer(axum_middleware::from_fn_with_state(
                    pool.clone(),
                    es::proxy_common::es_tenant_scope_middleware,
                )),
        )
        // 模块闸门：对象存储数据面属于「数据管道」加购模块。
        .layer(axum_middleware::from_fn(|req, next| {
            onebase::license::require_module(req, next, "pipeline")
        }));

    // 代理路由：不挂 auth_middleware（token 自鉴权）。注册所有 ES 用的 HTTP 方法。
    // 同时提供旧路径 `/api/es/*` 与项目 slug 路径 `/api/v1/:database_slug/es/*`。
    fn es_proxy_inner() -> Router<PgPool> {
        Router::new().route(
            "/*es_path",
            get(es::proxy_handler::proxy)
                .post(es::proxy_handler::proxy)
                .put(es::proxy_handler::proxy)
                .delete(es::proxy_handler::proxy)
                .head(es::proxy_handler::proxy)
                .patch(es::proxy_handler::proxy),
        )
    }
    let es_proxy_routes = Router::new()
        .nest("/api/es", es_proxy_inner())
        .merge(
            Router::new()
                .nest("/api/v1/:database_slug/es", es_proxy_inner())
                .route_layer(axum_middleware::from_fn_with_state(
                    pool.clone(),
                    es::proxy_common::es_tenant_scope_middleware,
                )),
        )
        // 模块闸门：ES 代理属于「数据管道」加购模块。
        .layer(axum_middleware::from_fn(|req, next| {
            onebase::license::require_module(req, next, "pipeline")
        }));

    // ES 高层「应用」API：业务侧无需 ES DSL / SDK，直接发简化 JSON。
    // 复用与 proxy 同一套 `obes_es_xxx` token；handler 自鉴权，同样不走 auth_middleware。
    // 旧路径 `/api/es-app/*` 保留兼容；推荐 `/api/v1/:database_slug/es-app/*`。
    fn es_app_inner() -> Router<PgPool> {
        Router::new()
            .route("/_indices", get(es::app_handlers::list_indices))
            .route(
                "/:index",
                get(es::app_handlers::get_index_info).delete(es::app_handlers::delete_index),
            )
            .route("/:index/_init", post(es::app_handlers::init_index))
            .route("/:index/docs", post(es::app_handlers::create_doc))
            .route(
                "/:index/docs/:id",
                get(es::app_handlers::get_doc)
                    .put(es::app_handlers::upsert_doc)
                    .patch(es::app_handlers::patch_doc)
                    .delete(es::app_handlers::delete_doc),
            )
            .route("/:index/search", post(es::app_handlers::search))
            .route("/:index/count", post(es::app_handlers::count))
            .route("/:index/bulk", post(es::app_handlers::bulk))
    }
    let es_app_routes = Router::new()
        .nest("/api/es-app", es_app_inner())
        .merge(
            Router::new()
                .nest("/api/v1/:database_slug/es-app", es_app_inner())
                .route_layer(axum_middleware::from_fn_with_state(
                    pool.clone(),
                    es::proxy_common::es_tenant_scope_middleware,
                )),
        )
        // 模块闸门：ES 应用面属于「数据管道」加购模块。
        .layer(axum_middleware::from_fn(|req, next| {
            onebase::license::require_module(req, next, "pipeline")
        }));

    // SSE / WebSocket 长连接：不挂全局 TimeoutLayer（默认 30s 会切断流）。
    let streaming_routes = Router::new()
        .merge(realtime_routes)
        .merge(sse_stream_routes)
        .merge(ai_chat_routes);

    // 工作流触发端点（GET/POST /workflow/... 与 POST /pub/workflow/...）：单次执行可能长达
    // workflow.timeout_ms（如 180s）。execute_workflow_internal 内部已有 per-workflow 的
    // tokio 超时兜底，超时/失败都会被 finalize_endpoint_response 优雅收口（开启
    // graceful_error_response 时返回 HTTP 200 + {ok:false,error}）。若再套全局 30s
    // TimeoutLayer，长工作流会在 HTTP 层被提前取消（408）：handler future 被 drop、来不及
    // 收口 → 调用方拿到连接层错误、run 被标记为「执行被中断（HTTP 请求超时或任务取消）」。
    // 因此与 SSE/WebSocket 一样不挂全局 TimeoutLayer，由 per-workflow 超时负责兜底。
    // 注意：这只拆掉服务端这一处 30s；调用方/中间代理若也有 30s 超时，仍需在各自侧放宽。
    let workflow_trigger_routes = Router::new()
        .merge(workflow_endpoint_routes)
        .merge(workflow_public_routes);

    let api_routes_with_timeout = Router::new()
        .merge(public_routes)
        .merge(public_workflow_doc_routes)
        .merge(public_rest_api_doc_routes)
        .merge(public_config_routes)
        .merge(sql_routes)
        .merge(protected_routes)
        .merge(schema_routes)
        .merge(index_routes)
        .merge(query_perf_routes)
        .merge(export_routes)
        .merge(monitor_routes)
        .merge(tenant_routes)
        .merge(platform_token_routes)
        .merge(superadmin_tenant_routes)
        .merge(admin_routes)
        .merge(rbac_routes)
        .merge(sso_public_routes)
        .merge(sso_admin_routes)
        .merge(api_routes)
        .merge(auto_api_routes)
        .merge(rpc_routes)
        .merge(ddl_v1_routes)
        .merge(sql_v1_routes)
        .merge(rpc_acl_routes)
        .merge(api_key_routes)
        .merge(webhook_routes)
        .merge(sse_publish_routes)
        .merge(sse_route_routes)
        .merge(audit_routes)
        .merge(platform_audit_routes)
        .merge(execution_log_routes)
        .merge(gateway_routes)
        .merge(platform_monitor_routes)
        .merge(scheduled_task_routes)
        .merge(session_rules_routes)
        .merge(es_admin_routes)
        .merge(redis_admin_routes)
        .merge(kafka_admin_routes)
        .merge(object_storage_admin_routes)
        .merge(object_storage_app_routes)
        .merge(kafka_app_routes)
        .merge(es_proxy_routes)
        .merge(es_app_routes)
        .merge(workflow_routes)
        .merge(workflow_folder_routes)
        .merge(pat_routes)
        .merge(mcp_routes)
        .merge(ai_config_routes)
        .layer(TimeoutLayer::new(Duration::from_secs(
            config.request_timeout_secs,
        )));

    let mut app = Router::new()
        .merge(streaming_routes)
        .merge(workflow_trigger_routes)
        .merge(api_routes_with_timeout)
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

    // 商用授权强制中间件：enforce 模式下、授权到期/无效时拦截写操作（只读降级）。
    // 与 audit 同款 layer 顺序不变式：先 .layer(中间件)（内层），再 .layer(Extension)
    // （外层，请求一进 router 就注入 LicenseState，下游中间件才读得到）。
    app = app.layer(axum_middleware::from_fn(
        onebase::license::license_enforcement_middleware,
    ));
    app = app.layer(axum::Extension(license_state.clone()));

    // 熔断器（使用可配置阈值）
    let cb_config = circuit_breaker::CircuitBreakerConfig {
        failure_threshold: config.cb_failure_threshold,
        success_threshold: 3,
        timeout_secs: config.cb_timeout_secs,
    };
    let cb_manager = circuit_breaker::CircuitBreakerManager::new(cb_config);
    let cb_manager_for_monitor = cb_manager.clone();
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
    let limiter_for_monitor = {
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
        let for_monitor = limiter.clone();
        app = app.layer(axum::Extension(limiter));
        app = app.layer(axum_middleware::from_fn(
            rate_limiter::rate_limit_middleware,
        ));
        Some(for_monitor)
    };

    // 事件系统 + Webhook + Realtime
    let event_bus = events::EventBus::new(4096);
    app = app.layer(axum::Extension(event_bus.clone()));

    let wh_manager = webhook_manager::WebhookManager::new(pool_for_events.clone());
    wh_manager.start(event_bus.clone());

    let rt_manager = realtime::RealtimeManager::new(event_bus.clone());
    let broadcaster = rt_manager.start_broadcaster();
    app = app.layer(axum::Extension(rt_manager));
    app = app.layer(axum::Extension(broadcaster));

    // 通用 SSE 总线：注入 Extension，并启动「数据变更 → topic」桥接（publish_local，不经 Redis 扇出）。
    let sse_hub = sse::SseHub::new(config.sse_hub_capacity);
    app = app.layer(axum::Extension(sse_hub.clone()));
    // 注册全局 publisher：让工作流节点 / Lua 脚本（lib 侧）也能推 SSE。
    sse_publisher::set_global_publisher(std::sync::Arc::new(sse_hub.clone()));
    sse::start_data_change_bridge(sse_hub.clone(), event_bus.clone());
    // 周期清理 SSE 回放缓冲里过期的消息（断线重连按 Last-Event-ID 续传用）。
    sse::spawn_replay_sweeper(sse_hub.clone());
    // 可配置的 SSE 转发规则执行器（缓存 management.sse_routes + 按数据变更匹配推送）
    sse_route_manager::start(pool.clone(), sse_hub.clone(), event_bus.clone());
    // PG NOTIFY → SSE 监听桥（按 management.sse_notify_bridges 配置 LISTEN 业务库，定向推送）
    let sse_bridge_metrics = sse_notify_bridge::BridgeMetrics::new();
    app = app.layer(axum::Extension(sse_bridge_metrics.clone()));
    let listen_hub = pg_listen_hub::ListenHub::start_with_pool(pool.clone());
    app = app.layer(axum::Extension(listen_hub.clone()));
    sse_notify_bridge::start(
        pool.clone(),
        sse_hub.clone(),
        sse_bridge_metrics.clone(),
        listen_hub.clone(),
    );

    // 跨实例 Redis Pub/Sub 事件桥接
    if let Some(ref redis) = redis {
        redis_pubsub::RedisPubSubBridge::start_publisher(event_bus.clone(), redis.clone());
        redis_pubsub::RedisPubSubBridge::start_subscriber(
            event_bus.clone(),
            config.redis_url.clone(),
        );
        // SSE 通用消息的跨实例扇出（独立 channel onebase:sse）
        sse_redis::SseRedisBridge::start_publisher(sse_hub.clone(), redis.clone());
        sse_redis::SseRedisBridge::start_subscriber(sse_hub.clone(), config.redis_url.clone());
        tracing::info!("Redis Pub/Sub 事件桥接已启动");
    }

    // 启动自检：收口上次进程残留的"幽灵 running"工作流执行。grace 兜住多实例下其它实例正在
    // 跑的新 run，不误伤；由 WORKFLOW_STALE_GRACE_SECS 配置（关闭超时时缺省放大到 24h）。
    // 失败不阻断启动，仅记日志。
    let stale_grace = workflow_engine::stale_grace_secs();
    match workflow_handlers::reconcile_stale_runs(&pool, stale_grace).await {
        Ok(n) if n > 0 => tracing::info!(swept = n, "启动自检：已收口残留 running 工作流执行"),
        Ok(_) => {}
        Err(e) => tracing::error!(error = %e, "启动自检：收口残留 running 工作流执行失败"),
    }

    // 第二道防线：周期自检。即便进程内超时未能收口（运行时被阻塞 / panic 前未更新 run 行等），
    // 也能确保任何 running 在 ~grace 内被收口为 failed，不再出现"越积越多、永不收口"。
    // grace 远大于常规 workflow.timeout_ms，不会误伤真正在跑的长任务；关闭超时时自动放大。
    workflow_handlers::start_stale_run_reaper(pool.clone(), 120, stale_grace);

    // 工作流事件触发器：订阅 EventBus，自动触发 event 类型工作流
    workflow_trigger::start_event_trigger(event_bus.clone(), pool.clone());
    // 工作流 NOTIFY 触发器：按 trigger_type='notify' 的工作流配置 LISTEN 业务库 channel。
    workflow_notify_trigger::start_notify_trigger(pool.clone(), listen_hub.clone());
    workflow_kafka_trigger::start_kafka_trigger(pool.clone());
    workflow_cron_trigger::start_cron_trigger(pool.clone());

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
        max_concurrency: config.scheduler_max_concurrency,
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
    let workflow_exec: scheduler::executors::WorkflowExecutorRef =
        std::sync::Arc::new(scheduler_workflow::WorkflowExecutor::new(pool.clone()));
    let scheduler_runner = std::sync::Arc::new(scheduler::runner::SchedulerRunner::new(
        pool.clone(),
        scheduler_cfg,
        rpc_exec,
        http_exec,
        shell_exec,
        workflow_exec,
    ));
    let scheduler_shutdown = scheduler_runner.shutdown_handle();
    app = app.layer(axum::Extension(scheduler_runner.clone()));
    scheduler_runner.clone().start();

    // 后台守护 Watchdog
    let wd = watchdog::Watchdog::new(pool.clone(), redis.clone());
    let wd_shutdown = wd.shutdown_handle();
    wd.start();

    // 租户池预热 / 保活：把「创建连接池」移出首个用户请求（见
    // docs/superpowers/specs/2026-07-27-tenant-pool-keepalive-design.md）。
    auto_api_handlers::spawn_tenant_pool_prewarm(pool.clone());

    // 副本健康看护任务（运行时自动旁路 + 自动恢复）
    {
        use watchdog::ReplicaWatchdogConfig;
        let env_u64 = |k: &str, default: u64| {
            std::env::var(k)
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(default)
        };
        let env_u32 = |k: &str, default: u32| {
            std::env::var(k)
                .ok()
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(default)
        };
        let env_f64_opt = |k: &str, default: Option<f64>| match std::env::var(k).ok() {
            None => default,
            Some(s) if s.eq_ignore_ascii_case("off") || s.eq_ignore_ascii_case("none") => None,
            Some(s) => s.parse::<f64>().ok().or(default),
        };
        let env_bool =
            |k: &str, default: bool| match std::env::var(k).ok().map(|v| v.to_ascii_lowercase()) {
                Some(s) if s == "false" || s == "0" || s == "no" => false,
                Some(s) if s == "true" || s == "1" || s == "yes" => true,
                _ => default,
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

    // 统一执行日志保留清理：按 EXEC_LOG_RETENTION_HOURS（默认 24h，即"保留一天"）滚动
    // 删除细节日志，按 EXEC_INDEX_RETENTION_DAYS（默认 7d）删除执行索引。常驻后台 task。
    execution_log::spawn_cleanup_task(pool.clone());

    // 平台监控：分钟采样落库 + 阈值告警评估（多实例 advisory lock 互斥）。
    platform_monitor_handlers::spawn_platform_monitor_task(
        pool.clone(),
        redis.clone(),
        cb_manager_for_monitor,
        limiter_for_monitor,
        sse_hub.clone(),
        sse_bridge_metrics.clone(),
    );

    // 细节日志落库层：把请求范围内的执行细节异步批量写入 execution_logs（EXEC_LOG_DB_SINK=off 关闭）。
    logging::start_db_log_sink(pool.clone());

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

        tracing::info!(
            "收到停机信号，开始优雅关闭（最长等待 {}s）...",
            graceful_shutdown_secs
        );

        // 停止 Watchdog
        wd_shutdown.store(false, std::sync::atomic::Ordering::Relaxed);
        // 停止 SchedulerRunner（循环每 tick 自检 running 标志位）
        scheduler_shutdown.store(false, std::sync::atomic::Ordering::Relaxed);

        // 给一个宽限期让正在处理的请求完成
        tokio::time::sleep(Duration::from_secs(graceful_shutdown_secs)).await;
        tracing::info!("优雅关闭完成");
    };

    let addr = format!("{}:{}", config.host, config.port);
    // 构建标记：日志里出现这一行即证明运行的是含「端点触发 detach + 超时诊断」的新二进制。
    // 排查「工作流 30s 被中断」时，先 grep 这行确认部署，再看 workflow 相关的诊断日志。
    tracing::info!(
        build_marker = "workflow_detached_execution+timeout_diagnostics",
        git = option_env!("GIT_COMMIT").unwrap_or("unknown"),
        request_timeout_secs = config.request_timeout_secs,
        workflow_timeout_disabled = workflow_engine::workflow_timeout_disabled(),
        workflow_http_default_secs = workflow_engine::http_default_timeout_secs(),
        "OneBase 构建标记（含工作流超时根治改动）"
    );
    tracing::info!("服务器启动在 http://{}", addr);
    tracing::info!("API 端点: http://{}/api/:schema/:table", addr);
    tracing::info!("健康探针: /health/live (存活) | /health/ready (就绪) | /health (详情)");

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await?;

    Ok(())
}

/// GET /api/license - 授权状态摘要（公开只读，供运维 / 客户查看到期与续保状态）
async fn license_status_handler(
    state: Option<axum::extract::Extension<onebase::license::LicenseState>>,
) -> Json<Value> {
    use serde_json::json;
    match state {
        Some(axum::extract::Extension(s)) => Json(s.summary_json()),
        None => Json(json!({ "status": "unlicensed", "enforcement": "off" })),
    }
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
                "list": "GET /api/v1/{database_slug}/{schema}/{table}",
                "get": "GET /api/v1/{database_slug}/{schema}/{table}/{id}",
                "create": "POST /api/v1/{database_slug}/{schema}/{table}",
                "update": "PATCH /api/v1/{database_slug}/{schema}/{table}/{id}",
                "delete": "DELETE /api/v1/{database_slug}/{schema}/{table}/{id}"
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

#[cfg(test)]
mod sql_type_tests {
    use crate::raw_sql_guard;

    #[test]
    fn get_sql_type_recognizes_postgres_utility_commands() {
        assert_eq!(
            raw_sql_guard::get_sql_type("REFRESH MATERIALIZED VIEW gamesq.member_list_stats_mv"),
            "UTILITY"
        );
        assert_eq!(
            raw_sql_guard::get_sql_type("VACUUM public.orders"),
            "UTILITY"
        );
        assert_eq!(
            raw_sql_guard::get_sql_type("ANALYZE public.orders"),
            "UTILITY"
        );
    }
}

async fn execute_sql_query(
    State(main_pool): State<PgPool>,
    dynamic_pool: Option<axum::extract::Extension<PgPool>>,
    db_id: Option<axum::extract::Extension<middleware::CurrentDatabaseId>>,
    claims: Option<axum::extract::Extension<crate::auth::Claims>>,
    audit_sink: Option<axum::extract::Extension<audit_middleware::AuditDetailSink>>,
    Json(req): Json<SqlQueryRequest>,
) -> Result<Json<Value>, AppError> {
    use serde_json::json;

    let start = std::time::Instant::now();
    let sql = raw_sql_guard::strip_sql_comments(&req.sql);
    if sql.is_empty() {
        return Ok(Json(json!({
            "type": "EMPTY",
            "data": [],
            "row_count": 0,
            "elapsed_ms": start.elapsed().as_millis(),
            "message": "没有可执行的 SQL（内容仅为注释或空白）",
        })));
    }
    let sql_type = raw_sql_guard::get_sql_type(&sql);
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
    if let Err(e) = raw_sql_guard::check_management_references(&sql) {
        push_audit("raw_sql_query_blocked", Some("management_schema_reference"));
        return Err(e);
    }
    if let Err(e) = raw_sql_guard::check_forbidden_session_commands(&sql) {
        push_audit(
            "raw_sql_query_blocked",
            Some("forbidden_listen_unlisten_command"),
        );
        return Err(e);
    }
    if !req.read_only {
        if let Err(e) =
            raw_sql_guard::require_destructive_ack(sql_type, req.acknowledge_destructive)
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
    if raw_sql_guard::is_dangerous_operation(&sql) {
        push_audit("raw_sql_query_blocked", Some("dangerous_keyword_blacklist"));
        return Err(AppError::InvalidQuery(
            "检测到危险操作，请使用专门的管理工具执行此类操作".to_string(),
        ));
    }
    // 拒绝裸事务控制语句（BEGIN / COMMIT / ROLLBACK）。/query 每个请求从池里临时拿一条
    // 连接、执行完就还回去，跨请求的事务控制毫无意义；更要命的是一条裸 `BEGIN` 会让这条
    // 池连接停在「事务进行中」状态被还回去，下一个请求抢到它就报 25P02。需要原子的多步写
    // 请走参数化的 /transaction 接口。
    if sql_type == "TRANSACTION" {
        push_audit("raw_sql_query_blocked", Some("bare_transaction_control"));
        return Err(AppError::InvalidQuery(
            "不支持在 /query 中执行 BEGIN/COMMIT/ROLLBACK 等事务控制语句；需要事务请使用 /transaction 接口".to_string(),
        ));
    }

    // ─── E2：单独 acquire 一条连接，设 statement_timeout，结束 RESET ───
    let policy = raw_sql_guard::policy();
    let mut conn = pool_metrics::acquire_traced(pool, Some(target_db_id), "query")
        .await
        .map_err(AppError::Database)?;
    raw_sql_guard::apply_session_guards(&mut conn, policy).await?;
    let max_rows = policy.max_returned_rows;

    let exec_result: Result<Value, AppError> = match sql_type {
        "SELECT" => {
            let rows = sqlx::query(&sql)
                .fetch_all(&mut *conn)
                .await
                .map_err(raw_sql_guard::map_user_sql_err);
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
            let sql_with_returning = if !sql.to_uppercase().contains("RETURNING") {
                format!("{} RETURNING *", sql.trim().trim_end_matches(';'))
            } else {
                sql.clone()
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
                    let r = sqlx::query(&sql)
                        .execute(&mut *conn)
                        .await
                        .map_err(raw_sql_guard::map_user_sql_err)?;
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
        // 关键修复（连接中毒 / PG 25P02）：必须跑在**已 acquire 的 `conn`** 上、并用
        // sqlx 跟踪的事务（`conn.begin()`）。旧实现用 `execute(pool)` + 裸文本
        // `BEGIN; ...; COMMIT;`：临时连接由 sqlx 自动归还，而 sqlx 并不知道这段文本里
        // 开了事务；一旦中间语句失败，simple query 协议会跳过后面的 `COMMIT`，连接带着
        // "事务已中止"的状态回到池子，下一个抢到它的请求（哪怕是只读的 /structure）就报
        // `current transaction is aborted`。改用 `conn.begin()` 后，失败时 `tx.rollback()`
        // 会把连接清干净再还池；且 `conn` 已 `apply_session_guards`（SET statement_timeout），
        // 无需再拼 `SET LOCAL`。
        "CREATE" | "ALTER" | "DROP" => raw_sql_guard::execute_raw_on_conn(&mut conn, &sql)
            .await
            .map_err(raw_sql_guard::map_user_sql_err)
            .map(|_| {
                json!({
                    "type": sql_type,
                    "data": [],
                    "row_count": 0,
                    "message": format!("{} 操作执行成功", sql_type)
                })
            }),
        _ => raw_sql_guard::execute_raw_on_conn(&mut conn, &sql)
            .await
            .map_err(raw_sql_guard::map_user_sql_err)
            .map(|_| {
                json!({
                    "type": sql_type,
                    "data": [],
                    "row_count": 0,
                    "rows_affected": 0,
                    "message": "操作执行成功"
                })
            }),
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

    // 操作日志打点：原始 SQL 通道。**只记写/DDL**——纯 SELECT 属于"查询"，按产品约定不打点。
    // tenant 由 record_db_op 按 target_db_id 反查；反查不到（管理库/无头）则自动跳过。
    if sql_type != "SELECT" && target_db_id > 0 {
        if let Some(axum::extract::Extension(ref c)) = claims {
            let rows = value
                .get("rows_affected")
                .or_else(|| value.get("row_count"))
                .cloned()
                .unwrap_or(Value::Null);
            let high_risk = matches!(sql_type, "DROP" | "ALTER" | "TRUNCATE");
            operation_log::record_db_op(
                &main_pool,
                target_db_id,
                operation_log::Actor::from_claims(c),
                operation_log::Source::Console,
                operation_log::action::EXECUTE,
                operation_log::resource_type::DATABASE,
                None, // 用数据库连接名兜底
                None,
                format!("执行 SQL（{}）", sql_type),
                operation_log::Status::Success,
                Some(high_risk),
                Some(json!({
                    "v": 1, "kind": "sql",
                    "sql": req.sql,
                    "sql_type": sql_type,
                    "rows": rows,
                })),
                None,
            );
        }
    }
    Ok(Json(value))
}

fn row_to_json_object_select(row: &sqlx::postgres::PgRow) -> Value {
    crate::pg_row_json::pg_row_to_json(row)
}

fn row_to_json_object_write(row: &sqlx::postgres::PgRow) -> Value {
    crate::pg_row_json::pg_row_to_json(row)
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
            if r.ping().await.unwrap_or(false) {
                "healthy"
            } else {
                "unhealthy"
            }
        }
        None => "not_configured",
    };

    let pool_size = pool.size();
    let idle_connections = pool.num_idle();
    let overall = if db_status == "healthy" {
        "healthy"
    } else {
        "unhealthy"
    };

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

    // 就绪探针必须**快速失败**：直接 `execute` 会在连接池耗尽时阻塞到 acquire_timeout
    // （默认 30s），远超探针自身超时，反而放大探测抖动。这里包一层 2s 超时——2s 内拿不到
    // 连接即视为"未就绪"，让上游负载均衡快速摘流，而不是把探针也拖死。
    let db_ok = matches!(
        tokio::time::timeout(
            Duration::from_secs(2),
            sqlx::query("SELECT 1").execute(&pool)
        )
        .await,
        Ok(Ok(_))
    );

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
