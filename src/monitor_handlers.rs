use crate::auth::Claims;
use crate::error::{AppError, Result};
use crate::middleware::CurrentDatabaseId;
use crate::permissions;
use crate::pool_manager::{self, PoolWaterMark, ReplicaWaterMark, POOL_MANAGER};
use crate::pool_metrics;
use axum::{
    extract::{Query, State},
    Extension, Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Row};

/// 选择目标连接池：`dynamic_db_middleware` 注入的优先；没注入回退到管理库。
fn pick_pool<'a>(main: &'a PgPool, dynamic: &'a Option<Extension<PgPool>>) -> &'a PgPool {
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
            AppError::InvalidQuery("缺少 X-Database-Id 请求头，无法定位监控目标数据库".to_string())
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
    let db_size: String =
        sqlx::query_scalar("SELECT pg_size_pretty(pg_database_size(current_database()))")
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
        "SELECT EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::float8",
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
    // pg_namespace 必须放在 pg_class 之前 join，
    // 否则 LEFT JOIN pg_class 仅按 relname 匹配会拉进其他 schema 的同名表，
    // 行数 / 大小都会被错误的同名表覆盖，列表里也会出现重复行。
    let tables = sqlx::query(
        r#"
        SELECT
            schemaname as schema_name,
            tablename as table_name,
            pg_class.reltuples::bigint as row_count,
            pg_size_pretty(pg_total_relation_size(pg_class.oid)) as total_size,
            pg_size_pretty(pg_relation_size(pg_class.oid)) as table_size,
            pg_size_pretty(pg_total_relation_size(pg_class.oid) - pg_relation_size(pg_class.oid)) as index_size
        FROM pg_tables
        JOIN pg_namespace ON pg_namespace.nspname = schemaname
        JOIN pg_class
            ON pg_class.relname = tablename
            AND pg_class.relnamespace = pg_namespace.oid
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY pg_total_relation_size(pg_class.oid) DESC
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
        "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements')",
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
    pub application_name: String,
    pub backend_start: Option<DateTime<Utc>>,
    pub xact_duration_seconds: Option<f64>,
    /// `query ILIKE 'LISTEN%'` —— sqlx PgListener 建连后这条会一直停在 query 列上。
    pub is_listen: bool,
}

#[derive(Debug, Deserialize)]
pub struct ConnectionsQuery {
    /// 为 true 时包含 idle 会话（LISTEN 长期 idle，默认过滤会把它们藏掉）。
    #[serde(default)]
    pub include_idle: bool,
}

/// GET /api/monitor/connections - 获取活动连接
///
/// 鉴权同 `get_slow_queries`：query 列里会暴露正在执行的 SQL 文本，按 owner/admin 收紧。
pub async fn get_active_connections(
    State(main_pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    db_id: Option<Extension<CurrentDatabaseId>>,
    dynamic_pool: Option<Extension<PgPool>>,
    Query(q): Query<ConnectionsQuery>,
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
    // - include_idle=false（默认）保持旧行为：过滤 idle，LISTEN 不在列表里。
    // - include_idle=true：把 LISTEN / 长 idle 事务露出来，LIMIT 提到 100。
    let connections = if q.include_idle {
        sqlx::query(
            r#"
            SELECT
                pid,
                COALESCE(usename, '')                                AS "user",
                COALESCE(datname, '')                                AS database,
                client_addr::text                                    AS client_addr,
                COALESCE(state, '')                                  AS state,
                COALESCE(query, '')                                  AS query,
                EXTRACT(EPOCH FROM (now() - query_start))::float8    AS duration,
                COALESCE(application_name, '')                       AS application_name,
                backend_start,
                EXTRACT(EPOCH FROM (now() - xact_start))::float8     AS xact_duration,
                (COALESCE(query, '') ILIKE 'LISTEN%')                AS is_listen
            FROM pg_stat_activity
            WHERE pid <> pg_backend_pid()
              AND backend_type = 'client backend'
            ORDER BY
                CASE state
                    WHEN 'active' THEN 0
                    WHEN 'idle in transaction' THEN 1
                    WHEN 'idle in transaction (aborted)' THEN 1
                    ELSE 2
                END,
                COALESCE(EXTRACT(EPOCH FROM (now() - query_start)), 0) DESC
            LIMIT 100
            "#,
        )
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query(
            r#"
            SELECT
                pid,
                COALESCE(usename, '')                                AS "user",
                COALESCE(datname, '')                                AS database,
                client_addr::text                                    AS client_addr,
                COALESCE(state, '')                                  AS state,
                COALESCE(query, '')                                  AS query,
                EXTRACT(EPOCH FROM (now() - query_start))::float8    AS duration,
                COALESCE(application_name, '')                       AS application_name,
                backend_start,
                EXTRACT(EPOCH FROM (now() - xact_start))::float8     AS xact_duration,
                (COALESCE(query, '') ILIKE 'LISTEN%')                AS is_listen
            FROM pg_stat_activity
            WHERE pid <> pg_backend_pid()
              AND backend_type = 'client backend'
              AND state IS DISTINCT FROM 'idle'
            ORDER BY
                CASE state
                    WHEN 'active' THEN 0
                    WHEN 'idle in transaction' THEN 1
                    WHEN 'idle in transaction (aborted)' THEN 1
                    ELSE 2
                END,
                COALESCE(EXTRACT(EPOCH FROM (now() - query_start)), 0) DESC
            LIMIT 100
            "#,
        )
        .fetch_all(pool)
        .await?
    };

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
            application_name: row.try_get("application_name").unwrap_or_default(),
            backend_start: row.try_get("backend_start").ok(),
            xact_duration_seconds: row.try_get("xact_duration").ok(),
            is_listen: row.try_get("is_listen").unwrap_or(false),
        })
        .collect();

    Ok(Json(result))
}

/// 锁等待 / 阻塞关系：被阻塞会话 → 阻塞它的会话
///
/// 每一行表示一对「被阻塞 PID」←「阻塞 PID」。前端可据此一键终止持锁进程
/// （复用 `/api/query-perf/active/:pid/cancel`）。
#[derive(Debug, Serialize)]
pub struct LockWait {
    /// 被阻塞（在等锁）的会话 PID
    pub blocked_pid: i32,
    pub blocked_user: String,
    pub blocked_query: String,
    pub blocked_duration_seconds: Option<f64>,
    /// 被阻塞会话正在等待的对象（表/索引名），可能为 NULL（非 relation 级锁）
    pub blocked_relation: Option<String>,
    /// 被阻塞会话申请但未授予的锁模式，如 AccessExclusiveLock
    pub blocked_lock_mode: Option<String>,
    pub wait_event_type: Option<String>,
    pub wait_event: Option<String>,
    /// 持锁、造成阻塞的会话 PID —— 通常就是要被「杀掉」的进程
    pub blocking_pid: i32,
    pub blocking_user: String,
    pub blocking_query: String,
    pub blocking_duration_seconds: Option<f64>,
    pub blocking_state: String,
}

/// GET /api/monitor/locks - 获取当前的锁等待 / 阻塞关系
///
/// 鉴权同其它监控接口（owner/admin 或平台超管）：会暴露被阻塞 / 阻塞双方的 SQL 文本。
/// 用 `pg_blocking_pids()`（PG 9.6+）拿到每个被阻塞会话的直接阻塞者，再各自关联
/// `pg_stat_activity` 取会话信息；relation / lock_mode 从 `pg_locks` 里取未授予的锁。
pub async fn get_lock_waits(
    State(main_pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    db_id: Option<Extension<CurrentDatabaseId>>,
    dynamic_pool: Option<Extension<PgPool>>,
) -> Result<Json<Vec<LockWait>>> {
    require_monitor_access(&main_pool, &claims, db_id).await?;
    let pool = pick_pool(&main_pool, &dynamic_pool);

    let rows = sqlx::query(
        r#"
        SELECT
            blocked.pid                                                   AS blocked_pid,
            COALESCE(blocked.usename, '')                                 AS blocked_user,
            COALESCE(blocked.query, '')                                   AS blocked_query,
            EXTRACT(EPOCH FROM (now() - blocked.query_start))::float8     AS blocked_duration,
            blocked.wait_event_type                                       AS wait_event_type,
            blocked.wait_event                                            AS wait_event,
            (
                SELECT c.relname
                FROM pg_locks l
                JOIN pg_class c ON c.oid = l.relation
                WHERE l.pid = blocked.pid AND NOT l.granted
                LIMIT 1
            )                                                             AS blocked_relation,
            (
                SELECT l.mode
                FROM pg_locks l
                WHERE l.pid = blocked.pid AND NOT l.granted
                LIMIT 1
            )                                                             AS blocked_lock_mode,
            blocking.pid                                                  AS blocking_pid,
            COALESCE(blocking.usename, '')                                AS blocking_user,
            COALESCE(blocking.query, '')                                  AS blocking_query,
            EXTRACT(EPOCH FROM (now() - blocking.query_start))::float8    AS blocking_duration,
            COALESCE(blocking.state, '')                                  AS blocking_state
        FROM pg_stat_activity AS blocked
        JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS bpid(pid) ON TRUE
        JOIN pg_stat_activity AS blocking ON blocking.pid = bpid.pid
        WHERE blocked.pid <> pg_backend_pid()
        ORDER BY blocked_duration DESC NULLS LAST
        LIMIT 100
        "#,
    )
    .fetch_all(pool)
    .await?;

    let result: Vec<LockWait> = rows
        .iter()
        .map(|row| LockWait {
            blocked_pid: row.try_get("blocked_pid").unwrap_or(0),
            blocked_user: row.try_get("blocked_user").unwrap_or_default(),
            blocked_query: row.try_get("blocked_query").unwrap_or_default(),
            blocked_duration_seconds: row.try_get("blocked_duration").ok(),
            blocked_relation: row.try_get("blocked_relation").ok(),
            blocked_lock_mode: row.try_get("blocked_lock_mode").ok(),
            wait_event_type: row.try_get("wait_event_type").ok(),
            wait_event: row.try_get("wait_event").ok(),
            blocking_pid: row.try_get("blocking_pid").unwrap_or(0),
            blocking_user: row.try_get("blocking_user").unwrap_or_default(),
            blocking_query: row.try_get("blocking_query").unwrap_or_default(),
            blocking_duration_seconds: row.try_get("blocking_duration").ok(),
            blocking_state: row.try_get("blocking_state").unwrap_or_default(),
        })
        .collect();

    Ok(Json(result))
}

// ─── 连接池健康诊断 ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ReplicaPoolInfo {
    pub replica_id: i32,
    pub bypassed: bool,
    pub watermark: PoolWaterMark,
}

#[derive(Debug, Serialize)]
pub struct AppPoolInfo {
    pub database_id: i32,
    pub max: u32,
    pub min: u32,
    pub size: u32,
    pub idle: u32,
    pub in_use: u32,
    pub usage_percent: u32,
    pub acquire_timeout_secs: u64,
    /// management.tenant_databases.max_connections（env 覆盖前）
    pub db_configured_max: Option<u32>,
    /// TENANT_DB_MAX_CONNECTIONS 合法值；未设置则为 null
    pub env_override: Option<u32>,
    /// 该库业务池是否已在本进程加载；false 时水位字段为 0
    pub loaded: bool,
    pub replicas: Vec<ReplicaPoolInfo>,
}

#[derive(Debug, Serialize)]
pub struct ListenerInfo {
    pub sse_bridges: i64,
    pub notify_workflows: i64,
    pub dedicated_connections: i64,
}

#[derive(Debug, Serialize)]
pub struct AcquireFailuresInfo {
    /// 进程启动以来的近似总次数（节点埋点 + HTTP 兜底可能双计）
    pub total: u64,
    pub for_this_database: u64,
    pub last_at: Option<DateTime<Utc>>,
    pub recent: Vec<pool_metrics::PoolTimeoutEvent>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PgConnInfo {
    pub max_connections: i32,
    pub instance_backends: i64,
    pub database_backends: i64,
    pub active: i64,
    pub idle: i64,
    pub idle_in_transaction: i64,
    pub idle_in_transaction_aborted: i64,
    pub listen_sessions: i64,
    pub waiting_on_locks: i64,
    pub longest_active_seconds: Option<f64>,
    pub longest_idle_in_transaction_seconds: Option<f64>,
    /// false：因应用池饱和跳过，或短超时未拿到 `pg_stat_activity`；数值不可信。
    pub sampled: bool,
}

impl PgConnInfo {
    fn unknown() -> Self {
        Self {
            max_connections: 0,
            instance_backends: 0,
            database_backends: 0,
            active: 0,
            idle: 0,
            idle_in_transaction: 0,
            idle_in_transaction_aborted: 0,
            listen_sessions: 0,
            waiting_on_locks: 0,
            longest_active_seconds: None,
            longest_idle_in_transaction_seconds: None,
            sampled: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VerdictLevel {
    Ok,
    Warn,
    Critical,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Verdict {
    pub level: VerdictLevel,
    pub summary: String,
    pub hints: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct PoolHealth {
    pub app_pool: AppPoolInfo,
    pub listeners: ListenerInfo,
    pub acquire_failures: AcquireFailuresInfo,
    pub pg: PgConnInfo,
    pub verdict: Verdict,
}

/// `diagnose` 的纯输入 —— 与 IO 解耦，方便单测。
#[derive(Debug, Clone)]
pub struct VerdictInput {
    pub app_max: u32,
    pub app_idle: u32,
    pub app_in_use: u32,
    pub app_loaded: bool,
    pub dedicated_connections: i64,
    pub acquire_failures_for_db: u64,
    pub pg_max: i32,
    pub pg_instance_backends: i64,
    pub longest_idle_in_transaction_seconds: Option<f64>,
    pub waiting_on_locks: i64,
    pub env_override: Option<u32>,
}

/// 按优先级取第一条命中的规则，输出「谁是瓶颈」。
pub fn diagnose(input: &VerdictInput) -> Verdict {
    let app_usage = if input.app_max == 0 {
        0
    } else {
        ((input.app_in_use as u64 * 100) / input.app_max as u64).min(100) as u32
    };
    let pg_usage = if input.pg_max <= 0 {
        0.0
    } else {
        (input.pg_instance_backends as f64 / input.pg_max as f64) * 100.0
    };
    let saturated = input.app_loaded
        && input.app_max > 0
        && input.app_idle == 0
        && input.app_in_use >= input.app_max;

    if saturated {
        let mut hints = vec![
            "先执行 POST /api/monitor/pool-reset?reload=true（监控页「重置连接池」）踢掉打满的进程内池，无需重启 OneBase".into(),
            "去「PG 会话」页找 idle in transaction / 长查询，确认是否有慢 SQL 占连接".into(),
            "确认 WORKFLOW_DB_STATEMENT_TIMEOUT_MS 已生效（默认 30s）".into(),
        ];
        if let Some(env) = input.env_override {
            hints.insert(
                1,
                format!("当前 TENANT_DB_MAX_CONNECTIONS={}，可调大后重启进程", env),
            );
        } else {
            hints.insert(
                1,
                format!(
                    "可设 TENANT_DB_MAX_CONNECTIONS（当前池 max={}）后重启进程抬池",
                    input.app_max
                ),
            );
        }
        let summary = if pg_usage < 50.0 {
            format!(
                "应用连接池已满 ({}/{})，PG 侧健康 ({}/{}) — 瓶颈在 OneBase 池",
                input.app_in_use, input.app_max, input.pg_instance_backends, input.pg_max
            )
        } else {
            format!(
                "应用连接池已满 ({}/{})，且 PG 实例连接偏高 ({}/{})",
                input.app_in_use, input.app_max, input.pg_instance_backends, input.pg_max
            )
        };
        return Verdict {
            level: VerdictLevel::Critical,
            summary,
            hints,
        };
    }

    if pg_usage > 90.0 {
        return Verdict {
            level: VerdictLevel::Critical,
            summary: format!(
                "PostgreSQL 实例连接接近上限 ({}/{}, {:.0}%)",
                input.pg_instance_backends, input.pg_max, pg_usage
            ),
            hints: vec![
                "检查是否有连接泄漏或其它客户端占满 max_connections".into(),
                "在 PG 会话页按耗时排序，终止异常长会话".into(),
            ],
        };
    }

    if let Some(secs) = input.longest_idle_in_transaction_seconds {
        if secs > 60.0 {
            return Verdict {
                level: VerdictLevel::Warn,
                summary: format!(
                    "存在空闲事务占用连接（最长 {:.0}s idle in transaction）",
                    secs
                ),
                hints: vec![
                    "去「PG 会话」页找到 idle in transaction 会话并排查来源".into(),
                    "确认 idle_in_transaction_session_timeout 是否已配置".into(),
                ],
            };
        }
    }

    if input.app_loaded && app_usage >= 80 {
        return Verdict {
            level: VerdictLevel::Warn,
            summary: format!(
                "应用连接池占用偏高 ({}/{}, {}%)",
                input.app_in_use, input.app_max, app_usage
            ),
            hints: vec![
                "关注下方趋势曲线是否持续上升".into(),
                "检查慢查询与 LISTEN 独立连接占比".into(),
            ],
        };
    }

    if input.dedicated_connections >= 20 {
        return Verdict {
            level: VerdictLevel::Warn,
            summary: format!(
                "LISTEN 独立连接偏多（{} 条），建议合并 channel",
                input.dedicated_connections
            ),
            hints: vec!["检查 sse_notify_bridges 与 notify 工作流是否有冗余 channel".into()],
        };
    }

    if input.acquire_failures_for_db > 0 {
        return Verdict {
            level: VerdictLevel::Warn,
            summary: format!(
                "本进程启动以来该库有 {} 次 acquire 超时（近似）",
                input.acquire_failures_for_db
            ),
            hints: vec![
                "结合应用池水位与 PG 会话判断是否仍在发生".into(),
                "开启自动刷新观察趋势".into(),
            ],
        };
    }

    if input.waiting_on_locks > 0 {
        return Verdict {
            level: VerdictLevel::Warn,
            summary: format!("有 {} 个会话在等锁", input.waiting_on_locks),
            hints: vec!["查看 /api/monitor/locks 或查询性能页的锁等待".into()],
        };
    }

    let summary = if input.app_loaded {
        format!(
            "一切正常 — 应用池 {}/{}，PG {}/{}",
            input.app_in_use, input.app_max, input.pg_instance_backends, input.pg_max
        )
    } else {
        "一切正常 — 该库业务池尚未加载（尚无请求命中）".to_string()
    };
    Verdict {
        level: VerdictLevel::Ok,
        summary,
        hints: vec![],
    }
}

/// GET /api/monitor/pool-health — OneBase 业务池 + PG 会话 + 一句话结论
pub async fn get_pool_health(
    State(main_pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    db_id: Option<Extension<CurrentDatabaseId>>,
    dynamic_pool: Option<Extension<PgPool>>,
) -> Result<Json<PoolHealth>> {
    let database_id = require_monitor_access(&main_pool, &claims, db_id).await?;
    // 绝不能回退到管理库：否则 pg_stat_activity 会是平台元数据，结论完全误导。
    let tenant_pool = dynamic_pool.as_ref().map(|Extension(p)| p).ok_or_else(|| {
        AppError::InvalidQuery(
            "无法加载目标数据库连接池，请确认 X-Database-Id 有效且库可连".to_string(),
        )
    })?;

    let db_configured_max: Option<u32> = sqlx::query_scalar(
        "SELECT COALESCE(max_connections, 20)::int FROM management.tenant_databases WHERE id = $1",
    )
    .bind(database_id)
    .fetch_optional(&main_pool)
    .await?
    .map(|v: i32| v.max(0) as u32);

    let env_override = std::env::var("TENANT_DB_MAX_CONNECTIONS")
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .filter(|v| (1..=pool_manager::TENANT_MAX_CONNECTIONS_CAP).contains(v));

    // POOL_MANAGER 命中优先；否则用 middleware 注入的池（同 Arc）读水位。
    let primary = POOL_MANAGER
        .primary_watermark(database_id)
        .or_else(|| Some(pool_manager::watermark(tenant_pool)));
    let replicas: Vec<ReplicaPoolInfo> = POOL_MANAGER
        .replica_watermarks(database_id)
        .into_iter()
        .map(
            |ReplicaWaterMark {
                 replica_id,
                 bypassed,
                 watermark,
             }| ReplicaPoolInfo {
                replica_id,
                bypassed,
                watermark,
            },
        )
        .collect();

    let (loaded, wm) = match primary {
        Some(w) => (true, w),
        None => (
            false,
            PoolWaterMark {
                max: 0,
                min: 0,
                size: 0,
                idle: 0,
                in_use: 0,
                acquire_timeout_secs: 0,
            },
        ),
    };

    let sse_bridges: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM management.sse_notify_bridges \
         WHERE is_active = true AND database_id = $1",
    )
    .bind(database_id)
    .fetch_one(&main_pool)
    .await
    .unwrap_or(0);

    let notify_workflows =
        crate::workflow_notify_trigger::active_listener_count(&main_pool, database_id)
            .await
            .unwrap_or(0) as i64;

    let dedicated_connections = sse_bridges + notify_workflows;

    let metrics = pool_metrics::snapshot();
    let acquire_failures = AcquireFailuresInfo {
        total: metrics.total,
        for_this_database: metrics.for_database(database_id),
        last_at: metrics.last_at,
        recent: metrics
            .recent
            .into_iter()
            .filter(|e| e.database_id.is_none() || e.database_id == Some(database_id))
            .take(10)
            .collect(),
    };

    // 应用池已打满时绝不能再走同一租户池查 pg_stat_activity（会再排队满 acquire_timeout）。
    // 未打满时也包 2s 短超时，避免诊断接口本身成为雪崩放大器。
    const PG_SAMPLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
    let app_saturated = loaded && wm.is_saturated();
    let pg = if app_saturated {
        tracing::warn!(
            database_id,
            "pool-health 跳过 PG 采样：应用池已饱和 {}/{}",
            wm.in_use,
            wm.max
        );
        PgConnInfo::unknown()
    } else {
        let pg_fut = sqlx::query(
            r#"
            SELECT
                (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_conn,
                COUNT(*) FILTER (WHERE backend_type = 'client backend')::bigint AS instance_backends,
                COUNT(*) FILTER (
                    WHERE backend_type = 'client backend'
                      AND datname = current_database()
                )::bigint AS database_backends,
                COUNT(*) FILTER (
                    WHERE backend_type = 'client backend'
                      AND datname = current_database()
                      AND state = 'active'
                )::bigint AS active,
                COUNT(*) FILTER (
                    WHERE backend_type = 'client backend'
                      AND datname = current_database()
                      AND state = 'idle'
                )::bigint AS idle,
                COUNT(*) FILTER (
                    WHERE backend_type = 'client backend'
                      AND datname = current_database()
                      AND state = 'idle in transaction'
                )::bigint AS idle_in_xact,
                COUNT(*) FILTER (
                    WHERE backend_type = 'client backend'
                      AND datname = current_database()
                      AND state = 'idle in transaction (aborted)'
                )::bigint AS idle_in_xact_aborted,
                COUNT(*) FILTER (
                    WHERE backend_type = 'client backend'
                      AND datname = current_database()
                      AND COALESCE(query, '') ILIKE 'LISTEN%'
                )::bigint AS listen_sessions,
                COUNT(*) FILTER (
                    WHERE backend_type = 'client backend'
                      AND datname = current_database()
                      AND wait_event_type = 'Lock'
                )::bigint AS waiting_on_locks,
                (MAX(EXTRACT(EPOCH FROM (now() - query_start))) FILTER (
                    WHERE backend_type = 'client backend'
                      AND datname = current_database()
                      AND state = 'active'
                      AND pid <> pg_backend_pid()
                ))::float8 AS longest_active,
                (MAX(EXTRACT(EPOCH FROM (now() - xact_start))) FILTER (
                    WHERE backend_type = 'client backend'
                      AND datname = current_database()
                      AND state IN ('idle in transaction', 'idle in transaction (aborted)')
                      AND pid <> pg_backend_pid()
                ))::float8 AS longest_idle_in_xact
            FROM pg_stat_activity
            "#,
        )
        .fetch_one(tenant_pool);

        match tokio::time::timeout(PG_SAMPLE_TIMEOUT, pg_fut).await {
            Ok(Ok(pg_row)) => PgConnInfo {
                max_connections: pg_row.try_get("max_conn").unwrap_or(0),
                instance_backends: pg_row.try_get("instance_backends").unwrap_or(0),
                database_backends: pg_row.try_get("database_backends").unwrap_or(0),
                active: pg_row.try_get("active").unwrap_or(0),
                idle: pg_row.try_get("idle").unwrap_or(0),
                idle_in_transaction: pg_row.try_get("idle_in_xact").unwrap_or(0),
                idle_in_transaction_aborted: pg_row.try_get("idle_in_xact_aborted").unwrap_or(0),
                listen_sessions: pg_row.try_get("listen_sessions").unwrap_or(0),
                waiting_on_locks: pg_row.try_get("waiting_on_locks").unwrap_or(0),
                longest_active_seconds: pg_row.try_get("longest_active").ok(),
                longest_idle_in_transaction_seconds: pg_row.try_get("longest_idle_in_xact").ok(),
                sampled: true,
            },
            Ok(Err(e)) => {
                tracing::warn!(database_id, error = %e, "pool-health PG 采样失败");
                PgConnInfo::unknown()
            }
            Err(_) => {
                tracing::warn!(
                    database_id,
                    "pool-health PG 采样超时（{}ms）",
                    PG_SAMPLE_TIMEOUT.as_millis()
                );
                PgConnInfo::unknown()
            }
        }
    };

    let verdict = diagnose(&VerdictInput {
        app_max: wm.max,
        app_idle: wm.idle,
        app_in_use: wm.in_use,
        app_loaded: loaded,
        dedicated_connections,
        acquire_failures_for_db: acquire_failures.for_this_database,
        pg_max: pg.max_connections,
        pg_instance_backends: pg.instance_backends,
        longest_idle_in_transaction_seconds: pg.longest_idle_in_transaction_seconds,
        waiting_on_locks: pg.waiting_on_locks,
        env_override,
    });

    Ok(Json(PoolHealth {
        app_pool: AppPoolInfo {
            database_id,
            max: wm.max,
            min: wm.min,
            size: wm.size,
            idle: wm.idle,
            in_use: wm.in_use,
            usage_percent: wm.usage_percent(),
            acquire_timeout_secs: wm.acquire_timeout_secs,
            db_configured_max,
            env_override,
            loaded,
            replicas,
        },
        listeners: ListenerInfo {
            sse_bridges,
            notify_workflows,
            dedicated_connections,
        },
        acquire_failures,
        pg,
        verdict,
    }))
}

/// POST /api/monitor/pool-reset — 踢掉当前库的进程内业务池，下次请求按配置重建。
///
/// 用于「应用池打满 / acquire 超时」且直连 PG 仍健康时的软恢复：不必重启整个 OneBase。
/// 鉴权与 `pool-health` 相同（`X-Database-Id` + database admin / 超管）。
///
/// Query `reload=true`：踢池后立刻 `ensure_pool_loaded` 预热，避免下一次业务请求冷启动。
#[derive(Debug, Deserialize, Default)]
pub struct PoolResetQuery {
    #[serde(default)]
    pub reload: bool,
}

pub async fn reset_tenant_pool(
    State(main_pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    db_id: Option<Extension<CurrentDatabaseId>>,
    Query(q): Query<PoolResetQuery>,
) -> Result<Json<Value>> {
    let database_id = require_monitor_access(&main_pool, &claims, db_id).await?;
    let before = POOL_MANAGER.primary_watermark(database_id);

    POOL_MANAGER.remove_pool(database_id).await;

    let mut reloaded = false;
    if q.reload {
        crate::auto_api_handlers::ensure_pool_loaded(&main_pool, database_id).await?;
        reloaded = true;
    }

    let after = POOL_MANAGER.primary_watermark(database_id);
    tracing::warn!(
        user = claims.sub,
        database_id,
        was_loaded = before.is_some(),
        reload = reloaded,
        "管理员重置租户连接池"
    );

    Ok(Json(json!({
        "database_id": database_id,
        "was_loaded": before.is_some(),
        "before": before,
        "after": after,
        "reloaded": reloaded,
    })))
}

#[cfg(test)]
mod pool_health_tests {
    use super::*;

    fn base() -> VerdictInput {
        VerdictInput {
            app_max: 50,
            app_idle: 10,
            app_in_use: 5,
            app_loaded: true,
            dedicated_connections: 2,
            acquire_failures_for_db: 0,
            pg_max: 1600,
            pg_instance_backends: 100,
            longest_idle_in_transaction_seconds: None,
            waiting_on_locks: 0,
            env_override: None,
        }
    }

    #[test]
    fn diagnose_ok_when_healthy() {
        let v = diagnose(&base());
        assert_eq!(v.level, VerdictLevel::Ok);
        assert!(v.summary.contains("一切正常"));
    }

    #[test]
    fn diagnose_critical_app_pool_full_pg_healthy() {
        let mut input = base();
        input.app_idle = 0;
        input.app_in_use = 50;
        let v = diagnose(&input);
        assert_eq!(v.level, VerdictLevel::Critical);
        assert!(v.summary.contains("瓶颈在 OneBase 池"));
        assert!(!v.hints.is_empty());
        assert!(
            v.hints.iter().any(|h| h.contains("pool-reset")),
            "饱和 hints 必须指引 pool-reset: {:?}",
            v.hints
        );
    }

    #[test]
    fn diagnose_critical_pg_near_limit() {
        let mut input = base();
        input.pg_instance_backends = 1500;
        let v = diagnose(&input);
        assert_eq!(v.level, VerdictLevel::Critical);
        assert!(v.summary.contains("接近上限"));
    }

    #[test]
    fn diagnose_warn_long_idle_in_xact() {
        let mut input = base();
        input.longest_idle_in_transaction_seconds = Some(120.0);
        let v = diagnose(&input);
        assert_eq!(v.level, VerdictLevel::Warn);
        assert!(v.summary.contains("空闲事务"));
    }

    #[test]
    fn diagnose_warn_app_usage_high() {
        let mut input = base();
        input.app_in_use = 40;
        input.app_idle = 5;
        let v = diagnose(&input);
        assert_eq!(v.level, VerdictLevel::Warn);
        assert!(v.summary.contains("占用偏高"));
    }

    #[test]
    fn diagnose_warn_many_listeners() {
        let mut input = base();
        input.dedicated_connections = 25;
        let v = diagnose(&input);
        assert_eq!(v.level, VerdictLevel::Warn);
        assert!(v.summary.contains("LISTEN"));
    }

    #[test]
    fn diagnose_warn_acquire_failures() {
        let mut input = base();
        input.acquire_failures_for_db = 3;
        let v = diagnose(&input);
        assert_eq!(v.level, VerdictLevel::Warn);
        assert!(v.summary.contains("acquire 超时"));
    }

    #[test]
    fn diagnose_warn_lock_waits() {
        let mut input = base();
        input.waiting_on_locks = 2;
        let v = diagnose(&input);
        assert_eq!(v.level, VerdictLevel::Warn);
        assert!(v.summary.contains("等锁"));
    }

    #[test]
    fn diagnose_saturation_beats_acquire_failures() {
        let mut input = base();
        input.app_idle = 0;
        input.app_in_use = 50;
        input.acquire_failures_for_db = 99;
        let v = diagnose(&input);
        assert_eq!(v.level, VerdictLevel::Critical);
        assert!(v.summary.contains("已满"));
    }
}
