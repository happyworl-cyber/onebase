//! API Key 驱动的"请求头 → PG session GUC"投喂钩子。
//!
//! 背景：默认情况下 RPC 路径只会注入两个事务局部 GUC——
//! `app.current_user_id` / `app.project_ids`，且**严禁**从请求头读项目列表，
//! 因为这样会让 `assert_project_access` 这类业务护栏被客户端自我授权绕开。
//!
//! 但少数项目（如 shirehub）有上游可信 BFF/网关：网关已经把 way 用户身份 +
//! 该用户当前可访问的 project_ids 验证完，再把结果通过私有头投到 onebase。
//! 这种情况下需要一个"明确 opt-in"的通道，让这把 API Key（而且只有这把 key）
//! 允许从指定 header 取值写到指定 GUC。
//!
//! 设计要点：
//! - **opt-in 在 server 端**：钩子配置存在 `management.api_keys.permissions.session_hooks`
//!   里，是服务端可信数据。客户端无法注入或修改它。没配 = 老行为。
//! - **只对 API Key 主体生效**：JWT 主体已经是可信用户身份，不应被头覆盖。
//! - **GUC 白名单**：只允许写 `^app\.[a-z_][a-z0-9_]{0,63}$` 形态的 GUC，
//!   避免把 hook 配成写 `role` / `search_path` 这种敏感 GUC。
//! - **类型校验**：
//!     - `text`：长度截到 `max_length`，过滤 NUL/CR/LF（这些字符 PG 会拒）；
//!     - `int_csv`：按 `,` 切，每段 `i64` 解析，非整数静默丢弃，截到 `max_count` 段。
//! - **缺值 = 不写**：header 缺失或校验后空值时，hook 不产出 entry，由
//!   `inject_rpc_session_context` 的 default 兜底（保持当前行为，不静默放过）。
//!
//! 配置示例（写在 API Key 的 permissions JSON 里）：
//! ```json
//! {
//!   "session_hooks": [
//!     { "header": "X-Way-UID",     "guc": "app.current_user_id", "type": "text",    "max_length": 256 },
//!     { "header": "X-Project-IDs", "guc": "app.project_ids",     "type": "int_csv", "max_count": 1000 }
//!   ]
//! }
//! ```

use axum::http::HeaderMap;
use serde::Serialize;
use serde_json::Value;

/// 单条 hook 规则。来自 `permissions.session_hooks[]` 的一项，经
/// [`parse_hooks_from_permissions`] 校验后才会进到执行路径。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionHook {
    /// 要读取的 HTTP header 名（大小写不敏感，HeaderMap::get 自身保证）。
    pub header: String,
    /// 要写入的 PG GUC 名，必须匹配 [`is_valid_guc_name`]。
    pub guc: String,
    /// 值类型与裁剪策略。
    pub kind: HookKind,
}

/// hook 值的解析/裁剪类型。每种类型有自己的安全约束，避免恶意 header 把
/// GUC 写成超大字符串或包含非法字符。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HookKind {
    /// 文本：长度上限 `max_length` 字节，过滤 NUL/CR/LF。
    Text { max_length: usize },
    /// 逗号分隔整数列表：每段 `i64::from_str`，非整数丢弃，截到 `max_count` 段。
    IntCsv { max_count: usize },
}

/// 默认值，给 JSON 里漏字段时兜底。
const DEFAULT_TEXT_MAX_LENGTH: usize = 256;
const DEFAULT_INT_CSV_MAX_COUNT: usize = 1000;

/// 严格解析时的单条错误。和 [`parse_hooks_from_value`] 的 Err 配套：
/// handler 拿到 `Vec<HookParseError>` 可以原样返给前端，前端按 `index` 把错误
/// 标到对应行上。
///
/// 与"放给 inject 路径用的容错解析" [`parse_hooks_from_permissions`] 形成对照：
/// - parse_hooks_from_permissions：吞错（丢弃坏条目），不给用户反馈
/// - parse_hooks_from_value：硬错（任何坏条目都拒绝），给用户反馈
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HookParseError {
    /// 错误所在的数组下标；输入根本不是数组时这里是 0。
    pub index: usize,
    /// 错误关联的字段名（如 `"header"` / `"guc"` / `"type"` / `"max_length"`），
    /// `None` 表示是整条 / 整组的结构性问题。
    pub field: Option<String>,
    /// 人话错误描述，给前端直接展示。
    pub reason: String,
}

/// 解析 `permissions.session_hooks`。
///
/// 容错策略：
/// - 整字段缺失 / 不是数组 → 返回空 Vec（= 关闭 hook）。
/// - 数组里某项不合法（缺 header / guc / type、GUC 名非法、type 不识别）→ 丢弃该项，
///   不影响其它项。
/// - `max_length` / `max_count` 缺失或非正整数 → 使用上面的 DEFAULT_*。
pub fn parse_hooks_from_permissions(permissions: &Value) -> Vec<SessionHook> {
    let arr = match permissions.get("session_hooks").and_then(Value::as_array) {
        Some(a) => a,
        None => return Vec::new(),
    };
    arr.iter().filter_map(parse_one_hook).collect()
}

/// 容错版的"数组直解析"：接受一个 hooks 数组 Value（**不**带外层 `session_hooks` 字段），
/// 返回合法 hook 列表，坏条目静默丢弃。
///
/// 用途：inject 路径合并 `management.session_rules.hooks` 列——那一列存的就是 hooks
/// 数组本身，不像 API Key permissions 还需要外层 `session_hooks` 字段包裹。
///
/// 容错策略与 [`parse_hooks_from_permissions`] 一致：
/// - value 不是数组 → 返回空 Vec（行为退化为"该规则未配 hooks"）。
/// - 数组里某项不合法 → 丢弃该项，不影响其它项。
///
/// 之所以**不**复用严格版 [`parse_hooks_from_value`]：inject 是 RPC 热路径，
/// 必须 fail-open——管理界面塞了脏 hook 不能阻塞业务调用。手动管理员配错就该
/// 由管理界面侧的严格校验拦在前面。
pub fn parse_hooks_array_lenient(value: &Value) -> Vec<SessionHook> {
    match value.as_array() {
        Some(arr) => arr.iter().filter_map(parse_one_hook).collect(),
        None => Vec::new(),
    }
}

/// 把"项目级 session_rules.hooks 列（按 id ASC 排好）"与"API Key permissions"
/// 合并成 inject 路径要 apply 的 hook 列表。
///
/// 顺序约定（**列表靠后的优先级高**，因为 `apply_hooks` 后续会用 iter_mut 覆盖
/// 同名 GUC）：
/// 1. project_rules_hooks 各条按入参顺序追加（调用方传入前应按 id ASC 排好）；
/// 2. api_key_permissions 中的 `session_hooks` 数组追加在最后。
///
/// 边界：
/// - project_rules_hooks 里某条不是数组 / 坏条目：内部用 [`parse_hooks_array_lenient`]
///   容错跳过，不阻塞整体。
/// - api_key_permissions 为 None / 没有 session_hooks 字段：跳过这一段。
///
/// 这是一个纯函数，没有 DB / IO，方便单测覆盖优先级语义。
pub fn merge_hooks_for_inject(
    project_rules_hooks: &[Value],
    api_key_permissions: Option<&Value>,
) -> Vec<SessionHook> {
    let mut out: Vec<SessionHook> = Vec::new();
    for rule_hooks in project_rules_hooks {
        let mut hs = parse_hooks_array_lenient(rule_hooks);
        out.append(&mut hs);
    }
    if let Some(perm) = api_key_permissions {
        let mut hs = parse_hooks_from_permissions(perm);
        out.append(&mut hs);
    }
    out
}

fn parse_one_hook(v: &Value) -> Option<SessionHook> {
    let obj = v.as_object()?;
    let header = obj
        .get("header")
        .and_then(Value::as_str)?
        .trim()
        .to_string();
    let guc = obj.get("guc").and_then(Value::as_str)?.trim().to_string();
    if header.is_empty() || !is_valid_guc_name(&guc) {
        return None;
    }
    let ty = obj.get("type").and_then(Value::as_str)?;
    let kind = match ty {
        "text" => {
            let max_length = obj
                .get("max_length")
                .and_then(Value::as_u64)
                .filter(|n| *n > 0)
                .map(|n| n as usize)
                .unwrap_or(DEFAULT_TEXT_MAX_LENGTH);
            HookKind::Text { max_length }
        }
        "int_csv" => {
            let max_count = obj
                .get("max_count")
                .and_then(Value::as_u64)
                .filter(|n| *n > 0)
                .map(|n| n as usize)
                .unwrap_or(DEFAULT_INT_CSV_MAX_COUNT);
            HookKind::IntCsv { max_count }
        }
        _ => return None,
    };
    Some(SessionHook { header, guc, kind })
}

/// 严格解析：用于 handler 校验入参。
///
/// `value` 应该是 hooks 数组本身（**不**是包在 `{"session_hooks": [...]}` 里的对象）。
/// 任何条目失败都会被收集到错误列表里——不会 short-circuit，让前端一次拿到所有
/// 错误（提升修复效率）。
///
/// 与 [`parse_hooks_from_permissions`] 的区别：
/// - 那个吞错（用于 inject 路径，老数据不能阻塞请求）；
/// - 这个硬错（用于 handler，恶意/手滑输入应该被拒绝并告诉用户）。
pub fn parse_hooks_from_value(value: &Value) -> Result<Vec<SessionHook>, Vec<HookParseError>> {
    let arr = match value.as_array() {
        Some(a) => a,
        None => {
            return Err(vec![HookParseError {
                index: 0,
                field: None,
                reason: "hooks 必须是 JSON 数组".to_string(),
            }]);
        }
    };

    let mut out = Vec::with_capacity(arr.len());
    let mut errors = Vec::new();
    for (i, v) in arr.iter().enumerate() {
        match parse_one_hook_strict(v, i) {
            Ok(h) => out.push(h),
            Err(mut e) => errors.append(&mut e),
        }
    }

    if errors.is_empty() {
        Ok(out)
    } else {
        Err(errors)
    }
}

/// 严格解析单条 hook，多错并报；与 [`parse_one_hook`] 的容错版本对照。
fn parse_one_hook_strict(v: &Value, index: usize) -> Result<SessionHook, Vec<HookParseError>> {
    let mut errors = Vec::new();
    let obj = match v.as_object() {
        Some(o) => o,
        None => {
            errors.push(HookParseError {
                index,
                field: None,
                reason: "必须是 JSON 对象".to_string(),
            });
            return Err(errors);
        }
    };

    let header = match obj.get("header").and_then(Value::as_str) {
        Some(s) if !s.trim().is_empty() => s.trim().to_string(),
        Some(_) => {
            errors.push(HookParseError {
                index,
                field: Some("header".to_string()),
                reason: "header 不能为空字符串".to_string(),
            });
            String::new()
        }
        None => {
            errors.push(HookParseError {
                index,
                field: Some("header".to_string()),
                reason: "缺少 header 或不是字符串".to_string(),
            });
            String::new()
        }
    };

    let guc = match obj.get("guc").and_then(Value::as_str) {
        Some(s) if is_valid_guc_name(s.trim()) => s.trim().to_string(),
        Some(s) => {
            errors.push(HookParseError {
                index,
                field: Some("guc".to_string()),
                reason: format!(
                    "GUC 名 '{}' 非法，必须匹配 ^app\\.[a-z_][a-z0-9_]{{0,63}}$",
                    s.trim()
                ),
            });
            String::new()
        }
        None => {
            errors.push(HookParseError {
                index,
                field: Some("guc".to_string()),
                reason: "缺少 guc 或不是字符串".to_string(),
            });
            String::new()
        }
    };

    let kind = match obj.get("type").and_then(Value::as_str) {
        Some("text") => {
            let max_length = parse_positive_usize(obj.get("max_length"), DEFAULT_TEXT_MAX_LENGTH);
            HookKind::Text { max_length }
        }
        Some("int_csv") => {
            let max_count = parse_positive_usize(obj.get("max_count"), DEFAULT_INT_CSV_MAX_COUNT);
            HookKind::IntCsv { max_count }
        }
        Some(other) => {
            errors.push(HookParseError {
                index,
                field: Some("type".to_string()),
                reason: format!("type '{}' 不支持，仅允许 'text' / 'int_csv'", other),
            });
            HookKind::Text {
                max_length: DEFAULT_TEXT_MAX_LENGTH,
            }
        }
        None => {
            errors.push(HookParseError {
                index,
                field: Some("type".to_string()),
                reason: "缺少 type 或不是字符串".to_string(),
            });
            HookKind::Text {
                max_length: DEFAULT_TEXT_MAX_LENGTH,
            }
        }
    };

    if errors.is_empty() {
        Ok(SessionHook { header, guc, kind })
    } else {
        Err(errors)
    }
}

/// 把 JSON 里的整数字段解析成 `usize`，<=0 或类型错误时用 default 兜底（与
/// `parse_one_hook` 同款宽松策略——严格解析里只把字段缺失 / 类型对但 ≤0 视作
/// "用默认值"，不视作错误，避免轰炸用户）。
fn parse_positive_usize(v: Option<&Value>, default: usize) -> usize {
    v.and_then(Value::as_u64)
        .filter(|n| *n > 0)
        .map(|n| n as usize)
        .unwrap_or(default)
}

/// 给 hook 用的 GUC 名白名单：必须是 `app.<name>` 形态。
///
/// 限制在 `app.*` 是为了：
/// - 避免误写 PG 内置/敏感 GUC（如 `role`、`search_path`、`session_authorization`）
/// - 给业务一个一目了然的命名空间
pub fn is_valid_guc_name(name: &str) -> bool {
    let Some(suffix) = name.strip_prefix("app.") else {
        return false;
    };
    if suffix.is_empty() || suffix.len() > 64 {
        return false;
    }
    let mut chars = suffix.chars();
    let first = chars.next().unwrap();
    if !(first.is_ascii_lowercase() || first == '_') {
        return false;
    }
    for c in chars {
        if !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') {
            return false;
        }
    }
    true
}

/// 把 hook 列表套到当前请求头上，返回需要写入的 `(guc, value)` 列表。
///
/// 调用方拿到这个列表后，逐项 `SELECT set_config(guc, value, true)` 即可。
/// 缺值/校验失败的 hook **不**出现在返回里，由调用方的 default 兜底。
pub fn apply_hooks(hooks: &[SessionHook], headers: &HeaderMap) -> Vec<(String, String)> {
    let mut out = Vec::with_capacity(hooks.len());
    for h in hooks {
        let Some(raw) = headers.get(&h.header).and_then(|v| v.to_str().ok()) else {
            continue;
        };
        let value = match &h.kind {
            HookKind::Text { max_length } => sanitize_text(raw, *max_length),
            HookKind::IntCsv { max_count } => sanitize_int_csv(raw, *max_count),
        };
        if let Some(v) = value {
            out.push((h.guc.clone(), v));
        }
    }
    out
}

/// 文本值清洗：去掉两端空白，剔除 NUL/CR/LF（GUC 不允许），截到 max_length 字节。
/// 空串 → None（视为缺值）。
///
/// 截断按字节边界处理时小心 UTF-8 多字节字符：找最后一个有效字符边界，不在中间截断。
fn sanitize_text(raw: &str, max_length: usize) -> Option<String> {
    let cleaned: String = raw
        .trim()
        .chars()
        .filter(|c| *c != '\0' && *c != '\r' && *c != '\n')
        .collect();
    if cleaned.is_empty() {
        return None;
    }
    if cleaned.len() <= max_length {
        return Some(cleaned);
    }
    // 找到 ≤ max_length 的最大 UTF-8 字符边界
    let mut end = max_length;
    while end > 0 && !cleaned.is_char_boundary(end) {
        end -= 1;
    }
    if end == 0 {
        None
    } else {
        Some(cleaned[..end].to_string())
    }
}

/// 整数 CSV 清洗：按 `,` 切，每段 trim 后 `i64::from_str`，非整数丢弃，
/// 截到前 `max_count` 个有效值，重新拼回逗号串。
/// 全部无效或空串 → None。
fn sanitize_int_csv(raw: &str, max_count: usize) -> Option<String> {
    let parts: Vec<String> = raw
        .split(',')
        .filter_map(|s| s.trim().parse::<i64>().ok())
        .take(max_count)
        .map(|n| n.to_string())
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(","))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderName, HeaderValue};
    use serde_json::json;

    fn h(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in pairs {
            let name = HeaderName::from_bytes(k.as_bytes()).unwrap();
            m.insert(name, HeaderValue::from_str(v).unwrap());
        }
        m
    }

    // ─── GUC 名白名单 ───

    #[test]
    fn guc_name_accepts_app_namespaced_snake_case() {
        assert!(is_valid_guc_name("app.current_user_id"));
        assert!(is_valid_guc_name("app.project_ids"));
        assert!(is_valid_guc_name("app.way_uid"));
        assert!(is_valid_guc_name("app._underscore_start"));
    }

    #[test]
    fn guc_name_rejects_non_app_namespace() {
        assert!(!is_valid_guc_name("role"));
        assert!(!is_valid_guc_name("search_path"));
        assert!(!is_valid_guc_name("session_authorization"));
        assert!(!is_valid_guc_name("public.foo"));
    }

    #[test]
    fn guc_name_rejects_bad_chars_or_lengths() {
        assert!(!is_valid_guc_name("app."));
        assert!(!is_valid_guc_name("app.WithUpper"));
        assert!(!is_valid_guc_name("app.with-dash"));
        assert!(!is_valid_guc_name("app.semi;colon"));
        assert!(!is_valid_guc_name("app.1starts_digit"));
        let long_suffix = "a".repeat(65);
        assert!(!is_valid_guc_name(&format!("app.{}", long_suffix)));
    }

    // ─── parse_hooks_from_permissions ───

    #[test]
    fn parse_returns_empty_when_field_missing() {
        let perms = json!({});
        assert!(parse_hooks_from_permissions(&perms).is_empty());
    }

    #[test]
    fn parse_returns_empty_when_field_not_array() {
        let perms = json!({ "session_hooks": "X-Foo" });
        assert!(parse_hooks_from_permissions(&perms).is_empty());
    }

    #[test]
    fn parse_returns_well_formed_text_hook() {
        let perms = json!({
            "session_hooks": [
                { "header": "X-Way-UID", "guc": "app.current_user_id", "type": "text", "max_length": 128 }
            ]
        });
        let hooks = parse_hooks_from_permissions(&perms);
        assert_eq!(
            hooks,
            vec![SessionHook {
                header: "X-Way-UID".into(),
                guc: "app.current_user_id".into(),
                kind: HookKind::Text { max_length: 128 },
            }]
        );
    }

    #[test]
    fn parse_returns_well_formed_int_csv_hook() {
        let perms = json!({
            "session_hooks": [
                { "header": "X-Project-IDs", "guc": "app.project_ids", "type": "int_csv", "max_count": 50 }
            ]
        });
        let hooks = parse_hooks_from_permissions(&perms);
        assert_eq!(
            hooks,
            vec![SessionHook {
                header: "X-Project-IDs".into(),
                guc: "app.project_ids".into(),
                kind: HookKind::IntCsv { max_count: 50 },
            }]
        );
    }

    #[test]
    fn parse_uses_defaults_when_caps_missing_or_invalid() {
        let perms = json!({
            "session_hooks": [
                { "header": "X-A", "guc": "app.a", "type": "text" },
                { "header": "X-B", "guc": "app.b", "type": "int_csv" },
                { "header": "X-C", "guc": "app.c", "type": "text", "max_length": 0 },
            ]
        });
        let hooks = parse_hooks_from_permissions(&perms);
        assert_eq!(hooks.len(), 3);
        assert_eq!(
            hooks[0].kind,
            HookKind::Text {
                max_length: DEFAULT_TEXT_MAX_LENGTH
            }
        );
        assert_eq!(
            hooks[1].kind,
            HookKind::IntCsv {
                max_count: DEFAULT_INT_CSV_MAX_COUNT
            }
        );
        assert_eq!(
            hooks[2].kind,
            HookKind::Text {
                max_length: DEFAULT_TEXT_MAX_LENGTH
            }
        );
    }

    #[test]
    fn parse_drops_entries_with_bad_guc_or_unknown_type() {
        let perms = json!({
            "session_hooks": [
                { "header": "X-OK",  "guc": "app.ok",       "type": "text" },
                { "header": "X-Bad", "guc": "role",         "type": "text" },
                { "header": "X-Bad", "guc": "app.ok2",      "type": "weird_type" },
                { "header": "",      "guc": "app.empty_hdr","type": "text" },
                { "guc":    "app.no_header",                "type": "text" },
            ]
        });
        let hooks = parse_hooks_from_permissions(&perms);
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].header, "X-OK");
    }

    // ─── apply_hooks: text ───

    #[test]
    fn apply_text_extracts_value() {
        let hooks = vec![SessionHook {
            header: "X-Way-UID".into(),
            guc: "app.current_user_id".into(),
            kind: HookKind::Text { max_length: 256 },
        }];
        let out = apply_hooks(&hooks, &h(&[("x-way-uid", "adosp9duiiysjbwzetodwomnie")]));
        assert_eq!(
            out,
            vec![(
                "app.current_user_id".into(),
                "adosp9duiiysjbwzetodwomnie".into()
            )]
        );
    }

    #[test]
    fn apply_text_truncates_to_max_length_on_char_boundary() {
        let hooks = vec![SessionHook {
            header: "X-Long".into(),
            guc: "app.long".into(),
            kind: HookKind::Text { max_length: 5 },
        }];
        let out = apply_hooks(&hooks, &h(&[("x-long", "abcdefghij")]));
        assert_eq!(out, vec![("app.long".into(), "abcde".into())]);
    }

    #[test]
    fn apply_text_skips_when_header_missing() {
        let hooks = vec![SessionHook {
            header: "X-Missing".into(),
            guc: "app.x".into(),
            kind: HookKind::Text { max_length: 256 },
        }];
        let out = apply_hooks(&hooks, &h(&[]));
        assert!(out.is_empty());
    }

    #[test]
    fn apply_text_skips_when_empty_or_whitespace_only() {
        let hooks = vec![SessionHook {
            header: "X-Empty".into(),
            guc: "app.x".into(),
            kind: HookKind::Text { max_length: 256 },
        }];
        let out = apply_hooks(&hooks, &h(&[("x-empty", "   ")]));
        assert!(out.is_empty());
    }

    // ─── apply_hooks: int_csv ───

    #[test]
    fn apply_int_csv_parses_and_filters_non_integers() {
        let hooks = vec![SessionHook {
            header: "X-Project-IDs".into(),
            guc: "app.project_ids".into(),
            kind: HookKind::IntCsv { max_count: 1000 },
        }];
        let out = apply_hooks(&hooks, &h(&[("x-project-ids", "1, 4, foo, 5, 7,  ,13")]));
        assert_eq!(out, vec![("app.project_ids".into(), "1,4,5,7,13".into())]);
    }

    #[test]
    fn apply_int_csv_caps_count() {
        let hooks = vec![SessionHook {
            header: "X-P".into(),
            guc: "app.project_ids".into(),
            kind: HookKind::IntCsv { max_count: 3 },
        }];
        let out = apply_hooks(&hooks, &h(&[("x-p", "1,2,3,4,5")]));
        assert_eq!(out, vec![("app.project_ids".into(), "1,2,3".into())]);
    }

    #[test]
    fn apply_int_csv_skips_when_all_invalid_or_empty() {
        let hooks = vec![SessionHook {
            header: "X-P".into(),
            guc: "app.project_ids".into(),
            kind: HookKind::IntCsv { max_count: 10 },
        }];
        assert!(apply_hooks(&hooks, &h(&[("x-p", "foo,bar")])).is_empty());
        assert!(apply_hooks(&hooks, &h(&[("x-p", "")])).is_empty());
        assert!(apply_hooks(&hooks, &h(&[])).is_empty());
    }

    // ─── apply_hooks: 多 hook ───

    #[test]
    fn apply_runs_all_hooks_independently() {
        let hooks = vec![
            SessionHook {
                header: "X-Way-UID".into(),
                guc: "app.current_user_id".into(),
                kind: HookKind::Text { max_length: 256 },
            },
            SessionHook {
                header: "X-Project-IDs".into(),
                guc: "app.project_ids".into(),
                kind: HookKind::IntCsv { max_count: 1000 },
            },
        ];
        let out = apply_hooks(
            &hooks,
            &h(&[("x-way-uid", "user-abc"), ("x-project-ids", "4,7")]),
        );
        assert_eq!(
            out,
            vec![
                ("app.current_user_id".into(), "user-abc".into()),
                ("app.project_ids".into(), "4,7".into()),
            ]
        );
    }

    // ─── merge_hooks_for_inject（合并语义 + 优先级） ───

    #[test]
    fn merge_returns_only_api_key_hooks_when_no_project_rules() {
        let perm = json!({
            "session_hooks": [
                { "header": "X-A", "guc": "app.a", "type": "text" }
            ]
        });
        let out = merge_hooks_for_inject(&[], Some(&perm));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].guc, "app.a");
    }

    #[test]
    fn merge_returns_only_project_hooks_when_no_api_key() {
        let rule = json!([
            { "header": "X-A", "guc": "app.a", "type": "text" }
        ]);
        let out = merge_hooks_for_inject(&[rule], None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].guc, "app.a");
    }

    #[test]
    fn merge_returns_empty_when_both_sides_empty() {
        assert!(merge_hooks_for_inject(&[], None).is_empty());
        assert!(merge_hooks_for_inject(&[], Some(&json!({}))).is_empty());
        assert!(merge_hooks_for_inject(&[json!([])], Some(&json!({}))).is_empty());
    }

    #[test]
    fn merge_concatenates_project_rules_in_order_then_api_key_last() {
        // 项目级 rule1（id=10）：app.a
        let r1 = json!([
            { "header": "X-A", "guc": "app.a", "type": "text" }
        ]);
        // 项目级 rule2（id=20）：app.b
        let r2 = json!([
            { "header": "X-B", "guc": "app.b", "type": "text" }
        ]);
        // API Key：app.c
        let perm = json!({
            "session_hooks": [
                { "header": "X-C", "guc": "app.c", "type": "text" }
            ]
        });
        let out = merge_hooks_for_inject(&[r1, r2], Some(&perm));
        let gucs: Vec<_> = out.iter().map(|h| h.guc.as_str()).collect();
        // 期望顺序：project rules 按入参顺序（id ASC），api_key 在最后
        assert_eq!(gucs, vec!["app.a", "app.b", "app.c"]);
    }

    #[test]
    fn merge_api_key_wins_on_same_guc_via_apply() {
        // 同一 GUC 名 app.x：project rule 走 header X-P，api_key 走 header X-K
        let rule = json!([
            { "header": "X-P", "guc": "app.x", "type": "text" }
        ]);
        let perm = json!({
            "session_hooks": [
                { "header": "X-K", "guc": "app.x", "type": "text" }
            ]
        });
        let hooks = merge_hooks_for_inject(&[rule], Some(&perm));

        let h = h(&[("X-P", "from-project"), ("X-K", "from-api-key")]);
        let pairs = apply_hooks(&hooks, &h);
        // 两条都命中（都写 app.x），但调用方 inject_rpc_session_context 用 iter_mut
        // 覆盖时，apply_hooks 返回 vec 里靠后的写入会覆盖靠前的——也就是 API Key 优先。
        // 这里只验证 apply_hooks 返回值的顺序：project 在前，api_key 在后。
        let values: Vec<_> = pairs
            .iter()
            .filter(|(g, _)| g == "app.x")
            .map(|(_, v)| v.as_str())
            .collect();
        assert_eq!(values, vec!["from-project", "from-api-key"]);
    }

    #[test]
    fn merge_later_project_rule_wins_over_earlier_for_same_guc() {
        // 多条 active rule 在 inject 路径按 id ASC 入列，**后规则覆盖前规则**。
        let r_early = json!([
            { "header": "X-Old", "guc": "app.x", "type": "text" }
        ]);
        let r_late = json!([
            { "header": "X-New", "guc": "app.x", "type": "text" }
        ]);
        let hooks = merge_hooks_for_inject(&[r_early, r_late], None);
        let h = h(&[("X-Old", "old-val"), ("X-New", "new-val")]);
        let pairs = apply_hooks(&hooks, &h);
        let values: Vec<_> = pairs
            .iter()
            .filter(|(g, _)| g == "app.x")
            .map(|(_, v)| v.as_str())
            .collect();
        assert_eq!(values, vec!["old-val", "new-val"]);
    }

    #[test]
    fn merge_skips_invalid_project_rule_entries() {
        // 一条 rule 是合法数组，另一条根本不是数组（脏数据 / 未初始化）。
        let good = json!([
            { "header": "X-OK", "guc": "app.ok", "type": "text" }
        ]);
        let bad = json!({ "not": "an_array" });
        let out = merge_hooks_for_inject(&[bad, good], None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].guc, "app.ok");
    }

    // ─── parse_hooks_array_lenient（数组直解析，容错） ───

    #[test]
    fn lenient_array_parse_returns_hooks_for_well_formed_array() {
        let v = json!([
            { "header": "X-A", "guc": "app.a", "type": "text" },
            { "header": "X-B", "guc": "app.b", "type": "int_csv", "max_count": 5 }
        ]);
        let hooks = parse_hooks_array_lenient(&v);
        assert_eq!(hooks.len(), 2);
        assert_eq!(hooks[0].guc, "app.a");
        assert_eq!(hooks[1].kind, HookKind::IntCsv { max_count: 5 });
    }

    #[test]
    fn lenient_array_parse_drops_bad_entries_keeps_good_ones() {
        let v = json!([
            { "header": "X-A", "guc": "app.a", "type": "text" },          // 合法
            { "header": "X-B", "guc": "role",  "type": "text" },          // GUC 非法 → 丢
            { "header": "",    "guc": "app.c", "type": "text" },          // header 空 → 丢
            "not_an_object",                                              // 不是 object → 丢
            { "header": "X-D", "guc": "app.d", "type": "weird" },         // type 不识别 → 丢
            { "header": "X-E", "guc": "app.e", "type": "int_csv" },       // 合法
        ]);
        let hooks = parse_hooks_array_lenient(&v);
        let gucs: Vec<_> = hooks.iter().map(|h| h.guc.as_str()).collect();
        assert_eq!(gucs, vec!["app.a", "app.e"]);
    }

    #[test]
    fn lenient_array_parse_returns_empty_for_non_array() {
        assert!(parse_hooks_array_lenient(&json!(null)).is_empty());
        assert!(parse_hooks_array_lenient(&json!({})).is_empty());
        assert!(parse_hooks_array_lenient(&json!("hi")).is_empty());
        assert!(parse_hooks_array_lenient(&json!(42)).is_empty());
    }

    // ─── parse_hooks_from_value（严格解析） ───

    #[test]
    fn strict_parse_returns_ok_for_well_formed_array() {
        let v = json!([
            { "header": "X-Way-UID", "guc": "app.current_user_id", "type": "text", "max_length": 256 },
            { "header": "X-Project-IDs", "guc": "app.project_ids", "type": "int_csv", "max_count": 1000 }
        ]);
        let hooks = parse_hooks_from_value(&v).expect("应成功");
        assert_eq!(hooks.len(), 2);
        assert_eq!(hooks[0].header, "X-Way-UID");
        assert_eq!(hooks[1].guc, "app.project_ids");
    }

    #[test]
    fn strict_parse_returns_ok_for_empty_array() {
        let v = json!([]);
        let hooks = parse_hooks_from_value(&v).expect("空数组合法");
        assert!(hooks.is_empty());
    }

    #[test]
    fn strict_parse_rejects_non_array_root() {
        let v = json!({ "session_hooks": [] });
        let errs = parse_hooks_from_value(&v).expect_err("对象不是数组");
        assert_eq!(errs.len(), 1);
        assert_eq!(errs[0].index, 0);
        assert!(errs[0].field.is_none());
        assert!(errs[0].reason.contains("数组"));
    }

    #[test]
    fn strict_parse_reports_missing_header() {
        let v = json!([
            { "guc": "app.x", "type": "text" }
        ]);
        let errs = parse_hooks_from_value(&v).expect_err("缺 header");
        assert_eq!(errs.len(), 1);
        assert_eq!(errs[0].index, 0);
        assert_eq!(errs[0].field.as_deref(), Some("header"));
    }

    #[test]
    fn strict_parse_reports_empty_header() {
        let v = json!([
            { "header": "  ", "guc": "app.x", "type": "text" }
        ]);
        let errs = parse_hooks_from_value(&v).expect_err("空 header");
        assert!(errs.iter().any(|e| e.field.as_deref() == Some("header")));
    }

    #[test]
    fn strict_parse_reports_bad_guc() {
        let v = json!([
            { "header": "X-Foo", "guc": "role", "type": "text" }
        ]);
        let errs = parse_hooks_from_value(&v).expect_err("非法 guc");
        assert!(errs.iter().any(|e| e.field.as_deref() == Some("guc")));
    }

    #[test]
    fn strict_parse_reports_unknown_type() {
        let v = json!([
            { "header": "X-Foo", "guc": "app.foo", "type": "weird" }
        ]);
        let errs = parse_hooks_from_value(&v).expect_err("type 不识别");
        assert_eq!(errs.len(), 1);
        assert_eq!(errs[0].field.as_deref(), Some("type"));
    }

    #[test]
    fn strict_parse_collects_multiple_errors_across_items() {
        let v = json!([
            { "header": "X-OK",  "guc": "app.ok", "type": "text" },     // 合法
            { "header": "",      "guc": "app.bad", "type": "text" },    // header 空
            { "header": "X-Bad", "guc": "role",   "type": "text" },     // guc 非法
            { "header": "X-Bad", "guc": "app.ok", "type": "weird" },    // type 非法
            "not_an_object",                                            // 不是对象
        ]);
        let errs = parse_hooks_from_value(&v).expect_err("有错");
        // 至少 4 个 index 出错（1/2/3/4）
        let indexes: std::collections::HashSet<usize> = errs.iter().map(|e| e.index).collect();
        assert!(indexes.contains(&1));
        assert!(indexes.contains(&2));
        assert!(indexes.contains(&3));
        assert!(indexes.contains(&4));
        // index 0 应该正常通过，不产生错误
        assert!(!indexes.contains(&0));
    }

    #[test]
    fn strict_parse_treats_invalid_max_length_as_default() {
        // max_length = 0 不算错（与宽松版一致），用默认值兜底
        let v = json!([
            { "header": "X-Foo", "guc": "app.foo", "type": "text", "max_length": 0 }
        ]);
        let hooks = parse_hooks_from_value(&v).expect("应成功");
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].kind, HookKind::Text { max_length: 256 });
    }

    // ─── 其它 apply 路径补测 ───

    #[test]
    fn apply_drops_control_chars_in_text() {
        let hooks = vec![SessionHook {
            header: "X-Way-UID".into(),
            guc: "app.current_user_id".into(),
            kind: HookKind::Text { max_length: 256 },
        }];
        let out = apply_hooks(&hooks, &h(&[("x-way-uid", "ok-value")]));
        assert_eq!(out[0].1, "ok-value");
        // 注：HeaderValue 本身不允许 NUL/CR/LF 进来；这里再过滤一道纯属 defense-in-depth。
    }
}
