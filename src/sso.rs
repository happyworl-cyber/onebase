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
        // Sign in with Apple。Apple 无 userinfo 端点，用户身份在 token 响应的 id_token 里；
        // 请求 name/email scope 时 Apple 要求 response_mode=form_post（回调改为 POST）。
        // client_secret 需用 Team ID/Key ID/私钥动态签发 ES256 JWT，见 idp_oidc::build_runtime_sso_provider。
        "apple" => Some(ProviderEndpoints {
            authorization_url: "https://appleid.apple.com/auth/authorize",
            token_url: "https://appleid.apple.com/auth/token",
            userinfo_url: "",
            default_scopes: "name email",
        }),
        // Mind SSO（im30）。线上认证中心 base = https://login.im30.cn。
        //
        // 走「前端业务接入」流程（PKCE + 授权码）：
        // - authorization_url：登录页**根路径**，文档示例
        //   `${serverUrl}/?client_id=...&response_type=code&redirect_uri=...&scope=...&state=...&code_challenge=...&code_challenge_method=S256`，
        //   所以这里 base 用根 `/`，查询参数由 build_authorization_url 追加。
        // - token_url / userinfo_url：接入文档未给出确切路径（在内网 yapi
        //   http://mind-yapi.im30.lan/project/87 上），这里按 `/account/api/*` 同族
        //   做合理默认，**上线前务必对照 yapi 校验**。
        // - scope：文档明确默认 `openid`。
        //
        // 这些只是预设兜底；不同环境（测试 http://login.mindoffice.lan:8888 /
        // 预发 https://prelogin.mindoffice.cn）的实际 URL 由管理员在创建 Provider
        // 时填 authorization_url/token_url/userinfo_url 覆盖（DB 列优先于预设）。
        "mind" => Some(ProviderEndpoints {
            authorization_url: "https://login.im30.cn/",
            token_url: "https://login.im30.cn/account/api/token",
            userinfo_url: "https://login.im30.cn/account/api/userInfo",
            default_scopes: "openid",
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
    /// 通过该 Provider 登录的用户在所属 tenant 自动获得的角色（owner/admin/member/viewer）。
    pub auto_role: String,
}

/// OAuth2 Token 响应
#[derive(Debug, Deserialize)]
pub struct OAuthTokenResponse {
    pub access_token: String,
    #[allow(dead_code)]
    pub token_type: Option<String>,
    #[allow(dead_code)]
    pub expires_in: Option<u64>,
    pub refresh_token: Option<String>,
    #[allow(dead_code)]
    pub scope: Option<String>,
    pub id_token: Option<String>,
}

/// 从 provider 配置中获取实际的端点 URL
impl SsoProvider {
    pub fn get_authorization_url(&self) -> String {
        self.authorization_url
            .clone()
            .or_else(|| {
                get_provider_endpoints(&self.provider_type).map(|e| e.authorization_url.to_string())
            })
            .unwrap_or_default()
    }

    pub fn get_token_url(&self) -> String {
        self.token_url
            .clone()
            .or_else(|| {
                get_provider_endpoints(&self.provider_type).map(|e| e.token_url.to_string())
            })
            .unwrap_or_default()
    }

    pub fn get_userinfo_url(&self) -> String {
        self.userinfo_url
            .clone()
            .or_else(|| {
                get_provider_endpoints(&self.provider_type).map(|e| e.userinfo_url.to_string())
            })
            .unwrap_or_default()
    }

    pub fn get_scopes(&self) -> String {
        self.scopes
            .clone()
            .or_else(|| {
                get_provider_endpoints(&self.provider_type).map(|e| e.default_scopes.to_string())
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

/// 该 provider 是否由**我们**发起 PKCE（在 authorize 带 code_challenge、token 带 code_verifier）。
///
/// 现状：Mind 走的是其**托管登录页**（`http://login.mindoffice.lan/`），登录页内部
/// 自行处理 PKCE，并**不校验**我们透传的 code_challenge。实测我们发出的 S256 pair
/// 完全自洽（authorize 的 code_challenge == token 的 verifier 推导值），Mind 仍返回
/// `code_challenge无效`——说明我们再叠一层 PKCE 反而和 Mind 内部的 PKCE 冲突。
/// 因此对 Mind 关闭"我方 PKCE"，按**机密客户端**（code + client_secret）换 token，
/// 与接入文档 token 步骤一致。
///
/// 函数与基础设施保留，便于将来对接「确实需要我方 PKCE」的 IdP 时打开。
pub fn provider_requires_pkce(_provider_type: &str) -> bool {
    false
}

/// 生成一对 PKCE (code_verifier, code_challenge)。
///
/// - verifier：32 字节随机数做 base64url（无填充）→ 43 字符，落在 RFC 7636
///   允许的 unreserved 字符集内。
/// - challenge：SHA256(verifier) 再 base64url（无填充），method = S256。
pub fn generate_pkce() -> (String, String) {
    use base64::Engine;
    use rand::RngCore;

    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let challenge = pkce_challenge_s256(&verifier);

    (verifier, challenge)
}

/// 由 code_verifier 计算 S256 code_challenge：BASE64URL-NO-PAD(SHA256(ASCII(verifier)))。
pub fn pkce_challenge_s256(verifier: &str) -> String {
    use base64::Engine;
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

/// 构建 OAuth2 授权 URL。
///
/// `code_challenge` 非空时追加 PKCE 参数（`code_challenge` + `code_challenge_method=S256`）。
/// `access_type=offline` 仅对 google 这类需要 refresh_token 的 IdP 追加，避免给
/// Mind 等发它不认识的参数。
pub fn build_authorization_url(
    provider: &SsoProvider,
    redirect_uri: &str,
    state: &str,
    code_challenge: Option<&str>,
) -> String {
    let auth_url = provider.get_authorization_url();
    let scopes = provider.get_scopes();

    tracing::debug!(
        target: "sso",
        provider_id = provider.id,
        provider_type = %provider.provider_type,
        tenant_id = provider.tenant_id,
        redirect_uri = %redirect_uri,
        pkce = code_challenge.is_some(),
        "构建 OAuth2 授权 URL"
    );

    let mut url = format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&state={}",
        auth_url,
        urlencoding::encode(&provider.client_id),
        urlencoding::encode(redirect_uri),
        urlencoding::encode(&scopes),
        urlencoding::encode(state),
    );

    if let Some(challenge) = code_challenge {
        url.push_str(&format!(
            "&code_challenge={}&code_challenge_method=S256",
            urlencoding::encode(challenge),
        ));
    }

    if provider.provider_type == "google" {
        url.push_str("&access_type=offline");
    }

    // Apple 在请求 name/email scope 时强制要求 form_post，否则拒绝授权。
    if provider.provider_type == "apple" {
        url.push_str("&response_mode=form_post");
    }

    url
}

/// 用授权码换取 access_token
pub async fn exchange_code_for_token(
    provider: &SsoProvider,
    code: &str,
    redirect_uri: &str,
    code_verifier: Option<&str>,
) -> Result<OAuthTokenResponse, String> {
    let token_url = provider.get_token_url();
    let client_secret = provider.decrypt_secret();

    let client = reqwest::Client::new();

    let mut params = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", &provider.client_id),
        ("client_secret", &client_secret),
    ];
    if let Some(verifier) = code_verifier {
        params.push(("code_verifier", verifier));
    }

    tracing::info!(
        target: "sso",
        provider_id = provider.id,
        provider_type = %provider.provider_type,
        token_url = %token_url,
        grant_type = "authorization_code",
        code = %code,
        redirect_uri = %redirect_uri,
        client_id = %provider.client_id,
        has_client_secret = !client_secret.is_empty(),
        client_secret_len = client_secret.len(),
        code_verifier = code_verifier.unwrap_or("<none>"),
        derived_challenge = %code_verifier
            .map(pkce_challenge_s256)
            .unwrap_or_else(|| "<none>".to_string()),
        "OAuth2 token 请求参数（即将发往 IdP）"
    );

    let request = client.post(&token_url).form(&params);

    let request = if provider.provider_type == "github" {
        request.header("Accept", "application/json")
    } else {
        request
    };

    let response = request.send().await.map_err(|e| {
        tracing::error!(
            target: "sso",
            provider_id = provider.id,
            provider_type = %provider.provider_type,
            err = %e,
            "OAuth2 token 请求失败（网络层）"
        );
        format!("Token 请求失败: {}", e)
    })?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        tracing::error!(
            target: "sso",
            provider_id = provider.id,
            provider_type = %provider.provider_type,
            status = status,
            body = %body.chars().take(500).collect::<String>(),
            "OAuth2 token 请求返回错误状态"
        );
        return Err(format!("Token 请求返回错误: {}", body));
    }

    let body = response
        .text()
        .await
        .map_err(|e| format!("读取 token 响应失败: {}", e))?;

    tracing::debug!(
        target: "sso",
        provider_id = provider.id,
        provider_type = %provider.provider_type,
        body = %body.chars().take(2000).collect::<String>(),
        "OAuth2 token 原始响应"
    );

    let raw: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
        format!(
            "解析 token 响应失败: {} (body: {})",
            e,
            body.chars().take(500).collect::<String>()
        )
    })?;

    // 兼容 Mind 等 `{code, data, msg}` 信封：真实 token 在 data 里。
    let payload = unwrap_data_envelope(&raw);

    // 兼容 access_token / token 两种字段名。
    let access_token = payload
        .get("access_token")
        .or_else(|| payload.get("token"))
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| {
            format!(
                "token 响应缺少 access_token/token 字段 (body: {})",
                body.chars().take(500).collect::<String>()
            )
        })?;

    let token = OAuthTokenResponse {
        access_token,
        token_type: payload
            .get("token_type")
            .and_then(|v| v.as_str())
            .map(String::from),
        expires_in: payload.get("expires_in").and_then(|v| v.as_u64()),
        refresh_token: payload
            .get("refresh_token")
            .and_then(|v| v.as_str())
            .map(String::from),
        scope: payload.get("scope").and_then(|v| v.as_str()).map(String::from),
        id_token: payload
            .get("id_token")
            .and_then(|v| v.as_str())
            .map(String::from),
    };

    tracing::info!(
        target: "sso",
        provider_id = provider.id,
        provider_type = %provider.provider_type,
        tenant_id = provider.tenant_id,
        "OAuth2 code 换取 token 成功"
    );

    Ok(token)
}

/// 部分 IdP（如 Mind）用 `{code, data, msg}` 信封包裹真实数据；
/// 若顶层存在对象型 `data` 字段则取出它，否则原样返回。标准 OAuth2 响应没有
/// 这层信封，函数对它们是无操作（no-op）。
fn unwrap_data_envelope(value: &serde_json::Value) -> serde_json::Value {
    match value.get("data") {
        Some(d) if d.is_object() => d.clone(),
        _ => value.clone(),
    }
}

/// 解码 JWT 的 payload 段取出 claims（**不验签**，仅用于读取身份信息）。
///
/// Mind 的 access_token 本身就是 JWT，用户身份 claims 已经在里面，可据此免去
/// 额外的 userinfo 调用（其 userinfo 路径在内网 yapi，且与 `/account/api/userinfo`
/// 默认值不一致会 404）。
pub fn decode_jwt_claims(token: &str) -> Result<serde_json::Value, String> {
    use base64::Engine;
    let payload_b64 = token
        .split('.')
        .nth(1)
        .ok_or_else(|| "不是合法 JWT（缺少 payload 段）".to_string())?;
    // JWT payload 标准是 base64url 无填充；个别实现带填充或用标准字母表，做几种兜底。
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload_b64)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload_b64))
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(payload_b64))
        .map_err(|e| format!("JWT payload base64 解码失败: {}", e))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("JWT payload JSON 解析失败: {}", e))
}

/// 使用 access_token 获取用户信息。
///
/// Mind：access_token 是 JWT，先解出 claims（含稳定的 `UserID`）作为基础 profile，
/// 再**尽力**调 userinfo 端点补充用户名/邮箱/头像；userinfo 失败仅告警、不阻断登录
/// （此时只用 JWT 里的字段）。其他 IdP 走标准 userinfo。
pub async fn fetch_user_profile(
    provider: &SsoProvider,
    access_token: &str,
) -> Result<serde_json::Value, String> {
    if provider.provider_type == "mind" {
        let claims = decode_jwt_claims(access_token)?;
        let mut profile = unwrap_data_envelope(&claims);
        tracing::info!(
            target: "sso",
            provider_id = provider.id,
            provider_type = %provider.provider_type,
            claims = %profile,
            "Mind access_token(JWT) 解析出的 claims"
        );

        // Mind userinfo 需要 userId（来自 JWT 的 UserID）。
        let jwt_user_id = profile.get("UserID").and_then(|v| v.as_str());

        // 尽力补充资料；失败不阻断登录（例如 userinfo 路径未配置正确）。
        match http_fetch_userinfo(provider, access_token, jwt_user_id).await {
            Ok(userinfo) => {
                tracing::info!(
                    target: "sso",
                    provider_id = provider.id,
                    userinfo = %userinfo,
                    "Mind userinfo 补充成功，合并进 profile"
                );
                merge_json_objects(&mut profile, &userinfo);
            }
            Err(e) => {
                tracing::warn!(
                    target: "sso",
                    provider_id = provider.id,
                    err = %e,
                    "Mind userinfo 获取失败（不阻断登录，仅用 JWT 中的字段）"
                );
            }
        }
        return Ok(profile);
    }

    let profile = http_fetch_userinfo(provider, access_token, None).await?;

    // GitHub 的 email 可能不在主响应中，需要额外获取
    if provider.provider_type == "github" && profile.get("email").and_then(|v| v.as_str()).is_none()
    {
        if let Ok(email) = fetch_github_email(access_token).await {
            let mut profile = profile;
            profile["email"] = serde_json::Value::String(email);
            return Ok(profile);
        }
    }

    Ok(profile)
}

/// 向 IdP 的 userinfo 端点发请求并解析（含 `{code,data,msg}` 信封解包）。
///
/// `user_id` 仅 Mind 用到：Mind 的 userinfo 是 **POST**，body 为 `{"userId": "<UserID>"}`
/// （来自 access_token JWT 里的 `UserID`）。其他 IdP 走标准 **GET** + Bearer。
async fn http_fetch_userinfo(
    provider: &SsoProvider,
    access_token: &str,
    user_id: Option<&str>,
) -> Result<serde_json::Value, String> {
    let userinfo_url = provider.get_userinfo_url();
    let is_mind = provider.provider_type == "mind";

    tracing::info!(
        target: "sso",
        provider_id = provider.id,
        provider_type = %provider.provider_type,
        method = if is_mind { "POST" } else { "GET" },
        userinfo_url = %userinfo_url,
        access_token_prefix = %access_token.chars().take(12).collect::<String>(),
        "OAuth2 UserInfo 请求（即将发往 IdP）"
    );

    let client = reqwest::Client::new();
    let request = if is_mind {
        // Mind：POST + JSON body {"userId": "<UserID>"}（userId 可为空，服务端按 token 解析）。
        client
            .post(&userinfo_url)
            .bearer_auth(access_token)
            .header("User-Agent", "OneBase/1.0")
            .json(&serde_json::json!({ "userId": user_id.unwrap_or("") }))
    } else {
        client
            .get(&userinfo_url)
            .bearer_auth(access_token)
            .header("User-Agent", "OneBase/1.0")
    };
    let response = request
        .send()
        .await
        .map_err(|e| {
            tracing::error!(
                target: "sso",
                provider_id = provider.id,
                provider_type = %provider.provider_type,
                err = %e,
                "OAuth2 获取用户信息失败（网络层）"
            );
            format!("UserInfo 请求失败: {}", e)
        })?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        tracing::error!(
            target: "sso",
            provider_id = provider.id,
            provider_type = %provider.provider_type,
            status = status,
            body = %body.chars().take(500).collect::<String>(),
            "OAuth2 获取用户信息返回错误状态"
        );
        return Err(format!("UserInfo 返回错误: {}", body));
    }

    let body = response
        .text()
        .await
        .map_err(|e| format!("读取 UserInfo 响应失败: {}", e))?;

    tracing::info!(
        target: "sso",
        provider_id = provider.id,
        provider_type = %provider.provider_type,
        body = %body.chars().take(2000).collect::<String>(),
        "OAuth2 UserInfo 原始响应"
    );

    let raw: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("解析 UserInfo 失败: {}", e))?;

    // 兼容 Mind 等 `{code, data, msg}` 信封：真实用户信息在 data 里。
    Ok(unwrap_data_envelope(&raw))
}

/// 把 overlay 对象的键浅合并进 base（overlay 优先；仅当两者都是 JSON 对象时生效）。
fn merge_json_objects(base: &mut serde_json::Value, overlay: &serde_json::Value) {
    if let (Some(b), Some(o)) = (base.as_object_mut(), overlay.as_object()) {
        for (k, v) in o {
            b.insert(k.clone(), v.clone());
        }
    }
}

/// GitHub 特殊处理：获取用户主 email
async fn fetch_github_email(access_token: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let response = client
        .get("https://api.github.com/user/emails")
        .bearer_auth(access_token)
        .header("User-Agent", "OneBase/1.0")
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
    // 取稳定唯一标识：优先用管理员配置的字段；取不到时按常见键兜底
    // （Mind 的 JWT claims 里恒有 `UserID`，OIDC 标准里是 `sub`）。
    // 这样即便 userinfo 暂时取不到、或字段名配错，也不会塌缩成 "unknown"
    // 而把所有 SSO 用户撞成同一个账号。
    let pick_id = |key: &str| {
        profile.get(key).and_then(|v| match v {
            serde_json::Value::String(s) if !s.trim().is_empty() => Some(s.clone()),
            serde_json::Value::Number(n) => Some(n.to_string()),
            _ => None,
        })
    };
    let external_id = pick_id(&provider.user_id_field)
        .or_else(|| pick_id("UserID"))
        .or_else(|| pick_id("sub"))
        .or_else(|| pick_id("user_center_id"))
        .or_else(|| pick_id("id"))
        .unwrap_or_else(|| "unknown".to_string());

    // 空字符串视作“没有”——Mind 的 userinfo 常返回 email:""，若原样落库会破坏
    // users.email 的 UNIQUE 约束（第二个空邮箱用户就建不出来）。
    let non_empty = |key: &str| {
        profile
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
    };

    let email = non_empty(&provider.email_field);
    let name = non_empty(&provider.name_field);
    let avatar = non_empty(&provider.avatar_field);

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
    fn test_mind_endpoints() {
        let ep = get_provider_endpoints("mind").unwrap();
        assert!(ep.authorization_url.contains("login.im30.cn"));
        // 前端接入：authorize 走登录页根路径，不再是 /account/api/authorize
        assert!(!ep.authorization_url.contains("/account/api/authorize"));
        assert!(ep.token_url.contains("/account/api/token"));
        assert_eq!(ep.default_scopes, "openid");
        // Mind 走托管登录页，PKCE 由其登录页内部处理，我方不再叠加。
        assert!(!provider_requires_pkce("mind"));
        assert!(!provider_requires_pkce("google"));
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
            auto_role: "member".to_string(),
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
            auto_role: "member".to_string(),
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
            auto_role: "member".to_string(),
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
            auto_role: "member".to_string(),
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
            auto_role: "member".to_string(),
        };

        let url =
            build_authorization_url(&provider, "http://localhost:3001/callback", "abc123", None);
        assert!(url.contains("accounts.google.com"));
        assert!(url.contains("client_id=my_client_id"));
        assert!(url.contains("state=abc123"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("access_type=offline"));
        assert!(!url.contains("code_challenge"));
    }

    #[test]
    fn test_build_authorization_url_pkce() {
        let provider = SsoProvider {
            id: 1,
            tenant_id: 1,
            provider_type: "mind".to_string(),
            display_name: "Mind".to_string(),
            client_id: "cid".to_string(),
            client_secret_encrypted: "".to_string(),
            authorization_url: Some("http://login.mindoffice.lan:8888/".to_string()),
            token_url: None,
            userinfo_url: None,
            scopes: None,
            user_id_field: "sub".to_string(),
            email_field: "email".to_string(),
            name_field: "name".to_string(),
            avatar_field: "picture".to_string(),
            is_active: true,
            auto_role: "member".to_string(),
        };
        let url = build_authorization_url(
            &provider,
            "http://localhost:3001/sso/callback",
            "st",
            Some("CHALLENGE"),
        );
        assert!(url.starts_with("http://login.mindoffice.lan:8888/?"));
        assert!(url.contains("code_challenge=CHALLENGE"));
        assert!(url.contains("code_challenge_method=S256"));
        // mind 不应带 google 专属的 access_type
        assert!(!url.contains("access_type"));
    }

    #[test]
    fn test_pkce_challenge_rfc7636_vector() {
        // RFC 7636 附录 B 官方测试向量
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert_eq!(pkce_challenge_s256(verifier), challenge);
    }

    #[test]
    fn test_generate_pkce() {
        let (verifier, challenge) = generate_pkce();
        assert_eq!(pkce_challenge_s256(&verifier), challenge);
        // base64url(32 bytes) = 43 chars，base64url(sha256)=43 chars
        assert_eq!(verifier.len(), 43);
        assert_eq!(challenge.len(), 43);
        assert_ne!(verifier, challenge);
        // 无填充、无非 url-safe 字符
        assert!(!verifier.contains('='));
        assert!(!verifier.contains('+'));
        assert!(!verifier.contains('/'));
    }
}
