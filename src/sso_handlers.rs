//! SSO / OAuth2 API 端点
//!
//! - GET  /auth/sso/providers              — 列出当前租户可用的 SSO Provider
//! - GET  /auth/sso/:provider/authorize    — 发起 SSO 登录（返回授权 URL，含 PKCE）
//! - POST /auth/sso/exchange               — 前端回调页回传 code+state，换 token 并签发 JWT
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
    /// 该 Provider 所属项目（tenant）。登录页需带它发起 authorize，
    /// 这样回调后用户被授予的就是这个项目的权限。
    pub tenant_id: i32,
    pub tenant_name: String,
}

/// GET /auth/sso/providers[?tenant_id=1]
///
/// - 不带 `tenant_id`：每种 `provider_type` 只返回**一个**登录入口（DISTINCT ON），
///   登录页只渲染一个「Mind 登录」按钮。登录后进入哪个项目由用户自身权限决定
///   （回调落地 `/workspace` 的 picker 按成员关系分发），不在登录入口层面区分项目。
///   前提：同一种 SSO 建议只在一个项目下配置;若多项目都配了同种 SSO，这里取
///   tenant_id 最小（最早创建）的那个作为统一入口。
/// - 带 `tenant_id`：仅列出该项目的 Provider（用于按项目定向的登录入口）。
pub async fn list_public_providers(
    State(pool): State<PgPool>,
    Query(q): Query<ProvidersQuery>,
) -> Result<Json<Vec<PublicProvider>>> {
    let rows = if let Some(tenant_id) = q.tenant_id {
        sqlx::query(
            r#"
            SELECT p.tenant_id, p.provider_type, p.display_name, t.name AS tenant_name
            FROM management.sso_providers p
            JOIN management.tenants t ON t.id = p.tenant_id
            WHERE p.tenant_id = $1 AND p.is_active = true
            ORDER BY p.display_name
            "#,
        )
        .bind(tenant_id)
        .fetch_all(&pool)
        .await?
    } else {
        sqlx::query(
            r#"
            SELECT DISTINCT ON (p.provider_type)
                   p.tenant_id, p.provider_type, p.display_name, t.name AS tenant_name
            FROM management.sso_providers p
            JOIN management.tenants t ON t.id = p.tenant_id
            WHERE p.is_active = true
            ORDER BY p.provider_type, p.tenant_id
            "#,
        )
        .fetch_all(&pool)
        .await?
    };

    let providers = rows
        .iter()
        .map(|r| {
            let pt: String = r.get("provider_type");
            let tid: i32 = r.get("tenant_id");
            PublicProvider {
                provider_type: pt.clone(),
                display_name: r.get("display_name"),
                authorize_url: format!("/auth/sso/{}/authorize?tenant_id={}", pt, tid),
                tenant_id: tid,
                tenant_name: r.get("tenant_name"),
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

    // 「前端业务接入」：OAuth redirect_uri 指向**前端回调页**（/sso/callback），
    // 由前端拿到 code+state 后回 POST /auth/sso/exchange 完成换取。redirect_uri 在
    // authorize 与 token 换取两处必须完全一致，所以这里把它存进 sso_states。
    let redirect_uri = q.redirect_url.clone().unwrap_or_else(|| {
        format!(
            "{}/sso/callback",
            std::env::var("SSO_REDIRECT_BASE_URL")
                .unwrap_or_else(|_| "http://localhost:3001".to_string())
        )
    });

    let provider = load_provider(&pool, tenant_id, &provider_type).await?;

    // 生成 state token 防 CSRF
    let state_token = uuid::Uuid::new_v4().to_string();

    // PKCE：仅对要求它的 provider（Mind）生成；verifier 存服务端，前端无感知。
    let (code_verifier, code_challenge) = if sso::provider_requires_pkce(&provider_type) {
        let (v, c) = sso::generate_pkce();
        (Some(v), Some(c))
    } else {
        (None, None)
    };

    sqlx::query(
        r#"
        INSERT INTO management.sso_states
            (state_token, provider_id, redirect_url, tenant_id, code_verifier, oauth_redirect_uri)
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(&state_token)
    .bind(provider.id)
    .bind(&redirect_uri)
    .bind(tenant_id)
    .bind(&code_verifier)
    .bind(&redirect_uri)
    .execute(&pool)
    .await?;

    let auth_url = sso::build_authorization_url(
        &provider,
        &redirect_uri,
        &state_token,
        code_challenge.as_deref(),
    );

    tracing::info!(
        target: "sso",
        provider_type = %provider_type,
        tenant_id,
        state = %state_token,
        code_challenge = code_challenge.as_deref().unwrap_or("<none>"),
        auth_url = %auth_url,
        "SSO authorize 生成授权 URL"
    );

    Ok(Json(json!({
        "authorization_url": auth_url,
        "state": state_token
    })))
}

/// POST /auth/sso/exchange  body: { code, state }
///
/// 「前端业务接入」第 4~6 步：前端 `/sso/callback` 页面拿到第三方回调的 `code`+`state`
/// 后回传到这里。后端按 `state` 取回 PKCE `code_verifier` 与 authorize 时用的
/// `redirect_uri`，用 `code` 换 token、拉 userinfo、找/建用户并签发 JWT，
/// 以 **JSON** 返回 `{ token }`（不是 302——前端是 fetch 调用，自行完成跳转）。
#[derive(Deserialize)]
pub struct ExchangeBody {
    pub code: String,
    pub state: String,
}

pub async fn sso_exchange(
    State(pool): State<PgPool>,
    Json(body): Json<ExchangeBody>,
) -> Result<Json<Value>> {
    // 验证 state
    let state_row = sqlx::query(
        r#"
        SELECT provider_id, tenant_id, code_verifier, oauth_redirect_uri, redirect_url, expires_at
        FROM management.sso_states
        WHERE state_token = $1
        "#,
    )
    .bind(&body.state)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::Unauthorized("无效的 SSO state".to_string()))?;

    let expires_at: chrono::DateTime<chrono::Utc> = state_row.get("expires_at");
    if expires_at < chrono::Utc::now() {
        return Err(AppError::Unauthorized("SSO state 已过期".to_string()));
    }

    let provider_id: i32 = state_row.get("provider_id");
    let tenant_id: i32 = state_row.get("tenant_id");
    let code_verifier: Option<String> = state_row.get("code_verifier");
    // token 换取时 redirect_uri 必须与 authorize 时一致；优先用专门记录的列。
    let oauth_redirect_uri: Option<String> = state_row.get("oauth_redirect_uri");
    let legacy_redirect: Option<String> = state_row.get("redirect_url");
    let redirect_uri = oauth_redirect_uri.or(legacy_redirect).unwrap_or_default();

    // 删除已使用的 state（一次性）
    let _ = sqlx::query("DELETE FROM management.sso_states WHERE state_token = $1")
        .bind(&body.state)
        .execute(&pool)
        .await;

    let provider = load_provider_by_id(&pool, provider_id).await?;

    tracing::info!(
        target: "sso",
        provider_type = %provider.provider_type,
        state = %body.state,
        redirect_uri = %redirect_uri,
        code_verifier = code_verifier.as_deref().unwrap_or("<none>"),
        derived_challenge = %code_verifier
            .as_deref()
            .map(sso::pkce_challenge_s256)
            .unwrap_or_else(|| "<none>".to_string()),
        "SSO exchange 用 code 换 token"
    );

    let token_response = sso::exchange_code_for_token(
        &provider,
        &body.code,
        &redirect_uri,
        code_verifier.as_deref(),
    )
    .await
    .map_err(AppError::Internal)?;

    let (jwt, is_new_user, user) =
        finish_sso_login(&pool, &provider, tenant_id, &token_response).await?;

    tracing::info!(
        target: "sso",
        provider = %provider.provider_type,
        tenant_id,
        is_new_user,
        "SSO exchange 成功，返回 JWT"
    );

    Ok(Json(json!({
        "token": jwt,
        "is_new_user": is_new_user,
        "user": user,
    })))
}

/// 拿到 token 之后的统一收尾逻辑：
/// 拉 userinfo → 找/建本地用户并对齐角色 → upsert sso_user_links → 签发 JWT 并登记会话。
/// 返回 `(jwt, is_new_user, user)`，其中 `user` 是与密码登录一致的用户对象 JSON，
/// 供前端 `setCurrentUser` 直接落地（否则登录后头像/用户名显示为空）。
async fn finish_sso_login(
    pool: &PgPool,
    provider: &SsoProvider,
    tenant_id: i32,
    token_response: &sso::OAuthTokenResponse,
) -> Result<(String, bool, serde_json::Value)> {
    let profile = sso::fetch_user_profile(provider, &token_response.access_token)
        .await
        .map_err(AppError::Internal)?;

    let (external_id, email, name, avatar) = sso::extract_profile_fields(provider, &profile);

    let (user_id, is_new_user) = find_or_create_user(
        pool,
        tenant_id,
        &email,
        &name,
        &external_id,
        provider.id,
        &provider.auto_role,
    )
    .await?;

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
    .bind(provider.id)
    .bind(&external_id)
    .bind(&email)
    .bind(&name)
    .bind(&avatar)
    .bind(&encrypted_access_token)
    .bind(&encrypted_refresh_token)
    .bind(&profile)
    .execute(pool)
    .await?;

    let user_row = sqlx::query(
        "SELECT username, email, role, COALESCE(is_superadmin, false) AS is_superadmin, \
                COALESCE(is_active, true) AS is_active, created_at \
         FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;

    let user_username: String = user_row.get("username");
    let user_email: String = user_row.get("email");
    let user_role: String = user_row.get("role");
    let user_is_superadmin: bool = user_row.get("is_superadmin");
    let user_is_active: bool = user_row.get("is_active");
    let user_created_at: chrono::NaiveDateTime = user_row.get("created_at");

    crate::auth_handlers::require_active_user(user_is_active)?;

    let user_json = json!({
        "id": user_id,
        "username": user_username,
        "email": user_email,
        "role": user_role,
        "is_superadmin": user_is_superadmin,
        "created_at": crate::models::naive_to_utc_string(user_created_at),
    });

    let (jwt, jti) = auth::generate_token(user_id, &user_email, &user_role, user_is_superadmin)?;

    // 登记会话（SSO 没有显式 IP/UA，写空即可）
    let session_expires =
        chrono::Utc::now() + chrono::Duration::seconds(auth::jwt_expiration_secs());
    sqlx::query(
        "INSERT INTO user_sessions (jti, user_id, expires_at, user_agent, ip) VALUES ($1::uuid, $2, $3, $4, NULL)",
    )
    .bind(&jti)
    .bind(user_id)
    .bind(session_expires)
    .bind::<Option<&str>>(Some("sso"))
    .execute(pool)
    .await
    .map_err(|e| AppError::Internal(format!("登记 SSO 会话失败: {}", e)))?;

    Ok((jwt, is_new_user, user_json))
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
               auto_role, is_active, created_at::TEXT, updated_at::TEXT,
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
                "user_id_field": r.get::<String, _>("user_id_field"),
                "email_field": r.get::<String, _>("email_field"),
                "name_field": r.get::<String, _>("name_field"),
                "avatar_field": r.get::<String, _>("avatar_field"),
                "auto_role": r.get::<String, _>("auto_role"),
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
    // userinfo 响应字段映射。不传则用 DB 默认（sub/email/name/picture）。
    // Mind 等非标准 IdP 的 claim 名（如头像可能叫 icon）可在此覆盖，无需改代码。
    pub user_id_field: Option<String>,
    pub email_field: Option<String>,
    pub name_field: Option<String>,
    pub avatar_field: Option<String>,
    /// 适用范围/角色：通过该 Provider 登录的用户在本项目自动获得的角色。
    /// owner/admin/member/viewer，不传默认 member。
    pub auto_role: Option<String>,
}

/// 校验 auto_role 取值（与 user_tenants.role + DB CHECK 对齐）。
fn validate_auto_role(role: &str) -> Result<()> {
    const VALID: [&str; 4] = ["owner", "admin", "member", "viewer"];
    if VALID.contains(&role) {
        Ok(())
    } else {
        Err(AppError::InvalidQuery(format!(
            "无效的 auto_role: {}，允许值: {:?}",
            role, VALID
        )))
    }
}

/// POST /api/sso/providers
pub async fn admin_create_provider(
    Extension(claims): Extension<Claims>,
    TenantContext(tenant_id): TenantContext,
    State(pool): State<PgPool>,
    Json(req): Json<CreateProviderRequest>,
) -> Result<Json<Value>> {
    permissions::require_tenant_admin(&pool, &claims, tenant_id).await?;

    let valid_types = ["google", "facebook", "github", "oidc", "mind"];
    if !valid_types.contains(&req.provider_type.as_str()) {
        return Err(AppError::InvalidQuery(format!(
            "无效的 provider_type: {}，允许值: {:?}",
            req.provider_type, valid_types
        )));
    }

    if let Some(ref role) = req.auto_role {
        validate_auto_role(role)?;
    }

    let encrypted_secret = base64_encode(&req.client_secret);

    // 字段映射用 COALESCE 兜底到默认值：这些列非空（row_to_provider 按 String 读取），
    // 显式 INSERT NULL 会让后续 fetch_one::<String> panic，故不能直接 bind None。
    let row = sqlx::query(
        r#"
        INSERT INTO management.sso_providers
            (tenant_id, provider_type, display_name, client_id, client_secret_encrypted,
             authorization_url, token_url, userinfo_url, scopes,
             user_id_field, email_field, name_field, avatar_field, auto_role)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                COALESCE($10, 'sub'), COALESCE($11, 'email'),
                COALESCE($12, 'name'), COALESCE($13, 'picture'), COALESCE($14, 'member'))
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
    .bind(&req.user_id_field)
    .bind(&req.email_field)
    .bind(&req.name_field)
    .bind(&req.avatar_field)
    .bind(&req.auto_role)
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
    pub user_id_field: Option<String>,
    pub email_field: Option<String>,
    pub name_field: Option<String>,
    pub avatar_field: Option<String>,
    pub auto_role: Option<String>,
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

    if let Some(ref role) = req.auto_role {
        validate_auto_role(role)?;
    }

    let encrypted_secret = req.client_secret.as_deref().map(base64_encode);

    let result = sqlx::query(
        r#"
        UPDATE management.sso_providers
        SET display_name = COALESCE($1, display_name),
            client_id = COALESCE($2, client_id),
            client_secret_encrypted = COALESCE($3, client_secret_encrypted),
            authorization_url = COALESCE($4, authorization_url),
            token_url = COALESCE($5, token_url),
            userinfo_url = COALESCE($6, userinfo_url),
            scopes = COALESCE($7, scopes),
            is_active = COALESCE($8, is_active),
            user_id_field = COALESCE($9, user_id_field),
            email_field = COALESCE($10, email_field),
            name_field = COALESCE($11, name_field),
            avatar_field = COALESCE($12, avatar_field),
            auto_role = COALESCE($13, auto_role)
        WHERE id = $14 AND tenant_id = $15
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
    .bind(&req.user_id_field)
    .bind(&req.email_field)
    .bind(&req.name_field)
    .bind(&req.avatar_field)
    .bind(&req.auto_role)
    .bind(provider_id)
    .bind(tenant_id)
    .execute(&pool)
    .await?;

    // WHERE 同时按 tenant_id 过滤：跨租户的 id 命中 0 行而非误改他人数据。
    // 但 0 行说明该 provider 不属于当前租户（或不存在），要明确报 404，
    // 不能继续返回 success（否则掩盖越权探测、且让前端误以为改成功）。
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!(
            "SSO Provider {} 不存在或不属于当前租户",
            provider_id
        )));
    }

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
               name_field, avatar_field, is_active, auto_role
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
               name_field, avatar_field, is_active, auto_role
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
        auto_role: row.get("auto_role"),
    }
}

/// 查找或创建本地用户，并对齐其在该 Provider 所属 tenant 的角色。
///
/// `auto_role` 来自 Provider 配置（适用范围/角色）：通过本 SSO 登录的用户在该项目
/// 自动获得的角色（owner/admin/member/viewer）。SSO 是该项目访问权限的"真源"，
/// 因此**每次登录**都把 `user_tenants.role` 与默认 RBAC 角色对齐到 `auto_role`，
/// 新老用户一致——这样"用 Mind SSO 登录即拥有该项目某角色"的语义稳定成立。
async fn find_or_create_user(
    pool: &PgPool,
    tenant_id: i32,
    email: &Option<String>,
    name: &Option<String>,
    external_id: &str,
    provider_id: i32,
    auto_role: &str,
) -> Result<(i32, bool)> {
    // 解析出 user_id（新建 or 已存在）。matched_via_link 表示是通过 SSO 关联
    // 命中的（确定是本 Provider 管理的账号），仅这种情况下我们才会用 SSO 的
    // name 覆盖本地 username——避免误改“恰好同邮箱的本地密码账号”的用户名。
    let (user_id, is_new_user, matched_via_link) = {
        // 先通过 SSO link 查找已关联的用户
        let existing_link = sqlx::query(
            "SELECT user_id FROM management.sso_user_links WHERE provider_id = $1 AND external_user_id = $2",
        )
        .bind(provider_id)
        .bind(external_id)
        .fetch_optional(pool)
        .await?;

        if let Some(row) = existing_link {
            (row.get::<i32, _>("user_id"), false, true)
        } else if let Some(row) = match email {
            // 如果有 email，尝试通过 email 找到已有用户
            Some(email) => {
                sqlx::query("SELECT id FROM users WHERE email = $1")
                    .bind(email)
                    .fetch_optional(pool)
                    .await?
            }
            None => None,
        } {
            (row.get::<i32, _>("id"), false, false)
        } else {
            // 创建新用户
            let user_email = email
                .clone()
                .unwrap_or_else(|| format!("{}@sso.onebase", external_id));
            // username 有唯一约束：SSO 显示名可能重名，必须挑一个不冲突的。
            let desired_name = name.clone().unwrap_or_else(|| "SSO User".to_string());
            let display_name = ensure_unique_username(pool, &desired_name, None).await?;
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

            let new_id: i32 = user_row.get("id");
            tracing::info!("SSO 创建新用户: id={}, email={}", new_id, user_email);
            (new_id, true, false)
        }
    };

    // 老用户（且确实是 SSO 关联账号）：用 SSO 最新的 name 刷新展示用户名。
    // 这样早先在 userinfo 还没打通时被建成 "SSO User" 的账号，下次登录会被纠正。
    // username 唯一，冲突时退而加后缀；任何失败都不阻断登录。
    if !is_new_user && matched_via_link {
        if let Some(raw_name) = name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            match ensure_unique_username(pool, raw_name, Some(user_id)).await {
                Ok(unique) => {
                    if let Err(e) = sqlx::query("UPDATE users SET username = $1 WHERE id = $2")
                        .bind(&unique)
                        .bind(user_id)
                        .execute(pool)
                        .await
                    {
                        tracing::warn!(
                            "SSO 刷新用户名失败 (user_id={}): {} —— 不阻断登录",
                            user_id,
                            e
                        );
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        "SSO 计算唯一用户名失败 (user_id={}): {} —— 不阻断登录",
                        user_id,
                        e
                    );
                }
            }
        }
    }

    // 不论新老用户：把其在该 Provider 所属 tenant 的成员角色对齐到 auto_role。
    // ON CONFLICT DO UPDATE 故意覆盖现有 role——SSO 是该项目权限的真源，
    // 避免出现"管理员手动降级后下次登录又被 SSO 提权"以外的歧义（这是预期行为）。
    sqlx::query(
        r#"
        INSERT INTO management.user_tenants (user_id, tenant_id, role, is_active)
        VALUES ($1, $2, $3, true)
        ON CONFLICT (user_id, tenant_id)
        DO UPDATE SET role = EXCLUDED.role, is_active = true
        "#,
    )
    .bind(user_id)
    .bind(tenant_id)
    .bind(auto_role)
    .execute(pool)
    .await
    .map_err(|e| AppError::Internal(format!("关联 SSO 用户到项目失败: {}", e)))?;

    // 同步默认 RBAC 角色（auto_role → admin/editor/viewer 见 permissions 映射），
    // 否则用户登进来在数据接口上 0 权限。SSO 路径没注入 RedisManager，
    // 缓存失效会在下次 RBAC 写操作时统一冲掉，这里失败也不阻断登录。
    if let Err(e) =
        crate::permissions::sync_default_rbac_role(pool, None, user_id, tenant_id, auto_role).await
    {
        tracing::warn!(
            "SSO 用户 {} 同步默认 RBAC 角色失败 (tenant={}, role={}): {} —— 不阻断登录流程",
            user_id,
            tenant_id,
            auto_role,
            e
        );
    }

    Ok((user_id, is_new_user))
}

/// 为 SSO 用户挑一个**不冲突**的 username（`users.username` 有唯一约束）。
/// 优先用 `desired`；被别人占用时退而加数字后缀（`name_1`、`name_2`…）。
/// `exclude_id` 是“这个名字若属于该用户自己则视为可用”（刷新场景下不算冲突）。
async fn ensure_unique_username(
    pool: &PgPool,
    desired: &str,
    exclude_id: Option<i32>,
) -> Result<String> {
    let base = {
        let t = desired.trim();
        if t.is_empty() {
            "SSO User".to_string()
        } else {
            t.chars().take(100).collect::<String>()
        }
    };

    for suffix in 0..1000 {
        let candidate = if suffix == 0 {
            base.clone()
        } else {
            format!("{}_{}", base, suffix)
        };
        let taken: Option<(i32,)> = sqlx::query_as("SELECT id FROM users WHERE username = $1")
            .bind(&candidate)
            .fetch_optional(pool)
            .await?;
        match taken {
            None => return Ok(candidate),
            Some((id,)) if Some(id) == exclude_id => return Ok(candidate),
            Some(_) => continue,
        }
    }

    // 极端兜底：用随机后缀保证唯一。
    Ok(format!("{}_{}", base, uuid::Uuid::new_v4().simple()))
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

    #[test]
    fn sso_login_requires_active_user_before_token_generation() {
        let source = include_str!("sso_handlers.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        let active_check = source
            .find("auth_handlers::require_active_user(user_is_active)?;")
            .expect("SSO login must reject inactive users");
        let token_generation = source
            .find("auth::generate_token(user_id")
            .expect("SSO login token generation missing");
        assert!(
            active_check < token_generation,
            "SSO active-user check must happen before token generation"
        );
    }
}
