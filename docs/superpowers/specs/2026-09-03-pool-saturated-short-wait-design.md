# 租户池饱和短等再 fail-fast

状态：已批准<br>
日期：2026-09-03<br>
关联：`src/pool_metrics.rs`、`src/auto_api_handlers.rs`<br>
前序：生产 10:47:45 一批 `pool timed out`（节点 0ms，应用池打满，PG 空闲）

## 背景

池 `idle=0 && in_use>=max` 时立刻 `PoolTimedOut`。微突发（列表+详情同一秒）时，前面的 SQL 再有几百毫秒就会还槽，0ms 拒绝会把尖刺放大成用户可见失败。

## 行为

饱和时先等 **300ms**（`TENANT_DB_SATURATED_WAIT_MS`），再读一次水位：有空闲则继续 `acquire`；仍满才记超时并拒绝。`0` / `off` 恢复立刻拒绝。非法或大于 2000 回退 300。

不抬 `max_connections`。不对 `PoolTimedOut` 做节点重试。

## 挂载

- `acquire_traced`（工作流 /query /transaction）
- Auto API `check_admission`
