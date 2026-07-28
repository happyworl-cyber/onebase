use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Instant;

use crate::error::{AppError, Result};

// ─── DAG 数据模型 ─────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowDefinition {
    pub nodes: Vec<WorkflowNode>,
    pub edges: Vec<WorkflowEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: NodeType,
    pub label: Option<String>,
    pub config: JsonValue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeType {
    Code,
    DbQuery,
    DbExecute,
    HttpCall,
    Condition,
    Transform,
    Response,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowEdge {
    pub from: String,
    pub to: String,
    /// condition 节点使用：当 from 节点求值结果匹配此分支标签时走这条边
    pub branch: Option<String>,
}

// ─── 执行上下文 ─────────────────────────────────────────

/// 单次工作流执行的运行时上下文
#[derive(Debug, Clone)]
pub struct ExecutionContext {
    pub workflow_id: i32,
    pub run_id: i64,
    pub trigger_type: String,
    pub trigger_data: JsonValue,
    pub user_id: Option<i32>,
    pub tenant_id: Option<i32>,
    pub database_id: Option<i32>,
    /// 每个已执行节点的输出，key = node_id
    pub node_outputs: HashMap<String, JsonValue>,
}

/// 单个节点的执行结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeExecutionResult {
    pub node_id: String,
    pub status: NodeStatus,
    pub output: JsonValue,
    pub elapsed_ms: u64,
    pub error: Option<String>,
    /// condition 节点使用：选中的分支标签
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeStatus {
    Success,
    Failed,
    Skipped,
}

// ─── 模板变量引擎 ─────────────────────────────────────────

/// 解析并替换 `{{nodeId.field}}` 模板变量
///
/// 支持嵌套路径：`{{nodeA.data.items[0].name}}`
pub fn resolve_template(template: &JsonValue, ctx: &ExecutionContext) -> JsonValue {
    match template {
        JsonValue::String(s) => resolve_string_template(s, ctx),
        JsonValue::Object(map) => {
            let mut new_map = serde_json::Map::new();
            for (k, v) in map {
                new_map.insert(k.clone(), resolve_template(v, ctx));
            }
            JsonValue::Object(new_map)
        }
        JsonValue::Array(arr) => {
            JsonValue::Array(arr.iter().map(|v| resolve_template(v, ctx)).collect())
        }
        other => other.clone(),
    }
}

fn resolve_string_template(s: &str, ctx: &ExecutionContext) -> JsonValue {
    // 如果整个字符串就是一个模板表达式，返回原始类型（不强制 string）
    let trimmed = s.trim();
    if trimmed.starts_with("{{") && trimmed.ends_with("}}") && trimmed.matches("{{").count() == 1 {
        let path = trimmed[2..trimmed.len() - 2].trim();
        return resolve_path(path, ctx);
    }

    // 混合模式：字符串中嵌入多个 {{...}}，全部替换为字符串
    let mut result = s.to_string();
    while let Some(start) = result.find("{{") {
        if let Some(end) = result[start..].find("}}") {
            let full_end = start + end + 2;
            let path = result[start + 2..start + end].trim();
            let val = resolve_path(path, ctx);
            let replacement = match &val {
                JsonValue::String(s) => s.clone(),
                JsonValue::Null => "".to_string(),
                other => other.to_string(),
            };
            result.replace_range(start..full_end, &replacement);
        } else {
            break;
        }
    }
    JsonValue::String(result)
}

fn resolve_path(path: &str, ctx: &ExecutionContext) -> JsonValue {
    // 特殊前缀
    if path.starts_with("trigger.") {
        return json_path_lookup(&ctx.trigger_data, &path["trigger.".len()..]);
    }
    if path == "trigger" {
        return ctx.trigger_data.clone();
    }

    // nodeId.field 格式
    let (node_id, field_path) = match path.find('.') {
        Some(pos) => (&path[..pos], &path[pos + 1..]),
        None => {
            return ctx.node_outputs.get(path).cloned().unwrap_or(JsonValue::Null);
        }
    };

    match ctx.node_outputs.get(node_id) {
        Some(output) => json_path_lookup(output, field_path),
        None => JsonValue::Null,
    }
}

/// 简易 JSON 路径查找：支持 `a.b.c` 和 `a[0].b` 格式
fn json_path_lookup(value: &JsonValue, path: &str) -> JsonValue {
    let mut current = value;
    for segment in PathSegmentIter::new(path) {
        match segment {
            PathSegment::Key(key) => {
                current = match current.get(key) {
                    Some(v) => v,
                    None => return JsonValue::Null,
                };
            }
            PathSegment::Index(idx) => {
                current = match current.get(idx) {
                    Some(v) => v,
                    None => return JsonValue::Null,
                };
            }
        }
    }
    current.clone()
}

enum PathSegment<'a> {
    Key(&'a str),
    Index(usize),
}

struct PathSegmentIter<'a> {
    remaining: &'a str,
}

impl<'a> PathSegmentIter<'a> {
    fn new(path: &'a str) -> Self {
        Self { remaining: path }
    }
}

impl<'a> Iterator for PathSegmentIter<'a> {
    type Item = PathSegment<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.remaining.is_empty() {
            return None;
        }

        // 处理数组索引 `[N]`
        if self.remaining.starts_with('[') {
            if let Some(end) = self.remaining.find(']') {
                let idx_str = &self.remaining[1..end];
                self.remaining = &self.remaining[end + 1..];
                if self.remaining.starts_with('.') {
                    self.remaining = &self.remaining[1..];
                }
                if let Ok(idx) = idx_str.parse::<usize>() {
                    return Some(PathSegment::Index(idx));
                }
            }
        }

        // 处理 key 段
        let (key, rest) = match self.remaining.find(|c| c == '.' || c == '[') {
            Some(pos) => {
                let key = &self.remaining[..pos];
                let rest = if self.remaining.as_bytes()[pos] == b'.' {
                    &self.remaining[pos + 1..]
                } else {
                    &self.remaining[pos..]
                };
                (key, rest)
            }
            None => (self.remaining, ""),
        };
        self.remaining = rest;
        if key.is_empty() {
            self.next()
        } else {
            Some(PathSegment::Key(key))
        }
    }
}

// ─── DAG 拓扑排序 ─────────────────────────────────────────

/// 对 DAG 执行拓扑排序，返回按依赖顺序排列的节点 ID 列表。
/// 如果图存在环，返回错误。
pub fn topological_sort(def: &WorkflowDefinition) -> Result<Vec<String>> {
    let mut in_degree: HashMap<&str, usize> = HashMap::new();
    let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();

    for node in &def.nodes {
        in_degree.entry(node.id.as_str()).or_insert(0);
        adjacency.entry(node.id.as_str()).or_default();
    }

    for edge in &def.edges {
        adjacency.entry(edge.from.as_str()).or_default().push(edge.to.as_str());
        *in_degree.entry(edge.to.as_str()).or_insert(0) += 1;
    }

    let mut queue: VecDeque<&str> = in_degree
        .iter()
        .filter(|(_, &deg)| deg == 0)
        .map(|(&id, _)| id)
        .collect();

    let mut sorted = Vec::with_capacity(def.nodes.len());

    while let Some(node_id) = queue.pop_front() {
        sorted.push(node_id.to_string());
        if let Some(neighbors) = adjacency.get(node_id) {
            for &neighbor in neighbors {
                if let Some(deg) = in_degree.get_mut(neighbor) {
                    *deg -= 1;
                    if *deg == 0 {
                        queue.push_back(neighbor);
                    }
                }
            }
        }
    }

    if sorted.len() != def.nodes.len() {
        return Err(AppError::InvalidQuery(
            "工作流 DAG 包含循环依赖，无法执行".to_string(),
        ));
    }

    Ok(sorted)
}

/// 获取 condition 节点在给定 branch 下的后继节点 ID 集合
fn get_branch_successors(def: &WorkflowDefinition, node_id: &str, branch: &str) -> HashSet<String> {
    def.edges
        .iter()
        .filter(|e| e.from == node_id && e.branch.as_deref() == Some(branch))
        .map(|e| e.to.clone())
        .collect()
}

/// 获取某节点的所有无条件后继（branch == None 的边）
#[allow(dead_code)]
fn get_default_successors(def: &WorkflowDefinition, node_id: &str) -> HashSet<String> {
    def.edges
        .iter()
        .filter(|e| e.from == node_id && e.branch.is_none())
        .map(|e| e.to.clone())
        .collect()
}

// ─── DAG 执行引擎 ─────────────────────────────────────────

/// 工作流 DAG 引擎：按拓扑顺序调度各节点
pub struct DagEngine {
    pool: PgPool,
}

impl DagEngine {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// 执行整个工作流 DAG
    pub async fn execute(
        &self,
        def: &WorkflowDefinition,
        ctx: &mut ExecutionContext,
    ) -> Result<Vec<NodeExecutionResult>> {
        let sorted = topological_sort(def)?;
        let node_map: HashMap<&str, &WorkflowNode> = def
            .nodes
            .iter()
            .map(|n| (n.id.as_str(), n))
            .collect();

        let mut results: Vec<NodeExecutionResult> = Vec::new();
        let mut skipped: HashSet<String> = HashSet::new();

        for node_id in &sorted {
            // 跳过被 condition 排除的分支节点
            if skipped.contains(node_id.as_str()) {
                results.push(NodeExecutionResult {
                    node_id: node_id.clone(),
                    status: NodeStatus::Skipped,
                    output: JsonValue::Null,
                    elapsed_ms: 0,
                    error: None,
                    branch: None,
                });
                continue;
            }

            let node = match node_map.get(node_id.as_str()) {
                Some(n) => *n,
                None => continue,
            };

            let config = resolve_template(&node.config, ctx);
            let start = Instant::now();

            let exec_result = self.execute_node(node, &config, ctx).await;
            let elapsed_ms = start.elapsed().as_millis() as u64;

            match exec_result {
                Ok((output, branch)) => {
                    ctx.node_outputs.insert(node_id.clone(), output.clone());
                    // 同时以 label 作为别名存储，方便 Lua 用 ctx.nodes.label_name 引用
                    if let Some(label) = node.label.as_ref().filter(|l| !l.is_empty() && *l != node_id) {
                        ctx.node_outputs.insert(label.clone(), output.clone());
                    }

                    // condition 节点：根据选中分支标记需要跳过的路径
                    if node.node_type == NodeType::Condition {
                        if let Some(ref chosen_branch) = branch {
                            let allowed = get_branch_successors(def, node_id, chosen_branch);
                            let all_successors: HashSet<String> = def.edges
                                .iter()
                                .filter(|e| e.from == *node_id && e.branch.is_some())
                                .map(|e| e.to.clone())
                                .collect();
                            for s in all_successors.difference(&allowed) {
                                mark_reachable_as_skipped(def, s, &mut skipped);
                            }
                        }
                    }

                    results.push(NodeExecutionResult {
                        node_id: node_id.clone(),
                        status: NodeStatus::Success,
                        output,
                        elapsed_ms,
                        error: None,
                        branch,
                    });
                }
                Err(e) => {
                    let err_msg = e.to_string();
                    results.push(NodeExecutionResult {
                        node_id: node_id.clone(),
                        status: NodeStatus::Failed,
                        output: JsonValue::Null,
                        elapsed_ms,
                        error: Some(err_msg.clone()),
                        branch: None,
                    });

                    // response 节点失败不中断（只是最终响应丢失）
                    if node.node_type != NodeType::Response {
                        return Ok(results);
                    }
                }
            }
        }

        Ok(results)
    }

    /// 执行单个节点，返回 (output, optional_branch)
    async fn execute_node(
        &self,
        node: &WorkflowNode,
        config: &JsonValue,
        ctx: &ExecutionContext,
    ) -> Result<(JsonValue, Option<String>)> {
        match node.node_type {
            NodeType::Code => self.exec_code_node(config, ctx).await,
            NodeType::DbQuery => self.exec_db_query_node(config, ctx).await,
            NodeType::DbExecute => self.exec_db_execute_node(config, ctx).await,
            NodeType::HttpCall => self.exec_http_call_node(config).await,
            NodeType::Condition => self.exec_condition_node(config, ctx).await,
            NodeType::Transform => self.exec_transform_node(config, ctx).await,
            NodeType::Response => self.exec_response_node(config, ctx).await,
        }
    }

    // ─── Code 节点 ─────────────────────────────────────────

    async fn exec_code_node(
        &self,
        config: &JsonValue,
        ctx: &ExecutionContext,
    ) -> Result<(JsonValue, Option<String>)> {
        use crate::lua_engine::{LuaEngine, PluginContext};

        let code = config
            .get("code")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::InvalidQuery("code 节点缺少 code 字段".to_string()))?;

        let plugin_ctx = PluginContext {
            method: "WORKFLOW".to_string(),
            path: format!("/workflow/{}", ctx.workflow_id),
            schema: None,
            table: None,
            body: Some(ctx.trigger_data.clone()),
            query_params: None,
            headers: None,
            user_id: ctx.user_id,
            tenant_id: ctx.tenant_id,
            database_id: ctx.database_id,
            request_id: Some(format!("wf-run-{}", ctx.run_id)),
        };

        // 将所有上游节点输出注入 ctx.nodes
        let nodes_json: JsonValue = ctx.node_outputs.clone().into_iter().collect();
        let nodes_str = serde_json::to_string(&nodes_json).unwrap_or_default();
        let wrapped_code = format!(
            "local _nodes = json.decode([==[{}]==])\nctx.nodes = _nodes\n{}",
            nodes_str,
            code
        );

        let engine = LuaEngine::new(1, 30_000, 32 * 1024 * 1024);
        let result = engine
            .execute_plugin(&wrapped_code, "execute", &plugin_ctx)
            .await
            .map_err(|e| AppError::Internal(format!("Lua 执行失败: {}", e)))?;

        let output = result
            .modified_body
            .or(result.response_body)
            .unwrap_or(JsonValue::Null);
        Ok((output, None))
    }

    // ─── DB Query 节点（只读） ─────────────────────────────────────────

    async fn exec_db_query_node(
        &self,
        config: &JsonValue,
        _ctx: &ExecutionContext,
    ) -> Result<(JsonValue, Option<String>)> {
        let sql = config
            .get("sql")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::InvalidQuery("db_query 节点缺少 sql 字段".to_string()))?;

        // 安全检查：只允许 SELECT / WITH
        let first_word = sql.trim().split_whitespace().next().unwrap_or("").to_uppercase();
        if !matches!(first_word.as_str(), "SELECT" | "WITH") {
            return Err(AppError::InvalidQuery(
                "db_query 节点只允许 SELECT/WITH 语句".to_string(),
            ));
        }

        let params = config.get("params").and_then(|v| v.as_array());

        let mut query = sqlx::query(sql);
        if let Some(params) = params {
            for p in params {
                query = bind_json_param(query, p);
            }
        }

        let rows = query.fetch_all(&self.pool).await?;
        let results: Vec<JsonValue> = rows.iter().map(pg_row_to_json).collect();

        Ok((json!({ "rows": results, "count": results.len() }), None))
    }

    // ─── DB Execute 节点（写操作） ─────────────────────────────────────────

    async fn exec_db_execute_node(
        &self,
        config: &JsonValue,
        _ctx: &ExecutionContext,
    ) -> Result<(JsonValue, Option<String>)> {
        let sql = config
            .get("sql")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::InvalidQuery("db_execute 节点缺少 sql 字段".to_string()))?;

        // DDL 拦截
        let first_word = sql.trim().split_whitespace().next().unwrap_or("").to_uppercase();
        if matches!(first_word.as_str(), "DROP" | "TRUNCATE") {
            return Err(AppError::InvalidQuery(
                "db_execute 节点禁止 DROP/TRUNCATE 操作".to_string(),
            ));
        }

        let params = config.get("params").and_then(|v| v.as_array());
        let mut query = sqlx::query(sql);
        if let Some(params) = params {
            for p in params {
                query = bind_json_param(query, p);
            }
        }

        let result = query.execute(&self.pool).await?;
        Ok((
            json!({ "rows_affected": result.rows_affected() }),
            None,
        ))
    }

    // ─── HTTP Call 节点 ─────────────────────────────────────────

    async fn exec_http_call_node(
        &self,
        config: &JsonValue,
    ) -> Result<(JsonValue, Option<String>)> {
        let url = config
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::InvalidQuery("http_call 节点缺少 url 字段".to_string()))?;

        let method = config
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("GET")
            .to_uppercase();

        // 内网黑名单
        if is_private_url(url) {
            return Err(AppError::InvalidQuery(
                "http_call 不允许访问内网地址".to_string(),
            ));
        }

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| AppError::Internal(format!("HTTP 客户端创建失败: {}", e)))?;

        let mut req = match method.as_str() {
            "POST" => client.post(url),
            "PUT" => client.put(url),
            "PATCH" => client.patch(url),
            "DELETE" => client.delete(url),
            _ => client.get(url),
        };

        if let Some(headers) = config.get("headers").and_then(|v| v.as_object()) {
            for (k, v) in headers {
                if let Some(val) = v.as_str() {
                    req = req.header(k.as_str(), val);
                }
            }
        }

        if let Some(body) = config.get("body") {
            req = req.json(body);
        }

        let resp = req
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("HTTP 请求失败: {}", e)))?;

        let status = resp.status().as_u16();
        let resp_headers: HashMap<String, String> = resp
            .headers()
            .iter()
            .filter_map(|(k, v)| Some((k.to_string(), v.to_str().ok()?.to_string())))
            .collect();

        let body_text = resp
            .text()
            .await
            .map_err(|e| AppError::Internal(format!("读取响应失败: {}", e)))?;

        let body_json: JsonValue = serde_json::from_str(&body_text).unwrap_or(json!(body_text));

        Ok((
            json!({
                "status": status,
                "headers": resp_headers,
                "body": body_json,
            }),
            None,
        ))
    }

    // ─── Condition 节点 ─────────────────────────────────────────

    async fn exec_condition_node(
        &self,
        config: &JsonValue,
        ctx: &ExecutionContext,
    ) -> Result<(JsonValue, Option<String>)> {
        let conditions = config
            .get("conditions")
            .and_then(|v| v.as_array())
            .ok_or_else(|| {
                AppError::InvalidQuery("condition 节点缺少 conditions 数组".to_string())
            })?;

        for cond in conditions {
            let branch = cond.get("branch").and_then(|v| v.as_str()).unwrap_or("default");
            let expr = cond.get("expression").and_then(|v| v.as_str()).unwrap_or("");

            if evaluate_expression(expr, ctx) {
                return Ok((
                    json!({ "matched_branch": branch }),
                    Some(branch.to_string()),
                ));
            }
        }

        // 未匹配任何条件，走 default
        let default_branch = config
            .get("default_branch")
            .and_then(|v| v.as_str())
            .unwrap_or("default");

        Ok((
            json!({ "matched_branch": default_branch }),
            Some(default_branch.to_string()),
        ))
    }

    // ─── Transform 节点 ─────────────────────────────────────────

    async fn exec_transform_node(
        &self,
        config: &JsonValue,
        _ctx: &ExecutionContext,
    ) -> Result<(JsonValue, Option<String>)> {
        // transform 节点的 config 就是输出模板，模板变量在外层 resolve_template 已处理
        let output = config.get("output").cloned().unwrap_or_else(|| config.clone());
        Ok((output, None))
    }

    // ─── Response 节点 ─────────────────────────────────────────

    async fn exec_response_node(
        &self,
        config: &JsonValue,
        _ctx: &ExecutionContext,
    ) -> Result<(JsonValue, Option<String>)> {
        let status_code = config
            .get("status_code")
            .and_then(|v| v.as_u64())
            .unwrap_or(200) as u16;

        let body = config.get("body").cloned().unwrap_or(JsonValue::Null);
        let headers = config.get("headers").cloned().unwrap_or(json!({}));

        Ok((
            json!({
                "status_code": status_code,
                "body": body,
                "headers": headers,
            }),
            None,
        ))
    }
}

// ─── 辅助函数 ─────────────────────────────────────────

/// 递归标记从某节点可达的所有节点为 skipped
fn mark_reachable_as_skipped(
    def: &WorkflowDefinition,
    start: &str,
    skipped: &mut HashSet<String>,
) {
    if !skipped.insert(start.to_string()) {
        return;
    }
    for edge in &def.edges {
        if edge.from == start {
            mark_reachable_as_skipped(def, &edge.to, skipped);
        }
    }
}

/// 判断 URL 是否指向内网地址
fn is_private_url(url: &str) -> bool {
    let host = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .and_then(|s| s.split('/').next())
        .and_then(|s| s.split(':').next())
        .unwrap_or("");

    if host == "localhost" || host == "127.0.0.1" || host == "::1" {
        return true;
    }

    if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        return ip.is_private() || ip.is_loopback() || ip.is_link_local();
    }

    // 10.x.x.x, 172.16-31.x.x, 192.168.x.x 已在 is_private() 覆盖
    host.ends_with(".local") || host.ends_with(".internal")
}

/// 简易条件表达式求值
///
/// 支持格式：
/// - `{{nodeA.field}} == "value"`
/// - `{{nodeA.count}} > 0`
/// - `true` / `false`
fn evaluate_expression(expr: &str, ctx: &ExecutionContext) -> bool {
    let expr = expr.trim();

    if expr == "true" || expr == "always" {
        return true;
    }
    if expr == "false" || expr == "never" {
        return false;
    }

    // 解析操作符
    let operators = ["==", "!=", ">=", "<=", ">", "<"];
    for op in &operators {
        if let Some(pos) = expr.find(op) {
            let left_raw = expr[..pos].trim();
            let right_raw = expr[pos + op.len()..].trim();

            let left_val = resolve_expr_value(left_raw, ctx);
            let right_val = resolve_expr_value(right_raw, ctx);

            return match *op {
                "==" => json_eq(&left_val, &right_val),
                "!=" => !json_eq(&left_val, &right_val),
                ">" => json_cmp(&left_val, &right_val) == Some(std::cmp::Ordering::Greater),
                "<" => json_cmp(&left_val, &right_val) == Some(std::cmp::Ordering::Less),
                ">=" => json_cmp(&left_val, &right_val).map(|o| o != std::cmp::Ordering::Less).unwrap_or(false),
                "<=" => json_cmp(&left_val, &right_val).map(|o| o != std::cmp::Ordering::Greater).unwrap_or(false),
                _ => false,
            };
        }
    }

    // 单值 truthy 判断
    let val = resolve_expr_value(expr, ctx);
    json_is_truthy(&val)
}

fn resolve_expr_value(raw: &str, ctx: &ExecutionContext) -> JsonValue {
    let raw = raw.trim();

    // 模板变量
    if raw.starts_with("{{") && raw.ends_with("}}") {
        let path = raw[2..raw.len() - 2].trim();
        return resolve_path(path, ctx);
    }

    // 字符串字面量
    if (raw.starts_with('"') && raw.ends_with('"'))
        || (raw.starts_with('\'') && raw.ends_with('\''))
    {
        return JsonValue::String(raw[1..raw.len() - 1].to_string());
    }

    // 数字
    if let Ok(n) = raw.parse::<i64>() {
        return json!(n);
    }
    if let Ok(n) = raw.parse::<f64>() {
        return json!(n);
    }

    // 布尔
    if raw == "true" {
        return JsonValue::Bool(true);
    }
    if raw == "false" {
        return JsonValue::Bool(false);
    }
    if raw == "null" || raw == "nil" {
        return JsonValue::Null;
    }

    JsonValue::String(raw.to_string())
}

fn json_eq(a: &JsonValue, b: &JsonValue) -> bool {
    a == b
}

fn json_cmp(a: &JsonValue, b: &JsonValue) -> Option<std::cmp::Ordering> {
    match (a.as_f64(), b.as_f64()) {
        (Some(a), Some(b)) => a.partial_cmp(&b),
        _ => None,
    }
}

fn json_is_truthy(val: &JsonValue) -> bool {
    match val {
        JsonValue::Null => false,
        JsonValue::Bool(b) => *b,
        JsonValue::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        JsonValue::String(s) => !s.is_empty(),
        JsonValue::Array(a) => !a.is_empty(),
        JsonValue::Object(_) => true,
    }
}

/// 将 JSON 值绑定到 sqlx 查询参数
fn bind_json_param<'q>(
    query: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    val: &'q JsonValue,
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    match val {
        JsonValue::Null => query.bind(None::<String>),
        JsonValue::Bool(b) => query.bind(*b),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                query.bind(i)
            } else {
                query.bind(n.as_f64().unwrap_or(0.0))
            }
        }
        JsonValue::String(s) => query.bind(s.as_str()),
        _ => query.bind(val.to_string()),
    }
}

/// 将 PgRow 转为 JSON object
fn pg_row_to_json(row: &sqlx::postgres::PgRow) -> JsonValue {
    use sqlx::{Column, Row};
    let mut obj = serde_json::Map::new();
    for col in row.columns() {
        let key = col.name().to_string();
        let idx = col.ordinal();
        let val: JsonValue = if let Ok(v) = row.try_get::<String, _>(idx) {
            JsonValue::String(v)
        } else if let Ok(v) = row.try_get::<i32, _>(idx) {
            json!(v)
        } else if let Ok(v) = row.try_get::<i64, _>(idx) {
            json!(v)
        } else if let Ok(v) = row.try_get::<f64, _>(idx) {
            json!(v)
        } else if let Ok(v) = row.try_get::<bool, _>(idx) {
            JsonValue::Bool(v)
        } else if let Ok(v) = row.try_get::<JsonValue, _>(idx) {
            v
        } else if let Ok(v) = row.try_get::<Option<String>, _>(idx) {
            v.map(JsonValue::String).unwrap_or(JsonValue::Null)
        } else {
            JsonValue::Null
        };
        obj.insert(key, val);
    }
    JsonValue::Object(obj)
}

// ─── 验证 ─────────────────────────────────────────

/// 验证 WorkflowDefinition 结构是否合法
pub fn validate_definition(def: &WorkflowDefinition) -> Result<()> {
    if def.nodes.is_empty() {
        return Err(AppError::InvalidQuery("工作流至少需要一个节点".to_string()));
    }

    let node_ids: HashSet<&str> = def.nodes.iter().map(|n| n.id.as_str()).collect();
    if node_ids.len() != def.nodes.len() {
        return Err(AppError::InvalidQuery("工作流节点 ID 存在重复".to_string()));
    }

    for edge in &def.edges {
        if !node_ids.contains(edge.from.as_str()) {
            return Err(AppError::InvalidQuery(format!(
                "边引用了不存在的源节点: {}",
                edge.from
            )));
        }
        if !node_ids.contains(edge.to.as_str()) {
            return Err(AppError::InvalidQuery(format!(
                "边引用了不存在的目标节点: {}",
                edge.to
            )));
        }
    }

    // 检测是否有环
    topological_sort(def)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_topological_sort_simple() {
        let def = WorkflowDefinition {
            nodes: vec![
                WorkflowNode { id: "a".into(), node_type: NodeType::Code, label: None, config: json!({}) },
                WorkflowNode { id: "b".into(), node_type: NodeType::Code, label: None, config: json!({}) },
                WorkflowNode { id: "c".into(), node_type: NodeType::Code, label: None, config: json!({}) },
            ],
            edges: vec![
                WorkflowEdge { from: "a".into(), to: "b".into(), branch: None },
                WorkflowEdge { from: "b".into(), to: "c".into(), branch: None },
            ],
        };
        let result = topological_sort(&def).unwrap();
        assert_eq!(result, vec!["a", "b", "c"]);
    }

    #[test]
    fn test_topological_sort_cycle_detected() {
        let def = WorkflowDefinition {
            nodes: vec![
                WorkflowNode { id: "a".into(), node_type: NodeType::Code, label: None, config: json!({}) },
                WorkflowNode { id: "b".into(), node_type: NodeType::Code, label: None, config: json!({}) },
            ],
            edges: vec![
                WorkflowEdge { from: "a".into(), to: "b".into(), branch: None },
                WorkflowEdge { from: "b".into(), to: "a".into(), branch: None },
            ],
        };
        assert!(topological_sort(&def).is_err());
    }

    #[test]
    fn test_template_resolution() {
        let mut ctx = ExecutionContext {
            workflow_id: 1,
            run_id: 1,
            trigger_type: "endpoint".into(),
            trigger_data: json!({"name": "test", "items": [1, 2, 3]}),
            user_id: Some(1),
            tenant_id: Some(1),
            database_id: Some(1),
            node_outputs: HashMap::new(),
        };
        ctx.node_outputs.insert("fetch".to_string(), json!({"count": 42, "data": {"id": 7}}));

        assert_eq!(
            resolve_template(&json!("{{trigger.name}}"), &ctx),
            json!("test")
        );
        assert_eq!(
            resolve_template(&json!("{{fetch.count}}"), &ctx),
            json!(42)
        );
        assert_eq!(
            resolve_template(&json!("{{fetch.data.id}}"), &ctx),
            json!(7)
        );
        assert_eq!(
            resolve_template(&json!("{{trigger.items[1]}}"), &ctx),
            json!(2)
        );
        assert_eq!(
            resolve_template(&json!("Hello {{trigger.name}}!"), &ctx),
            json!("Hello test!")
        );
    }

    #[test]
    fn test_condition_evaluation() {
        let mut ctx = ExecutionContext {
            workflow_id: 1,
            run_id: 1,
            trigger_type: "endpoint".into(),
            trigger_data: json!({"action": "create"}),
            user_id: Some(1),
            tenant_id: Some(1),
            database_id: Some(1),
            node_outputs: HashMap::new(),
        };
        ctx.node_outputs.insert("check".to_string(), json!({"count": 5}));

        assert!(evaluate_expression("{{trigger.action}} == \"create\"", &ctx));
        assert!(!evaluate_expression("{{trigger.action}} == \"delete\"", &ctx));
        assert!(evaluate_expression("{{check.count}} > 0", &ctx));
        assert!(!evaluate_expression("{{check.count}} > 10", &ctx));
        assert!(evaluate_expression("true", &ctx));
        assert!(!evaluate_expression("false", &ctx));
    }
}
