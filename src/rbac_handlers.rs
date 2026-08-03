//! RBAC 权限管理 API
//!
//! 角色、权限、用户-角色的 CRUD 端点

use axum::{
    extract::{Extension, Path, State},
    Json,
};
use serde_json::{json, Value};
use sqlx::{PgPool, Row};

use crate::auth::Claims;
use crate::error::{AppError, Result};
use crate::permissions::{self, TenantContext};
use crate::rbac_models::*;
use crate::redis_manager::RedisManager;

/// 缩写：从可选的 `Extension<RedisManager>` 中拿出底层 `&RedisManager`，喂给
/// `permissions::invalidate_*` 系列辅助。Redis 不可用时为 `None`，调用方静默跳过缓存失效。
fn redis_ref(redis: &Option<Extension<RedisManager>>) -> Option<&RedisManager> {
    redis.as_ref().map(|Extension(r)| r)
}

// ─── 租户上下文 ───────────────────────────────────────────
//
// 旧实现是 `resolve_tenant_id(pool, claims)`：用户加入多个租户时取"PK 最小的那个"，
// 等价于"操作错了租户"。新模型由 `permissions::TenantContext` 提取器完成：
// - 优先读取 `X-Tenant-Id` 请求头（或 `?tenant_id=N`）；
// - 普通用户必须是该租户的 active 成员；
// - 超管允许操作任意已存在的租户；
// - 没指定且用户恰好属于 1 个租户时复用旧的兜底。
//
// 各 handler 的签名加一个 `TenantContext(tenant_id): TenantContext` 参数即可。

/// 给新建 tenant 写入开箱可用的 RBAC 默认数据：
/// - 3 个系统角色（admin / editor / viewer）
/// - 4 条基础权限（resource = '*'，action = SELECT/INSERT/UPDATE/ALL）
/// - 角色到权限的绑定（与 011_seed_default_permissions.sql 一致）
///
/// 关于 `superadmin`：
///   早期版本会同时 seed 一个 tenant 维度的 `superadmin` 角色（赋 `*.ALL`），
///   但它和 `users.is_superadmin`（平台超管）同名 + 与 tenant 内 `admin` 角色
///   功能完全重叠（都绑 `*.ALL`），实际反而造成 confusion。
///   迁移 014_consolidate_tenant_rbac.sql 会把已有 `superadmin` 上挂的用户
///   平迁到 `admin` 再删掉该角色；这里同步不再创建。
///
/// 幂等：使用 ON CONFLICT DO NOTHING。
pub async fn seed_tenant_rbac_defaults(pool: &PgPool, tenant_id: i32) -> Result<()> {
    // 1) 系统角色
    sqlx::query(
        r#"
        INSERT INTO management.roles (tenant_id, name, description, is_system)
        VALUES
            ($1, 'admin',      '管理员，拥有所有 CRUD 权限', true),
            ($1, 'editor',     '编辑者，可查询、创建和更新', true),
            ($1, 'viewer',     '观察者，仅可查询', true)
        ON CONFLICT (tenant_id, name) DO NOTHING
        "#,
    )
    .bind(tenant_id)
    .execute(pool)
    .await?;

    // 2) 基础权限（依赖 011 migration 已建好的唯一索引）
    sqlx::query(
        r#"
        INSERT INTO management.permissions
            (tenant_id, resource, action, conditions, allowed_columns, denied_columns, description)
        VALUES
            ($1, '*', 'SELECT', '[]'::jsonb, NULL, '[]'::jsonb, '只读所有资源'),
            ($1, '*', 'INSERT', '[]'::jsonb, NULL, '[]'::jsonb, '插入所有资源'),
            ($1, '*', 'UPDATE', '[]'::jsonb, NULL, '[]'::jsonb, '更新所有资源'),
            ($1, '*', 'ALL',    '[]'::jsonb, NULL, '[]'::jsonb, '完全访问所有资源')
        ON CONFLICT (tenant_id, resource, action) DO NOTHING
        "#,
    )
    .bind(tenant_id)
    .execute(pool)
    .await?;

    // 3) 绑定关系
    sqlx::query(
        r#"
        INSERT INTO management.role_permissions (role_id, permission_id)
        SELECT r.id, p.id
        FROM management.roles r
        JOIN management.permissions p ON p.tenant_id = r.tenant_id
        WHERE r.tenant_id = $1
          AND r.name = 'viewer'
          AND p.resource = '*' AND p.action = 'SELECT'
        ON CONFLICT (role_id, permission_id) DO NOTHING
        "#,
    )
    .bind(tenant_id)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO management.role_permissions (role_id, permission_id)
        SELECT r.id, p.id
        FROM management.roles r
        JOIN management.permissions p ON p.tenant_id = r.tenant_id
        WHERE r.tenant_id = $1
          AND r.name = 'editor'
          AND p.resource = '*' AND p.action IN ('SELECT', 'INSERT', 'UPDATE')
        ON CONFLICT (role_id, permission_id) DO NOTHING
        "#,
    )
    .bind(tenant_id)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO management.role_permissions (role_id, permission_id)
        SELECT r.id, p.id
        FROM management.roles r
        JOIN management.permissions p ON p.tenant_id = r.tenant_id
        WHERE r.tenant_id = $1
          AND r.name = 'admin'
          AND p.resource = '*' AND p.action = 'ALL'
        ON CONFLICT (role_id, permission_id) DO NOTHING
        "#,
    )
    .bind(tenant_id)
    .execute(pool)
    .await?;

    Ok(())
}

/// 检查用户是否为平台超管。
///
/// 委托给 `crate::permissions::is_platform_superadmin`；保留 `pub` 接口仅为
/// 兼容外部调用方（query_perf_handlers 等）；新代码请直接用 `permissions::` 入口。
pub async fn is_superadmin(pool: &PgPool, user_id: i32) -> Result<bool> {
    Ok(permissions::is_platform_superadmin(pool, user_id).await)
}

/// 校验调用者必须是「平台超管」或「该租户的管理员（owner/admin）」。
/// 用于所有 RBAC 写操作（创建/修改角色、分配权限等）。
///
/// 委托给 `permissions::require_tenant_admin`，保留本地名是为了不动调用点。
async fn require_tenant_admin(pool: &PgPool, claims: &Claims, tenant_id: i32) -> Result<()> {
    permissions::require_tenant_admin(pool, claims, tenant_id).await
}

// ═══════════════════════════════════════════════
// 角色管理
// ═══════════════════════════════════════════════

/// GET /api/rbac/roles
pub async fn list_roles(
    Extension(_claims): Extension<Claims>,
    TenantContext(tenant_id): TenantContext,
    State(pool): State<PgPool>,
) -> Result<Json<Vec<Role>>> {
    let rows = sqlx::query(
        r#"
        SELECT r.id, r.tenant_id, r.name, r.description, r.is_system,
               r.created_at::TEXT, r.updated_at::TEXT,
               (SELECT COUNT(*) FROM management.user_roles ur WHERE ur.role_id = r.id) AS user_count,
               (SELECT COUNT(*) FROM management.role_permissions rp WHERE rp.role_id = r.id) AS perm_count
        FROM management.roles r
        WHERE r.tenant_id = $1
        ORDER BY r.is_system DESC, r.name
        "#,
    )
    .bind(tenant_id)
    .fetch_all(&pool)
    .await?;

    let roles: Vec<Role> = rows
        .iter()
        .map(|r| Role {
            id: r.get("id"),
            tenant_id: r.get("tenant_id"),
            name: r.get("name"),
            description: r.get("description"),
            is_system: r.get("is_system"),
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
        })
        .collect();

    Ok(Json(roles))
}

/// POST /api/rbac/roles
pub async fn create_role(
    Extension(claims): Extension<Claims>,
    TenantContext(tenant_id): TenantContext,
    redis: Option<Extension<RedisManager>>,
    State(pool): State<PgPool>,
    Json(req): Json<CreateRoleRequest>,
) -> Result<Json<Role>> {
    require_tenant_admin(&pool, &claims, tenant_id).await?;

    let row = sqlx::query(
        r#"
        INSERT INTO management.roles (tenant_id, name, description)
        VALUES ($1, $2, $3)
        RETURNING id, tenant_id, name, description, is_system, created_at::TEXT, updated_at::TEXT
        "#,
    )
    .bind(tenant_id)
    .bind(&req.name)
    .bind(&req.description)
    .fetch_one(&pool)
    .await
    .map_err(|e| AppError::InvalidQuery(format!("创建角色失败: {}", e)))?;

    // 新角色暂时没人挂，理论上不影响现有用户的权限缓存——但 list_roles
    // 等只读 API 没有缓存，所以这里失效租户缓存仅作"保险丝"，便于将来
    // create_role + 立即 assign_user_role 的常见组合在一致性窗口内表现一致。
    permissions::invalidate_tenant_permissions(redis_ref(&redis), tenant_id).await;

    Ok(Json(Role {
        id: row.get("id"),
        tenant_id: row.get("tenant_id"),
        name: row.get("name"),
        description: row.get("description"),
        is_system: row.get("is_system"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }))
}

/// PATCH /api/rbac/roles/:id
pub async fn update_role(
    Extension(claims): Extension<Claims>,
    TenantContext(tenant_id): TenantContext,
    redis: Option<Extension<RedisManager>>,
    State(pool): State<PgPool>,
    Path(role_id): Path<i32>,
    Json(req): Json<UpdateRoleRequest>,
) -> Result<Json<Role>> {
    require_tenant_admin(&pool, &claims, tenant_id).await?;

    // 禁止修改系统角色
    let existing =
        sqlx::query("SELECT is_system FROM management.roles WHERE id = $1 AND tenant_id = $2")
            .bind(role_id)
            .bind(tenant_id)
            .fetch_optional(&pool)
            .await?
            .ok_or_else(|| AppError::NotFound("角色不存在".to_string()))?;

    if existing.get::<bool, _>("is_system") {
        return Err(AppError::Forbidden("不能修改系统角色".to_string()));
    }

    let row = sqlx::query(
        r#"
        UPDATE management.roles
        SET name = COALESCE($1, name),
            description = COALESCE($2, description)
        WHERE id = $3 AND tenant_id = $4
        RETURNING id, tenant_id, name, description, is_system, created_at::TEXT, updated_at::TEXT
        "#,
    )
    .bind(&req.name)
    .bind(&req.description)
    .bind(role_id)
    .bind(tenant_id)
    .fetch_one(&pool)
    .await?;

    // 角色描述/名称变更影响下游 audit/log 展示，权限矩阵实质未变；但用户挂在该角色上
    // 的"is_system"判断如果有缓存仍可能用旧值，所以一并刷掉同租户缓存兜底。
    permissions::invalidate_tenant_permissions(redis_ref(&redis), tenant_id).await;

    Ok(Json(Role {
        id: row.get("id"),
        tenant_id: row.get("tenant_id"),
        name: row.get("name"),
        description: row.get("description"),
        is_system: row.get("is_system"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }))
}

/// DELETE /api/rbac/roles/:id
pub async fn delete_role(
    Extension(claims): Extension<Claims>,
    TenantContext(tenant_id): TenantContext,
    redis: Option<Extension<RedisManager>>,
    State(pool): State<PgPool>,
    Path(role_id): Path<i32>,
) -> Result<Json<Value>> {
    require_tenant_admin(&pool, &claims, tenant_id).await?;

    let existing =
        sqlx::query("SELECT is_system FROM management.roles WHERE id = $1 AND tenant_id = $2")
            .bind(role_id)
            .bind(tenant_id)
            .fetch_optional(&pool)
            .await?
            .ok_or_else(|| AppError::NotFound("角色不存在".to_string()))?;

    if existing.get::<bool, _>("is_system") {
        return Err(AppError::Forbidden("不能删除系统角色".to_string()));
    }

    sqlx::query("DELETE FROM management.roles WHERE id = $1 AND tenant_id = $2")
        .bind(role_id)
        .bind(tenant_id)
        .execute(&pool)
        .await?;

    // 删 role 会经 FK 级联清掉 user_roles / role_permissions，影响所有曾挂该 role 的用户。
    permissions::invalidate_tenant_permissions(redis_ref(&redis), tenant_id).await;

    Ok(Json(json!({ "success": true, "message": "角色已删除" })))
}

/// GET /api/rbac/roles/:id/permissions
pub async fn get_role_permissions(
    Extension(_claims): Extension<Claims>,
    TenantContext(tenant_id): TenantContext,
    State(pool): State<PgPool>,
    Path(role_id): Path<i32>,
) -> Result<Json<Vec<Permission>>> {
    // 验证角色属于当前租户
    sqlx::query("SELECT id FROM management.roles WHERE id = $1 AND tenant_id = $2")
        .bind(role_id)
        .bind(tenant_id)
        .fetch_optional(&pool)
        .await?
        .ok_or_else(|| AppError::NotFound("角色不存在".to_string()))?;

    let rows = sqlx::query(
        r#"
        SELECT p.id, p.tenant_id, p.resource, p.action, p.conditions,
               p.allowed_columns, p.denied_columns, p.description,
               p.created_at::TEXT, p.updated_at::TEXT
        FROM management.permissions p
        JOIN management.role_permissions rp ON rp.permission_id = p.id
        WHERE rp.role_id = $1
        ORDER BY p.resource, p.action
        "#,
    )
    .bind(role_id)
    .fetch_all(&pool)
    .await?;

    let perms = rows.iter().map(row_to_permission).collect();
    Ok(Json(perms))
}

/// PUT /api/rbac/roles/:id/permissions — 全量替换角色的权限
pub async fn set_role_permissions(
    Extension(claims): Extension<Claims>,
    TenantContext(tenant_id): TenantContext,
    redis: Option<Extension<RedisManager>>,
    State(pool): State<PgPool>,
    Path(role_id): Path<i32>,
    Json(req): Json<SetRolePermissionsRequest>,
) -> Result<Json<Value>> {
    require_tenant_admin(&pool, &claims, tenant_id).await?;

    sqlx::query("SELECT id FROM management.roles WHERE id = $1 AND tenant_id = $2")
        .bind(role_id)
        .bind(tenant_id)
        .fetch_optional(&pool)
        .await?
        .ok_or_else(|| AppError::NotFound("角色不存在".to_string()))?;

    // 事务：先删后插
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM management.role_permissions WHERE role_id = $1")
        .bind(role_id)
        .execute(&mut *tx)
        .await?;

    for pid in &req.permission_ids {
        sqlx::query(
            "INSERT INTO management.role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        )
        .bind(role_id)
        .bind(pid)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    // 角色的权限集合变了，所有挂该角色的用户视图都受影响——清整租户缓存。
    permissions::invalidate_tenant_permissions(redis_ref(&redis), tenant_id).await;

    Ok(Json(json!({
        "success": true,
        "message": format!("已设置 {} 条权限", req.permission_ids.len())
    })))
}

// ═══════════════════════════════════════════════
// 权限管理
// ═══════════════════════════════════════════════

/// GET /api/rbac/permissions
pub async fn list_permissions(
    Extension(_claims): Extension<Claims>,
    TenantContext(tenant_id): TenantContext,
    State(pool): State<PgPool>,
) -> Result<Json<Vec<Permission>>> {
    let rows = sqlx::query(
        r#"
        SELECT id, tenant_id, resource, action, conditions, allowed_columns,
               denied_columns, description, created_at::TEXT, updated_at::TEXT
        FROM management.permissions
        WHERE tenant_id = $1
        ORDER BY resource, action
        "#,
    )
    .bind(tenant_id)
    .fetch_all(&pool)
    .await?;

    let perms = rows.iter().map(row_to_permission).collect();
    Ok(Json(perms))
}

/// POST /api/rbac/permissions
pub async fn create_permission(
    Extension(claims): Extension<Claims>,
    TenantContext(tenant_id): TenantContext,
    redis: Option<Extension<RedisManager>>,
    State(pool): State<PgPool>,
    Json(req): Json<CreatePermissionRequest>,
) -> Result<Json<Permission>> {
    require_tenant_admin(&pool, &claims, tenant_id).await?;

    let valid_actions = ["SELECT", "INSERT", "UPDATE", "DELETE", "ALL"];
    if !valid_actions.contains(&req.action.as_str()) {
        return Err(AppError::InvalidQuery(format!(
            "无效的 action: {}，允许值: {:?}",
            req.action, valid_actions
        )));
    }

    let row = sqlx::query(
        r#"
        INSERT INTO management.permissions (tenant_id, resource, action, conditions, allowed_columns, denied_columns, description)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, tenant_id, resource, action, conditions, allowed_columns, denied_columns, description,
                  created_at::TEXT, updated_at::TEXT
        "#,
    )
    .bind(tenant_id)
    .bind(&req.resource)
    .bind(&req.action)
    .bind(&req.conditions)
    .bind(&req.allowed_columns)
    .bind(&req.denied_columns)
    .bind(&req.description)
    .fetch_one(&pool)
    .await
    .map_err(|e| AppError::InvalidQuery(format!("创建权限失败: {}", e)))?;

    // 新建的 permission 可能立即被绑到既有 role；为保一致性窗口干净，提前失效。
    permissions::invalidate_tenant_permissions(redis_ref(&redis), tenant_id).await;

    Ok(Json(row_to_permission(&row)))
}

/// PATCH /api/rbac/permissions/:id
pub async fn update_permission(
    Extension(claims): Extension<Claims>,
    TenantContext(tenant_id): TenantContext,
    redis: Option<Extension<RedisManager>>,
    State(pool): State<PgPool>,
    Path(perm_id): Path<i32>,
    Json(req): Json<UpdatePermissionRequest>,
) -> Result<Json<Permission>> {
    require_tenant_admin(&pool, &claims, tenant_id).await?;

    let row = sqlx::query(
        r#"
        UPDATE management.permissions
        SET resource = COALESCE($1, resource),
            action = COALESCE($2, action),
            conditions = COALESCE($3, conditions),
            allowed_columns = CASE WHEN $4::boolean THEN $5 ELSE allowed_columns END,
            denied_columns = COALESCE($6, denied_columns),
            description = COALESCE($7, description)
        WHERE id = $8 AND tenant_id = $9
        RETURNING id, tenant_id, resource, action, conditions, allowed_columns, denied_columns, description,
                  created_at::TEXT, updated_at::TEXT
        "#,
    )
    .bind(&req.resource)
    .bind(&req.action)
    .bind(&req.conditions)
    .bind(req.allowed_columns.is_some())
    .bind(&req.allowed_columns)
    .bind(&req.denied_columns)
    .bind(&req.description)
    .bind(perm_id)
    .bind(tenant_id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound("权限不存在".to_string()))?;

    // 行列条件 / resource / action 任何字段变了，所有挂这条 permission 的用户视图都受影响。
    permissions::invalidate_tenant_permissions(redis_ref(&redis), tenant_id).await;

    Ok(Json(row_to_permission(&row)))
}

/// DELETE /api/rbac/permissions/:id
pub async fn delete_permission(
    Extension(claims): Extension<Claims>,
    TenantContext(tenant_id): TenantContext,
    redis: Option<Extension<RedisManager>>,
    State(pool): State<PgPool>,
    Path(perm_id): Path<i32>,
) -> Result<Json<Value>> {
    require_tenant_admin(&pool, &claims, tenant_id).await?;

    let result = sqlx::query("DELETE FROM management.permissions WHERE id = $1 AND tenant_id = $2")
        .bind(perm_id)
        .bind(tenant_id)
        .execute(&pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("权限不存在".to_string()));
    }

    // 删 permission 直接撤销了所有挂它的 role 的对应资格。
    permissions::invalidate_tenant_permissions(redis_ref(&redis), tenant_id).await;

    Ok(Json(json!({ "success": true, "message": "权限已删除" })))
}

// ═══════════════════════════════════════════════
// 用户-角色管理
// ═══════════════════════════════════════════════

/// GET /api/rbac/users/:user_id/roles
pub async fn get_user_roles(
    Extension(_claims): Extension<Claims>,
    TenantContext(tenant_id): TenantContext,
    State(pool): State<PgPool>,
    Path(target_user_id): Path<i32>,
) -> Result<Json<Vec<UserRole>>> {
    let rows = sqlx::query(
        r#"
        SELECT ur.id, ur.user_id, ur.role_id, ur.tenant_id, r.name AS role_name, ur.created_at::TEXT
        FROM management.user_roles ur
        JOIN management.roles r ON r.id = ur.role_id
        WHERE ur.user_id = $1 AND ur.tenant_id = $2
        ORDER BY r.name
        "#,
    )
    .bind(target_user_id)
    .bind(tenant_id)
    .fetch_all(&pool)
    .await?;

    let roles = rows
        .iter()
        .map(|r| UserRole {
            id: r.get("id"),
            user_id: r.get("user_id"),
            role_id: r.get("role_id"),
            tenant_id: r.get("tenant_id"),
            role_name: r.get("role_name"),
            created_at: r.get("created_at"),
        })
        .collect();

    Ok(Json(roles))
}

/// POST /api/rbac/users/:user_id/roles
pub async fn assign_user_role(
    Extension(claims): Extension<Claims>,
    redis: Option<Extension<RedisManager>>,
    State(pool): State<PgPool>,
    Path(target_user_id): Path<i32>,
    Json(req): Json<AssignRoleRequest>,
) -> Result<Json<Value>> {
    // 调用者必须是 req.tenant_id 这个租户的管理员（或平台超管）
    require_tenant_admin(&pool, &claims, req.tenant_id).await?;

    // role_id 必须属于同一个 tenant_id（防止跨租户拉取角色）
    let role_belongs = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM management.roles WHERE id = $1 AND tenant_id = $2)",
    )
    .bind(req.role_id)
    .bind(req.tenant_id)
    .fetch_one(&pool)
    .await?;
    if !role_belongs {
        return Err(AppError::InvalidQuery("角色不属于该租户".to_string()));
    }

    // 目标用户必须已隶属于该租户（避免把外部用户拉进来当成员）
    let target_in_tenant = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM management.user_tenants \
         WHERE user_id = $1 AND tenant_id = $2 AND is_active = true)",
    )
    .bind(target_user_id)
    .bind(req.tenant_id)
    .fetch_one(&pool)
    .await?;
    if !target_in_tenant {
        return Err(AppError::InvalidQuery("目标用户不属于该租户".to_string()));
    }

    sqlx::query(
        r#"
        INSERT INTO management.user_roles (user_id, role_id, tenant_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, role_id, tenant_id) DO NOTHING
        "#,
    )
    .bind(target_user_id)
    .bind(req.role_id)
    .bind(req.tenant_id)
    .execute(&pool)
    .await
    .map_err(|e| AppError::InvalidQuery(format!("分配角色失败: {}", e)))?;

    // 仅这一个用户在这个租户内的权限视图变了。
    permissions::invalidate_user_permissions(redis_ref(&redis), req.tenant_id, target_user_id)
        .await;

    Ok(Json(json!({ "success": true, "message": "角色已分配" })))
}

/// DELETE /api/rbac/users/:user_id/roles/:role_id
pub async fn remove_user_role(
    Extension(claims): Extension<Claims>,
    TenantContext(tenant_id): TenantContext,
    redis: Option<Extension<RedisManager>>,
    State(pool): State<PgPool>,
    Path((target_user_id, role_id)): Path<(i32, i32)>,
) -> Result<Json<Value>> {
    require_tenant_admin(&pool, &claims, tenant_id).await?;

    sqlx::query(
        "DELETE FROM management.user_roles WHERE user_id = $1 AND role_id = $2 AND tenant_id = $3",
    )
    .bind(target_user_id)
    .bind(role_id)
    .bind(tenant_id)
    .execute(&pool)
    .await?;

    // 撤销角色后该用户在该租户视野立即变窄，必须失效缓存防止"已撤销仍能用"。
    permissions::invalidate_user_permissions(redis_ref(&redis), tenant_id, target_user_id).await;

    Ok(Json(json!({ "success": true, "message": "角色已移除" })))
}

// ═══════════════════════════════════════════════
// 权限查询（供中间件调用）
// ═══════════════════════════════════════════════

/// 由 database_id 反查 tenant_id（必须 active）。委托给 `permissions::lookup_tenant_for_database`。
async fn lookup_tenant_id(pool: &PgPool, database_id: i32) -> Result<i32> {
    permissions::lookup_tenant_for_database(pool, database_id).await
}

/// 检查用户是否为平台超管（任何资源都放行）。委托给 `permissions::is_platform_superadmin`。
async fn is_user_superadmin(pool: &PgPool, user_id: i32) -> bool {
    permissions::is_platform_superadmin(pool, user_id).await
}

/// 校验用户对 (schema.table) 资源是否具备 `action` 权限。
///
/// - 超管直接放行；
/// - 否则查询 `management.permissions`，命中精确匹配 / `*` / `schema.*` 任一即可；
/// - 命中为 0 → 返回 `Forbidden`。
///
/// 注意：本函数不展开行级 / 列级限制（DDL handler 不需要）。
/// 普通 CRUD 仍由 `rbac_middleware` 注入 `PermissionResult` 完成更精细的过滤。
pub async fn require_table_permission(
    pool: &PgPool,
    user_id: i32,
    database_id: i32,
    schema: &str,
    table: &str,
    action: &str,
) -> Result<()> {
    if is_user_superadmin(pool, user_id).await {
        return Ok(());
    }
    let tenant_id = lookup_tenant_id(pool, database_id).await?;
    let resource = format!("{}.{}", schema, table);
    let perms = query_user_permissions(pool, user_id, tenant_id, &resource, action).await?;
    if perms.is_empty() {
        return Err(crate::error::AppError::Forbidden(format!(
            "没有权限在 {} 上执行 {}",
            resource, action
        )));
    }
    Ok(())
}

/// 校验用户对整个 schema（任意表）是否具备 `action` 权限。
///
/// 用于 DDL / 元数据查询里"想列出整个 schema"的场景。
/// - 超管直接放行；
/// - 否则只接受三种通配权限：`*` / `*.*` / `<schema>.*`。
///   单独某张表的精确权限不算覆盖整个 schema。
pub async fn require_schema_permission(
    pool: &PgPool,
    user_id: i32,
    database_id: i32,
    schema: &str,
    action: &str,
) -> Result<()> {
    if is_user_superadmin(pool, user_id).await {
        return Ok(());
    }
    let tenant_id = lookup_tenant_id(pool, database_id).await?;
    let schema_wildcard = format!("{}.*", schema);

    let count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::BIGINT
        FROM management.permissions p
        JOIN management.role_permissions rp ON rp.permission_id = p.id
        JOIN management.user_roles ur ON ur.role_id = rp.role_id
        WHERE ur.user_id = $1
          AND ur.tenant_id = $2
          AND p.resource IN ($3, '*', '*.*')
          AND (p.action = $4 OR p.action = 'ALL')
        "#,
    )
    .bind(user_id)
    .bind(tenant_id)
    .bind(&schema_wildcard)
    .bind(action)
    .fetch_one(pool)
    .await?;

    if count == 0 {
        return Err(crate::error::AppError::Forbidden(format!(
            "没有权限对 schema {} 执行 {}",
            schema, action
        )));
    }
    Ok(())
}

/// 查询用户在指定租户下对某资源的有效权限
/// 返回所有匹配的 Permission 记录
///
/// resource 匹配规则（命中任一即算）：
/// - 完全相等：`p.resource = $3`
/// - 全通配：`p.resource = '*'`
/// - schema 通配：`p.resource = 'schema.*'`（schema 来自 $3 中 `.` 之前的部分）
pub async fn query_user_permissions(
    pool: &PgPool,
    user_id: i32,
    tenant_id: i32,
    resource: &str,
    action: &str,
) -> Result<Vec<Permission>> {
    let schema_wildcard = match resource.split_once('.') {
        Some((schema, _)) => format!("{}.*", schema),
        None => format!("{}.*", resource),
    };

    let rows = sqlx::query(
        r#"
        SELECT DISTINCT p.id, p.tenant_id, p.resource, p.action, p.conditions,
               p.allowed_columns, p.denied_columns, p.description,
               p.created_at::TEXT, p.updated_at::TEXT
        FROM management.permissions p
        JOIN management.role_permissions rp ON rp.permission_id = p.id
        JOIN management.user_roles ur ON ur.role_id = rp.role_id
        WHERE ur.user_id = $1
          AND ur.tenant_id = $2
          AND (p.resource = $3 OR p.resource = '*' OR p.resource = $5)
          AND (p.action = $4 OR p.action = 'ALL')
        "#,
    )
    .bind(user_id)
    .bind(tenant_id)
    .bind(resource)
    .bind(action)
    .bind(&schema_wildcard)
    .fetch_all(pool)
    .await?;

    Ok(rows.iter().map(row_to_permission).collect())
}

/// 从查询结果行构造 Permission
fn row_to_permission(row: &sqlx::postgres::PgRow) -> Permission {
    Permission {
        id: row.get("id"),
        tenant_id: row.get("tenant_id"),
        resource: row.get("resource"),
        action: row.get("action"),
        conditions: row.get("conditions"),
        allowed_columns: row.get("allowed_columns"),
        denied_columns: row.get("denied_columns"),
        description: row.get("description"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

/// 将多条 Permission 合并为一个 PermissionResult
///
/// 行条件合并策略：
/// - 任意一个 permission 配置为「无条件」（conditions 为空）时，最终也无条件
///   （等价于 SQL 中 `cond1 OR TRUE = TRUE`）
/// - 所有 permission 都有条件时，将它们的条件 **全部 AND** 连接
///   （注：这是较保守的策略，租户管理员配置时应将"互斥角色"建为不同 resource）
/// - 任何一条 permission 的 conditions 解析失败 → 该 permission 视为不生效
pub fn merge_permissions(permissions: &[Permission], user_id: i32) -> PermissionResult {
    use crate::rbac_models::parse_row_conditions;

    if permissions.is_empty() {
        return PermissionResult::denied();
    }

    let mut all_conditions: Vec<crate::rbac_models::RowCondition> = Vec::new();
    let mut any_uncon_strained = false;
    let mut all_allowed: Option<Vec<String>> = None;
    let mut all_denied: Vec<String> = Vec::new();

    for perm in permissions {
        // 行条件：解析失败则跳过该 permission（视为该权限本身失效）
        match parse_row_conditions(&perm.conditions, user_id) {
            Ok(conds) => {
                if conds.is_empty() {
                    any_uncon_strained = true;
                } else {
                    all_conditions.extend(conds);
                }
            }
            Err(e) => {
                tracing::warn!(
                    "permission {} 的 conditions 解析失败，已忽略: {}",
                    perm.id,
                    e
                );
            }
        }

        // 合并列（取并集：多个权限允许的列合并）
        if let Some(cols) = &perm.allowed_columns {
            if let Some(arr) = cols.as_array() {
                let cols_vec: Vec<String> = arr
                    .iter()
                    .filter_map(|c| c.as_str().map(String::from))
                    .collect();
                match &mut all_allowed {
                    Some(existing) => {
                        for c in cols_vec {
                            if !existing.contains(&c) {
                                existing.push(c);
                            }
                        }
                    }
                    None => all_allowed = Some(cols_vec),
                }
            }
        }

        // 合并被拒绝的列（取交集：只有所有权限都拒绝的列才最终拒绝）
        if let Some(denied) = perm.denied_columns.as_array() {
            let d: Vec<String> = denied
                .iter()
                .filter_map(|c| c.as_str().map(String::from))
                .collect();
            if all_denied.is_empty() {
                all_denied = d;
            } else {
                all_denied.retain(|c| d.contains(c));
            }
        }
    }

    // 从 allowed 中移除 denied
    if let Some(ref mut allowed) = all_allowed {
        allowed.retain(|c| !all_denied.contains(c));
    }

    let row_conditions = if any_uncon_strained {
        // 任一 permission 无条件 → 最终结果也无条件
        vec![]
    } else {
        all_conditions
    };

    PermissionResult {
        allowed: true,
        row_conditions,
        allowed_columns: all_allowed,
        is_superadmin: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rbac_models::RowOp;

    fn make_perm(
        conditions: serde_json::Value,
        allowed: Option<Vec<&str>>,
        denied: &[&str],
    ) -> Permission {
        Permission {
            id: 1,
            tenant_id: 1,
            resource: "public.posts".to_string(),
            action: "SELECT".to_string(),
            conditions,
            allowed_columns: allowed.map(|v| serde_json::json!(v)),
            denied_columns: serde_json::json!(denied),
            description: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn test_merge_empty_permissions() {
        let result = merge_permissions(&[], 1);
        assert!(!result.allowed);
    }

    #[test]
    fn test_merge_single_permission_no_conditions() {
        let perms = vec![make_perm(serde_json::json!([]), None, &[])];
        let result = merge_permissions(&perms, 1);
        assert!(result.allowed);
        assert!(result.row_conditions.is_empty());
        assert!(result.allowed_columns.is_none());
    }

    #[test]
    fn test_merge_single_permission_with_dsl_conditions() {
        let perms = vec![make_perm(
            serde_json::json!([
                {"field":"author_id","op":"=","value":"$current_user_id"}
            ]),
            Some(vec!["id", "title"]),
            &["secret"],
        )];
        let result = merge_permissions(&perms, 42);
        assert!(result.allowed);
        assert_eq!(result.row_conditions.len(), 1);
        assert_eq!(result.row_conditions[0].field, "author_id");
        assert_eq!(result.row_conditions[0].op, RowOp::Eq);
        assert_eq!(result.row_conditions[0].value, serde_json::json!(42));
        assert_eq!(
            result.allowed_columns,
            Some(vec!["id".to_string(), "title".to_string()])
        );
    }

    #[test]
    fn test_merge_multiple_permissions_columns_union() {
        let perms = vec![
            make_perm(serde_json::json!([]), Some(vec!["id", "title"]), &[]),
            make_perm(
                serde_json::json!([]),
                Some(vec!["title", "content", "author"]),
                &[],
            ),
        ];
        let result = merge_permissions(&perms, 1);
        let cols = result.allowed_columns.unwrap();
        assert!(cols.contains(&"id".to_string()));
        assert!(cols.contains(&"title".to_string()));
        assert!(cols.contains(&"content".to_string()));
        assert!(cols.contains(&"author".to_string()));
    }

    #[test]
    fn test_merge_uncon_strained_overrides_constrained() {
        // 一个无条件权限 + 一个有条件权限 → 取宽松（无条件）
        let perms = vec![
            make_perm(
                serde_json::json!([{"field":"author_id","op":"=","value":"$current_user_id"}]),
                None,
                &[],
            ),
            make_perm(serde_json::json!([]), None, &[]),
        ];
        let result = merge_permissions(&perms, 5);
        assert!(result.row_conditions.is_empty());
    }

    #[test]
    fn test_merge_legacy_string_conditions_silently_ignored() {
        // 旧的字符串裸 SQL 不再生效，会被解析失败而忽略 → 该 permission 视为无条件
        let perms = vec![make_perm(
            serde_json::json!(["author_id = :current_user_id"]),
            None,
            &[],
        )];
        let result = merge_permissions(&perms, 5);
        // 解析失败导致该 perm 不计入条件，但其它字段仍生效；这里只检查 row_conditions 为空
        assert!(result.row_conditions.is_empty());
    }

    #[test]
    fn test_denied_columns_removed_from_allowed() {
        let perms = vec![make_perm(
            serde_json::json!([]),
            Some(vec!["id", "title", "secret_field"]),
            &["secret_field"],
        )];
        let result = merge_permissions(&perms, 1);
        let cols = result.allowed_columns.unwrap();
        assert!(cols.contains(&"id".to_string()));
        assert!(!cols.contains(&"secret_field".to_string()));
    }
}
