//! 工作流 `sse_publish` 批量推送的运行时配置（环境变量，进程内缓存）。

use std::env;
use std::sync::OnceLock;
use std::time::Duration;

#[derive(Debug, Clone, Copy)]
pub struct SseBatchSettings {
    /// 单次节点最大 recipient 数（去重后）；`0` 表示不限制。
    pub max_recipients: usize,
    /// 默认 `batch_size`。
    pub default_chunk_size: usize,
    /// 节点 `batch_size` 上限。
    pub max_chunk_size: usize,
    /// 超过此数量且未强制 sync 时自动 async；0 表示关闭自动 async。
    pub async_threshold: usize,
    /// 批间 sleep 毫秒（削峰）；0 表示不 sleep。
    pub batch_delay_ms: u64,
}

impl SseBatchSettings {
    pub fn from_env() -> Self {
        Self {
            max_recipients: env_usize("SSE_BATCH_MAX_RECIPIENTS", 0),
            default_chunk_size: env_usize("SSE_BATCH_DEFAULT_CHUNK_SIZE", 500).max(1),
            max_chunk_size: env_usize("SSE_BATCH_MAX_CHUNK_SIZE", 2000).max(1),
            async_threshold: env_usize("SSE_BATCH_ASYNC_THRESHOLD", 1),
            batch_delay_ms: env_u64("SSE_BATCH_DELAY_MS", 0),
        }
    }
}

impl Default for SseBatchSettings {
    fn default() -> Self {
        Self {
            max_recipients: 0,
            default_chunk_size: 500,
            max_chunk_size: 2000,
            async_threshold: 1,
            batch_delay_ms: 0,
        }
    }
}

static SETTINGS: OnceLock<SseBatchSettings> = OnceLock::new();

pub fn sse_batch_settings() -> &'static SseBatchSettings {
    SETTINGS.get_or_init(SseBatchSettings::from_env)
}

fn env_usize(key: &str, default: usize) -> usize {
    env::var(key)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

fn env_u64(key: &str, default: u64) -> u64 {
    env::var(key)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

/// SSE Hub broadcast channel 容量（仅 binary 启动时用）。
pub fn sse_hub_capacity_from_env() -> usize {
    env_usize("SSE_HUB_CAPACITY", 16_384).max(256)
}

fn env_bool(key: &str, default: bool) -> bool {
    match env::var(key) {
        Ok(v) => matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        Err(_) => default,
    }
}

/// SSE 连接的具名心跳间隔；见 `SSE_HEARTBEAT_SECS`（默认 10s，对齐旧版 Go，最小 1s）。
///
/// 对齐旧版 Go `sq_push_server` 的 `event: heartbeat`：注释型 `:ping` 会被
/// `EventSource` 静默丢弃，具名事件客户端才能真正收到。
pub fn sse_heartbeat_interval() -> Duration {
    Duration::from_secs(env_u64("SSE_HEARTBEAT_SECS", 10).max(1))
}

/// 全局 SSE 优雅断开时长（兜底默认）；`None` 表示不自动断开（永久连接）。
///
/// 作为 `/events/:slug` 节点未显式配置时的回退，以及通用 `/sse` 端点的默认：
/// - `SSE_GRACEFUL_CLOSE_ENABLED`（默认 `false`——不配置即永不断开）；
/// - `SSE_GRACEFUL_CLOSE_MINUTES`（默认 `25`，≤0 时回落 25，仅在开启时生效）。
///
/// 节点级 `graceful_close_enabled` / `graceful_close_seconds` 优先于此全局值。
pub fn sse_graceful_close_duration() -> Option<Duration> {
    if !env_bool("SSE_GRACEFUL_CLOSE_ENABLED", false) {
        return None;
    }
    let minutes = env_u64("SSE_GRACEFUL_CLOSE_MINUTES", 25);
    let minutes = if minutes == 0 { 25 } else { minutes };
    Some(Duration::from_secs(minutes * 60))
}
