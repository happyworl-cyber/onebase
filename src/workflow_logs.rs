//! Code-node debug log lines and truncation.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_LOG_LINES: usize = 200;
pub const MAX_LOG_BYTES: usize = 64 * 1024;
pub const MAX_LOG_MESSAGE_CHARS: usize = 4096;

const HEAD_TAIL_CHARS: usize = 2048;
const TRUNCATED_MARKER: &str = "…[truncated]…";
const LOGS_TRUNCATED_MESSAGE: &str = "日志已截断";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeLogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl std::fmt::Display for NodeLogLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            NodeLogLevel::Debug => "debug",
            NodeLogLevel::Info => "info",
            NodeLogLevel::Warn => "warn",
            NodeLogLevel::Error => "error",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeLogLine {
    pub level: NodeLogLevel,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct CodeExecOutput {
    pub body: Value,
    pub logs: Vec<NodeLogLine>,
}

#[derive(Debug, Clone)]
pub struct CodeExecError {
    pub message: String,
    pub logs: Vec<NodeLogLine>,
}

impl std::fmt::Display for CodeExecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<String> for CodeExecError {
    fn from(message: String) -> Self {
        Self {
            message,
            logs: vec![],
        }
    }
}

pub fn clamp_message(s: &str) -> String {
    if s.chars().count() <= MAX_LOG_MESSAGE_CHARS {
        return s.to_string();
    }
    let head: String = s.chars().take(HEAD_TAIL_CHARS).collect();
    let tail: String = s
        .chars()
        .rev()
        .take(HEAD_TAIL_CHARS)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    format!("{head}{TRUNCATED_MARKER}{tail}")
}

pub fn truncate_logs(logs: Vec<NodeLogLine>) -> Vec<NodeLogLine> {
    let mut out = Vec::new();
    let mut bytes = 0usize;
    let mut dropped = false;
    for line in logs {
        let message = clamp_message(&line.message);
        if out.len() >= MAX_LOG_LINES || bytes + message.len() > MAX_LOG_BYTES {
            dropped = true;
            break;
        }
        bytes += message.len();
        out.push(NodeLogLine {
            level: line.level,
            message,
        });
    }
    if dropped {
        out.push(NodeLogLine {
            level: NodeLogLevel::Warn,
            message: LOGS_TRUNCATED_MESSAGE.into(),
        });
    }
    out
}

pub fn logs_from_json(v: &Value) -> Vec<NodeLogLine> {
    let Some(arr) = v.as_array() else {
        return vec![];
    };
    arr.iter()
        .filter_map(|item| {
            let message = item.get("message")?.as_str()?.to_string();
            let level = match item.get("level").and_then(|l| l.as_str()) {
                Some("debug") => NodeLogLevel::Debug,
                Some("info") => NodeLogLevel::Info,
                Some("warn") => NodeLogLevel::Warn,
                Some("error") => NodeLogLevel::Error,
                Some(_) => NodeLogLevel::Info,
                None => return None,
            };
            Some(NodeLogLine { level, message })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clamp_long_message_keeps_head_and_tail() {
        let s = "A".repeat(3000) + &"B".repeat(3000);
        let out = clamp_message(&s);
        assert!(out.starts_with(&"A".repeat(2048)));
        assert!(out.contains("…[truncated]…"));
        assert!(out.ends_with(&"B".repeat(2048)));
        assert!(out.chars().count() < s.chars().count());
    }

    #[test]
    fn truncate_caps_lines_and_appends_marker() {
        let logs: Vec<_> = (0..201)
            .map(|i| NodeLogLine {
                level: NodeLogLevel::Info,
                message: format!("l{i}"),
            })
            .collect();
        let out = truncate_logs(logs);
        assert_eq!(out.len(), 201);
        assert_eq!(out[199].message, "l199");
        assert_eq!(out[200].level, NodeLogLevel::Warn);
        assert_eq!(out[200].message, "日志已截断");
    }

    #[test]
    fn logs_from_json_skips_bad_rows() {
        let v = json!([
            { "level": "warn", "message": "x" },
            { "level": "nope", "message": "y" },
            { "message": "z" }
        ]);
        let logs = logs_from_json(&v);
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0].level, NodeLogLevel::Warn);
        assert_eq!(logs[1].level, NodeLogLevel::Info);
    }
}
