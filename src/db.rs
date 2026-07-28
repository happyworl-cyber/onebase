use sqlx::{postgres::PgPoolOptions, PgPool};
use std::time::Duration;

/// 创建数据库连接池（优化配置）
pub async fn create_pool(database_url: &str) -> anyhow::Result<PgPool> {
    // 从环境变量读取配置，提供默认值
    let max_connections = std::env::var("DB_MAX_CONNECTIONS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(20); // 默认 20 个连接

    let min_connections = std::env::var("DB_MIN_CONNECTIONS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(2); // 默认最少 2 个连接

    let acquire_timeout = std::env::var("DB_ACQUIRE_TIMEOUT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(30); // 默认 30 秒

    let idle_timeout = std::env::var("DB_IDLE_TIMEOUT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(600); // 默认 600 秒（10 分钟）

    let max_lifetime = std::env::var("DB_MAX_LIFETIME")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1800); // 默认 1800 秒（30 分钟）

    tracing::info!(
        "配置数据库连接池: max={}, min={}, acquire_timeout={}s, idle_timeout={}s, max_lifetime={}s",
        max_connections, min_connections, acquire_timeout, idle_timeout, max_lifetime
    );

    let pool = PgPoolOptions::new()
        .max_connections(max_connections)
        .min_connections(min_connections)
        .acquire_timeout(Duration::from_secs(acquire_timeout))
        .idle_timeout(Some(Duration::from_secs(idle_timeout)))
        .max_lifetime(Some(Duration::from_secs(max_lifetime)))
        // 连接前测试
        .test_before_acquire(true)
        .connect(database_url)
        .await?;

    tracing::info!("✅ 数据库连接池创建成功");
    
    // 测试连接
    let conn_test = sqlx::query("SELECT 1").execute(&pool).await;
    match conn_test {
        Ok(_) => tracing::info!("✅ 数据库连接测试成功"),
        Err(e) => {
            tracing::error!("❌ 数据库连接测试失败: {}", e);
            return Err(e.into());
        }
    }

    Ok(pool)
}

