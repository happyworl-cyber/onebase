//! 通用对外订阅端点（management.sse_public_endpoints）的管理 API（CRUD）
//!
//! 端点语义见 `src/sse.rs` 的 `public_event_handler`：GET /events/{slug} 按本表配置驱动。
//! 鉴权：端点按 tenant_id 归属租户，CRUD 走 permissions::require_tenant_admin
//! （与 sse_route_handlers / sse_notify_bridge_handlers 一致）。

use std::collections::HashMap;

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
use crate::sse::validate_topic_template;

const SELECT_COLS: &str =
    "id, tenant_id, slug, name, identity_header, topic_template, event_name, is_active";

fn row_to_json(r: &sqlx::postgres::PgRow) -> serde_json::Value {
    json!({
        "id": r.get::<i32, _>("id"),
        "tenant_id": r.get::<i32, _>("tenant_id"),
        "slug": r.get::<String, _>("slug"),
        "name": r.get::<String, _>("name"),
        "identity_header": r.get::<String, _>("identity_header"),
        "topic_template": r.get::<String, _>("topic_template"),
        "event_name": r.get::<String, _>("event_name"),
        "is_active": r.get::<bool, _>("is_active"),
    })
}

/// 已存在端点是否归当前用户的租户管辖；返回 tenant_id。
async fn require_admin_for_existing(pool: &PgPool, claims: &Claims, id: i32) -> Result<i32> {
    let tenant_id: i32 =
        sqlx::query_scalar("SELECT tenant_id FROM management.sse_public_endpoints WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("对外端点 {} 不存在", id)))?;
    permissions::require_tenant_admin(pool, claims, tenant_id).await?;
    Ok(tenant_id)
}

/// slug 仅允许 [a-z0-9-]，长度 1..=64。
fn validate_slug(slug: &str) -> Result<()> {
    if slug.is_empty() || slug.len() > 64 {
        return Err(AppError::InvalidQuery("slug 长度需为 1..=64".to_string()));
    }
    if !slug
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(AppError::InvalidQuery(
            "slug 仅允许小写字母、数字、连字符".to_string(),
        ));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct CreateEndpoint {
    pub tenant_id: i32,
    pub slug: String,
    pub name: String,
    pub identity_header: String,
    pub topic_template: String,
    pub event_name: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateEndpoint {
    pub name: Option<String>,
    pub identity_header: Option<String>,
    pub topic_template: Option<String>,
    pub event_name: Option<String>,
    pub is_active: Option<bool>,
}

/// GET /api/admin/sse-public-endpoints — 超管全量；租户 admin 仅本租户。
///
/// 可选 query `tenant_id`：传了就只看该租户（需是其 admin），用于前端在某个项目
/// 上下文里收敛可见范围（与 `sse_route_handlers::list_routes` 行为一致）。
pub async fn list_endpoints(
    State(pool): State<PgPool>,
    Query(params): Query<HashMap<String, String>>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<serde_json::Value>> {
    let tenant_id: Option<i32> = params.get("tenant_id").and_then(|v| v.parse().ok());

    let rows = if let Some(tid) = tenant_id {
        permissions::require_tenant_admin(&pool, &claims, tid).await?;
        sqlx::query(&format!(
            "SELECT {SELECT_COLS} FROM management.sse_public_endpoints \
             WHERE tenant_id = $1 ORDER BY id"
        ))
        .bind(tid)
        .fetch_all(&pool)
        .await?
    } else if claims.is_superadmin {
        sqlx::query(&format!(
            "SELECT {SELECT_COLS} FROM management.sse_public_endpoints ORDER BY id"
        ))
        .fetch_all(&pool)
        .await?
    } else {
        let tenant_ids = permissions::tenant_admin_ids(&pool, &claims).await?;
        if tenant_ids.is_empty() {
            return Ok(Json(json!({ "data": [] })));
        }
        sqlx::query(&format!(
            "SELECT {SELECT_COLS} FROM management.sse_public_endpoints \
             WHERE tenant_id = ANY($1) ORDER BY id"
        ))
        .bind(&tenant_ids)
        .fetch_all(&pool)
        .await?
    };
    let data: Vec<serde_json::Value> = rows.iter().map(row_to_json).collect();
    Ok(Json(json!({ "data": data })))
}

/// POST /api/admin/sse-public-endpoints
pub async fn create_endpoint(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<CreateEndpoint>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_admin(&pool, &claims, body.tenant_id).await?;

    let slug = body.slug.trim();
    let name = body.name.trim();
    let identity_header = body.identity_header.trim();
    let topic_template = body.topic_template.trim();
    let event_name = body.event_name.trim();
    validate_slug(slug)?;
    if name.is_empty() || identity_header.is_empty() || event_name.is_empty() {
        return Err(AppError::InvalidQuery(
            "名称/身份头/event 名不能为空".to_string(),
        ));
    }
    validate_topic_template(topic_template).map_err(AppError::InvalidQuery)?;

    let row = sqlx::query(
        "INSERT INTO management.sse_public_endpoints \
            (tenant_id, slug, name, identity_header, topic_template, event_name) \
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    )
    .bind(body.tenant_id)
    .bind(slug)
    .bind(name)
    .bind(identity_header)
    .bind(topic_template)
    .bind(event_name)
    .fetch_one(&pool)
    .await?;

    let id: i32 = row.get("id");
    Ok(Json(
        json!({ "data": { "id": id }, "message": "对外端点创建成功" }),
    ))
}

/// PATCH /api/admin/sse-public-endpoints/:id
pub async fn update_endpoint(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i32>,
    Json(body): Json<UpdateEndpoint>,
) -> Result<Json<serde_json::Value>> {
    require_admin_for_existing(&pool, &claims, id).await?;

    if let Some(t) = body.topic_template.as_deref().map(str::trim) {
        validate_topic_template(t).map_err(AppError::InvalidQuery)?;
    }

    let result = sqlx::query(
        "UPDATE management.sse_public_endpoints SET \
            name = COALESCE($2, name), \
            identity_header = COALESCE($3, identity_header), \
            topic_template = COALESCE($4, topic_template), \
            event_name = COALESCE($5, event_name), \
            is_active = COALESCE($6, is_active) \
         WHERE id = $1",
    )
    .bind(id)
    .bind(body.name.as_deref().map(str::trim))
    .bind(body.identity_header.as_deref().map(str::trim))
    .bind(body.topic_template.as_deref().map(str::trim))
    .bind(body.event_name.as_deref().map(str::trim))
    .bind(body.is_active)
    .execute(&pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("对外端点 {} 不存在", id)));
    }
    Ok(Json(json!({ "message": "更新成功" })))
}

/// DELETE /api/admin/sse-public-endpoints/:id
pub async fn delete_endpoint(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i32>,
) -> Result<Json<serde_json::Value>> {
    require_admin_for_existing(&pool, &claims, id).await?;
    let result = sqlx::query("DELETE FROM management.sse_public_endpoints WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("对外端点 {} 不存在", id)));
    }
    Ok(Json(json!({ "message": "删除成功" })))
}
