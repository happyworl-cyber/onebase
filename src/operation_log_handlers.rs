//! 操作日志查询侧 handler：list / detail / stats / actors / export。
//!
//! 全部为项目（租户）级，`require_tenant_admin` 隔离。设计见
//! `docs/superpowers/specs/2026-08-04-operation-logs-design.md`。
//!
//! 读取时把 `detail.change`（结构化事实）经 [`crate::operation_log::format_change`]
//! 渲染成视图返回前端（写事实、读格式化）。

use axum::{
    extract::{Extension, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};

use crate::auth::Claims;
use crate::error::Result;
use crate::operation_log;
use crate::permissions;

/// 统一的筛选条件（列表 / 统计 / 导出共用）。
#[derive(Debug, Default, Deserialize)]
pub struct LogFilters {
    pub actor_id: Option<i32>,
    pub actor_name: Option<String>,
    pub action: Option<String>,
    pub resource_type: Option<String>,
    /// 资源对象名模糊搜索（ILIKE）。
    pub q_resource: Option<String>,
    pub source: Option<String>,
    pub status: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

fn norm(s: &Option<String>) -> Option<String> {
    s.as_ref()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// 统一 WHERE：tenant + 9 个可选 bar 过滤 + 3 个 tab 参数。
/// 全部以固定位次绑定（`$n::type IS NULL OR ...`），避免动态拼接的 bind 错位。
const FILTER_WHERE: &str = "\
    tenant_id = $1 \
    AND ($2::int IS NULL OR actor_id = $2) \
    AND ($3::text IS NULL OR actor_name = $3) \
    AND ($4::text IS NULL OR action = $4) \
    AND ($5::text IS NULL OR resource_type = $5) \
    AND ($6::text IS NULL OR resource_name ILIKE '%'||$6||'%') \
    AND ($7::text IS NULL OR source = $7) \
    AND ($8::text IS NULL OR status = $8) \
    AND ($9::timestamptz IS NULL OR created_at >= $9::timestamptz) \
    AND ($10::timestamptz IS NULL OR created_at <= $10::timestamptz) \
    AND ($11::bool IS NULL OR high_risk = $11) \
    AND ($12::text IS NULL OR status = $12) \
    AND ($13::int IS NULL OR (actor_type = 'user' AND actor_id = $13))";

/// tab 派生出的 3 个绑定值。
struct TabBinds {
    high_risk: Option<bool>,
    failed: Option<String>,
    mine_actor: Option<i32>,
}

fn tab_binds(tab: Option<&str>, current_user: i32) -> TabBinds {
    match tab {
        Some("high_risk") | Some("highRisk") => TabBinds {
            high_risk: Some(true),
            failed: None,
            mine_actor: None,
        },
        Some("failed") => TabBinds {
            high_risk: None,
            failed: Some("failed".to_string()),
            mine_actor: None,
        },
        Some("mine") => TabBinds {
            high_risk: None,
            failed: None,
            mine_actor: Some(current_user),
        },
        _ => TabBinds {
            high_risk: None,
            failed: None,
            mine_actor: None,
        },
    }
}

/// 绑定 `$1..$13`（tenant + bar 过滤 + tab）到给定 query。
fn bind_filters<'q>(
    q: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    tenant_id: i32,
    f: &'q LogFilters,
    tab: &'q TabBinds,
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    q.bind(tenant_id)
        .bind(f.actor_id)
        .bind(norm(&f.actor_name))
        .bind(norm(&f.action))
        .bind(norm(&f.resource_type))
        .bind(norm(&f.q_resource))
        .bind(norm(&f.source))
        .bind(norm(&f.status))
        .bind(norm(&f.start_date))
        .bind(norm(&f.end_date))
        .bind(tab.high_risk)
        .bind(tab.failed.clone())
        .bind(tab.mine_actor)
}

fn row_to_list_json(r: &sqlx::postgres::PgRow) -> Value {
    json!({
        "id": r.get::<i64, _>("id"),
        "actor_type": r.get::<String, _>("actor_type"),
        "actor_id": r.get::<Option<i32>, _>("actor_id"),
        "actor_name": r.get::<Option<String>, _>("actor_name"),
        "actor_role": r.get::<Option<String>, _>("actor_role"),
        "source": r.get::<String, _>("source"),
        "action": r.get::<String, _>("action"),
        "resource_type": r.get::<Option<String>, _>("resource_type"),
        "resource_name": r.get::<Option<String>, _>("resource_name"),
        "resource_id": r.get::<Option<String>, _>("resource_id"),
        "summary": r.get::<String, _>("summary"),
        "status": r.get::<String, _>("status"),
        "high_risk": r.get::<bool, _>("high_risk"),
        "ip": r.get::<Option<String>, _>("ip"),
        "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at").to_rfc3339(),
    })
}

const LIST_COLUMNS: &str = "id, actor_type, actor_id, actor_name, actor_role, source, action, \
     resource_type, resource_name, resource_id, summary, status, high_risk, ip, created_at";

/// 列表查询参数。字段内联（不用 `#[serde(flatten)]`——axum Query 底层 serde_urlencoded
/// 不支持 flatten），再经 [`ListQuery::filters`] 收敛成 [`LogFilters`] 复用绑定逻辑。
#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub tab: Option<String>,
    pub actor_id: Option<i32>,
    pub actor_name: Option<String>,
    pub action: Option<String>,
    pub resource_type: Option<String>,
    pub q_resource: Option<String>,
    pub source: Option<String>,
    pub status: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

impl ListQuery {
    fn filters(&self) -> LogFilters {
        LogFilters {
            actor_id: self.actor_id,
            actor_name: self.actor_name.clone(),
            action: self.action.clone(),
            resource_type: self.resource_type.clone(),
            q_resource: self.q_resource.clone(),
            source: self.source.clone(),
            status: self.status.clone(),
            start_date: self.start_date.clone(),
            end_date: self.end_date.clone(),
        }
    }
}

/// GET /api/projects/:id/operation-logs
pub async fn list_operation_logs(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;

    let limit = q.limit.unwrap_or(20).clamp(1, 100);
    let offset = q.offset.unwrap_or(0).max(0);
    let tab = tab_binds(q.tab.as_deref(), claims.sub);
    let filters = q.filters();

    let sql = format!(
        "SELECT {cols} FROM management.operation_logs WHERE {where_} \
         ORDER BY created_at DESC LIMIT $14 OFFSET $15",
        cols = LIST_COLUMNS,
        where_ = FILTER_WHERE
    );
    let rows = bind_filters(sqlx::query(&sql), project_id, &filters, &tab)
        .bind(limit)
        .bind(offset)
        .fetch_all(&pool)
        .await?;

    let count_sql = format!(
        "SELECT COUNT(*) AS total FROM management.operation_logs WHERE {}",
        FILTER_WHERE
    );
    let total: i64 = bind_filters(sqlx::query(&count_sql), project_id, &filters, &tab)
        .fetch_one(&pool)
        .await?
        .get("total");

    let data: Vec<Value> = rows.iter().map(row_to_list_json).collect();
    Ok(Json(json!({ "data": data, "total": total, "limit": limit, "offset": offset })))
}

/// GET /api/projects/:id/operation-logs/:log_id —— 单条详情（含 detail + 格式化后的变更视图）。
pub async fn get_operation_log(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, log_id)): Path<(i32, i64)>,
) -> Result<Json<Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;

    let row = sqlx::query(
        "SELECT id, tenant_id, actor_type, actor_id, actor_name, actor_role, source, action, \
                resource_type, resource_name, resource_id, summary, status, high_risk, \
                ip, user_agent, session_id, trace_id, duration_ms, detail, created_at \
         FROM management.operation_logs WHERE id = $1 AND tenant_id = $2",
    )
    .bind(log_id)
    .bind(project_id)
    .fetch_optional(&pool)
    .await?;

    let row = row.ok_or_else(|| crate::error::AppError::NotFound("操作日志不存在".to_string()))?;

    let action = row.get::<String, _>("action");
    let resource_type = row.get::<Option<String>, _>("resource_type");
    let detail: Option<Value> = row.try_get::<Option<Value>, _>("detail").ok().flatten();

    // 读时格式化：detail.change（结构化事实）→ 视图
    let change_view = detail
        .as_ref()
        .and_then(|d| d.get("change"))
        .and_then(|c| operation_log::format_change(&action, resource_type.as_deref(), c));

    Ok(Json(json!({
        "id": row.get::<i64, _>("id"),
        "tenant_id": row.get::<i32, _>("tenant_id"),
        "actor_type": row.get::<String, _>("actor_type"),
        "actor_id": row.get::<Option<i32>, _>("actor_id"),
        "actor_name": row.get::<Option<String>, _>("actor_name"),
        "actor_role": row.get::<Option<String>, _>("actor_role"),
        "source": row.get::<String, _>("source"),
        "action": action,
        "resource_type": resource_type,
        "resource_name": row.get::<Option<String>, _>("resource_name"),
        "resource_id": row.get::<Option<String>, _>("resource_id"),
        "summary": row.get::<String, _>("summary"),
        "status": row.get::<String, _>("status"),
        "high_risk": row.get::<bool, _>("high_risk"),
        "ip": row.get::<Option<String>, _>("ip"),
        "user_agent": row.get::<Option<String>, _>("user_agent"),
        "session_id": row.get::<Option<String>, _>("session_id"),
        "trace_id": row.get::<Option<String>, _>("trace_id"),
        "duration_ms": row.get::<Option<i32>, _>("duration_ms"),
        "detail": detail,
        "change_view": change_view,
        "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at").to_rfc3339(),
    })))
}

/// GET /api/projects/:id/operation-logs/stats —— 卡片 + tab 计数（按 bar 过滤，忽略 tab 自身）。
pub async fn operation_log_stats(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
    Query(filters): Query<LogFilters>,
) -> Result<Json<Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;

    // 统计只按 bar 过滤（tab 三参绑 NULL）；mine 用当前用户单独 FILTER（$14）。
    let no_tab = TabBinds {
        high_risk: None,
        failed: None,
        mine_actor: None,
    };
    let sql = format!(
        "SELECT \
            COUNT(*) AS total, \
            COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now())) AS today, \
            COUNT(DISTINCT actor_id) AS active_users, \
            COUNT(*) FILTER (WHERE status = 'failed') AS failed, \
            COUNT(*) FILTER (WHERE high_risk) AS high_risk, \
            COUNT(*) FILTER (WHERE actor_type = 'user' AND actor_id = $14) AS mine \
         FROM management.operation_logs WHERE {}",
        FILTER_WHERE
    );
    let r = bind_filters(sqlx::query(&sql), project_id, &filters, &no_tab)
        .bind(claims.sub)
        .fetch_one(&pool)
        .await?;

    Ok(Json(json!({
        "total": r.get::<i64, _>("total"),
        "today": r.get::<i64, _>("today"),
        "active_users": r.get::<i64, _>("active_users"),
        "failed": r.get::<i64, _>("failed"),
        "high_risk": r.get::<i64, _>("high_risk"),
        "mine": r.get::<i64, _>("mine"),
    })))
}

#[derive(Debug, Deserialize)]
pub struct ActorsQuery {
    pub q: Option<String>,
}

/// GET /api/projects/:id/operation-logs/actors —— 操作人下拉数据源（支持 ?q= 搜索）。
pub async fn list_operation_log_actors(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
    Query(q): Query<ActorsQuery>,
) -> Result<Json<Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;

    let rows = sqlx::query(
        "SELECT actor_name, MIN(actor_type) AS actor_type, MAX(actor_id) AS actor_id, COUNT(*) AS cnt \
         FROM management.operation_logs \
         WHERE tenant_id = $1 AND actor_name IS NOT NULL \
           AND ($2::text IS NULL OR actor_name ILIKE '%'||$2||'%') \
         GROUP BY actor_name \
         ORDER BY cnt DESC, actor_name ASC \
         LIMIT 200",
    )
    .bind(project_id)
    .bind(norm(&q.q))
    .fetch_all(&pool)
    .await?;

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "actor_name": r.get::<Option<String>, _>("actor_name"),
                "actor_type": r.get::<Option<String>, _>("actor_type"),
                "actor_id": r.get::<Option<i32>, _>("actor_id"),
            })
        })
        .collect();
    Ok(Json(json!({ "data": data })))
}

/// GET /api/projects/:id/operation-logs/facets —— 筛选项数据源：数据里真实出现过的
/// 动作 / 资源类型（去重）。让「动作」「资源」下拉只展示实际发生过的值，
/// 随接入模块自动增减，避免列一堆当前用不到的选项（如登录/执行）。
pub async fn operation_log_facets(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
) -> Result<Json<Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;

    let actions: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT action FROM management.operation_logs \
         WHERE tenant_id = $1 AND action IS NOT NULL ORDER BY action",
    )
    .bind(project_id)
    .fetch_all(&pool)
    .await?;

    let resource_types: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT resource_type FROM management.operation_logs \
         WHERE tenant_id = $1 AND resource_type IS NOT NULL ORDER BY resource_type",
    )
    .bind(project_id)
    .fetch_all(&pool)
    .await?;

    Ok(Json(json!({ "actions": actions, "resource_types": resource_types })))
}

/// CSV 字段转义，并防止 Excel/表格软件把用户可控文本解释成公式。
fn csv_field(value: &str) -> String {
    let first_visible = value.trim_start_matches([' ', '\t']).chars().next();
    let value = if matches!(first_visible, Some('=' | '+' | '-' | '@')) {
        format!("'{value}")
    } else {
        value.to_string()
    };
    if value.contains(',') || value.contains('"') || value.contains('\n') || value.contains('\r') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value
    }
}

/// GET /api/projects/:id/operation-logs/export —— 按当前筛选导出 CSV，并自审计一条 EXPORT。
pub async fn export_operation_logs(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
    Query(filters): Query<LogFilters>,
) -> Result<Response> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;

    let no_tab = TabBinds {
        high_risk: None,
        failed: None,
        mine_actor: None,
    };
    let sql = format!(
        "SELECT {cols} FROM management.operation_logs WHERE {where_} \
         ORDER BY created_at DESC LIMIT 10000",
        cols = LIST_COLUMNS,
        where_ = FILTER_WHERE
    );
    let rows = bind_filters(sqlx::query(&sql), project_id, &filters, &no_tab)
        .fetch_all(&pool)
        .await?;

    let mut csv = String::from(
        "\u{feff}时间,操作人,角色,来源,动作,资源类型,资源对象,资源ID,操作内容,状态,高危,IP\r\n",
    );
    for row in &rows {
        let created_at = row
            .get::<chrono::DateTime<chrono::Utc>, _>("created_at")
            .to_rfc3339();
        let values = [
            created_at,
            row.get::<Option<String>, _>("actor_name").unwrap_or_default(),
            row.get::<Option<String>, _>("actor_role").unwrap_or_default(),
            row.get::<String, _>("source"),
            row.get::<String, _>("action"),
            row.get::<Option<String>, _>("resource_type")
                .unwrap_or_default(),
            row.get::<Option<String>, _>("resource_name")
                .unwrap_or_default(),
            row.get::<Option<String>, _>("resource_id")
                .unwrap_or_default(),
            row.get::<String, _>("summary"),
            row.get::<String, _>("status"),
            if row.get::<bool, _>("high_risk") {
                "是".to_string()
            } else {
                "否".to_string()
            },
            row.get::<Option<String>, _>("ip").unwrap_or_default(),
        ];
        csv.push_str(
            &values
                .iter()
                .map(|value| csv_field(value))
                .collect::<Vec<_>>()
                .join(","),
        );
        csv.push_str("\r\n");
    }

    // 导出行为本身自审计（D6）。
    operation_log::record(
        &pool,
        operation_log::OperationLogInput::new(
            project_id,
            operation_log::Actor::User {
                id: claims.sub,
                name: claims.email.clone(),
                role: None,
            },
            operation_log::Source::Console,
            operation_log::action::EXPORT,
            format!("导出操作日志（{} 条，CSV）", rows.len()),
            operation_log::Status::Success,
        )
        .resource(operation_log::resource_type::SYSTEM, "操作日志", None),
    );

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/csv; charset=utf-8"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!(
            "attachment; filename=\"operation-logs-{project_id}.csv\""
        ))
        .unwrap_or_else(|_| {
            HeaderValue::from_static("attachment; filename=\"operation-logs.csv\"")
        }),
    );
    Ok((StatusCode::OK, headers, csv).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 冒烟：FILTER_WHERE 恰好用到 $1..$13，list 才能安全接 $14/$15，stats 才能接 $14。
    #[test]
    fn filter_where_uses_exactly_13_placeholders() {
        let max = (1..=20)
            .rev()
            .find(|n| FILTER_WHERE.contains(&format!("${}", n)))
            .unwrap();
        assert_eq!(max, 13, "FILTER_WHERE 应绑定到 $13");
        assert!(FILTER_WHERE.contains("tenant_id = $1"));
        assert!(!FILTER_WHERE.contains("$14"));
    }

    #[test]
    fn tab_binds_map_each_tab() {
        let hr = tab_binds(Some("highRisk"), 7);
        assert_eq!(hr.high_risk, Some(true));
        assert_eq!(tab_binds(Some("high_risk"), 7).high_risk, Some(true));

        let failed = tab_binds(Some("failed"), 7);
        assert_eq!(failed.failed.as_deref(), Some("failed"));

        let mine = tab_binds(Some("mine"), 7);
        assert_eq!(mine.mine_actor, Some(7));

        let all = tab_binds(Some("all"), 7);
        assert!(all.high_risk.is_none() && all.failed.is_none() && all.mine_actor.is_none());
        let none = tab_binds(None, 7);
        assert!(none.high_risk.is_none() && none.failed.is_none() && none.mine_actor.is_none());
    }

    #[test]
    fn norm_trims_and_nulls_empty() {
        assert_eq!(norm(&Some("  wf250  ".to_string())).as_deref(), Some("wf250"));
        assert_eq!(norm(&Some("   ".to_string())), None);
        assert_eq!(norm(&None), None);
    }

    #[test]
    fn csv_field_escapes_content_and_blocks_formulas() {
        assert_eq!(csv_field("普通文本"), "普通文本");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("a\"b"), "\"a\"\"b\"");
        assert_eq!(csv_field("line1\nline2"), "\"line1\nline2\"");
        assert_eq!(csv_field("=1+1"), "'=1+1");
        assert_eq!(csv_field("+SUM(A1:A2)"), "'+SUM(A1:A2)");
        assert_eq!(csv_field("  =1+1"), "'  =1+1");
    }
}
