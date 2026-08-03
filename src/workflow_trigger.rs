use serde_json::{json, Value};
use sqlx::PgPool;
use std::time::{Duration, Instant};

use crate::events::{DataChangeEvent, EventBus};
use crate::workflow_handlers::{self, Workflow};

/// hook 工作流缓存的有效期：每个事件最多触发一次 DB 拉取，TTL 内复用内存快照。
const HOOK_CACHE_TTL: Duration = Duration::from_secs(5);
/// Lagged（事件积压被丢弃）告警的最小间隔，避免高写入量下刷爆日志。
const LAG_WARN_INTERVAL: Duration = Duration::from_secs(10);

/// 启动工作流事件触发器（后台任务）
///
/// 订阅 EventBus，当数据变更事件到达时，检查是否有匹配的 hook 类型工作流需要触发。
///
/// 性能要点（修复"处理太慢、跳过事件"刷屏）：
/// - **不再为每个事件查库**。把启用的 hook 工作流缓存在内存里（TTL 5s），事件处理退化为
///   纯内存匹配；没有 hook 工作流时（最常见）几乎零成本，消费者不会再落后于 Auto API
///   的写入事件流而触发 broadcast Lagged。
/// - **Lagged 告警限流**：积压丢弃只按固定间隔聚合告警一次，不再每丢一批就打一行日志。
pub fn start_event_trigger(event_bus: EventBus, pool: PgPool) {
    tokio::spawn(async move {
        let mut rx = event_bus.subscribe();
        tracing::info!("工作流事件触发器已启动（DAG 引擎）");

        // 单消费者任务内的本地缓存，无需加锁。
        let mut hook_cache: Vec<Workflow> = Vec::new();
        let mut cache_loaded_at: Option<Instant> = None;

        // Lagged 告警限流状态。
        let mut dropped_since_warn: u64 = 0;
        let mut last_lag_warn: Option<Instant> = None;

        loop {
            match rx.recv().await {
                Ok(event) => {
                    // 按 TTL 刷新缓存。加载失败时也更新时间戳，避免每个事件都重试拖慢消费。
                    let need_reload = cache_loaded_at
                        .map(|t| t.elapsed() >= HOOK_CACHE_TTL)
                        .unwrap_or(true);
                    if need_reload {
                        match load_enabled_hook_workflows(&pool).await {
                            Ok(list) => hook_cache = list,
                            Err(e) => {
                                tracing::error!("加载 hook 工作流缓存失败: {}", e)
                            }
                        }
                        cache_loaded_at = Some(Instant::now());
                    }

                    if hook_cache.is_empty() {
                        continue;
                    }

                    for workflow in &hook_cache {
                        // 租户作用域：tenant_id 为空表示全局；否则需与事件租户一致。
                        let tenant_ok = workflow.tenant_id.is_none()
                            || workflow.tenant_id == Some(event.tenant_id);
                        if tenant_ok && matches_hook_trigger(&workflow.trigger_config, &event) {
                            trigger_workflow_for_event(&pool, workflow, &event).await;
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    dropped_since_warn += n;
                    let should_warn = last_lag_warn
                        .map(|t| t.elapsed() >= LAG_WARN_INTERVAL)
                        .unwrap_or(true);
                    if should_warn {
                        tracing::warn!(
                            dropped = dropped_since_warn,
                            "工作流触发器: 事件积压被丢弃（消费跟不上发布速率，已聚合告警）"
                        );
                        dropped_since_warn = 0;
                        last_lag_warn = Some(Instant::now());
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    tracing::info!("工作流事件触发器: EventBus 关闭，退出");
                    break;
                }
            }
        }
    });
}

/// 拉取所有启用的 hook 工作流（不按租户过滤，租户匹配放到内存里做）。
async fn load_enabled_hook_workflows(pool: &PgPool) -> Result<Vec<Workflow>, sqlx::Error> {
    sqlx::query_as::<_, Workflow>(
        r#"SELECT * FROM management.workflows
           WHERE is_enabled = true AND trigger_type = 'hook'"#,
    )
    .fetch_all(pool)
    .await
}

/// 检查事件是否匹配工作流的 trigger_config
///
/// trigger_config 格式：
/// ```json
/// {
///   "table": "posts",
///   "schema": "public",
///   "actions": ["INSERT", "UPDATE"],
///   "database_id": 1
/// }
/// ```
fn matches_hook_trigger(config: &Value, event: &DataChangeEvent) -> bool {
    if let Some(table) = config.get("table").and_then(|v| v.as_str()) {
        if table != "*" && table != event.table {
            return false;
        }
    }

    if let Some(schema) = config.get("schema").and_then(|v| v.as_str()) {
        if schema != "*" && schema != event.schema {
            return false;
        }
    }

    if let Some(db_id) = config.get("database_id").and_then(|v| v.as_i64()) {
        if db_id as i32 != event.database_id {
            return false;
        }
    }

    if let Some(actions) = config.get("actions").and_then(|v| v.as_array()) {
        let action_str = event.action.to_string();
        if !actions.iter().any(|a| {
            a.as_str()
                .map(|s| s.eq_ignore_ascii_case(&action_str))
                .unwrap_or(false)
        }) {
            return false;
        }
    }

    true
}

/// 为匹配的事件异步触发工作流（使用新 DAG 引擎）
async fn trigger_workflow_for_event(pool: &PgPool, workflow: &Workflow, event: &DataChangeEvent) {
    let trigger_data = json!({
        "event": {
            "tenant_id": event.tenant_id,
            "database_id": event.database_id,
            "schema": event.schema,
            "table": event.table,
            "action": event.action.to_string(),
            "old_data": event.old_data,
            "new_data": event.new_data,
            "user_id": event.user_id,
            "timestamp": event.timestamp.to_rfc3339(),
            "request_id": event.request_id,
        }
    });

    tracing::info!(
        workflow_id = workflow.id,
        slug = %workflow.slug,
        table = %event.table,
        action = %event.action,
        "Hook 触发工作流"
    );

    let pool_clone = pool.clone();
    let wf = workflow.clone();
    tokio::spawn(async move {
        if let Err(e) = workflow_handlers::execute_workflow_internal(
            &pool_clone,
            &wf,
            "hook",
            &trigger_data,
            None,
        )
        .await
        {
            tracing::error!(
                workflow_id = wf.id,
                error = %e,
                "Hook 触发的工作流执行失败"
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::ChangeAction;

    #[test]
    fn test_matches_hook_trigger_basic() {
        let config = json!({
            "table": "posts",
            "schema": "public",
            "actions": ["INSERT", "UPDATE"]
        });

        let event = DataChangeEvent {
            tenant_id: 1,
            database_id: 1,
            schema: "public".to_string(),
            table: "posts".to_string(),
            action: ChangeAction::Insert,
            old_data: None,
            new_data: None,
            user_id: Some(1),
            timestamp: chrono::Utc::now(),
            request_id: None,
        };

        assert!(matches_hook_trigger(&config, &event));
    }

    #[test]
    fn test_matches_hook_trigger_wrong_table() {
        let config = json!({
            "table": "users",
            "actions": ["INSERT"]
        });

        let event = DataChangeEvent {
            tenant_id: 1,
            database_id: 1,
            schema: "public".to_string(),
            table: "posts".to_string(),
            action: ChangeAction::Insert,
            old_data: None,
            new_data: None,
            user_id: Some(1),
            timestamp: chrono::Utc::now(),
            request_id: None,
        };

        assert!(!matches_hook_trigger(&config, &event));
    }

    #[test]
    fn test_matches_hook_trigger_wildcard() {
        let config = json!({
            "table": "*",
            "schema": "*"
        });

        let event = DataChangeEvent {
            tenant_id: 1,
            database_id: 1,
            schema: "any_schema".to_string(),
            table: "any_table".to_string(),
            action: ChangeAction::Update,
            old_data: None,
            new_data: None,
            user_id: Some(1),
            timestamp: chrono::Utc::now(),
            request_id: None,
        };

        assert!(matches_hook_trigger(&config, &event));
    }
}
