//! ES 反向代理：PG 行映射
//!
//! 注意 `auth_credential_enc` / `token_hash` 这些敏感字段**永远不出 handler 边界**：
//!   - admin_handlers 返回时单独构造一个不含 credential 的 DTO
//!   - proxy_handler 解密后立即放入 reqwest Header，不写入 response

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct EsConnection {
    pub id: i64,
    pub tenant_id: i32,
    pub connection_name: String,
    pub base_url: String,
    pub auth_type: String,
    /// AES-GCM 加密后的凭据；'none' 时为 NULL。**不应直接序列化给前端**。
    #[serde(skip_serializing)]
    pub auth_credential_enc: Option<String>,
    pub verify_tls: bool,
    pub default_timeout_secs: i32,
    pub is_active: bool,
    pub created_by: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct EsAccessToken {
    pub id: i64,
    pub connection_id: i64,
    pub name: String,
    pub description: Option<String>,
    /// sha256(plain_token) 的 hex；**永远不出 handler 边界**
    #[allow(dead_code)]
    #[serde(skip_serializing)]
    pub token_hash: String,
    /// 列表展示用：`obes_es_aB3c…`
    pub token_prefix: String,
    pub allowed_methods: Vec<String>,
    pub index_allowlist: Vec<String>,
    pub path_denylist: Vec<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub use_count: i64,
    pub is_active: bool,
    pub revoked_at: Option<DateTime<Utc>>,
    pub created_by: i32,
    pub created_at: DateTime<Utc>,
}
