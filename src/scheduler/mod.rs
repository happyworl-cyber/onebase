//! 定时任务调度模块。
//!
//! 入口：`SchedulerRunner`（runner.rs）作为 tokio 后台任务运行，每 5s tick 一次，
//! 从 `management.scheduled_tasks` 用 `FOR UPDATE SKIP LOCKED` claim 到期任务后
//! 分发给 `RpcExecutor` / `HttpExecutor` 执行，结果写入 `scheduled_task_runs`。
//!
//! 详见 `docs/superpowers/specs/2026-05-14-scheduled-tasks-design.md`。

pub mod cron_parser;
pub mod executors;
pub mod models;
pub mod runner;

pub use cron_parser::next_after;
pub use executors::ShellSandboxMode;
pub use models::{ScheduledTask, ScheduledTaskRun, TaskKind, RunStatus, OverlapPolicy, TriggeredBy};
pub use runner::{SchedulerConfig, SchedulerRunner};
