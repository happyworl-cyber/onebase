use crate::error::Result;
use crate::query_builder::{fetch_column_types, QueryParams, SqlBuilder};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Extension, Json,
};
use serde_json::Value;
use sqlx::{PgPool, Row, Column};
use std::collections::HashMap;

/// 将数据库行转换为 JSON 值（智能类型处理）
fn row_to_json(row: &sqlx::postgres::PgRow) -> Value {
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
}

/// 选择目标连接池：优先用 dynamic_db_middleware 注入的租户库，
/// 没注入（即调用方没带 X-Database-Id）才落回管理库。
///
/// 这与 schema_handlers / execute_sql_query 的策略保持一致——前端在选定项目后
/// 会自动带上 X-Database-Id 请求头，路由也跟着切到租户的实际数据库。
fn pick_pool<'a>(
    main_pool: &'a PgPool,
    dynamic_pool: &'a Option<Extension<PgPool>>,
) -> &'a PgPool {
    dynamic_pool.as_deref().unwrap_or(main_pool)
}

/// GET /api/:schema/:table - 查询数据
pub async fn get_records(
    State(main_pool): State<PgPool>,
    dynamic_pool: Option<Extension<PgPool>>,
    Path((schema, table)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    tracing::debug!("GET /api/{}/{} - 查询参数: {:?}", schema, table, query);

    let pool = pick_pool(&main_pool, &dynamic_pool);

    let params = QueryParams::from_query_map(query)?;

    // 拉一次列类型，让 SqlBuilder 给每个 `$N` 加上 `::col_type` cast，
    // 否则 query string 里的纯文本（例如 ?id=42）跟 bigint 列比较会触发类型不匹配。
    let col_types = fetch_column_types(pool, &schema, &table).await.unwrap_or_default();

    let builder = SqlBuilder::new(schema, table, params)?.with_column_types(col_types);
    let (sql, args) = builder.build_select()?;

    tracing::debug!("执行 SQL: {}", sql);

    let rows = sqlx::query_with(&sql, args)
        .fetch_all(pool)
        .await?;

    let results: Vec<Value> = rows.iter().map(row_to_json).collect();

    Ok(Json(Value::Array(results)))
}

/// POST /api/:schema/:table - 插入数据
pub async fn create_record(
    State(main_pool): State<PgPool>,
    dynamic_pool: Option<Extension<PgPool>>,
    Path((schema, table)): Path<(String, String)>,
    Json(data): Json<Value>,
) -> Result<(StatusCode, Json<Value>)> {
    tracing::debug!("POST /api/{}/{} - 数据: {:?}", schema, table, data);

    let pool = pick_pool(&main_pool, &dynamic_pool);

    // 一次性把列类型读出来，下面循环复用——避免在多行 INSERT 时反复查 information_schema。
    let col_types = fetch_column_types(pool, &schema, &table).await.unwrap_or_default();

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

        let row = sqlx::query_with(&sql, args)
            .fetch_one(pool)
            .await?;

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
    State(main_pool): State<PgPool>,
    dynamic_pool: Option<Extension<PgPool>>,
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

    let pool = pick_pool(&main_pool, &dynamic_pool);

    let params = QueryParams::from_query_map(query)?;

    let col_types = fetch_column_types(pool, &schema, &table).await.unwrap_or_default();

    let builder = SqlBuilder::new(schema, table, params)?.with_column_types(col_types);
    let (sql, args) = builder.build_update(&data)?;

    tracing::debug!("执行 SQL: {}", sql);

    let rows = sqlx::query_with(&sql, args)
        .fetch_all(pool)
        .await?;

    let results: Vec<Value> = rows.iter().map(row_to_json).collect();

    Ok(Json(Value::Array(results)))
}

/// DELETE /api/:schema/:table - 删除数据
pub async fn delete_records(
    State(main_pool): State<PgPool>,
    dynamic_pool: Option<Extension<PgPool>>,
    Path((schema, table)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<(StatusCode, Json<Value>)> {
    tracing::debug!("DELETE /api/{}/{} - 查询参数: {:?}", schema, table, query);

    let pool = pick_pool(&main_pool, &dynamic_pool);

    let params = QueryParams::from_query_map(query)?;

    let col_types = fetch_column_types(pool, &schema, &table).await.unwrap_or_default();

    let builder = SqlBuilder::new(schema, table, params)?.with_column_types(col_types);
    let (sql, args) = builder.build_delete()?;

    tracing::debug!("执行 SQL: {}", sql);

    let rows = sqlx::query_with(&sql, args)
        .fetch_all(pool)
        .await?;

    let results: Vec<Value> = rows.iter().map(row_to_json).collect();

    Ok((StatusCode::OK, Json(Value::Array(results))))
}

