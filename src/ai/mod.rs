//! PlaneOS / OneBase 通用 AI 助手后端。
//!
//! Provider 配置按项目隔离；密钥只以 AES-256-GCM 密文落库，对外仅返回
//! `api_key_configured`。聊天不持久化，统一输出 meta/delta/tool/usage/done/error SSE。

use std::{
    convert::Infallible,
    net::{IpAddr, SocketAddr},
    time::Duration,
};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive},
        Sse,
    },
    Extension, Json,
};
use futures::{Stream, StreamExt};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use tokio::sync::mpsc;

use crate::{
    auth::Claims,
    crypto,
    error::{AppError, Result},
    operation_log::{self, Actor, OperationLogInput, Source, Status},
    permissions,
};

/// 首版 AI 不定义机器凭据 scopes：必须有认证后的 Claims，且请求不能携带任何
/// `ApiKeyContext` / `PlatformTokenContext`。两类机器凭据都会由 auth middleware
/// 合成 Claims，因此不能只用 `Claims` 是否存在来判断。
fn require_interactive_credential(
    has_claims: bool,
    has_api_key_context: bool,
    has_platform_token_context: bool,
) -> Result<()> {
    if !has_claims {
        return Err(AppError::Unauthorized("未认证".to_string()));
    }
    if has_api_key_context || has_platform_token_context {
        return Err(AppError::Forbidden(
            "AI 助手当前仅支持交互式用户会话".to_string(),
        ));
    }
    Ok(())
}

/// AI 路由凭据守卫。必须放在 `auth_middleware` 之后执行，读取其注入的扩展。
pub async fn interactive_jwt_guard(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response> {
    require_interactive_credential(
        req.extensions().get::<Claims>().is_some(),
        req.extensions()
            .get::<crate::middleware::ApiKeyContext>()
            .is_some(),
        req.extensions()
            .get::<crate::platform_token::PlatformTokenContext>()
            .is_some(),
    )?;
    Ok(next.run(req).await)
}

const MAX_MESSAGES: usize = 100;
const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_TOOL_CALLS: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Openai,
    #[serde(alias = "claude")]
    Anthropic,
    #[serde(alias = "tongyi")]
    Qwen,
}

impl ProviderKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
            Self::Qwen => "qwen",
        }
    }

    fn protocol(self) -> Protocol {
        match self {
            Self::Anthropic => Protocol::Anthropic,
            Self::Openai | Self::Qwen => Protocol::OpenAi,
        }
    }

    fn default_base_url(self) -> &'static str {
        match self {
            Self::Openai => "https://api.openai.com/v1",
            Self::Anthropic => "https://api.anthropic.com/v1",
            Self::Qwen => "https://dashscope.aliyuncs.com/compatible-mode/v1",
        }
    }
}

impl std::str::FromStr for ProviderKind {
    type Err = AppError;

    fn from_str(value: &str) -> Result<Self> {
        match value.to_ascii_lowercase().as_str() {
            "openai" => Ok(Self::Openai),
            "anthropic" | "claude" => Ok(Self::Anthropic),
            "qwen" | "tongyi" => Ok(Self::Qwen),
            _ => Err(AppError::InvalidQuery(format!(
                "不支持的 AI Provider：{value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Protocol {
    OpenAi,
    Anthropic,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct ProviderRecord {
    id: i32,
    tenant_id: i32,
    provider: String,
    name: String,
    base_url: String,
    model: String,
    api_key_enc: String,
    is_active: bool,
    is_default: bool,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

impl ProviderRecord {
    fn kind(&self) -> Result<ProviderKind> {
        self.provider.parse()
    }

    fn public_json(&self) -> Value {
        json!({
            "id": self.id,
            "tenant_id": self.tenant_id,
            "provider": self.provider,
            "name": self.name,
            "base_url": self.base_url,
            "model": self.model,
            "is_active": self.is_active,
            "is_default": self.is_default,
            "api_key_configured": !self.api_key_enc.is_empty(),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        })
    }
}

#[derive(Debug, Deserialize)]
pub struct CreateProviderRequest {
    pub provider: ProviderKind,
    pub name: String,
    #[serde(default)]
    pub base_url: Option<String>,
    pub model: String,
    pub api_key: String,
    #[serde(default)]
    pub is_active: Option<bool>,
    #[serde(default)]
    pub is_default: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProviderRequest {
    #[serde(default)]
    pub provider: Option<ProviderKind>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// 不传或传空字符串均保留原密钥。
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub is_active: Option<bool>,
    #[serde(default)]
    pub is_default: Option<bool>,
}

/// 计算一次 create/update 后目标项是否应成为默认项。
///
/// 不变量：停用项永不默认；只要存在 active Provider，就尽量维持一个 active default。
fn desired_default_state(
    is_active: bool,
    was_default: bool,
    requested_default: Option<bool>,
    has_other_active_default: bool,
) -> Result<bool> {
    if !is_active {
        if requested_default == Some(true) {
            return Err(AppError::InvalidQuery(
                "停用的 AI Provider 不能设为默认".to_string(),
            ));
        }
        return Ok(false);
    }
    Ok(match requested_default {
        Some(true) => true,
        Some(false) => !has_other_active_default,
        None => was_default || !has_other_active_default,
    })
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct ChatRequest {
    #[serde(default)]
    pub provider_id: Option<i32>,
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub tools_enabled: Option<bool>,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

fn validate_text(label: &str, value: &str, max: usize) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(AppError::InvalidQuery(format!("{label}不能为空")));
    }
    if value.len() > max {
        return Err(AppError::InvalidQuery(format!(
            "{label}过长，上限 {max} 字节"
        )));
    }
    Ok(value.to_string())
}

fn is_non_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_unspecified()
                || ip.octets()[0] == 0
                || ip.octets()[0] >= 224
        }
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip.is_multicast()
        }
    }
}

fn local_base_url_allowed(url: &Url) -> bool {
    let env = std::env::var("RUST_ENV").unwrap_or_default();
    if !matches!(env.as_str(), "development" | "test") {
        return false;
    }
    match url
        .host_str()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "localhost" => true,
        host => host
            .parse::<IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false),
    }
}

struct ValidatedTarget {
    base_url: String,
    host: String,
    addresses: Vec<SocketAddr>,
}

/// URL 既做语法/协议校验，也解析 DNS 检查所有地址，防止域名指向内网。
async fn validate_and_resolve_base_url(raw: &str) -> Result<ValidatedTarget> {
    let trimmed = raw.trim().trim_end_matches('/');
    let url = Url::parse(trimmed)
        .map_err(|_| AppError::InvalidQuery("base_url 不是有效 URL".to_string()))?;
    if url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::InvalidQuery(
            "base_url 不允许包含凭据、query 或 fragment".to_string(),
        ));
    }
    let local_allowed = local_base_url_allowed(&url);
    if url.scheme() != "https" && !(url.scheme() == "http" && local_allowed) {
        return Err(AppError::InvalidQuery(
            "base_url 必须使用 HTTPS；开发/测试环境仅允许 HTTP localhost".to_string(),
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| AppError::InvalidQuery("base_url 缺少主机名".to_string()))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| AppError::InvalidQuery("base_url 端口无效".to_string()))?;
    let addresses: Vec<_> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| AppError::InvalidQuery("base_url 主机无法解析".to_string()))?
        .collect();
    if addresses.is_empty() {
        return Err(AppError::InvalidQuery("base_url 主机无法解析".to_string()));
    }
    if !local_allowed && addresses.iter().any(|addr| is_non_public_ip(addr.ip())) {
        return Err(AppError::InvalidQuery(
            "base_url 不允许指向本机、内网、链路本地或保留地址".to_string(),
        ));
    }
    Ok(ValidatedTarget {
        base_url: trimmed.to_string(),
        host: host.to_string(),
        addresses,
    })
}

async fn validate_base_url(raw: &str) -> Result<String> {
    Ok(validate_and_resolve_base_url(raw).await?.base_url)
}

async fn normalized_base_url(kind: ProviderKind, value: Option<&str>) -> Result<String> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        Some(custom) => validate_base_url(custom).await,
        None => Ok(kind.default_base_url().to_string()),
    }
}

fn endpoint(record: &ProviderRecord) -> Result<String> {
    let suffix = match record.kind()?.protocol() {
        Protocol::OpenAi => "chat/completions",
        Protocol::Anthropic => "messages",
    };
    Ok(format!(
        "{}/{}",
        record.base_url.trim_end_matches('/'),
        suffix
    ))
}

fn record_provider_op(
    pool: &PgPool,
    claims: &Claims,
    tenant_id: i32,
    action: &str,
    record: &ProviderRecord,
    summary: String,
) {
    let input = OperationLogInput::new(
        tenant_id,
        Actor::from_claims(claims),
        Source::Console,
        action,
        summary,
        Status::Success,
    )
    .resource(
        operation_log::resource_type::PROJECT_SETTING,
        record.name.clone(),
        Some(record.id.to_string()),
    )
    .detail(json!({
        "setting": "ai_provider",
        "provider": record.provider,
        "model": record.model,
        "is_active": record.is_active,
        "is_default": record.is_default,
        "api_key": "***"
    }));
    operation_log::record(pool, input);
}

pub async fn list_providers(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
) -> Result<Json<Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;
    let rows = sqlx::query_as::<_, ProviderRecord>(
        "SELECT id, tenant_id, provider, name, base_url, model, api_key_enc, is_active, is_default, \
         created_at, updated_at FROM management.ai_providers \
         WHERE tenant_id = $1 ORDER BY is_default DESC, id ASC",
    )
    .bind(project_id)
    .fetch_all(&pool)
    .await?;
    Ok(Json(json!({
        "providers": rows.iter().map(ProviderRecord::public_json).collect::<Vec<_>>()
    })))
}

pub async fn create_provider(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
    Json(req): Json<CreateProviderRequest>,
) -> Result<(StatusCode, Json<Value>)> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;
    let name = validate_text("名称", &req.name, 120)?;
    let model = validate_text("模型", &req.model, 160)?;
    let api_key = validate_text("API Key", &req.api_key, 16 * 1024)?;
    let base_url = normalized_base_url(req.provider, req.base_url.as_deref()).await?;
    let api_key_enc = crypto::encrypt_secret(&api_key)?;
    let is_active = req.is_active.unwrap_or(true);

    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1::bigint)")
        .bind(project_id)
        .execute(&mut *tx)
        .await?;
    let has_active_default: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM management.ai_providers \
         WHERE tenant_id=$1 AND is_active=true AND is_default=true)",
    )
    .bind(project_id)
    .fetch_one(&mut *tx)
    .await?;
    let is_default = desired_default_state(is_active, false, req.is_default, has_active_default)?;
    if is_default {
        sqlx::query("UPDATE management.ai_providers SET is_default = false WHERE tenant_id = $1")
            .bind(project_id)
            .execute(&mut *tx)
            .await?;
    }
    let row = sqlx::query_as::<_, ProviderRecord>(
        "INSERT INTO management.ai_providers \
         (tenant_id, provider, name, base_url, model, api_key_enc, is_active, is_default, created_by, updated_by) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) \
         RETURNING id, tenant_id, provider, name, base_url, model, api_key_enc, is_active, is_default, created_at, updated_at",
    )
    .bind(project_id)
    .bind(req.provider.as_str())
    .bind(name)
    .bind(base_url)
    .bind(model)
    .bind(api_key_enc)
    .bind(is_active)
    .bind(is_default)
    .bind(claims.sub)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    record_provider_op(
        &pool,
        &claims,
        project_id,
        operation_log::action::CREATE,
        &row,
        format!("创建 AI Provider「{}」", row.name),
    );
    Ok((StatusCode::CREATED, Json(row.public_json())))
}

pub async fn update_provider(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, provider_id)): Path<(i32, i32)>,
    Json(req): Json<UpdateProviderRequest>,
) -> Result<Json<Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1::bigint)")
        .bind(project_id)
        .execute(&mut *tx)
        .await?;
    let old = sqlx::query_as::<_, ProviderRecord>(
        "SELECT id, tenant_id, provider, name, base_url, model, api_key_enc, is_active, is_default, \
         created_at, updated_at FROM management.ai_providers \
         WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(project_id)
    .bind(provider_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("AI Provider {provider_id} 不存在")))?;

    let kind = req.provider.unwrap_or(old.kind()?);
    let name = match req.name.as_deref() {
        Some(v) => validate_text("名称", v, 120)?,
        None => old.name.clone(),
    };
    let model = match req.model.as_deref() {
        Some(v) => validate_text("模型", v, 160)?,
        None => old.model.clone(),
    };
    let base_url = match req.base_url.as_deref() {
        Some(v) => normalized_base_url(kind, Some(v)).await?,
        None if req.provider.is_some() && kind != old.kind()? => {
            normalized_base_url(kind, None).await?
        }
        None => old.base_url.clone(),
    };
    let api_key_enc = match req.api_key.as_deref().map(str::trim) {
        Some(v) if !v.is_empty() => {
            validate_text("API Key", v, 16 * 1024)?;
            crypto::encrypt_secret(v)?
        }
        _ => old.api_key_enc.clone(),
    };
    let is_active = req.is_active.unwrap_or(old.is_active);
    let has_other_active_default: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM management.ai_providers \
         WHERE tenant_id=$1 AND id<>$2 AND is_active=true AND is_default=true)",
    )
    .bind(project_id)
    .bind(provider_id)
    .fetch_one(&mut *tx)
    .await?;
    let make_default = desired_default_state(
        is_active,
        old.is_default,
        req.is_default,
        has_other_active_default,
    )?;
    if make_default {
        sqlx::query("UPDATE management.ai_providers SET is_default = false WHERE tenant_id = $1")
            .bind(project_id)
            .execute(&mut *tx)
            .await?;
    }
    let affected = sqlx::query(
        "UPDATE management.ai_providers SET provider=$1, name=$2, base_url=$3, model=$4, \
         api_key_enc=$5, is_active=$6, is_default=$7, updated_by=$8 \
         WHERE id=$9 AND tenant_id=$10",
    )
    .bind(kind.as_str())
    .bind(name)
    .bind(base_url)
    .bind(model)
    .bind(api_key_enc)
    .bind(is_active)
    .bind(make_default)
    .bind(claims.sub)
    .bind(provider_id)
    .bind(project_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if affected == 0 {
        return Err(AppError::NotFound(format!(
            "AI Provider {provider_id} 不存在"
        )));
    }
    // 停用/取消当前默认项后，优先把另一个 active Provider 提升为默认；
    // 若目标是唯一 active 项，则仍由目标维持默认，避免 active 集合没有默认项。
    sqlx::query(
        "UPDATE management.ai_providers SET is_default=true \
         WHERE id=(SELECT id FROM management.ai_providers \
                   WHERE tenant_id=$1 AND is_active=true AND is_default=false \
                     AND NOT EXISTS(SELECT 1 FROM management.ai_providers \
                                    WHERE tenant_id=$1 AND is_active=true AND is_default=true) \
                   ORDER BY CASE WHEN id=$2 THEN 1 ELSE 0 END, id LIMIT 1)",
    )
    .bind(project_id)
    .bind(provider_id)
    .execute(&mut *tx)
    .await?;
    let row = sqlx::query_as::<_, ProviderRecord>(
        "SELECT id, tenant_id, provider, name, base_url, model, api_key_enc, is_active, is_default, \
         created_at, updated_at FROM management.ai_providers WHERE tenant_id=$1 AND id=$2",
    )
    .bind(project_id)
    .bind(provider_id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    record_provider_op(
        &pool,
        &claims,
        project_id,
        operation_log::action::UPDATE,
        &row,
        format!("更新 AI Provider「{}」", row.name),
    );
    Ok(Json(row.public_json()))
}

pub async fn delete_provider(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, provider_id)): Path<(i32, i32)>,
) -> Result<Json<Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1::bigint)")
        .bind(project_id)
        .execute(&mut *tx)
        .await?;
    let old = sqlx::query_as::<_, ProviderRecord>(
        "SELECT id, tenant_id, provider, name, base_url, model, api_key_enc, is_active, is_default, \
         created_at, updated_at FROM management.ai_providers \
         WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(project_id)
    .bind(provider_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("AI Provider {provider_id} 不存在")))?;
    let deleted = sqlx::query("DELETE FROM management.ai_providers WHERE id=$1 AND tenant_id=$2")
        .bind(provider_id)
        .bind(project_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if deleted == 0 {
        return Err(AppError::NotFound(format!(
            "AI Provider {provider_id} 不存在"
        )));
    }
    sqlx::query(
        "UPDATE management.ai_providers SET is_default=true \
         WHERE id=(SELECT id FROM management.ai_providers \
                   WHERE tenant_id=$1 AND is_active=true \
                     AND NOT EXISTS(SELECT 1 FROM management.ai_providers \
                                    WHERE tenant_id=$1 AND is_active=true AND is_default=true) \
                   ORDER BY id LIMIT 1)",
    )
    .bind(project_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    record_provider_op(
        &pool,
        &claims,
        project_id,
        operation_log::action::DELETE,
        &old,
        format!("删除 AI Provider「{}」", old.name),
    );
    Ok(Json(json!({ "deleted": true })))
}

async fn fetch_provider(pool: &PgPool, tenant_id: i32, id: i32) -> Result<ProviderRecord> {
    sqlx::query_as::<_, ProviderRecord>(
        "SELECT id, tenant_id, provider, name, base_url, model, api_key_enc, is_active, is_default, \
         created_at, updated_at FROM management.ai_providers WHERE tenant_id=$1 AND id=$2",
    )
    .bind(tenant_id)
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("AI Provider {id} 不存在")))
}

async fn resolve_provider(
    pool: &PgPool,
    tenant_id: i32,
    provider_id: Option<i32>,
) -> Result<ProviderRecord> {
    let row = if let Some(id) = provider_id {
        let provider = fetch_provider(pool, tenant_id, id).await?;
        if !provider.is_active {
            return Err(AppError::Forbidden(format!(
                "AI Provider {}「{}」已停用，不能用于聊天",
                provider.id, provider.name
            )));
        }
        provider
    } else {
        sqlx::query_as::<_, ProviderRecord>(
            "SELECT id, tenant_id, provider, name, base_url, model, api_key_enc, is_active, is_default, \
             created_at, updated_at FROM management.ai_providers \
             WHERE tenant_id=$1 AND is_active=true ORDER BY is_default DESC, id ASC LIMIT 1",
        )
        .bind(tenant_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("项目没有已启用的 AI Provider".to_string()))?
    };
    Ok(row)
}

/// 请求前重新解析并校验存储的 base_url，再把 reqwest DNS 固定到这组已验证地址。
/// URL 本身仍保留原 hostname，因此 HTTPS SNI/证书校验不会退化成 IP 校验。
async fn client_for_provider(provider: &ProviderRecord) -> Result<Client> {
    let target = validate_and_resolve_base_url(&provider.base_url).await?;
    let kind = provider.kind()?;
    if provider.base_url.trim_end_matches('/') == kind.default_base_url() {
        let expected = Url::parse(kind.default_base_url())
            .ok()
            .and_then(|url| url.host_str().map(str::to_string));
        if expected.as_deref() != Some(target.host.as_str()) {
            return Err(AppError::InvalidQuery(
                "默认 Provider 域名与内置配置不一致".to_string(),
            ));
        }
    }
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        // 系统 HTTP(S)_PROXY 会绕过本地 DNS resolver，使 pinned resolve 失效；
        // AI 出站请求必须直连已校验地址，不能把 SSRF 边界委托给代理。
        .no_proxy()
        .resolve_to_addrs(&target.host, &target.addresses)
        .build()
        .map_err(|e| AppError::Internal(format!("创建 AI HTTP 客户端失败: {e}")))
}

fn validate_messages(messages: &[ChatMessage]) -> Result<()> {
    if messages.is_empty() || messages.len() > MAX_MESSAGES {
        return Err(AppError::InvalidQuery(format!(
            "messages 数量必须为 1..={MAX_MESSAGES}"
        )));
    }
    let total: usize = messages.iter().map(|m| m.content.len()).sum();
    if total > MAX_MESSAGE_BYTES {
        return Err(AppError::InvalidQuery(format!(
            "消息总大小超过 {}KB",
            MAX_MESSAGE_BYTES / 1024
        )));
    }
    if messages.iter().any(|m| {
        !matches!(m.role.as_str(), "system" | "user" | "assistant") || m.content.trim().is_empty()
    }) {
        return Err(AppError::InvalidQuery(
            "消息 role 仅支持 system/user/assistant，且 content 不能为空".to_string(),
        ));
    }
    Ok(())
}

const SAFE_UPSTREAM_MESSAGE: &str = "AI Provider 请求失败，请稍后重试";

fn safe_request_id(headers: &reqwest::header::HeaderMap) -> Option<String> {
    const NAMES: &[&str] = &[
        "x-request-id",
        "request-id",
        "openai-request-id",
        "anthropic-request-id",
    ];
    NAMES.iter().find_map(|name| {
        let value = headers.get(*name)?.to_str().ok()?.trim();
        (!value.is_empty()
            && value.len() <= 128
            && value.bytes().all(|b| {
                b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':' | b'/')
            }))
        .then(|| value.to_string())
    })
}

fn log_upstream_failure(
    provider: &ProviderRecord,
    phase: &'static str,
    status: Option<reqwest::StatusCode>,
    request_id: Option<&str>,
) {
    tracing::warn!(
        provider = %provider.provider,
        model = %provider.model,
        phase,
        http_status = status.map(|s| s.as_u16()),
        request_id = request_id.unwrap_or(""),
        "AI Provider 请求失败（上游正文已丢弃）"
    );
}

fn upstream_unavailable() -> AppError {
    AppError::ServiceUnavailable(SAFE_UPSTREAM_MESSAGE.to_string())
}

async fn send_json(
    client: &Client,
    provider: &ProviderRecord,
    api_key: &str,
    body: &Value,
) -> Result<Value> {
    let mut request = client.post(endpoint(provider)?).json(body);
    request = match provider.kind()?.protocol() {
        Protocol::OpenAi => request.bearer_auth(api_key),
        Protocol::Anthropic => request
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01"),
    };
    let response = request.send().await.map_err(|_| {
        log_upstream_failure(provider, "send", None, None);
        upstream_unavailable()
    })?;
    let status = response.status();
    if !status.is_success() {
        let request_id = safe_request_id(response.headers());
        log_upstream_failure(provider, "http", Some(status), request_id.as_deref());
        return Err(upstream_unavailable());
    }
    response.json::<Value>().await.map_err(|_| {
        log_upstream_failure(provider, "decode_json", Some(status), None);
        upstream_unavailable()
    })
}

pub async fn test_provider(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, provider_id)): Path<(i32, i32)>,
) -> Result<Json<Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;
    // 管理员可测试停用项，便于先验证新配置再启用；聊天选择仍严格拒绝停用项。
    let provider = fetch_provider(&pool, project_id, provider_id).await?;
    let api_key = crypto::decrypt_secret(&provider.api_key_enc)?;
    let messages = vec![ChatMessage {
        role: "user".to_string(),
        content: "Reply with OK.".to_string(),
    }];
    let body = request_body(&provider, &messages, false, false, Some(8), Some(0.0))?;
    let started = std::time::Instant::now();
    let value = send_json(
        &client_for_provider(&provider).await?,
        &provider,
        &api_key,
        &body,
    )
    .await?;
    if extract_text(&provider, &value).is_none() {
        return Err(AppError::ServiceUnavailable(
            "Provider 连通，但响应中没有可识别的文本".to_string(),
        ));
    }
    Ok(Json(json!({
        "ok": true,
        "latency_ms": started.elapsed().as_millis(),
        "provider": provider.provider,
        "model": provider.model,
        "is_active": provider.is_active,
        "notice": if provider.is_active {
            "Provider 已启用"
        } else {
            "Provider 当前停用；本接口允许管理员测试，但聊天接口不会选择它"
        }
    })))
}

fn openai_tool_schemas() -> Value {
    json!([
        {"type":"function","function":{
            "name":"list_workflows",
            "description":"列出当前项目的工作流。只读。",
            "parameters":{"type":"object","properties":{"search":{"type":"string"}},"additionalProperties":false}
        }},
        {"type":"function","function":{
            "name":"get_workflow",
            "description":"按 ID 获取当前项目的工作流定义。只读。",
            "parameters":{"type":"object","properties":{"id":{"type":"integer"}},"required":["id"],"additionalProperties":false}
        }},
        {"type":"function","function":{
            "name":"get_project_schema",
            "description":"读取当前项目及其数据库连接的非敏感元数据。只读。",
            "parameters":{"type":"object","properties":{},"additionalProperties":false}
        }}
    ])
}

fn anthropic_tool_schemas() -> Value {
    let schemas = openai_tool_schemas();
    Value::Array(
        schemas
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.get("function"))
            .map(|f| {
                json!({
                    "name": f["name"],
                    "description": f["description"],
                    "input_schema": f["parameters"]
                })
            })
            .collect(),
    )
}

const READ_ONLY_TOOLS: &[&str] = &["list_workflows", "get_workflow", "get_project_schema"];

fn tool_allowed(name: &str) -> bool {
    READ_ONLY_TOOLS.contains(&name)
}

fn nullable_slug_value(slug: Option<String>) -> Value {
    slug.map(Value::String).unwrap_or(Value::Null)
}

async fn execute_readonly_tool(
    pool: &PgPool,
    tenant_id: i32,
    name: &str,
    args: &Value,
) -> Result<Value> {
    if !tool_allowed(name) {
        return Err(AppError::Forbidden(format!(
            "AI 工具不在只读白名单中：{name}"
        )));
    }
    match name {
        "list_workflows" => {
            let search = args.get("search").and_then(Value::as_str).unwrap_or("");
            let rows = sqlx::query(
                "SELECT id, name, slug, description, trigger_type, is_enabled, updated_at \
                 FROM management.workflows WHERE tenant_id=$1 \
                 AND ($2='' OR name ILIKE '%' || $2 || '%' OR slug ILIKE '%' || $2 || '%') \
                 ORDER BY updated_at DESC LIMIT 100",
            )
            .bind(tenant_id)
            .bind(search)
            .fetch_all(pool)
            .await?;
            Ok(Value::Array(
                rows.iter()
                    .map(|r| {
                        json!({
                            "id": r.get::<i32,_>("id"),
                            "name": r.get::<String,_>("name"),
                            "slug": r.get::<String,_>("slug"),
                            "description": r.get::<Option<String>,_>("description"),
                            "trigger_type": r.get::<String,_>("trigger_type"),
                            "is_enabled": r.get::<bool,_>("is_enabled"),
                            "updated_at": r.get::<chrono::NaiveDateTime,_>("updated_at")
                        })
                    })
                    .collect(),
            ))
        }
        "get_workflow" => {
            let id = args
                .get("id")
                .and_then(Value::as_i64)
                .and_then(|v| i32::try_from(v).ok())
                .ok_or_else(|| AppError::InvalidQuery("get_workflow 缺少有效 id".to_string()))?;
            let row = sqlx::query(
                "SELECT id, name, slug, description, trigger_type, trigger_config, nodes, edges, \
                 is_enabled, timeout_ms, max_retries, updated_at \
                 FROM management.workflows WHERE tenant_id=$1 AND id=$2",
            )
            .bind(tenant_id)
            .bind(id)
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("工作流 {id} 不存在")))?;
            Ok(json!({
                "id": row.get::<i32,_>("id"),
                "name": row.get::<String,_>("name"),
                "slug": row.get::<String,_>("slug"),
                "description": row.get::<Option<String>,_>("description"),
                "trigger_type": row.get::<String,_>("trigger_type"),
                "trigger_config": row.get::<Value,_>("trigger_config"),
                "nodes": row.get::<Value,_>("nodes"),
                "edges": row.get::<Value,_>("edges"),
                "is_enabled": row.get::<bool,_>("is_enabled"),
                "timeout_ms": row.get::<i32,_>("timeout_ms"),
                "max_retries": row.get::<i32,_>("max_retries"),
                "updated_at": row.get::<chrono::NaiveDateTime,_>("updated_at")
            }))
        }
        "get_project_schema" => {
            let project = sqlx::query(
                "SELECT id, name, status, created_at FROM management.tenants WHERE id=$1",
            )
            .bind(tenant_id)
            .fetch_one(pool)
            .await?;
            let databases = sqlx::query(
                "SELECT id, connection_name, slug, db_name, is_primary, is_active, created_at \
                 FROM management.tenant_databases WHERE tenant_id=$1 ORDER BY id",
            )
            .bind(tenant_id)
            .fetch_all(pool)
            .await?;
            let schemas = sqlx::query(
                "SELECT database_id, schema_name, business_type, display_name, description, is_active \
                 FROM management.tenant_schemas WHERE tenant_id=$1 ORDER BY database_id, schema_name",
            )
            .bind(tenant_id)
            .fetch_all(pool)
            .await?;
            Ok(json!({
                "project": {
                    "id": project.get::<i32,_>("id"),
                    "name": project.get::<String,_>("name"),
                    "status": project.get::<String,_>("status"),
                    "created_at": project.get::<chrono::NaiveDateTime,_>("created_at")
                },
                "databases": databases.iter().map(|r| json!({
                    "id": r.get::<i32,_>("id"),
                    "name": r.get::<String,_>("connection_name"),
                    "slug": nullable_slug_value(r.get::<Option<String>,_>("slug")),
                    "database_name": r.get::<String,_>("db_name"),
                    "is_primary": r.get::<Option<bool>,_>("is_primary").unwrap_or(false),
                    "is_active": r.get::<Option<bool>,_>("is_active").unwrap_or(false),
                    "created_at": r.get::<chrono::NaiveDateTime,_>("created_at")
                })).collect::<Vec<_>>(),
                "schemas": schemas.iter().map(|r| json!({
                    "database_id": r.get::<i32,_>("database_id"),
                    "schema_name": r.get::<String,_>("schema_name"),
                    "business_type": r.get::<String,_>("business_type"),
                    "display_name": r.get::<String,_>("display_name"),
                    "description": r.get::<Option<String>,_>("description"),
                    "is_active": r.get::<Option<bool>,_>("is_active").unwrap_or(false)
                })).collect::<Vec<_>>()
            }))
        }
        _ => unreachable!("白名单和分发必须同步"),
    }
}

fn request_body(
    provider: &ProviderRecord,
    messages: &[ChatMessage],
    stream: bool,
    tools: bool,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
) -> Result<Value> {
    let body = match provider.kind()?.protocol() {
        Protocol::OpenAi => {
            let mut body = json!({
                "model": provider.model,
                "messages": messages,
                "stream": stream,
                "max_tokens": max_tokens.unwrap_or(2048),
            });
            if let Some(t) = temperature {
                body["temperature"] = json!(t);
            }
            if stream {
                body["stream_options"] = json!({"include_usage": true});
            }
            if tools {
                body["tools"] = openai_tool_schemas();
                body["tool_choice"] = json!("auto");
            }
            body
        }
        Protocol::Anthropic => {
            let system = messages
                .iter()
                .filter(|m| m.role == "system")
                .map(|m| m.content.as_str())
                .collect::<Vec<_>>()
                .join("\n\n");
            let mapped: Vec<_> = messages
                .iter()
                .filter(|m| m.role != "system")
                .map(|m| json!({"role": m.role, "content": m.content}))
                .collect();
            let mut body = json!({
                "model": provider.model,
                "messages": mapped,
                "stream": stream,
                "max_tokens": max_tokens.unwrap_or(2048),
            });
            if !system.is_empty() {
                body["system"] = json!(system);
            }
            if let Some(t) = temperature {
                body["temperature"] = json!(t);
            }
            if tools {
                body["tools"] = anthropic_tool_schemas();
            }
            body
        }
    };
    Ok(body)
}

#[derive(Debug, Clone, PartialEq)]
enum ParsedEvent {
    Delta(String),
    Usage(Value),
    Done,
    Error(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamControl {
    Continue,
    Succeeded,
    Failed,
}

fn stream_control(event: &ParsedEvent) -> StreamControl {
    match event {
        ParsedEvent::Done => StreamControl::Succeeded,
        ParsedEvent::Error(_) => StreamControl::Failed,
        ParsedEvent::Delta(_) | ParsedEvent::Usage(_) => StreamControl::Continue,
    }
}

#[derive(Default)]
struct SseDecoder {
    buffer: Vec<u8>,
}

impl SseDecoder {
    fn push(&mut self, bytes: &[u8]) -> Vec<std::result::Result<(Option<String>, String), ()>> {
        self.buffer.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some((pos, delimiter_len)) = frame_delimiter(&self.buffer) {
            let frame: Vec<u8> = self.buffer.drain(..pos).collect();
            self.buffer.drain(..delimiter_len);
            if !frame.is_empty() {
                let decoded = decode_sse_frame(&frame);
                if !matches!(&decoded, Ok((_, data)) if data.is_empty()) {
                    out.push(decoded);
                }
            }
        }
        out
    }

    /// 上游关闭时仍处理没有空行终止符的最后一帧。
    fn finish(&mut self) -> Vec<std::result::Result<(Option<String>, String), ()>> {
        if self.buffer.iter().all(u8::is_ascii_whitespace) {
            self.buffer.clear();
            return Vec::new();
        }
        let frame = std::mem::take(&mut self.buffer);
        let decoded = decode_sse_frame(&frame);
        if matches!(&decoded, Ok((_, data)) if data.is_empty()) {
            Vec::new()
        } else {
            vec![decoded]
        }
    }
}

fn frame_delimiter(buffer: &[u8]) -> Option<(usize, usize)> {
    for i in 0..buffer.len() {
        if buffer.get(i..i + 4) == Some(b"\r\n\r\n") {
            return Some((i, 4));
        }
        if buffer.get(i..i + 2) == Some(b"\n\n") {
            return Some((i, 2));
        }
    }
    None
}

fn decode_sse_frame(frame: &[u8]) -> std::result::Result<(Option<String>, String), ()> {
    let block = std::str::from_utf8(frame).map_err(|_| ())?;
    let normalized = block.replace("\r\n", "\n");
    let mut event = None;
    let mut data = Vec::new();
    for line in normalized.lines() {
        if let Some(value) = line.strip_prefix("event:") {
            event = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push(value.trim_start().to_string());
        }
    }
    Ok((event, data.join("\n")))
}

fn parse_openai_sse(_event: Option<&str>, data: &str) -> Vec<ParsedEvent> {
    if data.trim() == "[DONE]" {
        return vec![ParsedEvent::Done];
    }
    let value: Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(_) => return vec![ParsedEvent::Error(SAFE_UPSTREAM_MESSAGE.to_string())],
    };
    if value.get("error").is_some() {
        return vec![ParsedEvent::Error(SAFE_UPSTREAM_MESSAGE.to_string())];
    }
    let mut out = Vec::new();
    if let Some(text) = value
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
    {
        if !text.is_empty() {
            out.push(ParsedEvent::Delta(text.to_string()));
        }
    }
    if let Some(usage) = value.get("usage").filter(|v| !v.is_null()) {
        out.push(ParsedEvent::Usage(usage.clone()));
    }
    out
}

fn parse_anthropic_sse(event: Option<&str>, data: &str) -> Vec<ParsedEvent> {
    let value: Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(_) => return vec![ParsedEvent::Error(SAFE_UPSTREAM_MESSAGE.to_string())],
    };
    match event.or_else(|| value.get("type").and_then(Value::as_str)) {
        Some("content_block_delta") => value
            .pointer("/delta/text")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(|s| vec![ParsedEvent::Delta(s.to_string())])
            .unwrap_or_default(),
        Some("message_delta") => value
            .get("usage")
            .cloned()
            .map(|v| vec![ParsedEvent::Usage(v)])
            .unwrap_or_default(),
        Some("message_stop") => vec![ParsedEvent::Done],
        Some("error") => vec![ParsedEvent::Error(SAFE_UPSTREAM_MESSAGE.to_string())],
        _ => Vec::new(),
    }
}

fn sse_event(kind: &'static str, data: Value) -> Event {
    let mut data = data;
    if let Some(object) = data.as_object_mut() {
        object
            .entry("type".to_string())
            .or_insert_with(|| json!(kind));
    } else {
        data = json!({"type": kind, "data": data});
    }
    Event::default()
        .event(kind)
        .json_data(data)
        .unwrap_or_else(|_| {
            Event::default()
                .event("error")
                .data(r#"{"message":"SSE 序列化失败"}"#)
        })
}

async fn emit(
    tx: &mpsc::Sender<std::result::Result<Event, Infallible>>,
    kind: &'static str,
    data: Value,
) -> bool {
    tx.send(Ok(sse_event(kind, data))).await.is_ok()
}

async fn emit_decoded_frames(
    tx: &mpsc::Sender<std::result::Result<Event, Infallible>>,
    protocol: Protocol,
    frames: Vec<std::result::Result<(Option<String>, String), ()>>,
) -> (bool, bool) {
    let mut sent_done = false;
    for frame in frames {
        let parsed = match frame {
            Ok((event, data)) => match protocol {
                Protocol::OpenAi => parse_openai_sse(event.as_deref(), &data),
                Protocol::Anthropic => parse_anthropic_sse(event.as_deref(), &data),
            },
            Err(()) => vec![ParsedEvent::Error(SAFE_UPSTREAM_MESSAGE.to_string())],
        };
        for item in parsed {
            let control = stream_control(&item);
            let keep = match item {
                ParsedEvent::Delta(text) => emit(tx, "delta", json!({"text": text})).await,
                ParsedEvent::Usage(usage) => emit(tx, "usage", usage).await,
                ParsedEvent::Done => {
                    sent_done = true;
                    emit(tx, "done", json!({"ok": true})).await
                }
                ParsedEvent::Error(_) => {
                    emit(tx, "error", json!({"message": SAFE_UPSTREAM_MESSAGE})).await
                }
            };
            if !keep {
                return (false, sent_done);
            }
            match control {
                StreamControl::Continue => {}
                // error 事件发出后立即终止；外层不会再补 done ok:true。
                StreamControl::Failed => return (false, false),
                StreamControl::Succeeded => return (false, true),
            }
        }
    }
    (true, sent_done)
}

async fn stream_provider(
    tx: &mpsc::Sender<std::result::Result<Event, Infallible>>,
    client: &Client,
    provider: &ProviderRecord,
    api_key: &str,
    body: Value,
) -> Result<()> {
    let mut request = client.post(endpoint(provider)?).json(&body);
    request = match provider.kind()?.protocol() {
        Protocol::OpenAi => request.bearer_auth(api_key),
        Protocol::Anthropic => request
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01"),
    };
    let response = request.send().await.map_err(|_| {
        log_upstream_failure(provider, "stream_send", None, None);
        upstream_unavailable()
    })?;
    let status = response.status();
    if !status.is_success() {
        let request_id = safe_request_id(response.headers());
        log_upstream_failure(provider, "stream_http", Some(status), request_id.as_deref());
        return Err(upstream_unavailable());
    }

    let protocol = provider.kind()?.protocol();
    let mut decoder = SseDecoder::default();
    let mut bytes = response.bytes_stream();
    let mut sent_done = false;
    while let Some(chunk) = bytes.next().await {
        let chunk = chunk.map_err(|_| {
            log_upstream_failure(provider, "stream_read", Some(status), None);
            upstream_unavailable()
        })?;
        let (keep, done) = emit_decoded_frames(tx, protocol, decoder.push(&chunk)).await;
        sent_done |= done;
        if !keep {
            return Ok(());
        }
    }
    let (keep, done) = emit_decoded_frames(tx, protocol, decoder.finish()).await;
    sent_done |= done;
    if !keep {
        return Ok(());
    }
    if !sent_done {
        emit(tx, "done", json!({"ok": true})).await;
    }
    Ok(())
}

#[derive(Debug)]
struct ToolCall {
    id: String,
    name: String,
    args: Value,
}

fn extract_tool_calls(provider: &ProviderRecord, response: &Value) -> Result<Vec<ToolCall>> {
    let calls = match provider.kind()?.protocol() {
        Protocol::OpenAi => response
            .pointer("/choices/0/message/tool_calls")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let id = item.get("id")?.as_str()?.to_string();
                        let name = item.pointer("/function/name")?.as_str()?.to_string();
                        let raw = item
                            .pointer("/function/arguments")
                            .and_then(Value::as_str)
                            .unwrap_or("{}");
                        let args = serde_json::from_str(raw).unwrap_or_else(|_| json!({}));
                        Some(ToolCall { id, name, args })
                    })
                    .collect()
            })
            .unwrap_or_default(),
        Protocol::Anthropic => response
            .get("content")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter(|item| item.get("type").and_then(Value::as_str) == Some("tool_use"))
                    .filter_map(|item| {
                        Some(ToolCall {
                            id: item.get("id")?.as_str()?.to_string(),
                            name: item.get("name")?.as_str()?.to_string(),
                            args: item.get("input").cloned().unwrap_or_else(|| json!({})),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
    };
    Ok(calls)
}

fn limit_tool_calls(calls: Vec<ToolCall>) -> Vec<ToolCall> {
    calls.into_iter().take(MAX_TOOL_CALLS).collect()
}

fn extract_text(provider: &ProviderRecord, response: &Value) -> Option<String> {
    match provider.kind().ok()?.protocol() {
        Protocol::OpenAi => response
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .map(str::to_string),
        Protocol::Anthropic => {
            let text = response
                .get("content")?
                .as_array()?
                .iter()
                .filter(|v| v.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|v| v.get("text").and_then(Value::as_str))
                .collect::<String>();
            (!text.is_empty()).then_some(text)
        }
    }
}

fn continuation_request_body(
    provider: &ProviderRecord,
    initial_messages: &[ChatMessage],
    response: &Value,
    results: &[(ToolCall, Value)],
) -> Result<Value> {
    let max_tokens = 2048;
    let body = match provider.kind()?.protocol() {
        Protocol::OpenAi => {
            let mut messages = serde_json::to_value(initial_messages)
                .map_err(AppError::InvalidJson)?
                .as_array()
                .cloned()
                .unwrap_or_default();
            let mut assistant =
                response
                    .pointer("/choices/0/message")
                    .cloned()
                    .ok_or_else(|| {
                        AppError::ServiceUnavailable("AI Provider 工具响应格式无效".to_string())
                    })?;
            if let Some(tool_calls) = assistant
                .get_mut("tool_calls")
                .and_then(Value::as_array_mut)
            {
                tool_calls.retain(|item| {
                    item.get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| results.iter().any(|(call, _)| call.id == id))
                });
            }
            // 原样保留 role=assistant + tool_calls，确保 tool_call_id 有协议上下文。
            messages.push(assistant);
            for (call, result) in results {
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": result.to_string()
                }));
            }
            json!({
                "model": provider.model,
                "messages": messages,
                "stream": true,
                "stream_options": {"include_usage": true},
                "max_tokens": max_tokens
            })
        }
        Protocol::Anthropic => {
            let system = initial_messages
                .iter()
                .filter(|m| m.role == "system")
                .map(|m| m.content.as_str())
                .collect::<Vec<_>>()
                .join("\n\n");
            let mut messages: Vec<Value> = initial_messages
                .iter()
                .filter(|m| m.role != "system")
                .map(|m| json!({"role": m.role, "content": m.content}))
                .collect();
            let mut assistant_content = response.get("content").cloned().ok_or_else(|| {
                AppError::ServiceUnavailable("AI Provider 工具响应格式无效".to_string())
            })?;
            if let Some(blocks) = assistant_content.as_array_mut() {
                blocks.retain(|block| {
                    block.get("type").and_then(Value::as_str) != Some("tool_use")
                        || block
                            .get("id")
                            .and_then(Value::as_str)
                            .is_some_and(|id| results.iter().any(|(call, _)| call.id == id))
                });
            }
            // 原样保留 assistant 的 tool_use content blocks。
            messages.push(json!({"role": "assistant", "content": assistant_content}));
            let tool_results: Vec<Value> = results
                .iter()
                .map(|(call, result)| {
                    json!({
                        "type": "tool_result",
                        "tool_use_id": call.id,
                        "content": result.to_string()
                    })
                })
                .collect();
            messages.push(json!({"role": "user", "content": tool_results}));
            let mut body = json!({
                "model": provider.model,
                "messages": messages,
                "stream": true,
                "max_tokens": max_tokens
            });
            if !system.is_empty() {
                body["system"] = json!(system);
            }
            body
        }
    };
    Ok(body)
}

async fn run_chat(
    tx: mpsc::Sender<std::result::Result<Event, Infallible>>,
    pool: PgPool,
    tenant_id: i32,
    provider: ProviderRecord,
    messages: Vec<ChatMessage>,
    tools_enabled: bool,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
) {
    let result: Result<()> = async {
        let api_key = crypto::decrypt_secret(&provider.api_key_enc)?;
        let client = client_for_provider(&provider).await?;
        emit(
            &tx,
            "meta",
            json!({
                "provider_id": provider.id,
                "provider": provider.provider,
                "model": provider.model,
                "tools_enabled": tools_enabled
            }),
        )
        .await;

        if tools_enabled {
            // 首轮非流式只用于判断是否调用工具；最多执行一次、最多四个并发意图，
            // 第二轮不再注入 tools，从协议层杜绝递归写调用。
            let first_body =
                request_body(&provider, &messages, false, true, max_tokens, temperature)?;
            let first = send_json(&client, &provider, &api_key, &first_body).await?;
            let calls = extract_tool_calls(&provider, &first)?;
            if calls.is_empty() {
                if let Some(text) = extract_text(&provider, &first) {
                    emit(&tx, "delta", json!({"text": text})).await;
                }
                if let Some(usage) = first.get("usage") {
                    emit(&tx, "usage", usage.clone()).await;
                }
                emit(&tx, "done", json!({"ok": true})).await;
                return Ok(());
            }

            let mut results = Vec::new();
            for call in limit_tool_calls(calls) {
                let value = execute_readonly_tool(&pool, tenant_id, &call.name, &call.args).await?;
                emit(
                    &tx,
                    "tool",
                    json!({"id": call.id, "name": call.name, "arguments": call.args, "result": value}),
                )
                .await;
                results.push((call, value));
            }
            let mut body = continuation_request_body(&provider, &messages, &first, &results)?;
            body["max_tokens"] = json!(max_tokens.unwrap_or(2048));
            if let Some(t) = temperature {
                body["temperature"] = json!(t);
            }
            return stream_provider(&tx, &client, &provider, &api_key, body).await;
        }

        let body = request_body(
            &provider,
            &messages,
            true,
            false,
            max_tokens,
            temperature,
        )?;
        stream_provider(&tx, &client, &provider, &api_key, body).await
    }
    .await;

    if result.is_err() {
        tracing::warn!(
            tenant_id,
            provider_id = provider.id,
            provider = %provider.provider,
            model = %provider.model,
            "AI chat failed（错误详情已脱敏）"
        );
        emit(&tx, "error", json!({"message": SAFE_UPSTREAM_MESSAGE})).await;
    }
}

pub async fn chat(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
    Json(req): Json<ChatRequest>,
) -> Result<Sse<impl Stream<Item = std::result::Result<Event, Infallible>>>> {
    permissions::require_tenant_member(&pool, &claims, project_id).await?;
    validate_messages(&req.messages)?;
    if let Some(t) = req.temperature {
        if !(0.0..=2.0).contains(&t) {
            return Err(AppError::InvalidQuery(
                "temperature 必须在 0..=2 之间".to_string(),
            ));
        }
    }
    let provider = resolve_provider(&pool, project_id, req.provider_id).await?;
    let (tx, rx) = mpsc::channel(64);
    tokio::spawn(run_chat(
        tx,
        pool,
        project_id,
        provider,
        req.messages,
        req.tools_enabled.unwrap_or(true),
        req.max_tokens.map(|v| v.clamp(1, 16_384)),
        req.temperature,
    ));
    let stream = futures::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    });
    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(kind: &str) -> ProviderRecord {
        ProviderRecord {
            id: 1,
            tenant_id: 2,
            provider: kind.to_string(),
            name: "测试".to_string(),
            base_url: "https://example.com/v1".to_string(),
            model: "model".to_string(),
            api_key_enc: "v2:TOP_SECRET_CIPHERTEXT".to_string(),
            is_active: true,
            is_default: true,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        }
    }

    #[test]
    fn provider_protocol_mapping_covers_qwen() {
        assert_eq!(ProviderKind::Openai.protocol(), Protocol::OpenAi);
        assert_eq!(ProviderKind::Qwen.protocol(), Protocol::OpenAi);
        assert_eq!(ProviderKind::Anthropic.protocol(), Protocol::Anthropic);
        assert!(ProviderKind::Qwen
            .default_base_url()
            .contains("compatible-mode/v1"));
    }

    #[test]
    fn ai_credentials_only_allow_interactive_jwt() {
        assert!(require_interactive_credential(true, false, false).is_ok());
        assert!(matches!(
            require_interactive_credential(true, true, false),
            Err(AppError::Forbidden(_))
        ));
        assert!(matches!(
            require_interactive_credential(true, false, true),
            Err(AppError::Forbidden(_))
        ));
        assert!(matches!(
            require_interactive_credential(false, false, false),
            Err(AppError::Unauthorized(_))
        ));
    }

    #[test]
    fn main_ai_route_layers_run_auth_then_guard_then_license() {
        let main = include_str!("../main.rs");
        let config_start = main.find("let ai_config_routes").unwrap();
        let chat_start = main.find("let ai_chat_routes").unwrap();
        let routes_end = main[chat_start..]
            .find("// 工作流 Endpoint")
            .map(|offset| chat_start + offset)
            .unwrap();
        for block in [
            &main[config_start..chat_start],
            &main[chat_start..routes_end],
        ] {
            // Axum 的后添加 layer 先执行，因此源码必须是 license -> guard -> auth。
            let license = block.find("onebase::license::require_module").unwrap();
            let guard = block.find("ai::interactive_jwt_guard").unwrap();
            let auth = block.find("middleware::auth_middleware").unwrap();
            assert!(license < guard && guard < auth);
        }
    }

    #[test]
    fn public_provider_never_contains_secret() {
        let value = record("openai").public_json();
        let encoded = value.to_string();
        assert!(!encoded.contains("api_key_enc"));
        assert!(!encoded.contains("TOP_SECRET"));
        assert_eq!(value["api_key_configured"], true);
        assert_eq!(value["is_active"], true);
    }

    #[test]
    fn provider_active_default_state_rules() {
        // 首个 active 项即使未显式设默认，也必须成为默认。
        assert!(desired_default_state(true, false, None, false).unwrap());
        // 已有其它 active default 时，新启用项保持非默认。
        assert!(!desired_default_state(true, false, None, true).unwrap());
        // 显式设默认会切换默认项。
        assert!(desired_default_state(true, false, Some(true), true).unwrap());
        // 显式取消唯一 active default 时仍维持它为默认。
        assert!(desired_default_state(true, true, Some(false), false).unwrap());
        // 有替代项时允许取消当前默认。
        assert!(!desired_default_state(true, true, Some(false), true).unwrap());
        // 停用项绝不保留默认，且不能同时请求设默认。
        assert!(!desired_default_state(false, true, None, false).unwrap());
        assert!(desired_default_state(false, true, Some(true), false).is_err());
    }

    #[test]
    fn nullable_project_database_slug_is_safe() {
        assert_eq!(nullable_slug_value(None), Value::Null);
        assert_eq!(
            nullable_slug_value(Some("primary".to_string())),
            json!("primary")
        );
    }

    #[test]
    fn sse_decoder_handles_split_frames_and_crlf() {
        let mut decoder = SseDecoder::default();
        assert!(decoder.push(b"event: message\r\nda").is_empty());
        let frames = decoder.push(b"ta: {\"ok\":true}\r\n\r\n");
        assert_eq!(frames.len(), 1);
        let (event, data) = frames[0].as_ref().unwrap();
        assert_eq!(event.as_deref(), Some("message"));
        assert_eq!(data, "{\"ok\":true}");
    }

    #[test]
    fn sse_decoder_preserves_split_utf8_and_tail_frame() {
        let frame = "event: message\ndata: {\"text\":\"你好👋\"}\n\n";
        let bytes = frame.as_bytes();
        let emoji = bytes
            .windows("👋".len())
            .position(|part| part == "👋".as_bytes())
            .unwrap();
        let mut decoder = SseDecoder::default();
        assert!(decoder.push(&bytes[..emoji + 1]).is_empty());
        let frames = decoder.push(&bytes[emoji + 1..]);
        assert_eq!(frames[0].as_ref().unwrap().1, "{\"text\":\"你好👋\"}");

        let mut tail = SseDecoder::default();
        assert!(tail.push("data: 结尾🙂".as_bytes()).is_empty());
        assert_eq!(tail.finish()[0].as_ref().unwrap().1, "结尾🙂");
    }

    #[test]
    fn parses_openai_delta_usage_done_and_error() {
        assert_eq!(
            parse_openai_sse(
                None,
                r#"{"choices":[{"delta":{"content":"你好"}}],"usage":null}"#
            ),
            vec![ParsedEvent::Delta("你好".to_string())]
        );
        assert!(matches!(
            parse_openai_sse(None, r#"{"choices":[],"usage":{"total_tokens":3}}"#)[0],
            ParsedEvent::Usage(_)
        ));
        assert_eq!(parse_openai_sse(None, "[DONE]"), vec![ParsedEvent::Done]);
        assert_eq!(
            parse_openai_sse(None, r#"{"error":{"message":"secret upstream body"}}"#),
            vec![ParsedEvent::Error(SAFE_UPSTREAM_MESSAGE.to_string())]
        );
    }

    #[test]
    fn parses_anthropic_delta_usage_done_and_error() {
        assert_eq!(
            parse_anthropic_sse(
                Some("content_block_delta"),
                r#"{"delta":{"type":"text_delta","text":"hi"}}"#
            ),
            vec![ParsedEvent::Delta("hi".to_string())]
        );
        assert!(matches!(
            parse_anthropic_sse(Some("message_delta"), r#"{"usage":{"output_tokens":2}}"#)[0],
            ParsedEvent::Usage(_)
        ));
        assert_eq!(
            parse_anthropic_sse(Some("message_stop"), "{}"),
            vec![ParsedEvent::Done]
        );
        assert_eq!(
            parse_anthropic_sse(
                Some("error"),
                r#"{"error":{"message":"secret upstream body"}}"#
            ),
            vec![ParsedEvent::Error(SAFE_UPSTREAM_MESSAGE.to_string())]
        );
    }

    #[tokio::test]
    async fn upstream_sse_error_stops_without_success_done() {
        let error = ParsedEvent::Error(SAFE_UPSTREAM_MESSAGE.to_string());
        assert_eq!(stream_control(&error), StreamControl::Failed);

        let (tx, _rx) = mpsc::channel(4);
        let frames = vec![Ok((
            None,
            r#"{"error":{"message":"must not escape"}}"#.to_string(),
        ))];
        let (keep_streaming, sent_success_done) =
            emit_decoded_frames(&tx, Protocol::OpenAi, frames).await;
        assert!(!keep_streaming);
        assert!(!sent_success_done);
    }

    #[test]
    fn upstream_error_metadata_is_safely_filtered() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("x-request-id", "req_safe-123".parse().unwrap());
        assert_eq!(safe_request_id(&headers).as_deref(), Some("req_safe-123"));
        headers.insert("x-request-id", "unsafe value with spaces".parse().unwrap());
        assert_eq!(safe_request_id(&headers), None);
        assert!(!SAFE_UPSTREAM_MESSAGE.contains("body"));
        let message = upstream_unavailable().to_string();
        assert!(message.ends_with(SAFE_UPSTREAM_MESSAGE));
        assert!(!message.contains("secret upstream body"));
    }

    #[test]
    fn readonly_tool_allowlist_rejects_writes() {
        for name in READ_ONLY_TOOLS {
            assert!(tool_allowed(name));
        }
        for name in [
            "create_workflow",
            "update_workflow",
            "delete_workflow",
            "run_workflow",
            "execute_sql",
        ] {
            assert!(!tool_allowed(name), "{name} 不能进入 AI 工具白名单");
        }
        let schemas = openai_tool_schemas().to_string();
        assert!(!schemas.contains("create_"));
        assert!(!schemas.contains("update_"));
        assert!(!schemas.contains("delete_"));
        assert!(!schemas.contains("run_"));
    }

    #[test]
    fn request_mapping_uses_provider_specific_shapes() {
        let messages = vec![ChatMessage {
            role: "user".to_string(),
            content: "hello".to_string(),
        }];
        let openai = request_body(&record("qwen"), &messages, true, true, None, None).unwrap();
        assert!(openai.get("tools").is_some());
        assert_eq!(openai["stream"], true);
        assert!(openai.get("system").is_none());

        let anthropic =
            request_body(&record("anthropic"), &messages, false, true, None, None).unwrap();
        assert!(anthropic.get("tools").is_some());
        assert!(anthropic.get("messages").is_some());
        assert!(anthropic.get("stream_options").is_none());
    }

    #[test]
    fn tool_continuation_uses_native_provider_protocols() {
        let messages = vec![ChatMessage {
            role: "user".to_string(),
            content: "查看工作流".to_string(),
        }];
        let calls = vec![(
            ToolCall {
                id: "call_1".to_string(),
                name: "list_workflows".to_string(),
                args: json!({}),
            },
            json!({"workflows":[]}),
        )];

        let openai_first = json!({
            "choices": [{"message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [{"id":"call_1","type":"function","function":{
                    "name":"list_workflows","arguments":"{}"
                }}]
            }}]
        });
        let openai =
            continuation_request_body(&record("qwen"), &messages, &openai_first, &calls).unwrap();
        let openai_messages = openai["messages"].as_array().unwrap();
        assert!(openai_messages[1].get("tool_calls").is_some());
        assert_eq!(openai_messages[2]["role"], "tool");
        assert_eq!(openai_messages[2]["tool_call_id"], "call_1");
        assert!(openai.get("tools").is_none());

        let anthropic_first = json!({
            "content": [
                {"type":"text","text":"我来查询。"},
                {"type":"tool_use","id":"call_1","name":"list_workflows","input":{}}
            ]
        });
        let anthropic =
            continuation_request_body(&record("anthropic"), &messages, &anthropic_first, &calls)
                .unwrap();
        let anthropic_messages = anthropic["messages"].as_array().unwrap();
        assert_eq!(anthropic_messages[1]["role"], "assistant");
        assert_eq!(anthropic_messages[1]["content"][1]["type"], "tool_use");
        assert_eq!(anthropic_messages[2]["role"], "user");
        assert_eq!(anthropic_messages[2]["content"][0]["type"], "tool_result");
        assert_eq!(anthropic_messages[2]["content"][0]["tool_use_id"], "call_1");
        assert!(anthropic.get("tools").is_none());
    }

    #[test]
    fn tool_calls_are_limited_to_four() {
        let calls = (0..5)
            .map(|index| ToolCall {
                id: format!("call_{index}"),
                name: "list_workflows".to_string(),
                args: json!({}),
            })
            .collect();
        let limited = limit_tool_calls(calls);
        assert_eq!(limited.len(), MAX_TOOL_CALLS);
        assert_eq!(limited.last().unwrap().id, "call_3");
    }

    #[test]
    fn migration_enforces_default_must_be_active() {
        let sql = include_str!("../../migrations/062_ai_providers.sql");
        assert!(sql.contains("ADD COLUMN IF NOT EXISTS is_active"));
        assert!(sql.contains("WHERE is_active = false AND is_default = true"));
        assert!(sql.contains("missing_defaults"));
        assert!(sql.contains("FROM pg_constraint"));
        assert!(sql.contains("CHECK (NOT is_default OR is_active)"));
        assert!(sql.contains("DROP INDEX IF EXISTS management.uq_ai_providers_one_default"));
        assert!(sql.contains("WHERE is_active = true AND is_default = true"));
    }
}
