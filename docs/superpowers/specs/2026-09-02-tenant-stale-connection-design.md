# 租户库死连接：空闲探活 + 首条 IO 重试

状态：已批准（2026-09-02 下午按代理层整实例重置修订根因）<br>
日期：2026-09-02<br>
关联：`src/pool_manager.rs`、`src/error.rs`、`src/raw_sql_guard.rs`、`src/pool_metrics.rs`<br>
前序：`docs/superpowers/specs/2026-07-27-tenant-pool-keepalive-design.md`

## 背景

生产工作流间歇失败，两种指纹是**同一瞬间事件的两种形态**：

| 报错 | 场景 |
|------|------|
| `error communicating with database: expected to read 5 bytes, got 0 bytes at EOF` | 闲置连接被从池子取出时才发现已死 |
| `Connection reset by peer`（截图里唯一的 `Con...`） | 那一瞬间正在传输的查询被掐断 |

与 2026-08-28 首次实锤的 EOF 指纹一字不差。

## 根因（2026-09-02 15:42 修订）

`pg_postmaster_start_time = 2026-07-29 15:22:06`（PG 进程未重启），但当时 `pg_stat_activity` 共 194 条连接，**全部** `backend_start >= 15:42:38`，没有更老的。

这不是「几条闲置连接被 NAT 随机杀掉」：局部静默回收不可能让**所有客户端**的连接在同一秒归零。符合的解释是 **RDS 代理 / VIP / 网络层一次批量重置**——host `pgm-rj9mm9h8ni97ub323o.pg.rds-aliyun-america...` 的 `pgm-` 前缀是阿里云 RDS **代理端点**典型命名；代理切换/重启/扩缩容可以在 postmaster 无感知的情况下踢光经过它的 TCP。

同日已发生两次（11:14、15:42），间隔约 4.5 小时。每次都是失败一次、数秒到十几秒自愈，没有持续性故障。

缩短 `idle_timeout`（原方案 A）对「瞬间全灭」无效：连接年龄再新也会一起死。

应用侧必须按「代理层会定期/突发踢连接」来兜底，不能指望 RDS/网络层不出事。NAT 闲置回收仍可能作为**次要**背景噪声存在，但今天两次事故的主因是整实例重置。

## 目标

- 缩小跨境链路上死连接的存活窗口，且**不**对每次 `acquire` 加一趟业务 RTT。
- 撞上死连接时，在**尚未成功执行业务语句**之前自动换连接重试 1 次。
- 保持 `test_before_acquire = false`、`idle_timeout` 默认 600、`min_connections` 默认 1。

## 非目标

- 不升级 sqlx 0.7（0.8 才有 `PgConnectOptions::keepalives_idle`）。
- 不改 `TENANT_DB_IDLE_TIMEOUT` 默认值：sqlx 的 `idle_timeout` **不回收低于 `min_connections` 的连接**，只改它治不到 min=1 的常驻连接。
- 不在 HTTP GET / workflow 入口按 method 重试（写节点与多语句事务会误伤）。
- 不给 Auto API 每条 `pool.execute` 套重试（由空闲探活覆盖；首条 IO 重试挂在已有 `acquire` + `SET` 路径）。
- 不引入 PgBouncer，不改部署拓扑。

## 关键决定

| # | 决定 | 结论 |
|---|------|------|
| 1 | **优先做 B** | 代理层整实例重置后，下一次请求的第一条 IO 必撞死连接；重试 1 次即可自愈 |
| 2 | 方案 A | **不做**。缩短 `idle_timeout` 挡不住瞬间全灭 |
| 3 | 方案 C（空闲探活） | **保留，次要**。重置后 60s 内清掉池里尸体；也覆盖真正的 NAT 闲置回收。不是这次主因的对策 |
| 4 | 探活间隔 | 默认 60s（`TENANT_DB_IDLE_PING_SECS`）；`0` = 关闭 |
| 5 | 探活方式 | 只 `try_acquire`：没有空闲连接就跳过 |
| 6 | B 挂载点 | `acquire` + `apply_session_guards`（该连接第一条 IO）失败且签名是死连接 → 换连接再 SET **1 次** |
| 7 | 错误签名 | `expected to read` + `got 0 bytes` / Io `UnexpectedEof`·`ConnectionReset`·`BrokenPipe`·`ConnectionAborted` / `connection reset` / `broken pipe` |
| 8 | 不重试 | `PoolTimedOut`、SQLSTATE 业务错误、**已经成功执行过业务 SQL** 之后的失败（含重置瞬间正在跑的那条查询） |
| 9 | 调用点 | 工作流 PG 节点、`/query`、`/transaction`、raw SQL autocommit；抽 `acquire_with_guards` |

## 架构

```
后台（每 60s）
  POOL_MANAGER 快照 primary + replica
    └─ try_acquire
         ├─ None → skip
         └─ Some(conn) → SELECT 1
              ├─ Ok → 归还（顺带刷新 NAT）
              └─ Io/EOF → sqlx 丢弃死连接

业务请求
  acquire_with_guards
    ├─ acquire_traced
    └─ apply_session_guards   ← 该连接第一条 IO
         ├─ Ok → 交业务 SQL
         └─ 死连接签名且未重试 → warn，换连接再来一次
```

空闲探活失败只打 warn，不影响请求、不摘池。

## 环境变量

| 变量 | 默认 | 含义 |
|------|------|------|
| `TENANT_DB_IDLE_PING_SECS` | `60` | 空闲探活间隔秒；`0` 关闭 |

## 风险

- 每个已加载租户池每 60s 最多 1 条空闲连接一次跨境 RTT；相对 `test_before_acquire` 的每请求 RTT 可接受。
- 探活间隔内仍可能撞上死连接，由 B 兜住。
- 探活与业务抢空闲连接：`try_acquire` 失败即让路，不排队。

## 测试

- 死连接签名：命中 EOF / reset / broken pipe；不误伤 `PoolTimedOut`、唯一约束、空串。
- `retry_once_if_stale`：死连接重试一次后成功；非死连接不重试；连续两次死连接只试两遍。
- `TENANT_DB_IDLE_PING_SECS` 解析：默认 60、`0` 关闭、非法回退。
- `cargo test` 相关模块。
