//! 查询性能 / 慢查询日志 (Query Performance & Slow Query Log)
//!
//! 这两个能力都建立在 PostgreSQL 的 `pg_stat_statements` 扩展和 `pg_stat_activity`
//! 系统视图之上：
//!
//! - `查询性能` 页面：直接浏览 `pg_stat_statements` 的聚合统计（每条 SQL 的调用次数、
//!   平均/总/最大耗时、命中率、返回行数等），并允许按多列排序、文本过滤、分页。
//! - `慢查询日志` 页面：三条数据来源拼起来——
//!     1. 从 `pg_stat_statements` 里挑 mean_exec_time 超过阈值的；
//!     2. 当前 `pg_stat_activity` 里跑得很久还没结束的（实时杀死功能在这里）；
//!     3. 应用层的 `management.slow_query_logs`（已有 audit_handlers 暴露），前端直接复用。
//!
//! 所有路由都走 `dynamic_db_middleware`，按租户切到目标数据库；
//! 普通租户用户只要拥有该数据库下任意 schema 的 `SELECT` 权限即可读取统计；
//! 重置统计、取消他人查询这两个破坏性操作要求超管。

use crate::auth::Claims;
use crate::error::{AppError, Result};
use crate::middleware::CurrentDatabaseId;
use crate::rbac_handlers::is_superadmin;
use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{PgPool, Row};

// ---------------- 共用工具 ----------------

/// 选择目标连接池：`dynamic_db_middleware` 注入的优先；没注入回退到管理库——
/// 这种情况只会发生在调用方没带 `X-Database-Id` 头时，handler 一般会拒绝，但兜底有备无患。
fn pick_pool<'a>(
    main: &'a PgPool,
    dynamic: &'a Option<Extension<PgPool>>,
) -> &'a PgPool {
    dynamic.as_deref().unwrap_or(main)
}

/// 必须带 `X-Database-Id`；否则返回 400，避免在管理库上跑 `pg_stat_statements_reset()` 这种事。
fn require_database_id(opt: Option<Extension<CurrentDatabaseId>>) -> Result<i32> {
    opt.map(|Extension(CurrentDatabaseId(id))| id).ok_or_else(|| {
        AppError::InvalidQuery(
            "缺少 X-Database-Id 请求头，无法定位目标数据库".to_string(),
        )
    })
}

/// 普通用户读取统计要求：在该数据库下至少能"读到一张表"。这里不绑定到具体 table，
/// 而是查 `management.permissions` 看是否有任何 `SELECT`/`ALL` 资格。超管直接放行。
async fn require_db_read(
    main_pool: &PgPool,
    user_id: i32,
    database_id: i32,
) -> Result<()> {
    if is_superadmin(main_pool, user_id).await.unwrap_or(false) {
        return Ok(());
    }
    let count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::BIGINT
        FROM management.permissions p
        JOIN management.role_permissions rp ON rp.permission_id = p.id
        JOIN management.user_roles ur       ON ur.role_id = rp.role_id
        JOIN management.tenant_databases td ON td.tenant_id = ur.tenant_id
        WHERE ur.user_id = $1
          AND td.id = $2
          AND (p.action = 'SELECT' OR p.action = 'ALL')
        "#,
    )
    .bind(user_id)
    .bind(database_id)
    .fetch_one(main_pool)
    .await
    .map_err(|e| AppError::Internal(format!("权限查询失败: {}", e)))?;

    if count == 0 {
        return Err(AppError::Forbidden(
            "没有权限查看该数据库的查询统计".to_string(),
        ));
    }
    Ok(())
}

// ---------------- 扩展安装状态 ----------------

#[derive(Debug, Serialize)]
pub struct ExtensionStatus {
    /// 是否已经在当前数据库 `CREATE EXTENSION` 完毕
    pub installed: bool,
    /// 是否在 `pg_available_extensions` 里——即所在的 PostgreSQL 是否带了这个扩展
    pub available: bool,
    /// 当前装的版本（installed=false 时为 null）
    pub version: Option<String>,
    /// 给前端展示的"如何启用"提示，已经按当前状态预生成；前端可直接展示
    pub install_hint: Option<String>,
    /// 是否需要 shared_preload_libraries（pg_stat_statements 必须先在配置里加上才能 CREATE EXTENSION）
    pub shared_preload: Option<String>,
}

/// GET /api/query-perf/extension
pub async fn get_extension_status(
    State(main_pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    db_id_ext: Option<Extension<CurrentDatabaseId>>,
    dynamic_pool: Option<Extension<PgPool>>,
) -> Result<Json<ExtensionStatus>> {
    let database_id = require_database_id(db_id_ext)?;
    require_db_read(&main_pool, claims.sub, database_id).await?;

    let pool = pick_pool(&main_pool, &dynamic_pool);

    let row = sqlx::query(
        r#"
        SELECT
            EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements')          AS installed,
            EXISTS(SELECT 1 FROM pg_available_extensions WHERE name = 'pg_stat_statements')  AS available,
            (SELECT extversion FROM pg_extension WHERE extname = 'pg_stat_statements')       AS version,
            current_setting('shared_preload_libraries', true)                                AS shared_preload
        "#,
    )
    .fetch_one(pool)
    .await?;

    let installed: bool = row.get("installed");
    let available: bool = row.get("available");
    let version: Option<String> = row.try_get("version").ok();
    let shared_preload: Option<String> = row.try_get("shared_preload").ok();

    let install_hint = if installed {
        None
    } else if available {
        Some(
            "扩展已可用但尚未启用：先确保 `shared_preload_libraries` 包含 \
             `pg_stat_statements`（修改 postgresql.conf 后需重启），再用超管账号在本数据库执行 \
             `CREATE EXTENSION pg_stat_statements;`。"
                .to_string(),
        )
    } else {
        Some(
            "当前 PostgreSQL 服务端未提供 pg_stat_statements。请安装 \
             `postgresql-contrib` 包（或对应版本的 contrib 模块），加到 \
             `shared_preload_libraries`，重启后再启用扩展。"
                .to_string(),
        )
    };

    Ok(Json(ExtensionStatus {
        installed,
        available,
        version,
        install_hint,
        shared_preload,
    }))
}

// ---------------- pg_stat_statements 列表 ----------------

#[derive(Debug, Serialize)]
pub struct StatementStat {
    pub queryid: Option<i64>,
    pub query: String,
    pub calls: i64,
    /// 单位：毫秒
    pub total_exec_time: f64,
    pub mean_exec_time: f64,
    pub min_exec_time: f64,
    pub max_exec_time: f64,
    pub stddev_exec_time: f64,
    pub rows: i64,
    pub shared_blks_hit: i64,
    pub shared_blks_read: i64,
    /// shared 缓冲区命中率：hit / (hit + read)，0~1
    pub hit_ratio: f64,
}

#[derive(Debug, Deserialize)]
pub struct StatementsQuery {
    /// 排序列：mean_exec_time(默认) | total_exec_time | calls | rows | max_exec_time
    pub order_by: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub min_calls: Option<i64>,
    pub min_mean_ms: Option<f64>,
    /// SQL 文本模糊搜索（ILIKE）
    pub search: Option<String>,
}

fn whitelist_order(order: &Option<String>) -> &'static str {
    match order.as_deref() {
        Some("total_exec_time") => "total_exec_time",
        Some("calls") => "calls",
        Some("rows") => "rows",
        Some("max_exec_time") => "max_exec_time",
        _ => "mean_exec_time",
    }
}

fn translate_pg_stat_error(e: sqlx::Error) -> AppError {
    let msg = e.to_string();
    if msg.contains("does not exist") || msg.contains("undefined_table") {
        AppError::InvalidQuery(
            "pg_stat_statements 扩展未启用，无法读取查询统计。请先在该数据库 \
             CREATE EXTENSION pg_stat_statements；详见扩展状态接口。"
                .to_string(),
        )
    } else {
        AppError::Database(e)
    }
}

/// GET /api/query-perf/statements
pub async fn list_statements(
    State(main_pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    db_id_ext: Option<Extension<CurrentDatabaseId>>,
    Query(q): Query<StatementsQuery>,
    dynamic_pool: Option<Extension<PgPool>>,
) -> Result<Json<Vec<StatementStat>>> {
    let database_id = require_database_id(db_id_ext)?;
    require_db_read(&main_pool, claims.sub, database_id).await?;

    let pool = pick_pool(&main_pool, &dynamic_pool);

    let order = whitelist_order(&q.order_by);
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let offset = q.offset.unwrap_or(0).max(0);
    let min_calls = q.min_calls.unwrap_or(1).max(0);
    let min_mean = q.min_mean_ms.unwrap_or(0.0).max(0.0);
    let search = q.search.unwrap_or_default();

    // ORDER BY 列名是白名单常量字符串，可以放心 format!；其它输入都走 bind。
    let sql = format!(
        r#"
        SELECT
            queryid,
            query,
            calls,
            total_exec_time,
            mean_exec_time,
            min_exec_time,
            max_exec_time,
            stddev_exec_time,
            rows,
            shared_blks_hit,
            shared_blks_read,
            CASE WHEN (shared_blks_hit + shared_blks_read) = 0 THEN 0
                 ELSE shared_blks_hit::float8 / (shared_blks_hit + shared_blks_read)
            END AS hit_ratio
        FROM pg_stat_statements
        WHERE calls >= $1
          AND mean_exec_time >= $2
          AND ($3 = '' OR query ILIKE '%' || $3 || '%')
          AND query NOT LIKE '%pg_stat_statements%'
        ORDER BY {} DESC NULLS LAST
        LIMIT $4 OFFSET $5
        "#,
        order
    );

    let rows = sqlx::query(&sql)
        .bind(min_calls)
        .bind(min_mean)
        .bind(&search)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await
        .map_err(translate_pg_stat_error)?;

    let result = rows
        .into_iter()
        .map(|r| StatementStat {
            queryid: r.try_get("queryid").ok(),
            query: r.try_get("query").unwrap_or_default(),
            calls: r.try_get("calls").unwrap_or_default(),
            total_exec_time: r.try_get("total_exec_time").unwrap_or_default(),
            mean_exec_time: r.try_get("mean_exec_time").unwrap_or_default(),
            min_exec_time: r.try_get("min_exec_time").unwrap_or_default(),
            max_exec_time: r.try_get("max_exec_time").unwrap_or_default(),
            stddev_exec_time: r.try_get("stddev_exec_time").unwrap_or_default(),
            rows: r.try_get("rows").unwrap_or_default(),
            shared_blks_hit: r.try_get("shared_blks_hit").unwrap_or_default(),
            shared_blks_read: r.try_get("shared_blks_read").unwrap_or_default(),
            hit_ratio: r.try_get("hit_ratio").unwrap_or_default(),
        })
        .collect();

    Ok(Json(result))
}

// ---------------- 重置统计 ----------------

/// POST /api/query-perf/statements/reset
///
/// 调 `pg_stat_statements_reset()`，对当前数据库的统计计数清零。
/// 仅超管可用，避免普通用户互相清掉对方需要的样本。
pub async fn reset_statements(
    State(main_pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    db_id_ext: Option<Extension<CurrentDatabaseId>>,
    dynamic_pool: Option<Extension<PgPool>>,
) -> Result<Json<serde_json::Value>> {
    require_database_id(db_id_ext)?;
    if !is_superadmin(&main_pool, claims.sub).await.unwrap_or(false) {
        return Err(AppError::Forbidden(
            "仅平台超级管理员可以重置 pg_stat_statements 统计".to_string(),
        ));
    }

    let pool = pick_pool(&main_pool, &dynamic_pool);
    sqlx::query("SELECT pg_stat_statements_reset()")
        .execute(pool)
        .await
        .map_err(translate_pg_stat_error)?;

    Ok(Json(json!({ "ok": true })))
}

// ---------------- 实时活跃查询 ----------------

#[derive(Debug, Serialize)]
pub struct ActiveQuery {
    pub pid: i32,
    pub user: String,
    pub database: String,
    pub client_addr: Option<String>,
    pub application_name: String,
    pub state: String,
    pub query: String,
    /// 自 query_start 以来的秒数
    pub duration_seconds: f64,
    pub wait_event_type: Option<String>,
    pub wait_event: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ActiveQueryParams {
    /// 只返回执行时长超过该毫秒数的查询；默认 0 = 全部
    pub min_duration_ms: Option<i64>,
    pub limit: Option<i64>,
}

/// GET /api/query-perf/active
pub async fn list_active_queries(
    State(main_pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    db_id_ext: Option<Extension<CurrentDatabaseId>>,
    Query(q): Query<ActiveQueryParams>,
    dynamic_pool: Option<Extension<PgPool>>,
) -> Result<Json<Vec<ActiveQuery>>> {
    let database_id = require_database_id(db_id_ext)?;
    require_db_read(&main_pool, claims.sub, database_id).await?;

    let pool = pick_pool(&main_pool, &dynamic_pool);
    let min_ms = q.min_duration_ms.unwrap_or(0).max(0);
    let limit = q.limit.unwrap_or(100).clamp(1, 500);

    // 注意：
    // - usename / datname / state / query / wait_event 在后台进程中可能为 NULL，
    //   COALESCE / try_get 兜底，避免 sqlx 解码 panic。
    // - PG 14+ 的 EXTRACT(EPOCH FROM interval) 返回 numeric，必须显式 ::float8。
    // - 限定 backend_type='client backend' 过滤 autovacuum/walwriter 等后台 worker。
    let rows = sqlx::query(
        r#"
        SELECT
            pid,
            COALESCE(usename, '')           AS "user",
            COALESCE(datname, '')           AS database,
            client_addr::text               AS client_addr,
            COALESCE(application_name, '')  AS application_name,
            COALESCE(state, '')             AS state,
            COALESCE(query, '')             AS query,
            EXTRACT(EPOCH FROM (now() - query_start))::float8 AS duration,
            wait_event_type,
            wait_event
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND backend_type = 'client backend'
          AND query_start IS NOT NULL
          AND state IS DISTINCT FROM 'idle'
          AND EXTRACT(EPOCH FROM (now() - query_start)) * 1000 >= $1
        ORDER BY query_start ASC
        LIMIT $2
        "#,
    )
    .bind(min_ms)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    let result = rows
        .into_iter()
        .map(|r| ActiveQuery {
            pid: r.try_get("pid").unwrap_or(0),
            user: r.try_get("user").unwrap_or_default(),
            database: r.try_get("database").unwrap_or_default(),
            client_addr: r.try_get("client_addr").ok(),
            application_name: r.try_get("application_name").unwrap_or_default(),
            state: r.try_get("state").unwrap_or_default(),
            query: r.try_get("query").unwrap_or_default(),
            duration_seconds: r.try_get("duration").unwrap_or_default(),
            wait_event_type: r.try_get("wait_event_type").ok(),
            wait_event: r.try_get("wait_event").ok(),
        })
        .collect();

    Ok(Json(result))
}

// ---------------- 取消 / 终止查询 ----------------

#[derive(Debug, Deserialize)]
pub struct CancelQueryParams {
    /// true → `pg_terminate_backend`（断开整条连接）；false（默认）→ `pg_cancel_backend`（仅取消当前查询）
    pub terminate: Option<bool>,
}

/// POST /api/query-perf/active/:pid/cancel
pub async fn cancel_active_query(
    State(main_pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    db_id_ext: Option<Extension<CurrentDatabaseId>>,
    Path(pid): Path<i32>,
    Query(p): Query<CancelQueryParams>,
    dynamic_pool: Option<Extension<PgPool>>,
) -> Result<Json<serde_json::Value>> {
    require_database_id(db_id_ext)?;
    if !is_superadmin(&main_pool, claims.sub).await.unwrap_or(false) {
        return Err(AppError::Forbidden(
            "仅平台超级管理员可以取消其他用户的查询".to_string(),
        ));
    }

    let pool = pick_pool(&main_pool, &dynamic_pool);
    let terminate = p.terminate.unwrap_or(false);

    let success: bool = if terminate {
        sqlx::query_scalar("SELECT pg_terminate_backend($1)")
            .bind(pid)
            .fetch_one(pool)
            .await?
    } else {
        sqlx::query_scalar("SELECT pg_cancel_backend($1)")
            .bind(pid)
            .fetch_one(pool)
            .await?
    };

    Ok(Json(json!({
        "ok": success,
        "pid": pid,
        "terminated": terminate,
    })))
}
