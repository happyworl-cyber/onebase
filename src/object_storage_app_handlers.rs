//! 对象存储令牌面 REST：外部用 `obes_os_*` 调 exec / health。
//!
//! 路径：
//!   - `/api/object-storage/:id/{exec|health}`
//!   - `/api/v1/:database_slug/object-storage/:id/...`（租户作用域，复用 ES slug 中间件）

use axum::{
    extract::{Extension, Path, State},
    http::HeaderMap,
    Json,
};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::time::{Duration, Instant};

use crate::error::AppError;
use crate::es::proxy_common::EsTenantScope;
use crate::object_storage_ds::auth as os_auth;
use crate::object_storage_ds::models::{ObjectStorageAccessToken, ObjectStorageConnection};
use crate::object_storage_ds::{client_cache, commands};

/// 按 key 取 `id`，兼容 slug 嵌套路由上多余的 `database_slug` 参数。
#[derive(Debug, Deserialize)]
pub struct ConnectionIdPath {
    pub id: i64,
}

#[derive(Debug, Deserialize)]
pub struct ExecBody {
    pub op: String,
    #[serde(default)]
    pub args: Value,
}

struct ResolvedAccess {
    token: ObjectStorageAccessToken,
    connection: ObjectStorageConnection,
}

async fn resolve_access(
    pool: &PgPool,
    headers: &HeaderMap,
    connection_id: i64,
    op: &str,
    keys: &[String],
    tenant_scope: Option<&EsTenantScope>,
) -> Result<ResolvedAccess, AppError> {
    let plain = os_auth::extract_token(headers).ok_or_else(|| {
        AppError::Unauthorized(
            "缺少对象存储访问令牌；请用 `Authorization: ApiKey obes_os_xxx`".to_string(),
        )
    })?;
    let hash = os_auth::hash_token(&plain);

    let token = sqlx::query_as::<_, ObjectStorageAccessToken>(
        "SELECT * FROM management.object_storage_access_tokens \
         WHERE token_hash = $1 AND is_active = true AND revoked_at IS NULL",
    )
    .bind(&hash)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询对象存储 token 失败: {e}")))?
    .ok_or_else(|| AppError::Unauthorized("对象存储访问令牌无效或已停用".to_string()))?;

    if token.connection_id != connection_id {
        return Err(AppError::Forbidden(
            "令牌与请求的对象存储连接不匹配".to_string(),
        ));
    }
    if let Some(exp) = token.expires_at {
        if exp < Utc::now() {
            return Err(AppError::Unauthorized("对象存储访问令牌已过期".to_string()));
        }
    }

    os_auth::op_allowed(op, &token.allowed_ops)?;
    for key in keys {
        os_auth::key_allowed(key, &token.key_prefix_allowlist)?;
    }

    let connection = sqlx::query_as::<_, ObjectStorageConnection>(
        "SELECT * FROM management.object_storage_connections WHERE id = $1",
    )
    .bind(connection_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询对象存储连接失败: {e}")))?
    .ok_or_else(|| AppError::NotFound(format!("对象存储连接 {connection_id} 不存在")))?;

    if !connection.is_active {
        return Err(AppError::ServiceUnavailable(
            "对象存储连接已停用".to_string(),
        ));
    }
    if let Some(scope) = tenant_scope {
        if connection.tenant_id != scope.tenant_id {
            return Err(AppError::Forbidden(
                "对象存储令牌不属于该项目（database_slug 租户不匹配）".to_string(),
            ));
        }
    }

    Ok(ResolvedAccess { token, connection })
}

fn spawn_usage_update(pool: PgPool, token_id: i64) {
    tokio::spawn(async move {
        let _ = sqlx::query(
            "UPDATE management.object_storage_access_tokens \
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

pub async fn exec(
    State(pool): State<PgPool>,
    Path(ConnectionIdPath { id: connection_id }): Path<ConnectionIdPath>,
    headers: HeaderMap,
    scope: Option<Extension<EsTenantScope>>,
    Json(body): Json<ExecBody>,
) -> Result<Json<Value>, AppError> {
    let op = body.op.trim().to_ascii_lowercase();
    if op.is_empty() {
        return Err(AppError::InvalidQuery("op 不能为空".to_string()));
    }
    if op == "health" {
        return Err(AppError::InvalidQuery(
            "health 请使用 GET .../health，不要走 /exec".to_string(),
        ));
    }

    let keys = os_auth::keys_for_acl(&op, &body.args)?;
    let access = resolve_access(
        &pool,
        &headers,
        connection_id,
        &op,
        &keys,
        scope.as_ref().map(|e| &e.0),
    )
    .await?;

    let handle = client_cache::get_or_create(&access.connection).await?;
    let result = commands::execute(&handle, &access.connection.bucket, &op, &body.args).await?;
    spawn_usage_update(pool, access.token.id);
    Ok(ok_result(&op, result))
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
        &[],
        scope.as_ref().map(|e| &e.0),
    )
    .await?;

    let handle = client_cache::get_or_create(&access.connection).await?;
    let budget_secs =
        (access.connection.connect_timeout_secs.clamp(1, 60) as u64 * 2).clamp(10, 60);
    let budget = Duration::from_secs(budget_secs);
    let started = Instant::now();
    let probe = tokio::time::timeout(
        budget,
        commands::probe_bucket(&handle, &access.connection.bucket),
    )
    .await;

    let result = match probe {
        Ok(Ok(())) => json!({
            "ok": true,
            "latency_ms": started.elapsed().as_millis() as u64,
            "bucket": access.connection.bucket,
        }),
        Ok(Err(e)) => {
            return Err(AppError::ServiceUnavailable(format!(
                "对象存储健康检查失败: {e}"
            )));
        }
        Err(_) => {
            return Err(AppError::ServiceUnavailable(
                "对象存储健康检查超时".to_string(),
            ));
        }
    };

    spawn_usage_update(pool, access.token.id);
    Ok(ok_result("health", result))
}
