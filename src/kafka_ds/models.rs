//! Kafka 数据源：PG 行映射。
//!
//! `sasl_password_enc` 是 AES-GCM 加密后的密码，**永不序列化给前端**
//! （已 `#[serde(skip_serializing)]`）；解密只在 client_cache 建连时发生。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct KafkaConnection {
    pub id: i64,
    pub tenant_id: i32,
    pub connection_name: String,
    pub brokers: String,
    pub security_protocol: String,
    pub sasl_mechanism: Option<String>,
    pub sasl_username: Option<String>,
    /// AES-GCM 加密后的密码；无密码实例为 NULL。**不应直接序列化给前端**。
    #[serde(skip_serializing)]
    pub sasl_password_enc: Option<String>,
    pub tls_insecure_skip_verify: bool,
    pub connect_timeout_secs: i32,
    pub is_active: bool,
    pub created_by: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct KafkaAccessToken {
    pub id: i64,
    pub connection_id: i64,
    pub name: String,
    pub description: Option<String>,
    #[allow(dead_code)]
    #[serde(skip_serializing)]
    pub token_hash: String,
    pub token_prefix: String,
    pub allowed_ops: Vec<String>,
    pub topic_allowlist: Vec<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub use_count: i64,
    pub is_active: bool,
    pub revoked_at: Option<DateTime<Utc>>,
    pub created_by: i32,
    pub created_at: DateTime<Utc>,
}
