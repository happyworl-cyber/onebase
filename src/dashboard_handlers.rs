//! M6 项目级简化大盘 endpoints。
//!
//! 两个 endpoint：
//!   GET /api/dashboard/overview?tenant_id=N
//!     → 6 个核心指标 + 24 个 hourly 分桶（供 sparkline）
//!     → 单 CTE 查询一次拿全；走 (tenant_id, created_at) 索引
//!   GET /api/dashboard/recent-activity?tenant_id=N&limit=10
//!     → sanitized 最近活动 feed；不返回 IP / user_agent / request_body
//!
//! 鉴权 = **租户任意成员**（owner/admin/member/viewer）+ 平台超管。
//! viewer 能看——大盘是纯聚合数字 + 路径前缀，不暴露行级业务数据。
//! 这里**不**复用 `audit_handlers::list_audit_logs`，因为后者 admin+ 且会返回敏感字段。

use crate::auth::Claims;
use crate::error::Result;
use crate::permissions;
use axum::{
    extract::{Query, State},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgPool, Row};

// ─── 请求 / 响应类型 ────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct DashboardQuery {
    pub tenant_id: i32,
}

#[derive(Debug, Serialize)]
pub struct DashboardOverview {
    /// 近 5 分钟 QPS（请求数 / 300）
    pub qps_5min: f64,
    /// 近 5 分钟 P95 延迟（ms）；样本不足时为 None
    pub p95_ms_5min: Option<f64>,
    /// 近 24h 错误率 [0.0, 1.0]；24h 内 0 调用时为 None
    pub error_rate_24h: Option<f64>,
    /// 近 24h 慢查询数（management.slow_query_logs）
    pub slow_queries_24h: i64,
    /// 当前活跃 API Key 数（is_active=true）
    pub active_api_keys: i64,
    /// 近 24h 总调用数
    pub calls_24h: i64,
    /// 24 个 hourly bucket（缺失小时填 0），最旧 → 最新
    pub hourly_24h: Vec<HourlyBucket>,
}

#[derive(Debug, Serialize, Clone)]
pub struct HourlyBucket {
    /// UTC 整点小时 rfc3339 字符串
    pub hour_utc: String,
    pub count: i64,
    pub err_5xx: i64,
}

#[derive(Debug, Deserialize)]
pub struct RecentActivityQuery {
    pub tenant_id: i32,
    #[serde(default = "default_limit")]
    pub limit: i64,
}

fn default_limit() -> i64 {
    10
}

#[derive(Debug, Serialize)]
pub struct ActivityRow {
    pub id: i64,
    pub action: String,
    pub resource: String,
    pub request_method: String,
    pub response_status: Option<i32>,
    pub duration_ms: Option<i32>,
    pub created_at: String,
}

// ─── handlers ───────────────────────────────────────────────────

/// GET /api/dashboard/overview
pub async fn get_overview(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(q): Query<DashboardQuery>,
) -> Result<Json<DashboardOverview>> {
    permissions::require_tenant_membership_any(&pool, &claims, q.tenant_id).await?;

    // 单查询一次拿全：5min QPS / P95、24h 调用 / 错误率 / hourly、慢查询、API Key。
    // 用 jsonb_agg 把 hourly 拼成 JSON 数组随主查询一起返回；省一次 round-trip。
    let row = sqlx::query(
        r#"
        WITH
        last_5min AS (
            SELECT duration_ms, response_status
            FROM management.audit_logs
            WHERE tenant_id = $1 AND created_at >= now() - INTERVAL '5 minutes'
        ),
        last_24h AS (
            SELECT response_status, date_trunc('hour', created_at) AS h
            FROM management.audit_logs
            WHERE tenant_id = $1 AND created_at >= now() - INTERVAL '24 hours'
        ),
        slow AS (
            SELECT COUNT(*)::bigint AS n
            FROM management.slow_query_logs s
            JOIN management.tenant_databases d ON s.database_id = d.id
            WHERE d.tenant_id = $1
              AND s.created_at >= now() - INTERVAL '24 hours'
        ),
        keys AS (
            SELECT COUNT(*)::bigint AS n
            FROM management.api_keys
            WHERE tenant_id = $1 AND COALESCE(is_active, false) = true
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
            (SELECT COUNT(*)::bigint FROM last_24h) AS calls_24h,
            CASE WHEN (SELECT COUNT(*) FROM last_24h) = 0 THEN NULL::float8
                 ELSE (SELECT COUNT(*) FILTER (WHERE response_status >= 500)::float8
                       / NULLIF(COUNT(*), 0)::float8 FROM last_24h)
            END AS error_rate_24h,
            (SELECT n FROM slow) AS slow_queries_24h,
            (SELECT n FROM keys) AS active_api_keys,
            COALESCE(
                (SELECT jsonb_agg(
                    jsonb_build_object('hour', hour, 'cnt', cnt, 'err_5xx', err_5xx)
                    ORDER BY hour
                ) FROM hourly),
                '[]'::jsonb
            ) AS hourly_24h
        "#,
    )
    .bind(q.tenant_id)
    .fetch_one(&pool)
    .await?;

    let qps_5min: f64 = row.try_get("qps_5min").unwrap_or(0.0);
    let p95_ms_5min: Option<f64> = row.try_get("p95_ms_5min").ok();
    let calls_24h: i64 = row.try_get("calls_24h").unwrap_or(0);
    let error_rate_24h: Option<f64> = row.try_get("error_rate_24h").ok();
    let slow_queries_24h: i64 = row.try_get("slow_queries_24h").unwrap_or(0);
    let active_api_keys: i64 = row.try_get("active_api_keys").unwrap_or(0);
    let hourly_raw: Value = row
        .try_get::<Value, _>("hourly_24h")
        .unwrap_or_else(|_| Value::Array(vec![]));

    Ok(Json(DashboardOverview {
        qps_5min,
        p95_ms_5min,
        error_rate_24h,
        slow_queries_24h,
        active_api_keys,
        calls_24h,
        hourly_24h: fill_hourly_buckets(&hourly_raw),
    }))
}

/// 把 PG 返回的稀疏 hourly 数组补成 24 个槽位（最旧的 23 小时前整点 → 当前小时整点）。
///
/// PG 端返回的是 `[{hour: "2026-05-19T13:00:00+00:00", cnt, err_5xx}, ...]`，
/// 但只有"实际有调用的小时"会出现。前端 sparkline 需要稳定的 24 个点，所以
/// 这里把缺失的小时填成 `{count: 0, err_5xx: 0}`。
fn fill_hourly_buckets(raw: &Value) -> Vec<HourlyBucket> {
    use chrono::{DurationRound, TimeDelta, Utc};

    // 索引：UTC 整点 ISO → (cnt, err_5xx)
    let mut have = std::collections::HashMap::<String, (i64, i64)>::new();
    if let Some(arr) = raw.as_array() {
        for v in arr {
            // hour 字段是 PG date_trunc('hour', created_at) 的输出，rfc3339 带时区
            if let (Some(hour), Some(cnt), Some(err)) = (
                v.get("hour").and_then(|x| x.as_str()),
                v.get("cnt").and_then(|x| x.as_i64()),
                v.get("err_5xx").and_then(|x| x.as_i64()),
            ) {
                // 归一化：去掉时区后缀差异，统一成 chrono parsed 后再格式化
                if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(hour) {
                    let utc = dt.with_timezone(&Utc);
                    have.insert(utc.to_rfc3339(), (cnt, err));
                }
            }
        }
    }

    // 当前 UTC 整点
    let now = Utc::now()
        .duration_trunc(TimeDelta::try_hours(1).unwrap())
        .unwrap_or_else(|_| Utc::now());

    let mut out = Vec::with_capacity(24);
    for i in (0..24).rev() {
        // 从 23 小时前到当前小时
        let t = now - TimeDelta::try_hours(i).unwrap();
        let key = t.to_rfc3339();
        let (cnt, err) = have.get(&key).copied().unwrap_or((0, 0));
        out.push(HourlyBucket {
            hour_utc: key,
            count: cnt,
            err_5xx: err,
        });
    }
    out
}

/// GET /api/dashboard/recent-activity
pub async fn get_recent_activity(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(q): Query<RecentActivityQuery>,
) -> Result<Json<Vec<ActivityRow>>> {
    permissions::require_tenant_membership_any(&pool, &claims, q.tenant_id).await?;

    // limit 收紧到 [1, 50]
    let limit = q.limit.max(1).min(50);

    let rows = sqlx::query(
        r#"
        SELECT id, action, resource, request_method, response_status, duration_ms, created_at
        FROM management.audit_logs
        WHERE tenant_id = $1
        ORDER BY created_at DESC
        LIMIT $2
        "#,
    )
    .bind(q.tenant_id)
    .bind(limit)
    .fetch_all(&pool)
    .await?;

    let activities: Vec<ActivityRow> = rows
        .into_iter()
        .map(|r| ActivityRow {
            id: r.get::<i64, _>("id"),
            action: r.get::<String, _>("action"),
            resource: r.get::<String, _>("resource"),
            request_method: r.get::<String, _>("request_method"),
            response_status: r
                .try_get::<Option<i32>, _>("response_status")
                .ok()
                .flatten(),
            duration_ms: r.try_get::<Option<i32>, _>("duration_ms").ok().flatten(),
            created_at: r
                .get::<chrono::DateTime<chrono::Utc>, _>("created_at")
                .to_rfc3339(),
        })
        .collect();

    Ok(Json(activities))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fill_hourly_pads_missing_to_24() {
        let raw = json!([
            // 故意只给 2 个点
            { "hour": "2026-05-19T05:00:00+00:00", "cnt": 5, "err_5xx": 1 },
            { "hour": "2026-05-19T06:00:00+00:00", "cnt": 3, "err_5xx": 0 },
        ]);
        let out = fill_hourly_buckets(&raw);
        assert_eq!(out.len(), 24, "应该补成 24 个槽位");
        // 单调递增的小时序列
        for w in out.windows(2) {
            assert!(w[0].hour_utc <= w[1].hour_utc);
        }
    }

    #[test]
    fn fill_hourly_handles_empty() {
        let out = fill_hourly_buckets(&json!([]));
        assert_eq!(out.len(), 24);
        assert!(out.iter().all(|b| b.count == 0 && b.err_5xx == 0));
    }

    #[test]
    fn fill_hourly_ignores_malformed_entries() {
        let raw = json!([
            { "hour": "not-a-date", "cnt": 99, "err_5xx": 1 },
            { "cnt": 100 },  // 没 hour
            { "hour": "2026-05-19T05:00:00+00:00", "cnt": 7, "err_5xx": 2 },
        ]);
        let out = fill_hourly_buckets(&raw);
        assert_eq!(out.len(), 24);
        // 不该 panic；总计应该只算上"完整可解析"的那一条
        let total: i64 = out.iter().map(|b| b.count).sum();
        // 取决于当前 UTC 时间是否落在 5:00 那一格，所以可能是 0 或 7；只断言不 panic + 24 槽
        assert!(total == 0 || total == 7);
    }
}
