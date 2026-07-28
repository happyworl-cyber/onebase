//! 品牌集中配置。
//!
//! 设计目标：上游与下游（不同产品名）之间，**只有 [`NAME`] 这一行取值不同**，
//! 其余源码保持一致，从而让 `git merge` 同步上游改动时几乎无冲突。
//!
//! 约定：
//! - 展示用（大小写敏感）名称走 [`NAME`]，由人工维护，上游/下游不同。
//! - 小写机器标识（Redis channel / 日志 target / 邮箱域 / 仓库名等）统一从
//!   [`SLUG`] 派生，而 `SLUG` = `Cargo.toml` 的 `name`（编译期常量），天然随
//!   crate 名变化——这些函数在两边源码里完全一致，无需人工区分。

/// 产品展示名（大小写敏感）。**这是上游/下游唯一需要人工区分的一行。**
pub const NAME: &str = "OneBase";

/// 与 `Cargo.toml` 的 `name` 完全一致的小写机器标识（编译期确定）。
pub const SLUG: &str = env!("CARGO_PKG_NAME");

/// 外发 HTTP 请求的 User-Agent。
pub fn user_agent() -> String {
    format!("{}/1.0", NAME)
}

/// Webhook / 定时任务 HTTP 回调的 HMAC 签名头名称。
pub fn signature_header() -> String {
    format!("X-{}-Signature", NAME)
}

/// SSO 用户无邮箱时的兜底邮箱域。
pub fn sso_email_domain() -> String {
    format!("sso.{}", SLUG)
}

/// 多实例事件同步用的 Redis Pub/Sub channel。
pub fn redis_event_channel() -> String {
    format!("{}:events", SLUG)
}

/// 只读副本探活连接的 PostgreSQL `application_name`。
pub fn replica_health_app_name() -> String {
    format!("{}-replica-health", SLUG)
}

/// 未显式设置 `RUST_LOG` 时的默认 EnvFilter 指令。
pub fn default_log_filter() -> String {
    format!("info,{}=debug,sqlx=info", SLUG)
}

/// 按天滚动日志文件名前缀（appender 会自动追加 `.YYYY-MM-DD`）。
pub fn log_file_name() -> String {
    format!("{}.log", SLUG)
}

/// API 根信息里的 documentation 链接。
pub fn repo_url() -> String {
    format!("https://github.com/yourusername/{}", SLUG)
}
