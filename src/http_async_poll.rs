//! Shared HTTP async poll protocol helpers (202 + poll).
//!
//! Pure classification / config parsing — no HTTP client wiring.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::time::{Duration, Instant};

pub const DEFAULT_POLL_INTERVAL_SECS: u64 = 5;
pub const DEFAULT_POLL_MAX_SECS: u64 = 600;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AsyncPollConfig {
    pub enabled: bool,
    pub poll_interval_secs: u64,
    pub poll_max_secs: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdSource {
    JobId,
    Id,
    ProvisionId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClassifyResult {
    Ready,
    Pending {
        job_id: Option<String>,
        id_source: Option<IdSource>,
        poll_url: Option<String>,
        poll_after_secs: Option<u64>,
    },
    Failed {
        message: String,
    },
}

#[derive(Debug, Clone)]
pub struct HttpExchange {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Value,
    pub body_text: String,
}

#[derive(Debug, Clone)]
pub struct PollRequest {
    pub method: String,
    pub url: String,
    pub json_body: Option<Value>,
    pub headers: HashMap<String, String>,
}

pub(crate) fn is_private_url(url: &str) -> bool {
    let host = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .and_then(|s| s.split('/').next())
        .and_then(|s| s.split(':').next())
        .unwrap_or("");

    if host == "localhost" || host == "127.0.0.1" || host == "::1" {
        return true;
    }

    if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        return ip.is_private() || ip.is_loopback() || ip.is_link_local();
    }

    // 10.x.x.x, 172.16-31.x.x, 192.168.x.x 已在 is_private() 覆盖
    host.ends_with(".local") || host.ends_with(".internal")
}

fn assert_public_http_url(url: &str) -> Result<(), String> {
    if is_private_url(url) {
        return Err(format!(
            "http_call 异步轮询不允许访问内网地址: {url}"
        ));
    }
    Ok(())
}

pub async fn run_async_poll_loop<F, Fut>(
    cfg: &AsyncPollConfig,
    initial_url: &str,
    initial: HttpExchange,
    auth_headers: &HashMap<String, String>,
    mut do_request: F,
) -> Result<(HttpExchange, Value), String>
where
    F: FnMut(PollRequest) -> Fut,
    Fut: Future<Output = Result<HttpExchange, String>>,
{
    let started = Instant::now();
    let mut attempts = 0_u64;
    let mut current = initial;
    let mut job_id = None;

    loop {
        match classify_http_response(current.status, &current.body, &current.headers) {
            ClassifyResult::Ready => {
                return Ok((
                    current,
                    json!({
                        "enabled": true,
                        "job_id": job_id,
                        "attempts": attempts,
                        "elapsed_secs": started.elapsed().as_secs(),
                    }),
                ));
            }
            ClassifyResult::Failed { message } => return Err(message),
            ClassifyResult::Pending {
                job_id: response_job_id,
                id_source,
                poll_url,
                poll_after_secs,
            } => {
                if response_job_id.is_none() && poll_url.is_none() {
                    return Err(
                        "HTTP 异步轮询缺少 job_id/id/provision_id 与 poll_url/Location".to_string(),
                    );
                }
                if started.elapsed() >= Duration::from_secs(cfg.poll_max_secs) {
                    return Err(format!(
                        "HTTP 异步轮询超时（已等待 {} 秒）",
                        cfg.poll_max_secs
                    ));
                }

                if response_job_id.is_some() {
                    job_id = response_job_id.clone();
                }
                if let Some(poll_url) = poll_url.as_deref() {
                    assert_public_http_url(poll_url)?;
                }
                tokio::time::sleep(Duration::from_secs(next_sleep_secs(
                    poll_after_secs,
                    cfg.poll_interval_secs,
                )))
                .await;

                if started.elapsed() >= Duration::from_secs(cfg.poll_max_secs) {
                    return Err(format!(
                        "HTTP 异步轮询超时（已等待 {} 秒）",
                        cfg.poll_max_secs
                    ));
                }

                let mut headers = auth_headers.clone();
                let (method, url, json_body) = if let Some(poll_url) = poll_url {
                    ("GET".to_string(), poll_url, None)
                } else {
                    let id = response_job_id.expect("checked above");
                    let id_source = id_source.expect("job id always has a source");
                    (
                        "POST".to_string(),
                        initial_url.to_string(),
                        Some(build_poll_post_body(&id, id_source)),
                    )
                };
                attempts += 1;
                current = do_request(PollRequest {
                    method,
                    url,
                    json_body,
                    headers: std::mem::take(&mut headers),
                })
                .await?;
            }
        }
    }
}

pub fn run_blocking_poll_loop<F>(
    cfg: &AsyncPollConfig,
    initial_url: &str,
    initial: HttpExchange,
    auth_headers: &HashMap<String, String>,
    mut do_request: F,
) -> Result<(HttpExchange, Value), String>
where
    F: FnMut(PollRequest) -> Result<HttpExchange, String>,
{
    let started = Instant::now();
    let mut attempts = 0_u64;
    let mut current = initial;
    let mut job_id = None;

    loop {
        match classify_http_response(current.status, &current.body, &current.headers) {
            ClassifyResult::Ready => {
                return Ok((
                    current,
                    json!({
                        "enabled": true,
                        "job_id": job_id,
                        "attempts": attempts,
                        "elapsed_secs": started.elapsed().as_secs(),
                    }),
                ));
            }
            ClassifyResult::Failed { message } => return Err(message),
            ClassifyResult::Pending {
                job_id: response_job_id,
                id_source,
                poll_url,
                poll_after_secs,
            } => {
                if response_job_id.is_none() && poll_url.is_none() {
                    return Err(
                        "HTTP 异步轮询缺少 job_id/id/provision_id 与 poll_url/Location".to_string(),
                    );
                }
                if started.elapsed() >= Duration::from_secs(cfg.poll_max_secs) {
                    return Err(format!(
                        "HTTP 异步轮询超时（已等待 {} 秒）",
                        cfg.poll_max_secs
                    ));
                }

                if response_job_id.is_some() {
                    job_id = response_job_id.clone();
                }
                if let Some(poll_url) = poll_url.as_deref() {
                    assert_public_http_url(poll_url)?;
                }
                std::thread::sleep(Duration::from_secs(next_sleep_secs(
                    poll_after_secs,
                    cfg.poll_interval_secs,
                )));

                if started.elapsed() >= Duration::from_secs(cfg.poll_max_secs) {
                    return Err(format!(
                        "HTTP 异步轮询超时（已等待 {} 秒）",
                        cfg.poll_max_secs
                    ));
                }

                let mut headers = auth_headers.clone();
                let (method, url, json_body) = if let Some(poll_url) = poll_url {
                    ("GET".to_string(), poll_url, None)
                } else {
                    let id = response_job_id.expect("checked above");
                    let id_source = id_source.expect("job id always has a source");
                    (
                        "POST".to_string(),
                        initial_url.to_string(),
                        Some(build_poll_post_body(&id, id_source)),
                    )
                };
                attempts += 1;
                current = do_request(PollRequest {
                    method,
                    url,
                    json_body,
                    headers: std::mem::take(&mut headers),
                })?;
            }
        }
    }
}

pub fn parse_async_poll_config(config: &Value) -> AsyncPollConfig {
    let enabled = config
        .get("async_poll")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut poll_interval_secs =
        parse_json_u64(config.get("poll_interval_secs")).unwrap_or(DEFAULT_POLL_INTERVAL_SECS);
    let mut poll_max_secs =
        parse_json_u64(config.get("poll_max_secs")).unwrap_or(DEFAULT_POLL_MAX_SECS);

    if enabled {
        poll_interval_secs = poll_interval_secs.max(1);
        poll_max_secs = poll_max_secs.max(1);
    }

    AsyncPollConfig {
        enabled,
        poll_interval_secs,
        poll_max_secs,
    }
}

pub fn classify_http_response(
    status: u16,
    body: &Value,
    headers: &HashMap<String, String>,
) -> ClassifyResult {
    if let Some(message) = non_empty_string_field(body, "error") {
        return ClassifyResult::Failed { message };
    }

    if let Some(status_lower) = body_status_lower(body) {
        if status_lower == "failed" || status_lower == "error" {
            let message = non_empty_string_field(body, "error")
                .or_else(|| non_empty_string_field(body, "message"))
                .unwrap_or_else(|| "远程任务失败".to_string());
            return ClassifyResult::Failed { message };
        }
    }

    if (400..600).contains(&status) {
        let message = non_empty_string_field(body, "message")
            .or_else(|| non_empty_string_field(body, "error"))
            .unwrap_or_else(|| format!("HTTP {status}"));
        return ClassifyResult::Failed { message };
    }

    let body_pending = body_status_lower(body).as_deref() == Some("pending");
    if status == 202 || body_pending {
        let (job_id, id_source) = extract_job_id(body);
        let poll_url = resolve_poll_url(body, headers);
        let poll_after_secs = extract_poll_after_secs(body);
        return ClassifyResult::Pending {
            job_id,
            id_source,
            poll_url,
            poll_after_secs,
        };
    }

    if (200..300).contains(&status) {
        return ClassifyResult::Ready;
    }

    ClassifyResult::Failed {
        message: format!("HTTP {status}"),
    }
}

pub fn build_poll_post_body(job_id: &str, id_source: IdSource) -> Value {
    let mut body = json!({
        "action": "poll",
        "job_id": job_id,
    });
    if id_source == IdSource::ProvisionId {
        body["provision_id"] = json!(job_id);
    }
    body
}

pub fn next_sleep_secs(poll_after_secs: Option<u64>, poll_interval_secs: u64) -> u64 {
    let interval = poll_interval_secs.max(1);
    let after = poll_after_secs.unwrap_or(interval);
    after.max(1).min(interval)
}

pub fn resolve_poll_url(body: &Value, headers: &HashMap<String, String>) -> Option<String> {
    non_empty_string_field(body, "poll_url").or_else(|| header_lookup_ci(headers, "location"))
}

fn parse_json_u64(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    match value {
        Value::Number(n) => n
            .as_u64()
            .or_else(|| n.as_i64().and_then(|i| u64::try_from(i).ok())),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn non_empty_string_field(body: &Value, key: &str) -> Option<String> {
    body.as_object()
        .and_then(|obj| obj.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn body_status_lower(body: &Value) -> Option<String> {
    body.as_object()
        .and_then(|obj| obj.get("status"))
        .and_then(|v| v.as_str().map(str::to_ascii_lowercase))
}

fn extract_job_id(body: &Value) -> (Option<String>, Option<IdSource>) {
    if let Some(id) = non_empty_string_field(body, "job_id") {
        return (Some(id), Some(IdSource::JobId));
    }
    if let Some(id) = non_empty_string_field(body, "id") {
        return (Some(id), Some(IdSource::Id));
    }
    if let Some(id) = non_empty_string_field(body, "provision_id") {
        return (Some(id), Some(IdSource::ProvisionId));
    }
    (None, None)
}

fn extract_poll_after_secs(body: &Value) -> Option<u64> {
    body.as_object()
        .and_then(|obj| obj.get("poll_after_secs"))
        .and_then(|v| parse_json_u64(Some(v)))
}

fn header_lookup_ci(headers: &HashMap<String, String>, name: &str) -> Option<String> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.trim())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn classify_202_is_pending() {
        let headers = HashMap::new();
        let body = json!({"job_id": "j1", "status": "pending"});
        match classify_http_response(202, &body, &headers) {
            ClassifyResult::Pending { job_id, .. } => assert_eq!(job_id.as_deref(), Some("j1")),
            other => panic!("expected Pending, got {:?}", other),
        }
    }

    #[test]
    fn classify_200_pending_status_is_pending() {
        let headers = HashMap::new();
        let body = json!({"status": "Pending", "id": "x"});
        assert!(matches!(
            classify_http_response(200, &body, &headers),
            ClassifyResult::Pending { .. }
        ));
    }

    #[test]
    fn classify_200_completed_is_ready() {
        let headers = HashMap::new();
        let body = json!({"status": "completed", "result": 1});
        assert!(matches!(
            classify_http_response(200, &body, &headers),
            ClassifyResult::Ready
        ));
    }

    #[test]
    fn classify_failed_status_and_error_field() {
        let headers = HashMap::new();
        let body = json!({"status": "failed", "error": "boom"});
        match classify_http_response(200, &body, &headers) {
            ClassifyResult::Failed { message } => assert!(message.contains("boom")),
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn classify_4xx_is_failed() {
        let headers = HashMap::new();
        let body = json!({"message": "nope"});
        assert!(matches!(
            classify_http_response(400, &body, &headers),
            ClassifyResult::Failed { .. }
        ));
    }

    #[test]
    fn job_id_priority_job_id_then_id_then_provision_id() {
        let headers = HashMap::new();
        let body = json!({"job_id": "a", "id": "b", "provision_id": "c", "status": "pending"});
        match classify_http_response(202, &body, &headers) {
            ClassifyResult::Pending {
                job_id, id_source, ..
            } => {
                assert_eq!(job_id.as_deref(), Some("a"));
                assert!(matches!(id_source, Some(IdSource::JobId)));
            }
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn location_header_and_poll_url_body() {
        let mut headers = HashMap::new();
        headers.insert("location".into(), "https://example.com/jobs/1".into());
        let body = json!({"status": "pending"});
        match classify_http_response(202, &body, &headers) {
            ClassifyResult::Pending { poll_url, .. } => {
                assert_eq!(poll_url.as_deref(), Some("https://example.com/jobs/1"));
            }
            other => panic!("{:?}", other),
        }
        let body2 = json!({"status": "pending", "poll_url": "https://example.com/p"});
        match classify_http_response(202, &body2, &HashMap::new()) {
            ClassifyResult::Pending { poll_url, .. } => {
                assert_eq!(poll_url.as_deref(), Some("https://example.com/p"));
            }
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn build_poll_body_includes_provision_id_when_sourced() {
        let v = build_poll_post_body("p1", IdSource::ProvisionId);
        assert_eq!(v["action"], "poll");
        assert_eq!(v["job_id"], "p1");
        assert_eq!(v["provision_id"], "p1");
    }

    #[test]
    fn next_sleep_clamps_like_provisioner() {
        assert_eq!(next_sleep_secs(Some(2), 5), 2);
        assert_eq!(next_sleep_secs(Some(9), 5), 5);
        assert_eq!(next_sleep_secs(None, 5), 5);
        assert_eq!(next_sleep_secs(Some(0), 5), 1);
    }

    #[test]
    fn parse_config_defaults_and_enabled() {
        let off = parse_async_poll_config(&json!({}));
        assert!(!off.enabled);
        let on = parse_async_poll_config(&json!({
            "async_poll": true,
            "poll_interval_secs": 3,
            "poll_max_secs": 90
        }));
        assert!(on.enabled);
        assert_eq!(on.poll_interval_secs, 3);
        assert_eq!(on.poll_max_secs, 90);
    }

    async fn response_to_exchange(response: reqwest::Response) -> HttpExchange {
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(key, value)| Some((key.to_string(), value.to_str().ok()?.to_string())))
            .collect();
        let body_text = response.text().await.unwrap();
        let body = serde_json::from_str(&body_text).unwrap_or(json!(body_text));
        HttpExchange {
            status,
            headers,
            body,
            body_text,
        }
    }

    async fn send_poll_request(
        client: reqwest::Client,
        request: PollRequest,
    ) -> Result<HttpExchange, String> {
        let mut builder = match request.method.as_str() {
            "GET" => client.get(&request.url),
            _ => client.post(&request.url),
        };
        for (key, value) in request.headers {
            builder = builder.header(key, value);
        }
        if let Some(body) = request.json_body {
            builder = builder.json(&body);
        }
        let response = builder.send().await.map_err(|error| error.to_string())?;
        Ok(response_to_exchange(response).await)
    }

    #[tokio::test]
    async fn async_poll_loop_pending_then_ready() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut first, _) = listener.accept().await.unwrap();
            let mut first_request = [0_u8; 1024];
            first.read(&mut first_request).await.unwrap();
            first
                .write_all(
                    b"HTTP/1.1 202 Accepted\r\nContent-Type: application/json\r\nContent-Length: 54\r\nConnection: close\r\n\r\n{\"status\":\"pending\",\"job_id\":\"j1\",\"poll_after_secs\":1}",
                )
                .await
                .unwrap();

            let (mut second, _) = listener.accept().await.unwrap();
            let mut second_request = [0_u8; 1024];
            let read = second.read(&mut second_request).await.unwrap();
            let second_request = String::from_utf8_lossy(&second_request[..read]);
            assert!(second_request.starts_with("POST "));
            assert!(second_request.contains("\"action\":\"poll\""));
            second
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 34\r\nConnection: close\r\n\r\n{\"status\":\"completed\",\"result\":42}",
                )
                .await
                .unwrap();
        });

        let client = reqwest::Client::new();
        let initial = response_to_exchange(client.get(&url).send().await.unwrap()).await;
        let cfg = AsyncPollConfig {
            enabled: true,
            poll_interval_secs: 1,
            poll_max_secs: 5,
        };
        let (final_exchange, meta) =
            run_async_poll_loop(&cfg, &url, initial, &HashMap::new(), |request| {
                let client = client.clone();
                async move { send_poll_request(client, request).await }
            })
            .await
            .unwrap();

        assert_eq!(final_exchange.status, 200);
        assert_eq!(final_exchange.body["result"], 42);
        assert_eq!(meta["enabled"], true);
        assert_eq!(meta["job_id"], "j1");
        assert_eq!(meta["attempts"], 1);
    }

    #[tokio::test]
    async fn async_poll_loop_missing_id_errors() {
        let cfg = AsyncPollConfig {
            enabled: true,
            poll_interval_secs: 1,
            poll_max_secs: 1,
        };
        let initial = HttpExchange {
            status: 202,
            headers: HashMap::new(),
            body: json!({"status": "pending"}),
            body_text: "{\"status\":\"pending\"}".to_string(),
        };

        let error = run_async_poll_loop(
            &cfg,
            "http://example.test",
            initial,
            &HashMap::new(),
            |_| async { unreachable!("request must not be attempted without an id or poll URL") },
        )
        .await
        .unwrap_err();

        assert_eq!(
            error,
            "HTTP 异步轮询缺少 job_id/id/provision_id 与 poll_url/Location"
        );
    }

    #[tokio::test]
    async fn async_poll_loop_follows_location_with_get() {
        let cfg = AsyncPollConfig {
            enabled: true,
            poll_interval_secs: 1,
            poll_max_secs: 5,
        };
        let mut headers = HashMap::new();
        headers.insert(
            "Location".to_string(),
            "https://example.test/jobs/j1".to_string(),
        );
        let initial = HttpExchange {
            status: 202,
            headers,
            body: json!({"status": "pending", "poll_after_secs": 1}),
            body_text: "{\"status\":\"pending\",\"poll_after_secs\":1}".to_string(),
        };

        let (final_exchange, meta) = run_async_poll_loop(
            &cfg,
            "https://example.test/jobs",
            initial,
            &HashMap::new(),
            |request| async move {
                assert_eq!(request.method, "GET");
                assert_eq!(request.url, "https://example.test/jobs/j1");
                assert_eq!(request.json_body, None);
                Ok(HttpExchange {
                    status: 200,
                    headers: HashMap::new(),
                    body: json!({"status": "completed", "result": 42}),
                    body_text: "{\"status\":\"completed\",\"result\":42}".to_string(),
                })
            },
        )
        .await
        .unwrap();

        assert_eq!(final_exchange.body["result"], 42);
        assert_eq!(meta["attempts"], 1);
    }

    #[tokio::test]
    async fn async_poll_loop_rejects_private_location_before_request() {
        let cfg = AsyncPollConfig {
            enabled: true,
            poll_interval_secs: 1,
            poll_max_secs: 5,
        };
        let mut headers = HashMap::new();
        headers.insert(
            "Location".to_string(),
            "http://127.0.0.1/internal".to_string(),
        );
        let initial = HttpExchange {
            status: 202,
            headers,
            body: json!({"status": "pending"}),
            body_text: "{\"status\":\"pending\"}".to_string(),
        };

        let error = run_async_poll_loop(
            &cfg,
            "https://example.test/jobs",
            initial,
            &HashMap::new(),
            |_| async { Err("private URL must not be requested".to_string()) },
        )
        .await
        .unwrap_err();

        assert_eq!(
            error,
            "http_call 异步轮询不允许访问内网地址: http://127.0.0.1/internal"
        );
    }

    #[test]
    fn blocking_poll_loop_pending_then_ready() {
        let cfg = AsyncPollConfig {
            enabled: true,
            poll_interval_secs: 1,
            poll_max_secs: 5,
        };
        let initial = HttpExchange {
            status: 202,
            headers: HashMap::new(),
            body: json!({"status": "pending", "job_id": "j1", "poll_after_secs": 1}),
            body_text: "{\"status\":\"pending\",\"job_id\":\"j1\",\"poll_after_secs\":1}"
                .to_string(),
        };
        let mut requests = Vec::new();
        let (final_exchange, meta) = run_blocking_poll_loop(
            &cfg,
            "http://example.test/jobs",
            initial,
            &HashMap::new(),
            |request| {
                requests.push(request);
                Ok(HttpExchange {
                    status: 200,
                    headers: HashMap::new(),
                    body: json!({"status": "completed", "result": 42}),
                    body_text: "{\"status\":\"completed\",\"result\":42}".to_string(),
                })
            },
        )
        .unwrap();

        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].method, "POST");
        assert_eq!(
            requests[0].json_body,
            Some(json!({"action": "poll", "job_id": "j1"}))
        );
        assert_eq!(final_exchange.body["result"], 42);
        assert_eq!(meta["attempts"], 1);
    }

    #[tokio::test]
    async fn async_poll_loop_respects_poll_max() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            stream.read(&mut request).await.unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 202 Accepted\r\nContent-Type: application/json\r\nContent-Length: 33\r\nConnection: close\r\n\r\n{\"status\":\"pending\",\"job_id\":\"j1\"}",
                )
                .await
                .unwrap();
        });

        let cfg = AsyncPollConfig {
            enabled: true,
            poll_interval_secs: 1,
            poll_max_secs: 1,
        };
        let initial = HttpExchange {
            status: 202,
            headers: HashMap::new(),
            body: json!({"status": "pending", "job_id": "j1", "poll_after_secs": 1}),
            body_text: "{\"status\":\"pending\",\"job_id\":\"j1\",\"poll_after_secs\":1}"
                .to_string(),
        };
        let client = reqwest::Client::new();
        let error = run_async_poll_loop(&cfg, &url, initial, &HashMap::new(), |request| {
            let client = client.clone();
            async move { send_poll_request(client, request).await }
        })
        .await
        .unwrap_err();

        assert_eq!(error, "HTTP 异步轮询超时（已等待 1 秒）");
    }
}
