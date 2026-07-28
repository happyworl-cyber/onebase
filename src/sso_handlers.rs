//! SSO / OAuth2 API 端点
//!
//! - GET  /auth/sso/providers              — 列出当前租户可用的 SSO Provider
//! - GET  /auth/sso/:provider/authorize    — 发起 SSO 登录（重定向到第三方）
//! - GET  /auth/sso/:provider/callback     — 第三方回调（授权码换 token）
//! - 管理 API (需认证)
//!   - GET    /api/sso/providers            — 列出全部 provider（管理）
//!   - POST   /api/sso/providers            — 创建 provider
//!   - PATCH  /api/sso/providers/:id        — 更新 provider
//!   - DELETE /api/sso/providers/:id        — 删除 provider

use axum::{
    extract::{Extension, Path, Query, State},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Row};

use crate::auth::{self, Claims};
use crate::error::{AppError, Result};
use crate::permissions::{self, TenantContext};
use crate::sso::{self, SsoProvider};

// ─── 公开端点 ───

/// 列出当前租户可用的 SSO Provider（公开，无需认证）
#[derive(Deserialize)]
pub struct ProvidersQuery {
    pub tenant_id: Option<i32>,
}

#[derive(Serialize)]
pub struct PublicProvider {
    pub provider_type: String,
    pub display_name: String,
    pub authorize_url: String,
}

/// GET /auth/sso/providers?tenant_id=1
pub async fn list_public_providers(
    State(pool): State<PgPool>,
    Query(q): Query<ProvidersQuery>,
) -> Result<Json<Vec<PublicProvider>>> {
    let tenant_id = q.tenant_id.unwrap_or(1);

    let rows = sqlx::query(
        r#"
        SELECT id, provider_type, display_name
        FROM management.sso_providers
        WHERE tenant_id = $1 AND is_active = true
        ORDER BY display_name
        "#,
    )
    .bind(tenant_id)
    .fetch_all(&pool)
    .await?;

    let providers = rows
        .iter()
        .map(|r| {
            let pt: String = r.get("provider_type");
            PublicProvider {
                provider_type: pt.clone(),
                display_name: r.get("display_name"),
                authorize_url: format!("/auth/sso/{}/authorize?tenant_id={}", pt, tenant_id),
            }
        })
        .collect();

    Ok(Json(providers))
}

/// GET /auth/sso/:provider/authorize?tenant_id=1&redirect_url=...
/// 发起 SSO 授权流程
#[derive(Deserialize)]
pub struct AuthorizeQuery {
    pub tenant_id: Option<i32>,
    pub redirect_url: Option<String>,
}

pub async fn sso_authorize(
    State(pool): State<PgPool>,
    Path(provider_type): Path<String>,
    Query(q): Query<AuthorizeQuery>,
) -> Result<Json<Value>> {
    let tenant_id = q.tenant_id.unwrap_or(1);
    let redirect_url = q.redirect_url.clone().unwrap_or_else(|| {
        std::env::var("SSO_REDIRECT_BASE_URL")
            .unwrap_or_else(|_| "http://localhost:3001".to_string())
    });

    let provider = load_provider(&pool, tenant_id, &provider_type).await?;

    // 生成 state token 防 CSRF
    let state_token = uuid::Uuid::new_v4().to_string();

    let callback_url = format!(
        "{}/auth/sso/{}/callback",
        std::env::var("API_BASE_URL").unwrap_or_else(|_| "http://localhost:3000".to_string()),
        provider_type
    );

    // 存储 state
    sqlx::query(
        r#"
        INSERT INTO management.sso_states (state_token, provider_id, redirect_url, tenant_id)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(&state_token)
    .bind(provider.id)
    .bind(&redirect_url)
    .bind(tenant_id)
    .execute(&pool)
    .await?;

    let auth_url = sso::build_authorization_url(&provider, &callback_url, &state_token);

    Ok(Json(json!({
        "authorization_url": auth_url,
        "state": state_token
    })))
}

/// GET /auth/sso/:provider/callback?code=...&state=...
/// OAuth2 回调端点
#[derive(Deserialize)]
pub struct CallbackQuery {
    pub code: String,
    pub state: String,
}

pub async fn sso_callback(
    State(pool): State<PgPool>,
    Path(provider_type): Path<String>,
    Query(q): Query<CallbackQuery>,
) -> Result<Json<Value>> {
    // 验证 state
    let state_row = sqlx::query(
        r#"
        SELECT s.provider_id, s.redirect_url, s.tenant_id, s.expires_at
        FROM management.sso_states s
        WHERE s.state_token = $1
        "#,
    )
    .bind(&q.state)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::Unauthorized("无效的 SSO state".to_string()))?;

    let expires_at: chrono::DateTime<chrono::Utc> = state_row.get("expires_at");
    if expires_at < chrono::Utc::now() {
        return Err(AppError::Unauthorized("SSO state 已过期".to_string()));
    }

    let provider_id: i32 = state_row.get("provider_id");
    let redirect_url: Option<String> = state_row.get("redirect_url");
    let tenant_id: i32 = state_row.get("tenant_id");

    // 删除已使用的 state
    let _ = sqlx::query("DELETE FROM management.sso_states WHERE state_token = $1")
        .bind(&q.state)
        .execute(&pool)
        .await;

    // 加载 provider 配置
    let provider = load_provider_by_id(&pool, provider_id).await?;

    let callback_url = format!(
        "{}/auth/sso/{}/callback",
        std::env::var("API_BASE_URL").unwrap_or_else(|_| "http://localhost:3000".to_string()),
        provider_type
    );

    // 用授权码换 token
    let token_response = sso::exchange_code_for_token(&provider, &q.code, &callback_url)
        .await
        .map_err(|e| AppError::Internal(e))?;

    // 获取用户信息
    let profile = sso::fetch_user_profile(&provider, &token_response.access_token)
        .await
        .map_err(|e| AppError::Internal(e))?;

    let (external_id, email, name, avatar) = sso::extract_profile_fields(&provider, &profile);

    // 查找或创建本地用户
    let (user_id, is_new_user) = find_or_create_user(
        &pool, tenant_id, &email, &name, &external_id, provider_id,
    )
    .await?;

    // 更新 SSO 用户关联
    let encrypted_access_token = base64_encode(&token_response.access_token);
    let encrypted_refresh_token = token_response.refresh_token.as_deref().map(base64_encode);

    sqlx::query(
        r#"
        INSERT INTO management.sso_user_links
            (user_id, provider_id, external_user_id, external_email, external_name,
             external_avatar, access_token_encrypted, refresh_token_encrypted, raw_profile, last_login_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        ON CONFLICT (provider_id, external_user_id) DO UPDATE
        SET external_email = EXCLUDED.external_email,
            external_name = EXCLUDED.external_name,
            external_avatar = EXCLUDED.external_avatar,
            access_token_encrypted = EXCLUDED.access_token_encrypted,
            refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
            raw_profile = EXCLUDED.raw_profile,
            last_login_at = NOW()
        "#,
    )
    .bind(user_id)
    .bind(provider_id)
    .bind(&external_id)
    .bind(&email)
    .bind(&name)
    .bind(&avatar)
    .bind(&encrypted_access_token)
    .bind(&encrypted_refresh_token)
    .bind(&profile)
    .execute(&pool)
    .await?;

    // 获取用户 email、role、is_superadmin 用于生成 JWT
    let user_row = sqlx::query(
        "SELECT email, role, COALESCE(is_superadmin, false) AS is_superadmin FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_one(&pool)
    .await?;

    let user_email: String = user_row.get("email");
    let user_role: String = user_row.get("role");
    let user_is_superadmin: bool = user_row.get("is_superadmin");

    let (jwt, jti) = auth::generate_token(user_id, &user_email, &user_role, user_is_superadmin)?;

    // 登记会话（SSO 没有显式 IP/UA，写空即可）
    let expires_at = chrono::Utc::now() + chrono::Duration::seconds(auth::jwt_expiration_secs());
    sqlx::query(
        "INSERT INTO user_sessions (jti, user_id, expires_at, user_agent, ip) VALUES ($1::uuid, $2, $3, $4, NULL)",
    )
    .bind(&jti)
    .bind(user_id)
    .bind(expires_at)
    .bind::<Option<&str>>(Some("sso"))
    .execute(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("登记 SSO 会话失败: {}", e)))?;

    let login_redirect = redirect_url.unwrap_or_else(|| "http://localhost:3001/dashboard".to_string());

    Ok(Json(json!({
        "token": jwt,
        "user": {
            "id": user_id,
            "email": user_email,
            "role": user_role,
            "name": name,
            "avatar": avatar,
            "is_new_user": is_new_user
        },
        "redirect_url": format!("{}?token={}", login_redirect, jwt),
        "provider": provider_type
    })))
}

// ─── 管理端点（需认证） ───

/// GET /api/sso/providers — 管理员列出 SSO Provider
///
/// 鉴权：调用方必须是该租户的 owner/admin（`TenantContext` 已强制要求用户
/// 属于该租户）+ 显式 require_tenant_admin。普通成员看不到 SSO 配置。
pub async fn admin_list_providers(
    Extension(claims): Extension<Claims>,
    TenantContext(tenant_id): TenantContext,
    State(pool): State<PgPool>,
) -> Result<Json<Vec<Value>>> {
    permissions::require_tenant_admin(&pool, &claims, tenant_id).await?;

    let rows = sqlx::query(
        r#"
        SELECT id, tenant_id, provider_type, display_name, client_id,
               authorization_url, token_url, userinfo_url, scopes,
               user_id_field, email_field, name_field, avatar_field,
               is_active, created_at::TEXT, updated_at::TEXT,
               (SELECT COUNT(*) FROM management.sso_user_links l WHERE l.provider_id = p.id) AS linked_users
        FROM management.sso_providers p
        WHERE p.tenant_id = $1
        ORDER BY p.display_name
        "#,
    )
    .bind(tenant_id)
    .fetch_all(&pool)
    .await?;

    let providers: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<i32, _>("id"),
                "tenant_id": r.get::<i32, _>("tenant_id"),
                "provider_type": r.get::<String, _>("provider_type"),
                "display_name": r.get::<String, _>("display_name"),
                "client_id": r.get::<String, _>("client_id"),
                "authorization_url": r.get::<Option<String>, _>("authorization_url"),
                "token_url": r.get::<Option<String>, _>("token_url"),
                "userinfo_url": r.get::<Option<String>, _>("userinfo_url"),
                "scopes": r.get::<Option<String>, _>("scopes"),
                "is_active": r.get::<bool, _>("is_active"),
                "linked_users": r.get::<i64, _>("linked_users"),
                "created_at": r.get::<String, _>("created_at"),
                "updated_at": r.get::<String, _>("updated_at"),
            })
        })
        .collect();

    Ok(Json(providers))
}

/// 创建 Provider 请求
#[derive(Deserialize)]
pub struct CreateProviderRequest {
    pub provider_type: String,
    pub display_name: String,
    pub client_id: String,
    pub client_secret: String,
    pub authorization_url: Option<String>,
    pub token_url: Option<String>,
    pub userinfo_url: Option<String>,
    pub scopes: Option<String>,
}

/// POST /api/sso/providers
pub async fn admin_create_provider(
    Extension(claims): Extension<Claims>,
    TenantContext(tenant_id): TenantContext,
    State(pool): State<PgPool>,
    Json(req): Json<CreateProviderRequest>,
) -> Result<Json<Value>> {
    permissions::require_tenant_admin(&pool, &claims, tenant_id).await?;

    let valid_types = ["google", "facebook", "github", "oidc"];
    if !valid_types.contains(&req.provider_type.as_str()) {
        return Err(AppError::InvalidQuery(format!(
            "无效的 provider_type: {}，允许值: {:?}",
            req.provider_type, valid_types
        )));
    }

    let encrypted_secret = base64_encode(&req.client_secret);

    let row = sqlx::query(
        r#"
        INSERT INTO management.sso_providers
            (tenant_id, provider_type, display_name, client_id, client_secret_encrypted,
             authorization_url, token_url, userinfo_url, scopes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, created_at::TEXT
        "#,
    )
    .bind(tenant_id)
    .bind(&req.provider_type)
    .bind(&req.display_name)
    .bind(&req.client_id)
    .bind(&encrypted_secret)
    .bind(&req.authorization_url)
    .bind(&req.token_url)
    .bind(&req.userinfo_url)
    .bind(&req.scopes)
    .fetch_one(&pool)
    .await
    .map_err(|e| AppError::InvalidQuery(format!("创建 SSO Provider 失败: {}", e)))?;

    Ok(Json(json!({
        "success": true,
        "id": row.get::<i32, _>("id"),
        "message": format!("{} SSO Provider 创建成功", req.display_name)
    })))
}

/// 更新 Provider 请求
#[derive(Deserialize)]
pub struct UpdateProviderRequest {
    pub display_name: Option<String>,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub authorization_url: Option<String>,
    pub token_url: Option<String>,
    pub userinfo_url: Option<String>,
    pub scopes: Option<String>,
    pub is_active: Option<bool>,
}

/// PATCH /api/sso/providers/:id
pub async fn admin_update_provider(
    Extension(claims): Extension<Claims>,
    TenantContext(tenant_id): TenantContext,
    State(pool): State<PgPool>,
    Path(provider_id): Path<i32>,
    Json(req): Json<UpdateProviderRequest>,
) -> Result<Json<Value>> {
    permissions::require_tenant_admin(&pool, &claims, tenant_id).await?;

    let encrypted_secret = req.client_secret.as_deref().map(base64_encode);

    sqlx::query(
        r#"
        UPDATE management.sso_providers
        SET display_name = COALESCE($1, display_name),
            client_id = COALESCE($2, client_id),
            client_secret_encrypted = COALESCE($3, client_secret_encrypted),
            authorization_url = COALESCE($4, authorization_url),
            token_url = COALESCE($5, token_url),
            userinfo_url = COALESCE($6, userinfo_url),
            scopes = COALESCE($7, scopes),
            is_active = COALESCE($8, is_active)
        WHERE id = $9 AND tenant_id = $10
        "#,
    )
    .bind(&req.display_name)
    .bind(&req.client_id)
    .bind(&encrypted_secret)
    .bind(&req.authorization_url)
    .bind(&req.token_url)
    .bind(&req.userinfo_url)
    .bind(&req.scopes)
    .bind(&req.is_active)
    .bind(provider_id)
    .bind(tenant_id)
    .execute(&pool)
    .await?;

    Ok(Json(json!({
        "success": true,
        "message": "SSO Provider 已更新"
    })))
}

/// DELETE /api/sso/providers/:id
pub async fn admin_delete_provider(
    Extension(claims): Extension<Claims>,
    TenantContext(tenant_id): TenantContext,
    State(pool): State<PgPool>,
    Path(provider_id): Path<i32>,
) -> Result<Json<Value>> {
    permissions::require_tenant_admin(&pool, &claims, tenant_id).await?;

    let result = sqlx::query(
        "DELETE FROM management.sso_providers WHERE id = $1 AND tenant_id = $2 RETURNING display_name",
    )
    .bind(provider_id)
    .bind(tenant_id)
    .fetch_optional(&pool)
    .await?;

    match result {
        Some(row) => {
            let name: String = row.get("display_name");
            Ok(Json(json!({
                "success": true,
                "message": format!("SSO Provider '{}' 已删除", name)
            })))
        }
        None => Err(AppError::NotFound("SSO Provider 不存在".to_string())),
    }
}

// ─── 辅助函数 ───
//
// 旧的 `resolve_tenant_id` 已删除，所有调用点改用 `permissions::TenantContext`
// 提取器：调用方通过 `X-Tenant-Id` 请求头/查询串显式指定要操作的租户，
// 超管可指定任意租户，普通用户必须是该租户的 active 成员。

async fn load_provider(pool: &PgPool, tenant_id: i32, provider_type: &str) -> Result<SsoProvider> {
    let row = sqlx::query(
        r#"
        SELECT id, tenant_id, provider_type, display_name, client_id,
               client_secret_encrypted, authorization_url, token_url,
               userinfo_url, scopes, user_id_field, email_field,
               name_field, avatar_field, is_active
        FROM management.sso_providers
        WHERE tenant_id = $1 AND provider_type = $2 AND is_active = true
        "#,
    )
    .bind(tenant_id)
    .bind(provider_type)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| {
        AppError::NotFound(format!("SSO Provider '{}' 未配置或已禁用", provider_type))
    })?;

    Ok(row_to_provider(&row))
}

async fn load_provider_by_id(pool: &PgPool, provider_id: i32) -> Result<SsoProvider> {
    let row = sqlx::query(
        r#"
        SELECT id, tenant_id, provider_type, display_name, client_id,
               client_secret_encrypted, authorization_url, token_url,
               userinfo_url, scopes, user_id_field, email_field,
               name_field, avatar_field, is_active
        FROM management.sso_providers
        WHERE id = $1
        "#,
    )
    .bind(provider_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("SSO Provider 不存在".to_string()))?;

    Ok(row_to_provider(&row))
}

fn row_to_provider(row: &sqlx::postgres::PgRow) -> SsoProvider {
    SsoProvider {
        id: row.get("id"),
        tenant_id: row.get("tenant_id"),
        provider_type: row.get("provider_type"),
        display_name: row.get("display_name"),
        client_id: row.get("client_id"),
        client_secret_encrypted: row.get("client_secret_encrypted"),
        authorization_url: row.get("authorization_url"),
        token_url: row.get("token_url"),
        userinfo_url: row.get("userinfo_url"),
        scopes: row.get("scopes"),
        user_id_field: row.get("user_id_field"),
        email_field: row.get("email_field"),
        name_field: row.get("name_field"),
        avatar_field: row.get("avatar_field"),
        is_active: row.get("is_active"),
    }
}

/// 查找或创建本地用户
async fn find_or_create_user(
    pool: &PgPool,
    tenant_id: i32,
    email: &Option<String>,
    name: &Option<String>,
    external_id: &str,
    provider_id: i32,
) -> Result<(i32, bool)> {
    // 先通过 SSO link 查找已关联的用户
    let existing_link = sqlx::query(
        "SELECT user_id FROM management.sso_user_links WHERE provider_id = $1 AND external_user_id = $2",
    )
    .bind(provider_id)
    .bind(external_id)
    .fetch_optional(pool)
    .await?;

    if let Some(row) = existing_link {
        return Ok((row.get("user_id"), false));
    }

    // 如果有 email，尝试通过 email 找到已有用户
    if let Some(ref email) = email {
        let existing_user = sqlx::query("SELECT id FROM users WHERE email = $1")
            .bind(email)
            .fetch_optional(pool)
            .await?;

        if let Some(row) = existing_user {
            return Ok((row.get("id"), false));
        }
    }

    // 创建新用户
    let user_email = email
        .clone()
        .unwrap_or_else(|| format!("{}@{}", external_id, crate::brand::sso_email_domain()));
    let display_name = name.clone().unwrap_or_else(|| "SSO User".to_string());
    let random_password = uuid::Uuid::new_v4().to_string();
    let password_hash = auth::hash_password(&random_password)?;

    let user_row = sqlx::query(
        r#"
        INSERT INTO users (username, email, password_hash, role)
        VALUES ($1, $2, $3, 'user')
        RETURNING id
        "#,
    )
    .bind(&display_name)
    .bind(&user_email)
    .bind(&password_hash)
    .fetch_one(pool)
    .await
    .map_err(|e| AppError::Internal(format!("创建 SSO 用户失败: {}", e)))?;

    let user_id: i32 = user_row.get("id");

    // 关联用户到租户。默认 role = 'member'（与 user_tenants 的列 default 一致）。
    let _ = sqlx::query(
        r#"
        INSERT INTO management.user_tenants (user_id, tenant_id, is_active)
        VALUES ($1, $2, true)
        ON CONFLICT (user_id, tenant_id) DO NOTHING
        "#,
    )
    .bind(user_id)
    .bind(tenant_id)
    .execute(pool)
    .await;

    // SSO 第一次登录的用户：按 'member' → RBAC `editor` 同步默认权限，
    // 否则用户登进来看 dashboard 是一片空白，体验很差。
    // 这里不带 RedisManager（SSO 路径没注入），缓存失效会在下次 RBAC 写操作时统一冲掉。
    if let Err(e) =
        crate::permissions::sync_default_rbac_role(pool, None, user_id, tenant_id, "member").await
    {
        tracing::warn!(
            "SSO 用户 {} 同步默认 RBAC 角色失败 (tenant={}): {} —— 不阻断登录流程",
            user_id,
            tenant_id,
            e
        );
    }

    tracing::info!("SSO 创建新用户: id={}, email={}", user_id, user_email);

    Ok((user_id, true))
}

fn base64_encode(input: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(input.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_base64_encode_decode() {
        let secret = "my-super-secret-client-id";
        let encoded = base64_encode(secret);
        assert!(!encoded.is_empty());

        use base64::Engine;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&encoded)
            .unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), secret);
    }
}
