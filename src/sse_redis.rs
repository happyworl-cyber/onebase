//! SSE 通用消息的跨实例 Redis 桥接
//!
//! 与 `redis_pubsub.rs`（桥接 `EventBus` 的 `DataChangeEvent`）同模式，但走独立 channel
//! `onebase:sse`，只负责 `SseHub` 里的「通用消息」（`SseEnvelope::replicate == true`）。
//!
//! 防回环 / 防重复的两条不变式：
//! 1. 发布端只 PUBLISH `replicate == true` 的信封——数据变更桥接产生的信封 `replicate`
//!    为 `false`，不会被扇出（它们经 `EventBus` 自己的 Redis 桥已跨实例，每个实例本地派生）。
//! 2. 订阅端收到后用 `publish_local`（强制 `replicate = false`）回注，因此不会被本实例的
//!    发布端再次 PUBLISH，避免实例间无限回环。

use futures::StreamExt;

use crate::redis_manager::RedisManager;
use crate::sse::{SseEnvelope, SseHub};

const CHANNEL: &str = "onebase:sse";

pub struct SseRedisBridge;

impl SseRedisBridge {
    /// 发布端：监听 `SseHub`，把 `replicate == true` 的信封 PUBLISH 到 Redis channel。
    pub fn start_publisher(hub: SseHub, redis: RedisManager) -> tokio::task::JoinHandle<()> {
        let mut rx = hub.subscribe();
        tokio::spawn(async move {
            tracing::info!("SSE Redis 发布端已启动 (channel={})", CHANNEL);
            loop {
                match rx.recv().await {
                    Ok(env) => {
                        if !env.replicate {
                            continue;
                        }
                        if let Ok(json) = serde_json::to_string(&env) {
                            let mut conn = redis.conn();
                            let result: std::result::Result<(), _> = redis::cmd("PUBLISH")
                                .arg(CHANNEL)
                                .arg(&json)
                                .query_async(&mut conn)
                                .await;
                            if let Err(e) = result {
                                tracing::warn!("SSE Redis PUBLISH 失败: {}", e);
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("SSE Redis 发布端丢失 {} 条消息", n);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        tracing::info!("SseHub 关闭，SSE Redis 发布端退出");
                        break;
                    }
                }
            }
        })
    }

    /// 订阅端：从 Redis channel 接收其它实例的信封，用 `publish_local` 回注本地 hub。
    pub fn start_subscriber(hub: SseHub, redis_url: String) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            tracing::info!("SSE Redis 订阅端启动中 (channel={})", CHANNEL);
            loop {
                match Self::run_subscriber(&hub, &redis_url).await {
                    Ok(()) => {
                        tracing::info!("SSE Redis 订阅端正常退出");
                        break;
                    }
                    Err(e) => {
                        tracing::warn!("SSE Redis 订阅端断开，5s 后重连: {}", e);
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    }
                }
            }
        })
    }

    async fn run_subscriber(hub: &SseHub, redis_url: &str) -> std::result::Result<(), String> {
        let client = redis::Client::open(redis_url).map_err(|e| e.to_string())?;
        let mut pubsub = client.get_async_pubsub().await.map_err(|e| e.to_string())?;
        pubsub.subscribe(CHANNEL).await.map_err(|e| e.to_string())?;
        tracing::info!("SSE Redis 订阅端已连接并订阅 {}", CHANNEL);

        loop {
            let msg: redis::Msg = pubsub
                .on_message()
                .next()
                .await
                .ok_or_else(|| "Pub/Sub stream ended".to_string())?;
            let payload: String = msg.get_payload().map_err(|e| e.to_string())?;

            match serde_json::from_str::<SseEnvelope>(&payload) {
                // publish_local 会强制 replicate=false，故不会被本实例发布端再次扇出。
                Ok(env) => hub.publish_local(env),
                Err(e) => tracing::warn!("反序列化 SSE Redis 信封失败: {}", e),
            }
        }
    }
}
