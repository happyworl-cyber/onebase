//! 对象存储连接缓存（按 connection id）。
//!
//! 使用 rusty-s3（Sans-IO）+ 共享 `reqwest::Client`，避免 aws-sdk-s3 / aws-lc-sys。

use std::time::Duration;

use dashmap::DashMap;
use once_cell::sync::Lazy;
use reqwest::{Client as HttpClient, Url};
use rusty_s3::{Bucket, Credentials, UrlStyle};

use crate::error::{AppError, Result};
use crate::object_storage_ds::models::ObjectStorageConnection;

/// 可复用的 S3 访问句柄：HTTP 客户端 + endpoint 元数据 + 解密后的凭证。
#[derive(Debug, Clone)]
pub struct S3Handle {
    pub http: HttpClient,
    pub endpoint: Url,
    pub region: String,
    pub url_style: UrlStyle,
    pub credentials: Credentials,
}

impl S3Handle {
    /// 按桶名构造 rusty-s3 `Bucket`（exec 可覆盖默认桶）。
    pub fn bucket(&self, name: &str) -> Result<Bucket> {
        Bucket::new(
            self.endpoint.clone(),
            self.url_style,
            name.to_string(),
            self.region.clone(),
        )
        .map_err(|e| AppError::InvalidQuery(format!("无效的对象存储 endpoint/bucket: {e}")))
    }
}

static CACHE: Lazy<DashMap<i64, S3Handle>> = Lazy::new(DashMap::new);

pub(crate) fn build_handle(conn: &ObjectStorageConnection, secret_key: &str) -> Result<S3Handle> {
    let endpoint: Url = conn
        .endpoint
        .trim()
        .parse()
        .map_err(|e| AppError::InvalidQuery(format!("endpoint 不是合法 URL: {e}")))?;
    if endpoint.host_str().is_none() {
        return Err(AppError::InvalidQuery("endpoint 缺少 host".into()));
    }

    let timeout_secs = conn.connect_timeout_secs.clamp(1, 60) as u64;
    let http = HttpClient::builder()
        .connect_timeout(Duration::from_secs(timeout_secs))
        .timeout(Duration::from_secs(timeout_secs.saturating_mul(2).clamp(10, 120)))
        .build()
        .map_err(|e| AppError::Internal(format!("创建 HTTP 客户端失败: {e}")))?;

    let url_style = if conn.force_path_style {
        UrlStyle::Path
    } else {
        UrlStyle::VirtualHost
    };

    Ok(S3Handle {
        http,
        endpoint,
        region: conn.region.trim().to_string(),
        url_style,
        credentials: Credentials::new(conn.access_key_id.trim(), secret_key),
    })
}

pub async fn get_or_create(conn: &ObjectStorageConnection) -> Result<S3Handle> {
    if let Some(existing) = CACHE.get(&conn.id) {
        return Ok(existing.clone());
    }

    let secret_key = crate::crypto::decrypt_secret(&conn.secret_key_enc)?;
    let handle = build_handle(conn, &secret_key)?;
    CACHE.insert(conn.id, handle.clone());
    Ok(handle)
}

pub fn invalidate(connection_id: i64) {
    CACHE.remove(&connection_id);
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;
    use crate::object_storage_ds::models::ObjectStorageConnection;

    #[test]
    fn builds_handle_from_connection() {
        let conn = ObjectStorageConnection {
            id: 1,
            tenant_id: 1,
            connection_name: "test".into(),
            provider: "minio".into(),
            endpoint: "http://localhost:9000".into(),
            region: "us-east-1".into(),
            bucket: "bucket".into(),
            access_key_id: "access-key".into(),
            secret_key_enc: "unused".into(),
            force_path_style: true,
            connect_timeout_secs: 5,
            is_active: true,
            created_by: 1,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let handle = build_handle(&conn, "secret-key").unwrap();
        assert!(handle.bucket("bucket").is_ok());
    }
}
