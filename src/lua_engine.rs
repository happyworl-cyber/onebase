use mlua::{Function, Lua, Result as LuaResult, StdLib, Table, Value as LuaValue};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
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
    /// 工作流 code 节点：上游节点输出（key = 节点 id）
    pub nodes: Option<JsonValue>,
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
#[allow(dead_code)]
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
    #[allow(dead_code)]
    max_concurrent: usize,
    semaphore: Arc<Semaphore>,
    max_execution_ms: u64,
    max_memory_bytes: usize,
    /// 禁用 http 模块（生产只读护栏）：调用 http.* 直接报错而非发出请求
    http_disabled: bool,
    /// 项目级环境变量，供 Lua `env.get` 读取（执行期从 DB 解密装入）
    env_vars: HashMap<String, String>,
    /// 当前工作流所属项目（租户）id，供 `google.sa_assertion` 派生 K8s 密钥名时绑定
    /// 租户使用（可信、用户不可伪造）。非工作流场景可为 None。
    tenant_id: Option<i32>,
}

impl LuaEngine {
    pub fn new(max_concurrent: usize, max_execution_ms: u64, max_memory_bytes: usize) -> Self {
        Self {
            max_concurrent,
            semaphore: Arc::new(Semaphore::new(max_concurrent)),
            max_execution_ms,
            max_memory_bytes,
            http_disabled: false,
            env_vars: HashMap::new(),
            tenant_id: None,
        }
    }

    /// 以"http 禁用"模式运行（生产只读护栏专用）
    pub fn with_http_disabled(mut self) -> Self {
        self.http_disabled = true;
        self
    }

    /// 注入项目级环境变量，供 Lua `env.get` 读取
    pub fn with_env_vars(mut self, env_vars: HashMap<String, String>) -> Self {
        self.env_vars = env_vars;
        self
    }

    /// 注入当前工作流所属项目（租户）id，供 `google.sa_assertion` 派生密钥名。
    pub fn with_tenant_id(mut self, tenant_id: Option<i32>) -> Self {
        self.tenant_id = tenant_id;
        self
    }

    /// 创建沙箱化的 Lua VM
    fn create_sandbox_lua(&self) -> LuaResult<Lua> {
        let libs = StdLib::TABLE | StdLib::STRING | StdLib::MATH | StdLib::UTF8;

        let lua = Lua::new_with(libs, mlua::LuaOptions::default())?;

        lua.set_memory_limit(self.max_memory_bytes)?;

        // 注入安全的全局函数
        self.inject_safe_globals(&lua)?;

        // 注册内置库（json / log / crypto / env / time）；env.get 读取本引擎装入的项目变量
        lua_builtins::register_builtins(&lua, self.env_vars.clone())?;

        // 注册 google 宿主模块（sa_assertion）：私钥留在 Rust，按 tenant_id + 派生名读 K8s。
        lua_builtins::register_google_module(&lua, self.tenant_id)?;

        // 注册 HTTP 模块（阻塞式，因为运行在 spawn_blocking 中）；
        // 生产只读护栏下换成报错 stub，封死 Lua 侧的副作用逃生舱。
        if self.http_disabled {
            lua_builtins::register_http_module_disabled(&lua)?;
        } else {
            lua_builtins::register_http_module(&lua)?;
        }

        Ok(lua)
    }

    /// 注入安全的全局工具函数（不包含 os/io/debug/loadfile 等危险模块）
    fn inject_safe_globals(&self, lua: &Lua) -> LuaResult<()> {
        let globals = lua.globals();

        // type() 函数
        globals.set(
            "type",
            lua.create_function(|_, val: LuaValue| {
                Ok(match val {
                    LuaValue::Nil => "nil",
                    LuaValue::Boolean(_) => "boolean",
                    LuaValue::Integer(_) => "number",
                    LuaValue::Number(_) => "number",
                    LuaValue::String(_) => "string",
                    LuaValue::Table(_) => "table",
                    LuaValue::Function(_) => "function",
                    _ => "userdata",
                }
                .to_string())
            })?,
        )?;

        // tostring()
        globals.set(
            "tostring",
            lua.create_function(|_, val: LuaValue| {
                Ok(match val {
                    LuaValue::Nil => "nil".to_string(),
                    LuaValue::Boolean(b) => b.to_string(),
                    LuaValue::Integer(n) => n.to_string(),
                    LuaValue::Number(n) => n.to_string(),
                    LuaValue::String(s) => s.to_str()?.to_string(),
                    _ => format!("{:?}", val),
                })
            })?,
        )?;

        // tonumber()
        globals.set(
            "tonumber",
            lua.create_function(|_, val: LuaValue| {
                Ok(match val {
                    LuaValue::Integer(n) => Some(n as f64),
                    LuaValue::Number(n) => Some(n),
                    LuaValue::String(s) => s.to_str()?.parse::<f64>().ok(),
                    _ => None,
                })
            })?,
        )?;

        // pairs / ipairs (Lua 5.4 已内置，但沙箱模式可能未加载 base)
        // pcall / xpcall
        globals.set(
            "pcall",
            lua.create_function(|lua, (func, args): (Function, mlua::MultiValue)| {
                match func.call::<mlua::MultiValue>(args) {
                    Ok(vals) => {
                        let mut result = vec![LuaValue::Boolean(true)];
                        result.extend(vals.into_iter());
                        Ok(mlua::MultiValue::from_iter(result))
                    }
                    Err(e) => Ok(mlua::MultiValue::from_iter(vec![
                        LuaValue::Boolean(false),
                        LuaValue::String(lua.create_string(e.to_string())?),
                    ])),
                }
            })?,
        )?;

        // print → 记录到 tracing
        globals.set(
            "print",
            lua.create_function(|_, args: mlua::MultiValue| {
                let msg: Vec<String> = args.iter().map(|v| format!("{:?}", v)).collect();
                tracing::info!(target: "lua_plugin", "{}", msg.join("\t"));
                Ok(())
            })?,
        )?;

        // error()
        globals.set(
            "error",
            lua.create_function(|_, msg: String| -> LuaResult<()> {
                Err(mlua::Error::RuntimeError(msg))
            })?,
        )?;

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
            LuaValue::String(s) => JsonValue::String(s.to_string_lossy().to_string()),
            LuaValue::Table(t) => {
                // 判断是数组还是对象：如果有连续整数键从 1 开始，视为数组
                let len = t.raw_len();
                if len > 0 {
                    let mut arr = Vec::new();
                    let mut is_array = true;
                    for i in 1..=len {
                        match t.raw_get::<LuaValue>(i) {
                            Ok(v) => arr.push(Self::lua_to_json(&v)),
                            Err(_) => {
                                is_array = false;
                                break;
                            }
                        }
                    }
                    if is_array {
                        return JsonValue::Array(arr);
                    }
                }
                let mut map = serde_json::Map::new();
                if let Ok(pairs) = t
                    .clone()
                    .pairs::<LuaValue, LuaValue>()
                    .collect::<Result<Vec<_>, _>>()
                {
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

        if let Some(nodes) = &ctx.nodes {
            ctx_table.set("nodes", Self::json_to_lua(lua, nodes)?)?;
        } else {
            ctx_table.set("nodes", LuaValue::Nil)?;
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
        let _permit = self
            .semaphore
            .acquire()
            .await
            .map_err(|_| PluginError::ResourceExhausted)?;

        let script = script.to_string();
        let hook_fn = hook_fn.to_string();
        let ctx = ctx.clone();
        let max_ms = self.max_execution_ms;
        let max_mem = self.max_memory_bytes;
        // 把外层引擎的护栏与项目变量带进阻塞线程：
        // - http_disabled：此前内层重建只复制了 max_ms/max_mem，导致生产只读护栏的
        //   "Lua 禁 http" 在 execute_plugin 路径实际失效（既有缺陷），这里一并修复；
        // - env_vars：供内层 env.get 读取（Lua VM 同步，必须在进线程前装好）。
        let http_disabled = self.http_disabled;
        let env_vars = self.env_vars.clone();
        // tenant_id 同样要过 spawn_blocking 边界透传，否则内层重建丢失（与 http_disabled 同坑），
        // 导致 google.sa_assertion 拿不到租户上下文。
        let tenant_id = self.tenant_id;

        // 在阻塞线程中执行 Lua（Lua VM 非 Send，必须在同一线程）
        let result = tokio::task::spawn_blocking(move || {
            let mut engine = LuaEngine::new(1, max_ms, max_mem)
                .with_env_vars(env_vars)
                .with_tenant_id(tenant_id);
            if http_disabled {
                engine = engine.with_http_disabled();
            }
            let lua = engine
                .create_sandbox_lua()
                .map_err(|e| PluginError::InitFailed(e.to_string()))?;

            // 墙钟执行时限：用指令计数 hook 周期性检查 deadline，超时即向 Lua 抛错中断。
            // 这是防 `while true do end` 这类死循环把 spawn_blocking 线程占死的唯一手段
            // （Lua 不可抢占；外层 tokio timeout 只能取消 await，杀不掉跑飞的阻塞线程）。
            if max_ms > 0 {
                let deadline = std::time::Instant::now() + std::time::Duration::from_millis(max_ms);
                // 每 ~10 万条指令检查一次：足够及时，开销可忽略。
                let _ = lua.set_hook(
                    mlua::HookTriggers::new().every_nth_instruction(100_000),
                    move |_lua, _debug| {
                        if std::time::Instant::now() >= deadline {
                            Err(mlua::Error::RuntimeError(format!(
                                "Lua 执行超时（超过 {} ms，已强制中止）",
                                max_ms
                            )))
                        } else {
                            Ok(mlua::VmState::Continue)
                        }
                    },
                );
            }

            Self::inject_context(&lua, &ctx)
                .map_err(|e| PluginError::ContextError(e.to_string()))?;

            // 加载并执行脚本（定义函数）
            lua.load(&script)
                .exec()
                .map_err(|e| PluginError::ScriptError(e.to_string()))?;

            // 调用目标 hook 函数
            let func: Function = lua
                .globals()
                .get(hook_fn.as_str())
                .map_err(|_| PluginError::HookNotFound(hook_fn.clone()))?;

            let ctx_val: LuaValue = lua
                .globals()
                .get("ctx")
                .map_err(|e| PluginError::ExecutionError(e.to_string()))?;

            func.call::<()>(ctx_val)
                .map_err(|e| PluginError::ExecutionError(e.to_string()))?;

            Self::extract_result(&lua).map_err(|e| PluginError::ResultError(e.to_string()))
        })
        .await
        .map_err(|e| PluginError::ExecutionError(format!("task panicked: {}", e)))??;

        Ok(result)
    }

    #[allow(dead_code)]
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

    #[allow(dead_code)]
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
            nodes: None,
        };

        let result = engine
            .execute_plugin(script, "on_request", &ctx)
            .await
            .unwrap();
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
            nodes: None,
        };

        let result = engine
            .execute_plugin(script, "on_request", &ctx)
            .await
            .unwrap();
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
            nodes: None,
        };

        let result = engine.execute_plugin(script, "on_request", &ctx).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_execution_timeout_breaks_infinite_loop() {
        // 200ms 时限 + 死循环：必须返回错误（而不是永久挂起阻塞线程）。
        let engine = LuaEngine::new(4, 200, 16 * 1024 * 1024);
        let script = r#"
            function on_request(ctx)
                while true do end
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
            nodes: None,
        };

        let result =
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                engine.execute_plugin(script, "on_request", &ctx).await
            })
            .await
            .expect("plugin should return within 5s, not hang the blocking thread forever");
        assert!(result.is_err(), "infinite loop should be aborted by hook");
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
            nodes: None,
        };

        let result = engine.execute_plugin(script, "on_request", &ctx).await;
        assert!(result.is_err());
    }

    /// 构造一个最小 PluginContext，供下面两个回归测试复用
    fn minimal_ctx() -> PluginContext {
        PluginContext {
            method: "WORKFLOW".to_string(),
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
            nodes: None,
        }
    }

    #[tokio::test]
    async fn test_inject_nodes_with_multiline_strings() {
        let engine = LuaEngine::new(4, 100, 16 * 1024 * 1024);
        let script = r#"
            function execute(ctx)
                ctx.body = { prompt = ctx.nodes["upstream"].system_prompt }
            end
        "#;

        let ctx = PluginContext {
            method: "WORKFLOW".to_string(),
            path: "/workflow/1".to_string(),
            schema: None,
            table: None,
            body: Some(serde_json::json!({})),
            query_params: None,
            headers: None,
            user_id: None,
            tenant_id: None,
            database_id: None,
            request_id: None,
            nodes: Some(serde_json::json!({
                "upstream": {
                    "system_prompt": "line1\nline2\nline3"
                }
            })),
        };

        let result = engine.execute_plugin(script, "execute", &ctx).await.unwrap();
        assert_eq!(
            result.modified_body.unwrap()["prompt"],
            "line1\nline2\nline3"
        );
    }

    /// 回归：http_disabled 必须穿透到 execute_plugin 内层重建的引擎。
    /// 修复前内层 LuaEngine::new 只复制了 max_ms/max_mem，http_disabled 丢失，
    /// 导致生产只读护栏下 Lua 仍能调 http —— 这里验证禁用生效后 http.get 报错。
    #[tokio::test]
    async fn test_http_disabled_propagates_to_inner_engine() {
        let engine = LuaEngine::new(1, 1000, 16 * 1024 * 1024).with_http_disabled();
        let script = r#"
            function on_request(ctx)
                http.get("http://example.com")
            end
        "#;
        let result = engine
            .execute_plugin(script, "on_request", &minimal_ctx())
            .await;
        // http 被禁用：调用 http.get 应使脚本执行报错
        assert!(result.is_err(), "http_disabled 下 http.get 应报错");
    }

    /// env.get 数据源穿透：通过 with_env_vars 装入的变量应在 Lua 内可读，未配置返回 nil。
    #[tokio::test]
    async fn test_env_vars_propagate_to_inner_engine() {
        let mut env_vars = HashMap::new();
        env_vars.insert("API_TOKEN".to_string(), "tok_abc".to_string());
        let engine = LuaEngine::new(1, 1000, 16 * 1024 * 1024).with_env_vars(env_vars);
        let script = r#"
            function on_request(ctx)
                assert(env.get("API_TOKEN") == "tok_abc", "应读到已配置变量")
                assert(env.get("MISSING") == nil, "未配置变量应为 nil")
            end
        "#;
        let result = engine
            .execute_plugin(script, "on_request", &minimal_ctx())
            .await;
        assert!(result.is_ok(), "env.get 穿透失败: {:?}", result.err());
    }
}
