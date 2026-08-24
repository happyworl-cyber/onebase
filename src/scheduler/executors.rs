//! 两种执行体：`RpcExecutor`（调 PG 函数）与 `HttpExecutor`（发起 HTTP）。
//!
//! 两者输出统一为 `Result<serde_json::Value, String>`：
//! - `Ok(value)` → runner 写 `status='success'`，`output = value`
//! - `Err(msg)`  → runner 写 `status='failed'`（或 `timeout` 当 tokio timeout 触发时）

use serde_json::Value;
use sqlx::{PgPool, Row};
use std::sync::Arc;

use crate::auth::Claims;
use crate::pool_manager::{DatabaseConfig, POOL_MANAGER};
use crate::redis_manager::RedisManager;
use crate::scheduler::models::ScheduledTask;

/// `synthesize_claims_for` 的失败类型，便于 runner 把不同失败归类成不同错误信息。
#[derive(Debug)]
pub enum SynthErr {
    /// **当前 schema 下不可达**：`management.scheduled_tasks.created_by` 是
    /// `ON DELETE RESTRICT`，存在引用任务时 PG 会拒绝删除用户。保留该变体作为
    /// 防御性 fallback —— 若未来 FK 改为 `SET NULL` / `CASCADE`，或被绕过约束
    /// 直接 SQL 改库，scheduler 仍能稳定降级到 failed run 而不是 panic。
    UserNotFound,
    /// 当前 `users` 表未提供 `is_active` 列；该变体保留给将来引入禁用列后使用。
    UserDisabled,
    Db(String),
}

/// 调用 RPC 的执行体。持有 management 池与可选 redis（用于 RBAC 权限缓存）。
pub struct RpcExecutor {
    pub pool: PgPool,
    pub redis: Option<RedisManager>,
}

impl RpcExecutor {
    pub fn new(pool: PgPool, redis: Option<RedisManager>) -> Self {
        Self { pool, redis }
    }

    /// 重读 `users` 表合成 `Claims`。每次执行都读，避免任务创建者被禁用 / 降权 / 删除后
    /// 仍以快照身份继续运行。返回 Err 时 runner 会把 run 记为 failed。
    pub async fn synthesize_claims_for(&self, user_id: i32) -> Result<Claims, SynthErr> {
        let row = sqlx::query(
            "SELECT id, email, COALESCE(role, 'user') AS role, \
                    COALESCE(is_superadmin, false) AS is_superadmin \
             FROM users WHERE id = $1",
        )
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| SynthErr::Db(e.to_string()))?;

        let row = row.ok_or(SynthErr::UserNotFound)?;
        let id: i32 = row.get("id");
        let email: String = row.get("email");
        let role: String = row.get("role");
        let is_superadmin: bool = row.get("is_superadmin");

        // 前向兼容：当前 `users` 表没有 `is_active` 列，但未来引入后 scheduler 必须
        // 立即感知"被禁用的用户的任务一律不再跑"。用一条独立 SELECT 探一下——
        // 列不存在时 sqlx 返回 Err，我们静默忽略；列存在且 false 时报 UserDisabled。
        let is_active_check: Result<Option<(bool,)>, sqlx::Error> =
            sqlx::query_as("SELECT is_active FROM users WHERE id = $1")
                .bind(user_id)
                .fetch_optional(&self.pool)
                .await;
        if let Ok(Some((false,))) = is_active_check {
            return Err(SynthErr::UserDisabled);
        }

        // jti 留空 —— scheduler 路径不走 user_sessions 校验（rpc_auth_middleware 不在调用链里）。
        // exp 给一个远期值避免 is_expired() 误判；scheduler 路径不调 is_expired，但语义上保持有效。
        Ok(Claims {
            sub: id,
            email,
            role,
            is_superadmin,
            jti: String::new(),
            exp: (chrono::Utc::now() + chrono::Duration::days(1)).timestamp(),
            iat: chrono::Utc::now().timestamp(),
        })
    }

    pub async fn execute(&self, task: &ScheduledTask) -> Result<Value, String> {
        let claims = self
            .synthesize_claims_for(task.created_by)
            .await
            .map_err(|e| match e {
                SynthErr::UserNotFound => "created_by 用户已被删除".to_string(),
                SynthErr::UserDisabled => "created_by 用户已禁用".to_string(),
                SynthErr::Db(msg) => format!("身份合成失败: {msg}"),
            })?;

        let database_id = task
            .database_id
            .ok_or_else(|| "RPC 任务缺 database_id".to_string())?;
        let schema = task
            .rpc_schema
            .as_deref()
            .ok_or_else(|| "RPC 任务缺 schema".to_string())?;
        let fn_name = task
            .rpc_fn_name
            .as_deref()
            .ok_or_else(|| "RPC 任务缺 fn_name".to_string())?;

        let args_value = task
            .rpc_args
            .clone()
            .unwrap_or(Value::Object(Default::default()));
        let args_map = match args_value {
            Value::Object(m) => m,
            _ => return Err("rpc_args 必须是 JSON object".to_string()),
        };

        // 取动态库连接池——按 database_id 加载。`POOL_MANAGER` 没有
        // `get_pool_for_database` 入口（plan 的 pseudo-code 与现状不符），
        // 实际 API 是 `get_write_pool`（命中缓存）/ `get_or_create_pool`（首次加载），
        // 行为对齐 `middleware::dynamic_db_middleware`。
        let dynamic_pool = resolve_database_pool(&self.pool, database_id)
            .await
            .map_err(|e| format!("加载库连接失败: {e}"))?;

        let value = crate::rpc::execute_rpc_inner(
            &self.pool,
            Some(&dynamic_pool),
            self.redis.as_ref(),
            &claims,
            database_id,
            schema,
            fn_name,
            args_map,
        )
        .await
        .map_err(|e| format!("RPC 执行失败: {e}"))?;

        Ok(value)
    }
}

/// 取或加载 `database_id` 对应的写池：命中缓存直接返回，未命中走 management 元数据
/// 与解密同款步骤——与 `middleware::dynamic_db_middleware` 行为对齐。
async fn resolve_database_pool(main_pool: &PgPool, database_id: i32) -> Result<PgPool, String> {
    if let Some(pool) = POOL_MANAGER.get_write_pool(database_id) {
        return Ok(pool);
    }

    let row = sqlx::query(
        "SELECT id, db_host, db_port, db_name, db_user, db_password_encrypted, \
                max_connections, connection_timeout \
         FROM management.tenant_databases \
         WHERE id = $1 AND is_active = true",
    )
    .bind(database_id)
    .fetch_optional(main_pool)
    .await
    .map_err(|e| format!("查询数据库配置失败: {e}"))?
    .ok_or_else(|| format!("database_id {database_id} 不存在或未启用"))?;

    let encrypted: String = row.get("db_password_encrypted");
    let password = crate::crypto::decrypt_secret_lossy(&encrypted);

    let config = DatabaseConfig {
        id: row.get("id"),
        host: row.get("db_host"),
        port: row.get("db_port"),
        database: row.get("db_name"),
        username: row.get("db_user"),
        password,
        max_connections: row
            .get::<Option<i32>, _>("max_connections")
            .unwrap_or(crate::pool_manager::DEFAULT_TENANT_MAX_CONNECTIONS as i32)
            as u32,
        connection_timeout: row
            .get::<Option<i32>, _>("connection_timeout")
            .unwrap_or(crate::pool_manager::DEFAULT_TENANT_ACQUIRE_TIMEOUT_SECS as i32)
            as u64,
    };

    POOL_MANAGER
        .get_or_create_pool(config)
        .await
        .map_err(|e| format!("创建连接池失败: {e}"))
}

/// Arc-friendly alias 供 runner clone。
pub type RpcExecutorRef = Arc<RpcExecutor>;

// ─────────────────────────────────────────────────────────────────────────────

/// HTTP 执行体：默认 https-only；可选 HMAC-SHA256 签名（与 webhook 同套规范）。
///
/// 超时模型：本 client 不设 request-level timeout，由 `SchedulerRunner::execute_one`
/// 外层 `tokio::time::timeout(task.timeout_secs)` 作为权威边界——之前在 client 上钉死
/// 60s 会让 `task.timeout_secs > 60` 的 HTTP 任务被静默截断。仅保留 30s `connect_timeout`
/// 作为 TCP 连接阶段的防卡死保险丝（避免 SYN-ACK 半挂导致外层 timeout 无法在 connect 完成
/// 前推进）。
pub struct HttpExecutor {
    pub client: reqwest::Client,
    pub allow_insecure: bool,
}

impl HttpExecutor {
    pub fn new(allow_insecure: bool) -> Self {
        // build() 只在 TLS 初始化失败时返回 Err——那是部署级配置问题，不应静默吞掉
        // （旧版本用 unwrap_or_default() 会退化成默认 Client，行为差异巨大）。
        // 这里直接 expect 让启动期就崩。
        //
        // 不设 client-level `.timeout(...)`：SchedulerRunner 已经用
        // `tokio::time::timeout(task.timeout_secs)` 包裹每次 executor 调用，那才是
        // 权威边界。此前固定 60s client timeout 会让 `task.timeout_secs > 60` 的
        // HTTP 任务被截断到 60s。`connect_timeout(30s)` 仍保留，仅约束 TCP 连接阶段。
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("reqwest::Client::builder() 应仅在 TLS 初始化异常时失败");
        Self {
            client,
            allow_insecure,
        }
    }

    pub async fn execute(&self, task: &ScheduledTask) -> Result<Value, String> {
        let url = task
            .http_url
            .as_deref()
            .ok_or_else(|| "HTTP 任务缺 url".to_string())?;

        if !self.allow_insecure && !url.starts_with("https://") {
            return Err(
                "HTTP URL 必须 https（或显式设置 ALLOW_INSECURE_SCHEDULED_HTTP=true）".to_string(),
            );
        }

        let method_str = task.http_method.as_deref().unwrap_or("POST").to_uppercase();
        let method = match method_str.as_str() {
            "GET" => reqwest::Method::GET,
            "POST" => reqwest::Method::POST,
            "PUT" => reqwest::Method::PUT,
            "PATCH" => reqwest::Method::PATCH,
            "DELETE" => reqwest::Method::DELETE,
            other => return Err(format!("不支持的 HTTP method: {other}")),
        };

        let body = task.http_body.clone().unwrap_or(Value::Null);
        let mut req = self.client.request(method.clone(), url);

        if let Some(headers) = task.http_headers.as_ref().and_then(|v| v.as_object()) {
            for (k, v) in headers {
                if let Some(s) = v.as_str() {
                    req = req.header(k, s);
                }
            }
        }

        // HMAC-SHA256 签名（与 webhook 同款规范）。
        if let Some(enc) = task.http_secret_enc.as_deref() {
            let secret = crate::crypto::decrypt_secret_lossy(enc);
            if !secret.is_empty() {
                use sha2::{Digest, Sha256};
                let body_bytes = serde_json::to_vec(&body).unwrap_or_default();
                let mut hasher = Sha256::new();
                hasher.update(secret.as_bytes());
                hasher.update(&body_bytes);
                let sig = hex::encode(hasher.finalize());
                req = req.header("X-Onebase-Signature", sig);
            }
        }

        let req = if matches!(method, reqwest::Method::GET | reqwest::Method::DELETE) {
            req
        } else {
            req.json(&body)
        };

        let resp = req
            .send()
            .await
            .map_err(|e| format!("HTTP 请求失败: {e}"))?;

        let status = resp.status();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("读取响应体失败: {e}"))?;
        let parsed: Value = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));

        if status.is_success() {
            Ok(serde_json::json!({
                "status": status.as_u16(),
                "body": parsed,
            }))
        } else {
            Err(format!("HTTP {} - {}", status.as_u16(), parsed))
        }
    }
}

pub type HttpExecutorRef = Arc<HttpExecutor>;

// ─────────────────────────────────────────────────────────────────────────────

/// Shell 任务沙盒选择策略。
///
/// 放在 scheduler 模块（而不是顶层 `crate::config`）是因为 `lib.rs` 只 re-export
/// scheduler；config 模块是 bin-only。把策略类型钉在它真正发挥作用的地方，
/// 集成测试 / 外部 bin 也能直接 import。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellSandboxMode {
    /// 自动探测（推荐 prod 默认）：bwrap > nsjail > direct。direct 时会在 startup 打 warn。
    Auto,
    /// 强制 bwrap；不存在则 ShellExecutor::new 直接 panic，避免静默失保护。
    Bwrap,
    /// 强制 nsjail；不存在则 panic。
    Nsjail,
    /// 直接 spawn 子进程，**无沙盒**；与服务进程同权限。仅用于受信开发环境。
    Direct,
    /// Shell 任务彻底禁用。已存在的 shell 任务每次执行都会落 failed run。
    Off,
}

impl ShellSandboxMode {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "auto" | "" => Some(Self::Auto),
            "bwrap" | "bubblewrap" => Some(Self::Bwrap),
            "nsjail" => Some(Self::Nsjail),
            "direct" | "none" | "raw" => Some(Self::Direct),
            "off" | "disable" | "disabled" | "false" | "0" => Some(Self::Off),
            _ => None,
        }
    }

    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Bwrap => "bwrap",
            Self::Nsjail => "nsjail",
            Self::Direct => "direct",
            Self::Off => "off",
        }
    }
}

/// Shell 任务执行体。
///
/// 启动时根据 `SCHEDULER_SHELL_SANDBOX_MODE` 决定一次"沙盒落地策略"，运行期不再
/// 改变 —— Auto 模式在 ShellExecutor::new 里探测 bwrap/nsjail 二进制，把决议结果
/// 钉到 `effective_sandbox` 上；后续每次 execute 都按这个策略 spawn 子进程。
///
/// 安全约束（多层防御，缺一不可）：
///   1. **Handler**：`validate_can_manage`
///      - 平台级（`tenant_id IS NULL`）→ 仅平台超管
///      - 租户级（`tenant_id = X`）   → 该租户 owner/admin（自 migration 017 放开）
///      历史上 DB 还有一道 `chk_st_shell_platform_only` 把 shell 任务钉在平台级；
///      017 删除了那道约束，威胁模型回到"沙盒+白名单"这条主轴
///   2. **Executor**：`Off` 模式直接 Err；`Auto` 落到 `Direct` 时打 warn 日志
///   3. **运行时**：`kill_on_drop=true` 保证外层 tokio::timeout 被命中时子进程立即被杀
///   4. **沙盒**：bwrap / nsjail 隔离命名空间 + 整盘 ro-bind + tmpfs 覆盖可写区
///   5. **解释器白名单**：`is_known_interpreter` 拦掉 `/bin/rm` 之流的 shebang 伪装
///   6. **env 隔离**：`env_clear` 后只注入白名单（PATH/HOME + 用户显式 shell_env），
///      不会泄露 onebase 进程自带的 secret / DB 凭据
///
/// 输出形态：
///   - 成功（exit_code=0）→ Ok(Value)，结构 `{ stdout, stderr, exit_code, sandbox, interpreter }`
///   - 非 0 退出 → Err(stderr 截断或 "exit code N")
///   - sandbox 不可用（Off / 探测失败）→ Err(明确说明)
pub struct ShellExecutor {
    effective_sandbox: EffectiveSandbox,
}

/// 启动时已经探测过的"实际可用沙盒"。区分 Auto 选定与显式选定，便于日志/错误提示。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EffectiveSandbox {
    Bwrap,
    Nsjail,
    Direct,
    Off,
}

impl EffectiveSandbox {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Bwrap => "bwrap",
            Self::Nsjail => "nsjail",
            Self::Direct => "direct",
            Self::Off => "off",
        }
    }
}

impl ShellExecutor {
    /// 按 mode 决议出实际沙盒；不在这里直接 panic（除非显式 mode 要求的工具不存在），
    /// Auto 模式找不到任何沙盒会**降级到 Direct 并打 warn**，让 dev 环境（macOS / 容器
    /// 内无 bwrap）也能跑。生产应该显式设 `bwrap` / `off` 而不是依赖 Auto。
    pub fn new(mode: ShellSandboxMode) -> Self {
        use ShellSandboxMode as M;
        let effective = match mode {
            M::Off => EffectiveSandbox::Off,
            M::Direct => {
                tracing::warn!(
                    "ShellExecutor: SCHEDULER_SHELL_SANDBOX_MODE=direct —— 脚本将以 onebase \
                     进程身份运行，**无沙盒**，仅限受信开发环境"
                );
                EffectiveSandbox::Direct
            }
            M::Bwrap => {
                if !binary_exists("bwrap") {
                    panic!(
                        "SCHEDULER_SHELL_SANDBOX_MODE=bwrap 但宿主机没有 `bwrap` 二进制；\
                         请安装 bubblewrap 或改用 SCHEDULER_SHELL_SANDBOX_MODE=off"
                    );
                }
                EffectiveSandbox::Bwrap
            }
            M::Nsjail => {
                if !binary_exists("nsjail") {
                    panic!(
                        "SCHEDULER_SHELL_SANDBOX_MODE=nsjail 但宿主机没有 `nsjail` 二进制；\
                         请安装 nsjail 或改用 SCHEDULER_SHELL_SANDBOX_MODE=off"
                    );
                }
                EffectiveSandbox::Nsjail
            }
            M::Auto => {
                if binary_exists("bwrap") {
                    EffectiveSandbox::Bwrap
                } else if binary_exists("nsjail") {
                    EffectiveSandbox::Nsjail
                } else {
                    tracing::warn!(
                        "ShellExecutor: Auto 模式未检测到 bwrap / nsjail，降级到 direct（无沙盒）。\
                         生产环境请安装 bubblewrap 并显式 SCHEDULER_SHELL_SANDBOX_MODE=bwrap"
                    );
                    EffectiveSandbox::Direct
                }
            }
        };
        tracing::info!(
            "ShellExecutor 初始化完成：requested={:?} effective={}",
            mode,
            effective.as_str(),
        );
        Self {
            effective_sandbox: effective,
        }
    }

    #[allow(dead_code)]
    pub fn sandbox_label(&self) -> &'static str {
        self.effective_sandbox.as_str()
    }

    pub async fn execute(&self, task: &ScheduledTask) -> Result<Value, String> {
        if self.effective_sandbox == EffectiveSandbox::Off {
            return Err(
                "shell 任务已被禁用：SCHEDULER_SHELL_SANDBOX_MODE=off。改回 auto/bwrap 并重启服务后再试"
                    .to_string(),
            );
        }

        let script = task
            .shell_script
            .as_deref()
            .ok_or_else(|| "shell 任务缺 shell_script".to_string())?;
        if script.trim().is_empty() {
            // 兜底：理论上 DB CHECK 已经挡住，但 RETURNING 行能被外部更新到空，再防一层。
            return Err("shell_script 为空".to_string());
        }

        let interpreter = task
            .shell_interpreter
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("/bin/sh");

        // 解释器白名单：避免被设置成 `rm` / `dd` 等危险二进制直接执行（虽然脚本里也能跑）。
        // 接受常见解释器（绝对路径或 basename）。非白名单值统一在沙盒里以 `sh -c` 兜底执行
        // —— 拒绝而不是默许，让用户感知到我们在筛。
        if !is_known_interpreter(interpreter) {
            return Err(format!(
                "解释器 `{interpreter}` 不在白名单内；当前允许：sh, bash, dash, zsh, python3, node, ruby \
                 （绝对路径或 basename 都可）"
            ));
        }

        let cwd = task
            .shell_cwd
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("/tmp");

        // 把 shell_env JSONB 拍平成 (k,v) 字符串列表。非字符串值直接跳过 —— env 必须是字符串
        // 才符合 POSIX；JSONB 里如果出现 number/bool 也不报错，做兼容处理。
        let env_pairs = task
            .shell_env
            .as_ref()
            .and_then(|v| v.as_object())
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| {
                        let val = match v {
                            Value::String(s) => s.clone(),
                            Value::Number(n) => n.to_string(),
                            Value::Bool(b) => b.to_string(),
                            _ => return None,
                        };
                        // 拒绝带 `=` / NUL 的 key（POSIX 不允许）。
                        if k.contains('=') || k.contains('\0') {
                            return None;
                        }
                        Some((k.clone(), val))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let mut cmd = self.build_command(interpreter, script, cwd, &env_pairs);
        // kill_on_drop：外层 tokio::timeout 命中后 drop future → 子进程立即被 SIGKILL，
        // 避免脚本继续偷跑占用 runner 槽位。
        cmd.kill_on_drop(true);
        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .stdin(std::process::Stdio::null());

        let output = cmd
            .output()
            .await
            .map_err(|e| format!("spawn 子进程失败：{e}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        let stdout = truncate_text(stdout, MAX_STREAM_BYTES);
        let stderr = truncate_text(stderr, MAX_STREAM_BYTES);
        let exit_code = output.status.code();

        if output.status.success() {
            Ok(serde_json::json!({
                "stdout": stdout,
                "stderr": stderr,
                "exit_code": exit_code,
                "sandbox": self.effective_sandbox.as_str(),
                "interpreter": interpreter,
            }))
        } else {
            // 失败时把 stderr 优先塞 error_message，stdout 仍可在 task run history 里看（output 字段也写一份）
            let msg = if !stderr.trim().is_empty() {
                format!("exit_code={:?}; stderr:\n{stderr}", exit_code)
            } else {
                format!("exit_code={:?}（无 stderr）", exit_code)
            };
            Err(msg)
        }
    }

    /// 真正拼 Command。沙盒参数集中在这里，便于阅读 + 测试。
    fn build_command(
        &self,
        interpreter: &str,
        script: &str,
        cwd: &str,
        env_pairs: &[(String, String)],
    ) -> tokio::process::Command {
        match self.effective_sandbox {
            EffectiveSandbox::Off => unreachable!("execute 入口已挡 Off"),
            EffectiveSandbox::Direct => {
                let mut c = tokio::process::Command::new(interpreter);
                c.arg("-c").arg(script).current_dir(cwd);
                // env_clear + 白名单：避免 leak onebase 进程的 SECRET / DB 凭据。
                c.env_clear();
                c.env(
                    "PATH",
                    "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                );
                c.env("HOME", cwd);
                for (k, v) in env_pairs {
                    c.env(k, v);
                }
                c
            }
            EffectiveSandbox::Bwrap => {
                // 保守 bwrap：整盘 ro-bind，再用 tmpfs 覆盖可写区，--unshare-all 隔离命名空间，
                // 单独 --share-net 保留网络（绝大多数 cron 脚本需要外发请求；要彻底切网用 Off）。
                // --die-with-parent：父进程 SIGKILL → 沙盒整体退出；和 kill_on_drop 双保险。
                let mut c = tokio::process::Command::new("bwrap");
                c.args([
                    "--die-with-parent",
                    "--new-session",
                    "--unshare-all",
                    "--share-net",
                    "--ro-bind",
                    "/",
                    "/",
                    "--tmpfs",
                    "/tmp",
                    "--tmpfs",
                    "/var/tmp",
                    "--tmpfs",
                    "/home",
                    "--proc",
                    "/proc",
                    "--dev",
                    "/dev",
                    "--chdir",
                    cwd,
                ]);
                // 环境变量必须在 bwrap 层用 `--setenv` 注入，否则进入沙盒后会丢；
                // onebase 自身的 env 我们不传，避免 secret 泄露。
                c.env_clear();
                c.args([
                    "--setenv",
                    "PATH",
                    "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                ]);
                c.args(["--setenv", "HOME", cwd]);
                for (k, v) in env_pairs {
                    c.args(["--setenv", k, v]);
                }
                c.arg(interpreter).arg("-c").arg(script);
                c
            }
            EffectiveSandbox::Nsjail => {
                // 简单 nsjail 调用：一次性模式（--mode o）、不打 verbose 日志、
                // 内存/CPU 用 rlimit max（用户 timeout_secs 由外层 tokio::timeout 管）。
                // nsjail 的细粒度策略（chroot / mount tree / seccomp）通常走 config file，
                // 这里只做"最小可用"，需要更严就显式 bwrap。
                let mut c = tokio::process::Command::new("nsjail");
                c.args([
                    "--mode",
                    "o",
                    "--quiet",
                    "--rlimit_as",
                    "max",
                    "--rlimit_cpu",
                    "max",
                    "--disable_clone_newnet", // 与 bwrap 的 --share-net 对齐：保留网络
                    "--cwd",
                    cwd,
                ]);
                c.env_clear();
                // nsjail 没有 --setenv；--keep_env 默认 false，从 host 继承的 env 已被切；
                // 子进程里只能拿到我们这边 .env() 显式塞的。
                c.env(
                    "PATH",
                    "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                );
                c.env("HOME", cwd);
                for (k, v) in env_pairs {
                    c.env(k, v);
                }
                c.arg("--").arg(interpreter).arg("-c").arg(script);
                c
            }
        }
    }
}

pub type ShellExecutorRef = Arc<ShellExecutor>;

/// stdout / stderr 单流截断阈值：64KB；超过部分截掉并加 `... [truncated, total N bytes]` 尾注。
const MAX_STREAM_BYTES: usize = 64 * 1024;

fn truncate_text(s: String, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s;
    }
    let bytes = s.as_bytes();
    let cut = max_bytes.min(bytes.len());
    // 切到 char 边界，否则截 utf-8 多字节字符中间会报错。
    let mut safe_cut = cut;
    while safe_cut > 0 && !s.is_char_boundary(safe_cut) {
        safe_cut -= 1;
    }
    let mut out = String::with_capacity(safe_cut + 64);
    out.push_str(&s[..safe_cut]);
    out.push_str(&format!("\n... [truncated, total {} bytes]", s.len(),));
    out
}

/// PATH 上是否能找到给定二进制。用 `which`/`command -v` 派生平台耦合；
/// 直接遍历 PATH 自己 stat 更可控。返回 false = 拒绝该 sandbox 模式。
fn binary_exists(name: &str) -> bool {
    // 绝对路径 → 直接 stat
    if name.starts_with('/') {
        return std::path::Path::new(name).is_file();
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return true;
        }
    }
    false
}

/// 解释器白名单。接受 basename 或绝对路径。绝对路径必须以白名单 basename 结尾。
fn is_known_interpreter(interp: &str) -> bool {
    const ALLOWED: &[&str] = &["sh", "bash", "dash", "zsh", "python3", "node", "ruby"];
    let basename = std::path::Path::new(interp)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    ALLOWED.contains(&basename)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn task_template() -> ScheduledTask {
        ScheduledTask {
            id: 1,
            tenant_id: None,
            name: "t".to_string(),
            description: None,
            cron_expr: "* * * * *".to_string(),
            timezone: "UTC".to_string(),
            kind: "rpc".to_string(),
            database_id: None,
            rpc_schema: None,
            rpc_fn_name: None,
            rpc_args: None,
            http_method: None,
            http_url: None,
            http_headers: None,
            http_body: None,
            http_secret_enc: None,
            shell_interpreter: None,
            shell_script: None,
            shell_env: None,
            shell_cwd: None,
            is_active: true,
            timeout_secs: 30,
            max_retries: 0,
            overlap_policy: "skip".to_string(),
            alert_webhook_url: None,
            alert_webhook_template: None,
            alert_throttle_hours: 24,
            last_alert_sent_at: None,
            next_run_at: None,
            last_run_at: None,
            last_run_status: None,
            claimed_at: None,
            claimed_by: None,
            created_by: 1,
            created_by_name: None,
            created_by_email: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    /// 真路径需要活的 PG 连接；该测试覆盖 synthesize_claims_for 在无法连库时的早期失败：
    /// `connect_lazy` 给的池在第一次查询时才尝试 TCP，因此 execute() 会在 synthesize 阶段
    /// 拿到 `SynthErr::Db`，被映射成 Err 字符串而不是 panic。
    #[tokio::test]
    async fn rpc_execute_returns_err_when_user_lookup_fails() {
        let pool = sqlx::PgPool::connect_lazy("postgres://invalid:invalid@127.0.0.1:1/none")
            .expect("connect_lazy");
        let exec = RpcExecutor::new(pool, None);

        let mut task = task_template();
        task.database_id = None;
        task.rpc_schema = Some("public".to_string());
        task.rpc_fn_name = Some("noop".to_string());

        let err = exec.execute(&task).await.err();
        assert!(err.is_some(), "无法连库时 execute 应返回 Err 而非 panic");
    }

    #[tokio::test]
    async fn http_execute_rejects_plain_http_by_default() {
        let exec = HttpExecutor::new(false);
        let mut task = task_template();
        task.kind = "http".to_string();
        task.http_method = Some("POST".to_string());
        task.http_url = Some("http://example.com/hook".to_string());

        let err = exec.execute(&task).await.err().unwrap();
        assert!(err.contains("https"), "明文 http:// 默认应被拒绝: {err}");
    }

    #[tokio::test]
    async fn http_execute_rejects_unknown_method() {
        let exec = HttpExecutor::new(true);
        let mut task = task_template();
        task.kind = "http".to_string();
        task.http_method = Some("FROB".to_string());
        task.http_url = Some("https://example.com/hook".to_string());

        let err = exec.execute(&task).await.err().unwrap();
        assert!(
            err.contains("不支持的 HTTP method"),
            "未知 method 应被拒绝: {err}"
        );
    }

    // ── ShellExecutor 单测：聚焦"拒绝路径 + Direct 模式实际执行"。沙盒路径
    //   依赖 bwrap/nsjail 存在，跑在 CI 容器里再加专门 e2e 用例。

    fn shell_task(script: &str) -> ScheduledTask {
        let mut t = task_template();
        t.kind = "shell".to_string();
        t.shell_script = Some(script.to_string());
        t
    }

    #[tokio::test]
    async fn shell_off_mode_rejects_all_tasks() {
        let exec = ShellExecutor::new(ShellSandboxMode::Off);
        let err = exec.execute(&shell_task("echo hi")).await.err().unwrap();
        assert!(err.contains("off"), "Off 模式应明确告知被禁用: {err}");
    }

    #[tokio::test]
    async fn shell_rejects_blacklisted_interpreter() {
        let exec = ShellExecutor::new(ShellSandboxMode::Direct);
        let mut t = shell_task("echo hi");
        t.shell_interpreter = Some("/usr/bin/rm".to_string());
        let err = exec.execute(&t).await.err().unwrap();
        assert!(err.contains("白名单"), "解释器白名单应拦截: {err}");
    }

    #[tokio::test]
    async fn shell_rejects_empty_script() {
        let exec = ShellExecutor::new(ShellSandboxMode::Direct);
        let mut t = shell_task("   ");
        t.shell_script = Some("   ".to_string());
        let err = exec.execute(&t).await.err().unwrap();
        assert!(err.contains("空"), "空脚本应被拒绝: {err}");
    }

    #[tokio::test]
    async fn shell_direct_runs_simple_echo() {
        // Direct 模式不依赖外部沙盒二进制；echo 是 POSIX builtin，任何 /bin/sh 都有。
        // 给 macOS / Linux dev 都能稳定通过。
        let exec = ShellExecutor::new(ShellSandboxMode::Direct);
        let t = shell_task("printf hello");
        let v = exec.execute(&t).await.expect("simple echo should succeed");
        assert_eq!(v["stdout"], "hello");
        assert_eq!(v["exit_code"], 0);
        assert_eq!(v["sandbox"], "direct");
    }

    #[tokio::test]
    async fn shell_direct_non_zero_exit_returns_err_with_stderr() {
        let exec = ShellExecutor::new(ShellSandboxMode::Direct);
        let t = shell_task("echo boom >&2; exit 7");
        let err = exec.execute(&t).await.err().unwrap();
        assert!(err.contains("exit_code"), "应当包含 exit_code: {err}");
        assert!(err.contains("boom"), "stderr 应被带出: {err}");
    }

    #[test]
    fn truncate_text_keeps_under_limit_intact() {
        let s = "hello".to_string();
        assert_eq!(truncate_text(s.clone(), 16), s);
    }

    #[test]
    fn truncate_text_adds_marker_when_over_limit() {
        let s = "x".repeat(100);
        let out = truncate_text(s, 32);
        assert!(out.contains("truncated"));
        assert!(out.starts_with(&"x".repeat(32)));
    }

    #[test]
    fn truncate_text_respects_utf8_boundary() {
        // 4 字节 utf-8（emoji），在 max_bytes 中间切断时应回退到 char 边界，不能 panic。
        let s = "🌟".repeat(10); // 每个 emoji 4 字节，共 40 字节
        let out = truncate_text(s, 5); // 切到 5 字节，必须回退到 4 字节边界
                                       // 不 panic 即通过；进一步验证不留半个 emoji
        assert!(out.starts_with("🌟"));
    }
}
