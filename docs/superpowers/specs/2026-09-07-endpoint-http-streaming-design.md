# Endpoint 同连接 HTTP 流式输出 — 设计文档

- 日期：2026-09-07
- 状态：待评审
- 范围：`endpoint` 工作流在同一次 `GET/POST /workflow/{db}/{slug}`（及 `/pub/workflow/...`）上把上游 HTTP 流原样转给调用方；引擎同时缓冲全文并抽出纯文本，供下游节点落库。
- 相关代码：
  - `src/workflow_handlers.rs`（`endpoint_trigger` / `finalize_endpoint_response` / `run_workflow_detached`）
  - `src/workflow_engine.rs`（`exec_http_call_node` / `validate_definition` / `exec_response_node`）
  - `src/mcp_tools.rs`（`node_spec`）
  - `frontend-nextjs/components/workflow/NodeConfigPanel.tsx`
- 关联：`2026-06-01-sse-capability-design.md`（已有 topic 订阅，本期不复用）、`docs/superpowers/plans/2026-07-21-http-call-async-poll.md`（与 `stream` 互斥）

## 1. 背景与目标

项目应用需要 LLM「打字机」：调一次工作流，同一条 HTTP 连接上边生成边显示，并在同一张图里把完整回复落库。

现状：

- `endpoint` 整图跑完才 `finalize_endpoint_response`，`response` 输出一整段 body。
- `http_call` 把上游 `text()` 读完再交给下游。
- 执行已 `detach`：调用方断开也不停工作流。
- 另有 `sse_publish` + `GET /events/{slug}`，是解耦订阅，不是这次请求上的流。

**目标（第一期）**

1. `http_call` 可标 `stream: true`：上游字节原样写入这次 endpoint HTTP 响应。
2. 引擎边推边拼 `body`，并抽出 `text` 给下游（写库 / 通知）。
3. 上游流结束即关掉这次 HTTP body；下游继续跑，调用方不等落库。
4. 调用方中途断开：停写 HTTP，工作流和上游照常跑完。
5. 没有 `stream: true` 的图行为为零变化。

### 已确认需求

| 项 | 结论 |
|---|---|
| 范围顺序 | 先做同连接流式（B）；订阅式 SSE（A）已存在，本期不改 |
| 流来源 | 只透传上游 HTTP；code 节点 yield 预留接口、不实现 |
| 流结束后 | 边推边拼，继续下游；下游拿到全文 |
| 调用方断开 | 停写，工作流跑完（与现 detach 一致） |
| 线上字节 | 原样透传上游，不套 OneBase SSE 信封 |
| 声明方式 | `http_call.config.stream === true`；全图最多一个 |
| 下游输出 | `body`（原文）+ `text`（抽出的纯文本） |

### 非目标（第一期）

- code / Lua / JS / Python 往这次连接 yield。
- OneBase 统一 `event: delta | done | error` 信封。
- 调用方「停止生成」API。
- 一张图多个流式出口。
- `stream` 与 `async_poll` 组合。
- 经 `call_workflow` 把子流接到父 HTTP。
- 复用 `SseHub` / Redis 扇出这条流。
- 真连 OpenAI / Claude 的集成测试。

## 2. 关键决定

| 项 | 结论 | 理由 |
|---|---|---|
| 实现路径 | StreamBridge（进程内通道）+ 晚提交 HTTP | 透传不经过 SseHub；旧 JSON 路径不动 |
| 提交时机 | 流式 `http_call` 拿到上游 status/headers 之后 | 才能原样传 Content-Type / status |
| HTTP 结束时机 | 上游 body 读完（或流中失败/超时） | 调用方不等下游落库 |
| 跳过流式节点 | 从未 Commit → 仍走现有 JSON | condition 走另一支时行为不变 |
| 透传头 | 白名单：`Content-Type`、`Cache-Control`、`Content-Disposition` | 任意上游，避免 `Set-Cookie` 等泄漏 |
| 必剥头 | `transfer-encoding`、`content-length`、hop-by-hop、`Set-Cookie` | 与 ES 流式代理相同：长度未知，axum 自己分块 |
| `text` 协议 | OpenAI 兼容 SSE + Claude `content_block_delta` | 覆盖项目应用主力；认不出则 `text=""` |
| `body` 上限 | **8 MiB**（`8 * 1024 * 1024`） | 防超长流打满内存；HTTP 侧该写仍写完 |
| 整图 `timeout_ms` 在流中 | 整图失败，下游不跑，部分缓冲不传下游 | 与现有工作流超时一致 |
| 节点 `timeout_secs` 在流中 | 该节点 Failed；无 `allow_failure` 则停图 | 与现有 `http_call` 超时一致 |
| 非 endpoint | `stream: true` 可保存；只缓冲+抽文本，不推 HTTP | cron/hook/kafka 没有调用方连接 |
| `response` 节点 | 允许存在；Commit 之后不再改这次 HTTP | 只进执行记录 |

## 3. 架构

```
项目应用
  GET|POST /workflow/{db}/{slug}
  POST     /pub/workflow/{db}/{slug}
        │
        ▼
endpoint handler
  定义中 0 个 stream http_call → 现状：detach + 整图结束再 JSON
  定义中 1 个 stream http_call → 启动工作流 + StreamBridge
        │
        ├─ 预节点（查库 / 拼 prompt / 取 key）
        │     HTTP 未提交；失败 → finalize_endpoint_response
        │
        ▼
  http_call stream=true
        │  上游连上
        ├─ Bridge.Commit(status, headers)
        ├─ 读上游 body → Bridge.Chunk(bytes) + 内存缓冲
        ├─ 调用方断开 → 停写，继续读上游
        └─ 上游结束 → Bridge.End → 关掉这次 HTTP body
        │
        ▼
  节点输出 { status, headers, body, text, streamed }
        │
        ▼
  下游（写库 / 通知 / 可选 response）
        只写执行历史；不再改这次 HTTP
```

`StreamBridge` 只活在本请求进程内，不进 Redis、不进 `SseHub`。预留给以后 yield 的写入口也是它；第一期只有 `http_call` 调用。

## 4. 组件

### 4.1 `StreamEvent` / `StreamBridge`

新建 `src/workflow_stream.rs`，不把通道细节摊进 `workflow_engine.rs`。

```rust
enum StreamEvent {
    Commit { status: u16, headers: HeaderMap },
    Chunk(Bytes),
    End,
}

struct StreamBridge {
    tx: mpsc::Sender<StreamEvent>,
}
```

- `Commit` 整次执行最多一次。第二次 Commit 忽略并打 error 日志。
- Handler 持 `mpsc::Receiver`。通道容量 **32** 个事件；`http_call` 用 `send().await`，调用方慢时对上游形成反压，不在引擎里无限排队。
- 调用方断开后 handler 丢弃 receiver。此后 `send` 失败视为「无人听」，`http_call` **继续读上游并缓冲**，不再往 Bridge 写。
- 工作流不是 endpoint、或 dry_run、或没有注入 Bridge：`http_call` 仍按流式读+缓冲+抽文本，Commit/Chunk 全部 noop。

`StreamBridge` 即以后 yield 要用的写入口。第一期不在 code 节点暴露它。

### 4.2 Handler 分支

`endpoint_trigger` / `endpoint_trigger_get` / 公开 `/pub/workflow` 共用同一条逻辑。

1. 扫描定义：`http_call` 且 `config.stream == true` 的节点数。
2. `0` → 现有 `run_workflow_detached` + `finalize_endpoint_response`。
3. `1` → `tokio::spawn` 执行（断开仍不 cancel，保持 detach），把 `StreamBridge` 放进执行上下文。
4. Handler `select`：
   - 先收到 `Commit` → 按 §5 提交 HTTP，然后把后续 `Chunk` 写成 body；`End` 或 tx 关闭则结束 body。**不要**再等整图结束才返回。
   - 先整图结束且从未 `Commit` → `finalize_endpoint_response`（失败、或 condition 跳过了流式节点）。
5. 写 body 时若请求已取消：停写，不要 `abort` spawn 的工作流。

全局 `TimeoutLayer` 本来就不挂在 workflow 路由上，流式路径保持如此。

### 4.3 `exec_http_call_node` 流式分支

当 `config.stream == true`：

- 禁止走 `async_poll`（保存期已拦；运行时若撞上也当配置错误失败）。
- `reqwest` 使用 `send()` 后 **不要** `text()` / `bytes()`；对 `bytes_stream()` 逐块读。
- `send()` 成功拿到 status/headers 后立即 `Commit`（不等第一块 body），再读流。
- 上游 4xx/5xx 仍算节点成功：照样 Commit 并透传错误 body（调用方看到的与直连上游一致）。连不上 / 读中断才是节点失败。
- 每一块：写入 Bridge（若仍有听众）、追加到缓冲（见 §6）。
- 读完发 `End`。
- 组装节点输出（§6），返回给 DAG。

`timeout_secs == 0` 时仍由 `workflow.timeout_ms` 兜底整图。`timeout_secs > 0` 包住「从发请求到上游读完」整段流式读取。

非流式 `http_call` 一行不改。

### 4.4 校验

`validate_definition` 增加：

- `stream: true` 的 `http_call` 不得多于一个。
- 同一节点 `stream: true` 且 `async_poll` 开启 → 拒绝。

不禁止非 endpoint 上的 `stream: true`。不禁止图里同时有 `response` 节点。

### 4.5 前端

`http_call` 配置增加「流式输出」开关，写入 `config.stream`。

- 打开时禁用 / 隐藏 `async_poll`（与保存校验一致）。
- 保存失败时展示引擎返回的校验文案（第二个流式节点、与 poll 冲突）。

不在画布上另做实时预览流。

### 4.6 文档

`node_spec` / MCP 规范补上 `http_call.stream`、互斥、输出字段、`text` 协议范围。`workflow_api_doc` 对含流式节点的 endpoint 注明：成功时响应是上游流，不是 JSON；调用方按上游 `Content-Type` 解析。

## 5. 对外 HTTP 契约

**URL / 鉴权 / 入参**：与现有 endpoint 完全相同。不新开路径，不要求特殊 `Accept`。

**Commit 之后**

- status = 上游 status（非法值回退 200）。
- headers = 白名单 ∩ 上游头，再去掉必剥头。
- body = 上游字节原样。OneBase 不插入 SSE 行、不补 `[DONE]`、不写 `event: error`。

**Commit 之前的失败**

- 与现在相同：默认 5xx；`graceful_error_response` → HTTP 200 + `{ok:false, error, failed_node?}`；只读 API Key 写拦截 → 403。

**Commit 之后的失败**

- 不再改 status，不再补 JSON。停写并关 body。细节进执行历史。

**`response` 节点**

- Commit 之后：忽略其对 HTTP 的 `status_code` / `headers` / `body`。
- 从未 Commit：现有逻辑，仍可由 `response` 收口。

## 6. 节点输出

流式 `http_call` 成功时：

```json
{
  "status": 200,
  "headers": { "content-type": "text/event-stream" },
  "body": "<上游原始字节，UTF-8 有损解码后的字符串>",
  "text": "抽出的纯文本",
  "streamed": true
}
```

缓冲规则：

- 上限 **8 MiB**。超出后：HTTP 该写继续写；缓冲停止追加；输出加 `"body_truncated": true`；`text` 只基于已缓冲部分。
- `body` 给还要自己解析的下游；`text` 给「存消息」直接用。

`text` 抽取（只认下列两种；都认不出则为 `""`）：

1. **OpenAI 兼容 SSE**：按行扫描 `data:` 前缀；忽略 `data: [DONE]`；JSON 里依次取 `choices[0].delta.content`、`choices[0].delta.text`、`choices[0].text`，只拼接字符串值。
2. **Claude SSE**：`data:` JSON 且 `type == "content_block_delta"`，拼接 `delta.text` 字符串。

不解析 Gemini、不解析 OpenAI Responses 其它形状。作者要那些协议时用 `body` 自己抽。

失败时（连不上、读中途断、节点 `timeout_secs`）：

- 节点 `Failed`（或 `allow_failure` → `FailedAllowed`）。
- 默认 **不跑后续节点**（与现引擎一致）。
- `allow_failure: true` 时：把已有的部分 `body`/`text`、`streamed: true`、`body_truncated`（若有）和错误信息交给下游。

整图 `timeout_ms` 在流中触发：整图失败、下游不跑、已写出的 HTTP chunk 不回收。部分缓冲 **不** 传给下游；`allow_failure` 也不能让下游继续。

## 7. 错误处理

| 时机 | HTTP | 工作流 |
|---|---|---|
| 预节点失败 / 流式节点连不上 / Commit 前超时 | JSON 错误（§5） | 现有收口 |
| 上游读中途失败 | 停写、关 body | 该节点 Failed；无 `allow_failure` 则停图 |
| 流中节点 `timeout_secs` | 停写、关 body | 该节点 Failed；无 `allow_failure` 则停图 |
| 流中整图 `timeout_ms` | 停写、关 body | 整图失败，下游不跑，部分缓冲不传下游 |
| 下游落库失败 | 已关掉，不回写 | 只记执行历史 / 现有告警 |
| 调用方断开 | 停写 | 继续读上游、拼全文、跑下游 |
| dry_run / `debug_workflow` | 无 HTTP 流 | 流式 `http_call` 走现有副作用 mock，输出 JSON |

保存期：多于一个 `stream: true`、或与 `async_poll` 同开，拒绝保存。

## 8. `call_workflow` 与其它触发

- 子工作流里的 `stream: true`：只缓冲+抽文本，**不**占用父请求 HTTP。
- 父图自己的流式 `http_call` 仍按 §4 接到父 HTTP。
- `cron` / `hook` / `notify` / `kafka` / `manual`：有 `stream: true` 时与「无 Bridge」相同，只缓冲+抽文本。

## 9. 测试

### 引擎 / handler

本地假上游吐 SSE。不真连模型。

- 无 `stream` 的 endpoint：响应仍是整段 JSON（回归）。
- 预节点失败：JSON 错误，未提交流。
- 快乐路径：调用方收到的字节与上游一致；OpenAI / Claude 样例的 `text` 抽对；`body` 为原文。
- condition 跳过流式节点：回落 JSON `response`。
- 调用方中途断开：handler 返回后工作流仍跑完，下游看到完整 `text`。
- 超过 8 MiB：`body_truncated: true`；HTTP 侧仍写完上游。
- 保存：两个 `stream: true` 失败；`stream` + `async_poll` 失败。
- dry_run：不访问上游，无 HTTP 流。
- 非 endpoint 执行带 `stream: true`：节点有 `text`/`body`，无 HTTP 副作用。

### 前端

- 打开「流式输出」时禁用 `async_poll`。
- 第二个流式节点在保存时能看到校验错误。

### 不测

- 真 OpenAI / Claude。
- 多实例 / Redis（Bridge 只在本请求内）。
- code yield。

## 10. 以后（不在本期实现）

- code 节点通过同一 `StreamBridge` yield（先 Commit 再 Chunk）。
- 调用方显式取消，从而中止上游。
- 统一 OneBase SSE 信封（若项目应用不想绑模型厂商协议）。
- 同一份 `text` 额外 `sse_publish` 到 `/events/{slug}`（A 与 B 汇合）。
