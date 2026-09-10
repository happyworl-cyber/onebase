mod finding;
mod provider;
mod redact;
mod rules;

pub use finding::{BatchSummary, Finding, ReviewItem, Severity, WorkflowMeta};
pub use provider::{
    build_query, extract_answer_text, interpret_http, parse_findings_json, AiResult, AiStatus,
};
pub use redact::{redact_value, truncate_codes_for_query};
pub use rules::{has_code_node, scan_rules};

#[derive(Debug, Clone)]
pub struct WorkflowSnapshot {
    pub id: i32,
    pub slug: String,
    pub name: String,
    pub department: Option<String>,
    pub trigger_type: String,
    pub input_schema: Option<serde_json::Value>,
    pub nodes: serde_json::Value,
    pub edges: serde_json::Value,
}

pub fn clamp_max_ai(v: Option<i64>) -> usize {
    match v {
        None => 20,
        Some(n) if n < 0 => 20,
        Some(n) => (n as usize).min(50),
    }
}

pub fn should_send_to_ai(rules: &[Finding], has_code: bool) -> bool {
    rules
        .iter()
        .any(|f| matches!(f.severity, Severity::Crit | Severity::High))
        || (has_code && !rules.is_empty())
}

pub fn pick_ai_ids(candidates: &[(i32, Vec<Finding>, bool)], max_ai: usize) -> Vec<i32> {
    let mut picked: Vec<(i32, bool)> = candidates
        .iter()
        .filter(|(_, rules, has_code)| should_send_to_ai(rules, *has_code))
        .map(|(id, rules, _)| {
            let high = rules
                .iter()
                .any(|f| matches!(f.severity, Severity::Crit | Severity::High));
            (*id, high)
        })
        .collect();
    picked.sort_by(|a, b| match (a.1, b.1) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.0.cmp(&b.0),
    });
    picked.into_iter().map(|(id, _)| id).take(max_ai).collect()
}

fn snapshot_from_value(v: &serde_json::Value) -> Option<WorkflowSnapshot> {
    let id = v
        .get("id")
        .and_then(|x| x.as_i64())
        .and_then(|n| i32::try_from(n).ok())?;
    Some(WorkflowSnapshot {
        id,
        slug: v.get("slug").and_then(|x| x.as_str())?.to_string(),
        name: v.get("name").and_then(|x| x.as_str())?.to_string(),
        department: v
            .get("department")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
        trigger_type: v.get("trigger_type").and_then(|x| x.as_str())?.to_string(),
        input_schema: v.get("input_schema").cloned().filter(|x| !x.is_null()),
        nodes: v
            .get("nodes")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
        edges: v
            .get("edges")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
    })
}

pub fn snapshot_from_get_json(body: &serde_json::Value) -> Option<WorkflowSnapshot> {
    snapshot_from_value(body.get("workflow")?)
}

pub fn snapshot_from_list_item(item: &serde_json::Value) -> Option<WorkflowSnapshot> {
    snapshot_from_value(item)
}

pub fn review_local(wf: &WorkflowSnapshot) -> (WorkflowSnapshot, Vec<Finding>) {
    let mut redacted = wf.clone();
    redacted.nodes = redact_value(&wf.nodes);
    redacted.edges = redact_value(&wf.edges);
    let rules = scan_rules(&redacted);
    (redacted, rules)
}

pub fn sort_findings(findings: &mut [Finding]) {
    findings.sort_by(|a, b| {
        severity_rank(a.severity)
            .cmp(&severity_rank(b.severity))
            .then_with(|| a.code.cmp(&b.code))
            .then_with(|| match (&a.node_id, &b.node_id) {
                (Some(x), Some(y)) => x.cmp(y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            })
    });
}

fn severity_rank(severity: Severity) -> u8 {
    match severity {
        Severity::Crit => 0,
        Severity::High => 1,
        Severity::Med => 2,
        Severity::Low => 3,
    }
}

pub fn lint_unsaved(
    trigger_type: &str,
    input_schema: Option<&serde_json::Value>,
    nodes: &serde_json::Value,
    edges: &serde_json::Value,
) -> Result<Vec<Finding>, String> {
    if !nodes.is_array() {
        return Err("nodes 必须是 JSON 数组".into());
    }
    if !edges.is_array() {
        return Err("edges 必须是 JSON 数组".into());
    }
    let wf = WorkflowSnapshot {
        id: 0,
        slug: String::new(),
        name: String::new(),
        department: None,
        trigger_type: trigger_type.to_string(),
        input_schema: input_schema.cloned(),
        nodes: nodes.clone(),
        edges: edges.clone(),
    };
    let (_red, mut rules) = review_local(&wf);
    sort_findings(&mut rules);
    Ok(rules)
}

pub fn to_review_item(wf: &WorkflowSnapshot, rules: Vec<Finding>, ai: AiResult) -> ReviewItem {
    ReviewItem {
        workflow: WorkflowMeta {
            id: wf.id,
            slug: wf.slug.clone(),
            name: wf.name.clone(),
            department: wf.department.clone(),
        },
        rules,
        ai_findings: ai.findings,
        ai_status: ai.status,
        ai_error: ai.error,
    }
}

pub fn review_item_json(item: &ReviewItem) -> serde_json::Value {
    let mut v = serde_json::json!({
        "workflow": item.workflow,
        "rules": item.rules,
        "ai_findings": item.ai_findings,
        "ai_status": item.ai_status.as_str(),
    });
    if item.ai_status == AiStatus::Error {
        if let Some(err) = &item.ai_error {
            v.as_object_mut()
                .expect("object")
                .insert("ai_error".into(), serde_json::json!(err));
        }
    }
    v
}

pub fn batch_json(summary: &BatchSummary, items: &[ReviewItem]) -> serde_json::Value {
    serde_json::json!({
        "summary": {
            "scanned": summary.scanned,
            "rules_hit": summary.rules_hit,
            "sent_to_ai": summary.sent_to_ai,
            "ai_ok": summary.ai_ok,
            "ai_error": summary.ai_error,
        },
        "items": items.iter().map(review_item_json).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod orch_tests {
    use super::*;
    use crate::workflow_qa::finding::{Finding, Severity};
    use serde_json::json;

    fn f(code: &str, sev: Severity) -> Finding {
        Finding {
            severity: sev,
            code: code.into(),
            title: code.into(),
            detail: String::new(),
            node_id: Some("n".into()),
            node_label: None,
            evidence: String::new(),
        }
    }

    #[test]
    fn clamp_max_ai_bounds() {
        assert_eq!(clamp_max_ai(None), 20);
        assert_eq!(clamp_max_ai(Some(0)), 0);
        assert_eq!(clamp_max_ai(Some(2)), 2);
        assert_eq!(clamp_max_ai(Some(999)), 50);
        assert_eq!(clamp_max_ai(Some(-1)), 20);
    }

    #[test]
    fn pick_ai_respects_max_and_priority() {
        let crit = vec![f("hardcoded_secret", Severity::Crit)];
        let huge = vec![f("huge_code", Severity::Med)];
        let empty: Vec<Finding> = vec![];
        let cands = vec![
            (1, empty.clone(), true),
            (2, huge.clone(), true),
            (3, crit.clone(), false),
            (4, huge.clone(), true),
        ];
        let ids = pick_ai_ids(&cands, 2);
        assert_eq!(ids, vec![3, 2]);
        assert_eq!(pick_ai_ids(&cands, 50).len(), 3);
    }

    #[test]
    fn snapshot_adapters() {
        let inner = json!({
            "id": 7, "slug": "s", "name": "N", "department": "共享",
            "trigger_type": "endpoint", "nodes": [], "edges": []
        });
        let get = json!({ "workflow": inner, "deps_status": {} });
        let s = snapshot_from_get_json(&get).unwrap();
        assert_eq!(s.id, 7);
        assert_eq!(s.department.as_deref(), Some("共享"));
        let listed = snapshot_from_list_item(&inner).unwrap();
        assert_eq!(listed.slug, "s");
    }

    #[test]
    fn review_local_redacts_before_rules() {
        let wf = WorkflowSnapshot {
            id: 1,
            slug: "c".into(),
            name: "c".into(),
            department: None,
            trigger_type: "manual".into(),
            input_schema: None,
            nodes: json!([{
                "id": "h", "type": "http_call",
                "config": { "headers": { "Authorization": "Bearer dw_abc.secretvalue" } }
            }]),
            edges: json!([]),
        };
        let (red, rules) = review_local(&wf);
        assert!(!red.nodes.to_string().contains("secretvalue"));
        assert!(rules.iter().any(|r| r.code == "hardcoded_secret"));
        assert!(rules.iter().all(|r| !r.evidence.contains("secretvalue")));
    }

    #[test]
    fn lint_unsaved_rejects_non_array_and_sorts() {
        assert!(lint_unsaved("endpoint", None, &json!({}), &json!([])).is_err());
        let nodes = json!([
            { "id": "h", "type": "http_call", "config": { "headers": { "Authorization": "Bearer ***" } } },
            { "id": "c", "type": "code", "config": { "code": "http.get(u)" } }
        ]);
        let out = lint_unsaved("endpoint", None, &nodes, &json!([])).unwrap();
        let idx_secret = out
            .iter()
            .position(|f| f.code == "hardcoded_secret")
            .unwrap();
        let idx_style = out
            .iter()
            .position(|f| f.code == "style.http_in_code")
            .unwrap();
        assert!(idx_secret < idx_style);
        assert!(out.iter().any(|f| f.code == "style.missing_input_schema"));
    }
}
