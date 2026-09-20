//! Sandboxed Python execution for workflow Python code nodes.
//!
//! Mirrors `js_runner` but runs the system Python interpreter. It reuses the
//! language-agnostic `js_host_bridge` so Python scripts get the same host API
//! (`env` / `http` / `crypto` / `log` / `json` / `time` / `sse` / `google`) and
//! the same secret / SSRF policy as Lua and JavaScript code nodes.

use crate::js_host_bridge::{start_bridge, HostBridgeConfig};
use crate::lua_engine::PluginContext;
use crate::py_deps::{self, PyDependencies};
use crate::workflow_logs::{logs_from_json, CodeExecError, CodeExecOutput};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

/// One Python workflow code-node invocation.
pub struct PyExecRequest {
    pub workflow_id: i32,
    pub code: String,
    pub plugin_ctx: PluginContext,
    pub env_vars: HashMap<String, String>,
    pub credentials: crate::workflow_credentials::CredentialStore,
    pub tenant_id: Option<i32>,
    pub http_disabled: bool,
    pub timeout_ms: u64,
    /// Parsed pip dependency declaration for this workflow, if any.
    pub py_dependencies: Option<PyDependencies>,
}

/// Whether Python workflow code nodes are enabled. Defaults to ON; set
/// WORKFLOW_PY_CODE_ENABLED to false/0/no/off to disable (unset/empty = enabled).
pub fn py_enabled() -> bool {
    match std::env::var("WORKFLOW_PY_CODE_ENABLED")
        .ok()
        .as_deref()
        .map(str::trim)
        .map(|value| value.to_ascii_lowercase())
    {
        Some(value) if !value.is_empty() => !matches!(value.as_str(), "false" | "0" | "no" | "off"),
        _ => true,
    }
}

/// Default execution deadline for Python workflow code nodes.
pub fn py_timeout_ms() -> u64 {
    std::env::var("WORKFLOW_PY_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .filter(|value: &u64| *value > 0)
        .unwrap_or(30_000)
}

/// Execute user-supplied Python and return its final `ctx.body` plus logs.
pub async fn execute_python(req: PyExecRequest) -> Result<CodeExecOutput, CodeExecError> {
    if !py_enabled() {
        return Err(
            "Python workflow code nodes are disabled（Python 工作流代码节点已禁用）；set WORKFLOW_PY_CODE_ENABLED=true to enable them"
                .to_string()
                .into(),
        );
    }

    let python = resolve_python()?;
    let site_packages = if let Some(deps) = req.py_dependencies.as_ref() {
        let status = py_deps::ensure_python_deps(req.workflow_id, deps).await?;
        use crate::js_deps::DepsStatusKind;
        if status.status == DepsStatusKind::Failed {
            return Err(format!(
                "Python dependencies are not ready: {}",
                status
                    .error
                    .unwrap_or_else(|| "pip install failed".to_string())
            )
            .into());
        }
        if status.status == DepsStatusKind::Installing {
            return Err("Python dependencies are still installing"
                .to_string()
                .into());
        }
        let dir = py_deps::site_packages_dir(req.workflow_id);
        dir.is_dir().then_some(dir)
    } else {
        None
    };

    let temp_dir = execution_dir()?;
    let result = execute_in_dir(&python, &req, site_packages.as_deref(), &temp_dir).await;
    std::fs::remove_dir_all(&temp_dir).ok();
    result
}

async fn execute_in_dir(
    python: &Path,
    req: &PyExecRequest,
    site_packages: Option<&Path>,
    temp_dir: &Path,
) -> Result<CodeExecOutput, CodeExecError> {
    let ctx_path = temp_dir.join("ctx.json");
    let user_path = temp_dir.join("user.py");
    let entry_path = temp_dir.join("entry.py");
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
        py_timeout_ms()
    } else {
        req.timeout_ms
    };
    let run_result = run_python(
        python,
        &entry_path,
        temp_dir,
        site_packages,
        &socket_path,
        timeout_ms,
    )
    .await;
    bridge.shutdown().await;

    match run_result {
        Ok(()) => {
            let raw = tokio::fs::read_to_string(&result_path)
                .await
                .map_err(|error| format!("Python execution did not write result.json: {error}"))?;
            let result: Value = serde_json::from_str(&raw)
                .map_err(|error| format!("invalid Python result.json: {error}"))?;
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
    req: &PyExecRequest,
    ctx_path: &Path,
    user_path: &Path,
    entry_path: &Path,
) -> Result<(), String> {
    let ctx = serde_json::to_vec(&req.plugin_ctx)
        .map_err(|error| format!("serialize Python context: {error}"))?;
    std::fs::write(ctx_path, ctx).map_err(|error| format!("write ctx.json: {error}"))?;
    std::fs::write(user_path, &req.code).map_err(|error| format!("write user.py: {error}"))?;
    std::fs::write(entry_path, ENTRY_PY).map_err(|error| format!("write entry.py: {error}"))
}

fn python_path_value(runtime_dir: &Path, site_packages: Option<&Path>) -> Result<String, String> {
    let runtime = runtime_dir
        .to_str()
        .ok_or("runtime path is not UTF-8")?
        .to_string();
    match site_packages {
        Some(dir) => Ok(format!(
            "{}:{}",
            dir.to_str().ok_or("site-packages path is not UTF-8")?,
            runtime
        )),
        None => Ok(runtime),
    }
}

async fn run_python(
    python: &Path,
    entry_path: &Path,
    temp_dir: &Path,
    site_packages: Option<&Path>,
    socket_path: &Path,
    timeout_ms: u64,
) -> Result<(), String> {
    let runtime_dir = runtime_dir()?;
    let python_path = python_path_value(&runtime_dir, site_packages)?;
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
        command.args([
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--chdir",
            temp_dir.to_str().ok_or("working directory is not UTF-8")?,
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
            "PYTHONPATH",
            &python_path,
            "--setenv",
            "PYTHONDONTWRITEBYTECODE",
            "1",
        ]);
        command.arg(python).arg("-s").arg(entry_path);
        command.env_clear();
        command
    } else {
        let mut command = tokio::process::Command::new(python);
        command
            .arg("-s")
            .arg(entry_path)
            .current_dir(temp_dir)
            .env_clear()
            .env("PATH", SAFE_PATH)
            .env("HOME", temp_dir)
            .env("ONEBASE_HOST_SOCK", socket_path)
            .env("PYTHONPATH", &python_path)
            .env("PYTHONDONTWRITEBYTECODE", "1");
        command
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let output = tokio::time::timeout(Duration::from_millis(timeout_ms), command.output())
        .await
        .map_err(|_| format!("Python execution timed out after {timeout_ms}ms"))?
        .map_err(|error| format!("spawn Python process: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("Python process exited with status {}", output.status)
        } else {
            format!(
                "Python process exited with status {}: {stderr}",
                output.status
            )
        })
    }
}

fn resolve_python() -> Result<PathBuf, String> {
    let configured = std::env::var("WORKFLOW_PYTHON_BIN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "python3".to_string());
    let binary = if configured.contains('/') {
        PathBuf::from(configured)
    } else {
        find_in_path(&configured).ok_or_else(|| {
            "Python binary not found; install python3 or set WORKFLOW_PYTHON_BIN".to_string()
        })?
    };
    let output = std::process::Command::new(&binary)
        .arg("--version")
        .output()
        .map_err(|error| format!("Python binary is not usable ({binary:?}): {error}"))?;
    if output.status.success() {
        Ok(binary)
    } else {
        Err(format!(
            "Python binary is not usable ({binary:?}): {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn runtime_dir() -> Result<PathBuf, String> {
    // Prefer an explicit dir (deployed images set WORKFLOW_PY_RUNTIME because the
    // compile-time CARGO_MANIFEST_DIR does not exist in the runtime container).
    if let Ok(configured) = std::env::var("WORKFLOW_PY_RUNTIME") {
        let configured = configured.trim();
        if !configured.is_empty() {
            let dir = PathBuf::from(configured);
            return dir
                .join("onebase_host.py")
                .is_file()
                .then_some(dir)
                .ok_or_else(|| {
                    format!("WORKFLOW_PY_RUNTIME 目录缺少 onebase_host.py: {configured}")
                });
        }
    }
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("py-runtime")
        .join("onebase_runtime");
    if dir.join("onebase_host.py").is_file() {
        Ok(dir)
    } else {
        Err("PlaneOS Python runtime onebase_host.py is missing".to_string())
    }
}

fn execution_dir() -> Result<PathBuf, String> {
    // Unix-domain socket paths are short (about 104 bytes on macOS). Keep the
    // per-run directory directly under /tmp where this module's bridge socket lives.
    let path = PathBuf::from("/tmp").join(format!("ctr-py-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&path).map_err(|error| format!("create Python temp dir: {error}"))?;
    Ok(path)
}

fn sandbox_uses_bwrap() -> bool {
    !matches!(
        std::env::var("WORKFLOW_PY_SANDBOX")
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

/// Serializes tests that mutate `WORKFLOW_PY_*` process env vars. Shared with
/// the `workflow_engine` dispatch test so they never race on the same globals.
#[cfg(test)]
pub(crate) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

const ENTRY_PY: &str = r#"import builtins as _builtins
import json as _json
import os as _os
import sys as _sys
from types import SimpleNamespace as _SimpleNamespace

import onebase_host as _host

_dir = _os.path.dirname(_os.path.abspath(__file__))
_logs = []

def _push(level, *args):
    _logs.append({"level": level, "message": " ".join(str(a) for a in args)})

_orig_print = _builtins.print

def _print(*args, **kwargs):
    _push("info", *args)

def _flush(body):
    with open(_os.path.join(_dir, "result.json"), "w", encoding="utf-8") as _f:
        _json.dump({"body": body, "logs": _logs}, _f)

_orig_log = {
    "info": _host.log.info,
    "warn": _host.log.warn,
    "error": _host.log.error,
    "debug": _host.log.debug,
}

def _wrap_log(level):
    orig = _orig_log[level]
    def _fn(message, *rest):
        _push(level, message, *rest)
        return orig(message)
    return _fn

_host.log.info = _wrap_log("info")
_host.log.warn = _wrap_log("warn")
_host.log.error = _wrap_log("error")
_host.log.debug = _wrap_log("debug")
_builtins.print = _print

with open(_os.path.join(_dir, "ctx.json"), "r", encoding="utf-8") as _f:
    _ctx_data = _json.load(_f)
if "body" not in _ctx_data:
    _ctx_data["body"] = None
if "nodes" not in _ctx_data:
    _ctx_data["nodes"] = None
ctx = _SimpleNamespace(**_ctx_data)

with open(_os.path.join(_dir, "user.py"), "r", encoding="utf-8") as _f:
    _source = _f.read()

_user_globals = {
    "ctx": ctx,
    "env": _host.env,
    "cred": _host.cred,
    "http": _host.http,
    "crypto": _host.crypto,
    "log": _host.log,
    "json": _host.json,
    "time": _host.time,
    "sse": _host.sse,
    "google": _host.google,
    "print": _print,
}

try:
    exec(compile(_source, "user.py", "exec"), _user_globals)
    _execute = _user_globals.get("execute")
    if callable(_execute):
        _returned = _execute(ctx)
        if _returned is not None:
            ctx.body = _returned
    _flush(getattr(ctx, "body", None))
except Exception:
    import traceback
    _flush(getattr(ctx, "body", None))
    _builtins.print = _orig_print
    traceback.print_exc()
    _sys.exit(1)
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

    fn request(code: &str) -> PyExecRequest {
        PyExecRequest {
            workflow_id: 1,
            code: code.to_string(),
            plugin_ctx: plugin_ctx(json!({"x": 7})),
            env_vars: HashMap::new(),
            credentials: crate::workflow_credentials::CredentialStore::default(),
            tenant_id: None,
            http_disabled: false,
            timeout_ms: 5_000,
            py_dependencies: None,
        }
    }

    #[tokio::test]
    async fn execute_rejects_when_python_is_disabled() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("WORKFLOW_PY_CODE_ENABLED", "false");

        let error = execute_python(request("ctx.body = {'ok': True}"))
            .await
            .expect_err("disabled Python code nodes must be rejected");

        std::env::remove_var("WORKFLOW_PY_CODE_ENABLED");
        assert!(
            error.message.contains("disabled") || error.message.contains("禁用"),
            "unexpected error: {}",
            error.message
        );
    }

    #[tokio::test]
    async fn execute_round_trips_modified_context_body() {
        let _guard = ENV_LOCK.lock().unwrap();
        if std::process::Command::new("python3")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        std::env::set_var("WORKFLOW_PY_CODE_ENABLED", "true");
        std::env::set_var("WORKFLOW_PY_SANDBOX", "direct");

        let result = execute_python(request(
            "def execute(ctx):\n    n = (ctx.body or {}).get('x', 1)\n    return {'ok': True, 'n': n}\n",
        ))
        .await
        .expect("Python should execute");

        std::env::remove_var("WORKFLOW_PY_CODE_ENABLED");
        std::env::remove_var("WORKFLOW_PY_SANDBOX");
        assert_eq!(result.body, json!({"ok": true, "n": 7}));
    }

    #[test]
    fn runtime_dir_prefers_env_override() {
        let _guard = ENV_LOCK.lock().unwrap();
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("py-runtime")
            .join("onebase_runtime");
        std::env::set_var("WORKFLOW_PY_RUNTIME", &dir);
        assert_eq!(runtime_dir().unwrap(), dir);
        std::env::set_var("WORKFLOW_PY_RUNTIME", "/nonexistent/py-runtime-xyz");
        assert!(runtime_dir().is_err());
        std::env::remove_var("WORKFLOW_PY_RUNTIME");
    }

    #[tokio::test]
    #[ignore = "network: installs a real pip package from PyPI"]
    async fn execute_installs_and_imports_pip_dependency() {
        let _guard = ENV_LOCK.lock().unwrap();
        if std::process::Command::new("python3")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let deps_dir = std::path::PathBuf::from("/tmp")
            .join(format!("ctr-py-deps-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&deps_dir).unwrap();
        std::env::set_var("WORKFLOW_DEPS_DIR", &deps_dir);
        std::env::set_var("WORKFLOW_PY_CODE_ENABLED", "true");
        std::env::set_var("WORKFLOW_PY_SANDBOX", "direct");

        let mut req =
            request("import six\n\ndef execute(ctx):\n    return { 'six': six.__version__ }\n");
        req.py_dependencies = Some(PyDependencies {
            requirements: "six==1.17.0".to_string(),
        });

        let result = execute_python(req).await;

        std::env::remove_var("WORKFLOW_DEPS_DIR");
        std::env::remove_var("WORKFLOW_PY_CODE_ENABLED");
        std::env::remove_var("WORKFLOW_PY_SANDBOX");
        std::fs::remove_dir_all(&deps_dir).ok();

        let result = result.expect("Python should install and import the pip dependency");
        assert_eq!(result.body, json!({"six": "1.17.0"}));
    }

    #[tokio::test]
    async fn execute_reads_injected_env_through_host_bridge() {
        let _guard = ENV_LOCK.lock().unwrap();
        if std::process::Command::new("python3")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        std::env::set_var("WORKFLOW_PY_CODE_ENABLED", "true");
        std::env::set_var("WORKFLOW_PY_SANDBOX", "direct");

        let mut req = request("def execute(ctx):\n    return { 'token': env.get('API_TOKEN') }\n");
        req.env_vars
            .insert("API_TOKEN".to_string(), "secret-123".to_string());

        let result = execute_python(req)
            .await
            .expect("Python should read env via host bridge");

        std::env::remove_var("WORKFLOW_PY_CODE_ENABLED");
        std::env::remove_var("WORKFLOW_PY_SANDBOX");
        assert_eq!(result.body, json!({"token": "secret-123"}));
    }

    #[tokio::test]
    async fn execute_reads_injected_cred_through_host_bridge() {
        let _guard = ENV_LOCK.lock().unwrap();
        if std::process::Command::new("python3")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        std::env::set_var("WORKFLOW_PY_CODE_ENABLED", "true");
        std::env::set_var("WORKFLOW_PY_SANDBOX", "direct");

        let mut req =
            request("def execute(ctx):\n    return { 'token': cred.get('crm', 'token') }\n");
        req.credentials
            .insert(crate::workflow_credentials::CredentialFields {
                id: 1,
                name: "crm".into(),
                kind: "bearer".into(),
                username: None,
                header_name: None,
                secret: Some("tok_abc".into()),
            });

        let result = execute_python(req)
            .await
            .expect("Python should read cred via host bridge");

        std::env::remove_var("WORKFLOW_PY_CODE_ENABLED");
        std::env::remove_var("WORKFLOW_PY_SANDBOX");
        assert_eq!(result.body, json!({"token": "tok_abc"}));
    }

    #[tokio::test]
    async fn execute_collects_print_and_log_and_survives_throw() {
        let _guard = ENV_LOCK.lock().unwrap();
        if std::process::Command::new("python3")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        std::env::set_var("WORKFLOW_PY_CODE_ENABLED", "true");
        std::env::set_var("WORKFLOW_PY_SANDBOX", "direct");
        let ok = execute_python(request(
            r#"
print("hello", 1)
log.error("e")
ctx.body = {"ok": True}
"#,
        ))
        .await
        .expect("py ok");
        std::env::remove_var("WORKFLOW_PY_CODE_ENABLED");
        std::env::remove_var("WORKFLOW_PY_SANDBOX");
        assert_eq!(ok.body, json!({"ok": true}));
        assert!(ok
            .logs
            .iter()
            .any(|l| l.level == crate::workflow_logs::NodeLogLevel::Info
                && l.message.contains("hello")));
        assert!(ok
            .logs
            .iter()
            .any(|l| l.level == crate::workflow_logs::NodeLogLevel::Error && l.message == "e"));

        std::env::set_var("WORKFLOW_PY_CODE_ENABLED", "true");
        std::env::set_var("WORKFLOW_PY_SANDBOX", "direct");
        let err = execute_python(request(
            r#"
print("before")
raise RuntimeError("boom")
"#,
        ))
        .await
        .expect_err("must fail");
        std::env::remove_var("WORKFLOW_PY_CODE_ENABLED");
        std::env::remove_var("WORKFLOW_PY_SANDBOX");
        assert!(err.message.to_lowercase().contains("boom") || err.message.contains("Error"));
        assert!(err.logs.iter().any(|l| l.message.contains("before")));
    }
}
