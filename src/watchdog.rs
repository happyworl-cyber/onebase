use sqlx::{PgPool, Row};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::pool_manager::POOL_MANAGER;
use crate::redis_manager::RedisManager;

/// 后台守护进程：定时探活 DB 和 Redis，监控连接池健康
pub struct Watchdog {
    pool: PgPool,
    redis: Option<RedisManager>,
    running: Arc<AtomicBool>,
}

impl Watchdog {
    pub fn new(pool: PgPool, redis: Option<RedisManager>) -> Self {
        Self {
            pool,
            redis,
            running: Arc::new(AtomicBool::new(true)),
        }
    }

    pub fn shutdown_handle(&self) -> Arc<AtomicBool> {
        self.running.clone()
    }

    pub fn start(self) -> tokio::task::JoinHandle<()> {
        let running = self.running.clone();

        tokio::spawn(async move {
            tracing::info!("Watchdog 已启动（每 10s 探活）");
            let mut consecutive_db_failures = 0u32;
            let mut consecutive_redis_failures = 0u32;

            while running.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_secs(10)).await;
                if !running.load(Ordering::Relaxed) {
                    break;
                }

                // 探活管理库
                match sqlx::query("SELECT 1").execute(&self.pool).await {
                    Ok(_) => {
                        if consecutive_db_failures > 0 {
                            tracing::info!(
                                "管理库连接恢复正常（之前连续失败 {} 次）",
                                consecutive_db_failures
                            );
                        }
                        consecutive_db_failures = 0;
                    }
                    Err(e) => {
                        consecutive_db_failures += 1;
                        if consecutive_db_failures >= 3 {
                            tracing::error!(
                                "管理库连续探活失败 {} 次: {}",
                                consecutive_db_failures,
                                e
                            );
                        } else {
                            tracing::warn!("管理库探活失败: {}", e);
                        }
                    }
                }

                // 探活 Redis
                if let Some(ref redis) = self.redis {
                    match redis.ping().await {
                        Ok(true) => {
                            if consecutive_redis_failures > 0 {
                                tracing::info!("Redis 连接恢复正常");
                            }
                            consecutive_redis_failures = 0;
                        }
                        _ => {
                            consecutive_redis_failures += 1;
                            if consecutive_redis_failures >= 3 {
                                tracing::error!(
                                    "Redis 连续探活失败 {} 次",
                                    consecutive_redis_failures
                                );
                            } else {
                                tracing::warn!("Redis 探活失败");
                            }
                        }
                    }
                }

                // 连接池指标
                let pool_size = self.pool.size();
                let idle = self.pool.num_idle();
                if idle == 0 && pool_size > 0 {
                    tracing::warn!(
                        "连接池压力告警：总连接 {}，空闲 0，所有连接均在使用中",
                        pool_size
                    );
                }
            }

            tracing::info!("Watchdog 已停止");
        })
    }
}

/// 副本健康看护配置
#[derive(Clone, Copy, Debug)]
pub struct ReplicaWatchdogConfig {
    /// 探活间隔
    pub interval: Duration,
    /// 单次探活的超时（含连接 + 查询）
    pub probe_timeout: Duration,
    /// 判定为 unhealthy 之前允许的连续失败次数（达到即旁路）
    pub max_consecutive_failures: u32,
    /// 复制延迟阈值（秒），超过即视为本次失败；None = 不检查延迟
    pub lag_threshold_seconds: Option<f64>,
    /// 主库 (in_recovery=false) 是否视为失败（防误挂只读副本指向主库）
    pub require_standby: bool,
}

impl Default for ReplicaWatchdogConfig {
    fn default() -> Self {
        Self {
            interval: Duration::from_secs(15),
            probe_timeout: Duration::from_secs(3),
            max_consecutive_failures: 2,
            lag_threshold_seconds: Some(60.0),
            require_standby: true,
        }
    }
}

/// 单次探活的判定结果
enum ProbeOutcome {
    Healthy,
    /// 拿到结果但语义不健康（非 standby / 超过延迟阈值）
    Degraded(&'static str, Option<f64>),
    /// 拿不到结果（超时 / 连接断 / SQL 出错）
    Unreachable(String),
}

async fn probe_via_pool(pool: &PgPool, cfg: &ReplicaWatchdogConfig) -> ProbeOutcome {
    let q = sqlx::query(
        "SELECT pg_is_in_recovery() AS in_recovery, \
                EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::float8 AS lag",
    )
    .fetch_one(pool);

    match tokio::time::timeout(cfg.probe_timeout, q).await {
        Err(_) => ProbeOutcome::Unreachable("timeout".into()),
        Ok(Err(e)) => ProbeOutcome::Unreachable(e.to_string()),
        Ok(Ok(row)) => {
            let in_recovery: bool = row.try_get("in_recovery").unwrap_or(false);
            let lag: Option<f64> = row.try_get("lag").unwrap_or(None);

            if cfg.require_standby && !in_recovery {
                return ProbeOutcome::Degraded("not_standby", lag);
            }
            if let (Some(threshold), Some(l)) = (cfg.lag_threshold_seconds, lag) {
                if l > threshold {
                    return ProbeOutcome::Degraded("lag_exceeded", Some(l));
                }
            }
            ProbeOutcome::Healthy
        }
    }
}

/// 启动副本健康看护任务（运行时自动旁路 + 自动恢复）。
///
/// 工作流程：
/// 1. 每 `interval` 秒从 `POOL_MANAGER` 快照当前已加载的所有副本
/// 2. 并发对每个副本做 `SELECT pg_is_in_recovery(), ...` 探活
/// 3. 失败计数累计到 `max_consecutive_failures` 即把副本旁路（不接收读流量）
/// 4. 任一次健康探活成功就清零计数并取消旁路
///
/// 注意：旁路 **不** 写库 —— 它是运行时旁路，重启 / 手动 reload 会自动复原。
pub fn spawn_replica_watchdog(cfg: ReplicaWatchdogConfig) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        tracing::info!(
            "副本看护任务已启动: interval={:?} probe_timeout={:?} max_fail={} lag_threshold={:?}s standby={}",
            cfg.interval,
            cfg.probe_timeout,
            cfg.max_consecutive_failures,
            cfg.lag_threshold_seconds,
            cfg.require_standby,
        );

        // (primary_id, replica_id) -> 连续失败次数
        let mut failures: HashMap<(i32, i32), u32> = HashMap::new();
        let mut ticker = tokio::time::interval(cfg.interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            ticker.tick().await;

            let targets = POOL_MANAGER.snapshot_replica_targets();
            if targets.is_empty() {
                continue;
            }

            let mut joinset = tokio::task::JoinSet::new();
            for (primary_id, replica_id, pool) in targets {
                let cfg_clone = cfg;
                joinset.spawn(async move {
                    let outcome = probe_via_pool(&pool, &cfg_clone).await;
                    (primary_id, replica_id, outcome)
                });
            }

            // 收集本轮探活仍然“存在”的目标，便于清理已下线的副本计数
            let mut seen: Vec<(i32, i32)> = Vec::new();

            while let Some(joined) = joinset.join_next().await {
                let Ok((primary_id, replica_id, outcome)) = joined else {
                    continue;
                };
                seen.push((primary_id, replica_id));
                let key = (primary_id, replica_id);

                match outcome {
                    ProbeOutcome::Healthy => {
                        failures.remove(&key);
                        if let Some(true) =
                            POOL_MANAGER.set_replica_bypass(primary_id, replica_id, false)
                        {
                            tracing::info!(
                                "副本恢复健康，已重新上线: primary={} replica={}",
                                primary_id,
                                replica_id
                            );
                        }
                    }
                    ProbeOutcome::Degraded(reason, lag) => {
                        let n = failures.entry(key).or_insert(0);
                        *n += 1;
                        tracing::warn!(
                            "副本异常（{}）lag={:?} 连续 {}/{} 次: primary={} replica={}",
                            reason,
                            lag,
                            n,
                            cfg.max_consecutive_failures,
                            primary_id,
                            replica_id
                        );
                        if *n >= cfg.max_consecutive_failures {
                            if let Some(true) =
                                POOL_MANAGER.set_replica_bypass(primary_id, replica_id, true)
                            {
                                tracing::error!(
                                    "副本已被运行时旁路（{}）: primary={} replica={}",
                                    reason,
                                    primary_id,
                                    replica_id
                                );
                            }
                        }
                    }
                    ProbeOutcome::Unreachable(err) => {
                        let n = failures.entry(key).or_insert(0);
                        *n += 1;
                        tracing::warn!(
                            "副本探活失败 {}/{} 次: primary={} replica={} err={}",
                            n,
                            cfg.max_consecutive_failures,
                            primary_id,
                            replica_id,
                            err
                        );
                        if *n >= cfg.max_consecutive_failures {
                            if let Some(true) =
                                POOL_MANAGER.set_replica_bypass(primary_id, replica_id, true)
                            {
                                tracing::error!(
                                    "副本已被运行时旁路（unreachable）: primary={} replica={} err={}",
                                    primary_id,
                                    replica_id,
                                    err
                                );
                            }
                        }
                    }
                }
            }

            // 清理掉本轮未出现的目标（已经从 PoolManager 里被删除 / 禁用 / 卸载）
            if !seen.is_empty() {
                failures.retain(|k, _| seen.contains(k));
            } else {
                failures.clear();
            }
        }
    })
}
