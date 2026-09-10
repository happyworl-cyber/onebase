use crate::workflow_qa::{truncate_codes_for_query, Finding, Severity, WorkflowSnapshot};
use serde_json::{json, Value};

const QUERY_INSTRUCTION: &str = "你是 PlaneOS 工作流质量审查员。只输出一个 JSON 数组（或 {\"findings\":[...]}），不要 Markdown。\n每项字段：severity(crit|high|med|low)、code（必须 ai. 前缀）、title、detail、node_id（可空）、node_label（可空）、evidence（已脱敏短摘录）。\n不要重复 rules 里已有的同一 code+node_id。重点：伪脱敏、该用平台节点却手写、ctx.nodes.xxx 与图不一致。\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiStatus {
    Ok,
    Skipped,
    Error,
}

impl AiStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Skipped => "skipped",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Clone)]
pub struct AiResult {
    pub status: AiStatus,
    pub findings: Vec<Finding>,
    pub error: Option<String>,
}

fn first_nonempty_str(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

pub fn extract_answer_text(body: &Value) -> Option<String> {
    if let Some(text) = first_nonempty_str(body.get("data")) {
        return Some(text);
    }
    if let Some(data) = body.get("data") {
        if let Some(text) = first_nonempty_str(data.get("text")) {
            return Some(text);
        }
        if let Some(text) = first_nonempty_str(data.get("output")) {
            return Some(text);
        }
    }
    first_nonempty_str(body.get("text"))
        .or_else(|| first_nonempty_str(body.get("output")))
        .or_else(|| first_nonempty_str(body.get("answer")))
}

fn slice_jsonish(text: &str) -> Option<&str> {
    let trimmed = text.trim();
    if let (Some(start), Some(end)) = (trimmed.find('['), trimmed.rfind(']')) {
        if start < end {
            return Some(&trimmed[start..=end]);
        }
    }
    if let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}')) {
        if start < end {
            return Some(&trimmed[start..=end]);
        }
    }
    None
}

fn severity_from_str(value: &str) -> Option<Severity> {
    match value {
        "crit" => Some(Severity::Crit),
        "high" => Some(Severity::High),
        "med" => Some(Severity::Med),
        "low" => Some(Severity::Low),
        _ => None,
    }
}

fn finding_from_value(value: &Value) -> Option<Finding> {
    let severity = value
        .get("severity")
        .and_then(Value::as_str)
        .and_then(severity_from_str)?;
    let code = value
        .get("code")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())?;
    let title = value
        .get("title")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())?;
    Some(Finding {
        severity,
        code: code.to_string(),
        title: title.to_string(),
        detail: value
            .get("detail")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        node_id: value
            .get("node_id")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_string),
        node_label: value
            .get("node_label")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_string),
        evidence: value
            .get("evidence")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    })
}

pub fn parse_findings_json(text: &str) -> Result<Vec<Finding>, String> {
    let candidate = slice_jsonish(text).unwrap_or(text.trim());
    let value: Value = serde_json::from_str(candidate).map_err(|error| error.to_string())?;
    let findings = if let Some(array) = value.as_array() {
        array
    } else if let Some(array) = value.get("findings").and_then(Value::as_array) {
        array
    } else {
        return Err("findings JSON 既不是数组也不是 {findings:[]}".into());
    };
    Ok(findings.iter().filter_map(finding_from_value).collect())
}

pub fn interpret_http(status: u16, body: &Value) -> AiResult {
    if !(200..300).contains(&status) {
        return AiResult {
            status: AiStatus::Error,
            findings: vec![],
            error: Some(format!("AI Provider 返回 HTTP {status}")),
        };
    }
    let Some(text) = extract_answer_text(body) else {
        return AiResult {
            status: AiStatus::Error,
            findings: vec![],
            error: Some("AI Provider 响应中没有文本".into()),
        };
    };
    match parse_findings_json(&text) {
        Ok(findings) => AiResult {
            status: AiStatus::Ok,
            findings,
            error: None,
        },
        Err(_) => AiResult {
            status: AiStatus::Error,
            findings: vec![],
            error: Some("AI Provider 未返回合法的检查结果 JSON".into()),
        },
    }
}

pub fn build_query(workflow: &WorkflowSnapshot, rules: &[Finding]) -> String {
    let payload = json!({
        "workflow": {
            "id": workflow.id,
            "slug": workflow.slug,
            "name": workflow.name,
            "department": workflow.department,
            "trigger_type": workflow.trigger_type,
        },
        "nodes": truncate_codes_for_query(&workflow.nodes),
        "edges": workflow.edges,
        "rules": rules,
    });
    format!("{QUERY_INSTRUCTION}{payload}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_array_and_wrapped_findings() {
        let direct = r#"[{"severity":"high","code":"ai.noop","title":"伪脱敏"}]"#;
        assert_eq!(parse_findings_json(direct).unwrap()[0].code, "ai.noop");

        let wrapped =
            r#"{"findings":[{"severity":"med","code":"ai.context","title":"上下文错误"}]}"#;
        assert_eq!(parse_findings_json(wrapped).unwrap().len(), 1);
    }

    #[test]
    fn sanitizes_provider_http_errors() {
        let result = interpret_http(401, &json!({"error": "secret-token"}));
        assert_eq!(result.status, AiStatus::Error);
        assert!(!result.error.unwrap().contains("secret-token"));
    }
}
