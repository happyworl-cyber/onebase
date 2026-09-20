//! access_log 用的 JSON body 副本：判定、脱敏、截断。不读 Request，方便单测。

use axum::http::Method;
use serde_json::Value;

pub const REQUEST_BODY_LOG_MAX_BYTES: usize = 4096;
/// 只为日志复制较小的 JSON 请求体。更大的请求保持流式透传，避免日志功能放大内存占用。
pub const REQUEST_BODY_CAPTURE_MAX_BYTES: usize = 64 * 1024;

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
    // 同时覆盖 snake_case、kebab-case 和 camelCase（转小写后如 clientSecret）。
    let compact: String = key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    if compact == "tokencount" {
        return false;
    }
    [
        "password",
        "passwd",
        "secret",
        "token",
        "authorization",
        "apikey",
        "accesskey",
        "privatekey",
        "cookie",
        "credential",
        "sessionid",
        "csrf",
    ]
    .iter()
    .any(|needle| compact.contains(needle))
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
        assert!(should_capture_json_body(
            &Method::PUT,
            Some("application/json")
        ));
        assert!(should_capture_json_body(
            &Method::PATCH,
            Some("application/json")
        ));
        assert!(!should_capture_json_body(
            &Method::GET,
            Some("application/json")
        ));
        assert!(!should_capture_json_body(
            &Method::DELETE,
            Some("application/json")
        ));
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
        assert!(is_sensitive_key("passwordConfirmation"));
        assert!(is_sensitive_key("client_secret"));
        assert!(is_sensitive_key("clientSecret"));
        assert!(is_sensitive_key("access_token"));
        assert!(is_sensitive_key("accessToken"));
        assert!(is_sensitive_key("api_key"));
        assert!(is_sensitive_key("apiKey"));
        assert!(is_sensitive_key("access_key"));
        assert!(is_sensitive_key("privateKey"));
        assert!(is_sensitive_key("credential_id"));
        assert!(is_sensitive_key("session_id"));
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
        assert!(
            out.contains("\"password\":\"***\"") || out.contains("\"password\": \"***\""),
            "{out}"
        );
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
