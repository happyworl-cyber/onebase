//! MCP server —— 工作流创作工作台的协议层
//!
//! `POST /mcp`：MCP Streamable HTTP 的无状态模式——单次 POST、单个 JSON 响应，
//! 手写 JSON-RPC 2.0 最小子集（initialize / ping / tools/list / tools/call），
//! 零外部 MCP SDK 依赖。
//!
//! 鉴权：`Authorization: Bearer crm_*`（PAT）。本路由**不挂 auth_middleware**
//! （那条链路只认 JWT / `cr_*` API Key / `crp_*` 平台令牌），在 handler 内自行调用
//! [`crate::pat_handlers::verify_pat`]。
//!
//! 客户端接入（Claude Code）：
//! `claude mcp add --transport http onebase <BASE_URL>/mcp --header "Authorization: Bearer crm_xxx"`

use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::mcp_tools;
use crate::pat_handlers::verify_pat;

/// 服务端支持的 MCP 协议版本（无状态 tools 子集对版本不敏感，直接回告客户端）
const PROTOCOL_VERSION: &str = "2025-06-18";

/// POST /mcp
pub async fn mcp_endpoint(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    // ── PAT 鉴权（401 走 HTTP 层，协议错误才走 JSON-RPC error）──
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let claims = match token {
        Some(t) => match verify_pat(&pool, t).await {
            Ok(c) => c,
            Err(e) => {
                return (
                    StatusCode::UNAUTHORIZED,
                    Json(json!({ "error": e.to_string() })),
                )
                    .into_response()
            }
        },
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "缺少 Authorization: Bearer crm_* 个人访问令牌" })),
            )
                .into_response()
        }
    };

    let Some(Json(req)) = body else {
        return jsonrpc_error(Value::Null, -32700, "请求体不是合法 JSON");
    };

    // 本服务端只接受单个 JSON-RPC 对象：数组（batch）、字符串、数字等一律 Invalid Request，
    // 避免畸形/batch 请求被下面的 `id.is_none()` 误判成 notification 而静默回 202。
    if !req.is_object() {
        return jsonrpc_error(
            Value::Null,
            -32600,
            "Invalid Request：仅支持单个 JSON-RPC 请求对象（不支持 batch）",
        );
    }

    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or(json!({}));

    // notification（对象且无 id）：按规范回 202，无响应体
    if req.get("id").is_none() {
        return StatusCode::ACCEPTED.into_response();
    }

    match method {
        "initialize" => {
            // 版本协商：客户端请求了版本就回显（无状态 tools 子集向后兼容所有版本），
            // 否则回服务端默认。固定回单一版本会让严格校验的旧客户端断连。
            let version = params
                .get("protocolVersion")
                .and_then(|v| v.as_str())
                .unwrap_or(PROTOCOL_VERSION)
                .to_string();
            jsonrpc_ok(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": {} },
                    "serverInfo": {
                        "name": "onebase-workflow-mcp",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "instructions": "OneBase 工作流创作工作台：先调 node_spec 获取节点规范，再 create_workflow（创建即启用）→ debug_workflow（默认干跑）→ workflow_api_doc 生成交付文档；已启用工作流的启停由人在页面操作。"
                }),
            )
        }
        "ping" => jsonrpc_ok(id, json!({})),
        "tools/list" => jsonrpc_ok(id, json!({ "tools": mcp_tools::tool_definitions() })),
        "tools/call" => {
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            // 审计补偿：/mcp 不走 audit_middleware（未注入 Claims extension），
            // 这里用 tracing 落审计痕——操作人（PAT 绑定用户）、工具名、目标 id。
            tracing::info!(
                target: "mcp_audit",
                user_id = claims.sub,
                jti = %claims.jti,
                tool = name,
                arg_id = args.get("id").and_then(|v| v.as_i64()).unwrap_or(-1),
                "MCP 工具调用"
            );
            match mcp_tools::call_tool(&pool, &claims, name, &args).await {
                Ok(result) => jsonrpc_ok(
                    id,
                    json!({
                        "content": [{
                            "type": "text",
                            "text": serde_json::to_string_pretty(&result).unwrap_or_default()
                        }],
                        "isError": false
                    }),
                ),
                // 业务错误（权限/校验/不存在）作为工具结果返回，AI 可读错误信息自行修正
                Err(e) => jsonrpc_ok(
                    id,
                    json!({
                        "content": [{ "type": "text", "text": format!("错误：{}", e) }],
                        "isError": true
                    }),
                ),
            }
        }
        _ => jsonrpc_error(id, -32601, &format!("方法不存在: {}", method)),
    }
}

fn jsonrpc_ok(id: Value, result: Value) -> Response {
    Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })).into_response()
}

fn jsonrpc_error(id: Value, code: i64, message: &str) -> Response {
    Json(json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_jsonrpc_envelope_shapes() {
        // 信封构造不 panic 即可；具体响应体由集成测试覆盖
        let _ = jsonrpc_ok(json!(1), json!({"ok": true}));
        let _ = jsonrpc_error(json!(1), -32601, "no such method");
    }
}
