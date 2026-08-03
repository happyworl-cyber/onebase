//! Redis 数据源连接缓存。
//!
//! 与 `pool_manager` 对 PostgreSQL 的做法平行：按 `redis_connections.id` 缓存一个
//! `ConnectionManager`（自动重连），首次用到时懒加载。连接被更新 / 删除时由 handler
//! 调用 [`invalidate`] 踢出缓存，下次访问重建。
//!
//! 注意：本模块随 `redis_ds` 同时编译进 lib crate 与 bin crate（因 `workflow_engine`
//! 两侧共用源文件），故 [`CACHE`] 在两个 crate 各有一份——与 `POOL_MANAGER` 同款限制，
//! 属既有约定，不额外处理。

use dashmap::DashMap;
use once_cell::sync::Lazy;
use redis::aio::ConnectionManager;
use redis::{Client, ConnectionAddr, ConnectionInfo, RedisConnectionInfo};
use std::time::Duration;

use crate::error::{AppError, Result};
use crate::redis_ds::models::RedisConnection;

/// connection_id → 已建立的 ConnectionManager。
static CACHE: Lazy<DashMap<i64, ConnectionManager>> = Lazy::new(DashMap::new);

/// 由 DB 行 + 解密后的明文密码构造 redis 连接信息（不走 URL 拼接，避免密码里的
/// 特殊字符破坏 URL 解析）。
fn build_connection_info(conn: &RedisConnection, password: Option<String>) -> ConnectionInfo {
    let host = conn.host.trim().to_string();
    let port = conn.port as u16;
    let addr = if conn.use_tls {
        ConnectionAddr::TcpTls {
            host,
            port,
            insecure: false,
            tls_params: None,
        }
    } else {
        ConnectionAddr::Tcp(host, port)
    };
    ConnectionInfo {
        addr,
        redis: RedisConnectionInfo {
            db: conn.db_index as i64,
            username: conn
                .username
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            password,
            ..Default::default()
        },
    }
}

/// 取（或懒建）指定连接的 ConnectionManager。
///
/// 明文密码从 `password_enc` 解密后仅在建连过程停留，不写入缓存键 / 日志。
pub async fn get_or_create(conn: &RedisConnection) -> Result<ConnectionManager> {
    if let Some(existing) = CACHE.get(&conn.id) {
        return Ok(existing.clone());
    }

    let password = match conn.password_enc.as_deref() {
        Some(enc) if !enc.is_empty() => Some(crate::crypto::decrypt_secret(enc)?),
        _ => None,
    };
    let info = build_connection_info(conn, password);

    let client = Client::open(info)
        .map_err(|e| AppError::Internal(format!("Redis 客户端创建失败: {e}")))?;

    let connect_timeout = Duration::from_secs(conn.connect_timeout_secs.clamp(1, 60) as u64);
    let manager = tokio::time::timeout(connect_timeout, ConnectionManager::new(client))
        .await
        .map_err(|_| {
            AppError::ServiceUnavailable(format!(
                "Redis 连接超时（>{}s），请检查 {}:{} 是否可达",
                connect_timeout.as_secs(),
                conn.host,
                conn.port
            ))
        })?
        .map_err(|e| AppError::ServiceUnavailable(format!("Redis 连接失败: {e}")))?;

    CACHE.insert(conn.id, manager.clone());
    Ok(manager)
}

/// 踢出缓存（连接配置更新 / 删除后调用），下次访问重建。
pub fn invalidate(connection_id: i64) {
    CACHE.remove(&connection_id);
}
