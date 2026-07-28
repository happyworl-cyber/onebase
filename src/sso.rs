//! SSO / OAuth2 核心逻辑
//!
//! 支持的 provider:
//! - Google
//! - Facebook
//! - GitHub
//! - 通用 OIDC

use serde::{Deserialize, Serialize};

/// 已知 OAuth2 Provider 的端点预设
pub struct ProviderEndpoints {
    pub authorization_url: &'static str,
    pub token_url: &'static str,
    pub userinfo_url: &'static str,
    pub default_scopes: &'static str,
}

pub fn get_provider_endpoints(provider_type: &str) -> Option<ProviderEndpoints> {
    match provider_type {
        "google" => Some(ProviderEndpoints {
            authorization_url: "https://accounts.google.com/o/oauth2/v2/auth",
            token_url: "https://oauth2.googleapis.com/token",
            userinfo_url: "https://openidconnect.googleapis.com/v1/userinfo",
            default_scopes: "openid email profile",
        }),
        "facebook" => Some(ProviderEndpoints {
            authorization_url: "https://www.facebook.com/v18.0/dialog/oauth",
            token_url: "https://graph.facebook.com/v18.0/oauth/access_token",
            userinfo_url: "https://graph.facebook.com/v18.0/me?fields=id,email,name,picture",
            default_scopes: "email public_profile",
        }),
        "github" => Some(ProviderEndpoints {
            authorization_url: "https://github.com/login/oauth/authorize",
            token_url: "https://github.com/login/oauth/access_token",
            userinfo_url: "https://api.github.com/user",
            default_scopes: "read:user user:email",
        }),
        _ => None,
    }
}

/// SSO Provider 配置（从数据库加载）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SsoProvider {
    pub id: i32,
    pub tenant_id: i32,
    pub provider_type: String,
    pub display_name: String,
    pub client_id: String,
    pub client_secret_encrypted: String,
    pub authorization_url: Option<String>,
    pub token_url: Option<String>,
    pub userinfo_url: Option<String>,
    pub scopes: Option<String>,
    pub user_id_field: String,
    pub email_field: String,
    pub name_field: String,
    pub avatar_field: String,
    pub is_active: bool,
}

/// OAuth2 Token 响应
#[derive(Debug, Deserialize)]
pub struct OAuthTokenResponse {
    pub access_token: String,
    pub token_type: Option<String>,
    pub expires_in: Option<u64>,
    pub refresh_token: Option<String>,
    pub scope: Option<String>,
    pub id_token: Option<String>,
}

/// 从 provider 配置中获取实际的端点 URL
impl SsoProvider {
    pub fn get_authorization_url(&self) -> String {
        self.authorization_url
            .clone()
            .or_else(|| {
                get_provider_endpoints(&self.provider_type)
                    .map(|e| e.authorization_url.to_string())
            })
            .unwrap_or_default()
    }

    pub fn get_token_url(&self) -> String {
        self.token_url
            .clone()
            .or_else(|| {
                get_provider_endpoints(&self.provider_type)
                    .map(|e| e.token_url.to_string())
            })
            .unwrap_or_default()
    }

    pub fn get_userinfo_url(&self) -> String {
        self.userinfo_url
            .clone()
            .or_else(|| {
                get_provider_endpoints(&self.provider_type)
                    .map(|e| e.userinfo_url.to_string())
            })
            .unwrap_or_default()
    }

    pub fn get_scopes(&self) -> String {
        self.scopes
            .clone()
            .or_else(|| {
                get_provider_endpoints(&self.provider_type)
                    .map(|e| e.default_scopes.to_string())
            })
            .unwrap_or_else(|| "openid email profile".to_string())
    }

    /// 解密 client_secret
    pub fn decrypt_secret(&self) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(&self.client_secret_encrypted)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .unwrap_or_default()
    }
}

/// 构建 OAuth2 授权 URL
pub fn build_authorization_url(
    provider: &SsoProvider,
    redirect_uri: &str,
    state: &str,
) -> String {
    let auth_url = provider.get_authorization_url();
    let scopes = provider.get_scopes();

    format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&state={}&access_type=offline",
        auth_url,
        urlencoding::encode(&provider.client_id),
        urlencoding::encode(redirect_uri),
        urlencoding::encode(&scopes),
        urlencoding::encode(state),
    )
}

/// 用授权码换取 access_token
pub async fn exchange_code_for_token(
    provider: &SsoProvider,
    code: &str,
    redirect_uri: &str,
) -> Result<OAuthTokenResponse, String> {
    let token_url = provider.get_token_url();
    let client_secret = provider.decrypt_secret();

    let client = reqwest::Client::new();

    let params = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", &provider.client_id),
        ("client_secret", &client_secret),
    ];

    let request = client.post(&token_url).form(&params);

    let request = if provider.provider_type == "github" {
        request.header("Accept", "application/json")
    } else {
        request
    };

    let response = request
        .send()
        .await
        .map_err(|e| format!("Token 请求失败: {}", e))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Token 请求返回错误: {}", body));
    }

    response
        .json::<OAuthTokenResponse>()
        .await
        .map_err(|e| format!("解析 token 响应失败: {}", e))
}

/// 使用 access_token 获取用户信息
pub async fn fetch_user_profile(
    provider: &SsoProvider,
    access_token: &str,
) -> Result<serde_json::Value, String> {
    let userinfo_url = provider.get_userinfo_url();

    let client = reqwest::Client::new();
    let response = client
        .get(&userinfo_url)
        .bearer_auth(access_token)
        .header("User-Agent", crate::brand::user_agent())
        .send()
        .await
        .map_err(|e| format!("UserInfo 请求失败: {}", e))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("UserInfo 返回错误: {}", body));
    }

    let profile: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("解析 UserInfo 失败: {}", e))?;

    // GitHub 的 email 可能不在主响应中，需要额外获取
    if provider.provider_type == "github" && profile.get("email").and_then(|v| v.as_str()).is_none() {
        let email = fetch_github_email(access_token).await.ok();
        if let Some(email) = email {
            let mut profile = profile;
            profile["email"] = serde_json::Value::String(email);
            return Ok(profile);
        }
    }

    Ok(profile)
}

/// GitHub 特殊处理：获取用户主 email
async fn fetch_github_email(access_token: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let response = client
        .get("https://api.github.com/user/emails")
        .bearer_auth(access_token)
        .header("User-Agent", crate::brand::user_agent())
        .send()
        .await
        .map_err(|e| format!("GitHub email 请求失败: {}", e))?;

    let emails: Vec<serde_json::Value> = response
        .json()
        .await
        .map_err(|e| format!("解析 GitHub email 失败: {}", e))?;

    emails
        .iter()
        .find(|e| e["primary"].as_bool() == Some(true))
        .and_then(|e| e["email"].as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "找不到 GitHub 主邮箱".to_string())
}

/// 从 profile 中提取标准字段
pub fn extract_profile_fields(
    provider: &SsoProvider,
    profile: &serde_json::Value,
) -> (String, Option<String>, Option<String>, Option<String>) {
    let external_id = profile
        .get(&provider.user_id_field)
        .and_then(|v| match v {
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Number(n) => Some(n.to_string()),
            _ => None,
        })
        .unwrap_or_else(|| "unknown".to_string());

    let email = profile
        .get(&provider.email_field)
        .and_then(|v| v.as_str())
        .map(String::from);

    let name = profile
        .get(&provider.name_field)
        .and_then(|v| v.as_str())
        .map(String::from);

    let avatar = profile
        .get(&provider.avatar_field)
        .and_then(|v| v.as_str())
        .map(String::from);

    (external_id, email, name, avatar)
}

// urlencoding 辅助（避免额外依赖）
mod urlencoding {
    pub fn encode(input: &str) -> String {
        let mut encoded = String::with_capacity(input.len() * 3);
        for byte in input.bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    encoded.push(byte as char);
                }
                _ => {
                    encoded.push_str(&format!("%{:02X}", byte));
                }
            }
        }
        encoded
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_google_endpoints() {
        let ep = get_provider_endpoints("google").unwrap();
        assert!(ep.authorization_url.contains("google"));
        assert!(ep.token_url.contains("googleapis"));
        assert!(ep.userinfo_url.contains("openidconnect"));
    }

    #[test]
    fn test_github_endpoints() {
        let ep = get_provider_endpoints("github").unwrap();
        assert!(ep.authorization_url.contains("github"));
        assert!(ep.token_url.contains("github"));
    }

    #[test]
    fn test_unknown_provider() {
        assert!(get_provider_endpoints("unknown").is_none());
    }

    #[test]
    fn test_provider_get_scopes_default() {
        let provider = SsoProvider {
            id: 1,
            tenant_id: 1,
            provider_type: "google".to_string(),
            display_name: "Google".to_string(),
            client_id: "test".to_string(),
            client_secret_encrypted: "".to_string(),
            authorization_url: None,
            token_url: None,
            userinfo_url: None,
            scopes: None,
            user_id_field: "sub".to_string(),
            email_field: "email".to_string(),
            name_field: "name".to_string(),
            avatar_field: "picture".to_string(),
            is_active: true,
        };
        assert_eq!(provider.get_scopes(), "openid email profile");
    }

    #[test]
    fn test_provider_custom_scopes() {
        let provider = SsoProvider {
            id: 1,
            tenant_id: 1,
            provider_type: "google".to_string(),
            display_name: "Google".to_string(),
            client_id: "test".to_string(),
            client_secret_encrypted: "".to_string(),
            authorization_url: None,
            token_url: None,
            userinfo_url: None,
            scopes: Some("email".to_string()),
            user_id_field: "sub".to_string(),
            email_field: "email".to_string(),
            name_field: "name".to_string(),
            avatar_field: "picture".to_string(),
            is_active: true,
        };
        assert_eq!(provider.get_scopes(), "email");
    }

    #[test]
    fn test_extract_profile_fields_google() {
        let provider = SsoProvider {
            id: 1,
            tenant_id: 1,
            provider_type: "google".to_string(),
            display_name: "Google".to_string(),
            client_id: "test".to_string(),
            client_secret_encrypted: "".to_string(),
            authorization_url: None,
            token_url: None,
            userinfo_url: None,
            scopes: None,
            user_id_field: "sub".to_string(),
            email_field: "email".to_string(),
            name_field: "name".to_string(),
            avatar_field: "picture".to_string(),
            is_active: true,
        };
        let profile = serde_json::json!({
            "sub": "123456",
            "email": "test@example.com",
            "name": "Test User",
            "picture": "https://example.com/photo.jpg"
        });
        let (id, email, name, avatar) = extract_profile_fields(&provider, &profile);
        assert_eq!(id, "123456");
        assert_eq!(email, Some("test@example.com".to_string()));
        assert_eq!(name, Some("Test User".to_string()));
        assert_eq!(avatar, Some("https://example.com/photo.jpg".to_string()));
    }

    #[test]
    fn test_extract_profile_fields_github_numeric_id() {
        let provider = SsoProvider {
            id: 1,
            tenant_id: 1,
            provider_type: "github".to_string(),
            display_name: "GitHub".to_string(),
            client_id: "test".to_string(),
            client_secret_encrypted: "".to_string(),
            authorization_url: None,
            token_url: None,
            userinfo_url: None,
            scopes: None,
            user_id_field: "id".to_string(),
            email_field: "email".to_string(),
            name_field: "name".to_string(),
            avatar_field: "avatar_url".to_string(),
            is_active: true,
        };
        let profile = serde_json::json!({
            "id": 789,
            "email": "dev@github.com",
            "name": "Dev",
            "avatar_url": "https://avatars.githubusercontent.com/u/789"
        });
        let (id, email, _, _) = extract_profile_fields(&provider, &profile);
        assert_eq!(id, "789");
        assert_eq!(email, Some("dev@github.com".to_string()));
    }

    #[test]
    fn test_urlencoding() {
        assert_eq!(urlencoding::encode("hello world"), "hello%20world");
        assert_eq!(urlencoding::encode("a+b"), "a%2Bb");
        assert_eq!(urlencoding::encode("test"), "test");
    }

    #[test]
    fn test_build_authorization_url() {
        let provider = SsoProvider {
            id: 1,
            tenant_id: 1,
            provider_type: "google".to_string(),
            display_name: "Google".to_string(),
            client_id: "my_client_id".to_string(),
            client_secret_encrypted: "".to_string(),
            authorization_url: None,
            token_url: None,
            userinfo_url: None,
            scopes: None,
            user_id_field: "sub".to_string(),
            email_field: "email".to_string(),
            name_field: "name".to_string(),
            avatar_field: "picture".to_string(),
            is_active: true,
        };

        let url = build_authorization_url(&provider, "http://localhost:3001/callback", "abc123");
        assert!(url.contains("accounts.google.com"));
        assert!(url.contains("client_id=my_client_id"));
        assert!(url.contains("state=abc123"));
        assert!(url.contains("response_type=code"));
    }
}
