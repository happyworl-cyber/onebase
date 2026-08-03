//! 平台级监控：overview / timeseries / 告警配置与评估。
//!
//! 鉴权：路由层挂 `require_superadmin_middleware`；handler 内再兜底一次。

use crate::alert_webhook::post_webhook_json;
use crate::auth::Claims;
use crate::circuit_breaker::{CircuitBreakerManager, CircuitState};
use crate::error::{AppError, Result};
use crate::permissions;
use crate::pool_manager::POOL_MANAGER;
use crate::rate_limiter::RateLimiter;
use crate::redis_manager::RedisManager;
use crate::sse::SseHub;
use crate::sse_notify_bridge::BridgeMetrics;
use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use std::collections::BTreeMap;
use std::time::Duration;

const SAMPLE_LOCK_KEY: i64 = 0x4352_5354_4d4f_4e31; // "CRSTMON1"
const REDIS_DEGRADED_STREAK: u64 = 3;

fn require_superadmin(claims: &Claims) -> Result<()> {
    permissions::require_platform_superadmin(claims)
}

// ─── Snapshot ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
struct TrafficSnapshot {
    qps_5min: Option<f64>,
    p95_ms_5min: Option<f64>,
    error_rate_24h: Option<f64>,
    calls_5min: Option<i64>,
    calls_24h: Option<i64>,
    slow_queries_5min: Option<i64>,
    slow_queries_24h: Option<i64>,
    hourly_24h: Vec<(String, i64, i64)>,
}

#[derive(Debug, Clone, Default)]
struct RuntimeSnapshot {
    mgmt_db_ok: bool,
    redis_status: String, // healthy | unhealthy | not_configured
    redis_ok: bool,
    mgmt_pool_size: u32,
    mgmt_pool_idle: usize,
    active_pools: usize,
    circuit_open_count: i32,
    circuit_half_open_count: i32,
    rate_limit: Option<Value>,
    rate_limit_degraded: bool,
    rate_limit_fallback_rejected: i64,
    version: &'static str,
}

#[derive(Debug, Clone, Default)]
struct AsyncSnapshot {
    execution_stats: Vec<Value>,
    exec_failed_24h: i64,
    scheduler: Option<Value>,
    scheduler_failed_24h: i64,
    sse: Option<Value>,
    sse_connections: i32,
}

async fn collect_traffic(pool: &PgPool) -> std::result::Result<TrafficSnapshot, String> {
    let row = sqlx::query(
        r#"
        WITH
        last_5min AS (
            SELECT duration_ms, response_status
            FROM management.audit_logs
            WHERE created_at >= now() - INTERVAL '5 minutes'
        ),
        last_24h AS (
            SELECT response_status, date_trunc('hour', created_at) AS h
            FROM management.audit_logs
            WHERE created_at >= now() - INTERVAL '24 hours'
        ),
        slow_5 AS (
            SELECT COUNT(*)::bigint AS n
            FROM management.slow_query_logs
            WHERE created_at >= now() - INTERVAL '5 minutes'
        ),
        slow_24 AS (
            SELECT COUNT(*)::bigint AS n
            FROM management.slow_query_logs
            WHERE created_at >= now() - INTERVAL '24 hours'
        ),
        hourly AS (
            SELECT
                h AS hour,
                COUNT(*)::bigint AS cnt,
                COUNT(*) FILTER (WHERE response_status >= 500)::bigint AS err_5xx
            FROM last_24h
            GROUP BY h
        )
        SELECT
            (SELECT COUNT(*)::float8 / 300.0 FROM last_5min) AS qps_5min,
            (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms::float8)
             FROM last_5min WHERE duration_ms IS NOT NULL) AS p95_ms_5min,
            (SELECT COUNT(*)::bigint FROM last_5min) AS calls_5min,
            (SELECT COUNT(*)::bigint FROM last_24h) AS calls_24h,
            CASE WHEN (SELECT COUNT(*) FROM last_24h) = 0 THEN NULL::float8
                 ELSE (SELECT COUNT(*) FILTER (WHERE response_status >= 500)::float8
                       / NULLIF(COUNT(*), 0)::float8 FROM last_24h)
            END AS error_rate_24h,
            (SELECT n FROM slow_5) AS slow_queries_5min,
            (SELECT n FROM slow_24) AS slow_queries_24h,
            COALESCE(
                (SELECT jsonb_agg(
                    jsonb_build_object('hour', hour, 'cnt', cnt, 'err_5xx', err_5xx)
                    ORDER BY hour
                ) FROM hourly),
                '[]'::jsonb
            ) AS hourly_24h
        "#,
    )
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;

    let hourly_raw: Value = row
        .try_get("hourly_24h")
        .unwrap_or_else(|_| Value::Array(vec![]));
    let mut hourly_24h = Vec::new();
    if let Some(arr) = hourly_raw.as_array() {
        for item in arr {
            let hour = item
                .get("hour")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let cnt = item.get("cnt").and_then(|v| v.as_i64()).unwrap_or(0);
            let err = item.get("err_5xx").and_then(|v| v.as_i64()).unwrap_or(0);
            hourly_24h.push((hour, cnt, err));
        }
    }

    Ok(TrafficSnapshot {
        qps_5min: row.try_get("qps_5min").ok(),
        p95_ms_5min: row.try_get("p95_ms_5min").ok(),
        error_rate_24h: row.try_get("error_rate_24h").ok(),
        calls_5min: row.try_get("calls_5min").ok(),
        calls_24h: row.try_get("calls_24h").ok(),
        slow_queries_5min: row.try_get("slow_queries_5min").ok(),
        slow_queries_24h: row.try_get("slow_queries_24h").ok(),
        hourly_24h,
    })
}

async fn collect_runtime(
    pool: &PgPool,
    redis: Option<&RedisManager>,
    cb: Option<&CircuitBreakerManager>,
    limiter: Option<&RateLimiter>,
) -> RuntimeSnapshot {
    let mgmt_db_ok = matches!(
        tokio::time::timeout(Duration::from_secs(2), sqlx::query("SELECT 1").execute(pool)).await,
        Ok(Ok(_))
    );

    let (redis_status, redis_ok) = match redis {
        Some(r) => {
            if r.ping().await.unwrap_or(false) {
                ("healthy".to_string(), true)
            } else {
                ("unhealthy".to_string(), false)
            }
        }
        None => ("not_configured".to_string(), true),
    };

    let mut circuit_open = 0i32;
    let mut circuit_half = 0i32;
    if let Some(mgr) = cb {
        for (_, state) in mgr.status_all() {
            match state {
                CircuitState::Open => circuit_open += 1,
                CircuitState::HalfOpen => circuit_half += 1,
                CircuitState::Closed => {}
            }
        }
    }

    let (rate_limit, rate_limit_degraded, rate_limit_fallback_rejected) =
        if let Some(limiter) = limiter {
            let stats = limiter.stats_snapshot().await;
            let degraded = stats.redis_configured && stats.redis_failures_streak >= REDIS_DEGRADED_STREAK;
            (
                Some(json!(stats)),
                degraded,
                stats.fallback_rejected_total as i64,
            )
        } else {
            (None, false, 0)
        };

    RuntimeSnapshot {
        mgmt_db_ok,
        redis_status,
        redis_ok,
        mgmt_pool_size: pool.size(),
        mgmt_pool_idle: pool.num_idle(),
        active_pools: POOL_MANAGER.active_pools_count(),
        circuit_open_count: circuit_open,
        circuit_half_open_count: circuit_half,
        rate_limit,
        rate_limit_degraded,
        rate_limit_fallback_rejected,
        version: env!("CARGO_PKG_VERSION"),
    }
}

async fn collect_async(
    pool: &PgPool,
    hub: Option<&SseHub>,
    bridge: Option<&BridgeMetrics>,
) -> std::result::Result<AsyncSnapshot, String> {
    let exec_rows = sqlx::query(
        "SELECT source, status, COUNT(*)::bigint AS cnt \
         FROM management.execution_index \
         WHERE started_at >= NOW() - INTERVAL '24 hours' \
         GROUP BY source, status",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut exec_failed_24h = 0i64;
    let execution_stats: Vec<Value> = exec_rows
        .iter()
        .map(|r| {
            let status: String = r.get("status");
            let count: i64 = r.get("cnt");
            if status == "failed" || status == "timeout" || status == "error" {
                exec_failed_24h += count;
            }
            json!({
                "source": r.get::<String, _>("source"),
                "status": status,
                "count": count,
            })
        })
        .collect();

    let total_tasks: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM management.scheduled_tasks",
    )
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    let active_tasks: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM management.scheduled_tasks WHERE is_active = true",
    )
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    let runs_24h: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM management.scheduled_task_runs \
         WHERE started_at >= NOW() - INTERVAL '24 hours'",
    )
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    let scheduler_failed_24h: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM management.scheduled_task_runs \
         WHERE started_at >= NOW() - INTERVAL '24 hours' \
           AND status IN ('failed','timeout')",
    )
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;

    let sse = hub.map(|h| {
        let conns = h.connection_metas();
        let total = conns.len();
        let public = conns.iter().filter(|c| c.kind == "public").count();
        let generic = conns.iter().filter(|c| c.kind == "sse").count();
        let listeners = bridge
            .map(|b| json!(b.snapshot()))
            .unwrap_or_else(|| json!([]));
        json!({
            "connections": {
                "total": total,
                "public": public,
                "generic": generic,
            },
            "listeners": listeners,
            "pushes_total": h.pushes_total(),
        })
    });
    let sse_connections = sse
        .as_ref()
        .and_then(|v| v.pointer("/connections/total"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as i32;

    Ok(AsyncSnapshot {
        execution_stats,
        exec_failed_24h,
        scheduler: Some(json!({
            "total_tasks": total_tasks,
            "active_tasks": active_tasks,
            "runs_24h": runs_24h,
            "failed_24h": scheduler_failed_24h,
        })),
        scheduler_failed_24h,
        sse,
        sse_connections,
    })
}

/// 预警信号：一次查询把「即将变坏 / 已经异常但未必致命」的隐患拉齐。
/// 任何子项失败都不致命——查询整体失败时返回 None，overview 用 warnings 标注。
#[derive(Debug, Clone, Default)]
struct Signals {
    rate_limited_429_1h: i64,
    auth_failures_1h: i64,
    stuck_running: i64,
    stuck_workflow: i64,
    expiring_api_keys_7d: i64,
    expiring_tokens_7d: i64,
    webhook_failures_24h: i64,
}

async fn collect_signals(pool: &PgPool) -> std::result::Result<Signals, String> {
    let row = sqlx::query(
        r#"
        SELECT
          (SELECT COUNT(*)::bigint FROM management.audit_logs
             WHERE response_status = 429 AND created_at >= now() - INTERVAL '1 hour') AS rl_429_1h,
          (SELECT COUNT(*)::bigint FROM management.audit_logs
             WHERE response_status IN (401, 403) AND created_at >= now() - INTERVAL '1 hour') AS auth_fail_1h,
          (SELECT COUNT(*)::bigint FROM management.execution_index
             WHERE status = 'running' AND started_at < now() - INTERVAL '10 minutes') AS stuck_running,
          (SELECT COUNT(*)::bigint FROM management.workflow_runs
             WHERE status = 'running' AND started_at < now() - INTERVAL '10 minutes') AS stuck_workflow,
          (SELECT COUNT(*)::bigint FROM management.api_keys
             WHERE COALESCE(is_active, false) = true
               AND expires_at IS NOT NULL
               AND expires_at BETWEEN now() AND now() + INTERVAL '7 days') AS exp_api_keys_7d,
          (SELECT COUNT(*)::bigint FROM management.platform_tokens
             WHERE expires_at IS NOT NULL
               AND expires_at BETWEEN now() AND now() + INTERVAL '7 days') AS exp_tokens_7d,
          (SELECT COUNT(*)::bigint FROM management.webhook_logs
             WHERE success = false AND created_at >= now() - INTERVAL '24 hours') AS webhook_fail_24h
        "#,
    )
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(Signals {
        rate_limited_429_1h: row.try_get("rl_429_1h").unwrap_or(0),
        auth_failures_1h: row.try_get("auth_fail_1h").unwrap_or(0),
        stuck_running: row.try_get("stuck_running").unwrap_or(0),
        stuck_workflow: row.try_get("stuck_workflow").unwrap_or(0),
        expiring_api_keys_7d: row.try_get("exp_api_keys_7d").unwrap_or(0),
        expiring_tokens_7d: row.try_get("exp_tokens_7d").unwrap_or(0),
        webhook_failures_24h: row.try_get("webhook_fail_24h").unwrap_or(0),
    })
}

fn build_anomalies(traffic: &TrafficSnapshot, runtime: &RuntimeSnapshot, asyncs: &AsyncSnapshot) -> Vec<Value> {
    let mut out = Vec::new();
    if !runtime.mgmt_db_ok {
        out.push(json!({"level":"critical","code":"mgmt_db","message":"管理库健康检查失败"}));
    }
    if runtime.redis_status == "unhealthy" {
        out.push(json!({"level":"critical","code":"redis","message":"Redis ping 失败"}));
    }
    if runtime.circuit_open_count > 0 {
        out.push(json!({
            "level":"warning",
            "code":"circuit_open",
            "message": format!("{} 个数据库熔断 Open", runtime.circuit_open_count),
        }));
    }
    if runtime.rate_limit_degraded {
        out.push(json!({"level":"warning","code":"rate_limit_degraded","message":"限流器处于 Redis 降级模式"}));
    }
    if let Some(rate) = traffic.error_rate_24h {
        if rate > 0.05 {
            out.push(json!({
                "level":"warning",
                "code":"error_rate",
                "message": format!("24h 错误率 {:.1}%", rate * 100.0),
            }));
        }
    }
    if let Some(slow) = traffic.slow_queries_5min {
        if slow > 20 {
            out.push(json!({
                "level":"warning",
                "code":"slow_queries",
                "message": format!("近 5 分钟慢查询 {} 条", slow),
            }));
        }
    }
    if asyncs.exec_failed_24h > 50 {
        out.push(json!({
            "level":"warning",
            "code":"exec_failed",
            "message": format!("24h 异步执行失败 {} 次", asyncs.exec_failed_24h),
        }));
    }
    out
}

/// 把预警信号转成异常清单条目（有阈值才冒泡，避免噪声）。
fn signals_to_anomalies(s: &Signals) -> Vec<Value> {
    let mut out = Vec::new();
    if s.stuck_running > 0 {
        out.push(json!({"level":"warning","code":"stuck_running","message":format!("{} 条执行 running 超过 10 分钟（疑似卡死）", s.stuck_running)}));
    }
    if s.stuck_workflow > 0 {
        out.push(json!({"level":"warning","code":"stuck_workflow","message":format!("{} 个工作流 run 卡在 running", s.stuck_workflow)}));
    }
    if s.auth_failures_1h >= 20 {
        out.push(json!({"level":"warning","code":"auth_failures","message":format!("近 1h 认证失败(401/403) {} 次", s.auth_failures_1h)}));
    }
    if s.rate_limited_429_1h >= 20 {
        out.push(json!({"level":"warning","code":"rate_limited","message":format!("近 1h 触发限流(429) {} 次", s.rate_limited_429_1h)}));
    }
    if s.webhook_failures_24h > 0 {
        out.push(json!({"level":"info","code":"webhook_failed","message":format!("24h Webhook 投递失败 {} 次", s.webhook_failures_24h)}));
    }
    if s.expiring_api_keys_7d > 0 {
        out.push(json!({"level":"info","code":"api_key_expiring","message":format!("{} 个 API Key 将在 7 天内过期", s.expiring_api_keys_7d)}));
    }
    if s.expiring_tokens_7d > 0 {
        out.push(json!({"level":"info","code":"token_expiring","message":format!("{} 个平台令牌将在 7 天内过期", s.expiring_tokens_7d)}));
    }
    out
}

fn metric_value(
    metric: &str,
    traffic: &TrafficSnapshot,
    runtime: &RuntimeSnapshot,
    asyncs: &AsyncSnapshot,
) -> Option<f64> {
    match metric {
        "error_rate_24h" => traffic.error_rate_24h,
        "circuit_open_count" => Some(runtime.circuit_open_count as f64),
        "rate_limit_degraded" => Some(if runtime.rate_limit_degraded { 1.0 } else { 0.0 }),
        "slow_queries_5min" => traffic.slow_queries_5min.map(|v| v as f64),
        "exec_failed_24h" => Some(asyncs.exec_failed_24h as f64),
        "scheduler_failed_24h" => Some(asyncs.scheduler_failed_24h as f64),
        "mgmt_db_ok" => Some(if runtime.mgmt_db_ok { 1.0 } else { 0.0 }),
        "redis_ok" => Some(if runtime.redis_ok { 1.0 } else { 0.0 }),
        "qps_5min" => traffic.qps_5min,
        "p95_ms_5min" => traffic.p95_ms_5min,
        _ => None,
    }
}

pub fn eval_rule(operator: &str, value: f64, threshold: f64) -> bool {
    match operator {
        ">" => value > threshold,
        ">=" => value >= threshold,
        "==" => (value - threshold).abs() < f64::EPSILON,
        "<" => value < threshold,
        "<=" => value <= threshold,
        _ => false,
    }
}

// ─── Handlers ───────────────────────────────────────────────────────────────

/// GET /api/admin/platform-monitor/overview
pub async fn overview(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    redis: Option<Extension<RedisManager>>,
    cb: Option<Extension<CircuitBreakerManager>>,
    limiter: Option<Extension<RateLimiter>>,
    hub: Option<Extension<SseHub>>,
    bridge: Option<Extension<BridgeMetrics>>,
) -> Result<Json<Value>> {
    require_superadmin(&claims)?;

    let mut warnings: Vec<String> = Vec::new();

    let traffic = match collect_traffic(&pool).await {
        Ok(t) => t,
        Err(e) => {
            warnings.push(format!("traffic: {e}"));
            TrafficSnapshot::default()
        }
    };

    let runtime = collect_runtime(
        &pool,
        redis.as_ref().map(|Extension(r)| r),
        cb.as_ref().map(|Extension(c)| c),
        limiter.as_ref().map(|Extension(l)| l),
    )
    .await;

    let asyncs = match collect_async(
        &pool,
        hub.as_ref().map(|Extension(h)| h),
        bridge.as_ref().map(|Extension(b)| b),
    )
    .await
    {
        Ok(a) => a,
        Err(e) => {
            warnings.push(format!("async: {e}"));
            AsyncSnapshot::default()
        }
    };

    let signals = match collect_signals(&pool).await {
        Ok(s) => s,
        Err(e) => {
            warnings.push(format!("signals: {e}"));
            Signals::default()
        }
    };

    let mut anomalies = build_anomalies(&traffic, &runtime, &asyncs);
    anomalies.extend(signals_to_anomalies(&signals));
    let hourly: Vec<Value> = traffic
        .hourly_24h
        .iter()
        .map(|(h, c, e)| json!({"hour": h, "count": c, "err_5xx": e}))
        .collect();

    Ok(Json(json!({
        "health": {
            "mgmt_db": if runtime.mgmt_db_ok { "healthy" } else { "unhealthy" },
            "redis": runtime.redis_status,
            "version": runtime.version,
            "mgmt_pool": {
                "size": runtime.mgmt_pool_size,
                "idle": runtime.mgmt_pool_idle,
            },
            "active_pools": runtime.active_pools,
        },
        "traffic": {
            "qps_5min": traffic.qps_5min,
            "p95_ms_5min": traffic.p95_ms_5min,
            "error_rate_24h": traffic.error_rate_24h,
            "calls_5min": traffic.calls_5min,
            "calls_24h": traffic.calls_24h,
            "slow_queries_5min": traffic.slow_queries_5min,
            "slow_queries_24h": traffic.slow_queries_24h,
            "hourly_24h": hourly,
        },
        "runtime": {
            "circuit_open_count": runtime.circuit_open_count,
            "circuit_half_open_count": runtime.circuit_half_open_count,
            "rate_limit_degraded": runtime.rate_limit_degraded,
            "rate_limit": runtime.rate_limit,
        },
        "async": {
            "execution_stats": asyncs.execution_stats,
            "exec_failed_24h": asyncs.exec_failed_24h,
            "scheduler": asyncs.scheduler,
            "sse": asyncs.sse,
        },
        "signals": {
            "rate_limited_429_1h": signals.rate_limited_429_1h,
            "auth_failures_1h": signals.auth_failures_1h,
            "stuck_running": signals.stuck_running,
            "stuck_workflow": signals.stuck_workflow,
            "expiring_api_keys_7d": signals.expiring_api_keys_7d,
            "expiring_tokens_7d": signals.expiring_tokens_7d,
            "webhook_failures_24h": signals.webhook_failures_24h,
        },
        "anomalies": anomalies,
        "warnings": warnings,
    })))
}

// ─── Root-cause drill-down ──────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct TopEndpointsQuery {
    #[serde(default = "default_window")]
    pub window: String,
    #[serde(default = "default_order")]
    pub order: String,
}

fn default_window() -> String {
    "1h".to_string()
}
fn default_order() -> String {
    "errors".to_string()
}

/// GET /api/admin/platform-monitor/top-endpoints
/// 按路径聚合近 window 的调用量 / 错误 / 延迟，用于定位「哪个接口在拖后腿」。
pub async fn top_endpoints(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(q): Query<TopEndpointsQuery>,
) -> Result<Json<Value>> {
    require_superadmin(&claims)?;
    let interval = match q.window.as_str() {
        "24h" => "24 hours",
        "6h" => "6 hours",
        _ => "1 hour",
    };
    let order_col = match q.order.as_str() {
        "latency" => "p95 DESC NULLS LAST",
        "calls" => "calls DESC",
        _ => "err_5xx DESC, calls DESC",
    };
    let sql = format!(
        "SELECT request_path, \
                COUNT(*)::bigint AS calls, \
                COUNT(*) FILTER (WHERE response_status >= 500)::bigint AS err_5xx, \
                COUNT(*) FILTER (WHERE response_status >= 400 AND response_status < 500)::bigint AS err_4xx, \
                percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms::float8) AS p95, \
                AVG(duration_ms)::float8 AS avg_ms \
         FROM management.audit_logs \
         WHERE created_at >= now() - INTERVAL '{interval}' \
         GROUP BY request_path \
         ORDER BY {order_col} \
         LIMIT 25"
    );
    let rows = sqlx::query(&sql)
        .fetch_all(&pool)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "request_path": r.get::<String, _>("request_path"),
                "calls": r.get::<i64, _>("calls"),
                "err_5xx": r.get::<i64, _>("err_5xx"),
                "err_4xx": r.get::<i64, _>("err_4xx"),
                "p95": r.try_get::<Option<f64>, _>("p95").ok().flatten(),
                "avg_ms": r.try_get::<Option<f64>, _>("avg_ms").ok().flatten(),
            })
        })
        .collect();
    Ok(Json(json!({ "window": q.window, "order": q.order, "data": data })))
}

/// GET /api/admin/platform-monitor/recent-errors
/// 最近失败执行（带 trace_id 可跳执行日志）+ 最近 5xx 请求，问题发生时的第一落点。
pub async fn recent_errors(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(q): Query<AlertEventsQuery>,
) -> Result<Json<Value>> {
    require_superadmin(&claims)?;
    let limit = q.limit.clamp(1, 200);

    let exec_rows = sqlx::query(
        "SELECT trace_id, source, name, status, tenant_id, \
                started_at::TEXT AS started_at, duration_ms, error_brief \
         FROM management.execution_index \
         WHERE status IN ('failed','timeout') \
         ORDER BY started_at DESC LIMIT $1",
    )
    .bind(limit)
    .fetch_all(&pool)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    let failed_executions: Vec<Value> = exec_rows
        .iter()
        .map(|r| {
            json!({
                "trace_id": r.get::<String, _>("trace_id"),
                "source": r.get::<String, _>("source"),
                "name": r.try_get::<Option<String>, _>("name").ok().flatten(),
                "status": r.get::<String, _>("status"),
                "tenant_id": r.try_get::<Option<i32>, _>("tenant_id").ok().flatten(),
                "started_at": r.get::<String, _>("started_at"),
                "duration_ms": r.try_get::<Option<i32>, _>("duration_ms").ok().flatten(),
                "error_brief": r.try_get::<Option<String>, _>("error_brief").ok().flatten(),
            })
        })
        .collect();

    let http_rows = sqlx::query(
        "SELECT request_method, request_path, response_status, tenant_id, \
                duration_ms, ip_address, created_at::TEXT AS created_at \
         FROM management.audit_logs \
         WHERE response_status >= 500 \
         ORDER BY created_at DESC LIMIT $1",
    )
    .bind(limit)
    .fetch_all(&pool)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    let http_5xx: Vec<Value> = http_rows
        .iter()
        .map(|r| {
            json!({
                "request_method": r.get::<String, _>("request_method"),
                "request_path": r.get::<String, _>("request_path"),
                "response_status": r.try_get::<Option<i32>, _>("response_status").ok().flatten(),
                "tenant_id": r.try_get::<Option<i32>, _>("tenant_id").ok().flatten(),
                "duration_ms": r.try_get::<Option<i32>, _>("duration_ms").ok().flatten(),
                "ip_address": r.try_get::<Option<String>, _>("ip_address").ok().flatten(),
                "created_at": r.get::<String, _>("created_at"),
            })
        })
        .collect();

    Ok(Json(json!({
        "failed_executions": failed_executions,
        "http_5xx": http_5xx,
    })))
}

#[derive(Debug, Deserialize)]
pub struct TenantBreakdownQuery {
    #[serde(default = "default_range")]
    pub range: String,
}

/// GET /api/admin/platform-monitor/tenant-breakdown
/// 按租户聚合调用 / 错误 / P95 / 慢查询，用于判断「问题是全局还是某个租户」。
pub async fn tenant_breakdown(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(q): Query<TenantBreakdownQuery>,
) -> Result<Json<Value>> {
    require_superadmin(&claims)?;
    let interval = match q.range.as_str() {
        "7d" => "7 days",
        "1h" => "1 hour",
        _ => "24 hours",
    };
    let sql = format!(
        "SELECT a.tenant_id, t.name AS tenant_name, \
                COUNT(*)::bigint AS calls, \
                COUNT(*) FILTER (WHERE a.response_status >= 500)::bigint AS err_5xx, \
                percentile_cont(0.95) WITHIN GROUP (ORDER BY a.duration_ms::float8) AS p95, \
                (SELECT COUNT(*)::bigint FROM management.slow_query_logs s \
                   WHERE s.tenant_id = a.tenant_id \
                     AND s.created_at >= now() - INTERVAL '{interval}') AS slow_queries \
         FROM management.audit_logs a \
         LEFT JOIN management.tenants t ON t.id = a.tenant_id \
         WHERE a.created_at >= now() - INTERVAL '{interval}' \
         GROUP BY a.tenant_id, t.name \
         ORDER BY err_5xx DESC, calls DESC \
         LIMIT 50"
    );
    let rows = sqlx::query(&sql)
        .fetch_all(&pool)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "tenant_id": r.try_get::<Option<i32>, _>("tenant_id").ok().flatten(),
                "tenant_name": r.try_get::<Option<String>, _>("tenant_name").ok().flatten(),
                "calls": r.get::<i64, _>("calls"),
                "err_5xx": r.get::<i64, _>("err_5xx"),
                "p95": r.try_get::<Option<f64>, _>("p95").ok().flatten(),
                "slow_queries": r.try_get::<i64, _>("slow_queries").unwrap_or(0),
            })
        })
        .collect();
    Ok(Json(json!({ "range": q.range, "data": data })))
}

#[derive(Debug, Deserialize)]
pub struct TimeseriesQuery {
    #[serde(default = "default_range")]
    pub range: String,
}

fn default_range() -> String {
    "24h".to_string()
}

/// GET /api/admin/platform-monitor/timeseries
pub async fn timeseries(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(q): Query<TimeseriesQuery>,
) -> Result<Json<Value>> {
    require_superadmin(&claims)?;

    let interval = match q.range.as_str() {
        "7d" => "7 days",
        _ => "24 hours",
    };

    let rows = sqlx::query(
        &format!(
            "SELECT sampled_at::TEXT AS sampled_at, qps_5min, p95_ms_5min, error_rate_24h, \
                    calls_5min, slow_queries_5min, circuit_open_count, rate_limit_degraded, \
                    exec_failed_24h, scheduler_failed_24h, sse_connections, \
                    mgmt_db_ok, redis_ok \
             FROM management.platform_metric_samples \
             WHERE sampled_at >= NOW() - INTERVAL '{interval}' \
             ORDER BY sampled_at ASC"
        ),
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    let points: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "sampled_at": r.get::<String, _>("sampled_at"),
                "qps_5min": r.try_get::<Option<f64>, _>("qps_5min").ok().flatten(),
                "p95_ms_5min": r.try_get::<Option<f64>, _>("p95_ms_5min").ok().flatten(),
                "error_rate_24h": r.try_get::<Option<f64>, _>("error_rate_24h").ok().flatten(),
                "calls_5min": r.try_get::<Option<i64>, _>("calls_5min").ok().flatten(),
                "slow_queries_5min": r.try_get::<Option<i64>, _>("slow_queries_5min").ok().flatten(),
                "circuit_open_count": r.try_get::<Option<i32>, _>("circuit_open_count").ok().flatten(),
                "rate_limit_degraded": r.try_get::<Option<bool>, _>("rate_limit_degraded").ok().flatten(),
                "exec_failed_24h": r.try_get::<Option<i64>, _>("exec_failed_24h").ok().flatten(),
                "scheduler_failed_24h": r.try_get::<Option<i64>, _>("scheduler_failed_24h").ok().flatten(),
                "sse_connections": r.try_get::<Option<i32>, _>("sse_connections").ok().flatten(),
                "mgmt_db_ok": r.try_get::<Option<bool>, _>("mgmt_db_ok").ok().flatten(),
                "redis_ok": r.try_get::<Option<bool>, _>("redis_ok").ok().flatten(),
            })
        })
        .collect();

    Ok(Json(json!({ "range": q.range, "points": points })))
}

/// GET /api/admin/platform-monitor/alert-config
pub async fn get_alert_config(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Value>> {
    require_superadmin(&claims)?;
    let row = sqlx::query(
        "SELECT enabled, webhook_url, webhook_template, default_throttle_hours, \
                updated_at::TEXT AS updated_at \
         FROM management.platform_alert_config WHERE id = 1",
    )
    .fetch_optional(&pool)
    .await?;

    let Some(row) = row else {
        return Ok(Json(json!({
            "enabled": false,
            "webhook_url": null,
            "webhook_template": null,
            "default_throttle_hours": 1,
            "updated_at": null,
        })));
    };

    Ok(Json(json!({
        "enabled": row.get::<bool, _>("enabled"),
        "webhook_url": row.try_get::<Option<String>, _>("webhook_url").ok().flatten(),
        "webhook_template": row.try_get::<Option<Value>, _>("webhook_template").ok().flatten(),
        "default_throttle_hours": row.get::<i32, _>("default_throttle_hours"),
        "updated_at": row.get::<String, _>("updated_at"),
    })))
}

#[derive(Debug, Deserialize)]
pub struct AlertConfigUpdate {
    pub enabled: Option<bool>,
    pub webhook_url: Option<Option<String>>,
    pub webhook_template: Option<Option<Value>>,
    pub default_throttle_hours: Option<i32>,
}

/// PUT /api/admin/platform-monitor/alert-config
pub async fn put_alert_config(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<AlertConfigUpdate>,
) -> Result<Json<Value>> {
    require_superadmin(&claims)?;

    if let Some(Some(ref url)) = body.webhook_url {
        let t = url.trim();
        if t.is_empty() || !(t.starts_with("http://") || t.starts_with("https://")) {
            return Err(AppError::InvalidQuery(
                "webhook_url 必须是 http(s) URL，或传 null 清空".into(),
            ));
        }
    }
    if let Some(hours) = body.default_throttle_hours {
        if !(0..=720).contains(&hours) {
            return Err(AppError::InvalidQuery(
                "default_throttle_hours 需在 0..=720".into(),
            ));
        }
    }
    if let Some(Some(ref tmpl)) = body.webhook_template {
        if !tmpl.is_object() {
            return Err(AppError::InvalidQuery(
                "webhook_template 必须是 JSON object".into(),
            ));
        }
    }

    sqlx::query(
        "INSERT INTO management.platform_alert_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING",
    )
    .execute(&pool)
    .await?;

    // 逐字段更新，避免覆盖未传字段
    if let Some(enabled) = body.enabled {
        sqlx::query("UPDATE management.platform_alert_config SET enabled = $1, updated_at = NOW() WHERE id = 1")
            .bind(enabled)
            .execute(&pool)
            .await?;
    }
    if let Some(url) = body.webhook_url {
        sqlx::query("UPDATE management.platform_alert_config SET webhook_url = $1, updated_at = NOW() WHERE id = 1")
            .bind(url.as_deref().map(str::trim))
            .execute(&pool)
            .await?;
    }
    if let Some(tmpl) = body.webhook_template {
        sqlx::query("UPDATE management.platform_alert_config SET webhook_template = $1, updated_at = NOW() WHERE id = 1")
            .bind(tmpl)
            .execute(&pool)
            .await?;
    }
    if let Some(hours) = body.default_throttle_hours {
        sqlx::query("UPDATE management.platform_alert_config SET default_throttle_hours = $1, updated_at = NOW() WHERE id = 1")
            .bind(hours)
            .execute(&pool)
            .await?;
    }

    get_alert_config(State(pool), Extension(claims)).await
}

/// GET /api/admin/platform-monitor/alert-rules
pub async fn list_alert_rules(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Value>> {
    require_superadmin(&claims)?;
    let rows = sqlx::query(
        "SELECT id, name, metric, operator, threshold, metric_window, enabled, throttle_hours, \
                last_fired_at::TEXT AS last_fired_at, created_at::TEXT AS created_at, \
                updated_at::TEXT AS updated_at \
         FROM management.platform_alert_rules ORDER BY id",
    )
    .fetch_all(&pool)
    .await?;

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<i64, _>("id"),
                "name": r.get::<String, _>("name"),
                "metric": r.get::<String, _>("metric"),
                "operator": r.get::<String, _>("operator"),
                "threshold": r.get::<f64, _>("threshold"),
                "window": r.get::<String, _>("metric_window"),
                "enabled": r.get::<bool, _>("enabled"),
                "throttle_hours": r.try_get::<Option<i32>, _>("throttle_hours").ok().flatten(),
                "last_fired_at": r.try_get::<Option<String>, _>("last_fired_at").ok().flatten(),
                "created_at": r.get::<String, _>("created_at"),
                "updated_at": r.get::<String, _>("updated_at"),
            })
        })
        .collect();
    Ok(Json(json!({ "data": data })))
}

#[derive(Debug, Deserialize)]
pub struct AlertRuleBody {
    pub name: Option<String>,
    pub metric: Option<String>,
    pub operator: Option<String>,
    pub threshold: Option<f64>,
    pub window: Option<String>,
    pub enabled: Option<bool>,
    pub throttle_hours: Option<Option<i32>>,
}

fn validate_metric(m: &str) -> Result<()> {
    const OK: &[&str] = &[
        "error_rate_24h",
        "circuit_open_count",
        "rate_limit_degraded",
        "slow_queries_5min",
        "exec_failed_24h",
        "mgmt_db_ok",
        "redis_ok",
        "qps_5min",
        "p95_ms_5min",
        "scheduler_failed_24h",
    ];
    if OK.contains(&m) {
        Ok(())
    } else {
        Err(AppError::InvalidQuery(format!("不支持的 metric: {m}")))
    }
}

fn validate_operator(op: &str) -> Result<()> {
    if matches!(op, ">" | ">=" | "==" | "<" | "<=") {
        Ok(())
    } else {
        Err(AppError::InvalidQuery(format!("不支持的 operator: {op}")))
    }
}

/// POST /api/admin/platform-monitor/alert-rules
pub async fn create_alert_rule(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<AlertRuleBody>,
) -> Result<Json<Value>> {
    require_superadmin(&claims)?;
    let name = body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::InvalidQuery("name 必填".into()))?;
    let metric = body
        .metric
        .as_deref()
        .ok_or_else(|| AppError::InvalidQuery("metric 必填".into()))?;
    let operator = body
        .operator
        .as_deref()
        .ok_or_else(|| AppError::InvalidQuery("operator 必填".into()))?;
    let threshold = body
        .threshold
        .ok_or_else(|| AppError::InvalidQuery("threshold 必填".into()))?;
    validate_metric(metric)?;
    validate_operator(operator)?;
    let metric_window = body.window.unwrap_or_else(|| "live".to_string());
    let enabled = body.enabled.unwrap_or(true);
    let throttle = body.throttle_hours.flatten();

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO management.platform_alert_rules \
         (name, metric, operator, threshold, metric_window, enabled, throttle_hours) \
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
    )
    .bind(name)
    .bind(metric)
    .bind(operator)
    .bind(threshold)
    .bind(&metric_window)
    .bind(enabled)
    .bind(throttle)
    .fetch_one(&pool)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(json!({ "id": id, "message": "created" })))
}

/// PATCH /api/admin/platform-monitor/alert-rules/:id
pub async fn patch_alert_rule(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
    Json(body): Json<AlertRuleBody>,
) -> Result<Json<Value>> {
    require_superadmin(&claims)?;

    if let Some(ref m) = body.metric {
        validate_metric(m)?;
    }
    if let Some(ref op) = body.operator {
        validate_operator(op)?;
    }

    let row = sqlx::query(
        "SELECT name, metric, operator, threshold, metric_window, enabled, throttle_hours \
         FROM management.platform_alert_rules WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("规则 {id} 不存在")))?;

    let name = body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| row.get("name"));
    let metric = body.metric.clone().unwrap_or_else(|| row.get("metric"));
    let operator = body.operator.clone().unwrap_or_else(|| row.get("operator"));
    let threshold = body.threshold.unwrap_or_else(|| row.get("threshold"));
    let metric_window = body
        .window
        .clone()
        .unwrap_or_else(|| row.get("metric_window"));
    let enabled = body.enabled.unwrap_or_else(|| row.get("enabled"));
    let throttle = match body.throttle_hours {
        Some(v) => v,
        None => row.try_get("throttle_hours").ok(),
    };

    let n = sqlx::query(
        "UPDATE management.platform_alert_rules SET \
         name=$1, metric=$2, operator=$3, threshold=$4, metric_window=$5, \
         enabled=$6, throttle_hours=$7, updated_at=NOW() WHERE id=$8",
    )
    .bind(&name)
    .bind(&metric)
    .bind(&operator)
    .bind(threshold)
    .bind(&metric_window)
    .bind(enabled)
    .bind(throttle)
    .bind(id)
    .execute(&pool)
    .await?
    .rows_affected();

    if n == 0 {
        return Err(AppError::NotFound(format!("规则 {id} 不存在")));
    }
    Ok(Json(json!({ "id": id, "message": "updated" })))
}

/// DELETE /api/admin/platform-monitor/alert-rules/:id
pub async fn delete_alert_rule(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<Value>> {
    require_superadmin(&claims)?;
    let n = sqlx::query("DELETE FROM management.platform_alert_rules WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound(format!("规则 {id} 不存在")));
    }
    Ok(Json(json!({ "message": "deleted" })))
}

#[derive(Debug, Deserialize)]
pub struct AlertEventsQuery {
    #[serde(default = "default_events_limit")]
    pub limit: i64,
}

fn default_events_limit() -> i64 {
    50
}

/// GET /api/admin/platform-monitor/alert-events
pub async fn list_alert_events(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(q): Query<AlertEventsQuery>,
) -> Result<Json<Value>> {
    require_superadmin(&claims)?;
    let limit = q.limit.clamp(1, 200);
    let rows = sqlx::query(
        "SELECT id, rule_id, rule_name, metric, value, threshold, status, error, \
                created_at::TEXT AS created_at \
         FROM management.platform_alert_events \
         ORDER BY created_at DESC LIMIT $1",
    )
    .bind(limit)
    .fetch_all(&pool)
    .await?;

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<i64, _>("id"),
                "rule_id": r.try_get::<Option<i64>, _>("rule_id").ok().flatten(),
                "rule_name": r.get::<String, _>("rule_name"),
                "metric": r.get::<String, _>("metric"),
                "value": r.try_get::<Option<f64>, _>("value").ok().flatten(),
                "threshold": r.try_get::<Option<f64>, _>("threshold").ok().flatten(),
                "status": r.get::<String, _>("status"),
                "error": r.try_get::<Option<String>, _>("error").ok().flatten(),
                "created_at": r.get::<String, _>("created_at"),
            })
        })
        .collect();
    Ok(Json(json!({ "data": data })))
}

// ─── Sampler + alert evaluation ─────────────────────────────────────────────

fn platform_default_template() -> Value {
    json!({
        "msg_type": "markdown",
        "content": "### \u{1F6A8} 平台监控报警\n- **规则**: {{rule_name}}\n- **指标**: {{metric}}\n- **当前值**: {{value}}\n- **阈值**: {{threshold}}\n- **时间**: {{time}}"
    })
}

async fn insert_sample(
    pool: &PgPool,
    traffic: &TrafficSnapshot,
    runtime: &RuntimeSnapshot,
    asyncs: &AsyncSnapshot,
) -> std::result::Result<(), String> {
    sqlx::query(
        "INSERT INTO management.platform_metric_samples (\
            qps_5min, p95_ms_5min, error_rate_24h, calls_5min, slow_queries_5min, \
            mgmt_db_ok, redis_ok, mgmt_pool_size, mgmt_pool_idle, active_pools, \
            circuit_open_count, rate_limit_degraded, rate_limit_fallback_rejected, \
            exec_failed_24h, scheduler_failed_24h, sse_connections\
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)",
    )
    .bind(traffic.qps_5min)
    .bind(traffic.p95_ms_5min)
    .bind(traffic.error_rate_24h)
    .bind(traffic.calls_5min)
    .bind(traffic.slow_queries_5min)
    .bind(runtime.mgmt_db_ok)
    .bind(runtime.redis_ok)
    .bind(runtime.mgmt_pool_size as i32)
    .bind(runtime.mgmt_pool_idle as i32)
    .bind(runtime.active_pools as i32)
    .bind(runtime.circuit_open_count)
    .bind(runtime.rate_limit_degraded)
    .bind(runtime.rate_limit_fallback_rejected)
    .bind(asyncs.exec_failed_24h)
    .bind(asyncs.scheduler_failed_24h)
    .bind(asyncs.sse_connections)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

async fn cleanup_old_samples(pool: &PgPool) {
    if let Err(e) = sqlx::query(
        "DELETE FROM management.platform_metric_samples \
         WHERE sampled_at < NOW() - INTERVAL '7 days'",
    )
    .execute(pool)
    .await
    {
        tracing::warn!(error = %e, "清理 platform_metric_samples 失败");
    }
}

async fn evaluate_alerts(
    pool: &PgPool,
    traffic: &TrafficSnapshot,
    runtime: &RuntimeSnapshot,
    asyncs: &AsyncSnapshot,
) {
    let cfg = match sqlx::query(
        "SELECT enabled, webhook_url, webhook_template, default_throttle_hours \
         FROM management.platform_alert_config WHERE id = 1",
    )
    .fetch_optional(pool)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return,
        Err(e) => {
            tracing::warn!(error = %e, "读取 platform_alert_config 失败");
            return;
        }
    };

    let enabled: bool = cfg.get("enabled");
    if !enabled {
        return;
    }
    let webhook_url: Option<String> = cfg.try_get("webhook_url").ok().flatten();
    let Some(webhook_url) = webhook_url.filter(|u| !u.trim().is_empty()) else {
        return;
    };
    let template: Value = cfg
        .try_get::<Option<Value>, _>("webhook_template")
        .ok()
        .flatten()
        .unwrap_or_else(platform_default_template);
    let default_throttle: i32 = cfg.get("default_throttle_hours");

    let rules = match sqlx::query(
        "SELECT id, name, metric, operator, threshold, throttle_hours \
         FROM management.platform_alert_rules WHERE enabled = true",
    )
    .fetch_all(pool)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "读取 platform_alert_rules 失败");
            return;
        }
    };

    for rule in rules {
        let id: i64 = rule.get("id");
        let name: String = rule.get("name");
        let metric: String = rule.get("metric");
        let operator: String = rule.get("operator");
        let threshold: f64 = rule.get("threshold");
        let throttle: i32 = rule
            .try_get::<Option<i32>, _>("throttle_hours")
            .ok()
            .flatten()
            .unwrap_or(default_throttle);

        let Some(value) = metric_value(&metric, traffic, runtime, asyncs) else {
            continue;
        };
        if !eval_rule(&operator, value, threshold) {
            continue;
        }

        // 限流 claim
        let claimed = sqlx::query(
            "UPDATE management.platform_alert_rules \
             SET last_fired_at = NOW() \
             WHERE id = $1 \
               AND ( \
                 $2 = 0 \
                 OR last_fired_at IS NULL \
                 OR last_fired_at < NOW() - ($2 * INTERVAL '1 hour') \
               ) \
             RETURNING id",
        )
        .bind(id)
        .bind(throttle)
        .fetch_optional(pool)
        .await;

        match claimed {
            Ok(None) => {
                let _ = sqlx::query(
                    "INSERT INTO management.platform_alert_events \
                     (rule_id, rule_name, metric, value, threshold, status) \
                     VALUES ($1,$2,$3,$4,$5,'throttled')",
                )
                .bind(id)
                .bind(&name)
                .bind(&metric)
                .bind(value)
                .bind(threshold)
                .execute(pool)
                .await;
                continue;
            }
            Err(e) => {
                tracing::warn!(rule_id = id, error = %e, "告警限流 claim 失败");
                continue;
            }
            Ok(Some(_)) => {}
        }

        let vars = BTreeMap::from([
            ("rule_name".to_string(), name.clone()),
            ("metric".to_string(), metric.clone()),
            ("value".to_string(), format!("{value}")),
            ("threshold".to_string(), format!("{threshold}")),
            ("time".to_string(), Utc::now().to_rfc3339()),
            ("operator".to_string(), operator),
        ]);

        match post_webhook_json(&webhook_url, &template, &vars).await {
            Ok(()) => {
                let _ = sqlx::query(
                    "INSERT INTO management.platform_alert_events \
                     (rule_id, rule_name, metric, value, threshold, status) \
                     VALUES ($1,$2,$3,$4,$5,'sent')",
                )
                .bind(id)
                .bind(&name)
                .bind(&metric)
                .bind(value)
                .bind(threshold)
                .execute(pool)
                .await;
            }
            Err(e) => {
                tracing::warn!(rule_id = id, error = %e, "平台监控告警 Webhook 发送失败");
                let _ = sqlx::query(
                    "INSERT INTO management.platform_alert_events \
                     (rule_id, rule_name, metric, value, threshold, status, error) \
                     VALUES ($1,$2,$3,$4,$5,'failed',$6)",
                )
                .bind(id)
                .bind(&name)
                .bind(&metric)
                .bind(value)
                .bind(threshold)
                .bind(&e)
                .execute(pool)
                .await;
            }
        }
    }

}

/// 后台采样 + 告警评估。多实例用 advisory lock 互斥。
pub fn spawn_platform_monitor_task(
    pool: PgPool,
    redis: Option<RedisManager>,
    cb: CircuitBreakerManager,
    limiter: Option<RateLimiter>,
    hub: SseHub,
    bridge: BridgeMetrics,
) {
    let interval_secs = std::env::var("PLATFORM_MONITOR_SAMPLE_INTERVAL_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(60)
        .max(30);

    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(interval_secs));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // 启动后稍等再采，避免与启动高峰抢连接
        tokio::time::sleep(Duration::from_secs(15)).await;
        loop {
            ticker.tick().await;
            let locked: bool = match sqlx::query_scalar(
                "SELECT pg_try_advisory_lock($1)",
            )
            .bind(SAMPLE_LOCK_KEY)
            .fetch_one(&pool)
            .await
            {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(error = %e, "platform_monitor advisory lock 失败");
                    continue;
                }
            };
            if !locked {
                continue;
            }

            let result = async {
                let traffic = collect_traffic(&pool).await.unwrap_or_default();
                let runtime = collect_runtime(
                    &pool,
                    redis.as_ref(),
                    Some(&cb),
                    limiter.as_ref(),
                )
                .await;
                let asyncs = collect_async(&pool, Some(&hub), Some(&bridge))
                    .await
                    .unwrap_or_default();
                if let Err(e) = insert_sample(&pool, &traffic, &runtime, &asyncs).await {
                    tracing::warn!(error = %e, "写入 platform_metric_samples 失败");
                }
                evaluate_alerts(&pool, &traffic, &runtime, &asyncs).await;
                cleanup_old_samples(&pool).await;
            }
            .await;
            let _ = result;

            if let Err(e) = sqlx::query_scalar::<_, bool>("SELECT pg_advisory_unlock($1)")
                .bind(SAMPLE_LOCK_KEY)
                .fetch_one(&pool)
                .await
            {
                tracing::warn!(error = %e, "platform_monitor advisory unlock 失败");
            }
        }
    });
    tracing::info!(
        interval_secs,
        "平台监控采样/告警任务已启动"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eval_rule_operators() {
        assert!(eval_rule(">", 0.06, 0.05));
        assert!(!eval_rule(">", 0.05, 0.05));
        assert!(eval_rule(">=", 1.0, 1.0));
        assert!(eval_rule("==", 0.0, 0.0));
        assert!(eval_rule("<", 1.0, 2.0));
        assert!(!eval_rule("bogus", 1.0, 0.0));
    }
}
