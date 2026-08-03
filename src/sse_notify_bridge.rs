//! PostgreSQL `NOTIFY` → SSE 监听桥
//!
//! 设计见 `docs/superpowers/specs/2026-06-01-growth-animation-sse-design.md`。
//!
//! 现有 `DataChangeEvent` 只在经 OneBase REST API 写库时产生，覆盖不到业务库内部
//! 触发器 / RPC 写入后发出的 `NOTIFY`。本模块按 `management.sse_notify_bridges` 的配置，
//! 对每个启用的 `(database_id, channel)` 持一条 `LISTEN`，收到通知后用 `topic_template`
//! （占位符取 NOTIFY payload 字段）算出 SSE topic，`publish_local` 推给本实例的连接。
//!
//! 多实例：PostgreSQL 把 `NOTIFY` 投给所有 `LISTEN` 会话，每个实例各自只向本地连接
//! 投递（`replicate = false`，不经 Redis 扇出），浏览器只连一个实例 → 恰好一次。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use dashmap::DashMap;
use serde::Serialize;
use serde_json::Value;
use sqlx::{PgPool, Row};
use tokio::task::JoinHandle;

use crate::sse::{SseEnvelope, SseHub};

const REFRESH_INTERVAL: Duration = Duration::from_secs(10);
const RECONNECT_DELAY: Duration = Duration::from_secs(5);

/// 一条监听桥配置。`(database_id, channel, topic_template, event_name)` 任一变化都视为
/// 新 listener（旧的 abort），从而无需在运行中热更模板。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct BridgeConfig {
    database_id: i32,
    channel: String,
    topic_template: String,
    event_name: String,
}

// ───── 指标 ────────────────────────────────────────────────

#[derive(Default)]
struct ListenerStat {
    connected: AtomicBool,
    received: AtomicU64,
    published: AtomicU64,
    parse_error: AtomicU64,
    reconnect: AtomicU64,
}

/// 监听桥运行指标（进程内、近似、重启清零，仅监控用）。作为 axum `Extension` 注入。
#[derive(Clone, Default)]
pub struct BridgeMetrics {
    inner: Arc<DashMap<(i32, String), Arc<ListenerStat>>>,
}

/// 单个 listener 的指标快照（供监控 API 序列化）。
#[derive(Debug, Clone, Serialize)]
pub struct ListenerStatSnapshot {
    pub database_id: i32,
    pub channel: String,
    pub connected: bool,
    pub received: u64,
    pub published: u64,
    pub parse_error: u64,
    pub reconnect: u64,
}

impl BridgeMetrics {
    pub fn new() -> Self {
        Self::default()
    }

    fn stat(&self, database_id: i32, channel: &str) -> Arc<ListenerStat> {
        self.inner
            .entry((database_id, channel.to_string()))
            .or_default()
            .clone()
    }

    pub fn snapshot(&self) -> Vec<ListenerStatSnapshot> {
        let mut out: Vec<ListenerStatSnapshot> = self
            .inner
            .iter()
            .map(|e| {
                let (db, ch) = e.key();
                let s = e.value();
                ListenerStatSnapshot {
                    database_id: *db,
                    channel: ch.clone(),
                    connected: s.connected.load(Ordering::Relaxed),
                    received: s.received.load(Ordering::Relaxed),
                    published: s.published.load(Ordering::Relaxed),
                    parse_error: s.parse_error.load(Ordering::Relaxed),
                    reconnect: s.reconnect.load(Ordering::Relaxed),
                }
            })
            .collect();
        out.sort_by(|a, b| (a.database_id, &a.channel).cmp(&(b.database_id, &b.channel)));
        out
    }
}

// ───── 启动 / 配置刷新 ─────────────────────────────────────

/// 启动监听桥管理任务：每 `REFRESH_INTERVAL` 读取启用配置，与正在运行的 listener 集合 diff，
/// 新增的起 listener、移除/停用的 abort。
pub fn start(main_pool: PgPool, hub: SseHub, metrics: BridgeMetrics) -> JoinHandle<()> {
    tokio::spawn(async move {
        tracing::info!(
            "SSE NOTIFY 监听桥管理任务已启动 (interval={:?})",
            REFRESH_INTERVAL
        );
        let mut running: HashMap<BridgeConfig, JoinHandle<()>> = HashMap::new();

        loop {
            match load_active_bridges(&main_pool).await {
                Ok(configs) => {
                    // 移除：正在跑但已不在配置里的。
                    running.retain(|cfg, handle| {
                        let keep = configs.contains(cfg);
                        if !keep {
                            tracing::info!(
                                "停止监听桥 (database_id={}, channel={})",
                                cfg.database_id,
                                cfg.channel
                            );
                            handle.abort();
                        }
                        keep
                    });
                    // 新增：配置里有但还没跑的。
                    for cfg in configs {
                        if !running.contains_key(&cfg) {
                            tracing::info!(
                                "启动监听桥 (database_id={}, channel={}, topic_template={})",
                                cfg.database_id,
                                cfg.channel,
                                cfg.topic_template
                            );
                            let handle = tokio::spawn(run_listener(
                                main_pool.clone(),
                                hub.clone(),
                                metrics.clone(),
                                cfg.clone(),
                            ));
                            running.insert(cfg, handle);
                        }
                    }
                }
                Err(e) => tracing::warn!("加载 SSE NOTIFY 监听桥配置失败（保留上次）: {}", e),
            }
            tokio::time::sleep(REFRESH_INTERVAL).await;
        }
    })
}

async fn load_active_bridges(pool: &PgPool) -> Result<Vec<BridgeConfig>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT database_id, channel, topic_template, event_name \
         FROM management.sse_notify_bridges WHERE is_active = true",
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| BridgeConfig {
            database_id: r.get("database_id"),
            channel: r.get("channel"),
            topic_template: r.get("topic_template"),
            event_name: r.get("event_name"),
        })
        .collect())
}

// ───── 单个 listener ───────────────────────────────────────

/// 对单个 `(database_id, channel)` 持续 `LISTEN`：断线 5s 重连，脏 payload 跳过不退出。
/// 被管理任务 `abort()` 时整体取消（释放业务库连接）。
async fn run_listener(main_pool: PgPool, hub: SseHub, metrics: BridgeMetrics, cfg: BridgeConfig) {
    let stat = metrics.stat(cfg.database_id, &cfg.channel);

    loop {
        // 独立单连接池 + LISTEN，不占用业务 POOL_MANAGER 槽位。
        let db_config =
            match crate::auto_api_handlers::load_database_config(&main_pool, cfg.database_id).await
            {
                Ok(c) => c,
                Err(e) => {
                    stat.connected.store(false, Ordering::Relaxed);
                    tracing::warn!(
                        "监听桥加载业务库配置失败 (database_id={}): {}，{:?} 后重试",
                        cfg.database_id,
                        e,
                        RECONNECT_DELAY
                    );
                    tokio::time::sleep(RECONNECT_DELAY).await;
                    continue;
                }
            };

        let (_listen_pool, mut listener) =
            match crate::pool_manager::connect_dedicated_listener(&db_config).await {
                Ok(pair) => pair,
                Err(e) => {
                    stat.connected.store(false, Ordering::Relaxed);
                    tracing::warn!(
                        "监听桥建立 LISTEN 连接失败 (database_id={}): {}，{:?} 后重连",
                        cfg.database_id,
                        e,
                        RECONNECT_DELAY
                    );
                    stat.reconnect.fetch_add(1, Ordering::Relaxed);
                    tokio::time::sleep(RECONNECT_DELAY).await;
                    continue;
                }
            };

        if let Err(e) = listener.listen(&cfg.channel).await {
            stat.connected.store(false, Ordering::Relaxed);
            tracing::warn!(
                "监听桥 LISTEN {} 失败 (database_id={}): {}，{:?} 后重连",
                cfg.channel,
                cfg.database_id,
                e,
                RECONNECT_DELAY
            );
            stat.reconnect.fetch_add(1, Ordering::Relaxed);
            tokio::time::sleep(RECONNECT_DELAY).await;
            continue;
        }

        stat.connected.store(true, Ordering::Relaxed);
        tracing::info!(
            "监听桥已就绪: LISTEN {} (database_id={})",
            cfg.channel,
            cfg.database_id
        );

        // 内层循环消费通知；断开则跳出到外层重连。
        loop {
            match listener.recv().await {
                Ok(notification) => {
                    stat.received.fetch_add(1, Ordering::Relaxed);
                    let payload_str = notification.payload();
                    match serde_json::from_str::<Value>(payload_str) {
                        Ok(payload) => match render_topic(&cfg.topic_template, &payload) {
                            Some(topic) => {
                                hub.publish_local(SseEnvelope {
                                    topic,
                                    event: cfg.event_name.clone(),
                                    data: payload,
                                    id: None,
                                    ts: Utc::now(),
                                    replicate: false,
                                });
                                stat.published.fetch_add(1, Ordering::Relaxed);
                            }
                            None => {
                                stat.parse_error.fetch_add(1, Ordering::Relaxed);
                                tracing::warn!(
                                    "监听桥 payload 缺占位符字段，跳过 (channel={}, template={})",
                                    cfg.channel,
                                    cfg.topic_template
                                );
                            }
                        },
                        Err(e) => {
                            stat.parse_error.fetch_add(1, Ordering::Relaxed);
                            tracing::warn!(
                                "监听桥 payload 非 JSON，跳过 (channel={}): {}",
                                cfg.channel,
                                e
                            );
                        }
                    }
                }
                Err(e) => {
                    stat.connected.store(false, Ordering::Relaxed);
                    stat.reconnect.fetch_add(1, Ordering::Relaxed);
                    tracing::warn!(
                        "监听桥连接中断 (database_id={}, channel={}): {}，{:?} 后重连",
                        cfg.database_id,
                        cfg.channel,
                        e,
                        RECONNECT_DELAY
                    );
                    break;
                }
            }
        }

        tokio::time::sleep(RECONNECT_DELAY).await;
    }
}

// ───── topic 模板渲染 ──────────────────────────────────────

/// 把 `topic_template` 里的 `{key}` 替换成 NOTIFY payload 对应字段的字符串值。
///
/// 任一被引用的 key 缺失、或值非标量（对象/数组/null）→ 返回 `None`（调用方跳过该条）。
fn render_topic(template: &str, payload: &Value) -> Option<String> {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;

    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let end = after.find('}')?;
        let key = &after[..end];
        let value = payload.get(key)?;
        let rendered = match value {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            _ => return None,
        };
        out.push_str(&rendered);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_topic_substitutes_payload_fields() {
        let payload = serde_json::json!({
            "wayUid": "adosp9d",
            "projectId": 1,
            "eventId": 123
        });
        assert_eq!(
            render_topic("way:{wayUid}:growth:{projectId}", &payload).as_deref(),
            Some("way:adosp9d:growth:1")
        );
    }

    #[test]
    fn render_topic_handles_no_placeholders() {
        let payload = serde_json::json!({});
        assert_eq!(
            render_topic("sys:broadcast", &payload).as_deref(),
            Some("sys:broadcast")
        );
    }

    #[test]
    fn render_topic_missing_key_returns_none() {
        let payload = serde_json::json!({ "wayUid": "x" });
        assert_eq!(
            render_topic("way:{wayUid}:growth:{projectId}", &payload),
            None
        );
    }

    #[test]
    fn render_topic_non_scalar_value_returns_none() {
        let payload = serde_json::json!({ "wayUid": { "nested": true } });
        assert_eq!(render_topic("way:{wayUid}:x", &payload), None);
    }

    #[test]
    fn render_topic_bool_and_number() {
        let payload = serde_json::json!({ "a": true, "b": 42 });
        assert_eq!(
            render_topic("{a}-{b}", &payload).as_deref(),
            Some("true-42")
        );
    }
}
