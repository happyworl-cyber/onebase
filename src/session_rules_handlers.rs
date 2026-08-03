//! HTTP API：项目级 Session Rules CRUD。
//!
//! 详细设计见 `docs/superpowers/specs/2026-05-27-session-rules-design.md`。
//!
//! 关系图（运行期）：
//! ```text
//!   admin/前端 ──HTTP──▶  /api/admin/session-rules/:database_slug[/:id]
//!                              │
//!                              ▼   auth_middleware（注入 Claims）
//!                              ▼   permissions::require_database_admin
//!                              ▼   session_hooks::parse_hooks_from_value（严格校验）
//!                              ▼   management.session_rules 读写
//!                              ▼   AuditDetailSink → audit_logs（middleware 全局拦）
//! ```
//!
//! 路由清单：
//! - `GET    /api/admin/session-rules/:database_slug`
//! - `POST   /api/admin/session-rules/:database_slug`
//! - `GET    /api/admin/session-rules/:database_slug/:id`
//! - `PATCH  /api/admin/session-rules/:database_slug/:id`
//! - `DELETE /api/admin/session-rules/:database_slug/:id`
//!
//! 鉴权：全部走 `permissions::require_database_admin`——超管 + 该 database 所属
//! 租户的 owner/admin。viewer/member 不可见，因为 hooks 直接影响 RLS/权限决策，
//! 属于"租户级管理"操作，与 API Key 管理同级。
//!
//! 审计：
//! - 所有写请求（POST/PATCH/DELETE）由全局 `audit_middleware` 自动落
//!   `management.audit_logs`；
//! - handler 通过 `AuditDetailSink` 在 `request_body` 里塞结构化字段
//!   （`kind` / `rule_id` / `database_id` / `name` / `hooks` / `is_active`），
//!   middleware 会把 `kind` 升级为 `audit_logs.action` 列值
//!   （如 `SESSION_RULE.CREATE`），方便后续按 jsonb 索引 / 列过滤回溯。
//!
//! 校验失败的响应形态（区别于 AppError 的通用 schema）：
//! ```json
//! {
//!   "error": "hooks 校验失败",
//!   "code": "validation_error",
//!   "details": [
//!     { "index": 1, "field": "header", "reason": "header 不能为空字符串" },
//!     { "index": 2, "field": "guc",    "reason": "GUC 名 'role' 非法..." }
//!   ]
//! }
//! ```
//! 422 + `details` 数组让前端能逐条标红到对应 hook 行，比单字符串错误信息友好。

use axum::{
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};

use crate::audit_middleware::AuditDetailSink;
use crate::auth::Claims;
use crate::error::{AppError, Result};
use crate::permissions;
use crate::session_hooks::{parse_hooks_from_value, HookParseError};

// ─── Request 形状 ──────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreateRuleReq {
    pub name: String,
    pub description: Option<String>,
    /// 默认 true：创建即生效。前端可显式置 false 做"草稿态"。
    pub is_active: Option<bool>,
    /// hooks 数组本身，**不是**包在 `{"session_hooks": [...]}` 里的对象。
    /// 与 API Key permissions 的 inline 字段一致，便于运维直接复制粘贴。
    pub hooks: Value,
}

#[derive(Debug, Deserialize)]
pub struct UpdateRuleReq {
    pub name: Option<String>,
    pub description: Option<String>,
    pub is_active: Option<bool>,
    pub hooks: Option<Value>,
}

// ─── Helpers ──────────────────────────────────────────────────────────

/// 把严格解析的 `Vec<HookParseError>` 包成 422 响应。
///
/// 不走 `AppError`：那条通道只能塞单一 message，丢掉了"哪一行 / 哪个字段错"
/// 的结构。前端拿到 422 + `details[]` 可以逐条把错误标到表单行。
fn hook_validation_response(errors: Vec<HookParseError>) -> Response {
    let body = Json(json!({
        "error": "hooks 校验失败",
        "code": "validation_error",
        "details": errors,
    }));
    (StatusCode::UNPROCESSABLE_ENTITY, body).into_response()
}

/// 把 row 映射成对外 JSON。统一在一处，避免每个 handler 重复拼字段名。
fn row_to_json(r: &sqlx::postgres::PgRow) -> Value {
    json!({
        "id":          r.get::<i64, _>("id"),
        "database_slug": r.get::<String, _>("database_slug"),
        "name":        r.get::<String, _>("name"),
        "description": r.get::<Option<String>, _>("description"),
        "is_active":   r.get::<bool, _>("is_active"),
        "hooks":       r.get::<Value, _>("hooks"),
        "created_by":  r.get::<i32, _>("created_by"),
        "created_at":  r.get::<chrono::DateTime<chrono::Utc>, _>("created_at").to_rfc3339(),
        "updated_at":  r.get::<chrono::DateTime<chrono::Utc>, _>("updated_at").to_rfc3339(),
    })
}

/// 给 audit_middleware 喂结构化字段。`kind` 会被 middleware 升级成
/// `audit_logs.action`（比如 `kind="session_rule.create"` →
/// `action="SESSION_RULE.CREATE"`），便于按列过滤。
fn audit_detail(
    sink: &Option<Extension<AuditDetailSink>>,
    kind: &str,
    database_id: i32,
    rule_id: Option<i64>,
    extra: Value,
) {
    if let Some(Extension(s)) = sink {
        s.set(json!({
            "kind": kind,
            "database_id": database_id,
            "rule_id": rule_id,
            "detail": extra,
        }));
    }
}

// ─── Handlers ──────────────────────────────────────────────────────────

/// `GET /api/admin/session-rules/:database_slug`
///
/// 列出该项目下的全部 rules。鉴权：超管 + 项目 owner/admin。
pub async fn list_rules(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(database_slug): Path<String>,
) -> Result<Json<Value>> {
    let database_id =
        permissions::resolve_database_id_by_slug_for_claims(&pool, &claims, &database_slug).await?;
    permissions::require_database_admin(&pool, &claims, database_id).await?;

    let rows = sqlx::query(
        "SELECT sr.id, td.slug AS database_slug, sr.name, sr.description, sr.is_active, sr.hooks, \
                sr.created_by, sr.created_at, sr.updated_at \
         FROM management.session_rules sr \
         JOIN management.tenant_databases td ON td.id = sr.database_id \
         WHERE sr.database_id = $1 \
         ORDER BY sr.id ASC",
    )
    .bind(database_id)
    .fetch_all(&pool)
    .await?;

    let data: Vec<Value> = rows.iter().map(row_to_json).collect();
    Ok(Json(json!({ "data": data })))
}

/// `GET /api/admin/session-rules/:database_slug/:id`
///
/// 取单条规则（详情页用）。404 时给出明确的资源名。
pub async fn get_rule(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((database_slug, id)): Path<(String, i64)>,
) -> Result<Json<Value>> {
    let database_id =
        permissions::resolve_database_id_by_slug_for_claims(&pool, &claims, &database_slug).await?;
    permissions::require_database_admin(&pool, &claims, database_id).await?;

    let row = sqlx::query(
        "SELECT sr.id, td.slug AS database_slug, sr.name, sr.description, sr.is_active, sr.hooks, \
                sr.created_by, sr.created_at, sr.updated_at \
         FROM management.session_rules sr \
         JOIN management.tenant_databases td ON td.id = sr.database_id \
         WHERE sr.database_id = $1 AND sr.id = $2",
    )
    .bind(database_id)
    .bind(id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("session rule {} 不存在", id)))?;

    Ok(Json(row_to_json(&row)))
}

/// `POST /api/admin/session-rules/:database_slug`
///
/// 创建一条规则。`hooks` 字段必须是严格合法的 hooks JSON 数组；任何条目失败
/// 都会以 422 + `details[]` 形式被一次性返回，方便前端逐条标红。
///
/// 重名（同 database_id + name）由 `session_rules_name_db_unique` 约束兜底，
/// 通过 `classify_db_error` 落成 409 `unique_violation`，前端给"项目内已存在
/// 同名规则"的提示。
pub async fn create_rule(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    audit_sink: Option<Extension<AuditDetailSink>>,
    Path(database_slug): Path<String>,
    Json(req): Json<CreateRuleReq>,
) -> std::result::Result<Response, AppError> {
    let database_id =
        permissions::resolve_database_id_by_slug_for_claims(&pool, &claims, &database_slug).await?;
    permissions::require_database_admin(&pool, &claims, database_id).await?;

    let trimmed_name = req.name.trim();
    if trimmed_name.is_empty() {
        return Err(AppError::InvalidQuery("name 不能为空".to_string()));
    }
    if trimmed_name.len() > 100 {
        return Err(AppError::InvalidQuery(
            "name 长度超过 100 个字符".to_string(),
        ));
    }

    if let Err(errors) = parse_hooks_from_value(&req.hooks) {
        return Ok(hook_validation_response(errors));
    }

    let is_active = req.is_active.unwrap_or(true);

    let row = sqlx::query(
        "INSERT INTO management.session_rules \
             (database_id, name, description, is_active, hooks, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6) \
         RETURNING id, \
                   (SELECT slug FROM management.tenant_databases WHERE id = database_id) AS database_slug, \
                   name, description, is_active, hooks, \
                   created_by, created_at, updated_at",
    )
    .bind(database_id)
    .bind(trimmed_name)
    .bind(req.description.as_deref())
    .bind(is_active)
    .bind(&req.hooks)
    .bind(claims.sub)
    .fetch_one(&pool)
    .await?;

    let json_row = row_to_json(&row);
    let new_id = json_row["id"].as_i64();
    audit_detail(
        &audit_sink,
        "session_rule.create",
        database_id,
        new_id,
        json!({
            "name": trimmed_name,
            "is_active": is_active,
            "hooks": req.hooks,
        }),
    );

    Ok((StatusCode::CREATED, Json(json_row)).into_response())
}

/// `PATCH /api/admin/session-rules/:database_slug/:id`
///
/// 局部更新。只要任何字段被赋值，就会写回新值；hooks 仍走严格校验。
///
/// 同 create：重名走 unique constraint → 409。
pub async fn update_rule(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    audit_sink: Option<Extension<AuditDetailSink>>,
    Path((database_slug, id)): Path<(String, i64)>,
    Json(req): Json<UpdateRuleReq>,
) -> std::result::Result<Response, AppError> {
    let database_id =
        permissions::resolve_database_id_by_slug_for_claims(&pool, &claims, &database_slug).await?;
    permissions::require_database_admin(&pool, &claims, database_id).await?;

    if let Some(ref name) = req.name {
        let t = name.trim();
        if t.is_empty() {
            return Err(AppError::InvalidQuery("name 不能为空".to_string()));
        }
        if t.len() > 100 {
            return Err(AppError::InvalidQuery(
                "name 长度超过 100 个字符".to_string(),
            ));
        }
    }
    if let Some(ref hooks) = req.hooks {
        if let Err(errors) = parse_hooks_from_value(hooks) {
            return Ok(hook_validation_response(errors));
        }
    }

    // COALESCE 让"只传想改的字段"成为默认行为，其它字段保留旧值。
    // 注意：与 scheduler_handlers::update_task 同款取舍——`Json<UpdateRuleReq>` 反序列化
    // 时不区分"字段缺省"和"字段=null"，统一映射成 `None`，因此**无法**表达"显式清空"
    // 语义。给 session_rules 来说这够用：description 留旧值不影响功能；要清空走前端
    // "改成空字符串"的常规交互即可。
    let row = sqlx::query(
        "UPDATE management.session_rules SET \
             name        = COALESCE($1, name), \
             description = COALESCE($2, description), \
             is_active   = COALESCE($3, is_active), \
             hooks       = COALESCE($4, hooks), \
             updated_at  = NOW() \
         WHERE database_id = $5 AND id = $6 \
         RETURNING id, \
                   (SELECT slug FROM management.tenant_databases WHERE id = database_id) AS database_slug, \
                   name, description, is_active, hooks, \
                   created_by, created_at, updated_at",
    )
    .bind(req.name.as_ref().map(|s| s.trim().to_string()))
    .bind(req.description.as_deref())
    .bind(req.is_active)
    .bind(req.hooks.as_ref())
    .bind(database_id)
    .bind(id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("session rule {} 不存在", id)))?;

    let json_row = row_to_json(&row);
    audit_detail(
        &audit_sink,
        "session_rule.update",
        database_id,
        Some(id),
        json!({
            "name_changed":        req.name.is_some(),
            "description_changed": req.description.is_some(),
            "is_active_changed":   req.is_active.is_some(),
            "hooks_changed":       req.hooks.is_some(),
            "new_name":            json_row["name"],
            "new_is_active":       json_row["is_active"],
            "new_hooks":           req.hooks.unwrap_or(json!(null)),
        }),
    );

    Ok((StatusCode::OK, Json(json_row)).into_response())
}

/// `DELETE /api/admin/session-rules/:database_slug/:id`
///
/// 物理删除。session_rules 与 audit_logs 解耦——审计走 middleware，删行后
/// 历史轨迹仍在 audit_logs 里查得到。
pub async fn delete_rule(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    audit_sink: Option<Extension<AuditDetailSink>>,
    Path((database_slug, id)): Path<(String, i64)>,
) -> Result<Json<Value>> {
    let database_id =
        permissions::resolve_database_id_by_slug_for_claims(&pool, &claims, &database_slug).await?;
    permissions::require_database_admin(&pool, &claims, database_id).await?;

    let result =
        sqlx::query("DELETE FROM management.session_rules WHERE database_id = $1 AND id = $2")
            .bind(database_id)
            .bind(id)
            .execute(&pool)
            .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("session rule {} 不存在", id)));
    }

    audit_detail(
        &audit_sink,
        "session_rule.delete",
        database_id,
        Some(id),
        json!({}),
    );

    Ok(Json(json!({ "deleted": true, "id": id })))
}
