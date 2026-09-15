//! 跨工作流契约：`call_workflow` 调用方 vs 子流当前定义。
//!
//! 入参字段不依赖 bin 侧 `workflow_input_schema`：有 schema 只取必填；
//! 否则扫描节点里的 `{{trigger.X}}`（与文档扫描同一套字段名规则）。

use crate::workflow_qa::{Finding, Severity, WorkflowSnapshot};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone)]
pub struct WorkflowSketch {
    pub id: i32,
    pub slug: String,
    pub name: String,
    pub nodes: Value,
    pub input_schema: Option<Value>,
    pub is_enabled: bool,
}

impl WorkflowSketch {
    fn as_child_snapshot(&self) -> WorkflowSnapshot {
        WorkflowSnapshot {
            id: self.id,
            slug: self.slug.clone(),
            name: self.name.clone(),
            department: None,
            trigger_type: String::new(),
            input_schema: self.input_schema.clone(),
            nodes: self.nodes.clone(),
            edges: json!([]),
        }
    }
}

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
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn call_target_slug(n: &Value) -> Option<&str> {
    n.get("config")
        .and_then(|c| c.get("workflow"))
        .and_then(|w| w.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn looks_like_whole_template(s: &str) -> bool {
    let s = s.trim();
    s.starts_with("{{") && s.ends_with("}}") && s.matches("{{").count() == 1
}

fn parse_call_input(config: &Value) -> (Value, bool) {
    match config.get("input") {
        None | Some(Value::Null) => (json!({}), false),
        Some(Value::Object(o)) => (Value::Object(o.clone()), false),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                return (json!({}), false);
            }
            if looks_like_whole_template(t) {
                return (json!({}), true);
            }
            match serde_json::from_str::<Value>(t) {
                Ok(Value::Object(o)) => (Value::Object(o), false),
                _ => (json!({}), true),
            }
        }
        _ => (json!({}), true),
    }
}

fn scan_trigger_fields(nodes: &Value) -> Vec<String> {
    let raw = nodes.to_string();
    let chars: Vec<char> = raw.chars().collect();
    let n = chars.len();
    let mut fields = Vec::new();
    let mut i = 0;
    while i + 1 < n {
        if chars[i] == '{' && chars[i + 1] == '{' {
            let mut j = i + 2;
            while j < n && chars[j].is_whitespace() {
                j += 1;
            }
            let kw: String = chars[j..n.min(j + 8)].iter().collect();
            if kw == "trigger." {
                j += 8;
                let field: String = chars[j..]
                    .iter()
                    .take_while(|c| c.is_alphanumeric() || **c == '_' || **c == '-')
                    .collect();
                if !field.is_empty() && !fields.contains(&field) {
                    fields.push(field);
                }
            }
            i = j;
        } else {
            i += 1;
        }
    }
    fields
}

fn required_from_schema(schema: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(arr) = schema.get("required").and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(name) = item.as_str() {
                if !out.iter().any(|s| s == name) {
                    out.push(name.to_string());
                }
            }
        }
    }
    if let Some(props) = schema.get("properties").and_then(|p| p.as_object()) {
        for (name, prop) in props {
            if prop.get("required").and_then(|v| v.as_bool()) == Some(true)
                && !out.iter().any(|s| s == name)
            {
                out.push(name.clone());
            }
        }
    }
    out
}

fn required_input_fields(child: &WorkflowSnapshot) -> Vec<String> {
    if let Some(schema) = child.input_schema.as_ref() {
        if schema.is_object() {
            return required_from_schema(schema);
        }
    }
    scan_trigger_fields(&child.nodes)
}

fn object_keys(v: &Value) -> Option<HashSet<String>> {
    v.as_object().map(|o| o.keys().cloned().collect())
}

fn parse_maybe_object(v: &Value) -> Option<Value> {
    match v {
        Value::Object(_) => Some(v.clone()),
        Value::String(s) => serde_json::from_str(s)
            .ok()
            .filter(|p: &Value| p.is_object()),
        _ => None,
    }
}

/// 子流 response.body 的静态键。没有任何对象 body 时返回 None（无法判断，跳过输出检查）。
fn child_response_body_keys(child: &WorkflowSnapshot) -> Option<HashSet<String>> {
    let mut keys = HashSet::new();
    let mut saw_object = false;
    for n in nodes_of(&child.nodes) {
        if node_type(n) != "response" {
            continue;
        }
        let Some(body) = n.get("config").and_then(|c| c.get("body")) else {
            continue;
        };
        if let Some(obj) = parse_maybe_object(body) {
            saw_object = true;
            if let Some(k) = object_keys(&obj) {
                keys.extend(k);
            }
        }
    }
    if saw_object {
        Some(keys)
    } else {
        None
    }
}

fn scan_template_paths(hay: &str, node_id: &str) -> Vec<Vec<String>> {
    let chars: Vec<char> = hay.chars().collect();
    let n = chars.len();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < n {
        if chars[i] != '{' || chars[i + 1] != '{' {
            i += 1;
            continue;
        }
        let mut j = i + 2;
        while j < n && chars[j].is_whitespace() {
            j += 1;
        }
        let ident: String = chars[j..]
            .iter()
            .take_while(|c| c.is_alphanumeric() || **c == '_' || **c == '-')
            .collect();
        if ident != node_id {
            i = j.max(i + 1);
            continue;
        }
        j += ident.chars().count();
        let mut path = Vec::new();
        while j < n && chars[j] == '.' {
            j += 1;
            let seg: String = chars[j..]
                .iter()
                .take_while(|c| c.is_alphanumeric() || **c == '_' || **c == '-')
                .collect();
            if seg.is_empty() {
                break;
            }
            path.push(seg.clone());
            j += seg.chars().count();
        }
        out.push(path);
        i = j;
    }
    out
}

const ENVELOPE: &[&str] = &["status_code", "body", "headers", "body_base64", "nodes"];

fn unknown_output_fields(
    parent_nodes: &Value,
    call_node_id: &str,
    body_keys: &Option<HashSet<String>>,
) -> Vec<String> {
    let hay = parent_nodes.to_string();
    let mut bad = Vec::new();
    for path in scan_template_paths(&hay, call_node_id) {
        if path.is_empty() {
            continue;
        }
        let first = path[0].as_str();
        if !ENVELOPE.contains(&first) {
            if !bad.contains(&first.to_string()) {
                bad.push(first.to_string());
            }
            continue;
        }
        if first == "body" && path.len() >= 2 {
            if let Some(keys) = body_keys {
                let field = &path[1];
                if !keys.contains(field) && !bad.contains(field) {
                    bad.push(field.clone());
                }
            }
        }
    }
    bad
}

fn missing_required(input: &Value, required: &[String]) -> Vec<String> {
    let Some(obj) = input.as_object() else {
        return required.to_vec();
    };
    required
        .iter()
        .filter(|k| !obj.contains_key(k.as_str()))
        .cloned()
        .collect()
}

fn hit(
    severity: Severity,
    code: &str,
    title: &str,
    detail: &str,
    node_id: Option<String>,
    node_label: Option<String>,
    evidence: String,
) -> Finding {
    Finding {
        severity,
        code: code.to_string(),
        title: title.to_string(),
        detail: detail.to_string(),
        node_id,
        node_label,
        evidence,
    }
}

fn caller_label(caller: &WorkflowSketch, call_node: &Value) -> String {
    let node = node_label(call_node)
        .or_else(|| node_id(call_node).map(|s| s.to_string()))
        .unwrap_or_else(|| "call_workflow".into());
    format!("父工作流 {}（{}）/ {}", caller.name, caller.slug, node)
}

/// 当前子流定义会不会把已有调用方打坏；以及本图对外调用是否对得上子流。
pub fn scan_call_graph(
    wf: &WorkflowSnapshot,
    previous_slug: Option<&str>,
    sketches: &[WorkflowSketch],
) -> Vec<Finding> {
    let mut out = Vec::new();
    let exclude = (wf.id > 0).then_some(wf.id);
    if !wf.slug.trim().is_empty() {
        out.extend(scan_incoming(wf, sketches, exclude));
        if let Some(old) = previous_slug.map(str::trim).filter(|s| !s.is_empty()) {
            if old != wf.slug.trim() {
                out.extend(scan_slug_orphans(old, &wf.slug, sketches, exclude));
            }
        }
    }
    out.extend(scan_outgoing(wf, sketches, exclude));
    out
}

fn scan_incoming(
    child: &WorkflowSnapshot,
    sketches: &[WorkflowSketch],
    exclude: Option<i32>,
) -> Vec<Finding> {
    let target = child.slug.trim();
    let required = required_input_fields(child);
    let body_keys = child_response_body_keys(child);
    let mut out = Vec::new();
    for caller in sketches {
        if exclude == Some(caller.id) || !caller.is_enabled {
            continue;
        }
        for n in nodes_of(&caller.nodes) {
            if node_type(n) != "call_workflow" {
                continue;
            }
            if call_target_slug(n) != Some(target) {
                continue;
            }
            let config = n.get("config").unwrap_or(&Value::Null);
            let (input, opaque) = parse_call_input(config);
            let label = Some(caller_label(caller, n));
            if !opaque {
                let missing = missing_required(&input, &required);
                if !missing.is_empty() {
                    out.push(hit(
                        Severity::High,
                        "caller.missing_required_input",
                        "父工作流传入字段对不上当前入参",
                        &format!("{} 调用本流时缺少：{}", caller.slug, missing.join("、")),
                        None,
                        label.clone(),
                        json!({ "caller": caller.slug, "missing": missing }).to_string(),
                    ));
                }
            }
            let unknown =
                unknown_output_fields(&caller.nodes, node_id(n).unwrap_or(""), &body_keys);
            if !unknown.is_empty() {
                out.push(hit(
                    Severity::High,
                    "caller.unknown_output_field",
                    "父工作流仍在读本流已不存在的输出字段",
                    &format!("{} 引用了：{}", caller.slug, unknown.join("、")),
                    None,
                    label,
                    json!({ "caller": caller.slug, "fields": unknown }).to_string(),
                ));
            }
        }
    }
    out
}

fn scan_slug_orphans(
    old_slug: &str,
    new_slug: &str,
    sketches: &[WorkflowSketch],
    exclude: Option<i32>,
) -> Vec<Finding> {
    let mut out = Vec::new();
    for caller in sketches {
        if exclude == Some(caller.id) || !caller.is_enabled {
            continue;
        }
        for n in nodes_of(&caller.nodes) {
            if node_type(n) != "call_workflow" {
                continue;
            }
            if call_target_slug(n) != Some(old_slug) {
                continue;
            }
            out.push(hit(
                Severity::High,
                "caller.slug_changed",
                "改 slug 后父工作流仍指向旧名称",
                &format!(
                    "{} 的 call_workflow 仍写「{}」，保存后将解析不到「{}」",
                    caller.slug, old_slug, new_slug
                ),
                None,
                Some(caller_label(caller, n)),
                json!({ "caller": caller.slug, "old_slug": old_slug, "new_slug": new_slug })
                    .to_string(),
            ));
        }
    }
    out
}

fn sketches_by_slug(sketches: &[WorkflowSketch]) -> HashMap<&str, &WorkflowSketch> {
    let mut map = HashMap::new();
    for s in sketches {
        let slug = s.slug.trim();
        if slug.is_empty() {
            continue;
        }
        map.entry(slug).or_insert(s);
    }
    map
}

fn scan_outgoing(
    parent: &WorkflowSnapshot,
    sketches: &[WorkflowSketch],
    exclude: Option<i32>,
) -> Vec<Finding> {
    let by_slug = sketches_by_slug(sketches);
    let mut out = Vec::new();
    for n in nodes_of(&parent.nodes) {
        if node_type(n) != "call_workflow" {
            continue;
        }
        let Some(target) = call_target_slug(n) else {
            out.push(hit(
                Severity::High,
                "call_workflow.target_missing",
                "call_workflow 未填写子工作流 slug",
                "运行时无法解析目标",
                node_id(n).map(|s| s.to_string()),
                node_label(n),
                String::new(),
            ));
            continue;
        };
        let Some(child) = by_slug.get(target).copied() else {
            out.push(hit(
                Severity::High,
                "call_workflow.target_missing",
                "call_workflow 目标不存在",
                &format!("同租户内没有 slug 为「{target}」的工作流"),
                node_id(n).map(|s| s.to_string()),
                node_label(n),
                json!({ "workflow": target }).to_string(),
            ));
            continue;
        };
        if exclude == Some(child.id) {
            continue;
        }
        if !child.is_enabled {
            out.push(hit(
                Severity::High,
                "call_workflow.target_disabled",
                "call_workflow 目标已停用",
                &format!("「{target}」未启用，运行时会解析失败"),
                node_id(n).map(|s| s.to_string()),
                node_label(n),
                json!({ "workflow": target }).to_string(),
            ));
            continue;
        }
        let child_snap = child.as_child_snapshot();
        let required = required_input_fields(&child_snap);
        let body_keys = child_response_body_keys(&child_snap);
        let config = n.get("config").unwrap_or(&Value::Null);
        let (input, opaque) = parse_call_input(config);
        if !opaque {
            let missing = missing_required(&input, &required);
            if !missing.is_empty() {
                out.push(hit(
                    Severity::High,
                    "call_workflow.missing_required_input",
                    "调用子工作流时缺少必填入参",
                    &format!("「{target}」需要：{}", missing.join("、")),
                    node_id(n).map(|s| s.to_string()),
                    node_label(n),
                    json!({ "workflow": target, "missing": missing }).to_string(),
                ));
            }
        }
        let unknown = unknown_output_fields(&parent.nodes, node_id(n).unwrap_or(""), &body_keys);
        if !unknown.is_empty() {
            out.push(hit(
                Severity::High,
                "call_workflow.unknown_output_field",
                "引用了子工作流不存在的输出字段",
                &format!("「{target}」没有：{}", unknown.join("、")),
                node_id(n).map(|s| s.to_string()),
                node_label(n),
                json!({ "workflow": target, "fields": unknown }).to_string(),
            ));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn child(schema: Option<Value>, nodes: Value) -> WorkflowSnapshot {
        WorkflowSnapshot {
            id: 9,
            slug: "child".into(),
            name: "子".into(),
            department: None,
            trigger_type: "endpoint".into(),
            input_schema: schema,
            nodes,
            edges: json!([]),
        }
    }

    fn sketch(id: i32, slug: &str, nodes: Value) -> WorkflowSketch {
        WorkflowSketch {
            id,
            slug: slug.into(),
            name: slug.into(),
            nodes,
            input_schema: None,
            is_enabled: true,
        }
    }

    #[test]
    fn incoming_flags_missing_required_and_unknown_body() {
        let wf = child(
            Some(json!({
                "type": "object",
                "properties": { "user_id": { "type": "string" }, "opt": { "type": "string" } },
                "required": ["user_id"]
            })),
            json!([{
                "id": "r", "type": "response",
                "config": { "body": { "ok": true } }
            }]),
        );
        let parent = sketch(
            1,
            "parent",
            json!([
                {
                    "id": "cw", "label": "调子流", "type": "call_workflow",
                    "config": { "workflow": "child", "input": { "opt": "1" } }
                },
                {
                    "id": "use", "type": "code",
                    "config": { "code": "x = {{cw.body.gone}}" }
                }
            ]),
        );
        let hits = scan_call_graph(&wf, None, &[parent]);
        let codes: Vec<_> = hits.iter().map(|f| f.code.as_str()).collect();
        assert!(
            codes.contains(&"caller.missing_required_input"),
            "{codes:?}"
        );
        assert!(codes.contains(&"caller.unknown_output_field"), "{codes:?}");
        assert!(hits.iter().any(|f| f.detail.contains("user_id")));
        assert!(hits.iter().any(|f| f.detail.contains("gone")));
    }

    #[test]
    fn opaque_input_skips_required() {
        let wf = child(
            Some(json!({
                "type": "object",
                "properties": { "user_id": {} },
                "required": ["user_id"]
            })),
            json!([]),
        );
        let parent = sketch(
            1,
            "parent",
            json!([{
                "id": "cw", "type": "call_workflow",
                "config": { "workflow": "child", "input": "{{upstream}}" }
            }]),
        );
        let hits = scan_call_graph(&wf, None, &[parent]);
        assert!(hits
            .iter()
            .all(|f| f.code != "caller.missing_required_input"));
    }

    #[test]
    fn slug_change_flags_old_callers() {
        let wf = child(None, json!([]));
        let parent = sketch(
            1,
            "parent",
            json!([{
                "id": "cw", "type": "call_workflow",
                "config": { "workflow": "old-child" }
            }]),
        );
        let hits = scan_call_graph(&wf, Some("old-child"), &[parent]);
        assert!(hits.iter().any(|f| f.code == "caller.slug_changed"));
    }

    #[test]
    fn outgoing_flags_disabled_and_missing_input() {
        let parent = WorkflowSnapshot {
            id: 1,
            slug: "parent".into(),
            name: "父".into(),
            department: None,
            trigger_type: "manual".into(),
            input_schema: None,
            nodes: json!([{
                "id": "cw", "label": "调", "type": "call_workflow",
                "config": { "workflow": "child", "input": {} }
            }]),
            edges: json!([]),
        };
        let child_sk = WorkflowSketch {
            id: 9,
            slug: "child".into(),
            name: "子".into(),
            nodes: json!([{
                "id": "c", "type": "code",
                "config": { "code": "print({{trigger.user_id}})" }
            }]),
            input_schema: None,
            is_enabled: true,
        };
        let hits = scan_call_graph(&parent, None, &[child_sk]);
        assert!(
            hits.iter()
                .any(|f| f.code == "call_workflow.missing_required_input"),
            "{hits:?}"
        );
    }

    #[test]
    fn outgoing_missing_target() {
        let parent = WorkflowSnapshot {
            id: 1,
            slug: "parent".into(),
            name: "父".into(),
            department: None,
            trigger_type: "manual".into(),
            input_schema: None,
            nodes: json!([{
                "id": "cw", "type": "call_workflow",
                "config": { "workflow": "nope" }
            }]),
            edges: json!([]),
        };
        let hits = scan_call_graph(&parent, None, &[]);
        assert!(hits
            .iter()
            .any(|f| f.code == "call_workflow.target_missing"));
    }
}
