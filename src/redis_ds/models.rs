//! Redis 数据源：PG 行映射。
//!
//! `password_enc` 是 AES-GCM 加密后的密码，**永不序列化给前端**
//! （已 `#[serde(skip_serializing)]`）；解密只在 client_cache 建连时发生。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct RedisConnection {
    pub id: i64,
    pub tenant_id: i32,
    pub connection_name: String,
    pub host: String,
    pub port: i32,
    pub db_index: i32,
    pub username: Option<String>,
    /// AES-GCM 加密后的密码；无密码实例为 NULL。**不应直接序列化给前端**。
    #[serde(skip_serializing)]
    pub password_enc: Option<String>,
    pub use_tls: bool,
    pub connect_timeout_secs: i32,
    pub is_active: bool,
    pub created_by: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
