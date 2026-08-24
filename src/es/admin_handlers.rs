//! ES 连接 + 代理 token 的管理端 API。
//!
//! 鉴权与 scheduler 一致：超管 / 该租户 owner-admin。
//! 凭据明文从不出 handler 边界：
//!   - `auth_credential_enc` 在 `EsConnection` 上已 `#[serde(skip_serializing)]`
//!   - `token_hash` 同上
//!   - 仅 `create_token` 一处把刚生成的明文 token 返回给前端"一次性显示"
//!
//! 路由：
//! ```
//! GET    /api/admin/es-connections
//! POST   /api/admin/es-connections
//! GET    /api/admin/es-connections/:id
//! PUT    /api/admin/es-connections/:id
//! DELETE /api/admin/es-connections/:id
//! POST   /api/admin/es-connections/:id/health
//!
//! GET    /api/admin/es-connections/:id/tokens
//! POST   /api/admin/es-connections/:id/tokens
//! PATCH  /api/admin/es-connections/:id/tokens/:token_id
//! DELETE /api/admin/es-connections/:id/tokens/:token_id
//! ```

use axum::{
    extract::{Extension, Path, Query, State},
    Json,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::audit_handlers;
use crate::auth::Claims;
use crate::crypto;
use crate::error::AppError;
use crate::es::auth as es_auth;
use crate::es::models::{EsAccessToken, EsConnection};

// ── 校验 helper ─────────────────────────────────────────────────────────

/// 超管 / 该租户 owner-admin 才能操作。与 `scheduler_handlers::validate_can_manage`
/// 同款语义；这里的 `tenant_id` 是 ES 连接所属租户（**不可为 NULL**，每个 ES 必有
/// 归属，没有"平台级 ES"概念 —— 这与 shell 任务不同）。
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
            "仅超管或该租户 owner/admin 可管理 ES 连接".to_string(),
        ))
    }
}

/// 取连接行或返回 NotFound。同时校验当前用户能管理这个租户。
async fn fetch_connection_authorized(
    pool: &PgPool,
    claims: &Claims,
    id: i64,
) -> Result<EsConnection, AppError> {
    let conn =
        sqlx::query_as::<_, EsConnection>("SELECT * FROM management.es_connections WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await
            .map_err(|e| AppError::Internal(format!("查询 ES 连接失败: {e}")))?
            .ok_or_else(|| AppError::NotFound(format!("ES 连接 {} 不存在", id)))?;
    require_tenant_admin(pool, claims, conn.tenant_id).await?;
    Ok(conn)
}

// ── DTO ────────────────────────────────────────────────────────────────

/// 列表查询参数。
#[derive(Debug, Deserialize)]
pub struct ListConnectionsQuery {
    /// 按项目过滤。工作空间页必须传；未传时超管看全平台，非超管看其全部管辖租户。
    pub tenant_id: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct CreateConnectionReq {
    pub tenant_id: i32,
    pub connection_name: String,
    pub base_url: String,
    /// `api_key` / `basic` / `none`
    pub auth_type: String,
    /// 明文凭据：api_key 模式直接是 base64 后的 id:api_key；basic 模式是 user:pass；
    /// none 模式必须留空 / null。
    pub credential: Option<String>,
    pub verify_tls: Option<bool>,
    pub default_timeout_secs: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateConnectionReq {
    pub connection_name: Option<String>,
    pub base_url: Option<String>,
    pub auth_type: Option<String>,
    /// **如果传 null** = 保留原凭据；**如果传非空字符串** = 替换为新凭据；
    /// 如果想清空（只在 auth_type='none' 时有意义），传空字符串 ""。
    pub credential: Option<String>,
    pub verify_tls: Option<bool>,
    pub default_timeout_secs: Option<i32>,
    pub is_active: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct CreateTokenReq {
    pub name: String,
    pub description: Option<String>,
    pub allowed_methods: Option<Vec<String>>,
    pub index_allowlist: Option<Vec<String>>,
    pub path_denylist: Option<Vec<String>>,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateTokenReq {
    pub name: Option<String>,
    pub description: Option<String>,
    pub allowed_methods: Option<Vec<String>>,
    pub index_allowlist: Option<Vec<String>>,
    pub path_denylist: Option<Vec<String>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub is_active: Option<bool>,
}

// ── Connection CRUD ────────────────────────────────────────────────────

pub async fn list_connections(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(q): Query<ListConnectionsQuery>,
) -> Result<Json<Vec<EsConnection>>, AppError> {
    // 与 webhook / sse-routes 一致：显式 tenant_id 必须生效，避免多项目 admin
    // 在项目 A 看到项目 B 的连接与代理 token。
    let admins = if claims.is_superadmin {
        Vec::new()
    } else {
        audit_handlers::admin_tenant_ids(&pool, &claims).await?
    };
    let filter =
        crate::permissions::resolve_tenant_list_filter(claims.is_superadmin, q.tenant_id, &admins)?;
    let rows = match filter {
        crate::permissions::TenantListFilter::One(t) => {
            sqlx::query_as::<_, EsConnection>(
                "SELECT * FROM management.es_connections WHERE tenant_id = $1 ORDER BY id DESC",
            )
            .bind(t)
            .fetch_all(&pool)
            .await
        }
        crate::permissions::TenantListFilter::All => {
            sqlx::query_as::<_, EsConnection>(
                "SELECT * FROM management.es_connections ORDER BY id DESC",
            )
            .fetch_all(&pool)
            .await
        }
        crate::permissions::TenantListFilter::Many(ids) => {
            if ids.is_empty() {
                return Ok(Json(vec![]));
            }
            sqlx::query_as::<_, EsConnection>(
                "SELECT * FROM management.es_connections WHERE tenant_id = ANY($1) ORDER BY id DESC",
            )
            .bind(&ids)
            .fetch_all(&pool)
            .await
        }
    }
    .map_err(|e| AppError::Internal(format!("列出 ES 连接失败: {e}")))?;
    Ok(Json(rows))
}

pub async fn get_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<EsConnection>, AppError> {
    let conn = fetch_connection_authorized(&pool, &claims, id).await?;
    Ok(Json(conn))
}

pub async fn create_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<CreateConnectionReq>,
) -> Result<Json<EsConnection>, AppError> {
    require_tenant_admin(&pool, &claims, req.tenant_id).await?;

    validate_auth_type(&req.auth_type)?;
    let credential_enc = encrypt_credential(&req.auth_type, req.credential.as_deref())?;
    validate_base_url(&req.base_url)?;

    let row = sqlx::query_as::<_, EsConnection>(
        "INSERT INTO management.es_connections \
            (tenant_id, connection_name, base_url, auth_type, auth_credential_enc, \
             verify_tls, default_timeout_secs, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *",
    )
    .bind(req.tenant_id)
    .bind(req.connection_name.trim())
    .bind(req.base_url.trim())
    .bind(&req.auth_type)
    .bind(credential_enc)
    .bind(req.verify_tls.unwrap_or(true))
    .bind(req.default_timeout_secs.unwrap_or(30))
    .bind(claims.sub)
    .fetch_one(&pool)
    .await
    .map_err(|e| map_unique_violation(e, "同名 ES 连接已存在"))?;

    Ok(Json(row))
}

pub async fn update_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateConnectionReq>,
) -> Result<Json<EsConnection>, AppError> {
    let existing = fetch_connection_authorized(&pool, &claims, id).await?;

    // 决定最终 auth_type 与 credential 之间的关系。
    //   - auth_type 未传：沿用原值；credential 传了就加密入库
    //   - auth_type 传了 'none'：必须把 credential 清成 NULL（不论用户是否传）
    //   - auth_type 传了 'api_key'/'basic'：credential 必填（除非沿用原 enc）
    let final_auth_type = req
        .auth_type
        .as_deref()
        .unwrap_or(&existing.auth_type)
        .to_string();
    validate_auth_type(&final_auth_type)?;

    let final_credential_enc: Option<String> =
        match (req.credential.as_deref(), final_auth_type.as_str()) {
            // 切到 'none' → 永远清空
            (_, "none") => None,
            // 没传 credential 且 auth_type 没变 → 保留原 enc
            (None, t) if t == existing.auth_type => existing.auth_credential_enc.clone(),
            // 切了 auth_type 但没给新 credential → 拒绝（防止用旧 ApiKey 当 Basic user:pass 解析）
            (None, _) => {
                return Err(AppError::InvalidQuery(
                    "切换 auth_type 时必须同时提供新的 credential".to_string(),
                ));
            }
            // 给了非空 credential → 重新加密
            (Some(s), _) if !s.is_empty() => Some(crypto::encrypt_secret(s)?),
            // 给了空串但 auth_type 不是 none → 拒
            (Some(_), _) => {
                return Err(AppError::InvalidQuery(format!(
                    "auth_type={} 必须提供非空 credential",
                    final_auth_type
                )));
            }
        };

    if let Some(url) = req.base_url.as_deref() {
        validate_base_url(url)?;
    }

    let row = sqlx::query_as::<_, EsConnection>(
        "UPDATE management.es_connections SET \
            connection_name = COALESCE($1, connection_name), \
            base_url = COALESCE($2, base_url), \
            auth_type = $3, \
            auth_credential_enc = $4, \
            verify_tls = COALESCE($5, verify_tls), \
            default_timeout_secs = COALESCE($6, default_timeout_secs), \
            is_active = COALESCE($7, is_active), \
            updated_at = NOW() \
         WHERE id = $8 RETURNING *",
    )
    .bind(req.connection_name.as_deref().map(|s| s.trim()))
    .bind(req.base_url.as_deref().map(|s| s.trim()))
    .bind(&final_auth_type)
    .bind(final_credential_enc)
    .bind(req.verify_tls)
    .bind(req.default_timeout_secs)
    .bind(req.is_active)
    .bind(id)
    .fetch_one(&pool)
    .await
    .map_err(|e| map_unique_violation(e, "同名 ES 连接已存在"))?;

    Ok(Json(row))
}

pub async fn delete_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    let _ = fetch_connection_authorized(&pool, &claims, id).await?;
    let res = sqlx::query("DELETE FROM management.es_connections WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .map_err(|e| AppError::Internal(format!("删除 ES 连接失败: {e}")))?;
    // CASCADE 会级联清掉 es_access_tokens；不需要单独 DELETE。
    Ok(Json(json!({"deleted": res.rows_affected()})))
}

// ── 探活 ────────────────────────────────────────────────────────────────

/// 对上游 ES 跑一次 `GET /` 校验 base_url + 凭据。
///
/// **不复用 proxy_handler 的 http client cache**（探活频率低，且要带 `default_timeout_secs`
/// 而非 token 级 timeout）；这里临时建一个 `reqwest::Client`，跑完即丢。
pub async fn health_check(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    let conn = fetch_connection_authorized(&pool, &claims, id).await?;

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(!conn.verify_tls)
        .timeout(std::time::Duration::from_secs(
            conn.default_timeout_secs.clamp(1, 60) as u64,
        ))
        .build()
        .map_err(|e| AppError::Internal(format!("构造 reqwest client 失败: {e}")))?;

    // base_url 末尾可能带 /，统一去掉
    let url = format!("{}/", conn.base_url.trim_end_matches('/'));
    let mut req = client.get(&url);
    if let Some(header) = build_auth_header(&conn)
        .map_err(|e| AppError::Internal(format!("解密 ES 凭据失败: {e}")))?
    {
        req = req.header("authorization", header);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| AppError::ServiceUnavailable(format!("无法访问 ES: {e}")))?;

    let status = resp.status();
    let body_text = resp.text().await.unwrap_or_default();
    let body_json: Value = serde_json::from_str(&body_text).unwrap_or(Value::Null);

    Ok(Json(json!({
        "status_code": status.as_u16(),
        "ok": status.is_success(),
        // ES root response 一般含 { "name", "cluster_name", "version": { "number": ... } }
        "cluster_name": body_json.get("cluster_name").cloned().unwrap_or(Value::Null),
        "version": body_json.get("version").cloned().unwrap_or(Value::Null),
        "raw": if status.is_success() { Value::Null } else { Value::String(body_text) },
    })))
}

// ── Token CRUD ─────────────────────────────────────────────────────────

pub async fn list_tokens(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(connection_id): Path<i64>,
) -> Result<Json<Vec<EsAccessToken>>, AppError> {
    let _ = fetch_connection_authorized(&pool, &claims, connection_id).await?;
    let rows = sqlx::query_as::<_, EsAccessToken>(
        "SELECT * FROM management.es_access_tokens \
         WHERE connection_id = $1 ORDER BY id DESC",
    )
    .bind(connection_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("列出 token 失败: {e}")))?;
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
    let methods = req.allowed_methods.unwrap_or_else(default_methods);
    validate_methods(&methods)?;
    let allowlist = req.index_allowlist.unwrap_or_else(|| vec!["*".to_string()]);
    if allowlist.is_empty() {
        return Err(AppError::InvalidQuery(
            "index_allowlist 至少要有一项（用 [\"*\"] 表示不限）".to_string(),
        ));
    }
    let denylist = req.path_denylist.unwrap_or_else(default_path_denylist);
    validate_regex_list(&denylist)?;

    // 生成明文 + hash + prefix
    let plain = es_auth::generate_token();
    let hash = es_auth::hash_token(&plain);
    let prefix = es_auth::token_prefix(&plain);

    let row = sqlx::query_as::<_, EsAccessToken>(
        "INSERT INTO management.es_access_tokens \
            (connection_id, name, description, token_hash, token_prefix, \
             allowed_methods, index_allowlist, path_denylist, expires_at, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *",
    )
    .bind(connection_id)
    .bind(req.name.trim())
    .bind(req.description.as_deref().map(|s| s.trim()))
    .bind(&hash)
    .bind(&prefix)
    .bind(&methods)
    .bind(&allowlist)
    .bind(&denylist)
    .bind(req.expires_at)
    .bind(claims.sub)
    .fetch_one(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("创建 token 失败: {e}")))?;

    // **明文 token 仅此一次** 出现在响应里；前端必须立刻让用户复制保存。
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
) -> Result<Json<EsAccessToken>, AppError> {
    let _ = fetch_connection_authorized(&pool, &claims, connection_id).await?;

    if let Some(m) = &req.allowed_methods {
        validate_methods(m)?;
    }
    if let Some(d) = &req.path_denylist {
        validate_regex_list(d)?;
    }
    if let Some(a) = &req.index_allowlist {
        if a.is_empty() {
            return Err(AppError::InvalidQuery(
                "index_allowlist 至少要有一项".to_string(),
            ));
        }
    }

    let row = sqlx::query_as::<_, EsAccessToken>(
        "UPDATE management.es_access_tokens SET \
            name = COALESCE($1, name), \
            description = COALESCE($2, description), \
            allowed_methods = COALESCE($3, allowed_methods), \
            index_allowlist = COALESCE($4, index_allowlist), \
            path_denylist = COALESCE($5, path_denylist), \
            expires_at = COALESCE($6, expires_at), \
            is_active = COALESCE($7, is_active) \
         WHERE id = $8 AND connection_id = $9 RETURNING *",
    )
    .bind(req.name.as_deref().map(|s| s.trim()))
    .bind(req.description.as_deref().map(|s| s.trim()))
    .bind(req.allowed_methods.as_ref())
    .bind(req.index_allowlist.as_ref())
    .bind(req.path_denylist.as_ref())
    .bind(req.expires_at)
    .bind(req.is_active)
    .bind(token_id)
    .bind(connection_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("更新 token 失败: {e}")))?
    .ok_or_else(|| AppError::NotFound(format!("token {} 不存在", token_id)))?;
    Ok(Json(row))
}

pub async fn delete_token(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((connection_id, token_id)): Path<(i64, i64)>,
) -> Result<Json<Value>, AppError> {
    let _ = fetch_connection_authorized(&pool, &claims, connection_id).await?;
    let res =
        sqlx::query("DELETE FROM management.es_access_tokens WHERE id = $1 AND connection_id = $2")
            .bind(token_id)
            .bind(connection_id)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("删除 token 失败: {e}")))?;
    Ok(Json(json!({"deleted": res.rows_affected()})))
}

// ── 内部 helpers ────────────────────────────────────────────────────────

fn validate_auth_type(t: &str) -> Result<(), AppError> {
    match t {
        "api_key" | "basic" | "none" => Ok(()),
        other => Err(AppError::InvalidQuery(format!(
            "非法 auth_type: {} （支持 api_key / basic / none）",
            other
        ))),
    }
}

fn validate_base_url(url: &str) -> Result<(), AppError> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err(AppError::InvalidQuery(
            "base_url 必须以 http:// 或 https:// 开头".to_string(),
        ));
    }
    if trimmed.contains(' ') || trimmed.contains('\n') {
        return Err(AppError::InvalidQuery("base_url 含非法字符".to_string()));
    }
    Ok(())
}

fn encrypt_credential(
    auth_type: &str,
    credential: Option<&str>,
) -> Result<Option<String>, AppError> {
    match (auth_type, credential) {
        ("none", _) => Ok(None),
        (_, None) | (_, Some("")) => Err(AppError::InvalidQuery(format!(
            "auth_type={} 必须提供非空 credential",
            auth_type
        ))),
        (_, Some(s)) => Ok(Some(crypto::encrypt_secret(s)?)),
    }
}

/// 解密凭据并返回拼好的 `Authorization` header value。`auth_type='none'` 返回 None。
pub(crate) fn build_auth_header(conn: &EsConnection) -> Result<Option<String>, AppError> {
    match conn.auth_type.as_str() {
        "none" => Ok(None),
        kind => {
            let enc = conn.auth_credential_enc.as_deref().ok_or_else(|| {
                AppError::Internal(format!(
                    "ES 连接 {} 的 auth_type={} 但凭据为空（DB CHECK 应已防止此情况）",
                    conn.id, kind
                ))
            })?;
            let plain = crypto::decrypt_secret(enc)?;
            match kind {
                "api_key" => Ok(Some(format!("ApiKey {}", plain))),
                "basic" => {
                    // 用户输入 `user:pass` → base64 → Authorization: Basic <b64>
                    use base64::Engine as _;
                    let encoded =
                        base64::engine::general_purpose::STANDARD.encode(plain.as_bytes());
                    Ok(Some(format!("Basic {}", encoded)))
                }
                other => Err(AppError::Internal(format!(
                    "未知 auth_type: {}（DB CHECK 漏了？）",
                    other
                ))),
            }
        }
    }
}

fn default_methods() -> Vec<String> {
    vec!["GET".to_string(), "HEAD".to_string(), "POST".to_string()]
}

fn default_path_denylist() -> Vec<String> {
    vec![
        "^/?_cluster(/.*)?$".to_string(),
        "^/?_security(/.*)?$".to_string(),
        "^/?_ilm(/.*)?$".to_string(),
        "^/?_snapshot(/.*)?$".to_string(),
        "^/?_shutdown(/.*)?$".to_string(),
        "^/?_nodes/.*/(reload_secure_settings|shutdown)$".to_string(),
    ]
}

fn validate_methods(methods: &[String]) -> Result<(), AppError> {
    const VALID: &[&str] = &["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH", "OPTIONS"];
    if methods.is_empty() {
        return Err(AppError::InvalidQuery(
            "allowed_methods 不能为空".to_string(),
        ));
    }
    for m in methods {
        let upper = m.to_uppercase();
        if !VALID.contains(&upper.as_str()) {
            return Err(AppError::InvalidQuery(format!(
                "非法 HTTP method: {}（允许 {:?}）",
                m, VALID
            )));
        }
    }
    Ok(())
}

fn validate_regex_list(patterns: &[String]) -> Result<(), AppError> {
    for p in patterns {
        if p.is_empty() {
            return Err(AppError::InvalidQuery(
                "path_denylist 不能含空字符串".to_string(),
            ));
        }
        regex::Regex::new(p).map_err(|e| {
            AppError::InvalidQuery(format!("path_denylist 含非法正则 `{}`: {}", p, e))
        })?;
    }
    Ok(())
}

fn map_unique_violation(e: sqlx::Error, msg: &str) -> AppError {
    if let sqlx::Error::Database(ref db_err) = e {
        if db_err.code().as_deref() == Some("23505") {
            return AppError::InvalidQuery(msg.to_string());
        }
    }
    AppError::Internal(format!("DB 错误: {e}"))
}
