//! ES「应用」API：把 Elasticsearch 包装成业务侧无需写 DSL / 不需要 ES SDK 的 HTTP 接口。
//!
//! 路由前缀 `/api/es-app/` 或 `/api/v1/:database_slug/es-app/`；与 `/api/es/*` /
//! `/api/v1/:database_slug/es/*` 透传层共用同一套 `cres_es_xxx` token 鉴权。
//! `Authorization: ApiKey cres_es_xxx` token，所以一份 token 同时可用于两种模式。
//!
//! ## 提供的高层操作
//!
//! ```text
//! POST   /api/es-app/{index}/docs          创建文档（body._id 可选，缺省 ES 自动生成）
//! GET    /api/es-app/{index}/docs/{id}     按 id 获取
//! PUT    /api/es-app/{index}/docs/{id}     按 id upsert（整文档替换 + 不存在则创建）
//! PATCH  /api/es-app/{index}/docs/{id}     按 id 部分更新（{doc:{...}} 或裸字段）
//! DELETE /api/es-app/{index}/docs/{id}     按 id 删除
//! POST   /api/es-app/{index}/search        扁平查询 + 受限 terms/composite 聚合
//! POST   /api/es-app/{index}/count         同上但只算 total，无文档
//! POST   /api/es-app/{index}/bulk          批量 index/create/update/delete
//! POST   /api/es-app/{index}/_init         按字段类型字典创建 index + mapping
//! DELETE /api/es-app/{index}               删除 index
//! GET    /api/es-app/{index}               读 mapping + settings
//! GET    /api/es-app/_indices              列出 token allowlist 命中的所有 index
//! ```
//!
//! ## 鉴权
//!
//! 复用 [`proxy_common::resolve_token`] + [`proxy_common::enforce_app_access`]：
//! method 必须在 token `allowed_methods`，index 必须命中 `index_allowlist`，
//! 且高层 API 显式拒绝逗号 / 通配 / `_` 前缀的 index（避免无意越权）。
//!
//! 不跑 path_denylist：上游 path 由代理自己构造，不存在 path 注入面。
//!
//! ## search 的 DSL 翻译
//!
//! [`build_search_query`] 把扁平的 `where` map 翻译成 ES bool 查询。规则：
//!
//! | 输入                                | ES 子句                           | bool 桶  |
//! |-------------------------------------|-----------------------------------|----------|
//! | `{f: v}`                            | `term: {f: v}`                    | filter   |
//! | `{f: {eq: v}}`                      | `term: {f: v}`                    | filter   |
//! | `{f: {ne: v}}`                      | `term: {f: v}`                    | must_not |
//! | `{f: {gt|gte|lt|lte: v}}`           | `range: {f: {op: v}}`             | filter   |
//! | `{f: {in: [...]}}`                  | `terms: {f: [...]}`               | filter   |
//! | `{f: {contains: "..."}}`            | `match: {f: "..."}`               | filter   |
//! | `{f: {prefix: "..."}}`              | `prefix: {f: "..."}`              | filter   |
//! | `{f: {prefix: {value, ...}}}`        | `prefix: {f: {value, ...}}`        | filter   |
//! | `{f: {wildcard: "..."}}`            | `wildcard: {f: "..."}`            | filter   |
//! | `{f: {wildcard: {value, ...}}}`      | `wildcard: {f: {value, ...}}`      | filter   |
//! | `{f: {exists: true}}`               | `exists: {field: f}`              | filter   |
//! | `{f: {exists: false}}`              | `exists: {field: f}`              | must_not |
//! | `q` + 可选 `q_fields`                | `query_string` / `multi_match`     | must     |
//!
//! 多个 range op 合并到同字段（`gte` + `lte` → `range: {f: {gte, lte}}`）。
//!
//! `nested_paths` 声明的前缀（如 `title`/`content`）会让命中该前缀的 `q_fields`
//! 包进 `nested` 查询 + `inner_hits` 高亮；其余字段照常走 multi_match，多个子句用
//! `bool.should + minimum_should_match:1` 组合。nested 命中的高亮片段会被汇总到
//! 结果每条记录的 `_highlights` 字段。每条 multi_match 用 `type=bool_prefix` +
//! `operator=and`——适配「边输入边搜」：前面的词精确 AND 命中、最后一个词当前缀，
//! 避免 OR 默认语义下整句搜索命中半个库。
//!
//! 聚合仅开放无脚本的 `terms` / `composite` 子集（每次最多 20 项、总 bucket size 最多 10000）。
//! 故意**不**暴露：脚本查询、其它 agg、suggest、template、KNN —— 这些场景应直接走透传层。

use axum::{
    extract::{Extension, Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use reqwest::Method as ReqMethod;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sqlx::PgPool;

use crate::error::AppError;
use crate::es::admin_handlers::build_auth_header;
use crate::es::auth as es_auth;
use crate::es::proxy_common::{
    build_upstream_url, enforce_app_access, pick_client, resolve_token_for_request,
    spawn_usage_update, EsTenantScope, ResolvedToken,
};

// ── 路径参数 ────────────────────────────────────────────────────────────
//
// 同一套 router 同时挂在 `/api/es-app/...` 与 `/api/v1/:database_slug/es-app/...`。
// 后者比前者多一个 `database_slug` 路径参数，若用 `Path<String>` /
// `Path<(String, String)>` 这类按个数匹配的 extractor，会在带 slug 的路由上
// 报 "Wrong number of path arguments"。改用具名结构体按 key 解析：多余的
// `database_slug` 会被 serde 忽略，两种挂载方式都能正确取出 index / id。

#[derive(Debug, Deserialize)]
pub struct IndexPath {
    index: String,
}

#[derive(Debug, Deserialize)]
pub struct DocPath {
    index: String,
    id: String,
}

// ── 通用 helper：往上游发请求 + 解 JSON ─────────────────────────────────

/// 把 `Value` body 发到 upstream ES，统一处理 timeout / 网络错误 / JSON 解析。
///
/// 返回 (upstream HTTP status, upstream JSON body)。
/// 5xx 会被翻成 `AppError::ServiceUnavailable`；其它状态码原样回（含 4xx，
/// 让调用方决定 propagate 还是改写）。
async fn upstream_json(
    token: &ResolvedToken,
    method: ReqMethod,
    es_path: &str,
    query: Option<&str>,
    body: Option<&Value>,
) -> Result<(StatusCode, Value), AppError> {
    let body_bytes = body
        .map(|v| serde_json::to_vec(v))
        .transpose()
        .map_err(|e| AppError::Internal(format!("序列化上游 ES 请求 body 失败: {e}")))?
        .unwrap_or_default();
    upstream_raw(
        token,
        method,
        es_path,
        query,
        "application/json",
        body_bytes,
    )
    .await
}

/// 同上但 body 是已构造好的字节 + content-type，给 NDJSON（`_bulk`）用。
async fn upstream_raw(
    token: &ResolvedToken,
    method: ReqMethod,
    es_path: &str,
    query: Option<&str>,
    content_type: &str,
    body: Vec<u8>,
) -> Result<(StatusCode, Value), AppError> {
    let auth_header = build_auth_header(&token.connection)?;
    let client = pick_client(token.connection.verify_tls);
    let upstream_url = build_upstream_url(&token.connection.base_url, es_path, query);

    let mut req = client
        .request(method.clone(), &upstream_url)
        .header("content-type", content_type)
        .header("accept", "application/json")
        .body(body);
    if let Some(h) = auth_header {
        req = req.header("authorization", h);
    }

    let resp = match tokio::time::timeout(
        std::time::Duration::from_secs(token.timeout_secs),
        req.send(),
    )
    .await
    {
        Err(_) => {
            return Err(AppError::ServiceUnavailable(format!(
                "上游 ES 请求超时（{}s）",
                token.timeout_secs
            )));
        }
        Ok(Err(e)) => {
            tracing::warn!(
                connection_id = token.connection.id,
                token_id = token.token_id,
                upstream_url,
                "ES 上游请求失败: {}",
                e
            );
            return Err(AppError::ServiceUnavailable(format!(
                "无法访问上游 ES: {}",
                e
            )));
        }
        Ok(Ok(r)) => r,
    };

    let upstream_status = resp.status();
    let status_axum =
        StatusCode::from_u16(upstream_status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::ServiceUnavailable(format!("读取上游 ES 响应失败: {}", e)))?;

    // ES 在 5xx 时偶尔返回 text/html（reverse-proxy 错误页），别假设永远是 JSON
    let parsed: Value = if bytes.is_empty() {
        Value::Null
    } else {
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) => v,
            Err(_) if !upstream_status.is_success() => {
                // 非 2xx 且非 JSON：透出片段帮排查，剩下细节进 server log
                let snippet: String = String::from_utf8_lossy(&bytes).chars().take(200).collect();
                return Err(AppError::ServiceUnavailable(format!(
                    "上游 ES 返回非 JSON 错误（HTTP {}）：{}",
                    upstream_status, snippet
                )));
            }
            Err(e) => {
                return Err(AppError::Internal(format!(
                    "上游 ES 响应不是合法 JSON: {}",
                    e
                )));
            }
        }
    };

    // 5xx 一律视为上游故障；4xx 透传给调用方（带 ES 的 error 解释）
    if upstream_status.is_server_error() {
        let msg = es_error_message(&parsed)
            .unwrap_or_else(|| format!("上游 ES 故障 HTTP {}", upstream_status));
        return Err(AppError::ServiceUnavailable(msg));
    }

    Ok((status_axum, parsed))
}

/// 从 ES 的 error JSON 抽 reason 串。
/// 形如 `{"error": {"reason": "..."}}` 或 `{"error": "..."}`。
fn es_error_message(body: &Value) -> Option<String> {
    let err = body.get("error")?;
    if let Some(s) = err.as_str() {
        return Some(s.to_string());
    }
    err.get("reason")
        .and_then(|r| r.as_str())
        .map(|s| s.to_string())
}

/// 构造透传 upstream status 的 axum Response（JSON body）。
fn json_response(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

// ── 文档 CRUD ──────────────────────────────────────────────────────────

/// POST /api/es-app/:index/docs
/// body：文档本体，可选含 `_id` 字段（命中 PUT /:index/_doc/:id；否则 POST /:index/_doc 自动 id）。
pub async fn create_doc(
    State(pool): State<PgPool>,
    headers: axum::http::HeaderMap,
    scope: Option<Extension<EsTenantScope>>,
    Path(IndexPath { index }): Path<IndexPath>,
    Json(mut body): Json<Value>,
) -> Result<Response, AppError> {
    let token = resolve_token_for_request(&pool, &headers, scope).await?;
    enforce_app_access(&token, "POST", &index)?;

    // 把可选的 `_id` 从 body 抠出来（ES `_doc` endpoint 不接受 body 里有 _id）
    let explicit_id = body
        .as_object_mut()
        .and_then(|m| m.remove("_id"))
        .and_then(|v| match v {
            Value::String(s) => Some(s),
            Value::Number(n) => Some(n.to_string()),
            _ => None,
        });

    let (path, method) = match &explicit_id {
        Some(id) => (
            format!("/{}/_doc/{}", index, url_encode_id(id)),
            ReqMethod::PUT,
        ),
        None => (format!("/{}/_doc", index), ReqMethod::POST),
    };

    let (status, upstream) = upstream_json(&token, method, &path, None, Some(&body)).await?;
    spawn_usage_update(pool.clone(), token.token_id);

    let result = json!({
        "_id": upstream.get("_id").cloned().unwrap_or(Value::Null),
        "result": upstream.get("result").cloned().unwrap_or(Value::Null),
        "version": upstream.get("_version").cloned().unwrap_or(Value::Null),
    });
    Ok(json_response(status, result))
}

/// GET /api/es-app/:index/docs/:id
pub async fn get_doc(
    State(pool): State<PgPool>,
    headers: axum::http::HeaderMap,
    scope: Option<Extension<EsTenantScope>>,
    Path(DocPath { index, id }): Path<DocPath>,
) -> Result<Response, AppError> {
    let token = resolve_token_for_request(&pool, &headers, scope).await?;
    enforce_app_access(&token, "GET", &index)?;

    let path = format!("/{}/_doc/{}", index, url_encode_id(&id));
    let (status, upstream) = upstream_json(&token, ReqMethod::GET, &path, None, None).await?;
    spawn_usage_update(pool.clone(), token.token_id);

    // 404：ES 返回 `{found: false}`。我们也回 404 + `{found: false, _id}`，简洁直观。
    if status == StatusCode::NOT_FOUND {
        return Ok(json_response(
            StatusCode::NOT_FOUND,
            json!({ "found": false, "_id": id }),
        ));
    }

    // 200：把 _source 提到顶层，再带 _id / _version
    let mut data = upstream
        .get("_source")
        .and_then(|s| s.as_object())
        .cloned()
        .unwrap_or_default();
    if let Some(v) = upstream.get("_id") {
        data.insert("_id".to_string(), v.clone());
    }
    if let Some(v) = upstream.get("_version") {
        data.insert("_version".to_string(), v.clone());
    }
    Ok(json_response(status, Value::Object(data)))
}

/// PUT /api/es-app/:index/docs/:id —— 整文档替换（不存在则创建）
pub async fn upsert_doc(
    State(pool): State<PgPool>,
    headers: axum::http::HeaderMap,
    scope: Option<Extension<EsTenantScope>>,
    Path(DocPath { index, id }): Path<DocPath>,
    Json(body): Json<Value>,
) -> Result<Response, AppError> {
    let token = resolve_token_for_request(&pool, &headers, scope).await?;
    enforce_app_access(&token, "PUT", &index)?;

    let path = format!("/{}/_doc/{}", index, url_encode_id(&id));
    let (status, upstream) =
        upstream_json(&token, ReqMethod::PUT, &path, None, Some(&body)).await?;
    spawn_usage_update(pool.clone(), token.token_id);

    let result = json!({
        "_id": upstream.get("_id").cloned().unwrap_or(Value::Null),
        "result": upstream.get("result").cloned().unwrap_or(Value::Null),
        "version": upstream.get("_version").cloned().unwrap_or(Value::Null),
    });
    Ok(json_response(status, result))
}

/// PATCH /api/es-app/:index/docs/:id —— 部分更新
///
/// body 接受两种形态：
///   - `{doc: {...}, doc_as_upsert?: bool}`（ES 原生 `_update` 协议子集）
///   - 直接 `{field1: v, field2: v}`（裸字段，自动包成 `{doc: {...}}`）
///
/// 默认 `doc_as_upsert: false`（找不到 id 就 404）；若 `true` 则不存在时按 doc 创建。
pub async fn patch_doc(
    State(pool): State<PgPool>,
    headers: axum::http::HeaderMap,
    scope: Option<Extension<EsTenantScope>>,
    Path(DocPath { index, id }): Path<DocPath>,
    Json(body): Json<Value>,
) -> Result<Response, AppError> {
    let token = resolve_token_for_request(&pool, &headers, scope).await?;
    enforce_app_access(&token, "PATCH", &index)?;

    // 是否已经是 `{doc: ...}` 形态？以 `doc` 键存在为判据
    let upstream_body = if body.get("doc").is_some() {
        body
    } else {
        json!({ "doc": body })
    };

    let path = format!("/{}/_update/{}", index, url_encode_id(&id));
    // ES `_update` 用 POST，不是 PATCH
    let (status, upstream) =
        upstream_json(&token, ReqMethod::POST, &path, None, Some(&upstream_body)).await?;
    spawn_usage_update(pool.clone(), token.token_id);

    let result = json!({
        "_id": upstream.get("_id").cloned().unwrap_or(Value::Null),
        "result": upstream.get("result").cloned().unwrap_or(Value::Null),
        "version": upstream.get("_version").cloned().unwrap_or(Value::Null),
    });
    Ok(json_response(status, result))
}

/// DELETE /api/es-app/:index/docs/:id
pub async fn delete_doc(
    State(pool): State<PgPool>,
    headers: axum::http::HeaderMap,
    scope: Option<Extension<EsTenantScope>>,
    Path(DocPath { index, id }): Path<DocPath>,
) -> Result<Response, AppError> {
    let token = resolve_token_for_request(&pool, &headers, scope).await?;
    enforce_app_access(&token, "DELETE", &index)?;

    let path = format!("/{}/_doc/{}", index, url_encode_id(&id));
    let (status, upstream) = upstream_json(&token, ReqMethod::DELETE, &path, None, None).await?;
    spawn_usage_update(pool.clone(), token.token_id);

    // 404 也直接透传 + `{found: false}`，与 get_doc 对齐
    if status == StatusCode::NOT_FOUND {
        return Ok(json_response(
            StatusCode::NOT_FOUND,
            json!({ "found": false, "_id": id }),
        ));
    }
    let result = json!({
        "_id": upstream.get("_id").cloned().unwrap_or(Value::Null),
        "result": upstream.get("result").cloned().unwrap_or(Value::Null),
        "version": upstream.get("_version").cloned().unwrap_or(Value::Null),
    });
    Ok(json_response(status, result))
}

// ── 查询 ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct SearchRequest {
    #[serde(default, rename = "where")]
    pub where_: Option<Map<String, Value>>,
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub q_fields: Option<Vec<String>>,
    /// 声明哪些 `q_fields` 前缀是 ES nested 字段（如 `["title", "content"]`）。
    /// 命中的字段会被包进 `nested` 查询 + `inner_hits` 高亮；其余走普通 multi_match。
    #[serde(default)]
    pub nested_paths: Option<Vec<String>>,
    #[serde(default)]
    pub sort: Option<Vec<SortClause>>,
    #[serde(default)]
    pub page: Option<u32>,
    #[serde(default)]
    pub size: Option<u32>,
    #[serde(default)]
    pub select: Option<Vec<String>>,
    /// 受限聚合：仅支持顶层 `terms`，选项只开放 `field` / `size`。
    #[serde(default)]
    pub aggs: Option<Map<String, Value>>,
    /// 透传给 ES 的 `track_total_hits`（默认 true，确保 total 不被 10000 截断）
    #[serde(default)]
    pub track_total: Option<Value>,
    /// 精确命中加权字段，格式同 q_fields，支持 `^boost`（如 `"title^10"`）。
    /// 当 `q` 非空时，额外生成 `match_phrase` + `.keyword term` 两条 should 子句，
    /// 让精确短语 / 完全匹配的文档排名优先于仅前缀局部命中的文档。
    /// 不影响是否命中（must 条件不变），只提升得分。
    #[serde(default)]
    pub exact_boost_fields: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct SortClause {
    pub field: String,
    #[serde(default = "default_sort_order")]
    pub order: String,
}

fn default_sort_order() -> String {
    "asc".to_string()
}

/// POST /api/es-app/:index/search
pub async fn search(
    State(pool): State<PgPool>,
    headers: axum::http::HeaderMap,
    scope: Option<Extension<EsTenantScope>>,
    Path(IndexPath { index }): Path<IndexPath>,
    Json(req): Json<SearchRequest>,
) -> Result<Response, AppError> {
    let token = resolve_token_for_request(&pool, &headers, scope).await?;
    enforce_app_access(&token, "POST", &index)?;

    let page = req.page.unwrap_or(1).max(1);
    let size = req.size.unwrap_or(20).min(1000); // 硬上限 1000：超过应改用 scroll / search_after
    let from = (page - 1) * size;

    let body = build_search_body(&req, from, size)?;

    let path = format!("/{}/_search", index);
    let (status, upstream) =
        upstream_json(&token, ReqMethod::POST, &path, None, Some(&body)).await?;
    spawn_usage_update(pool.clone(), token.token_id);

    if !status.is_success() {
        // ES 4xx：透传给调用方
        return Ok(json_response(status, upstream));
    }

    let took_ms = upstream.get("took").and_then(|v| v.as_u64()).unwrap_or(0);
    let total = upstream
        .get("hits")
        .and_then(|h| h.get("total"))
        .and_then(|t| t.get("value"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let data: Vec<Value> = upstream
        .get("hits")
        .and_then(|h| h.get("hits"))
        .and_then(|a| a.as_array())
        .map(|arr| arr.iter().map(flatten_hit).collect())
        .unwrap_or_default();

    let mut result = json!({
        "total": total,
        "page": page,
        "size": size,
        "took_ms": took_ms,
        "data": data,
    });
    if let (Some(out), Some(aggregations)) = (result.as_object_mut(), upstream.get("aggregations"))
    {
        out.insert("aggregations".to_string(), aggregations.clone());
    }

    Ok(json_response(status, result))
}

/// 构造完整的 `_search` body，并在发往 ES 前校验受限聚合。
fn build_search_body(req: &SearchRequest, from: u32, size: u32) -> Result<Value, AppError> {
    let mut body = build_search_query(req)?;
    if let Some(obj) = body.as_object_mut() {
        obj.insert("from".to_string(), json!(from));
        obj.insert("size".to_string(), json!(size));
        if let Some(sort) = build_sort(req) {
            obj.insert("sort".to_string(), sort);
        }
        if let Some(select) = &req.select {
            obj.insert("_source".to_string(), json!(select));
        }
        if let Some(aggs) = &req.aggs {
            obj.insert("aggs".to_string(), validate_aggregations(aggs)?);
        }
        // track_total_hits 默认 true（避免 total 在 >10000 时被截）
        let track = req.track_total.clone().unwrap_or(json!(true));
        obj.insert("track_total_hits".to_string(), track);
    }
    Ok(body)
}

const MAX_AGGREGATIONS: usize = 20;
const MAX_TOTAL_AGG_BUCKETS: u64 = 10_000;
const MAX_COMPOSITE_AGG_SIZE: u64 = 1_000;
const MAX_COMPOSITE_SOURCES: usize = 10;

/// 校验 ES App 暴露的聚合子集，拒绝 script 和其它高成本/高权限聚合。
fn validate_aggregations(aggs: &Map<String, Value>) -> Result<Value, AppError> {
    if aggs.len() > MAX_AGGREGATIONS {
        return Err(AppError::InvalidQuery(format!(
            "aggs 最多支持 {} 项",
            MAX_AGGREGATIONS
        )));
    }

    let mut validated = Map::new();
    let mut total_bucket_budget = 0_u64;
    for (name, definition) in aggs {
        if name.trim().is_empty() || name.len() > 128 {
            return Err(AppError::InvalidQuery(
                "aggs 名称不能为空且不能超过 128 字节".to_string(),
            ));
        }
        let definition = definition
            .as_object()
            .ok_or_else(|| AppError::InvalidQuery(format!("aggs.{} 必须是对象", name)))?;
        if definition.len() != 1 {
            return Err(AppError::InvalidQuery(format!(
                "aggs.{} 必须且只能包含 terms 或 composite",
                name
            )));
        }

        let (validated_definition, bucket_budget) = if let Some(terms) = definition.get("terms") {
            validate_terms_aggregation(name, terms)?
        } else if let Some(composite) = definition.get("composite") {
            validate_composite_aggregation(name, composite)?
        } else {
            return Err(AppError::InvalidQuery(format!(
                "aggs.{} 仅支持 terms 或 composite 聚合",
                name
            )));
        };
        total_bucket_budget = total_bucket_budget
            .checked_add(bucket_budget)
            .ok_or_else(|| AppError::InvalidQuery("aggs size 总和过大".to_string()))?;
        if total_bucket_budget > MAX_TOTAL_AGG_BUCKETS {
            return Err(AppError::InvalidQuery(format!(
                "aggs 所有 size 总和不能超过 {}",
                MAX_TOTAL_AGG_BUCKETS
            )));
        }
        validated.insert(name.clone(), validated_definition);
    }
    Ok(Value::Object(validated))
}

fn validate_terms_aggregation(name: &str, terms: &Value) -> Result<(Value, u64), AppError> {
    let terms = terms
        .as_object()
        .ok_or_else(|| AppError::InvalidQuery(format!("aggs.{}.terms 必须是对象", name)))?;
    if let Some(unknown) = terms
        .keys()
        .find(|key| !matches!(key.as_str(), "field" | "size"))
    {
        return Err(AppError::InvalidQuery(format!(
            "aggs.{}.terms 不支持参数 `{}`；支持 field/size",
            name, unknown
        )));
    }

    let field =
        validate_aggregation_field(terms.get("field"), &format!("aggs.{}.terms.field", name))?;
    let size = validate_optional_size(
        terms.get("size"),
        MAX_TOTAL_AGG_BUCKETS,
        &format!("aggs.{}.terms.size", name),
    )?;

    let mut terms_out = Map::new();
    terms_out.insert("field".to_string(), Value::String(field));
    if let Some(size) = size {
        terms_out.insert("size".to_string(), json!(size));
    }
    Ok((json!({ "terms": terms_out }), size.unwrap_or(10)))
}

fn validate_composite_aggregation(name: &str, composite: &Value) -> Result<(Value, u64), AppError> {
    let composite = composite
        .as_object()
        .ok_or_else(|| AppError::InvalidQuery(format!("aggs.{}.composite 必须是对象", name)))?;
    if let Some(unknown) = composite
        .keys()
        .find(|key| !matches!(key.as_str(), "size" | "sources" | "after"))
    {
        return Err(AppError::InvalidQuery(format!(
            "aggs.{}.composite 不支持参数 `{}`；支持 size/sources/after",
            name, unknown
        )));
    }

    let size = validate_optional_size(
        composite.get("size"),
        MAX_COMPOSITE_AGG_SIZE,
        &format!("aggs.{}.composite.size", name),
    )?;
    let sources = composite
        .get("sources")
        .and_then(Value::as_array)
        .filter(|sources| !sources.is_empty() && sources.len() <= MAX_COMPOSITE_SOURCES)
        .ok_or_else(|| {
            AppError::InvalidQuery(format!(
                "aggs.{}.composite.sources 必须是 1..={} 项的数组",
                name, MAX_COMPOSITE_SOURCES
            ))
        })?;

    let mut source_names: Vec<String> = Vec::with_capacity(sources.len());
    let mut validated_sources: Vec<Value> = Vec::with_capacity(sources.len());
    for (index, source) in sources.iter().enumerate() {
        let source = source
            .as_object()
            .filter(|source| source.len() == 1)
            .ok_or_else(|| {
                AppError::InvalidQuery(format!(
                    "aggs.{}.composite.sources[{}] 必须只包含一个命名 source",
                    name, index
                ))
            })?;
        let (source_name, source_definition) = source.iter().next().expect("长度已校验为 1");
        if source_name.trim().is_empty() || source_name.len() > 128 {
            return Err(AppError::InvalidQuery(format!(
                "aggs.{}.composite.sources[{}] 名称不能为空且不能超过 128 字节",
                name, index
            )));
        }
        if source_names.contains(source_name) {
            return Err(AppError::InvalidQuery(format!(
                "aggs.{}.composite source `{}` 重复",
                name, source_name
            )));
        }

        let source_definition = source_definition.as_object().ok_or_else(|| {
            AppError::InvalidQuery(format!(
                "aggs.{}.composite source `{}` 必须是对象",
                name, source_name
            ))
        })?;
        if source_definition.len() != 1 || !source_definition.contains_key("terms") {
            return Err(AppError::InvalidQuery(format!(
                "aggs.{}.composite source `{}` 仅支持 terms",
                name, source_name
            )));
        }
        let source_terms = source_definition["terms"].as_object().ok_or_else(|| {
            AppError::InvalidQuery(format!(
                "aggs.{}.composite source `{}`.terms 必须是对象",
                name, source_name
            ))
        })?;
        if let Some(unknown) = source_terms.keys().find(|key| key.as_str() != "field") {
            return Err(AppError::InvalidQuery(format!(
                "aggs.{}.composite source `{}`.terms 不支持参数 `{}`；仅支持 field",
                name, source_name, unknown
            )));
        }
        let field = validate_aggregation_field(
            source_terms.get("field"),
            &format!(
                "aggs.{}.composite source `{}`.terms.field",
                name, source_name
            ),
        )?;

        source_names.push(source_name.clone());
        let mut source_out = Map::new();
        source_out.insert(source_name.clone(), json!({ "terms": { "field": field } }));
        validated_sources.push(Value::Object(source_out));
    }

    let mut composite_out = Map::new();
    if let Some(size) = size {
        composite_out.insert("size".to_string(), json!(size));
    }
    composite_out.insert("sources".to_string(), Value::Array(validated_sources));
    if let Some(after) = composite.get("after") {
        let after = after.as_object().ok_or_else(|| {
            AppError::InvalidQuery(format!("aggs.{}.composite.after 必须是对象", name))
        })?;
        if after.len() != source_names.len() || after.keys().any(|key| !source_names.contains(key))
        {
            return Err(AppError::InvalidQuery(format!(
                "aggs.{}.composite.after 必须包含且仅包含所有 source 名称",
                name
            )));
        }
        if let Some((key, _)) = after
            .iter()
            .find(|(_, value)| !(value.is_string() || value.is_number() || value.is_boolean()))
        {
            return Err(AppError::InvalidQuery(format!(
                "aggs.{}.composite.after.{} 必须是字符串、数字或布尔值",
                name, key
            )));
        }
        composite_out.insert("after".to_string(), Value::Object(after.clone()));
    }

    Ok((json!({ "composite": composite_out }), size.unwrap_or(10)))
}

fn validate_aggregation_field(value: Option<&Value>, path: &str) -> Result<String, AppError> {
    value
        .and_then(Value::as_str)
        .filter(|field| !field.trim().is_empty() && field.len() <= 512)
        .map(ToString::to_string)
        .ok_or_else(|| {
            AppError::InvalidQuery(format!("{} 必须是非空字符串且不超过 512 字节", path))
        })
}

fn validate_optional_size(
    value: Option<&Value>,
    max: u64,
    path: &str,
) -> Result<Option<u64>, AppError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value
        .as_u64()
        .ok_or_else(|| AppError::InvalidQuery(format!("{} 必须是正整数", path)))?;
    if value == 0 || value > max {
        return Err(AppError::InvalidQuery(format!(
            "{} 必须在 1..={} 之间",
            path, max
        )));
    }
    Ok(Some(value))
}

/// POST /api/es-app/:index/count
pub async fn count(
    State(pool): State<PgPool>,
    headers: axum::http::HeaderMap,
    scope: Option<Extension<EsTenantScope>>,
    Path(IndexPath { index }): Path<IndexPath>,
    Json(req): Json<SearchRequest>,
) -> Result<Response, AppError> {
    let token = resolve_token_for_request(&pool, &headers, scope).await?;
    enforce_app_access(&token, "POST", &index)?;

    // /_count 只接受 `query`；其它都剥掉
    let body = build_search_query(&req)?;
    let path = format!("/{}/_count", index);
    let (status, upstream) =
        upstream_json(&token, ReqMethod::POST, &path, None, Some(&body)).await?;
    spawn_usage_update(pool.clone(), token.token_id);

    if !status.is_success() {
        return Ok(json_response(status, upstream));
    }
    let count = upstream.get("count").and_then(|v| v.as_u64()).unwrap_or(0);
    Ok(json_response(status, json!({ "count": count })))
}

/// 把 ES `hits` 项扁平化：`_source` 内字段提到顶层 + `_id` / `_score`。
fn flatten_hit(hit: &Value) -> Value {
    let mut out = hit
        .get("_source")
        .and_then(|s| s.as_object())
        .cloned()
        .unwrap_or_default();
    if let Some(v) = hit.get("_id") {
        out.insert("_id".to_string(), v.clone());
    }
    if let Some(v) = hit.get("_score") {
        // _score 在 filter-only 查询时是 null / 0；保留以便调用方判定相关性
        out.insert("_score".to_string(), v.clone());
    }
    // nested 命中的高亮片段（如有）汇总到 _highlights，方便前端展示"命中了哪段译文"
    if let Some(hl) = extract_highlights(hit) {
        out.insert("_highlights".to_string(), hl);
    }
    Value::Object(out)
}

/// 从 nested `inner_hits` 里汇总高亮片段，输出形如 `{ "title.value": ["...<em>x</em>..."] }`。
///
/// 同一字段跨多条 nested 子文档命中的片段会合并到一个数组；没有任何高亮时返回 `None`。
fn extract_highlights(hit: &Value) -> Option<Value> {
    let inner = hit.get("inner_hits")?.as_object()?;
    let mut out: Map<String, Value> = Map::new();
    for (_path, ih) in inner {
        let hits = match ih
            .get("hits")
            .and_then(|h| h.get("hits"))
            .and_then(|a| a.as_array())
        {
            Some(arr) => arr,
            None => continue,
        };
        for h in hits {
            let hl = match h.get("highlight").and_then(|v| v.as_object()) {
                Some(m) => m,
                None => continue,
            };
            for (field, frags) in hl {
                let frag_arr = match frags.as_array() {
                    Some(a) => a,
                    None => continue,
                };
                let slot = out
                    .entry(field.clone())
                    .or_insert_with(|| Value::Array(Vec::new()));
                if let Some(existing) = slot.as_array_mut() {
                    existing.extend(frag_arr.iter().cloned());
                }
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(Value::Object(out))
    }
}

/// 把 `SearchRequest.where_` + `q` 翻译成 `{query: {bool: {...}}}`。
///
/// 返回的 `Value` 形如 `{"query": {"bool": {...}}}`，调用方再补 `from/size/sort/_source`。
fn build_search_query(req: &SearchRequest) -> Result<Value, AppError> {
    let mut filter: Vec<Value> = Vec::new();
    let mut must_not: Vec<Value> = Vec::new();
    let mut must: Vec<Value> = Vec::new();
    // should 不影响是否命中，只提升精确/短语匹配文档的得分
    let mut should: Vec<Value> = Vec::new();

    if let Some(where_map) = &req.where_ {
        for (field, val) in where_map.iter() {
            translate_where_entry(field, val, &mut filter, &mut must_not)?;
        }
    }

    if let Some(q) = &req.q {
        if !q.trim().is_empty() {
            must.push(build_q_clause(req, q));

            // 精确命中 boost：match_phrase（短语包含）+ .keyword term（完全等于），
            // 让 title="A" 这类精确匹配文档得分远高于仅前缀局部命中的文档。
            if let Some(boost_fields) = &req.exact_boost_fields {
                for f in boost_fields {
                    let (field, boost) = parse_field_boost(f);
                    should.push(
                        json!({ "match_phrase": { &field: { "query": q, "boost": boost } } }),
                    );
                    // .keyword 子字段完全精确匹配，给 2 倍 boost
                    let kw = format!("{}.keyword", field);
                    should.push(json!({ "term": { kw: { "value": q, "boost": boost * 2.0 } } }));
                }
            }
        }
    }

    // 四个桶都空：match_all
    if filter.is_empty() && must_not.is_empty() && must.is_empty() && should.is_empty() {
        return Ok(json!({ "query": { "match_all": {} } }));
    }

    let mut bool_obj = Map::new();
    if !filter.is_empty() {
        bool_obj.insert("filter".to_string(), Value::Array(filter));
    }
    if !must_not.is_empty() {
        bool_obj.insert("must_not".to_string(), Value::Array(must_not));
    }
    if !must.is_empty() {
        bool_obj.insert("must".to_string(), Value::Array(must));
    }
    if !should.is_empty() {
        bool_obj.insert("should".to_string(), Value::Array(should));
    }
    Ok(json!({ "query": { "bool": bool_obj } }))
}

/// 解析 `"field_name^boost"` → `("field_name", boost)`，无 `^` 时 boost 默认 1.0。
fn parse_field_boost(field: &str) -> (String, f64) {
    match field.split_once('^') {
        Some((name, b)) => (name.to_string(), b.parse::<f64>().unwrap_or(1.0)),
        None => (field.to_string(), 1.0),
    }
}

/// 构造 `q` 全文检索子句。
///
/// - 未声明 `nested_paths`：保持原行为（有 `q_fields` 用 multi_match，否则 query_string）。
/// - 声明了 `nested_paths`：把 `q_fields` 按 nested 前缀（如 `title.`）分组——每个 nested
///   path 包一层 `nested` 查询并带 `inner_hits`（含高亮），其余普通字段合成一条 multi_match；
///   多个子句用 `bool.should + minimum_should_match:1` 组合（命中任意字段即算相关）。
///   每条 multi_match 用 `type=bool_prefix` + `operator=and`（边输入边搜，详见模块头注释）。
fn build_q_clause(req: &SearchRequest, q: &str) -> Value {
    let nested = req.nested_paths.clone().unwrap_or_default();

    // 无 nested 声明 —— 完全兼容老行为
    if nested.is_empty() {
        return match &req.q_fields {
            Some(fields) if !fields.is_empty() => json!({
                "multi_match": { "query": q, "fields": fields }
            }),
            _ => json!({
                "query_string": { "query": q }
            }),
        };
    }

    let fields = req.q_fields.clone().unwrap_or_default();
    let mut should: Vec<Value> = Vec::new();

    // 每个 nested path 一条 nested 子句
    for path in &nested {
        let prefix = format!("{}.", path);
        let path_fields: Vec<String> = fields
            .iter()
            .filter(|f| f.starts_with(&prefix))
            .cloned()
            .collect();
        if path_fields.is_empty() {
            continue;
        }
        // inner_hits 高亮字段名要去掉 `^boost` 后缀
        let mut hl_fields = Map::new();
        for f in &path_fields {
            hl_fields.insert(strip_boost(f).to_string(), json!({}));
        }
        should.push(json!({
            "nested": {
                "path": path,
                // 两层评分：
                // must=bool_prefix  保证「边输入边搜」前缀命中（如 "Mys" → "Mystery"）；
                // should=best_fields 利用 BM25 字段长度归一化给完整词额外加分——
                //   title="A"（1词）比 title="Recovery of my account"（4词）得分高得多，
                //   解决精确匹配排名靠后的问题。
                "query": {
                    "bool": {
                        "must": [{ "multi_match": { "query": q, "fields": path_fields, "type": "bool_prefix", "operator": "and" } }],
                        "should": [{ "multi_match": { "query": q, "fields": path_fields, "type": "best_fields", "operator": "and" } }]
                    }
                },
                "inner_hits": { "highlight": { "fields": hl_fields } }
            }
        }));
    }

    // 非 nested 的普通字段合成一条两层查询（与 nested 内部相同策略）
    let flat_fields: Vec<String> = fields
        .iter()
        .filter(|f| !nested.iter().any(|p| f.starts_with(&format!("{}.", p))))
        .cloned()
        .collect();
    if !flat_fields.is_empty() {
        should.push(json!({
            "bool": {
                "must": [{ "multi_match": { "query": q, "fields": flat_fields, "type": "bool_prefix", "operator": "and" } }],
                "should": [{ "multi_match": { "query": q, "fields": flat_fields, "type": "best_fields", "operator": "and" } }]
            }
        }));
    }

    // 兜底：声明了 nested 却没有任何可用字段 → 退回 query_string，避免空 should 查不到东西
    if should.is_empty() {
        return json!({ "query_string": { "query": q } });
    }

    json!({ "bool": { "minimum_should_match": 1, "should": should } })
}

/// 去掉字段名里的 `^boost` 后缀（`title.value^3` → `title.value`），用于 highlight 字段名。
fn strip_boost(field: &str) -> &str {
    field.split('^').next().unwrap_or(field)
}

/// 翻译一条 `{field: value | {ops...}}`。
fn translate_where_entry(
    field: &str,
    val: &Value,
    filter: &mut Vec<Value>,
    must_not: &mut Vec<Value>,
) -> Result<(), AppError> {
    // 标量 / 数组 / null —— 当作 eq
    let ops = match val {
        Value::Object(map) => map,
        Value::Null => {
            // {f: null} → exists:false 语义
            must_not.push(json!({ "exists": { "field": field } }));
            return Ok(());
        }
        Value::Array(arr) => {
            filter.push(json!({ "terms": { field: arr } }));
            return Ok(());
        }
        scalar => {
            filter.push(json!({ "term": { field: scalar } }));
            return Ok(());
        }
    };

    // 多 range op 合并：gte/gt/lte/lt 同字段进同一个 range 子句
    let mut range_obj: Map<String, Value> = Map::new();

    for (op, v) in ops.iter() {
        match op.as_str() {
            "eq" => filter.push(json!({ "term": { field: v } })),
            "ne" => must_not.push(json!({ "term": { field: v } })),
            "in" => {
                let arr = v.as_array().ok_or_else(|| {
                    AppError::InvalidQuery(format!("where.{}.in 必须是数组", field))
                })?;
                filter.push(json!({ "terms": { field: arr } }));
            }
            "nin" | "not_in" => {
                let arr = v.as_array().ok_or_else(|| {
                    AppError::InvalidQuery(format!("where.{}.{} 必须是数组", field, op))
                })?;
                must_not.push(json!({ "terms": { field: arr } }));
            }
            "gt" | "gte" | "lt" | "lte" => {
                range_obj.insert(op.clone(), v.clone());
            }
            "contains" | "match" => {
                let s = v.as_str().ok_or_else(|| {
                    AppError::InvalidQuery(format!("where.{}.{} 必须是字符串", field, op))
                })?;
                filter.push(json!({ "match": { field: s } }));
            }
            "prefix" | "starts_with" => {
                let prefix = translate_multi_term_value(field, op, v)?;
                filter.push(json!({ "prefix": { field: prefix } }));
            }
            "exists" => {
                let b = v.as_bool().ok_or_else(|| {
                    AppError::InvalidQuery(format!("where.{}.exists 必须是布尔", field))
                })?;
                if b {
                    filter.push(json!({ "exists": { "field": field } }));
                } else {
                    must_not.push(json!({ "exists": { "field": field } }));
                }
            }
            "wildcard" => {
                let wildcard = translate_multi_term_value(field, op, v)?;
                filter.push(json!({ "wildcard": { field: wildcard } }));
            }
            other => {
                return Err(AppError::InvalidQuery(format!(
                    "where.{}: 不支持的操作符 `{}`；支持 eq/ne/in/nin/gt/gte/lt/lte/contains/prefix/exists/wildcard",
                    field, other
                )));
            }
        }
    }
    if !range_obj.is_empty() {
        filter.push(json!({ "range": { field: range_obj } }));
    }
    Ok(())
}

/// 翻译 prefix / wildcard 的简写或 ES 参数对象。
///
/// - `"promo-*"` 保持原有字符串简写；
/// - `{"value":"*iphone*","case_insensitive":true,"rewrite":"constant_score"}`
///   允许业务侧使用 ES multi-term query 的常用参数。
fn translate_multi_term_value(
    field: &str,
    operator: &str,
    value: &Value,
) -> Result<Value, AppError> {
    if value.is_string() {
        return Ok(value.clone());
    }

    let options = value.as_object().ok_or_else(|| {
        AppError::InvalidQuery(format!(
            "where.{}.{} 必须是字符串或参数对象",
            field, operator
        ))
    })?;

    let query_value = options
        .get("value")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::InvalidQuery(format!("where.{}.{}.value 必须是字符串", field, operator))
        })?;

    if let Some(case_insensitive) = options.get("case_insensitive") {
        if !case_insensitive.is_boolean() {
            return Err(AppError::InvalidQuery(format!(
                "where.{}.{}.case_insensitive 必须是布尔值",
                field, operator
            )));
        }
    }
    if let Some(rewrite) = options.get("rewrite") {
        if !rewrite.is_string() {
            return Err(AppError::InvalidQuery(format!(
                "where.{}.{}.rewrite 必须是字符串",
                field, operator
            )));
        }
    }
    if let Some(boost) = options.get("boost") {
        if !boost.is_number() {
            return Err(AppError::InvalidQuery(format!(
                "where.{}.{}.boost 必须是数字",
                field, operator
            )));
        }
    }

    const ALLOWED_OPTIONS: &[&str] = &["value", "case_insensitive", "rewrite", "boost"];
    if let Some(unknown) = options
        .keys()
        .find(|key| !ALLOWED_OPTIONS.contains(&key.as_str()))
    {
        return Err(AppError::InvalidQuery(format!(
            "where.{}.{} 不支持参数 `{}`；支持 value/case_insensitive/rewrite/boost",
            field, operator, unknown
        )));
    }

    let mut translated = Map::new();
    translated.insert("value".to_string(), json!(query_value));
    for option in ["case_insensitive", "rewrite", "boost"] {
        if let Some(option_value) = options.get(option) {
            translated.insert(option.to_string(), option_value.clone());
        }
    }
    Ok(Value::Object(translated))
}

fn build_sort(req: &SearchRequest) -> Option<Value> {
    let sort = req.sort.as_ref()?;
    if sort.is_empty() {
        return None;
    }
    let arr: Vec<Value> = sort
        .iter()
        .map(|s| {
            let order = if s.order.eq_ignore_ascii_case("desc") {
                "desc"
            } else {
                "asc"
            };
            json!({ &s.field: { "order": order } })
        })
        .collect();
    Some(Value::Array(arr))
}

// ── bulk ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct BulkRequest {
    pub operations: Vec<BulkOp>,
}

#[derive(Debug, Deserialize)]
pub struct BulkOp {
    /// index | create | update | delete
    pub action: String,
    pub id: Option<String>,
    pub doc: Option<Value>,
    /// 仅 update：是否找不到时按 doc 创建（doc_as_upsert）
    #[serde(default)]
    pub upsert: Option<bool>,
}

/// POST /api/es-app/:index/bulk
pub async fn bulk(
    State(pool): State<PgPool>,
    headers: axum::http::HeaderMap,
    scope: Option<Extension<EsTenantScope>>,
    Path(IndexPath { index }): Path<IndexPath>,
    Json(req): Json<BulkRequest>,
) -> Result<Response, AppError> {
    let token = resolve_token_for_request(&pool, &headers, scope).await?;
    enforce_app_access(&token, "POST", &index)?;

    if req.operations.is_empty() {
        return Err(AppError::InvalidQuery(
            "bulk.operations 不能为空".to_string(),
        ));
    }
    if req.operations.len() > 1000 {
        return Err(AppError::InvalidQuery(
            "bulk.operations 单次最多 1000 条".to_string(),
        ));
    }

    let ndjson = build_bulk_ndjson(&index, &req)?;
    let path = "/_bulk".to_string();
    let (status, upstream) = upstream_raw(
        &token,
        ReqMethod::POST,
        &path,
        None,
        // ES 8.x 推荐 application/x-ndjson；旧版本接受 application/json 但不规范
        "application/x-ndjson",
        ndjson.into_bytes(),
    )
    .await?;
    spawn_usage_update(pool.clone(), token.token_id);

    if !status.is_success() {
        return Ok(json_response(status, upstream));
    }

    let took_ms = upstream.get("took").and_then(|v| v.as_u64()).unwrap_or(0);
    let errors = upstream
        .get("errors")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let results: Vec<Value> = upstream
        .get("items")
        .and_then(|v| v.as_array())
        .map(|items| items.iter().map(simplify_bulk_item).collect())
        .unwrap_or_default();

    Ok(json_response(
        status,
        json!({
            "took_ms": took_ms,
            "errors": errors,
            "results": results,
        }),
    ))
}

/// 把高层 BulkRequest 编成 ES `_bulk` 协议的 NDJSON。
///
/// 每个操作两行（delete 只有一行的 action header）；最后必须有换行符，否则 ES 5xx。
fn build_bulk_ndjson(index: &str, req: &BulkRequest) -> Result<String, AppError> {
    let mut out = String::new();
    for (i, op) in req.operations.iter().enumerate() {
        let action = op.action.to_ascii_lowercase();
        match action.as_str() {
            "index" | "create" => {
                let doc = op.doc.as_ref().ok_or_else(|| {
                    AppError::InvalidQuery(format!(
                        "bulk.operations[{}]: action={} 需要 doc",
                        i, action
                    ))
                })?;
                let header = match &op.id {
                    Some(id) => json!({ &action: { "_index": index, "_id": id } }),
                    None => json!({ &action: { "_index": index } }),
                };
                out.push_str(&serde_json::to_string(&header).unwrap());
                out.push('\n');
                out.push_str(&serde_json::to_string(doc).unwrap());
                out.push('\n');
            }
            "update" => {
                let id = op.id.as_ref().ok_or_else(|| {
                    AppError::InvalidQuery(format!("bulk.operations[{}]: action=update 需要 id", i))
                })?;
                let doc = op.doc.as_ref().ok_or_else(|| {
                    AppError::InvalidQuery(format!(
                        "bulk.operations[{}]: action=update 需要 doc",
                        i
                    ))
                })?;
                let header = json!({ "update": { "_index": index, "_id": id } });
                let mut body = json!({ "doc": doc });
                if op.upsert == Some(true) {
                    body.as_object_mut()
                        .unwrap()
                        .insert("doc_as_upsert".to_string(), json!(true));
                }
                out.push_str(&serde_json::to_string(&header).unwrap());
                out.push('\n');
                out.push_str(&serde_json::to_string(&body).unwrap());
                out.push('\n');
            }
            "delete" => {
                let id = op.id.as_ref().ok_or_else(|| {
                    AppError::InvalidQuery(format!("bulk.operations[{}]: action=delete 需要 id", i))
                })?;
                let header = json!({ "delete": { "_index": index, "_id": id } });
                out.push_str(&serde_json::to_string(&header).unwrap());
                out.push('\n');
            }
            other => {
                return Err(AppError::InvalidQuery(format!(
                    "bulk.operations[{}]: 不支持的 action `{}`（支持 index/create/update/delete）",
                    i, other
                )));
            }
        }
    }
    Ok(out)
}

/// 简化 `_bulk` items 里的单条结果。
/// ES 返回形如 `{"index": {"_id": "...", "status": 201, "result": "created"}}`；
/// 我们抠成 `{"action": "index", "_id": "...", "status": 201, "result": "created", "ok": true|false, "error": "..."}`。
fn simplify_bulk_item(item: &Value) -> Value {
    let obj = match item.as_object() {
        Some(o) => o,
        None => return item.clone(),
    };
    let (action, inner) = match obj.iter().next() {
        Some((k, v)) => (k.clone(), v.clone()),
        None => return item.clone(),
    };
    let id = inner.get("_id").cloned().unwrap_or(Value::Null);
    let status = inner.get("status").and_then(|v| v.as_u64()).unwrap_or(0);
    let result = inner.get("result").cloned().unwrap_or(Value::Null);
    let ok = status < 400;
    let mut out = json!({
        "action": action,
        "_id": id,
        "status": status,
        "result": result,
        "ok": ok,
    });
    if !ok {
        if let Some(err) = inner.get("error") {
            let msg = err
                .get("reason")
                .and_then(|r| r.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| err.to_string());
            out.as_object_mut()
                .unwrap()
                .insert("error".to_string(), Value::String(msg));
        }
    }
    out
}

// ── 索引管理 ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct InitIndexRequest {
    /// 字段类型字典：{字段名: {type: "keyword"|"text"|..., ...}}
    #[serde(default)]
    pub fields: Option<Map<String, Value>>,
    /// 简化的 settings：`{shards: N, replicas: N, refresh_interval: "1s"}`
    /// 也允许直接传 ES 原生 settings 对象（含 `number_of_shards` 等）。
    #[serde(default)]
    pub settings: Option<Map<String, Value>>,
    /// 若 true 且 index 已存在，不报错直接返回 acknowledged=true。
    #[serde(default)]
    pub if_not_exists: bool,
}

/// POST /api/es-app/:index/_init —— 用简化语法建 index + mapping
pub async fn init_index(
    State(pool): State<PgPool>,
    headers: axum::http::HeaderMap,
    scope: Option<Extension<EsTenantScope>>,
    Path(IndexPath { index }): Path<IndexPath>,
    Json(req): Json<InitIndexRequest>,
) -> Result<Response, AppError> {
    let token = resolve_token_for_request(&pool, &headers, scope).await?;
    // 用 POST 校验（用户对这个 endpoint 打的是 POST）；上游再翻译成 PUT
    enforce_app_access(&token, "POST", &index)?;

    let mut body = Map::new();
    if let Some(settings) = req.settings {
        body.insert(
            "settings".to_string(),
            Value::Object(normalize_settings(settings)),
        );
    }
    if let Some(fields) = req.fields {
        body.insert(
            "mappings".to_string(),
            json!({ "properties": Value::Object(fields) }),
        );
    }

    let path = format!("/{}", index);
    let (status, upstream) = upstream_json(
        &token,
        ReqMethod::PUT,
        &path,
        None,
        Some(&Value::Object(body)),
    )
    .await?;
    spawn_usage_update(pool.clone(), token.token_id);

    // 如果 if_not_exists=true 且 ES 报 resource_already_exists_exception，吞掉错误
    if req.if_not_exists && status == StatusCode::BAD_REQUEST {
        let already_exists = upstream
            .get("error")
            .and_then(|e| e.get("type"))
            .and_then(|t| t.as_str())
            == Some("resource_already_exists_exception");
        if already_exists {
            return Ok(json_response(
                StatusCode::OK,
                json!({ "acknowledged": true, "already_exists": true, "index": index }),
            ));
        }
    }
    Ok(json_response(status, upstream))
}

/// 兼容简化字段：`shards/replicas/refresh_interval` → ES 原生 `number_of_*`。
fn normalize_settings(mut settings: Map<String, Value>) -> Map<String, Value> {
    if let Some(v) = settings.remove("shards") {
        settings.insert("number_of_shards".to_string(), v);
    }
    if let Some(v) = settings.remove("replicas") {
        settings.insert("number_of_replicas".to_string(), v);
    }
    settings
}

/// DELETE /api/es-app/:index
pub async fn delete_index(
    State(pool): State<PgPool>,
    headers: axum::http::HeaderMap,
    scope: Option<Extension<EsTenantScope>>,
    Path(IndexPath { index }): Path<IndexPath>,
) -> Result<Response, AppError> {
    let token = resolve_token_for_request(&pool, &headers, scope).await?;
    enforce_app_access(&token, "DELETE", &index)?;

    let path = format!("/{}", index);
    let (status, upstream) = upstream_json(&token, ReqMethod::DELETE, &path, None, None).await?;
    spawn_usage_update(pool.clone(), token.token_id);
    Ok(json_response(status, upstream))
}

/// GET /api/es-app/:index —— 读 mapping + settings
pub async fn get_index_info(
    State(pool): State<PgPool>,
    headers: axum::http::HeaderMap,
    scope: Option<Extension<EsTenantScope>>,
    Path(IndexPath { index }): Path<IndexPath>,
) -> Result<Response, AppError> {
    let token = resolve_token_for_request(&pool, &headers, scope).await?;
    enforce_app_access(&token, "GET", &index)?;

    let path = format!("/{}", index);
    let (status, upstream) = upstream_json(&token, ReqMethod::GET, &path, None, None).await?;
    spawn_usage_update(pool.clone(), token.token_id);

    if !status.is_success() {
        return Ok(json_response(status, upstream));
    }

    // ES 返回 `{"<index_name>": {"aliases":..., "mappings":..., "settings":...}}`
    // 抠出 inner object，再带 `index` 字段方便调用方使用
    if let Some((real_name, inner)) = upstream.as_object().and_then(|o| o.iter().next()) {
        let mut out = inner.as_object().cloned().unwrap_or_default();
        out.insert("index".to_string(), Value::String(real_name.clone()));
        return Ok(json_response(status, Value::Object(out)));
    }
    Ok(json_response(status, upstream))
}

#[derive(Debug, Deserialize)]
pub struct ListIndicesQuery {
    /// 仅返回名字（默认 false，会带 docs / store / health 等元数据）
    #[serde(default)]
    pub names_only: bool,
}

/// GET /api/es-app/_indices —— 列出 token allowlist 命中的所有 index
pub async fn list_indices(
    State(pool): State<PgPool>,
    headers: axum::http::HeaderMap,
    scope: Option<Extension<EsTenantScope>>,
    Query(q): Query<ListIndicesQuery>,
) -> Result<Response, AppError> {
    let token = resolve_token_for_request(&pool, &headers, scope).await?;

    // 只校 method（这条 endpoint 不针对具体 index）
    if !token.allowed_methods.iter().any(|m| m == "GET") {
        return Err(AppError::Forbidden(
            "method GET 不在 token 允许列表".to_string(),
        ));
    }

    let path = "/_cat/indices".to_string();
    // 强制 JSON + 选择字段，控制响应体积
    let query_str = "format=json&h=index,health,status,docs.count,store.size";
    let (status, upstream) =
        upstream_json(&token, ReqMethod::GET, &path, Some(query_str), None).await?;
    spawn_usage_update(pool.clone(), token.token_id);

    if !status.is_success() {
        return Ok(json_response(status, upstream));
    }

    let arr = upstream.as_array().cloned().unwrap_or_default();

    // token allowlist 过滤（`*` 直接全放行）
    let allow_all = token.index_allowlist.iter().any(|p| p == "*");
    let filtered: Vec<Value> = arr
        .into_iter()
        .filter(|item| {
            let name = item.get("index").and_then(|v| v.as_str()).unwrap_or("");
            if name.is_empty() || name.starts_with('.') {
                return false; // 系统索引（.kibana / .geoip_databases 之类）默认不展示
            }
            if allow_all {
                return true;
            }
            token
                .index_allowlist
                .iter()
                .any(|pat| es_auth::glob_match(pat, name))
        })
        .collect();

    let result = if q.names_only {
        let names: Vec<Value> = filtered
            .iter()
            .filter_map(|v| v.get("index").cloned())
            .collect();
        json!({ "indices": names })
    } else {
        json!({ "indices": filtered })
    };
    Ok(json_response(status, result))
}

// ── 工具 ────────────────────────────────────────────────────────────────

/// URL-encode 文档 id（id 里可能含 `/` `空格` 等需要转义的字符）。
///
/// 用 `percent-encoding` crate 的 NON_ALPHANUMERIC 集合就够：保守一点，
/// 只放过 ASCII 字母数字，其它一律 `%xx`。
fn url_encode_id(id: &str) -> String {
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    utf8_percent_encode(id, NON_ALPHANUMERIC).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(json_str: &str) -> SearchRequest {
        serde_json::from_str(json_str).unwrap()
    }

    #[test]
    fn search_empty_means_match_all() {
        let r = req("{}");
        let q = build_search_query(&r).unwrap();
        assert_eq!(q, json!({ "query": { "match_all": {} } }));
    }

    #[test]
    fn search_terms_aggregation_is_added_to_body() {
        let r = req(r#"{
            "where": {"article_type": 0, "delete_status": 0},
            "size": 0,
            "aggs": {
                "topic_counts": {
                    "terms": {"field": "topics", "size": 10000}
                }
            }
        }"#);
        let body = build_search_body(&r, 0, 0).unwrap();
        assert_eq!(
            body["aggs"],
            json!({
                "topic_counts": {
                    "terms": {"field": "topics", "size": 10000}
                }
            })
        );
        assert_eq!(body["size"], 0);
        assert_eq!(body["from"], 0);
        assert_eq!(body["track_total_hits"], true);
    }

    #[test]
    fn search_composite_aggregation_is_added_to_body() {
        let r = req(r#"{
            "size": 0,
            "aggs": {
                "topic_counts": {
                    "composite": {
                        "size": 1000,
                        "sources": [
                            {"topic": {"terms": {"field": "topics"}}}
                        ],
                        "after": {"topic": "上一页最后一个值"}
                    }
                }
            }
        }"#);
        let body = build_search_body(&r, 0, 0).unwrap();
        assert_eq!(
            body["aggs"],
            json!({
                "topic_counts": {
                    "composite": {
                        "size": 1000,
                        "sources": [
                            {"topic": {"terms": {"field": "topics"}}}
                        ],
                        "after": {"topic": "上一页最后一个值"}
                    }
                }
            })
        );
    }

    #[test]
    fn search_aggregation_rejects_unsafe_or_oversized_options() {
        let scripted = req(r#"{
            "aggs": {
                "topic_counts": {
                    "terms": {"field": "topics", "script": "malicious"}
                }
            }
        }"#);
        assert!(build_search_body(&scripted, 0, 0)
            .unwrap_err()
            .to_string()
            .contains("不支持参数 `script`"));

        let oversized = req(r#"{
            "aggs": {
                "topic_counts": {
                    "terms": {"field": "topics", "size": 10001}
                }
            }
        }"#);
        assert!(build_search_body(&oversized, 0, 0)
            .unwrap_err()
            .to_string()
            .contains("1..=10000"));

        let combined_oversized = req(r#"{
            "aggs": {
                "topics": {"terms": {"field": "topics", "size": 6000}},
                "authors": {"terms": {"field": "author_id", "size": 5000}}
            }
        }"#);
        assert!(build_search_body(&combined_oversized, 0, 0)
            .unwrap_err()
            .to_string()
            .contains("size 总和不能超过 10000"));

        let unsupported = req(r#"{
            "aggs": {
                "avg_score": {
                    "avg": {"field": "score"}
                }
            }
        }"#);
        assert!(build_search_body(&unsupported, 0, 0)
            .unwrap_err()
            .to_string()
            .contains("仅支持 terms 或 composite 聚合"));

        let composite_scripted = req(r#"{
            "aggs": {
                "topics": {
                    "composite": {
                        "sources": [
                            {"topic": {"terms": {"field": "topics", "script": "malicious"}}}
                        ]
                    }
                }
            }
        }"#);
        assert!(build_search_body(&composite_scripted, 0, 0)
            .unwrap_err()
            .to_string()
            .contains("仅支持 field"));

        let composite_bad_after = req(r#"{
            "aggs": {
                "topics": {
                    "composite": {
                        "sources": [
                            {"topic": {"terms": {"field": "topics"}}}
                        ],
                        "after": {"wrong_source": "x"}
                    }
                }
            }
        }"#);
        assert!(build_search_body(&composite_bad_after, 0, 0)
            .unwrap_err()
            .to_string()
            .contains("必须包含且仅包含所有 source 名称"));
    }

    #[test]
    fn search_scalar_eq() {
        let r = req(r#"{"where": {"status": "paid"}}"#);
        let q = build_search_query(&r).unwrap();
        assert_eq!(
            q,
            json!({
                "query": {
                    "bool": {
                        "filter": [{ "term": { "status": "paid" } }]
                    }
                }
            })
        );
    }

    #[test]
    fn search_array_means_terms() {
        let r = req(r#"{"where": {"tag": ["a", "b"]}}"#);
        let q = build_search_query(&r).unwrap();
        assert_eq!(
            q,
            json!({
                "query": { "bool": { "filter": [{ "terms": { "tag": ["a", "b"] } }] } }
            })
        );
    }

    #[test]
    fn search_null_means_not_exists() {
        let r = req(r#"{"where": {"deleted_at": null}}"#);
        let q = build_search_query(&r).unwrap();
        assert_eq!(
            q,
            json!({
                "query": { "bool": { "must_not": [{ "exists": { "field": "deleted_at" } }] } }
            })
        );
    }

    #[test]
    fn search_range_merges_ops() {
        let r = req(r#"{"where": {"amount": {"gte": 10, "lte": 500}}}"#);
        let q = build_search_query(&r).unwrap();
        assert_eq!(
            q,
            json!({
                "query": {
                    "bool": {
                        "filter": [{ "range": { "amount": { "gte": 10, "lte": 500 } } }]
                    }
                }
            })
        );
    }

    #[test]
    fn search_ne_goes_to_must_not() {
        let r = req(r#"{"where": {"user_id": {"ne": 42}}}"#);
        let q = build_search_query(&r).unwrap();
        assert_eq!(
            q,
            json!({
                "query": { "bool": { "must_not": [{ "term": { "user_id": 42 } }] } }
            })
        );
    }

    #[test]
    fn search_in_and_nin() {
        let r = req(r#"{"where": {"status": {"in": ["paid"]}, "user_id": {"nin": [1, 2]}}}"#);
        let q = build_search_query(&r).unwrap();
        let bool_obj = &q["query"]["bool"];
        // 两条 must_not + 两条 filter 顺序非确定（HashMap 迭代），所以 assert 内容存在
        assert!(bool_obj["filter"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c == &json!({ "terms": { "status": ["paid"] } })));
        assert!(bool_obj["must_not"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c == &json!({ "terms": { "user_id": [1, 2] } })));
    }

    #[test]
    fn search_contains_and_prefix_and_wildcard() {
        let r = req(r#"{"where": {
                "title": {"contains": "首单"},
                "code":  {"prefix": "ORD-"},
                "tags":  {"wildcard": "promo-*"}
            }}"#);
        let q = build_search_query(&r).unwrap();
        let filters = q["query"]["bool"]["filter"].as_array().unwrap();
        assert!(filters
            .iter()
            .any(|c| c == &json!({ "match": { "title": "首单" } })));
        assert!(filters
            .iter()
            .any(|c| c == &json!({ "prefix": { "code": "ORD-" } })));
        assert!(filters
            .iter()
            .any(|c| c == &json!({ "wildcard": { "tags": "promo-*" } })));
    }

    #[test]
    fn search_prefix_accepts_es_options() {
        let r = req(r#"{"where": {
            "name": {"prefix": {
                "value": "iphone",
                "case_insensitive": true,
                "rewrite": "constant_score",
                "boost": 2
            }}
        }}"#);
        let q = build_search_query(&r).unwrap();
        assert_eq!(
            q,
            json!({
                "query": {
                    "bool": {
                        "filter": [{
                            "prefix": {
                                "name": {
                                    "value": "iphone",
                                    "case_insensitive": true,
                                    "rewrite": "constant_score",
                                    "boost": 2
                                }
                            }
                        }]
                    }
                }
            })
        );
    }

    #[test]
    fn search_wildcard_accepts_es_options() {
        let r = req(r#"{"where": {
            "name": {"wildcard": {
                "value": "*iphone*",
                "case_insensitive": true,
                "rewrite": "constant_score",
                "boost": 2
            }}
        }}"#);
        let q = build_search_query(&r).unwrap();
        assert_eq!(
            q,
            json!({
                "query": {
                    "bool": {
                        "filter": [{
                            "wildcard": {
                                "name": {
                                    "value": "*iphone*",
                                    "case_insensitive": true,
                                    "rewrite": "constant_score",
                                    "boost": 2
                                }
                            }
                        }]
                    }
                }
            })
        );
    }

    #[test]
    fn search_wildcard_rejects_invalid_options() {
        let missing_value = req(r#"{"where":{"name":{"wildcard":{"case_insensitive":true}}}}"#);
        assert!(build_search_query(&missing_value)
            .unwrap_err()
            .to_string()
            .contains("wildcard.value 必须是字符串"));

        let invalid_case =
            req(r#"{"where":{"name":{"wildcard":{"value":"*iphone*","case_insensitive":"yes"}}}}"#);
        assert!(build_search_query(&invalid_case)
            .unwrap_err()
            .to_string()
            .contains("case_insensitive 必须是布尔值"));

        let unknown_option =
            req(r#"{"where":{"name":{"wildcard":{"value":"*iphone*","unknown":true}}}}"#);
        assert!(build_search_query(&unknown_option)
            .unwrap_err()
            .to_string()
            .contains("不支持参数 `unknown`"));
    }

    #[test]
    fn search_exists_true_and_false() {
        let r = req(r#"{"where": {"a": {"exists": true}, "b": {"exists": false}}}"#);
        let q = build_search_query(&r).unwrap();
        let bool_obj = &q["query"]["bool"];
        assert!(bool_obj["filter"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c == &json!({ "exists": { "field": "a" } })));
        assert!(bool_obj["must_not"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c == &json!({ "exists": { "field": "b" } })));
    }

    #[test]
    fn search_q_uses_query_string_or_multi_match() {
        let r = req(r#"{"q": "promo OR sale"}"#);
        let q = build_search_query(&r).unwrap();
        assert_eq!(
            q,
            json!({
                "query": { "bool": { "must": [{ "query_string": { "query": "promo OR sale" } }] } }
            })
        );

        let r2 = req(r#"{"q": "promo", "q_fields": ["title", "remark"]}"#);
        let q2 = build_search_query(&r2).unwrap();
        assert_eq!(
            q2,
            json!({
                "query": { "bool": { "must": [{ "multi_match": { "query": "promo", "fields": ["title", "remark"] } }] } }
            })
        );
    }

    #[test]
    fn search_q_nested_paths_wraps_nested_query() {
        let r = req(r#"{"q": "篮球",
                "q_fields": ["title.value^3", "content.value", "tags"],
                "nested_paths": ["title", "content"]}"#);
        let q = build_search_query(&r).unwrap();
        let should = q["query"]["bool"]["must"][0]["bool"]["should"]
            .as_array()
            .unwrap();
        // title / content 各一条 nested + 普通字段 tags 一条 bool = 3 条
        assert_eq!(should.len(), 3);
        // title 这条：nested.path=title，内部 bool.must 用 bool_prefix + operator=and，
        // bool.should 用 best_fields（BM25 长度归一化，精确匹配加分）
        assert!(should.iter().any(|c| {
            let inner_must = &c["nested"]["query"]["bool"]["must"][0]["multi_match"];
            c["nested"]["path"] == "title"
                && inner_must["fields"][0] == "title.value^3"
                && inner_must["type"] == "bool_prefix"
                && inner_must["operator"] == "and"
                && c["nested"]["query"]["bool"]["should"][0]["multi_match"]["type"] == "best_fields"
                // 高亮字段名去掉了 boost
                && c["nested"]["inner_hits"]["highlight"]["fields"]
                    .get("title.value")
                    .is_some()
        }));
        assert!(should.iter().any(|c| c["nested"]["path"] == "content"));
        // 非 nested 的 tags 走两层 bool（must=bool_prefix, should=best_fields）
        assert!(should.iter().any(|c| {
            c["bool"]["must"][0]["multi_match"]["fields"]
                .as_array()
                .map_or(false, |a| a.contains(&json!("tags")))
        }));
        assert_eq!(
            q["query"]["bool"]["must"][0]["bool"]["minimum_should_match"],
            1
        );
    }

    #[test]
    fn search_q_nested_without_fields_falls_back_to_query_string() {
        // 声明了 nested 但字段不属于任何 nested path → 走普通两层 bool
        let r = req(r#"{"q": "x", "q_fields": ["other"], "nested_paths": ["title"]}"#);
        let q = build_search_query(&r).unwrap();
        // other 不属于 title.* → 进普通 bool（must=bool_prefix），should 仍有一条
        let should = q["query"]["bool"]["must"][0]["bool"]["should"]
            .as_array()
            .unwrap();
        assert_eq!(should.len(), 1);
        // 该条是 bool，其 must[0] 含 multi_match
        assert!(should[0]["bool"]["must"][0]["multi_match"]["fields"]
            .as_array()
            .map_or(false, |a| a.contains(&json!("other"))));
    }

    #[test]
    fn extract_highlights_collects_inner_hits() {
        let hit = json!({
            "_id": "1",
            "_source": { "article_id": 1 },
            "inner_hits": {
                "title": { "hits": { "hits": [
                    { "highlight": { "title.value": ["<em>篮球</em>教学"] } }
                ]}}
            }
        });
        let flat = flatten_hit(&hit);
        assert_eq!(flat["_highlights"]["title.value"][0], "<em>篮球</em>教学");
        assert_eq!(flat["article_id"], 1);
    }

    #[test]
    fn search_q_empty_string_is_ignored() {
        let r = req(r#"{"q": "   "}"#);
        let q = build_search_query(&r).unwrap();
        assert_eq!(q, json!({ "query": { "match_all": {} } }));
    }

    #[test]
    fn search_unknown_operator_returns_error() {
        let r = req(r#"{"where": {"x": {"bogus": 1}}}"#);
        let err = build_search_query(&r).unwrap_err();
        match err {
            AppError::InvalidQuery(msg) => assert!(msg.contains("bogus")),
            _ => panic!("expected InvalidQuery"),
        }
    }

    #[test]
    fn search_in_must_be_array() {
        let r = req(r#"{"where": {"x": {"in": "not-array"}}}"#);
        let err = build_search_query(&r).unwrap_err();
        match err {
            AppError::InvalidQuery(msg) => assert!(msg.contains("in 必须是数组")),
            _ => panic!("expected InvalidQuery"),
        }
    }

    #[test]
    fn sort_translation() {
        let r = req(r#"{"sort": [{"field": "created_at", "order": "desc"}, {"field": "name"}]}"#);
        let s = build_sort(&r).unwrap();
        assert_eq!(
            s,
            json!([
                { "created_at": { "order": "desc" } },
                { "name": { "order": "asc" } }
            ])
        );
    }

    #[test]
    fn bulk_ndjson_index_create() {
        let req = BulkRequest {
            operations: vec![
                BulkOp {
                    action: "index".into(),
                    id: Some("1".into()),
                    doc: Some(json!({ "name": "a" })),
                    upsert: None,
                },
                BulkOp {
                    action: "create".into(),
                    id: None,
                    doc: Some(json!({ "name": "b" })),
                    upsert: None,
                },
            ],
        };
        let nd = build_bulk_ndjson("orders", &req).unwrap();
        let lines: Vec<&str> = nd.split('\n').collect();
        // 每个 index/create 都是两行 + 末尾空行
        assert_eq!(lines.len(), 5);
        assert!(lines[0].contains("\"_index\":\"orders\""));
        assert!(lines[0].contains("\"_id\":\"1\""));
        assert!(lines[1].contains("\"name\":\"a\""));
        assert!(lines[2].contains("\"create\""));
        // create 无 id 时 header 里不应出现 _id
        assert!(!lines[2].contains("_id"));
        assert!(lines[3].contains("\"name\":\"b\""));
    }

    #[test]
    fn bulk_ndjson_update_with_upsert() {
        let req = BulkRequest {
            operations: vec![BulkOp {
                action: "update".into(),
                id: Some("k1".into()),
                doc: Some(json!({ "status": "x" })),
                upsert: Some(true),
            }],
        };
        let nd = build_bulk_ndjson("t", &req).unwrap();
        assert!(nd.contains("\"update\""));
        assert!(nd.contains("\"doc_as_upsert\":true"));
        assert!(nd.contains("\"status\":\"x\""));
    }

    #[test]
    fn bulk_ndjson_delete_only_one_line() {
        let req = BulkRequest {
            operations: vec![BulkOp {
                action: "delete".into(),
                id: Some("9".into()),
                doc: None,
                upsert: None,
            }],
        };
        let nd = build_bulk_ndjson("t", &req).unwrap();
        let lines: Vec<&str> = nd.split('\n').filter(|l| !l.is_empty()).collect();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("\"delete\""));
        assert!(lines[0].contains("\"_id\":\"9\""));
    }

    #[test]
    fn bulk_rejects_missing_doc() {
        let req = BulkRequest {
            operations: vec![BulkOp {
                action: "index".into(),
                id: Some("1".into()),
                doc: None,
                upsert: None,
            }],
        };
        let err = build_bulk_ndjson("t", &req).unwrap_err();
        match err {
            AppError::InvalidQuery(m) => assert!(m.contains("doc")),
            _ => panic!(),
        }
    }

    #[test]
    fn bulk_rejects_unknown_action() {
        let req = BulkRequest {
            operations: vec![BulkOp {
                action: "upsert".into(),
                id: Some("1".into()),
                doc: Some(json!({})),
                upsert: None,
            }],
        };
        let err = build_bulk_ndjson("t", &req).unwrap_err();
        match err {
            AppError::InvalidQuery(m) => assert!(m.contains("upsert")),
            _ => panic!(),
        }
    }

    #[test]
    fn simplify_bulk_item_ok_and_err() {
        let ok = json!({"index": {"_id": "1", "status": 201, "result": "created"}});
        let s = simplify_bulk_item(&ok);
        assert_eq!(s["action"], "index");
        assert_eq!(s["_id"], "1");
        assert_eq!(s["ok"], true);
        assert_eq!(s["status"], 201);

        let bad = json!({
            "update": {
                "_id": "x",
                "status": 409,
                "error": { "type": "version_conflict", "reason": "doc 已被改" }
            }
        });
        let s = simplify_bulk_item(&bad);
        assert_eq!(s["ok"], false);
        assert_eq!(s["error"], "doc 已被改");
    }

    #[test]
    fn normalize_settings_aliases() {
        let mut m = Map::new();
        m.insert("shards".into(), json!(3));
        m.insert("replicas".into(), json!(1));
        m.insert("refresh_interval".into(), json!("1s"));
        let out = normalize_settings(m);
        assert_eq!(out.get("number_of_shards"), Some(&json!(3)));
        assert_eq!(out.get("number_of_replicas"), Some(&json!(1)));
        // 未识别的 key 原样保留
        assert_eq!(out.get("refresh_interval"), Some(&json!("1s")));
    }

    #[test]
    fn flatten_hit_lifts_source_with_id() {
        let hit = json!({
            "_id": "abc",
            "_score": 1.5,
            "_source": { "name": "A", "amount": 10 }
        });
        let flat = flatten_hit(&hit);
        assert_eq!(flat["_id"], "abc");
        assert_eq!(flat["_score"], 1.5);
        assert_eq!(flat["name"], "A");
        assert_eq!(flat["amount"], 10);
    }

    #[test]
    fn url_encode_id_escapes_special_chars() {
        assert_eq!(url_encode_id("a/b c"), "a%2Fb%20c");
        assert_eq!(url_encode_id("abc-123"), "abc%2D123");
    }

    #[test]
    fn exact_boost_fields_adds_should_clauses() {
        let r = req(
            r#"{"q": "A", "q_fields": ["title", "content"], "exact_boost_fields": ["title^10"]}"#,
        );
        let q = build_search_query(&r).unwrap();
        // must 仍然存在（必须命中）
        assert!(q["query"]["bool"]["must"].as_array().is_some());
        // should 有两条：match_phrase + term on .keyword
        let should = q["query"]["bool"]["should"].as_array().unwrap();
        assert_eq!(should.len(), 2);
        assert!(should
            .iter()
            .any(|c| c["match_phrase"]["title"]["query"] == "A"
                && c["match_phrase"]["title"]["boost"] == 10.0));
        assert!(should
            .iter()
            .any(|c| c["term"]["title.keyword"]["value"] == "A"
                && c["term"]["title.keyword"]["boost"] == 20.0));
    }

    #[test]
    fn exact_boost_fields_no_boost_suffix_defaults_to_1() {
        let r = req(r#"{"q": "hello", "exact_boost_fields": ["title"]}"#);
        let q = build_search_query(&r).unwrap();
        let should = q["query"]["bool"]["should"].as_array().unwrap();
        assert!(should
            .iter()
            .any(|c| c["match_phrase"]["title"]["boost"] == 1.0));
        assert!(should
            .iter()
            .any(|c| c["term"]["title.keyword"]["boost"] == 2.0));
    }

    #[test]
    fn exact_boost_fields_empty_q_no_should() {
        let r = req(r#"{"q": "  ", "exact_boost_fields": ["title^5"]}"#);
        let q = build_search_query(&r).unwrap();
        // q 为空白 → match_all，不应有 should
        assert_eq!(q, json!({ "query": { "match_all": {} } }));
    }

    #[test]
    fn parse_field_boost_with_and_without_caret() {
        assert_eq!(parse_field_boost("title^5"), ("title".to_string(), 5.0));
        assert_eq!(
            parse_field_boost("content^2.5"),
            ("content".to_string(), 2.5)
        );
        assert_eq!(parse_field_boost("body"), ("body".to_string(), 1.0));
        assert_eq!(parse_field_boost("x^bad"), ("x".to_string(), 1.0));
    }

    #[test]
    fn es_error_message_extracts_reason() {
        let body = json!({"error": {"type": "x", "reason": "ouch"}});
        assert_eq!(es_error_message(&body), Some("ouch".into()));
        let body2 = json!({"error": "stringly"});
        assert_eq!(es_error_message(&body2), Some("stringly".into()));
        let body3 = json!({"ok": true});
        assert_eq!(es_error_message(&body3), None);
    }
}
