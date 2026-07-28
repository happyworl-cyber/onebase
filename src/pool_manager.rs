use dashmap::DashMap;
use once_cell::sync::Lazy;
use sqlx::postgres::{PgPool, PgPoolOptions};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio::sync::Mutex;

use crate::error::{AppError, Result};

pub static POOL_MANAGER: Lazy<PoolManager> = Lazy::new(PoolManager::new);

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
    pub fn connection_url(&self) -> String {
        format!(
            "postgresql://{}:{}@{}:{}/{}",
            self.username, self.password, self.host, self.port, self.database
        )
    }
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
    pub async fn get_or_create_pool(&self, config: DatabaseConfig) -> Result<PgPool> {
        if let Some(pool) = self.pools.get(&config.id) {
            if pool.acquire().await.is_ok() {
                return Ok(pool.clone());
            }
        }

        let _guard = self.create_lock.lock().await;

        if let Some(pool) = self.pools.get(&config.id) {
            if pool.acquire().await.is_ok() {
                return Ok(pool.clone());
            }
            self.pools.remove(&config.id);
        }

        let pool = Self::create_pool(&config).await?;
        self.pools.insert(config.id, pool.clone());

        if !self.groups.contains_key(&config.id) {
            self.groups.insert(config.id, PoolGroup::new(pool.clone()));
        }

        Ok(pool)
    }

    /// 兼容旧调用：默认权重 = 1，replica_id 用 config.id（与 tenant_databases.id 一致）
    pub async fn add_replica(&self, primary_db_id: i32, config: DatabaseConfig) -> Result<()> {
        let replica_id = config.id;
        self.upsert_replica(primary_db_id, replica_id, 1, config).await
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
            .and_then(|g| g.replicas.iter().find(|r| r.id == replica_id).map(|r| r.bypassed))
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

        PgPoolOptions::new()
            .max_connections(config.max_connections)
            .acquire_timeout(Duration::from_secs(config.connection_timeout))
            .connect(&config.connection_url())
            .await
            .map_err(|e| {
                tracing::error!("创建连接池失败: {}", e);
                AppError::Internal(format!("连接数据库失败: {}", e))
            })
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
            max_connections: 10,
            connection_timeout: 30,
        };
        assert_eq!(
            config.connection_url(),
            "postgresql://user:pass@localhost:5432/mydb"
        );
    }

    #[test]
    fn test_pool_manager_default() {
        let pm = PoolManager::default();
        assert_eq!(pm.active_pools_count(), 0);
    }
}
