use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::collections::HashMap;

use crate::auth::Claims;
use crate::error::{AppError, Result};
use crate::workflow_engine::{
    self, DagEngine, ExecutionContext, NodeExecutionResult, NodeStatus, WorkflowDefinition,
};

// ─── 数据模型 ─────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Workflow {
    pub id: i32,
    pub tenant_id: Option<i32>,
    pub database_id: Option<i32>,
    pub name: String,
    pub slug: String,
    pub description: Option<String>,
    pub trigger_type: String,
    pub trigger_config: Value,
    pub nodes: Value,
    pub edges: Value,
    pub is_enabled: bool,
    pub timeout_ms: i32,
    pub max_retries: i32,
    pub created_by: Option<i32>,
    pub created_at: chrono::NaiveDateTime,
    pub updated_at: chrono::NaiveDateTime,
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
    pub started_at: chrono::NaiveDateTime,
    pub completed_at: Option<chrono::NaiveDateTime>,
}

#[derive(Debug, Deserialize)]
pub struct CreateWorkflowRequest {
    pub name: String,
    pub slug: String,
    pub description: Option<String>,
    pub database_id: Option<i32>,
    pub trigger_type: Option<String>,
    pub trigger_config: Option<Value>,
    pub nodes: Value,
    pub edges: Value,
    pub is_enabled: Option<bool>,
    pub timeout_ms: Option<i32>,
    pub max_retries: Option<i32>,
    pub tenant_id: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateWorkflowRequest {
    pub name: Option<String>,
    pub slug: Option<String>,
    pub description: Option<String>,
    pub database_id: Option<i32>,
    pub trigger_type: Option<String>,
    pub trigger_config: Option<Value>,
    pub nodes: Option<Value>,
    pub edges: Option<Value>,
    pub is_enabled: Option<bool>,
    pub timeout_ms: Option<i32>,
    pub max_retries: Option<i32>,
}

// ─── 管理 API Handler ─────────────────────────────────────────

/// GET /api/admin/workflows
pub async fn list_workflows(
    State(pool): State<PgPool>,
    Query(params): Query<HashMap<String, String>>,
    axum::Extension(_claims): axum::Extension<Claims>,
) -> Result<Json<Value>> {
    let tenant_id: Option<i32> = params.get("tenant_id").and_then(|v| v.parse().ok());
    let database_id: Option<i32> = params.get("database_id").and_then(|v| v.parse().ok());

    let workflows = if let Some(did) = database_id {
        sqlx::query_as::<_, Workflow>(
            "SELECT * FROM management.workflows WHERE database_id = $1 ORDER BY created_at DESC",
        )
        .bind(did)
        .fetch_all(&pool)
        .await?
    } else if let Some(tid) = tenant_id {
        sqlx::query_as::<_, Workflow>(
            "SELECT * FROM management.workflows WHERE tenant_id = $1 ORDER BY created_at DESC",
        )
        .bind(tid)
        .fetch_all(&pool)
        .await?
    } else {
        sqlx::query_as::<_, Workflow>(
            "SELECT * FROM management.workflows ORDER BY created_at DESC",
        )
        .fetch_all(&pool)
        .await?
    };

    Ok(Json(json!({ "workflows": workflows, "total": workflows.len() })))
}

/// GET /api/admin/workflows/:id
pub async fn get_workflow(
    State(pool): State<PgPool>,
    Path(id): Path<i32>,
    axum::Extension(_claims): axum::Extension<Claims>,
) -> Result<Json<Value>> {
    let workflow = sqlx::query_as::<_, Workflow>(
        "SELECT * FROM management.workflows WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("工作流 {} 不存在", id)))?;

    Ok(Json(json!({ "workflow": workflow })))
}

/// POST /api/admin/workflows
pub async fn create_workflow(
    State(pool): State<PgPool>,
    axum::Extension(claims): axum::Extension<Claims>,
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
            "slug 只能包含小写字母、数字、连字符".to_string(),
        ));
    }

    let trigger_type = req.trigger_type.unwrap_or_else(|| "endpoint".to_string());
    if !["endpoint", "hook", "cron", "manual"].contains(&trigger_type.as_str()) {
        return Err(AppError::InvalidQuery(
            "trigger_type 必须是 endpoint / hook / cron / manual".to_string(),
        ));
    }

    // 验证 DAG 结构
    let def = parse_definition(&req.nodes, &req.edges)?;
    workflow_engine::validate_definition(&def)?;

    let workflow = sqlx::query_as::<_, Workflow>(
        r#"INSERT INTO management.workflows
           (tenant_id, database_id, name, slug, description, trigger_type, trigger_config,
            nodes, edges, is_enabled, timeout_ms, max_retries, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING *"#,
    )
    .bind(req.tenant_id)
    .bind(req.database_id)
    .bind(&req.name)
    .bind(&req.slug)
    .bind(&req.description)
    .bind(&trigger_type)
    .bind(req.trigger_config.unwrap_or(json!({})))
    .bind(&req.nodes)
    .bind(&req.edges)
    .bind(req.is_enabled.unwrap_or(true))
    .bind(req.timeout_ms.unwrap_or(30_000))
    .bind(req.max_retries.unwrap_or(0))
    .bind(claims.sub)
    .fetch_one(&pool)
    .await?;

    tracing::info!(workflow_id = workflow.id, slug = %workflow.slug, "工作流已创建");

    Ok((StatusCode::CREATED, Json(json!({ "workflow": workflow }))))
}

/// PATCH /api/admin/workflows/:id
pub async fn update_workflow(
    State(pool): State<PgPool>,
    Path(id): Path<i32>,
    axum::Extension(_claims): axum::Extension<Claims>,
    Json(req): Json<UpdateWorkflowRequest>,
) -> Result<Json<Value>> {
    if let Some(ref slug) = req.slug {
        if !is_valid_slug(slug) {
            return Err(AppError::InvalidQuery(
                "slug 只能包含小写字母、数字、连字符".to_string(),
            ));
        }
    }

    // 如果提供了 nodes/edges，验证 DAG
    if let (Some(ref nodes), Some(ref edges)) = (&req.nodes, &req.edges) {
        let def = parse_definition(nodes, edges)?;
        workflow_engine::validate_definition(&def)?;
    }

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
            is_enabled = COALESCE($10, is_enabled),
            timeout_ms = COALESCE($11, timeout_ms),
            max_retries = COALESCE($12, max_retries)
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
    .bind(req.is_enabled)
    .bind(req.timeout_ms)
    .bind(req.max_retries)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("工作流 {} 不存在", id)))?;

    tracing::info!(workflow_id = workflow.id, "工作流已更新");
    Ok(Json(json!({ "workflow": workflow })))
}

/// DELETE /api/admin/workflows/:id
pub async fn delete_workflow(
    State(pool): State<PgPool>,
    Path(id): Path<i32>,
    axum::Extension(_claims): axum::Extension<Claims>,
) -> Result<Json<Value>> {
    let result = sqlx::query("DELETE FROM management.workflows WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("工作流 {} 不存在", id)));
    }

    tracing::info!(workflow_id = id, "工作流已删除");
    Ok(Json(json!({ "message": "工作流已删除", "id": id })))
}

/// POST /api/admin/workflows/:id/trigger — 手动触发
pub async fn trigger_workflow(
    State(pool): State<PgPool>,
    Path(id): Path<i32>,
    axum::Extension(claims): axum::Extension<Claims>,
    Json(trigger_data): Json<Option<Value>>,
) -> Result<(StatusCode, Json<Value>)> {
    let workflow = sqlx::query_as::<_, Workflow>(
        "SELECT * FROM management.workflows WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("工作流 {} 不存在", id)))?;

    if !workflow.is_enabled {
        return Err(AppError::InvalidQuery("工作流已禁用，无法触发".to_string()));
    }

    let data = trigger_data.unwrap_or(json!({}));
    let pool_clone = pool.clone();
    let wf = workflow.clone();

    tokio::spawn(async move {
        if let Err(e) = execute_workflow_internal(&pool_clone, &wf, "manual", &data, Some(claims.sub)).await {
            tracing::error!(workflow_id = wf.id, error = %e, "手动触发工作流执行失败");
        }
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "message": "工作流已触发", "workflow_id": id })),
    ))
}

/// GET /api/admin/workflows/:id/runs
pub async fn get_workflow_runs(
    State(pool): State<PgPool>,
    Path(id): Path<i32>,
    Query(params): Query<HashMap<String, String>>,
    axum::Extension(_claims): axum::Extension<Claims>,
) -> Result<Json<Value>> {
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

// ─── Endpoint 触发器 ─────────────────────────────────────────
//
// POST /workflow/:database_id/:slug
// 任意外部系统可通过此路由触发工作流（需携带 API Key 或 JWT）

pub async fn endpoint_trigger(
    State(pool): State<PgPool>,
    Path((database_id_str, slug)): Path<(String, String)>,
    claims: Option<axum::Extension<Claims>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>> {
    let database_id: Option<i32> = database_id_str.parse().ok().filter(|&id| id > 0);

    let workflow = if let Some(db_id) = database_id {
        sqlx::query_as::<_, Workflow>(
            r#"SELECT * FROM management.workflows
               WHERE database_id = $1 AND slug = $2 AND trigger_type = 'endpoint' AND is_enabled = true"#,
        )
        .bind(db_id)
        .bind(&slug)
        .fetch_optional(&pool)
        .await?
    } else {
        sqlx::query_as::<_, Workflow>(
            r#"SELECT * FROM management.workflows
               WHERE database_id IS NULL AND slug = $1 AND trigger_type = 'endpoint' AND is_enabled = true"#,
        )
        .bind(&slug)
        .fetch_optional(&pool)
        .await?
    }
    .ok_or_else(|| {
        AppError::NotFound(format!("工作流 {}/{} 不存在或未启用", database_id_str, slug))
    })?;

    let user_id = claims.as_ref().map(|c| c.sub);
    let result = execute_workflow_internal(&pool, &workflow, "endpoint", &body, user_id).await?;

    // 找 response 节点的输出
    let response_output = result
        .iter()
        .rev()
        .find(|r| r.status == NodeStatus::Success && r.output.get("status_code").is_some())
        .map(|r| &r.output);

    if let Some(resp) = response_output {
        let body = resp.get("body").cloned().unwrap_or(json!({"ok": true}));
        Ok(Json(body))
    } else {
        let final_output = result
            .last()
            .filter(|r| r.status == NodeStatus::Success)
            .map(|r| r.output.clone())
            .unwrap_or(json!({"ok": true}));
        Ok(Json(final_output))
    }
}

/// GET /workflow/:database_id/:slug — 支持通过 query string 传参
pub async fn endpoint_trigger_get(
    State(pool): State<PgPool>,
    Path((database_id_str, slug)): Path<(String, String)>,
    Query(params): Query<HashMap<String, String>>,
    claims: Option<axum::Extension<Claims>>,
) -> Result<Json<Value>> {
    let body = serde_json::to_value(&params).unwrap_or(json!({}));
    let database_id: Option<i32> = database_id_str.parse().ok().filter(|&id| id > 0);

    let workflow = if let Some(db_id) = database_id {
        sqlx::query_as::<_, Workflow>(
            r#"SELECT * FROM management.workflows
               WHERE database_id = $1 AND slug = $2 AND trigger_type = 'endpoint' AND is_enabled = true"#,
        )
        .bind(db_id)
        .bind(&slug)
        .fetch_optional(&pool)
        .await?
    } else {
        sqlx::query_as::<_, Workflow>(
            r#"SELECT * FROM management.workflows
               WHERE database_id IS NULL AND slug = $1 AND trigger_type = 'endpoint' AND is_enabled = true"#,
        )
        .bind(&slug)
        .fetch_optional(&pool)
        .await?
    }
    .ok_or_else(|| {
        AppError::NotFound(format!("工作流 {}/{} 不存在或未启用", database_id_str, slug))
    })?;

    let user_id = claims.as_ref().map(|c| c.sub);
    let result = execute_workflow_internal(&pool, &workflow, "endpoint", &body, user_id).await?;

    let response_output = result
        .iter()
        .rev()
        .find(|r| r.status == NodeStatus::Success && r.output.get("status_code").is_some())
        .map(|r| &r.output);

    if let Some(resp) = response_output {
        let body = resp.get("body").cloned().unwrap_or(json!({"ok": true}));
        Ok(Json(body))
    } else {
        let final_output = result
            .last()
            .filter(|r| r.status == NodeStatus::Success)
            .map(|r| r.output.clone())
            .unwrap_or(json!({"ok": true}));
        Ok(Json(final_output))
    }
}

// ─── 内部执行逻辑 ─────────────────────────────────────────

pub async fn execute_workflow_internal(
    pool: &PgPool,
    workflow: &Workflow,
    trigger_type: &str,
    trigger_data: &Value,
    user_id: Option<i32>,
) -> Result<Vec<NodeExecutionResult>> {
    let start = std::time::Instant::now();

    // 创建执行记录
    let run = sqlx::query_as::<_, WorkflowRun>(
        r#"INSERT INTO management.workflow_runs
           (workflow_id, tenant_id, trigger_type, trigger_data, status)
           VALUES ($1, $2, $3, $4, 'running')
           RETURNING *"#,
    )
    .bind(workflow.id)
    .bind(workflow.tenant_id)
    .bind(trigger_type)
    .bind(trigger_data)
    .fetch_one(pool)
    .await?;

    let def = parse_definition(&workflow.nodes, &workflow.edges)?;

    let mut exec_ctx = ExecutionContext {
        workflow_id: workflow.id,
        run_id: run.id,
        trigger_type: trigger_type.to_string(),
        trigger_data: trigger_data.clone(),
        user_id,
        tenant_id: workflow.tenant_id,
        database_id: workflow.database_id,
        node_outputs: HashMap::new(),
    };

    let engine = DagEngine::new(pool.clone());
    let results = engine.execute(&def, &mut exec_ctx).await;

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

            sqlx::query(
                r#"UPDATE management.workflow_runs
                   SET status = $2, node_results = $3, final_output = $4,
                       error_message = $5, elapsed_ms = $6, completed_at = NOW()
                   WHERE id = $1"#,
            )
            .bind(run.id)
            .bind(status)
            .bind(json!(node_results))
            .bind(final_output)
            .bind(&error_msg)
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

            Ok(node_results.clone())
        }
        Err(e) => {
            sqlx::query(
                r#"UPDATE management.workflow_runs
                   SET status = 'failed', error_message = $2, elapsed_ms = $3, completed_at = NOW()
                   WHERE id = $1"#,
            )
            .bind(run.id)
            .bind(e.to_string())
            .bind(elapsed_ms)
            .execute(pool)
            .await?;

            Err(e)
        }
    }
}

// ─── 辅助函数 ─────────────────────────────────────────

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
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !slug.starts_with('-')
        && !slug.ends_with('-')
}
