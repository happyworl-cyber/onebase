use axum::{
    extract::{Extension, Path, State},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::{PgPool, Row};

use crate::circuit_breaker::CircuitBreakerManager;
use crate::error::{AppError, Result};
use crate::rate_limiter::RateLimiter;

// ── 精细化限流规则 CRUD ──
//
// ⚠️ 写完表后必须调 RateLimiter::refresh_now()。否则规则虽然落库，但中间件
//    要等下一轮 30s 后台轮询才会拉到新版本，管理员改动看起来"完全没生效"。
//    历史上整个 CRUD 路径与限流器完全脱钩，该问题已修复。

const ALLOWED_RULE_TYPES: &[&str] = &["tenant", "user", "endpoint", "ip"];
const MAX_WINDOW_SECONDS: i32 = 24 * 3600; // 1 天，再大基本是误填

#[derive(Debug, Deserialize)]
pub struct CreateRateLimitRule {
    pub tenant_id: Option<i32>,
    pub name: String,
    pub rule_type: String,
    pub match_pattern: Option<String>,
    pub max_requests: i32,
    pub window_seconds: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateRateLimitRule {
    pub name: Option<String>,
    pub match_pattern: Option<String>,
    pub max_requests: Option<i32>,
    pub window_seconds: Option<i32>,
    pub is_active: Option<bool>,
}

fn validate_rule_type(rt: &str) -> Result<()> {
    if !ALLOWED_RULE_TYPES.contains(&rt) {
        return Err(AppError::InvalidQuery(format!(
            "rule_type 必须是 {:?} 之一",
            ALLOWED_RULE_TYPES
        )));
    }
    Ok(())
}

fn validate_max_requests(n: i32) -> Result<()> {
    if n <= 0 {
        return Err(AppError::InvalidQuery(
            "max_requests 必须是正整数".to_string(),
        ));
    }
    Ok(())
}

fn validate_window_seconds(n: i32) -> Result<()> {
    if n <= 0 {
        return Err(AppError::InvalidQuery(
            "window_seconds 必须是正整数".to_string(),
        ));
    }
    if n > MAX_WINDOW_SECONDS {
        return Err(AppError::InvalidQuery(format!(
            "window_seconds 不能超过 {} (1 天)",
            MAX_WINDOW_SECONDS
        )));
    }
    Ok(())
}

/// 校验 rule_type / tenant_id / match_pattern 三者的内在一致性。
/// - tenant 规则必须显式带 tenant_id（否则永远不命中）
/// - user / endpoint / ip 规则必须给 match_pattern（否则同样永远不命中）
fn validate_rule_shape(
    rule_type: &str,
    tenant_id: Option<i32>,
    match_pattern: Option<&str>,
) -> Result<()> {
    match rule_type {
        "tenant" => {
            if tenant_id.is_none() {
                return Err(AppError::InvalidQuery(
                    "rule_type=tenant 时必须填 tenant_id".to_string(),
                ));
            }
        }
        "user" | "endpoint" | "ip" => {
            if match_pattern.map(|s| s.trim().is_empty()).unwrap_or(true) {
                return Err(AppError::InvalidQuery(format!(
                    "rule_type={} 时必须填 match_pattern",
                    rule_type
                )));
            }
        }
        _ => {}
    }
    Ok(())
}

/// 写表成功后通知限流器立即 reload。失败只告警，不报错给管理员
/// （DB 已经写成功了，下一轮 30s 轮询也能兜底）。
async fn notify_limiter(limiter: Option<&RateLimiter>) {
    if let Some(l) = limiter {
        if let Err(e) = l.refresh_now().await {
            tracing::warn!("限流规则热加载失败（30s 后会自动重试）: {}", e);
        }
    }
}

/// GET /api/admin/rate-limit-rules
pub async fn list_rules(State(pool): State<PgPool>) -> Result<Json<serde_json::Value>> {
    let rows = sqlx::query(
        "SELECT id, tenant_id, name, rule_type, match_pattern, max_requests, window_seconds, is_active \
         FROM management.rate_limit_rules ORDER BY id"
    )
    .fetch_all(&pool)
    .await?;

    let rules: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<i32, _>("id"),
                "tenant_id": r.get::<Option<i32>, _>("tenant_id"),
                "name": r.get::<String, _>("name"),
                "rule_type": r.get::<String, _>("rule_type"),
                "match_pattern": r.get::<Option<String>, _>("match_pattern"),
                "max_requests": r.get::<i32, _>("max_requests"),
                "window_seconds": r.get::<i32, _>("window_seconds"),
                "is_active": r.get::<bool, _>("is_active"),
            })
        })
        .collect();

    Ok(Json(json!({ "data": rules })))
}

/// POST /api/admin/rate-limit-rules
pub async fn create_rule(
    State(pool): State<PgPool>,
    limiter: Option<Extension<RateLimiter>>,
    Json(body): Json<CreateRateLimitRule>,
) -> Result<Json<serde_json::Value>> {
    validate_rule_type(&body.rule_type)?;
    validate_max_requests(body.max_requests)?;
    let window = body.window_seconds.unwrap_or(60);
    validate_window_seconds(window)?;
    validate_rule_shape(
        &body.rule_type,
        body.tenant_id,
        body.match_pattern.as_deref(),
    )?;

    let row = sqlx::query(
        "INSERT INTO management.rate_limit_rules (tenant_id, name, rule_type, match_pattern, max_requests, window_seconds) \
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id"
    )
    .bind(body.tenant_id)
    .bind(&body.name)
    .bind(&body.rule_type)
    .bind(&body.match_pattern)
    .bind(body.max_requests)
    .bind(window)
    .fetch_one(&pool)
    .await?;

    notify_limiter(limiter.as_ref().map(|Extension(l)| l)).await;

    Ok(Json(
        json!({ "data": { "id": row.get::<i32, _>("id") }, "message": "创建成功" }),
    ))
}

/// PATCH /api/admin/rate-limit-rules/:id
pub async fn update_rule(
    State(pool): State<PgPool>,
    Path(id): Path<i32>,
    limiter: Option<Extension<RateLimiter>>,
    Json(body): Json<UpdateRateLimitRule>,
) -> Result<Json<serde_json::Value>> {
    if let Some(n) = body.max_requests {
        validate_max_requests(n)?;
    }
    if let Some(n) = body.window_seconds {
        validate_window_seconds(n)?;
    }

    let result = sqlx::query(
        "UPDATE management.rate_limit_rules SET \
            name = COALESCE($2, name), \
            match_pattern = COALESCE($3, match_pattern), \
            max_requests = COALESCE($4, max_requests), \
            window_seconds = COALESCE($5, window_seconds), \
            is_active = COALESCE($6, is_active) \
         WHERE id = $1",
    )
    .bind(id)
    .bind(&body.name)
    .bind(&body.match_pattern)
    .bind(body.max_requests)
    .bind(body.window_seconds)
    .bind(body.is_active)
    .execute(&pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("规则 {} 不存在", id)));
    }

    notify_limiter(limiter.as_ref().map(|Extension(l)| l)).await;

    Ok(Json(json!({ "message": "更新成功" })))
}

/// DELETE /api/admin/rate-limit-rules/:id
pub async fn delete_rule(
    State(pool): State<PgPool>,
    Path(id): Path<i32>,
    limiter: Option<Extension<RateLimiter>>,
) -> Result<Json<serde_json::Value>> {
    let result = sqlx::query("DELETE FROM management.rate_limit_rules WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("规则 {} 不存在", id)));
    }

    notify_limiter(limiter.as_ref().map(|Extension(l)| l)).await;

    Ok(Json(json!({ "message": "删除成功" })))
}

// ── 熔断器状态 ──

/// GET /api/admin/circuit-breakers
pub async fn circuit_breaker_status(
    cb_mgr: Option<axum::extract::Extension<CircuitBreakerManager>>,
) -> Result<Json<serde_json::Value>> {
    let statuses: Vec<serde_json::Value> = if let Some(axum::extract::Extension(mgr)) = cb_mgr {
        mgr.status_all()
            .into_iter()
            .map(|(db_id, state)| {
                json!({
                    "database_id": db_id,
                    "state": format!("{:?}", state),
                })
            })
            .collect()
    } else {
        vec![]
    };

    Ok(Json(json!({ "data": statuses })))
}

// ── 限流器健康/降级状态（运维可观测） ──

/// GET /api/admin/rate-limit-stats
///
/// 返回 RateLimiter 的实时计数与降级状态：
/// - `redis_failures_streak > 0` → Redis 正在抖
/// - `redis_failures_streak >= 3` → 已进入降级模式，应该报警去查 Redis
/// - `fallback_decisions_total / fallback_rejected_total` → 兑底期间究竟挡了多少
/// - `local_counter_keys` → 兑底内存占用规模
pub async fn rate_limit_stats(
    limiter: Option<Extension<RateLimiter>>,
) -> Result<Json<serde_json::Value>> {
    let Some(Extension(limiter)) = limiter else {
        return Ok(Json(json!({
            "error": "RateLimiter 未启用（可能是 Redis 未连接）",
        })));
    };
    let stats = limiter.stats_snapshot().await;
    Ok(Json(json!({ "data": stats })))
}

// ── API 版本信息 ──

/// GET /api/admin/gateway-info
pub async fn gateway_info() -> Result<Json<serde_json::Value>> {
    Ok(Json(json!({
        "api_versions": ["v1"],
        "features": {
            "rate_limiting": true,
            "circuit_breaker": true,
            "read_write_splitting": true,
            "query_caching": true,
            "webhook": true,
            "realtime_ws": true,
            "audit_log": true,
        },
        "version": env!("CARGO_PKG_VERSION"),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_rule_type() {
        assert!(validate_rule_type("tenant").is_ok());
        assert!(validate_rule_type("user").is_ok());
        assert!(validate_rule_type("endpoint").is_ok());
        assert!(validate_rule_type("ip").is_ok());
        assert!(validate_rule_type("garbage").is_err());
        assert!(validate_rule_type("").is_err());
    }

    #[test]
    fn test_validate_max_requests() {
        assert!(validate_max_requests(1).is_ok());
        assert!(validate_max_requests(10_000).is_ok());
        assert!(validate_max_requests(0).is_err());
        assert!(validate_max_requests(-1).is_err());
    }

    #[test]
    fn test_validate_window_seconds() {
        assert!(validate_window_seconds(1).is_ok());
        assert!(validate_window_seconds(60).is_ok());
        assert!(validate_window_seconds(MAX_WINDOW_SECONDS).is_ok());
        assert!(validate_window_seconds(0).is_err());
        assert!(validate_window_seconds(MAX_WINDOW_SECONDS + 1).is_err());
    }

    #[test]
    fn test_validate_rule_shape() {
        // tenant 规则必须带 tenant_id
        assert!(validate_rule_shape("tenant", Some(1), None).is_ok());
        assert!(validate_rule_shape("tenant", None, None).is_err());

        // 其它规则必须带 match_pattern
        for rt in ["user", "endpoint", "ip"] {
            assert!(validate_rule_shape(rt, None, Some("/api/*")).is_ok());
            assert!(validate_rule_shape(rt, None, None).is_err());
            assert!(validate_rule_shape(rt, None, Some("")).is_err());
            assert!(validate_rule_shape(rt, None, Some("   ")).is_err());
        }
    }
}
