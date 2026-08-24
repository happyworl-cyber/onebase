//! Kafka 数据源：把租户已有的 Kafka 集群登记进平台并统一使用。
//!
//! 本模块（models / client_cache / commands）刻意保持"lib-safe"：只依赖
//! crypto / error / sqlx / serde，因此能随 `workflow_engine` 一起编进 lib crate。
//! 真正的 axum handler 放在 bin-only 的 `crate::kafka_handlers`（Task 后续）。

pub mod auth;
pub mod client_cache;
pub mod commands;
pub mod models;
pub mod trigger_config;

use sqlx::PgPool;

use crate::error::{AppError, Result};
use crate::kafka_ds::models::KafkaConnection;

/// 按 id 取"启用中"的连接；不做权限校验（调用方负责）。
pub async fn fetch_active(pool: &PgPool, id: i64) -> Result<KafkaConnection> {
    sqlx::query_as::<_, KafkaConnection>(
        "SELECT * FROM management.kafka_connections WHERE id = $1 AND is_active = true",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询 Kafka 连接失败: {e}")))?
    .ok_or_else(|| AppError::NotFound(format!("Kafka 连接 {id} 不存在或已禁用")))
}

/// 按 id + tenant_id 取"启用中"的连接（工作流节点用：锁死在本租户，杜绝跨租户取数）。
pub async fn fetch_active_for_tenant(
    pool: &PgPool,
    id: i64,
    tenant_id: i32,
) -> Result<KafkaConnection> {
    sqlx::query_as::<_, KafkaConnection>(
        "SELECT * FROM management.kafka_connections \
         WHERE id = $1 AND tenant_id = $2 AND is_active = true",
    )
    .bind(id)
    .bind(tenant_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询 Kafka 连接失败: {e}")))?
    .ok_or_else(|| AppError::NotFound(format!("Kafka 连接 {id} 不存在 / 已禁用 / 不属于当前租户")))
}
