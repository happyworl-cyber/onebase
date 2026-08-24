//! 操作日志（operation_logs）打点、记录与读时格式化。
//!
//! 设计见 `docs/superpowers/specs/2026-08-04-operation-logs-design.md`。
//!
//! 三层职责：**写 = 存结构化事实 → 读 = 后端格式化成视图 → 前端 = 呈现**。
//!
//! - 打点方在业务调用点构造 [`OperationLogInput`]，调 [`record`]（fire-and-forget，
//!   异步写库、失败仅 `warn!`、DB 未配置时静默跳过，绝不阻塞主流程）。
//! - 变更内容以**结构化事实**（机器可读 before/after / diff，带版本 `v`）存进
//!   `detail.change`；读取时由 [`format_change`] 格式化成可读视图返回给前端。
//! - 「什么算高危」集中在 [`derive_high_risk`]（第一期仅"工作流删除"），
//!   打点方可用 `high_risk: Some(_)` 覆盖。

use serde_json::{json, Value};
use sqlx::PgPool;

/// 操作来源通道。VARCHAR 落库，加值零成本。
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Console,
    Api,
    Mcp,
    Cron,
    System,
}

/// 可选的来源提示。用于**同一个 handler 被多渠道调用**的场景：
/// HTTP 路由不注入它 → handler 取默认 [`Source::Console`]；
/// MCP 直接调用 handler 时传 `Some(Extension(OpSourceHint(Source::Mcp)))` 覆盖。
#[derive(Clone, Copy, Debug)]
pub struct OpSourceHint(pub Source);

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Console => "console",
            Source::Api => "api",
            Source::Mcp => "mcp",
            Source::Cron => "cron",
            Source::System => "system",
        }
    }
}

/// 操作者。MCP/API 经认证映射为真实用户 → [`Actor::User`]；
/// 仅 cron/system 是无人类主体的机器 → [`Actor::System`]。
#[allow(dead_code)]
#[derive(Clone, Debug)]
pub enum Actor {
    User {
        id: i32,
        name: String,
        /// 操作时租户角色快照（owner/admin/member/viewer），可空。
        role: Option<String>,
    },
    System {
        /// 展示名，如 "系统调度器"。
        name: String,
    },
}

impl Actor {
    /// 从登录态构造用户 actor（本期不填租户角色快照）。各 handler 打点的统一入口，
    /// 避免到处手写 `Actor::User { id: claims.sub, name: claims.email.clone(), role: None }`。
    pub fn from_claims(claims: &crate::auth::Claims) -> Self {
        Actor::User {
            id: claims.sub,
            name: claims.email.clone(),
            role: None,
        }
    }
}

/// 操作结果状态。
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Success,
    Failed,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Success => "success",
            Status::Failed => "failed",
        }
    }
}

/// 动作词表常量（避免各处硬编码字符串拼错）。
#[allow(dead_code)]
pub mod action {
    pub const CREATE: &str = "CREATE";
    pub const UPDATE: &str = "UPDATE";
    pub const DELETE: &str = "DELETE";
    pub const READ: &str = "READ";
    pub const EXPORT: &str = "EXPORT";
    pub const IMPORT: &str = "IMPORT";
    pub const LOGIN: &str = "LOGIN";
    pub const PERMISSION: &str = "PERMISSION";
    pub const TRIGGER: &str = "TRIGGER";
    pub const EXECUTE: &str = "EXECUTE";
}

/// 常见资源类型（中文标签，落 `resource_type`）。
#[allow(dead_code)]
pub mod resource_type {
    pub const WORKFLOW: &str = "工作流";
    pub const DATABASE: &str = "数据库";
    pub const TABLE: &str = "数据表";
    pub const SCHEMA: &str = "Schema";
    pub const INDEX: &str = "索引";
    pub const API: &str = "API";
    pub const USER: &str = "用户";
    pub const ROLE: &str = "角色";
    pub const ENV_VAR: &str = "环境变量";
    pub const PROJECT_SETTING: &str = "项目设置";
    pub const RLS: &str = "RLS";
    pub const RPC_ACL: &str = "RPC ACL";
    pub const IDP: &str = "身份提供方";
    pub const OAUTH2_CLIENT: &str = "OAuth2 Client";
    pub const SCHEDULED_TASK: &str = "定时任务";
    pub const SYSTEM: &str = "系统";
}

/// 打点入参契约。任意子系统"按此传值"即可打点。
pub struct OperationLogInput {
    pub tenant_id: i32,
    pub actor: Actor,
    pub source: Source,
    /// 用 [`action`] 常量，如 `action::CREATE`。
    pub action: String,
    pub resource_type: Option<String>,
    pub resource_name: Option<String>,
    pub resource_id: Option<String>,
    /// 人类可读「操作内容」，列表主展示（写入时给）。
    pub summary: String,
    pub status: Status,
    /// `None` → 由 [`derive_high_risk`] 规则推导；`Some(_)` → 打点方覆盖。
    pub high_risk: Option<bool>,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    pub session_id: Option<String>,
    pub trace_id: Option<String>,
    pub duration_ms: Option<i32>,
    /// 结构化变更事实（`{ v, kind, ... }`），落 `detail.change`；读时 [`format_change`] 渲染。
    pub change: Option<Value>,
    /// 其它上下文（method/endpoint/mcp_tool/query/error…）。
    pub detail: Option<Value>,
}

impl OperationLogInput {
    /// 便捷构造：最小必填 + 其余默认 None。
    pub fn new(
        tenant_id: i32,
        actor: Actor,
        source: Source,
        action: impl Into<String>,
        summary: impl Into<String>,
        status: Status,
    ) -> Self {
        Self {
            tenant_id,
            actor,
            source,
            action: action.into(),
            resource_type: None,
            resource_name: None,
            resource_id: None,
            summary: summary.into(),
            status,
            high_risk: None,
            ip: None,
            user_agent: None,
            session_id: None,
            trace_id: None,
            duration_ms: None,
            change: None,
            detail: None,
        }
    }

    pub fn resource(
        mut self,
        rtype: impl Into<String>,
        name: impl Into<String>,
        id: Option<String>,
    ) -> Self {
        self.resource_type = Some(rtype.into());
        self.resource_name = Some(name.into());
        self.resource_id = id;
        self
    }

    pub fn change(mut self, change: Value) -> Self {
        self.change = Some(change);
        self
    }

    pub fn detail(mut self, detail: Value) -> Self {
        self.detail = Some(detail);
        self
    }
}

/// 高危判定（规则集中在此，打点方永远可用 `Some(_)` 覆盖）：
/// - 删工作流；
/// - 删表 / 删 Schema（结构级不可逆破坏）。
/// 其余 false，留扩展空间；后续接入权限变更 / 系统级改删等时在此增量加规则。
pub fn derive_high_risk(action: &str, resource_type: Option<&str>) -> bool {
    matches!(
        (action, resource_type),
        (action::DELETE, Some(resource_type::WORKFLOW))
            | (action::DELETE, Some(resource_type::TABLE))
            | (action::DELETE, Some(resource_type::SCHEMA))
    )
}

fn actor_columns(actor: &Actor) -> (&'static str, Option<i32>, Option<String>, Option<String>) {
    match actor {
        Actor::User { id, name, role } => ("user", Some(*id), Some(name.clone()), role.clone()),
        Actor::System { name } => ("system", None, Some(name.clone()), Some("系统".to_string())),
    }
}

/// 组装最终落库的 `detail`：把结构化 `change` 合并进 detail 的 `change` 字段。
fn build_detail(detail: Option<Value>, change: Option<Value>) -> Option<Value> {
    let mut obj = match detail {
        Some(Value::Object(m)) => m,
        Some(other) => {
            // 非对象的 detail 包一层，避免丢失
            let mut m = serde_json::Map::new();
            m.insert("value".to_string(), other);
            m
        }
        None => serde_json::Map::new(),
    };
    if let Some(change) = change {
        obj.insert("change".to_string(), change);
    }
    if obj.is_empty() {
        None
    } else {
        Some(Value::Object(obj))
    }
}

/// 真正的写库逻辑（高危推导 → actor 拆列 → 合并 detail → INSERT）。
/// 由 [`record`] / [`record_db_op`] 在各自 spawn 出来的任务里 await 调用。
async fn write_log(pool: &PgPool, input: OperationLogInput) {
    let high_risk = input
        .high_risk
        .unwrap_or_else(|| derive_high_risk(&input.action, input.resource_type.as_deref()));
    let (actor_type, actor_id, actor_name, actor_role) = actor_columns(&input.actor);
    let detail = build_detail(input.detail, input.change);

    let res = sqlx::query(
        "INSERT INTO management.operation_logs \
         (tenant_id, actor_type, actor_id, actor_name, actor_role, source, action, \
          resource_type, resource_name, resource_id, summary, status, high_risk, \
          ip, user_agent, session_id, trace_id, duration_ms, detail) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)",
    )
    .bind(input.tenant_id)
    .bind(actor_type)
    .bind(actor_id)
    .bind(actor_name)
    .bind(actor_role)
    .bind(input.source.as_str())
    .bind(&input.action)
    .bind(input.resource_type)
    .bind(input.resource_name)
    .bind(input.resource_id)
    .bind(&input.summary)
    .bind(input.status.as_str())
    .bind(high_risk)
    .bind(input.ip)
    .bind(input.user_agent)
    .bind(input.session_id)
    .bind(input.trace_id)
    .bind(input.duration_ms)
    .bind(detail)
    .execute(pool)
    .await;

    if let Err(e) = res {
        tracing::warn!(action = %input.action, "operation_logs INSERT 失败: {}", e);
    }
}

/// **打点入口**：fire-and-forget 异步写库。
///
/// - 永不 panic、永不阻塞调用方；写失败仅 `warn!`（审计不影响主业务）。
/// - `pool` 传管理库连接池（`operation_logs` 在 management schema）。
pub fn record(pool: &PgPool, input: OperationLogInput) {
    let pool = pool.clone();
    tokio::spawn(async move {
        write_log(&pool, input).await;
    });
}

/// **数据库类操作打点便捷入口**：调用方通常只有 `database_id`（而没有 tenant_id），
/// 这里在后台任务里按 `database_id` 反查租户与库名，再落库。fire-and-forget。
///
/// - `resource_name = None` 时用数据库连接名兜底（如原始 SQL/事务这种"针对整库"的操作）。
/// - 反查不到租户/库（如管理库、已停用库）→ 静默跳过，绝不阻塞主流程。
#[allow(clippy::too_many_arguments)]
pub fn record_db_op(
    pool: &PgPool,
    database_id: i32,
    actor: Actor,
    source: Source,
    action: &str,
    resource_type: &str,
    resource_name: Option<String>,
    resource_id: Option<String>,
    summary: String,
    status: Status,
    high_risk: Option<bool>,
    change: Option<Value>,
    detail: Option<Value>,
) {
    let pool = pool.clone();
    let action = action.to_string();
    let resource_type = resource_type.to_string();
    tokio::spawn(async move {
        let row = sqlx::query_as::<_, (i32, Option<String>)>(
            "SELECT tenant_id, connection_name FROM management.tenant_databases \
             WHERE id = $1 AND is_active = true",
        )
        .bind(database_id)
        .fetch_optional(&pool)
        .await;
        let (tenant_id, db_name) = match row {
            Ok(Some((tid, name))) => (tid, name),
            _ => return, // 解析不到租户/库 → 跳过
        };
        let rname = resource_name
            .or(db_name)
            .unwrap_or_else(|| format!("数据库 #{database_id}"));

        let mut input = OperationLogInput::new(tenant_id, actor, source, action, summary, status)
            .resource(resource_type, rname, resource_id);
        input.high_risk = high_risk;
        if let Some(c) = change {
            input = input.change(c);
        }
        if let Some(d) = detail {
            input = input.detail(d);
        }
        write_log(&pool, input).await;
    });
}

// ============ 读时格式化：结构化事实 → 视图 ============

fn val_to_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "—".to_string(),
        other => other.to_string(),
    }
}

/// object → `[{label, value}]`（generic 摘要）。
fn fields_to_summary(fields: &Value) -> Vec<Value> {
    match fields.as_object() {
        Some(map) => map
            .iter()
            .map(|(k, v)| json!({ "label": k, "value": val_to_str(v) }))
            .collect(),
        None => vec![],
    }
}

/// 把结构化变更事实 `detail.change` 格式化为前端可渲染的视图。
///
/// 返回 `None` 表示无变更内容可展示。formatter 按 `kind`（+未来按 `resource_type`/`v`）分派，
/// 新旧 payload 版本靠 `v` 兼容——本期 `v=1`。
pub fn format_change(_action: &str, _resource_type: Option<&str>, change: &Value) -> Option<Value> {
    let kind = change.get("kind").and_then(|k| k.as_str())?;
    match kind {
        "created" | "deleted" => {
            let summary = change
                .get("fields")
                .map(fields_to_summary)
                .unwrap_or_default();
            if summary.is_empty() {
                return None;
            }
            Some(json!({ "kind": kind, "summary": summary }))
        }
        "imported" => {
            // 批量导入：直接透传导入项列表（每项 {name, slug, action}）。
            match change.get("items").and_then(|a| a.as_array()) {
                Some(items) if !items.is_empty() => {
                    Some(json!({ "kind": "imported", "items": items }))
                }
                _ => None,
            }
        }
        "sql" => {
            // 原始 SQL / 事务执行：透传 SQL 文本、类型、多语句列表、影响行数给前端代码块展示。
            let mut out = serde_json::Map::new();
            out.insert("kind".to_string(), json!("sql"));
            let mut has_body = false;
            if let Some(sql) = change.get("sql").and_then(|s| s.as_str()) {
                if !sql.trim().is_empty() {
                    out.insert("sql".to_string(), json!(sql));
                    has_body = true;
                }
            }
            if let Some(stmts) = change.get("statements").and_then(|a| a.as_array()) {
                if !stmts.is_empty() {
                    out.insert("statements".to_string(), json!(stmts));
                    has_body = true;
                }
            }
            if let Some(t) = change.get("sql_type").and_then(|s| s.as_str()) {
                out.insert("sql_type".to_string(), json!(t));
            }
            if let Some(rows) = change.get("rows") {
                out.insert("rows".to_string(), rows.clone());
            }
            if has_body {
                Some(Value::Object(out))
            } else {
                None
            }
        }
        "modified" => {
            let mut groups: Vec<Value> = Vec::new();

            let added = change.get("added").and_then(|a| a.as_array());
            if let Some(items) = added {
                if !items.is_empty() {
                    let mapped: Vec<Value> = items.iter().map(map_addremove_item).collect();
                    groups.push(json!({ "op": "add", "title": "新增", "items": mapped }));
                }
            }

            let modified = change.get("modified").and_then(|a| a.as_array());
            if let Some(items) = modified {
                if !items.is_empty() {
                    let mapped: Vec<Value> = items.iter().map(map_modified_item).collect();
                    groups.push(json!({ "op": "modify", "title": "修改", "items": mapped }));
                }
            }

            let removed = change.get("removed").and_then(|a| a.as_array());
            if let Some(items) = removed {
                if !items.is_empty() {
                    let mapped: Vec<Value> = items.iter().map(map_addremove_item).collect();
                    groups.push(json!({ "op": "delete", "title": "删除", "items": mapped }));
                }
            }

            if groups.is_empty() {
                return None;
            }
            Some(json!({ "kind": "modified", "groups": groups }))
        }
        _ => None,
    }
}

/// 新增/删除条目：取 node/edge 作 name，node_type 作 type。
fn map_addremove_item(item: &Value) -> Value {
    let name = item
        .get("node")
        .or_else(|| item.get("edge"))
        .or_else(|| item.get("name"))
        .map(val_to_str)
        .unwrap_or_default();
    let mut out = serde_json::Map::new();
    out.insert("name".to_string(), json!(name));
    if let Some(t) = item.get("node_type").or_else(|| item.get("type")) {
        out.insert("type".to_string(), json!(val_to_str(t)));
    }
    if item.get("edge").is_some() {
        out.entry("type".to_string()).or_insert(json!("连线"));
    }
    Value::Object(out)
}

/// 修改条目：node 作 name。字段变更支持两种输入：
/// - **单字段**：`{node, field, old, new}`（工作流节点级 diff 用）；
/// - **多字段**：`{node, fields:[{field|key, old, new}, ...]}`（配置级一次列多字段，如启用状态/名称/超时）。
fn map_modified_item(item: &Value) -> Value {
    let name = item
        .get("node")
        .or_else(|| item.get("name"))
        .map(val_to_str)
        .unwrap_or_default();
    let mut fields: Vec<Value> = Vec::new();
    // 多字段格式
    if let Some(arr) = item.get("fields").and_then(|f| f.as_array()) {
        for f in arr {
            let key = f
                .get("field")
                .or_else(|| f.get("key"))
                .map(val_to_str)
                .unwrap_or_default();
            fields.push(json!({
                "key": key,
                "old": f.get("old").map(val_to_str).unwrap_or_else(|| "—".into()),
                "new": f.get("new").map(val_to_str).unwrap_or_else(|| "—".into()),
            }));
        }
    }
    // 单字段格式
    if let Some(field) = item.get("field") {
        fields.push(json!({
            "key": val_to_str(field),
            "old": item.get("old").map(val_to_str).unwrap_or_else(|| "—".into()),
            "new": item.get("new").map(val_to_str).unwrap_or_else(|| "—".into()),
        }));
    }
    let mut out = serde_json::Map::new();
    out.insert("name".to_string(), json!(name));
    if !fields.is_empty() {
        out.insert("fields".to_string(), json!(fields));
    }
    if let Some(t) = item.get("node_type").or_else(|| item.get("type")) {
        out.insert("type".to_string(), json!(val_to_str(t)));
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn high_risk_covers_destructive_deletes() {
        // 高危：删工作流 / 删表 / 删 Schema。
        assert!(derive_high_risk(
            action::DELETE,
            Some(resource_type::WORKFLOW)
        ));
        assert!(derive_high_risk(action::DELETE, Some(resource_type::TABLE)));
        assert!(derive_high_risk(
            action::DELETE,
            Some(resource_type::SCHEMA)
        ));
        // 非删除 / 非结构对象一律 false。
        assert!(!derive_high_risk(
            action::UPDATE,
            Some(resource_type::WORKFLOW)
        ));
        assert!(!derive_high_risk(
            action::CREATE,
            Some(resource_type::TABLE)
        ));
        assert!(!derive_high_risk(
            action::DELETE,
            Some(resource_type::INDEX)
        ));
        assert!(!derive_high_risk(
            action::PERMISSION,
            Some(resource_type::ROLE)
        ));
        assert!(!derive_high_risk(action::DELETE, None));
    }

    #[test]
    fn high_risk_override_respected_via_input() {
        // 覆盖语义在 record() 内：Some(_) 优先于规则。这里直接验证规则本身。
        assert!(!derive_high_risk(
            action::CREATE,
            Some(resource_type::WORKFLOW)
        ));
    }

    #[test]
    fn source_and_status_as_str() {
        assert_eq!(Source::Mcp.as_str(), "mcp");
        assert_eq!(Source::Cron.as_str(), "cron");
        assert_eq!(Status::Failed.as_str(), "failed");
    }

    #[test]
    fn actor_columns_user_and_system() {
        let (t, id, name, role) = actor_columns(&Actor::User {
            id: 7,
            name: "叙白".into(),
            role: Some("admin".into()),
        });
        assert_eq!(t, "user");
        assert_eq!(id, Some(7));
        assert_eq!(name.as_deref(), Some("叙白"));
        assert_eq!(role.as_deref(), Some("admin"));

        let (t, id, name, role) = actor_columns(&Actor::System {
            name: "系统调度器".into(),
        });
        assert_eq!(t, "system");
        assert_eq!(id, None);
        assert_eq!(name.as_deref(), Some("系统调度器"));
        assert_eq!(role.as_deref(), Some("系统"));
    }

    #[test]
    fn build_detail_merges_change() {
        let d = build_detail(
            Some(json!({ "method": "PATCH" })),
            Some(json!({ "v": 1, "kind": "modified" })),
        )
        .unwrap();
        assert_eq!(d["method"], "PATCH");
        assert_eq!(d["change"]["kind"], "modified");

        // 都为空 → None
        assert!(build_detail(None, None).is_none());
    }

    #[test]
    fn format_created_summary() {
        let change = json!({
            "v": 1, "kind": "created",
            "fields": { "id": 251, "slug": "daily-digest", "nodes": 5 }
        });
        let view = format_change(action::CREATE, Some(resource_type::WORKFLOW), &change).unwrap();
        assert_eq!(view["kind"], "created");
        let summary = view["summary"].as_array().unwrap();
        assert_eq!(summary.len(), 3);
        // value 被字符串化
        assert!(summary
            .iter()
            .any(|s| s["label"] == "slug" && s["value"] == "daily-digest"));
    }

    #[test]
    fn format_modified_groups_with_old_new() {
        let change = json!({
            "v": 1, "kind": "modified",
            "added":    [ { "node": "check_empty", "node_type": "condition" } ],
            "modified": [ { "node": "send_reply", "field": "timeout_ms", "old": 5000, "new": 8000 } ],
            "removed":  [ { "edge": "a->b" } ]
        });
        let view = format_change(action::UPDATE, Some(resource_type::WORKFLOW), &change).unwrap();
        let groups = view["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 3);

        let modify = groups.iter().find(|g| g["op"] == "modify").unwrap();
        let item = &modify["items"][0];
        assert_eq!(item["name"], "send_reply");
        assert_eq!(item["fields"][0]["key"], "timeout_ms");
        assert_eq!(item["fields"][0]["old"], "5000");
        assert_eq!(item["fields"][0]["new"], "8000");

        let del = groups.iter().find(|g| g["op"] == "delete").unwrap();
        assert_eq!(del["items"][0]["name"], "a->b");
        assert_eq!(del["items"][0]["type"], "连线");
    }

    #[test]
    fn format_modified_supports_multi_field_item() {
        // 配置级：一个节点条目携带多字段（启用状态 / 名称）。
        let change = json!({
            "v": 1, "kind": "modified",
            "modified": [ {
                "node": "每日摘要",
                "fields": [
                    { "field": "启用状态", "old": "停用", "new": "启用" },
                    { "field": "超时(ms)", "old": 5000, "new": 8000 },
                ]
            } ]
        });
        let view = format_change(action::UPDATE, Some(resource_type::WORKFLOW), &change).unwrap();
        let item = &view["groups"][0]["items"][0];
        assert_eq!(item["name"], "每日摘要");
        let fields = item["fields"].as_array().unwrap();
        assert_eq!(fields.len(), 2);
        assert!(fields
            .iter()
            .any(|f| f["key"] == "启用状态" && f["old"] == "停用" && f["new"] == "启用"));
        assert!(fields
            .iter()
            .any(|f| f["key"] == "超时(ms)" && f["new"] == "8000"));
    }

    #[test]
    fn format_change_empty_returns_none() {
        assert!(format_change(action::UPDATE, None, &json!({ "kind": "modified" })).is_none());
        assert!(format_change(action::CREATE, None, &json!({ "kind": "unknown" })).is_none());
    }

    #[test]
    fn format_sql_passthrough() {
        // 单条 SQL：透传 sql/sql_type/rows。
        let change = json!({
            "v": 1, "kind": "sql",
            "sql": "DROP TABLE public.tmp",
            "sql_type": "DROP", "rows": 0
        });
        let view = format_change(action::EXECUTE, Some(resource_type::DATABASE), &change).unwrap();
        assert_eq!(view["kind"], "sql");
        assert_eq!(view["sql"], "DROP TABLE public.tmp");
        assert_eq!(view["sql_type"], "DROP");

        // 事务：多语句列表。
        let txn = json!({
            "v": 1, "kind": "sql",
            "statements": [ { "op": "UPDATE", "table": "public.users" } ]
        });
        let tview = format_change(action::EXECUTE, None, &txn).unwrap();
        assert_eq!(tview["statements"].as_array().unwrap().len(), 1);

        // 无 sql 也无 statements → 无内容。
        assert!(format_change(
            action::EXECUTE,
            None,
            &json!({ "kind": "sql", "sql_type": "SELECT" })
        )
        .is_none());
    }

    #[test]
    fn format_imported_lists_items() {
        let change = json!({
            "v": 1, "kind": "imported",
            "items": [
                { "name": "每日摘要", "slug": "daily-digest", "action": "create" },
                { "name": "", "slug": "order-sync", "action": "overwrite" }
            ]
        });
        let view = format_change(action::IMPORT, Some(resource_type::WORKFLOW), &change).unwrap();
        assert_eq!(view["kind"], "imported");
        assert_eq!(view["items"].as_array().unwrap().len(), 2);
        assert_eq!(view["items"][0]["slug"], "daily-digest");
        // 空 items → 无内容
        assert!(format_change(
            action::IMPORT,
            None,
            &json!({ "kind": "imported", "items": [] })
        )
        .is_none());
    }
}
