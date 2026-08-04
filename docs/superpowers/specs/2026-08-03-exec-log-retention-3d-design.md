# 执行日志保留 3 天（生产运维）

日期：2026-08-03  
状态：已确认 / 运维执行

## 背景

执行日志页（诊断与监控 → 执行日志）展示的是平台管理库 `management.execution_index`，不是业务 schema（如 `gamesq`）。详情权威数据在 `management.workflow_runs` / `management.scheduled_task_runs`。细节事件在 `management.execution_logs`（默认已按 24h 滚动清理）。

当前默认：`EXEC_INDEX_RETENTION_DAYS=7`、`EXEC_RUNS_RETENTION_DAYS=7`。生产希望列表与权威 run 表只保留 3 天。

## 目标与非目标

### 目标

- 生产环境执行索引 + 权威 run 表保留窗口改为 3 天。
- 提供可在生产管理库直接执行的一次性清理 SQL（预览 + 分批删除）。
- 依赖现有 `spawn_cleanup_task` 维持滚动清理，不新增代码路径。

### 非目标

- 不改代码默认值（避免影响未显式配置的环境）。
- 不调整 `EXEC_LOG_RETENTION_HOURS`（细节日志仍默认 24h）。
- 不清理 `audit_logs` / `slow_query_logs`（不在本次「执行日志」范围内）。

## 方案

**方案 A：仅改生产环境变量 + 一次性 SQL 清存量。**

1. 在 onebase 进程环境增加（或覆盖）：
   ```
   EXEC_INDEX_RETENTION_DAYS=3
   EXEC_RUNS_RETENTION_DAYS=3
   ```
2. 滚动重启 / 重新部署使进程读到新 env。后台每小时（`EXEC_LOG_CLEANUP_INTERVAL_SECS`，默认 3600）按新阈值清理。
3. 在**管理库**执行下方 SQL，立刻删掉已超 3 天的存量（不必等下次 cleanup tick）。

约束：`EXEC_RUNS_RETENTION_DAYS` 会被代码强制抬到 ≥ `EXEC_INDEX_RETENTION_DAYS`；两者都设为 3 即可。

## 生产一次性清理 SQL

在管理库（与 onebase 使用的 Postgres 同一库）执行。**不要**在租户业务库 / `gamesq` 下执行。

建议先预览、再分批删；大表可把 `LIMIT` 调小、循环多跑几次。

```sql
-- ── 0. 预览：各表将删除多少行 ──
SELECT 'execution_index' AS tbl, COUNT(*) AS to_delete
FROM management.execution_index
WHERE started_at < NOW() - INTERVAL '3 days'
UNION ALL
SELECT 'workflow_runs', COUNT(*)
FROM management.workflow_runs
WHERE started_at < NOW() - INTERVAL '3 days'
UNION ALL
SELECT 'scheduled_task_runs', COUNT(*)
FROM management.scheduled_task_runs
WHERE started_at < NOW() - INTERVAL '3 days';

-- ── 1. 分批删除 execution_index（列表页）──
-- 重复执行直到 rows=0
DELETE FROM management.execution_index
WHERE ctid IN (
  SELECT ctid FROM management.execution_index
  WHERE started_at < NOW() - INTERVAL '3 days'
  LIMIT 5000
);

-- ── 2. 分批删除 workflow_runs ──
DELETE FROM management.workflow_runs
WHERE ctid IN (
  SELECT ctid FROM management.workflow_runs
  WHERE started_at < NOW() - INTERVAL '3 days'
  LIMIT 5000
);

-- ── 3. 分批删除 scheduled_task_runs ──
DELETE FROM management.scheduled_task_runs
WHERE ctid IN (
  SELECT ctid FROM management.scheduled_task_runs
  WHERE started_at < NOW() - INTERVAL '3 days'
  LIMIT 5000
);

-- ── 4. 可选：确认剩余最早记录 ──
SELECT 'execution_index' AS tbl, MIN(started_at) AS oldest, COUNT(*) AS rows
FROM management.execution_index
UNION ALL
SELECT 'workflow_runs', MIN(started_at), COUNT(*)
FROM management.workflow_runs
UNION ALL
SELECT 'scheduled_task_runs', MIN(started_at), COUNT(*)
FROM management.scheduled_task_runs;
```

说明：

- 用 `ctid` + `LIMIT` 分批，避免单次超大 DELETE 长时间锁表 / 撑爆 WAL。
- 细节表 `execution_logs` 默认已按小时清理；若也想手动压体积，可另跑  
  `DELETE ... WHERE ts < NOW() - INTERVAL '24 hours'`（不在本次必做范围）。
- 删完后建议在低峰对相关表做 `VACUUM (ANALYZE)`（可选，非必须）。

## 仓库侧（可选、非阻塞）

仅在 `.env.example` 注释中注明「生产建议索引/run 保留 3 天」。不改代码默认值。

## 验收

- 生产 env 中上述两个变量为 `3`，onebase 日志出现「执行日志清理任务已启动」且 `index_retention_days=3`、`runs_retention_days=3`。
- 执行日志页看不到 3 天前记录；预览 SQL 的 `to_delete` 为 0（或仅剩边界附近少量待下一轮清理）。
- 点击 3 天内失败/成功记录的详情仍能回查到对应 run。
