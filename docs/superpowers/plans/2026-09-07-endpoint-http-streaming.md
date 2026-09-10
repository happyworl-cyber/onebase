# Endpoint HTTP Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an endpoint workflow opt in with `http_call.stream=true` so the same `/workflow/{db}/{slug}` request pipes the upstream HTTP body to the caller while the engine buffers `body`, extracts `text`, and continues the DAG after the stream ends.

**Architecture:** A process-local `StreamBridge` (`mpsc`, capacity 32) carries `Commit` / `Chunk` / `End`. The handler late-commits the HTTP response on `Commit` and writes raw bytes; the workflow stays detached so a client disconnect does not cancel upstream or downstream. The bridge lives on `DagEngine` and is only written when `ctx.trigger_type == "endpoint"`, so `call_workflow` children buffer+extract but never take the parent HTTP connection.

**Tech Stack:** Rust (tokio mpsc, reqwest `bytes_stream`, axum `Body::from_stream`), Next.js `NodeConfigPanel.tsx`.

**Spec:** `docs/superpowers/specs/2026-09-07-endpoint-http-streaming-design.md`

## Global Constraints

- Do not create git commits unless the user explicitly asks. Keep the Commit steps in this plan but skip them until asked.
- No `stream: true` graph must keep today's JSON / detach behavior byte-for-byte.
- Do not wrap upstream bytes in a OneBase SSE envelope.
- Do not send the stream through `SseHub` / Redis.
- One `stream: true` `http_call` per definition; `stream` and `async_poll` are mutually exclusive.
- `body` buffer cap is **8 MiB** (`8 * 1024 * 1024`). HTTP still writes every upstream byte after the cap; only the node buffer stops.
- `text` extractors: OpenAI-compatible SSE and Claude `content_block_delta` only.
- Channel capacity is **32**. `send().await` backpressures the upstream read.
- Do not add a stop-generation API, code-node yield, or a second stream URL.

---

## File Structure

- Create `src/workflow_stream.rs`: `StreamEvent`, `StreamBridge`, `stream_enabled`, `count_stream_http_calls`, `count_stream_http_calls_json`, `extract_stream_text`, `filter_stream_response_headers`, `BodyBuffer`.
- Modify `src/lib.rs`: `pub mod workflow_stream;`
- Modify `src/main.rs`: `mod workflow_stream;` (same file, bin crate).
- Modify `src/workflow_engine.rs`: `validate_definition` stream rules; `DagEngine.stream_bridge`; `exec_http_call_node(&self, config, ctx)` streaming branch.
- Modify `src/workflow_handlers.rs`: `execute_workflow_with_bridge`; endpoint GET/POST/`/pub` late-commit streaming response.
- Modify `src/mcp_tools.rs`: `node_spec` `http_call` paragraph; `workflow_api_doc` stream note.
- Modify `frontend-nextjs/components/workflow/NodeConfigPanel.tsx`: stream checkbox; hide `async_poll` when stream is on.

---

### Task 1: Pure `workflow_stream` module

**Files:**
- Create: `src/workflow_stream.rs`
- Modify: `src/lib.rs` (add `pub mod workflow_stream;` next to `pub mod http_async_poll;`)
- Modify: `src/main.rs` (add `mod workflow_stream;` next to `mod http_async_poll;`)

**Interfaces:**
- Consumes: none.
- Produces:
  - `pub const BODY_LIMIT_BYTES: usize = 8 * 1024 * 1024;`
  - `pub const STREAM_CHANNEL_CAPACITY: usize = 32;`
  - `pub enum StreamEvent { Commit { status: u16, headers: Vec<(String, String)> }, Chunk(Vec<u8>), End }`
  - `pub struct StreamBridge { tx: tokio::sync::mpsc::Sender<StreamEvent> }` (`Clone`)
  - `impl StreamBridge { pub fn pair() -> (Self, tokio::sync::mpsc::Receiver<StreamEvent>); pub async fn commit(&self, status: u16, headers: Vec<(String, String)>) -> bool; pub async fn chunk(&self, bytes: Vec<u8>) -> bool; pub async fn end(&self) -> bool }` — each returns `false` when the receiver is gone.
  - `pub fn stream_enabled(config: &serde_json::Value) -> bool`
  - `pub fn count_stream_http_calls_json(nodes: &serde_json::Value) -> usize`
  - `pub fn extract_stream_text(body: &str) -> String`
  - `pub fn filter_stream_response_headers<'a, I>(headers: I) -> Vec<(String, String)>` where `I` is iterator of `(&str, &str)`
  - `pub struct BodyBuffer { raw: Vec<u8>, truncated: bool }` with `pub fn new() -> Self`, `pub fn push(&mut self, bytes: &[u8])`, `pub fn body_string(&self) -> String`, `pub fn is_truncated(&self) -> bool`

- [ ] **Step 1: Write the failing tests**

Create `src/workflow_stream.rs` with the public signatures above as `todo!()` / empty stubs, plus `#[cfg(test)] mod tests` containing exactly:

```rust
use super::*;
use serde_json::json;

#[test]
fn stream_enabled_reads_bool() {
    assert!(!stream_enabled(&json!({})));
    assert!(stream_enabled(&json!({"stream": true})));
    assert!(!stream_enabled(&json!({"stream": false})));
}

#[test]
fn count_stream_http_calls_json_counts_only_stream_http() {
    let nodes = json!([
        {"id":"a","type":"http_call","config":{"url":"https://x","stream":true}},
        {"id":"b","type":"http_call","config":{"url":"https://y"}},
        {"id":"c","type":"response","config":{"stream":true}}
    ]);
    assert_eq!(count_stream_http_calls_json(&nodes), 1);
}

#[test]
fn extract_openai_delta_content() {
    let body = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n",
        "data: [DONE]\n\n"
    );
    assert_eq!(extract_stream_text(body), "Hello");
}

#[test]
fn extract_openai_choice_text() {
    let body = "data: {\"choices\":[{\"text\":\"Hi\"}]}\n\n";
    assert_eq!(extract_stream_text(body), "Hi");
}

#[test]
fn extract_claude_content_block_delta() {
    let body = concat!(
        "event: content_block_delta\n",
        "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Ab\"}}\n\n",
        "data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"c\"}}\n\n"
    );
    assert_eq!(extract_stream_text(body), "Abc");
}

#[test]
fn extract_unknown_protocol_is_empty() {
    assert_eq!(extract_stream_text("not-sse"), "");
}

#[test]
fn filter_keeps_whitelist_and_drops_set_cookie() {
    let out = filter_stream_response_headers([
        ("Content-Type", "text/event-stream"),
        ("Cache-Control", "no-cache"),
        ("Content-Disposition", "inline"),
        ("Set-Cookie", "a=b"),
        ("Transfer-Encoding", "chunked"),
        ("Content-Length", "12"),
        ("X-Request-Id", "secret"),
    ]);
    let names: Vec<_> = out.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(names, ["content-type", "cache-control", "content-disposition"]);
}

#[test]
fn body_buffer_truncates_at_8mib_but_remembers_flag() {
    let mut buf = BodyBuffer::new();
    buf.push(&vec![b'a'; BODY_LIMIT_BYTES]);
    buf.push(b"xyz");
    assert!(buf.is_truncated());
    assert_eq!(buf.body_string().len(), BODY_LIMIT_BYTES);
}

#[tokio::test]
async fn bridge_send_returns_false_after_rx_drop() {
    let (bridge, rx) = StreamBridge::pair();
    drop(rx);
    assert!(!bridge.commit(200, vec![]).await);
    assert!(!bridge.chunk(b"x".to_vec()).await);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p onebase --lib workflow_stream::tests -- --nocapture`

Expected: compile error or FAIL because functions are missing / `todo!()`.

- [ ] **Step 3: Implement the module**

`stream_enabled`: `config.get("stream").and_then(|v| v.as_bool()).unwrap_or(false)`.

`count_stream_http_calls_json`: iterate `nodes.as_array()`, count objects whose `type` is `"http_call"` and `stream_enabled(config)`.

`extract_stream_text`:

1. Walk lines. For each line, strip a leading `"data:"` plus optional one space; skip empty and `[DONE]`.
2. `serde_json::from_str` the rest. On parse failure, skip the line.
3. If `type == "content_block_delta"` and `delta.text` is a string, append it (Claude).
4. Else if `choices[0]` exists: append the first present string among `delta.content`, `delta.text`, `text` (OpenAI).
5. Return the concatenation. If nothing was appended, return `""`.

`filter_stream_response_headers`: lowercase names. Keep only `content-type`, `cache-control`, `content-disposition`. Always drop `set-cookie`, `transfer-encoding`, `content-length`, `connection`, `keep-alive`, `proxy-authenticate`, `te`, `trailer`, `upgrade` (even if someone later expands the whitelist). Emit kept names in lowercase.

`BodyBuffer::push`: if `truncated`, return. If `raw.len() + bytes.len() > BODY_LIMIT_BYTES`, extend with the prefix that fills the cap, set `truncated = true`. Else extend all. `body_string` is `String::from_utf8_lossy(&self.raw).into_owned()`.

`StreamBridge::pair`: `mpsc::channel(STREAM_CHANNEL_CAPACITY)`. `commit` / `chunk` / `end` use `self.tx.send(...).await.is_ok()`.

Do not implement “Commit only once” inside the bridge in this task; Task 3 can ignore a second Commit at the caller if needed. First Commit wins is enough: document that `http_call` sends Commit once.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p onebase --lib workflow_stream::tests -- --nocapture`

Expected: PASS (all tests in the module).

- [ ] **Step 5: Commit (skip unless the user asked)**

```bash
git add src/workflow_stream.rs src/lib.rs src/main.rs
git commit -m "feat(workflow): add StreamBridge and stream text extractors"
```

---

### Task 2: Definition validation

**Files:**
- Modify: `src/workflow_engine.rs` (`validate_definition` around line 5585; tests module around line 7620)
- Modify: `src/workflow_stream.rs` (add `count_stream_http_calls` if not done)

**Interfaces:**
- Consumes: `stream_enabled`, `parse_async_poll_config` from `crate::http_async_poll`
- Produces: `validate_definition` rejects `>1` streaming `http_call`, and rejects `stream && async_poll` on the same node. Error strings (copy verbatim):
  - `"工作流最多只能有一个 stream: true 的 http_call 节点"`
  - `"http_call 不能同时开启 stream 与 async_poll"`

- [ ] **Step 1: Write the failing tests**

Add at the end of `workflow_engine.rs` `#[cfg(test)] mod tests`:

```rust
fn http_node(id: &str, config: JsonValue) -> WorkflowNode {
    WorkflowNode {
        id: id.into(),
        node_type: NodeType::HttpCall,
        label: None,
        config,
    }
}

#[test]
fn validate_rejects_two_stream_http_calls() {
    let def = WorkflowDefinition {
        nodes: vec![
            http_node("a", json!({"url":"https://x","stream":true})),
            http_node("b", json!({"url":"https://y","stream":true})),
        ],
        edges: vec![],
    };
    let err = validate_definition(&def).unwrap_err().to_string();
    assert!(err.contains("最多只能有一个 stream"));
}

#[test]
fn validate_rejects_stream_plus_async_poll() {
    let def = WorkflowDefinition {
        nodes: vec![http_node(
            "a",
            json!({"url":"https://x","stream":true,"async_poll":true}),
        )],
        edges: vec![],
    };
    let err = validate_definition(&def).unwrap_err().to_string();
    assert!(err.contains("stream 与 async_poll"));
}

#[test]
fn validate_allows_single_stream_http_call() {
    let def = WorkflowDefinition {
        nodes: vec![http_node("a", json!({"url":"https://x","stream":true}))],
        edges: vec![],
    };
    assert!(validate_definition(&def).is_ok());
}
```

If `WorkflowNode` / `edges: vec![]` fails existing “至少需要一个节点” only, one node is enough. Isolated nodes with no edges are already accepted today (loop tests use edges). Confirm `validate_definition` does not require edges.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p onebase --lib workflow_engine::tests::validate_rejects_two_stream_http_calls workflow_engine::tests::validate_rejects_stream_plus_async_poll workflow_engine::tests::validate_allows_single_stream_http_call -- --nocapture`

Expected: FAIL (assertions / Ok when Err expected).

- [ ] **Step 3: Implement validation**

At the end of `validate_definition`, after `topological_sort(def)?` and before `Ok(())`:

```rust
let mut stream_http_calls = 0usize;
for node in &def.nodes {
    if node.node_type != NodeType::HttpCall {
        continue;
    }
    let streaming = crate::workflow_stream::stream_enabled(&node.config);
    if streaming {
        stream_http_calls += 1;
    }
    if streaming && crate::http_async_poll::parse_async_poll_config(&node.config).enabled {
        return Err(AppError::InvalidQuery(
            "http_call 不能同时开启 stream 与 async_poll".to_string(),
        ));
    }
}
if stream_http_calls > 1 {
    return Err(AppError::InvalidQuery(
        "工作流最多只能有一个 stream: true 的 http_call 节点".to_string(),
    ));
}
```

Do not reject `stream: true` on cron/hook/kafka workflows. Do not reject a `response` node next to a stream node.

- [ ] **Step 4: Run tests to verify they pass**

Run: the same three-test command as Step 2.

Expected: PASS.

Also run: `cargo test -p onebase --lib workflow_engine::tests::validate_ -- --nocapture`

Expected: existing validate tests still PASS.

- [ ] **Step 5: Commit (skip unless the user asked)**

```bash
git add src/workflow_engine.rs src/workflow_stream.rs
git commit -m "feat(workflow): reject multiple stream http_call and stream+async_poll"
```

---

### Task 3: Stream `http_call` execution

**Files:**
- Modify: `src/workflow_engine.rs` (`DagEngine` ~2364, dispatch ~2698, `exec_http_call_node` ~4281, `side_effect_mock` ~4651)
- Modify: `src/mcp_tools.rs` (`http_call` paragraph in the `node_spec` string ~line 108)

**Interfaces:**
- Consumes: `StreamBridge`, `stream_enabled`, `extract_stream_text`, `filter_stream_response_headers`, `BodyBuffer`, `BODY_LIMIT_BYTES`
- Produces:
  - `DagEngine { pool: PgPool, stream_bridge: Option<StreamBridge> }`
  - `DagEngine::new(pool)` sets `stream_bridge: None`
  - `DagEngine::with_stream_bridge(self, StreamBridge) -> Self`
  - `exec_http_call_node(&self, config: &JsonValue, ctx: &ExecutionContext)`
  - Stream success output keys: `status`, `headers`, `body` (string), `text` (string), `streamed` (true), optional `body_truncated` (true)
  - Writes to the bridge only when `self.stream_bridge.is_some() && ctx.trigger_type == "endpoint" && !ctx.dry_run`
  - Upstream HTTP 4xx/5xx is **node success** (Commit + pipe body). Connect/read errors are node failure.
  - Runtime `stream && async_poll`: `Err(AppError::InvalidQuery("http_call 不能同时开启 stream 与 async_poll".into()))`

- [ ] **Step 1: Write the failing tests**

Add in `workflow_engine.rs` tests (same local TcpListener style as `exec_http_call_runs_async_poll_when_enabled`):

```rust
fn lazy_pool() -> sqlx::PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://localhost/onebase")
        .unwrap()
}

fn dummy_ctx(trigger_type: &str) -> ExecutionContext {
    ExecutionContext {
        workflow_id: 1,
        run_id: 1,
        trigger_type: trigger_type.into(),
        trigger_data: json!({}),
        user_id: None,
        tenant_id: None,
        database_id: None,
        node_outputs: HashMap::new(),
        env_vars: HashMap::new(),
        workflow_dependencies: json!({}),
        dry_run: false,
        prod_readonly: false,
        apikey_write_guard: ApiKeyWriteGuard::Off,
    }
}

#[tokio::test]
async fn stream_http_call_pipes_bytes_and_extracts_openai_text() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("[::1]:0").await.unwrap();
    let url = format!("http://[::1]:{}", listener.local_addr().unwrap().port());
    let sse = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n",
        "data: [DONE]\n\n"
    );
    let sse_len = sse.len();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = [0_u8; 1024];
        let _ = sock.read(&mut buf).await;
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {sse_len}\r\nSet-Cookie: x=1\r\nConnection: close\r\n\r\n"
        );
        sock.write_all(head.as_bytes()).await.unwrap();
        sock.write_all(sse.as_bytes()).await.unwrap();
    });

    let (bridge, mut rx) = crate::workflow_stream::StreamBridge::pair();
    let engine = DagEngine::new(lazy_pool()).with_stream_bridge(bridge);
    let (output, _) = engine
        .exec_http_call_node(
            &json!({"url": url, "stream": true}),
            &dummy_ctx("endpoint"),
        )
        .await
        .unwrap();

    assert_eq!(output["status"], 200);
    assert_eq!(output["text"], "Hi");
    assert_eq!(output["streamed"], true);
    assert_eq!(output["body"].as_str().unwrap(), sse);

    match rx.recv().await {
        Some(crate::workflow_stream::StreamEvent::Commit { status, headers }) => {
            assert_eq!(status, 200);
            assert!(headers.iter().any(|(k, v)| k == "content-type" && v.starts_with("text/event-stream")));
            assert!(!headers.iter().any(|(k, _)| k == "set-cookie"));
        }
        other => panic!("expected Commit, got {other:?}"),
    }
    let mut piped = Vec::new();
    while let Some(ev) = rx.recv().await {
        match ev {
            crate::workflow_stream::StreamEvent::Chunk(b) => piped.extend_from_slice(&b),
            crate::workflow_stream::StreamEvent::End => break,
            crate::workflow_stream::StreamEvent::Commit { .. } => {}
        }
    }
    assert_eq!(piped, sse.as_bytes());
}

#[tokio::test]
async fn stream_http_call_does_not_commit_for_subworkflow_trigger() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("[::1]:0").await.unwrap();
    let url = format!("http://[::1]:{}", listener.local_addr().unwrap().port());
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = [0_u8; 1024];
        let _ = sock.read(&mut buf).await;
        sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK")
            .await
            .unwrap();
    });

    let (bridge, mut rx) = crate::workflow_stream::StreamBridge::pair();
    let engine = DagEngine::new(lazy_pool()).with_stream_bridge(bridge);
    let (output, _) = engine
        .exec_http_call_node(
            &json!({"url": url, "stream": true}),
            &dummy_ctx("subworkflow"),
        )
        .await
        .unwrap();
    assert_eq!(output["body"], "OK");
    assert!(rx.try_recv().is_err(), "child/subworkflow must not Commit");
}

#[tokio::test]
async fn stream_plus_async_poll_is_runtime_error() {
    let engine = DagEngine::new(lazy_pool());
    let err = engine
        .exec_http_call_node(
            &json!({"url":"https://example.com","stream":true,"async_poll":true}),
            &dummy_ctx("endpoint"),
        )
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("stream 与 async_poll"));
}
```

`dummy_ctx` must match the current `ExecutionContext` fields exactly. If a field was added after this plan was written, include it. Do not add `stream_bridge` to `ExecutionContext`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p onebase --lib workflow_engine::tests::stream_http_call_pipes_bytes_and_extracts_openai_text workflow_engine::tests::stream_http_call_does_not_commit_for_subworkflow_trigger workflow_engine::tests::stream_plus_async_poll_is_runtime_error -- --nocapture`

Expected: compile error (`with_stream_bridge` / extra `ctx` arg missing) or FAIL.

- [ ] **Step 3: Implement**

1. `DagEngine` gains `stream_bridge: Option<StreamBridge>`. `new` sets `None`. Add:

```rust
pub fn with_stream_bridge(mut self, bridge: crate::workflow_stream::StreamBridge) -> Self {
    self.stream_bridge = Some(bridge);
    self
}
```

2. Change dispatch to `NodeType::HttpCall => self.exec_http_call_node(config, ctx).await`.

3. Change `exec_http_call_node` signature to take `ctx: &ExecutionContext`. Update the existing `exec_http_call_runs_async_poll_when_enabled` call to pass `&dummy_ctx("endpoint")` (or a local `ExecutionContext`).

4. After URL/private/timeout/headers/body parsing, if `stream_enabled(config)`:
   - If `parse_async_poll_config(config).enabled` → return the InvalidQuery error above.
   - Build the same `reqwest::Client` (connect timeout 30s).
   - `send()` the request (same method/url/headers/json body as the non-stream path).
   - On send error → `AppError::Internal(format!("HTTP 请求失败: {}", e))` (no Commit).
   - Read `status` and header pairs from the response. `filter_stream_response_headers` on `(k.as_str(), v.to_str().unwrap_or(""))`.
   - If `self.stream_bridge.as_ref()` is Some **and** `ctx.trigger_type == "endpoint"`: `commit(status, filtered_headers).await`.
   - `let mut stream = resp.bytes_stream();` `let mut buf = BodyBuffer::new();`
   - `while let Some(item) = stream.next().await` (import `futures::StreamExt`):
     - `let bytes = item.map_err(|e| AppError::Internal(format!("读取响应失败: {}", e)))?;`
     - if endpoint bridge present: `chunk(bytes.to_vec()).await;` (ignore false)
     - `buf.push(&bytes);`
   - If endpoint bridge present: `end().await;`
   - Wrap the read loop in the same `tokio::time::timeout` used today when `timeout_secs > 0`.
   - Return

```rust
let mut output = json!({
    "status": status,
    "headers": resp_headers, // all decoded upstream headers, same as non-stream
    "body": buf.body_string(),
    "text": crate::workflow_stream::extract_stream_text(&buf.body_string()),
    "streamed": true,
});
if buf.is_truncated() {
    output["body_truncated"] = json!(true);
}
Ok((output, None))
```

   - Do not run `async_poll` after a stream.

5. Non-stream path: unchanged, including `async_poll`.

6. dry_run: still hits `side_effect_mock` before dispatch; do not change mock shape.

7. In `src/mcp_tools.rs` replace the `http_call` bullet with:

```
### http_call（外部 HTTP）
config: `{ "method": "GET|POST|PUT|PATCH|DELETE", "url": "https://...", "headers": {对象}, "body": 任意, "stream": 可选布尔, "async_poll": 可选布尔 }`
- 禁止内网地址；超时由 timeout_secs / 默认 120s / 工作流 timeout_ms 兜底
- 默认输出 `{ "status", "headers", "body" }`
- `stream: true`：按上游字节流读取。endpoint 触发时把上游 status + Content-Type/Cache-Control/Content-Disposition 原样写入本次 HTTP 响应（其余头丢弃），调用方收到的 body 与上游一致。节点同时输出 `{ status, headers, body, text, streamed: true }`：`body` 为上游原文（UTF-8 有损，上限 8MiB，超出加 body_truncated），`text` 仅从 OpenAI 兼容 SSE（choices[0].delta.content|delta.text|text）和 Claude content_block_delta.delta.text 抽取，认不出则为空串。全图最多一个 stream http_call；不可与 async_poll 同开。上游流结束后才跑下游；调用方断开不停工作流。非 endpoint / 子工作流只缓冲+抽文本，不占用父 HTTP。
```

- [ ] **Step 4: Run tests to verify they pass**

Run: the three stream tests from Step 2, plus `cargo test -p onebase --lib workflow_engine::tests::exec_http_call_runs_async_poll_when_enabled -- --nocapture`

Expected: PASS.

- [ ] **Step 5: Commit (skip unless the user asked)**

```bash
git add src/workflow_engine.rs src/mcp_tools.rs
git commit -m "feat(workflow): stream http_call bytes to StreamBridge and extract text"
```

---

### Task 4: Endpoint handler late-commit

**Files:**
- Modify: `src/workflow_handlers.rs` (`execute_workflow_internal` ~3813, `run_workflow_detached` ~3468, `endpoint_trigger` ~3594, `endpoint_trigger_get` ~3657, `endpoint_trigger_public` ~3703, tests module ~4914)
- Modify: `src/mcp_tools.rs` (`tool_workflow_api_doc` ~672)

**Interfaces:**
- Consumes: `StreamBridge::pair`, `StreamEvent`, `count_stream_http_calls_json`
- Produces:
  - `pub async fn execute_workflow_with_bridge(..., stream_bridge: Option<StreamBridge>) -> Result<Vec<NodeExecutionResult>>`
  - `execute_workflow_internal(...)` becomes a wrapper that calls `execute_workflow_with_bridge(..., None)` so cron/hook/kafka/notify/manual stay unchanged
  - `async fn wait_stream_or_complete(mut rx, handle) -> StreamOrJson` where

```rust
enum StreamOrJson {
    Stream {
        status: u16,
        headers: Vec<(String, String)>,
        rx: tokio::sync::mpsc::Receiver<StreamEvent>,
    },
    Json(Result<Vec<NodeExecutionResult>>),
}
```

  - Streaming HTTP: status from Commit (invalid → 200); headers from Commit; body = remaining `Chunk`s until `End` or channel close. Do **not** wait for the JoinHandle before returning the response.
  - Never-Commit + join finished → `finalize_endpoint_response`.
  - Client cancel while writing chunks: stop writing; do not abort the JoinHandle.
  - `workflow_api_doc` adds `stream: true` and a Chinese note when the definition has a stream `http_call`.

- [ ] **Step 1: Write the failing tests**

Add in `workflow_handlers.rs` tests (same module as `finalize_endpoint_response` tests):

```rust
#[tokio::test]
async fn wait_stream_or_complete_prefers_commit() {
    let (bridge, rx) = crate::workflow_stream::StreamBridge::pair();
    let handle = tokio::spawn(async move {
        bridge
            .commit(201, vec![("content-type".into(), "text/event-stream".into())])
            .await;
        bridge.chunk(b"abc".to_vec()).await;
        bridge.end().await;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        Ok::<Vec<NodeExecutionResult>, AppError>(vec![])
    });
    match wait_stream_or_complete(rx, handle).await {
        StreamOrJson::Stream { status, headers, mut rx } => {
            assert_eq!(status, 201);
            assert_eq!(headers[0].0, "content-type");
            assert!(matches!(rx.recv().await, Some(crate::workflow_stream::StreamEvent::Chunk(_))));
        }
        StreamOrJson::Json(_) => panic!("expected stream"),
    }
}

#[tokio::test]
async fn wait_stream_or_complete_falls_back_when_no_commit() {
    let (_bridge, rx) = crate::workflow_stream::StreamBridge::pair();
    let handle = tokio::spawn(async {
        Ok::<Vec<NodeExecutionResult>, AppError>(vec![success_response(json!({
            "status_code": 200,
            "body": { "ok": true }
        }))])
    });
    match wait_stream_or_complete(rx, handle).await {
        StreamOrJson::Json(Ok(results)) => {
            assert_eq!(results[0].output["body"]["ok"], true);
        }
        other => panic!("expected json, got fallback mismatch: {other:?}"),
    }
}
```

`StreamOrJson` should `#[allow(dead_code)]` derive Debug for the panic message, or match without debug. If `NodeExecutionResult` construction via `success_response` already exists in this test module, reuse it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --bin onebase wait_stream_or_complete_prefers_commit wait_stream_or_complete_falls_back_when_no_commit -- --nocapture`

Expected: compile error (`wait_stream_or_complete` missing).

- [ ] **Step 3: Implement handler + wrapper**

1. Rename the body of `execute_workflow_internal` to `execute_workflow_with_bridge` adding `stream_bridge: Option<StreamBridge>`. After `let engine = DagEngine::new(pool.clone());` apply:

```rust
let engine = match stream_bridge {
    Some(bridge) => engine.with_stream_bridge(bridge),
    None => engine,
};
```

`execute_workflow_internal` calls `execute_workflow_with_bridge(..., None).await`. Keep the public signature used by cron/hook/kafka/notify/manual/debug-adjacent callers unchanged.

2. Implement `wait_stream_or_complete`:

```rust
async fn wait_stream_or_complete(
    mut rx: tokio::sync::mpsc::Receiver<crate::workflow_stream::StreamEvent>,
    mut handle: tokio::task::JoinHandle<Result<Vec<NodeExecutionResult>>>,
) -> StreamOrJson {
    tokio::select! {
        ev = rx.recv() => match ev {
            Some(crate::workflow_stream::StreamEvent::Commit { status, headers }) => {
                StreamOrJson::Stream { status, headers, rx }
            }
            Some(_) | None => {
                let result = match handle.await {
                    Ok(r) => r,
                    Err(e) => Err(AppError::Internal(format!("工作流执行任务异常终止: {}", e))),
                };
                StreamOrJson::Json(result)
            }
        },
        join = &mut handle => {
            let result = match join {
                Ok(r) => r,
                Err(e) => Err(AppError::Internal(format!("工作流执行任务异常终止: {}", e))),
            };
            StreamOrJson::Json(result)
        }
    }
}
```

3. `fn stream_response(status: u16, headers: Vec<(String, String)>, mut rx: Receiver<StreamEvent>) -> Response`:

```rust
let status = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
let body = Body::from_stream(async_stream::stream! {
    while let Some(ev) = rx.recv().await {
        match ev {
            crate::workflow_stream::StreamEvent::Chunk(bytes) => {
                yield Ok::<_, std::io::Error>(bytes::Bytes::from(bytes));
            }
            crate::workflow_stream::StreamEvent::End => break,
            crate::workflow_stream::StreamEvent::Commit { .. } => {}
        }
    }
});
```

If `async-stream` is not in `Cargo.toml`, do **not** add it. Use `futures::stream::unfold` instead:

```rust
let stream = futures::stream::unfold(rx, |mut rx| async move {
    match rx.recv().await {
        Some(crate::workflow_stream::StreamEvent::Chunk(bytes)) => {
            Some((Ok::<_, std::io::Error>(axum::body::Bytes::from(bytes)), rx))
        }
        Some(crate::workflow_stream::StreamEvent::End) | None => None,
        Some(crate::workflow_stream::StreamEvent::Commit { .. }) => {
            Some((Ok(axum::body::Bytes::new()), rx))
        }
    }
});
let mut response = axum::http::Response::new(Body::from_stream(stream));
*response.status_mut() = status;
for (k, v) in headers {
    if let (Ok(name), Ok(val)) = (
        axum::http::header::HeaderName::from_bytes(k.as_bytes()),
        axum::http::header::HeaderValue::from_str(&v),
    ) {
        response.headers_mut().insert(name, val);
    }
}
response
```

Prefer `axum::body::Bytes` so you do not add a direct `bytes` crate dependency.

4. New `async fn run_endpoint_maybe_stream(...)` used by GET/POST/`/pub`:

- If `count_stream_http_calls_json(&workflow.nodes) == 0`: keep `run_workflow_detached` + `finalize_endpoint_response`.
- Else: `let (bridge, rx) = StreamBridge::pair();` spawn `execute_workflow_with_bridge(..., Some(bridge))` (same detach / CancelProbe as `run_workflow_detached` — copy that function and pass the bridge through, or add an optional `stream_bridge` argument to `run_workflow_detached` defaulting to `None`).
- `match wait_stream_or_complete(rx, handle).await`:
  - `Stream` → `Ok(stream_response(...))` (do not join the handle).
  - `Json(result)` → `finalize_endpoint_response(&workflow, result)`.

Keep CancelProbe: if the handler drops after Commit while the body stream is still being consumed, that is normal; do not abort the workflow. If you attach CancelProbe to the handler future, mark it `done` once `wait_stream_or_complete` returns (stream committed or json finished). The streaming `Body` must not hold CancelProbe.

5. `tool_workflow_api_doc`: after building `note` / `curl`, if `count_stream_http_calls_json(workflow.get("nodes").unwrap_or(&Value::Null)) > 0`, set

```rust
let stream_note = "本工作流含 stream: true 的 http_call：成功时 HTTP 响应是上游字节流（通常 text/event-stream），不是 JSON。请按上游 Content-Type 解析；curl 加 --no-buffer 以便边收边看。";
```

Return extra fields `"stream": true` and append `stream_note` to `note` (newline-separated). Leave curl URL unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```
cargo test --bin onebase wait_stream_or_complete_prefers_commit wait_stream_or_complete_falls_back_when_no_commit json_response_keeps_body_and_applies_status_and_headers graceful_error_still_returns_json -- --nocapture
```

Expected: PASS.

- [ ] **Step 5: Commit (skip unless the user asked)**

```bash
git add src/workflow_handlers.rs src/mcp_tools.rs
git commit -m "feat(workflow): late-commit endpoint HTTP when http_call streams"
```

---

### Task 5: Frontend stream checkbox

**Files:**
- Modify: `frontend-nextjs/components/workflow/NodeConfigPanel.tsx` (http_call block ~697–748)

**Interfaces:**
- Consumes: `node.config.stream`, `updateConfig`
- Produces: checkbox that writes `config.stream` boolean; when `true`, force `async_poll` off and do not render the poll interval/max fields.

There is no frontend unit-test runner for this panel. Verification is compile + grep.

- [ ] **Step 1: Add the checkbox above the async_poll label**

Insert:

```tsx
<label className="flex items-start gap-2 cursor-pointer">
  <input
    type="checkbox"
    className="mt-0.5"
    checked={!!node.config.stream}
    disabled={readOnly}
    onChange={e => {
      const on = e.target.checked
      updateConfig('stream', on)
      if (on) updateConfig('async_poll', false)
    }}
  />
  <span>
    <span className="block text-sm font-medium text-gray-700">流式输出</span>
    <span className="block text-xs text-gray-400 mt-0.5">
      把上游 HTTP 响应当成这次工作流请求的响应流（适合 LLM）。全图只能有一个。不可与异步轮询同时开。
    </span>
  </span>
</label>
```

Change the async_poll block to `{!node.config.stream && ( <> ... existing async_poll checkbox and poll fields ... </> )}`.

Do not change other node types.

- [ ] **Step 2: Verify the wiring**

Run: `rg -n "流式输出" frontend-nextjs/components/workflow/NodeConfigPanel.tsx`

Expected: the new label is present.

Run: `rg -n "async_poll" frontend-nextjs/components/workflow/NodeConfigPanel.tsx`

Expected: the checkbox sits inside `!node.config.stream`.

If the frontend typecheck script exists (`cd frontend-nextjs && npx tsc --noEmit`), run it. Expected: no new errors in `NodeConfigPanel.tsx`.

- [ ] **Step 3: Commit (skip unless the user asked)**

```bash
git add frontend-nextjs/components/workflow/NodeConfigPanel.tsx
git commit -m "feat(workflow): add http_call stream checkbox"
```

---

## Self-review (spec coverage)

| Spec section | Task |
|---|---|
| StreamBridge + late-commit | 1, 4 |
| Opt-in `http_call.stream`, max one, mutex with `async_poll` | 2, 3, 5 |
| Raw upstream passthrough + header whitelist | 1, 3, 4 |
| Buffer 8 MiB + `text` extractors | 1, 3 |
| Continue DAG after stream; HTTP ends on upstream End | 3, 4 |
| Client disconnect: stop write, keep running | 4 (detach + ignore failed `send`) |
| Pre-commit errors stay JSON | 4 (`StreamOrJson::Json`) |
| Skip stream node → JSON | 4 (`wait_stream_or_complete` join-first) |
| `call_workflow` / non-endpoint do not take HTTP | 3 (`trigger_type == "endpoint"`) |
| dry_run mock, no HTTP stream | 3 (existing `side_effect_mock`) |
| `response` after Commit ignored | 4 (return stream body, never `finalize` after Commit) |
| `/pub/workflow` POST included; no extra URL | 4 |
| `node_spec` + `workflow_api_doc` | 3, 4 |
| Frontend checkbox | 5 |
| Code yield / stop API / OneBase envelope | out of scope |

No TBD/TODO placeholders. Names (`StreamBridge`, `wait_stream_or_complete`, `execute_workflow_with_bridge`, `BODY_LIMIT_BYTES`) are consistent across tasks.
