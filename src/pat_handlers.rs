//! 个人访问令牌（PAT）管理 + 校验
//!
//! PAT 是 MCP（工作流创作）的鉴权凭证：绑定用户而非 database，审计可定位到人。
//! 与 `management.api_keys`（`cr_*`，database 级、仅 endpoint 触发）及
//! 平台服务令牌（`crp_*`）互不相干：PAT 前缀 `crm_`（MCP），哈希同款
//! sha256-hex 入库，明文仅创建时返回一次。
//!
//! 校验侧通过 [`verify_pat`] 把 PAT **合成为 [`Claims`]**，使
//! `require_admin_for_workflow` / `resolve_tenant_for_workflow_input` 等
//! 现有权限检查零改动复用；`jti` 填 `"pat:{id}"` 留审计痕。

use axum::{
    extract::{Path, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};

use crate::auth::Claims;
use crate::error::{AppError, Result};

/// PAT 明文前缀（`crm_` = OneBase MCP）。区别于数据面 `cr_` 与平台令牌 `crp_`；
/// /mcp 不挂 auth_middleware，由 handler 自行调 [`verify_pat`]。
pub const PAT_PREFIX: &str = "crm_";

/// sha256(token) 的 hex，64 字符——与 management.api_keys / es_proxy 同款入库格式。
pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

#[derive(Debug, Deserialize)]
pub struct CreatePatRequest {
    pub name: String,
    /// 过期天数；None = 永不过期（可随时吊销）
    pub expires_days: Option<i64>,
}

/// POST /api/admin/pats — 生成 PAT，**明文仅本次响应返回**
pub async fn create_pat(
    State(pool): State<PgPool>,
    axum::Extension(claims): axum::Extension<Claims>,
    Json(req): Json<CreatePatRequest>,
) -> Result<Json<Value>> {
    let name = req.name.trim();
    if name.is_empty() || name.len() > 100 {
        return Err(AppError::InvalidQuery(
            "name 不能为空且不超过 100 字符".to_string(),
        ));
    }
    // 校验有效期：0/负数会生成出生即过期的死令牌；超大值在 PG make_interval($4::int) 报 500
    if let Some(days) = req.expires_days {
        if !(1..=3650).contains(&days) {
            return Err(AppError::InvalidQuery(
                "expires_days 必须在 1..=3650（留空为永不过期）".to_string(),
            ));
        }
    }

    // 32 字节随机数 → 64 hex 字符，熵足够且肉眼可辨识前缀
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    let token = format!("{}{}", PAT_PREFIX, hex::encode(bytes));

    let row = sqlx::query(
        r#"INSERT INTO management.personal_access_tokens
           (user_id, name, token_hash, expires_at)
           VALUES ($1, $2, $3, CASE WHEN $4::bigint IS NULL THEN NULL
                                    ELSE NOW() + make_interval(days => $4::int) END)
           RETURNING id, scope, expires_at, created_at"#,
    )
    .bind(claims.sub)
    .bind(name)
    .bind(hash_token(&token))
    .bind(req.expires_days)
    .fetch_one(&pool)
    .await?;

    Ok(Json(json!({
        "id": row.get::<i32, _>("id"),
        "name": name,
        "scope": row.get::<String, _>("scope"),
        "token": token, // 明文仅此一次
        "expires_at": crate::models::naive_opt_to_utc_string(row.get::<Option<chrono::NaiveDateTime>, _>("expires_at")),
        "created_at": crate::models::naive_to_utc_string(row.get::<chrono::NaiveDateTime, _>("created_at")),
    })))
}

/// GET /api/admin/pats — 当前用户的 PAT 列表（不含哈希/明文）
pub async fn list_pats(
    State(pool): State<PgPool>,
    axum::Extension(claims): axum::Extension<Claims>,
) -> Result<Json<Value>> {
    let rows = sqlx::query(
        r#"SELECT id, name, scope, is_active, expires_at, last_used_at, created_at
           FROM management.personal_access_tokens
           WHERE user_id = $1
           ORDER BY id DESC"#,
    )
    .bind(claims.sub)
    .fetch_all(&pool)
    .await?;

    let list: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<i32, _>("id"),
                "name": r.get::<String, _>("name"),
                "scope": r.get::<String, _>("scope"),
                "is_active": r.get::<bool, _>("is_active"),
                "expires_at": crate::models::naive_opt_to_utc_string(r.get::<Option<chrono::NaiveDateTime>, _>("expires_at")),
                "last_used_at": crate::models::naive_opt_to_utc_string(r.get::<Option<chrono::NaiveDateTime>, _>("last_used_at")),
                "created_at": crate::models::naive_to_utc_string(r.get::<chrono::NaiveDateTime, _>("created_at")),
            })
        })
        .collect();

    Ok(Json(json!({ "pats": list })))
}

/// DELETE /api/admin/pats/:id — 吊销（置 is_active=false；只能吊销自己的，superadmin 不例外）
pub async fn revoke_pat(
    State(pool): State<PgPool>,
    axum::Extension(claims): axum::Extension<Claims>,
    Path(id): Path<i32>,
) -> Result<Json<Value>> {
    let result = sqlx::query(
        r#"UPDATE management.personal_access_tokens
           SET is_active = false
           WHERE id = $1 AND user_id = $2"#,
    )
    .bind(id)
    .bind(claims.sub)
    .execute(&pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("PAT {} 不存在或不属于你", id)));
    }
    Ok(Json(json!({ "revoked": id })))
}

/// 校验 PAT 并合成 Claims（MCP 鉴权入口）
///
/// - 哈希查表 + is_active + 过期校验；
/// - JOIN users 实读 email / is_superadmin，权限语义与登录用户一致；
/// - `jti = "pat:{id}"`：审计中与会话 JWT 区分；
/// - last_used_at 异步 best-effort 更新，不阻塞请求。
pub async fn verify_pat(pool: &PgPool, token: &str) -> Result<Claims> {
    if !token.starts_with(PAT_PREFIX) {
        return Err(AppError::Unauthorized("无效的 PAT 格式".to_string()));
    }

    let row = sqlx::query(
        r#"SELECT p.id, p.user_id, p.expires_at, u.email, u.is_superadmin
           FROM management.personal_access_tokens p
           JOIN users u ON u.id = p.user_id
           WHERE p.token_hash = $1
             AND p.is_active = true
             AND COALESCE(u.is_active, true) = true
             AND (p.expires_at IS NULL OR p.expires_at > NOW())"#,
    )
    .bind(hash_token(token))
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::Unauthorized("PAT 无效、已吊销或已过期".to_string()))?;

    let pat_id: i32 = row.get("id");

    // last_used_at 更新失败不影响本次请求
    let pool2 = pool.clone();
    tokio::spawn(async move {
        // 节流：MCP 一次创作几十次 tools/call，逐次写会放大行锁竞争。
        // 仅在从未用过或距上次 >60s 才更新，把热点写收敛。
        let _ = sqlx::query(
            "UPDATE management.personal_access_tokens SET last_used_at = NOW() \
             WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < NOW() - interval '60 seconds')",
        )
        .bind(pat_id)
        .execute(&pool2)
        .await;
    });

    let now = chrono::Utc::now().timestamp();
    Ok(Claims {
        sub: row.get("user_id"),
        email: row.get("email"),
        role: "user".to_string(), // 遗留字段，仅前端展示用
        is_superadmin: row.get::<Option<bool>, _>("is_superadmin").unwrap_or(false),
        jti: format!("pat:{}", pat_id),
        exp: row
            .get::<Option<chrono::NaiveDateTime>, _>("expires_at")
            .map(|t| t.and_utc().timestamp())
            .unwrap_or(now + 86400), // PAT 无过期时间时给个名义值；真实校验以上方 SQL 为准
        iat: now,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hash_token_is_sha256_hex() {
        // 与 PostgreSQL encode(sha256('abc'),'hex') 一致
        assert_eq!(
            hash_token("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(hash_token("abc").len(), 64);
    }

    #[test]
    fn test_pat_prefix_distinct_from_other_token_prefixes() {
        // crm_ 不与数据面 cr_ / 平台 crp_ 混淆；/mcp 自行校验，不依赖中间件。
        assert!(!PAT_PREFIX.starts_with("cr_"));
        assert_ne!(PAT_PREFIX, "cr_");
        assert_ne!(PAT_PREFIX, "crp_");
    }

    #[test]
    fn pat_authentication_requires_active_user() {
        let production_source = include_str!("pat_handlers.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(
            production_source.contains("AND COALESCE(u.is_active, true) = true"),
            "PAT lookup must reject globally inactive users"
        );
    }
}
