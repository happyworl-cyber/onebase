use mlua::{Lua, Result as LuaResult, Table, Value as LuaValue};
use serde_json::Value as JsonValue;
use std::collections::HashMap;

use crate::crypto_primitives as cp;
use crate::http_async_poll::{
    parse_async_poll_config, run_blocking_poll_loop, HttpExchange, PollRequest,
};
use crate::lua_engine::LuaEngine;

/// 统一把原语层的 String 错误包成 Lua RuntimeError。
fn crypto_err(msg: String) -> mlua::Error {
    mlua::Error::RuntimeError(msg)
}

/// 从 options table 读可选字符串字段，缺省时用 default。
fn tbl_str(t: &Table, key: &str, default: &str) -> LuaResult<String> {
    let v: Option<String> = t.get(key)?;
    Ok(v.unwrap_or_else(|| default.to_string()))
}

/// 读必填字符串字段，缺失即报错。
fn tbl_required_str(t: &Table, key: &str) -> LuaResult<String> {
    let v: Option<String> = t.get(key)?;
    v.ok_or_else(|| crypto_err(format!("crypto: 缺少必填字段 `{key}`")))
}

/// 读一个「值字段 + 编码字段」并解码成字节（值必填）。
fn tbl_decode_required(
    t: &Table,
    value_key: &str,
    enc_key: &str,
    default_enc: &str,
) -> LuaResult<Vec<u8>> {
    let s = tbl_required_str(t, value_key)?;
    let enc = tbl_str(t, enc_key, default_enc)?;
    cp::decode_input(&s, &enc).map_err(crypto_err)
}

/// 读一个「值字段 + 编码字段」并解码成字节（值可选，缺失返回 None）。
fn tbl_decode_optional(
    t: &Table,
    value_key: &str,
    enc_key: &str,
    default_enc: &str,
) -> LuaResult<Option<Vec<u8>>> {
    let v: Option<String> = t.get(value_key)?;
    match v {
        None => Ok(None),
        Some(s) => {
            let enc = tbl_str(t, enc_key, default_enc)?;
            Ok(Some(cp::decode_input(&s, &enc).map_err(crypto_err)?))
        }
    }
}

/// 注册所有内置模块到 Lua 环境
///
/// `env_vars` 为项目级环境变量（owned 副本），供 `env.get` 读取。Lua VM 运行在
/// spawn_blocking 线程内，无法异步查库，故由调用方在进入阻塞线程前一次性装好。
pub fn register_builtins(lua: &Lua, env_vars: HashMap<String, String>) -> LuaResult<()> {
    register_json_module(lua)?;
    register_log_module(lua)?;
    register_crypto_module(lua)?;
    register_env_module(lua, env_vars)?;
    register_sse_module(lua)?;
    register_time_module(lua)?;
    Ok(())
}

/// time 模块：读取墙钟时间。沙箱不加载 `os`，但 JWT 的 iat/exp、限流窗口等需要
/// 当前时间，故单独暴露一个最小只读时钟。不涉及沙箱逃逸。
fn register_time_module(lua: &Lua) -> LuaResult<()> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let time_mod = lua.create_table()?;

    // time.now() -> 当前 unix 时间（秒，整数）
    time_mod.set(
        "now",
        lua.create_function(|_, ()| {
            let secs = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            Ok(secs as i64)
        })?,
    )?;

    // time.now_ms() -> 当前 unix 时间（毫秒，整数）
    time_mod.set(
        "now_ms",
        lua.create_function(|_, ()| {
            let ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            Ok(ms as i64)
        })?,
    )?;

    lua.globals().set("time", time_mod)?;
    Ok(())
}

/// google 模块：`sa_assertion(project, scope)` —— 私钥全程留在 Rust。
///
/// 设计（见 plan「Lua Google SA 私钥隐藏」）：工作流作者只传 `project`，本函数用
/// `project + 当前工作流 tenant_id + 服务端保密盐` 经 SHA-256 派生出 K8s 密钥名，
/// 读取挂载在 Pod 里的 Service Account JSON，签出 Google OAuth 用的 RS256 JWT。
/// - `tenant_id` 由引擎透传（可信、用户不可伪造）→ 天然跨租户隔离；
/// - 盐 `FCM_KEY_SALT`、目录 `FCM_SECRETS_DIR`（默认 /app/secrets/fcm）走进程 env（不经
///   `env.get`，Lua 不可见）；私钥永不返回 / 不日志 / 不进 Lua。
///
/// 注：本函数是 Rust 宿主代码，`std::fs`/`std::env` 不受 Lua 沙箱（无 os/io）限制。
pub fn register_google_module(lua: &Lua, tenant_id: Option<i32>) -> LuaResult<()> {
    let google_mod = lua.create_table()?;

    // google.sa_assertion(project, scope) -> { assertion, project_id, client_email }
    // 返回表而非纯字符串：project_id 来自同一把 SA JSON，供 FCM v1 发送 URL
    // （projects/{project_id}）使用，保证「换 token 用的 SA」与「发送目标 project」永远一致，
    // 杜绝 azp/project 不匹配导致的 403。
    google_mod.set(
        "sa_assertion",
        lua.create_function(move |lua, (project, scope): (String, String)| {
            let tenant_id = tenant_id.ok_or_else(|| {
                mlua::Error::RuntimeError(
                    "google.sa_assertion: 缺少工作流租户上下文（tenant_id）".to_string(),
                )
            })?;
            let project = project.trim();
            if project.is_empty() {
                return Err(mlua::Error::RuntimeError(
                    "google.sa_assertion: project 不能为空".to_string(),
                ));
            }
            let scope = scope.trim();
            if scope.is_empty() {
                return Err(mlua::Error::RuntimeError(
                    "google.sa_assertion: scope 不能为空".to_string(),
                ));
            }

            // 保密盐（缺失即拒签，避免退化成可猜派生名）
            let salt = std::env::var("FCM_KEY_SALT")
                .ok()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    mlua::Error::RuntimeError(
                        "google.sa_assertion: 服务端未配置 FCM_KEY_SALT".to_string(),
                    )
                })?;
            let dir = std::env::var("FCM_SECRETS_DIR")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "/app/secrets/fcm".to_string());

            // 派生密钥名：确定性 SHA-256，hex 天然 path-safe（project 只进哈希、不入路径）
            let name = derive_fcm_secret_name(project, tenant_id, &salt);
            let path = std::path::Path::new(&dir).join(format!("{}.json", name));

            let sa_json = std::fs::read_to_string(&path).map_err(|_| {
                // 脱敏：不回显路径 / 盐 / 派生名
                mlua::Error::RuntimeError(
                    "google.sa_assertion: 未找到该 project 对应的 Service Account 凭据".to_string(),
                )
            })?;

            let (client_email, private_key, project_id) = parse_sa_json(&sa_json)
                .map_err(|e| mlua::Error::RuntimeError(format!("google.sa_assertion: {}", e)))?;

            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);

            let assertion = build_google_sa_jwt(&client_email, &private_key, scope, now)
                .map_err(|e| mlua::Error::RuntimeError(format!("google.sa_assertion: {}", e)))?;

            let out = lua.create_table()?;
            out.set("assertion", assertion)?;
            out.set("project_id", project_id)?;
            out.set("client_email", client_email)?;
            Ok(out)
        })?,
    )?;

    lua.globals().set("google", google_mod)?;
    Ok(())
}

/// Builds a Google Service Account assertion for trusted workflow host code.
///
/// This is the Rust-side implementation behind the Lua builtin and the
/// JavaScript host bridge. It deliberately accepts the tenant context as a
/// separate trusted input so scripts cannot choose another tenant's secret.
pub fn google_sa_assertion(
    tenant_id: Option<i32>,
    project: &str,
    scope: &str,
) -> Result<(String, String, String), String> {
    let tenant_id = tenant_id
        .ok_or_else(|| "google.sa_assertion: 缺少工作流租户上下文（tenant_id）".to_string())?;
    let project = project.trim();
    if project.is_empty() {
        return Err("google.sa_assertion: project 不能为空".to_string());
    }
    let scope = scope.trim();
    if scope.is_empty() {
        return Err("google.sa_assertion: scope 不能为空".to_string());
    }
    let salt = std::env::var("FCM_KEY_SALT")
        .ok()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "google.sa_assertion: 服务端未配置 FCM_KEY_SALT".to_string())?;
    let dir = std::env::var("FCM_SECRETS_DIR")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/app/secrets/fcm".to_string());
    let name = derive_fcm_secret_name(project, tenant_id, &salt);
    let path = std::path::Path::new(&dir).join(format!("{}.json", name));
    let sa_json = std::fs::read_to_string(&path).map_err(|_| {
        "google.sa_assertion: 未找到该 project 对应的 Service Account 凭据".to_string()
    })?;
    let (client_email, private_key, project_id) =
        parse_sa_json(&sa_json).map_err(|e| format!("google.sa_assertion: {e}"))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let assertion = build_google_sa_jwt(&client_email, &private_key, scope, now)
        .map_err(|e| format!("google.sa_assertion: {e}"))?;
    Ok((assertion, project_id, client_email))
}

/// 派生 K8s 密钥名：`hex(sha256(project \0 tenant_id \0 salt))`。确定性，供读写两侧共享
/// （运维放 Secret 时用 `fcm_secret_name` bin 算出同一名字）。
pub fn derive_fcm_secret_name(project: &str, tenant_id: i32, salt: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(project.as_bytes());
    hasher.update(b"\0");
    hasher.update(tenant_id.to_string().as_bytes());
    hasher.update(b"\0");
    hasher.update(salt.as_bytes());
    hex::encode(hasher.finalize())
}

/// 从 Service Account JSON 提取 `client_email`、`private_key`（PEM）与 `project_id`。
/// project_id 供 FCM v1 发送 URL 使用，保证与签名 SA 同源。
fn parse_sa_json(raw: &str) -> Result<(String, String, String), String> {
    let v: JsonValue = serde_json::from_str(raw).map_err(|_| "SA JSON 解析失败".to_string())?;
    let client_email = v
        .get("client_email")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "SA JSON 缺少 client_email".to_string())?;
    let private_key = v
        .get("private_key")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "SA JSON 缺少 private_key".to_string())?;
    let project_id = v
        .get("project_id")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "SA JSON 缺少 project_id".to_string())?;
    Ok((
        client_email.to_string(),
        private_key.to_string(),
        project_id.to_string(),
    ))
}

/// 用 SA 私钥签出 Google OAuth（jwt-bearer）用的 RS256 JWT assertion。
/// 私钥仅在本函数栈内使用，不返回、不日志。
fn build_google_sa_jwt(
    client_email: &str,
    private_key_pem: &str,
    scope: &str,
    now: u64,
) -> Result<String, String> {
    use base64::{engine::general_purpose, Engine as _};
    use rsa::pkcs1::DecodeRsaPrivateKey;
    use rsa::pkcs1v15::SigningKey;
    use rsa::pkcs8::DecodePrivateKey;
    use rsa::signature::{SignatureEncoding, Signer};
    use rsa::RsaPrivateKey;
    use sha2::Sha256;

    const TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
    let header = general_purpose::URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
    let claims = serde_json::json!({
        "iss": client_email,
        "scope": scope,
        "aud": TOKEN_URI,
        "iat": now,
        "exp": now + 3600,
    });
    let claims_str = serde_json::to_string(&claims).map_err(|_| "claims 序列化失败".to_string())?;
    let claims_b64 = general_purpose::URL_SAFE_NO_PAD.encode(claims_str.as_bytes());
    let signing_input = format!("{}.{}", header, claims_b64);

    let pem = private_key_pem.trim();
    let priv_key = RsaPrivateKey::from_pkcs8_pem(pem)
        .or_else(|_| RsaPrivateKey::from_pkcs1_pem(pem))
        .map_err(|_| "解析私钥失败".to_string())?;
    let signing_key = SigningKey::<Sha256>::new(priv_key);
    let sig = signing_key
        .try_sign(signing_input.as_bytes())
        .map_err(|_| "签名失败".to_string())?;
    let sig_b64 = general_purpose::URL_SAFE_NO_PAD.encode(sig.to_vec());
    Ok(format!("{}.{}", signing_input, sig_b64))
}

/// sse 模块：sse.publish(topic, event?, data?) —— 经全局 publisher 推送 SSE 消息。
///
/// 在工作流 Code 节点 / 定时任务 / RPC 插件等任意 Lua 上下文可用。
/// 返回 true 表示已投递；进程未注册 SSE（如集成测试）时返回 false（no-op）。
fn register_sse_module(lua: &Lua) -> LuaResult<()> {
    let sse_mod = lua.create_table()?;

    sse_mod.set(
        "publish",
        lua.create_function(
            |_lua, (topic, event, data): (String, Option<String>, Option<LuaValue>)| {
                if topic.trim().is_empty() {
                    return Err(mlua::Error::RuntimeError(
                        "sse.publish: topic 不能为空".to_string(),
                    ));
                }
                let event = event
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "message".to_string());
                let data_json = match data {
                    Some(v) => LuaEngine::lua_to_json(&v),
                    None => JsonValue::Null,
                };
                Ok(crate::sse_publisher::publish(topic, event, data_json))
            },
        )?,
    )?;

    lua.globals().set("sse", sse_mod)?;
    Ok(())
}

/// json 模块：encode / decode
fn register_json_module(lua: &Lua) -> LuaResult<()> {
    let json_mod = lua.create_table()?;

    // json.encode(table) -> string
    json_mod.set(
        "encode",
        lua.create_function(|_lua, val: LuaValue| {
            let json_val = LuaEngine::lua_to_json(&val);
            serde_json::to_string(&json_val)
                .map_err(|e| mlua::Error::RuntimeError(format!("json.encode 失败: {}", e)))
        })?,
    )?;

    // json.encode_pretty(table) -> string
    json_mod.set(
        "encode_pretty",
        lua.create_function(|_lua, val: LuaValue| {
            let json_val = LuaEngine::lua_to_json(&val);
            serde_json::to_string_pretty(&json_val)
                .map_err(|e| mlua::Error::RuntimeError(format!("json.encode_pretty 失败: {}", e)))
        })?,
    )?;

    // json.decode(string) -> table
    json_mod.set(
        "decode",
        lua.create_function(|lua, s: String| {
            let val: JsonValue = serde_json::from_str(&s)
                .map_err(|e| mlua::Error::RuntimeError(format!("json.decode 失败: {}", e)))?;
            LuaEngine::json_to_lua(lua, &val)
        })?,
    )?;

    lua.globals().set("json", json_mod)?;
    Ok(())
}

/// log 模块：info / warn / error / debug
fn register_log_module(lua: &Lua) -> LuaResult<()> {
    let log_mod = lua.create_table()?;

    log_mod.set(
        "info",
        lua.create_function(|_, msg: String| {
            tracing::info!(target: "lua_plugin", "{}", msg);
            Ok(())
        })?,
    )?;

    log_mod.set(
        "warn",
        lua.create_function(|_, msg: String| {
            tracing::warn!(target: "lua_plugin", "{}", msg);
            Ok(())
        })?,
    )?;

    log_mod.set(
        "error",
        lua.create_function(|_, msg: String| {
            tracing::error!(target: "lua_plugin", "{}", msg);
            Ok(())
        })?,
    )?;

    log_mod.set(
        "debug",
        lua.create_function(|_, msg: String| {
            tracing::debug!(target: "lua_plugin", "{}", msg);
            Ok(())
        })?,
    )?;

    lua.globals().set("log", log_mod)?;
    Ok(())
}

/// crypto 模块：sha256 / uuid
fn register_crypto_module(lua: &Lua) -> LuaResult<()> {
    let crypto_mod = lua.create_table()?;

    // crypto.sha256(input) -> hex string
    crypto_mod.set(
        "sha256",
        lua.create_function(|_, input: String| {
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(input.as_bytes());
            Ok(hex::encode(hasher.finalize()))
        })?,
    )?;

    // crypto.hmac_sha256(key, data) -> hex string
    crypto_mod.set(
        "hmac_sha256",
        lua.create_function(|_, (key, data): (String, String)| {
            use hmac::{Hmac, Mac};
            use sha2::Sha256;
            type HmacSha256 = Hmac<Sha256>;

            let mut mac = HmacSha256::new_from_slice(key.as_bytes())
                .map_err(|e| mlua::Error::RuntimeError(e.to_string()))?;
            mac.update(data.as_bytes());
            Ok(hex::encode(mac.finalize().into_bytes()))
        })?,
    )?;

    // crypto.hmac_sha256_raw_key(base64_key, data) -> hex string
    // base64_key: Base64 编码的原始密钥（如 Stripe whsec_ 去掉前缀后的部分）
    crypto_mod.set(
        "hmac_sha256_raw_key",
        lua.create_function(|_, (base64_key, data): (String, String)| {
            use base64::{engine::general_purpose, Engine as _};
            use hmac::{Hmac, Mac};
            use sha2::Sha256;
            type HmacSha256 = Hmac<Sha256>;

            let key_bytes = general_purpose::STANDARD
                .decode(base64_key.as_bytes())
                .map_err(|e| mlua::Error::RuntimeError(format!("base64 decode failed: {}", e)))?;
            let mut mac = HmacSha256::new_from_slice(&key_bytes)
                .map_err(|e| mlua::Error::RuntimeError(e.to_string()))?;
            mac.update(data.as_bytes());
            Ok(hex::encode(mac.finalize().into_bytes()))
        })?,
    )?;

    // crypto.uuid() -> random UUID v4
    crypto_mod.set(
        "uuid",
        lua.create_function(|_, ()| Ok(uuid::Uuid::new_v4().to_string()))?,
    )?;

    // crypto.random_hex(len) -> random hex string
    crypto_mod.set(
        "random_hex",
        lua.create_function(|_, len: usize| {
            use rand::Rng;
            let byte_len = (len + 1) / 2;
            let bytes: Vec<u8> = (0..byte_len).map(|_| rand::thread_rng().gen()).collect();
            let s = hex::encode(&bytes);
            Ok(s[..len.min(s.len())].to_string())
        })?,
    )?;

    // crypto.md5(input, output_encoding?) -> 默认 hex。仅用于兼容旧系统，勿用于安全场景。
    crypto_mod.set(
        "md5",
        lua.create_function(|_, (input, out_enc): (String, Option<String>)| {
            let digest = cp::md5(input.as_bytes());
            cp::encode_output(&digest, &out_enc.unwrap_or_else(|| "hex".to_string()))
                .map_err(crypto_err)
        })?,
    )?;

    // crypto.sha1(input, output_encoding?) -> 默认 hex。
    crypto_mod.set(
        "sha1",
        lua.create_function(|_, (input, out_enc): (String, Option<String>)| {
            let digest = cp::sha1(input.as_bytes());
            cp::encode_output(&digest, &out_enc.unwrap_or_else(|| "hex".to_string()))
                .map_err(crypto_err)
        })?,
    )?;

    // crypto.hmac_sha1(key, data, output_encoding?) -> 默认 hex。key/data 按 utf8 取字节。
    crypto_mod.set(
        "hmac_sha1",
        lua.create_function(
            |_, (key, data, out_enc): (String, String, Option<String>)| {
                let mac = cp::hmac_sha1(key.as_bytes(), data.as_bytes()).map_err(crypto_err)?;
                cp::encode_output(&mac, &out_enc.unwrap_or_else(|| "hex".to_string()))
                    .map_err(crypto_err)
            },
        )?,
    )?;

    // crypto.aes_encrypt(opts) -> 密文（默认 base64）。
    //
    // opts 字段：
    //   mode            = "cbc" | "gcm" | "ecb"（默认 cbc）
    //   key             = 密钥字符串（必填）
    //   key_encoding    = "utf8" | "hex" | "base64" | "base64url"（默认 utf8）
    //   iv              = IV/Nonce（cbc/gcm 必填；cbc 需 16 字节、gcm 需 12 字节）
    //   iv_encoding     = 同上（默认 utf8）
    //   padding         = "pkcs7" | "zero" | "none"（cbc/ecb，默认 pkcs7）
    //   plaintext       = 明文（必填）
    //   input_encoding  = 明文编码（默认 utf8）
    //   output_encoding = 密文输出编码（默认 base64）
    //   aad / aad_encoding = 仅 gcm，附加认证数据（可选）
    // gcm 输出为 `密文 || 16 字节 tag`。
    crypto_mod.set(
        "aes_encrypt",
        lua.create_function(|_, opts: Table| {
            let mode = tbl_str(&opts, "mode", "cbc")?.to_ascii_lowercase();
            let key = tbl_decode_required(&opts, "key", "key_encoding", "utf8")?;
            let padding = tbl_str(&opts, "padding", "pkcs7")?;
            let input_enc = tbl_str(&opts, "input_encoding", "utf8")?;
            let out_enc = tbl_str(&opts, "output_encoding", "base64")?;
            let plaintext = {
                let s = tbl_required_str(&opts, "plaintext")?;
                cp::decode_input(&s, &input_enc).map_err(crypto_err)?
            };
            let ct = match mode.as_str() {
                "cbc" => {
                    let iv = tbl_decode_required(&opts, "iv", "iv_encoding", "utf8")?;
                    cp::aes_cbc_encrypt(&key, &iv, &padding, &plaintext).map_err(crypto_err)?
                }
                "ecb" => cp::aes_ecb_encrypt(&key, &padding, &plaintext).map_err(crypto_err)?,
                "gcm" => {
                    let iv = tbl_decode_required(&opts, "iv", "iv_encoding", "utf8")?;
                    let aad = tbl_decode_optional(&opts, "aad", "aad_encoding", "utf8")?
                        .unwrap_or_default();
                    cp::aes_gcm_encrypt(&key, &iv, &aad, &plaintext).map_err(crypto_err)?
                }
                other => {
                    return Err(crypto_err(format!(
                        "crypto.aes_encrypt: 不支持的 mode `{other}`（可选 cbc/gcm/ecb）"
                    )))
                }
            };
            cp::encode_output(&ct, &out_enc).map_err(crypto_err)
        })?,
    )?;

    // crypto.aes_decrypt(opts) -> 明文（默认 utf8）。字段同 aes_encrypt，但：
    //   ciphertext      = 密文（必填）
    //   input_encoding  = 密文编码（默认 base64）
    //   output_encoding = 明文输出编码（默认 utf8）
    crypto_mod.set(
        "aes_decrypt",
        lua.create_function(|_, opts: Table| {
            let mode = tbl_str(&opts, "mode", "cbc")?.to_ascii_lowercase();
            let key = tbl_decode_required(&opts, "key", "key_encoding", "utf8")?;
            let padding = tbl_str(&opts, "padding", "pkcs7")?;
            let input_enc = tbl_str(&opts, "input_encoding", "base64")?;
            let out_enc = tbl_str(&opts, "output_encoding", "utf8")?;
            let ciphertext = {
                let s = tbl_required_str(&opts, "ciphertext")?;
                cp::decode_input(&s, &input_enc).map_err(crypto_err)?
            };
            let pt = match mode.as_str() {
                "cbc" => {
                    let iv = tbl_decode_required(&opts, "iv", "iv_encoding", "utf8")?;
                    cp::aes_cbc_decrypt(&key, &iv, &padding, &ciphertext).map_err(crypto_err)?
                }
                "ecb" => cp::aes_ecb_decrypt(&key, &padding, &ciphertext).map_err(crypto_err)?,
                "gcm" => {
                    let iv = tbl_decode_required(&opts, "iv", "iv_encoding", "utf8")?;
                    let aad = tbl_decode_optional(&opts, "aad", "aad_encoding", "utf8")?
                        .unwrap_or_default();
                    cp::aes_gcm_decrypt(&key, &iv, &aad, &ciphertext).map_err(crypto_err)?
                }
                other => {
                    return Err(crypto_err(format!(
                        "crypto.aes_decrypt: 不支持的 mode `{other}`（可选 cbc/gcm/ecb）"
                    )))
                }
            };
            cp::encode_output(&pt, &out_enc).map_err(crypto_err)
        })?,
    )?;

    // crypto.base64_encode(input) -> base64 string（RSA 密文/二进制常用）
    crypto_mod.set(
        "base64_encode",
        lua.create_function(|_, input: mlua::String| {
            use base64::{engine::general_purpose, Engine as _};
            Ok(general_purpose::STANDARD.encode(input.as_bytes()))
        })?,
    )?;

    // crypto.base64_decode(b64) -> string（解码结果按字节原样返回）
    crypto_mod.set(
        "base64_decode",
        lua.create_function(|lua, b64: String| {
            use base64::{engine::general_purpose, Engine as _};
            let bytes = general_purpose::STANDARD
                .decode(b64.trim().as_bytes())
                .map_err(|e| mlua::Error::RuntimeError(format!("base64_decode 失败: {}", e)))?;
            lua.create_string(&bytes)
        })?,
    )?;

    // crypto.rsa_encrypt(public_key_pem, plaintext) -> base64 密文
    // 填充：RSA PKCS#1 v1.5（互通场景最常见默认）。公钥 PEM 同时兼容
    // PKCS#8/SPKI（BEGIN PUBLIC KEY）与 PKCS#1（BEGIN RSA PUBLIC KEY）两种格式。
    crypto_mod.set(
        "rsa_encrypt",
        lua.create_function(|_, (pem, plaintext): (String, mlua::String)| {
            use base64::{engine::general_purpose, Engine as _};
            use rsa::pkcs1::DecodeRsaPublicKey;
            use rsa::pkcs8::DecodePublicKey;
            use rsa::{Pkcs1v15Encrypt, RsaPublicKey};

            let pem = pem.trim();
            let pub_key = RsaPublicKey::from_public_key_pem(pem)
                .or_else(|_| RsaPublicKey::from_pkcs1_pem(pem))
                .map_err(|e| {
                    mlua::Error::RuntimeError(format!("rsa_encrypt: 解析公钥失败: {}", e))
                })?;
            let mut rng = rsa::rand_core::OsRng;
            let enc = pub_key
                .encrypt(&mut rng, Pkcs1v15Encrypt, &plaintext.as_bytes())
                .map_err(|e| mlua::Error::RuntimeError(format!("rsa_encrypt: 加密失败: {}", e)))?;
            Ok(general_purpose::STANDARD.encode(enc))
        })?,
    )?;

    // crypto.rsa_encrypt_oaep(public_key_pem, plaintext) -> base64 密文
    // 填充：RSA-OAEP with SHA-256（现代推荐）。公钥 PEM 格式兼容同 rsa_encrypt。
    crypto_mod.set(
        "rsa_encrypt_oaep",
        lua.create_function(|_, (pem, plaintext): (String, mlua::String)| {
            use base64::{engine::general_purpose, Engine as _};
            use rsa::pkcs1::DecodeRsaPublicKey;
            use rsa::pkcs8::DecodePublicKey;
            use rsa::{Oaep, RsaPublicKey};
            use sha2::Sha256;

            let pem = pem.trim();
            let pub_key = RsaPublicKey::from_public_key_pem(pem)
                .or_else(|_| RsaPublicKey::from_pkcs1_pem(pem))
                .map_err(|e| {
                    mlua::Error::RuntimeError(format!("rsa_encrypt_oaep: 解析公钥失败: {}", e))
                })?;
            let mut rng = rsa::rand_core::OsRng;
            let enc = pub_key
                .encrypt(&mut rng, Oaep::new::<Sha256>(), &plaintext.as_bytes())
                .map_err(|e| {
                    mlua::Error::RuntimeError(format!("rsa_encrypt_oaep: 加密失败: {}", e))
                })?;
            Ok(general_purpose::STANDARD.encode(enc))
        })?,
    )?;

    // crypto.rsa_decrypt(private_key_pem, base64_ciphertext) -> 明文（PKCS#1 v1.5）
    // 主要用于自测/回环验证。私钥 PEM 兼容 PKCS#8（BEGIN PRIVATE KEY）
    // 与 PKCS#1（BEGIN RSA PRIVATE KEY）两种格式。
    crypto_mod.set(
        "rsa_decrypt",
        lua.create_function(|lua, (pem, b64): (String, String)| {
            use base64::{engine::general_purpose, Engine as _};
            use rsa::pkcs1::DecodeRsaPrivateKey;
            use rsa::pkcs8::DecodePrivateKey;
            use rsa::{Pkcs1v15Encrypt, RsaPrivateKey};

            let pem = pem.trim();
            let priv_key = RsaPrivateKey::from_pkcs8_pem(pem)
                .or_else(|_| RsaPrivateKey::from_pkcs1_pem(pem))
                .map_err(|e| {
                    mlua::Error::RuntimeError(format!("rsa_decrypt: 解析私钥失败: {}", e))
                })?;
            let ct = general_purpose::STANDARD
                .decode(b64.trim().as_bytes())
                .map_err(|e| {
                    mlua::Error::RuntimeError(format!("rsa_decrypt: base64 解码失败: {}", e))
                })?;
            let dec = priv_key
                .decrypt(Pkcs1v15Encrypt, &ct)
                .map_err(|e| mlua::Error::RuntimeError(format!("rsa_decrypt: 解密失败: {}", e)))?;
            lua.create_string(&dec)
        })?,
    )?;

    // crypto.rsa_sign_sha256(private_key_pem, message) -> base64 签名
    // 算法：RSASSA-PKCS1-v1.5 + SHA-256（即 JWT 的 RS256）。用于在 Lua 里自建
    // RS256 JWT assertion（如 Google Service Account 换 OAuth token）。
    // 私钥 PEM 兼容 PKCS#8（BEGIN PRIVATE KEY）与 PKCS#1（BEGIN RSA PRIVATE KEY）。
    crypto_mod.set(
        "rsa_sign_sha256",
        lua.create_function(|_, (pem, message): (String, mlua::String)| {
            use base64::{engine::general_purpose, Engine as _};
            use rsa::pkcs1::DecodeRsaPrivateKey;
            use rsa::pkcs1v15::SigningKey;
            use rsa::pkcs8::DecodePrivateKey;
            use rsa::signature::{SignatureEncoding, Signer};
            use rsa::RsaPrivateKey;
            use sha2::Sha256;

            let pem = pem.trim();
            let priv_key = RsaPrivateKey::from_pkcs8_pem(pem)
                .or_else(|_| RsaPrivateKey::from_pkcs1_pem(pem))
                .map_err(|e| {
                    mlua::Error::RuntimeError(format!("rsa_sign_sha256: 解析私钥失败: {}", e))
                })?;
            let signing_key = SigningKey::<Sha256>::new(priv_key);
            let sig = signing_key.try_sign(&message.as_bytes()).map_err(|e| {
                mlua::Error::RuntimeError(format!("rsa_sign_sha256: 签名失败: {}", e))
            })?;
            Ok(general_purpose::STANDARD.encode(sig.to_vec()))
        })?,
    )?;

    // crypto.base64url_encode(input) -> base64url 字符串（无 padding）
    // JWT 各段（header/payload/signature）用的就是 URL-safe、无 `=` 的 base64。
    crypto_mod.set(
        "base64url_encode",
        lua.create_function(|_, input: mlua::String| {
            use base64::{engine::general_purpose, Engine as _};
            Ok(general_purpose::URL_SAFE_NO_PAD.encode(input.as_bytes()))
        })?,
    )?;

    lua.globals().set("crypto", crypto_mod)?;
    Ok(())
}

/// env 模块：读取项目级环境变量
///
/// 语义变化（相对旧版，写入文档）：
/// - 数据源从进程 `std::env::var` 改为闭包捕获的项目变量 HashMap（执行期从 DB 解密装入）；
/// - 取消 `PLUGIN_` 前缀限制——任意变量名都可读取；
/// - 未命中由"抛 Lua 错误"改为**返回 nil**，调用方可用 `env.get(x) or default` 兜底。
fn register_env_module(lua: &Lua, env_vars: HashMap<String, String>) -> LuaResult<()> {
    let env_mod = lua.create_table()?;

    // env.get(key) -> string | nil（未配置返回 nil，不再抛错）
    env_mod.set(
        "get",
        lua.create_function(move |_, key: String| Ok(env_vars.get(&key).cloned()))?,
    )?;

    lua.globals().set("env", env_mod)?;
    Ok(())
}

/// HTTP 请求结果（用于从阻塞线程返回）
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
    pub headers: Vec<(String, String)>,
}

/// http 模块的报错 stub（生产只读护栏）：API 面与真实模块一致，调用即报错。
/// 让 AI 在生产库调试时得到明确的错误信息，而不是静默成功或 nil 引用崩溃。
pub fn register_http_module_disabled(lua: &Lua) -> LuaResult<()> {
    let http_mod = lua.create_table()?;
    for method in ["get", "post", "put", "patch", "delete", "request"] {
        http_mod.set(
            method,
            lua.create_function(|_, _args: mlua::MultiValue| -> LuaResult<()> {
                Err(mlua::Error::RuntimeError(
                    "生产环境调试禁止 Lua http（production_readonly）".to_string(),
                ))
            })?,
        )?;
    }
    lua.globals().set("http", http_mod)?;
    Ok(())
}

/// 注册 HTTP 模块（需要在异步上下文中使用 —— 目前用同步阻塞实现）
///
/// 因为 Lua 在 spawn_blocking 中运行，HTTP 请求也使用阻塞的 reqwest::blocking。
/// URL scheme 不做限制，HTTP / HTTPS 均放行（生产只读护栏另走 disabled stub 封死）。
pub fn register_http_module(lua: &Lua) -> LuaResult<()> {
    let http_mod = lua.create_table()?;

    // http.get(url, opts?) -> {status, body, headers}
    http_mod.set(
        "get",
        lua.create_function(|lua, (url, opts): (String, Option<Table>)| {
            do_http_request(lua, "GET", &url, opts, None)
        })?,
    )?;

    // http.post(url, body, opts?) -> {status, body, headers}
    http_mod.set(
        "post",
        lua.create_function(
            |lua, (url, body, opts): (String, Option<LuaValue>, Option<Table>)| {
                let body_str = match body {
                    Some(LuaValue::String(s)) => Some(s.to_string_lossy().to_string()),
                    Some(val) => {
                        let json_val = LuaEngine::lua_to_json(&val);
                        Some(serde_json::to_string(&json_val).unwrap_or_default())
                    }
                    None => None,
                };
                do_http_request(lua, "POST", &url, opts, body_str.as_deref())
            },
        )?,
    )?;

    // http.put(url, body, opts?) -> {status, body, headers}
    http_mod.set(
        "put",
        lua.create_function(
            |lua, (url, body, opts): (String, Option<LuaValue>, Option<Table>)| {
                let body_str = match body {
                    Some(LuaValue::String(s)) => Some(s.to_string_lossy().to_string()),
                    Some(val) => {
                        let json_val = LuaEngine::lua_to_json(&val);
                        Some(serde_json::to_string(&json_val).unwrap_or_default())
                    }
                    None => None,
                };
                do_http_request(lua, "PUT", &url, opts, body_str.as_deref())
            },
        )?,
    )?;

    // http.delete(url, opts?) -> {status, body, headers}
    http_mod.set(
        "delete",
        lua.create_function(|lua, (url, opts): (String, Option<Table>)| {
            do_http_request(lua, "DELETE", &url, opts, None)
        })?,
    )?;

    lua.globals().set("http", http_mod)?;
    Ok(())
}

/// 从 opts 表读取超时配置，返回秒数（None = 未配置，交由调用方取默认）。
/// 接受 `timeout_secs`（优先）与 `timeout` 两个键；值可为整数/浮点/字符串。
/// 负数视为未配置；0 表示显式不限制超时。
fn opts_timeout_secs(opts: &Table) -> Option<u64> {
    for key in ["timeout_secs", "timeout"] {
        if let Ok(v) = opts.get::<LuaValue>(key) {
            let parsed = match v {
                LuaValue::Integer(n) if n >= 0 => Some(n as u64),
                LuaValue::Number(n) if n >= 0.0 => Some(n as u64),
                LuaValue::String(s) => s.to_string_lossy().trim().parse::<u64>().ok(),
                _ => None,
            };
            if parsed.is_some() {
                return parsed;
            }
        }
    }
    None
}

fn opts_async_poll_config(opts: Option<&Table>) -> crate::http_async_poll::AsyncPollConfig {
    let config = opts
        .map(|table| LuaEngine::lua_to_json(&LuaValue::Table(table.clone())))
        .unwrap_or(JsonValue::Null);
    parse_async_poll_config(&config)
}

fn blocking_response_to_exchange(
    response: reqwest::blocking::Response,
) -> Result<HttpExchange, String> {
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .map(|(key, value)| (key.to_string(), value.to_str().unwrap_or("").to_string()))
        .collect();
    let body_text = response.text().map_err(|error| error.to_string())?;
    let body =
        serde_json::from_str(&body_text).unwrap_or_else(|_| JsonValue::String(body_text.clone()));
    Ok(HttpExchange {
        status,
        headers,
        body,
        body_text,
    })
}

fn http_exchange_to_lua<'lua>(
    lua: &'lua Lua,
    exchange: HttpExchange,
    poll_meta: Option<JsonValue>,
) -> LuaResult<LuaValue> {
    let result = lua.create_table()?;
    result.set("status", exchange.status)?;
    result.set("body", exchange.body_text.as_str())?;

    let headers_table = lua.create_table()?;
    for (key, value) in exchange.headers {
        headers_table.set(key, value)?;
    }
    result.set("headers", headers_table)?;
    if let Ok(json) = serde_json::from_str::<JsonValue>(&exchange.body_text) {
        result.set("json", LuaEngine::json_to_lua(lua, &json)?)?;
    }
    if let Some(meta) = poll_meta {
        result.set("async_poll", LuaEngine::json_to_lua(lua, &meta)?)?;
    }
    Ok(LuaValue::Table(result))
}

fn do_http_request<'lua>(
    lua: &'lua Lua,
    method: &str,
    url: &str,
    opts: Option<Table>,
    body: Option<&str>,
) -> LuaResult<LuaValue> {
    // 超时秒数：优先读 opts.timeout_secs（兼容 timeout），单位秒；0 = 不限制。
    // 未显式配置时取 workflow_engine::http_default_timeout_secs()
    // （环境变量 WORKFLOW_HTTP_DEFAULT_TIMEOUT_SECS，缺省 120；全局关闭超时时为 0）。
    // 历史上此处硬编码 10s，会忽略脚本传入的 timeout 参数，导致 LLM 等长耗时请求
    // 在 10s 被强制中断（operation timed out）。
    let timeout_secs = opts
        .as_ref()
        .and_then(|t| opts_timeout_secs(t))
        .unwrap_or_else(crate::workflow_engine::http_default_timeout_secs);
    let async_poll_config = opts_async_poll_config(opts.as_ref());

    // 构建请求
    let mut builder = reqwest::blocking::Client::builder();
    if timeout_secs > 0 {
        builder = builder.timeout(std::time::Duration::from_secs(timeout_secs));
    }
    let client = builder
        .build()
        .map_err(|e| mlua::Error::RuntimeError(format!("HTTP 客户端创建失败: {}", e)))?;

    let mut req = match method {
        "GET" => client.get(url),
        "POST" => client.post(url),
        "PUT" => client.put(url),
        "DELETE" => client.delete(url),
        "PATCH" => client.patch(url),
        _ => {
            return Err(mlua::Error::RuntimeError(format!(
                "不支持的 HTTP 方法: {}",
                method
            )))
        }
    };

    let mut auth_headers = HashMap::new();

    // 设置 headers
    if let Some(ref opts_table) = opts {
        if let Ok(headers_table) = opts_table.get::<Table>("headers") {
            for pair in headers_table.pairs::<String, String>() {
                if let Ok((k, v)) = pair {
                    req = req.header(&k, &v);
                    auth_headers.insert(k, v);
                }
            }
        }
    }

    // 设置 body（不强制覆盖 content-type，由调用方通过 opts.headers 控制）
    if let Some(body_content) = body {
        req = req.body(body_content.to_string());
    }

    // 发送请求
    let resp = req
        .send()
        .map_err(|e| mlua::Error::RuntimeError(format!("HTTP 请求失败: {}", e)))?;
    let initial = blocking_response_to_exchange(resp)
        .map_err(|error| mlua::Error::RuntimeError(format!("读取响应体失败: {error}")))?;

    if !async_poll_config.enabled {
        return http_exchange_to_lua(lua, initial, None);
    }
    let mut poll_builder = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none());
    if timeout_secs > 0 {
        poll_builder = poll_builder.timeout(std::time::Duration::from_secs(timeout_secs));
    }
    let poll_client = poll_builder
        .build()
        .map_err(|e| mlua::Error::RuntimeError(format!("HTTP 轮询客户端创建失败: {}", e)))?;

    let (final_exchange, poll_meta) = run_blocking_poll_loop(
        &async_poll_config,
        url,
        initial,
        &auth_headers,
        |poll_request| send_blocking_poll_request(&poll_client, poll_request),
    )
    .map_err(mlua::Error::RuntimeError)?;
    http_exchange_to_lua(lua, final_exchange, Some(poll_meta))
}

fn send_blocking_poll_request(
    client: &reqwest::blocking::Client,
    request: PollRequest,
) -> Result<HttpExchange, String> {
    let mut builder = match request.method.as_str() {
        "GET" => client.get(&request.url),
        "POST" => client.post(&request.url),
        unsupported => return Err(format!("不支持的轮询 HTTP 方法: {unsupported}")),
    };
    for (key, value) in request.headers {
        builder = builder.header(key, value);
    }
    if let Some(body) = request.json_body {
        builder = builder.json(&body);
    }
    let response = builder.send().map_err(|error| error.to_string())?;
    blocking_response_to_exchange(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    // 2048-bit 测试密钥对（PKCS#8 私钥 / SPKI 公钥），仅用于单测，无生产用途。
    const TEST_RSA_PRIV_PEM: &str = "-----BEGIN PRIVATE KEY-----\n\
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC9ZhFJNVokQTNr\n\
adOPdZzJITZ+wjUuCGNp85Q5xJhZ33r92d3b8cL118B7j1oq9LUb7XsWhBYq3eNj\n\
9cvJQm1B9nk9acS/SmdPSSlsPVnIyHivLMj4TnANw8kEvrDpmzxXwPn+S/vDU9SZ\n\
5izyylyMXt9n/aKey/DHLKRDXH2fpW+UveqmvLRk/joEpKHhJZYt+5npPNPnr80t\n\
8Vb/wduI7CpsgabhLPYZaIM7rrwNOf/G1Ze+su2IGGMzBBPt7hy48I9S4U8ErM6O\n\
3XufAp/dMv4IWIkUg79skk3/ntL0Ulj+cOlxDs+YgFrEvUDknRgjQzG6+TgJ29u0\n\
DKWMIviZAgMBAAECggEAHn9l/yzZJAdfuUckKvCcW4K+nLC3EX+GSpRPZPH0OlyT\n\
GHdRk04dv6qLMxpFQa9/zkxySpDgZOyv5fO5aeIJZ9rBcRMr/EWF1y2HvwcuAvfM\n\
/yAuCFXRE1ZYcywlnqhBkjvfxYQEuVIxZMq8qCfPuUa5oKwl2H4selYE6VfmXqNl\n\
ARhx+sFJNTEQwgNHKVYqqA61zFo0Awz2HCauIWFrubWxHfsRTN8YdVLtGOt/Re7I\n\
zaAaS2iLXEeynTKnf65TPSV0kp681794ayscsfT+mTtXelcaha1axjSdf4FF/TsU\n\
mWhPMCwQEsjIUyVjM5F3OMUDV02YZFCV1ND/YywiRQKBgQDq7bQ7rnRLgzkw4u66\n\
aqNQkGQU3Ds/DsaDpg0HWWCt6D8fgP3y6Yel2NTW6RiO6pjgv8wuh1TcJkJrm9ms\n\
NPanb/rTxjg8KM7KN0PeIGTHFtkspY/B9DmtuOGP5D8wRlx0lQD1FS8jsP7Yf06g\n\
9xxiMsMMp4wWENJYBpoOro2LgwKBgQDOYu7srbri8GpJLBejL0DxpsbmbETwP0hm\n\
o2f0iJOoWSbZS4Zv+OXI2vkQP0Mu64M9upOEQIqD3MCS3yiLbEP4ro/ajMxoNncV\n\
hqYQKbHxj78Ud+Y7IrfaKR3KsbWF2SOTOyeBEh8sn6fb4kU0/1EMPtmPGiW/UM4T\n\
1glHOIQkswKBgErIjD0LVZ3MEeKL+q6Az6gPrqwtRvbVvz+dFjymqO3zJlTi/PPc\n\
fv++PFKFNPoZl7zDkT2mes7xpucWX35ABdxa+x9609/ipaEdYo9NBIeTsGJT+aUm\n\
F05DshnZ8HtvinLaE8nwimb0KsvECsWWpARmYEyg8Sj9BdhbkaLm0cv9AoGBAJFv\n\
Ofpiej2NOPiTL5z4oYUoByU8yl+Z2IUrRQgWbibFnBCnnfatqA8f7z65tbgMkhEf\n\
tvANIw7EspdM1h9ZjZRiPlC9wxT0vHnYxpDBMPmOWBIuY3jsgC4lpy68h7PoTZ9k\n\
ofPcN0eUwg66phYwjIZai6jBvjPQ10c3HpanhsbtAoGBAL9NQ68O9zcMhGFo42KO\n\
GSYXtVU2a5hxeVb52Q438okFJELpgLABGpDEaL7i4FQqjuu9tqQyOrBdZD1AOshZ\n\
Ax/sk2fcndv5p+ppl/rBiya50XAzvWEtfoEG1fTa7na2d7aUK/J6oOV8KeX1nta3\n\
5+aRr/Ze0s6w97Wo3y2O+xQv\n\
-----END PRIVATE KEY-----";
    const TEST_RSA_PUB_PEM: &str = "-----BEGIN PUBLIC KEY-----\n\
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvWYRSTVaJEEza2nTj3Wc\n\
ySE2fsI1LghjafOUOcSYWd96/dnd2/HC9dfAe49aKvS1G+17FoQWKt3jY/XLyUJt\n\
QfZ5PWnEv0pnT0kpbD1ZyMh4ryzI+E5wDcPJBL6w6Zs8V8D5/kv7w1PUmeYs8spc\n\
jF7fZ/2insvwxyykQ1x9n6VvlL3qpry0ZP46BKSh4SWWLfuZ6TzT56/NLfFW/8Hb\n\
iOwqbIGm4Sz2GWiDO668DTn/xtWXvrLtiBhjMwQT7e4cuPCPUuFPBKzOjt17nwKf\n\
3TL+CFiJFIO/bJJN/57S9FJY/nDpcQ7PmIBaxL1A5J0YI0Mxuvk4CdvbtAyljCL4\n\
mQIDAQAB\n\
-----END PUBLIC KEY-----";

    #[test]
    fn test_derive_fcm_secret_name_deterministic() {
        let a = derive_fcm_secret_name("im30-way", 4, "salt-x");
        let b = derive_fcm_secret_name("im30-way", 4, "salt-x");
        assert_eq!(a, b, "同输入应确定性一致");
        assert_eq!(a.len(), 64, "sha256 hex 应为 64 字符");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()), "应为 hex（path-safe）");
        // 任一因子变化 → 派生名变化
        assert_ne!(a, derive_fcm_secret_name("im30-way", 5, "salt-x"), "换 tenant 应变");
        assert_ne!(a, derive_fcm_secret_name("other", 4, "salt-x"), "换 project 应变");
        assert_ne!(a, derive_fcm_secret_name("im30-way", 4, "salt-y"), "换盐应变");
    }

    #[test]
    fn test_parse_sa_json() {
        let raw = r#"{"type":"service_account","client_email":"a@b.iam","private_key":"KEY","project_id":"p"}"#;
        let (email, key, project_id) = parse_sa_json(raw).unwrap();
        assert_eq!(email, "a@b.iam");
        assert_eq!(key, "KEY");
        assert_eq!(project_id, "p");
        // 缺字段报错
        assert!(parse_sa_json(r#"{"client_email":"a@b","private_key":"K"}"#).is_err());
        assert!(parse_sa_json("not json").is_err());
    }

    #[test]
    fn test_build_google_sa_jwt_verifies() {
        use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};

        let jwt = build_google_sa_jwt(
            "sa@test.iam.gserviceaccount.com",
            TEST_RSA_PRIV_PEM,
            "https://www.googleapis.com/auth/firebase.messaging",
            1_700_000_000,
        )
        .unwrap();

        let header = jsonwebtoken::decode_header(&jwt).unwrap();
        assert_eq!(header.alg, Algorithm::RS256);

        #[derive(serde::Deserialize)]
        struct Claims {
            iss: String,
            aud: String,
            scope: String,
            exp: u64,
        }
        let mut v = Validation::new(Algorithm::RS256);
        v.set_audience(&["https://oauth2.googleapis.com/token"]);
        // 固定 iat 是 2023，关掉过期校验只验签名与字段
        v.validate_exp = false;
        let key = DecodingKey::from_rsa_pem(TEST_RSA_PUB_PEM.as_bytes()).unwrap();
        let data = decode::<Claims>(&jwt, &key, &v).unwrap();
        assert_eq!(data.claims.iss, "sa@test.iam.gserviceaccount.com");
        assert_eq!(data.claims.aud, "https://oauth2.googleapis.com/token");
        assert_eq!(
            data.claims.scope,
            "https://www.googleapis.com/auth/firebase.messaging"
        );
        assert_eq!(data.claims.exp, 1_700_000_000 + 3600);
    }

    #[test]
    fn test_google_sa_assertion_end_to_end() {
        use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};

        // 唯一临时目录 + 唯一盐，避免与其它测试/并发冲突
        let salt = format!("test-salt-{}", uuid::Uuid::new_v4());
        let dir = std::env::temp_dir().join(format!("ob_fcm_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let project = "myproject";
        let tenant_id = 4;
        // 按同一派生规则命名 SA JSON 文件（模拟运维放 K8s Secret）
        let name = derive_fcm_secret_name(project, tenant_id, &salt);
        let sa_json = serde_json::json!({
            "type": "service_account",
            "client_email": "sa@test.iam.gserviceaccount.com",
            "private_key": TEST_RSA_PRIV_PEM,
            "project_id": "testproj"
        })
        .to_string();
        std::fs::write(dir.join(format!("{}.json", name)), sa_json).unwrap();

        std::env::set_var("FCM_KEY_SALT", &salt);
        std::env::set_var("FCM_SECRETS_DIR", &dir);

        let lua = Lua::new();
        register_google_module(&lua, Some(tenant_id)).unwrap();
        lua.globals().set("proj", project).unwrap();

        // 返回表：{ assertion, project_id, client_email }
        let (jwt, project_id): (String, String) = lua
            .load(
                r#"local sa = google.sa_assertion(proj, "https://www.googleapis.com/auth/firebase.messaging")
                return sa.assertion, sa.project_id"#,
            )
            .eval()
            .unwrap();
        assert_eq!(project_id, "testproj");

        #[derive(serde::Deserialize)]
        struct Claims {
            iss: String,
            scope: String,
        }
        let mut v = Validation::new(Algorithm::RS256);
        v.set_audience(&["https://oauth2.googleapis.com/token"]);
        let key = DecodingKey::from_rsa_pem(TEST_RSA_PUB_PEM.as_bytes()).unwrap();
        let data = decode::<Claims>(&jwt, &key, &v).unwrap();
        assert_eq!(data.claims.iss, "sa@test.iam.gserviceaccount.com");
        assert_eq!(
            data.claims.scope,
            "https://www.googleapis.com/auth/firebase.messaging"
        );

        // 清理
        std::env::remove_var("FCM_KEY_SALT");
        std::env::remove_var("FCM_SECRETS_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_google_sa_assertion_requires_tenant() {
        // tenant_id 缺失（None）时必须拒签，不能误用密钥
        let lua = Lua::new();
        register_google_module(&lua, None).unwrap();
        let res = lua
            .load(r#"return google.sa_assertion("p", "scope")"#)
            .eval::<String>();
        assert!(res.is_err(), "缺 tenant_id 应报错");
    }

    #[test]
    fn test_json_encode_decode() {
        let lua = Lua::new();
        register_builtins(&lua, HashMap::new()).unwrap();

        lua.load(
            r#"
            local t = {name = "test", age = 30, active = true}
            local s = json.encode(t)
            local decoded = json.decode(s)
            assert(decoded.name == "test")
            assert(decoded.age == 30)
            assert(decoded.active == true)
        "#,
        )
        .exec()
        .unwrap();
    }

    #[test]
    fn test_crypto_sha256() {
        let lua = Lua::new();
        register_builtins(&lua, HashMap::new()).unwrap();

        lua.load(
            r#"
            local hash = crypto.sha256("hello")
            assert(#hash == 64, "SHA256 should produce 64 hex chars")
        "#,
        )
        .exec()
        .unwrap();
    }

    #[test]
    fn test_crypto_uuid() {
        let lua = Lua::new();
        register_builtins(&lua, HashMap::new()).unwrap();

        lua.load(
            r#"
            local id = crypto.uuid()
            assert(#id == 36, "UUID should be 36 chars")
        "#,
        )
        .exec()
        .unwrap();
    }

    #[test]
    fn test_crypto_md5_sha1() {
        let lua = Lua::new();
        register_builtins(&lua, HashMap::new()).unwrap();
        lua.load(
            r#"
            assert(crypto.md5("abc") == "900150983cd24fb0d6963f7d28e17f72", "md5 mismatch")
            assert(crypto.sha1("abc") == "a9993e364706816aba3e25717850c26c9cd0d89d", "sha1 mismatch")
            -- 输出编码可选 base64
            assert(crypto.md5("abc", "base64") == "kAFQmDzST7DWlj99KOF/cg==", "md5 base64 mismatch")
        "#,
        )
        .exec()
        .unwrap();
    }

    #[test]
    fn test_crypto_base64_roundtrip() {
        let lua = Lua::new();
        register_builtins(&lua, HashMap::new()).unwrap();

        lua.load(
            r#"
            local enc = crypto.base64_encode("hello world")
            assert(enc == "aGVsbG8gd29ybGQ=", "base64 encode mismatch: " .. enc)
            local dec = crypto.base64_decode(enc)
            assert(dec == "hello world", "base64 decode mismatch: " .. dec)
        "#,
        )
        .exec()
        .unwrap();
    }

    #[test]
    fn test_crypto_aes_cbc_roundtrip() {
        let lua = Lua::new();
        register_builtins(&lua, HashMap::new()).unwrap();
        lua.load(
            r#"
            local ct = crypto.aes_encrypt({
                mode = "cbc",
                key = "0123456789abcdef",
                iv = "abcdef0123456789",
                plaintext = "hello world",
            })
            assert(type(ct) == "string" and #ct > 0, "密文应为非空字符串")
            local pt = crypto.aes_decrypt({
                mode = "cbc",
                key = "0123456789abcdef",
                iv = "abcdef0123456789",
                ciphertext = ct,
            })
            assert(pt == "hello world", "CBC 往返不一致: " .. tostring(pt))
        "#,
        )
        .exec()
        .unwrap();
    }

    #[test]
    fn test_crypto_rsa_encrypt_decrypt_roundtrip() {
        let lua = Lua::new();
        register_builtins(&lua, HashMap::new()).unwrap();

        // 2048-bit 测试密钥对（PKCS#8 私钥 / SPKI 公钥），仅用于单测
        let priv_pem = "-----BEGIN PRIVATE KEY-----\n\
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC9ZhFJNVokQTNr\n\
adOPdZzJITZ+wjUuCGNp85Q5xJhZ33r92d3b8cL118B7j1oq9LUb7XsWhBYq3eNj\n\
9cvJQm1B9nk9acS/SmdPSSlsPVnIyHivLMj4TnANw8kEvrDpmzxXwPn+S/vDU9SZ\n\
5izyylyMXt9n/aKey/DHLKRDXH2fpW+UveqmvLRk/joEpKHhJZYt+5npPNPnr80t\n\
8Vb/wduI7CpsgabhLPYZaIM7rrwNOf/G1Ze+su2IGGMzBBPt7hy48I9S4U8ErM6O\n\
3XufAp/dMv4IWIkUg79skk3/ntL0Ulj+cOlxDs+YgFrEvUDknRgjQzG6+TgJ29u0\n\
DKWMIviZAgMBAAECggEAHn9l/yzZJAdfuUckKvCcW4K+nLC3EX+GSpRPZPH0OlyT\n\
GHdRk04dv6qLMxpFQa9/zkxySpDgZOyv5fO5aeIJZ9rBcRMr/EWF1y2HvwcuAvfM\n\
/yAuCFXRE1ZYcywlnqhBkjvfxYQEuVIxZMq8qCfPuUa5oKwl2H4selYE6VfmXqNl\n\
ARhx+sFJNTEQwgNHKVYqqA61zFo0Awz2HCauIWFrubWxHfsRTN8YdVLtGOt/Re7I\n\
zaAaS2iLXEeynTKnf65TPSV0kp681794ayscsfT+mTtXelcaha1axjSdf4FF/TsU\n\
mWhPMCwQEsjIUyVjM5F3OMUDV02YZFCV1ND/YywiRQKBgQDq7bQ7rnRLgzkw4u66\n\
aqNQkGQU3Ds/DsaDpg0HWWCt6D8fgP3y6Yel2NTW6RiO6pjgv8wuh1TcJkJrm9ms\n\
NPanb/rTxjg8KM7KN0PeIGTHFtkspY/B9DmtuOGP5D8wRlx0lQD1FS8jsP7Yf06g\n\
9xxiMsMMp4wWENJYBpoOro2LgwKBgQDOYu7srbri8GpJLBejL0DxpsbmbETwP0hm\n\
o2f0iJOoWSbZS4Zv+OXI2vkQP0Mu64M9upOEQIqD3MCS3yiLbEP4ro/ajMxoNncV\n\
hqYQKbHxj78Ud+Y7IrfaKR3KsbWF2SOTOyeBEh8sn6fb4kU0/1EMPtmPGiW/UM4T\n\
1glHOIQkswKBgErIjD0LVZ3MEeKL+q6Az6gPrqwtRvbVvz+dFjymqO3zJlTi/PPc\n\
fv++PFKFNPoZl7zDkT2mes7xpucWX35ABdxa+x9609/ipaEdYo9NBIeTsGJT+aUm\n\
F05DshnZ8HtvinLaE8nwimb0KsvECsWWpARmYEyg8Sj9BdhbkaLm0cv9AoGBAJFv\n\
Ofpiej2NOPiTL5z4oYUoByU8yl+Z2IUrRQgWbibFnBCnnfatqA8f7z65tbgMkhEf\n\
tvANIw7EspdM1h9ZjZRiPlC9wxT0vHnYxpDBMPmOWBIuY3jsgC4lpy68h7PoTZ9k\n\
ofPcN0eUwg66phYwjIZai6jBvjPQ10c3HpanhsbtAoGBAL9NQ68O9zcMhGFo42KO\n\
GSYXtVU2a5hxeVb52Q438okFJELpgLABGpDEaL7i4FQqjuu9tqQyOrBdZD1AOshZ\n\
Ax/sk2fcndv5p+ppl/rBiya50XAzvWEtfoEG1fTa7na2d7aUK/J6oOV8KeX1nta3\n\
5+aRr/Ze0s6w97Wo3y2O+xQv\n\
-----END PRIVATE KEY-----";
        let pub_pem = "-----BEGIN PUBLIC KEY-----\n\
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvWYRSTVaJEEza2nTj3Wc\n\
ySE2fsI1LghjafOUOcSYWd96/dnd2/HC9dfAe49aKvS1G+17FoQWKt3jY/XLyUJt\n\
QfZ5PWnEv0pnT0kpbD1ZyMh4ryzI+E5wDcPJBL6w6Zs8V8D5/kv7w1PUmeYs8spc\n\
jF7fZ/2insvwxyykQ1x9n6VvlL3qpry0ZP46BKSh4SWWLfuZ6TzT56/NLfFW/8Hb\n\
iOwqbIGm4Sz2GWiDO668DTn/xtWXvrLtiBhjMwQT7e4cuPCPUuFPBKzOjt17nwKf\n\
3TL+CFiJFIO/bJJN/57S9FJY/nDpcQ7PmIBaxL1A5J0YI0Mxuvk4CdvbtAyljCL4\n\
mQIDAQAB\n\
-----END PUBLIC KEY-----";

        lua.globals().set("priv_pem", priv_pem).unwrap();
        lua.globals().set("pub_pem", pub_pem).unwrap();

        // PKCS#1 v1.5 往返
        lua.load(
            r#"
            local plain = "hello rsa 你好"
            local ct = crypto.rsa_encrypt(pub_pem, plain)
            assert(#ct > 0, "ciphertext should be non-empty")
            local back = crypto.rsa_decrypt(priv_pem, ct)
            assert(back == plain, "rsa pkcs1v15 roundtrip mismatch: " .. back)
        "#,
        )
        .exec()
        .unwrap();
    }

    #[test]
    fn test_crypto_aes_cbc_hex_key_and_output() {
        let lua = Lua::new();
        register_builtins(&lua, HashMap::new()).unwrap();
        // key/iv 用 hex 传入，密文用 hex 输出（对接旧系统常见）
        lua.load(
            r#"
            local key_hex = "30313233343536373839616263646566" -- "0123456789abcdef"
            local iv_hex  = "61626364656630313233343536373839" -- "abcdef0123456789"
            local ct = crypto.aes_encrypt({
                mode = "cbc", key = key_hex, key_encoding = "hex",
                iv = iv_hex, iv_encoding = "hex",
                plaintext = "hello world", output_encoding = "hex",
            })
            local pt = crypto.aes_decrypt({
                mode = "cbc", key = key_hex, key_encoding = "hex",
                iv = iv_hex, iv_encoding = "hex",
                ciphertext = ct, input_encoding = "hex",
            })
            assert(pt == "hello world", "hex 往返不一致")
        "#,
        )
        .exec()
        .unwrap();
    }

    #[test]
    fn test_crypto_aes_gcm_roundtrip() {
        let lua = Lua::new();
        register_builtins(&lua, HashMap::new()).unwrap();
        lua.load(
            r#"
            local opts_enc = {
                mode = "gcm",
                key = "0123456789abcdef",
                iv = "unique-nonce",  -- 12 bytes
                aad = "hdr",
                plaintext = "top secret",
            }
            local ct = crypto.aes_encrypt(opts_enc)
            local pt = crypto.aes_decrypt({
                mode = "gcm",
                key = "0123456789abcdef",
                iv = "unique-nonce",
                aad = "hdr",
                ciphertext = ct,
            })
            assert(pt == "top secret", "GCM 往返不一致: " .. tostring(pt))
        "#,
        )
        .exec()
        .unwrap();
    }

    #[test]
    fn test_crypto_aes_bad_mode_errors() {
        let lua = Lua::new();
        register_builtins(&lua, HashMap::new()).unwrap();
        let res = lua
            .load(
                r#"
                crypto.aes_encrypt({ mode = "wat", key = "0123456789abcdef", iv = "abcdef0123456789", plaintext = "x" })
            "#,
            )
            .exec();
        assert!(res.is_err(), "未知 mode 应报错");
    }

    #[test]
    fn test_crypto_rs256_jwt_sign_verifies() {
        use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};

        // 2048-bit 测试密钥对（PKCS#8 私钥 / SPKI 公钥），仅用于单测
        let priv_pem = "-----BEGIN PRIVATE KEY-----\n\
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC9ZhFJNVokQTNr\n\
adOPdZzJITZ+wjUuCGNp85Q5xJhZ33r92d3b8cL118B7j1oq9LUb7XsWhBYq3eNj\n\
9cvJQm1B9nk9acS/SmdPSSlsPVnIyHivLMj4TnANw8kEvrDpmzxXwPn+S/vDU9SZ\n\
5izyylyMXt9n/aKey/DHLKRDXH2fpW+UveqmvLRk/joEpKHhJZYt+5npPNPnr80t\n\
8Vb/wduI7CpsgabhLPYZaIM7rrwNOf/G1Ze+su2IGGMzBBPt7hy48I9S4U8ErM6O\n\
3XufAp/dMv4IWIkUg79skk3/ntL0Ulj+cOlxDs+YgFrEvUDknRgjQzG6+TgJ29u0\n\
DKWMIviZAgMBAAECggEAHn9l/yzZJAdfuUckKvCcW4K+nLC3EX+GSpRPZPH0OlyT\n\
GHdRk04dv6qLMxpFQa9/zkxySpDgZOyv5fO5aeIJZ9rBcRMr/EWF1y2HvwcuAvfM\n\
/yAuCFXRE1ZYcywlnqhBkjvfxYQEuVIxZMq8qCfPuUa5oKwl2H4selYE6VfmXqNl\n\
ARhx+sFJNTEQwgNHKVYqqA61zFo0Awz2HCauIWFrubWxHfsRTN8YdVLtGOt/Re7I\n\
zaAaS2iLXEeynTKnf65TPSV0kp681794ayscsfT+mTtXelcaha1axjSdf4FF/TsU\n\
mWhPMCwQEsjIUyVjM5F3OMUDV02YZFCV1ND/YywiRQKBgQDq7bQ7rnRLgzkw4u66\n\
aqNQkGQU3Ds/DsaDpg0HWWCt6D8fgP3y6Yel2NTW6RiO6pjgv8wuh1TcJkJrm9ms\n\
NPanb/rTxjg8KM7KN0PeIGTHFtkspY/B9DmtuOGP5D8wRlx0lQD1FS8jsP7Yf06g\n\
9xxiMsMMp4wWENJYBpoOro2LgwKBgQDOYu7srbri8GpJLBejL0DxpsbmbETwP0hm\n\
o2f0iJOoWSbZS4Zv+OXI2vkQP0Mu64M9upOEQIqD3MCS3yiLbEP4ro/ajMxoNncV\n\
hqYQKbHxj78Ud+Y7IrfaKR3KsbWF2SOTOyeBEh8sn6fb4kU0/1EMPtmPGiW/UM4T\n\
1glHOIQkswKBgErIjD0LVZ3MEeKL+q6Az6gPrqwtRvbVvz+dFjymqO3zJlTi/PPc\n\
fv++PFKFNPoZl7zDkT2mes7xpucWX35ABdxa+x9609/ipaEdYo9NBIeTsGJT+aUm\n\
F05DshnZ8HtvinLaE8nwimb0KsvECsWWpARmYEyg8Sj9BdhbkaLm0cv9AoGBAJFv\n\
Ofpiej2NOPiTL5z4oYUoByU8yl+Z2IUrRQgWbibFnBCnnfatqA8f7z65tbgMkhEf\n\
tvANIw7EspdM1h9ZjZRiPlC9wxT0vHnYxpDBMPmOWBIuY3jsgC4lpy68h7PoTZ9k\n\
ofPcN0eUwg66phYwjIZai6jBvjPQ10c3HpanhsbtAoGBAL9NQ68O9zcMhGFo42KO\n\
GSYXtVU2a5hxeVb52Q438okFJELpgLABGpDEaL7i4FQqjuu9tqQyOrBdZD1AOshZ\n\
Ax/sk2fcndv5p+ppl/rBiya50XAzvWEtfoEG1fTa7na2d7aUK/J6oOV8KeX1nta3\n\
5+aRr/Ze0s6w97Wo3y2O+xQv\n\
-----END PRIVATE KEY-----";
        let pub_pem = "-----BEGIN PUBLIC KEY-----\n\
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvWYRSTVaJEEza2nTj3Wc\n\
ySE2fsI1LghjafOUOcSYWd96/dnd2/HC9dfAe49aKvS1G+17FoQWKt3jY/XLyUJt\n\
QfZ5PWnEv0pnT0kpbD1ZyMh4ryzI+E5wDcPJBL6w6Zs8V8D5/kv7w1PUmeYs8spc\n\
jF7fZ/2insvwxyykQ1x9n6VvlL3qpry0ZP46BKSh4SWWLfuZ6TzT56/NLfFW/8Hb\n\
iOwqbIGm4Sz2GWiDO668DTn/xtWXvrLtiBhjMwQT7e4cuPCPUuFPBKzOjt17nwKf\n\
3TL+CFiJFIO/bJJN/57S9FJY/nDpcQ7PmIBaxL1A5J0YI0Mxuvk4CdvbtAyljCL4\n\
mQIDAQAB\n\
-----END PUBLIC KEY-----";

        let lua = Lua::new();
        register_builtins(&lua, HashMap::new()).unwrap();
        lua.globals().set("priv_pem", priv_pem).unwrap();

        // 在 Lua 里拼一个 RS256 JWT：header.payload.signature，各段 base64url。
        // 签名段 = base64url(原始签名字节)；rsa_sign_sha256 返回标准 base64，故先
        // base64_decode 还原为原始字节再 base64url_encode。
        let jwt: String = lua
            .load(
                r#"
                local header = crypto.base64url_encode('{"alg":"RS256","typ":"JWT"}')
                local payload = crypto.base64url_encode('{"iss":"sa@test","aud":"https://oauth2.googleapis.com/token","scope":"s1 s2"}')
                local signing_input = header .. "." .. payload
                local raw_sig = crypto.base64_decode(crypto.rsa_sign_sha256(priv_pem, signing_input))
                local sig = crypto.base64url_encode(raw_sig)
                return signing_input .. "." .. sig
            "#,
            )
            .eval()
            .unwrap();

        #[derive(serde::Deserialize)]
        struct Claims {
            iss: String,
            aud: String,
            scope: String,
        }
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_audience(&["https://oauth2.googleapis.com/token"]);
        validation.required_spec_claims = std::collections::HashSet::new();
        validation.validate_exp = false;
        let key = DecodingKey::from_rsa_pem(pub_pem.as_bytes()).unwrap();
        let data = decode::<Claims>(&jwt, &key, &validation).unwrap();
        assert_eq!(data.claims.iss, "sa@test");
        assert_eq!(data.claims.aud, "https://oauth2.googleapis.com/token");
        assert_eq!(data.claims.scope, "s1 s2");
    }

    #[test]
    fn test_env_get_returns_nil_for_unset() {
        let lua = Lua::new();
        register_builtins(&lua, HashMap::new()).unwrap();

        // 语义变化：未配置的变量返回 nil（不再抛错），且不再读进程 env
        lua.load(
            r#"
            assert(env.get("PATH") == nil, "未配置变量应返回 nil")
            assert(env.get("ANYTHING") == nil, "任意未配置变量应返回 nil")
        "#,
        )
        .exec()
        .unwrap();
    }

    #[test]
    fn test_env_get_reads_configured_var() {
        let lua = Lua::new();
        let mut env_vars = HashMap::new();
        env_vars.insert(
            "PLUGIN_STRIPE_SECRET_KEY".to_string(),
            "sk_live_xyz".to_string(),
        );
        env_vars.insert("API_TOKEN".to_string(), "tok_123".to_string());
        register_builtins(&lua, env_vars).unwrap();

        // 取消了 PLUGIN_ 前缀限制：任意已配置变量名都可读取
        lua.load(
            r#"
            assert(env.get("PLUGIN_STRIPE_SECRET_KEY") == "sk_live_xyz")
            assert(env.get("API_TOKEN") == "tok_123")
            assert(env.get("NOT_CONFIGURED") == nil)
        "#,
        )
        .exec()
        .unwrap();
    }

    #[test]
    fn test_time_module() {
        let lua = Lua::new();
        register_builtins(&lua, HashMap::new()).unwrap();
        lua.load(
            r#"
            local s = time.now()
            local ms = time.now_ms()
            assert(type(s) == "number", "time.now() 应为数字")
            assert(s > 1700000000, "time.now() 应为合理的 unix 秒")
            assert(ms >= s * 1000, "毫秒应不小于秒*1000")
        "#,
        )
        .exec()
        .unwrap();
    }

    #[test]
    fn test_log_module() {
        let lua = Lua::new();
        register_builtins(&lua, HashMap::new()).unwrap();

        // 日志调用不应 panic
        lua.load(
            r#"
            log.info("test info message")
            log.warn("test warn message")
            log.debug("test debug message")
        "#,
        )
        .exec()
        .unwrap();
    }

    #[test]
    fn test_opts_timeout_secs_parsing() {
        let lua = Lua::new();

        // 未配置 -> None
        let empty = lua.create_table().unwrap();
        assert_eq!(opts_timeout_secs(&empty), None);

        // timeout_secs 整数
        let t = lua.create_table().unwrap();
        t.set("timeout_secs", 180).unwrap();
        assert_eq!(opts_timeout_secs(&t), Some(180));

        // 兼容 timeout 键
        let t = lua.create_table().unwrap();
        t.set("timeout", 90).unwrap();
        assert_eq!(opts_timeout_secs(&t), Some(90));

        // timeout_secs 优先于 timeout
        let t = lua.create_table().unwrap();
        t.set("timeout", 30).unwrap();
        t.set("timeout_secs", 200).unwrap();
        assert_eq!(opts_timeout_secs(&t), Some(200));

        // 字符串数值
        let t = lua.create_table().unwrap();
        t.set("timeout_secs", "150").unwrap();
        assert_eq!(opts_timeout_secs(&t), Some(150));

        // 0 = 显式不限制
        let t = lua.create_table().unwrap();
        t.set("timeout_secs", 0).unwrap();
        assert_eq!(opts_timeout_secs(&t), Some(0));

        // 负数视为未配置
        let t = lua.create_table().unwrap();
        t.set("timeout_secs", -5).unwrap();
        assert_eq!(opts_timeout_secs(&t), None);
    }

    #[test]
    fn lua_http_post_async_poll_waits_for_completion() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/job", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let pending = r#"{"status":"pending","job_id":"j1","poll_after_secs":1}"#;
            let (mut first, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            first.read(&mut request).unwrap();
            write!(
                first,
                "HTTP/1.1 202 Accepted\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                pending.len(),
                pending
            )
            .unwrap();

            let (mut second, _) = listener.accept().unwrap();
            let read = second.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("POST /job "));
            assert!(request.contains(r#""action":"poll""#));
            let completed = r#"{"status":"completed","result":42}"#;
            write!(
                second,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                completed.len(),
                completed
            )
            .unwrap();
        });

        let lua = Lua::new();
        register_http_module(&lua).unwrap();
        let chunk = format!(
            r#"
                local r = http.post("{url}", {{}}, {{
                  async_poll = true,
                  poll_interval_secs = 1,
                  poll_max_secs = 30,
                  timeout_secs = 5,
                }})
                assert(r.status == 200)
                assert(r.async_poll ~= nil)
                assert(r.async_poll.attempts >= 1)
                return r.json.result
            "#
        );
        let result: i64 = lua.load(&chunk).eval().unwrap();
        server.join().unwrap();
        assert_eq!(result, 42);
    }

    #[test]
    fn lua_http_post_202_does_not_poll_without_async_poll() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/job", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let pending = r#"{"status":"pending","job_id":"j1"}"#;
            let (mut first, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            first.read(&mut request).unwrap();
            write!(
                first,
                "HTTP/1.1 202 Accepted\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                pending.len(),
                pending
            )
            .unwrap();
            listener.set_nonblocking(true).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(100));
            assert!(listener.accept().is_err(), "unexpected poll request");
        });

        let lua = Lua::new();
        register_http_module(&lua).unwrap();
        let status: u16 = lua
            .load(&format!(r#"return http.post("{url}", {{}}).status"#))
            .eval()
            .unwrap();
        server.join().unwrap();
        assert_eq!(status, 202);
    }
}
