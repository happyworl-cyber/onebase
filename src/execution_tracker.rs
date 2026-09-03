//! 工作流执行次数跟踪服务
//!
//! 用于跟踪和限制月度工作流执行次数（max_executions_per_month）。
//! 基于 Redis 实现，自动按月重置计数（使用 TTL）。

use chrono::{Datelike, Duration, Utc};
use redis::AsyncCommands;

use crate::error::{AppError, Result};
use crate::redis_manager::RedisManager;

/// 执行次数跟踪器
#[derive(Clone)]
pub struct ExecutionTracker {
    redis: RedisManager,
}

impl ExecutionTracker {
    /// 创建新的执行次数跟踪器
    pub fn new(redis: RedisManager) -> Self {
        Self { redis }
    }

    /// 获取当前月度的 Redis key
    fn current_month_key() -> String {
        format!("license:executions:{}", Utc::now().format("%Y-%m"))
    }

    /// 计算当月剩余秒数（用于设置 TTL）
    fn seconds_until_month_end() -> i64 {
        let now = Utc::now();
        let next_month = if now.month() == 12 {
            now.with_year(now.year() + 1)
                .unwrap()
                .with_month(1)
                .unwrap()
        } else {
            now.with_month(now.month() + 1).unwrap()
        };
        let first_of_next_month = next_month
            .with_day(1)
            .unwrap()
            .with_hour(0)
            .unwrap()
            .with_minute(0)
            .unwrap()
            .with_second(0)
            .unwrap();

        (first_of_next_month - now).num_seconds()
    }

    /// 增加执行计数
    ///
    /// 返回当前执行次数（包括本次）
    pub async fn increment(&self) -> Result<u64> {
        let key = Self::current_month_key();
        let mut conn = self.redis.conn();

        // 增加计数
        let count: u64 = conn
            .incr(&key, 1)
            .await
            .map_err(|e| AppError::Internal(format!("Redis incr 失败: {}", e)))?;

        // 如果是第一次（count == 1），设置过期时间
        if count == 1 {
            let ttl = Self::seconds_until_month_end();
            let _: () = conn
                .expire(&key, ttl as usize)
                .await
                .map_err(|e| AppError::Internal(format!("Redis expire 失败: {}", e)))?;

            tracing::debug!(
                "初始化月度执行计数器，TTL = {} 秒（到月底）",
                ttl
            );
        }

        Ok(count)
    }

    /// 获取当前月度执行次数
    pub async fn get_current_count(&self) -> Result<u64> {
        let key = Self::current_month_key();
        let mut conn = self.redis.conn();

        let count: Option<u64> = conn
            .get(&key)
            .await
            .map_err(|e| AppError::Internal(format!("Redis get 失败: {}", e)))?;

        Ok(count.unwrap_or(0))
    }

    /// 检查并增加执行计数
    ///
    /// 如果超过限制则返回错误，否则增加计数并返回当前值
    pub async fn track_and_check(&self, max_executions: Option<u64>) -> Result<u64> {
        // 如果没有限制，直接增加计数并返回
        let Some(max) = max_executions else {
            return self.increment().await;
        };

        // 先获取当前计数
        let current = self.get_current_count().await?;

        // 检查是否超限
        if current >= max {
            return Err(AppError::Forbidden(format!(
                "已达到月度工作流执行次数上限（{}/{}）。请升级 License 或等待下月重置。",
                current, max
            )));
        }

        // 增加计数
        let new_count = self.increment().await?;

        // 记录日志（接近上限时警告）
        if new_count >= max * 90 / 100 {
            tracing::warn!(
                "月度执行次数接近上限：{}/{} ({:.1}%)",
                new_count,
                max,
                (new_count as f64 / max as f64) * 100.0
            );
        }

        Ok(new_count)
    }

    /// 重置计数（仅用于测试）
    #[cfg(test)]
    pub async fn reset(&self) -> Result<()> {
        let key = Self::current_month_key();
        let mut conn = self.redis.conn();
        let _: () = conn
            .del(&key)
            .await
            .map_err(|e| AppError::Internal(format!("Redis del 失败: {}", e)))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_month_key_format() {
        let key = ExecutionTracker::current_month_key();
        // 格式应该是 "license:executions:YYYY-MM"
        assert!(key.starts_with("license:executions:"));
        assert_eq!(key.len(), "license:executions:YYYY-MM".len());
    }

    #[test]
    fn test_seconds_until_month_end() {
        let seconds = ExecutionTracker::seconds_until_month_end();
        // 应该在 0 到 31 天之间
        assert!(seconds > 0);
        assert!(seconds <= 31 * 24 * 3600);
    }
}
