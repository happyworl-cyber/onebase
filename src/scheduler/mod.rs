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

// 对外稳定 re-export；crate 内多从子模块路径直接引用，故允许 unused_imports。
#[allow(unused_imports)]
pub use cron_parser::next_after;
#[allow(unused_imports)]
pub use executors::ShellSandboxMode;
#[allow(unused_imports)]
pub use models::{
    OverlapPolicy, RunStatus, ScheduledTask, ScheduledTaskRun, TaskKind, TriggeredBy,
};
#[allow(unused_imports)]
pub use runner::{SchedulerConfig, SchedulerRunner};
