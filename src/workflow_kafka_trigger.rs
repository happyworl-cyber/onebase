//! Kafka → 工作流触发器。
//!
//! 每个启用的 Kafka 工作流拥有独立 consumer。消息只有在工作流执行成功后才提交 offset，
//! 从而提供 at-least-once 处理语义。

use std::collections::HashMap;
use std::time::Duration;

use rdkafka::consumer::{CommitMode, Consumer, StreamConsumer};
use rdkafka::message::{Headers, Message};
use serde_json::{Map, Value};
use sqlx::PgPool;
use tokio::task::JoinHandle;

use crate::kafka_ds;
use crate::kafka_ds::trigger_config::{
    build_kafka_trigger_data, parse_kafka_trigger_config, KafkaTriggerConfig,
};
use crate::workflow_handlers::{self, Workflow};

const REFRESH_INTERVAL: Duration = Duration::from_secs(10);
const RETRY_DELAY: Duration = Duration::from_secs(2);

struct RunningConsumer {
    config: KafkaTriggerConfig,
    handle: JoinHandle<()>,
}

fn kafka_config_for_workflow(workflow: &Workflow) -> Option<(i32, KafkaTriggerConfig)> {
    if workflow.trigger_type != "kafka" || !workflow.is_enabled {
        return None;
    }

    parse_kafka_trigger_config(workflow.id, &workflow.trigger_config)
        .map(|config| (workflow.id, config))
}

/// 启动 Kafka 工作流触发器管理任务。
///
/// 每 10 秒同步一次启用中的 Kafka 工作流。每个 workflow id 独占一个 consumer；
/// 禁用工作流或修改其消费配置时，会停止旧 consumer 并按新配置重建。
pub fn start_kafka_trigger(main_pool: PgPool) -> JoinHandle<()> {
    tokio::spawn(async move {
        tracing::info!(
            interval = ?REFRESH_INTERVAL,
            "工作流 Kafka 触发器管理任务已启动"
        );
        let mut running: HashMap<i32, RunningConsumer> = HashMap::new();

        loop {
            match load_active_kafka_configs(&main_pool).await {
                Ok(configs) => {
                    running.retain(|workflow_id, running_consumer| {
                        let current = configs.get(workflow_id);
                        let keep = current == Some(&running_consumer.config)
                            && !running_consumer.handle.is_finished();
                        if !keep {
                            tracing::info!(workflow_id, "停止工作流 Kafka consumer");
                            running_consumer.handle.abort();
                        }
                        keep
                    });

                    for (workflow_id, config) in configs {
                        if running.contains_key(&workflow_id) {
                            continue;
                        }

                        tracing::info!(
                            workflow_id,
                            connection_id = config.connection_id,
                            topic = %config.topic,
                            group_id = %config.group_id,
                            "启动工作流 Kafka consumer"
                        );
                        let handle = tokio::spawn(run_consumer(
                            main_pool.clone(),
                            workflow_id,
                            config.clone(),
                        ));
                        running.insert(workflow_id, RunningConsumer { config, handle });
                    }
                }
                Err(error) => {
                    tracing::warn!(error = %error, "加载工作流 Kafka 配置失败（保留上次）")
                }
            }

            tokio::time::sleep(REFRESH_INTERVAL).await;
        }
    })
}

async fn load_active_kafka_configs(
    pool: &PgPool,
) -> Result<HashMap<i32, KafkaTriggerConfig>, sqlx::Error> {
    let workflows = sqlx::query_as::<_, Workflow>(
        "SELECT * FROM management.workflows \
         WHERE is_enabled = true AND trigger_type = 'kafka'",
    )
    .fetch_all(pool)
    .await?;

    Ok(workflows
        .iter()
        .filter_map(kafka_config_for_workflow)
        .collect())
}

async fn run_consumer(main_pool: PgPool, workflow_id: i32, config: KafkaTriggerConfig) {
    let connection = match kafka_ds::fetch_active(&main_pool, config.connection_id).await {
        Ok(connection) => connection,
        Err(error) => {
            tracing::warn!(
                workflow_id,
                connection_id = config.connection_id,
                error = %error,
                "Kafka 连接不存在或已禁用，停止 consumer"
            );
            return;
        }
    };

    let password = match connection.sasl_password_enc.as_deref() {
        Some(encrypted) if !encrypted.is_empty() => {
            match crate::crypto::decrypt_secret(encrypted) {
                Ok(password) => Some(password),
                Err(error) => {
                    tracing::error!(
                        workflow_id,
                        connection_id = config.connection_id,
                        error = %error,
                        "解密 Kafka 连接密码失败，停止 consumer"
                    );
                    return;
                }
            }
        }
        _ => None,
    };

    let consumer: StreamConsumer =
        match kafka_ds::client_cache::build_client_config(&connection, password.as_deref())
            .set("group.id", &config.group_id)
            .set("enable.auto.commit", "false")
            .set("auto.offset.reset", &config.auto_offset_reset)
            .create()
        {
            Ok(consumer) => consumer,
            Err(error) => {
                tracing::error!(
                    workflow_id,
                    connection_id = config.connection_id,
                    error = %error,
                    "创建工作流 Kafka consumer 失败"
                );
                return;
            }
        };

    if let Err(error) = consumer.subscribe(&[&config.topic]) {
        tracing::error!(
            workflow_id,
            topic = %config.topic,
            error = %error,
            "订阅工作流 Kafka topic 失败"
        );
        return;
    }

    tracing::info!(
        workflow_id,
        connection_id = config.connection_id,
        topic = %config.topic,
        group_id = %config.group_id,
        "工作流 Kafka consumer 已就绪"
    );

    loop {
        let message = match consumer.recv().await {
            Ok(message) => message,
            Err(error) => {
                tracing::warn!(
                    workflow_id,
                    error = %error,
                    "工作流 Kafka consumer 接收消息失败，稍后重试"
                );
                tokio::time::sleep(RETRY_DELAY).await;
                continue;
            }
        };

        let workflow = match fetch_current_workflow(&main_pool, workflow_id, &config).await {
            Ok(Some(workflow)) => workflow,
            Ok(None) => {
                tracing::info!(workflow_id, "Kafka 工作流已禁用或配置已变更，停止 consumer");
                return;
            }
            Err(error) => {
                tracing::error!(
                    workflow_id,
                    error = %error,
                    "查询 Kafka 工作流失败，消息暂不提交"
                );
                tokio::time::sleep(RETRY_DELAY).await;
                // 退出后由管理任务重建 consumer，从上次 committed offset 重读（at-least-once）。
                // 不可 continue：StreamConsumer 本地位点已前进，不 commit 再 recv 会跳过该消息。
                return;
            }
        };

        let value_raw = String::from_utf8_lossy(message.payload().unwrap_or_default());
        let key = message
            .key()
            .map(|key| String::from_utf8_lossy(key).into_owned());
        let trigger_data = build_kafka_trigger_data(
            config.connection_id,
            message.topic(),
            message.partition(),
            message.offset(),
            key.as_deref(),
            message_headers(&message),
            &value_raw,
            &config.value_format,
        );

        match workflow_handlers::execute_workflow_internal(
            &main_pool,
            &workflow,
            "kafka",
            &trigger_data,
            None,
            crate::workflow_engine::ApiKeyWriteGuard::Off,
        )
        .await
        {
            Ok(_) => {
                if let Err(error) = consumer.commit_message(&message, CommitMode::Sync) {
                    tracing::error!(
                        workflow_id,
                        topic = message.topic(),
                        partition = message.partition(),
                        offset = message.offset(),
                        error = %error,
                        "Kafka 工作流执行成功但提交 offset 失败"
                    );
                    tokio::time::sleep(RETRY_DELAY).await;
                    return;
                }
            }
            Err(error) => {
                tracing::error!(
                    workflow_id,
                    topic = message.topic(),
                    partition = message.partition(),
                    offset = message.offset(),
                    error = %error,
                    "Kafka 触发的工作流执行失败，消息暂不提交"
                );
                tokio::time::sleep(RETRY_DELAY).await;
                // 退出后由管理任务重建 consumer，从上次 committed offset 重读（at-least-once）。
                // 不可 continue：StreamConsumer 本地位点已前进，不 commit 再 recv 会跳过该消息。
                return;
            }
        }
    }
}

async fn fetch_current_workflow(
    pool: &PgPool,
    workflow_id: i32,
    expected_config: &KafkaTriggerConfig,
) -> Result<Option<Workflow>, sqlx::Error> {
    let workflow = sqlx::query_as::<_, Workflow>(
        "SELECT * FROM management.workflows \
         WHERE id = $1 AND is_enabled = true AND trigger_type = 'kafka'",
    )
    .bind(workflow_id)
    .fetch_optional(pool)
    .await?;

    Ok(workflow.filter(|workflow| {
        parse_kafka_trigger_config(workflow.id, &workflow.trigger_config).as_ref()
            == Some(expected_config)
    }))
}

fn message_headers<M: Message>(message: &M) -> Value {
    let mut values = Map::new();
    if let Some(headers) = message.headers() {
        for header in headers.iter() {
            let value = header
                .value
                .map(|bytes| Value::String(String::from_utf8_lossy(bytes).into_owned()))
                .unwrap_or(Value::Null);
            values.insert(header.key.to_string(), value);
        }
    }
    Value::Object(values)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow_handlers::Workflow;
    use serde_json::{json, Value};

    fn workflow(id: i32, trigger_type: &str, is_enabled: bool, trigger_config: Value) -> Workflow {
        Workflow {
            id,
            tenant_id: Some(7),
            database_id: None,
            name: format!("workflow-{id}"),
            slug: format!("workflow-{id}"),
            description: None,
            category: None,
            department: None,
            trigger_type: trigger_type.to_string(),
            trigger_config,
            nodes: json!([]),
            edges: json!([]),
            dependencies: json!({}),
            is_enabled,
            timeout_ms: 30_000,
            max_retries: 0,
            alert_webhook_url: None,
            alert_webhook_template: None,
            alert_throttle_hours: 24,
            last_alert_sent_at: None,
            created_by: Some(1),
            created_by_name: None,
            created_by_email: None,
            created_at: chrono::NaiveDateTime::default(),
            updated_at: chrono::NaiveDateTime::default(),
        }
    }

    #[test]
    fn config_is_scoped_to_each_enabled_kafka_workflow() {
        let first = workflow(
            41,
            "kafka",
            true,
            json!({ "connection_id": 9, "topic": "orders" }),
        );
        let second = workflow(
            42,
            "kafka",
            true,
            json!({ "connection_id": 9, "topic": "orders" }),
        );

        let first = kafka_config_for_workflow(&first).unwrap();
        let second = kafka_config_for_workflow(&second).unwrap();

        assert_eq!(first.0, 41);
        assert_eq!(second.0, 42);
        assert_ne!(first.1.group_id, second.1.group_id);
    }

    #[test]
    fn non_kafka_or_disabled_workflow_has_no_config() {
        let manual = workflow(
            41,
            "manual",
            true,
            json!({ "connection_id": 9, "topic": "orders" }),
        );
        let disabled = workflow(
            42,
            "kafka",
            false,
            json!({ "connection_id": 9, "topic": "orders" }),
        );

        assert!(kafka_config_for_workflow(&manual).is_none());
        assert!(kafka_config_for_workflow(&disabled).is_none());
    }
}
