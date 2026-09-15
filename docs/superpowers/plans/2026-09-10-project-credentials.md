# Project Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project-scoped typed credentials (`basic` / `bearer` / `api_key`) that never echo secrets, can be picked on HTTP/datasource nodes, and resolve as `{{cred.名称.字段}}` / `cred.get`.

**Architecture:** Keep `management.wf_credentials`. Put runtime types and pure helpers in a new lib module `workflow_credentials`. CRUD stays in `datasource_handlers` with a new `/credentials` alias. Execution loads a `CredentialStore` into `ExecutionContext` beside `env_vars`.

**Tech Stack:** Rust (sqlx, axum, mlua), Next.js 14, existing `crypto::encrypt_secret`.

**Spec:** `docs/superpowers/specs/2026-09-10-project-credentials-design.md`

## Global Constraints

- Do not create git commits unless the user explicitly asks. Keep Commit steps but skip them until asked.
- Do not migrate ciphertext to a new table. Do not add OAuth / SMTP types.
- Do not change object storage / Redis / Kafka / ES connections.
- Do not change env-var plaintext display.
- List/detail/edit APIs never return `secret` or `secret_encrypted`.
- Datasources may bind only `kind=basic`. HTTP picker accepts all three kinds.
- Template missing name/field → empty string + warn. `cred.get` miss → nil.
- Credential-injected HTTP headers overwrite same-named node headers.
- Default API Key header is `X-API-Key` when `header_name` is NULL.
- `workflow_engine.rs` is already huge; new runtime logic goes in `src/workflow_credentials.rs`.
- `src/main.rs` and `src/lib.rs` both `mod` shared files. Add `mod workflow_credentials;` in both.

## File Structure

| Path | Responsibility |
|------|----------------|
| `src/workflow_credentials.rs` | `CredentialFields`, `CredentialStore`, parse/lookup/headers/mask/validate/load |
| `migrations/064_wf_credentials_api_key.sql` | `header_name` column |
| `src/migrate.rs` | Register 064 |
| `src/datasource_handlers.rs` | CRUD: `api_key`, `header_name`, list = member, write = admin, datasource binds basic only |
| `src/main.rs` | `/credentials` routes + alias + `mod workflow_credentials` |
| `src/lib.rs` | `pub mod workflow_credentials` |
| `src/workflow_engine.rs` | Context field, `{{cred.}}`, HTTP inject, mask, datasource kind |
| `src/workflow_handlers.rs` | Load store into exec ctx; mask with creds |
| `src/lua_builtins.rs` / `src/lua_engine.rs` | `cred.get` |
| `src/js_host_bridge.rs` / `js-runtime/.../index.js` | `cred.get` IPC + JS global |
| `src/js_runner.rs` / `src/py_runner.rs` / `py-runtime/.../onebase_host.py` | Pass store; Python `cred.get` |
| `src/operation_log.rs` | `resource_type::CREDENTIAL` |
| `src/mcp_tools.rs` | Document `{{cred.*}}` / `cred.get` / `credential_id` |
| `frontend-nextjs/lib/api.ts` | Types + `/credentials` client (keep `/wf-credentials` wrappers) |
| `frontend-nextjs/components/workspace/workspaceNav.ts` | 设置 → 凭证管理 |
| `frontend-nextjs/app/workspace/[projectId]/settings/credentials/page.tsx` | Management UI |
| `frontend-nextjs/app/workspace/[projectId]/events/datasources/page.tsx` | Drop credentials tab; basic-only dropdown |
| `frontend-nextjs/components/workflow/NodeConfigPanel.tsx` | HTTP credential picker |

---

### Task 1: Runtime module — store, parse, headers, validate

**Files:**
- Create: `src/workflow_credentials.rs`
- Modify: `src/lib.rs` (add `pub mod workflow_credentials;`)
- Modify: `src/main.rs` (add `mod workflow_credentials;` next to `mod workflow_engine;`)

**Interfaces:**
- Consumes: nothing from later tasks
- Produces:
  - `pub const CRED_FIELD_USERNAME/PASSWORD/TOKEN/API_KEY/HEADER_NAME`
  - `pub const DEFAULT_API_KEY_HEADER: &str = "X-API-Key"`
  - `pub struct CredentialFields { id: i32, name: String, kind: String, username: Option<String>, header_name: Option<String>, secret: Option<String> }`
  - `pub struct CredentialStore` with `Default + Clone`
  - `CredentialStore::insert`, `get_by_id`, `get_by_name`, `get_field`, `secret_values`
  - `pub fn parse_cred_path(path: &str) -> Option<(&str, &str)>`
  - `pub fn apply_http_auth_headers(headers: &mut serde_json::Map<String, serde_json::Value>, cred: &CredentialFields) -> Result<(), String>`
  - `pub fn validate_kind(kind: &str) -> Result<String, String>`
  - `pub fn validate_header_name(name: &str) -> Result<Option<String>, String>`
  - `pub fn validate_kind_fields(kind: &str, username: Option<&str>) -> Result<(), String>`
  - `pub fn datasource_accepts_kind(kind: &str) -> bool`

- [ ] **Step 1: Write the failing tests**

Create `src/workflow_credentials.rs` with only the test module first (file will not compile until types exist — write types as `todo!()` stubs if needed so tests compile and fail on asserts). Prefer: write full types + empty impls that make tests fail, then fill.

```rust
//! 项目凭证运行时：装载结果、模板解析、HTTP 头注入、字段校验。
//! 密钥明文只短暂留在 `CredentialFields.secret`；`Debug` 不打印 secret。

use serde_json::{json, Map, Value};
use std::collections::HashMap;

pub const DEFAULT_API_KEY_HEADER: &str = "X-API-Key";
pub const CRED_FIELD_USERNAME: &str = "username";
pub const CRED_FIELD_PASSWORD: &str = "password";
pub const CRED_FIELD_TOKEN: &str = "token";
pub const CRED_FIELD_API_KEY: &str = "api_key";
pub const CRED_FIELD_HEADER_NAME: &str = "header_name";

#[derive(Clone)]
pub struct CredentialFields {
    pub id: i32,
    pub name: String,
    pub kind: String,
    pub username: Option<String>,
    pub header_name: Option<String>,
    pub secret: Option<String>,
}

impl std::fmt::Debug for CredentialFields {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CredentialFields")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("kind", &self.kind)
            .field("username", &self.username)
            .field("header_name", &self.header_name)
            .field("secret", &self.secret.as_ref().map(|_| "<masked>"))
            .finish()
    }
}

#[derive(Clone, Default)]
pub struct CredentialStore {
    by_id: HashMap<i32, CredentialFields>,
    by_name: HashMap<String, CredentialFields>,
}

impl std::fmt::Debug for CredentialStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CredentialStore")
            .field("count", &self.by_id.len())
            .finish()
    }
}

impl CredentialStore {
    pub fn insert(&mut self, cred: CredentialFields) {
        self.by_id.insert(cred.id, cred.clone());
        self.by_name.insert(cred.name.clone(), cred);
    }

    pub fn get_by_id(&self, id: i32) -> Option<&CredentialFields> {
        self.by_id.get(&id)
    }

    pub fn get_by_name(&self, name: &str) -> Option<&CredentialFields> {
        self.by_name.get(name)
    }

    pub fn get_field(&self, name: &str, field: &str) -> Option<String> {
        let cred = self.by_name.get(name)?;
        field_value(cred, field)
    }

    pub fn secret_values(&self) -> Vec<&str> {
        self.by_id
            .values()
            .filter_map(|c| c.secret.as_deref())
            .filter(|s| s.len() >= 4)
            .collect()
    }

    pub fn len(&self) -> usize {
        self.by_id.len()
    }
}

fn effective_header_name(cred: &CredentialFields) -> String {
    cred.header_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_API_KEY_HEADER)
        .to_string()
}

pub fn field_value(cred: &CredentialFields, field: &str) -> Option<String> {
    match (cred.kind.as_str(), field) {
        ("basic", CRED_FIELD_USERNAME) => cred.username.clone(),
        ("basic", CRED_FIELD_PASSWORD) => cred.secret.clone(),
        ("bearer", CRED_FIELD_TOKEN) => cred.secret.clone(),
        ("api_key", CRED_FIELD_API_KEY) => cred.secret.clone(),
        ("api_key", CRED_FIELD_HEADER_NAME) => Some(effective_header_name(cred)),
        _ => None,
    }
}

/// `cred.` 之后的路径：最后一段是字段，前面整段是名称。
pub fn parse_cred_path(path: &str) -> Option<(&str, &str)> {
    let dot = path.rfind('.')?;
    if dot == 0 || dot + 1 == path.len() {
        return None;
    }
    let name = &path[..dot];
    let field = &path[dot + 1..];
    if name.is_empty() || field.is_empty() {
        return None;
    }
    Some((name, field))
}

pub fn apply_http_auth_headers(
    headers: &mut Map<String, Value>,
    cred: &CredentialFields,
) -> Result<(), String> {
    let secret = cred
        .secret
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("凭证 {} 解密失败", cred.name))?;
    match cred.kind.as_str() {
        "basic" => {
            let user = cred.username.as_deref().unwrap_or("");
            let raw = format!("{user}:{secret}");
            let encoded = base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                raw.as_bytes(),
            );
            headers.insert(
                "Authorization".to_string(),
                json!(format!("Basic {encoded}")),
            );
        }
        "bearer" => {
            headers.insert(
                "Authorization".to_string(),
                json!(format!("Bearer {secret}")),
            );
        }
        "api_key" => {
            let header = effective_header_name(cred);
            headers.insert(header, json!(secret));
        }
        other => return Err(format!("不支持的凭证类型：{other}")),
    }
    Ok(())
}

pub fn validate_kind(kind: &str) -> Result<String, String> {
    let kind = kind.trim().to_string();
    if matches!(kind.as_str(), "basic" | "bearer" | "api_key") {
        Ok(kind)
    } else {
        Err(format!(
            "非法凭证类型：{kind}（仅支持 basic / bearer / api_key）"
        ))
    }
}

pub fn validate_header_name(name: &str) -> Result<Option<String>, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > 128 {
        return Err("header_name 过长（上限 128 字符）".to_string());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("header_name 只允许字母数字、下划线和连字符".to_string());
    }
    Ok(Some(trimmed.to_string()))
}

pub fn validate_kind_fields(kind: &str, username: Option<&str>) -> Result<(), String> {
    if kind == "basic" {
        let ok = username
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_some();
        if !ok {
            return Err("basic 凭证必须填写用户名".to_string());
        }
    }
    Ok(())
}

pub fn datasource_accepts_kind(kind: &str) -> bool {
    kind == "basic"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn basic() -> CredentialFields {
        CredentialFields {
            id: 1,
            name: "生产库账号".into(),
            kind: "basic".into(),
            username: Some("app_ro".into()),
            header_name: None,
            secret: Some("s3cret-pass".into()),
        }
    }

    fn bearer() -> CredentialFields {
        CredentialFields {
            id: 2,
            name: "obm_token".into(),
            kind: "bearer".into(),
            username: None,
            header_name: None,
            secret: Some("tok_abc".into()),
        }
    }

    fn api_key() -> CredentialFields {
        CredentialFields {
            id: 3,
            name: "stripe".into(),
            kind: "api_key".into(),
            username: None,
            header_name: None,
            secret: Some("sk_live_abcdef".into()),
        }
    }

    #[test]
    fn parse_cred_path_chinese_name() {
        assert_eq!(
            parse_cred_path("生产库账号.password"),
            Some(("生产库账号", "password"))
        );
    }

    #[test]
    fn parse_cred_path_requires_field() {
        assert_eq!(parse_cred_path("生产库账号"), None);
        assert_eq!(parse_cred_path(".password"), None);
    }

    #[test]
    fn store_lookup_hit_and_kind_mismatch() {
        let mut store = CredentialStore::default();
        store.insert(basic());
        store.insert(bearer());
        assert_eq!(
            store.get_field("生产库账号", "password").as_deref(),
            Some("s3cret-pass")
        );
        assert_eq!(
            store.get_field("生产库账号", "username").as_deref(),
            Some("app_ro")
        );
        assert_eq!(store.get_field("生产库账号", "token"), None);
        assert_eq!(store.get_field("missing", "password"), None);
        assert_eq!(
            store.get_field("obm_token", "token").as_deref(),
            Some("tok_abc")
        );
    }

    #[test]
    fn api_key_header_defaults() {
        let cred = api_key();
        assert_eq!(
            field_value(&cred, "header_name").as_deref(),
            Some(DEFAULT_API_KEY_HEADER)
        );
        let mut named = cred.clone();
        named.header_name = Some("X-Custom-Key".into());
        assert_eq!(
            field_value(&named, "header_name").as_deref(),
            Some("X-Custom-Key")
        );
    }

    #[test]
    fn apply_headers_overwrites_authorization() {
        let mut headers = Map::new();
        headers.insert("Authorization".into(), json!("Bearer old"));
        apply_http_auth_headers(&mut headers, &bearer()).unwrap();
        assert_eq!(headers["Authorization"], json!("Bearer tok_abc"));
    }

    #[test]
    fn apply_headers_basic_and_api_key() {
        let mut headers = Map::new();
        apply_http_auth_headers(&mut headers, &basic()).unwrap();
        let auth = headers["Authorization"].as_str().unwrap();
        assert!(auth.starts_with("Basic "));

        let mut headers = Map::new();
        apply_http_auth_headers(&mut headers, &api_key()).unwrap();
        assert_eq!(headers[DEFAULT_API_KEY_HEADER], json!("sk_live_abcdef"));
    }

    #[test]
    fn validate_kind_and_header_name() {
        assert_eq!(validate_kind(" api_key ").unwrap(), "api_key");
        assert!(validate_kind("oauth").is_err());
        assert_eq!(validate_header_name("").unwrap(), None);
        assert_eq!(
            validate_header_name(" X-API-Key ").unwrap(),
            Some("X-API-Key".into())
        );
        assert!(validate_header_name("X API").is_err());
        assert!(validate_header_name("X:Key").is_err());
        assert!(validate_kind_fields("basic", Some("")).is_err());
        assert!(validate_kind_fields("basic", Some("u")).is_ok());
        assert!(datasource_accepts_kind("basic"));
        assert!(!datasource_accepts_kind("bearer"));
    }

    #[test]
    fn secret_values_skips_short_and_failed() {
        let mut store = CredentialStore::default();
        store.insert(basic());
        let mut failed = bearer();
        failed.secret = None;
        store.insert(failed);
        assert_eq!(store.secret_values(), vec!["s3cret-pass"]);
    }
}
```

If `base64` is not already a crate dependency used this way, the project already uses `base64` in `js_host_bridge.rs`. Same import style:

```rust
use base64::{engine::general_purpose, Engine as _};
// ...
let encoded = general_purpose::STANDARD.encode(raw.as_bytes());
```

Use that instead of the fully-qualified path in the snippet above.

- [ ] **Step 2: Register the module**

In `src/lib.rs`, next to `pub mod workflow_engine;`:

```rust
pub mod workflow_credentials;
```

In `src/main.rs`, next to `mod workflow_engine;`:

```rust
mod workflow_credentials;
```

- [ ] **Step 3: Run tests**

Run: `cargo test --lib workflow_credentials -- --nocapture`

Expected: PASS (all tests in this module).

- [ ] **Step 4: Commit** (skip unless asked)

```bash
git add src/workflow_credentials.rs src/lib.rs src/main.rs
git commit -m "feat: add project credential runtime helpers."
```

---

### Task 2: ExecutionContext, template, mask, load

**Files:**
- Modify: `src/workflow_credentials.rs` (add `load_credential_store`)
- Modify: `src/workflow_engine.rs`
- Modify: `src/workflow_handlers.rs`

**Interfaces:**
- Consumes: `CredentialStore`, `parse_cred_path`, `get_field`, `secret_values` from Task 1
- Produces: `ExecutionContext.credentials: CredentialStore`; `{{cred.名称.字段}}`; `mask_env_and_credentials`; `load_credential_store`

- [ ] **Step 1: Write failing template / mask tests in `workflow_engine.rs`**

Next to `test_env_template_resolution` (~line 7319), add:

```rust
    #[test]
    fn test_cred_template_resolution() {
        let mut credentials = crate::workflow_credentials::CredentialStore::default();
        credentials.insert(crate::workflow_credentials::CredentialFields {
            id: 1,
            name: "生产库账号".into(),
            kind: "basic".into(),
            username: Some("app_ro".into()),
            header_name: None,
            secret: Some("s3cret-pass".into()),
        });
        let ctx = ExecutionContext {
            workflow_id: 1,
            run_id: 1,
            trigger_type: "manual".into(),
            trigger_data: json!({}),
            user_id: None,
            tenant_id: Some(1),
            database_id: None,
            node_outputs: HashMap::new(),
            env_vars: HashMap::new(),
            credentials,
            workflow_dependencies: json!({}),
            dry_run: false,
            prod_readonly: false,
            apikey_write_guard: ApiKeyWriteGuard::Off,
        };
        assert_eq!(
            resolve_template(&json!("{{cred.生产库账号.password}}"), &ctx),
            json!("s3cret-pass")
        );
        assert_eq!(
            resolve_template(&json!("{{cred.生产库账号.username}}"), &ctx),
            json!("app_ro")
        );
        assert_eq!(
            resolve_template(&json!("{{cred.生产库账号.token}}"), &ctx),
            json!("")
        );
        assert_eq!(
            resolve_template(&json!("{{cred.NOT_SET.password}}"), &ctx),
            json!("")
        );
    }

    #[test]
    fn test_mask_env_and_credentials() {
        let mut env_vars = HashMap::new();
        env_vars.insert("K".into(), "envsecret99".into());
        let mut credentials = crate::workflow_credentials::CredentialStore::default();
        credentials.insert(crate::workflow_credentials::CredentialFields {
            id: 1,
            name: "c".into(),
            kind: "bearer".into(),
            username: None,
            header_name: None,
            secret: Some("tok_secret_xyz".into()),
        });
        let value = json!({
            "a": "Bearer tok_secret_xyz",
            "b": "envsecret99",
            "user": "visible"
        });
        let masked = mask_env_and_credentials(&value, &env_vars, &credentials);
        assert_eq!(masked["a"], json!("Bearer ***"));
        assert_eq!(masked["b"], json!("***"));
        assert_eq!(masked["user"], json!("visible"));
    }
```

- [ ] **Step 2: Run to verify compile/fail**

Run: `cargo test --lib test_cred_template_resolution -- --nocapture`

Expected: compile error (`no field credentials` / `mask_env_and_credentials not found`) or FAIL.

- [ ] **Step 3: Implement**

Add to `ExecutionContext`:

```rust
    pub credentials: crate::workflow_credentials::CredentialStore,
```

In the hand-written `Debug` impl, after `env_vars`:

```rust
            .field(
                "credentials",
                &format_args!("<{} credentials masked>", self.credentials.len()),
            )
```

Add `credentials: ctx.credentials.clone()` everywhere this struct is copied field-by-field (subworkflow ~3276, code-node paths that rebuild ctx). For every `ExecutionContext {` literal in `src/workflow_engine.rs` and `src/workflow_handlers.rs`, add:

```rust
            credentials: crate::workflow_credentials::CredentialStore::default(),
```

unless the test supplies a real store.

In `resolve_path`, immediately after the `env.` block:

```rust
    if let Some(rest) = path.strip_prefix("cred.") {
        return match crate::workflow_credentials::parse_cred_path(rest)
            .and_then(|(name, field)| ctx.credentials.get_field(name, field))
        {
            Some(v) => JsonValue::String(v),
            None => {
                tracing::warn!(
                    path = rest,
                    "模板引用了未定义的凭证字段 {{cred.名称.字段}}，已渲染为空串"
                );
                JsonValue::String(String::new())
            }
        };
    }
```

Keep `mask_env_values` as a wrapper. Add:

```rust
pub fn mask_env_and_credentials(
    value: &JsonValue,
    env_vars: &HashMap<String, String>,
    credentials: &crate::workflow_credentials::CredentialStore,
) -> JsonValue {
    let mut secrets: Vec<&str> = env_vars
        .values()
        .filter(|v| v.len() >= 4)
        .map(|s| s.as_str())
        .collect();
    secrets.extend(credentials.secret_values());
    if secrets.is_empty() {
        return value.clone();
    }
    secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
    mask_in_value(value, &secrets)
}

pub fn mask_env_values(value: &JsonValue, env_vars: &HashMap<String, String>) -> JsonValue {
    mask_env_and_credentials(
        value,
        env_vars,
        &crate::workflow_credentials::CredentialStore::default(),
    )
}
```

Replace persist/debug mask call sites that have an `ExecutionContext` (`workflow_engine.rs` ~2265 and `workflow_handlers.rs` ~2925 / ~4176 / ~4249 / ~4321) with:

```rust
workflow_engine::mask_env_and_credentials(&json!(...), &exec_ctx.env_vars, &exec_ctx.credentials)
```

Add loader at the bottom of `src/workflow_credentials.rs` (needs `sqlx`, `crypto`, `permissions` — `permissions` is bin+lib). If `permissions::lookup_tenant_for_database` is awkward from lib, copy the same tenant-resolution block already in `load_env_vars` (`workflow_handlers.rs` 3984–4001) into this function by taking an already-resolved `tenant_id: i32` instead:

```rust
pub async fn load_credential_store(
    pool: &sqlx::PgPool,
    tenant_id: i32,
) -> CredentialStore {
    use sqlx::Row;
    let rows = match sqlx::query(
        r#"SELECT id, name, kind, username, header_name, secret_encrypted
           FROM management.wf_credentials WHERE tenant_id = $1"#,
    )
    .bind(tenant_id)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!(tenant_id, error = %e, "加载项目凭证失败，按空表降级");
            return CredentialStore::default();
        }
    };
    let mut store = CredentialStore::default();
    for row in rows {
        let id: i32 = row.get("id");
        let name: String = row.get("name");
        let secret = match crate::crypto::decrypt_secret(row.get("secret_encrypted")) {
            Ok(v) => Some(v),
            Err(e) => {
                tracing::error!(tenant_id, name = %name, error = %e, "凭证解密失败，跳过该条");
                None
            }
        };
        store.insert(CredentialFields {
            id,
            name,
            kind: row.get("kind"),
            username: row.get("username"),
            header_name: row.get("header_name"),
            secret,
        });
    }
    store
}
```

**Migration must land before this SQL is used in production**, but unit tests do not hit it. If `header_name` is missing (Task 3 not applied in a running DB), the SELECT fails and loader returns empty — acceptable until Task 3.

In `workflow_handlers.rs`, next to both `load_env_vars(...)` calls:

```rust
    let credentials = match resolved_tenant_id {
        Some(tid) => crate::workflow_credentials::load_credential_store(pool, tid).await,
        None => crate::workflow_credentials::CredentialStore::default(),
    };
```

(Use the same `effective_tenant` already computed inside `load_env_vars`. Best: change `load_env_vars` to return tenant id, or duplicate the 15-line tenant resolve. Duplicating is fine for this task.)

Pass `credentials` into both `ExecutionContext { ... }` literals.

- [ ] **Step 4: Run tests**

Run:

```
cargo test --lib test_cred_template_resolution test_mask_env_and_credentials test_env_template_resolution test_mask_env_values -- --nocapture
```

Expected: PASS. Then `cargo test --lib workflow_engine -- --test-threads=8` — existing engine tests must still compile and pass.

- [ ] **Step 5: Commit** (skip unless asked)

```bash
git add src/workflow_credentials.rs src/workflow_engine.rs src/workflow_handlers.rs
git commit -m "feat: resolve and mask project credentials in workflow runs."
```

---

### Task 3: HTTP `credential_id` + datasource kind at execute

**Files:**
- Modify: `src/workflow_engine.rs` (`exec_http_call_node`, `load_datasource_meta`)

**Interfaces:**
- Consumes: `CredentialStore::get_by_id`, `apply_http_auth_headers`, `datasource_accepts_kind`
- Produces: http_call reads `config.credential_id`; missing/decrypt-failed credential fails the node; datasource non-basic fails

- [ ] **Step 1: Write failing unit tests**

Add in `workflow_engine.rs` tests:

```rust
    #[test]
    fn merge_http_credential_headers_bearer_overwrites() {
        let cred = crate::workflow_credentials::CredentialFields {
            id: 9,
            name: "crm".into(),
            kind: "bearer".into(),
            username: None,
            header_name: None,
            secret: Some("tok_new".into()),
        };
        let mut headers = serde_json::Map::new();
        headers.insert("Authorization".into(), json!("Bearer old"));
        crate::workflow_credentials::apply_http_auth_headers(&mut headers, &cred).unwrap();
        assert_eq!(headers["Authorization"], json!("Bearer tok_new"));
    }
```

This test already passes after Task 1. Add the real node-level test as a focused helper:

```rust
    fn inject_http_credential(
        config: &JsonValue,
        ctx: &ExecutionContext,
        headers: &mut serde_json::Map<String, JsonValue>,
    ) -> Result<(), String> {
        let Some(id) = config.get("credential_id").and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_u64().map(|n| n as i64))
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        }) else {
            return Ok(());
        };
        let cred = ctx
            .credentials
            .get_by_id(id as i32)
            .ok_or_else(|| format!("凭证 {id} 不存在"))?;
        if cred.secret.is_none() {
            return Err(format!("凭证 {} 解密失败", cred.name));
        }
        crate::workflow_credentials::apply_http_auth_headers(headers, cred)
    }

    #[test]
    fn inject_http_credential_missing_id_fails() {
        let ctx = sample_ctx_with_trigger(json!({}));
        let mut headers = serde_json::Map::new();
        let err = inject_http_credential(&json!({"credential_id": 99}), &ctx, &mut headers)
            .unwrap_err();
        assert!(err.contains("99"));
        assert!(!err.contains("tok_"));
    }
```

Put `inject_http_credential` in the production module (not only tests), then call it from `exec_http_call_node`.

- [ ] **Step 2: Implement injection in `exec_http_call_node`**

After headers are parsed into `headers: Option<JsonValue>` (~4332), before building the request (both stream and non-stream paths share one headers value):

```rust
        let mut headers_obj = match headers {
            Some(JsonValue::Object(map)) => map,
            Some(_) => {
                return Err(AppError::InvalidQuery(
                    "http_call.headers 必须是对象".to_string(),
                ))
            }
            None => serde_json::Map::new(),
        };
        if let Err(msg) = inject_http_credential(config, ctx, &mut headers_obj) {
            return Err(AppError::InvalidQuery(msg));
        }
        let headers = if headers_obj.is_empty() {
            None
        } else {
            Some(JsonValue::Object(headers_obj))
        };
```

Rebuild `auth_headers` HashMap from this merged `headers` (existing code ~4336). Stream and non-stream both use `headers`, so one merge covers both.

- [ ] **Step 3: Datasource execute rejects non-basic**

In `load_datasource_meta` SELECT add `c.kind AS cred_kind`. After reading the row:

```rust
    let cred_kind: Option<String> = row.try_get("cred_kind").ok().flatten();
    if let Some(kind) = cred_kind {
        if !crate::workflow_credentials::datasource_accepts_kind(&kind) {
            return Err(AppError::InvalidQuery(format!(
                "数据源 {} 绑定的凭证类型是 {kind}，请改绑 basic",
                ds_id
            )));
        }
    }
```

If `try_get` is messy because the column is `String` not Option, use `row.get::<Option<String>, _>("cred_kind")`.

- [ ] **Step 4: Run tests**

Run: `cargo test --lib inject_http_credential_missing_id_fails merge_http_credential_headers_bearer_overwrites -- --nocapture`

Expected: PASS.

- [ ] **Step 5: Commit** (skip unless asked)

```bash
git add src/workflow_engine.rs
git commit -m "feat: inject credential headers on http_call nodes."
```

---

### Task 4: Migration + credential API

**Files:**
- Create: `migrations/064_wf_credentials_api_key.sql`
- Modify: `src/migrate.rs` (append 064 after 063)
- Modify: `src/datasource_handlers.rs`
- Modify: `src/main.rs` (routes)
- Modify: `src/operation_log.rs` (`resource_type::CREDENTIAL`)

**Interfaces:**
- Consumes: `validate_kind`, `validate_header_name`, `validate_kind_fields`, `datasource_accepts_kind`
- Produces: `/api/projects/:id/credentials` (+ old alias); list = `require_tenant_member`; writes = `require_tenant_admin`; JSON includes `header_name`; create requires secret; update empty secret keeps ciphertext

- [ ] **Step 1: Migration**

`migrations/064_wf_credentials_api_key.sql`:

```sql
-- 项目凭证增加 api_key：非机密 header_name。kind 仍由 handler 校验。
ALTER TABLE management.wf_credentials
    ADD COLUMN IF NOT EXISTS header_name VARCHAR(128);

COMMENT ON COLUMN management.wf_credentials.header_name IS
    'api_key 请求头名；空则运行时按 X-API-Key。可回显。';
```

In `src/migrate.rs` after the 063 tuple:

```rust
    (
        "064 wf credentials api key",
        include_str!("../migrations/064_wf_credentials_api_key.sql"),
    ),
```

- [ ] **Step 2: Handler + routes**

In `datasource_handlers.rs`:

- Delete local `ALLOWED_KINDS`.
- Add `header_name: Option<String>` to `CredentialRequest`.
- `list_credentials`: `require_tenant_member` instead of `require_tenant_admin`.
- create/update/delete: keep `require_tenant_admin`.
- create/update: `let kind = workflow_credentials::validate_kind(...)?` mapped through `AppError::InvalidQuery`.
- create/update: `validate_kind_fields(&kind, req.username.as_deref())`.
- `header_name` only stored when `kind == "api_key"`; otherwise bind `NULL`. Validate with `validate_header_name`.
- INSERT/UPDATE/RETURNING include `header_name`.
- `credential_row_to_json` add `"header_name": row.get::<Option<String>, _>("header_name")`.
- SELECT lists must include `header_name`.
- create: secret still required.
- For `bearer` / `api_key`, bind `username` as `NULL` (ignore leftover username).
- In `ensure_credential_in_project` (or create/update datasource): after existence check, load `kind` and reject if `!datasource_accepts_kind(kind)` with message `数据源只能绑定 basic 凭证`.

Add write audit using env-var pattern. In `operation_log.rs` `resource_type`:

```rust
    pub const CREDENTIAL: &str = "凭证";
```

Record create/update/delete with name, kind, id — never secret.

In `src/main.rs`, keep existing `/wf-credentials` routes. Add the same handlers on:

```rust
        .route(
            "/api/projects/:id/credentials",
            get(datasource_handlers::list_credentials).post(datasource_handlers::create_credential),
        )
        .route(
            "/api/projects/:id/credentials/:cred_id",
            axum::routing::put(datasource_handlers::update_credential)
                .delete(datasource_handlers::delete_credential),
        )
```

Update the module doc comment at the top of `datasource_handlers.rs` to list both paths and the new list permission.

- [ ] **Step 3: Compile**

Run: `cargo check`

Expected: success. Restart `cargo run` so migration 064 applies (existing terminal may already be running).

- [ ] **Step 4: Commit** (skip unless asked)

```bash
git add migrations/064_wf_credentials_api_key.sql src/migrate.rs src/datasource_handlers.rs src/main.rs src/operation_log.rs
git commit -m "feat: project credentials API with api_key and no secret echo."
```

---

### Task 5: Lua `cred.get`

**Files:**
- Modify: `src/lua_builtins.rs`
- Modify: `src/lua_engine.rs`
- Modify: `src/workflow_engine.rs` (Lua code-node builder ~3577)

**Interfaces:**
- Consumes: `CredentialStore::get_field`
- Produces: `LuaEngine::with_credentials`; `cred.get(name, field)` → string | nil

- [ ] **Step 1: Write failing tests in `lua_builtins.rs`**

Change `register_builtins` signature to take credentials. Add a two-arg wrapper so existing tests still compile:

```rust
pub fn register_builtins(lua: &Lua, env_vars: HashMap<String, String>) -> LuaResult<()> {
    register_builtins_with_creds(lua, env_vars, crate::workflow_credentials::CredentialStore::default())
}

pub fn register_builtins_with_creds(
    lua: &Lua,
    env_vars: HashMap<String, String>,
    credentials: crate::workflow_credentials::CredentialStore,
) -> LuaResult<()> {
    register_json_module(lua)?;
    register_log_module(lua)?;
    register_crypto_module(lua)?;
    register_zlib_module(lua)?;
    register_env_module(lua, env_vars)?;
    register_cred_module(lua, credentials)?;
    register_sse_module(lua)?;
    register_time_module(lua)?;
    Ok(())
}
```

```rust
fn register_cred_module(
    lua: &Lua,
    credentials: crate::workflow_credentials::CredentialStore,
) -> LuaResult<()> {
    let cred = lua.create_table()?;
    cred.set(
        "get",
        lua.create_function(move |_, (name, field): (String, String)| {
            Ok(credentials.get_field(&name, &field))
        })?,
    )?;
    lua.globals().set("cred", cred)?;
    Ok(())
}
```

Test:

```rust
    #[test]
    fn test_cred_get_hit_and_miss() {
        let lua = Lua::new();
        let mut store = crate::workflow_credentials::CredentialStore::default();
        store.insert(crate::workflow_credentials::CredentialFields {
            id: 1,
            name: "生产库账号".into(),
            kind: "basic".into(),
            username: Some("u".into()),
            header_name: None,
            secret: Some("p".into()),
        });
        register_builtins_with_creds(&lua, HashMap::new(), store).unwrap();
        lua.load(
            r#"
            assert(cred.get("生产库账号", "password") == "p")
            assert(cred.get("生产库账号", "token") == nil)
            assert(cred.get("nope", "password") == nil)
            "#,
        )
        .exec()
        .unwrap();
    }
```

- [ ] **Step 2: Wire LuaEngine**

Add field `credentials: CredentialStore` to `LuaEngine`, default empty in `new()`. Add `with_credentials(mut self, credentials: CredentialStore) -> Self`. In `create_sandbox_lua` call `register_builtins_with_creds(&lua, self.env_vars.clone(), self.credentials.clone())?`.

In `workflow_engine.rs` where `.with_env_vars(ctx.env_vars.clone())` is used, also `.with_credentials(ctx.credentials.clone())`.

- [ ] **Step 3: Run tests**

Run: `cargo test --lib test_cred_get_hit_and_miss test_env_get_reads_configured_var -- --nocapture`

Expected: PASS.

- [ ] **Step 4: Commit** (skip unless asked)

```bash
git add src/lua_builtins.rs src/lua_engine.rs src/workflow_engine.rs
git commit -m "feat: expose cred.get to Lua code nodes."
```

---

### Task 6: JS / Python `cred.get`

**Files:**
- Modify: `src/js_host_bridge.rs`
- Modify: `src/js_runner.rs`
- Modify: `src/py_runner.rs`
- Modify: `js-runtime/onebase-runtime/index.js`
- Modify: `py-runtime/onebase_runtime/onebase_host.py`
- Modify: `src/workflow_engine.rs` (`JsExecRequest` / `PyExecRequest` construction)

**Interfaces:**
- Consumes: `CredentialStore::get_field`
- Produces: IPC `cred.get` `{ name, field }`; JS `cred.get(name, field)`; Python `cred.get(name, field)`

- [ ] **Step 1: Bridge + runtimes**

`HostBridgeConfig` add:

```rust
    pub credentials: crate::workflow_credentials::CredentialStore,
```

In `handle_request`, next to `"env.get"`:

```rust
        "cred.get" => Ok(args
            .get("name")
            .and_then(Value::as_str)
            .and_then(|name| {
                args.get("field")
                    .and_then(Value::as_str)
                    .and_then(|field| config.credentials.get_field(name, field))
            })
            .map(Value::String)
            .unwrap_or(Value::Null)),
```

Update every `HostBridgeConfig {` (js_host_bridge tests, js_runner, py_runner) with `credentials: CredentialStore::default()` or the request's store.

`JsExecRequest` / `PyExecRequest` add `pub credentials: CredentialStore`. Pass `ctx.credentials.clone()` from `workflow_engine.rs`. Existing tests that build these structs: add `credentials: Default::default()`.

`js-runtime/onebase-runtime/index.js` after `env`:

```javascript
installGlobal('cred', { get: (name, field) => call('cred.get', { name, field }) });
```

`py-runtime/onebase_runtime/onebase_host.py` after `env`:

```python
cred = SimpleNamespace(get=lambda name, field: _call("cred.get", {"name": name, "field": field}))
```

- [ ] **Step 2: Tests**

In `js_host_bridge.rs` tests, clone the existing node test:

```rust
    #[tokio::test]
    async fn node_runtime_reads_injected_credential() {
        if Command::new("node").arg("--version").output().is_err() {
            return;
        }
        let socket_path =
            PathBuf::from("/tmp").join(format!("ctr-js-cred-{}.sock", uuid::Uuid::new_v4()));
        let mut credentials = crate::workflow_credentials::CredentialStore::default();
        credentials.insert(crate::workflow_credentials::CredentialFields {
            id: 1,
            name: "crm".into(),
            kind: "bearer".into(),
            username: None,
            header_name: None,
            secret: Some("tok_abc".into()),
        });
        let bridge = start_bridge(HostBridgeConfig {
            env_vars: HashMap::new(),
            credentials,
            tenant_id: None,
            http_disabled: false,
            socket_path: socket_path.clone(),
        })
        .await
        .expect("bridge starts");
        let runtime =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("js-runtime/onebase-runtime/index.js");
        let output = tokio::task::spawn_blocking(move || {
            Command::new("node")
                .arg("--require")
                .arg(runtime)
                .arg("-e")
                .arg("process.stdout.write(String(cred.get('crm','token')))")
                .env("ONEBASE_HOST_SOCK", &socket_path)
                .output()
                .expect("node starts")
        })
        .await
        .expect("node task completes");
        bridge.shutdown().await;
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout), "tok_abc");
    }
```

In `py_runner.rs` tests, add a case mirroring `env.get('API_TOKEN')` that uses `cred.get('crm','token')` and sets `req.credentials`. Skip if Python is unavailable, same as existing tests.

- [ ] **Step 3: Run tests**

Run:

```
cargo test --lib node_runtime_reads_injected_credential node_runtime_reads_injected_environment_value -- --nocapture
cargo test --lib py_runner -- --nocapture
```

Expected: PASS (or skip if node/python missing).

- [ ] **Step 4: Commit** (skip unless asked)

```bash
git add src/js_host_bridge.rs src/js_runner.rs src/py_runner.rs src/workflow_engine.rs js-runtime/onebase-runtime/index.js py-runtime/onebase_runtime/onebase_host.py
git commit -m "feat: expose cred.get to JS and Python code nodes."
```

---

### Task 7: Settings page + API client + nav

**Files:**
- Modify: `frontend-nextjs/lib/api.ts`
- Modify: `frontend-nextjs/components/workspace/workspaceNav.ts`
- Create: `frontend-nextjs/app/workspace/[projectId]/settings/credentials/page.tsx`

**Interfaces:**
- Consumes: `/api/projects/:id/credentials` from Task 4
- Produces: `WfCredential.header_name`, `WfCredentialKind = 'basic' | 'bearer' | 'api_key'`, settings nav item, management page

- [ ] **Step 1: API types**

In `frontend-nextjs/lib/api.ts`, change `WfCredentialKind` to `'basic' | 'bearer' | 'api_key'`. Add `header_name: string | null` to `WfCredential`. Add `header_name?: string | null` to `WfCredentialWriteBody`.

Point `wfCredentialAPI` at `/credentials` (keep the functions; only the URL changes). Old `/wf-credentials` remains on the server as an alias.

```ts
export const wfCredentialAPI = {
  list: (projectId: number) =>
    api.get<WfCredential[]>(`/api/projects/${projectId}/credentials`),
  create: (projectId: number, body: WfCredentialWriteBody) =>
    api.post<WfCredential>(`/api/projects/${projectId}/credentials`, body),
  update: (projectId: number, credId: number, body: WfCredentialWriteBody) =>
    api.put<WfCredential>(`/api/projects/${projectId}/credentials/${credId}`, body),
  remove: (projectId: number, credId: number) =>
    api.delete(`/api/projects/${projectId}/credentials/${credId}`),
}
```

- [ ] **Step 2: Nav**

In `workspaceNav.ts`, after 环境变量:

```ts
      {
        label: '凭证管理',
        href: '/settings/credentials',
        icon: 'fas fa-key',
        visibleIf: (caps) => caps.canManageMembers,
      },
```

- [ ] **Step 3: Page**

Create `frontend-nextjs/app/workspace/[projectId]/settings/credentials/page.tsx` by moving the credentials-tab UI from `events/datasources/page.tsx` (cards + modal). Differences:

- `canManageMembers` gate (same as env-vars), not `canManageEvents`.
- Kind select includes `api_key`（API Key）.
- When `kind === 'api_key'`, show `header_name` input placeholder `X-API-Key`.
- Secret input: `type="password"`, placeholder `留空表示保持不变` when editing.
- Page blurb:

```
凭证加密存储，密钥只写不回显。工作流模板用 {{cred.名称.password}} / {{cred.名称.token}} / {{cred.名称.api_key}}，代码节点用 cred.get("名称", "字段")。HTTP 节点和下方数据源可下拉引用。
```

Reuse the same `Modal` / `Field` / `ModalFooter` local components (copy into this file; do not export from datasources).

Submit body:

```ts
{
  name,
  kind,
  username: kind === 'basic' ? username : null,
  header_name: kind === 'api_key' ? header_name : null,
  secret: secret || null,
  description,
}
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend-nextjs && npx tsc --noEmit --pretty false`

Expected: no errors in the new page / api types.

- [ ] **Step 5: Commit** (skip unless asked)

```bash
git add frontend-nextjs/lib/api.ts frontend-nextjs/components/workspace/workspaceNav.ts frontend-nextjs/app/workspace/[projectId]/settings/credentials/page.tsx
git commit -m "feat: add settings page for project credentials."
```

---

### Task 8: Datasource page, HTTP picker, MCP docs

**Files:**
- Modify: `frontend-nextjs/app/workspace/[projectId]/events/datasources/page.tsx`
- Modify: `frontend-nextjs/components/workflow/NodeConfigPanel.tsx`
- Modify: `src/mcp_tools.rs`

**Interfaces:**
- Consumes: `wfCredentialAPI.list`, settings route
- Produces: datasource page without credentials tab; HTTP node `credential_id` select; MCP text

- [ ] **Step 1: Datasource page**

- Remove `Tab`, credentials grid, cred modal, `EMPTY_CRED_FORM`, create-credential button branch.
- Always show the datasource table.
- Header button only「新增数据源」.
- Credential `<select>` options: `credentials.filter((c) => c.kind === 'basic')`.
- Under the select:

```tsx
<p className="text-[11px] text-gray-400 mt-1">
  仅列出用户名/密码凭证。
  <a className="text-blue-600 hover:underline ml-1" href={`/workspace/${projectId}/settings/credentials`}>
    去设置中管理
  </a>
</p>
```

- Update the file header comment: 凭证入口已迁到设置。

- [ ] **Step 2: HTTP node picker**

In `NodeConfigPanel.tsx`, next to the datasource `useEffect`, load credentials when `node?.type === 'http_call'`:

```tsx
  const [httpCredentials, setHttpCredentials] = useState<WfCredential[]>([])
  const isHttpNode = node?.type === 'http_call'
  useEffect(() => {
    const pid = Number(params?.projectId)
    if (!isHttpNode || !Number.isFinite(pid)) return
    let cancelled = false
    wfCredentialAPI
      .list(pid)
      .then((res) => {
        if (!cancelled) setHttpCredentials(res.data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [params?.projectId, isHttpNode])
```

Import `wfCredentialAPI`, `WfCredential`.

Inside the `http_call` block, **above** Headers, add:

```tsx
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">凭证</label>
              <select
                value={node.config.credential_id ?? ''}
                onChange={e =>
                  updateConfig(
                    'credential_id',
                    e.target.value === '' ? undefined : Number(e.target.value),
                  )
                }
                disabled={readOnly}
                className="w-full px-2 py-2 border rounded-lg text-sm"
              >
                <option value="">不使用凭证</option>
                {httpCredentials.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}（{c.kind === 'basic' ? '用户名/密码' : c.kind === 'bearer' ? 'Bearer' : 'API Key'}）
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-400 mt-1">
                选中后按类型自动加认证头，并覆盖 Headers 里的同名头。也可用 {'{{cred.名称.token}}'} 等模板。
              </p>
            </div>
```

- [ ] **Step 3: MCP docs**

In `src/mcp_tools.rs` template section, after the `{{env.X}}` bullet:

```
- `{{cred.名称.字段}}`：项目凭证（设置 → 凭证管理）。字段：basic=`username`/`password`，bearer=`token`，api_key=`api_key`/`header_name`。未定义渲染为空串。执行输出中 password/token/api_key 脱敏为 `***`
```

In code-node host API bullets (Lua / JS / Python), add `cred.get(name, field)` next to `env.get`.

In `### http_call` config line add `"credential_id": 可选整数` and a bullet:

```
- `credential_id`：引用项目凭证。basic → Authorization Basic；bearer → Authorization Bearer；api_key → `{header_name}`（默认 X-API-Key）。覆盖节点 Headers 同名头
```

- [ ] **Step 4: Verify**

Run:

```
cargo test --lib workflow_credentials test_cred_template_resolution test_mask_env_and_credentials test_cred_get_hit_and_miss -- --nocapture
cd frontend-nextjs && npx tsc --noEmit --pretty false
```

Expected: PASS / no tsc errors.

In the running app (restart backend so 064 applied):

1. 设置 → 凭证管理：新建 basic / bearer / api_key，列表无明文，编辑留空不改密。
2. 数据源页无凭证 Tab；下拉只有 basic；链接能进设置页。
3. HTTP 节点能选凭证。
4. 工作流里 `{{cred.名称.password}}` 能解析；执行记录里密码是 `***`。

- [ ] **Step 5: Commit** (skip unless asked)

```bash
git add frontend-nextjs/app/workspace/[projectId]/events/datasources/page.tsx frontend-nextjs/components/workflow/NodeConfigPanel.tsx src/mcp_tools.rs
git commit -m "feat: wire credential picker and move credential UI to settings."
```

---

## Self-review

**Spec coverage**

| Spec | Task |
|------|------|
| Evolve `wf_credentials` + `header_name` + `api_key` | 1, 4 |
| `/credentials` + `/wf-credentials` alias | 4 |
| Never echo secret; empty update keeps ciphertext | 4, 7 |
| List = member, write = admin | 4 |
| `{{cred.名称.字段}}` last-segment parse, Chinese names | 1, 2 |
| `cred.get` Lua / JS / Python | 5, 6 |
| HTTP `credential_id` header inject + overwrite | 1, 3, 8 |
| Datasource only `basic`; historic non-basic fails exec | 3, 4, 8 |
| Mask password/token/api_key | 2 |
| Decrypt fail skips row; node using it fails | 2, 3 |
| Settings page, remove datasource tab | 7, 8 |
| MCP docs | 8 |
| No env-var / OS / Redis / Kafka / ES changes | honored |

**Placeholder scan:** none.

**Type consistency:** `CredentialFields` / `CredentialStore` / `get_field` / `apply_http_auth_headers` / `load_credential_store` names are the same in every task. Frontend `header_name` matches the API. `WfCredentialKind` includes `api_key`.
