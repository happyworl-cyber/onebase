# access log 写入 JSON 请求体 — 设计文档

- 日期：2026-09-17
- 状态：已通过
- 范围：POST/PUT/PATCH 的 JSON body 脱敏截断后写入 `access_log.request_body`，云日志按关键词能搜到业务 uid。
- 相关代码：
  - `src/request_id.rs`（`request_id_middleware`、`emit_access_log`）
  - `src/logging.rs`（结构化字段平铺到 JSON 根）
  - `frontend-nextjs/app/workspace/[projectId]/cloud-logs/page.tsx`（本期不改）
  - `src/cloud_log.rs`（短语检索已存在，本期不改）
- 关联：
  - `docs/superpowers/specs/2026-09-11-project-cloud-logs-design.md`
  - `docs/superpowers/specs/2026-09-16-runs-list-and-cloud-log-keyword-design.md`

## 1. 背景

工作流 HTTP 触发的业务 id（如 body 里的 `uids: ["15107269003108"]`）只存在 `workflow_runs.trigger_data`，执行记录弹层能看见。云日志查的是 SLS；现有 `access_log` 只记 `method` / `path` / `status` / `elapsed_ms` / `user_id` / `x_request_id`，不记请求体。关键词搜 uid 必然 0 命中。

已确认：要的是 SLS 里这次请求的 access 行，不是改执行记录列表。检索语法维持全文短语。

## 2. 已确认需求

| 项 | 结论 |
|---|---|
| 命中物 | 该次 HTTP 的 `access_log` 行 |
| 哪些请求 | 全部 POST / PUT / PATCH（含工作流对外 HTTP 与平台管理接口） |
| Body 形态 | 仅 `Content-Type` 含 `application/json`（含 `charset=utf-8`） |
| 写入位置 | 现有 `access_log` 根字段 `request_body`（字符串，脱敏后的 JSON 文本） |
| 截断 | 只截**日志副本**到 4KB；handler 仍拿完整 body |
| 脱敏 | 按 JSON **键名**（忽略大小写；相等或以 `_password` 这类后缀结尾）替换值；不按 32 位 hex 抹掉，以免误伤 uid |
| 云日志 UI | 不改；现有短语搜索扫整行即可 |

## 3. 非目标

- GET、query string、multipart、非 JSON、空 body
- 自定义头（如 `#req_id`）；链路 ID 仍用 `X-Request-Id`
- 把 body 再写入 `workflow_runs` / 执行记录列表
- 改 `compose_sls_query` 或云日志页交互
- 保证超过 4KB 截断点之后的 uid 能被搜到
- 记响应 body

## 4. 写入路径

在 `request_id_middleware` 内、`next.run` **之前**缓冲 body，之后 `emit_access_log` 带上字段。不新增中间件层。

1. 方法是 POST / PUT / PATCH，且 `Content-Type` 含 `application/json`。否则不读 body。
2. 读出完整 bytes，再 `Body::from` 塞回 `Request`。现有 axum body limit 仍约束真实请求。
3. 副本按 UTF-8 JSON 解析。失败则不设 `request_body`，请求照常。
4. 递归走对象/数组；键名命中敏感表则该值改为 `***`，子树不再展开。
5. `serde_json` 序列化后若超过 4096 **字节**，按 UTF-8 字符边界截到不超过 4096 字节。
6. `tracing::info!(target: "access_log", request_body = %text, ...)`。空则不加该字段。

读 body / 解析 / 脱敏失败：只省略 `request_body`，access log 其余字段与 handler 不受影响。

### 4.1 敏感键

忽略大小写。键等于下表之一，**或以 `_` + 该项结尾**（`smtp_password`、`client_secret`、`access_token`）。不用子串包含，避免 `token_count` 被误伤：

`password`、`token`、`secret`、`authorization`、`api_key`、`access_key`、`cookie`

嵌套对象同样处理。不复用 `workflow_qa::redact_value`（其中 32 位 hex 规则会误伤 id）。

## 5. 检索

云日志关键字普通词已编成全文短语 `"uid"`。SLS 全文会扫 access 行里的 `request_body`。控制台深链用同一 query，也能搜到。

排障路径：curl 工作流 → 云日志选对应时间窗与日志源 → 关键字填 uid → 命中 `logger=access_log` 的那一行。

## 6. 测试

纯函数覆盖脱敏、截断、是否视为 JSON。中间件或缓冲辅助函数覆盖「读完再塞回」：

- `{"uids":["15107269003108"]}` → `request_body` 含该 uid
- `password` / `token` 明文不出现，值为 `***`；嵌套与 `smtp_password` 同样
- `token_count` 不被当成敏感键
- GET、`multipart/form-data`、`text/plain`、缺 Content-Type → 无 `request_body`
- `application/json; charset=utf-8` 视为 JSON
- 序列化结果 > 4KB → 日志副本截断；恢复后的 request body 仍是完整 bytes
- 非法 JSON → 无 `request_body`，不 500

## 7. 风险

- 管理接口 JSON（登录、改密、存凭证）也会进 SLS；依赖键名脱敏。未列入敏感表的密钥字段仍可能泄漏。
- 日志量：每个 JSON 写请求多最多 4KB。相对一条 access 行可接受。
- 缓冲完整 body 增加峰值内存，上限仍是现有 request body limit。
