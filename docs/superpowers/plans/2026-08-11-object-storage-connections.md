# Object Storage Connections (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tenant-scoped object storage connections (COS / OSS / MinIO) with admin CRUD, health, exec (`put`/`get`/`delete`/`list`/`presign`), and a workspace admin page — mirroring `redis_ds` / `kafka_ds`.

**Architecture:** PG registry `management.object_storage_connections` + lib-safe `object_storage_ds` (models, client_cache, commands) + bin-only `object_storage_handlers` + Next.js page. All providers use `aws-sdk-s3` with custom endpoint / path-style. No token proxy, no workflow node in this phase.

**Tech Stack:** Rust/Axum/SQLx, `aws-sdk-s3` + `aws-config` + `aws-credential-types`, DashMap cache, Next.js admin UI.

**Spec:** `docs/superpowers/specs/2026-08-10-object-storage-connections-design.md`

## Global Constraints

- Providers only: `minio` | `cos` | `oss` (no generic `s3` yet)
- Unified S3 SDK (`aws-sdk-s3`); no vendor-native SDKs
- Secrets: `secret_key_enc` via `crypto::encrypt_secret` / `decrypt_secret`; never serialize to clients
- Update HTTP method: **PUT** (match Redis/Kafka handlers, not PATCH)
- Ops: `put` | `get` | `delete` | `list` | `presign` only
- Limits: body 5 MiB; list max_keys default 100 / cap 1000; presign expires default 3600 / cap 86400; delete keys cap 100; op timeout 30s
- Do **not** wire workflow engine, ES-style tokens, multipart/copy/head
- TLS: project uses native-tls elsewhere; AWS SDK may pull its default HTTPS client (modern rustls/aws-lc) — accept that dual stack; do **not** force openssl feature flags that fight sqlx/reqwest
- Auth: admin = superadmin / tenant owner-admin; exec write = `require_tenant_member`; exec read = `require_tenant_membership_any`

## File Structure

| Path | Responsibility |
|---|---|
| `migrations/057_object_storage_connections.sql` | Schema |
| `src/migrate.rs` | Register migration 057 |
| `Cargo.toml` | AWS SDK deps |
| `src/object_storage_ds/mod.rs` | `fetch_active` / `fetch_active_for_tenant` |
| `src/object_storage_ds/models.rs` | Row type + provider/endpoint/bucket validators |
| `src/object_storage_ds/client_cache.rs` | S3 client DashMap cache |
| `src/object_storage_ds/commands.rs` | Exec ops + limits + unit tests |
| `src/object_storage_handlers.rs` | Axum CRUD / health / exec |
| `src/lib.rs` | `pub mod object_storage_ds` |
| `src/main.rs` | `mod object_storage_handlers` + routes + merge |
| `frontend-nextjs/lib/api.ts` | Types + `objectStorageAPI` |
| `frontend-nextjs/components/workspace/workspaceNav.ts` | Nav entry |
| `frontend-nextjs/app/workspace/[projectId]/events/object-storage-connections/page.tsx` | Admin UI |

---

### Task 1: Migration

**Files:**
- Create: `migrations/057_object_storage_connections.sql`
- Modify: `src/migrate.rs` (append after 056 entry)

**Interfaces:**
- Consumes: none
- Produces: table `management.object_storage_connections` with columns/constraints from the spec

- [ ] **Step 1: Write the migration SQL**

Create `migrations/057_object_storage_connections.sql`:

```sql
-- migrations/057_object_storage_connections.sql
--
-- 对象存储数据源：租户登记 COS / OSS / MinIO（S3 兼容），之后可通过
--   1) 管理 API（/api/admin/object-storage-connections/*）维护连接 + health
--   2) 数据 API（/api/object-storage-connections/:id/exec）put/get/delete/list/presign
-- 统一使用。工作流节点 / Access Token 代理留待后续期。

CREATE TABLE IF NOT EXISTS management.object_storage_connections (
    id                   BIGSERIAL PRIMARY KEY,
    tenant_id            INTEGER NOT NULL
                         REFERENCES management.tenants(id) ON DELETE CASCADE,
    connection_name      VARCHAR(100) NOT NULL,
    provider             TEXT NOT NULL
                         CHECK (provider IN ('minio', 'cos', 'oss')),
    endpoint             TEXT NOT NULL,
    region               TEXT NOT NULL DEFAULT 'us-east-1',
    bucket               TEXT NOT NULL,
    access_key_id        TEXT NOT NULL,
    secret_key_enc       TEXT NOT NULL,
    force_path_style     BOOLEAN NOT NULL DEFAULT false,
    connect_timeout_secs INTEGER NOT NULL DEFAULT 5
                         CHECK (connect_timeout_secs BETWEEN 1 AND 60),
    is_active            BOOLEAN NOT NULL DEFAULT true,
    created_by           INTEGER NOT NULL
                         REFERENCES users(id) ON DELETE RESTRICT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_object_storage_conn_name UNIQUE (tenant_id, connection_name),
    CONSTRAINT chk_object_storage_endpoint CHECK (
        endpoint ~ '^https?://[^[:space:]]+$'
    ),
    CONSTRAINT chk_object_storage_bucket CHECK (
        bucket ~ '^[^[:space:]]+$'
    )
);

CREATE INDEX IF NOT EXISTS idx_object_storage_connections_tenant
    ON management.object_storage_connections(tenant_id)
    WHERE is_active;
```

- [ ] **Step 2: Register in `src/migrate.rs`**

Append after the `"056 operation logs"` tuple:

```rust
    (
        "057 object storage connections",
        include_str!("../migrations/057_object_storage_connections.sql"),
    ),
```

- [ ] **Step 3: Commit**

```bash
git add migrations/057_object_storage_connections.sql src/migrate.rs
git commit -m "$(cat <<'EOF'
feat: add object storage connections migration

Register tenant-scoped COS/OSS/MinIO connection table for phase-1
object storage datasource support.
EOF
)"
```

---

### Task 2: Cargo deps + models + fetch helpers

**Files:**
- Modify: `Cargo.toml`
- Create: `src/object_storage_ds/mod.rs`
- Create: `src/object_storage_ds/models.rs`
- Modify: `src/lib.rs` (add `pub mod object_storage_ds;`)

**Interfaces:**
- Consumes: `crypto`, `error`, `sqlx`
- Produces:
  - `ObjectStorageConnection` row struct
  - `default_force_path_style(provider) -> bool`
  - `validate_provider` / `validate_endpoint` / `validate_bucket` / `validate_region` / `validate_access_key_id`
  - `fetch_active(pool, id)` / `fetch_active_for_tenant(pool, id, tenant_id)`

- [ ] **Step 1: Add dependencies to `Cargo.toml`**

Near other infra deps (after `rdkafka` block is fine):

```toml
# 对象存储数据源（COS / OSS / MinIO，S3 兼容）
aws-config = { version = "1", features = ["behavior-version-latest"] }
aws-sdk-s3 = { version = "1", default-features = false, features = ["behavior-version-latest", "rt-tokio", "default-https-client"] }
aws-credential-types = "1"
aws-smithy-types = "1"
```

If `cargo check` complains about missing features (`sigv4` / `http-1x`), add the features the compiler asks for; keep `default-features = false` to avoid the legacy rustls feature set.

- [ ] **Step 2: Write failing tests for validators in `models.rs`**

Create `src/object_storage_ds/models.rs` with validators + tests first (implementation can be in same file after tests fail conceptually — TDD: write tests, then functions).

```rust
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
```

- [ ] **Step 3: Write `mod.rs` with fetch helpers**

```rust
//! 对象存储数据源：租户登记 COS / OSS / MinIO（S3 兼容）并统一使用。
//!
//! lib-safe：models / client_cache / commands 可随 lib crate 编译（便于后续工作流节点）。
//! axum handlers 在 bin-only 的 `crate::object_storage_handlers`。

pub mod client_cache;
pub mod commands;
pub mod models;

use sqlx::PgPool;

use crate::error::{AppError, Result};
use crate::object_storage_ds::models::ObjectStorageConnection;

pub async fn fetch_active(pool: &PgPool, id: i64) -> Result<ObjectStorageConnection> {
    sqlx::query_as::<_, ObjectStorageConnection>(
        "SELECT * FROM management.object_storage_connections WHERE id = $1 AND is_active = true",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询对象存储连接失败: {e}")))?
    .ok_or_else(|| AppError::NotFound(format!("对象存储连接 {id} 不存在或已禁用")))
}

pub async fn fetch_active_for_tenant(
    pool: &PgPool,
    id: i64,
    tenant_id: i32,
) -> Result<ObjectStorageConnection> {
    sqlx::query_as::<_, ObjectStorageConnection>(
        "SELECT * FROM management.object_storage_connections \
         WHERE id = $1 AND tenant_id = $2 AND is_active = true",
    )
    .bind(id)
    .bind(tenant_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询对象存储连接失败: {e}")))?
    .ok_or_else(|| {
        AppError::NotFound(format!(
            "对象存储连接 {id} 不存在 / 已禁用 / 不属于当前租户"
        ))
    })
}
```

Temporarily stub `client_cache.rs` and `commands.rs` as empty modules so the crate compiles:

```rust
// client_cache.rs — Task 3 will replace
// commands.rs — Task 4 will replace
```

- [ ] **Step 4: Export from `lib.rs`**

Add next to `redis_ds` / `kafka_ds`:

```rust
pub mod object_storage_ds;
```

- [ ] **Step 5: Run tests**

```bash
cargo test object_storage_ds::models --lib
```

Expected: PASS (all validator + serde tests).

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml Cargo.lock src/lib.rs src/object_storage_ds/
git commit -m "$(cat <<'EOF'
feat: add object_storage_ds models and fetch helpers

Introduce S3-compatible connection row mapping, provider validators,
and lib module scaffolding for COS/OSS/MinIO datasources.
EOF
)"
```

---

### Task 3: Client cache

**Files:**
- Create/Replace: `src/object_storage_ds/client_cache.rs`

**Interfaces:**
- Consumes: `ObjectStorageConnection`, `crypto::decrypt_secret`
- Produces:
  - `get_or_create(conn: &ObjectStorageConnection) -> Result<aws_sdk_s3::Client>`
  - `invalidate(connection_id: i64)`
  - `build_client(conn, secret_key: &str) -> Result<aws_sdk_s3::Client>` (pub(crate) for health re-build if needed)

- [ ] **Step 1: Implement client cache**

```rust
//! 对象存储 S3 客户端缓存（按 connection id）。

use aws_credential_types::Credentials;
use aws_sdk_s3::config::{BehaviorVersion, Region};
use aws_sdk_s3::Client;
use dashmap::DashMap;
use once_cell::sync::Lazy;

use crate::error::{AppError, Result};
use crate::object_storage_ds::models::ObjectStorageConnection;

static CACHE: Lazy<DashMap<i64, Client>> = Lazy::new(DashMap::new);

pub(crate) fn build_client(conn: &ObjectStorageConnection, secret_key: &str) -> Result<Client> {
    let creds = Credentials::new(
        conn.access_key_id.trim(),
        secret_key,
        None,
        None,
        "onebase-object-storage",
    );
    let conf = aws_sdk_s3::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .region(Region::new(conn.region.trim().to_string()))
        .endpoint_url(conn.endpoint.trim())
        .credentials_provider(creds)
        .force_path_style(conn.force_path_style)
        .build();
    Ok(Client::from_conf(conf))
}

pub async fn get_or_create(conn: &ObjectStorageConnection) -> Result<Client> {
    if let Some(existing) = CACHE.get(&conn.id) {
        return Ok(existing.clone());
    }
    let secret = crate::crypto::decrypt_secret(&conn.secret_key_enc)?;
    let client = build_client(conn, &secret)?;
    CACHE.insert(conn.id, client.clone());
    Ok(client)
}

pub fn invalidate(connection_id: i64) {
    CACHE.remove(&connection_id);
}
```

If `BehaviorVersion::latest()` / builder APIs differ slightly by crate version, adjust to whatever `cargo check` reports (common alternate: `.behavior_version_latest()` on the builder).

- [ ] **Step 2: Compile check**

```bash
cargo check --lib
```

Expected: SUCCESS (or fix API name drift only).

- [ ] **Step 3: Commit**

```bash
git add src/object_storage_ds/client_cache.rs
git commit -m "$(cat <<'EOF'
feat: cache S3 clients for object storage connections

Lazy-build aws-sdk-s3 clients per connection id with encrypted
secret decryption only at construction time.
EOF
)"
```

---

### Task 4: Commands layer (TDD)

**Files:**
- Create/Replace: `src/object_storage_ds/commands.rs`

**Interfaces:**
- Consumes: `aws_sdk_s3::Client`, JSON args
- Produces:
  - `SUPPORTED_OPS: &[&str]`
  - `is_write_op(op: &str, args: &Value) -> bool`
  - `validate_object_key(key: &str) -> Result<String>`
  - `resolve_bucket(args, default_bucket) -> Result<String>`
  - `clamp_max_keys` / `clamp_expires_secs` / body size helpers
  - `execute(client, default_bucket, op, args) -> Result<Value>`

- [ ] **Step 1: Write unit tests for pure helpers first**

Put these tests at the bottom of `commands.rs` and implement helpers until green before wiring full S3 I/O:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn write_ops() {
        assert!(is_write_op("put", &json!({})));
        assert!(is_write_op("delete", &json!({})));
        assert!(is_write_op("presign", &json!({"method": "PUT"})));
        assert!(is_write_op("presign", &json!({}))); // default write
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
        assert_eq!(clamp_expires_secs(None), 3600);
        assert_eq!(clamp_expires_secs(Some(999_999)), 86400);
    }

    #[test]
    fn put_body_too_large() {
        let big = "a".repeat(MAX_BODY_BYTES + 1);
        let err = decode_put_body(&json!({"content": big})).unwrap_err();
        assert!(err.to_string().contains("presign") || err.to_string().contains("5"));
    }
}
```

- [ ] **Step 2: Implement commands module**

Core structure (complete implementation required — expand each match arm fully):

```rust
//! 对象存储精选操作：admin exec 与未来工作流节点共用。

use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::Client;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value as JsonValue};
use std::time::Duration;

use crate::error::{AppError, Result};

pub const SUPPORTED_OPS: &[&str] = &["put", "get", "delete", "list", "presign"];
pub const MAX_BODY_BYTES: usize = 5 * 1024 * 1024;
pub const LIST_DEFAULT_MAX_KEYS: i32 = 100;
pub const LIST_CAP_MAX_KEYS: i32 = 1000;
pub const PRESIGN_DEFAULT_SECS: u64 = 3600;
pub const PRESIGN_CAP_SECS: u64 = 86400;
pub const DELETE_KEYS_CAP: usize = 100;
const OP_TIMEOUT: Duration = Duration::from_secs(30);

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
        Some(n) => (n as i32).clamp(1, LIST_CAP_MAX_KEYS),
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

fn map_s3_err(op: &str, e: aws_sdk_s3::Error) -> AppError {
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
    {
        return AppError::InvalidQuery(format!("对象存储拒绝访问（{op}）: 请检查密钥/权限"));
    }
    AppError::Internal(format!("对象存储 {op} 失败: {msg}"))
}

async fn timed<T>(
    label: &str,
    fut: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    match tokio::time::timeout(OP_TIMEOUT, fut).await {
        Ok(r) => r,
        Err(_) => Err(AppError::ServiceUnavailable(format!(
            "对象存储 {label} 超时（>{}s）",
            OP_TIMEOUT.as_secs()
        ))),
    }
}

pub async fn execute(
    client: &Client,
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
        "put" => op_put(client, &bucket, args).await,
        "get" => op_get(client, &bucket, args).await,
        "delete" => op_delete(client, &bucket, args).await,
        "list" => op_list(client, &bucket, args).await,
        "presign" => op_presign(client, &bucket, args).await,
        _ => unreachable!(),
    }
}

fn arg_str<'a>(args: &'a JsonValue, name: &str) -> Result<&'a str> {
    args.get(name)
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::InvalidQuery(format!("缺少字符串参数 `{name}`")))
}

async fn op_put(client: &Client, bucket: &str, args: &JsonValue) -> Result<JsonValue> {
    let key = validate_object_key(arg_str(args, "key")?)?;
    let (bytes, content_type) = decode_put_body(args)?;
    let mut req = client
        .put_object()
        .bucket(bucket)
        .key(&key)
        .body(ByteStream::from(bytes));
    if let Some(ct) = content_type {
        req = req.content_type(ct);
    }
    let out = timed("put", async {
        req.send()
            .await
            .map_err(|e| map_s3_err("put", e.into()))
    })
    .await?;
    Ok(json!({ "etag": out.e_tag(), "key": key, "bucket": bucket }))
}

async fn op_get(client: &Client, bucket: &str, args: &JsonValue) -> Result<JsonValue> {
    let key = validate_object_key(arg_str(args, "key")?)?;
    let out = timed("get", async {
        client
            .get_object()
            .bucket(bucket)
            .key(&key)
            .send()
            .await
            .map_err(|e| map_s3_err("get", e.into()))
    })
    .await?;
    let ct = out.content_type().map(|s| s.to_string());
    let data = out
        .body
        .collect()
        .await
        .map_err(|e| AppError::Internal(format!("读取对象失败: {e}")))?
        .into_bytes();
    if data.len() > MAX_BODY_BYTES {
        return Err(AppError::InvalidQuery(format!(
            "对象超过 {MAX_BODY_BYTES} 字节，请改用 presign 下载"
        )));
    }
    let as_b64 = args
        .get("as_base64")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if as_b64 {
        return Ok(json!({
            "key": key,
            "bucket": bucket,
            "content_type": ct,
            "size": data.len(),
            "content_base64": B64.encode(&data),
        }));
    }
    match String::from_utf8(data.to_vec()) {
        Ok(s) => Ok(json!({
            "key": key,
            "bucket": bucket,
            "content_type": ct,
            "size": s.len(),
            "content": s,
        })),
        Err(err) => {
            let bytes = err.into_bytes();
            Ok(json!({
                "key": key,
                "bucket": bucket,
                "content_type": ct,
                "size": bytes.len(),
                "content_base64": B64.encode(&bytes),
            }))
        }
    }
}

async fn op_delete(client: &Client, bucket: &str, args: &JsonValue) -> Result<JsonValue> {
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

    let mut deleted = Vec::new();
    for key in keys {
        timed("delete", async {
            client
                .delete_object()
                .bucket(bucket)
                .key(&key)
                .send()
                .await
                .map_err(|e| map_s3_err("delete", e.into()))
        })
        .await?;
        deleted.push(key);
    }
    Ok(json!({ "deleted": deleted, "bucket": bucket }))
}

async fn op_list(client: &Client, bucket: &str, args: &JsonValue) -> Result<JsonValue> {
    let max_keys = clamp_max_keys(args.get("max_keys").and_then(|v| v.as_i64()));
    let mut req = client.list_objects_v2().bucket(bucket).max_keys(max_keys);
    if let Some(prefix) = args.get("prefix").and_then(|v| v.as_str()) {
        req = req.prefix(prefix);
    }
    if let Some(delimiter) = args.get("delimiter").and_then(|v| v.as_str()) {
        req = req.delimiter(delimiter);
    }
    if let Some(token) = args.get("continuation_token").and_then(|v| v.as_str()) {
        req = req.continuation_token(token);
    }
    let out = timed("list", async {
        req.send()
            .await
            .map_err(|e| map_s3_err("list", e.into()))
    })
    .await?;
    let objects: Vec<JsonValue> = out
        .contents()
        .iter()
        .map(|o| {
            json!({
                "key": o.key(),
                "size": o.size().unwrap_or(0),
                "etag": o.e_tag(),
                "last_modified": o.last_modified().map(|t| t.to_string()),
            })
        })
        .collect();
    let common_prefixes: Vec<String> = out
        .common_prefixes()
        .iter()
        .filter_map(|p| p.prefix().map(|s| s.to_string()))
        .collect();
    Ok(json!({
        "objects": objects,
        "common_prefixes": common_prefixes,
        "next_continuation_token": out.next_continuation_token(),
        "is_truncated": out.is_truncated().unwrap_or(false),
        "bucket": bucket,
    }))
}

async fn op_presign(client: &Client, bucket: &str, args: &JsonValue) -> Result<JsonValue> {
    let key = validate_object_key(arg_str(args, "key")?)?;
    let method = args
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("PUT")
        .to_ascii_uppercase();
    let secs = clamp_expires_secs(args.get("expires_secs").and_then(|v| v.as_i64()));
    let cfg = PresigningConfig::expires_in(Duration::from_secs(secs))
        .map_err(|e| AppError::Internal(format!("presign 配置失败: {e}")))?;
    let url = match method.as_str() {
        "GET" => {
            let p = client
                .get_object()
                .bucket(bucket)
                .key(&key)
                .presigned(cfg)
                .await
                .map_err(|e| map_s3_err("presign", e.into()))?;
            p.uri().to_string()
        }
        "PUT" => {
            let mut req = client.put_object().bucket(bucket).key(&key);
            if let Some(ct) = args.get("content_type").and_then(|v| v.as_str()) {
                req = req.content_type(ct);
            }
            let p = req
                .presigned(cfg)
                .await
                .map_err(|e| map_s3_err("presign", e.into()))?;
            p.uri().to_string()
        }
        other => {
            return Err(AppError::InvalidQuery(format!(
                "presign method 仅支持 GET/PUT，收到 {other}"
            )))
        }
    };
    let expires_at =
        (chrono::Utc::now() + chrono::Duration::seconds(secs as i64)).to_rfc3339();
    Ok(json!({
        "url": url,
        "expires_at": expires_at,
        "method": method,
        "key": key,
        "bucket": bucket,
    }))
}
```

Also fix `map_s3_err` signature to accept whatever `SdkError` converts cleanly — if `e.into()` does not yield `aws_sdk_s3::Error`, use:

```rust
fn map_s3_err(op: &str, e: impl std::fmt::Display) -> AppError {
    let msg = e.to_string();
    // ... same classification on msg ...
}
```

- [ ] **Step 3: Run unit tests**

```bash
cargo test object_storage_ds::commands --lib
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/object_storage_ds/commands.rs
git commit -m "$(cat <<'EOF'
feat: implement object storage exec commands

Add allowlisted put/get/delete/list/presign ops with size/expiry
caps and unit tests for validation helpers.
EOF
)"
```

---

### Task 5: Handlers + routes

**Files:**
- Create: `src/object_storage_handlers.rs`
- Modify: `src/main.rs` — add `mod object_storage_handlers;`, build `object_storage_admin_routes`, `.merge(...)` after kafka routes

**Interfaces:**
- Consumes: `object_storage_ds::{fetch_active, client_cache, commands, models}`
- Produces: Axum handlers matching Redis route shapes:
  - `GET/POST /api/admin/object-storage-connections`
  - `GET/PUT/DELETE /api/admin/object-storage-connections/:id`
  - `POST /api/admin/object-storage-connections/:id/health`
  - `POST /api/object-storage-connections/:id/exec`

- [ ] **Step 1: Implement handlers**

Mirror `src/redis_handlers.rs` structure. Key differences:

```rust
//! 对象存储数据源管理端 + 数据端 API（bin-only）。

use axum::{extract::{Extension, Path, Query, State}, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::time::Instant;

use crate::audit_handlers;
use crate::auth::Claims;
use crate::crypto;
use crate::error::AppError;
use crate::object_storage_ds::models::{
    self, ObjectStorageConnection, default_force_path_style, validate_access_key_id,
    validate_bucket, validate_endpoint, validate_provider, validate_region,
};
use crate::object_storage_ds::{self, client_cache, commands};
use crate::permissions;

// require_tenant_admin / fetch_connection_authorized — copy Redis pattern,
// replace table name + error strings with 对象存储.

#[derive(Debug, Deserialize)]
pub struct ListConnectionsQuery { pub tenant_id: Option<i32> }

#[derive(Debug, Deserialize)]
pub struct CreateConnectionReq {
    pub tenant_id: i32,
    pub connection_name: String,
    pub provider: String,
    pub endpoint: String,
    pub region: Option<String>,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_key: String,
    pub force_path_style: Option<bool>,
    pub connect_timeout_secs: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateConnectionReq {
    pub connection_name: Option<String>,
    pub provider: Option<String>,
    pub endpoint: Option<String>,
    pub region: Option<String>,
    pub bucket: Option<String>,
    pub access_key_id: Option<String>,
    /// None = keep; Some(non-empty) = replace. Empty string rejected (secret required).
    pub secret_key: Option<String>,
    pub force_path_style: Option<bool>,
    pub connect_timeout_secs: Option<i32>,
    pub is_active: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct ExecReq {
    pub op: String,
    #[serde(default)]
    pub args: Value,
}
```

**create_connection** validation order:
1. `require_tenant_admin`
2. trim `connection_name` non-empty
3. `validate_provider` / `validate_endpoint` / `validate_bucket` / `validate_region(region.unwrap_or("us-east-1"))` / `validate_access_key_id`
4. `secret_key` trim non-empty → `encrypt_secret`
5. `force_path_style = req.force_path_style.unwrap_or_else(|| default_force_path_style(&provider))`
6. INSERT … RETURNING *

**update_connection:** COALESCE fields; secret only replaced when `Some(non-empty)`; reject `Some("")`; always `client_cache::invalidate(id)` after success.

**health_check:**
```rust
client_cache::invalidate(id);
let client = match client_cache::get_or_create(&conn).await {
    Ok(c) => c,
    Err(e) => return Ok(Json(json!({ "ok": false, "error": e.to_string() }))),
};
let started = Instant::now();
let head = client.head_bucket().bucket(&conn.bucket).send().await;
let ok = match head {
    Ok(_) => true,
    Err(_) => client
        .list_objects_v2()
        .bucket(&conn.bucket)
        .max_keys(1)
        .send()
        .await
        .is_ok(),
};
if ok {
    Ok(Json(json!({
        "ok": true,
        "latency_ms": started.elapsed().as_millis() as u64,
        "bucket": conn.bucket,
    })))
} else {
    Ok(Json(json!({ "ok": false, "error": "HeadBucket/ListObjects 均失败，请检查 endpoint/密钥/桶" })))
}
```

**exec:**
```rust
let conn = object_storage_ds::fetch_active(&pool, id).await?;
if commands::is_write_op(&req.op, &req.args) {
    permissions::require_tenant_member(&pool, &claims, conn.tenant_id).await?;
} else {
    permissions::require_tenant_membership_any(&pool, &claims, conn.tenant_id).await?;
}
let client = client_cache::get_or_create(&conn).await?;
let result = commands::execute(&client, &conn.bucket, &req.op, &req.args).await?;
Ok(Json(json!({ "op": req.op, "result": result })))
```

Include `map_unique_violation` helper identical to Redis.

- [ ] **Step 2: Wire `main.rs`**

Near other `mod` lines:

```rust
mod object_storage_handlers;
```

After `kafka_admin_routes` block, add:

```rust
    let object_storage_admin_routes = Router::new()
        .route(
            "/api/admin/object-storage-connections",
            get(object_storage_handlers::list_connections)
                .post(object_storage_handlers::create_connection),
        )
        .route(
            "/api/admin/object-storage-connections/:id",
            get(object_storage_handlers::get_connection)
                .put(object_storage_handlers::update_connection)
                .delete(object_storage_handlers::delete_connection),
        )
        .route(
            "/api/admin/object-storage-connections/:id/health",
            post(object_storage_handlers::health_check),
        )
        .route(
            "/api/object-storage-connections/:id/exec",
            post(object_storage_handlers::exec),
        )
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));
```

Merge:

```rust
        .merge(kafka_admin_routes)
        .merge(object_storage_admin_routes)
```

- [ ] **Step 3: Compile**

```bash
cargo check
```

Expected: SUCCESS.

- [ ] **Step 4: Run lib tests again**

```bash
cargo test object_storage_ds --lib
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/object_storage_handlers.rs src/main.rs
git commit -m "$(cat <<'EOF'
feat: expose object storage admin and exec APIs

Add CRUD, health, and allowlisted exec routes for tenant object
storage connections, wired like redis/kafka datasources.
EOF
)"
```

---

### Task 6: Frontend API + nav + page

**Files:**
- Modify: `frontend-nextjs/lib/api.ts`
- Modify: `frontend-nextjs/components/workspace/workspaceNav.ts`
- Create: `frontend-nextjs/app/workspace/[projectId]/events/object-storage-connections/page.tsx`

**Interfaces:**
- Consumes: backend routes from Task 5
- Produces: `objectStorageAPI`, `OBJECT_STORAGE_OPS`, workspace nav label「对象存储」

- [ ] **Step 1: Add API client types after Kafka block in `api.ts`**

```typescript
// ─────────────────────────────────────────────────────────────────────────
// 对象存储数据源连接（COS / OSS / MinIO，S3 兼容）

export type ObjectStorageProvider = 'minio' | 'cos' | 'oss'

export interface ObjectStorageConnection {
  id: number
  tenant_id: number
  connection_name: string
  provider: ObjectStorageProvider | string
  endpoint: string
  region: string
  bucket: string
  access_key_id: string
  force_path_style: boolean
  connect_timeout_secs: number
  is_active: boolean
  created_by: number
  created_at: string
  updated_at: string
}

export interface CreateObjectStorageConnectionInput {
  tenant_id: number
  connection_name: string
  provider: ObjectStorageProvider
  endpoint: string
  region?: string
  bucket: string
  access_key_id: string
  secret_key: string
  force_path_style?: boolean
  connect_timeout_secs?: number
}

export interface UpdateObjectStorageConnectionInput {
  connection_name?: string
  provider?: ObjectStorageProvider
  endpoint?: string
  region?: string
  bucket?: string
  access_key_id?: string
  /** undefined = keep; non-empty = replace */
  secret_key?: string
  force_path_style?: boolean
  connect_timeout_secs?: number
  is_active?: boolean
}

export const OBJECT_STORAGE_OPS = ['put', 'get', 'delete', 'list', 'presign'] as const
export type ObjectStorageOp = (typeof OBJECT_STORAGE_OPS)[number]

export interface ObjectStorageExecInput {
  op: ObjectStorageOp | string
  args?: Record<string, unknown>
}

export const objectStorageAPI = {
  listConnections: (tenantId?: number) =>
    api.get<ObjectStorageConnection[]>('/api/admin/object-storage-connections', {
      params: tenantId !== undefined ? { tenant_id: tenantId } : undefined,
    }),
  getConnection: (id: number) =>
    api.get<ObjectStorageConnection>(`/api/admin/object-storage-connections/${id}`),
  createConnection: (input: CreateObjectStorageConnectionInput) =>
    api.post<ObjectStorageConnection>('/api/admin/object-storage-connections', input),
  updateConnection: (id: number, input: UpdateObjectStorageConnectionInput) =>
    api.put<ObjectStorageConnection>(`/api/admin/object-storage-connections/${id}`, input),
  deleteConnection: (id: number) =>
    api.delete<{ deleted: number }>(`/api/admin/object-storage-connections/${id}`),
  healthCheck: (id: number) =>
    api.post<{ ok: boolean; latency_ms?: number; bucket?: string; error?: string }>(
      `/api/admin/object-storage-connections/${id}/health`,
      {},
      { suppressErrorToast: true } as ApiRequestConfig,
    ),
  exec: (id: number, input: ObjectStorageExecInput) =>
    api.post<{ op: string; result: Record<string, unknown> }>(
      `/api/object-storage-connections/${id}/exec`,
      input,
      { suppressErrorToast: true } as ApiRequestConfig,
    ),
}
```

- [ ] **Step 2: Nav entry**

In `workspaceNav.ts`, next to Kafka:

```typescript
      { label: 'Kafka', href: '/events/kafka-connections', icon: 'fas fa-stream' },
      { label: '对象存储', href: '/events/object-storage-connections', icon: 'fas fa-cloud' },
```

- [ ] **Step 3: Build the page**

Create `frontend-nextjs/app/workspace/[projectId]/events/object-storage-connections/page.tsx`.

Structure (same layout as Redis page — list left / detail right):

1. Gate with `caps.canManageEvents` + `ForbiddenPlaceholder`
2. `objectStorageAPI.listConnections(tenantId)`
3. Create modal fields: `connection_name`, `provider` select, `endpoint`, `region`, `bucket`, `access_key_id`, `secret_key`, `force_path_style` checkbox, `connect_timeout_secs`
4. When `provider` changes in create/edit form, if user has not manually toggled path-style, set `force_path_style = (provider === 'minio')`
5. Detail tabs/sections:
   - **控制台**: op select from `OBJECT_STORAGE_OPS`, JSON args textarea (default `{"key":"demo.txt","content":"hello"}`), Run → show result JSON; call `objectStorageAPI.exec`
   - **设置**: edit form + delete; secret placeholder「留空则不修改」
   - **探活**: button → `healthCheck`, show ok/latency/error
6. Reuse existing CSS classes (`btn-primary`, gray borders) — do not invent a new visual system

Keep the page self-contained in one file (Redis style). Prefer copying the Redis page and adapting field names over inventing new UX.

- [ ] **Step 4: Typecheck frontend (if available)**

```bash
cd frontend-nextjs && npx tsc --noEmit -p tsconfig.json 2>&1 | head -50
```

Expected: no errors in the new page / api types (project may have unrelated errors — only fix what this task introduced).

- [ ] **Step 5: Commit**

```bash
git add frontend-nextjs/lib/api.ts \
  frontend-nextjs/components/workspace/workspaceNav.ts \
  frontend-nextjs/app/workspace/[projectId]/events/object-storage-connections/page.tsx
git commit -m "$(cat <<'EOF'
feat: add object storage connections workspace UI

Expose COS/OSS/MinIO connection management, health checks, and
exec console under workspace events navigation.
EOF
)"
```

---

### Task 7: End-to-end verification

**Files:** none new (verification only)

- [ ] **Step 1: Backend tests + check**

```bash
cargo test object_storage_ds --lib
cargo check
```

Expected: PASS / SUCCESS.

- [ ] **Step 2: Manual smoke (optional if MinIO available)**

1. Run API with migrated DB
2. Create MinIO connection via UI or curl
3. `POST .../health` → `ok: true`
4. exec `put` → `get` → `list` → `delete`
5. exec `presign` GET/PUT → URL returned
6. Confirm list/get responses never include `secret_key` / `secret_key_enc`

- [ ] **Step 3: Mark spec status**

In `docs/superpowers/specs/2026-08-10-object-storage-connections-design.md`, change status line to:

```markdown
> 状态：implemented（phase 1，2026-08-11）。
```

- [ ] **Step 4: Final commit**

```bash
git add docs/superpowers/specs/2026-08-10-object-storage-connections-design.md
git commit -m "$(cat <<'EOF'
docs: mark object storage phase-1 design implemented
EOF
)"
```

---

## Spec coverage checklist

| Spec section | Task |
|---|---|
| §3 Architecture / file list | Tasks 1–6 |
| §4 Data model + provider defaults | Tasks 1–2 |
| §5.1 Admin API + health | Task 5 |
| §5.2 Exec ops + limits + key rules | Task 4 |
| §6 Client cache | Task 3 |
| §7 Frontend | Task 6 |
| §8 Errors | Tasks 4–5 (`map_s3_err`, InvalidQuery/NotFound/503) |
| §9 Unit tests | Tasks 2, 4 |
| §10 Dependencies | Task 2 |
| §11 Out of scope hooks | Not implemented (fetch_active_for_tenant reserved in Task 2) |
| §12 Acceptance | Task 7 |

## Self-review notes

- No TBD/placeholder steps remain for phase-1 deliverables
- Update verb is **PUT** (aligned with Redis/Kafka; supersedes draft “PATCH” wording in the design conversational notes)
- AWS SDK TLS may differ from project native-tls; accepted dual stack per Global Constraints
- Frontend page intentionally mirrors Redis UX; implementer should copy/adapt that file rather than redesign
