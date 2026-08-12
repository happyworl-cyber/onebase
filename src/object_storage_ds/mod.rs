//! 对象存储数据源：租户登记 COS / OSS / MinIO（S3 兼容）并统一使用。
//!
//! lib-safe：models / client_cache / commands 可随 lib crate 编译（便于后续工作流节点）。
//! axum handlers 在 bin-only 的 `crate::object_storage_handlers`。

pub mod auth;
pub mod client_cache;
pub mod commands;
pub mod models;

use sqlx::PgPool;

use crate::error::{AppError, Result};
use crate::object_storage_ds::models::ObjectStorageConnection;

pub async fn fetch_active(pool: &PgPool, id: i64) -> Result<ObjectStorageConnection> {
    sqlx::query_as::<_, ObjectStorageConnection>(
        "SELECT * FROM management.object_storage_connections WHERE id = $1 AND is_active = true",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询对象存储连接失败: {e}")))?
    .ok_or_else(|| AppError::NotFound(format!("对象存储连接 {id} 不存在或已禁用")))
}

/// 按 id + tenant_id 取启用中的连接（工作流节点：锁死本租户，杜绝跨租户取数）。
pub async fn fetch_active_for_tenant(
    pool: &PgPool,
    id: i64,
    tenant_id: i32,
) -> Result<ObjectStorageConnection> {
    sqlx::query_as::<_, ObjectStorageConnection>(
        "SELECT * FROM management.object_storage_connections \
         WHERE id = $1 AND tenant_id = $2 AND is_active = true",
    )
    .bind(id)
    .bind(tenant_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询对象存储连接失败: {e}")))?
    .ok_or_else(|| {
        AppError::NotFound(format!(
            "对象存储连接 {id} 不存在 / 已禁用 / 不属于当前租户"
        ))
    })
}
