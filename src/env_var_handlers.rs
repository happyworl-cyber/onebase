//! 项目级环境变量 CRUD
//!
//! 路由挂在项目路径下（与成员管理 `/api/projects/:id/members` 同款惯例）：
//! - `GET    /api/projects/:id/env-vars`          列表（解密后明文回显）
//! - `POST   /api/projects/:id/env-vars`          新建
//! - `PUT    /api/projects/:id/env-vars/:var_id`  更新
//! - `DELETE /api/projects/:id/env-vars/:var_id`  删除
//!
//! 权限：路由级 `auth_middleware` 已注入 Claims；handler 内统一
//! `require_tenant_admin(pool, claims, project_id)`（Claims 无 tenant_id 字段，
//! 租户上下文只能来自路径参数）。
//!
//! 明文 GET 三道补偿：
//! 1. 响应头 `Cache-Control: no-store`，阻止浏览器/中间层缓存明文密钥；
//! 2. handler 内绝不打印解密后的变量值（仅记审计元信息，不含 value）；
//! 3. 每次读取记一行 `tracing::info!(user_id, tenant_id, "env vars read")` 审计。
//!
//! 值入库前 `crypto::encrypt_secret`，读出 `crypto::decrypt_secret`。
//! 解密失败（密钥轮换/数据损坏）**不返回空串**——用户会误以为"没配过"而覆盖
//! 保存导致密钥静默丢失；显式返回 `<解密失败>` 标记 + `decrypt_error` 字段。

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::{PgPool, Row};
use std::collections::HashMap;

use crate::auth::Claims;
use crate::crypto;
use crate::error::{AppError, Result};
use crate::permissions;

/// 变量名校验规则：以字母或下划线开头，后接字母/数字/下划线。
/// 与 Lua `env.get` / 模板 `{{env.X}}` 的命名空间保持一致。
fn validate_var_name(name: &str) -> Result<()> {
    let mut chars = name.chars();
    let first_ok = matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_');
    let rest_ok = chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if name.is_empty() || !first_ok || !rest_ok {
        return Err(AppError::InvalidQuery(
            "变量名非法：必须匹配 ^[A-Za-z_][A-Za-z0-9_]*$".to_string(),
        ));
    }
    Ok(())
}

/// 新建 / 更新请求体
#[derive(Deserialize)]
pub struct EnvVarRequest {
    pub name: String,
    pub value: String,
    #[serde(default)]
    pub description: Option<String>,
}

/// 变量值大小上限：防误用/盗号塞超大值撑爆存储与执行期内存（全量解密装入 HashMap）
const MAX_VALUE_BYTES: usize = 8 * 1024;
/// 每项目变量条数上限
const MAX_VARS_PER_TENANT: i64 = 200;
/// 解密失败时列表返回的占位串；保存路径拒绝它，防止用户把占位串当真实值写回覆盖密文
const DECRYPT_FAILED_PLACEHOLDER: &str = "<解密失败>";

/// 变量值校验：长度上限 + 拒绝写入解密失败占位串。
fn validate_value(value: &str) -> Result<()> {
    if value.len() > MAX_VALUE_BYTES {
        return Err(AppError::InvalidQuery(format!(
            "变量值过大：上限 {}KB",
            MAX_VALUE_BYTES / 1024
        )));
    }
    // 解密失败的行在列表里显示为占位串；若用户未改值直接保存会把占位串加密写回、
    // 永久覆盖原密文。这里直接拒绝，要求重新填入真实值。
    if value == DECRYPT_FAILED_PLACEHOLDER {
        return Err(AppError::InvalidQuery(
            "该变量当前解密失败，请重新填入真实值后再保存".to_string(),
        ));
    }
    Ok(())
}

/// Provisioner Webhook 返回的 env_vars 批量写入；非法项跳过，不阻断开通。
pub async fn seed_provision_env_vars(
    pool: &PgPool,
    tenant_id: i32,
    vars: &HashMap<String, String>,
    created_by: i32,
) -> Result<()> {
    if vars.is_empty() {
        return Ok(());
    }

    for (name, value) in vars {
        if validate_var_name(name).is_err() {
            tracing::warn!(tenant_id, name = %name, "跳过非法 provision env var 名");
            continue;
        }
        if validate_value(value).is_err() {
            tracing::warn!(tenant_id, name = %name, "跳过非法 provision env var 值");
            continue;
        }

        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM management.project_env_vars WHERE tenant_id = $1")
                .bind(tenant_id)
                .fetch_one(pool)
                .await?;
        if count >= MAX_VARS_PER_TENANT {
            tracing::warn!(
                tenant_id,
                "provision env vars 已达上限 {}，跳过后续项",
                MAX_VARS_PER_TENANT
            );
            break;
        }

        let value_encrypted = crypto::encrypt_secret(value)?;
        sqlx::query(
            r#"
            INSERT INTO management.project_env_vars
                (tenant_id, name, value_encrypted, description, created_by, updated_by)
            VALUES ($1, $2, $3, 'Provisioner Webhook 自动写入', $4, $4)
            ON CONFLICT (tenant_id, name) DO UPDATE
                SET value_encrypted = EXCLUDED.value_encrypted,
                    updated_by = EXCLUDED.updated_by
            "#,
        )
        .bind(tenant_id)
        .bind(name)
        .bind(&value_encrypted)
        .bind(created_by)
        .execute(pool)
        .await?;

        tracing::info!(
            user_id = created_by,
            tenant_id,
            name = %name,
            "env var seeded from provision webhook"
        );
    }

    Ok(())
}

/// 把一行 project_env_vars 解密后转 JSON（含明文 value）。
///
/// 解密失败的行不返回空串（防止用户把"解密失败"误读成"空值"后覆盖保存，
/// 造成密钥静默丢失），显式返回 `<解密失败>` 占位 + `decrypt_error: true`。
fn row_to_json(row: &sqlx::postgres::PgRow) -> serde_json::Value {
    let value_encrypted: String = row.get("value_encrypted");
    let name: String = row.get("name");
    let (value, decrypt_error) = match crypto::decrypt_secret(&value_encrypted) {
        Ok(v) => (v, false),
        Err(e) => {
            tracing::error!(name = %name, error = %e, "环境变量解密失败");
            (DECRYPT_FAILED_PLACEHOLDER.to_string(), true)
        }
    };
    json!({
        "id": row.get::<i32, _>("id"),
        "name": name,
        "value": value,
        "decrypt_error": decrypt_error,
        "description": row.get::<Option<String>, _>("description"),
        "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
        "updated_at": row.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
    })
}

/// GET /api/projects/:id/env-vars —— 列表，返回解密后明文。
///
/// 响应带 `Cache-Control: no-store`；每次读取记一行审计日志（不含变量值）。
pub async fn list_env_vars(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
) -> Result<Response> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;

    let rows = sqlx::query(
        r#"
        SELECT id, name, value_encrypted, description, created_at, updated_at
        FROM management.project_env_vars
        WHERE tenant_id = $1
        ORDER BY name ASC
        "#,
    )
    .bind(project_id)
    .fetch_all(&pool)
    .await?;

    // 审计：仅记元信息（谁、哪个项目、读了几条），绝不打印变量值
    tracing::info!(
        user_id = claims.sub,
        tenant_id = project_id,
        count = rows.len(),
        "env vars read"
    );

    let body: Vec<serde_json::Value> = rows.iter().map(row_to_json).collect();

    // 明文密钥严禁缓存
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    Ok((StatusCode::OK, headers, Json(body)).into_response())
}

/// POST /api/projects/:id/env-vars —— 新建变量。
///
/// 重名（UNIQUE(tenant_id, name) 冲突）由 error.rs 统一映射为 409。
pub async fn create_env_var(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
    Json(req): Json<EnvVarRequest>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;
    validate_var_name(&req.name)?;
    validate_value(&req.value)?;

    // 条数上限：防御性约束（计数与插入间存在竞态窗口，但 admin-only 入口下
    // 软上限足够，不值得为此加锁）
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM management.project_env_vars WHERE tenant_id = $1")
            .bind(project_id)
            .fetch_one(&pool)
            .await?;
    if count >= MAX_VARS_PER_TENANT {
        return Err(AppError::InvalidQuery(format!(
            "环境变量数量已达上限（{}），请清理后再添加",
            MAX_VARS_PER_TENANT
        )));
    }

    let value_encrypted = crypto::encrypt_secret(&req.value)?;

    let row = sqlx::query(
        r#"
        INSERT INTO management.project_env_vars
            (tenant_id, name, value_encrypted, description, created_by, updated_by)
        VALUES ($1, $2, $3, $4, $5, $5)
        RETURNING id, name, value_encrypted, description, created_at, updated_at
        "#,
    )
    .bind(project_id)
    .bind(&req.name)
    .bind(&value_encrypted)
    .bind(&req.description)
    .bind(claims.sub)
    .fetch_one(&pool)
    .await?;

    tracing::info!(
        user_id = claims.sub,
        tenant_id = project_id,
        name = %req.name,
        "env var created"
    );

    Ok(Json(row_to_json(&row)))
}

/// PUT /api/projects/:id/env-vars/:var_id —— 更新变量。
pub async fn update_env_var(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, var_id)): Path<(i32, i32)>,
    Json(req): Json<EnvVarRequest>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;
    validate_var_name(&req.name)?;
    validate_value(&req.value)?;

    let value_encrypted = crypto::encrypt_secret(&req.value)?;

    // WHERE 同时带 tenant_id，防越权改到别的项目的变量。
    // updated_at 由迁移 031 的 BEFORE UPDATE 触发器统一维护，此处不手写。
    let row = sqlx::query(
        r#"
        UPDATE management.project_env_vars
        SET name = $1, value_encrypted = $2, description = $3,
            updated_by = $4
        WHERE id = $5 AND tenant_id = $6
        RETURNING id, name, value_encrypted, description, created_at, updated_at
        "#,
    )
    .bind(&req.name)
    .bind(&value_encrypted)
    .bind(&req.description)
    .bind(claims.sub)
    .bind(var_id)
    .bind(project_id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("环境变量 {} 不存在", var_id)))?;

    tracing::info!(
        user_id = claims.sub,
        tenant_id = project_id,
        var_id = var_id,
        "env var updated"
    );

    Ok(Json(row_to_json(&row)))
}

/// DELETE /api/projects/:id/env-vars/:var_id —— 删除变量。
pub async fn delete_env_var(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, var_id)): Path<(i32, i32)>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;

    let affected = sqlx::query(
        "DELETE FROM management.project_env_vars WHERE id = $1 AND tenant_id = $2",
    )
    .bind(var_id)
    .bind(project_id)
    .execute(&pool)
    .await?
    .rows_affected();

    if affected == 0 {
        return Err(AppError::NotFound(format!("环境变量 {} 不存在", var_id)));
    }

    tracing::info!(
        user_id = claims.sub,
        tenant_id = project_id,
        var_id = var_id,
        "env var deleted"
    );

    Ok(Json(json!({ "deleted": true })))
}
