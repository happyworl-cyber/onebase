//! Redis 连接管理
//!
//! 封装 Redis 连接管理器，支持 Standalone 模式。
//! 后续可扩展 Sentinel / Cluster 模式。

use redis::aio::ConnectionManager;
use redis::Client;
use std::sync::Arc;
use std::time::Duration;

use crate::error::{AppError, Result};

/// Redis 启动期连接超时。设短一点，避免不可达的 REDIS_URL（例如 IP 路由不通）
/// 卡住整个 main()——HTTP 服务必须先把 Redis 这一步过掉才会 bind 端口。
/// 业务请求时的 read/write 由 ConnectionManager 自动重连，这里只关心首次连接。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

/// Redis 连接管理器
#[derive(Clone)]
pub struct RedisManager {
    conn: Arc<ConnectionManager>,
}

impl RedisManager {
    /// 从 Redis URL 创建连接管理器
    pub async fn new(redis_url: &str) -> std::result::Result<Self, AppError> {
        let client = Client::open(redis_url)
            .map_err(|e| AppError::Internal(format!("Redis 客户端创建失败: {}", e)))?;

        // 给首次连接套一个超时，避免 TCP SYN 一直卡在不可达地址上拖慢启动。
        let conn = tokio::time::timeout(CONNECT_TIMEOUT, ConnectionManager::new(client))
            .await
            .map_err(|_| {
                AppError::Internal(format!(
                    "Redis 连接超时（>{:?}），请检查 REDIS_URL 是否可达",
                    CONNECT_TIMEOUT
                ))
            })?
            .map_err(|e| AppError::Internal(format!("Redis 连接失败: {}", e)))?;

        tracing::info!("Redis 连接成功: {}", redis_url);
        Ok(Self {
            conn: Arc::new(conn),
        })
    }

    /// 获取连接（克隆 ConnectionManager，自动重连）
    pub fn conn(&self) -> ConnectionManager {
        (*self.conn).clone()
    }

    /// GET 操作
    pub async fn get(&self, key: &str) -> Result<Option<String>> {
        let mut conn = self.conn();
        let val: Option<String> = redis::cmd("GET")
            .arg(key)
            .query_async(&mut conn)
            .await
            .map_err(|e| AppError::Internal(format!("Redis GET 失败: {}", e)))?;
        Ok(val)
    }

    /// SET 操作（带 TTL）
    pub async fn set_ex(&self, key: &str, value: &str, ttl_secs: u64) -> Result<()> {
        let mut conn = self.conn();
        let _: () = redis::cmd("SET")
            .arg(key)
            .arg(value)
            .arg("EX")
            .arg(ttl_secs)
            .query_async(&mut conn)
            .await
            .map_err(|e| AppError::Internal(format!("Redis SET 失败: {}", e)))?;
        Ok(())
    }

    /// DEL 操作
    pub async fn del(&self, key: &str) -> Result<()> {
        let mut conn = self.conn();
        let _: () = redis::cmd("DEL")
            .arg(key)
            .query_async(&mut conn)
            .await
            .map_err(|e| AppError::Internal(format!("Redis DEL 失败: {}", e)))?;
        Ok(())
    }

    /// 按模式批量删除 key（SCAN + DEL，不阻塞）
    pub async fn del_pattern(&self, pattern: &str) -> Result<u64> {
        let mut conn = self.conn();
        let mut cursor: u64 = 0;
        let mut deleted: u64 = 0;

        loop {
            let (next_cursor, keys): (u64, Vec<String>) = redis::cmd("SCAN")
                .arg(cursor)
                .arg("MATCH")
                .arg(pattern)
                .arg("COUNT")
                .arg(100)
                .query_async(&mut conn)
                .await
                .map_err(|e| AppError::Internal(format!("Redis SCAN 失败: {}", e)))?;

            if !keys.is_empty() {
                let count: u64 = redis::cmd("DEL")
                    .arg(&keys)
                    .query_async(&mut conn)
                    .await
                    .map_err(|e| AppError::Internal(format!("Redis DEL 失败: {}", e)))?;
                deleted += count;
            }

            cursor = next_cursor;
            if cursor == 0 {
                break;
            }
        }

        Ok(deleted)
    }

    /// INCR + EXPIRE 原子操作（用于限流计数）
    pub async fn incr_with_expire(&self, key: &str, ttl_secs: u64) -> Result<u64> {
        let mut conn = self.conn();
        let count: u64 = redis::cmd("INCR")
            .arg(key)
            .query_async(&mut conn)
            .await
            .map_err(|e| AppError::Internal(format!("Redis INCR 失败: {}", e)))?;

        if count == 1 {
            let _: () = redis::cmd("EXPIRE")
                .arg(key)
                .arg(ttl_secs)
                .query_async(&mut conn)
                .await
                .map_err(|e| AppError::Internal(format!("Redis EXPIRE 失败: {}", e)))?;
        }

        Ok(count)
    }

    /// 获取 key 的 TTL
    pub async fn ttl(&self, key: &str) -> Result<i64> {
        let mut conn = self.conn();
        let ttl: i64 = redis::cmd("TTL")
            .arg(key)
            .query_async(&mut conn)
            .await
            .map_err(|e| AppError::Internal(format!("Redis TTL 失败: {}", e)))?;
        Ok(ttl)
    }

    /// PING 健康检查
    pub async fn ping(&self) -> Result<bool> {
        let mut conn = self.conn();
        let result: std::result::Result<String, _> =
            redis::cmd("PING").query_async(&mut conn).await;
        Ok(result.map(|s| s == "PONG").unwrap_or(false))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_redis_manager_is_clone() {
        fn assert_clone<T: Clone>() {}
        assert_clone::<RedisManager>();
    }

    #[test]
    fn test_redis_manager_is_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<RedisManager>();
    }
}
