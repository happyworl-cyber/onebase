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

pub mod auth;
pub mod brand;
pub mod crypto;
pub mod error;
pub mod lua_builtins;
pub mod lua_engine;
pub mod migrate;
pub mod workflow_engine;
pub mod pool_manager;
pub mod redis_manager;
pub mod rpc;
pub mod scheduler;

// `rpc` 的传递依赖——本身不暴露给集成测试用，只是让 lib 能完整编译。
mod permission_cache;
// `rbac_handlers` 经 optimize 分支重构后调用了 `crate::permissions::...`，lib 编译
// 必须也带上 permissions 模块；只是 mod，不需要 pub。
mod permissions;
mod query_builder;
mod rbac_handlers;
mod rbac_models;
