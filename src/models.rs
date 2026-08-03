use serde::{Deserialize, Serialize};
use validator::Validate;

// ─── 时间序列化工具（统一 UTC 标记）─────────────────────────────
//
// 数据库 `TIMESTAMP` 列以 UTC 存储但**不带时区信息**。直接 `serialize` 或 `.to_string()`
// 得到的字符串没有 Z/偏移，前端 `new Date(...)` 会按浏览器本地时区解析，导致显示时间
// 与北京时间差 8 小时。这里统一转成带偏移的 RFC3339（如 `2026-06-29T04:23:14+00:00`），
// 前端即可正确转换到本地时区。所有展示用的 NaiveDateTime 都应经由这里输出。

/// 把 UTC 存储的 `NaiveDateTime` 转成带偏移的 RFC3339 字符串。
pub fn naive_to_utc_string(dt: chrono::NaiveDateTime) -> String {
    chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(dt, chrono::Utc).to_rfc3339()
}

/// `naive_to_utc_string` 的 Option 版本：None → None。
pub fn naive_opt_to_utc_string(dt: Option<chrono::NaiveDateTime>) -> Option<String> {
    dt.map(naive_to_utc_string)
}

/// serde `serialize_with` 适配器：结构体字段为 `NaiveDateTime` 时使用。
pub fn serialize_naive_as_utc<S>(
    dt: &chrono::NaiveDateTime,
    s: S,
) -> std::result::Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(*dt, chrono::Utc).serialize(s)
}

/// serde `serialize_with` 适配器：结构体字段为 `Option<NaiveDateTime>` 时使用。
#[allow(dead_code)]
pub fn serialize_naive_as_utc_opt<S>(
    dt: &Option<chrono::NaiveDateTime>,
    s: S,
) -> std::result::Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    match dt {
        Some(d) => serialize_naive_as_utc(d, s),
        None => s.serialize_none(),
    }
}

/// 用户注册请求
#[derive(Debug, Deserialize, Validate)]
pub struct RegisterRequest {
    #[validate(length(min = 1, max = 100, message = "用户名长度必须在 1-100 字符之间"))]
    pub username: String,

    #[validate(email(message = "无效的邮箱地址"))]
    pub email: String,

    #[validate(length(min = 8, message = "密码至少 8 个字符"))]
    #[validate(custom(function = "validate_password_strength"))]
    pub password: String,
}

/// 用户登录请求
#[derive(Debug, Deserialize, Validate)]
pub struct LoginRequest {
    #[validate(email(message = "无效的邮箱地址"))]
    pub email: String,

    #[validate(length(min = 1, message = "密码不能为空"))]
    pub password: String,
}

/// 认证响应
#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: UserInfo,
}

/// 用户信息（不包含密码）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserInfo {
    pub id: i32,
    pub username: String,
    pub email: String,
    pub role: String,
    #[serde(default)]
    pub is_superadmin: bool,
    /// 是否必须先修改密码才能继续使用（内置默认管理员首登强制改密）
    #[serde(default)]
    pub must_change_password: bool,
    pub created_at: String,
}

/// 刷新 Token 请求
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct RefreshTokenRequest {
    pub token: String,
}

/// 自定义密码强度验证
fn validate_password_strength(password: &str) -> Result<(), validator::ValidationError> {
    let has_uppercase = password.chars().any(|c| c.is_uppercase());
    let has_lowercase = password.chars().any(|c| c.is_lowercase());
    let has_digit = password.chars().any(|c| c.is_numeric());

    if !has_uppercase || !has_lowercase || !has_digit {
        return Err(validator::ValidationError::new(
            "密码必须包含大写字母、小写字母和数字",
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use validator::Validate;

    #[test]
    fn test_valid_register_request() {
        let req = RegisterRequest {
            username: "testuser".to_string(),
            email: "test@example.com".to_string(),
            password: "Password123".to_string(),
        };

        assert!(req.validate().is_ok());
    }

    #[test]
    fn test_invalid_email() {
        let req = RegisterRequest {
            username: "testuser".to_string(),
            email: "invalid-email".to_string(),
            password: "Password123".to_string(),
        };

        assert!(req.validate().is_err());
    }

    #[test]
    fn test_weak_password() {
        let req = RegisterRequest {
            username: "testuser".to_string(),
            email: "test@example.com".to_string(),
            password: "weak".to_string(),
        };

        assert!(req.validate().is_err());
    }

    #[test]
    fn test_password_without_uppercase() {
        let req = RegisterRequest {
            username: "testuser".to_string(),
            email: "test@example.com".to_string(),
            password: "password123".to_string(),
        };

        assert!(req.validate().is_err());
    }
}
