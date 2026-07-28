use mlua::{Lua, Result as LuaResult, StdLib, Value as LuaValue, Table, Function};
use serde_json::Value as JsonValue;
use std::sync::Arc;
use tokio::sync::Semaphore;

use crate::lua_builtins;

/// Lua 脚本执行的请求上下文
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PluginContext {
    pub method: String,
    pub path: String,
    pub schema: Option<String>,
    pub table: Option<String>,
    pub body: Option<JsonValue>,
    pub query_params: Option<JsonValue>,
    pub headers: Option<JsonValue>,
    pub user_id: Option<i32>,
    pub tenant_id: Option<i32>,
    pub database_id: Option<i32>,
    pub request_id: Option<String>,
}

/// 插件执行结果
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PluginResult {
    /// 是否中止请求（前置插件返回 true 则不再继续）
    pub abort: bool,
    /// 中止时的 HTTP 状态码
    pub status_code: Option<u16>,
    /// 中止时的响应体
    pub response_body: Option<JsonValue>,
    /// 修改后的请求体（传给下一个插件或实际 handler）
    pub modified_body: Option<JsonValue>,
    /// 修改后的响应体（后置插件可以修改最终响应）
    pub modified_response: Option<JsonValue>,
    /// 插件设置的额外 headers
    pub extra_headers: Option<JsonValue>,
}

impl Default for PluginResult {
    fn default() -> Self {
        Self {
            abort: false,
            status_code: None,
            response_body: None,
            modified_body: None,
            modified_response: None,
            extra_headers: None,
        }
    }
}

/// 插件触发时机
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HookPoint {
    BeforeRequest,
    AfterRequest,
    OnError,
}

impl std::fmt::Display for HookPoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HookPoint::BeforeRequest => write!(f, "before_request"),
            HookPoint::AfterRequest => write!(f, "after_request"),
            HookPoint::OnError => write!(f, "on_error"),
        }
    }
}

/// Lua 引擎 —— 管理 Lua VM 实例池
pub struct LuaEngine {
    max_concurrent: usize,
    semaphore: Arc<Semaphore>,
    max_execution_ms: u64,
    max_memory_bytes: usize,
}

impl LuaEngine {
    pub fn new(max_concurrent: usize, max_execution_ms: u64, max_memory_bytes: usize) -> Self {
        Self {
            max_concurrent,
            semaphore: Arc::new(Semaphore::new(max_concurrent)),
            max_execution_ms,
            max_memory_bytes,
        }
    }

    /// 创建沙箱化的 Lua VM
    fn create_sandbox_lua(&self) -> LuaResult<Lua> {
        let libs = StdLib::TABLE
            | StdLib::STRING
            | StdLib::MATH
            | StdLib::UTF8;

        let lua = Lua::new_with(libs, mlua::LuaOptions::default())?;

        lua.set_memory_limit(self.max_memory_bytes)?;

        // 注入安全的全局函数
        self.inject_safe_globals(&lua)?;

        // 注册内置库（json / log / crypto / env）
        lua_builtins::register_builtins(&lua)?;

        // 注册 HTTP 模块（阻塞式，因为运行在 spawn_blocking 中）
        lua_builtins::register_http_module(&lua)?;

        Ok(lua)
    }

    /// 注入安全的全局工具函数（不包含 os/io/debug/loadfile 等危险模块）
    fn inject_safe_globals(&self, lua: &Lua) -> LuaResult<()> {
        let globals = lua.globals();

        // type() 函数
        globals.set("type", lua.create_function(|_, val: LuaValue| {
            Ok(match val {
                LuaValue::Nil => "nil",
                LuaValue::Boolean(_) => "boolean",
                LuaValue::Integer(_) => "number",
                LuaValue::Number(_) => "number",
                LuaValue::String(_) => "string",
                LuaValue::Table(_) => "table",
                LuaValue::Function(_) => "function",
                _ => "userdata",
            }.to_string())
        })?)?;

        // tostring()
        globals.set("tostring", lua.create_function(|_, val: LuaValue| {
            Ok(match val {
                LuaValue::Nil => "nil".to_string(),
                LuaValue::Boolean(b) => b.to_string(),
                LuaValue::Integer(n) => n.to_string(),
                LuaValue::Number(n) => n.to_string(),
                LuaValue::String(s) => s.to_str()?.to_string(),
                _ => format!("{:?}", val),
            })
        })?)?;

        // tonumber()
        globals.set("tonumber", lua.create_function(|_, val: LuaValue| {
            Ok(match val {
                LuaValue::Integer(n) => Some(n as f64),
                LuaValue::Number(n) => Some(n),
                LuaValue::String(s) => s.to_str()?.parse::<f64>().ok(),
                _ => None,
            })
        })?)?;

        // pairs / ipairs (Lua 5.4 已内置，但沙箱模式可能未加载 base)
        // pcall / xpcall
        globals.set("pcall", lua.create_function(|lua, (func, args): (Function, mlua::MultiValue)| {
            match func.call::<mlua::MultiValue>(args) {
                Ok(vals) => {
                    let mut result = vec![LuaValue::Boolean(true)];
                    result.extend(vals.into_iter());
                    Ok(mlua::MultiValue::from_iter(result))
                }
                Err(e) => {
                    Ok(mlua::MultiValue::from_iter(vec![
                        LuaValue::Boolean(false),
                        LuaValue::String(lua.create_string(e.to_string())?),
                    ]))
                }
            }
        })?)?;

        // print → 记录到 tracing
        globals.set("print", lua.create_function(|_, args: mlua::MultiValue| {
            let msg: Vec<String> = args.iter().map(|v| format!("{:?}", v)).collect();
            tracing::info!(target: "lua_plugin", "{}", msg.join("\t"));
            Ok(())
        })?)?;

        // error()
        globals.set("error", lua.create_function(|_, msg: String| -> LuaResult<()> {
            Err(mlua::Error::RuntimeError(msg))
        })?)?;

        Ok(())
    }

    /// 将 JSON 值转为 Lua 值
    pub fn json_to_lua(lua: &Lua, val: &JsonValue) -> LuaResult<LuaValue> {
        match val {
            JsonValue::Null => Ok(LuaValue::Nil),
            JsonValue::Bool(b) => Ok(LuaValue::Boolean(*b)),
            JsonValue::Number(n) => {
                if let Some(i) = n.as_i64() {
                    Ok(LuaValue::Integer(i))
                } else {
                    Ok(LuaValue::Number(n.as_f64().unwrap_or(0.0)))
                }
            }
            JsonValue::String(s) => Ok(LuaValue::String(lua.create_string(s)?)),
            JsonValue::Array(arr) => {
                let table = lua.create_table()?;
                for (i, item) in arr.iter().enumerate() {
                    table.set(i + 1, Self::json_to_lua(lua, item)?)?;
                }
                Ok(LuaValue::Table(table))
            }
            JsonValue::Object(map) => {
                let table = lua.create_table()?;
                for (k, v) in map.iter() {
                    table.set(k.as_str(), Self::json_to_lua(lua, v)?)?;
                }
                Ok(LuaValue::Table(table))
            }
        }
    }

    /// 将 Lua 值转回 JSON
    pub fn lua_to_json(val: &LuaValue) -> JsonValue {
        match val {
            LuaValue::Nil => JsonValue::Null,
            LuaValue::Boolean(b) => JsonValue::Bool(*b),
            LuaValue::Integer(n) => serde_json::json!(*n),
            LuaValue::Number(n) => serde_json::json!(*n),
            LuaValue::String(s) => {
                JsonValue::String(s.to_string_lossy().to_string())
            }
            LuaValue::Table(t) => {
                // 判断是数组还是对象：如果有连续整数键从 1 开始，视为数组
                let len = t.raw_len();
                if len > 0 {
                    let mut arr = Vec::new();
                    let mut is_array = true;
                    for i in 1..=len {
                        match t.raw_get::<LuaValue>(i) {
                            Ok(v) => arr.push(Self::lua_to_json(&v)),
                            Err(_) => { is_array = false; break; }
                        }
                    }
                    if is_array {
                        return JsonValue::Array(arr);
                    }
                }
                let mut map = serde_json::Map::new();
                if let Ok(pairs) = t.clone().pairs::<LuaValue, LuaValue>().collect::<Result<Vec<_>, _>>() {
                    for (k, v) in pairs {
                        let key = match &k {
                            LuaValue::String(s) => s.to_string_lossy().to_string(),
                            LuaValue::Integer(n) => n.to_string(),
                            _ => continue,
                        };
                        map.insert(key, Self::lua_to_json(&v));
                    }
                }
                JsonValue::Object(map)
            }
            _ => JsonValue::Null,
        }
    }

    /// 将 PluginContext 注入为 Lua 全局变量 `ctx`
    fn inject_context(lua: &Lua, ctx: &PluginContext) -> LuaResult<()> {
        let ctx_table = lua.create_table()?;

        ctx_table.set("method", ctx.method.as_str())?;
        ctx_table.set("path", ctx.path.as_str())?;
        ctx_table.set("schema", ctx.schema.as_deref())?;
        ctx_table.set("table_name", ctx.table.as_deref())?;
        ctx_table.set("user_id", ctx.user_id)?;
        ctx_table.set("tenant_id", ctx.tenant_id)?;
        ctx_table.set("database_id", ctx.database_id)?;
        ctx_table.set("request_id", ctx.request_id.as_deref())?;

        if let Some(body) = &ctx.body {
            ctx_table.set("body", Self::json_to_lua(lua, body)?)?;
        } else {
            ctx_table.set("body", LuaValue::Nil)?;
        }

        if let Some(params) = &ctx.query_params {
            ctx_table.set("query", Self::json_to_lua(lua, params)?)?;
        } else {
            ctx_table.set("query", LuaValue::Nil)?;
        }

        if let Some(headers) = &ctx.headers {
            ctx_table.set("headers", Self::json_to_lua(lua, headers)?)?;
        } else {
            ctx_table.set("headers", LuaValue::Nil)?;
        }

        // result 表用于插件写回结果
        let result_table = lua.create_table()?;
        result_table.set("abort", false)?;
        ctx_table.set("result", result_table)?;

        lua.globals().set("ctx", ctx_table)?;
        Ok(())
    }

    /// 从 Lua 全局 `ctx.result` 中提取插件执行结果
    fn extract_result(lua: &Lua) -> LuaResult<PluginResult> {
        let globals = lua.globals();
        let ctx: Table = globals.get("ctx")?;
        let result: Table = ctx.get("result")?;

        let abort: bool = result.get("abort").unwrap_or(false);
        let status_code: Option<u16> = result.get("status_code").ok();

        let response_body = match result.get::<LuaValue>("body") {
            Ok(val) if val != LuaValue::Nil => Some(Self::lua_to_json(&val)),
            _ => None,
        };

        let modified_body = match ctx.get::<LuaValue>("body") {
            Ok(val) if val != LuaValue::Nil => Some(Self::lua_to_json(&val)),
            _ => None,
        };

        let extra_headers = match result.get::<LuaValue>("headers") {
            Ok(val) if val != LuaValue::Nil => Some(Self::lua_to_json(&val)),
            _ => None,
        };

        Ok(PluginResult {
            abort,
            status_code,
            response_body,
            modified_body,
            modified_response: None,
            extra_headers,
        })
    }

    /// 执行插件脚本
    pub async fn execute_plugin(
        &self,
        script: &str,
        hook_fn: &str,
        ctx: &PluginContext,
    ) -> Result<PluginResult, PluginError> {
        let _permit = self.semaphore.acquire().await
            .map_err(|_| PluginError::ResourceExhausted)?;

        let script = script.to_string();
        let hook_fn = hook_fn.to_string();
        let ctx = ctx.clone();
        let max_ms = self.max_execution_ms;
        let max_mem = self.max_memory_bytes;

        // 在阻塞线程中执行 Lua（Lua VM 非 Send，必须在同一线程）
        let result = tokio::task::spawn_blocking(move || {
            let engine = LuaEngine::new(1, max_ms, max_mem);
            let lua = engine.create_sandbox_lua()
                .map_err(|e| PluginError::InitFailed(e.to_string()))?;

            Self::inject_context(&lua, &ctx)
                .map_err(|e| PluginError::ContextError(e.to_string()))?;

            // 加载并执行脚本（定义函数）
            lua.load(&script).exec()
                .map_err(|e| PluginError::ScriptError(e.to_string()))?;

            // 调用目标 hook 函数
            let func: Function = lua.globals().get(hook_fn.as_str())
                .map_err(|_| PluginError::HookNotFound(hook_fn.clone()))?;

            let ctx_val: LuaValue = lua.globals().get("ctx")
                .map_err(|e| PluginError::ExecutionError(e.to_string()))?;

            func.call::<()>(ctx_val)
                .map_err(|e| PluginError::ExecutionError(e.to_string()))?;

            Self::extract_result(&lua)
                .map_err(|e| PluginError::ResultError(e.to_string()))
        })
        .await
        .map_err(|e| PluginError::ExecutionError(format!("task panicked: {}", e)))??;

        Ok(result)
    }

    pub fn max_concurrent(&self) -> usize {
        self.max_concurrent
    }
}

/// 插件执行错误
#[derive(Debug, thiserror::Error)]
pub enum PluginError {
    #[error("Lua VM 初始化失败: {0}")]
    InitFailed(String),

    #[error("上下文注入失败: {0}")]
    ContextError(String),

    #[error("脚本加载/编译错误: {0}")]
    ScriptError(String),

    #[error("Hook 函数 '{0}' 未找到")]
    HookNotFound(String),

    #[error("执行错误: {0}")]
    ExecutionError(String),

    #[error("结果提取失败: {0}")]
    ResultError(String),

    #[error("并发资源耗尽")]
    ResourceExhausted,

    #[error("执行超时")]
    Timeout,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_basic_plugin_execution() {
        let engine = LuaEngine::new(4, 100, 16 * 1024 * 1024);
        let script = r#"
            function on_request(ctx)
                if ctx.method == "POST" then
                    ctx.body.status = "pending"
                end
            end
        "#;

        let ctx = PluginContext {
            method: "POST".to_string(),
            path: "/api/v1/1/public/posts".to_string(),
            schema: Some("public".to_string()),
            table: Some("posts".to_string()),
            body: Some(serde_json::json!({"title": "hello", "content": "world"})),
            query_params: None,
            headers: None,
            user_id: Some(1),
            tenant_id: Some(1),
            database_id: Some(1),
            request_id: Some("req-123".to_string()),
        };

        let result = engine.execute_plugin(script, "on_request", &ctx).await.unwrap();
        assert!(!result.abort);
        let body = result.modified_body.unwrap();
        assert_eq!(body["status"], "pending");
    }

    #[tokio::test]
    async fn test_plugin_abort() {
        let engine = LuaEngine::new(4, 100, 16 * 1024 * 1024);
        let script = r#"
            function on_request(ctx)
                if ctx.user_id == nil then
                    ctx.result.abort = true
                    ctx.result.status_code = 403
                    ctx.result.body = {error = "unauthorized"}
                end
            end
        "#;

        let ctx = PluginContext {
            method: "GET".to_string(),
            path: "/api/v1/1/public/secrets".to_string(),
            schema: Some("public".to_string()),
            table: Some("secrets".to_string()),
            body: None,
            query_params: None,
            headers: None,
            user_id: None,
            tenant_id: Some(1),
            database_id: Some(1),
            request_id: None,
        };

        let result = engine.execute_plugin(script, "on_request", &ctx).await.unwrap();
        assert!(result.abort);
        assert_eq!(result.status_code, Some(403));
    }

    #[tokio::test]
    async fn test_sandbox_blocks_dangerous_operations() {
        let engine = LuaEngine::new(4, 100, 16 * 1024 * 1024);
        let script = r#"
            function on_request(ctx)
                os.execute("rm -rf /")
            end
        "#;

        let ctx = PluginContext {
            method: "GET".to_string(),
            path: "/".to_string(),
            schema: None,
            table: None,
            body: None,
            query_params: None,
            headers: None,
            user_id: None,
            tenant_id: None,
            database_id: None,
            request_id: None,
        };

        let result = engine.execute_plugin(script, "on_request", &ctx).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_memory_limit() {
        let engine = LuaEngine::new(4, 5000, 1024 * 1024); // 1MB limit
        let script = r#"
            function on_request(ctx)
                local t = {}
                for i = 1, 10000000 do
                    t[i] = string.rep("x", 1000)
                end
            end
        "#;

        let ctx = PluginContext {
            method: "GET".to_string(),
            path: "/".to_string(),
            schema: None,
            table: None,
            body: None,
            query_params: None,
            headers: None,
            user_id: None,
            tenant_id: None,
            database_id: None,
            request_id: None,
        };

        let result = engine.execute_plugin(script, "on_request", &ctx).await;
        assert!(result.is_err());
    }
}
