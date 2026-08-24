use axum::{
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
use crate::workflow_taxonomy::SHARED_DEPARTMENT;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct WorkflowFolder {
    pub id: i32,
    pub database_id: i32,
    pub parent_id: Option<i32>,
    pub name: String,
    pub sort_order: i32,
    pub is_shared: bool,
    #[serde(serialize_with = "crate::models::serialize_naive_as_utc")]
    pub created_at: chrono::NaiveDateTime,
    #[serde(serialize_with = "crate::models::serialize_naive_as_utc")]
    pub updated_at: chrono::NaiveDateTime,
}

#[derive(Debug, Deserialize)]
pub struct CreateWorkflowFolderRequest {
    pub database_id: i32,
    pub parent_id: Option<i32>,
    pub name: String,
    pub sort_order: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateWorkflowFolderRequest {
    pub name: Option<String>,
    pub sort_order: Option<i32>,
    /// 移动分类文件夹到另一部门；传 `null` 仅对部门节点无效（部门 parent 恒为 NULL）
    pub parent_id: Option<Option<i32>>,
}

fn trim_name(name: &str) -> Result<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidQuery("文件夹名称不能为空".to_string()));
    }
    if trimmed.contains('/') {
        return Err(AppError::InvalidQuery("文件夹名称不能包含 '/'".to_string()));
    }
    if trimmed.chars().count() > 64 {
        return Err(AppError::InvalidQuery(
            "文件夹名称不能超过 64 个字符".to_string(),
        ));
    }
    Ok(trimmed.to_string())
}

async fn fetch_folder(pool: &PgPool, id: i32) -> Result<WorkflowFolder> {
    sqlx::query_as::<_, WorkflowFolder>("SELECT * FROM management.workflow_folders WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("文件夹 {} 不存在", id)))
}

/// GET /api/admin/workflow-folders?database_id=
pub async fn list_workflow_folders(
    State(pool): State<PgPool>,
    Query(params): Query<HashMap<String, String>>,
    axum::Extension(claims): axum::Extension<Claims>,
) -> Result<Json<Value>> {
    let database_id: i32 = params
        .get("database_id")
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| AppError::InvalidQuery("缺少 database_id".to_string()))?;

    crate::permissions::require_database_admin(&pool, &claims, database_id).await?;

    let folders = sqlx::query_as::<_, WorkflowFolder>(
        r#"SELECT * FROM management.workflow_folders
           WHERE database_id = $1
           ORDER BY COALESCE(parent_id, 0), sort_order, name"#,
    )
    .bind(database_id)
    .fetch_all(&pool)
    .await?;

    Ok(Json(json!({ "folders": folders, "total": folders.len() })))
}

/// POST /api/admin/workflow-folders
pub async fn create_workflow_folder(
    State(pool): State<PgPool>,
    axum::Extension(claims): axum::Extension<Claims>,
    Json(req): Json<CreateWorkflowFolderRequest>,
) -> Result<(StatusCode, Json<Value>)> {
    crate::permissions::require_database_admin(&pool, &claims, req.database_id).await?;

    let name = trim_name(&req.name)?;
    let is_shared = req.parent_id.is_none() && name == SHARED_DEPARTMENT;

    if is_shared {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM management.workflow_folders WHERE database_id = $1 AND parent_id IS NULL AND name = $2)",
        )
        .bind(req.database_id)
        .bind(SHARED_DEPARTMENT)
        .fetch_one(&pool)
        .await?;
        if exists {
            return Err(AppError::InvalidQuery(
                "共享服务已存在，每个项目库仅允许一个".to_string(),
            ));
        }
    }

    if let Some(parent_id) = req.parent_id {
        let parent = fetch_folder(&pool, parent_id).await?;
        if parent.database_id != req.database_id {
            return Err(AppError::InvalidQuery(
                "parent_id 与 database_id 不匹配".to_string(),
            ));
        }
        if parent.parent_id.is_some() {
            return Err(AppError::InvalidQuery(
                "分类文件夹下不能再建子文件夹（仅支持 服务 → 分类 两级）".to_string(),
            ));
        }
    }

    let folder = sqlx::query_as::<_, WorkflowFolder>(
        r#"INSERT INTO management.workflow_folders (database_id, parent_id, name, sort_order, is_shared)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *"#,
    )
    .bind(req.database_id)
    .bind(req.parent_id)
    .bind(&name)
    .bind(req.sort_order.unwrap_or(if is_shared { -100 } else { 0 }))
    .bind(is_shared)
    .fetch_one(&pool)
    .await
    .map_err(|e| {
        if e.to_string().contains("idx_workflow_folders_unique_name") {
            AppError::InvalidQuery(format!("文件夹「{}」已存在", name))
        } else {
            AppError::from(e)
        }
    })?;

    Ok((StatusCode::CREATED, Json(json!({ "folder": folder }))))
}

/// PATCH /api/admin/workflow-folders/:id
pub async fn update_workflow_folder(
    State(pool): State<PgPool>,
    Path(id): Path<i32>,
    axum::Extension(claims): axum::Extension<Claims>,
    Json(req): Json<UpdateWorkflowFolderRequest>,
) -> Result<Json<Value>> {
    let existing = fetch_folder(&pool, id).await?;
    crate::permissions::require_database_admin(&pool, &claims, existing.database_id).await?;

    let name = if let Some(ref n) = req.name {
        Some(trim_name(n)?)
    } else {
        None
    };

    let (parent_provided, new_parent_id) = if let Some(parent_opt) = req.parent_id {
        if existing.is_shared && existing.parent_id.is_none() {
            return Err(AppError::InvalidQuery("共享服务不可移动".to_string()));
        }
        match parent_opt {
            None => {
                if existing.parent_id.is_some() {
                    return Err(AppError::InvalidQuery(
                        "分类文件夹必须归属某个服务".to_string(),
                    ));
                }
                (true, None)
            }
            Some(parent_id) => {
                if existing.parent_id.is_none() {
                    return Err(AppError::InvalidQuery(
                        "服务文件夹不能挂到其他服务下".to_string(),
                    ));
                }
                let parent = fetch_folder(&pool, parent_id).await?;
                if parent.database_id != existing.database_id {
                    return Err(AppError::InvalidQuery(
                        "parent_id 与 database_id 不匹配".to_string(),
                    ));
                }
                if parent.parent_id.is_some() {
                    return Err(AppError::InvalidQuery(
                        "分类只能移动到服务节点下".to_string(),
                    ));
                }
                if parent.id == id {
                    return Err(AppError::InvalidQuery("不能将文件夹移动到自身".to_string()));
                }
                (true, Some(parent_id))
            }
        }
    } else {
        (false, existing.parent_id)
    };

    let folder = sqlx::query_as::<_, WorkflowFolder>(
        r#"UPDATE management.workflow_folders SET
            name = COALESCE($2, name),
            sort_order = COALESCE($3, sort_order),
            parent_id = CASE WHEN $5 THEN $4 ELSE parent_id END,
            updated_at = NOW()
           WHERE id = $1
           RETURNING *"#,
    )
    .bind(id)
    .bind(&name)
    .bind(req.sort_order)
    .bind(new_parent_id)
    .bind(parent_provided)
    .fetch_one(&pool)
    .await
    .map_err(|e| {
        if e.to_string().contains("idx_workflow_folders_unique_name") {
            AppError::InvalidQuery("目标服务下已存在同名文件夹".to_string())
        } else {
            AppError::from(e)
        }
    })?;

    Ok(Json(json!({ "folder": folder })))
}

/// DELETE /api/admin/workflow-folders/:id
pub async fn delete_workflow_folder(
    State(pool): State<PgPool>,
    Path(id): Path<i32>,
    axum::Extension(claims): axum::Extension<Claims>,
) -> Result<Json<Value>> {
    let existing = fetch_folder(&pool, id).await?;
    crate::permissions::require_database_admin(&pool, &claims, existing.database_id).await?;

    if existing.is_shared {
        return Err(AppError::InvalidQuery("共享服务不可删除".to_string()));
    }

    let child_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM management.workflow_folders WHERE parent_id = $1")
            .bind(id)
            .fetch_one(&pool)
            .await?;

    if child_count > 0 {
        return Err(AppError::InvalidQuery(
            "请先删除该服务下的分类文件夹".to_string(),
        ));
    }

    sqlx::query("DELETE FROM management.workflow_folders WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await?;

    Ok(Json(json!({ "message": "文件夹已删除", "id": id })))
}
