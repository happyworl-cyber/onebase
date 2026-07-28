use serde::{Deserialize, Serialize};
use validator::Validate;

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
    pub created_at: String,
}

/// 刷新 Token 请求
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

