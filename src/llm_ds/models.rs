//! LLM 连接：PG 行映射。表内无密钥列；认证走 `credential_id` → `wf_credentials`。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct LlmConnection {
    pub id: i64,
    pub tenant_id: i32,
    pub connection_name: String,
    pub base_url: String,
    pub credential_id: Option<i32>,
    pub models: Vec<String>,
    pub is_active: bool,
    pub created_by: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
