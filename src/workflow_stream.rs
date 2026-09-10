//! Endpoint 同连接 HTTP 流：进程内 Bridge、正文缓冲、SSE 抽文本。

use serde_json::Value;
use tokio::sync::mpsc;

pub const BODY_LIMIT_BYTES: usize = 8 * 1024 * 1024;
pub const STREAM_CHANNEL_CAPACITY: usize = 32;

#[derive(Debug, Clone)]
pub enum StreamEvent {
    Commit {
        status: u16,
        headers: Vec<(String, String)>,
    },
    Chunk(Vec<u8>),
    End,
}

#[derive(Clone)]
pub struct StreamBridge {
    tx: mpsc::Sender<StreamEvent>,
}

impl StreamBridge {
    pub fn pair() -> (Self, mpsc::Receiver<StreamEvent>) {
        let (tx, rx) = mpsc::channel(STREAM_CHANNEL_CAPACITY);
        (Self { tx }, rx)
    }

    pub async fn commit(&self, status: u16, headers: Vec<(String, String)>) -> bool {
        self.tx
            .send(StreamEvent::Commit { status, headers })
            .await
            .is_ok()
    }

    pub async fn chunk(&self, bytes: Vec<u8>) -> bool {
        self.tx.send(StreamEvent::Chunk(bytes)).await.is_ok()
    }

    pub async fn end(&self) -> bool {
        self.tx.send(StreamEvent::End).await.is_ok()
    }
}

pub fn stream_enabled(config: &Value) -> bool {
    config
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

pub fn count_stream_http_calls_json(nodes: &Value) -> usize {
    nodes
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter(|n| {
                    n.get("type").and_then(|t| t.as_str()) == Some("http_call")
                        && n.get("config").map(stream_enabled).unwrap_or(false)
                })
                .count()
        })
        .unwrap_or(0)
}

pub fn extract_stream_text(body: &str) -> String {
    let mut out = String::new();
    for line in body.lines() {
        let line = line.trim_end_matches('\r');
        let Some(rest) = line.strip_prefix("data:") else {
            continue;
        };
        let data = rest.strip_prefix(' ').unwrap_or(rest);
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        if value.get("type").and_then(|t| t.as_str()) == Some("content_block_delta") {
            if let Some(text) = value.pointer("/delta/text").and_then(|v| v.as_str()) {
                out.push_str(text);
            }
            continue;
        }
        if let Some(choice) = value.pointer("/choices/0") {
            let text = choice
                .pointer("/delta/content")
                .and_then(|v| v.as_str())
                .or_else(|| choice.pointer("/delta/text").and_then(|v| v.as_str()))
                .or_else(|| choice.get("text").and_then(|v| v.as_str()));
            if let Some(text) = text {
                out.push_str(text);
            }
        }
    }
    out
}

const STREAM_HEADER_WHITELIST: &[&str] = &["content-type", "cache-control", "content-disposition"];

const STREAM_HEADER_DENY: &[&str] = &[
    "set-cookie",
    "transfer-encoding",
    "content-length",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "te",
    "trailer",
    "upgrade",
];

pub fn filter_stream_response_headers<'a, I>(headers: I) -> Vec<(String, String)>
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    let mut out = Vec::new();
    for (name, value) in headers {
        let key = name.to_ascii_lowercase();
        if STREAM_HEADER_DENY.contains(&key.as_str()) {
            continue;
        }
        if STREAM_HEADER_WHITELIST.contains(&key.as_str()) {
            out.push((key, value.to_string()));
        }
    }
    out
}

pub struct BodyBuffer {
    raw: Vec<u8>,
    truncated: bool,
}

impl BodyBuffer {
    pub fn new() -> Self {
        Self {
            raw: Vec::new(),
            truncated: false,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        if self.truncated {
            return;
        }
        let room = BODY_LIMIT_BYTES.saturating_sub(self.raw.len());
        if bytes.len() > room {
            self.raw.extend_from_slice(&bytes[..room]);
            self.truncated = true;
        } else {
            self.raw.extend_from_slice(bytes);
        }
    }

    pub fn body_string(&self) -> String {
        String::from_utf8_lossy(&self.raw).into_owned()
    }

    pub fn is_truncated(&self) -> bool {
        self.truncated
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stream_enabled_reads_bool() {
        assert!(!stream_enabled(&json!({})));
        assert!(stream_enabled(&json!({"stream": true})));
        assert!(!stream_enabled(&json!({"stream": false})));
    }

    #[test]
    fn count_stream_http_calls_json_counts_only_stream_http() {
        let nodes = json!([
            {"id":"a","type":"http_call","config":{"url":"https://x","stream":true}},
            {"id":"b","type":"http_call","config":{"url":"https://y"}},
            {"id":"c","type":"response","config":{"stream":true}}
        ]);
        assert_eq!(count_stream_http_calls_json(&nodes), 1);
    }

    #[test]
    fn extract_openai_delta_content() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n",
            "data: [DONE]\n\n"
        );
        assert_eq!(extract_stream_text(body), "Hello");
    }

    #[test]
    fn extract_openai_choice_text() {
        let body = "data: {\"choices\":[{\"text\":\"Hi\"}]}\n\n";
        assert_eq!(extract_stream_text(body), "Hi");
    }

    #[test]
    fn extract_claude_content_block_delta() {
        let body = concat!(
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Ab\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"c\"}}\n\n"
        );
        assert_eq!(extract_stream_text(body), "Abc");
    }

    #[test]
    fn extract_unknown_protocol_is_empty() {
        assert_eq!(extract_stream_text("not-sse"), "");
    }

    #[test]
    fn filter_keeps_whitelist_and_drops_set_cookie() {
        let out = filter_stream_response_headers([
            ("Content-Type", "text/event-stream"),
            ("Cache-Control", "no-cache"),
            ("Content-Disposition", "inline"),
            ("Set-Cookie", "a=b"),
            ("Transfer-Encoding", "chunked"),
            ("Content-Length", "12"),
            ("X-Request-Id", "secret"),
        ]);
        let names: Vec<_> = out.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            names,
            ["content-type", "cache-control", "content-disposition"]
        );
    }

    #[test]
    fn body_buffer_truncates_at_8mib_but_remembers_flag() {
        let mut buf = BodyBuffer::new();
        buf.push(&vec![b'a'; BODY_LIMIT_BYTES]);
        buf.push(b"xyz");
        assert!(buf.is_truncated());
        assert_eq!(buf.body_string().len(), BODY_LIMIT_BYTES);
    }

    #[tokio::test]
    async fn bridge_send_returns_false_after_rx_drop() {
        let (bridge, rx) = StreamBridge::pair();
        drop(rx);
        assert!(!bridge.commit(200, vec![]).await);
        assert!(!bridge.chunk(b"x".to_vec()).await);
    }
}
