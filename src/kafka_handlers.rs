//! Kafka data-source administration and execution APIs.

use axum::{
    extract::{Extension, Path, Query, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::audit_handlers;
use crate::auth::Claims;
use crate::crypto;
use crate::error::AppError;
use crate::kafka_ds::auth as kafka_auth;
use crate::kafka_ds::models::{KafkaAccessToken, KafkaConnection};
use crate::kafka_ds::{self, client_cache, commands};
use crate::permissions;
use chrono::{DateTime, Utc};

async fn require_tenant_admin(
    pool: &PgPool,
    claims: &Claims,
    tenant_id: i32,
) -> Result<(), AppError> {
    if claims.is_superadmin {
        return Ok(());
    }
    let admins = audit_handlers::admin_tenant_ids(pool, claims).await?;
    if admins.contains(&tenant_id) {
        Ok(())
    } else {
        Err(AppError::Forbidden(
            "仅超管或该租户 owner/admin 可管理 Kafka 连接".to_string(),
        ))
    }
}

async fn fetch_connection_authorized(
    pool: &PgPool,
    claims: &Claims,
    id: i64,
) -> Result<KafkaConnection, AppError> {
    let conn = sqlx::query_as::<_, KafkaConnection>(
        "SELECT * FROM management.kafka_connections WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询 Kafka 连接失败: {e}")))?
    .ok_or_else(|| AppError::NotFound(format!("Kafka 连接 {id} 不存在")))?;
    require_tenant_admin(pool, claims, conn.tenant_id).await?;
    Ok(conn)
}

#[derive(Debug, Deserialize)]
pub struct ListConnectionsQuery {
    pub tenant_id: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct CreateConnectionReq {
    pub tenant_id: i32,
    pub connection_name: String,
    pub brokers: String,
    pub security_protocol: Option<String>,
    pub sasl_mechanism: Option<String>,
    pub sasl_username: Option<String>,
    pub sasl_password: Option<String>,
    pub tls_insecure_skip_verify: Option<bool>,
    pub connect_timeout_secs: Option<i32>,
    pub is_active: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateConnectionReq {
    pub connection_name: Option<String>,
    pub brokers: Option<String>,
    pub security_protocol: Option<String>,
    pub sasl_mechanism: Option<String>,
    pub sasl_username: Option<String>,
    pub sasl_password: Option<String>,
    pub tls_insecure_skip_verify: Option<bool>,
    pub connect_timeout_secs: Option<i32>,
    pub is_active: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct ExecReq {
    pub op: String,
    #[serde(default)]
    pub args: Value,
}

pub async fn list_connections(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(q): Query<ListConnectionsQuery>,
) -> Result<Json<Vec<Value>>, AppError> {
    let rows = if claims.is_superadmin {
        match q.tenant_id {
            Some(tenant_id) => {
                sqlx::query_as::<_, KafkaConnection>(
                    "SELECT * FROM management.kafka_connections \
                 WHERE tenant_id = $1 ORDER BY id DESC",
                )
                .bind(tenant_id)
                .fetch_all(&pool)
                .await
            }
            None => {
                sqlx::query_as::<_, KafkaConnection>(
                    "SELECT * FROM management.kafka_connections ORDER BY id DESC",
                )
                .fetch_all(&pool)
                .await
            }
        }
    } else {
        let admins = audit_handlers::admin_tenant_ids(&pool, &claims).await?;
        if admins.is_empty() {
            return Ok(Json(vec![]));
        }
        sqlx::query_as::<_, KafkaConnection>(
            "SELECT * FROM management.kafka_connections \
             WHERE tenant_id = ANY($1) ORDER BY id DESC",
        )
        .bind(&admins)
        .fetch_all(&pool)
        .await
    }
    .map_err(|e| AppError::Internal(format!("列出 Kafka 连接失败: {e}")))?;

    Ok(Json(rows.iter().map(connection_json).collect()))
}

pub async fn get_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    let conn = fetch_connection_authorized(&pool, &claims, id).await?;
    Ok(Json(connection_json(&conn)))
}

pub async fn create_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<CreateConnectionReq>,
) -> Result<Json<Value>, AppError> {
    require_tenant_admin(&pool, &claims, req.tenant_id).await?;
    validate_name(&req.connection_name)?;
    validate_brokers(&req.brokers)?;

    let protocol = normalize_protocol(req.security_protocol.as_deref().unwrap_or("PLAINTEXT"))?;
    let mechanism = normalize_opt(req.sasl_mechanism);
    let username = normalize_opt(req.sasl_username);
    validate_sasl(&protocol, mechanism.as_deref(), username.as_deref())?;
    let password_enc = match req.sasl_password.as_deref() {
        None | Some("") => None,
        Some(password) => Some(crypto::encrypt_secret(password)?),
    };
    let timeout = req.connect_timeout_secs.unwrap_or(5).clamp(1, 60);

    let row = sqlx::query_as::<_, KafkaConnection>(
        "INSERT INTO management.kafka_connections \
            (tenant_id, connection_name, brokers, security_protocol, sasl_mechanism, \
             sasl_username, sasl_password_enc, tls_insecure_skip_verify, \
             connect_timeout_secs, is_active, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *",
    )
    .bind(req.tenant_id)
    .bind(req.connection_name.trim())
    .bind(req.brokers.trim())
    .bind(protocol)
    .bind(mechanism)
    .bind(username)
    .bind(password_enc)
    .bind(req.tls_insecure_skip_verify.unwrap_or(false))
    .bind(timeout)
    .bind(req.is_active.unwrap_or(true))
    .bind(claims.sub)
    .fetch_one(&pool)
    .await
    .map_err(|e| map_unique_violation(e, "同名 Kafka 连接已存在"))?;

    Ok(Json(connection_json(&row)))
}

pub async fn update_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateConnectionReq>,
) -> Result<Json<Value>, AppError> {
    let existing = fetch_connection_authorized(&pool, &claims, id).await?;
    if let Some(name) = req.connection_name.as_deref() {
        validate_name(name)?;
    }
    if let Some(brokers) = req.brokers.as_deref() {
        validate_brokers(brokers)?;
    }

    let protocol = match req.security_protocol.as_deref() {
        Some(value) => Some(normalize_protocol(value)?),
        None => None,
    };
    let touch_mechanism = req.sasl_mechanism.is_some();
    let touch_username = req.sasl_username.is_some();
    let mechanism = normalize_opt(req.sasl_mechanism);
    let username = normalize_opt(req.sasl_username);
    let effective_protocol = protocol.as_deref().unwrap_or(&existing.security_protocol);
    let effective_mechanism = if touch_mechanism {
        mechanism.as_deref()
    } else {
        existing.sasl_mechanism.as_deref()
    };
    let effective_username = if touch_username {
        username.as_deref()
    } else {
        existing.sasl_username.as_deref()
    };
    validate_sasl(effective_protocol, effective_mechanism, effective_username)?;

    let (touch_password, password_enc): (bool, Option<String>) = match req.sasl_password.as_deref()
    {
        None => (false, None),
        Some("") => (true, None),
        Some(password) => (true, Some(crypto::encrypt_secret(password)?)),
    };

    let row = sqlx::query_as::<_, KafkaConnection>(
        "UPDATE management.kafka_connections SET \
            connection_name = COALESCE($1, connection_name), \
            brokers = COALESCE($2, brokers), \
            security_protocol = COALESCE($3, security_protocol), \
            sasl_mechanism = CASE WHEN $4 THEN $5 ELSE sasl_mechanism END, \
            sasl_username = CASE WHEN $6 THEN $7 ELSE sasl_username END, \
            sasl_password_enc = CASE WHEN $8 THEN $9 ELSE sasl_password_enc END, \
            tls_insecure_skip_verify = COALESCE($10, tls_insecure_skip_verify), \
            connect_timeout_secs = COALESCE($11, connect_timeout_secs), \
            is_active = COALESCE($12, is_active), \
            updated_at = NOW() \
         WHERE id = $13 RETURNING *",
    )
    .bind(req.connection_name.as_deref().map(str::trim))
    .bind(req.brokers.as_deref().map(str::trim))
    .bind(protocol)
    .bind(touch_mechanism)
    .bind(mechanism)
    .bind(touch_username)
    .bind(username)
    .bind(touch_password)
    .bind(password_enc)
    .bind(req.tls_insecure_skip_verify)
    .bind(req.connect_timeout_secs.map(|value| value.clamp(1, 60)))
    .bind(req.is_active)
    .bind(id)
    .fetch_one(&pool)
    .await
    .map_err(|e| map_unique_violation(e, "同名 Kafka 连接已存在"))?;

    client_cache::invalidate(id);
    Ok(Json(connection_json(&row)))
}

pub async fn delete_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    let _ = fetch_connection_authorized(&pool, &claims, id).await?;
    let result = sqlx::query("DELETE FROM management.kafka_connections WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .map_err(|e| AppError::Internal(format!("删除 Kafka 连接失败: {e}")))?;
    client_cache::invalidate(id);
    Ok(Json(json!({ "deleted": result.rows_affected() })))
}

pub async fn health_check(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    let conn = fetch_connection_authorized(&pool, &claims, id).await?;
    if !conn.is_active {
        return Ok(Json(json!({ "ok": false, "error": "连接已禁用" })));
    }
    match commands::health_probe(&conn).await {
        Ok(result) => Ok(Json(result)),
        Err(error) => Ok(Json(json!({ "ok": false, "error": error.to_string() }))),
    }
}

pub async fn list_topics(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    let conn = fetch_connection_authorized(&pool, &claims, id).await?;
    if !conn.is_active {
        return Err(AppError::NotFound(format!(
            "Kafka 连接 {id} 不存在或已禁用"
        )));
    }
    Ok(Json(commands::list_topics(&conn).await?))
}

#[derive(Debug, Deserialize)]
pub struct CreateTopicReq {
    pub name: String,
    pub num_partitions: i32,
    pub replication_factor: i32,
}

pub async fn create_topic(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
    Json(req): Json<CreateTopicReq>,
) -> Result<Json<Value>, AppError> {
    let conn = fetch_connection_authorized(&pool, &claims, id).await?;
    if !conn.is_active {
        return Err(AppError::NotFound(format!(
            "Kafka 连接 {id} 不存在或已禁用"
        )));
    }
    Ok(Json(
        commands::create_topic(
            &conn,
            &req.name,
            req.num_partitions,
            req.replication_factor,
        )
        .await?,
    ))
}

pub async fn list_consumer_groups(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    let conn = fetch_connection_authorized(&pool, &claims, id).await?;
    if !conn.is_active {
        return Err(AppError::NotFound(format!(
            "Kafka 连接 {id} 不存在或已禁用"
        )));
    }
    Ok(Json(commands::list_consumer_groups(&conn).await?))
}

pub async fn exec(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
    Json(req): Json<ExecReq>,
) -> Result<Json<Value>, AppError> {
    let conn = kafka_ds::fetch_active(&pool, id).await?;
    let op = req.op.to_ascii_lowercase();
    if commands::is_write_op(&op) {
        permissions::require_tenant_member(&pool, &claims, conn.tenant_id).await?;
    } else {
        permissions::require_tenant_membership_any(&pool, &claims, conn.tenant_id).await?;
    }

    let result = match op.as_str() {
        "produce" => {
            let producer = client_cache::get_or_create(&conn).await?;
            commands::execute(&producer, &op, &req.args).await?
        }
        "list_topics" => commands::list_topics(&conn).await?,
        _ => {
            return Err(AppError::InvalidQuery(format!(
                "不支持的 Kafka 操作 `{}`（支持：{}）",
                req.op,
                commands::SUPPORTED_OPS.join(", ")
            )));
        }
    };
    Ok(Json(json!({ "op": req.op, "result": result })))
}

fn connection_json(conn: &KafkaConnection) -> Value {
    let mut value = serde_json::to_value(conn).expect("KafkaConnection must serialize");
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "has_password".into(),
            json!(conn
                .sasl_password_enc
                .as_ref()
                .map(|value| !value.is_empty())
                .unwrap_or(false)),
        );
    }
    value
}

fn normalize_opt(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn normalize_protocol(value: &str) -> Result<String, AppError> {
    let protocol = value.trim().to_ascii_uppercase();
    match protocol.as_str() {
        "PLAINTEXT" | "SASL_PLAINTEXT" | "SASL_SSL" | "SSL" => Ok(protocol),
        _ => Err(AppError::InvalidQuery(
            "security_protocol 必须是 PLAINTEXT、SASL_PLAINTEXT、SASL_SSL 或 SSL".into(),
        )),
    }
}

fn validate_sasl(
    protocol: &str,
    mechanism: Option<&str>,
    username: Option<&str>,
) -> Result<(), AppError> {
    if protocol.starts_with("SASL_")
        && (mechanism.map(str::trim).filter(|v| !v.is_empty()).is_none()
            || username.map(str::trim).filter(|v| !v.is_empty()).is_none())
    {
        return Err(AppError::InvalidQuery(
            "SASL 协议必须配置 sasl_mechanism 和 sasl_username".into(),
        ));
    }
    Ok(())
}

fn validate_name(name: &str) -> Result<(), AppError> {
    if name.trim().is_empty() {
        Err(AppError::InvalidQuery("connection_name 不能为空".into()))
    } else {
        Ok(())
    }
}

fn validate_brokers(brokers: &str) -> Result<(), AppError> {
    if brokers.trim().is_empty() {
        Err(AppError::InvalidQuery("brokers 不能为空".into()))
    } else {
        Ok(())
    }
}

fn map_unique_violation(error: sqlx::Error, message: &str) -> AppError {
    if let sqlx::Error::Database(ref database_error) = error {
        if database_error.code().as_deref() == Some("23505") {
            return AppError::InvalidQuery(message.to_string());
        }
    }
    AppError::Internal(format!("DB 错误: {error}"))
}

// ── Token CRUD ─────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreateTokenReq {
    pub name: String,
    pub description: Option<String>,
    pub allowed_ops: Option<Vec<String>>,
    pub topic_allowlist: Option<Vec<String>>,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateTokenReq {
    pub name: Option<String>,
    pub description: Option<String>,
    pub allowed_ops: Option<Vec<String>>,
    pub topic_allowlist: Option<Vec<String>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub is_active: Option<bool>,
}

pub async fn list_tokens(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(connection_id): Path<i64>,
) -> Result<Json<Vec<KafkaAccessToken>>, AppError> {
    let _ = fetch_connection_authorized(&pool, &claims, connection_id).await?;
    let rows = sqlx::query_as::<_, KafkaAccessToken>(
        "SELECT * FROM management.kafka_access_tokens \
         WHERE connection_id = $1 ORDER BY id DESC",
    )
    .bind(connection_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("列出 Kafka token 失败: {e}")))?;
    Ok(Json(rows))
}

pub async fn create_token(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(connection_id): Path<i64>,
    Json(req): Json<CreateTokenReq>,
) -> Result<Json<Value>, AppError> {
    let _ = fetch_connection_authorized(&pool, &claims, connection_id).await?;
    if req.name.trim().is_empty() {
        return Err(AppError::InvalidQuery("token name 不能为空".to_string()));
    }
    let ops = req
        .allowed_ops
        .unwrap_or_else(|| kafka_auth::DEFAULT_OPS.iter().map(|s| s.to_string()).collect());
    kafka_auth::validate_ops(&ops)?;
    let topics = req.topic_allowlist.unwrap_or_else(|| vec!["*".to_string()]);
    if topics.is_empty() {
        return Err(AppError::InvalidQuery(
            "topic_allowlist 至少要有一项（用 [\"*\"] 表示不限）".to_string(),
        ));
    }

    let plain = kafka_auth::generate_token();
    let hash = kafka_auth::hash_token(&plain);
    let prefix = kafka_auth::token_prefix(&plain);

    let row = sqlx::query_as::<_, KafkaAccessToken>(
        "INSERT INTO management.kafka_access_tokens \
            (connection_id, name, description, token_hash, token_prefix, \
             allowed_ops, topic_allowlist, expires_at, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *",
    )
    .bind(connection_id)
    .bind(req.name.trim())
    .bind(req.description.as_deref().map(|s| s.trim()))
    .bind(&hash)
    .bind(&prefix)
    .bind(&ops)
    .bind(&topics)
    .bind(req.expires_at)
    .bind(claims.sub)
    .fetch_one(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("创建 Kafka token 失败: {e}")))?;

    Ok(Json(json!({
        "token": plain,
        "record": row,
    })))
}

pub async fn update_token(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((connection_id, token_id)): Path<(i64, i64)>,
    Json(req): Json<UpdateTokenReq>,
) -> Result<Json<KafkaAccessToken>, AppError> {
    let _ = fetch_connection_authorized(&pool, &claims, connection_id).await?;
    if let Some(ops) = &req.allowed_ops {
        kafka_auth::validate_ops(ops)?;
    }
    if let Some(topics) = &req.topic_allowlist {
        if topics.is_empty() {
            return Err(AppError::InvalidQuery(
                "topic_allowlist 至少要有一项".to_string(),
            ));
        }
    }

    let row = sqlx::query_as::<_, KafkaAccessToken>(
        "UPDATE management.kafka_access_tokens SET \
            name = COALESCE($1, name), \
            description = COALESCE($2, description), \
            allowed_ops = COALESCE($3, allowed_ops), \
            topic_allowlist = COALESCE($4, topic_allowlist), \
            expires_at = COALESCE($5, expires_at), \
            is_active = COALESCE($6, is_active) \
         WHERE id = $7 AND connection_id = $8 RETURNING *",
    )
    .bind(req.name.as_deref().map(|s| s.trim()))
    .bind(req.description.as_deref().map(|s| s.trim()))
    .bind(req.allowed_ops.as_ref())
    .bind(req.topic_allowlist.as_ref())
    .bind(req.expires_at)
    .bind(req.is_active)
    .bind(token_id)
    .bind(connection_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("更新 Kafka token 失败: {e}")))?
    .ok_or_else(|| AppError::NotFound(format!("token {token_id} 不存在")))?;
    Ok(Json(row))
}

pub async fn delete_token(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((connection_id, token_id)): Path<(i64, i64)>,
) -> Result<Json<Value>, AppError> {
    let _ = fetch_connection_authorized(&pool, &claims, connection_id).await?;
    let res = sqlx::query(
        "DELETE FROM management.kafka_access_tokens WHERE id = $1 AND connection_id = $2",
    )
    .bind(token_id)
    .bind(connection_id)
    .execute(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("删除 Kafka token 失败: {e}")))?;
    Ok(Json(json!({ "deleted": res.rows_affected() })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sasl_protocol_requires_mechanism_and_username() {
        assert!(validate_sasl("SASL_SSL", Some("PLAIN"), Some("user")).is_ok());
        assert!(validate_sasl("SASL_SSL", None, Some("user")).is_err());
        assert!(validate_sasl("SASL_PLAINTEXT", Some("PLAIN"), None).is_err());
        assert!(validate_sasl("PLAINTEXT", None, None).is_ok());
    }
}
