use regex::Regex;
use serde_json::{json, Map, Value};
use std::sync::OnceLock;

const SECRET_HEADERS: &[&str] = &["authorization", "app-secret", "x-api-key"];

fn is_secret_header(key: &str) -> bool {
    SECRET_HEADERS.iter().any(|h| key.eq_ignore_ascii_case(h))
}

fn walk(v: &Value) -> Value {
    match v {
        Value::Object(map) => {
            let mut out = Map::new();
            for (k, val) in map {
                if is_secret_header(k) {
                    if let Some(s) = val.as_str() {
                        if !s.contains("{{env.") {
                            out.insert(k.clone(), json!("***"));
                            continue;
                        }
                    }
                }
                out.insert(k.clone(), walk(val));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(walk).collect()),
        other => other.clone(),
    }
}

fn protect_templates(s: &str) -> (String, Vec<String>) {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"\{\{[^}]*\}\}").expect("template regex"));
    let mut held = Vec::new();
    let rewritten = re
        .replace_all(s, |caps: &regex::Captures| {
            let i = held.len();
            held.push(caps[0].to_string());
            format!("\u{1}TPL{i}\u{1}")
        })
        .into_owned();
    (rewritten, held)
}

fn restore_templates(s: &str, held: &[String]) -> String {
    let mut out = s.to_string();
    for (i, raw) in held.iter().enumerate() {
        out = out.replace(&format!("\u{1}TPL{i}\u{1}"), raw);
    }
    out
}

fn redact_string(s: &str) -> String {
    static BEARER: OnceLock<Regex> = OnceLock::new();
    static DW: OnceLock<Regex> = OnceLock::new();
    static SK: OnceLock<Regex> = OnceLock::new();
    static AKIA: OnceLock<Regex> = OnceLock::new();
    static HEX: OnceLock<Regex> = OnceLock::new();
    static ENV_OR: OnceLock<Regex> = OnceLock::new();

    let (protected, held) = protect_templates(s);
    let mut t = protected;
    let bearer = BEARER.get_or_init(|| Regex::new(r"Bearer\s+\S+").expect("bearer regex"));
    t = bearer.replace_all(&t, "Bearer ***").into_owned();
    let dw = DW.get_or_init(|| Regex::new(r"\bdw_[A-Za-z0-9._-]{6,}").expect("dw regex"));
    t = dw.replace_all(&t, "***").into_owned();
    let sk = SK.get_or_init(|| Regex::new(r"\bsk-[A-Za-z0-9]{16,}").expect("sk regex"));
    t = sk.replace_all(&t, "***").into_owned();
    let akia = AKIA.get_or_init(|| Regex::new(r"\bAKIA[A-Z0-9]{16}").expect("akia regex"));
    t = akia.replace_all(&t, "***").into_owned();
    let hex = HEX.get_or_init(|| Regex::new(r"\b[A-Fa-f0-9]{32,}\b").expect("hex regex"));
    t = hex.replace_all(&t, "***").into_owned();
    let env_or = ENV_OR.get_or_init(|| {
        Regex::new(r#"env\.get\([^)]*\)\s+or\s+(?:'[^']+'|"[^"]+")"#).expect("env or regex")
    });
    t = env_or
        .replace_all(&t, |caps: &regex::Captures| {
            let m = &caps[0];
            if let Some(q) = m.rfind('\'') {
                if m[..q].contains('\'') {
                    return format!("{}***'", &m[..=m.find('\'').unwrap()]);
                }
            }
            if let Some(q) = m.rfind('"') {
                if m[..q].contains('"') {
                    return format!("{}\"***\"", &m[..=m.find('"').unwrap()]);
                }
            }
            "***".to_string()
        })
        .into_owned();
    restore_templates(&t, &held)
}

/// Walk JSON, mask secret headers, then apply literal secret patterns on the serialized form.
pub fn redact_value(v: &Value) -> Value {
    let walked = walk(v);
    let rewritten = redact_string(&walked.to_string());
    serde_json::from_str(&rewritten).unwrap_or(walked)
}

fn char_boundary_prefix(s: &str, n: usize) -> &str {
    if s.len() <= n {
        return s;
    }
    let mut end = n;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn char_boundary_suffix(s: &str, n: usize) -> &str {
    if s.len() <= n {
        return s;
    }
    let mut start = s.len() - n;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

/// Keep head and tail 2 KiB of oversized `config.code`; leave other fields alone.
pub fn truncate_codes_for_query(nodes: &Value) -> Value {
    let Some(arr) = nodes.as_array() else {
        return nodes.clone();
    };
    Value::Array(
        arr.iter()
            .map(|node| {
                let Some(code) = node
                    .get("config")
                    .and_then(|c| c.get("code"))
                    .and_then(|c| c.as_str())
                else {
                    return node.clone();
                };
                if code.len() <= 4096 {
                    return node.clone();
                }
                let mut n = node.clone();
                let new_code = format!(
                    "{}…[truncated]…{}",
                    char_boundary_prefix(code, 2048),
                    char_boundary_suffix(code, 2048)
                );
                if let Some(cfg) = n.get_mut("config").and_then(|c| c.as_object_mut()) {
                    cfg.insert("code".to_string(), json!(new_code));
                }
                n
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redact_strips_authorization_and_keeps_env_templates() {
        let raw = json!({
            "nodes": [{
                "id": "h",
                "type": "http_call",
                "config": {
                    "headers": {
                        "Authorization": "Bearer dw_5e9517b3.secret",
                        "app-secret": "plain-secret",
                        "x-api-key": "abc"
                    },
                    "body": { "token": "{{env.AI_PLATFORM_API_KEY}}" }
                }
            }]
        });
        let red = redact_value(&raw);
        let s = red.to_string();
        assert!(!s.contains("dw_5e9517b3"));
        assert!(!s.contains("plain-secret"));
        assert!(s.contains("{{env.AI_PLATFORM_API_KEY}}"));
        assert!(s.contains("***"));
    }

    #[test]
    fn redact_env_get_fallback_literal() {
        let raw = json!("local appSecret = env.get('GEOIP_APP_SECRET') or ''\nif appSecret == '' then appSecret = 'C66DE25ADF0ED1F8AAA803E8E91BF7DC' end");
        let s = redact_value(&raw).to_string();
        assert!(!s.contains("C66DE25ADF0ED1F8AAA803E8E91BF7DC"));
        assert!(s.contains("***"));
    }

    #[test]
    fn truncate_keeps_head_and_tail() {
        let code = format!(
            "{}MID{}{}",
            "H".repeat(2048),
            "X".repeat(100),
            "T".repeat(2048)
        );
        let nodes = json!([{ "id": "c", "type": "code", "config": { "code": code } }]);
        let out = truncate_codes_for_query(&nodes);
        let c = out[0]["config"]["code"].as_str().unwrap();
        assert!(c.contains("…[truncated]…"));
        assert!(c.starts_with(&"H".repeat(2048)));
        assert!(c.ends_with(&"T".repeat(2048)));
        assert!(!c.contains("X"));
    }
}
