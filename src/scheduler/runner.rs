//! 调度循环：每 `tick_interval` 一次，
//!   Step 1 回收陈旧 claim（仅当 `claimed_at < NOW - (timeout + grace)`）
//!   Step 2 `SELECT ... FOR UPDATE SKIP LOCKED` 批量 claim 到期任务
//!   Step 3 每个 claimed task 独立 `tokio::spawn` 执行 `execute_one`
//!
//! ## 设计要点
//!
//! - `start` / `tick` / `trigger_now` 都接 `self: Arc<Self>`，让后台 task 用
//!   `Arc::clone` 即可拿到执行权，handler 通过 `Arc<SchedulerRunner>` Extension
//!   一并复用同一份状态；不需要内部再嵌一层 `clone_for_spawn`。
//! - `tick` 失败不退出循环——sqlx 错误降级为 `tracing::error!` 并下个 tick 重试。
//! - 多实例去重：claim 阶段的 `FOR UPDATE SKIP LOCKED` 是 PG 官方 work-queue
//!   recipe，scheduler_runner_integration 测试覆盖这一点。
//! - overlap=skip 在 `execute_one` 内部判定：先写一行 `running`，再查同 task 是否
//!   已有另一行 `running`，有就把自己标 cancelled 并把 next_run_at 推到 cron 下一次。

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{PgPool, Row};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;

use crate::scheduler::cron_parser::next_after;
use crate::scheduler::executors::{HttpExecutorRef, RpcExecutorRef, ShellExecutorRef};
use crate::scheduler::models::ScheduledTask;

#[derive(Clone, Debug)]
pub struct SchedulerConfig {
    pub tick_interval: Duration,
    pub batch_size: i64,
    pub stale_claim_grace_secs: i64,
    pub retry_base_secs: i64,
    pub retry_factor: u32,
    /// 同时执行的任务数上限（`execute_one` 并发闸门）。
    ///
    /// 每个 `execute_one` 都会向**管理库池**做多次读写；若不限并发，单个 tick 可能一次
    /// spawn `batch_size`（默认 32）个任务瞬间抢光连接池（默认 20），进而拖垮探活 /
    /// 日志落库 / 健康探针，触发 k8s 反复重启。该值应显著小于 `DB_MAX_CONNECTIONS`，
    /// 给 HTTP 流量与后台写入留出连接余量。默认 8。
    pub max_concurrency: usize,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            tick_interval: Duration::from_secs(5),
            batch_size: 32,
            stale_claim_grace_secs: 30,
            retry_base_secs: 60,
            retry_factor: 2,
            max_concurrency: 8,
        }
    }
}

pub struct SchedulerRunner {
    pool: PgPool,
    runner_id: String,
    config: SchedulerConfig,
    rpc_exec: RpcExecutorRef,
    http_exec: HttpExecutorRef,
    shell_exec: ShellExecutorRef,
    running: Arc<AtomicBool>,
    /// 并发闸门：限制同时在跑的 `execute_one` 数量（见 `SchedulerConfig::max_concurrency`）。
    exec_sem: Arc<Semaphore>,
}

impl SchedulerRunner {
    pub fn new(
        pool: PgPool,
        config: SchedulerConfig,
        rpc_exec: RpcExecutorRef,
        http_exec: HttpExecutorRef,
        shell_exec: ShellExecutorRef,
    ) -> Self {
        let hostname = hostname_best_effort();
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let runner_id = format!("{hostname}-{pid}-{nanos}");
        let exec_sem = Arc::new(Semaphore::new(config.max_concurrency.max(1)));
        Self {
            pool,
            runner_id,
            config,
            rpc_exec,
            http_exec,
            shell_exec,
            running: Arc::new(AtomicBool::new(true)),
            exec_sem,
        }
    }

    pub fn shutdown_handle(&self) -> Arc<AtomicBool> {
        self.running.clone()
    }

    #[allow(dead_code)]
    pub fn runner_id(&self) -> &str {
        &self.runner_id
    }

    // ── executor 引用暴露给 handler 层。
    //
    // dry-run 端点（POST /api/admin/scheduled-tasks/dry-run）需要拿到这三个 Arc 直接
    // 调用对应 executor，而不经过完整的 claim → execute_one → 写 run 记录的流程：
    //   - dry-run 不该污染 scheduled_task_runs（否则统计 / 失败告警会把试错当真实跑）
    //   - 也不该改 next_run_at / claimed_at
    //   - 但要复用同一份 executor 实例（共享 reqwest::Client / Redis 连接池 / sandbox
    //     决议结果），避免在 handler 里重新 new 一份导致行为漂移
    pub fn rpc_exec(&self) -> &RpcExecutorRef {
        &self.rpc_exec
    }
    pub fn http_exec(&self) -> &HttpExecutorRef {
        &self.http_exec
    }
    pub fn shell_exec(&self) -> &ShellExecutorRef {
        &self.shell_exec
    }

    /// 启动循环——返回 JoinHandle 由调用方持有以便 `abort()`。
    /// 接 `self: Arc<Self>` 让 handler 也持有同一份 runner（用 Extension 注入）。
    pub fn start(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
        let running = self.running.clone();
        let me = self;
        tokio::spawn(async move {
            tracing::info!(
                "SchedulerRunner 已启动: runner_id={} tick={:?} batch={} max_concurrency={}",
                me.runner_id,
                me.config.tick_interval,
                me.config.batch_size,
                me.config.max_concurrency
            );
            while running.load(Ordering::Relaxed) {
                tokio::time::sleep(me.config.tick_interval).await;
                if !running.load(Ordering::Relaxed) {
                    break;
                }
                if let Err(e) = me.clone().tick().await {
                    tracing::error!("scheduler tick 失败: {e}");
                }
            }
            tracing::info!("SchedulerRunner 已停止");
        })
    }

    async fn tick(self: Arc<Self>) -> Result<(), sqlx::Error> {
        self.reclaim_stale().await?;
        let claimed = self.claim_due_tasks().await?;
        for task in claimed {
            let me = self.clone();
            // 并发闸门：先拿 permit 再执行，避免一次 tick 把管理库连接池抢光。permit 随
            // spawn 出去的任务持有，任务结束（含 timeout / panic）自动归还。
            let permit = match me.exec_sem.clone().acquire_owned().await {
                Ok(p) => p,
                Err(_) => break, // Semaphore 已关闭（仅进程收尾时发生），停止本轮派发。
            };
            tokio::spawn(async move {
                let _permit = permit;
                me.execute_one(task, "cron").await;
            });
        }
        Ok(())
    }

    /// 立即触发一次（手动 run-now 入口）。不走 claim 流程——直接调用 `execute_one`，
    /// `triggered_by='manual'`。
    pub async fn trigger_now(self: Arc<Self>, task: ScheduledTask) {
        let me = self;
        // 手动 run-now 也走同一并发闸门，避免大批量手动触发绕过限流击穿连接池。
        let permit = match me.exec_sem.clone().acquire_owned().await {
            Ok(p) => p,
            Err(_) => return,
        };
        tokio::spawn(async move {
            let _permit = permit;
            me.execute_one(task, "manual").await;
        });
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
        // SKIP LOCKED 是多实例去重的关键——不要改成普通 SELECT。
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

    async fn execute_one(&self, task: ScheduledTask, triggered_by: &str) {
        // 本次执行的统一关联键：cron / run-now 都没有（或跨 spawn 后读不到）HTTP 请求
        // 上下文，故现场生成 UUID。写进 scheduled_task_runs.trace_id 与 execution_index，
        // 让统一执行日志列表能把这次定时任务和它的 run 记录串起来。
        let trace_id = crate::execution_log::new_trace_id();

        // overlap=skip 在 INSERT 之前判定——否则两个并发 /run-now 都会先各自写一行
        // status='running'，再都看到对方的 running 而把自己 cancel 掉，净结果 0 次执行。
        //
        // 注：这里的 SELECT-then-INSERT 仍有一个理论上的竞态——两个并发 /run-now 都看到
        // count=0 后各自 INSERT。该窗口在调度 tick 路径里靠 FOR UPDATE SKIP LOCKED 兜底，
        // 在 /run-now 路径里依靠 API 限流（rate_limit_middleware）兜底。要彻底消除需要
        // 数据库级 advisory_lock 或部分唯一索引，YAGNI 暂不做。
        if task.overlap_policy == "skip" {
            if let Ok(n) = self.count_existing_running_runs(task.id).await {
                if n > 0 {
                    let attempt = self.current_attempt(&task).await.unwrap_or(1);
                    match self
                        .create_run_record_with_status(
                            &task,
                            &trace_id,
                            triggered_by,
                            attempt,
                            "cancelled",
                            Some("overlap with previous run"),
                        )
                        .await
                    {
                        Ok(run_id) => {
                            crate::execution_log::record_terminal(
                                &self.pool,
                                &trace_id,
                                "scheduler",
                                Some("scheduled_task_runs"),
                                Some(run_id),
                                task.tenant_id,
                                None,
                                Some(&task.name),
                                "cancelled",
                                Some(0),
                                Some("overlap with previous run"),
                            )
                            .await;
                        }
                        Err(e) => {
                            tracing::error!(
                                "create_run_record_with_status 失败 task_id={}: {e}",
                                task.id
                            );
                        }
                    }
                    tracing::warn!("task_id={} overlap=skip：跳过本次触发", task.id);
                    if let Err(e) = self
                        .update_task_after_run(&task, "cancelled", self.cron_next_safe(&task))
                        .await
                    {
                        tracing::error!("update_task_after_run 失败 task_id={}: {e}", task.id);
                    }
                    return;
                }
            }
            // 查询失败时落到下面正常路径——不为瞬时 DB 抖动阻塞调度。
        }

        let started_at = Utc::now();
        let attempt = self.current_attempt(&task).await.unwrap_or(1);

        let run_id = match self
            .create_run_record(&task, &trace_id, triggered_by, attempt)
            .await
        {
            Ok(id) => id,
            Err(e) => {
                tracing::error!("写 run 起始记录失败 task_id={}: {e}", task.id);
                if let Err(e) = self.release_with_cron(&task).await {
                    tracing::error!("release_with_cron 失败 task_id={}: {e}", task.id);
                }
                return;
            }
        };

        // 统一执行索引：写一行 running，收口时 finish。失败返回 None，后续 finish 自动跳过。
        let index_id = crate::execution_log::begin_index(
            &self.pool,
            &trace_id,
            "scheduler",
            Some("scheduled_task_runs"),
            Some(run_id),
            task.tenant_id,
            None,
            Some(&task.name),
        )
        .await;

        let timeout = Duration::from_secs(task.timeout_secs.max(1) as u64);
        let exec_future: std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<Value, String>> + Send>,
        > = match task.kind.as_str() {
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
            "shell" => Box::pin({
                let shell = self.shell_exec.clone();
                let t = task.clone();
                async move { shell.execute(&t).await }
            }),
            other => {
                tracing::error!("未知任务类型 kind={} task_id={}", other, task.id);
                let unknown_err = format!("unknown kind: {other}");
                if let Err(e) = self
                    .finalize_run(run_id, "failed", None, Some(&unknown_err), started_at)
                    .await
                {
                    tracing::error!(
                        "finalize_run 失败 run_id={} task_id={}: {e}",
                        run_id,
                        task.id
                    );
                }
                crate::execution_log::finish_index(
                    &self.pool,
                    index_id,
                    "failed",
                    Some((Utc::now() - started_at).num_milliseconds().max(0)),
                    Some(&unknown_err),
                )
                .await;
                if let Err(e) = self
                    .update_task_after_run(&task, "failed", self.cron_next_safe(&task))
                    .await
                {
                    tracing::error!("update_task_after_run 失败 task_id={}: {e}", task.id);
                }
                return;
            }
        };

        let outcome = tokio::time::timeout(timeout, exec_future).await;

        let (status, output, err_msg) = match outcome {
            Ok(Ok(v)) => ("success", Some(truncate_output(v)), None),
            Ok(Err(e)) => ("failed", None, Some(e)),
            Err(_) => ("timeout", None, Some("execution timed out".to_string())),
        };

        if let Err(e) = self
            .finalize_run(run_id, status, output, err_msg.as_deref(), started_at)
            .await
        {
            tracing::error!(
                "finalize_run 失败 run_id={} task_id={}: {e}",
                run_id,
                task.id
            );
        }

        crate::execution_log::finish_index(
            &self.pool,
            index_id,
            status,
            Some((Utc::now() - started_at).num_milliseconds().max(0)),
            err_msg.as_deref(),
        )
        .await;

        let next_run_at = self.compute_next_run_at(&task, status, attempt);
        if let Err(e) = self.update_task_after_run(&task, status, next_run_at).await {
            tracing::error!("update_task_after_run 失败 task_id={}: {e}", task.id);
        }

        if matches!(status, "failed" | "timeout") && attempt >= task.max_retries {
            crate::alert_webhook::spawn_scheduled_task_failure_alert(
                self.pool.clone(),
                task.id,
                crate::alert_webhook::AlertWebhookContext {
                    source: "scheduled_task",
                    object_id: task.id,
                    run_id,
                    name: task.name.clone(),
                    status: status.to_string(),
                    error: err_msg,
                    trigger_type: triggered_by.to_string(),
                    trace_id: Some(trace_id),
                },
            );
        }
    }

    /// 计算下一次 next_run_at。spec §8.2 的"重试窗口溢出"规则：
    /// 若 `backoff_at >= cron_next` 直接回到 cron 节奏，相当于放弃这一轮重试。
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
        // failed / timeout 才走重试退避。
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

    /// 当前尝试次数 = 同 task 最近一行的 attempt_number + 1（若上一行是 failed/timeout
    /// 且重试预算还没耗尽），否则 = 1（cron 触发的新一轮，attempt 重置）。
    ///
    /// 重置规则（spec §8.2「attempt > max_retries: 回到正常 cron 节奏，attempt 重置为 1」）：
    /// - `success` / `cancelled`：上一轮干净结束，新触发起点
    /// - `running`：通常出现在 overlap_policy='allow' 下两个并发 run，彼此不算重试链
    /// - `failed` / `timeout` 且 `n >= max_retries`：重试预算已耗尽，下一次必然是新 cron 周期
    /// - `failed` / `timeout` 且 `n < max_retries`：仍在重试链上，attempt 累加
    async fn current_attempt(&self, task: &ScheduledTask) -> Result<i32, sqlx::Error> {
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
                if matches!(st.as_str(), "success" | "cancelled" | "running") {
                    1
                } else if n >= task.max_retries {
                    1
                } else {
                    n + 1
                }
            }
            None => 1,
        })
    }

    /// 是否还有同 task 的 running 行。用于 overlap=skip 的前置判定（在 INSERT 之前）。
    async fn count_existing_running_runs(&self, task_id: i64) -> Result<i64, sqlx::Error> {
        let row = sqlx::query(
            "SELECT COUNT(*)::bigint AS n FROM management.scheduled_task_runs \
             WHERE task_id = $1 AND status = 'running'",
        )
        .bind(task_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.get::<i64, _>("n"))
    }

    async fn create_run_record(
        &self,
        task: &ScheduledTask,
        trace_id: &str,
        triggered_by: &str,
        attempt: i32,
    ) -> Result<i64, sqlx::Error> {
        let row = sqlx::query(
            "INSERT INTO management.scheduled_task_runs \
                (task_id, status, runner_id, attempt_number, triggered_by, trace_id) \
             VALUES ($1, 'running', $2, $3, $4, $5) RETURNING id",
        )
        .bind(task.id)
        .bind(&self.runner_id)
        .bind(attempt)
        .bind(triggered_by)
        .bind(trace_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.get::<i64, _>("id"))
    }

    /// 用指定终态直接落一行 run（finished_at = NOW）。给 overlap=skip 写 cancelled 用，
    /// 避免先 INSERT(running) → UPDATE(cancelled) 两步留出 running 窗口。
    async fn create_run_record_with_status(
        &self,
        task: &ScheduledTask,
        trace_id: &str,
        triggered_by: &str,
        attempt: i32,
        status: &str,
        error_message: Option<&str>,
    ) -> Result<i64, sqlx::Error> {
        let row = sqlx::query(
            "INSERT INTO management.scheduled_task_runs \
                (task_id, status, runner_id, attempt_number, triggered_by, finished_at, error_message, trace_id) \
             VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7) RETURNING id",
        )
        .bind(task.id)
        .bind(status)
        .bind(&self.runner_id)
        .bind(attempt)
        .bind(triggered_by)
        .bind(error_message)
        .bind(trace_id)
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

    /// 启动阶段就 release：写 run 起始失败时调用，避免 claim 长期占着。
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

/// 200KB 截断阈值——超过则替换为带 `truncated`/`size_bytes`/`preview` 的占位对象，
/// 防止单次 RPC 返回的大 JSON 把 `scheduled_task_runs.output` 写爆。
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

/// 启动期解析一次本机 hostname，用于 runner_id 前缀。
///
/// 之前直接读 `HOSTNAME` env：在容器 / K8s 里 OK（Docker 会自动 export），但 macOS dev
/// 上 bash 把 `HOSTNAME` 当 shell parameter 而不是环境变量，导致 cargo run 看到的就是
/// 空，最后 runner_id 变成 `unknown-<pid>-<ts>` —— 多实例追踪难看也容易误以为是 bug。
///
/// 改成三段兜底：
///   1. `HOSTNAME` env（容器原生，最快）
///   2. 同步 spawn `hostname` 命令（POSIX 一刀切，Linux/macOS 都有；只在启动时跑一次，
///      之后 runner_id 是 String 字段，不会再调）
///   3. 读 `/etc/hostname` 文件（少数 hostname 命令缺失的 minimal 容器；trim 换行）
///   4. 最后才回落到 "unknown"
///
/// 不引入 libc / hostname crate，避免单一字段值膨胀依赖图。
fn hostname_best_effort() -> String {
    if let Ok(h) = std::env::var("HOSTNAME") {
        let h = h.trim();
        if !h.is_empty() {
            return h.to_string();
        }
    }
    if let Ok(out) = std::process::Command::new("hostname").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                return s;
            }
        }
    }
    if let Ok(s) = std::fs::read_to_string("/etc/hostname") {
        let s = s.trim();
        if !s.is_empty() {
            return s.to_string();
        }
    }
    "unknown".to_string()
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
    // 查询）；放在 Task 2.5 集成测试里跑，而不是这里桩出来。
}
