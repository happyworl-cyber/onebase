# 定时任务（Scheduled Tasks）能力设计

> 状态：design approved（2026-05-14），待 spec review。
>
> 上游设计：`docs/superpowers/specs/2026-05-13-platform-evolution-design.md`（本能力将作为 M9 加入路线图）。

## 1. 目标与非目标

### 1.1 目标

让平台具备「按时间表自动触发动作」的能力，覆盖两类用户与两类执行体：

- **平台超管**：维护类任务（清理过期 session、归档审计日志、聚合统计、license 校验）
- **业务租户**：业务调度类任务（每天结算、定时报表、批量通知）
- **执行体**：调用 PG 函数（RPC，复用现有 rbac 调用栈）或发起 HTTP 请求（复用 webhook 出口客户端）

### 1.2 非目标

| 不做 | 替代方案 |
|---|---|
| 原始 SQL 任务类型 | 写 PG 函数 + 调 RPC（前面问题 7 已经定调） |
| Cron 表达式 GUI 构建器 | v1 用字符串输入框 + 后端 `/validate-cron` 校验；v2 再做 GUI |
| 任务依赖（A 完成后触发 B） | 用 HTTP 任务回调另一个任务 endpoint 凑合；真要做应另立"工作流引擎"专项 |
| 任务分组 / 标签 / 文件夹 | 列表搜索 `name` 模糊匹配；v2 再扩 |
| 输出物外链（S3/OSS） | `output` JSONB 截断到 200KB 直接落库，超长写 `{truncated: true}` |
| WebSocket 实时推送任务状态 | 复用 M5 的 events/realtime；只需要在 `events.rs` 加 `scheduled_task.completed` 事件类型 |
| 任务版本控制 / 审批流 | 任务变更走 `audit_logs`（已有）；正式审批 M8 再说 |
| `pg_cron` 扩展 | 强依赖 PG 扩展安装权限，私有化部署受限；自研可控性高 |

## 2. 关键决定（来自 brainstorming）

| 决定 | 选项 | 理由 |
|---|---|---|
| 使用者 | **C — 超管 + 租户都能用** | 维护脚本 + 业务调度都覆盖；复用现有 RBAC 模型 |
| 执行体形态 | **B — RPC + HTTP，两种 kind** | RPC 覆盖"业务逻辑在 DB"场景；HTTP 覆盖"调外部系统"；超管想跑 SQL 写函数即可 |
| 多实例去重 | **2 — PG `SELECT ... FOR UPDATE SKIP LOCKED`** | 不引入 Redis 硬依赖；PG 行锁负责释放；多 replica 安全 |
| Cron 表达式 | **5 字段标准 cron + IANA 时区** | 行业标准，使用 `cron` crate；`chrono-tz` 提供 DST/时区数据 |
| 鉴权身份 | **`created_by` 用户身份每次重读** | 任务创建者被降权后任务自动失去对应权限 |
| HTTP 协议 | **默认仅 https**，`ALLOW_INSECURE_SCHEDULED_HTTP=true` 才放行 http | 私有化部署常见安全要求 |

## 3. 架构

### 3.1 模块布局

```
src/scheduler/
├── mod.rs              模块入口；pub use 关键类型
├── models.rs           ScheduledTask / ScheduledTaskRun
├── cron_parser.rs      cron 表达式 → next_run_at（含时区 + DST 边界处理）
├── runner.rs           SchedulerRunner（tick + claim + execute）
└── executors.rs        RpcExecutor + HttpExecutor

src/scheduler_handlers.rs   HTTP API 层（CRUD + run-now + runs + stats）
migrations/021_scheduled_tasks.sql   schema 迁移
```

调度循环作为后台 tokio task 启动，与 `Watchdog` / `WebhookManager` 同层并列，由 `main.rs` 在启动期一次性拉起。

### 3.2 数据流

```
[API 层 CRUD] ─→ management.scheduled_tasks
                       │
                       ▼ (next_run_at <= NOW, claimed_at IS NULL)
[Runner tick @ 5s] ──→ Claim 批量（SKIP LOCKED）
                       │
              ┌────────┴────────┐
              ▼                 ▼
        [RpcExecutor]    [HttpExecutor]
              │                 │
              ▼                 ▼
        rpc::execute_rpc    reqwest::Client
              │                 │
              └────────┬────────┘
                       ▼
              [写 scheduled_task_runs]
              [更新 task last_*/next_run_at]
              [释放 claim]
```

## 4. 数据模型

### 4.1 `management.scheduled_tasks`

任务定义与调度状态合一存一行——避免"任务表 + 调度表"两表事务。

```sql
CREATE TABLE management.scheduled_tasks (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       INTEGER NULL,                  -- NULL=平台级任务（仅超管管理）
    name            VARCHAR(200) NOT NULL,
    description     TEXT,

    -- 触发
    cron_expr       VARCHAR(100) NOT NULL,         -- "0 */6 * * *"
    timezone        VARCHAR(50)  NOT NULL DEFAULT 'UTC',  -- IANA tz name

    -- kind 与对应字段
    kind            VARCHAR(20)  NOT NULL,         -- 'rpc' | 'http'

    -- kind=rpc
    database_id     INTEGER,
    rpc_schema      VARCHAR(63),
    rpc_fn_name     VARCHAR(63),
    rpc_args        JSONB,

    -- kind=http
    http_method     VARCHAR(10),                   -- 'POST' | 'GET'
    http_url        TEXT,
    http_headers    JSONB,
    http_body       JSONB,
    http_secret_enc TEXT,                          -- 加密（复用 crypto::encrypt_secret v2:）

    -- 运行控制
    is_active       BOOLEAN NOT NULL DEFAULT true,
    timeout_secs    INTEGER NOT NULL DEFAULT 60,
    max_retries     INTEGER NOT NULL DEFAULT 0,
    overlap_policy  VARCHAR(20) NOT NULL DEFAULT 'skip',  -- 'skip' | 'allow'

    -- 调度状态
    next_run_at     TIMESTAMPTZ,
    last_run_at     TIMESTAMPTZ,
    last_run_status VARCHAR(20),
    claimed_at      TIMESTAMPTZ,                   -- NULL=可被认领
    claimed_by      VARCHAR(100),                  -- runner_id

    created_by      INTEGER NOT NULL,              -- users.id；任务执行身份
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_kind_rpc CHECK (
        kind <> 'rpc' OR (database_id IS NOT NULL AND rpc_schema IS NOT NULL AND rpc_fn_name IS NOT NULL)
    ),
    CONSTRAINT chk_kind_http CHECK (
        kind <> 'http' OR (http_method IS NOT NULL AND http_url IS NOT NULL)
    ),
    CONSTRAINT chk_overlap CHECK (overlap_policy IN ('skip', 'allow'))
);

CREATE INDEX idx_st_due ON management.scheduled_tasks(next_run_at)
    WHERE is_active = true AND claimed_at IS NULL;
CREATE INDEX idx_st_tenant ON management.scheduled_tasks(tenant_id);
CREATE INDEX idx_st_stale_claim ON management.scheduled_tasks(claimed_at)
    WHERE claimed_at IS NOT NULL;
```

### 4.2 `management.scheduled_task_runs`

每次执行（含 `run-now` 手动触发）写一行。

```sql
CREATE TABLE management.scheduled_task_runs (
    id              BIGSERIAL PRIMARY KEY,
    task_id         BIGINT NOT NULL REFERENCES management.scheduled_tasks(id) ON DELETE CASCADE,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at     TIMESTAMPTZ,
    status          VARCHAR(20) NOT NULL,          -- 'running'|'success'|'failed'|'timeout'|'cancelled'
    runner_id       VARCHAR(100),
    output          JSONB,                          -- 截断到 200KB
    error_message   TEXT,
    duration_ms     INTEGER,
    attempt_number  INTEGER NOT NULL DEFAULT 1,
    triggered_by    VARCHAR(20) NOT NULL DEFAULT 'cron'  -- 'cron' | 'manual'
);

CREATE INDEX idx_str_task ON management.scheduled_task_runs(task_id, started_at DESC);
CREATE INDEX idx_str_status ON management.scheduled_task_runs(status, started_at DESC);
```

**`output` 截断策略**：handler 处发现 `serde_json::to_vec(value).len() > 200 * 1024` 则替换为 `{"truncated": true, "size_bytes": N, "preview": <头 8KB>}`。

## 5. 调度循环

### 5.1 `SchedulerRunner` 结构

```rust
pub struct SchedulerRunner {
    pool: PgPool,
    runner_id: String,        // "{hostname}-{pid}-{startup_ns}"，启动时一次性算
    config: SchedulerConfig,
    rpc_exec: Arc<RpcExecutor>,
    http_exec: Arc<HttpExecutor>,
    running: Arc<AtomicBool>, // 与 watchdog 共享 shutdown 机制
}

pub struct SchedulerConfig {
    pub tick_interval: Duration,      // 默认 5s
    pub batch_size: i64,               // 默认 32
    pub stale_claim_grace_secs: i64,  // 默认 30
    pub retry_base_secs: i64,          // 默认 60
    pub retry_factor: u32,             // 默认 2
    pub allow_insecure_http: bool,     // 默认 false
}
```

### 5.2 一次 tick 三步走

**Step 1 — 回收陈旧 claim**：实例崩溃 / 断电后，PG 行锁会被连接关闭释放，但 `claimed_at` 列还在；下一个活着的 runner tick 时回收。

```sql
UPDATE management.scheduled_tasks
SET claimed_at = NULL, claimed_by = NULL
WHERE claimed_at IS NOT NULL
  AND claimed_at < NOW() - (timeout_secs + $1) * INTERVAL '1 second';
```

**Step 2 — Claim 一批 due 任务**：`SELECT ... FOR UPDATE SKIP LOCKED` 是 PG 工作队列的标准做法。

```sql
UPDATE management.scheduled_tasks
SET claimed_at = NOW(), claimed_by = $1
WHERE id IN (
    SELECT id FROM management.scheduled_tasks
    WHERE is_active = true
      AND claimed_at IS NULL
      AND next_run_at <= NOW()
    ORDER BY next_run_at ASC
    LIMIT $2
    FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

**Step 3 — 并发执行**：每个 claimed task 独立 `tokio::spawn`，不阻塞下一次 tick。

### 5.3 `execute_one` 关键路径

```rust
async fn execute_one(&self, task: ScheduledTask) {
    let run_id = self.create_run_record(&task, "cron").await;
    let timeout = Duration::from_secs(task.timeout_secs as u64);

    let exec_future = match task.kind.as_str() {
        "rpc"  => self.rpc_exec.execute(&task).boxed(),
        "http" => self.http_exec.execute(&task).boxed(),
        _      => return self.fail_run(run_id, "unknown kind").await,
    };

    let result = tokio::time::timeout(timeout, exec_future).await;

    let outcome = match result {
        Ok(Ok(_))           => Outcome::Success,
        Ok(Err(business_err)) => Outcome::Failed(business_err),
        Err(_elapsed)       => Outcome::Timeout,
    };

    let next_run_at = match outcome {
        Outcome::Success => self.cron_next(&task),
        Outcome::Failed(_) | Outcome::Timeout => {
            let attempt = self.current_attempt_number(task.id).await;
            if attempt < task.max_retries {
                // 走指数退避；若退避后时刻已 >= cron 下一次触发点，
                // 直接回到 cron 节奏并把 attempt 重置（视为"重试窗口溢出，放弃重试"）。
                let backoff_at = NOW + Duration::seconds(
                    self.config.retry_base_secs *
                    self.config.retry_factor.pow(attempt - 1) as i64
                );
                let cron_at = self.cron_next(&task);
                if backoff_at >= cron_at { cron_at } else { backoff_at }
            } else {
                self.cron_next(&task)
            }
        }
    };

    // 同事务：写 run 终态 + 更新 task last_*/next_run_at + 释放 claim
    let mut tx = self.pool.begin().await?;
    self.finalize_run(&mut tx, run_id, &result).await;
    self.release_task(&mut tx, task.id, next_run_at, &result).await;
    tx.commit().await;
}
```

### 5.4 cron 解析

`src/scheduler/cron_parser.rs`：薄封装 `cron` crate + `chrono_tz::Tz`。

```rust
pub fn next_after(expr: &str, tz: &str, after: DateTime<Utc>) -> Result<DateTime<Utc>> {
    let tz: chrono_tz::Tz = tz.parse()
        .map_err(|_| AppError::InvalidQuery(format!("无效时区: {}", tz)))?;
    let schedule: cron::Schedule = expr.parse()
        .map_err(|e| AppError::InvalidQuery(format!("无效 cron 表达式: {}", e)))?;
    let local = after.with_timezone(&tz);
    schedule.after(&local).next()
        .map(|t| t.with_timezone(&Utc))
        .ok_or_else(|| AppError::Internal("cron 表达式无下一个触发点".into()))
}
```

需测的边界情形（写进 cron_parser 单测）：

- `0 */6 * * *` 标准每 6 小时
- `* * * * *` 每分钟（最小粒度，runner tick 5s 仍能覆盖）
- `0 2 * * *` 在 `America/New_York` 时区跨 DST 转换日（3 月跳跃 / 11 月重复）
- 非法表达式 → 400
- 非法时区 → 400

## 6. 执行器

### 6.1 `RpcExecutor`

```rust
impl RpcExecutor {
    async fn execute(&self, task: &ScheduledTask) -> ExecResult {
        // 每次重读 created_by 的 is_active / is_superadmin，
        // 避免任务创建者被禁用 / 降权后仍以快照身份跑。
        let claims = match self.synthesize_claims_for(task.created_by).await {
            Ok(c) => c,
            Err(SynthErr::UserDisabled)   => return ExecResult::Err("created_by 用户已禁用".into()),
            Err(SynthErr::UserNotFound)   => return ExecResult::Err("created_by 用户已被删除".into()),
            Err(SynthErr::Db(e))          => return ExecResult::Err(format!("身份合成失败: {e}")),
        };
        let args = task.rpc_args.clone().unwrap_or(json!({}));

        // 调 execute_rpc_inner —— 与 axum handler 等价的纯逻辑函数
        // （database_id 路由 + RBAC permission/condition 求值 + 实际执行）。
        // 该函数在 PR-2 中从原 handler 中抽出，原 handler 改造为瘦壳。
        let resp = crate::rpc::execute_rpc_inner(
            &self.pool,
            task.database_id.unwrap(),
            task.rpc_schema.as_ref().unwrap(),
            task.rpc_fn_name.as_ref().unwrap(),
            args,
            &claims,
        ).await?;

        ExecResult::Ok(resp)
    }
}
```

**实施说明**：
- 当前 `src/rpc.rs` 只暴露 `execute_rpc` axum handler，签名带 `Extension<Claims>` / `Path<…>` 等 axum 类型。PR-2 要做小重构：抽 `execute_rpc_inner(pool, database_id, schema, fn_name, args, claims) -> Result<Value>`，原 handler 改成 1-2 行的瘦壳。
- "RBAC 等价"是指**逻辑等价**，不是"调用同一个 `rbac_middleware` 实例"——后者是 axum Layer，不在 scheduler 路径上。inner 函数内会显式调 permission 检查代码（与中间件内部相同的 helper）。

### 6.2 `HttpExecutor`

复用 `webhook_manager` 同一套 reqwest client + HMAC-SHA256 签名头规范。

```rust
impl HttpExecutor {
    async fn execute(&self, task: &ScheduledTask) -> ExecResult {
        let url = task.http_url.as_ref().unwrap();

        if !url.starts_with("https://") && !self.config.allow_insecure_http {
            return ExecResult::Err("HTTP URL 必须 https（或显式开启 ALLOW_INSECURE_SCHEDULED_HTTP）".into());
        }

        let body = task.http_body.clone().unwrap_or(json!({}));
        let mut req = self.client.request(parse_method(&task.http_method)?, url);

        // 自定义 headers
        if let Some(headers) = task.http_headers.as_ref() {
            for (k, v) in headers.as_object().unwrap_or(&Default::default()) {
                req = req.header(k, v.as_str().unwrap_or(""));
            }
        }

        // HMAC 签名（同 webhook）
        if let Some(enc) = task.http_secret_enc.as_ref() {
            let secret = crate::crypto::decrypt_secret_lossy(enc);
            let signature = hmac_sha256(&secret, &serde_json::to_vec(&body)?);
            req = req.header("X-Onebase-Signature", signature);
        }

        let resp = req.json(&body).send().await?;
        let status = resp.status();
        let body = resp.bytes().await?;

        if status.is_success() {
            ExecResult::Ok(serde_json::from_slice(&body).unwrap_or(json!({"raw": String::from_utf8_lossy(&body)})))
        } else {
            ExecResult::Err(format!("HTTP {}", status))
        }
    }
}
```

## 7. API 层

### 7.1 路由清单

| 方法 | 路径 | 描述 | 鉴权 |
|---|---|---|---|
| POST | `/api/admin/scheduled-tasks` | 创建任务 | 超管 或 租户 owner/admin（按 body.tenant_id） |
| GET | `/api/admin/scheduled-tasks` | 列表 | 同上；列表按可见 tenant_id 过滤 |
| GET | `/api/admin/scheduled-tasks/:id` | 详情（含最近 5 次 runs） | 可见即可查 |
| PATCH | `/api/admin/scheduled-tasks/:id` | 更新（改 cron 重算 next_run_at） | 创建者权限 |
| DELETE | `/api/admin/scheduled-tasks/:id` | 删除（CASCADE 清 runs） | 同上 |
| POST | `/api/admin/scheduled-tasks/:id/run-now` | 立即触发一次（写 triggered_by='manual'） | 同上 |
| POST | `/api/admin/scheduled-tasks/:id/pause` | 置 is_active=false | 同上 |
| POST | `/api/admin/scheduled-tasks/:id/resume` | 置 is_active=true 并重算 next_run_at | 同上 |
| GET | `/api/admin/scheduled-tasks/:id/runs` | 执行历史分页（limit≤100） | 可见即可查 |
| GET | `/api/admin/scheduled-tasks/stats` | 仪表盘：总数 / 24h 执行 / 失败率 | 仅超管 |
| POST | `/api/admin/scheduled-tasks/validate-cron` | 校验 `cron_expr + timezone`，返回前 5 个 next_run_at | 已登录 |
| POST | `/api/admin/scheduled-tasks/runs/cleanup-zombies` | 批量将 `status=running` 且 `started_at < now - N` 的 runs 改为 timeout | 仅超管 |

### 7.2 鉴权辅助函数

```rust
async fn validate_can_manage(
    claims: &Claims,
    task_tenant_id: Option<i32>,
    pool: &PgPool,
) -> Result<()> {
    if claims.is_superadmin { return Ok(()); }
    match task_tenant_id {
        None => Err(AppError::Forbidden("平台级任务仅超管可管理".into())),
        Some(t) => {
            let admins = admin_tenant_ids(pool, claims).await?;
            if admins.contains(&t) { Ok(()) }
            else { Err(AppError::Forbidden("仅租户 owner/admin 可管理此项目的任务".into())) }
        }
    }
}
```

`admin_tenant_ids` 是 audit_handlers 已有的 helper，原样复用。

### 7.3 创建/更新校验

- `cron_expr` 当场用 cron crate 解析，不能解析 → 400
- `timezone` 当场用 `chrono_tz::Tz::from_str` 校验，不存在 → 400
- `kind=rpc` 时 `database_id` 必须存在且 active；按 `tenant_id` 分两种校验：
  - `tenant_id IS NOT NULL`（租户级任务）：`database_id` 必须属于该 `tenant_id` 对应的库（防止跨租户调函数）
  - `tenant_id IS NULL`（平台级任务，仅超管可创建）：`database_id` 可以是任意 active 库，不做归属约束
- `kind=http` 时 URL 默认 https-only（除非 `ALLOW_INSECURE_SCHEDULED_HTTP=true`）
- `http_secret`：明文进，加密后写库；返回时只露 `has_secret: true`，明文绝不回显

## 8. 失败处理 / 重试 / overlap

### 8.1 状态机

| 情形 | runner 行为 | 任务表写入 | runs 表写入 |
|---|---|---|---|
| `execute_one` 成功 | release claim | `last_run_status='success'`, `next_run_at`=cron next | 一行 `status='success'`, `output` |
| 业务失败（RPC 抛错 / HTTP non-2xx） | release claim | `last_run_status='failed'`, `next_run_at`=max(cron next, NOW+backoff) | 一行 `status='failed'`, `error_message` |
| `tokio::time::timeout` 触发 | 强制 release claim（task 可能还在跑，但 PG 视角已释放） | `last_run_status='timeout'` | 一行 `status='timeout'` |
| runner 进程崩溃 | 不发生 release | `claimed_at` 保留，下一次 tick Step 1 回收 | runs 行停留在 `status='running'`（zombie） |
| 用户 pause | runner 不感知；正在跑的不打断 | `is_active=false`，下次 tick 不 claim | — |

### 8.2 重试

仅业务失败 / 超时触发重试：

```
attempt 1: cron 时刻触发，失败
attempt 2: NOW + (retry_base_secs * retry_factor^0) = NOW + 60s
attempt 3: NOW + (retry_base_secs * retry_factor^1) = NOW + 120s
attempt 4: NOW + (retry_base_secs * retry_factor^2) = NOW + 240s
…
attempt > max_retries: 放弃，回到正常 cron 节奏（下一次 cron 触发时 attempt 重置为 1）
```

**重试窗口溢出规则**：

若 `NOW + backoff_secs >= cron_next_at`（即退避后已经追上 / 超过 cron 下一次触发点），则放弃这一轮重试，`next_run_at = cron_next_at` 并把 `attempt_number` 重置为 1。

- 防止"重试时间窗" 把本该触发的下一次 cron 排程整个挤掉
- 例：cron `* * * * *`（每分钟），`retry_base_secs=60`，第一次重试时间 = NOW+60s ≈ 下一次 cron 时刻，所以 max_retries 高于 1 实际上仍然只会重试 1 次

`max_retries=0`（默认）等价于不重试。

### 8.3 overlap policy

只有「同一 task 上一次 run 还没结束，cron 又到点」时这条策略生效。判定方式：claim 时检查同 task_id 是否存在 `status='running'` 的 run 行。

- `skip`（默认）：跳过这一次 trigger，写一行 `status='cancelled', error_message='overlap with previous run'`，next_run_at 推到 cron 再下一次
- `allow`：允许并发，开新 run，attempt_number 与上一次无关

**没有 `cancel_prev`**——技术上可行但语义复杂（要主动 abort 上一个 tokio task），v1 不做。

### 8.4 zombie runs 清理

zombie = runs 行 `status='running'` 且 `started_at < now() - threshold`，常见原因：runner 进程崩溃后 task 来不及写终态。

`POST /api/admin/scheduled-tasks/runs/cleanup-zombies { older_than_hours: 24 }` 把这类行批量改成 `status='timeout', error_message='zombie cleanup'`。

**故意不做后台自动清理**——zombie 行本身是 incident 信号，应让运维看到。

## 9. 配置项

```bash
SCHEDULER_TICK_INTERVAL_SECS=5         # 调度循环周期
SCHEDULER_BATCH_SIZE=32                # 单次 tick 最多 claim 任务数
SCHEDULER_STALE_CLAIM_GRACE_SECS=30    # 超时 + 此值后视为陈旧 claim 自动释放
SCHEDULER_RETRY_BASE_SECS=60           # 重试指数退避起点
SCHEDULER_RETRY_FACTOR=2               # 退避倍数
ALLOW_INSECURE_SCHEDULED_HTTP=false    # 默认禁止 http://
```

全部由 `src/config.rs` 解析，无 fallback 报错则用默认值（保持现有 config 风格）。

## 10. 安全模型对照

| 维度 | 实现 |
|---|---|
| 谁能创建 | 平台级任务（tenant_id=NULL）：仅超管；租户级任务：超管 + 该租户 owner/admin |
| 谁能编辑 / 删除 | 同上；handler 内 `validate_can_manage` 守门 |
| 任务执行身份 | `task.created_by` 用户身份（每次重读 `is_active` + `is_superadmin`；用户被禁用 / 删除 → run 直接 `status='failed'`，不再 fallback 任何身份） |
| RPC kind 鉴权 | `execute_rpc_inner` 内部走与 `rbac_middleware` **逻辑等价** 的 permission / condition 求值代码（不是同一个 axum Layer 实例） |
| HTTP kind 鉴权 | 默认 https；可选 HMAC-SHA256 签名（与 webhook 同套规范） |
| Secret 加密 | `http_secret` 通过 `crypto::encrypt_secret` 落 `http_secret_enc`（v2: 前缀，AES-256-GCM） |
| 审计 | 任务 CRUD（API 触发）走 `audit_middleware` 自动落 `audit_logs`；定时触发的执行**不**走 axum 中间件，仅落 `scheduled_task_runs` 一张表（每行 = 一次执行的完整审计） |
| 限流 | 经过全局 `rate_limit_middleware`；可在 `management.rate_limit_rules` 给 `/api/admin/scheduled-tasks/*` 配专属阈值 |

README.md `2.2` 节会新增一行简述。

## 11. 文件清单

**新增（8 个）：**

```
migrations/021_scheduled_tasks.sql              schema 迁移
src/scheduler/mod.rs                            模块入口
src/scheduler/models.rs                         ScheduledTask / ScheduledTaskRun 结构体
src/scheduler/cron_parser.rs                    cron 表达式 → next_run_at
src/scheduler/runner.rs                         SchedulerRunner（tick + claim + execute）
src/scheduler/executors.rs                      RpcExecutor + HttpExecutor
src/scheduler_handlers.rs                       HTTP API 层
docs/superpowers/specs/2026-05-14-scheduled-tasks-design.md   本文档
```

**修改（6 个）：**

```
Cargo.toml                                      加 cron + chrono-tz 依赖
src/main.rs                                     mod scheduler；启动 runner；挂 handlers 路由
src/config.rs                                   加 6 个 SCHEDULER_*/ALLOW_* 配置
src/rpc.rs                                      抽 inner 函数（让 RpcExecutor 不走 handler 入口）
README.md                                       2.2 节新增"定时任务"安全模型说明
docs/superpowers/specs/2026-05-13-platform-evolution-design.md   M9 加入路线图 + v2 表新增一行
```

## 12. 测试策略

| 层 | 覆盖点 |
|---|---|
| `cron_parser` 单测 | 合法 / 非法表达式；`@daily` 别名；跨 DST 边界（`America/New_York` 3 月跳跃 / 11 月重复）；不存在的时区 |
| `runner` 单测 | 陈旧 claim 回收 SQL；SKIP LOCKED 行为（用 sqlx test pool）；重试退避计算；overlap 策略选择 |
| `executors` 单测 | RpcExecutor 路径（mock `rpc::execute_rpc_inner`）；HttpExecutor 路径（mock reqwest client）；https-only 强制；secret 加解密往返 |
| `handler` 单测 | 鉴权矩阵：超管 / tenant admin / 普通用户 × 平台任务 / 自己租户任务 / 别人租户任务 |
| 集成测（shell） | 起 2 个 runner 同步指同一 PG，每个 due 任务只跑一次；pause / resume / run-now / cleanup-zombies |
| 手测 checklist | 起 1 runner，配 cron `* * * * *`，观察 5 分钟看 runs 表 5 行 |

## 13. 配置迁移与上线步骤

1. **PR-1 — schema + 模块骨架**：migrations/021、`src/scheduler/{mod,models,cron_parser}.rs`、单测覆盖 cron_parser
2. **PR-2 — runner + executors**：`runner.rs`、`executors.rs`、`src/rpc.rs` 抽 inner、单测
3. **PR-3 — API 层**：`scheduler_handlers.rs`、`main.rs` 挂路由、`config.rs`、`Cargo.toml` 加依赖
4. **PR-4 — 前端 + 文档**：dashboard 配置 UI（cron 输入框 + 任务列表 + runs 历史）、README、platform-evolution-design.md 更新

每个 PR 都能独立 merge 不影响生产（前面 PR merge 后即使 PR-3 没合，runner 也不会起，新增表不会被写）。

## 14. 待商议项 / 已知留白

| 项 | 当前决策 | 备选 |
|---|---|---|
| 重试上限 | `max_retries` 列上限默认 5（DB CHECK 或前端校验） | 不设上限 |
| `output` 截断阈值 | 200KB | 可配置 `SCHEDULER_OUTPUT_MAX_KB` |
| 任务总数上限 | 不设硬上限，靠 PG 索引兜底 | v2 加 `tenant_max_tasks` 配额 |
| 时间精度 | tick 5s，最坏延迟 5s | 1s 也能跑，但 tick 期间 SQL 压力 5 倍——保持 5s |

---

**设计结束。**实施按 §13 的四个 PR 分批推进；spec self-review 与 user review 通过后启动 PR-1。
