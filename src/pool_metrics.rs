//! 连接池 `acquire` 超时的进程内计数 —— 只服务于监控页诊断。
//!
//! 事故背景：租户池被打满时日志里刷满
//! `pool timed out while waiting for an open connection`，但监控页上完全看不到
//! 这个信号（页面只有 PG 服务端指标）。排障只能靠翻日志。本模块把该信号搬到
//! 内存里，供 `/api/monitor/pool-health` 直接回显。
//!
//! 刻意的取舍：
//! - **进程内、重启清零**，定位与 `sse_notify_bridge::BridgeMetrics` 一致；需要跨重启
//!   的长期曲线应上 Prometheus，不是这里的职责。
//! - **近似计数**。同一次超时可能被计两次（工作流节点级 `acquire_traced` 记一次，
//!   错误冒泡到 HTTP 层 `error.rs` 再记一次）。该指标回答「有没有 / 什么时候 /
//!   大概多严重」，不做精确 SLO 计算，UI 与接口文档均标注「近似」。
//! - **不记录 SQL 文本**，只记 `source` 标签（节点类型 / `http`）+ 时间戳 +
//!   database_id，避免监控接口成为业务数据泄露面。
//!
//! lib-safe：只依赖 sqlx / chrono / serde / dashmap / once_cell，可同时编进
//! lib crate 与 bin crate（`workflow_engine` 在两侧都会用到）。

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use dashmap::DashMap;
use once_cell::sync::Lazy;
use serde::Serialize;
use sqlx::pool::PoolConnection;
use sqlx::{PgPool, Postgres};

/// 最近事件环形缓冲容量。够看清「是刚开始还是持续了一阵」，又不至于占内存。
const RECENT_CAPACITY: usize = 20;

static TOTAL: AtomicU64 = AtomicU64::new(0);
static BY_DATABASE: Lazy<DashMap<i32, u64>> = Lazy::new(DashMap::new);
static RECENT: Lazy<Mutex<VecDeque<PoolTimeoutEvent>>> =
    Lazy::new(|| Mutex::new(VecDeque::with_capacity(RECENT_CAPACITY)));

/// 一次 acquire 超时。`source` 是埋点位置标签，不含 SQL。
#[derive(Debug, Clone, Serialize)]
pub struct PoolTimeoutEvent {
    pub at: DateTime<Utc>,
    /// 归因到的池 key（租户库 id 或 datasource pool key）；HTTP 兜底埋点为 `None`。
    pub database_id: Option<i32>,
    pub source: String,
}

/// 计数快照（供监控 API 序列化）。
#[derive(Debug, Clone, Default, Serialize)]
pub struct PoolTimeoutSnapshot {
    /// 进程启动以来的近似总次数。
    pub total: u64,
    /// 按池 key 归因的次数；HTTP 兜底埋点不计入任何 key。
    pub by_database: HashMap<i32, u64>,
    pub last_at: Option<DateTime<Utc>>,
    /// 最近 `RECENT_CAPACITY` 条，新的在前。
    pub recent: Vec<PoolTimeoutEvent>,
}

impl PoolTimeoutSnapshot {
    /// 某个池归因到的次数（没有记录则 0）。
    pub fn for_database(&self, database_id: i32) -> u64 {
        self.by_database.get(&database_id).copied().unwrap_or(0)
    }
}

/// 记录一次 acquire 超时。
///
/// 全程无 `.await`：`RECENT` 用 `std::sync::Mutex`，临界区只做一次 push/pop。
/// 锁被毒化（持锁线程 panic）时走 `into_inner` 继续用——监控计数不值得让调用方失败。
pub fn record_timeout(database_id: Option<i32>, source: &str) {
    TOTAL.fetch_add(1, Ordering::Relaxed);
    if let Some(id) = database_id {
        *BY_DATABASE.entry(id).or_insert(0) += 1;
    }

    let event = PoolTimeoutEvent {
        at: Utc::now(),
        database_id,
        source: source.to_string(),
    };
    let mut recent = match RECENT.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if recent.len() == RECENT_CAPACITY {
        recent.pop_back();
    }
    recent.push_front(event);
}

pub fn snapshot() -> PoolTimeoutSnapshot {
    let recent: Vec<PoolTimeoutEvent> = match RECENT.lock() {
        Ok(g) => g.iter().cloned().collect(),
        Err(poisoned) => poisoned.into_inner().iter().cloned().collect(),
    };
    PoolTimeoutSnapshot {
        total: TOTAL.load(Ordering::Relaxed),
        by_database: BY_DATABASE.iter().map(|e| (*e.key(), *e.value())).collect(),
        last_at: recent.first().map(|e| e.at),
        recent,
    }
}

/// `pool.acquire()` 的薄包装：仅在 `PoolTimedOut` 时计数，其它错误原样透出。
///
/// 用在工作流 Postgres 节点上——那里的 acquire 失败会被记进节点错误，未必冒泡到
/// HTTP 层，光靠 `error.rs` 的兜底埋点会漏掉。
pub async fn acquire_traced(
    pool: &PgPool,
    database_id: Option<i32>,
    source: &str,
) -> Result<PoolConnection<Postgres>, sqlx::Error> {
    match pool.acquire().await {
        Ok(conn) => Ok(conn),
        Err(e) => {
            if matches!(e, sqlx::Error::PoolTimedOut) {
                record_timeout(database_id, source);
            }
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这些计数器是进程级 static，测试之间会互相看见对方的写入。所以断言一律写成
    /// 「相对基线的增量」，并且用各测试独占的 database_id / source，避免顺序依赖。
    fn baseline() -> u64 {
        snapshot().total
    }

    #[test]
    fn record_timeout_increments_total_and_attributes_database() {
        let before = baseline();
        record_timeout(Some(-1001), "unit_a");
        record_timeout(Some(-1001), "unit_a");
        record_timeout(None, "unit_a");

        let snap = snapshot();
        // TOTAL 是进程级 static，其它测试（含 error::pool_timeout_maps_to_503）会并行写入，
        // 所以只断言「至少增加了本测试写入的 3 次」，精确归因看独占的 database_id。
        assert!(snap.total >= before + 3);
        assert_eq!(snap.for_database(-1001), 2);
        // None 归因不进 by_database；-9999 未被本测试使用
        assert_eq!(snap.for_database(-9999), 0);
        assert!(snap.last_at.is_some());
    }

    #[test]
    fn recent_is_capped_and_newest_first() {
        for i in 0..(RECENT_CAPACITY + 5) {
            record_timeout(Some(-2000 - i as i32), "unit_b");
        }
        let snap = snapshot();
        assert_eq!(snap.recent.len(), RECENT_CAPACITY);
        // 最后写入的那条排在最前
        let newest = &snap.recent[0];
        assert_eq!(
            newest.database_id,
            Some(-2000 - (RECENT_CAPACITY + 4) as i32)
        );
        // 时间单调不减（新的在前）
        for pair in snap.recent.windows(2) {
            assert!(pair[0].at >= pair[1].at);
        }
    }

    #[test]
    fn snapshot_for_unknown_database_is_zero() {
        assert_eq!(snapshot().for_database(i32::MIN), 0);
    }
}
