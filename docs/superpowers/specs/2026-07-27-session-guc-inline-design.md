# Auto API 会话 GUC 内联设计

状态：已实现
日期：2026-07-27
关联：`src/auto_api_handlers.rs`

## 背景

tcpdump 显示热路径事务为：`BEGIN` → `set_config`（Parse+Execute）→ 业务 SQL → `COMMIT`。
在 ~180ms RTT 下，独立 `set_config` 约 2 RTT；读路径的 BEGIN/COMMIT 各 1 RTT。

## 目标

- 将 `set_config('app.current_user_id', …, true)` **折进首条（或每条独立）业务 SQL**（CTE），不再单独往返。
- 只读且无需跨语句共享会话时：**去掉显式事务**（单语句即事务，`SET LOCAL` 仍对 RLS 生效）。
- `user_id` 为服务端 `i32`，以十进制字面量嵌入 CTE，不移动现有 `$N` 编号。

## 非目标

- 不重开 sqlx statement cache。
- 不改 RPC 多 GUC 注入路径（可后续复用同一 helper）。

## 决策

| 路径 | 行为 |
|------|------|
| list / get（读） | `sql_with_session_user` + 直接 `pool` 执行；COUNT 若需要则自带同一 CTE |
| create/update/delete（写） | 保留事务；去掉独立 `inject_session_user_id`；事务内**第一条** SQL 带 CTE |

## 风险

- 已以 `WITH` 开头的 SQL：helper 合并为 `WITH __onebase_sess AS (...), …`。
- raw SQL 改表与本改动无关。
