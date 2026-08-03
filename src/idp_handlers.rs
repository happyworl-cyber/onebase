//! IdP / OIDC 基础管理接口（slice 1）
//!
//! 当前阶段先打通三件事：
//! - 项目级 Provider 凭证库
//! - OAuth2 Client 注册与 Provider 开关
//! - 公开 `GET /api/providers?client_id=...`，供前端动态渲染登录按钮
//!
//! 说明：
//! - 设计文档里的“项目”在当前代码里落在 `management.tenants`
//! - 这里只实现配置面与 provider list，授权码 / token / JWKS 后续再接

use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use rand::Rng;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};

use crate::auth::Claims;
use crate::crypto;
use crate::error::{AppError, Result};
use crate::permissions;

const VALID_PROVIDER_TYPES: &[&str] = &[
    "google",
    "apple",
    "facebook",
    "github",
    "oidc",
    "mind",
];
const DEFAULT_ALLOWED_SCOPES: &[&str] = &["openid", "email", "profile"];
const CLIENT_ID_PREFIX: &str = "cr_live_";
const CLIENT_SECRET_PREFIX: &str = "crs_live_";
const MAX_REDIRECT_URIS: usize = 20;
const MAX_SCOPE_COUNT: usize = 20;

#[derive(Deserialize)]
pub struct PublicProvidersQuery {
    pub client_id: String,
}

#[derive(Deserialize)]
pub struct UpsertProjectProviderRequest {
    pub provider_type: String,
    pub display_name: Option<String>,
    pub client_id: String,
    pub client_secret: String,
    pub is_enabled: Option<bool>,
    pub provider_config: Option<Value>,
}

#[derive(Deserialize)]
pub struct PatchProjectProviderRequest {
    pub display_name: Option<String>,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub is_enabled: Option<bool>,
    pub provider_config: Option<Value>,
}

#[derive(Deserialize)]
pub struct CreateOauth2ClientRequest {
    pub display_name: String,
    pub redirect_uris: Vec<String>,
    pub allowed_scopes: Option<Vec<String>>,
    pub access_token_ttl: Option<i32>,
    pub refresh_token_ttl: Option<i32>,
    pub require_pkce: Option<bool>,
    pub is_active: Option<bool>,
}

#[derive(Deserialize)]
pub struct UpdateOauth2ClientRequest {
    pub display_name: Option<String>,
    pub redirect_uris: Option<Vec<String>>,
    pub allowed_scopes: Option<Vec<String>>,
    pub access_token_ttl: Option<i32>,
    pub refresh_token_ttl: Option<i32>,
    pub require_pkce: Option<bool>,
    pub is_active: Option<bool>,
}

#[derive(Deserialize)]
pub struct ReplaceClientProvidersRequest {
    pub providers: Vec<ClientProviderToggle>,
}

#[derive(Deserialize)]
pub struct ClientProviderToggle {
    pub provider_type: String,
    pub is_enabled: bool,
}

#[derive(Deserialize)]
pub struct IdpSessionDeleteQuery {
    pub family_id: String,
}

#[derive(Deserialize)]
pub struct IdpLoginLogQuery {
    pub provider: Option<String>,
    pub client_id: Option<String>,
    pub q: Option<String>,
    pub limit: Option<i64>,
}

fn provider_default_label(provider_type: &str) -> String {
    match provider_type {
        "google" => "使用 Google 登录".to_string(),
        "apple" => "使用 Apple 登录".to_string(),
        "facebook" => "使用 Facebook 登录".to_string(),
        "github" => "使用 GitHub 登录".to_string(),
        "mind" => "使用 Mind 登录".to_string(),
        _ => format!("使用 {} 登录", provider_type),
    }
}

fn validate_provider_type(provider_type: &str) -> Result<()> {
    if VALID_PROVIDER_TYPES.contains(&provider_type) {
        Ok(())
    } else {
        Err(AppError::InvalidQuery(format!(
            "不支持的 provider_type: {}",
            provider_type
        )))
    }
}

fn normalize_provider_config(provider_config: Option<Value>) -> Result<Option<Value>> {
    match provider_config {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(map)) => Ok(Some(Value::Object(map))),
        Some(_) => Err(AppError::InvalidQuery(
            "provider_config 必须是 JSON object".to_string(),
        )),
    }
}

fn validate_redirect_uris(redirect_uris: &[String]) -> Result<()> {
    if redirect_uris.is_empty() {
        return Err(AppError::InvalidQuery(
            "redirect_uris 至少需要一个回调地址".to_string(),
        ));
    }
    if redirect_uris.len() > MAX_REDIRECT_URIS {
        return Err(AppError::InvalidQuery(format!(
            "redirect_uris 数量不能超过 {}",
            MAX_REDIRECT_URIS
        )));
    }
    for uri in redirect_uris {
        let trimmed = uri.trim();
        if trimmed.is_empty() {
            return Err(AppError::InvalidQuery(
                "redirect_uri 不能为空字符串".to_string(),
            ));
        }
        reqwest::Url::parse(trimmed).map_err(|_| {
            AppError::InvalidQuery(format!("redirect_uri 不是合法 URL: {}", trimmed))
        })?;
    }
    Ok(())
}

fn normalize_allowed_scopes(scopes: Option<Vec<String>>) -> Result<Vec<String>> {
    let scopes = scopes.unwrap_or_else(|| {
        DEFAULT_ALLOWED_SCOPES
            .iter()
            .map(|s| (*s).to_string())
            .collect()
    });
    if scopes.is_empty() {
        return Err(AppError::InvalidQuery(
            "allowed_scopes 不能为空".to_string(),
        ));
    }
    if scopes.len() > MAX_SCOPE_COUNT {
        return Err(AppError::InvalidQuery(format!(
            "allowed_scopes 数量不能超过 {}",
            MAX_SCOPE_COUNT
        )));
    }
    for scope in &scopes {
        let trimmed = scope.trim();
        if trimmed.is_empty() {
            return Err(AppError::InvalidQuery("scope 不能为空".to_string()));
        }
        if !trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == ':' || c == '-' || c == '.')
        {
            return Err(AppError::InvalidQuery(format!(
                "scope 含非法字符: {}",
                trimmed
            )));
        }
    }
    Ok(scopes.into_iter().map(|s| s.trim().to_string()).collect())
}

fn validate_client_ttls(access_token_ttl: i32, refresh_token_ttl: i32) -> Result<()> {
    if !(60..=86_400).contains(&access_token_ttl) {
        return Err(AppError::InvalidQuery(
            "access_token_ttl 必须在 60 到 86400 秒之间".to_string(),
        ));
    }
    if !(300..=31_536_000).contains(&refresh_token_ttl) {
        return Err(AppError::InvalidQuery(
            "refresh_token_ttl 必须在 300 到 31536000 秒之间".to_string(),
        ));
    }
    Ok(())
}

fn generate_oauth2_client_id() -> String {
    let mut rng = rand::thread_rng();
    let random_bytes: Vec<u8> = (0..12).map(|_| rng.gen()).collect();
    format!("{}{}", CLIENT_ID_PREFIX, hex::encode(random_bytes))
}

fn generate_oauth2_client_secret() -> String {
    let mut rng = rand::thread_rng();
    let random_bytes: Vec<u8> = (0..24).map(|_| rng.gen()).collect();
    format!("{}{}", CLIENT_SECRET_PREFIX, hex::encode(random_bytes))
}

fn hash_client_secret(raw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    hex::encode(hasher.finalize())
}

async fn assert_project_admin(pool: &PgPool, claims: &Claims, project_id: i32) -> Result<()> {
    permissions::require_tenant_admin(pool, claims, project_id).await
}

async fn assert_client_belongs_to_project(
    pool: &PgPool,
    project_id: i32,
    client_id: &str,
) -> Result<()> {
    let exists: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM management.oauth2_clients
            WHERE tenant_id = $1 AND client_id = $2
        )
        "#,
    )
    .bind(project_id)
    .bind(client_id)
    .fetch_one(pool)
    .await?;
    if !exists {
        return Err(AppError::NotFound(format!(
            "项目 {} 下不存在 OAuth2 Client {}",
            project_id, client_id
        )));
    }
    Ok(())
}

/// GET /api/providers?client_id=...
pub async fn list_available_providers(
    State(pool): State<PgPool>,
    Query(q): Query<PublicProvidersQuery>,
) -> Result<Json<Value>> {
    let rows = sqlx::query(
        r#"
        SELECT p.provider_type,
               COALESCE(NULLIF(p.display_name, ''), p.provider_type) AS label
        FROM management.oauth2_clients c
        JOIN management.oauth2_client_providers cp
             ON cp.client_id = c.client_id
            AND cp.is_enabled = true
        JOIN management.project_idp_providers p
             ON p.tenant_id = c.tenant_id
            AND p.provider_type = cp.provider_type
        WHERE c.client_id = $1
          AND c.is_active = true
          AND p.is_enabled = true
          AND p.client_id IS NOT NULL
          AND p.client_secret_enc IS NOT NULL
        ORDER BY p.provider_type ASC
        "#,
    )
    .bind(&q.client_id)
    .fetch_all(&pool)
    .await?;

    let providers: Vec<Value> = rows
        .iter()
        .map(|row| {
            let provider_type: String = row.get("provider_type");
            let configured_label: String = row.get("label");
            json!({
                "provider": provider_type,
                "label": if configured_label == row.get::<String, _>("provider_type") {
                    provider_default_label(&configured_label)
                } else {
                    configured_label
                },
                "icon": row.get::<String, _>("provider_type"),
            })
        })
        .collect();

    Ok(Json(json!({ "providers": providers })))
}

/// GET /api/projects/:id/idp/providers
pub async fn list_project_idp_providers(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
) -> Result<Json<Vec<Value>>> {
    assert_project_admin(&pool, &claims, project_id).await?;

    let rows = sqlx::query(
        r#"
        SELECT p.id,
               p.provider_type,
               p.display_name,
               p.client_id,
               p.provider_config,
               p.is_enabled,
               p.created_at,
               p.updated_at,
               COALESCE((
                   SELECT COUNT(*)
                   FROM management.oauth2_client_providers cp
                   JOIN management.oauth2_clients c ON c.client_id = cp.client_id
                   WHERE c.tenant_id = p.tenant_id
                     AND cp.provider_type = p.provider_type
                     AND cp.is_enabled = true
               ), 0) AS enabled_client_count
        FROM management.project_idp_providers p
        WHERE p.tenant_id = $1
        ORDER BY p.provider_type ASC
        "#,
    )
    .bind(project_id)
    .fetch_all(&pool)
    .await?;

    let items = rows
        .iter()
        .map(|row| {
            let provider_type: String = row.get("provider_type");
            json!({
                "id": row.get::<i32, _>("id"),
                "provider_type": provider_type,
                "display_name": row.get::<Option<String>, _>("display_name")
                    .unwrap_or_else(|| provider_default_label(row.get::<String, _>("provider_type").as_str())),
                "client_id": row.get::<String, _>("client_id"),
                "provider_config": row.get::<Option<serde_json::Value>, _>("provider_config"),
                "has_client_secret": true,
                "is_enabled": row.get::<bool, _>("is_enabled"),
                "enabled_client_count": row.get::<i64, _>("enabled_client_count"),
                "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
                "updated_at": row.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
            })
        })
        .collect();

    Ok(Json(items))
}

/// POST /api/projects/:id/idp/providers
pub async fn create_project_idp_provider(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
    Json(req): Json<UpsertProjectProviderRequest>,
) -> Result<Json<Value>> {
    assert_project_admin(&pool, &claims, project_id).await?;
    validate_provider_type(&req.provider_type)?;

    let client_id = req.client_id.trim();
    if client_id.is_empty() {
        return Err(AppError::InvalidQuery("client_id 不能为空".to_string()));
    }
    let client_secret = req.client_secret.trim();
    if client_secret.is_empty() {
        return Err(AppError::InvalidQuery("client_secret 不能为空".to_string()));
    }

    let encrypted_secret = crypto::encrypt_secret(client_secret)?;
    let provider_config = normalize_provider_config(req.provider_config)?;
    let display_name = req
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let row = sqlx::query(
        r#"
        INSERT INTO management.project_idp_providers
            (tenant_id, provider_type, display_name, client_id, client_secret_enc, provider_config, is_enabled)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, provider_type, display_name, client_id, provider_config, is_enabled, created_at, updated_at
        "#,
    )
    .bind(project_id)
    .bind(&req.provider_type)
    .bind(display_name.as_deref())
    .bind(client_id)
    .bind(&encrypted_secret)
    .bind(provider_config.as_ref())
    .bind(req.is_enabled.unwrap_or(true))
    .fetch_one(&pool)
    .await?;

    let provider_type: String = row.get("provider_type");
    Ok(Json(json!({
        "id": row.get::<i32, _>("id"),
        "provider_type": provider_type,
        "display_name": row.get::<Option<String>, _>("display_name")
            .unwrap_or_else(|| provider_default_label(&req.provider_type)),
        "client_id": row.get::<String, _>("client_id"),
        "provider_config": row.get::<Option<serde_json::Value>, _>("provider_config"),
        "has_client_secret": true,
        "is_enabled": row.get::<bool, _>("is_enabled"),
        "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
        "updated_at": row.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
    })))
}

/// PATCH /api/projects/:id/idp/providers/:provider_type
pub async fn update_project_idp_provider(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, provider_type)): Path<(i32, String)>,
    Json(req): Json<PatchProjectProviderRequest>,
) -> Result<Json<Value>> {
    assert_project_admin(&pool, &claims, project_id).await?;
    validate_provider_type(&provider_type)?;

    if let Some(client_id) = &req.client_id {
        if client_id.trim().is_empty() {
            return Err(AppError::InvalidQuery("client_id 不能为空".to_string()));
        }
    }
    if let Some(client_secret) = &req.client_secret {
        if client_secret.trim().is_empty() {
            return Err(AppError::InvalidQuery("client_secret 不能为空".to_string()));
        }
    }

    let encrypted_secret = match req.client_secret.as_deref() {
        Some(secret) => Some(crypto::encrypt_secret(secret.trim())?),
        None => None,
    };
    let provider_config = normalize_provider_config(req.provider_config)?;

    let row = sqlx::query(
        r#"
        UPDATE management.project_idp_providers
        SET display_name = COALESCE($1, display_name),
            client_id = COALESCE($2, client_id),
            client_secret_enc = COALESCE($3, client_secret_enc),
            provider_config = COALESCE($4, provider_config),
            is_enabled = COALESCE($5, is_enabled)
        WHERE tenant_id = $6 AND provider_type = $7
        RETURNING id, provider_type, display_name, client_id, provider_config, is_enabled, created_at, updated_at
        "#,
    )
    .bind(req.display_name.as_deref().map(str::trim))
    .bind(req.client_id.as_deref().map(str::trim))
    .bind(encrypted_secret.as_deref())
    .bind(provider_config.as_ref())
    .bind(req.is_enabled)
    .bind(project_id)
    .bind(&provider_type)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("项目 {} 未配置 provider {}", project_id, provider_type)))?;

    Ok(Json(json!({
        "id": row.get::<i32, _>("id"),
        "provider_type": row.get::<String, _>("provider_type"),
        "display_name": row.get::<Option<String>, _>("display_name")
            .unwrap_or_else(|| provider_default_label(&provider_type)),
        "client_id": row.get::<String, _>("client_id"),
        "provider_config": row.get::<Option<serde_json::Value>, _>("provider_config"),
        "has_client_secret": true,
        "is_enabled": row.get::<bool, _>("is_enabled"),
        "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
        "updated_at": row.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
    })))
}

/// GET /api/projects/:id/idp/clients
pub async fn list_oauth2_clients(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
) -> Result<Json<Vec<Value>>> {
    assert_project_admin(&pool, &claims, project_id).await?;

    let rows = sqlx::query(
        r#"
        SELECT c.id, c.client_id, c.display_name, c.redirect_uris, c.allowed_scopes,
               c.access_token_ttl, c.refresh_token_ttl, c.require_pkce, c.is_active, c.created_at,
               COALESCE((
                   SELECT jsonb_agg(
                       jsonb_build_object(
                           'provider_type', cp.provider_type,
                           'is_enabled', cp.is_enabled
                       )
                       ORDER BY cp.provider_type
                   )
                   FROM management.oauth2_client_providers cp
                   WHERE cp.client_id = c.client_id
               ), '[]'::jsonb) AS providers
        FROM management.oauth2_clients c
        WHERE c.tenant_id = $1
        ORDER BY c.created_at DESC
        "#,
    )
    .bind(project_id)
    .fetch_all(&pool)
    .await?;

    let items = rows
        .iter()
        .map(|row| {
            json!({
                "id": row.get::<i32, _>("id"),
                "client_id": row.get::<String, _>("client_id"),
                "display_name": row.get::<String, _>("display_name"),
                "redirect_uris": row.get::<Vec<String>, _>("redirect_uris"),
                "allowed_scopes": row.get::<Vec<String>, _>("allowed_scopes"),
                "access_token_ttl": row.get::<i32, _>("access_token_ttl"),
                "refresh_token_ttl": row.get::<i32, _>("refresh_token_ttl"),
                "require_pkce": row.get::<bool, _>("require_pkce"),
                "is_active": row.get::<bool, _>("is_active"),
                "providers": row.get::<serde_json::Value, _>("providers"),
                "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            })
        })
        .collect();

    Ok(Json(items))
}

/// POST /api/projects/:id/idp/clients
pub async fn create_oauth2_client(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
    Json(req): Json<CreateOauth2ClientRequest>,
) -> Result<Json<Value>> {
    assert_project_admin(&pool, &claims, project_id).await?;

    let display_name = req.display_name.trim();
    if display_name.is_empty() {
        return Err(AppError::InvalidQuery(
            "display_name 不能为空".to_string(),
        ));
    }
    validate_redirect_uris(&req.redirect_uris)?;
    let allowed_scopes = normalize_allowed_scopes(req.allowed_scopes)?;
    let access_token_ttl = req.access_token_ttl.unwrap_or(900);
    let refresh_token_ttl = req.refresh_token_ttl.unwrap_or(2_592_000);
    validate_client_ttls(access_token_ttl, refresh_token_ttl)?;

    let client_id = generate_oauth2_client_id();
    let client_secret = generate_oauth2_client_secret();
    let client_secret_hash = hash_client_secret(&client_secret);

    let row = sqlx::query(
        r#"
        INSERT INTO management.oauth2_clients
            (tenant_id, client_id, client_secret_hash, display_name, redirect_uris,
             allowed_scopes, access_token_ttl, refresh_token_ttl, require_pkce, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, client_id, display_name, redirect_uris, allowed_scopes,
                  access_token_ttl, refresh_token_ttl, require_pkce, is_active, created_at
        "#,
    )
    .bind(project_id)
    .bind(&client_id)
    .bind(&client_secret_hash)
    .bind(display_name)
    .bind(req.redirect_uris.iter().map(|s| s.trim().to_string()).collect::<Vec<_>>())
    .bind(&allowed_scopes)
    .bind(access_token_ttl)
    .bind(refresh_token_ttl)
    .bind(req.require_pkce.unwrap_or(true))
    .bind(req.is_active.unwrap_or(true))
    .fetch_one(&pool)
    .await?;

    Ok(Json(json!({
        "client_id": client_id,
        "client_secret": client_secret,
        "client": {
            "id": row.get::<i32, _>("id"),
            "client_id": row.get::<String, _>("client_id"),
            "display_name": row.get::<String, _>("display_name"),
            "redirect_uris": row.get::<Vec<String>, _>("redirect_uris"),
            "allowed_scopes": row.get::<Vec<String>, _>("allowed_scopes"),
            "access_token_ttl": row.get::<i32, _>("access_token_ttl"),
            "refresh_token_ttl": row.get::<i32, _>("refresh_token_ttl"),
            "require_pkce": row.get::<bool, _>("require_pkce"),
            "is_active": row.get::<bool, _>("is_active"),
            "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
        }
    })))
}

/// PATCH /api/projects/:id/idp/clients/:client_id
pub async fn update_oauth2_client(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, client_id)): Path<(i32, String)>,
    Json(req): Json<UpdateOauth2ClientRequest>,
) -> Result<Json<Value>> {
    assert_project_admin(&pool, &claims, project_id).await?;
    assert_client_belongs_to_project(&pool, project_id, &client_id).await?;

    if let Some(display_name) = &req.display_name {
        if display_name.trim().is_empty() {
            return Err(AppError::InvalidQuery(
                "display_name 不能为空".to_string(),
            ));
        }
    }
    if let Some(redirect_uris) = &req.redirect_uris {
        validate_redirect_uris(redirect_uris)?;
    }

    let allowed_scopes = if req.allowed_scopes.is_some() {
        Some(normalize_allowed_scopes(req.allowed_scopes.clone())?)
    } else {
        None
    };

    let current_ttls = if req.access_token_ttl.is_some() || req.refresh_token_ttl.is_some() {
        let row = sqlx::query(
            "SELECT access_token_ttl, refresh_token_ttl FROM management.oauth2_clients WHERE tenant_id = $1 AND client_id = $2",
        )
        .bind(project_id)
        .bind(&client_id)
        .fetch_one(&pool)
        .await?;
        let access_token_ttl = req
            .access_token_ttl
            .unwrap_or_else(|| row.get::<i32, _>("access_token_ttl"));
        let refresh_token_ttl = req
            .refresh_token_ttl
            .unwrap_or_else(|| row.get::<i32, _>("refresh_token_ttl"));
        validate_client_ttls(access_token_ttl, refresh_token_ttl)?;
        Some((access_token_ttl, refresh_token_ttl))
    } else {
        None
    };

    let row = sqlx::query(
        r#"
        UPDATE management.oauth2_clients
        SET display_name = COALESCE($1, display_name),
            redirect_uris = COALESCE($2, redirect_uris),
            allowed_scopes = COALESCE($3, allowed_scopes),
            access_token_ttl = COALESCE($4, access_token_ttl),
            refresh_token_ttl = COALESCE($5, refresh_token_ttl),
            require_pkce = COALESCE($6, require_pkce),
            is_active = COALESCE($7, is_active)
        WHERE tenant_id = $8 AND client_id = $9
        RETURNING id, client_id, display_name, redirect_uris, allowed_scopes,
                  access_token_ttl, refresh_token_ttl, require_pkce, is_active, created_at
        "#,
    )
    .bind(req.display_name.as_deref().map(str::trim))
    .bind(
        req.redirect_uris
            .as_ref()
            .map(|uris| uris.iter().map(|s| s.trim().to_string()).collect::<Vec<_>>()),
    )
    .bind(allowed_scopes.as_ref())
    .bind(current_ttls.map(|(access, _)| access))
    .bind(current_ttls.map(|(_, refresh)| refresh))
    .bind(req.require_pkce)
    .bind(req.is_active)
    .bind(project_id)
    .bind(&client_id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| {
        AppError::NotFound(format!(
            "项目 {} 下不存在 OAuth2 Client {}",
            project_id, client_id
        ))
    })?;

    Ok(Json(json!({
        "id": row.get::<i32, _>("id"),
        "client_id": row.get::<String, _>("client_id"),
        "display_name": row.get::<String, _>("display_name"),
        "redirect_uris": row.get::<Vec<String>, _>("redirect_uris"),
        "allowed_scopes": row.get::<Vec<String>, _>("allowed_scopes"),
        "access_token_ttl": row.get::<i32, _>("access_token_ttl"),
        "refresh_token_ttl": row.get::<i32, _>("refresh_token_ttl"),
        "require_pkce": row.get::<bool, _>("require_pkce"),
        "is_active": row.get::<bool, _>("is_active"),
        "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
    })))
}

/// POST /api/projects/:id/idp/clients/:client_id/rotate-secret
pub async fn rotate_oauth2_client_secret(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, client_id)): Path<(i32, String)>,
) -> Result<Json<Value>> {
    assert_project_admin(&pool, &claims, project_id).await?;
    assert_client_belongs_to_project(&pool, project_id, &client_id).await?;

    let new_secret = generate_oauth2_client_secret();
    let secret_hash = hash_client_secret(&new_secret);

    let affected = sqlx::query(
        r#"
        UPDATE management.oauth2_clients
        SET client_secret_hash = $1
        WHERE tenant_id = $2 AND client_id = $3
        "#,
    )
    .bind(&secret_hash)
    .bind(project_id)
    .bind(&client_id)
    .execute(&pool)
    .await?
    .rows_affected();

    if affected == 0 {
        return Err(AppError::NotFound(format!(
            "项目 {} 下不存在 OAuth2 Client {}",
            project_id, client_id
        )));
    }

    Ok(Json(json!({
        "client_id": client_id,
        "client_secret": new_secret,
    })))
}

/// GET /api/projects/:id/idp/clients/:client_id/providers
pub async fn get_oauth2_client_providers(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, client_id)): Path<(i32, String)>,
) -> Result<Json<Value>> {
    assert_project_admin(&pool, &claims, project_id).await?;
    assert_client_belongs_to_project(&pool, project_id, &client_id).await?;

    let rows = sqlx::query(
        r#"
        SELECT p.provider_type,
               p.is_enabled AS project_enabled,
               p.display_name,
               cp.is_enabled AS client_enabled
        FROM management.project_idp_providers p
        LEFT JOIN management.oauth2_client_providers cp
               ON cp.client_id = $2
              AND cp.provider_type = p.provider_type
        WHERE p.tenant_id = $1
        ORDER BY p.provider_type ASC
        "#,
    )
    .bind(project_id)
    .bind(&client_id)
    .fetch_all(&pool)
    .await?;

    let providers: Vec<Value> = rows
        .iter()
        .map(|row| {
            let provider_type: String = row.get("provider_type");
            json!({
                "provider_type": provider_type,
                "display_name": row.get::<Option<String>, _>("display_name")
                    .unwrap_or_else(|| provider_default_label(row.get::<String, _>("provider_type").as_str())),
                "project_enabled": row.get::<bool, _>("project_enabled"),
                "client_enabled": row.get::<Option<bool>, _>("client_enabled").unwrap_or(false),
            })
        })
        .collect();

    Ok(Json(json!({
        "client_id": client_id,
        "providers": providers,
    })))
}

/// PUT /api/projects/:id/idp/clients/:client_id/providers
pub async fn replace_oauth2_client_providers(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, client_id)): Path<(i32, String)>,
    Json(req): Json<ReplaceClientProvidersRequest>,
) -> Result<Json<Value>> {
    assert_project_admin(&pool, &claims, project_id).await?;
    assert_client_belongs_to_project(&pool, project_id, &client_id).await?;

    for item in &req.providers {
        validate_provider_type(&item.provider_type)?;
    }

    let project_provider_rows = sqlx::query(
        r#"
        SELECT provider_type, is_enabled
        FROM management.project_idp_providers
        WHERE tenant_id = $1
        "#,
    )
    .bind(project_id)
    .fetch_all(&pool)
    .await?;

    let mut project_provider_state = std::collections::HashMap::new();
    for row in project_provider_rows {
        project_provider_state.insert(
            row.get::<String, _>("provider_type"),
            row.get::<bool, _>("is_enabled"),
        );
    }

    for item in &req.providers {
        let Some(project_enabled) = project_provider_state.get(&item.provider_type) else {
            return Err(AppError::InvalidQuery(format!(
                "provider {} 尚未在项目凭证库中配置",
                item.provider_type
            )));
        };
        if item.is_enabled && !project_enabled {
            return Err(AppError::InvalidQuery(format!(
                "provider {} 在项目层已禁用，不能为应用单独开启",
                item.provider_type
            )));
        }
    }

    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM management.oauth2_client_providers WHERE client_id = $1")
        .bind(&client_id)
        .execute(&mut *tx)
        .await?;

    for item in &req.providers {
        sqlx::query(
            r#"
            INSERT INTO management.oauth2_client_providers
                (client_id, provider_type, is_enabled)
            VALUES ($1, $2, $3)
            "#,
        )
        .bind(&client_id)
        .bind(&item.provider_type)
        .bind(item.is_enabled)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    Ok(Json(json!({
        "client_id": client_id,
        "providers": req.providers.iter().map(|p| {
            json!({
                "provider_type": p.provider_type,
                "is_enabled": p.is_enabled,
            })
        }).collect::<Vec<_>>(),
    })))
}

/// GET /api/projects/:id/idp/sessions
pub async fn list_idp_sessions(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
) -> Result<Json<Vec<Value>>> {
    assert_project_admin(&pool, &claims, project_id).await?;

    let rows = sqlx::query(
        r#"
        SELECT rt.family_id,
               rt.client_id,
               c.display_name AS client_display_name,
               rt.identity_id,
               i.sub,
               i.email,
               i.name,
               rt.auth_method,
               rt.created_at,
               rt.expires_at
        FROM management.oauth2_refresh_tokens rt
        JOIN management.oauth2_clients c
             ON c.client_id = rt.client_id
        JOIN management.idp_identities i
             ON i.id = rt.identity_id
        WHERE c.tenant_id = $1
          AND rt.revoked = false
          AND rt.rotated = false
          AND rt.expires_at > NOW()
        ORDER BY rt.created_at DESC
        "#,
    )
    .bind(project_id)
    .fetch_all(&pool)
    .await?;

    let sessions = rows
        .iter()
        .map(|row| {
            json!({
                "family_id": row.get::<String, _>("family_id"),
                "client_id": row.get::<String, _>("client_id"),
                "client_display_name": row.get::<String, _>("client_display_name"),
                "identity_id": row.get::<i32, _>("identity_id"),
                "sub": row.get::<String, _>("sub"),
                "email": row.get::<Option<String>, _>("email"),
                "name": row.get::<Option<String>, _>("name"),
                "auth_method": row.get::<Option<String>, _>("auth_method"),
                "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
                "expires_at": row.get::<chrono::DateTime<chrono::Utc>, _>("expires_at"),
            })
        })
        .collect();

    Ok(Json(sessions))
}

/// DELETE /api/projects/:id/idp/sessions?family_id=...
pub async fn revoke_idp_session(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
    Query(q): Query<IdpSessionDeleteQuery>,
) -> Result<Json<Value>> {
    assert_project_admin(&pool, &claims, project_id).await?;

    let affected = sqlx::query(
        r#"
        UPDATE management.oauth2_refresh_tokens rt
        SET revoked = true
        FROM management.oauth2_clients c
        WHERE rt.client_id = c.client_id
          AND c.tenant_id = $1
          AND rt.family_id = $2
          AND rt.revoked = false
        "#,
    )
    .bind(project_id)
    .bind(&q.family_id)
    .execute(&pool)
    .await?
    .rows_affected();

    if affected == 0 {
        return Err(AppError::NotFound(format!(
            "未找到可撤销的 IdP session family {}",
            q.family_id
        )));
    }

    Ok(Json(json!({
        "revoked": true,
        "family_id": q.family_id,
    })))
}

/// GET /api/projects/:id/idp/logs —— 登录日志（审计事件流）
pub async fn list_idp_login_logs(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
    Query(q): Query<IdpLoginLogQuery>,
) -> Result<Json<Vec<Value>>> {
    assert_project_admin(&pool, &claims, project_id).await?;

    let limit = q.limit.unwrap_or(200).clamp(1, 1000);
    let provider = q.provider.as_deref().filter(|s| !s.trim().is_empty());
    let client_id = q.client_id.as_deref().filter(|s| !s.trim().is_empty());
    let search = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty());

    let rows = sqlx::query(
        r#"
        SELECT l.id,
               l.created_at,
               l.event,
               l.provider,
               l.sub,
               l.email,
               l.status,
               l.error,
               l.ip,
               l.client_id,
               COALESCE(c.display_name, l.client_id) AS client_display_name
        FROM management.idp_login_logs l
        LEFT JOIN management.oauth2_clients c ON c.client_id = l.client_id
        WHERE l.tenant_id = $1
          AND ($2::text IS NULL OR l.provider = $2)
          AND ($3::text IS NULL OR l.client_id = $3)
          AND ($4::text IS NULL
               OR l.sub ILIKE '%' || $4 || '%'
               OR l.provider ILIKE '%' || $4 || '%'
               OR l.ip ILIKE '%' || $4 || '%'
               OR l.email ILIKE '%' || $4 || '%')
        ORDER BY l.created_at DESC
        LIMIT $5
        "#,
    )
    .bind(project_id)
    .bind(provider)
    .bind(client_id)
    .bind(search)
    .bind(limit)
    .fetch_all(&pool)
    .await?;

    let items = rows
        .iter()
        .map(|row| {
            json!({
                "id": row.get::<i32, _>("id"),
                "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
                "event": row.get::<String, _>("event"),
                "provider": row.get::<String, _>("provider"),
                "sub": row.get::<Option<String>, _>("sub"),
                "email": row.get::<Option<String>, _>("email"),
                "status": row.get::<String, _>("status"),
                "error": row.get::<Option<String>, _>("error"),
                "ip": row.get::<Option<String>, _>("ip"),
                "client_id": row.get::<Option<String>, _>("client_id"),
                "client_display_name": row.get::<Option<String>, _>("client_display_name"),
            })
        })
        .collect();

    Ok(Json(items))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_client_id_has_expected_prefix() {
        let client_id = generate_oauth2_client_id();
        assert!(client_id.starts_with(CLIENT_ID_PREFIX));
    }

    #[test]
    fn generated_client_secret_has_expected_prefix() {
        let secret = generate_oauth2_client_secret();
        assert!(secret.starts_with(CLIENT_SECRET_PREFIX));
    }

    #[test]
    fn client_secret_hash_is_deterministic() {
        assert_eq!(hash_client_secret("abc"), hash_client_secret("abc"));
        assert_ne!(hash_client_secret("abc"), hash_client_secret("def"));
    }
}
