//! Sandboxed Node.js execution for workflow JavaScript code nodes.

use crate::js_deps::{self, DepsStatusKind, JsDependencies};
use crate::js_host_bridge::{start_bridge, HostBridgeConfig};
use crate::lua_engine::PluginContext;
use crate::workflow_logs::{logs_from_json, CodeExecError, CodeExecOutput};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

/// One JavaScript workflow code-node invocation.
pub struct JsExecRequest {
    pub workflow_id: i32,
    pub code: String,
    pub plugin_ctx: PluginContext,
    pub env_vars: HashMap<String, String>,
    pub credentials: crate::workflow_credentials::CredentialStore,
    pub tenant_id: Option<i32>,
    pub http_disabled: bool,
    pub timeout_ms: u64,
    /// Parsed npm dependency declaration for this workflow, if any.
    pub js_dependencies: Option<JsDependencies>,
}

/// Whether JavaScript workflow code nodes are enabled. Defaults to ON; set
/// WORKFLOW_JS_CODE_ENABLED to false/0/no/off to disable (unset/empty = enabled).
pub fn js_enabled() -> bool {
    match std::env::var("WORKFLOW_JS_CODE_ENABLED")
        .ok()
        .as_deref()
        .map(str::trim)
        .map(|value| value.to_ascii_lowercase())
    {
        Some(value) if !value.is_empty() => !matches!(value.as_str(), "false" | "0" | "no" | "off"),
        _ => true,
    }
}

/// Default execution deadline for JavaScript workflow code nodes.
pub fn js_timeout_ms() -> u64 {
    std::env::var("WORKFLOW_JS_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .filter(|value: &u64| *value > 0)
        .unwrap_or(30_000)
}

/// Execute user-supplied JavaScript and return its final `ctx.body` plus logs.
pub async fn execute_javascript(req: JsExecRequest) -> Result<CodeExecOutput, CodeExecError> {
    if !js_enabled() {
        return Err(
            "JavaScript workflow code nodes are disabled（JavaScript 工作流代码节点已禁用）；set WORKFLOW_JS_CODE_ENABLED=true to enable them"
                .to_string()
                .into(),
        );
    }

    let node = resolve_node()?;
    let deps_dir = if let Some(deps) = req.js_dependencies.as_ref() {
        let status = js_deps::ensure_javascript_deps(req.workflow_id, deps).await?;
        if status.status == DepsStatusKind::Failed {
            return Err(format!(
                "JavaScript dependencies are not ready: {}",
                status
                    .error
                    .unwrap_or_else(|| "npm install failed".to_string())
            )
            .into());
        }
        if status.status == DepsStatusKind::Installing {
            return Err("JavaScript dependencies are still installing"
                .to_string()
                .into());
        }
        let dir = js_deps::javascript_dir(req.workflow_id);
        dir.is_dir().then_some(dir)
    } else {
        None
    };

    let temp_dir = execution_dir()?;
    let result = execute_in_dir(&node, &req, deps_dir.as_deref(), &temp_dir).await;
    std::fs::remove_dir_all(&temp_dir).ok();
    result
}

async fn execute_in_dir(
    node: &Path,
    req: &JsExecRequest,
    deps_dir: Option<&Path>,
    temp_dir: &Path,
) -> Result<CodeExecOutput, CodeExecError> {
    let ctx_path = temp_dir.join("ctx.json");
    let user_path = temp_dir.join("user.js");
    let entry_path = temp_dir.join("entry.js");
    let result_path = temp_dir.join("result.json");
    write_execution_files(req, &ctx_path, &user_path, &entry_path)?;

    let socket_path = temp_dir.join("bridge.sock");
    let bridge = start_bridge(HostBridgeConfig {
        env_vars: req.env_vars.clone(),
        credentials: req.credentials.clone(),
        tenant_id: req.tenant_id,
        http_disabled: req.http_disabled,
        socket_path: socket_path.clone(),
    })
    .await?;

    let timeout_ms = if req.timeout_ms == 0 {
        js_timeout_ms()
    } else {
        req.timeout_ms
    };
    let run_result = run_node(
        node,
        &entry_path,
        temp_dir,
        deps_dir,
        &socket_path,
        timeout_ms,
    )
    .await;
    bridge.shutdown().await;

    match run_result {
        Ok(()) => {
            let raw = tokio::fs::read_to_string(&result_path)
                .await
                .map_err(|error| {
                    format!("JavaScript execution did not write result.json: {error}")
                })?;
            let result: Value = serde_json::from_str(&raw)
                .map_err(|error| format!("invalid JavaScript result.json: {error}"))?;
            Ok(CodeExecOutput {
                body: result.get("body").cloned().unwrap_or(Value::Null),
                logs: logs_from_json(result.get("logs").unwrap_or(&Value::Null)),
            })
        }
        Err(message) => {
            let logs = match tokio::fs::read_to_string(&result_path).await.ok() {
                Some(raw) => serde_json::from_str::<Value>(&raw)
                    .ok()
                    .map(|result| logs_from_json(result.get("logs").unwrap_or(&Value::Null)))
                    .unwrap_or_default(),
                None => vec![],
            };
            Err(CodeExecError { message, logs })
        }
    }
}

fn write_execution_files(
    req: &JsExecRequest,
    ctx_path: &Path,
    user_path: &Path,
    entry_path: &Path,
) -> Result<(), String> {
    let ctx = serde_json::to_vec(&req.plugin_ctx)
        .map_err(|error| format!("serialize JavaScript context: {error}"))?;
    std::fs::write(ctx_path, ctx).map_err(|error| format!("write ctx.json: {error}"))?;
    std::fs::write(user_path, &req.code).map_err(|error| format!("write user.js: {error}"))?;
    std::fs::write(entry_path, ENTRY_JS).map_err(|error| format!("write entry.js: {error}"))
}

async fn run_node(
    node: &Path,
    entry_path: &Path,
    temp_dir: &Path,
    deps_dir: Option<&Path>,
    socket_path: &Path,
    timeout_ms: u64,
) -> Result<(), String> {
    let runtime = runtime_path()?;
    let cwd = deps_dir.filter(|dir| dir.is_dir()).unwrap_or(temp_dir);
    let node_modules = cwd.join("node_modules");
    let use_bwrap = sandbox_uses_bwrap();
    let mut command = if use_bwrap {
        let mut command = tokio::process::Command::new("bwrap");
        command.args([
            "--die-with-parent",
            "--new-session",
            "--unshare-all",
            "--share-net",
            "--ro-bind",
            "/",
            "/",
            "--bind",
            temp_dir.to_str().ok_or("temporary path is not UTF-8")?,
            temp_dir.to_str().ok_or("temporary path is not UTF-8")?,
        ]);
        if cwd != temp_dir {
            command.args([
                "--bind",
                cwd.to_str().ok_or("dependency path is not UTF-8")?,
                cwd.to_str().ok_or("dependency path is not UTF-8")?,
            ]);
        }
        command.args([
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--chdir",
            cwd.to_str().ok_or("working directory is not UTF-8")?,
            "--setenv",
            "PATH",
            SAFE_PATH,
            "--setenv",
            "HOME",
            temp_dir.to_str().ok_or("temporary path is not UTF-8")?,
            "--setenv",
            "ONEBASE_HOST_SOCK",
            socket_path.to_str().ok_or("socket path is not UTF-8")?,
            "--setenv",
            "NODE_PATH",
            node_modules
                .to_str()
                .ok_or("node_modules path is not UTF-8")?,
        ]);
        command
            .arg(node)
            .arg("--require")
            .arg(runtime)
            .arg(entry_path);
        command.env_clear();
        command
    } else {
        let mut command = tokio::process::Command::new(node);
        command
            .arg("--require")
            .arg(runtime)
            .arg(entry_path)
            .current_dir(cwd)
            .env_clear()
            .env("PATH", SAFE_PATH)
            .env("HOME", temp_dir)
            .env("ONEBASE_HOST_SOCK", socket_path)
            .env("NODE_PATH", node_modules);
        command
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let output = tokio::time::timeout(Duration::from_millis(timeout_ms), command.output())
        .await
        .map_err(|_| format!("JavaScript execution timed out after {timeout_ms}ms"))?
        .map_err(|error| format!("spawn JavaScript process: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("JavaScript process exited with status {}", output.status)
        } else {
            format!(
                "JavaScript process exited with status {}: {stderr}",
                output.status
            )
        })
    }
}

fn resolve_node() -> Result<PathBuf, String> {
    let configured = std::env::var("WORKFLOW_NODE_BIN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "node".to_string());
    let binary = if configured.contains('/') {
        PathBuf::from(configured)
    } else {
        find_in_path(&configured).ok_or_else(|| {
            "Node.js binary not found; install node or set WORKFLOW_NODE_BIN".to_string()
        })?
    };
    let output = std::process::Command::new(&binary)
        .arg("--version")
        .output()
        .map_err(|error| format!("Node.js binary is not usable ({binary:?}): {error}"))?;
    if output.status.success() {
        Ok(binary)
    } else {
        Err(format!(
            "Node.js binary is not usable ({binary:?}): {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn runtime_path() -> Result<PathBuf, String> {
    // Prefer an explicit path (deployed images set WORKFLOW_JS_RUNTIME because the
    // compile-time CARGO_MANIFEST_DIR does not exist in the runtime container).
    if let Ok(configured) = std::env::var("WORKFLOW_JS_RUNTIME") {
        let configured = configured.trim();
        if !configured.is_empty() {
            let path = PathBuf::from(configured);
            return path
                .is_file()
                .then_some(path)
                .ok_or_else(|| format!("WORKFLOW_JS_RUNTIME 指向的文件不存在: {configured}"));
        }
    }
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("js-runtime")
        .join("onebase-runtime")
        .join("index.js");
    path.is_file()
        .then_some(path)
        .ok_or_else(|| "PlaneOS JavaScript runtime index.js is missing".to_string())
}

fn execution_dir() -> Result<PathBuf, String> {
    // Unix-domain socket paths are short (about 104 bytes on macOS). The
    // process temp directory can be deeply nested, so keep the per-run
    // directory directly under /tmp where this module's bridge socket lives.
    let path = PathBuf::from("/tmp").join(format!("ctr-js-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&path).map_err(|error| format!("create JavaScript temp dir: {error}"))?;
    Ok(path)
}

fn sandbox_uses_bwrap() -> bool {
    !matches!(
        std::env::var("WORKFLOW_JS_SANDBOX")
            .ok()
            .as_deref()
            .map(str::trim)
            .map(|value| value.to_ascii_lowercase()),
        Some(value) if matches!(value.as_str(), "direct" | "none" | "raw")
    ) && find_in_path("bwrap").is_some()
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}

const SAFE_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/// Serializes tests that mutate `WORKFLOW_JS_*` process env vars. Shared with
/// the `workflow_engine` dispatch test so they never race on the same globals.
#[cfg(test)]
pub(crate) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

const ENTRY_JS: &str = r#"'use strict';
const fs = require('fs');
const path = require('path');
const util = require('util');

const __logs = [];
function __push(level, args) {
  __logs.push({
    level,
    message: Array.from(args).map((a) => typeof a === 'string' ? a : util.inspect(a, { depth: 4 })).join(' '),
  });
}

const __origError = console.error.bind(console);
console.log = (...args) => { __push('info', args); };
console.info = (...args) => { __push('info', args); };
console.warn = (...args) => { __push('warn', args); };
console.error = (...args) => { __push('error', args); };
console.debug = (...args) => { __push('debug', args); };

if (global.log) {
  for (const level of ['info', 'warn', 'error', 'debug']) {
    const orig = global.log[level] && global.log[level].bind(global.log);
    if (!orig) continue;
    global.log[level] = (message, ...rest) => {
      __push(level, [message, ...rest]);
      return orig(message, ...rest);
    };
  }
}

function __flush(body) {
  fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify({ body: body ?? null, logs: __logs }));
}

(async () => {
  const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, 'ctx.json'), 'utf8'));
  if (!Object.prototype.hasOwnProperty.call(ctx, 'body')) ctx.body = null;
  if (!Object.prototype.hasOwnProperty.call(ctx, 'nodes')) ctx.nodes = null;
  const source = fs.readFileSync(path.join(__dirname, 'user.js'), 'utf8');
  const mod = { exports: {} };
  const fn = new Function(
    'require', 'module', 'exports', 'ctx',
    `${source}\n; return typeof execute === 'function' ? execute : (module.exports && module.exports.execute);`
  );
  const execute = fn(require, mod, mod.exports, ctx);
  const returned = typeof execute === 'function' ? await execute(ctx) : undefined;
  if (returned !== undefined && returned !== null) ctx.body = returned;
  __flush(ctx.body);
})().catch((error) => {
  __flush(null);
  __origError(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    fn plugin_ctx(body: serde_json::Value) -> crate::lua_engine::PluginContext {
        crate::lua_engine::PluginContext {
            method: "WORKFLOW".to_string(),
            path: "/workflow/1".to_string(),
            schema: None,
            table: None,
            body: Some(body),
            query_params: None,
            headers: None,
            user_id: None,
            tenant_id: None,
            database_id: None,
            request_id: None,
            nodes: Some(json!({"previous": {"ok": true}})),
        }
    }

    fn request(code: &str) -> JsExecRequest {
        JsExecRequest {
            workflow_id: 1,
            code: code.to_string(),
            plugin_ctx: plugin_ctx(json!({"x": 7})),
            env_vars: HashMap::new(),
            credentials: crate::workflow_credentials::CredentialStore::default(),
            tenant_id: None,
            http_disabled: false,
            timeout_ms: 1_000,
            js_dependencies: None,
        }
    }

    #[test]
    fn runtime_path_prefers_env_override() {
        let _guard = ENV_LOCK.lock().unwrap();
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("js-runtime")
            .join("onebase-runtime")
            .join("index.js");
        std::env::set_var("WORKFLOW_JS_RUNTIME", &path);
        assert_eq!(runtime_path().unwrap(), path);
        std::env::set_var("WORKFLOW_JS_RUNTIME", "/nonexistent/index.js");
        assert!(runtime_path().is_err());
        std::env::remove_var("WORKFLOW_JS_RUNTIME");
    }

    #[tokio::test]
    async fn execute_rejects_when_javascript_is_disabled() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("WORKFLOW_JS_CODE_ENABLED", "false");

        let error = execute_javascript(request("ctx.body = { ok: true };"))
            .await
            .expect_err("disabled JavaScript code nodes must be rejected");

        std::env::remove_var("WORKFLOW_JS_CODE_ENABLED");
        assert!(
            error.message.contains("disabled") || error.message.contains("禁用"),
            "unexpected error: {}",
            error.message
        );
    }

    #[tokio::test]
    async fn execute_round_trips_modified_context_body() {
        let _guard = ENV_LOCK.lock().unwrap();
        if std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        std::env::set_var("WORKFLOW_JS_CODE_ENABLED", "true");
        std::env::set_var("WORKFLOW_JS_SANDBOX", "direct");

        let result = execute_javascript(request(
            "ctx.body = { ok: true, n: (ctx.body && ctx.body.x) || 1 };",
        ))
        .await
        .expect("JavaScript should execute");

        std::env::remove_var("WORKFLOW_JS_CODE_ENABLED");
        std::env::remove_var("WORKFLOW_JS_SANDBOX");
        assert_eq!(result.body, json!({"ok": true, "n": 7}));
    }

    #[tokio::test]
    async fn execute_collects_console_and_log_and_survives_throw() {
        let _guard = ENV_LOCK.lock().unwrap();
        if std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        std::env::set_var("WORKFLOW_JS_CODE_ENABLED", "true");
        std::env::set_var("WORKFLOW_JS_SANDBOX", "direct");
        let ok = execute_javascript(request(
            r#"
console.log("hello", 1);
log.warn("w");
ctx.body = { ok: true };
"#,
        ))
        .await
        .expect("js ok");
        std::env::remove_var("WORKFLOW_JS_CODE_ENABLED");
        std::env::remove_var("WORKFLOW_JS_SANDBOX");
        assert_eq!(ok.body, json!({"ok": true}));
        assert!(ok
            .logs
            .iter()
            .any(|l| l.level == crate::workflow_logs::NodeLogLevel::Info
                && l.message.contains("hello")));
        assert!(ok
            .logs
            .iter()
            .any(|l| l.level == crate::workflow_logs::NodeLogLevel::Warn && l.message == "w"));

        std::env::set_var("WORKFLOW_JS_CODE_ENABLED", "true");
        std::env::set_var("WORKFLOW_JS_SANDBOX", "direct");
        let err = execute_javascript(request(
            r#"
console.log("before");
throw new Error("boom");
"#,
        ))
        .await
        .expect_err("must fail");
        std::env::remove_var("WORKFLOW_JS_CODE_ENABLED");
        std::env::remove_var("WORKFLOW_JS_SANDBOX");
        assert!(err.message.to_lowercase().contains("boom") || err.message.contains("Error"));
        assert!(err.logs.iter().any(|l| l.message.contains("before")));
    }
}
