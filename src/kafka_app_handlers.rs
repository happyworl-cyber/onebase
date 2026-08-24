//! Kafka 令牌面 REST：外部用 `obes_kafka_*` 调 produce / topics / health。
//!
//! 路径：
//!   - `/api/kafka/:id/{produce|topics|health}`
//!   - `/api/v1/:database_slug/kafka/:id/...`（租户作用域，复用 ES slug 中间件）

use axum::{
    extract::{Extension, Path, State},
    http::HeaderMap,
    Json,
};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::error::AppError;
use crate::es::proxy_common::EsTenantScope;
use crate::kafka_ds::auth as kafka_auth;
use crate::kafka_ds::models::{KafkaAccessToken, KafkaConnection};
use crate::kafka_ds::{client_cache, commands};

/// 按 key 取 `id`，兼容 slug 嵌套路由上多余的 `database_slug` 参数。
#[derive(Debug, Deserialize)]
pub struct ConnectionIdPath {
    pub id: i64,
}

#[derive(Debug, Deserialize)]
pub struct ProduceBody {
    pub topic: String,
    pub key: Option<String>,
    pub value: Value,
    pub headers: Option<Value>,
}

struct ResolvedAccess {
    token: KafkaAccessToken,
    connection: KafkaConnection,
}

async fn resolve_access(
    pool: &PgPool,
    headers: &HeaderMap,
    connection_id: i64,
    op: &str,
    topic: Option<&str>,
    tenant_scope: Option<&EsTenantScope>,
) -> Result<ResolvedAccess, AppError> {
    let plain = kafka_auth::extract_token(headers).ok_or_else(|| {
        AppError::Unauthorized(
            "缺少 Kafka 访问令牌；请用 `Authorization: ApiKey obes_kafka_xxx`".to_string(),
        )
    })?;
    let hash = kafka_auth::hash_token(&plain);

    let token = sqlx::query_as::<_, KafkaAccessToken>(
        "SELECT * FROM management.kafka_access_tokens \
         WHERE token_hash = $1 AND is_active = true AND revoked_at IS NULL",
    )
    .bind(&hash)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询 Kafka token 失败: {e}")))?
    .ok_or_else(|| AppError::Unauthorized("Kafka 访问令牌无效或已停用".to_string()))?;

    if token.connection_id != connection_id {
        return Err(AppError::Forbidden(
            "令牌与请求的 Kafka 连接不匹配".to_string(),
        ));
    }
    if let Some(exp) = token.expires_at {
        if exp < Utc::now() {
            return Err(AppError::Unauthorized("Kafka 访问令牌已过期".to_string()));
        }
    }

    kafka_auth::op_allowed(op, &token.allowed_ops)?;
    if let Some(topic) = topic {
        kafka_auth::topic_allowed(topic, &token.topic_allowlist)?;
    }

    let connection = sqlx::query_as::<_, KafkaConnection>(
        "SELECT * FROM management.kafka_connections WHERE id = $1",
    )
    .bind(connection_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询 Kafka 连接失败: {e}")))?
    .ok_or_else(|| AppError::NotFound(format!("Kafka 连接 {connection_id} 不存在")))?;

    if !connection.is_active {
        return Err(AppError::ServiceUnavailable("Kafka 连接已停用".to_string()));
    }
    if let Some(scope) = tenant_scope {
        if connection.tenant_id != scope.tenant_id {
            return Err(AppError::Forbidden(
                "Kafka 令牌不属于该项目（database_slug 租户不匹配）".to_string(),
            ));
        }
    }

    Ok(ResolvedAccess { token, connection })
}

fn spawn_usage_update(pool: PgPool, token_id: i64) {
    tokio::spawn(async move {
        let _ = sqlx::query(
            "UPDATE management.kafka_access_tokens \
             SET use_count = use_count + 1, last_used_at = NOW() WHERE id = $1",
        )
        .bind(token_id)
        .execute(&pool)
        .await;
    });
}

fn ok_result(op: &str, result: Value) -> Json<Value> {
    Json(json!({ "ok": true, "op": op, "result": result }))
}

pub async fn produce(
    State(pool): State<PgPool>,
    Path(ConnectionIdPath { id: connection_id }): Path<ConnectionIdPath>,
    headers: HeaderMap,
    scope: Option<Extension<EsTenantScope>>,
    Json(body): Json<ProduceBody>,
) -> Result<Json<Value>, AppError> {
    let topic = body.topic.trim();
    if topic.is_empty() {
        return Err(AppError::InvalidQuery("topic 不能为空".to_string()));
    }
    let access = resolve_access(
        &pool,
        &headers,
        connection_id,
        "produce",
        Some(topic),
        scope.as_ref().map(|e| &e.0),
    )
    .await?;

    let producer = client_cache::get_or_create(&access.connection).await?;
    let headers_val = body.headers.unwrap_or(Value::Null);
    let key = body.key.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let value = match &body.value {
        Value::String(s) => s.clone(),
        Value::Object(_) | Value::Array(_) => body.value.to_string(),
        _ => {
            return Err(AppError::InvalidQuery(
                "value 必须是字符串、对象或数组".to_string(),
            ));
        }
    };
    let result = commands::produce(&producer, topic, key, &value, &headers_val).await?;
    spawn_usage_update(pool, access.token.id);
    Ok(ok_result("produce", result))
}

pub async fn list_topics(
    State(pool): State<PgPool>,
    Path(ConnectionIdPath { id: connection_id }): Path<ConnectionIdPath>,
    headers: HeaderMap,
    scope: Option<Extension<EsTenantScope>>,
) -> Result<Json<Value>, AppError> {
    let access = resolve_access(
        &pool,
        &headers,
        connection_id,
        "list_topics",
        None,
        scope.as_ref().map(|e| &e.0),
    )
    .await?;
    let result = commands::list_topics(&access.connection).await?;
    spawn_usage_update(pool, access.token.id);
    Ok(ok_result("list_topics", result))
}

pub async fn health(
    State(pool): State<PgPool>,
    Path(ConnectionIdPath { id: connection_id }): Path<ConnectionIdPath>,
    headers: HeaderMap,
    scope: Option<Extension<EsTenantScope>>,
) -> Result<Json<Value>, AppError> {
    let access = resolve_access(
        &pool,
        &headers,
        connection_id,
        "health",
        None,
        scope.as_ref().map(|e| &e.0),
    )
    .await?;
    let result = commands::health_probe(&access.connection).await?;
    spawn_usage_update(pool, access.token.id);
    Ok(ok_result("health", result))
}
