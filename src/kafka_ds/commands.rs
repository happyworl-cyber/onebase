//! Allowlisted Kafka operations shared by API and workflow callers.

use std::time::Duration;

use rdkafka::admin::{AdminClient, AdminOptions, NewTopic, TopicReplication};
use rdkafka::client::DefaultClientContext;
use rdkafka::error::RDKafkaErrorCode;
use rdkafka::message::{Header, OwnedHeaders};
use rdkafka::producer::{FutureProducer, FutureRecord, Producer};
use rdkafka::util::Timeout;
use serde_json::{json, Value};

use crate::error::{AppError, Result};
use crate::kafka_ds::client_cache::build_client_config;
use crate::kafka_ds::models::KafkaConnection;

const OP_TIMEOUT: Duration = Duration::from_secs(10);

pub const SUPPORTED_OPS: &[&str] = &["produce", "list_topics"];

pub fn is_write_op(op: &str) -> bool {
    op.eq_ignore_ascii_case("produce")
}

pub async fn execute(producer: &FutureProducer, op: &str, args: &Value) -> Result<Value> {
    match op.to_ascii_lowercase().as_str() {
        "produce" => {
            let topic = required_string(args, "topic")?;
            // Template `{{loop.item.article_id}}` often resolves to a JSON number;
            // Kafka record keys are bytes/strings — coerce numbers (and bools).
            let key = optional_kafka_key(args)?;
            let value = args
                .get("value")
                .ok_or_else(|| AppError::InvalidQuery("缺少参数 `value`".into()))?;
            let value = match value {
                Value::String(value) => value.clone(),
                Value::Object(_) | Value::Array(_) => value.to_string(),
                _ => {
                    return Err(AppError::InvalidQuery(
                        "参数 `value` 必须是字符串、对象或数组".into(),
                    ));
                }
            };
            let headers = args.get("headers").unwrap_or(&Value::Null);
            produce(producer, topic, key.as_deref(), &value, headers).await
        }
        "list_topics" => {
            let metadata = producer
                .client()
                .fetch_metadata(None, Timeout::After(OP_TIMEOUT))
                .map_err(|error| {
                    AppError::ServiceUnavailable(format!("Kafka 获取 topic 列表失败: {error}"))
                })?;
            Ok(metadata_json(&metadata))
        }
        other => Err(AppError::InvalidQuery(format!(
            "不支持的 Kafka 操作 `{other}`（支持：{}）",
            SUPPORTED_OPS.join(", ")
        ))),
    }
}

pub async fn produce(
    producer: &FutureProducer,
    topic: &str,
    key: Option<&str>,
    value: &str,
    headers: &Value,
) -> Result<Value> {
    let mut record = FutureRecord::to(topic).payload(value);
    if let Some(key) = key {
        record = record.key(key);
    }
    if !headers.is_null() {
        let object = headers
            .as_object()
            .ok_or_else(|| AppError::InvalidQuery("参数 `headers` 必须是对象".into()))?;
        let mut owned = OwnedHeaders::new_with_capacity(object.len());
        for (name, value) in object {
            let value = value.as_str().ok_or_else(|| {
                AppError::InvalidQuery(format!("Kafka header `{name}` 的值必须是字符串"))
            })?;
            owned = owned.insert(Header {
                key: name,
                value: Some(value),
            });
        }
        record = record.headers(owned);
    }

    let delivery = tokio::time::timeout(
        OP_TIMEOUT,
        producer.send(record, Timeout::After(OP_TIMEOUT)),
    )
    .await
    .map_err(|_| {
        AppError::ServiceUnavailable(format!("Kafka produce 超时（>{}s）", OP_TIMEOUT.as_secs()))
    })?
    .map_err(|(error, _)| AppError::Internal(format!("Kafka produce 失败: {error}")))?;

    Ok(json!({
        "topic": topic,
        "partition": delivery.0,
        "offset": delivery.1,
        "key": key,
    }))
}

pub async fn list_topics(conn: &KafkaConnection) -> Result<Value> {
    let password = decrypt_password(conn)?;
    let admin = build_client_config(conn, password.as_deref())
        .create::<AdminClient<DefaultClientContext>>()
        .map_err(|error| AppError::Internal(format!("Kafka metadata client 创建失败: {error}")))?;
    let metadata = admin
        .inner()
        .fetch_metadata(None, Timeout::After(connection_timeout(conn)))
        .map_err(|error| {
            AppError::ServiceUnavailable(format!("Kafka 获取 topic 列表失败: {error}"))
        })?;
    Ok(metadata_json(&metadata))
}

/// Validate topic creation parameters. Returns trimmed name on success.
pub fn validate_new_topic(
    name: &str,
    num_partitions: i32,
    replication_factor: i32,
) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidQuery("topic 名称不能为空".into()));
    }
    if name == "." || name == ".." {
        return Err(AppError::InvalidQuery("topic 名称非法".into()));
    }
    if name.len() > 249 {
        return Err(AppError::InvalidQuery(
            "topic 名称过长（最多 249 字符）".into(),
        ));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(AppError::InvalidQuery(
            "topic 名称仅允许字母、数字、点、下划线、连字符".into(),
        ));
    }
    if !(1..=100).contains(&num_partitions) {
        return Err(AppError::InvalidQuery(
            "num_partitions 须在 1..=100".into(),
        ));
    }
    if !(1..=10).contains(&replication_factor) {
        return Err(AppError::InvalidQuery(
            "replication_factor 须在 1..=10".into(),
        ));
    }
    Ok(name.to_string())
}

pub async fn create_topic(
    conn: &KafkaConnection,
    name: &str,
    num_partitions: i32,
    replication_factor: i32,
) -> Result<Value> {
    let name = validate_new_topic(name, num_partitions, replication_factor)?;
    let password = decrypt_password(conn)?;
    let admin = build_client_config(conn, password.as_deref())
        .create::<AdminClient<DefaultClientContext>>()
        .map_err(|error| AppError::Internal(format!("Kafka admin client 创建失败: {error}")))?;

    let topic = NewTopic::new(
        &name,
        num_partitions,
        TopicReplication::Fixed(replication_factor),
    );
    let timeout = connection_timeout(conn);
    let opts = AdminOptions::new().operation_timeout(Some(timeout));
    let results = tokio::time::timeout(timeout + Duration::from_secs(5), admin.create_topics(&[topic], &opts))
        .await
        .map_err(|_| AppError::ServiceUnavailable("Kafka 创建 topic 超时".into()))?
        .map_err(|error| {
            AppError::ServiceUnavailable(format!("Kafka 创建 topic 失败: {error}"))
        })?;

    let result = results.into_iter().next().ok_or_else(|| {
        AppError::Internal("Kafka 创建 topic 未返回结果".into())
    })?;

    match result {
        Ok(_) => Ok(json!({
            "ok": true,
            "topic": name,
            "num_partitions": num_partitions,
            "replication_factor": replication_factor,
        })),
        Err((_, RDKafkaErrorCode::TopicAlreadyExists)) => Err(AppError::InvalidQuery(format!(
            "topic 已存在: {name}"
        ))),
        Err((_, code)) => Err(AppError::ServiceUnavailable(format!(
            "Kafka 创建 topic 失败: {code}"
        ))),
    }
}

pub async fn health_probe(conn: &KafkaConnection) -> Result<Value> {
    let password = decrypt_password(conn)?;
    let admin = build_client_config(conn, password.as_deref())
        .create::<AdminClient<DefaultClientContext>>()
        .map_err(|error| AppError::Internal(format!("Kafka health client 创建失败: {error}")))?;
    let metadata = admin
        .inner()
        .fetch_metadata(None, Timeout::After(connection_timeout(conn)))
        .map_err(|error| AppError::ServiceUnavailable(format!("Kafka 健康检查失败: {error}")))?;
    Ok(json!({
        "ok": true,
        "broker_count": metadata.brokers().len(),
    }))
}

/// List consumer groups (membership / state). Does not compute partition lag.
pub async fn list_consumer_groups(conn: &KafkaConnection) -> Result<Value> {
    let password = decrypt_password(conn)?;
    let admin = build_client_config(conn, password.as_deref())
        .create::<AdminClient<DefaultClientContext>>()
        .map_err(|error| AppError::Internal(format!("Kafka admin client 创建失败: {error}")))?;
    let group_list = admin
        .inner()
        .fetch_group_list(None, Timeout::After(connection_timeout(conn)))
        .map_err(|error| {
            AppError::ServiceUnavailable(format!("Kafka 列出消费组失败: {error}"))
        })?;

    let mut groups: Vec<Value> = group_list
        .groups()
        .iter()
        .map(|group| {
            let members: Vec<Value> = group
                .members()
                .iter()
                .map(|member| {
                    json!({
                        "member_id": member.id(),
                        "client_id": member.client_id(),
                        "client_host": member.client_host(),
                    })
                })
                .collect();
            json!({
                "name": group.name(),
                "state": group.state(),
                "protocol": group.protocol(),
                "protocol_type": group.protocol_type(),
                "member_count": members.len(),
                "members": members,
            })
        })
        .collect();
    groups.sort_by(|a, b| {
        a.get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .cmp(b.get("name").and_then(|v| v.as_str()).unwrap_or(""))
    });

    Ok(json!({
        "groups": groups,
        "group_count": groups.len(),
    }))
}

fn decrypt_password(conn: &KafkaConnection) -> Result<Option<String>> {
    match conn.sasl_password_enc.as_deref() {
        Some(encrypted) if !encrypted.is_empty() => {
            Ok(Some(crate::crypto::decrypt_secret(encrypted)?))
        }
        _ => Ok(None),
    }
}

fn connection_timeout(conn: &KafkaConnection) -> Duration {
    Duration::from_secs(conn.connect_timeout_secs.max(1) as u64)
}

fn metadata_json(metadata: &rdkafka::metadata::Metadata) -> Value {
    let mut topics: Vec<&str> = metadata.topics().iter().map(|topic| topic.name()).collect();
    topics.sort_unstable();
    json!({
        "topics": topics,
        "broker_count": metadata.brokers().len(),
    })
}

fn required_string<'a>(args: &'a Value, name: &str) -> Result<&'a str> {
    args.get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::InvalidQuery(format!("缺少字符串参数 `{name}`")))
}

/// Kafka produce `key`: string, or number/bool coerced to string. Empty string → None.
fn optional_kafka_key(args: &Value) -> Result<Option<String>> {
    match args.get("key") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            if value.is_empty() {
                Ok(None)
            } else {
                Ok(Some(value.clone()))
            }
        }
        Some(Value::Number(n)) => Ok(Some(n.to_string())),
        Some(Value::Bool(b)) => Ok(Some(b.to_string())),
        Some(_) => Err(AppError::InvalidQuery(
            "参数 `key` 必须是字符串或数字".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn produce_is_write_op() {
        assert!(is_write_op("produce"));
        assert!(!is_write_op("list_topics"));
    }

    #[test]
    fn validate_new_topic_accepts_common_names() {
        assert_eq!(
            validate_new_topic("onebase.ai-close-ticket", 3, 1).unwrap(),
            "onebase.ai-close-ticket"
        );
        assert_eq!(validate_new_topic("  orders_v1  ", 1, 1).unwrap(), "orders_v1");
    }

    #[test]
    fn validate_new_topic_rejects_bad_name() {
        assert!(validate_new_topic("", 1, 1).is_err());
        assert!(validate_new_topic(".", 1, 1).is_err());
        assert!(validate_new_topic("bad name", 1, 1).is_err());
        assert!(validate_new_topic(&"a".repeat(250), 1, 1).is_err());
    }

    #[test]
    fn validate_new_topic_rejects_out_of_range() {
        assert!(validate_new_topic("t", 0, 1).is_err());
        assert!(validate_new_topic("t", 101, 1).is_err());
        assert!(validate_new_topic("t", 1, 0).is_err());
        assert!(validate_new_topic("t", 1, 11).is_err());
    }

    #[test]
    fn optional_kafka_key_coerces_number() {
        let args = json!({ "key": 639582 });
        assert_eq!(optional_kafka_key(&args).unwrap().as_deref(), Some("639582"));
        let args = json!({ "key": "aid-1" });
        assert_eq!(optional_kafka_key(&args).unwrap().as_deref(), Some("aid-1"));
        let args = json!({ "key": "" });
        assert_eq!(optional_kafka_key(&args).unwrap(), None);
        let args = json!({});
        assert_eq!(optional_kafka_key(&args).unwrap(), None);
        assert!(optional_kafka_key(&json!({ "key": ["x"] })).is_err());
    }
}
