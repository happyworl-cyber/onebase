//! 平台服务令牌管理端点（`/api/platform-tokens`）
//!
//! **仅平台超管**可创建 / 列出 / 停用平台服务令牌。
//! 为避免「令牌再造令牌」的提权链，**禁止用平台令牌（obp_）调用创建接口**。

use axum::extract::{Extension, Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};

use crate::auth::Claims;
use crate::error::{AppError, Result};
use crate::platform_token;

fn require_platform_token_admin(claims: &Claims) -> Result<()> {
    if claims.is_superadmin {
        Ok(())
    } else {
        Err(AppError::Forbidden(
            "仅平台超管可管理平台服务令牌".to_string(),
        ))
    }
}

#[derive(Debug, Deserialize)]
pub struct CreatePlatformTokenRequest {
    pub name: String,
    /// scope 列表，如 ["project:create","workflow:write"]；为空则默认给全部已知 scope。
    #[serde(default)]
    pub scopes: Vec<String>,
    /// 过期天数；不传表示永不过期。
    pub expires_in_days: Option<i64>,
}

/// POST /api/platform-tokens —— 创建平台令牌（明文只返回一次）
pub async fn create_platform_token(
    State(pool): State<PgPool>,
    claims: Extension<Claims>,
    token_ctx: Option<Extension<platform_token::PlatformTokenContext>>,
    Json(req): Json<CreatePlatformTokenRequest>,
) -> Result<Json<Value>> {
    require_platform_token_admin(&claims)?;
    // 禁止用平台令牌再创建平台令牌（防提权链）。
    if token_ctx.is_some() {
        return Err(AppError::Forbidden(
            "禁止使用平台令牌创建新的平台令牌，请用登录用户（JWT）操作".to_string(),
        ));
    }

    let name = req.name.trim();
    if name.is_empty() || name.len() > 100 {
        return Err(AppError::InvalidQuery("令牌名称需为 1-100 个字符".to_string()));
    }

    // 默认授予全部已知 scope（绑定用户自身权限仍会兜底限制实际能做什么）。
    let scopes: Vec<String> = if req.scopes.is_empty() {
        platform_token::ALL_SCOPES
            .iter()
            .map(|s| s.to_string())
            .collect()
    } else {
        req.scopes.clone()
    };
    platform_token::validate_scopes(&scopes)?;

    let raw = platform_token::generate_token();
    let token_hash = platform_token::hash_token(&raw);
    let token_prefix = format!("{}...", &raw[..10]); // obp_xxxxx...
    let scopes_json = serde_json::to_value(&scopes).unwrap_or(json!([]));

    let row = sqlx::query(
        r#"
        INSERT INTO management.platform_tokens
            (user_id, name, token_hash, token_prefix, scopes, expires_at)
        VALUES ($1, $2, $3, $4, $5,
            CASE WHEN $6::BIGINT IS NOT NULL THEN NOW() + ($6::BIGINT || ' days')::INTERVAL ELSE NULL END)
        RETURNING id, created_at::TEXT
        "#,
    )
    .bind(claims.sub)
    .bind(name)
    .bind(&token_hash)
    .bind(&token_prefix)
    .bind(&scopes_json)
    .bind(req.expires_in_days)
    .fetch_one(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("创建平台令牌失败: {}", e)))?;

    let id: i32 = row.get("id");
    let created_at: String = row.get("created_at");

    tracing::info!(
        "创建平台令牌: {} (id={}, user_id={}, scopes={:?})",
        name,
        id,
        claims.sub,
        scopes
    );

    Ok(Json(json!({
        "id": id,
        "name": name,
        "token": raw, // 只在创建时返回完整明文
        "token_prefix": token_prefix,
        "scopes": scopes,
        "created_at": created_at,
        "message": "请立即保存该令牌，它只会显示这一次！"
    })))
}

/// GET /api/platform-tokens —— 列出全部平台令牌（仅超管）
pub async fn list_platform_tokens(
    State(pool): State<PgPool>,
    claims: Extension<Claims>,
) -> Result<Json<Value>> {
    require_platform_token_admin(&claims)?;
    let rows = sqlx::query(
        r#"
        SELECT pt.id, pt.user_id, u.email AS user_email, pt.name, pt.token_prefix,
               pt.scopes, pt.is_active,
               pt.last_used_at::TEXT, pt.created_at::TEXT, pt.expires_at::TEXT
        FROM management.platform_tokens pt
        JOIN users u ON u.id = pt.user_id
        ORDER BY pt.created_at DESC
        "#,
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询平台令牌失败: {}", e)))?;

    let tokens: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "id": row.get::<i32, _>("id"),
                "user_id": row.get::<i32, _>("user_id"),
                "user_email": row.get::<String, _>("user_email"),
                "name": row.get::<String, _>("name"),
                "token_prefix": row.get::<String, _>("token_prefix"),
                "scopes": row.get::<Value, _>("scopes"),
                "is_active": row.get::<bool, _>("is_active"),
                "last_used_at": row.get::<Option<String>, _>("last_used_at"),
                "created_at": row.get::<Option<String>, _>("created_at"),
                "expires_at": row.get::<Option<String>, _>("expires_at"),
            })
        })
        .collect();

    Ok(Json(json!({ "tokens": tokens })))
}

/// DELETE /api/platform-tokens/:id —— 停用令牌（软删除：is_active=false）
pub async fn delete_platform_token(
    State(pool): State<PgPool>,
    claims: Extension<Claims>,
    Path(id): Path<i32>,
) -> Result<Json<Value>> {
    require_platform_token_admin(&claims)?;
    let affected = sqlx::query("UPDATE management.platform_tokens SET is_active = false WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .map_err(|e| AppError::Internal(format!("停用平台令牌失败: {}", e)))?
        .rows_affected();

    if affected == 0 {
        return Err(AppError::NotFound("令牌不存在或无权操作".to_string()));
    }

    Ok(Json(json!({ "success": true, "id": id })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claims(superadmin: bool) -> Claims {
        Claims {
            sub: 1,
            email: "u@example.com".to_string(),
            role: "user".to_string(),
            is_superadmin: superadmin,
            jti: "test".to_string(),
            exp: 9_999_999_999,
            iat: 0,
        }
    }

    #[test]
    fn platform_token_admin_allows_superadmin_only() {
        assert!(require_platform_token_admin(&claims(true)).is_ok());
        assert!(require_platform_token_admin(&claims(false)).is_err());
    }
}
