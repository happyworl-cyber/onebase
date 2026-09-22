//! LLM 连接注册表（`management.llm_connections`）。
//!
//! lib-safe：只依赖 error / sqlx / serde，随 `workflow_engine` 编进 lib crate。
//! axum handler 在 bin-only 的 `crate::llm_connection_handlers`。

pub mod models;

use sqlx::PgPool;

use crate::error::{AppError, Result};
use crate::llm_ds::models::LlmConnection;

pub async fn fetch_active(pool: &PgPool, id: i64) -> Result<LlmConnection> {
    sqlx::query_as::<_, LlmConnection>(
        "SELECT * FROM management.llm_connections WHERE id = $1 AND is_active = true",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询 LLM 连接失败: {e}")))?
    .ok_or_else(|| {
        AppError::not_found_coded(
            "llmds_connection_not_found_or_disabled",
            format!("LLM 连接 {id} 不存在或已禁用"),
            serde_json::json!({ "id": id }),
        )
    })
}

pub async fn fetch_active_for_tenant(
    pool: &PgPool,
    id: i64,
    tenant_id: i32,
) -> Result<LlmConnection> {
    sqlx::query_as::<_, LlmConnection>(
        "SELECT * FROM management.llm_connections \
         WHERE id = $1 AND tenant_id = $2 AND is_active = true",
    )
    .bind(id)
    .bind(tenant_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询 LLM 连接失败: {e}")))?
    .ok_or_else(|| {
        AppError::not_found_coded(
            "llmds_connection_not_found_for_tenant",
            format!("LLM 连接 {id} 不存在 / 已禁用 / 不属于当前租户"),
            serde_json::json!({ "id": id }),
        )
    })
}

pub async fn list_for_tenant(pool: &PgPool, tenant_id: i32) -> Result<Vec<LlmConnection>> {
    sqlx::query_as::<_, LlmConnection>(
        "SELECT * FROM management.llm_connections WHERE tenant_id = $1 ORDER BY id DESC",
    )
    .bind(tenant_id)
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::Internal(format!("列出 LLM 连接失败: {e}")))
}
