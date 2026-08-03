//! PostgreSQL 行 → JSON 的统一解码。
//!
//! Auto API / RPC / 工作流 DB 节点 / `/query` 都靠"按常见类型逐一 try_get"把
//! `PgRow` 转成 `serde_json::Value`。历史上这些函数各自复制一份，且都漏掉了
//! `uuid`——sqlx 不会把 UUID 自动当 `String` 解，于是真实存在的 UUID 主键会
//! 落到最终的 `Value::Null`，表现为"表里有 id，接口返回 null"。
//!
//! 本模块是唯一实现；其它调用点应复用 [`pg_row_to_json`]，避免再分叉漏类型。

use serde_json::{json, Value};
use sqlx::{Column, Row};
use uuid::Uuid;

/// 把一行 Postgres 结果解成 JSON object。
///
/// 未知 / 暂不支持的 PG 类型（如 `bytea`、自定义 domain）仍回退为 `null`，
/// 与历史行为一致；新增类型请在本函数补分支，而不是在调用点再写一份。
pub fn pg_row_to_json(row: &sqlx::postgres::PgRow) -> Value {
    let mut obj = serde_json::Map::new();
    for column in row.columns() {
        let key = column.name().to_string();
        let idx = column.ordinal();
        obj.insert(key, decode_pg_value(row, idx));
    }
    Value::Object(obj)
}

fn decode_pg_value(row: &sqlx::postgres::PgRow, idx: usize) -> Value {
    // jsonb / json 优先：避免被 String 路径误吃成文本。
    if let Ok(v) = row.try_get::<Value, _>(idx) {
        return v;
    }
    if let Ok(v) = row.try_get::<String, _>(idx) {
        return Value::String(v);
    }
    if let Ok(v) = row.try_get::<i32, _>(idx) {
        return json!(v);
    }
    if let Ok(v) = row.try_get::<i64, _>(idx) {
        return json!(v);
    }
    if let Ok(v) = row.try_get::<i16, _>(idx) {
        return json!(v);
    }
    if let Ok(v) = row.try_get::<f64, _>(idx) {
        return json!(v);
    }
    if let Ok(v) = row.try_get::<f32, _>(idx) {
        return json!(v);
    }
    if let Ok(v) = row.try_get::<bool, _>(idx) {
        return Value::Bool(v);
    }
    // UUID：必须显式解码。sqlx 不会把 uuid OID 当成 text/String。
    if let Ok(v) = row.try_get::<Uuid, _>(idx) {
        return Value::String(v.to_string());
    }
    if let Ok(v) = row.try_get::<Option<Uuid>, _>(idx) {
        return v.map(|u| Value::String(u.to_string())).unwrap_or(Value::Null);
    }
    if let Ok(v) = row.try_get::<Option<String>, _>(idx) {
        return v.map(Value::String).unwrap_or(Value::Null);
    }
    if let Ok(v) = row.try_get::<Option<i32>, _>(idx) {
        return v.map(|n| json!(n)).unwrap_or(Value::Null);
    }
    if let Ok(v) = row.try_get::<Option<i64>, _>(idx) {
        return v.map(|n| json!(n)).unwrap_or(Value::Null);
    }
    if let Ok(v) = row.try_get::<Option<i16>, _>(idx) {
        return v.map(|n| json!(n)).unwrap_or(Value::Null);
    }
    if let Ok(v) = row.try_get::<chrono::DateTime<chrono::Utc>, _>(idx) {
        return Value::String(v.to_rfc3339());
    }
    if let Ok(v) = row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(idx) {
        return v
            .map(|dt| Value::String(dt.to_rfc3339()))
            .unwrap_or(Value::Null);
    }
    if let Ok(v) = row.try_get::<chrono::NaiveDateTime, _>(idx) {
        return Value::String(v.format("%Y-%m-%dT%H:%M:%S%.f").to_string());
    }
    if let Ok(v) = row.try_get::<Option<chrono::NaiveDateTime>, _>(idx) {
        return v
            .map(|dt| Value::String(dt.format("%Y-%m-%dT%H:%M:%S%.f").to_string()))
            .unwrap_or(Value::Null);
    }
    if let Ok(v) = row.try_get::<chrono::NaiveDate, _>(idx) {
        return Value::String(v.to_string());
    }
    if let Ok(v) = row.try_get::<Option<chrono::NaiveDate>, _>(idx) {
        return v
            .map(|d| Value::String(d.to_string()))
            .unwrap_or(Value::Null);
    }
    if let Ok(v) = row.try_get::<chrono::NaiveTime, _>(idx) {
        return Value::String(v.to_string());
    }
    if let Ok(v) = row.try_get::<Option<chrono::NaiveTime>, _>(idx) {
        return v
            .map(|t| Value::String(t.to_string()))
            .unwrap_or(Value::Null);
    }
    if let Ok(v) = row.try_get::<Option<f64>, _>(idx) {
        return v.map(|n| json!(n)).unwrap_or(Value::Null);
    }
    if let Ok(v) = row.try_get::<Option<f32>, _>(idx) {
        return v.map(|n| json!(n)).unwrap_or(Value::Null);
    }
    if let Ok(v) = row.try_get::<Option<bool>, _>(idx) {
        return v.map(Value::Bool).unwrap_or(Value::Null);
    }
    Value::Null
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_formats_as_hyphenated_string() {
        let id = Uuid::parse_str("550e8400-e29b-41d4-a716-446655440000").unwrap();
        assert_eq!(
            Value::String(id.to_string()),
            json!("550e8400-e29b-41d4-a716-446655440000")
        );
    }

    async fn connect_test_pg() -> Option<sqlx::PgPool> {
        let url = std::env::var("DATABASE_URL_TEST")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .ok()?;
        sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .ok()
    }

    #[tokio::test]
    async fn smallint_and_real_decode_as_json_numbers_not_null() {
        let Some(pool) = connect_test_pg().await else {
            eprintln!("DATABASE_URL(_TEST) unset/unreachable, skip");
            return;
        };
        let row = sqlx::query(
            "SELECT 1::smallint AS s, NULL::smallint AS s_null, 1.5::real AS r, NULL::real AS r_null",
        )
        .fetch_one(&pool)
        .await
        .expect("query");
        let v = pg_row_to_json(&row);
        assert_eq!(v["s"], json!(1));
        assert_eq!(v["s_null"], Value::Null);
        assert_eq!(v["r"], json!(1.5));
        assert_eq!(v["r_null"], Value::Null);
    }
}
