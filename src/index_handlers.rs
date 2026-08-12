//! 索引管理 (Indexes)
//!
//! 提供 PostgreSQL 索引的列出 / 创建 / 删除能力。
//!
//! 设计要点：
//! - 所有标识符（schema/table/index/column）都先经过 `is_valid_identifier`
//!   严格白名单校验，再以 `quote_ident` 双引号包裹拼接 SQL —— 拒绝任何拼接型注入。
//! - 表达式索引 (`expression`) 与部分索引 (`where_clause`) 是裸 SQL 片段，
//!   仅对长度做上限保护，**信任调用方为已认证的超管**（与 schema DDL 同等权限）。
//! - 创建/删除使用普通 `pool.execute`，不会包到事务里，因此 `CONCURRENTLY`
//!   能正常工作（PostgreSQL 不允许在事务块里跑 CONCURRENTLY）。

use crate::auth::Claims;
use crate::error::{AppError, Result};
use crate::middleware::CurrentDatabaseId;
use crate::operation_log::{self, Actor, Source, Status};
use crate::rbac_handlers::{require_schema_permission, require_table_permission};
use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{PgPool, Row};

/// 读权限——列出索引。
const ACTION_READ: &str = "SELECT";
/// 写权限——创建/删除索引。索引 DDL 视为表层结构变更，最严格，仅放行 `ALL`。
const ACTION_WRITE: &str = "ALL";

/// 从扩展中拿到 `database_id`，没有则报错（说明前端忘记带 `X-Database-Id` 头）。
fn require_database_id(opt: Option<Extension<CurrentDatabaseId>>) -> Result<i32> {
    opt.map(|Extension(CurrentDatabaseId(id))| id)
        .ok_or_else(|| {
            AppError::InvalidQuery("缺少 X-Database-Id 请求头，无法定位目标数据库".to_string())
        })
}

// ---------- 标识符校验与转义 ----------

/// PostgreSQL 标准标识符限制：63 字节、字母/数字/下划线、不以数字开头。
fn is_valid_identifier(name: &str) -> bool {
    if name.is_empty() || name.len() > 63 {
        return false;
    }
    let first = match name.chars().next() {
        Some(c) => c,
        None => return false,
    };
    if !first.is_ascii_alphabetic() && first != '_' {
        return false;
    }
    name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 将合法标识符转义为 `"name"` 形式（即便已经 `is_valid_identifier`，
/// 双引号包裹仍是必要的——某些保留字否则会被解析失败）。
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

// ---------- 列出索引 ----------

#[derive(Debug, Serialize)]
pub struct IndexRow {
    pub schema: String,
    pub table: String,
    pub name: String,
    pub method: String,
    pub is_unique: bool,
    pub is_primary: bool,
    pub is_valid: bool,
    pub columns: Vec<String>,
    pub definition: String,
    pub size: String,
    pub size_bytes: i64,
}

#[derive(Debug, Deserialize)]
pub struct ListIndexesQuery {
    /// 可选：按表名过滤（同 schema 内）。
    pub table: Option<String>,
}

/// GET /api/indexes/:schema
pub async fn list_indexes(
    State(main_pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    db_id_ext: Option<Extension<CurrentDatabaseId>>,
    Path(schema): Path<String>,
    Query(q): Query<ListIndexesQuery>,
    dynamic_pool: Option<Extension<PgPool>>,
) -> Result<Json<Vec<IndexRow>>> {
    let pool = dynamic_pool.as_deref().unwrap_or(&main_pool);

    if !is_valid_identifier(&schema) {
        return Err(AppError::InvalidQuery("无效的 schema 名".to_string()));
    }
    if let Some(t) = &q.table {
        if !is_valid_identifier(t) {
            return Err(AppError::InvalidQuery("无效的表名".to_string()));
        }
    }

    // RBAC：
    // - 指定了 table → 该表上需要 SELECT；
    // - 未指定 → 需要 schema 通配 SELECT（避免越权扫到无权访问的表元数据）。
    let database_id = require_database_id(db_id_ext)?;
    if let Some(t) = &q.table {
        require_table_permission(&main_pool, claims.sub, database_id, &schema, t, ACTION_READ)
            .await?;
    } else {
        require_schema_permission(&main_pool, claims.sub, database_id, &schema, ACTION_READ)
            .await?;
    }

    // 通过 pg_index/pg_class 拿索引元数据，pg_get_indexdef 拿到原始 DDL，
    // pg_relation_size 拿磁盘占用；列名通过 indkey + pg_attribute 拼装，
    // 表达式列在 pg_attribute 里没有名字（attnum=0），用 pg_get_indexdef 拿表达式回填。
    let rows = sqlx::query(
        r#"
        SELECT
            n.nspname                                    AS schema_name,
            t.relname                                    AS table_name,
            i.relname                                    AS index_name,
            am.amname                                    AS method,
            ix.indisunique                               AS is_unique,
            ix.indisprimary                              AS is_primary,
            ix.indisvalid                                AS is_valid,
            pg_get_indexdef(ix.indexrelid)               AS definition,
            pg_size_pretty(pg_relation_size(ix.indexrelid)) AS size,
            pg_relation_size(ix.indexrelid)::BIGINT      AS size_bytes,
            (
                SELECT array_agg(
                    CASE
                      WHEN k = 0 THEN
                        pg_get_indexdef(ix.indexrelid, ord::int, true)
                      ELSE
                        (SELECT a.attname FROM pg_attribute a
                          WHERE a.attrelid = t.oid AND a.attnum = k)
                    END
                    ORDER BY ord
                )
                FROM unnest(ix.indkey) WITH ORDINALITY AS u(k, ord)
            )                                            AS columns
        FROM pg_class t
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_index ix    ON ix.indrelid = t.oid
        JOIN pg_class i     ON i.oid = ix.indexrelid
        JOIN pg_am am       ON am.oid = i.relam
        WHERE n.nspname = $1
          AND ($2::text IS NULL OR t.relname = $2)
          AND t.relkind IN ('r','m','p')      -- table / matview / partitioned table
        ORDER BY t.relname, i.relname
        "#,
    )
    .bind(&schema)
    .bind(&q.table)
    .fetch_all(pool)
    .await?;

    let result: Vec<IndexRow> = rows
        .into_iter()
        .map(|row| {
            let cols_opt: Option<Vec<Option<String>>> = row.try_get("columns").ok();
            let columns: Vec<String> = cols_opt
                .unwrap_or_default()
                .into_iter()
                .map(|c| c.unwrap_or_default())
                .collect();
            IndexRow {
                schema: row.get("schema_name"),
                table: row.get("table_name"),
                name: row.get("index_name"),
                method: row.get("method"),
                is_unique: row.get("is_unique"),
                is_primary: row.get("is_primary"),
                is_valid: row.get("is_valid"),
                columns,
                definition: row.get("definition"),
                size: row.get::<Option<String>, _>("size").unwrap_or_default(),
                size_bytes: row.get::<Option<i64>, _>("size_bytes").unwrap_or(0),
            }
        })
        .collect();

    Ok(Json(result))
}

// ---------- 创建索引 ----------

#[derive(Debug, Deserialize)]
pub struct IndexColumnInput {
    /// 列名；与 `expression` 二选一。
    pub name: Option<String>,
    /// 表达式（如 `lower(email)`）；与 `name` 二选一。
    pub expression: Option<String>,
    /// 排序方向：ASC / DESC。
    pub ordering: Option<String>,
    /// NULLS 顺序：FIRST / LAST。
    pub nulls: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateIndexRequest {
    pub schema: String,
    pub table: String,
    pub name: String,
    /// btree / hash / gin / gist / brin / spgist
    pub method: Option<String>,
    pub unique: Option<bool>,
    /// CONCURRENTLY，避免锁表
    pub concurrent: Option<bool>,
    pub if_not_exists: Option<bool>,
    pub columns: Vec<IndexColumnInput>,
    /// INCLUDE 覆盖列（PostgreSQL 11+）
    pub include: Option<Vec<String>>,
    /// WHERE 过滤条件（部分索引）
    pub where_clause: Option<String>,
}

const ALLOWED_METHODS: &[&str] = &["btree", "hash", "gin", "gist", "brin", "spgist"];

/// POST /api/indexes
pub async fn create_index(
    State(main_pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    db_id_ext: Option<Extension<CurrentDatabaseId>>,
    dynamic_pool: Option<Extension<PgPool>>,
    Json(req): Json<CreateIndexRequest>,
) -> Result<Json<serde_json::Value>> {
    let pool = dynamic_pool.as_deref().unwrap_or(&main_pool);

    if !is_valid_identifier(&req.schema) {
        return Err(AppError::InvalidQuery("无效的 schema 名".to_string()));
    }
    if !is_valid_identifier(&req.table) {
        return Err(AppError::InvalidQuery("无效的表名".to_string()));
    }
    if !is_valid_identifier(&req.name) {
        return Err(AppError::InvalidQuery(
            "索引名只允许字母数字和下划线，且不能以数字开头（最长 63 字符）".to_string(),
        ));
    }
    if req.columns.is_empty() {
        return Err(AppError::InvalidQuery(
            "索引至少需要一列或一个表达式".to_string(),
        ));
    }

    // RBAC：表层 DDL，要求该表上的 ALL 权限。
    let database_id = require_database_id(db_id_ext)?;
    require_table_permission(
        &main_pool,
        claims.sub,
        database_id,
        &req.schema,
        &req.table,
        ACTION_WRITE,
    )
    .await?;

    let method = req
        .method
        .as_deref()
        .unwrap_or("btree")
        .to_ascii_lowercase();
    if !ALLOWED_METHODS.contains(&method.as_str()) {
        return Err(AppError::InvalidQuery(format!(
            "不支持的索引类型 '{}'，可选: {}",
            method,
            ALLOWED_METHODS.join(", ")
        )));
    }

    // 列 / 表达式 — 拼装 (col1 ASC NULLS LAST, (lower(name)), ...)
    let mut col_parts: Vec<String> = Vec::with_capacity(req.columns.len());
    for (i, c) in req.columns.iter().enumerate() {
        let core = match (c.name.as_deref(), c.expression.as_deref()) {
            (Some(n), None) | (Some(n), Some("")) => {
                if !is_valid_identifier(n) {
                    return Err(AppError::InvalidQuery(format!(
                        "第 {} 列的列名 '{}' 不合法",
                        i + 1,
                        n
                    )));
                }
                quote_ident(n)
            }
            (None, Some(e)) | (Some(""), Some(e)) => {
                let trimmed = e.trim();
                if trimmed.is_empty() {
                    return Err(AppError::InvalidQuery(format!(
                        "第 {} 列的表达式不能为空",
                        i + 1
                    )));
                }
                if trimmed.len() > 1000 {
                    return Err(AppError::InvalidQuery(format!(
                        "第 {} 列的表达式过长（>1000 字符）",
                        i + 1
                    )));
                }
                // 表达式必须用括号包裹，否则 PostgreSQL 解析失败
                format!("({})", trimmed)
            }
            _ => {
                return Err(AppError::InvalidQuery(format!(
                    "第 {} 列必须填写「列名」或「表达式」其中之一",
                    i + 1
                )));
            }
        };

        let mut part = core;
        if let Some(ord) = c.ordering.as_deref().map(|s| s.trim().to_ascii_uppercase()) {
            if !ord.is_empty() {
                if ord != "ASC" && ord != "DESC" {
                    return Err(AppError::InvalidQuery(
                        "排序方向只能是 ASC 或 DESC".to_string(),
                    ));
                }
                part.push(' ');
                part.push_str(&ord);
            }
        }
        if let Some(nulls) = c.nulls.as_deref().map(|s| s.trim().to_ascii_uppercase()) {
            if !nulls.is_empty() {
                if nulls != "FIRST" && nulls != "LAST" {
                    return Err(AppError::InvalidQuery(
                        "NULLS 顺序只能是 FIRST 或 LAST".to_string(),
                    ));
                }
                part.push_str(" NULLS ");
                part.push_str(&nulls);
            }
        }
        col_parts.push(part);
    }

    // INCLUDE
    let include_clause = if let Some(inc) = req.include.as_ref().filter(|v| !v.is_empty()) {
        for n in inc {
            if !is_valid_identifier(n) {
                return Err(AppError::InvalidQuery(format!(
                    "INCLUDE 列名 '{}' 不合法",
                    n
                )));
            }
        }
        let joined: Vec<String> = inc.iter().map(|n| quote_ident(n)).collect();
        format!(" INCLUDE ({})", joined.join(", "))
    } else {
        String::new()
    };

    // WHERE（部分索引）—— 自由 SQL，但裹一层括号、限长。
    let where_clause = if let Some(w) = req.where_clause.as_ref().map(|s| s.trim()) {
        if w.is_empty() {
            String::new()
        } else if w.len() > 2000 {
            return Err(AppError::InvalidQuery(
                "WHERE 子句过长（>2000 字符）".to_string(),
            ));
        } else {
            format!(" WHERE ({})", w)
        }
    } else {
        String::new()
    };

    let unique = req.unique.unwrap_or(false);
    let concurrent = req.concurrent.unwrap_or(false);
    let if_not_exists = req.if_not_exists.unwrap_or(false);

    let sql = format!(
        "CREATE {unique}INDEX {concurrent}{ine}{name} ON {schema}.{table} USING {method} ({cols}){include}{wh}",
        unique      = if unique { "UNIQUE " } else { "" },
        concurrent  = if concurrent { "CONCURRENTLY " } else { "" },
        ine         = if if_not_exists { "IF NOT EXISTS " } else { "" },
        name        = quote_ident(&req.name),
        schema      = quote_ident(&req.schema),
        table       = quote_ident(&req.table),
        method      = method,
        cols        = col_parts.join(", "),
        include     = include_clause,
        wh          = where_clause,
    );

    tracing::info!("创建索引: {}", sql);
    sqlx::query(&sql).execute(pool).await?;

    let col_desc: Vec<String> = req
        .columns
        .iter()
        .map(|c| {
            c.name
                .clone()
                .filter(|s| !s.is_empty())
                .or_else(|| c.expression.clone())
                .unwrap_or_default()
        })
        .collect();
    operation_log::record_db_op(
        &main_pool,
        database_id,
        Actor::from_claims(&claims),
        Source::Console,
        operation_log::action::CREATE,
        operation_log::resource_type::INDEX,
        Some(req.name.clone()),
        None,
        format!("在「{}.{}」上创建索引「{}」", req.schema, req.table, req.name),
        Status::Success,
        None,
        Some(json!({
            "v": 1, "kind": "created",
            "fields": {
                "表": format!("{}.{}", req.schema, req.table),
                "方法": method,
                "唯一": if unique { "是" } else { "否" },
                "列": col_desc.join(", "),
            }
        })),
        None,
    );

    Ok(Json(json!({
        "success": true,
        "name": req.name,
        "sql": sql,
    })))
}

// ---------- 删除索引 ----------

#[derive(Debug, Deserialize)]
pub struct DropIndexQuery {
    /// CONCURRENTLY，避免锁表
    pub concurrent: Option<bool>,
    pub cascade: Option<bool>,
    pub if_exists: Option<bool>,
}

/// DELETE /api/indexes/:schema/:index_name
pub async fn drop_index(
    State(main_pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    db_id_ext: Option<Extension<CurrentDatabaseId>>,
    Path((schema, index_name)): Path<(String, String)>,
    Query(q): Query<DropIndexQuery>,
    dynamic_pool: Option<Extension<PgPool>>,
) -> Result<Json<serde_json::Value>> {
    let pool = dynamic_pool.as_deref().unwrap_or(&main_pool);

    if !is_valid_identifier(&schema) {
        return Err(AppError::InvalidQuery("无效的 schema 名".to_string()));
    }
    if !is_valid_identifier(&index_name) {
        return Err(AppError::InvalidQuery("无效的索引名".to_string()));
    }

    // RBAC：先在租户库里反查该索引归属的表名，再要求该表的 ALL 权限。
    // 索引不存在时返回 404，避免泄露"存在与否"的差异。
    let owning_table: Option<(String,)> = sqlx::query_as(
        r#"
        SELECT t.relname AS table_name
        FROM pg_class i
        JOIN pg_namespace n ON n.oid = i.relnamespace
        JOIN pg_index ix    ON ix.indexrelid = i.oid
        JOIN pg_class t     ON t.oid = ix.indrelid
        WHERE n.nspname = $1 AND i.relname = $2
        "#,
    )
    .bind(&schema)
    .bind(&index_name)
    .fetch_optional(pool)
    .await?;

    let table_name = match owning_table {
        Some((t,)) => t,
        None => {
            return Err(AppError::NotFound(format!(
                "索引 {}.{} 不存在",
                schema, index_name
            )));
        }
    };

    let database_id = require_database_id(db_id_ext)?;
    require_table_permission(
        &main_pool,
        claims.sub,
        database_id,
        &schema,
        &table_name,
        ACTION_WRITE,
    )
    .await?;

    let concurrent = q.concurrent.unwrap_or(false);
    let cascade = q.cascade.unwrap_or(false);
    let if_exists = q.if_exists.unwrap_or(false);

    // PostgreSQL 限制：CONCURRENTLY 与 CASCADE 互斥；CONCURRENTLY 必须在事务块外。
    if concurrent && cascade {
        return Err(AppError::InvalidQuery(
            "CONCURRENTLY 与 CASCADE 不能同时使用".to_string(),
        ));
    }

    let sql = format!(
        "DROP INDEX {concurrent}{ie}{schema}.{name}{cascade}",
        concurrent = if concurrent { "CONCURRENTLY " } else { "" },
        ie = if if_exists { "IF EXISTS " } else { "" },
        schema = quote_ident(&schema),
        name = quote_ident(&index_name),
        cascade = if cascade { " CASCADE" } else { "" },
    );

    tracing::info!("删除索引: {}", sql);
    sqlx::query(&sql).execute(pool).await?;

    operation_log::record_db_op(
        &main_pool,
        database_id,
        Actor::from_claims(&claims),
        Source::Console,
        operation_log::action::DELETE,
        operation_log::resource_type::INDEX,
        Some(index_name.clone()),
        None,
        format!("删除索引「{}.{}」（表 {}）", schema, index_name, table_name),
        Status::Success,
        None,
        None,
        None,
    );

    Ok(Json(json!({
        "success": true,
        "name": index_name,
        "sql": sql,
    })))
}
