use crate::error::{AppError, Result};
use crate::middleware::CurrentDatabaseId;
use crate::query_builder::{fetch_column_types, QueryParams, SqlBuilder};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Extension, Json,
};
use serde_json::Value;
use sqlx::PgPool;
use std::collections::HashMap;

/// 将数据库行转换为 JSON 值（智能类型处理，含 uuid）
fn row_to_json(row: &sqlx::postgres::PgRow) -> Value {
    crate::pg_row_json::pg_row_to_json(row)
}

/// 选择目标连接池：**必须**是 dynamic_db_middleware 注入的租户库。
///
/// 历史上这里在没注入时回落到管理库（main_pool）。但这组遗留 CRUD 接口现在对项目
/// 成员开放（不再仅超管），若仍回落管理库，等于让任意成员在平台 management 库上跑
/// `SELECT * FROM users` —— 跨租户/平台数据泄漏。因此改为：拿不到租户库直接 403。
/// 正常请求里 `legacy_crud_access_middleware` 已先行保证 X-Database-Id 存在，这里是
/// 第二道防线。
fn pick_pool<'a>(dynamic_pool: &'a Option<Extension<PgPool>>) -> Result<&'a PgPool> {
    dynamic_pool.as_deref().ok_or_else(|| {
        AppError::Forbidden(
            "该接口必须通过 X-Database-Id 指定项目数据库，禁止在平台管理库上执行".to_string(),
        )
    })
}

fn require_db_id(db_id: Option<Extension<CurrentDatabaseId>>) -> Result<i32> {
    db_id
        .map(|Extension(CurrentDatabaseId(id))| id)
        .ok_or_else(|| {
            AppError::Forbidden(
                "该接口必须通过 X-Database-Id 指定项目数据库，禁止在平台管理库上执行".to_string(),
            )
        })
}

/// GET /api/:schema/:table - 查询数据
pub async fn get_records(
    State(_main_pool): State<PgPool>,
    dynamic_pool: Option<Extension<PgPool>>,
    db_id: Option<Extension<CurrentDatabaseId>>,
    Path((schema, table)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    tracing::debug!("GET /api/{}/{} - 查询参数: {:?}", schema, table, query);

    let pool = pick_pool(&dynamic_pool)?;
    let database_id = require_db_id(db_id)?;

    let params = QueryParams::from_query_map(query)?;

    // 拉一次列类型，让 SqlBuilder 给每个 `$N` 加上 `::col_type` cast，
    // 否则 query string 里的纯文本（例如 ?id=42）跟 bigint 列比较会触发类型不匹配。
    let col_types = fetch_column_types(pool, database_id, &schema, &table)
        .await
        .unwrap_or_default();

    let builder = SqlBuilder::new(schema, table, params)?.with_column_types(col_types);
    let (sql, args) = builder.build_select()?;

    tracing::debug!("执行 SQL: {}", sql);

    let rows = sqlx::query_with(&sql, args).fetch_all(pool).await?;

    let results: Vec<Value> = rows.iter().map(row_to_json).collect();

    Ok(Json(Value::Array(results)))
}

/// POST /api/:schema/:table - 插入数据
pub async fn create_record(
    State(_main_pool): State<PgPool>,
    dynamic_pool: Option<Extension<PgPool>>,
    db_id: Option<Extension<CurrentDatabaseId>>,
    Path((schema, table)): Path<(String, String)>,
    Json(data): Json<Value>,
) -> Result<(StatusCode, Json<Value>)> {
    tracing::debug!("POST /api/{}/{} - 数据: {:?}", schema, table, data);

    let pool = pick_pool(&dynamic_pool)?;
    let database_id = require_db_id(db_id)?;

    // 一次性把列类型读出来，下面循环复用——避免在多行 INSERT 时反复查 information_schema。
    let col_types = fetch_column_types(pool, database_id, &schema, &table)
        .await
        .unwrap_or_default();

    let records = match data {
        Value::Array(arr) => arr,
        other => vec![other],
    };

    let mut results = Vec::new();

    for record in records {
        let builder = SqlBuilder::new(schema.clone(), table.clone(), QueryParams::default())?
            .with_column_types(col_types.clone());
        let (sql, args) = builder.build_insert(&record)?;

        tracing::debug!("执行 SQL: {}", sql);

        let row = sqlx::query_with(&sql, args).fetch_one(pool).await?;

        results.push(row_to_json(&row));
    }

    let response = if results.len() == 1 {
        results.into_iter().next().unwrap_or(Value::Null)
    } else {
        Value::Array(results)
    };

    Ok((StatusCode::CREATED, Json(response)))
}

/// PATCH /api/:schema/:table - 更新数据
pub async fn update_records(
    State(_main_pool): State<PgPool>,
    dynamic_pool: Option<Extension<PgPool>>,
    db_id: Option<Extension<CurrentDatabaseId>>,
    Path((schema, table)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
    Json(data): Json<Value>,
) -> Result<Json<Value>> {
    tracing::debug!(
        "PATCH /api/{}/{} - 查询参数: {:?}, 数据: {:?}",
        schema,
        table,
        query,
        data
    );

    let pool = pick_pool(&dynamic_pool)?;
    let database_id = require_db_id(db_id)?;

    let params = QueryParams::from_query_map(query)?;

    let col_types = fetch_column_types(pool, database_id, &schema, &table)
        .await
        .unwrap_or_default();

    let builder = SqlBuilder::new(schema, table, params)?.with_column_types(col_types);
    let (sql, args) = builder.build_update(&data)?;

    tracing::debug!("执行 SQL: {}", sql);

    let rows = sqlx::query_with(&sql, args).fetch_all(pool).await?;

    let results: Vec<Value> = rows.iter().map(row_to_json).collect();

    Ok(Json(Value::Array(results)))
}

/// DELETE /api/:schema/:table - 删除数据
pub async fn delete_records(
    State(_main_pool): State<PgPool>,
    dynamic_pool: Option<Extension<PgPool>>,
    db_id: Option<Extension<CurrentDatabaseId>>,
    Path((schema, table)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<(StatusCode, Json<Value>)> {
    tracing::debug!("DELETE /api/{}/{} - 查询参数: {:?}", schema, table, query);

    let pool = pick_pool(&dynamic_pool)?;
    let database_id = require_db_id(db_id)?;

    let params = QueryParams::from_query_map(query)?;

    let col_types = fetch_column_types(pool, database_id, &schema, &table)
        .await
        .unwrap_or_default();

    let builder = SqlBuilder::new(schema, table, params)?.with_column_types(col_types);
    let (sql, args) = builder.build_delete()?;

    tracing::debug!("执行 SQL: {}", sql);

    let rows = sqlx::query_with(&sql, args).fetch_all(pool).await?;

    let results: Vec<Value> = rows.iter().map(row_to_json).collect();

    Ok((StatusCode::OK, Json(Value::Array(results))))
}
