//! `management.scheduled_tasks` / `scheduled_task_runs` 的 Rust 镜像。
//!
//! 命名约定与表列一一对应；JSONB 列用 `serde_json::Value`，
//! `TIMESTAMPTZ` 用 `DateTime<Utc>`。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

// 当前 ScheduledTask 列用 String 存 kind/status；这些枚举留给校验与 API 序列化。
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskKind {
    Rpc,
    Http,
    /// 在宿主机执行命令 / 解释器脚本。
    ///
    /// 鉴权（自 migration 017 起）：
    ///   - 平台级（tenant_id IS NULL）→ 平台超管
    ///   - 租户级（tenant_id = X）   → 该租户的 owner/admin
    /// 全部由 handler 的 `validate_can_manage` 落实；DB 的 `chk_st_shell_platform_only`
    /// 约束已被 017 删除（沙盒/白名单/env_clear 才是 shell 任务真正的安全边界）。
    /// 运行时是否走沙盒由 `SCHEDULER_SHELL_SANDBOX_MODE` 决定，与 schema 解耦。
    Shell,
    /// 进程内调用 `execute_workflow_internal`。必须带 tenant_id + workflow_id。
    Workflow,
}

#[allow(dead_code)]
impl TaskKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskKind::Rpc => "rpc",
            TaskKind::Http => "http",
            TaskKind::Shell => "shell",
            TaskKind::Workflow => "workflow",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "rpc" => Some(TaskKind::Rpc),
            "http" => Some(TaskKind::Http),
            "shell" => Some(TaskKind::Shell),
            "workflow" => Some(TaskKind::Workflow),
            _ => None,
        }
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OverlapPolicy {
    Skip,
    Allow,
}

#[allow(dead_code)]
impl OverlapPolicy {
    pub fn as_str(&self) -> &'static str {
        match self {
            OverlapPolicy::Skip => "skip",
            OverlapPolicy::Allow => "allow",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "skip" => Some(OverlapPolicy::Skip),
            "allow" => Some(OverlapPolicy::Allow),
            _ => None,
        }
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Running,
    Success,
    Failed,
    Timeout,
    Cancelled,
}

#[allow(dead_code)]
impl RunStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            RunStatus::Running => "running",
            RunStatus::Success => "success",
            RunStatus::Failed => "failed",
            RunStatus::Timeout => "timeout",
            RunStatus::Cancelled => "cancelled",
        }
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TriggeredBy {
    Cron,
    Manual,
}

#[allow(dead_code)]
impl TriggeredBy {
    pub fn as_str(&self) -> &'static str {
        match self {
            TriggeredBy::Cron => "cron",
            TriggeredBy::Manual => "manual",
        }
    }
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct ScheduledTask {
    pub id: i64,
    pub tenant_id: Option<i32>,
    pub name: String,
    pub description: Option<String>,
    pub cron_expr: String,
    pub timezone: String,
    pub kind: String,
    pub database_id: Option<i32>,
    pub rpc_schema: Option<String>,
    pub rpc_fn_name: Option<String>,
    pub rpc_args: Option<serde_json::Value>,
    pub http_method: Option<String>,
    pub http_url: Option<String>,
    pub http_headers: Option<serde_json::Value>,
    pub http_body: Option<serde_json::Value>,
    pub http_secret_enc: Option<String>,
    // ── kind='shell' 专属列；其它 kind 始终 NULL ──
    /// 解释器二进制名；NULL/空 → 默认 `/bin/sh`。沙盒内通过 PATH 查找。
    pub shell_interpreter: Option<String>,
    /// 脚本内容（裸文本，等价 `<interpreter> -c <script>`）。
    /// kind='shell' 时由 DB CHECK 保证非空。
    pub shell_script: Option<String>,
    /// 注入到子进程的环境变量（JSONB object，key/val 都是字符串）。
    pub shell_env: Option<serde_json::Value>,
    /// 子进程工作目录；NULL → 沙盒内的 /tmp。
    pub shell_cwd: Option<String>,
    // ── kind='workflow' 专属列；其它 kind 始终 NULL ──
    pub workflow_id: Option<i32>,
    pub workflow_slug: Option<String>,
    pub workflow_input: Option<serde_json::Value>,
    pub is_active: bool,
    pub timeout_secs: i32,
    pub max_retries: i32,
    pub overlap_policy: String,
    pub alert_webhook_url: Option<String>,
    pub alert_webhook_template: Option<serde_json::Value>,
    pub alert_throttle_hours: i32,
    pub last_alert_sent_at: Option<DateTime<Utc>>,
    pub next_run_at: Option<DateTime<Utc>>,
    pub last_run_at: Option<DateTime<Utc>>,
    pub last_run_status: Option<String>,
    pub claimed_at: Option<DateTime<Utc>>,
    pub claimed_by: Option<String>,
    pub created_by: i32,
    /// 列表 JOIN users 后填充；`SELECT *` / `RETURNING *` 无此列时为 None
    #[sqlx(default)]
    pub created_by_name: Option<String>,
    #[sqlx(default)]
    pub created_by_email: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow, Serialize)]
pub struct ScheduledTaskRun {
    pub id: i64,
    pub task_id: i64,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub status: String,
    pub runner_id: Option<String>,
    pub output: Option<serde_json::Value>,
    pub error_message: Option<String>,
    pub duration_ms: Option<i32>,
    pub attempt_number: i32,
    pub triggered_by: String,
}
