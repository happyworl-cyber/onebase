//! Auto API - 自动生成的 RESTful API
//! 
//! 根据数据库表结构自动提供 CRUD 接口
//! 
//! URL 格式: /api/v1/{database_id}/{schema}/{table}
//! 
//! 支持的操作:
//! - GET    /api/v1/{db}/{schema}/{table}        - 查询列表
//! - GET    /api/v1/{db}/{schema}/{table}/{id}   - 查询单条
//! - POST   /api/v1/{db}/{schema}/{table}        - 创建记录
//! - PATCH  /api/v1/{db}/{schema}/{table}/{id}   - 更新记录
//! - DELETE /api/v1/{db}/{schema}/{table}/{id}   - 删除记录

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Column, PgPool, Postgres, Row, Transaction};

use crate::audit_middleware::SlowQueryLogger;
use crate::auth::Claims;
use crate::circuit_breaker::CircuitBreakerManager;
use crate::error::{AppError, Result};
use crate::events::{ChangeAction, DataChangeEvent, EventBus};
use crate::permissions;
use crate::pool_manager::POOL_MANAGER;
use crate::postgrest_compat;
use crate::query_cache::QueryCache;
use crate::rbac_models::{PermissionResult, RowCondition, RowOp};
use crate::redis_manager::RedisManager;

/// 在事务内把当前 JWT 用户 ID 注入到 PostgreSQL session 变量 `app.current_user_id`
/// （第三个参数 `true` = 事务局部 GUC，等价于 `SET LOCAL`，COMMIT/ROLLBACK 后自动清除）。
///
/// 供业务库的 PostgreSQL Row-Level Security POLICY 读取。
/// 未登录调用（仅在通过 API Key 时可能）会写入字符串 "0"，配合 RLS 模板里的
/// `NULLIF(current_setting('app.current_user_id', true), '0')::int` 可以识别匿名身份。
async fn inject_session_user_id(
    tx: &mut Transaction<'_, Postgres>,
    user_id: i32,
) -> Result<()> {
    sqlx::query("SELECT set_config('app.current_user_id', $1, true)")
        .bind(user_id.to_string())
        .execute(&mut **tx)
        .await
        .map_err(AppError::Database)?;
    Ok(())
}

/// 从 Claims 提取用户 ID；无 claims（API Key 调用）时返回 0。
fn user_id_from_claims(claims: &Option<axum::extract::Extension<Claims>>) -> i32 {
    claims.as_ref().map(|c| c.0.sub).unwrap_or(0)
}

/// 把单个 JSON 值转为 sqlx bind 用的字符串。
///
/// 注意：这里返回的字符串只是**承载值的形态**，**不是**最终 bind 到 PG 的类型；
/// 真正的类型推断在 [`bind_inferred`] 里按字面值形态决定（数字→i64/f64、
/// true/false→bool、null→SQL NULL、其它→text）。
///
/// 历史包袱：早期注释写"PG 自动把 string cast 到目标列类型" —— 这是错的，PG 不做
/// implicit text → integer cast，导致 `WHERE int_col = $1`（bind text）报
/// `operator does not exist: integer = text`。修复后 bind 路径见 [`bind_inferred`]。
fn value_to_bind_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// 按字面值形态推断类型，bind 到 sqlx Query。
///
/// PG 不做 implicit `text → integer` cast：如果列是 `integer` 但 sqlx 把 String
/// 编码成 `text` 传过去，PG 会报 `operator does not exist: integer = text`。修复
/// 思路是 bind 时根据字面值选择合适的 Rust 类型，让 PG prepared statement 拿到
/// 的参数类型尽量贴近列类型：
///
/// | 字面值 | 推断类型 | PG 参数类型 |
/// |---|---|---|
/// | `null` (任意大小写) | `Option<i64>::None` | NULL |
/// | `true` / `false` | `bool` | bool |
/// | 纯整数 | `i64` | bigint（PG 自动转 int2/int4） |
/// | 数字含小数点 / 科学计数 | `f64` | double precision |
/// | 其它 | `&str` | text |
///
/// **已知 edge case**：列是 `text` 但 query 值是数字字面值（如 `?id=eq.123`，id 是
/// UUID 文本列）—— 这里会 bind i64，PG 报 `text = bigint` 不存在。这种 case 当前
/// 罕见，后续若需要彻底覆盖可改成"查 information_schema 缓存列类型按列类型 bind"，
/// 与 PostgREST 同款思路。
fn bind_inferred<'q>(
    q: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    raw: &'q str,
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    let trimmed = raw.trim();
    if trimmed.eq_ignore_ascii_case("null") {
        return q.bind(Option::<i64>::None);
    }
    if trimmed.eq_ignore_ascii_case("true") {
        return q.bind(true);
    }
    if trimmed.eq_ignore_ascii_case("false") {
        return q.bind(false);
    }
    // 整数优先：避免 "1" 被 f64 接收变成 double precision，触发"数值精度不精确"
    // 类的 cast 问题（PG 对 numeric / int 严格分离）
    if let Ok(i) = trimmed.parse::<i64>() {
        return q.bind(i);
    }
    if let Ok(f) = trimmed.parse::<f64>() {
        return q.bind(f);
    }
    // 字符串场景：原始 raw 包含可能的前后空白；尊重业务方原始输入而不是 trim 后
    // 的值（PG text 列对空白敏感）
    q.bind(raw)
}

/// 判定一行待插入的数据是否满足 RBAC 行条件。
///
/// 用于 POST/INSERT：避免低权用户把记录写进"不属于自己"的行（如把 user_id 设成别人的）。
/// 实现：对每个 row_condition，检查请求体中对应字段（缺失视为不满足）。
fn check_insert_satisfies_row_condition(
    obj: &serde_json::Map<String, serde_json::Value>,
    cond: &RowCondition,
) -> std::result::Result<(), String> {
    use serde_json::Value as JV;

    // IsNull/IsNotNull 类操作：客户端如果没传字段，视为 NULL。
    let v = obj.get(&cond.field);

    let value_eq = |a: &JV, b: &JV| -> bool {
        match (a, b) {
            (JV::Null, JV::Null) => true,
            (JV::Number(x), JV::Number(y)) => x == y,
            (JV::String(x), JV::String(y)) => x == y,
            (JV::Bool(x), JV::Bool(y)) => x == y,
            // 其余跨类型情况全部当成不相等
            _ => false,
        }
    };

    match cond.op {
        RowOp::Eq => match v {
            Some(actual) if value_eq(actual, &cond.value) => Ok(()),
            _ => Err(format!("列 {} 必须 = {}", cond.field, cond.value)),
        },
        RowOp::Neq => match v {
            Some(actual) if !value_eq(actual, &cond.value) => Ok(()),
            None => Ok(()), // 未传 = NULL，与多数值不等
            _ => Err(format!("列 {} 必须 != {}", cond.field, cond.value)),
        },
        RowOp::IsNull => {
            if v.is_none() || matches!(v, Some(JV::Null)) {
                Ok(())
            } else {
                Err(format!("列 {} 必须为 NULL", cond.field))
            }
        }
        RowOp::IsNotNull => match v {
            Some(actual) if !matches!(actual, JV::Null) => Ok(()),
            _ => Err(format!("列 {} 不能为 NULL", cond.field)),
        },
        // 数值类比较：用 f64 近似比较；INSERT 时一般用 Eq，比较类操作放宽为"如果数值能比就比，否则放过"
        // 这一块在 INSERT 路径上很少见，做最严判断会误伤业务，所以保守：未提供字段判失败，提供字段则按值比
        RowOp::Gt | RowOp::Gte | RowOp::Lt | RowOp::Lte => {
            let actual = v.ok_or_else(|| format!("列 {} 缺失", cond.field))?;
            let a = actual.as_f64().ok_or_else(|| format!("列 {} 不是数值", cond.field))?;
            let b = cond.value.as_f64().ok_or_else(|| "条件值不是数值".to_string())?;
            let ok = match cond.op {
                RowOp::Gt => a > b,
                RowOp::Gte => a >= b,
                RowOp::Lt => a < b,
                RowOp::Lte => a <= b,
                _ => unreachable!(),
            };
            if ok { Ok(()) } else { Err(format!("列 {} 不满足约束", cond.field)) }
        }
        RowOp::In => {
            let arr = cond.value.as_array().ok_or_else(|| "IN 条件值必须是数组".to_string())?;
            let actual = v.ok_or_else(|| format!("列 {} 缺失", cond.field))?;
            if arr.iter().any(|x| value_eq(x, actual)) {
                Ok(())
            } else {
                Err(format!("列 {} 不在允许的集合内", cond.field))
            }
        }
    }
}

/// 把 RBAC 行条件转换为 WHERE 片段 + bind 值，并返回新的占位符起始索引。
/// 所有值通过 `$N` 占位符参数化绑定，杜绝 SQL 注入。
fn append_rbac_where(
    where_clauses: &mut Vec<String>,
    bind_values: &mut Vec<String>,
    conds: &[RowCondition],
    start_index: usize,
) -> usize {
    let mut idx = start_index;
    for c in conds {
        // field 在 parse_row_conditions 时已经做过白名单校验
        match c.op {
            RowOp::IsNull => {
                where_clauses.push(format!("\"{}\" IS NULL", c.field));
            }
            RowOp::IsNotNull => {
                where_clauses.push(format!("\"{}\" IS NOT NULL", c.field));
            }
            RowOp::In => {
                let arr = c.value.as_array().cloned().unwrap_or_default();
                if arr.is_empty() {
                    where_clauses.push("FALSE".to_string());
                    continue;
                }
                let placeholders: Vec<String> = arr
                    .iter()
                    .map(|v| {
                        bind_values.push(value_to_bind_string(v));
                        let p = format!("${}", idx);
                        idx += 1;
                        p
                    })
                    .collect();
                where_clauses.push(format!(
                    "\"{}\" IN ({})",
                    c.field,
                    placeholders.join(", ")
                ));
            }
            other => {
                where_clauses.push(format!("\"{}\" {} ${}", c.field, other.as_sql(), idx));
                bind_values.push(value_to_bind_string(&c.value));
                idx += 1;
            }
        }
    }
    idx
}

/// 将结构化行条件序列化为 fingerprint 用的字符串集合
fn row_conditions_to_fingerprint(conds: &[RowCondition]) -> Vec<String> {
    conds
        .iter()
        .map(|c| {
            format!(
                "{}|{}|{}",
                c.field,
                c.op.as_sql(),
                serde_json::to_string(&c.value).unwrap_or_default()
            )
        })
        .collect()
}

/// 查询参数
#[derive(Debug, Deserialize)]
pub struct QueryParams {
    /// 选择的字段，逗号分隔
    pub select: Option<String>,
    /// 排序，格式: field.asc 或 field.desc
    pub order: Option<String>,
    /// 分页数量
    pub limit: Option<i64>,
    /// 分页偏移
    pub offset: Option<i64>,
}

/// API 响应结构
#[derive(Debug, Serialize, Deserialize)]
pub struct ApiResponse<T> {
    pub data: T,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 解密数据库密码（统一走 crypto 模块，兼容 v2 和老格式）
fn decrypt_db_password(encrypted: &str) -> String {
    crate::crypto::decrypt_secret_lossy(encrypted)
}

/// 从数据库行构造 DatabaseConfig
fn row_to_db_config(row: &sqlx::postgres::PgRow) -> crate::pool_manager::DatabaseConfig {
    let encrypted: String = row.get("db_password_encrypted");
    crate::pool_manager::DatabaseConfig {
        id: row.get("id"),
        host: row.get("db_host"),
        port: row.get("db_port"),
        database: row.get("db_name"),
        username: row.get("db_user"),
        password: decrypt_db_password(&encrypted),
        max_connections: 10,
        connection_timeout: 30,
    }
}

/// 检查熔断器是否允许请求通过
fn check_circuit_breaker(
    cb_mgr: &Option<axum::extract::Extension<CircuitBreakerManager>>,
    database_id: i32,
) -> Result<()> {
    if let Some(axum::extract::Extension(ref mgr)) = cb_mgr {
        let cb = mgr.get_or_create(database_id);
        if !cb.allow_request() {
            return Err(AppError::ServiceUnavailable(
                format!("数据库 {} 熔断中，请稍后重试", database_id),
            ));
        }
    }
    Ok(())
}

/// 记录熔断器成功
fn cb_record_success(
    cb_mgr: &Option<axum::extract::Extension<CircuitBreakerManager>>,
    database_id: i32,
) {
    if let Some(axum::extract::Extension(ref mgr)) = cb_mgr {
        mgr.get_or_create(database_id).record_success();
    }
}

/// 记录熔断器失败
fn cb_record_failure(
    cb_mgr: &Option<axum::extract::Extension<CircuitBreakerManager>>,
    database_id: i32,
) {
    if let Some(axum::extract::Extension(ref mgr)) = cb_mgr {
        mgr.get_or_create(database_id).record_failure();
    }
}

/// 获取数据库写池（Primary）
async fn get_write_pool(main_pool: &PgPool, database_id: i32) -> Result<PgPool> {
    ensure_pool_loaded(main_pool, database_id).await?;
    POOL_MANAGER
        .get_write_pool(database_id)
        .ok_or_else(|| AppError::NotFound(format!("数据库连接 {} 不存在", database_id)))
}

/// 获取数据库读池（有 Replica 时自动路由）
async fn get_read_pool(main_pool: &PgPool, database_id: i32) -> Result<PgPool> {
    ensure_pool_loaded(main_pool, database_id).await?;
    POOL_MANAGER
        .get_read_pool(database_id)
        .ok_or_else(|| AppError::NotFound(format!("数据库连接 {} 不存在", database_id)))
}

/// 确保 primary + replica 已加载
async fn ensure_pool_loaded(main_pool: &PgPool, database_id: i32) -> Result<()> {
    if POOL_MANAGER.get_write_pool(database_id).is_some() {
        return Ok(());
    }

    // 加载 primary
    let primary_row = sqlx::query(
        r#"
        SELECT id, db_host, db_port, db_name, db_user, db_password_encrypted
        FROM management.tenant_databases
        WHERE id = $1 AND is_active = true
        "#,
    )
    .bind(database_id)
    .fetch_optional(main_pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("数据库连接 {} 不存在或已禁用", database_id)))?;

    let config = row_to_db_config(&primary_row);
    POOL_MANAGER.get_or_create_pool(config).await?;

    // 尝试加载 replica（列可能不存在，忽略错误）
    if let Ok(replicas) = sqlx::query(
        r#"
        SELECT id, db_host, db_port, db_name, db_user, db_password_encrypted,
               COALESCE(weight, 1) AS weight
        FROM management.tenant_databases
        WHERE primary_id = $1 AND is_active = true AND db_role = 'replica'
        "#,
    )
    .bind(database_id)
    .fetch_all(main_pool)
    .await
    {
        for replica_row in &replicas {
            let replica_config = row_to_db_config(replica_row);
            let replica_id: i32 = replica_row.get("id");
            let weight: i32 = replica_row.get("weight");
            if let Err(e) = POOL_MANAGER
                .upsert_replica(database_id, replica_id, weight, replica_config)
                .await
            {
                tracing::warn!("加载 replica {} 失败: {}", replica_id, e);
            }
        }
        if !replicas.is_empty() {
            tracing::info!(
                "database_id={} 已加载 {} 个 replica",
                database_id,
                replicas.len()
            );
        }
    }

    Ok(())
}

/// 向后兼容：获取池（默认 primary）
async fn get_pool_for_database(main_pool: &PgPool, database_id: i32) -> Result<PgPool> {
    get_write_pool(main_pool, database_id).await
}

/// 认证来源
#[derive(Debug, Clone, Copy, PartialEq)]
enum AuthSource {
    ApiKey,
    Jwt,
}

/// 验证请求身份：必须持有有效 API Key 或有效 JWT，否则返回 401
async fn validate_auth(
    main_pool: &PgPool,
    headers: &HeaderMap,
    path_database_id: i32,
    has_jwt: bool,
) -> Result<(i32, AuthSource)> {
    // 优先检查 API Key（以 "cr_" 前缀区分于 JWT）
    if let Some(auth_header) = headers.get("Authorization") {
        if let Ok(auth_str) = auth_header.to_str() {
            if auth_str.starts_with("Bearer cr_") {
                let api_key = &auth_str[7..];

                let key_record = sqlx::query(
                    r#"
                    SELECT database_id, permissions, is_active
                    FROM management.api_keys
                    WHERE key_hash = encode(sha256($1::bytea), 'hex')
                    AND is_active = true
                    AND (expires_at IS NULL OR expires_at > NOW())
                    "#,
                )
                .bind(api_key)
                .fetch_optional(main_pool)
                .await?;

                if let Some(record) = key_record {
                    let db_id: i32 = record.get("database_id");

                    if db_id != path_database_id {
                        return Err(AppError::Unauthorized("API Key 与数据库不匹配".to_string()));
                    }

                    let _ = sqlx::query(
                        "UPDATE management.api_keys SET last_used_at = NOW() WHERE key_hash = encode(sha256($1::bytea), 'hex')"
                    )
                    .bind(api_key)
                    .execute(main_pool)
                    .await;

                    return Ok((db_id, AuthSource::ApiKey));
                }

                return Err(AppError::Unauthorized("API Key 无效或已过期".to_string()));
            }
        }
    }

    // 没有 API Key → 必须持有有效 JWT
    if has_jwt {
        return Ok((path_database_id, AuthSource::Jwt));
    }

    Err(AppError::Unauthorized(
        "请提供有效的 API Key 或 JWT Token".to_string(),
    ))
}

/// 校验标识符是否为合法 PostgreSQL 列名/表名（防止注入）
/// 允许：字母、数字、下划线，且不能以数字开头
fn is_valid_identifier(name: &str) -> bool {
    if name.is_empty() || name.len() > 128 {
        return false;
    }
    let first = name.chars().next().unwrap();
    if !first.is_ascii_alphabetic() && first != '_' {
        return false;
    }
    name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn validate_path_identifiers(schema: &str, table: &str) -> Result<()> {
    if !is_valid_identifier(schema) {
        return Err(AppError::InvalidQuery(format!(
            "非法的 schema 名称: '{}'", schema
        )));
    }
    if !is_valid_identifier(table) {
        return Err(AppError::InvalidQuery(format!(
            "非法的 table 名称: '{}'", table
        )));
    }
    Ok(())
}

/// 构建 SELECT 字段列表（过滤非法标识符）
fn build_select_fields(select: &Option<String>) -> String {
    match select {
        Some(fields) => {
            let safe: Vec<String> = fields
                .split(',')
                .map(|f| f.trim())
                .filter(|f| is_valid_identifier(f))
                .map(|f| format!("\"{}\"", f))
                .collect();
            if safe.is_empty() { "*".to_string() } else { safe.join(", ") }
        }
        None => "*".to_string(),
    }
}

/// 构建 ORDER BY 子句（校验标识符合法性）
fn build_order_clause(order: &Option<String>) -> String {
    match order {
        Some(order_str) => {
            let parts: Vec<&str> = order_str.split('.').collect();
            if parts.len() == 2 {
                let field = parts[0];
                if !is_valid_identifier(field) {
                    return String::new();
                }
                let direction = if parts[1].to_lowercase() == "desc" { "DESC" } else { "ASC" };
                format!("ORDER BY \"{}\" {}", field, direction)
            } else {
                if !is_valid_identifier(order_str) {
                    return String::new();
                }
                format!("ORDER BY \"{}\" ASC", order_str)
            }
        }
        None => String::new(),
    }
}

/// 应用 RBAC 列过滤：如果权限限制了列，则只 SELECT 允许的列
fn apply_column_filter(select: &Option<String>, perm: &Option<PermissionResult>) -> String {
    if let Some(p) = perm {
        if let Some(ref allowed) = p.allowed_columns {
            if !allowed.is_empty() {
                return allowed.iter().map(|c| format!("\"{}\"", c)).collect::<Vec<_>>().join(", ");
            }
        }
    }
    build_select_fields(select)
}

/// 将数据库行转换为 JSON 对象
fn row_to_json(row: &sqlx::postgres::PgRow) -> Value {
    let mut obj = serde_json::Map::new();
    for column in row.columns() {
        let key = column.name().to_string();
        let idx = column.ordinal();

        let value: Value = if let Ok(v) = row.try_get::<String, _>(idx) {
            Value::String(v)
        } else if let Ok(v) = row.try_get::<i32, _>(idx) {
            json!(v)
        } else if let Ok(v) = row.try_get::<i64, _>(idx) {
            json!(v)
        } else if let Ok(v) = row.try_get::<f64, _>(idx) {
            json!(v)
        } else if let Ok(v) = row.try_get::<bool, _>(idx) {
            Value::Bool(v)
        } else if let Ok(v) = row.try_get::<Option<String>, _>(idx) {
            v.map(Value::String).unwrap_or(Value::Null)
        } else if let Ok(v) = row.try_get::<Option<i32>, _>(idx) {
            v.map(|n| json!(n)).unwrap_or(Value::Null)
        } else if let Ok(v) = row.try_get::<Option<i64>, _>(idx) {
            v.map(|n| json!(n)).unwrap_or(Value::Null)
        } else if let Ok(v) = row.try_get::<serde_json::Value, _>(idx) {
            v
        } else {
            Value::Null
        };

        obj.insert(key, value);
    }
    Value::Object(obj)
}

/// 从查询字符串解析过滤条件（校验字段名合法性）。
///
/// **value 会做 percent-decode**：raw query 来自 `axum::extract::RawQuery`，是 URI
/// 里 `?` 之后**未经 url-decode** 的原始字符串。如果不 decode，IN 列表里的 `,` 在
/// 客户端被编码成 `%2C` 时（绝大多数 HTTP 客户端默认行为），下游 IN 分支的
/// `split(',')` 拆不开 → 整个列表当一个元素绑给 sqlx，触发：
///   - `IN ($1)` 占位数与值数量不匹配
///   - 列是 int / bigint 但绑了 text 串，`operator does not exist: bigint = text`
///
/// key 不 decode：合法 PG identifier 不含 `%XX`，decode 反而增加被构造畸形 key 的
/// 攻击面；后面 `is_valid_identifier` 会再校验一遍，非法 key 整条 drop。
fn parse_filters(query_string: &str) -> Vec<(String, String, String)> {
    use percent_encoding::percent_decode_str;

    let decode_value = |raw: &str| -> String {
        percent_decode_str(raw)
            .decode_utf8_lossy()
            .into_owned()
    };

    let mut filters = Vec::new();
    
    for pair in query_string.split('&') {
        if let Some((key, value)) = pair.split_once('=') {
            let decoded_value = decode_value(value);
            if key.contains('.') {
                let parts: Vec<&str> = key.split('.').collect();
                if parts.len() == 2 {
                    let field = parts[0];
                    if !is_valid_identifier(field) {
                        continue;
                    }
                    // PostgREST 算子 → 内部 SQL op 占位符。
                    // 注意 "IN" / "IS" 是哨兵字符串：不直接拼到 SQL 里，list_records 里
                    // 的 WHERE 拼接会按 op 字符串分支处理（IN 需要多个 placeholder、
                    // IS NULL 不绑参）。
                    let op = match parts[1] {
                        "eq" => "=",
                        "neq" => "!=",
                        "gt" => ">",
                        "gte" => ">=",
                        "lt" => "<",
                        "lte" => "<=",
                        "like" => "LIKE",
                        "ilike" => "ILIKE",
                        "is" => "IS",
                        "in" => "IN",
                        _ => continue,
                    };
                    filters.push((field.to_string(), op.to_string(), decoded_value));
                }
            } else if !["select", "order", "limit", "offset"].contains(&key) {
                if !is_valid_identifier(key) {
                    continue;
                }
                filters.push((key.to_string(), "=".to_string(), decoded_value));
            }
        }
    }
    
    filters
}

/// GET /api/v1/{database_id}/{schema}/{table} - 查询列表
pub async fn list_records(
    State(main_pool): State<PgPool>,
    Path((database_id, schema, table)): Path<(i32, String, String)>,
    Query(params): Query<QueryParams>,
    headers: HeaderMap,
    raw_query: axum::extract::RawQuery,
    claims: Option<axum::extract::Extension<Claims>>,
    rbac: Option<axum::extract::Extension<PermissionResult>>,
    redis: Option<axum::extract::Extension<RedisManager>>,
    cb_mgr: Option<axum::extract::Extension<CircuitBreakerManager>>,
) -> Result<Json<ApiResponse<Vec<Value>>>> {
    validate_path_identifiers(&schema, &table)?;
    validate_auth(&main_pool, &headers, database_id, claims.is_some()).await?;
    check_circuit_breaker(&cb_mgr, database_id)?;

    let perm = rbac.map(|e| e.0);
    let row_conditions = perm.as_ref().map(|p| p.row_conditions.clone()).unwrap_or_default();
    let allowed_columns = perm.as_ref().and_then(|p| p.allowed_columns.clone());

    let query_string = raw_query.0.as_deref().unwrap_or("");
    let rc_fingerprint = row_conditions_to_fingerprint(&row_conditions);
    // user_id 写入 fingerprint：不同用户经 RLS 后可见结果不同，缓存必须分桶
    let fingerprint = QueryCache::build_fingerprint(
        query_string,
        &rc_fingerprint,
        &allowed_columns,
        user_id_from_claims(&claims),
    );

    if let Some(axum::extract::Extension(ref r)) = redis {
        if let Some(cached) = QueryCache::get(r, database_id, &schema, &table, &fingerprint).await {
            tracing::debug!("查询缓存命中: {}.{}", schema, table);
            if let Ok(resp) = serde_json::from_str::<ApiResponse<Vec<Value>>>(&cached) {
                return Ok(Json(resp));
            }
        }
    }

    let pool = match get_read_pool(&main_pool, database_id).await {
        Ok(p) => p,
        Err(e) => {
            cb_record_failure(&cb_mgr, database_id);
            return Err(e);
        }
    };

    let select_fields = apply_column_filter(&params.select, &perm);
    let order_clause = build_order_clause(&params.order);
    let limit = params.limit.unwrap_or(100).min(1000);
    let offset = params.offset.unwrap_or(0);

    let filters = raw_query.0.map(|q| parse_filters(&q)).unwrap_or_default();

    let mut where_clauses = Vec::new();
    let mut bind_values: Vec<String> = Vec::new();
    let mut next_param_idx: usize = 1;

    for (field, op, value) in filters.iter() {
        if op == "IS" {
            if value.to_lowercase() == "null" {
                where_clauses.push(format!("\"{}\" IS NULL", field));
            } else {
                where_clauses.push(format!("\"{}\" IS NOT NULL", field));
            }
        } else if op == "IN" {
            // PostgREST 语法：`field=in.(a,b,c)` —— rewrite middleware 会改写成
            // `field.in=(a,b,c)`，parse_filters 拿到 value = "(a,b,c)" 或裸 "a,b,c"。
            // 在 SQL 侧展开为 `"field" IN ($n, $n+1, ...)`，每项单独参数化绑定。
            let raw = value
                .trim()
                .trim_start_matches('(')
                .trim_end_matches(')');
            let items: Vec<String> = raw
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if items.is_empty() {
                // 空 IN 在 PG 里语法非法，且语义上"在空集合里"必然 false。
                // 这里写恒假，让结果集明确为空而不是触发 500。
                where_clauses.push("FALSE".to_string());
            } else {
                let placeholders: Vec<String> = (0..items.len())
                    .map(|i| format!("${}", next_param_idx + i))
                    .collect();
                where_clauses.push(format!(
                    "\"{}\" IN ({})",
                    field,
                    placeholders.join(", ")
                ));
                let n = items.len();
                for item in items {
                    bind_values.push(item);
                }
                next_param_idx += n;
            }
        } else {
            where_clauses.push(format!("\"{}\" {} ${}", field, op, next_param_idx));
            bind_values.push(value.clone());
            next_param_idx += 1;
        }
    }

    // RBAC 行级条件：参数化绑定，禁止裸字符串拼接
    if !row_conditions.is_empty() {
        next_param_idx = append_rbac_where(
            &mut where_clauses,
            &mut bind_values,
            &row_conditions,
            next_param_idx,
        );
    }
    let _ = next_param_idx;

    let where_clause = if where_clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", where_clauses.join(" AND "))
    };

    let count_sql = format!(
        "SELECT COUNT(*) as count FROM \"{}\".\"{}\" {}",
        schema, table, where_clause
    );

    let sql = format!(
        "SELECT {} FROM \"{}\".\"{}\" {} {} LIMIT {} OFFSET {}",
        select_fields, schema, table, where_clause, order_clause, limit, offset
    );

    tracing::debug!("Auto API SQL: {}", sql);

    // 包一层事务：注入 app.current_user_id 给 PG RLS 使用
    let mut tx = pool.begin().await.map_err(AppError::Database)?;
    inject_session_user_id(&mut tx, user_id_from_claims(&claims)).await?;

    let mut count_query = sqlx::query(&count_sql);
    for value in &bind_values {
        count_query = bind_inferred(count_query, value);
    }

    // count_sql 与下面的 data SQL 共享 WHERE：count 失败几乎必然意味着 data 也会
    // 失败（同样的列名 / 类型 / 权限）。**绝对不能 unwrap_or(0)** 把错误吞掉 —— 之前
    // 就是这么写的，结果错误被吞掉后事务进入 aborted 状态，紧跟着的 SELECT 报
    // "current transaction is aborted, commands ignored until end of transaction block"，
    // 客户端看到的错误跟真实 root cause（如列不存在 / 类型不兼容 / RLS 拒绝）完全
    // 错位，排障极其困难。明确把 count 错误向上返回；事务 drop 时 sqlx 会自动 rollback。
    let total_count: i64 = match count_query.fetch_one(&mut *tx).await {
        Ok(r) => r.get("count"),
        Err(e) => {
            cb_record_failure(&cb_mgr, database_id);
            tracing::warn!(
                schema = %schema,
                table = %table,
                "COUNT(*) 查询失败，整个请求按失败返回；SQL: {} ; err: {}",
                count_sql,
                e
            );
            return Err(AppError::Database(e));
        }
    };

    let mut query = sqlx::query(&sql);
    for value in &bind_values {
        query = bind_inferred(query, value);
    }

    let query_start = std::time::Instant::now();
    let rows = match query.fetch_all(&mut *tx).await {
        Ok(r) => {
            cb_record_success(&cb_mgr, database_id);
            r
        }
        Err(e) => {
            cb_record_failure(&cb_mgr, database_id);
            return Err(AppError::Database(e));
        }
    };
    tx.commit().await.map_err(AppError::Database)?;
    let query_ms = query_start.elapsed().as_millis() as i32;

    SlowQueryLogger::log(&main_pool, database_id, &schema, &table, &sql, query_ms).await;

    let results: Vec<Value> = rows
        .iter()
        .map(|row| row_to_json(row))
        .collect();

    let response = ApiResponse {
        data: results,
        count: Some(total_count),
        error: None,
    };

    if let Some(axum::extract::Extension(ref r)) = redis {
        if let Ok(data) = serde_json::to_string(&response) {
            QueryCache::set(r, database_id, &schema, &table, &fingerprint, &data).await;
        }
    }

    Ok(Json(response))
}

/// GET /api/v1/{database_id}/{table} - PostgREST 兼容形态的列表查询。
///
/// 与三段版本 [`list_records`] 的差异：
/// - schema 不在 path 里，由 `Accept-Profile` 头取（缺省 `public`）
/// - `X-Project-IDs` 头会被翻译成 `project_id.in=(...)` 追加到 query
/// - PostgREST 标准 filter 语法 `field=op.value` 会被翻译成内部 `field.op=value`
///
/// **不是新的 SQL 路径**：完成上述合成后直接 forward 给 [`list_records`]，复用其
/// 全部 RBAC / 缓存 / 熔断 / RLS / 审计逻辑。
pub async fn list_records_pgrest(
    State(main_pool): State<PgPool>,
    Path((database_id, table)): Path<(i32, String)>,
    Query(params): Query<QueryParams>,
    headers: HeaderMap,
    raw_query: axum::extract::RawQuery,
    claims: Option<axum::extract::Extension<Claims>>,
    rbac: Option<axum::extract::Extension<PermissionResult>>,
    redis: Option<axum::extract::Extension<RedisManager>>,
    cb_mgr: Option<axum::extract::Extension<CircuitBreakerManager>>,
) -> Result<axum::response::Response> {
    let schema = postgrest_compat::resolve_schema(&axum::http::Method::GET, &headers);
    // 重写 query：PostgREST filter 翻译 + X-Project-IDs 附加 IN filter
    let synthesized = postgrest_compat::translate_and_augment_query(
        raw_query.0.as_deref(),
        &headers,
    );
    let synthesized_opt = if synthesized.is_empty() {
        None
    } else {
        Some(synthesized)
    };
    // 提前缓存 offset + Accept 头：list_records 内部会消费 Query(params) 与 headers，
    // 后面我们要按 PostgREST 标准检查 `Accept: application/vnd.pgrst.object+json`，
    // 必须在 move 之前拿到。
    let offset = params.offset.unwrap_or(0).max(0);
    let single_object_response = wants_single_object_response(&headers);

    // QueryParams（select/order/limit/offset）走的是保留字段，翻译过程中不会动它们
    // 的字面值，所以可以直接复用 axum 反序列化好的 params；不需要再 deserialize 一次。
    let inner: Json<ApiResponse<Vec<Value>>> = list_records(
        State(main_pool),
        Path((database_id, schema, table)),
        Query(params),
        headers,
        axum::extract::RawQuery(synthesized_opt),
        claims,
        rbac,
        redis,
        cb_mgr,
    )
    .await?;

    // PostgREST 默认响应是**裸 JSON 数组**（不是 `{data, count}` 包装）；count 信息
    // 改写到 `Content-Range` 响应头（PostgREST 标准 `<first>-<last>/<total>`）。
    // 这样 supabase-js / postgrest-js 客户端能直接消费，业务方不再需要 `.data` 解包。
    let ApiResponse {
        data,
        count,
        error: _, // ApiResponse 错误字段在当前 list_records 流程里始终是 None
    } = inner.0;

    use axum::response::IntoResponse;
    let returned = data.len() as i64;
    let total_str = count
        .map(|n| n.to_string())
        .unwrap_or_else(|| "*".to_string());
    // 0 行时 PostgREST 用 `*/<total>` 表达"无返回行"，避免 last < first 的歧义。
    let content_range = if returned == 0 {
        format!("*/{}", total_str)
    } else {
        let last = offset + returned - 1;
        format!("{}-{}/{}", offset, last, total_str)
    };

    // `Accept: application/vnd.pgrst.object+json` —— PostgREST / supabase-js 的 `.single()`
    // 语义：业务方主动声明"只关心一行"，server 拆掉外层数组直接返单 object。
    //   - 1 行 → 单 object
    //   - 0 行 / 多行 → 406 "JSON object requested, ... rows returned"
    // 行为与 RPC 路径 `crate::rpc::wants_single_object_response` 完全对齐。
    if single_object_response {
        match data.len() {
            0 => {
                return Err(AppError::InvalidQuery(
                    "JSON object requested, no rows returned".to_string(),
                ));
            }
            1 => {
                let single = data.into_iter().next().unwrap();
                let mut resp = Json(single).into_response();
                if let Ok(value) = axum::http::HeaderValue::from_str(&content_range) {
                    resp.headers_mut()
                        .insert(axum::http::header::CONTENT_RANGE, value);
                }
                return Ok(resp);
            }
            n => {
                return Err(AppError::InvalidQuery(format!(
                    "JSON object requested, multiple ({}) rows returned",
                    n
                )));
            }
        }
    }

    let mut resp = Json(data).into_response();
    if let Ok(value) = axum::http::HeaderValue::from_str(&content_range) {
        resp.headers_mut()
            .insert(axum::http::header::CONTENT_RANGE, value);
    }
    Ok(resp)
}

/// 解析 `Accept` 头是否含 `application/vnd.pgrst.object+json`。
///
/// 与 [`crate::rpc::wants_single_object_response`] 行为一致 —— 但 RPC 那份是
/// crate-private 不能跨模块复用，这里独立维护一份。允许逗号分隔的多 media
/// type，**任一**匹配就返 true；不解析 `;q=` 权重，因为客户端表达 `.single()`
/// 意图时这个值都是首选。
fn wants_single_object_response(headers: &HeaderMap) -> bool {
    headers
        .get(axum::http::header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .map(|s| {
            s.split(',').any(|part| {
                let media = part.split(';').next().unwrap_or("").trim();
                media.eq_ignore_ascii_case("application/vnd.pgrst.object+json")
            })
        })
        .unwrap_or(false)
}

/// POST /api/v1/{database_id}/{table} - PostgREST 兼容形态的创建。
///
/// 与 [`create_record`] 的差异：schema 由 `Content-Profile`（fallback `Accept-Profile`）
/// 头决定。创建场景下 `X-Project-IDs` 不参与（写不是按多项目筛选；要写哪条记录由
/// body 决定），仅做 schema 翻译后 forward。
pub async fn create_record_pgrest(
    State(main_pool): State<PgPool>,
    Path((database_id, table)): Path<(i32, String)>,
    headers: HeaderMap,
    claims: Option<axum::extract::Extension<Claims>>,
    rbac: Option<axum::extract::Extension<PermissionResult>>,
    redis: Option<axum::extract::Extension<RedisManager>>,
    event_bus: Option<axum::extract::Extension<EventBus>>,
    cb_mgr: Option<axum::extract::Extension<CircuitBreakerManager>>,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<ApiResponse<Value>>)> {
    let schema = postgrest_compat::resolve_schema(&axum::http::Method::POST, &headers);
    create_record(
        State(main_pool),
        Path((database_id, schema, table)),
        headers,
        claims,
        rbac,
        redis,
        event_bus,
        cb_mgr,
        Json(body),
    )
    .await
}

/// GET /api/v1/{database_id}/{schema}/{table}/{id} - 查询单条记录
pub async fn get_record(
    State(main_pool): State<PgPool>,
    Path((database_id, schema, table, id)): Path<(i32, String, String, String)>,
    Query(params): Query<QueryParams>,
    headers: HeaderMap,
    claims: Option<axum::extract::Extension<Claims>>,
    rbac: Option<axum::extract::Extension<PermissionResult>>,
    redis: Option<axum::extract::Extension<RedisManager>>,
    cb_mgr: Option<axum::extract::Extension<CircuitBreakerManager>>,
) -> Result<Json<ApiResponse<Option<Value>>>> {
    validate_path_identifiers(&schema, &table)?;
    validate_auth(&main_pool, &headers, database_id, claims.is_some()).await?;
    check_circuit_breaker(&cb_mgr, database_id)?;

    let perm = rbac.map(|e| e.0);
    let allowed_columns = perm.as_ref().and_then(|p| p.allowed_columns.clone());
    let fingerprint = QueryCache::build_fingerprint(
        &format!("id={}", id),
        &[],
        &allowed_columns,
        user_id_from_claims(&claims),
    );

    if let Some(axum::extract::Extension(ref r)) = redis {
        if let Some(cached) = QueryCache::get(r, database_id, &schema, &table, &fingerprint).await {
            if let Ok(resp) = serde_json::from_str::<ApiResponse<Option<Value>>>(&cached) {
                return Ok(Json(resp));
            }
        }
    }

    let pool = match get_read_pool(&main_pool, database_id).await {
        Ok(p) => p,
        Err(e) => {
            cb_record_failure(&cb_mgr, database_id);
            return Err(e);
        }
    };
    let select_fields = apply_column_filter(&params.select, &perm);
    let pk_column = get_primary_key_column(&pool, &schema, &table).await?;

    // 主键过滤为 $1，RBAC 行条件从 $2 开始
    let mut where_clauses = vec![format!("\"{}\" = $1", pk_column)];
    let mut bind_values: Vec<String> = vec![id.clone()];
    let row_conds = perm.as_ref().map(|p| p.row_conditions.clone()).unwrap_or_default();
    let _ = append_rbac_where(&mut where_clauses, &mut bind_values, &row_conds, 2);

    let sql = format!(
        "SELECT {} FROM \"{}\".\"{}\" WHERE {} LIMIT 1",
        select_fields,
        schema,
        table,
        where_clauses.join(" AND ")
    );

    // 事务 + RLS 上下文
    let mut tx = pool.begin().await.map_err(AppError::Database)?;
    inject_session_user_id(&mut tx, user_id_from_claims(&claims)).await?;

    let mut q = sqlx::query(&sql);
    // PK + rbac 用 bind_inferred 推类型，否则 bigint PK 比较会报 `bigint = text`。
    for v in &bind_values {
        q = bind_inferred(q, v);
    }
    let row = match q.fetch_optional(&mut *tx).await {
        Ok(r) => {
            cb_record_success(&cb_mgr, database_id);
            r
        }
        Err(e) => {
            cb_record_failure(&cb_mgr, database_id);
            return Err(AppError::Database(e));
        }
    };
    tx.commit().await.map_err(AppError::Database)?;

    let result = row.map(|row| row_to_json(&row));

    if result.is_none() {
        return Err(AppError::NotFound(format!("记录 {} 不存在", id)));
    }

    let response = ApiResponse {
        data: result,
        count: None,
        error: None,
    };

    if let Some(axum::extract::Extension(ref r)) = redis {
        if let Ok(data) = serde_json::to_string(&response) {
            QueryCache::set(r, database_id, &schema, &table, &fingerprint, &data).await;
        }
    }

    Ok(Json(response))
}

/// POST /api/v1/{database_id}/{schema}/{table} - 创建记录
pub async fn create_record(
    State(main_pool): State<PgPool>,
    Path((database_id, schema, table)): Path<(i32, String, String)>,
    headers: HeaderMap,
    claims: Option<axum::extract::Extension<Claims>>,
    rbac: Option<axum::extract::Extension<PermissionResult>>,
    redis: Option<axum::extract::Extension<RedisManager>>,
    event_bus: Option<axum::extract::Extension<EventBus>>,
    cb_mgr: Option<axum::extract::Extension<CircuitBreakerManager>>,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<ApiResponse<Value>>)> {
    validate_path_identifiers(&schema, &table)?;
    validate_auth(&main_pool, &headers, database_id, claims.is_some()).await?;
    check_circuit_breaker(&cb_mgr, database_id)?;

    let perm = rbac.map(|e| e.0);
    let pool = match get_write_pool(&main_pool, database_id).await {
        Ok(p) => p,
        Err(e) => {
            cb_record_failure(&cb_mgr, database_id);
            return Err(e);
        }
    };
    
    let obj = body.as_object().ok_or_else(|| {
        AppError::InvalidQuery("请求体必须是 JSON 对象".to_string())
    })?;
    
    if obj.is_empty() {
        return Err(AppError::InvalidQuery("请求体不能为空".to_string()));
    }

    // 列级权限：禁止 INSERT 配置以外的列
    if let Some(ref p) = perm {
        if let Some(ref allowed) = p.allowed_columns {
            for key in obj.keys() {
                if !allowed.iter().any(|c| c == key) {
                    return Err(AppError::Forbidden(format!(
                        "无权写入列: {}",
                        key
                    )));
                }
            }
        }
    }

    // 行级权限：要求 INSERT 的数据满足 row_conditions（防止越权写入到其他用户/租户的行）
    if let Some(ref p) = perm {
        for cond in &p.row_conditions {
            if let Err(e) = check_insert_satisfies_row_condition(obj, cond) {
                return Err(AppError::Forbidden(format!(
                    "INSERT 数据未满足行级权限约束: {}",
                    e
                )));
            }
        }
    }

    let columns: Vec<String> = obj.keys().map(|k| format!("\"{}\"", k)).collect();
    let placeholders: Vec<String> = (1..=obj.len()).map(|i| format!("${}", i)).collect();
    
    let sql = format!(
        "INSERT INTO \"{}\".\"{}\" ({}) VALUES ({}) RETURNING *",
        schema, table, columns.join(", "), placeholders.join(", ")
    );

    // 事务 + RLS 上下文
    let mut tx = pool.begin().await.map_err(AppError::Database)?;
    inject_session_user_id(&mut tx, user_id_from_claims(&claims)).await?;

    let mut query = sqlx::query(&sql);
    for value in obj.values() {
        query = bind_json_value(query, value);
    }

    let row = match query.fetch_one(&mut *tx).await {
        Ok(r) => {
            cb_record_success(&cb_mgr, database_id);
            r
        }
        Err(e) => {
            cb_record_failure(&cb_mgr, database_id);
            return Err(AppError::InvalidQuery(format!("创建记录失败: {}", e)));
        }
    };
    tx.commit().await.map_err(AppError::Database)?;

    let result = row_to_json(&row);

    if let Some(axum::extract::Extension(ref r)) = redis {
        QueryCache::invalidate_table(r, database_id, &schema, &table).await;
    }

    if let Some(axum::extract::Extension(ref bus)) = event_bus {
        bus.publish(DataChangeEvent {
            tenant_id: 0,
            database_id,
            schema: schema.clone(),
            table: table.clone(),
            action: ChangeAction::Insert,
            old_data: None,
            new_data: Some(result.clone()),
            user_id: None,
            timestamp: chrono::Utc::now(),
            request_id: crate::request_id::current(),
        });
    }

    Ok((StatusCode::CREATED, Json(ApiResponse {
        data: result,
        count: None,
        error: None,
    })))
}

/// PATCH /api/v1/{database_id}/{schema}/{table}/{id} - 更新记录
pub async fn update_record(
    State(main_pool): State<PgPool>,
    Path((database_id, schema, table, id)): Path<(i32, String, String, String)>,
    headers: HeaderMap,
    claims: Option<axum::extract::Extension<Claims>>,
    rbac: Option<axum::extract::Extension<PermissionResult>>,
    redis: Option<axum::extract::Extension<RedisManager>>,
    event_bus: Option<axum::extract::Extension<EventBus>>,
    cb_mgr: Option<axum::extract::Extension<CircuitBreakerManager>>,
    Json(body): Json<Value>,
) -> Result<Json<ApiResponse<Value>>> {
    validate_path_identifiers(&schema, &table)?;
    validate_auth(&main_pool, &headers, database_id, claims.is_some()).await?;
    check_circuit_breaker(&cb_mgr, database_id)?;

    let perm = rbac.map(|e| e.0);
    let pool = match get_write_pool(&main_pool, database_id).await {
        Ok(p) => p,
        Err(e) => {
            cb_record_failure(&cb_mgr, database_id);
            return Err(e);
        }
    };
    
    let obj = body.as_object().ok_or_else(|| {
        AppError::InvalidQuery("请求体必须是 JSON 对象".to_string())
    })?;
    
    if obj.is_empty() {
        return Err(AppError::InvalidQuery("请求体不能为空".to_string()));
    }

    // 列级权限：禁止更新 allowed_columns 之外的列（若已配置）
    if let Some(ref p) = perm {
        if let Some(ref allowed) = p.allowed_columns {
            for key in obj.keys() {
                if !allowed.iter().any(|c| c == key) {
                    return Err(AppError::Forbidden(format!(
                        "无权更新列: {}",
                        key
                    )));
                }
            }
        }
    }

    let pk_column = get_primary_key_column(&pool, &schema, &table).await?;
    
    let set_clauses: Vec<String> = obj
        .keys()
        .enumerate()
        .map(|(i, k)| format!("\"{}\" = ${}", k, i + 1))
        .collect();

    // pk 占用 $N+1，RBAC 行条件从 $N+2 开始
    let pk_placeholder = obj.len() + 1;
    let mut where_clauses = vec![format!("\"{}\" = ${}", pk_column, pk_placeholder)];
    let mut rbac_binds: Vec<String> = Vec::new();
    let row_conds = perm.as_ref().map(|p| p.row_conditions.clone()).unwrap_or_default();
    let _ = append_rbac_where(
        &mut where_clauses,
        &mut rbac_binds,
        &row_conds,
        pk_placeholder + 1,
    );

    let sql = format!(
        "UPDATE \"{}\".\"{}\" SET {} WHERE {} RETURNING *",
        schema,
        table,
        set_clauses.join(", "),
        where_clauses.join(" AND ")
    );

    // 事务 + RLS 上下文
    let mut tx = pool.begin().await.map_err(AppError::Database)?;
    inject_session_user_id(&mut tx, user_id_from_claims(&claims)).await?;

    let mut query = sqlx::query(&sql);
    for value in obj.values() {
        query = bind_json_value(query, value);
    }
    // PK 用 bind_inferred：数字字面值 bind 成 i64，避免 bigint PK 上的
    // `operator does not exist: bigint = text`。rbac_binds 同理。
    query = bind_inferred(query, &id);
    for v in &rbac_binds {
        query = bind_inferred(query, v);
    }

    let row = match query.fetch_optional(&mut *tx).await {
        Ok(r) => {
            cb_record_success(&cb_mgr, database_id);
            r
        }
        Err(e) => {
            cb_record_failure(&cb_mgr, database_id);
            return Err(AppError::InvalidQuery(format!("更新记录失败: {}", e)));
        }
    };
    tx.commit().await.map_err(AppError::Database)?;

    let row = row.ok_or_else(|| AppError::NotFound(
        format!("记录 {} 不存在或您无权访问", id)
    ))?;

    let result = row_to_json(&row);

    if let Some(axum::extract::Extension(ref r)) = redis {
        QueryCache::invalidate_table(r, database_id, &schema, &table).await;
    }

    if let Some(axum::extract::Extension(ref bus)) = event_bus {
        bus.publish(DataChangeEvent {
            tenant_id: 0,
            database_id,
            schema: schema.clone(),
            table: table.clone(),
            action: ChangeAction::Update,
            old_data: None,
            new_data: Some(result.clone()),
            user_id: None,
            timestamp: chrono::Utc::now(),
            request_id: crate::request_id::current(),
        });
    }

    Ok(Json(ApiResponse {
        data: result,
        count: None,
        error: None,
    }))
}

/// DELETE /api/v1/{database_id}/{schema}/{table}/{id} - 删除记录
pub async fn delete_record(
    State(main_pool): State<PgPool>,
    Path((database_id, schema, table, id)): Path<(i32, String, String, String)>,
    headers: HeaderMap,
    claims: Option<axum::extract::Extension<Claims>>,
    rbac: Option<axum::extract::Extension<PermissionResult>>,
    redis: Option<axum::extract::Extension<RedisManager>>,
    event_bus: Option<axum::extract::Extension<EventBus>>,
    cb_mgr: Option<axum::extract::Extension<CircuitBreakerManager>>,
) -> Result<Json<ApiResponse<Value>>> {
    validate_path_identifiers(&schema, &table)?;
    validate_auth(&main_pool, &headers, database_id, claims.is_some()).await?;
    check_circuit_breaker(&cb_mgr, database_id)?;

    let perm = rbac.map(|e| e.0);
    let pool = match get_write_pool(&main_pool, database_id).await {
        Ok(p) => p,
        Err(e) => {
            cb_record_failure(&cb_mgr, database_id);
            return Err(e);
        }
    };
    let pk_column = get_primary_key_column(&pool, &schema, &table).await?;

    let mut where_clauses = vec![format!("\"{}\" = $1", pk_column)];
    let mut bind_values: Vec<String> = vec![id.clone()];
    let row_conds = perm.as_ref().map(|p| p.row_conditions.clone()).unwrap_or_default();
    let _ = append_rbac_where(&mut where_clauses, &mut bind_values, &row_conds, 2);

    let sql = format!(
        "DELETE FROM \"{}\".\"{}\" WHERE {} RETURNING *",
        schema,
        table,
        where_clauses.join(" AND ")
    );

    // 事务 + RLS 上下文
    let mut tx = pool.begin().await.map_err(AppError::Database)?;
    inject_session_user_id(&mut tx, user_id_from_claims(&claims)).await?;

    let mut q = sqlx::query(&sql);
    // PK + rbac 都用 bind_inferred 推 i64/bool/text，否则 bigint PK 比较会报
    // `operator does not exist: bigint = text`。
    for v in &bind_values {
        q = bind_inferred(q, v);
    }
    let row = match q.fetch_optional(&mut *tx).await {
        Ok(r) => {
            cb_record_success(&cb_mgr, database_id);
            r
        }
        Err(e) => {
            cb_record_failure(&cb_mgr, database_id);
            return Err(AppError::InvalidQuery(format!("删除记录失败: {}", e)));
        }
    };
    tx.commit().await.map_err(AppError::Database)?;

    let row = row.ok_or_else(|| AppError::NotFound(
        format!("记录 {} 不存在或您无权访问", id)
    ))?;

    let result = row_to_json(&row);

    if let Some(axum::extract::Extension(ref r)) = redis {
        QueryCache::invalidate_table(r, database_id, &schema, &table).await;
    }

    if let Some(axum::extract::Extension(ref bus)) = event_bus {
        bus.publish(DataChangeEvent {
            tenant_id: 0,
            database_id,
            schema: schema.clone(),
            table: table.clone(),
            action: ChangeAction::Delete,
            old_data: Some(result.clone()),
            new_data: None,
            user_id: None,
            timestamp: chrono::Utc::now(),
            request_id: crate::request_id::current(),
        });
    }

    Ok(Json(ApiResponse {
        data: result,
        count: None,
        error: None,
    }))
}

/// PATCH /api/v1/{database_id}/{schema}/{table}?filter=... - 批量按过滤条件更新
///
/// PostgREST 语义的"按 query filter 批量更新"。与 [`update_record`] 的关键区别：
/// - 不靠 path 末段的 `:id` 锁定单条，而是 query string 的 `field=op.value` 过滤集合；
/// - **必须**至少提供一个 filter（防止"漏掉 WHERE → 改整张表"的灾难性误操作）；
/// - 返回的是被影响的所有行（`RETURNING *`），可能是多行。
///
/// 安全约束：
/// - filter 经 [`parse_filters`] 校验 + 参数化绑定，不存在 SQL 注入；
/// - 列级 RBAC：`allowed_columns` 之外的列不允许出现在 body；
/// - 行级 RBAC：`row_conditions` 追加到 WHERE，参数化绑定；
/// - 事务内注入 `app.current_user_id`，配合 PG RLS POLICY 工作。
pub async fn update_records(
    State(main_pool): State<PgPool>,
    Path((database_id, schema, table)): Path<(i32, String, String)>,
    headers: HeaderMap,
    raw_query: axum::extract::RawQuery,
    claims: Option<axum::extract::Extension<Claims>>,
    rbac: Option<axum::extract::Extension<PermissionResult>>,
    redis: Option<axum::extract::Extension<RedisManager>>,
    event_bus: Option<axum::extract::Extension<EventBus>>,
    cb_mgr: Option<axum::extract::Extension<CircuitBreakerManager>>,
    Json(body): Json<Value>,
) -> Result<Json<ApiResponse<Vec<Value>>>> {
    validate_path_identifiers(&schema, &table)?;
    validate_auth(&main_pool, &headers, database_id, claims.is_some()).await?;
    check_circuit_breaker(&cb_mgr, database_id)?;

    let perm = rbac.map(|e| e.0);

    // body 必须是非空 JSON object
    let obj = body
        .as_object()
        .ok_or_else(|| AppError::InvalidQuery("请求体必须是 JSON 对象".to_string()))?;
    if obj.is_empty() {
        return Err(AppError::InvalidQuery("请求体不能为空".to_string()));
    }
    // 列级权限：禁止更新 allowed_columns 之外的列（若已配置）
    if let Some(ref p) = perm {
        if let Some(ref allowed) = p.allowed_columns {
            for key in obj.keys() {
                if !allowed.iter().any(|c| c == key) {
                    return Err(AppError::Forbidden(format!("无权更新列: {}", key)));
                }
            }
        }
    }

    // filters：至少一个；不允许"裸 PATCH 整张表"。RBAC row_conditions 不算 filter，
    // 这是行级安全的兜底，不是用户的"显式意图"。
    let query_string = raw_query.0.as_deref().unwrap_or("");
    let filters = parse_filters(query_string);
    if filters.is_empty() {
        return Err(AppError::InvalidQuery(
            "批量更新必须提供至少一个过滤条件（如 ?id=eq.123），禁止裸 PATCH 整表".to_string(),
        ));
    }

    let pool = match get_write_pool(&main_pool, database_id).await {
        Ok(p) => p,
        Err(e) => {
            cb_record_failure(&cb_mgr, database_id);
            return Err(e);
        }
    };

    // SET：每个待更新列拿一个 $N（按 obj.keys() 的迭代顺序，下面 bind 时同序）。
    let set_clauses: Vec<String> = obj
        .keys()
        .enumerate()
        .map(|(i, k)| format!("\"{}\" = ${}", k, i + 1))
        .collect();
    let mut next_param_idx = obj.len() + 1;

    // WHERE：filter 转 SQL，复用 list_records 的占位符策略。
    let mut where_clauses: Vec<String> = Vec::new();
    let mut filter_binds: Vec<String> = Vec::new();
    for (field, op, value) in filters.iter() {
        if op == "IS" {
            if value.to_lowercase() == "null" {
                where_clauses.push(format!("\"{}\" IS NULL", field));
            } else {
                where_clauses.push(format!("\"{}\" IS NOT NULL", field));
            }
        } else if op == "IN" {
            let raw = value.trim().trim_start_matches('(').trim_end_matches(')');
            let items: Vec<String> = raw
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if items.is_empty() {
                where_clauses.push("FALSE".to_string());
            } else {
                let placeholders: Vec<String> = (0..items.len())
                    .map(|i| format!("${}", next_param_idx + i))
                    .collect();
                where_clauses.push(format!("\"{}\" IN ({})", field, placeholders.join(", ")));
                let n = items.len();
                for item in items {
                    filter_binds.push(item);
                }
                next_param_idx += n;
            }
        } else {
            where_clauses.push(format!("\"{}\" {} ${}", field, op, next_param_idx));
            filter_binds.push(value.clone());
            next_param_idx += 1;
        }
    }

    // RBAC 行级条件
    let row_conds = perm.as_ref().map(|p| p.row_conditions.clone()).unwrap_or_default();
    let mut rbac_binds: Vec<String> = Vec::new();
    if !row_conds.is_empty() {
        next_param_idx =
            append_rbac_where(&mut where_clauses, &mut rbac_binds, &row_conds, next_param_idx);
    }
    let _ = next_param_idx;

    let sql = format!(
        "UPDATE \"{}\".\"{}\" SET {} WHERE {} RETURNING *",
        schema,
        table,
        set_clauses.join(", "),
        where_clauses.join(" AND ")
    );

    let mut tx = pool.begin().await.map_err(AppError::Database)?;
    inject_session_user_id(&mut tx, user_id_from_claims(&claims)).await?;

    let mut query = sqlx::query(&sql);
    // 绑顺序：先 SET（obj.values 与 obj.keys 同序，用 bind_json_value 按 JSON 字面值
    // 类型 bind），再 filter binds 与 rbac binds（用 bind_inferred 按字面值形态推断
    // 类型）。**别用 `query.bind(&String)`**：那会把整列都 bind 成 PG `text`，
    // bigint / int 列会直接报 `operator does not exist: bigint = text`。
    for value in obj.values() {
        query = bind_json_value(query, value);
    }
    for v in &filter_binds {
        query = bind_inferred(query, v);
    }
    for v in &rbac_binds {
        query = bind_inferred(query, v);
    }

    let rows = match query.fetch_all(&mut *tx).await {
        Ok(r) => {
            cb_record_success(&cb_mgr, database_id);
            r
        }
        Err(e) => {
            cb_record_failure(&cb_mgr, database_id);
            return Err(AppError::InvalidQuery(format!("批量更新失败: {}", e)));
        }
    };
    tx.commit().await.map_err(AppError::Database)?;

    let results: Vec<Value> = rows.iter().map(row_to_json).collect();

    if let Some(axum::extract::Extension(ref r)) = redis {
        QueryCache::invalidate_table(r, database_id, &schema, &table).await;
    }

    if let Some(axum::extract::Extension(ref bus)) = event_bus {
        let req_id_snapshot = crate::request_id::current();
        for new_data in &results {
            bus.publish(DataChangeEvent {
                tenant_id: 0,
                database_id,
                schema: schema.clone(),
                table: table.clone(),
                action: ChangeAction::Update,
                old_data: None,
                new_data: Some(new_data.clone()),
                user_id: None,
                timestamp: chrono::Utc::now(),
                request_id: req_id_snapshot.clone(),
            });
        }
    }

    let count = Some(results.len() as i64);
    Ok(Json(ApiResponse {
        data: results,
        count,
        error: None,
    }))
}

/// DELETE /api/v1/{database_id}/{schema}/{table}?filter=... - 批量按过滤条件删除
///
/// 同 [`update_records`]：必须显式给 filter（防止裸 DELETE 全表）；RBAC + RLS + 缓存
/// 失效 + EventBus 广播 与单条 [`delete_record`] 一致。
pub async fn delete_records(
    State(main_pool): State<PgPool>,
    Path((database_id, schema, table)): Path<(i32, String, String)>,
    headers: HeaderMap,
    raw_query: axum::extract::RawQuery,
    claims: Option<axum::extract::Extension<Claims>>,
    rbac: Option<axum::extract::Extension<PermissionResult>>,
    redis: Option<axum::extract::Extension<RedisManager>>,
    event_bus: Option<axum::extract::Extension<EventBus>>,
    cb_mgr: Option<axum::extract::Extension<CircuitBreakerManager>>,
) -> Result<Json<ApiResponse<Vec<Value>>>> {
    validate_path_identifiers(&schema, &table)?;
    validate_auth(&main_pool, &headers, database_id, claims.is_some()).await?;
    check_circuit_breaker(&cb_mgr, database_id)?;

    let perm = rbac.map(|e| e.0);

    let query_string = raw_query.0.as_deref().unwrap_or("");
    let filters = parse_filters(query_string);
    if filters.is_empty() {
        return Err(AppError::InvalidQuery(
            "批量删除必须提供至少一个过滤条件（如 ?id=eq.123），禁止裸 DELETE 整表".to_string(),
        ));
    }

    let pool = match get_write_pool(&main_pool, database_id).await {
        Ok(p) => p,
        Err(e) => {
            cb_record_failure(&cb_mgr, database_id);
            return Err(e);
        }
    };

    let mut where_clauses: Vec<String> = Vec::new();
    let mut filter_binds: Vec<String> = Vec::new();
    let mut next_param_idx: usize = 1;
    for (field, op, value) in filters.iter() {
        if op == "IS" {
            if value.to_lowercase() == "null" {
                where_clauses.push(format!("\"{}\" IS NULL", field));
            } else {
                where_clauses.push(format!("\"{}\" IS NOT NULL", field));
            }
        } else if op == "IN" {
            let raw = value.trim().trim_start_matches('(').trim_end_matches(')');
            let items: Vec<String> = raw
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if items.is_empty() {
                where_clauses.push("FALSE".to_string());
            } else {
                let placeholders: Vec<String> = (0..items.len())
                    .map(|i| format!("${}", next_param_idx + i))
                    .collect();
                where_clauses.push(format!("\"{}\" IN ({})", field, placeholders.join(", ")));
                let n = items.len();
                for item in items {
                    filter_binds.push(item);
                }
                next_param_idx += n;
            }
        } else {
            where_clauses.push(format!("\"{}\" {} ${}", field, op, next_param_idx));
            filter_binds.push(value.clone());
            next_param_idx += 1;
        }
    }

    let row_conds = perm.as_ref().map(|p| p.row_conditions.clone()).unwrap_or_default();
    if !row_conds.is_empty() {
        next_param_idx = append_rbac_where(
            &mut where_clauses,
            &mut filter_binds,
            &row_conds,
            next_param_idx,
        );
    }
    let _ = next_param_idx;

    let sql = format!(
        "DELETE FROM \"{}\".\"{}\" WHERE {} RETURNING *",
        schema,
        table,
        where_clauses.join(" AND ")
    );

    let mut tx = pool.begin().await.map_err(AppError::Database)?;
    inject_session_user_id(&mut tx, user_id_from_claims(&claims)).await?;

    let mut q = sqlx::query(&sql);
    // 同 update_records：必须 bind_inferred 才能让 bigint / int 列正确比较；
    // 详见 `bind_inferred` 文档与上面注释。
    for v in &filter_binds {
        q = bind_inferred(q, v);
    }

    let rows = match q.fetch_all(&mut *tx).await {
        Ok(r) => {
            cb_record_success(&cb_mgr, database_id);
            r
        }
        Err(e) => {
            cb_record_failure(&cb_mgr, database_id);
            return Err(AppError::InvalidQuery(format!("批量删除失败: {}", e)));
        }
    };
    tx.commit().await.map_err(AppError::Database)?;

    let results: Vec<Value> = rows.iter().map(row_to_json).collect();

    if let Some(axum::extract::Extension(ref r)) = redis {
        QueryCache::invalidate_table(r, database_id, &schema, &table).await;
    }

    if let Some(axum::extract::Extension(ref bus)) = event_bus {
        let req_id_snapshot = crate::request_id::current();
        for old_data in &results {
            bus.publish(DataChangeEvent {
                tenant_id: 0,
                database_id,
                schema: schema.clone(),
                table: table.clone(),
                action: ChangeAction::Delete,
                old_data: Some(old_data.clone()),
                new_data: None,
                user_id: None,
                timestamp: chrono::Utc::now(),
                request_id: req_id_snapshot.clone(),
            });
        }
    }

    let count = Some(results.len() as i64);
    Ok(Json(ApiResponse {
        data: results,
        count,
        error: None,
    }))
}

/// PATCH /api/v1/{database_id}/{table}?filter=... - PostgREST 两段形态的批量更新
///
/// 与 [`update_records`] 的唯一差异：schema 不在 path 里，由 `Content-Profile`
/// （fallback `Accept-Profile`）头决定。filter 翻译复用 [`postgrest_compat`]：
/// `?id=eq.10` 翻译为 `?id.eq=10` 后丢给 [`update_records`]，所有 RBAC / RLS /
/// 缓存 / EventBus 路径都被复用。
pub async fn update_records_pgrest(
    State(main_pool): State<PgPool>,
    Path((database_id, table)): Path<(i32, String)>,
    headers: HeaderMap,
    raw_query: axum::extract::RawQuery,
    claims: Option<axum::extract::Extension<Claims>>,
    rbac: Option<axum::extract::Extension<PermissionResult>>,
    redis: Option<axum::extract::Extension<RedisManager>>,
    event_bus: Option<axum::extract::Extension<EventBus>>,
    cb_mgr: Option<axum::extract::Extension<CircuitBreakerManager>>,
    Json(body): Json<Value>,
) -> Result<Json<ApiResponse<Vec<Value>>>> {
    let schema = postgrest_compat::resolve_schema(&axum::http::Method::PATCH, &headers);
    let synthesized = postgrest_compat::translate_and_augment_query(
        raw_query.0.as_deref(),
        &headers,
    );
    let synthesized_opt = if synthesized.is_empty() {
        None
    } else {
        Some(synthesized)
    };
    update_records(
        State(main_pool),
        Path((database_id, schema, table)),
        headers,
        axum::extract::RawQuery(synthesized_opt),
        claims,
        rbac,
        redis,
        event_bus,
        cb_mgr,
        Json(body),
    )
    .await
}

/// DELETE /api/v1/{database_id}/{table}?filter=... - PostgREST 两段形态的批量删除
pub async fn delete_records_pgrest(
    State(main_pool): State<PgPool>,
    Path((database_id, table)): Path<(i32, String)>,
    headers: HeaderMap,
    raw_query: axum::extract::RawQuery,
    claims: Option<axum::extract::Extension<Claims>>,
    rbac: Option<axum::extract::Extension<PermissionResult>>,
    redis: Option<axum::extract::Extension<RedisManager>>,
    event_bus: Option<axum::extract::Extension<EventBus>>,
    cb_mgr: Option<axum::extract::Extension<CircuitBreakerManager>>,
) -> Result<Json<ApiResponse<Vec<Value>>>> {
    let schema = postgrest_compat::resolve_schema(&axum::http::Method::DELETE, &headers);
    let synthesized = postgrest_compat::translate_and_augment_query(
        raw_query.0.as_deref(),
        &headers,
    );
    let synthesized_opt = if synthesized.is_empty() {
        None
    } else {
        Some(synthesized)
    };
    delete_records(
        State(main_pool),
        Path((database_id, schema, table)),
        headers,
        axum::extract::RawQuery(synthesized_opt),
        claims,
        rbac,
        redis,
        event_bus,
        cb_mgr,
    )
    .await
}

/// 获取表的主键列名
async fn get_primary_key_column(pool: &PgPool, schema: &str, table: &str) -> Result<String> {
    let pk = sqlx::query(
        r#"
        SELECT a.attname as column_name
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE i.indisprimary
        AND n.nspname = $1
        AND c.relname = $2
        LIMIT 1
        "#,
    )
    .bind(schema)
    .bind(table)
    .fetch_optional(pool)
    .await?;
    
    match pk {
        Some(row) => Ok(row.get("column_name")),
        None => Ok("id".to_string()), // 默认使用 id
    }
}

/// 将 JSON 值绑定到查询。
///
/// PG 不做隐式 `text → bigint / timestamptz / date` cast，sqlx 默认会把所有 JSON
/// String 当 PG `text` 发过去——结果 INSERT / UPDATE 进非 text 列时 PG 直接报
/// `column "x" is of type ... but expression is of type text`。
///
/// 这里在 String 路径上做"字面值形态推断"：先尝试解析为常见时间格式，命中就 bind
/// 对应的 chrono 类型（sqlx 会以正确的 PG 类型编码）；都失败再退回 text。
///
/// 已覆盖：
/// - RFC 3339 / ISO 8601 带时区 → `DateTime<Utc>` → `timestamptz`（自动可 cast 到
///   `timestamp` 列，赋值上下文允许）。
/// - 不带时区的 `YYYY-MM-DDTHH:MM:SS[.fff]` → `NaiveDateTime` → `timestamp`。
/// - 纯日期 `YYYY-MM-DD` → `NaiveDate` → `date`。
///
/// **未覆盖**（已知 edge case，再发生时再扩）：
/// - UUID 文本：当前业务很少把 UUID 当 JSON 字符串写到非 text 列。
/// - 数字字面值字符串 `"123"`：不推断为 i64，避免误伤"text 列存数字串"的合法 case。
///   想往 bigint 列写就直接用 JSON Number。
fn bind_json_value<'q>(
    query: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    value: &'q Value,
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    match value {
        Value::Null => query.bind(Option::<String>::None),
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
        Value::String(s) => bind_string_with_datetime_inference(query, s),
        Value::Array(_) | Value::Object(_) => query.bind(value.clone()),
    }
}

/// 见 [`bind_json_value`] 文档：按字面值形态推断 timestamp / date / text。
fn bind_string_with_datetime_inference<'q>(
    query: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    s: &'q str,
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};

    // 启发式：长度太短就不像时间，省下三次 parse 调用。
    //   - `YYYY-MM-DD` = 10
    //   - `YYYY-MM-DDTHH:MM:SS` = 19
    //   - `YYYY-MM-DDTHH:MM:SS.fffZ` 最长约 30+
    if s.len() >= 10 && s.len() <= 35 && s.starts_with(|c: char| c.is_ascii_digit()) {
        // 1) 带时区的 ISO 8601 / RFC 3339 → timestamptz
        if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
            return query.bind(dt.with_timezone(&Utc));
        }
        // 2) 不带时区的 `YYYY-MM-DDTHH:MM:SS[.fff]` → timestamp。两种分隔符都试。
        for fmt in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%d %H:%M:%S"] {
            if let Ok(ndt) = NaiveDateTime::parse_from_str(s, fmt) {
                return query.bind(ndt);
            }
        }
        // 3) 纯日期 `YYYY-MM-DD` → date
        if s.len() == 10 {
            if let Ok(nd) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
                return query.bind(nd);
            }
        }
    }
    query.bind(s)
}

// ============= API Key 管理 =============

/// 生成随机 API Key
fn generate_api_key() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let random_bytes: Vec<u8> = (0..32).map(|_| rng.gen()).collect();
    format!("cr_{}", hex::encode(random_bytes))
}

/// API Key 信息
#[derive(Debug, Serialize)]
pub struct ApiKeyInfo {
    pub id: i32,
    pub name: String,
    pub key_prefix: String,
    pub permissions: Value,
    pub is_active: bool,
    pub last_used_at: Option<String>,
    pub created_at: String,
    pub expires_at: Option<String>,
}

// 旧的 `verify_database_owner(pool, user_id, database_id)` 已下沉到
// `permissions::require_database_admin(pool, &claims, database_id)`。
// 调用点直接持有 Claims，少一次 SQL（用 JWT 里的 is_superadmin 即可），
// 错误信息也由统一模块给出，避免"管理 API Key"这类业务字眼漂移。

/// GET /api/admin/api-keys/{database_id} - 获取项目的 API Keys 列表
pub async fn list_api_keys(
    State(pool): State<PgPool>,
    Path(database_id): Path<i32>,
    claims: axum::extract::Extension<Claims>,
) -> Result<Json<Vec<ApiKeyInfo>>> {
    permissions::require_database_admin(&pool, &claims.0, database_id).await?;
    let keys = sqlx::query(
        r#"
        SELECT id, name, key_prefix, permissions, is_active, 
               last_used_at::TEXT, created_at::TEXT, expires_at::TEXT
        FROM management.api_keys
        WHERE database_id = $1
        ORDER BY created_at DESC
        "#,
    )
    .bind(database_id)
    .fetch_all(&pool)
    .await?;
    
    let result: Vec<ApiKeyInfo> = keys
        .iter()
        .map(|row| ApiKeyInfo {
            id: row.get("id"),
            name: row.get("name"),
            key_prefix: row.get("key_prefix"),
            permissions: row.get("permissions"),
            is_active: row.get("is_active"),
            last_used_at: row.get("last_used_at"),
            created_at: row.get("created_at"),
            expires_at: row.get("expires_at"),
        })
        .collect();
    
    Ok(Json(result))
}

/// POST /api/admin/api-keys/{database_id} - 创建新的 API Key
pub async fn create_api_key(
    State(pool): State<PgPool>,
    Path(database_id): Path<i32>,
    claims: axum::extract::Extension<Claims>,
    Json(req): Json<Value>,
) -> Result<Json<Value>> {
    permissions::require_database_admin(&pool, &claims.0, database_id).await?;

    let name = req["name"].as_str().ok_or_else(|| {
        AppError::InvalidQuery("缺少 API Key 名称".to_string())
    })?;
    
    let tenant_id: i32 = sqlx::query_scalar(
        "SELECT tenant_id FROM management.tenant_databases WHERE id = $1"
    )
    .bind(database_id)
    .fetch_one(&pool)
    .await?;
    
    // 生成 API Key
    let api_key = generate_api_key();
    let key_prefix = format!("{}...", &api_key[..8]); // cr_xxxxx...
    
    // 计算 SHA256 哈希
    use sha2::{Sha256, Digest};
    let mut hasher = Sha256::new();
    hasher.update(api_key.as_bytes());
    let key_hash = hex::encode(hasher.finalize());
    
    // 权限设置（推荐使用 allowed_resources / allowed_actions 精细 scope）
    // 兼容旧字段 read/write/delete；如客户端传入新字段会一并保存
    let mut permissions = req
        .get("permissions")
        .cloned()
        .unwrap_or(json!({"read": true, "write": true, "delete": true}));

    // 如果顶层提供了 allowed_resources / allowed_actions，则合并到 permissions
    if let Some(allowed_resources) = req.get("allowed_resources") {
        if let Some(obj) = permissions.as_object_mut() {
            obj.insert("allowed_resources".to_string(), allowed_resources.clone());
        }
    }
    if let Some(allowed_actions) = req.get("allowed_actions") {
        if let Some(obj) = permissions.as_object_mut() {
            obj.insert("allowed_actions".to_string(), allowed_actions.clone());
        }
    }

    let expires_in_days = req["expires_in_days"].as_i64();
    
    let row = sqlx::query(
        r#"
        INSERT INTO management.api_keys 
        (tenant_id, database_id, name, key_hash, key_prefix, permissions, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::BIGINT IS NOT NULL THEN NOW() + ($7::BIGINT || ' days')::INTERVAL ELSE NULL END)
        RETURNING id, created_at::TEXT
        "#,
    )
    .bind(tenant_id)
    .bind(database_id)
    .bind(name)
    .bind(&key_hash)
    .bind(&key_prefix)
    .bind(&permissions)
    .bind(expires_in_days)
    .fetch_one(&pool)
    .await?;
    
    let id: i32 = row.get("id");
    let created_at: String = row.get("created_at");
    
    tracing::info!("创建了新的 API Key: {} (id={}, database_id={})", name, id, database_id);
    
    Ok(Json(json!({
        "id": id,
        "name": name,
        "api_key": api_key,  // 只在创建时返回完整 key
        "key_prefix": key_prefix,
        "permissions": permissions,
        "created_at": created_at,
        "message": "请保存好 API Key，它只会显示一次！"
    })))
}

/// DELETE /api/admin/api-keys/{database_id}/{key_id} - 删除 API Key
pub async fn delete_api_key(
    State(pool): State<PgPool>,
    Path((database_id, key_id)): Path<(i32, i32)>,
    claims: axum::extract::Extension<Claims>,
) -> Result<Json<Value>> {
    permissions::require_database_admin(&pool, &claims.0, database_id).await?;
    let result = sqlx::query(
        "DELETE FROM management.api_keys WHERE id = $1 AND database_id = $2 RETURNING name"
    )
    .bind(key_id)
    .bind(database_id)
    .fetch_optional(&pool)
    .await?;
    
    match result {
        Some(row) => {
            let name: String = row.get("name");
            tracing::info!("删除了 API Key: {} (id={})", name, key_id);
            Ok(Json(json!({
                "success": true,
                "message": format!("API Key '{}' 已删除", name)
            })))
        }
        None => Err(AppError::NotFound(format!("API Key {} 不存在", key_id))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_filters_decodes_in_list_percent_encoded() {
        // axum::extract::RawQuery 给的是 url-encoded raw 串；客户端常把 `,` 编成
        // `%2C`、`(`/`)` 编成 `%28`/`%29`。parse_filters 必须 decode value 才能让
        // 下游 IN 分支 split(',') 正常拆开。
        let q = "tag_id.in=%281778743781042%2C1778743801935%2C1778743826464%2C1%29";
        let filters = parse_filters(q);
        assert_eq!(filters.len(), 1);
        let (field, op, value) = &filters[0];
        assert_eq!(field, "tag_id");
        assert_eq!(op, "IN");
        assert_eq!(value, "(1778743781042,1778743801935,1778743826464,1)");
    }

    #[test]
    fn parse_filters_decodes_eq_value_with_spaces() {
        // `+` 是 form-encoded 的空格，但 RawQuery 是 URI 风格（不把 `+` 当空格），
        // 业务上空格被编成 `%20`。检查这条更代表线上场景。
        let q = "name.eq=hello%20world";
        let filters = parse_filters(q);
        assert_eq!(filters.len(), 1);
        let (field, op, value) = &filters[0];
        assert_eq!(field, "name");
        assert_eq!(op, "=");
        assert_eq!(value, "hello world");
    }

    #[test]
    fn parse_filters_skips_invalid_field_names() {
        // 防 SQL 注入：parse_filters 校验 identifier 合法性，含 `;` 之类的整条 drop
        let q = "drop;table.eq=1&legit_field.eq=2";
        let filters = parse_filters(q);
        assert_eq!(filters.len(), 1);
        assert_eq!(filters[0].0, "legit_field");
    }
}

/// PATCH /api/admin/api-keys/{database_id}/{key_id} - 更新 API Key (启用/禁用)
pub async fn update_api_key(
    State(pool): State<PgPool>,
    Path((database_id, key_id)): Path<(i32, i32)>,
    claims: axum::extract::Extension<Claims>,
    Json(req): Json<Value>,
) -> Result<Json<Value>> {
    permissions::require_database_admin(&pool, &claims.0, database_id).await?;
    let is_active = req["is_active"].as_bool();
    
    if let Some(active) = is_active {
        sqlx::query(
            "UPDATE management.api_keys SET is_active = $1 WHERE id = $2 AND database_id = $3"
        )
        .bind(active)
        .bind(key_id)
        .bind(database_id)
        .execute(&pool)
        .await?;
        
        Ok(Json(json!({
            "success": true,
            "message": if active { "API Key 已启用" } else { "API Key 已禁用" }
        })))
    } else {
        Err(AppError::InvalidQuery("请提供 is_active 参数".to_string()))
    }
}

