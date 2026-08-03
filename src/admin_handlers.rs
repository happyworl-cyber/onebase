use crate::auth::{hash_password, Claims};
use crate::error::{AppError, Result};
use crate::permissions;
use crate::redis_manager::RedisManager;
use crate::tenant_models::*;
use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};

/// 把 `Option<Extension<RedisManager>>` 转成 `Option<&RedisManager>` 喂给
/// `permissions::invalidate_*` 系列。Redis 缺失时返回 None，调用方静默跳过。
fn redis_ref(redis: &Option<Extension<RedisManager>>) -> Option<&RedisManager> {
    redis.as_ref().map(|Extension(r)| r)
}

/// 检查是否为平台超管。文件内 wrapper：保留旧调用点不变，
/// 实现统一走 `crate::permissions::require_platform_superadmin`。
fn require_super_admin(claims: &Claims) -> Result<()> {
    permissions::require_platform_superadmin(claims)
}

// ==================== 租户管理 ====================

/// 创建租户请求
#[derive(Debug, Deserialize)]
pub struct CreateTenantRequest {
    pub name: String,
    pub slug: String,
    pub contact_email: Option<String>,
}

/// 租户列表响应
#[derive(Debug, Serialize)]
pub struct TenantListItem {
    pub id: i32,
    pub name: String,
    pub slug: String,
    pub status: String,
    pub contact_email: Option<String>,
    pub user_count: i64,
    pub database_count: i64,
    pub created_at: String,
}

/// GET /api/admin/tenants - 获取所有租户（仅超管）
pub async fn list_tenants(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<TenantListItem>>> {
    require_super_admin(&claims)?;

    let tenants = sqlx::query(
        r#"
        SELECT 
            t.id, t.name, t.slug, t.status, t.contact_email, t.created_at,
            COUNT(DISTINCT ut.user_id) as user_count,
            COUNT(DISTINCT td.id) as database_count
        FROM management.tenants t
        LEFT JOIN management.user_tenants ut ON ut.tenant_id = t.id AND ut.is_active = true
        LEFT JOIN management.tenant_databases td ON td.tenant_id = t.id AND td.is_active = true
        GROUP BY t.id, t.name, t.slug, t.status, t.contact_email, t.created_at
        ORDER BY t.created_at DESC
        "#,
    )
    .fetch_all(&pool)
    .await?;

    let result: Vec<TenantListItem> = tenants
        .iter()
        .map(|row| TenantListItem {
            id: row.get("id"),
            name: row.get("name"),
            slug: row.get("slug"),
            status: row.get("status"),
            contact_email: row.get("contact_email"),
            user_count: row.get("user_count"),
            database_count: row.get("database_count"),
            created_at: crate::models::naive_to_utc_string(
                row.get::<chrono::NaiveDateTime, _>("created_at"),
            ),
        })
        .collect();

    Ok(Json(result))
}

/// POST /api/admin/tenants - 创建租户（仅超管）
pub async fn create_tenant(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<CreateTenantRequest>,
) -> Result<Json<Tenant>> {
    require_super_admin(&claims)?;

    // 检查 slug 是否已存在
    let existing = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM management.tenants WHERE slug = $1)",
    )
    .bind(&req.slug)
    .fetch_one(&pool)
    .await?;

    if existing {
        return Err(AppError::InvalidQuery("租户标识 (slug) 已存在".to_string()));
    }

    let tenant = sqlx::query_as::<_, Tenant>(
        r#"
        INSERT INTO management.tenants (name, slug, contact_email)
        VALUES ($1, $2, $3)
        RETURNING id, name, slug, status, contact_email
        "#,
    )
    .bind(&req.name)
    .bind(&req.slug)
    .bind(&req.contact_email)
    .fetch_one(&pool)
    .await?;

    // 给新租户种入开箱可用的 RBAC 默认数据
    if let Err(e) = crate::rbac_handlers::seed_tenant_rbac_defaults(&pool, tenant.id).await {
        tracing::warn!(
            "为租户 {} 写入默认 RBAC 数据失败（不影响租户创建）: {}",
            tenant.id,
            e
        );
    }

    tracing::info!(
        "超管 {} 创建了新租户: {} ({})",
        claims.email,
        tenant.name,
        tenant.slug
    );

    Ok(Json(tenant))
}

/// PUT /api/admin/tenants/:tenant_id/status - 更新租户状态（仅超管）
#[derive(Debug, Deserialize)]
pub struct UpdateTenantStatusRequest {
    pub status: String, // active, suspended, deleted
}

pub async fn update_tenant_status(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(tenant_id): Path<i32>,
    Json(req): Json<UpdateTenantStatusRequest>,
) -> Result<Json<Tenant>> {
    require_super_admin(&claims)?;

    // 验证 status 值
    if !["active", "suspended", "deleted"].contains(&req.status.as_str()) {
        return Err(AppError::InvalidQuery("无效的状态值".to_string()));
    }

    let tenant = sqlx::query_as::<_, Tenant>(
        r#"
        UPDATE management.tenants
        SET status = $1
        WHERE id = $2
        RETURNING id, name, slug, status, contact_email
        "#,
    )
    .bind(&req.status)
    .bind(tenant_id)
    .fetch_one(&pool)
    .await?;

    tracing::info!(
        "超管 {} 将租户 {} 的状态更新为 {}",
        claims.email,
        tenant.name,
        req.status
    );

    Ok(Json(tenant))
}

// ==================== 用户管理 ====================

/// 用户信息（包含角色）
#[derive(Debug, Serialize)]
pub struct UserListItem {
    pub id: i32,
    pub username: String,
    pub email: String,
    pub role: String,
    pub tenant_count: i64,
    pub created_at: String,
}

/// GET /api/admin/users - 获取所有用户（仅超管）
pub async fn list_users(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<UserListItem>>> {
    require_super_admin(&claims)?;

    let users = sqlx::query(
        r#"
        SELECT 
            u.id, u.username, u.email, u.role, u.created_at,
            COUNT(DISTINCT ut.tenant_id) as tenant_count
        FROM users u
        LEFT JOIN management.user_tenants ut ON ut.user_id = u.id AND ut.is_active = true
        GROUP BY u.id, u.username, u.email, u.role, u.created_at
        ORDER BY u.created_at DESC
        "#,
    )
    .fetch_all(&pool)
    .await?;

    let result: Vec<UserListItem> = users
        .iter()
        .map(|row| UserListItem {
            id: row.get("id"),
            username: row.get("username"),
            email: row.get("email"),
            role: row.get("role"),
            tenant_count: row.get("tenant_count"),
            created_at: crate::models::naive_to_utc_string(
                row.get::<chrono::NaiveDateTime, _>("created_at"),
            ),
        })
        .collect();

    Ok(Json(result))
}

/// 为租户添加用户请求
#[derive(Debug, Deserialize)]
pub struct AddUserToTenantRequest {
    pub user_id: i32,
    pub tenant_id: i32,
    pub role: String, // owner, admin, member, viewer
}

/// POST /api/admin/tenant-users - 为租户添加用户（仅超管）
pub async fn add_user_to_tenant(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    redis: Option<Extension<RedisManager>>,
    Json(req): Json<AddUserToTenantRequest>,
) -> Result<Json<serde_json::Value>> {
    require_super_admin(&claims)?;

    // 验证角色
    if !["owner", "admin", "member", "viewer"].contains(&req.role.as_str()) {
        return Err(AppError::InvalidQuery("无效的角色".to_string()));
    }

    // 检查用户是否存在
    let user_exists =
        sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
            .bind(req.user_id)
            .fetch_one(&pool)
            .await?;

    if !user_exists {
        return Err(AppError::NotFound("用户不存在".to_string()));
    }

    // 检查租户是否存在
    let tenant_exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM management.tenants WHERE id = $1)",
    )
    .bind(req.tenant_id)
    .fetch_one(&pool)
    .await?;

    if !tenant_exists {
        return Err(AppError::NotFound("租户不存在".to_string()));
    }

    // 添加用户到租户（如果已存在则更新）
    sqlx::query(
        r#"
        INSERT INTO management.user_tenants (user_id, tenant_id, role, is_active)
        VALUES ($1, $2, $3, true)
        ON CONFLICT (user_id, tenant_id) 
        DO UPDATE SET role = $3, is_active = true
        "#,
    )
    .bind(req.user_id)
    .bind(req.tenant_id)
    .bind(&req.role)
    .execute(&pool)
    .await?;

    tracing::info!(
        "超管 {} 将用户 {} 添加到租户 {} (角色: {})",
        claims.email,
        req.user_id,
        req.tenant_id,
        req.role
    );

    // 用户被加进新租户：
    // 1) 自动按 tenant_role 同步默认 RBAC 角色，避免"加进来后在数据接口上仍 0 权限"的尴尬；
    //    内部包含 seed_tenant_rbac_defaults + invalidate_user_permissions，幂等。
    // 2) 不强制 revoke 会话——目前 Claims 不存 tenant 列表，旧 token 不会因此持有错误权限。
    permissions::sync_default_rbac_role(
        &pool,
        redis_ref(&redis),
        req.user_id,
        req.tenant_id,
        &req.role,
    )
    .await?;

    Ok(Json(serde_json::json!({
        "message": "用户添加成功",
        "user_id": req.user_id,
        "tenant_id": req.tenant_id,
        "role": req.role
    })))
}

/// GET /api/admin/tenants/:tenant_id/users - 获取租户的所有用户（仅超管）
pub async fn list_tenant_users(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(tenant_id): Path<i32>,
) -> Result<Json<Vec<serde_json::Value>>> {
    require_super_admin(&claims)?;

    let users = sqlx::query(
        r#"
        SELECT 
            u.id, u.username, u.email, u.role as user_role,
            ut.role as tenant_role, ut.is_active, ut.created_at
        FROM management.user_tenants ut
        JOIN users u ON u.id = ut.user_id
        WHERE ut.tenant_id = $1
        ORDER BY ut.created_at DESC
        "#,
    )
    .bind(tenant_id)
    .fetch_all(&pool)
    .await?;

    let result: Vec<serde_json::Value> = users
        .iter()
        .map(|row| {
            serde_json::json!({
                "id": row.get::<i32, _>("id"),
                "username": row.get::<String, _>("username"),
                "email": row.get::<String, _>("email"),
                "user_role": row.get::<String, _>("user_role"),
                "tenant_role": row.get::<String, _>("tenant_role"),
                "is_active": row.get::<bool, _>("is_active"),
                "created_at": crate::models::naive_to_utc_string(row.get::<chrono::NaiveDateTime, _>("created_at")),
            })
        })
        .collect();

    Ok(Json(result))
}

/// DELETE /api/admin/tenant-users/:user_id/:tenant_id - 从租户移除用户（仅超管）
pub async fn remove_user_from_tenant(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    redis: Option<Extension<RedisManager>>,
    Path((user_id, tenant_id)): Path<(i32, i32)>,
) -> Result<Json<serde_json::Value>> {
    require_super_admin(&claims)?;

    sqlx::query(
        "UPDATE management.user_tenants SET is_active = false WHERE user_id = $1 AND tenant_id = $2",
    )
    .bind(user_id)
    .bind(tenant_id)
    .execute(&pool)
    .await?;

    // 同时把该用户在该租户挂的 RBAC 角色清掉——否则下次重新把人加回租户时，
    // 旧 role 仍然有效，等于"软删除"过的人重新激活就自动恢复全部权限。
    sqlx::query("DELETE FROM management.user_roles WHERE user_id = $1 AND tenant_id = $2")
        .bind(user_id)
        .bind(tenant_id)
        .execute(&pool)
        .await?;

    // 失效该用户在该租户的权限缓存（防止"已踢出仍能访问"）。
    permissions::invalidate_user_permissions(redis_ref(&redis), tenant_id, user_id).await;

    // 同步吊销该用户全部活跃会话——保守做法：被踢出任意租户时，下次必须重登录刷新 token
    // 的"租户列表"语义。即使 Claims 当前不带 tenant 列表，也避免攻击者拿旧 token + 旧 cookie
    // 误访问已撤销资源（rate_limiter 等只看 user_id 不区分 tenant）。
    let _ = permissions::revoke_user_sessions(
        &pool,
        user_id,
        &format!("removed_from_tenant_{}", tenant_id),
    )
    .await;

    tracing::info!(
        "超管 {} 将用户 {} 从租户 {} 移除",
        claims.email,
        user_id,
        tenant_id
    );

    Ok(Json(serde_json::json!({
        "message": "用户移除成功"
    })))
}

// ==================== 系统统计 ====================

/// 系统统计信息
#[derive(Debug, Serialize)]
pub struct SystemStats {
    pub total_users: i64,
    pub total_tenants: i64,
    pub active_tenants: i64,
    pub total_databases: i64,
    pub super_admins: i64,
}

/// GET /api/admin/stats - 获取系统统计信息（仅超管）
pub async fn get_system_stats(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<SystemStats>> {
    require_super_admin(&claims)?;

    let total_users = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users")
        .fetch_one(&pool)
        .await?;

    let total_tenants = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM management.tenants")
        .fetch_one(&pool)
        .await?;

    let active_tenants = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM management.tenants WHERE status = 'active'",
    )
    .fetch_one(&pool)
    .await?;

    let total_databases = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM management.tenant_databases WHERE is_active = true",
    )
    .fetch_one(&pool)
    .await?;

    // 权威字段是 is_superadmin（boolean）。早期版本写过 role='super_admin'，
    // 但 admin_create_user 现在写的是 role='admin'，按 role 统计会恒为 0。
    let super_admins = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM users WHERE COALESCE(is_superadmin, false) = true",
    )
    .fetch_one(&pool)
    .await?;

    Ok(Json(SystemStats {
        total_users,
        total_tenants,
        active_tenants,
        total_databases,
        super_admins,
    }))
}

// ==================== 用户增删改密 ====================
//
// 这一组接口由 `/dashboard/users` 页面驱动，全部仅超管可调。
// 安全护栏（在 handler 内部强制，不依赖前端）：
//   - 操作目标必须存在；
//   - 不能删自己 / 不能把自己降级为非超管 —— 否则当前会话立刻失效；
//   - 不能删除 / 降级"系统里最后一个超管"——会把平台锁死；
//   - 重置密码、改名时仅做轻量校验，密码强度复用注册时的"大写+小写+数字+长度≥8"。
// 任何字段更新都会写一条 tracing::info 审计行。

/// 创建用户请求（管理员侧，无需自助注册流程的限速 / 邮箱验证）。
#[derive(Debug, Deserialize)]
pub struct AdminCreateUserRequest {
    pub username: String,
    pub email: String,
    pub password: String,
    /// 是否直接授予平台超管。默认 false。
    #[serde(default)]
    pub is_superadmin: bool,
}

/// 更新用户请求（PATCH 语义：字段可选，不传即不动）。
#[derive(Debug, Deserialize)]
pub struct AdminUpdateUserRequest {
    pub username: Option<String>,
    pub is_superadmin: Option<bool>,
}

/// 重置密码请求。
#[derive(Debug, Deserialize)]
pub struct AdminResetPasswordRequest {
    pub new_password: String,
}

/// 简单的密码校验（与注册时一致：≥ 8 位、含大小写和数字）。
fn validate_password(p: &str) -> Result<()> {
    if p.len() < 8 {
        return Err(AppError::InvalidQuery("密码至少需要 8 位".to_string()));
    }
    let has_upper = p.chars().any(|c| c.is_uppercase());
    let has_lower = p.chars().any(|c| c.is_lowercase());
    let has_digit = p.chars().any(|c| c.is_ascii_digit());
    if !(has_upper && has_lower && has_digit) {
        return Err(AppError::InvalidQuery(
            "密码必须包含大写字母、小写字母和数字".to_string(),
        ));
    }
    Ok(())
}

/// 用户名校验（1-100 字符，不允许只是空白）。
fn validate_username(name: &str) -> Result<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 100 {
        return Err(AppError::InvalidQuery(
            "用户名长度需在 1-100 字符之间".to_string(),
        ));
    }
    Ok(())
}

/// 简易邮箱校验（够用即可，不做完整 RFC 校验）。
fn validate_email(email: &str) -> Result<()> {
    let e = email.trim();
    if e.is_empty() || !e.contains('@') || !e.contains('.') || e.len() > 320 {
        return Err(AppError::InvalidQuery("无效的邮箱地址".to_string()));
    }
    Ok(())
}

/// 数一下当前还有几个有效超管，用来防止"删掉最后一个超管把平台锁死"。
///
/// 委托给 `crate::permissions::count_platform_superadmins`；保留本地名字
/// 是为了让后面的护栏代码读起来仍是"删用户/降级时数一下超管"的语义。
async fn count_superadmins(pool: &PgPool) -> Result<i64> {
    permissions::count_platform_superadmins(pool).await
}

/// 取目标用户的关键标志位，找不到就 NotFound。
async fn fetch_user_flags(pool: &PgPool, user_id: i32) -> Result<(String, String, bool)> {
    let row = sqlx::query(
        "SELECT username, email, COALESCE(is_superadmin, false) AS is_superadmin
         FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("用户 {} 不存在", user_id)))?;

    Ok((
        row.get("username"),
        row.get("email"),
        row.get("is_superadmin"),
    ))
}

/// POST /api/admin/users - 管理员创建用户（仅超管）
pub async fn admin_create_user(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<AdminCreateUserRequest>,
) -> Result<Json<UserListItem>> {
    require_super_admin(&claims)?;
    validate_username(&req.username)?;
    validate_email(&req.email)?;
    validate_password(&req.password)?;

    // 唯一性校验
    let dup_email: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE email = $1)")
        .bind(req.email.trim())
        .fetch_one(&pool)
        .await?;
    if dup_email {
        return Err(AppError::InvalidQuery("邮箱已被注册".to_string()));
    }
    let dup_username: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE username = $1)")
            .bind(req.username.trim())
            .fetch_one(&pool)
            .await?;
    if dup_username {
        return Err(AppError::InvalidQuery("用户名已被使用".to_string()));
    }

    let password_hash = hash_password(&req.password)?;
    // 业务侧 role 字段保留 'admin' / 'user' 二选一仅作展示，权威字段是 is_superadmin
    let display_role = if req.is_superadmin { "admin" } else { "user" };

    let row = sqlx::query(
        r#"
        INSERT INTO users (username, email, password_hash, role, is_superadmin)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, username, email, role, created_at
        "#,
    )
    .bind(req.username.trim())
    .bind(req.email.trim())
    .bind(password_hash)
    .bind(display_role)
    .bind(req.is_superadmin)
    .fetch_one(&pool)
    .await?;

    tracing::info!(
        "超管 {} 创建了新用户 #{} ({}, is_superadmin={})",
        claims.email,
        row.get::<i32, _>("id"),
        row.get::<String, _>("email"),
        req.is_superadmin
    );

    Ok(Json(UserListItem {
        id: row.get("id"),
        username: row.get("username"),
        email: row.get("email"),
        role: row.get("role"),
        tenant_count: 0,
        created_at: crate::models::naive_to_utc_string(
            row.get::<chrono::NaiveDateTime, _>("created_at"),
        ),
    }))
}

/// PATCH /api/admin/users/:user_id - 更新用户名 / 超管标志（仅超管）
pub async fn admin_update_user(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(user_id): Path<i32>,
    Json(req): Json<AdminUpdateUserRequest>,
) -> Result<Json<serde_json::Value>> {
    require_super_admin(&claims)?;

    if req.username.is_none() && req.is_superadmin.is_none() {
        return Err(AppError::InvalidQuery(
            "请求体为空，至少需要 username 或 is_superadmin".to_string(),
        ));
    }

    let (current_username, current_email, current_is_super) =
        fetch_user_flags(&pool, user_id).await?;

    // 改名校验
    if let Some(name) = req.username.as_ref() {
        validate_username(name)?;
        let trimmed = name.trim();
        if trimmed != current_username {
            let dup: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM users WHERE username = $1 AND id <> $2)",
            )
            .bind(trimmed)
            .bind(user_id)
            .fetch_one(&pool)
            .await?;
            if dup {
                return Err(AppError::InvalidQuery("用户名已被使用".to_string()));
            }
        }
    }

    // 超管标志位变更的护栏
    if let Some(target_is_super) = req.is_superadmin {
        if target_is_super != current_is_super {
            // 不许把自己降级为非超管，否则当前 token 立刻失效
            if user_id == claims.sub && !target_is_super {
                return Err(AppError::Forbidden(
                    "不能取消自己的超级管理员身份".to_string(),
                ));
            }
            // 不许降级"最后一个超管"
            if current_is_super && !target_is_super {
                let total = count_superadmins(&pool).await?;
                if total <= 1 {
                    return Err(AppError::Forbidden(
                        "系统至少需要保留一个超级管理员".to_string(),
                    ));
                }
            }
        }
    }

    let new_username = req.username.as_ref().map(|s| s.trim().to_string());
    let new_is_super = req.is_superadmin;
    // 注意：`users.role` 是遗留显示字段（见 auth.rs::Claims 文档），不再随
    // `is_superadmin` 自动联动。早期实现会把 is_superadmin=true 翻成 role='admin'，
    // is_superadmin=false 翻成 role='user'，等于"是不是超管"这一个 bit 会反复覆盖
    // 管理员手动改过的 display 标签。这里只动权威字段 + username，不动 role。
    // 如果未来需要支持显式改 display label，请给 AdminUpdateUserRequest 加 role 字段
    // 并独立 UPDATE，不要再做自动派生。

    sqlx::query(
        r#"
        UPDATE users
        SET username      = COALESCE($2, username),
            is_superadmin = COALESCE($3, is_superadmin)
        WHERE id = $1
        "#,
    )
    .bind(user_id)
    .bind(new_username.as_deref())
    .bind(new_is_super)
    .execute(&pool)
    .await?;

    // 超管位翻转一定要吊销所有活跃会话——JWT 里的 is_superadmin 是签发时快照，
    // 不强制重登录就会出现"已降级但旧 token 仍当超管"的提权窗口。
    // 复用统一辅助避免每个 handler 各写一份 DELETE。
    if new_is_super.is_some() {
        permissions::revoke_user_sessions(&pool, user_id, "is_superadmin_changed").await?;
    }

    tracing::info!(
        "超管 {} 更新了用户 #{} ({}): username={:?}, is_superadmin={:?}",
        claims.email,
        user_id,
        current_email,
        new_username,
        new_is_super,
    );

    Ok(Json(serde_json::json!({
        "ok": true,
        "user_id": user_id,
        "username": new_username,
        "is_superadmin": new_is_super,
    })))
}

/// POST /api/admin/users/:user_id/reset-password - 重置他人密码（仅超管）
pub async fn admin_reset_password(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(user_id): Path<i32>,
    Json(req): Json<AdminResetPasswordRequest>,
) -> Result<Json<serde_json::Value>> {
    require_super_admin(&claims)?;
    validate_password(&req.new_password)?;

    let (_username, email, _) = fetch_user_flags(&pool, user_id).await?;

    let new_hash = hash_password(&req.new_password)?;

    sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2")
        .bind(&new_hash)
        .bind(user_id)
        .execute(&pool)
        .await?;

    // 重置密码后强制重新登录——所有挂该 user_id 的活跃 jti 都作废。
    let _ = permissions::revoke_user_sessions(&pool, user_id, "password_reset_by_admin").await;

    tracing::info!(
        "超管 {} 重置了用户 #{} ({}) 的密码",
        claims.email,
        user_id,
        email
    );

    Ok(Json(serde_json::json!({
        "ok": true,
        "message": "密码已重置，目标用户需要重新登录",
    })))
}

/// DELETE /api/admin/users/:user_id - 彻底删除用户（仅超管）
pub async fn admin_delete_user(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(user_id): Path<i32>,
) -> Result<Json<serde_json::Value>> {
    require_super_admin(&claims)?;

    if user_id == claims.sub {
        return Err(AppError::Forbidden("不能删除自己".to_string()));
    }

    let (_username, email, target_is_super) = fetch_user_flags(&pool, user_id).await?;

    // 不许删掉系统里最后一个超管
    if target_is_super {
        let total = count_superadmins(&pool).await?;
        if total <= 1 {
            return Err(AppError::Forbidden(
                "系统至少需要保留一个超级管理员".to_string(),
            ));
        }
    }

    // 大部分外键已经是 ON DELETE CASCADE（user_tenants / user_roles /
    // user_sessions / sso_user_links）。connection_access_logs 是 NO ACTION
    // 但 user_id 可空，所以把它置空保留审计痕迹，最后再删 users。
    let mut tx = pool.begin().await?;

    sqlx::query("UPDATE management.connection_access_logs SET user_id = NULL WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

    let res = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

    if res.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("用户 {} 不存在", user_id)));
    }

    tx.commit().await?;

    tracing::info!("超管 {} 删除了用户 #{} ({})", claims.email, user_id, email);

    Ok(Json(serde_json::json!({
        "ok": true,
        "message": format!("用户 {} 已删除", email),
    })))
}
