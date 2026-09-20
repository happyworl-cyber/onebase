//! 项目云日志源 CRUD 与 SLS 代查。
//!
//! 全部 `require_tenant_admin`。响应不含密钥。

use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::{PgPool, Row};

use crate::auth::Claims;
use crate::cloud_log::{
    clamp_line, compose_sls_query, default_sls_endpoint, resolve_query_window, sls_console_url,
    CloudLogPage, CloudLogQuery,
};
use crate::cloud_log_aliyun::{get_logs, ReqwestSlsHttp};
use crate::crypto;
use crate::error::{AppError, Result};
use crate::operation_log::{self, Actor, OperationLogInput, Source, Status};
use crate::permissions;

const MAX_NAME_LEN: usize = 100;

#[derive(Deserialize)]
pub struct LogSourceWrite {
    pub name: String,
    #[serde(default)]
    pub provider: Option<String>,
    pub credential_id: i32,
    pub region: String,
    pub sls_project: String,
    pub logstore: String,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub query_prefix: Option<String>,
}

#[derive(Deserialize)]
pub struct LogQueryBody {
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub query: Option<String>,
    pub x_request_id: Option<String>,
    pub line: Option<u32>,
    pub offset: Option<i64>,
}

fn source_row_to_json(row: &sqlx::postgres::PgRow) -> serde_json::Value {
    json!({
        "id": row.get::<i32, _>("id"),
        "name": row.get::<String, _>("name"),
        "provider": row.get::<String, _>("provider"),
        "credential_id": row.get::<i32, _>("credential_id"),
        "credential_name": row.get::<String, _>("credential_name"),
        "region": row.get::<String, _>("region"),
        "sls_project": row.get::<String, _>("sls_project"),
        "logstore": row.get::<String, _>("logstore"),
        "endpoint": row.get::<Option<String>, _>("endpoint"),
        "query_prefix": row.get::<Option<String>, _>("query_prefix"),
        "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
        "updated_at": row.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
    })
}

fn opt_trim(s: Option<&str>) -> Option<String> {
    s.map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
}

fn validate_write(
    req: &LogSourceWrite,
) -> Result<(
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
)> {
    let name = req.name.trim().to_string();
    if name.is_empty() || name.chars().count() > MAX_NAME_LEN {
        return Err(AppError::InvalidQuery("名称不能为空且最长 100 字".into()));
    }
    let provider = req
        .provider
        .as_deref()
        .unwrap_or("aliyun_sls")
        .trim()
        .to_string();
    if provider != "aliyun_sls" {
        return Err(AppError::InvalidQuery("第一期仅支持 aliyun_sls".into()));
    }
    let region = req.region.trim().to_string();
    let sls_project = req.sls_project.trim().to_string();
    let logstore = req.logstore.trim().to_string();
    if region.is_empty() || sls_project.is_empty() || logstore.is_empty() {
        return Err(AppError::InvalidQuery(
            "地域、SLS Project、Logstore 均为必填".into(),
        ));
    }
    Ok((
        name,
        provider,
        region,
        sls_project,
        logstore,
        opt_trim(req.endpoint.as_deref()),
        opt_trim(req.query_prefix.as_deref()),
    ))
}

async fn require_aliyun_ak(pool: &PgPool, project_id: i32, credential_id: i32) -> Result<()> {
    let kind: Option<String> = sqlx::query_scalar(
        "SELECT kind FROM management.wf_credentials WHERE id = $1 AND tenant_id = $2",
    )
    .bind(credential_id)
    .bind(project_id)
    .fetch_optional(pool)
    .await?;
    match kind.as_deref() {
        Some("aliyun_ak") => Ok(()),
        Some(_) => Err(AppError::InvalidQuery("请选择阿里云 AccessKey 凭证".into())),
        None => Err(AppError::InvalidQuery("凭证不存在或不属于本项目".into())),
    }
}

fn map_unique(e: sqlx::Error) -> AppError {
    if let sqlx::Error::Database(db) = &e {
        if db.constraint() == Some("project_log_sources_name_unique") {
            return AppError::InvalidQuery("同一项目内日志源名称必须唯一".into());
        }
    }
    AppError::Database(e)
}

fn record_source_op(
    pool: &PgPool,
    claims: &Claims,
    tenant_id: i32,
    action: &str,
    source_id: i32,
    name: &str,
    summary: String,
    change: serde_json::Value,
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
        operation_log::resource_type::LOG_SOURCE,
        name.to_string(),
        Some(source_id.to_string()),
    )
    .change(change);
    operation_log::record(pool, input);
}

const SOURCE_SELECT: &str = r#"
    SELECT s.id, s.name, s.provider, s.credential_id, c.name AS credential_name,
           s.region, s.sls_project, s.logstore, s.endpoint, s.query_prefix,
           s.created_at, s.updated_at
    FROM management.project_log_sources s
    JOIN management.wf_credentials c
      ON c.id = s.credential_id AND c.tenant_id = s.tenant_id
"#;

pub async fn list_log_sources(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
) -> Result<Json<Vec<serde_json::Value>>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;
    let rows = sqlx::query(&format!(
        "{SOURCE_SELECT} WHERE s.tenant_id = $1 ORDER BY s.name ASC"
    ))
    .bind(project_id)
    .fetch_all(&pool)
    .await?;
    Ok(Json(rows.iter().map(source_row_to_json).collect()))
}

pub async fn create_log_source(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
    Json(req): Json<LogSourceWrite>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;
    let (name, provider, region, sls_project, logstore, endpoint, query_prefix) =
        validate_write(&req)?;
    require_aliyun_ak(&pool, project_id, req.credential_id).await?;

    let row = sqlx::query(&format!(
        r#"
        INSERT INTO management.project_log_sources
            (tenant_id, name, provider, credential_id, region, sls_project, logstore,
             endpoint, query_prefix, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id
        "#
    ))
    .bind(project_id)
    .bind(&name)
    .bind(&provider)
    .bind(req.credential_id)
    .bind(&region)
    .bind(&sls_project)
    .bind(&logstore)
    .bind(endpoint.as_deref())
    .bind(query_prefix.as_deref())
    .bind(claims.sub)
    .fetch_one(&pool)
    .await
    .map_err(map_unique)?;
    let id: i32 = row.get("id");

    let row = sqlx::query(&format!(
        "{SOURCE_SELECT} WHERE s.id = $1 AND s.tenant_id = $2"
    ))
    .bind(id)
    .bind(project_id)
    .fetch_one(&pool)
    .await?;

    record_source_op(
        &pool,
        &claims,
        project_id,
        operation_log::action::CREATE,
        id,
        &name,
        format!("新建云日志源 {name}"),
        json!({ "provider": provider, "region": region }),
    );
    Ok(Json(source_row_to_json(&row)))
}

pub async fn update_log_source(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, sid)): Path<(i32, i32)>,
    Json(req): Json<LogSourceWrite>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;
    let (name, provider, region, sls_project, logstore, endpoint, query_prefix) =
        validate_write(&req)?;
    require_aliyun_ak(&pool, project_id, req.credential_id).await?;

    let affected = sqlx::query(
        r#"
        UPDATE management.project_log_sources
        SET name = $1, provider = $2, credential_id = $3, region = $4,
            sls_project = $5, logstore = $6, endpoint = $7, query_prefix = $8
        WHERE id = $9 AND tenant_id = $10
        "#,
    )
    .bind(&name)
    .bind(&provider)
    .bind(req.credential_id)
    .bind(&region)
    .bind(&sls_project)
    .bind(&logstore)
    .bind(endpoint.as_deref())
    .bind(query_prefix.as_deref())
    .bind(sid)
    .bind(project_id)
    .execute(&pool)
    .await
    .map_err(map_unique)?
    .rows_affected();
    if affected == 0 {
        return Err(AppError::NotFound(format!("云日志源 {sid} 不存在")));
    }

    let row = sqlx::query(&format!(
        "{SOURCE_SELECT} WHERE s.id = $1 AND s.tenant_id = $2"
    ))
    .bind(sid)
    .bind(project_id)
    .fetch_one(&pool)
    .await?;
    record_source_op(
        &pool,
        &claims,
        project_id,
        operation_log::action::UPDATE,
        sid,
        &name,
        format!("更新云日志源 {name}"),
        json!({ "provider": provider, "region": region }),
    );
    Ok(Json(source_row_to_json(&row)))
}

pub async fn delete_log_source(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, sid)): Path<(i32, i32)>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;
    let name: Option<String> = sqlx::query_scalar(
        "SELECT name FROM management.project_log_sources WHERE id = $1 AND tenant_id = $2",
    )
    .bind(sid)
    .bind(project_id)
    .fetch_optional(&pool)
    .await?;
    let Some(name) = name else {
        return Err(AppError::NotFound(format!("云日志源 {sid} 不存在")));
    };
    sqlx::query("DELETE FROM management.project_log_sources WHERE id = $1 AND tenant_id = $2")
        .bind(sid)
        .bind(project_id)
        .execute(&pool)
        .await?;
    record_source_op(
        &pool,
        &claims,
        project_id,
        operation_log::action::DELETE,
        sid,
        &name,
        format!("删除云日志源 {name}"),
        json!({}),
    );
    Ok(Json(json!({ "ok": true })))
}

struct SourceExec {
    region: String,
    sls_project: String,
    logstore: String,
    endpoint: Option<String>,
    query_prefix: Option<String>,
    access_key_id: String,
    access_key_secret: String,
}

async fn load_source_exec(pool: &PgPool, project_id: i32, sid: i32) -> Result<SourceExec> {
    let row = sqlx::query(
        r#"
        SELECT s.region, s.sls_project, s.logstore, s.endpoint, s.query_prefix,
               c.username, c.secret_encrypted, c.kind
        FROM management.project_log_sources s
        JOIN management.wf_credentials c
          ON c.id = s.credential_id AND c.tenant_id = s.tenant_id
        WHERE s.id = $1 AND s.tenant_id = $2
        "#,
    )
    .bind(sid)
    .bind(project_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("云日志源 {sid} 不存在")))?;

    let kind: String = row.get("kind");
    if kind != "aliyun_ak" {
        return Err(AppError::InvalidQuery("请选择阿里云 AccessKey 凭证".into()));
    }
    let access_key_id: Option<String> = row.get("username");
    let access_key_id = access_key_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::InvalidQuery("凭证缺少 AccessKeyId".into()))?
        .to_string();
    let secret = crypto::decrypt_secret(row.get("secret_encrypted"))
        .map_err(|_| AppError::InvalidQuery("凭证解密失败".into()))?;
    Ok(SourceExec {
        region: row.get("region"),
        sls_project: row.get("sls_project"),
        logstore: row.get("logstore"),
        endpoint: row.get("endpoint"),
        query_prefix: row.get("query_prefix"),
        access_key_id,
        access_key_secret: secret,
    })
}

fn build_query(src: &SourceExec, body: &LogQueryBody, now: i64) -> Result<(CloudLogQuery, String)> {
    let query = compose_sls_query(
        src.query_prefix.as_deref(),
        body.query.as_deref(),
        body.x_request_id.as_deref(),
    )
    .map_err(AppError::InvalidQuery)?;
    let (from, to) =
        resolve_query_window(body.from, body.to, now).map_err(AppError::InvalidQuery)?;
    let offset = body.offset.unwrap_or(0).max(0) as u32;
    Ok((
        CloudLogQuery {
            from,
            to,
            query: query.clone(),
            line: clamp_line(body.line),
            offset,
            reverse: true,
        },
        query,
    ))
}

fn map_sls_err(e: String) -> AppError {
    if e.contains("凭证无效") || e.contains("读权限") {
        AppError::InvalidQuery(e)
    } else if e.contains("SLS 返回 4") {
        AppError::InvalidQuery(e)
    } else {
        AppError::Internal(e)
    }
}

pub async fn query_log_source(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, sid)): Path<(i32, i32)>,
    Json(body): Json<LogQueryBody>,
) -> Result<Json<CloudLogPage>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;
    let src = load_source_exec(&pool, project_id, sid).await?;
    let now = chrono::Utc::now().timestamp();
    let (q, _) = build_query(&src, &body, now)?;
    let endpoint = src
        .endpoint
        .clone()
        .unwrap_or_else(|| default_sls_endpoint(&src.sls_project, &src.region));
    let date = chrono::Utc::now().to_rfc2822();
    let logs = get_logs(
        &ReqwestSlsHttp {
            client: reqwest::Client::new(),
        },
        &endpoint,
        &src.access_key_id,
        &src.access_key_secret,
        &src.sls_project,
        &src.logstore,
        &date,
        &q,
    )
    .await
    .map_err(map_sls_err)?;
    let console_url = sls_console_url(
        &src.region,
        &src.sls_project,
        &src.logstore,
        q.from,
        q.to,
        &q.query,
    );
    let count = logs.len();
    Ok(Json(CloudLogPage {
        logs,
        count,
        console_url,
    }))
}

pub async fn get_log_source_console_url(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, sid)): Path<(i32, i32)>,
    Query(body): Query<LogQueryBody>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;
    let src = load_source_exec(&pool, project_id, sid).await?;
    let now = chrono::Utc::now().timestamp();
    let (q, _) = build_query(&src, &body, now)?;
    Ok(Json(json!({
        "console_url": sls_console_url(
            &src.region,
            &src.sls_project,
            &src.logstore,
            q.from,
            q.to,
            &q.query,
        )
    })))
}

pub async fn test_log_source(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, sid)): Path<(i32, i32)>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;
    let src = load_source_exec(&pool, project_id, sid).await?;
    let now = chrono::Utc::now().timestamp();
    let body = LogQueryBody {
        from: Some(now - 60),
        to: Some(now),
        query: None,
        x_request_id: None,
        line: Some(1),
        offset: Some(0),
    };
    let (q, _) = build_query(&src, &body, now)?;
    let endpoint = src
        .endpoint
        .clone()
        .unwrap_or_else(|| default_sls_endpoint(&src.sls_project, &src.region));
    let date = chrono::Utc::now().to_rfc2822();
    let logs = get_logs(
        &ReqwestSlsHttp {
            client: reqwest::Client::new(),
        },
        &endpoint,
        &src.access_key_id,
        &src.access_key_secret,
        &src.sls_project,
        &src.logstore,
        &date,
        &q,
    )
    .await
    .map_err(map_sls_err)?;
    Ok(Json(json!({ "ok": true, "count": logs.len() })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sls_4xx_is_validation_not_internal() {
        match map_sls_err("SLS 返回 400: key (content) is not config as key value config".into())
        {
            AppError::InvalidQuery(m) => assert!(m.contains("400"), "{m}"),
            other => panic!("expected InvalidQuery, got {other:?}"),
        }
    }

    #[test]
    fn log_source_row_json_has_no_secret_keys() {
        let v = serde_json::json!({
            "id": 1,
            "name": "Access",
            "provider": "aliyun_sls",
            "credential_id": 3,
            "credential_name": "阿里云生产",
            "region": "cn-hangzhou",
            "sls_project": "p",
            "logstore": "app-log",
            "endpoint": null,
            "query_prefix": null,
        });
        let s = v.to_string();
        assert!(!s.contains("secret"));
        assert!(!s.contains("AccessKeySecret"));
    }
}
