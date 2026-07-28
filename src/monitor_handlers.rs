use crate::auth::Claims;
use crate::error::{AppError, Result};
use crate::middleware::CurrentDatabaseId;
use crate::permissions;
use axum::{
    extract::State,
    Extension, Json,
};
use serde::Serialize;
use sqlx::{PgPool, Row};

/// 选择目标连接池：`dynamic_db_middleware` 注入的优先；没注入回退到管理库。
fn pick_pool<'a>(
    main: &'a PgPool,
    dynamic: &'a Option<Extension<PgPool>>,
) -> &'a PgPool {
    dynamic.as_deref().unwrap_or(main)
}

/// 监控接口统一鉴权：
/// - 必须带 `X-Database-Id`（缺失→400），否则会落到管理库返回平台元数据，绝对不能放出去；
/// - 平台超管或该 db 所属租户的 owner/admin 才能看——这些接口可能泄漏慢查询/活动连接的 SQL
///   文本（带过 WHERE 条件参数），不是普通 viewer 能看到的。
async fn require_monitor_access(
    main_pool: &PgPool,
    claims: &Claims,
    db_id: Option<Extension<CurrentDatabaseId>>,
) -> Result<i32> {
    let database_id = db_id
        .map(|Extension(CurrentDatabaseId(id))| id)
        .ok_or_else(|| {
            AppError::InvalidQuery(
                "缺少 X-Database-Id 请求头，无法定位监控目标数据库".to_string(),
            )
        })?;
    permissions::require_database_admin(main_pool, claims, database_id).await?;
    Ok(database_id)
}

/// 数据库统计信息
#[derive(Debug, Serialize)]
pub struct DatabaseStats {
    pub database_size: String,
    pub table_count: i64,
    pub connection_count: i32,
    pub max_connections: i32,
    pub active_connections: i64,
    pub idle_connections: i64,
    pub cache_hit_ratio: f64,
    pub transaction_count: i64,
    pub uptime_seconds: i64,
}

/// 表大小统计
#[derive(Debug, Serialize)]
pub struct TableSizeInfo {
    pub schema_name: String,
    pub table_name: String,
    pub row_count: i64,
    pub total_size: String,
    pub table_size: String,
    pub index_size: String,
}

/// 慢查询信息
#[derive(Debug, Serialize)]
pub struct SlowQuery {
    pub query: String,
    pub calls: i64,
    pub total_time: f64,
    pub mean_time: f64,
    pub max_time: f64,
}

/// GET /api/monitor/stats - 获取数据库统计信息
///
/// 鉴权：仅平台超管或目标 db 的租户 owner/admin。
/// 之前 `State<PgPool>` 直接用主连接池跑统计是过时实现——路由层挂了
/// `dynamic_db_middleware` 后，租户库的连接池在 `Extension<PgPool>` 里，
/// 必须显式从那里取，否则统计的会是管理库（database_size = management db）。
pub async fn get_database_stats(
    State(main_pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    db_id: Option<Extension<CurrentDatabaseId>>,
    dynamic_pool: Option<Extension<PgPool>>,
) -> Result<Json<DatabaseStats>> {
    require_monitor_access(&main_pool, &claims, db_id).await?;
    let pool = pick_pool(&main_pool, &dynamic_pool);
    let db_size: String = sqlx::query_scalar(
        "SELECT pg_size_pretty(pg_database_size(current_database()))"
    )
    .fetch_one(pool)
    .await?;

    // 表数量
    let table_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')"
    )
    .fetch_one(pool)
    .await?;

    // 连接数信息
    let conn_info = sqlx::query(
        r#"
        SELECT 
            (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') as max_conn,
            COUNT(*) FILTER (WHERE state = 'active') as active,
            COUNT(*) FILTER (WHERE state = 'idle') as idle,
            COUNT(*) as total
        FROM pg_stat_activity
        "#,
    )
    .fetch_one(pool)
    .await?;

    let max_connections: i32 = conn_info.get("max_conn");
    let active_connections: i64 = conn_info.get("active");
    let idle_connections: i64 = conn_info.get("idle");
    let connection_count: i64 = conn_info.get("total");

    // 缓存命中率
    // 注意：sum(bigint) 返回 numeric，numeric/numeric 也是 numeric；
    // sqlx 不会自动把 numeric 解到 f64，所以这里显式 ::float8。
    let cache_stats = sqlx::query(
        r#"
        SELECT
            (sum(blks_hit)::float8
                / NULLIF(sum(blks_hit) + sum(blks_read), 0)::float8) as ratio
        FROM pg_stat_database
        WHERE datname = current_database()
        "#,
    )
    .fetch_one(pool)
    .await?;

    let cache_hit_ratio: Option<f64> = cache_stats.try_get("ratio").ok();

    // 事务数
    let tx_count: i64 = sqlx::query_scalar(
        "SELECT xact_commit + xact_rollback FROM pg_stat_database WHERE datname = current_database()"
    )
    .fetch_one(pool)
    .await?;

    // 运行时间（秒）
    // PostgreSQL 14+ 的 EXTRACT(EPOCH FROM interval) 返回 numeric，
    // 必须显式 ::float8，否则 sqlx 解码到 f64 会报 mismatched types。
    let uptime: f64 = sqlx::query_scalar(
        "SELECT EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::float8"
    )
    .fetch_one(pool)
    .await?;

    Ok(Json(DatabaseStats {
        database_size: db_size,
        table_count,
        connection_count: connection_count as i32,
        max_connections,
        active_connections,
        idle_connections,
        cache_hit_ratio: cache_hit_ratio.unwrap_or(0.0) * 100.0,
        transaction_count: tx_count,
        uptime_seconds: uptime as i64,
    }))
}

/// GET /api/monitor/tables - 获取表大小统计（Top 10）
///
/// 鉴权同 `get_database_stats`：必须带 `X-Database-Id` 且为该 db 的 admin。
/// 否则会落到管理库返回 management schema 的表大小（含 audit_logs 等敏感表）。
pub async fn get_table_sizes(
    State(main_pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    db_id: Option<Extension<CurrentDatabaseId>>,
    dynamic_pool: Option<Extension<PgPool>>,
) -> Result<Json<Vec<TableSizeInfo>>> {
    require_monitor_access(&main_pool, &claims, db_id).await?;
    let pool = pick_pool(&main_pool, &dynamic_pool);
    let tables = sqlx::query(
        r#"
        SELECT
            schemaname as schema_name,
            tablename as table_name,
            pg_class.reltuples::bigint as row_count,
            pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as total_size,
            pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) as table_size,
            pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename) - pg_relation_size(schemaname||'.'||tablename)) as index_size
        FROM pg_tables
        LEFT JOIN pg_class ON pg_class.relname = tablename
        LEFT JOIN pg_namespace ON pg_namespace.nspname = schemaname AND pg_class.relnamespace = pg_namespace.oid
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
        LIMIT 10
        "#,
    )
    .fetch_all(pool)
    .await?;

    let result: Vec<TableSizeInfo> = tables
        .iter()
        .map(|row| TableSizeInfo {
            schema_name: row.get("schema_name"),
            table_name: row.get("table_name"),
            row_count: row.try_get("row_count").unwrap_or(0),
            total_size: row.get("total_size"),
            table_size: row.get("table_size"),
            index_size: row.get("index_size"),
        })
        .collect();

    Ok(Json(result))
}

/// GET /api/monitor/slow-queries - 获取慢查询（需要 pg_stat_statements 扩展）
///
/// 鉴权：仅平台超管或目标 db 的租户 owner/admin。
/// 慢查询里会带原始 SQL 文本（含 WHERE 条件参数），可能泄漏业务数据，所以
/// 这里特意收紧——viewer/member 没资格看，必须升到 owner/admin 才行。
pub async fn get_slow_queries(
    State(main_pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    db_id: Option<Extension<CurrentDatabaseId>>,
    dynamic_pool: Option<Extension<PgPool>>,
) -> Result<Json<Vec<SlowQuery>>> {
    require_monitor_access(&main_pool, &claims, db_id).await?;
    let pool = pick_pool(&main_pool, &dynamic_pool);

    // 检查 pg_stat_statements 是否已启用
    let extension_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements')"
    )
    .fetch_one(pool)
    .await?;

    if !extension_exists {
        return Ok(Json(vec![]));
    }

    let queries = sqlx::query(
        r#"
        SELECT
            query,
            calls,
            total_exec_time as total_time,
            mean_exec_time as mean_time,
            max_exec_time as max_time
        FROM pg_stat_statements
        WHERE query NOT LIKE '%pg_stat_statements%'
        ORDER BY mean_exec_time DESC
        LIMIT 10
        "#,
    )
    .fetch_all(pool)
    .await;

    match queries {
        Ok(rows) => {
            let result: Vec<SlowQuery> = rows
                .iter()
                .map(|row| SlowQuery {
                    query: row.get("query"),
                    calls: row.get("calls"),
                    total_time: row.get("total_time"),
                    mean_time: row.get("mean_time"),
                    max_time: row.get("max_time"),
                })
                .collect();
            Ok(Json(result))
        }
        Err(_) => {
            // 如果查询失败（可能是权限问题），返回空列表
            Ok(Json(vec![]))
        }
    }
}

/// 活动连接信息
#[derive(Debug, Serialize)]
pub struct ActiveConnection {
    pub pid: i32,
    pub user: String,
    pub database: String,
    pub client_addr: Option<String>,
    pub state: String,
    pub query: String,
    pub duration_seconds: Option<f64>,
}

/// GET /api/monitor/connections - 获取活动连接
///
/// 鉴权同 `get_slow_queries`：query 列里会暴露正在执行的 SQL 文本，按 owner/admin 收紧。
pub async fn get_active_connections(
    State(main_pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    db_id: Option<Extension<CurrentDatabaseId>>,
    dynamic_pool: Option<Extension<PgPool>>,
) -> Result<Json<Vec<ActiveConnection>>> {
    require_monitor_access(&main_pool, &claims, db_id).await?;
    let pool = pick_pool(&main_pool, &dynamic_pool);
    // 关于这条 SQL 的几个注意事项：
    // - pg_stat_activity 里后台 worker（autovacuum launcher / parallel worker /
    //   walwriter 等）的 usename / datname / state / query 都可能是 NULL，所以
    //   下面用 COALESCE 兜底，避免 sqlx 把 NULL 解到 String 时 panic。
    // - EXTRACT(EPOCH FROM interval) 在 PG 14+ 返回 numeric，必须 ::float8，
    //   否则 sqlx 解到 f64 会报 mismatched types。
    // - WHERE 多加一条 backend_type = 'client backend'，这样只看真正的用户会话，
    //   不被后台进程刷屏。
    let connections = sqlx::query(
        r#"
        SELECT
            pid,
            COALESCE(usename, '')                                AS "user",
            COALESCE(datname, '')                                AS database,
            client_addr::text                                    AS client_addr,
            COALESCE(state, '')                                  AS state,
            COALESCE(query, '')                                  AS query,
            EXTRACT(EPOCH FROM (now() - query_start))::float8    AS duration
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND backend_type = 'client backend'
          AND state IS DISTINCT FROM 'idle'
        ORDER BY query_start DESC NULLS LAST
        LIMIT 20
        "#,
    )
    .fetch_all(pool)
    .await?;

    let result: Vec<ActiveConnection> = connections
        .iter()
        .map(|row| ActiveConnection {
            pid: row.try_get("pid").unwrap_or(0),
            user: row.try_get("user").unwrap_or_default(),
            database: row.try_get("database").unwrap_or_default(),
            client_addr: row.try_get("client_addr").ok(),
            state: row.try_get("state").unwrap_or_default(),
            query: row.try_get("query").unwrap_or_default(),
            duration_seconds: row.try_get("duration").ok(),
        })
        .collect();

    Ok(Json(result))
}

