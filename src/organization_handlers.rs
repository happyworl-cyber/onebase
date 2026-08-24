//! Organization（产品「租户/组织」）API
//!
//! 层级：Organization → Project(`management.tenants`) → 资源。
//! `tenant_id` / `X-Tenant-Id` 仍表示 project id。

use crate::auth::Claims;
use crate::error::{AppError, Result};
use crate::permissions;
use crate::redis_manager::RedisManager;
use crate::tenant_handlers::{self, ProvisionRequest};
use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::{PgPool, Row};

fn is_valid_slug(s: &str) -> bool {
    if s.is_empty() || s.len() > 50 {
        return false;
    }
    let first = match s.chars().next() {
        Some(c) => c,
        None => return false,
    };
    if !first.is_ascii_lowercase() {
        return false;
    }
    s.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn validate_org_role(role: &str) -> Result<()> {
    match role {
        "owner" | "admin" | "member" => Ok(()),
        _ => Err(AppError::InvalidQuery(format!(
            "无效组织角色 '{}'，必须是 owner / admin / member 之一",
            role
        ))),
    }
}

fn org_row_json(r: &sqlx::postgres::PgRow, user_role: &str) -> serde_json::Value {
    json!({
        "id": r.get::<i32, _>("id"),
        "name": r.get::<String, _>("name"),
        "slug": r.get::<String, _>("slug"),
        "status": r.get::<String, _>("status"),
        "contact_email": r.try_get::<Option<String>, _>("contact_email").ok().flatten(),
        "user_role": user_role,
    })
}

/// GET /api/organizations
pub async fn list_organizations(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<serde_json::Value>> {
    let rows = if claims.is_superadmin {
        // 平台视角：含 suspended，不含已删除
        sqlx::query(
            r#"
            SELECT id, name, slug, status, contact_email
            FROM management.organizations
            WHERE status <> 'deleted'
            ORDER BY id DESC
            "#,
        )
        .fetch_all(&pool)
        .await?
    } else {
        sqlx::query(
            r#"
            SELECT o.id, o.name, o.slug, o.status, o.contact_email, om.role AS user_role
            FROM management.organizations o
            JOIN management.organization_members om
              ON om.organization_id = o.id AND om.is_active = true
            WHERE om.user_id = $1 AND o.status = 'active'
            ORDER BY o.id DESC
            "#,
        )
        .bind(claims.sub)
        .fetch_all(&pool)
        .await?
    };

    let organizations: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            let role = if claims.is_superadmin {
                "superadmin".to_string()
            } else {
                r.get::<String, _>("user_role")
            };
            org_row_json(r, &role)
        })
        .collect();

    Ok(Json(json!({ "organizations": organizations })))
}

#[derive(Deserialize)]
pub struct CreateOrganizationRequest {
    pub name: String,
    pub slug: String,
    pub contact_email: Option<String>,
    /// 可选：指定首个 owner；不传则组织暂无成员，由平台稍后加人
    pub owner_user_id: Option<i32>,
}

/// POST /api/organizations — **仅平台超管**可创建租户
pub async fn create_organization(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<CreateOrganizationRequest>,
) -> Result<Json<serde_json::Value>> {
    if !claims.is_superadmin {
        return Err(AppError::Forbidden(
            "仅平台超管可以创建租户，请联系平台管理员".to_string(),
        ));
    }

    let name = req.name.trim();
    let slug = req.slug.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(AppError::InvalidQuery("name 必须 1-100 字符".to_string()));
    }
    if !is_valid_slug(slug) {
        return Err(AppError::InvalidQuery(
            "slug 必须 1-50 字符，首字符小写字母，仅含 [a-z0-9_-]".to_string(),
        ));
    }

    if let Some(owner_id) = req.owner_user_id {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
            .bind(owner_id)
            .fetch_one(&pool)
            .await?;
        if !exists {
            return Err(AppError::NotFound(format!("用户 {} 不存在", owner_id)));
        }
    }

    let mut tx = pool.begin().await?;
    let row = sqlx::query(
        r#"
        INSERT INTO management.organizations (name, slug, status, contact_email)
        VALUES ($1, $2, 'active', $3)
        RETURNING id, name, slug, status, contact_email
        "#,
    )
    .bind(name)
    .bind(slug)
    .bind(req.contact_email.as_deref())
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| match &e {
        sqlx::Error::Database(db) if db.constraint() == Some("organizations_slug_key") => {
            AppError::InvalidQuery(format!("slug '{}' 已被占用", slug))
        }
        _ => AppError::Database(e),
    })?;

    let org_id: i32 = row.get("id");
    if let Some(owner_id) = req.owner_user_id {
        sqlx::query(
            r#"
            INSERT INTO management.organization_members (user_id, organization_id, role, is_active)
            VALUES ($1, $2, 'owner', true)
            "#,
        )
        .bind(owner_id)
        .bind(org_id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    Ok(Json(json!({
        "organization": org_row_json(&row, "superadmin"),
    })))
}

/// GET /api/organizations/:id
pub async fn get_organization(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(organization_id): Path<i32>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_organization_member(&pool, &claims, organization_id).await?;

    let row = sqlx::query(
        r#"
        SELECT id, name, slug, status, contact_email
        FROM management.organizations
        WHERE id = $1 AND status <> 'deleted'
        "#,
    )
    .bind(organization_id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("组织 {} 不存在", organization_id)))?;

    let status: String = row.get("status");
    if status != "active" && !claims.is_superadmin {
        return Err(AppError::Forbidden(format!(
            "租户 {} 已停用，请联系平台管理员",
            organization_id
        )));
    }

    let user_role = if claims.is_superadmin {
        "superadmin".to_string()
    } else {
        sqlx::query_scalar::<_, String>(
            r#"
            SELECT role FROM management.organization_members
            WHERE user_id = $1 AND organization_id = $2 AND is_active = true
            "#,
        )
        .bind(claims.sub)
        .bind(organization_id)
        .fetch_one(&pool)
        .await?
    };

    Ok(Json(json!({
        "organization": org_row_json(&row, &user_role),
    })))
}

#[derive(Deserialize)]
pub struct PatchOrganizationRequest {
    pub name: Option<String>,
    pub contact_email: Option<String>,
    /// active | suspended | deleted — 仅平台超管可改状态
    pub status: Option<String>,
}

/// PATCH /api/organizations/:id — owner 可改信息；超管还可改 status
pub async fn patch_organization(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(organization_id): Path<i32>,
    Json(req): Json<PatchOrganizationRequest>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_organization_owner(&pool, &claims, organization_id).await?;

    if req.name.is_none() && req.contact_email.is_none() && req.status.is_none() {
        return Err(AppError::InvalidQuery(
            "至少提供 name、contact_email 或 status 之一".to_string(),
        ));
    }
    if let Some(ref name) = req.name {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 100 {
            return Err(AppError::InvalidQuery("name 必须 1-100 字符".to_string()));
        }
    }
    if let Some(ref status) = req.status {
        if !claims.is_superadmin {
            return Err(AppError::Forbidden(
                "仅平台超管可以修改租户状态".to_string(),
            ));
        }
        if !["active", "suspended", "deleted"].contains(&status.as_str()) {
            return Err(AppError::InvalidQuery(
                "status 必须是 active / suspended / deleted".to_string(),
            ));
        }
    }

    let row = sqlx::query(
        r#"
        UPDATE management.organizations
        SET
          name = COALESCE($2, name),
          contact_email = COALESCE($3, contact_email),
          status = COALESCE($4, status),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status <> 'deleted'
        RETURNING id, name, slug, status, contact_email
        "#,
    )
    .bind(organization_id)
    .bind(req.name.as_deref().map(|s| s.trim()))
    .bind(req.contact_email.as_deref())
    .bind(req.status.as_deref())
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("组织 {} 不存在", organization_id)))?;

    let role = if claims.is_superadmin {
        "superadmin".to_string()
    } else {
        "owner".to_string()
    };

    Ok(Json(json!({
        "organization": org_row_json(&row, &role),
    })))
}

/// GET /api/organizations/:id/members
pub async fn list_organization_members(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(organization_id): Path<i32>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_organization_member(&pool, &claims, organization_id).await?;

    let rows = sqlx::query(
        r#"
        SELECT u.id AS user_id, u.username, u.email,
               COALESCE(u.is_superadmin, false) AS is_superadmin,
               COALESCE(u.is_active, true) AS is_active,
               om.role, om.created_at
        FROM management.organization_members om
        JOIN users u ON u.id = om.user_id
        WHERE om.organization_id = $1 AND om.is_active = true
        ORDER BY
          CASE om.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
          om.created_at
        "#,
    )
    .bind(organization_id)
    .fetch_all(&pool)
    .await?;

    let members: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            json!({
                "user_id": r.get::<i32, _>("user_id"),
                "username": r.get::<String, _>("username"),
                "email": r.get::<String, _>("email"),
                "is_superadmin": r.get::<bool, _>("is_superadmin"),
                "is_active": r.get::<bool, _>("is_active"),
                "role": r.get::<String, _>("role"),
                "created_at": crate::models::naive_to_utc_string(
                    r.get::<chrono::NaiveDateTime, _>("created_at")
                ),
            })
        })
        .collect();

    Ok(Json(json!({ "members": members })))
}

#[derive(Deserialize)]
pub struct OrgMemberSearchQuery {
    pub q: Option<String>,
}

/// GET /api/organizations/:id/member-candidates?q=
///
/// 租户 admin+ 搜索尚未加入本租户的平台用户（按 username/email）。
pub async fn search_organization_member_candidates(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(organization_id): Path<i32>,
    Query(q): Query<OrgMemberSearchQuery>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_organization_admin(&pool, &claims, organization_id).await?;

    let keyword = q.q.as_deref().unwrap_or("").trim();
    if keyword.chars().count() < 2 {
        return Ok(Json(json!({ "candidates": [] })));
    }

    let escaped = keyword
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let like = format!("%{}%", escaped);

    let rows = sqlx::query(
        r#"
        SELECT u.id AS user_id, u.username, u.email,
               COALESCE(u.is_superadmin, false) AS is_superadmin
        FROM users u
        WHERE (u.username ILIKE $1 ESCAPE '\' OR u.email ILIKE $1 ESCAPE '\')
          AND NOT EXISTS (
            SELECT 1 FROM management.organization_members om
            WHERE om.user_id = u.id AND om.organization_id = $2 AND om.is_active = true
          )
        ORDER BY
          CASE
            WHEN lower(u.username) = lower($3) OR lower(u.email) = lower($3) THEN 0
            WHEN lower(u.username) LIKE lower($3) || '%' OR lower(u.email) LIKE lower($3) || '%' THEN 1
            ELSE 2
          END,
          u.username ASC
        LIMIT 20
        "#,
    )
    .bind(&like)
    .bind(organization_id)
    .bind(keyword)
    .fetch_all(&pool)
    .await?;

    let candidates: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            json!({
                "user_id": r.get::<i32, _>("user_id"),
                "username": r.get::<String, _>("username"),
                "email": r.get::<String, _>("email"),
                "is_superadmin": r.get::<bool, _>("is_superadmin"),
            })
        })
        .collect();

    Ok(Json(json!({ "candidates": candidates })))
}

#[derive(Deserialize)]
pub struct AddOrgMemberRequest {
    pub user_id: i32,
    pub role: String,
}

/// POST /api/organizations/:id/members
pub async fn add_organization_member(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(organization_id): Path<i32>,
    Json(req): Json<AddOrgMemberRequest>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_organization_admin(&pool, &claims, organization_id).await?;
    validate_org_role(&req.role)?;
    // 授予 owner 仅限现有 owner（或超管）；admin 不能自行造 owner
    if req.role == "owner" {
        permissions::require_organization_owner(&pool, &claims, organization_id).await?;
    }

    let user_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
        .bind(req.user_id)
        .fetch_one(&pool)
        .await?;
    if !user_exists {
        return Err(AppError::NotFound(format!("用户 {} 不存在", req.user_id)));
    }

    sqlx::query(
        r#"
        INSERT INTO management.organization_members (user_id, organization_id, role, is_active)
        VALUES ($1, $2, $3, true)
        ON CONFLICT (user_id, organization_id)
        DO UPDATE SET role = $3, is_active = true
        "#,
    )
    .bind(req.user_id)
    .bind(organization_id)
    .bind(&req.role)
    .execute(&pool)
    .await?;

    Ok(Json(json!({
        "ok": true,
        "user_id": req.user_id,
        "organization_id": organization_id,
        "role": req.role,
    })))
}

#[derive(Deserialize)]
pub struct UpdateOrgMemberRequest {
    pub role: String,
}

/// PATCH /api/organizations/:id/members/:user_id
pub async fn update_organization_member(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((organization_id, user_id)): Path<(i32, i32)>,
    Json(req): Json<UpdateOrgMemberRequest>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_organization_admin(&pool, &claims, organization_id).await?;
    validate_org_role(&req.role)?;

    if user_id == claims.sub && !claims.is_superadmin {
        return Err(AppError::Forbidden("不能修改自己的组织角色".to_string()));
    }

    // 升为 owner、或改动现有 owner 的角色，仅限组织 owner / 超管
    let current: Option<String> = sqlx::query_scalar(
        r#"
        SELECT role FROM management.organization_members
        WHERE organization_id = $1 AND user_id = $2 AND is_active = true
        "#,
    )
    .bind(organization_id)
    .bind(user_id)
    .fetch_optional(&pool)
    .await?;
    if req.role == "owner" || current.as_deref() == Some("owner") {
        permissions::require_organization_owner(&pool, &claims, organization_id).await?;
    }

    if req.role != "owner" {
        let owners: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*) FROM management.organization_members
            WHERE organization_id = $1 AND is_active = true AND role = 'owner'
              AND user_id <> $2
            "#,
        )
        .bind(organization_id)
        .bind(user_id)
        .fetch_one(&pool)
        .await?;
        if current.as_deref() == Some("owner") && owners == 0 {
            return Err(AppError::InvalidQuery(
                "不能降级组织的最后一个 owner".to_string(),
            ));
        }
    }

    let n = sqlx::query(
        r#"
        UPDATE management.organization_members
        SET role = $3
        WHERE organization_id = $1 AND user_id = $2 AND is_active = true
        "#,
    )
    .bind(organization_id)
    .bind(user_id)
    .bind(&req.role)
    .execute(&pool)
    .await?
    .rows_affected();

    if n == 0 {
        return Err(AppError::NotFound("组织成员不存在".to_string()));
    }

    Ok(Json(json!({
        "ok": true,
        "user_id": user_id,
        "organization_id": organization_id,
        "role": req.role,
    })))
}

/// DELETE /api/organizations/:id/members/:user_id
pub async fn remove_organization_member(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((organization_id, user_id)): Path<(i32, i32)>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_organization_admin(&pool, &claims, organization_id).await?;

    if user_id == claims.sub && !claims.is_superadmin {
        return Err(AppError::Forbidden("不能移除自己".to_string()));
    }

    let role: Option<String> = sqlx::query_scalar(
        r#"
        SELECT role FROM management.organization_members
        WHERE organization_id = $1 AND user_id = $2 AND is_active = true
        "#,
    )
    .bind(organization_id)
    .bind(user_id)
    .fetch_optional(&pool)
    .await?;

    let Some(role) = role else {
        return Err(AppError::NotFound("组织成员不存在".to_string()));
    };

    if role == "owner" {
        let other_owners: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*) FROM management.organization_members
            WHERE organization_id = $1 AND is_active = true AND role = 'owner'
              AND user_id <> $2
            "#,
        )
        .bind(organization_id)
        .bind(user_id)
        .fetch_one(&pool)
        .await?;
        if other_owners == 0 {
            return Err(AppError::InvalidQuery(
                "不能移除组织的最后一个 owner".to_string(),
            ));
        }
    }

    // 软移除组织成员，并停用该组织下所有项目成员关系
    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"
        UPDATE management.organization_members
        SET is_active = false
        WHERE organization_id = $1 AND user_id = $2
        "#,
    )
    .bind(organization_id)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        UPDATE management.user_tenants ut
        SET is_active = false
        FROM management.tenants t
        WHERE ut.tenant_id = t.id
          AND t.organization_id = $1
          AND ut.user_id = $2
        "#,
    )
    .bind(organization_id)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct OrgProjectsQuery {
    /// `all`：org admin+ 看租户下全部项目；默认只看自己加入的
    pub view: Option<String>,
}

/// GET /api/organizations/:id/projects
pub async fn list_organization_projects(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(organization_id): Path<i32>,
    Query(q): Query<OrgProjectsQuery>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_organization_member(&pool, &claims, organization_id).await?;

    let view_all = q.view.as_deref() == Some("all");
    if view_all {
        permissions::require_organization_admin(&pool, &claims, organization_id).await?;
    }

    let rows = if view_all || claims.is_superadmin {
        sqlx::query(
            r#"
            SELECT t.id, t.name, t.slug, t.status, t.kind, t.contact_email,
                   t.organization_id, o.name AS organization_name,
                   ut.role AS user_role
            FROM management.tenants t
            JOIN management.organizations o ON o.id = t.organization_id
            LEFT JOIN management.user_tenants ut
              ON ut.tenant_id = t.id AND ut.is_active = true AND ut.user_id = $2
            -- 管理视图含已归档(suspended)；deleted 仍隐藏
            WHERE t.organization_id = $1 AND t.status IN ('active', 'suspended')
            ORDER BY CASE t.status WHEN 'active' THEN 0 ELSE 1 END, t.id DESC
            "#,
        )
        .bind(organization_id)
        .bind(claims.sub)
        .fetch_all(&pool)
        .await?
    } else {
        sqlx::query(
            r#"
            SELECT t.id, t.name, t.slug, t.status, t.kind, t.contact_email,
                   t.organization_id, o.name AS organization_name, ut.role AS user_role
            FROM management.tenants t
            JOIN management.organizations o ON o.id = t.organization_id
            JOIN management.user_tenants ut
              ON ut.tenant_id = t.id AND ut.is_active = true AND ut.user_id = $2
            JOIN management.organization_members om
              ON om.organization_id = t.organization_id
             AND om.user_id = ut.user_id AND om.is_active = true
            WHERE t.organization_id = $1 AND t.status = 'active'
            ORDER BY t.id DESC
            "#,
        )
        .bind(organization_id)
        .bind(claims.sub)
        .fetch_all(&pool)
        .await?
    };

    let projects: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            let user_role: Option<String> = if claims.is_superadmin {
                Some("superadmin".to_string())
            } else {
                r.try_get::<String, _>("user_role").ok()
            };
            json!({
                "id": r.get::<i32, _>("id"),
                "name": r.get::<String, _>("name"),
                "slug": r.get::<String, _>("slug"),
                "status": r.get::<String, _>("status"),
                "kind": r.get::<String, _>("kind"),
                "contact_email": r.try_get::<Option<String>, _>("contact_email").ok().flatten(),
                "organization_id": r.get::<i32, _>("organization_id"),
                "organization_name": r.get::<String, _>("organization_name"),
                "user_role": user_role,
            })
        })
        .collect();

    Ok(Json(json!({ "projects": projects })))
}

/// POST /api/organizations/:id/projects — 在组织下开通项目（需 org admin+）
pub async fn create_organization_project(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    redis: Option<Extension<RedisManager>>,
    Path(organization_id): Path<i32>,
    Json(mut req): Json<ProvisionRequest>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_organization_admin(&pool, &claims, organization_id).await?;
    req.organization_id = Some(organization_id);
    tenant_handlers::provision_project(State(pool), Extension(claims), redis, Json(req)).await
}

#[derive(Deserialize)]
pub struct AddProjectMemberFromOrgRequest {
    pub user_id: Option<i32>,
    pub username: Option<String>,
    pub email: Option<String>,
    pub password: Option<String>,
    pub role: String,
    /// 仅当目标尚非租户成员时写入 organization_members；默认 member
    pub org_role: Option<String>,
}

fn validate_project_role(role: &str) -> Result<()> {
    match role {
        "owner" | "admin" | "member" | "viewer" => Ok(()),
        _ => Err(AppError::InvalidQuery(format!(
            "无效项目角色 '{}'，必须是 owner / admin / member / viewer 之一",
            role
        ))),
    }
}

fn organization_member_upsert_sql(update_role: bool) -> &'static str {
    if update_role {
        r#"
        INSERT INTO management.organization_members (user_id, organization_id, role, is_active)
        VALUES ($1, $2, $3, true)
        ON CONFLICT (user_id, organization_id)
        DO UPDATE SET role = EXCLUDED.role, is_active = true
        "#
    } else {
        r#"
        INSERT INTO management.organization_members (user_id, organization_id, role, is_active)
        VALUES ($1, $2, $3, true)
        ON CONFLICT (user_id, organization_id)
        DO UPDATE SET is_active = true
        "#
    }
}

/// POST /api/organizations/:id/projects/:project_id/members
///
/// 租户 admin+ 将用户加入下属项目：已有 user_id（可顺带加入租户），或新建账号并入租户+项目。
pub async fn add_organization_project_member(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    redis: Option<Extension<RedisManager>>,
    Path((organization_id, project_id)): Path<(i32, i32)>,
    Json(req): Json<AddProjectMemberFromOrgRequest>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_organization_admin(&pool, &claims, organization_id).await?;
    validate_project_role(&req.role)?;
    if req.role == "owner" {
        permissions::require_project_owner_grant(&pool, &claims, project_id).await?;
    }

    let update_org_role = req.org_role.is_some();
    let org_role = req.org_role.as_deref().unwrap_or("member");
    validate_org_role(org_role)?;
    if org_role == "owner" {
        permissions::require_organization_owner(&pool, &claims, organization_id).await?;
    }

    let create_mode = req.username.is_some() || req.email.is_some() || req.password.is_some();
    match (req.user_id, create_mode) {
        (Some(_), true) => {
            return Err(AppError::InvalidQuery(
                "不能同时传 user_id 与新建账号字段".to_string(),
            ));
        }
        (None, false) => {
            return Err(AppError::InvalidQuery(
                "请提供 user_id，或 username/email/password 新建账号".to_string(),
            ));
        }
        _ => {}
    }

    let belongs: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM management.tenants
            WHERE id = $1 AND organization_id = $2 AND status = 'active'
        )
        "#,
    )
    .bind(project_id)
    .bind(organization_id)
    .fetch_one(&pool)
    .await?;
    if !belongs {
        return Err(AppError::NotFound(format!(
            "项目 {} 不属于组织 {} 或不存在",
            project_id, organization_id
        )));
    }

    let password_hash = if create_mode {
        let username = req.username.as_deref().unwrap_or("").trim();
        let email = req.email.as_deref().unwrap_or("").trim().to_lowercase();
        let password = req.password.as_deref().unwrap_or("");
        if username.chars().count() < 3 {
            return Err(AppError::InvalidQuery("用户名至少 3 个字符".to_string()));
        }
        if !email.contains('@') || email.len() < 5 {
            return Err(AppError::InvalidQuery("邮箱格式不正确".to_string()));
        }
        if password.chars().count() < 6 {
            return Err(AppError::InvalidQuery("密码至少 6 个字符".to_string()));
        }

        let email_taken: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE lower(email) = $1)")
                .bind(&email)
                .fetch_one(&pool)
                .await?;
        if email_taken {
            return Err(AppError::InvalidQuery("该邮箱已被注册".to_string()));
        }
        let username_taken: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE username = $1)")
                .bind(username)
                .fetch_one(&pool)
                .await?;
        if username_taken {
            return Err(AppError::InvalidQuery("该用户名已被使用".to_string()));
        }

        Some((
            username.to_string(),
            email,
            crate::auth::hash_password(password)?,
        ))
    } else {
        None
    };

    let existing_user_id = if create_mode {
        None
    } else {
        let Some(user_id) = req.user_id else {
            return Err(AppError::InvalidQuery("请提供 user_id".to_string()));
        };

        let user_exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
                .bind(user_id)
                .fetch_one(&pool)
                .await?;
        if !user_exists {
            return Err(AppError::NotFound(format!("用户 {} 不存在", user_id)));
        }

        Some(user_id)
    };

    let add_org_member = if create_mode {
        true
    } else {
        let user_id = existing_user_id.expect("validated above");
        !permissions::is_organization_member(&pool, user_id, organization_id).await?
    };

    let mut tx = pool.begin().await?;

    let user_id = if let Some((username, email, password_hash)) = password_hash {
        let new_user_id: i32 = sqlx::query_scalar(
            r#"INSERT INTO users (username, email, password_hash, role)
               VALUES ($1, $2, $3, 'user') RETURNING id"#,
        )
        .bind(&username)
        .bind(&email)
        .bind(&password_hash)
        .fetch_one(&mut *tx)
        .await?;

        sqlx::query(organization_member_upsert_sql(update_org_role))
            .bind(new_user_id)
            .bind(organization_id)
            .bind(org_role)
            .execute(&mut *tx)
            .await?;

        new_user_id
    } else {
        let user_id = existing_user_id.expect("validated above");

        if add_org_member {
            sqlx::query(organization_member_upsert_sql(update_org_role))
                .bind(user_id)
                .bind(organization_id)
                .bind(org_role)
                .execute(&mut *tx)
                .await?;
        }

        user_id
    };

    sqlx::query(
        r#"
        INSERT INTO management.user_tenants (user_id, tenant_id, role, is_active)
        VALUES ($1, $2, $3, true)
        ON CONFLICT (user_id, tenant_id)
        DO UPDATE SET role = $3, is_active = true
        "#,
    )
    .bind(user_id)
    .bind(project_id)
    .bind(&req.role)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    let redis_ref = redis.as_ref().map(|Extension(r)| r);
    permissions::sync_default_rbac_role(&pool, redis_ref, user_id, project_id, &req.role).await?;

    tracing::info!(
        "org {} admin {} added user {} to project {} as {}",
        organization_id,
        claims.sub,
        user_id,
        project_id,
        req.role
    );

    Ok(Json(json!({
        "ok": true,
        "organization_id": organization_id,
        "project_id": project_id,
        "user_id": user_id,
        "role": req.role,
    })))
}

#[derive(Deserialize)]
pub struct TransferOrgOwnerRequest {
    pub user_id: i32,
}

/// POST /api/organizations/:id/transfer-owner
///
/// 将 owner 转让给已是租户成员的用户：目标升为 owner，调用方（若为 owner）降为 admin。
pub async fn transfer_organization_owner(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(organization_id): Path<i32>,
    Json(req): Json<TransferOrgOwnerRequest>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_organization_owner(&pool, &claims, organization_id).await?;

    if req.user_id == claims.sub {
        return Err(AppError::InvalidQuery("不能转让给自己".to_string()));
    }

    let target_active: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM management.organization_members
            WHERE organization_id = $1 AND user_id = $2 AND is_active = true
        )
        "#,
    )
    .bind(organization_id)
    .bind(req.user_id)
    .fetch_one(&pool)
    .await?;
    if !target_active {
        return Err(AppError::InvalidQuery(
            "目标用户必须先是本租户的活跃成员".to_string(),
        ));
    }

    let mut tx = pool.begin().await?;

    sqlx::query(
        r#"
        UPDATE management.organization_members
        SET role = 'owner'
        WHERE organization_id = $1 AND user_id = $2 AND is_active = true
        "#,
    )
    .bind(organization_id)
    .bind(req.user_id)
    .execute(&mut *tx)
    .await?;

    // 调用方若是成员 owner 则降为 admin；超管代操作且非成员时 rows=0，无影响
    sqlx::query(
        r#"
        UPDATE management.organization_members
        SET role = 'admin'
        WHERE organization_id = $1 AND user_id = $2 AND is_active = true AND role = 'owner'
        "#,
    )
    .bind(organization_id)
    .bind(claims.sub)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    tracing::info!(
        "org {} owner transferred from {} to {} by {}",
        organization_id,
        claims.sub,
        req.user_id,
        claims.sub
    );

    Ok(Json(json!({
        "ok": true,
        "organization_id": organization_id,
        "new_owner_user_id": req.user_id,
    })))
}

#[derive(Deserialize)]
pub struct PatchOrgProjectRequest {
    /// active | suspended（归档）
    pub status: String,
}

/// PATCH /api/organizations/:id/projects/:project_id
///
/// 租户 owner 归档/恢复下属项目（status: suspended / active）。
pub async fn patch_organization_project(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((organization_id, project_id)): Path<(i32, i32)>,
    Json(req): Json<PatchOrgProjectRequest>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_organization_owner(&pool, &claims, organization_id).await?;

    if !["active", "suspended"].contains(&req.status.as_str()) {
        return Err(AppError::InvalidQuery(
            "status 只能是 active（恢复）或 suspended（归档）".to_string(),
        ));
    }

    let n = sqlx::query(
        r#"
        UPDATE management.tenants
        SET status = $3
        WHERE id = $1 AND organization_id = $2 AND status IN ('active', 'suspended')
        "#,
    )
    .bind(project_id)
    .bind(organization_id)
    .bind(&req.status)
    .execute(&pool)
    .await?
    .rows_affected();

    if n == 0 {
        return Err(AppError::NotFound(format!(
            "项目 {} 不属于组织 {} 或不存在",
            project_id, organization_id
        )));
    }

    tracing::info!(
        "org {} owner {} set project {} status={}",
        organization_id,
        claims.sub,
        project_id,
        req.status
    );

    Ok(Json(json!({
        "ok": true,
        "organization_id": organization_id,
        "project_id": project_id,
        "status": req.status,
    })))
}

const ORGANIZATION_MATRIX_MEMBERS_SQL: &str = r#"
    SELECT u.id AS user_id, u.username, u.email, om.role AS org_role
    FROM management.organization_members om
    JOIN users u ON u.id = om.user_id
    WHERE om.organization_id = $1 AND om.is_active = true
    ORDER BY u.username ASC
"#;

const ORGANIZATION_MATRIX_PROJECTS_SQL: &str = r#"
    SELECT id, name, slug
    FROM management.tenants
    WHERE organization_id = $1 AND status = 'active'
    ORDER BY name ASC
"#;

const ORGANIZATION_MATRIX_CELLS_SQL: &str = r#"
    SELECT ut.user_id, ut.tenant_id AS project_id, ut.role
    FROM management.user_tenants ut
    JOIN management.organization_members om
      ON om.user_id = ut.user_id
     AND om.organization_id = $1
     AND om.is_active = true
    WHERE ut.tenant_id = ANY($2) AND ut.is_active = true
"#;

/// GET /api/organizations/:id/member-project-matrix
pub async fn organization_member_project_matrix(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(organization_id): Path<i32>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_organization_admin(&pool, &claims, organization_id).await?;

    let member_rows = sqlx::query(ORGANIZATION_MATRIX_MEMBERS_SQL)
        .bind(organization_id)
        .fetch_all(&pool)
        .await?;
    let members: Vec<serde_json::Value> = member_rows
        .iter()
        .map(|row| {
            json!({
                "user_id": row.get::<i32, _>("user_id"),
                "username": row.get::<String, _>("username"),
                "email": row.get::<String, _>("email"),
                "org_role": row.get::<String, _>("org_role"),
            })
        })
        .collect();

    let project_rows = sqlx::query(ORGANIZATION_MATRIX_PROJECTS_SQL)
        .bind(organization_id)
        .fetch_all(&pool)
        .await?;
    let project_ids: Vec<i32> = project_rows
        .iter()
        .map(|row| row.get::<i32, _>("id"))
        .collect();
    let projects: Vec<serde_json::Value> = project_rows
        .iter()
        .map(|row| {
            json!({
                "id": row.get::<i32, _>("id"),
                "name": row.get::<String, _>("name"),
                "slug": row.get::<String, _>("slug"),
            })
        })
        .collect();

    let cell_rows = if project_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query(ORGANIZATION_MATRIX_CELLS_SQL)
            .bind(organization_id)
            .bind(&project_ids)
            .fetch_all(&pool)
            .await?
    };
    let cells: Vec<serde_json::Value> = cell_rows
        .iter()
        .map(|row| {
            json!({
                "user_id": row.get::<i32, _>("user_id"),
                "project_id": row.get::<i32, _>("project_id"),
                "role": row.get::<String, _>("role"),
            })
        })
        .collect();

    Ok(Json(json!({
        "organization_id": organization_id,
        "members": members,
        "projects": projects,
        "cells": cells,
    })))
}

const ORGANIZATION_SECURITY_OVERVIEW_SQL: &str = r#"
    SELECT t.id, t.name, t.slug,
      (SELECT COUNT(*)::bigint
       FROM management.api_keys k
       WHERE k.tenant_id = t.id AND k.is_active = true) AS api_keys,
      (SELECT COUNT(*)::bigint
       FROM management.webhooks w
       WHERE w.tenant_id = t.id AND w.is_active = true) AS webhooks,
      (SELECT COUNT(*)::bigint
       FROM management.sso_providers s
       WHERE s.tenant_id = t.id AND s.is_active = true) AS sso_providers,
      (SELECT COUNT(*)::bigint
       FROM management.project_idp_providers p
       WHERE p.tenant_id = t.id) AS idp_providers,
      (SELECT COUNT(*)::bigint
       FROM management.tenant_databases d
       WHERE d.tenant_id = t.id AND d.is_active = true) AS databases
    FROM management.tenants t
    WHERE t.organization_id = $1 AND t.status = 'active'
    ORDER BY t.name ASC
"#;

/// GET /api/organizations/:id/security-overview
pub async fn organization_security_overview(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(organization_id): Path<i32>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_organization_admin(&pool, &claims, organization_id).await?;

    let rows = sqlx::query(ORGANIZATION_SECURITY_OVERVIEW_SQL)
        .bind(organization_id)
        .fetch_all(&pool)
        .await?;
    let projects: Vec<serde_json::Value> = rows
        .iter()
        .map(|row| {
            json!({
                "id": row.get::<i32, _>("id"),
                "name": row.get::<String, _>("name"),
                "slug": row.get::<String, _>("slug"),
                "api_keys": row.get::<i64, _>("api_keys"),
                "webhooks": row.get::<i64, _>("webhooks"),
                "sso_providers": row.get::<i64, _>("sso_providers"),
                "idp_providers": row.get::<i64, _>("idp_providers"),
                "databases": row.get::<i64, _>("databases"),
            })
        })
        .collect();

    Ok(Json(json!({
        "organization_id": organization_id,
        "projects": projects,
    })))
}

/// GET /api/organizations/:id/stats —— 租户大盘（org admin+）
pub async fn organization_stats(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(organization_id): Path<i32>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_organization_admin(&pool, &claims, organization_id).await?;
    let project_ids = permissions::organization_project_ids(&pool, organization_id).await?;

    let projects_active: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM management.tenants \
         WHERE organization_id = $1 AND status = 'active'",
    )
    .bind(organization_id)
    .fetch_one(&pool)
    .await?;

    let projects_archived: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM management.tenants \
         WHERE organization_id = $1 AND status = 'suspended'",
    )
    .bind(organization_id)
    .fetch_one(&pool)
    .await?;

    let members_active: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM management.organization_members \
         WHERE organization_id = $1 AND is_active = true",
    )
    .bind(organization_id)
    .fetch_one(&pool)
    .await?;

    let (audit_calls_24h, audit_errors_24h, slow_queries_24h, exec_total_24h, exec_failed_24h) =
        if project_ids.is_empty() {
            (0i64, 0i64, 0i64, 0i64, 0i64)
        } else {
            let audit_calls_24h: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM management.audit_logs \
                 WHERE tenant_id = ANY($1) AND created_at >= NOW() - INTERVAL '24 hours'",
            )
            .bind(&project_ids)
            .fetch_one(&pool)
            .await?;

            let audit_errors_24h: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM management.audit_logs \
                 WHERE tenant_id = ANY($1) AND created_at >= NOW() - INTERVAL '24 hours' \
                   AND response_status >= 400",
            )
            .bind(&project_ids)
            .fetch_one(&pool)
            .await?;

            let slow_queries_24h: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM management.slow_query_logs s \
                 JOIN management.tenant_databases td ON td.id = s.database_id \
                 WHERE td.tenant_id = ANY($1) AND s.created_at >= NOW() - INTERVAL '24 hours'",
            )
            .bind(&project_ids)
            .fetch_one(&pool)
            .await?;

            let exec_total_24h: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM management.execution_index \
                 WHERE tenant_id = ANY($1) AND started_at >= NOW() - INTERVAL '24 hours'",
            )
            .bind(&project_ids)
            .fetch_one(&pool)
            .await?;

            let exec_failed_24h: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM management.execution_index \
                 WHERE tenant_id = ANY($1) AND started_at >= NOW() - INTERVAL '24 hours' \
                   AND status IN ('failed', 'timeout')",
            )
            .bind(&project_ids)
            .fetch_one(&pool)
            .await?;

            (
                audit_calls_24h,
                audit_errors_24h,
                slow_queries_24h,
                exec_total_24h,
                exec_failed_24h,
            )
        };

    Ok(Json(json!({
        "organization_id": organization_id,
        "projects_active": projects_active,
        "projects_archived": projects_archived,
        "members_active": members_active,
        "audit_calls_24h": audit_calls_24h,
        "audit_errors_24h": audit_errors_24h,
        "slow_queries_24h": slow_queries_24h,
        "exec_total_24h": exec_total_24h,
        "exec_failed_24h": exec_failed_24h,
    })))
}

#[cfg(test)]
mod tests {
    use super::{
        organization_member_upsert_sql, ORGANIZATION_MATRIX_CELLS_SQL,
        ORGANIZATION_MATRIX_MEMBERS_SQL, ORGANIZATION_MATRIX_PROJECTS_SQL,
        ORGANIZATION_SECURITY_OVERVIEW_SQL,
    };

    #[test]
    fn org_member_reactivation_only_updates_explicit_role() {
        let default_role_sql = organization_member_upsert_sql(false);
        assert!(default_role_sql.contains("DO UPDATE SET is_active = true"));
        assert!(!default_role_sql.contains("role = EXCLUDED.role"));

        let explicit_role_sql = organization_member_upsert_sql(true);
        assert!(explicit_role_sql.contains("role = EXCLUDED.role"));
        assert!(explicit_role_sql.contains("is_active = true"));
    }

    #[test]
    fn member_project_matrix_queries_only_include_active_org_data() {
        assert!(ORGANIZATION_MATRIX_MEMBERS_SQL.contains("om.organization_id = $1"));
        assert!(ORGANIZATION_MATRIX_MEMBERS_SQL.contains("om.is_active = true"));
        assert!(ORGANIZATION_MATRIX_PROJECTS_SQL.contains("organization_id = $1"));
        assert!(ORGANIZATION_MATRIX_PROJECTS_SQL.contains("status = 'active'"));
        assert!(ORGANIZATION_MATRIX_CELLS_SQL.contains("om.organization_id = $1"));
        assert!(ORGANIZATION_MATRIX_CELLS_SQL.contains("om.is_active = true"));
        assert!(ORGANIZATION_MATRIX_CELLS_SQL.contains("ut.tenant_id = ANY($2)"));
        assert!(ORGANIZATION_MATRIX_CELLS_SQL.contains("ut.is_active = true"));
    }

    #[test]
    fn security_overview_counts_only_active_security_resources() {
        assert!(ORGANIZATION_SECURITY_OVERVIEW_SQL.contains("t.organization_id = $1"));
        assert!(ORGANIZATION_SECURITY_OVERVIEW_SQL.contains("t.status = 'active'"));
        assert!(ORGANIZATION_SECURITY_OVERVIEW_SQL.contains("k.is_active = true"));
        assert!(ORGANIZATION_SECURITY_OVERVIEW_SQL.contains("w.is_active = true"));
        assert!(ORGANIZATION_SECURITY_OVERVIEW_SQL.contains("s.is_active = true"));
        assert!(ORGANIZATION_SECURITY_OVERVIEW_SQL.contains("d.is_active = true"));
        assert!(!ORGANIZATION_SECURITY_OVERVIEW_SQL.contains("p.is_active"));
        assert!(!ORGANIZATION_SECURITY_OVERVIEW_SQL.contains("p.is_enabled"));
    }
}
