//! `pg_stat_statements` 探测与 SQL 兼容层。
//!
//! 扩展页的「已安装」只表示 `CREATE EXTENSION` 成功。监控要真正读到数据，还要求：
//! 1. `shared_preload_libraries` 已加载该库（否则视图在但查询报错）；
//! 2. `search_path` 能解析到扩展所在 schema（否则 `FROM pg_stat_statements` 像没装）；
//! 3. PG12 用 `mean_time`，PG13+ 用 `mean_exec_time`。

use crate::error::{AppError, Result};
use sqlx::{PgPool, Row};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeColumns {
    pub total: &'static str,
    pub mean: &'static str,
    pub min: &'static str,
    pub max: &'static str,
    pub stddev: &'static str,
}

pub const EXEC_TIME_COLUMNS: TimeColumns = TimeColumns {
    total: "total_exec_time",
    mean: "mean_exec_time",
    min: "min_exec_time",
    max: "max_exec_time",
    stddev: "stddev_exec_time",
};

pub const LEGACY_TIME_COLUMNS: TimeColumns = TimeColumns {
    total: "total_time",
    mean: "mean_time",
    min: "min_time",
    max: "max_time",
    stddev: "stddev_time",
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PgStatView {
    pub schema: String,
    pub qualified: String,
    pub columns: TimeColumns,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PgStatErrorKind {
    NotInstalled,
    NotLoaded,
    PermissionDenied,
    Other,
}

pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

pub fn library_preloaded(shared_preload: Option<&str>) -> bool {
    shared_preload.unwrap_or("").split(',').any(|part| {
        let token = part.trim().trim_matches('"');
        token == "pg_stat_statements" || token.ends_with("/pg_stat_statements")
    })
}

pub fn classify_pg_stat_error(msg: &str) -> PgStatErrorKind {
    let lower = msg.to_ascii_lowercase();
    if lower.contains("must be loaded via shared_preload_libraries") {
        PgStatErrorKind::NotLoaded
    } else if lower.contains("permission denied") {
        PgStatErrorKind::PermissionDenied
    } else if lower.contains("does not exist")
        || lower.contains("undefined_table")
        || lower.contains("undefined_column")
    {
        PgStatErrorKind::NotInstalled
    } else {
        PgStatErrorKind::Other
    }
}

pub fn translate_pg_stat_error(e: sqlx::Error) -> AppError {
    match classify_pg_stat_error(&e.to_string()) {
        PgStatErrorKind::NotLoaded => AppError::InvalidQuery(
            "pg_stat_statements 扩展对象已存在，但未通过 shared_preload_libraries 加载。\
             请把 pg_stat_statements 写入 shared_preload_libraries 并重启 PostgreSQL。"
                .to_string(),
        ),
        PgStatErrorKind::PermissionDenied => AppError::Forbidden(
            "当前数据库用户无权读取 pg_stat_statements。请授予 pg_read_all_stats，\
             或对该视图执行 GRANT SELECT。"
                .to_string(),
        ),
        PgStatErrorKind::NotInstalled => AppError::InvalidQuery(
            "无法读取 pg_stat_statements。请确认已在该数据库执行 CREATE EXTENSION，\
             且连接的 search_path 包含扩展所在 schema。"
                .to_string(),
        ),
        PgStatErrorKind::Other => AppError::Database(e),
    }
}

pub fn order_column(order: Option<&str>, cols: &TimeColumns) -> &'static str {
    match order {
        Some("total_exec_time") | Some("total_time") => cols.total,
        Some("max_exec_time") | Some("max_time") => cols.max,
        Some("calls") => "calls",
        Some("rows") => "rows",
        _ => cols.mean,
    }
}

pub fn track_is_none(track: Option<&str>) -> bool {
    track
        .map(|s| s.trim().eq_ignore_ascii_case("none"))
        .unwrap_or(false)
}

pub fn extension_hint(
    installed: bool,
    available: bool,
    loaded: bool,
    readable: bool,
    shared_preload: Option<&str>,
    track: Option<&str>,
    row_count: Option<i64>,
) -> Option<String> {
    if installed && !loaded {
        return Some(format!(
            "扩展已 CREATE，但 shared_preload_libraries 未加载 pg_stat_statements（当前：{}）。\
             写入该库并重启 PostgreSQL 后才会采集统计。",
            shared_preload.unwrap_or("(空)")
        ));
    }
    if installed && !readable {
        return Some(
            "扩展已安装，但当前连接用户无法读取 pg_stat_statements（缺 GRANT SELECT 或 pg_read_all_stats）。"
                .to_string(),
        );
    }
    if installed && loaded && readable && track_is_none(track) {
        return Some(
            "pg_stat_statements.track 当前为 none，扩展在但不会采集任何 SQL。\
             请改为 top 或 all（云厂商通常在参数组里改，改完一般不用重启）。"
                .to_string(),
        );
    }
    if installed && loaded && readable && row_count == Some(0) {
        return Some(
            "视图能读但一行统计都没有。请确认 pg_stat_statements.track 不是 none，\
             并在启用采集之后执行过业务 SQL（历史慢查询不会回溯进来）。"
                .to_string(),
        );
    }
    if installed && readable && loaded {
        return None;
    }
    if available {
        return Some(
            "扩展已可用但尚未启用：先确保 shared_preload_libraries 包含 \
             pg_stat_statements（修改后需重启），再在本数据库执行 \
             CREATE EXTENSION pg_stat_statements;"
                .to_string(),
        );
    }
    Some(
        "当前 PostgreSQL 未提供 pg_stat_statements。请安装 postgresql-contrib，\
         加入 shared_preload_libraries，重启后再启用扩展。"
            .to_string(),
    )
}

async fn has_exec_time_columns(pool: &PgPool, schema: &str) -> Result<bool> {
    let found: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1
              AND c.relname = 'pg_stat_statements'
              AND a.attname = 'mean_exec_time'
              AND NOT a.attisdropped
        )
        "#,
    )
    .bind(schema)
    .fetch_one(pool)
    .await?;
    Ok(found)
}

pub async fn resolve_view(pool: &PgPool) -> Result<Option<PgStatView>> {
    let schema: Option<String> = sqlx::query_scalar(
        r#"
        SELECT n.nspname
        FROM pg_extension e
        JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname = 'pg_stat_statements'
        "#,
    )
    .fetch_optional(pool)
    .await?;

    let Some(schema) = schema else {
        return Ok(None);
    };

    let columns = if has_exec_time_columns(pool, &schema).await? {
        EXEC_TIME_COLUMNS
    } else {
        LEGACY_TIME_COLUMNS
    };

    Ok(Some(PgStatView {
        qualified: format!(
            "{}.{}",
            quote_ident(&schema),
            quote_ident("pg_stat_statements")
        ),
        schema,
        columns,
    }))
}

pub async fn probe_readable(pool: &PgPool, view: &PgStatView) -> bool {
    let sql = format!("SELECT 1 FROM {} LIMIT 1", view.qualified);
    sqlx::query(&sql).fetch_optional(pool).await.is_ok()
}

/// 当前库上 `pg_stat_statements` 的运行时采集参数与可见行数。
#[derive(Debug, Clone, Default)]
pub struct PgStatRuntime {
    pub track: Option<String>,
    pub row_count: Option<i64>,
    pub current_user: Option<String>,
    pub is_superuser: bool,
    pub has_pg_read_all_stats: bool,
}

pub async fn probe_runtime(pool: &PgPool, view: Option<&PgStatView>) -> PgStatRuntime {
    let mut runtime = PgStatRuntime::default();

    if let Ok(row) = sqlx::query(
        r#"
        SELECT
            current_setting('pg_stat_statements.track', true) AS track,
            current_user::text AS session_user_name,
            COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS is_superuser,
            EXISTS (
                SELECT 1 FROM pg_roles r
                WHERE r.rolname = 'pg_read_all_stats'
                  AND pg_has_role(current_user, r.oid, 'MEMBER')
            ) AS has_pg_read_all_stats
        "#,
    )
    .fetch_one(pool)
    .await
    {
        runtime.track = row.try_get("track").ok();
        runtime.current_user = row.try_get("session_user_name").ok();
        runtime.is_superuser = row.try_get("is_superuser").unwrap_or(false);
        runtime.has_pg_read_all_stats = row.try_get("has_pg_read_all_stats").unwrap_or(false);
    } else if let Ok(track) = sqlx::query_scalar::<_, Option<String>>(
        "SELECT current_setting('pg_stat_statements.track', true)",
    )
    .fetch_one(pool)
    .await
    {
        runtime.track = track;
    }

    if let Some(view) = view {
        let sql = format!("SELECT COUNT(*)::bigint FROM {}", view.qualified);
        runtime.row_count = sqlx::query_scalar(&sql).fetch_one(pool).await.ok();
    }

    runtime
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_ident_escapes_embedded_quotes() {
        assert_eq!(quote_ident("public"), "\"public\"");
        assert_eq!(quote_ident("weird\"name"), "\"weird\"\"name\"");
    }

    #[test]
    fn library_preloaded_accepts_common_guc_shapes() {
        assert!(!library_preloaded(None));
        assert!(!library_preloaded(Some("")));
        assert!(!library_preloaded(Some("auto_explain")));
        assert!(library_preloaded(Some("pg_stat_statements")));
        assert!(library_preloaded(Some("pg_stat_statements, auto_explain")));
        assert!(library_preloaded(Some("auto_explain, pg_stat_statements")));
        assert!(library_preloaded(Some(" $libdir/pg_stat_statements ")));
        assert!(library_preloaded(Some("\"pg_stat_statements\"")));
        assert!(!library_preloaded(Some("pg_stat_kcache")));
    }

    #[test]
    fn classify_error_distinguishes_not_loaded_from_missing() {
        assert_eq!(
            classify_pg_stat_error(
                "ERROR: pg_stat_statements must be loaded via shared_preload_libraries"
            ),
            PgStatErrorKind::NotLoaded
        );
        assert_eq!(
            classify_pg_stat_error("ERROR: relation \"pg_stat_statements\" does not exist"),
            PgStatErrorKind::NotInstalled
        );
        assert_eq!(
            classify_pg_stat_error("ERROR: permission denied for view pg_stat_statements"),
            PgStatErrorKind::PermissionDenied
        );
        assert_eq!(
            classify_pg_stat_error("connection reset"),
            PgStatErrorKind::Other
        );
    }

    #[test]
    fn order_column_maps_api_names_onto_actual_pg_columns() {
        assert_eq!(
            order_column(Some("total_exec_time"), &LEGACY_TIME_COLUMNS),
            "total_time"
        );
        assert_eq!(
            order_column(Some("max_time"), &EXEC_TIME_COLUMNS),
            "max_exec_time"
        );
        assert_eq!(order_column(Some("calls"), &EXEC_TIME_COLUMNS), "calls");
        assert_eq!(order_column(None, &EXEC_TIME_COLUMNS), "mean_exec_time");
    }

    #[test]
    fn hint_when_created_but_not_preloaded() {
        let hint = extension_hint(
            true,
            true,
            false,
            false,
            Some("auto_explain"),
            Some("top"),
            None,
        )
        .unwrap();
        assert!(hint.contains("shared_preload_libraries"));
        assert!(hint.contains("auto_explain"));
    }

    #[test]
    fn no_hint_when_installed_loaded_readable_and_collecting() {
        assert_eq!(
            extension_hint(
                true,
                true,
                true,
                true,
                Some("pg_stat_statements"),
                Some("top"),
                Some(12),
            ),
            None
        );
    }

    #[test]
    fn hint_when_track_is_none() {
        let hint = extension_hint(
            true,
            true,
            true,
            true,
            Some("pg_stat_statements"),
            Some("none"),
            Some(0),
        )
        .unwrap();
        assert!(hint.contains("track"));
        assert!(hint.contains("none"));
    }

    #[test]
    fn hint_when_view_readable_but_empty() {
        let hint = extension_hint(
            true,
            true,
            true,
            true,
            Some("pg_stat_statements"),
            Some("top"),
            Some(0),
        )
        .unwrap();
        assert!(hint.contains("一行统计都没有"));
    }

    #[test]
    fn track_is_none_is_case_insensitive() {
        assert!(track_is_none(Some("none")));
        assert!(track_is_none(Some("NONE")));
        assert!(!track_is_none(Some("top")));
        assert!(!track_is_none(None));
    }

    #[test]
    fn translate_not_loaded_does_not_claim_extension_missing() {
        let err = translate_pg_stat_error(sqlx::Error::Protocol(
            "pg_stat_statements must be loaded via shared_preload_libraries".into(),
        ));
        let msg = err.to_string();
        assert!(msg.contains("shared_preload_libraries"));
        assert!(!msg.contains("CREATE EXTENSION pg_stat_statements；详见扩展状态接口"));
    }
}
