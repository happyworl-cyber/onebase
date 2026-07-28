use crate::events::{DataChangeEvent, EventBus};
use crate::redis_manager::RedisManager;

const CHANNEL: &str = "onebase:events";

/// 将本地 EventBus 的事件发布到 Redis Pub/Sub，使多实例共享
pub struct RedisPubSubBridge;

impl RedisPubSubBridge {
    /// 启动发布端：监听本地 EventBus，publish 到 Redis channel
    pub fn start_publisher(event_bus: EventBus, redis: RedisManager) -> tokio::task::JoinHandle<()> {
        let mut rx = event_bus.subscribe();

        tokio::spawn(async move {
            tracing::info!("Redis Pub/Sub 发布端已启动 (channel={})", CHANNEL);
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        if let Ok(json) = serde_json::to_string(&event) {
                            let mut conn = redis.conn();
                            let result: Result<(), _> = redis::cmd("PUBLISH")
                                .arg(CHANNEL)
                                .arg(&json)
                                .query_async(&mut conn)
                                .await;
                            if let Err(e) = result {
                                tracing::warn!("Redis PUBLISH 失败: {}", e);
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("Redis publisher 丢失 {} 个事件", n);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        tracing::info!("EventBus 关闭，Redis publisher 退出");
                        break;
                    }
                }
            }
        })
    }

    /// 启动订阅端：从 Redis channel 接收其他实例的事件，注入本地 EventBus
    pub fn start_subscriber(event_bus: EventBus, redis_url: String) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            tracing::info!("Redis Pub/Sub 订阅端启动中 (channel={})", CHANNEL);

            loop {
                match Self::run_subscriber(&event_bus, &redis_url).await {
                    Ok(()) => {
                        tracing::info!("Redis subscriber 正常退出");
                        break;
                    }
                    Err(e) => {
                        tracing::warn!("Redis subscriber 断开，5s 后重连: {}", e);
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    }
                }
            }
        })
    }

    async fn run_subscriber(event_bus: &EventBus, redis_url: &str) -> Result<(), String> {
        let client = redis::Client::open(redis_url).map_err(|e| e.to_string())?;
        let mut pubsub = client
            .get_async_pubsub()
            .await
            .map_err(|e| e.to_string())?;

        pubsub
            .subscribe(CHANNEL)
            .await
            .map_err(|e| e.to_string())?;

        tracing::info!("Redis subscriber 已连接并订阅 {}", CHANNEL);

        loop {
            let msg: redis::Msg = pubsub
                .on_message()
                .next()
                .await
                .ok_or_else(|| "Pub/Sub stream ended".to_string())?;

            let payload: String = msg.get_payload().map_err(|e| e.to_string())?;

            match serde_json::from_str::<DataChangeEvent>(&payload) {
                Ok(event) => {
                    event_bus.publish(event);
                }
                Err(e) => {
                    tracing::warn!("反序列化 Redis 事件失败: {}", e);
                }
            }
        }
    }
}

use futures::StreamExt;
