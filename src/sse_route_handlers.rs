//! SSE 转发/路由规则的管理 API（CRUD）
//!
//! 镜像 `webhook_handlers`：挂 `auth_middleware`，租户管理员鉴权
//! （`permissions::require_tenant_admin`）。规则语义见 `sse_route_manager`。

use axum::{
    extract::{Extension, Path, Query, State},
    Json,
};
use serde::{Deserialize, Deserializer};
use serde_json::json;
use sqlx::{PgPool, Row};
use std::collections::HashMap;

use crate::auth::Claims;
use crate::error::{AppError, Result};
use crate::permissions;

/// 已存在的规则是否归当前用户的租户管辖；返回该规则的 tenant_id。
async fn require_admin_for_existing_route(
    pool: &PgPool,
    claims: &Claims,
    route_id: i32,
) -> Result<i32> {
    let row = sqlx::query("SELECT tenant_id FROM management.sse_routes WHERE id = $1")
        .bind(route_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("SSE 路由规则 {} 不存在", route_id)))?;
    let tenant_id: i32 = row.get("tenant_id");
    permissions::require_tenant_admin(pool, claims, tenant_id).await?;
    Ok(tenant_id)
}

#[derive(Debug, Deserialize)]
pub struct CreateSseRoute {
    pub tenant_id: i32,
    pub name: String,
    pub database_id: Option<i32>,
    pub event_pattern: String,
    pub topic_template: String,
    pub event_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateSseRoute {
    pub name: Option<String>,
    /// 双层 Option 区分三态：字段缺省（None，保持原值）/ 显式 null（Some(None)，置为
    /// 「该租户所有库」）/ 显式数字（Some(Some(id))）。普通 `Option<i32>` 无法表达前两者的区别。
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub database_id: Option<Option<i32>>,
    pub event_pattern: Option<String>,
    pub topic_template: Option<String>,
    pub event_name: Option<String>,
    pub is_active: Option<bool>,
}

/// 把出现的字段（含 null）解析成 `Some(...)`，缺省字段由 `#[serde(default)]` 给 `None`。
fn deserialize_double_option<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<Option<i32>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<i32>::deserialize(deserializer).map(Some)
}

fn row_to_json(r: &sqlx::postgres::PgRow) -> serde_json::Value {
    json!({
        "id": r.get::<i32, _>("id"),
        "tenant_id": r.get::<i32, _>("tenant_id"),
        "name": r.get::<String, _>("name"),
        "database_id": r.get::<Option<i32>, _>("database_id"),
        "event_pattern": r.get::<String, _>("event_pattern"),
        "topic_template": r.get::<String, _>("topic_template"),
        "event_name": r.get::<Option<String>, _>("event_name"),
        "is_active": r.get::<bool, _>("is_active"),
    })
}

const SELECT_COLS: &str =
    "id, tenant_id, name, database_id, event_pattern, topic_template, event_name, is_active";

/// GET /api/admin/sse-routes — 超管全量；租户 admin 仅本租户。
pub async fn list_routes(
    State(pool): State<PgPool>,
    Query(params): Query<HashMap<String, String>>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<serde_json::Value>> {
    let tenant_id: Option<i32> = params.get("tenant_id").and_then(|v| v.parse().ok());

    let rows = if let Some(tid) = tenant_id {
        permissions::require_tenant_admin(&pool, &claims, tid).await?;
        sqlx::query(&format!(
            "SELECT {SELECT_COLS} FROM management.sse_routes WHERE tenant_id = $1 ORDER BY id"
        ))
        .bind(tid)
        .fetch_all(&pool)
        .await?
    } else if claims.is_superadmin {
        sqlx::query(&format!(
            "SELECT {SELECT_COLS} FROM management.sse_routes ORDER BY id"
        ))
        .fetch_all(&pool)
        .await?
    } else {
        let tenant_ids = permissions::tenant_admin_ids(&pool, &claims).await?;
        if tenant_ids.is_empty() {
            return Ok(Json(json!({ "data": [] })));
        }
        sqlx::query(&format!(
            "SELECT {SELECT_COLS} FROM management.sse_routes WHERE tenant_id = ANY($1) ORDER BY id"
        ))
        .bind(&tenant_ids)
        .fetch_all(&pool)
        .await?
    };

    let data: Vec<serde_json::Value> = rows.iter().map(row_to_json).collect();
    Ok(Json(json!({ "data": data })))
}

/// POST /api/admin/sse-routes
pub async fn create_route(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<CreateSseRoute>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_admin(&pool, &claims, body.tenant_id).await?;

    if body.name.trim().is_empty() {
        return Err(AppError::InvalidQuery("规则名不能为空".to_string()));
    }
    if body.event_pattern.trim().is_empty() {
        return Err(AppError::InvalidQuery("事件模式不能为空".to_string()));
    }
    if body.topic_template.trim().is_empty() {
        return Err(AppError::InvalidQuery("topic 模板不能为空".to_string()));
    }

    let row = sqlx::query(
        "INSERT INTO management.sse_routes \
            (tenant_id, name, database_id, event_pattern, topic_template, event_name) \
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    )
    .bind(body.tenant_id)
    .bind(&body.name)
    .bind(body.database_id)
    .bind(&body.event_pattern)
    .bind(&body.topic_template)
    .bind(&body.event_name)
    .fetch_one(&pool)
    .await?;

    let id: i32 = row.get("id");
    Ok(Json(
        json!({ "data": { "id": id }, "message": "SSE 路由规则创建成功" }),
    ))
}

/// PATCH /api/admin/sse-routes/:id
pub async fn update_route(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i32>,
    Json(body): Json<UpdateSseRoute>,
) -> Result<Json<serde_json::Value>> {
    require_admin_for_existing_route(&pool, &claims, id).await?;

    // database_id 用单独的标志位区分「不改」与「显式置 NULL」：
    // COALESCE 无法表达「把 database_id 改成 NULL」，所以这里用 $N IS NULL 控制开关。
    let result = sqlx::query(
        "UPDATE management.sse_routes SET \
            name = COALESCE($2, name), \
            database_id = CASE WHEN $3 THEN $4 ELSE database_id END, \
            event_pattern = COALESCE($5, event_pattern), \
            topic_template = COALESCE($6, topic_template), \
            event_name = COALESCE($7, event_name), \
            is_active = COALESCE($8, is_active) \
         WHERE id = $1",
    )
    .bind(id)
    .bind(&body.name)
    // $3：请求体里是否出现了 database_id 字段（含显式 null）→ 决定是否改；
    // $4：要改成的值（null = 该租户所有库）。
    .bind(body.database_id.is_some())
    .bind(body.database_id.flatten())
    .bind(&body.event_pattern)
    .bind(&body.topic_template)
    .bind(&body.event_name)
    .bind(body.is_active)
    .execute(&pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("SSE 路由规则 {} 不存在", id)));
    }
    Ok(Json(json!({ "message": "更新成功" })))
}

/// DELETE /api/admin/sse-routes/:id
pub async fn delete_route(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i32>,
) -> Result<Json<serde_json::Value>> {
    require_admin_for_existing_route(&pool, &claims, id).await?;
    let result = sqlx::query("DELETE FROM management.sse_routes WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("SSE 路由规则 {} 不存在", id)));
    }
    Ok(Json(json!({ "message": "删除成功" })))
}
