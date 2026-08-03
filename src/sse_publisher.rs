//! 进程级 SSE 发布句柄（lib 可见的解耦层）。
//!
//! `sse::SseHub`（binary 专有，带 axum/Redis 依赖）在启动时把自身注册为全局 publisher，
//! 使 lib 侧模块（`lua_builtins` / `workflow_engine`）无需依赖 binary 的 `sse` 模块即可推送。
//!
//! 设计见 `docs/superpowers/specs/2026-06-01-sse-capability-design.md`：工作流 / 脚本通过
//! 全局 `publish` 推送的消息走「通用」入口（`replicate = true`），会经 Redis 跨实例扇出。

use std::sync::Arc;
use std::sync::OnceLock;

use serde_json::Value;

/// 由 binary 侧的 `SseHub` 实现并在启动时注册。
pub trait SsePublisher: Send + Sync {
    fn publish(&self, topic: String, event: String, data: Value);
}

static GLOBAL: OnceLock<Arc<dyn SsePublisher>> = OnceLock::new();

/// 启动时注册全局 publisher（仅首次生效）。
pub fn set_global_publisher(publisher: Arc<dyn SsePublisher>) {
    let _ = GLOBAL.set(publisher);
}

/// 发布一条 SSE 消息。
///
/// 返回是否真正投递：未注册（如集成测试 / 无 SSE 环境）时返回 `false`（no-op，不报错）。
pub fn publish(topic: String, event: String, data: Value) -> bool {
    match GLOBAL.get() {
        Some(p) => {
            p.publish(topic, event, data);
            true
        }
        None => false,
    }
}
