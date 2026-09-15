//! LLM 连接管理 API（bin-only）。
//!
//! 鉴权对齐 Redis：超管 / 该租户 owner-admin 才能 CRUD 与探活。
//! 列表按 `resolve_tenant_list_filter` 过滤。表内无密钥。

use axum::{
    extract::{Extension, Path, Query, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::audit_handlers;
use crate::auth::Claims;
use crate::error::AppError;
use crate::llm_ds::models::LlmConnection;
use crate::permissions;
use crate::workflow_credentials::{apply_http_auth_headers, load_credential_store};
use crate::workflow_llm::{models_url, normalize_base_url, normalize_models};

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
            "仅超管或该租户 owner/admin 可管理 LLM 连接".to_string(),
        ))
    }
}

async fn fetch_connection_authorized(
    pool: &PgPool,
    claims: &Claims,
    id: i64,
) -> Result<LlmConnection, AppError> {
    let conn = sqlx::query_as::<_, LlmConnection>(
        "SELECT * FROM management.llm_connections WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询 LLM 连接失败: {e}")))?
    .ok_or_else(|| AppError::NotFound(format!("LLM 连接 {id} 不存在")))?;
    require_tenant_admin(pool, claims, conn.tenant_id).await?;
    Ok(conn)
}

#[derive(Debug, Deserialize)]
pub struct ListConnectionsQuery {
    pub tenant_id: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct CreateConnectionReq {
    pub tenant_id: i32,
    pub connection_name: String,
    pub base_url: String,
    pub credential_id: Option<i32>,
    pub models: Option<Vec<String>>,
    pub is_active: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateConnectionReq {
    pub connection_name: Option<String>,
    pub base_url: Option<String>,
    #[serde(default)]
    pub credential_id: Option<Option<i32>>,
    pub models: Option<Vec<String>>,
    pub is_active: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct TestConnectionReq {
    pub tenant_id: i32,
    pub base_url: String,
    pub credential_id: Option<i32>,
}

pub async fn list_connections(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(q): Query<ListConnectionsQuery>,
) -> Result<Json<Vec<LlmConnection>>, AppError> {
    let admins = if claims.is_superadmin {
        Vec::new()
    } else {
        audit_handlers::admin_tenant_ids(&pool, &claims).await?
    };
    let filter =
        permissions::resolve_tenant_list_filter(claims.is_superadmin, q.tenant_id, &admins)?;
    let rows = match filter {
        permissions::TenantListFilter::One(t) => {
            sqlx::query_as::<_, LlmConnection>(
                "SELECT * FROM management.llm_connections WHERE tenant_id = $1 ORDER BY id DESC",
            )
            .bind(t)
            .fetch_all(&pool)
            .await
        }
        permissions::TenantListFilter::All => {
            sqlx::query_as::<_, LlmConnection>(
                "SELECT * FROM management.llm_connections ORDER BY id DESC",
            )
            .fetch_all(&pool)
            .await
        }
        permissions::TenantListFilter::Many(ids) => {
            if ids.is_empty() {
                return Ok(Json(vec![]));
            }
            sqlx::query_as::<_, LlmConnection>(
                "SELECT * FROM management.llm_connections WHERE tenant_id = ANY($1) ORDER BY id DESC",
            )
            .bind(&ids)
            .fetch_all(&pool)
            .await
        }
    }
    .map_err(|e| AppError::Internal(format!("列出 LLM 连接失败: {e}")))?;
    Ok(Json(rows))
}

pub async fn get_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<LlmConnection>, AppError> {
    let conn = fetch_connection_authorized(&pool, &claims, id).await?;
    Ok(Json(conn))
}

async fn assert_credential_in_tenant(
    pool: &PgPool,
    tenant_id: i32,
    credential_id: i32,
) -> Result<(), AppError> {
    let exists: Option<i32> = sqlx::query_scalar(
        "SELECT id FROM management.wf_credentials WHERE id = $1 AND tenant_id = $2",
    )
    .bind(credential_id)
    .bind(tenant_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(format!("校验凭证失败: {e}")))?;
    if exists.is_none() {
        return Err(AppError::InvalidQuery("凭证不存在或不属于当前项目".into()));
    }
    Ok(())
}

pub async fn create_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<CreateConnectionReq>,
) -> Result<Json<LlmConnection>, AppError> {
    require_tenant_admin(&pool, &claims, req.tenant_id).await?;
    if req.connection_name.trim().is_empty() {
        return Err(AppError::InvalidQuery("connection_name 不能为空".into()));
    }
    let base_url = normalize_base_url(&req.base_url).map_err(AppError::InvalidQuery)?;
    let models = normalize_models(&req.models.unwrap_or_default());
    if let Some(cid) = req.credential_id {
        assert_credential_in_tenant(&pool, req.tenant_id, cid).await?;
    }

    let row = sqlx::query_as::<_, LlmConnection>(
        "INSERT INTO management.llm_connections \
            (tenant_id, connection_name, base_url, credential_id, models, is_active, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
    )
    .bind(req.tenant_id)
    .bind(req.connection_name.trim())
    .bind(base_url)
    .bind(req.credential_id)
    .bind(&models)
    .bind(req.is_active.unwrap_or(true))
    .bind(claims.sub)
    .fetch_one(&pool)
    .await
    .map_err(|e| map_unique_violation(e, "同名 LLM 连接已存在"))?;
    Ok(Json(row))
}

pub async fn update_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateConnectionReq>,
) -> Result<Json<LlmConnection>, AppError> {
    let existing = fetch_connection_authorized(&pool, &claims, id).await?;
    let base_url = match req.base_url.as_deref() {
        None => None,
        Some(raw) => Some(normalize_base_url(raw).map_err(AppError::InvalidQuery)?),
    };
    if let Some(Some(cid)) = req.credential_id {
        assert_credential_in_tenant(&pool, existing.tenant_id, cid).await?;
    }
    let models = req.models.as_ref().map(|m| normalize_models(m));
    let name = req
        .connection_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if req.connection_name.as_ref().is_some() && name.is_none() {
        return Err(AppError::InvalidQuery("connection_name 不能为空".into()));
    }

    let row = sqlx::query_as::<_, LlmConnection>(
        "UPDATE management.llm_connections SET \
            connection_name = COALESCE($1, connection_name), \
            base_url = COALESCE($2, base_url), \
            credential_id = CASE WHEN $3 THEN $4 ELSE credential_id END, \
            models = COALESCE($5, models), \
            is_active = COALESCE($6, is_active), \
            updated_at = NOW() \
         WHERE id = $7 RETURNING *",
    )
    .bind(name)
    .bind(base_url)
    .bind(req.credential_id.is_some())
    .bind(req.credential_id.flatten())
    .bind(models.as_deref())
    .bind(req.is_active)
    .bind(id)
    .fetch_one(&pool)
    .await
    .map_err(|e| map_unique_violation(e, "同名 LLM 连接已存在"))?;
    Ok(Json(row))
}

pub async fn delete_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    let _ = fetch_connection_authorized(&pool, &claims, id).await?;
    let res = sqlx::query("DELETE FROM management.llm_connections WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .map_err(|e| AppError::Internal(format!("删除 LLM 连接失败: {e}")))?;
    Ok(Json(json!({ "deleted": res.rows_affected() })))
}

async fn probe_models(
    pool: &PgPool,
    tenant_id: i32,
    base_url: &str,
    credential_id: Option<i32>,
) -> Result<Value, AppError> {
    let mut headers_obj = serde_json::Map::new();
    if let Some(cid) = credential_id {
        let store = load_credential_store(pool, tenant_id).await;
        let cred = store
            .get_by_id(cid)
            .ok_or_else(|| AppError::InvalidQuery("探活凭证不存在".into()))?;
        apply_http_auth_headers(&mut headers_obj, cred).map_err(AppError::InvalidQuery)?;
    }
    let url = models_url(base_url);
    let client = crate::workflow_llm::client_for_url(&url).await?;
    let mut req = client.get(url);
    for (k, v) in &headers_obj {
        if let Some(val) = v.as_str() {
            req = req.header(k.as_str(), val);
        }
    }
    match tokio::time::timeout(std::time::Duration::from_secs(10), req.send()).await {
        Err(_) => Ok(json!({ "ok": false, "error": "连接上游 LLM 服务超时" })),
        Ok(result) => match result {
            Ok(resp) => {
                let status = resp.status().as_u16();
                if resp.status().is_success() {
                    Ok(json!({ "ok": true, "status": status }))
                } else {
                    Ok(json!({
                        "ok": false,
                        "status": status,
                        "error": format!("上游返回 HTTP {status}")
                    }))
                }
            }
            Err(_) => Ok(json!({ "ok": false, "error": "无法连接上游 LLM 服务" })),
        },
    }
}

pub async fn test_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<TestConnectionReq>,
) -> Result<Json<Value>, AppError> {
    require_tenant_admin(&pool, &claims, req.tenant_id).await?;
    let base_url = normalize_base_url(&req.base_url).map_err(AppError::InvalidQuery)?;
    if let Some(cid) = req.credential_id {
        assert_credential_in_tenant(&pool, req.tenant_id, cid).await?;
    }
    Ok(Json(
        probe_models(&pool, req.tenant_id, &base_url, req.credential_id).await?,
    ))
}

pub async fn health_connection(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    let conn = fetch_connection_authorized(&pool, &claims, id).await?;
    if !conn.is_active {
        return Ok(Json(json!({ "ok": false, "error": "连接已禁用" })));
    }
    Ok(Json(
        probe_models(&pool, conn.tenant_id, &conn.base_url, conn.credential_id).await?,
    ))
}

fn map_unique_violation(e: sqlx::Error, msg: &str) -> AppError {
    if let sqlx::Error::Database(ref db_err) = e {
        if db_err.code().as_deref() == Some("23505") {
            return AppError::InvalidQuery(msg.to_string());
        }
    }
    AppError::Internal(format!("DB 错误: {e}"))
}
