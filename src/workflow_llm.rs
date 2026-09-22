//! 工作流 llm 节点：OpenAI 兼容 Chat Completions 组包 / 解析 / HTTP。
//! 连接存取见 `llm_ds`；引擎只负责取连接、注入凭证、接 StreamBridge。

use reqwest::Url;
use serde_json::{json, Value};
use std::net::{IpAddr, SocketAddr};

use crate::error::{AppError, Result};
use crate::workflow_stream::StreamBridge;

pub struct LlmCallRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Value,
    pub timeout_secs: u64,
    pub json_mode: bool,
    pub stream: bool,
    pub requested_model: String,
}

pub fn normalize_base_url(raw: &str) -> std::result::Result<String, String> {
    let s = raw.trim().trim_end_matches('/').to_string();
    if s.is_empty() {
        return Err("base_url 不能为空".into());
    }
    if !(s.starts_with("http://") || s.starts_with("https://")) {
        return Err("base_url 必须以 http:// 或 https:// 开头".into());
    }
    Ok(s)
}

pub fn chat_completions_url(base_url: &str) -> String {
    format!("{}/chat/completions", base_url.trim_end_matches('/'))
}

pub fn models_url(base_url: &str) -> String {
    format!("{}/models", base_url.trim_end_matches('/'))
}

fn is_non_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_unspecified()
                || ip.octets()[0] == 0
                || ip.octets()[0] >= 224
        }
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip.is_multicast()
        }
    }
}

fn local_url_allowed(url: &Url) -> bool {
    if !matches!(
        std::env::var("RUST_ENV").unwrap_or_default().as_str(),
        "development" | "test"
    ) {
        return false;
    }
    match url
        .host_str()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "localhost" => true,
        // host_str() 对 IPv6 字面量保留方括号（如 `[::1]`），需剥离后才能解析成 IpAddr
        host => host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false),
    }
}

/// 请求时重新解析并固定目标地址，避免项目配置的 LLM URL 通过 DNS 重绑定访问内网。
pub async fn client_for_url(raw: &str) -> Result<reqwest::Client> {
    let url = Url::parse(raw).map_err(|_| {
        AppError::validation(
            "wfllm_base_url_invalid",
            "LLM base_url 不是有效 URL".to_string(),
            serde_json::json!({}),
        )
    })?;
    if url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::validation(
            "wfllm_base_url_forbidden_parts",
            "LLM base_url 不允许包含凭据、query 或 fragment".to_string(),
            serde_json::json!({}),
        ));
    }
    let local_allowed = local_url_allowed(&url);
    if url.scheme() != "https" && !(url.scheme() == "http" && local_allowed) {
        return Err(AppError::validation(
            "wfllm_base_url_requires_https",
            "LLM base_url 必须使用 HTTPS；开发/测试环境仅允许 HTTP localhost".to_string(),
            serde_json::json!({}),
        ));
    }
    let host = url.host_str().ok_or_else(|| {
        AppError::validation(
            "wfllm_base_url_missing_host",
            "LLM base_url 缺少主机名".to_string(),
            serde_json::json!({}),
        )
    })?;
    let port = url.port_or_known_default().ok_or_else(|| {
        AppError::validation(
            "wfllm_base_url_invalid_port",
            "LLM base_url 端口无效".to_string(),
            serde_json::json!({}),
        )
    })?;
    // IPv6 字面量的 host_str() 带方括号，lookup_host 不接受，解析前先剥离
    let lookup_name = host.trim_start_matches('[').trim_end_matches(']');
    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((lookup_name, port))
        .await
        .map_err(|_| {
            AppError::validation(
                "wfllm_base_url_host_unresolvable",
                "LLM base_url 主机无法解析".to_string(),
                serde_json::json!({}),
            )
        })?
        .collect();
    if addresses.is_empty()
        || (!local_allowed && addresses.iter().any(|addr| is_non_public_ip(addr.ip())))
    {
        return Err(AppError::validation(
            "wfllm_base_url_forbidden_address",
            "LLM base_url 不允许指向本机、内网、链路本地或保留地址".to_string(),
            serde_json::json!({}),
        ));
    }
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(|e| AppError::Internal(format!("HTTP 客户端创建失败: {e}")))
}

pub fn normalize_models(models: &[String]) -> Vec<String> {
    models
        .iter()
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .collect()
}

pub fn model_allowed(models: &[String], model: &str) -> bool {
    models.iter().any(|m| m == model)
}

pub fn is_statically_empty_prompts(system: &Value, user: &Value, messages: &Value) -> bool {
    let sys = system.as_str().unwrap_or("");
    let usr = user.as_str().unwrap_or("");
    if sys.contains("{{") || usr.contains("{{") {
        return false;
    }
    if messages.as_str().is_some_and(|s| s.contains("{{")) {
        return false;
    }
    let msgs_empty = match messages {
        Value::Null => true,
        Value::String(s) => s.trim().is_empty() || s.trim() == "[]",
        Value::Array(a) => a.is_empty(),
        _ => false,
    };
    sys.trim().is_empty() && usr.trim().is_empty() && msgs_empty
}

pub fn assemble_messages(
    system_prompt: Option<&str>,
    messages: &Value,
    user_prompt: Option<&str>,
) -> std::result::Result<Vec<Value>, String> {
    let mut out = Vec::new();
    if let Some(s) = system_prompt.map(str::trim).filter(|s| !s.is_empty()) {
        out.push(json!({"role":"system","content":s}));
    }
    let arr = match messages {
        Value::Null => vec![],
        Value::String(s) if s.trim().is_empty() => vec![],
        Value::String(s) => serde_json::from_str::<Value>(s)
            .map_err(|e| format!("messages 不是合法 JSON: {e}"))?
            .as_array()
            .cloned()
            .ok_or_else(|| "messages 必须是数组".to_string())?,
        Value::Array(a) => a.clone(),
        _ => return Err("messages 必须是数组或 JSON 数组字符串".into()),
    };
    for item in arr {
        let role = item.get("role").and_then(|v| v.as_str()).unwrap_or("");
        if !matches!(role, "system" | "user" | "assistant") {
            return Err(format!(
                "messages.role 只允许 system/user/assistant，收到 {role}"
            ));
        }
        let content = item
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "messages.content 必须是字符串".to_string())?;
        out.push(json!({"role": role, "content": content}));
    }
    if let Some(s) = user_prompt.map(str::trim).filter(|s| !s.is_empty()) {
        out.push(json!({"role":"user","content":s}));
    }
    if out.is_empty() {
        return Err("llm 节点组完 messages 为空".into());
    }
    Ok(out)
}

pub fn parse_temperature(config: &Value) -> std::result::Result<f64, String> {
    let Some(v) = config.get("temperature") else {
        return Ok(0.7);
    };
    let n = v
        .as_f64()
        .or_else(|| v.as_i64().map(|i| i as f64))
        .ok_or_else(|| "temperature 必须是数字".to_string())?;
    if !(0.0..=2.0).contains(&n) {
        return Err("temperature 必须在 0–2".into());
    }
    Ok(n)
}

pub fn parse_max_tokens(config: &Value) -> std::result::Result<Option<u32>, String> {
    let Some(v) = config.get("max_tokens") else {
        return Ok(None);
    };
    if v.is_null() {
        return Ok(None);
    }
    let n = v
        .as_u64()
        .or_else(|| v.as_i64().filter(|i| *i > 0).map(|i| i as u64))
        .ok_or_else(|| "max_tokens 必须是正整数".to_string())?;
    Ok(Some(n as u32))
}

pub fn build_chat_body(
    model: &str,
    messages: &[Value],
    temperature: f64,
    max_tokens: Option<u32>,
    json_mode: bool,
    stream: bool,
) -> Value {
    let mut body = json!({
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "stream": stream
    });
    if let Some(n) = max_tokens {
        body["max_tokens"] = json!(n);
    }
    if json_mode {
        body["response_format"] = json!({"type":"json_object"});
    }
    body
}

pub fn parse_json_mode_text(text: &str) -> std::result::Result<Value, String> {
    serde_json::from_str(text.trim()).map_err(|_| "json_mode 下模型输出不是合法 JSON".into())
}

pub fn skip_llm_mock(model: &str, json_mode: bool) -> Value {
    let mut o = json!({
        "text": "[skip_llm] mocked completion",
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        "model": model,
        "finish_reason": "stop",
        "streamed": false
    });
    if json_mode {
        o["json"] = json!({});
    }
    o
}

pub fn truncate_error_body(s: &str) -> String {
    let mut t = s.to_string();
    t.truncate(2048);
    t
}

pub fn llm_output(
    text: String,
    json_mode: bool,
    usage: Value,
    model: String,
    finish_reason: Value,
    streamed: bool,
) -> std::result::Result<Value, String> {
    let mut o = json!({
        "text": text,
        "usage": usage,
        "model": model,
        "finish_reason": finish_reason,
        "streamed": streamed
    });
    if json_mode {
        o["json"] = parse_json_mode_text(o["text"].as_str().unwrap_or(""))?;
    }
    Ok(o)
}

pub fn parse_non_stream_response(
    body: &Value,
    requested_model: &str,
    json_mode: bool,
) -> std::result::Result<Value, String> {
    let choices = body
        .get("choices")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "供应商响应缺少 choices".to_string())?;
    let first = choices
        .first()
        .ok_or_else(|| "供应商响应 choices 为空".to_string())?;
    let text = first
        .pointer("/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let finish = first.get("finish_reason").cloned().unwrap_or(Value::Null);
    let usage = body.get("usage").cloned().unwrap_or(json!({
        "prompt_tokens": null, "completion_tokens": null, "total_tokens": null
    }));
    let model = body
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or(requested_model);
    llm_output(text, json_mode, usage, model.to_string(), finish, false)
}

fn apply_headers(
    mut req: reqwest::RequestBuilder,
    headers: &[(String, String)],
) -> reqwest::RequestBuilder {
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }
    req
}

async fn execute_chat_request_inner(
    req: LlmCallRequest,
    sink: Option<StreamBridge>,
) -> Result<Value> {
    let client = client_for_url(&req.url).await?;

    if req.stream {
        use futures::StreamExt;
        let http_req = apply_headers(client.post(&req.url), &req.headers).json(&req.body);
        let resp = http_req
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("HTTP 请求失败: {e}")))?;
        let status = resp.status().as_u16();
        if !resp.status().is_success() {
            return Err(AppError::Internal(format!("LLM 请求失败 HTTP {status}")));
        }
        let filtered = crate::workflow_stream::filter_stream_response_headers(
            resp.headers()
                .iter()
                .filter_map(|(k, v)| Some((k.as_str(), v.to_str().ok()?))),
        );
        if let Some(bridge) = sink.as_ref() {
            bridge.commit(status, filtered).await;
        }
        let mut buf = crate::workflow_stream::BodyBuffer::new();
        let mut byte_stream = resp.bytes_stream();
        while let Some(item) = byte_stream.next().await {
            let bytes = item.map_err(|e| AppError::Internal(format!("读取响应失败: {e}")))?;
            if let Some(bridge) = sink.as_ref() {
                bridge.chunk(bytes.to_vec()).await;
            }
            buf.push(&bytes);
        }
        if let Some(bridge) = sink.as_ref() {
            bridge.end().await;
        }
        let body = buf.body_string();
        let text = crate::workflow_stream::extract_stream_text(&body);
        return llm_output(
            text,
            req.json_mode,
            json!({"prompt_tokens": null, "completion_tokens": null, "total_tokens": null}),
            req.requested_model,
            json!("stop"),
            true,
        )
        .map_err(|reason| {
            AppError::validation(
                "wfllm_stream_output_invalid",
                reason.clone(),
                serde_json::json!({ "reason": reason }),
            )
        });
    }

    let resp = apply_headers(client.post(&req.url), &req.headers)
        .json(&req.body)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("HTTP 请求失败: {e}")))?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(AppError::Internal(format!("LLM 请求失败 HTTP {status}")));
    }
    let text = resp
        .text()
        .await
        .map_err(|e| AppError::Internal(format!("读取响应失败: {e}")))?;
    let body: Value = serde_json::from_str(&text)
        .map_err(|e| AppError::Internal(format!("LLM 响应不是 JSON: {e}")))?;
    parse_non_stream_response(&body, &req.requested_model, req.json_mode).map_err(|reason| {
        AppError::validation(
            "wfllm_response_parse_invalid",
            reason.clone(),
            serde_json::json!({ "reason": reason }),
        )
    })
}

pub async fn execute_chat_request(
    req: LlmCallRequest,
    sink: Option<StreamBridge>,
) -> Result<Value> {
    let timeout_secs = req.timeout_secs;
    let execute = execute_chat_request_inner(req, sink);
    if timeout_secs > 0 {
        tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), execute)
            .await
            .map_err(|_| {
                AppError::Internal(format!("LLM 请求超时（超过 {timeout_secs} 秒未响应）"))
            })?
    } else {
        execute.await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_base_url_strips_slash_and_space() {
        assert_eq!(
            normalize_base_url(" https://api.deepseek.com/v1/ ").unwrap(),
            "https://api.deepseek.com/v1"
        );
    }

    #[test]
    fn normalize_base_url_rejects_empty_and_non_http() {
        assert!(normalize_base_url("").is_err());
        assert!(normalize_base_url("ftp://x").is_err());
        assert!(normalize_base_url("api.openai.com").is_err());
    }

    #[test]
    fn normalize_base_url_allows_localhost() {
        assert_eq!(
            normalize_base_url("http://127.0.0.1:11434/v1").unwrap(),
            "http://127.0.0.1:11434/v1"
        );
    }

    #[test]
    fn chat_and_models_urls_join() {
        assert_eq!(
            chat_completions_url("https://api.openai.com/v1"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            models_url("https://api.openai.com/v1"),
            "https://api.openai.com/v1/models"
        );
    }

    #[test]
    fn model_allowed_is_case_sensitive() {
        let models = normalize_models(&[
            "  deepseek-chat  ".into(),
            "".into(),
            "deepseek-reasoner".into(),
        ]);
        assert_eq!(models, vec!["deepseek-chat", "deepseek-reasoner"]);
        assert!(model_allowed(&models, "deepseek-chat"));
        assert!(!model_allowed(&models, "DeepSeek-Chat"));
    }

    #[test]
    fn assemble_system_messages_user() {
        let msgs = assemble_messages(
            Some("sys"),
            &json!([{"role":"user","content":"hi"},{"role":"assistant","content":"yo"}]),
            Some("now"),
        )
        .unwrap();
        assert_eq!(msgs.len(), 4);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[3]["content"], "now");
    }

    #[test]
    fn assemble_rejects_empty_and_bad_role_and_array_content() {
        assert!(assemble_messages(None, &json!(null), None).is_err());
        assert!(assemble_messages(None, &json!([{"role":"tool","content":"x"}]), None).is_err());
        assert!(assemble_messages(None, &json!([{"role":"user","content":["no"]}]), None).is_err());
    }

    #[test]
    fn assemble_parses_messages_json_string() {
        let msgs = assemble_messages(
            None,
            &json!("[{\"role\":\"user\",\"content\":\"a\"}]"),
            None,
        )
        .unwrap();
        assert_eq!(msgs[0]["content"], "a");
    }

    #[test]
    fn statically_empty_only_when_no_templates() {
        assert!(is_statically_empty_prompts(
            &json!(""),
            &json!("  "),
            &json!([])
        ));
        assert!(!is_statically_empty_prompts(
            &json!("{{trigger.x}}"),
            &json!(""),
            &json!(null)
        ));
    }

    #[test]
    fn temperature_default_and_range() {
        assert_eq!(parse_temperature(&json!({})).unwrap(), 0.7);
        assert_eq!(parse_temperature(&json!({"temperature": 0})).unwrap(), 0.0);
        assert!(parse_temperature(&json!({"temperature": 2.1})).is_err());
    }

    #[test]
    fn json_mode_parse_and_fence_not_stripped() {
        assert_eq!(parse_json_mode_text("{\"a\":1}").unwrap()["a"], 1);
        assert!(parse_json_mode_text("```json\n{\"a\":1}\n```").is_err());
        assert!(parse_json_mode_text("not-json").is_err());
    }

    #[test]
    fn skip_mock_and_truncate() {
        let m = skip_llm_mock("m1", true);
        assert_eq!(m["text"], "[skip_llm] mocked completion");
        assert_eq!(m["json"], json!({}));
        assert_eq!(truncate_error_body(&"x".repeat(3000)).len(), 2048);
    }

    #[test]
    fn parse_non_stream_extracts_text_usage() {
        let body = json!({
            "model": "deepseek-chat",
            "choices": [{"message": {"content": "{\"ok\":true}"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3}
        });
        let out = parse_non_stream_response(&body, "fallback", true).unwrap();
        assert_eq!(out["text"], "{\"ok\":true}");
        assert_eq!(out["json"]["ok"], true);
        assert_eq!(out["usage"]["total_tokens"], 3);
        assert_eq!(out["model"], "deepseek-chat");
    }

    #[tokio::test]
    async fn execute_chat_request_posts_json() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        // client_for_url 只在 development/test 实例放行 http://localhost
        std::env::set_var("RUST_ENV", "test");

        let listener = TcpListener::bind("[::1]:0").await.unwrap();
        let url = format!(
            "http://[::1]:{}/v1/chat/completions",
            listener.local_addr().unwrap().port()
        );
        let payload =
            r#"{"choices":[{"message":{"content":"hi"},"finish_reason":"stop"}],"usage":{}}"#;
        let handle = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 8192];
            let n = s.read(&mut buf).await.unwrap();
            let req = String::from_utf8_lossy(&buf[..n]);
            assert!(req.contains("POST "));
            assert!(req.contains("deepseek-chat"));
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                payload.len(),
                payload
            );
            s.write_all(resp.as_bytes()).await.unwrap();
        });

        let out = execute_chat_request(
            LlmCallRequest {
                url,
                headers: vec![],
                body: build_chat_body(
                    "deepseek-chat",
                    &[json!({"role":"user","content":"q"})],
                    0.7,
                    None,
                    false,
                    false,
                ),
                timeout_secs: 5,
                json_mode: false,
                stream: false,
                requested_model: "deepseek-chat".into(),
            },
            None,
        )
        .await
        .unwrap();
        assert_eq!(out["text"], "hi");
        handle.await.unwrap();
    }
}
