//! M2 自助开通向导：PG 池超管 CRUD handlers + 用户视角只读。
//!
//! 路由层（详见 main.rs）：
//!   - `/api/admin/pg-pools` + `/api/admin/pg-pools/:id` + `/api/admin/pg-pools/:id/test`
//!     挂在 require_superadmin 链路里
//!   - `/api/provision/pg-pools/*` 挂在普通 auth_middleware 链路（任意已登录用户可读）
//!
//! 鉴权策略：路由层挂中间件 + handler 内部 require_super_admin 兜底（W 系列 spec
//! 一贯的"双 check"约定）。

use crate::auth::Claims;
use crate::crypto::encrypt_secret;
use crate::error::{AppError, Result};
use crate::pg_pool_helpers::{self, PgPoolEntry};
use crate::provision_webhook;
use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::Deserialize;
use sqlx::{PgPool, Row};

// ─── 鉴权辅助 ─────────────────────────────────────────────────────

fn require_super_admin(_claims: &Claims) -> Result<()> {
    // 平台超管限制已按需求移除：任何已认证用户均放行（调用点都在 auth_middleware 之后）。
    Ok(())
}

// ─── 序列化 ───────────────────────────────────────────────────────

fn entry_to_admin_json(entry: &PgPoolEntry) -> serde_json::Value {
    // 超管视角：返回完整字段（不含密码本身——密码只接受写入，不返回明文/密文）
    serde_json::json!({
        "id":          entry.id,
        "name":        entry.name,
        "db_host":     entry.db_host,
        "db_port":     entry.db_port,
        "admin_user":  entry.admin_user,
        "note":        entry.note,
        "is_active":   entry.is_active,
    })
}

fn entry_to_user_json(entry: &PgPoolEntry, is_platform_instance: bool) -> serde_json::Value {
    // 用户视角：不暴露 admin_user
    serde_json::json!({
        "id":       entry.id,
        "name":     entry.name,
        "db_host":  entry.db_host,
        "db_port":  entry.db_port,
        "note":     entry.note,
        "is_platform_instance": is_platform_instance,
    })
}

// ─── 超管 CRUD ───────────────────────────────────────────────────

/// GET /api/admin/pg-pools
pub async fn list_pg_pools(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<serde_json::Value>>> {
    require_super_admin(&claims)?;
    let entries = pg_pool_helpers::list_all_pools(&pool).await?;
    Ok(Json(entries.iter().map(entry_to_admin_json).collect()))
}

#[derive(Deserialize)]
pub struct CreatePgPoolRequest {
    pub name: String,
    pub db_host: String,
    pub db_port: Option<i32>,
    pub admin_user: String,
    pub admin_password: String,
    pub note: Option<String>,
}

/// POST /api/admin/pg-pools
pub async fn create_pg_pool(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<CreatePgPoolRequest>,
) -> Result<Json<serde_json::Value>> {
    require_super_admin(&claims)?;

    if req.name.trim().is_empty() {
        return Err(AppError::InvalidQuery("name 不能为空".to_string()));
    }
    if req.db_host.trim().is_empty() {
        return Err(AppError::InvalidQuery("db_host 不能为空".to_string()));
    }
    if req.admin_user.trim().is_empty() {
        return Err(AppError::InvalidQuery("admin_user 不能为空".to_string()));
    }
    if req.admin_password.is_empty() {
        return Err(AppError::InvalidQuery(
            "admin_password 不能为空".to_string(),
        ));
    }

    let encrypted = encrypt_secret(&req.admin_password)
        .map_err(|e| AppError::Internal(format!("admin 密码加密失败: {}", e)))?;

    let row = sqlx::query(
        r#"
        INSERT INTO management.pg_pools (name, db_host, db_port, admin_user, admin_password_encrypted, note, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, true)
        RETURNING id, name, db_host, db_port, admin_user, note, is_active
        "#,
    )
    .bind(req.name.trim())
    .bind(req.db_host.trim())
    .bind(req.db_port.unwrap_or(5432))
    .bind(req.admin_user.trim())
    .bind(&encrypted)
    .bind(req.note.as_deref())
    .fetch_one(&pool)
    .await
    .map_err(|e| match &e {
        sqlx::Error::Database(db) if db.constraint() == Some("pg_pools_name_key") => {
            AppError::InvalidQuery(format!("PG 池名称 '{}' 已被占用", req.name))
        }
        _ => AppError::Database(e),
    })?;

    let entry = pg_pool_helpers::get_pool(&pool, row.try_get::<i32, _>("id")?).await?;

    tracing::info!(
        "超管 {} 创建 PG 池 {} (id={}, host={}:{})",
        claims.email,
        entry.name,
        entry.id,
        entry.db_host,
        entry.db_port,
    );

    Ok(Json(entry_to_admin_json(&entry)))
}

#[derive(Deserialize)]
pub struct UpdatePgPoolRequest {
    pub name: Option<String>,
    pub db_host: Option<String>,
    pub db_port: Option<i32>,
    pub admin_user: Option<String>,
    /// 空字符串视为"不修改密码"
    pub admin_password: Option<String>,
    pub note: Option<String>,
    pub is_active: Option<bool>,
}

/// PATCH /api/admin/pg-pools/:id
pub async fn update_pg_pool(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i32>,
    Json(req): Json<UpdatePgPoolRequest>,
) -> Result<Json<serde_json::Value>> {
    require_super_admin(&claims)?;

    // 确认存在
    let _existing = pg_pool_helpers::get_pool(&pool, id).await?;

    let password_to_set = match req.admin_password.as_deref() {
        Some(p) if !p.is_empty() => {
            Some(encrypt_secret(p).map_err(|e| AppError::Internal(format!("加密失败: {}", e)))?)
        }
        _ => None,
    };

    sqlx::query(
        r#"
        UPDATE management.pg_pools
        SET
            name = COALESCE($1, name),
            db_host = COALESCE($2, db_host),
            db_port = COALESCE($3, db_port),
            admin_user = COALESCE($4, admin_user),
            admin_password_encrypted = COALESCE($5, admin_password_encrypted),
            note = CASE WHEN $7::bool THEN $6 ELSE note END,
            is_active = COALESCE($8, is_active)
        WHERE id = $9
        "#,
    )
    .bind(req.name.as_deref())
    .bind(req.db_host.as_deref())
    .bind(req.db_port)
    .bind(req.admin_user.as_deref())
    .bind(password_to_set.as_deref())
    .bind(req.note.as_deref())
    .bind(req.note.is_some())
    .bind(req.is_active)
    .bind(id)
    .execute(&pool)
    .await?;

    tracing::info!("超管 {} 更新 PG 池 {}", claims.email, id);

    let entry = pg_pool_helpers::get_pool(&pool, id).await?;
    Ok(Json(entry_to_admin_json(&entry)))
}

/// DELETE /api/admin/pg-pools/:id —— 软删（is_active=false）。
///
/// 不级联删 tenant_databases——已经从这台 PG provisioned 出去的项目继续可用。
pub async fn delete_pg_pool(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i32>,
) -> Result<Json<serde_json::Value>> {
    require_super_admin(&claims)?;

    let result = sqlx::query("UPDATE management.pg_pools SET is_active = false WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("PG 池 {} 不存在", id)));
    }

    tracing::info!("超管 {} 停用 PG 池 {}", claims.email, id);
    Ok(Json(serde_json::json!({ "id": id, "is_active": false })))
}

/// POST /api/admin/pg-pools/:id/test —— 用 admin 凭据 SELECT 1。
pub async fn test_pg_pool(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i32>,
) -> Result<Json<serde_json::Value>> {
    require_super_admin(&claims)?;

    match pg_pool_helpers::test_pool(&pool, id).await {
        Ok(()) => Ok(Json(serde_json::json!({ "ok": true }))),
        Err(e) => {
            // 探活失败不算 5xx——是 PG 端 / 凭据 / 网络问题；前端要展示给运营看
            let msg = match &e {
                AppError::Internal(m) | AppError::InvalidQuery(m) => m.clone(),
                _ => e.to_string(),
            };
            Ok(Json(serde_json::json!({ "ok": false, "error": msg })))
        }
    }
}

// ─── 用户视角（任意已登录用户）─────────────────────────────────

/// GET /api/provision/pg-pools/available —— 给 wizard 用的下拉数据。
///
/// 只返回 is_active=true 的池，且**不含** admin_user / 密码字段。
/// 与当前平台 `DATABASE_URL` 同 host:port 的池会标记 `is_platform_instance=true`。
pub async fn list_available_pg_pools(
    State(pool): State<PgPool>,
    Extension(_claims): Extension<Claims>,
) -> Result<Json<Vec<serde_json::Value>>> {
    let entries = pg_pool_helpers::list_active_pools(&pool).await?;
    let platform = pg_pool_helpers::platform_instance_from_env().ok();
    Ok(Json(
        entries
            .iter()
            .map(|e| {
                let is_platform = platform.as_ref().is_some_and(|p| {
                    pg_pool_helpers::same_pg_endpoint(&e.db_host, e.db_port, &p.db_host, p.db_port)
                });
                entry_to_user_json(e, is_platform)
            })
            .collect(),
    ))
}

/// GET /api/provision/pg-pools/platform-instance —— 当前 Onebase 平台自身 PG 实例。
pub async fn get_platform_pg_instance(
    State(pool): State<PgPool>,
    Extension(_claims): Extension<Claims>,
) -> Result<Json<serde_json::Value>> {
    let platform = match pg_pool_helpers::platform_instance_from_env() {
        Ok(p) => p,
        Err(_) => {
            return Ok(Json(serde_json::json!({ "available": false })));
        }
    };

    let matching_pool_id = pg_pool_helpers::list_active_pools(&pool)
        .await?
        .into_iter()
        .find(|e| {
            pg_pool_helpers::same_pg_endpoint(
                &e.db_host,
                e.db_port,
                &platform.db_host,
                platform.db_port,
            )
        })
        .map(|e| e.id);

    let (provision_ready, provision_error) = match pg_pool_helpers::probe_platform_provision().await
    {
        Ok(()) => (true, None::<String>),
        Err(e) => (false, Some(e.to_string())),
    };

    Ok(Json(serde_json::json!({
        "available": true,
        "db_host": platform.db_host,
        "db_port": platform.db_port,
        "management_db_name": platform.management_db_name,
        "matching_pool_id": matching_pool_id,
        "provision_ready": provision_ready,
        "provision_error": provision_error,
    })))
}

/// GET /api/provision/webhook-config —— 运维 Webhook 开通是否可用（不含 secret）。
pub async fn get_provision_webhook_config(
    Extension(_claims): Extension<Claims>,
) -> Result<Json<serde_json::Value>> {
    Ok(Json(provision_webhook::public_webhook_config()))
}

/// GET /api/admin/provision/webhook-status —— 超管只读 Webhook 配置状态。
pub async fn get_admin_provision_webhook_status(
    Extension(claims): Extension<Claims>,
) -> Result<Json<serde_json::Value>> {
    require_super_admin(&claims)?;
    Ok(Json(provision_webhook::admin_webhook_status()))
}

/// POST /api/admin/provision/webhook-probe —— 超管探活 Provisioner 端点。
pub async fn probe_admin_provision_webhook(
    Extension(claims): Extension<Claims>,
) -> Result<Json<serde_json::Value>> {
    require_super_admin(&claims)?;
    Ok(Json(provision_webhook::probe_provision_webhook().await))
}
