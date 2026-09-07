# db_query 节点级死连接重试

状态：已批准<br>
日期：2026-09-02<br>
关联：`src/workflow_engine.rs`、`src/error.rs`<br>
前序：`docs/superpowers/specs/2026-09-02-tenant-stale-connection-design.md`

## 背景

`max_retries` 只被 cron 调度器消费，HTTP endpoint 工作流不受影响。`workflow_engine.rs` 原先没有节点级重试。

`acquire_with_guards` 只在 `SET statement_timeout` 失败时换连接。代理层整实例重置时，高频 `db_query`（如 wf25 `open/get-article-detail`）往往已经过了 SET、正在 `fetch_all`，报 `Connection reset by peer`，节点直接失败。

## 目标

`db_query` 遇死连接签名时，整节点自动再跑一遍（重新 acquire + SET + SELECT），50ms backoff，只 1 次。平台默认，不复用 `max_retries`，不给单个工作流加参数。

## 非目标

- 不重试 `db_execute` / `db_transaction` / `foreach`（写可能已提交）。
- 不重试带数据修改型 CTE 的 `db_query`。
- 不改 workflow 表、前端「最大重试」、Auto API 直连路径。
- 不改 `acquire_with_guards`（池尸体仍在 SET 阶段换掉，不必整段 SQL 重跑）。

## 行为

`execute_node` 对 `NodeType::DbQuery`：先 `exec_db_query_node`；若失败且 `is_stale_connection` 且不是修改型 CTE → warn（`error.kind=stale_connection`，带 workflow_id / run_id）→ sleep 50ms → 再跑一次。第二次失败原样返回。

错误签名复用 `AppError::is_stale_connection`。
