use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::env;

use crate::error::AppError;

static JWT_SECRET: Lazy<String> = Lazy::new(|| {
    let secret = env::var("JWT_SECRET").unwrap_or_default();
    if secret.is_empty() || secret == "change-me-in-production" {
        if env::var("RUST_ENV").unwrap_or_default() == "development" {
            tracing::warn!("JWT_SECRET 未设置，使用开发默认值（仅限开发环境！）");
            return "dev-only-jwt-secret-do-not-use-in-production".to_string();
        }
        panic!("JWT_SECRET 未设置或使用了默认值。生产环境必须设置 JWT_SECRET 环境变量为强随机字符串（32+ 位）。");
    }
    if secret.len() < 16 {
        panic!(
            "JWT_SECRET 太短（当前 {} 位），至少需要 16 位。",
            secret.len()
        );
    }
    secret
});

static JWT_EXPIRATION: Lazy<i64> = Lazy::new(|| {
    env::var("JWT_EXPIRATION")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(24 * 3600) // 默认 24 小时
});

/// JWT Claims
///
/// 字段权威性约定（**改之前务必读**）：
/// - `is_superadmin`：**唯一**的平台超管判定字段。`auth_middleware` 校验 jti 通过后，
///   handler / 提取器一律信任它（不再回查 `users.is_superadmin`）。
/// - `role`：**遗留显示字段**。早期版本用 `role IN ('admin', 'user')` 做权限判定，
///   但已被 `is_superadmin` + RBAC 完整替代。现在它只在前端 dashboard 顶部"用户卡片"
///   做"管理员/用户"标签展示——**不参与任何鉴权决策**。
///   - `middleware::has_role` / `require_role` 仍在引用它，但都是 dead code（`main.rs`
///     里没有挂载），仅为兼容旧 API 保留。新代码请用 `permissions::require_*` 系列。
/// - `jti`：服务端会话登记 UUID。`auth_middleware` 会查 `user_sessions` 表确认 jti
///   未被吊销；超管位翻转 / 密码重置 / 移出租户会通过 `permissions::revoke_user_sessions`
///   一并删除该用户全部 jti，强制下次重登录。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Claims {
    pub sub: i32,      // 用户 ID
    pub email: String, // 用户邮箱
    pub role: String,  // 遗留：用户角色（仅前端展示，不参与权限判定，详见结构体文档）
    #[serde(default)]
    pub is_superadmin: bool, // 是否为平台超级管理员（权威字段）
    /// JWT 唯一标识，写入 user_sessions 表，可服务端吊销
    #[serde(default)]
    pub jti: String,
    pub exp: i64, // 过期时间（Unix 时间戳）
    pub iat: i64, // 签发时间
}

impl Claims {
    /// 创建新的 Claims
    pub fn new(
        user_id: i32,
        email: String,
        role: String,
        is_superadmin: bool,
        jti: String,
    ) -> Self {
        let now = Utc::now();
        let exp = (now + Duration::seconds(*JWT_EXPIRATION)).timestamp();

        Self {
            sub: user_id,
            email,
            role,
            is_superadmin,
            jti,
            exp,
            iat: now.timestamp(),
        }
    }

    /// 检查 token 是否过期
    #[allow(dead_code)]
    pub fn is_expired(&self) -> bool {
        Utc::now().timestamp() > self.exp
    }
}

/// JWT 默认有效期（秒），导出供 handler 写入 user_sessions.expires_at
pub fn jwt_expiration_secs() -> i64 {
    *JWT_EXPIRATION
}

/// 生成 JWT token
///
/// 返回 `(token, jti)`；调用方必须把 jti 写入 `user_sessions` 表，
/// 否则该 token 在校验阶段会被识别为"未登记"而被拒绝。
pub fn generate_token(
    user_id: i32,
    email: &str,
    role: &str,
    is_superadmin: bool,
) -> Result<(String, String), AppError> {
    let jti = uuid::Uuid::new_v4().to_string();
    let claims = Claims::new(
        user_id,
        email.to_string(),
        role.to_string(),
        is_superadmin,
        jti.clone(),
    );

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(JWT_SECRET.as_bytes()),
    )
    .map_err(|e| AppError::Internal(format!("生成 token 失败: {}", e)))?;

    Ok((token, jti))
}

/// 验证 JWT token
pub fn verify_token(token: &str) -> Result<Claims, AppError> {
    let token_data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(JWT_SECRET.as_bytes()),
        &Validation::default(),
    )
    .map_err(|e| match e.kind() {
        jsonwebtoken::errors::ErrorKind::ExpiredSignature => {
            AppError::Unauthorized("Token 已过期".to_string())
        }
        jsonwebtoken::errors::ErrorKind::InvalidToken => {
            AppError::Unauthorized("无效的 token".to_string())
        }
        _ => AppError::Unauthorized(format!("Token 验证失败: {}", e)),
    })?;

    Ok(token_data.claims)
}

/// 哈希密码
pub fn hash_password(password: &str) -> Result<String, AppError> {
    bcrypt::hash(password, bcrypt::DEFAULT_COST)
        .map_err(|e| AppError::Internal(format!("密码哈希失败: {}", e)))
}

/// 验证密码
pub fn verify_password(password: &str, hash: &str) -> Result<bool, AppError> {
    bcrypt::verify(password, hash).map_err(|e| AppError::Internal(format!("密码验证失败: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试环境初始化：先尝试加载 `.env`，若仍然没有 `JWT_SECRET`，
    /// 则把 `RUST_ENV` 设为 `development` 让 `JWT_SECRET` 的 `Lazy`
    /// 走"开发默认值"分支，避免在 CI / 无 .env 环境下因未配置秘钥而 panic
    /// 一次后整个 `Lazy` 被 poisoned。
    fn init_test_env() {
        use std::sync::Once;
        static INIT: Once = Once::new();
        INIT.call_once(|| {
            let _ = dotenv::dotenv();
            if env::var("JWT_SECRET")
                .map(|s| s.is_empty() || s == "change-me-in-production")
                .unwrap_or(true)
            {
                env::set_var("RUST_ENV", "development");
            }
        });
    }

    #[test]
    fn test_generate_and_verify_token() {
        init_test_env();
        let (token, jti) = generate_token(123, "test@example.com", "user", false).unwrap();
        let claims = verify_token(&token).unwrap();

        assert_eq!(claims.sub, 123);
        assert_eq!(claims.email, "test@example.com");
        assert_eq!(claims.role, "user");
        assert!(!claims.is_superadmin);
        assert!(!claims.is_expired());
        assert_eq!(claims.jti, jti);
        assert!(!claims.jti.is_empty());
    }

    #[test]
    fn test_generate_token_superadmin_flag() {
        init_test_env();
        let (token, _jti) = generate_token(1, "admin@example.com", "admin", true).unwrap();
        let claims = verify_token(&token).unwrap();
        assert!(claims.is_superadmin);
    }

    #[test]
    fn test_generate_token_unique_jti() {
        init_test_env();
        let (_, jti1) = generate_token(1, "a@x.com", "user", false).unwrap();
        let (_, jti2) = generate_token(1, "a@x.com", "user", false).unwrap();
        assert_ne!(jti1, jti2, "每次签发应生成不同 jti");
    }

    #[test]
    fn test_hash_and_verify_password() {
        let password = "test_password_123";
        let hash = hash_password(password).unwrap();

        assert!(verify_password(password, &hash).unwrap());
        assert!(!verify_password("wrong_password", &hash).unwrap());
    }

    #[test]
    fn test_invalid_token() {
        init_test_env();
        let result = verify_token("invalid.token.here");
        assert!(result.is_err());
    }
}
