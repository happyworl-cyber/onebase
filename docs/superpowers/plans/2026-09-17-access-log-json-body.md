# access log JSON 请求体 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** POST/PUT/PATCH 的 JSON body 脱敏截断后写入 `access_log.request_body`，云日志用业务 uid 全文短语能命中该次 HTTP 的 access 行。

**Architecture:** 纯函数负责 Content-Type 判定、键名脱敏、UTF-8 截断。`request_id_middleware` 在 `next.run` 前把 body 读出再塞回 Request，把准备好的字符串传给现有 `emit_access_log`。不新增中间件层，不改云日志检索。

**Tech Stack:** Rust, axum 0.7, serde_json, tracing。测试：`cargo test --bin onebase`。

**Spec:** `docs/superpowers/specs/2026-09-17-access-log-json-body-design.md`

## Global Constraints

- Do not create git commits unless the user explicitly asks. Keep Commit steps but skip them until asked.
- Do not modify cloud-logs frontend, `compose_sls_query`, `workflow_runs`, or execution 记录列表.
- Do not log GET, query string, multipart, non-JSON, response body, or custom headers such as `#req_id`.
- Do not reuse `workflow_qa::redact_value` (32-bit hex rule would clobber ids).
- Sensitive keys: case-insensitive exact match OR suffix `_{name}` for `password` / `token` / `secret` / `authorization` / `api_key` / `access_key` / `cookie`. Not substring (do not treat `token_count` as secret).
- Log copy max **4096 bytes** at UTF-8 char boundary; handler still receives the full original body.
- Read/parse/redact failure: omit `request_body` only; do not 500; do not drop other access_log fields.
- `request_id.rs` is bin-only. Run tests with `cargo test --bin onebase <filter>`.

---

## File Structure

| Path | Responsibility |
|------|----------------|
| `src/access_log_body.rs` | `should_capture_json_body` / `is_json_content_type` / `is_sensitive_key` / `redact_json` / `truncate_utf8_bytes` / `prepare_request_body_for_log` |
| `src/main.rs` | `mod access_log_body;` |
| `src/request_id.rs` | `copy_request_body`；中间件缓冲；`emit_access_log` 增加可选 `request_body` |

---

### Task 1: JSON body 日志纯函数

**Files:**
- Create: `src/access_log_body.rs`
- Modify: `src/main.rs`（在 `mod request_id;` 上一行加 `mod access_log_body;`）

**Interfaces:**
- Consumes: raw body bytes、`Method`、Content-Type 字符串
- Produces:
  - `pub const REQUEST_BODY_LOG_MAX_BYTES: usize = 4096;`
  - `pub fn is_json_content_type(ct: &str) -> bool`
  - `pub fn should_capture_json_body(method: &axum::http::Method, content_type: Option<&str>) -> bool`
  - `pub fn is_sensitive_key(key: &str) -> bool`
  - `pub fn redact_json(value: serde_json::Value) -> serde_json::Value`
  - `pub fn truncate_utf8_bytes(s: &str, max_bytes: usize) -> String`
  - `pub fn prepare_request_body_for_log(raw: &[u8]) -> Option<String>`

- [ ] **Step 1: Write the failing tests**

Create `src/access_log_body.rs` with tests first and empty/unimplemented functions so it compiles but tests fail — actually TDD: write tests that call the functions. Put functions as `todo!()` so the file compiles and tests panic, or omit functions so it does not compile (that counts as fail). Prefer real signatures + `todo!()`:

```rust
//! access_log 用的 JSON body 副本：判定、脱敏、截断。不读 Request，方便单测。

use axum::http::Method;
use serde_json::Value;

pub const REQUEST_BODY_LOG_MAX_BYTES: usize = 4096;

pub fn is_json_content_type(ct: &str) -> bool {
    todo!()
}

pub fn should_capture_json_body(method: &Method, content_type: Option<&str>) -> bool {
    todo!()
}

pub fn is_sensitive_key(key: &str) -> bool {
    todo!()
}

pub fn redact_json(value: Value) -> Value {
    todo!()
}

pub fn truncate_utf8_bytes(s: &str, max_bytes: usize) -> String {
    todo!()
}

pub fn prepare_request_body_for_log(raw: &[u8]) -> Option<String> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_content_type_accepts_charset() {
        assert!(is_json_content_type("application/json"));
        assert!(is_json_content_type("application/json; charset=utf-8"));
        assert!(is_json_content_type("Application/JSON; charset=UTF-8"));
        assert!(!is_json_content_type("text/plain"));
        assert!(!is_json_content_type("multipart/form-data"));
        assert!(!is_json_content_type("application/jsonp"));
    }

    #[test]
    fn capture_only_json_writes() {
        assert!(should_capture_json_body(
            &Method::POST,
            Some("application/json; charset=utf-8")
        ));
        assert!(should_capture_json_body(&Method::PUT, Some("application/json")));
        assert!(should_capture_json_body(&Method::PATCH, Some("application/json")));
        assert!(!should_capture_json_body(&Method::GET, Some("application/json")));
        assert!(!should_capture_json_body(&Method::DELETE, Some("application/json")));
        assert!(!should_capture_json_body(&Method::POST, Some("text/plain")));
        assert!(!should_capture_json_body(&Method::POST, None));
        assert!(!should_capture_json_body(
            &Method::POST,
            Some("multipart/form-data")
        ));
    }

    #[test]
    fn sensitive_keys_exact_or_underscore_suffix() {
        assert!(is_sensitive_key("password"));
        assert!(is_sensitive_key("Token"));
        assert!(is_sensitive_key("smtp_password"));
        assert!(is_sensitive_key("client_secret"));
        assert!(is_sensitive_key("access_token"));
        assert!(is_sensitive_key("api_key"));
        assert!(is_sensitive_key("access_key"));
        assert!(is_sensitive_key("cookie"));
        assert!(is_sensitive_key("authorization"));
        assert!(!is_sensitive_key("token_count"));
        assert!(!is_sensitive_key("uids"));
        assert!(!is_sensitive_key("project_id"));
    }

    #[test]
    fn prepare_keeps_business_uid_and_redacts_secrets() {
        let raw = serde_json::to_vec(&json!({
            "project_id": "1",
            "uids": ["M69D9AHN", "15107269003108"],
            "password": "super-secret",
            "nested": { "smtp_password": "mail-pass", "token_count": 3 }
        }))
        .unwrap();
        let out = prepare_request_body_for_log(&raw).expect("json");
        assert!(out.contains("15107269003108"), "{out}");
        assert!(!out.contains("super-secret"), "{out}");
        assert!(!out.contains("mail-pass"), "{out}");
        assert!(out.contains("\"password\":\"***\"") || out.contains("\"password\": \"***\""), "{out}");
        assert!(out.contains("token_count"), "{out}");
        assert!(out.contains('3'), "{out}");
    }

    #[test]
    fn prepare_rejects_invalid_json() {
        assert!(prepare_request_body_for_log(b"not-json").is_none());
        assert!(prepare_request_body_for_log(b"").is_none());
    }

    #[test]
    fn truncate_utf8_does_not_split_char() {
        let s = "é".repeat(10);
        let cut = truncate_utf8_bytes(&s, 3);
        assert!(cut.len() <= 3);
        assert!(cut.is_char_boundary(cut.len()));
    }

    #[test]
    fn prepare_truncates_over_4kb() {
        let big = "x".repeat(REQUEST_BODY_LOG_MAX_BYTES + 100);
        let raw = serde_json::to_vec(&json!({ "blob": big })).unwrap();
        let out = prepare_request_body_for_log(&raw).unwrap();
        assert!(out.len() <= REQUEST_BODY_LOG_MAX_BYTES);
        assert!(out.is_char_boundary(out.len()));
    }
}
```

In `src/main.rs` immediately above `mod request_id;`:

```rust
mod access_log_body;
mod request_id;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --bin onebase access_log_body -- --nocapture`

Expected: FAIL / panic at `todo!()` (or compile error if Step 1 skipped the stubs)

- [ ] **Step 3: Write minimal implementation**

Replace `todo!()` bodies in `src/access_log_body.rs` with:

```rust
pub fn is_json_content_type(ct: &str) -> bool {
    ct.split(';')
        .next()
        .map(|t| t.trim().eq_ignore_ascii_case("application/json"))
        .unwrap_or(false)
}

pub fn should_capture_json_body(method: &Method, content_type: Option<&str>) -> bool {
    matches!(*method, Method::POST | Method::PUT | Method::PATCH)
        && content_type.map(is_json_content_type).unwrap_or(false)
}

pub fn is_sensitive_key(key: &str) -> bool {
    const KEYS: &[&str] = &[
        "password",
        "token",
        "secret",
        "authorization",
        "api_key",
        "access_key",
        "cookie",
    ];
    let k = key.to_ascii_lowercase();
    KEYS.iter()
        .any(|n| k == *n || k.ends_with(&format!("_{n}")))
}

pub fn redact_json(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                if is_sensitive_key(&k) {
                    out.insert(k, Value::String("***".into()));
                } else {
                    out.insert(k, redact_json(v));
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(redact_json).collect()),
        other => other,
    }
}

pub fn truncate_utf8_bytes(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

pub fn prepare_request_body_for_log(raw: &[u8]) -> Option<String> {
    let parsed: Value = serde_json::from_slice(raw).ok()?;
    let text = redact_json(parsed).to_string();
    Some(truncate_utf8_bytes(&text, REQUEST_BODY_LOG_MAX_BYTES))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --bin onebase access_log_body -- --nocapture`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/access_log_body.rs src/main.rs
git commit -m "feat: access log JSON body 脱敏截断纯函数。"
```

Skip until asked.

---

### Task 2: 中间件缓冲 body 并写入 access_log

**Files:**
- Modify: `src/request_id.rs`（`request_id_middleware`、`emit_access_log`、`#[cfg(test)]`）

**Interfaces:**
- Consumes: `crate::access_log_body::{should_capture_json_body, prepare_request_body_for_log}`
- Produces:
  - `async fn copy_request_body(req: &mut Request) -> Option<bytes::Bytes>`
  - `fn emit_access_log(..., request_body: Option<&str>)`
  - middleware: JSON 写请求的 access_log 带 `request_body`；handler 仍读到完整原 body

- [ ] **Step 1: Write the failing tests**

Add to `src/request_id.rs` `mod tests` (need `use axum::body::{Body, to_bytes};`):

```rust
    #[tokio::test]
    async fn copy_request_body_restores_full_bytes() {
        let payload = vec![b'x'; 5000];
        let mut req = Request::builder()
            .method("POST")
            .header("content-type", "application/json")
            .body(Body::from(payload.clone()))
            .unwrap();
        let copied = copy_request_body(&mut req).await.expect("copy");
        assert_eq!(copied.as_ref(), payload.as_slice());
        let restored = to_bytes(req.into_body(), usize::MAX).await.unwrap();
        assert_eq!(restored.as_ref(), payload.as_slice());
    }
```

`copy_request_body` does not exist yet → compile fail / FAIL.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --bin onebase copy_request_body_restores_full_bytes -- --nocapture`

Expected: FAIL（`copy_request_body` 未定义）

- [ ] **Step 3: Write minimal implementation**

At top of `src/request_id.rs`, extend imports:

```rust
use axum::{
    body::{Body, to_bytes},
    extract::Request,
    http::{header, HeaderName, HeaderValue, Method},
    middleware::Next,
    response::Response,
};
use bytes::Bytes;

use crate::access_log_body::{prepare_request_body_for_log, should_capture_json_body};
```

Add:

```rust
async fn copy_request_body(req: &mut Request) -> Option<Bytes> {
    let body = std::mem::replace(req.body_mut(), Body::empty());
    match to_bytes(body, usize::MAX).await {
        Ok(bytes) => {
            *req.body_mut() = Body::from(bytes.clone());
            Some(bytes)
        }
        Err(_) => None,
    }
}
```

Change signature to `pub async fn request_id_middleware(mut req: Request, next: Next)` and **before** the `REQUEST_ID.scope` block:

```rust
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let start = Instant::now();

    let ct = req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .map(str::to_string);
    let request_body_log = if should_capture_json_body(&method, ct.as_deref()) {
        match copy_request_body(&mut req).await {
            Some(bytes) => prepare_request_body_for_log(&bytes),
            None => None,
        }
    } else {
        None
    };

    let mut response = REQUEST_ID
        .scope(req_id, async move {
            let response = next.run(req).await;
            let status = response.status().as_u16();
            let elapsed_ms = start.elapsed().as_millis() as u64;
            let user_id = response
                .extensions()
                .get::<AccessLogUser>()
                .map(|u| u.0)
                .unwrap_or(-1);
            emit_access_log(
                &method,
                &path,
                status,
                elapsed_ms,
                user_id,
                request_body_log.as_deref(),
            );
            response
        })
        .await;
```

Replace `emit_access_log` with:

```rust
fn emit_access_log(
    method: &Method,
    path: &str,
    status: u16,
    elapsed_ms: u64,
    user_id: i32,
    request_body: Option<&str>,
) {
    if *method == Method::OPTIONS {
        tracing::debug!(
            target: "access_log",
            method = %method,
            path = %path,
            status = status,
            elapsed_ms = elapsed_ms,
            user_id = user_id,
            "HTTP request completed"
        );
        return;
    }
    if let Some(request_body) = request_body {
        tracing::info!(
            target: "access_log",
            method = %method,
            path = %path,
            status = status,
            elapsed_ms = elapsed_ms,
            user_id = user_id,
            request_body = %request_body,
            "HTTP request completed"
        );
    } else {
        tracing::info!(
            target: "access_log",
            method = %method,
            path = %path,
            status = status,
            elapsed_ms = elapsed_ms,
            user_id = user_id,
            "HTTP request completed"
        );
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```
cargo test --bin onebase copy_request_body_restores_full_bytes -- --nocapture
cargo test --bin onebase access_log_body -- --nocapture
cargo test --bin onebase request_id:: -- --nocapture
```

Expected: all PASS. GET/非法 JSON 路径不读或 `prepare` 返回 None，access log 无 `request_body` 字段。

- [ ] **Step 5: Commit**

```bash
git add src/request_id.rs src/access_log_body.rs src/main.rs docs/superpowers/specs/2026-09-17-access-log-json-body-design.md
git commit -m "feat: POST JSON 请求体脱敏后写入 access_log，便于按业务 uid 检索。"
```

In the spec header, set `状态：已通过`. Skip commit until asked.

---

## Spec coverage (self-review)

| Spec | Task |
|------|------|
| POST/PUT/PATCH + `application/json`（含 charset） | Task 1 `should_capture_json_body` / `is_json_content_type` |
| 不记 GET / multipart / 非 JSON / 空或非法 JSON | Task 1 tests + Task 2 不 capture 则不 copy |
| `request_body` 字符串进 access_log 根 | Task 2 `emit_access_log` |
| 键名脱敏 + `_password` 后缀；不伤 `token_count` / uid | Task 1 `is_sensitive_key` / `prepare_keeps_business_uid` |
| 不复用 workflow_qa hex 脱敏 | Task 1 自写 `redact_json` |
| 日志副本 4KB UTF-8 截断；handler 完整 body | Task 1 truncate + Task 2 `copy_request_body_restores_full_bytes` |
| 失败不 500 | Task 1 `prepare` → None；Task 2 copy Err → None |
| 云日志 UI / compose_sls_query | 不改（Global） |
| `#req_id` / 响应 body / workflow_runs | 不改（Global） |
