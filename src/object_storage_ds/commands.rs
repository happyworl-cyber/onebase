//! 对象存储精选操作：admin exec 与未来工作流节点共用。
//!
//! 实现：rusty-s3 签名 URL + reqwest 发送（无 aws-sdk）。

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rusty_s3::actions::{DeleteObject, GetObject, HeadBucket, ListObjectsV2, PutObject, S3Action};
use serde_json::{json, Value as JsonValue};
use std::time::Duration;

use crate::error::{AppError, Result};
use crate::object_storage_ds::client_cache::S3Handle;

pub const SUPPORTED_OPS: &[&str] = &["put", "get", "delete", "list", "presign"];
pub const MAX_BODY_BYTES: usize = 5 * 1024 * 1024;
pub const LIST_DEFAULT_MAX_KEYS: i32 = 100;
pub const LIST_CAP_MAX_KEYS: i32 = 1000;
pub const PRESIGN_DEFAULT_SECS: u64 = 3600;
pub const PRESIGN_CAP_SECS: u64 = 86400;
pub const DELETE_KEYS_CAP: usize = 100;
const OP_TIMEOUT: Duration = Duration::from_secs(30);
/// 服务端主动调用时签名 URL 有效期（短于用户 presign 上限即可）。
const SIGN_TTL: Duration = Duration::from_secs(900);

pub fn is_write_op(op: &str, args: &JsonValue) -> bool {
    match op.to_ascii_lowercase().as_str() {
        "put" | "delete" => true,
        "presign" => {
            let m = args
                .get("method")
                .and_then(|v| v.as_str())
                .unwrap_or("PUT")
                .to_ascii_uppercase();
            m != "GET"
        }
        _ => false,
    }
}

pub fn validate_object_key(key: &str) -> Result<String> {
    let t = key.trim();
    if t.is_empty() {
        return Err(AppError::InvalidQuery("key 不能为空".into()));
    }
    if t.len() > 1024 {
        return Err(AppError::InvalidQuery("key 长度不能超过 1024".into()));
    }
    if t.contains('\0') {
        return Err(AppError::InvalidQuery("key 含非法字符".into()));
    }
    if t.split('/').any(|seg| seg == "..") {
        return Err(AppError::InvalidQuery("key 不得包含 .. 路径段".into()));
    }
    Ok(t.to_string())
}

pub fn resolve_bucket(args: &JsonValue, default_bucket: &str) -> Result<String> {
    match args.get("bucket").and_then(|v| v.as_str()) {
        Some(b) => {
            let t = b.trim();
            if t.is_empty() {
                return Err(AppError::InvalidQuery("bucket 不能为空".into()));
            }
            Ok(t.to_string())
        }
        None => {
            let t = default_bucket.trim();
            if t.is_empty() {
                return Err(AppError::InvalidQuery("连接未配置默认 bucket".into()));
            }
            Ok(t.to_string())
        }
    }
}

pub fn clamp_max_keys(v: Option<i64>) -> i32 {
    match v {
        None => LIST_DEFAULT_MAX_KEYS,
        Some(n) => n.clamp(1, i64::from(LIST_CAP_MAX_KEYS)) as i32,
    }
}

pub fn clamp_expires_secs(v: Option<i64>) -> u64 {
    match v {
        None => PRESIGN_DEFAULT_SECS,
        Some(n) if n <= 0 => PRESIGN_DEFAULT_SECS,
        Some(n) => (n as u64).min(PRESIGN_CAP_SECS),
    }
}

pub fn decode_put_body(args: &JsonValue) -> Result<(Vec<u8>, Option<String>)> {
    let content_type = args
        .get("content_type")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    if let Some(b64) = args.get("content_base64").and_then(|v| v.as_str()) {
        let bytes = B64
            .decode(b64)
            .map_err(|e| AppError::InvalidQuery(format!("content_base64 无效: {e}")))?;
        if bytes.len() > MAX_BODY_BYTES {
            return Err(AppError::InvalidQuery(format!(
                "对象超过 {MAX_BODY_BYTES} 字节，请改用 presign 上传"
            )));
        }
        return Ok((bytes, content_type));
    }
    if let Some(text) = args.get("content").and_then(|v| v.as_str()) {
        let bytes = text.as_bytes().to_vec();
        if bytes.len() > MAX_BODY_BYTES {
            return Err(AppError::InvalidQuery(format!(
                "对象超过 {MAX_BODY_BYTES} 字节，请改用 presign 上传"
            )));
        }
        return Ok((bytes, content_type));
    }
    Err(AppError::InvalidQuery(
        "put 需要 `content` 或 `content_base64`".into(),
    ))
}

fn map_s3_err(op: &str, e: impl std::fmt::Display) -> AppError {
    let msg = e.to_string();
    let lower = msg.to_lowercase();
    if lower.contains("nosuchkey")
        || lower.contains("not found")
        || lower.contains("404")
        || lower.contains("nosuchbucket")
    {
        return AppError::NotFound(format!("对象存储 {op}: {msg}"));
    }
    if lower.contains("403")
        || lower.contains("access denied")
        || lower.contains("invalidaccesskey")
        || lower.contains("signature")
        || lower.contains("forbidden")
    {
        return AppError::InvalidQuery(format!("对象存储拒绝访问（{op}）: 请检查密钥/权限"));
    }
    AppError::Internal(format!("对象存储 {op} 失败: {msg}"))
}

fn map_http_status(op: &str, status: reqwest::StatusCode, body: &str) -> AppError {
    let snippet: String = body.chars().take(200).collect();
    map_s3_err(op, format!("HTTP {} {}", status.as_u16(), snippet))
}

fn get_body_too_large() -> AppError {
    AppError::InvalidQuery(format!(
        "对象超过 {MAX_BODY_BYTES} 字节，请改用 presign 下载"
    ))
}

fn append_get_chunk(body: &mut Vec<u8>, chunk: &[u8]) -> Result<()> {
    if body
        .len()
        .checked_add(chunk.len())
        .is_none_or(|len| len > MAX_BODY_BYTES)
    {
        return Err(get_body_too_large());
    }
    body.extend_from_slice(chunk);
    Ok(())
}

async fn timed<T>(label: &str, fut: impl std::future::Future<Output = Result<T>>) -> Result<T> {
    match tokio::time::timeout(OP_TIMEOUT, fut).await {
        Ok(r) => r,
        Err(_) => Err(AppError::ServiceUnavailable(format!(
            "对象存储 {label} 超时（>{}s）",
            OP_TIMEOUT.as_secs()
        ))),
    }
}

pub async fn execute(
    handle: &S3Handle,
    default_bucket: &str,
    op: &str,
    args: &JsonValue,
) -> Result<JsonValue> {
    let op_l = op.to_ascii_lowercase();
    if !SUPPORTED_OPS.contains(&op_l.as_str()) {
        return Err(AppError::InvalidQuery(format!(
            "不支持的 op `{op}`，可选: {}",
            SUPPORTED_OPS.join(", ")
        )));
    }
    let bucket = resolve_bucket(args, default_bucket)?;
    match op_l.as_str() {
        "put" => op_put(handle, &bucket, args).await,
        "get" => op_get(handle, &bucket, args).await,
        "delete" => op_delete(handle, &bucket, args).await,
        "list" => op_list(handle, &bucket, args).await,
        "presign" => op_presign(handle, &bucket, args).await,
        _ => unreachable!(),
    }
}

/// HeadBucket；失败则 ListObjectsV2(max_keys=1)。成功返回 Ok(())。
pub async fn probe_bucket(handle: &S3Handle, bucket_name: &str) -> Result<()> {
    let bucket = handle.bucket(bucket_name)?;
    let head = HeadBucket::new(&bucket, Some(&handle.credentials));
    let url = head.sign(SIGN_TTL);
    let head_resp = handle.http.head(url).send().await;
    if let Ok(resp) = head_resp {
        if resp.status().is_success() {
            return Ok(());
        }
    }

    let mut list = ListObjectsV2::new(&bucket, Some(&handle.credentials));
    list.with_max_keys(1);
    let url = list.sign(SIGN_TTL);
    let resp = handle
        .http
        .get(url)
        .send()
        .await
        .map_err(|e| map_s3_err("health", e))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        Err(map_http_status("health", status, &body))
    }
}

fn arg_str<'a>(args: &'a JsonValue, name: &str) -> Result<&'a str> {
    args.get(name)
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::InvalidQuery(format!("缺少字符串参数 `{name}`")))
}

async fn op_put(handle: &S3Handle, bucket_name: &str, args: &JsonValue) -> Result<JsonValue> {
    let key = validate_object_key(arg_str(args, "key")?)?;
    let (bytes, content_type) = decode_put_body(args)?;
    let bucket = handle.bucket(bucket_name)?;

    timed("put", async {
        let mut action = PutObject::new(&bucket, Some(&handle.credentials), &key);
        if let Some(ct) = content_type.clone() {
            // Owned Cow so header lifetime is not tied to local borrows.
            action.headers_mut().insert("content-type", ct);
        }
        let url = action.sign(SIGN_TTL);
        let mut req = handle.http.put(url).body(bytes);
        if let Some(ct) = content_type.as_deref() {
            req = req.header(reqwest::header::CONTENT_TYPE, ct);
        }
        let resp = req.send().await.map_err(|e| map_s3_err("put", e))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(map_http_status("put", status, &body));
        }
        let etag = resp
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        Ok(json!({ "etag": etag, "key": key, "bucket": bucket_name }))
    })
    .await
}

async fn op_get(handle: &S3Handle, bucket_name: &str, args: &JsonValue) -> Result<JsonValue> {
    let key = validate_object_key(arg_str(args, "key")?)?;
    let bucket = handle.bucket(bucket_name)?;

    let (ct, data) = timed("get", async {
        let action = GetObject::new(&bucket, Some(&handle.credentials), &key);
        let url = action.sign(SIGN_TTL);
        let mut resp = handle
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| map_s3_err("get", e))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(map_http_status("get", status, &body));
        }
        if resp
            .content_length()
            .is_some_and(|len| len > MAX_BODY_BYTES as u64)
        {
            return Err(get_body_too_large());
        }
        let ct = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let mut data = Vec::with_capacity(
            resp.content_length()
                .and_then(|len| usize::try_from(len).ok())
                .unwrap_or(0)
                .min(MAX_BODY_BYTES),
        );
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| AppError::Internal(format!("读取对象失败: {e}")))?
        {
            append_get_chunk(&mut data, &chunk)?;
        }
        Ok((ct, data))
    })
    .await?;

    let as_b64 = args
        .get("as_base64")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if as_b64 {
        return Ok(json!({
            "key": key,
            "bucket": bucket_name,
            "content_type": ct,
            "size": data.len(),
            "content_base64": B64.encode(&data),
        }));
    }
    match String::from_utf8(data) {
        Ok(s) => Ok(json!({
            "key": key,
            "bucket": bucket_name,
            "content_type": ct,
            "size": s.len(),
            "content": s,
        })),
        Err(err) => {
            let bytes = err.into_bytes();
            Ok(json!({
                "key": key,
                "bucket": bucket_name,
                "content_type": ct,
                "size": bytes.len(),
                "content_base64": B64.encode(&bytes),
            }))
        }
    }
}

async fn op_delete(handle: &S3Handle, bucket_name: &str, args: &JsonValue) -> Result<JsonValue> {
    let mut keys: Vec<String> = Vec::new();
    if let Some(arr) = args.get("keys").and_then(|v| v.as_array()) {
        if arr.is_empty() {
            return Err(AppError::InvalidQuery("`keys` 不能为空数组".into()));
        }
        if arr.len() > DELETE_KEYS_CAP {
            return Err(AppError::InvalidQuery(format!(
                "单次最多删除 {DELETE_KEYS_CAP} 个对象"
            )));
        }
        for v in arr {
            let k = v
                .as_str()
                .ok_or_else(|| AppError::InvalidQuery("`keys` 元素必须是字符串".into()))?;
            keys.push(validate_object_key(k)?);
        }
    } else {
        keys.push(validate_object_key(arg_str(args, "key")?)?);
    }

    let bucket = handle.bucket(bucket_name)?;
    let deleted = timed("delete", async {
        let mut deleted = Vec::new();
        for key in keys {
            let action = DeleteObject::new(&bucket, Some(&handle.credentials), &key);
            let url = action.sign(SIGN_TTL);
            let resp = handle
                .http
                .delete(url)
                .send()
                .await
                .map_err(|e| map_s3_err("delete", e))?;
            // S3 delete is idempotent; 204/200/404 all OK for our purposes when status < 500
            if resp.status().is_server_error() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(map_http_status("delete", status, &body));
            }
            deleted.push(key);
        }
        Ok(deleted)
    })
    .await?;
    Ok(json!({ "deleted": deleted, "bucket": bucket_name }))
}

async fn op_list(handle: &S3Handle, bucket_name: &str, args: &JsonValue) -> Result<JsonValue> {
    let max_keys = clamp_max_keys(args.get("max_keys").and_then(|v| v.as_i64()));
    let bucket = handle.bucket(bucket_name)?;

    timed("list", async {
        let mut action = ListObjectsV2::new(&bucket, Some(&handle.credentials));
        action.with_max_keys(max_keys as usize);
        if let Some(prefix) = args.get("prefix").and_then(|v| v.as_str()) {
            action.with_prefix(prefix.to_string());
        }
        if let Some(delimiter) = args.get("delimiter").and_then(|v| v.as_str()) {
            action.with_delimiter(delimiter.to_string());
        }
        if let Some(token) = args.get("continuation_token").and_then(|v| v.as_str()) {
            action.with_continuation_token(token.to_string());
        }
        let url = action.sign(SIGN_TTL);
        let resp = handle
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| map_s3_err("list", e))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(map_http_status("list", status, &body));
        }
        let text = resp
            .text()
            .await
            .map_err(|e| AppError::Internal(format!("读取 list 响应失败: {e}")))?;
        let parsed = ListObjectsV2::parse_response(&text)
            .map_err(|e| AppError::Internal(format!("解析 list 响应失败: {e}")))?;
        let objects: Vec<JsonValue> = parsed
            .contents
            .iter()
            .map(|o| {
                json!({
                    "key": o.key,
                    "size": o.size,
                    "etag": o.etag,
                    "last_modified": o.last_modified,
                })
            })
            .collect();
        let common_prefixes: Vec<String> = parsed
            .common_prefixes
            .iter()
            .map(|p| p.prefix.clone())
            .collect();
        let next = parsed.next_continuation_token.clone();
        let is_truncated = next.is_some();
        Ok(json!({
            "objects": objects,
            "common_prefixes": common_prefixes,
            "next_continuation_token": next,
            "is_truncated": is_truncated,
            "bucket": bucket_name,
        }))
    })
    .await
}

async fn op_presign(handle: &S3Handle, bucket_name: &str, args: &JsonValue) -> Result<JsonValue> {
    let key = validate_object_key(arg_str(args, "key")?)?;
    let method = args
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("PUT")
        .to_ascii_uppercase();
    let secs = clamp_expires_secs(args.get("expires_secs").and_then(|v| v.as_i64()));
    let bucket = handle.bucket(bucket_name)?;
    let expires = Duration::from_secs(secs);

    let url = match method.as_str() {
        "GET" => {
            let action = GetObject::new(&bucket, Some(&handle.credentials), &key);
            action.sign(expires).to_string()
        }
        "PUT" => {
            let mut action = PutObject::new(&bucket, Some(&handle.credentials), &key);
            if let Some(ct) = args.get("content_type").and_then(|v| v.as_str()) {
                action.headers_mut().insert("content-type", ct.to_string());
            }
            action.sign(expires).to_string()
        }
        other => {
            return Err(AppError::InvalidQuery(format!(
                "presign method 仅支持 GET/PUT，收到 {other}"
            )))
        }
    };
    let expires_at = (chrono::Utc::now() + chrono::Duration::seconds(secs as i64)).to_rfc3339();
    Ok(json!({
        "url": url,
        "expires_at": expires_at,
        "method": method,
        "key": key,
        "bucket": bucket_name,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn write_ops() {
        assert!(is_write_op("put", &json!({})));
        assert!(is_write_op("delete", &json!({})));
        assert!(is_write_op("presign", &json!({"method": "PUT"})));
        assert!(is_write_op("presign", &json!({})));
        assert!(!is_write_op("presign", &json!({"method": "GET"})));
        assert!(!is_write_op("get", &json!({})));
        assert!(!is_write_op("list", &json!({})));
    }

    #[test]
    fn key_validation() {
        assert_eq!(validate_object_key("a/b.txt").unwrap(), "a/b.txt");
        assert!(validate_object_key("").is_err());
        assert!(validate_object_key("a/../b").is_err());
        assert!(validate_object_key(&"x".repeat(1025)).is_err());
    }

    #[test]
    fn limits() {
        assert_eq!(clamp_max_keys(None), 100);
        assert_eq!(clamp_max_keys(Some(5000)), 1000);
        assert_eq!(clamp_max_keys(Some(i64::MAX)), 1000);
        assert_eq!(clamp_max_keys(Some(i64::MIN)), 1);
        assert_eq!(clamp_expires_secs(None), 3600);
        assert_eq!(clamp_expires_secs(Some(999_999)), 86400);
    }

    #[test]
    fn put_body_too_large() {
        let big = "a".repeat(MAX_BODY_BYTES + 1);
        let err = decode_put_body(&json!({"content": big})).unwrap_err();
        assert!(err.to_string().contains("presign") || err.to_string().contains("5"));
    }

    #[test]
    fn get_body_rejects_chunk_before_appending_past_limit() {
        let mut body = vec![0; MAX_BODY_BYTES];
        let err = append_get_chunk(&mut body, &[1]).unwrap_err();
        assert_eq!(body.len(), MAX_BODY_BYTES);
        assert!(err.to_string().contains("presign"));
    }
}
