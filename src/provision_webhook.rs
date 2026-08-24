//! P3：Provisioner Webhook —— 开通项目时调用运维 HTTP 接口创建 PG（及可选 Redis）。
//!
//! 配置见 `PROVISION_WEBHOOK_*` 环境变量；契约见
//! `docs/superpowers/specs/2026-06-17-p3-provisioner-webhook-design.md`。

use crate::auth::Claims;
use crate::error::{AppError, Result};
use crate::pg_pool_helpers::PgAdminCredentials;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::Deserialize;
use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct WebhookConfig {
    pub url: String,
    pub token: Option<String>,
    pub timeout: Duration,
    pub deprovision_url: Option<String>,
    pub poll_interval: Duration,
    pub poll_max: Duration,
}

#[derive(Debug, Clone)]
pub struct WebhookProvisionOutcome {
    pub provision_id: String,
    pub db_host: String,
    pub db_port: i32,
    pub db_name: String,
    pub db_user: String,
    pub db_password: String,
    pub env_vars: HashMap<String, String>,
}

impl WebhookProvisionOutcome {
    pub fn creds(&self) -> PgAdminCredentials {
        PgAdminCredentials {
            db_host: self.db_host.clone(),
            db_port: self.db_port,
            admin_user: self.db_user.clone(),
            admin_password: self.db_password.clone(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProvisionWebhookRequest<'a> {
    pub action: &'static str,
    pub name: &'a str,
    pub slug: &'a str,
    pub template_slug: &'a str,
    pub requested_resources: Vec<String>,
    pub caller: ProvisionCaller<'a>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProvisionCaller<'a> {
    pub user_id: i32,
    pub email: &'a str,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProvisionPollRequest<'a> {
    pub action: &'static str,
    pub provision_id: &'a str,
    pub slug: &'a str,
}

#[derive(Debug, Deserialize)]
struct WebhookErrorBody {
    error: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WebhookProvisionResponse {
    #[serde(default)]
    status: Option<String>,
    provision_id: Option<String>,
    #[serde(default)]
    postgresql: Option<WebhookPostgresql>,
    #[serde(default)]
    redis: Option<WebhookRedis>,
    #[serde(default)]
    env_vars: HashMap<String, String>,
    #[serde(default)]
    poll_after_secs: Option<u64>,
    error: Option<String>,
    message: Option<String>,
}

enum ProvisionParseResult {
    Ready(WebhookProvisionOutcome),
    Pending {
        provision_id: String,
        poll_after_secs: u64,
        message: Option<String>,
    },
    Failed(String),
}

#[derive(Debug, Deserialize)]
struct WebhookRedis {
    url: String,
}

#[derive(Debug, Deserialize)]
struct WebhookPostgresql {
    host: String,
    #[serde(default = "default_pg_port")]
    port: i32,
    database: String,
    user: String,
    password: String,
}

fn default_pg_port() -> i32 {
    5432
}

/// 前端可读：是否启用运维 Webhook 开通（不暴露 token / URL）。
pub fn public_webhook_config() -> serde_json::Value {
    let cfg = load_config();
    serde_json::json!({
        "enabled": cfg.is_some(),
        "supports_redis": true,
        "supports_async_poll": cfg.is_some(),
        "poll_interval_secs": cfg.as_ref().map(|c| c.poll_interval.as_secs()).unwrap_or(5),
        "poll_max_secs": cfg.as_ref().map(|c| c.poll_max.as_secs()).unwrap_or(600),
        "description": "由运维 Provisioner 创建独立 PostgreSQL 实例（可选 Redis），耗时可能 1–5 分钟；支持异步 poll",
    })
}

/// 超管只读：Webhook 配置是否就绪（不暴露 URL / token 明文）。
pub fn admin_webhook_status() -> serde_json::Value {
    let cfg = load_config();
    let deprovision_configured = std::env::var("PROVISION_WEBHOOK_DEPROVISION_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .is_some();
    let token_configured = std::env::var("PROVISION_WEBHOOK_TOKEN")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .is_some();
    serde_json::json!({
        "provision_webhook_enabled": cfg.is_some(),
        "supports_redis": true,
        "deprovision_url_configured": deprovision_configured,
        "token_configured": token_configured,
        "timeout_secs": cfg.as_ref().map(|c| c.timeout.as_secs()).unwrap_or(120),
        "poll_interval_secs": cfg.as_ref().map(|c| c.poll_interval.as_secs()).unwrap_or(5),
        "poll_max_secs": cfg.as_ref().map(|c| c.poll_max.as_secs()).unwrap_or(600),
        "supports_async_poll": cfg.is_some(),
        "description": "由运维 Provisioner 创建独立 PostgreSQL / Redis；删项目时可回调 deprovision；长任务支持 poll",
    })
}

/// 超管探活：对 Provisioner URL 发轻量 POST（`action=ping`），能连上即视为可达。
pub async fn probe_provision_webhook() -> serde_json::Value {
    let Some(cfg) = load_config() else {
        return serde_json::json!({
            "ok": false,
            "error": "未配置 PROVISION_WEBHOOK_URL",
        });
    };

    let probe_timeout = Duration::from_secs(5);
    let client = match reqwest::Client::builder().timeout(probe_timeout).build() {
        Ok(c) => c,
        Err(e) => {
            return serde_json::json!({
                "ok": false,
                "error": format!("HTTP 客户端初始化失败: {}", e),
            });
        }
    };

    let mut req = client
        .post(&cfg.url)
        .header(CONTENT_TYPE, "application/json")
        .json(&serde_json::json!({ "action": "ping" }));

    if let Some(token) = &cfg.token {
        req = req.header(AUTHORIZATION, format!("Bearer {}", token));
    }

    match req.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            serde_json::json!({
                "ok": true,
                "http_status": status,
                "message": "Provisioner 端点可达",
            })
        }
        Err(e) => serde_json::json!({
            "ok": false,
            "error": format!("Provisioner 不可达: {}", e),
        }),
    }
}

pub fn load_config() -> Option<WebhookConfig> {
    let url = std::env::var("PROVISION_WEBHOOK_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())?;
    let timeout_secs = std::env::var("PROVISION_WEBHOOK_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(120);
    let poll_interval_secs = std::env::var("PROVISION_WEBHOOK_POLL_INTERVAL_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(5);
    let poll_max_secs = std::env::var("PROVISION_WEBHOOK_POLL_MAX_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(600);
    Some(WebhookConfig {
        url: url.trim().to_string(),
        token: std::env::var("PROVISION_WEBHOOK_TOKEN")
            .ok()
            .filter(|s| !s.trim().is_empty()),
        timeout: Duration::from_secs(timeout_secs),
        deprovision_url: std::env::var("PROVISION_WEBHOOK_DEPROVISION_URL")
            .ok()
            .filter(|s| !s.trim().is_empty()),
        poll_interval: Duration::from_secs(poll_interval_secs.max(1)),
        poll_max: Duration::from_secs(poll_max_secs.max(30)),
    })
}

pub fn normalize_requested_resources(raw: Option<Vec<String>>) -> Result<Vec<String>> {
    let list = raw.unwrap_or_else(|| vec!["postgresql".to_string()]);
    let mut out: Vec<String> = list
        .into_iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    if out.is_empty() {
        out.push("postgresql".to_string());
    }

    for r in &out {
        if r != "postgresql" && r != "redis" {
            return Err(AppError::InvalidQuery(format!(
                "不支持的 requested_resources: {}（允许: postgresql, redis）",
                r
            )));
        }
    }

    if !out.iter().any(|r| r == "postgresql") {
        out.insert(0, "postgresql".to_string());
    }

    out.sort();
    out.dedup();
    Ok(out)
}

pub async fn call_provision_webhook(
    cfg: &WebhookConfig,
    name: &str,
    slug: &str,
    template_slug: &str,
    requested_resources: Vec<String>,
    claims: &Claims,
) -> Result<WebhookProvisionOutcome> {
    let body = ProvisionWebhookRequest {
        action: "provision",
        name,
        slug,
        template_slug,
        requested_resources,
        caller: ProvisionCaller {
            user_id: claims.sub,
            email: &claims.email,
        },
    };

    let request_id = uuid::Uuid::new_v4().to_string();
    let client = build_http_client(cfg.timeout)?;

    let mut req = client
        .post(&cfg.url)
        .header(CONTENT_TYPE, "application/json")
        .header("X-Onebase-Request-Id", &request_id)
        .json(&body);

    if let Some(token) = &cfg.token {
        req = req.header(AUTHORIZATION, format!("Bearer {}", token));
    }

    tracing::info!(
        target = "provisioning",
        event = "provision_webhook_call",
        slug = slug,
        request_id = %request_id,
        url = %cfg.url,
        "调用运维 Provisioner Webhook"
    );

    let resp = req.send().await.map_err(|e| {
        AppError::InvalidQuery(format!("Provisioner 请求失败（{}）：{}", cfg.url, e))
    })?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let http_pending = status.as_u16() == 202;

    if !status.is_success() && !http_pending {
        let msg = parse_webhook_error(&text)
            .unwrap_or_else(|| format!("Provisioner 返回 HTTP {}", status));
        tracing::warn!(
            target = "provisioning",
            event = "provision_webhook_failed",
            slug = slug,
            status = %status,
            "Provisioner 失败: {}",
            msg
        );
        return Err(AppError::InvalidQuery(msg));
    }

    match parse_provision_response(slug, &text, http_pending)? {
        ProvisionParseResult::Ready(outcome) => {
            tracing::info!(
                target = "provisioning",
                event = "provision_webhook_ok",
                slug = slug,
                provision_id = %outcome.provision_id,
                host = %outcome.db_host,
                database = %outcome.db_name,
                "Provisioner 同步返回 PG 连接信息"
            );
            Ok(outcome)
        }
        ProvisionParseResult::Pending {
            provision_id,
            poll_after_secs,
            message,
        } => {
            tracing::info!(
                target = "provisioning",
                event = "provision_webhook_pending",
                slug = slug,
                provision_id = %provision_id,
                poll_after_secs = poll_after_secs,
                "Provisioner 异步开通，开始 poll"
            );
            poll_provision_until_ready(cfg, slug, &provision_id, poll_after_secs, message).await
        }
        ProvisionParseResult::Failed(msg) => {
            tracing::warn!(
                target = "provisioning",
                event = "provision_webhook_failed",
                slug = slug,
                "Provisioner 失败: {}",
                msg
            );
            Err(AppError::InvalidQuery(msg))
        }
    }
}

async fn poll_provision_until_ready(
    cfg: &WebhookConfig,
    slug: &str,
    provision_id: &str,
    initial_poll_after_secs: u64,
    initial_message: Option<String>,
) -> Result<WebhookProvisionOutcome> {
    let deadline = Instant::now() + cfg.poll_max;
    let client = build_http_client(cfg.timeout)?;
    let mut next_sleep = initial_poll_after_secs
        .max(1)
        .min(cfg.poll_interval.as_secs().max(1));

    if let Some(msg) = initial_message.as_ref().filter(|s| !s.is_empty()) {
        tracing::info!(
            target = "provisioning",
            slug = slug,
            provision_id = provision_id,
            "Provisioner: {}",
            msg
        );
    }

    loop {
        if Instant::now() >= deadline {
            return Err(AppError::InvalidQuery(format!(
                "Provisioner 异步开通超时（已等待 {} 秒）",
                cfg.poll_max.as_secs()
            )));
        }

        tokio::time::sleep(Duration::from_secs(next_sleep)).await;

        let body = ProvisionPollRequest {
            action: "poll",
            provision_id,
            slug,
        };

        let mut req = client
            .post(&cfg.url)
            .header(CONTENT_TYPE, "application/json")
            .header("X-Onebase-Request-Id", &uuid::Uuid::new_v4().to_string())
            .json(&body);

        if let Some(token) = &cfg.token {
            req = req.header(AUTHORIZATION, format!("Bearer {}", token));
        }

        let resp = req
            .send()
            .await
            .map_err(|e| AppError::InvalidQuery(format!("Provisioner poll 请求失败: {}", e)))?;

        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let http_pending = status.as_u16() == 202;

        if !status.is_success() && !http_pending {
            let msg = parse_webhook_error(&text)
                .unwrap_or_else(|| format!("Provisioner poll 返回 HTTP {}", status));
            return Err(AppError::InvalidQuery(msg));
        }

        match parse_provision_response(slug, &text, http_pending)? {
            ProvisionParseResult::Ready(outcome) => {
                tracing::info!(
                    target = "provisioning",
                    event = "provision_webhook_poll_ok",
                    slug = slug,
                    provision_id = %outcome.provision_id,
                    "Provisioner poll 完成"
                );
                return Ok(outcome);
            }
            ProvisionParseResult::Pending {
                poll_after_secs,
                message,
                ..
            } => {
                next_sleep = poll_after_secs
                    .max(1)
                    .min(cfg.poll_interval.as_secs().max(1));
                if let Some(msg) = message.filter(|s| !s.is_empty()) {
                    tracing::info!(
                        target = "provisioning",
                        slug = slug,
                        provision_id = provision_id,
                        "Provisioner poll: {}",
                        msg
                    );
                }
            }
            ProvisionParseResult::Failed(msg) => {
                return Err(AppError::InvalidQuery(msg));
            }
        }
    }
}

fn build_http_client(timeout: Duration) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| AppError::Internal(format!("Provisioner HTTP 客户端初始化失败: {}", e)))
}

fn parse_provision_response(
    slug: &str,
    text: &str,
    http_pending: bool,
) -> Result<ProvisionParseResult> {
    if text.trim().is_empty() {
        if http_pending {
            return Ok(ProvisionParseResult::Pending {
                provision_id: format!("prov_{}", slug),
                poll_after_secs: 5,
                message: Some("Provisioner 已接受请求".to_string()),
            });
        }
        return Err(AppError::Internal("Provisioner 响应体为空".to_string()));
    }

    let parsed: WebhookProvisionResponse = serde_json::from_str(text).map_err(|e| {
        AppError::Internal(format!(
            "Provisioner 响应 JSON 解析失败: {}；body={}",
            e,
            truncate_for_log(text, 500)
        ))
    })?;

    let status = parsed.status.as_deref().map(str::to_ascii_lowercase);
    if status.as_deref() == Some("failed") {
        let msg = parsed
            .error
            .or(parsed.message)
            .unwrap_or_else(|| "Provisioner 开通失败".to_string());
        return Ok(ProvisionParseResult::Failed(msg));
    }
    if let Some(err) = parsed.error.filter(|s| !s.is_empty()) {
        return Ok(ProvisionParseResult::Failed(err));
    }

    if let Some(pg) = parsed.postgresql.as_ref() {
        return Ok(ProvisionParseResult::Ready(build_outcome_from_parts(
            slug,
            parsed.provision_id,
            pg,
            parsed.redis,
            parsed.env_vars,
        )?));
    }

    let provision_id = parsed
        .provision_id
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("prov_{}", slug));

    if http_pending || status.as_deref() == Some("pending") {
        return Ok(ProvisionParseResult::Pending {
            provision_id,
            poll_after_secs: parsed.poll_after_secs.unwrap_or(5).max(1),
            message: parsed.message,
        });
    }

    Err(AppError::Internal(
        "Provisioner 响应缺少 postgresql 且非 pending 状态".to_string(),
    ))
}

fn build_outcome_from_parts(
    slug: &str,
    provision_id: Option<String>,
    pg: &WebhookPostgresql,
    redis: Option<WebhookRedis>,
    env_vars: HashMap<String, String>,
) -> Result<WebhookProvisionOutcome> {
    if pg.host.trim().is_empty() {
        return Err(AppError::Internal(
            "Provisioner 响应缺少 postgresql.host".to_string(),
        ));
    }
    if pg.database.trim().is_empty() {
        return Err(AppError::Internal(
            "Provisioner 响应缺少 postgresql.database".to_string(),
        ));
    }
    if pg.user.is_empty() || pg.password.is_empty() {
        return Err(AppError::Internal(
            "Provisioner 响应 postgresql.user/password 不能为空".to_string(),
        ));
    }

    let provision_id = provision_id
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("prov_{}", slug));

    let mut env_vars = env_vars;
    if let Some(redis) = redis {
        let url = redis.url.trim();
        if !url.is_empty() && !env_vars.contains_key("REDIS_URL") {
            env_vars.insert("REDIS_URL".to_string(), url.to_string());
        }
    }

    Ok(WebhookProvisionOutcome {
        provision_id,
        db_host: pg.host.trim().to_string(),
        db_port: pg.port,
        db_name: pg.database.trim().to_string(),
        db_user: pg.user.trim().to_string(),
        db_password: pg.password.clone(),
        env_vars,
    })
}

/// 删项目 / 删租户后回调 deprovision；失败只记日志，不阻塞删除。
pub async fn deprovision_after_tenant_delete(
    slug: &str,
    workspace_config: &serde_json::Value,
    tenant_id: i32,
) {
    let via = workspace_config
        .get("provisioned_via_webhook")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !via {
        return;
    }

    let provision_id = workspace_config
        .get("provision_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(slug);

    tracing::info!(
        target = "provisioning",
        event = "tenant_delete_deprovision",
        slug = slug,
        tenant_id = tenant_id,
        provision_id = provision_id,
        "删项目后回调 deprovision Webhook"
    );
    try_deprovision_webhook(slug, provision_id, Some(tenant_id)).await;
}

/// 管理库写入失败等场景下的补偿；失败只记日志。
pub async fn try_deprovision_webhook(slug: &str, provision_id: &str, project_id: Option<i32>) {
    let Some(cfg) = load_config() else { return };
    let Some(url) = cfg.deprovision_url.as_ref() else {
        tracing::warn!(
            target = "provisioning",
            slug = slug,
            provision_id = provision_id,
            "未配置 PROVISION_WEBHOOK_DEPROVISION_URL，跳过 deprovision 补偿"
        );
        return;
    };

    let body = serde_json::json!({
        "action": "deprovision",
        "slug": slug,
        "provision_id": provision_id,
        "project_id": project_id,
    });

    let client = match reqwest::Client::builder().timeout(cfg.timeout).build() {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("deprovision HTTP 客户端失败: {}", e);
            return;
        }
    };

    let mut req = client.post(url).json(&body);
    if let Some(token) = &cfg.token {
        req = req.header(AUTHORIZATION, format!("Bearer {}", token));
    }

    match req.send().await {
        Ok(r) if r.status().is_success() => {
            tracing::info!(
                target = "provisioning",
                slug = slug,
                provision_id = provision_id,
                "deprovision Webhook 成功"
            );
        }
        Ok(r) => {
            let status = r.status();
            let text = r.text().await.unwrap_or_default();
            tracing::error!(
                target = "provisioning",
                slug = slug,
                provision_id = provision_id,
                "deprovision Webhook 失败 HTTP {}: {}",
                status,
                truncate_for_log(&text, 300)
            );
        }
        Err(e) => {
            tracing::error!(
                target = "provisioning",
                slug = slug,
                provision_id = provision_id,
                "deprovision Webhook 请求失败: {}",
                e
            );
        }
    }
}

fn parse_webhook_error(body: &str) -> Option<String> {
    if body.trim().is_empty() {
        return None;
    }
    if let Ok(v) = serde_json::from_str::<WebhookErrorBody>(body) {
        if let Some(e) = v.error.filter(|s| !s.is_empty()) {
            return Some(e);
        }
        if let Some(m) = v.message.filter(|s| !s.is_empty()) {
            return Some(m);
        }
    }
    Some(truncate_for_log(body, 500))
}

fn truncate_for_log(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_resources_defaults_postgresql() {
        assert_eq!(
            normalize_requested_resources(None).unwrap(),
            vec!["postgresql".to_string()]
        );
    }

    #[test]
    fn normalize_resources_rejects_unknown() {
        assert!(normalize_requested_resources(Some(vec!["kafka".to_string()])).is_err());
    }

    #[test]
    fn normalize_resources_postgresql_and_redis() {
        assert_eq!(
            normalize_requested_resources(Some(vec![
                "redis".to_string(),
                "postgresql".to_string()
            ]))
            .unwrap(),
            vec!["postgresql".to_string(), "redis".to_string()]
        );
    }

    #[test]
    fn parse_error_body() {
        assert_eq!(
            parse_webhook_error(r#"{"error":"quota exceeded"}"#),
            Some("quota exceeded".to_string())
        );
    }

    #[test]
    fn parse_sync_success_response() {
        let body = r#"{
            "provision_id": "prov_x",
            "postgresql": {
                "host": "h",
                "database": "d",
                "user": "u",
                "password": "p"
            }
        }"#;
        match parse_provision_response("x", body, false).unwrap() {
            ProvisionParseResult::Ready(o) => {
                assert_eq!(o.provision_id, "prov_x");
                assert_eq!(o.db_host, "h");
            }
            _ => panic!("expected ready"),
        }
    }

    #[test]
    fn parse_pending_202_response() {
        let body = r#"{
            "status": "pending",
            "provision_id": "prov_job1",
            "message": "terraform apply",
            "poll_after_secs": 3
        }"#;
        match parse_provision_response("job1", body, true).unwrap() {
            ProvisionParseResult::Pending {
                provision_id,
                poll_after_secs,
                ..
            } => {
                assert_eq!(provision_id, "prov_job1");
                assert_eq!(poll_after_secs, 3);
            }
            _ => panic!("expected pending"),
        }
    }

    #[test]
    fn parse_failed_status() {
        let body = r#"{"status":"failed","error":"quota exceeded"}"#;
        match parse_provision_response("x", body, false).unwrap() {
            ProvisionParseResult::Failed(msg) => assert_eq!(msg, "quota exceeded"),
            _ => panic!("expected failed"),
        }
    }
}
