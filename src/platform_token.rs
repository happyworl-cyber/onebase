//! 平台服务令牌（Platform Service Token, `crp_` 前缀）
//!
//! 给「机器 / AI / 外部系统」一种长期有效、带 scope 的管理级凭证，用于通过纯 HTTP
//! 调用原本「仅 JWT」的管理端点（如 `POST /api/projects/provision`、
//! `POST /api/admin/workflows`）。
//!
//! 设计要点：
//! - 令牌绑定到一个**用户**(`user_id`)。鉴权时把令牌解析成该用户的 [`Claims`]，从而**完全
//!   复用**现有 owner/admin/superadmin 权限校验，不必给每个端点单独开后门。
//! - 与数据面 API Key（`cr_` 前缀、绑库、走 `rbac_middleware`）严格区分：`crp_` 前缀、
//!   绑用户、在 `auth_middleware` 里就解析完成。
//! - `scopes` 限定该令牌能做哪些管理动作；即使绑定的是超管用户，**scope 仍然生效**
//!   （令牌就是要做最小权限收敛）。

use sqlx::{PgPool, Row};

use crate::auth::Claims;
use crate::error::{AppError, Result};

/// 平台令牌明文前缀。注意与数据面 API Key 的 `cr_` 区分：`crp_` 不以 `cr_` 开头
/// （前 3 字节是 `crp` 而非 `cr_`），所以 `auth_middleware` 里两个分支不会冲突。
pub const TOKEN_PREFIX: &str = "crp_";

/// 令牌可声明的管理动作 scope。
pub const SCOPE_PROJECT_CREATE: &str = "project:create";
pub const SCOPE_WORKFLOW_READ: &str = "workflow:read";
pub const SCOPE_WORKFLOW_WRITE: &str = "workflow:write";
pub const SCOPE_WORKFLOW_RUN: &str = "workflow:run";

/// 所有合法 scope（创建令牌时校验输入用）。`*` 单独处理（代表全部）。
pub const ALL_SCOPES: &[&str] = &[
    SCOPE_PROJECT_CREATE,
    SCOPE_WORKFLOW_READ,
    SCOPE_WORKFLOW_WRITE,
    SCOPE_WORKFLOW_RUN,
];

/// 随请求携带的平台令牌上下文，由 `auth_middleware` 注入请求扩展。
/// scope 校验中间件据此判断该令牌能否执行某动作；JWT 用户不会有这个扩展，因此不受 scope 限制。
#[derive(Debug, Clone)]
pub struct PlatformTokenContext {
    #[allow(dead_code)]
    pub token_id: i32,
    #[allow(dead_code)]
    pub user_id: i32,
    pub scopes: Vec<String>,
}

impl PlatformTokenContext {
    /// 该令牌是否允许执行 `required` 动作（含 `*` 通配）。
    pub fn allows(&self, required: &str) -> bool {
        self.scopes
            .iter()
            .any(|s| s == "*" || s == "ALL" || s == required)
    }
}

/// 生成一个新的平台令牌明文（仅在创建时返回一次）。
pub fn generate_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let random_bytes: Vec<u8> = (0..32).map(|_| rng.gen()).collect();
    format!("{}{}", TOKEN_PREFIX, hex::encode(random_bytes))
}

/// 计算令牌的 SHA-256 十六进制摘要（与 `api_keys` 一致，存库只存摘要）。
pub fn hash_token(raw: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    hex::encode(hasher.finalize())
}

/// 校验输入的 scope 列表是否合法（允许 `*`，其余必须在 [`ALL_SCOPES`] 内）。
pub fn validate_scopes(scopes: &[String]) -> Result<()> {
    for s in scopes {
        if s == "*" || s == "ALL" || ALL_SCOPES.contains(&s.as_str()) {
            continue;
        }
        return Err(AppError::InvalidQuery(format!(
            "非法 scope: {}（可选：{} 或 *）",
            s,
            ALL_SCOPES.join(", ")
        )));
    }
    Ok(())
}

/// 用平台令牌明文鉴权：查表 → 校验启用/过期 → 反查用户构造 [`Claims`] + 上下文。
///
/// 返回的 `Claims.jti` 为空、`exp` 取一个远期时间——平台令牌不走 `user_sessions`
/// 会话体系，其有效性完全由 `platform_tokens.is_active` / `expires_at` 决定。
pub async fn authenticate(
    pool: &PgPool,
    raw_token: &str,
) -> Result<(Claims, PlatformTokenContext)> {
    let token_hash = hash_token(raw_token);

    let row = sqlx::query(
        r#"
        SELECT pt.id            AS token_id,
               pt.user_id       AS user_id,
               pt.scopes        AS scopes,
               pt.expires_at    AS expires_at,
               u.email          AS email,
               u.role           AS role,
               u.is_superadmin  AS is_superadmin
        FROM management.platform_tokens pt
        JOIN users u ON u.id = pt.user_id
        WHERE pt.token_hash = $1 AND pt.is_active = true
        "#,
    )
    .bind(&token_hash)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询平台令牌失败: {}", e)))?;

    let row = row.ok_or_else(|| AppError::Unauthorized("平台令牌无效或已停用".to_string()))?;

    let expires_at: Option<chrono::NaiveDateTime> = row.try_get("expires_at").ok();
    if let Some(exp) = expires_at {
        if exp < chrono::Utc::now().naive_utc() {
            return Err(AppError::Unauthorized("平台令牌已过期".to_string()));
        }
    }

    let token_id: i32 = row.get("token_id");
    let user_id: i32 = row.get("user_id");
    let email: String = row.get("email");
    let role: String = row.get("role");
    let is_superadmin: bool = row.try_get("is_superadmin").unwrap_or(false);
    let scopes_json: serde_json::Value = row.get("scopes");
    let scopes: Vec<String> = scopes_json
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    // 异步刷新 last_used_at，失败不影响鉴权。
    let _ = sqlx::query("UPDATE management.platform_tokens SET last_used_at = NOW() WHERE id = $1")
        .bind(token_id)
        .execute(pool)
        .await;

    let now = chrono::Utc::now().timestamp();
    let claims = Claims {
        sub: user_id,
        email,
        role,
        is_superadmin,
        jti: String::new(),
        // 远期过期：平台令牌的有效性由 platform_tokens 表控制，不依赖 JWT exp。
        exp: now + 3600 * 24 * 365,
        iat: now,
    };

    let ctx = PlatformTokenContext {
        token_id,
        user_id,
        scopes,
    };

    Ok((claims, ctx))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_token_has_prefix() {
        let t = generate_token();
        assert!(t.starts_with("crp_"));
        // crp_ 不应被识别为数据面 cr_ key
        assert!(!t.starts_with("cr_"));
    }

    #[test]
    fn test_hash_token_deterministic() {
        assert_eq!(hash_token("crp_abc"), hash_token("crp_abc"));
        assert_ne!(hash_token("crp_abc"), hash_token("crp_def"));
    }

    #[test]
    fn test_scope_allows() {
        let ctx = PlatformTokenContext {
            token_id: 1,
            user_id: 1,
            scopes: vec!["project:create".to_string(), "workflow:write".to_string()],
        };
        assert!(ctx.allows("project:create"));
        assert!(ctx.allows("workflow:write"));
        assert!(!ctx.allows("workflow:run"));
    }

    #[test]
    fn test_scope_wildcard() {
        let ctx = PlatformTokenContext {
            token_id: 1,
            user_id: 1,
            scopes: vec!["*".to_string()],
        };
        assert!(ctx.allows("project:create"));
        assert!(ctx.allows("workflow:run"));
    }

    #[test]
    fn test_validate_scopes() {
        assert!(validate_scopes(&["project:create".to_string()]).is_ok());
        assert!(validate_scopes(&["*".to_string()]).is_ok());
        assert!(validate_scopes(&["bogus".to_string()]).is_err());
    }
}
