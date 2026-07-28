//! ES 反向代理核心：把 `/api/es/*es_path` 流式透传到 `es_connections.base_url`。
//!
//! ## 请求生命周期
//!
//! 1. [`proxy_common::resolve_token`]：抽 token、JOIN connection、校状态/过期
//! 2. [`proxy_common::enforce_full_access`]：method / path_denylist / index_allowlist 三层
//! 3. 解密凭据 → 装 `Authorization` 头
//! 4. 复制部分客户端 header（白名单），剥掉 hop-by-hop 与 platform 内部头
//! 5. `reqwest` 发请求，response body **流式**回灌
//! 6. [`proxy_common::spawn_usage_update`] 异步更新统计（fire-and-forget）
//!
//! 鉴权 / 客户端 / 统计公用部分在 [`proxy_common`]；这里只剩 axum ↔ reqwest 桥接
//! 与 header 过滤这两件代理特有的工作。

use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri},
    response::Response,
};
// NOTE: axum 0.7 用 http 1.x，reqwest 0.11 用 http 0.2 —— **两份不同的 crate**。
// 所有 Method / HeaderMap / StatusCode 跨边界时必须显式转一遍，类型同名不同源。
//
// 这里给 reqwest 侧起别名，让代码里"哪边的"一目了然；避免 `use reqwest::Method;`
// 和 `axum::http::Method` 直接冲突。
use reqwest::header::{
    HeaderMap as ReqHeaderMap, HeaderName as ReqHeaderName, HeaderValue as ReqHeaderValue,
};
use reqwest::Method as ReqMethod;
use sqlx::PgPool;

use crate::error::AppError;
use crate::es::admin_handlers::build_auth_header;
use crate::es::proxy_common;

/// 主入口：`/api/es/*es_path`。`Path` 抽出来的 `es_path` 不含开头 `/`，需要补上。
pub async fn proxy(
    State(pool): State<PgPool>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    Path(es_path): Path<String>,
    body: axum::body::Bytes,
) -> Result<Response, AppError> {
    let token = proxy_common::resolve_token(&pool, &headers).await?;

    let path_normalized = if es_path.starts_with('/') {
        es_path.clone()
    } else {
        format!("/{}", es_path)
    };
    proxy_common::enforce_full_access(&token, method.as_str(), &path_normalized)?;

    let auth_header = build_auth_header(&token.connection)?;
    let client = proxy_common::pick_client(token.connection.verify_tls);

    // 拼上游 URL（保留 query string；不 URL-encode 已编码过的 path）
    let upstream_url =
        proxy_common::build_upstream_url(&token.connection.base_url, &path_normalized, uri.query());

    // axum http 1.x → reqwest http 0.2 桥接
    let req_method = ReqMethod::from_bytes(method.as_str().as_bytes())
        .map_err(|e| AppError::InvalidQuery(format!("非法 HTTP method `{}`: {}", method, e)))?;
    let mut upstream_req = client.request(req_method, &upstream_url).body(body);
    upstream_req = upstream_req.headers(filter_request_headers(&headers));
    if let Some(h) = auth_header {
        upstream_req = upstream_req.header("authorization", h);
    }

    // 发请求 + per-connection timeout
    let resp = match tokio::time::timeout(
        std::time::Duration::from_secs(token.timeout_secs),
        upstream_req.send(),
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

    proxy_common::spawn_usage_update(pool.clone(), token.token_id);

    // 把 reqwest::Response 流式塞回 axum::Response
    // reqwest::StatusCode（http 0.2）→ axum http 1.x StatusCode：走 u16 中转
    let upstream_status = resp.status();
    let status = StatusCode::from_u16(upstream_status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut response_builder = Response::builder().status(status);
    {
        let response_headers = response_builder
            .headers_mut()
            .expect("Response::builder 不应在还没被 ::body 消费前缺少 headers");
        for (k, v) in filter_response_headers(resp.headers()) {
            response_headers.insert(k, v);
        }
    }
    let stream = resp.bytes_stream();
    let body = Body::from_stream(stream);
    response_builder
        .body(body)
        .map_err(|e| AppError::Internal(format!("构造代理响应失败: {e}")))
}

// ── header 白/黑名单 ────────────────────────────────────────────────────

/// 客户端 → 上游：剥掉与代理身份 / 平台内部相关的头，保留 Content-Type / Accept 等
/// ES 必须的头 + 用户的 `X-Opaque-Id`（ES 用来在慢日志里关联请求）。
///
/// 返回 **reqwest 版本** 的 HeaderMap（http 0.2）；axum HeaderName 通过字节重建。
fn filter_request_headers(incoming: &HeaderMap) -> ReqHeaderMap {
    let mut out = ReqHeaderMap::with_capacity(incoming.len());
    for (k, v) in incoming.iter() {
        let name = k.as_str().to_ascii_lowercase();
        if REQUEST_HEADER_BLACKLIST.contains(&name.as_str()) {
            continue;
        }
        // axum http 1.x → reqwest http 0.2 桥接：走字节构造，避开同名不同源的 trait。
        if let (Ok(rn), Ok(rv)) = (
            ReqHeaderName::from_bytes(k.as_str().as_bytes()),
            ReqHeaderValue::from_bytes(v.as_bytes()),
        ) {
            out.insert(rn, rv);
        }
    }
    out
}

/// hop-by-hop（RFC 7230 §6.1）+ 我们自定义的内部头一律剥掉
const REQUEST_HEADER_BLACKLIST: &[&str] = &[
    "authorization",  // 由 build_auth_header 注入上游真凭据
    "host",           // reqwest 会自己根据 URL 设
    "content-length", // reqwest 自己算
    "cookie",         // ES 不需要；防 cookie 串味
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "x-database-id",   // 平台内部头
    "x-es-token",      // 代理 token，不要外发
    "x-forwarded-for", // 这里不主动构造，避免泄露内网拓扑；如需可在网关层另加
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
];

/// 上游 → 客户端：剥掉 hop-by-hop 头，避免 axum 序列化坏掉（`transfer-encoding: chunked`
/// 会让 hyper 拒绝；axum 自己处理 body）。也别透传 `content-length`，因为我们改成 streaming
/// 之后长度不可知。其它头照搬（包括 `content-type` —— ES 用 `application/json` /
/// `application/vnd.elasticsearch+json;compatible-with=8`）。
///
/// 返回 **axum 版本** 的 (HeaderName, HeaderValue) 对（http 1.x）；reqwest header
/// 通过字节重建。
fn filter_response_headers(upstream: &ReqHeaderMap) -> Vec<(HeaderName, HeaderValue)> {
    const BLACKLIST: &[&str] = &[
        "transfer-encoding",
        "content-length",
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "te",
        "trailer",
        "upgrade",
    ];
    let mut out = Vec::with_capacity(upstream.len());
    for (k, v) in upstream.iter() {
        let name = k.as_str().to_ascii_lowercase();
        if BLACKLIST.contains(&name.as_str()) {
            continue;
        }
        // reqwest http 0.2 → axum http 1.x 桥接：与请求方向同理，走字节构造。
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(k.as_str().as_bytes()),
            HeaderValue::from_bytes(v.as_bytes()),
        ) {
            out.push((name, val));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_header_blacklist() {
        use axum::http::HeaderValue;
        let mut h = HeaderMap::new();
        h.insert("authorization", HeaderValue::from_static("ApiKey leaked"));
        h.insert("content-type", HeaderValue::from_static("application/json"));
        h.insert("x-database-id", HeaderValue::from_static("9"));
        h.insert("x-opaque-id", HeaderValue::from_static("trace-1"));
        let out = filter_request_headers(&h);
        assert!(out.get("authorization").is_none());
        assert!(out.get("x-database-id").is_none());
        assert_eq!(
            out.get("content-type").unwrap().to_str().unwrap(),
            "application/json"
        );
        assert_eq!(out.get("x-opaque-id").unwrap().to_str().unwrap(), "trace-1");
    }

    #[test]
    fn response_header_blacklist() {
        let mut h = ReqHeaderMap::new();
        h.insert("content-type", ReqHeaderValue::from_static("application/json"));
        h.insert("transfer-encoding", ReqHeaderValue::from_static("chunked"));
        h.insert("content-length", ReqHeaderValue::from_static("12345"));
        let out = filter_response_headers(&h);
        let names: Vec<String> = out.iter().map(|(k, _)| k.as_str().to_string()).collect();
        assert!(names.contains(&"content-type".to_string()));
        assert!(!names.contains(&"transfer-encoding".to_string()));
        assert!(!names.contains(&"content-length".to_string()));
    }
}
