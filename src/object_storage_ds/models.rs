//! 对象存储连接：PG 行映射与字段校验。
//!
//! `secret_key_enc` 永不序列化给前端（`#[serde(skip_serializing)]`）。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use crate::error::{AppError, Result};

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct ObjectStorageConnection {
    pub id: i64,
    pub tenant_id: i32,
    pub connection_name: String,
    pub provider: String,
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    #[serde(skip_serializing)]
    pub secret_key_enc: String,
    pub force_path_style: bool,
    pub connect_timeout_secs: i32,
    pub is_active: bool,
    pub created_by: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct ObjectStorageAccessToken {
    pub id: i64,
    pub connection_id: i64,
    pub name: String,
    pub description: Option<String>,
    #[allow(dead_code)]
    #[serde(skip_serializing)]
    pub token_hash: String,
    pub token_prefix: String,
    pub allowed_ops: Vec<String>,
    pub key_prefix_allowlist: Vec<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub use_count: i64,
    pub is_active: bool,
    pub revoked_at: Option<DateTime<Utc>>,
    pub created_by: i32,
    pub created_at: DateTime<Utc>,
}

pub fn default_force_path_style(provider: &str) -> bool {
    matches!(provider, "minio")
}

pub fn validate_provider(provider: &str) -> Result<()> {
    match provider {
        "minio" | "cos" | "oss" => Ok(()),
        _ => Err(AppError::InvalidQuery(
            "provider 必须是 minio / cos / oss".into(),
        )),
    }
}

pub fn validate_endpoint(endpoint: &str) -> Result<()> {
    let t = endpoint.trim();
    if !(t.starts_with("http://") || t.starts_with("https://")) {
        return Err(AppError::InvalidQuery(
            "endpoint 必须以 http:// 或 https:// 开头".into(),
        ));
    }
    if t.chars().any(|c| c.is_whitespace()) {
        return Err(AppError::InvalidQuery("endpoint 含非法空白字符".into()));
    }
    if t.len() <= "https://".len() {
        return Err(AppError::InvalidQuery("endpoint 无效".into()));
    }
    Ok(())
}

pub fn validate_bucket(bucket: &str) -> Result<()> {
    let t = bucket.trim();
    if t.is_empty() {
        return Err(AppError::InvalidQuery("bucket 不能为空".into()));
    }
    if t.chars().any(|c| c.is_whitespace()) {
        return Err(AppError::InvalidQuery("bucket 含非法空白字符".into()));
    }
    Ok(())
}

pub fn validate_region(region: &str) -> Result<()> {
    let t = region.trim();
    if t.is_empty() {
        return Err(AppError::InvalidQuery("region 不能为空".into()));
    }
    if t.chars().any(|c| c.is_whitespace()) {
        return Err(AppError::InvalidQuery("region 含非法空白字符".into()));
    }
    Ok(())
}

pub fn validate_access_key_id(ak: &str) -> Result<()> {
    if ak.trim().is_empty() {
        return Err(AppError::InvalidQuery("access_key_id 不能为空".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn force_path_style_defaults() {
        assert!(default_force_path_style("minio"));
        assert!(!default_force_path_style("cos"));
        assert!(!default_force_path_style("oss"));
    }

    #[test]
    fn provider_validation() {
        assert!(validate_provider("minio").is_ok());
        assert!(validate_provider("s3").is_err());
    }

    #[test]
    fn endpoint_validation() {
        assert!(validate_endpoint("https://cos.ap-guangzhou.myqcloud.com").is_ok());
        assert!(validate_endpoint("http://127.0.0.1:9000").is_ok());
        assert!(validate_endpoint("cos.example.com").is_err());
        assert!(validate_endpoint("https://bad host").is_err());
    }

    #[test]
    fn secret_not_serialized() {
        let row = ObjectStorageConnection {
            id: 1,
            tenant_id: 1,
            connection_name: "c".into(),
            provider: "minio".into(),
            endpoint: "http://localhost:9000".into(),
            region: "us-east-1".into(),
            bucket: "b".into(),
            access_key_id: "ak".into(),
            secret_key_enc: "ENC".into(),
            force_path_style: true,
            connect_timeout_secs: 5,
            is_active: true,
            created_by: 1,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        let v = serde_json::to_value(&row).unwrap();
        assert!(v.get("secret_key_enc").is_none());
        assert_eq!(v["access_key_id"], json!("ak"));
    }
}
