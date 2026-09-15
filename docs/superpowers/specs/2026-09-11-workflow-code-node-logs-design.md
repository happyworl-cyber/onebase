# 工作流代码节点调试日志 — 设计文档

- 日期：2026-09-11
- 状态：已通过
- 范围：Lua / JavaScript / Python 代码节点的 `print`、`console.log`、`log.*` 写入该次运行的 `node_results.logs`；调试面板、执行历史、回放详情可见。不新建日志表。
- 相关代码：
  - `src/workflow_engine.rs`（`NodeExecutionResult`、`exec_code_node`、落库脱敏）
  - `src/lua_engine.rs` / `src/lua_builtins.rs`（`print`、`log.*`）
  - `src/js_runner.rs`（`ENTRY_JS`、`execute_javascript`）
  - `src/py_runner.rs`（`ENTRY_PY`、`execute_python`）
  - `frontend-nextjs/components/workflow/WorkflowsManager.tsx`（`NodeResultCard`）
  - `frontend-nextjs/components/workflow/replay/ExecutionReplayView.tsx`
- 关联：节点结果脱敏（`mask_env_and_credentials`）

## 1. 背景与目标

代码节点里 `console.log` / `print` / Lua `print` 和 `log.*` 现在进不了运行结果：JS/Python 的 stdout 成功时丢弃，Lua `print` / `log.*` 只打 tracing。调试面板和执行历史只能看 input / output / error。

**目标**

1. 调试运行和正式执行都收集，写入该次 `node_results`。
2. 三种语言行为一致：标准打印 + 平台 `log.*` 都进同一份 `logs`。
3. 节点失败时，失败前已打出的行仍保留。
4. 落库前脱敏、单节点截断，避免密钥和大对象撑爆历史。

### 已确认需求

| 项 | 结论 |
|---|---|
| 哪些运行 | 调试 + 正式，都落 `node_results` |
| 语言 | Lua `print` / `log.*`，JS `console.log/info/warn/error` 与 `log.*`，Python `print` 与 `log.*` |
| 通道 | 运行时拦截用户 API，不整段收进程 stdout |
| 展示 | 节点卡片「调试日志」；回放选中代码节点同样显示 |

### 非目标

- 新建按 run 的日志表或实时推流
- 拦截 `process.stdout.write`、未走 `print` 的第三方 logger
- 改代码节点对外 `output` / `ctx.body` 的语义
- 为日志单独做 MCP 工具

## 2. 关键决定

| 项 | 结论 | 理由 |
|---|---|---|
| 字段 | `NodeExecutionResult.logs: Vec<NodeLogLine>`，空则 omit | 与 input/output 同通道，旧运行无字段即可 |
| 行形状 | `{ level, message }`，无时间戳 | 数组顺序即发生顺序 |
| `level` | `debug` \| `info` \| `warn` \| `error` | `print` / `console.log` → `info` |
| 截断 | 每节点最多 200 行、合计 64KB；单条 message 超 4KB 留头尾 | 正式跑也收，必须封顶 |
| 超限标记 | 保留前面的行，追加一条 `warn`：`日志已截断` | 调试先看开头 |
| 脱敏 | `logs[].message` 走 `mask_env_and_credentials` | 与 node_results 其它字段同一边界 |
| 失败 | 成功 / Failed / FailedAllowed 都带已收集的 logs | 否则排错看不到 throw 前的 print |
| 引擎出口 | `execute_node` 改为 `NodeOutcome { output, branch, logs }`，非代码节点 `logs` 为空 | 只扩结果结构，不把 logs 塞进 output |

## 3. 数据

```json
{
  "node_id": "normalize",
  "status": "success",
  "logs": [
    { "level": "info", "message": "user_id=42" },
    { "level": "warn", "message": "skip empty row" }
  ]
}
```

`NodeLogLine.level` 序列化为小写字符串。非代码节点、或代码节点从未打日志：序列化省略 `logs`。

`ctx.node_outputs` 仍只放该节点 `output`（`body`），下游模板 `{{normalize.x}}` 不变，不能把 `logs` 混进节点输出。

## 4. 三种语言

**JavaScript**（`ENTRY_JS`）

- 包 `console.log/info/warn/error/debug`（`log`→`info`，`debug`→`debug`）。不包 `dir` / `table`。
- 平台 `log.*`：先入同一数组，再调现有 host 桥（tracing 照旧）。
- `result.json` 为 `{ "body": ..., "logs": [...] }`。
- `catch` 先写 `result.json`（`body` 可为 null，带已有 `logs`）再 `exit 1`。
- `execute_javascript` 成功返回 `{ body, logs }`；失败返回错误文案 + 已读到的 `logs`（有 `result.json` 则用之）。

**Python**（`ENTRY_PY`）

- 替换内置 `print`：多参数用空格拼接，与标准 `print` 一致（`sep=' '`）。
- `log.info/warn/error/debug` 双写：数组 + host。
- 成功与 `except` 都写 `{ body, logs }`，失败再非 0 退出。
- `execute_python` 契约同 JS。

**Lua**

- `print` / `log.*` 写入引擎内缓冲（`print` 多值仍用 tab 拼接），并继续打 tracing。
- `execute_plugin` 成功或失败都带回缓冲。
- 无子进程 stdout。

不管 `process.stdout.write`、不管第三方 logger。

## 5. 引擎与落库

`exec_code_node` 把 runner / Lua 的 `logs` 填进 `NodeOutcome.logs`。顶层循环在 Success / Failed / FailedAllowed 三处写入 `NodeExecutionResult.logs`。Skipped 与其它节点类型不填。

凡写入 `NodeExecutionResult` 的代码节点都填 `logs`（含 loop 体内执行后并入 loop 输出的条目）。不另开通道。`_iterations` 若当前只摘 output、不含完整节点结果，第一期不往里面单独塞 logs。

落库与调试响应：对整份 `node_results`（含 `logs`）做现有脱敏。截断在脱敏前、写入 `NodeExecutionResult` 时做（先裁再打码）。

## 6. 前端

`NodeResultItem` 增加 `logs?: { level: string; message: string }[]`。

`NodeResultCard`（调试 + 执行历史）在入参/输出下增加「调试日志」：等宽、按行 `level` + `message`、可滚动、可复制。有日志时卡片默认展开。

回放 `ExecutionReplayView` 选中节点详情同样列出 `logs`。旧运行无字段则不渲染该块。

不改画布、不在节点上画日志角标。

## 7. 测试

不连真实编辑器页。

| 用例 | 断言 |
|---|---|
| JS `console.log` + `log.warn` | `logs` 含对应 `info` / `warn` |
| JS 中途 `throw` | 错误非空，且含 throw 前的行 |
| Python `print` + `log.error` | 同上 |
| Lua `print` + `log.info` | 引擎带回缓冲 |
| 201 行 | 200 条用户行 + 一条 `日志已截断` |
| message 含与 env/凭证相同的明文 | 落库/响应里是 `***` |
| `db_query` 等非代码节点 | 无 `logs` 字段 |
| 下游读 `{{code_node.foo}}` | 仍是 body 字段，不是 logs |

## 8. 不做的代码

- 日志表、SSE 推日志、按 level 过滤 UI
- 改 MCP `debug_workflow` 契约以外的新工具（现有 debug 回包带上 `logs` 即可）
- 拦截 `console.dir` / `console.table`
