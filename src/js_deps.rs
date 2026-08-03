//! Per-workflow JavaScript npm dependency install, hash, and status tracking.
//!
//! Disk layout under `deps_root()`:
//!   `{workflow_id}/javascript/package.json`
//!   `{workflow_id}/javascript/package-lock.json` (optional)
//!   `{workflow_id}/javascript/node_modules/`
//!   `{workflow_id}/javascript/.deps-hash`
//!   `{workflow_id}/javascript/.deps-status.json`

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;

const STATUS_FILE: &str = ".deps-status.json";
const HASH_FILE: &str = ".deps-hash";

#[derive(Debug, Clone, PartialEq)]
pub struct JsDependencies {
    pub package_json: Value,
    pub package_lock: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DepsStatusKind {
    Idle,
    Installing,
    Ready,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DepsStatus {
    pub status: DepsStatusKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
}

impl Default for DepsStatus {
    fn default() -> Self {
        Self {
            status: DepsStatusKind::Idle,
            error: None,
            hash: None,
        }
    }
}

static INSTALL_MUTEXES: OnceLock<Mutex<HashMap<i32, Arc<Mutex<()>>>>> = OnceLock::new();

/// Parse `dependencies.javascript` from a workflow `dependencies` JSON value.
pub fn parse_javascript_deps(dependencies: &Value) -> Option<JsDependencies> {
    let js = dependencies.get("javascript")?;
    let package_json = js.get("packageJson")?.clone();
    let package_lock = js
        .get("packageLock")
        .and_then(|v| {
            if v.is_null() {
                None
            } else {
                v.as_str().map(str::to_string)
            }
        });
    Some(JsDependencies {
        package_json,
        package_lock,
    })
}

/// Stable SHA-256 hex hash of canonical `package.json` JSON plus optional lockfile text.
pub fn content_hash(package_json: &Value, package_lock: Option<&str>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(canonical_json_string(package_json).as_bytes());
    hasher.update(b"\0");
    if let Some(lock) = package_lock {
        hasher.update(lock.as_bytes());
    }
    hex::encode(hasher.finalize())
}

/// Root directory for workflow JS deps. `WORKFLOW_DEPS_DIR` or `{cwd}/workflow_deps`.
pub fn deps_root() -> PathBuf {
    std::env::var("WORKFLOW_DEPS_DIR")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("workflow_deps")
        })
}

/// `{deps_root}/{workflow_id}/javascript/`
pub fn javascript_dir(workflow_id: i32) -> PathBuf {
    deps_root()
        .join(workflow_id.to_string())
        .join("javascript")
}

/// Read `.deps-status.json` for a workflow, or `Idle` when missing/unreadable.
pub fn read_status(workflow_id: i32) -> DepsStatus {
    let path = javascript_dir(workflow_id).join(STATUS_FILE);
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => DepsStatus::default(),
    }
}

/// Ensure npm dependencies are installed when declared; no-op for empty dependency sets.
pub async fn ensure_javascript_deps(
    workflow_id: i32,
    js: &JsDependencies,
) -> Result<DepsStatus, String> {
    if !has_installable_deps(&js.package_json) {
        return Ok(DepsStatus {
            status: DepsStatusKind::Idle,
            error: None,
            hash: None,
        });
    }

    let hash = content_hash(&js.package_json, js.package_lock.as_deref());
    let lock = install_lock(workflow_id).await;
    let _guard = lock.lock().await;

    if is_ready(workflow_id, &hash)? {
        return Ok(DepsStatus {
            status: DepsStatusKind::Ready,
            error: None,
            hash: Some(hash),
        });
    }

    let dir = javascript_dir(workflow_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create deps dir: {e}"))?;

    write_status(
        workflow_id,
        &DepsStatus {
            status: DepsStatusKind::Installing,
            error: None,
            hash: Some(hash.clone()),
        },
    )?;

    if let Err(err) = write_manifest(&dir, js) {
        let status = DepsStatus {
            status: DepsStatusKind::Failed,
            error: Some(err.clone()),
            hash: Some(hash.clone()),
        };
        write_status(workflow_id, &status).ok();
        return Ok(status);
    }

    match run_npm_install(&dir, js.package_lock.is_some()).await {
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

fn has_installable_deps(package_json: &Value) -> bool {
    fn object_len(value: Option<&Value>) -> usize {
        value
            .and_then(Value::as_object)
            .map(Map::len)
            .unwrap_or(0)
    }
    object_len(package_json.get("dependencies")) > 0
        || object_len(package_json.get("devDependencies")) > 0
}

fn is_ready(workflow_id: i32, hash: &str) -> Result<bool, String> {
    let dir = javascript_dir(workflow_id);
    let stored_hash = read_hash(workflow_id)?;
    let node_modules = dir.join("node_modules");
    Ok(stored_hash.as_deref() == Some(hash) && node_modules.is_dir())
}

async fn install_lock(workflow_id: i32) -> Arc<Mutex<()>> {
    let map = INSTALL_MUTEXES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().await;
    guard
        .entry(workflow_id)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn write_manifest(dir: &Path, js: &JsDependencies) -> Result<(), String> {
    let package_json = serde_json::to_string_pretty(&js.package_json)
        .map_err(|e| format!("serialize package.json: {e}"))?;
    std::fs::write(dir.join("package.json"), package_json)
        .map_err(|e| format!("write package.json: {e}"))?;
    if let Some(lock) = &js.package_lock {
        std::fs::write(dir.join("package-lock.json"), lock)
            .map_err(|e| format!("write package-lock.json: {e}"))?;
    } else if dir.join("package-lock.json").exists() {
        std::fs::remove_file(dir.join("package-lock.json"))
            .map_err(|e| format!("remove stale package-lock.json: {e}"))?;
    }
    Ok(())
}

fn write_status(workflow_id: i32, status: &DepsStatus) -> Result<(), String> {
    let dir = javascript_dir(workflow_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create deps dir: {e}"))?;
    let raw =
        serde_json::to_string_pretty(status).map_err(|e| format!("serialize status: {e}"))?;
    std::fs::write(dir.join(STATUS_FILE), raw).map_err(|e| format!("write status: {e}"))
}

fn write_hash(workflow_id: i32, hash: &str) -> Result<(), String> {
    let dir = javascript_dir(workflow_id);
    std::fs::write(dir.join(HASH_FILE), hash).map_err(|e| format!("write deps hash: {e}"))
}

fn read_hash(workflow_id: i32) -> Result<Option<String>, String> {
    let path = javascript_dir(workflow_id).join(HASH_FILE);
    match std::fs::read_to_string(&path) {
        Ok(raw) => Ok(Some(raw.trim().to_string())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read deps hash: {e}")),
    }
}

fn npm_install_timeout_ms() -> u64 {
    std::env::var("WORKFLOW_NPM_INSTALL_TIMEOUT_MS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(300_000)
}

fn npm_binary() -> String {
    std::env::var("WORKFLOW_NPM_BIN")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "npm".to_string())
}

fn resolve_npm() -> Result<String, String> {
    let npm = npm_binary();
    let output = std::process::Command::new(&npm)
        .arg("--version")
        .output()
        .map_err(|e| format!("npm not found ({npm}): {e}"))?;
    if output.status.success() {
        Ok(npm)
    } else {
        Err(format!(
            "npm not usable ({npm}): {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

async fn run_npm_install(dir: &Path, has_lock: bool) -> Result<(), String> {
    let npm = resolve_npm()?;
    let timeout_ms = npm_install_timeout_ms();

    let mut cmd = tokio::process::Command::new(&npm);
    cmd.current_dir(dir);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    if has_lock {
        cmd.args(["ci", "--omit=dev"]);
    } else {
        cmd.args(["install", "--omit=dev"]);
    }
    if let Ok(registry) = std::env::var("WORKFLOW_NPM_REGISTRY") {
        let registry = registry.trim();
        if !registry.is_empty() {
            cmd.args(["--registry", registry]);
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn npm ({npm}): {e}"))?;

    match tokio::time::timeout(
        std::time::Duration::from_millis(timeout_ms),
        child.wait(),
    )
    .await
    {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) => {
            let stderr = child.stderr.take();
            let detail = if let Some(mut stderr) = stderr {
                let mut buf = String::new();
                use tokio::io::AsyncReadExt;
                stderr.read_to_string(&mut buf).await.ok();
                buf
            } else {
                String::new()
            };
            Err(format!(
                "npm exited with status {}{}",
                status.code().unwrap_or(-1),
                if detail.trim().is_empty() {
                    String::new()
                } else {
                    format!(": {}", detail.trim())
                }
            ))
        }
        Ok(Err(e)) => Err(format!("npm failed: {e}")),
        Err(_) => {
            child.kill().await.ok();
            Err(format!("npm install timed out after {timeout_ms}ms"))
        }
    }
}

fn canonical_json_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string()),
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(canonical_json_string).collect();
            format!("[{}]", parts.join(","))
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()),
                        canonical_json_string(&map[*key])
                    )
                })
                .collect();
            format!("{{{}}}", parts.join(","))
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

    fn with_temp_deps_root<F: FnOnce(PathBuf)>(f: F) {
        let _guard = ENV_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!(
            "onebase_js_deps_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let _env = EnvOverride::set("WORKFLOW_DEPS_DIR", dir.to_str().unwrap());
        f(dir.clone());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn content_hash_is_stable_for_same_input() {
        let pkg = json!({
            "name": "workflow-1",
            "private": true,
            "dependencies": {
                "axios": "^1.7.0",
                "lodash": "^4.17.21"
            }
        });
        let lock = Some("{ \"lockfileVersion\": 3 }");
        let h1 = content_hash(&pkg, lock);
        let h2 = content_hash(&pkg, lock);
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
    }

    #[test]
    fn content_hash_changes_when_lock_changes() {
        let pkg = json!({"dependencies": {"axios": "^1.7.0"}});
        assert_ne!(
            content_hash(&pkg, Some("lock-a")),
            content_hash(&pkg, Some("lock-b"))
        );
    }

    #[test]
    fn parse_javascript_deps_extracts_package_json_and_lock() {
        let dependencies = json!({
            "javascript": {
                "packageJson": {
                    "name": "workflow-42",
                    "dependencies": { "axios": "^1.7.0" }
                },
                "packageLock": "{ \"lockfileVersion\": 3 }"
            }
        });
        let parsed = parse_javascript_deps(&dependencies).expect("javascript deps");
        assert_eq!(parsed.package_json["name"], "workflow-42");
        assert_eq!(
            parsed.package_lock.as_deref(),
            Some("{ \"lockfileVersion\": 3 }")
        );
    }

    #[test]
    fn parse_javascript_deps_missing_section_returns_none() {
        assert!(parse_javascript_deps(&json!({})).is_none());
        assert!(parse_javascript_deps(&json!({"javascript": {}})).is_none());
    }

    #[tokio::test]
    async fn ensure_empty_deps_is_idle_without_npm() {
        let _guard = ENV_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!(
            "onebase_js_deps_test_empty_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let _deps_dir = EnvOverride::set("WORKFLOW_DEPS_DIR", dir.to_str().unwrap());
        let _npm = EnvOverride::set("WORKFLOW_NPM_BIN", "/nonexistent/npm-for-test");

        let js = JsDependencies {
            package_json: json!({
                "name": "workflow-empty",
                "private": true,
                "dependencies": {}
            }),
            package_lock: None,
        };
        let status = ensure_javascript_deps(1001, &js).await.unwrap();
        assert_eq!(status.status, DepsStatusKind::Idle);
        assert!(!dir.join("1001/javascript/package.json").exists());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn ensure_missing_npm_returns_failed_when_install_required() {
        let _guard = ENV_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!(
            "onebase_js_deps_test_failed_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let _deps_dir = EnvOverride::set("WORKFLOW_DEPS_DIR", dir.to_str().unwrap());
        let _npm = EnvOverride::set("WORKFLOW_NPM_BIN", "/nonexistent/npm-for-test");

        let js = JsDependencies {
            package_json: json!({
                "name": "workflow-needs-deps",
                "private": true,
                "dependencies": { "axios": "^1.7.0" }
            }),
            package_lock: None,
        };
        let status = ensure_javascript_deps(1002, &js).await.unwrap();
        assert_eq!(status.status, DepsStatusKind::Failed);
        assert!(
            status
                .error
                .as_deref()
                .unwrap_or("")
                .contains("npm not found"),
            "unexpected error: {:?}",
            status.error
        );
        assert!(dir.join("1002/javascript/package.json").exists());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_status_defaults_to_idle_when_missing() {
        with_temp_deps_root(|_| {
            let status = read_status(4242);
            assert_eq!(status, DepsStatus::default());
        });
    }
}
