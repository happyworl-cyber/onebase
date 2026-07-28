use axum::{
    extract::{Extension, Path, State},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{PgPool, Row};

use crate::auth::Claims;
use crate::error::{AppError, Result};
use crate::permissions;

/// 当前用户管理（owner/admin）的全部 tenant_id 列表；超管返回空向量表示"无限制"。
///
/// 委托给 `crate::permissions::tenant_admin_ids`，并补上原实现漏掉的 `is_active = true` 过滤。
async fn admin_tenant_ids(pool: &PgPool, claims: &Claims) -> Result<Vec<i32>> {
    permissions::tenant_admin_ids(pool, claims).await
}

/// 判定当前用户能否管理指定租户的 webhook。委托给 `permissions::require_tenant_admin`。
async fn require_webhook_admin(pool: &PgPool, claims: &Claims, tenant_id: i32) -> Result<()> {
    permissions::require_tenant_admin(pool, claims, tenant_id).await
}

/// 已经存在的 webhook 是否归当前用户的租户管辖
async fn require_admin_for_existing_webhook(
    pool: &PgPool,
    claims: &Claims,
    webhook_id: i32,
) -> Result<i32> {
    let row = sqlx::query("SELECT tenant_id FROM management.webhooks WHERE id = $1")
        .bind(webhook_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Webhook {} 不存在", webhook_id)))?;
    let tenant_id: i32 = row.get("tenant_id");
    require_webhook_admin(pool, claims, tenant_id).await?;
    Ok(tenant_id)
}

#[derive(Debug, Deserialize)]
pub struct CreateWebhook {
    pub tenant_id: i32,
    pub name: String,
    pub url: String,
    pub event_pattern: String,
    pub headers: Option<serde_json::Value>,
    pub secret: Option<String>,
    pub retry_count: Option<i32>,
    pub timeout_ms: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateWebhook {
    pub name: Option<String>,
    pub url: Option<String>,
    pub event_pattern: Option<String>,
    pub headers: Option<serde_json::Value>,
    pub secret: Option<String>,
    pub retry_count: Option<i32>,
    pub timeout_ms: Option<i32>,
    pub is_active: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct WebhookResponse {
    pub id: i32,
    pub tenant_id: i32,
    pub name: String,
    pub url: String,
    pub event_pattern: String,
    pub headers: serde_json::Value,
    pub retry_count: i32,
    pub timeout_ms: i32,
    pub is_active: bool,
}

/// GET /api/admin/webhooks
///
/// 超管返回全部；租户 admin 仅返回本租户。
pub async fn list_webhooks(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<serde_json::Value>> {
    let rows = if claims.is_superadmin {
        sqlx::query(
            "SELECT id, tenant_id, name, url, event_pattern, \
                    COALESCE(headers, '{}') as headers, retry_count, timeout_ms, is_active \
             FROM management.webhooks ORDER BY id",
        )
        .fetch_all(&pool)
        .await?
    } else {
        let tenant_ids = admin_tenant_ids(&pool, &claims).await?;
        if tenant_ids.is_empty() {
            return Ok(Json(json!({ "data": [] })));
        }
        sqlx::query(
            "SELECT id, tenant_id, name, url, event_pattern, \
                    COALESCE(headers, '{}') as headers, retry_count, timeout_ms, is_active \
             FROM management.webhooks WHERE tenant_id = ANY($1) ORDER BY id",
        )
        .bind(&tenant_ids)
        .fetch_all(&pool)
        .await?
    };

    let webhooks: Vec<serde_json::Value> = rows.iter().map(|r| {
        json!({
            "id": r.get::<i32, _>("id"),
            "tenant_id": r.get::<i32, _>("tenant_id"),
            "name": r.get::<String, _>("name"),
            "url": r.get::<String, _>("url"),
            "event_pattern": r.get::<String, _>("event_pattern"),
            "headers": r.get::<serde_json::Value, _>("headers"),
            "retry_count": r.get::<i32, _>("retry_count"),
            "timeout_ms": r.get::<i32, _>("timeout_ms"),
            "is_active": r.get::<bool, _>("is_active"),
        })
    }).collect();

    Ok(Json(json!({ "data": webhooks })))
}

/// POST /api/admin/webhooks
pub async fn create_webhook(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<CreateWebhook>,
) -> Result<Json<serde_json::Value>> {
    require_webhook_admin(&pool, &claims, body.tenant_id).await?;

    let row = sqlx::query(
        "INSERT INTO management.webhooks (tenant_id, name, url, event_pattern, headers, secret, retry_count, timeout_ms) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id"
    )
    .bind(body.tenant_id)
    .bind(&body.name)
    .bind(&body.url)
    .bind(&body.event_pattern)
    .bind(&body.headers.unwrap_or(json!({})))
    .bind(&body.secret)
    .bind(body.retry_count.unwrap_or(3))
    .bind(body.timeout_ms.unwrap_or(5000))
    .fetch_one(&pool)
    .await?;

    let id: i32 = row.get("id");
    Ok(Json(json!({ "data": { "id": id }, "message": "Webhook 创建成功" })))
}

/// PATCH /api/admin/webhooks/:id
pub async fn update_webhook(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i32>,
    Json(body): Json<UpdateWebhook>,
) -> Result<Json<serde_json::Value>> {
    require_admin_for_existing_webhook(&pool, &claims, id).await?;
    let result = sqlx::query(
        "UPDATE management.webhooks SET \
            name = COALESCE($2, name), \
            url = COALESCE($3, url), \
            event_pattern = COALESCE($4, event_pattern), \
            headers = COALESCE($5, headers), \
            secret = COALESCE($6, secret), \
            retry_count = COALESCE($7, retry_count), \
            timeout_ms = COALESCE($8, timeout_ms), \
            is_active = COALESCE($9, is_active) \
         WHERE id = $1"
    )
    .bind(id)
    .bind(&body.name)
    .bind(&body.url)
    .bind(&body.event_pattern)
    .bind(&body.headers)
    .bind(&body.secret)
    .bind(body.retry_count)
    .bind(body.timeout_ms)
    .bind(body.is_active)
    .execute(&pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Webhook {} 不存在", id)));
    }

    Ok(Json(json!({ "message": "更新成功" })))
}

/// DELETE /api/admin/webhooks/:id
pub async fn delete_webhook(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i32>,
) -> Result<Json<serde_json::Value>> {
    require_admin_for_existing_webhook(&pool, &claims, id).await?;
    let result = sqlx::query("DELETE FROM management.webhooks WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Webhook {} 不存在", id)));
    }

    Ok(Json(json!({ "message": "删除成功" })))
}

/// POST /api/admin/webhooks/:id/test
pub async fn test_webhook(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i32>,
) -> Result<Json<serde_json::Value>> {
    require_admin_for_existing_webhook(&pool, &claims, id).await?;
    let row = sqlx::query("SELECT url, COALESCE(headers, '{}') as headers, timeout_ms FROM management.webhooks WHERE id = $1")
        .bind(id)
        .fetch_optional(&pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Webhook {} 不存在", id)))?;

    let url: String = row.get("url");
    let headers: serde_json::Value = row.get("headers");
    let timeout_ms: i32 = row.get("timeout_ms");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms as u64))
        .build()
        .unwrap_or_default();

    let test_payload = json!({
        "event": "TEST",
        "schema": "test",
        "table": "test",
        "data": { "message": "OneBase Webhook 测试" },
        "timestamp": chrono::Utc::now().to_rfc3339(),
    });

    let mut req = client.post(&url).json(&test_payload);
    if let Some(obj) = headers.as_object() {
        for (k, v) in obj {
            if let Some(vs) = v.as_str() {
                req = req.header(k.as_str(), vs);
            }
        }
    }

    match req.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            Ok(Json(json!({
                "success": (200..300).contains(&status),
                "status": status,
                "body": body.chars().take(500).collect::<String>(),
            })))
        }
        Err(e) => {
            Ok(Json(json!({
                "success": false,
                "error": e.to_string(),
            })))
        }
    }
}

/// GET /api/admin/webhooks/:id/logs
pub async fn webhook_logs(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i32>,
) -> Result<Json<serde_json::Value>> {
    require_admin_for_existing_webhook(&pool, &claims, id).await?;
    let rows = sqlx::query(
        "SELECT id, response_status, attempt, success, error_message, duration_ms, created_at \
         FROM management.webhook_logs WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT 50"
    )
    .bind(id)
    .fetch_all(&pool)
    .await?;

    let logs: Vec<serde_json::Value> = rows.iter().map(|r| {
        json!({
            "id": r.get::<i64, _>("id"),
            "response_status": r.get::<Option<i32>, _>("response_status"),
            "attempt": r.get::<i32, _>("attempt"),
            "success": r.get::<bool, _>("success"),
            "error_message": r.get::<Option<String>, _>("error_message"),
            "duration_ms": r.get::<i32, _>("duration_ms"),
            "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at").to_rfc3339(),
        })
    }).collect();

    Ok(Json(json!({ "data": logs })))
}
