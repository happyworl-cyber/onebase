use mlua::{Lua, Result as LuaResult, Value as LuaValue, Table};
use serde_json::Value as JsonValue;

use crate::lua_engine::LuaEngine;

/// 注册所有内置模块到 Lua 环境
pub fn register_builtins(lua: &Lua) -> LuaResult<()> {
    register_json_module(lua)?;
    register_log_module(lua)?;
    register_crypto_module(lua)?;
    register_env_module(lua)?;
    Ok(())
}

/// json 模块：encode / decode
fn register_json_module(lua: &Lua) -> LuaResult<()> {
    let json_mod = lua.create_table()?;

    // json.encode(table) -> string
    json_mod.set("encode", lua.create_function(|_lua, val: LuaValue| {
        let json_val = LuaEngine::lua_to_json(&val);
        serde_json::to_string(&json_val)
            .map_err(|e| mlua::Error::RuntimeError(format!("json.encode 失败: {}", e)))
    })?)?;

    // json.encode_pretty(table) -> string
    json_mod.set("encode_pretty", lua.create_function(|_lua, val: LuaValue| {
        let json_val = LuaEngine::lua_to_json(&val);
        serde_json::to_string_pretty(&json_val)
            .map_err(|e| mlua::Error::RuntimeError(format!("json.encode_pretty 失败: {}", e)))
    })?)?;

    // json.decode(string) -> table
    json_mod.set("decode", lua.create_function(|lua, s: String| {
        let val: JsonValue = serde_json::from_str(&s)
            .map_err(|e| mlua::Error::RuntimeError(format!("json.decode 失败: {}", e)))?;
        LuaEngine::json_to_lua(lua, &val)
    })?)?;

    lua.globals().set("json", json_mod)?;
    Ok(())
}

/// log 模块：info / warn / error / debug
fn register_log_module(lua: &Lua) -> LuaResult<()> {
    let log_mod = lua.create_table()?;

    log_mod.set("info", lua.create_function(|_, msg: String| {
        tracing::info!(target: "lua_plugin", "{}", msg);
        Ok(())
    })?)?;

    log_mod.set("warn", lua.create_function(|_, msg: String| {
        tracing::warn!(target: "lua_plugin", "{}", msg);
        Ok(())
    })?)?;

    log_mod.set("error", lua.create_function(|_, msg: String| {
        tracing::error!(target: "lua_plugin", "{}", msg);
        Ok(())
    })?)?;

    log_mod.set("debug", lua.create_function(|_, msg: String| {
        tracing::debug!(target: "lua_plugin", "{}", msg);
        Ok(())
    })?)?;

    lua.globals().set("log", log_mod)?;
    Ok(())
}

/// crypto 模块：sha256 / uuid
fn register_crypto_module(lua: &Lua) -> LuaResult<()> {
    let crypto_mod = lua.create_table()?;

    // crypto.sha256(input) -> hex string
    crypto_mod.set("sha256", lua.create_function(|_, input: String| {
        use sha2::{Sha256, Digest};
        let mut hasher = Sha256::new();
        hasher.update(input.as_bytes());
        Ok(hex::encode(hasher.finalize()))
    })?)?;

    // crypto.uuid() -> random UUID v4
    crypto_mod.set("uuid", lua.create_function(|_, ()| {
        Ok(uuid::Uuid::new_v4().to_string())
    })?)?;

    // crypto.random_hex(len) -> random hex string
    crypto_mod.set("random_hex", lua.create_function(|_, len: usize| {
        use rand::Rng;
        let byte_len = (len + 1) / 2;
        let bytes: Vec<u8> = (0..byte_len).map(|_| rand::thread_rng().gen()).collect();
        let s = hex::encode(&bytes);
        Ok(s[..len.min(s.len())].to_string())
    })?)?;

    lua.globals().set("crypto", crypto_mod)?;
    Ok(())
}

/// env 模块：安全地读取白名单环境变量（仅允许 PLUGIN_ 前缀）
fn register_env_module(lua: &Lua) -> LuaResult<()> {
    let env_mod = lua.create_table()?;

    // env.get(key) -> string | nil（仅允许 PLUGIN_ 前缀的变量）
    env_mod.set("get", lua.create_function(|_, key: String| {
        if !key.starts_with("PLUGIN_") {
            return Err(mlua::Error::RuntimeError(
                format!("env.get 仅允许读取 PLUGIN_ 前缀的环境变量，不允许读取 '{}'", key)
            ));
        }
        Ok(std::env::var(&key).ok())
    })?)?;

    lua.globals().set("env", env_mod)?;
    Ok(())
}

/// HTTP 请求结果（用于从阻塞线程返回）
#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
    pub headers: Vec<(String, String)>,
}

/// 注册 HTTP 模块（需要在异步上下文中使用 —— 目前用同步阻塞实现）
///
/// 因为 Lua 在 spawn_blocking 中运行，HTTP 请求也使用阻塞的 reqwest::blocking。
/// 安全措施：限制目标 URL 只能是 HTTPS（或 PLUGIN_ALLOW_HTTP=1 时允许 HTTP）
pub fn register_http_module(lua: &Lua) -> LuaResult<()> {
    let http_mod = lua.create_table()?;

    // http.get(url, opts?) -> {status, body, headers}
    http_mod.set("get", lua.create_function(|lua, (url, opts): (String, Option<Table>)| {
        do_http_request(lua, "GET", &url, opts, None)
    })?)?;

    // http.post(url, body, opts?) -> {status, body, headers}
    http_mod.set("post", lua.create_function(|lua, (url, body, opts): (String, Option<LuaValue>, Option<Table>)| {
        let body_str = match body {
            Some(LuaValue::String(s)) => Some(s.to_string_lossy().to_string()),
            Some(val) => {
                let json_val = LuaEngine::lua_to_json(&val);
                Some(serde_json::to_string(&json_val).unwrap_or_default())
            }
            None => None,
        };
        do_http_request(lua, "POST", &url, opts, body_str.as_deref())
    })?)?;

    // http.put(url, body, opts?) -> {status, body, headers}
    http_mod.set("put", lua.create_function(|lua, (url, body, opts): (String, Option<LuaValue>, Option<Table>)| {
        let body_str = match body {
            Some(LuaValue::String(s)) => Some(s.to_string_lossy().to_string()),
            Some(val) => {
                let json_val = LuaEngine::lua_to_json(&val);
                Some(serde_json::to_string(&json_val).unwrap_or_default())
            }
            None => None,
        };
        do_http_request(lua, "PUT", &url, opts, body_str.as_deref())
    })?)?;

    // http.delete(url, opts?) -> {status, body, headers}
    http_mod.set("delete", lua.create_function(|lua, (url, opts): (String, Option<Table>)| {
        do_http_request(lua, "DELETE", &url, opts, None)
    })?)?;

    lua.globals().set("http", http_mod)?;
    Ok(())
}

fn do_http_request<'lua>(
    lua: &'lua Lua,
    method: &str,
    url: &str,
    opts: Option<Table>,
    body: Option<&str>,
) -> LuaResult<LuaValue> {
    // 安全检查：默认仅允许 HTTPS
    if !url.starts_with("https://") {
        let allow_http = std::env::var("PLUGIN_ALLOW_HTTP").unwrap_or_default() == "1";
        if !allow_http && !url.starts_with("http://localhost") && !url.starts_with("http://127.0.0.1") {
            return Err(mlua::Error::RuntimeError(
                "http 请求仅允许 HTTPS URL（设置 PLUGIN_ALLOW_HTTP=1 可允许 HTTP）".to_string()
            ));
        }
    }

    // 构建请求
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| mlua::Error::RuntimeError(format!("HTTP 客户端创建失败: {}", e)))?;

    let mut req = match method {
        "GET" => client.get(url),
        "POST" => client.post(url),
        "PUT" => client.put(url),
        "DELETE" => client.delete(url),
        "PATCH" => client.patch(url),
        _ => return Err(mlua::Error::RuntimeError(format!("不支持的 HTTP 方法: {}", method))),
    };

    // 设置 headers
    if let Some(ref opts_table) = opts {
        if let Ok(headers_table) = opts_table.get::<Table>("headers") {
            for pair in headers_table.pairs::<String, String>() {
                if let Ok((k, v)) = pair {
                    req = req.header(&k, &v);
                }
            }
        }
    }

    // 设置 body
    if let Some(body_content) = body {
        req = req.header("content-type", "application/json");
        req = req.body(body_content.to_string());
    }

    // 发送请求
    let resp = req.send()
        .map_err(|e| mlua::Error::RuntimeError(format!("HTTP 请求失败: {}", e)))?;

    let status = resp.status().as_u16();
    let resp_headers: Vec<(String, String)> = resp.headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let resp_body = resp.text()
        .map_err(|e| mlua::Error::RuntimeError(format!("读取响应体失败: {}", e)))?;

    // 构建返回值
    let result = lua.create_table()?;
    result.set("status", status)?;
    result.set("body", resp_body.as_str())?;

    let headers_table = lua.create_table()?;
    for (k, v) in &resp_headers {
        headers_table.set(k.as_str(), v.as_str())?;
    }
    result.set("headers", headers_table)?;

    // 尝试自动 JSON 解码
    if let Ok(json_val) = serde_json::from_str::<JsonValue>(&resp_body) {
        result.set("json", LuaEngine::json_to_lua(lua, &json_val)?)?;
    }

    Ok(LuaValue::Table(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_json_encode_decode() {
        let lua = Lua::new();
        register_builtins(&lua).unwrap();

        lua.load(r#"
            local t = {name = "test", age = 30, active = true}
            local s = json.encode(t)
            local decoded = json.decode(s)
            assert(decoded.name == "test")
            assert(decoded.age == 30)
            assert(decoded.active == true)
        "#).exec().unwrap();
    }

    #[test]
    fn test_crypto_sha256() {
        let lua = Lua::new();
        register_builtins(&lua).unwrap();

        lua.load(r#"
            local hash = crypto.sha256("hello")
            assert(#hash == 64, "SHA256 should produce 64 hex chars")
        "#).exec().unwrap();
    }

    #[test]
    fn test_crypto_uuid() {
        let lua = Lua::new();
        register_builtins(&lua).unwrap();

        lua.load(r#"
            local id = crypto.uuid()
            assert(#id == 36, "UUID should be 36 chars")
        "#).exec().unwrap();
    }

    #[test]
    fn test_env_security() {
        let lua = Lua::new();
        register_builtins(&lua).unwrap();

        // 尝试读取非 PLUGIN_ 前缀的变量应失败
        let result = lua.load(r#"env.get("PATH")"#).exec();
        assert!(result.is_err());
    }

    #[test]
    fn test_log_module() {
        let lua = Lua::new();
        register_builtins(&lua).unwrap();

        // 日志调用不应 panic
        lua.load(r#"
            log.info("test info message")
            log.warn("test warn message")
            log.debug("test debug message")
        "#).exec().unwrap();
    }
}
