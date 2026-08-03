//! OIDC / OAuth2 runtime handlers for OneBase acting as an IdP.
//!
//! This slice wires up:
//! - OIDC discovery
//! - JWKS exposure
//! - OAuth2 authorization endpoint
//! - Upstream callback bridge
//! - Token exchange
//! - Basic userinfo

use axum::{
    extract::{Form, Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Redirect, Response},
    Json,
};
use base64::Engine;
use chrono::Utc;
use jsonwebtoken::{decode, decode_header, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use rsa::{
    pkcs8::{DecodePublicKey, EncodePrivateKey, EncodePublicKey, LineEnding},
    traits::PublicKeyParts,
    RsaPrivateKey, RsaPublicKey,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};

use crate::crypto;
use crate::error::{AppError, Result};
use crate::sso;

const DEFAULT_ISSUER: &str = "http://127.0.0.1:3000";
const AUTH_CODE_TTL_SECS: i64 = 600;
const AUTH_STATE_TTL_SECS: i64 = 600;

#[derive(Debug, Clone)]
struct OauthClient {
    client_id: String,
    client_secret_hash: String,
    tenant_id: i32,
    redirect_uris: Vec<String>,
    allowed_scopes: Vec<String>,
    access_token_ttl: i32,
    refresh_token_ttl: i32,
    require_pkce: bool,
    is_active: bool,
}

#[derive(Debug, Clone)]
struct IdpProjectProvider {
    tenant_id: i32,
    provider_type: String,
    client_id: String,
    client_secret_enc: String,
    provider_config: Option<serde_json::Value>,
    authorization_url: Option<String>,
    token_url: Option<String>,
    userinfo_url: Option<String>,
    scopes: Option<String>,
    is_enabled: bool,
}

#[derive(Debug, Clone)]
struct AuthorizationState {
    tenant_id: i32,
    client_id: String,
    provider_type: String,
    redirect_uri: String,
    requested_scopes: Vec<String>,
    downstream_state: Option<String>,
    nonce: Option<String>,
    code_challenge: Option<String>,
    code_challenge_method: Option<String>,
}

#[derive(Debug, Clone)]
struct SigningKeyMaterial {
    kid: String,
    public_key_pem: String,
    private_key_pem: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct OidcTokenClaims {
    iss: String,
    sub: String,
    aud: String,
    exp: i64,
    iat: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    email_verified: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auth_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    token_use: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AuthorizeQuery {
    pub client_id: String,
    pub connection: Option<String>,
    pub redirect_uri: String,
    pub scope: Option<String>,
    pub state: Option<String>,
    pub nonce: Option<String>,
    pub response_type: Option<String>,
    pub response_mode: Option<String>,
    pub code_challenge: Option<String>,
    pub code_challenge_method: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpstreamCallbackQuery {
    pub code: Option<String>,
    pub state: String,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TokenRequest {
    pub grant_type: String,
    pub code: Option<String>,
    pub redirect_uri: Option<String>,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub code_verifier: Option<String>,
    pub refresh_token: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RevokeRequest {
    pub token: String,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct UserInfoPostBody {
    pub access_token: Option<String>,
}

/// 运维显式配置的对外 issuer（IDP_ISSUER / PUBLIC_BASE_URL）；未配置时为 None。
fn configured_issuer() -> Option<String> {
    std::env::var("IDP_ISSUER")
        .or_else(|_| std::env::var("PUBLIC_BASE_URL"))
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
}

fn issuer_base() -> String {
    configured_issuer().unwrap_or_else(|| DEFAULT_ISSUER.to_string())
}

fn request_base_from_headers(headers: &HeaderMap) -> String {
    // 显式配置的 issuer 拥有最高优先级：一旦运维设了 IDP_ISSUER/PUBLIC_BASE_URL，
    // issuer / Discovery 端点 / 上游回调地址 全部用它，避免反向代理改写 Host 导致 issuer 与
    // 用户访问域名不一致（同域反代 + 单一对外域名的标准部署）。未配置时才按请求 Host 动态推导。
    //
    // 与接口文档的「对外调用基址」共用同一套解析（`crate::public_base`），避免两处逻辑漂移；
    // 差别仅在于此处 `IDP_ISSUER` 拥有比 `PUBLIC_BASE_URL` 更高的优先级。
    if let Some(fixed) = configured_issuer() {
        return fixed;
    }
    let derived = crate::public_base::resolve_public_base(headers);
    if derived.is_empty() {
        issuer_base()
    } else {
        derived
    }
}

fn now_ts() -> i64 {
    Utc::now().timestamp()
}

fn b64url(data: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}

fn hash_secret(raw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    hex::encode(hasher.finalize())
}

fn random_hex(bytes: usize) -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let buf: Vec<u8> = (0..bytes).map(|_| rng.gen()).collect();
    hex::encode(buf)
}

fn random_code() -> String {
    format!("crac_{}", random_hex(24))
}

fn callback_uri(base: &str, provider_type: &str) -> String {
    format!("{}/oauth2/callback/{}", base.trim_end_matches('/'), provider_type)
}

fn build_redirect_with_params(base: &str, params: &[(&str, &str)]) -> Result<String> {
    let mut url = reqwest::Url::parse(base)
        .map_err(|_| AppError::InvalidQuery(format!("无效的 redirect_uri: {}", base)))?;
    {
        let mut pairs = url.query_pairs_mut();
        for (k, v) in params {
            pairs.append_pair(k, v);
        }
    }
    Ok(url.to_string())
}

fn html_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn parse_scopes(raw: Option<&str>, allowed_scopes: &[String]) -> Result<Vec<String>> {
    let scopes = if let Some(raw_scopes) = raw {
        raw_scopes
            .split_whitespace()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_string())
            .collect::<Vec<_>>()
    } else {
        allowed_scopes.to_vec()
    };

    if scopes.is_empty() {
        return Err(AppError::InvalidQuery("scope 不能为空".to_string()));
    }
    for scope in &scopes {
        if !allowed_scopes.contains(scope) {
            return Err(AppError::InvalidQuery(format!(
                "scope {} 未在该 client 的 allowed_scopes 中启用",
                scope
            )));
        }
    }
    if !scopes.iter().any(|s| s == "openid") {
        return Err(AppError::InvalidQuery(
            "OIDC 请求必须包含 openid scope".to_string(),
        ));
    }
    Ok(scopes)
}

/// 为 Sign in with Apple 动态签发 `client_secret`（ES256 JWT）。
///
/// Apple 不接受静态 client_secret，必须用开发者后台下载的 `.p8`（PKCS#8 EC P-256 私钥）
/// 配合 Team ID 与 Key ID 现签一个短时 JWT：
///   header: {alg: ES256, kid: <Key ID>}
///   claims: {iss: <Team ID>, iat, exp, aud: "https://appleid.apple.com", sub: <client_id/Services ID>}
fn apple_client_secret(
    team_id: &str,
    key_id: &str,
    private_key_pem: &str,
    client_id: &str,
) -> Result<String> {
    use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};

    #[derive(Serialize)]
    struct AppleClaims<'a> {
        iss: &'a str,
        iat: i64,
        exp: i64,
        aud: &'a str,
        sub: &'a str,
    }

    let now = now_ts();
    let claims = AppleClaims {
        iss: team_id,
        iat: now,
        exp: now + 3600,
        aud: "https://appleid.apple.com",
        sub: client_id,
    };
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some(key_id.to_string());
    let key = EncodingKey::from_ec_pem(private_key_pem.as_bytes())
        .map_err(|e| AppError::Internal(format!("Apple 私钥(.p8)解析失败: {}", e)))?;
    encode(&header, &claims, &key)
        .map_err(|e| AppError::Internal(format!("Apple client_secret 签发失败: {}", e)))
}

fn build_runtime_sso_provider(provider: &IdpProjectProvider) -> Result<sso::SsoProvider> {
    // Apple 的 client_secret 是动态 ES256 JWT，用 provider_config 里的 Team ID/Key ID/私钥现签；
    // 其余 Provider 用存储的静态 client_secret。
    let secret_b64 = if provider.provider_type == "apple" {
        // Team ID / Key ID 在 provider_config；私钥(.p8)作为加密的 client_secret 存储。
        let cfg = provider.provider_config.as_ref();
        let field = |k: &str| {
            cfg.and_then(|c| c.get(k))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
        };
        let team_id = field("team_id").ok_or_else(|| {
            AppError::InvalidQuery("Apple 缺少 Team ID（provider_config.team_id）".to_string())
        })?;
        let key_id = field("key_id").ok_or_else(|| {
            AppError::InvalidQuery("Apple 缺少 Key ID（provider_config.key_id）".to_string())
        })?;
        let private_key_pem = crypto::decrypt_secret(&provider.client_secret_enc)?;
        if private_key_pem.trim().is_empty() {
            return Err(AppError::InvalidQuery(
                "Apple 缺少私钥(.p8)——请在凭证里填写".to_string(),
            ));
        }
        let jwt = apple_client_secret(team_id, key_id, &private_key_pem, &provider.client_id)?;
        base64::engine::general_purpose::STANDARD.encode(jwt)
    } else {
        let secret_plain = crypto::decrypt_secret(&provider.client_secret_enc)?;
        base64::engine::general_purpose::STANDARD.encode(secret_plain)
    };
    let (user_id_field, email_field, name_field, avatar_field) = match provider.provider_type.as_str() {
        "github" => ("id", "email", "name", "avatar_url"),
        "mind" => ("UserID", "email", "name", "picture"),
        _ => ("sub", "email", "name", "picture"),
    };

    let configured_auth_url = provider
        .provider_config
        .as_ref()
        .and_then(|cfg| cfg.get("authorization_url"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| provider.authorization_url.clone());
    let configured_token_url = provider
        .provider_config
        .as_ref()
        .and_then(|cfg| cfg.get("token_url"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| provider.token_url.clone());
    let configured_userinfo_url = provider
        .provider_config
        .as_ref()
        .and_then(|cfg| cfg.get("userinfo_url"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| provider.userinfo_url.clone());
    let configured_scopes = provider
        .provider_config
        .as_ref()
        .and_then(|cfg| cfg.get("scopes"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| provider.scopes.clone());

    Ok(sso::SsoProvider {
        id: 0,
        tenant_id: provider.tenant_id,
        provider_type: provider.provider_type.clone(),
        display_name: provider.provider_type.clone(),
        client_id: provider.client_id.clone(),
        client_secret_encrypted: secret_b64,
        authorization_url: configured_auth_url,
        token_url: configured_token_url,
        userinfo_url: configured_userinfo_url,
        scopes: configured_scopes,
        user_id_field: user_id_field.to_string(),
        email_field: email_field.to_string(),
        name_field: name_field.to_string(),
        avatar_field: avatar_field.to_string(),
        is_active: provider.is_enabled,
        auto_role: "member".to_string(),
    })
}

async fn load_oauth_client(pool: &PgPool, client_id: &str) -> Result<OauthClient> {
    let row = sqlx::query(
        r#"
        SELECT client_id, client_secret_hash, tenant_id, redirect_uris, allowed_scopes,
               access_token_ttl, refresh_token_ttl, require_pkce, is_active
        FROM management.oauth2_clients
        WHERE client_id = $1
        "#,
    )
    .bind(client_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::Unauthorized("未知的 client_id".to_string()))?;

    Ok(OauthClient {
        client_id: row.get("client_id"),
        client_secret_hash: row.get("client_secret_hash"),
        tenant_id: row.get("tenant_id"),
        redirect_uris: row.get("redirect_uris"),
        allowed_scopes: row.get("allowed_scopes"),
        access_token_ttl: row.get("access_token_ttl"),
        refresh_token_ttl: row.get("refresh_token_ttl"),
        require_pkce: row.get("require_pkce"),
        is_active: row.get("is_active"),
    })
}

async fn authenticate_client(
    pool: &PgPool,
    client_id: &str,
    client_secret: Option<&str>,
    allow_pkce_without_secret: bool,
) -> Result<OauthClient> {
    let client = load_oauth_client(pool, client_id).await?;
    if !client.is_active {
        return Err(AppError::Unauthorized("该 OAuth2 Client 已停用".to_string()));
    }
    if let Some(secret) = client_secret {
        if hash_secret(secret) != client.client_secret_hash {
            return Err(AppError::Unauthorized("client_secret 无效".to_string()));
        }
    } else if !allow_pkce_without_secret {
        return Err(AppError::Unauthorized("缺少 client_secret".to_string()));
    }
    Ok(client)
}

async fn load_available_provider(
    pool: &PgPool,
    tenant_id: i32,
    client_id: &str,
    provider_type: &str,
) -> Result<IdpProjectProvider> {
    let row = sqlx::query(
        r#"
        SELECT p.tenant_id, p.provider_type, p.client_id, p.client_secret_enc, p.provider_config, p.is_enabled,
               sp.authorization_url, sp.token_url, sp.userinfo_url, sp.scopes
        FROM management.project_idp_providers p
        JOIN management.oauth2_client_providers cp
             ON cp.provider_type = p.provider_type
            AND cp.client_id = $2
            AND cp.is_enabled = true
        LEFT JOIN management.sso_providers sp
               ON sp.tenant_id = p.tenant_id
              AND sp.provider_type = p.provider_type
        WHERE p.tenant_id = $1
          AND p.provider_type = $3
          AND p.is_enabled = true
        "#,
    )
    .bind(tenant_id)
    .bind(client_id)
    .bind(provider_type)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::InvalidQuery(format!("provider {} 对该 client 不可用", provider_type)))?;

    Ok(IdpProjectProvider {
        tenant_id: row.get("tenant_id"),
        provider_type: row.get("provider_type"),
        client_id: row.get("client_id"),
        client_secret_enc: row.get("client_secret_enc"),
        provider_config: row.get("provider_config"),
        authorization_url: row.get("authorization_url"),
        token_url: row.get("token_url"),
        userinfo_url: row.get("userinfo_url"),
        scopes: row.get("scopes"),
        is_enabled: row.get("is_enabled"),
    })
}

async fn list_enabled_provider_types(
    pool: &PgPool,
    tenant_id: i32,
    client_id: &str,
) -> Result<Vec<String>> {
    let rows = sqlx::query(
        r#"
        SELECT p.provider_type
        FROM management.project_idp_providers p
        JOIN management.oauth2_client_providers cp
             ON cp.provider_type = p.provider_type
            AND cp.client_id = $2
            AND cp.is_enabled = true
        WHERE p.tenant_id = $1
          AND p.is_enabled = true
        ORDER BY p.provider_type ASC
        "#,
    )
    .bind(tenant_id)
    .bind(client_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| row.get::<String, _>("provider_type"))
        .collect())
}

async fn load_auth_state(pool: &PgPool, state_token: &str) -> Result<AuthorizationState> {
    let row = sqlx::query(
        r#"
        SELECT tenant_id, client_id, provider_type, redirect_uri, requested_scopes,
               downstream_state, nonce, code_challenge, code_challenge_method, expires_at
        FROM management.idp_authorization_states
        WHERE state_token = $1
        "#,
    )
    .bind(state_token)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::Unauthorized("无效的授权 state".to_string()))?;

    let expires_at: chrono::DateTime<chrono::Utc> = row.get("expires_at");
    if expires_at < Utc::now() {
        return Err(AppError::Unauthorized("授权 state 已过期".to_string()));
    }

    Ok(AuthorizationState {
        tenant_id: row.get("tenant_id"),
        client_id: row.get("client_id"),
        provider_type: row.get("provider_type"),
        redirect_uri: row.get("redirect_uri"),
        requested_scopes: row.get("requested_scopes"),
        downstream_state: row.get("downstream_state"),
        nonce: row.get("nonce"),
        code_challenge: row.get("code_challenge"),
        code_challenge_method: row.get("code_challenge_method"),
    })
}

async fn delete_auth_state(pool: &PgPool, state_token: &str) -> Result<()> {
    sqlx::query("DELETE FROM management.idp_authorization_states WHERE state_token = $1")
        .bind(state_token)
        .execute(pool)
        .await?;
    Ok(())
}

/// 从上游 userinfo/claims 判定邮箱是否已验证。
/// 兼容 OIDC 标准 `email_verified` 与 GitHub 的 `verified_email`，支持 bool 或 "true"/"1" 字符串。
/// 上游未明确标记时保守地按「未验证」处理——不作为跨 Provider 归并 key。
fn profile_email_verified(profile: &serde_json::Value) -> bool {
    let truthy = |v: &serde_json::Value| match v {
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::String(s) => {
            matches!(s.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes")
        }
        serde_json::Value::Number(n) => n.as_i64().map(|i| i != 0).unwrap_or(false),
        _ => false,
    };
    profile
        .get("email_verified")
        .or_else(|| profile.get("verified_email"))
        .map(truthy)
        .unwrap_or(false)
}

/// 返回 `(identity_id, sub, is_new)`；`is_new=true` 表示本次是首次创建身份（register）。
///
/// 身份归并有两级 key：
///   1. 主 key `(provider, provider_sub)`——同一上游账号恒定命中，`sub` 稳定，与 email 无关；
///   2. 次 key `email`——仅用于把不同 Provider 归并成同一身份。为避免未验证邮箱导致的账号接管，
///      只有当上游明确标记邮箱已验证（`email_verified`）时才用 email 做归并；否则各自独立。
async fn resolve_or_create_identity(
    pool: &PgPool,
    provider_type: &str,
    provider_sub: &str,
    email: Option<&str>,
    email_verified: bool,
    name: Option<&str>,
) -> Result<(i32, String, bool)> {
    if let Some(row) = sqlx::query(
        r#"
        SELECT i.id, i.sub
        FROM management.idp_provider_links l
        JOIN management.idp_identities i ON i.id = l.identity_id
        WHERE l.provider = $1 AND l.provider_sub = $2
        "#,
    )
    .bind(provider_type)
    .bind(provider_sub)
    .fetch_optional(pool)
    .await?
    {
        // 该 provider 账号已关联过 → 登录
        return Ok((row.get("id"), row.get("sub"), false));
    }

    // 仅在邮箱「存在且已验证」时才按 email 归并；未验证邮箱不作为归并 key，防止账号接管。
    let existing_by_email = match email {
        Some(email) if email_verified => {
            sqlx::query("SELECT id, sub FROM management.idp_identities WHERE email = $1")
                .bind(email)
                .fetch_optional(pool)
                .await?
        }
        _ => None,
    };

    // 未通过 email 命中已有身份 → 视为首次注册
    let is_new = existing_by_email.is_none();
    let (identity_id, sub) = if let Some(row) = existing_by_email {
        (row.get::<i32, _>("id"), row.get::<String, _>("sub"))
    } else {
        let sub = uuid::Uuid::new_v4().to_string();
        let row = sqlx::query(
            r#"
            INSERT INTO management.idp_identities (sub, email, name)
            VALUES ($1, $2, $3)
            RETURNING id, sub
            "#,
        )
        .bind(&sub)
        .bind(email)
        .bind(name)
        .fetch_one(pool)
        .await?;
        (row.get("id"), row.get("sub"))
    };

    sqlx::query(
        r#"
        INSERT INTO management.idp_provider_links (identity_id, provider, provider_sub)
        VALUES ($1, $2, $3)
        ON CONFLICT (provider, provider_sub) DO NOTHING
        "#,
    )
    .bind(identity_id)
    .bind(provider_type)
    .bind(provider_sub)
    .execute(pool)
    .await?;

    if email.is_some() || name.is_some() {
        sqlx::query(
            r#"
            UPDATE management.idp_identities
            SET email = COALESCE($1, email),
                name = COALESCE($2, name)
            WHERE id = $3
            "#,
        )
        .bind(email)
        .bind(name)
        .bind(identity_id)
        .execute(pool)
        .await?;
    }

    Ok((identity_id, sub, is_new))
}

/// 写一条登录日志；失败仅告警、不影响登录主流程。
#[allow(clippy::too_many_arguments)]
async fn record_login_log(
    pool: &PgPool,
    tenant_id: i32,
    client_id: &str,
    provider: &str,
    identity_id: Option<i32>,
    sub: Option<&str>,
    email: Option<&str>,
    event: &str,
    status: &str,
    error: Option<&str>,
    ip: Option<&str>,
    user_agent: Option<&str>,
) {
    if let Err(e) = sqlx::query(
        r#"
        INSERT INTO management.idp_login_logs
            (tenant_id, client_id, provider, identity_id, sub, email, event, status, error, ip, user_agent)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        "#,
    )
    .bind(tenant_id)
    .bind(client_id)
    .bind(provider)
    .bind(identity_id)
    .bind(sub)
    .bind(email)
    .bind(event)
    .bind(status)
    .bind(error)
    .bind(ip)
    .bind(user_agent)
    .execute(pool)
    .await
    {
        tracing::warn!(target: "idp", error = %e, "写入登录日志失败");
    }
}

fn client_ip_from_headers(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            headers
                .get("x-real-ip")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
                .filter(|s| !s.is_empty())
        })
}

fn user_agent_from_headers(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

async fn ensure_active_signing_key(pool: &PgPool) -> Result<SigningKeyMaterial> {
    if let Some(row) = sqlx::query(
        r#"
        SELECT kid, public_key_pem, private_key_enc
        FROM management.oauth2_signing_keys
        WHERE is_active = true
        ORDER BY created_at DESC
        LIMIT 1
        "#,
    )
    .fetch_optional(pool)
    .await?
    {
        return Ok(SigningKeyMaterial {
            kid: row.get("kid"),
            public_key_pem: row.get("public_key_pem"),
            private_key_pem: crypto::decrypt_secret(&row.get::<String, _>("private_key_enc"))?,
        });
    }

    let mut rng = rsa::rand_core::OsRng;
    let private_key =
        RsaPrivateKey::new(&mut rng, 2048).map_err(|e| AppError::Internal(format!("生成 RSA 密钥失败: {}", e)))?;
    let public_key = RsaPublicKey::from(&private_key);

    let private_key_pem = private_key
        .to_pkcs8_pem(LineEnding::LF)
        .map_err(|e| AppError::Internal(format!("导出 RSA 私钥失败: {}", e)))?
        .to_string();
    let public_key_pem = public_key
        .to_public_key_pem(LineEnding::LF)
        .map_err(|e| AppError::Internal(format!("导出 RSA 公钥失败: {}", e)))?;
    let kid = uuid::Uuid::new_v4().to_string();

    sqlx::query(
        r#"
        INSERT INTO management.oauth2_signing_keys (kid, public_key_pem, private_key_enc, is_active)
        VALUES ($1, $2, $3, true)
        "#,
    )
    .bind(&kid)
    .bind(&public_key_pem)
    .bind(crypto::encrypt_secret(&private_key_pem)?)
    .execute(pool)
    .await?;

    Ok(SigningKeyMaterial {
        kid,
        public_key_pem,
        private_key_pem,
    })
}

fn sign_token(claims: &OidcTokenClaims, signing_key: &SigningKeyMaterial) -> Result<String> {
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some(signing_key.kid.clone());
    encode(
        &header,
        claims,
        &EncodingKey::from_rsa_pem(signing_key.private_key_pem.as_bytes())
            .map_err(|e| AppError::Internal(format!("加载 RSA 私钥失败: {}", e)))?,
    )
    .map_err(|e| AppError::Internal(format!("签发 RS256 token 失败: {}", e)))
}

fn decode_rs256_claims(token: &str, signing_key: &SigningKeyMaterial) -> Result<OidcTokenClaims> {
    let mut validation = Validation::new(Algorithm::RS256);
    validation.validate_aud = false;
    let claims = decode::<OidcTokenClaims>(
        token,
        &DecodingKey::from_rsa_pem(signing_key.public_key_pem.as_bytes())
            .map_err(|e| AppError::Internal(format!("加载 RSA 公钥失败: {}", e)))?,
        &validation,
    )
    .map_err(|e| AppError::Unauthorized(format!("token 验证失败: {}", e)))?;
    Ok(claims.claims)
}

fn claims_to_userinfo(claims: &OidcTokenClaims) -> serde_json::Value {
    let mut body = json!({
        "sub": claims.sub,
    });
    if let Some(email) = &claims.email {
        body["email"] = json!(email);
        body["email_verified"] = json!(claims.email_verified.unwrap_or(true));
    }
    if let Some(name) = &claims.name {
        body["name"] = json!(name);
    }
    body
}

fn extract_bearer_or_body_token(headers: &HeaderMap, body_token: Option<&str>) -> Result<String> {
    if let Some(auth_header) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        let token = auth_header
            .strip_prefix("Bearer ")
            .ok_or_else(|| AppError::Unauthorized("Authorization 必须使用 Bearer".to_string()))?;
        return Ok(token.to_string());
    }

    if let Some(token) = body_token.filter(|s| !s.trim().is_empty()) {
        return Ok(token.to_string());
    }

    Err(AppError::Unauthorized(
        "缺少 access token（Bearer 或 body.access_token）".to_string(),
    ))
}

async fn decode_userinfo_token(pool: &PgPool, token: &str) -> Result<OidcTokenClaims> {
    let header = decode_header(token)
        .map_err(|e| AppError::Unauthorized(format!("token header 解析失败: {}", e)))?;
    let kid = header
        .kid
        .ok_or_else(|| AppError::Unauthorized("token 缺少 kid".to_string()))?;
    let row = sqlx::query(
        r#"
        SELECT kid, public_key_pem, private_key_enc
        FROM management.oauth2_signing_keys
        WHERE kid = $1 AND is_active = true
        "#,
    )
    .bind(&kid)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::Unauthorized("未知的 kid".to_string()))?;

    let signing_key = SigningKeyMaterial {
        kid: row.get("kid"),
        public_key_pem: row.get("public_key_pem"),
        private_key_pem: crypto::decrypt_secret(&row.get::<String, _>("private_key_enc"))?,
    };
    decode_rs256_claims(token, &signing_key)
}

async fn issue_refresh_token(
    pool: &PgPool,
    client_id: &str,
    identity_id: i32,
    scopes: &[String],
    family_id: &str,
    auth_method: Option<&str>,
    ttl_secs: i32,
) -> Result<String> {
    let refresh_token = format!("crrt_{}", random_hex(32));
    sqlx::query(
        r#"
        INSERT INTO management.oauth2_refresh_tokens
            (token_hash, client_id, identity_id, scopes, family_id, auth_method, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 || ' seconds')::interval)
        "#,
    )
    .bind(hash_secret(&refresh_token))
    .bind(client_id)
    .bind(identity_id)
    .bind(scopes)
    .bind(family_id)
    .bind(auth_method)
    .bind(ttl_secs.to_string())
    .execute(pool)
    .await?;
    Ok(refresh_token)
}

async fn revoke_refresh_family(pool: &PgPool, family_id: &str) -> Result<()> {
    sqlx::query(
        "UPDATE management.oauth2_refresh_tokens SET revoked = true WHERE family_id = $1 AND revoked = false",
    )
    .bind(family_id)
    .execute(pool)
    .await?;
    Ok(())
}

async fn issue_token_bundle(
    pool: &PgPool,
    signing_key: &SigningKeyMaterial,
    issuer: &str,
    client: &OauthClient,
    identity_id: i32,
    sub: String,
    email: Option<String>,
    name: Option<String>,
    scopes: Vec<String>,
    auth_method: Option<String>,
    nonce: Option<String>,
    refresh_family_id: Option<String>,
) -> Result<serde_json::Value> {
    let now = now_ts();
    let scope_str = scopes.join(" ");
    let auth_method_for_claims = auth_method.clone();
    let access_claims = OidcTokenClaims {
        iss: issuer.to_string(),
        sub: sub.clone(),
        aud: client.client_id.clone(),
        exp: now + i64::from(client.access_token_ttl),
        iat: now,
        email: email.clone(),
        email_verified: email.as_ref().map(|_| true),
        name: name.clone(),
        auth_method: auth_method_for_claims,
        scope: Some(scope_str.clone()),
        nonce: None,
        token_use: Some("access_token".to_string()),
    };
    let id_claims = OidcTokenClaims {
        iss: issuer.to_string(),
        sub,
        aud: client.client_id.clone(),
        exp: now + i64::from(client.access_token_ttl),
        iat: now,
        email: email.clone(),
        email_verified: email.as_ref().map(|_| true),
        name,
        auth_method: auth_method.clone(),
        scope: None,
        nonce,
        token_use: Some("id_token".to_string()),
    };

    let access_token = sign_token(&access_claims, signing_key)?;
    let id_token = sign_token(&id_claims, signing_key)?;
    let family_id = refresh_family_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let refresh_token = issue_refresh_token(
        pool,
        &client.client_id,
        identity_id,
        &scopes,
        &family_id,
        auth_method.as_deref(),
        client.refresh_token_ttl,
    )
    .await?;

    Ok(json!({
        "access_token": access_token,
        "id_token": id_token,
        "refresh_token": refresh_token,
        "token_type": "Bearer",
        "expires_in": client.access_token_ttl,
        "scope": scope_str,
    }))
}

pub async fn oidc_discovery(headers: HeaderMap) -> Result<Json<serde_json::Value>> {
    let issuer = request_base_from_headers(&headers);
    Ok(Json(json!({
        "issuer": issuer,
        "authorization_endpoint": format!("{}/oauth2/authorize", issuer),
        "token_endpoint": format!("{}/oauth2/token", issuer),
        "revocation_endpoint": format!("{}/oauth2/revoke", issuer),
        "userinfo_endpoint": format!("{}/oauth2/userinfo", issuer),
        "jwks_uri": format!("{}/.well-known/jwks.json", issuer),
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "subject_types_supported": ["public"],
        "id_token_signing_alg_values_supported": ["RS256"],
        "scopes_supported": ["openid", "email", "profile"],
        "token_endpoint_auth_methods_supported": ["client_secret_post", "none"],
        "claims_supported": ["sub", "email", "email_verified", "name", "auth_method"],
        "code_challenge_methods_supported": ["S256"]
    })))
}

pub async fn jwks(State(pool): State<PgPool>) -> Result<Json<serde_json::Value>> {
    let active = ensure_active_signing_key(&pool).await?;
    let public_key = RsaPublicKey::from_public_key_pem(&active.public_key_pem)
        .map_err(|e| AppError::Internal(format!("解析 RSA 公钥失败: {}", e)))?;

    Ok(Json(json!({
        "keys": [{
            "kty": "RSA",
            "use": "sig",
            "alg": "RS256",
            "kid": active.kid,
            "n": b64url(&public_key.n().to_bytes_be()),
            "e": b64url(&public_key.e().to_bytes_be()),
        }]
    })))
}

pub async fn oauth2_authorize(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Query(q): Query<AuthorizeQuery>,
) -> Result<Response> {
    let request_base = request_base_from_headers(&headers);
    if q.response_type.as_deref().unwrap_or("code") != "code" {
        return Err(AppError::InvalidQuery(
            "当前仅支持 response_type=code".to_string(),
        ));
    }

    let client = load_oauth_client(&pool, &q.client_id).await?;
    if !client.is_active {
        return Err(AppError::Unauthorized("该 OAuth2 Client 已停用".to_string()));
    }
    if !client.redirect_uris.iter().any(|uri| uri == &q.redirect_uri) {
        return Err(AppError::InvalidQuery(
            "redirect_uri 未在 client 白名单中".to_string(),
        ));
    }
    let provider_type = if let Some(connection) = q.connection.as_deref() {
        connection
    } else {
        let providers = list_enabled_provider_types(&pool, client.tenant_id, &client.client_id).await?;
        if providers.is_empty() {
            return Err(AppError::NotFound(
                "该 client 当前没有可用的登录 Provider".to_string(),
            ));
        }

        let mut html = String::from(
            "<!doctype html><html><head><meta charset=\"utf-8\"><title>Select Provider</title>\
             <style>body{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;padding:32px;max-width:560px;margin:0 auto;}\
             a{display:block;margin:12px 0;padding:12px 16px;border:1px solid #ddd;border-radius:8px;text-decoration:none;color:#111;}\
             a:hover{background:#f7f7f7;}h1{font-size:24px;}p{color:#666;}</style></head><body>\
             <h1>Choose a sign-in provider</h1><p>Select one of the configured upstream identity providers.</p>",
        );
        for provider in providers {
            let mut url = reqwest::Url::parse(&format!("{}/oauth2/authorize", request_base))
                .map_err(|e| AppError::Internal(format!("构造 provider 选择页链接失败: {}", e)))?;
            {
                let mut pairs = url.query_pairs_mut();
                pairs.append_pair("client_id", &q.client_id);
                pairs.append_pair("connection", &provider);
                pairs.append_pair("redirect_uri", &q.redirect_uri);
                if let Some(scope) = q.scope.as_deref() {
                    pairs.append_pair("scope", scope);
                }
                if let Some(state) = q.state.as_deref() {
                    pairs.append_pair("state", state);
                }
                if let Some(nonce) = q.nonce.as_deref() {
                    pairs.append_pair("nonce", nonce);
                }
                if let Some(response_mode) = q.response_mode.as_deref() {
                    pairs.append_pair("response_mode", response_mode);
                }
                if let Some(challenge) = q.code_challenge.as_deref() {
                    pairs.append_pair("code_challenge", challenge);
                }
                if let Some(method) = q.code_challenge_method.as_deref() {
                    pairs.append_pair("code_challenge_method", method);
                }
                pairs.append_pair("response_type", q.response_type.as_deref().unwrap_or("code"));
            }
            html.push_str(&format!(
                "<a href=\"{}\">Continue with {}</a>",
                html_escape(url.as_str()),
                html_escape(&provider)
            ));
        }
        html.push_str("</body></html>");
        return Ok(Html(html).into_response());
    };
    let provider = load_available_provider(&pool, client.tenant_id, &client.client_id, provider_type).await?;
    let requested_scopes = parse_scopes(q.scope.as_deref(), &client.allowed_scopes)?;

    if client.require_pkce {
        if q.code_challenge.as_deref().unwrap_or("").is_empty() {
            return Err(AppError::InvalidQuery(
                "该 client 要求 PKCE，必须提供 code_challenge".to_string(),
            ));
        }
        if q.code_challenge_method.as_deref() != Some("S256") {
            return Err(AppError::InvalidQuery(
                "当前仅支持 code_challenge_method=S256".to_string(),
            ));
        }
    }

    let internal_state = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        r#"
        INSERT INTO management.idp_authorization_states
            (state_token, tenant_id, client_id, provider_type, redirect_uri, requested_scopes,
             downstream_state, nonce, response_mode, code_challenge, code_challenge_method, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW() + ($12 || ' seconds')::interval)
        "#,
    )
    .bind(&internal_state)
    .bind(client.tenant_id)
    .bind(&client.client_id)
    .bind(provider_type)
    .bind(&q.redirect_uri)
    .bind(&requested_scopes)
    .bind(q.state.as_deref())
    .bind(q.nonce.as_deref())
    .bind(q.response_mode.as_deref())
    .bind(q.code_challenge.as_deref())
    .bind(q.code_challenge_method.as_deref())
    .bind(AUTH_STATE_TTL_SECS.to_string())
    .execute(&pool)
    .await?;

    let runtime_provider = build_runtime_sso_provider(&provider)?;
    let upstream_redirect = sso::build_authorization_url(
        &runtime_provider,
        &callback_uri(&request_base, provider_type),
        &internal_state,
        None,
    );
    Ok(Redirect::temporary(&upstream_redirect).into_response())
}

/// GET 回调（Google / GitHub / Mind 等标准 query 重定向）。
pub async fn oauth2_upstream_callback(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(provider_type): Path<String>,
    Query(q): Query<UpstreamCallbackQuery>,
) -> Result<Redirect> {
    let url = process_upstream_callback(pool, headers, provider_type, q).await?;
    Ok(Redirect::temporary(&url))
}

/// POST 回调（Apple `response_mode=form_post`）。回给下游用 303，让浏览器改用 GET。
pub async fn oauth2_upstream_callback_post(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Path(provider_type): Path<String>,
    Form(q): Form<UpstreamCallbackQuery>,
) -> Result<Redirect> {
    let url = process_upstream_callback(pool, headers, provider_type, q).await?;
    Ok(Redirect::to(&url))
}

async fn process_upstream_callback(
    pool: PgPool,
    headers: HeaderMap,
    provider_type: String,
    q: UpstreamCallbackQuery,
) -> Result<String> {
    let request_base = request_base_from_headers(&headers);
    let auth_state = load_auth_state(&pool, &q.state).await?;
    if auth_state.provider_type != provider_type {
        delete_auth_state(&pool, &q.state).await?;
        return Err(AppError::Unauthorized(
            "回调 provider 与授权阶段不一致".to_string(),
        ));
    }

    if let Some(error) = q.error.as_deref() {
        record_login_log(
            &pool,
            auth_state.tenant_id,
            &auth_state.client_id,
            &provider_type,
            None,
            None,
            None,
            "login",
            "failure",
            Some(q.error_description.as_deref().unwrap_or(error)),
            client_ip_from_headers(&headers).as_deref(),
            user_agent_from_headers(&headers).as_deref(),
        )
        .await;
        let redirect = build_redirect_with_params(
            &auth_state.redirect_uri,
            &[
                ("error", error),
                (
                    "error_description",
                    q.error_description.as_deref().unwrap_or("upstream authorization failed"),
                ),
                ("state", auth_state.downstream_state.as_deref().unwrap_or("")),
            ],
        )?;
        delete_auth_state(&pool, &q.state).await?;
        return Ok(redirect);
    }

    let code = q
        .code
        .as_deref()
        .ok_or_else(|| AppError::Unauthorized("上游回调缺少 code".to_string()))?;
    let provider =
        load_available_provider(&pool, auth_state.tenant_id, &auth_state.client_id, &provider_type).await?;
    let runtime_provider = build_runtime_sso_provider(&provider)?;
    let token_response = sso::exchange_code_for_token(
        &runtime_provider,
        code,
        &callback_uri(&request_base, &provider_type),
        None,
    )
    .await
    .map_err(AppError::Internal)?;
    // Apple 无 userinfo 端点：用户身份在 token 响应的 id_token（JWT）里，直接解出 claims；
    // 其他 Provider 走标准 userinfo。
    let profile = if provider_type == "apple" {
        let id_token = token_response
            .id_token
            .as_deref()
            .ok_or_else(|| AppError::Internal("Apple token 响应缺少 id_token".to_string()))?;
        sso::decode_jwt_claims(id_token).map_err(AppError::Internal)?
    } else {
        sso::fetch_user_profile(&runtime_provider, &token_response.access_token)
            .await
            .map_err(AppError::Internal)?
    };
    let (provider_sub, email, name, _avatar) = sso::extract_profile_fields(&runtime_provider, &profile);
    let email_verified = profile_email_verified(&profile);
    let (identity_id, sub, is_new) = resolve_or_create_identity(
        &pool,
        &provider_type,
        &provider_sub,
        email.as_deref(),
        email_verified,
        name.as_deref(),
    )
    .await?;

    record_login_log(
        &pool,
        auth_state.tenant_id,
        &auth_state.client_id,
        &provider_type,
        Some(identity_id),
        Some(&sub),
        email.as_deref(),
        if is_new { "register" } else { "login" },
        "success",
        None,
        client_ip_from_headers(&headers).as_deref(),
        user_agent_from_headers(&headers).as_deref(),
    )
    .await;

    let auth_code = random_code();
    sqlx::query(
        r#"
        INSERT INTO management.oauth2_auth_codes
            (code_hash, client_id, identity_id, redirect_uri, scopes,
             code_challenge, challenge_method, nonce, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + ($9 || ' seconds')::interval)
        "#,
    )
    .bind(hash_secret(&auth_code))
    .bind(&auth_state.client_id)
    .bind(identity_id)
    .bind(&auth_state.redirect_uri)
    .bind(&auth_state.requested_scopes)
    .bind(auth_state.code_challenge.as_deref())
    .bind(auth_state.code_challenge_method.as_deref())
    .bind(auth_state.nonce.as_deref())
    .bind(AUTH_CODE_TTL_SECS.to_string())
    .execute(&pool)
    .await?;

    delete_auth_state(&pool, &q.state).await?;

    let mut params = vec![("code", auth_code.as_str())];
    if let Some(state) = auth_state.downstream_state.as_deref() {
        params.push(("state", state));
    }
    let redirect = build_redirect_with_params(&auth_state.redirect_uri, &params)?;
    Ok(redirect)
}

pub async fn oauth2_token(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Form(req): Form<TokenRequest>,
) -> Result<Json<serde_json::Value>> {
    let request_base = request_base_from_headers(&headers);
    let client_id = req
        .client_id
        .as_deref()
        .ok_or_else(|| AppError::InvalidQuery("缺少 client_id".to_string()))?;
    match req.grant_type.as_str() {
        "authorization_code" => {}
        "refresh_token" => {}
        _ => {
            return Err(AppError::InvalidQuery(
                "当前仅支持 authorization_code / refresh_token grant".to_string(),
            ))
        }
    }

    if req.grant_type == "refresh_token" {
        let client = authenticate_client(&pool, client_id, req.client_secret.as_deref(), false).await?;
        let refresh_token = req
            .refresh_token
            .as_deref()
            .ok_or_else(|| AppError::InvalidQuery("缺少 refresh_token".to_string()))?;

        let row = sqlx::query(
            r#"
            SELECT rt.identity_id, rt.scopes, rt.family_id, rt.revoked, rt.rotated, rt.expires_at,
                   i.sub, i.email, i.name, pl.provider
            FROM management.oauth2_refresh_tokens rt
            JOIN management.idp_identities i ON i.id = rt.identity_id
            LEFT JOIN management.idp_provider_links pl ON pl.identity_id = i.id
            WHERE rt.token_hash = $1 AND rt.client_id = $2
            ORDER BY pl.linked_at DESC NULLS LAST
            LIMIT 1
            "#,
        )
        .bind(hash_secret(refresh_token))
        .bind(client_id)
        .fetch_optional(&pool)
        .await?
        .ok_or_else(|| AppError::Unauthorized("refresh_token 无效".to_string()))?;

        let family_id: String = row.get("family_id");
        if row.get::<bool, _>("revoked") || row.get::<bool, _>("rotated") {
            revoke_refresh_family(&pool, &family_id).await?;
            return Err(AppError::Unauthorized(
                "refresh_token 已失效，请重新登录".to_string(),
            ));
        }
        let expires_at: chrono::DateTime<chrono::Utc> = row.get("expires_at");
        if expires_at < Utc::now() {
            revoke_refresh_family(&pool, &family_id).await?;
            return Err(AppError::Unauthorized(
                "refresh_token 已过期，请重新登录".to_string(),
            ));
        }

        sqlx::query(
            "UPDATE management.oauth2_refresh_tokens SET rotated = true WHERE token_hash = $1 AND client_id = $2",
        )
        .bind(hash_secret(refresh_token))
        .bind(client_id)
        .execute(&pool)
        .await?;

        let signing_key = ensure_active_signing_key(&pool).await?;
        let body = issue_token_bundle(
            &pool,
            &signing_key,
            &request_base,
            &client,
            row.get("identity_id"),
            row.get("sub"),
            row.get("email"),
            row.get("name"),
            row.get("scopes"),
            row.get("provider"),
            None,
            Some(family_id),
        )
        .await?;
        return Ok(Json(body));
    }

    let code = req
        .code
        .as_deref()
        .ok_or_else(|| AppError::InvalidQuery("缺少 code".to_string()))?;
    let redirect_uri = req
        .redirect_uri
        .as_deref()
        .ok_or_else(|| AppError::InvalidQuery("缺少 redirect_uri".to_string()))?;

    let client = authenticate_client(
        &pool,
        client_id,
        req.client_secret.as_deref(),
        true,
    )
    .await?;

    let row = sqlx::query(
        r#"
        SELECT ac.identity_id, ac.redirect_uri, ac.scopes, ac.code_challenge, ac.challenge_method,
               ac.nonce, ac.used, ac.expires_at, i.sub, i.email, i.name, pl.provider
        FROM management.oauth2_auth_codes ac
        JOIN management.idp_identities i ON i.id = ac.identity_id
        LEFT JOIN management.idp_provider_links pl ON pl.identity_id = i.id
        WHERE ac.code_hash = $1 AND ac.client_id = $2
        ORDER BY pl.linked_at DESC NULLS LAST
        LIMIT 1
        "#,
    )
    .bind(hash_secret(code))
    .bind(client_id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::Unauthorized("授权码无效".to_string()))?;

    if row.get::<bool, _>("used") {
        return Err(AppError::Unauthorized("授权码已被使用".to_string()));
    }
    let expires_at: chrono::DateTime<chrono::Utc> = row.get("expires_at");
    if expires_at < Utc::now() {
        return Err(AppError::Unauthorized("授权码已过期".to_string()));
    }
    let stored_redirect_uri: String = row.get("redirect_uri");
    if stored_redirect_uri != redirect_uri {
        return Err(AppError::Unauthorized(
            "redirect_uri 与授权阶段不一致".to_string(),
        ));
    }

    let stored_challenge: Option<String> = row.get("code_challenge");
    let stored_challenge_method: Option<String> = row.get("challenge_method");
    if client.require_pkce || stored_challenge.is_some() {
        let verifier = req
            .code_verifier
            .as_deref()
            .ok_or_else(|| AppError::Unauthorized("缺少 code_verifier".to_string()))?;
        if stored_challenge_method.as_deref() != Some("S256") {
            return Err(AppError::Unauthorized(
                "当前仅支持 S256 PKCE".to_string(),
            ));
        }
        let derived = sso::pkce_challenge_s256(verifier);
        if Some(derived) != stored_challenge {
            return Err(AppError::Unauthorized("code_verifier 校验失败".to_string()));
        }
    } else if req.client_secret.is_none() {
        return Err(AppError::Unauthorized(
            "该 client 需要 client_secret 或 PKCE".to_string(),
        ));
    }

    let signing_key = ensure_active_signing_key(&pool).await?;
    let scopes: Vec<String> = row.get("scopes");
    let auth_method: Option<String> = row.get("provider");
    let nonce: Option<String> = row.get("nonce");
    let sub: String = row.get("sub");
    let email: Option<String> = row.get("email");
    let name: Option<String> = row.get("name");
    let identity_id: i32 = row.get("identity_id");

    sqlx::query(
        "UPDATE management.oauth2_auth_codes SET used = true WHERE code_hash = $1 AND client_id = $2",
    )
    .bind(hash_secret(code))
    .bind(client_id)
    .execute(&pool)
    .await?;

    let body = issue_token_bundle(
        &pool,
        &signing_key,
        &request_base,
        &client,
        identity_id,
        sub,
        email,
        name,
        scopes,
        auth_method,
        nonce,
        None,
    )
    .await?;

    Ok(Json(body))
}

pub async fn oauth2_userinfo(
    State(pool): State<PgPool>,
    headers: HeaderMap,
) -> Result<Response> {
    let token = extract_bearer_or_body_token(&headers, None)?;
    let claims = decode_userinfo_token(&pool, &token).await?;

    if claims.token_use.as_deref() != Some("access_token") {
        return Err(AppError::Unauthorized(
            "userinfo 只能使用 access_token".to_string(),
        ));
    }

    Ok((StatusCode::OK, Json(claims_to_userinfo(&claims))).into_response())
}

pub async fn oauth2_userinfo_post(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Form(body): Form<UserInfoPostBody>,
) -> Result<Response> {
    let token = extract_bearer_or_body_token(&headers, body.access_token.as_deref())?;
    let claims = decode_userinfo_token(&pool, &token).await?;

    if claims.token_use.as_deref() != Some("access_token") {
        return Err(AppError::Unauthorized(
            "userinfo 只能使用 access_token".to_string(),
        ));
    }

    Ok((StatusCode::OK, Json(claims_to_userinfo(&claims))).into_response())
}

pub async fn oauth2_revoke(
    State(pool): State<PgPool>,
    Form(req): Form<RevokeRequest>,
) -> Result<StatusCode> {
    let client_id = req
        .client_id
        .as_deref()
        .ok_or_else(|| AppError::InvalidQuery("缺少 client_id".to_string()))?;
    let _client = authenticate_client(&pool, client_id, req.client_secret.as_deref(), false).await?;

    let token_hash = hash_secret(&req.token);
    let family_row = sqlx::query(
        "SELECT family_id FROM management.oauth2_refresh_tokens WHERE token_hash = $1 AND client_id = $2",
    )
    .bind(&token_hash)
    .bind(client_id)
    .fetch_optional(&pool)
    .await?;

    if let Some(row) = family_row {
        let family_id: String = row.get("family_id");
        revoke_refresh_family(&pool, &family_id).await?;
    } else {
        let _ = sqlx::query(
            "UPDATE management.oauth2_auth_codes SET used = true WHERE code_hash = $1 AND client_id = $2",
        )
        .bind(&token_hash)
        .bind(client_id)
        .execute(&pool)
        .await?;
    }

    Ok(StatusCode::OK)
}
