# Workflow LLM Node Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 项目级 LLM 连接 + 工作流一等 `llm` 节点（OpenAI 兼容 Chat Completions、可选流式 / JSON 模式、dry_run 默认真调）。

**Architecture:** 纯逻辑放 `workflow_llm.rs`；连接表与 `fetch_active_for_tenant` 放 `llm_ds`（lib-safe，对齐 `redis_ds`）；CRUD/探活放 bin-only `llm_connection_handlers`；引擎只取连接、注入凭证、接 StreamBridge。不抽 `LlmProvider`。

**Tech Stack:** Rust (sqlx, axum, reqwest, tokio), Next.js 14, 现有 `wf_credentials` / StreamBridge。

**Spec:** `docs/superpowers/specs/2026-09-11-workflow-llm-node-design.md`

## Global Constraints

- Do not create git commits unless the user explicitly asks. Keep Commit steps but skip them until asked.
- 只对接 OpenAI 兼容 `POST {base_url}/chat/completions`。不实现 Anthropic 原生、Agent、视觉、会话表、json_schema。
- `base_url` 只来自连接表；节点不能改写 host。登记时允许内网。
- dry_run / prod_readonly **不**把 `llm` 放进 `side_effect_mock`。只有 `skip_llm: true` 返回 mock。
- `json_mode` 解析失败 = 节点失败。不剥 markdown 围栏。
- 全图 `http_call.stream` + `llm.stream` 合计 ≤ 1。必须同步改 `count_stream_http_calls_json`，否则 endpoint 打字机不会挂桥。
- `workflow_engine.rs` 已很大：组包 / 解析 / HTTP 客户端进 `workflow_llm.rs`。
- `src/lib.rs` 与 `src/main.rs` 都要 `mod workflow_llm` / `mod llm_ds`（handlers 只在 main.rs）。
- 列表 / 详情永不返回凭证密文。
- 供应商测试用本机 TcpListener，禁止连真实 OpenAI。

## File Structure

| Path | Responsibility |
|------|----------------|
| `src/workflow_llm.rs` | URL、组消息、请求体、响应解析、mock、Chat Completions HTTP（含流式） |
| `src/llm_ds/mod.rs` | `fetch_active` / `fetch_active_for_tenant` |
| `src/llm_ds/models.rs` | `LlmConnection` |
| `migrations/067_llm_connections.sql` | 表（号以落地时仓库最大 +1 为准） |
| `src/migrate.rs` | 注册迁移 |
| `src/llm_connection_handlers.rs` | 连接 CRUD + test/health（bin-only） |
| `src/workflow_engine.rs` | `NodeType::Llm`、`exec_llm_node`、静态空 prompt 校验 |
| `src/workflow_stream.rs` | `count_stream_http_calls_json` 计入 `llm` |
| `src/mcp_tools.rs` | `NODE_SPEC`、`list_llm_connections`、debug/文档文案 |
| `src/workflow_qa/rules.rs` | 缺 `connection_id` / `model` |
| `src/main.rs` / `src/lib.rs` | mod + 路由 |
| `frontend-nextjs/lib/api.ts` | `llmAPI` |
| `frontend-nextjs/app/workspace/[projectId]/events/llm-connections/page.tsx` | 连接页（无 exec 控制台） |
| `frontend-nextjs/components/workspace/workspaceNav.ts` | 集成 → LLM |
| `frontend-nextjs/components/workflow/{NodeTypes,WorkflowCanvas,NodeConfigPanel}.tsx` | 节点 UI |

---

### Task 1: `workflow_llm` 纯逻辑 + Chat Completions 客户端

**Files:**
- Create: `src/workflow_llm.rs`
- Modify: `src/lib.rs`（`pub mod workflow_llm;`，放在 `workflow_engine` 旁）
- Modify: `src/main.rs`（`mod workflow_llm;`，放在 `mod workflow_engine;` 旁）

**Interfaces:**
- Consumes: `crate::workflow_stream::{StreamBridge, stream_enabled, extract_stream_text, filter_stream_response_headers, BodyBuffer}`；`crate::error::{AppError, Result}`
- Produces:
  - `pub fn normalize_base_url(raw: &str) -> std::result::Result<String, String>`
  - `pub fn chat_completions_url(base_url: &str) -> String`
  - `pub fn models_url(base_url: &str) -> String`
  - `pub fn normalize_models(models: &[String]) -> Vec<String>`
  - `pub fn model_allowed(models: &[String], model: &str) -> bool`
  - `pub fn is_statically_empty_prompts(system: &Value, user: &Value, messages: &Value) -> bool`
  - `pub fn assemble_messages(system_prompt: Option<&str>, messages: &Value, user_prompt: Option<&str>) -> std::result::Result<Vec<Value>, String>`
  - `pub fn parse_temperature(config: &Value) -> std::result::Result<f64, String>`
  - `pub fn parse_max_tokens(config: &Value) -> std::result::Result<Option<u32>, String>`
  - `pub fn build_chat_body(model: &str, messages: &[Value], temperature: f64, max_tokens: Option<u32>, json_mode: bool, stream: bool) -> Value`
  - `pub fn parse_json_mode_text(text: &str) -> std::result::Result<Value, String>`
  - `pub fn skip_llm_mock(model: &str, json_mode: bool) -> Value`
  - `pub fn truncate_error_body(s: &str) -> String`
  - `pub fn llm_output(text: String, json_mode: bool, usage: Value, model: String, finish_reason: Value, streamed: bool) -> std::result::Result<Value, String>`
  - `pub fn parse_non_stream_response(body: &Value, requested_model: &str, json_mode: bool) -> std::result::Result<Value, String>`
  - `pub struct LlmCallRequest { pub url: String, pub headers: Vec<(String, String)>, pub body: Value, pub timeout_secs: u64, pub json_mode: bool, pub stream: bool, pub requested_model: String }`
  - `pub async fn execute_chat_request(req: LlmCallRequest, sink: Option<StreamBridge>) -> Result<Value>`

- [ ] **Step 1: Write the failing tests**

在 `src/workflow_llm.rs` 先写 `#[cfg(test)]` 与下面用例（函数暂不存在，文件先放空 `pub fn normalize_base_url` 等 stub 让测试能编过并失败）。

```rust
//! 工作流 llm 节点：OpenAI 兼容 Chat Completions 组包 / 解析 / HTTP。
//! 连接存取见 `llm_ds`；引擎只负责取连接、注入凭证、接 StreamBridge。

use serde_json::{json, Value};

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_base_url_strips_slash_and_space() {
        assert_eq!(
            normalize_base_url(" https://api.deepseek.com/v1/ ").unwrap(),
            "https://api.deepseek.com/v1"
        );
    }

    #[test]
    fn normalize_base_url_rejects_empty_and_non_http() {
        assert!(normalize_base_url("").is_err());
        assert!(normalize_base_url("ftp://x").is_err());
        assert!(normalize_base_url("api.openai.com").is_err());
    }

    #[test]
    fn normalize_base_url_allows_localhost() {
        assert_eq!(
            normalize_base_url("http://127.0.0.1:11434/v1").unwrap(),
            "http://127.0.0.1:11434/v1"
        );
    }

    #[test]
    fn chat_and_models_urls_join() {
        assert_eq!(
            chat_completions_url("https://api.openai.com/v1"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            models_url("https://api.openai.com/v1"),
            "https://api.openai.com/v1/models"
        );
    }

    #[test]
    fn model_allowed_is_case_sensitive() {
        let models = normalize_models(&[
            "  deepseek-chat  ".into(),
            "".into(),
            "deepseek-reasoner".into(),
        ]);
        assert_eq!(models, vec!["deepseek-chat", "deepseek-reasoner"]);
        assert!(model_allowed(&models, "deepseek-chat"));
        assert!(!model_allowed(&models, "DeepSeek-Chat"));
    }

    #[test]
    fn assemble_system_messages_user() {
        let msgs = assemble_messages(
            Some("sys"),
            &json!([{"role":"user","content":"hi"},{"role":"assistant","content":"yo"}]),
            Some("now"),
        )
        .unwrap();
        assert_eq!(msgs.len(), 4);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[3]["content"], "now");
    }

    #[test]
    fn assemble_rejects_empty_and_bad_role_and_array_content() {
        assert!(assemble_messages(None, &json!(null), None).is_err());
        assert!(assemble_messages(None, &json!([{"role":"tool","content":"x"}]), None).is_err());
        assert!(assemble_messages(
            None,
            &json!([{"role":"user","content":["no"]}]),
            None
        )
        .is_err());
    }

    #[test]
    fn assemble_parses_messages_json_string() {
        let msgs = assemble_messages(
            None,
            &json!("[{\"role\":\"user\",\"content\":\"a\"}]"),
            None,
        )
        .unwrap();
        assert_eq!(msgs[0]["content"], "a");
    }

    #[test]
    fn statically_empty_only_when_no_templates() {
        assert!(is_statically_empty_prompts(
            &json!(""),
            &json!("  "),
            &json!([])
        ));
        assert!(!is_statically_empty_prompts(
            &json!("{{trigger.x}}"),
            &json!(""),
            &json!(null)
        ));
    }

    #[test]
    fn temperature_default_and_range() {
        assert_eq!(parse_temperature(&json!({})).unwrap(), 0.7);
        assert_eq!(parse_temperature(&json!({"temperature": 0})).unwrap(), 0.0);
        assert!(parse_temperature(&json!({"temperature": 2.1})).is_err());
    }

    #[test]
    fn json_mode_parse_and_fence_not_stripped() {
        assert_eq!(parse_json_mode_text("{\"a\":1}").unwrap()["a"], 1);
        assert!(parse_json_mode_text("```json\n{\"a\":1}\n```").is_err());
        assert!(parse_json_mode_text("not-json").is_err());
    }

    #[test]
    fn skip_mock_and_truncate() {
        let m = skip_llm_mock("m1", true);
        assert_eq!(m["text"], "[skip_llm] mocked completion");
        assert_eq!(m["json"], json!({}));
        assert_eq!(truncate_error_body(&"x".repeat(3000)).len(), 2048);
    }

    #[test]
    fn parse_non_stream_extracts_text_usage() {
        let body = json!({
            "model": "deepseek-chat",
            "choices": [{"message": {"content": "{\"ok\":true}"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3}
        });
        let out = parse_non_stream_response(&body, "fallback", true).unwrap();
        assert_eq!(out["text"], "{\"ok\":true}");
        assert_eq!(out["json"]["ok"], true);
        assert_eq!(out["usage"]["total_tokens"], 3);
        assert_eq!(out["model"], "deepseek-chat");
    }

    #[tokio::test]
    async fn execute_chat_request_posts_json() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("[::1]:0").await.unwrap();
        let url = format!(
            "http://[::1]:{}/v1/chat/completions",
            listener.local_addr().unwrap().port()
        );
        let handle = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let n = s.read(&mut buf).await.unwrap();
            let req = String::from_utf8_lossy(&buf[..n]);
            assert!(req.contains("POST "));
            assert!(req.contains("deepseek-chat"));
            let resp = concat!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n",
                "Content-Length: 92\r\nConnection: close\r\n\r\n",
                r#"{"choices":[{"message":{"content":"hi"},"finish_reason":"stop"}],"usage":{}}"#
            );
            s.write_all(resp.as_bytes()).await.unwrap();
        });

        let out = execute_chat_request(
            LlmCallRequest {
                url,
                headers: vec![],
                body: build_chat_body("deepseek-chat", &[json!({"role":"user","content":"q"})], 0.7, None, false, false),
                timeout_secs: 5,
                json_mode: false,
                stream: false,
                requested_model: "deepseek-chat".into(),
            },
            None,
        )
        .await
        .unwrap();
        assert_eq!(out["text"], "hi");
        handle.await.unwrap();
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib workflow_llm -- --nocapture`

Expected: compile fail or FAIL（`normalize_base_url` 未定义 / stub 返回错值）。

- [ ] **Step 3: Implement the module**

实现要点（必须遵守）：

```rust
pub fn normalize_base_url(raw: &str) -> std::result::Result<String, String> {
    let s = raw.trim().trim_end_matches('/').to_string();
    if s.is_empty() {
        return Err("base_url 不能为空".into());
    }
    if !(s.starts_with("http://") || s.starts_with("https://")) {
        return Err("base_url 必须以 http:// 或 https:// 开头".into());
    }
    Ok(s)
}

pub fn chat_completions_url(base_url: &str) -> String {
    format!("{}/chat/completions", base_url.trim_end_matches('/'))
}

pub fn models_url(base_url: &str) -> String {
    format!("{}/models", base_url.trim_end_matches('/'))
}

pub fn normalize_models(models: &[String]) -> Vec<String> {
    models.iter().map(|m| m.trim().to_string()).filter(|m| !m.is_empty()).collect()
}

pub fn model_allowed(models: &[String], model: &str) -> bool {
    models.iter().any(|m| m == model)
}

fn prompt_str(v: &Value) -> Option<&str> {
    v.as_str().map(str::trim).filter(|s| !s.is_empty())
}

pub fn is_statically_empty_prompts(system: &Value, user: &Value, messages: &Value) -> bool {
    let sys = system.as_str().unwrap_or("");
    let usr = user.as_str().unwrap_or("");
    if sys.contains("{{") || usr.contains("{{") {
        return false;
    }
    if messages.as_str().is_some_and(|s| s.contains("{{")) {
        return false;
    }
    let msgs_empty = match messages {
        Value::Null => true,
        Value::String(s) => s.trim().is_empty() || s.trim() == "[]",
        Value::Array(a) => a.is_empty(),
        _ => false,
    };
    sys.trim().is_empty() && usr.trim().is_empty() && msgs_empty
}

pub fn assemble_messages(
    system_prompt: Option<&str>,
    messages: &Value,
    user_prompt: Option<&str>,
) -> std::result::Result<Vec<Value>, String> {
    let mut out = Vec::new();
    if let Some(s) = system_prompt.map(str::trim).filter(|s| !s.is_empty()) {
        out.push(json!({"role":"system","content":s}));
    }
    let arr = match messages {
        Value::Null => vec![],
        Value::String(s) if s.trim().is_empty() => vec![],
        Value::String(s) => serde_json::from_str::<Value>(s)
            .map_err(|e| format!("messages 不是合法 JSON: {e}"))?
            .as_array()
            .cloned()
            .ok_or_else(|| "messages 必须是数组".to_string())?,
        Value::Array(a) => a.clone(),
        _ => return Err("messages 必须是数组或 JSON 数组字符串".into()),
    };
    for item in arr {
        let role = item.get("role").and_then(|v| v.as_str()).unwrap_or("");
        if !matches!(role, "system" | "user" | "assistant") {
            return Err(format!("messages.role 只允许 system/user/assistant，收到 {role}"));
        }
        let content = item
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "messages.content 必须是字符串".to_string())?;
        out.push(json!({"role": role, "content": content}));
    }
    if let Some(s) = user_prompt.map(str::trim).filter(|s| !s.is_empty()) {
        out.push(json!({"role":"user","content":s}));
    }
    if out.is_empty() {
        return Err("llm 节点组完 messages 为空".into());
    }
    Ok(out)
}

pub fn parse_temperature(config: &Value) -> std::result::Result<f64, String> {
    let Some(v) = config.get("temperature") else {
        return Ok(0.7);
    };
    let n = v.as_f64().or_else(|| v.as_i64().map(|i| i as f64))
        .ok_or_else(|| "temperature 必须是数字".to_string())?;
    if !(0.0..=2.0).contains(&n) {
        return Err("temperature 必须在 0–2".into());
    }
    Ok(n)
}

pub fn parse_max_tokens(config: &Value) -> std::result::Result<Option<u32>, String> {
    let Some(v) = config.get("max_tokens") else { return Ok(None); };
    if v.is_null() { return Ok(None); }
    let n = v.as_u64().or_else(|| v.as_i64().filter(|i| *i > 0).map(|i| i as u64))
        .ok_or_else(|| "max_tokens 必须是正整数".to_string())?;
    Ok(Some(n as u32))
}

pub fn build_chat_body(
    model: &str,
    messages: &[Value],
    temperature: f64,
    max_tokens: Option<u32>,
    json_mode: bool,
    stream: bool,
) -> Value {
    let mut body = json!({
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "stream": stream
    });
    if let Some(n) = max_tokens {
        body["max_tokens"] = json!(n);
    }
    if json_mode {
        body["response_format"] = json!({"type":"json_object"});
    }
    body
}

pub fn parse_json_mode_text(text: &str) -> std::result::Result<Value, String> {
    serde_json::from_str(text.trim()).map_err(|_| "json_mode 下模型输出不是合法 JSON".into())
}

pub fn skip_llm_mock(model: &str, json_mode: bool) -> Value {
    let mut o = json!({
        "text": "[skip_llm] mocked completion",
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        "model": model,
        "finish_reason": "stop",
        "streamed": false
    });
    if json_mode {
        o["json"] = json!({});
    }
    o
}

pub fn truncate_error_body(s: &str) -> String {
    let mut t = s.to_string();
    t.truncate(2048);
    t
}

pub fn llm_output(
    text: String,
    json_mode: bool,
    usage: Value,
    model: String,
    finish_reason: Value,
    streamed: bool,
) -> std::result::Result<Value, String> {
    let mut o = json!({
        "text": text,
        "usage": usage,
        "model": model,
        "finish_reason": finish_reason,
        "streamed": streamed
    });
    if json_mode {
        o["json"] = parse_json_mode_text(o["text"].as_str().unwrap_or(""))?;
    }
    Ok(o)
}

pub fn parse_non_stream_response(
    body: &Value,
    requested_model: &str,
    json_mode: bool,
) -> std::result::Result<Value, String> {
    let choices = body.get("choices").and_then(|v| v.as_array())
        .ok_or_else(|| "供应商响应缺少 choices".to_string())?;
    let first = choices.first().ok_or_else(|| "供应商响应 choices 为空".to_string())?;
    let text = first
        .pointer("/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let finish = first.get("finish_reason").cloned().unwrap_or(Value::Null);
    let usage = body.get("usage").cloned().unwrap_or(json!({
        "prompt_tokens": null, "completion_tokens": null, "total_tokens": null
    }));
    let model = body.get("model").and_then(|v| v.as_str()).unwrap_or(requested_model);
    llm_output(text, json_mode, usage, model.to_string(), finish, false)
}
```

`execute_chat_request`：非流式 `client.post(&url)` + 把 `headers` 写上 + `.json(&req.body)`；非 2xx → `Err(AppError::Internal(format!("LLM 请求失败 HTTP {status}: {}", truncate_error_body(&text))))`；2xx 把 body 当 JSON 交给 `parse_non_stream_response`。

流式：抄 `exec_http_call_node` 的 stream 分支（`src/workflow_engine.rs` 约 4534–4623 行）：`send()` 后 `filter_stream_response_headers` + `sink.commit`，`bytes_stream` 推 `chunk`，结束 `end()`，`text = extract_stream_text(&body)`，再 `llm_output(..., streamed: true)`。`timeout_secs == 0` 不包 timeout；`>0` 用 `tokio::time::timeout`。

`json_mode` 从 `req.json_mode` 读，不要从 body 再猜。

- [ ] **Step 4: Run tests**

Run: `cargo test --lib workflow_llm -- --nocapture`

Expected: PASS

- [ ] **Step 5: Commit**（用户未要求则跳过）

```bash
git add src/workflow_llm.rs src/lib.rs src/main.rs
git commit -m "feat: add workflow_llm OpenAI-compatible helpers"
```

---

### Task 2: 迁移 + `llm_ds` 取连接

**Files:**
- Create: `migrations/067_llm_connections.sql`（若仓库已有 ≥067，用最大号 +1，并同步本任务所有路径）
- Modify: `src/migrate.rs`：在 `MIGRATIONS` 末尾、`066 project log sources` 之后追加一项
- Create: `src/llm_ds/mod.rs`、`src/llm_ds/models.rs`
- Modify: `src/lib.rs`（`pub mod llm_ds;`，注释写明 lib-safe、给 workflow 节点用）
- Modify: `src/main.rs`（`mod llm_ds;`）

**Interfaces:**
- Consumes: `normalize_base_url` / `normalize_models` 仅 handlers 用；本任务模型层只存已规范化值
- Produces:
  - `pub struct LlmConnection { id: i64, tenant_id: i32, connection_name: String, base_url: String, credential_id: Option<i32>, models: Vec<String>, is_active: bool, created_by: i32, created_at: DateTime<Utc>, updated_at: DateTime<Utc> }`
  - `pub async fn fetch_active(pool: &PgPool, id: i64) -> Result<LlmConnection>`
  - `pub async fn fetch_active_for_tenant(pool: &PgPool, id: i64, tenant_id: i32) -> Result<LlmConnection>`
  - `pub async fn list_for_tenant(pool: &PgPool, tenant_id: i32) -> Result<Vec<LlmConnection>>`（MCP / 下拉复用）

- [ ] **Step 1: Write the migration exactly**

```sql
CREATE TABLE IF NOT EXISTS management.llm_connections (
    id                   BIGSERIAL PRIMARY KEY,
    tenant_id            INTEGER NOT NULL
                         REFERENCES management.tenants(id) ON DELETE CASCADE,
    connection_name      VARCHAR(100) NOT NULL,
    base_url             TEXT NOT NULL,
    credential_id        INTEGER
                         REFERENCES management.wf_credentials(id) ON DELETE SET NULL,
    models               TEXT[] NOT NULL DEFAULT '{}',
    is_active            BOOLEAN NOT NULL DEFAULT true,
    created_by           INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_llm_conn_name UNIQUE (tenant_id, connection_name)
);

CREATE INDEX IF NOT EXISTS idx_llm_connections_tenant
    ON management.llm_connections(tenant_id)
    WHERE is_active;
```

`migrate.rs` 追加：

```rust
    (
        "067 llm connections",
        include_str!("../migrations/067_llm_connections.sql"),
    ),
```

- [ ] **Step 2: Implement models + fetch**

`models.rs`：`#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]`。`models` 列用 `Vec<String>`（sqlx Postgres TEXT[]）。

`mod.rs` 照抄 `src/redis_ds/mod.rs` 的两个 fetch，表名换成 `management.llm_connections`，错误文案换成「LLM 连接」。`fetch_active_for_tenant` 的 SQL 必须含 `id = $1 AND tenant_id = $2 AND is_active = true`。另加 `list_for_tenant`：`WHERE tenant_id = $1 ORDER BY id DESC`（含停用行，供编辑器与 MCP）。

- [ ] **Step 3: Compile**

Run: `cargo test --lib llm_ds -- --nocapture`

Expected: 能编译。本模块无单测也可；若 sqlx 对 TEXT[] 映射报错，给 `models` 加 `#[sqlx(try_from = "...")]` 前先确认 `Vec<String>` 在本仓库其它 FromRow 是否已用过——没有的话用 `sqlx::types::Json` 不改表，**表保持 TEXT[]**，在 Rust 用：

```rust
#[sqlx(try_from = "Vec<String>")]
```

不需要时不要加。标准 `sqlx` Postgres `TEXT[]` → `Vec<String>` 即可。

- [ ] **Step 4: Commit**（未要求则跳过）

```bash
git add migrations/067_llm_connections.sql src/migrate.rs src/llm_ds src/lib.rs src/main.rs
git commit -m "feat: add llm_connections table and tenant fetch"
```

---

### Task 3: 连接 CRUD + 探活 API

**Files:**
- Create: `src/llm_connection_handlers.rs`
- Modify: `src/main.rs`：`mod llm_connection_handlers;`；在 `redis-connections` 路由旁注册

**Interfaces:**
- Consumes: `llm_ds::models::LlmConnection`、`workflow_llm::{normalize_base_url, normalize_models, models_url}`、`workflow_credentials::{load_credential_store, apply_http_auth_headers}`
- Produces: 下列 handler（签名与 `redis_handlers` 相同风格）
  - `list_connections` / `get_connection` / `create_connection` / `update_connection` / `delete_connection`
  - `test_connection`（未保存）
  - `health_connection`（已保存）

- [ ] **Step 1: Implement handlers**

权限：复制 `redis_handlers.rs` 的 `require_tenant_admin` + `list` 的 `resolve_tenant_list_filter`。列表不过滤 `is_active`（编辑器要能看到停用项）；工作流执行只走 `fetch_active_for_tenant`。

DTO：

```rust
#[derive(Deserialize)]
pub struct CreateConnectionReq {
    pub tenant_id: i32,
    pub connection_name: String,
    pub base_url: String,
    pub credential_id: Option<i32>,
    pub models: Option<Vec<String>>,
    pub is_active: Option<bool>,
}

#[derive(Deserialize)]
pub struct UpdateConnectionReq {
    pub connection_name: Option<String>,
    pub base_url: Option<String>,
    pub credential_id: Option<Option<i32>>, // JSON null = 清空凭证
    pub models: Option<Vec<String>>,
    pub is_active: Option<bool>,
}

#[derive(Deserialize)]
pub struct TestConnectionReq {
    pub tenant_id: i32,
    pub base_url: String,
    pub credential_id: Option<i32>,
}
```

创建校验：

1. `connection_name.trim()` 非空
2. `base_url = normalize_base_url(&req.base_url)?`（`map_err(AppError::InvalidQuery)`）
3. `models = normalize_models(&req.models.unwrap_or_default())`
4. 若 `credential_id` 有值：查 `management.wf_credentials` 且 `tenant_id` 相同，否则 `InvalidQuery("凭证不存在或不属于当前项目")`

INSERT：

```sql
INSERT INTO management.llm_connections
  (tenant_id, connection_name, base_url, credential_id, models, is_active, created_by)
VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
```

`is_active` 默认 true。唯一约束冲突文案：`同名 LLM 连接已存在`。

探活（test 与 health 共用内部函数 `probe_models(base_url, tenant_id, credential_id, pool)`）：

1. `load_credential_store(pool, tenant_id).await`
2. 若有 `credential_id`：`get_by_id`，无则失败「探活凭证不存在」；`apply_http_auth_headers` 到 map，再打成 reqwest headers
3. `GET models_url(&base_url)`，timeout 10s
4. 2xx → `{ "ok": true, "status": n }`
5. 否则返回脱敏后的状态错误，不透传上游响应体；**handler 仍 200**，由前端展示。网络错也返回通用错误，但 **create/update 不调用探活**。

`test_connection`：先 `require_tenant_admin(tenant_id)`，再 probe。<br>
`health_connection`：先 `fetch_connection_authorized`，用行上的 `base_url` / `credential_id` / `tenant_id`。

DELETE：`DELETE FROM management.llm_connections WHERE id = $1`，不扫工作流。

- [ ] **Step 2: Register routes in `src/main.rs`**

紧挨现有 redis 路由：

```rust
.route("/api/admin/llm-connections", get(llm_connection_handlers::list_connections).post(llm_connection_handlers::create_connection))
.route("/api/admin/llm-connections/test", post(llm_connection_handlers::test_connection))
.route("/api/admin/llm-connections/:id", get(llm_connection_handlers::get_connection).put(llm_connection_handlers::update_connection).delete(llm_connection_handlers::delete_connection))
.route("/api/admin/llm-connections/:id/health", post(llm_connection_handlers::health_connection))
```

注意：`/test` 必须注册在 `/:id` **之前**，避免 `test` 被当成 id。

- [ ] **Step 3: Compile**

Run: `cargo check --bin onebase`（或仓库实际 bin 名；若只有 lib+main：`cargo check`）

Expected: 无错误。

- [ ] **Step 4: Commit**（未要求则跳过）

```bash
git add src/llm_connection_handlers.rs src/main.rs
git commit -m "feat: add LLM connection admin API"
```

---

### Task 4: 引擎 `llm` 节点 + 流式计数

**Files:**
- Modify: `src/workflow_engine.rs`
- Modify: `src/workflow_stream.rs`
- Modify: `src/workflow_handlers.rs`（不必改调用点，只因计数函数语义变了）
- Modify: `src/mcp_tools.rs` 里 `workflow_api_doc` 的提示文案（本任务改计数；文案在 Task 5 一起改也可，本任务必须改计数测试）

**Interfaces:**
- Consumes: `workflow_llm::*`、`llm_ds::fetch_active_for_tenant`、`workflow_credentials::apply_http_auth_headers`
- Produces: `NodeType::Llm`（serde `llm`）、`exec_llm_node`、`validate_definition` 合计流式 ≤ 1

- [ ] **Step 1: Write failing engine / stream tests**

在 `src/workflow_stream.rs` 的 `count_stream_http_calls_json_counts_only_stream_http` **之后**加：

```rust
    #[test]
    fn count_stream_http_calls_json_counts_llm_stream() {
        let nodes = json!([
            {"id":"a","type":"llm","config":{"stream":true}},
            {"id":"b","type":"http_call","config":{"stream":false}}
        ]);
        assert_eq!(count_stream_http_calls_json(&nodes), 1);
    }
```

在 `src/workflow_engine.rs` 的 `validate_rejects_two_stream_http_calls` 旁加：

```rust
    fn llm_node(id: &str, config: JsonValue) -> WorkflowNode {
        WorkflowNode {
            id: id.into(),
            node_type: NodeType::Llm,
            label: None,
            config,
        }
    }

    #[test]
    fn validate_rejects_llm_and_http_stream() {
        let def = WorkflowDefinition {
            nodes: vec![
                llm_node("a", json!({"connection_id":1,"model":"m","user_prompt":"q","stream":true})),
                http_node("b", json!({"url":"https://y","stream":true})),
            ],
            edges: vec![],
        };
        let err = validate_definition(&def).unwrap_err().to_string();
        assert!(err.contains("最多只能有一个 stream"));
    }

    #[test]
    fn validate_rejects_statically_empty_llm_prompts() {
        let def = WorkflowDefinition {
            nodes: vec![llm_node("a", json!({"connection_id":1,"model":"m"}))],
            edges: vec![],
        };
        let err = validate_definition(&def).unwrap_err().to_string();
        assert!(err.contains("messages"));
    }

    #[test]
    fn validate_allows_templated_llm_user_prompt() {
        let def = WorkflowDefinition {
            nodes: vec![llm_node(
                "a",
                json!({"connection_id":1,"model":"m","user_prompt":"{{trigger.q}}"}),
            )],
            edges: vec![],
        };
        assert!(validate_definition(&def).is_ok());
    }
```

在 `workflow_engine.rs` tests 加（不连 DB：直接调 `execute_llm_turn` 见 Step 3）：

```rust
    #[test]
    fn skip_llm_mock_shape() {
        let out = crate::workflow_llm::skip_llm_mock("m", false);
        assert_eq!(out["finish_reason"], "stop");
        assert_eq!(out["streamed"], false);
    }
```

- [ ] **Step 2: Run to see fail**

Run: `cargo test --lib workflow_stream::tests::count_stream_http_calls_json_counts_llm_stream -- --nocapture`

Expected: FAIL（计数仍为 0）或 `NodeType::Llm` 不存在。

- [ ] **Step 3: Implement**

1. `NodeType` 在 `Loop` 前加：

```rust
    /// OpenAI 兼容 Chat Completions。
    /// config: `{ connection_id, model, system_prompt?, user_prompt?, messages?,
    ///            temperature?, max_tokens?, json_mode?, stream?, timeout_secs?, skip_llm? }`
    Llm,
```

2. `execute_node` 的 `match` 加 `NodeType::Llm => self.exec_llm_node(config, ctx).await,`

3. **不要**把 `Llm` 加入 `side_effect_mock`。

4. `validate_definition` 里现有 `stream_http_calls` 循环改为统计所有 `stream_enabled` 的 `HttpCall` **或** `Llm`。错误文案：`工作流最多只能有一个 stream: true 的 http_call 或 llm 节点`。对每个 `Llm`：缺 `connection_id` 或 `model`（非空字符串）→ 失败；`is_statically_empty_prompts(system, user, messages)` → 失败「llm 节点组完 messages 为空」。`temperature` 若存在则 `parse_temperature`，失败则保存失败。

5. `count_stream_http_calls_json`：`type` 为 `http_call` **或** `llm` 且 `stream_enabled(config)`。更新函数注释。`workflow_api_doc` 提示改为「stream: true 的 http_call 或 llm」。

6. `exec_llm_node`：

```rust
    async fn exec_llm_node(&self, config: &JsonValue, ctx: &ExecutionContext) -> Result<NodeOutcome> {
        let connection_id = config.get("connection_id").and_then(|v| v.as_i64())
            .ok_or_else(|| AppError::InvalidQuery("llm 节点缺少 connection_id".into()))?;
        let model = config.get("model").and_then(|v| v.as_str()).map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::InvalidQuery("llm 节点缺少 model".into()))?
            .to_string();
        let tenant_id = ctx.tenant_id.ok_or_else(|| {
            AppError::InvalidQuery("llm 节点需要 workflow.tenant_id 才能解析连接".into())
        })?;
        let conn = crate::llm_ds::fetch_active_for_tenant(&self.pool, connection_id, tenant_id).await?;
        if !crate::workflow_llm::model_allowed(&conn.models, &model) {
            return Err(AppError::InvalidQuery(format!("模型 {model} 不在连接 {} 的列表中", conn.connection_name)));
        }
        let json_mode = config.get("json_mode").and_then(|v| v.as_bool()).unwrap_or(false);
        let skip = config.get("skip_llm").and_then(|v| v.as_bool()).unwrap_or(false);
        let system = config.get("system_prompt").and_then(|v| v.as_str());
        let user = config.get("user_prompt").and_then(|v| v.as_str());
        let messages_v = config.get("messages").cloned().unwrap_or(JsonValue::Null);
        let assembled = crate::workflow_llm::assemble_messages(system, &messages_v, user)
            .map_err(AppError::InvalidQuery)?;
        if skip {
            return Ok(ok_out(crate::workflow_llm::skip_llm_mock(&model, json_mode)));
        }
        let temperature = crate::workflow_llm::parse_temperature(config).map_err(AppError::InvalidQuery)?;
        let max_tokens = crate::workflow_llm::parse_max_tokens(config).map_err(AppError::InvalidQuery)?;
        let stream = crate::workflow_stream::stream_enabled(config);
        let timeout_secs = /* 与 http_call 相同的 timeout_secs/timeout 解析，默认 http_default_timeout_secs() */;
        let mut headers_obj = serde_json::Map::new();
        if let Some(cid) = conn.credential_id {
            let cred = ctx.credentials.get_by_id(cid)
                .ok_or_else(|| AppError::InvalidQuery(format!("连接凭证 {cid} 不存在")))?;
            crate::workflow_credentials::apply_http_auth_headers(&mut headers_obj, cred)
                .map_err(AppError::InvalidQuery)?;
        }
        let headers: Vec<(String, String)> = headers_obj.iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
            .collect();
        let body = crate::workflow_llm::build_chat_body(&model, &assembled, temperature, max_tokens, json_mode, stream);
        let sink = if stream && ctx.trigger_type == "endpoint" {
            self.stream_bridge.clone()
        } else {
            None
        };
        let url = crate::workflow_llm::chat_completions_url(&conn.base_url);
        let output = crate::workflow_llm::execute_chat_request(
            crate::workflow_llm::LlmCallRequest {
                url, headers, body, timeout_secs, json_mode, stream, requested_model: model,
            },
            sink,
        ).await?;
        Ok(ok_out(output))
    }
```

`timeout_secs` 解析复制 `exec_http_call_node` 45–58 行那段（`timeout_secs` / `timeout` / 默认 `http_default_timeout_secs()`）。

- [ ] **Step 4: Run tests**

Run:

```
cargo test --lib workflow_stream::tests::count_stream -- --nocapture
cargo test --lib workflow_engine::tests::validate_rejects_llm -- --nocapture
cargo test --lib workflow_engine::tests::validate_allows_templated_llm -- --nocapture
cargo test --lib workflow_engine::tests::validate_rejects_two_stream -- --nocapture
```

Expected: PASS。旧测试「最多只能有一个 stream」仍能匹配新文案。

再跑：`cargo test --lib workflow_llm -- --nocapture` 防回归。

- [ ] **Step 5: Commit**（未要求则跳过）

```bash
git add src/workflow_engine.rs src/workflow_stream.rs src/mcp_tools.rs
git commit -m "feat: execute workflow llm nodes"
```

---

### Task 5: MCP `NODE_SPEC` + `list_llm_connections`

**Files:**
- Modify: `src/mcp_tools.rs`

**Interfaces:**
- Consumes: `llm_ds::models::LlmConnection` 的列表查询（handler 或直接 SQL）
- Produces: 工具 `list_llm_connections`；`NODE_SPEC` 写 16 种节点并含 `llm` 节

- [ ] **Step 1: Update `NODE_SPEC`**

把 `## 节点类型（15 种）` 改为 `16 种`。在 `http_call` 节后插入：

```
### llm（大模型 Chat Completions）
config: `{ "connection_id": 整数, "model": "连接 models 列表中的字面量",
          "system_prompt": "可选", "user_prompt": "可选",
          "messages": "可选数组或 {{trigger.messages}}",
          "temperature": 0.7, "max_tokens": 可选正整数,
          "json_mode": false, "stream": false, "timeout_secs": 120, "skip_llm": false }`
- 先 `list_llm_connections` 再填 `connection_id`，不要猜 id
- 只 POST `{base_url}/chat/completions`（OpenAI 兼容）；密钥来自连接上的 credential_id
- 组消息：system_prompt → messages → user_prompt；content 只允许字符串
- 输出 `{ text, json?, usage, model, finish_reason, streamed? }`；json 仅 json_mode 成功时出现
- dry_run 默认真调；`skip_llm: true` 才 mock
- stream: true 与 http_call.stream 合计全图最多一个
```

`tool_definitions` 里 `node_spec` 的 description 改为「16 种节点」。

`debug_workflow` description 把「跳过写库/HTTP/邮件/SSE」改成：「默认 dry_run=true：跳过写库/http_call/邮件/SSE；**llm 节点仍真调**（除非节点 skip_llm）。」

`workflow_api_doc` 流式 note：`含 stream: true 的 http_call 或 llm`。

在 `tool_definitions` 数组中 `node_spec` 后插入：

```json
{
  "name": "list_llm_connections",
  "description": "列出当前项目已登记的 LLM 连接（id/name/base_url/models/is_active/credential_id，无密钥）。编写 llm 节点前必调。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "tenant_id": { "type": "integer", "description": "项目/租户 ID" }
    },
    "required": ["tenant_id"]
  }
}
```

`call_tool` match 增加 `"list_llm_connections" => tool_list_llm_connections(pool, claims, args).await`。

在 `llm_ds/mod.rs` 增加（Task 2 若已写 fetch，本步补上 list）：

```rust
pub async fn list_for_tenant(pool: &PgPool, tenant_id: i32) -> Result<Vec<LlmConnection>> {
    sqlx::query_as::<_, LlmConnection>(
        "SELECT * FROM management.llm_connections WHERE tenant_id = $1 ORDER BY id DESC",
    )
    .bind(tenant_id)
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::Internal(format!("列出 LLM 连接失败: {e}")))
}
```

```rust
async fn tool_list_llm_connections(pool: &PgPool, claims: &Claims, args: &Value) -> Result<Value> {
    let tenant_id = args.get("tenant_id").and_then(|v| v.as_i64())
        .ok_or_else(|| AppError::InvalidQuery("缺少 tenant_id".into()))? as i32;
    // 与 list_workflows 相同：非超管必须对该 tenant 可见，抄 tool_list_workflows 里的权限检查。
    let rows = crate::llm_ds::list_for_tenant(pool, tenant_id).await?;
    Ok(serde_json::to_value(rows).unwrap_or(json!([])))
}
```

返回数组字段即 `LlmConnection`（表无密文列）。

- [ ] **Step 2: Compile and grep**

Run: `rg "15 种" src/mcp_tools.rs` → 无匹配。<br>
Run: `cargo check`

- [ ] **Step 3: Commit**（未要求则跳过）

```bash
git add src/mcp_tools.rs src/llm_ds/mod.rs
git commit -m "docs: add llm node to MCP node_spec"
```

---

### Task 6: workflow-qa 规则

**Files:**
- Modify: `src/workflow_qa/rules.rs`

**Interfaces:**
- Consumes: 节点 JSON `type === "llm"`
- Produces: finding code `llm.missing_connection`、`llm.missing_model`（Severity::High / error 级；现有枚举用 `Severity::High`）

- [ ] **Step 1: Write failing tests** in `rules.rs` `mod tests`

```rust
    #[test]
    fn llm_missing_connection_and_model() {
        let wf = snap(
            "endpoint",
            json!([{"id":"a","type":"llm","config":{}}]),
            json!([]),
        );
        let c: Vec<_> = scan_rules(&wf).into_iter().map(|f| f.code).collect();
        assert!(c.contains(&"llm.missing_connection".to_string()));
        assert!(c.contains(&"llm.missing_model".to_string()));
    }

    #[test]
    fn llm_complete_config_skips_those_rules() {
        let wf = snap(
            "manual",
            json!([{"id":"a","type":"llm","config":{"connection_id":1,"model":"m","user_prompt":"q"}}]),
            json!([]),
        );
        let c: Vec<_> = scan_rules(&wf).into_iter().map(|f| f.code).collect();
        assert!(!c.contains(&"llm.missing_connection".to_string()));
        assert!(!c.contains(&"llm.missing_model".to_string()));
    }
```

`snap` 已存在。`has_hardcoded_secret` 已扫整节点字符串，prompt 里的密钥字面量沿用，不必新规则。

- [ ] **Step 2: Run to fail**

Run: `cargo test --lib workflow_qa::rules::tests::llm_missing -- --nocapture`

Expected: FAIL

- [ ] **Step 3: Implement in `scan_rules` 的 `for n in nodes` 循环末尾**

```rust
        if ty == "llm" {
            let cfg = n.get("config").cloned().unwrap_or(Value::Null);
            let has_conn = cfg.get("connection_id").and_then(|v| v.as_i64()).is_some();
            let has_model = cfg.get("model").and_then(|v| v.as_str()).map(str::trim).is_some_and(|s| !s.is_empty());
            if !has_conn {
                out.push(hit(
                    Severity::High,
                    "llm.missing_connection",
                    "llm 节点缺少 connection_id",
                    "先在集成 → LLM 登记连接，再填 connection_id",
                    Some(n),
                    evidence(n),
                ));
            }
            if !has_model {
                out.push(hit(
                    Severity::High,
                    "llm.missing_model",
                    "llm 节点缺少 model",
                    "model 必须是该连接 models 列表中的字面量",
                    Some(n),
                    evidence(n),
                ));
            }
        }
```

- [ ] **Step 4: Run tests**

Run: `cargo test --lib workflow_qa::rules -- --nocapture`

Expected: PASS

- [ ] **Step 5: Commit**（未要求则跳过）

```bash
git add src/workflow_qa/rules.rs
git commit -m "feat: lint llm nodes missing connection or model"
```

---

### Task 7: 前端连接页

**Files:**
- Modify: `frontend-nextjs/lib/api.ts`
- Modify: `frontend-nextjs/components/workspace/workspaceNav.ts`（「对象存储」项后加 LLM）
- Create: `frontend-nextjs/app/workspace/[projectId]/events/llm-connections/page.tsx`

**Interfaces:**
- Consumes: `/api/admin/llm-connections*`
- Produces: `llmAPI`、侧栏入口、连接 CRUD + 测试按钮（无 exec 控制台）

- [ ] **Step 1: Add API types next to `redisAPI`**

```ts
export interface LlmConnection {
  id: number
  tenant_id: number
  connection_name: string
  base_url: string
  credential_id: number | null
  models: string[]
  is_active: boolean
  created_by: number
  created_at: string
  updated_at: string
}

export const llmAPI = {
  listConnections: (tenantId: number) =>
    api.get<LlmConnection[]>('/api/admin/llm-connections', { params: { tenant_id: tenantId } }),
  getConnection: (id: number) => api.get<LlmConnection>(`/api/admin/llm-connections/${id}`),
  createConnection: (input: {
    tenant_id: number
    connection_name: string
    base_url: string
    credential_id?: number | null
    models?: string[]
    is_active?: boolean
  }) => api.post<LlmConnection>('/api/admin/llm-connections', input),
  updateConnection: (id: number, input: Record<string, unknown>) =>
    api.put<LlmConnection>(`/api/admin/llm-connections/${id}`, input),
  deleteConnection: (id: number) => api.delete(`/api/admin/llm-connections/${id}`),
  testConnection: (input: { tenant_id: number; base_url: string; credential_id?: number | null }) =>
    api.post<{ ok: boolean; status?: number; error?: string }>('/api/admin/llm-connections/test', input),
  healthConnection: (id: number) =>
    api.post<{ ok: boolean; status?: number; error?: string }>(`/api/admin/llm-connections/${id}/health`),
}
```

- [ ] **Step 2: Nav**

在 `workspaceNav.ts` 集成组 `对象存储` 后：

```ts
{ label: 'LLM', href: '/events/llm-connections', icon: 'fas fa-robot' },
```

- [ ] **Step 3: Page**

新建页面，布局对齐 Redis **但不做数据控制台**：左列表，右表单（名称、base_url、凭证下拉 `wfCredentialAPI.list(tenantId)`、模型用逗号或 tag 输入、is_active、测试连接、保存、删除）。`canManageEvents` 不足则 `ForbiddenPlaceholder`。`base_url` 占位符写 `https://api.openai.com/v1`。模型保存为 `string[]`。测试调用 `llmAPI.testConnection`，用 notify 显示 `ok` / `error`。

凭证下拉：列出 `bearer` / `api_key` / `basic`，允许空（无认证）。

- [ ] **Step 4: Typecheck**

Run: `cd frontend-nextjs && npx tsc --noEmit`

Expected: 无因本页产生的错误。

- [ ] **Step 5: Commit**（未要求则跳过）

```bash
git add frontend-nextjs/lib/api.ts frontend-nextjs/components/workspace/workspaceNav.ts \
  frontend-nextjs/app/workspace/\[projectId\]/events/llm-connections/page.tsx
git commit -m "feat: add project LLM connections page"
```

---

### Task 8: 画布 `llm` 节点表单

**Files:**
- Modify: `frontend-nextjs/components/workflow/NodeTypes.tsx`
- Modify: `frontend-nextjs/components/workflow/WorkflowCanvas.tsx`
- Modify: `frontend-nextjs/components/workflow/NodeConfigPanel.tsx`

**Interfaces:**
- Consumes: `llmAPI.listConnections(projectId)`
- Produces: 调色板「集成」含 `llm`；配置连接/模型/prompt/开关

- [ ] **Step 1: Meta + palette + default config**

`NODE_TYPE_META` 加：

```ts
  llm: { label: '大模型', icon: '✦', color: 'bg-violet-50', borderColor: 'border-violet-400', accent: 'bg-violet-400', minimapColor: '#a78bfa' },
```

`NODE_PALETTE_GROUPS` 集成组改为：

```ts
{ label: '集成', types: ['http_call', 'llm', 'email_send', 'sse_publish', 'call_workflow', 'redis', 'kafka', 'object_storage'] },
```

`getDefaultConfig`：

```ts
    case 'llm': return {
      connection_id: 0,
      model: '',
      system_prompt: '',
      user_prompt: '',
      messages: '',
      temperature: 0.7,
      json_mode: false,
      stream: false,
      skip_llm: false,
    }
```

- [ ] **Step 2: `JSON_FIELD_RULES`**

```ts
  llm: {
    messages: { label: 'messages' },
  },
```

- [ ] **Step 3: `LlmNodeConfig` 组件**

照 `RedisNodeConfig`：`useParams` 取 `projectId`，`llmAPI.listConnections`。连接 `<select>` 写 `connection_id` 数字；模型 `<select>` options = 当前连接 `models`（连接未选或列表空时禁用并提示去「集成 → LLM」登记）。

字段：

- `CodeSnippetEditor`：`system_prompt`、`user_prompt`（language plaintext / text）
- messages：现有 JSON 文本框 + `commitJsonField('messages')`（整段 `{{trigger.messages}}` 可过）
- temperature：`type="number"` min 0 max 2 step 0.1
- max_tokens：number，空则 `updateConfig('max_tokens', undefined)` 或删键
- checkbox：`json_mode`、`stream`（文案：「流式输出（适合 endpoint 打字机）」）、`skip_llm`（文案：「跳过真实调用（debug mock）」）
- `timeout_secs` 可选数字，占位 120

在主 panel `node.type === 'http_call'` 块旁加 `{node.type === 'llm' && <LlmNodeConfig node={node} updateConfig={updateConfig} commitJsonField={commitJsonField} readOnly={readOnly} />}`。

连接切换时若当前 `model` 不在新列表，把 `model` 设为 `models[0] || ''`。

- [ ] **Step 4: Typecheck**

Run: `cd frontend-nextjs && npx tsc --noEmit`

Expected: PASS

- [ ] **Step 5: 手工验收**

1. 集成 → LLM：建一条连接（可用任意 OpenAI 兼容 base_url + 凭证），测试连接。
2. 画布拖「大模型」，选连接和模型，写 user_prompt `{{trigger.q}}`。
3. debug：`trigger_data: { "q": "ping" }`，未勾 skip 时应打到供应商（或你的 mock 网关）；勾 skip 得到 `[skip_llm] mocked completion`。
4. 同图再拖一个 `http_call` 并勾 stream，保存应被后端拒绝。
5. MCP `node_spec` 含 `llm`；`list_llm_connections` 返回刚建的 id。

- [ ] **Step 6: Commit**（未要求则跳过）

```bash
git add frontend-nextjs/components/workflow/NodeTypes.tsx \
  frontend-nextjs/components/workflow/WorkflowCanvas.tsx \
  frontend-nextjs/components/workflow/NodeConfigPanel.tsx
git commit -m "feat: add llm node to workflow editor"
```

---

## Spec coverage

| Spec 节 | Task |
|---|---|
| 连接表 / 内网 base_url / credential_id | 2, 3 |
| 探活 /models 不拦保存 | 3 |
| 组消息 / JSON 模式 / skip mock / 输出形状 | 1, 4 |
| dry_run 真调、不进 side_effect_mock | 4 |
| StreamBridge + 合计一个流式源 + endpoint 挂桥 | 4（改 `count_stream_http_calls_json`） |
| MCP 16 种 + list_llm_connections + debug 文案 | 5 |
| QA 缺 connection/model | 6 |
| 集成页 + 节点表单 | 7, 8 |
| 非目标（Agent/视觉/会话/LlmProvider） | 不实现 |

## Type consistency

- 连接 `id: i64`，`credential_id: Option<i32>`，`tenant_id: i32`
- 节点 serde 类型名 `llm` ↔ `NodeType::Llm`
- `skip_llm_mock` / `execute_chat_request` / `fetch_active_for_tenant` 名称在 Task 1–4 前后一致
- 流式计数函数仍叫 `count_stream_http_calls_json`，语义变为 http_call **或** llm
