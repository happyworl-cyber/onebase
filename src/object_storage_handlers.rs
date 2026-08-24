//! 对象存储数据源的管理端 + 数据端 API（bin-only）。
//!
//! 鉴权与 Redis/ES 连接一致：
//!   - 管理端（连接 CRUD / health）：超管 / 该租户 owner-admin
//!   - 数据端（exec 读写）：读走「任意租户成员」，写走「owner/admin/member」（viewer 只读）
//!
//! 密钥明文从不出 handler 边界：`ObjectStorageConnection.secret_key_enc` 已
//! `#[serde(skip_serializing)]`，解密只在 `object_storage_ds::client_cache` 建连时短暂发生。
//!
//! 路由（见 main.rs 注册处）：
//! ```text
//! GET    /api/admin/object-storage-connections
//! POST   /api/admin/object-storage-connections
//! GET    /api/admin/object-storage-connections/:id
//! PUT    /api/admin/object-storage-connections/:id
//! DELETE /api/admin/object-storage-connections/:id
//! POST   /api/admin/object-storage-connections/:id/health
//! GET|POST /api/admin/object-storage-connections/:id/tokens
//! PATCH|DELETE /api/admin/object-storage-connections/:id/tokens/:token_id
//!
//! POST   /api/object-storage-connections/:id/exec
//! ```

use axum::{
    extract::{Extension, Path, Query, State},
    Json,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::time::{Duration, Instant};

use crate::audit_handlers;
use crate::auth::Claims;
use crate::crypto;
use crate::error::AppError;
use crate::object_storage_ds::auth as os_auth;
use crate::object_storage_ds::models::{
    default_force_path_style, validate_access_key_id, validate_bucket, validate_endpoint,
    validate_provider, validate_region, ObjectStorageAccessToken, ObjectStorageConnection,
};
use crate::object_storage_ds::{self, client_cache, commands};
use crate::permissions;

// ── 校验 helper ─────────────────────────────────────────────────────────

/// 超管 / 该租户 owner-admin 才能操作（与 redis_handlers::require_tenant_admin 同款）。
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
            "仅超管或该租户 owner/admin 可管理对象存储连接".to_string(),
        ))
    }
}

/// 取连接行或返回 NotFound，同时校验当前用户能管理其所属租户。
async fn fetch_connection_authorized(
    pool: &PgPool,
    claims: &Claims,
    id: i64,
) -> Result<ObjectStorageConnection, AppError> {
    let conn = sqlx::query_as::<_, ObjectStorageConnection>(
        "SELECT * FROM management.object_storage_connections WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询对象存储连接失败: {e}")))?
    .ok_or_else(|| AppError::NotFound(format!("对象存储连接 {id} 不存在")))?;
    require_tenant_admin(pool, claims, conn.tenant_id).await?;
    Ok(conn)
}

// ── DTO ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ListConnectionsQuery {
    /// 仅超管可用：按 tenant_id 过滤。非超管自动按自己管辖的租户过滤。
    pub tenant_id: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct CreateConnectionReq {
    pub tenant_id: i32,
    pub connection_name: String,
    pub provider: String,
    pub endpoint: String,
    pub region: Option<String>,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_key: String,
    pub force_path_style: Option<bool>,
    pub connect_timeout_secs: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateConnectionReq {
    pub connection_name: Option<String>,
    pub provider: Option<String>,
    pub endpoint: Option<String>,
    pub region: Option<String>,
    pub bucket: Option<String>,
    pub access_key_id: Option<String>,
    /// None = 保留；Some(non-empty) = 替换。Some("") 会被拒绝（密钥不可置空）。
    pub secret_key: Option<String>,
    pub force_path_style: Option<bool>,
    pub connect_timeout_secs: Option<i32>,
    pub is_active: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct ExecReq {
    pub op: String,
    #[serde(default)]
    pub args: Value,
}

// ── Connection CRUD ────────────────────────────────────────────────────

pub async fn list_connections(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(q): Query<ListConnectionsQuery>,
) -> Result<Json<Vec<ObjectStorageConnection>>, AppError> {
    let rows = if claims.is_superadmin {
        match q.tenant_id {
            Some(t) => sqlx::query_as::<_, ObjectStorageConnection>(
                "SELECT * FROM management.object_storage_connections WHERE tenant_id = $1 ORDER BY id DESC",
            )
            .bind(t)
            .fetch_all(&pool)
            .await,
            None => sqlx::query_as::<_, ObjectStorageConnection>(
                "SELECT * FROM management.object_storage_connections ORDER BY id DESC",
            )
            .fetch_all(&pool)
            .await,
        }
    } else {
        let admins = audit_handlers::admin_tenant_ids(&pool, &claims).await?;
        if admins.is_empty() {
            return Ok(Json(vec![]));
        }
        sqlx::query_as::<_, ObjectStorageConnection>(
            "SELECT * FROM management.object_storage_connections WHERE tenant_id = ANY($1) ORDER BY id DESC",
        )
        .bind(&admins)
        .fetch_all(&pool)
        .await
    }
    .map_err(|e| AppError::Internal(format!("列出对象存储连接失败: {e}")))?;
    Ok(Json(rows))
}

pub async fn get_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<ObjectStorageConnection>, AppError> {
    let conn = fetch_connection_authorized(&pool, &claims, id).await?;
    Ok(Json(conn))
}

pub async fn create_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<CreateConnectionReq>,
) -> Result<Json<ObjectStorageConnection>, AppError> {
    require_tenant_admin(&pool, &claims, req.tenant_id).await?;

    if req.connection_name.trim().is_empty() {
        return Err(AppError::InvalidQuery("connection_name 不能为空".into()));
    }
    validate_provider(&req.provider)?;
    validate_endpoint(&req.endpoint)?;
    validate_bucket(&req.bucket)?;
    let region = req
        .region
        .clone()
        .unwrap_or_else(|| "us-east-1".to_string());
    validate_region(&region)?;
    validate_access_key_id(&req.access_key_id)?;

    if req.secret_key.trim().is_empty() {
        return Err(AppError::InvalidQuery("secret_key 不能为空".into()));
    }
    let secret_key_enc = crypto::encrypt_secret(req.secret_key.trim())?;
    let force_path_style = req
        .force_path_style
        .unwrap_or_else(|| default_force_path_style(&req.provider));
    let timeout = req.connect_timeout_secs.unwrap_or(5).clamp(1, 60);

    let row = sqlx::query_as::<_, ObjectStorageConnection>(
        "INSERT INTO management.object_storage_connections \
            (tenant_id, connection_name, provider, endpoint, region, bucket, access_key_id, \
             secret_key_enc, force_path_style, connect_timeout_secs, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *",
    )
    .bind(req.tenant_id)
    .bind(req.connection_name.trim())
    .bind(req.provider.trim())
    .bind(req.endpoint.trim())
    .bind(region.trim())
    .bind(req.bucket.trim())
    .bind(req.access_key_id.trim())
    .bind(secret_key_enc)
    .bind(force_path_style)
    .bind(timeout)
    .bind(claims.sub)
    .fetch_one(&pool)
    .await
    .map_err(|e| map_unique_violation(e, "同名对象存储连接已存在"))?;

    Ok(Json(row))
}

pub async fn update_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateConnectionReq>,
) -> Result<Json<ObjectStorageConnection>, AppError> {
    let _existing = fetch_connection_authorized(&pool, &claims, id).await?;

    if let Some(name) = req.connection_name.as_deref() {
        if name.trim().is_empty() {
            return Err(AppError::InvalidQuery("connection_name 不能为空".into()));
        }
    }
    if let Some(p) = req.provider.as_deref() {
        validate_provider(p)?;
    }
    if let Some(e) = req.endpoint.as_deref() {
        validate_endpoint(e)?;
    }
    if let Some(b) = req.bucket.as_deref() {
        validate_bucket(b)?;
    }
    if let Some(r) = req.region.as_deref() {
        validate_region(r)?;
    }
    if let Some(ak) = req.access_key_id.as_deref() {
        validate_access_key_id(ak)?;
    }

    // secret_key: None → 保留；Some("") → 拒绝（密钥不可置空）；Some(x) → 加密替换。
    let (touch_secret, new_secret_enc): (bool, Option<String>) = match req.secret_key.as_deref() {
        None => (false, None),
        Some(s) if s.trim().is_empty() => {
            return Err(AppError::InvalidQuery("secret_key 不能置空".into()));
        }
        Some(s) => (true, Some(crypto::encrypt_secret(s.trim())?)),
    };

    let row = sqlx::query_as::<_, ObjectStorageConnection>(
        "UPDATE management.object_storage_connections SET \
            connection_name = COALESCE($1, connection_name), \
            provider = COALESCE($2, provider), \
            endpoint = COALESCE($3, endpoint), \
            region = COALESCE($4, region), \
            bucket = COALESCE($5, bucket), \
            access_key_id = COALESCE($6, access_key_id), \
            secret_key_enc = CASE WHEN $7 THEN $8 ELSE secret_key_enc END, \
            force_path_style = COALESCE($9, force_path_style), \
            connect_timeout_secs = COALESCE($10, connect_timeout_secs), \
            is_active = COALESCE($11, is_active), \
            updated_at = NOW() \
         WHERE id = $12 RETURNING *",
    )
    .bind(req.connection_name.as_deref().map(|s| s.trim()))
    .bind(req.provider.as_deref().map(|s| s.trim()))
    .bind(req.endpoint.as_deref().map(|s| s.trim()))
    .bind(req.region.as_deref().map(|s| s.trim()))
    .bind(req.bucket.as_deref().map(|s| s.trim()))
    .bind(req.access_key_id.as_deref().map(|s| s.trim()))
    .bind(touch_secret)
    .bind(new_secret_enc)
    .bind(req.force_path_style)
    .bind(req.connect_timeout_secs.map(|t| t.clamp(1, 60)))
    .bind(req.is_active)
    .bind(id)
    .fetch_one(&pool)
    .await
    .map_err(|e| map_unique_violation(e, "同名对象存储连接已存在"))?;

    // 配置可能已变（endpoint / 密钥 / bucket 等），踢掉缓存的旧客户端。
    client_cache::invalidate(id);
    Ok(Json(row))
}

pub async fn delete_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    let _ = fetch_connection_authorized(&pool, &claims, id).await?;
    let res = sqlx::query("DELETE FROM management.object_storage_connections WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .map_err(|e| AppError::Internal(format!("删除对象存储连接失败: {e}")))?;
    client_cache::invalidate(id);
    Ok(Json(json!({ "deleted": res.rows_affected() })))
}

// ── 探活 ────────────────────────────────────────────────────────────────

/// HeadBucket，失败则回退 ListObjectsV2(max_keys=1) 校验连接可用。
pub async fn health_check(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    let conn = fetch_connection_authorized(&pool, &claims, id).await?;
    if !conn.is_active {
        return Ok(Json(json!({ "ok": false, "error": "连接已禁用" })));
    }

    // health 前先踢缓存，确保拿最新配置建连（用户可能刚改完密钥就点探活）。
    client_cache::invalidate(id);
    let handle = match client_cache::get_or_create(&conn).await {
        Ok(h) => h,
        Err(e) => return Ok(Json(json!({ "ok": false, "error": e.to_string() }))),
    };

    // 探活整体超时：连接超时的适度倍数，避免慢/挂死后端把请求拖到 HTTP 层超时。
    let budget_secs = (conn.connect_timeout_secs.clamp(1, 60) as u64 * 2).clamp(10, 60);
    let budget = Duration::from_secs(budget_secs);

    let started = Instant::now();
    let probe = tokio::time::timeout(budget, commands::probe_bucket(&handle, &conn.bucket)).await;

    match probe {
        Ok(Ok(())) => Ok(Json(json!({
            "ok": true,
            "latency_ms": started.elapsed().as_millis() as u64,
            "bucket": conn.bucket,
        }))),
        Ok(Err(e)) => Ok(Json(json!({
            "ok": false,
            "error": format!("HeadBucket/ListObjects 失败: {e}")
        }))),
        Err(_) => Ok(Json(
            json!({ "ok": false, "error": "探活超时，请检查网络/endpoint 是否可达" }),
        )),
    }
}

// ── 数据 API：exec ───────────────────────────────────────────────────────

pub async fn exec(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
    Json(req): Json<ExecReq>,
) -> Result<Json<Value>, AppError> {
    let conn = object_storage_ds::fetch_active(&pool, id).await?;

    // 写操作要 member（viewer 拒），读操作任意成员即可。
    if commands::is_write_op(&req.op, &req.args) {
        permissions::require_tenant_member(&pool, &claims, conn.tenant_id).await?;
    } else {
        permissions::require_tenant_membership_any(&pool, &claims, conn.tenant_id).await?;
    }

    let handle = client_cache::get_or_create(&conn).await?;
    let result = commands::execute(&handle, &conn.bucket, &req.op, &req.args).await?;
    Ok(Json(json!({ "op": req.op, "result": result })))
}

// ── Token CRUD ─────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreateTokenReq {
    pub name: String,
    pub description: Option<String>,
    pub allowed_ops: Option<Vec<String>>,
    pub key_prefix_allowlist: Option<Vec<String>>,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateTokenReq {
    pub name: Option<String>,
    pub description: Option<String>,
    pub allowed_ops: Option<Vec<String>>,
    pub key_prefix_allowlist: Option<Vec<String>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub is_active: Option<bool>,
}

pub async fn list_tokens(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(connection_id): Path<i64>,
) -> Result<Json<Vec<ObjectStorageAccessToken>>, AppError> {
    let _ = fetch_connection_authorized(&pool, &claims, connection_id).await?;
    let rows = sqlx::query_as::<_, ObjectStorageAccessToken>(
        "SELECT * FROM management.object_storage_access_tokens \
         WHERE connection_id = $1 ORDER BY id DESC",
    )
    .bind(connection_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("列出对象存储 token 失败: {e}")))?;
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
        .unwrap_or_else(|| os_auth::DEFAULT_OPS.iter().map(|s| s.to_string()).collect());
    os_auth::validate_ops(&ops)?;
    let keys = req
        .key_prefix_allowlist
        .unwrap_or_else(|| vec!["*".to_string()]);
    os_auth::validate_key_prefix_allowlist(&keys)?;

    let plain = os_auth::generate_token();
    let hash = os_auth::hash_token(&plain);
    let prefix = os_auth::token_prefix(&plain);

    let row = sqlx::query_as::<_, ObjectStorageAccessToken>(
        "INSERT INTO management.object_storage_access_tokens \
            (connection_id, name, description, token_hash, token_prefix, \
             allowed_ops, key_prefix_allowlist, expires_at, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *",
    )
    .bind(connection_id)
    .bind(req.name.trim())
    .bind(req.description.as_deref().map(|s| s.trim()))
    .bind(&hash)
    .bind(&prefix)
    .bind(&ops)
    .bind(&keys)
    .bind(req.expires_at)
    .bind(claims.sub)
    .fetch_one(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("创建对象存储 token 失败: {e}")))?;

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
) -> Result<Json<ObjectStorageAccessToken>, AppError> {
    let _ = fetch_connection_authorized(&pool, &claims, connection_id).await?;
    if let Some(ops) = &req.allowed_ops {
        os_auth::validate_ops(ops)?;
    }
    if let Some(keys) = &req.key_prefix_allowlist {
        os_auth::validate_key_prefix_allowlist(keys)?;
    }

    let row = sqlx::query_as::<_, ObjectStorageAccessToken>(
        "UPDATE management.object_storage_access_tokens SET \
            name = COALESCE($1, name), \
            description = COALESCE($2, description), \
            allowed_ops = COALESCE($3, allowed_ops), \
            key_prefix_allowlist = COALESCE($4, key_prefix_allowlist), \
            expires_at = COALESCE($5, expires_at), \
            is_active = COALESCE($6, is_active) \
         WHERE id = $7 AND connection_id = $8 RETURNING *",
    )
    .bind(req.name.as_deref().map(|s| s.trim()))
    .bind(req.description.as_deref().map(|s| s.trim()))
    .bind(req.allowed_ops.as_ref())
    .bind(req.key_prefix_allowlist.as_ref())
    .bind(req.expires_at)
    .bind(req.is_active)
    .bind(token_id)
    .bind(connection_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("更新对象存储 token 失败: {e}")))?
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
        "DELETE FROM management.object_storage_access_tokens WHERE id = $1 AND connection_id = $2",
    )
    .bind(token_id)
    .bind(connection_id)
    .execute(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("删除对象存储 token 失败: {e}")))?;
    Ok(Json(json!({ "deleted": res.rows_affected() })))
}

// ── 内部 helpers ────────────────────────────────────────────────────────

fn map_unique_violation(e: sqlx::Error, msg: &str) -> AppError {
    if let sqlx::Error::Database(ref db_err) = e {
        if db_err.code().as_deref() == Some("23505") {
            return AppError::InvalidQuery(msg.to_string());
        }
    }
    AppError::Internal(format!("DB 错误: {e}"))
}
