//! 对象存储访问令牌工具 + ops / object key ACL。
//!
//! Token 格式：`obes_os_<43 字符 base64url>`。

use sha2::{Digest, Sha256};

use crate::error::AppError;

pub const TOKEN_PREFIX: &str = "obes_os_";

pub const DEFAULT_OPS: &[&str] = &["put", "get", "delete", "list", "presign", "health"];

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

/// 从 Authorization / X-Os-Token / X-Object-Storage-Token 提取明文。
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
    for header_name in ["x-os-token", "x-object-storage-token"] {
        if let Some(val) = headers.get(header_name).and_then(|v| v.to_str().ok()) {
            let t = val.trim();
            if t.starts_with(TOKEN_PREFIX) {
                return Some(t.to_string());
            }
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

/// 对象 key 白名单：`*` 放行全部；否则按 glob 匹配（与 Kafka topic_allowlist 同款）。
pub fn key_allowed(key: &str, key_prefix_allowlist: &[String]) -> Result<(), AppError> {
    if key_prefix_allowlist.iter().any(|p| p == "*") {
        return Ok(());
    }
    if key_prefix_allowlist.iter().any(|pat| glob_match(pat, key)) {
        Ok(())
    } else {
        Err(AppError::Forbidden(format!(
            "对象 key `{key}` 不在令牌白名单内（key_prefix_allowlist={key_prefix_allowlist:?}）"
        )))
    }
}

/// 简单 glob：`*` 匹配任意串，`?` 匹配单字符。
pub fn glob_match(pattern: &str, candidate: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let c: Vec<char> = candidate.chars().collect();
    fn rec(p: &[char], c: &[char]) -> bool {
        match (p.first(), c.first()) {
            (None, None) => true,
            (Some('*'), _) => {
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

pub fn validate_key_prefix_allowlist(keys: &[String]) -> Result<(), AppError> {
    if keys.is_empty() {
        return Err(AppError::InvalidQuery(
            "key_prefix_allowlist 至少要有一项（用 [\"*\"] 表示不限）".to_string(),
        ));
    }
    if keys.iter().any(|k| k.trim().is_empty()) {
        return Err(AppError::InvalidQuery(
            "key_prefix_allowlist 不能含空字符串".to_string(),
        ));
    }
    Ok(())
}

/// 从 exec args 中取出需要做 key ACL 的路径（无 key 的 op 跳过）。
pub fn keys_for_acl(op: &str, args: &serde_json::Value) -> Result<Vec<String>, AppError> {
    let op = op.trim().to_ascii_lowercase();
    match op.as_str() {
        "health" | "list" => {
            // list：若带 prefix，用 prefix 做 ACL；否则不校验具体 key（仍受 allowed_ops 约束）
            if op == "list" {
                if let Some(prefix) = args.get("prefix").and_then(|v| v.as_str()) {
                    let t = prefix.trim();
                    if !t.is_empty() {
                        return Ok(vec![t.to_string()]);
                    }
                }
            }
            Ok(vec![])
        }
        "put" | "get" | "presign" => {
            let key = args
                .get("key")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppError::InvalidQuery("缺少字符串参数 `key`".into()))?
                .trim();
            if key.is_empty() {
                return Err(AppError::InvalidQuery("key 不能为空".into()));
            }
            Ok(vec![key.to_string()])
        }
        "delete" => {
            if let Some(arr) = args.get("keys").and_then(|v| v.as_array()) {
                let mut out = Vec::new();
                for v in arr {
                    let k = v
                        .as_str()
                        .ok_or_else(|| AppError::InvalidQuery("`keys` 元素必须是字符串".into()))?
                        .trim();
                    if k.is_empty() {
                        return Err(AppError::InvalidQuery("keys 含空字符串".into()));
                    }
                    out.push(k.to_string());
                }
                Ok(out)
            } else {
                let key = args
                    .get("key")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| AppError::InvalidQuery("缺少字符串参数 `key`".into()))?
                    .trim();
                if key.is_empty() {
                    return Err(AppError::InvalidQuery("key 不能为空".into()));
                }
                Ok(vec![key.to_string()])
            }
        }
        _ => Ok(vec![]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;
    use serde_json::json;

    #[test]
    fn generate_token_has_prefix() {
        let t = generate_token();
        assert!(t.starts_with(TOKEN_PREFIX));
        assert_eq!(hash_token(&t).len(), 64);
        assert!(token_prefix(&t).starts_with("obes_os_"));
    }

    #[test]
    fn extract_api_key_and_x_header() {
        let mut h = HeaderMap::new();
        h.insert("authorization", "ApiKey obes_os_abc".parse().unwrap());
        assert_eq!(extract_token(&h).as_deref(), Some("obes_os_abc"));

        let mut h2 = HeaderMap::new();
        h2.insert("x-os-token", "obes_os_xyz".parse().unwrap());
        assert_eq!(extract_token(&h2).as_deref(), Some("obes_os_xyz"));
    }

    #[test]
    fn op_and_key_acl() {
        let ops = vec!["put".into(), "health".into()];
        assert!(op_allowed("put", &ops).is_ok());
        assert!(op_allowed("list", &ops).is_err());

        let keys = vec!["uploads/*".into(), "a.txt".into()];
        assert!(key_allowed("uploads/x", &keys).is_ok());
        assert!(key_allowed("a.txt", &keys).is_ok());
        assert!(key_allowed("other", &keys).is_err());
        assert!(key_allowed("anything", &["*".into()]).is_ok());
    }

    #[test]
    fn keys_for_acl_helpers() {
        assert_eq!(
            keys_for_acl("put", &json!({"key": "a/b"})).unwrap(),
            vec!["a/b".to_string()]
        );
        assert!(keys_for_acl("health", &json!({})).unwrap().is_empty());
        assert_eq!(
            keys_for_acl("list", &json!({"prefix": "uploads/"})).unwrap(),
            vec!["uploads/".to_string()]
        );
    }
}
