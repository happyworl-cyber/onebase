//! SSE NOTIFY 监听桥的管理 API（CRUD）+ 只读监控
//!
//! 监听桥语义见 `src/sse_notify_bridge.rs`：按 `management.sse_notify_bridges` 的每条配置
//! `LISTEN` 业务库的某个 channel，收到 `NOTIFY` 后按 `topic_template` 算出 SSE topic 推送。
//! 管理任务每 10s 重读配置，故本 API 的增删改会自动生效，无需重启。
//!
//! 鉴权：监听桥按 `database_id` 归属租户（经 `management.tenant_databases`），CRUD 走
//! `permissions::require_tenant_admin`（与 `sse_route_handlers` 一致）。
//! stats 是**进程全局**视图（本实例所有 listener + 所有 SSE 连接），故限超管访问。

use std::collections::{BTreeMap, HashMap};

use axum::{
    extract::{Extension, Path, Query, State},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::{PgPool, Row};

use crate::auth::Claims;
use crate::error::{AppError, Result};
use crate::permissions;
use crate::sse::SseHub;
use crate::sse_notify_bridge::BridgeMetrics;

// ───── CRUD ────────────────────────────────────────────────

const SELECT_COLS: &str = "b.id, b.database_id, d.tenant_id, b.channel, b.topic_template, \
     b.event_name, b.is_active";

fn row_to_json(r: &sqlx::postgres::PgRow) -> serde_json::Value {
    json!({
        "id": r.get::<i32, _>("id"),
        "database_id": r.get::<i32, _>("database_id"),
        "tenant_id": r.get::<i32, _>("tenant_id"),
        "channel": r.get::<String, _>("channel"),
        "topic_template": r.get::<String, _>("topic_template"),
        "event_name": r.get::<String, _>("event_name"),
        "is_active": r.get::<bool, _>("is_active"),
    })
}

/// 解析 database_id 所属租户，并要求当前用户是该租户管理员；返回 tenant_id。
async fn require_admin_for_database(
    pool: &PgPool,
    claims: &Claims,
    database_id: i32,
) -> Result<i32> {
    let tenant_id: i32 =
        sqlx::query_scalar("SELECT tenant_id FROM management.tenant_databases WHERE id = $1")
            .bind(database_id)
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| AppError::InvalidQuery(format!("数据库 {} 不存在", database_id)))?;
    permissions::require_tenant_admin(pool, claims, tenant_id).await?;
    Ok(tenant_id)
}

/// 已存在桥所属库归当前用户的租户管辖；返回该桥的 database_id。
async fn require_admin_for_existing_bridge(
    pool: &PgPool,
    claims: &Claims,
    bridge_id: i32,
) -> Result<i32> {
    let database_id: i32 =
        sqlx::query_scalar("SELECT database_id FROM management.sse_notify_bridges WHERE id = $1")
            .bind(bridge_id)
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("监听桥 {} 不存在", bridge_id)))?;
    require_admin_for_database(pool, claims, database_id).await?;
    Ok(database_id)
}

#[derive(Debug, Deserialize)]
pub struct CreateBridge {
    pub database_id: i32,
    pub channel: String,
    pub topic_template: String,
    pub event_name: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateBridge {
    pub channel: Option<String>,
    pub topic_template: Option<String>,
    pub event_name: Option<String>,
    pub is_active: Option<bool>,
}

/// `GET /api/admin/sse-notify-bridges` — 超管全量；租户 admin 仅本租户的库。
///
/// 可选 query `tenant_id`：传了就只看该租户（需是其 admin），用于前端在某个项目
/// 上下文里收敛可见范围，避免跨多租户的 admin 在 A 项目看到 B 项目的监听桥
/// （与 `sse_route_handlers::list_routes` 行为一致）。
pub async fn list_bridges(
    State(pool): State<PgPool>,
    Query(params): Query<HashMap<String, String>>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<serde_json::Value>> {
    let tenant_id: Option<i32> = params.get("tenant_id").and_then(|v| v.parse().ok());

    let rows = if let Some(tid) = tenant_id {
        permissions::require_tenant_admin(&pool, &claims, tid).await?;
        sqlx::query(&format!(
            "SELECT {SELECT_COLS} FROM management.sse_notify_bridges b \
             JOIN management.tenant_databases d ON d.id = b.database_id \
             WHERE d.tenant_id = $1 ORDER BY b.id"
        ))
        .bind(tid)
        .fetch_all(&pool)
        .await?
    } else if claims.is_superadmin {
        sqlx::query(&format!(
            "SELECT {SELECT_COLS} FROM management.sse_notify_bridges b \
             JOIN management.tenant_databases d ON d.id = b.database_id ORDER BY b.id"
        ))
        .fetch_all(&pool)
        .await?
    } else {
        let tenant_ids = permissions::tenant_admin_ids(&pool, &claims).await?;
        if tenant_ids.is_empty() {
            return Ok(Json(json!({ "data": [] })));
        }
        sqlx::query(&format!(
            "SELECT {SELECT_COLS} FROM management.sse_notify_bridges b \
             JOIN management.tenant_databases d ON d.id = b.database_id \
             WHERE d.tenant_id = ANY($1) ORDER BY b.id"
        ))
        .bind(&tenant_ids)
        .fetch_all(&pool)
        .await?
    };

    let data: Vec<serde_json::Value> = rows.iter().map(row_to_json).collect();
    Ok(Json(json!({ "data": data })))
}

/// `POST /api/admin/sse-notify-bridges`
pub async fn create_bridge(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<CreateBridge>,
) -> Result<Json<serde_json::Value>> {
    require_admin_for_database(&pool, &claims, body.database_id).await?;

    let channel = body.channel.trim();
    let topic_template = body.topic_template.trim();
    let event_name = body.event_name.trim();
    if channel.is_empty() {
        return Err(AppError::InvalidQuery("channel 不能为空".to_string()));
    }
    if channel.len() > 63 {
        return Err(AppError::InvalidQuery(
            "channel 长度不能超过 63".to_string(),
        ));
    }
    if topic_template.is_empty() {
        return Err(AppError::InvalidQuery("topic 模板不能为空".to_string()));
    }
    if event_name.is_empty() {
        return Err(AppError::InvalidQuery("event 名不能为空".to_string()));
    }

    let row = sqlx::query(
        "INSERT INTO management.sse_notify_bridges \
            (database_id, channel, topic_template, event_name) \
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(body.database_id)
    .bind(channel)
    .bind(topic_template)
    .bind(event_name)
    .fetch_one(&pool)
    .await?;

    let id: i32 = row.get("id");
    Ok(Json(
        json!({ "data": { "id": id }, "message": "监听桥创建成功" }),
    ))
}

/// `PATCH /api/admin/sse-notify-bridges/:id`
pub async fn update_bridge(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i32>,
    Json(body): Json<UpdateBridge>,
) -> Result<Json<serde_json::Value>> {
    require_admin_for_existing_bridge(&pool, &claims, id).await?;

    let result = sqlx::query(
        "UPDATE management.sse_notify_bridges SET \
            channel = COALESCE($2, channel), \
            topic_template = COALESCE($3, topic_template), \
            event_name = COALESCE($4, event_name), \
            is_active = COALESCE($5, is_active) \
         WHERE id = $1",
    )
    .bind(id)
    .bind(body.channel.as_deref().map(str::trim))
    .bind(body.topic_template.as_deref().map(str::trim))
    .bind(body.event_name.as_deref().map(str::trim))
    .bind(body.is_active)
    .execute(&pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("监听桥 {} 不存在", id)));
    }
    Ok(Json(json!({ "message": "更新成功" })))
}

/// `DELETE /api/admin/sse-notify-bridges/:id`
pub async fn delete_bridge(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i32>,
) -> Result<Json<serde_json::Value>> {
    require_admin_for_existing_bridge(&pool, &claims, id).await?;
    let result = sqlx::query("DELETE FROM management.sse_notify_bridges WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("监听桥 {} 不存在", id)));
    }
    Ok(Json(json!({ "message": "删除成功" })))
}

// ───── 只读监控 ─────────────────────────────────────────────

/// `GET /api/admin/sse-notify-bridges/stats`（挂 `auth_middleware`，限超管）
pub async fn stats(
    Extension(claims): Extension<Claims>,
    Extension(hub): Extension<SseHub>,
    Extension(metrics): Extension<BridgeMetrics>,
) -> Result<Json<serde_json::Value>> {
    // 平台超管限制已移除：任何已认证用户均可查看推送监控。
    let _ = &claims;

    let listeners = metrics.snapshot();

    let conns = hub.connection_metas();
    let total = conns.len();
    let public = conns.iter().filter(|c| c.kind == "public").count();
    let generic = conns.iter().filter(|c| c.kind == "sse").count();

    // 按端点 slug 聚合对外端点连接。
    let mut by_endpoint: BTreeMap<String, usize> = BTreeMap::new();
    for c in conns.iter().filter(|c| c.kind == "public") {
        let slug = c
            .endpoint_slug
            .clone()
            .unwrap_or_else(|| "(unknown)".to_string());
        *by_endpoint.entry(slug).or_insert(0) += 1;
    }
    let by_endpoint: Vec<serde_json::Value> = by_endpoint
        .into_iter()
        .map(|(slug, count)| json!({ "slug": slug, "count": count }))
        .collect();

    Ok(Json(json!({
        "listeners": listeners,
        "connections": {
            "total": total,
            "public": public,
            "generic": generic,
            "by_endpoint": by_endpoint,
        },
        "pushes_total": hub.pushes_total(),
    })))
}
