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

use crate::workflow_handlers;
use crate::workflow_handlers::Workflow;

const REFRESH_INTERVAL: Duration = Duration::from_secs(10);
const RECONNECT_DELAY: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct NotifyTriggerConfig {
    database_id: i32,
    channel: String,
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
/// 每 10s 扫描启用的 `trigger_type='notify'` 工作流，按 `(database_id, channel)` 去重启动
/// listener。收到 NOTIFY 后再实时查询匹配工作流并触发，保证工作流节点/配置更新无需重启。
pub fn start_notify_trigger(main_pool: PgPool) -> JoinHandle<()> {
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
                            let handle = tokio::spawn(run_listener(main_pool.clone(), cfg.clone()));
                            running.insert(cfg, handle);
                        }
                    }
                }
                Err(e) => tracing::warn!("加载工作流 NOTIFY 配置失败（保留上次）: {}", e),
            }

            tokio::time::sleep(REFRESH_INTERVAL).await;
        }
    })
}

async fn load_active_notify_configs(
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

/// 某业务库上启用的 notify listener 数量（按 channel 去重）。
///
/// 监控页要展示「LISTEN 独立连接占了几条」，必须和管理任务实际起的 listener 数量一致。
/// 所以复用 `load_active_notify_configs` 的去重规则，而不是在 handler 里另写一条
/// `COUNT(DISTINCT trigger_config->>'channel')` —— 后者会漏掉
/// `trigger_config.database_id` 回退 `workflows.database_id` 的逻辑，日后必然漂移。
pub(crate) async fn active_listener_count(
    main_pool: &PgPool,
    database_id: i32,
) -> Result<usize, sqlx::Error> {
    let configs = load_active_notify_configs(main_pool).await?;
    Ok(configs
        .iter()
        .filter(|c| c.database_id == database_id)
        .count())
}

async fn run_listener(main_pool: PgPool, cfg: NotifyTriggerConfig) {
    loop {
        // 独立单连接池 + LISTEN，不占用业务 POOL_MANAGER 槽位。
        let db_config =
            match crate::auto_api_handlers::load_database_config(&main_pool, cfg.database_id).await
            {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(
                        database_id = cfg.database_id,
                        error = %e,
                        "工作流 NOTIFY listener 加载业务库配置失败，稍后重试"
                    );
                    tokio::time::sleep(RECONNECT_DELAY).await;
                    continue;
                }
            };

        let (_listen_pool, mut listener) =
            match crate::pool_manager::connect_dedicated_listener(&db_config).await {
                Ok(pair) => pair,
                Err(e) => {
                    tracing::warn!(
                        database_id = cfg.database_id,
                        channel = %cfg.channel,
                        error = %e,
                        "工作流 NOTIFY listener 建立连接失败，稍后重连"
                    );
                    tokio::time::sleep(RECONNECT_DELAY).await;
                    continue;
                }
            };

        if let Err(e) = listener.listen(&cfg.channel).await {
            tracing::warn!(
                database_id = cfg.database_id,
                channel = %cfg.channel,
                error = %e,
                "工作流 NOTIFY LISTEN 失败，稍后重连"
            );
            tokio::time::sleep(RECONNECT_DELAY).await;
            continue;
        }

        tracing::info!(
            database_id = cfg.database_id,
            channel = %cfg.channel,
            "工作流 NOTIFY listener 已就绪"
        );

        loop {
            match listener.recv().await {
                Ok(notification) => {
                    let payload_raw = notification.payload();
                    match build_trigger_data(cfg.database_id, &cfg.channel, payload_raw) {
                        Some(trigger_data) => {
                            trigger_matching_workflows(
                                &main_pool,
                                cfg.database_id,
                                &cfg.channel,
                                trigger_data,
                            )
                            .await;
                        }
                        None => tracing::warn!(
                            database_id = cfg.database_id,
                            channel = %cfg.channel,
                            "工作流 NOTIFY payload 非 JSON，跳过"
                        ),
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        database_id = cfg.database_id,
                        channel = %cfg.channel,
                        error = %e,
                        "工作流 NOTIFY listener 连接中断，稍后重连"
                    );
                    break;
                }
            }
        }

        tokio::time::sleep(RECONNECT_DELAY).await;
    }
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
