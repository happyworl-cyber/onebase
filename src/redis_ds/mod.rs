//! Redis 数据源：把租户已有的 Redis 实例登记进平台并统一使用。
//!
//! 三条消费路径共用同一份连接注册表（`management.redis_connections`）：
//!   - 管理 API：`/api/admin/redis-connections/*`（见 `crate::redis_handlers`，bin-only）
//!   - 数据 API：`/api/redis-connections/:id/exec`（同上）
//!   - 工作流 `redis` 节点（见 `workflow_engine::exec_redis_node`）
//!
//! 本模块（models / client_cache / commands）刻意保持"lib-safe"：只依赖
//! crypto / error / redis / sqlx / serde，因此能随 `workflow_engine` 一起编进 lib crate。
//! 真正的 axum handler 放在 bin-only 的 `crate::redis_handlers`，那里才用到
//! `audit_handlers` / `permissions` 等 bin 模块。
//!
//! 与既有平台 Redis（`redis_manager` + `REDIS_URL`，用于缓存 / 限流 / pub-sub）互不相干。

pub mod client_cache;
pub mod commands;
pub mod models;

use sqlx::PgPool;

use crate::error::{AppError, Result};
use crate::redis_ds::models::RedisConnection;

/// 按 id 取"启用中"的连接；不做权限校验（调用方负责）。
pub async fn fetch_active(pool: &PgPool, id: i64) -> Result<RedisConnection> {
    sqlx::query_as::<_, RedisConnection>(
        "SELECT * FROM management.redis_connections WHERE id = $1 AND is_active = true",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询 Redis 连接失败: {e}")))?
    .ok_or_else(|| AppError::NotFound(format!("Redis 连接 {id} 不存在或已禁用")))
}

/// 按 id + tenant_id 取"启用中"的连接（工作流节点用：锁死在本租户，杜绝跨租户取数）。
pub async fn fetch_active_for_tenant(
    pool: &PgPool,
    id: i64,
    tenant_id: i32,
) -> Result<RedisConnection> {
    sqlx::query_as::<_, RedisConnection>(
        "SELECT * FROM management.redis_connections \
         WHERE id = $1 AND tenant_id = $2 AND is_active = true",
    )
    .bind(id)
    .bind(tenant_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询 Redis 连接失败: {e}")))?
    .ok_or_else(|| AppError::NotFound(format!("Redis 连接 {id} 不存在 / 已禁用 / 不属于当前租户")))
}
