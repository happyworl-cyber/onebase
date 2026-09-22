//! 项目凭证运行时：装载结果、模板解析、HTTP 头注入、字段校验。
//! 密钥明文只短暂留在 `CredentialFields.secret`；`Debug` 不打印 secret。

use crate::error::AppError;
use base64::{engine::general_purpose, Engine as _};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

pub const DEFAULT_API_KEY_HEADER: &str = "X-API-Key";
pub const CRED_FIELD_USERNAME: &str = "username";
pub const CRED_FIELD_PASSWORD: &str = "password";
pub const CRED_FIELD_TOKEN: &str = "token";
pub const CRED_FIELD_API_KEY: &str = "api_key";
pub const CRED_FIELD_HEADER_NAME: &str = "header_name";

#[derive(Clone)]
pub struct CredentialFields {
    pub id: i32,
    pub name: String,
    pub kind: String,
    pub username: Option<String>,
    pub header_name: Option<String>,
    pub secret: Option<String>,
}

impl std::fmt::Debug for CredentialFields {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CredentialFields")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("kind", &self.kind)
            .field("username", &self.username)
            .field("header_name", &self.header_name)
            .field("secret", &self.secret.as_ref().map(|_| "<masked>"))
            .finish()
    }
}

#[derive(Clone, Default)]
pub struct CredentialStore {
    by_id: HashMap<i32, CredentialFields>,
    by_name: HashMap<String, CredentialFields>,
}

impl std::fmt::Debug for CredentialStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CredentialStore")
            .field("count", &self.by_id.len())
            .finish()
    }
}

impl CredentialStore {
    pub fn insert(&mut self, cred: CredentialFields) {
        self.by_id.insert(cred.id, cred.clone());
        self.by_name.insert(cred.name.clone(), cred);
    }

    pub fn get_by_id(&self, id: i32) -> Option<&CredentialFields> {
        self.by_id.get(&id)
    }

    pub fn get_by_name(&self, name: &str) -> Option<&CredentialFields> {
        self.by_name.get(name)
    }

    pub fn get_field(&self, name: &str, field: &str) -> Option<String> {
        let cred = self.by_name.get(name)?;
        field_value(cred, field)
    }

    pub fn secret_values(&self) -> Vec<&str> {
        self.by_id
            .values()
            .filter_map(|c| c.secret.as_deref())
            .filter(|s| s.len() >= 4)
            .collect()
    }

    pub fn len(&self) -> usize {
        self.by_id.len()
    }
}

fn effective_header_name(cred: &CredentialFields) -> String {
    cred.header_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_API_KEY_HEADER)
        .to_string()
}

pub fn field_value(cred: &CredentialFields, field: &str) -> Option<String> {
    match (cred.kind.as_str(), field) {
        ("basic", CRED_FIELD_USERNAME) => cred.username.clone(),
        ("basic", CRED_FIELD_PASSWORD) => cred.secret.clone(),
        ("bearer", CRED_FIELD_TOKEN) => cred.secret.clone(),
        ("api_key", CRED_FIELD_API_KEY) => cred.secret.clone(),
        ("api_key", CRED_FIELD_HEADER_NAME) => Some(effective_header_name(cred)),
        _ => None,
    }
}

/// `cred.` 之后的路径：最后一段是字段，前面整段是名称。
pub fn parse_cred_path(path: &str) -> Option<(&str, &str)> {
    let dot = path.rfind('.')?;
    if dot == 0 || dot + 1 == path.len() {
        return None;
    }
    let name = &path[..dot];
    let field = &path[dot + 1..];
    if name.is_empty() || field.is_empty() {
        return None;
    }
    Some((name, field))
}

pub fn apply_http_auth_headers(
    headers: &mut Map<String, Value>,
    cred: &CredentialFields,
) -> Result<(), String> {
    let secret = cred
        .secret
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("凭证 {} 解密失败", cred.name))?;
    match cred.kind.as_str() {
        "basic" => {
            let user = cred.username.as_deref().unwrap_or("");
            let encoded = general_purpose::STANDARD.encode(format!("{user}:{secret}"));
            headers.insert(
                "Authorization".to_string(),
                json!(format!("Basic {encoded}")),
            );
        }
        "bearer" => {
            headers.insert(
                "Authorization".to_string(),
                json!(format!("Bearer {secret}")),
            );
        }
        "api_key" => {
            headers.insert(effective_header_name(cred), json!(secret));
        }
        other => return Err(format!("不支持的凭证类型：{other}")),
    }
    Ok(())
}

pub fn validate_kind(kind: &str) -> Result<String, AppError> {
    let kind = kind.trim().to_string();
    if matches!(kind.as_str(), "basic" | "bearer" | "api_key" | "aliyun_ak") {
        Ok(kind)
    } else {
        Err(AppError::validation(
            "wfcred_invalid_kind",
            format!("非法凭证类型：{kind}（仅支持 basic / bearer / api_key / aliyun_ak）"),
            json!({ "kind": kind }),
        ))
    }
}

pub fn validate_header_name(name: &str) -> Result<Option<String>, AppError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > 128 {
        return Err(AppError::validation(
            "wfcred_header_name_too_long",
            "header_name 过长（上限 128 字符）",
            json!({ "max_len": 128 }),
        ));
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(AppError::validation(
            "wfcred_header_name_charset",
            "header_name 只允许字母数字、下划线和连字符",
            json!({}),
        ));
    }
    Ok(Some(trimmed.to_string()))
}

pub fn validate_kind_fields(kind: &str, username: Option<&str>) -> Result<(), AppError> {
    if kind == "basic" || kind == "aliyun_ak" {
        let ok = username.map(str::trim).filter(|s| !s.is_empty()).is_some();
        if !ok {
            return Err(if kind == "aliyun_ak" {
                AppError::validation(
                    "wfcred_aliyun_ak_missing_access_key_id",
                    "aliyun_ak 凭证必须填写 AccessKeyId",
                    json!({}),
                )
            } else {
                AppError::validation(
                    "wfcred_basic_missing_username",
                    "basic 凭证必须填写用户名",
                    json!({}),
                )
            });
        }
    }
    Ok(())
}

pub fn workflow_loads_kind(kind: &str) -> bool {
    kind != "aliyun_ak"
}

pub fn datasource_accepts_kind(kind: &str) -> bool {
    kind == "basic"
}

pub async fn load_credential_store(pool: &sqlx::PgPool, tenant_id: i32) -> CredentialStore {
    use sqlx::Row;
    let rows = match sqlx::query(
        r#"SELECT id, name, kind, username, header_name, secret_encrypted
           FROM management.wf_credentials WHERE tenant_id = $1"#,
    )
    .bind(tenant_id)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!(tenant_id, error = %e, "加载项目凭证失败，按空表降级");
            return CredentialStore::default();
        }
    };
    let mut store = CredentialStore::default();
    for row in rows {
        let id: i32 = row.get("id");
        let name: String = row.get("name");
        let kind: String = row.get("kind");
        if !workflow_loads_kind(&kind) {
            continue;
        }
        let secret = match crate::crypto::decrypt_secret(&row.get::<String, _>("secret_encrypted"))
        {
            Ok(v) => Some(v),
            Err(e) => {
                tracing::error!(tenant_id, name = %name, error = %e, "凭证解密失败，跳过该条");
                None
            }
        };
        store.insert(CredentialFields {
            id,
            name,
            kind,
            username: row.get("username"),
            header_name: row.get("header_name"),
            secret,
        });
    }
    store
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn basic() -> CredentialFields {
        CredentialFields {
            id: 1,
            name: "生产库账号".into(),
            kind: "basic".into(),
            username: Some("app_ro".into()),
            header_name: None,
            secret: Some("s3cret-pass".into()),
        }
    }

    fn bearer() -> CredentialFields {
        CredentialFields {
            id: 2,
            name: "obm_token".into(),
            kind: "bearer".into(),
            username: None,
            header_name: None,
            secret: Some("tok_abc".into()),
        }
    }

    fn api_key() -> CredentialFields {
        CredentialFields {
            id: 3,
            name: "stripe".into(),
            kind: "api_key".into(),
            username: None,
            header_name: None,
            secret: Some("sk_live_abcdef".into()),
        }
    }

    #[test]
    fn parse_cred_path_chinese_name() {
        assert_eq!(
            parse_cred_path("生产库账号.password"),
            Some(("生产库账号", "password"))
        );
    }

    #[test]
    fn parse_cred_path_requires_field() {
        assert_eq!(parse_cred_path("生产库账号"), None);
        assert_eq!(parse_cred_path(".password"), None);
    }

    #[test]
    fn store_lookup_hit_and_kind_mismatch() {
        let mut store = CredentialStore::default();
        store.insert(basic());
        store.insert(bearer());
        assert_eq!(
            store.get_field("生产库账号", "password").as_deref(),
            Some("s3cret-pass")
        );
        assert_eq!(
            store.get_field("生产库账号", "username").as_deref(),
            Some("app_ro")
        );
        assert_eq!(store.get_field("生产库账号", "token"), None);
        assert_eq!(store.get_field("missing", "password"), None);
        assert_eq!(
            store.get_field("obm_token", "token").as_deref(),
            Some("tok_abc")
        );
    }

    #[test]
    fn api_key_header_defaults() {
        let cred = api_key();
        assert_eq!(
            field_value(&cred, "header_name").as_deref(),
            Some(DEFAULT_API_KEY_HEADER)
        );
        let mut named = cred.clone();
        named.header_name = Some("X-Custom-Key".into());
        assert_eq!(
            field_value(&named, "header_name").as_deref(),
            Some("X-Custom-Key")
        );
    }

    #[test]
    fn apply_headers_overwrites_authorization() {
        let mut headers = Map::new();
        headers.insert("Authorization".into(), json!("Bearer old"));
        apply_http_auth_headers(&mut headers, &bearer()).unwrap();
        assert_eq!(headers["Authorization"], json!("Bearer tok_abc"));
    }

    #[test]
    fn apply_headers_basic_and_api_key() {
        let mut headers = Map::new();
        apply_http_auth_headers(&mut headers, &basic()).unwrap();
        let auth = headers["Authorization"].as_str().unwrap();
        assert!(auth.starts_with("Basic "));

        let mut headers = Map::new();
        apply_http_auth_headers(&mut headers, &api_key()).unwrap();
        assert_eq!(headers[DEFAULT_API_KEY_HEADER], json!("sk_live_abcdef"));
    }

    fn aliyun_ak() -> CredentialFields {
        CredentialFields {
            id: 9,
            name: "阿里云生产".into(),
            kind: "aliyun_ak".into(),
            username: Some("LTAI5tExample".into()),
            header_name: None,
            secret: Some("super-secret-sk".into()),
        }
    }

    #[test]
    fn aliyun_ak_kind_rules() {
        assert_eq!(validate_kind(" aliyun_ak ").unwrap(), "aliyun_ak");
        assert!(validate_kind_fields("aliyun_ak", Some("")).is_err());
        assert!(validate_kind_fields("aliyun_ak", Some("LTAI5t")).is_ok());
        assert!(!workflow_loads_kind("aliyun_ak"));
        assert!(workflow_loads_kind("basic"));
        assert!(!datasource_accepts_kind("aliyun_ak"));
        assert!(field_value(&aliyun_ak(), "access_key_secret").is_none());
        assert!(field_value(&aliyun_ak(), "username").is_none());
        let mut headers = Map::new();
        assert!(apply_http_auth_headers(&mut headers, &aliyun_ak()).is_err());
    }

    #[test]
    fn validate_kind_and_header_name() {
        assert_eq!(validate_kind(" api_key ").unwrap(), "api_key");
        assert!(validate_kind("oauth").is_err());
        assert_eq!(validate_header_name("").unwrap(), None);
        assert_eq!(
            validate_header_name(" X-API-Key ").unwrap(),
            Some("X-API-Key".into())
        );
        assert!(validate_header_name("X API").is_err());
        assert!(validate_header_name("X:Key").is_err());
        assert!(validate_kind_fields("basic", Some("")).is_err());
        assert!(validate_kind_fields("basic", Some("u")).is_ok());
        assert!(datasource_accepts_kind("basic"));
        assert!(!datasource_accepts_kind("bearer"));
    }

    #[test]
    fn secret_values_skips_short_and_failed() {
        let mut store = CredentialStore::default();
        store.insert(basic());
        let mut failed = bearer();
        failed.secret = None;
        store.insert(failed);
        assert_eq!(store.secret_values(), vec!["s3cret-pass"]);
    }
}
