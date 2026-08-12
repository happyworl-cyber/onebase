//! Kafka 访问令牌工具 + ops / topic ACL。
//!
//! Token 格式：`obes_kafka_<43 字符 base64url>`（避免被 `ob_` API Key 中间件误判）。

use sha2::{Digest, Sha256};

use crate::error::AppError;

pub const TOKEN_PREFIX: &str = "obes_kafka_";

pub const DEFAULT_OPS: &[&str] = &["produce", "list_topics", "health"];

/// 生成明文 token（仅创建时返回一次）。
pub fn generate_token() -> String {
    use base64::Engine as _;
    use rand::RngCore;
    let mut buf = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    let body = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf);
    format!("{TOKEN_PREFIX}{body}")
}

pub fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn token_prefix(token: &str) -> String {
    token.chars().take(16).collect()
}

/// 从 Authorization / X-Kafka-Token 提取明文。
pub fn extract_token(headers: &axum::http::HeaderMap) -> Option<String> {
    if let Some(val) = headers.get("authorization").and_then(|v| v.to_str().ok()) {
        let v = val.trim();
        for prefix in ["ApiKey ", "Bearer ", "ApiKey  ", "Bearer  "] {
            if let Some(rest) = v.strip_prefix(prefix) {
                let t = rest.trim();
                if t.starts_with(TOKEN_PREFIX) {
                    return Some(t.to_string());
                }
            }
        }
        if v.starts_with(TOKEN_PREFIX) {
            return Some(v.to_string());
        }
    }
    if let Some(val) = headers.get("x-kafka-token").and_then(|v| v.to_str().ok()) {
        let t = val.trim();
        if t.starts_with(TOKEN_PREFIX) {
            return Some(t.to_string());
        }
    }
    None
}

pub fn op_allowed(op: &str, allowed_ops: &[String]) -> Result<(), AppError> {
    let op = op.trim().to_ascii_lowercase();
    if allowed_ops
        .iter()
        .any(|o| o.trim().eq_ignore_ascii_case(&op))
    {
        Ok(())
    } else {
        Err(AppError::Forbidden(format!(
            "令牌不允许操作 `{op}`（allowed_ops={allowed_ops:?}）"
        )))
    }
}

pub fn topic_allowed(topic: &str, topic_allowlist: &[String]) -> Result<(), AppError> {
    if topic_allowlist.iter().any(|p| p == "*") {
        return Ok(());
    }
    if topic_allowlist.iter().any(|pat| glob_match(pat, topic)) {
        Ok(())
    } else {
        Err(AppError::Forbidden(format!(
            "topic `{topic}` 不在令牌白名单内（topic_allowlist={topic_allowlist:?}）"
        )))
    }
}

/// 简单 glob：`*` 匹配任意串，`?` 匹配单字符；`.` 按字面匹配。
pub fn glob_match(pattern: &str, candidate: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let c: Vec<char> = candidate.chars().collect();
    fn rec(p: &[char], c: &[char]) -> bool {
        match (p.first(), c.first()) {
            (None, None) => true,
            (Some('*'), _) => {
                // * 吃掉 0..n 个字符
                for i in 0..=c.len() {
                    if rec(&p[1..], &c[i..]) {
                        return true;
                    }
                }
                false
            }
            (Some('?'), Some(_)) => rec(&p[1..], &c[1..]),
            (Some(a), Some(b)) if a == b => rec(&p[1..], &c[1..]),
            _ => false,
        }
    }
    rec(&p, &c)
}

pub fn validate_ops(ops: &[String]) -> Result<(), AppError> {
    if ops.is_empty() {
        return Err(AppError::InvalidQuery(
            "allowed_ops 至少要有一项".to_string(),
        ));
    }
    for op in ops {
        let o = op.trim().to_ascii_lowercase();
        if !DEFAULT_OPS.contains(&o.as_str()) {
            return Err(AppError::InvalidQuery(format!(
                "不支持的 op `{op}`（支持：{}）",
                DEFAULT_OPS.join(", ")
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;

    #[test]
    fn generate_token_has_prefix() {
        let t = generate_token();
        assert!(t.starts_with(TOKEN_PREFIX));
        assert_eq!(hash_token(&t).len(), 64);
        assert!(token_prefix(&t).starts_with("obes_kafka_"));
    }

    #[test]
    fn extract_api_key_and_x_header() {
        let mut h = HeaderMap::new();
        h.insert("authorization", "ApiKey obes_kafka_abc".parse().unwrap());
        assert_eq!(extract_token(&h).as_deref(), Some("obes_kafka_abc"));

        let mut h2 = HeaderMap::new();
        h2.insert("x-kafka-token", "obes_kafka_xyz".parse().unwrap());
        assert_eq!(extract_token(&h2).as_deref(), Some("obes_kafka_xyz"));
    }

    #[test]
    fn op_and_topic_acl() {
        let ops = vec!["produce".into(), "health".into()];
        assert!(op_allowed("produce", &ops).is_ok());
        assert!(op_allowed("list_topics", &ops).is_err());

        let topics = vec!["orders-*".into(), "events".into()];
        assert!(topic_allowed("orders-1", &topics).is_ok());
        assert!(topic_allowed("events", &topics).is_ok());
        assert!(topic_allowed("audit", &topics).is_err());
        assert!(topic_allowed("anything", &["*".into()]).is_ok());
    }

    #[test]
    fn glob_basics() {
        assert!(glob_match("*", "x"));
        assert!(glob_match("logs-*", "logs-2024"));
        assert!(!glob_match("logs-*", "audit-2024"));
        assert!(glob_match("event-?", "event-1"));
        assert!(!glob_match("event-?", "event-12"));
    }
}
