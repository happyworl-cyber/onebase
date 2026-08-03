//! PostgREST 风格请求的兼容工具集（schema 决议 / X-Project-IDs 翻译 / filter 改写）。
//!
//! 业务侧（基于 supabase / postgrest 客户端的代码）发出的请求形如：
//!
//! ```text
//! GET /api/v1/{database_id}/{table}?col=eq.val&order=created_at.desc
//! Authorization: Bearer cr_<api_key>
//! Accept-Profile: <schema>          # 读：GET / HEAD / DELETE
//! Content-Profile: <schema>         # 写：POST / PATCH / PUT
//! X-Project-IDs: 1,4,5,...          # 业务自定义：多项目过滤
//! ```
//!
//! 当前 Auto API 路由是三段 `/api/v1/{db}/{schema}/{table}`：schema 在 path 里而不是
//! 头里。为兼容，**显式注册了两段路由** `/api/v1/{db}/{table}`，其 handler
//! ([`crate::auto_api_handlers::list_records_pgrest`] /
//! [`crate::auto_api_handlers::create_record_pgrest`]) 内部调用本模块完成头→schema
//! 翻译、X-Project-IDs → filter 注入、PostgREST filter 语法翻译，再 forward 到三段
//! 版本的核心逻辑（[`crate::auto_api_handlers::list_records`] /
//! [`crate::auto_api_handlers::create_record`]）。
//!
//! ## 为什么不用 layer 改 URI 的方案
//!
//! 早期实现把 schema/filter 翻译做成了 axum middleware，挂在 app 全局 layer 上。
//! 但 axum 0.7 的 `Router::layer` 是 **per-route 包装**：路由匹配先发生，已匹配的
//! endpoint（含 fallback 的 catch-all NotFound）才会进入 layer 函数体。两段路径在
//! 没显式注册路由时被 fallback 命中 → middleware 改 URI 来不及 → 客户端拿 404。
//! 显式注册两段路由 + handler 内部 dispatch 是唯一可行的路径。
//!
//! ## 安全
//!
//! - schema 走 `is_safe_identifier`（PG 标识符规则：ASCII 字母 / 数字 / `_`，首字符
//!   非数字，长度 ≤ 64）—— 防 path injection / 后续 SQL 拼接污染
//! - project_id 仅接受 `[A-Za-z0-9_]+`；含特殊字符的 id 整段 drop
//! - 翻译后的 query 走 [`crate::auto_api_handlers::parse_filters`] 的合法字段名校
//!   验 + sqlx 参数化绑定，本层无需重复防护

use axum::http::{HeaderMap, Method};

use crate::rbac_models::is_safe_identifier;

/// schema 决议：
///   - 写方法（POST/PATCH/PUT）：`Content-Profile` 头 > `Accept-Profile` 头 > `public`
///   - 读方法（其它）：`Accept-Profile` 头 > `public`
///
/// 与 [`crate::rpc::resolve_schema`] 行为对齐 —— 业务方学一套 PostgREST 协议就能
/// 同时打 Auto API 与 RPC，不用记两套。
pub fn resolve_schema(method: &Method, headers: &HeaderMap) -> String {
    let primary = if matches!(*method, Method::POST | Method::PATCH | Method::PUT) {
        "content-profile"
    } else {
        "accept-profile"
    };
    headers
        .get(primary)
        .or_else(|| headers.get("accept-profile"))
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && is_safe_identifier(s))
        .unwrap_or_else(|| "public".to_string())
}

/// PostgREST `field=op.value` 语法翻译为 onebase 内部 `field.op=value`。
///
/// 规则：
/// - 保留字 `select` / `order` / `limit` / `offset` 原样保留（这四个 PostgREST 与
///   onebase 同款语义，handler 直接消费 `Query<QueryParams>`）。
/// - value 以已知算子前缀 `gte.|lte.|neq.|ilike.|like.|eq.|gt.|lt.|is.|in.` 开头
///   → 拆成 `key.op=rest_value`。**长前缀优先**，避免 `gte.` 被 `gt.` 误吞。
/// - key 已含 `.`（已经是 onebase 内部风格）或无识别算子前缀的 value：原样透传。
///
/// 我们把"翻译后的"中间件级 query 当成不可信输入交给 [`parse_filters`]，下游会走
/// `is_valid_identifier(field)` + 仅允许的 op 列表，最终参数化绑定 sqlx；本翻译层
/// 不必再做 SQL 注入防护，只关心格式转换。
pub fn translate_query(q: &str) -> String {
    const OPS: &[&str] = &[
        "gte", "lte", "neq", "ilike", "like", "eq", "gt", "lt", "is", "in",
    ];
    const RESERVED: &[&str] = &["select", "order", "limit", "offset"];

    q.split('&')
        .map(|pair| {
            let Some((key, value)) = pair.split_once('=') else {
                return pair.to_string();
            };
            if RESERVED.contains(&key) {
                return pair.to_string();
            }
            if key.contains('.') {
                return pair.to_string();
            }
            for op in OPS {
                let prefix_with_dot = format!("{}.", op);
                if let Some(rest) = value.strip_prefix(&prefix_with_dot) {
                    return format!("{}.{}={}", key, op, rest);
                }
            }
            pair.to_string()
        })
        .collect::<Vec<_>>()
        .join("&")
}

/// 把 `X-Project-IDs: 1,4,5` 转成 `project_id.in=(1,4,5)`（onebase 内部风格）。
///
/// 注意是 `project_id.in=(...)` 而不是 PostgREST 风格 `project_id=in.(...)`：
/// 这个 fragment 会直接拼到已经经过 `translate_query` 处理过的 query 后面，再不
/// 会经翻译；parse_filters 期望的就是 `field.op=value` 形态。
///
/// **严格输入校验**：每个 id 只允许 `[A-Za-z0-9_]`。理由：
/// 1. handler 端 `parse_filters` 会把 `(...)` 的内容当字符串绑给 sqlx，PG cast
///    后入 WHERE。理论上不会 SQL 注入，但留有"特殊字符把 query 解析弄歪"的风险。
/// 2. 业务约定 project_id 是数字或短 token，正常值天然落在这个字符集内；非法输入
///    很可能是攻击 / 写错 header —— 静默 drop 比中途 50x 更友好。
///
/// 整段空 / 全过滤掉之后空数组 → 返回 None（不追加 filter，行为 = "无项目过滤"）。
pub fn build_project_ids_filter(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get("x-project-ids").and_then(|v| v.to_str().ok())?;
    let ids: Vec<&str> = raw
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter(|s| s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
        .collect();
    if ids.is_empty() {
        None
    } else {
        Some(format!("project_id.in=({})", ids.join(",")))
    }
}

/// 把原始 PostgREST 风格 query 翻译并附加上 `X-Project-IDs` 派生的 filter。
///
/// 返回值为合成后的 `&` 拼接 query 串（不带前导 `?`）；可能为空字符串。
/// 这是 wrapper handler 用来重建 `RawQuery` 喂给 `list_records` 的核心工具。
pub fn translate_and_augment_query(raw_query: Option<&str>, headers: &HeaderMap) -> String {
    let translated = raw_query.map(translate_query).unwrap_or_default();
    match (translated.is_empty(), build_project_ids_filter(headers)) {
        (true, None) => String::new(),
        (true, Some(pf)) => pf,
        (false, None) => translated,
        (false, Some(pf)) => format!("{}&{}", translated, pf),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderName, HeaderValue};

    fn h(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut hh = HeaderMap::new();
        for (k, v) in pairs {
            hh.insert(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        hh
    }

    #[test]
    fn schema_get_uses_accept_profile() {
        let s = resolve_schema(&Method::GET, &h(&[("accept-profile", "gamesq")]));
        assert_eq!(s, "gamesq");
    }

    #[test]
    fn schema_post_prefers_content_profile_then_accept_profile() {
        let s1 = resolve_schema(
            &Method::POST,
            &h(&[("content-profile", "a"), ("accept-profile", "b")]),
        );
        assert_eq!(s1, "a");
        let s2 = resolve_schema(&Method::POST, &h(&[("accept-profile", "b")]));
        assert_eq!(s2, "b");
    }

    #[test]
    fn schema_defaults_to_public() {
        assert_eq!(resolve_schema(&Method::GET, &h(&[])), "public");
    }

    #[test]
    fn schema_unsafe_falls_back_to_public() {
        let s = resolve_schema(
            &Method::GET,
            &h(&[("accept-profile", "x; DROP TABLE users")]),
        );
        assert_eq!(s, "public");
    }

    #[test]
    fn translates_in_operator() {
        let out = translate_query("status=in.(active,pending)&id=in.(1,2,3)");
        assert_eq!(out, "status.in=(active,pending)&id.in=(1,2,3)");
    }

    #[test]
    fn translates_eq_neq_gte() {
        let out = translate_query("a=eq.1&b=neq.2&c=gte.3");
        assert_eq!(out, "a.eq=1&b.neq=2&c.gte=3");
    }

    #[test]
    fn translate_keeps_reserved_words() {
        let out = translate_query("select=*&order=created_at.desc&limit=20&offset=0");
        assert_eq!(out, "select=*&order=created_at.desc&limit=20&offset=0");
    }

    #[test]
    fn translate_long_op_wins_over_short() {
        // gte 必须比 gt 先匹配，否则 `gte.10` 会被吞成 `gt` + `e.10`
        let out = translate_query("a=gte.10&b=lte.20");
        assert_eq!(out, "a.gte=10&b.lte=20");
    }

    #[test]
    fn translate_passthrough_unknown_op_or_dotted_key() {
        let out = translate_query("a=hello&b.eq=1&c=unknownop.5");
        assert_eq!(out, "a=hello&b.eq=1&c=unknownop.5");
    }

    #[test]
    fn project_ids_basic() {
        let f = build_project_ids_filter(&h(&[("x-project-ids", "1,4,5")])).unwrap();
        assert_eq!(f, "project_id.in=(1,4,5)");
    }

    #[test]
    fn project_ids_drops_unsafe_entries() {
        let f = build_project_ids_filter(&h(&[("x-project-ids", "1,2);DROP,4")])).unwrap();
        assert_eq!(f, "project_id.in=(1,4)");
    }

    #[test]
    fn project_ids_all_filtered_returns_none() {
        let f = build_project_ids_filter(&h(&[("x-project-ids", " , , ")]));
        assert!(f.is_none());
    }

    #[test]
    fn project_ids_missing_header_returns_none() {
        assert!(build_project_ids_filter(&h(&[])).is_none());
    }

    #[test]
    fn translate_and_augment_full_pipeline() {
        let q = translate_and_augment_query(
            Some("select=*&receive_wayuid=eq.xyz&status=eq.1&order=created_at.desc&limit=20"),
            &h(&[("x-project-ids", "1,4,5")]),
        );
        // 顺序检查
        assert!(q.contains("select=*"), "{q}");
        assert!(q.contains("receive_wayuid.eq=xyz"), "{q}");
        assert!(q.contains("status.eq=1"), "{q}");
        assert!(q.contains("order=created_at.desc"), "{q}");
        assert!(q.contains("limit=20"), "{q}");
        assert!(q.contains("project_id.in=(1,4,5)"), "{q}");
    }

    #[test]
    fn translate_and_augment_empty_inputs() {
        assert_eq!(translate_and_augment_query(None, &h(&[])), "");
        assert_eq!(
            translate_and_augment_query(None, &h(&[("x-project-ids", "1")])),
            "project_id.in=(1)"
        );
    }
}
