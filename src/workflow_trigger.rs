use serde_json::{json, Value};
use sqlx::PgPool;

use crate::events::{DataChangeEvent, EventBus};
use crate::workflow_handlers::{self, Workflow};

/// 启动工作流事件触发器（后台任务）
///
/// 订阅 EventBus，当数据变更事件到达时，检查是否有匹配的 hook 类型工作流需要触发。
pub fn start_event_trigger(event_bus: EventBus, pool: PgPool) {
    tokio::spawn(async move {
        let mut rx = event_bus.subscribe();
        tracing::info!("工作流事件触发器已启动（DAG 引擎）");

        loop {
            match rx.recv().await {
                Ok(event) => {
                    if let Err(e) = handle_event(&pool, &event).await {
                        tracing::error!("处理工作流事件触发失败: {}", e);
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!("工作流触发器: 跳过 {} 个事件（处理太慢）", n);
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    tracing::info!("工作流事件触发器: EventBus 关闭，退出");
                    break;
                }
            }
        }
    });
}

/// 处理单个数据变更事件：查找匹配的工作流并触发
async fn handle_event(pool: &PgPool, event: &DataChangeEvent) -> Result<(), sqlx::Error> {
    let workflows = sqlx::query_as::<_, Workflow>(
        r#"SELECT * FROM management.workflows
           WHERE is_enabled = true
           AND trigger_type = 'hook'
           AND (tenant_id IS NULL OR tenant_id = $1)"#,
    )
    .bind(event.tenant_id)
    .fetch_all(pool)
    .await?;

    for workflow in &workflows {
        if matches_hook_trigger(&workflow.trigger_config, event) {
            trigger_workflow_for_event(pool, workflow, event).await;
        }
    }

    Ok(())
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
        if !actions
            .iter()
            .any(|a| a.as_str().map(|s| s.eq_ignore_ascii_case(&action_str)).unwrap_or(false))
        {
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
        if let Err(e) =
            workflow_handlers::execute_workflow_internal(&pool_clone, &wf, "hook", &trigger_data, None)
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
