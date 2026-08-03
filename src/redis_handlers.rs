//! Redis 数据源的管理端 + 数据端 API（bin-only）。
//!
//! 鉴权与 ES 连接一致：
//!   - 管理端（连接 CRUD / health）：超管 / 该租户 owner-admin
//!   - 数据端（exec 读写）：读走「任意租户成员」，写走「owner/admin/member」（viewer 只读）
//!
//! 密码明文从不出 handler 边界：`RedisConnection.password_enc` 已 `#[serde(skip_serializing)]`，
//! 解密只在 `redis_ds::client_cache` 建连时短暂发生。
//!
//! 路由（见 main.rs 注册处）：
//! ```text
//! GET    /api/admin/redis-connections
//! POST   /api/admin/redis-connections
//! GET    /api/admin/redis-connections/:id
//! PUT    /api/admin/redis-connections/:id
//! DELETE /api/admin/redis-connections/:id
//! POST   /api/admin/redis-connections/:id/health
//!
//! POST   /api/redis-connections/:id/exec
//! ```

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
use crate::permissions;
use crate::redis_ds::models::RedisConnection;
use crate::redis_ds::{self, client_cache, commands};

// ── 校验 helper ─────────────────────────────────────────────────────────

/// 超管 / 该租户 owner-admin 才能操作（与 es::admin_handlers::require_tenant_admin 同款）。
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
            "仅超管或该租户 owner/admin 可管理 Redis 连接".to_string(),
        ))
    }
}

/// 取连接行或返回 NotFound，同时校验当前用户能管理其所属租户。
async fn fetch_connection_authorized(
    pool: &PgPool,
    claims: &Claims,
    id: i64,
) -> Result<RedisConnection, AppError> {
    let conn = sqlx::query_as::<_, RedisConnection>(
        "SELECT * FROM management.redis_connections WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询 Redis 连接失败: {e}")))?
    .ok_or_else(|| AppError::NotFound(format!("Redis 连接 {id} 不存在")))?;
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
    pub host: String,
    pub port: Option<i32>,
    pub db_index: Option<i32>,
    pub username: Option<String>,
    /// 明文密码；无密码实例留空 / null。
    pub password: Option<String>,
    pub use_tls: Option<bool>,
    pub connect_timeout_secs: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateConnectionReq {
    pub connection_name: Option<String>,
    pub host: Option<String>,
    pub port: Option<i32>,
    pub db_index: Option<i32>,
    pub username: Option<String>,
    /// **null** = 保留原密码；**非空字符串** = 替换；**空字符串 ""** = 清空（无密码）。
    pub password: Option<String>,
    pub use_tls: Option<bool>,
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
) -> Result<Json<Vec<RedisConnection>>, AppError> {
    let rows = if claims.is_superadmin {
        match q.tenant_id {
            Some(t) => sqlx::query_as::<_, RedisConnection>(
                "SELECT * FROM management.redis_connections WHERE tenant_id = $1 ORDER BY id DESC",
            )
            .bind(t)
            .fetch_all(&pool)
            .await,
            None => sqlx::query_as::<_, RedisConnection>(
                "SELECT * FROM management.redis_connections ORDER BY id DESC",
            )
            .fetch_all(&pool)
            .await,
        }
    } else {
        let admins = audit_handlers::admin_tenant_ids(&pool, &claims).await?;
        if admins.is_empty() {
            return Ok(Json(vec![]));
        }
        sqlx::query_as::<_, RedisConnection>(
            "SELECT * FROM management.redis_connections WHERE tenant_id = ANY($1) ORDER BY id DESC",
        )
        .bind(&admins)
        .fetch_all(&pool)
        .await
    }
    .map_err(|e| AppError::Internal(format!("列出 Redis 连接失败: {e}")))?;
    Ok(Json(rows))
}

pub async fn get_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<RedisConnection>, AppError> {
    let conn = fetch_connection_authorized(&pool, &claims, id).await?;
    Ok(Json(conn))
}

pub async fn create_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<CreateConnectionReq>,
) -> Result<Json<RedisConnection>, AppError> {
    require_tenant_admin(&pool, &claims, req.tenant_id).await?;

    if req.connection_name.trim().is_empty() {
        return Err(AppError::InvalidQuery("connection_name 不能为空".into()));
    }
    validate_host(&req.host)?;
    let port = req.port.unwrap_or(6379);
    validate_port(port)?;
    let db_index = req.db_index.unwrap_or(0);
    validate_db_index(db_index)?;
    let timeout = req.connect_timeout_secs.unwrap_or(5).clamp(1, 60);

    let password_enc = match req.password.as_deref() {
        None | Some("") => None,
        Some(p) => Some(crypto::encrypt_secret(p)?),
    };
    let username = normalize_opt(req.username);

    let row = sqlx::query_as::<_, RedisConnection>(
        "INSERT INTO management.redis_connections \
            (tenant_id, connection_name, host, port, db_index, username, password_enc, \
             use_tls, connect_timeout_secs, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *",
    )
    .bind(req.tenant_id)
    .bind(req.connection_name.trim())
    .bind(req.host.trim())
    .bind(port)
    .bind(db_index)
    .bind(username)
    .bind(password_enc)
    .bind(req.use_tls.unwrap_or(false))
    .bind(timeout)
    .bind(claims.sub)
    .fetch_one(&pool)
    .await
    .map_err(|e| map_unique_violation(e, "同名 Redis 连接已存在"))?;

    Ok(Json(row))
}

pub async fn update_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateConnectionReq>,
) -> Result<Json<RedisConnection>, AppError> {
    let _existing = fetch_connection_authorized(&pool, &claims, id).await?;

    if let Some(h) = req.host.as_deref() {
        validate_host(h)?;
    }
    if let Some(p) = req.port {
        validate_port(p)?;
    }
    if let Some(d) = req.db_index {
        validate_db_index(d)?;
    }

    // password: None → 保留（用哨兵值，SQL 里 COALESCE 不动）；Some("") → 清空；Some(x) → 加密替换。
    // 用两个绑定表达「是否改动」与「新值」，避免 COALESCE 无法表达「设为 NULL」。
    let (touch_password, new_password_enc): (bool, Option<String>) = match req.password.as_deref() {
        None => (false, None),
        Some("") => (true, None),
        Some(p) => (true, Some(crypto::encrypt_secret(p)?)),
    };

    let row = sqlx::query_as::<_, RedisConnection>(
        "UPDATE management.redis_connections SET \
            connection_name = COALESCE($1, connection_name), \
            host = COALESCE($2, host), \
            port = COALESCE($3, port), \
            db_index = COALESCE($4, db_index), \
            username = CASE WHEN $5 THEN $6 ELSE username END, \
            password_enc = CASE WHEN $7 THEN $8 ELSE password_enc END, \
            use_tls = COALESCE($9, use_tls), \
            connect_timeout_secs = COALESCE($10, connect_timeout_secs), \
            is_active = COALESCE($11, is_active), \
            updated_at = NOW() \
         WHERE id = $12 RETURNING *",
    )
    .bind(req.connection_name.as_deref().map(|s| s.trim()))
    .bind(req.host.as_deref().map(|s| s.trim()))
    .bind(req.port)
    .bind(req.db_index)
    // username: 只要请求里带了该字段就更新（含清空为 NULL）
    .bind(req.username.is_some())
    .bind(normalize_opt(req.username))
    .bind(touch_password)
    .bind(new_password_enc)
    .bind(req.use_tls)
    .bind(req.connect_timeout_secs.map(|t| t.clamp(1, 60)))
    .bind(req.is_active)
    .bind(id)
    .fetch_one(&pool)
    .await
    .map_err(|e| map_unique_violation(e, "同名 Redis 连接已存在"))?;

    // 配置可能已变（地址 / 密码 / TLS），踢掉缓存的旧连接。
    client_cache::invalidate(id);
    Ok(Json(row))
}

pub async fn delete_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    let _ = fetch_connection_authorized(&pool, &claims, id).await?;
    let res = sqlx::query("DELETE FROM management.redis_connections WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .map_err(|e| AppError::Internal(format!("删除 Redis 连接失败: {e}")))?;
    client_cache::invalidate(id);
    Ok(Json(json!({ "deleted": res.rows_affected() })))
}

// ── 探活 ────────────────────────────────────────────────────────────────

/// PING + INFO server（截取版本 / 运行秒数）校验连接可用。
pub async fn health_check(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    let conn = fetch_connection_authorized(&pool, &claims, id).await?;
    if !conn.is_active {
        return Ok(Json(json!({ "ok": false, "error": "连接已禁用" })));
    }

    // health 前先踢缓存，确保拿最新配置建连（用户可能刚改完密码就点探活）。
    client_cache::invalidate(id);
    let manager = match client_cache::get_or_create(&conn).await {
        Ok(m) => m,
        Err(e) => return Ok(Json(json!({ "ok": false, "error": e.to_string() }))),
    };
    let mut c = manager.clone();

    let pong: Result<String, redis::RedisError> =
        redis::cmd("PING").query_async(&mut c).await;
    if let Err(e) = pong {
        return Ok(Json(json!({ "ok": false, "error": format!("PING 失败: {e}") })));
    }

    let info: Option<String> = redis::cmd("INFO")
        .arg("server")
        .query_async(&mut c)
        .await
        .ok();
    let version = info
        .as_deref()
        .and_then(|s| {
            s.lines()
                .find_map(|l| l.strip_prefix("redis_version:"))
                .map(|v| v.trim().to_string())
        });

    Ok(Json(json!({
        "ok": true,
        "redis_version": version,
    })))
}

// ── 数据 API：exec ───────────────────────────────────────────────────────

pub async fn exec(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
    Json(req): Json<ExecReq>,
) -> Result<Json<Value>, AppError> {
    let conn = redis_ds::fetch_active(&pool, id).await?;

    // 写操作要 member（viewer 拒），读操作任意成员即可。
    if commands::is_write_op(&req.op.to_lowercase()) {
        permissions::require_tenant_member(&pool, &claims, conn.tenant_id).await?;
    } else {
        permissions::require_tenant_membership_any(&pool, &claims, conn.tenant_id).await?;
    }

    let manager = client_cache::get_or_create(&conn).await?;
    let result = commands::execute(&manager, &req.op, &req.args).await?;
    Ok(Json(json!({ "op": req.op, "result": result })))
}

// ── 内部 helpers ────────────────────────────────────────────────────────

fn normalize_opt(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn validate_host(host: &str) -> Result<(), AppError> {
    let t = host.trim();
    if t.is_empty() {
        return Err(AppError::InvalidQuery("host 不能为空".into()));
    }
    if t.chars().any(|c| c.is_whitespace()) {
        return Err(AppError::InvalidQuery("host 含非法空白字符".into()));
    }
    Ok(())
}

fn validate_port(port: i32) -> Result<(), AppError> {
    if (1..=65535).contains(&port) {
        Ok(())
    } else {
        Err(AppError::InvalidQuery("port 必须在 1..=65535".into()))
    }
}

fn validate_db_index(db: i32) -> Result<(), AppError> {
    if (0..=255).contains(&db) {
        Ok(())
    } else {
        Err(AppError::InvalidQuery("db_index 必须在 0..=255".into()))
    }
}

fn map_unique_violation(e: sqlx::Error, msg: &str) -> AppError {
    if let sqlx::Error::Database(ref db_err) = e {
        if db_err.code().as_deref() == Some("23505") {
            return AppError::InvalidQuery(msg.to_string());
        }
    }
    AppError::Internal(format!("DB 错误: {e}"))
}
