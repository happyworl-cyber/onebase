use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::audit_middleware::{set_audit_detail, AuditDetailSink};
use crate::auth::Claims;
use crate::error::{AppError, Result};
use crate::middleware::ApiKeyContext;
use crate::operation_log::{self, Actor, OpSourceHint, OperationLogInput, Source, Status};
use std::collections::BTreeMap;
use crate::workflow_engine::{
    self, ApiKeyWriteGuard, DagEngine, ExecutionContext, NodeExecutionResult, NodeStatus,
    WorkflowDefinition,
};
use crate::workflow_taxonomy::{self, WorkflowTaxonomy};

// ─── 数据模型 ─────────────────────────────────────────

fn audit_workflow(
    sink: &Option<axum::Extension<AuditDetailSink>>,
    kind: &str,
    workflow_id: i32,
    name: &str,
    slug: &str,
    extra: Value,
) {
    let mut detail = json!({
        "workflow_id": workflow_id,
        "name": name,
        "slug": slug,
    });
    if let Some(obj) = detail.as_object_mut() {
        if let Some(ext) = extra.as_object() {
            for (k, v) in ext {
                obj.insert(k.clone(), v.clone());
            }
        }
    }
    set_audit_detail(sink, kind, detail);
}

// ─── 操作日志（operation_logs）打点辅助 ─────────────────────────────
//
// 设计见 docs/superpowers/specs/2026-08-04-operation-logs-design.md：
// 写入时存"结构化事实"（change），读取时由后端 format_change 渲染。
// 这里的 diff 负责把新旧工作流定义整理成机器可读的 added/modified/removed 事实。

/// 来源解析：HTTP 路由无此提示 → Console；MCP 直接调用会传 Some(Mcp)。
fn op_source_of(hint: &Option<axum::Extension<OpSourceHint>>) -> Source {
    hint.as_ref().map(|axum::Extension(h)| h.0).unwrap_or(Source::Console)
}

fn nodes_count(nodes: &Value) -> usize {
    nodes.as_array().map(|a| a.len()).unwrap_or(0)
}

fn scalar_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".to_string(),
        other => other.to_string(),
    }
}

/// 布局 / 画布内部字段（节点坐标、尺寸、选中态等）：不算业务变更，diff 时忽略。
/// 例如前端画布给节点带的 `_position: {x,y}` —— 挪动位置不应产生一条"修改"记录。
fn is_ignorable_node_key(k: &str) -> bool {
    if k.starts_with('_') {
        return true;
    }
    matches!(
        k.to_ascii_lowercase().as_str(),
        "position" | "positionabsolute" | "x" | "y" | "width" | "height" | "selected" | "dragging" | "zindex"
    )
}

/// 把一个节点对象拍平成 field→value（含 config 下钻一层），用于字段级 diff。
/// 会跳过布局/内部字段（见 [`is_ignorable_node_key`]），避免坐标改动污染变更内容。
fn flat_node_fields(node: &Value) -> BTreeMap<String, String> {
    let mut m = BTreeMap::new();
    if let Some(obj) = node.as_object() {
        for (k, v) in obj {
            if k == "id" || is_ignorable_node_key(k) {
                continue;
            }
            if k == "config" {
                if let Some(cfg) = v.as_object() {
                    for (ck, cv) in cfg {
                        if is_ignorable_node_key(ck) {
                            continue;
                        }
                        m.insert(ck.clone(), scalar_str(cv));
                    }
                }
            } else {
                m.insert(k.clone(), scalar_str(v));
            }
        }
    }
    m
}

fn node_id(node: &Value) -> Option<String> {
    node.get("id").and_then(|x| x.as_str()).map(String::from)
}

fn node_type_of(node: &Value) -> Option<String> {
    node.get("type")
        .or_else(|| node.get("node_type"))
        .and_then(|x| x.as_str())
        .map(String::from)
}

fn edge_key(edge: &Value) -> String {
    let from = edge.get("from").and_then(|x| x.as_str()).unwrap_or("?");
    let to = edge.get("to").and_then(|x| x.as_str()).unwrap_or("?");
    match edge.get("branch").and_then(|x| x.as_str()) {
        Some(b) if !b.is_empty() => format!("{from} --{b}--> {to}"),
        _ => format!("{from} -> {to}"),
    }
}

/// 生成工作流 update 的结构化变更事实（`{v,kind:"modified",added,modified,removed}`）。
/// 返回 `None` 表示无实质变更（不产出变更内容）。
fn workflow_change_diff(old: &Workflow, new: &Workflow) -> Option<Value> {
    diff_definition(&old.nodes, &old.edges, &new.nodes, &new.edges)
}

/// 工作流"配置级"字段 diff（非 nodes/edges）：启用状态 / 名称 / 超时 / 重试 / 描述 等标量字段。
/// enable/disable、改名这类列表页局部更新用它产出变更内容，避免"更新配置"详情空白。
/// 返回 `{v,kind:"modified",modified:[{node,fields:[{field,old,new}]}]}`，无变化则 `None`。
fn workflow_config_diff(old: &Workflow, new: &Workflow) -> Option<Value> {
    let en = |b: bool| if b { "启用" } else { "停用" };
    let mut fields: Vec<Value> = Vec::new();
    if old.is_enabled != new.is_enabled {
        fields.push(json!({ "field": "启用状态", "old": en(old.is_enabled), "new": en(new.is_enabled) }));
    }
    if old.name != new.name {
        fields.push(json!({ "field": "名称", "old": old.name, "new": new.name }));
    }
    if old.timeout_ms != new.timeout_ms {
        fields.push(json!({ "field": "超时(ms)", "old": old.timeout_ms, "new": new.timeout_ms }));
    }
    if old.max_retries != new.max_retries {
        fields.push(json!({ "field": "最大重试", "old": old.max_retries, "new": new.max_retries }));
    }
    if old.description != new.description {
        fields.push(json!({
            "field": "描述",
            "old": old.description.clone().unwrap_or_default(),
            "new": new.description.clone().unwrap_or_default(),
        }));
    }
    if fields.is_empty() {
        return None;
    }
    Some(json!({ "v": 1, "kind": "modified", "modified": [ { "node": new.name, "fields": fields } ] }))
}

/// 纯函数版：对新旧 nodes/edges（JSON 数组）做 diff。抽出便于单测。
fn diff_definition(
    old_nodes_v: &Value,
    old_edges_v: &Value,
    new_nodes_v: &Value,
    new_edges_v: &Value,
) -> Option<Value> {
    let empty: Vec<Value> = vec![];
    let old_nodes = old_nodes_v.as_array().unwrap_or(&empty);
    let new_nodes = new_nodes_v.as_array().unwrap_or(&empty);
    let old_edges = old_edges_v.as_array().unwrap_or(&empty);
    let new_edges = new_edges_v.as_array().unwrap_or(&empty);

    let old_node_map: BTreeMap<String, &Value> =
        old_nodes.iter().filter_map(|n| node_id(n).map(|id| (id, n))).collect();
    let new_node_map: BTreeMap<String, &Value> =
        new_nodes.iter().filter_map(|n| node_id(n).map(|id| (id, n))).collect();

    let mut added: Vec<Value> = Vec::new();
    let mut removed: Vec<Value> = Vec::new();
    let mut modified: Vec<Value> = Vec::new();

    for (id, node) in &new_node_map {
        if !old_node_map.contains_key(id) {
            added.push(json!({ "node": id, "node_type": node_type_of(node) }));
        }
    }
    for (id, node) in &old_node_map {
        if !new_node_map.contains_key(id) {
            removed.push(json!({ "node": id, "node_type": node_type_of(node) }));
        }
    }
    for (id, new_node) in &new_node_map {
        if let Some(old_node) = old_node_map.get(id) {
            let of = flat_node_fields(old_node);
            let nf = flat_node_fields(new_node);
            let mut keys: Vec<&String> = of.keys().chain(nf.keys()).collect();
            keys.sort();
            keys.dedup();
            for key in keys {
                let ov = of.get(key);
                let nv = nf.get(key);
                if ov != nv {
                    modified.push(json!({
                        "node": id,
                        "field": key,
                        "old": ov.cloned().unwrap_or_else(|| "—".to_string()),
                        "new": nv.cloned().unwrap_or_else(|| "—".to_string()),
                    }));
                }
            }
        }
    }

    // 连线：仅增删（用 from/to/branch 作 key）。
    let old_edge_keys: std::collections::BTreeSet<String> =
        old_edges.iter().map(edge_key).collect();
    let new_edge_keys: std::collections::BTreeSet<String> =
        new_edges.iter().map(edge_key).collect();
    for k in new_edge_keys.difference(&old_edge_keys) {
        added.push(json!({ "edge": k }));
    }
    for k in old_edge_keys.difference(&new_edge_keys) {
        removed.push(json!({ "edge": k }));
    }

    if added.is_empty() && removed.is_empty() && modified.is_empty() {
        return None;
    }
    Some(json!({
        "v": 1, "kind": "modified",
        "added": added, "modified": modified, "removed": removed,
    }))
}

fn workflow_snapshot_fields(wf: &Workflow, kind: &str) -> Value {
    json!({
        "v": 1,
        "kind": kind,
        "fields": {
            "id": wf.id,
            "slug": wf.slug,
            "nodes": nodes_count(&wf.nodes),
            "trigger_type": wf.trigger_type,
            "enabled": wf.is_enabled,
        }
    })
}

/// 统一打点：工作流操作 → operation_logs。tenant_id 缺失（平台共享工作流）则跳过。
fn record_workflow_op(
    pool: &PgPool,
    claims: &Claims,
    source: Source,
    action: &str,
    wf: &Workflow,
    summary: String,
    change: Option<Value>,
) {
    let tenant_id = match wf.tenant_id {
        Some(t) => t,
        None => return,
    };
    let mut input = OperationLogInput::new(
        tenant_id,
        Actor::User {
            id: claims.sub,
            name: claims.email.clone(),
            role: None,
        },
        source,
        action,
        summary,
        Status::Success,
    )
    .resource(
        operation_log::resource_type::WORKFLOW,
        wf.name.clone(),
        Some(wf.id.to_string()),
    )
    .detail(json!({ "slug": wf.slug, "database_id": wf.database_id }));
    if let Some(c) = change {
        input = input.change(c);
    }
    operation_log::record(pool, input);
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Workflow {
    pub id: i32,
    pub tenant_id: Option<i32>,
    pub database_id: Option<i32>,
    pub name: String,
    pub slug: String,
    pub description: Option<String>,
    pub category: Option<String>,
    pub department: Option<String>,
    pub trigger_type: String,
    pub trigger_config: Value,
    pub nodes: Value,
    pub edges: Value,
    #[serde(default = "default_json_object")]
    pub dependencies: Value,
    pub is_enabled: bool,
    pub timeout_ms: i32,
    pub max_retries: i32,
    pub alert_webhook_url: Option<String>,
    pub alert_webhook_template: Option<Value>,
    pub alert_throttle_hours: i32,
    pub last_alert_sent_at: Option<chrono::DateTime<chrono::Utc>>,
    pub created_by: Option<i32>,
    pub created_at: chrono::NaiveDateTime,
    pub updated_at: chrono::NaiveDateTime,
    // 创建者账号信息：仅在列表/详情查询里 JOIN users 填充；其它 SELECT * 查询缺列时默认 None。
    #[sqlx(default)]
    pub created_by_name: Option<String>,
    #[sqlx(default)]
    pub created_by_email: Option<String>,
}

/// 数据库 `TIMESTAMP` 列以 UTC 存储但不带时区信息，直接序列化会丢失时区标记，
/// 导致前端把 UTC 当成本地时间。这里序列化为带偏移的 RFC3339（带 Z），前端可正确转换。
fn serialize_naive_as_utc<S>(
    dt: &chrono::NaiveDateTime,
    s: S,
) -> std::result::Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    use serde::Serialize;
    chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(*dt, chrono::Utc).serialize(s)
}

fn serialize_naive_as_utc_opt<S>(
    dt: &Option<chrono::NaiveDateTime>,
    s: S,
) -> std::result::Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    match dt {
        Some(d) => serialize_naive_as_utc(d, s),
        None => s.serialize_none(),
    }
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct WorkflowRun {
    pub id: i64,
    pub workflow_id: i32,
    pub tenant_id: Option<i32>,
    pub trigger_type: String,
    pub trigger_data: Option<Value>,
    pub status: String,
    pub node_results: Value,
    pub final_output: Option<Value>,
    pub error_message: Option<String>,
    pub elapsed_ms: Option<i64>,
    #[serde(serialize_with = "serialize_naive_as_utc")]
    pub started_at: chrono::NaiveDateTime,
    #[serde(serialize_with = "serialize_naive_as_utc_opt")]
    pub completed_at: Option<chrono::NaiveDateTime>,
}

/// 工作流定义快照（版本控制）。只含定义相关字段，不含 is_enabled / 绑定信息。
#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct WorkflowVersion {
    pub id: i64,
    pub workflow_id: i32,
    pub version: i32,
    pub name: String,
    pub slug: String,
    pub description: Option<String>,
    pub category: Option<String>,
    pub department: Option<String>,
    pub trigger_type: String,
    pub trigger_config: Value,
    pub nodes: Value,
    pub edges: Value,
    pub timeout_ms: i32,
    pub max_retries: i32,
    pub note: Option<String>,
    pub created_by: Option<i32>,
    #[serde(serialize_with = "serialize_naive_as_utc")]
    pub created_at: chrono::NaiveDateTime,
    #[sqlx(default)]
    pub created_by_name: Option<String>,
    #[sqlx(default)]
    pub created_by_email: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateWorkflowRequest {
    pub name: String,
    pub slug: String,
    pub description: Option<String>,
    pub category: Option<String>,
    pub department: Option<String>,
    pub database_id: Option<i32>,
    pub trigger_type: Option<String>,
    pub trigger_config: Option<Value>,
    pub nodes: Value,
    pub edges: Value,
    pub dependencies: Option<Value>,
    pub is_enabled: Option<bool>,
    pub timeout_ms: Option<i32>,
    pub max_retries: Option<i32>,
    pub alert_webhook_url: Option<String>,
    pub alert_webhook_template: Option<Value>,
    pub alert_throttle_hours: Option<i32>,
    pub tenant_id: Option<i32>,
    /// 版本备注（可选）：随首个版本快照一起记录。
    pub version_note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateWorkflowRequest {
    pub name: Option<String>,
    pub slug: Option<String>,
    pub description: Option<String>,
    pub category: Option<String>,
    pub department: Option<String>,
    pub database_id: Option<i32>,
    pub trigger_type: Option<String>,
    pub trigger_config: Option<Value>,
    pub nodes: Option<Value>,
    pub edges: Option<Value>,
    pub dependencies: Option<Value>,
    /// 增量节点补丁（整节点替换语义）：数组里每个节点按 id 与现有 nodes 合并——
    /// id 已存在则整体替换该节点，不存在则新增。与全量 `nodes` 互斥。
    pub node_patch: Option<Value>,
    /// 要删除的节点 id 列表。可与 `node_patch` 同时使用；与全量 `nodes` 互斥。
    pub remove_node_ids: Option<Vec<String>>,
    pub is_enabled: Option<bool>,
    pub timeout_ms: Option<i32>,
    pub max_retries: Option<i32>,
    #[serde(default)]
    pub alert_webhook_url: Option<Option<String>>,
    #[serde(default)]
    pub alert_webhook_template: Option<Option<Value>>,
    pub alert_throttle_hours: Option<i32>,
    /// 版本备注（可选）：仅在本次保存改动了定义（带 nodes/edges）时记录到新版本快照。
    pub version_note: Option<String>,
}

fn default_json_object() -> Value {
    json!({})
}

fn normalize_alert_webhook_url(url: Option<&str>) -> Result<Option<String>> {
    let Some(url) = url else {
        return Ok(None);
    };
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err(AppError::InvalidQuery(
            "告警 Webhook URL 必须以 http:// 或 https:// 开头".to_string(),
        ));
    }
    Ok(Some(trimmed.to_string()))
}

fn validate_alert_webhook_template(template: Option<&Value>) -> Result<()> {
    if let Some(v) = template {
        if !v.is_object() {
            return Err(AppError::InvalidQuery(
                "告警 Webhook 模板必须是 JSON object".to_string(),
            ));
        }
    }
    Ok(())
}

fn validate_alert_throttle_hours(hours: Option<i32>) -> Result<()> {
    if let Some(h) = hours {
        if !(0..=720).contains(&h) {
            return Err(AppError::InvalidQuery(
                "告警限流小时数必须在 0 到 720 之间".to_string(),
            ));
        }
    }
    Ok(())
}

// ─── 管理 API Handler ─────────────────────────────────────────

/// 工作流写操作（创建/编辑/删除/复制）的授权门槛。
///
/// 语义：**owner/admin/member 均可**（viewer 不可），或平台超管。工作流被视为"业务级
/// 资产"——开发者（member 角色）需要通过 UI / MCP 创作与维护工作流，因此放行 member；
/// 与 `require_tenant_member`（业务级写操作）保持一致。租户无关的平台级工作流
/// （tenant_id/database_id 都为空）仍需超管。
async fn require_admin_for_workflow(
    pool: &PgPool,
    claims: &Claims,
    workflow: &Workflow,
) -> Result<()> {
    if let Some(database_id) = workflow.database_id {
        return crate::permissions::require_database_member(pool, claims, database_id).await;
    }
    if let Some(tenant_id) = workflow.tenant_id {
        return crate::permissions::require_tenant_member(pool, claims, tenant_id).await;
    }
    crate::permissions::require_platform_superadmin(claims)
}

async fn fetch_workflow_for_admin(pool: &PgPool, claims: &Claims, id: i32) -> Result<Workflow> {
    let workflow =
        sqlx::query_as::<_, Workflow>("SELECT * FROM management.workflows WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("工作流 {} 不存在", id)))?;
    require_admin_for_workflow(pool, claims, &workflow).await?;
    Ok(workflow)
}

/// 给 workflow 当前定义打一份版本快照（version 自增）。
///
/// version 用 `MAX(version)+1` 子查询在单条 INSERT 内原子计算；并发保存同一 workflow 时，
/// `UNIQUE(workflow_id, version)` 兜底保证不会出现重复版本号（极少数撞号的那次保存会报错，
/// 由调用方决定是否致命——这里作为非阻断的"尽力而为"，失败仅记日志）。
async fn snapshot_workflow_version(
    pool: &PgPool,
    workflow: &Workflow,
    note: Option<&str>,
    created_by: Option<i32>,
) -> Result<i32> {
    let note = note.map(str::trim).filter(|s| !s.is_empty());
    let row = sqlx::query(
        r#"INSERT INTO management.workflow_versions
           (workflow_id, version, name, slug, description, category, department,
            trigger_type, trigger_config, nodes, edges, timeout_ms, max_retries, note, created_by)
           VALUES ($1,
                   (SELECT COALESCE(MAX(version), 0) + 1 FROM management.workflow_versions WHERE workflow_id = $1),
                   $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           RETURNING version"#,
    )
    .bind(workflow.id)
    .bind(&workflow.name)
    .bind(&workflow.slug)
    .bind(&workflow.description)
    .bind(&workflow.category)
    .bind(&workflow.department)
    .bind(&workflow.trigger_type)
    .bind(&workflow.trigger_config)
    .bind(&workflow.nodes)
    .bind(&workflow.edges)
    .bind(workflow.timeout_ms)
    .bind(workflow.max_retries)
    .bind(note)
    .bind(created_by)
    .fetch_one(pool)
    .await?;
    Ok(row.get::<i32, _>("version"))
}

async fn resolve_tenant_for_workflow_input(
    pool: &PgPool,
    claims: &Claims,
    database_id: Option<i32>,
    tenant_id: Option<i32>,
) -> Result<Option<i32>> {
    // 工作流是"业务级资产"：owner/admin/member 均可创作（viewer 不可），或平台超管。
    // 与 `require_admin_for_workflow` 的编辑门槛保持一致，避免"能建不能改"的割裂。
    match (database_id, tenant_id) {
        (Some(database_id), Some(tenant_id)) => {
            let actual_tenant_id =
                crate::permissions::lookup_tenant_for_database(pool, database_id).await?;
            if actual_tenant_id != tenant_id {
                return Err(AppError::InvalidQuery(format!(
                    "database_id={} 不属于 tenant_id={}",
                    database_id, tenant_id
                )));
            }
            crate::permissions::require_database_member(pool, claims, database_id).await?;
            Ok(Some(actual_tenant_id))
        }
        (Some(database_id), None) => {
            crate::permissions::require_database_member(pool, claims, database_id).await?;
            Ok(Some(
                crate::permissions::lookup_tenant_for_database(pool, database_id).await?,
            ))
        }
        (None, Some(tenant_id)) => {
            crate::permissions::require_tenant_member(pool, claims, tenant_id).await?;
            Ok(Some(tenant_id))
        }
        (None, None) => {
            crate::permissions::require_platform_superadmin(claims)?;
            Ok(None)
        }
    }
}

const LIST_DEFAULT_PAGE_SIZE: i64 = 10;
const LIST_MAX_PAGE_SIZE: i64 = 100;

#[derive(Debug, Clone)]
struct ParsedListParams {
    tenant_id: Option<i32>,
    database_id: Option<i32>,
    department: Option<String>,
    category: Option<String>,
    uncategorized: Option<bool>,
    global_search: bool,
    search: Option<String>,
    is_enabled: Option<bool>,
    trigger_types: Vec<String>,
    author: Option<String>,
    sort: String,
    page: Option<i64>,
    page_size: Option<i64>,
    include_authors: bool,
}

#[derive(Debug)]
enum ListScope {
    Database(i32),
    Tenant(i32),
    SuperAdmin,
    TenantAdmin(Vec<i32>),
    Empty,
}

fn parse_bool_param(v: &str) -> bool {
    v == "1" || v.eq_ignore_ascii_case("true")
}

fn parse_list_params(params: &HashMap<String, String>) -> ParsedListParams {
    let trigger_types = params
        .get("trigger_type")
        .map(|s| {
            s.split(',')
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    ParsedListParams {
        tenant_id: params.get("tenant_id").and_then(|v| v.parse().ok()),
        database_id: params.get("database_id").and_then(|v| v.parse().ok()),
        department: params
            .get("department")
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        category: params
            .get("category")
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        uncategorized: params.get("uncategorized").map(|s| parse_bool_param(s)),
        global_search: params
            .get("global_search")
            .map(|s| parse_bool_param(s))
            .unwrap_or(false),
        search: params
            .get("search")
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        is_enabled: params.get("is_enabled").and_then(|s| match s.as_str() {
            "true" | "1" => Some(true),
            "false" | "0" => Some(false),
            _ => None,
        }),
        trigger_types,
        author: params
            .get("author")
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        sort: params
            .get("sort")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "created_at".to_string()),
        page: params.get("page").and_then(|v| v.parse().ok()),
        page_size: params.get("page_size").and_then(|v| v.parse().ok()),
        include_authors: params
            .get("include_authors")
            .map(|s| parse_bool_param(s))
            .unwrap_or(false),
    }
}

async fn resolve_list_scope(
    pool: &PgPool,
    claims: &Claims,
    tenant_id: Option<i32>,
    database_id: Option<i32>,
) -> Result<ListScope> {
    if let Some(did) = database_id {
        // 显式按库筛选：member 也放行（工作流是业务级资产，开发者需能查看自己创作的）。
        crate::permissions::require_database_member(pool, claims, did).await?;
        Ok(ListScope::Database(did))
    } else if let Some(tid) = tenant_id {
        crate::permissions::require_tenant_member(pool, claims, tid).await?;
        Ok(ListScope::Tenant(tid))
    } else if claims.is_superadmin {
        Ok(ListScope::SuperAdmin)
    } else {
        // 默认作用域（无显式筛选）：工作流是业务级资产，member 也应看到自己所在租户的。
        let tenant_ids = crate::permissions::tenant_member_ids(pool, claims).await?;
        if tenant_ids.is_empty() {
            Ok(ListScope::Empty)
        } else {
            Ok(ListScope::TenantAdmin(tenant_ids))
        }
    }
}

fn push_list_scope(qb: &mut sqlx::QueryBuilder<'_, sqlx::Postgres>, scope: &ListScope) {
    match scope {
        ListScope::Database(did) => {
            qb.push("WHERE w.database_id = ").push_bind(*did);
        }
        ListScope::Tenant(tid) => {
            qb.push("WHERE w.tenant_id = ").push_bind(*tid);
        }
        ListScope::SuperAdmin => {
            qb.push("WHERE TRUE");
        }
        ListScope::TenantAdmin(tenant_ids) => {
            qb.push(
                "LEFT JOIN management.tenant_databases td ON td.id = w.database_id \
                 WHERE (w.tenant_id = ANY(",
            )
            .push_bind(tenant_ids.clone())
            .push(") OR td.tenant_id = ANY(")
            .push_bind(tenant_ids.clone())
            .push("))");
        }
        ListScope::Empty => {
            qb.push("WHERE FALSE");
        }
    }
}

/// ILIKE 模式转义：先转义反斜杠（默认 escape 字符），再转义通配符 % 和 _。
fn escape_like(term: &str) -> String {
    term.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn push_list_filters(qb: &mut sqlx::QueryBuilder<'_, sqlx::Postgres>, p: &ParsedListParams) {
    // 文件夹层过滤：全局搜索开启时整段跳过，让搜索/浏览横跨该库（权限 scope）下的所有文件夹。
    if !p.global_search {
        if p.uncategorized == Some(true) {
            workflow_taxonomy::push_dept_uncategorized_filter(
                qb,
                workflow_taxonomy::SHARED_DEPARTMENT,
            );
        } else if let Some(dept) = &p.department {
            if let Some(cat) = &p.category {
                if cat == workflow_taxonomy::UNCATEGORIZED_CATEGORY {
                    workflow_taxonomy::push_dept_uncategorized_filter(qb, dept);
                } else {
                    qb.push(" AND w.department = ")
                        .push_bind(dept.clone())
                        .push(" AND w.category = ")
                        .push_bind(cat.clone());
                }
            } else {
                qb.push(" AND w.department = ").push_bind(dept.clone());
            }
        } else if let Some(cat) = &p.category {
            qb.push(" AND w.category = ").push_bind(cat.clone());
        }
    }

    if let Some(enabled) = p.is_enabled {
        qb.push(" AND w.is_enabled = ").push_bind(enabled);
    }

    if !p.trigger_types.is_empty() {
        qb.push(" AND w.trigger_type = ANY(")
            .push_bind(p.trigger_types.clone())
            .push(")");
    }

    if let Some(author) = &p.author {
        if author == "未知" {
            qb.push(" AND cu.username IS NULL");
        } else {
            qb.push(" AND cu.username = ").push_bind(author.clone());
        }
    }

    // 关键词搜索：按空格拆分为多个 term，每个 term 都需命中（AND），单个 term 内跨字段（OR）。
    // 支持 ID（纯数字精确匹配）/ 名称 / slug / 描述 / 部门 / 分类。
    if let Some(kw) = &p.search {
        for term in kw.split_whitespace() {
            let like = format!("%{}%", escape_like(term));
            qb.push(" AND (w.name ILIKE ")
                .push_bind(like.clone())
                .push(" OR w.slug ILIKE ")
                .push_bind(like.clone())
                .push(" OR w.description ILIKE ")
                .push_bind(like.clone())
                .push(" OR w.department ILIKE ")
                .push_bind(like.clone())
                .push(" OR w.category ILIKE ")
                .push_bind(like);
            if let Ok(id) = term.parse::<i32>() {
                qb.push(" OR w.id = ").push_bind(id);
            }
            qb.push(")");
        }
    }
}

fn push_list_sort(qb: &mut sqlx::QueryBuilder<'_, sqlx::Postgres>, p: &ParsedListParams) {
    // 搜索态：相关性优先（ID 精确 > 名称完全 > 名称前缀 > 名称包含 > slug 包含 > 其它），
    // 再按用户选择的排序作为次级；非搜索态维持原排序。
    if let Some(kw) = &p.search {
        let contains = format!("%{}%", escape_like(kw));
        let prefix = format!("{}%", escape_like(kw));
        qb.push(" ORDER BY (CASE");
        if let Ok(id) = kw.trim().parse::<i32>() {
            qb.push(" WHEN w.id = ").push_bind(id).push(" THEN 0");
        }
        qb.push(" WHEN lower(w.name) = lower(")
            .push_bind(kw.clone())
            .push(") THEN 1")
            .push(" WHEN w.name ILIKE ")
            .push_bind(prefix)
            .push(" THEN 2")
            .push(" WHEN w.name ILIKE ")
            .push_bind(contains.clone())
            .push(" THEN 3")
            .push(" WHEN w.slug ILIKE ")
            .push_bind(contains)
            .push(" THEN 4 ELSE 5 END),");
        match p.sort.as_str() {
            "updated_at" => qb.push(" w.updated_at DESC"),
            "name" => qb.push(" w.name ASC"),
            _ => qb.push(" w.created_at DESC"),
        };
    } else {
        match p.sort.as_str() {
            "updated_at" => qb.push(" ORDER BY w.updated_at DESC"),
            "created_at" => qb.push(" ORDER BY w.created_at DESC"),
            "name" => qb.push(" ORDER BY w.name ASC"),
            _ => qb.push(" ORDER BY w.created_at DESC"),
        };
    }
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct WorkflowGroupCount {
    department: Option<String>,
    category: Option<String>,
    count: i64,
}

/// GET /api/admin/workflows/summary — 侧边栏文件夹树计数（按 department/category 聚合）
pub async fn workflow_list_summary(
    State(pool): State<PgPool>,
    Query(params): Query<HashMap<String, String>>,
    axum::Extension(claims): axum::Extension<Claims>,
) -> Result<Json<Value>> {
    let p = parse_list_params(&params);
    let scope = resolve_list_scope(&pool, &claims, p.tenant_id, p.database_id).await?;
    if matches!(scope, ListScope::Empty) {
        return Ok(Json(json!({ "groups": [], "total": 0 })));
    }

    let mut qb: sqlx::QueryBuilder<sqlx::Postgres> = sqlx::QueryBuilder::new(
        "SELECT w.department, w.category, COUNT(*)::bigint AS count \
         FROM management.workflows w ",
    );
    push_list_scope(&mut qb, &scope);
    qb.push(
        " GROUP BY w.department, w.category \
              ORDER BY w.department NULLS LAST, w.category NULLS LAST",
    );

    let groups = qb
        .build_query_as::<WorkflowGroupCount>()
        .fetch_all(&pool)
        .await?;
    let total: i64 = groups.iter().map(|g| g.count).sum();

    Ok(Json(json!({ "groups": groups, "total": total })))
}

/// GET /api/admin/workflows
pub async fn list_workflows(
    State(pool): State<PgPool>,
    Query(params): Query<HashMap<String, String>>,
    axum::Extension(claims): axum::Extension<Claims>,
) -> Result<Json<Value>> {
    let p = parse_list_params(&params);
    let scope = resolve_list_scope(&pool, &claims, p.tenant_id, p.database_id).await?;
    if matches!(scope, ListScope::Empty) {
        return Ok(Json(json!({ "workflows": [], "total": 0 })));
    }

    let paginate = p.page.is_some() || p.page_size.is_some();

    let mut count_qb: sqlx::QueryBuilder<sqlx::Postgres> = sqlx::QueryBuilder::new(
        "SELECT COUNT(*)::bigint FROM management.workflows w \
         LEFT JOIN users cu ON cu.id = w.created_by ",
    );
    push_list_scope(&mut count_qb, &scope);
    push_list_filters(&mut count_qb, &p);
    let total: i64 = count_qb
        .build_query_scalar::<i64>()
        .fetch_one(&pool)
        .await?;

    let mut qb: sqlx::QueryBuilder<sqlx::Postgres> = sqlx::QueryBuilder::new(
        "SELECT w.*, cu.username AS created_by_name, cu.email AS created_by_email \
         FROM management.workflows w \
         LEFT JOIN users cu ON cu.id = w.created_by ",
    );
    push_list_scope(&mut qb, &scope);
    push_list_filters(&mut qb, &p);
    push_list_sort(&mut qb, &p);

    let (page, page_size) = if paginate {
        let page = p.page.unwrap_or(1).max(1);
        let page_size = p
            .page_size
            .unwrap_or(LIST_DEFAULT_PAGE_SIZE)
            .clamp(1, LIST_MAX_PAGE_SIZE);
        let offset = (page - 1) * page_size;
        qb.push(" LIMIT ").push_bind(page_size);
        qb.push(" OFFSET ").push_bind(offset);
        (page, page_size)
    } else {
        (1, total.max(0))
    };

    let workflows = qb.build_query_as::<Workflow>().fetch_all(&pool).await?;

    let mut out = json!({
        "workflows": workflows,
        "total": total,
    });
    if paginate {
        out["page"] = json!(page);
        out["page_size"] = json!(page_size);
    }

    if p.include_authors {
        let mut auth_qb: sqlx::QueryBuilder<sqlx::Postgres> = sqlx::QueryBuilder::new(
            "SELECT DISTINCT COALESCE(cu.username, '未知') AS author \
             FROM management.workflows w \
             LEFT JOIN users cu ON cu.id = w.created_by ",
        );
        push_list_scope(&mut auth_qb, &scope);
        push_list_filters(&mut auth_qb, &p);
        auth_qb.push(" ORDER BY author ASC");
        let authors: Vec<String> = auth_qb
            .build_query_scalar::<String>()
            .fetch_all(&pool)
            .await?;
        out["authors"] = json!(authors);
    }

    Ok(Json(out))
}

/// GET /api/admin/workflows/:id
pub async fn get_workflow(
    State(pool): State<PgPool>,
    Path(id): Path<i32>,
    axum::Extension(claims): axum::Extension<Claims>,
) -> Result<Json<Value>> {
    let workflow = fetch_workflow_for_admin(&pool, &claims, id).await?;

    Ok(Json(json!({
        "workflow": workflow,
        "deps_status": crate::js_deps::read_status(id),
        "py_deps_status": crate::py_deps::read_status(id),
    })))
}

/// POST /api/admin/workflows
/// 校验 trigger_config 里的 cron `schedule`（若存在且非空）。
/// 空 schedule 允许（草稿态，永不触发）；非法表达式直接 400，避免静默不触发。
fn validate_cron_in_trigger_config(cfg: Option<&Value>) -> Result<()> {
    let schedule = cfg
        .and_then(|c| c.get("schedule"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if schedule.is_empty() {
        return Ok(());
    }
    crate::workflow_cron_trigger::validate_cron(schedule)
        .map_err(|e| AppError::InvalidQuery(format!("cron 表达式非法：{}", e)))
}

fn spawn_javascript_deps_install(workflow: &Workflow) {
    let Some(js) = crate::js_deps::parse_javascript_deps(&workflow.dependencies) else {
        return;
    };
    let workflow_id = workflow.id;
    tokio::spawn(async move {
        match crate::js_deps::ensure_javascript_deps(workflow_id, &js).await {
            Ok(status) if status.status == crate::js_deps::DepsStatusKind::Failed => {
                tracing::warn!(
                    workflow_id,
                    error = ?status.error,
                    "工作流 JavaScript 依赖安装失败"
                );
            }
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(workflow_id, %error, "工作流 JavaScript 依赖安装失败");
            }
        }
    });
}

fn spawn_python_deps_install(workflow: &Workflow) {
    // Only pre-install when the feature is enabled; otherwise users who never
    // use Python would see a confusing red "failed" deps badge.
    if !crate::py_runner::py_enabled() {
        return;
    }
    let Some(py) = crate::py_deps::parse_python_deps(&workflow.dependencies) else {
        return;
    };
    let workflow_id = workflow.id;
    tokio::spawn(async move {
        match crate::py_deps::ensure_python_deps(workflow_id, &py).await {
            Ok(status) if status.status == crate::js_deps::DepsStatusKind::Failed => {
                tracing::warn!(
                    workflow_id,
                    error = ?status.error,
                    "工作流 Python 依赖安装失败"
                );
            }
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(workflow_id, %error, "工作流 Python 依赖安装失败");
            }
        }
    });
}

pub async fn create_workflow(
    State(pool): State<PgPool>,
    axum::Extension(claims): axum::Extension<Claims>,
    audit_sink: Option<axum::Extension<AuditDetailSink>>,
    op_source: Option<axum::Extension<OpSourceHint>>,
    Json(req): Json<CreateWorkflowRequest>,
) -> Result<(StatusCode, Json<Value>)> {
    if req.name.is_empty() {
        return Err(AppError::InvalidQuery("工作流名称不能为空".to_string()));
    }
    if req.slug.is_empty() {
        return Err(AppError::InvalidQuery("工作流 slug 不能为空".to_string()));
    }
    if !is_valid_slug(&req.slug) {
        return Err(AppError::InvalidQuery(
            "slug 只能包含小写字母、数字、连字符和斜杠（/）".to_string(),
        ));
    }

    let trigger_type = req.trigger_type.unwrap_or_else(|| "endpoint".to_string());
    if !["endpoint", "hook", "cron", "manual", "notify", "kafka"].contains(&trigger_type.as_str()) {
        return Err(AppError::InvalidQuery(
            "trigger_type 必须是 endpoint / hook / cron / manual / notify / kafka".to_string(),
        ));
    }

    // cron 触发：校验 schedule 表达式合法，避免非法 cron 静默永不触发。
    if trigger_type == "cron" {
        validate_cron_in_trigger_config(req.trigger_config.as_ref())?;
    }
    validate_alert_webhook_template(req.alert_webhook_template.as_ref())?;
    validate_alert_throttle_hours(req.alert_throttle_hours)?;
    let alert_webhook_url = normalize_alert_webhook_url(req.alert_webhook_url.as_deref())?;

    // 验证 DAG 结构
    let def = parse_definition(&req.nodes, &req.edges)?;
    workflow_engine::validate_definition(&def)?;

    let resolved_tenant_id =
        resolve_tenant_for_workflow_input(&pool, &claims, req.database_id, req.tenant_id).await?;

    let taxonomy = workflow_taxonomy::resolve_taxonomy_input(
        req.department.as_deref(),
        req.category.as_deref(),
    );

    let workflow = sqlx::query_as::<_, Workflow>(
        r#"INSERT INTO management.workflows
           (tenant_id, database_id, name, slug, description, category, department,
            trigger_type, trigger_config, nodes, edges, dependencies, is_enabled, timeout_ms, max_retries,
            alert_webhook_url, alert_webhook_template, alert_throttle_hours, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
           RETURNING *"#,
    )
    .bind(resolved_tenant_id)
    .bind(req.database_id)
    .bind(&req.name)
    .bind(&req.slug)
    .bind(&req.description)
    .bind(&taxonomy.category)
    .bind(&taxonomy.department)
    .bind(&trigger_type)
    .bind(req.trigger_config.unwrap_or(json!({})))
    .bind(&req.nodes)
    .bind(&req.edges)
    .bind(req.dependencies.unwrap_or_else(|| json!({})))
    .bind(req.is_enabled.unwrap_or(true))
    .bind(req.timeout_ms.unwrap_or(120_000))
    .bind(req.max_retries.unwrap_or(0))
    .bind(alert_webhook_url)
    .bind(req.alert_webhook_template)
    .bind(req.alert_throttle_hours.unwrap_or(24))
    .bind(claims.sub)
    .fetch_one(&pool)
    .await
    .map_err(map_workflow_write_err)?;

    tracing::info!(workflow_id = workflow.id, slug = %workflow.slug, "工作流已创建");
    spawn_javascript_deps_install(&workflow);
    spawn_python_deps_install(&workflow);

    // 初始版本快照（v1）。失败不阻断创建，仅记日志。
    let note = req.version_note.as_deref().or(Some("初始版本"));
    if let Err(e) = snapshot_workflow_version(&pool, &workflow, note, Some(claims.sub)).await {
        tracing::warn!(workflow_id = workflow.id, error = %e, "创建工作流的初始版本快照失败");
    }

    audit_workflow(
        &audit_sink,
        "workflow.create",
        workflow.id,
        &workflow.name,
        &workflow.slug,
        json!({ "database_id": workflow.database_id }),
    );

    let source = op_source_of(&op_source);
    let summary = match source {
        Source::Mcp => format!("通过 MCP 创建工作流「{}」", workflow.name),
        _ => format!("创建工作流「{}」", workflow.name),
    };
    record_workflow_op(
        &pool,
        &claims,
        source,
        operation_log::action::CREATE,
        &workflow,
        summary,
        Some(workflow_snapshot_fields(&workflow, "created")),
    );

    Ok((StatusCode::CREATED, Json(json!({ "workflow": workflow }))))
}

/// PATCH /api/admin/workflows/:id
pub async fn update_workflow(
    State(pool): State<PgPool>,
    Path(id): Path<i32>,
    axum::Extension(claims): axum::Extension<Claims>,
    audit_sink: Option<axum::Extension<AuditDetailSink>>,
    op_source: Option<axum::Extension<OpSourceHint>>,
    Json(mut req): Json<UpdateWorkflowRequest>,
) -> Result<Json<Value>> {
    let existing = fetch_workflow_for_admin(&pool, &claims, id).await?;
    if let Some(ref slug) = req.slug {
        if !is_valid_slug(slug) {
            return Err(AppError::InvalidQuery(
                "slug 只能包含小写字母、数字、连字符和斜杠（/）".to_string(),
            ));
        }
    }
    if let Some(ref trigger_type) = req.trigger_type {
        if !["endpoint", "hook", "cron", "manual", "notify", "kafka"]
            .contains(&trigger_type.as_str())
        {
            return Err(AppError::InvalidQuery(
                "trigger_type 必须是 endpoint / hook / cron / manual / notify / kafka".to_string(),
            ));
        }
    }

    // cron 触发：若本次会让工作流处于 cron 类型且带了 trigger_config，校验其 schedule。
    let effective_trigger_type = req
        .trigger_type
        .clone()
        .unwrap_or_else(|| existing.trigger_type.clone());
    if effective_trigger_type == "cron" && req.trigger_config.is_some() {
        validate_cron_in_trigger_config(req.trigger_config.as_ref())?;
    }

    // 增量节点补丁：按 id upsert / 删除，产出合并后的完整 nodes，
    // 交给下游统一走 DAG 校验 + COALESCE 落库 + 版本快照（与全量路径共用）。
    let has_patch = req.node_patch.is_some()
        || req
            .remove_node_ids
            .as_ref()
            .map(|v| !v.is_empty())
            .unwrap_or(false);
    if has_patch {
        if req.nodes.is_some() {
            return Err(AppError::InvalidQuery(
                "node_patch/remove_node_ids 不能与全量 nodes 同时使用".to_string(),
            ));
        }
        let merged = merge_node_patch(
            &existing.nodes,
            req.node_patch.as_ref(),
            req.remove_node_ids.as_deref().unwrap_or(&[]),
        )?;
        req.nodes = Some(merged);
    }

    // 校验 DAG：nodes 或 edges 任一变更，都用「最终生效」的 nodes+edges 组合整体校验。
    // patch 只改 nodes、edges 沿用旧值也要跑——兜住「删了节点但旧边还引用它」这类断链。
    if req.nodes.is_some() || req.edges.is_some() {
        let eff_nodes = req.nodes.as_ref().unwrap_or(&existing.nodes);
        let eff_edges = req.edges.as_ref().unwrap_or(&existing.edges);
        let def = parse_definition(eff_nodes, eff_edges)?;
        workflow_engine::validate_definition(&def)?;
    }

    let tenant_id_update = if let Some(database_id) = req.database_id {
        resolve_tenant_for_workflow_input(&pool, &claims, Some(database_id), None).await?
    } else {
        None
    };

    let existing_taxonomy = WorkflowTaxonomy {
        department: existing.department.clone(),
        category: existing.category.clone(),
    };
    let taxonomy_provided = req.category.is_some() || req.department.is_some();
    let taxonomy = if taxonomy_provided {
        let dept_field = if req.department.is_some() {
            Some(req.department.as_deref())
        } else {
            None
        };
        let cat_field = if req.category.is_some() {
            Some(req.category.as_deref())
        } else {
            None
        };
        workflow_taxonomy::resolve_taxonomy_update(&existing_taxonomy, dept_field, cat_field)
    } else {
        existing_taxonomy
    };
    let alert_webhook_url = match req.alert_webhook_url.as_ref() {
        Some(Some(url)) => normalize_alert_webhook_url(Some(url))?,
        Some(None) => None,
        None => existing.alert_webhook_url.clone(),
    };
    let alert_webhook_template = match req.alert_webhook_template.clone() {
        Some(template) => template,
        None => existing.alert_webhook_template.clone(),
    };
    validate_alert_webhook_template(alert_webhook_template.as_ref())?;
    let alert_throttle_hours = req
        .alert_throttle_hours
        .unwrap_or(existing.alert_throttle_hours);
    validate_alert_throttle_hours(Some(alert_throttle_hours))?;

    let workflow = sqlx::query_as::<_, Workflow>(
        r#"UPDATE management.workflows SET
            name = COALESCE($2, name),
            slug = COALESCE($3, slug),
            description = COALESCE($4, description),
            database_id = COALESCE($5, database_id),
            trigger_type = COALESCE($6, trigger_type),
            trigger_config = COALESCE($7, trigger_config),
            nodes = COALESCE($8, nodes),
            edges = COALESCE($9, edges),
            dependencies = COALESCE($10, dependencies),
            is_enabled = COALESCE($11, is_enabled),
            timeout_ms = COALESCE($12, timeout_ms),
            max_retries = COALESCE($13, max_retries),
            tenant_id = COALESCE($14, tenant_id),
            category = CASE WHEN $15 THEN $16 ELSE category END,
            department = CASE WHEN $15 THEN $17 ELSE department END,
            alert_webhook_url = $18,
            alert_webhook_template = $19,
            alert_throttle_hours = $20
           WHERE id = $1
           RETURNING *"#,
    )
    .bind(id)
    .bind(&req.name)
    .bind(&req.slug)
    .bind(&req.description)
    .bind(req.database_id)
    .bind(&req.trigger_type)
    .bind(&req.trigger_config)
    .bind(&req.nodes)
    .bind(&req.edges)
    .bind(&req.dependencies)
    .bind(req.is_enabled)
    .bind(req.timeout_ms)
    .bind(req.max_retries)
    .bind(tenant_id_update)
    .bind(taxonomy_provided)
    .bind(&taxonomy.category)
    .bind(&taxonomy.department)
    .bind(alert_webhook_url)
    .bind(alert_webhook_template)
    .bind(alert_throttle_hours)
    .fetch_optional(&pool)
    .await
    .map_err(map_workflow_write_err)?
    .ok_or_else(|| AppError::NotFound(format!("工作流 {} 不存在", id)))?;

    tracing::info!(workflow_id = workflow.id, "工作流已更新");
    if req.dependencies.is_some() {
        spawn_javascript_deps_install(&workflow);
        spawn_python_deps_install(&workflow);
    }

    // 仅在本次保存改动了定义（编辑器保存会带 nodes+edges）时打版本快照，
    // 避免列表里的启用/禁用、改名等局部更新也刷出一堆版本。
    if req.nodes.is_some() || req.edges.is_some() || req.dependencies.is_some() {
        if let Err(e) = snapshot_workflow_version(
            &pool,
            &workflow,
            req.version_note.as_deref(),
            Some(claims.sub),
        )
        .await
        {
            tracing::warn!(workflow_id = workflow.id, error = %e, "更新工作流的版本快照失败");
        }
    }

    audit_workflow(
        &audit_sink,
        "workflow.update",
        workflow.id,
        &workflow.name,
        &workflow.slug,
        json!({
            "definition_changed": req.nodes.is_some() || req.edges.is_some() || req.dependencies.is_some(),
        }),
    );

    // 变更事实：定义（nodes/edges）改动走节点级 diff；否则走配置级 diff（启用状态/名称/超时/重试/描述）。
    // 这样 enable/disable、改名等列表页局部更新也有可读的变更内容，不再是空详情。
    let def_changed = req.nodes.is_some() || req.edges.is_some();
    let change = if def_changed {
        workflow_change_diff(&existing, &workflow)
    } else {
        workflow_config_diff(&existing, &workflow)
    };
    let source = op_source_of(&op_source);
    // 摘要：定义改动=「修改」；纯启用/停用切换=「启用/停用」；其余配置改动=「更新配置」。
    let summary = if def_changed {
        format!("修改工作流「{}」", workflow.name)
    } else if existing.is_enabled != workflow.is_enabled {
        format!(
            "{}工作流「{}」",
            if workflow.is_enabled { "启用" } else { "停用" },
            workflow.name
        )
    } else {
        format!("更新工作流「{}」配置", workflow.name)
    };
    record_workflow_op(
        &pool,
        &claims,
        source,
        operation_log::action::UPDATE,
        &workflow,
        summary,
        change,
    );

    Ok(Json(json!({ "workflow": workflow })))
}

/// DELETE /api/admin/workflows/:id
pub async fn delete_workflow(
    State(pool): State<PgPool>,
    Path(id): Path<i32>,
    axum::Extension(claims): axum::Extension<Claims>,
    audit_sink: Option<axum::Extension<AuditDetailSink>>,
) -> Result<Json<Value>> {
    let workflow = fetch_workflow_for_admin(&pool, &claims, id).await?;
    let result = sqlx::query("DELETE FROM management.workflows WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("工作流 {} 不存在", id)));
    }

    audit_workflow(
        &audit_sink,
        "workflow.delete",
        id,
        &workflow.name,
        &workflow.slug,
        json!({}),
    );

    // 工作流删除 = 高危（derive_high_risk 自动打标）。
    record_workflow_op(
        &pool,
        &claims,
        Source::Console,
        operation_log::action::DELETE,
        &workflow,
        format!("删除工作流「{}」", workflow.name),
        Some(workflow_snapshot_fields(&workflow, "deleted")),
    );

    tracing::info!(workflow_id = id, "工作流已删除");
    Ok(Json(json!({ "message": "工作流已删除", "id": id })))
}

/// 单次批量操作允许的最大工作流数量，避免一次请求拖垮库或权限校验。
const BATCH_MAX_IDS: usize = 500;

#[derive(Debug, Deserialize)]
pub struct BatchWorkflowRequest {
    /// "enable" / "disable" / "delete"
    pub action: String,
    pub ids: Vec<i32>,
}

/// POST /api/admin/workflows/batch — 批量启用 / 禁用 / 删除。
///
/// best-effort：逐条做管理员权限校验，能成功的成功，无权限 / 不存在的记进 `failed`，
/// 一次请求返回成功与失败明细，前端无需再循环调用单条接口。
pub async fn batch_workflows(
    State(pool): State<PgPool>,
    axum::Extension(claims): axum::Extension<Claims>,
    Json(req): Json<BatchWorkflowRequest>,
) -> Result<Json<Value>> {
    let action = req.action.as_str();
    if !matches!(action, "enable" | "disable" | "delete") {
        return Err(AppError::InvalidQuery(
            "action 必须是 enable / disable / delete".to_string(),
        ));
    }
    if req.ids.is_empty() {
        return Err(AppError::InvalidQuery("ids 不能为空".to_string()));
    }

    // 去重并保持原始顺序
    let mut seen = std::collections::HashSet::new();
    let ids: Vec<i32> = req
        .ids
        .iter()
        .copied()
        .filter(|id| seen.insert(*id))
        .collect();

    if ids.len() > BATCH_MAX_IDS {
        return Err(AppError::InvalidQuery(format!(
            "单次批量操作不能超过 {} 个工作流",
            BATCH_MAX_IDS
        )));
    }

    // 一次查出全部目标，逐条校验管理员权限
    let workflows =
        sqlx::query_as::<_, Workflow>("SELECT * FROM management.workflows WHERE id = ANY($1)")
            .bind(&ids)
            .fetch_all(&pool)
            .await?;
    let found: HashMap<i32, Workflow> = workflows.into_iter().map(|w| (w.id, w)).collect();

    let mut allowed: Vec<i32> = Vec::new();
    let mut failed: Vec<Value> = Vec::new();
    for id in &ids {
        match found.get(id) {
            None => failed.push(json!({ "id": id, "error": "工作流不存在" })),
            Some(wf) => match require_admin_for_workflow(&pool, &claims, wf).await {
                Ok(()) => allowed.push(*id),
                Err(e) => failed.push(json!({ "id": id, "error": e.to_string() })),
            },
        }
    }

    // 对有权限的批量执行；单条单条 toggle 不写 updated_at，这里保持一致语义。
    let mut succeeded: Vec<i32> = Vec::new();
    if !allowed.is_empty() {
        succeeded = match action {
            "enable" | "disable" => sqlx::query_scalar::<_, i32>(
                "UPDATE management.workflows SET is_enabled = $1 WHERE id = ANY($2) RETURNING id",
            )
            .bind(action == "enable")
            .bind(&allowed)
            .fetch_all(&pool)
            .await
            .map_err(map_workflow_write_err)?,
            "delete" => sqlx::query_scalar::<_, i32>(
                "DELETE FROM management.workflows WHERE id = ANY($1) RETURNING id",
            )
            .bind(&allowed)
            .fetch_all(&pool)
            .await
            .map_err(map_workflow_write_err)?,
            _ => unreachable!(),
        };
    }

    // 操作日志打点：批量操作逐条记录（enable/disable=UPDATE，delete=DELETE 由规则标高危）。
    for id in &succeeded {
        if let Some(wf) = found.get(id) {
            let (act, verb) = match action {
                "enable" => (operation_log::action::UPDATE, "启用"),
                "disable" => (operation_log::action::UPDATE, "禁用"),
                "delete" => (operation_log::action::DELETE, "删除"),
                _ => unreachable!(),
            };
            // 变更内容：删除记快照；启用/停用**仅在状态确有翻转时**记切换
            // （wf 为更新前状态）。对"已是目标态"的批量操作不产生误导性的 X→X。
            let change = match action {
                "delete" => Some(workflow_snapshot_fields(wf, "deleted")),
                "enable" | "disable" => {
                    let want = action == "enable";
                    if wf.is_enabled == want {
                        None
                    } else {
                        Some(json!({
                            "v": 1, "kind": "modified",
                            "modified": [ {
                                "node": wf.name,
                                "fields": [ {
                                    "field": "启用状态",
                                    "old": if wf.is_enabled { "启用" } else { "停用" },
                                    "new": if want { "启用" } else { "停用" },
                                } ]
                            } ]
                        }))
                    }
                }
                _ => None,
            };
            record_workflow_op(
                &pool,
                &claims,
                Source::Console,
                act,
                wf,
                format!("{}工作流「{}」（批量）", verb, wf.name),
                change,
            );
        }
    }

    tracing::info!(
        action = action,
        succeeded = succeeded.len(),
        failed = failed.len(),
        "工作流批量操作完成"
    );

    Ok(Json(json!({
        "action": action,
        "total": ids.len(),
        "succeeded": succeeded,
        "succeeded_count": succeeded.len(),
        "failed": failed,
        "failed_count": failed.len(),
    })))
}

/// 单次批量导入允许的最大文件数。
const IMPORT_MAX_ITEMS: usize = 200;

#[derive(Debug, Deserialize)]
pub struct ImportWorkflowDef {
    pub name: String,
    pub description: Option<String>,
    pub department: Option<String>,
    pub category: Option<String>,
    pub trigger_type: Option<String>,
    pub trigger_config: Option<Value>,
    pub nodes: Value,
    pub edges: Value,
    pub dependencies: Option<Value>,
    pub timeout_ms: Option<i32>,
    pub max_retries: Option<i32>,
    pub alert_webhook_url: Option<String>,
    pub alert_webhook_template: Option<Value>,
    pub alert_throttle_hours: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct ImportWorkflowItem {
    /// "create" | "overwrite" | "rename"
    pub action: String,
    /// 最终落库 slug：rename 为新 slug；create/overwrite 为原 slug。
    pub slug: String,
    pub workflow: ImportWorkflowDef,
}

#[derive(Debug, Deserialize)]
pub struct ImportWorkflowsRequest {
    pub database_id: Option<i32>,
    pub items: Vec<ImportWorkflowItem>,
}

/// POST /api/admin/workflows/import — 批量导入工作流。
///
/// 设计：先在前端预检（解析 / 冲突 / 选择处理方式），此处按每条 item 的 action 落库。
/// - create / rename：新建，默认 `is_enabled=true`（与前端手工新建一致；如需禁用可
///   在列表页操作）。注意：MCP 通道创建仍强制禁用，见 `mcp_tools.rs`。
/// - overwrite：按 (database_id, slug) 覆盖既有定义，**保留原 is_enabled 与 id**，并
///   **保留目标环境的连接类配置**（节点里的数据源 `datasource_id`/`datasource_ref`、
///   Redis `connection_id`），避免用导入文件（测试环境）的连接改掉线上连接；文件里
///   新增的节点则连接字段留空，交给用户手动选择（见 `merge_connection_for_overwrite`）。
/// best-effort：单条失败不影响其余，返回逐条结果。
pub async fn import_workflows(
    State(pool): State<PgPool>,
    axum::Extension(claims): axum::Extension<Claims>,
    Json(req): Json<ImportWorkflowsRequest>,
) -> Result<Json<Value>> {
    if req.items.is_empty() {
        return Err(AppError::InvalidQuery("items 不能为空".to_string()));
    }
    if req.items.len() > IMPORT_MAX_ITEMS {
        return Err(AppError::InvalidQuery(format!(
            "单次批量导入不能超过 {} 个文件",
            IMPORT_MAX_ITEMS
        )));
    }

    // 统一目标库；权限只校验一次（导入全部落到当前工作区库）。
    let tenant_id =
        resolve_tenant_for_workflow_input(&pool, &claims, req.database_id, None).await?;

    let mut succeeded: Vec<Value> = Vec::new();
    let mut failed: Vec<Value> = Vec::new();

    for item in &req.items {
        let label = if item.workflow.name.trim().is_empty() {
            item.slug.clone()
        } else {
            item.workflow.name.clone()
        };
        match import_one_workflow(&pool, &claims, req.database_id, tenant_id, item).await {
            Ok(v) => succeeded.push(v),
            Err(e) => failed.push(json!({
                "slug": item.slug,
                "name": label,
                "error": e.to_string(),
            })),
        }
    }

    tracing::info!(
        succeeded = succeeded.len(),
        failed = failed.len(),
        "工作流批量导入完成"
    );

    // 操作日志打点：批量导入记一条聚合记录（来源=控制台，操作者=真实用户）。
    // tenant_id 为 Option（平台共享导入可能无租户）——无租户则跳过打点。
    if let (false, Some(tid)) = (succeeded.is_empty(), tenant_id) {
        // 导入项明细：供详情「导入内容」逐条展示（名称 / slug / 动作 create|overwrite|rename）。
        let items: Vec<Value> = succeeded
            .iter()
            .map(|v| {
                json!({
                    "name": v.get("name").and_then(|x| x.as_str()).unwrap_or(""),
                    "slug": v.get("slug").and_then(|x| x.as_str()).unwrap_or(""),
                    "action": v.get("action").and_then(|x| x.as_str()).unwrap_or("create"),
                })
            })
            .collect();
        // 列表「资源对象」：单个→工作流名；多个→「首个 等 N 个」。
        let first_name = succeeded
            .first()
            .and_then(|v| {
                v.get("name")
                    .and_then(|x| x.as_str())
                    .filter(|s| !s.is_empty())
                    .or_else(|| v.get("slug").and_then(|x| x.as_str()))
            })
            .unwrap_or("工作流")
            .to_string();
        let resource_name = if succeeded.len() == 1 {
            first_name
        } else {
            format!("{} 等 {} 个", first_name, succeeded.len())
        };
        operation_log::record(
            &pool,
            OperationLogInput::new(
                tid,
                Actor::User {
                    id: claims.sub,
                    name: claims.email.clone(),
                    role: None,
                },
                Source::Console,
                operation_log::action::IMPORT,
                format!(
                    "批量导入工作流（成功 {} / 失败 {}，共 {}）",
                    succeeded.len(),
                    failed.len(),
                    req.items.len()
                ),
                Status::Success,
            )
            .resource(operation_log::resource_type::WORKFLOW, resource_name, None)
            .change(json!({ "v": 1, "kind": "imported", "items": items }))
            .detail(json!({
                "succeeded": succeeded.len(),
                "failed": failed.len(),
                "total": req.items.len(),
            })),
        );
    }

    Ok(Json(json!({
        "total": req.items.len(),
        "succeeded": succeeded,
        "succeeded_count": succeeded.len(),
        "failed": failed,
        "failed_count": failed.len(),
    })))
}

#[derive(Debug, Deserialize)]
pub struct ExportAuditRequest {
    /// 本次导出的工作流 id 列表（单个导出传 1 个）。
    pub ids: Vec<i32>,
}

/// POST /api/admin/workflows/export-audit
///
/// 工作流导出在前端本地生成 JSON 下载（无后端调用），故导出无法自动落审计。
/// 前端在触发下载后调用本端点回执，由后端按 id 校验可管理权限并逐个记 EXPORT 打点
/// （来源=控制台，操作者=真实用户）。纯审计用途，不返回工作流内容。
pub async fn export_workflows_audit(
    State(pool): State<PgPool>,
    axum::Extension(claims): axum::Extension<Claims>,
    Json(req): Json<ExportAuditRequest>,
) -> Result<Json<Value>> {
    let mut recorded = 0usize;
    for id in req.ids.into_iter().take(500) {
        // 复用管理员校验；无权限/不存在的静默跳过（导出回执不应报错打断）。
        if let Ok(wf) = fetch_workflow_for_admin(&pool, &claims, id).await {
            record_workflow_op(
                &pool,
                &claims,
                Source::Console,
                operation_log::action::EXPORT,
                &wf,
                format!("导出工作流「{}」", wf.name),
                None,
            );
            recorded += 1;
        }
    }
    Ok(Json(json!({ "recorded": recorded })))
}

/// 覆盖导入时保留目标环境的「连接类配置」（数据源引用、Redis 连接）。
///
/// 背景：节点里的数据源引用（`datasource_id` / `datasource_ref`）与 Redis 连接
/// （`connection_id`）指向的是**集成配置**，测试与线上环境并不一致。覆盖既有工作流时若
/// 照搬导入文件里的这些字段，会把线上连接改成测试环境的连接（连错库 / 连错 Redis）。
/// 因此覆盖时的策略：
///  - 能按节点 `id` 在既有工作流里匹配到的节点：连接字段**沿用目标库现值**，忽略文件里的；
///  - 文件里新增、既有工作流没有的节点：连接字段**一律留空**（置 null），不做任何自动映射，
///    交给用户在编辑器里手动选择数据源 / Redis 连接（同时返回一条告警提示）。
///
/// 返回 (处理后的 nodes, 告警列表)。
fn merge_connection_for_overwrite(
    imported_nodes: &Value,
    existing_nodes: &Value,
) -> (Value, Vec<String>) {
    // 视为「与环境/集成绑定」的连接字段：覆盖时统一保留目标库现值，新增节点则留空。
    const CONN_KEYS: [&str; 3] = ["datasource_id", "datasource_ref", "connection_id"];

    // 先给既有节点建立 id -> 连接字段快照。
    let mut existing_conn: std::collections::HashMap<String, serde_json::Map<String, Value>> =
        std::collections::HashMap::new();
    if let Some(arr) = existing_nodes.as_array() {
        for node in arr {
            let Some(id) = node.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            if let Some(cfg) = node.get("config").and_then(|c| c.as_object()) {
                let mut snap = serde_json::Map::new();
                for k in CONN_KEYS {
                    if let Some(v) = cfg.get(k) {
                        snap.insert(k.to_string(), v.clone());
                    }
                }
                if !snap.is_empty() {
                    existing_conn.insert(id.to_string(), snap);
                }
            }
        }
    }

    let Some(arr) = imported_nodes.as_array() else {
        return (imported_nodes.clone(), Vec::new());
    };

    let mut warnings: Vec<String> = Vec::new();
    let mut out = Vec::with_capacity(arr.len());
    for node in arr {
        let node_id = node
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("?")
            .to_string();
        match existing_conn.get(&node_id) {
            // 既有节点：连接字段沿用目标库现值（不采用文件里的）。
            Some(snap) => {
                let mut node = node.clone();
                if let Some(cfg) = node.get_mut("config").and_then(|c| c.as_object_mut()) {
                    for k in CONN_KEYS {
                        if let Some(v) = snap.get(k) {
                            cfg.insert(k.to_string(), v.clone());
                        }
                    }
                }
                out.push(node);
            }
            // 文件新增的节点：连接字段一律留空，不自动映射，交给用户手动选择。
            None => {
                let mut node = node.clone();
                let mut cleared = false;
                if let Some(cfg) = node.get_mut("config").and_then(|c| c.as_object_mut()) {
                    for k in CONN_KEYS {
                        if cfg.contains_key(k) {
                            cfg.insert(k.to_string(), Value::Null);
                            cleared = true;
                        }
                    }
                }
                if cleared {
                    warnings.push(format!(
                        "节点「{}」是本次覆盖新增的节点，数据源 / Redis 连接已留空，请在编辑器中手动选择",
                        node_id
                    ));
                }
                out.push(node);
            }
        }
    }
    (Value::Array(out), warnings)
}

/// 导入时按「名称」重映射节点里的数据源引用（跨环境/跨项目安全）。
///
/// 背景：节点 config 里的 `datasource_id` 是本项目内的整数引用，跨环境导入时该 id
/// 在目标项目要么不存在、要么指向另一条数据源 —— 直接沿用会“连错库”。因此：
///  - 若节点带 `datasource_ref`（数据源名称，导出时随节点携带）：在**目标项目**按名称
///    查真实 id 并回填；查不到则置空（回退默认库）并记一条告警，绝不保留悬空 id。
///  - 若只有 `datasource_id`（旧导出无名称）：校验该 id 是否归属目标项目，不归属则置空。
///
/// 返回 (重映射后的 nodes, 告警列表)。
async fn remap_datasource_refs(
    pool: &PgPool,
    tenant_id: Option<i32>,
    nodes: &Value,
) -> (Value, Vec<String>) {
    let mut warnings: Vec<String> = Vec::new();
    let Some(arr) = nodes.as_array() else {
        return (nodes.clone(), warnings);
    };

    let mut out = Vec::with_capacity(arr.len());
    for node in arr {
        let mut node = node.clone();
        let node_id = node
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("?")
            .to_string();

        if let Some(cfg) = node.get_mut("config").and_then(|c| c.as_object_mut()) {
            let ds_ref = cfg
                .get("datasource_ref")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let has_id = cfg
                .get("datasource_id")
                .map(|v| !v.is_null())
                .unwrap_or(false);

            if let Some(name) = ds_ref {
                // 有名称：在目标项目按名解析
                let resolved = match tenant_id {
                    Some(tid) => sqlx::query_scalar::<_, i32>(
                        "SELECT id FROM management.wf_datasources \
                         WHERE tenant_id = $1 AND name = $2 AND is_active = true",
                    )
                    .bind(tid)
                    .bind(&name)
                    .fetch_optional(pool)
                    .await
                    .ok()
                    .flatten(),
                    None => None,
                };
                match resolved {
                    Some(id) => {
                        cfg.insert("datasource_id".to_string(), json!(id));
                    }
                    None => {
                        cfg.insert("datasource_id".to_string(), Value::Null);
                        warnings.push(format!(
                            "节点「{}」引用的数据源「{}」在目标项目不存在，已回退为默认（工作流绑定库）",
                            node_id, name
                        ));
                    }
                }
            } else if has_id {
                // 无名称的旧导出：按 id 校验归属，不属于目标项目则置空，防连错库
                let id = cfg
                    .get("datasource_id")
                    .and_then(|v| v.as_i64())
                    .map(|x| x as i32);
                let belongs = match (tenant_id, id) {
                    (Some(tid), Some(id)) => sqlx::query_scalar::<_, bool>(
                        "SELECT EXISTS(SELECT 1 FROM management.wf_datasources \
                         WHERE id = $1 AND tenant_id = $2 AND is_active = true)",
                    )
                    .bind(id)
                    .bind(tid)
                    .fetch_one(pool)
                    .await
                    .unwrap_or(false),
                    _ => false,
                };
                if !belongs {
                    cfg.insert("datasource_id".to_string(), Value::Null);
                    warnings.push(format!(
                        "节点「{}」引用的数据源 id={} 在目标项目不可用，已回退为默认（工作流绑定库）",
                        node_id,
                        id.map(|v| v.to_string()).unwrap_or_else(|| "?".into())
                    ));
                }
            }
        }
        out.push(node);
    }
    (Value::Array(out), warnings)
}

async fn import_one_workflow(
    pool: &PgPool,
    claims: &Claims,
    database_id: Option<i32>,
    tenant_id: Option<i32>,
    item: &ImportWorkflowItem,
) -> Result<Value> {
    let wf = &item.workflow;
    if wf.name.trim().is_empty() {
        return Err(AppError::InvalidQuery("工作流名称不能为空".to_string()));
    }
    if !is_valid_slug(&item.slug) {
        return Err(AppError::InvalidQuery(
            "slug 只能包含小写字母、数字、连字符和斜杠（/）".to_string(),
        ));
    }
    let trigger_type = wf
        .trigger_type
        .clone()
        .unwrap_or_else(|| "endpoint".to_string());
    if !["endpoint", "hook", "cron", "manual", "notify", "kafka"].contains(&trigger_type.as_str()) {
        return Err(AppError::InvalidQuery(
            "trigger_type 必须是 endpoint / hook / cron / manual / notify / kafka".to_string(),
        ));
    }

    // 覆盖时预取既有工作流：用于（1）改动前的权限校验（避免“先改后拒”）；
    // （2）保留目标环境的连接类配置（数据源 / Redis 连接）。
    let existing_for_overwrite = if item.action.as_str() == "overwrite" {
        let ex = sqlx::query_as::<_, Workflow>(
            "SELECT * FROM management.workflows \
             WHERE database_id IS NOT DISTINCT FROM $1 AND slug = $2",
        )
        .bind(database_id)
        .bind(&item.slug)
        .fetch_optional(pool)
        .await
        .map_err(map_workflow_write_err)?
        .ok_or_else(|| AppError::NotFound(format!("待覆盖的工作流 slug='{}' 不存在", item.slug)))?;
        require_admin_for_workflow(pool, claims, &ex).await?;
        Some(ex)
    } else {
        None
    };

    // 计算最终落库 nodes：
    // - create / rename：按名重映射数据源引用（跨环境导入安全）。
    // - overwrite：数据源 / Redis 连接等「连接类配置」保留目标库现值（测试/线上集成不同），
    //   文件里新增的节点则连接字段留空，交给用户手动选择。
    let (remapped_nodes, ds_warnings) = match existing_for_overwrite.as_ref() {
        Some(existing) => merge_connection_for_overwrite(&wf.nodes, &existing.nodes),
        None => remap_datasource_refs(pool, tenant_id, &wf.nodes).await,
    };

    // 验证 DAG 结构（基于处理后的 nodes）
    let def = parse_definition(&remapped_nodes, &wf.edges)?;
    workflow_engine::validate_definition(&def)?;

    let taxonomy =
        workflow_taxonomy::resolve_taxonomy_input(wf.department.as_deref(), wf.category.as_deref());
    let trigger_config = wf.trigger_config.clone().unwrap_or_else(|| json!({}));
    let timeout_ms = wf.timeout_ms.unwrap_or(30_000);
    let max_retries = wf.max_retries.unwrap_or(0);
    validate_alert_webhook_template(wf.alert_webhook_template.as_ref())?;
    validate_alert_throttle_hours(wf.alert_throttle_hours)?;
    let alert_webhook_url = normalize_alert_webhook_url(wf.alert_webhook_url.as_deref())?;
    let alert_throttle_hours = wf.alert_throttle_hours.unwrap_or(24);
    let dependencies = wf.dependencies.clone().unwrap_or_else(|| json!({}));

    match item.action.as_str() {
        "overwrite" => {
            // 按 (database_id, slug) 覆盖既有定义，保留 id 与 is_enabled。
            let workflow = sqlx::query_as::<_, Workflow>(
                r#"UPDATE management.workflows SET
                    name = $3, description = $4, category = $5, department = $6,
                    trigger_type = $7, trigger_config = $8, nodes = $9, edges = $10,
                    dependencies = $11, timeout_ms = $12, max_retries = $13,
                    alert_webhook_url = $14, alert_webhook_template = $15, alert_throttle_hours = $16
                   WHERE database_id IS NOT DISTINCT FROM $1 AND slug = $2
                   RETURNING *"#,
            )
            .bind(database_id)
            .bind(&item.slug)
            .bind(&wf.name)
            .bind(&wf.description)
            .bind(&taxonomy.category)
            .bind(&taxonomy.department)
            .bind(&trigger_type)
            .bind(&trigger_config)
            .bind(&remapped_nodes)
            .bind(&wf.edges)
            .bind(&dependencies)
            .bind(timeout_ms)
            .bind(max_retries)
            .bind(&alert_webhook_url)
            .bind(&wf.alert_webhook_template)
            .bind(alert_throttle_hours)
            .fetch_optional(pool)
            .await
            .map_err(map_workflow_write_err)?
            .ok_or_else(|| {
                AppError::NotFound(format!("待覆盖的工作流 slug='{}' 不存在", item.slug))
            })?;
            // 权限已在改动前基于既有工作流校验（见 existing_for_overwrite）。

            if let Err(e) =
                snapshot_workflow_version(pool, &workflow, Some("批量导入覆盖"), Some(claims.sub))
                    .await
            {
                tracing::warn!(workflow_id = workflow.id, error = %e, "导入覆盖的版本快照失败");
            }
            Ok(json!({
                "action": "overwrite",
                "id": workflow.id,
                "slug": workflow.slug,
                "name": workflow.name,
                "warnings": ds_warnings,
            }))
        }
        "create" | "rename" => {
            // 默认启用：与前端手工新建行为一致；MCP 通道另行强制禁用（见 mcp_tools.rs）。
            let workflow = sqlx::query_as::<_, Workflow>(
                r#"INSERT INTO management.workflows
                   (tenant_id, database_id, name, slug, description, category, department,
                    trigger_type, trigger_config, nodes, edges, dependencies, is_enabled, timeout_ms, max_retries,
                    alert_webhook_url, alert_webhook_template, alert_throttle_hours, created_by)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, $13, $14, $15, $16, $17, $18)
                   RETURNING *"#,
            )
            .bind(tenant_id)
            .bind(database_id)
            .bind(&wf.name)
            .bind(&item.slug)
            .bind(&wf.description)
            .bind(&taxonomy.category)
            .bind(&taxonomy.department)
            .bind(&trigger_type)
            .bind(&trigger_config)
            .bind(&remapped_nodes)
            .bind(&wf.edges)
            .bind(&dependencies)
            .bind(timeout_ms)
            .bind(max_retries)
            .bind(&alert_webhook_url)
            .bind(&wf.alert_webhook_template)
            .bind(alert_throttle_hours)
            .bind(claims.sub)
            .fetch_one(pool)
            .await
            .map_err(map_workflow_write_err)?;

            if let Err(e) =
                snapshot_workflow_version(pool, &workflow, Some("批量导入"), Some(claims.sub)).await
            {
                tracing::warn!(workflow_id = workflow.id, error = %e, "导入新建的版本快照失败");
            }
            Ok(json!({
                "action": item.action,
                "id": workflow.id,
                "slug": workflow.slug,
                "name": workflow.name,
                "warnings": ds_warnings,
            }))
        }
        other => Err(AppError::InvalidQuery(format!(
            "未知的 action：{}（应为 create / overwrite / rename）",
            other
        ))),
    }
}

/// POST /api/admin/workflows/:id/duplicate — 复制一份工作流。
///
/// 在同库内自动生成唯一 slug（`<slug>-copy`、冲突再 `-copy-2`…），名字加「(副本)」后缀，
/// 并**默认禁用**（is_enabled=false）：复制出来先让人改完再启用，避免新副本立刻接管
/// endpoint / hook 触发造成意外执行。tenant_id / database_id 跟随源工作流。
pub async fn duplicate_workflow(
    State(pool): State<PgPool>,
    Path(id): Path<i32>,
    axum::Extension(claims): axum::Extension<Claims>,
    audit_sink: Option<axum::Extension<AuditDetailSink>>,
    op_source: Option<axum::Extension<OpSourceHint>>,
) -> Result<(StatusCode, Json<Value>)> {
    let src = fetch_workflow_for_admin(&pool, &claims, id).await?;

    let new_slug =
        generate_unique_slug(&pool, src.database_id, &format!("{}-copy", src.slug)).await?;
    let new_name = format!("{} (副本)", src.name);

    let workflow = sqlx::query_as::<_, Workflow>(
        r#"INSERT INTO management.workflows
           (tenant_id, database_id, name, slug, description, category, department,
            trigger_type, trigger_config, nodes, edges, dependencies, is_enabled, timeout_ms, max_retries,
            alert_webhook_url, alert_webhook_template, alert_throttle_hours, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, false, $13, $14, $15, $16, $17, $18)
           RETURNING *"#,
    )
    .bind(src.tenant_id)
    .bind(src.database_id)
    .bind(&new_name)
    .bind(&new_slug)
    .bind(&src.description)
    .bind(&src.category)
    .bind(&src.department)
    .bind(&src.trigger_type)
    .bind(&src.trigger_config)
    .bind(&src.nodes)
    .bind(&src.edges)
    .bind(&src.dependencies)
    .bind(src.timeout_ms)
    .bind(src.max_retries)
    .bind(&src.alert_webhook_url)
    .bind(&src.alert_webhook_template)
    .bind(src.alert_throttle_hours)
    .bind(claims.sub)
    .fetch_one(&pool)
    .await
    .map_err(map_workflow_write_err)?;

    tracing::info!(
        workflow_id = workflow.id,
        source_id = id,
        slug = %workflow.slug,
        "工作流已复制"
    );
    audit_workflow(
        &audit_sink,
        "workflow.duplicate",
        workflow.id,
        &workflow.name,
        &workflow.slug,
        json!({ "source_workflow_id": id }),
    );

    record_workflow_op(
        &pool,
        &claims,
        op_source_of(&op_source),
        operation_log::action::CREATE,
        &workflow,
        format!("复制工作流为「{}」", workflow.name),
        Some(workflow_snapshot_fields(&workflow, "created")),
    );

    Ok((StatusCode::CREATED, Json(json!({ "workflow": workflow }))))
}

/// POST /api/admin/workflows/:id/trigger — 手动触发
pub async fn trigger_workflow(
    State(pool): State<PgPool>,
    Path(id): Path<i32>,
    axum::Extension(claims): axum::Extension<Claims>,
    audit_sink: Option<axum::Extension<AuditDetailSink>>,
    Json(trigger_data): Json<Option<Value>>,
) -> Result<(StatusCode, Json<Value>)> {
    let workflow = fetch_workflow_for_admin(&pool, &claims, id).await?;

    if !workflow.is_enabled {
        return Err(AppError::InvalidQuery("工作流已禁用，无法触发".to_string()));
    }

    // 手动触发打点（source=console）。cron 自动触发的打点在调度侧另行接入。
    record_workflow_op(
        &pool,
        &claims,
        Source::Console,
        operation_log::action::TRIGGER,
        &workflow,
        format!("手动触发工作流「{}」", workflow.name),
        None,
    );

    let data = trigger_data.unwrap_or(json!({}));
    let pool_clone = pool.clone();
    let wf = workflow.clone();

    tokio::spawn(async move {
        if let Err(e) = execute_workflow_internal(
            &pool_clone,
            &wf,
            "manual",
            &data,
            Some(claims.sub),
            ApiKeyWriteGuard::Off,
        )
        .await
        {
            tracing::error!(workflow_id = wf.id, error = %e, "手动触发工作流执行失败");
        }
    });

    audit_workflow(
        &audit_sink,
        "workflow.trigger",
        workflow.id,
        &workflow.name,
        &workflow.slug,
        json!({}),
    );

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "message": "工作流已触发", "workflow_id": id })),
    ))
}

#[derive(Debug, Deserialize)]
pub struct DebugWorkflowRequest {
    pub nodes: Value,
    pub edges: Value,
    pub database_id: Option<i32>,
    pub tenant_id: Option<i32>,
    pub trigger_type: Option<String>,
    pub trigger_data: Option<Value>,
    pub timeout_ms: Option<i32>,
    /// 干跑：跳过写库 / HTTP / 邮件 / SSE 推送等副作用节点。
    pub dry_run: Option<bool>,
    /// 生产只读护栏：MCP 调试层按实例环境（RUST_ENV）注入；只会收紧不会放宽，
    /// 页面调用默认 false，行为与从前一致。
    #[serde(default)]
    pub prod_readonly: bool,
}

/// POST /api/admin/workflows/debug — 编辑态调试运行
///
/// 直接对**当前（可能未保存）**的 nodes/edges 定义跑一遍，返回逐节点结果，便于用户在
/// 编辑过程中调试。与 `trigger` 的区别：
///   - 不要求工作流已保存（接收整套定义，而非 id）
///   - 同步返回每个节点的 output / status / 耗时（不落 workflow_runs，绕开 FK）
///   - 鉴权同 create：按 database_id / tenant_id 解析并要求对应 admin
///
/// ⚠️ 调试会**真实执行**各节点（含写库 / 发 HTTP / 发邮件），前端已就此告警。
pub async fn debug_workflow(
    State(pool): State<PgPool>,
    axum::Extension(claims): axum::Extension<Claims>,
    Json(req): Json<DebugWorkflowRequest>,
) -> Result<Json<Value>> {
    let resolved_tenant_id =
        resolve_tenant_for_workflow_input(&pool, &claims, req.database_id, req.tenant_id).await?;

    let def = parse_definition(&req.nodes, &req.edges)?;
    workflow_engine::validate_definition(&def)?;

    let trigger_type = req.trigger_type.unwrap_or_else(|| "manual".to_string());
    let trigger_data = req.trigger_data.unwrap_or(json!({}));

    // 调试同样按 tenant_id 加载环境变量，保证 {{env.X}} / env.get 在调试态可解析
    let env_vars = load_env_vars(&pool, resolved_tenant_id, req.database_id).await;

    let mut exec_ctx = ExecutionContext {
        workflow_id: 0,
        run_id: 0,
        trigger_type: trigger_type.clone(),
        trigger_data: trigger_data.clone(),
        user_id: Some(claims.sub),
        tenant_id: resolved_tenant_id,
        database_id: req.database_id,
        node_outputs: HashMap::new(),
        env_vars,
        workflow_dependencies: json!({}),
        dry_run: req.dry_run.unwrap_or(false),
        prod_readonly: req.prod_readonly,
        // 调试路径不接网关 key 维度护栏（无 ApiKeyContext）；保持历史行为。
        apikey_write_guard: ApiKeyWriteGuard::Off,
    };

    let timeout_ms = match req.timeout_ms {
        Some(ms) if ms > 0 => (ms as u64).max(1_000),
        _ => 30_000,
    };

    let start = std::time::Instant::now();
    let engine = DagEngine::new(pool.clone());
    let results = match tokio::time::timeout(
        std::time::Duration::from_millis(timeout_ms),
        engine.execute(&def, &mut exec_ctx),
    )
    .await
    {
        Ok(r) => r,
        Err(_) => {
            return Ok(Json(json!({
                "status": "failed",
                "elapsed_ms": start.elapsed().as_millis() as i64,
                "node_results": [],
                "final_output": Value::Null,
                "error_message": format!("调试执行超时（超过 {} ms 未完成）", timeout_ms),
            })));
        }
    };
    let elapsed_ms = start.elapsed().as_millis() as i64;

    match results {
        Ok(node_results) => {
            let has_failure = node_results.iter().any(|r| r.status == NodeStatus::Failed);
            let status = if has_failure { "failed" } else { "completed" };
            let error_message = node_results
                .iter()
                .find(|r| r.status == NodeStatus::Failed)
                .and_then(|r| r.error.clone());
            let final_output = node_results
                .iter()
                .rev()
                .find(|r| r.status == NodeStatus::Success)
                .map(|r| r.output.clone())
                .unwrap_or(Value::Null);

            // 脱敏边界②：调试响应同样掩码——页面调试与 MCP tool_debug_workflow 共用此返回点，
            // 一处掩码两处覆盖。逐节点结果 / final_output / error_message 全过 mask_env_values。
            let masked_node_results =
                workflow_engine::mask_env_values(&json!(node_results), &exec_ctx.env_vars);
            let masked_final_output =
                workflow_engine::mask_env_values(&final_output, &exec_ctx.env_vars);
            let masked_error_message = error_message.as_ref().map(|m| {
                workflow_engine::mask_env_values(&json!(m), &exec_ctx.env_vars)
                    .as_str()
                    .unwrap_or(m)
                    .to_string()
            });

            Ok(Json(json!({
                "status": status,
                "elapsed_ms": elapsed_ms,
                "node_results": masked_node_results,
                "final_output": masked_final_output,
                "error_message": masked_error_message,
            })))
        }
        Err(e) => {
            // 错误文本也可能携带密钥，掩码后再返回
            let masked_err =
                workflow_engine::mask_env_values(&json!(e.to_string()), &exec_ctx.env_vars)
                    .as_str()
                    .unwrap_or("执行失败")
                    .to_string();
            Ok(Json(json!({
                "status": "failed",
                "elapsed_ms": elapsed_ms,
                "node_results": [],
                "final_output": Value::Null,
                "error_message": masked_err,
            })))
        }
    }
}

/// GET /api/admin/workflows/:id/runs
pub async fn get_workflow_runs(
    State(pool): State<PgPool>,
    Path(id): Path<i32>,
    Query(params): Query<HashMap<String, String>>,
    axum::Extension(claims): axum::Extension<Claims>,
) -> Result<Json<Value>> {
    let _workflow = fetch_workflow_for_admin(&pool, &claims, id).await?;
    let limit: i64 = params
        .get("limit")
        .and_then(|v| v.parse().ok())
        .unwrap_or(20)
        .min(100);

    let runs = sqlx::query_as::<_, WorkflowRun>(
        r#"SELECT * FROM management.workflow_runs
           WHERE workflow_id = $1
           ORDER BY started_at DESC
           LIMIT $2"#,
    )
    .bind(id)
    .bind(limit)
    .fetch_all(&pool)
    .await?;

    Ok(Json(json!({ "runs": runs, "total": runs.len() })))
}

// ─── 版本控制 ─────────────────────────────────────────

/// GET /api/admin/workflows/:id/versions — 版本列表（不含 nodes/edges 大字段，仅元信息）。
pub async fn list_workflow_versions(
    State(pool): State<PgPool>,
    Path(id): Path<i32>,
    Query(params): Query<HashMap<String, String>>,
    axum::Extension(claims): axum::Extension<Claims>,
) -> Result<Json<Value>> {
    let _workflow = fetch_workflow_for_admin(&pool, &claims, id).await?;
    let limit: i64 = params
        .get("limit")
        .and_then(|v| v.parse().ok())
        .unwrap_or(50)
        .min(200);

    let rows = sqlx::query(
        r#"SELECT v.id, v.version, v.name, v.note, v.trigger_type, v.created_at, v.created_by,
                  cu.username AS created_by_name, cu.email AS created_by_email,
                  jsonb_array_length(v.nodes) AS node_count
           FROM management.workflow_versions v
           LEFT JOIN users cu ON cu.id = v.created_by
           WHERE v.workflow_id = $1
           ORDER BY v.version DESC
           LIMIT $2"#,
    )
    .bind(id)
    .bind(limit)
    .fetch_all(&pool)
    .await?;

    let versions: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<i64, _>("id"),
                "version": r.get::<i32, _>("version"),
                "name": r.get::<String, _>("name"),
                "note": r.get::<Option<String>, _>("note"),
                "trigger_type": r.get::<String, _>("trigger_type"),
                "node_count": r.try_get::<Option<i32>, _>("node_count").ok().flatten(),
                "created_at": crate::models::naive_to_utc_string(r.get::<chrono::NaiveDateTime, _>("created_at")),
                "created_by": r.get::<Option<i32>, _>("created_by"),
                "created_by_name": r.get::<Option<String>, _>("created_by_name"),
                "created_by_email": r.get::<Option<String>, _>("created_by_email"),
            })
        })
        .collect();

    Ok(Json(
        json!({ "versions": versions, "total": versions.len() }),
    ))
}

/// GET /api/admin/workflows/:id/versions/:version — 取某个版本的完整快照（含 nodes/edges）。
pub async fn get_workflow_version(
    State(pool): State<PgPool>,
    Path((id, version)): Path<(i32, i32)>,
    axum::Extension(claims): axum::Extension<Claims>,
) -> Result<Json<Value>> {
    let _workflow = fetch_workflow_for_admin(&pool, &claims, id).await?;

    let v = sqlx::query_as::<_, WorkflowVersion>(
        r#"SELECT v.*, cu.username AS created_by_name, cu.email AS created_by_email
           FROM management.workflow_versions v
           LEFT JOIN users cu ON cu.id = v.created_by
           WHERE v.workflow_id = $1 AND v.version = $2"#,
    )
    .bind(id)
    .bind(version)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("工作流 {} 不存在版本 {}", id, version)))?;

    Ok(Json(json!({ "version": v })))
}

/// POST /api/admin/workflows/:id/versions/:version/restore — 把某历史版本恢复为当前定义。
///
/// 只恢复"定义"字段（name/slug/description/category/trigger_*/nodes/edges/timeout/retries），
/// **不动** is_enabled / database_id / tenant_id 等绑定与开关。恢复后会自动追加一条新版本
/// 快照（note 记为"恢复自 vN"），保持历史线性、可再次回滚。
pub async fn restore_workflow_version(
    State(pool): State<PgPool>,
    Path((id, version)): Path<(i32, i32)>,
    axum::Extension(claims): axum::Extension<Claims>,
    audit_sink: Option<axum::Extension<AuditDetailSink>>,
) -> Result<Json<Value>> {
    let existing = fetch_workflow_for_admin(&pool, &claims, id).await?;

    let snapshot = sqlx::query_as::<_, WorkflowVersion>(
        r#"SELECT v.* FROM management.workflow_versions v
           WHERE v.workflow_id = $1 AND v.version = $2"#,
    )
    .bind(id)
    .bind(version)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("工作流 {} 不存在版本 {}", id, version)))?;

    let workflow = sqlx::query_as::<_, Workflow>(
        r#"UPDATE management.workflows SET
            name = $2, slug = $3, description = $4, category = $5, department = $6,
            trigger_type = $7, trigger_config = $8, nodes = $9, edges = $10,
            timeout_ms = $11, max_retries = $12
           WHERE id = $1
           RETURNING *"#,
    )
    .bind(id)
    .bind(&snapshot.name)
    .bind(&snapshot.slug)
    .bind(&snapshot.description)
    .bind(&snapshot.category)
    .bind(&snapshot.department)
    .bind(&snapshot.trigger_type)
    .bind(&snapshot.trigger_config)
    .bind(&snapshot.nodes)
    .bind(&snapshot.edges)
    .bind(snapshot.timeout_ms)
    .bind(snapshot.max_retries)
    .fetch_optional(&pool)
    .await
    .map_err(map_workflow_write_err)?
    .ok_or_else(|| AppError::NotFound(format!("工作流 {} 不存在", id)))?;

    let note = format!("恢复自 v{}", version);
    let new_version = snapshot_workflow_version(&pool, &workflow, Some(&note), Some(claims.sub))
        .await
        .unwrap_or(0);

    tracing::info!(
        workflow_id = id,
        restored_from = version,
        new_version = new_version,
        "工作流已恢复到历史版本"
    );

    audit_workflow(
        &audit_sink,
        "workflow.restore_version",
        workflow.id,
        &workflow.name,
        &workflow.slug,
        json!({ "restored_from": version, "new_version": new_version }),
    );

    // 操作日志打点：恢复版本本质是把定义覆盖为历史快照，记为 UPDATE，并 diff 出实际变化。
    let change = workflow_change_diff(&existing, &workflow);
    record_workflow_op(
        &pool,
        &claims,
        Source::Console,
        operation_log::action::UPDATE,
        &workflow,
        format!("恢复工作流「{}」到版本 v{}", workflow.name, version),
        change,
    );

    Ok(Json(json!({
        "workflow": workflow,
        "restored_from": version,
        "new_version": new_version
    })))
}

// ─── Endpoint 触发器 ─────────────────────────────────────────
//
// POST /workflow/:database_slug/:workflow_slug
// 任意外部系统可通过此路由触发工作流（需携带 API Key 或 JWT）

enum EndpointCaller {
    User(Claims),
    ApiKey {
        database_id: i32,
        /// 这把 key 的 permissions JSONB。随身份一起带出来，让只读护栏判定的就是
        /// **实际认下调用方的那把 key**，而不是另一条路上解析出的 key。
        permissions: Value,
    },
    Anonymous,
}

async fn resolve_endpoint_caller(
    pool: &PgPool,
    headers: &HeaderMap,
    claims: Option<&axum::Extension<Claims>>,
) -> Result<EndpointCaller> {
    let bearer = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let apikey = headers.get("apikey").and_then(|h| h.to_str().ok());
    let api_key = bearer
        .filter(|v| v.starts_with("cr_"))
        .or_else(|| apikey.filter(|v| v.starts_with("cr_")));

    if let Some(key) = api_key {
        let row = sqlx::query(
            r#"
            SELECT database_id, permissions
            FROM management.api_keys
            WHERE key_hash = encode(sha256($1::bytea), 'hex')
              AND is_active = true
              AND (expires_at IS NULL OR expires_at > NOW())
            "#,
        )
        .bind(key)
        .fetch_optional(pool)
        .await?;
        let row = row.ok_or_else(|| AppError::Unauthorized("API Key 无效或已过期".to_string()))?;
        let key_database_id: i32 = row.get("database_id");
        let permissions: Value = row.try_get("permissions").unwrap_or_else(|_| json!({}));
        return Ok(EndpointCaller::ApiKey {
            database_id: key_database_id,
            permissions,
        });
    }

    if let Some(claims) = claims {
        return Ok(EndpointCaller::User(claims.0.clone()));
    }

    Err(AppError::Unauthorized(
        "缺少有效的 JWT 或 API Key".to_string(),
    ))
}

async fn resolve_database_for_caller(
    pool: &PgPool,
    caller: &EndpointCaller,
    database_slug: &str,
) -> Result<(i32, Option<i32>)> {
    match caller {
        EndpointCaller::ApiKey {
            database_id: key_database_id,
            ..
        } => {
            let row = sqlx::query(
                r#"
                SELECT id, tenant_id
                FROM management.tenant_databases
                WHERE id = $1 AND slug = $2 AND is_active = true
                "#,
            )
            .bind(*key_database_id)
            .bind(database_slug)
            .fetch_optional(pool)
            .await?;
            let row = row.ok_or_else(|| {
                AppError::Forbidden("API Key 无权触发该 database_slug 下的 workflow".to_string())
            })?;
            Ok((row.get("id"), row.try_get("tenant_id").ok()))
        }
        EndpointCaller::Anonymous => {
            // 公开路由：按 slug 查找，不做身份校验（webhook 自行验签）
            let row = sqlx::query(
                r#"SELECT id, tenant_id FROM management.tenant_databases
                   WHERE slug = $1 AND is_active = true ORDER BY id ASC LIMIT 1"#,
            )
            .bind(database_slug)
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| {
                AppError::NotFound(format!("database_slug '{}' 不存在", database_slug))
            })?;
            Ok((row.get("id"), row.try_get("tenant_id").ok()))
        }
        EndpointCaller::User(claims) => {
            let rows = if claims.is_superadmin {
                sqlx::query(
                    r#"
                    SELECT id, tenant_id
                    FROM management.tenant_databases
                    WHERE slug = $1 AND is_active = true
                    ORDER BY id ASC
                    LIMIT 2
                    "#,
                )
                .bind(database_slug)
                .fetch_all(pool)
                .await?
            } else {
                sqlx::query(
                    r#"
                    SELECT td.id, td.tenant_id
                    FROM management.tenant_databases td
                    JOIN management.user_tenants ut
                      ON ut.tenant_id = td.tenant_id
                     AND ut.user_id = $1
                     AND ut.is_active = true
                    WHERE td.slug = $2 AND td.is_active = true
                    ORDER BY td.id ASC
                    LIMIT 2
                    "#,
                )
                .bind(claims.sub)
                .bind(database_slug)
                .fetch_all(pool)
                .await?
            };
            match rows.len() {
                0 => Err(AppError::NotFound(format!(
                    "database_slug '{}' 不存在或未启用",
                    database_slug
                ))),
                1 => Ok((rows[0].get("id"), rows[0].try_get("tenant_id").ok())),
                _ => Err(AppError::InvalidQuery(format!(
                    "database_slug '{}' 存在歧义，请改用 API Key 或确保租户唯一",
                    database_slug
                ))),
            }
        }
    }
}

/// 该节点错误是否为只读 API Key 护栏的拦截结果。
///
/// 节点失败经 `NodeExecutionResult.error` 降级成字符串后才到达这里，类型信息已丢失，
/// 只能靠 `API_KEY_READONLY_BLOCK_CODE` 这个稳定标识回认。
fn is_api_key_readonly_block(error: &str) -> bool {
    workflow_engine::is_api_key_readonly_block_message(error)
}

/// 把一次 endpoint 工作流执行结果收敛为对外 HTTP 响应。
///
/// 三个 endpoint 入口（POST 鉴权 / GET / 公开 POST）共用此收口，保证行为一致：
/// - 命中 response 节点：返回其 body。
/// - 全部成功但无 response 节点：返回末节点输出（或 `{"ok": true}`）。
/// - 出现硬失败（`NodeStatus::Failed`）或整体超时/取消（`result` 为 `Err`）：
///   - 默认维持原语义，向上抛 `AppError`（对外 HTTP 5xx）；只读 API Key 护栏拦截是
///     例外，抛 `Forbidden`（403），因为那是权限拒绝而非服务端故障。
///   - 若 `workflow.trigger_config.graceful_error_response == true`：改为返回 **HTTP 200** +
///     结构化错误体 `{ ok:false, error, failed_node? }`，让外部调用方（如其它项目）始终
///     拿到可解析的 JSON 而不是连接层错误。`ok:false` 明确标失败，不构成「假成功」。
///
/// 注意：`FailedAllowed`（节点配置 allow_failure 被容错）不会触发错误分支——它本就期望
/// 后续 response 节点正常产出，这里只兜底「无人收口」的失败/超时。
fn finalize_endpoint_response(
    workflow: &Workflow,
    result: Result<Vec<NodeExecutionResult>>,
) -> Result<Json<Value>> {
    let graceful = workflow
        .trigger_config
        .get("graceful_error_response")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    match result {
        Ok(node_results) => {
            // 注意：endpoint 触发的对外 HTTP 响应**不脱敏**——这是规格规定的预期行为。
            // final_output 是工作流主动构造、返给外部调用方的业务结果。脱敏只作用于
            // 执行历史/调试输出这类内部留存面（见 execute_workflow_internal 的 UPDATE）。
            if let Some(resp) = node_results
                .iter()
                .rev()
                .find(|r| r.status == NodeStatus::Success && r.output.get("status_code").is_some())
            {
                let body = resp
                    .output
                    .get("body")
                    .cloned()
                    .unwrap_or(json!({"ok": true}));
                return Ok(Json(body));
            }

            if let Some(failed) = node_results.iter().find(|r| r.status == NodeStatus::Failed) {
                let err = failed
                    .error
                    .clone()
                    .unwrap_or_else(|| "工作流节点执行失败".to_string());
                if graceful {
                    return Ok(Json(json!({
                        "ok": false,
                        "error": err,
                        "failed_node": failed.node_id,
                    })));
                }
                // 只读 API Key 护栏拦截是权限问题而非服务端故障，映射成 403 让调用方
                // 一眼看出是「这把 key 不许写」，而不是以为后端挂了去重试。
                if is_api_key_readonly_block(&err) {
                    return Err(AppError::Forbidden(err));
                }
                // 工作流节点失败且没有 response 节点被执行，返回 5xx 而不是假成功
                return Err(AppError::Internal(err));
            }

            let final_output = node_results
                .last()
                .filter(|r| r.status == NodeStatus::Success)
                .map(|r| r.output.clone())
                .unwrap_or(json!({"ok": true}));
            Ok(Json(final_output))
        }
        // 整体超时 / 任务取消：execute_workflow_internal 已把 run 收口为 failed。
        Err(e) => {
            if graceful {
                Ok(Json(json!({
                    "ok": false,
                    "error": e.to_string(),
                })))
            } else {
                Err(e)
            }
        }
    }
}

/// 在**脱离当前 HTTP 请求生命周期**的独立任务里执行工作流，并等待其结果。
///
/// 背景：axum/hyper 在客户端断开连接（或上游 ingress/代理/前端 axios 超时，默认 30s）时会
/// drop handler future，取消其中所有 `.await`——正在进行的工作流执行被强行打断，run 收口成
/// 「执行被中断」。这与节点/工作流内部超时无关，调大内部超时救不回来。
///
/// 解法：把执行 `tokio::spawn` 到独立 task。handler future 被 drop 时只丢弃 JoinHandle
/// （tokio 不会因此 abort 任务），工作流照常跑完并正常收口。
///
/// 诊断：内置 `CancelProbe`——若 handler 在工作流完成前被取消（客户端/代理断连），会打一条
/// WARN（带 `elapsed_ms`），明确证明「30s 来自请求侧取消」而非工作流内部超时。
async fn run_workflow_detached(
    pool: PgPool,
    workflow: Workflow,
    trigger_type: &'static str,
    trigger_data: Value,
    user_id: Option<i32>,
    apikey_write_guard: ApiKeyWriteGuard,
) -> Result<Vec<NodeExecutionResult>> {
    let started = std::time::Instant::now();
    let wf_id = workflow.id;
    let wf_slug = workflow.slug.clone();

    tracing::info!(
        target: "workflow",
        workflow_id = wf_id,
        slug = %wf_slug,
        trigger_type = trigger_type,
        "端点触发：开始执行工作流（已 detach，客户端断开不影响执行）"
    );

    let handle = tokio::spawn(async move {
        execute_workflow_internal(
            &pool,
            &workflow,
            trigger_type,
            &trigger_data,
            user_id,
            apikey_write_guard,
        )
        .await
    });

    // 请求侧取消探针：handler future 在 join 完成前被 drop（客户端/ingress/axios 断连）时触发。
    struct CancelProbe {
        started: std::time::Instant,
        wf_id: i32,
        slug: String,
        done: bool,
    }
    impl Drop for CancelProbe {
        fn drop(&mut self) {
            if !self.done {
                tracing::warn!(
                    target: "workflow",
                    workflow_id = self.wf_id,
                    slug = %self.slug,
                    elapsed_ms = self.started.elapsed().as_millis() as u64,
                    "HTTP 请求侧被取消（客户端/ingress/代理/axios 断开连接）——这就是那个 30s 超时的来源；\
                     工作流已 detach，仍在后台继续执行并会正常收口，不会再写「被中断」"
                );
            }
        }
    }
    let mut probe = CancelProbe {
        started,
        wf_id,
        slug: wf_slug.clone(),
        done: false,
    };

    let out = match handle.await {
        Ok(result) => result,
        // 仅在 spawned task panic 时发生（我们从不 abort）；guard 会在 unwind 中收口 run。
        Err(join_err) => Err(AppError::Internal(format!(
            "工作流执行任务异常终止: {}",
            join_err
        ))),
    };
    probe.done = true;

    tracing::info!(
        target: "workflow",
        workflow_id = wf_id,
        slug = %wf_slug,
        elapsed_ms = started.elapsed().as_millis() as u64,
        "端点触发：工作流执行结束（HTTP 响应仅在调用方仍在线时送达）"
    );

    out
}

/// 依据请求所带网关 cr_ key 的 `permissions` 与 `WORKFLOW_APIKEY_RW_GUARD` 档位，推导本次
/// endpoint 执行的 DB 写护栏状态。
///
/// - mode=off / 无 key / 读写 key → `Off`（不拦，维持现状）。
/// - 只读 key（`api_key_declares_readonly`）→ 采用配置档位（`log_only` 影子 / `enforce` 拦截）。
///
/// 与「调用者是机器还是 SSO 用户」无关：只认请求里那把 key（网关对两类请求都挂同一把）。
///
/// **两个来源都要看**，因为请求里的 key 有两条互不重合的进入路径：
/// - `ApiKeyContext` 由 `auth_middleware` 注入，只认 `Authorization: Bearer` 与 `?token=`；
/// - `EndpointCaller::ApiKey` 由 `resolve_endpoint_caller` 解析，额外认 `apikey` 请求头。
///
/// 只看前者，`apikey: cr_只读key` + 另一个 Bearer（JWT/crp_）就能让护栏静默失效，而工作流
/// 却已按这把只读 key 的 database 在跑；只看后者，`?token=cr_只读key` 又会漏。取并集后
/// 任一路径认出的只读 key 都能生效，且两条路径指向同一把 key 时结论一致。
fn resolve_apikey_write_guard(
    api_key_ctx: Option<&axum::Extension<ApiKeyContext>>,
    caller: &EndpointCaller,
) -> ApiKeyWriteGuard {
    let caller_permissions = match caller {
        EndpointCaller::ApiKey { permissions, .. } => Some(permissions),
        _ => None,
    };
    let sources: Vec<&Value> = [api_key_ctx.map(|ctx| &ctx.permissions), caller_permissions]
        .into_iter()
        .flatten()
        .collect();
    apikey_write_guard_for(workflow_engine::apikey_rw_guard_mode(), &sources)
}

/// 纯组合逻辑（可注入 mode / permissions，便于单测）：mode=off、无 key、或所有来源都是
/// 读写 key → Off；**任一**来源声明只读 → 采用 mode（log_only / enforce）。
fn apikey_write_guard_for(mode: ApiKeyWriteGuard, permissions: &[&Value]) -> ApiKeyWriteGuard {
    if mode == ApiKeyWriteGuard::Off {
        return ApiKeyWriteGuard::Off;
    }
    if permissions
        .iter()
        .any(|p| crate::permissions::api_key_declares_readonly(p))
    {
        mode
    } else {
        ApiKeyWriteGuard::Off
    }
}

pub async fn endpoint_trigger(
    State(pool): State<PgPool>,
    Path((database_slug, workflow_slug)): Path<(String, String)>,
    headers: HeaderMap,
    claims: Option<axum::Extension<Claims>>,
    api_key_ctx: Option<axum::Extension<ApiKeyContext>>,
    body_bytes: Bytes,
) -> Result<Json<Value>> {
    let caller = resolve_endpoint_caller(&pool, &headers, claims.as_ref()).await?;
    let apikey_write_guard = resolve_apikey_write_guard(api_key_ctx.as_ref(), &caller);
    let (resolved_database_id, _tenant_id) =
        resolve_database_for_caller(&pool, &caller, &database_slug).await?;

    let workflow = sqlx::query_as::<_, Workflow>(
        r#"SELECT * FROM management.workflows
           WHERE database_id = $1 AND slug = $2 AND trigger_type = 'endpoint' AND is_enabled = true"#,
    )
    .bind(resolved_database_id)
    .bind(&workflow_slug)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| {
        AppError::NotFound(format!(
            "工作流 {}/{} 不存在或未启用",
            database_slug, workflow_slug
        ))
    })?;

    // 解析 JSON body，保留原始字节供 Webhook 验签
    let parsed_body: Value = serde_json::from_slice(&body_bytes).unwrap_or(Value::Null);

    // 提取 HTTP headers 注入 trigger_data（供 Lua 访问）
    let headers_json: serde_json::Map<String, Value> = headers
        .iter()
        .filter_map(|(k, v)| Some((k.to_string(), Value::String(v.to_str().ok()?.to_string()))))
        .collect();

    // 向后兼容：保持 body 字段平铺到 trigger_data 顶层，同时注入 _raw_body 和 headers。
    // 老工作流 {{trigger.field}} 继续工作；webhook 可用 {{trigger._raw_body}} / {{trigger.headers["..."]}}。
    let mut trigger_map = parsed_body.as_object().cloned().unwrap_or_default();
    trigger_map.insert(
        "_raw_body".to_string(),
        Value::String(String::from_utf8_lossy(&body_bytes).to_string()),
    );
    trigger_map.insert("headers".to_string(), Value::Object(headers_json));
    let trigger_data = Value::Object(trigger_map);

    let user_id = match &caller {
        EndpointCaller::User(c) => Some(c.sub),
        EndpointCaller::ApiKey { .. } | EndpointCaller::Anonymous => None,
    };
    let result = run_workflow_detached(
        pool.clone(),
        workflow.clone(),
        "endpoint",
        trigger_data,
        user_id,
        apikey_write_guard,
    )
    .await;
    finalize_endpoint_response(&workflow, result)
}

/// GET /workflow/:database_slug/:workflow_slug — 支持通过 query string 传参
pub async fn endpoint_trigger_get(
    State(pool): State<PgPool>,
    Path((database_slug, workflow_slug)): Path<(String, String)>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
    claims: Option<axum::Extension<Claims>>,
    api_key_ctx: Option<axum::Extension<ApiKeyContext>>,
) -> Result<Json<Value>> {
    let body = serde_json::to_value(&params).unwrap_or(json!({}));
    let caller = resolve_endpoint_caller(&pool, &headers, claims.as_ref()).await?;
    let apikey_write_guard = resolve_apikey_write_guard(api_key_ctx.as_ref(), &caller);
    let (resolved_database_id, _tenant_id) =
        resolve_database_for_caller(&pool, &caller, &database_slug).await?;

    let workflow = sqlx::query_as::<_, Workflow>(
        r#"SELECT * FROM management.workflows
           WHERE database_id = $1 AND slug = $2 AND trigger_type = 'endpoint' AND is_enabled = true"#,
    )
    .bind(resolved_database_id)
    .bind(&workflow_slug)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| {
        AppError::NotFound(format!(
            "工作流 {}/{} 不存在或未启用",
            database_slug, workflow_slug
        ))
    })?;

    let user_id = match &caller {
        EndpointCaller::User(c) => Some(c.sub),
        EndpointCaller::ApiKey { .. } | EndpointCaller::Anonymous => None,
    };
    let result = run_workflow_detached(
        pool.clone(),
        workflow.clone(),
        "endpoint",
        body,
        user_id,
        apikey_write_guard,
    )
    .await;
    finalize_endpoint_response(&workflow, result)
}

/// POST /pub/workflow/:database_slug/:workflow_slug — 公开端点，无需认证（Stripe webhook 用）
pub async fn endpoint_trigger_public(
    State(pool): State<PgPool>,
    Path((database_slug, workflow_slug)): Path<(String, String)>,
    headers: HeaderMap,
    body_bytes: Bytes,
) -> Result<Json<Value>> {
    let caller = EndpointCaller::Anonymous;
    let (resolved_database_id, _tenant_id) =
        resolve_database_for_caller(&pool, &caller, &database_slug).await?;

    let workflow = sqlx::query_as::<_, Workflow>(
        r#"SELECT * FROM management.workflows
           WHERE database_id = $1 AND slug = $2 AND trigger_type = 'endpoint' AND is_enabled = true"#,
    )
    .bind(resolved_database_id)
    .bind(&workflow_slug)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| {
        AppError::NotFound(format!(
            "工作流 {}/{} 不存在或未启用",
            database_slug, workflow_slug
        ))
    })?;

    let parsed_body: Value = serde_json::from_slice(&body_bytes).unwrap_or(Value::Null);
    let headers_json: serde_json::Map<String, Value> = headers
        .iter()
        .filter_map(|(k, v)| Some((k.to_string(), Value::String(v.to_str().ok()?.to_string()))))
        .collect();

    let mut trigger_map = parsed_body.as_object().cloned().unwrap_or_default();
    trigger_map.insert(
        "_raw_body".to_string(),
        Value::String(String::from_utf8_lossy(&body_bytes).to_string()),
    );
    trigger_map.insert("headers".to_string(), Value::Object(headers_json));
    let trigger_data = Value::Object(trigger_map);

    // 公开端点无 auth_middleware / ApiKeyContext，不接网关 key 读写护栏（维持现状）。
    let result = run_workflow_detached(
        pool.clone(),
        workflow.clone(),
        "endpoint",
        trigger_data,
        None,
        ApiKeyWriteGuard::Off,
    )
    .await;
    finalize_endpoint_response(&workflow, result)
}

// ─── 内部执行逻辑 ─────────────────────────────────────────

/// 按 tenant_id 一次性加载项目级环境变量（解密后明文），装入执行上下文。
///
/// 单一数据源：`{{env.X}}` 模板与 Lua `env.get` 都从这里装入的 HashMap 读取，单次执行内
/// 变量一致。解密失败的变量**跳过不装入**（而非装空串）：空 token 发往外部系统会产生非
/// 预期副作用，缺失与"未配置"同语义，error 日志点名变量。
///
/// 租户解析：环境变量按 tenant 隔离，但工作流可能只绑 `database_id`、`tenant_id` 为 NULL
/// （如 Stripe 工作流挂在库上）。此时从 database_id 反查所属租户，否则变量永远读不到。
async fn load_env_vars(
    pool: &PgPool,
    tenant_id: Option<i32>,
    database_id: Option<i32>,
) -> HashMap<String, String> {
    let effective_tenant = match tenant_id {
        Some(id) => Some(id),
        None => match database_id {
            Some(db_id) => crate::permissions::lookup_tenant_for_database(pool, db_id)
                .await
                .ok(),
            None => None,
        },
    };
    let tenant_id = match effective_tenant {
        Some(id) => id,
        None => return HashMap::new(),
    };
    let rows = match sqlx::query(
        r#"SELECT name, value_encrypted FROM management.project_env_vars WHERE tenant_id = $1"#,
    )
    .bind(tenant_id)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            // 查询失败不阻断执行（如表尚未迁移），记录后按空表降级
            tracing::error!(tenant_id, error = %e, "加载项目环境变量失败，按空表降级");
            return HashMap::new();
        }
    };
    rows.into_iter()
        .filter_map(|row| {
            let name: String = row.get("name");
            let encrypted: String = row.get("value_encrypted");
            match crate::crypto::decrypt_secret(&encrypted) {
                Ok(v) => Some((name, v)),
                Err(e) => {
                    tracing::error!(tenant_id, name = %name, error = %e, "环境变量解密失败，跳过该变量");
                    None
                }
            }
        })
        .collect()
}

pub async fn execute_workflow_internal(
    pool: &PgPool,
    workflow: &Workflow,
    trigger_type: &str,
    trigger_data: &Value,
    user_id: Option<i32>,
    apikey_write_guard: ApiKeyWriteGuard,
) -> Result<Vec<NodeExecutionResult>> {
    // 防御性兜底（集中不变量）：任何触发路径都不得执行已禁用的工作流。
    //
    // 各触发入口（endpoint 三态 / hook / notify / cron / manual）都已在查询时过滤
    // `is_enabled = true`，正常不会走到这里。但把「禁用即不执行」这条不变量集中在唯一的
    // 执行入口再确认一次：即便将来新增触发方式漏了过滤，禁用的工作流也绝不会真正运行
    // —— 不落 run、不产生任何副作用。（调试 debug_workflow / 子工作流 call_workflow 不经此函数，
    // 不受影响。）
    if !workflow.is_enabled {
        tracing::warn!(
            workflow_id = workflow.id,
            slug = %workflow.slug,
            trigger_type,
            "拒绝执行已禁用的工作流：触发入口本应已过滤 is_enabled，此处为兜底拦截"
        );
        return Err(AppError::InvalidQuery(format!(
            "工作流 {} 已禁用，拒绝执行",
            workflow.slug
        )));
    }

    let start = std::time::Instant::now();

    // 统一关联键：endpoint 触发时复用本次 HTTP 请求的 x-request-id（让工作流 run 与
    // access log 串到同一条链路）；cron / notify 等无请求上下文时生成新 UUID。
    let trace_id = crate::request_id::current().unwrap_or_else(crate::execution_log::new_trace_id);

    // 创建执行记录
    let run = sqlx::query_as::<_, WorkflowRun>(
        r#"INSERT INTO management.workflow_runs
           (workflow_id, tenant_id, trigger_type, trigger_data, status, trace_id)
           VALUES ($1, $2, $3, $4, 'running', $5)
           RETURNING *"#,
    )
    .bind(workflow.id)
    .bind(workflow.tenant_id)
    .bind(trigger_type)
    .bind(trigger_data)
    .bind(&trace_id)
    .fetch_one(pool)
    .await?;

    // 统一执行索引：一行 running，三个收口分支（超时 / 完成 / 错误）各自 finish。
    let index_id = crate::execution_log::begin_index(
        pool,
        &trace_id,
        "workflow",
        Some("workflow_runs"),
        Some(run.id),
        workflow.tenant_id,
        user_id,
        Some(&workflow.name),
    )
    .await;

    // HTTP 层 TimeoutLayer（408）或任务取消时，execute 可能来不及走正常收口分支；
    // guard 在 Drop 时把仍为 running 的 run 与 execution_index 一并收口为 failed。
    let run_guard = WorkflowRunGuard::new(pool.clone(), run.id, index_id);

    let def = parse_definition(&workflow.nodes, &workflow.edges)?;

    // 执行开始一次性加载项目环境变量（单一数据源，供 {{env.X}} 与 Lua env.get 读取）
    let env_vars = load_env_vars(pool, workflow.tenant_id, workflow.database_id).await;

    let mut exec_ctx = ExecutionContext {
        workflow_id: workflow.id,
        run_id: run.id,
        trigger_type: trigger_type.to_string(),
        trigger_data: trigger_data.clone(),
        user_id,
        tenant_id: workflow.tenant_id,
        database_id: workflow.database_id,
        node_outputs: HashMap::new(),
        env_vars,
        workflow_dependencies: workflow.dependencies.clone(),
        dry_run: false,
        prod_readonly: false,
        apikey_write_guard,
    };

    let engine = DagEngine::new(pool.clone());

    // 整体执行超时兜底（可配置 / 可完全关闭）：resolve_workflow_timeout 返回 None 表示不限
    // （WORKFLOW_DISABLE_TIMEOUT 或 timeout_ms<0），此时不包 tokio::time::timeout，由
    // WorkflowRunGuard（中断收口）+ 残留 run 周期自检兜底，避免幽灵 running。否则用解析出的
    // 墙钟上限包裹执行，超时即把 run 置为 failed，避免"executor 卡死、run 永不收口"。
    let maybe_timeout = workflow_engine::resolve_workflow_timeout(workflow.timeout_ms);
    // 定位诊断：把「本次执行实际生效的超时策略」打出来，一眼看清 30s 到底是不是内部超时。
    let effective_timeout = match maybe_timeout {
        Some(d) => format!("{}ms", d.as_millis()),
        None => "无限（已关闭工作流整体超时）".to_string(),
    };
    tracing::info!(
        target: "workflow",
        run_id = run.id,
        workflow_id = workflow.id,
        stored_timeout_ms = workflow.timeout_ms,
        effective_timeout = %effective_timeout,
        http_node_default_secs = workflow_engine::http_default_timeout_secs(),
        timeout_disabled = workflow_engine::workflow_timeout_disabled(),
        "工作流超时策略（用于定位 30s 来源；若这里显示 30000ms 则是内部超时，否则 30s 来自请求侧/外部）"
    );
    let exec_fut = engine.execute(&def, &mut exec_ctx);
    let timed_result = match maybe_timeout {
        None => Ok(exec_fut.await),
        Some(dur) => tokio::time::timeout(dur, exec_fut)
            .await
            .map_err(|_| dur.as_millis() as u64),
    };
    let results = match timed_result {
        Ok(results) => results,
        Err(timeout_ms) => {
            let elapsed_ms = start.elapsed().as_millis() as i64;
            // 超时文案为固定文本、本不含密钥，仍统一过掩码以防未来漂移引入泄漏
            let msg = workflow_engine::mask_env_values(
                &json!(format!(
                    "工作流执行超时（超过 {} ms 未完成，已强制中止）",
                    timeout_ms
                )),
                &exec_ctx.env_vars,
            )
            .as_str()
            .unwrap_or("工作流执行超时")
            .to_string();
            let _ = sqlx::query(
                r#"UPDATE management.workflow_runs
                   SET status = 'failed', error_message = $2, elapsed_ms = $3, completed_at = NOW()
                   WHERE id = $1"#,
            )
            .bind(run.id)
            .bind(&msg)
            .bind(elapsed_ms)
            .execute(pool)
            .await;
            tracing::error!(
                workflow_id = workflow.id,
                run_id = run.id,
                timeout_ms = timeout_ms,
                "工作流执行超时，已强制中止并置为 failed"
            );
            crate::execution_log::finish_index(
                pool,
                index_id,
                "timeout",
                Some(elapsed_ms),
                Some(&msg),
            )
            .await;
            crate::alert_webhook::spawn_workflow_failure_alert(
                pool.clone(),
                workflow.id,
                crate::alert_webhook::AlertWebhookContext {
                    source: "workflow",
                    object_id: workflow.id as i64,
                    run_id: run.id,
                    name: workflow.name.clone(),
                    status: "timeout".to_string(),
                    error: Some(msg.clone()),
                    trigger_type: trigger_type.to_string(),
                    trace_id: Some(trace_id.clone()),
                },
            );
            run_guard.mark_finalized();
            return Err(AppError::Internal(msg));
        }
    };

    let elapsed_ms = start.elapsed().as_millis() as i64;

    match results {
        Ok(ref node_results) => {
            let has_failure = node_results.iter().any(|r| r.status == NodeStatus::Failed);
            let status = if has_failure { "failed" } else { "completed" };
            let error_msg = node_results
                .iter()
                .find(|r| r.status == NodeStatus::Failed)
                .and_then(|r| r.error.clone());

            let final_output = node_results
                .iter()
                .rev()
                .find(|r| r.status == NodeStatus::Success)
                .map(|r| &r.output);

            // 脱敏边界①：落 workflow_runs 前对 node_results / final_output / error_message
            // 三字段全量掩码，防止密钥经执行历史泄漏
            let masked_node_results =
                workflow_engine::mask_env_values(&json!(node_results), &exec_ctx.env_vars);
            let masked_final_output =
                final_output.map(|o| workflow_engine::mask_env_values(o, &exec_ctx.env_vars));
            let masked_error_msg = error_msg.as_ref().map(|m| {
                workflow_engine::mask_env_values(&json!(m), &exec_ctx.env_vars)
                    .as_str()
                    .unwrap_or(m)
                    .to_string()
            });

            sqlx::query(
                r#"UPDATE management.workflow_runs
                   SET status = $2, node_results = $3, final_output = $4,
                       error_message = $5, elapsed_ms = $6, completed_at = NOW()
                   WHERE id = $1"#,
            )
            .bind(run.id)
            .bind(status)
            .bind(masked_node_results)
            .bind(masked_final_output)
            .bind(&masked_error_msg)
            .bind(elapsed_ms)
            .execute(pool)
            .await?;

            tracing::info!(
                workflow_id = workflow.id,
                run_id = run.id,
                status = status,
                elapsed_ms = elapsed_ms,
                "工作流执行完成"
            );

            // 索引层用 success/failed 表达终态（status 此处为 'completed'/'failed'）。
            let index_status = if status == "completed" {
                "success"
            } else {
                "failed"
            };
            crate::execution_log::finish_index(
                pool,
                index_id,
                index_status,
                Some(elapsed_ms),
                masked_error_msg.as_deref(),
            )
            .await;

            if status == "failed" {
                crate::alert_webhook::spawn_workflow_failure_alert(
                    pool.clone(),
                    workflow.id,
                    crate::alert_webhook::AlertWebhookContext {
                        source: "workflow",
                        object_id: workflow.id as i64,
                        run_id: run.id,
                        name: workflow.name.clone(),
                        status: "failed".to_string(),
                        error: masked_error_msg.clone(),
                        trigger_type: trigger_type.to_string(),
                        trace_id: Some(trace_id.clone()),
                    },
                );
            }

            run_guard.mark_finalized();
            Ok(node_results.clone())
        }
        Err(e) => {
            // 脱敏边界①（Err 分支）：e.to_string() 直接入库，SMTP / 网络错误文本可能携带
            // 解析后的密钥，必须先掩码再落库
            let masked_err =
                workflow_engine::mask_env_values(&json!(e.to_string()), &exec_ctx.env_vars)
                    .as_str()
                    .unwrap_or("执行失败")
                    .to_string();
            sqlx::query(
                r#"UPDATE management.workflow_runs
                   SET status = 'failed', error_message = $2, elapsed_ms = $3, completed_at = NOW()
                   WHERE id = $1"#,
            )
            .bind(run.id)
            .bind(&masked_err)
            .bind(elapsed_ms)
            .execute(pool)
            .await?;

            crate::execution_log::finish_index(
                pool,
                index_id,
                "failed",
                Some(elapsed_ms),
                Some(&masked_err),
            )
            .await;

            crate::alert_webhook::spawn_workflow_failure_alert(
                pool.clone(),
                workflow.id,
                crate::alert_webhook::AlertWebhookContext {
                    source: "workflow",
                    object_id: workflow.id as i64,
                    run_id: run.id,
                    name: workflow.name.clone(),
                    status: "failed".to_string(),
                    error: Some(masked_err.clone()),
                    trigger_type: trigger_type.to_string(),
                    trace_id: Some(trace_id.clone()),
                },
            );

            run_guard.mark_finalized();
            Err(e)
        }
    }
}

/// 工作流 run 收口守卫：正常完成须 `mark_finalized()`；若任务被 HTTP 408 / 取消打断，
/// Drop 时异步把仍为 `running` 的 run 与 execution_index 一并置为 failed。
struct WorkflowRunGuard {
    pool: PgPool,
    run_id: i64,
    index_id: Option<i64>,
    started: std::time::Instant,
    finalized: Arc<AtomicBool>,
}

impl WorkflowRunGuard {
    fn new(pool: PgPool, run_id: i64, index_id: Option<i64>) -> Self {
        Self {
            pool,
            run_id,
            index_id,
            started: std::time::Instant::now(),
            finalized: Arc::new(AtomicBool::new(false)),
        }
    }

    fn mark_finalized(&self) {
        self.finalized.store(true, Ordering::SeqCst);
    }
}

impl Drop for WorkflowRunGuard {
    fn drop(&mut self) {
        if self.finalized.load(Ordering::SeqCst) {
            return;
        }
        let pool = self.pool.clone();
        let run_id = self.run_id;
        let index_id = self.index_id;
        let elapsed_ms = self.started.elapsed().as_millis() as i64;
        let msg = "工作流执行被中断（HTTP 请求超时或任务取消，未正常收口）".to_string();
        tracing::warn!(
            target: "workflow",
            run_id = run_id,
            elapsed_ms = elapsed_ms,
            "WorkflowRunGuard 触发：执行任务本身在收口前被 drop（任务被取消 / 进程退出）。\
             端点触发已 detach，正常不应出现此日志；若仍出现，多半是运行的仍是旧二进制、\
             或进程被强杀/重启"
        );
        tokio::spawn(async move {
            let _ = sqlx::query(
                r#"UPDATE management.workflow_runs
                   SET status = 'failed', error_message = $2, elapsed_ms = $3, completed_at = NOW()
                   WHERE id = $1 AND status = 'running'"#,
            )
            .bind(run_id)
            .bind(&msg)
            .bind(elapsed_ms)
            .execute(&pool)
            .await;
            crate::execution_log::finish_index(
                &pool,
                index_id,
                "failed",
                Some(elapsed_ms),
                Some(&msg),
            )
            .await;
        });
    }
}

/// 启动自检：把残留的、超过 `grace_secs` 仍停在 `running` 的 workflow_runs 收口为 failed。
///
/// 工作流执行是进程内的 tokio 任务，进程一旦重启（或上次卡死被强杀），这些 run 的内存态
/// 执行就没了，但 DB 行还停在 `running`，永远不会再被更新。这里在启动时一次性清理，
/// 避免出现"幽灵 running"。grace 窗口避免误伤多实例部署下其它实例正在跑的新 run。
pub async fn reconcile_stale_runs(pool: &PgPool, grace_secs: i64) -> Result<u64> {
    let grace = grace_secs.max(0) as f64;
    let res = sqlx::query(
        r#"UPDATE management.workflow_runs
           SET status = 'failed',
               error_message = COALESCE(error_message, 'running 超时未收口（疑似进程重启或执行卡死），已由自检置为 failed'),
               completed_at = NOW(),
               elapsed_ms = (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::bigint
           WHERE status = 'running'
             AND started_at < NOW() - make_interval(secs => $1)"#,
    )
    .bind(grace)
    .execute(pool)
    .await?;

    let swept = res.rows_affected();
    if swept > 0 {
        tracing::warn!(
            swept = swept,
            grace_secs = grace_secs,
            "工作流自检：已把残留的 running 执行记录收口为 failed"
        );
    }
    Ok(swept)
}

/// 周期性收口「幽灵 running」工作流执行的后台任务（第二道防线）。
///
/// 第一道防线是 `execute_workflow_internal` 里的进程内 `tokio::time::timeout`：正常情况下
/// 每个 run 都会在 `workflow.timeout_ms` 内收口。但在极端场景下——运行时 worker 被同步阻塞、
/// 进程在更新 run 行前 panic / 被 kill、或定时器迟迟无法被 poll——仍可能残留 running。
/// 该任务用**独立的 management 连接池**周期性扫描，把超过 `grace_secs` 仍 running 的 run 置为
/// failed，确保任何 run 都不会永远卡在 running，executor 也不会出现「越积越多、永不收口」。
///
/// `grace_secs` 取一个明显大于常规 `workflow.timeout_ms` 的值（默认 600s），避免误伤
/// 真正还在执行的长任务。
pub fn start_stale_run_reaper(pool: PgPool, interval_secs: u64, grace_secs: i64) {
    tokio::spawn(async move {
        let period = std::time::Duration::from_secs(interval_secs.max(10));
        let mut ticker = tokio::time::interval(period);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // 跳过首个立即返回的 tick：启动自检已单独跑过一次，避免重复。
        ticker.tick().await;
        tracing::info!(
            interval_secs = interval_secs,
            grace_secs = grace_secs,
            "工作流残留 run 周期自检已启动"
        );
        loop {
            ticker.tick().await;
            match reconcile_stale_runs(&pool, grace_secs).await {
                Ok(_) => {}
                Err(e) => tracing::error!(error = %e, "工作流周期自检失败"),
            }
        }
    });
}

#[derive(Debug, Deserialize)]
pub struct CleanupRunsRequest {
    /// 仅清理某数据库下工作流的 run（需 database admin）。
    pub database_id: Option<i32>,
    /// 仅清理某租户下工作流的 run（需 tenant admin）。
    pub tenant_id: Option<i32>,
    /// 收口阈值：仅清理 running 超过该秒数的 run。缺省 600s；传 0 表示清理全部 running
    /// （慎用——可能误伤真正在执行的 run）。
    pub grace_secs: Option<i64>,
}

/// POST /api/admin/workflows/runs/cleanup — 管理员手动收口残留 running 的执行记录。
///
/// 与后台「周期自检」「启动自检」同一套收口逻辑，区别是由管理员主动触发、可自定义阈值，
/// 用于卡死事故时不等周期任务、立刻清积压。作用域沿用 list_workflows 的四分支权限：
/// 指定 database_id / tenant_id 时校验对应 admin；超管可全量；普通管理员仅限所辖租户。
pub async fn cleanup_stale_runs(
    State(pool): State<PgPool>,
    axum::Extension(claims): axum::Extension<Claims>,
    Json(req): Json<CleanupRunsRequest>,
) -> Result<Json<Value>> {
    let grace = req.grace_secs.unwrap_or(600).max(0) as f64;

    let mut qb: sqlx::QueryBuilder<sqlx::Postgres> = sqlx::QueryBuilder::new(
        "UPDATE management.workflow_runs r \
         SET status = 'failed', \
             error_message = COALESCE(error_message, '管理员手动清理：收口残留 running'), \
             completed_at = NOW(), \
             elapsed_ms = (EXTRACT(EPOCH FROM (NOW() - r.started_at)) * 1000)::bigint \
         WHERE r.status = 'running' \
           AND r.started_at < NOW() - make_interval(secs => ",
    );
    qb.push_bind(grace).push(")");

    if let Some(did) = req.database_id {
        crate::permissions::require_database_admin(&pool, &claims, did).await?;
        qb.push(" AND r.workflow_id IN (SELECT id FROM management.workflows WHERE database_id = ")
            .push_bind(did)
            .push(")");
    } else if let Some(tid) = req.tenant_id {
        crate::permissions::require_tenant_admin(&pool, &claims, tid).await?;
        qb.push(" AND r.workflow_id IN (SELECT id FROM management.workflows WHERE tenant_id = ")
            .push_bind(tid)
            .push(")");
    } else if claims.is_superadmin {
        // 全量，无额外作用域约束
    } else {
        let tenant_ids = crate::permissions::tenant_admin_ids(&pool, &claims).await?;
        if tenant_ids.is_empty() {
            return Ok(Json(json!({ "cleaned": 0 })));
        }
        qb.push(
            " AND r.workflow_id IN (SELECT w.id FROM management.workflows w \
              LEFT JOIN management.tenant_databases td ON td.id = w.database_id \
              WHERE w.tenant_id = ANY(",
        )
        .push_bind(tenant_ids.clone())
        .push(") OR td.tenant_id = ANY(")
        .push_bind(tenant_ids)
        .push("))");
    }

    let res = qb.build().execute(&pool).await?;
    let cleaned = res.rows_affected();
    tracing::warn!(
        user = claims.sub,
        cleaned = cleaned,
        grace_secs = grace as i64,
        "管理员手动清理残留 running 工作流执行"
    );
    Ok(Json(json!({ "cleaned": cleaned })))
}

// ─── 辅助函数 ─────────────────────────────────────────

/// 按节点 id 把增量补丁合并进现有 nodes 数组（整节点替换语义）。
/// - `patch` 里每个节点：id 已存在则整体替换，不存在则追加；每个节点必须带 id。
/// - `remove_ids` 里的 id：从数组移除。
/// 全程在原始 JSON 层按 id 匹配，未涉及的节点原样保留——不经 WorkflowNode 结构体，
/// 以免丢掉前端画布坐标等未建模字段。
fn merge_node_patch(
    existing_nodes: &Value,
    patch: Option<&Value>,
    remove_ids: &[String],
) -> Result<Value> {
    let mut list: Vec<Value> = existing_nodes.as_array().cloned().unwrap_or_default();

    // 删除
    if !remove_ids.is_empty() {
        list.retain(|n| {
            n.get("id")
                .and_then(|v| v.as_str())
                .map(|id| !remove_ids.iter().any(|r| r == id))
                .unwrap_or(true)
        });
    }

    // upsert
    if let Some(patch_val) = patch {
        let patch_arr = patch_val
            .as_array()
            .ok_or_else(|| AppError::InvalidQuery("node_patch 必须是节点对象数组".to_string()))?;
        for pnode in patch_arr {
            let pid = pnode
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    AppError::InvalidQuery("node_patch 中每个节点必须带 id".to_string())
                })?
                .to_string();
            if let Some(slot) = list
                .iter_mut()
                .find(|n| n.get("id").and_then(|v| v.as_str()) == Some(pid.as_str()))
            {
                *slot = pnode.clone();
            } else {
                list.push(pnode.clone());
            }
        }
    }

    Ok(Value::Array(list))
}

fn parse_definition(nodes: &Value, edges: &Value) -> Result<WorkflowDefinition> {
    let nodes_vec = serde_json::from_value(nodes.clone())
        .map_err(|e| AppError::InvalidQuery(format!("nodes 格式错误: {}", e)))?;
    let edges_vec = serde_json::from_value(edges.clone())
        .map_err(|e| AppError::InvalidQuery(format!("edges 格式错误: {}", e)))?;

    Ok(WorkflowDefinition {
        nodes: nodes_vec,
        edges: edges_vec,
    })
}

fn is_valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 64
        // 允许用 `/` 做分段（如 `public/kop-callback`）——HTTP Endpoint 触发路由
        // 用 `/workflow/:db/*workflow_slug` 通配捕获，多段 slug 可正常路由。
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '/')
        && !slug.starts_with('-')
        && !slug.ends_with('-')
        // `/` 不能出现在首尾，也不能连续（避免空段 / 与路由前缀混淆）。
        && !slug.starts_with('/')
        && !slug.ends_with('/')
        && !slug.contains("//")
}

/// 把任意字符串规整成合法 slug（小写字母 / 数字 / 连字符，<=64，不以连字符开头结尾）。
/// 给「复制 / 导入」用——源 slug 或导入文件里的 slug 不一定合法，先兜一道。
fn slugify(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else {
            out.push('-');
        }
    }
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    let out: String = out.trim_matches('-').chars().take(64).collect();
    let out = out.trim_matches('-').to_string();
    if out.is_empty() {
        "workflow".to_string()
    } else {
        out
    }
}

/// 在同一 `database_id` 作用域内生成唯一 slug（表上有 `UNIQUE(database_id, slug)`）。
/// 先试 `base`，冲突则追加 `-2`、`-3`…，并始终把总长截在 64 内。
async fn generate_unique_slug(
    pool: &PgPool,
    database_id: Option<i32>,
    base: &str,
) -> Result<String> {
    let base = slugify(base);
    for n in 1..=1000 {
        let candidate = if n == 1 {
            base.clone()
        } else {
            let suffix = format!("-{}", n);
            let keep = 64usize.saturating_sub(suffix.len());
            let trimmed: String = base.chars().take(keep).collect();
            format!("{}{}", trimmed.trim_end_matches('-'), suffix)
        };
        // database_id 为 NULL 时 UNIQUE 约束不生效（PG 多 NULL 视为不同），这里用
        // IS NOT DISTINCT FROM 把 NULL 也当作一个作用域，避免平台级工作流 slug 重名。
        let exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM management.workflows \
             WHERE database_id IS NOT DISTINCT FROM $1 AND slug = $2)",
        )
        .bind(database_id)
        .bind(&candidate)
        .fetch_one(pool)
        .await?;
        if !exists {
            return Ok(candidate);
        }
    }
    Err(AppError::InvalidQuery(
        "无法生成唯一 slug，请手动指定".to_string(),
    ))
}

/// 把 INSERT/UPDATE 撞 `UNIQUE(database_id, slug)`（SQLSTATE 23505）的库错翻译成
/// 人话，而不是走默认脱敏后变成「数据库结构异常」这种和实际原因无关的文案。
fn map_workflow_write_err(e: sqlx::Error) -> AppError {
    if let sqlx::Error::Database(ref db) = e {
        if db.code().as_deref() == Some("23505") {
            return AppError::InvalidQuery(
                "该数据库下已存在相同 slug 的工作流，请换一个 slug".to_string(),
            );
        }
    }
    AppError::Database(e)
}

// ─── 接口文档公开分享 ─────────────────────────────────
//
// 给工作流生成可开关的公开文档链接 `<origin>/doc/<token>`：
//  - 管理接口（登录态）：GET/POST /api/admin/workflows/:id/doc-share —— 读状态 / 开关分享；
//  - 公开接口（无鉴权）：GET /api/public/workflow-doc/:token —— 凭 token 取提炼后的文档数据。
//
// 公开接口只返回「文档必需」的字段（DocModel），不下发 nodes/edges，避免暴露节点内部配置。

/// 公开文档链接 token：`ds_` 前缀 + 24 字节随机 hex（共 51 字符，< VARCHAR(64)）。
/// 与 API Key（`cr_`/`crp_`）命名空间独立，泄露它不泄露任何调用凭证。
fn generate_doc_share_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let random_bytes: Vec<u8> = (0..24).map(|_| rng.gen()).collect();
    format!("ds_{}", hex::encode(random_bytes))
}

/// 从工作流当前定义提炼出「接口文档模型」（DocModel）。
///
/// 与前端 `deriveDocModel` 同一业务规则：`input_fields` 来自节点里 `{{trigger.X}}` 引用的
/// 自动扫描（复用 `mcp_tools::scan_trigger_fields`），`response_body`/`status_code` 取自
/// response 节点的 config。**不含** nodes/edges，供公开页面渲染。
fn build_doc_model(
    name: &str,
    description: Option<&str>,
    slug: &str,
    database_slug: Option<&str>,
    trigger_type: &str,
    trigger_config: &Value,
    timeout_ms: i32,
    nodes: &Value,
) -> Value {
    let mut input_fields = crate::mcp_tools::scan_trigger_fields(nodes);
    input_fields.sort();

    let response_node = nodes.as_array().and_then(|arr| {
        arr.iter()
            .find(|n| n.get("type").and_then(|t| t.as_str()) == Some("response"))
    });

    let (response_body, status_code, has_response_node) = match response_node {
        Some(n) => {
            let cfg = n.get("config");
            let body = cfg.and_then(|c| c.get("body")).and_then(|b| match b {
                Value::Null => None,
                Value::String(s) => Some(s.clone()),
                other => Some(serde_json::to_string_pretty(other).unwrap_or_default()),
            });
            let status = cfg
                .and_then(|c| c.get("status_code"))
                .and_then(|v| v.as_i64())
                .unwrap_or(200);
            (body, status, true)
        }
        None => (None, 200, false),
    };

    json!({
        "name": name,
        "description": description.unwrap_or(""),
        "slug": slug,
        "database_slug": database_slug.unwrap_or(""),
        "trigger_type": trigger_type,
        "trigger_config": trigger_config,
        "timeout_ms": timeout_ms,
        "input_fields": input_fields,
        "response_body": response_body,
        "status_code": status_code,
        "has_response_node": has_response_node,
    })
}

/// 统一的分享状态响应体：token / 开关 / 相对路径（完整 URL 由前端拼 origin）。
fn doc_share_response(token: Option<String>, enabled: bool) -> Value {
    let path = token.as_ref().map(|t| format!("/doc/{}", t));
    json!({
        "share_token": token,
        "share_enabled": enabled,
        "share_path": path,
    })
}

/// GET /api/admin/workflows/:id/doc-share —— 读当前分享状态。
pub async fn get_workflow_doc_share(
    State(pool): State<PgPool>,
    Path(id): Path<i32>,
    axum::Extension(claims): axum::Extension<Claims>,
) -> Result<Json<Value>> {
    // 复用 admin 鉴权：无权限直接 401/403。
    fetch_workflow_for_admin(&pool, &claims, id).await?;

    let row = sqlx::query(
        "SELECT doc_share_token, doc_share_enabled FROM management.workflows WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&pool)
    .await?;

    let token: Option<String> = row.get("doc_share_token");
    let enabled: bool = row.get("doc_share_enabled");
    Ok(Json(doc_share_response(token, enabled)))
}

#[derive(Debug, Deserialize)]
pub struct DocShareRequest {
    pub enabled: bool,
}

/// POST /api/admin/workflows/:id/doc-share —— 开关分享。
/// enabled=true：token 为空则生成一次（永久保留），并置 enabled=true；
/// enabled=false：仅置 enabled=false，token 保留（重开复用同一链接）。
pub async fn set_workflow_doc_share(
    State(pool): State<PgPool>,
    Path(id): Path<i32>,
    axum::Extension(claims): axum::Extension<Claims>,
    Json(req): Json<DocShareRequest>,
) -> Result<Json<Value>> {
    let wf = fetch_workflow_for_admin(&pool, &claims, id).await?;

    let row = if req.enabled {
        let token = generate_doc_share_token();
        sqlx::query(
            r#"UPDATE management.workflows
               SET doc_share_token = COALESCE(doc_share_token, $2), doc_share_enabled = true
               WHERE id = $1
               RETURNING doc_share_token, doc_share_enabled"#,
        )
        .bind(id)
        .bind(&token)
        .fetch_one(&pool)
        .await?
    } else {
        sqlx::query(
            r#"UPDATE management.workflows
               SET doc_share_enabled = false
               WHERE id = $1
               RETURNING doc_share_token, doc_share_enabled"#,
        )
        .bind(id)
        .fetch_one(&pool)
        .await?
    };

    let token: Option<String> = row.get("doc_share_token");
    let enabled: bool = row.get("doc_share_enabled");

    // 操作日志打点：开启/关闭公开文档分享链接。开启=对外暴露，标记高危。
    if let Some(tenant_id) = wf.tenant_id {
        let mut input = OperationLogInput::new(
            tenant_id,
            Actor::User {
                id: claims.sub,
                name: claims.email.clone(),
                role: None,
            },
            Source::Console,
            operation_log::action::UPDATE,
            format!(
                "{}工作流「{}」的公开文档分享链接",
                if req.enabled { "开启" } else { "关闭" },
                wf.name
            ),
            Status::Success,
        )
        .resource(
            operation_log::resource_type::WORKFLOW,
            wf.name.clone(),
            Some(wf.id.to_string()),
        )
        .detail(json!({ "doc_share_enabled": enabled, "slug": wf.slug }));
        if req.enabled {
            input.high_risk = Some(true);
        }
        operation_log::record(&pool, input);
    }

    Ok(Json(doc_share_response(token, enabled)))
}

/// GET /api/public/workflow-doc/:token —— 公开只读文档数据（无鉴权）。
/// 命中条件含 `doc_share_enabled = true`；未命中 / 已关闭 → 404（链接立即失效）。
pub async fn public_workflow_doc(
    headers: axum::http::HeaderMap,
    State(pool): State<PgPool>,
    Path(token): Path<String>,
) -> Result<Json<Value>> {
    let row = sqlx::query(
        r#"SELECT name, description, slug, database_id, tenant_id, trigger_type, trigger_config, timeout_ms, nodes
           FROM management.workflows
           WHERE doc_share_token = $1 AND doc_share_enabled = true"#,
    )
    .bind(&token)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound("链接不存在或已失效".to_string()))?;

    let name: String = row.get("name");
    let description: Option<String> = row.get("description");
    let slug: String = row.get("slug");
    let database_id: Option<i32> = row.get("database_id");
    // 项目(tenant)标识，用于解析项目级对外基址（项目级 > 平台全局）。
    let tenant_id: Option<i32> = row.try_get("tenant_id").ok();
    let trigger_type: String = row.get("trigger_type");
    let trigger_config: Value = row.get("trigger_config");
    let timeout_ms: i32 = row.get("timeout_ms");
    let nodes: Value = row.get("nodes");

    let database_slug: Option<String> = match database_id {
        Some(did) => {
            sqlx::query_scalar::<_, String>(
                "SELECT slug FROM management.tenant_databases WHERE id = $1",
            )
            .bind(did)
            .fetch_optional(&pool)
            .await?
        }
        None => None,
    };

    let mut model = build_doc_model(
        &name,
        description.as_deref(),
        &slug,
        database_slug.as_deref(),
        &trigger_type,
        &trigger_config,
        timeout_ms,
        &nodes,
    );
    // 注入对外调用基址（网关域名），供公开文档页在服务端就拿到正确地址，
    // 不再依赖访客浏览器 origin（可能是内网 IP:端口）。优先级：项目级 > 平台全局 > 环境变量 > 转发头。
    if let Some(obj) = model.as_object_mut() {
        obj.insert(
            "api_base_url".to_string(),
            Value::String(
                crate::public_base_settings::resolve_public_base(&pool, tenant_id, &headers).await,
            ),
        );
        // 走网关时接口文档隐藏 API Key 鉴权头（网关统一鉴权）。
        obj.insert(
            "gateway_mode".to_string(),
            Value::Bool(crate::public_base_settings::is_gateway_mode(&pool, tenant_id).await),
        );
    }
    Ok(Json(model))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apikey_write_guard_composition() {
        let ro = json!({ "read": true, "write": false, "delete": false });
        let rw = json!({ "read": true, "write": true, "delete": true });

        // mode=off：无论 key 如何都不拦。
        assert_eq!(
            apikey_write_guard_for(ApiKeyWriteGuard::Off, &[&ro]),
            ApiKeyWriteGuard::Off
        );

        // 无 key：不拦（维持现状）。
        assert_eq!(
            apikey_write_guard_for(ApiKeyWriteGuard::Enforce, &[]),
            ApiKeyWriteGuard::Off
        );

        // 读写 key：不拦。
        assert_eq!(
            apikey_write_guard_for(ApiKeyWriteGuard::Enforce, &[&rw]),
            ApiKeyWriteGuard::Off
        );

        // 只读 key + enforce：采用 enforce（真拦）。
        assert_eq!(
            apikey_write_guard_for(ApiKeyWriteGuard::Enforce, &[&ro]),
            ApiKeyWriteGuard::Enforce
        );

        // 只读 key + log_only：采用 log_only（不拦但记日志）。
        assert_eq!(
            apikey_write_guard_for(ApiKeyWriteGuard::LogOnly, &[&ro]),
            ApiKeyWriteGuard::LogOnly
        );
    }

    #[test]
    fn apikey_write_guard_takes_union_of_sources() {
        let ro = json!({ "read": true, "write": false, "delete": false });
        let rw = json!({ "read": true, "write": true, "delete": true });
        let empty = json!({});

        // 任一来源声明只读即生效——覆盖 `apikey: cr_只读key` + `Bearer <JWT>` 这条
        // 绕过路径（ApiKeyContext 缺席，只有 caller 侧解析出只读 key）。
        assert_eq!(
            apikey_write_guard_for(ApiKeyWriteGuard::Enforce, &[&rw, &ro]),
            ApiKeyWriteGuard::Enforce
        );
        assert_eq!(
            apikey_write_guard_for(ApiKeyWriteGuard::Enforce, &[&ro, &rw]),
            ApiKeyWriteGuard::Enforce
        );

        // 全是读写才放行。
        assert_eq!(
            apikey_write_guard_for(ApiKeyWriteGuard::Enforce, &[&rw, &rw]),
            ApiKeyWriteGuard::Off
        );

        // 空 permissions 走 fail-open，不因「判不出来」就拦掉存量 key。
        assert_eq!(
            apikey_write_guard_for(ApiKeyWriteGuard::Enforce, &[&empty]),
            ApiKeyWriteGuard::Off
        );
        // 但同一请求里另有来源显式声明只读时，仍然拦。
        assert_eq!(
            apikey_write_guard_for(ApiKeyWriteGuard::Enforce, &[&empty, &ro]),
            ApiKeyWriteGuard::Enforce
        );
    }

    #[test]
    fn api_key_readonly_block_marker_is_recognized() {
        let err = workflow_engine::api_key_readonly_block_error("save", "db_execute").to_string();
        assert!(is_api_key_readonly_block(&err));
        // 普通节点错误不得被误判成 403。
        assert!(!is_api_key_readonly_block("db_execute 节点执行失败: 连接超时"));
        assert!(!is_api_key_readonly_block(""));
    }
}

#[cfg(test)]
mod op_log_diff_tests {
    use super::*;

    #[test]
    fn diff_detects_add_modify_remove_nodes_and_edges() {
        let old_nodes = json!([
            { "id": "n1", "type": "db_query", "config": { "timeout_ms": 5000 } },
            { "id": "n2", "type": "http_call", "config": {} }
        ]);
        let old_edges = json!([{ "from": "n1", "to": "n2" }]);
        let new_nodes = json!([
            { "id": "n1", "type": "db_query", "config": { "timeout_ms": 8000 } },
            { "id": "n3", "type": "condition", "config": {} }
        ]);
        let new_edges = json!([{ "from": "n1", "to": "n3" }]);

        let change = diff_definition(&old_nodes, &old_edges, &new_nodes, &new_edges)
            .expect("有变更应产出 change");
        assert_eq!(change["kind"], "modified");
        assert_eq!(change["v"], 1);

        // 新增节点 n3 + 新增连线 n1->n3
        let added = change["added"].as_array().unwrap();
        assert!(added.iter().any(|x| x["node"] == "n3"));
        assert!(added.iter().any(|x| x["edge"] == "n1 -> n3"));

        // 删除节点 n2 + 删除连线 n1->n2
        let removed = change["removed"].as_array().unwrap();
        assert!(removed.iter().any(|x| x["node"] == "n2"));
        assert!(removed.iter().any(|x| x["edge"] == "n1 -> n2"));

        // 修改 n1 的 config.timeout_ms 5000 -> 8000
        let modified = change["modified"].as_array().unwrap();
        let m = modified
            .iter()
            .find(|x| x["node"] == "n1" && x["field"] == "timeout_ms")
            .expect("应捕获 timeout_ms 变更");
        assert_eq!(m["old"], "5000");
        assert_eq!(m["new"], "8000");
    }

    #[test]
    fn diff_no_change_returns_none() {
        let nodes = json!([{ "id": "n1", "type": "code", "config": { "x": 1 } }]);
        let edges = json!([]);
        assert!(diff_definition(&nodes, &edges, &nodes, &edges).is_none());
    }

    #[test]
    fn diff_ignores_pure_position_moves() {
        // 仅画布坐标 _position 变化（挪动节点）→ 不应产生任何变更内容。
        let old = json!([{ "id": "main", "type": "code", "config": {}, "_position": { "x": 300, "y": 60 } }]);
        let new = json!([{ "id": "main", "type": "code", "config": {}, "_position": { "x": 320, "y": 60 } }]);
        let edges = json!([]);
        assert!(diff_definition(&old, &edges, &new, &edges).is_none());

        // 但真实字段变化仍然要被捕获（坐标同时变了也不影响）。
        let new2 = json!([{ "id": "main", "type": "code", "config": { "timeout_ms": 8000 }, "_position": { "x": 999, "y": 1 } }]);
        let old2 = json!([{ "id": "main", "type": "code", "config": { "timeout_ms": 5000 }, "_position": { "x": 300, "y": 60 } }]);
        let change = diff_definition(&old2, &edges, &new2, &edges).expect("timeout 改动应被捕获");
        let modified = change["modified"].as_array().unwrap();
        assert_eq!(modified.len(), 1);
        assert_eq!(modified[0]["field"], "timeout_ms");
        assert!(!modified.iter().any(|m| m["field"] == "_position"));
    }
}
