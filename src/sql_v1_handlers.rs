//! v1 对外 raw DDL：`POST /api/v1/:database_slug/sql`
//!
//! 与结构化 `/api/v1/:database_slug/ddl/tables` 互补——允许直接提交
//! `CREATE TABLE` / `ALTER TABLE` / `DROP TABLE` / `COMMENT ON` 等 DDL 文本。
//!
//! 安全边界（比超管 `/query` 更严）：
//!   - 仅 DDL 类首关键字（CREATE / ALTER / DROP / COMMENT）
//!   - 禁止 DROP DATABASE / DROP SCHEMA / TRUNCATE
//!   - 禁止 management / pg_catalog 等敏感引用
//!   - 必须 `acknowledge_destructive: true`
//!   - JWT 需 member+；API Key 需 scope 含 DDL 或 ALL + Resources 覆盖目标 schema

use crate::audit_middleware::AuditDetailSink;
use crate::ddl_handlers::{self, DdlAuthSubject};
use crate::error::{AppError, Result};
use crate::middleware::CurrentDatabaseId;
use crate::raw_sql_guard;
use axum::{
    extract::{Path, Request, State},
    http::HeaderValue,
    middleware::Next,
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};

#[derive(Deserialize)]
pub struct RawDdlRequest {
    pub sql: String,
    /// 用于 API Key Resources scope 校验；缺省 `public`。
    #[serde(default = "default_schema")]
    pub schema: String,
    #[serde(default)]
    pub acknowledge_destructive: bool,
}

fn default_schema() -> String {
    "public".to_string()
}

fn extract_sql_database_segment(path: &str) -> Option<String> {
    let mut iter = path.trim_start_matches('/').split('/');
    if iter.next()? != "api" || iter.next()? != "v1" {
        return None;
    }
    let db_seg = iter.next()?.to_string();
    if iter.next()? != "sql" {
        return None;
    }
    if iter.next().is_some() {
        return None;
    }
    Some(db_seg)
}

/// 与 `ddl_auth_middleware` 同款，路径固定为 `/api/v1/:database_slug/sql`。
pub async fn sql_auth_middleware(
    State(pool): State<PgPool>,
    mut req: Request,
    next: Next,
) -> Result<axum::response::Response> {
    let path_db_seg = extract_sql_database_segment(req.uri().path()).ok_or_else(|| {
        AppError::Internal("SQL 路径未匹配 /api/v1/:database_slug/sql".to_string())
    })?;

    let auth_header_str = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .map(|s| s.to_string());
    let apikey_header_str = req
        .headers()
        .get("apikey")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.to_string());

    // PAT（crp_* 平台服务令牌）支持：解析成绑定用户的 Claims，复用 DDL 权限体系。
    // auth_middleware 里已有相同模式；ddl/sql 中间件只检查了 JWT 和 cr_* 项目 key，
    // 漏掉了 PAT，导致 crp_* 两个分支都走不进，直接落到 Unauthorized。
    if let Some(pat) = auth_header_str
        .as_deref()
        .and_then(|h| h.strip_prefix("Bearer "))
        .filter(|t| t.starts_with(crate::platform_token::TOKEN_PREFIX))
    {
        let (claims, _ctx) = crate::platform_token::authenticate(&pool, pat).await?;
        let path_db_id =
            ddl_handlers::resolve_ddl_database_id_for_user(&pool, &claims, &path_db_seg).await?;
        if let Ok(v) = HeaderValue::from_str(&path_db_id.to_string()) {
            req.headers_mut().insert("X-Database-Id", v);
        }
        req.extensions_mut().insert(claims.clone());
        req.extensions_mut().insert(DdlAuthSubject::User(claims));
        return Ok(next.run(req).await);
    }

    if let Some(token) = auth_header_str
        .as_deref()
        .and_then(|h| h.strip_prefix("Bearer "))
        .filter(|t| !t.starts_with("cr_"))
    {
        if let Ok(claims) = crate::auth::verify_token(token) {
            if !claims.jti.is_empty() {
                let session = sqlx::query(
                    "SELECT revoked, expires_at FROM user_sessions WHERE jti = $1::uuid",
                )
                .bind(&claims.jti)
                .fetch_optional(&pool)
                .await
                .map_err(|e| AppError::Internal(format!("查询会话失败: {}", e)))?;

                if let Some(row) = session {
                    let revoked: bool = row.try_get("revoked").unwrap_or(false);
                    let expires_at: Option<chrono::DateTime<chrono::Utc>> =
                        row.try_get("expires_at").ok();
                    let active =
                        !revoked && expires_at.map(|t| t > chrono::Utc::now()).unwrap_or(false);
                    if active {
                        let path_db_id = ddl_handlers::resolve_ddl_database_id_for_user(
                            &pool, &claims, &path_db_seg,
                        )
                        .await?;
                        if let Ok(v) = HeaderValue::from_str(&path_db_id.to_string()) {
                            req.headers_mut().insert("X-Database-Id", v);
                        }
                        req.extensions_mut().insert(claims.clone());
                        req.extensions_mut()
                            .insert(DdlAuthSubject::User(claims));
                        return Ok(next.run(req).await);
                    }
                }
            }
        }
    }

    let api_key = auth_header_str
        .as_deref()
        .and_then(|h| h.strip_prefix("Bearer "))
        .filter(|s| s.starts_with("cr_"))
        .or_else(|| {
            apikey_header_str
                .as_deref()
                .filter(|s| s.starts_with("cr_"))
        });

    if let Some(key) = api_key {
        let row = sqlx::query(
            r#"
            SELECT database_id, permissions
            FROM management.api_keys
            WHERE key_hash = encode(sha256($1::bytea), 'hex')
              AND is_active = true
              AND (expires_at IS NULL OR expires_at > NOW())
            "#,
        )
        .bind(key)
        .fetch_optional(&pool)
        .await
        .map_err(|e| AppError::Internal(format!("校验 API Key 失败: {}", e)))?;

        let row = row.ok_or_else(|| AppError::Unauthorized("API Key 无效或已过期".to_string()))?;
        let key_database_id: i32 = row.get("database_id");
        let permissions: Value = row.get("permissions");

        let key_path_match = if let Ok(id) = path_db_seg.parse::<i32>() {
            key_database_id == id
        } else {
            let row = sqlx::query(
                "SELECT 1 FROM management.tenant_databases WHERE id = $1 AND slug = $2 AND is_active = true",
            )
            .bind(key_database_id)
            .bind(&path_db_seg)
            .fetch_optional(&pool)
            .await
            .map_err(AppError::Database)?;
            row.is_some()
        };
        if !key_path_match {
            return Err(AppError::Unauthorized(
                "URL 中的 database_slug 与 API Key 绑定的数据库不一致".to_string(),
            ));
        }

        let _ = sqlx::query(
            "UPDATE management.api_keys SET last_used_at = NOW() WHERE key_hash = encode(sha256($1::bytea), 'hex')",
        )
        .bind(key)
        .execute(&pool)
        .await;

        req.extensions_mut()
            .insert(DdlAuthSubject::ApiKey(ddl_handlers::DdlApiKeyAuth {
                database_id: key_database_id,
                permissions,
            }));
        if let Ok(v) = HeaderValue::from_str(&key_database_id.to_string()) {
            req.headers_mut().insert("X-Database-Id", v);
        }
        return Ok(next.run(req).await);
    }

    Err(AppError::Unauthorized(
        "缺少有效的 JWT 或 API Key".to_string(),
    ))
}

fn require_database_id(opt: Option<Extension<CurrentDatabaseId>>) -> Result<i32> {
    opt.map(|Extension(CurrentDatabaseId(id))| id).ok_or_else(|| {
        AppError::InvalidQuery("缺少 X-Database-Id 请求头，无法在租户库上执行 DDL".to_string())
    })
}

fn actor_label(subject: &DdlAuthSubject) -> String {
    match subject {
        DdlAuthSubject::User(claims) => format!("user:{}", claims.sub),
        DdlAuthSubject::ApiKey(key) => format!("api_key:db{}", key.database_id),
    }
}

/// POST /api/v1/:database_slug/sql
pub async fn v1_execute_raw_ddl(
    State(main_pool): State<PgPool>,
    Extension(subject): Extension<DdlAuthSubject>,
    db_id: Option<Extension<CurrentDatabaseId>>,
    dynamic_pool: Option<Extension<PgPool>>,
    audit_sink: Option<Extension<AuditDetailSink>>,
    Path(_database_slug): Path<String>,
    Json(req): Json<RawDdlRequest>,
) -> Result<Json<Value>> {
    use std::time::Instant;

    let start = Instant::now();
    let database_id = require_database_id(db_id)?;
    let schema = req.schema.trim();
    if schema.is_empty() {
        return Err(AppError::InvalidQuery("schema 不能为空".to_string()));
    }

    ddl_handlers::enforce_ddl_schema_access(&main_pool, &subject, database_id, schema).await?;

    let sql = req.sql.trim();
    if sql.is_empty() {
        return Err(AppError::InvalidQuery("sql 不能为空".to_string()));
    }

    let sql_type = raw_sql_guard::get_sql_type(sql);
    let push_audit = |kind: &'static str, blocked_reason: Option<&str>| {
        if let Some(Extension(sink)) = &audit_sink {
            sink.set(json!({
                "kind": kind,
                "actor": actor_label(&subject),
                "database_id": database_id,
                "schema": schema,
                "sql_type": sql_type,
                "sql_len": sql.len(),
                "acknowledge_destructive": req.acknowledge_destructive,
                "blocked_reason": blocked_reason,
            }));
        }
    };
    push_audit("v1_raw_ddl", None);

    tracing::warn!(
        target: "raw_sql_audit",
        event = "v1_raw_ddl_invoked",
        actor = %actor_label(&subject),
        database_id = database_id,
        schema = %schema,
        sql_type = sql_type,
        sql_len = sql.len(),
        "v1 raw DDL 执行"
    );

    let pool = match raw_sql_guard::require_target_pool(dynamic_pool.as_deref()) {
        Ok(p) => p,
        Err(e) => {
            push_audit("v1_raw_ddl_blocked", Some("missing_database_id"));
            return Err(e);
        }
    };

    if let Err(e) = raw_sql_guard::check_management_references(sql) {
        push_audit("v1_raw_ddl_blocked", Some("management_schema_reference"));
        return Err(e);
    }
    if let Err(e) = raw_sql_guard::check_forbidden_session_commands(sql) {
        push_audit("v1_raw_ddl_blocked", Some("forbidden_listen_unlisten_command"));
        return Err(e);
    }
    if let Err(e) = raw_sql_guard::require_ddl_only_sql_type(sql_type) {
        push_audit("v1_raw_ddl_blocked", Some("non_ddl_sql_type"));
        return Err(e);
    }
    if let Err(e) = raw_sql_guard::require_destructive_ack(sql_type, req.acknowledge_destructive) {
        push_audit("v1_raw_ddl_blocked", Some("missing_destructive_ack"));
        return Err(e);
    }
    if raw_sql_guard::is_dangerous_operation(sql) {
        push_audit("v1_raw_ddl_blocked", Some("dangerous_keyword_blacklist"));
        return Err(AppError::InvalidQuery(
            "检测到危险操作（DROP DATABASE / DROP SCHEMA / TRUNCATE），已拒绝".to_string(),
        ));
    }
    if sql_type == "TRANSACTION" {
        push_audit("v1_raw_ddl_blocked", Some("bare_transaction_control"));
        return Err(AppError::InvalidQuery(
            "不支持事务控制语句；多条 DDL 将按 autocommit 逐条执行".to_string(),
        ));
    }

    let policy = raw_sql_guard::policy();
    raw_sql_guard::run_raw_script_autocommit(pool, sql, policy)
        .await
        .map_err(raw_sql_guard::map_user_sql_err)?;

    push_audit("v1_raw_ddl_done", None);

    tracing::info!(
        target: "raw_sql_audit",
        event = "v1_raw_ddl_done",
        actor = %actor_label(&subject),
        database_id = database_id,
        schema = %schema,
        sql_type = sql_type,
        elapsed_ms = start.elapsed().as_millis(),
        "v1 raw DDL 执行成功"
    );

    Ok(Json(json!({
        "success": true,
        "type": sql_type,
        "schema": schema,
        "elapsed_ms": start.elapsed().as_millis(),
        "message": format!("{} 操作执行成功", sql_type),
    })))
}
