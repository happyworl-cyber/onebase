//! 统一执行日志查询 API（P1）。
//!
//! 面向"汇总各类任务执行 + 快速定位问题"：
//!   - `GET /api/platform/executions`            执行索引列表（跨来源 + 多维筛选 + 分页）
//!   - `GET /api/platform/executions/:trace_id`  单次执行详情（索引行 + 细节日志时间线）
//!   - `GET /api/platform/executions/stats`      近 24h 概览（按来源/状态聚合）
//!
//! 权限：与 `audit_handlers::list_audit_logs` 一致——平台超管看全部；租户 owner/admin
//! 只看自己 `tenant_id` 的记录（`tenant_id IS NULL` 的平台级执行不返回给租户管理员）。

use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};

use crate::audit_handlers::admin_tenant_ids;
use crate::auth::Claims;
use crate::error::{AppError, Result};
use crate::permissions;

#[derive(Debug, Deserialize)]
pub struct ExecutionQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    /// 'api' | 'db' | 'workflow' | 'scheduler' | 'rpc'
    pub source: Option<String>,
    /// running|success|failed|timeout|cancelled
    pub status: Option<String>,
    pub user_id: Option<i32>,
    /// 显式限定租户（工作空间内查看时传当前项目 = 租户 id）。
    /// 对非超管会与其可管理租户集合求交，越权传入只会查到空结果。
    pub tenant_id: Option<i32>,
    /// 组织级聚合：限定为该组织下属全部项目（与身份可管理集合求交）。
    pub organization_id: Option<i32>,
    /// 名称模糊匹配（工作流名 / 任务名 / 路径）
    pub name: Option<String>,
    pub trace_id: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    /// 仅看失败 / 超时（排障主路径）
    pub failed_only: Option<bool>,
}

/// 计算 tenant 过滤：超管返回 `None`（不限制），租户 owner/admin 返回其可管理的 tenant_id 列表。
async fn tenant_scope(pool: &PgPool, claims: &Claims) -> Result<Option<Vec<i32>>> {
    if claims.is_superadmin {
        Ok(None)
    } else {
        let ids = admin_tenant_ids(pool, claims).await?;
        if ids.is_empty() {
            return Err(AppError::Forbidden(
                "需要平台超管或租户 owner/admin 角色才能查看执行日志".to_string(),
            ));
        }
        Ok(Some(ids))
    }
}

/// 解析执行日志可见项目集合。
///
/// - 带 `organization_id`：要求 org admin+，范围为该组织下属全部项目
///   （不要求调用方同时是每个项目的 owner/admin）
/// - 不带：沿用平台语义（超管全部 / 项目 owner·admin 自己的项目）
async fn resolve_execution_tenant_filter(
    pool: &PgPool,
    claims: &Claims,
    params: &ExecutionQuery,
) -> Result<Option<Vec<i32>>> {
    let Some(org_id) = params.organization_id else {
        return tenant_scope(pool, claims).await;
    };

    permissions::require_organization_admin(pool, claims, org_id).await?;
    let org_projects: Vec<i32> = sqlx::query_scalar(
        r#"
        SELECT id FROM management.tenants
        WHERE organization_id = $1 AND status IN ('active', 'suspended')
        "#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await?;
    Ok(Some(org_projects))
}

/// Exact COUNT 在百万行租户下会扫完整 btree；分页只需要「够不够翻页」的量级。
/// 超过该上限时返回 capped=true，UI 显示「N+」。
const EXECUTION_COUNT_CAP: i64 = 50_000;

/// 按可选筛选拼 WHERE 片段；返回 `(where_clause, 下一个占位符序号)`。
///
/// list（列表）与 count（总数）两个 handler 复用它，确保筛选语义与占位符顺序完全一致——
/// 否则绑定顺序一旦对不上就是隐蔽的错数/错查。
///
/// 租户条件：显式 `tenant_id` 时只用等值（可走 idx_ei_tenant）；否则非超管用 `ANY($租户列表)`。
/// 避免历史上 `ANY([1]) AND tenant_id = 1` 的重复谓词。
fn build_exec_conditions(
    params: &ExecutionQuery,
    tenant_filter: &Option<Vec<i32>>,
) -> (String, u32) {
    let mut conditions = vec!["1=1".to_string()];
    let mut idx = 1u32;

    if params.tenant_id.is_some() {
        conditions.push(format!("tenant_id = ${idx}"));
        idx += 1;
    } else if tenant_filter.is_some() {
        conditions.push(format!("tenant_id = ANY(${idx})"));
        idx += 1;
    }
    if params.source.is_some() {
        conditions.push(format!("source = ${idx}"));
        idx += 1;
    }
    if params.status.is_some() {
        conditions.push(format!("status = ${idx}"));
        idx += 1;
    }
    if params.user_id.is_some() {
        conditions.push(format!("user_id = ${idx}"));
        idx += 1;
    }
    if params.name.is_some() {
        conditions.push(format!("name ILIKE ${idx}"));
        idx += 1;
    }
    if params.trace_id.is_some() {
        conditions.push(format!("trace_id = ${idx}"));
        idx += 1;
    }
    if params.start_date.is_some() {
        conditions.push(format!("started_at >= ${idx}::timestamptz"));
        idx += 1;
    }
    if params.end_date.is_some() {
        conditions.push(format!("started_at <= ${idx}::timestamptz"));
        idx += 1;
    }
    if params.failed_only.unwrap_or(false) {
        conditions.push("status IN ('failed','timeout')".to_string());
    }

    (conditions.join(" AND "), idx)
}

/// 把 `build_exec_conditions` 里各筛选对应的值按同一顺序绑定到 query 上。
/// limit/offset 由调用方在其后自行 `.bind`（count 无需）。
fn bind_exec_filters<'a>(
    mut q: sqlx::query::Query<'a, sqlx::Postgres, sqlx::postgres::PgArguments>,
    params: &'a ExecutionQuery,
    tenant_filter: &'a Option<Vec<i32>>,
) -> sqlx::query::Query<'a, sqlx::Postgres, sqlx::postgres::PgArguments> {
    // 与 build_exec_conditions 顺序一致：先显式 tenant_id，否则再绑 ANY 列表。
    if let Some(v) = params.tenant_id {
        q = q.bind(v);
    } else if let Some(ref ids) = tenant_filter {
        q = q.bind(ids);
    }
    if let Some(ref v) = params.source {
        q = q.bind(v);
    }
    if let Some(ref v) = params.status {
        q = q.bind(v);
    }
    if let Some(v) = params.user_id {
        q = q.bind(v);
    }
    if let Some(ref v) = params.name {
        q = q.bind(format!("%{v}%"));
    }
    if let Some(ref v) = params.trace_id {
        q = q.bind(v);
    }
    if let Some(ref v) = params.start_date {
        q = q.bind(v);
    }
    if let Some(ref v) = params.end_date {
        q = q.bind(v);
    }
    q
}

/// GET /api/platform/executions
///
/// 只返回列表数据（走 idx_ei_tenant 有序索引，毫秒级）。总数不在这里算——由独立的
/// `count_executions`（/api/platform/execution-count）按需返回，翻页时不再重复计数。
pub async fn list_executions(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(params): Query<ExecutionQuery>,
) -> Result<Json<Value>> {
    let limit = params.limit.unwrap_or(50).clamp(1, 200);
    let offset = params.offset.unwrap_or(0).max(0);

    let tenant_filter = resolve_execution_tenant_filter(&pool, &claims, &params).await?;
    if matches!(tenant_filter.as_deref(), Some([])) {
        return Ok(Json(json!({
            "data": [],
            "limit": limit,
            "offset": offset,
        })));
    }
    if let (Some(tid), Some(ids)) = (params.tenant_id, tenant_filter.as_ref()) {
        if !ids.contains(&tid) {
            return Ok(Json(json!({
                "data": [],
                "limit": limit,
                "offset": offset,
            })));
        }
    }

    let (where_clause, idx) = build_exec_conditions(&params, &tenant_filter);
    let sql = format!(
        "SELECT id, trace_id, source, ref_table, ref_id, tenant_id, user_id, name, \
                status, started_at, finished_at, duration_ms, error_brief \
         FROM management.execution_index \
         WHERE {where_clause} \
         ORDER BY started_at DESC \
         LIMIT ${} OFFSET ${}",
        idx,
        idx + 1
    );

    // 筛选值按 build_exec_conditions 的顺序绑定，最后再绑 limit/offset。
    let mut q = bind_exec_filters(sqlx::query(&sql), &params, &tenant_filter);
    q = q.bind(limit).bind(offset);

    let rows = q.fetch_all(&pool).await?;
    let data: Vec<Value> = rows.iter().map(row_to_index_json).collect();

    Ok(Json(json!({
        "data": data,
        "limit": limit,
        "offset": offset,
    })))
}

/// GET /api/platform/execution-count
///
/// 与 `list_executions` 共享同一套筛选。前端仅在**筛选条件变化时**请求一次。
///
/// 百万行租户上精确 `COUNT(*)` 会扫完整匹配索引，往往数秒～数十秒。这里改为
/// `COUNT(*) FROM (SELECT 1 … LIMIT cap+1)`：找到 cap+1 行即停，返回
/// `{ total: cap, capped: true }`；不足则返回精确值。列表本身仍走 LIMIT 分页，不受影响。
pub async fn count_executions(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(params): Query<ExecutionQuery>,
) -> Result<Json<Value>> {
    let tenant_filter = resolve_execution_tenant_filter(&pool, &claims, &params).await?;
    if matches!(tenant_filter.as_deref(), Some([])) {
        return Ok(Json(
            json!({ "total": 0, "capped": false, "cap": EXECUTION_COUNT_CAP }),
        ));
    }
    // 显式 tenant_id：必须落在可管理 / 组织集合内，越权直接空结果。
    if let (Some(tid), Some(ids)) = (params.tenant_id, tenant_filter.as_ref()) {
        if !ids.contains(&tid) {
            return Ok(Json(
                json!({ "total": 0, "capped": false, "cap": EXECUTION_COUNT_CAP }),
            ));
        }
    }

    let (where_clause, _) = build_exec_conditions(&params, &tenant_filter);
    let scan_limit = EXECUTION_COUNT_CAP + 1;
    let count_sql = format!(
        "SELECT COUNT(*)::bigint AS total FROM (\
           SELECT 1 FROM management.execution_index \
           WHERE {where_clause} \
           LIMIT {scan_limit}\
         ) AS capped_scan"
    );
    let cq = bind_exec_filters(sqlx::query(&count_sql), &params, &tenant_filter);
    let scanned: i64 = cq.fetch_one(&pool).await?.get("total");
    let capped = scanned > EXECUTION_COUNT_CAP;
    let total = if capped { EXECUTION_COUNT_CAP } else { scanned };

    Ok(Json(json!({
        "total": total,
        "capped": capped,
        "cap": EXECUTION_COUNT_CAP,
    })))
}

/// GET /api/platform/executions/:trace_id
///
/// 返回该 trace 的索引行（可能多行，如重试）+ 细节日志时间线（按 ts 升序）。
pub async fn get_execution_detail(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(trace_id): Path<String>,
) -> Result<Json<Value>> {
    let tenant_filter = tenant_scope(&pool, &claims).await?;

    let index_rows = sqlx::query(
        "SELECT id, trace_id, source, ref_table, ref_id, tenant_id, user_id, name, \
                status, started_at, finished_at, duration_ms, error_brief \
         FROM management.execution_index \
         WHERE trace_id = $1 \
         ORDER BY started_at ASC",
    )
    .bind(&trace_id)
    .fetch_all(&pool)
    .await?;

    if index_rows.is_empty() {
        return Err(AppError::NotFound("未找到该执行记录".to_string()));
    }

    // 租户隔离：项目 owner/admin，或该项目所属组织的 org admin+。
    if let Some(ref ids) = tenant_filter {
        let mut allowed = index_rows.iter().any(|r| {
            r.get::<Option<i32>, _>("tenant_id")
                .map(|t| ids.contains(&t))
                .unwrap_or(false)
        });
        if !allowed {
            let trace_tenants: Vec<i32> = index_rows
                .iter()
                .filter_map(|r| r.get::<Option<i32>, _>("tenant_id"))
                .collect();
            if !trace_tenants.is_empty() {
                allowed = sqlx::query_scalar(
                    r#"
                    SELECT EXISTS(
                        SELECT 1
                        FROM management.tenants t
                        JOIN management.organization_members om
                          ON om.organization_id = t.organization_id
                         AND om.user_id = $2
                         AND om.is_active = true
                         AND om.role IN ('owner', 'admin')
                        WHERE t.id = ANY($1)
                    )
                    "#,
                )
                .bind(&trace_tenants)
                .bind(claims.sub)
                .fetch_one(&pool)
                .await?;
            }
        }
        if !allowed {
            return Err(AppError::Forbidden("无权查看该执行记录".to_string()));
        }
    }

    let log_rows = sqlx::query(
        "SELECT id, ts, level, source, logger, span, message, fields \
         FROM management.execution_logs \
         WHERE trace_id = $1 \
         ORDER BY ts ASC, id ASC \
         LIMIT 5000",
    )
    .bind(&trace_id)
    .fetch_all(&pool)
    .await?;

    // 索引行 + 回查权威 run 表的输入/输出等细节（这是"够详细"的关键来源）。
    let mut index: Vec<Value> = Vec::with_capacity(index_rows.len());
    for r in &index_rows {
        let mut v = row_to_index_json(r);
        let ref_table = r.get::<Option<String>, _>("ref_table");
        let ref_id = r.get::<Option<i64>, _>("ref_id");
        if let (Some(rt), Some(rid)) = (ref_table.as_deref(), ref_id) {
            if let Some(detail) = fetch_ref_detail(&pool, rt, rid).await {
                v["detail"] = detail;
            }
        }
        index.push(v);
    }
    let logs: Vec<Value> = log_rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<i64, _>("id"),
                "ts": r.get::<chrono::DateTime<chrono::Utc>, _>("ts").to_rfc3339(),
                "level": r.get::<String, _>("level"),
                "source": r.get::<Option<String>, _>("source"),
                "logger": r.get::<Option<String>, _>("logger"),
                "span": r.get::<Option<String>, _>("span"),
                "message": r.get::<String, _>("message"),
                "fields": r.get::<Option<Value>, _>("fields"),
            })
        })
        .collect();

    Ok(Json(json!({
        "trace_id": trace_id,
        "index": index,
        "logs": logs,
    })))
}

/// GET /api/platform/executions/stats
///
/// 近 24h 按 source × status 聚合，给概览面板用。
pub async fn execution_stats(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(params): Query<ExecutionQuery>,
) -> Result<Json<Value>> {
    let tenant_filter = resolve_execution_tenant_filter(&pool, &claims, &params).await?;
    if matches!(tenant_filter.as_deref(), Some([])) {
        return Ok(Json(json!({ "by_source": [], "by_status": [] })));
    }

    let mut conditions = vec!["started_at >= NOW() - INTERVAL '24 hours'".to_string()];
    // 与列表/count 一致：显式 tenant_id 用等值，否则非超管用 ANY。
    if params.tenant_id.is_some() {
        conditions.push("tenant_id = $1".to_string());
    } else if tenant_filter.is_some() {
        conditions.push("tenant_id = ANY($1)".to_string());
    }
    let where_clause = conditions.join(" AND ");
    let sql = format!(
        "SELECT source, status, COUNT(*) AS cnt \
         FROM management.execution_index \
         WHERE {where_clause} \
         GROUP BY source, status"
    );

    let mut q = sqlx::query(&sql);
    if let Some(v) = params.tenant_id {
        q = q.bind(v);
    } else if let Some(ref ids) = tenant_filter {
        q = q.bind(ids);
    }
    let rows = q.fetch_all(&pool).await?;

    let stats: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "source": r.get::<String, _>("source"),
                "status": r.get::<String, _>("status"),
                "count": r.get::<i64, _>("cnt"),
            })
        })
        .collect();

    Ok(Json(json!({ "window": "24h", "stats": stats })))
}

/// 回查权威 run 表，取出该次执行的输入/输出等细节，归一成统一 JSON。
///
/// 这是详情页"够详细"的核心：执行索引层只存摘要，真正的入参 / 出参 / 逐节点结果都在
/// 各来源自己的 run 表里（见 022/014/009 迁移）。靠 `ref_table` + `ref_id` 精确回查。
/// 任何查询失败都返回 `None`（详情页降级为只展示索引摘要，不报错）。
async fn fetch_ref_detail(pool: &PgPool, ref_table: &str, ref_id: i64) -> Option<Value> {
    match ref_table {
        "workflow_runs" => {
            let r = sqlx::query(
                "SELECT trigger_type, trigger_data, node_results, final_output, \
                        error_message, elapsed_ms, status \
                 FROM management.workflow_runs WHERE id = $1",
            )
            .bind(ref_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()?;
            Some(json!({
                "kind": "workflow",
                "trigger_type": r.get::<Option<String>, _>("trigger_type"),
                "input": r.get::<Option<Value>, _>("trigger_data"),
                "node_results": r.get::<Option<Value>, _>("node_results"),
                "output": r.get::<Option<Value>, _>("final_output"),
                "error": r.get::<Option<String>, _>("error_message"),
                "elapsed_ms": r.get::<Option<i64>, _>("elapsed_ms"),
                "status": r.get::<Option<String>, _>("status"),
            }))
        }
        "scheduled_task_runs" => {
            let r = sqlx::query(
                "SELECT r.output, r.error_message, r.duration_ms, r.attempt_number, \
                        r.triggered_by, r.status, t.kind, t.name AS task_name, \
                        t.rpc_schema, t.rpc_fn_name, t.rpc_args, \
                        t.http_method, t.http_url, t.http_body \
                 FROM management.scheduled_task_runs r \
                 JOIN management.scheduled_tasks t ON t.id = r.task_id \
                 WHERE r.id = $1",
            )
            .bind(ref_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()?;
            let kind = r.get::<Option<String>, _>("kind").unwrap_or_default();
            // 输入按任务类型组织：rpc 看 schema/函数/参数；http 看方法/URL/body。
            let input = if kind == "rpc" {
                json!({
                    "rpc_schema": r.get::<Option<String>, _>("rpc_schema"),
                    "rpc_fn_name": r.get::<Option<String>, _>("rpc_fn_name"),
                    "rpc_args": r.get::<Option<Value>, _>("rpc_args"),
                })
            } else {
                json!({
                    "http_method": r.get::<Option<String>, _>("http_method"),
                    "http_url": r.get::<Option<String>, _>("http_url"),
                    "http_body": r.get::<Option<Value>, _>("http_body"),
                })
            };
            Some(json!({
                "kind": "scheduler",
                "task_name": r.get::<Option<String>, _>("task_name"),
                "task_kind": kind,
                "triggered_by": r.get::<Option<String>, _>("triggered_by"),
                "attempt_number": r.get::<Option<i32>, _>("attempt_number"),
                "input": input,
                "output": r.get::<Option<Value>, _>("output"),
                "error": r.get::<Option<String>, _>("error_message"),
                "duration_ms": r.get::<Option<i32>, _>("duration_ms"),
                "status": r.get::<Option<String>, _>("status"),
            }))
        }
        "audit_logs" => {
            let r = sqlx::query(
                "SELECT request_method, request_path, request_body, response_status, \
                        user_agent, ip_address, duration_ms \
                 FROM management.audit_logs WHERE id = $1",
            )
            .bind(ref_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()?;
            Some(json!({
                "kind": "api",
                "request_method": r.get::<Option<String>, _>("request_method"),
                "request_path": r.get::<Option<String>, _>("request_path"),
                "input": r.get::<Option<Value>, _>("request_body"),
                "response_status": r.get::<Option<i32>, _>("response_status"),
                "user_agent": r.get::<Option<String>, _>("user_agent"),
                "ip_address": r.get::<Option<String>, _>("ip_address"),
                "duration_ms": r.get::<Option<i32>, _>("duration_ms"),
            }))
        }
        _ => None,
    }
}

fn row_to_index_json(r: &sqlx::postgres::PgRow) -> Value {
    json!({
        "id": r.get::<i64, _>("id"),
        "trace_id": r.get::<String, _>("trace_id"),
        "source": r.get::<String, _>("source"),
        "ref_table": r.get::<Option<String>, _>("ref_table"),
        "ref_id": r.get::<Option<i64>, _>("ref_id"),
        "tenant_id": r.get::<Option<i32>, _>("tenant_id"),
        "user_id": r.get::<Option<i32>, _>("user_id"),
        "name": r.get::<Option<String>, _>("name"),
        "status": r.get::<String, _>("status"),
        "started_at": r.get::<chrono::DateTime<chrono::Utc>, _>("started_at").to_rfc3339(),
        "finished_at": r
            .get::<Option<chrono::DateTime<chrono::Utc>>, _>("finished_at")
            .map(|t| t.to_rfc3339()),
        "duration_ms": r.get::<Option<i32>, _>("duration_ms"),
        "error_brief": r.get::<Option<String>, _>("error_brief"),
    })
}
