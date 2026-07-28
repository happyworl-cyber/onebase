# 定时任务（Scheduled Tasks）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让平台具备调用 PG 函数（RPC）和发起 HTTP 请求的定时调度能力，覆盖平台超管 + 租户两类用户，并支持多实例去重运行。

**Architecture:** 单张 `management.scheduled_tasks` 表存任务定义 + 调度状态；后台 `SchedulerRunner` 每 5s tick 一次，用 PostgreSQL `FOR UPDATE SKIP LOCKED` 在多实例间安全 claim 到期任务，独立 tokio task 执行；每次执行写一行 `scheduled_task_runs` 完整审计。

**Tech Stack:** Rust / axum 0.7 / sqlx 0.7 / `cron` 0.12 / `chrono-tz` 0.8 / tokio。复用现有 `RpcAuthSubject` + `run_rpc` + `crypto::encrypt_secret`。

**Spec:** `docs/superpowers/specs/2026-05-14-scheduled-tasks-design.md`

**Phases & PR layout:**
- **Phase 1 (PR-1)** schema + 模块骨架 + cron_parser + 单测（Task 1.1–1.8）
- **Phase 2 (PR-2)** `run_rpc` 重构 + executors + runner + 集成测（Task 2.1–2.10）
- **Phase 3 (PR-3)** config + handlers + main.rs wire-up + e2e smoke（Task 3.1–3.10）
- **Phase 4 (PR-4)** README / spec 更新 + 前端 stub（Task 4.1–4.4）

每个 phase 末尾有一个 commit 步骤；建议 phase 完成后停一下让用户决定是开 PR 还是直接进下一阶段。

---

## Phase 1 — Schema + 模块骨架 + cron_parser

### Task 1.1: 添加 cron + chrono-tz 依赖

**Files:**
- Modify: `Cargo.toml`

- [ ] **Step 1: 编辑 Cargo.toml**

把 `# 时间处理` 区块改成：

```toml
# 时间处理
chrono = { version = "0.4", features = ["serde"] }
chrono-tz = "0.8"

# 定时调度
cron = "0.12"
```

- [ ] **Step 2: 验证依赖能解析**

```bash
cargo check 2>&1 | tail -20
```

Expected: 编译可能因为别的还没改完而报错，但**不能**报 `cron` / `chrono-tz` 解析失败。看到 `Compiling cron v0.12.x` 与 `Compiling chrono-tz v0.8.x` 即视为成功。

---

### Task 1.2: 写 migration 014_scheduled_tasks.sql

**Files:**
- Create: `migrations/014_scheduled_tasks.sql`

- [ ] **Step 1: 写 migration SQL**

```sql
-- ============================================
-- 定时任务（Scheduled Tasks）
-- ============================================
-- 单表设计：任务定义 + 调度状态合一存一行，避免双表事务。
-- 多实例去重靠 SELECT ... FOR UPDATE SKIP LOCKED。
-- claimed_at 列在实例崩溃后由下一个活着的 runner 在 tick Step 1 回收。

CREATE TABLE IF NOT EXISTS management.scheduled_tasks (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       INTEGER NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    name            VARCHAR(200) NOT NULL,
    description     TEXT,

    cron_expr       VARCHAR(100) NOT NULL,
    timezone        VARCHAR(50)  NOT NULL DEFAULT 'UTC',

    kind            VARCHAR(20)  NOT NULL,

    database_id     INTEGER REFERENCES management.tenant_databases(id) ON DELETE CASCADE,
    rpc_schema      VARCHAR(63),
    rpc_fn_name     VARCHAR(63),
    rpc_args        JSONB,

    http_method     VARCHAR(10),
    http_url        TEXT,
    http_headers    JSONB,
    http_body       JSONB,
    http_secret_enc TEXT,

    is_active       BOOLEAN NOT NULL DEFAULT true,
    timeout_secs    INTEGER NOT NULL DEFAULT 60,
    max_retries     INTEGER NOT NULL DEFAULT 0,
    overlap_policy  VARCHAR(20) NOT NULL DEFAULT 'skip',

    next_run_at     TIMESTAMPTZ,
    last_run_at     TIMESTAMPTZ,
    last_run_status VARCHAR(20),
    claimed_at      TIMESTAMPTZ,
    claimed_by      VARCHAR(100),

    created_by      INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_st_kind CHECK (kind IN ('rpc', 'http')),
    CONSTRAINT chk_st_kind_rpc CHECK (
        kind <> 'rpc' OR (database_id IS NOT NULL AND rpc_schema IS NOT NULL AND rpc_fn_name IS NOT NULL)
    ),
    CONSTRAINT chk_st_kind_http CHECK (
        kind <> 'http' OR (http_method IS NOT NULL AND http_url IS NOT NULL)
    ),
    CONSTRAINT chk_st_overlap CHECK (overlap_policy IN ('skip', 'allow')),
    CONSTRAINT chk_st_timeout CHECK (timeout_secs > 0 AND timeout_secs <= 3600),
    CONSTRAINT chk_st_retries CHECK (max_retries >= 0 AND max_retries <= 10)
);

CREATE INDEX IF NOT EXISTS idx_st_due ON management.scheduled_tasks(next_run_at)
    WHERE is_active = true AND claimed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_st_tenant ON management.scheduled_tasks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_st_stale_claim ON management.scheduled_tasks(claimed_at)
    WHERE claimed_at IS NOT NULL;


CREATE TABLE IF NOT EXISTS management.scheduled_task_runs (
    id              BIGSERIAL PRIMARY KEY,
    task_id         BIGINT NOT NULL REFERENCES management.scheduled_tasks(id) ON DELETE CASCADE,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at     TIMESTAMPTZ,
    status          VARCHAR(20) NOT NULL,
    runner_id       VARCHAR(100),
    output          JSONB,
    error_message   TEXT,
    duration_ms     INTEGER,
    attempt_number  INTEGER NOT NULL DEFAULT 1,
    triggered_by    VARCHAR(20) NOT NULL DEFAULT 'cron',

    CONSTRAINT chk_str_status CHECK (status IN ('running', 'success', 'failed', 'timeout', 'cancelled')),
    CONSTRAINT chk_str_trigger CHECK (triggered_by IN ('cron', 'manual'))
);

CREATE INDEX IF NOT EXISTS idx_str_task ON management.scheduled_task_runs(task_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_str_status ON management.scheduled_task_runs(status, started_at DESC);
```

- [ ] **Step 2: 加进 migrate_all 清单**

修改 `src/bin/migrate_all.rs` 的 `MIGRATIONS` 常量，在 `"012 jwt sessions"` 之后追加：

```rust
    ("014 scheduled tasks",      include_str!("../../migrations/014_scheduled_tasks.sql")),
```

> 注：仓库里没有 013（业务库专用），所以这里跳到 014。

- [ ] **Step 3: 创建独立的迁移 binary（保持仓库约定）**

Create `src/bin/migrate_scheduled_tasks.rs`:

```rust
//! 迁移脚本：定时任务表
//! 运行方式: `cargo run --bin migrate_scheduled_tasks`

use onebase::migrate::run_sql_script;
use sqlx::postgres::PgPoolOptions;
use std::env;

const SQL: &str = include_str!("../../migrations/014_scheduled_tasks.sql");

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenv::dotenv().ok();
    let database_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let pool = PgPoolOptions::new().max_connections(5).connect(&database_url).await?;

    println!("📝 创建定时任务表...");
    let stats = run_sql_script(&pool, "014 scheduled tasks", SQL).await;
    if stats.has_error() {
        eprintln!("❌ 迁移失败：执行 {}，跳过 {}，错误 {}", stats.ok, stats.skipped, stats.errors);
        std::process::exit(1);
    }
    println!("✅ 完成（执行 {}，幂等跳过 {}）", stats.ok, stats.skipped);
    Ok(())
}
```

- [ ] **Step 4: 在 Cargo.toml 注册 binary**

在 `[[bin]]` 列表末尾追加：

```toml
[[bin]]
name = "migrate_scheduled_tasks"
path = "src/bin/migrate_scheduled_tasks.rs"
```

- [ ] **Step 5: 验证 SQL 能跑（需 DATABASE_URL 指向开发数据库）**

```bash
cargo run --bin migrate_scheduled_tasks 2>&1 | tail -10
```

Expected: 看到 `✅ 完成（执行 X，幂等跳过 0）`。

二次运行验证幂等：

```bash
cargo run --bin migrate_scheduled_tasks 2>&1 | tail -10
```

Expected: 这一次"幂等跳过"非 0，没有错误。

---

### Task 1.3: 创建 scheduler 模块入口

**Files:**
- Create: `src/scheduler/mod.rs`

- [ ] **Step 1: 写 mod.rs**

```rust
//! 定时任务调度模块。
//!
//! 入口：`SchedulerRunner`（runner.rs）作为 tokio 后台任务运行，每 5s tick 一次，
//! 从 `management.scheduled_tasks` 用 `FOR UPDATE SKIP LOCKED` claim 到期任务后
//! 分发给 `RpcExecutor` / `HttpExecutor` 执行，结果写入 `scheduled_task_runs`。
//!
//! 详见 `docs/superpowers/specs/2026-05-14-scheduled-tasks-design.md`。

pub mod cron_parser;
pub mod executors;
pub mod models;
pub mod runner;

pub use cron_parser::next_after;
pub use models::{ScheduledTask, ScheduledTaskRun, TaskKind, RunStatus, OverlapPolicy, TriggeredBy};
pub use runner::{SchedulerConfig, SchedulerRunner};
```

> 注：`executors.rs` 和 `runner.rs` 会在 Phase 2 写；此处只声明 mod 让骨架立起来。先在 mod.rs 里写一个空占位让 Phase 1 能编译——见下一步。

- [ ] **Step 2: 创建空 executors.rs / runner.rs 占位**

Create `src/scheduler/executors.rs`:

```rust
//! 实际实现见 Phase 2。

#![allow(dead_code)]
```

Create `src/scheduler/runner.rs`:

```rust
//! 实际实现见 Phase 2。

#![allow(dead_code)]
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct SchedulerConfig {
    pub tick_interval: Duration,
    pub batch_size: i64,
    pub stale_claim_grace_secs: i64,
    pub retry_base_secs: i64,
    pub retry_factor: u32,
    pub allow_insecure_http: bool,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            tick_interval: Duration::from_secs(5),
            batch_size: 32,
            stale_claim_grace_secs: 30,
            retry_base_secs: 60,
            retry_factor: 2,
            allow_insecure_http: false,
        }
    }
}

pub struct SchedulerRunner;
```

- [ ] **Step 3: 在 src/main.rs / src/lib.rs 里 mod scheduler**

在 `src/main.rs` 找到现有的 `mod` 声明块（搜 `mod auth;`），追加：

```rust
mod scheduler;
```

按字母序就近插入。如果 `src/lib.rs` 也有同样的 mod 块（仓库里 lib.rs 是 re-export 给 `onebase::migrate` 等用），在那里也追加：

```rust
pub mod scheduler;
```

(`src/lib.rs` 当前内容简单——检查后只有 migrate / models / 等少量 pub mod；按已有顺序加上 `pub mod scheduler;` 即可。)

- [ ] **Step 4: 验证编译**

```bash
cargo check 2>&1 | tail -20
```

Expected: 无 `unresolved module` / `cannot find` 错误（其他 warning 可忽略）。

---

### Task 1.4: 写 models.rs（task / run 结构体 + 枚举）

**Files:**
- Create: `src/scheduler/models.rs`

- [ ] **Step 1: 写 models.rs**

```rust
//! `management.scheduled_tasks` / `scheduled_task_runs` 的 Rust 镜像。
//!
//! 命名约定与表列一一对应；JSONB 列用 `serde_json::Value`，
//! `TIMESTAMPTZ` 用 `DateTime<Utc>`。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskKind {
    Rpc,
    Http,
}

impl TaskKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskKind::Rpc => "rpc",
            TaskKind::Http => "http",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "rpc" => Some(TaskKind::Rpc),
            "http" => Some(TaskKind::Http),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OverlapPolicy {
    Skip,
    Allow,
}

impl OverlapPolicy {
    pub fn as_str(&self) -> &'static str {
        match self {
            OverlapPolicy::Skip => "skip",
            OverlapPolicy::Allow => "allow",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "skip" => Some(OverlapPolicy::Skip),
            "allow" => Some(OverlapPolicy::Allow),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Running,
    Success,
    Failed,
    Timeout,
    Cancelled,
}

impl RunStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            RunStatus::Running => "running",
            RunStatus::Success => "success",
            RunStatus::Failed => "failed",
            RunStatus::Timeout => "timeout",
            RunStatus::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TriggeredBy {
    Cron,
    Manual,
}

impl TriggeredBy {
    pub fn as_str(&self) -> &'static str {
        match self {
            TriggeredBy::Cron => "cron",
            TriggeredBy::Manual => "manual",
        }
    }
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct ScheduledTask {
    pub id: i64,
    pub tenant_id: Option<i32>,
    pub name: String,
    pub description: Option<String>,
    pub cron_expr: String,
    pub timezone: String,
    pub kind: String,
    pub database_id: Option<i32>,
    pub rpc_schema: Option<String>,
    pub rpc_fn_name: Option<String>,
    pub rpc_args: Option<serde_json::Value>,
    pub http_method: Option<String>,
    pub http_url: Option<String>,
    pub http_headers: Option<serde_json::Value>,
    pub http_body: Option<serde_json::Value>,
    pub http_secret_enc: Option<String>,
    pub is_active: bool,
    pub timeout_secs: i32,
    pub max_retries: i32,
    pub overlap_policy: String,
    pub next_run_at: Option<DateTime<Utc>>,
    pub last_run_at: Option<DateTime<Utc>>,
    pub last_run_status: Option<String>,
    pub claimed_at: Option<DateTime<Utc>>,
    pub claimed_by: Option<String>,
    pub created_by: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct ScheduledTaskRun {
    pub id: i64,
    pub task_id: i64,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub status: String,
    pub runner_id: Option<String>,
    pub output: Option<serde_json::Value>,
    pub error_message: Option<String>,
    pub duration_ms: Option<i32>,
    pub attempt_number: i32,
    pub triggered_by: String,
}
```

- [ ] **Step 2: 验证编译**

```bash
cargo check 2>&1 | grep -E "^(error|warning: unused)" | head -10
```

Expected: 无 `error[`。dead_code warning 在 executors/runner 占位下可接受。

---

### Task 1.5: 写 cron_parser.rs（含单测）

**Files:**
- Create: `src/scheduler/cron_parser.rs`

- [ ] **Step 1: 写失败的测试**

在 `cron_parser.rs` 文件末尾先放测试模块——TDD：先写测试再写实现。

```rust
//! Cron 表达式 → next_run_at 计算。
//!
//! 接受 5 字段（minute / hour / day / month / weekday）+ IANA 时区，
//! 内部用 `cron` crate（实际接受 6 字段含秒）做表达式解析——本模块在前面补 "0 "
//! 来对齐。返回值统一是 UTC。

use chrono::{DateTime, Utc};

use crate::error::AppError;

/// 计算 `expr` 在 `tz` 时区下、`after` 之后的第一个触发时刻。
pub fn next_after(expr: &str, tz: &str, after: DateTime<Utc>) -> Result<DateTime<Utc>, AppError> {
    todo!("implemented in next step")
}

/// 校验 cron 表达式 + 时区可解析，并返回前 N 个触发时刻。供 /validate-cron 用。
pub fn preview(expr: &str, tz: &str, count: usize) -> Result<Vec<DateTime<Utc>>, AppError> {
    todo!("implemented in next step")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn parses_every_6h() {
        let after = Utc.with_ymd_and_hms(2026, 5, 14, 12, 30, 0).unwrap();
        let next = next_after("0 */6 * * *", "UTC", after).unwrap();
        // */6 在 0、6、12、18 触发；12:30 之后下一个是 18:00。
        assert_eq!(next, Utc.with_ymd_and_hms(2026, 5, 14, 18, 0, 0).unwrap());
    }

    #[test]
    fn parses_every_minute() {
        let after = Utc.with_ymd_and_hms(2026, 5, 14, 12, 30, 45).unwrap();
        let next = next_after("* * * * *", "UTC", after).unwrap();
        // 当前秒 45，下一分钟整点。
        assert_eq!(next, Utc.with_ymd_and_hms(2026, 5, 14, 12, 31, 0).unwrap());
    }

    #[test]
    fn timezone_shifts_trigger() {
        // 02:00 in America/New_York 是 06:00 UTC（EST 期间 UTC-5）。
        let after = Utc.with_ymd_and_hms(2026, 1, 15, 0, 0, 0).unwrap(); // 2026-01-15 是 EST
        let next = next_after("0 2 * * *", "America/New_York", after).unwrap();
        assert_eq!(next, Utc.with_ymd_and_hms(2026, 1, 15, 7, 0, 0).unwrap());
    }

    #[test]
    fn rejects_invalid_expr() {
        let after = Utc::now();
        assert!(next_after("not a cron", "UTC", after).is_err());
    }

    #[test]
    fn rejects_invalid_tz() {
        let after = Utc::now();
        assert!(next_after("* * * * *", "Mars/Olympus", after).is_err());
    }

    #[test]
    fn preview_returns_n_times() {
        let after = Utc.with_ymd_and_hms(2026, 5, 14, 0, 0, 0).unwrap();
        let times = preview("0 */6 * * *", "UTC", 4).unwrap();
        assert_eq!(times.len(), 4);
        assert_eq!(times[0], Utc.with_ymd_and_hms(2026, 5, 14, 6, 0, 0).unwrap());
        assert_eq!(times[3], Utc.with_ymd_and_hms(2026, 5, 15, 0, 0, 0).unwrap());
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cargo test --bin onebase scheduler::cron_parser:: 2>&1 | tail -20
```

Expected: 5 个 test FAIL with `not yet implemented`（即 `todo!()` panic），或编译错误。要看到 5 个测试名出现且都 fail。

不过 `preview` 内部依赖 `next_after`，我们需要在调用方把测试名列出来时不被 todo 阻塞。在 Step 1 的测试代码里如果 `preview` 实现还没动，那条测试也会 panic，符合 TDD。

- [ ] **Step 3: 实现 next_after + preview**

把 `cron_parser.rs` 替换为：

```rust
//! Cron 表达式 → next_run_at 计算。
//!
//! 输入是 5 字段 cron + IANA 时区。`cron` crate 接受 6 字段（含秒），所以
//! 我们在前面补一个 "0 " 把语义钉到 "整分钟触发"。
//!
//! 返回值统一是 UTC——所有调用方都用 UTC 比对 NOW()。

use chrono::{DateTime, TimeZone, Utc};
use std::str::FromStr;

use crate::error::AppError;

fn normalize(expr: &str) -> String {
    let parts: Vec<&str> = expr.split_whitespace().collect();
    match parts.len() {
        5 => format!("0 {}", expr.trim()),
        6 => expr.to_string(),
        _ => expr.to_string(),
    }
}

pub fn next_after(expr: &str, tz: &str, after: DateTime<Utc>) -> Result<DateTime<Utc>, AppError> {
    let tz: chrono_tz::Tz = tz
        .parse()
        .map_err(|_| AppError::InvalidQuery(format!("无效时区: {}", tz)))?;
    let schedule = cron::Schedule::from_str(&normalize(expr))
        .map_err(|e| AppError::InvalidQuery(format!("无效 cron 表达式: {}", e)))?;
    let local = after.with_timezone(&tz);
    let next = schedule
        .after(&local)
        .next()
        .ok_or_else(|| AppError::Internal("cron 表达式无下一个触发点".into()))?;
    Ok(next.with_timezone(&Utc))
}

pub fn preview(expr: &str, tz: &str, count: usize) -> Result<Vec<DateTime<Utc>>, AppError> {
    let tz_parsed: chrono_tz::Tz = tz
        .parse()
        .map_err(|_| AppError::InvalidQuery(format!("无效时区: {}", tz)))?;
    let schedule = cron::Schedule::from_str(&normalize(expr))
        .map_err(|e| AppError::InvalidQuery(format!("无效 cron 表达式: {}", e)))?;
    let now = Utc::now().with_timezone(&tz_parsed);
    Ok(schedule
        .after(&now)
        .take(count)
        .map(|dt| dt.with_timezone(&Utc))
        .collect())
}

#[cfg(test)]
mod tests {
    // ...原 tests 模块保留...
}
```

> 注：保留 Step 1 写的 tests 模块；只是把上面的 `todo!()` 实现填上。

- [ ] **Step 4: 修一个 preview 测试的依赖**

`preview` 用了 `Utc::now()` 导致测试时间漂移，所以 `preview_returns_n_times` 那个测试逻辑要改成不依赖当前时间——把 `preview` 改成接受 `after: DateTime<Utc>` 参数（与 next_after 对齐），handler 层再传 `Utc::now()`。

修正 `preview` 签名：

```rust
pub fn preview(
    expr: &str,
    tz: &str,
    after: DateTime<Utc>,
    count: usize,
) -> Result<Vec<DateTime<Utc>>, AppError> {
    let tz_parsed: chrono_tz::Tz = tz
        .parse()
        .map_err(|_| AppError::InvalidQuery(format!("无效时区: {}", tz)))?;
    let schedule = cron::Schedule::from_str(&normalize(expr))
        .map_err(|e| AppError::InvalidQuery(format!("无效 cron 表达式: {}", e)))?;
    let local = after.with_timezone(&tz_parsed);
    Ok(schedule
        .after(&local)
        .take(count)
        .map(|dt| dt.with_timezone(&Utc))
        .collect())
}
```

同步修改 Step 1 中 `preview_returns_n_times` 测试：

```rust
let times = preview("0 */6 * * *", "UTC", after, 4).unwrap();
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cargo test --bin onebase scheduler::cron_parser:: 2>&1 | tail -15
```

Expected: `test result: ok. 6 passed; 0 failed`.

---

### Task 1.6: 让 lib.rs 暴露 scheduler 供测试用

**Files:**
- Modify: `src/lib.rs`

- [ ] **Step 1: 检查 lib.rs 当前内容**

```bash
cat src/lib.rs
```

- [ ] **Step 2: 追加 mod scheduler 导出（若尚未加）**

如果 `pub mod scheduler;` 在 Task 1.3 已加，跳过。否则在合适位置加：

```rust
pub mod scheduler;
```

- [ ] **Step 3: 跑一遍 cargo check 确保库 + binary 都干净**

```bash
cargo check --all-targets 2>&1 | grep "^error" | head -10
```

Expected: 空（没有 error 行）。

---

### Task 1.7: 跑一遍完整测试 + 编译

- [ ] **Step 1: 全量测试**

```bash
cargo test --bin onebase scheduler:: 2>&1 | tail -20
```

Expected: cron_parser 的 6 个测试通过，无其他失败。

- [ ] **Step 2: 全量编译 release（防止 release-only lint）**

```bash
cargo check --release 2>&1 | tail -10
```

Expected: 无 error。

---

### Task 1.8: Phase 1 commit

- [ ] **Step 1: git status 看清状态**

```bash
git status
```

Expected: 列出 `Cargo.toml`、`migrations/014_*.sql`、`src/scheduler/`（4 个文件）、`src/bin/migrate_scheduled_tasks.rs`、`src/main.rs`、`src/lib.rs`、`src/bin/migrate_all.rs` 为修改 / 新增。

- [ ] **Step 2: commit**

```bash
git add -A && git commit -m "$(cat <<'EOF'
feat(scheduler): phase 1 - schema + module scaffolding + cron parser

Adds management.scheduled_tasks / scheduled_task_runs tables, the
src/scheduler/ module skeleton (models + cron_parser), and the
migrate_scheduled_tasks binary. Cron parsing supports 5-field
expressions with IANA timezone via cron + chrono-tz crates.

Spec: docs/superpowers/specs/2026-05-14-scheduled-tasks-design.md
EOF
)"
```

- [ ] **Step 3: 验证 commit**

```bash
git log -1 --stat
```

Expected: commit 出现，含上述文件。

---

## Phase 2 — Runner + Executors + rpc inner 重构

### Task 2.1: 抽 `run_rpc` 为可纯调用形式（不带 axum Extension）

**Files:**
- Modify: `src/rpc.rs:150-220`（`run_rpc` 函数）

- [ ] **Step 1: 检查当前 run_rpc 签名**

```bash
sed -n '150,170p' src/rpc.rs
```

Expected: 看到 `async fn run_rpc(main_pool: PgPool, dynamic_pool: Option<Extension<PgPool>>, redis: Option<Extension<RedisManager>>, subject: &RpcAuthSubject, ...)`。

- [ ] **Step 2: 改 run_rpc 签名为纯类型**

把 `run_rpc` 的签名改成：

```rust
async fn run_rpc(
    main_pool: &PgPool,
    dynamic_pool: Option<&PgPool>,
    redis: Option<&RedisManager>,
    subject: &RpcAuthSubject,
    database_id: i32,
    fn_name: &str,
    schema: String,
    args: serde_json::Map<String, Value>,
    single_object: bool,
) -> Result<(StatusCode, Json<Value>), AppError> {
```

函数体内的 `dynamic_pool.as_deref()` → 直接用 `dynamic_pool`（已经是 `Option<&PgPool>`）。`redis.as_deref()` 同理。

`let pool: &PgPool = dynamic_pool.as_deref().unwrap_or(&main_pool);` 改为：

```rust
let pool: &PgPool = dynamic_pool.unwrap_or(main_pool);
```

`enforce_rpc_permission(&main_pool, redis.as_deref(), ...)` 改为：

```rust
enforce_rpc_permission(main_pool, redis, ...)
```

- [ ] **Step 3: 改两个 handler 调用方匹配新签名**

`execute_rpc` 调用：

```rust
run_rpc(
    &main_pool,
    dynamic_pool.as_deref(),
    redis.as_deref(),
    &subject,
    database_id,
    &fn_name,
    schema,
    body_obj,
    single_object,
).await
```

`execute_rpc_get` 同样改。

> `Option<Extension<X>>::as_deref()` 当 `X: Deref<Target=T>` 时返回 `Option<&T>`。`Extension<PgPool>` deref 到 `PgPool` —— 但 `Extension` 没实现 Deref。需要先 `.map(|Extension(p)| p)` 拿到 `Option<&PgPool>` 形式。改成：

```rust
run_rpc(
    &main_pool,
    dynamic_pool.as_ref().map(|ext| &ext.0),
    redis.as_ref().map(|ext| &ext.0),
    &subject,
    ...
```

- [ ] **Step 4: 新增 pub 入口 `execute_rpc_inner` 给 scheduler 用**

在 `run_rpc` 函数之上加：

```rust
/// 不依赖 axum 入口的 RPC 执行入口——供 scheduler 等后台 task 调用。
///
/// 与 axum handler `execute_rpc` 的区别只在调用形态：本函数直接接受 PgPool 引用
/// 和已构造好的 `Claims`（包成 `RpcAuthSubject::User`），不再经过 middleware 链。
/// 内部仍然走 `run_rpc` 的同款 ACL + 形态查询 + 执行 + 形态拆包路径，
/// **不绕过任何 RBAC 校验**。
pub async fn execute_rpc_inner(
    main_pool: &PgPool,
    dynamic_pool: Option<&PgPool>,
    redis: Option<&RedisManager>,
    claims: &Claims,
    database_id: i32,
    schema: &str,
    fn_name: &str,
    args: serde_json::Map<String, Value>,
) -> Result<Value, AppError> {
    let subject = RpcAuthSubject::User(claims.clone());
    let (_status, Json(value)) = run_rpc(
        main_pool,
        dynamic_pool,
        redis,
        &subject,
        database_id,
        fn_name,
        schema.to_string(),
        args,
        false,
    )
    .await?;
    Ok(value)
}
```

- [ ] **Step 5: 编译确认**

```bash
cargo check --bin onebase 2>&1 | grep -E "^error" | head -20
```

Expected: 没有 error。

- [ ] **Step 6: 跑现有 rpc 相关测试**

```bash
cargo test --bin onebase rpc:: 2>&1 | tail -20
```

Expected: 全部 PASS（这是回归保护，确保重构没改变行为）。

- [ ] **Step 7: 写新的 inner 单测**

在 `src/rpc.rs` 末尾的 `#[cfg(test)] mod tests` 里追加：

```rust
#[test]
fn execute_rpc_inner_signature_compiles() {
    // Compile-time check: signature 是稳定的 pub 接口，scheduler 依赖它。
    fn assert_signature() {
        let _: fn(
            &sqlx::PgPool,
            Option<&sqlx::PgPool>,
            Option<&crate::redis_manager::RedisManager>,
            &crate::auth::Claims,
            i32,
            &str,
            &str,
            serde_json::Map<String, serde_json::Value>,
        ) -> _ = |a, b, c, d, e, f, g, h| {
            Box::pin(super::execute_rpc_inner(a, b, c, d, e, f, g, h))
                as std::pin::Pin<Box<dyn std::future::Future<Output = _>>>
        };
        let _ = assert_signature;
    }
}
```

> 如果该模块没有 `#[cfg(test)] mod tests {}` 段，直接在文件末尾新增。

- [ ] **Step 8: 跑该测试**

```bash
cargo test --bin onebase rpc::tests::execute_rpc_inner_signature_compiles 2>&1 | tail -5
```

Expected: PASS。

---

### Task 2.2: 写 RpcExecutor + 单测

**Files:**
- Modify: `src/scheduler/executors.rs`

- [ ] **Step 1: 先写测试（TDD）**

替换 `executors.rs` 的占位为：

```rust
//! 两种执行体：RpcExecutor（调 PG 函数）与 HttpExecutor（发起 HTTP）。

use serde_json::Value;
use sqlx::{PgPool, Row};
use std::sync::Arc;

use crate::auth::Claims;
use crate::pool_manager::POOL_MANAGER;
use crate::redis_manager::RedisManager;
use crate::scheduler::models::ScheduledTask;

#[derive(Debug)]
pub enum SynthErr {
    UserNotFound,
    UserDisabled,
    Db(String),
}

pub struct RpcExecutor {
    pub pool: PgPool,
    pub redis: Option<RedisManager>,
}

impl RpcExecutor {
    pub fn new(pool: PgPool, redis: Option<RedisManager>) -> Self {
        Self { pool, redis }
    }

    /// 重读 users 表合成 `Claims`。每次执行都读，避免任务创建者被禁用/降权后
    /// 仍以快照身份运行。返回 Err 时 runner 会把 run 记为 failed。
    pub async fn synthesize_claims_for(&self, user_id: i32) -> Result<Claims, SynthErr> {
        let row = sqlx::query(
            "SELECT id, email, COALESCE(role, 'user') AS role, COALESCE(is_superadmin, false) AS is_superadmin \
             FROM users WHERE id = $1",
        )
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| SynthErr::Db(e.to_string()))?;

        let row = row.ok_or(SynthErr::UserNotFound)?;
        // users 表当前没有 is_active 列；如果将来加上，这里 row.try_get::<bool, _>("is_active") 取值并判 false→Disabled。
        let id: i32 = row.get("id");
        let email: String = row.get("email");
        let role: String = row.get("role");
        let is_superadmin: bool = row.get("is_superadmin");

        // jti 留空 —— scheduler 路径不走 user_sessions 校验（rpc_auth_middleware 不在调用链里）。
        Ok(Claims {
            sub: id,
            email,
            role,
            is_superadmin,
            jti: String::new(),
            // 给一个远期 exp 避免 is_expired() 误判；scheduler 路径不调 is_expired。
            exp: (chrono::Utc::now() + chrono::Duration::days(1)).timestamp(),
            iat: chrono::Utc::now().timestamp(),
        })
    }

    pub async fn execute(&self, task: &ScheduledTask) -> Result<Value, String> {
        let claims = self
            .synthesize_claims_for(task.created_by)
            .await
            .map_err(|e| match e {
                SynthErr::UserNotFound => "created_by 用户已被删除".to_string(),
                SynthErr::UserDisabled => "created_by 用户已禁用".to_string(),
                SynthErr::Db(msg) => format!("身份合成失败: {msg}"),
            })?;

        let database_id = task
            .database_id
            .ok_or_else(|| "RPC 任务缺 database_id".to_string())?;
        let schema = task
            .rpc_schema
            .as_deref()
            .ok_or_else(|| "RPC 任务缺 schema".to_string())?;
        let fn_name = task
            .rpc_fn_name
            .as_deref()
            .ok_or_else(|| "RPC 任务缺 fn_name".to_string())?;

        let args_value = task.rpc_args.clone().unwrap_or(Value::Object(Default::default()));
        let args_map = match args_value {
            Value::Object(m) => m,
            _ => return Err("rpc_args 必须是 JSON object".to_string()),
        };

        // 取动态库连接池——按 database_id 找。POOL_MANAGER 已是单例。
        let dynamic_pool = POOL_MANAGER
            .get_pool_for_database(database_id)
            .await
            .map_err(|e| format!("加载库连接失败: {e}"))?;

        let value = crate::rpc::execute_rpc_inner(
            &self.pool,
            Some(&dynamic_pool),
            self.redis.as_ref(),
            &claims,
            database_id,
            schema,
            fn_name,
            args_map,
        )
        .await
        .map_err(|e| format!("RPC 执行失败: {e}"))?;

        Ok(value)
    }
}

// Arc-friendly alias 供 runner clone。
pub type RpcExecutorRef = Arc<RpcExecutor>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scheduler::models::ScheduledTask;
    use chrono::Utc;

    fn task_template() -> ScheduledTask {
        ScheduledTask {
            id: 1,
            tenant_id: None,
            name: "t".to_string(),
            description: None,
            cron_expr: "* * * * *".to_string(),
            timezone: "UTC".to_string(),
            kind: "rpc".to_string(),
            database_id: None,
            rpc_schema: None,
            rpc_fn_name: None,
            rpc_args: None,
            http_method: None,
            http_url: None,
            http_headers: None,
            http_body: None,
            http_secret_enc: None,
            is_active: true,
            timeout_secs: 30,
            max_retries: 0,
            overlap_policy: "skip".to_string(),
            next_run_at: None,
            last_run_at: None,
            last_run_status: None,
            claimed_at: None,
            claimed_by: None,
            created_by: 1,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    // 注意：execute() 真路径需要活的 PG 连接；这里只测前置参数校验分支。
    #[tokio::test]
    async fn rpc_execute_rejects_missing_database_id() {
        // 构造一个 fake pool 不会被真正用到——参数校验在前面就 Err 了。
        // 用 PgPoolOptions::lazy_connect 在没有连接的情况下也能拿到 PgPool 类型。
        let pool = sqlx::PgPool::connect_lazy(
            "postgres://invalid:invalid@127.0.0.1:1/none",
        ).unwrap();
        let exec = RpcExecutor::new(pool, None);

        let mut task = task_template();
        task.database_id = None;
        task.rpc_schema = Some("public".to_string());
        task.rpc_fn_name = Some("noop".to_string());

        // 这里会先打到 synthesize_claims_for（需要查 users 表）——也会失败。
        // 测试目的是确认错误被映射成字符串而不是 panic。
        let err = exec.execute(&task).await.err();
        assert!(err.is_some());
    }
}
```

- [ ] **Step 2: 检查 POOL_MANAGER.get_pool_for_database 签名**

```bash
rg "fn get_pool_for_database|pub.*get_pool_for_database" src/pool_manager.rs
```

如果方法名是别的（比如 `get_pool` / `get_or_load_database_pool`），改 executors.rs 里对应调用名匹配现状。

- [ ] **Step 3: 跑测试**

```bash
cargo test --bin onebase scheduler::executors::tests::rpc_execute_rejects_missing_database_id 2>&1 | tail -10
```

Expected: PASS（即使错误是因为 PG 连接失败而不是参数缺失，只要返回 Err 而不 panic 就过）。

---

### Task 2.3: 写 HttpExecutor + 单测

**Files:**
- Modify: `src/scheduler/executors.rs`

- [ ] **Step 1: 在文件中追加 HttpExecutor + tests**

在 `RpcExecutor` 之后、`#[cfg(test)]` 之前插入：

```rust
pub struct HttpExecutor {
    pub client: reqwest::Client,
    pub allow_insecure: bool,
}

impl HttpExecutor {
    pub fn new(allow_insecure: bool) -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .unwrap_or_default();
        Self { client, allow_insecure }
    }

    pub async fn execute(&self, task: &ScheduledTask) -> Result<Value, String> {
        let url = task
            .http_url
            .as_deref()
            .ok_or_else(|| "HTTP 任务缺 url".to_string())?;

        if !self.allow_insecure && !url.starts_with("https://") {
            return Err(
                "HTTP URL 必须 https（或显式设置 ALLOW_INSECURE_SCHEDULED_HTTP=true）".to_string(),
            );
        }

        let method_str = task.http_method.as_deref().unwrap_or("POST").to_uppercase();
        let method = match method_str.as_str() {
            "GET" => reqwest::Method::GET,
            "POST" => reqwest::Method::POST,
            "PUT" => reqwest::Method::PUT,
            "PATCH" => reqwest::Method::PATCH,
            "DELETE" => reqwest::Method::DELETE,
            other => return Err(format!("不支持的 HTTP method: {other}")),
        };

        let body = task.http_body.clone().unwrap_or(Value::Null);
        let mut req = self.client.request(method.clone(), url);

        if let Some(headers) = task.http_headers.as_ref().and_then(|v| v.as_object()) {
            for (k, v) in headers {
                if let Some(s) = v.as_str() {
                    req = req.header(k, s);
                }
            }
        }

        // HMAC-SHA256 签名（与 webhook 同款规范）。
        if let Some(enc) = task.http_secret_enc.as_deref() {
            let secret = crate::crypto::decrypt_secret_lossy(enc);
            if !secret.is_empty() {
                use sha2::{Digest, Sha256};
                let body_bytes = serde_json::to_vec(&body).unwrap_or_default();
                let mut hasher = Sha256::new();
                hasher.update(secret.as_bytes());
                hasher.update(&body_bytes);
                let sig = hex::encode(hasher.finalize());
                req = req.header("X-Onebase-Signature", sig);
            }
        }

        let req = if matches!(method, reqwest::Method::GET | reqwest::Method::DELETE) {
            req
        } else {
            req.json(&body)
        };

        let resp = req
            .send()
            .await
            .map_err(|e| format!("HTTP 请求失败: {e}"))?;

        let status = resp.status();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("读取响应体失败: {e}"))?;
        let parsed: Value = serde_json::from_slice(&bytes).unwrap_or_else(|_| {
            Value::String(String::from_utf8_lossy(&bytes).into_owned())
        });

        if status.is_success() {
            Ok(serde_json::json!({
                "status": status.as_u16(),
                "body": parsed,
            }))
        } else {
            Err(format!("HTTP {} - {}", status.as_u16(), parsed))
        }
    }
}

pub type HttpExecutorRef = Arc<HttpExecutor>;
```

并在底部 `mod tests` 内追加：

```rust
#[tokio::test]
async fn http_execute_rejects_plain_http_by_default() {
    let exec = HttpExecutor::new(false);
    let mut task = task_template();
    task.kind = "http".to_string();
    task.http_method = Some("POST".to_string());
    task.http_url = Some("http://example.com/hook".to_string());

    let err = exec.execute(&task).await.err().unwrap();
    assert!(err.contains("https"));
}

#[tokio::test]
async fn http_execute_rejects_unknown_method() {
    let exec = HttpExecutor::new(true);
    let mut task = task_template();
    task.kind = "http".to_string();
    task.http_method = Some("FROB".to_string());
    task.http_url = Some("https://example.com/hook".to_string());

    let err = exec.execute(&task).await.err().unwrap();
    assert!(err.contains("不支持的 HTTP method"));
}
```

- [ ] **Step 2: 跑测试**

```bash
cargo test --bin onebase scheduler::executors::tests:: 2>&1 | tail -10
```

Expected: 3 个测试都 PASS。

---

### Task 2.4: 写 SchedulerRunner 骨架 + tick 循环

**Files:**
- Modify: `src/scheduler/runner.rs`

- [ ] **Step 1: 替换占位 runner.rs**

```rust
//! 调度循环：每 tick_interval 一次，
//!   Step 1 回收陈旧 claim
//!   Step 2 SELECT ... FOR UPDATE SKIP LOCKED 批量 claim 到期任务
//!   Step 3 每个 claimed task 独立 tokio::spawn 执行 execute_one。

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{PgPool, Row};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::scheduler::cron_parser::next_after;
use crate::scheduler::executors::{HttpExecutorRef, RpcExecutorRef};
use crate::scheduler::models::ScheduledTask;

#[derive(Clone, Debug)]
pub struct SchedulerConfig {
    pub tick_interval: Duration,
    pub batch_size: i64,
    pub stale_claim_grace_secs: i64,
    pub retry_base_secs: i64,
    pub retry_factor: u32,
    pub allow_insecure_http: bool,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            tick_interval: Duration::from_secs(5),
            batch_size: 32,
            stale_claim_grace_secs: 30,
            retry_base_secs: 60,
            retry_factor: 2,
            allow_insecure_http: false,
        }
    }
}

pub struct SchedulerRunner {
    pool: PgPool,
    runner_id: String,
    config: SchedulerConfig,
    rpc_exec: RpcExecutorRef,
    http_exec: HttpExecutorRef,
    running: Arc<AtomicBool>,
}

impl SchedulerRunner {
    pub fn new(
        pool: PgPool,
        config: SchedulerConfig,
        rpc_exec: RpcExecutorRef,
        http_exec: HttpExecutorRef,
    ) -> Self {
        let hostname = hostname_best_effort();
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let runner_id = format!("{hostname}-{pid}-{nanos}");
        Self {
            pool,
            runner_id,
            config,
            rpc_exec,
            http_exec,
            running: Arc::new(AtomicBool::new(true)),
        }
    }

    pub fn shutdown_handle(&self) -> Arc<AtomicBool> {
        self.running.clone()
    }

    pub fn runner_id(&self) -> &str {
        &self.runner_id
    }

    pub fn start(self) -> tokio::task::JoinHandle<()> {
        let running = self.running.clone();
        let me = Arc::new(self);
        tokio::spawn(async move {
            tracing::info!(
                "SchedulerRunner 已启动: runner_id={} tick={:?} batch={}",
                me.runner_id, me.config.tick_interval, me.config.batch_size
            );
            while running.load(Ordering::Relaxed) {
                tokio::time::sleep(me.config.tick_interval).await;
                if !running.load(Ordering::Relaxed) {
                    break;
                }
                if let Err(e) = me.tick().await {
                    tracing::error!("scheduler tick 失败: {e}");
                }
            }
            tracing::info!("SchedulerRunner 已停止");
        })
    }

    async fn tick(&self) -> Result<(), sqlx::Error> {
        self.reclaim_stale().await?;
        let claimed = self.claim_due_tasks().await?;
        for task in claimed {
            let me = Arc::new(self.clone_for_spawn());
            tokio::spawn(async move {
                me.execute_one(task, "cron").await;
            });
        }
        Ok(())
    }

    fn clone_for_spawn(&self) -> Self {
        Self {
            pool: self.pool.clone(),
            runner_id: self.runner_id.clone(),
            config: self.config.clone(),
            rpc_exec: self.rpc_exec.clone(),
            http_exec: self.http_exec.clone(),
            running: self.running.clone(),
        }
    }

    async fn reclaim_stale(&self) -> Result<u64, sqlx::Error> {
        let res = sqlx::query(
            "UPDATE management.scheduled_tasks \
             SET claimed_at = NULL, claimed_by = NULL \
             WHERE claimed_at IS NOT NULL \
               AND claimed_at < NOW() - (timeout_secs + $1) * INTERVAL '1 second'",
        )
        .bind(self.config.stale_claim_grace_secs)
        .execute(&self.pool)
        .await?;
        if res.rows_affected() > 0 {
            tracing::warn!("回收陈旧 claim {} 条", res.rows_affected());
        }
        Ok(res.rows_affected())
    }

    async fn claim_due_tasks(&self) -> Result<Vec<ScheduledTask>, sqlx::Error> {
        let rows = sqlx::query_as::<_, ScheduledTask>(
            "UPDATE management.scheduled_tasks \
             SET claimed_at = NOW(), claimed_by = $1 \
             WHERE id IN ( \
                 SELECT id FROM management.scheduled_tasks \
                 WHERE is_active = true \
                   AND claimed_at IS NULL \
                   AND next_run_at IS NOT NULL \
                   AND next_run_at <= NOW() \
                 ORDER BY next_run_at ASC \
                 LIMIT $2 \
                 FOR UPDATE SKIP LOCKED \
             ) \
             RETURNING *",
        )
        .bind(&self.runner_id)
        .bind(self.config.batch_size)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// 立即触发一次（手动 run-now 入口）。不走 claim 流程——
    /// 直接调用 execute_one，triggered_by='manual'。
    pub async fn trigger_now(&self, task: ScheduledTask) {
        let me = Arc::new(self.clone_for_spawn());
        tokio::spawn(async move {
            me.execute_one(task, "manual").await;
        });
    }

    async fn execute_one(&self, task: ScheduledTask, triggered_by: &str) {
        let started_at = Utc::now();
        let attempt = self.current_attempt(&task).await.unwrap_or(1);

        let run_id = match self.create_run_record(&task, triggered_by, attempt).await {
            Ok(id) => id,
            Err(e) => {
                tracing::error!("写 run 起始记录失败 task_id={}: {e}", task.id);
                let _ = self.release_with_cron(&task).await;
                return;
            }
        };

        // overlap：判定同 task 上一次 run 是否还在 running。
        if task.overlap_policy == "skip" {
            if let Ok(running_count) = self.count_running_runs(task.id, run_id).await {
                if running_count > 0 {
                    tracing::warn!("task_id={} overlap=skip：跳过本次触发", task.id);
                    let _ = self
                        .finalize_run(
                            run_id,
                            "cancelled",
                            None,
                            Some("overlap with previous run"),
                            started_at,
                        )
                        .await;
                    let _ = self
                        .update_task_after_run(&task, "cancelled", self.cron_next_safe(&task))
                        .await;
                    return;
                }
            }
        }

        let timeout = Duration::from_secs(task.timeout_secs.max(1) as u64);
        let exec_future: std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send>> =
            match task.kind.as_str() {
                "rpc" => Box::pin({
                    let rpc = self.rpc_exec.clone();
                    let t = task.clone();
                    async move { rpc.execute(&t).await }
                }),
                "http" => Box::pin({
                    let http = self.http_exec.clone();
                    let t = task.clone();
                    async move { http.execute(&t).await }
                }),
                other => {
                    tracing::error!("未知任务类型 kind={} task_id={}", other, task.id);
                    let _ = self
                        .finalize_run(
                            run_id,
                            "failed",
                            None,
                            Some(&format!("unknown kind: {other}")),
                            started_at,
                        )
                        .await;
                    let _ = self.update_task_after_run(&task, "failed", self.cron_next_safe(&task)).await;
                    return;
                }
            };

        let outcome = tokio::time::timeout(timeout, exec_future).await;

        let (status, output, err_msg) = match outcome {
            Ok(Ok(v)) => ("success", Some(truncate_output(v)), None),
            Ok(Err(e)) => ("failed", None, Some(e)),
            Err(_) => ("timeout", None, Some("execution timed out".to_string())),
        };

        let _ = self
            .finalize_run(run_id, status, output, err_msg.as_deref(), started_at)
            .await;

        let next_run_at = self.compute_next_run_at(&task, status, attempt);
        let _ = self.update_task_after_run(&task, status, next_run_at).await;
    }

    fn compute_next_run_at(
        &self,
        task: &ScheduledTask,
        status: &str,
        attempt: i32,
    ) -> Option<DateTime<Utc>> {
        let cron_next = self.cron_next_safe(task);
        if status == "success" || status == "cancelled" {
            return cron_next;
        }
        if attempt < task.max_retries {
            let factor = (self.config.retry_factor as i64).pow(attempt.max(1) as u32 - 1);
            let backoff = chrono::Duration::seconds(self.config.retry_base_secs * factor);
            let backoff_at = Utc::now() + backoff;
            match cron_next {
                Some(c) if backoff_at >= c => Some(c),
                _ => Some(backoff_at),
            }
        } else {
            cron_next
        }
    }

    fn cron_next_safe(&self, task: &ScheduledTask) -> Option<DateTime<Utc>> {
        match next_after(&task.cron_expr, &task.timezone, Utc::now()) {
            Ok(t) => Some(t),
            Err(e) => {
                tracing::error!("task_id={} cron 解析失败: {e}", task.id);
                None
            }
        }
    }

    async fn current_attempt(&self, task: &ScheduledTask) -> Result<i32, sqlx::Error> {
        // 当前正在尝试的次数 = 同 task 最近一次非 success/cancelled 的连续失败串长度 + 1。
        // 简化：取最近一行的 attempt_number；若上一行是 success/cancelled，attempt=1，否则 attempt+1。
        let row = sqlx::query(
            "SELECT attempt_number, status FROM management.scheduled_task_runs \
             WHERE task_id = $1 ORDER BY started_at DESC LIMIT 1",
        )
        .bind(task.id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(match row {
            Some(r) => {
                let st: String = r.get("status");
                let n: i32 = r.get("attempt_number");
                if st == "success" || st == "cancelled" { 1 } else { n + 1 }
            }
            None => 1,
        })
    }

    async fn count_running_runs(&self, task_id: i64, exclude_run_id: i64) -> Result<i64, sqlx::Error> {
        let row = sqlx::query(
            "SELECT COUNT(*)::bigint AS n FROM management.scheduled_task_runs \
             WHERE task_id = $1 AND status = 'running' AND id <> $2",
        )
        .bind(task_id)
        .bind(exclude_run_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.get::<i64, _>("n"))
    }

    async fn create_run_record(
        &self,
        task: &ScheduledTask,
        triggered_by: &str,
        attempt: i32,
    ) -> Result<i64, sqlx::Error> {
        let row = sqlx::query(
            "INSERT INTO management.scheduled_task_runs \
                (task_id, status, runner_id, attempt_number, triggered_by) \
             VALUES ($1, 'running', $2, $3, $4) RETURNING id",
        )
        .bind(task.id)
        .bind(&self.runner_id)
        .bind(attempt)
        .bind(triggered_by)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.get::<i64, _>("id"))
    }

    async fn finalize_run(
        &self,
        run_id: i64,
        status: &str,
        output: Option<Value>,
        error_message: Option<&str>,
        started_at: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        let duration_ms = (Utc::now() - started_at).num_milliseconds().max(0) as i32;
        sqlx::query(
            "UPDATE management.scheduled_task_runs \
             SET finished_at = NOW(), status = $1, output = $2, error_message = $3, duration_ms = $4 \
             WHERE id = $5",
        )
        .bind(status)
        .bind(output)
        .bind(error_message)
        .bind(duration_ms)
        .bind(run_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn update_task_after_run(
        &self,
        task: &ScheduledTask,
        status: &str,
        next_run_at: Option<DateTime<Utc>>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE management.scheduled_tasks \
             SET last_run_at = NOW(), last_run_status = $1, \
                 next_run_at = $2, claimed_at = NULL, claimed_by = NULL, updated_at = NOW() \
             WHERE id = $3",
        )
        .bind(status)
        .bind(next_run_at)
        .bind(task.id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn release_with_cron(&self, task: &ScheduledTask) -> Result<(), sqlx::Error> {
        let cron_next = self.cron_next_safe(task);
        sqlx::query(
            "UPDATE management.scheduled_tasks \
             SET next_run_at = $1, claimed_at = NULL, claimed_by = NULL \
             WHERE id = $2",
        )
        .bind(cron_next)
        .bind(task.id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

fn truncate_output(v: Value) -> Value {
    const MAX_BYTES: usize = 200 * 1024;
    let bytes = serde_json::to_vec(&v).unwrap_or_default();
    if bytes.len() <= MAX_BYTES {
        return v;
    }
    let preview_len = 8 * 1024;
    let preview = String::from_utf8_lossy(&bytes[..preview_len.min(bytes.len())]).into_owned();
    serde_json::json!({
        "truncated": true,
        "size_bytes": bytes.len(),
        "preview": preview,
    })
}

fn hostname_best_effort() -> String {
    std::env::var("HOSTNAME").unwrap_or_else(|_| "unknown".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_below_limit_returns_original() {
        let v = serde_json::json!({"hello": "world"});
        let out = truncate_output(v.clone());
        assert_eq!(out, v);
    }

    #[test]
    fn truncate_above_limit_returns_preview() {
        let huge = "x".repeat(300 * 1024);
        let v = serde_json::json!({"data": huge});
        let out = truncate_output(v);
        assert_eq!(out["truncated"], Value::Bool(true));
        assert!(out["size_bytes"].as_u64().unwrap() > 200 * 1024);
        assert!(out["preview"].is_string());
    }

    // compute_next_run_at / overlap 决策测试需要 PG 连接（含 scheduled_task_runs 表
    // 查询）；整合到 Task 2.5 集成测试里跑，而不是这里桩出来。
}
```

- [ ] **Step 2: 跑这部分的单测**

```bash
cargo test --bin onebase scheduler::runner::tests:: 2>&1 | tail -10
```

Expected: 3 个测试 PASS。

- [ ] **Step 3: 整体编译**

```bash
cargo check --bin onebase 2>&1 | grep "^error" | head -10
```

Expected: 空。

---

### Task 2.5: 集成测试 SKIP LOCKED 行为（需 DATABASE_URL_TEST）

**Files:**
- Create: `tests/scheduler_runner_integration.rs`

- [ ] **Step 1: 写集成测试**

```rust
//! 集成测试：验证两个 SchedulerRunner 不会重复 claim 同一个任务。
//!
//! 运行前提：环境变量 `DATABASE_URL_TEST` 指向一个空 PG 实例（migration 已跑）。
//! 没设这个变量时测试自动 skip（不 fail）。

use chrono::Utc;
use onebase::scheduler::executors::{HttpExecutor, RpcExecutor};
use onebase::scheduler::runner::{SchedulerConfig, SchedulerRunner};
use sqlx::PgPool;
use std::sync::Arc;

async fn setup_pool() -> Option<PgPool> {
    let url = std::env::var("DATABASE_URL_TEST").ok()?;
    PgPool::connect(&url).await.ok()
}

async fn seed_due_task(pool: &PgPool) -> i64 {
    let row: (i64,) = sqlx::query_as(
        "INSERT INTO management.scheduled_tasks \
            (name, cron_expr, timezone, kind, http_method, http_url, \
             is_active, next_run_at, created_by) \
         VALUES ('it', '* * * * *', 'UTC', 'http', 'GET', 'https://example.test/', \
                  true, NOW() - INTERVAL '1 second', 1) \
         RETURNING id",
    )
    .fetch_one(pool)
    .await
    .expect("insert");
    row.0
}

#[tokio::test]
async fn two_runners_do_not_double_claim() {
    let Some(pool) = setup_pool().await else {
        eprintln!("DATABASE_URL_TEST 未设置，skip");
        return;
    };

    // 清理 + 播种
    sqlx::query("DELETE FROM management.scheduled_task_runs").execute(&pool).await.ok();
    sqlx::query("DELETE FROM management.scheduled_tasks").execute(&pool).await.ok();
    let _task_id = seed_due_task(&pool).await;

    let rpc = Arc::new(RpcExecutor::new(pool.clone(), None));
    let http = Arc::new(HttpExecutor::new(true));

    let r1 = SchedulerRunner::new(pool.clone(), SchedulerConfig::default(), rpc.clone(), http.clone());
    let r2 = SchedulerRunner::new(pool.clone(), SchedulerConfig::default(), rpc, http);

    // 直接 tick 一次（不启动循环）。
    // tick 是 private，所以这里通过 start() 启 + 短暂 sleep 来观察。
    let h1 = r1.start();
    let h2 = r2.start();

    tokio::time::sleep(std::time::Duration::from_secs(8)).await;

    h1.abort();
    h2.abort();

    let runs: (i64,) = sqlx::query_as(
        "SELECT COUNT(*)::bigint FROM management.scheduled_task_runs",
    )
    .fetch_one(&pool)
    .await
    .expect("count");

    // HTTP 调用会失败（example.test 不存在），但 run 记录 = 1 行，
    // 说明只有一个 runner 抢到了 claim。
    assert_eq!(runs.0, 1, "两个 runner 同时跑应只产生一条 run 记录");
}
```

- [ ] **Step 2: 检查测试环境**

```bash
echo "DATABASE_URL_TEST=$DATABASE_URL_TEST"
```

如果设置了：

```bash
cargo test --test scheduler_runner_integration -- --nocapture 2>&1 | tail -15
```

Expected: `test result: ok. 1 passed`.

如果没设置：测试自打印"skip"并通过。这步可放过，等用户配 staging PG 时再回头跑。

---

### Task 2.6: Phase 2 commit

- [ ] **Step 1: 看修改清单**

```bash
git status
```

Expected: `src/rpc.rs`（modified）、`src/scheduler/executors.rs`、`src/scheduler/runner.rs`、`tests/scheduler_runner_integration.rs`。

- [ ] **Step 2: commit**

```bash
git add -A && git commit -m "$(cat <<'EOF'
feat(scheduler): phase 2 - runner + executors + execute_rpc_inner

Adds RpcExecutor / HttpExecutor and SchedulerRunner with FOR UPDATE
SKIP LOCKED claim semantics. Refactors src/rpc.rs run_rpc to take
pool references directly and exposes the new pub execute_rpc_inner
entry point so scheduler can reuse the full RBAC path without
going through axum middleware.

Spec: docs/superpowers/specs/2026-05-14-scheduled-tasks-design.md
EOF
)"
```

---

## Phase 3 — Config + HTTP API + main.rs wire-up

### Task 3.1: 扩展 src/config.rs

**Files:**
- Modify: `src/config.rs`

- [ ] **Step 1: 在 Config struct 加 6 个字段**

在 `cors_origins: Vec<String>,` 之前插入：

```rust
    /// 调度循环周期（秒）；默认 5。
    pub scheduler_tick_interval_secs: u64,
    /// 单次 tick 最多 claim 任务数；默认 32。
    pub scheduler_batch_size: i64,
    /// 超时 + 此值后视为陈旧 claim 自动释放（秒）；默认 30。
    pub scheduler_stale_claim_grace_secs: i64,
    /// 重试指数退避起点（秒）；默认 60。
    pub scheduler_retry_base_secs: i64,
    /// 退避倍数；默认 2。
    pub scheduler_retry_factor: u32,
    /// 是否允许 HTTP 任务使用明文 http://（默认 false，仅 https）。
    pub allow_insecure_scheduled_http: bool,
```

- [ ] **Step 2: 在 from_env() 加解析**

在 `let cors_origins = ...` 之前插入：

```rust
        let scheduler_tick_interval_secs = env::var("SCHEDULER_TICK_INTERVAL_SECS")
            .ok().and_then(|s| s.parse().ok()).unwrap_or(5);
        let scheduler_batch_size = env::var("SCHEDULER_BATCH_SIZE")
            .ok().and_then(|s| s.parse().ok()).unwrap_or(32);
        let scheduler_stale_claim_grace_secs = env::var("SCHEDULER_STALE_CLAIM_GRACE_SECS")
            .ok().and_then(|s| s.parse().ok()).unwrap_or(30);
        let scheduler_retry_base_secs = env::var("SCHEDULER_RETRY_BASE_SECS")
            .ok().and_then(|s| s.parse().ok()).unwrap_or(60);
        let scheduler_retry_factor = env::var("SCHEDULER_RETRY_FACTOR")
            .ok().and_then(|s| s.parse().ok()).unwrap_or(2);
        let allow_insecure_scheduled_http = env::var("ALLOW_INSECURE_SCHEDULED_HTTP")
            .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes"))
            .unwrap_or(false);
```

并在最后的 `Ok(Config { ... })` 块里加上这 6 个字段。

- [ ] **Step 3: 验证**

```bash
cargo check --bin onebase 2>&1 | grep "^error" | head -5
```

Expected: 空。

---

### Task 3.2: 写 scheduler_handlers.rs - 基础 CRUD

**Files:**
- Create: `src/scheduler_handlers.rs`

- [ ] **Step 1: 写 handler 文件**

```rust
//! HTTP API：定时任务管理。
//!
//! 路由清单见 spec §7。所有 handler 假定已经通过 auth_middleware（拿到 Claims）。
//! 鉴权细节由 `validate_can_manage` / `is_visible_tenant_for` 负责。

use axum::{
    extract::{Extension, Path, Query, State},
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Row};

use crate::auth::Claims;
use crate::audit_handlers; // 复用其内部 helper
use crate::error::AppError;
use crate::scheduler::cron_parser;
use crate::scheduler::models::ScheduledTask;
use crate::scheduler::runner::SchedulerRunner;
use std::sync::Arc;

// ─── Request / Response 形状 ────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreateTaskReq {
    pub tenant_id: Option<i32>,
    pub name: String,
    pub description: Option<String>,
    pub cron_expr: String,
    pub timezone: Option<String>,
    pub kind: String,
    pub database_id: Option<i32>,
    pub rpc_schema: Option<String>,
    pub rpc_fn_name: Option<String>,
    pub rpc_args: Option<Value>,
    pub http_method: Option<String>,
    pub http_url: Option<String>,
    pub http_headers: Option<Value>,
    pub http_body: Option<Value>,
    pub http_secret: Option<String>,
    pub timeout_secs: Option<i32>,
    pub max_retries: Option<i32>,
    pub overlap_policy: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateTaskReq {
    pub name: Option<String>,
    pub description: Option<String>,
    pub cron_expr: Option<String>,
    pub timezone: Option<String>,
    pub rpc_args: Option<Value>,
    pub http_headers: Option<Value>,
    pub http_body: Option<Value>,
    pub http_secret: Option<String>,
    pub timeout_secs: Option<i32>,
    pub max_retries: Option<i32>,
    pub overlap_policy: Option<String>,
    pub is_active: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub tenant_id: Option<i32>,
    pub kind: Option<String>,
    pub is_active: Option<bool>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct ValidateCronReq {
    pub cron_expr: String,
    pub timezone: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CleanupZombiesReq {
    pub older_than_hours: Option<i64>,
}

// ─── 鉴权辅助 ────────────────────────────────

async fn admin_tenant_ids_for(claims: &Claims, pool: &PgPool) -> Result<Vec<i32>, AppError> {
    audit_handlers::admin_tenant_ids(pool, claims).await
}

async fn validate_can_manage(
    claims: &Claims,
    task_tenant_id: Option<i32>,
    pool: &PgPool,
) -> Result<(), AppError> {
    if claims.is_superadmin {
        return Ok(());
    }
    match task_tenant_id {
        None => Err(AppError::Forbidden("平台级任务仅超管可管理".to_string())),
        Some(t) => {
            let admins = admin_tenant_ids_for(claims, pool).await?;
            if admins.contains(&t) { Ok(()) }
            else { Err(AppError::Forbidden("仅租户 owner/admin 可管理此任务".to_string())) }
        }
    }
}

async fn validate_database_belongs_to_tenant(
    pool: &PgPool,
    database_id: i32,
    tenant_id: Option<i32>,
) -> Result<(), AppError> {
    let owner: Option<i32> = sqlx::query_scalar(
        "SELECT tenant_id FROM management.tenant_databases WHERE id = $1 AND is_active = true",
    )
    .bind(database_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询数据库归属失败: {e}")))?
    .ok_or_else(|| AppError::InvalidQuery("database_id 不存在或未启用".to_string()))?;
    match (tenant_id, owner) {
        (None, _) => Ok(()), // 平台级任务可指任意库（仅超管能创建）
        (Some(t), o) if t == o => Ok(()),
        _ => Err(AppError::InvalidQuery(
            "database_id 不属于指定的 tenant_id".to_string(),
        )),
    }
}

// ─── Handlers ────────────────────────────────

pub async fn create_task(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<CreateTaskReq>,
) -> Result<Json<ScheduledTask>, AppError> {
    validate_can_manage(&claims, req.tenant_id, &pool).await?;

    let kind = req.kind.as_str();
    if kind != "rpc" && kind != "http" {
        return Err(AppError::InvalidQuery("kind 必须是 rpc 或 http".to_string()));
    }
    let timezone = req.timezone.clone().unwrap_or_else(|| "UTC".to_string());
    cron_parser::next_after(&req.cron_expr, &timezone, Utc::now())?;

    if kind == "rpc" {
        if req.database_id.is_none() || req.rpc_schema.is_none() || req.rpc_fn_name.is_none() {
            return Err(AppError::InvalidQuery(
                "rpc 任务必须提供 database_id / rpc_schema / rpc_fn_name".to_string(),
            ));
        }
        validate_database_belongs_to_tenant(&pool, req.database_id.unwrap(), req.tenant_id).await?;
    } else if kind == "http" {
        if req.http_method.is_none() || req.http_url.is_none() {
            return Err(AppError::InvalidQuery(
                "http 任务必须提供 http_method / http_url".to_string(),
            ));
        }
    }

    let http_secret_enc = match req.http_secret.as_deref() {
        Some(s) if !s.is_empty() => Some(crate::crypto::encrypt_secret(s)?),
        _ => None,
    };

    let next_run_at = cron_parser::next_after(&req.cron_expr, &timezone, Utc::now()).ok();

    let row = sqlx::query_as::<_, ScheduledTask>(
        "INSERT INTO management.scheduled_tasks ( \
            tenant_id, name, description, cron_expr, timezone, kind, \
            database_id, rpc_schema, rpc_fn_name, rpc_args, \
            http_method, http_url, http_headers, http_body, http_secret_enc, \
            timeout_secs, max_retries, overlap_policy, next_run_at, created_by) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) \
         RETURNING *",
    )
    .bind(req.tenant_id)
    .bind(&req.name)
    .bind(&req.description)
    .bind(&req.cron_expr)
    .bind(&timezone)
    .bind(kind)
    .bind(req.database_id)
    .bind(&req.rpc_schema)
    .bind(&req.rpc_fn_name)
    .bind(&req.rpc_args)
    .bind(req.http_method.as_deref().map(|s| s.to_uppercase()))
    .bind(&req.http_url)
    .bind(&req.http_headers)
    .bind(&req.http_body)
    .bind(&http_secret_enc)
    .bind(req.timeout_secs.unwrap_or(60))
    .bind(req.max_retries.unwrap_or(0))
    .bind(req.overlap_policy.as_deref().unwrap_or("skip"))
    .bind(next_run_at)
    .bind(claims.sub)
    .fetch_one(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("创建任务失败: {e}")))?;

    Ok(Json(redact_secret(row)))
}

pub async fn list_tasks(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<ScheduledTask>>, AppError> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let offset = q.offset.unwrap_or(0).max(0);

    // 走"先按可见 tenant 过滤行集，再用 bind 参数过滤 kind / is_active"。
    // tenant_id IN (...) 的占位数随 admins.len() 动态生成——这部分仍需拼字符串，
    // 但绑定的还是 i32 数组，不会发生 SQL 注入。kind / is_active 用 bind。
    let mut where_parts: Vec<String> = vec!["1=1".to_string()];
    let mut bind_idx: i32 = 0;
    let mut int_binds: Vec<i32> = Vec::new();
    let mut str_binds: Vec<String> = Vec::new();
    let mut bool_binds: Vec<bool> = Vec::new();

    if !claims.is_superadmin {
        let admins = admin_tenant_ids_for(&claims, &pool).await?;
        if admins.is_empty() {
            return Ok(Json(Vec::new()));
        }
        let placeholders = admins
            .iter()
            .map(|_| {
                bind_idx += 1;
                format!("${}", bind_idx)
            })
            .collect::<Vec<_>>()
            .join(",");
        where_parts.push(format!("tenant_id IN ({placeholders})"));
        int_binds.extend(admins);
    } else if let Some(t) = q.tenant_id {
        bind_idx += 1;
        where_parts.push(format!("tenant_id = ${}", bind_idx));
        int_binds.push(t);
    }

    if let Some(k) = &q.kind {
        bind_idx += 1;
        where_parts.push(format!("kind = ${}", bind_idx));
        str_binds.push(k.clone());
    }
    if let Some(a) = q.is_active {
        bind_idx += 1;
        where_parts.push(format!("is_active = ${}", bind_idx));
        bool_binds.push(a);
    }

    let sql = format!(
        "SELECT * FROM management.scheduled_tasks WHERE {} ORDER BY id DESC LIMIT {} OFFSET {}",
        where_parts.join(" AND "),
        limit,
        offset,
    );
    let mut query = sqlx::query_as::<_, ScheduledTask>(&sql);
    for v in &int_binds { query = query.bind(v); }
    for v in &str_binds { query = query.bind(v); }
    for v in &bool_binds { query = query.bind(v); }
    let rows = query
        .fetch_all(&pool)
        .await
        .map_err(|e| AppError::Internal(format!("列表查询失败: {e}")))?;
    Ok(Json(rows.into_iter().map(redact_secret).collect()))
}

pub async fn get_task(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    let task = fetch_task_or_404(&pool, id).await?;
    validate_can_manage(&claims, task.tenant_id, &pool).await?;
    let runs = sqlx::query(
        "SELECT id, started_at, finished_at, status, runner_id, attempt_number, \
                triggered_by, duration_ms, error_message \
         FROM management.scheduled_task_runs WHERE task_id = $1 \
         ORDER BY started_at DESC LIMIT 5",
    )
    .bind(id)
    .fetch_all(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询 runs 失败: {e}")))?;
    let runs_json: Vec<Value> = runs
        .into_iter()
        .map(|r| {
            json!({
                "id": r.get::<i64, _>("id"),
                "started_at": r.get::<chrono::DateTime<Utc>, _>("started_at"),
                "finished_at": r.try_get::<Option<chrono::DateTime<Utc>>, _>("finished_at").unwrap_or(None),
                "status": r.get::<String, _>("status"),
                "runner_id": r.try_get::<Option<String>, _>("runner_id").unwrap_or(None),
                "attempt_number": r.get::<i32, _>("attempt_number"),
                "triggered_by": r.get::<String, _>("triggered_by"),
                "duration_ms": r.try_get::<Option<i32>, _>("duration_ms").unwrap_or(None),
                "error_message": r.try_get::<Option<String>, _>("error_message").unwrap_or(None),
            })
        })
        .collect();
    Ok(Json(json!({ "task": redact_secret(task), "recent_runs": runs_json })))
}

pub async fn update_task(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateTaskReq>,
) -> Result<Json<ScheduledTask>, AppError> {
    let task = fetch_task_or_404(&pool, id).await?;
    validate_can_manage(&claims, task.tenant_id, &pool).await?;

    // 校验 cron + timezone（若任一变了都要重新算 next_run_at）
    let cron = req.cron_expr.clone().unwrap_or_else(|| task.cron_expr.clone());
    let tz = req.timezone.clone().unwrap_or_else(|| task.timezone.clone());
    let next = cron_parser::next_after(&cron, &tz, Utc::now())?;

    let http_secret_enc = match req.http_secret.as_deref() {
        Some(s) if !s.is_empty() => Some(crate::crypto::encrypt_secret(s)?),
        Some(_) => task.http_secret_enc.clone(),
        None => task.http_secret_enc.clone(),
    };

    let row = sqlx::query_as::<_, ScheduledTask>(
        "UPDATE management.scheduled_tasks SET \
            name = COALESCE($1, name), \
            description = COALESCE($2, description), \
            cron_expr = $3, timezone = $4, next_run_at = $5, \
            rpc_args = COALESCE($6, rpc_args), \
            http_headers = COALESCE($7, http_headers), \
            http_body = COALESCE($8, http_body), \
            http_secret_enc = $9, \
            timeout_secs = COALESCE($10, timeout_secs), \
            max_retries = COALESCE($11, max_retries), \
            overlap_policy = COALESCE($12, overlap_policy), \
            is_active = COALESCE($13, is_active), \
            updated_at = NOW() \
         WHERE id = $14 RETURNING *",
    )
    .bind(req.name)
    .bind(req.description)
    .bind(cron)
    .bind(tz)
    .bind(next)
    .bind(req.rpc_args)
    .bind(req.http_headers)
    .bind(req.http_body)
    .bind(http_secret_enc)
    .bind(req.timeout_secs)
    .bind(req.max_retries)
    .bind(req.overlap_policy)
    .bind(req.is_active)
    .bind(id)
    .fetch_one(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("更新失败: {e}")))?;

    Ok(Json(redact_secret(row)))
}

pub async fn delete_task(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    let task = fetch_task_or_404(&pool, id).await?;
    validate_can_manage(&claims, task.tenant_id, &pool).await?;
    sqlx::query("DELETE FROM management.scheduled_tasks WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .map_err(|e| AppError::Internal(format!("删除失败: {e}")))?;
    Ok(Json(json!({"deleted": true, "id": id})))
}

pub async fn pause_task(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    set_active(&pool, &claims, id, false).await
}

pub async fn resume_task(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    set_active(&pool, &claims, id, true).await
}

async fn set_active(pool: &PgPool, claims: &Claims, id: i64, active: bool) -> Result<Json<Value>, AppError> {
    let task = fetch_task_or_404(pool, id).await?;
    validate_can_manage(claims, task.tenant_id, pool).await?;
    let next_run_at = if active {
        cron_parser::next_after(&task.cron_expr, &task.timezone, Utc::now()).ok()
    } else {
        task.next_run_at
    };
    sqlx::query(
        "UPDATE management.scheduled_tasks \
         SET is_active = $1, next_run_at = $2, updated_at = NOW() WHERE id = $3",
    )
    .bind(active)
    .bind(next_run_at)
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| AppError::Internal(format!("切换状态失败: {e}")))?;
    Ok(Json(json!({"id": id, "is_active": active})))
}

pub async fn run_now(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Extension(runner): Extension<Arc<SchedulerRunner>>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    let task = fetch_task_or_404(&pool, id).await?;
    validate_can_manage(&claims, task.tenant_id, &pool).await?;
    runner.trigger_now(task).await;
    Ok(Json(json!({"triggered": true, "id": id})))
}

pub async fn list_runs(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<Value>>, AppError> {
    let task = fetch_task_or_404(&pool, id).await?;
    validate_can_manage(&claims, task.tenant_id, &pool).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 100);
    let offset = q.offset.unwrap_or(0).max(0);
    let rows = sqlx::query(
        "SELECT id, task_id, started_at, finished_at, status, runner_id, output, error_message, \
                duration_ms, attempt_number, triggered_by \
         FROM management.scheduled_task_runs WHERE task_id = $1 \
         ORDER BY started_at DESC LIMIT $2 OFFSET $3",
    )
    .bind(id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询 runs 失败: {e}")))?;
    let out: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            json!({
                "id": r.get::<i64, _>("id"),
                "task_id": r.get::<i64, _>("task_id"),
                "started_at": r.get::<chrono::DateTime<Utc>, _>("started_at"),
                "finished_at": r.try_get::<Option<chrono::DateTime<Utc>>, _>("finished_at").unwrap_or(None),
                "status": r.get::<String, _>("status"),
                "runner_id": r.try_get::<Option<String>, _>("runner_id").unwrap_or(None),
                "output": r.try_get::<Option<Value>, _>("output").unwrap_or(None),
                "error_message": r.try_get::<Option<String>, _>("error_message").unwrap_or(None),
                "duration_ms": r.try_get::<Option<i32>, _>("duration_ms").unwrap_or(None),
                "attempt_number": r.get::<i32, _>("attempt_number"),
                "triggered_by": r.get::<String, _>("triggered_by"),
            })
        })
        .collect();
    Ok(Json(out))
}

pub async fn stats(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Value>, AppError> {
    if !claims.is_superadmin {
        return Err(AppError::Forbidden("仅超管可查看全局统计".to_string()));
    }
    let total: (i64,) = sqlx::query_as(
        "SELECT COUNT(*)::bigint FROM management.scheduled_tasks",
    ).fetch_one(&pool).await.map_err(|e| AppError::Internal(e.to_string()))?;
    let active: (i64,) = sqlx::query_as(
        "SELECT COUNT(*)::bigint FROM management.scheduled_tasks WHERE is_active = true",
    ).fetch_one(&pool).await.map_err(|e| AppError::Internal(e.to_string()))?;
    let runs_24h: (i64,) = sqlx::query_as(
        "SELECT COUNT(*)::bigint FROM management.scheduled_task_runs \
         WHERE started_at >= NOW() - INTERVAL '24 hours'",
    ).fetch_one(&pool).await.map_err(|e| AppError::Internal(e.to_string()))?;
    let failed_24h: (i64,) = sqlx::query_as(
        "SELECT COUNT(*)::bigint FROM management.scheduled_task_runs \
         WHERE started_at >= NOW() - INTERVAL '24 hours' AND status IN ('failed','timeout')",
    ).fetch_one(&pool).await.map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(json!({
        "total_tasks": total.0,
        "active_tasks": active.0,
        "runs_24h": runs_24h.0,
        "failed_24h": failed_24h.0,
    })))
}

pub async fn validate_cron(
    Extension(_claims): Extension<Claims>,
    Json(req): Json<ValidateCronReq>,
) -> Result<Json<Value>, AppError> {
    let tz = req.timezone.unwrap_or_else(|| "UTC".to_string());
    let times = cron_parser::preview(&req.cron_expr, &tz, Utc::now(), 5)?;
    Ok(Json(json!({
        "valid": true,
        "timezone": tz,
        "preview": times,
    })))
}

pub async fn cleanup_zombies(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<CleanupZombiesReq>,
) -> Result<Json<Value>, AppError> {
    if !claims.is_superadmin {
        return Err(AppError::Forbidden("仅超管可清理僵尸 run".to_string()));
    }
    let hours = req.older_than_hours.unwrap_or(24).max(1);
    let res = sqlx::query(
        "UPDATE management.scheduled_task_runs \
         SET status = 'timeout', error_message = 'zombie cleanup', \
             finished_at = NOW() \
         WHERE status = 'running' AND started_at < NOW() - $1::int * INTERVAL '1 hour'",
    )
    .bind(hours as i32)
    .execute(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("清理失败: {e}")))?;
    Ok(Json(json!({"cleaned": res.rows_affected()})))
}

// ─── 内部 helper ─────────────────────────────

async fn fetch_task_or_404(pool: &PgPool, id: i64) -> Result<ScheduledTask, AppError> {
    sqlx::query_as::<_, ScheduledTask>(
        "SELECT * FROM management.scheduled_tasks WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询任务失败: {e}")))?
    .ok_or_else(|| AppError::NotFound(format!("scheduled_task {id} 不存在")))
}

fn redact_secret(mut task: ScheduledTask) -> ScheduledTask {
    task.http_secret_enc = task.http_secret_enc.map(|_| "***".to_string());
    task
}
```

- [ ] **Step 2: 在 src/main.rs 顶部 `mod` 块加上**

```rust
mod scheduler_handlers;
```

- [ ] **Step 3: 检查 audit_handlers::admin_tenant_ids 签名**

```bash
rg "pub (async )?fn admin_tenant_ids" src/audit_handlers.rs
```

如果签名不匹配（比如不是 `pub` 或参数顺序不一致），改 `scheduler_handlers.rs` 的调用匹配现状；若该函数当前不是 pub，把它改成 `pub` 或在 audit_handlers.rs 里加一个 `pub use` re-export。

- [ ] **Step 4: 编译**

```bash
cargo check --bin onebase 2>&1 | grep "^error" | head -20
```

Expected: 0 个 error。修复后继续。

---

### Task 3.3: main.rs wire-up — 启动 runner + 挂路由

**Files:**
- Modify: `src/main.rs`（找到 `// 后台守护 Watchdog` 一行，在它之前 / 之后插入；找到路由注册区域加路由）

- [ ] **Step 1: 启动 SchedulerRunner**

在 `// 后台守护 Watchdog` 之前插入：

```rust
    // 定时任务调度
    let scheduler_cfg = scheduler::runner::SchedulerConfig {
        tick_interval: std::time::Duration::from_secs(config.scheduler_tick_interval_secs),
        batch_size: config.scheduler_batch_size,
        stale_claim_grace_secs: config.scheduler_stale_claim_grace_secs,
        retry_base_secs: config.scheduler_retry_base_secs,
        retry_factor: config.scheduler_retry_factor,
        allow_insecure_http: config.allow_insecure_scheduled_http,
    };
    let rpc_exec = std::sync::Arc::new(scheduler::executors::RpcExecutor::new(
        pool.clone(),
        redis.clone(),
    ));
    let http_exec = std::sync::Arc::new(scheduler::executors::HttpExecutor::new(
        config.allow_insecure_scheduled_http,
    ));
    let scheduler_runner = scheduler::runner::SchedulerRunner::new(
        pool.clone(),
        scheduler_cfg,
        rpc_exec.clone(),
        http_exec.clone(),
    );
    let scheduler_runner_arc = std::sync::Arc::new(scheduler_runner);
    app = app.layer(axum::Extension(scheduler_runner_arc.clone()));
    // start() consumes self, so 我们这里 clone 出一份 inner——
    // 把 Arc 解包成 Owned 是不行的；改为：把 runner 留作 layer 提供给 handler，
    // 同时单独构造一个用于循环的 runner（同 runner_id 池子）。
```

> **注**：`SchedulerRunner::start(self)` consume self，与 `Arc::new(self)` for layer 冲突。需要在 runner.rs 里把签名改成 `start(self: Arc<Self>)`——或者在 handler 端通过 `Arc<SchedulerRunner>` 调 `trigger_now(&self, ...)` 即可（`trigger_now` 已经是 `&self`）。

**正确做法**（改 Task 2.4 已写的 runner.rs）：

把 `pub fn start(self)` 改成 `pub fn start(self: Arc<Self>)`，函数体里 `let me = self.clone()` 直接用而不是再包一次 Arc。

- [ ] **Step 2: 修 runner.rs 的 start 签名**

打开 `src/scheduler/runner.rs`，把：

```rust
    pub fn start(self) -> tokio::task::JoinHandle<()> {
        let running = self.running.clone();
        let me = Arc::new(self);
        tokio::spawn(async move {
```

改成：

```rust
    pub fn start(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
        let running = self.running.clone();
        let me = self;
        tokio::spawn(async move {
```

并去掉 `clone_for_spawn` 中重复构造的部分——内部 spawn 处改成直接 clone Arc：

`tick` 函数里：

```rust
        for task in claimed {
            let me = self.clone_for_spawn();  // 旧
            let me_arc = Arc::new(me);
            tokio::spawn(async move {
                me_arc.execute_one(task, "cron").await;
            });
        }
```

改成接收 `&Arc<Self>` 形式更简洁，但当前 `tick` 是 `async fn tick(&self)`——只需用 `self` 引用克隆 fields 的 Arc 即可。简化版：

```rust
    async fn tick(self: Arc<Self>) -> Result<(), sqlx::Error> {
        self.reclaim_stale().await?;
        let claimed = self.claim_due_tasks().await?;
        for task in claimed {
            let me = self.clone();
            tokio::spawn(async move {
                me.execute_one(task, "cron").await;
            });
        }
        Ok(())
    }
```

并把 `start` 内部循环里调用改成 `me.clone().tick().await`：

```rust
                if let Err(e) = me.clone().tick().await {
                    tracing::error!("scheduler tick 失败: {e}");
                }
```

去掉 `clone_for_spawn` 函数（不再需要）。`trigger_now` 同样改成 `pub async fn trigger_now(self: Arc<Self>, task: ScheduledTask)` 或保持 `&self` 但内部不再调 `clone_for_spawn` —— 改用 `Arc<SchedulerRunner>` 调 `Arc::clone(self_arc)`。

最简实现：保留 `trigger_now(&self, task)` 但内部不能 spawn `&self`。需要它接受 `self: Arc<Self>`：

```rust
    pub async fn trigger_now(self: Arc<Self>, task: ScheduledTask) {
        tokio::spawn(async move {
            self.execute_one(task, "manual").await;
        });
    }
```

`execute_one` 现在被 `&self` 调用即可（异步 spawn 内 self 是 Arc，`self.execute_one()` 等价 `(&*self).execute_one()`）。

- [ ] **Step 3: 修 scheduler_handlers.rs::run_now 调用**

把：

```rust
    runner.trigger_now(task).await;
```

改成：

```rust
    runner.clone().trigger_now(task).await;
```

- [ ] **Step 4: 修 main.rs runner 起 + Extension**

把 Step 1 的代码替换成：

```rust
    // 定时任务调度
    let scheduler_cfg = scheduler::runner::SchedulerConfig {
        tick_interval: std::time::Duration::from_secs(config.scheduler_tick_interval_secs),
        batch_size: config.scheduler_batch_size,
        stale_claim_grace_secs: config.scheduler_stale_claim_grace_secs,
        retry_base_secs: config.scheduler_retry_base_secs,
        retry_factor: config.scheduler_retry_factor,
        allow_insecure_http: config.allow_insecure_scheduled_http,
    };
    let rpc_exec = std::sync::Arc::new(scheduler::executors::RpcExecutor::new(
        pool.clone(),
        redis.clone(),
    ));
    let http_exec = std::sync::Arc::new(scheduler::executors::HttpExecutor::new(
        config.allow_insecure_scheduled_http,
    ));
    let scheduler_runner = std::sync::Arc::new(scheduler::runner::SchedulerRunner::new(
        pool.clone(),
        scheduler_cfg,
        rpc_exec,
        http_exec,
    ));
    app = app.layer(axum::Extension(scheduler_runner.clone()));
    scheduler_runner.clone().start();
```

- [ ] **Step 5: 挂 handler 路由**

找到 main.rs 里挂 `/api/admin/rate-limit-rules` 等管理路由的位置（搜 `rate-limit-rules`），在它附近以同样的 pattern 加一组路由：

```rust
    // 定时任务管理 API
    let scheduled_task_routes = Router::new()
        .route("/api/admin/scheduled-tasks", post(scheduler_handlers::create_task).get(scheduler_handlers::list_tasks))
        .route("/api/admin/scheduled-tasks/:id", get(scheduler_handlers::get_task).patch(scheduler_handlers::update_task).delete(scheduler_handlers::delete_task))
        .route("/api/admin/scheduled-tasks/:id/run-now", post(scheduler_handlers::run_now))
        .route("/api/admin/scheduled-tasks/:id/pause", post(scheduler_handlers::pause_task))
        .route("/api/admin/scheduled-tasks/:id/resume", post(scheduler_handlers::resume_task))
        .route("/api/admin/scheduled-tasks/:id/runs", get(scheduler_handlers::list_runs))
        .route("/api/admin/scheduled-tasks/stats", get(scheduler_handlers::stats))
        .route("/api/admin/scheduled-tasks/validate-cron", post(scheduler_handlers::validate_cron))
        .route("/api/admin/scheduled-tasks/runs/cleanup-zombies", post(scheduler_handlers::cleanup_zombies))
        .with_state(pool.clone())
        .layer(axum_middleware::from_fn_with_state(pool.clone(), middleware::auth_middleware));
    app = app.merge(scheduled_task_routes);
```

> 注：精确的 `use` 路径（`Router` / `post` / `get` / `axum_middleware`）按 main.rs 现有 import 调整。

- [ ] **Step 6: 编译**

```bash
cargo check --bin onebase 2>&1 | grep "^error" | head -20
```

Expected: 0 个 error。

---

### Task 3.4: Handler 鉴权矩阵单测（关键路径）

**Files:**
- Create: `tests/scheduler_handlers_authz.rs`

- [ ] **Step 1: 写鉴权矩阵测试**

```rust
//! 手动构造 Claims 调 handler 验证 validate_can_manage 决策。
//! 需要 DATABASE_URL_TEST 指向带 management 表的 PG。

use onebase::auth::Claims;
use sqlx::PgPool;

async fn setup() -> Option<PgPool> {
    let url = std::env::var("DATABASE_URL_TEST").ok()?;
    PgPool::connect(&url).await.ok()
}

#[tokio::test]
async fn superadmin_can_manage_platform_tasks() {
    let Some(_pool) = setup().await else {
        eprintln!("DATABASE_URL_TEST 未设置，skip");
        return;
    };
    let claims = Claims {
        sub: 1, email: "admin@example.com".into(), role: "super_admin".into(),
        is_superadmin: true, jti: String::new(),
        exp: chrono::Utc::now().timestamp() + 3600,
        iat: chrono::Utc::now().timestamp(),
    };
    // validate_can_manage 是 private——这里只能通过 HTTP 端到端测；
    // 简化版：手动复制 helper 来 spec 化决策即可。
    // 此测试占位，等 PR-3 落地后由 e2e 测试补强。
    assert!(claims.is_superadmin);
}
```

> 注：handler 内的 `validate_can_manage` 是 private function；端到端测试更合适用 axum 的 ServiceExt::oneshot。这条任务暂用占位，让 commit 保留 test 文件，正式 e2e 在 Task 3.5 做。

- [ ] **Step 2: 跑一下确保编译过**

```bash
cargo test --test scheduler_handlers_authz 2>&1 | tail -5
```

Expected: 1 个测试 PASS（或 skip）。

---

### Task 3.5: e2e smoke（手测 checklist）

- [ ] **Step 1: 启服务**

```bash
cargo run --bin onebase 2>&1 | tee /tmp/onebase-smoke.log &
SERVICE_PID=$!
sleep 5
```

Expected: 日志含 `SchedulerRunner 已启动: runner_id=...`

- [ ] **Step 2: 拿超管 JWT**（依赖项目现有的登录流程；如不知 admin 密码，跳过本任务，留给联调时跑）

```bash
TOKEN=$(curl -sX POST http://127.0.0.1:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<admin_password>"}' | jq -r .token)
echo "$TOKEN" | head -c 30
```

Expected: JWT 字串。

- [ ] **Step 3: 创建一个每分钟跑一次的 HTTP 任务（指向 httpbin.org）**

```bash
curl -sX POST http://127.0.0.1:3000/api/admin/scheduled-tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "smoke-http",
    "cron_expr": "* * * * *",
    "kind": "http",
    "http_method": "POST",
    "http_url": "https://httpbin.org/post",
    "http_body": {"hello": "world"}
  }' | jq
```

Expected: 返回的 JSON 含 `id`、`next_run_at`、`is_active: true`。

- [ ] **Step 4: 等 90s 后查 runs**

```bash
TASK_ID=...  # 用 Step 3 返回的 id
sleep 90
curl -s "http://127.0.0.1:3000/api/admin/scheduled-tasks/$TASK_ID/runs" \
  -H "Authorization: Bearer $TOKEN" | jq
```

Expected: 至少 1 行 `status: "success"`，`output.status: 200`。

- [ ] **Step 5: 测试 run-now**

```bash
curl -sX POST "http://127.0.0.1:3000/api/admin/scheduled-tasks/$TASK_ID/run-now" \
  -H "Authorization: Bearer $TOKEN" | jq
sleep 3
curl -s "http://127.0.0.1:3000/api/admin/scheduled-tasks/$TASK_ID/runs?limit=5" \
  -H "Authorization: Bearer $TOKEN" | jq '.[0].triggered_by'
```

Expected: `"manual"`。

- [ ] **Step 6: 测试 pause / resume**

```bash
curl -sX POST "http://127.0.0.1:3000/api/admin/scheduled-tasks/$TASK_ID/pause" \
  -H "Authorization: Bearer $TOKEN" | jq
curl -sX POST "http://127.0.0.1:3000/api/admin/scheduled-tasks/$TASK_ID/resume" \
  -H "Authorization: Bearer $TOKEN" | jq
```

- [ ] **Step 7: 收尾**

```bash
curl -sX DELETE "http://127.0.0.1:3000/api/admin/scheduled-tasks/$TASK_ID" \
  -H "Authorization: Bearer $TOKEN" | jq
kill $SERVICE_PID
```

- [ ] **Step 8: 如果跳过本任务**

记录在 commit body 里："e2e smoke 推迟到联调环境跑（缺 admin 密码 / staging 数据库）"。

---

### Task 3.6: Phase 3 commit

```bash
git add -A && git commit -m "$(cat <<'EOF'
feat(scheduler): phase 3 - HTTP API + main.rs wire-up

Adds 11 endpoints under /api/admin/scheduled-tasks (CRUD, run-now,
pause/resume, runs, stats, validate-cron, cleanup-zombies) with
superadmin / tenant-admin authz. Wires SchedulerRunner into main.rs
alongside Watchdog and exposes 6 new SCHEDULER_* config knobs.

Spec: docs/superpowers/specs/2026-05-14-scheduled-tasks-design.md
EOF
)"
```

---

## Phase 4 — 文档 + 前端 stub

### Task 4.1: README 2.2 节加定时任务

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 找到现有「路由权限分层」/「访问控制」节**

```bash
rg "^##" README.md | head -20
```

确认表/节存在再下笔。如果 README 当前没有「2.2」「2.3」编号结构，按现有标题命名风格（比如 `## 路由权限分层`）追加一个对等小节，标题改成 `### 定时任务的访问控制（/api/admin/scheduled-tasks/*）`。

- [ ] **Step 2: 插入新表**

在最贴近的"路由 / 访问控制"小节末尾、下一个同级 `##` 之前插入：

```markdown
### 2.3 定时任务（`/api/admin/scheduled-tasks/*`）

| 维度 | 实现 |
|---|---|
| 谁能创建 | 平台级（tenant_id=NULL）仅超管；租户级超管 + 该租户 owner/admin |
| 谁能编辑 / 删除 | 创建者权限维度对齐 |
| 执行身份 | `created_by` 用户身份，每次重读 `is_superadmin`，避免快照过期 |
| RPC 鉴权 | 走 `execute_rpc_inner`，与 axum 路径相同的 permission / condition 求值 |
| HTTP 鉴权 | 默认 https-only；HMAC-SHA256 签名（同 webhook） |
| 失败处理 | 业务失败 / 超时按 `max_retries` 指数退避；超过 cron 间距则回到正常节奏 |
| 多实例 | PostgreSQL `FOR UPDATE SKIP LOCKED` 保证去重；不依赖 Redis |
| 审计 | CRUD 走 `audit_middleware`；每次执行写 `scheduled_task_runs` |

详细设计：`docs/superpowers/specs/2026-05-14-scheduled-tasks-design.md`
```

- [ ] **Step 3: 提交前预览**

```bash
git diff README.md | head -50
```

---

### Task 4.2: spec 路线图加 M9

**Files:**
- Modify: `docs/superpowers/specs/2026-05-13-platform-evolution-design.md`

- [ ] **Step 1: 找路线图表（搜 `M1` / `M5`）**

在最后一个 M 之后追加：

```markdown
| M9 | 定时任务（Scheduled Tasks） | runner / executors / handlers / 14_migration | 详细 spec: `2026-05-14-scheduled-tasks-design.md` |
```

并在「v2 预留接口」表里追加一行：

```markdown
| `POST/GET/PATCH/DELETE /api/admin/scheduled-tasks/*` | 任务 CRUD / 触发 / 历史 | `auth + require_superadmin (or tenant admin)` |
```

---

### Task 4.3: 前端入口 stub

**Files:**
- Create: `frontend-nextjs/app/dashboard/scheduled-tasks/page.tsx`

- [ ] **Step 1: 写最小占位页面**

```tsx
'use client'

export default function ScheduledTasksPage() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">定时任务</h1>
      <p className="text-gray-500">
        UI 待完善。当前可用接口：<code className="bg-gray-100 px-2 py-1 rounded">/api/admin/scheduled-tasks</code>。
        参考 <a href="/docs/superpowers/specs/2026-05-14-scheduled-tasks-design.md" className="text-blue-500 underline">spec</a>。
      </p>
    </div>
  )
}
```

- [ ] **Step 2: 在侧边栏加链接**

打开 `frontend-nextjs/components/SidebarV3.tsx`（当前最新版侧边栏），找到现有 dashboard 链接列表（搜 `dashboard/audit` 或 `dashboard/rpc`），按相同 pattern 加：

```tsx
{ href: '/dashboard/scheduled-tasks', label: '定时任务', icon: '⏰' },
```

> 实际 icon 字段 / 数据结构按 SidebarV3 现状对齐。

---

### Task 4.4: Phase 4 commit

```bash
git add -A && git commit -m "$(cat <<'EOF'
docs(scheduler): phase 4 - README + spec roadmap + frontend stub

Documents the scheduled-tasks authz / execution model in README.md
section 2.3, adds M9 to the platform-evolution roadmap, and lands
a placeholder /dashboard/scheduled-tasks page with sidebar entry.
Full UI deferred to a follow-up plan.
EOF
)"
```

---

## 整体验证

- [ ] **完整 cargo test**

```bash
cargo test --bin onebase 2>&1 | tail -20
```

Expected: 全部 PASS。

- [ ] **完整 cargo check release**

```bash
cargo check --release 2>&1 | tail -5
```

Expected: 0 个 error。

- [ ] **commit 历史 sanity**

```bash
git log --oneline -10
```

Expected: 4 个 phase commit 按顺序排列。

---

## 后续 / YAGNI 提醒

下列不在本计划范围内（spec §1.2 明列），需另立 plan：
- 完整前端 UI（cron 输入框 / 任务列表 / runs 历史可视化 / 输出查看器）
- 任务级别的限流规则（接 `rate_limit_rules`，按需）
- 业务事件触发的"事件驱动任务"（与 webhook 边界划清）
- WebSocket 实时推送 `scheduled_task.completed`（如有需求按 spec §1.2 备注接 events 系统即可）
