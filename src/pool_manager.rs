use dashmap::DashMap;
use once_cell::sync::Lazy;
use sqlx::postgres::{PgConnectOptions, PgListener, PgPool, PgPoolOptions};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio::sync::Mutex;

use crate::error::{AppError, Result};

pub static POOL_MANAGER: Lazy<PoolManager> = Lazy::new(PoolManager::new);

/// 新建 / NULL 回退时的租户库 `max_connections` 默认值。
pub const DEFAULT_TENANT_MAX_CONNECTIONS: u32 = 20;

/// 与 tenant API / 连接预算校验一致的单库上限。
pub const TENANT_MAX_CONNECTIONS_CAP: u32 = 50;

/// 数据库连接配置
#[derive(Debug, Clone)]
pub struct DatabaseConfig {
    pub id: i32,
    pub host: String,
    pub port: i32,
    pub database: String,
    pub username: String,
    pub password: String,
    pub max_connections: u32,
    pub connection_timeout: u64,
}

impl DatabaseConfig {
    #[allow(dead_code)]
    pub fn connection_url(&self) -> String {
        format!(
            "postgresql://{}:{}@{}:{}/{}",
            self.username, self.password, self.host, self.port, self.database
        )
    }

    /// 字段构造连接选项（避免密码特殊字符破坏 URL）。
    pub fn connect_options(&self) -> PgConnectOptions {
        PgConnectOptions::new()
            .host(&self.host)
            .port(self.port as u16)
            .database(&self.database)
            .username(&self.username)
            .password(&self.password)
            .statement_cache_capacity(0)
    }
}

/// 解析建池用的有效 `max_connections`。
///
/// - `TENANT_DB_MAX_CONNECTIONS` 合法（1..=50）时**完全覆盖** `db_value`
/// - 非法 env：warn 后回退 `db_value`
/// - 最终 clamp 到 `1..=TENANT_MAX_CONNECTIONS_CAP`
pub fn effective_max_connections(db_value: u32) -> u32 {
    effective_max_connections_from(db_value, std::env::var("TENANT_DB_MAX_CONNECTIONS").ok())
}

/// 可注入 env，便于单测。
pub fn effective_max_connections_from(db_value: u32, env: Option<String>) -> u32 {
    let fallback = db_value.clamp(1, TENANT_MAX_CONNECTIONS_CAP);
    match env {
        None => fallback,
        Some(raw) => match raw.trim().parse::<u32>() {
            Ok(v) if (1..=TENANT_MAX_CONNECTIONS_CAP).contains(&v) => v,
            Ok(v) => {
                tracing::warn!(
                    "TENANT_DB_MAX_CONNECTIONS={} 超出 1..={}，回退 db 值 {}",
                    v,
                    TENANT_MAX_CONNECTIONS_CAP,
                    fallback
                );
                fallback
            }
            Err(_) => {
                tracing::warn!(
                    "TENANT_DB_MAX_CONNECTIONS={:?} 无效，回退 db 值 {}",
                    raw,
                    fallback
                );
                fallback
            }
        },
    }
}

/// 为 NOTIFY / SSE LISTEN 建立**独立**单连接池 + listener，不占用业务 `POOL_MANAGER` 槽位。
///
/// 返回的 `PgPool` 必须与 `PgListener` 同寿命持有（sqlx `connect_with` 从该池 checkout）。
pub async fn connect_dedicated_listener(config: &DatabaseConfig) -> Result<(PgPool, PgListener)> {
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect_with(config.connect_options())
        .await
        .map_err(|e| {
            tracing::error!(
                "LISTEN 独立连接池创建失败 id={}: {}",
                config.id,
                e
            );
            AppError::Internal(format!("连接数据库失败: {}", e))
        })?;

    let listener = PgListener::connect_with(&pool).await.map_err(|e| {
        tracing::error!("PgListener 建立失败 id={}: {}", config.id, e);
        AppError::Internal(format!("连接数据库失败: {}", e))
    })?;

    Ok((pool, listener))
}

/// 单个 sqlx 池的实时水位。
///
/// 全部取自 `PgPool` 自身的计数器（`Arc` 内的原子量），零 DB 开销 —— 这一层正是
/// 监控页此前完全缺失的：PG 服务端显示 126/1600 很健康时，业务请求排队等的其实是
/// 这里的 `max`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct PoolWaterMark {
    pub max: u32,
    pub min: u32,
    /// 池中已建立的连接总数（含被借出的）。
    pub size: u32,
    /// 当前空闲可立即借出的连接数。
    pub idle: u32,
    /// 正被业务持有的连接数。
    pub in_use: u32,
    pub acquire_timeout_secs: u64,
}

impl PoolWaterMark {
    /// 占用率百分比（0..=100）。`max` 为 0 时返回 0，避免除零。
    pub fn usage_percent(&self) -> u32 {
        if self.max == 0 {
            return 0;
        }
        ((self.in_use as u64 * 100) / self.max as u64).min(100) as u32
    }

    /// 池是否已无空闲且借满 —— 后续 acquire 必然排队直到 `acquire_timeout`。
    pub fn is_saturated(&self) -> bool {
        self.max > 0 && self.idle == 0 && self.in_use >= self.max
    }
}

/// 读取单个池的水位。
///
/// `num_idle()` 返回 `usize` 且与 `size()` 是分别读取的原子量，并发下可能出现
/// `idle > size` 的瞬时不一致，故 `in_use` 用 `saturating_sub` 兜底。
pub fn watermark(pool: &PgPool) -> PoolWaterMark {
    let opts = pool.options();
    let size = pool.size();
    let idle = pool.num_idle().min(u32::MAX as usize) as u32;
    PoolWaterMark {
        max: opts.get_max_connections(),
        min: opts.get_min_connections(),
        size,
        idle,
        in_use: size.saturating_sub(idle),
        acquire_timeout_secs: opts.get_acquire_timeout().as_secs(),
    }
}

/// 副本池水位 + 它当前是否被看护任务旁路。
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct ReplicaWaterMark {
    pub replica_id: i32,
    pub bypassed: bool,
    pub watermark: PoolWaterMark,
}

/// 单个 replica 的运行时表示（带 id / 权重 / 池 / 旁路标记）
#[derive(Clone)]
struct ReplicaEntry {
    /// 对应 management.tenant_databases.id —— 用于增量增删时定位
    id: i32,
    pool: PgPool,
    /// >= 1；用于加权轮询
    weight: i32,
    /// 运行时旁路：true 表示看护任务判定该副本不健康，**临时**不接收读流量；
    /// 与 `is_active = false` 的区别：bypass 不写库，恢复健康会自动取消。
    bypassed: bool,
}

/// 一组连接池：primary + 零或多个 replica（加权轮询）
struct PoolGroup {
    primary: PgPool,
    replicas: Vec<ReplicaEntry>,
    /// 按权重展开后的索引表：weights = [2, 1, 3] -> picks = [0,0,1,2,2,2]
    weighted_picks: Vec<usize>,
    rr_counter: AtomicUsize,
}

impl PoolGroup {
    fn new(primary: PgPool) -> Self {
        Self {
            primary,
            replicas: Vec::new(),
            weighted_picks: Vec::new(),
            rr_counter: AtomicUsize::new(0),
        }
    }

    /// 重新计算加权 pick 列表 —— 在 replicas 任意变动后调用
    ///
    /// **会跳过 bypassed 的副本** —— 看护任务可以通过翻转 bypass 来
    /// 临时把不健康的副本从读路由里摘掉，不需要改动 weights / replicas 本身。
    fn rebuild_picks(&mut self) {
        let mut picks = Vec::new();
        for (i, r) in self.replicas.iter().enumerate() {
            if r.bypassed {
                continue;
            }
            let w = r.weight.max(1) as usize;
            for _ in 0..w {
                picks.push(i);
            }
        }
        self.weighted_picks = picks;
        self.rr_counter.store(0, Ordering::Relaxed);
    }

    /// 写池始终是 primary
    fn write_pool(&self) -> PgPool {
        self.primary.clone()
    }

    /// 读池：无 replica 时回退 primary；有 replica 时按加权轮询取
    fn read_pool(&self) -> PgPool {
        if self.weighted_picks.is_empty() {
            return self.primary.clone();
        }
        let idx = self.rr_counter.fetch_add(1, Ordering::Relaxed) % self.weighted_picks.len();
        self.replicas[self.weighted_picks[idx]].pool.clone()
    }
}

/// 连接池管理器（支持读写分离 + 加权轮询 + 增量增删副本）
pub struct PoolManager {
    pools: DashMap<i32, PgPool>,
    groups: DashMap<i32, PoolGroup>,
    create_lock: Mutex<()>,
}

impl PoolManager {
    pub fn new() -> Self {
        Self {
            pools: DashMap::new(),
            groups: DashMap::new(),
            create_lock: Mutex::new(()),
        }
    }

    /// 获取或创建主连接池
    ///
    /// 关键约束：**绝不能在持有 DashMap 分片 guard 的同时 `.await`**，也绝不能在
    /// 同一分片 `Ref` 还存活时调用 `remove/insert`（写锁）——否则会与自己持有的读锁
    /// 死锁，进而卡住整个 executor。历史上这里用 `pool.acquire().await` 探活、失败再
    /// `pools.remove()`，正好踩中这两条，业务库一抖动就把全局 `create_lock` 永久占死。
    ///
    /// 现在：命中缓存就立刻 `clone` 出 `PgPool`（Arc，廉价）并在同一语句里释放 guard，
    /// 不做 acquire 探活——sqlx 连接池本身会自愈（死连接丢弃、按需重连）；连接真不可用
    /// 时由具体查询返回普通错误，再由上层超时兜底，不会再卡死调度。
    pub async fn get_or_create_pool(&self, config: DatabaseConfig) -> Result<PgPool> {
        // 快路径：克隆出池后 guard 立即随临时量析构，不跨 await。
        if let Some(pool) = self.pools.get(&config.id).map(|p| p.clone()) {
            return Ok(pool);
        }

        let _guard = self.create_lock.lock().await;

        // 拿到 create_lock 后复检：可能已被并发创建。同样只 clone、不持 guard。
        if let Some(pool) = self.pools.get(&config.id).map(|p| p.clone()) {
            return Ok(pool);
        }

        let pool = Self::create_pool(&config).await?;
        self.pools.insert(config.id, pool.clone());

        if !self.groups.contains_key(&config.id) {
            self.groups.insert(config.id, PoolGroup::new(pool.clone()));
        }

        Ok(pool)
    }

    /// 兼容旧调用：默认权重 = 1，replica_id 用 config.id（与 tenant_databases.id 一致）
    #[allow(dead_code)]
    pub async fn add_replica(&self, primary_db_id: i32, config: DatabaseConfig) -> Result<()> {
        let replica_id = config.id;
        self.upsert_replica(primary_db_id, replica_id, 1, config)
            .await
    }

    /// 增量挂载（或替换）单个副本到既有 primary group —— 不破坏其他副本/primary
    ///
    /// 行为：
    /// - 如果 primary 池尚未注册：仅记录 warning，**不**自动创建（避免出现孤儿 group）
    /// - 如果该 replica_id 已存在：先关闭旧池，再用新配置替换
    /// - 任意变动后重建 weighted picks
    pub async fn upsert_replica(
        &self,
        primary_db_id: i32,
        replica_id: i32,
        weight: i32,
        config: DatabaseConfig,
    ) -> Result<()> {
        let pool = Self::create_pool(&config).await?;

        if let Some(mut group) = self.groups.get_mut(&primary_db_id) {
            // 同 id 已存在：先取出旧池，稍后异步关闭
            let old_pool: Option<PgPool> =
                if let Some(idx) = group.replicas.iter().position(|r| r.id == replica_id) {
                    let entry = group.replicas.remove(idx);
                    Some(entry.pool)
                } else {
                    None
                };

            group.replicas.push(ReplicaEntry {
                id: replica_id,
                pool,
                weight: weight.max(1),
                bypassed: false,
            });
            group.rebuild_picks();

            tracing::info!(
                "primary_db_id={} 副本 {} 已挂载（权重={}，当前副本数={}）",
                primary_db_id,
                replica_id,
                weight,
                group.replicas.len()
            );

            // 关 group 锁后再异步释放旧池，避免长时间持锁
            drop(group);
            if let Some(p) = old_pool {
                tokio::spawn(async move { p.close().await });
            }
        } else {
            tracing::warn!(
                "Primary {} 尚未注册池，副本 {} 暂未挂载；下一次访问 primary 时会被 ensure_pool_loaded 自动加载",
                primary_db_id,
                replica_id
            );
            // 关掉刚创建的副本池，避免泄露
            tokio::spawn(async move { pool.close().await });
        }

        Ok(())
    }

    /// 从 group 移除单个副本（不影响 primary 与其他副本）
    pub async fn remove_replica(&self, primary_db_id: i32, replica_id: i32) {
        let mut taken: Option<PgPool> = None;
        if let Some(mut group) = self.groups.get_mut(&primary_db_id) {
            if let Some(idx) = group.replicas.iter().position(|r| r.id == replica_id) {
                let entry = group.replicas.remove(idx);
                group.rebuild_picks();
                taken = Some(entry.pool);
                tracing::info!(
                    "primary_db_id={} 副本 {} 已下线（剩余副本数={}）",
                    primary_db_id,
                    replica_id,
                    group.replicas.len()
                );
            }
        }
        if let Some(pool) = taken {
            tokio::spawn(async move { pool.close().await });
        }
    }

    /// 查询某副本是否已在内存中（用于 handler 判定是否需要 upsert vs no-op）
    #[allow(dead_code)]
    pub fn has_replica(&self, primary_db_id: i32, replica_id: i32) -> bool {
        self.groups
            .get(&primary_db_id)
            .map(|g| g.replicas.iter().any(|r| r.id == replica_id))
            .unwrap_or(false)
    }

    /// 获取写池
    pub fn get_write_pool(&self, db_id: i32) -> Option<PgPool> {
        self.groups.get(&db_id).map(|g| g.write_pool())
    }

    /// 获取读池（有 replica 时加权轮询，否则 fallback 到 primary）
    pub fn get_read_pool(&self, db_id: i32) -> Option<PgPool> {
        self.groups.get(&db_id).map(|g| g.read_pool())
    }

    /// 获取 replica 数量
    #[allow(dead_code)]
    pub fn replica_count(&self, db_id: i32) -> usize {
        self.groups
            .get(&db_id)
            .map(|g| g.replicas.len())
            .unwrap_or(0)
    }

    /// 查询某副本当前是否被运行时看护旁路
    pub fn is_replica_bypassed(&self, primary_db_id: i32, replica_id: i32) -> bool {
        self.groups
            .get(&primary_db_id)
            .and_then(|g| {
                g.replicas
                    .iter()
                    .find(|r| r.id == replica_id)
                    .map(|r| r.bypassed)
            })
            .unwrap_or(false)
    }

    /// 翻转副本的 bypass 状态。
    ///
    /// 返回 `Some(true)` 表示发生了状态变化（需要调用方记日志 / 触发事件），
    /// 返回 `Some(false)` 表示状态未变，`None` 表示找不到该副本。
    pub fn set_replica_bypass(
        &self,
        primary_db_id: i32,
        replica_id: i32,
        bypass: bool,
    ) -> Option<bool> {
        let mut group = self.groups.get_mut(&primary_db_id)?;
        let entry = group.replicas.iter_mut().find(|r| r.id == replica_id)?;
        if entry.bypassed == bypass {
            return Some(false);
        }
        entry.bypassed = bypass;
        group.rebuild_picks();
        Some(true)
    }

    /// 主池实时水位；池尚未加载（该库还没被访问过）时返回 `None`。
    pub fn primary_watermark(&self, db_id: i32) -> Option<PoolWaterMark> {
        self.groups.get(&db_id).map(|g| watermark(&g.primary))
    }

    /// 该库所有副本池的实时水位。
    pub fn replica_watermarks(&self, db_id: i32) -> Vec<ReplicaWaterMark> {
        self.groups
            .get(&db_id)
            .map(|g| {
                g.replicas
                    .iter()
                    .map(|r| ReplicaWaterMark {
                        replica_id: r.id,
                        bypassed: r.bypassed,
                        watermark: watermark(&r.pool),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 快照当前所有已加载的副本（primary_id, replica_id, pool）
    ///
    /// 看护任务用：克隆出来的 `PgPool` 是 Arc，对 group 无锁，可以并发探活。
    pub fn snapshot_replica_targets(&self) -> Vec<(i32, i32, PgPool)> {
        let mut out = Vec::new();
        for entry in self.groups.iter() {
            let primary_id = *entry.key();
            for r in &entry.value().replicas {
                out.push((primary_id, r.id, r.pool.clone()));
            }
        }
        out
    }

    pub async fn remove_pool(&self, database_id: i32) {
        if let Some((_, pool)) = self.pools.remove(&database_id) {
            pool.close().await;
        }
        // 关掉 group 里所有副本池
        let replica_pools: Vec<PgPool> = if let Some((_, group)) = self.groups.remove(&database_id)
        {
            group.replicas.into_iter().map(|r| r.pool).collect()
        } else {
            vec![]
        };
        for p in replica_pools {
            tokio::spawn(async move { p.close().await });
        }
    }

    pub fn active_pools_count(&self) -> usize {
        self.pools.len()
    }

    #[allow(dead_code)]
    pub async fn clear_all(&self) {
        let ids: Vec<i32> = self.pools.iter().map(|entry| *entry.key()).collect();
        for id in ids {
            self.remove_pool(id).await;
        }
    }

    async fn create_pool(config: &DatabaseConfig) -> Result<PgPool> {
        tracing::info!(
            "创建连接池: id={}, host={}:{}, db={}",
            config.id,
            config.host,
            config.port,
            config.database
        );

        // 关闭预处理语句缓存（statement_cache_capacity=0）。
        //
        // 租户库的表结构是**运行时可变的**（我们开放了 DDL / Raw SQL 接口，用户可随时
        // ALTER/加列/删列/改类型/DROP 重建）。sqlx 默认会 prepare 每条 SQL 并按物理连接
        // 缓存 plan；一旦某表结构变化，池里持有旧 plan 的连接下次复用时 PostgreSQL 会抛
        // `cached plan must not change result type`（SQLSTATE 0A000），表现为偶发 500。
        // 对「schema 会变」的多租户库，关缓存是正确取舍：换来的是彻底消除该错误。
        //
        // 用字段逐项构造 PgConnectOptions（而非解析 URL），避免密码含特殊字符时的转义问题。
        let opts = config.connect_options();

        // 与主库池同量级的保活：min≥1 把首连成本留在 create_pool，避免业务请求
        // 中段 `begin()` 才 TCP+认证（日志里「创建连接池」后整请求 4s+ 的根因）。
        // 不对租户池开 test_before_acquire：跨公网时每 acquire 多一趟 RTT。
        let pool_opts = TenantPoolOptions::from_env();
        let db_max = config.max_connections.max(1);
        let max_connections = effective_max_connections(db_max);
        let min_connections = pool_opts.clamped_min(max_connections);
        let env_override = std::env::var("TENANT_DB_MAX_CONNECTIONS").ok();

        tracing::info!(
            "租户池参数: id={}, db_max={}, effective_max={}, env_override={:?}, min={}, idle_timeout={}s, max_lifetime={}s",
            config.id,
            db_max,
            max_connections,
            env_override,
            min_connections,
            pool_opts.idle_timeout_secs,
            pool_opts.max_lifetime_secs
        );

        let pool = PgPoolOptions::new()
            .max_connections(max_connections)
            .min_connections(min_connections)
            .acquire_timeout(Duration::from_secs(config.connection_timeout))
            .idle_timeout(Some(Duration::from_secs(pool_opts.idle_timeout_secs)))
            .max_lifetime(Some(Duration::from_secs(pool_opts.max_lifetime_secs)))
            .connect_with(opts)
            .await
            .map_err(|e| {
                tracing::error!("创建连接池失败: {}", e);
                AppError::Internal(format!("连接数据库失败: {}", e))
            })?;

        sqlx::query("SELECT 1").execute(&pool).await.map_err(|e| {
            tracing::error!("租户库连接测试失败 id={}: {}", config.id, e);
            AppError::Internal(format!("连接数据库失败: {}", e))
        })?;

        Ok(pool)
    }
}

/// 租户池保活参数（env 可覆盖，默认对齐主库量级）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TenantPoolOptions {
    pub min_connections: u32,
    pub idle_timeout_secs: u64,
    pub max_lifetime_secs: u64,
}

impl TenantPoolOptions {
    pub fn from_env() -> Self {
        Self::from_env_map(|k| std::env::var(k).ok())
    }

    /// 可注入 env 读取，便于单测。
    pub fn from_env_map<F>(mut get: F) -> Self
    where
        F: FnMut(&str) -> Option<String>,
    {
        let parse_u32 = |raw: Option<String>, default: u32| {
            raw.and_then(|s| s.parse().ok()).unwrap_or(default)
        };
        let parse_u64 = |raw: Option<String>, default: u64| {
            raw.and_then(|s| s.parse().ok()).unwrap_or(default)
        };
        Self {
            min_connections: parse_u32(get("TENANT_DB_MIN_CONNECTIONS"), 1).max(1),
            idle_timeout_secs: parse_u64(get("TENANT_DB_IDLE_TIMEOUT"), 600).max(1),
            max_lifetime_secs: parse_u64(get("TENANT_DB_MAX_LIFETIME"), 1800).max(1),
        }
    }

    /// 保证 `min_connections <= max_connections`。
    pub fn clamped_min(&self, max_connections: u32) -> u32 {
        let max = max_connections.max(1);
        self.min_connections.min(max).max(1)
    }
}

impl Default for PoolManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_database_config_url() {
        let config = DatabaseConfig {
            id: 1,
            host: "localhost".to_string(),
            port: 5432,
            database: "mydb".to_string(),
            username: "user".to_string(),
            password: "pass".to_string(),
            max_connections: DEFAULT_TENANT_MAX_CONNECTIONS,
            connection_timeout: 30,
        };
        assert_eq!(
            config.connection_url(),
            "postgresql://user:pass@localhost:5432/mydb"
        );
    }

    #[test]
    fn effective_max_connections_uses_db_when_no_env() {
        assert_eq!(effective_max_connections_from(20, None), 20);
        assert_eq!(effective_max_connections_from(0, None), 1);
        assert_eq!(
            effective_max_connections_from(99, None),
            TENANT_MAX_CONNECTIONS_CAP
        );
    }

    #[test]
    fn effective_max_connections_env_overrides_db() {
        assert_eq!(
            effective_max_connections_from(10, Some("30".into())),
            30
        );
        assert_eq!(
            effective_max_connections_from(50, Some("5".into())),
            5
        );
    }

    #[test]
    fn effective_max_connections_invalid_env_falls_back() {
        assert_eq!(
            effective_max_connections_from(20, Some("0".into())),
            20
        );
        assert_eq!(
            effective_max_connections_from(20, Some("51".into())),
            20
        );
        assert_eq!(
            effective_max_connections_from(20, Some("abc".into())),
            20
        );
    }

    #[test]
    fn test_pool_manager_default() {
        let pm = PoolManager::default();
        assert_eq!(pm.active_pools_count(), 0);
        // 未加载的库不应凭空造出水位，否则监控页会把「池还没建」误报成「池空闲」
        assert!(pm.primary_watermark(1).is_none());
        assert!(pm.replica_watermarks(1).is_empty());
    }

    fn wm(max: u32, size: u32, idle: u32) -> PoolWaterMark {
        PoolWaterMark {
            max,
            min: 1,
            size,
            idle,
            in_use: size.saturating_sub(idle),
            acquire_timeout_secs: 30,
        }
    }

    #[test]
    fn watermark_usage_percent() {
        assert_eq!(wm(50, 50, 0).usage_percent(), 100);
        assert_eq!(wm(50, 25, 0).usage_percent(), 50);
        assert_eq!(wm(50, 10, 10).usage_percent(), 0);
        // max=0 不除零
        assert_eq!(wm(0, 0, 0).usage_percent(), 0);
    }

    #[test]
    fn watermark_saturation() {
        assert!(wm(50, 50, 0).is_saturated());
        // 还有空闲连接就不算打满
        assert!(!wm(50, 50, 1).is_saturated());
        assert!(!wm(50, 10, 0).is_saturated());
        assert!(!wm(0, 0, 0).is_saturated());
    }

    #[test]
    fn watermark_in_use_never_underflows() {
        // idle > size 是并发读两个原子量的瞬时不一致，不能 panic
        let w = wm(50, 3, 5);
        assert_eq!(w.in_use, 0);
        assert_eq!(w.usage_percent(), 0);
    }

    #[test]
    fn tenant_pool_options_defaults() {
        let opts = TenantPoolOptions::from_env_map(|_| None);
        assert_eq!(
            opts,
            TenantPoolOptions {
                min_connections: 1,
                idle_timeout_secs: 600,
                max_lifetime_secs: 1800,
            }
        );
    }

    #[test]
    fn tenant_pool_options_from_env_map() {
        let opts = TenantPoolOptions::from_env_map(|k| match k {
            "TENANT_DB_MIN_CONNECTIONS" => Some("3".into()),
            "TENANT_DB_IDLE_TIMEOUT" => Some("120".into()),
            "TENANT_DB_MAX_LIFETIME" => Some("900".into()),
            _ => None,
        });
        assert_eq!(opts.min_connections, 3);
        assert_eq!(opts.idle_timeout_secs, 120);
        assert_eq!(opts.max_lifetime_secs, 900);
    }

    #[test]
    fn tenant_pool_options_clamped_min() {
        let opts = TenantPoolOptions {
            min_connections: 8,
            idle_timeout_secs: 600,
            max_lifetime_secs: 1800,
        };
        assert_eq!(opts.clamped_min(10), 8);
        assert_eq!(opts.clamped_min(2), 2);
        assert_eq!(opts.clamped_min(0), 1);
    }
}
