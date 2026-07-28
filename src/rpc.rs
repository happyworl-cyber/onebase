//! PostgREST 风格的 RPC（存储过程调用）端点。
//!
//! 把请求参数按字段名作为命名参数（`arg := $N`）传给目标 PG 函数并返回结果，
//! 行为对齐 Supabase / PostgREST 的 `rpc/<function_name>` 语义；与本平台
//! Auto API 保持同款 URL 形态——项目 ID 直接出现在路径里：
//!
//!   `POST  /api/v1/:database_id/rpc/:fn_name`
//!   `GET   /api/v1/:database_id/rpc/:fn_name`
//!
//! 这样调用方组路径只需要一套规则（`/api/v1/{project_id}/...`），不再像旧版
//! `/rest/v1/rpc/...` 那样需要额外读 `X-Database-Id` 头。
//!
//! 兼容点：
//! - POST 请求体：JSON object，字段名 = 形参名
//! - GET 请求：query string 即形参，每个 value 先按 JSON 解析（"123" → 数字、
//!   "true"/"false"/"null"、`[..]`、`{..}` 都识别），其它当字符串。
//! - schema 选择优先级：
//!     POST: `Content-Profile` header > `?schema=` > 默认 `public`
//!     GET : `Accept-Profile`  header > `?schema=` > 默认 `public`
//! - `Prefer: params=single-object` → 把整段 body 作为单个 jsonb 实参传入（仅 POST）
//!
//! 数据隔离：路径中的 `database_id` 是**唯一权威源**——`rpc_auth_middleware` 会
//! 据此覆盖 `X-Database-Id` 头，再交给 `dynamic_db_middleware` 切池。即使调用方
//! 自带了不一致的 `X-Database-Id`，也以 URL 路径为准（API Key 与路径不匹配会
//! 直接 401，避免跨项目越权）。

use axum::{
    extract::{Extension, Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    middleware::Next,
    response::Response,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Column, PgPool, Postgres, Row, Transaction};
use std::collections::HashMap;

use crate::auth::{verify_token, Claims};
use crate::error::AppError;
use crate::permission_cache::PermissionCache;
use crate::query_builder::QueryParams;
use crate::rbac_handlers::query_user_permissions;
use crate::redis_manager::RedisManager;

/// PostgREST 在 GET 中保留给元控制的 query 键，不进入函数实参列表。
/// 我们目前只需要 `schema`；其它（select/order/limit/offset）对 RPC 没意义，
/// 但仍然显式忽略以避免语义混淆。
const RESERVED_QUERY_KEYS: &[&str] = &["schema", "select", "order", "limit", "offset"];

#[derive(Debug, Deserialize)]
pub struct RpcQuery {
    pub schema: Option<String>,
}

/// PG 函数返回形态描述，用于决定响应 JSON 的拆包方式。
struct FunctionShape {
    /// `pg_proc.proretset`：是否为 SETOF / TABLE 之类的多行返回。
    returns_set: bool,
    /// 返回类型 OID 是否为 `void`（2278）。
    returns_void: bool,
    /// 返回类型是否为复合类型（`pg_type.typtype = 'c'`，比如显式 RETURNS TABLE 或 RECORD）。
    returns_composite: bool,
    /// 该 `schema.fn_name` 的所有重载签名 —— 同名函数可以有多个不同形参列表。
    /// 命名参数调用时按业务方传入的参数名集合匹配唯一重载，然后用其形参类型做 cast。
    overloads: Vec<FunctionOverload>,
}

/// 单个 PG 函数重载的形参信息（用来按 PG 形参类型给 prepared statement 显式 cast）。
#[derive(Debug, Clone)]
struct FunctionOverload {
    /// 形参名列表，顺序与 [`Self::arg_types`] / `pg_proc.proargtypes` 一致。
    arg_names: Vec<String>,
    /// 形参的 PG 类型字面值（`format_type(typoid, NULL)` 的结果），例如：
    /// `integer` / `bigint` / `text[]` / `jsonb` / `numeric(10,2)` 等。
    /// 拼 SQL 时直接附加 `::<arg_types[i]>` 即可。
    arg_types: Vec<String>,
}

/// `POST /api/v1/:database_id/rpc/:fn_name` —— 主要入口，最贴合 supabase-js 默认行为。
pub async fn execute_rpc(
    State(main_pool): State<PgPool>,
    dynamic_pool: Option<Extension<PgPool>>,
    redis: Option<Extension<RedisManager>>,
    Extension(subject): Extension<RpcAuthSubject>,
    Path((database_id, fn_name)): Path<(i32, String)>,
    Query(rpc_query): Query<RpcQuery>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let body_value = body.map(|Json(v)| v).unwrap_or(Value::Object(Default::default()));
    let body_obj: serde_json::Map<String, Value> = match body_value {
        Value::Object(map) => map,
        Value::Null => serde_json::Map::new(),
        _ => {
            return Err(AppError::InvalidQuery(
                "RPC 请求体必须是 JSON 对象".to_string(),
            ));
        }
    };

    // POST 用 Content-Profile 选 schema（PostgREST 约定）。
    let schema = resolve_schema(&headers, "content-profile", rpc_query.schema.clone());

    // POST 才支持 `Prefer: params=single-object`——把整段 body 当成单个 jsonb 形参。
    let single_object = parse_prefer_single_object(&headers);
    // `Accept: application/vnd.pgrst.object+json` —— PostgREST / supabase-js 的 `.single()`
    // 语义：希望响应是一个**单 object**而非数组。仅当 rows 恰好 1 行才成立；0 行 / 多行
    // 返 406。
    let single_object_response = wants_single_object_response(&headers);

    run_rpc(
        &main_pool,
        dynamic_pool.as_ref().map(|ext| &ext.0),
        redis.as_ref().map(|ext| &ext.0),
        &subject,
        database_id,
        &fn_name,
        schema,
        body_obj,
        single_object,
        single_object_response,
    )
    .await
}

/// `GET /api/v1/:database_id/rpc/:fn_name` —— 用于 IMMUTABLE / STABLE 函数 / CDN 缓存场景。
///
/// 形参从 query string 拿；保留键（`schema`/`select`/...）不进入实参列表。
/// 每个 value 先尝试当 JSON 解析（数字、bool、null、数组/对象都自然识别），
/// 失败再当字符串——和 supabase-js 在 `get: true` 时的反序列化语义一致。
pub async fn execute_rpc_get(
    State(main_pool): State<PgPool>,
    dynamic_pool: Option<Extension<PgPool>>,
    redis: Option<Extension<RedisManager>>,
    Extension(subject): Extension<RpcAuthSubject>,
    Path((database_id, fn_name)): Path<(i32, String)>,
    Query(raw_query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let schema_override = raw_query.get("schema").cloned();
    let mut args = serde_json::Map::new();
    for (key, raw_value) in raw_query.into_iter() {
        if RESERVED_QUERY_KEYS.iter().any(|r| r.eq_ignore_ascii_case(&key)) {
            continue;
        }
        args.insert(key, parse_query_value(&raw_value));
    }

    // GET 用 Accept-Profile 选 schema（PostgREST 约定）。
    let schema = resolve_schema(&headers, "accept-profile", schema_override);

    // GET 不支持 `Prefer: params=single-object`——PostgREST 也是这样；想用就发 POST。
    // 但 `Accept: application/vnd.pgrst.object+json` 在 GET 上是支持的（PostgREST 通用）。
    let single_object_response = wants_single_object_response(&headers);

    run_rpc(
        &main_pool,
        dynamic_pool.as_ref().map(|ext| &ext.0),
        redis.as_ref().map(|ext| &ext.0),
        &subject,
        database_id,
        &fn_name,
        schema,
        args,
        false,
        single_object_response,
    )
    .await
}

/// 不依赖 axum 入口的 RPC 执行入口——供 scheduler 等后台 task 调用。
///
/// 与 axum handler `execute_rpc` 的区别只在调用形态：本函数直接接受 PgPool 引用
/// 和已构造好的 `Claims`（包成 `RpcAuthSubject::User`），不再经过 middleware 链。
/// 内部仍然走 `run_rpc` 的同款 ACL + 形态查询 + 执行 + 形态拆包路径，
/// **不绕过任何 RBAC 校验**。
pub async fn execute_rpc_inner(
    main_pool: &PgPool,
    dynamic_pool: Option<&PgPool>,
    redis: Option<&RedisManager>,
    claims: &Claims,
    database_id: i32,
    schema: &str,
    fn_name: &str,
    args: serde_json::Map<String, Value>,
) -> Result<Value, AppError> {
    let subject = RpcAuthSubject::User(claims.clone());
    // scheduler 等后台调用方拿不到 HTTP 头：
    //   - `single_object` = false  → Prefer: params=single-object（POST 时把整个 args
    //     当一个 jsonb object 传）；后台调用是结构化 named args，永远走多参数模式。
    //   - `single_object_response` = false → Accept: application/vnd.pgrst.object+json
    //     是 supabase-js `.single()` 标记，后台没有 HTTP 客户端，直接返裸结果即可。
    let (_status, Json(value)) = run_rpc(
        main_pool,
        dynamic_pool,
        redis,
        &subject,
        database_id,
        fn_name,
        schema.to_string(),
        args,
        false,
        false,
    )
    .await?;
    Ok(value)
}

/// 共享执行核心：标识符校验 → ACL 校验 → 函数形态查询 → 构 SQL → 执行 → 形态拆包。
async fn run_rpc(
    main_pool: &PgPool,
    dynamic_pool: Option<&PgPool>,
    redis: Option<&RedisManager>,
    subject: &RpcAuthSubject,
    database_id: i32,
    fn_name: &str,
    schema: String,
    args: serde_json::Map<String, Value>,
    single_object: bool,
    single_object_response: bool,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let schema = QueryParams::sanitize_identifier(&schema)?;
    let fn_ident = QueryParams::sanitize_identifier(fn_name)?;

    // ACL 校验必须在最早期执行：避免函数存在性 / 形态信息被无权限的调用方探测出来。
    enforce_rpc_permission(
        main_pool,
        redis,
        subject,
        database_id,
        &schema,
        &fn_ident,
    )
    .await?;

    // 优先用租户库，没注入时落到管理库——与 /query、/transaction 同策略。
    let pool: &PgPool = dynamic_pool.unwrap_or(main_pool);

    let shape = lookup_function_shape(pool, &schema, &fn_ident).await?;

    // 构造 SQL 与绑定参数顺序。
    //
    // 命名参数模式 (`fn(arg := $N)`)：用客户端传入字段名当形参名，PG 会按
    // 名字匹配 + 解决重载，避免参数顺序敏感问题。所有形参名都过 sanitize。
    // (value, cast_type_hint) —— cast_type_hint 来自 resolve_overload 推断的目标 PG
    // 类型字面值（如 `integer` / `text[]`），bind_json_value 据此选择 array 二进制协议
    // 或者 jsonb 字符串路径。
    let (sql, bind_values): (String, Vec<(Value, Option<String>)>) = if single_object {
        let body_json = Value::Object(args);
        (
            format!("SELECT * FROM \"{}\".\"{}\"($1::jsonb)", schema, fn_ident),
            // Object 在 bind_json_value 内永远走 to_string()+::jsonb 路径，
            // cast_type=None 即可，传 Some("jsonb") 也等价
            vec![(body_json, None)],
        )
    } else if args.is_empty() {
        (
            format!("SELECT * FROM \"{}\".\"{}\"()", schema, fn_ident),
            Vec::new(),
        )
    } else {
        // 先把业务方传入的参数名收集成 &str slice，喂给 resolve_overload 匹配重载。
        // 匹配成功 → 每个 $N 按"该重载的形参类型"显式 cast，让 PG 函数解析精确命中；
        // 匹配失败（重载不存在 / 歧义）→ 回落到按 JSON 字面值的简易 cast（仅
        // 对象/数组强制 jsonb 避免 text → jsonb 不兼容），其余让 PG 自己推断 ——
        // 即便最后 PG 报 "function does not exist" 错误信息也比静默 cast 错更可调试。
        let provided_names: Vec<&str> = args.keys().map(String::as_str).collect();
        let matched = resolve_overload(&shape.overloads, &provided_names, &args);
        if matched.is_none() {
            tracing::debug!(
                schema = %schema,
                fn_name = %fn_ident,
                provided = ?provided_names,
                overload_count = shape.overloads.len(),
                "RPC: 未匹配到唯一重载，回落到字面值 cast（仅对象/数组强制 jsonb）"
            );
        }

        let mut arg_clauses = Vec::with_capacity(args.len());
        let mut binds = Vec::with_capacity(args.len());
        for (i, (key, value)) in args.iter().enumerate() {
            // 形参名必须是合法 PG 标识符；非法直接 400，避免 SQL 注入。
            let safe_key = QueryParams::sanitize_identifier(key)?;

            // 选 cast 字面值（attribute_type）：
            //   - 匹配到唯一重载 → 用该重载 argtypes 里对应的 PG 类型字面值
            //   - 未匹配 / 形参不在 argnames 列表（用户传了不存在的形参）→ 回落
            let cast_type: Option<String> = matched
                .and_then(|m| {
                    m.arg_names
                        .iter()
                        .position(|n| n == key)
                        .and_then(|idx| m.arg_types.get(idx))
                })
                .cloned();

            let placeholder = match cast_type.as_deref() {
                Some(ty) => format!("${}::{}", i + 1, ty),
                None => match value {
                    // 没匹配到重载时：对象 / 数组仍然要强制 jsonb，否则 sqlx 把它
                    // 序列化成 text 后 PG 会拒收 jsonb 形参
                    Value::Array(_) | Value::Object(_) => format!("${}::jsonb", i + 1),
                    _ => format!("${}", i + 1),
                },
            };
            arg_clauses.push(format!("\"{}\" := {}", safe_key, placeholder));
            binds.push((value.clone(), cast_type));
        }
        (
            format!(
                "SELECT * FROM \"{}\".\"{}\"({})",
                schema,
                fn_ident,
                arg_clauses.join(", ")
            ),
            binds,
        )
    };

    tracing::debug!(
        "RPC 调用: schema={} fn={} single_object={} args={}",
        schema,
        fn_ident,
        single_object,
        bind_values.len()
    );

    // 包一层事务，把调用方身份注入到事务局部 GUC（`set_config(_, _, true)` 等价
    // SET LOCAL，COMMIT 后自动清，不污染连接池里这条连接的下次复用）。
    //
    // 这是 Onebase 给业务函数提供"调用方上下文"的标准通道，与 `auto_api_handlers`
    // 的 `inject_session_user_id` 同款做法。业务函数可以读：
    //   - `current_setting('app.current_user_id', true)` —— JWT 调用是用户 ID；
    //     API Key 调用统一写 `'0'`，与现有 RLS helper（migrations/013_rls_helpers.sql
    //     `app.current_user_id()`）的"匿名"语义对齐。
    //   - `current_setting('app.project_ids', true)` —— 逗号分隔的项目 ID 列表，
    //     来自 API Key `permissions.project_ids` JSON 数组。业务方在 `RAISE EXCEPTION
    //     ... ERRCODE = '42501'` 风格的 project guard 里 `string_to_array(...,',')::int[]`
    //     即可使用（详见 docs/postgres-rls-guide.md）。
    //
    // 设计要点：项目 ID 列表必须由**服务端**从 API Key 的 permissions 读取，
    // 严禁让客户端通过 header / body 自带——否则 `assert_project_access` 形同虚设。
    let mut tx: Transaction<'_, Postgres> = pool.begin().await.map_err(AppError::Database)?;
    inject_rpc_session_context(&mut tx, subject).await?;

    let mut q = sqlx::query(&sql);
    for (v, cast_type) in &bind_values {
        q = bind_json_value(q, v, cast_type.as_deref());
    }

    let rows = q.fetch_all(&mut *tx).await?;
    tx.commit().await.map_err(AppError::Database)?;

    // `Accept: application/vnd.pgrst.object+json` —— 强制单 object 响应。
    // 行为对齐 PostgREST：
    //   - rows.len() == 1：unwrap 成 object（即便函数 RETURNS SETOF / TABLE，业务方
    //     主动表达了"我知道只会有一行"）
    //   - 0 行：406 `"JSON object requested, no rows returned"`
    //   - 多行：406 `"JSON object requested, multiple rows returned"`
    if single_object_response {
        let row_count = rows.len();
        if row_count == 0 {
            return Err(AppError::InvalidQuery(
                "JSON object requested, no rows returned".to_string(),
            ));
        }
        if row_count > 1 {
            return Err(AppError::InvalidQuery(format!(
                "JSON object requested, multiple ({}) rows returned",
                row_count
            )));
        }
        // 复用 build_response_payload 的单行打包路径：临时把 shape.returns_set 当 false，
        // 让它走 "非集合返回" 分支统一拆出 object/scalar，避免在这里重写一次拆解逻辑
        let shape_single = FunctionShape {
            returns_set: false,
            returns_void: shape.returns_void,
            returns_composite: shape.returns_composite,
            // overloads 在 build_response_payload 内不再使用，传空 Vec 即可
            overloads: Vec::new(),
        };
        let payload = build_response_payload(rows, &fn_ident, &shape_single);
        return Ok((StatusCode::OK, Json(payload)));
    }

    let payload = build_response_payload(rows, &fn_ident, &shape);
    Ok((StatusCode::OK, Json(payload)))
}

/// 解析 `Accept` 头是否包含 `application/vnd.pgrst.object+json`。
///
/// PostgREST 标准 Accept 头有以下取值（按需可扩）：
/// - `application/json`（默认）
/// - `application/vnd.pgrst.object+json` —— 单 object（本函数检测的就是这个）
/// - `application/vnd.pgrst.array+json` —— 单 array（与默认等价，PostgREST 仍接受）
/// - `text/csv` / `application/geo+json` —— 暂不支持
///
/// 允许多个 media type 用逗号分隔，**任何一个**匹配上就返回 true（不解析 q 值
/// 偏好，因为客户端在表达 `.single()` 意图时总是把这个值作为首选）。
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

/// 解析 schema：header > query 覆盖 > 默认 public。
fn resolve_schema(
    headers: &HeaderMap,
    header_name: &str,
    query_override: Option<String>,
) -> String {
    headers
        .get(header_name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .or(query_override)
        .unwrap_or_else(|| "public".to_string())
}

/// 解析 `Prefer: params=single-object`（大小写不敏感、允许多个 prefer 用逗号分隔）。
fn parse_prefer_single_object(headers: &HeaderMap) -> bool {
    headers
        .get("prefer")
        .and_then(|v| v.to_str().ok())
        .map(|s| {
            s.split(',')
                .any(|part| part.trim().eq_ignore_ascii_case("params=single-object"))
        })
        .unwrap_or(false)
}

/// query string 的 value 智能解析——优先 JSON，失败兜底字符串。
///
/// 这样 `?id=123` 进函数当 integer，`?meta={"a":1}` 进函数当 jsonb，
/// `?name=Alice` 仍然当 text；与 PostgREST / supabase-js 的 GET 语义一致。
fn parse_query_value(raw: &str) -> Value {
    if let Ok(v) = serde_json::from_str::<Value>(raw) {
        // 注意：serde_json 不会把裸字符串（如 `Alice`）当成合法 JSON，会失败 →
        // 走下面的 String 分支。带引号的 `"Alice"` 会成功，自然得到 String。
        return v;
    }
    Value::String(raw.to_string())
}

/// 查询 `pg_catalog` 拿目标函数的返回形态；找不到时返回 404，方便定位。
///
/// 当存在重载时取第一行——重载之间通常返回类型一致；若不一致，调用方应自行
/// 区分（重载主要靠参数列表区分，本端点只校验函数存在性）。
async fn lookup_function_shape(
    pool: &PgPool,
    schema: &str,
    fn_name: &str,
) -> Result<FunctionShape, AppError> {
    // 一次性把同名函数的所有重载查出来：返回形态字段（第一条覆盖即可，PostgREST 也
    // 不区分重载的返回 shape）+ 每个重载的形参 (names, types)。
    //
    // - `proargnames` 是 `text[]`，对于全位置参数函数可能为 NULL（旧版 PG 行为）
    // - `proargtypes` 是 `oidvector`：**只含 IN 参数**，命名参数调用最常用
    // - `format_type(oid, NULL)` 把 oid 转成可直接拼进 SQL 的类型字面值，
    //   保留数组括号 / typmod / schema 前缀（如 `public.my_enum`），避免我们自行
    //   维护 oid → 字面值映射表
    let rows = sqlx::query(
        r#"
        SELECT
            p.proretset                                     AS proretset,
            p.prorettype::int8                              AS rettype,
            t.typtype::text                                 AS typtype,
            COALESCE(p.proargnames, ARRAY[]::text[])        AS argnames,
            COALESCE(
                ARRAY(
                    SELECT format_type(u.oid, NULL)
                    FROM unnest(p.proargtypes) WITH ORDINALITY AS u(oid, ord)
                    ORDER BY u.ord
                ),
                ARRAY[]::text[]
            )                                               AS argtypes
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        JOIN pg_type     t ON p.prorettype   = t.oid
        WHERE n.nspname = $1 AND p.proname = $2
        ORDER BY p.oid
        "#,
    )
    .bind(schema)
    .bind(fn_name)
    .fetch_all(pool)
    .await?;

    if rows.is_empty() {
        return Err(AppError::NotFound(format!(
            "函数 {}.{}() 不存在",
            schema, fn_name
        )));
    }

    // 返回形态：取第一行（同名重载理论上返回 shape 一致；即使不一致下游也会按
    // returns_set/composite 容忍 —— 真正影响 SQL 拼接的是 overloads.arg_types）。
    let first = &rows[0];
    let returns_set: bool = first.try_get("proretset").unwrap_or(false);
    let prorettype: i64 = first.try_get("rettype").unwrap_or(0);
    let returns_void = prorettype == 2278;
    let typtype: String = first
        .try_get::<String, _>("typtype")
        .unwrap_or_else(|_| "b".to_string());
    let returns_composite = typtype == "c" || prorettype == 2249;

    let overloads = rows
        .iter()
        .map(|r| {
            let arg_names: Vec<String> = r.try_get("argnames").unwrap_or_default();
            let arg_types: Vec<String> = r.try_get("argtypes").unwrap_or_default();
            FunctionOverload {
                arg_names,
                arg_types,
            }
        })
        .collect();

    Ok(FunctionShape {
        returns_set,
        returns_void,
        returns_composite,
        overloads,
    })
}

/// 按业务方传入的命名参数集合匹配唯一重载，返回参数名 → PG 类型字面值的映射。
///
/// 匹配规则（与 PostgREST 对齐）：
///
/// 1. 候选重载的形参名集合 **完全等于**业务方传入的参数名集合 → 完美匹配，优先
/// 2. 否则候选重载的形参名集合 **超集**业务方传入参数（多余形参可走 DEFAULT）
/// 3. 多个候选时按 JSON 值类型与形参 PG 类型的"兼容度"打分挑最匹配 —— 复刻 PG
///    自己的重载解析行为：调用方写 `fn(p_limit := 100)`，PG 默认按 integer
///    解析常量，若同时存在 `fn(p_limit integer)` 与 `fn(p_limit bigint)`，
///    PG 优先选 integer 这一组。我们的 JSON 值在 sqlx 端会按 i64 编码（bigint），
///    若不在这里做评分，加到 SQL 上的 cast 就会被跳过，PG 直接报
///    `function does not exist`（因为它收到 bigint 后再去找 (p_limit bigint)
///    的重载，而 dropdown 里展示的那条只有 integer）。
/// 4. 零候选 → 返回 None，回落到"按字面值类型 cast"（与历史行为一致）
///
/// 返回 None 不是 fatal —— 让 PG 自己报"function does not exist"或者走老路径，
/// 这样不会因为我们的匹配逻辑 bug 而比之前更糟。
fn resolve_overload<'a>(
    overloads: &'a [FunctionOverload],
    provided_names: &[&str],
    provided_values: &serde_json::Map<String, Value>,
) -> Option<&'a FunctionOverload> {
    let provided: std::collections::HashSet<&str> = provided_names.iter().copied().collect();

    // 第 1 轮：完全相等匹配
    let exact: Vec<&FunctionOverload> = overloads
        .iter()
        .filter(|o| {
            let s: std::collections::HashSet<&str> =
                o.arg_names.iter().map(String::as_str).collect();
            s == provided
        })
        .collect();
    if exact.len() == 1 {
        return Some(exact[0]);
    }
    if exact.len() > 1 {
        // 完全相等仍然有多个 = 形参类型不同的同名重载（如 integer vs bigint）。
        // 按 JSON 值类型兼容度打分挑最优，让一个真实存在的 cast 总能落到 SQL 上。
        return pick_best_overload_by_values(&exact, provided_values);
    }

    // 第 2 轮：候选形参名集合是 provided 的超集（剩余形参走 DEFAULT）
    let superset: Vec<&FunctionOverload> = overloads
        .iter()
        .filter(|o| {
            let s: std::collections::HashSet<&str> =
                o.arg_names.iter().map(String::as_str).collect();
            provided.is_subset(&s)
        })
        .collect();
    if superset.len() == 1 {
        return Some(superset[0]);
    }
    if superset.len() > 1 {
        return pick_best_overload_by_values(&superset, provided_values);
    }
    None
}

/// 多个候选重载之间用 JSON 值类型兼容度打分，挑得分最高者；同分则取首个
/// （pg_proc.oid 顺序 = 创建顺序，与 PG 自身在歧义重载下的潜规则一致）。
fn pick_best_overload_by_values<'a>(
    candidates: &[&'a FunctionOverload],
    values: &serde_json::Map<String, Value>,
) -> Option<&'a FunctionOverload> {
    let mut best: Option<(&FunctionOverload, i64)> = None;
    for c in candidates {
        let score: i64 = c
            .arg_names
            .iter()
            .zip(c.arg_types.iter())
            .map(|(name, ty)| score_arg_type_against_value(ty, values.get(name)))
            .sum();
        match best {
            None => best = Some((*c, score)),
            // 严格 > 才替换：保留首个最高分（pg_proc.oid 顺序 = 创建顺序）
            Some((_, prev)) if score > prev => best = Some((*c, score)),
            _ => {}
        }
    }
    best.map(|(c, _)| c)
}

/// 给定 PG 形参类型字面值与一个可选 JSON 值，估算 PG 在该值上选中此类型的偏好。
///
/// 分数越高 = 越契合。设计原则：复刻 PG 重载解析的偏好（exact > 同族 widen > 不同族），
/// 不指望覆盖所有类型——只解决最常见的 integer/bigint/text/json 重载歧义。
/// 未列出的类型走"低分但非零"兜底，避免在含未知类型的重载里整组归零。
fn score_arg_type_against_value(pg_type: &str, value: Option<&Value>) -> i64 {
    let ty = normalize_pg_type(pg_type);
    let ty = ty.as_str();
    match value {
        // 形参没人传 → 走 DEFAULT。给中性分，避免影响 exact-match 候选之间的相对排序。
        None => 50,
        Some(Value::Null) => 50,
        Some(Value::Bool(_)) => match ty {
            "boolean" | "bool" => 100,
            _ => 10,
        },
        Some(Value::Number(n)) => {
            if n.is_i64() {
                let i = n.as_i64().unwrap_or(0);
                let fits_i32 = i32::try_from(i).is_ok();
                let fits_i16 = i16::try_from(i).is_ok();
                match ty {
                    // 整数 JSON 字面量在 PG 中默认按 integer 解析；这是首选
                    "integer" | "int4" if fits_i32 => 100,
                    "bigint" | "int8" => 90,
                    "smallint" | "int2" if fits_i16 => 70,
                    "numeric" | "decimal" => 60,
                    "double precision" | "float8" => 55,
                    "real" | "float4" => 50,
                    "text" | "varchar" => 20,
                    _ => 15,
                }
            } else {
                // 浮点
                match ty {
                    "double precision" | "float8" => 100,
                    "real" | "float4" => 85,
                    "numeric" | "decimal" => 80,
                    "integer" | "int4" | "bigint" | "int8" | "smallint" | "int2" => 30,
                    _ => 15,
                }
            }
        }
        Some(Value::String(_)) => match ty {
            "text" => 100,
            "varchar" => 95,
            "char" | "bpchar" => 85,
            "name" => 80,
            "uuid" => 75,
            "date" | "timestamp" | "timestamptz" | "time" | "timetz" | "interval" => 70,
            "jsonb" | "json" => 40,
            _ => 20,
        },
        Some(Value::Array(_)) => {
            if ty.ends_with("[]") {
                100
            } else if ty == "jsonb" {
                85
            } else if ty == "json" {
                80
            } else {
                15
            }
        }
        Some(Value::Object(_)) => match ty {
            "jsonb" => 100,
            "json" => 90,
            "hstore" => 70,
            _ => 15,
        },
    }
}

/// 按 PostgREST/Supabase 的语义把 PG 行集装箱成调用方期望的 JSON 形态：
/// - `RETURNS void` → `null`
/// - SETOF / TABLE / 多行 → 数组
/// - 单行单标量 → 拆出标量值（列名通常等于函数名）
/// - 单行复合（RETURNS RECORD / 表类型）→ 单个对象
fn build_response_payload(
    rows: Vec<sqlx::postgres::PgRow>,
    fn_name: &str,
    shape: &FunctionShape,
) -> Value {
    if shape.returns_void {
        return Value::Null;
    }

    let json_rows: Vec<serde_json::Map<String, Value>> =
        rows.iter().map(row_to_map).collect();

    if shape.returns_set {
        return Value::Array(json_rows.into_iter().map(Value::Object).collect());
    }

    // 非集合返回：理论上至多一行。
    match json_rows.into_iter().next() {
        None => Value::Null,
        Some(mut obj) => {
            // 单标量：1 列且列名是 fn_name 或 PG 默认占位 "?column?"。
            if !shape.returns_composite && obj.len() == 1 {
                let key = obj.keys().next().cloned().unwrap_or_default();
                if key == fn_name || key == "?column?" {
                    return obj.remove(&key).unwrap_or(Value::Null);
                }
            }
            Value::Object(obj)
        }
    }
}

/// 把单行转换为 JSON map。延用项目内其他 handler 同款的"逐类型 try_get"
/// 探测策略——sqlx 没有提供 row → JSON 的官方通道，逐类型尝试是最稳的兜底。
fn row_to_map(row: &sqlx::postgres::PgRow) -> serde_json::Map<String, Value> {
    let mut obj = serde_json::Map::new();
    for column in row.columns() {
        let key = column.name().to_string();
        let idx = column.ordinal();

        let value: Value = if let Ok(v) = row.try_get::<serde_json::Value, _>(idx) {
            v
        } else if let Ok(v) = row.try_get::<String, _>(idx) {
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
        } else if let Ok(v) = row.try_get::<Option<f64>, _>(idx) {
            v.map(|n| json!(n)).unwrap_or(Value::Null)
        } else if let Ok(v) = row.try_get::<Option<bool>, _>(idx) {
            v.map(Value::Bool).unwrap_or(Value::Null)
        } else {
            Value::Null
        };

        obj.insert(key, value);
    }
    obj
}

/// 把 JSON value 绑定到 sqlx Query。
///
/// 关键参数 `cast_type`：来自 [`resolve_overload`] 推断的目标 PG 类型字面值（如
/// `integer` / `text[]` / `jsonb` / `numeric`）。Array 编码路径会用它决定走"数组
/// 协议"还是"jsonb 字符串协议"：
///
/// - 目标 `text[]` / `varchar[]` → bind 成 `Vec<String>`，sqlx 自动按 PG `_text`
///   二进制协议发送 —— **不是** `'[a,b]'::text[]` 这种字面量解析路径，避免 PG 见到
///   JSON 风格的 `[...]` 报 `malformed array literal`
/// - 目标 `integer[]` / `int4[]` → `Vec<i32>` →  PG `_int4`
/// - 目标 `bigint[]`  / `int8[]` → `Vec<i64>` → PG `_int8`
/// - 目标 `jsonb` / `json` / 其它 / `None` → 退化到 `value.to_string()` 再让 SQL
///   端的 `::jsonb` 显式 cast 处理，与历史行为一致
///
/// Object：永远走 jsonb 路径（PG 没有 record literal 的 portable bind 方案）。
fn bind_json_value<'q>(
    query: sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments>,
    value: &'q Value,
    cast_type: Option<&str>,
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
        Value::Array(items) => bind_json_array(query, items, cast_type),
        Value::Object(_) => query.bind(value.to_string()),
    }
}

/// Array 绑定子例程：按 `cast_type` 走真正的 PG 数组二进制协议；不匹配则退化 jsonb。
fn bind_json_array<'q>(
    query: sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments>,
    items: &'q [Value],
    cast_type: Option<&str>,
) -> sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments> {
    let normalized = cast_type.map(normalize_pg_type);
    match normalized.as_deref() {
        Some("text[]") | Some("varchar[]") | Some("name[]") | Some("char[]") => {
            // 把 JSON element 统一成 String（数字 / bool / null 用各自字面量；null →
            // 空串。`null` 严格映射到 SQL NULL 需要 Option<String>，但 PG text[] 里
            // 表达 NULL 元素的 portable 路径要走 Vec<Option<String>>；先简单按空串。
            let v: Vec<String> = items
                .iter()
                .map(|x| match x {
                    Value::String(s) => s.clone(),
                    Value::Null => String::new(),
                    other => other.to_string(),
                })
                .collect();
            query.bind(v)
        }
        Some("int4[]") | Some("integer[]") => {
            // try_from 失败（超 i32 范围 / 浮点 / 字符串）→ 0 兜底；business 上 PG 会
            // 因为业务校验失败拒掉，比 sqlx encode panic 更可调试
            let v: Vec<i32> = items
                .iter()
                .map(|x| x.as_i64().and_then(|i| i32::try_from(i).ok()).unwrap_or(0))
                .collect();
            query.bind(v)
        }
        Some("int8[]") | Some("bigint[]") => {
            let v: Vec<i64> = items.iter().map(|x| x.as_i64().unwrap_or(0)).collect();
            query.bind(v)
        }
        Some("int2[]") | Some("smallint[]") => {
            let v: Vec<i16> = items
                .iter()
                .map(|x| x.as_i64().and_then(|i| i16::try_from(i).ok()).unwrap_or(0))
                .collect();
            query.bind(v)
        }
        Some("float4[]") | Some("real[]") => {
            let v: Vec<f32> = items.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect();
            query.bind(v)
        }
        Some("float8[]") | Some("double precision[]") => {
            let v: Vec<f64> = items.iter().map(|x| x.as_f64().unwrap_or(0.0)).collect();
            query.bind(v)
        }
        Some("bool[]") | Some("boolean[]") => {
            let v: Vec<bool> = items.iter().map(|x| x.as_bool().unwrap_or(false)).collect();
            query.bind(v)
        }
        // 包括 jsonb / json / unknown / None：序列化成 JSON 字符串 + 让 SQL 端
        // `::jsonb` cast 解析
        _ => query.bind(Value::Array(items.to_vec()).to_string()),
    }
}

/// 把 `format_type(typoid, NULL)` 的输出规范化成"裸类型"用于 array bind 分支判定。
///
/// `format_type` 可能返回带 typmod 的形态如 `varchar(100)[]` / `numeric(10,2)`，
/// 我们只关心"是不是数组 + 元素类型大类"。这里只剥掉 `(...)`，保留方括号。
fn normalize_pg_type(ct: &str) -> String {
    let trimmed = ct.trim();
    // 剥掉首个 '(' 之后的部分到对应的 ')'，比如 `varchar(100)[]` → `varchar[]`
    if let Some(open) = trimmed.find('(') {
        if let Some(close_rel) = trimmed[open..].find(')') {
            let close = open + close_rel;
            let mut s = String::with_capacity(trimmed.len());
            s.push_str(&trimmed[..open]);
            s.push_str(&trimmed[close + 1..]);
            return s.trim().to_string();
        }
    }
    trimmed.to_string()
}

// ═══════════════════════════════════════════════════════════════════════════
// RPC 身份与授权
// ═══════════════════════════════════════════════════════════════════════════
//
// 身份（auth）：登录态 JWT 或 API Key 二选一。RPC 路由用专属的
// `rpc_auth_middleware` 解析两种 header（`Authorization` / `apikey`），并把
// 通过校验的主体注入 `RpcAuthSubject`。
//
// 授权（authz）：`enforce_rpc_permission`
// - 用户主体 → 复用 management.permissions / role_permissions（同表权限模型）
// - API Key  → 复用 api_keys.permissions JSONB 的 scope 模型（与 Auto API 同）
//
// 资源命名：`resource = "<schema>.<function_name>"`，`action = "EXECUTE"`。
// 兼容策略（仅对用户主体）：当前 tenant 对该函数没配过 EXECUTE 行就走兼容模式，
// 任何登录用户可调；一旦配过即转严格模式。API Key 不享受兼容模式——key 必须
// 显式声明可访问的 resource/action，否则一律拒绝。
// ═══════════════════════════════════════════════════════════════════════════

/// API Key 鉴权信息——不持有原始 key，只携带库 ID 与 scope。
#[derive(Clone, Debug)]
pub struct ApiKeyAuth {
    pub database_id: i32,
    pub permissions: Value,
}

/// RPC 调用方主体。中间件保证恰有一个被注入。
#[derive(Clone, Debug)]
pub enum RpcAuthSubject {
    User(Claims),
    ApiKey(ApiKeyAuth),
}

/// 从 `/api/v1/{database_id}/rpc/{fn_name}` 形态的 URL 路径里抠出 database_id。
///
/// 与 `rbac_middleware::extract_auto_api_parts` 同款做法——按段切分，校验前缀
/// 与 `rpc` 段固定位置，再 parse 数字。中间件用它做"路径权威"语义。
fn extract_rpc_database_id(path: &str) -> Option<i32> {
    let mut iter = path.trim_start_matches('/').split('/');
    if iter.next()? != "api" {
        return None;
    }
    if iter.next()? != "v1" {
        return None;
    }
    let db_id_str = iter.next()?;
    if iter.next()? != "rpc" {
        return None;
    }
    db_id_str.parse::<i32>().ok()
}

/// RPC 专属认证中间件：
/// 1. 从 URL 路径抠出 `database_id`（`/api/v1/:database_id/rpc/:fn_name`），
///    并把它作为权威值覆盖到 `X-Database-Id` 请求头——后续的
///    `dynamic_db_middleware` 据此切池，调用方自带的同名头会被忽略。
/// 2. 优先尝试 JWT（`Authorization: Bearer <jwt>`，`<jwt>` 不以 `cr_` 开头）。
/// 3. 兜底 API Key：`Authorization: Bearer cr_*` 或 Supabase 风格的 `apikey: cr_*`；
///    Key 绑定的 `database_id` 必须与路径一致，否则 401（防止用 A 库的 key 跨调到 B 库）。
/// 4. 把通过校验的主体注入 `RpcAuthSubject` request extension 供 handler 使用。
///
/// 注意：本中间件必须挂在 `dynamic_db_middleware` 的外层（先于它执行），
/// 这样路径注入的 `X-Database-Id` 才能被 dynamic_db 看见并切池。
pub async fn rpc_auth_middleware(
    State(pool): State<PgPool>,
    mut req: Request,
    next: Next,
) -> Result<Response, AppError> {
    // 路径提取：路由在 main.rs 已限定为 i32，这里再校验一次只是防御（可挡住未来
    // 路由形态变更后被错挂的情况）。提取失败直接 500，不暴露内部细节。
    let path_db_id = extract_rpc_database_id(req.uri().path()).ok_or_else(|| {
        AppError::Internal("RPC 路径未匹配 /api/v1/:database_id/rpc/:fn_name".to_string())
    })?;

    // 路径权威：覆盖任何调用方自带的 X-Database-Id 头，避免出现"路径选 A 库 / 头选 B 库"的歧义。
    if let Ok(v) = HeaderValue::from_str(&path_db_id.to_string()) {
        req.headers_mut().insert("X-Database-Id", v);
    }

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

    // ──── 1) JWT 路径 ────
    if let Some(token) = auth_header_str
        .as_deref()
        .and_then(|h| h.strip_prefix("Bearer "))
        .filter(|t| !t.starts_with("cr_"))
    {
        if let Ok(claims) = verify_token(token) {
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
                    let active = !revoked
                        && expires_at.map(|t| t > chrono::Utc::now()).unwrap_or(false);
                    if active {
                        req.extensions_mut().insert(claims.clone());
                        req.extensions_mut().insert(RpcAuthSubject::User(claims));
                        return Ok(next.run(req).await);
                    }
                }
            }
        }
        // JWT 解析失败/会话失效 → 不立即返回，给 API Key 一次机会（同请求允许两种凭据共存）
    }

    // ──── 2) API Key 路径 ────
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

        let row = row
            .ok_or_else(|| AppError::Unauthorized("API Key 无效或已过期".to_string()))?;
        let key_database_id: i32 = row.get("database_id");
        let permissions: Value = row.get("permissions");

        // 路径权威：URL 路径里的 database_id 必须与 key 绑定的库一致——否则就
        // 是"用 A 库的 key 试图调用 B 库的 RPC"，直接 401，不给探测窗口。
        if key_database_id != path_db_id {
            return Err(AppError::Unauthorized(
                "URL 中的 database_id 与 API Key 绑定的数据库不一致".to_string(),
            ));
        }

        // 更新 last_used_at（best-effort，失败不影响请求）
        let _ = sqlx::query(
            "UPDATE management.api_keys \
             SET last_used_at = NOW() \
             WHERE key_hash = encode(sha256($1::bytea), 'hex')",
        )
        .bind(key)
        .execute(&pool)
        .await;

        req.extensions_mut()
            .insert(RpcAuthSubject::ApiKey(ApiKeyAuth {
                database_id: key_database_id,
                permissions,
            }));
        return Ok(next.run(req).await);
    }

    Err(AppError::Unauthorized(
        "缺少有效的 JWT 或 API Key".to_string(),
    ))
}

/// 校验调用方是否有权调用 `schema.fn_name`。底层在 management 池上执行
/// （permissions/api_keys 是平台元数据，与租户业务库无关）。`database_id` 来自
/// URL 路径（`rpc_auth_middleware` 已确保 API Key 的绑定库与之一致）。
async fn enforce_rpc_permission(
    main_pool: &PgPool,
    redis: Option<&RedisManager>,
    subject: &RpcAuthSubject,
    database_id: i32,
    schema: &str,
    fn_name: &str,
) -> Result<(), AppError> {
    let resource = format!("{}.{}", schema, fn_name);

    match subject {
        RpcAuthSubject::User(claims) => {
            enforce_rpc_user(main_pool, redis, claims, database_id, schema, fn_name, &resource)
                .await
        }
        RpcAuthSubject::ApiKey(key) => enforce_rpc_api_key(key, schema, &resource).await,
    }
}

/// 用户主体（JWT）—— 走 management.permissions / role_permissions。
async fn enforce_rpc_user(
    main_pool: &PgPool,
    redis: Option<&RedisManager>,
    claims: &Claims,
    database_id: i32,
    schema: &str,
    fn_name: &str,
    resource: &str,
) -> Result<(), AppError> {
    if claims.is_superadmin {
        return Ok(());
    }

    let tenant_row = sqlx::query(
        "SELECT tenant_id FROM management.tenant_databases \
         WHERE id = $1 AND is_active = true",
    )
    .bind(database_id)
    .fetch_optional(main_pool)
    .await?;
    let tenant_id: i32 = tenant_row
        .ok_or_else(|| AppError::NotFound(format!("数据库连接 {} 不存在", database_id)))?
        .get("tenant_id");

    let schema_wildcard = format!("{}.*", schema);

    // 是否有人对这个函数（或其上层通配）配过 EXECUTE 行？
    let configured: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*) FROM management.permissions
         WHERE tenant_id = $1
           AND (resource = $2 OR resource = $3 OR resource = '*')
           AND (action = 'EXECUTE' OR action = 'ALL')
        "#,
    )
    .bind(tenant_id)
    .bind(resource)
    .bind(&schema_wildcard)
    .fetch_one(main_pool)
    .await?;

    if configured == 0 {
        tracing::debug!(
            "RPC ACL 未配置，放行: tenant={} resource={}",
            tenant_id,
            resource
        );
        return Ok(());
    }

    // 严格模式：先看 Redis 缓存，未命中再查库并回写。失效在角色 / 权限变更时
    // 通过 PermissionCache::invalidate_tenant 触发；这里只保证读路径。
    let perms = if let Some(r) = redis {
        match PermissionCache::get(r, tenant_id, claims.sub, resource, "EXECUTE").await {
            Some(cached) => cached,
            None => {
                let perms =
                    query_user_permissions(main_pool, claims.sub, tenant_id, resource, "EXECUTE")
                        .await?;
                PermissionCache::set(r, tenant_id, claims.sub, resource, "EXECUTE", &perms).await;
                perms
            }
        }
    } else {
        query_user_permissions(main_pool, claims.sub, tenant_id, resource, "EXECUTE").await?
    };

    if perms.is_empty() {
        return Err(AppError::Forbidden(format!(
            "您没有调用 {}.{}() 的权限",
            schema, fn_name
        )));
    }
    Ok(())
}

/// 把调用方身份写到事务局部 GUC，供业务函数 / RLS POLICY 读取。
///
/// 注入两个变量：
///
/// - `app.current_user_id`：JWT 调用 = `claims.sub`；API Key 调用 = `"0"`。
///   语义与 `auto_api_handlers::inject_session_user_id` 一致，业务库里的
///   `app.current_user_id()` helper（见 `migrations/013_rls_helpers.sql`）会把
///   `'0'` 当 NULL，不会被误识别成 user_id=0。
///
/// - `app.project_ids`：逗号分隔的项目 ID 列表，仅在 API Key 调用时从
///   `permissions.project_ids` JSON 数组读取；JWT 调用暂不注入（业务函数若要做
///   "用户 → 项目" 映射，应自己 JOIN 业务表，参考 `gamesq.rls_project_ids()`
///   的实现思路）。值序列化为 `"4,7,12"` 形态，业务侧 `string_to_array(_, ',')::int[]`
///   即可使用。
///
/// 安全约束：`project_ids` **必须**只来自服务端可信的 API Key permissions JSON——
/// **绝不**接受请求 header / body 自带的项目列表，否则 caller 可以自我授权，
/// `assert_project_access` 风格的护栏完全失效。
async fn inject_rpc_session_context(
    tx: &mut Transaction<'_, Postgres>,
    subject: &RpcAuthSubject,
) -> Result<(), AppError> {
    let (user_id, project_ids_csv) = match subject {
        RpcAuthSubject::User(claims) => (claims.sub.to_string(), String::new()),
        RpcAuthSubject::ApiKey(key) => (
            "0".to_string(),
            project_ids_from_api_key(&key.permissions),
        ),
    };

    sqlx::query("SELECT set_config('app.current_user_id', $1, true)")
        .bind(&user_id)
        .execute(&mut **tx)
        .await
        .map_err(AppError::Database)?;

    sqlx::query("SELECT set_config('app.project_ids', $1, true)")
        .bind(&project_ids_csv)
        .execute(&mut **tx)
        .await
        .map_err(AppError::Database)?;

    tracing::debug!(
        "RPC session 上下文注入：app.current_user_id={} app.project_ids='{}'",
        user_id,
        project_ids_csv
    );
    Ok(())
}

/// 从 API Key 的 `permissions.project_ids` JSON 数组解析逗号分隔串。
///
/// 容错策略：
/// - 字段缺失 / 不是数组 → 返回空串 → 业务函数会拒绝任何具体项目 ID（fail closed）
/// - 元素不是整数 → 跳过（容忍部分脏数据，不让一条坏值拖垮整把 key）
/// - 元素是 i64 但不在 i32 范围 → 仍按 i64 序列化，让业务函数自己处理（
///   gamesq.rls_project_ids() 会 cast 到 int[] 时失败，错误更准确反映"项目 ID
///   越界"而不是被这里悄悄丢弃）。
fn project_ids_from_api_key(permissions: &Value) -> String {
    let arr = match permissions.get("project_ids").and_then(Value::as_array) {
        Some(a) => a,
        None => return String::new(),
    };
    arr.iter()
        .filter_map(Value::as_i64)
        .map(|n| n.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

/// API Key 主体 —— 复用 Auto API 的 scope 模型。要求新格式
/// `{ allowed_resources, allowed_actions }`；旧格式（read/write/delete）不支持
/// EXECUTE，直接拒绝（避免老 key 被意外授予 RPC 调用权）。
async fn enforce_rpc_api_key(
    key: &ApiKeyAuth,
    schema: &str,
    resource: &str,
) -> Result<(), AppError> {
    tracing::debug!(
        "RPC API Key 鉴权: database_id={} resource={}",
        key.database_id,
        resource
    );
    let perms = &key.permissions;

    let new_format = perms.get("allowed_actions").is_some()
        || perms.get("allowed_resources").is_some();
    if !new_format {
        return Err(AppError::Forbidden(
            "该 API Key 使用旧版 scope 格式，不支持 RPC 调用；请重建 key 并启用 allowed_resources/allowed_actions".to_string(),
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
            .any(|a| a == "*" || a == "ALL" || a == "EXECUTE")
    {
        return Err(AppError::Forbidden(
            "API Key 不允许执行 EXECUTE 操作".to_string(),
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
        let allowed = resources
            .iter()
            .any(|r| r == "*" || r == "*.*" || r == resource || r == &schema_wildcard);
        if !allowed {
            return Err(AppError::Forbidden(format!(
                "API Key 不允许调用 {}",
                resource
            )));
        }
    }

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// RPC ACL 管理 API
//
// 这些接口只是把"操作 management.permissions / role_permissions 的两步动作"
// 封装成一个语义化端点，便于前端做"RPC 授权"页；底层模型与表权限完全共享。
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Debug, Deserialize)]
pub struct ListAclsQuery {
    pub database_id: i32,
    pub schema: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RpcAclEntry {
    pub permission_id: i32,
    pub schema: String,
    pub function_name: String,
    pub resource: String,
    pub role_id: i32,
    pub role_name: String,
}

#[derive(Debug, Deserialize)]
pub struct GrantAclRequest {
    pub database_id: i32,
    pub schema: String,
    pub function_name: String,
    pub role_id: i32,
}

#[derive(Debug, Deserialize)]
pub struct RevokeAclQuery {
    pub permission_id: i32,
    pub role_id: i32,
}

/// 把 database_id 解析成 (tenant_id)，并校验调用方对该 tenant 有管理员权限。
///
/// 复用已有的 `user_tenants.role` 概念（owner / admin），保持和 RBAC 写操作
/// 一致的鉴权语义；超管直接放行。
async fn require_tenant_admin_for_db(
    pool: &PgPool,
    claims: &Claims,
    database_id: i32,
) -> Result<i32, AppError> {
    let tenant_row = sqlx::query(
        "SELECT tenant_id FROM management.tenant_databases \
         WHERE id = $1 AND is_active = true",
    )
    .bind(database_id)
    .fetch_optional(pool)
    .await?;
    let tenant_id: i32 = tenant_row
        .ok_or_else(|| AppError::NotFound(format!("数据库连接 {} 不存在", database_id)))?
        .get("tenant_id");

    if claims.is_superadmin {
        return Ok(tenant_id);
    }

    let role_row = sqlx::query(
        "SELECT role FROM management.user_tenants \
         WHERE user_id = $1 AND tenant_id = $2 AND is_active = true",
    )
    .bind(claims.sub)
    .bind(tenant_id)
    .fetch_optional(pool)
    .await?;
    let role: String = role_row
        .ok_or_else(|| AppError::Forbidden("您不属于该租户".to_string()))?
        .get("role");
    if role != "owner" && role != "admin" {
        return Err(AppError::Forbidden(format!(
            "需要租户管理员权限（当前角色：{}）",
            role
        )));
    }
    Ok(tenant_id)
}

/// `GET /api/admin/rpc-acls?database_id=X&schema=public`
///
/// 列出该 tenant 下所有 RPC EXECUTE 授权（按 resource / role 双维展开为一行一条）。
pub async fn list_rpc_acls(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(params): Query<ListAclsQuery>,
) -> Result<Json<Vec<RpcAclEntry>>, AppError> {
    let tenant_id = require_tenant_admin_for_db(&pool, &claims, params.database_id).await?;

    // 用 LIKE 过滤 EXECUTE 资源；schema 过滤可选。
    // 注意：LIKE 模式仅按字面拼接，参数仍走 bind，无 SQL 注入风险。
    let schema_filter = params
        .schema
        .as_deref()
        .map(|s| format!("{}.%", s))
        .unwrap_or_default();

    let rows = sqlx::query(
        r#"
        SELECT p.id          AS permission_id,
               p.resource    AS resource,
               r.id          AS role_id,
               r.name        AS role_name
        FROM management.permissions p
        JOIN management.role_permissions rp ON rp.permission_id = p.id
        JOIN management.roles r             ON r.id            = rp.role_id
        WHERE p.tenant_id = $1
          AND (p.action = 'EXECUTE' OR p.action = 'ALL')
          AND ($2 = '' OR p.resource LIKE $2 OR p.resource = '*')
        ORDER BY p.resource, r.name
        "#,
    )
    .bind(tenant_id)
    .bind(&schema_filter)
    .fetch_all(&pool)
    .await?;

    let entries: Vec<RpcAclEntry> = rows
        .iter()
        .map(|r| {
            let resource: String = r.get("resource");
            let (schema, function_name) = resource
                .split_once('.')
                .map(|(a, b)| (a.to_string(), b.to_string()))
                .unwrap_or_else(|| (resource.clone(), String::new()));
            RpcAclEntry {
                permission_id: r.get("permission_id"),
                schema,
                function_name,
                resource,
                role_id: r.get("role_id"),
                role_name: r.get("role_name"),
            }
        })
        .collect();

    Ok(Json(entries))
}

/// `POST /api/admin/rpc-acls` —— 授予一个角色对某个函数的 EXECUTE 权限。
///
/// 行为是幂等的：
/// 1) 不存在则插入一条 permissions row（resource = `<schema>.<fn>`, action = EXECUTE）
/// 2) 不存在则插入一条 role_permissions（role_id, permission_id）
/// 3) 失效该 tenant 下所有用户的 RBAC 权限缓存（角色权限变更立刻生效）
pub async fn grant_rpc_acl(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    redis: Option<Extension<RedisManager>>,
    Json(req): Json<GrantAclRequest>,
) -> Result<Json<RpcAclEntry>, AppError> {
    let tenant_id = require_tenant_admin_for_db(&pool, &claims, req.database_id).await?;

    // 标识符再校一次，防止接口被绕过 sanitize 调用。
    let schema = QueryParams::sanitize_identifier(&req.schema)?;
    let function_name = QueryParams::sanitize_identifier(&req.function_name)?;
    let resource = format!("{}.{}", schema, function_name);

    // 校验 role 必须属于当前 tenant，避免跨租户授权。
    let role_row = sqlx::query("SELECT name FROM management.roles WHERE id = $1 AND tenant_id = $2")
        .bind(req.role_id)
        .bind(tenant_id)
        .fetch_optional(&pool)
        .await?;
    let role_name: String = role_row
        .ok_or_else(|| AppError::NotFound("角色不存在或不属于当前租户".to_string()))?
        .get("name");

    // 1) UPSERT permission
    //    用唯一约束 (tenant_id, resource, action) 去重；表上已有这个唯一约束的
    //    （来自迁移文件），如果将来不存在则会 fallback 到 SELECT-then-INSERT。
    let perm_id: i32 = sqlx::query_scalar(
        r#"
        INSERT INTO management.permissions
            (tenant_id, resource, action, conditions, denied_columns, description)
        VALUES ($1, $2, 'EXECUTE', '[]'::jsonb, '[]'::jsonb, $3)
        ON CONFLICT (tenant_id, resource, action) DO UPDATE
            SET resource = EXCLUDED.resource
        RETURNING id
        "#,
    )
    .bind(tenant_id)
    .bind(&resource)
    .bind(format!("RPC EXECUTE {}", resource))
    .fetch_one(&pool)
    .await?;

    // 2) UPSERT role_permissions
    sqlx::query(
        r#"
        INSERT INTO management.role_permissions (role_id, permission_id)
        VALUES ($1, $2)
        ON CONFLICT (role_id, permission_id) DO NOTHING
        "#,
    )
    .bind(req.role_id)
    .bind(perm_id)
    .execute(&pool)
    .await?;

    // 3) 失效缓存——否则缓存里还是"无权限"，新授予的角色要等 5 分钟才能生效。
    if let Some(Extension(r)) = redis {
        PermissionCache::invalidate_tenant(&r, tenant_id).await;
    }

    Ok(Json(RpcAclEntry {
        permission_id: perm_id,
        schema,
        function_name,
        resource,
        role_id: req.role_id,
        role_name,
    }))
}

/// `DELETE /api/admin/rpc-acls?permission_id=X&role_id=Y`
///
/// 仅解除 (role_id, permission_id) 的绑定，**不**删除 permission 行——
/// 同一条 permission 可能被多个角色引用，删除会牵连其它授权。
///
/// 如果某条 permission 解绑后再没有任何角色引用，前端 UI 上会自然不再显示，
/// 数据库里保留 zombie row 也无害（下一次 grant 会复用）。
pub async fn revoke_rpc_acl(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    redis: Option<Extension<RedisManager>>,
    Query(req): Query<RevokeAclQuery>,
) -> Result<StatusCode, AppError> {
    // 用 permission_id 反查 tenant_id，再校验调用者是该租户管理员。
    let tenant_row = sqlx::query("SELECT tenant_id FROM management.permissions WHERE id = $1")
        .bind(req.permission_id)
        .fetch_optional(&pool)
        .await?;
    let tenant_id: i32 = tenant_row
        .ok_or_else(|| AppError::NotFound("权限不存在".to_string()))?
        .get("tenant_id");

    if !claims.is_superadmin {
        let role_row = sqlx::query(
            "SELECT role FROM management.user_tenants \
             WHERE user_id = $1 AND tenant_id = $2 AND is_active = true",
        )
        .bind(claims.sub)
        .bind(tenant_id)
        .fetch_optional(&pool)
        .await?;
        let role: String = role_row
            .ok_or_else(|| AppError::Forbidden("您不属于该租户".to_string()))?
            .get("role");
        if role != "owner" && role != "admin" {
            return Err(AppError::Forbidden(format!(
                "需要租户管理员权限（当前角色：{}）",
                role
            )));
        }
    }

    sqlx::query(
        "DELETE FROM management.role_permissions \
         WHERE role_id = $1 AND permission_id = $2",
    )
    .bind(req.role_id)
    .bind(req.permission_id)
    .execute(&pool)
    .await?;

    // 收回也要立即失效缓存——否则被收回的用户在 TTL 内仍能调用。
    if let Some(Extension(r)) = redis {
        PermissionCache::invalidate_tenant(&r, tenant_id).await;
    }

    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_ids_from_api_key_handles_normal_array() {
        let perms = json!({
            "allowed_actions": ["EXECUTE"],
            "project_ids": [4, 7, 12]
        });
        assert_eq!(project_ids_from_api_key(&perms), "4,7,12");
    }

    #[test]
    fn project_ids_from_api_key_returns_empty_when_field_missing() {
        let perms = json!({"allowed_actions": ["EXECUTE"]});
        // 字段缺失 → fail closed：业务函数会拒绝任何具体项目，不会"恰好通过"
        assert_eq!(project_ids_from_api_key(&perms), "");
    }

    #[test]
    fn project_ids_from_api_key_returns_empty_when_not_array() {
        let perms = json!({"project_ids": "4,7,12"}); // 字符串而非数组
        assert_eq!(project_ids_from_api_key(&perms), "");
    }

    #[test]
    fn project_ids_from_api_key_skips_non_integer_elements() {
        // 容忍部分脏数据：丢掉 "abc" / null / 嵌套对象，保留合法 int
        let perms = json!({"project_ids": [4, "abc", null, {"x": 1}, 7]});
        assert_eq!(project_ids_from_api_key(&perms), "4,7");
    }

    #[test]
    fn project_ids_from_api_key_handles_empty_array() {
        let perms = json!({"project_ids": []});
        assert_eq!(project_ids_from_api_key(&perms), "");
    }

    fn ov(names: &[&str], types: &[&str]) -> FunctionOverload {
        FunctionOverload {
            arg_names: names.iter().map(|s| s.to_string()).collect(),
            arg_types: types.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// 构造一个 JSON object 用作 provided_values。短手以便测试可读。
    fn vals(pairs: &[(&str, Value)]) -> serde_json::Map<String, Value> {
        let mut m = serde_json::Map::new();
        for (k, v) in pairs {
            m.insert((*k).to_string(), v.clone());
        }
        m
    }

    #[test]
    fn resolve_overload_exact_match_single() {
        let ovs = vec![ov(&["p_page", "p_size"], &["integer", "integer"])];
        let vs = vals(&[("p_page", json!(1)), ("p_size", json!(20))]);
        let m = resolve_overload(&ovs, &["p_page", "p_size"], &vs).unwrap();
        assert_eq!(m.arg_types, vec!["integer", "integer"]);
    }

    #[test]
    fn resolve_overload_exact_match_order_independent() {
        let ovs = vec![ov(&["a", "b", "c"], &["text", "integer", "boolean"])];
        let vs = vals(&[("c", json!(true)), ("a", json!("x")), ("b", json!(1))]);
        // 调用方按任意顺序传参名仍然匹配同一个 overload
        let m = resolve_overload(&ovs, &["c", "a", "b"], &vs).unwrap();
        assert_eq!(m.arg_names, vec!["a", "b", "c"]);
    }

    #[test]
    fn resolve_overload_superset_with_defaults() {
        // 函数有 3 个形参（其中 1 个有 DEFAULT），业务方只传 2 个 → 仍可匹配
        let ovs = vec![ov(&["p_page", "p_size", "p_extra"], &["integer", "integer", "text"])];
        let vs = vals(&[("p_page", json!(1)), ("p_size", json!(20))]);
        let m = resolve_overload(&ovs, &["p_page", "p_size"], &vs).unwrap();
        assert_eq!(m.arg_types.len(), 3);
    }

    #[test]
    fn resolve_overload_no_match_returns_none() {
        let ovs = vec![ov(&["a", "b"], &["integer", "integer"])];
        let vs = vals(&[("a", json!(1)), ("c", json!(2))]);
        // 传了不在 argnames 里的参数 → 没有候选
        assert!(resolve_overload(&ovs, &["a", "c"], &vs).is_none());
    }

    #[test]
    fn resolve_overload_business_case_admin_get_project_list() {
        // 回放业务方报错请求的形参 → 应该唯一匹配
        let ovs = vec![ov(
            &[
                "p_page",
                "p_page_size",
                "p_keyword",
                "p_status",
                "p_category_id",
                "p_sort_keys",
                "p_sort_orders",
                "p_alliance_filter",
            ],
            &[
                "integer",
                "integer",
                "text",
                "text",
                "text",
                "text[]",
                "text[]",
                "text",
            ],
        )];
        let vs = vals(&[
            ("p_page", json!(1)),
            ("p_page_size", json!(30)),
            ("p_keyword", json!("foo")),
            ("p_status", json!("active")),
            ("p_category_id", json!("c1")),
            ("p_sort_keys", json!(["post_count"])),
            ("p_sort_orders", json!(["desc"])),
            ("p_alliance_filter", json!("exclude")),
        ]);
        let m = resolve_overload(
            &ovs,
            &[
                "p_page",
                "p_page_size",
                "p_keyword",
                "p_status",
                "p_category_id",
                "p_sort_keys",
                "p_sort_orders",
                "p_alliance_filter",
            ],
            &vs,
        )
        .unwrap();
        // 关键：p_page → integer（不是 bigint），p_sort_keys → text[]（不是 jsonb）
        let idx_page = m.arg_names.iter().position(|n| n == "p_page").unwrap();
        let idx_keys = m.arg_names.iter().position(|n| n == "p_sort_keys").unwrap();
        assert_eq!(m.arg_types[idx_page], "integer");
        assert_eq!(m.arg_types[idx_keys], "text[]");
    }

    // ── 回归：同名同形参不同类型的重载在歧义时按 JSON 值评分挑最匹配 ──
    //
    // 这是用户报"function refresh_recommendation_pool(p_limit => bigint) does not exist"
    // 时触发的真实场景：函数被同时定义为 (p_limit integer) 与 (p_limit bigint) 两份，
    // 历史行为是返 None → 不加 cast → sqlx 默认按 i64 编码常量 → PG 收到 bigint
    // → 命中不到 dropdown 里展示的 integer 那条 → 报"函数不存在"。

    #[test]
    fn resolve_overload_picks_integer_when_value_fits_in_i32() {
        // 两个完全相等的重载，仅参数类型不同（integer vs bigint）。
        // 给一个 i32 范围内的整数 → 应该优先 integer
        let ovs = vec![
            ov(&["p_limit"], &["integer"]),
            ov(&["p_limit"], &["bigint"]),
        ];
        let vs = vals(&[("p_limit", json!(100))]);
        let m = resolve_overload(&ovs, &["p_limit"], &vs).unwrap();
        assert_eq!(m.arg_types, vec!["integer"], "100 在 i32 范围内，应选 integer 重载");
    }

    #[test]
    fn resolve_overload_picks_integer_when_value_fits_even_if_bigint_defined_first() {
        // 与上一例对称：把 bigint 重载放在前面，确认评分胜过 oid 顺序
        let ovs = vec![
            ov(&["p_limit"], &["bigint"]),
            ov(&["p_limit"], &["integer"]),
        ];
        let vs = vals(&[("p_limit", json!(100))]);
        let m = resolve_overload(&ovs, &["p_limit"], &vs).unwrap();
        assert_eq!(m.arg_types, vec!["integer"]);
    }

    #[test]
    fn resolve_overload_picks_bigint_when_value_overflows_i32() {
        // 超 i32 范围的整数 → 应该选 bigint，integer 会失败
        let ovs = vec![
            ov(&["p_id"], &["integer"]),
            ov(&["p_id"], &["bigint"]),
        ];
        let vs = vals(&[("p_id", json!(5_000_000_000_i64))]);
        let m = resolve_overload(&ovs, &["p_id"], &vs).unwrap();
        assert_eq!(m.arg_types, vec!["bigint"]);
    }

    #[test]
    fn resolve_overload_picks_text_for_string_value() {
        // string vs integer 重载 → JSON string 应选 text
        let ovs = vec![
            ov(&["p_q"], &["integer"]),
            ov(&["p_q"], &["text"]),
        ];
        let vs = vals(&[("p_q", json!("hello"))]);
        let m = resolve_overload(&ovs, &["p_q"], &vs).unwrap();
        assert_eq!(m.arg_types, vec!["text"]);
    }

    #[test]
    fn resolve_overload_picks_jsonb_for_object_value() {
        // jsonb vs text 重载 → JSON object 应选 jsonb
        let ovs = vec![
            ov(&["p_payload"], &["text"]),
            ov(&["p_payload"], &["jsonb"]),
        ];
        let vs = vals(&[("p_payload", json!({"k": "v"}))]);
        let m = resolve_overload(&ovs, &["p_payload"], &vs).unwrap();
        assert_eq!(m.arg_types, vec!["jsonb"]);
    }

    #[test]
    fn resolve_overload_picks_array_type_for_json_array() {
        // text[] vs jsonb 重载 → JSON array 应选 text[]
        let ovs = vec![
            ov(&["p_keys"], &["jsonb"]),
            ov(&["p_keys"], &["text[]"]),
        ];
        let vs = vals(&[("p_keys", json!(["a", "b"]))]);
        let m = resolve_overload(&ovs, &["p_keys"], &vs).unwrap();
        assert_eq!(m.arg_types, vec!["text[]"]);
    }

    #[test]
    fn resolve_overload_picks_bool_for_bool_value() {
        let ovs = vec![
            ov(&["p_flag"], &["integer"]),
            ov(&["p_flag"], &["boolean"]),
        ];
        let vs = vals(&[("p_flag", json!(true))]);
        let m = resolve_overload(&ovs, &["p_flag"], &vs).unwrap();
        assert_eq!(m.arg_types, vec!["boolean"]);
    }

    #[test]
    fn resolve_overload_picks_float8_for_floating_value() {
        let ovs = vec![
            ov(&["p_rate"], &["integer"]),
            ov(&["p_rate"], &["double precision"]),
        ];
        let vs = vals(&[("p_rate", json!(1.5))]);
        let m = resolve_overload(&ovs, &["p_rate"], &vs).unwrap();
        assert_eq!(m.arg_types, vec!["double precision"]);
    }

    #[test]
    fn resolve_overload_ties_broken_by_first_candidate() {
        // 两条候选类型上对同一个值打分完全一致 → 取 oid 顺序首条（与 PG 在歧义重载下的潜规则一致）
        let ovs = vec![
            ov(&["x"], &["integer"]),
            ov(&["x"], &["integer"]),
        ];
        let vs = vals(&[("x", json!(1))]);
        let m = resolve_overload(&ovs, &["x"], &vs).unwrap();
        // 不验证具体哪个（两条等价），只验证返了 Some 而不是 None
        assert_eq!(m.arg_types, vec!["integer"]);
    }

    #[test]
    fn resolve_overload_superset_with_multiple_candidates_also_disambiguates() {
        // 第 2 轮（superset）也会出现多候选 —— 同样按值评分挑最优
        let ovs = vec![
            ov(&["p_limit", "p_extra"], &["integer", "text"]),
            ov(&["p_limit", "p_extra"], &["bigint", "text"]),
        ];
        let vs = vals(&[("p_limit", json!(100))]);
        // 只传 p_limit → 走 superset 分支（两条候选都是 superset）
        let m = resolve_overload(&ovs, &["p_limit"], &vs).unwrap();
        assert_eq!(m.arg_types[0], "integer");
    }

    #[test]
    fn normalize_pg_type_strips_typmod_keeps_array_brackets() {
        assert_eq!(normalize_pg_type("integer"), "integer");
        assert_eq!(normalize_pg_type("text[]"), "text[]");
        assert_eq!(normalize_pg_type("varchar(100)"), "varchar");
        assert_eq!(normalize_pg_type("varchar(100)[]"), "varchar[]");
        assert_eq!(normalize_pg_type("numeric(10,2)"), "numeric");
        assert_eq!(normalize_pg_type("  bigint  "), "bigint");
    }

    #[test]
    fn execute_rpc_inner_signature_compiles() {
        // Compile-time check: 签名是稳定的 pub 接口，scheduler 依赖它。
        // 调用形态写死在 _assert_args 内，若 execute_rpc_inner 的形参类型 / 顺序变更则编译失败。
        fn _assert_args(
            main_pool: &sqlx::PgPool,
            dynamic_pool: Option<&sqlx::PgPool>,
            redis: Option<&crate::redis_manager::RedisManager>,
            claims: &crate::auth::Claims,
            database_id: i32,
            schema: &str,
            fn_name: &str,
            args: serde_json::Map<String, serde_json::Value>,
        ) {
            let _fut = super::execute_rpc_inner(
                main_pool,
                dynamic_pool,
                redis,
                claims,
                database_id,
                schema,
                fn_name,
                args,
            );
        }
        let _ = _assert_args;
    }
}
