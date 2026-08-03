//! 工作流「数据源 / 凭证」集成模块 CRUD。
//!
//! 路由挂在项目路径下（与环境变量 `/api/projects/:id/env-vars` 同款惯例）：
//!   凭证：
//!     - GET    /api/projects/:id/wf-credentials
//!     - POST   /api/projects/:id/wf-credentials
//!     - PUT    /api/projects/:id/wf-credentials/:cred_id
//!     - DELETE /api/projects/:id/wf-credentials/:cred_id
//!   数据源：
//!     - GET    /api/projects/:id/wf-datasources
//!     - POST   /api/projects/:id/wf-datasources
//!     - PUT    /api/projects/:id/wf-datasources/:ds_id
//!     - DELETE /api/projects/:id/wf-datasources/:ds_id
//!     - POST   /api/projects/:id/wf-datasources/:ds_id/test  （测试连接，仅 postgresql）
//!
//! 权限：路由级 `auth_middleware` 注入 Claims；handler 内统一
//! `require_tenant_admin(pool, claims, project_id)`（Claims 无 tenant_id，
//! 租户上下文只能来自路径参数），并且所有写查询都 `WHERE ... AND tenant_id = $project`
//! 防越权。
//!
//! 凭证密钥入库前 `crypto::encrypt_secret`，**永不回显**（列表 / 详情只给
//! `has_secret: true`）。更新时密钥可空——空表示保持原密文不变（COALESCE）。

use std::collections::HashMap;

use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::{PgPool, Row};

use crate::auth::Claims;
use crate::crypto;
use crate::error::{AppError, Result};
use crate::permissions;

const ALLOWED_KINDS: [&str; 2] = ["basic", "bearer"];
const ALLOWED_DS_TYPES: [&str; 2] = ["postgresql", "mysql"];
const MAX_NAME_LEN: usize = 100;

fn validate_name(name: &str) -> Result<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidQuery("名称不能为空".to_string()));
    }
    if trimmed.chars().count() > MAX_NAME_LEN {
        return Err(AppError::InvalidQuery(format!(
            "名称过长（上限 {} 字符）",
            MAX_NAME_LEN
        )));
    }
    Ok(())
}

// ─────────────────────────────── 凭证 ───────────────────────────────

#[derive(Deserialize)]
pub struct CredentialRequest {
    pub name: String,
    /// basic（用户名/密码）| bearer（令牌）；缺省 basic
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    /// 密码 / 令牌明文。新建必填；更新时留空表示保持原密文不变。
    #[serde(default)]
    pub secret: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

fn credential_row_to_json(row: &sqlx::postgres::PgRow, ref_count: i64) -> serde_json::Value {
    json!({
        "id": row.get::<i32, _>("id"),
        "name": row.get::<String, _>("name"),
        "kind": row.get::<String, _>("kind"),
        "username": row.get::<Option<String>, _>("username"),
        "description": row.get::<Option<String>, _>("description"),
        // 密钥永不回显；仅告知「已配置」，供前端渲染 •••• 占位
        "has_secret": true,
        "ref_count": ref_count,
        "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
        "updated_at": row.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
    })
}

/// GET /api/projects/:id/wf-credentials
pub async fn list_credentials(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
) -> Result<Json<Vec<serde_json::Value>>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;

    let rows = sqlx::query(
        r#"
        SELECT id, name, kind, username, description, created_at, updated_at
        FROM management.wf_credentials
        WHERE tenant_id = $1
        ORDER BY name ASC
        "#,
    )
    .bind(project_id)
    .fetch_all(&pool)
    .await?;

    // 引用计数：每个凭证被多少个数据源引用
    let ref_rows = sqlx::query(
        r#"
        SELECT credential_id, COUNT(*)::bigint AS cnt
        FROM management.wf_datasources
        WHERE tenant_id = $1 AND credential_id IS NOT NULL
        GROUP BY credential_id
        "#,
    )
    .bind(project_id)
    .fetch_all(&pool)
    .await?;
    let ref_map: HashMap<i32, i64> = ref_rows
        .iter()
        .map(|r| (r.get::<i32, _>("credential_id"), r.get::<i64, _>("cnt")))
        .collect();

    let body = rows
        .iter()
        .map(|r| {
            let id: i32 = r.get("id");
            credential_row_to_json(r, ref_map.get(&id).copied().unwrap_or(0))
        })
        .collect();
    Ok(Json(body))
}

/// POST /api/projects/:id/wf-credentials
pub async fn create_credential(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
    Json(req): Json<CredentialRequest>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;
    validate_name(&req.name)?;

    let kind = req.kind.as_deref().unwrap_or("basic").trim().to_string();
    if !ALLOWED_KINDS.contains(&kind.as_str()) {
        return Err(AppError::InvalidQuery(format!(
            "非法凭证类型：{}（仅支持 basic / bearer）",
            kind
        )));
    }

    let secret = req
        .secret
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::InvalidQuery("新建凭证必须填写密码 / 令牌".to_string()))?;
    let secret_encrypted = crypto::encrypt_secret(secret)?;

    let row = sqlx::query(
        r#"
        INSERT INTO management.wf_credentials
            (tenant_id, name, kind, username, secret_encrypted, description, created_by, updated_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
        RETURNING id, name, kind, username, description, created_at, updated_at
        "#,
    )
    .bind(project_id)
    .bind(req.name.trim())
    .bind(&kind)
    .bind(req.username.as_deref().map(str::trim))
    .bind(&secret_encrypted)
    .bind(req.description.as_deref())
    .bind(claims.sub)
    .fetch_one(&pool)
    .await?;

    tracing::info!(user_id = claims.sub, tenant_id = project_id, name = %req.name, "wf credential created");
    Ok(Json(credential_row_to_json(&row, 0)))
}

/// PUT /api/projects/:id/wf-credentials/:cred_id
pub async fn update_credential(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, cred_id)): Path<(i32, i32)>,
    Json(req): Json<CredentialRequest>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;
    validate_name(&req.name)?;

    let kind = req.kind.as_deref().unwrap_or("basic").trim().to_string();
    if !ALLOWED_KINDS.contains(&kind.as_str()) {
        return Err(AppError::InvalidQuery(format!(
            "非法凭证类型：{}（仅支持 basic / bearer）",
            kind
        )));
    }

    // 密钥留空表示保持原密文不变；填了才重新加密。
    let secret_encrypted = match req.secret.as_deref().filter(|s| !s.is_empty()) {
        Some(s) => Some(crypto::encrypt_secret(s)?),
        None => None,
    };

    let row = sqlx::query(
        r#"
        UPDATE management.wf_credentials
        SET name = $1,
            kind = $2,
            username = $3,
            secret_encrypted = COALESCE($4, secret_encrypted),
            description = $5,
            updated_by = $6
        WHERE id = $7 AND tenant_id = $8
        RETURNING id, name, kind, username, description, created_at, updated_at
        "#,
    )
    .bind(req.name.trim())
    .bind(&kind)
    .bind(req.username.as_deref().map(str::trim))
    .bind(secret_encrypted.as_deref())
    .bind(req.description.as_deref())
    .bind(claims.sub)
    .bind(cred_id)
    .bind(project_id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("凭证 {} 不存在", cred_id)))?;

    // 凭证连接信息可能变化：淘汰所有引用该凭证的数据源的内存池，下次执行按新配置重建。
    evict_pools_for_credential(&pool, project_id, cred_id).await;

    tracing::info!(user_id = claims.sub, tenant_id = project_id, cred_id, "wf credential updated");
    Ok(Json(credential_row_to_json(&row, 0)))
}

/// DELETE /api/projects/:id/wf-credentials/:cred_id
///
/// 被数据源引用时拒绝删除（外键是 SET NULL，但静默置空会让数据源突然免密，
/// 不如显式拦住让用户先解绑）。
pub async fn delete_credential(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, cred_id)): Path<(i32, i32)>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;

    let ref_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM management.wf_datasources WHERE tenant_id = $1 AND credential_id = $2",
    )
    .bind(project_id)
    .bind(cred_id)
    .fetch_one(&pool)
    .await?;
    if ref_count > 0 {
        return Err(AppError::InvalidQuery(format!(
            "该凭证仍被 {} 个数据源引用，请先解绑后再删除",
            ref_count
        )));
    }

    let affected = sqlx::query(
        "DELETE FROM management.wf_credentials WHERE id = $1 AND tenant_id = $2",
    )
    .bind(cred_id)
    .bind(project_id)
    .execute(&pool)
    .await?
    .rows_affected();
    if affected == 0 {
        return Err(AppError::NotFound(format!("凭证 {} 不存在", cred_id)));
    }

    tracing::info!(user_id = claims.sub, tenant_id = project_id, cred_id, "wf credential deleted");
    Ok(Json(json!({ "deleted": true })))
}

// ────────────────────────────── 数据源 ──────────────────────────────

#[derive(Deserialize)]
pub struct DatasourceRequest {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// postgresql | mysql；缺省 postgresql
    #[serde(default)]
    pub ds_type: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<i32>,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub credential_id: Option<i32>,
}

fn datasource_row_to_json(
    row: &sqlx::postgres::PgRow,
    ref_count: i64,
) -> serde_json::Value {
    json!({
        "id": row.get::<i32, _>("id"),
        "name": row.get::<String, _>("name"),
        "description": row.get::<Option<String>, _>("description"),
        "ds_type": row.get::<String, _>("ds_type"),
        "host": row.get::<String, _>("host"),
        "port": row.get::<Option<i32>, _>("port"),
        "database": row.get::<Option<String>, _>("database"),
        "credential_id": row.get::<Option<i32>, _>("credential_id"),
        "credential_name": row.get::<Option<String>, _>("credential_name"),
        "status": row.get::<String, _>("status"),
        "last_tested_at": row.get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_tested_at"),
        "last_test_error": row.get::<Option<String>, _>("last_test_error"),
        "is_active": row.get::<bool, _>("is_active"),
        "ref_count": ref_count,
        "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
        "updated_at": row.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
    })
}

/// 统计每个数据源被多少个工作流的 db 节点引用（扫描 workflows.nodes JSONB）。
async fn datasource_ref_counts(pool: &PgPool, project_id: i32) -> HashMap<i32, i64> {
    let rows = sqlx::query(
        r#"
        SELECT (n->'config'->>'datasource_id')::int AS ds_id,
               COUNT(DISTINCT w.id)::bigint AS cnt
        FROM management.workflows w
        CROSS JOIN LATERAL jsonb_array_elements(w.nodes) AS n
        WHERE w.tenant_id = $1
          AND (n->'config'->>'datasource_id') ~ '^[0-9]+$'
        GROUP BY 1
        "#,
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    rows.iter()
        .filter_map(|r| {
            let ds_id: Option<i32> = r.try_get("ds_id").ok();
            ds_id.map(|id| (id, r.get::<i64, _>("cnt")))
        })
        .collect()
}

/// GET /api/projects/:id/wf-datasources
pub async fn list_datasources(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
) -> Result<Json<Vec<serde_json::Value>>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;

    let rows = sqlx::query(
        r#"
        SELECT d.id, d.name, d.description, d.ds_type, d.host, d.port, d.database,
               d.credential_id, c.name AS credential_name,
               d.status, d.last_tested_at, d.last_test_error, d.is_active,
               d.created_at, d.updated_at
        FROM management.wf_datasources d
        LEFT JOIN management.wf_credentials c ON c.id = d.credential_id
        WHERE d.tenant_id = $1 AND d.is_active = true
        ORDER BY d.name ASC
        "#,
    )
    .bind(project_id)
    .fetch_all(&pool)
    .await?;

    let ref_map = datasource_ref_counts(&pool, project_id).await;
    let body = rows
        .iter()
        .map(|r| {
            let id: i32 = r.get("id");
            datasource_row_to_json(r, ref_map.get(&id).copied().unwrap_or(0))
        })
        .collect();
    Ok(Json(body))
}

fn validate_ds_type(ds_type: &str) -> Result<()> {
    if !ALLOWED_DS_TYPES.contains(&ds_type) {
        return Err(AppError::InvalidQuery(format!(
            "非法数据源类型：{}（仅支持 postgresql / mysql）",
            ds_type
        )));
    }
    Ok(())
}

/// 校验 credential_id（若给定）确实属于本项目，避免引用别项目的凭证。
async fn ensure_credential_in_project(
    pool: &PgPool,
    project_id: i32,
    credential_id: Option<i32>,
) -> Result<()> {
    if let Some(cid) = credential_id {
        let ok: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM management.wf_credentials WHERE id = $1 AND tenant_id = $2)",
        )
        .bind(cid)
        .bind(project_id)
        .fetch_one(pool)
        .await?;
        if !ok {
            return Err(AppError::InvalidQuery(format!("凭证 {} 不存在", cid)));
        }
    }
    Ok(())
}

/// POST /api/projects/:id/wf-datasources
pub async fn create_datasource(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
    Json(req): Json<DatasourceRequest>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;
    validate_name(&req.name)?;
    let ds_type = req
        .ds_type
        .as_deref()
        .unwrap_or("postgresql")
        .trim()
        .to_string();
    validate_ds_type(&ds_type)?;
    ensure_credential_in_project(&pool, project_id, req.credential_id).await?;

    let row = sqlx::query(
        r#"
        INSERT INTO management.wf_datasources
            (tenant_id, name, description, ds_type, host, port, database, credential_id, created_by, updated_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
        RETURNING id, name, description, ds_type, host, port, database, credential_id,
                  (SELECT name FROM management.wf_credentials WHERE id = wf_datasources.credential_id) AS credential_name,
                  status, last_tested_at, last_test_error, is_active, created_at, updated_at
        "#,
    )
    .bind(project_id)
    .bind(req.name.trim())
    .bind(req.description.as_deref())
    .bind(&ds_type)
    .bind(req.host.as_deref().unwrap_or("").trim())
    .bind(req.port)
    .bind(req.database.as_deref().map(str::trim))
    .bind(req.credential_id)
    .bind(claims.sub)
    .fetch_one(&pool)
    .await?;

    tracing::info!(user_id = claims.sub, tenant_id = project_id, name = %req.name, "wf datasource created");
    Ok(Json(datasource_row_to_json(&row, 0)))
}

/// PUT /api/projects/:id/wf-datasources/:ds_id
pub async fn update_datasource(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, ds_id)): Path<(i32, i32)>,
    Json(req): Json<DatasourceRequest>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;
    validate_name(&req.name)?;
    let ds_type = req
        .ds_type
        .as_deref()
        .unwrap_or("postgresql")
        .trim()
        .to_string();
    validate_ds_type(&ds_type)?;
    ensure_credential_in_project(&pool, project_id, req.credential_id).await?;

    // 连接信息变了就重置状态为未测试（连通性需重新验证）。
    let row = sqlx::query(
        r#"
        UPDATE management.wf_datasources
        SET name = $1, description = $2, ds_type = $3, host = $4, port = $5,
            database = $6, credential_id = $7, status = 'untested',
            last_test_error = NULL, updated_by = $8
        WHERE id = $9 AND tenant_id = $10
        RETURNING id, name, description, ds_type, host, port, database, credential_id,
                  (SELECT name FROM management.wf_credentials WHERE id = wf_datasources.credential_id) AS credential_name,
                  status, last_tested_at, last_test_error, is_active, created_at, updated_at
        "#,
    )
    .bind(req.name.trim())
    .bind(req.description.as_deref())
    .bind(&ds_type)
    .bind(req.host.as_deref().unwrap_or("").trim())
    .bind(req.port)
    .bind(req.database.as_deref().map(str::trim))
    .bind(req.credential_id)
    .bind(claims.sub)
    .bind(ds_id)
    .bind(project_id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("数据源 {} 不存在", ds_id)))?;

    // 淘汰内存池（PG/MySQL 两处缓存），下次执行按新配置重建。
    crate::workflow_engine::evict_datasource_pool(ds_id).await;

    tracing::info!(user_id = claims.sub, tenant_id = project_id, ds_id, "wf datasource updated");
    Ok(Json(datasource_row_to_json(&row, 0)))
}

/// DELETE /api/projects/:id/wf-datasources/:ds_id
///
/// 被工作流节点引用时拒绝删除，避免执行期节点突然找不到数据源而报错。
pub async fn delete_datasource(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, ds_id)): Path<(i32, i32)>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;

    let ref_map = datasource_ref_counts(&pool, project_id).await;
    if let Some(&cnt) = ref_map.get(&ds_id) {
        if cnt > 0 {
            return Err(AppError::InvalidQuery(format!(
                "该数据源仍被 {} 个工作流引用，请先在相关节点改回默认或换用其它数据源",
                cnt
            )));
        }
    }

    let affected = sqlx::query(
        "DELETE FROM management.wf_datasources WHERE id = $1 AND tenant_id = $2",
    )
    .bind(ds_id)
    .bind(project_id)
    .execute(&pool)
    .await?
    .rows_affected();
    if affected == 0 {
        return Err(AppError::NotFound(format!("数据源 {} 不存在", ds_id)));
    }

    crate::workflow_engine::evict_datasource_pool(ds_id).await;

    tracing::info!(user_id = claims.sub, tenant_id = project_id, ds_id, "wf datasource deleted");
    Ok(Json(json!({ "deleted": true })))
}

/// POST /api/projects/:id/wf-datasources/:ds_id/test —— 测试连接（仅 postgresql）。
///
/// 结果写回 status / last_tested_at / last_test_error，并返回给前端内联展示。
pub async fn test_datasource(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, ds_id)): Path<(i32, i32)>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;

    let outcome =
        crate::workflow_engine::probe_datasource_connection(&pool, Some(project_id), ds_id).await;

    let (status, error): (&str, Option<String>) = match &outcome {
        Ok(()) => ("connected", None),
        Err(e) => ("failed", Some(e.to_string())),
    };

    sqlx::query(
        r#"
        UPDATE management.wf_datasources
        SET status = $1, last_tested_at = NOW(), last_test_error = $2
        WHERE id = $3 AND tenant_id = $4
        "#,
    )
    .bind(status)
    .bind(error.as_deref())
    .bind(ds_id)
    .bind(project_id)
    .execute(&pool)
    .await?;

    match outcome {
        Ok(()) => Ok(Json(json!({ "ok": true, "status": "connected" }))),
        Err(e) => Ok(Json(json!({ "ok": false, "status": "failed", "error": e.to_string() }))),
    }
}

/// 淘汰所有引用某凭证的数据源内存池（凭证变更后连接信息可能失效）。
async fn evict_pools_for_credential(pool: &PgPool, project_id: i32, cred_id: i32) {
    let ids: Vec<i32> = sqlx::query_scalar(
        "SELECT id FROM management.wf_datasources WHERE tenant_id = $1 AND credential_id = $2",
    )
    .bind(project_id)
    .bind(cred_id)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    for ds_id in ids {
        crate::workflow_engine::evict_datasource_pool(ds_id).await;
    }
}
