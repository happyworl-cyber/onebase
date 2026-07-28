//! 分布式限流器
//!
//! 基于 Redis 的固定窗口计数（INCR + EXPIRE）。每条规则独立一个 Redis key，
//! 同一请求若命中多条规则，按"任意一条拒绝即拒绝"的最严格语义聚合。
//!
//! 规则来源：
//! 1. 全局兜底 `max_requests`（env `RATE_LIMIT_PER_MINUTE`，60s 窗口）
//!    —— 用于兼容历史行为，未命中任何精细化规则时使用。
//! 2. `management.rate_limit_rules` 表里的精细化规则。后台任务每 30s 刷新；
//!    管理员通过 `/api/admin/rate-limit-rules` 增删改后会主动调
//!    `RateLimiter::refresh_now()`，无需等到下一轮轮询。
//!
//! ## Redis 故障 / 缺失降级（FallbackMode）
//!
//! 限流器**不再**强依赖 Redis。Redis 既可能"运行中故障"（短暂不可达），也可能
//! "压根没配置"（开发环境 / 单实例最小化部署）。两种情况都走同一套降级路径：
//!
//! - `degraded`（默认）：本地内存计数兑底，按 `max_requests * fallback_multiplier`
//!   每实例独立计数。失去全局视图，但每实例有上限，DB 不会被无门槛打穿。
//! - `closed`：直接拒绝（429）。用于"宁可拒服务也不能击穿后端"的关键系统。
//!   仍会豁免 `/health*` 探针路径，避免把 k8s 的存活检查一起 429 → pod 反复重启。
//! - `open`：保留历史行为（一断全放）。仅供 DB 容量极大、可承受短时洪峰的场景；
//!   不再是隐式默认。
//!
//! 与"Redis 突然故障"不同的是，`redis = None` 时降级是配置选择，不应污染
//! `redis_failures_streak` 计数与"已进入降级"告警 —— 那些指标只反映**意外**的
//! Redis 故障。无 Redis 部署属于**预期**降级，启动期由 main.rs 输出一次明确日志。
//!
//! ## 历史 bug
//!
//! 1. CRUD 写入的 `management.rate_limit_rules` 不被任何代码读取 —— 已修复。
//! 2. `req.extensions().get::<Claims>()` 在 rate_limit_middleware 阶段永远拿不到，
//!    因此"按 user_id 限流"实际从未生效 —— 已用轻量 JWT 校验补回。
//! 3. Redis 故障 fail-open 导致级联雪崩 —— 已用 FallbackMode + 本地兑底修复。
//! 4. Redis 缺失时整个限流中间件 silently 不挂载，等于无保护 —— 已通过
//!    `Option<RedisManager>` + 永远挂载中间件 + 本地兑底 修复。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::Request,
    middleware::Next,
    response::{IntoResponse, Response},
};
use dashmap::DashMap;
use sqlx::{PgPool, Row};
use tokio::sync::RwLock;

use crate::auth::verify_token;
use crate::error::AppError;
use crate::redis_manager::RedisManager;

/// 全局兜底窗口（秒）。仅当请求未命中任何精细化规则时使用。
const DEFAULT_RATE_LIMIT_WINDOW: u64 = 60;

/// 后台刷新规则缓存的间隔。
const RULES_REFRESH_INTERVAL: Duration = Duration::from_secs(30);

/// `database_id → tenant_id` 缓存条目的 TTL。
/// 短一点能让"租户被删除/迁移"在 ~5 分钟内自动失效；这条映射本身极少变化，
/// 不必做精细的失效。
const DB_TENANT_CACHE_TTL: Duration = Duration::from_secs(300);

/// 本地兑底计数器的清理间隔（清掉所有 window_end < now 的条目，回收内存）。
const LOCAL_CLEANUP_INTERVAL: Duration = Duration::from_secs(60);

/// Redis 连续失败到这个次数后输出一次"已进入降级"的结构化告警。
/// 阈值不要太大 —— Redis 真断了，前几个请求就足以判定。
const REDIS_DEGRADE_LOG_THRESHOLD: u64 = 3;

/// 全路径前缀豁免列表：永远不进入限流逻辑。当前只豁免 k8s/LB 探针。
/// 如果要添加更多豁免路径，请保持该列表尽可能短 —— 任何豁免都是一次"信任假设"。
const RATE_LIMIT_EXEMPT_PREFIXES: &[&str] = &["/health"];

/// Redis 故障时的降级策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FallbackMode {
    /// 本地兑底计数器，每实例按 `max * fallback_multiplier` 卡限制（默认）。
    Degraded,
    /// 直接拒绝。最严格，适合不能击穿后端的核心服务。
    Closed,
    /// 全部放行（历史行为）。**不推荐**，仅为兼容保留。
    Open,
}

impl FallbackMode {
    /// 从环境变量字符串解析；不识别的值回退到默认 Degraded 并告警。
    pub fn from_env_str(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "degraded" | "" => Self::Degraded,
            "closed" | "deny" | "reject" => Self::Closed,
            "open" | "allow" | "permit" => {
                tracing::warn!(
                    "RATE_LIMIT_FALLBACK_MODE=open：Redis 故障期间将全部放行，\
                     这是历史行为且会让缓存故障级联到 DB。生产环境请使用 degraded 或 closed。"
                );
                Self::Open
            }
            other => {
                tracing::warn!(
                    "未知的 RATE_LIMIT_FALLBACK_MODE='{}'，回退到 degraded",
                    other
                );
                Self::Degraded
            }
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Degraded => "degraded",
            Self::Closed => "closed",
            Self::Open => "open",
        }
    }
}

/// 限流降级配置。
#[derive(Debug, Clone, Copy)]
pub struct FallbackConfig {
    pub mode: FallbackMode,
    /// 本地兑底时，每实例配额 = `floor(max * multiplier)`，至少 1。
    /// 默认 0.5：典型 2 实例部署下总配额 ≈ 1× 全局上限。
    /// 单实例部署可调到 1.0；4+ 实例可调到 0.25。
    pub multiplier: f64,
}

impl Default for FallbackConfig {
    fn default() -> Self {
        Self {
            mode: FallbackMode::Degraded,
            multiplier: 0.5,
        }
    }
}

/// 单条精细化限流规则。字段语义：
/// - `rule_type == "tenant"`：当请求所属 tenant_id == 本规则 tenant_id 时命中。
/// - `rule_type == "user"`：`match_pattern` 是 user_id 字符串；`*` 表示任意已认证用户。
/// - `rule_type == "endpoint"`：`match_pattern` 是 path glob（仅支持末尾 `*`，例如
///   `/api/v1/*`），`*` 单独表示全部路径。
/// - `rule_type == "ip"`：`match_pattern` 是精确 IP；`*` 表示任意 IP。
///
/// 当 `tenant_id` 字段在 `'user' / 'endpoint' / 'ip'` 类型规则上也设置时，
/// 该规则会被进一步限定到"仅命中该租户"——可以用来做"X 租户的某端点单独提速/降速"。
#[derive(Debug, Clone)]
pub struct RateLimitRule {
    pub id: i32,
    pub tenant_id: Option<i32>,
    pub rule_type: String,
    pub match_pattern: Option<String>,
    pub max_requests: u32,
    pub window_seconds: u32,
}

#[derive(Clone)]
struct CachedTenant {
    tenant_id: Option<i32>,
    fetched_at: Instant,
}

/// 单次请求的上下文，由中间件组装后交给 `RateLimiter::check_request` 评估。
#[derive(Debug, Clone)]
pub struct RequestContext<'a> {
    pub path: &'a str,
    pub ip: &'a str,
    pub user_id: Option<i32>,
    pub tenant_id: Option<i32>,
}

/// 单次评估结果：
/// - `allowed`：是否放行。
/// - `limit/remaining`：用于响应头。多规则命中时取"最受限"那条（剩余配额最少）的数值。
/// - `degraded`：本次决策是否走了 Redis 故障兜底路径，便于响应头/日志区分。
#[derive(Debug, Clone, Copy)]
pub struct RateLimitDecision {
    pub allowed: bool,
    pub limit: u64,
    pub remaining: u64,
    pub window_seconds: u64,
    pub degraded: bool,
}

impl RateLimitDecision {
    fn allow_full(limit: u64, window: u64) -> Self {
        Self {
            allowed: true,
            limit,
            remaining: limit,
            window_seconds: window,
            degraded: false,
        }
    }
}

/// 进程内本地兑底计数器：按 (key, window) 维护"窗口起点 + 计数"。
/// `entries` 用 DashMap 做并发分片；窗口到期时原子地重置而不是删除条目，
/// 删除交给后台定时清理任务，热点 key 不必反复 alloc。
#[derive(Debug, Default)]
struct LocalCounters {
    entries: DashMap<String, LocalEntry>,
}

#[derive(Debug)]
struct LocalEntry {
    /// 窗口结束时刻（自 RateLimiter::created_at 起的秒数；用 monotonic 时间避免时钟回拨）。
    window_end_secs: AtomicU64,
    count: AtomicU64,
}

impl LocalEntry {
    fn new(window_end_secs: u64) -> Self {
        Self {
            window_end_secs: AtomicU64::new(window_end_secs),
            count: AtomicU64::new(0),
        }
    }
}

impl LocalCounters {
    /// 自增并返回当前窗口内的计数。如果当前窗口已过期，会原子地把窗口重置为
    /// `[now, now + window)` 并把计数置为 1。
    fn incr(&self, key: &str, now_secs: u64, window_secs: u64) -> u64 {
        if let Some(entry) = self.entries.get(key) {
            // 快路径：条目已存在
            let end = entry.window_end_secs.load(Ordering::Acquire);
            if now_secs < end {
                return entry.count.fetch_add(1, Ordering::AcqRel) + 1;
            }
            // 窗口过期：尝试原子地把窗口推进。compare_exchange 失败说明别的线程已经推过了，
            // 我们直接在新窗口里 +1 即可。
            let new_end = now_secs + window_secs;
            let _ = entry.window_end_secs.compare_exchange(
                end,
                new_end,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
            // 不论我们 / 别的线程谁推进的窗口，都需要把 count 归零再 +1。
            // 这里为了保持原子语义直接 store(1)；存在极小概率与并发的 fetch_add 竞争
            // 导致计数偏少，但本地兑底本来就是粗粒度兜底，可接受。
            entry.count.store(1, Ordering::Release);
            return 1;
        }

        // 慢路径：首次见到这个 key
        let new_end = now_secs + window_secs;
        let entry = self
            .entries
            .entry(key.to_string())
            .or_insert_with(|| LocalEntry::new(new_end));
        entry.count.fetch_add(1, Ordering::AcqRel) + 1
    }

    /// 清理所有 window_end_secs <= now 的条目，避免长期堆积。
    fn cleanup(&self, now_secs: u64) {
        self.entries
            .retain(|_, v| v.window_end_secs.load(Ordering::Acquire) > now_secs);
    }

    fn len(&self) -> usize {
        self.entries.len()
    }
}

/// 限流器内部健康/计数指标。可通过 `RateLimiter::stats_snapshot` 暴露给运维接口。
#[derive(Debug, Default)]
struct LimiterMetrics {
    total_checks: AtomicU64,
    redis_failures_total: AtomicU64,
    redis_failures_streak: AtomicU64,
    fallback_decisions_total: AtomicU64,
    fallback_rejected_total: AtomicU64,
    /// 是否已经为当前的连续失败发过一次"降级"告警 —— 避免每个请求一行 warn 把日志刷爆。
    degraded_logged: AtomicBool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LimiterStats {
    pub total_checks: u64,
    /// 是否配置了 Redis。`false` 表示本进程一直在 fallback 路径上跑（预期降级）；
    /// 此时观察 `redis_failures_*` 没有意义。
    pub redis_configured: bool,
    pub redis_failures_total: u64,
    pub redis_failures_streak: u64,
    pub fallback_decisions_total: u64,
    pub fallback_rejected_total: u64,
    pub local_counter_keys: usize,
    pub fallback_mode: &'static str,
    pub fallback_multiplier: f64,
    pub default_max_requests: u64,
    pub active_rules: usize,
}

/// 分布式限流器
#[derive(Clone)]
pub struct RateLimiter {
    /// Redis 句柄。`None` 表示部署未配置 Redis（视为"永远不可用"），
    /// `check_one` 会跳过 Redis 直接走 fallback；这种缺失**不**计入 Redis 故障 streak。
    redis: Option<RedisManager>,
    pool: PgPool,
    default_max_requests: u64,
    rules: Arc<RwLock<Vec<RateLimitRule>>>,
    db_to_tenant: Arc<RwLock<HashMap<i32, CachedTenant>>>,
    fallback: FallbackConfig,
    local: Arc<LocalCounters>,
    metrics: Arc<LimiterMetrics>,
    /// monotonic 起点。本地兑底用 (Instant - created_at).as_secs() 表示时间，
    /// 避免依赖系统时钟（防回拨 / 防 NTP 抖动）。
    created_at: Instant,
}

impl RateLimiter {
    /// 构造限流器。`fallback` 控制 Redis 故障/缺失时的行为，调用方 **必须** 显式
    /// 传入，强制每个集成点都做出降级语义的明确决策（避免又退回到隐式 fail-open）。
    /// `redis` 可以为 `None` —— 此时所有请求直接走本地 fallback，限流仍然生效。
    pub fn new(
        redis: Option<RedisManager>,
        pool: PgPool,
        default_max_requests: u64,
        fallback: FallbackConfig,
    ) -> Self {
        let redis_status = if redis.is_some() { "connected" } else { "absent" };
        let limiter = Self {
            redis,
            pool,
            default_max_requests,
            rules: Arc::new(RwLock::new(Vec::new())),
            db_to_tenant: Arc::new(RwLock::new(HashMap::new())),
            fallback,
            local: Arc::new(LocalCounters::default()),
            metrics: Arc::new(LimiterMetrics::default()),
            created_at: Instant::now(),
        };

        tracing::info!(
            "RateLimiter 启动: default_max={}/min fallback_mode={} multiplier={:.2} redis={}",
            default_max_requests,
            fallback.mode.as_str(),
            fallback.multiplier,
            redis_status,
        );

        // 后台规则刷新任务
        let bg = limiter.clone();
        tokio::spawn(async move {
            if let Err(e) = bg.refresh_now().await {
                tracing::warn!("RateLimiter 初次加载规则失败: {}", e);
            }
            let mut interval = tokio::time::interval(RULES_REFRESH_INTERVAL);
            interval.tick().await;
            loop {
                interval.tick().await;
                if let Err(e) = bg.refresh_now().await {
                    tracing::warn!("RateLimiter 规则刷新失败: {}", e);
                }
            }
        });

        // 后台本地兑底清理任务
        let cleanup = limiter.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(LOCAL_CLEANUP_INTERVAL);
            interval.tick().await;
            loop {
                interval.tick().await;
                cleanup.local.cleanup(cleanup.now_secs());
            }
        });

        limiter
    }

    fn now_secs(&self) -> u64 {
        self.created_at.elapsed().as_secs()
    }

    /// 立即从 DB 重载规则缓存。CRUD handler 在写完表之后会调一次，让管理员
    /// 的修改立即生效（不必等到下一轮 30s 轮询）。
    pub async fn refresh_now(&self) -> Result<(), AppError> {
        let rows = sqlx::query(
            "SELECT id, tenant_id, rule_type, match_pattern, max_requests, window_seconds \
             FROM management.rate_limit_rules WHERE is_active = true",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("加载限流规则失败: {}", e)))?;

        let mut rules = Vec::with_capacity(rows.len());
        for r in rows {
            let max_requests: i32 = r.get("max_requests");
            let window_seconds: i32 = r.get("window_seconds");
            if max_requests <= 0 || window_seconds <= 0 {
                tracing::warn!(
                    "跳过无效限流规则 id={} max_requests={} window_seconds={}",
                    r.get::<i32, _>("id"),
                    max_requests,
                    window_seconds
                );
                continue;
            }
            rules.push(RateLimitRule {
                id: r.get("id"),
                tenant_id: r.get("tenant_id"),
                rule_type: r.get("rule_type"),
                match_pattern: r.get("match_pattern"),
                max_requests: max_requests as u32,
                window_seconds: window_seconds as u32,
            });
        }

        let count = rules.len();
        *self.rules.write().await = rules;
        tracing::debug!("限流规则已刷新: {} 条", count);
        Ok(())
    }

    /// 根据 `database_id` 解析所属 `tenant_id`，带短期内存缓存。
    async fn resolve_tenant_id(&self, database_id: i32) -> Option<i32> {
        if let Some(entry) = self.db_to_tenant.read().await.get(&database_id) {
            if entry.fetched_at.elapsed() < DB_TENANT_CACHE_TTL {
                return entry.tenant_id;
            }
        }

        let tenant_id: Option<i32> = sqlx::query_scalar(
            "SELECT tenant_id FROM management.tenant_databases WHERE id = $1 AND is_active = true",
        )
        .bind(database_id)
        .fetch_optional(&self.pool)
        .await
        .ok()
        .flatten();

        self.db_to_tenant.write().await.insert(
            database_id,
            CachedTenant {
                tenant_id,
                fetched_at: Instant::now(),
            },
        );
        tenant_id
    }

    /// 评估请求是否允许通过。
    pub async fn check_request(&self, ctx: &RequestContext<'_>) -> RateLimitDecision {
        self.metrics.total_checks.fetch_add(1, Ordering::Relaxed);

        let rules_snapshot = self.rules.read().await.clone();
        let matched: Vec<&RateLimitRule> = rules_snapshot
            .iter()
            .filter(|r| rule_matches(r, ctx))
            .collect();

        if matched.is_empty() {
            let identity = identity_for_default(ctx);
            return self
                .check_one(
                    &format!("default:{}", identity),
                    self.default_max_requests,
                    DEFAULT_RATE_LIMIT_WINDOW,
                )
                .await;
        }

        let mut allowed = true;
        let mut tightest = RateLimitDecision::allow_full(
            self.default_max_requests,
            DEFAULT_RATE_LIMIT_WINDOW,
        );
        let mut tightest_remaining = u64::MAX;
        let mut any_degraded = false;

        for rule in matched {
            let scope = scope_token_for_rule(rule, ctx);
            let key = format!("rule:{}:{}", rule.id, scope);
            let decision = self
                .check_one(&key, rule.max_requests as u64, rule.window_seconds as u64)
                .await;

            if !decision.allowed {
                allowed = false;
            }
            if decision.degraded {
                any_degraded = true;
            }
            if decision.remaining < tightest_remaining {
                tightest_remaining = decision.remaining;
                tightest = decision;
            }
        }

        RateLimitDecision {
            allowed,
            degraded: any_degraded || tightest.degraded,
            ..tightest
        }
    }

    /// 单条 key + (max, window) 的判断。先走 Redis；失败/缺失则按 FallbackMode 兑底。
    ///
    /// `redis = None` 是部署期的预期配置，不计入 Redis 故障 streak —— 那是给
    /// "本来该有 Redis 但突然抖了"留的告警通道，不该被无 Redis 部署污染。
    async fn check_one(&self, key: &str, max_requests: u64, window: u64) -> RateLimitDecision {
        let redis = match &self.redis {
            Some(r) => r,
            None => return self.fallback_decision(key, max_requests, window),
        };

        let redis_key = format!("rl:{}", key);
        match redis.incr_with_expire(&redis_key, window).await {
            Ok(count) => {
                self.note_redis_success();
                let remaining = max_requests.saturating_sub(count);
                RateLimitDecision {
                    allowed: count <= max_requests,
                    limit: max_requests,
                    remaining,
                    window_seconds: window,
                    degraded: false,
                }
            }
            Err(e) => {
                self.note_redis_failure(&e);
                self.fallback_decision(key, max_requests, window)
            }
        }
    }

    fn note_redis_success(&self) {
        // 把连续失败 streak 清零，并在曾经降级过的情况下记录"恢复"事件
        let prev = self.metrics.redis_failures_streak.swap(0, Ordering::AcqRel);
        if prev >= REDIS_DEGRADE_LOG_THRESHOLD
            && self
                .metrics
                .degraded_logged
                .swap(false, Ordering::AcqRel)
        {
            tracing::info!(
                "RateLimiter Redis 已恢复，退出降级模式（之前连续失败 {} 次）",
                prev
            );
        }
    }

    fn note_redis_failure(&self, err: &AppError) {
        self.metrics
            .redis_failures_total
            .fetch_add(1, Ordering::Relaxed);
        let streak = self
            .metrics
            .redis_failures_streak
            .fetch_add(1, Ordering::AcqRel)
            + 1;
        if streak >= REDIS_DEGRADE_LOG_THRESHOLD
            && !self.metrics.degraded_logged.swap(true, Ordering::AcqRel)
        {
            tracing::warn!(
                "RateLimiter 进入降级模式: Redis 连续失败 {} 次, mode={}, multiplier={:.2}, err={}",
                streak,
                self.fallback.mode.as_str(),
                self.fallback.multiplier,
                err
            );
        }
    }

    fn fallback_decision(&self, key: &str, max_requests: u64, window: u64) -> RateLimitDecision {
        self.metrics
            .fallback_decisions_total
            .fetch_add(1, Ordering::Relaxed);

        match self.fallback.mode {
            FallbackMode::Open => RateLimitDecision {
                allowed: true,
                limit: max_requests,
                remaining: max_requests,
                window_seconds: window,
                degraded: true,
            },
            FallbackMode::Closed => {
                self.metrics
                    .fallback_rejected_total
                    .fetch_add(1, Ordering::Relaxed);
                RateLimitDecision {
                    allowed: false,
                    limit: max_requests,
                    remaining: 0,
                    window_seconds: window,
                    degraded: true,
                }
            }
            FallbackMode::Degraded => {
                let local_max = local_cap(max_requests, self.fallback.multiplier);
                let count = self.local.incr(key, self.now_secs(), window);
                let allowed = count <= local_max;
                if !allowed {
                    self.metrics
                        .fallback_rejected_total
                        .fetch_add(1, Ordering::Relaxed);
                }
                RateLimitDecision {
                    allowed,
                    limit: local_max,
                    remaining: local_max.saturating_sub(count),
                    window_seconds: window,
                    degraded: true,
                }
            }
        }
    }

    /// 给运维 / 监控接口的快照。
    pub async fn stats_snapshot(&self) -> LimiterStats {
        LimiterStats {
            total_checks: self.metrics.total_checks.load(Ordering::Relaxed),
            redis_configured: self.redis.is_some(),
            redis_failures_total: self
                .metrics
                .redis_failures_total
                .load(Ordering::Relaxed),
            redis_failures_streak: self
                .metrics
                .redis_failures_streak
                .load(Ordering::Relaxed),
            fallback_decisions_total: self
                .metrics
                .fallback_decisions_total
                .load(Ordering::Relaxed),
            fallback_rejected_total: self
                .metrics
                .fallback_rejected_total
                .load(Ordering::Relaxed),
            local_counter_keys: self.local.len(),
            fallback_mode: self.fallback.mode.as_str(),
            fallback_multiplier: self.fallback.multiplier,
            default_max_requests: self.default_max_requests,
            active_rules: self.rules.read().await.len(),
        }
    }
}

/// 兑底时单实例上限：`floor(max * multiplier)`，至少 1（避免 multiplier=0 时永远拒绝）。
fn local_cap(max_requests: u64, multiplier: f64) -> u64 {
    let m = multiplier.clamp(0.0, 1.0);
    let cap = (max_requests as f64 * m).floor() as u64;
    cap.max(1)
}

/// 是否豁免限流（探针等基础设施路径）。
fn is_exempt_path(path: &str) -> bool {
    RATE_LIMIT_EXEMPT_PREFIXES
        .iter()
        .any(|p| path == *p || path.starts_with(&format!("{}/", p)))
}

/// 兜底维度：优先按用户，其次按 IP（与原行为一致）。
fn identity_for_default(ctx: &RequestContext<'_>) -> String {
    if let Some(uid) = ctx.user_id {
        format!("user:{}", uid)
    } else {
        format!("ip:{}", ctx.ip)
    }
}

/// 给精细化规则的 Redis key 拼一个"作用域 token"。
fn scope_token_for_rule(rule: &RateLimitRule, ctx: &RequestContext<'_>) -> String {
    match rule.rule_type.as_str() {
        "tenant" => format!("t{}", rule.tenant_id.unwrap_or(0)),
        "user" => match ctx.user_id {
            Some(uid) => format!("u{}", uid),
            None => format!("ip:{}", ctx.ip),
        },
        "endpoint" => {
            let who = ctx
                .user_id
                .map(|u| format!("u{}", u))
                .unwrap_or_else(|| format!("ip:{}", ctx.ip));
            let tenant_part = ctx
                .tenant_id
                .map(|t| format!("t{}", t))
                .unwrap_or_else(|| "t-".to_string());
            format!("{}|{}", tenant_part, who)
        }
        "ip" => format!("ip:{}", ctx.ip),
        _ => "unknown".to_string(),
    }
}

/// 单条规则是否命中当前请求。
fn rule_matches(rule: &RateLimitRule, ctx: &RequestContext<'_>) -> bool {
    if let Some(rule_tenant) = rule.tenant_id {
        if ctx.tenant_id != Some(rule_tenant) {
            return false;
        }
    }

    match rule.rule_type.as_str() {
        "tenant" => rule.tenant_id.is_some(),
        "user" => {
            let pattern = match rule.match_pattern.as_deref() {
                Some(p) => p,
                None => return false,
            };
            match ctx.user_id {
                Some(uid) => pattern == "*" || pattern == uid.to_string(),
                None => false,
            }
        }
        "endpoint" => {
            let pattern = match rule.match_pattern.as_deref() {
                Some(p) => p,
                None => return false,
            };
            path_glob_matches(pattern, ctx.path)
        }
        "ip" => {
            let pattern = match rule.match_pattern.as_deref() {
                Some(p) => p,
                None => return false,
            };
            pattern == "*" || pattern == ctx.ip
        }
        _ => false,
    }
}

/// 极轻量的 path glob：
/// - `*`     → 全匹配
/// - `xxx*`  → 前缀匹配
/// - 其它    → 精确匹配
fn path_glob_matches(pattern: &str, path: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if let Some(prefix) = pattern.strip_suffix('*') {
        return path.starts_with(prefix);
    }
    pattern == path
}

/// 限流中间件
pub async fn rate_limit_middleware(
    limiter: Option<axum::extract::Extension<RateLimiter>>,
    req: Request,
    next: Next,
) -> Response {
    let limiter = match limiter {
        Some(axum::extract::Extension(l)) => l,
        None => return next.run(req).await,
    };

    let path = req.uri().path().to_string();

    // 探针/基础设施路径完全不进入限流，避免 closed 模式下把 k8s 探针一起 429。
    if is_exempt_path(&path) {
        return next.run(req).await;
    }

    let ip = extract_client_ip(&req);

    // 关键修复：rate_limit_middleware 在 auth_middleware 之前执行，
    // 必须自己解一次 JWT 才能识别用户身份。只验签名 + 过期，不查 user_sessions。
    let user_id = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .filter(|t| !t.starts_with("cr_"))
        .and_then(|t| verify_token(t).ok())
        .map(|c| c.sub);

    let database_id = req
        .headers()
        .get("X-Database-Id")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.parse::<i32>().ok());
    let tenant_id = match database_id {
        Some(db_id) => limiter.resolve_tenant_id(db_id).await,
        None => None,
    };

    let ctx = RequestContext {
        path: path.as_str(),
        ip: ip.as_str(),
        user_id,
        tenant_id,
    };

    let decision = limiter.check_request(&ctx).await;

    if !decision.allowed {
        tracing::warn!(
            "限流触发: path={} ip={} user_id={:?} tenant_id={:?} limit={} window={}s degraded={}",
            ctx.path,
            ctx.ip,
            ctx.user_id,
            ctx.tenant_id,
            decision.limit,
            decision.window_seconds,
            decision.degraded,
        );
        let msg = if decision.degraded {
            format!(
                "服务暂时降级中（缓存层不可用），请 {} 秒后重试",
                decision.window_seconds
            )
        } else {
            format!("请求过于频繁，请 {} 秒后重试", decision.window_seconds)
        };
        let err = AppError::TooManyRequests(msg);
        let mut resp = err.into_response();
        let headers = resp.headers_mut();
        if let Ok(v) = decision.limit.to_string().parse() {
            headers.insert("X-RateLimit-Limit", v);
        }
        if let Ok(v) = "0".parse() {
            headers.insert("X-RateLimit-Remaining", v);
        }
        if let Ok(v) = decision.window_seconds.to_string().parse() {
            headers.insert("Retry-After", v);
        }
        if decision.degraded {
            if let Ok(v) = "true".parse() {
                headers.insert("X-RateLimit-Degraded", v);
            }
        }
        return resp;
    }

    let mut response = next.run(req).await;

    let headers = response.headers_mut();
    if let Ok(v) = decision.limit.to_string().parse() {
        headers.insert("X-RateLimit-Limit", v);
    }
    if let Ok(v) = decision.remaining.to_string().parse() {
        headers.insert("X-RateLimit-Remaining", v);
    }
    if decision.degraded {
        if let Ok(v) = "true".parse() {
            headers.insert("X-RateLimit-Degraded", v);
        }
    }

    response
}

fn extract_client_ip(req: &Request) -> String {
    if let Some(v) = req
        .headers()
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
    {
        if let Some(first) = v.split(',').next() {
            let trimmed = first.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    if let Some(v) = req
        .headers()
        .get("x-real-ip")
        .and_then(|v| v.to_str().ok())
    {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    "unknown".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(rule_type: &str, pattern: Option<&str>, tenant_id: Option<i32>) -> RateLimitRule {
        RateLimitRule {
            id: 1,
            tenant_id,
            rule_type: rule_type.to_string(),
            match_pattern: pattern.map(|s| s.to_string()),
            max_requests: 100,
            window_seconds: 60,
        }
    }

    fn ctx<'a>(
        path: &'a str,
        ip: &'a str,
        user_id: Option<i32>,
        tenant_id: Option<i32>,
    ) -> RequestContext<'a> {
        RequestContext {
            path,
            ip,
            user_id,
            tenant_id,
        }
    }

    #[test]
    fn test_rate_limiter_is_clone() {
        fn assert_clone<T: Clone>() {}
        assert_clone::<RateLimiter>();
    }

    #[test]
    fn test_rate_limiter_is_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<RateLimiter>();
    }

    #[test]
    fn test_path_glob_matches_exact_and_prefix_and_wildcard() {
        assert!(path_glob_matches("*", "/anything"));
        assert!(path_glob_matches("/api/v1/*", "/api/v1/users"));
        assert!(path_glob_matches("/api/v1/*", "/api/v1/"));
        assert!(!path_glob_matches("/api/v1/*", "/api/v2/users"));
        assert!(path_glob_matches("/health", "/health"));
        assert!(!path_glob_matches("/health", "/health/live"));
    }

    #[test]
    fn test_endpoint_rule_matches_only_matching_path() {
        let r = rule("endpoint", Some("/api/v1/*"), None);
        assert!(rule_matches(&r, &ctx("/api/v1/users", "1.1.1.1", None, None)));
        assert!(!rule_matches(&r, &ctx("/api/v2/users", "1.1.1.1", None, None)));
    }

    #[test]
    fn test_endpoint_rule_with_tenant_scope() {
        let r = rule("endpoint", Some("/api/v1/*"), Some(7));
        assert!(rule_matches(
            &r,
            &ctx("/api/v1/x", "1.1.1.1", Some(42), Some(7))
        ));
        assert!(!rule_matches(
            &r,
            &ctx("/api/v1/x", "1.1.1.1", Some(42), Some(8))
        ));
        assert!(!rule_matches(
            &r,
            &ctx("/api/v1/x", "1.1.1.1", Some(42), None)
        ));
    }

    #[test]
    fn test_user_rule_requires_authenticated_request() {
        let r = rule("user", Some("42"), None);
        assert!(rule_matches(&r, &ctx("/x", "1.1.1.1", Some(42), None)));
        assert!(!rule_matches(&r, &ctx("/x", "1.1.1.1", Some(43), None)));
        assert!(!rule_matches(&r, &ctx("/x", "1.1.1.1", None, None)));

        let any_user = rule("user", Some("*"), None);
        assert!(rule_matches(&any_user, &ctx("/x", "1.1.1.1", Some(99), None)));
        assert!(!rule_matches(&any_user, &ctx("/x", "1.1.1.1", None, None)));
    }

    #[test]
    fn test_ip_rule_exact_and_wildcard() {
        let r = rule("ip", Some("9.9.9.9"), None);
        assert!(rule_matches(&r, &ctx("/x", "9.9.9.9", None, None)));
        assert!(!rule_matches(&r, &ctx("/x", "1.1.1.1", None, None)));

        let all = rule("ip", Some("*"), None);
        assert!(rule_matches(&all, &ctx("/x", "anything", None, None)));
    }

    #[test]
    fn test_tenant_rule_matches_only_when_tenant_set() {
        let r = rule("tenant", None, Some(5));
        assert!(rule_matches(&r, &ctx("/x", "1.1.1.1", Some(1), Some(5))));
        assert!(!rule_matches(&r, &ctx("/x", "1.1.1.1", Some(1), Some(6))));
        assert!(!rule_matches(&r, &ctx("/x", "1.1.1.1", Some(1), None)));

        let bad = rule("tenant", None, None);
        assert!(!rule_matches(&bad, &ctx("/x", "1.1.1.1", Some(1), Some(5))));
    }

    #[test]
    fn test_unknown_rule_type_never_matches() {
        let r = rule("garbage", Some("*"), None);
        assert!(!rule_matches(&r, &ctx("/x", "1.1.1.1", None, None)));
    }

    #[test]
    fn test_scope_token_isolates_users_within_endpoint_rule() {
        let r = rule("endpoint", Some("/api/v1/*"), Some(7));
        let a = scope_token_for_rule(&r, &ctx("/api/v1/x", "1.1.1.1", Some(42), Some(7)));
        let b = scope_token_for_rule(&r, &ctx("/api/v1/x", "2.2.2.2", Some(43), Some(7)));
        assert_ne!(a, b, "不同用户在 endpoint 规则下应该有独立的 Redis key");
    }

    // ── Redis 故障降级 ──

    #[test]
    fn test_fallback_mode_from_env() {
        assert_eq!(FallbackMode::from_env_str(""), FallbackMode::Degraded);
        assert_eq!(FallbackMode::from_env_str("degraded"), FallbackMode::Degraded);
        assert_eq!(FallbackMode::from_env_str("DEGRADED"), FallbackMode::Degraded);
        assert_eq!(FallbackMode::from_env_str("closed"), FallbackMode::Closed);
        assert_eq!(FallbackMode::from_env_str("deny"), FallbackMode::Closed);
        assert_eq!(FallbackMode::from_env_str("open"), FallbackMode::Open);
        // 未知值回退到 degraded
        assert_eq!(FallbackMode::from_env_str("xyz"), FallbackMode::Degraded);
    }

    #[test]
    fn test_local_cap() {
        assert_eq!(local_cap(100, 0.5), 50);
        assert_eq!(local_cap(100, 1.0), 100);
        assert_eq!(local_cap(100, 0.25), 25);
        // multiplier=0 时不应该把所有请求都拒掉，至少留 1
        assert_eq!(local_cap(100, 0.0), 1);
        // 超出 [0,1] 自动 clamp
        assert_eq!(local_cap(100, 1.5), 100);
        assert_eq!(local_cap(100, -0.5), 1);
        // max=0 也至少留 1（理论上 max 不应该是 0，但防御一下）
        assert_eq!(local_cap(0, 0.5), 1);
    }

    #[test]
    fn test_local_counters_increment_within_window() {
        let lc = LocalCounters::default();
        assert_eq!(lc.incr("k", 100, 60), 1);
        assert_eq!(lc.incr("k", 100, 60), 2);
        assert_eq!(lc.incr("k", 100, 60), 3);
        // 不同 key 独立计数
        assert_eq!(lc.incr("other", 100, 60), 1);
    }

    #[test]
    fn test_local_counters_reset_after_window() {
        let lc = LocalCounters::default();
        // window=10s, 起点 100s
        assert_eq!(lc.incr("k", 100, 10), 1);
        assert_eq!(lc.incr("k", 105, 10), 2);
        // 110s 时第一个窗口 [100, 110) 已结束，重新计数
        assert_eq!(lc.incr("k", 110, 10), 1);
        assert_eq!(lc.incr("k", 115, 10), 2);
    }

    #[test]
    fn test_local_counters_cleanup_drops_expired_entries() {
        let lc = LocalCounters::default();
        lc.incr("k1", 100, 10);
        lc.incr("k2", 100, 60);
        assert_eq!(lc.len(), 2);
        // now=200 时 k1 的窗口早就过了，k2 还在 [100,160)
        lc.cleanup(200);
        assert_eq!(lc.len(), 0); // 两个都过期
    }

    #[test]
    fn test_fallback_decision_open_mode_allows() {
        // 直接构造 metrics+local 而不走 RateLimiter 完整构造（避免 spawn）
        let local = LocalCounters::default();
        // closed 模式：Redis 缺失 → 立即拒绝
        let result = simulate_fallback(
            FallbackMode::Closed,
            0.5,
            "k",
            100,
            60,
            &local,
        );
        assert!(!result.allowed);
        assert!(result.degraded);

        // open 模式：保留历史一断全放
        let result = simulate_fallback(
            FallbackMode::Open,
            0.5,
            "k",
            100,
            60,
            &local,
        );
        assert!(result.allowed);
        assert!(result.degraded);

        // degraded 模式：本地计数 cap=50（100×0.5），第 1 次必允许
        let result = simulate_fallback(
            FallbackMode::Degraded,
            0.5,
            "k_deg",
            100,
            60,
            &local,
        );
        assert!(result.allowed);
        assert_eq!(result.limit, 50);
        assert_eq!(result.remaining, 49);
    }

    #[test]
    fn test_fallback_decision_degraded_eventually_rejects() {
        let local = LocalCounters::default();
        // cap = 100*0.5 = 50；连打 51 次，第 51 次应该被拒
        let mut last_allowed = true;
        for _ in 0..50 {
            let r = simulate_fallback(FallbackMode::Degraded, 0.5, "spam", 100, 60, &local);
            assert!(r.allowed, "前 50 次必须放行");
            last_allowed = r.allowed;
        }
        let _ = last_allowed;
        let r = simulate_fallback(FallbackMode::Degraded, 0.5, "spam", 100, 60, &local);
        assert!(!r.allowed, "第 51 次必须被本地兑底拒掉");
        assert!(r.degraded);
        assert_eq!(r.remaining, 0);
    }

    /// 仅供单测：复用 RateLimiter::fallback_decision 的纯逻辑（不依赖 tokio runtime）。
    /// 这里手动复刻其核心实现以便在没有完整 RateLimiter 的情况下验证决策。
    fn simulate_fallback(
        mode: FallbackMode,
        multiplier: f64,
        key: &str,
        max_requests: u64,
        window: u64,
        local: &LocalCounters,
    ) -> RateLimitDecision {
        match mode {
            FallbackMode::Open => RateLimitDecision {
                allowed: true,
                limit: max_requests,
                remaining: max_requests,
                window_seconds: window,
                degraded: true,
            },
            FallbackMode::Closed => RateLimitDecision {
                allowed: false,
                limit: max_requests,
                remaining: 0,
                window_seconds: window,
                degraded: true,
            },
            FallbackMode::Degraded => {
                let local_max = local_cap(max_requests, multiplier);
                let count = local.incr(key, 0, window);
                RateLimitDecision {
                    allowed: count <= local_max,
                    limit: local_max,
                    remaining: local_max.saturating_sub(count),
                    window_seconds: window,
                    degraded: true,
                }
            }
        }
    }

    #[test]
    fn test_is_exempt_path_only_health() {
        assert!(is_exempt_path("/health"));
        assert!(is_exempt_path("/health/live"));
        assert!(is_exempt_path("/health/ready"));
        // 防护：/healthcheck 不应该被豁免（避免业务路径碰巧前缀冲突时被误豁免）
        assert!(!is_exempt_path("/healthcheck"));
        assert!(!is_exempt_path("/api/health"));
        assert!(!is_exempt_path("/api/v1/anything"));
        assert!(!is_exempt_path("/"));
    }
}
