# PG 崩溃连带 / Webhook 加压硬化设计

状态：已批准  
日期：2026-07-27  
关联：`src/webhook_manager.rs`、`src/tenant_handlers.rs`、`docker/entrypoint.sh`、`.env.example`

## 背景与动机

生产间歇性报错（例：2026-07-27 08:31，`run_id=182893` workflow 完成后）：

- 应用：`webhook_manager` 报 `expected to read 5 bytes, got 0 bytes at EOF` / `Connection reset by peer` / `Broken pipe`
- PG notice：`terminating connection because of crash of another server process`
- 几秒后自愈；无容器/supervisord 重启记录

根因在 Postgres 侧：某 backend 异常退出（常见 OOM kill 或扩展/worker 崩溃）→ postmaster 强制断开其它连接保护共享内存 → 崩溃恢复后重新接受连接。应用侧 sqlx 报错是死连接症状。

加压因素（源码核实）：

1. `webhook_manager` 对每个 `DataChangeEvent` 无界 `tokio::spawn`，且每次全表查 `management.webhooks`（无缓存、无并发上限）。
2. AIO 容器（`Dockerfile.aio`）同 cgroup 跑 PG+Redis+Node+Rust；`entrypoint.sh` 仅改 `listen_addresses`，未调 `shared_buffers` / `work_mem` / `max_connections`。
3. 租户池 `max_connections` API 上限达 200，多库叠加易顶穿物理 `max_connections`。

## 目标

- 限制 webhook 分发并发，并对 webhook 配置加短 TTL 缓存，避免事件风暴打满管理库连接池。
- AIO 启动时幂等写入合理 PG 参数（含已有数据目录）。
- 收紧单租户连接上限，并按 `(db_host, db_port)` 做连接预算校验。
- 文档说明：如何用 `postgresql.log`/`dmesg` 区分 OOM vs worker 崩溃；生产持续 OOM 时评估拆出 Postgres（本次不改拓扑）。

## 非目标

- 不访问/依赖生产 A 项日志验证（运维侧另行排查）。
- 不把 Postgres 从 AIO 拆成独立部署（仅文档建议）。
- 不引入 PgBouncer。
- webhook CRUD 不做主动缓存失效（仅 TTL）。
- 不强制 migration 改写存量 `max_connections > 50` 的行。
- 不合并 `set_config` 与业务 SQL、不改 EventBus 扇出语义。

## 关键设计决策

| # | 决策 | 结论 |
|---|------|------|
| 1 | 实现路径 | 最小侵入：改现有 `webhook_manager` / `tenant_handlers` / `entrypoint.sh` |
| 2 | 分发并发 | 默认 16（`WEBHOOK_DISPATCH_CONCURRENCY`） |
| 3 | 配置缓存 TTL | 默认 30s（`WEBHOOK_CONFIG_CACHE_TTL_SECS`） |
| 4 | Semaphore 范围 | 覆盖「取配置 + 匹配 + spawn HTTP」；HTTP 发送不长期占用许可 |
| 5 | 缓存失效 | 仅 TTL；配置变更最多延迟 30s |
| 6 | 单库上限 | `1..=50`（原 `1..=200`） |
| 7 | 连接预算 | 默认 60（`TENANT_POOL_GLOBAL_MAX_CONNECTIONS`），按 `(db_host, db_port)` 聚合 |
| 8 | 存量超限 | 不扫表拒绝；仅创建/更新新写入时校验 |
| 9 | AIO `max_connections` | 默认 120（`AIO_PG_MAX_CONNECTIONS`） |
| 10 | AIO `shared_buffers` | 默认 256MB（`AIO_PG_SHARED_BUFFERS`） |
| 11 | AIO `work_mem` | 默认 4MB（`AIO_PG_WORK_MEM`） |
| 12 | AIO 调优时机 | **每次启动**幂等 apply，不只 initdb 首次 |

## 架构

### Webhook 分发

```
EventBus event
  └─ spawn dispatch
       └─ acquire Semaphore (max 16)
            ├─ load_matching_webhooks (TTL cache → else SQL → store)
            ├─ filter by pattern
            ├─ spawn execute_webhook (HTTP + log)  // 不长期占 permit
            └─ drop permit
```

### 连接预算

```
create/update tenant_databases.max_connections
  ├─ validate 1..=50
  └─ SUM(max_connections) WHERE (db_host, db_port) = target
       AND id <> self  + requested  ≤ TENANT_POOL_GLOBAL_MAX_CONNECTIONS
```

### AIO 入口

```
entrypoint.sh (every boot)
  └─ apply_pg_conf: listen_addresses / max_connections / shared_buffers / work_mem
       └─ then existing start / migrate / supervisord
```

## 环境变量

| 变量 | 默认 | 含义 |
|------|------|------|
| `WEBHOOK_DISPATCH_CONCURRENCY` | `16` | 同时进行中的 webhook dispatch 数 |
| `WEBHOOK_CONFIG_CACHE_TTL_SECS` | `30` | 活跃 webhook 配置缓存秒数 |
| `TENANT_POOL_GLOBAL_MAX_CONNECTIONS` | `60` | 同一 `(host,port)` 上租户池 max 之和上限 |
| `AIO_PG_MAX_CONNECTIONS` | `120` | AIO postgresql.conf |
| `AIO_PG_SHARED_BUFFERS` | `256MB` | AIO postgresql.conf |
| `AIO_PG_WORK_MEM` | `4MB` | AIO postgresql.conf |

## 错误与兼容

- 预算/单库上限超限 → `AppError::InvalidQuery`（HTTP 400），文案含当前占用与上限。
- 已有 `max_connections > 50` 的行可读可跑；再次更新该字段时须落入新规则。
- Webhook 缓存未命中或 DB 短暂失败：行为与现网一致（打 error 并跳过该事件）；池自愈后后续事件恢复。

## 运维备注（拆库建议，本次不实施）

1. 崩溃现场：查 `postgresql.log` 中 `server process (PID …) was terminated by signal …`，并对照 `dmesg` / 容器 OOMKilled。
2. AIO 同 cgroup 下 PG 与应用争内存；若 OOM 复现，将 Postgres 拆到独立容器/主机并单独 memory limit，应用只连远程 `DATABASE_URL`。
3. 成功标准：事件风暴下管理池不再被 webhook 全表查询打满；同 host 预算超限可拒；AIO 重启后 conf 含新参数。

## 测试

- Webhook：TTL 命中不重复查库；过期后重查；并发/TTL 默认值与 env 解析单测。
- 连接预算：纯函数 `1..=50`、同 host 超预算拒绝、不同 host 互不影响、更新排除自身。
- `cargo test` 相关模块；`entrypoint` 调优用 shell 片段或文档手工核对（不强制容器集成测）。

## 风险

- TTL 30s 内 webhook 配置变更延迟生效。
- 单库上限降至 50 可能影响依赖更大池的运维脚本（可用 env 预算与文档说明；单库 cap 本次固定 50，若需可后续再 env 化）。
- AIO `shared_buffers=256MB` 在极小内存机器上仍可能偏大；可用 env 下调。
