//! M3 可视化建表：项目级 DDL endpoints。
//!
//! 与 `/query`（仅超管 raw SQL 通道）的关键区别：
//!   - 鉴权门槛 = **member+**（owner/admin/member 都能跑，viewer 不行）。
//!   - SQL **不接受 raw 字符串**——前端只传结构化 body（columns/indexes/operations），
//!     handler 在服务端拼，全过白名单 + 标识符校验。
//!   - 因此即使开放给 member，也不会带来"任意 DROP DATABASE / DROP SCHEMA"风险。
//!
//! 端点：
//!   POST   /api/ddl/tables                    创建表（含列 / FK / 索引）
//!   DELETE /api/ddl/tables/:schema/:table     删表（可 CASCADE）
//!   PATCH  /api/ddl/tables/:schema/:table     ALTER（极简集，详见 AlterOp）
//!
//! 对外 v1（JWT 或 API Key，Key scope 须含 DDL 或 ALL）：
//!   POST   /api/v1/:database_slug/ddl/tables
//!   DELETE /api/v1/:database_slug/ddl/tables/:schema/:table
//!   PATCH  /api/v1/:database_slug/ddl/tables/:schema/:table
//!
//! 共同前置：X-Database-Id 头必须有，否则会落到管理库；handler 用
//! `require_database_id` 兜底。

use crate::auth::Claims;
use crate::error::{AppError, Result};
use crate::middleware::CurrentDatabaseId;
use crate::operation_log::{self, Actor, Source, Status};
use crate::permissions;
use crate::query_builder::invalidate_column_types;
use axum::{
    extract::{Path, Query, Request, State},
    http::HeaderValue,
    middleware::Next,
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};

// ─── 白名单 ───────────────────────────────────────────────────────────

const ALLOWED_DATA_TYPES: &[&str] = &[
    "smallint",
    "integer",
    "bigint",
    "smallserial",
    "serial",
    "bigserial",
    "numeric",
    "real",
    "double precision",
    "text",
    "varchar",
    "char",
    "boolean",
    "date",
    "time",
    "timestamp",
    "timestamptz",
    "uuid",
    "json",
    "jsonb",
    "bytea",
    "inet",
];

const ALLOWED_DEFAULT_EXPRS: &[&str] = &[
    "CURRENT_TIMESTAMP",
    "NOW()",
    "CURRENT_DATE",
    "CURRENT_TIME",
    "GEN_RANDOM_UUID()",
    "TRUE",
    "FALSE",
    "NULL",
];

const ALLOWED_FK_ACTIONS: &[&str] = &[
    "CASCADE",
    "SET NULL",
    "SET DEFAULT",
    "RESTRICT",
    "NO ACTION",
];

/// 禁止 DDL 的 schema 黑名单——避免普通 member 改坏平台 / PG 系统对象。
/// 严格小写比较；调用方先 lowercase 再查。
const FORBIDDEN_SCHEMAS: &[&str] = &["pg_catalog", "information_schema", "pg_toast", "management"];

// ─── 输入类型 ────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreateTableRequest {
    pub schema: String,
    pub table: String,
    pub columns: Vec<ColumnDef>,
    #[serde(default)]
    pub indexes: Vec<IndexDef>,
}

#[derive(Debug, Deserialize)]
pub struct ColumnDef {
    pub name: String,
    pub data_type: String,
    #[serde(default)]
    pub length: Option<i32>,
    #[serde(default)]
    pub precision: Option<i32>,
    #[serde(default)]
    pub scale: Option<i32>,
    #[serde(default = "default_true")]
    pub nullable: bool,
    /// 字面量；表达式必须在 ALLOWED_DEFAULT_EXPRS 中
    #[serde(default)]
    pub default_value: Option<String>,
    #[serde(default)]
    pub is_primary_key: bool,
    #[serde(default)]
    pub is_unique: bool,
    #[serde(default)]
    pub references: Option<ForeignKeyRef>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
pub struct ForeignKeyRef {
    pub schema: String,
    pub table: String,
    pub column: String,
    #[serde(default)]
    pub on_delete: Option<String>,
    #[serde(default)]
    pub on_update: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct IndexDef {
    pub name: String,
    pub columns: Vec<String>,
    #[serde(default)]
    pub is_unique: bool,
}

#[derive(Debug, Deserialize)]
pub struct DropTableQuery {
    #[serde(default)]
    pub cascade: bool,
}

#[derive(Debug, Deserialize)]
pub struct AlterTableRequest {
    pub operations: Vec<AlterOp>,
}

/// 结构化 ALTER 操作集。仍不接受 raw SQL；服务端负责标识符和类型白名单校验。
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AlterOp {
    /// 改表名。
    RenameTable { new_name: String },
    /// 加列；可带默认 / NOT NULL / 外键
    AddColumn { column: ColumnDef },
    /// 删列；cascade=true 时同时删依赖（视图、约束等）
    DropColumn {
        name: String,
        #[serde(default)]
        cascade: bool,
    },
    /// 改列名。
    RenameColumn { old_name: String, new_name: String },
    /// 改列类型。PostgreSQL 如无法隐式转换会报错；当前版本不自动生成 USING。
    AlterColumnType { name: String, column: ColumnDef },
    /// value=true → SET NOT NULL；false → DROP NOT NULL
    SetNotNull { name: String, value: bool },
    /// value=Some(...) → SET DEFAULT；None → DROP DEFAULT
    SetDefault {
        name: String,
        #[serde(default)]
        value: Option<String>,
    },
    /// 给单列新增 UNIQUE 约束。约束名固定为 `{table}_{column}_key`。
    AddUnique { name: String },
}

// ─── 公共校验 ────────────────────────────────────────────────────────

/// PG identifier 检查：1-63 ASCII 字符，首字符字母/下划线，余下字母数字下划线。
/// 不允许引号、空格、连字符——避免任何拼 SQL 时需要再次转义。
pub fn is_valid_pg_ident(name: &str) -> bool {
    if name.is_empty() || name.len() > 63 {
        return false;
    }
    let first = name.chars().next().unwrap();
    if !first.is_ascii_alphabetic() && first != '_' {
        return false;
    }
    name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub fn check_ident(label: &str, value: &str) -> Result<()> {
    if is_valid_pg_ident(value) {
        Ok(())
    } else {
        Err(AppError::InvalidQuery(format!(
            "{} '{}' 不是合法的 PostgreSQL 标识符（仅限 [A-Za-z_][A-Za-z0-9_]*，长度 ≤63）",
            label, value
        )))
    }
}

fn check_schema_allowed(schema: &str) -> Result<()> {
    check_ident("schema 名", schema)?;
    if FORBIDDEN_SCHEMAS.contains(&schema.to_ascii_lowercase().as_str()) {
        return Err(AppError::Forbidden(format!(
            "不允许在 schema '{}' 上执行 DDL（平台 / PG 系统 schema）",
            schema
        )));
    }
    Ok(())
}

fn check_data_type(t: &str) -> Result<()> {
    let normalized = t.trim().to_ascii_lowercase();
    if ALLOWED_DATA_TYPES.contains(&normalized.as_str()) {
        Ok(())
    } else {
        Err(AppError::InvalidQuery(format!(
            "数据类型 '{}' 不在白名单内。允许：{}",
            t,
            ALLOWED_DATA_TYPES.join(", ")
        )))
    }
}

fn check_fk_action(action: &str) -> Result<()> {
    let normalized = action.trim().to_ascii_uppercase();
    if ALLOWED_FK_ACTIONS.contains(&normalized.as_str()) {
        Ok(())
    } else {
        Err(AppError::InvalidQuery(format!(
            "外键动作 '{}' 不合法。允许：{}",
            action,
            ALLOWED_FK_ACTIONS.join(", ")
        )))
    }
}

/// 把 `'` 替换成 `''` 再用单引号包起来，作为 SQL 字面量。
/// 仅用于 default_value 是字面量的分支。
fn quote_literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// 把 default_value 转成可拼接的 SQL 片段：
///   - 如果（大小写无关）匹配 ALLOWED_DEFAULT_EXPRS → 原样使用
///   - 否则按字面量处理（quote_literal）
fn render_default(value: &str) -> String {
    let upper = value.trim().to_ascii_uppercase();
    if ALLOWED_DEFAULT_EXPRS.contains(&upper.as_str()) {
        upper
    } else {
        quote_literal(value)
    }
}

/// 把列定义渲染成 PG 列 SQL 片段（不含开头的列名引号）。
fn render_column_type(col: &ColumnDef) -> Result<String> {
    check_data_type(&col.data_type)?;
    let base = col.data_type.trim().to_ascii_lowercase();
    let typ = match base.as_str() {
        "varchar" | "char" => match col.length {
            Some(n) if n > 0 && n <= 10485760 => format!("{}({})", base, n),
            None => base.clone(),
            _ => {
                return Err(AppError::InvalidQuery(format!(
                    "{}/{} 的 length 非法",
                    col.name, base
                )))
            }
        },
        "numeric" => match (col.precision, col.scale) {
            (Some(p), Some(s)) if p > 0 && p <= 1000 && s >= 0 && s <= p => {
                format!("numeric({},{})", p, s)
            }
            (Some(p), None) if p > 0 && p <= 1000 => format!("numeric({})", p),
            (None, None) => "numeric".to_string(),
            _ => {
                return Err(AppError::InvalidQuery(format!(
                    "{}/numeric 的 precision/scale 非法",
                    col.name
                )))
            }
        },
        _ => base.clone(),
    };
    Ok(typ)
}

/// 渲染一行列定义，含 type / nullable / default / pk / unique / references。
/// 调用方需要保证 col.name 已通过 check_ident。
fn render_column_line(col: &ColumnDef) -> Result<String> {
    check_ident("列名", &col.name)?;
    let typ = render_column_type(col)?;
    let mut s = format!(r#""{}" {}"#, col.name, typ);
    if col.is_primary_key {
        s.push_str(" PRIMARY KEY");
    }
    if col.is_unique && !col.is_primary_key {
        s.push_str(" UNIQUE");
    }
    if !col.nullable && !col.is_primary_key {
        s.push_str(" NOT NULL");
    }
    if let Some(d) = &col.default_value {
        if !d.is_empty() {
            s.push_str(&format!(" DEFAULT {}", render_default(d)));
        }
    }
    if let Some(fk) = &col.references {
        check_schema_allowed(&fk.schema)?;
        check_ident("外键 table", &fk.table)?;
        check_ident("外键 column", &fk.column)?;
        s.push_str(&format!(
            r#" REFERENCES "{}"."{}"("{}")"#,
            fk.schema, fk.table, fk.column
        ));
        if let Some(a) = &fk.on_delete {
            check_fk_action(a)?;
            s.push_str(&format!(" ON DELETE {}", a.to_uppercase()));
        }
        if let Some(a) = &fk.on_update {
            check_fk_action(a)?;
            s.push_str(&format!(" ON UPDATE {}", a.to_uppercase()));
        }
    }
    Ok(s)
}

// ─── handlers ────────────────────────────────────────────────────────

/// API Key 鉴权信息（v1 DDL / raw SQL 路径用）。
#[derive(Clone, Debug)]
pub struct DdlApiKeyAuth {
    pub database_id: i32,
    pub permissions: Value,
}

/// DDL 调用方主体。`ddl_auth_middleware` 保证恰有一个被注入。
#[derive(Clone, Debug)]
pub enum DdlAuthSubject {
    User(Claims),
    ApiKey(DdlApiKeyAuth),
}

fn extract_ddl_database_segment(path: &str) -> Option<String> {
    let mut iter = path.trim_start_matches('/').split('/');
    if iter.next()? != "api" || iter.next()? != "v1" {
        return None;
    }
    let db_seg = iter.next()?.to_string();
    if iter.next()? != "ddl" {
        return None;
    }
    Some(db_seg)
}

pub async fn resolve_ddl_database_id_for_user(
    pool: &PgPool,
    claims: &Claims,
    db_seg: &str,
) -> Result<i32> {
    if let Ok(id) = db_seg.parse::<i32>() {
        return Ok(id);
    }
    let rows = if claims.is_superadmin {
        sqlx::query(
            "SELECT id FROM management.tenant_databases WHERE slug = $1 AND is_active = true ORDER BY id ASC LIMIT 2",
        )
        .bind(db_seg)
        .fetch_all(pool)
        .await
        .map_err(AppError::Database)?
    } else {
        sqlx::query(
            r#"
            SELECT td.id
            FROM management.tenant_databases td
            JOIN management.user_tenants ut
              ON ut.tenant_id = td.tenant_id
             AND ut.user_id = $1
             AND ut.is_active = true
            WHERE td.slug = $2 AND td.is_active = true
            ORDER BY td.id ASC
            LIMIT 2
            "#,
        )
        .bind(claims.sub)
        .bind(db_seg)
        .fetch_all(pool)
        .await
        .map_err(AppError::Database)?
    };
    match rows.len() {
        0 => Err(AppError::NotFound(format!(
            "database_slug '{}' 不存在或无权访问",
            db_seg
        ))),
        1 => Ok(rows[0].get("id")),
        _ => Err(AppError::InvalidQuery(format!(
            "database_slug '{}' 存在歧义，请使用 API Key 或确保租户唯一",
            db_seg
        ))),
    }
}

async fn enforce_ddl_api_key(
    key: &DdlApiKeyAuth,
    schema: &str,
    resource: &str,
) -> Result<()> {
    let perms = &key.permissions;
    let new_format = perms.get("allowed_actions").is_some()
        || perms.get("allowed_resources").is_some();
    if !new_format {
        return Err(AppError::Forbidden(
            "该 API Key 使用旧版 scope 格式，不支持 DDL；请重建 key 并启用 allowed_resources/allowed_actions".to_string(),
        ));
    }

    let actions: Vec<String> = perms
        .get("allowed_actions")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_uppercase))
                .collect()
        })
        .unwrap_or_default();
    if !actions.is_empty()
        && !actions
            .iter()
            .any(|a| a == "*" || a == "ALL" || a == "DDL")
    {
        return Err(AppError::Forbidden(
            "API Key 不允许执行 DDL 操作".to_string(),
        ));
    }

    let resources: Vec<String> = perms
        .get("allowed_resources")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if !resources.is_empty() {
        let schema_wildcard = format!("{}.*", schema);
        let allowed = resources.iter().any(|r| {
            r == "*"
                || r == "*.*"
                || r == resource
                || r == &schema_wildcard
        });
        if !allowed {
            return Err(AppError::Forbidden(format!(
                "API Key 不允许访问资源: {}",
                resource
            )));
        }
    }
    Ok(())
}

async fn enforce_ddl_access(
    main_pool: &PgPool,
    subject: &DdlAuthSubject,
    database_id: i32,
    schema: &str,
    table: &str,
) -> Result<()> {
    let resource = format!("{}.{}", schema, table);
    match subject {
        DdlAuthSubject::User(claims) => {
            permissions::require_database_member(main_pool, claims, database_id).await
        }
        DdlAuthSubject::ApiKey(key) => {
            if key.database_id != database_id {
                return Err(AppError::Unauthorized(
                    "URL 中的 database_slug 与 API Key 绑定的数据库不一致".to_string(),
                ));
            }
            enforce_ddl_api_key(key, schema, &resource).await
        }
    }
}

/// raw DDL 用：按 schema 校验 API Key scope（Resources 允许 `schema.*` / `*`）。
pub async fn enforce_ddl_schema_access(
    main_pool: &PgPool,
    subject: &DdlAuthSubject,
    database_id: i32,
    schema: &str,
) -> Result<()> {
    check_ident("schema 名", schema)?;
    let resource = format!("{}.*", schema);
    match subject {
        DdlAuthSubject::User(claims) => {
            permissions::require_database_member(main_pool, claims, database_id).await
        }
        DdlAuthSubject::ApiKey(key) => {
            if key.database_id != database_id {
                return Err(AppError::Unauthorized(
                    "URL 中的 database_slug 与 API Key 绑定的数据库不一致".to_string(),
                ));
            }
            enforce_ddl_api_key(key, schema, &resource).await
        }
    }
}

fn ddl_actor_label(subject: &DdlAuthSubject) -> String {
    match subject {
        DdlAuthSubject::User(claims) => format!("user:{}", claims.sub),
        DdlAuthSubject::ApiKey(key) => format!("api_key:db{}", key.database_id),
    }
}

/// v1 DDL 专属认证：JWT 或 API Key；路径 `/api/v1/:database_slug/ddl/...`。
pub async fn ddl_auth_middleware(
    State(pool): State<PgPool>,
    mut req: Request,
    next: Next,
) -> Result<axum::response::Response> {
    let path_db_seg = extract_ddl_database_segment(req.uri().path()).ok_or_else(|| {
        AppError::Internal("DDL 路径未匹配 /api/v1/:database_slug/ddl/...".to_string())
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

    // PAT（crp_* 平台服务令牌）支持：与 sql_auth_middleware 同款修复。
    if let Some(pat) = auth_header_str
        .as_deref()
        .and_then(|h| h.strip_prefix("Bearer "))
        .filter(|t| t.starts_with(crate::platform_token::TOKEN_PREFIX))
    {
        let (claims, _ctx) = crate::platform_token::authenticate(&pool, pat).await?;
        let path_db_id =
            resolve_ddl_database_id_for_user(&pool, &claims, &path_db_seg).await?;
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
                        let path_db_id =
                            resolve_ddl_database_id_for_user(&pool, &claims, &path_db_seg).await?;
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

        req.extensions_mut().insert(DdlAuthSubject::ApiKey(DdlApiKeyAuth {
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
    opt.map(|Extension(CurrentDatabaseId(id))| id)
        .ok_or_else(|| {
            AppError::InvalidQuery("缺少 X-Database-Id 请求头，无法在租户库上执行 DDL".to_string())
        })
}

/// POST /api/ddl/tables
pub async fn create_table(
    State(main_pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    db_id: Option<Extension<CurrentDatabaseId>>,
    dynamic_pool: Option<Extension<PgPool>>,
    Json(req): Json<CreateTableRequest>,
) -> Result<Json<Value>> {
    let database_id = require_database_id(db_id)?;
    permissions::require_database_member(&main_pool, &claims, database_id).await?;
    let pool = dynamic_pool.as_deref().unwrap_or(&main_pool);
    let result = create_table_inner(pool, &req).await?;
    invalidate_column_types(database_id, &req.schema, &req.table);
    tracing::info!(
        target = "ddl",
        "user {} (db {}) created table {}.{}: {} columns, {} indexes",
        claims.sub,
        database_id,
        req.schema,
        req.table,
        req.columns.len(),
        req.indexes.len(),
    );
    let col_names: Vec<&str> = req.columns.iter().map(|c| c.name.as_str()).collect();
    operation_log::record_db_op(
        &main_pool,
        database_id,
        Actor::from_claims(&claims),
        Source::Console,
        operation_log::action::CREATE,
        operation_log::resource_type::TABLE,
        Some(format!("{}.{}", req.schema, req.table)),
        None,
        format!("创建数据表「{}.{}」", req.schema, req.table),
        Status::Success,
        None,
        Some(json!({
            "v": 1, "kind": "created",
            "fields": {
                "Schema": req.schema,
                "列": col_names.join(", "),
                "列数": req.columns.len(),
                "索引数": req.indexes.len(),
            }
        })),
        None,
    );
    Ok(Json(result))
}

/// POST /api/v1/:database_slug/ddl/tables
pub async fn v1_create_table(
    State(main_pool): State<PgPool>,
    Extension(subject): Extension<DdlAuthSubject>,
    db_id: Option<Extension<CurrentDatabaseId>>,
    dynamic_pool: Option<Extension<PgPool>>,
    Path(_database_slug): Path<String>,
    Json(req): Json<CreateTableRequest>,
) -> Result<Json<Value>> {
    let database_id = require_database_id(db_id)?;
    enforce_ddl_access(&main_pool, &subject, database_id, &req.schema, &req.table).await?;
    let pool = dynamic_pool.as_deref().unwrap_or(&main_pool);
    let result = create_table_inner(pool, &req).await?;
    invalidate_column_types(database_id, &req.schema, &req.table);
    tracing::info!(
        target = "ddl",
        "{} (db {}) created table {}.{} via v1 API",
        ddl_actor_label(&subject),
        database_id,
        req.schema,
        req.table,
    );
    Ok(Json(result))
}

// ─── 操作日志（operation_logs）打点辅助 ─────────────────────────────

/// 把结构化 ALTER 操作集整理成 [`operation_log::format_change`] 认识的
/// `{v,kind:"modified",added,modified,removed}` 事实。无操作则 `None`。
fn alter_ops_to_change(table: &str, ops: &[AlterOp]) -> Option<Value> {
    let mut added: Vec<Value> = Vec::new();
    let mut removed: Vec<Value> = Vec::new();
    let mut modified: Vec<Value> = Vec::new();
    for op in ops {
        match op {
            AlterOp::AddColumn { column } => {
                added.push(json!({ "node": column.name, "node_type": column.data_type }));
            }
            AlterOp::DropColumn { name, .. } => {
                removed.push(json!({ "node": name, "node_type": "列" }));
            }
            AlterOp::RenameTable { new_name } => {
                modified.push(json!({ "node": table, "field": "表名", "old": table, "new": new_name }));
            }
            AlterOp::RenameColumn { old_name, new_name } => {
                modified.push(json!({ "node": old_name, "field": "列名", "old": old_name, "new": new_name }));
            }
            AlterOp::AlterColumnType { name, column } => {
                modified.push(json!({ "node": name, "field": "类型", "old": "—", "new": column.data_type }));
            }
            AlterOp::SetNotNull { name, value } => {
                modified.push(json!({ "node": name, "field": "NOT NULL", "old": "—", "new": if *value { "是" } else { "否" } }));
            }
            AlterOp::SetDefault { name, value } => {
                let nv = value.clone().unwrap_or_else(|| "(无)".to_string());
                modified.push(json!({ "node": name, "field": "默认值", "old": "—", "new": nv }));
            }
            AlterOp::AddUnique { name } => {
                modified.push(json!({ "node": name, "field": "唯一约束", "old": "—", "new": "UNIQUE" }));
            }
        }
    }
    if added.is_empty() && removed.is_empty() && modified.is_empty() {
        return None;
    }
    Some(json!({ "v": 1, "kind": "modified", "added": added, "modified": modified, "removed": removed }))
}

/// 破坏性 ALTER 判定：**删列 = 列及其数据不可逆丢失 → 高危**。
/// 加列 / 改名 / 改类型 / 加约束等非破坏性，不算高危。
fn alter_ops_high_risk(ops: &[AlterOp]) -> bool {
    ops.iter().any(|op| matches!(op, AlterOp::DropColumn { .. }))
}

async fn create_table_inner(pool: &PgPool, req: &CreateTableRequest) -> Result<Value> {
    check_schema_allowed(&req.schema)?;
    check_ident("表名", &req.table)?;
    if req.columns.is_empty() {
        return Err(AppError::InvalidQuery("至少需要 1 列才能建表".to_string()));
    }

    let pk_count = req.columns.iter().filter(|c| c.is_primary_key).count();
    if pk_count > 1 {
        return Err(AppError::InvalidQuery(
            "v1 不支持复合主键；请用单列主键 + 唯一约束/索引等价表达".to_string(),
        ));
    }

    let mut column_lines = Vec::with_capacity(req.columns.len());
    for c in &req.columns {
        column_lines.push(render_column_line(c)?);
    }

    let create_sql = format!(
        r#"CREATE TABLE "{}"."{}" ({})"#,
        req.schema,
        req.table,
        column_lines.join(", ")
    );

    let mut index_sqls = Vec::with_capacity(req.indexes.len());
    for idx in &req.indexes {
        check_ident("索引名", &idx.name)?;
        if idx.columns.is_empty() {
            return Err(AppError::InvalidQuery(format!(
                "索引 '{}' 至少需要 1 列",
                idx.name
            )));
        }
        let mut col_idents = Vec::with_capacity(idx.columns.len());
        for c in &idx.columns {
            check_ident("索引列", c)?;
            col_idents.push(format!(r#""{}""#, c));
        }
        let unique = if idx.is_unique { "UNIQUE " } else { "" };
        index_sqls.push(format!(
            r#"CREATE {}INDEX "{}" ON "{}"."{}" ({})"#,
            unique,
            idx.name,
            req.schema,
            req.table,
            col_idents.join(", "),
        ));
    }

    let mut tx = pool.begin().await?;
    sqlx::query(&create_sql)
        .execute(&mut *tx)
        .await
        .map_err(|e| AppError::Internal(format!("CREATE TABLE 失败: {}", e)))?;
    for sql in &index_sqls {
        sqlx::query(sql)
            .execute(&mut *tx)
            .await
            .map_err(|e| AppError::Internal(format!("CREATE INDEX 失败: {}", e)))?;
    }
    tx.commit().await?;

    Ok(json!({
        "success": true,
        "schema": req.schema,
        "table":  req.table,
        "columns": req.columns.len(),
        "indexes": req.indexes.len(),
    }))
}

/// DELETE /api/ddl/tables/:schema/:table?cascade=true
pub async fn drop_table(
    State(main_pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    db_id: Option<Extension<CurrentDatabaseId>>,
    dynamic_pool: Option<Extension<PgPool>>,
    Path((schema, table)): Path<(String, String)>,
    Query(q): Query<DropTableQuery>,
) -> Result<Json<Value>> {
    let database_id = require_database_id(db_id)?;
    permissions::require_database_member(&main_pool, &claims, database_id).await?;
    let pool = dynamic_pool.as_deref().unwrap_or(&main_pool);
    let result = drop_table_inner(pool, &schema, &table, q.cascade).await?;
    invalidate_column_types(database_id, &schema, &table);
    tracing::info!(
        target = "ddl",
        "user {} (db {}) dropped table {}.{} (cascade={})",
        claims.sub,
        database_id,
        schema,
        table,
        q.cascade,
    );
    operation_log::record_db_op(
        &main_pool,
        database_id,
        Actor::from_claims(&claims),
        Source::Console,
        operation_log::action::DELETE,
        operation_log::resource_type::TABLE,
        Some(format!("{}.{}", schema, table)),
        None,
        format!("删除数据表「{}.{}」", schema, table),
        Status::Success,
        None, // 由 derive_high_risk 判定为高危
        Some(json!({
            "v": 1, "kind": "deleted",
            "fields": { "Schema": schema, "级联删除": q.cascade }
        })),
        None,
    );
    Ok(Json(result))
}

/// DELETE /api/v1/:database_slug/ddl/tables/:schema/:table
pub async fn v1_drop_table(
    State(main_pool): State<PgPool>,
    Extension(subject): Extension<DdlAuthSubject>,
    db_id: Option<Extension<CurrentDatabaseId>>,
    dynamic_pool: Option<Extension<PgPool>>,
    Path((_database_slug, schema, table)): Path<(String, String, String)>,
    Query(q): Query<DropTableQuery>,
) -> Result<Json<Value>> {
    let database_id = require_database_id(db_id)?;
    enforce_ddl_access(&main_pool, &subject, database_id, &schema, &table).await?;
    let pool = dynamic_pool.as_deref().unwrap_or(&main_pool);
    let result = drop_table_inner(pool, &schema, &table, q.cascade).await?;
    invalidate_column_types(database_id, &schema, &table);
    tracing::info!(
        target = "ddl",
        "{} (db {}) dropped table {}.{} via v1 API (cascade={})",
        ddl_actor_label(&subject),
        database_id,
        schema,
        table,
        q.cascade,
    );
    Ok(Json(result))
}

async fn drop_table_inner(
    pool: &PgPool,
    schema: &str,
    table: &str,
    cascade: bool,
) -> Result<Value> {
    check_schema_allowed(schema)?;
    check_ident("表名", table)?;

    let cascade_sql = if cascade { " CASCADE" } else { "" };
    let sql = format!(r#"DROP TABLE "{}"."{}"{}"#, schema, table, cascade_sql);
    sqlx::query(&sql)
        .execute(pool)
        .await
        .map_err(|e| AppError::Internal(format!("DROP TABLE 失败: {}", e)))?;

    Ok(json!({
        "success": true,
        "schema":  schema,
        "table":   table,
        "cascade": cascade,
    }))
}

/// PATCH /api/ddl/tables/:schema/:table
pub async fn alter_table(
    State(main_pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    db_id: Option<Extension<CurrentDatabaseId>>,
    dynamic_pool: Option<Extension<PgPool>>,
    Path((schema, table)): Path<(String, String)>,
    Json(req): Json<AlterTableRequest>,
) -> Result<Json<Value>> {
    let database_id = require_database_id(db_id)?;
    permissions::require_database_member(&main_pool, &claims, database_id).await?;
    let pool = dynamic_pool.as_deref().unwrap_or(&main_pool);
    let result = alter_table_inner(pool, &schema, &table, &req.operations).await?;
    invalidate_column_types(database_id, &schema, &table);
    tracing::info!(
        target = "ddl",
        "user {} (db {}) altered table {}.{}: {} operations",
        claims.sub,
        database_id,
        schema,
        table,
        req.operations.len(),
    );
    let destructive = alter_ops_high_risk(&req.operations);
    let summary = if destructive {
        format!("修改数据表「{}.{}」结构（含删列）", schema, table)
    } else {
        format!("修改数据表「{}.{}」结构", schema, table)
    };
    operation_log::record_db_op(
        &main_pool,
        database_id,
        Actor::from_claims(&claims),
        Source::Console,
        operation_log::action::UPDATE,
        operation_log::resource_type::TABLE,
        Some(format!("{}.{}", schema, table)),
        None,
        summary,
        Status::Success,
        destructive.then_some(true),
        alter_ops_to_change(&table, &req.operations),
        None,
    );
    Ok(Json(result))
}

/// PATCH /api/v1/:database_slug/ddl/tables/:schema/:table
pub async fn v1_alter_table(
    State(main_pool): State<PgPool>,
    Extension(subject): Extension<DdlAuthSubject>,
    db_id: Option<Extension<CurrentDatabaseId>>,
    dynamic_pool: Option<Extension<PgPool>>,
    Path((_database_slug, schema, table)): Path<(String, String, String)>,
    Json(req): Json<AlterTableRequest>,
) -> Result<Json<Value>> {
    let database_id = require_database_id(db_id)?;
    enforce_ddl_access(&main_pool, &subject, database_id, &schema, &table).await?;
    let pool = dynamic_pool.as_deref().unwrap_or(&main_pool);
    let result = alter_table_inner(pool, &schema, &table, &req.operations).await?;
    invalidate_column_types(database_id, &schema, &table);
    tracing::info!(
        target = "ddl",
        "{} (db {}) altered table {}.{} via v1 API: {} operations",
        ddl_actor_label(&subject),
        database_id,
        schema,
        table,
        req.operations.len(),
    );
    Ok(Json(result))
}

async fn alter_table_inner(
    pool: &PgPool,
    schema: &str,
    table: &str,
    operations: &[AlterOp],
) -> Result<Value> {
    check_schema_allowed(schema)?;
    check_ident("表名", table)?;
    if operations.is_empty() {
        return Err(AppError::InvalidQuery("operations 不能为空".to_string()));
    }

    let mut sqls = Vec::with_capacity(operations.len());
    let mut current_table = table.to_string();
    for op in operations {
        sqls.push(render_alter_op(schema, &current_table, op)?);
        if let AlterOp::RenameTable { new_name } = op {
            current_table = new_name.clone();
        }
    }

    let mut tx = pool.begin().await?;
    for sql in &sqls {
        sqlx::query(sql)
            .execute(&mut *tx)
            .await
            .map_err(|e| AppError::Internal(format!("ALTER TABLE 失败: {}", e)))?;
    }
    tx.commit().await?;

    Ok(json!({
        "success":    true,
        "schema":     schema,
        "table":      table,
        "operations": operations.len(),
    }))
}

fn render_alter_op(schema: &str, table: &str, op: &AlterOp) -> Result<String> {
    let prefix = format!(r#"ALTER TABLE "{}"."{}""#, schema, table);
    match op {
        AlterOp::RenameTable { new_name } => {
            check_ident("新表名", new_name)?;
            Ok(format!(r#"{} RENAME TO "{}""#, prefix, new_name))
        }
        AlterOp::AddColumn { column } => {
            let line = render_column_line(column)?;
            Ok(format!("{} ADD COLUMN {}", prefix, line))
        }
        AlterOp::DropColumn { name, cascade } => {
            check_ident("列名", name)?;
            let casc = if *cascade { " CASCADE" } else { "" };
            Ok(format!(r#"{} DROP COLUMN "{}"{}"#, prefix, name, casc))
        }
        AlterOp::RenameColumn { old_name, new_name } => {
            check_ident("旧列名", old_name)?;
            check_ident("新列名", new_name)?;
            Ok(format!(
                r#"{} RENAME COLUMN "{}" TO "{}""#,
                prefix, old_name, new_name
            ))
        }
        AlterOp::AlterColumnType { name, column } => {
            check_ident("列名", name)?;
            let typ = render_column_type(column)?;
            Ok(format!(
                r#"{} ALTER COLUMN "{}" TYPE {}"#,
                prefix, name, typ
            ))
        }
        AlterOp::SetNotNull { name, value } => {
            check_ident("列名", name)?;
            let verb = if *value {
                "SET NOT NULL"
            } else {
                "DROP NOT NULL"
            };
            Ok(format!(r#"{} ALTER COLUMN "{}" {}"#, prefix, name, verb))
        }
        AlterOp::SetDefault { name, value } => {
            check_ident("列名", name)?;
            match value {
                Some(v) if !v.is_empty() => Ok(format!(
                    r#"{} ALTER COLUMN "{}" SET DEFAULT {}"#,
                    prefix,
                    name,
                    render_default(v),
                )),
                _ => Ok(format!(
                    r#"{} ALTER COLUMN "{}" DROP DEFAULT"#,
                    prefix, name
                )),
            }
        }
        AlterOp::AddUnique { name } => {
            check_ident("列名", name)?;
            let constraint = format!("{}_{}_key", table, name);
            check_ident("唯一约束名", &constraint)?;
            Ok(format!(
                r#"{} ADD CONSTRAINT "{}" UNIQUE ("{}")"#,
                prefix, constraint, name
            ))
        }
    }
}

// 防止 sqlx::Row 在 panic 后 "unused import" warning
#[allow(dead_code)]
fn _row_marker(r: &sqlx::postgres::PgRow) -> i32 {
    r.get(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pg_ident_rules() {
        assert!(is_valid_pg_ident("posts"));
        assert!(is_valid_pg_ident("_underscore"));
        assert!(is_valid_pg_ident("table_2026"));
        assert!(!is_valid_pg_ident(""));
        assert!(!is_valid_pg_ident("2starts"));
        assert!(!is_valid_pg_ident("with space"));
        assert!(!is_valid_pg_ident("has-dash"));
        assert!(!is_valid_pg_ident(&"x".repeat(64)));
    }

    #[test]
    fn schema_blacklist() {
        assert!(check_schema_allowed("public").is_ok());
        assert!(check_schema_allowed("app_data").is_ok());
        assert!(check_schema_allowed("management").is_err());
        assert!(check_schema_allowed("Management").is_err()); // case-insensitive
        assert!(check_schema_allowed("pg_catalog").is_err());
    }

    #[test]
    fn type_whitelist() {
        assert!(check_data_type("integer").is_ok());
        assert!(check_data_type("VARCHAR").is_ok());
        assert!(check_data_type("uuid").is_ok());
        assert!(check_data_type("hstore").is_err());
        assert!(check_data_type("'; DROP TABLE x;").is_err());
    }

    #[test]
    fn default_rendering() {
        assert_eq!(render_default("hello"), "'hello'");
        assert_eq!(render_default("it's"), "'it''s'");
        assert_eq!(render_default("CURRENT_TIMESTAMP"), "CURRENT_TIMESTAMP");
        assert_eq!(render_default("current_timestamp"), "CURRENT_TIMESTAMP");
        assert_eq!(render_default("now()"), "NOW()");
    }

    #[test]
    fn column_line_basic() {
        let col = ColumnDef {
            name: "id".into(),
            data_type: "serial".into(),
            length: None,
            precision: None,
            scale: None,
            nullable: false,
            default_value: None,
            is_primary_key: true,
            is_unique: false,
            references: None,
        };
        let line = render_column_line(&col).unwrap();
        assert!(line.contains(r#""id" serial"#));
        assert!(line.contains("PRIMARY KEY"));
    }

    #[test]
    fn alter_op_rendering() {
        let drop = AlterOp::DropColumn {
            name: "stale".into(),
            cascade: true,
        };
        let s = render_alter_op("public", "posts", &drop).unwrap();
        assert_eq!(
            s,
            r#"ALTER TABLE "public"."posts" DROP COLUMN "stale" CASCADE"#
        );

        let setnull = AlterOp::SetNotNull {
            name: "title".into(),
            value: true,
        };
        let s2 = render_alter_op("public", "posts", &setnull).unwrap();
        assert_eq!(
            s2,
            r#"ALTER TABLE "public"."posts" ALTER COLUMN "title" SET NOT NULL"#
        );

        let rename_table = AlterOp::RenameTable {
            new_name: "articles".into(),
        };
        assert_eq!(
            render_alter_op("public", "posts", &rename_table).unwrap(),
            r#"ALTER TABLE "public"."posts" RENAME TO "articles""#
        );

        let rename_col = AlterOp::RenameColumn {
            old_name: "title".into(),
            new_name: "headline".into(),
        };
        assert_eq!(
            render_alter_op("public", "posts", &rename_col).unwrap(),
            r#"ALTER TABLE "public"."posts" RENAME COLUMN "title" TO "headline""#
        );

        let alter_type = AlterOp::AlterColumnType {
            name: "headline".into(),
            column: ColumnDef {
                name: "headline".into(),
                data_type: "varchar".into(),
                length: Some(128),
                precision: None,
                scale: None,
                nullable: true,
                default_value: None,
                is_primary_key: false,
                is_unique: false,
                references: None,
            },
        };
        assert_eq!(
            render_alter_op("public", "posts", &alter_type).unwrap(),
            r#"ALTER TABLE "public"."posts" ALTER COLUMN "headline" TYPE varchar(128)"#
        );

        let unique = AlterOp::AddUnique {
            name: "headline".into(),
        };
        assert_eq!(
            render_alter_op("public", "posts", &unique).unwrap(),
            r#"ALTER TABLE "public"."posts" ADD CONSTRAINT "posts_headline_key" UNIQUE ("headline")"#
        );
    }

    #[test]
    fn alter_ops_change_maps_add_drop_modify() {
        let ops = vec![
            AlterOp::AddColumn {
                column: ColumnDef {
                    name: "views".into(),
                    data_type: "integer".into(),
                    length: None,
                    precision: None,
                    scale: None,
                    nullable: true,
                    default_value: None,
                    is_primary_key: false,
                    is_unique: false,
                    references: None,
                },
            },
            AlterOp::DropColumn {
                name: "legacy".into(),
                cascade: false,
            },
            AlterOp::RenameColumn {
                old_name: "title".into(),
                new_name: "headline".into(),
            },
            AlterOp::RenameTable {
                new_name: "articles".into(),
            },
        ];
        let change = alter_ops_to_change("posts", &ops).unwrap();
        assert_eq!(change["kind"], "modified");
        assert_eq!(change["added"][0]["node"], "views");
        assert_eq!(change["added"][0]["node_type"], "integer");
        assert_eq!(change["removed"][0]["node"], "legacy");
        // 改列名 + 改表名都归到 modified
        let modified = change["modified"].as_array().unwrap();
        assert!(modified.iter().any(|m| m["field"] == "列名" && m["new"] == "headline"));
        assert!(modified.iter().any(|m| m["field"] == "表名" && m["old"] == "posts" && m["new"] == "articles"));

        // 空操作 → None
        assert!(alter_ops_to_change("posts", &[]).is_none());
    }

    #[test]
    fn alter_high_risk_only_on_drop_column() {
        // 删列 = 高危
        assert!(alter_ops_high_risk(&[AlterOp::DropColumn {
            name: "val".into(),
            cascade: false,
        }]));
        // 混入删列也算高危
        assert!(alter_ops_high_risk(&[
            AlterOp::RenameTable { new_name: "t2".into() },
            AlterOp::DropColumn { name: "old".into(), cascade: true },
        ]));
        // 纯非破坏性 → 非高危
        assert!(!alter_ops_high_risk(&[
            AlterOp::AddColumn {
                column: ColumnDef {
                    name: "c".into(), data_type: "text".into(), length: None, precision: None,
                    scale: None, nullable: true, default_value: None, is_primary_key: false,
                    is_unique: false, references: None,
                },
            },
            AlterOp::RenameColumn { old_name: "a".into(), new_name: "b".into() },
        ]));
        assert!(!alter_ops_high_risk(&[]));
    }
}
