use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::broadcast;

/// 数据变更事件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataChangeEvent {
    pub tenant_id: i32,
    pub database_id: i32,
    pub schema: String,
    pub table: String,
    pub action: ChangeAction,
    pub old_data: Option<Value>,
    pub new_data: Option<Value>,
    pub user_id: Option<i32>,
    pub timestamp: DateTime<Utc>,
    /// 触发本次事件的 HTTP 请求 `x-request-id`；后台消费者（webhook 分发、
    /// realtime 推送等）可以把这个 ID 带进自己的日志，跟前端报错串起来。
    /// 非 HTTP 触发（DB trigger / 后台脚本）下为 `None`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "UPPERCASE")]
pub enum ChangeAction {
    Insert,
    Update,
    Delete,
}

impl std::fmt::Display for ChangeAction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ChangeAction::Insert => write!(f, "INSERT"),
            ChangeAction::Update => write!(f, "UPDATE"),
            ChangeAction::Delete => write!(f, "DELETE"),
        }
    }
}

/// 进程内事件总线（基于 tokio broadcast）
#[derive(Clone)]
pub struct EventBus {
    sender: Arc<broadcast::Sender<DataChangeEvent>>,
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self {
            sender: Arc::new(sender),
        }
    }

    /// 发布事件
    pub fn publish(&self, event: DataChangeEvent) {
        let receivers = self.sender.receiver_count();
        if receivers > 0 {
            if let Err(e) = self.sender.send(event) {
                tracing::warn!("事件发布失败（无接收者）: {}", e);
            }
        } else {
            tracing::trace!("事件发布：当前无订阅者");
        }
    }

    /// 订阅事件流
    pub fn subscribe(&self) -> broadcast::Receiver<DataChangeEvent> {
        self.sender.subscribe()
    }

    #[allow(dead_code)]
    pub fn receiver_count(&self) -> usize {
        self.sender.receiver_count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_event_bus_publish_subscribe() {
        let bus = EventBus::new(16);
        let mut rx = bus.subscribe();

        let event = DataChangeEvent {
            tenant_id: 1,
            database_id: 10,
            schema: "public".to_string(),
            table: "posts".to_string(),
            action: ChangeAction::Insert,
            old_data: None,
            new_data: Some(serde_json::json!({"id": 1, "title": "hello"})),
            user_id: Some(42),
            timestamp: Utc::now(),
            request_id: None,
        };

        bus.publish(event.clone());

        let received = rx.recv().await.unwrap();
        assert_eq!(received.table, "posts");
        assert_eq!(received.action, ChangeAction::Insert);
        assert_eq!(received.user_id, Some(42));
    }

    #[test]
    fn test_change_action_display() {
        assert_eq!(ChangeAction::Insert.to_string(), "INSERT");
        assert_eq!(ChangeAction::Update.to_string(), "UPDATE");
        assert_eq!(ChangeAction::Delete.to_string(), "DELETE");
    }

    #[test]
    fn test_no_subscriber_no_panic() {
        let bus = EventBus::new(16);
        let event = DataChangeEvent {
            tenant_id: 1,
            database_id: 1,
            schema: "public".to_string(),
            table: "test".to_string(),
            action: ChangeAction::Delete,
            old_data: None,
            new_data: None,
            user_id: None,
            timestamp: Utc::now(),
            request_id: None,
        };
        bus.publish(event);
    }
}
