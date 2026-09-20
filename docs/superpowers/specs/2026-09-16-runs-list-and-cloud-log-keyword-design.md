# 执行记录瘦列表 + 云日志关键词 — 设计文档

- 日期：2026-09-16
- 状态：已通过
- 范围：工作流「执行记录」弹层与回放共用的 runs 列表去掉大字段；云日志「关键字」对普通词按内容检索，回车可查询。
- 相关代码：
  - `src/workflow_handlers.rs`（`WorkflowRunSummary`、`get_workflow_runs`、`get_workflow_run_detail`）
  - `frontend-nextjs/components/workflow/WorkflowsManager.tsx`（执行记录弹层）
  - `frontend-nextjs/components/workflow/replay/replayApi.ts`、`ExecutionReplayView.tsx`
  - `src/cloud_log.rs`（`compose_sls_query`）
  - `frontend-nextjs/app/workspace/[projectId]/cloud-logs/page.tsx`
- 关联：
  - `docs/superpowers/specs/2026-09-11-project-cloud-logs-design.md`
  - `docs/superpowers/specs/2026-09-14-cloud-logs-query-window-7d-design.md`

两块互不依赖，同一轮实现；先做执行记录（体感更差），再做云日志。

## 1. 执行记录：列表先出、展开再加载

### 1.1 背景

`GET /api/admin/workflows/:id/runs?limit=20` 虽用 `WorkflowRunSummary`，仍 `SELECT node_results`。20 条 × 数十节点入参/出参，弹层打开要近 10 秒。回放页已经是「列表 + 选中再拉 `GET .../runs/:run_id`」，弹层却把详情绑在第一次请求上。

### 1.2 已确认需求

| 项 | 结论 |
|---|---|
| 列表首屏 | 立刻画出 20 行：id、状态、触发方式、耗时、开始时间、节点/失败数 |
| 逐节点详情 | 展开 `<details>` 时再请求已有明细接口 |
| 失败摘要 | 列表仍带 `error_message`（短文本，不必等展开） |
| 回放 | 共用瘦列表；明细仍走现有 `get_workflow_run_detail` |

### 1.3 非目标

- 后台预拉全部明细
- 改 limit / 分页
- 拆 `workflow_runs` 表或加汇总列
- 执行日志页（`ExecutionLogsView`）的其它列表

### 1.4 接口

`WorkflowRunSummary` **不再包含** `node_results`。增加：

| 字段 | 来源 |
|---|---|
| `node_count` | `COALESCE(jsonb_array_length(node_results), 0)` |
| `executed_count` | `node_results` 里 `status != 'skipped'` 的个数 |
| `failed_count` | `status = 'failed'` 的个数 |
| `error_message` | 表列（列表需要展示） |

计数在 SQL 内对 JSONB 聚合，只扫 20 行、不把 JSON 回给客户端。权限、limit 默认 20 / 上限 100 不变。

明细 `GET /api/admin/workflows/:id/runs/:run_id` 不变，仍返回完整 `WorkflowRun`（含 `node_results`）。

### 1.5 前端

弹层：

- 首屏用摘要字段画行；「N 个节点执行 · M 失败」用 `executed_count` / `failed_count`。
- 「逐节点详情」一律默认收起（失败数在摘要行用红色标出）。展开才拉明细；加载中可点，失败可重试。
- 已加载的明细按 `run.id` 缓存在弹层生命周期内，收起再展开不重复请求。

回放：`ReplayRunSummary.node_results` 改为可选且列表不再依赖它；选中 run 仍走 `fetchReplayRunDetail`。

## 2. 云日志：普通词搜内容

### 2.1 背景

页上已有「关键字」，原样拼进 SLS（`prefix and error and x_request_id: "..."`）。未建全文索引时，光写 `error` 经常打不中 `message` / `content`。占位符 `error` 也看不出这是搜正文。时间窗、行数、凭证不变。

### 2.2 已确认需求

| 项 | 结论 |
|---|---|
| 普通词 | 自动搜 `content`、`message` 以及整行短语 |
| 高级语法 | 含 SLS 操作符的输入原样发送 |
| 交互 | 关键字框（及 `x_request_id`）回车触发查询 |
| 文案 | 占位改为「搜日志内容，如 超时 / error」 |

### 2.3 非目标

- 已查出表格的二次客户端过滤
- 改时间窗、行数、provider
- 多字段下拉（level / logger）本期不做

### 2.4 查询拼装

仍走 `compose_sls_query(prefix, user_query, request_id)`。对 `user_query`：

**普通词**（trim 后非空，且不含 `:` `"` `'` `(` `)` `|`，也不含作为独立词的 `and` / `or` / `not`，大小写不敏感）编成全文短语：

```text
"<escaped>"
```

`<escaped>`：把 `\` 和 `"` 转义，整段作为短语，不按空格拆成多个 AND。

不要编 `content: "..."` / `message: "..."`。SLS 对未建键值索引的字段做 `field:value` 会直接 400（`key (...) is not config as key value config`），后端再收成 500，而不是 0 命中。搜正文靠全文索引的短语；要按字段搜仍走下面的高级语法。

**否则**原样拼进去（与今天一致），方便写 `level: ERROR` 等。

`x_request_id` 仍只接受现有 `looks_like_trace_id`；非法继续 400。合法值同样编成全文短语 `"{id}"`，不用 `x_request_id: "..."`（未建键值索引时 SLS 会 400）。prefix 不变。控制台深链用拼好后的同一 `queryString`。

### 2.5 前端

- 关键字、`x_request_id` 的 `input`：`onKeyDown` 遇到 Enter（非 IME composing）调用现有 `handleQuery`。
- 占位符改为「搜日志内容，如 超时 / error」。
- 查询按钮文案与时间窗校验不变。

## 3. 测试

- `get_workflow_runs` 的 SELECT 不含 `node_results`，含 `node_count` / `executed_count` / `failed_count` / `error_message`。
- `compose_sls_query(None, Some("超时"), None)` 得到全文短语 `"超时"`，不含 `content:` / `message:`；`Some("level: ERROR")` 仍为 `level: ERROR`。
- `compose_sls_query(None, None, Some(uuid))` 得到 `"uuid"`，不含 `x_request_id:`。
- 关键字含引号时转义后仍能拼成合法查询。
- 前端：展开详情才请求 `/runs/:id`；云日志输入框回车会走查询（能测的抽成纯函数则测纯函数）。

## 4. 风险

- 计数子查询扫 JSONB：20 行、每行数十节点，远小于把 JSON 序列化出网。
- SLS 若无全文索引，短语 `"kw"` 可能 0 命中；高级语法兜底。不要用未建索引的 `field:value` 去「增强」普通词，SLS 会 400。
- 明细按展开按需请求；不在打开弹层时预拉。
