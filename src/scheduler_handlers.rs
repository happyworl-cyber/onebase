//! HTTP API：定时任务管理。
//!
//! 路由清单见 spec §7。所有 handler 假定已经通过 `auth_middleware`（拿到 Claims）。
//!
//! 鉴权矩阵：
//! - 平台级任务（`tenant_id IS NULL`）—— 仅超管可创建 / 编辑 / 删除 / 触发
//! - 租户级任务（`tenant_id = T`）—— 超管 或 该租户 owner/admin
//!
//! 由 `validate_can_manage` 集中决策；database_id 还会额外做"归属校验"
//! （`validate_database_belongs_to_tenant`），防止租户把任务挂到其他租户的库上。
//!
//! 响应里的 `http_secret_enc` 一律通过 `redact_secret` 替换为 `"***"`，
//! 永远不向外暴露密文。

use axum::{
    extract::{Extension, Path, Query, State},
    Json,
};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use std::sync::Arc;

use crate::audit_handlers;
use crate::auth::Claims;
use crate::error::AppError;
use crate::middleware::ApiKeyContext;
use crate::scheduler::cron_parser;
use crate::scheduler::models::ScheduledTask;
use crate::scheduler::runner::SchedulerRunner;

// ─── Request / Response 形状 ────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreateTaskReq {
    pub tenant_id: Option<i32>,
    pub name: String,
    pub description: Option<String>,
    pub cron_expr: String,
    pub timezone: Option<String>,
    pub kind: String,
    pub database_id: Option<i32>,
    pub rpc_schema: Option<String>,
    pub rpc_fn_name: Option<String>,
    pub rpc_args: Option<Value>,
    pub http_method: Option<String>,
    pub http_url: Option<String>,
    pub http_headers: Option<Value>,
    pub http_body: Option<Value>,
    pub http_secret: Option<String>,
    pub shell_interpreter: Option<String>,
    pub shell_script: Option<String>,
    pub shell_env: Option<Value>,
    pub shell_cwd: Option<String>,
    pub workflow_id: Option<i32>,
    pub workflow_input: Option<Value>,
    pub timeout_secs: Option<i32>,
    pub max_retries: Option<i32>,
    pub overlap_policy: Option<String>,
    pub alert_webhook_url: Option<String>,
    pub alert_webhook_template: Option<Value>,
    pub alert_throttle_hours: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateTaskReq {
    pub name: Option<String>,
    pub description: Option<String>,
    pub cron_expr: Option<String>,
    pub timezone: Option<String>,
    pub rpc_args: Option<Value>,
    // http_url 允许在编辑时修改（上游服务搬家/换路径的场景很常见）。
    // http_method 仍视为不可变：GET → POST 这种语义变化基本等于另一个任务，
    // 想换 method 请新建任务，避免运维误改后历史 run 的"含义"被偷偷改写。
    pub http_url: Option<String>,
    pub http_headers: Option<Value>,
    pub http_body: Option<Value>,
    pub http_secret: Option<String>,
    // shell 字段允许在编辑时修改（脚本是会迭代的）；interpreter / cwd 也允许调整。
    // 注意：kind 本身不可变（同 rpc/http 一致），所以这些字段只在 kind='shell' 时才会落库。
    pub shell_interpreter: Option<String>,
    pub shell_script: Option<String>,
    pub shell_env: Option<Value>,
    pub shell_cwd: Option<String>,
    pub workflow_id: Option<i32>,
    pub workflow_input: Option<Value>,
    pub timeout_secs: Option<i32>,
    pub max_retries: Option<i32>,
    pub overlap_policy: Option<String>,
    pub is_active: Option<bool>,
    #[serde(default)]
    pub alert_webhook_url: Option<Option<String>>,
    #[serde(default)]
    pub alert_webhook_template: Option<Option<Value>>,
    pub alert_throttle_hours: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub tenant_id: Option<i32>,
    pub kind: Option<String>,
    pub is_active: Option<bool>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct ValidateCronReq {
    pub cron_expr: String,
    pub timezone: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CleanupZombiesReq {
    pub older_than_hours: Option<i64>,
}

fn normalize_alert_webhook_url(url: Option<&str>) -> Result<Option<String>, AppError> {
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

fn validate_alert_webhook_template(template: Option<&Value>) -> Result<(), AppError> {
    if let Some(v) = template {
        if !v.is_object() {
            return Err(AppError::InvalidQuery(
                "告警 Webhook 模板必须是 JSON object".to_string(),
            ));
        }
    }
    Ok(())
}

fn validate_alert_throttle_hours(hours: Option<i32>) -> Result<(), AppError> {
    if let Some(h) = hours {
        if !(0..=720).contains(&h) {
            return Err(AppError::InvalidQuery(
                "告警限流小时数必须在 0 到 720 之间".to_string(),
            ));
        }
    }
    Ok(())
}

async fn load_enabled_workflow_for_tenant(
    pool: &PgPool,
    workflow_id: i32,
    tenant_id: i32,
) -> Result<crate::workflow_handlers::Workflow, AppError> {
    let wf = sqlx::query_as::<_, crate::workflow_handlers::Workflow>(
        "SELECT * FROM management.workflows WHERE id = $1",
    )
    .bind(workflow_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("工作流不存在".into()))?;

    if wf.tenant_id != Some(tenant_id) {
        return Err(AppError::InvalidQuery("工作流不属于当前项目".to_string()));
    }
    if !wf.is_enabled {
        return Err(AppError::InvalidQuery("只能选择已启用的工作流".to_string()));
    }
    Ok(wf)
}

fn workflow_input_or_empty(v: Option<Value>) -> Result<Value, AppError> {
    let v = v.unwrap_or_else(|| json!({}));
    if !v.is_object() {
        return Err(AppError::InvalidQuery(
            "workflow_input 必须是 JSON 对象".to_string(),
        ));
    }
    Ok(v)
}

/// 试运行：把表单里的"未保存任务"直接喂给 executor 跑一遍，不写 DB（不入 scheduled_tasks，
/// 也不入 scheduled_task_runs）。
///
/// 与 create 完全相同的字段集合，方便前端把"创建表单的当前值"原封不动 POST 过来。
/// 鉴权与 create 一致：超管 / 租户 owner-admin；shell 仍要求超管 + tenant_id IS NULL。
#[derive(Debug, Deserialize)]
pub struct DryRunReq {
    pub tenant_id: Option<i32>,
    pub kind: String,
    pub timeout_secs: Option<i32>,
    pub database_id: Option<i32>,
    pub rpc_schema: Option<String>,
    pub rpc_fn_name: Option<String>,
    pub rpc_args: Option<Value>,
    pub http_method: Option<String>,
    pub http_url: Option<String>,
    pub http_headers: Option<Value>,
    pub http_body: Option<Value>,
    pub http_secret: Option<String>,
    pub shell_interpreter: Option<String>,
    pub shell_script: Option<String>,
    pub shell_env: Option<Value>,
    pub shell_cwd: Option<String>,
    pub workflow_id: Option<i32>,
    pub workflow_input: Option<Value>,
}

// ─── 鉴权辅助 ────────────────────────────────

/// 当前 claims 是否可以管理这个 tenant_id 下（含 None = 平台级）的任务。
///
/// - 超管：恒允许
/// - 平台级（`tenant_id IS NULL`）：非超管一律拒绝
/// - 租户级：当前用户必须是该 tenant 的 owner/admin
async fn validate_can_manage(
    claims: &Claims,
    task_tenant_id: Option<i32>,
    pool: &PgPool,
) -> Result<(), AppError> {
    if claims.is_superadmin {
        return Ok(());
    }
    match task_tenant_id {
        // 平台超管限制已移除：平台级任务对任何已认证用户开放（租户级仍按 owner/admin 校验）。
        None => Ok(()),
        Some(t) => {
            let admins = audit_handlers::admin_tenant_ids(pool, claims).await?;
            if admins.contains(&t) {
                Ok(())
            } else {
                Err(AppError::Forbidden(
                    "仅租户 owner/admin 可管理此任务".to_string(),
                ))
            }
        }
    }
}

/// 校验 `database_id` 归属。
/// - 平台级任务（tenant_id=None）可指任意活跃库（仅超管能创建到达此处）
/// - 租户级任务必须指向该租户名下的库
async fn validate_database_belongs_to_tenant(
    pool: &PgPool,
    database_id: i32,
    tenant_id: Option<i32>,
) -> Result<(), AppError> {
    // `tenant_databases.tenant_id` 在 schema 里是 nullable（平台级 DB 没有 tenant 归属），
    // 所以这里是双层 Option：外层 = "该 DB 行是否存在"，内层 = "tenant 列是否 NULL"。
    let owner_opt: Option<i32> = sqlx::query_scalar(
        "SELECT tenant_id FROM management.tenant_databases WHERE id = $1 AND is_active = true",
    )
    .bind(database_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询数据库归属失败: {e}")))?
    .ok_or_else(|| AppError::InvalidQuery("database_id 不存在或未启用".to_string()))?;
    match (tenant_id, owner_opt) {
        // 平台级任务（仅超管能创建到达此处）可指任何活跃库
        (None, _) => Ok(()),
        // 租户级任务必须指向同租户的库
        (Some(t), Some(o)) if t == o => Ok(()),
        _ => Err(AppError::InvalidQuery(
            "database_id 不属于指定的 tenant_id".to_string(),
        )),
    }
}

// ─── Handlers ────────────────────────────────

/// `ob_` API Key 调用时：body 未指定则回填密钥绑定的租户/数据库。
fn fill_from_api_key_context(
    tenant_id: &mut Option<i32>,
    database_id: &mut Option<i32>,
    api_key_ctx: Option<&ApiKeyContext>,
) {
    if let Some(ctx) = api_key_ctx {
        if tenant_id.is_none() {
            *tenant_id = Some(ctx.tenant_id);
        }
        if database_id.is_none() {
            *database_id = Some(ctx.database_id);
        }
    }
}

/// 定时任务**管理操作**打点（建/改/删/启停/立即触发）。
/// - 平台级任务（`tenant_id = None`）无租户归属 → 跳过（对齐工作流）。
/// - 任务的**自动定时执行**不在此打点（太频繁），其可观测性由执行日志 / task_runs 覆盖。
fn record_task_op(
    pool: &PgPool,
    claims: &Claims,
    tenant_id: Option<i32>,
    action: &str,
    task_id: i64,
    task_name: &str,
    summary: String,
    high_risk: Option<bool>,
) {
    let tenant_id = match tenant_id {
        Some(t) => t,
        None => return,
    };
    let mut input = crate::operation_log::OperationLogInput::new(
        tenant_id,
        crate::operation_log::Actor::from_claims(claims),
        crate::operation_log::Source::Console,
        action,
        summary,
        crate::operation_log::Status::Success,
    )
    .resource(
        crate::operation_log::resource_type::SCHEDULED_TASK,
        task_name.to_string(),
        Some(task_id.to_string()),
    );
    input.high_risk = high_risk;
    crate::operation_log::record(pool, input);
}

pub async fn create_task(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    api_key_ctx: Option<Extension<ApiKeyContext>>,
    Json(mut req): Json<CreateTaskReq>,
) -> Result<Json<ScheduledTask>, AppError> {
    fill_from_api_key_context(
        &mut req.tenant_id,
        &mut req.database_id,
        api_key_ctx.as_ref().map(|e| &e.0),
    );

    validate_can_manage(&claims, req.tenant_id, &pool).await?;

    let kind = req.kind.as_str();
    if kind != "rpc" && kind != "http" && kind != "shell" && kind != "workflow" {
        return Err(AppError::InvalidQuery(
            "kind 必须是 rpc / http / shell / workflow".to_string(),
        ));
    }
    // shell 任务的鉴权完全交给 `validate_can_manage`：
    //   - 平台级（tenant_id IS NULL）→ 仍只允许平台超管（与原来一致）
    //   - 租户级（tenant_id = X）   → 该租户的 owner/admin 可创建（迁移 017 之后放开）
    // 沙盒（bwrap/nsjail）、解释器白名单、env_clear 等运行时防护是 shell 任务真正
    // 的安全边界，不依赖"只准超管建"这个早期保守限制；详见 015 → 017 的演进。
    let timezone = req.timezone.clone().unwrap_or_else(|| "UTC".to_string());
    // 一次解析：既是校验，也是 next_run_at 的初值。
    let next_run_at = cron_parser::next_after(&req.cron_expr, &timezone, Utc::now())?;

    if kind == "rpc" {
        if req.database_id.is_none() || req.rpc_schema.is_none() || req.rpc_fn_name.is_none() {
            return Err(AppError::InvalidQuery(
                "rpc 任务必须提供 database_id / rpc_schema / rpc_fn_name".to_string(),
            ));
        }
        validate_database_belongs_to_tenant(&pool, req.database_id.unwrap(), req.tenant_id).await?;
    } else if kind == "http" {
        if req.http_method.is_none() || req.http_url.is_none() {
            return Err(AppError::InvalidQuery(
                "http 任务必须提供 http_method / http_url".to_string(),
            ));
        }
    } else if kind == "shell" {
        let script_ok = req
            .shell_script
            .as_deref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        if !script_ok {
            return Err(AppError::InvalidQuery(
                "shell 任务必须提供非空的 shell_script".to_string(),
            ));
        }
        if let Some(env) = &req.shell_env {
            if !env.is_object() {
                return Err(AppError::InvalidQuery(
                    "shell_env 必须是 JSON object（{key: value, ...}）".to_string(),
                ));
            }
        }
    }

    let mut workflow_id: Option<i32> = None;
    let mut workflow_slug: Option<String> = None;
    let mut workflow_input: Option<Value> = None;
    if kind == "workflow" {
        let tenant_id = req.tenant_id.ok_or_else(|| {
            AppError::InvalidQuery("工作流任务必须属于一个项目（tenant_id）".into())
        })?;
        let wf_id = req
            .workflow_id
            .ok_or_else(|| AppError::InvalidQuery("工作流任务必须提供 workflow_id".into()))?;
        let wf = load_enabled_workflow_for_tenant(&pool, wf_id, tenant_id).await?;
        workflow_id = Some(wf.id);
        workflow_slug = Some(wf.slug.clone());
        workflow_input = Some(workflow_input_or_empty(req.workflow_input.clone())?);
    }

    let http_secret_enc = match req.http_secret.as_deref() {
        Some(s) if !s.is_empty() => Some(crate::crypto::encrypt_secret(s)?),
        _ => None,
    };
    validate_alert_webhook_template(req.alert_webhook_template.as_ref())?;
    validate_alert_throttle_hours(req.alert_throttle_hours)?;
    let alert_webhook_url = normalize_alert_webhook_url(req.alert_webhook_url.as_deref())?;

    let row = sqlx::query_as::<_, ScheduledTask>(
        "INSERT INTO management.scheduled_tasks ( \
            tenant_id, name, description, cron_expr, timezone, kind, \
            database_id, rpc_schema, rpc_fn_name, rpc_args, \
            http_method, http_url, http_headers, http_body, http_secret_enc, \
            shell_interpreter, shell_script, shell_env, shell_cwd, \
            workflow_id, workflow_slug, workflow_input, \
            timeout_secs, max_retries, overlap_policy, alert_webhook_url, \
            alert_webhook_template, alert_throttle_hours, next_run_at, created_by) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30) \
         RETURNING *",
    )
    .bind(req.tenant_id)
    .bind(&req.name)
    .bind(&req.description)
    .bind(&req.cron_expr)
    .bind(&timezone)
    .bind(kind)
    .bind(req.database_id)
    .bind(&req.rpc_schema)
    .bind(&req.rpc_fn_name)
    .bind(&req.rpc_args)
    .bind(req.http_method.as_deref().map(|s| s.to_uppercase()))
    .bind(&req.http_url)
    .bind(&req.http_headers)
    .bind(&req.http_body)
    .bind(&http_secret_enc)
    // shell_* 仅在 kind='shell' 时有意义；其它 kind 这里也照 bind None，让 DB 的
    // chk_st_kind_shell 等约束自己把关，避免分支爆炸。
    .bind(if kind == "shell" { req.shell_interpreter.as_deref() } else { None })
    .bind(if kind == "shell" { req.shell_script.as_deref() } else { None })
    .bind(if kind == "shell" { req.shell_env.as_ref() } else { None })
    .bind(if kind == "shell" { req.shell_cwd.as_deref() } else { None })
    .bind(workflow_id)
    .bind(&workflow_slug)
    .bind(&workflow_input)
    .bind(req.timeout_secs.unwrap_or(60))
    .bind(req.max_retries.unwrap_or(0))
    .bind(req.overlap_policy.as_deref().unwrap_or("skip"))
    .bind(alert_webhook_url)
    .bind(req.alert_webhook_template)
    .bind(req.alert_throttle_hours.unwrap_or(24))
    .bind(next_run_at)
    .bind(claims.sub)
    .fetch_one(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("创建任务失败: {e}")))?;

    tracing::info!(
        target: "scheduler",
        task_id = row.id,
        tenant_id = ?req.tenant_id,
        kind = %kind,
        name = %req.name,
        operator = claims.sub,
        "创建定时任务"
    );

    record_task_op(
        &pool,
        &claims,
        row.tenant_id,
        crate::operation_log::action::CREATE,
        row.id,
        &row.name,
        format!("创建定时任务「{}」（{}）", row.name, kind),
        None,
    );

    Ok(Json(redact_secret(row)))
}

pub async fn list_tasks(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<ScheduledTask>>, AppError> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let offset = q.offset.unwrap_or(0).max(0);

    // 动态构造 WHERE：tenant_id IN (...) 的占位符数随 admins 数量变，但所有值都通过
    // bind 进来，不发生 SQL 注入。kind / is_active 用 bind 参数。
    // LIMIT / OFFSET 是已经 clamp 过的 i64，直接 format 到 SQL 里是安全的——
    // sqlx 不支持把 LIMIT/OFFSET 作为 bind 的所有 driver/版本组合。
    let mut where_parts: Vec<String> = vec!["1=1".to_string()];
    let mut bind_idx: i32 = 0;
    let mut int_binds: Vec<i32> = Vec::new();
    let mut str_binds: Vec<String> = Vec::new();
    let mut bool_binds: Vec<bool> = Vec::new();

    if !claims.is_superadmin {
        let admins = audit_handlers::admin_tenant_ids(&pool, &claims).await?;
        if admins.is_empty() {
            return Ok(Json(Vec::new()));
        }
        if let Some(t) = q.tenant_id {
            if !admins.contains(&t) {
                return Err(AppError::Forbidden("无权查看该租户的定时任务".to_string()));
            }
            bind_idx += 1;
            where_parts.push(format!("t.tenant_id = ${}", bind_idx));
            int_binds.push(t);
        } else {
            let placeholders = admins
                .iter()
                .map(|_| {
                    bind_idx += 1;
                    format!("${}", bind_idx)
                })
                .collect::<Vec<_>>()
                .join(",");
            where_parts.push(format!("t.tenant_id IN ({placeholders})"));
            int_binds.extend(admins);
        }
    } else if let Some(t) = q.tenant_id {
        bind_idx += 1;
        where_parts.push(format!("t.tenant_id = ${}", bind_idx));
        int_binds.push(t);
    }

    if let Some(k) = &q.kind {
        bind_idx += 1;
        where_parts.push(format!("t.kind = ${}", bind_idx));
        str_binds.push(k.clone());
    }
    if let Some(a) = q.is_active {
        bind_idx += 1;
        where_parts.push(format!("t.is_active = ${}", bind_idx));
        bool_binds.push(a);
    }

    let sql = format!(
        "SELECT t.*, cu.username AS created_by_name, cu.email AS created_by_email \
         FROM management.scheduled_tasks t \
         LEFT JOIN users cu ON cu.id = t.created_by \
         WHERE {} ORDER BY t.id DESC LIMIT {} OFFSET {}",
        where_parts.join(" AND "),
        limit,
        offset,
    );
    let mut query = sqlx::query_as::<_, ScheduledTask>(&sql);
    for v in &int_binds {
        query = query.bind(v);
    }
    for v in &str_binds {
        query = query.bind(v);
    }
    for v in &bool_binds {
        query = query.bind(v);
    }
    let rows = query
        .fetch_all(&pool)
        .await
        .map_err(|e| AppError::Internal(format!("列表查询失败: {e}")))?;
    Ok(Json(rows.into_iter().map(redact_secret).collect()))
}

pub async fn get_task(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    let task = fetch_task_or_404(&pool, id).await?;
    validate_can_manage(&claims, task.tenant_id, &pool).await?;
    let runs = sqlx::query(
        "SELECT id, started_at, finished_at, status, runner_id, attempt_number, \
                triggered_by, duration_ms, error_message \
         FROM management.scheduled_task_runs WHERE task_id = $1 \
         ORDER BY started_at DESC LIMIT 5",
    )
    .bind(id)
    .fetch_all(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询 runs 失败: {e}")))?;
    let runs_json: Vec<Value> = runs
        .into_iter()
        .map(|r| {
            json!({
                "id": r.get::<i64, _>("id"),
                "started_at": r.get::<chrono::DateTime<Utc>, _>("started_at"),
                "finished_at": r.try_get::<Option<chrono::DateTime<Utc>>, _>("finished_at").unwrap_or(None),
                "status": r.get::<String, _>("status"),
                "runner_id": r.try_get::<Option<String>, _>("runner_id").unwrap_or(None),
                "attempt_number": r.get::<i32, _>("attempt_number"),
                "triggered_by": r.get::<String, _>("triggered_by"),
                "duration_ms": r.try_get::<Option<i32>, _>("duration_ms").unwrap_or(None),
                "error_message": r.try_get::<Option<String>, _>("error_message").unwrap_or(None),
            })
        })
        .collect();
    Ok(Json(json!({
        "task": redact_secret(task),
        "recent_runs": runs_json,
    })))
}

pub async fn update_task(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateTaskReq>,
) -> Result<Json<ScheduledTask>, AppError> {
    let task = fetch_task_or_404(&pool, id).await?;
    validate_can_manage(&claims, task.tenant_id, &pool).await?;

    // cron / timezone 任一变化都重算 next_run_at；保持与 create 同款语义。
    let cron = req
        .cron_expr
        .clone()
        .unwrap_or_else(|| task.cron_expr.clone());
    let tz = req
        .timezone
        .clone()
        .unwrap_or_else(|| task.timezone.clone());
    let next = cron_parser::next_after(&cron, &tz, Utc::now())?;

    // http_secret 语义：传非空字符串 → 重新加密覆盖；传空串或不传 → 保留原值。
    let http_secret_enc = match req.http_secret.as_deref() {
        Some(s) if !s.is_empty() => Some(crate::crypto::encrypt_secret(s)?),
        _ => task.http_secret_enc.clone(),
    };

    // http_url 允许修改，但传空串视为无效（不允许把已有任务的 URL 清空）。
    // 显式传值才覆盖；不传（None）走 COALESCE 保留原值。
    if let Some(u) = req.http_url.as_deref() {
        if u.trim().is_empty() {
            return Err(AppError::InvalidQuery(
                "http_url 不能为空字符串".to_string(),
            ));
        }
    }
    let alert_webhook_url = match req.alert_webhook_url.as_ref() {
        Some(Some(url)) => normalize_alert_webhook_url(Some(url))?,
        Some(None) => None,
        None => task.alert_webhook_url.clone(),
    };
    let alert_webhook_template = match req.alert_webhook_template.clone() {
        Some(template) => template,
        None => task.alert_webhook_template.clone(),
    };
    validate_alert_webhook_template(alert_webhook_template.as_ref())?;
    let alert_throttle_hours = req
        .alert_throttle_hours
        .unwrap_or(task.alert_throttle_hours);
    validate_alert_throttle_hours(Some(alert_throttle_hours))?;

    let mut workflow_id: Option<i32> = None;
    let mut workflow_slug: Option<String> = None;
    let mut workflow_input: Option<Value> = None;
    if task.kind == "workflow" {
        if let Some(wf_id) = req.workflow_id {
            let tenant_id = task
                .tenant_id
                .ok_or_else(|| AppError::InvalidQuery("工作流任务缺少 tenant_id".into()))?;
            let wf = load_enabled_workflow_for_tenant(&pool, wf_id, tenant_id).await?;
            workflow_id = Some(wf.id);
            workflow_slug = Some(wf.slug);
        }
        if req.workflow_input.is_some() {
            workflow_input = Some(workflow_input_or_empty(req.workflow_input.clone())?);
        }
    }

    // shell_* 字段仅对 shell kind 有意义。这里仍走 COALESCE 语义（None → 保留原值）
    // 而不是无条件覆盖，避免 patch http 任务时把 shell_* 当成"清空"误传。
    // 即使有人给 http 任务传了 shell_script，DB 的 chk_st_kind_shell 等约束也只在
    // kind='shell' 时校验，对其它 kind 是 no-op；handler 这里不再额外分支判 kind，
    // 让 DB 做最后兜底。
    let row = sqlx::query_as::<_, ScheduledTask>(
        "UPDATE management.scheduled_tasks SET \
            name = COALESCE($1, name), \
            description = COALESCE($2, description), \
            cron_expr = $3, timezone = $4, next_run_at = $5, \
            rpc_args = COALESCE($6, rpc_args), \
            http_url = COALESCE($7, http_url), \
            http_headers = COALESCE($8, http_headers), \
            http_body = COALESCE($9, http_body), \
            http_secret_enc = $10, \
            shell_interpreter = COALESCE($11, shell_interpreter), \
            shell_script = COALESCE($12, shell_script), \
            shell_env = COALESCE($13, shell_env), \
            shell_cwd = COALESCE($14, shell_cwd), \
            workflow_id = COALESCE($15, workflow_id), \
            workflow_slug = COALESCE($16, workflow_slug), \
            workflow_input = COALESCE($17, workflow_input), \
            timeout_secs = COALESCE($18, timeout_secs), \
            max_retries = COALESCE($19, max_retries), \
            overlap_policy = COALESCE($20, overlap_policy), \
            is_active = COALESCE($21, is_active), \
            alert_webhook_url = $22, \
            alert_webhook_template = $23, \
            alert_throttle_hours = $24, \
            updated_at = NOW() \
         WHERE id = $25 RETURNING *",
    )
    .bind(req.name)
    .bind(req.description)
    .bind(cron)
    .bind(tz)
    .bind(next)
    .bind(req.rpc_args)
    .bind(req.http_url)
    .bind(req.http_headers)
    .bind(req.http_body)
    .bind(http_secret_enc)
    .bind(req.shell_interpreter)
    .bind(req.shell_script)
    .bind(req.shell_env)
    .bind(req.shell_cwd)
    .bind(workflow_id)
    .bind(workflow_slug)
    .bind(workflow_input)
    .bind(req.timeout_secs)
    .bind(req.max_retries)
    .bind(req.overlap_policy)
    .bind(req.is_active)
    .bind(alert_webhook_url)
    .bind(alert_webhook_template)
    .bind(alert_throttle_hours)
    .bind(id)
    .fetch_one(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("更新失败: {e}")))?;

    tracing::info!(
        target: "scheduler",
        task_id = id,
        operator = claims.sub,
        "更新定时任务"
    );

    record_task_op(
        &pool,
        &claims,
        row.tenant_id,
        crate::operation_log::action::UPDATE,
        row.id,
        &row.name,
        format!("修改定时任务「{}」", row.name),
        None,
    );

    Ok(Json(redact_secret(row)))
}

pub async fn delete_task(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    let task = fetch_task_or_404(&pool, id).await?;
    validate_can_manage(&claims, task.tenant_id, &pool).await?;
    sqlx::query("DELETE FROM management.scheduled_tasks WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .map_err(|e| AppError::Internal(format!("删除失败: {e}")))?;
    tracing::info!(
        target: "scheduler",
        task_id = id,
        tenant_id = ?task.tenant_id,
        operator = claims.sub,
        "删除定时任务"
    );
    record_task_op(
        &pool,
        &claims,
        task.tenant_id,
        crate::operation_log::action::DELETE,
        id,
        &task.name,
        format!("删除定时任务「{}」", task.name),
        None,
    );
    Ok(Json(json!({"deleted": true, "id": id})))
}

pub async fn pause_task(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    set_active(&pool, &claims, id, false).await
}

pub async fn resume_task(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    set_active(&pool, &claims, id, true).await
}

async fn set_active(
    pool: &PgPool,
    claims: &Claims,
    id: i64,
    active: bool,
) -> Result<Json<Value>, AppError> {
    let task = fetch_task_or_404(pool, id).await?;
    validate_can_manage(claims, task.tenant_id, pool).await?;
    // resume 时把 next_run_at 重算到"现在之后的第一次"；pause 时保持原值即可，
    // 否则恢复后会立即触发一次（行为不符合 pause 的预期）。
    //
    // 注意：resume 路径**不**用 `.ok()` 吞掉 cron 解析失败——否则一个无效 cron_expr
    // 会让 next_run_at = NULL，任务被标"激活"却永不触发（silent dormancy）。
    // 用 `?` 把 AppError 抛到调用方，前端拿到 400 后能引导用户走 PATCH 修 cron。
    let next_run_at = if active {
        Some(cron_parser::next_after(
            &task.cron_expr,
            &task.timezone,
            Utc::now(),
        )?)
    } else {
        task.next_run_at
    };
    sqlx::query(
        "UPDATE management.scheduled_tasks \
         SET is_active = $1, next_run_at = $2, updated_at = NOW() WHERE id = $3",
    )
    .bind(active)
    .bind(next_run_at)
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| AppError::Internal(format!("切换状态失败: {e}")))?;
    tracing::info!(
        target: "scheduler",
        task_id = id,
        is_active = active,
        operator = claims.sub,
        "{}定时任务",
        if active { "恢复" } else { "暂停" }
    );
    record_task_op(
        pool,
        claims,
        task.tenant_id,
        crate::operation_log::action::UPDATE,
        id,
        &task.name,
        format!(
            "{}定时任务「{}」",
            if active { "启用" } else { "停用" },
            task.name
        ),
        None,
    );
    Ok(Json(json!({"id": id, "is_active": active})))
}

pub async fn run_now(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Extension(runner): Extension<Arc<SchedulerRunner>>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    let task = fetch_task_or_404(&pool, id).await?;
    validate_can_manage(&claims, task.tenant_id, &pool).await?;
    // 停用中的任务不允许 run-now：
    // - pause 的语义就是"不要再跑"，手动旁路绕过会让 pause 失去意义
    // - 即使前端已把按钮禁掉，后端也要兜底防止直接 cURL 攻击面
    // 用户想"临时跑一次"应先 resume → run-now → pause（明确意图）。
    if !task.is_active {
        return Err(AppError::InvalidQuery(
            "任务已停用；请先恢复（resume）后再触发，或在恢复后立即停用".to_string(),
        ));
    }
    tracing::info!(
        target: "scheduler",
        task_id = id,
        kind = %task.kind,
        operator = claims.sub,
        "手动触发定时任务（run-now）"
    );
    // 人工「立即运行」是低频主动操作，打点（区别于自动定时触发——后者不打点）。
    record_task_op(
        &pool,
        &claims,
        task.tenant_id,
        crate::operation_log::action::TRIGGER,
        id,
        &task.name,
        format!("手动触发定时任务「{}」", task.name),
        None,
    );
    // trigger_now 签名是 `pub async fn trigger_now(self: Arc<Self>, task)`——
    // 这里 clone Arc 出来传所有权；不要直接 `runner.trigger_now(...)`。
    runner.clone().trigger_now(task).await;
    Ok(Json(json!({"triggered": true, "id": id})))
}

pub async fn list_runs(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i64>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<Value>>, AppError> {
    let task = fetch_task_or_404(&pool, id).await?;
    validate_can_manage(&claims, task.tenant_id, &pool).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 100);
    let offset = q.offset.unwrap_or(0).max(0);
    let rows = sqlx::query(
        "SELECT id, task_id, started_at, finished_at, status, runner_id, output, error_message, \
                duration_ms, attempt_number, triggered_by \
         FROM management.scheduled_task_runs WHERE task_id = $1 \
         ORDER BY started_at DESC LIMIT $2 OFFSET $3",
    )
    .bind(id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询 runs 失败: {e}")))?;
    let out: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            json!({
                "id": r.get::<i64, _>("id"),
                "task_id": r.get::<i64, _>("task_id"),
                "started_at": r.get::<chrono::DateTime<Utc>, _>("started_at"),
                "finished_at": r.try_get::<Option<chrono::DateTime<Utc>>, _>("finished_at").unwrap_or(None),
                "status": r.get::<String, _>("status"),
                "runner_id": r.try_get::<Option<String>, _>("runner_id").unwrap_or(None),
                "output": r.try_get::<Option<Value>, _>("output").unwrap_or(None),
                "error_message": r.try_get::<Option<String>, _>("error_message").unwrap_or(None),
                "duration_ms": r.try_get::<Option<i32>, _>("duration_ms").unwrap_or(None),
                "attempt_number": r.get::<i32, _>("attempt_number"),
                "triggered_by": r.get::<String, _>("triggered_by"),
            })
        })
        .collect();
    Ok(Json(out))
}

pub async fn stats(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Value>, AppError> {
    // 平台超管限制已移除：任何已认证用户均可查看全局统计。
    let _ = &claims;
    let total: (i64,) = sqlx::query_as("SELECT COUNT(*)::bigint FROM management.scheduled_tasks")
        .fetch_one(&pool)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let active: (i64,) = sqlx::query_as(
        "SELECT COUNT(*)::bigint FROM management.scheduled_tasks WHERE is_active = true",
    )
    .fetch_one(&pool)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;
    let runs_24h: (i64,) = sqlx::query_as(
        "SELECT COUNT(*)::bigint FROM management.scheduled_task_runs \
         WHERE started_at >= NOW() - INTERVAL '24 hours'",
    )
    .fetch_one(&pool)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;
    let failed_24h: (i64,) = sqlx::query_as(
        "SELECT COUNT(*)::bigint FROM management.scheduled_task_runs \
         WHERE started_at >= NOW() - INTERVAL '24 hours' AND status IN ('failed','timeout')",
    )
    .fetch_one(&pool)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(json!({
        "total_tasks": total.0,
        "active_tasks": active.0,
        "runs_24h": runs_24h.0,
        "failed_24h": failed_24h.0,
    })))
}

pub async fn validate_cron(
    Extension(_claims): Extension<Claims>,
    Json(req): Json<ValidateCronReq>,
) -> Result<Json<Value>, AppError> {
    let tz = req.timezone.unwrap_or_else(|| "UTC".to_string());
    let times = cron_parser::preview(&req.cron_expr, &tz, Utc::now(), 5)?;
    Ok(Json(json!({
        "valid": true,
        "timezone": tz,
        "preview": times,
    })))
}

pub async fn cleanup_zombies(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<CleanupZombiesReq>,
) -> Result<Json<Value>, AppError> {
    // 平台超管限制已移除：任何已认证用户均可清理僵尸 run。
    let _ = &claims;
    // 上限一年，防止误传 i64::MAX 触发 `INTERVAL` 溢出（Postgres `interval` 字段
    // 上限实际更宽，但语义上 cleanup 看一年外的 zombie 没意义，反倒掩盖运维问题）。
    let hours = req.older_than_hours.unwrap_or(24).clamp(1, 24 * 365);
    let res = sqlx::query(
        // 也把 duration_ms 补齐：marker 是"超时"，duration 取 started→现在作粗略值，
        // 否则前端聚合 avg(duration_ms) 时这批 zombie 会被当成 NULL 排除掉，
        // 拉低统计的代表性。
        "UPDATE management.scheduled_task_runs \
         SET status = 'timeout', \
             error_message = 'zombie cleanup', \
             finished_at = NOW(), \
             duration_ms = (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::int \
         WHERE status = 'running' AND started_at < NOW() - $1::int * INTERVAL '1 hour'",
    )
    .bind(hours as i32)
    .execute(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("清理失败: {e}")))?;
    Ok(Json(json!({"cleaned": res.rows_affected()})))
}

/// 试运行端点：不持久化任何 DB 行，直接调用对应 executor 跑一次，把 stdout/stderr/output
/// 返回给前端用于"创建前调试"。
///
/// 设计点：
///  - 与 create_task **同一份字段校验**（避免 dry-run 通过、save 失败这种迷惑情况）
///  - 共用 SchedulerRunner 持有的 executor Arc（同一份 reqwest::Client / 沙盒决议结果）
///  - 不写 scheduled_task_runs：避免污染统计 / 失败告警
///  - 超时模型与正式跑齐平：外层 `tokio::time::timeout(timeout_secs)`，timeout 时
///    shell 子进程靠 `kill_on_drop=true` 立即 SIGKILL（与正式路径同款保险丝）
pub async fn dry_run(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Extension(runner): Extension<Arc<SchedulerRunner>>,
    api_key_ctx: Option<Extension<ApiKeyContext>>,
    Json(mut req): Json<DryRunReq>,
) -> Result<Json<Value>, AppError> {
    fill_from_api_key_context(
        &mut req.tenant_id,
        &mut req.database_id,
        api_key_ctx.as_ref().map(|e| &e.0),
    );

    let kind = req.kind.as_str();
    if kind != "rpc" && kind != "http" && kind != "shell" && kind != "workflow" {
        return Err(AppError::InvalidQuery(
            "kind 必须是 rpc / http / shell / workflow".to_string(),
        ));
    }

    // 鉴权与 create_task 一致：先看能不能管理这个 tenant 范围。
    // shell 任务的"谁能跑"判定同样落在 validate_can_manage 上：
    //   - tenant_id=None → 平台超管
    //   - tenant_id=X    → 该租户 owner/admin（自 017 后租户级 shell 开放）
    validate_can_manage(&claims, req.tenant_id, &pool).await?;

    // kind 专属约束，与 create_task 同款（少了 cron / next_run_at 校验，因为 dry-run
    // 跟调度时刻无关）。
    if kind == "shell" {
        let script_ok = req
            .shell_script
            .as_deref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        if !script_ok {
            return Err(AppError::InvalidQuery(
                "shell 任务必须提供非空的 shell_script".to_string(),
            ));
        }
        if let Some(env) = &req.shell_env {
            if !env.is_object() {
                return Err(AppError::InvalidQuery(
                    "shell_env 必须是 JSON object".to_string(),
                ));
            }
        }
    } else if kind == "rpc" {
        if req.database_id.is_none() || req.rpc_schema.is_none() || req.rpc_fn_name.is_none() {
            return Err(AppError::InvalidQuery(
                "rpc 任务必须提供 database_id / rpc_schema / rpc_fn_name".to_string(),
            ));
        }
        validate_database_belongs_to_tenant(&pool, req.database_id.unwrap(), req.tenant_id).await?;
    } else if kind == "http" {
        if req.http_method.is_none() || req.http_url.is_none() {
            return Err(AppError::InvalidQuery(
                "http 任务必须提供 http_method / http_url".to_string(),
            ));
        }
    } else if kind == "workflow" {
        let tenant_id = req.tenant_id.ok_or_else(|| {
            AppError::InvalidQuery("工作流任务必须属于一个项目（tenant_id）".into())
        })?;
        let wf_id = req
            .workflow_id
            .ok_or_else(|| AppError::InvalidQuery("工作流任务必须提供 workflow_id".into()))?;
        let wf = load_enabled_workflow_for_tenant(&pool, wf_id, tenant_id).await?;
        let _ = workflow_input_or_empty(req.workflow_input.clone())?;
        return Ok(Json(json!({
            "dry_run": true,
            "ok": true,
            "kind": "workflow",
            "workflow_id": wf.id,
            "workflow_slug": wf.slug,
            "status": "success",
            "output": {
                "ok": true,
                "kind": "workflow",
                "workflow_id": wf.id,
                "workflow_slug": wf.slug,
            },
            "error_message": null,
            "duration_ms": 0,
        })));
    }

    // 试运行单次超时：上限沿用 schema 的 1..=86400（24h）；前端不传时默认 60。
    let timeout_secs = req.timeout_secs.unwrap_or(60).clamp(1, 86400);

    // HTTP secret 在正式路径里以 encrypted 形式存 DB，executor 读后解密；试运行没有
    // DB 写入，但为了让 HMAC 签名路径与正式路径一致，这里 in-memory 加密一遍再丢给
    // executor 自己解。多走一道 round-trip 是可以接受的代价（保证行为等价）。
    let http_secret_enc = match req.http_secret.as_deref() {
        Some(s) if !s.is_empty() => Some(crate::crypto::encrypt_secret(s)?),
        _ => None,
    };

    // 合成一份 in-memory ScheduledTask。`id=0` 是哨兵值，executor 不会因为读到 0 而做
    // 任何特殊处理 —— RpcExecutor 走 task.created_by 合成 claims，依然有 RBAC 检查。
    // claimed_at / next_run_at 等调度字段对 executor 不可见，置 None 即可。
    let now = Utc::now();
    let task = ScheduledTask {
        id: 0,
        tenant_id: req.tenant_id,
        name: "(dry-run)".to_string(),
        description: None,
        cron_expr: "* * * * *".to_string(),
        timezone: "UTC".to_string(),
        kind: kind.to_string(),
        database_id: req.database_id,
        rpc_schema: req.rpc_schema.clone(),
        rpc_fn_name: req.rpc_fn_name.clone(),
        rpc_args: req.rpc_args.clone(),
        http_method: req.http_method.as_deref().map(|s| s.to_uppercase()),
        http_url: req.http_url.clone(),
        http_headers: req.http_headers.clone(),
        http_body: req.http_body.clone(),
        http_secret_enc,
        shell_interpreter: req.shell_interpreter.clone(),
        shell_script: req.shell_script.clone(),
        shell_env: req.shell_env.clone(),
        shell_cwd: req.shell_cwd.clone(),
        workflow_id: req.workflow_id,
        workflow_slug: None,
        workflow_input: req.workflow_input.clone(),
        is_active: true,
        timeout_secs: timeout_secs,
        max_retries: 0,
        overlap_policy: "skip".to_string(),
        alert_webhook_url: None,
        alert_webhook_template: None,
        alert_throttle_hours: 24,
        last_alert_sent_at: None,
        next_run_at: None,
        last_run_at: None,
        last_run_status: None,
        claimed_at: None,
        claimed_by: None,
        created_by: claims.sub,
        created_by_name: None,
        created_by_email: None,
        created_at: now,
        updated_at: now,
    };

    let started_at = Utc::now();
    let exec_future: std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Value, String>> + Send>,
    > = match kind {
        "rpc" => {
            let rpc = runner.rpc_exec().clone();
            Box::pin(async move { rpc.execute(&task).await })
        }
        "http" => {
            let http = runner.http_exec().clone();
            Box::pin(async move { http.execute(&task).await })
        }
        "shell" => {
            let shell = runner.shell_exec().clone();
            Box::pin(async move { shell.execute(&task).await })
        }
        _ => unreachable!("kind 已在上面 match 过"),
    };

    let outcome = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs as u64),
        exec_future,
    )
    .await;
    let duration_ms = (Utc::now() - started_at).num_milliseconds().max(0) as i32;
    let (status, output, err_msg) = match outcome {
        Ok(Ok(v)) => ("success", Some(v), None),
        Ok(Err(e)) => ("failed", None, Some(e)),
        Err(_) => ("timeout", None, Some("execution timed out".to_string())),
    };

    Ok(Json(json!({
        "dry_run": true,
        "status": status,
        "output": output,
        "error_message": err_msg,
        "duration_ms": duration_ms,
    })))
}

// ─── 内部 helper ─────────────────────────────

async fn fetch_task_or_404(pool: &PgPool, id: i64) -> Result<ScheduledTask, AppError> {
    sqlx::query_as::<_, ScheduledTask>("SELECT * FROM management.scheduled_tasks WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| AppError::Internal(format!("查询任务失败: {e}")))?
        .ok_or_else(|| AppError::NotFound(format!("scheduled_task {id} 不存在")))
}

/// 永远不要把 `http_secret_enc` 密文回给客户端。
fn redact_secret(mut task: ScheduledTask) -> ScheduledTask {
    task.http_secret_enc = task.http_secret_enc.map(|_| "***".to_string());
    task
}
