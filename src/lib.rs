//! Onebase 库入口
//!
//! 此处只暴露**与多个 bin / 集成测试共享**的工具模块（如迁移脚本切分器）。
//! 业务逻辑模块（handlers / middleware / models 等）仍由 `src/main.rs`
//! 直接以 `mod xxx;` 形式持有，不通过 lib 暴露——避免与现有调用图冲突。
//!
//! 例外：`scheduler` 模块需要从集成测试访问（见
//! `docs/superpowers/plans/2026-05-14-scheduled-tasks.md` Task 2.5），
//! 因此与其传递依赖的若干基础模块一并 re-export：
//! - `error`        AppError（scheduler 各处都用）
//! - `auth`         Claims（synthesize_claims_for 返回）
//! - `pool_manager` POOL_MANAGER / DatabaseConfig（动态库连接）
//! - `redis_manager` RedisManager（RBAC 权限缓存）
//! - `rpc`          execute_rpc_inner（RpcExecutor 调用）
//! - `crypto`       decrypt_secret_lossy（HTTP 签名 secret / 密码解密）
//! - `permission_cache` / `query_builder` / `rbac_handlers` 是 `rpc` 的内部依赖，
//!   一并 `mod`（不需要 pub，但 lib 编译需要它们存在）
//!
//! 这是最小必要集——多加任何 handler 模块会引入和 main.rs 的双重 mod 树，
//! 容易踩 once_cell static 重复初始化等坑。

pub mod alert_webhook;
pub mod auth;
pub mod crypto;
pub mod crypto_primitives;
pub mod error;
/// 统一执行日志（执行索引层 + 保留清理）。被 lib crate 的 `scheduler` 与 bin crate 的
/// handler 共用，故放在 lib；刻意不依赖 bin-only 的 `request_id` / `logging`。
pub mod execution_log;
/// 工作流执行次数跟踪（月度配额限制）。基于 Redis 实现，用于 License 配额检查。
pub mod execution_tracker;
pub mod http_async_poll;
pub mod js_deps;
pub mod js_host_bridge;
pub mod js_runner;
/// Redis 数据源：连接注册表 + 客户端缓存 + 精选命令。随 `workflow_engine` 编进 lib
/// crate（`redis` 节点要用），刻意只依赖 crypto/error/redis/sqlx，保持 lib-safe。
pub mod kafka_ds;
/// 商用离线 License（授权 / 续保控制）。服务端中间件与 `license_tool` CLI 共用，
/// 只依赖 rsa / sha2 / serde / chrono / axum，保持 lib-safe。
pub mod license;
pub mod lua_builtins;
pub mod lua_engine;
pub mod migrate;
pub mod object_storage_ds;
pub mod operation_log;
pub mod pg_row_json;
pub mod pool_manager;
/// 连接池 acquire 超时计数 + 饱和 fail-fast。`workflow_engine` 的 Postgres 节点埋点
/// 要用，故随其编进 lib crate；依赖 sqlx/chrono/serde/dashmap/pool_manager。
pub mod pool_metrics;
pub mod py_deps;
pub mod py_runner;
/// 工作流 Postgres 节点复用其 `apply_session_guards` / `reset_session_guards`；
/// 与 bin 侧超管 raw SQL 通道同源文件，lib 只依赖 error/sqlx，保持 lib-safe。
pub mod raw_sql_guard;
pub mod redis_ds;
pub mod redis_manager;
pub mod rpc;
pub mod scheduler;
pub mod session_hooks;
pub mod sse_batch_config;
pub mod sse_publisher;
pub mod workflow_engine;

// `rpc` 的传递依赖——本身不暴露给集成测试用，只是让 lib 能完整编译。
// 真正的调用方（tenant_handlers / main 路由等）只在 bin crate；lib 侧会误报 dead_code。
#[allow(dead_code)]
mod permission_cache;
// `rbac_handlers` 经 optimize 分支重构后调用了 `crate::permissions::...`，lib 编译
// 必须也带上 permissions 模块；只是 mod，不需要 pub。
#[allow(dead_code)]
mod permissions;
#[allow(dead_code)]
mod query_builder;
#[allow(dead_code)]
mod rbac_handlers;
#[allow(dead_code)]
mod rbac_models;
