use axum::{
    extract::{Extension, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Column, PgPool, Postgres, Row, Transaction};
use std::collections::HashMap;

use crate::error::AppError;
use crate::query_builder::QueryParams;

/// 事务操作类型
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "UPPERCASE")]
pub enum OperationType {
    Post,   // 插入
    Patch,  // 更新
    Delete, // 删除
}

/// 单个事务操作
#[derive(Debug, Deserialize)]
pub struct TransactionOperation {
    /// 操作类型
    pub method: OperationType,
    /// Schema 名称
    pub schema: String,
    /// 表名
    pub table: String,
    /// WHERE 条件（用于 PATCH 和 DELETE）
    #[serde(rename = "where")]
    pub conditions: Option<HashMap<String, String>>,
    /// 数据（用于 POST 和 PATCH）
    pub data: Option<Value>,
}

/// 事务请求
#[derive(Debug, Deserialize)]
pub struct TransactionRequest {
    /// 操作列表
    pub operations: Vec<TransactionOperation>,
}

/// 事务响应
#[derive(Debug, Serialize)]
pub struct TransactionResponse {
    /// 成功的操作数
    pub success_count: usize,
    /// 每个操作的结果
    pub results: Vec<Value>,
    /// 总耗时（毫秒）
    pub elapsed_ms: u128,
}

/// 执行事务
pub async fn execute_transaction(
    State(main_pool): State<PgPool>,
    dynamic_pool: Option<Extension<PgPool>>,
    db_id: Option<Extension<crate::middleware::CurrentDatabaseId>>,
    claims: Option<Extension<crate::auth::Claims>>,
    audit_sink: Option<Extension<crate::audit_middleware::AuditDetailSink>>,
    Json(req): Json<TransactionRequest>,
) -> Result<(StatusCode, Json<TransactionResponse>), AppError> {
    let start = std::time::Instant::now();
    let policy = crate::raw_sql_guard::policy();

    // 审计入口：与 `/query` 同套 `raw_sql_audit` target，记录"谁在哪个库上提交了
    // 多少条事务操作"。双轨：结构化日志 + `audit_logs.request_body` 落表。
    // /transaction 走的是 SqlBuilder（白名单操作符 + $N 占位参数化），不接收原始 SQL；
    // 即便如此仍是超管直连接口，留个轨迹方便复盘。
    let user_id = claims.as_deref().map(|c| c.sub).unwrap_or(-1);
    let target_db_id = db_id.as_deref().map(|d| d.0).unwrap_or(0);
    let op_count = req.operations.len();
    let push_audit = |kind: &'static str, blocked_reason: Option<&str>| {
        if let Some(Extension(ref sink)) = audit_sink {
            sink.set(serde_json::json!({
                "kind": kind,
                "user_id": user_id,
                "database_id": target_db_id,
                "op_count": op_count,
                "blocked_reason": blocked_reason,
            }));
        }
    };
    push_audit("raw_sql_txn", None);

    // ─── 安全闸：与 /query 用同一套 raw_sql_guard 不变量 ────────────────
    //   1) 必须显式指定 X-Database-Id，不再向管理库 fallback；
    //   2) 操作数 ≤ policy.max_operations（可通过环境变量覆盖，默认 100）；
    //   3) op_count > 0；
    //   4) tenant 级 schema 仍然要走 sanitize_identifier 防注入，这部分在 execute_insert
    //      / execute_update / execute_delete 里已有。
    let pool: &PgPool = match crate::raw_sql_guard::require_target_pool(dynamic_pool.as_deref()) {
        Ok(p) => p,
        Err(e) => {
            push_audit("raw_sql_txn", Some("missing_database_id"));
            return Err(e);
        }
    };
    if req.operations.is_empty() {
        push_audit("raw_sql_txn", Some("empty_operations"));
        return Err(AppError::InvalidQuery("事务操作列表不能为空".to_string()));
    }
    if req.operations.len() > policy.max_operations {
        push_audit("raw_sql_txn", Some("op_count_exceeds_max"));
        return Err(AppError::InvalidQuery(format!(
            "单个事务最多支持 {} 个操作（环境变量 RAW_SQL_MAX_OPERATIONS 可调）",
            policy.max_operations
        )));
    }

    tracing::warn!(
        target: "raw_sql_audit",
        event = "transaction_invoked",
        user_id = user_id,
        database_id = target_db_id,
        op_count = req.operations.len(),
        "超管提交多语句事务（/transaction）；操作通过 SqlBuilder 参数化生成，不接受原始 SQL"
    );

    // 单独 acquire 一条连接，先 `SET statement_timeout`，然后开事务跑 N 条 SQL，
    // 整个事务结束后 RESET 把连接还干净。与 /query 同套策略——所有 raw_sql 通道
    // 都被 PG 服务端的 statement_timeout 兜底，跑飞了 PG 会主动 abort。
    // 走 acquire_traced：池饱和时 fail-fast，避免干等满 connection_timeout。
    let mut conn = crate::pool_metrics::acquire_traced(pool, Some(target_db_id), "transaction")
        .await
        .map_err(AppError::Database)?;
    crate::raw_sql_guard::apply_session_guards(&mut conn, policy).await?;

    use sqlx::Connection;
    let mut tx = conn.begin().await?;

    let mut results = Vec::new();

    // 执行每个操作。任何一步出错，先 rollback + reset 再返回；不能让 SET 过的
    // statement_timeout 跟着这条连接回到池里污染下一个请求。
    let mut exec_err: Option<AppError> = None;
    for (index, op) in req.operations.iter().enumerate() {
        tracing::debug!(
            "执行事务操作 {}/{}: {:?} {}.{}",
            index + 1,
            req.operations.len(),
            op.method,
            op.schema,
            op.table
        );

        let res = match op.method {
            OperationType::Post => execute_insert(&mut tx, op).await,
            OperationType::Patch => execute_update(&mut tx, op).await,
            OperationType::Delete => execute_delete(&mut tx, op).await,
        };
        match res {
            Ok(v) => results.push(v),
            Err(e) => {
                exec_err = Some(e);
                break;
            }
        }
    }

    let commit_result = if let Some(e) = exec_err {
        let _ = tx.rollback().await;
        Err(e)
    } else {
        tx.commit().await.map_err(|e| {
            tracing::error!("事务提交失败: {}", e);
            AppError::Database(e)
        })
    };
    crate::raw_sql_guard::reset_session_guards(&mut conn).await;
    drop(conn);
    if let Err(e) = commit_result {
        push_audit("raw_sql_txn", Some("execute_or_commit_failed"));
        return Err(e);
    }

    let elapsed = start.elapsed().as_millis();

    tracing::info!("事务执行成功: {} 个操作，耗时 {}ms", results.len(), elapsed);

    // 操作日志打点：事务是一组参数化写操作（INSERT/UPDATE/DELETE），逐条列出表与动作。
    // tenant 由 record_db_op 按 target_db_id 反查；反查不到（管理库/无头）自动跳过。
    if target_db_id > 0 {
        if let Some(Extension(ref c)) = claims {
            let statements: Vec<Value> = req
                .operations
                .iter()
                .map(|op| {
                    let verb = match op.method {
                        OperationType::Post => "INSERT",
                        OperationType::Patch => "UPDATE",
                        OperationType::Delete => "DELETE",
                    };
                    serde_json::json!({ "op": verb, "table": format!("{}.{}", op.schema, op.table) })
                })
                .collect();
            crate::operation_log::record_db_op(
                &main_pool,
                target_db_id,
                crate::operation_log::Actor::from_claims(c),
                crate::operation_log::Source::Console,
                crate::operation_log::action::EXECUTE,
                crate::operation_log::resource_type::DATABASE,
                None,
                None,
                format!("执行事务（{} 个操作）", op_count),
                crate::operation_log::Status::Success,
                None,
                Some(serde_json::json!({ "v": 1, "kind": "sql", "statements": statements })),
                None,
            );
        }
    }

    Ok((
        StatusCode::OK,
        Json(TransactionResponse {
            success_count: results.len(),
            results,
            elapsed_ms: elapsed,
        }),
    ))
}

/// 执行插入操作
async fn execute_insert(
    tx: &mut Transaction<'_, Postgres>,
    op: &TransactionOperation,
) -> Result<Value, AppError> {
    let data = op
        .data
        .as_ref()
        .ok_or_else(|| AppError::InvalidQuery("POST 操作需要提供 data 字段".to_string()))?;

    // 验证标识符
    QueryParams::sanitize_identifier(&op.schema)?;
    QueryParams::sanitize_identifier(&op.table)?;

    // 构建 INSERT SQL
    let obj = data
        .as_object()
        .ok_or_else(|| AppError::InvalidQuery("data 必须是 JSON 对象".to_string()))?;

    if obj.is_empty() {
        return Err(AppError::InvalidQuery("data 不能为空".to_string()));
    }

    let mut columns = Vec::new();
    let mut placeholders = Vec::new();

    for (i, key) in obj.keys().enumerate() {
        QueryParams::sanitize_identifier(key)?;
        columns.push(format!("\"{}\"", key));
        placeholders.push(format!("${}", i + 1));
    }

    let sql = format!(
        "INSERT INTO \"{}\".\"{}\" ({}) VALUES ({}) RETURNING *",
        op.schema,
        op.table,
        columns.join(", "),
        placeholders.join(", ")
    );

    tracing::debug!("执行 SQL: {}", sql);

    // 构建查询
    let mut query = sqlx::query(&sql);
    for value in obj.values() {
        query = bind_json_value(query, value);
    }

    // 执行并返回结果
    let rows = query.fetch_all(&mut **tx).await?;
    rows_to_json(rows)
}

/// 执行更新操作
async fn execute_update(
    tx: &mut Transaction<'_, Postgres>,
    op: &TransactionOperation,
) -> Result<Value, AppError> {
    let data = op
        .data
        .as_ref()
        .ok_or_else(|| AppError::InvalidQuery("PATCH 操作需要提供 data 字段".to_string()))?;

    let conditions = op
        .conditions
        .as_ref()
        .ok_or_else(|| AppError::InvalidQuery("PATCH 操作需要提供 where 条件".to_string()))?;

    // 验证标识符
    QueryParams::sanitize_identifier(&op.schema)?;
    QueryParams::sanitize_identifier(&op.table)?;

    // 构建 UPDATE SQL
    let obj = data
        .as_object()
        .ok_or_else(|| AppError::InvalidQuery("data 必须是 JSON 对象".to_string()))?;

    if obj.is_empty() {
        return Err(AppError::InvalidQuery("data 不能为空".to_string()));
    }

    let mut set_clauses = Vec::new();
    let mut param_index = 1;

    for key in obj.keys() {
        QueryParams::sanitize_identifier(key)?;
        set_clauses.push(format!("\"{}\" = ${}", key, param_index));
        param_index += 1;
    }

    let mut sql = format!(
        "UPDATE \"{}\".\"{}\" SET {}",
        op.schema,
        op.table,
        set_clauses.join(", ")
    );

    // 添加 WHERE 条件
    let mut where_clauses = Vec::new();
    for (key, _) in conditions.iter() {
        QueryParams::sanitize_identifier(key)?;
        where_clauses.push(format!("\"{}\" = ${}", key, param_index));
        param_index += 1;
    }

    if !where_clauses.is_empty() {
        sql.push_str(&format!(" WHERE {}", where_clauses.join(" AND ")));
    }

    sql.push_str(" RETURNING *");

    tracing::debug!("执行 SQL: {}", sql);

    // 构建查询
    let mut query = sqlx::query(&sql);

    // 绑定 SET 值
    for value in obj.values() {
        query = bind_json_value(query, value);
    }

    // 绑定 WHERE 值
    for value in conditions.values() {
        query = query.bind(value);
    }

    let rows = query.fetch_all(&mut **tx).await?;
    rows_to_json(rows)
}

/// 执行删除操作
async fn execute_delete(
    tx: &mut Transaction<'_, Postgres>,
    op: &TransactionOperation,
) -> Result<Value, AppError> {
    let conditions = op
        .conditions
        .as_ref()
        .ok_or_else(|| AppError::InvalidQuery("DELETE 操作需要提供 where 条件".to_string()))?;

    // 验证标识符
    QueryParams::sanitize_identifier(&op.schema)?;
    QueryParams::sanitize_identifier(&op.table)?;

    // 构建 DELETE SQL
    let mut sql = format!("DELETE FROM \"{}\".\"{}\"", op.schema, op.table);

    let mut where_clauses = Vec::new();
    let mut param_index = 1;

    for (key, _) in conditions.iter() {
        QueryParams::sanitize_identifier(key)?;
        where_clauses.push(format!("\"{}\" = ${}", key, param_index));
        param_index += 1;
    }

    if where_clauses.is_empty() {
        return Err(AppError::InvalidQuery(
            "DELETE 操作必须提供 WHERE 条件，以防止误删除全表".to_string(),
        ));
    }

    sql.push_str(&format!(" WHERE {}", where_clauses.join(" AND ")));
    sql.push_str(" RETURNING *");

    tracing::debug!("执行 SQL: {}", sql);

    // 构建查询
    let mut query = sqlx::query(&sql);
    for value in conditions.values() {
        query = query.bind(value);
    }

    let rows = query.fetch_all(&mut **tx).await?;
    rows_to_json(rows)
}

/// 绑定 JSON 值到 SQL 查询
fn bind_json_value<'q>(
    query: sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments>,
    value: &'q Value,
) -> sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments> {
    match value {
        Value::Null => query.bind(None::<String>),
        Value::Bool(b) => query.bind(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                query.bind(i)
            } else if let Some(f) = n.as_f64() {
                query.bind(f)
            } else {
                query.bind(n.to_string())
            }
        }
        Value::String(s) => query.bind(s.as_str()),
        Value::Array(_) | Value::Object(_) => query.bind(value.to_string()),
    }
}

/// 将数据库行转换为 JSON
fn rows_to_json(rows: Vec<sqlx::postgres::PgRow>) -> Result<Value, AppError> {
    let mut result = Vec::new();

    for row in rows {
        let mut obj = serde_json::Map::new();

        for column in row.columns() {
            let key = column.name().to_string();
            let idx = column.ordinal();

            // 尝试获取不同类型的值
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

        result.push(Value::Object(obj));
    }

    Ok(Value::Array(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_transaction_request_deserialization() {
        let json = r#"{
            "operations": [
                {
                    "method": "POST",
                    "schema": "public",
                    "table": "users",
                    "data": {
                        "name": "Test User",
                        "email": "test@example.com"
                    }
                },
                {
                    "method": "PATCH",
                    "schema": "public",
                    "table": "users",
                    "where": {"id": "1"},
                    "data": {"status": "active"}
                }
            ]
        }"#;

        let req: TransactionRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.operations.len(), 2);
    }
}
