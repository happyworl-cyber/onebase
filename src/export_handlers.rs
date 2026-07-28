use crate::auth::Claims;
use crate::error::{AppError, Result};
use crate::middleware::CurrentDatabaseId;
use crate::permissions;
use crate::query_builder::{QueryParams, SqlBuilder};
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde_json::Value;
use sqlx::{Column, PgPool, Row};
use std::collections::HashMap;

/// 选目标连接池：`dynamic_db_middleware` 给的优先；没注入直接拒绝——
/// 旧实现是"没 db_id 就用 main_pool"，等于把租户表导出请求悄悄落到管理库上，
/// 既会返回错误数据，又会泄漏 management schema。所以这里 strict 一些。
fn require_target_pool<'a>(
    dynamic: &'a Option<Extension<PgPool>>,
) -> Result<&'a PgPool> {
    dynamic.as_deref().ok_or_else(|| {
        AppError::InvalidQuery(
            "缺少 X-Database-Id 请求头，无法定位导出目标数据库".to_string(),
        )
    })
}

/// 导出接口统一鉴权：必须带 `X-Database-Id` 且为该 db 的 owner/admin（或平台超管）。
/// 导出本质是批量拉数据，权限应当对齐"管理这个 db"——viewer / 普通 RBAC 角色就算配了
/// `SELECT *.*` 也不应该一键拖整张表，那条门走 `auto_api`（带 pagination + 行级条件）。
async fn require_export_access(
    main_pool: &PgPool,
    claims: &Claims,
    db_id: Option<Extension<CurrentDatabaseId>>,
) -> Result<()> {
    let database_id = db_id
        .map(|Extension(CurrentDatabaseId(id))| id)
        .ok_or_else(|| {
            AppError::InvalidQuery(
                "缺少 X-Database-Id 请求头，无法定位导出目标数据库".to_string(),
            )
        })?;
    permissions::require_database_admin(main_pool, claims, database_id).await
}

/// GET /api/export/csv/:schema/:table - 导出为 CSV
pub async fn export_csv(
    State(main_pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    db_id: Option<Extension<CurrentDatabaseId>>,
    dynamic_pool: Option<Extension<PgPool>>,
    Path((schema, table)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response> {
    require_export_access(&main_pool, &claims, db_id).await?;
    let pool = require_target_pool(&dynamic_pool)?;
    let params = QueryParams::from_query_map(query)?;
    let builder = SqlBuilder::new(schema.clone(), table.clone(), params)?;
    let (sql, args) = builder.build_select()?;
    tracing::debug!("导出 CSV - 执行 SQL: {}", sql);
    let rows = sqlx::query_with(&sql, args).fetch_all(pool).await?;

    if rows.is_empty() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/csv"),
        );
        return Ok((StatusCode::OK, headers, "".to_string()).into_response());
    }

    let mut csv = String::new();
    let columns: Vec<String> = rows[0]
        .columns()
        .iter()
        .map(|col| escape_csv_field(col.name()))
        .collect();
    csv.push_str(&columns.join(","));
    csv.push('\n');

    // CSV 数据行
    for row in &rows {
        let mut values = Vec::new();
        for (i, _column) in row.columns().iter().enumerate() {
            let value = get_value_as_string(&row, i);
            values.push(escape_csv_field(&value));
        }
        csv.push_str(&values.join(","));
        csv.push('\n');
    }

    let filename = format!("{}_{}.csv", schema, table);
    let disposition = format!("attachment; filename=\"{}\"", filename);
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/csv; charset=utf-8"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&disposition)
            .unwrap_or_else(|_| HeaderValue::from_static("attachment; filename=\"export.csv\"")),
    );

    Ok((StatusCode::OK, headers, csv).into_response())
}

/// GET /api/export/json/:schema/:table - 导出为 JSON
pub async fn export_json(
    State(main_pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    db_id: Option<Extension<CurrentDatabaseId>>,
    dynamic_pool: Option<Extension<PgPool>>,
    Path((schema, table)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response> {
    require_export_access(&main_pool, &claims, db_id).await?;
    let pool = require_target_pool(&dynamic_pool)?;
    let params = QueryParams::from_query_map(query)?;
    let builder = SqlBuilder::new(schema.clone(), table.clone(), params)?;
    let (sql, args) = builder.build_select()?;
    tracing::debug!("导出 JSON - 执行 SQL: {}", sql);
    let rows = sqlx::query_with(&sql, args).fetch_all(pool).await?;

    // 转换为 JSON
    let results: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut obj = serde_json::Map::new();
            for column in row.columns() {
                let key = column.name().to_string();
                let idx = column.ordinal();

                // 尝试不同的类型
                let value: Value = if let Ok(v) = row.try_get::<String, _>(idx) {
                    Value::String(v)
                } else if let Ok(v) = row.try_get::<i32, _>(idx) {
                    serde_json::json!(v)
                } else if let Ok(v) = row.try_get::<i64, _>(idx) {
                    serde_json::json!(v)
                } else if let Ok(v) = row.try_get::<f64, _>(idx) {
                    serde_json::json!(v)
                } else if let Ok(v) = row.try_get::<bool, _>(idx) {
                    Value::Bool(v)
                } else if let Ok(v) = row.try_get::<Option<String>, _>(idx) {
                    v.map(Value::String).unwrap_or(Value::Null)
                } else if let Ok(v) = row.try_get::<Option<i32>, _>(idx) {
                    v.map(|n| serde_json::json!(n)).unwrap_or(Value::Null)
                } else if let Ok(v) = row.try_get::<Option<i64>, _>(idx) {
                    v.map(|n| serde_json::json!(n)).unwrap_or(Value::Null)
                } else if let Ok(v) = row.try_get::<serde_json::Value, _>(idx) {
                    v
                } else {
                    Value::Null
                };

                obj.insert(key, value);
            }
            Value::Object(obj)
        })
        .collect();

    let json_str = serde_json::to_string_pretty(&results)?;

    let filename = format!("{}_{}.json", schema, table);
    let disposition = format!("attachment; filename=\"{}\"", filename);
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&disposition)
            .unwrap_or_else(|_| HeaderValue::from_static("attachment; filename=\"export.json\"")),
    );

    Ok((StatusCode::OK, headers, json_str).into_response())
}

/// POST /api/export/sql - 导出 SQL 查询结果为 CSV
/// POST /api/export/sql/csv - 用任意 SELECT 跑一次导出
///
/// 鉴权特例：**仅平台超管**。这条接口允许跑任意 SQL（哪怕只是 SELECT），
/// pg_catalog / 系统视图 / 跨 schema 关联都能命中，租户管理员开放 = 给一个
/// 绕 RBAC 的后门。租户管理员自己的 ad-hoc 导出走 per-table 接口即可。
pub async fn export_sql_csv(
    State(_main_pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    db_id: Option<Extension<CurrentDatabaseId>>,
    dynamic_pool: Option<Extension<PgPool>>,
    Json(req): Json<serde_json::Value>,
) -> Result<Response> {
    permissions::require_platform_superadmin(&claims)?;
    // 必须带 X-Database-Id；否则会落到管理库导出 management.* 数据。
    let _ = db_id.as_ref().ok_or_else(|| {
        AppError::InvalidQuery(
            "缺少 X-Database-Id 请求头，无法定位导出目标数据库".to_string(),
        )
    })?;
    let pool = require_target_pool(&dynamic_pool)?;

    let sql = req
        .get("sql")
        .and_then(|s| s.as_str())
        .ok_or_else(|| crate::error::AppError::InvalidQuery("缺少 sql 参数".to_string()))?;

    let sql_upper = sql.trim().to_uppercase();
    if !sql_upper.starts_with("SELECT") && !sql_upper.starts_with("WITH") {
        return Err(crate::error::AppError::InvalidQuery(
            "只允许执行 SELECT 查询语句".to_string(),
        ));
    }

    tracing::debug!("导出 SQL 查询结果 - 执行 SQL: {}", sql);
    let rows = sqlx::query(sql).fetch_all(pool).await?;

    if rows.is_empty() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/csv"),
        );
        return Ok((StatusCode::OK, headers, "".to_string()).into_response());
    }

    // 构建 CSV
    let mut csv = String::new();

    // CSV 头部（列名）
    let columns: Vec<String> = rows[0]
        .columns()
        .iter()
        .map(|col| escape_csv_field(col.name()))
        .collect();
    csv.push_str(&columns.join(","));
    csv.push('\n');

    // CSV 数据行
    for row in &rows {
        let mut values = Vec::new();
        for (i, _column) in row.columns().iter().enumerate() {
            let value = get_value_as_string(&row, i);
            values.push(escape_csv_field(&value));
        }
        csv.push_str(&values.join(","));
        csv.push('\n');
    }

    // 设置响应头
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/csv; charset=utf-8"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment; filename=\"query_result.csv\""),
    );

    Ok((StatusCode::OK, headers, csv).into_response())
}

/// 转义 CSV 字段
fn escape_csv_field(field: &str) -> String {
    if field.contains(',') || field.contains('"') || field.contains('\n') {
        format!("\"{}\"", field.replace('"', "\"\""))
    } else {
        field.to_string()
    }
}

/// 从行中获取值作为字符串
fn get_value_as_string(row: &sqlx::postgres::PgRow, idx: usize) -> String {
    if let Ok(v) = row.try_get::<String, _>(idx) {
        v
    } else if let Ok(v) = row.try_get::<i32, _>(idx) {
        v.to_string()
    } else if let Ok(v) = row.try_get::<i64, _>(idx) {
        v.to_string()
    } else if let Ok(v) = row.try_get::<f64, _>(idx) {
        v.to_string()
    } else if let Ok(v) = row.try_get::<bool, _>(idx) {
        v.to_string()
    } else if let Ok(v) = row.try_get::<Option<String>, _>(idx) {
        v.unwrap_or_else(|| "NULL".to_string())
    } else if let Ok(v) = row.try_get::<Option<i32>, _>(idx) {
        v.map(|n| n.to_string()).unwrap_or_else(|| "NULL".to_string())
    } else if let Ok(v) = row.try_get::<Option<i64>, _>(idx) {
        v.map(|n| n.to_string()).unwrap_or_else(|| "NULL".to_string())
    } else if let Ok(v) = row.try_get::<serde_json::Value, _>(idx) {
        v.to_string()
    } else {
        "NULL".to_string()
    }
}

