# 列类型缓存设计

状态：已实现
日期：2026-07-27
关联：`src/query_builder.rs`、`src/auto_api_handlers.rs`、`src/handlers.rs`、`src/ddl_handlers.rs`

## 背景

tcpdump 显示带 filter 的 Auto API list 在业务事务前会另开连接查询：

```sql
SELECT column_name, udt_name FROM information_schema.columns
WHERE table_schema = $1 AND table_name = $2
```

跨公网 RTT ~180ms 时，扩展协议 Parse+Execute 约 2 RTT。同表重复请求不应反复打 `information_schema`。

## 目标

- 按 `(database_id, schema, table)` 缓存列类型映射，命中则跳过 DB。
- DDL（create/alter/drop table）后主动失效；另设 TTL 兜底 raw SQL 改表。
- 不重开 `statement_cache_capacity`（与 cached-plan 修复无关）。

## 非目标

- 不合并 `set_config` + 业务 SQL（另议）。
- 不把列类型放进 Redis（进程内足够；多 pod 各缓存一份可接受）。

## 决策

| 项 | 结论 |
|----|------|
| 存储 | 进程内 `DashMap` |
| Key | `(database_id, schema, table)` |
| TTL | 默认 300s（`COLUMN_TYPE_CACHE_TTL_SECS`） |
| 失效 | DDL 成功后 `invalidate_column_types`；TTL 兜底 |
| API | `fetch_column_types(pool, database_id, schema, table)` |

## 风险

- 经 raw SQL 改表且未走 DDL API：最多 stale TTL 秒；最坏是 filter cast 类型不对（与历史无缓存时每次读最新相比），TTL 可调短。
