//! 工作流入参契约：显式 `input_schema` + `{{trigger.X}}` 扫描兜底。
//!
//! 接口文档 / MCP / 公开分享页只通过本模块解析入参，禁止再各写一套。

use serde_json::{json, Value};
use std::collections::HashSet;

use crate::error::{AppError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputSource {
    Schema,
    Scan,
}

impl InputSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Schema => "schema",
            Self::Scan => "scan",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputRequired {
    Yes,
    No,
    Conditional,
}

impl InputRequired {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Yes => "yes",
            Self::No => "no",
            Self::Conditional => "conditional",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DocInputField {
    pub field: String,
    pub type_name: Option<String>,
    pub description: Option<String>,
    pub required: InputRequired,
    pub example: Option<Value>,
    pub template: String,
}

impl DocInputField {
    pub fn to_json(&self) -> Value {
        json!({
            "field": self.field,
            "type": self.type_name,
            "description": self.description,
            "required": self.required.as_str(),
            "example": self.example,
            "template": self.template,
        })
    }
}

pub fn validate_input_schema(value: Option<&Value>) -> Result<Option<Value>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(v) if v.is_object() => Ok(Some(v.clone())),
        Some(_) => Err(AppError::InvalidQuery(
            "input_schema 必须是 JSON object 或 null".to_string(),
        )),
    }
}

/// 扫描所有节点 config 中的 `{{trigger.X}}` 引用，提取顶层字段名。
/// 与前端 collectTriggerFields 同一业务规则（正则 `/\{\{\s*trigger\./`）：
/// - 容忍 `{{` 与 `trigger` 之间的空白（引擎 resolve 路径时会 trim）；
/// - 字段名允许非 ASCII（中文等，引擎与 NODE_SPEC 示例都支持），用 is_alphanumeric。
pub fn scan_trigger_fields(nodes: &Value) -> Vec<String> {
    let raw = serde_json::to_string(nodes).unwrap_or_default();
    let chars: Vec<char> = raw.chars().collect();
    let n = chars.len();
    let mut fields: Vec<String> = Vec::new();
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

pub fn resolve_doc_inputs(
    input_schema: Option<&Value>,
    nodes: &Value,
) -> (InputSource, Vec<DocInputField>) {
    if let Some(schema) = input_schema {
        if schema.is_object() {
            return (InputSource::Schema, fields_from_schema(schema));
        }
    }
    let mut fields: Vec<DocInputField> = scan_trigger_fields(nodes)
        .into_iter()
        .map(|name| DocInputField {
            field: name.clone(),
            type_name: None,
            description: None,
            required: InputRequired::No,
            example: None,
            template: format!("{{{{trigger.{}}}}}", name),
        })
        .collect();
    fields.sort_by(|a, b| a.field.cmp(&b.field));
    (InputSource::Scan, fields)
}

pub fn sample_body_from_fields(fields: &[DocInputField]) -> Value {
    let mut map = serde_json::Map::new();
    for f in fields {
        let value = match &f.example {
            Some(ex) => ex.clone(),
            None => placeholder_for_type(f.type_name.as_deref(), &f.field),
        };
        map.insert(f.field.clone(), value);
    }
    Value::Object(map)
}

fn placeholder_for_type(ty: Option<&str>, field: &str) -> Value {
    match ty {
        Some("number") | Some("integer") => json!(0),
        Some("boolean") => json!(false),
        Some("object") => json!({}),
        Some("array") => json!([]),
        _ => json!(format!("<{}>", field)),
    }
}

fn required_name_set(value: Option<&Value>) -> HashSet<String> {
    value
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn collect_conditional_required(schema: &Value) -> HashSet<String> {
    let mut out = HashSet::new();
    for key in ["oneOf", "anyOf"] {
        if let Some(arr) = schema.get(key).and_then(|v| v.as_array()) {
            for branch in arr {
                out.extend(required_name_set(branch.get("required")));
            }
        }
    }
    out
}

fn fields_from_schema(schema: &Value) -> Vec<DocInputField> {
    let Some(properties) = schema.get("properties").and_then(|p| p.as_object()) else {
        return vec![];
    };
    let top_required = required_name_set(schema.get("required"));
    let conditional = collect_conditional_required(schema);
    let mut fields: Vec<DocInputField> = properties
        .iter()
        .map(|(name, prop)| {
            let prop_required = prop
                .get("required")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let required = if top_required.contains(name) || prop_required {
                InputRequired::Yes
            } else if conditional.contains(name) {
                InputRequired::Conditional
            } else {
                InputRequired::No
            };
            DocInputField {
                field: name.clone(),
                type_name: prop
                    .get("type")
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string()),
                description: prop
                    .get("description")
                    .and_then(|d| d.as_str())
                    .map(|s| s.to_string()),
                required,
                example: prop.get("example").cloned(),
                template: format!("{{{{trigger.{}}}}}", name),
            }
        })
        .collect();
    fields.sort_by(|a, b| a.field.cmp(&b.field));
    fields
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_scan_trigger_fields_nested_and_dedup() {
        let nodes = json!([
            { "id": "q", "type": "db_query", "config": { "sql": "SELECT * FROM t WHERE a = '{{trigger.user_id}}' AND b = '{{trigger.plan.name}}'" } },
            { "id": "t", "type": "transform", "config": { "output": { "x": "{{trigger.user_id}}", "y": "{{q.rows[0].id}}" } } }
        ]);
        let fields = scan_trigger_fields(&nodes);
        assert_eq!(fields, vec!["user_id".to_string(), "plan".to_string()]);
    }

    #[test]
    fn test_scan_trigger_fields_empty() {
        let nodes = json!([{ "id": "r", "type": "response", "config": { "body": {"ok": true} } }]);
        assert!(scan_trigger_fields(&nodes).is_empty());
    }

    #[test]
    fn test_scan_trigger_fields_whitespace_and_non_ascii() {
        let nodes = json!([
            { "id": "a", "type": "transform", "config": { "v": "{{ trigger.user_id }}" } },
            { "id": "b", "type": "transform", "config": { "v": "{{trigger.用户名}}" } }
        ]);
        let fields = scan_trigger_fields(&nodes);
        assert_eq!(fields, vec!["user_id".to_string(), "用户名".to_string()]);
    }

    #[test]
    fn resolve_null_schema_scans_nodes() {
        let nodes = json!([{
            "id": "t",
            "type": "transform",
            "config": { "v": "{{trigger.user_id}}" }
        }]);
        let (source, fields) = resolve_doc_inputs(None, &nodes);
        assert_eq!(source, InputSource::Scan);
        assert_eq!(
            fields.iter().map(|f| f.field.as_str()).collect::<Vec<_>>(),
            ["user_id"]
        );
        assert_eq!(fields[0].required, InputRequired::No);
        assert_eq!(fields[0].template, "{{trigger.user_id}}");
        assert!(fields[0].type_name.is_none());
    }

    #[test]
    fn resolve_schema_ignores_node_trigger_refs() {
        let schema = json!({
            "type": "object",
            "properties": {
                "email": { "type": "string", "description": "邮箱", "example": "a@b.com" },
                "password": { "type": "string", "required": true }
            },
            "required": ["password"],
            "oneOf": [{ "required": ["email"] }, { "required": ["phone"] }]
        });
        let nodes = json!([{
            "id": "c",
            "type": "code",
            "config": { "source": "{{trigger.other}}" }
        }]);
        let (source, fields) = resolve_doc_inputs(Some(&schema), &nodes);
        assert_eq!(source, InputSource::Schema);
        let names: Vec<_> = fields.iter().map(|f| f.field.as_str()).collect();
        assert_eq!(names, ["email", "password"]);
        let email = fields.iter().find(|f| f.field == "email").unwrap();
        assert_eq!(email.type_name.as_deref(), Some("string"));
        assert_eq!(email.description.as_deref(), Some("邮箱"));
        assert_eq!(email.required, InputRequired::Conditional);
        assert_eq!(email.example, Some(json!("a@b.com")));
        let password = fields.iter().find(|f| f.field == "password").unwrap();
        assert_eq!(password.required, InputRequired::Yes);
    }

    #[test]
    fn resolve_empty_properties_is_declared_empty() {
        let schema = json!({ "type": "object", "properties": {} });
        let nodes = json!([{
            "id": "t",
            "type": "transform",
            "config": { "v": "{{trigger.user_id}}" }
        }]);
        let (source, fields) = resolve_doc_inputs(Some(&schema), &nodes);
        assert_eq!(source, InputSource::Schema);
        assert!(fields.is_empty());
    }

    #[test]
    fn resolve_object_without_properties_is_declared_empty() {
        let schema = json!({ "type": "object" });
        let (source, fields) = resolve_doc_inputs(Some(&schema), &json!([]));
        assert_eq!(source, InputSource::Schema);
        assert!(fields.is_empty());
    }

    #[test]
    fn sample_body_prefers_example_then_type() {
        let fields = vec![
            DocInputField {
                field: "email".into(),
                type_name: Some("string".into()),
                description: None,
                required: InputRequired::Yes,
                example: Some(json!("a@b.com")),
                template: "{{trigger.email}}".into(),
            },
            DocInputField {
                field: "age".into(),
                type_name: Some("integer".into()),
                description: None,
                required: InputRequired::No,
                example: None,
                template: "{{trigger.age}}".into(),
            },
            DocInputField {
                field: "ok".into(),
                type_name: Some("boolean".into()),
                description: None,
                required: InputRequired::No,
                example: None,
                template: "{{trigger.ok}}".into(),
            },
        ];
        assert_eq!(
            sample_body_from_fields(&fields),
            json!({ "email": "a@b.com", "age": 0, "ok": false })
        );
    }

    #[test]
    fn validate_rejects_non_object() {
        assert!(validate_input_schema(Some(&json!([]))).is_err());
        assert!(validate_input_schema(Some(&json!("x"))).is_err());
        assert_eq!(validate_input_schema(None).unwrap(), None);
        assert_eq!(validate_input_schema(Some(&Value::Null)).unwrap(), None);
        assert!(validate_input_schema(Some(&json!({})))
            .unwrap()
            .unwrap()
            .is_object());
    }
}
