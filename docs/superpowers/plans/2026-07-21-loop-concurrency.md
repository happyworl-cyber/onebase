# Loop 节点并发（for_each concurrency）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现。步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** 放开 `loop` 节点 `for_each` 模式的并发执行能力（`concurrency > 1`），显著降低「逐 item 调 LLM」批量场景的总耗时；其余模式保持串行，默认行为不变。

**Architecture:** 在 `run_loop` 内新增「for_each 并发分支」，用 `futures::stream::buffer_unordered(concurrency)` 有界并发地执行各 item 的循环体子图（`region.body_def`），带 index 收集后按原序重组 `results`/`_iterations`；校验层放开 for_each 的 concurrency 上限并新增「并发禁用 `{{loop.results}}`」校验；前端启用 for_each 的并发数输入框。

**Tech Stack:** Rust / Tokio / futures（后端）；Next.js / React / TypeScript（前端）。

关联 spec：`docs/superpowers/specs/2026-07-21-loop-concurrency-design.md`

## Global Constraints

- 未经用户明确要求不要创建 git commit。
- 默认行为零变更：`concurrency` 不填或 `=1` 时与现状逐字节等价（走原串行分支）。
- 仅 `for_each` 支持 `concurrency>1`；`while`/`until`/`count` 仍强制 `=1`。
- `HARD_LOOP_MAX_CONCURRENCY = 8`；配置超限 → 校验报错。
- 并发 for_each 循环体禁止引用 `{{loop.results}}`（校验期报错）。
- `results` / `_iterations` 必须按 item 原序。
- 失败沿用 `allow_failure` 语义。
- 测试构建须将 `CARGO_TARGET_DIR` 指向项目本地 `target/`（沙盒缓存盘空间不足会导致链接失败 errno=28）。

---

## File Structure

- Modify `src/workflow_engine.rs`:
  - 新增常量 `HARD_LOOP_MAX_CONCURRENCY`。
  - loop 配置校验函数：放开 for_each 的 concurrency 上限校验；新增并发下 `{{loop.results}}` 禁用校验（扫描本 loop body 节点 config）。
  - `run_loop`：解析并 clamp `concurrency`；新增 for_each 并发执行分支；抽出「单轮执行 → (index, body_results, last_out, error)」的辅助逻辑供并发复用。
  - 测试模块：新增并发相关测试。
- Modify `frontend-nextjs/components/workflow/NodeConfigPanel.tsx`:
  - 启用 for_each「并发数」输入框（`max=8`、绑定 `config.concurrency`、写回）。
  - 更新说明文案与 `{{loop.results}}` 变量说明标注。

---

### Task 1: 后端常量与校验层

**Files:**
- Modify: `src/workflow_engine.rs`

**Steps:**
- [ ] 新增 `const HARD_LOOP_MAX_CONCURRENCY: u64 = 8;`（放在 `HARD_LOOP_MAX_ITERATIONS` 附近）。
- [ ] loop 校验函数（含 `for_each` 分支的 `concurrency != 1` 判断，约 `src/workflow_engine.rs:1583`）：
  - `for_each`：把「`!= 1` 即报错」改为「`concurrency` 解析后必须在 `1..=HARD_LOOP_MAX_CONCURRENCY`，否则 `InvalidQuery`（消息含实际值与上限）」。缺省视为 1。
  - `while`/`until`/`count`：保持 `concurrency != 1` → 报错。
- [ ] 新增并发下 `{{loop.results}}` 禁用校验：当 `for_each` 且 `concurrency > 1` 时，取本 loop 的 body 节点集合（复用 `plan_loops` / `LoopRegion.body_nodes`），扫描这些节点 config 序列化文本，若包含 `loop.results` 引用 → `InvalidQuery`（提示并发 for_each 不可引用 `{{loop.results}}`）。仅扫描本 loop body，避免误伤。
- [ ] 校验清晰的中文错误消息，风格与既有 loop 校验一致。

**Verification:**
- [ ] `CARGO_TARGET_DIR=./target cargo build` 通过。

---

### Task 2: run_loop 并发执行分支

**Files:**
- Modify: `src/workflow_engine.rs`

**Steps:**
- [ ] 在 `run_loop`（约 `src/workflow_engine.rs:2209`）解析 `concurrency`（`config.get("concurrency").and_then(json_as_u64).unwrap_or(1)`），clamp 到 `1..=HARD_LOOP_MAX_CONCURRENCY`。
- [ ] 当 `mode == "for_each" && concurrency > 1`：进入并发分支；否则维持现有串行 `loop {}` 分支（原样保留，零行为变更）。
- [ ] 并发分支实现：
  - 待处理索引 `0..max_iterations`（沿用现有 `max_iterations` for_each 截断）。
  - 每个 index 构造 future：`iter_ctx = ctx.clone()`（进入 loop 前基线，不含跨轮累积），注入 `loop` 作用域变量 `index`/`count=index+1`/`item=items[index]`/`reached_max=false`（**不注入 `results`**），调用 `self.execute_dag(&region.body_def, &mut iter_ctx, call_stack.to_vec())`。
  - future 产出 `(index, cur_item, body_results, last_out: Option<JsonValue>, error: Option<String>)`；`last_out` 取 `iter_ctx.node_outputs[region.back_source]`（成功时）。
  - 用 `futures::stream::iter(...).map(...).buffer_unordered(concurrency)` 消费。
  - 失败处理：
    - `allow_failure == false`：遇首个失败 future（body_results 含 Failed，或 execute_dag Err）立即 `return Err(InvalidQuery(...))`（消息与串行分支一致），停止消费流。
    - `allow_failure == true`：记 `had_failures=true`、`last_error`，继续。
  - 收集所有结果后按 `index` 排序：
    - `results_acc`：仅成功轮的 `last_out`（与串行一致：失败轮不进 results）。
    - `iteration_reports`：按 index 顺序 push（失败轮带 `failed:true`/`error`/`item`/`nodes`；成功轮 `index`/`item`/`nodes`），受 `MAX_LOOP_ITERATION_REPORTS` 截断。
  - `index`（iterations 计数）= 处理的 item 数；`last_item` = 最后一个被处理索引的 item（确定性）。
- [ ] 输出 json 结构字段与串行分支保持完全一致。
- [ ] `delay_ms` 在并发分支忽略（不 sleep）。
- [ ] 保留/复用现有 tracing 日志（记录 mode/iterations/reached_max，可加 concurrency 字段）。
- [ ] 确认 `futures` crate 已在依赖中（`Cargo.toml`）；若无则 `cargo add futures`。

**Verification:**
- [ ] `CARGO_TARGET_DIR=./target cargo build` 通过。

---

### Task 3: 后端测试

**Files:**
- Modify: `src/workflow_engine.rs`（测试模块）

**Steps:**
- [ ] 回归：`for_each concurrency=1` / 不填 → 输出与现状一致。
- [ ] 并发：`for_each concurrency>1` → 所有 item 执行；`results`/`_iterations` 按原序；内容正确。
- [ ] 乱序完成仍按原序（body 内不同 sleep 或按 index 校验顺序）。
- [ ] `allow_failure=false` 某轮失败 → 返回错误。
- [ ] `allow_failure=true` 某轮失败 → 跑完、`had_failures=true`、成功轮进 results。
- [ ] `concurrency > HARD_LOOP_MAX_CONCURRENCY` → 校验报错。
- [ ] `while/until/count` + `concurrency>1` → 校验报错（回归）。
- [ ] 并发 for_each 循环体引用 `{{loop.results}}` → 校验报错。

**Verification:**
- [ ] `CARGO_TARGET_DIR=./target cargo test`（loop 相关测试）全绿。

---

### Task 4: 前端 UI

**Files:**
- Modify: `frontend-nextjs/components/workflow/NodeConfigPanel.tsx`

**Steps:**
- [ ] for_each 分支「并发数」输入框（约 `NodeConfigPanel.tsx:871`）：去掉 `disabled`，`min=1`、`max=8`，`value={node.config.concurrency ?? 1}`，`onChange` 写回 `updateConfig('concurrency', ...)`（空值回落 1，clamp 到 1..8）。
- [ ] 更新说明文案：`1=串行；>1 并发执行各元素（上限 8）。并发模式下循环体不可引用 {{loop.results}}，迭代间延迟被忽略。`
- [ ] 内置变量说明表中 `{{loop.results}}` 行标注「（串行模式；并发 for_each 不可用）」。
- [ ] 确认 for_each 初始化默认 `concurrency: 1`（约 `NodeConfigPanel.tsx:201`）仍成立。

**Verification:**
- [ ] `npm run build`（或项目对应前端构建/类型检查）通过。

---

### Task 5: 文档收尾

**Files:**
- Modify: `docs/superpowers/specs/2026-07-21-loop-concurrency-design.md`（如实现中有偏差则回填）

**Steps:**
- [ ] 若实现与 spec 有出入，更新 spec 记录最终决策。
