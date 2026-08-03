use std::env;

/// 应用配置
#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub host: String,
    pub port: u16,
    pub redis_url: String,
    /// 是否要求 Redis 必须可用。`true` 时，Redis 启动连接失败将 panic 而不是
    /// 静默降级。**多实例部署必须设为 true**，否则 Pub/Sub 事件桥不挂载，
    /// WebSocket / 实时推送在多实例间静默不工作。
    pub require_redis: bool,
    pub rate_limit_per_minute: u64,
    /// Redis 不可用时的限流降级模式：`degraded` | `closed` | `open`。
    /// 默认 `degraded`：本地内存计数兑底，避免缓存故障级联到 DB。
    pub rate_limit_fallback_mode: String,
    /// 兑底模式下每实例配额 = `floor(rate_limit_per_minute * multiplier)`，
    /// 至少 1。建议：单实例 1.0；2 实例 0.5；4+ 实例 0.25。
    pub rate_limit_fallback_multiplier: f64,
    pub request_timeout_secs: u64,
    pub graceful_shutdown_secs: u64,
    pub cb_failure_threshold: u32,
    pub cb_timeout_secs: u64,
    /// 调度循环周期（秒）；默认 5。
    pub scheduler_tick_interval_secs: u64,
    /// 单次 tick 最多 claim 任务数；默认 32。
    pub scheduler_batch_size: i64,
    /// 超时 + 此值后视为陈旧 claim 自动释放（秒）；默认 30。
    pub scheduler_stale_claim_grace_secs: i64,
    /// 重试指数退避起点（秒）；默认 60。
    pub scheduler_retry_base_secs: i64,
    /// 退避倍数；默认 2。
    pub scheduler_retry_factor: u32,
    /// 同时执行的定时任务数上限（并发闸门）；默认 8。应显著小于 `DB_MAX_CONNECTIONS`。
    pub scheduler_max_concurrency: usize,
    /// 是否允许 HTTP 任务使用明文 http://（默认 false，仅 https）。
    pub allow_insecure_scheduled_http: bool,
    /// Shell 任务沙盒模式。**默认 `auto`**：优先 bwrap → 退到 nsjail → 退到 direct(+ warn)。
    /// 显式取值：`auto` / `bwrap` / `nsjail` / `direct` / `off`。
    /// `off` 时整个 ShellExecutor 拒绝执行任何 shell 任务（仍可创建、被调度，但每次都 failed）。
    /// 枚举定义在 `crate::scheduler::executors` 内（lib-exposed），方便集成测试 import。
    pub scheduler_shell_sandbox_mode: crate::scheduler::ShellSandboxMode,
    pub cors_origins: Vec<String>,
    /// 进程启动时是否自动执行管理库迁移（`onebase::migrate::run_all_migrations`）。
    /// 默认 `true`：发版重启即同步 schema，免去生产环境手动跑 `migrate_all`。
    /// 设 `AUTO_MIGRATE=off`（或 false/0/no）可关闭，留给"CI/CD 里 gated 迁移"的团队。
    pub auto_migrate: bool,
    /// 通用 SSE 总线 broadcast channel 容量；见 `SSE_HUB_CAPACITY`。
    pub sse_hub_capacity: usize,
}

impl Config {
    /// 从环境变量加载配置
    pub fn from_env() -> anyhow::Result<Self> {
        dotenv::dotenv().ok();

        let database_url = env::var("DATABASE_URL").expect("DATABASE_URL 必须设置在环境变量中");

        let host = env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());

        let port = env::var("PORT")
            .unwrap_or_else(|_| "3000".to_string())
            .parse()
            .expect("PORT 必须是有效的数字");

        let redis_url =
            env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string());

        // REQUIRE_REDIS：true/1/yes 视为要求；其他视为可选（默认）。
        let require_redis = env::var("REQUIRE_REDIS")
            .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes"))
            .unwrap_or(false);

        let rate_limit_per_minute = env::var("RATE_LIMIT_PER_MINUTE")
            .unwrap_or_else(|_| "100".to_string())
            .parse()
            .unwrap_or(100);

        let rate_limit_fallback_mode =
            env::var("RATE_LIMIT_FALLBACK_MODE").unwrap_or_else(|_| "degraded".to_string());

        // 0.0~1.0，超出会在 RateLimiter 内 clamp。脏值回退到 0.5。
        let rate_limit_fallback_multiplier = env::var("RATE_LIMIT_FALLBACK_MULTIPLIER")
            .ok()
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|v| v.is_finite())
            .unwrap_or(0.5);

        let request_timeout_secs = env::var("REQUEST_TIMEOUT_SECS")
            .unwrap_or_else(|_| "30".to_string())
            .parse()
            .unwrap_or(30);

        let graceful_shutdown_secs = env::var("GRACEFUL_SHUTDOWN_SECS")
            .unwrap_or_else(|_| "30".to_string())
            .parse()
            .unwrap_or(30);

        let cb_failure_threshold = env::var("CIRCUIT_BREAKER_FAILURE_THRESHOLD")
            .unwrap_or_else(|_| "5".to_string())
            .parse()
            .unwrap_or(5);

        let cb_timeout_secs = env::var("CIRCUIT_BREAKER_TIMEOUT_SECS")
            .unwrap_or_else(|_| "30".to_string())
            .parse()
            .unwrap_or(30);

        // Scheduler 相关参数（见 SchedulerConfig 注释）。
        // 所有值都是宽松解析（非法 → 默认值），避免因脏环境变量阻塞启动。
        let scheduler_tick_interval_secs = env::var("SCHEDULER_TICK_INTERVAL_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(5);
        let scheduler_batch_size = env::var("SCHEDULER_BATCH_SIZE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(32);
        let scheduler_stale_claim_grace_secs = env::var("SCHEDULER_STALE_CLAIM_GRACE_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(30);
        let scheduler_retry_base_secs = env::var("SCHEDULER_RETRY_BASE_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(60);
        let scheduler_retry_factor = env::var("SCHEDULER_RETRY_FACTOR")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(2);
        // 并发闸门上限：0 / 非法值一律回退默认 8，且强制 >= 1（0 会让调度器永远拿不到 permit）。
        let scheduler_max_concurrency = env::var("SCHEDULER_MAX_CONCURRENCY")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(8);
        let allow_insecure_scheduled_http = env::var("ALLOW_INSECURE_SCHEDULED_HTTP")
            .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes"))
            .unwrap_or(false);

        // Shell 沙盒模式：脏值 / 缺失 → Auto（最安全的默认，会自己探测优先级）。
        let scheduler_shell_sandbox_mode = env::var("SCHEDULER_SHELL_SANDBOX_MODE")
            .ok()
            .and_then(|s| crate::scheduler::ShellSandboxMode::parse(&s))
            .unwrap_or(crate::scheduler::ShellSandboxMode::Auto);

        // CORS_ORIGINS: 逗号分隔的允许域名列表，"*" 表示全部允许（仅限开发环境）
        let cors_origins = env::var("CORS_ORIGINS")
            .unwrap_or_else(|_| "*".to_string())
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        // AUTO_MIGRATE：缺省 true（启动自动迁移）；显式 off/false/0/no 才关闭。
        let auto_migrate = env::var("AUTO_MIGRATE")
            .map(|v| {
                !matches!(
                    v.trim().to_ascii_lowercase().as_str(),
                    "off" | "false" | "0" | "no"
                )
            })
            .unwrap_or(true);

        let sse_hub_capacity = onebase::sse_batch_config::sse_hub_capacity_from_env();

        Ok(Config {
            database_url,
            host,
            port,
            redis_url,
            require_redis,
            rate_limit_per_minute,
            rate_limit_fallback_mode,
            rate_limit_fallback_multiplier,
            request_timeout_secs,
            graceful_shutdown_secs,
            cb_failure_threshold,
            cb_timeout_secs,
            scheduler_tick_interval_secs,
            scheduler_batch_size,
            scheduler_stale_claim_grace_secs,
            scheduler_retry_base_secs,
            scheduler_retry_factor,
            scheduler_max_concurrency,
            allow_insecure_scheduled_http,
            scheduler_shell_sandbox_mode,
            cors_origins,
            auto_migrate,
            sse_hub_capacity,
        })
    }
}
