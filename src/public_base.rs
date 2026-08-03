//! 对外调用基址（网关域名）解析。
//!
//! 背景：运维在网关层新增了对外域名，所有接口调用都应走网关，而不是后端实例的
//! 内网 IP:端口。接口文档展示的调用地址、以及各处「基址 Base URL」都应统一取这个值。
//!
//! 本模块负责「环境变量 + 请求头」这两层解析；更高优先级的「平台页面可编辑的 DB 配置」
//! 在 `crate::platform_settings` 里叠加（DB 值 > 本模块结果）。本模块解析优先级：
//!   1. `PUBLIC_BASE_URL` 环境变量 —— 运维显式配置的对外域名（如 `https://gw.example.com`）。
//!   2. 反向代理转发头 `X-Forwarded-Host` + `X-Forwarded-Proto` —— 网关反代时通常会自动带上，
//!      因此多数标准部署下 **零配置** 即可自动得到网关域名。
//!   3. 原始 `Host` 头 —— 前两者都缺失时的兜底。
//!   4. 全部缺失（少见）时返回空串，交由前端兜底到浏览器 `origin`。
//!
//! 与 OIDC issuer 复用同一约定：`idp_oidc` 的 `IDP_ISSUER` 优先级更高，未设时回落到本模块。

use axum::http::{header, HeaderMap};

/// 运维显式配置的对外基址（`PUBLIC_BASE_URL`）；未配置或为空时返回 `None`。
/// 返回值已去掉首尾空白与末尾 `/`，方便直接拼接路径。
pub fn configured_public_base() -> Option<String> {
    std::env::var("PUBLIC_BASE_URL")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
}

/// 从请求头解析对外调用基址（不含末尾 `/`）。详见模块文档的优先级说明。
pub fn resolve_public_base(headers: &HeaderMap) -> String {
    if let Some(fixed) = configured_public_base() {
        return fixed;
    }

    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))
        .and_then(|v| v.to_str().ok())
        // 多级代理时 X-Forwarded-Host 可能是 "a.com, b.com"，取最外层（第一个）。
        .and_then(|s| s.split(',').next())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let proto = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("http");

    match host {
        Some(h) => format!("{}://{}", proto, h.trim_end_matches('/')),
        None => String::new(),
    }
}
