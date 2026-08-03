//! 通用 Server-Sent Events（SSE）推送能力
//!
//! 在现有 `EventBus` / WebSocket / Redis 桥接之上，提供一条**通用的服务端→客户端单向
//! 推送通道**。与 `realtime.rs`（WebSocket，专推 `DataChangeEvent`）不同，这里是 topic
//! 级 pub/sub，业务侧可以推任意 JSON 消息（任务/工作流进度、通知、日志……），也通过
//! 「数据变更桥接」自动把 `DataChangeEvent` 映射成 topic 推出去。
//!
//! 设计要点见 `docs/superpowers/specs/2026-06-01-sse-capability-design.md`：
//!
//! - **Topic 作用域授权**（fail-closed）：
//!     - `user:{uid}:*` —— 仅 `uid == claims.sub`；
//!     - `db:{dbId}:*`  —— 用户是该 db 所属租户的 active 成员（任意角色）；
//!     - `sys:*`        —— 仅平台超管；
//!     - 其它前缀一律拒绝。
//! - **三条 publish 入口**：内部 `SseHub::publish`、HTTP `POST /api/sse/publish`、
//!   以及订阅 `EventBus` 的数据变更桥接。
//! - **多实例**：`replicate` 标志区分「需经 Redis 扇出的通用消息」与「本地派生的数据变更」，
//!   避免回环 / 重复投递（见 `sse_redis` 与 `start_data_change_bridge`）。

use std::collections::{HashMap, HashSet, VecDeque};
use std::convert::Infallible;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Extension, Path, Query, State},
    http::{header, HeaderMap, HeaderValue},
    response::{sse::{Event, KeepAlive, Sse}, IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use futures::stream::Stream;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgPool, Row};
use tokio::sync::broadcast;
use tokio::time::{interval_at, Instant, MissedTickBehavior};

use crate::auth::{verify_token, Claims};
use crate::error::{AppError, Result};
use crate::events::{DataChangeEvent, EventBus};

/// SSE 推送的统一信封。
///
/// `replicate` 决定这条消息是否需要经 Redis 跨实例扇出：
/// - 内部 `publish` / HTTP publish 产生的通用消息 → `true`（其它实例的订阅者也要收到）；
/// - 数据变更桥接产生的消息 → `false`（`EventBus` 本身已被 `redis_pubsub` 跨实例桥接，
///   每个实例都会本地派生一份，再扇出就重复了）。
///
/// 该字段 `#[serde(skip)]`：跨 Redis 传输时不序列化，订阅端回注时一律按 `false` 处理，
/// 从而不会被本实例的 Redis 发布端再次 PUBLISH（防回环）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SseEnvelope {
    pub topic: String,
    pub event: String,
    pub data: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub ts: DateTime<Utc>,
    #[serde(skip)]
    pub replicate: bool,
}

/// 单条 SSE 连接的元信息（仅进程内、用于监控）。
///
/// `identity` 仅供服务端日志/排障，不对外暴露（监控页只按端点聚合计数）。
#[derive(Debug, Clone)]
#[allow(dead_code)] // identity / connected_at 为监控/日志保留字段
pub struct ConnMeta {
    /// 连接类型："sse"（通用 /sse）或 "public"（/events/:slug 对外端点）。
    pub kind: &'static str,
    /// 对外端点连接所属的端点 slug；通用 /sse 连接为 None。
    pub endpoint_slug: Option<String>,
    /// 对外端点连接的身份（来自可信头）；通用 /sse 连接为 None。
    pub identity: Option<String>,
    pub connected_at: DateTime<Utc>,
}

/// 每个 topic 在回放缓冲区里保留的最大消息条数。
const REPLAY_MAX_PER_TOPIC: usize = 64;
/// 回放缓冲区里消息的存活时长（秒）；超过则不再回放并被清理。
const REPLAY_TTL_SECS: i64 = 300;

/// 通用 SSE 总线：进程内 `tokio::broadcast`，作为 axum `Extension` 注入。
#[derive(Clone)]
pub struct SseHub {
    sender: Arc<broadcast::Sender<SseEnvelope>>,
    connections: Arc<DashMap<String, ConnMeta>>,
    /// 已成功投递给客户端的消息累计数（近似、重启清零，仅监控用）。
    pushes: Arc<AtomicU64>,
    /// 按 topic 分组的最近消息环形缓冲，用于断线重连时按 `Last-Event-ID` 回放。
    ///
    /// 关键点：所有 `send`（含本地 publish、Redis 回注的 `publish_local`）都会写这里，
    /// 且每条消息在 `send` 里被赋予稳定的 `id` 后再扇出，因此各实例缓冲的内容与 id 收敛
    /// 一致——客户端重连到任意实例都能从其缓冲里按 id 续传，不依赖落到同一实例。
    recent: Arc<DashMap<String, VecDeque<SseEnvelope>>>,
}

impl SseHub {
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self {
            sender: Arc::new(sender),
            connections: Arc::new(DashMap::new()),
            pushes: Arc::new(AtomicU64::new(0)),
            recent: Arc::new(DashMap::new()),
        }
    }

    /// 发布一条「通用」消息：会被 Redis 桥接扇出到其它实例。
    pub fn publish(
        &self,
        topic: String,
        event: String,
        data: serde_json::Value,
        id: Option<String>,
    ) {
        self.send(SseEnvelope {
            topic,
            event,
            data,
            id,
            ts: Utc::now(),
            replicate: true,
        });
    }

    /// 发布一条「本地」消息：不经 Redis 扇出。
    ///
    /// 用于数据变更桥接、以及 Redis 订阅端回注（避免回环）。
    pub fn publish_local(&self, mut env: SseEnvelope) {
        env.replicate = false;
        self.send(env);
    }

    fn send(&self, mut env: SseEnvelope) {
        // 统一在此处补 id：保证每条消息都带稳定 id，浏览器才能在重连时回传
        // `Last-Event-ID`。在扇出前赋值，使本地缓冲、Redis 扇出到其它实例的副本共享同一 id。
        if env.id.is_none() {
            env.id = Some(uuid::Uuid::new_v4().to_string());
        }
        // 无论当前有没有订阅者都先写回放缓冲——这正是修复「重连窗口里发出的消息
        // 因无人在线被直接丢弃」的关键。
        self.buffer(&env);
        // 没有订阅者时 broadcast::send 会返回 Err，这是正常情况，不记 warn。
        if self.sender.receiver_count() > 0 {
            let _ = self.sender.send(env);
        }
    }

    /// 把消息追加进对应 topic 的回放缓冲，按条数上限裁剪。
    fn buffer(&self, env: &SseEnvelope) {
        let mut q = self.recent.entry(env.topic.clone()).or_default();
        q.push_back(env.clone());
        while q.len() > REPLAY_MAX_PER_TOPIC {
            q.pop_front();
        }
    }

    /// 回放：返回订阅 `subs`（可含末尾 `*` 通配）匹配、且发生在 `last_id` 之后、仍在 TTL 内
    /// 的历史消息，按时间升序。`last_id` 不在缓冲（太旧被清理 / 不属于这些 topic）时返回空，
    /// 避免重放过多或重复。
    pub fn replay_since(&self, subs: &[String], last_id: &str) -> Vec<SseEnvelope> {
        let cutoff = Utc::now() - chrono::Duration::seconds(REPLAY_TTL_SECS);
        let mut matched: Vec<SseEnvelope> = self
            .recent
            .iter()
            .filter(|e| topic_matches(subs, e.key()))
            .flat_map(|e| e.value().iter().cloned().collect::<Vec<_>>())
            .filter(|env| env.ts >= cutoff)
            .collect();
        matched.sort_by_key(|e| e.ts);
        match matched.iter().position(|e| e.id.as_deref() == Some(last_id)) {
            Some(pos) => matched.split_off(pos + 1),
            None => Vec::new(),
        }
    }

    /// 清理回放缓冲里过期（超过 TTL）的消息，并移除变空的 topic，避免无界增长。
    fn sweep_replay(&self) {
        let cutoff = Utc::now() - chrono::Duration::seconds(REPLAY_TTL_SECS);
        self.recent.retain(|_topic, q| {
            while q.front().map(|e| e.ts < cutoff).unwrap_or(false) {
                q.pop_front();
            }
            !q.is_empty()
        });
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SseEnvelope> {
        self.sender.subscribe()
    }

    #[allow(dead_code)]
    pub fn connection_count(&self) -> usize {
        self.connections.len()
    }

    /// 当前所有连接的元信息快照（监控用）。
    pub fn connection_metas(&self) -> Vec<ConnMeta> {
        self.connections.iter().map(|e| e.value().clone()).collect()
    }

    /// 累计成功投递的消息条数（监控用）。
    pub fn pushes_total(&self) -> u64 {
        self.pushes.load(Ordering::Relaxed)
    }

    fn record_push(&self) {
        self.pushes.fetch_add(1, Ordering::Relaxed);
    }
}

/// 周期性清理回放缓冲里过期的消息（每 60s 一次）。
pub fn spawn_replay_sweeper(hub: SseHub) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            hub.sweep_replay();
        }
    })
}

/// 让 lib 侧模块（lua_builtins / workflow_engine）经全局句柄推送 SSE，无需依赖本 binary 模块。
/// 走「通用」入口（`replicate = true`），跨实例扇出。
impl crate::sse_publisher::SsePublisher for SseHub {
    fn publish(&self, topic: String, event: String, data: serde_json::Value) {
        SseHub::publish(self, topic, event, data, None);
    }
}

// ───── 授权 ────────────────────────────────────────────────

/// 判断 `claims` 是否有权订阅 / 发布 `topic`。
///
/// 容忍订阅端的末尾通配符（`db:2:*`）：剥掉尾部 `*` 后按作用域前缀解析。
pub async fn authorize_topic(pool: &PgPool, claims: &Claims, topic: &str) -> bool {
    if claims.is_superadmin {
        return true;
    }
    let topic = topic.strip_suffix('*').unwrap_or(topic);
    let mut parts = topic.split(':');
    match parts.next() {
        Some("user") => parts
            .next()
            .and_then(|s| s.parse::<i32>().ok())
            .map(|uid| uid == claims.sub)
            .unwrap_or(false),
        Some("db") => match parts.next().and_then(|s| s.parse::<i32>().ok()) {
            Some(db_id) => user_can_access_database(pool, claims, db_id).await,
            None => false,
        },
        // `way:*` 是成长动画专用端点的定向 topic，身份来自网关注入的 `X-Way-UID`
        // （JWT 里没有 way_uid）。故通用 JWT 路径上非超管一律拒绝（fail-closed），
        // 与下面的兜底等价，这里显式列出以示意图。
        Some("way") => false,
        // `sys:*` 仅超管，前面已短路；非超管到这里一律拒绝。
        _ => false,
    }
}

/// 非超管用户能否访问某个 database：必须是该 db 所属租户的 active 成员（任意角色）。
///
/// 复用 `permissions.rs` 里 `tenant_databases` / `user_tenants` 的查询口径。
async fn user_can_access_database(pool: &PgPool, claims: &Claims, database_id: i32) -> bool {
    let tenant_id: Option<i32> = sqlx::query_scalar(
        "SELECT tenant_id FROM management.tenant_databases WHERE id = $1 AND is_active = true",
    )
    .bind(database_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();

    let tenant_id = match tenant_id {
        Some(t) => t,
        None => return false,
    };

    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM management.user_tenants \
         WHERE user_id = $1 AND tenant_id = $2 AND is_active = true)",
    )
    .bind(claims.sub)
    .bind(tenant_id)
    .fetch_one(pool)
    .await
    .unwrap_or(false)
}

/// 订阅 topic（可能含末尾 `*` 通配）是否匹配实际推送 topic。
fn topic_matches(subscriptions: &[String], topic: &str) -> bool {
    subscriptions.iter().any(|sub| match sub.strip_suffix('*') {
        Some(prefix) => topic.starts_with(prefix),
        None => sub == topic,
    })
}

/// 解析 topic 模板里按顺序出现的占位符名（不含花括号），如 ["identity", "query.projectId"]。
/// 文本里没有 `{` 就返回空。遇到未闭合 `{` 视为普通文本忽略。
fn template_placeholders(template: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        let after = &rest[start + 1..];
        match after.find('}') {
            Some(end) => {
                names.push(after[..end].to_string());
                rest = &after[end + 1..];
            }
            None => break,
        }
    }
    names
}

/// 校验对外端点的 topic 模板：
/// - 必含 `{identity}`；
/// - 占位符只允许 `{identity}` 和 `{query.<param>}`；
/// - `{identity}` 必须出现在所有 `{query.X}` 之前（否则缺省 query 截断会丢掉 identity 而越权）。
pub fn validate_topic_template(template: &str) -> std::result::Result<(), String> {
    let mut seen_identity = false;
    for name in template_placeholders(template) {
        if name == "identity" {
            seen_identity = true;
        } else if let Some(param) = name.strip_prefix("query.") {
            if param.is_empty() {
                return Err("占位符 {query.} 缺少参数名".to_string());
            }
            if !seen_identity {
                return Err("{identity} 必须出现在所有 {query.X} 之前".to_string());
            }
        } else {
            return Err(format!("不支持的占位符 {{{}}}", name));
        }
    }
    if !seen_identity {
        return Err("topic 模板必须包含 {identity}".to_string());
    }
    Ok(())
}

/// 渲染订阅 topic：
/// - `{identity}` → 身份头值；
/// - `{query.X}` → query 参数 X 的值；缺省或为空字符串时在该位置截断、追加 `*` 并停止（末尾通配）。
/// 调用前模板应已通过 `validate_topic_template`（保证 `{identity}` 在 query 之前）。
/// `identity` 来自网关注入的可信头，调用方负责保证其可信；本函数不对其做转义
/// （信任边界在网关）。
pub fn render_subscription_topic(
    template: &str,
    identity: &str,
    query: &HashMap<String, String>,
) -> String {
    let mut out = String::with_capacity(template.len() + identity.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let end = match after.find('}') {
            Some(e) => e,
            None => {
                out.push('{');
                rest = after;
                continue;
            }
        };
        let name = &after[..end];
        rest = &after[end + 1..];
        if name == "identity" {
            out.push_str(identity);
        } else if let Some(param) = name.strip_prefix("query.") {
            match query.get(param) {
                Some(v) if !v.is_empty() => out.push_str(v),
                _ => {
                    out.push('*');
                    return out;
                }
            }
        } else {
            out.push('{');
            out.push_str(name);
            out.push('}');
        }
    }
    out.push_str(rest);
    out
}

fn identity_query_keys(identity_header: &str) -> Vec<String> {
    let mut keys = vec!["identity".to_string(), identity_header.to_string()];
    let lower = identity_header.to_ascii_lowercase();
    if lower != identity_header {
        keys.push(lower.clone());
    }

    let stripped = lower.strip_prefix("x-").unwrap_or(&lower);
    let parts: Vec<&str> = stripped
        .split(|c| c == '-' || c == '_')
        .filter(|s| !s.is_empty())
        .collect();

    if !parts.is_empty() {
        keys.push(parts.join("_"));
        let mut camel = String::new();
        for (idx, part) in parts.iter().enumerate() {
            if idx == 0 {
                camel.push_str(part);
            } else {
                let mut chars = part.chars();
                if let Some(first) = chars.next() {
                    camel.push(first.to_ascii_uppercase());
                    camel.push_str(chars.as_str());
                }
            }
        }
        keys.push(camel);
    }

    keys.dedup();
    keys
}

fn public_identity(
    headers: &HeaderMap,
    query: &HashMap<String, String>,
    identity_header: &str,
) -> Option<String> {
    if let Some(identity) = headers
        .get(identity_header)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(identity.to_string());
    }

    identity_query_keys(identity_header)
        .into_iter()
        .filter_map(|key| query.get(&key))
        .map(|s| s.trim())
        .find(|s| !s.is_empty())
        .map(|s| s.to_string())
}

// ───── SSE 端点 ────────────────────────────────────────────

/// 为 SSE 响应附加反缓冲 / 反压缩头，避免 nginx 等反向代理 gzip 或缓冲导致
/// 浏览器 EventSource 长时间 pending 却收不到事件（curl 无 Accept-Encoding 时正常）。
fn sse_response<S>(sse: Sse<S>) -> Response
where
    S: Stream<Item = std::result::Result<Event, Infallible>> + Send + 'static,
{
    let mut resp = sse.into_response();
    let headers = resp.headers_mut();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-transform"),
    );
    headers.insert(
        header::CONNECTION,
        HeaderValue::from_static("keep-alive"),
    );
    headers.insert(
        header::HeaderName::from_static("x-accel-buffering"),
        HeaderValue::from_static("no"),
    );
    resp
}

/// 心跳事件 payload（对齐旧版 Go：`{"type":"heartbeat","timestamp":<unix秒>}`）。
fn heartbeat_payload() -> serde_json::Value {
    serde_json::json!({
        "type": "heartbeat",
        "timestamp": Utc::now().timestamp(),
    })
}

/// 优雅断开事件 payload（对齐旧版 Go 的 `graceful_close`）。
fn graceful_close_payload(close_after: Duration) -> serde_json::Value {
    serde_json::json!({
        "type": "graceful_close",
        "reason": "connection_ttl_reached",
        "close_after_seconds": close_after.as_secs(),
        "timestamp": Utc::now().timestamp(),
    })
}

/// 具名心跳事件（对齐旧版 Go `event: heartbeat`）。
///
/// axum `KeepAlive` 只会发注释型 `:ping`，会被浏览器 `EventSource` 静默丢弃；
/// 这里额外发一条具名事件，客户端 `addEventListener("heartbeat", ...)` 才能收到。
fn heartbeat_event() -> Event {
    Event::default()
        .event("heartbeat")
        .json_data(heartbeat_payload())
        .unwrap_or_default()
}

/// 优雅断开事件（对齐旧版 Go `event: exit` 的 `graceful_close` payload）。
fn graceful_close_event(close_after: Duration) -> Event {
    Event::default()
        .event("exit")
        .json_data(graceful_close_payload(close_after))
        .unwrap_or_default()
}

/// 实时消息流构造器：把 broadcast 订阅、具名心跳、25 分钟优雅断开合并到同一个
/// `unfold` 循环里（等价旧版 Go 的 `select`）。
///
/// - `fixed_event_name = None`：使用信封自带的 `env.event`（`/sse` 端点）；
/// - `fixed_event_name = Some(name)`：所有消息统一命名（`/events/:slug` 端点）。
/// - `heartbeat_period`：具名心跳间隔；`close_after = None` 表示不启用优雅断开。
fn live_stream(
    rx: broadcast::Receiver<SseEnvelope>,
    subs: Vec<String>,
    guard: ConnGuard,
    replayed_ids: HashSet<String>,
    fixed_event_name: Option<String>,
    heartbeat_period: Duration,
    close_after: Option<Duration>,
) -> impl Stream<Item = std::result::Result<Event, Infallible>> + Send + 'static {
    let mut heartbeat = interval_at(Instant::now() + heartbeat_period, heartbeat_period);
    // 落后时直接跳到下一个整点，不补发堆积的心跳。
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let close_deadline = close_after.map(|d| Instant::now() + d);

    futures::stream::unfold(
        (rx, subs, guard, replayed_ids, fixed_event_name, heartbeat, close_deadline, close_after, false),
        |(mut rx, subs, guard, mut replayed_ids, fixed_event_name, mut heartbeat, close_deadline, close_after, closing)| async move {
            // 上一轮已发出 exit 事件，本轮结束流 → ConnGuard drop → 摘除连接。
            if closing {
                return None;
            }
            loop {
                tokio::select! {
                    _ = heartbeat.tick() => {
                        return Some((
                            Ok(heartbeat_event()),
                            (rx, subs, guard, replayed_ids, fixed_event_name, heartbeat, close_deadline, close_after, false),
                        ));
                    }
                    _ = async { tokio::time::sleep_until(close_deadline.unwrap()).await }, if close_deadline.is_some() => {
                        let d = close_after.unwrap_or_default();
                        tracing::info!(
                            "SSE 连接到达 TTL，发送 exit 并优雅断开 (close_after={}s)",
                            d.as_secs()
                        );
                        return Some((
                            Ok(graceful_close_event(d)),
                            (rx, subs, guard, replayed_ids, fixed_event_name, heartbeat, close_deadline, close_after, true),
                        ));
                    }
                    r = rx.recv() => {
                        match r {
                            Ok(env) => {
                                if !topic_matches(&subs, &env.topic) {
                                    continue;
                                }
                                // 与回放重叠的消息去重（subscribe 与读取回放之间的窗口）。
                                if let Some(id) = &env.id {
                                    if replayed_ids.remove(id) {
                                        continue;
                                    }
                                }
                                let name = fixed_event_name.clone().unwrap_or_else(|| env.event.clone());
                                let mut event = Event::default().event(name);
                                if let Some(id) = &env.id {
                                    event = event.id(id.clone());
                                }
                                match event.json_data(&env.data) {
                                    Ok(event) => {
                                        guard.hub.record_push();
                                        return Some((
                                            Ok(event),
                                            (rx, subs, guard, replayed_ids, fixed_event_name, heartbeat, close_deadline, close_after, false),
                                        ));
                                    }
                                    Err(e) => {
                                        tracing::warn!("SSE 序列化消息失败，跳过: {}", e);
                                        continue;
                                    }
                                }
                            }
                            Err(broadcast::error::RecvError::Lagged(n)) => {
                                tracing::warn!("SSE 连接滞后，丢失 {} 条消息", n);
                                continue;
                            }
                            Err(broadcast::error::RecvError::Closed) => return None,
                        }
                    }
                }
            }
        },
    )
}

#[derive(Debug, Deserialize)]
pub struct SseQuery {
    pub token: Option<String>,
    /// 逗号分隔的订阅 topic 列表，如 `db:2:table:public.posts,user:5:notify`。
    pub topics: Option<String>,
}

/// `GET /sse?token=<jwt>&topics=a,b,c`
///
/// 不挂 `auth_middleware`——浏览器 `EventSource` 无法设置自定义 header，沿用
/// `/realtime/ws` 的 query-token 鉴权方案。
pub async fn sse_handler(
    State(pool): State<PgPool>,
    Extension(hub): Extension<SseHub>,
    headers: HeaderMap,
    Query(query): Query<SseQuery>,
) -> Result<Response> {
    let token = query
        .token
        .filter(|t| !t.is_empty())
        .ok_or_else(|| AppError::Unauthorized("缺少 token".to_string()))?;
    let claims = verify_token(&token)?;

    let topics: Vec<String> = query
        .topics
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    if topics.is_empty() {
        return Err(AppError::InvalidQuery(
            "必须通过 ?topics= 指定至少一个订阅 topic".to_string(),
        ));
    }

    for t in &topics {
        if !authorize_topic(&pool, &claims, t).await {
            return Err(AppError::Forbidden(format!("无权订阅 topic: {}", t)));
        }
    }

    let conn_id = uuid::Uuid::new_v4().to_string();
    hub.connections.insert(
        conn_id.clone(),
        ConnMeta {
            kind: "sse",
            endpoint_slug: None,
            identity: None,
            connected_at: Utc::now(),
        },
    );
    tracing::info!(
        "SSE 连接建立: {} (user={}, topics={:?})",
        conn_id,
        claims.sub,
        topics
    );

    // 断线重连：浏览器自动带上 Last-Event-ID，用它回放缓冲区里这之后的历史消息。
    let last_event_id = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    // 先 subscribe 再取回放快照：subscribe 之后到读取回放之间到达的消息会进 rx 缓冲，
    // 与回放集合用 dedup 去重，确保既不漏也不重。
    let rx = hub.subscribe();
    let replay = match last_event_id.as_deref() {
        Some(id) => hub.replay_since(&topics, id),
        None => Vec::new(),
    };
    let replayed_ids: HashSet<String> = replay.iter().filter_map(|e| e.id.clone()).collect();

    // ConnGuard 在 stream 被 drop（连接断开）时清理连接计数。
    let guard = ConnGuard {
        hub: hub.clone(),
        conn_id,
    };

    let history = futures::stream::iter(replay.into_iter().map(|env| {
        let mut event = Event::default().event(env.event);
        if let Some(id) = env.id {
            event = event.id(id);
        }
        Ok(event.json_data(&env.data).unwrap_or_default())
    }));

    let body = live_stream(
        rx,
        topics,
        guard,
        replayed_ids,
        None,
        crate::sse_batch_config::sse_heartbeat_interval(),
        crate::sse_batch_config::sse_graceful_close_duration(),
    );

    let stream = history.chain(body);

    Ok(sse_response(
        Sse::new(stream).keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("ping"),
        ),
    ))
}

/// 连接生命周期守卫：随 stream 一起被 drop 时摘除连接计数。
struct ConnGuard {
    hub: SseHub,
    conn_id: String,
}

impl Drop for ConnGuard {
    fn drop(&mut self) {
        self.hub.connections.remove(&self.conn_id);
        tracing::info!("SSE 连接关闭: {}", self.conn_id);
    }
}

// ───── 通用对外订阅端点 ────────────────────────────────────
//
// GET /events/:slug —— 不挂 auth_middleware。按 slug 读取启用工作流里的 SSE 推送节点，
// 将 URL 身份参数渲染成订阅 topic 后流式推送。payload 原样透传。

struct PublicEndpointCfg {
    identity_header: String,
    topic_template: String,
    event_name: String,
    graceful_close: GracefulCloseCfg,
}

/// 节点级优雅断开配置（`/events/:slug` 每个 `sse_publish` 节点独立可配）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GracefulCloseCfg {
    /// 节点未显式配置：回退到全局 `SSE_GRACEFUL_CLOSE_*`。
    Inherit,
    /// 节点显式关闭：永不自动断开。
    Disabled,
    /// 节点显式开启并指定时长（秒）。
    After(Duration),
}

/// 节点开启优雅断开但未显式给秒数时的默认时长（秒）；与前端默认、Go 25 分钟一致。
const DEFAULT_GRACEFUL_CLOSE_SECS: u64 = 1500;

impl GracefulCloseCfg {
    /// 从节点 `config` 解析 `graceful_close_enabled` / `graceful_close_seconds`。
    fn from_node_config(config: &Value) -> Self {
        match config.get("graceful_close_enabled").and_then(|v| v.as_bool()) {
            Some(true) => {
                // 兼容数字与字符串（如 "1500"）；缺省 / 非法则用默认 1500s，
                // 避免「开启了却因没填秒数而回退全局甚至永不断开」的反直觉行为。
                let secs = config
                    .get("graceful_close_seconds")
                    .and_then(|v| {
                        v.as_u64()
                            .or_else(|| v.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
                    })
                    .filter(|n| *n > 0)
                    .unwrap_or(DEFAULT_GRACEFUL_CLOSE_SECS);
                GracefulCloseCfg::After(Duration::from_secs(secs))
            }
            Some(false) => GracefulCloseCfg::Disabled,
            None => GracefulCloseCfg::Inherit,
        }
    }

    /// 结合全局兜底，解析出最终的断开时长；`None` 表示永不断开。
    fn resolve(self, global_default: Option<Duration>) -> Option<Duration> {
        match self {
            GracefulCloseCfg::Inherit => global_default,
            GracefulCloseCfg::Disabled => None,
            GracefulCloseCfg::After(d) => Some(d),
        }
    }
}

async fn load_public_endpoint(pool: &PgPool, slug: &str) -> Option<PublicEndpointCfg> {
    load_workflow_public_endpoint(pool, slug).await
}

fn workflow_topic_to_public_template(topic: &str) -> Option<String> {
    let mut out = topic.trim().to_string();
    if out.is_empty() {
        return None;
    }

    for key in ["wayUid", "way_uid", "identity", "uid", "userId"] {
        out = out.replace(&format!("{{{{trigger.payload.{key}}}}}"), "{identity}");
        out = out.replace(&format!("{{trigger.payload.{key}}}"), "{identity}");
    }
    out = out.replace("{{trigger.payload.projectId}}", "{query.projectId}");
    out = out.replace("{trigger.payload.projectId}", "{query.projectId}");

    validate_topic_template(&out).ok()?;
    Some(out)
}

async fn load_workflow_public_endpoint(pool: &PgPool, slug: &str) -> Option<PublicEndpointCfg> {
    let rows = sqlx::query(
        "SELECT slug, nodes FROM management.workflows WHERE is_enabled = true ORDER BY updated_at DESC",
    )
    .fetch_all(pool)
    .await
    .ok()?;

    for row in rows {
        let workflow_slug: String = row.get("slug");
        let nodes: Value = row.get("nodes");
        let Some(nodes) = nodes.as_array() else {
            continue;
        };

        for node in nodes {
            if node.get("type").and_then(|v| v.as_str()) != Some("sse_publish") {
                continue;
            }
            let config = node.get("config").unwrap_or(node);
            let endpoint_slug = config
                .get("subscription_slug")
                .or_else(|| config.get("public_endpoint_slug"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(&workflow_slug);
            if endpoint_slug != slug {
                continue;
            }

            let Some(topic) = config.get("topic").and_then(|v| v.as_str()) else {
                continue;
            };
            let Some(topic_template) = workflow_topic_to_public_template(topic) else {
                continue;
            };
            let event_name = config
                .get("event")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("message")
                .to_string();
            let identity_header = config
                .get("identity_header")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("X-Way-UID")
                .to_string();
            let graceful_close = GracefulCloseCfg::from_node_config(config);

            return Some(PublicEndpointCfg {
                identity_header,
                topic_template,
                event_name,
                graceful_close,
            });
        }
    }

    None
}

/// `GET /events/:slug?<query>`（不挂 auth_middleware）
pub async fn public_event_handler(
    State(pool): State<PgPool>,
    Extension(hub): Extension<SseHub>,
    Path(slug): Path<String>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response> {
    let cfg = load_public_endpoint(&pool, &slug)
        .await
        .ok_or_else(|| AppError::NotFound(format!("工作流订阅 {} 不存在或未启用", slug)))?;

    let identity = public_identity(&headers, &query, &cfg.identity_header)
        .ok_or_else(|| AppError::Unauthorized(format!("缺少 {}", cfg.identity_header)))?
        .to_string();

    let topic = render_subscription_topic(&cfg.topic_template, &identity, &query);
    let event_name = cfg.event_name.clone();
    // 节点级优先，未配置回退全局 SSE_GRACEFUL_CLOSE_*（默认关=永不断开）。
    let close_after = cfg
        .graceful_close
        .resolve(crate::sse_batch_config::sse_graceful_close_duration());

    let conn_id = uuid::Uuid::new_v4().to_string();
    hub.connections.insert(
        conn_id.clone(),
        ConnMeta {
            kind: "public",
            endpoint_slug: Some(slug.clone()),
            identity: Some(identity.clone()),
            connected_at: Utc::now(),
        },
    );
    tracing::info!(
        "对外端点 SSE 连接建立: {} (slug={}, identity={}, topic={})",
        conn_id,
        slug,
        identity,
        topic
    );

    // 断线重连：浏览器自动带上 Last-Event-ID，用它回放重连窗口里漏掉的历史消息。
    let last_event_id = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    // 先 subscribe 再取回放快照，再用 dedup 去掉两者重叠的那一小段。
    let rx = hub.subscribe();
    let subs = vec![topic];
    let replay = match last_event_id.as_deref() {
        Some(id) => hub.replay_since(&subs, id),
        None => Vec::new(),
    };
    let replayed_ids: HashSet<String> = replay.iter().filter_map(|e| e.id.clone()).collect();

    let guard = ConnGuard {
        hub: hub.clone(),
        conn_id,
    };

    let connected = futures::stream::once(async move {
        Ok(Event::default()
            .event("connected")
            // 把浏览器默认 ~3s 的重连间隔压到 500ms，缩小重连期间的丢消息窗口。
            .retry(Duration::from_millis(500))
            .json_data(serde_json::json!({ "ok": true }))
            .unwrap_or_default())
    });

    // 回放历史消息：带上 id，浏览器收到后会持续刷新 Last-Event-ID。
    let history_event_name = event_name.clone();
    let history = futures::stream::iter(replay.into_iter().map(move |env| {
        let mut event = Event::default().event(history_event_name.clone());
        if let Some(id) = &env.id {
            event = event.id(id.clone());
        }
        Ok(event.json_data(&env.data).unwrap_or_default())
    }));

    let body = live_stream(
        rx,
        subs,
        guard,
        replayed_ids,
        Some(event_name),
        crate::sse_batch_config::sse_heartbeat_interval(),
        close_after,
    );

    let stream = connected.chain(history).chain(body);
    Ok(sse_response(
        Sse::new(stream).keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("ping"),
        ),
    ))
}

// ───── HTTP 发布端点 ───────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct PublishReq {
    pub topic: String,
    #[serde(default)]
    pub event: Option<String>,
    #[serde(default)]
    pub data: serde_json::Value,
    #[serde(default)]
    pub id: Option<String>,
}

/// `POST /api/sse/publish`（挂 `auth_middleware`，注入 `Claims`）
pub async fn publish_handler(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Extension(hub): Extension<SseHub>,
    Json(req): Json<PublishReq>,
) -> Result<Json<serde_json::Value>> {
    if req.topic.trim().is_empty() {
        return Err(AppError::InvalidQuery("topic 不能为空".to_string()));
    }
    if !authorize_topic(&pool, &claims, &req.topic).await {
        return Err(AppError::Forbidden(format!(
            "无权向 topic 发布: {}",
            req.topic
        )));
    }
    let event = req.event.unwrap_or_else(|| "message".to_string());
    hub.publish(req.topic, event, req.data, req.id);
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ───── 数据变更桥接 ────────────────────────────────────────

/// 订阅 `EventBus`，把每个 `DataChangeEvent` 映射成 `db:{database_id}:table:{schema}.{table}`
/// 推进 `SseHub`（`publish_local`，不经 Redis 扇出）。
pub fn start_data_change_bridge(hub: SseHub, event_bus: EventBus) -> tokio::task::JoinHandle<()> {
    let mut rx = event_bus.subscribe();
    tokio::spawn(async move {
        tracing::info!("SSE 数据变更桥接已启动");
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    let env = data_change_to_envelope(&ev);
                    hub.publish_local(env);
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!("SSE 数据变更桥接丢失 {} 个事件", n);
                }
                Err(broadcast::error::RecvError::Closed) => {
                    tracing::info!("EventBus 关闭，SSE 数据变更桥接退出");
                    break;
                }
            }
        }
    })
}

fn data_change_to_envelope(ev: &DataChangeEvent) -> SseEnvelope {
    SseEnvelope {
        topic: format!("db:{}:table:{}.{}", ev.database_id, ev.schema, ev.table),
        event: ev.action.to_string(),
        data: ev
            .new_data
            .clone()
            .or_else(|| ev.old_data.clone())
            .unwrap_or(serde_json::Value::Null),
        id: ev.request_id.clone(),
        ts: ev.timestamp,
        replicate: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::ChangeAction;

    fn claims(superadmin: bool, sub: i32) -> Claims {
        Claims {
            sub,
            email: "u@example.com".to_string(),
            role: "user".to_string(),
            is_superadmin: superadmin,
            jti: "test".to_string(),
            exp: 9_999_999_999,
            iat: 0,
        }
    }

    // authorize_topic 的 db:* 分支需要 DB，留给集成 / 手动测试；
    // 下面覆盖纯前缀判定（user:）与 topic 匹配、信封序列化、数据变更映射。

    #[test]
    fn topic_matches_exact_and_wildcard() {
        let subs = vec!["user:5:notify".to_string(), "db:2:*".to_string()];
        assert!(topic_matches(&subs, "user:5:notify"));
        assert!(!topic_matches(&subs, "user:6:notify"));
        assert!(topic_matches(&subs, "db:2:table:public.posts"));
        assert!(topic_matches(&subs, "db:2:workflow:99"));
        assert!(!topic_matches(&subs, "db:3:table:public.posts"));
        assert!(!topic_matches(&subs, "sys:broadcast"));
    }

    #[test]
    fn topic_matches_empty_subscriptions() {
        assert!(!topic_matches(&[], "db:2:table:public.posts"));
    }

    #[test]
    fn envelope_serde_skips_replicate_and_optional_id() {
        let env = SseEnvelope {
            topic: "db:2:workflow:1".to_string(),
            event: "progress".to_string(),
            data: serde_json::json!({"pct": 50}),
            id: None,
            ts: Utc::now(),
            replicate: true,
        };
        let json = serde_json::to_string(&env).unwrap();
        assert!(!json.contains("replicate"), "replicate 不应被序列化");
        assert!(!json.contains("\"id\""), "id 为 None 时不应出现");

        // 反序列化（来自 Redis）后 replicate 默认为 false（防回环）。
        let back: SseEnvelope = serde_json::from_str(&json).unwrap();
        assert!(!back.replicate);
        assert_eq!(back.topic, "db:2:workflow:1");
        assert_eq!(back.event, "progress");
    }

    #[test]
    fn data_change_maps_to_db_table_topic() {
        let ev = DataChangeEvent {
            tenant_id: 1,
            database_id: 7,
            schema: "public".to_string(),
            table: "orders".to_string(),
            action: ChangeAction::Insert,
            old_data: None,
            new_data: Some(serde_json::json!({"id": 1})),
            user_id: Some(3),
            timestamp: Utc::now(),
            request_id: Some("req-1".to_string()),
        };
        let env = data_change_to_envelope(&ev);
        assert_eq!(env.topic, "db:7:table:public.orders");
        assert_eq!(env.event, "INSERT");
        assert_eq!(env.id.as_deref(), Some("req-1"));
        assert!(!env.replicate);
        assert_eq!(env.data, serde_json::json!({"id": 1}));
    }

    #[test]
    fn replay_since_returns_messages_after_last_id() {
        let hub = SseHub::new(16);
        let topic = "way:u1:growth:1".to_string();
        hub.publish(topic.clone(), "msg".into(), serde_json::json!({"n":1}), Some("id1".into()));
        hub.publish(topic.clone(), "msg".into(), serde_json::json!({"n":2}), Some("id2".into()));
        hub.publish(topic.clone(), "msg".into(), serde_json::json!({"n":3}), Some("id3".into()));

        let subs = vec!["way:u1:growth:*".to_string()];
        let out = hub.replay_since(&subs, "id1");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].id.as_deref(), Some("id2"));
        assert_eq!(out[1].id.as_deref(), Some("id3"));

        // 未知 / 已过期的 id：不回放（避免重复或刷屏），返回空。
        assert!(hub.replay_since(&subs, "does-not-exist").is_empty());
        // 不匹配的订阅：返回空。
        assert!(hub
            .replay_since(&["way:u2:growth:*".to_string()], "id1")
            .is_empty());
    }

    #[test]
    fn send_assigns_id_when_missing() {
        let hub = SseHub::new(16);
        hub.publish("user:5:notify".into(), "msg".into(), serde_json::json!({}), None);
        let q = hub.recent.get("user:5:notify").unwrap();
        assert_eq!(q.len(), 1);
        assert!(q.front().unwrap().id.is_some(), "send 应为缺省 id 的消息补上 id");
    }

    #[test]
    fn growth_topic_wildcard_matches_any_project() {
        let subs = vec!["way:u1:growth:*".to_string()];
        assert!(topic_matches(&subs, "way:u1:growth:1"));
        assert!(topic_matches(&subs, "way:u1:growth:42"));
        assert!(!topic_matches(&subs, "way:u2:growth:1"));
    }

    #[test]
    fn render_topic_identity_and_query() {
        let mut q = std::collections::HashMap::new();
        q.insert("projectId".to_string(), "1".to_string());
        assert_eq!(
            render_subscription_topic("way:{identity}:growth:{query.projectId}", "u1", &q),
            "way:u1:growth:1"
        );
    }

    #[test]
    fn render_topic_missing_query_truncates_to_wildcard() {
        let q = std::collections::HashMap::new();
        assert_eq!(
            render_subscription_topic("way:{identity}:growth:{query.projectId}", "u1", &q),
            "way:u1:growth:*"
        );
    }

    #[test]
    fn render_topic_empty_query_value_truncates_to_wildcard() {
        let mut q = std::collections::HashMap::new();
        q.insert("projectId".to_string(), "".to_string());
        assert_eq!(
            render_subscription_topic("way:{identity}:growth:{query.projectId}", "u1", &q),
            "way:u1:growth:*"
        );
    }

    #[test]
    fn render_topic_identity_only() {
        let q = std::collections::HashMap::new();
        assert_eq!(
            render_subscription_topic("notify:{identity}", "u1", &q),
            "notify:u1"
        );
    }

    #[test]
    fn public_identity_prefers_header() {
        let mut headers = HeaderMap::new();
        headers.insert("X-Way-UID", "from-header".parse().unwrap());
        let mut query = std::collections::HashMap::new();
        query.insert("wayUid".to_string(), "from-query".to_string());

        assert_eq!(
            public_identity(&headers, &query, "X-Way-UID").as_deref(),
            Some("from-header")
        );
    }

    #[test]
    fn public_identity_reads_identity_query_param() {
        let headers = HeaderMap::new();
        let mut query = std::collections::HashMap::new();
        query.insert("identity".to_string(), "u1".to_string());

        assert_eq!(
            public_identity(&headers, &query, "X-Way-UID").as_deref(),
            Some("u1")
        );
    }

    #[test]
    fn public_identity_reads_camel_query_param_from_header_name() {
        let headers = HeaderMap::new();
        let mut query = std::collections::HashMap::new();
        query.insert("wayUid".to_string(), "u1".to_string());

        assert_eq!(
            public_identity(&headers, &query, "X-Way-UID").as_deref(),
            Some("u1")
        );
    }

    #[test]
    fn public_identity_reads_snake_query_param_from_header_name() {
        let headers = HeaderMap::new();
        let mut query = std::collections::HashMap::new();
        query.insert("way_uid".to_string(), "u1".to_string());

        assert_eq!(
            public_identity(&headers, &query, "X-Way-UID").as_deref(),
            Some("u1")
        );
    }

    #[test]
    fn validate_template_requires_identity() {
        assert!(validate_topic_template("order:{query.orderId}").is_err());
    }

    #[test]
    fn validate_template_rejects_query_before_identity() {
        assert!(validate_topic_template("x:{query.a}:{identity}").is_err());
    }

    #[test]
    fn validate_template_rejects_unknown_placeholder() {
        assert!(validate_topic_template("x:{identity}:{foo}").is_err());
    }

    #[test]
    fn validate_template_accepts_identity_then_query() {
        assert!(validate_topic_template("way:{identity}:growth:{query.projectId}").is_ok());
    }

    #[test]
    fn workflow_topic_to_public_template_maps_way_uid() {
        assert_eq!(
            workflow_topic_to_public_template(
                "way:{{trigger.payload.way_uid}}:growth:{{trigger.payload.projectId}}"
            ),
            Some("way:{identity}:growth:{query.projectId}".to_string())
        );
    }

    #[test]
    fn workflow_topic_to_public_template_maps_way_uid_camel_case() {
        assert_eq!(
            workflow_topic_to_public_template(
                "way:{{trigger.payload.wayUid}}:growth:{{trigger.payload.projectId}}"
            ),
            Some("way:{identity}:growth:{query.projectId}".to_string())
        );
    }

    #[test]
    fn workflow_topic_to_public_template_rejects_unmapped_placeholder() {
        assert!(workflow_topic_to_public_template("way:{{trigger.payload.unknown}}:x").is_none());
    }

    #[test]
    fn authorize_user_topic_prefix_logic() {
        // 复刻 authorize_topic 里 user: 分支的纯逻辑（不含 DB），确保前缀解析正确。
        let c = claims(false, 5);
        let parse_uid = |topic: &str| -> Option<i32> {
            let topic = topic.strip_suffix('*').unwrap_or(topic);
            let mut parts = topic.split(':');
            match parts.next() {
                Some("user") => parts.next().and_then(|s| s.parse::<i32>().ok()),
                _ => None,
            }
        };
        assert_eq!(parse_uid("user:5:notify"), Some(5));
        assert_eq!(parse_uid("user:5:*"), Some(5));
        assert_eq!(parse_uid("user:6:notify"), Some(6));
        assert_eq!(parse_uid("db:2:x"), None);
        // 业务判定：uid==sub 才放行
        assert_eq!(parse_uid("user:5:notify") == Some(c.sub), true);
        assert_eq!(parse_uid("user:6:notify") == Some(c.sub), false);
    }
}
