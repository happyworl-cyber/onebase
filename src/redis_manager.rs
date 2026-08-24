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

/// 单条 Redis 命令的执行超时。
///
/// 关键护栏：ConnectionManager 在 Redis 不可达 / 抖动 / 重连时，命令会一直 await
/// 直到底层 socket 超时（默认很长），从而把整个 HTTP 请求拖到 ~10s。给每条命令套一个
/// 短超时后，Redis 退化只会让缓存「读 miss → 直接打 DB、写失效静默跳过」，而不会拖慢
/// 业务请求。2s 对健康 Redis 绰绰有余（正常 <1ms），对劣化 Redis 又足够快地放弃。
const OP_TIMEOUT: Duration = Duration::from_secs(2);

/// 给单条 Redis 命令套超时；超时/错误都归一成 `AppError`，由调用方决定吞掉还是上抛。
async fn timed<T>(
    label: &str,
    fut: impl std::future::Future<Output = redis::RedisResult<T>>,
) -> Result<T> {
    match tokio::time::timeout(OP_TIMEOUT, fut).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(AppError::Internal(format!("Redis {} 失败: {}", label, e))),
        Err(_) => {
            tracing::warn!(
                "Redis {} 超时（>{:?}），按失败处理（缓存退化，不拖慢请求）",
                label,
                OP_TIMEOUT
            );
            Err(AppError::Internal(format!("Redis {} 超时", label)))
        }
    }
}

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
        timed("GET", redis::cmd("GET").arg(key).query_async(&mut conn)).await
    }

    /// SET 操作（带 TTL）
    pub async fn set_ex(&self, key: &str, value: &str, ttl_secs: u64) -> Result<()> {
        let mut conn = self.conn();
        timed(
            "SET",
            redis::cmd("SET")
                .arg(key)
                .arg(value)
                .arg("EX")
                .arg(ttl_secs)
                .query_async(&mut conn),
        )
        .await
    }

    /// DEL 操作
    #[allow(dead_code)]
    pub async fn del(&self, key: &str) -> Result<()> {
        let mut conn = self.conn();
        timed("DEL", redis::cmd("DEL").arg(key).query_async(&mut conn)).await
    }

    /// 按模式批量删除 key（SCAN + DEL）。
    ///
    /// 注意：`SCAN MATCH` 是全 keyspace 遍历，大 keyspace 上很慢。整段循环套一个总超时，
    /// 超时即放弃（返回已删数量），避免拖死调用方。**数据查询缓存（QueryCache）已不再走这里**
    /// （改用版本号失效），此函数现仅供权限缓存（PermissionCache）等小范围失效使用。
    pub async fn del_pattern(&self, pattern: &str) -> Result<u64> {
        let inner = async {
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
            Ok::<u64, AppError>(deleted)
        };

        match tokio::time::timeout(OP_TIMEOUT, inner).await {
            Ok(r) => r,
            Err(_) => {
                tracing::warn!(
                    "Redis del_pattern({}) 超时（>{:?}），放弃剩余删除",
                    pattern,
                    OP_TIMEOUT
                );
                Ok(0)
            }
        }
    }

    /// INCR 并**每次都刷新** EXPIRE。
    ///
    /// 与 [`incr_with_expire`](Self::incr_with_expire) 的区别：后者只在 count==1（首次创建）
    /// 时设过期，用于限流窗口；本方法每次都重置 TTL，用于"表级缓存版本号"这类只要还在被
    /// 写入就不该过期、过期了也只是回退到从 0 计数（语义安全）的计数器。
    pub async fn incr_refresh_expire(&self, key: &str, ttl_secs: u64) -> Result<u64> {
        let mut conn = self.conn();
        let count: u64 = timed("INCR", redis::cmd("INCR").arg(key).query_async(&mut conn)).await?;
        let _: () = timed(
            "EXPIRE",
            redis::cmd("EXPIRE")
                .arg(key)
                .arg(ttl_secs)
                .query_async(&mut conn),
        )
        .await?;
        Ok(count)
    }

    /// INCR + EXPIRE 原子操作（用于限流计数）
    pub async fn incr_with_expire(&self, key: &str, ttl_secs: u64) -> Result<u64> {
        let mut conn = self.conn();
        let count: u64 = timed("INCR", redis::cmd("INCR").arg(key).query_async(&mut conn)).await?;

        if count == 1 {
            let _: () = timed(
                "EXPIRE",
                redis::cmd("EXPIRE")
                    .arg(key)
                    .arg(ttl_secs)
                    .query_async(&mut conn),
            )
            .await?;
        }

        Ok(count)
    }

    /// 获取 key 的 TTL
    #[allow(dead_code)]
    pub async fn ttl(&self, key: &str) -> Result<i64> {
        let mut conn = self.conn();
        timed("TTL", redis::cmd("TTL").arg(key).query_async(&mut conn)).await
    }

    /// PING 健康检查
    pub async fn ping(&self) -> Result<bool> {
        let mut conn = self.conn();
        let result: Result<String> = timed("PING", redis::cmd("PING").query_async(&mut conn)).await;
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
