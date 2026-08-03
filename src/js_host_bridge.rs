//! JavaScript workflow host bridge.
//!
//! The bridge speaks newline-delimited JSON over a Unix-domain stream socket:
//! `{ "id": "1", "op": "env.get", "args": { "key": "FOO" } }` produces
//! `{ "id": "1", "ok": true, "result": "..." }` (or `ok: false` with an
//! error). A bridge is scoped to one JavaScript process and only exposes its
//! injected project environment, never the service process environment.

use base64::{engine::general_purpose, Engine as _};
use hmac::{Hmac, Mac};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::task::JoinHandle;

/// Per-execution host capabilities made available to JavaScript code.
pub struct HostBridgeConfig {
    pub env_vars: HashMap<String, String>,
    pub tenant_id: Option<i32>,
    pub http_disabled: bool,
    pub socket_path: PathBuf,
}

/// Owns the listener task. Dropping it stops the bridge and removes the socket.
pub struct HostBridgeHandle {
    task: JoinHandle<()>,
    socket_path: PathBuf,
}

impl HostBridgeHandle {
    /// Stops the listener and removes its Unix socket.
    pub async fn shutdown(self) {
        self.task.abort();
        let _ = tokio::fs::remove_file(&self.socket_path).await;
    }
}

impl Drop for HostBridgeHandle {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

/// Starts a bridge listener for one JavaScript execution.
pub async fn start_bridge(config: HostBridgeConfig) -> Result<HostBridgeHandle, String> {
    if config.socket_path.exists() {
        tokio::fs::remove_file(&config.socket_path)
            .await
            .map_err(|e| format!("移除旧 JS host socket 失败: {e}"))?;
    }
    let listener = UnixListener::bind(&config.socket_path)
        .map_err(|e| format!("创建 JS host socket 失败: {e}"))?;
    let socket_path = config.socket_path.clone();
    let config = Arc::new(config);
    let task = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let config = Arc::clone(&config);
            tokio::spawn(async move {
                if let Err(error) = serve_connection(stream, config).await {
                    tracing::debug!(target: "js_host_bridge", "JS host IPC connection failed: {error}");
                }
            });
        }
    });
    Ok(HostBridgeHandle { task, socket_path })
}

/// Enforces the platform's existing host-level private URL policy.
pub fn validate_http_url(url: &str) -> Result<(), String> {
    if crate::http_async_poll::is_private_url(url) {
        Err("JS host HTTP 不允许访问内网地址".to_string())
    } else {
        Ok(())
    }
}

async fn serve_connection(stream: UnixStream, config: Arc<HostBridgeConfig>) -> Result<(), String> {
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        let request: Value = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                write_response(
                    &mut writer,
                    Value::Null,
                    Err(format!("无效 IPC JSON: {error}")),
                )
                .await?;
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let result = match request.get("op").and_then(Value::as_str) {
            Some(op) => {
                handle_request(op, request.get("args").unwrap_or(&Value::Null), &config).await
            }
            None => Err("IPC 请求缺少 op".to_string()),
        };
        write_response(&mut writer, id, result).await?;
    }
    Ok(())
}

async fn write_response(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    id: Value,
    result: Result<Value, String>,
) -> Result<(), String> {
    let response = match result {
        Ok(result) => json!({ "id": id, "ok": true, "result": result }),
        Err(error) => json!({ "id": id, "ok": false, "error": error }),
    };
    let mut bytes = serde_json::to_vec(&response).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    writer.write_all(&bytes).await.map_err(|e| e.to_string())
}

async fn handle_request(
    op: &str,
    args: &Value,
    config: &HostBridgeConfig,
) -> Result<Value, String> {
    match op {
        "env.get" => Ok(args
            .get("key")
            .and_then(Value::as_str)
            .and_then(|key| config.env_vars.get(key))
            .map(|value| Value::String(value.clone()))
            .unwrap_or(Value::Null)),
        "json.encode" => serde_json::to_string(args.get("value").unwrap_or(&Value::Null))
            .map(Value::String)
            .map_err(|e| format!("json.encode 失败: {e}")),
        "json.encode_pretty" => {
            serde_json::to_string_pretty(args.get("value").unwrap_or(&Value::Null))
                .map(Value::String)
                .map_err(|e| format!("json.encode_pretty 失败: {e}"))
        }
        "json.decode" => {
            let input = required_str(args, "input")?;
            serde_json::from_str(input).map_err(|e| format!("json.decode 失败: {e}"))
        }
        "time.now" => Ok(json!(unix_duration()?.as_secs())),
        "time.now_ms" => Ok(json!(unix_duration()?.as_millis())),
        "log.info" | "log.warn" | "log.error" | "log.debug" => {
            let message = required_str(args, "message")?;
            match op {
                "log.info" => tracing::info!(target: "js_plugin", "{message}"),
                "log.warn" => tracing::warn!(target: "js_plugin", "{message}"),
                "log.error" => tracing::error!(target: "js_plugin", "{message}"),
                _ => tracing::debug!(target: "js_plugin", "{message}"),
            }
            Ok(Value::Null)
        }
        "http.get" | "http.post" | "http.put" | "http.delete" => {
            if config.http_disabled {
                return Err("JS host HTTP 在当前执行环境中已禁用".to_string());
            }
            execute_http(op.trim_start_matches("http."), args).await
        }
        "crypto.sha256" => Ok(Value::String(hex::encode(Sha256::digest(
            required_str(args, "input")?.as_bytes(),
        )))),
        "crypto.hmac_sha256" => {
            type HmacSha256 = Hmac<Sha256>;
            let mut mac = HmacSha256::new_from_slice(required_str(args, "key")?.as_bytes())
                .map_err(|e| e.to_string())?;
            mac.update(required_str(args, "data")?.as_bytes());
            Ok(Value::String(hex::encode(mac.finalize().into_bytes())))
        }
        "crypto.uuid" => Ok(Value::String(uuid::Uuid::new_v4().to_string())),
        "crypto.base64_encode" => Ok(Value::String(
            general_purpose::STANDARD.encode(required_str(args, "input")?.as_bytes()),
        )),
        "crypto.base64_decode" => {
            let bytes = general_purpose::STANDARD
                .decode(required_str(args, "input")?.trim())
                .map_err(|e| format!("base64_decode 失败: {e}"))?;
            String::from_utf8(bytes).map(Value::String).map_err(|_| {
                "base64_decode 结果不是 UTF-8；JS runtime 暂不支持二进制字符串".to_string()
            })
        }
        "sse.publish" => {
            let topic = required_str(args, "topic")?;
            if topic.trim().is_empty() {
                return Err("sse.publish: topic 不能为空".to_string());
            }
            let event = args
                .get("event")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or("message")
                .to_string();
            Ok(Value::Bool(crate::sse_publisher::publish(
                topic.to_string(),
                event,
                args.get("data").cloned().unwrap_or(Value::Null),
            )))
        }
        "google.sa_assertion" => {
            let (assertion, project_id, client_email) = crate::lua_builtins::google_sa_assertion(
                config.tenant_id,
                required_str(args, "project")?,
                required_str(args, "scope")?,
            )?;
            Ok(
                json!({ "assertion": assertion, "project_id": project_id, "client_email": client_email }),
            )
        }
        _ if op.starts_with("crypto.") => Err(format!("{op}: not implemented by JS host bridge")),
        _ => Err(format!("未知 JS host 操作: {op}")),
    }
}

async fn execute_http(method: &str, args: &Value) -> Result<Value, String> {
    let url = required_str(args, "url")?;
    validate_http_url(url)?;
    let timeout_secs = args.get("timeout").and_then(Value::as_u64).unwrap_or(120);
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;
    let mut request = match method {
        "post" => client.post(url),
        "put" => client.put(url),
        "delete" => client.delete(url),
        _ => client.get(url),
    };
    if let Some(headers) = args.get("headers").and_then(Value::as_object) {
        for (key, value) in headers {
            if let Some(value) = value.as_str() {
                request = request.header(key, value);
            }
        }
    }
    if let Some(body) = args.get("body") {
        request = if let Some(body) = body.as_str() {
            request.body(body.to_string())
        } else {
            request.json(body)
        };
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("HTTP 请求失败: {e}"))?;
    let status = response.status().as_u16();
    let headers: Map<String, Value> = response
        .headers()
        .iter()
        .filter_map(|(key, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (key.to_string(), json!(value)))
        })
        .collect();
    let body = response
        .text()
        .await
        .map_err(|e| format!("读取 HTTP 响应失败: {e}"))?;
    let mut result = json!({ "status": status, "body": body, "headers": headers });
    if let Ok(value) = serde_json::from_str::<Value>(result["body"].as_str().unwrap_or_default()) {
        result["json"] = value;
    }
    Ok(result)
}

fn required_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("JS host 操作缺少字符串参数 `{key}`"))
}

fn unix_duration() -> Result<Duration, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("系统时钟早于 Unix epoch: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{start_bridge, validate_http_url, HostBridgeConfig};
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::process::Command;

    #[test]
    fn rejects_private_http_urls() {
        assert!(validate_http_url("http://127.0.0.1/internal").is_err());
    }

    #[tokio::test]
    async fn node_runtime_reads_injected_environment_value() {
        if Command::new("node").arg("--version").output().is_err() {
            return;
        }

        // Unix socket paths are capped at roughly 104 bytes on macOS; use
        // the native temporary filesystem rather than the external workspace.
        let socket_path =
            PathBuf::from("/tmp").join(format!("ctr-js-{}.sock", uuid::Uuid::new_v4()));
        let bridge = start_bridge(HostBridgeConfig {
            env_vars: HashMap::from([("FOO".to_string(), "bar".to_string())]),
            tenant_id: None,
            http_disabled: false,
            socket_path: socket_path.clone(),
        })
        .await
        .expect("bridge starts");

        let runtime =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("js-runtime/onebase-runtime/index.js");
        let output = tokio::task::spawn_blocking(move || {
            Command::new("node")
                .arg("--require")
                .arg(runtime)
                .arg("-e")
                .arg("process.stdout.write(env.get('FOO'))")
                .env("ONEBASE_HOST_SOCK", &socket_path)
                .output()
                .expect("node starts")
        })
        .await
        .expect("node task completes");

        bridge.shutdown().await;
        assert!(
            output.status.success(),
            "node stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8(output.stdout).unwrap(), "bar");
    }
}
