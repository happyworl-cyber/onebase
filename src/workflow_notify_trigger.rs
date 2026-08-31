//! PostgreSQL `NOTIFY` → 工作流触发器
//!
//! 与 `sse_notify_bridge` 不同，本模块不直接发布 SSE，而是把业务库 `NOTIFY` 作为
//! `trigger_type = 'notify'` 的工作流触发源。工作流再通过现有 `sse_publish` 节点决定如何
//! 定向推送给客户端。

use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::task::JoinHandle;

use crate::pg_listen_hub::ListenHub;
use crate::workflow_handlers;
use crate::workflow_handlers::Workflow;

const REFRESH_INTERVAL: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct NotifyTriggerConfig {
    pub(crate) database_id: i32,
    pub(crate) channel: String,
}

fn notify_config_for_workflow(_workflow: &Workflow) -> Option<NotifyTriggerConfig> {
    if _workflow.trigger_type != "notify" || !_workflow.is_enabled {
        return None;
    }

    let channel = _workflow
        .trigger_config
        .get("channel")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    if channel.len() > 63 {
        return None;
    }

    let database_id = _workflow
        .trigger_config
        .get("database_id")
        .and_then(|v| v.as_i64())
        .map(|id| id as i32)
        .or(_workflow.database_id)?;

    Some(NotifyTriggerConfig {
        database_id,
        channel: channel.to_string(),
    })
}

fn build_trigger_data(_database_id: i32, _channel: &str, _payload_raw: &str) -> Option<Value> {
    let payload: Value = serde_json::from_str(_payload_raw).ok()?;
    Some(json!({
        "notify": {
            "database_id": _database_id,
            "channel": _channel,
            "payload_raw": _payload_raw,
        },
        "payload": payload,
    }))
}

fn workflow_matches_notify(_workflow: &Workflow, _database_id: i32, _channel: &str) -> bool {
    notify_config_for_workflow(_workflow)
        .map(|cfg| cfg.database_id == _database_id && cfg.channel == _channel)
        .unwrap_or(false)
}

/// 启动工作流 NOTIFY 触发器管理任务。
///
/// 每 10s 扫描启用的 `trigger_type='notify'` 工作流，按 `(database_id, channel)` 去重
/// 向 `ListenHub` 订阅。收到 NOTIFY 后再实时查询匹配工作流并触发，保证工作流节点/配置更新无需重启。
pub fn start_notify_trigger(main_pool: PgPool, hub: ListenHub) -> JoinHandle<()> {
    tokio::spawn(async move {
        tracing::info!(
            "工作流 NOTIFY 触发器管理任务已启动 (interval={:?})",
            REFRESH_INTERVAL
        );
        let mut running: HashMap<NotifyTriggerConfig, JoinHandle<()>> = HashMap::new();

        loop {
            match load_active_notify_configs(&main_pool).await {
                Ok(configs) => {
                    running.retain(|cfg, handle| {
                        if handle.is_finished() {
                            tracing::warn!(
                                database_id = cfg.database_id,
                                channel = %cfg.channel,
                                "工作流 NOTIFY 订阅已结束，下次扫描将重新订阅"
                            );
                            return false;
                        }
                        let keep = configs.contains(cfg);
                        if !keep {
                            tracing::info!(
                                database_id = cfg.database_id,
                                channel = %cfg.channel,
                                "停止工作流 NOTIFY listener"
                            );
                            handle.abort();
                        }
                        keep
                    });

                    for cfg in configs {
                        if !running.contains_key(&cfg) {
                            tracing::info!(
                                database_id = cfg.database_id,
                                channel = %cfg.channel,
                                "启动工作流 NOTIFY listener"
                            );
                            let mut sub = hub.subscribe(cfg.database_id, &cfg.channel);
                            let pool = main_pool.clone();
                            let database_id = cfg.database_id;
                            let channel = cfg.channel.clone();
                            let task = tokio::spawn(async move {
                                while let Some(notice) = sub.recv().await {
                                    match build_trigger_data(
                                        notice.database_id,
                                        &notice.channel,
                                        &notice.payload,
                                    ) {
                                        Some(trigger_data) => {
                                            trigger_matching_workflows(
                                                &pool,
                                                notice.database_id,
                                                &notice.channel,
                                                trigger_data,
                                            )
                                            .await;
                                        }
                                        None => tracing::warn!(
                                            database_id = notice.database_id,
                                            channel = %notice.channel,
                                            "工作流 NOTIFY payload 非 JSON，跳过"
                                        ),
                                    }
                                }
                                tracing::warn!(
                                    database_id,
                                    channel = %channel,
                                    "工作流 NOTIFY recv 已结束"
                                );
                            });
                            running.insert(cfg, task);
                        }
                    }
                }
                Err(e) => tracing::warn!("加载工作流 NOTIFY 配置失败（保留上次）: {}", e),
            }

            tokio::time::sleep(REFRESH_INTERVAL).await;
        }
    })
}

pub(crate) async fn load_active_notify_configs(
    pool: &PgPool,
) -> Result<Vec<NotifyTriggerConfig>, sqlx::Error> {
    let workflows = sqlx::query_as::<_, Workflow>(
        "SELECT * FROM management.workflows WHERE is_enabled = true AND trigger_type = 'notify'",
    )
    .fetch_all(pool)
    .await?;

    let mut configs = Vec::new();
    for workflow in &workflows {
        if let Some(cfg) = notify_config_for_workflow(workflow) {
            if !configs.contains(&cfg) {
                configs.push(cfg);
            }
        }
    }
    Ok(configs)
}

async fn trigger_matching_workflows(
    pool: &PgPool,
    database_id: i32,
    channel: &str,
    trigger_data: Value,
) {
    let workflows = match sqlx::query_as::<_, Workflow>(
        "SELECT * FROM management.workflows WHERE is_enabled = true AND trigger_type = 'notify'",
    )
    .fetch_all(pool)
    .await
    {
        Ok(workflows) => workflows,
        Err(e) => {
            tracing::error!(error = %e, "查询 notify 工作流失败");
            return;
        }
    };

    for workflow in workflows {
        if !workflow_matches_notify(&workflow, database_id, channel) {
            continue;
        }
        tracing::info!(
            workflow_id = workflow.id,
            slug = %workflow.slug,
            database_id,
            channel,
            "NOTIFY 触发工作流"
        );
        let pool_clone = pool.clone();
        let trigger_data = trigger_data.clone();
        tokio::spawn(async move {
            if let Err(e) = workflow_handlers::execute_workflow_internal(
                &pool_clone,
                &workflow,
                "notify",
                &trigger_data,
                None,
                crate::workflow_engine::ApiKeyWriteGuard::Off,
            )
            .await
            {
                tracing::error!(
                    workflow_id = workflow.id,
                    error = %e,
                    "NOTIFY 触发的工作流执行失败"
                );
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn workflow(database_id: Option<i32>, trigger_config: Value) -> Workflow {
        Workflow {
            id: 42,
            tenant_id: Some(7),
            database_id,
            name: "growth animation".to_string(),
            slug: "growth-animation".to_string(),
            description: None,
            category: None,
            department: None,
            trigger_type: "notify".to_string(),
            trigger_config,
            nodes: json!([]),
            edges: json!([]),
            dependencies: json!({}),
            is_enabled: true,
            timeout_ms: 30_000,
            max_retries: 0,
            alert_webhook_url: None,
            alert_webhook_template: None,
            alert_throttle_hours: 24,
            last_alert_sent_at: None,
            created_by: Some(1),
            created_by_name: None,
            created_by_email: None,
            created_at: chrono::NaiveDateTime::default(),
            updated_at: chrono::NaiveDateTime::default(),
        }
    }

    #[test]
    fn config_uses_workflow_database_and_channel() {
        let wf = workflow(Some(2), json!({ "channel": "growth_animation_available" }));

        let cfg = notify_config_for_workflow(&wf).unwrap();
        assert_eq!(
            cfg,
            NotifyTriggerConfig {
                database_id: 2,
                channel: "growth_animation_available".to_string(),
            }
        );
    }

    #[test]
    fn config_allows_database_override_in_trigger_config() {
        let wf = workflow(
            Some(2),
            json!({ "database_id": 9, "channel": "growth_animation_available" }),
        );

        let cfg = notify_config_for_workflow(&wf).unwrap();
        assert_eq!(cfg.database_id, 9);
        assert_eq!(cfg.channel, "growth_animation_available");
    }

    #[test]
    fn config_missing_channel_is_ignored() {
        let wf = workflow(Some(2), json!({}));
        assert_eq!(notify_config_for_workflow(&wf), None);
    }

    #[test]
    fn trigger_data_exposes_payload_and_notify_metadata() {
        let data = build_trigger_data(
            2,
            "growth_animation_available",
            r#"{"eventId":123,"projectId":1,"wayUid":"u1","eventType":"reward_claim"}"#,
        )
        .unwrap();

        assert_eq!(data["payload"]["eventId"], 123);
        assert_eq!(data["payload"]["projectId"], 1);
        assert_eq!(data["payload"]["wayUid"], "u1");
        assert_eq!(data["notify"]["database_id"], 2);
        assert_eq!(data["notify"]["channel"], "growth_animation_available");
        assert_eq!(
            data["notify"]["payload_raw"],
            r#"{"eventId":123,"projectId":1,"wayUid":"u1","eventType":"reward_claim"}"#
        );
    }

    #[test]
    fn non_json_payload_is_ignored() {
        assert_eq!(
            build_trigger_data(2, "growth_animation_available", "not json"),
            None
        );
    }

    #[test]
    fn workflow_matching_requires_same_database_and_channel() {
        let wf = workflow(Some(2), json!({ "channel": "growth_animation_available" }));

        assert!(workflow_matches_notify(
            &wf,
            2,
            "growth_animation_available"
        ));
        assert!(!workflow_matches_notify(
            &wf,
            3,
            "growth_animation_available"
        ));
        assert!(!workflow_matches_notify(&wf, 2, "other_channel"));
    }
}
