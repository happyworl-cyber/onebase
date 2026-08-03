# Loop 节点并发（for_each concurrency）设计

状态：已实现（后端 `src/workflow_engine.rs` + 前端 `NodeConfigPanel.tsx`），实现与本设计一致，无偏差
日期：2026-07-21
关联：`src/workflow_engine.rs`（`run_loop` / loop 校验）、`frontend-nextjs/components/workflow/NodeConfigPanel.tsx`

## 背景与动机

工作流的 `loop` 节点当前**严格串行**执行：`run_loop` 内一个 `loop { clone(carry_ctx) → execute_dag(body) → 累加结果 }`。
对「逐工单调 LLM（DeepMind）」这类批量场景，N 个 item 依次跑，累计耗时轻易突破 Lua 节点超时（`WORKFLOW_LUA_TIMEOUT_MS`）与工作流总超时（`workflows.timeout_ms`）。

由于每个 item 相互独立，`for_each` 模式天然适合并发执行。本设计放开 `for_each` 的并发能力，其余模式保持串行。

## 目标

- `for_each` 模式支持 `concurrency > 1`，并发执行各 item 的循环体，显著降低批量场景总耗时。
- 不改变默认行为：不填 / `concurrency=1` 时与现状完全一致（串行）。
- 结果与观测（`results` / `_iterations`）保持 item **原序**。
- 有服务端硬上限兜底，防止耗尽 DB 连接池。

## 非目标

- 不为 `while` / `until` / `count` 提供并发（它们存在跨轮状态依赖，无法安全并行）。
- 不引入跨节点/跨工作流的分布式并发或队列。
- 不改变 async_poll、http_call 等既有能力。

## 关键设计决策（已与用户确认）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 适用模式 | 仅 `for_each`；`while`/`until`/`count` 仍强制 `concurrency=1` |
| 2 | `{{loop.results}}` 可见性 | 并发 `for_each`（concurrency>1）的循环体中**禁止**引用 `{{loop.results}}` —— 校验期报错。仅允许 `{{loop.item}}` / `{{loop.index}}` / `{{loop.count}}` |
| 3 | 并发硬上限 | `HARD_LOOP_MAX_CONCURRENCY = 8`；配置值 clamp 到 `1..=8`（或校验报错）。默认 `concurrency=1`（opt-in） |
| 4 | 失败语义 | 沿用现有 `allow_failure`：`false` → 停止派发后续、返回首个错误；`true` → 记录该轮失败并跑完剩余 |
| 5 | 结果顺序 | 迭代可能乱序完成，但 `results` / `_iterations` 按 item 原序重组 |
| 6 | `delay_ms` | 并发模式下**忽略**（迭代间延迟对并发无意义）；串行模式行为不变 |

### 决策 2 的理由
串行时第 K 轮能看到前 K-1 轮结果（`{{loop.results}}`）。并发后多轮同时执行，跨轮可见性无法保证，若允许引用会得到非确定性的「部分结果」。因此在并发模式下将其定义为**非法引用**，校验期直接报错，语义清晰、避免隐蔽 bug。

### 决策 3 的理由
主库连接池默认 20（`DB_MAX_CONNECTIONS`），租户库每个 10（`workflow_engine.rs` 中 `max_connections=10`）。并发上限 8 可给租户池留余量，同时提供约 8× 提速。DeepMind 侧确认无速率限制，故约束来自 DB 池而非外部 API。

## 行为规格

### 校验（loop 配置校验函数）
- `for_each` 模式：`concurrency` 允许 `1..=HARD_LOOP_MAX_CONCURRENCY`；缺省视为 1。超出上限 → `InvalidQuery` 报错（消息含实际值与上限）。
- `while`/`until`/`count`：`concurrency` 若 `!= 1` → 保持现有 `InvalidQuery` 报错。
- **`{{loop.results}}` 禁用校验**：当 `for_each` 且解析出的 `concurrency > 1` 时，扫描该 loop 的**循环体节点**（经 `plan_loops` 得到的 `body_nodes` 对应节点）config，若任意节点 config 文本包含 `loop.results` 占位符引用 → `InvalidQuery` 报错，提示「并发 for_each 循环体不可引用 {{loop.results}}」。
  - 仅扫描本 loop 的 body 节点，避免误伤其它节点。

### 执行（`run_loop`）
- 解析 `concurrency`（`json_as_u64`，缺省 1），clamp 到 `1..=HARD_LOOP_MAX_CONCURRENCY`。
- **`concurrency <= 1` 或 非 for_each**：走现有串行分支，行为完全不变。
- **`for_each` 且 `concurrency > 1`**：走新增并发分支：
  1. 待处理索引集合为 `0..max_iterations`（沿用现有 `max_iterations` 截断语义：`for_each` 下 = `min(configured_max?, items.len(), HARD_LOOP_MAX_ITERATIONS)`）。
  2. 为每个 index 构造独立 `iter_ctx = ctx.clone()`（以进入 loop 前的基线 `ctx` 为准，**不**含跨轮累积），注入 `loop` 作用域变量：`index`、`count=index+1`、`item=items[index]`、`reached_max=false`；**不注入 `results`**。
  3. 用有界并发（`futures::stream::iter(...).map(fut).buffer_unordered(concurrency)`）执行各 `execute_dag(&region.body_def, &mut iter_ctx, ...)`。
  4. 每个 future 产出 `(index, body_results, last_out_or_none, error_or_none)`。
  5. **失败处理**：
     - `allow_failure = false`：任一 future 失败即停止消费流（`buffer_unordered` drop 未启动的 future 天然停止派发），返回 `InvalidQuery`（首个失败）。
     - `allow_failure = true`：记录 `had_failures=true`、`last_error`，继续。
  6. 收集完成后按 `index` 排序，构建 `results_acc`（成功轮次的 `last_out`，与串行一致：失败轮不进 results）与 `iteration_reports`（含 `index`/`item`/`nodes`，失败轮带 `failed:true`/`error`），`_iterations` 仍受 `MAX_LOOP_ITERATION_REPORTS` 截断（按 index 顺序取前 N）。
  7. `index`（iterations 计数）= 实际完成的轮次数（= 处理的 item 数）。`reached_max` 沿用现有逻辑（`configured_max < items.len()` 时可能为 true）。
- 输出结构（`output` json）与串行分支保持一致字段：`loop_mode`/`iterations`/`index`/`count`/`reached_max`/`results`/`item`/`had_failures`/`error`/`_iterations`/`_iterations_truncated`。
  - `item`（last_item）：并发下取最后一个**被处理**索引对应的 item（保证确定性，不依赖完成顺序）。

### 前端 UI（`NodeConfigPanel.tsx` for_each 分支）
- 启用现有「并发数」输入框（当前 `disabled`、`max=1`、写死 `value=1`）：
  - `min=1`、`max=HARD_LOOP_MAX_CONCURRENCY(=8)`、绑定 `node.config.concurrency`，`onChange` 写回。
  - 说明文案更新：`1=串行；>1 并发执行各元素（上限 8）。并发模式下循环体不可引用 {{loop.results}}，迭代间延迟被忽略。`
- `{{loop.results}}` 内置变量说明表中标注：`（串行模式；并发 for_each 不可用）`。

## 边界与风险

- **嵌套 loop**：外层并发 × 内层并发可能放大总并发。本期不做全局并发预算限制，依赖各 loop 的 `HARD_LOOP_MAX_CONCURRENCY` 与工作流总超时兜底；spec 记录为已知限制。
- **副作用顺序**：body 内 SSE/邮件/写库的发生顺序在并发下不确定。可接受；`results`/`_iterations` 的最终展示仍按 item 原序。
- **DB 事务**：并发轮次各自持有连接/事务；上限 8 相对租户池 10 留有余量，但若 body 单轮占用多个连接仍可能触及 `acquire_timeout`。记录为运维注意点。

## 测试规格

后端（`src/workflow_engine.rs` 测试模块）：
1. `for_each concurrency=1` 与不填 → 行为、输出与现状一致（回归）。
2. `for_each concurrency>1` → 所有 item 都执行；`results`/`_iterations` 按原序；结果内容正确。
3. 乱序完成仍保持原序（可用带不同 sleep 的 mock body，或校验 index 顺序）。
4. `allow_failure=false` 且某轮失败 → 返回错误、不吞掉。
5. `allow_failure=true` 且某轮失败 → 跑完、`had_failures=true`、成功轮进 results。
6. `concurrency` 超 `HARD_LOOP_MAX_CONCURRENCY` → 校验报错。
7. `while/until/count` + `concurrency>1` → 校验报错（回归）。
8. 并发 for_each 循环体引用 `{{loop.results}}` → 校验报错。

前端：手动/构建校验并发输入框可编辑、上限 8、写回 config。
