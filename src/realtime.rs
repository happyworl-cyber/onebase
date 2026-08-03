use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query,
    },
    response::Response,
};
use dashmap::DashMap;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::broadcast;

use crate::auth::verify_token;
use crate::events::{DataChangeEvent, EventBus};

/// WebSocket 查询参数
#[derive(Debug, Deserialize)]
pub struct WsQuery {
    pub token: Option<String>,
}

/// 客户端发送的消息
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ClientMessage {
    #[serde(rename = "subscribe")]
    Subscribe { channel: String },
    #[serde(rename = "unsubscribe")]
    Unsubscribe { channel: String },
}

/// 服务端推送的消息
#[derive(Debug, Serialize)]
struct ServerMessage {
    event: String,
    channel: String,
    data: serde_json::Value,
    timestamp: String,
}

/// 实时推送管理器
#[derive(Clone)]
pub struct RealtimeManager {
    event_bus: EventBus,
    connections: Arc<DashMap<String, usize>>,
}

impl RealtimeManager {
    pub fn new(event_bus: EventBus) -> Self {
        Self {
            event_bus,
            connections: Arc::new(DashMap::new()),
        }
    }

    #[allow(dead_code)]
    pub fn connection_count(&self) -> usize {
        self.connections.len()
    }

    /// 启动后台事件分发
    pub fn start_broadcaster(&self) -> broadcast::Sender<DataChangeEvent> {
        let (tx, _) = broadcast::channel::<DataChangeEvent>(1024);
        let tx_clone = tx.clone();
        let mut rx = self.event_bus.subscribe();

        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        let _ = tx_clone.send(event);
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("Realtime broadcaster 丢失 {} 个事件", n);
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });

        tx
    }
}

/// GET /realtime/ws?token=xxx — WebSocket 升级
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(query): Query<WsQuery>,
    axum::extract::Extension(manager): axum::extract::Extension<RealtimeManager>,
    axum::extract::Extension(broadcaster): axum::extract::Extension<
        broadcast::Sender<DataChangeEvent>,
    >,
) -> Response {
    let user_id = query
        .token
        .as_deref()
        .and_then(|t| verify_token(t).ok())
        .map(|c| c.sub);

    ws.on_upgrade(move |socket| handle_ws(socket, user_id, manager, broadcaster))
}

async fn handle_ws(
    socket: WebSocket,
    user_id: Option<i32>,
    manager: RealtimeManager,
    broadcaster: broadcast::Sender<DataChangeEvent>,
) {
    let conn_id = uuid::Uuid::new_v4().to_string();
    manager.connections.insert(conn_id.clone(), 0);
    tracing::info!("WebSocket 连接建立: {} (user={:?})", conn_id, user_id);

    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut event_rx = broadcaster.subscribe();

    // 本连接订阅的 channels（如 "public.posts"）
    let subscriptions: Arc<DashMap<String, ()>> = Arc::new(DashMap::new());
    let subs_write = subscriptions.clone();
    let subs_read = subscriptions.clone();

    // 读取客户端消息的任务
    let read_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_rx.next().await {
            if let Message::Text(text) = msg {
                if let Ok(client_msg) = serde_json::from_str::<ClientMessage>(&text) {
                    match client_msg {
                        ClientMessage::Subscribe { channel } => {
                            tracing::debug!("订阅 channel: {}", channel);
                            subs_write.insert(channel, ());
                        }
                        ClientMessage::Unsubscribe { channel } => {
                            tracing::debug!("取消订阅 channel: {}", channel);
                            subs_write.remove(&channel);
                        }
                    }
                }
            }
        }
    });

    // 推送事件的任务
    let write_task = tokio::spawn(async move {
        loop {
            match event_rx.recv().await {
                Ok(event) => {
                    let channel = format!("{}.{}", event.schema, event.table);

                    let should_send = subs_read.contains_key(&channel)
                        || subs_read.contains_key(&format!("{}.*", event.schema))
                        || subs_read.contains_key("*.*");

                    if !should_send {
                        continue;
                    }

                    let msg = ServerMessage {
                        event: event.action.to_string(),
                        channel,
                        data: event
                            .new_data
                            .or(event.old_data)
                            .unwrap_or(serde_json::Value::Null),
                        timestamp: event.timestamp.to_rfc3339(),
                    };

                    if let Ok(json) = serde_json::to_string(&msg) {
                        if ws_tx.send(Message::Text(json.into())).await.is_err() {
                            break;
                        }
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    tokio::select! {
        _ = read_task => {},
        _ = write_task => {},
    }

    manager.connections.remove(&conn_id);
    tracing::info!("WebSocket 连接关闭: {}", conn_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_client_message_parse() {
        let msg = r#"{"type":"subscribe","channel":"public.posts"}"#;
        let parsed: ClientMessage = serde_json::from_str(msg).unwrap();
        match parsed {
            ClientMessage::Subscribe { channel } => assert_eq!(channel, "public.posts"),
            _ => panic!("Expected subscribe"),
        }

        let msg2 = r#"{"type":"unsubscribe","channel":"public.comments"}"#;
        let parsed2: ClientMessage = serde_json::from_str(msg2).unwrap();
        match parsed2 {
            ClientMessage::Unsubscribe { channel } => assert_eq!(channel, "public.comments"),
            _ => panic!("Expected unsubscribe"),
        }
    }

    #[test]
    fn test_server_message_serialize() {
        let msg = ServerMessage {
            event: "INSERT".to_string(),
            channel: "public.posts".to_string(),
            data: serde_json::json!({"id": 1}),
            timestamp: "2024-01-01T00:00:00Z".to_string(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("INSERT"));
        assert!(json.contains("public.posts"));
    }
}
