//! ES 代理 token 工具 + 三层访问控制
//!
//! ## Token 格式
//!
//! `cres_es_<43 字符 base64url>`，固定 8 + 43 = 51 字符。前缀让运维一眼能辨别
//! token 类型（与 management.api_keys 的 `cr_` 前缀同思路；之所以叫 `cres_es_`
//! 是因为 `cr_` 已被 Auto API 占用，且 `cres_es_` 不会被 rbac_middleware 的
//! `s.starts_with("cr_")` 误判）。
//!
//! 32 字节随机熵 → base64url no-padding（避免 URL/JSON 字符串特殊字符），
//! 大约 256 bits 熵 —— 远高于 NIST 推荐的 128 bits。
//!
//! ## 存储
//!
//! 与 `management.api_keys.key_hash` 同款 sha256 hex（64 字符）。
//! DB 永远拿不回明文，泄露 DB 也无法伪造 token（除非有人撞 sha256）。
//!
//! ## 三层访问控制
//!
//! 1. **method**：HTTP 方法在 `allowed_methods` 白名单内
//! 2. **path_denylist**：正则全段匹配，命中即拒（拦 `_cluster/*` `_security/*` 等）
//! 3. **index_allowlist**：从 path 提取首段（多 index 拆逗号），逐个 glob 匹配
//!
//! Order: deny first (path_denylist) → allow next (index_allowlist) →
//! method last（method 拦截快，但成本和正则相比可以忽略；放最后让错误信息更具体）

use sha2::{Digest, Sha256};

/// 生成一个新的明文 token。仅返回字符串，hash 在 [`hash_token`] 单独算。
///
/// 每次调用都用 `OsRng`，不缓存。
pub fn generate_token() -> String {
    use base64::Engine as _;
    use rand::RngCore;
    let mut buf = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    let body = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf);
    format!("cres_es_{}", body)
}

/// 计算 token 的 sha256 hex（64 字符）。用于 DB 入库 / 查找。
pub fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

/// 给 token 截前 16 字符做"预览"。`cres_es_aB3c1234`。
///
/// 不参与鉴权；唯一目的是让 UI / 审计日志能区分多个 token 而不用泄露完整明文。
pub fn token_prefix(token: &str) -> String {
    token.chars().take(16).collect()
}

/// 从 `Authorization` header 里抠出 token 明文。
///
/// 支持三种形式（兼容主流 ES client 的默认行为）：
///   - `Authorization: ApiKey cres_es_xxxxx`   ES 官方 client 默认
///   - `Authorization: Bearer cres_es_xxxxx`   通用 HTTP client 默认
///   - `Authorization: cres_es_xxxxx`          裸 token（curl 一行命令场景）
///
/// 还接受 `X-Es-Token` 作为 fallback，方便业务端不动 Authorization 链路。
pub fn extract_token(headers: &axum::http::HeaderMap) -> Option<String> {
    if let Some(val) = headers.get("authorization").and_then(|v| v.to_str().ok()) {
        let v = val.trim();
        // 大小写不敏感的前缀剥离；ES 官方文档 "ApiKey" 是 case-sensitive，但代理层
        // 宽松一点不会引入歧义（token 自带 `cres_es_` 不会和其它 scheme 撞）。
        for prefix in ["ApiKey ", "Bearer ", "ApiKey  ", "Bearer  "] {
            if let Some(rest) = v.strip_prefix(prefix) {
                let t = rest.trim();
                if t.starts_with("cres_es_") {
                    return Some(t.to_string());
                }
            }
        }
        if v.starts_with("cres_es_") {
            return Some(v.to_string());
        }
    }
    if let Some(val) = headers.get("x-es-token").and_then(|v| v.to_str().ok()) {
        let v = val.trim();
        if v.starts_with("cres_es_") {
            return Some(v.to_string());
        }
    }
    None
}

// ── 访问控制 ────────────────────────────────────────────────────────────

/// 一次访问检查的最终结论。`Allowed` 不带任何数据；`Denied` 带原因字符串，
/// 供审计日志和 403 响应使用。
#[derive(Debug, PartialEq, Eq)]
pub enum AccessDecision {
    Allowed,
    Denied(String),
}

/// 三层校验：method → path_denylist → index_allowlist。
///
/// `path` 是去掉 `/api/es` 前缀后的"ES 原生路径"，例如 `/logs-2024/_search`；
/// 必须以 `/` 开头。
pub fn check_access(
    method: &str,
    path: &str,
    allowed_methods: &[String],
    path_denylist: &[String],
    index_allowlist: &[String],
) -> AccessDecision {
    let method_upper = method.to_uppercase();

    // 1. method 白名单
    if !allowed_methods
        .iter()
        .any(|m| m.eq_ignore_ascii_case(&method_upper))
    {
        return AccessDecision::Denied(format!(
            "method {} 不在 token 允许列表 {:?}",
            method_upper, allowed_methods
        ));
    }

    // 2. path 黑名单（任一正则命中即拒）
    for pat in path_denylist {
        match regex::Regex::new(pat) {
            Ok(re) => {
                if re.is_match(path) {
                    return AccessDecision::Denied(format!(
                        "path {} 命中黑名单规则 `{}`",
                        path, pat
                    ));
                }
            }
            Err(e) => {
                // 不合法的正则当成"匹配失败"放行，但记日志：DB 端 CHECK 阻止不了正则
                // 语法错误，运维出错的成本不应转嫁给业务端 401/500。
                tracing::warn!(
                    "es_access_token.path_denylist 含非法正则 `{}`：{}；跳过该规则",
                    pat,
                    e
                );
            }
        }
    }

    // 3. index 白名单。从 path 提取 index 段；不存在 index 段（如 `/_search`、`/_cat`）
    //    则视为"集群级请求"——既然 path_denylist 没拦下来，就放行 method 校验后的请求。
    let indices = extract_indices(path);
    if !indices.is_empty() && !index_allowlist.iter().any(|p| p == "*") {
        for idx in &indices {
            if !index_allowlist.iter().any(|pat| glob_match(pat, idx)) {
                return AccessDecision::Denied(format!(
                    "index `{}` 不在 token 允许列表 {:?}",
                    idx, index_allowlist
                ));
            }
        }
    }

    AccessDecision::Allowed
}

/// 从 ES 路径里抠 index 段：
///   - `/<indices>/<rest>` → 拆 `<indices>` 部分按逗号
///   - 首段以 `_` 开头（如 `_search`, `_cat`, `_cluster`）→ 视为集群级，返回空
///   - 空 path / `/` → 视为集群级
pub fn extract_indices(path: &str) -> Vec<String> {
    let trimmed = path.trim_start_matches('/');
    if trimmed.is_empty() {
        return vec![];
    }
    let first_segment = trimmed.split('/').next().unwrap_or("");
    if first_segment.starts_with('_') {
        return vec![];
    }
    // URL 解码？axum 给到的 wildcard path 已经解码过，这里直接拆。
    first_segment
        .split(',')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

/// 极简 glob：支持 `*`（任意字符串包含空）和 `?`（任意单字符）。
///
/// 我们故意**不**使用完整的 fnmatch / regex 语法，避免 token 配置时被复杂 pattern
/// 反咬一口（譬如转义 `.` 时漏写）。ES 的 index pattern 本来就这么简单。
pub fn glob_match(pattern: &str, candidate: &str) -> bool {
    // 转换成正则：`*` → `.*`，`?` → `.`，其它 regex meta 字符全部转义
    let mut re_src = String::with_capacity(pattern.len() + 4);
    re_src.push('^');
    for ch in pattern.chars() {
        match ch {
            '*' => re_src.push_str(".*"),
            '?' => re_src.push('.'),
            // regex 元字符列表：. + ( ) | { } [ ] ^ $ \
            '.' | '+' | '(' | ')' | '|' | '{' | '}' | '[' | ']' | '^' | '$' | '\\' => {
                re_src.push('\\');
                re_src.push(ch);
            }
            _ => re_src.push(ch),
        }
    }
    re_src.push('$');
    match regex::Regex::new(&re_src) {
        Ok(re) => re.is_match(candidate),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_format_and_hash() {
        let t = generate_token();
        assert!(t.starts_with("cres_es_"));
        // 8 (前缀) + 43 (base64url no-padding 32 bytes) = 51
        assert_eq!(t.len(), 51, "token={}", t);
        // 同一个 token 多次 hash 结果相同；不同 token hash 不同
        assert_eq!(hash_token(&t), hash_token(&t));
        let t2 = generate_token();
        assert_ne!(t, t2);
        assert_ne!(hash_token(&t), hash_token(&t2));
        assert_eq!(token_prefix(&t).len(), 16);
    }

    #[test]
    fn extract_token_from_headers() {
        use axum::http::HeaderMap;
        let mk = |k: &str, v: &str| {
            let mut h = HeaderMap::new();
            h.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                axum::http::HeaderValue::from_str(v).unwrap(),
            );
            h
        };
        // ApiKey
        assert_eq!(
            extract_token(&mk("authorization", "ApiKey cres_es_abc")),
            Some("cres_es_abc".to_string())
        );
        // Bearer
        assert_eq!(
            extract_token(&mk("authorization", "Bearer cres_es_xyz")),
            Some("cres_es_xyz".to_string())
        );
        // 裸 token
        assert_eq!(
            extract_token(&mk("authorization", "cres_es_naked")),
            Some("cres_es_naked".to_string())
        );
        // X-Es-Token
        assert_eq!(
            extract_token(&mk("x-es-token", "cres_es_xeT")),
            Some("cres_es_xeT".to_string())
        );
        // 错前缀（不是我们的 token）→ 不抓
        assert_eq!(extract_token(&mk("authorization", "Bearer cr_other")), None);
        // 空 header
        assert_eq!(extract_token(&HeaderMap::new()), None);
    }

    #[test]
    fn glob_basics() {
        assert!(glob_match("*", "anything"));
        assert!(glob_match("logs-*", "logs-2024"));
        assert!(glob_match("logs-*", "logs-"));
        assert!(!glob_match("logs-*", "audit-2024"));
        assert!(glob_match("orders", "orders"));
        assert!(!glob_match("orders", "orders-2024"));
        assert!(glob_match("event-?", "event-1"));
        assert!(!glob_match("event-?", "event-12"));
        // regex 元字符必须被字面化（不应该把 `.` 当通配符）
        assert!(glob_match("foo.bar", "foo.bar"));
        assert!(!glob_match("foo.bar", "fooXbar"));
    }

    #[test]
    fn extract_indices_cases() {
        assert_eq!(extract_indices("/logs-2024/_search"), vec!["logs-2024"]);
        assert_eq!(
            extract_indices("/logs-2024,audit-2024/_search"),
            vec!["logs-2024", "audit-2024"]
        );
        assert!(extract_indices("/_search").is_empty(), "_search 是集群级");
        assert!(extract_indices("/_cat/indices").is_empty());
        assert!(extract_indices("/").is_empty());
        assert!(extract_indices("").is_empty());
    }

    #[test]
    fn check_access_method_filter() {
        let methods = vec!["GET".to_string(), "POST".to_string()];
        let denylist: Vec<String> = vec![];
        let allowlist = vec!["*".to_string()];
        assert_eq!(
            check_access("GET", "/logs/_search", &methods, &denylist, &allowlist),
            AccessDecision::Allowed
        );
        // PUT 不在白名单 → 拒
        assert!(matches!(
            check_access("PUT", "/logs/_doc/1", &methods, &denylist, &allowlist),
            AccessDecision::Denied(_)
        ));
        // 大小写无关
        assert_eq!(
            check_access("post", "/logs/_search", &methods, &denylist, &allowlist),
            AccessDecision::Allowed
        );
    }

    #[test]
    fn check_access_path_denylist() {
        let methods = vec!["GET".to_string(), "POST".to_string(), "DELETE".to_string()];
        let denylist = vec!["^/?_cluster(/.*)?$".to_string()];
        let allowlist = vec!["*".to_string()];
        assert!(matches!(
            check_access("GET", "/_cluster/health", &methods, &denylist, &allowlist),
            AccessDecision::Denied(_)
        ));
        assert!(matches!(
            check_access("POST", "/_cluster/settings", &methods, &denylist, &allowlist),
            AccessDecision::Denied(_)
        ));
        // 不命中黑名单
        assert_eq!(
            check_access("GET", "/logs/_search", &methods, &denylist, &allowlist),
            AccessDecision::Allowed
        );
    }

    #[test]
    fn check_access_index_allowlist() {
        let methods = vec!["GET".to_string()];
        let denylist: Vec<String> = vec![];
        let allowlist = vec!["logs-*".to_string(), "audit".to_string()];

        assert_eq!(
            check_access("GET", "/logs-2024/_search", &methods, &denylist, &allowlist),
            AccessDecision::Allowed
        );
        assert_eq!(
            check_access("GET", "/audit/_search", &methods, &denylist, &allowlist),
            AccessDecision::Allowed
        );
        // 多 index：任一不匹配即拒
        assert!(matches!(
            check_access(
                "GET",
                "/logs-2024,orders/_search",
                &methods,
                &denylist,
                &allowlist
            ),
            AccessDecision::Denied(_)
        ));
        // 集群级路径（`_`-prefix）不受 index_allowlist 限制
        assert_eq!(
            check_access("GET", "/_cat/indices", &methods, &denylist, &allowlist),
            AccessDecision::Allowed
        );
    }

    #[test]
    fn check_access_star_allowlist_bypasses_index_check() {
        let methods = vec!["GET".to_string()];
        let denylist: Vec<String> = vec![];
        let allowlist = vec!["*".to_string()];
        assert_eq!(
            check_access("GET", "/anything-goes/_search", &methods, &denylist, &allowlist),
            AccessDecision::Allowed
        );
    }
}
