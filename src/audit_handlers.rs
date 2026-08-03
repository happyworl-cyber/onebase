use axum::{
    extract::{Extension, Query, State},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::{PgPool, Row};

use crate::auth::Claims;
use crate::error::{AppError, Result};
use crate::permissions;

/// 当前用户管理（owner/admin）的全部 tenant_id，超管返回空向量表示"无限制"。
///
/// 委托给 `crate::permissions::tenant_admin_ids`，那里同时过滤了
/// `user_tenants.is_active = true`——被软删除的成员不应再算作"租户管理员"。
/// 必须保持 `pub`：`scheduler_handlers` 和 `es::admin_handlers` 也借这个 helper 做
/// "该任务/资源的 tenant 当前用户是否能管理"的判定（详见 grep `admin_tenant_ids`）。
pub async fn admin_tenant_ids(pool: &PgPool, claims: &Claims) -> Result<Vec<i32>> {
    permissions::tenant_admin_ids(pool, claims).await
}

#[derive(Debug, Deserialize)]
pub struct AuditLogQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub user_id: Option<i32>,
    pub action: Option<String>,
    pub resource: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

/// GET /api/admin/audit-logs
///
/// 超管：返回全部审计日志；
/// 租户 owner/admin：只返回自己 tenant_id 的日志（NULL tenant_id 视为平台级，不返回）。
pub async fn list_audit_logs(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(params): Query<AuditLogQuery>,
) -> Result<Json<serde_json::Value>> {
    let limit = params.limit.unwrap_or(50).min(200);
    let offset = params.offset.unwrap_or(0);

    let mut conditions = vec!["1=1".to_string()];
    let mut bind_idx = 1u32;

    let tenant_filter: Option<Vec<i32>> = if claims.is_superadmin {
        None
    } else {
        let ids = admin_tenant_ids(&pool, &claims).await?;
        if ids.is_empty() {
            return Err(AppError::Forbidden(
                "需要租户 owner/admin 角色才能查看审计日志".to_string(),
            ));
        }
        Some(ids)
    };

    if tenant_filter.is_some() {
        conditions.push(format!("tenant_id = ANY(${})", bind_idx));
        bind_idx += 1;
    }

    if params.user_id.is_some() {
        conditions.push(format!("user_id = ${}", bind_idx));
        bind_idx += 1;
    }
    if params.action.is_some() {
        conditions.push(format!("action = ${}", bind_idx));
        bind_idx += 1;
    }
    if params.resource.is_some() {
        conditions.push(format!("resource LIKE ${}", bind_idx));
        bind_idx += 1;
    }
    if params.start_date.is_some() {
        conditions.push(format!("created_at >= ${}::timestamptz", bind_idx));
        bind_idx += 1;
    }
    if params.end_date.is_some() {
        conditions.push(format!("created_at <= ${}::timestamptz", bind_idx));
        bind_idx += 1;
    }

    let where_clause = conditions.join(" AND ");
    let sql = format!(
        "SELECT id, tenant_id, user_id, action, resource, request_method, \
                request_path, response_status, ip_address, user_agent, duration_ms, created_at \
         FROM management.audit_logs \
         WHERE {} \
         ORDER BY created_at DESC \
         LIMIT ${} OFFSET ${}",
        where_clause,
        bind_idx,
        bind_idx + 1
    );

    let mut query = sqlx::query(&sql);
    if let Some(ref ids) = tenant_filter {
        query = query.bind(ids);
    }
    if let Some(uid) = params.user_id {
        query = query.bind(uid);
    }
    if let Some(ref act) = params.action {
        query = query.bind(act);
    }
    if let Some(ref res) = params.resource {
        query = query.bind(format!("%{}%", res));
    }
    if let Some(ref sd) = params.start_date {
        query = query.bind(sd);
    }
    if let Some(ref ed) = params.end_date {
        query = query.bind(ed);
    }
    query = query.bind(limit).bind(offset);

    let rows = query.fetch_all(&pool).await?;

    let count_sql = format!(
        "SELECT COUNT(*) as total FROM management.audit_logs WHERE {}",
        where_clause
    );
    let mut count_query = sqlx::query(&count_sql);
    if let Some(ref ids) = tenant_filter {
        count_query = count_query.bind(ids);
    }
    if let Some(uid) = params.user_id {
        count_query = count_query.bind(uid);
    }
    if let Some(ref act) = params.action {
        count_query = count_query.bind(act);
    }
    if let Some(ref res) = params.resource {
        count_query = count_query.bind(format!("%{}%", res));
    }
    if let Some(ref sd) = params.start_date {
        count_query = count_query.bind(sd);
    }
    if let Some(ref ed) = params.end_date {
        count_query = count_query.bind(ed);
    }
    let total: i64 = count_query.fetch_one(&pool).await?.get("total");

    let logs: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<i64, _>("id"),
                "tenant_id": r.get::<Option<i32>, _>("tenant_id"),
                "user_id": r.get::<Option<i32>, _>("user_id"),
                "action": r.get::<String, _>("action"),
                "resource": r.get::<String, _>("resource"),
                "request_method": r.get::<String, _>("request_method"),
                "request_path": r.get::<String, _>("request_path"),
                "response_status": r.get::<Option<i32>, _>("response_status"),
                "ip_address": r.get::<Option<String>, _>("ip_address"),
                "user_agent": r.get::<Option<String>, _>("user_agent"),
                "duration_ms": r.get::<Option<i32>, _>("duration_ms"),
                "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at").to_rfc3339(),
            })
        })
        .collect();

    Ok(Json(json!({
        "data": logs,
        "total": total,
        "limit": limit,
        "offset": offset,
    })))
}

/// 操作审计涉及的路径前缀（平台管理、工作流、定时任务等）。
const OPERATION_AUDIT_PATH_PREFIXES: &[&str] = &[
    "/api/admin/tenants",
    "/api/admin/users",
    "/api/admin/tenant-users",
    "/api/admin/pg-pools",
    "/api/platform-tokens",
    "/api/sso/providers",
    "/api/admin/rate-limit-rules",
    "/api/admin/workflows",
    "/api/admin/workflow-folders",
    "/api/admin/scheduled-tasks",
];

fn matches_operation_audit_path(path: &str) -> bool {
    OPERATION_AUDIT_PATH_PREFIXES
        .iter()
        .any(|prefix| path.starts_with(prefix))
        || path == "/query"
        || path == "/transaction"
        || (path.starts_with("/api/v1/") && path.ends_with("/sql"))
}

fn operation_path_sql_filter() -> String {
    let prefix_conds: Vec<String> = OPERATION_AUDIT_PATH_PREFIXES
        .iter()
        .map(|p| format!("al.request_path LIKE '{}%'", p))
        .collect();
    format!(
        "({} OR al.request_path IN ('/query', '/transaction') OR (al.request_path LIKE '/api/v1/%' AND al.request_path LIKE '%/sql'))",
        prefix_conds.join(" OR ")
    )
}

fn classify_operation_category(path: &str, action: &str, body: Option<&serde_json::Value>) -> &'static str {
    if path == "/query"
        || path == "/transaction"
        || (path.starts_with("/api/v1/") && path.ends_with("/sql"))
        || action.starts_with("RAW_SQL")
        || action.starts_with("V1_RAW")
    {
        return "sql";
    }
    if let Some(kind) = body.and_then(|b| b.get("kind")).and_then(|k| k.as_str()) {
        if kind.contains("workflow") {
            return "workflow";
        }
        if kind.contains("tenant") || kind.contains("project") {
            return "project";
        }
    }
    if path.starts_with("/api/admin/workflows") || path.starts_with("/api/admin/workflow-folders") {
        return "workflow";
    }
    if path.starts_with("/api/admin/tenants") {
        return "project";
    }
    "platform"
}

/// 把 HTTP 方法 + 路径映射成可读的中文操作描述（无 handler 侧 kind 时的兜底）。
fn describe_operation(method: &str, path: &str, action: &str) -> String {
    if action != method && !action.chars().all(|c| c.is_ascii_uppercase() || c == '_' || c == '.')
    {
        return action.replace('_', " ").to_string();
    }
    if let Some(kind) = action.strip_prefix("WORKFLOW.") {
        return match kind {
            "CREATE" => "创建工作流".to_string(),
            "UPDATE" => "修改工作流".to_string(),
            "DELETE" => "删除工作流".to_string(),
            "DUPLICATE" => "复制工作流".to_string(),
            "TRIGGER" => "触发工作流".to_string(),
            "RESTORE_VERSION" => "恢复工作流版本".to_string(),
            other => format!("工作流 {}", other.to_lowercase()),
        };
    }
    if let Some(kind) = action.strip_prefix("PLATFORM.TENANT.") {
        return match kind {
            "CREATE" => "创建项目".to_string(),
            "UPDATE" => "更新项目".to_string(),
            "DELETE" => "删除项目".to_string(),
            other => format!("项目 {}", other.to_lowercase()),
        };
    }
    if action.starts_with("RAW_SQL") || action.starts_with("V1_RAW") {
        return match action {
            "RAW_SQL_QUERY" | "V1_RAW_DDL" => "执行 SQL".to_string(),
            "RAW_SQL_QUERY_DONE" | "V1_RAW_DDL_DONE" => "SQL 执行成功".to_string(),
            a if a.contains("BLOCKED") => "SQL 被拦截".to_string(),
            "RAW_SQL_TXN" => "执行 SQL 事务".to_string(),
            _ => "执行 SQL".to_string(),
        };
    }
    if path == "/query" || path == "/transaction" {
        return if path == "/transaction" {
            "执行 SQL 事务".to_string()
        } else {
            "执行 SQL".to_string()
        };
    }
    if path.starts_with("/api/v1/") && path.ends_with("/sql") {
        return "执行 DDL SQL".to_string();
    }
    if path.starts_with("/api/admin/workflows") {
        return match method {
            "POST" if path.contains("/duplicate") => "复制工作流".to_string(),
            "POST" if path.contains("/trigger") => "触发工作流".to_string(),
            "POST" if path.contains("/restore") => "恢复工作流版本".to_string(),
            "POST" => "创建工作流".to_string(),
            "PATCH" => "修改工作流".to_string(),
            "DELETE" => "删除工作流".to_string(),
            _ => format!("{} {}", method, path),
        };
    }
    if path.starts_with("/api/admin/tenants/create") || (path == "/api/admin/tenants" && method == "POST") {
        return "创建项目".to_string();
    }
    if path.starts_with("/api/admin/tenants/") && method == "PATCH" {
        return "更新项目".to_string();
    }
    if path.starts_with("/api/admin/tenants/") && method == "DELETE" {
        return "删除项目".to_string();
    }
    if path.contains("/status") && method == "PATCH" {
        return "更新项目状态".to_string();
    }
    if path.starts_with("/api/admin/tenants/") && path.contains("/replicas") {
        return match method {
            "POST" => "添加数据库副本".to_string(),
            "PATCH" => "更新数据库副本".to_string(),
            "DELETE" => "删除数据库副本".to_string(),
            _ => format!("{} {}", method, path),
        };
    }
    if path.contains("/assign-tenant") {
        return "分配用户到项目".to_string();
    }
    if path == "/api/admin/users" && method == "POST" {
        return "创建用户".to_string();
    }
    if path.starts_with("/api/admin/users/") && path.contains("reset-password") {
        return "重置用户密码".to_string();
    }
    if path.starts_with("/api/admin/users/") && method == "PATCH" {
        return "更新用户".to_string();
    }
    if path.starts_with("/api/admin/users/") && method == "DELETE" {
        return "删除用户".to_string();
    }
    if path == "/api/admin/tenant-users" && method == "POST" {
        return "添加用户到项目".to_string();
    }
    if path.starts_with("/api/admin/tenant-users/") && method == "DELETE" {
        return "从项目移除用户".to_string();
    }
    if path.starts_with("/api/admin/pg-pools") {
        return match method {
            "POST" if path.ends_with("/test") => "测试 PG 池连接".to_string(),
            "POST" => "创建 PG 池".to_string(),
            "PATCH" => "更新 PG 池".to_string(),
            "DELETE" => "删除 PG 池".to_string(),
            _ => format!("{} {}", method, path),
        };
    }
    if path.starts_with("/api/admin/scheduled-tasks") {
        return match method {
            "POST" if path.contains("/run-now") => "立即执行定时任务".to_string(),
            "POST" if path.contains("/pause") => "暂停定时任务".to_string(),
            "POST" if path.contains("/resume") => "恢复定时任务".to_string(),
            "POST" => "创建定时任务".to_string(),
            "PATCH" => "修改定时任务".to_string(),
            "DELETE" => "删除定时任务".to_string(),
            _ => format!("{} {}", method, path),
        };
    }
    if path.starts_with("/api/platform-tokens") {
        return match method {
            "POST" => "创建平台令牌".to_string(),
            "DELETE" => "删除平台令牌".to_string(),
            _ => format!("{} {}", method, path),
        };
    }
    if path.starts_with("/api/sso/providers") {
        return match method {
            "POST" => "创建 SSO 提供商".to_string(),
            "PATCH" => "更新 SSO 提供商".to_string(),
            "DELETE" => "删除 SSO 提供商".to_string(),
            _ => format!("{} {}", method, path),
        };
    }
    if path.starts_with("/api/admin/rate-limit-rules") {
        return match method {
            "POST" => "创建限流规则".to_string(),
            "PATCH" => "更新限流规则".to_string(),
            "DELETE" => "删除限流规则".to_string(),
            _ => format!("{} {}", method, path),
        };
    }
    format!("{} {}", method, path)
}

fn detail_field<'a>(body: Option<&'a serde_json::Value>, key: &str) -> Option<&'a str> {
    body.and_then(|b| {
        b.get("detail")
            .and_then(|d| d.get(key))
            .or_else(|| b.get(key))
            .and_then(|v| v.as_str())
    })
}

fn detail_i64(body: Option<&serde_json::Value>, key: &str) -> Option<i64> {
    body.and_then(|b| {
        b.get("detail")
            .and_then(|d| d.get(key))
            .or_else(|| b.get(key))
            .and_then(|v| v.as_i64())
    })
}

/// 生成带业务上下文的可读摘要，例如「创建工作流「订单同步」」「执行 SELECT SQL（128 字符）库 #3」。
fn build_operation_summary(
    method: &str,
    path: &str,
    action: &str,
    body: Option<&serde_json::Value>,
) -> String {
    let base = describe_operation(method, path, action);

    if let Some(blocked) = body
        .and_then(|b| b.get("blocked_reason"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        let sql_type = body
            .and_then(|b| b.get("sql_type"))
            .and_then(|v| v.as_str())
            .unwrap_or("SQL");
        return format!("{}（{} · {}）", base, sql_type, blocked);
    }

    if action.starts_with("RAW_SQL")
        || action.starts_with("V1_RAW")
        || path == "/query"
        || path == "/transaction"
        || (path.starts_with("/api/v1/") && path.ends_with("/sql"))
    {
        let sql_type = body
            .and_then(|b| b.get("sql_type"))
            .and_then(|v| v.as_str())
            .unwrap_or("SQL");
        let sql_len = body
            .and_then(|b| b.get("sql_len"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let db_id = detail_i64(body, "database_id");
        let op_count = body
            .and_then(|b| b.get("op_count"))
            .and_then(|v| v.as_i64());
        let db_part = db_id
            .map(|id| format!(" · 库 #{id}"))
            .unwrap_or_default();
        if let Some(n) = op_count {
            return format!("{base} · {sql_type} · {n} 条语句 · {sql_len} 字符{db_part}");
        }
        return format!("{base} · {sql_type} · {sql_len} 字符{db_part}");
    }

    if let Some(name) = detail_field(body, "name") {
        let slug = detail_field(body, "slug").unwrap_or("");
        if slug.is_empty() {
            return format!("{base}「{name}」");
        }
        return format!("{base}「{name}」({slug})");
    }

    if let Some(slug) = detail_field(body, "slug") {
        return format!("{base} ({slug})");
    }

    if let Some(wf_id) = detail_i64(body, "workflow_id") {
        return format!("{base} #{}", wf_id);
    }

    if let Some(tenant_id) = detail_i64(body, "tenant_id") {
        return format!("{base} #{}", tenant_id);
    }

    base
}

#[derive(Debug, Deserialize)]
pub struct PlatformAdminAuditQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub user_id: Option<i32>,
    pub action: Option<String>,
    pub resource: Option<String>,
    pub category: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

/// GET /api/platform/admin-audit-logs
///
/// 平台超管专属：列出关键写操作（项目、工作流、SQL、用户管理等）。
/// 数据来自全局 `audit_middleware` 自动写入的 `management.audit_logs`。
pub async fn list_platform_admin_audit(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(params): Query<PlatformAdminAuditQuery>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_platform_superadmin(&claims)?;

    let limit = params.limit.unwrap_or(50).min(200);
    let offset = params.offset.unwrap_or(0);

    let path_filter = operation_path_sql_filter();

    let mut conditions = vec![
        "al.request_method IN ('POST', 'PATCH', 'PUT', 'DELETE')".to_string(),
        path_filter,
    ];
    let mut bind_idx = 1u32;

    if let Some(ref cat) = params.category {
        match cat.as_str() {
            "sql" => conditions.push(
                "(al.request_path IN ('/query', '/transaction') OR (al.request_path LIKE '/api/v1/%' AND al.request_path LIKE '%/sql') OR al.action LIKE 'RAW_SQL%' OR al.action LIKE 'V1_RAW%')".to_string(),
            ),
            "workflow" => conditions.push(
                "(al.request_path LIKE '/api/admin/workflows%' OR al.request_path LIKE '/api/admin/workflow-folders%' OR al.action LIKE 'WORKFLOW.%')".to_string(),
            ),
            "project" => conditions.push(
                "(al.request_path LIKE '/api/admin/tenants%' OR al.action LIKE 'PLATFORM.TENANT.%')".to_string(),
            ),
            "platform" => conditions.push(
                "(al.request_path NOT LIKE '/api/admin/tenants%' AND al.request_path NOT LIKE '/api/admin/workflows%' AND al.request_path NOT LIKE '/api/admin/workflow-folders%' AND al.request_path NOT IN ('/query', '/transaction') AND NOT (al.request_path LIKE '/api/v1/%' AND al.request_path LIKE '%/sql') AND al.action NOT LIKE 'RAW_SQL%' AND al.action NOT LIKE 'V1_RAW%' AND al.action NOT LIKE 'WORKFLOW.%' AND al.action NOT LIKE 'PLATFORM.TENANT.%')".to_string(),
            ),
            _ => {}
        }
    }

    if params.user_id.is_some() {
        conditions.push(format!("al.user_id = ${}", bind_idx));
        bind_idx += 1;
    }
    if params.action.is_some() {
        conditions.push(format!("al.action = ${}", bind_idx));
        bind_idx += 1;
    }
    if params.resource.is_some() {
        conditions.push(format!("al.request_path LIKE ${}", bind_idx));
        bind_idx += 1;
    }
    if params.start_date.is_some() {
        conditions.push(format!("al.created_at >= ${}::timestamptz", bind_idx));
        bind_idx += 1;
    }
    if params.end_date.is_some() {
        conditions.push(format!("al.created_at <= ${}::timestamptz", bind_idx));
        bind_idx += 1;
    }

    let where_clause = conditions.join(" AND ");
    let sql = format!(
        "SELECT al.id, al.user_id, u.username, u.email, al.action, al.resource, \
                al.request_method, al.request_path, al.request_body, \
                al.response_status, al.ip_address, al.user_agent, al.duration_ms, al.created_at \
         FROM management.audit_logs al \
         LEFT JOIN users u ON u.id = al.user_id \
         WHERE {} \
         ORDER BY al.created_at DESC \
         LIMIT ${} OFFSET ${}",
        where_clause,
        bind_idx,
        bind_idx + 1
    );

    let mut query = sqlx::query(&sql);
    if let Some(uid) = params.user_id {
        query = query.bind(uid);
    }
    if let Some(ref act) = params.action {
        query = query.bind(act);
    }
    if let Some(ref res) = params.resource {
        query = query.bind(format!("%{}%", res));
    }
    if let Some(ref sd) = params.start_date {
        query = query.bind(sd);
    }
    if let Some(ref ed) = params.end_date {
        query = query.bind(ed);
    }
    query = query.bind(limit).bind(offset);

    let rows = query.fetch_all(&pool).await?;

    let count_sql = format!(
        "SELECT COUNT(*) as total FROM management.audit_logs al WHERE {}",
        where_clause
    );
    let mut count_query = sqlx::query(&count_sql);
    if let Some(uid) = params.user_id {
        count_query = count_query.bind(uid);
    }
    if let Some(ref act) = params.action {
        count_query = count_query.bind(act);
    }
    if let Some(ref res) = params.resource {
        count_query = count_query.bind(format!("%{}%", res));
    }
    if let Some(ref sd) = params.start_date {
        count_query = count_query.bind(sd);
    }
    if let Some(ref ed) = params.end_date {
        count_query = count_query.bind(ed);
    }
    let total: i64 = count_query.fetch_one(&pool).await?.get("total");

    let logs: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            let method = r.get::<String, _>("request_method");
            let path = r.get::<String, _>("request_path");
            let action = r.get::<String, _>("action");
            let request_body: Option<serde_json::Value> = r
                .try_get::<Option<serde_json::Value>, _>("request_body")
                .ok()
                .flatten();
            let category = classify_operation_category(&path, &action, request_body.as_ref());
            let summary = build_operation_summary(
                &method,
                &path,
                &action,
                request_body.as_ref(),
            );
            json!({
                "id": r.get::<i64, _>("id"),
                "user_id": r.get::<Option<i32>, _>("user_id"),
                "username": r.get::<Option<String>, _>("username"),
                "email": r.get::<Option<String>, _>("email"),
                "action": action,
                "category": category,
                "operation": describe_operation(&method, &path, &action),
                "summary": summary,
                "resource": r.get::<String, _>("resource"),
                "request_method": method,
                "request_path": path,
                "request_body": request_body,
                "response_status": r.get::<Option<i32>, _>("response_status"),
                "ip_address": r.get::<Option<String>, _>("ip_address"),
                "user_agent": r.get::<Option<String>, _>("user_agent"),
                "duration_ms": r.get::<Option<i32>, _>("duration_ms"),
                "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at").to_rfc3339(),
            })
        })
        .collect();

    Ok(Json(json!({
        "data": logs,
        "total": total,
        "limit": limit,
        "offset": offset,
    })))
}

#[cfg(test)]
mod platform_audit_tests {
    use super::*;

    #[test]
    fn operation_path_filter_matches_key_routes() {
        assert!(matches_operation_audit_path("/api/admin/tenants/create"));
        assert!(matches_operation_audit_path("/api/admin/workflows"));
        assert!(matches_operation_audit_path("/api/admin/workflows/42"));
        assert!(matches_operation_audit_path("/query"));
        assert!(matches_operation_audit_path("/api/v1/mydb/sql"));
        assert!(!matches_operation_audit_path("/api/query-perf/statements"));
    }

    #[test]
    fn describe_create_tenant() {
        assert_eq!(
            describe_operation("POST", "/api/admin/tenants/create", "POST"),
            "创建项目"
        );
    }

    #[test]
    fn summary_workflow_with_name() {
        let body = json!({
            "kind": "workflow.create",
            "detail": { "name": "订单同步", "slug": "order-sync", "workflow_id": 7 }
        });
        assert_eq!(
            build_operation_summary("POST", "/api/admin/workflows", "WORKFLOW.CREATE", Some(&body)),
            "创建工作流「订单同步」(order-sync)"
        );
    }

    #[test]
    fn summary_sql_execution() {
        let body = json!({
            "sql_type": "SELECT",
            "sql_len": 128,
            "database_id": 3
        });
        assert_eq!(
            build_operation_summary("POST", "/query", "RAW_SQL_QUERY", Some(&body)),
            "执行 SQL · SELECT · 128 字符 · 库 #3"
        );
    }
}

/// GET /api/admin/slow-queries
///
/// 超管：返回所有慢查询；
/// 租户 owner/admin：只返回 database_id 属于自己租户的慢查询（按 tenant_databases 关联过滤）。
pub async fn list_slow_queries(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(params): Query<SlowQueryParams>,
) -> Result<Json<serde_json::Value>> {
    let limit = params.limit.unwrap_or(50).min(200);
    let min_duration = params.min_duration_ms.unwrap_or(500);

    let rows = if let Some(database_id) = params.database_id {
        permissions::require_database_admin(&pool, &claims, database_id).await?;
        sqlx::query(
            "SELECT id, database_id, schema_name, table_name, sql_preview, duration_ms, created_at \
             FROM management.slow_query_logs \
             WHERE duration_ms >= $1 AND database_id = $2 \
             ORDER BY created_at DESC \
             LIMIT $3",
        )
        .bind(min_duration)
        .bind(database_id)
        .bind(limit)
        .fetch_all(&pool)
        .await?
    } else if let Some(tenant_id) = params.tenant_id {
        permissions::require_tenant_admin(&pool, &claims, tenant_id).await?;
        sqlx::query(
            "SELECT s.id, s.database_id, s.schema_name, s.table_name, s.sql_preview, s.duration_ms, s.created_at \
             FROM management.slow_query_logs s \
             JOIN management.tenant_databases td ON td.id = s.database_id \
             WHERE s.duration_ms >= $1 AND td.tenant_id = $2 \
             ORDER BY s.created_at DESC \
             LIMIT $3",
        )
        .bind(min_duration)
        .bind(tenant_id)
        .bind(limit)
        .fetch_all(&pool)
        .await?
    } else if claims.is_superadmin {
        sqlx::query(
            "SELECT id, database_id, schema_name, table_name, sql_preview, duration_ms, created_at \
             FROM management.slow_query_logs \
             WHERE duration_ms >= $1 \
             ORDER BY created_at DESC \
             LIMIT $2"
        )
        .bind(min_duration)
        .bind(limit)
        .fetch_all(&pool)
        .await?
    } else {
        let tenant_ids = admin_tenant_ids(&pool, &claims).await?;
        if tenant_ids.is_empty() {
            return Err(AppError::Forbidden(
                "需要租户 owner/admin 角色才能查看慢查询".to_string(),
            ));
        }
        sqlx::query(
            "SELECT s.id, s.database_id, s.schema_name, s.table_name, s.sql_preview, s.duration_ms, s.created_at \
             FROM management.slow_query_logs s \
             JOIN management.tenant_databases td ON td.id = s.database_id \
             WHERE s.duration_ms >= $1 AND td.tenant_id = ANY($2) \
             ORDER BY s.created_at DESC \
             LIMIT $3"
        )
        .bind(min_duration)
        .bind(&tenant_ids)
        .bind(limit)
        .fetch_all(&pool)
        .await?
    };

    let queries: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<i64, _>("id"),
                "database_id": r.get::<Option<i32>, _>("database_id"),
                "schema_name": r.get::<Option<String>, _>("schema_name"),
                "table_name": r.get::<Option<String>, _>("table_name"),
                "sql_preview": r.get::<Option<String>, _>("sql_preview"),
                "duration_ms": r.get::<i32, _>("duration_ms"),
                "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at").to_rfc3339(),
            })
        })
        .collect();

    Ok(Json(json!({ "data": queries })))
}

#[derive(Debug, Deserialize)]
pub struct SlowQueryParams {
    pub limit: Option<i64>,
    pub min_duration_ms: Option<i32>,
    pub tenant_id: Option<i32>,
    pub database_id: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct RawSqlAuditQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub user_id: Option<i32>,
    pub database_id: Option<i32>,
    /// `RAW_SQL_QUERY` / `RAW_SQL_BLOCKED` / `RAW_SQL_TXN` / `RAW_SQL_QUERY_DONE`
    pub action: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    /// 仅返回被拦截的记录（action 以 BLOCKED 结尾）
    pub blocked_only: Option<bool>,
}

/// GET /api/platform/raw-sql-audit
///
/// 平台超管专属的"原始 SQL 调用链"面板：
/// - 从 `management.audit_logs` 里挑出所有 `action LIKE 'RAW_SQL%'` 的行；
/// - 把 `request_body` JSONB 里的 `sql_type` / `sql_len` / `blocked_reason` /
///   `database_id` / `read_only` / `acknowledge_destructive` 顶层暴露出来，
///   便于前端做"被拦截统计 / 谁在哪个库上跑了多少条 DDL"之类的快速分析。
///
/// 与 `list_audit_logs` 区分：那个接口面向"租户日常审计"（含租户 admin），
/// 这个接口只面向**平台超管**，因为原始 SQL 通道本身就是平台级特权。
pub async fn list_raw_sql_audit(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(params): Query<RawSqlAuditQuery>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_platform_superadmin(&claims)?;

    let limit = params.limit.unwrap_or(50).min(200);
    let offset = params.offset.unwrap_or(0);

    let mut conditions = vec!["action LIKE 'RAW_SQL%'".to_string()];
    let mut bind_idx = 1u32;

    if params.user_id.is_some() {
        conditions.push(format!("user_id = ${}", bind_idx));
        bind_idx += 1;
    }
    if params.database_id.is_some() {
        conditions.push(format!(
            "(request_body->>'database_id')::int = ${}",
            bind_idx
        ));
        bind_idx += 1;
    }
    if params.action.is_some() {
        conditions.push(format!("action = ${}", bind_idx));
        bind_idx += 1;
    }
    if params.start_date.is_some() {
        conditions.push(format!("created_at >= ${}::timestamptz", bind_idx));
        bind_idx += 1;
    }
    if params.end_date.is_some() {
        conditions.push(format!("created_at <= ${}::timestamptz", bind_idx));
        bind_idx += 1;
    }
    if params.blocked_only.unwrap_or(false) {
        conditions.push("action LIKE 'RAW_SQL_%BLOCKED%'".to_string());
    }

    let where_clause = conditions.join(" AND ");
    // 关键：request_body 已经是 jsonb，直接 ->> 提抽要的字段，不依赖应用层再解析。
    let sql = format!(
        "SELECT id, user_id, action, request_method, request_path, \
                response_status, duration_ms, ip_address, created_at, \
                (request_body->>'database_id')::int AS database_id, \
                request_body->>'sql_type' AS sql_type, \
                (request_body->>'sql_len')::int AS sql_len, \
                (request_body->>'read_only')::boolean AS read_only, \
                (request_body->>'acknowledge_destructive')::boolean AS acknowledge_destructive, \
                request_body->>'blocked_reason' AS blocked_reason, \
                (request_body->>'op_count')::int AS op_count \
         FROM management.audit_logs \
         WHERE {} \
         ORDER BY created_at DESC \
         LIMIT ${} OFFSET ${}",
        where_clause,
        bind_idx,
        bind_idx + 1
    );

    let mut query = sqlx::query(&sql);
    if let Some(uid) = params.user_id {
        query = query.bind(uid);
    }
    if let Some(did) = params.database_id {
        query = query.bind(did);
    }
    if let Some(ref act) = params.action {
        query = query.bind(act);
    }
    if let Some(ref sd) = params.start_date {
        query = query.bind(sd);
    }
    if let Some(ref ed) = params.end_date {
        query = query.bind(ed);
    }
    query = query.bind(limit).bind(offset);

    let rows = query.fetch_all(&pool).await?;

    let count_sql = format!(
        "SELECT COUNT(*) AS total FROM management.audit_logs WHERE {}",
        where_clause
    );
    let mut count_query = sqlx::query(&count_sql);
    if let Some(uid) = params.user_id {
        count_query = count_query.bind(uid);
    }
    if let Some(did) = params.database_id {
        count_query = count_query.bind(did);
    }
    if let Some(ref act) = params.action {
        count_query = count_query.bind(act);
    }
    if let Some(ref sd) = params.start_date {
        count_query = count_query.bind(sd);
    }
    if let Some(ref ed) = params.end_date {
        count_query = count_query.bind(ed);
    }
    let total: i64 = count_query.fetch_one(&pool).await?.get("total");

    let logs: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<i64, _>("id"),
                "user_id": r.get::<Option<i32>, _>("user_id"),
                "action": r.get::<String, _>("action"),
                "request_method": r.get::<String, _>("request_method"),
                "request_path": r.get::<String, _>("request_path"),
                "response_status": r.get::<Option<i32>, _>("response_status"),
                "duration_ms": r.get::<Option<i32>, _>("duration_ms"),
                "ip_address": r.get::<Option<String>, _>("ip_address"),
                "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at").to_rfc3339(),
                "database_id": r.get::<Option<i32>, _>("database_id"),
                "sql_type": r.get::<Option<String>, _>("sql_type"),
                "sql_len": r.get::<Option<i32>, _>("sql_len"),
                "read_only": r.get::<Option<bool>, _>("read_only"),
                "acknowledge_destructive": r.get::<Option<bool>, _>("acknowledge_destructive"),
                "blocked_reason": r.get::<Option<String>, _>("blocked_reason"),
                "op_count": r.get::<Option<i32>, _>("op_count"),
            })
        })
        .collect();

    // 顺手算一下面板上常看的"被拦截统计"——同 where 条件，但按 blocked_reason 分组。
    let stats_sql = format!(
        "SELECT COALESCE(request_body->>'blocked_reason', 'ok') AS reason, COUNT(*) AS cnt \
         FROM management.audit_logs WHERE {} \
         GROUP BY 1 ORDER BY cnt DESC",
        where_clause
    );
    let mut stats_query = sqlx::query(&stats_sql);
    if let Some(uid) = params.user_id {
        stats_query = stats_query.bind(uid);
    }
    if let Some(did) = params.database_id {
        stats_query = stats_query.bind(did);
    }
    if let Some(ref act) = params.action {
        stats_query = stats_query.bind(act);
    }
    if let Some(ref sd) = params.start_date {
        stats_query = stats_query.bind(sd);
    }
    if let Some(ref ed) = params.end_date {
        stats_query = stats_query.bind(ed);
    }
    let stats_rows = stats_query.fetch_all(&pool).await?;
    let stats: Vec<serde_json::Value> = stats_rows
        .iter()
        .map(|r| {
            json!({
                "reason": r.get::<String, _>("reason"),
                "count": r.get::<i64, _>("cnt"),
            })
        })
        .collect();

    Ok(Json(json!({
        "data": logs,
        "total": total,
        "limit": limit,
        "offset": offset,
        "stats_by_reason": stats,
    })))
}
