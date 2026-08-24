//! Per-workflow Python pip dependency install, hash, and status tracking.
//!
//! Disk layout under `crate::js_deps::deps_root()`:
//!   `{workflow_id}/python/requirements.txt`
//!   `{workflow_id}/python/site-packages/`
//!   `{workflow_id}/python/.deps-hash`
//!   `{workflow_id}/python/.deps-status.json`
//!
//! Mirrors `js_deps` (npm) but installs into a per-workflow `site-packages`
//! directory via `pip install --target`, so multiple workflows never share
//! interpreter packages.

use crate::js_deps::{deps_root, DepsStatus, DepsStatusKind};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;

const STATUS_FILE: &str = ".deps-status.json";
const HASH_FILE: &str = ".deps-hash";
const SITE_PACKAGES: &str = "site-packages";

/// Parsed pip requirements for one workflow.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PyDependencies {
    /// Normalized `requirements.txt` text (one requirement per line).
    pub requirements: String,
}

static INSTALL_MUTEXES: OnceLock<Mutex<HashMap<i32, Arc<Mutex<()>>>>> = OnceLock::new();

/// Parse `dependencies.python` from a workflow `dependencies` JSON value.
///
/// Accepts either an array of requirement strings or a single multi-line
/// string under `requirements`. Returns `None` when no requirements exist.
pub fn parse_python_deps(dependencies: &Value) -> Option<PyDependencies> {
    let python = dependencies.get("python")?;
    let requirements = python.get("requirements")?;
    let normalized = match requirements {
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item.as_str())
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::String(text) => text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    if normalized.is_empty() {
        return None;
    }
    Some(PyDependencies {
        requirements: normalized,
    })
}

/// Stable SHA-256 hex hash of the normalized requirements text.
pub fn content_hash(requirements: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(requirements.as_bytes());
    hex::encode(hasher.finalize())
}

/// `{deps_root}/{workflow_id}/python/`
pub fn python_dir(workflow_id: i32) -> PathBuf {
    deps_root().join(workflow_id.to_string()).join("python")
}

/// `{deps_root}/{workflow_id}/python/site-packages/`
pub fn site_packages_dir(workflow_id: i32) -> PathBuf {
    python_dir(workflow_id).join(SITE_PACKAGES)
}

/// Read `.deps-status.json` for a workflow, or `Idle` when missing/unreadable.
pub fn read_status(workflow_id: i32) -> DepsStatus {
    let path = python_dir(workflow_id).join(STATUS_FILE);
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => DepsStatus::default(),
    }
}

/// Ensure pip dependencies are installed when declared; no-op for empty sets.
pub async fn ensure_python_deps(
    workflow_id: i32,
    py: &PyDependencies,
) -> Result<DepsStatus, String> {
    if py.requirements.trim().is_empty() {
        return Ok(DepsStatus {
            status: DepsStatusKind::Idle,
            error: None,
            hash: None,
        });
    }

    let hash = content_hash(&py.requirements);
    let lock = install_lock(workflow_id).await;
    let _guard = lock.lock().await;

    if is_ready(workflow_id, &hash)? {
        return Ok(DepsStatus {
            status: DepsStatusKind::Ready,
            error: None,
            hash: Some(hash),
        });
    }

    let dir = python_dir(workflow_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create deps dir: {e}"))?;

    write_status(
        workflow_id,
        &DepsStatus {
            status: DepsStatusKind::Installing,
            error: None,
            hash: Some(hash.clone()),
        },
    )?;

    if let Err(err) = write_manifest(&dir, py) {
        let status = DepsStatus {
            status: DepsStatusKind::Failed,
            error: Some(err),
            hash: Some(hash),
        };
        write_status(workflow_id, &status).ok();
        return Ok(status);
    }

    match run_pip_install(&dir).await {
        Ok(()) => {
            write_hash(workflow_id, &hash)?;
            let status = DepsStatus {
                status: DepsStatusKind::Ready,
                error: None,
                hash: Some(hash),
            };
            write_status(workflow_id, &status)?;
            Ok(status)
        }
        Err(err) => {
            let status = DepsStatus {
                status: DepsStatusKind::Failed,
                error: Some(err),
                hash: Some(hash),
            };
            write_status(workflow_id, &status)?;
            Ok(status)
        }
    }
}

fn is_ready(workflow_id: i32, hash: &str) -> Result<bool, String> {
    let stored_hash = read_hash(workflow_id)?;
    let site_packages = site_packages_dir(workflow_id);
    Ok(stored_hash.as_deref() == Some(hash) && site_packages.is_dir())
}

async fn install_lock(workflow_id: i32) -> Arc<Mutex<()>> {
    let map = INSTALL_MUTEXES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().await;
    guard
        .entry(workflow_id)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn write_manifest(dir: &Path, py: &PyDependencies) -> Result<(), String> {
    let mut requirements = py.requirements.clone();
    if !requirements.ends_with('\n') {
        requirements.push('\n');
    }
    std::fs::write(dir.join("requirements.txt"), requirements)
        .map_err(|e| format!("write requirements.txt: {e}"))
}

fn write_status(workflow_id: i32, status: &DepsStatus) -> Result<(), String> {
    let dir = python_dir(workflow_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create deps dir: {e}"))?;
    let raw = serde_json::to_string_pretty(status).map_err(|e| format!("serialize status: {e}"))?;
    std::fs::write(dir.join(STATUS_FILE), raw).map_err(|e| format!("write status: {e}"))
}

fn write_hash(workflow_id: i32, hash: &str) -> Result<(), String> {
    let dir = python_dir(workflow_id);
    std::fs::write(dir.join(HASH_FILE), hash).map_err(|e| format!("write deps hash: {e}"))
}

fn read_hash(workflow_id: i32) -> Result<Option<String>, String> {
    let path = python_dir(workflow_id).join(HASH_FILE);
    match std::fs::read_to_string(&path) {
        Ok(raw) => Ok(Some(raw.trim().to_string())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read deps hash: {e}")),
    }
}

fn pip_install_timeout_ms() -> u64 {
    std::env::var("WORKFLOW_PIP_INSTALL_TIMEOUT_MS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(300_000)
}

fn python_binary() -> String {
    std::env::var("WORKFLOW_PYTHON_BIN")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "python3".to_string())
}

fn verify_usable(bin: &str, args: &[&str]) -> Result<(), String> {
    let output = std::process::Command::new(bin)
        .args(args)
        .output()
        .map_err(|e| format!("pip not found ({bin}): {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "pip not usable ({bin}): {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

/// The pip invocation to use: `(program, leading_args)` ending in `install`.
///
/// Prefer an explicit `WORKFLOW_PIP_BIN`; otherwise run pip through the same
/// interpreter used for execution (`python -m pip`) so installs and imports
/// share one interpreter/ABI (avoids pip3-vs-python3 mismatch).
fn pip_command() -> Result<(String, Vec<String>), String> {
    if let Ok(pip) = std::env::var("WORKFLOW_PIP_BIN") {
        let pip = pip.trim().to_string();
        if !pip.is_empty() {
            verify_usable(&pip, &["--version"])?;
            return Ok((pip, vec!["install".to_string()]));
        }
    }
    let python = python_binary();
    verify_usable(&python, &["-m", "pip", "--version"])?;
    Ok((
        python,
        vec!["-m".to_string(), "pip".to_string(), "install".to_string()],
    ))
}

async fn run_pip_install(dir: &Path) -> Result<(), String> {
    let (program, mut args) = pip_command()?;
    let timeout_ms = pip_install_timeout_ms();
    let target = dir.join(SITE_PACKAGES);

    // Reinstall into a clean target so removed requirements do not linger.
    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(|e| format!("clean site-packages: {e}"))?;
    }
    std::fs::create_dir_all(&target).map_err(|e| format!("create site-packages: {e}"))?;

    args.push("--no-input".to_string());
    args.push("--disable-pip-version-check".to_string());
    // Debian/Ubuntu system Python is marked EXTERNALLY-MANAGED (PEP 668); pip
    // refuses to install even with --target unless this flag is present.
    args.push("--break-system-packages".to_string());
    args.push("--target".to_string());
    args.push(target.to_string_lossy().into_owned());
    args.push("-r".to_string());
    args.push("requirements.txt".to_string());
    if let Ok(index_url) = std::env::var("WORKFLOW_PIP_INDEX_URL") {
        let index_url = index_url.trim();
        if !index_url.is_empty() {
            args.push("--index-url".to_string());
            args.push(index_url.to_string());
        }
    }

    let mut cmd = tokio::process::Command::new(&program);
    cmd.current_dir(dir);
    cmd.args(&args);
    // pip is far more verbose than npm; discard stdout and drain stderr
    // concurrently so a full pipe buffer can never deadlock the child.
    cmd.stdout(Stdio::null()).stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn pip ({program}): {e}"))?;

    let stderr = child.stderr.take();
    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        if let Some(mut stderr) = stderr {
            use tokio::io::AsyncReadExt;
            stderr.read_to_string(&mut buf).await.ok();
        }
        buf
    });

    match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), child.wait()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) => {
            let detail = stderr_task.await.unwrap_or_default();
            Err(format!(
                "pip exited with status {}{}",
                status.code().unwrap_or(-1),
                if detail.trim().is_empty() {
                    String::new()
                } else {
                    format!(": {}", detail.trim())
                }
            ))
        }
        Ok(Err(e)) => Err(format!("pip failed: {e}")),
        Err(_) => {
            child.kill().await.ok();
            Err(format!("pip install timed out after {timeout_ms}ms"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex as StdMutex;

    static ENV_LOCK: StdMutex<()> = StdMutex::new(());

    struct EnvOverride {
        key: &'static str,
        prev: Option<String>,
    }

    impl EnvOverride {
        fn set(key: &'static str, value: &str) -> Self {
            let prev = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, prev }
        }
    }

    impl Drop for EnvOverride {
        fn drop(&mut self) {
            match &self.prev {
                Some(v) => std::env::set_var(self.key, v),
                None => std::env::remove_var(self.key),
            }
        }
    }

    #[test]
    fn content_hash_is_stable_for_same_input() {
        let reqs = "requests==2.31.0\nnumpy>=1.24";
        let h1 = content_hash(reqs);
        let h2 = content_hash(reqs);
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
    }

    #[test]
    fn content_hash_changes_when_requirements_change() {
        assert_ne!(
            content_hash("requests==2.31.0"),
            content_hash("requests==2.32.0")
        );
    }

    #[test]
    fn parse_python_deps_accepts_array() {
        let dependencies = json!({
            "python": { "requirements": ["requests==2.31.0", " numpy>=1.24 ", ""] }
        });
        let parsed = parse_python_deps(&dependencies).expect("python deps");
        assert_eq!(parsed.requirements, "requests==2.31.0\nnumpy>=1.24");
    }

    #[test]
    fn parse_python_deps_accepts_string() {
        let dependencies = json!({
            "python": { "requirements": "requests==2.31.0\n\n  numpy>=1.24  \n" }
        });
        let parsed = parse_python_deps(&dependencies).expect("python deps");
        assert_eq!(parsed.requirements, "requests==2.31.0\nnumpy>=1.24");
    }

    #[test]
    fn parse_python_deps_missing_or_empty_returns_none() {
        assert!(parse_python_deps(&json!({})).is_none());
        assert!(parse_python_deps(&json!({"python": {}})).is_none());
        assert!(parse_python_deps(&json!({"python": {"requirements": []}})).is_none());
        assert!(parse_python_deps(&json!({"python": {"requirements": "\n  \n"}})).is_none());
    }

    #[tokio::test]
    async fn ensure_empty_deps_is_idle_without_pip() {
        let _guard = ENV_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!(
            "onebase_py_deps_test_empty_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let _deps_dir = EnvOverride::set("WORKFLOW_DEPS_DIR", dir.to_str().unwrap());
        let _pip = EnvOverride::set("WORKFLOW_PIP_BIN", "/nonexistent/pip-for-test");

        let py = PyDependencies {
            requirements: "   \n".to_string(),
        };
        let status = ensure_python_deps(2001, &py).await.unwrap();
        assert_eq!(status.status, DepsStatusKind::Idle);
        assert!(!dir.join("2001/python/requirements.txt").exists());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn ensure_missing_pip_returns_failed_when_install_required() {
        let _guard = ENV_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!(
            "onebase_py_deps_test_failed_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let _deps_dir = EnvOverride::set("WORKFLOW_DEPS_DIR", dir.to_str().unwrap());
        let _pip = EnvOverride::set("WORKFLOW_PIP_BIN", "/nonexistent/pip-for-test");

        let py = PyDependencies {
            requirements: "requests==2.31.0".to_string(),
        };
        let status = ensure_python_deps(2002, &py).await.unwrap();
        assert_eq!(status.status, DepsStatusKind::Failed);
        assert!(
            status
                .error
                .as_deref()
                .unwrap_or("")
                .contains("pip not found"),
            "unexpected error: {:?}",
            status.error
        );
        assert!(dir.join("2002/python/requirements.txt").exists());

        std::fs::remove_dir_all(&dir).ok();
    }
}
