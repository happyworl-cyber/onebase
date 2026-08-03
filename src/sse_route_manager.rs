//! SSE 转发/路由规则执行器
//!
//! 在 `sse::start_data_change_bridge`（内置 `db:{id}:table:{schema}.{table}` 桥接）之上，
//! 提供**管理员可配置**的转发规则：当数据变更命中 `event_pattern` 时，把事件推到
//! `topic_template` 解析出的自定义 topic。规则存于 `management.sse_routes`，由本管理器
//! 缓存（每 10s 刷新）后在 `EventBus` 消费循环里匹配。
//!
//! 与 webhook 的两点差异：
//! - 复用 `webhook_manager::pattern_matches` 做 `schema.table.action` 匹配；
//! - **强制 `tenant_id` 相等**（webhook 当前不校验 tenant），避免跨租户误路由。

use std::sync::Arc;
use std::time::Duration;

use sqlx::{PgPool, Row};
use tokio::sync::RwLock;

use crate::events::{DataChangeEvent, EventBus};
use crate::sse::{SseEnvelope, SseHub};
use crate::webhook_manager::pattern_matches;

const REFRESH_INTERVAL: Duration = Duration::from_secs(10);

#[derive(Debug, Clone)]
struct SseRoute {
    #[allow(dead_code)]
    id: i32,
    tenant_id: i32,
    database_id: Option<i32>,
    event_pattern: String,
    topic_template: String,
    event_name: Option<String>,
}

/// 启动 SSE 路由规则执行器：返回缓存刷新任务与事件消费任务的 join handle。
pub fn start(
    pool: PgPool,
    hub: SseHub,
    event_bus: EventBus,
) -> (tokio::task::JoinHandle<()>, tokio::task::JoinHandle<()>) {
    let cache: Arc<RwLock<Vec<SseRoute>>> = Arc::new(RwLock::new(Vec::new()));

    // 任务①：定时刷新规则快照。
    let refresh_cache = cache.clone();
    let refresh_pool = pool.clone();
    let refresh = tokio::spawn(async move {
        tracing::info!(
            "SSE 路由规则缓存刷新任务已启动 (interval={:?})",
            REFRESH_INTERVAL
        );
        loop {
            match load_active_routes(&refresh_pool).await {
                Ok(routes) => *refresh_cache.write().await = routes,
                Err(e) => tracing::warn!("加载 SSE 路由规则失败（保留上次快照）: {}", e),
            }
            tokio::time::sleep(REFRESH_INTERVAL).await;
        }
    });

    // 任务②：消费 EventBus，按快照匹配并推送。
    let dispatch = tokio::spawn(async move {
        let mut rx = event_bus.subscribe();
        tracing::info!("SSE 路由规则分发任务已启动");
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let routes = cache.read().await;
                    for env in matching_envelopes(&routes, &event) {
                        hub.publish_local(env);
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!("SSE 路由分发丢失 {} 个事件", n);
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    tracing::info!("EventBus 关闭，SSE 路由分发退出");
                    break;
                }
            }
        }
    });

    (refresh, dispatch)
}

async fn load_active_routes(pool: &PgPool) -> Result<Vec<SseRoute>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, tenant_id, database_id, event_pattern, topic_template, event_name \
         FROM management.sse_routes WHERE is_active = true",
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| SseRoute {
            id: r.get("id"),
            tenant_id: r.get("tenant_id"),
            database_id: r.get("database_id"),
            event_pattern: r.get("event_pattern"),
            topic_template: r.get("topic_template"),
            event_name: r.get("event_name"),
        })
        .collect())
}

/// 计算某个事件命中的所有规则对应的 `SseEnvelope`。
fn matching_envelopes(routes: &[SseRoute], event: &DataChangeEvent) -> Vec<SseEnvelope> {
    let event_key = format!("{}.{}.{}", event.schema, event.table, event.action);
    let data = event
        .new_data
        .clone()
        .or_else(|| event.old_data.clone())
        .unwrap_or(serde_json::Value::Null);

    routes
        .iter()
        .filter(|r| route_matches(r, event, &event_key))
        .map(|r| SseEnvelope {
            topic: resolve_topic(&r.topic_template, event),
            event: r
                .event_name
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| event.action.to_string()),
            data: data.clone(),
            id: event.request_id.clone(),
            ts: event.timestamp,
            replicate: false,
        })
        .collect()
}

fn route_matches(route: &SseRoute, event: &DataChangeEvent, event_key: &str) -> bool {
    route.tenant_id == event.tenant_id
        && route.database_id.map_or(true, |db| db == event.database_id)
        && pattern_matches(&route.event_pattern, event_key)
}

/// 用事件字段替换 topic 模板里的占位符。
fn resolve_topic(template: &str, event: &DataChangeEvent) -> String {
    template
        .replace("{database_id}", &event.database_id.to_string())
        .replace("{schema}", &event.schema)
        .replace("{table}", &event.table)
        .replace("{action}", &event.action.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::ChangeAction;
    use chrono::Utc;

    fn event() -> DataChangeEvent {
        DataChangeEvent {
            tenant_id: 1,
            database_id: 2,
            schema: "public".to_string(),
            table: "orders".to_string(),
            action: ChangeAction::Insert,
            old_data: None,
            new_data: Some(serde_json::json!({"id": 9})),
            user_id: Some(3),
            timestamp: Utc::now(),
            request_id: Some("req-1".to_string()),
        }
    }

    fn route(
        database_id: Option<i32>,
        pattern: &str,
        template: &str,
        event_name: Option<&str>,
    ) -> SseRoute {
        SseRoute {
            id: 1,
            tenant_id: 1,
            database_id,
            event_pattern: pattern.to_string(),
            topic_template: template.to_string(),
            event_name: event_name.map(|s| s.to_string()),
        }
    }

    #[test]
    fn resolve_topic_substitutes_placeholders() {
        let t = resolve_topic("db:{database_id}:{schema}.{table}:{action}", &event());
        assert_eq!(t, "db:2:public.orders:INSERT");
    }

    #[test]
    fn route_matches_respects_tenant_db_and_pattern() {
        let ev = event();
        let key = format!("{}.{}.{}", ev.schema, ev.table, ev.action);

        // 命中：同租户、库匹配、pattern 命中
        assert!(route_matches(
            &route(Some(2), "public.orders.INSERT", "x", None),
            &ev,
            &key
        ));
        // 命中：database_id 为 NULL = 该租户所有库
        assert!(route_matches(
            &route(None, "public.*.INSERT", "x", None),
            &ev,
            &key
        ));
        // 不命中：库不同
        assert!(!route_matches(
            &route(Some(99), "*.*.*", "x", None),
            &ev,
            &key
        ));
        // 不命中：pattern 不匹配 action
        assert!(!route_matches(
            &route(Some(2), "public.orders.UPDATE", "x", None),
            &ev,
            &key
        ));
        // 不命中：租户不同
        let mut other = route(Some(2), "*.*.*", "x", None);
        other.tenant_id = 999;
        assert!(!route_matches(&other, &ev, &key));
    }

    #[test]
    fn matching_envelopes_builds_expected_message() {
        let routes = vec![
            route(
                Some(2),
                "public.orders.INSERT",
                "db:{database_id}:orders:{action}",
                Some("order_created"),
            ),
            route(None, "*.*.DELETE", "never", None), // 不命中 INSERT
        ];
        let envs = matching_envelopes(&routes, &event());
        assert_eq!(envs.len(), 1);
        assert_eq!(envs[0].topic, "db:2:orders:INSERT");
        assert_eq!(envs[0].event, "order_created");
        assert_eq!(envs[0].id.as_deref(), Some("req-1"));
        assert!(!envs[0].replicate);
        assert_eq!(envs[0].data, serde_json::json!({"id": 9}));
    }

    #[test]
    fn empty_event_name_falls_back_to_action() {
        let routes = vec![route(Some(2), "*.*.*", "db:{database_id}:x", Some(""))];
        let envs = matching_envelopes(&routes, &event());
        assert_eq!(envs[0].event, "INSERT");
    }
}
