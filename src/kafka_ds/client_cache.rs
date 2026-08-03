//! Kafka producer cache, keyed by connection id.

use dashmap::DashMap;
use once_cell::sync::Lazy;
use rdkafka::producer::FutureProducer;
use rdkafka::ClientConfig;

use crate::error::{AppError, Result};
use crate::kafka_ds::models::KafkaConnection;

static CACHE: Lazy<DashMap<i64, FutureProducer>> = Lazy::new(DashMap::new);

/// Build the librdkafka configuration shared by producers and metadata clients.
pub(crate) fn build_client_config(conn: &KafkaConnection, password: Option<&str>) -> ClientConfig {
    let mut config = ClientConfig::new();
    let protocol = conn.security_protocol.trim();
    let timeout_ms = conn.connect_timeout_secs.max(1).saturating_mul(1000);

    config
        .set("bootstrap.servers", conn.brokers.trim())
        .set("security.protocol", protocol)
        .set("socket.timeout.ms", timeout_ms.to_string())
        .set("message.timeout.ms", timeout_ms.to_string());

    if protocol.starts_with("SASL_") {
        if let Some(mechanism) = conn
            .sasl_mechanism
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            config.set("sasl.mechanism", mechanism);
        }
        if let Some(username) = conn
            .sasl_username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            config.set("sasl.username", username);
        }
        if let Some(password) = password {
            config.set("sasl.password", password);
        }
    }

    if protocol.contains("SSL") {
        config.set(
            "enable.ssl.certificate.verification",
            (!conn.tls_insecure_skip_verify).to_string(),
        );
    }

    config
}

/// Return a cached producer, creating it lazily on first use.
pub async fn get_or_create(conn: &KafkaConnection) -> Result<FutureProducer> {
    if let Some(producer) = CACHE.get(&conn.id) {
        return Ok(producer.clone());
    }

    let password = match conn.sasl_password_enc.as_deref() {
        Some(encrypted) if !encrypted.is_empty() => Some(crate::crypto::decrypt_secret(encrypted)?),
        _ => None,
    };
    let producer = build_client_config(conn, password.as_deref())
        .create::<FutureProducer>()
        .map_err(|error| AppError::Internal(format!("Kafka producer 创建失败: {error}")))?;

    CACHE.insert(conn.id, producer.clone());
    Ok(producer)
}

/// Evict a producer after its connection configuration changes or is deleted.
pub fn invalidate(connection_id: i64) {
    CACHE.remove(&connection_id);
}
