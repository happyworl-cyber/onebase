use crate::workflow_qa::{Finding, Severity, WorkflowSnapshot};
use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

fn nodes_of(v: &Value) -> &[Value] {
    v.as_array().map(|a| a.as_slice()).unwrap_or(&[])
}

fn node_id(n: &Value) -> Option<&str> {
    n.get("id").and_then(|v| v.as_str())
}

fn node_type(n: &Value) -> &str {
    n.get("type").and_then(|v| v.as_str()).unwrap_or("")
}

fn node_label(n: &Value) -> Option<String> {
    n.get("label")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn node_code(n: &Value) -> &str {
    n.get("config")
        .and_then(|c| c.get("code"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
}

fn evidence(n: &Value) -> String {
    let s = n.to_string();
    if s.chars().count() <= 160 {
        s
    } else {
        s.chars().take(160).collect()
    }
}

fn hit(
    severity: Severity,
    code: &str,
    title: &str,
    detail: &str,
    n: Option<&Value>,
    evidence_text: String,
) -> Finding {
    Finding {
        severity,
        code: code.to_string(),
        title: title.to_string(),
        detail: detail.to_string(),
        node_id: n.and_then(node_id).map(|s| s.to_string()),
        node_label: n.and_then(node_label),
        evidence: evidence_text,
    }
}

fn edge_ids(edges: &Value) -> std::collections::HashSet<String> {
    let mut ids = std::collections::HashSet::new();
    if let Some(arr) = edges.as_array() {
        for e in arr {
            if let Some(s) = e.get("from").and_then(|v| v.as_str()) {
                ids.insert(s.to_string());
            }
            if let Some(s) = e.get("to").and_then(|v| v.as_str()) {
                ids.insert(s.to_string());
            }
        }
    }
    ids
}

fn within_80(hay: &str, a: &str, b: &str) -> bool {
    if let Some(i) = hay.find(a) {
        if let Some(j) = hay[i..].find(b) {
            return j <= 80;
        }
    }
    false
}

fn noop_b64(code: &str) -> bool {
    let lower = code.to_ascii_lowercase();
    within_80(&lower, "b64encode", "b64decode") || within_80(&lower, "b64decode", "b64encode")
}

fn looks_like_manual_storage(text: &str) -> bool {
    text.contains("storage.googleapis.com")
        || text.contains("AWS4-HMAC-SHA256")
        || text.contains("SigV4")
}

fn has_hardcoded_secret(n: &Value) -> bool {
    let s = n.to_string();
    if s.contains("Bearer ***") {
        return true;
    }
    if s.contains("or '***'") || s.contains("or \"***\"") {
        return true;
    }
    if let Some(headers) = n.pointer("/config/headers").and_then(|h| h.as_object()) {
        for (k, v) in headers {
            if k.eq_ignore_ascii_case("authorization")
                || k.eq_ignore_ascii_case("app-secret")
                || k.eq_ignore_ascii_case("x-api-key")
            {
                if v.as_str() == Some("***") {
                    return true;
                }
            }
        }
    }
    false
}

pub fn has_code_node(nodes: &Value) -> bool {
    nodes_of(nodes).iter().any(|n| node_type(n) == "code")
}

fn is_generated_node_id(id: &str, ty: &str) -> bool {
    if ty.is_empty() {
        return false;
    }
    let prefix = format!("{}_", ty);
    let Some(rest) = id.strip_prefix(&prefix) else {
        return false;
    };
    let Some((mid, seq)) = rest.rsplit_once('_') else {
        return false;
    };
    !mid.is_empty()
        && mid
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && !seq.is_empty()
        && seq.chars().all(|c| c.is_ascii_digit())
}

fn has_python_bare_except(code: &str) -> bool {
    let lines: Vec<&str> = code.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed != "except:" && trimmed != "except Exception:" {
            continue;
        }
        let next = lines[i + 1..]
            .iter()
            .map(|l| l.trim())
            .find(|l| !l.is_empty());
        match next {
            None | Some("pass") => return true,
            _ => {}
        }
    }
    false
}

fn has_empty_js_catch(code: &str) -> bool {
    static JS: OnceLock<Regex> = OnceLock::new();
    JS.get_or_init(|| Regex::new(r"catch\s*(?:\([^)]*\))?\s*\{\s*\}").expect("empty catch regex"))
        .is_match(code)
}

fn has_bare_except(code: &str) -> bool {
    has_python_bare_except(code) || has_empty_js_catch(code)
}

fn has_http_in_code(code: &str) -> bool {
    code.contains("http.get")
        || code.contains("http.post")
        || code.contains("http.put")
        || code.contains("http.delete")
}

fn missing_input_schema(wf: &WorkflowSnapshot) -> bool {
    wf.trigger_type == "endpoint"
        && !wf
            .input_schema
            .as_ref()
            .is_some_and(|schema| schema.is_object())
}

pub fn scan_rules(wf: &WorkflowSnapshot) -> Vec<Finding> {
    let nodes = nodes_of(&wf.nodes);
    let linked = edge_ids(&wf.edges);
    let mut out = Vec::new();

    if missing_input_schema(wf) {
        out.push(hit(
            Severity::Low,
            "style.missing_input_schema",
            "endpoint 未声明 input_schema",
            "应提供 JSON 对象（可以为 {}）",
            None,
            String::new(),
        ));
    }

    if wf.trigger_type == "endpoint" && !nodes.iter().any(|n| node_type(n) == "response") {
        out.push(hit(
            Severity::High,
            "endpoint_no_response",
            "endpoint 工作流没有 response 节点",
            "调用方收不到明确 HTTP 响应信封",
            None,
            String::new(),
        ));
    }

    for n in nodes {
        let ty = node_type(n);
        let code = node_code(n);

        if ty == "code" && code.trim().is_empty() {
            out.push(hit(
                Severity::High,
                "empty_code",
                "代码节点为空",
                "code 节点没有可执行源码",
                Some(n),
                evidence(n),
            ));
        }

        if nodes.len() > 1 {
            if let Some(id) = node_id(n) {
                if !linked.contains(id) {
                    out.push(hit(
                        Severity::Med,
                        "isolated_node",
                        "节点不在任何边上",
                        "图上存在悬空节点",
                        Some(n),
                        evidence(n),
                    ));
                }
            }
        }

        if has_hardcoded_secret(n) {
            out.push(hit(
                Severity::Crit,
                "hardcoded_secret",
                "疑似硬编码密钥",
                "密钥应走 {{env.X}} 或对象存储连接，不要写在节点里",
                Some(n),
                evidence(n),
            ));
        }

        if noop_b64(code) {
            out.push(hit(
                Severity::High,
                "noop_b64_roundtrip",
                "Base64 编码后立刻解码",
                "这是空操作，不能当脱敏",
                Some(n),
                evidence(n),
            ));
        }

        if ty != "object_storage" && looks_like_manual_storage(&n.to_string()) {
            out.push(hit(
                Severity::High,
                "manual_object_storage",
                "手写对象存储/上传",
                "应使用 object_storage 节点",
                Some(n),
                evidence(n),
            ));
        }

        if ty == "code" && code.len() > 8000 {
            out.push(hit(
                Severity::Med,
                "huge_code",
                "单节点代码过大",
                "超过 8KB，难审难测",
                Some(n),
                evidence(n),
            ));
        }

        if let Some(id) = node_id(n) {
            if is_generated_node_id(id, ty) {
                out.push(hit(
                    Severity::Low,
                    "style.generated_node_id",
                    "节点 id 仍是画布生成名",
                    "建议改成有语义的 id",
                    Some(n),
                    evidence(n),
                ));
            }
        }

        if ty == "code" && has_bare_except(code) {
            out.push(hit(
                Severity::Low,
                "style.bare_except",
                "空的异常处理",
                "except/catch 后只有 pass 或为空，错误会被吞掉",
                Some(n),
                evidence(n),
            ));
        }

        if ty == "code" && has_http_in_code(code) {
            out.push(hit(
                Severity::Low,
                "style.http_in_code",
                "代码节点里直接调 http.*",
                "应使用 http_call 节点",
                Some(n),
                evidence(n),
            ));
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow_qa::WorkflowSnapshot;
    use serde_json::json;

    fn snap(trigger: &str, nodes: serde_json::Value, edges: serde_json::Value) -> WorkflowSnapshot {
        WorkflowSnapshot {
            id: 1,
            slug: "t".into(),
            name: "t".into(),
            department: None,
            trigger_type: trigger.into(),
            input_schema: None,
            nodes,
            edges,
        }
    }

    fn snap_full(
        trigger: &str,
        schema: Option<serde_json::Value>,
        nodes: serde_json::Value,
        edges: serde_json::Value,
    ) -> WorkflowSnapshot {
        WorkflowSnapshot {
            id: 1,
            slug: "t".into(),
            name: "t".into(),
            department: None,
            trigger_type: trigger.into(),
            input_schema: schema,
            nodes,
            edges,
        }
    }

    fn codes(wf: &WorkflowSnapshot) -> Vec<String> {
        scan_rules(wf).into_iter().map(|f| f.code).collect()
    }

    #[test]
    fn empty_code_and_isolated_and_no_response() {
        let nodes = json!([
            { "id": "start", "label": "入参", "type": "code", "config": { "code": "  " } },
            { "id": "ghost", "label": "悬空", "type": "redis", "config": {} }
        ]);
        let edges = json!([]);
        let findings = scan_rules(&snap("endpoint", nodes, edges));
        let c: Vec<_> = findings.iter().map(|f| f.code.as_str()).collect();
        assert!(c.contains(&"empty_code"));
        assert!(c.contains(&"isolated_node"));
        assert!(c.contains(&"endpoint_no_response"));
        assert!(findings
            .iter()
            .any(|f| f.code == "endpoint_no_response" && f.node_id.is_none()));
    }

    #[test]
    fn noop_b64_roundtrip() {
        let nodes = json!([{
            "id": "gcs", "label": "GCS 上传", "type": "code",
            "config": { "language": "python", "code": "def _detaint(v):\n    return base64.b64decode(base64.b64encode(s.encode('utf-8'))).decode('utf-8')\n" }
        }]);
        assert!(
            codes(&snap("manual", nodes, json!([]))).contains(&"noop_b64_roundtrip".to_string())
        );
    }

    #[test]
    fn hardcoded_secret_evidence_is_redacted() {
        let wf = snap(
            "endpoint",
            json!([
                { "id": "call", "label": "判官", "type": "http_call",
                  "config": { "headers": { "Authorization": "Bearer ***" } } },
                { "id": "resp", "type": "response", "config": {} }
            ]),
            json!([{"from":"call","to":"resp"}]),
        );
        let hits: Vec<_> = scan_rules(&wf)
            .into_iter()
            .filter(|f| f.code == "hardcoded_secret")
            .collect();
        assert_eq!(hits.len(), 1);
        assert!(!hits[0].evidence.contains("dw_"));
        assert!(hits[0].evidence.contains("***"));
    }

    #[test]
    fn env_template_is_not_a_secret() {
        let nodes = json!([
            { "id": "h", "type": "http_call", "config": { "headers": { "Authorization": "Bearer {{env.KEY}}" } } },
            { "id": "r", "type": "response", "config": {} }
        ]);
        let edges = json!([{"from":"h","to":"r"}]);
        assert!(!codes(&snap("endpoint", nodes, edges)).contains(&"hardcoded_secret".to_string()));
    }

    #[test]
    fn manual_object_storage() {
        let nodes = json!([{
            "id": "up", "label": "上传", "type": "code",
            "config": { "code": "url = 'https://storage.googleapis.com/bucket/obj'\n# AWS4-HMAC-SHA256" }
        }]);
        assert!(
            codes(&snap("manual", nodes, json!([]))).contains(&"manual_object_storage".to_string())
        );
    }

    #[test]
    fn object_storage_node_is_not_manual() {
        let nodes = json!([{
            "id": "os", "type": "object_storage",
            "config": { "op": "put", "key": "a", "content": "https://storage.googleapis.com/x" }
        }]);
        assert!(!codes(&snap("manual", nodes, json!([])))
            .contains(&"manual_object_storage".to_string()));
    }

    #[test]
    fn bare_script_is_not_no_execute() {
        let nodes = json!([{
            "id": "verify", "type": "code",
            "config": { "language": "python", "code": "def _run(c):\n    return {'ok': True}\nctx.body = _run(ctx)\n" }
        }]);
        let c = codes(&snap("manual", nodes, json!([])));
        assert!(!c.iter().any(|x| x.contains("execute")));
    }

    #[test]
    fn huge_code_on_untruncated_source() {
        let code = "x".repeat(8001);
        let nodes = json!([{ "id": "p1", "type": "code", "config": { "code": code } }]);
        let hits = scan_rules(&snap("manual", nodes, json!([])));
        assert!(hits.iter().any(|f| f.code == "huge_code"));
    }

    #[test]
    fn style_missing_input_schema() {
        let empty_nodes = json!([]);
        let edges = json!([]);
        let c = codes(&snap_full(
            "endpoint",
            None,
            empty_nodes.clone(),
            edges.clone(),
        ));
        assert!(c.contains(&"style.missing_input_schema".to_string()));
        let c2 = codes(&snap_full(
            "endpoint",
            Some(json!({})),
            empty_nodes.clone(),
            edges.clone(),
        ));
        assert!(!c2.contains(&"style.missing_input_schema".to_string()));
        let c3 = codes(&snap_full("cron", None, empty_nodes, edges));
        assert!(!c3.contains(&"style.missing_input_schema".to_string()));
    }

    #[test]
    fn style_generated_node_id() {
        let nodes = json!([
            { "id": "code_lj9abc_3", "type": "code", "label": "x", "config": { "code": "return 1" } },
            { "id": "resp_ok", "type": "response", "config": {} }
        ]);
        let edges = json!([{"from":"code_lj9abc_3","to":"resp_ok"}]);
        let c = codes(&snap_full("manual", None, nodes, edges));
        assert!(c.contains(&"style.generated_node_id".to_string()));
        assert_eq!(
            c.iter().filter(|x| *x == "style.generated_node_id").count(),
            1
        );
    }

    #[test]
    fn style_bare_except_and_typed_except() {
        let bare = json!([{ "id": "c", "type": "code", "config": { "code": "try:\n    x()\nexcept:\n    pass\n" } }]);
        assert!(codes(&snap_full("manual", None, bare, json!([])))
            .contains(&"style.bare_except".to_string()));
        let js = json!([{ "id": "c", "type": "code", "config": { "code": "try { x() } catch (e) {}" } }]);
        assert!(codes(&snap_full("manual", None, js, json!([])))
            .contains(&"style.bare_except".to_string()));
        let typed = json!([{ "id": "c", "type": "code", "config": { "code": "try:\n    x()\nexcept ValueError:\n    return {}\n" } }]);
        assert!(!codes(&snap_full("manual", None, typed, json!([])))
            .contains(&"style.bare_except".to_string()));
        let handled = json!([{ "id": "c", "type": "code", "config": { "code": "try:\n    x()\nexcept Exception:\n    return {}\n" } }]);
        assert!(!codes(&snap_full("manual", None, handled, json!([])))
            .contains(&"style.bare_except".to_string()));
    }

    #[test]
    fn style_http_in_code() {
        let nodes =
            json!([{ "id": "c", "type": "code", "config": { "code": "http.post(url, {})" } }]);
        assert!(codes(&snap_full("manual", None, nodes, json!([])))
            .contains(&"style.http_in_code".to_string()));
    }
}
