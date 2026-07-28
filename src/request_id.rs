//! `X-Request-Id` 中间件：每条 HTTP 请求绑一个稳定 ID，贯穿日志 / 响应头。
//!
//! 行为：
//! 1. 进来的请求若已经带 `X-Request-Id` 头（且值"长得像合理 ID"，见
//!    [`looks_like_request_id`]），直接复用——便于网关 / 调用方在多服务间传链路；
//! 2. 否则现场生成一个 UUID v4；
//! 3. 用 [`crate::logging::REQUEST_ID`] task_local 把 ID 注入到本请求 future 上下文，
//!    内部所有 `tracing::info!` / `error!` 经 `JsonLogFormatter` 都会自动带上；
//! 4. 在响应头里**回写**这个 ID，方便前端 / 网关回收到错误时贴给后端定位问题。
//!
//! 安装位置：在 axum router 的**最外层**包一层 `axum::middleware::from_fn(...)`，
//! 让所有下游 handler / 中间件都跑在 REQUEST_ID 的 scope 里。

use axum::{
    extract::Request,
    http::{HeaderName, HeaderValue},
    middleware::Next,
    response::Response,
};
use uuid::Uuid;

use crate::logging::REQUEST_ID;

/// 拿当前请求的 `x-request-id`；没有就 `None`（启动 / 非请求上下文）。
///
/// 主要用法：在 handler 把 ID 复制到 spawn future 之前先 capture 出来，
/// 因为 `tokio::task_local` 不会自动跨 `tokio::spawn`。
pub fn current() -> Option<String> {
    REQUEST_ID.try_with(|s| s.clone()).ok().filter(|s| !s.is_empty())
}

/// 把一个 future 在指定 `request_id` 下跑（或没 ID 时直接 await）。
///
/// 这是给跨 `tokio::spawn` 边界手工传递 request_id 用的封装：调用方在还在请求
/// 上下文时先 [`current()`] 拿到 ID，然后 `tokio::spawn(scope_with(id, fut))`，
/// spawn 出来的后台任务就能继续在日志里关联到原请求。
pub async fn scope_with<F: std::future::Future>(req_id: Option<String>, fut: F) -> F::Output {
    match req_id {
        Some(id) => REQUEST_ID.scope(id, fut).await,
        None => fut.await,
    }
}

pub const REQUEST_ID_HEADER: HeaderName = HeaderName::from_static("x-request-id");

pub async fn request_id_middleware(req: Request, next: Next) -> Response {
    // 1) 选 ID：上游传的 + 校验通过 → 复用；否则现场生成。
    let incoming = req
        .headers()
        .get(&REQUEST_ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| looks_like_request_id(s))
        .map(String::from);
    let req_id = incoming.unwrap_or_else(|| Uuid::new_v4().to_string());

    // 2) clone 一份给响应头用（下面把原值 move 给 task_local scope）。
    let echo = req_id.clone();

    // 3) scope 包 future：scope 内所有 tracing event 都能从 task_local 拿到 ID。
    let mut response = REQUEST_ID.scope(req_id, next.run(req)).await;

    // 4) 回写响应头。理论上 from_str 失败需要 ID 含非法 char，UUID v4 不可能；
    //    上游传的我们用 looks_like_request_id 限制了字符集，也安全。万一失败就跳过。
    if let Ok(v) = HeaderValue::from_str(&echo) {
        response.headers_mut().insert(REQUEST_ID_HEADER, v);
    }
    response
}

/// 简单校验：长度 8~128，仅允许 ASCII 字母数字 + `-` / `_`。
/// 拦住"上游传个奇怪 binary / 巨长字符串污染日志"的情况，同时兼容 UUID / KSUID /
/// 自研短 ID 等常见形态。失败时上层 fallback 重新生成 UUID v4。
fn looks_like_request_id(s: &str) -> bool {
    let len = s.len();
    if !(8..=128).contains(&len) {
        return false;
    }
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_uuid_v4() {
        assert!(looks_like_request_id("98753d7e-3bdb-4c00-bcf7-4a697606b88b"));
    }

    #[test]
    fn accepts_short_alnum_id() {
        assert!(looks_like_request_id("abc12345"));
    }

    #[test]
    fn rejects_too_short() {
        assert!(!looks_like_request_id("short"));
    }

    #[test]
    fn rejects_special_chars() {
        assert!(!looks_like_request_id("aaa$bbb_ccc"));
        assert!(!looks_like_request_id("with space xxx"));
    }

    #[test]
    fn rejects_too_long() {
        let s = "a".repeat(200);
        assert!(!looks_like_request_id(&s));
    }
}
