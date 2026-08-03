# http_call / Lua http 异步轮询（202 + poll）— 设计文档

- 日期：2026-07-21
- 状态：已实现（待合入）
- 相关代码：`src/workflow_engine.rs`、`src/lua_builtins.rs`、`src/provision_webhook.rs`（协议参考）、`frontend-nextjs/components/workflow/NodeConfigPanel.tsx`

## 1. 背景与目标

工作流节点（尤其是 `http_call` 与 Lua `code` 内 `http.*` 调用 LLM / 慢外部 API）经常因超时失败。当前执行模型是进程内同步 DAG：一次性 HTTP 请求完成后才继续；没有「202 Accepted → 轮询直至就绪」能力。平台已有同类模式：运维 Provisioner（`provision_webhook.rs`）支持 HTTP `202` / JSON `status=pending` 后轮询。

**已落地（不在本 spec 实现范围）**：Lua `code` 节点脚本墙钟已可通过环境变量 `WORKFLOW_LUA_TIMEOUT_MS` 调整（`lua_node_timeout_ms()`，缺省仍 30s）。本 spec **不再**改动该默认值或再做一套 code 节点超时 UI。

目标：

1. 在现有 `http_call` 节点上 **opt-in** 支持异步轮询，语义对齐 Provisioner。
2. 在 Lua `http.get/post/put/delete` 的 `opts` 上以同样协议 **opt-in** 支持 `async_poll`。
3. 单次请求超时（`timeout_secs`）与轮询总等待（`poll_max_secs`）分层，避免「单次超时太短」或「盲等无上限」。
4. `http_call` 前端配置面板可显式开启，并提供合理默认（间隔 5s、最长 600s）。
5. 未开启时行为与现网完全一致（含直接返回 `202`）。
6. `http_call` 与 Lua 共用同一套 pending/完成/失败判定与 poll 请求构造，避免两套语义漂移。

非目标（本阶段不做）：

- 通用节点挂起 / webhook 回调唤醒 / 进程重启后续跑。
- 新建独立 `http_async` 节点类型。
- 自动放宽 Debug 路径的前端 axios / Admin `TimeoutLayer` 约 30s 限制（可另开任务）。
- 再改 Lua 脚本墙钟默认值或新增 code 节点级 `timeout_ms` UI（已由 `WORKFLOW_LUA_TIMEOUT_MS` 处理）。

## 2. 用户确认的产品语义

| 决策 | 选择 |
|---|---|
| 痛点范围 | 慢 HTTP 外部调用 + 异步完成模型，但先不做通用挂起 |
| 实现范围 | 强化 `http_call` + Lua `http.*`：`202` + 轮询 |
| 协议默认 | 对齐现有 Provisioner 模式 |
| 开启方式 | 显式 `async_poll: true` + 默认 interval/max |
| UI 布局（http_call） | 超时下方「启用异步轮询」开关；开启后折叠展开 interval / max |
| Lua 脚本超时 | 沿用已合并的 `WORKFLOW_LUA_TIMEOUT_MS`；本 spec 只做 `http.*` async_poll |

## 3. 协议

### 3.1 Pending 判定

满足任一即视为进行中：

- HTTP 状态码 `202`
- JSON body 中 `status`（大小写不敏感）为 `pending`

### 3.2 完成 / 失败

- **完成**：非 pending，且非失败语义（默认：`2xx` 且 `status` 不是 `failed` / `error`）
- **失败**：`4xx` / `5xx`，或 body.`status` 为 `failed` / `error`，或存在非空 `error` 字段

### 3.3 轮询方式

1. 首次请求按现有调用方式发出（`http_call` 的 method/url/headers/body，或 Lua `http.*` 对应参数）。
2. Pending 时解析：
   - 任务 ID，优先级：`body.job_id` → `body.id` → `body.provision_id`
   - 可选 poll 地址：`body.poll_url` 或响应头 `Location`
3. 若既无任务 ID、也无 `poll_url`/`Location` → 失败，不盲轮询。  
   仅有 `poll_url`/`Location`、无任务 ID 时允许进入轮询（走 GET）；仅有任务 ID 时走下方默认 POST。
4. 默认轮询（无 `poll_url`/`Location`）：对**同一 URL** 发 `POST`，body 为 `{ "action": "poll", "job_id": "<id>" }`；若 ID 来自 `provision_id` 字段，额外带上 `"provision_id": "<id>"` 以兼容 Provisioner 风格 API。保留原 headers 中的鉴权。
5. 若存在 `poll_url` / `Location`：后续轮询对该 URL 发 `GET`（仍带鉴权 headers）；每次 pending 响应若更新了 `poll_url`/`Location`，以最新值为准。
6. 间隔：优先使用响应中的 `poll_after_secs`，否则用配置的 `poll_interval_secs`；实际 sleep 取 `max(1, min(poll_after, poll_interval))`（与 Provisioner 一致）。

### 3.4 超时分层

| 配置 | 含义 | 默认 |
|---|---|---|
| `timeout_secs` | **单次** HTTP 请求超时 | 现有（默认 120；`0` = 不限） |
| `poll_interval_secs` | 轮询间隔参考上限 | `5` |
| `poll_max_secs` | 从首次 pending 起的总等待上限 | `600` |
| `workflows.timeout_ms` | 整条工作流墙钟（含轮询等待） | 不变；长任务需调大或关闭 |
| `WORKFLOW_LUA_TIMEOUT_MS` | Lua `code` 节点脚本墙钟（已有） | `30000`；`0` = 不限（慎用） |

Lua 路径额外约束：`poll_max_secs` 与多次请求耗时之和必须落在脚本墙钟内，否则指令 hook 仍会中断。运维在启用 Lua async_poll 时需把 `WORKFLOW_LUA_TIMEOUT_MS`（以及工作流 `timeout_ms`）调到不小于预期最长等待。

## 4. 引擎行为（http_call）

实现落点：`DagEngine::exec_http_call_node`（`workflow_engine.rs`）。节点仍同步阻塞 DAG，**不做** run 级 suspend/resume。

流程：

1. 发首次请求（现有逻辑 + 单次 `timeout_secs`）。
2. 若未开 `async_poll` → 原样返回。
3. 若已开且判定 pending → 进入 poll 循环，直到 Ready / Failed / `poll_max_secs`。
4. 返回最终完成那次响应。

### 4.1 错误语义

| 情况 | 结果 |
|---|---|
| 单次请求超时 / 网络错误 | 节点失败（与现网一致） |
| pending 且既无任务 ID 也无 poll 地址 | 节点失败，明确错误信息 |
| poll 返回失败语义 | 节点失败，带上远端 `error` / `message` |
| 超过 `poll_max_secs` | 节点失败：`HTTP 异步轮询超时（已等待 N 秒）` |
| 工作流墙钟先到 | 整 run 失败（现有 `timeout_ms`） |
| 节点 `allow_failure` | 与现网一致：失败可继续下游 |

### 4.2 干跑

`async_poll` 开启时仍跳过真实 HTTP（与现有 `http_call` 干跑一致），不进入 poll。

### 4.3 可观测性

节点结果 / debug 输出附带元数据（进入过 poll 时）：

```json
{
  "status": 200,
  "headers": {},
  "body": {},
  "async_poll": {
    "enabled": true,
    "job_id": "...",
    "attempts": 3,
    "elapsed_secs": 42
  }
}
```

tracing 记录 pending / poll_ok / poll_timeout 类事件（可参考 Provisioner 的 event 命名风格）。

## 5. Lua `http.*` 异步轮询

### 5.1 API

在现有 `opts` 表上增加与 http_call 同名的字段：

```lua
http.post(url, body, {
  headers = { Authorization = "Bearer ..." },
  timeout_secs = 120,          -- 单次请求
  async_poll = true,           -- 显式开启
  poll_interval_secs = 5,      -- 默认 5
  poll_max_secs = 600,         -- 默认 600
})
```

`http.get` / `put` / `delete` 同样支持。未设 `async_poll`（或为 false）时行为不变。

### 5.2 实现落点

- `lua_builtins::do_http_request`：在 blocking HTTP 路径内实现 poll 循环（Lua 运行于 `spawn_blocking`）。
- 判定与 poll 请求构造：**与 http_call 共用同一 helper**（新建小模块或放在 `workflow_engine` 可复用处，由 async 与 blocking 客户端分别调用），禁止复制粘贴两套规则。
- 生产只读护栏下 `http` 仍禁用，async_poll 不适用。

### 5.3 返回值

保持 `{ status, body, headers, json? }`；若进入过 poll，附加：

```lua
async_poll = { job_id = "...", attempts = 3, elapsed_secs = 42 }
```

错误以 Lua runtime error 抛出（与现有 `http.*` 失败语义一致），消息与 http_call 侧对齐。

## 6. 配置与 UI（http_call）

### 6.1 节点配置字段（`http_call.config`）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `async_poll` | bool | `false` | 显式开启才轮询 |
| `poll_interval_secs` | number | `5` | 轮询间隔参考 |
| `poll_max_secs` | number | `600` | 总等待上限 |

关闭 `async_poll` 时忽略 `poll_*`（可保留配置值以便再次开启）。

### 6.2 `NodeConfigPanel`

- 超时字段下方增加「启用异步轮询」开关。
- 开启后展开：轮询间隔、最长等待（两列）。
- 简短说明：收到 `202` / `status=pending` 时自动轮询；提示总耗时仍受工作流 `timeout_ms` 限制。
- 修正超时 placeholder：与后端默认 **120** 对齐（当前文案误写「默认 30」）。

Lua 侧无额外可视化开关（脚本内 opts 配置即可）；可在 code 节点说明文案中加一行指向 `async_poll` 与 `WORKFLOW_LUA_TIMEOUT_MS`（可选，非必须）。

## 7. 测试计划

| 用例 | 期望 |
|---|---|
| http_call 未开 `async_poll`，响应 `202` | 原样返回，不轮询 |
| http_call 开启 + pending → ready | 返回最终 body；`async_poll.attempts >= 1` |
| http_call 开启 + pending 且无 job_id 也无 poll_url/Location | 明确失败 |
| http_call 开启 + 持续 pending 超 `poll_max` | 轮询超时失败 |
| http_call `poll_url` / `Location` | 后续对指定 URL 发 GET |
| http_call 干跑 | 不发真实请求 |
| http_call `allow_failure` + 轮询失败 | 下游可继续 |
| Lua `http.post` 未开 async_poll，`202` | 原样返回 |
| Lua `http.post` 开启 + pending → ready | 返回最终表；含 `async_poll` 元数据 |
| Lua 开启 + 缺 ID 且无 Location | runtime error |
| 共用 helper 单测 | pending/ready/failed 判定与 poll body 构造 |

优先用 mock HTTP（或现有测试夹具）覆盖上述路径。

## 8. 实现范围与文件

| 文件 | 变更 |
|---|---|
| 新建小模块（建议）或 `workflow_engine` 内私有模块 | 共享 pending/完成判定、job_id 解析、poll 请求描述 |
| `src/workflow_engine.rs` | `exec_http_call_node` 接入共享 helper + poll 循环 |
| `src/lua_builtins.rs` | `do_http_request` 读 opts、blocking poll 循环 |
| `frontend-nextjs/components/workflow/NodeConfigPanel.tsx` | http_call 开关 + 折叠字段；修正 timeout placeholder |
| 测试 | 覆盖 §7 主要用例 |

可选后续（不在本 spec）：与 Provisioner 进一步合并 poll 基础设施；Debug 长任务等待（前端轮询 `workflow_runs` 或放宽 axios / TimeoutLayer）；code 节点级超时 UI。

## 9. 风险与约束

1. **仍占用执行任务**：轮询期间 Tokio / blocking 线程在 sleep/等待，长任务需同时调大 `workflow.timeout_ms`；Lua 还需调大 `WORKFLOW_LUA_TIMEOUT_MS`。
2. **进程被杀**：进行中的 poll 不会恢复；依赖现有 stale run 清理。
3. **外部协议差异**：默认 POST `{action, job_id}` 对齐 Provisioner；若目标 API 仅支持 Location GET，需返回 `poll_url` / `Location`。
4. **Debug UX**：管理端调试仍可能被约 30s 客户端/Admin 超时打断；本功能主要惠及 endpoint / manual / cron 等完整执行路径。
5. **Lua blocking**：poll 在 `spawn_blocking` 线程内 sleep，长时间占用阻塞线程池；`poll_max` 默认 600s，需关注线程池容量（与现有长 HTTP 阻塞同类风险）。
