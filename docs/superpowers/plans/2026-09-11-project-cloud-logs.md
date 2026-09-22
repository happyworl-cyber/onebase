# Project Cloud Logs (Aliyun SLS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 项目可配多条阿里云 SLS 日志源，用项目凭证里的 AccessKey 由后端代查，并在站内查看或跳转控制台。

**Architecture:** 纯函数放 `cloud_log`（拼查询、时间窗、控制台 URL）。SLS 签名与 GetLogs 放 `cloud_log_aliyun`。CRUD / 代查 handler 只在 bin。密钥仍在 `wf_credentials`（`aliyun_ak`），日志源新表只存 `credential_id`。浏览器从不拿到 Secret。

**Tech Stack:** Rust (axum, sqlx, reqwest, `crypto_primitives::hmac_sha1`)，Next.js 14，现有 `wfCredentialAPI`。

**Spec:** `docs/superpowers/specs/2026-09-11-project-cloud-logs-design.md`

## Global Constraints

- Do not create git commits unless the user explicitly asks. Keep Commit steps but skip them until asked.
- Do not add Huawei / Tencent providers. `provider` check allows only `aliyun_sls`.
- Do not send AccessKeySecret to the browser. List/query/console-url responses must not contain `secret` or `secret_encrypted`.
- Do not register `aliyun_ak` on `field_value` / `{{cred.}}` / `cred.get`. `load_credential_store` must skip `kind = aliyun_ak`.
- `datasource_accepts_kind` stays `basic` only. `apply_http_auth_headers` must reject `aliyun_ak`.
- Query permission and log-source list: `permissions::require_tenant_admin` (same people as 执行日志 UI `canManageSecurity`). Write sources: same.
- Single query window ≤ 86400 seconds. `line` clamp 1–100, default 50. Default window last 3600 seconds.
- SLS HTTP timeout 10 seconds. 401/403 → `AppError::InvalidQuery`. Other SLS/network errors → `AppError::Internal` / 502-equivalent existing `AppError`.
- `src/main.rs` and `src/lib.rs` both `mod` shared files (`cloud_log`, `cloud_log_aliyun`). Handlers only in `main.rs`.
- Do not change the gateway SLS-aggregation-into-Postgres pipeline.
- No MCP tool for SLS. No live tail.

## File Structure

| Path | Responsibility |
|------|----------------|
| `src/cloud_log.rs` | Query string, time window, trace-id check, console URL, types, `CloudLogProvider` |
| `src/cloud_log_aliyun.rs` | SLS signature + GetLogs over injected HTTP |
| `src/cloud_log_handlers.rs` | Project log-source CRUD, query, test, console-url |
| `migrations/066_project_log_sources.sql` | Table + comments |
| `src/migrate.rs` | Register 066 |
| `src/workflow_credentials.rs` | `aliyun_ak` validate; skip in workflow store |
| `src/datasource_handlers.rs` | `ref_count` + delete include log sources |
| `src/operation_log.rs` | `resource_type::LOG_SOURCE` |
| `src/lib.rs` / `src/main.rs` | `mod` + routes |
| `frontend-nextjs/lib/api.ts` | Types + `projectLogSourceAPI`；`WfCredentialKind` 加 `aliyun_ak` |
| `frontend-nextjs/app/workspace/[projectId]/settings/credentials/page.tsx` | 阿里云 AccessKey 表单 |
| `frontend-nextjs/app/workspace/[projectId]/settings/log-sources/page.tsx` | 日志源 CRUD + 测试 |
| `frontend-nextjs/app/workspace/[projectId]/cloud-logs/page.tsx` | 查询页 |
| `frontend-nextjs/components/workspace/workspaceNav.ts` | 两个入口 |
| `frontend-nextjs/components/ExecutionLogsView.tsx` | 「云日志」跳转 |

---

### Task 1: Query composition, time window, console URL

**Files:**
- Create: `src/cloud_log.rs`
- Modify: `src/lib.rs` — add `pub mod cloud_log;` next to `pub mod workflow_logs;`
- Modify: `src/main.rs` — add `mod cloud_log;` next to `mod workflow_logs;`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `pub const MAX_WINDOW_SECS: i64 = 86400`
  - `pub const DEFAULT_WINDOW_SECS: i64 = 3600`
  - `pub const DEFAULT_LINE: u32 = 50`
  - `pub const MAX_LINE: u32 = 100`
  - `pub fn looks_like_trace_id(s: &str) -> bool`
  - `pub fn compose_sls_query(prefix: Option<&str>, user_query: Option<&str>, request_id: Option<&str>) -> Result<String, String>`
  - `pub fn resolve_query_window(from: Option<i64>, to: Option<i64>, now: i64) -> Result<(i64, i64), String>`
  - `pub fn clamp_line(line: Option<u32>) -> u32`
  - `pub fn sls_console_url(region: &str, sls_project: &str, logstore: &str, from: i64, to: i64, query: &str) -> String`
  - `pub fn default_sls_endpoint(sls_project: &str, region: &str) -> String`
  - `pub struct CloudLogQuery { pub from: i64, pub to: i64, pub query: String, pub line: u32, pub offset: u32, pub reverse: bool }`
  - `pub struct CloudLogLine { pub time: i64, pub contents: serde_json::Map<String, serde_json::Value> }`
  - `pub struct CloudLogPage { pub logs: Vec<CloudLogLine>, pub count: usize, pub console_url: String }`

- [ ] **Step 1: Write the failing tests**

Create `src/cloud_log.rs` with types + `todo!()` bodies (or empty functions that fail asserts) and this test module:

```rust
//! 云日志：查询拼装、时间窗、控制台深链。与具体云厂商 HTTP 无关。

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compose_joins_prefix_query_and_request_id() {
        let q = compose_sls_query(
            Some(" app:pay "),
            Some("error"),
            Some("98753d7e-3bdb-4c00-bcf7-4a697606b88b"),
        )
        .unwrap();
        assert_eq!(
            q,
            r#"app:pay and error and x_request_id: "98753d7e-3bdb-4c00-bcf7-4a697606b88b""#
        );
    }

    #[test]
    fn compose_empty_is_star() {
        assert_eq!(compose_sls_query(None, Some("  "), None).unwrap(), "*");
    }

    #[test]
    fn compose_rejects_bad_request_id() {
        assert!(compose_sls_query(None, None, Some("bad id")).is_err());
        assert!(compose_sls_query(None, None, Some("short")).is_err());
    }

    #[test]
    fn window_defaults_and_rejects_oversize() {
        let now = 2_000_000_i64;
        assert_eq!(
            resolve_query_window(None, None, now).unwrap(),
            (now - 3600, now)
        );
        assert!(resolve_query_window(Some(1), Some(1 + 86401), now).is_err());
        assert!(resolve_query_window(Some(10), Some(10), now).is_err());
    }

    #[test]
    fn line_clamp() {
        assert_eq!(clamp_line(None), 50);
        assert_eq!(clamp_line(Some(0)), 1);
        assert_eq!(clamp_line(Some(200)), 100);
    }

    #[test]
    fn console_url_contains_encoded_query() {
        let url = sls_console_url(
            "cn-hangzhou",
            "my-proj",
            "app-log",
            100,
            200,
            r#"x_request_id: "abc-def_1""#,
        );
        assert!(url.starts_with(
            "https://sls.console.aliyun.com/lognext/project/my-proj/logsearch/app-log?"
        ));
        assert!(url.contains("slsRegion=cn-hangzhou"));
        assert!(url.contains("queryTimeType=99"));
        assert!(url.contains("startTime=100"));
        assert!(url.contains("endTime=200"));
        assert!(url.contains("queryString="));
        assert!(!url.contains("x_request_id: "));
    }

    #[test]
    fn default_endpoint() {
        assert_eq!(
            default_sls_endpoint("my-proj", "cn-hangzhou"),
            "https://my-proj.cn-hangzhou.log.aliyuncs.com"
        );
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p planeos --lib cloud_log:: -- --nocapture`

Expected: compile error or FAIL (functions missing / `todo!()`).

- [ ] **Step 3: Implement**

```rust
use serde::{Deserialize, Serialize};
use serde_json::Map;

pub const MAX_WINDOW_SECS: i64 = 86400;
pub const DEFAULT_WINDOW_SECS: i64 = 3600;
pub const DEFAULT_LINE: u32 = 50;
pub const MAX_LINE: u32 = 100;

#[derive(Debug, Clone)]
pub struct CloudLogQuery {
    pub from: i64,
    pub to: i64,
    pub query: String,
    pub line: u32,
    pub offset: u32,
    pub reverse: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudLogLine {
    pub time: i64,
    pub contents: Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudLogPage {
    pub logs: Vec<CloudLogLine>,
    pub count: usize,
    pub console_url: String,
}

pub fn looks_like_trace_id(s: &str) -> bool {
    let len = s.len();
    if !(8..=128).contains(&len) {
        return false;
    }
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn compose_sls_query(
    prefix: Option<&str>,
    user_query: Option<&str>,
    request_id: Option<&str>,
) -> Result<String, String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(p) = prefix.map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(p.to_string());
    }
    if let Some(q) = user_query.map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(q.to_string());
    }
    if let Some(id) = request_id.map(str::trim).filter(|s| !s.is_empty()) {
        if !looks_like_trace_id(id) {
            return Err("非法 x_request_id".into());
        }
        parts.push(format!(r#"x_request_id: "{id}""#));
    }
    if parts.is_empty() {
        Ok("*".into())
    } else {
        Ok(parts.join(" and "))
    }
}

pub fn resolve_query_window(
    from: Option<i64>,
    to: Option<i64>,
    now: i64,
) -> Result<(i64, i64), String> {
    let to = to.unwrap_or(now);
    let from = from.unwrap_or(to - DEFAULT_WINDOW_SECS);
    if from >= to {
        return Err("from 必须小于 to".into());
    }
    if to - from > MAX_WINDOW_SECS {
        return Err("时间窗不能超过 24 小时".into());
    }
    Ok((from, to))
}

pub fn clamp_line(line: Option<u32>) -> u32 {
    line.unwrap_or(DEFAULT_LINE).clamp(1, MAX_LINE)
}

pub fn sls_console_url(
    region: &str,
    sls_project: &str,
    logstore: &str,
    from: i64,
    to: i64,
    query: &str,
) -> String {
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    let enc = |s: &str| utf8_percent_encode(s, NON_ALPHANUMERIC).to_string();
    let path_proj = enc(sls_project);
    let path_store = enc(logstore);
    let qs = enc(query);
    let region = enc(region);
    format!(
        "https://sls.console.aliyun.com/lognext/project/{path_proj}/logsearch/{path_store}?slsRegion={region}&queryTimeType=99&startTime={from}&endTime={to}&queryString={qs}"
    )
}

pub fn default_sls_endpoint(sls_project: &str, region: &str) -> String {
    format!("https://{sls_project}.{region}.log.aliyuncs.com")
}
```

Use `percent-encoding` (already in `Cargo.toml`). Do not add `urlencoding`.

Add `pub mod cloud_log;` in `src/lib.rs` and `mod cloud_log;` in `src/main.rs`.

- [ ] **Step 4: Run tests**

Run: `cargo test -p planeos --lib cloud_log:: -- --nocapture`

Expected: PASS

- [ ] **Step 5: Commit** (skip until asked)

```bash
git add src/cloud_log.rs src/lib.rs src/main.rs
git commit -m "feat: 云日志查询串、时间窗和控制台 URL。"
```

---

### Task 2: Credential kind `aliyun_ak`

**Files:**
- Modify: `src/workflow_credentials.rs`

**Interfaces:**
- Consumes: existing `validate_kind` / `validate_kind_fields` / `apply_http_auth_headers` / `load_credential_store`
- Produces:
  - `validate_kind` accepts `aliyun_ak`
  - `validate_kind_fields("aliyun_ak", username)` requires non-empty username (AccessKeyId)
  - `pub fn workflow_loads_kind(kind: &str) -> bool` — `false` for `aliyun_ak`
  - `load_credential_store` skips rows where `!workflow_loads_kind(kind)`
  - `apply_http_auth_headers` returns `Err` for `aliyun_ak`
  - `field_value` stays `None` for `aliyun_ak` (do not add match arms)

- [ ] **Step 1: Write the failing tests**

Append to `src/workflow_credentials.rs` tests:

```rust
    fn aliyun_ak() -> CredentialFields {
        CredentialFields {
            id: 9,
            name: "阿里云生产".into(),
            kind: "aliyun_ak".into(),
            username: Some("LTAI5tExample".into()),
            header_name: None,
            secret: Some("super-secret-sk".into()),
        }
    }

    #[test]
    fn aliyun_ak_kind_rules() {
        assert_eq!(validate_kind(" aliyun_ak ").unwrap(), "aliyun_ak");
        assert!(validate_kind_fields("aliyun_ak", Some("")).is_err());
        assert!(validate_kind_fields("aliyun_ak", Some("LTAI5t")).is_ok());
        assert!(!workflow_loads_kind("aliyun_ak"));
        assert!(workflow_loads_kind("basic"));
        assert!(!datasource_accepts_kind("aliyun_ak"));
        assert!(field_value(&aliyun_ak(), "access_key_secret").is_none());
        assert!(field_value(&aliyun_ak(), "username").is_none());
        let mut headers = Map::new();
        assert!(apply_http_auth_headers(&mut headers, &aliyun_ak()).is_err());
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p planeos --lib workflow_credentials::tests::aliyun_ak_kind_rules -- --nocapture`

Expected: FAIL (`workflow_loads_kind` missing and/or `validate_kind` rejects `aliyun_ak`)

- [ ] **Step 3: Implement**

In `validate_kind`, add `aliyun_ak` to the `matches!` list; update the error string to `basic / bearer / api_key / aliyun_ak`.

In `validate_kind_fields`:

```rust
    if kind == "basic" || kind == "aliyun_ak" {
        let ok = username
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_some();
        if !ok {
            return Err(if kind == "aliyun_ak" {
                "aliyun_ak 凭证必须填写 AccessKeyId".into()
            } else {
                "basic 凭证必须填写用户名".into()
            });
        }
    }
```

Add:

```rust
pub fn workflow_loads_kind(kind: &str) -> bool {
    kind != "aliyun_ak"
}
```

In `load_credential_store`, after reading `kind`, `if !workflow_loads_kind(&kind) { continue; }` (bind `kind` to a local `String` before `insert`).

In `apply_http_auth_headers` `match`, keep the existing `other` arm — it already errors for `aliyun_ak`. No new arm.

Do **not** add `field_value` arms for `aliyun_ak`.

- [ ] **Step 4: Run tests**

Run: `cargo test -p planeos --lib workflow_credentials:: -- --nocapture`

Expected: PASS (old tests + new)

- [ ] **Step 5: Commit** (skip until asked)

```bash
git add src/workflow_credentials.rs
git commit -m "feat: 项目凭证支持 aliyun_ak，且不装进工作流。"
```

---

### Task 3: Migration `project_log_sources`

**Files:**
- Create: `migrations/066_project_log_sources.sql`
- Modify: `src/migrate.rs` — append after the 064 tuple (around line 329)

**Interfaces:**
- Consumes: `management.wf_credentials(id)`
- Produces: table `management.project_log_sources` as specified

- [ ] **Step 1: Write the SQL**

```sql
-- 项目云日志源：多条 SLS Logstore，共用一份 aliyun_ak 凭证。
CREATE TABLE IF NOT EXISTS management.project_log_sources (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    provider VARCHAR(32) NOT NULL,
    credential_id INTEGER NOT NULL REFERENCES management.wf_credentials(id) ON DELETE RESTRICT,
    region VARCHAR(64) NOT NULL,
    sls_project VARCHAR(128) NOT NULL,
    logstore VARCHAR(128) NOT NULL,
    endpoint VARCHAR(256),
    query_prefix TEXT,
    created_by INTEGER REFERENCES management.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT project_log_sources_name_unique UNIQUE (tenant_id, name),
    CONSTRAINT project_log_sources_provider_chk CHECK (provider = 'aliyun_sls')
);

CREATE INDEX IF NOT EXISTS idx_project_log_sources_tenant
    ON management.project_log_sources (tenant_id);

CREATE INDEX IF NOT EXISTS idx_project_log_sources_credential
    ON management.project_log_sources (credential_id);

COMMENT ON TABLE management.project_log_sources IS
    '项目云日志源。密钥在 wf_credentials（aliyun_ak），本表只引用。';
```

If `tenants` / `users` FK names differ, copy the exact references from `migrations/031_project_env_vars.sql` or `046_workflow_datasources.sql`.

- [ ] **Step 2: Register in `migrate.rs`**

After the 064 entry:

```rust
    (
        "066 project log sources",
        include_str!("../migrations/066_project_log_sources.sql"),
    ),
```

- [ ] **Step 3: Compile**

Run: `cargo test -p planeos --lib migrate:: -- --nocapture`

Expected: compile succeeds. If there is no `migrate` test, `cargo check -p planeos --lib` is enough.

- [ ] **Step 4: Commit** (skip until asked)

```bash
git add migrations/066_project_log_sources.sql src/migrate.rs
git commit -m "feat: 项目云日志源表。"
```

---

### Task 4: Credential `ref_count` and delete include log sources

**Files:**
- Modify: `src/datasource_handlers.rs` — `list_credentials` ref query (lines 161–176) and `delete_credential` (lines 316–328)

**Interfaces:**
- Consumes: `management.project_log_sources`
- Produces: `ref_count` = datasource refs + log-source refs; delete 400 if either > 0

- [ ] **Step 1: Write a failing unit test for the message helper**

Add next to the existing delete logic a small pure function (so we do not need a DB for the first test):

```rust
fn credential_in_use_message(ds_refs: i64, log_refs: i64) -> Option<String> {
    if ds_refs <= 0 && log_refs <= 0 {
        return None;
    }
    let mut bits = Vec::new();
    if ds_refs > 0 {
        bits.push(format!("{ds_refs} 个数据源"));
    }
    if log_refs > 0 {
        bits.push(format!("{log_refs} 个云日志源"));
    }
    Some(format!(
        "该凭证仍被 {} 引用，请先解绑后再删除",
        bits.join("、")
    ))
}
```

Put it in `datasource_handlers.rs` and add under `#[cfg(test)]`:

```rust
    #[test]
    fn credential_in_use_mentions_log_sources() {
        assert_eq!(
            credential_in_use_message(0, 2).as_deref(),
            Some("该凭证仍被 2 个云日志源引用，请先解绑后再删除")
        );
        assert_eq!(
            credential_in_use_message(1, 1).as_deref(),
            Some("该凭证仍被 1 个数据源、1 个云日志源引用，请先解绑后再删除")
        );
        assert!(credential_in_use_message(0, 0).is_none());
    }
```

If `datasource_handlers` has no `#[cfg(test)]` yet, add `#[cfg(test)] mod tests { use super::*; ... }` at the file end. This module is **bin-only** — run with `cargo test --bin planeos credential_in_use`.

- [ ] **Step 2: Run test**

Run: `cargo test --bin planeos credential_in_use -- --nocapture`

Expected: FAIL until the helper exists, then PASS after Step 3 if you implement helper first. Prefer helper + test together, then wire delete.

- [ ] **Step 3: Wire list + delete**

Replace the single `wf_datasources` count in `list_credentials` with:

```sql
SELECT credential_id, COUNT(*)::bigint AS cnt FROM (
    SELECT credential_id FROM management.wf_datasources
     WHERE tenant_id = $1 AND credential_id IS NOT NULL
    UNION ALL
    SELECT credential_id FROM management.project_log_sources
     WHERE tenant_id = $1
) t
GROUP BY credential_id
```

In `delete_credential`, query both counts (two scalars or one query with two columns) and:

```rust
    if let Some(msg) = credential_in_use_message(ds_refs, log_refs) {
        return Err(AppError::InvalidQuery(msg));
    }
```

- [ ] **Step 4: Run tests**

Run: `cargo test --bin planeos credential_in_use -- --nocapture`

Expected: PASS

- [ ] **Step 5: Commit** (skip until asked)

```bash
git add src/datasource_handlers.rs
git commit -m "feat: 删除凭证时计入云日志源引用。"
```

---

### Task 5: Aliyun GetLogs client (mockable HTTP)

**Files:**
- Create: `src/cloud_log_aliyun.rs`
- Modify: `src/lib.rs` — `pub mod cloud_log_aliyun;`
- Modify: `src/main.rs` — `mod cloud_log_aliyun;`

**Interfaces:**
- Consumes: `CloudLogQuery`, `CloudLogLine`, `crate::crypto_primitives::hmac_sha1`
- Produces:
  - `pub fn sls_string_to_sign(method: &str, content_md5: &str, content_type: &str, date: &str, canonical_headers: &str, canonical_resource: &str) -> String`
  - `pub fn sls_authorization(access_key_id: &str, access_key_secret: &str, string_to_sign: &str) -> Result<String, String>`
  - `pub fn sls_canonical_resource(logstore: &str, q: &CloudLogQuery) -> String`
  - `pub fn parse_getlogs_json(body: &str) -> Result<Vec<CloudLogLine>, String>`
  - `#[async_trait] pub trait SlsHttp { async fn get(&self, url: &str, headers: Vec<(String, String)>) -> Result<(u16, String), String>; }`
  - `pub async fn get_logs<H: SlsHttp + Sync>(http: &H, endpoint: &str, access_key_id: &str, access_key_secret: &str, sls_project: &str, logstore: &str, date_rfc1123: &str, q: &CloudLogQuery) -> Result<Vec<CloudLogLine>, String>`

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud_log::CloudLogQuery;

    fn sample_q() -> CloudLogQuery {
        CloudLogQuery {
            from: 100,
            to: 200,
            query: "error".into(),
            line: 50,
            offset: 0,
            reverse: true,
        }
    }

    #[test]
    fn canonical_resource_sorts_params() {
        let r = sls_canonical_resource("app-log", &sample_q());
        assert_eq!(
            r,
            "/logstores/app-log?from=100&line=50&offset=0&query=error&reverse=true&to=200&type=log"
        );
    }

    #[test]
    fn authorization_is_log_scheme() {
        let sts = sls_string_to_sign(
            "GET",
            "",
            "",
            "Mon, 3 Jan 2010 08:33:47 GMT",
            "x-log-apiversion:0.6.0\nx-log-bodyrawsize:0\nx-log-signaturemethod:hmac-sha1\n",
            "/logstores/app-log?type=log",
        );
        let auth = sls_authorization("testid", "testsecret", &sts).unwrap();
        assert!(auth.starts_with("LOG testid:"));
        assert_eq!(auth, sls_authorization("testid", "testsecret", &sts).unwrap());
    }

    #[test]
    fn parse_getlogs_json_reads_time_and_fields() {
        let logs = parse_getlogs_json(
            r#"[{"__time__":1726032000,"message":"hello","x_request_id":"abc12345"}]"#,
        )
        .unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].time, 1726032000);
        assert_eq!(logs[0].contents["message"], "hello");
        assert_eq!(logs[0].contents["x_request_id"], "abc12345");
        assert!(!logs[0].contents.contains_key("__time__"));
    }

    struct MockHttp {
        status: u16,
        body: String,
    }

    #[async_trait::async_trait]
    impl SlsHttp for MockHttp {
        async fn get(&self, _url: &str, _headers: Vec<(String, String)>) -> Result<(u16, String), String> {
            Ok((self.status, self.body.clone()))
        }
    }

    #[tokio::test]
    async fn get_logs_maps_403() {
        let http = MockHttp {
            status: 403,
            body: r#"{"errorMessage":"denied"}"#.into(),
        };
        let err = get_logs(
            &http,
            "https://p.cn-hangzhou.log.aliyuncs.com",
            "id",
            "sec",
            "p",
            "app-log",
            "Mon, 3 Jan 2010 08:33:47 GMT",
            &sample_q(),
        )
        .await
        .unwrap_err();
        assert!(err.contains("凭证") || err.contains("权限") || err.contains("403"));
    }

    #[tokio::test]
    async fn get_logs_parses_200() {
        let http = MockHttp {
            status: 200,
            body: r#"[{"__time__":1,"message":"ok"}]"#.into(),
        };
        let logs = get_logs(
            &http,
            "https://p.cn-hangzhou.log.aliyuncs.com",
            "id",
            "sec",
            "p",
            "app-log",
            "Mon, 3 Jan 2010 08:33:47 GMT",
            &sample_q(),
        )
        .await
        .unwrap();
        assert_eq!(logs[0].contents["message"], "ok");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p planeos --lib cloud_log_aliyun:: -- --nocapture`

Expected: compile error / FAIL

- [ ] **Step 3: Implement**

SLS 0.6.0 GetLogs (JSON via `Accept: application/json`):

1. `canonical_headers` must be lowercase names, sorted, each `name:value\n`. Always include:
   - `x-log-apiversion:0.6.0`
   - `x-log-bodyrawsize:0`
   - `x-log-signaturemethod:hmac-sha1`
2. `string_to_sign = METHOD + "\n" + Content-MD5 + "\n" + Content-Type + "\n" + Date + "\n" + canonical_headers + canonical_resource`
3. `Authorization = "LOG " + ak_id + ":" + base64(hmac_sha1(secret, string_to_sign))` using `crate::crypto_primitives::hmac_sha1` and `base64` STANDARD.
4. URL = `{endpoint}/logstores/{urlencode(logstore)}?from=&to=&line=&offset=&reverse=true&query={urlencode}&type=log` (`endpoint` has no trailing slash).
5. Headers to send: `Date`, `Authorization`, `Accept: application/json`, `Host` from endpoint, plus the `x-log-*` headers.
6. Status 401/403 → `Err("凭证无效或没有该 Logstore 的读权限".into())`.
7. Other non-200 → `Err(format!("SLS 返回 {status}: {truncate body}"))` (truncate body to 300 chars; never include `access_key_secret`).
8. `parse_getlogs_json`: body is a JSON array. Each object: `time` from `__time__` (number or numeric string, default 0); `contents` = all other keys.

`ReqwestSlsHttp` (used by handlers in Task 6):

```rust
pub struct ReqwestSlsHttp {
    pub client: reqwest::Client,
}

#[async_trait::async_trait]
impl SlsHttp for ReqwestSlsHttp {
    async fn get(&self, url: &str, headers: Vec<(String, String)>) -> Result<(u16, String), String> {
        let mut req = self.client.get(url).timeout(std::time::Duration::from_secs(10));
        for (k, v) in headers {
            req = req.header(&k, v);
        }
        let res = req.send().await.map_err(|e| e.to_string())?;
        let status = res.status().as_u16();
        let body = res.text().await.map_err(|e| e.to_string())?;
        Ok((status, body))
    }
}
```

`query` in `urlencode` must match the canonical resource **raw** value (SLS signs the unescaped query in the canonical string as `query={query}` where query is the raw SLS string; if the official rule requires percent-encoding inside the canonical resource, encode consistently in both the URL and the canonical string — pick one and lock it in the `canonical_resource_sorts_params` test).

- [ ] **Step 4: Run tests**

Run: `cargo test -p planeos --lib cloud_log_aliyun:: -- --nocapture`

Expected: PASS

- [ ] **Step 5: Commit** (skip until asked)

```bash
git add src/cloud_log_aliyun.rs src/lib.rs src/main.rs
git commit -m "feat: 阿里云 SLS GetLogs 签名与 mock 可测客户端。"
```

---

### Task 6: HTTP handlers and routes

**Files:**
- Create: `src/cloud_log_handlers.rs`
- Modify: `src/main.rs` — `mod cloud_log_handlers;` and routes next to credentials (after line 741)
- Modify: `src/operation_log.rs` — add `pub const LOG_SOURCE: &str = "云日志源";` in `resource_type`

**Interfaces:**
- Consumes: Task 1–5, `permissions::require_tenant_admin`, `crypto::decrypt_secret`
- Produces routes under `/api/projects/:id/log-sources`

| Method | Path | Handler |
|--------|------|---------|
| GET | `/api/projects/:id/log-sources` | `list_log_sources` |
| POST | `/api/projects/:id/log-sources` | `create_log_source` |
| PUT | `/api/projects/:id/log-sources/:sid` | `update_log_source` |
| DELETE | `/api/projects/:id/log-sources/:sid` | `delete_log_source` |
| POST | `/api/projects/:id/log-sources/:sid/query` | `query_log_source` |
| GET | `/api/projects/:id/log-sources/:sid/console-url` | `console_url` |
| POST | `/api/projects/:id/log-sources/:sid/test` | `test_log_source` |

- [ ] **Step 1: Write handler-level unit tests that do not hit SLS**

In `cloud_log_handlers.rs` `#[cfg(test)]`, test request DTO defaults via the same compose/window helpers (already covered). Add:

```rust
    #[test]
    fn log_source_row_json_has_no_secret_keys() {
        let v = serde_json::json!({
            "id": 1,
            "name": "Access",
            "provider": "aliyun_sls",
            "credential_id": 3,
            "credential_name": "阿里云生产",
            "region": "cn-hangzhou",
            "sls_project": "p",
            "logstore": "app-log",
            "endpoint": null,
            "query_prefix": null,
        });
        let s = v.to_string();
        assert!(!s.contains("secret"));
        assert!(!s.contains("AccessKeySecret"));
    }
```

This is a contract reminder; the real JSON builder must only use these keys (plus timestamps).

- [ ] **Step 2: Implement handlers**

Shared rules:

- Every handler: `permissions::require_tenant_admin(&pool, &claims, project_id).await?`
- Load source: `SELECT ... FROM management.project_log_sources s JOIN management.wf_credentials c ON c.id = s.credential_id AND c.tenant_id = s.tenant_id WHERE s.id = $1 AND s.tenant_id = $2`
- Create/update: `name` trim 1–100; `provider` must be `aliyun_sls`; `region` / `sls_project` / `logstore` trim non-empty; `endpoint` / `query_prefix` trim empty → NULL
- `credential_id` must exist in this project with `kind = 'aliyun_ak'`, else 400「请选择阿里云 AccessKey 凭证」
- Unique `(tenant_id, name)` violation → 400
- Decrypt only inside query/test: `crypto::decrypt_secret(&secret_encrypted)`. Failure → 400「凭证解密失败」
- AccessKeyId = `wf_credentials.username`
- Effective endpoint = `endpoint` or `default_sls_endpoint(sls_project, region)`
- `query` body:

```rust
#[derive(Deserialize)]
pub struct LogQueryBody {
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub query: Option<String>,
    pub x_request_id: Option<String>,
    pub line: Option<u32>,
    pub offset: Option<i64>,
}
```

Build `CloudLogQuery` with `compose_sls_query(prefix, query, x_request_id)`, `resolve_query_window(..., chrono::Utc::now().timestamp())`, `clamp_line`, `offset.max(0) as u32`, `reverse: true`.

Call `get_logs(&ReqwestSlsHttp { client: reqwest::Client::new() }, ..., &chrono::Utc::now().to_rfc2822(), &q)`.

Map compose/window `Err(msg)` → `AppError::InvalidQuery(msg)`.
Map get_logs 权限文案 → `AppError::InvalidQuery`.
Map other get_logs Err → `AppError::Internal(msg)`.

Response:

```json
{ "logs": [...], "count": N, "console_url": "..." }
```

`console_url` GET: same querystring fields, no SLS HTTP, only `sls_console_url(...)`.

`test`: last 60 seconds, `line=1`, user query empty (still AND `query_prefix`), then return `{ "ok": true, "count": n }` or 400/502.

Write ops: `operation_log::record` with `resource_type::LOG_SOURCE`, action create/update/delete, **no secret fields**.

List JSON keys: `id, name, provider, credential_id, credential_name, region, sls_project, logstore, endpoint, query_prefix, created_at, updated_at`.

- [ ] **Step 3: Register routes in `main.rs`**

```rust
        .route(
            "/api/projects/:id/log-sources",
            get(cloud_log_handlers::list_log_sources)
                .post(cloud_log_handlers::create_log_source),
        )
        .route(
            "/api/projects/:id/log-sources/:sid",
            axum::routing::put(cloud_log_handlers::update_log_source)
                .delete(cloud_log_handlers::delete_log_source),
        )
        .route(
            "/api/projects/:id/log-sources/:sid/query",
            post(cloud_log_handlers::query_log_source),
        )
        .route(
            "/api/projects/:id/log-sources/:sid/console-url",
            get(cloud_log_handlers::get_log_source_console_url),
        )
        .route(
            "/api/projects/:id/log-sources/:sid/test",
            post(cloud_log_handlers::test_log_source),
        )
```

- [ ] **Step 4: Compile**

Run: `cargo test --bin planeos log_source_row_json -- --nocapture`

Expected: PASS. Also `cargo check --bin planeos`.

- [ ] **Step 5: Commit** (skip until asked)

```bash
git add src/cloud_log_handlers.rs src/main.rs src/operation_log.rs
git commit -m "feat: 项目云日志源 CRUD 与 SLS 代查接口。"
```

---

### Task 7: Frontend API types and credential form

**Files:**
- Modify: `frontend-nextjs/lib/api.ts` — `WfCredentialKind` and new `projectLogSourceAPI`
- Modify: `frontend-nextjs/app/workspace/[projectId]/settings/credentials/page.tsx`

**Interfaces:**
- Consumes: Task 6 JSON shapes
- Produces: `projectLogSourceAPI` used by Tasks 8–10

- [ ] **Step 1: Extend types in `api.ts`**

Change:

```ts
export type WfCredentialKind = 'basic' | 'bearer' | 'api_key' | 'aliyun_ak'
```

After `wfCredentialAPI`, add:

```ts
export type CloudLogProvider = 'aliyun_sls'

export interface ProjectLogSource {
  id: number
  name: string
  provider: CloudLogProvider
  credential_id: number
  credential_name: string
  region: string
  sls_project: string
  logstore: string
  endpoint: string | null
  query_prefix: string | null
  created_at: string
  updated_at: string
}

export interface ProjectLogSourceWriteBody {
  name: string
  provider?: CloudLogProvider
  credential_id: number
  region: string
  sls_project: string
  logstore: string
  endpoint?: string | null
  query_prefix?: string | null
}

export interface CloudLogQueryBody {
  from?: number
  to?: number
  query?: string
  x_request_id?: string
  line?: number
  offset?: number
}

export interface CloudLogLine {
  time: number
  contents: Record<string, unknown>
}

export interface CloudLogPage {
  logs: CloudLogLine[]
  count: number
  console_url: string
}

export const projectLogSourceAPI = {
  list: (projectId: number) =>
    api.get<ProjectLogSource[]>(`/api/projects/${projectId}/log-sources`),
  create: (projectId: number, body: ProjectLogSourceWriteBody) =>
    api.post<ProjectLogSource>(`/api/projects/${projectId}/log-sources`, body),
  update: (projectId: number, sid: number, body: ProjectLogSourceWriteBody) =>
    api.put<ProjectLogSource>(`/api/projects/${projectId}/log-sources/${sid}`, body),
  remove: (projectId: number, sid: number) =>
    api.delete(`/api/projects/${projectId}/log-sources/${sid}`),
  query: (projectId: number, sid: number, body: CloudLogQueryBody) =>
    api.post<CloudLogPage>(`/api/projects/${projectId}/log-sources/${sid}/query`, body),
  consoleUrl: (projectId: number, sid: number, params: CloudLogQueryBody) =>
    api.get<{ console_url: string }>(
      `/api/projects/${projectId}/log-sources/${sid}/console-url`,
      { params },
    ),
  test: (projectId: number, sid: number) =>
    api.post<{ ok: boolean; count: number }>(
      `/api/projects/${projectId}/log-sources/${sid}/test`,
    ),
}
```

- [ ] **Step 2: Credentials page**

In `kindLabel`:

```ts
  if (kind === 'aliyun_ak') return '阿里云 AccessKey'
```

In `handleSave`:

- `aliyun_ak` requires `username` (AccessKeyId), same as basic.
- `username: form.kind === 'basic' || form.kind === 'aliyun_ak' ? form.username.trim() : null`
- New secret warning: `新建凭证必须填写密码 / 令牌 / AccessKeySecret`

Form `<select>` add `<option value="aliyun_ak">阿里云 AccessKey</option>`.

When `form.kind === 'aliyun_ak'`, show AccessKeyId input (reuse username field, label「AccessKeyId」) and secret label「AccessKeySecret」. Hide `header_name`.

List card: if `c.kind === 'aliyun_ak'`, show AccessKeyId like basic username.

`canManageMembers` visibility stays as today (members can open 凭证管理). Creating `aliyun_ak` still hits admin write API.

- [ ] **Step 3: Typecheck**

Run: `cd frontend-nextjs && npx tsc --noEmit`

Expected: no new errors on these files.

- [ ] **Step 4: Commit** (skip until asked)

```bash
git add frontend-nextjs/lib/api.ts frontend-nextjs/app/workspace/\[projectId\]/settings/credentials/page.tsx
git commit -m "feat: 凭证页支持阿里云 AccessKey。"
```

---

### Task 8: Settings → 云日志源 page + nav

**Files:**
- Create: `frontend-nextjs/app/workspace/[projectId]/settings/log-sources/page.tsx`
- Modify: `frontend-nextjs/components/workspace/workspaceNav.ts` — after 凭证管理 (line 188)

**Interfaces:**
- Consumes: `projectLogSourceAPI`, `wfCredentialAPI`
- Produces: `/workspace/:id/settings/log-sources`

- [ ] **Step 1: Add nav item**

```ts
      {
        label: '云日志源',
        href: '/settings/log-sources',
        icon: 'fas fa-cloud',
        visibleIf: (caps) => caps.canManageSecurity,
      },
```

Insert immediately after the 凭证管理 item.

- [ ] **Step 2: Implement the page**

Follow `settings/credentials/page.tsx` layout (list + slide-over / inline form). Gate with `caps.canManageSecurity`; else `ForbiddenPlaceholder`.

Fields: name, credential dropdown (`wfCredentialAPI.list` filtered `kind === 'aliyun_ak'`), region, sls_project, logstore, endpoint (optional), query_prefix (optional). Hidden `provider: 'aliyun_sls'`.

Actions: 保存 / 删除 / 测试连接 (`projectLogSourceAPI.test`). Empty credentials → text + link to `/workspace/${projectId}/settings/credentials`.

Do not display any secret.

- [ ] **Step 3: Typecheck**

Run: `cd frontend-nextjs && npx tsc --noEmit`

Expected: pass

- [ ] **Step 4: Commit** (skip until asked)

```bash
git add frontend-nextjs/app/workspace/\[projectId\]/settings/log-sources/page.tsx frontend-nextjs/components/workspace/workspaceNav.ts
git commit -m "feat: 项目设置可维护云日志源。"
```

---

### Task 9: 云日志 query page + nav

**Files:**
- Create: `frontend-nextjs/app/workspace/[projectId]/cloud-logs/page.tsx`
- Modify: `frontend-nextjs/components/workspace/workspaceNav.ts` — after 执行日志 (line 149)

**Interfaces:**
- Consumes: `projectLogSourceAPI.query` / `.consoleUrl`
- Produces: `/workspace/:id/cloud-logs?source_id=&trace_id=&from=&to=`

- [ ] **Step 1: Add nav item**

```ts
      {
        label: '云日志',
        href: '/cloud-logs',
        icon: 'fas fa-cloud-download-alt',
        visibleIf: (caps) => caps.canManageSecurity,
      },
```

Insert immediately after 执行日志.

- [ ] **Step 2: Implement the page**

`'use client'`. `useSearchParams` to read `source_id`, `trace_id`, `from`, `to`.

- `canManageSecurity` or `ForbiddenPlaceholder`.
- Load sources. Zero sources → empty state link to `/workspace/${projectId}/settings/log-sources`.
- Controls: source `<select>`, datetime-local or unix-friendly range (default last 1h), keyword input, `x_request_id` input (prefill `trace_id`).
- Submit → `projectLogSourceAPI.query`. Table columns: time (format local), `level` / `message` / `x_request_id` from `contents`, plus a details `<pre>` for remaining keys.
- Button「在阿里云打开」→ `window.open(page.console_url, '_blank', 'noopener')`. If `console_url` missing, call `consoleUrl` with the same params.
- Do not render secrets. If a cell looks like `secret` / `*encrypted*` still show as returned (SLS payload); do not add client-side masking beyond what the API returns.

- [ ] **Step 3: Typecheck**

Run: `cd frontend-nextjs && npx tsc --noEmit`

Expected: pass

- [ ] **Step 4: Commit** (skip until asked)

```bash
git add frontend-nextjs/app/workspace/\[projectId\]/cloud-logs/page.tsx frontend-nextjs/components/workspace/workspaceNav.ts
git commit -m "feat: 项目云日志查询页。"
```

---

### Task 10: Execution log jump to 云日志

**Files:**
- Modify: `frontend-nextjs/components/ExecutionLogsView.tsx` — detail header next to「复制 trace」(around lines 490–497)

**Interfaces:**
- Consumes: `tenantId` prop already passed by the project logs page; `projectLogSourceAPI.list`
- Produces: navigation to `/workspace/{tenantId}/cloud-logs?source_id=&trace_id=`

- [ ] **Step 1: Add the button**

Only when `tenantId` is a finite number (hide on platform-wide logs with no project).

On click:

1. `const sources = (await projectLogSourceAPI.list(tenantId)).data`
2. `0` → `notify.warning('请先在设置 → 云日志源中配置')` and return
3. `1` → `router.push(`/workspace/${tenantId}/cloud-logs?source_id=${sources[0].id}&trace_id=${encodeURIComponent(detail.trace_id)}`)`
4. `>1` → set local state `pickSource: ProjectLogSource[]` and show a small menu listing `source.name`; on pick, same push with that `source_id`

Use `useRouter` from `next/navigation`. Import `projectLogSourceAPI`.

Button label: `云日志`. Place it left of「复制 trace」.

- [ ] **Step 2: Typecheck**

Run: `cd frontend-nextjs && npx tsc --noEmit`

Expected: pass

- [ ] **Step 3: Commit** (skip until asked)

```bash
git add frontend-nextjs/components/ExecutionLogsView.tsx
git commit -m "feat: 执行日志详情可跳到云日志。"
```

---

### Task 11: Spec status

**Files:**
- Modify: `docs/superpowers/specs/2026-09-11-project-cloud-logs-design.md` — line 4 `状态：待审阅` → `状态：已通过`

- [ ] **Step 1: Flip status**

- [ ] **Step 2: Commit** (skip until asked)

```bash
git add docs/superpowers/specs/2026-09-11-project-cloud-logs-design.md
git commit -m "docs: 项目云日志设计状态改为已通过。"
```

---

## Spec coverage (self-review)

| Spec section | Task |
|---|---|
| `aliyun_ak` 不进工作流 / HTTP / 数据源 | 2 |
| `project_log_sources` 表 | 3 |
| `ref_count` / 删除拦截 | 4 |
| 查询拼装、24h、line、控制台 URL | 1 |
| GetLogs 签名、401/403、超时 | 5–6 |
| CRUD + query + test + console-url API | 6 |
| 凭证页 | 7 |
| 设置 → 云日志源 | 8 |
| 诊断 → 云日志 + URL 参数 | 9 |
| 执行日志跳转 | 10 |
| 非目标（华为/腾讯、网关管道、MCP、tail） | Global Constraints |

No TBD / “implement later” steps. Names (`compose_sls_query`, `get_logs`, `projectLogSourceAPI`) are consistent across tasks.
