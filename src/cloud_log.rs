//! 云日志：查询拼装、时间窗、控制台深链。与具体云厂商 HTTP 无关。

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use serde_json::Map;

pub const MAX_WINDOW_SECS: i64 = 7 * 86400;
pub const DEFAULT_WINDOW_SECS: i64 = 3600;
pub const DEFAULT_LINE: u32 = 50;
pub const MAX_LINE: u32 = 100;

#[derive(Debug, Clone)]
pub struct CloudLogQuery {
    pub from: i64,
    pub to: i64,
    pub query: String,
    pub line: u32,
    pub offset: u32,
    pub reverse: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudLogLine {
    pub time: i64,
    pub contents: Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudLogPage {
    pub logs: Vec<CloudLogLine>,
    pub count: usize,
    pub console_url: String,
}

pub fn looks_like_trace_id(s: &str) -> bool {
    let len = s.len();
    if !(8..=128).contains(&len) {
        return false;
    }
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn is_plain_sls_keyword(q: &str) -> bool {
    let t = q.trim();
    if t.is_empty() {
        return false;
    }
    if t.chars()
        .any(|c| matches!(c, ':' | '"' | '\'' | '(' | ')' | '|'))
    {
        return false;
    }
    !t.split_whitespace()
        .any(|w| matches!(w.to_ascii_lowercase().as_str(), "and" | "or" | "not"))
}

pub fn expand_plain_sls_keyword(q: &str) -> String {
    let esc = q.replace('\\', "\\\\").replace('"', "\\\"");
    // 全文短语。不用 content:/message:：字段未建键值索引时 SLS 会 400，而不是 0 命中。
    format!(r#""{esc}""#)
}

pub fn compose_sls_query(
    prefix: Option<&str>,
    user_query: Option<&str>,
    request_id: Option<&str>,
) -> Result<String, String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(p) = prefix.map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(p.to_string());
    }
    if let Some(q) = user_query.map(str::trim).filter(|s| !s.is_empty()) {
        if is_plain_sls_keyword(q) {
            parts.push(expand_plain_sls_keyword(q));
        } else {
            parts.push(q.to_string());
        }
    }
    if let Some(id) = request_id.map(str::trim).filter(|s| !s.is_empty()) {
        if !looks_like_trace_id(id) {
            return Err("非法 x_request_id".into());
        }
        // 与普通关键词相同：全文短语。x_request_id: 在字段未建键值索引时 SLS 会 400。
        parts.push(expand_plain_sls_keyword(id));
    }
    if parts.is_empty() {
        Ok("*".into())
    } else {
        Ok(parts.join(" and "))
    }
}

pub fn resolve_query_window(
    from: Option<i64>,
    to: Option<i64>,
    now: i64,
) -> Result<(i64, i64), AppError> {
    let to = to.unwrap_or(now);
    let from = from.unwrap_or(to - DEFAULT_WINDOW_SECS);
    if from >= to {
        return Err(AppError::validation(
            "cloudlog_window_from_after_to",
            "from 必须小于 to",
            serde_json::json!({}),
        ));
    }
    if to - from > MAX_WINDOW_SECS {
        return Err(AppError::validation(
            "cloudlog_window_too_large",
            "时间窗不能超过 7 天",
            serde_json::json!({ "max_days": MAX_WINDOW_SECS / 86400 }),
        ));
    }
    Ok((from, to))
}

pub fn clamp_line(line: Option<u32>) -> u32 {
    line.unwrap_or(DEFAULT_LINE).clamp(1, MAX_LINE)
}

pub fn sls_console_url(
    region: &str,
    sls_project: &str,
    logstore: &str,
    from: i64,
    to: i64,
    query: &str,
) -> String {
    use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
    const ENC: &AsciiSet = &CONTROLS
        .add(b' ')
        .add(b'"')
        .add(b'#')
        .add(b'%')
        .add(b'&')
        .add(b'+')
        .add(b',')
        .add(b'/')
        .add(b':')
        .add(b';')
        .add(b'<')
        .add(b'=')
        .add(b'>')
        .add(b'?')
        .add(b'@')
        .add(b'[')
        .add(b'\\')
        .add(b']')
        .add(b'^')
        .add(b'`')
        .add(b'{')
        .add(b'|')
        .add(b'}');
    let enc = |s: &str| utf8_percent_encode(s, ENC).to_string();
    let path_proj = enc(sls_project);
    let path_store = enc(logstore);
    let qs = enc(query);
    let region = enc(region);
    format!(
        "https://sls.console.aliyun.com/lognext/project/{path_proj}/logsearch/{path_store}?slsRegion={region}&queryTimeType=99&startTime={from}&endTime={to}&queryString={qs}"
    )
}

pub fn default_sls_endpoint(sls_project: &str, region: &str) -> String {
    format!("https://{sls_project}.{region}.log.aliyuncs.com")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compose_joins_prefix_query_and_request_id() {
        let q = compose_sls_query(
            Some(" app:pay "),
            Some("error"),
            Some("98753d7e-3bdb-4c00-bcf7-4a697606b88b"),
        )
        .unwrap();
        assert_eq!(
            q,
            r#"app:pay and "error" and "98753d7e-3bdb-4c00-bcf7-4a697606b88b""#
        );
    }

    #[test]
    fn request_id_expands_to_quoted_phrase_without_field_query() {
        let q =
            compose_sls_query(None, None, Some("98753d7e-3bdb-4c00-bcf7-4a697606b88b")).unwrap();
        assert_eq!(q, r#""98753d7e-3bdb-4c00-bcf7-4a697606b88b""#);
        assert!(!q.contains("x_request_id:"));
        assert_eq!(
            compose_sls_query(None, None, Some("743650000001")).unwrap(),
            r#""743650000001""#
        );
    }

    #[test]
    fn plain_keyword_expands_to_quoted_phrase_without_field_queries() {
        assert!(is_plain_sls_keyword("超时"));
        assert!(is_plain_sls_keyword("android"));
        assert!(is_plain_sls_keyword("123"));
        assert!(!is_plain_sls_keyword("level: ERROR"));
        assert!(!is_plain_sls_keyword("foo and bar"));
        assert!(!is_plain_sls_keyword("a|b"));
        let q = compose_sls_query(None, Some("超时"), None).unwrap();
        assert_eq!(q, r#""超时""#);
        // SLS 对未建键值索引的字段做 field:value 会 400，不能编进 content:/message:
        assert!(!q.contains("content:"));
        assert!(!q.contains("message:"));
        assert_eq!(
            compose_sls_query(None, Some("123"), None).unwrap(),
            r#""123""#
        );
        assert_eq!(
            compose_sls_query(None, Some("level: ERROR"), None).unwrap(),
            "level: ERROR"
        );
    }

    #[test]
    fn expand_escapes_backslash_and_quotes() {
        assert_eq!(expand_plain_sls_keyword(r#"a\b"c"#), r#""a\\b\"c""#);
    }

    #[test]
    fn compose_empty_is_star() {
        assert_eq!(compose_sls_query(None, Some("  "), None).unwrap(), "*");
    }

    #[test]
    fn compose_rejects_bad_request_id() {
        assert!(compose_sls_query(None, None, Some("bad id")).is_err());
        assert!(compose_sls_query(None, None, Some("short")).is_err());
    }

    #[test]
    fn window_defaults_and_rejects_oversize() {
        let now = 2_000_000_i64;
        assert_eq!(
            resolve_query_window(None, None, now).unwrap(),
            (now - 3600, now)
        );
        let week = 7 * 86400;
        assert!(resolve_query_window(Some(1), Some(1 + week), now).is_ok());
        match resolve_query_window(Some(1), Some(1 + week + 1), now).unwrap_err() {
            AppError::Coded { message, .. } => assert_eq!(message, "时间窗不能超过 7 天"),
            other => panic!("unexpected error: {other:?}"),
        }
        assert!(resolve_query_window(Some(10), Some(10), now).is_err());
        // 旧 24h 上限必须已经放开
        assert!(resolve_query_window(Some(1), Some(1 + 86400 + 1), now).is_ok());
    }

    #[test]
    fn line_clamp() {
        assert_eq!(clamp_line(None), 50);
        assert_eq!(clamp_line(Some(0)), 1);
        assert_eq!(clamp_line(Some(200)), 100);
    }

    #[test]
    fn console_url_contains_encoded_query() {
        let url = sls_console_url(
            "cn-hangzhou",
            "my-proj",
            "app-log",
            100,
            200,
            r#"x_request_id: "abc-def_1""#,
        );
        assert!(url.starts_with(
            "https://sls.console.aliyun.com/lognext/project/my-proj/logsearch/app-log?"
        ));
        assert!(url.contains("slsRegion=cn-hangzhou"));
        assert!(url.contains("queryTimeType=99"));
        assert!(url.contains("startTime=100"));
        assert!(url.contains("endTime=200"));
        assert!(url.contains("queryString="));
        assert!(!url.contains("x_request_id: "));
    }

    #[test]
    fn default_endpoint() {
        assert_eq!(
            default_sls_endpoint("my-proj", "cn-hangzhou"),
            "https://my-proj.cn-hangzhou.log.aliyuncs.com"
        );
    }
}
