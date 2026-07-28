//! 结构化业务日志
//!
//! 输出固定形态的 JSON，方便 ELK / Loki / 自研 SaaS 日志系统直接解析：
//! ```text
//! {"timestamp":"2026-05-18T01:25:16.361976Z","level":"ERROR",
//!  "logger":"onebase::auto_api_handlers","message":"...",
//!  "taskName":null,"x_request_id":"98753d7e-..."}
//! ```
//!
//! 字段：
//! - `timestamp`：UTC RFC 3339，固定 6 位微秒，结尾 `Z`
//! - `level`：`INFO` / `WARN` / `ERROR` / `DEBUG` / `TRACE`
//! - `logger`：tracing event 的 `target`（一般等于模块路径）
//! - `message`：`tracing::info!("...")` 的 message 字段
//! - `taskName`：最里层的 tracing span 名（无 span 时为 `null`），用于关联协程 / 业务流程
//! - `x_request_id`：从请求级 task_local 读取（由 [`crate::request_id`] 中间件设置），
//!   非 HTTP 路径（启动 / 后台任务）下为 `null`
//!
//! 额外结构化字段（如 `tracing::info!(user_id = 42, "msg")` 里的 `user_id`）会被
//! 平铺到 JSON 根对象，对接 ES 直接 mapping 成索引字段。
//!
//! 同时维持原有 EnvFilter 行为：`RUST_LOG` 不变；默认 `info,onebase=debug,sqlx=info`。
//!
//! ### 输出目的地
//!
//! - **stdout**：始终开启。本地 `cargo run` 直接看终端；容器里 `docker logs` /
//!   `kubectl logs` 都靠这个。
//! - **文件**：可选。设置 `LOG_DIR=/var/log/onebase` 后，按天滚动写
//!   `onebase.YYYY-MM-DD.log`；或设置 `LOG_FILE=/path/to/file.log` 写到固定文件
//!   （此时不滚动，建议交给 logrotate）。两个变量都未设置 → 不写文件，保持纯 stdout。
//!
//! 文件写入走 `tracing-appender::non_blocking`：业务线程只往 channel 推一条，
//! 真正落盘在后台线程，避免 IO 抖动卡住请求路径。代价是必须把
//! [`tracing_appender::non_blocking::WorkerGuard`] 持有到进程结束——`init()` 把它
//! 通过返回值交给 `main`，丢给 `_guard` 即可。

use std::fmt;
use std::path::PathBuf;

use tracing::{Event, Subscriber};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::fmt::{
    format::Writer,
    FmtContext, FormatEvent, FormatFields,
};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

tokio::task_local! {
    /// 当前请求的 `x-request-id`。
    ///
    /// 由 [`crate::request_id::request_id_middleware`] 在每个请求最外层用
    /// `task_local!::scope` 注入；该 future 内的所有 `tracing::info!` 等都会
    /// 经 [`JsonLogFormatter`] 自动带上对应 ID。
    ///
    /// 非请求路径（启动日志 / `tokio::spawn` 出去的后台任务）读不到 → 输出 `null`。
    pub static REQUEST_ID: String;
}

/// 初始化全局 tracing 订阅器。**只能调一次**（再调会触发 `try_init` 失败被忽略）。
///
/// 返回 `Option<WorkerGuard>`：
/// - `Some(guard)`：启用了文件日志，调用方 **必须** 把 guard 持有到进程结束
///   （`let _guard = logging::init();`），否则文件 writer 后台线程会 drop 掉，
///   后续 `tracing::*` 写入直接静默丢失。
/// - `None`：未启用文件日志（仅 stdout），可以直接忽略返回值。
#[must_use = "持有返回的 WorkerGuard 直到进程结束，否则文件日志会被静默丢弃"]
pub fn init() -> Option<WorkerGuard> {
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(crate::brand::default_log_filter()));

    // stdout 永远开。容器里 supervisord / docker / k8s 的标准日志收集都依赖这条。
    let stdout_layer = tracing_subscriber::fmt::layer()
        .event_format(JsonLogFormatter)
        .with_writer(std::io::stdout);

    // 文件可选：LOG_DIR 优先（按天滚动），其次 LOG_FILE（单文件），都不设 → 跳过。
    let (file_layer, guard) = match build_file_writer() {
        Some((non_blocking, guard)) => {
            let layer = tracing_subscriber::fmt::layer()
                .event_format(JsonLogFormatter)
                .with_ansi(false) // 文件里别留 ANSI 颜色码，cat / grep 才干净
                .with_writer(non_blocking);
            (Some(layer), Some(guard))
        }
        None => (None, None),
    };

    tracing_subscriber::registry()
        .with(env_filter)
        .with(stdout_layer)
        .with(file_layer)
        .init();

    guard
}

/// 根据环境变量决定要不要建文件 writer，建则返回 `(NonBlocking, WorkerGuard)`。
///
/// 解析顺序：
/// 1. `LOG_DIR`（推荐生产用）：在该目录下按天滚动写 `onebase.YYYY-MM-DD.log`，
///    天然方便外部 logrotate / 清理脚本按 mtime 删旧文件。
/// 2. `LOG_FILE`：单文件，不自动滚动（适合 dev / 排障 / 让 logrotate 接管）。
/// 3. 都没有 → 返回 `None`，调用方走纯 stdout。
///
/// 任何一步失败（路径建不出 / 父目录不可写等）都会 fallback 到 `None` 并向 stderr
/// 打一条 warning，**绝不 panic**——日志系统抢救业务可观察性，自己挂掉等于火上浇油。
fn build_file_writer() -> Option<(tracing_appender::non_blocking::NonBlocking, WorkerGuard)> {
    if let Ok(dir) = std::env::var("LOG_DIR") {
        let dir = dir.trim();
        if !dir.is_empty() {
            if let Err(e) = std::fs::create_dir_all(dir) {
                eprintln!("[logging] LOG_DIR={} 建目录失败，回退到纯 stdout: {}", dir, e);
                return None;
            }
            let appender = tracing_appender::rolling::daily(dir, crate::brand::log_file_name());
            let (nb, guard) = tracing_appender::non_blocking(appender);
            return Some((nb, guard));
        }
    }

    if let Ok(path) = std::env::var("LOG_FILE") {
        let path = PathBuf::from(path.trim());
        if !path.as_os_str().is_empty() {
            if let Some(parent) = path.parent() {
                if !parent.as_os_str().is_empty() {
                    if let Err(e) = std::fs::create_dir_all(parent) {
                        eprintln!(
                            "[logging] LOG_FILE 父目录 {:?} 建目录失败，回退到纯 stdout: {}",
                            parent, e
                        );
                        return None;
                    }
                }
            }
            // 用 OpenOptions 走 append；non_blocking 接受任意 io::Write + Send。
            match std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
            {
                Ok(file) => {
                    let (nb, guard) = tracing_appender::non_blocking(file);
                    return Some((nb, guard));
                }
                Err(e) => {
                    eprintln!(
                        "[logging] LOG_FILE={:?} 打开失败，回退到纯 stdout: {}",
                        path, e
                    );
                    return None;
                }
            }
        }
    }

    None
}

/// 自研 JSON 格式化器；与 `tracing-subscriber` 自带 `.json()` 不同：
/// - 字段名按"业务侧约定"输出（`logger` / `x_request_id` / `taskName`），
///   不再是 `target` / `span.name`
/// - `timestamp` 6 位微秒，避免不同环境的小数位数不一致让日志比对乱掉
/// - `message` 提到根字段，其它 structured field 平铺到根（不再嵌 `fields: {...}`）
pub struct JsonLogFormatter;

impl<S, N> FormatEvent<S, N> for JsonLogFormatter
where
    S: Subscriber + for<'lookup> LookupSpan<'lookup>,
    N: for<'writer> FormatFields<'writer> + 'static,
{
    fn format_event(
        &self,
        ctx: &FmtContext<'_, S, N>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> fmt::Result {
        let meta = event.metadata();

        // 收集 event 的字段：message 单独提出来；其它结构化字段平铺到根对象。
        let mut visitor = FieldCollector::default();
        event.record(&mut visitor);

        // 用 serde_json::Map 拼装：让 serde 帮我们做字符串转义，省得手写 `\"` `\\` 翻车。
        use serde_json::{Map, Value};
        let mut obj: Map<String, Value> = Map::new();

        // timestamp：%.6f = 微秒，对齐 Python `datetime.isoformat(timespec='microseconds')`
        let ts = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.6fZ")
            .to_string();
        obj.insert("timestamp".into(), Value::String(ts));
        obj.insert("level".into(), Value::String(meta.level().as_str().to_string()));
        obj.insert("logger".into(), Value::String(meta.target().to_string()));
        obj.insert(
            "message".into(),
            Value::String(visitor.message.unwrap_or_default()),
        );

        // taskName：最里层 span 名（HTTP 路径上一般是中间件 / handler 注册的 span）。
        // 没有 span 上下文 = 后台任务 / 启动期 → null。
        let task_name = ctx
            .lookup_current()
            .map(|span| span.name().to_string());
        obj.insert(
            "taskName".into(),
            match task_name {
                Some(s) => Value::String(s),
                None => Value::Null,
            },
        );

        // x_request_id：从 task_local 取；非请求上下文 → null。
        let req_id = REQUEST_ID.try_with(|s| s.clone()).ok();
        obj.insert(
            "x_request_id".into(),
            match req_id {
                Some(s) if !s.is_empty() => Value::String(s),
                _ => Value::Null,
            },
        );

        // 把 event 自带的额外结构化字段也并到根对象。**不会**覆盖上面 6 个保留字段，
        // 避免业务方误用 `tracing::info!(level = "X")` 之类的把保留键冲掉。
        const RESERVED: [&str; 6] = ["timestamp", "level", "logger", "message", "taskName", "x_request_id"];
        for (k, v) in visitor.extra {
            if RESERVED.contains(&k.as_str()) {
                continue;
            }
            obj.insert(k, v);
        }

        let line = Value::Object(obj).to_string();
        writer.write_str(&line)?;
        writeln!(writer)
    }
}

/// `tracing::field::Visit` 实现：把 `message` 字段单独拎出来，其它字段塞到 `extra`
/// 等格式化器最终写到 JSON 根对象。
#[derive(Default)]
struct FieldCollector {
    message: Option<String>,
    extra: Vec<(String, serde_json::Value)>,
}

impl tracing::field::Visit for FieldCollector {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" {
            self.message = Some(value.to_string());
        } else {
            self.extra
                .push((field.name().to_string(), serde_json::Value::String(value.to_string())));
        }
    }

    fn record_bool(&mut self, field: &tracing::field::Field, value: bool) {
        self.extra
            .push((field.name().to_string(), serde_json::Value::Bool(value)));
    }

    fn record_i64(&mut self, field: &tracing::field::Field, value: i64) {
        self.extra.push((field.name().to_string(), value.into()));
    }

    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        self.extra.push((field.name().to_string(), value.into()));
    }

    fn record_f64(&mut self, field: &tracing::field::Field, value: f64) {
        self.extra.push((field.name().to_string(), value.into()));
    }

    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn fmt::Debug) {
        // `tracing::info!("hello {x}", x = 1)` 的 message 走的是 record_debug 而不是
        // record_str —— 用 {:?} 拿到的字符串首尾带引号，去一下避免 message 套两层引号。
        let formatted = format!("{:?}", value);
        let cleaned = if formatted.starts_with('"') && formatted.ends_with('"') && formatted.len() >= 2 {
            formatted[1..formatted.len() - 1].to_string()
        } else {
            formatted
        };
        if field.name() == "message" {
            self.message = Some(cleaned);
        } else {
            self.extra
                .push((field.name().to_string(), serde_json::Value::String(cleaned)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 互斥锁：`build_file_writer` 走 env var，多 case 并发改环境会互相干扰。
    /// `cargo test` 默认线程并发跑，靠这把锁串行化。
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn build_file_writer_returns_none_when_no_env() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // 临时清空两个变量，跑完恢复。
        let prev_dir = std::env::var("LOG_DIR").ok();
        let prev_file = std::env::var("LOG_FILE").ok();
        std::env::remove_var("LOG_DIR");
        std::env::remove_var("LOG_FILE");

        let out = build_file_writer();
        assert!(out.is_none(), "未设置任何环境变量时应返回 None");

        if let Some(v) = prev_dir { std::env::set_var("LOG_DIR", v); }
        if let Some(v) = prev_file { std::env::set_var("LOG_FILE", v); }
    }

    #[test]
    fn build_file_writer_creates_directory_for_log_dir() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev_dir = std::env::var("LOG_DIR").ok();
        let prev_file = std::env::var("LOG_FILE").ok();

        // 用 PID + 纳秒避免并行测试 / 重跑撞目录。
        let dir = std::env::temp_dir().join(format!(
            "onebase-log-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::env::set_var("LOG_DIR", dir.to_str().unwrap());
        std::env::remove_var("LOG_FILE");

        let out = build_file_writer();
        assert!(out.is_some(), "LOG_DIR 设置后应建出 writer");
        assert!(dir.exists(), "LOG_DIR 指定的目录应被自动创建");
        // drop guard → 后台线程退出
        drop(out);
        let _ = std::fs::remove_dir_all(&dir);

        std::env::remove_var("LOG_DIR");
        if let Some(v) = prev_dir { std::env::set_var("LOG_DIR", v); }
        if let Some(v) = prev_file { std::env::set_var("LOG_FILE", v); }
    }

    #[test]
    fn build_file_writer_opens_log_file_in_append_mode() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev_dir = std::env::var("LOG_DIR").ok();
        let prev_file = std::env::var("LOG_FILE").ok();

        let dir = std::env::temp_dir().join(format!(
            "onebase-logfile-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let path = dir.join("app.log");

        // 预置文件已有内容，验证 append 不被截断。
        std::fs::create_dir_all(&dir).unwrap();
        {
            let mut f = std::fs::File::create(&path).unwrap();
            f.write_all(b"existing\n").unwrap();
        }

        std::env::remove_var("LOG_DIR");
        std::env::set_var("LOG_FILE", path.to_str().unwrap());

        let out = build_file_writer();
        assert!(out.is_some(), "LOG_FILE 设置后应建出 writer");
        drop(out);

        let kept = std::fs::read_to_string(&path).unwrap();
        assert!(
            kept.contains("existing"),
            "已有日志内容应被保留（append 模式），实际: {:?}",
            kept
        );

        let _ = std::fs::remove_dir_all(&dir);

        std::env::remove_var("LOG_FILE");
        if let Some(v) = prev_dir { std::env::set_var("LOG_DIR", v); }
        if let Some(v) = prev_file { std::env::set_var("LOG_FILE", v); }
    }

    #[test]
    fn build_file_writer_returns_none_when_dir_unwriteable() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev_dir = std::env::var("LOG_DIR").ok();
        let prev_file = std::env::var("LOG_FILE").ok();

        // 故意指向"应该不可创建"的位置：父级是个不可写普通文件。
        let blocker = std::env::temp_dir().join(format!(
            "onebase-log-blocker-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::write(&blocker, b"i am a file, not a dir").unwrap();
        let bad_dir = blocker.join("nested"); // 父级是文件 → mkdir 必失败

        std::env::set_var("LOG_DIR", bad_dir.to_str().unwrap());
        std::env::remove_var("LOG_FILE");

        let out = build_file_writer();
        assert!(out.is_none(), "目录建不出来时应回退到 None 而不是 panic");

        let _ = std::fs::remove_file(&blocker);

        std::env::remove_var("LOG_DIR");
        if let Some(v) = prev_dir { std::env::set_var("LOG_DIR", v); }
        if let Some(v) = prev_file { std::env::set_var("LOG_FILE", v); }
    }
}
