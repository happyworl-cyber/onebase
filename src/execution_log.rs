//! 统一执行日志（P0：执行索引层 + 关联键 + 保留清理）。
//!
//! 设计见 migration `036_execution_logs.sql` 顶部注释。本模块只负责**执行索引层**
//! (`management.execution_index`) 的写入与全表保留清理；细节事件层
//! (`management.execution_logs`) 的写入是 P1（tracing DbLogLayer），表已在迁移里建好。
//!
//! ## 关联键 trace_id
//!
//! 复用 HTTP 链路已有的 `x-request-id`（见 `request_id` / `logging::REQUEST_ID`）。
//! 本模块同时被 lib crate 的 `scheduler` 引用，而 `request_id` / `logging` 只在 bin crate
//! 里声明，故本模块**刻意不依赖**它们——只提供 [`new_trace_id`] 生成 UUID。HTTP 路径的
//! 调用方（bin crate 内）自行 `request_id::current().unwrap_or_else(new_trace_id)` 复用
//! 请求 ID；cron / 后台路径直接 [`new_trace_id`]（跨 `tokio::spawn` 后 task_local 本就
//! 读不到请求 ID，新 UUID 才是正确语义）。调用方拿到 trace_id 后：
//!   1. 写进权威 run 表的 `trace_id` 列；
//!   2. [`begin_index`] / [`finish_index`] 写进 `execution_index`；
//!   3.（P1）配合 `request_id::scope_with` 把执行 future 包进同一个 trace_id 的 scope，
//!      让该次执行内所有 `tracing::*` 细节日志自动带上同一 trace_id。
//!
//! ## 容错原则
//!
//! 与现有 `audit_middleware` 一致：执行日志是"抢救业务可观察性"的旁路，写失败只
//! `tracing::warn!`，**绝不阻塞 / 影响主流程**。所有公开函数都吞掉 DB 错误。

use sqlx::{PgPool, Row};
use uuid::Uuid;

/// 生成一个新的 trace_id（UUID v4）。
///
/// 用法：cron / 后台路径直接调用；HTTP 路径用 `request_id::current().unwrap_or_else(new_trace_id)`
/// 以复用请求自带的 `x-request-id`，让索引行与 access log 串到同一条链路。
pub fn new_trace_id() -> String {
    Uuid::new_v4().to_string()
}

/// 写一行 `running` 的执行索引，返回索引行 id（失败返回 `None`，调用方据此跳过后续 finish）。
///
/// - `source`：'api' | 'db' | 'workflow' | 'scheduler' | 'rpc'
/// - `ref_table` / `ref_id`：指回权威 run 表（如 `workflow_runs` / 主键），便于详情页 JOIN。
#[allow(clippy::too_many_arguments)]
pub async fn begin_index(
    pool: &PgPool,
    trace_id: &str,
    source: &str,
    ref_table: Option<&str>,
    ref_id: Option<i64>,
    tenant_id: Option<i32>,
    user_id: Option<i32>,
    name: Option<&str>,
) -> Option<i64> {
    let res = sqlx::query(
        "INSERT INTO management.execution_index \
            (trace_id, source, ref_table, ref_id, tenant_id, user_id, name, status) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'running') RETURNING id",
    )
    .bind(trace_id)
    .bind(source)
    .bind(ref_table)
    .bind(ref_id)
    .bind(tenant_id)
    .bind(user_id)
    .bind(name)
    .fetch_one(pool)
    .await;

    match res {
        Ok(row) => Some(row.get::<i64, _>("id")),
        Err(e) => {
            tracing::warn!(source = %source, "execution_index 起始写入失败: {}", e);
            None
        }
    }
}

/// 收口一行执行索引：写终态 status / 耗时 / 错误摘要。`index_id` 为 `None` 时静默跳过
/// （起始写入失败时调用方传 None，避免无意义的 UPDATE）。
pub async fn finish_index(
    pool: &PgPool,
    index_id: Option<i64>,
    status: &str,
    duration_ms: Option<i64>,
    error_brief: Option<&str>,
) {
    let Some(id) = index_id else {
        return;
    };
    if let Err(e) = sqlx::query(
        "UPDATE management.execution_index \
         SET status = $2, finished_at = NOW(), duration_ms = $3, error_brief = $4 \
         WHERE id = $1",
    )
    .bind(id)
    .bind(status)
    .bind(duration_ms.map(|v| v as i32))
    .bind(error_brief.map(|s| truncate(s, 2000)))
    .execute(pool)
    .await
    {
        tracing::warn!(index_id = id, "execution_index 收口失败: {}", e);
    }
}

/// 一次性写一行终态执行索引（适合 API 这类"完成后才记一行"的场景）。
#[allow(clippy::too_many_arguments)]
pub async fn record_terminal(
    pool: &PgPool,
    trace_id: &str,
    source: &str,
    ref_table: Option<&str>,
    ref_id: Option<i64>,
    tenant_id: Option<i32>,
    user_id: Option<i32>,
    name: Option<&str>,
    status: &str,
    duration_ms: Option<i64>,
    error_brief: Option<&str>,
) {
    if let Err(e) = sqlx::query(
        "INSERT INTO management.execution_index \
            (trace_id, source, ref_table, ref_id, tenant_id, user_id, name, status, \
             finished_at, duration_ms, error_brief) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9, $10)",
    )
    .bind(trace_id)
    .bind(source)
    .bind(ref_table)
    .bind(ref_id)
    .bind(tenant_id)
    .bind(user_id)
    .bind(name)
    .bind(status)
    .bind(duration_ms.map(|v| v as i32))
    .bind(error_brief.map(|s| truncate(s, 2000)))
    .execute(pool)
    .await
    {
        tracing::warn!(source = %source, "execution_index 终态写入失败: {}", e);
    }
}

/// 执行一次保留清理：删除过期的细节日志、执行索引，以及权威 run 表里的历史记录。
/// 返回 (logs_deleted, index_deleted, runs_deleted)。
///
/// 为什么要一并清 `workflow_runs` / `scheduled_task_runs`：这两张是执行详情的**权威来源**
/// （存完整入参 / 出参 / 逐节点结果），执行索引层只存摘要。若只清索引不清 run 表，run 表会
/// **无界增长**——这正是"执行日志页看着 7 天滚动、但库里数据一直涨"的根因。为保证 7 天索引
/// 窗口内点详情仍能回查到 run，`runs_retention_days` 应 ≥ `index_retention_days`。
pub async fn cleanup_once(
    pool: &PgPool,
    logs_retention_hours: i64,
    index_retention_days: i64,
    runs_retention_days: i64,
) -> (u64, u64, u64) {
    let logs_deleted = match sqlx::query(
        "DELETE FROM management.execution_logs \
         WHERE ts < NOW() - ($1 || ' hours')::interval",
    )
    .bind(logs_retention_hours.to_string())
    .execute(pool)
    .await
    {
        Ok(r) => r.rows_affected(),
        Err(e) => {
            tracing::warn!("execution_logs 清理失败: {}", e);
            0
        }
    };

    let index_deleted = match sqlx::query(
        "DELETE FROM management.execution_index \
         WHERE started_at < NOW() - ($1 || ' days')::interval",
    )
    .bind(index_retention_days.to_string())
    .execute(pool)
    .await
    {
        Ok(r) => r.rows_affected(),
        Err(e) => {
            tracing::warn!("execution_index 清理失败: {}", e);
            0
        }
    };

    // 权威 run 表：按 started_at 滚动删除。两表同一保留窗口，逐表容错（某张失败不影响另一张）。
    let mut runs_deleted = 0u64;
    for table in ["workflow_runs", "scheduled_task_runs"] {
        let sql = format!(
            "DELETE FROM management.{table} \
             WHERE started_at < NOW() - ($1 || ' days')::interval"
        );
        match sqlx::query(&sql)
            .bind(runs_retention_days.to_string())
            .execute(pool)
            .await
        {
            Ok(r) => runs_deleted += r.rows_affected(),
            Err(e) => tracing::warn!("{} 清理失败: {}", table, e),
        }
    }

    (logs_deleted, index_deleted, runs_deleted)
}

/// 后台保留清理任务：常驻 tokio task，按固定间隔跑 [`cleanup_once`]。
///
/// 配置（环境变量，缺省即合理默认）：
///   - `EXEC_LOG_RETENTION_HOURS`：细节日志保留小时数，默认 24（即"保留一天"）。
///   - `EXEC_INDEX_RETENTION_DAYS`：执行索引保留天数，默认 7。
///   - `EXEC_RUNS_RETENTION_DAYS`：权威 run 表（workflow_runs / scheduled_task_runs）保留天数，
///     默认 7；会被强制抬到 ≥ 索引保留天数，避免索引窗口内点详情回查不到 run。
///   - `EXEC_LOG_CLEANUP_INTERVAL_SECS`：清理间隔秒数，默认 3600（每小时）。
///
/// 与现有 watchdog 同款的"进程内常驻 task"模式，零外部依赖。多实例同时跑清理是幂等的
/// （DELETE 互不冲突），不需要额外加锁。
pub fn spawn_cleanup_task(pool: PgPool) {
    let logs_hours = env_i64("EXEC_LOG_RETENTION_HOURS", 24).max(1);
    let index_days = env_i64("EXEC_INDEX_RETENTION_DAYS", 7).max(1);
    // run 表保留必须 ≥ 索引保留：否则索引行还在（≤7d）、run 已被删，详情页回查不到入参/出参。
    let runs_days = env_i64("EXEC_RUNS_RETENTION_DAYS", 7).max(index_days);
    let interval_secs = env_i64("EXEC_LOG_CLEANUP_INTERVAL_SECS", 3600).max(60) as u64;

    tokio::spawn(async move {
        tracing::info!(
            logs_retention_hours = logs_hours,
            index_retention_days = index_days,
            runs_retention_days = runs_days,
            interval_secs = interval_secs,
            "执行日志清理任务已启动"
        );
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(interval_secs));
        // 首个 tick 立即触发——进程刚起就先清一次历史积压。
        loop {
            ticker.tick().await;
            let (logs, idx, runs) = cleanup_once(&pool, logs_hours, index_days, runs_days).await;
            if logs > 0 || idx > 0 || runs > 0 {
                tracing::info!(
                    logs_deleted = logs,
                    index_deleted = idx,
                    runs_deleted = runs,
                    "执行日志清理完成"
                );
            }
        }
    });
}

fn env_i64(key: &str, default: i64) -> i64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(default)
}

/// 安全截断字符串到 `max` 字节（按 char 边界），避免超长错误文本撑爆列。
fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_trace_id_is_valid_uuid() {
        let id = new_trace_id();
        assert!(!id.is_empty());
        assert!(Uuid::parse_str(&id).is_ok(), "应是合法 UUID，实际: {}", id);
    }

    #[test]
    fn truncate_keeps_short_string() {
        assert_eq!(truncate("hello", 100), "hello");
    }

    #[test]
    fn truncate_respects_char_boundary() {
        let s = "中文字符串测试";
        let out = truncate(s, 5); // 5 字节落在某个多字节 char 中间
        assert!(s.starts_with(&out));
        assert!(out.len() <= 5);
    }
}
