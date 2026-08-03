use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KafkaTriggerConfig {
    pub connection_id: i64,
    pub topic: String,
    pub group_id: String,
    pub auto_offset_reset: String,
    pub value_format: String,
}

pub fn parse_kafka_trigger_config(
    workflow_id: i32,
    trigger_config: &Value,
) -> Option<KafkaTriggerConfig> {
    // Accept number or numeric string — UI/JSON 偶发写成 "1" 时不应静默跳过 consumer。
    let connection_id = match trigger_config.get("connection_id")? {
        Value::Number(n) => n.as_i64()?,
        Value::String(s) => s.trim().parse::<i64>().ok()?,
        _ => return None,
    };
    if connection_id <= 0 {
        return None;
    }
    let topic = trigger_config.get("topic")?.as_str()?.trim();
    if topic.is_empty() {
        return None;
    }

    let group_id = trigger_config
        .get("group_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("onebase-wf-{workflow_id}"));

    let auto_offset_reset = trigger_config
        .get("auto_offset_reset")
        .and_then(|v| v.as_str())
        .unwrap_or("latest");
    if auto_offset_reset != "latest" && auto_offset_reset != "earliest" {
        return None;
    }

    let value_format = trigger_config
        .get("value_format")
        .and_then(|v| v.as_str())
        .unwrap_or("json");
    if value_format != "json" && value_format != "text" {
        return None;
    }

    Some(KafkaTriggerConfig {
        connection_id,
        topic: topic.to_string(),
        group_id,
        auto_offset_reset: auto_offset_reset.to_string(),
        value_format: value_format.to_string(),
    })
}

pub fn build_kafka_trigger_data(
    connection_id: i64,
    topic: &str,
    partition: i32,
    offset: i64,
    key: Option<&str>,
    headers: Value,
    value_raw: &str,
    value_format: &str,
) -> Value {
    let payload = if value_format == "text" {
        Value::String(value_raw.to_string())
    } else {
        serde_json::from_str(value_raw).unwrap_or(Value::Null)
    };

    let mut kafka = json!({
        "connection_id": connection_id,
        "topic": topic,
        "partition": partition,
        "offset": offset,
        "headers": headers,
        "value_raw": value_raw,
    });

    if let Some(k) = key {
        kafka["key"] = json!(k);
    }

    json!({
        "kafka": kafka,
        "payload": payload,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn default_group_id_uses_workflow_id() {
        let cfg = parse_kafka_trigger_config(
            42,
            &json!({ "connection_id": 1, "topic": "orders" }),
        )
        .unwrap();
        assert_eq!(cfg.group_id, "onebase-wf-42");
        assert_eq!(cfg.auto_offset_reset, "latest");
        assert_eq!(cfg.value_format, "json");
    }

    #[test]
    fn connection_id_accepts_numeric_string() {
        let cfg = parse_kafka_trigger_config(
            7,
            &json!({ "connection_id": "3", "topic": "t", "group_id": "g" }),
        )
        .unwrap();
        assert_eq!(cfg.connection_id, 3);
        assert!(parse_kafka_trigger_config(
            7,
            &json!({ "connection_id": "0", "topic": "t" }),
        )
        .is_none());
    }

    #[test]
    fn build_trigger_data_parses_json_payload() {
        let v = build_kafka_trigger_data(
            1,
            "orders",
            0,
            9,
            Some("k"),
            json!({"x-a": "1"}),
            r#"{"order_id":7}"#,
            "json",
        );
        assert_eq!(v["payload"]["order_id"], 7);
        assert_eq!(v["kafka"]["offset"], 9);
    }

    #[test]
    fn build_trigger_data_text_keeps_string_payload() {
        let v = build_kafka_trigger_data(
            1, "t", 0, 1, None, json!({}), "hello", "text",
        );
        assert_eq!(v["payload"], "hello");
    }
}
